/**
 * 正式 BM25 词法打分 —— 0.36.0。
 *
 * 为什么需要这一层(替代 `scoring.lexicalScore` 的召回打分):
 *   现有词法分是 "IDF 加权的查询覆盖率"(命中 token 的 IDF / 全部查询 token 的 IDF),
 *   它是 0..1 的覆盖率,不是检索模型:词频完全不参与(同一 token 出现 1 次还是 10 次
 *   一个分),长文档也不受惩罚(一条 3000 字记忆只要碰巧命中关键词就能和 20 字记忆
 *   同分)。BM25 把这两个维度显式建模:
 *
 *     score(q,d) = Σ_{t∈q} IDF(t) · tf'(t,d)·(k1+1) / (tf'(t,d) + k1·(1 − b + b·dl(d)/avgdl))
 *
 *   - k1 控制词频饱和:tf 越大分越高,但收益递减(k1=1.2 时第 2 次出现的边际收益
 *     明显小于第 1 次),避免"刷关键词"的记忆霸榜;
 *   - b 控制长度归一:b=0 完全忽略长度(只比词频),b=1 完全按长度压缩,0.75 是
 *     标准折中;
 *   - IDF 用非负的 `log(1 + (N − df + 0.5)/(df + 0.5))`:越常见的词权重越低,
 *     且 df 取到 N 时仍 ≥ 0,不会出现负 IDF(负 IDF 会让"命中的常见词越多分越低")。
 *
 * 口径约定:
 *   - token 直接复用 `scoring.tokenize`(拉丁词 + CJK 一元/二元),与现有词法通道、
 *     自适应阈值、hasStrongHit 完全同一套分词,不引入第二套口径;
 *   - 多字段加权(BM25F 的简化版):正文 × contentWeight、标签 × tagsWeight。
 *     标签是人工挑的触发词,正文里未必出现(例如 tags=['release'] 但正文是中文),
 *     等权会低估标签命中,所以默认给标签更高权重。加权方式:
 *       tf'(t,d) = Σ_f w_f·tf_f(t,d)
 *       dl(d)   = Σ_f w_f·|field_tokens|
 *     avgdl 也是加权长度的均值。只有一个字段时就是标准 BM25;
 *   - 查询 token 去重后逐个累加(重复的查询 token 不再放大权重 —— 查询侧的
 *     "出现两次"通常只是分词产物,不是用户意图);
 *   - 未登录词(df=0 且 tf=0)贡献 0,不抛错;空语料 / 空查询返回 0。
 *
 * 纯函数、无 I/O、零第三方依赖:buildBm25Docs 只读入参,bm25Score 不写索引。
 * 调用方(index.ts 的词法通道)把当前 scope 的记录映射成 Bm25DocInput 即可,
 * 不需要迁移任何存量数据。
 */
import { tokenize } from '../scoring.ts'

/** k1 默认值:词频饱和速度(标准取法 1.2)。 */
export const DEFAULT_BM25_K1 = 1.2
/** b 默认值:长度归一强度(标准取法 0.75)。 */
export const DEFAULT_BM25_B = 0.75
/** 正文字段默认权重。 */
export const DEFAULT_CONTENT_WEIGHT = 1
/** 标签字段默认权重:标签是人工挑的触发词,比正文更"贵",默认略高于正文。 */
export const DEFAULT_TAGS_WEIGHT = 1.5

/** 字段内容:文本(内部 tokenize)或已切好的 token 列表(直接使用)。 */
export type Bm25FieldText = string | readonly string[]

/** 建索引的文档输入:一条记忆 = id + 正文 + 可选标签。 */
export interface Bm25DocInput {
  id: string
  /** 正文;数组表示调用方已 tokenize(不再二次分词,便于单测精确控分)。 */
  content: Bm25FieldText
  /** 标签;数组表示已 tokenize。 */
  tags?: Bm25FieldText
}

