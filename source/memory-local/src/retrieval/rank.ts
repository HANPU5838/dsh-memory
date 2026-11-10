/**
 * 可解释排序:校准相关度 × 保持度 × 效用提升 × 重要度 —— 0.33.0。
 *
 * 为什么需要这一层:
 *   `scoring.recordScore` 把相关度、recency、重要度、访问次数揉成一个黑盒标量,
 *   面板上只能看到"终态分 0.37",没人知道为什么 A 排在 B 前面。调参时也无法判断
 *   是相关度不够、太旧、还是重要度低。这里把终态分显式拆成四个可解释因子:
 *
 *     score = relevance          (校准后的相关度:词法/向量/混合分)
 *           × retentionFactor    (保持度:R(t) 的软化版,详见下)
 *           × utilityFactor      (效用提升:被取用且确实有用的历史)
 *           × importanceFactor   (显式重要度)
 *           × supersededFactor   (退役版本惩罚)
 *
 *   返回的每条结果都带 `breakdown`,每个因子单独可见 —— 可解释、可单测、可面板展示。
 *
 * 为什么保持度/重要度用"软化因子"而不是直接相乘:
 *   R(t) 渐近到 0,直接乘会让"很旧但依然正确"的记忆永久沉底(一条 3 年前的
 *   部署端口仍可能救急);重要度直接乘则会让 importance=0 的记录直接归零。
 *   所以:
 *     retentionFactor  = 1 − w_ret·(1 − R)      ∈ [1−w_ret, 1]
 *     importanceFactor = 1 − w_imp·(1 − imp)    ∈ [1−w_imp, 1]
 *   它们**保持单调性**(R/imp 越大分越高),但把最大降权幅度限制在权重上;
 *   breakdown 里同时给出原始 R / importance,解释不受影响。
 *
 * 纯函数、无 I/O、零第三方依赖;默认参数全部导出,方便面板/日志标注。
 */
import { daysBetween, retrievability, stabilityOf, utilityScore, type StrengthRecord } from './retention.ts'

// ---------------------------------------------------------------------------
// 权重与默认值
// ---------------------------------------------------------------------------

/** 排序权重:每个数值表示该因子最多能把分数拉动多少(0 = 关闭该层)。 */
export interface RankWeights {
  /** 保持度最大降权幅度 0..1,默认 0.5(最低保留 50%) */
  retention: number
  /** 效用最大加成 0..1,默认 0.3(因子 ∈ [1,1.3]) */
  utility: number
  /** 重要度最大降权幅度 0..1,默认 0.4(最低保留 60%) */
  importance: number
  /** 退役记录惩罚因子 0..1,默认 0.3(乘 0.3);传 1 表示不惩罚 */
  superseded: number
}

/** 默认权重。 */
export const DEFAULT_RANK_WEIGHTS: Readonly<RankWeights> = {
  retention: 0.5,
  utility: 0.3,
  importance: 0.4,
  superseded: 0.3,
}

/** 老记录(既无 stability、也无 content/kind)退化为指数半衰期时的默认半衰期(天)。 */
export const DEFAULT_RANK_HALF_LIFE_DAYS = 30

/** 一条候选的最小形状:`id` + 相关度 + 强度字段(其余字段可选)。 */
export interface RankCandidate extends StrengthRecord {
  id: string
  /** 已校准的相关度(通常 0..1:词法校准分 / 向量余弦 / 两者混合) */
  relevance: number
  /** 是否已被新版本取代(退役);默认 false */
  superseded?: boolean
}

// ---------------------------------------------------------------------------
// 单条候选的分解
// ---------------------------------------------------------------------------

/** 终态分的完整分解(每个字段都可直接展示)。 */
export interface RankBreakdown {
  /** 输入相关度(非有限值→0,负数→0) */
  relevance: number
  /** 保持度 R(t) 原始值 ∈ (0,1] */
  retention: number
  /** 保持度因子 = 1 − w_ret·(1 − R) */
  retentionFactor: number
  /** 效用分 ∈ [0,1] */
  utility: number
  /** 效用提升因子 = 1 + w_util·utility */
  utilityFactor: number
  /** 重要度(夹到 0..1) */
  importance: number
  /** 重要度因子 = 1 − w_imp·(1 − importance) */
  importanceFactor: number
  /** 退役惩罚因子(1 或 w_sup) */
  supersededFactor: number
  /** 终态分 = relevance · retentionFactor · utilityFactor · importanceFactor · supersededFactor */
  score: number
}

