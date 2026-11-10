/**
 * 记忆巩固（cognitive/consolidate）—— episodic → semantic 的"消化"过程。
 *
 * 背景：同一条经验会被反复写成多条记忆（"终端是 aarch64"、"设备是 arm64 Android"、
 * "uname -m 返回 aarch64"）。它们语义高度重叠，检索时互相挤占名额，注入时又各说一遍。
 * 巩固 = 把一簇近义记录**抽取式**合成一条更完整的当前版本：
 *   - 正文：选 utility/importance 最高的那条当基底，追加簇内其它记录的**独有要点**
 *     （按句切分、去重、截断 maxChars）—— 不做生成式改写，零依赖、可复现、不丢原话；
 *   - tags 并集、importance 取大、generation = max+1、consolidatedFrom 记下全部来源；
 *   - stability / utility 取最大（合并出来的新版本至少和最强的来源一样牢）；
 *   - 旧记录**不删**：基底被新记录 supersedes（保留为退役版本），其余来源置
 *     validUntil=now（时间上失效，历史仍可查）。
 *
 * 本模块分两层：clusterRecords / planConsolidation 是纯函数（只算计划、无 I/O），
 * applyConsolidationPlan 是唯一写路径，用 store API 落盘且**不 flush**（与 store 其它
 * 写路径一致，由调用方 scheduleFlush()/flush()）。
 */
import {
  clamp01,
  cosineSimilarity,
  generationOf,
  isTombstonedRecord,
  newId,
  normalizeContent,
  type CognitiveFields,
  type CognitiveRecord,
  type MemoryRecord,
  type MemoryScope,
  type MemoryStore,
  type ScopeStore,
} from '../store.ts'
import { unionTags } from './merge.ts'
import { hasCriticalDetailConflict } from './conflict.ts'
import { validFromOf, validUntilOf } from './temporal.ts'

/** 聚类阈值：余弦相似度 ≥ 0.90 视为同一簇（略低于语义合并的 0.92：巩固允许"角度相近"）。 */
export const CONSOLIDATION_THRESHOLD = 0.9
/** 合并正文默认上限（字符数）。 */
export const DEFAULT_MAX_CHARS = 2000
/** 单 scope 参与两两比较的记录数上限（O(n²) 保护，与 store.nearDuplicates 同口径）。 */
export const DEFAULT_MAX_RECORDS = 2000
/** 截断一个要点时至少要留这么多字符，否则不如不加。 */
const MIN_TRUNCATED_POINT = 8
/** 多要点拼接分隔符。 */
const POINT_SEPARATOR = '\n'

// ---------------------------------------------------------------- 聚类（纯函数）

export interface ClusterOptions {
  /** 余弦阈值，默认 CONSOLIDATION_THRESHOLD(0.90)。 */
  threshold?: number
  /** 记录 id → 向量。缺省时退化为"归一化内容完全相同"的精确聚类。 */
  vectors?: ReadonlyMap<string, Float32Array> | Readonly<Record<string, Float32Array>>
  /** 自定义相似度（给了它就不用 vectors；测试/离线算法用）。 */
  similarity?: (a: MemoryRecord, b: MemoryRecord) => number
  /** 单 scope 比较上限，默认 2000。 */
  maxRecords?: number
  /** 是否把 tombstone 软删记录也算进簇，默认 false。 */
  includeTombstoned?: boolean
}

export interface RecordCluster {
  scope: MemoryScope
  /** 成员 id，按 createdAt 升序（稳定、可复现）。 */
  ids: string[]
  records: MemoryRecord[]
  /** 簇内平均两两相似度 0..1（单成员视为 1，但单成员不会成为簇）。 */
  cohesion: number
}

export interface ClusterResult {
  /** 只含成员数 ≥ 2 的簇；按成员数降序、再按首个 id 升序。 */
  clusters: RecordCluster[]
  /** 实际比较过的记录对数。 */
  comparedPairs: number
  /** 因为缺少向量而被跳过的记录 id（仅传了 vectors 时）。 */
  skippedNoVector: string[]
}

/** 取向量表里的向量（支持 Map 和普通对象两种入参）。 */
function vectorOf(vectors: ClusterOptions['vectors'], id: string): Float32Array | undefined {
  if (vectors === undefined) return undefined
  if (vectors instanceof Map) return vectors.get(id)
  const found = (vectors as Readonly<Record<string, Float32Array>>)[id]
  return found
}

