/**
 * Lexical scoring — pure functions, no I/O.
 *
 * Tokenization handles mixed CJK/Latin text: Latin words plus CJK unigrams
 * and bigrams (bigrams matter — single Chinese characters are too ambiguous).
 */

export interface LexicalStats {
  /** document frequency per token across the candidate universe */
  df: Map<string, number>
  /** number of documents in the universe */
  n: number
}

export function tokenize(text: string): string[] {
  const lower = text.toLowerCase()
  const tokens: string[] = []
  for (const m of lower.matchAll(/[a-z0-9][a-z0-9_+\-.]{1,}/g)) tokens.push(m[0])
  for (const run of lower.matchAll(/[\u3400-\u4dbf\u4e00-\u9fff]+/g)) {
    const chars = [...run[0]]
    for (const c of chars) tokens.push(c)
    for (let i = 0; i + 1 < chars.length; i++) tokens.push(chars[i]! + chars[i + 1]!)
  }
  return tokens
}

export function buildStats(tokenSets: Iterable<Set<string>>): LexicalStats {
  const df = new Map<string, number>()
  let n = 0
  for (const set of tokenSets) {
    n++
    for (const t of set) df.set(t, (df.get(t) ?? 0) + 1)
  }
  return { df, n }
}

/** IDF-weighted overlap of query tokens present in the record, normalized to 0..1. */
export function lexicalScore(queryTokens: string[], recordTokens: Set<string>, stats: LexicalStats): number {
  const unique = [...new Set(queryTokens)]
  if (unique.length === 0 || stats.n === 0) return 0
  let hit = 0
  let total = 0
  for (const t of unique) {
    const idf = Math.log(1 + stats.n / (1 + (stats.df.get(t) ?? 0)))
    total += idf
    if (recordTokens.has(t)) hit += idf
  }
  return total === 0 ? 0 : hit / total
}

/**
 * True when the query shares at least one STRONG token with the record —
 * a Latin word or a CJK bigram. Single CJK characters are too ambiguous to
 * stand alone: a query mentioning 完 shouldn't match every record containing
 * 完. Matches carried only by weak tokens must clear a higher score floor
 * (0.25: the measured floor of real hits) instead of the permissive one.
 */
export function hasStrongHit(queryTokens: string[], recordTokens: Set<string>): boolean {
  for (const t of queryTokens) {
    if (t.length >= 2 && recordTokens.has(t)) return true
  }
  return false
}

/** Exponential recency decay with configurable half-life. */
export function recencyFactor(lastAccessedAt: number, now: number, halfLifeDays: number): number {
  const ageDays = Math.max(0, now - lastAccessedAt) / 86_400_000
  return Math.pow(0.5, ageDays / Math.max(halfLifeDays, 0.001))
}

export interface RecordScoreOptions {
  now: number
  halfLifeDays: number
  /** Superseded records stay retrievable but rank lower. */
  superseded: boolean
}

export function recordScore(
  lexical: number,
  importance: number,
  accessCount: number,
  lastAccessedAt: number,
  opts: RecordScoreOptions,
): number {
  const recency = recencyFactor(lastAccessedAt, opts.now, opts.halfLifeDays)
  const importanceFactor = 0.5 + 0.5 * Math.min(1, Math.max(0, importance))
  const accessBoost = 1 + 0.1 * Math.log(1 + accessCount)
  const penalty = opts.superseded ? 0.3 : 1
  return lexical * recency * importanceFactor * accessBoost * penalty
}

/** Cosine similarity for unit vectors == dot product. Normalizes defensively. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** Normalize a vector in place; returns it. Zero vectors are left as-is. */
export function normalizeInPlace(v: Float32Array): Float32Array {
  let sum = 0
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!
  const norm = Math.sqrt(sum)
  if (norm > 0) for (let i = 0; i < v.length; i++) v[i] = v[i]! / norm
  return v
}