export interface Bm25Options {
  /** 词频饱和参数,默认 1.2;非有限值回落默认、负数按 0 处理 */
  k1?: number
  /** 长度归一参数,默认 0.75;夹到 0..1 */
  b?: number
  /** 正文字段权重,默认 1;非有限值回落默认,负数按 0(关闭正文字段) */
  contentWeight?: number
  /** 标签字段权重,默认 1.5;非有限值回落默认,负数按 0(关闭标签字段) */
  tagsWeight?: number
}

/** 解析后的参数(索引上原样暴露,便于面板/日志标注与单测断言)。 */
export interface ResolvedBm25Options {
  k1: number
  b: number
  contentWeight: number
  tagsWeight: number
}

/** 单条文档的索引形态:加权长度 + 加权词频。 */
export interface Bm25DocStats {
  id: string
  /** 加权字段长度 Σ_f w_f·|field_tokens|(avgdl 的分子) */
  length: number
  /** 加权词频 tf'(t) = Σ_f w_f·tf_f(t) */
  termFreq: Map<string, number>
}

/** 一个候选集合的 BM25 索引(通常 = 一个 scope 的全部记录)。 */
export interface Bm25Index extends ResolvedBm25Options {
  /** 文档数(重复 id 只算一条:后者覆盖前者) */
  n: number
  /** 文档频率:token → 含该 token 的文档数(以最终文档集合为准) */
  df: Map<string, number>
  /** 加权文档长度均值;空语料为 0 */
  avgLength: number
  /** id → 文档索引;迭代顺序与入参中首次出现的顺序一致 */
  docs: Map<string, Bm25DocStats>
}

/** 分数与 id 的最小命中形状(可直接喂给 fusion.reciprocalRankFusion)。 */
export interface Bm25Hit {
  id: string
  score: number
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value))
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 权重解析:非有限值回落默认,负数按 0(0 是合法权重 = 关闭该字段)。 */
function weightOr(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(0, value)
}

function resolveOptions(opts: Bm25Options = {}): ResolvedBm25Options {
  return {
    k1: Math.max(0, finiteOr(opts.k1, DEFAULT_BM25_K1)),
    b: clamp(finiteOr(opts.b, DEFAULT_BM25_B), 0, 1),
    contentWeight: weightOr(opts.contentWeight, DEFAULT_CONTENT_WEIGHT),
    tagsWeight: weightOr(opts.tagsWeight, DEFAULT_TAGS_WEIGHT),
  }
}

/** 字段取 token:字符串走现有 tokenize,数组按已分词直接过滤使用。 */
function fieldTokens(field: Bm25FieldText | undefined): string[] {
  if (typeof field === 'string') return tokenize(field)
  if (!Array.isArray(field)) return []
  const tokens: string[] = []
  for (const token of field as readonly string[]) {
    if (typeof token === 'string' && token.length > 0) tokens.push(token)
  }
  return tokens
}

/**
 * 建 BM25 索引。纯函数:不修改 docs,也不写任何外部状态。
 *
 * 行为:
 *   - id 为空/非字符串的条目直接忽略(避免多条记录挤到同一个空 id 上);
 *   - 重复 id:后者覆盖前者(df / avgdl 都按最终集合重算,不会留下幽灵文档);
 *   - 空语料:n=0、avgLength=0,docs 为空 Map。
 */
export function buildBm25Docs(docs: readonly Bm25DocInput[], opts: Bm25Options = {}): Bm25Index {
  const resolved = resolveOptions(opts)
  const byId = new Map<string, Bm25DocStats>()
  for (const doc of docs ?? []) {
    if (doc === null || doc === undefined) continue
    if (typeof doc.id !== 'string' || doc.id.length === 0) continue
    const contentTokens = fieldTokens(doc.content)
    const tagsTokens = fieldTokens(doc.tags)
    const termFreq = new Map<string, number>()
    const accumulate = (tokens: readonly string[], fieldWeight: number): void => {
      // 权重 0 = 关闭该字段:连 df 也不该被它污染,否则会压低其他字段命中的 IDF。
      if (!(fieldWeight > 0)) return
      for (const token of tokens) termFreq.set(token, (termFreq.get(token) ?? 0) + fieldWeight)
    }
    accumulate(contentTokens, resolved.contentWeight)
    accumulate(tagsTokens, resolved.tagsWeight)
    const length = resolved.contentWeight * contentTokens.length
      + resolved.tagsWeight * tagsTokens.length
    byId.set(doc.id, { id: doc.id, length, termFreq })
  }

  const df = new Map<string, number>()
  let totalLength = 0
  for (const doc of byId.values()) {
    totalLength += doc.length
    for (const token of doc.termFreq.keys()) df.set(token, (df.get(token) ?? 0) + 1)
  }
  return {
    n: byId.size,
    df,
    avgLength: byId.size > 0 ? totalLength / byId.size : 0,
    docs: byId,
    ...resolved,
  }
}