/** 并查集（路径压缩 + 按秩合并）。 */
class UnionFind {
  private parent = new Map<string, string>()
  private rank = new Map<string, number>()

  add(id: string): void {
    if (!this.parent.has(id)) {
      this.parent.set(id, id)
      this.rank.set(id, 0)
    }
  }

  find(id: string): string {
    let root = id
    while (this.parent.get(root) !== root) root = this.parent.get(root)!
    // 路径压缩
    let cursor = id
    while (cursor !== root) {
      const next = this.parent.get(cursor)!
      this.parent.set(cursor, root)
      cursor = next
    }
    return root
  }

  union(a: string, b: string): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra === rb) return
    const rankA = this.rank.get(ra) ?? 0
    const rankB = this.rank.get(rb) ?? 0
    if (rankA < rankB) this.parent.set(ra, rb)
    else if (rankA > rankB) this.parent.set(rb, ra)
    else {
      this.parent.set(rb, ra)
      this.rank.set(ra, rankA + 1)
    }
  }
}

/** 一趟聚类：按 scope 分组（跨 scope 不合并，作用域边界优先），组内并查集聚类。 */
function clusterScope(
  scope: MemoryScope,
  records: MemoryRecord[],
  options: ClusterOptions,
  result: ClusterResult,
): void {
  if (records.length < 2) return
  const threshold = clamp01(options.threshold ?? CONSOLIDATION_THRESHOLD)
  const exactOnly = options.vectors === undefined && options.similarity === undefined
  const custom = options.similarity

  const uf = new UnionFind()
  for (const record of records) uf.add(record.id)

  if (exactOnly) {
    // 无向量兜底：只合并归一化内容完全相同的记录（零误判）。
    const buckets = new Map<string, string[]>()
    for (const record of records) {
      const key = normalizeContent(record.content)
      const list = buckets.get(key)
      if (list === undefined) buckets.set(key, [record.id])
      else list.push(record.id)
    }
    for (const ids of buckets.values()) {
      result.comparedPairs += (ids.length * (ids.length - 1)) / 2
      for (let i = 1; i < ids.length; i++) uf.union(ids[0]!, ids[i]!)
    }
  } else {
    const similarityOf = (a: MemoryRecord, b: MemoryRecord): number => {
      // 0.41.5：关键细节冲突（10.4GB vs 20GB）绝不参与巩固 —— 即使余弦再高、
      // 即使冲突检测因时序漏判，也不能把互斥事实揉成一条。
      if (hasCriticalDetailConflict(a.content, b.content)) return 0
      if (custom !== undefined) return clamp01(custom(a, b))
      const va = vectorOf(options.vectors, a.id)
      const vb = vectorOf(options.vectors, b.id)
      if (va === undefined || vb === undefined) return 0
      return clamp01(cosineSimilarity(va, vb))
    }
    for (let i = 0; i < records.length; i++) {
      for (let j = i + 1; j < records.length; j++) {
        result.comparedPairs++
        if (similarityOf(records[i]!, records[j]!) >= threshold) uf.union(records[i]!.id, records[j]!.id)
      }
    }
  }

  // 收集簇 → 算 cohesion（簇内平均两两相似度）
  const groups = new Map<string, MemoryRecord[]>()
  for (const record of records) {
    const root = uf.find(record.id)
    const list = groups.get(root)
    if (list === undefined) groups.set(root, [record])
    else list.push(record)
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue
    group.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    let sum = 0
    let pairs = 0
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        pairs++
        if (exactOnly && normalizeContent(group[i]!.content) === normalizeContent(group[j]!.content)) sum += 1
        else if (custom !== undefined) sum += clamp01(custom(group[i]!, group[j]!))
        else {
          const va = vectorOf(options.vectors, group[i]!.id)
          const vb = vectorOf(options.vectors, group[j]!.id)
          if (va !== undefined && vb !== undefined) sum += clamp01(cosineSimilarity(va, vb))
        }
      }
    }
    result.clusters.push({
      scope,
      ids: group.map((record) => record.id),
      records: group,
      cohesion: pairs === 0 ? 1 : clamp01(sum / pairs),
    })
  }
}

