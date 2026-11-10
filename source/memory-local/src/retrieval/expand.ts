/**
 * 伪相关反馈查询扩展(Rocchio)+ 查询画像 + 词法/向量动态混合权重 —— 0.33.0。
 *
 * 为什么需要这一层:
 *   1) 单轮检索只看查询本身。若查询和记忆用了不同措辞(「怎么让记忆别过期」
 *      vs 「TTL / validUntil / 有效期」),向量通道能救一部分,但查询向量本身
 *      离目标簇还远。Rocchio 伪相关反馈:先拿 top-N 结果当"伪相关文档",把查询
 *      向量往它们的质心推一点,再检索一次。它不需要标注,一轮就能明显改善召回。
 *      只做正反馈(α·q + β·mean(top)),不做负反馈 —— 第一轮没有可靠负例。
 *   2) 词法通道和向量通道各有强项:查 `src/retrieval/adapt.ts`、`v0.33.0`、
 *      端口号 8080 这类标识符/数字,词法精确、向量反而糊;查自然语言长句,
 *      向量语义泛化更好。固定权重(比如永远 0.5/0.5)会浪费这个差异,所以先
 *      给查询做画像,再按画像动态分配权重。
 *
 * 纯函数、无 I/O、零第三方依赖;不读任何配置对象,参数由调用方传入。
 */

// ---------------------------------------------------------------------------
// 查询画像
// ---------------------------------------------------------------------------

/**
 * 查询画像。所有比例的分母是**非空白字符数**(significant),以码点计;
 * 分母为 0(空查询/纯空白)时所有比例为 0。
 */
export interface QueryProfile {
  text: string
  /** 码点字符数(含空白) */
  chars: number
  /** 非空白字符数(比例分母) */
  significant: number
  /** CJK 统一表意文字字符数(含扩展 A) */
  cjkChars: number
  /** CJK 字符占比 0..1 */
  cjkRatio: number
  /** 拉丁字母数 */
  latinChars: number
  /** 拉丁字母占比 0..1 */
  latinRatio: number
  /** 数字字符数 */
  digitChars: number
  /** 数字占比 0..1 */
  digitRatio: number
  /**
   * 标识符字符数:以拉丁字母开头的连续串(允许数字与 `_ . / \ + - : $` 连写,
   * 如 `getById`、`src/retrieval/adapt.ts`、`llama-server`、`v0.33.0`)的总长度。
   * 纯数字串不算标识符(单独进 digitRatio)。
   */
  identifierChars: number
  /** 标识符字符占比 0..1 */
  identifierRatio: number
  /** 路径/文件名类 token 的字符数(空白分词后判定) */
  pathChars: number
  /** 路径类字符占比 0..1 */
  pathRatio: number
  /** 是否含有路径/文件名/命令特征 */
  hasPath: boolean
  /** 代码/标识符信号 0..1(identifierRatio + 数字密度 + 路径特征) */
  codeSignal: number
  /** 自然语言信号 0..1(CJK 比例与"不像代码"程度的组合) */
  naturalSignal: number
}

/** CJK 判定:CJK 统一表意文字 + 扩展 A。 */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/
/** 标识符串:必须以拉丁字母开头,允许代码里常见的连接符。 */
const IDENTIFIER_RE = /[A-Za-z][A-Za-z0-9_.\/\\+\-:$]*/g
/** 路径 token:整个 token 含目录分隔符(/ 或 \),如 `src/a.ts`、`/usr/bin`、`C:\x`。 */
const PATH_TOKEN_RE = /^[^\s]*[\/\\][^\s]*$/
/** 文件扩展名白名单:让无目录的 `adapt.ts` 也算路径,同时不误判 `v0.33`。 */
const PATH_EXT_RE = /\.(?:[cm]?[jt]sx?|json|jsonl|md|py|sh|ya?ml|toml|rs|go|java|txt|db|sql|log)$/i

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** 码点字符数。 */
function charCount(text: string): number {
  return typeof text === 'string' ? [...text].length : 0
}

/**
 * 分析查询文本,输出比例特征。纯函数、确定性;不做分词(不引 tokenize,
 * 避免和 adapt.profileQuery 的 token 口径耦合 —— 这里关心的是字符类别)。
 *
 * 定义:
 *   significant   = 非空白字符数
 *   cjkRatio      = CJK 字符 / significant
 *   latinRatio    = 拉丁字母 / significant
 *   identifierRatio = 标识符串总字符 / significant(串内标点也计入)
 *   pathRatio     = 路径类 token 字符 / significant
 *   codeSignal    = clamp01(0.55·identifierRatio
 *                           + 0.25·min(1, digitRatio·4)
 *                           + 0.20·(hasPath ? 1 : 0))
 *   naturalSignal = clamp01(0.7·cjkRatio + 0.3·(1 − codeSignal))
 */