// ---------------------------------------------------------------------------
// Result shaping (0.32.0): absolute floor → synonym dedupe → MMR diversity.
//
// 这三步解决同一个症状:同一句查询召回 5 条,其中 3 条是弱相关噪声,另外两条
// 同义记忆(向量余弦 0.86+)互相挤占名额。它们只依赖 `{ id, score, vector? }`
// 这个最小结构,不 import 服务层类型 —— search() 把内部候选映射过来即可。
// 顺序很重要:floor 先砍噪声,dedupe 再合并同义,MMR 最后在剩余里做多样性,
// 这样后两步不会浪费名额在已经被判定为噪声的条目上。
// ---------------------------------------------------------------------------

/** 结果整形需要的最小条目形状(id 用于去重,vector 仅用于冗余惩罚)。 */
export interface ScoredItem {
  id: string
  score: number
  /** 记录向量;缺失/空数组 = 该条不参与冗余惩罚(退化为纯分数)。 */
  vector?: ArrayLike<number> | null
}

/**
 * 终态命中的绝对分数下限。低于它的条目是"弱相关噪声"而不是命中 —— 即使
 * topK 没用满也不补位。0.25 与 `REAL_HIT_FLOOR` 同源(实测真命中的下限),
 * 调用方有实测数据时可以覆写。
 */
export const FINAL_SCORE_FLOOR = 0.25

/**
 * 丢掉分数低于绝对下限的条目。纯函数,返回新数组,保持原顺序。
 * `floor <= 0` 表示关闭这一层。
 */
export function finalFloor<T extends { score: number }>(hits: readonly T[], floor: number = FINAL_SCORE_FLOOR): T[] {
  if (!(floor > 0)) return [...hits]
  return hits.filter((hit) => hit.score >= floor)
}

/**
 * 同义结果合并阈值:余弦 ≥ 该值的两条记忆视为同一条,只保留分高的那条。
 * 0.85 是实测量级 —— 真正同义的两条记忆实测 0.865,而不同事情的记忆通常 < 0.7。
 */
export const DEFAULT_SEMANTIC_DEDUPE_THRESHOLD = 0.85

export interface SemanticDedupeOptions<T extends ScoredItem = ScoredItem> {
  /**
   * 没有向量时的自定义相似度(返回 undefined = 无法判断,不合并)。
   * 例如按规范化正文相等合并跨 scope 的重复记忆。
   */
  similarityOf?: (a: T, b: T) => number | undefined
}

export interface SemanticDedupeResult<T extends ScoredItem> {
  /** 保留的条目,按分数从高到低(同分按 id 升序,保证确定性)。 */
  hits: T[]
  /** 被合并掉的 id,按扫描顺序(分数降序)出现。 */
  merged: string[]
  /** 被合并 id → 保留的 id。 */
  mergeMap: Map<string, string>
}

function usableVector(item: ScoredItem): ArrayLike<number> | undefined {
  const v = item.vector
  return v != null && v.length > 0 ? v : undefined
}

/** 两条条目的冗余度:两边都有可用向量时用余弦,否则 0(不惩罚)。 */
function similarityOfItems(a: ScoredItem, b: ScoredItem): number {
  const va = usableVector(a)
  const vb = usableVector(b)
  if (!va || !vb) return 0
  return cosine(va, vb)
}

/** 确定性的"分数降序、id 升序"排序(不改动入参)。 */
function byScoreThenId<T extends ScoredItem>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
}

/**
 * 合并同义结果:按分数顺序扫描,与已保留条目的相似度 ≥ threshold 就并入
 * 分最高的那条,否则保留。返回保留集合 + 被合并 id 列表。
 *
 * 纯函数。分数相同且 id 不同时按 id 升序决定谁留下,保证跨进程可复现。
 */