/**
 * 把记录聚成"同一件事"的簇（贪心 + 并查集，O(n²) 两两余弦）。
 *
 * - 只返回成员数 ≥ 2 的簇，单条记录不构成簇；
 * - 跨 scope 不合并；
 * - 传了 vectors：只比较有向量的记录，没向量的进 skippedNoVector；
 * - 没传 vectors / similarity：退化为"归一化内容完全相同"的精确聚类。
 *
 * 典型调用方是维护任务（housekeeping）：从 store 拿一批当前版本记录 + 向量表，
 * 聚类后对每个簇 planConsolidation()。
 */
export function clusterRecords(records: Iterable<MemoryRecord>, options: ClusterOptions = {}): ClusterResult {
  const result: ClusterResult = { clusters: [], comparedPairs: 0, skippedNoVector: [] }
  const maxRecords = Math.max(2, Math.floor(options.maxRecords ?? DEFAULT_MAX_RECORDS))
  const byScope = new Map<MemoryScope, MemoryRecord[]>()
  for (const record of records) {
    if (options.includeTombstoned !== true && isTombstonedRecord(record)) continue
    if (options.vectors !== undefined) {
      if (vectorOf(options.vectors, record.id) === undefined) {
        result.skippedNoVector.push(record.id)
        continue
      }
    }
    const list = byScope.get(record.scope)
    if (list === undefined) byScope.set(record.scope, [record])
    else list.push(record)
  }
  for (const [scope, candidates] of byScope) {
    // O(n²) 保护：超过上限时只保留最近更新的那批（与 store.nearDuplicates 一致）。
    candidates.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
    clusterScope(scope, candidates.slice(0, maxRecords), options, result)
  }
  result.clusters.sort((a, b) => b.ids.length - a.ids.length || a.ids[0]!.localeCompare(b.ids[0]!))
  return result
}

// ---------------------------------------------------------------- 合并计划（纯函数）

/**
 * 基底得分：utility 缺省按 0.5 中性处理，importance 是必填。
 * 0.6 * utility + 0.4 * importance（越高越适合当合并正文的底本）。
 */
export function consolidationScore(record: MemoryRecord): number {
  const utility = (record as CognitiveFields).utility
  return 0.6 * clamp01(utility ?? 0.5) + 0.4 * clamp01(record.importance)
}

/**
 * 按句切分正文，保留句末标点，便于抽取式追加时"原话照搬"。
 * 同时按换行切分，过滤空串和单字符碎片。
 */
export function splitPoints(content: string): string[] {
  const out: string[] = []
  for (const m of content.matchAll(/[^。！？；;!?;\n]+[。！？；;!?;]?/g)) {
    const point = m[0].trim()
    if (point.length >= 2) out.push(point)
  }
  return out
}

export interface ConsolidationOptions {
  /** 合并正文上限（字符数），默认 DEFAULT_MAX_CHARS(2000)。 */
  maxChars?: number
  /** 固定时间（测试用），缺省 Date.now()。 */
  now?: number
}

export interface ConsolidationPlan {
  scope: MemoryScope
  /** 基底记录 id（新记录 supersedes 指向它）。 */
  baseId: string
  /** 合并后的抽取式正文。 */
  content: string
  /** 实际追加进来的独有要点（未含基底正文本身）。 */
  addedPoints: string[]
  tags: string[]
  importance: number
  /** 新版本号 = 簇内最大 generation + 1。 */
  generation: number
  /** 被新记录取代的全部来源 id，基底排第一。 */
  supersedes: string[]
  /** 被合并进来的全部旧记录 id（含基底，完整溯源）。 */
  consolidatedFrom: string[]
  /** 计划里携带的落盘元数据。 */
  kind: MemoryRecord['kind']
  source: MemoryRecord['source']
  stability?: number
  utility?: number
  difficulty?: number
  useCount?: number
  lastUsedAt?: number
  validFrom?: number
  validUntil?: number
  cohesion: number
  now: number
}

/** 一批记录里定义过的最小值；全都没定义 → undefined。 */
function minDefined(values: Array<number | undefined>): number | undefined {
  let out: number | undefined
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    out = out === undefined ? value : Math.min(out, value)
  }
  return out
}