export function queryProfile(text: string): QueryProfile {
  const source = typeof text === 'string' ? text : ''
  const chars = charCount(source)
  const significant = [...source].filter((ch) => !/\s/.test(ch)).length
  let cjkChars = 0
  let latinChars = 0
  let digitChars = 0
  for (const ch of source) {
    if (CJK_RE.test(ch)) cjkChars += 1
    else if (ch >= 'A' && ch <= 'Z') latinChars += 1
    else if (ch >= 'a' && ch <= 'z') latinChars += 1
    else if (ch >= '0' && ch <= '9') digitChars += 1
  }

  let identifierChars = 0
  for (const m of source.matchAll(IDENTIFIER_RE)) identifierChars += charCount(m[0])

  let pathChars = 0
  for (const token of source.trim().length === 0 ? [] : source.trim().split(/\s+/)) {
    if (PATH_EXT_RE.test(token) || PATH_TOKEN_RE.test(token)) pathChars += charCount(token)
  }

  const denom = significant > 0 ? significant : 0
  const ratio = (part: number): number => (denom === 0 ? 0 : clamp01(part / denom))
  const cjkRatio = ratio(cjkChars)
  const digitRatio = ratio(digitChars)
  const identifierRatio = ratio(identifierChars)
  const hasPath = pathChars > 0
  const codeSignal = clamp01(
    0.55 * identifierRatio
    + 0.25 * Math.min(1, digitRatio * 4)
    + 0.2 * (hasPath ? 1 : 0),
  )
  const naturalSignal = clamp01(0.7 * cjkRatio + 0.3 * (1 - codeSignal))
  return {
    text: source,
    chars,
    significant,
    cjkChars,
    cjkRatio,
    latinChars,
    latinRatio: ratio(latinChars),
    digitChars,
    digitRatio,
    identifierChars,
    identifierRatio,
    pathChars,
    pathRatio: ratio(pathChars),
    hasPath,
    codeSignal,
    naturalSignal,
  }
}

// ---------------------------------------------------------------------------
// 动态混合权重
// ---------------------------------------------------------------------------

/** 词法权重的基线:平均情况下两通道各半。 */
export const LEXICAL_BASE = 0.5
/** 代码信号对词法权重的抬升幅度:满信号 +0.45。 */
export const LEXICAL_CODE_GAIN = 0.45
/** CJK 占比对词法权重的压低幅度:纯自然语言 −0.15。 */
export const LEXICAL_NATURAL_PENALTY = 0.15
/** 词法权重下限:再自然的查询也保留 20% 词法(防止向量通道失效时全瞎)。 */
export const MIN_LEXICAL_WEIGHT = 0.2
/** 词法权重上限:再像代码的查询也保留 10% 向量(语义近邻仍有价值)。 */
export const MAX_LEXICAL_WEIGHT = 0.9

export interface HybridWeights {
  /** 词法通道权重 0..1 */
  lexical: number
  /** 向量通道权重 0..1;与 lexical 之和为 1 */
  vector: number
}

/**
 * 按查询画像给出词法/向量权重:
 *
 *   lexical = clamp(0.5 + 0.45·codeSignal − 0.15·cjkRatio, 0.2, 0.9)
 *   vector  = 1 − lexical
 *
 * 直觉:标识符/数字/路径越多 → 词法越重(精确匹配);CJK 自然语言越多 →
 * 向量越重(语义泛化)。结果恒满足 lexical + vector = 1 且都在 [0.2, 0.9]。
 */
export function hybridWeights(profile: QueryProfile): HybridWeights {
  const lexical = Math.min(
    MAX_LEXICAL_WEIGHT,
    Math.max(
      MIN_LEXICAL_WEIGHT,
      LEXICAL_BASE + LEXICAL_CODE_GAIN * clamp01(profile.codeSignal) - LEXICAL_NATURAL_PENALTY * clamp01(profile.cjkRatio),
    ),
  )
  return { lexical, vector: 1 - lexical }
}

/**
 * 混合两路分数:score = (wL·lexical + wV·vector) / (wL + wV)。
 *
 * 用**归一化加权平均**而不是直接相加,好处是权重不必强制和为 1(调用方可以传
 * 任意正权重),结果与原分数同量级、可解释。权重和 ≤ 0 时退化为等权平均;
 * 非有限输入按 0 处理;非有限结果 → 0。
 */