/**
 * 非负 IDF:`log(1 + (N − df + 0.5)/(df + 0.5))`。
 *
 * df 先夹到 [0, N](脏输入不会让 log 变负或 NaN),n ≤ 0 返回 0。
 * 单调性:df 越小(词越稀有)IDF 越大;df = N 时仍为正(约 0.0025)。
 */
export function bm25Idf(df: number, n: number): number {
  if (!(n > 0) || !Number.isFinite(n)) return 0
  const freq = clamp(Number.isFinite(df) ? df : 0, 0, n)
  const idf = Math.log(1 + (n - freq + 0.5) / (freq + 0.5))
  return Number.isFinite(idf) ? Math.max(0, idf) : 0
}

/**
 * 单条文档的 BM25 分。
 *
 * 参数顺序:queryTokens → docIndex(单条文档索引)→ stats(BM25 索引)。
 * 纯函数;queryTokens 会被去重,空 token / 未登录词 / 空文档贡献 0。
 */
export function bm25Score(
  queryTokens: readonly string[],
  doc: Bm25DocStats | null | undefined,
  index: Bm25Index | null | undefined,
): number {
  if (doc === null || doc === undefined || index === null || index === undefined) return 0
  if (!(index.n > 0)) return 0
  const seen = new Set<string>()
  let score = 0
  for (const token of queryTokens ?? []) {
    if (typeof token !== 'string' || token.length === 0 || seen.has(token)) continue
    seen.add(token)
    const tf = doc.termFreq.get(token) ?? 0
    if (!(tf > 0)) continue
    const idf = bm25Idf(index.df.get(token) ?? 0, index.n)
    if (!(idf > 0)) continue
    const lengthNorm = index.avgLength > 0 && Number.isFinite(doc.length)
      ? 1 - index.b + index.b * (doc.length / index.avgLength)
      : 1
    const denominator = tf + index.k1 * lengthNorm
    if (!(denominator > 0)) continue
    score += (idf * (tf * (index.k1 + 1))) / denominator
  }
  return Number.isFinite(score) ? Math.max(0, score) : 0
}

/** 确定性 id 比较(码点序,不依赖 locale)。 */
function compareIds(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/**
 * 对整个索引打分并排序:分数降序,同分按 id 升序(跨进程可复现)。
 * 只返回 score > 0 的文档;limit 省略 = 全部,0/负数 = 空数组。
 *
 * 输出可直接作为 RRF 的一路排名列表:`{ name: 'bm25', ids: rankByBm25(...).map(h => h.id) }`。
 */
export function rankByBm25(
  queryTokens: readonly string[],
  index: Bm25Index | null | undefined,
  limit?: number,
): Bm25Hit[] {
  if (index === null || index === undefined || !(index.n > 0)) return []
  const hits: Bm25Hit[] = []
  for (const doc of index.docs.values()) {
    const score = bm25Score(queryTokens, doc, index)
    if (score > 0) hits.push({ id: doc.id, score })
  }
  hits.sort((a, b) => b.score - a.score || compareIds(a.id, b.id))
  const cap = limit === undefined
    ? hits.length
    : Math.max(0, Math.min(hits.length, Number.isFinite(limit) ? Math.floor(limit) : 0))
  return cap >= hits.length ? hits : hits.slice(0, cap)
}