/** 一批记录里定义过的最大值；全都没定义 → undefined。 */
function maxDefined(values: Array<number | undefined>): number | undefined {
  let out: number | undefined
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    out = out === undefined ? value : Math.max(out, value)
  }
  return out
}

/** 把簇内的独有要点抽取式追加到基底下，返回正文 + 追加要点。 */
function extractiveMerge(
  base: MemoryRecord,
  others: MemoryRecord[],
  maxChars: number,
): { content: string; addedPoints: string[] } {
  let merged = base.content.trim()
  if (merged.length > maxChars) merged = merged.slice(0, maxChars)
  const addedPoints: string[] = []
  const existing = [normalizeContent(merged)]
  outer: for (const record of others) {
    for (const point of splitPoints(record.content)) {
      const normalized = normalizeContent(point)
      if (normalized.length < 2) continue
      // 已被基底 / 已追加内容覆盖（或反过来覆盖了已有内容）→ 不是独有要点。
      let covered = false
      for (const part of existing) {
        if (part.includes(normalized) || normalized.includes(part)) {
          covered = true
          break
        }
      }
      if (covered) continue
      const candidate = `${merged}${POINT_SEPARATOR}${point}`
      if (candidate.length <= maxChars) {
        merged = candidate
        existing.push(normalized)
        addedPoints.push(point)
        continue
      }
      // 放不下整句：能塞下足够长的一段就截断，然后收工（保持正文原样到上限）。
      const room = maxChars - merged.length - POINT_SEPARATOR.length
      if (room >= MIN_TRUNCATED_POINT) {
        const truncated = point.slice(0, room).trim()
        if (truncated.length >= MIN_TRUNCATED_POINT) {
          merged = `${merged}${POINT_SEPARATOR}${truncated}`
          existing.push(normalizeContent(truncated))
          addedPoints.push(truncated)
        }
      }
      break outer
    }
  }
  return { content: merged, addedPoints }
}

/**
 * 给一个簇产出合并计划。纯函数：不读 store、不写任何东西。
 *
 * - 成员 < 2（或全被软删）→ null（单条记录不需要巩固）；
 * - 基底 = utility/importance 得分最高者（同分按 generation、updatedAt、id 稳定裁决）；
 * - 正文 = 基底正文 + 其它成员里"基底没有的句子"（去重、去覆盖、截断 maxChars）；
 * - supersedes / consolidatedFrom = 全簇 id（基底第一）；
 * - generation = 簇内最大版本 + 1；tags 并集；importance 取大；stability/utility 取大。
 */
export function planConsolidation(cluster: RecordCluster, options: ConsolidationOptions = {}): ConsolidationPlan | null {
  const now = options.now ?? Date.now()
  const maxChars = Math.max(1, Math.floor(options.maxChars ?? DEFAULT_MAX_CHARS))
  const members = cluster.records.filter((record) => !isTombstonedRecord(record))
  if (members.length < 2) return null
  // 基底：得分高者优先；同分按版本号、更新时间、id 稳定裁决。
  const ranked = [...members].sort((a, b) => {
    const score = consolidationScore(b) - consolidationScore(a)
    if (score !== 0) return score
    const generation = generationOf(b) - generationOf(a)
    if (generation !== 0) return generation
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt
    return a.id.localeCompare(b.id)
  })
  const base = ranked[0]!
  const others = ranked.slice(1)
  const { content, addedPoints } = extractiveMerge(base, others, maxChars)
  const tags = unionTags(...members.map((record) => record.tags))
  const importance = Math.max(...members.map((record) => clamp01(record.importance)))
  const generations = members.map((record) => generationOf(record))
  const generation = Math.max(...generations) + 1
  const ordered = [base, ...others]
  const ids = ordered.map((record) => record.id)
  const cognitive = members as CognitiveRecord[]

  const plan: ConsolidationPlan = {
    scope: cluster.scope,
    baseId: base.id,
    content,
    addedPoints,
    tags,
    importance,
    generation,
    supersedes: ids,
    consolidatedFrom: ids,
    kind: base.kind,
    source: { ...base.source },
    cohesion: clamp01(cluster.cohesion),
    now,
  }
  const stability = maxDefined(cognitive.map((record) => record.stability))
  if (stability !== undefined) plan.stability = stability
  const utility = maxDefined(cognitive.map((record) => record.utility))
  if (utility !== undefined) plan.utility = utility
  const difficulty = maxDefined(cognitive.map((record) => record.difficulty))
  if (difficulty !== undefined) plan.difficulty = difficulty
  const useCounts = cognitive.map((record) => record.useCount)
  if (useCounts.some((value) => typeof value === 'number' && Number.isFinite(value))) {
    plan.useCount = useCounts.reduce<number>((sum, value) => sum + (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0), 0)
  }
  const lastUsedAt = maxDefined(cognitive.map((record) => record.lastUsedAt))
  if (lastUsedAt !== undefined) plan.lastUsedAt = lastUsedAt
  plan.validFrom = minDefined(members.map(validFromOf))
  // 来源里有"永不过期"的 → 合并版本也永不过期；否则取最晚的失效时刻。
  const untils = members.map(validUntilOf)
  if (untils.every((until) => Number.isFinite(until))) plan.validUntil = Math.max(...untils)
  return plan
}