export function blendHybrid(lexical: number, vector: number, weights: HybridWeights): number {
  const lex = Number.isFinite(lexical) ? lexical : 0
  const vec = Number.isFinite(vector) ? vector : 0
  let wl = Number.isFinite(weights?.lexical) ? weights.lexical : 0
  let wv = Number.isFinite(weights?.vector) ? weights.vector : 0
  if (wl < 0) wl = 0
  if (wv < 0) wv = 0
  const total = wl + wv
  if (!(total > 0)) return (lex + vec) / 2
  return (lex * wl + vec * wv) / total
}

// ---------------------------------------------------------------------------
// Rocchio 伪相关反馈
// ---------------------------------------------------------------------------

/** Rocchio 原始查询权重 α 的默认值(标准取法 α=1)。 */
export const DEFAULT_ALPHA = 1
/** 伪相关文档质心权重 β 的默认值(标准取法 0.75,这里偏保守取 0.5,防止首轮噪声带偏)。 */
export const DEFAULT_BETA = 0.5

export interface RocchioOptions {
  /** 原始查询权重 α,默认 1;负数按 0 处理 */
  alpha?: number
  /** 伪相关文档质心权重 β,默认 0.5;负数按 0 处理 */
  beta?: number
}

/** 长度为 dim 的 L2 归一化新向量;零向量原样返回(调用方自行判空)。 */
function unitVector(values: ArrayLike<number>, dim: number): Float32Array {
  const out = new Float32Array(dim)
  let sum = 0
  for (let i = 0; i < dim; i++) {
    const v = Number.isFinite(values[i]) ? values[i]! : 0
    out[i] = v
    sum += v * v
  }
  const norm = Math.sqrt(sum)
  if (norm > 0) for (let i = 0; i < dim; i++) out[i] = out[i]! / norm
  return out
}

/** 是否为可用的非零向量。 */
function usableVector(v: ArrayLike<number> | null | undefined, dim: number): v is ArrayLike<number> {
  if (v == null || v.length !== dim || dim === 0) return false
  for (let i = 0; i < dim; i++) {
    const value = v[i]
    if (typeof value === 'number' && Number.isFinite(value) && value !== 0) return true
  }
  return false
}

/**
 * Rocchio 查询扩展:q' = normalize(α·q + β·mean(伪相关文档向量))。
 *
 * 行为约定:
 *   - q 为空/零向量 → 返回 null(表示"没有查询向量可用",调用方走纯词法);
 *   - 没有任何可用的伪相关文档(空数组、维度不一致、全零) → 返回归一化后的 q,
 *     即"扩展退化为原查询",不会丢失向量通道;
 *   - 维度不一致的文档直接忽略(不截断/不补零,避免静默错位);
 *   - α+β 抵消成零向量这种退化 → 同样回退到归一化 q;
 *   - 返回新 Float32Array,不修改 qvec / docVecs。
 *
 * 纯函数;topDocVecs 通常传向量通道 top-N 命中的记录向量(3~5 条即可)。
 */
export function expandQuery(
  qvec: ArrayLike<number> | null | undefined,
  topDocVecs: readonly (ArrayLike<number> | null | undefined)[] | null | undefined,
  opts: RocchioOptions = {},
): Float32Array | null {
  const dim = qvec?.length ?? 0
  if (dim === 0 || !usableVector(qvec, dim)) return null
  const alpha = Math.max(0, Number.isFinite(opts.alpha) ? opts.alpha! : DEFAULT_ALPHA)
  const beta = Math.max(0, Number.isFinite(opts.beta) ? opts.beta! : DEFAULT_BETA)

  const docs: ArrayLike<number>[] = []
  for (const doc of topDocVecs ?? []) {
    if (usableVector(doc, dim)) docs.push(doc)
  }
  if (docs.length === 0) return unitVector(qvec, dim)

  const result = new Float32Array(dim)
  let sum = 0
  for (let i = 0; i < dim; i++) {
    let centroid = 0
    for (const doc of docs) centroid += Number.isFinite(doc[i]) ? doc[i]! : 0
    centroid /= docs.length
    const q = Number.isFinite(qvec[i]) ? qvec[i]! : 0
    result[i] = alpha * q + beta * centroid
    sum += result[i]! * result[i]!
  }
  if (!(sum > 0)) return unitVector(qvec, dim)
  const norm = Math.sqrt(sum)
  for (let i = 0; i < dim; i++) result[i] = result[i]! / norm
  return result
}