export function semanticDedupe<T extends ScoredItem>(
  hits: readonly T[],
  threshold: number = DEFAULT_SEMANTIC_DEDUPE_THRESHOLD,
  opts: SemanticDedupeOptions<T> = {},
): SemanticDedupeResult<T> {
  const sorted = byScoreThenId(hits)
  const kept: T[] = []
  const merged: string[] = []
  const mergeMap = new Map<string, string>()
  for (const hit of sorted) {
    let survivor: T | undefined
    for (const rep of kept) {
      const sim = opts.similarityOf?.(hit, rep) ?? similarityOfItems(hit, rep)
      if (sim >= threshold) {
        survivor = rep
        break
      }
    }
    if (survivor) {
      merged.push(hit.id)
      mergeMap.set(hit.id, survivor.id)
    } else {
      kept.push(hit)
    }
  }
  return { hits: kept, merged, mergeMap }
}

/** MMR 默认的相关系数:偏相关一点(0.7),噪声剔除交给 floor/dedupe。 */
export const DEFAULT_MMR_LAMBDA = 0.7

/**
 * 最大边际相关性(Maximal Marginal Relevance)选择:
 *   argmax λ·rel(i) − (1−λ)·max_{j∈已选} sim(i,j)
 * 用记录向量余弦做冗余惩罚,无向量时退化为"按分数去重"(纯分数排序 + id 去重)。
 *
 * rel 用候选集内的 min-max 归一到 0..1,避免分数域(可能 >1)与余弦 0..1 直接相加。
 * 纯函数;结果顺序 = 选择顺序(即输出顺序)。k 超过候选数时返回全部。
 */
export function mmrSelect<T extends ScoredItem>(
  candidates: readonly T[],
  lambda: number = DEFAULT_MMR_LAMBDA,
  k: number = candidates.length,
): T[] {
  // 同一 id 只保留最高分那条:候选集合可能由多通道合并而来。
  const best = new Map<string, T>()
  for (const c of candidates) {
    const prev = best.get(c.id)
    if (prev === undefined || c.score > prev.score) best.set(c.id, c)
  }
  const pool = byScoreThenId([...best.values()])
  const limit = Math.max(0, Math.min(Math.floor(k), pool.length))
  if (limit === 0) return []

  // 无向量(缺失/空数组)= 没有冗余信息可算,退化为分数去重。
  if (!pool.some((c) => usableVector(c) !== undefined)) return pool.slice(0, limit)

  const lo = Math.min(...pool.map((c) => c.score))
  const hi = Math.max(...pool.map((c) => c.score))
  const span = hi - lo
  const rel = pool.map((c) => (span > 0 ? (c.score - lo) / span : 1))
  const weight = Math.min(1, Math.max(0, lambda))

  const simCache = new Map<number, number>() // key = i * pool.length + j, i > j
  const sim = (i: number, j: number): number => {
    const a = i > j ? i : j
    const b = i > j ? j : i
    const key = a * pool.length + b
    const cached = simCache.get(key)
    if (cached !== undefined) return cached
    const value = similarityOfItems(pool[a]!, pool[b]!)
    simCache.set(key, value)
    return value
  }

  const selected: number[] = []
  const chosen = new Set<number>()
  while (selected.length < limit) {
    let bestIdx = -1
    let bestValue = Number.NEGATIVE_INFINITY
    for (let i = 0; i < pool.length; i++) {
      if (chosen.has(i)) continue
      let redundancy = 0
      for (const j of selected) redundancy = Math.max(redundancy, sim(i, j))
      const value = weight * rel[i]! - (1 - weight) * redundancy
      // 同分时:相关度更高者优先,再按 id 升序 —— 不能依赖 Map/数组顺序。
      if (value > bestValue
        || (value === bestValue && bestIdx >= 0 && rel[i]! > rel[bestIdx]!)) {
        bestValue = value
        bestIdx = i
      }
    }
    if (bestIdx < 0) break
    selected.push(bestIdx)
    chosen.add(bestIdx)
  }
  return selected.map((i) => pool[i]!)
}

/** LRU cache for rerank/embedding dedupe. */
export class LruSet<V> {
  private map = new Map<string, V>()
  readonly capacity: number

  constructor(capacity: number) {
    this.capacity = capacity
  }

  get(key: string): V | undefined {
    const v = this.map.get(key)
    if (v !== undefined) {
      this.map.delete(key)
      this.map.set(key, v)
    }
    return v
  }
  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
  }
}