// ---------------------------------------------------------------- 落盘（唯一写路径）

export interface ConsolidationApplyResult {
  /** 新写入的合并记录（已插进内存增量，向量待调用方补）。 */
  record: CognitiveRecord
  /** 被新记录 supersedes 指向的基底 id（它变成退役历史版本）。 */
  superseded: string
  /** 其它来源记录：置 validUntil = plan.now（时间上失效，历史保留）。 */
  invalidated: string[]
  /** 计划里提到但 store 里找不到（已被物理删除）的 id。 */
  missing: string[]
}

/**
 * 执行合并计划（store 写路径，不 flush）。
 *
 * 为什么手动构造记录而不用 store.save()：save 会按"归一化内容去重"，合并后的正文
 * 可能恰好等于某个来源（比如簇内没有独有要点可加），那会被 save 的去重分支吃掉
 * generation/consolidatedFrom/supersedes —— 巩固语义要求这些字段必须落地，所以这里
 * 与 cognitive/merge.ts 的做法一致，显式构造记录后 ScopeStore.insert()。
 *
 * 旧记录处理：基底被新记录 supersedes（retired，lineage 可查）；其余来源置
 * validUntil=now（search 的时间过滤会跳过，但记录不删、历史可查）。新记录同时进
 * embedPending 待嵌入队列，调用方下次 backfill 会补向量。
 */
export function applyConsolidationPlan(store: MemoryStore, plan: ConsolidationPlan): ConsolidationApplyResult {
  if (!plan.supersedes.includes(plan.baseId)) {
    throw new Error(`consolidation plan 的 baseId(${plan.baseId}) 不在 supersedes 里`)
  }
  const now = plan.now
  const record: CognitiveRecord = {
    id: newId(),
    scope: plan.scope,
    kind: plan.kind,
    content: plan.content,
    tags: [...plan.tags],
    source: { ...plan.source },
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
    accessCount: 0,
    importance: plan.importance,
    supersedes: plan.baseId,
    generation: plan.generation,
    consolidatedFrom: [...plan.consolidatedFrom],
  }
  if (plan.stability !== undefined) record.stability = plan.stability
  if (plan.utility !== undefined) record.utility = plan.utility
  if (plan.difficulty !== undefined) record.difficulty = plan.difficulty
  if (plan.useCount !== undefined) record.useCount = plan.useCount
  if (plan.lastUsedAt !== undefined) record.lastUsedAt = plan.lastUsedAt
  if (plan.validFrom !== undefined) record.validFrom = plan.validFrom
  if (plan.validUntil !== undefined) record.validUntil = plan.validUntil
  const scopeStore: ScopeStore = store.scope(plan.scope)
  scopeStore.insert(record)
  // 新记录还没有向量：进嵌入待办队列，由嵌入层的 backfill 补上（否则下次聚类看不到它）。
  scopeStore.embedPending.add(record.id)

  const invalidated: string[] = []
  const missing: string[] = []
  for (const id of plan.supersedes) {
    if (id === plan.baseId) continue
    if (store.scopeOf(id) === undefined) {
      missing.push(id)
      continue
    }
    store.updateMetrics(id, { validUntil: now })
    invalidated.push(id)
  }
  return { record, superseded: plan.baseId, invalidated, missing }
}
