/**
 * 写入裁决（write arbiter）—— Mem0 式 ADD / UPDATE / NOOP。
 *
 * 纯函数，零 I/O：调用方提供**同作用域内的近邻候选**（可选带向量）。
 * - 有向量：余弦优先；
 * - 没向量：词法 Dice 兜底（完全离线、确定性）。
 *
 * 判决顺序（固定，先硬冲突后重复）：
 *   0. 显式 supersedes            → UPDATE（用户意图优先，NOOP 不得吃掉显式修正）
 *   1. 归一化正文完全相同          → NOOP(identical-content)
 *   2. sim >= update 且 事实冲突   → UPDATE(fact-conflict)
 *   3. sim >= update 且 否定翻转   → UPDATE(negation-flip)
 *   4. sim >= noop                → NOOP(duplicate)
 *   5. sim >= update 且有新信息    → ADD(new-detail)
 *   6. sim >= update 且无新信息    → NOOP(duplicate)
 *   7. 其余                       → ADD(below-threshold)
 *
 * 事实冲突只认三类硬信号：数字、路径、否定极性 —— 宁可漏判，不可错杀。
 * 任何异常都应由调用方退化成 ADD（本模块不抛错）。
 */

import { tokenize, cosine } from '../scoring.ts'

export type WriteAction = 'ADD' | 'UPDATE' | 'NOOP'

export type WriteReason =
  | 'explicit-supersedes'
  | 'identical-content'
  | 'fact-conflict'
  | 'negation-flip'
  | 'duplicate'
  | 'new-detail'
  | 'below-threshold'

export interface ArbiterNeighbor {
  readonly id: string
  readonly content: string
  readonly kind?: string
  readonly importance?: number
}

export interface ArbiterInput {
  /** 待写入正文（已过钩子与脱敏）。 */
  readonly content: string
  /** 同作用域近邻候选。 */
  readonly neighbors: ReadonlyArray<ArbiterNeighbor>
  readonly kind?: string
  /** 候选自身向量（可缺省）。 */
  readonly vector?: ArrayLike<number> | null
  /** 近邻 id → 向量（缺省项退回词法）。 */
  readonly neighborVectors?: ReadonlyMap<string, ArrayLike<number>>
  /** 显式修正目标：存在时直接 UPDATE，跳过重复判定。 */
  readonly supersedes?: string
  readonly noopThreshold?: number
  readonly updateThreshold?: number
  readonly noveltyFloor?: number
  /** 只在同 kind 之间做近似判定（默认 true）。 */
  readonly sameKindOnly?: boolean
  /** 最多比较多少条候选（默认 500，确定性截断）。 */
  readonly maxCandidates?: number
}

export interface ArbiterEvidence {
  readonly numbers: boolean
  readonly paths: boolean
  readonly negation: boolean
}

export interface ArbiterResult {
  readonly action: WriteAction
  readonly targetId?: string
  readonly similarity: number
  readonly reason: WriteReason
  readonly evidence: ArbiterEvidence
}

export const DEFAULT_NOOP_THRESHOLD = 0.92
export const DEFAULT_UPDATE_THRESHOLD = 0.75
export const DEFAULT_NOVELTY_FLOOR = 0.15
export const DEFAULT_MAX_CANDIDATES = 500

function clamp01(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(1, Math.max(0, value))
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase()
}

function tokenSet(text: string): Set<string> {
  return new Set(tokenize(text))
}

/** 词法 Dice：完全离线，用于没有向量的场景。 */
export function diceSimilarity(a: string, b: string): number {
  const ta = tokenSet(a)
  const tb = tokenSet(b)
  if (ta.size === 0 || tb.size === 0) return 0
  let inter = 0
  for (const token of ta) if (tb.has(token)) inter++
  return (2 * inter) / (ta.size + tb.size)
}

/** 候选里有多少 token 是旧记录没有的（0..1）。 */
export function noveltyRatio(candidate: string, existing: string): number {
  const tc = tokenSet(candidate)
  if (tc.size === 0) return 0
  const te = tokenSet(existing)
  let novel = 0
  for (const token of tc) if (!te.has(token)) novel++
  return novel / tc.size
}

export interface FactTokens {
  readonly numbers: ReadonlySet<string>
  readonly paths: ReadonlySet<string>
}

/** 抽数字（含版本/IP 这类点分序列）与路径（同时认 `/` 与 `\`，兼容 Windows）。 */
export function extractFactTokens(text: string): FactTokens {
  const numbers = new Set<string>()
  for (const m of text.matchAll(/[0-9]+(?:\.[0-9]+)*/g)) numbers.add(m[0].replace(/^0+(?=\d)/, ''))
  const paths = new Set<string>()
  for (const m of text.matchAll(/(?:[A-Za-z]:)?(?:[\\/]+[\w.@-]+){2,}/g)) {
    paths.add(m[0].replace(/\\/g, '/').replace(/\/+/g, '/'))
  }
  return { numbers, paths }
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}

