/**
 * 冲突自动解决（cognitive/resolve）—— 决策是纯函数，落盘只走一个显式入口。
 *
 * 背景：`conflict.ts` 只负责"这两条相似但内容对不上 → 打 conflictWith 标记"，
 * 决策权交给上层。本模块把这个决策**规则化**，让维护任务 / 面板可以自动收敛：
 *
 *   invalidate-old  新陈述证据更强且确实矛盾 → 旧记录 validUntil=now（保留历史，不再当有效事实）
 *   merge            两条其实不矛盾（矛盾度低）/ 同一内容 → 合成新版本，旧记录退役为历史版本
 *   keep-both        证据不够 / 双方对等 / 谱系不允许 → 什么都不动，等人工裁决
 *
 * 决策 = 四个信号加权，全部可解释：
 *   1) 矛盾置信度 contradiction：0.6×（数值/标识符差异 + 关键细节冲突，见 contradiction.ts）
 *      ——"同一件事但细节互斥"才叫矛盾，换个说法不算；
 *   2) 证据计数 evidence：同向记录数（supportNewer / supportOlder），Laplace 平滑成 0..1；
 *   3) 来源可信度 source.origin：user/explicit 1.0 > tool 0.9 > agent 0.7 > auto 0.5；
 *   4) 时间优先：updatedAt 更新的一方占优（相等给 0.5）。
 *
 *   新陈述优势 newerAdvantage = 0.45×证据 + 0.35×来源 + 0.20×时间
 *   决策强度 decisionStrength = 0.60×矛盾 + 0.40×优势
 *
 * 边界：矛盾 < low(0.3) → 可共存（merge）；矛盾 ≥ high(0.6) 且优势 ≥ 0.6 → 旧记录失效；
 * 其余 keep-both（优势 ≤ 0.4 记为旧陈述更可信，否则记为证据对等）。
 *
 * 硬性约束：本模块**绝不**根据向量相似度直接删记录；invalidate-old 只写 validUntil，
 * 历史仍可 lineage/memory_get 查到。merge 只让新记录 supersedes 旧记录（旧记录保留），
 * 绝不产生第三条或物理删除。落盘入口不 flush —— 由调用方 scheduleFlush()/flush()。
 */
import {
  clamp01,
  generationOf,
  normalizeContent,
  type CognitiveRecord,
  type MemoryRecord,
  type MemoryStore,
} from '../store.ts'
import { CONTRADICTION_HIGH, CONTRADICTION_MEDIUM, assessContradiction } from './contradiction.ts'
import { unionTags } from './merge.ts'

// ---------------------------------------------------------------- 常量

/** 优势公式权重：证据计数（同向记录数）占 0.45。 */
export const DEFAULT_EVIDENCE_WEIGHT = 0.45
/** 优势公式权重：来源可信度占 0.35。 */
export const DEFAULT_CREDIBILITY_WEIGHT = 0.35
/** 优势公式权重：时间优先占 0.20。 */
export const DEFAULT_TIME_WEIGHT = 0.2
/** 决策强度里矛盾置信度的权重（其余给优势）。 */
export const DECISION_CONTRADICTION_WEIGHT = 0.6
/** 决策强度里新陈述优势的权重。 */
export const DECISION_ADVANTAGE_WEIGHT = 0.4
/** 旧记录失效所需的最低新陈述优势，默认 0.6。 */
export const DEFAULT_INVALIDATE_THRESHOLD = 0.6
/** 新陈述优势低于它 = 旧陈述明显更可信（keep-both 的理由），默认 0.4。 */
export const DEFAULT_KEEP_THRESHOLD = 0.4

/**
 * 来源可信度权重表。user/explicit 是用户显式写入（最可信）；auto 是自动采集
 * （最容易把模型臆测 / 过期上下文写进来）；未知来源给中性 0.6（既不压过 user，
 * 也不比 agent 更差）。
 */
export const SOURCE_CREDIBILITY: Readonly<Record<string, number>> = {
  user: 1,
  explicit: 1,
  tool: 0.9,
  agent: 0.7,
  subagent: 0.65,
  auto: 0.5,
  import: 0.4,
}

