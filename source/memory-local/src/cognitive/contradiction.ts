/**
 * 矛盾置信度（cognitive/contradiction）—— 纯函数，无 I/O、无副作用。
 *
 * 背景：`conflict.ts` 只回答"相似度落在冲突区，要不要打标"；这里回答更细的问题——
 * "两条记忆到底有多矛盾、矛盾在哪"。纯向量相似度有个盲区：**措辞几乎一样但关键细节
 * 不同**的句子（10.4GB vs 20GB、端口 8080 vs 8078、pnpm vs npm）余弦往往比真正的
 * 同义改写还高，相似度本身分辨不出"事实被改写了"。
 *
 * 本模块把矛盾拆成两件事：
 *   1) 是不是同一件事 —— 语义相似度（嵌入余弦，缺省用词面 Jaccard 兜底）；
 *   2) 细节互不互斥 —— 数值差异率 + 标识符差异率。
 * 置信度公式（数值见下方常量，全部 0..1）：
 *
 *   detailDiff   = 0.6 * numericRate + 0.4 * identifierRate
 *   confidence   = similarity * (0.65 * detailDiff + 0.35 * criticalDetailConflict)
 *
 * 直觉：**同题 × 细节互斥**才是矛盾；话题都不一样的两个句子即使数字不同也不算矛盾
 * （所以每一项都乘 similarity）。`criticalDetailConflict` 是 `conflict.ts` 的布尔证据
 * （双方都有关键细节但集合不一致），给"数值差异率很小、但端口/版本号真的变了"这种
 * 情况兜底，避免 8080 vs 8078 因为差异率只有 0.02% 而被判低。
 *
 * 等级：confidence >= 0.6 → high；>= 0.3 → medium；否则 low。
 */
import { clamp01, normalizeContent, type MemoryRecord } from '../store.ts'
import { hasCriticalDetailConflict } from './conflict.ts'

/** 高/中矛盾阈值（含）。 */
export const CONTRADICTION_HIGH = 0.6
export const CONTRADICTION_MEDIUM = 0.3

/** detailDiff 内部权重：数值差异更能说明"事实被改写"，给 0.6。 */
export const NUMERIC_WEIGHT = 0.6
/** detailDiff 内部权重：标识符差异（路径 / 版本 / 工具名）给 0.4。 */
export const IDENTIFIER_WEIGHT = 0.4
/** 置信度公式权重：细节互斥度的贡献 0.65。 */
export const DETAIL_WEIGHT = 0.65
/** 置信度公式权重：关键细节集合不一致（布尔证据）的贡献 0.35。 */
export const CRITICAL_WEIGHT = 0.35

/** 拉丁停用词：不算"标识符"（与 conflict.ts 同口径，刻意各自维护，避免跨模块耦合）。 */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were', 'have', 'has',
  'not', 'but', 'you', 'your', 'can', 'will', 'all', 'any', 'our', 'out', 'use', 'only',
])

/** 从正文里抽出的可比较断言。 */
export interface ExtractedClaims {
  /** 数值（按出现顺序去重；支持小数、千分位）。 */
  numbers: number[]
  /** 路径 / URL / Windows 盘符路径。 */
  paths: string[]
  /** 拉丁标识符（版本号、工具名、变量名…），长度 ≥3 且不是停用词。 */
  identifiers: string[]
}

/** 一对数值的差异明细；right === null 表示另一边没有可配对的数值。 */
export interface NumericDifferenceDetail {
  left: number
  right: number | null
  /** |a-b| / max(|a|,|b|)，无配对时为 1。 */
  rate: number
}

/** 两条正文的断言差异（compareClaims 的返回）。 */
export interface ClaimComparison {
  left: ExtractedClaims
  right: ExtractedClaims
  /** 数值差异率 0..1。 */
  numericRate: number
  /** 标识符（含路径）差异率 0..1。 */
  identifierRate: number
  numericDiffs: NumericDifferenceDetail[]
  identifiersMissing: string[]
  identifiersExtra: string[]
  pathsMissing: string[]
  pathsExtra: string[]
  /** 人类可读的中文差异明细（面板 / 工具回执直接展示）。 */
  details: string[]
  /** 是否存在任何可比较的差异。 */
  differs: boolean
}

/** 矛盾评估结果。 */
export interface ContradictionAssessment {
  /** 矛盾置信度 0..1。 */
  confidence: number
  level: 'low' | 'medium' | 'high'
  /** 实际使用的语义相似度（入参或词面兜底）。 */
  similarity: number
  /** 各信号原值，方便上层解释排序/回执。 */
  signals: {
    /** 数值差异率（含"不相等即至少 0.5"的下限，见 numericDifferenceRate）。 */
    numeric: number
    /** 标识符差异率。 */
    identifier: number
    /** 细节互斥度（数值/标识符的加权）。 */
    detail: number
    /** 关键细节集合是否整体不一致（conflict.ts 的布尔证据）。 */
    criticalDetailConflict: boolean
  }
  /** 逐项差异明细。 */
  comparison: ClaimComparison
}