const NEGATION_RE = /(?:不要|不能|不用|不允许|禁止|取消|停止|禁用|永不|勿|别|未|没|不|not\b|never\b|without\b|cannot\b|n't\b|disable)/i

export interface NegationProfile {
  readonly negated: boolean
  readonly count: number
}

/**
 * 中文里大量「不」开头的词并不表达否定（不一样/不错/不仅/不同…），
 * 先剔除这些假朋友，否则「完全不一样的措辞」会被误判成否定极性。
 */
const NEGATION_FALSE_FRIENDS = /(不一样|不也|不错|不仅|不断|不同|不少|不久|不得不|不管|不论|不过|不免|不愧|不确定性)/g

export function negationProfile(content: string): NegationProfile {
  const cleaned = content.replace(NEGATION_FALSE_FRIENDS, '')
  const hits = cleaned.match(new RegExp(NEGATION_RE.source, 'gi')) ?? []
  return { negated: hits.length > 0, count: hits.length }
}

/** 只有「极性不同」才算翻转：「不允许 A」vs「不允许 B」不算。 */
export function hasNegationFlip(a: string, b: string): boolean {
  return negationProfile(a).negated !== negationProfile(b).negated
}

export interface ConflictSignal {
  readonly conflict: boolean
  readonly numbers: boolean
  readonly paths: boolean
  readonly negation: boolean
}

/** 三类硬冲突：数字、路径、否定极性。 */
export function detectFactConflict(a: string, b: string): ConflictSignal {
  const fa = extractFactTokens(a)
  const fb = extractFactTokens(b)
  const numbers = fa.numbers.size > 0 && fb.numbers.size > 0 && !sameSet(fa.numbers, fb.numbers)
  const paths = fa.paths.size > 0 && fb.paths.size > 0 && !sameSet(fa.paths, fb.paths)
  const negation = hasNegationFlip(a, b)
  return { conflict: numbers || paths || negation, numbers, paths, negation }
}

function similarityOf(
  content: string,
  vector: ArrayLike<number> | null | undefined,
  neighbor: ArbiterNeighbor,
  neighborVectors: ReadonlyMap<string, ArrayLike<number>> | undefined,
): number {
  const neighborVector = neighborVectors?.get(neighbor.id)
  if (vector != null && neighborVector != null && vector.length === neighborVector.length) {
    return Math.max(0, cosine(vector, neighborVector))
  }
  return diceSimilarity(content, neighbor.content)
}

/**
 * 裁决一次写入。调用方据此决定：直接落库（ADD）、带 supersedes 落库（UPDATE）、
 * 或把已有记录返回给调用方（NOOP，不写盘）。
 */
export function decideWrite(input: ArbiterInput): ArbiterResult {
  const noopThreshold = clamp01(input.noopThreshold, DEFAULT_NOOP_THRESHOLD)
  const updateThreshold = Math.min(clamp01(input.updateThreshold, DEFAULT_UPDATE_THRESHOLD), noopThreshold)
  const noveltyFloor = clamp01(input.noveltyFloor, DEFAULT_NOVELTY_FLOOR)
  const sameKindOnly = input.sameKindOnly !== false
  const maxCandidates = Math.max(0, Math.floor(input.maxCandidates ?? DEFAULT_MAX_CANDIDATES))
  const emptyEvidence: ArbiterEvidence = { numbers: false, paths: false, negation: false }

  const explicit = input.supersedes?.trim()
  if (explicit !== undefined && explicit !== '') {
    return { action: 'UPDATE', targetId: explicit, similarity: 0, reason: 'explicit-supersedes', evidence: emptyEvidence }
  }

  const candidates = input.neighbors
    .filter((n) => !sameKindOnly || input.kind === undefined || n.kind === undefined || n.kind === input.kind)
    .slice(0, maxCandidates)

  if (candidates.length === 0) {
    return { action: 'ADD', similarity: 0, reason: 'below-threshold', evidence: emptyEvidence }
  }

  let best: { neighbor: ArbiterNeighbor; similarity: number } | undefined
  for (const neighbor of candidates) {
    const similarity = similarityOf(input.content, input.vector, neighbor, input.neighborVectors)
    if (
      best === undefined
      || similarity > best.similarity
      || (similarity === best.similarity && (neighbor.importance ?? 0) > (best.neighbor.importance ?? 0))
      || (similarity === best.similarity && (neighbor.importance ?? 0) === (best.neighbor.importance ?? 0) && neighbor.id < best.neighbor.id)
    ) {
      best = { neighbor, similarity }
    }
  }
  if (best === undefined) {
    return { action: 'ADD', similarity: 0, reason: 'below-threshold', evidence: emptyEvidence }
  }

  const similarity = Math.round(best.similarity * 1000) / 1000
  const targetId = best.neighbor.id
  const signal = detectFactConflict(best.neighbor.content, input.content)
  const evidence: ArbiterEvidence = { numbers: signal.numbers, paths: signal.paths, negation: signal.negation }

  if (normalizeText(best.neighbor.content) === normalizeText(input.content)) {
    return { action: 'NOOP', targetId, similarity, reason: 'identical-content', evidence }
  }
  if (similarity >= updateThreshold && (signal.numbers || signal.paths)) {
    return { action: 'UPDATE', targetId, similarity, reason: 'fact-conflict', evidence }
  }
  if (similarity >= updateThreshold && signal.negation) {
    return { action: 'UPDATE', targetId, similarity, reason: 'negation-flip', evidence }
  }
  if (similarity >= noopThreshold) {
    return { action: 'NOOP', targetId, similarity, reason: 'duplicate', evidence }
  }
  if (similarity >= updateThreshold) {
    if (noveltyRatio(input.content, best.neighbor.content) >= noveltyFloor) {
      return { action: 'ADD', targetId, similarity, reason: 'new-detail', evidence }
    }
    return { action: 'NOOP', targetId, similarity, reason: 'duplicate', evidence }
  }
  return { action: 'ADD', similarity, reason: 'below-threshold', evidence }
}