/** 未知来源的默认可信度。 */
export const DEFAULT_SOURCE_CREDIBILITY = 0.6

/** 记录来源可信度（source.origin 查表，未知 / 老记录用默认值）。 */
export function sourceCredibility(record: MemoryRecord): number {
  const source = record.source as { origin?: unknown } | undefined
  const origin = source?.origin
  if (typeof origin === 'string' && SOURCE_CREDIBILITY[origin] !== undefined) return SOURCE_CREDIBILITY[origin]!
  return DEFAULT_SOURCE_CREDIBILITY
}

// ---------------------------------------------------------------- 类型

export type ResolveAction = 'invalidate-old' | 'merge' | 'keep-both'

export type ResolveReason =
  /** 归一化内容相同：重复而不是冲突，合并（让旧版本退役）。 */
  | 'identical-content'
  /** 矛盾置信度低于下界：两条可共存。 */
  | 'compatible-statements'
  /** 新陈述矛盾高、证据/来源/时间全面占优 → 旧记录失效。 */
  | 'newer-dominant'
  /** 矛盾高但旧陈述明显更可信（或时间更晚）→ 保守保留双方。 */
  | 'older-dominant'
  /** 矛盾高但双方对等 → 保留双方等人工裁决。 */
  | 'balanced-evidence'
  /** 新记录已有别的谱系前驱，单值 supersedes 接不上 → 不合并。 */
  | 'lineage-conflict'
  /** 跨作用域：supersedes / validUntil 都是作用域内语义，不能跨域自动处理。 */
  | 'cross-scope'

/** 可选证据：同向记录数 + 上层预计算的相似度 / 矛盾度。 */
export interface ConflictEvidence {
  /** 支持新陈述（与 newer 同向）的记录数。 */
  supportNewer?: number
  /** 支持旧陈述（与 older 同向）的记录数。 */
  supportOlder?: number
  /** 语义相似度 0..1（缺省用词面 Jaccard 兜底，见 contradiction.ts）。 */
  similarity?: number
  /** 上层已算好的矛盾置信度 0..1（缺省由本模块自算）。 */
  contradiction?: number
}

/** 影响决策的可配置阈值 / 参数。 */
export interface ResolveOptions {
  /** 矛盾低于它视为可共存（merge），默认 CONTRADICTION_MEDIUM(0.3)。 */
  lowContradiction?: number
  /** 矛盾高于它才可能让旧记录失效，默认 CONTRADICTION_HIGH(0.6)。 */
  highContradiction?: number
  /** 旧记录失效所需的新陈述优势，默认 DEFAULT_INVALIDATE_THRESHOLD(0.6)。 */
  invalidateThreshold?: number
  /** 新陈述优势低于它记为"旧陈述更可信"，默认 DEFAULT_KEEP_THRESHOLD(0.4)。 */
  keepThreshold?: number
  /** 优势公式三权重，默认 0.45 / 0.35 / 0.20（内部归一化）。 */
  evidenceWeight?: number
  credibilityWeight?: number
  timeWeight?: number
  /** 固定时间（测试用），缺省 Date.now()；同时是 invalidate-old 的 validUntil。 */
  now?: number
  /** merge 时可选的上层合成正文（缺省用 newer.content）。 */
  mergedContent?: string
}

export interface ResolveConflictInput {
  /** 新陈述（后写入 / 被新证据支持的一方）。 */
  newer: MemoryRecord
  /** 旧陈述（可能被推翻的一方）。 */
  older: MemoryRecord
  /** 可选证据：同向记录数 / 相似度 / 矛盾度。 */
  evidence?: ConflictEvidence
  /** 可选阈值参数。 */
  options?: ResolveOptions
}