/** 抽取正文里的数值/路径/标识符（保序去重）。 */
export function extractClaims(content: string): ExtractedClaims {
  const numbers: number[] = []
  const seenNumbers = new Set<number>()
  for (const m of content.matchAll(/-?\d+(?:[.,]\d+)*/g)) {
    const value = Number(m[0].replace(/,/g, ''))
    if (!Number.isFinite(value) || seenNumbers.has(value)) continue
    seenNumbers.add(value)
    numbers.push(value)
  }
  const paths: string[] = []
  const seenPaths = new Set<string>()
  for (const m of content.matchAll(/(?:\/[\w.\-]+){2,}|https?:\/\/\S+|[A-Za-z]:\\[^\s]+/g)) {
    if (seenPaths.has(m[0])) continue
    seenPaths.add(m[0])
    paths.push(m[0])
  }
  const identifiers: string[] = []
  const seenIds = new Set<string>()
  for (const m of content.toLowerCase().matchAll(/[a-z][a-z0-9_+.\-]{2,}/g)) {
    const token = m[0]
    if (STOP_WORDS.has(token) || seenIds.has(token)) continue
    seenIds.add(token)
    identifiers.push(token)
  }
  return { numbers, paths, identifiers }
}

/** 排序后按下标配对两串数值，返回每对的差异（多出来的记为无配对，rate=1）。 */
function pairNumbers(left: number[], right: number[]): NumericDifferenceDetail[] {
  const a = [...left].sort((x, y) => x - y)
  const b = [...right].sort((x, y) => x - y)
  const out: NumericDifferenceDetail[] = []
  const size = Math.max(a.length, b.length)
  for (let i = 0; i < size; i++) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) {
      out.push({ left: NaN, right: y!, rate: 1 })
      continue
    }
    if (y === undefined) {
      out.push({ left: x, right: null, rate: 1 })
      continue
    }
    if (x === y) {
      out.push({ left: x, right: y, rate: 0 })
      continue
    }
    const max = Math.max(Math.abs(x), Math.abs(y))
    out.push({ left: x, right: y, rate: max === 0 ? 1 : Math.abs(x - y) / max })
  }
  return out
}

/**
 * 数值差异率 0..1。
 *
 * 每对不等数值的贡献 = 0.5 + 0.5 * |a-b|/max(|a|,|b|)，即**只要数值被改了就至少 0.5**，
 * 幅度越大越接近 1（8080 vs 8078 这种幅度率几乎为 0，但"确实变了"本身就是证据）；
 * 无配对的数值记 1；相等记 0。最后对所有配对取平均。
 */
export function numericDifferenceRate(left: number[], right: number[]): number {
  if (left.length === 0 && right.length === 0) return 0
  const diffs = pairNumbers(left, right)
  if (diffs.length === 0) return 0
  let sum = 0
  for (const diff of diffs) sum += diff.rate === 0 ? 0 : 0.5 + 0.5 * diff.rate
  return clamp01(sum / diffs.length)
}

/** 标识符差异率 0..1：(只在一边出现的项数) / (并集大小)；两边都空 → 0。 */
export function identifierDifferenceRate(left: readonly string[], right: readonly string[]): number {
  const a = new Set(left)
  const b = new Set(right)
  const union = new Set([...a, ...b])
  if (union.size === 0) return 0
  let differ = 0
  for (const token of union) if (!a.has(token) || !b.has(token)) differ++
  return clamp01(differ / union.size)
}

/** 单边独有的项（保序：左/右各自的原始顺序）。 */
function onlyIn(source: readonly string[], other: ReadonlySet<string>): string[] {
  return source.filter((token) => !other.has(token))
}

/** 差异率格式化：<0.1% 的极小差异也明确写出来（端口/版本号常常只差一点）。 */
function formatRate(rate: number): string {
  if (rate <= 0) return '0%'
  if (rate < 0.001) return '<0.1%'
  return `${(rate * 100).toFixed(1)}%`
}

/** 数值格式化：整数不带小数点，小数最多保留 4 位。 */
function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '?'
  if (Number.isInteger(value)) return String(value)
  return String(Number(value.toFixed(4)))
}

/**
 * 逐项比较两条正文的断言，返回差异率 + 人类可读明细。
 *
 * 数值按排序后下标配对（顺序无关，重复数值也按多重集处理）；标识符是集合比较，
 * 路径单独列出来便于回执展示（路径也计入 identifierRate —— 路径确实是最强的标识符）。
 */
