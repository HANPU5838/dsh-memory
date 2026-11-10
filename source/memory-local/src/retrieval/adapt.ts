/**
 * 查询自适应阈值 + 跨 scope 分数校准(0.32.0)。
 *
 * 为什么需要这一层:
 *   1) 固定词法阈值对短查询太严、对长查询太松。短查询只带 2~4 个 token,
 *      `lexicalScore` 的分母小、真命中也常压在线下;长查询塞了几十个弱 token,
 *      一条长记忆只要碰巧命中几个就能过线。所以阈值按查询 token 数自适应:
 *      **短查询放宽、长查询收紧**,中间线性过渡。
 *      注意:词法分数天然随查询变长而稀释(分母是全部查询 token 的 IDF),
 *      所以 `tighten` 默认只取 0.1;若离线评测显示长查询被过度过滤,把它调小。
 *   2) 多 scope 合并排序时,词法分数是**在每个 scope 内各自归一**的(IDF 用本
 *      store 的语料),而且 global / project 的召回门槛本来就不同(默认 0.12
 *      vs 0.10)。直接比大小等于苹果比橘子。这里按"门槛对齐"做仿射校准:让每个
 *      tier 恰好压线的分数映射到参考 tier 的门槛分,于是跨 scope 可比较。
 *      校准只用于**词法通道**的分数;向量余弦本身就在同一坐标域,别重复校准。
 *
 * 纯函数、无 I/O、无第三方依赖;不读配置对象 —— 配置值由调用方传入,
 * 单元测试可以直接给数字。`ScopeKind` 用 type-only import,运行时零依赖。
 */
import type { ScopeKind } from '../scope.ts'
import { tokenize } from '../scoring.ts'

// ---------------------------------------------------------------------------
// 查询画像
// ---------------------------------------------------------------------------

export type QueryClass = 'short' | 'medium' | 'long'

/**
 * token 数分档边界。tokenize() 对 CJK 同时给一元和二元,所以一个 n 字中文
 * 查询约有 2n−1 个 token:8 / 24 大致对应"≤4 字 / 5~12 字 / ≥13 字"。
 */
export const SHORT_QUERY_TOKENS = 8
export const LONG_QUERY_TOKENS = 24

export interface QueryProfile {
  /** 原始查询 */
  text: string
  /** 字符数(按码点计,`[...text].length`) */
  chars: number
  /** 空白分词的词数(纯 CJK 查询通常是 1;仅用于观测,不参与判定) */
  words: number
  /** tokenize() 口径的 token 数(CJK 一元 + 二元,拉丁按词) */
  tokens: number
  /** 唯一 token 数 */
  uniqueTokens: number
  /** 短/中/长档位 */
  class: QueryClass
}

export function classifyQuery(
  tokens: number,
  shortTokens: number = SHORT_QUERY_TOKENS,
  longTokens: number = LONG_QUERY_TOKENS,
): QueryClass {
  if (!(tokens > 0)) return 'short'
  if (tokens <= shortTokens) return 'short'
  if (tokens >= longTokens) return 'long'
  return 'medium'
}

/** 算出查询画像。纯函数,不做缓存(调用方查询级只调一次)。 */
export function profileQuery(text: string): QueryProfile {
  const tokens = tokenize(text)
  const words = text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length
  return {
    text,
    chars: [...text].length,
    words,
    tokens: tokens.length,
    uniqueTokens: new Set(tokens).size,
    class: classifyQuery(tokens.length),
  }
}

// ---------------------------------------------------------------------------
// 自适应阈值
// ---------------------------------------------------------------------------

/** 短查询最多把门槛放宽多少(绝对值)。 */
export const DEFAULT_SHORT_RELAX = 0.05
/** 长查询最多把门槛收紧多少(绝对值)。 */
export const DEFAULT_LONG_TIGHTEN = 0.1
/** 自适应结果的绝对下界:再宽松也不能让"零重合"混进来。 */
export const MIN_ADAPTIVE_THRESHOLD = 0.02
/** 自适应结果的绝对上界:再严格也不能把真命中全砍掉。 */
export const MAX_ADAPTIVE_THRESHOLD = 0.9