/** 决策过程中用到的信号原值（便于回执 / 面板解释）。 */
export interface ConflictSignals {
  /** 证据计数平滑后的新陈述占比 0..1。 */
  evidenceBalance: number
  /** 来源可信度归一化后的新陈述占比 0..1。 */
  credibilityBalance: number
  /** 时间优先：1 = 新陈述更新，0.5 = 同时，0 = 旧陈述更新。 */
  timeFavorsNewer: number
  credibilityNewer: number
  credibilityOlder: number
  /** 新陈述优势 0..1。 */
  newerAdvantage: number
  /** 决策强度 0..1 = 0.6×矛盾 + 0.4×优势。 */
  decisionStrength: number
  weights: { evidence: number; credibility: number; time: number }
}

/** merge 落盘所需的合并字段（正文 / 标签 / 重要性）。 */
export interface ConflictMergePlan {
  /** 合并后的正文（缺省 newer.content；上层可用 LLM 合成后通过 options.mergedContent 传入）。 */
  content: string
  /** tags 并集（旧在前、新的补充在后）。 */
  tags: string[]
  /** importance 取大。 */
  importance: number
}

/** 一次冲突裁决（纯数据，可直接回执 / 存审计）。 */
export interface ConflictDecision {
  action: ResolveAction
  reason: ResolveReason
  /** 决策置信度 0..1（语义见各分支注释）。 */
  confidence: number
  newerId: string
  olderId: string
  scope: MemoryRecord['scope']
  /** 矛盾置信度 0..1。 */
  contradiction: number
  /** 新陈述优势 0..1。 */
  newerAdvantage: number
  signals: ConflictSignals
  evidence: {
    supportNewer: number
    supportOlder: number
    similarity?: number
    contradictionOverride?: number
  }
  thresholds: {
    lowContradiction: number
    highContradiction: number
    invalidateThreshold: number
    keepThreshold: number
  }
  /** action='invalidate-old'：写进旧记录的 validUntil 时刻。 */
  validUntil?: number
  /** action='merge'：落盘时的合并字段。 */
  merge?: ConflictMergePlan
  /** 中文可解释明细。 */
  explanation: string[]
}

// ---------------------------------------------------------------- 纯函数：决策

/** 同向记录数：非法值归 0，负数 / 小数收敛到非负整数。 */
function countOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return Math.floor(value)
}

/** 权重归一化：三个权重都被置 0 / 非法时回落到默认权重。 */
function normalizeWeights(options: ResolveOptions): { evidence: number; credibility: number; time: number } {
  const raw = {
    evidence: options.evidenceWeight ?? DEFAULT_EVIDENCE_WEIGHT,
    credibility: options.credibilityWeight ?? DEFAULT_CREDIBILITY_WEIGHT,
    time: options.timeWeight ?? DEFAULT_TIME_WEIGHT,
  }
  const safe = {
    evidence: Number.isFinite(raw.evidence) && raw.evidence >= 0 ? raw.evidence : DEFAULT_EVIDENCE_WEIGHT,
    credibility: Number.isFinite(raw.credibility) && raw.credibility >= 0 ? raw.credibility : DEFAULT_CREDIBILITY_WEIGHT,
    time: Number.isFinite(raw.time) && raw.time >= 0 ? raw.time : DEFAULT_TIME_WEIGHT,
  }
  const sum = safe.evidence + safe.credibility + safe.time
  if (sum <= 0) return { evidence: DEFAULT_EVIDENCE_WEIGHT, credibility: DEFAULT_CREDIBILITY_WEIGHT, time: DEFAULT_TIME_WEIGHT }
  return { evidence: safe.evidence / sum, credibility: safe.credibility / sum, time: safe.time / sum }
}

/** 百分比格式（解释文案用）。 */
function pct(value: number): string {
  return `${(clamp01(value) * 100).toFixed(1)}%`
}

/**
 * 对一对冲突记录给出裁决。
 *
 * 纯函数：只读 newer/older（不改字段）、不碰 store、无副作用。返回的 decision
 * 交给 applyConflictResolution() 才会落盘；keep-both 时什么都不会写。
 */