export function compareClaims(leftContent: string, rightContent: string): ClaimComparison {
  const left = extractClaims(leftContent)
  const right = extractClaims(rightContent)
  const numericDiffs = pairNumbers(left.numbers, right.numbers)
  const numericRate = numericDifferenceRate(left.numbers, right.numbers)

  // 路径既算标识符也单独明细，比较时合进标识符集合，避免路径差异被漏算。
  const leftIds = new Set([...left.identifiers, ...left.paths])
  const rightIds = new Set([...right.identifiers, ...right.paths])
  const leftIdList = [...left.identifiers, ...left.paths]
  const rightIdList = [...right.identifiers, ...right.paths]
  const identifiersMissing = onlyIn(leftIdList, rightIds)
  const identifiersExtra = onlyIn(rightIdList, leftIds)
  const pathsMissing = onlyIn(left.paths, new Set(right.paths))
  const pathsExtra = onlyIn(right.paths, new Set(left.paths))
  const identifierRate = identifierDifferenceRate(leftIdList, rightIdList)

  const details: string[] = []
  for (const diff of numericDiffs) {
    if (diff.rate === 0) continue
    if (diff.right === null) details.push(`数值 ${formatNumber(diff.left)} 在新陈述中缺失`)
    else if (!Number.isFinite(diff.left)) details.push(`新增数值 ${formatNumber(diff.right)}`)
    else details.push(`数值 ${formatNumber(diff.left)} → ${formatNumber(diff.right)}（差异率 ${formatRate(diff.rate)}）`)
  }
  if (identifiersMissing.length > 0) details.push(`标识符/路径缺失: ${identifiersMissing.join(', ')}`)
  if (identifiersExtra.length > 0) details.push(`标识符/路径新增: ${identifiersExtra.join(', ')}`)
  const differs = numericRate > 0 || identifierRate > 0
  return {
    left,
    right,
    numericRate,
    identifierRate,
    numericDiffs,
    identifiersMissing,
    identifiersExtra,
    pathsMissing,
    pathsExtra,
    details,
    differs,
  }
}

/** 把置信度映射成等级。 */
export function contradictionLevel(confidence: number): 'low' | 'medium' | 'high' {
  const value = clamp01(confidence)
  if (value >= CONTRADICTION_HIGH) return 'high'
  if (value >= CONTRADICTION_MEDIUM) return 'medium'
  return 'low'
}

/**
 * 文本分词：拉丁标识符按完整 token，CJK 按字符二元组（bigram）。
 * 用于没有嵌入向量时的词面相似度兜底（纯函数、可复现）。
 */
export function textTokens(text: string): string[] {
  const normalized = normalizeContent(text)
  const tokens = new Set<string>()
  for (const m of normalized.matchAll(/[a-z0-9_.\-/]+/g)) tokens.add(m[0])
  const cjk = normalized.replace(/[^\u3400-\u9fff]/g, '')
  if (cjk.length === 1) tokens.add(cjk)
  for (let i = 0; i + 1 < cjk.length; i++) tokens.add(cjk.slice(i, i + 2))
  return [...tokens]
}

/** 词面 Jaccard 相似度 0..1；两边都空 → 0（无从判断，不当成同题）。 */
export function lexicalSimilarity(a: string, b: string): number {
  const left = new Set(textTokens(a))
  const right = new Set(textTokens(b))
  if (left.size === 0 || right.size === 0) return 0
  let inter = 0
  for (const token of left) if (right.has(token)) inter++
  const union = left.size + right.size - inter
  return union === 0 ? 0 : clamp01(inter / union)
}

export interface ContradictionOptions {
  /**
   * 语义相似度 0..1（通常来自嵌入余弦）。缺省用词面 Jaccard 兜底 ——
   * 只适合单测 / 无向量场景，别拿它替代真实嵌入。
   */
  similarity?: number
}

/**
 * 评估两条正文的矛盾：置信度 + 等级 + 信号 + 差异明细。
 *
 * 不依赖 store / 任何记录对象 —— 传两条字符串即可；`MemoryRecord` 版见
 * assessRecordContradiction。
 */
export function assessContradiction(leftContent: string, rightContent: string, options: ContradictionOptions = {}): ContradictionAssessment {
  const similarity = options.similarity !== undefined && Number.isFinite(options.similarity)
    ? clamp01(options.similarity)
    : lexicalSimilarity(leftContent, rightContent)
  const comparison = compareClaims(leftContent, rightContent)
  const detail = clamp01(NUMERIC_WEIGHT * comparison.numericRate + IDENTIFIER_WEIGHT * comparison.identifierRate)
  const criticalDetailConflict = hasCriticalDetailConflict(leftContent, rightContent)
  const confidence = clamp01(
    similarity * (DETAIL_WEIGHT * detail + CRITICAL_WEIGHT * (criticalDetailConflict ? 1 : 0)),
  )
  return {
    confidence,
    level: contradictionLevel(confidence),
    similarity,
    signals: {
      numeric: comparison.numericRate,
      identifier: comparison.identifierRate,
      detail,
      criticalDetailConflict,
    },
    comparison,
  }
}

/** 记录版：等价于 assessContradiction(a.content, b.content, options)。 */
export function assessRecordContradiction(
  a: MemoryRecord,
  b: MemoryRecord,
  options: ContradictionOptions = {},
): ContradictionAssessment {
  return assessContradiction(a.content, b.content, options)
}