export interface RankOneOptions {
  now: number
  /** 部分覆写的权重;缺省字段用 DEFAULT_RANK_WEIGHTS */
  weights?: Partial<RankWeights>
  /** 老记录退化为指数半衰期时的半衰期(天),默认 30 */
  halfLifeDays?: number
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** 权重归一:非有限→默认,负数→0,超过 1 的保持度/重要度/效用权重夹到 1。 */
function resolveWeights(weights: Partial<RankWeights> | undefined): RankWeights {
  const pick = (key: keyof RankWeights): number => {
    const value = weights?.[key]
    const fallback = DEFAULT_RANK_WEIGHTS[key]
    const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback
    return Math.min(1, Math.max(0, n))
  }
  return {
    retention: pick('retention'),
    utility: pick('utility'),
    importance: pick('importance'),
    superseded: pick('superseded'),
  }
}

/**
 * 候选的保持度:
 *   1) 有合法 stability → R = (1 + t/(9S))^-1,t 从 lastUsedAt(缺省 createdAt)算起;
 *   2) 没有 stability 但有 content/kind/accessCount → 用 retention.stabilityOf 推导
 *      兼容稳定性,再套同一公式(老记录也参与新排序);
 *   3) 退化候选(只有 id/relevance,无任何强度线索)→ 指数半衰期
 *      0.5^(ageDays / halfLifeDays);连时间戳都没有 → 1(刚刚存在,不奖不罚)。
 */
function retentionOf(candidate: RankCandidate, now: number, halfLifeDays: number): number {
  const anchor = candidate.lastUsedAt ?? candidate.createdAt
  if (typeof candidate.stability === 'number' && Number.isFinite(candidate.stability) && candidate.stability > 0) {
    return retrievability(daysBetween(anchor, now), candidate.stability)
  }
  const hasContentClues = candidate.content !== undefined || candidate.kind !== undefined || candidate.accessCount !== undefined
  if (hasContentClues) return retrievability(daysBetween(anchor, now), stabilityOf(candidate))
  if (anchor === undefined) return 1
  const ageDays = daysBetween(anchor, now)
  return Math.pow(0.5, ageDays / Math.max(0.001, halfLifeDays))
}

/** 计算单条候选的终态分与分解(纯函数,不改入参)。 */
export function explainCandidate(candidate: RankCandidate, opts: RankOneOptions): RankBreakdown {
  const weights = resolveWeights(opts.weights)
  const now = Number.isFinite(opts.now) ? opts.now : 0
  const halfLifeDays = typeof opts.halfLifeDays === 'number' && Number.isFinite(opts.halfLifeDays) && opts.halfLifeDays > 0
    ? opts.halfLifeDays
    : DEFAULT_RANK_HALF_LIFE_DAYS

  const relevance = Math.max(0, Number.isFinite(candidate.relevance) ? candidate.relevance : 0)
  const retention = retentionOf(candidate, now, halfLifeDays)
  const utility = utilityScore(candidate, now)
  const importance = clamp01(typeof candidate.importance === 'number' ? candidate.importance : 0)
  const retentionFactor = 1 - weights.retention * (1 - retention)
  const utilityFactor = 1 + weights.utility * utility
  const importanceFactor = 1 - weights.importance * (1 - importance)
  const supersededFactor = candidate.superseded ? weights.superseded : 1
  const score = relevance * retentionFactor * utilityFactor * importanceFactor * supersededFactor
  return {
    relevance,
    retention,
    retentionFactor,
    utility,
    utilityFactor,
    importance,
    importanceFactor,
    supersededFactor,
    // 防御:因子均为有限正数,理论上不会 NaN;但 relevance 可能极大,这里只挡非有限结果。
    score: Number.isFinite(score) ? score : 0,
  }
}

// ---------------------------------------------------------------------------
// 批量排序
// ---------------------------------------------------------------------------

export interface RankOptions extends RankOneOptions {
  /** 最多返回几条,默认全部;负数/0 → 空数组 */
  limit?: number
}

/** 一条排序结果(candidate 为原对象引用,便于调用方回取记录)。 */
export interface RankedCandidate<T extends RankCandidate> {
  candidate: T
  /** 终态分(等于 breakdown.score) */
  score: number
  /** 可解释分解 */
  breakdown: RankBreakdown
}

/**
 * 对候选排序并返回分解。纯函数:不修改 candidates 数组与元素。
 *
 * 排序规则:
 *   1) 终态分降序;
 *   2) 同分按 **id 升序** —— 不依赖输入顺序,保证跨进程/跨调用可复现;
 *   3) 应用 limit(缺省全部)。
 */
export function rankCandidates<T extends RankCandidate>(
  candidates: readonly T[],
  opts: RankOptions,
): RankedCandidate<T>[] {
  const limit = opts.limit === undefined
    ? candidates.length
    : Math.max(0, Math.min(candidates.length, Math.floor(Number.isFinite(opts.limit) ? opts.limit : 0)))
  const ranked: RankedCandidate<T>[] = candidates.map((candidate) => {
    const breakdown = explainCandidate(candidate, opts)
    return { candidate, score: breakdown.score, breakdown }
  })
  ranked.sort((a, b) => b.score - a.score || a.candidate.id.localeCompare(b.candidate.id))
  return limit >= ranked.length ? ranked : ranked.slice(0, limit)
}