export function resolveConflict(input: ResolveConflictInput): ConflictDecision {
  const { newer, older } = input
  if (newer === null || typeof newer !== 'object' || older === null || typeof older !== 'object') {
    throw new TypeError('resolveConflict: newer / older 必须是记忆记录')
  }
  if (newer.id === older.id) throw new TypeError('resolveConflict: newer 与 older 必须是两条不同的记录')

  const evidence = input.evidence ?? {}
  const options = input.options ?? {}
  const now = options.now ?? Date.now()
  const weights = normalizeWeights(options)
  const lowContradiction = clamp01(options.lowContradiction ?? CONTRADICTION_MEDIUM)
  const highContradiction = clamp01(options.highContradiction ?? CONTRADICTION_HIGH)
  const invalidateThreshold = clamp01(options.invalidateThreshold ?? DEFAULT_INVALIDATE_THRESHOLD)
  const keepThreshold = clamp01(options.keepThreshold ?? DEFAULT_KEEP_THRESHOLD)

  const supportNewer = countOf(evidence.supportNewer)
  const supportOlder = countOf(evidence.supportOlder)
  const similarity = typeof evidence.similarity === 'number' && Number.isFinite(evidence.similarity)
    ? clamp01(evidence.similarity)
    : undefined
  const contradictionOverride = typeof evidence.contradiction === 'number' && Number.isFinite(evidence.contradiction)
    ? clamp01(evidence.contradiction)
    : undefined
  const contradiction = contradictionOverride
    ?? assessContradiction(newer.content, older.content, similarity !== undefined ? { similarity } : {}).confidence

  // 证据 / 来源 / 时间三个信号 → 新陈述优势。
  const evidenceBalance = (supportNewer + 1) / (supportNewer + supportOlder + 2) // Laplace 平滑
  const credibilityNewer = sourceCredibility(newer)
  const credibilityOlder = sourceCredibility(older)
  const credibilitySum = credibilityNewer + credibilityOlder
  const credibilityBalance = credibilitySum > 0 ? credibilityNewer / credibilitySum : 0.5
  const timeFavorsNewer = newer.updatedAt > older.updatedAt ? 1 : newer.updatedAt === older.updatedAt ? 0.5 : 0
  const newerAdvantage = clamp01(
    weights.evidence * evidenceBalance +
      weights.credibility * credibilityBalance +
      weights.time * timeFavorsNewer,
  )
  const decisionStrength = clamp01(
    DECISION_CONTRADICTION_WEIGHT * contradiction + DECISION_ADVANTAGE_WEIGHT * newerAdvantage,
  )

  const signals: ConflictSignals = {
    evidenceBalance,
    credibilityBalance,
    timeFavorsNewer,
    credibilityNewer,
    credibilityOlder,
    newerAdvantage,
    decisionStrength,
    weights,
  }
  const thresholds = { lowContradiction, highContradiction, invalidateThreshold, keepThreshold }

  /** 谱系是否允许合并：newer 没有前驱，或前驱正是 older。 */
  const lineage: string | undefined =
    typeof newer.supersedes === 'string' && newer.supersedes !== '' ? newer.supersedes : undefined
  const lineageSafe = lineage === undefined || lineage === older.id

  const explanation: string[] = [
    `矛盾置信度 ${pct(contradiction)}（可共存 < ${pct(lowContradiction)} ≤ 冲突 < ${pct(highContradiction)} ≤ 高冲突）。`,
    `新陈述优势 ${pct(newerAdvantage)} = 证据 ${pct(evidenceBalance)}×${weights.evidence.toFixed(2)}` +
      ` + 来源 ${pct(credibilityBalance)}×${weights.credibility.toFixed(2)}` +
      ` + 时间 ${pct(timeFavorsNewer)}×${weights.time.toFixed(2)}` +
      `（同向记录 ${supportNewer}:${supportOlder}，来源可信度 ${credibilityNewer}:${credibilityOlder}）。`,
  ]
  const base = {
    newerId: newer.id,
    olderId: older.id,
    scope: newer.scope,
    contradiction,
    newerAdvantage,
    signals,
    evidence: { supportNewer, supportOlder, ...(similarity !== undefined ? { similarity } : {}), ...(contradictionOverride !== undefined ? { contradictionOverride } : {}) },
    thresholds,
    explanation,
  }

  // 1) 跨作用域：supersedes / validUntil 都是作用域内语义，不做自动处理。
  if (newer.scope !== older.scope) {
    explanation.push(`决策：保留双方 —— 两条记录分属不同作用域（${newer.scope} vs ${older.scope}），不自动失效/合并。`)
    return { ...base, action: 'keep-both', reason: 'cross-scope', confidence: clamp01(1 - newerAdvantage) }
  }

  const identical = normalizeContent(newer.content) === normalizeContent(older.content)

  // 2) 归一化内容相同：重复而不是冲突 → 合并（旧版本退役，保留历史）。
  if (identical) {
    if (!lineageSafe) {
      explanation.push('决策：保留双方 —— 内容相同但新记录已有别的谱系前驱，不能接上第二条 supersedes。')
      return { ...base, action: 'keep-both', reason: 'lineage-conflict', confidence: clamp01(1 - newerAdvantage) }
    }
    const merge = buildMergePlan(newer, older, options)
    explanation.push('决策：合并 —— 两条内容相同（重复写入），合并标签/重要性后让旧版本退役。')
    return { ...base, action: 'merge', reason: 'identical-content', confidence: 1, merge }
  }

  // 3) 矛盾度低于下界：换个说法 / 可共存 → 合并成新版本。
  if (contradiction < lowContradiction) {
    if (!lineageSafe) {
      explanation.push('决策：保留双方 —— 虽可共存，但新记录已有别的谱系前驱，不能自动合并。')
      return { ...base, action: 'keep-both', reason: 'lineage-conflict', confidence: clamp01(1 - newerAdvantage) }
    }
    const merge = buildMergePlan(newer, older, options)
    explanation.push(`决策：合并 —— 矛盾 ${pct(contradiction)} 低于可共存阈值 ${pct(lowContradiction)}，两条说的是同一件事的不同侧面。`)
    return {
      ...base,
      action: 'merge',
      reason: 'compatible-statements',
      confidence: clamp01(1 - contradiction / Math.max(lowContradiction, 1e-6)),
      merge,
    }
  }

  // 4) 矛盾高且新陈述优势够强 → 旧记录失效（保留历史，不再当有效事实）。
  if (contradiction >= highContradiction && newerAdvantage >= invalidateThreshold) {
    explanation.push(
      `决策：旧记录失效 —— 矛盾 ${pct(contradiction)} ≥ ${pct(highContradiction)} 且新陈述优势 ${pct(newerAdvantage)} ≥ ${pct(invalidateThreshold)}。`,
    )
    return {
      ...base,
      action: 'invalidate-old',
      reason: 'newer-dominant',
      confidence: decisionStrength,
      validUntil: now,
    }
  }

  // 5) 矛盾高但旧陈述明显更可信（来源更强 / 时间更晚）→ 保守保留。
  if (contradiction >= highContradiction && newerAdvantage <= keepThreshold) {
    explanation.push(
      `决策：保留双方 —— 矛盾高，但新陈述优势 ${pct(newerAdvantage)} ≤ ${pct(keepThreshold)}（旧陈述来源/时间更强），不贸然推翻。`,
    )
    return { ...base, action: 'keep-both', reason: 'older-dominant', confidence: clamp01(1 - newerAdvantage) }
  }

  // 6) 其余（中等矛盾，或高矛盾但优势在边界内）→ 保留双方等人工裁决。
  explanation.push(
    `决策：保留双方 —— 矛盾 ${pct(contradiction)}，优势 ${pct(newerAdvantage)} 未形成压倒性结论，交给人工裁决。`,
  )
  return { ...base, action: 'keep-both', reason: 'balanced-evidence', confidence: clamp01(1 - newerAdvantage) }
}