export interface AdaptiveThresholdOptions {
  /** 该 scope tier 的配置门槛(config.globalThreshold / projectThreshold) */
  base: number
  /** 短查询放宽量,默认 DEFAULT_SHORT_RELAX */
  relax?: number
  /** 长查询收紧量,默认 DEFAULT_LONG_TIGHTEN */
  tighten?: number
  /** 结果下界,默认 MIN_ADAPTIVE_THRESHOLD;想关掉一侧就传 0 */
  min?: number
  /** 结果上界,默认 MAX_ADAPTIVE_THRESHOLD */
  max?: number
  shortTokens?: number
  longTokens?: number
}

/**
 * 按查询 token 数缩放配置门槛:
 *   tokens ≤ short  →  base − relax
 *   tokens ≥ long   →  base + tighten
 *   之间             →  线性插值
 * 最后夹到 [min, max]。纯函数。
 */
export function adaptiveThreshold(text: string, opts: AdaptiveThresholdOptions): number {
  const { tokens } = profileQuery(text)
  const short = opts.shortTokens ?? SHORT_QUERY_TOKENS
  const long = opts.longTokens ?? LONG_QUERY_TOKENS
  const relax = Math.max(0, opts.relax ?? DEFAULT_SHORT_RELAX)
  const tighten = Math.max(0, opts.tighten ?? DEFAULT_LONG_TIGHTEN)
  const min = opts.min ?? MIN_ADAPTIVE_THRESHOLD
  const max = opts.max ?? MAX_ADAPTIVE_THRESHOLD

  let delta: number
  if (tokens <= short) {
    delta = -relax
  } else if (tokens >= long || long <= short) {
    delta = tighten
  } else {
    const ratio = (tokens - short) / (long - short)
    delta = -relax + ratio * (relax + tighten)
  }
  // base 本身可能已经在 min/max 之外(配置写错),仍按夹取后的区间输出。
  return Math.min(max, Math.max(min, opts.base + delta))
}

/** 该 scope 的配置口径门槛:global 一档,其余(session/project/custom)一档。 */
export function scopeThresholdBase(
  scope: string,
  opts: { globalThreshold?: number; projectThreshold?: number } = {},
): number {
  return kindOfScope(scope) === 'global'
    ? (opts.globalThreshold ?? 0.12)
    : (opts.projectThreshold ?? 0.1)
}

export interface AdaptiveScopeThresholdOptions {
  globalThreshold?: number
  projectThreshold?: number
  relax?: number
  tighten?: number
  min?: number
  max?: number
  shortTokens?: number
  longTokens?: number
}

/**
 * 一步到位:scope → 配置门槛 → 查询自适应。
 * `search()` 的词法通道可以原样用 `landed = adaptiveScopeThreshold(query.text, rec.scope, cfg)`
 * 替换现在的手写 `isGlobal ? globalThreshold : projectThreshold`。
 */
export function adaptiveScopeThreshold(
  text: string,
  scope: string,
  opts: AdaptiveScopeThresholdOptions = {},
): number {
  const adaptive: AdaptiveThresholdOptions = { base: scopeThresholdBase(scope, opts) }
  if (opts.relax !== undefined) adaptive.relax = opts.relax
  if (opts.tighten !== undefined) adaptive.tighten = opts.tighten
  if (opts.min !== undefined) adaptive.min = opts.min
  if (opts.max !== undefined) adaptive.max = opts.max
  if (opts.shortTokens !== undefined) adaptive.shortTokens = opts.shortTokens
  if (opts.longTokens !== undefined) adaptive.longTokens = opts.longTokens
  return adaptiveThreshold(text, adaptive)
}

// ---------------------------------------------------------------------------
// scope 分数校准
// ---------------------------------------------------------------------------

/** 与 scope.ts 的 scopeKind 同语义;用本地实现避免把 store/fs 依赖拖进检索层。 */
function kindOfScope(scope: string): ScopeKind {
  if (scope === 'global') return 'global'
  if (scope.startsWith('project:')) return 'project'
  if (scope.startsWith('session:')) return 'session'
  return 'custom'
}

