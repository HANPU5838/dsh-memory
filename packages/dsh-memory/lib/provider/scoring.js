/**
 * Lexical scoring — pure functions, no I/O.
 *
 * Tokenization handles mixed CJK/Latin text: Latin words plus CJK unigrams
 * and bigrams (bigrams matter — single Chinese characters are too ambiguous).
 */

                               
                                                                   
                         
                                            
           
 

export function tokenize(text        )           {
  const lower = text.toLowerCase()
  const tokens           = []
  for (const m of lower.matchAll(/[a-z0-9][a-z0-9_+\-.]{1,}/g)) tokens.push(m[0])
  for (const run of lower.matchAll(/[\u3400-\u4dbf\u4e00-\u9fff]+/g)) {
    const chars = [...run[0]]
    for (const c of chars) tokens.push(c)
    for (let i = 0; i + 1 < chars.length; i++) tokens.push(chars[i]  + chars[i + 1] )
  }
  return tokens
}

export function buildStats(tokenSets                       )               {
  const df = new Map                ()
  let n = 0
  for (const set of tokenSets) {
    n++
    for (const t of set) df.set(t, (df.get(t) ?? 0) + 1)
  }
  return { df, n }
}

/** IDF-weighted overlap of query tokens present in the record, normalized to 0..1. */
export function lexicalScore(queryTokens          , recordTokens             , stats              )         {
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
export function hasStrongHit(queryTokens          , recordTokens             )          {
  for (const t of queryTokens) {
    if (t.length >= 2 && recordTokens.has(t)) return true
  }
  return false
}

/** Exponential recency decay with configurable half-life. */
export function recencyFactor(lastAccessedAt        , now        , halfLifeDays        )         {
  const ageDays = Math.max(0, now - lastAccessedAt) / 86_400_000
  return Math.pow(0.5, ageDays / Math.max(halfLifeDays, 0.001))
}

                                     
             
                      
                                                            
                     
 

export function recordScore(
  lexical        ,
  importance        ,
  accessCount        ,
  lastAccessedAt        ,
  opts                    ,
)         {
  const recency = recencyFactor(lastAccessedAt, opts.now, opts.halfLifeDays)
  const importanceFactor = 0.5 + 0.5 * Math.min(1, Math.max(0, importance))
  const accessBoost = 1 + 0.1 * Math.log(1 + accessCount)
  const penalty = opts.superseded ? 0.3 : 1
  return lexical * recency * importanceFactor * accessBoost * penalty
}

/** Cosine similarity for unit vectors == dot product. Normalizes defensively. */
export function cosine(a                   , b                   )         {
  const n = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    dot += a[i]  * b[i] 
    na += a[i]  * a[i] 
    nb += b[i]  * b[i] 
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** Normalize a vector in place; returns it. Zero vectors are left as-is. */
export function normalizeInPlace(v              )               {
  let sum = 0
  for (let i = 0; i < v.length; i++) sum += v[i]  * v[i] 
  const norm = Math.sqrt(sum)
  if (norm > 0) for (let i = 0; i < v.length; i++) v[i] = v[i]  / norm
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
export function finalFloor                             (hits              , floor         = FINAL_SCORE_FLOOR)      {
  if (!(floor > 0)) return [...hits]
  return hits.filter((hit) => hit.score >= floor)
}

/**
 * 同义结果合并阈值:余弦 ≥ 该值的两条记忆视为同一条,只保留分高的那条。
 * 0.85 是实测量级 —— 真正同义的两条记忆实测 0.865,而不同事情的记忆通常 < 0.7。
 */
export const DEFAULT_SEMANTIC_DEDUPE_THRESHOLD = 0.85

                                                                           
     
                                           
                               
     
                                                   
 

                                                             
                                        
           
                                
                  
                         
                               
 

function usableVector(item            )                                {
  const v = item.vector
  return v != null && v.length > 0 ? v : undefined
}

/** 两条条目的冗余度:两边都有可用向量时用余弦,否则 0(不惩罚)。 */
function similarityOfItems(a            , b            )         {
  const va = usableVector(a)
  const vb = usableVector(b)
  if (!va || !vb) return 0
  return cosine(va, vb)
}

/** 确定性的"分数降序、id 升序"排序(不改动入参)。 */
function byScoreThenId                      (items              )      {
  return [...items].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
}

/**
 * 合并同义结果:按分数顺序扫描,与已保留条目的相似度 ≥ threshold 就并入
 * 分最高的那条,否则保留。返回保留集合 + 被合并 id 列表。
 *
 * 纯函数。分数相同且 id 不同时按 id 升序决定谁留下,保证跨进程可复现。
 */
export function semanticDedupe                      (
  hits              ,
  threshold         = DEFAULT_SEMANTIC_DEDUPE_THRESHOLD,
  opts                           = {},
)                          {
  const sorted = byScoreThenId(hits)
  const kept      = []
  const merged           = []
  const mergeMap = new Map                ()
  for (const hit of sorted) {
    let survivor               
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
export function mmrSelect                      (
  candidates              ,
  lambda         = DEFAULT_MMR_LAMBDA,
  k         = candidates.length,
)      {
  // 同一 id 只保留最高分那条:候选集合可能由多通道合并而来。
  const best = new Map           ()
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

  const simCache = new Map                () // key = i * pool.length + j, i > j
  const sim = (i        , j        )         => {
    const a = i > j ? i : j
    const b = i > j ? j : i
    const key = a * pool.length + b
    const cached = simCache.get(key)
    if (cached !== undefined) return cached
    const value = similarityOfItems(pool[a] , pool[b] )
    simCache.set(key, value)
    return value
  }

  const selected           = []
  const chosen = new Set        ()
  while (selected.length < limit) {
    let bestIdx = -1
    let bestValue = Number.NEGATIVE_INFINITY
    for (let i = 0; i < pool.length; i++) {
      if (chosen.has(i)) continue
      let redundancy = 0
      for (const j of selected) redundancy = Math.max(redundancy, sim(i, j))
      const value = weight * rel[i]  - (1 - weight) * redundancy
      // 同分时:相关度更高者优先,再按 id 升序 —— 不能依赖 Map/数组顺序。
      if (value > bestValue
        || (value === bestValue && bestIdx >= 0 && rel[i]  > rel[bestIdx] )) {
        bestValue = value
        bestIdx = i
      }
    }
    if (bestIdx < 0) break
    selected.push(bestIdx)
    chosen.add(bestIdx)
  }
  return selected.map((i) => pool[i] )
}

/** LRU cache for rerank/embedding dedupe. */
export class LruSet    {
          map = new Map           ()
           capacity        

  constructor(capacity        ) {
    this.capacity = capacity
  }

  get(key        )                {
    const v = this.map.get(key)
    if (v !== undefined) {
      this.map.delete(key)
      this.map.set(key, v)
    }
    return v
  }
  set(key        , value   )       {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
  }
}

/** 常见汉语功能词单字：只由这些字组成的 token 不算"内容词"。 */
const GENERIC_CJK_CHARS                      = new Set([
  '的', '了', '是', '在', '有', '和', '与', '或', '就', '都', '也', '很', '会', '能', '要', '想',
  '我', '你', '他', '她', '它', '们', '这', '那', '哪', '什', '么', '怎', '如', '何', '为', '吗',
  '呢', '吧', '啊', '呀', '哦', '嗯', '个', '些', '点', '下', '上', '中', '里', '天', '时', '候',
  '多', '少', '好', '可', '以', '办', '弄', '搞', '做', '事', '情', '样', '法', '话', '说', '等',
  '把', '被', '让', '给', '对', '从', '向', '到', '于', '而', '但', '却', '又', '再', '还', '只',
  '更', '最', '太', '挺', '才', '已', '经', '过', '着', '得', '地', '之', '其', '此', '该', '每',
  '各', '某', '谁', '啥', '俩', '您', '咱', '正', '刚', '快', '慢', '真', '假', '像', '跟', '同',
])

/**
 * 0.62.7：这个 token 是不是"通用功能词"（不含任何实义）。
 * 单字：字在功能词表里；多字：**每个字**都是功能词（如「怎么」「什么」「多少」「为什么」）。
 * 英文/数字 token 一律视为内容词（功能词表只针对汉字）。
 */
export function isGenericCjkToken(token        )          {
  if (!/^[\u3400-\u4dbf\u4e00-\u9fff]+$/u.test(token)) return false
  for (const char of token) if (!GENERIC_CJK_CHARS.has(char)) return false
  return true
}

/**
 * 0.62.7：词法准入要求"命中至少一个内容词"（≥2 字的非功能词）。
 *
 * 为什么：`hasStrongHit` 把任何 ≥2 字重叠都当强命中，于是「怎么办」「怎么减肥」
 * 这类查询会命中任何正文里带「怎么」的记忆 —— 实测「怎么办」返回了 3 条无关记忆，
 * 「怎么减肥」命中了含「怎么输出」的沟通偏好。功能词重叠不构成相关性证据；
 * 语义相关交给向量通道，词法通道只认实义。
 */
export function hasContentHit(queryTokens          , recordTokens             )          {
  for (const token of queryTokens) {
    if (token.length >= 2 && recordTokens.has(token) && !isGenericCjkToken(token)) return true
  }
  return false
}


//# sourceURL=source/memory-local/src/scoring.ts