/** 构造 merge 落盘字段：正文缺省用新陈述，tags 并集，importance 取大。 */
function buildMergePlan(newer: MemoryRecord, older: MemoryRecord, options: ResolveOptions): ConflictMergePlan {
  const mergedContent = options.mergedContent?.trim()
  return {
    content: mergedContent !== undefined && mergedContent !== '' ? mergedContent : newer.content,
    tags: unionTags(older.tags, newer.tags),
    importance: Math.max(clamp01(older.importance), clamp01(newer.importance)),
  }
}

// ---------------------------------------------------------------- 落盘（唯一写入口）

export type ConflictApplyReason = 'keep-both' | 'not-found' | 'lineage-conflict' | 'already-merged'

export interface ConflictApplyResult {
  applied: boolean
  action: ResolveAction
  /** applied=false 时说明原因。 */
  reason?: ConflictApplyReason
  /** 被更新的记录 id（invalidate-old = 旧记录；merge = 新记录）。 */
  updated: string[]
  /** merge 后写入的新版本记录。 */
  record?: MemoryRecord
}

/**
 * 把裁决落进 store（唯一写入口）：
 *   invalidate-old → 旧记录写 validUntil（store.updateMetrics，其它字段不动）；
 *   merge          → 新记录原地升级：tags 并集 / importance 取大 / supersedes 指向旧记录 /
 *                    generation+1，并清掉冲突与休眠标记；旧记录保留（退役为历史版本）；
 *   keep-both      → 不做任何写操作。
 *
 * 不 flush —— 与 store 其它写路径一致，由调用方 scheduleFlush() / flush()。
 * 幂等保护：merge 已经合过（newer.supersedes === olderId）时不再重复升级版本号。
 */