/** 配置里的默认门槛与 index.ts 的 retrieval 默认值保持一致。 */
export const DEFAULT_GLOBAL_THRESHOLD = 0.12
export const DEFAULT_PROJECT_THRESHOLD = 0.1

export interface ScopeCalibrationOptions {
  globalThreshold?: number
  projectThreshold?: number
  /** 参考分数域所属 tier,默认 'project'(它的门槛就是目标门槛)。 */
  reference?: ScopeKind
  /** 显式覆写某 tier 的乘数;优先于按门槛推导的值。 */
  scales?: Partial<Record<ScopeKind, number>>
  /** 显式覆写某 tier 的加性偏移。 */
  offsets?: Partial<Record<ScopeKind, number>>
}

export interface ScopeCalibration {
  /** 参考 tier 的名字,方便日志/面板标注 */
  readonly reference: ScopeKind
  readonly globalThreshold: number
  readonly projectThreshold: number
  /** 该 scope 的乘数 */
  scale(scope: string): number
  /** 该 scope 的加性偏移 */
  offset(scope: string): number
  /** calibratedScore = scale(scope) * score + offset(scope) */
  apply(score: number, scope: string): number
}

/**
 * 创建跨 scope 分数校准器。默认推导规则:
 *   reference 门槛 = 参考 tier 的配置门槛 Tref(默认 project 的 0.10)
 *   其他 tier 乘数 = Tref / 该 tier 门槛
 * 这样每个 tier 恰好压线的词法分数都映射到同一个 Tref 分,跨 scope 排序才公平。
 * 用 scope 的**原始键**(如 `project:/a/b`),按前缀判定 tier。
 */
export function createScopeCalibration(opts: ScopeCalibrationOptions = {}): ScopeCalibration {
  const globalThreshold = opts.globalThreshold ?? DEFAULT_GLOBAL_THRESHOLD
  const projectThreshold = opts.projectThreshold ?? DEFAULT_PROJECT_THRESHOLD
  const reference: ScopeKind = opts.reference ?? 'project'
  const thresholdOf = (kind: ScopeKind): number => (kind === 'global' ? globalThreshold : projectThreshold)
  const referenceThreshold = thresholdOf(reference)
  const derived: Record<ScopeKind, number> = {
    global: thresholdOf('global') > 0 ? referenceThreshold / thresholdOf('global') : 1,
    project: thresholdOf('project') > 0 ? referenceThreshold / thresholdOf('project') : 1,
    session: thresholdOf('session') > 0 ? referenceThreshold / thresholdOf('session') : 1,
    custom: thresholdOf('custom') > 0 ? referenceThreshold / thresholdOf('custom') : 1,
  }
  const offsets: Partial<Record<ScopeKind, number>> = opts.offsets ?? {}
  return {
    reference,
    globalThreshold,
    projectThreshold,
    scale: (scope) => opts.scales?.[kindOfScope(scope)] ?? derived[kindOfScope(scope)] ?? 1,
    offset: (scope) => offsets[kindOfScope(scope)] ?? 0,
    apply: (score, scope) => score * (opts.scales?.[kindOfScope(scope)] ?? derived[kindOfScope(scope)] ?? 1)
      + (offsets[kindOfScope(scope)] ?? 0),
  }
}

/** 默认校准器(project 门槛 0.10 为参考域)。 */
export const DEFAULT_SCOPE_CALIBRATION: ScopeCalibration = createScopeCalibration()

/** 把一条词法分按 scope 校准。纯函数。 */
export function calibrateScore(score: number, scope: string, cal: ScopeCalibration = DEFAULT_SCOPE_CALIBRATION): number {
  return cal.apply(score, scope)
}

/** 批量校准命中:返回新数组,条目为浅拷贝且 `score` 换成校准后的值。 */
export function calibrateHits<T extends { score: number }>(
  hits: readonly T[],
  scopeOf: (hit: T) => string,
  cal: ScopeCalibration = DEFAULT_SCOPE_CALIBRATION,
): T[] {
  return hits.map((hit) => ({ ...hit, score: cal.apply(hit.score, scopeOf(hit)) }))
}