export function applyConflictResolution(store: MemoryStore, decision: ConflictDecision): ConflictApplyResult {
  if (decision.action === 'keep-both') {
    return { applied: false, action: decision.action, reason: 'keep-both', updated: [] }
  }

  const locatedOlder = store.scopeOf(decision.olderId)
  if (locatedOlder === undefined) {
    return { applied: false, action: decision.action, reason: 'not-found', updated: [] }
  }

  if (decision.action === 'invalidate-old') {
    const validUntil = typeof decision.validUntil === 'number' && Number.isFinite(decision.validUntil)
      ? decision.validUntil
      : Date.now()
    const updated = store.updateMetrics(decision.olderId, { validUntil })
    if (updated === undefined) {
      return { applied: false, action: decision.action, reason: 'not-found', updated: [] }
    }
    return { applied: true, action: decision.action, updated: [decision.olderId], record: updated }
  }

  // action === 'merge'
  const plan = decision.merge
  if (plan === undefined) {
    return { applied: false, action: decision.action, reason: 'not-found', updated: [] }
  }
  const locatedNewer = store.scopeOf(decision.newerId)
  if (locatedNewer === undefined) {
    return { applied: false, action: decision.action, reason: 'not-found', updated: [] }
  }
  const current = locatedNewer.record as CognitiveRecord
  const olderRecord = locatedOlder.record
  const previous = typeof current.supersedes === 'string' && current.supersedes !== '' ? current.supersedes : undefined
  if (previous !== undefined && previous !== decision.olderId) {
    return { applied: false, action: decision.action, reason: 'lineage-conflict', updated: [] }
  }
  if (previous === decision.olderId) {
    // 已经合并过：不重复提升版本号（保持幂等）。
    return { applied: false, action: decision.action, reason: 'already-merged', updated: [] }
  }

  const now = Date.now()
  const next: CognitiveRecord = {
    ...current,
    content: plan.content !== '' ? plan.content : current.content,
    tags: [...plan.tags],
    importance: clamp01(plan.importance),
    generation: Math.max(generationOf(current), generationOf(olderRecord)) + 1,
    supersedes: decision.olderId,
    updatedAt: now,
    lastAccessedAt: now,
  }
  // 合并解决了分歧：冲突标记 / 休眠标记不该留在"当前活动版本"上。
  delete next.conflictWith
  delete next.conflictConfidence
  delete next.dormantAt
  locatedNewer.store.insert(next)
  return { applied: true, action: decision.action, updated: [decision.newerId], record: next }
}
