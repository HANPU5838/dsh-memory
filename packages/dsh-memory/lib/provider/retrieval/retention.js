/**
 * 记忆保持度(FSRS 式,简化版 FSRS-4.5) —— 0.33.0。
 *
 * 为什么需要这一层:
 *   `scoring.recordScore` 用的是"指数半衰期"recency(次线性? 不,是线性指数):每条记录
 *   每过 halfLifeDays 分数减半,与它被用了几次、内容多难记无关。结果是:
 *     - 一条被反复取用、每次都验证正确的记忆,和一条从没被用过的记忆,衰减速度一样;
 *     - 一条"容易忘"的易变事实(state)和一条稳定的偏好(preference)也一样;
 *     - 刚用过一次的记忆,下一次该隔多久再复习也没有模型可算。
 *   FSRS(Fewer/Free Spaced Repetition Scheduler)把记忆拆成两个隐藏变量:
 *     - stability S(天):保持度降到 90% 所需的天数,越大越难忘;
 *     - difficulty D(0..1):这条记忆天生多难记,越大每次复习的增益越小。
 *   每次"取用"(success/lapse)都按 FSRS 的增益公式更新 S 和 D,于是"越用越牢"、
 *   "难记的涨得慢"、"间隔越久(检索越费力)复习收益越大"这三个直觉都能被算出来。
 *
 * 与完整 FSRS 的差异(刻意简化,保持零依赖、可解释):
 *   1) retrievability 用任务约定的 FSRS v1/v2 形式 R(t) = (1 + t/(9S))^-1,
 *      而不是 FSRS-4.5 的 (1 + 19/81·t/S)^-0.5 —— 前者在 t=S 时 R≈0.9 附近,
 *      且解析更简单;两者都能满足"单调递减、S 越大衰减越慢"。
 *   2) 没有"评分 1~4"的训练数据,所以初始 S/D 由**内容长度 + kind** 的启发式给出,
 *      而不是 FSRS 权重拟合;更新公式仍保留 FSRS 的形状(难度项、稳定性幂项、
 *      间隔收益项),参数取 FSRS-4.5 默认权重量级。
 *   3) 不处理"忘记后的 post-lapse stability"公式的全部细节,退化为按倍率衰减。
 *
 * 时间单位约定:所有对外参数里"天"都是浮点天(1 天 = 86_400_000ms);时间戳是
 * epoch 毫秒。纯函数、无 I/O、零第三方依赖,不会改动入参。
 */

// ---------------------------------------------------------------------------
// 默认参数
// ---------------------------------------------------------------------------

/** retrievability 的时间尺度:公式 R = (1 + t/(9S))^-1 里的 9。 */
export const RETENTION_SCALE = 9
/** 公式的固定指数(FSRS v1/v2 口径固定为 -1,单独提出来便于注释公式)。 */
export const RETENTION_DECAY = -1

/** 稳定性下限(天):防止 0 导致除零,也防止"永远记不住"的数值坍塌。 */
export const MIN_STABILITY_DAYS = 0.1
/** 稳定性上限(约 100 年):防止长期高频使用后溢出/失去区分度。 */
export const MAX_STABILITY_DAYS = 36_500

/** kind 缺省值。 */
export const DEFAULT_KIND = 'fact'

/**
 * 各 kind 的初始稳定性先验(天)。越"难变"的记忆越稳定:
 *   preference / rule 是长期约束;decision / procedure 会随项目演进;
 *   fact 是中性;note 是随手记;state 每次都变,最不稳定。
 */
export const KIND_STABILITY_DAYS                                   = {
  preference: 8,
  rule: 8,
  decision: 4,
  procedure: 5,
  fact: 3,
  note: 1.5,
  state: 0.5,
}

/** 未知 kind / 老记录缺 kind 时用 fact 的先验。 */
export const FALLBACK_STABILITY_DAYS = KIND_STABILITY_DAYS[DEFAULT_KIND] 

/** 内容长度对初始稳定性的影响尺度(字符)。 */
export const LENGTH_STABILITY_SCALE = 200
/** 内容长度对初始稳定性的影响强度(log 饱和)。 */
export const LENGTH_STABILITY_GAIN = 0.12

/**
 * 各 kind 的初始难度先验(0..1)。易变 / 依赖外部状态的类型更难:
 *   state 最易变、note 半结构化、procedure/decision 涉及步骤与前提;
 *   preference / rule 最稳定。
 */
export const KIND_DIFFICULTY                                   = {
  rule: 0.25,
  preference: 0.3,
  fact: 0.35,
  decision: 0.45,
  procedure: 0.5,
  note: 0.55,
  state: 0.75,
}

/** 未知 kind 的难度先验。 */
export const FALLBACK_DIFFICULTY = KIND_DIFFICULTY[DEFAULT_KIND] 

/** 内容长度对难度的饱和尺度(字符)。 */
export const LENGTH_DIFFICULTY_SCALE = 300
/** 内容长度最多把难度抬高多少(饱和上限)。 */
export const LENGTH_DIFFICULTY_MAX = 0.2

/** 取用质量:1=Again(取用后仍没记住),2=Hard,3=Good,4=Easy(FSRS 评分口径)。 */
                                         

/** 默认评分(没有反馈数据时按 Good 处理)。 */
export const DEFAULT_QUALITY                = 3

/**
 * 成功取用时的稳定性增益系数(FSRS-4.5 的 w8 = 1.616 量级,这里取 1.2 更保守)。
 * 公式(见 updateAfterUse): S' = S·(1 + GROWTH_FACTOR·(11−D10)·S^−GROWTH_POWER
 *                                       ·(e^{SPACING_EXP·(1−R)}−1)·ease)
 */
export const GROWTH_FACTOR = 1.2
/** 稳定性幂项指数(FSRS-4.5 的 w9 = 0.1544):S 越大,单次复习的相对增益越小。 */
export const GROWTH_POWER = 0.1544
/** 间隔收益指数(FSRS-4.5 的 w10 = 1.0651):复习前 R 越低,增益越大(间隔效应)。 */
export const SPACING_EXP = 1.0651
/** 单次复习最多把稳定性放大到几倍(含本次,即 1+MAX_GROWTH)。 */
export const MAX_GROWTH = 3
/** 遗忘(Again)时稳定性按该倍率衰减。 */
export const LAPSE_MULTIPLIER = 0.3
/** 各评分对应的增益倍率:Hard 只涨一半,Easy 多涨四成。 */
export const QUALITY_EASE                                          = { 1: 0, 2: 0.5, 3: 1, 4: 1.4 }
/** 各评分对应的效用奖励(EWMA 的观测值,0..1)。 */
export const QUALITY_REWARD                                          = { 1: 0, 2: 0.35, 3: 0.75, 4: 1 }
/** 各评分对难度的增量:遗忘变难,顺利变简单。 */
export const QUALITY_DIFFICULTY_DELTA                                          = {
  1: 0.15,
  2: 0.05,
  3: -0.03,
  4: -0.12,
}

/** 效用 EWMA 的平滑系数:新观测占 25%。 */
export const UTILITY_ALPHA = 0.25
/** 效用衰减半衰期(天):30 天没被取用,效用贡献减半。 */
export const UTILITY_HALF_LIFE_DAYS = 30
/** useCount 置信度的半程点:用 2 次达到 50% 置信。 */
export const USE_COUNT_HALF = 2
/** 综合分里效用提升的默认权重:utility 满值时把强度抬高 30%。 */
export const UTILITY_UPLIFT_WEIGHT = 0.3
/** 重要度因子的默认下限:importance=0 时综合分仍保留 50%。 */
export const IMPORTANCE_FLOOR = 0.5

const DAY_MS = 86_400_000

// ---------------------------------------------------------------------------
// 小工具(全部防御性:NaN / 负数 / 缺省一律归一)
// ---------------------------------------------------------------------------

function finiteOr(value                    , fallback        )         {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 夹到 [0,1];非数值 → 0。与 store.clamp01 同口径(本地实现避免依赖存储层)。 */
function clamp01(value        )         {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** 字符数按码点计(emoji / 代理对算 1 个)。 */
function charCount(text        )         {
  return typeof text === 'string' ? [...text].length : 0
}

/** 时间差(天),未来时间按 0 处理。 */
export function daysBetween(from                    , now        )         {
  const a = finiteOr(from, now)
  const elapsed = finiteOr(now, a) - a
  return elapsed > 0 ? elapsed / DAY_MS : 0
}

// ---------------------------------------------------------------------------
// 初始强度:没有训练数据时的启发式
// ---------------------------------------------------------------------------

/**
 * 初始稳定性 S0(天)= kind 先验 ÷ 长度惩罚。
 *
 * 长度惩罚 = 1 + 0.12·log2(1 + chars/200):越长越难整体记住(信息点更多、
 * 任何一点错都算记错),但用 log 饱和,避免长笔记被判成"必然忘记"。
 * 例:0 字 → 1.0x;200 字 → 1.12x;1600 字 → 1.36x 惩罚。
 *
 * 纯函数;未知 kind 走 fact 先验;空内容 = 只按 kind 给。
 */
export function initialStability(content        , kind         = DEFAULT_KIND)         {
  const prior = KIND_STABILITY_DAYS[kind] ?? FALLBACK_STABILITY_DAYS
  const chars = charCount(content)
  const lengthPenalty = 1 + LENGTH_STABILITY_GAIN * Math.log2(1 + chars / LENGTH_STABILITY_SCALE)
  return Math.min(MAX_STABILITY_DAYS, Math.max(MIN_STABILITY_DAYS, prior / lengthPenalty))
}

/**
 * 初始难度 D0(0..1)= kind 先验 + 长度项。
 *
 * 长度项 = 0.2·(1 − e^(−chars/300)):0 字 → 0;300 字 → 0.126;1000 字 → 0.193;
 * 饱和到 0.2。长文本信息点多,单条记录"全部记住"更难,故难度更高。
 * 结果夹到 [0,1]。
 *
 * 注:任务列出的签名是 initialDifficulty(content);第二个参数 kind 可选,
 * 不传时按 fact 处理 —— 这样既满足"只看内容"的调用,也能让易变类型更难。
 */
export function initialDifficulty(content        , kind         = DEFAULT_KIND)         {
  const prior = KIND_DIFFICULTY[kind] ?? FALLBACK_DIFFICULTY
  const chars = charCount(content)
  const lengthTerm = LENGTH_DIFFICULTY_MAX * (1 - Math.exp(-chars / LENGTH_DIFFICULTY_SCALE))
  return clamp01(prior + lengthTerm)
}

// ---------------------------------------------------------------------------
// 保持度 R(t)
// ---------------------------------------------------------------------------

/**
 * 保持度 R(t) = (1 + t/(9S))^(−1),单位:t = 距上次取用的天数,S = 稳定性(天)。
 *
 * 性质:
 *   - t = 0 → R = 1;t = 9S → R = 0.5;t → ∞ → 0,但永远 > 0(渐近,不会变负数);
 *   - 对 t 严格单调递减;对 S 严格单调递增(同一时刻 S 越大记得越牢)。
 *   - S 用 [MIN_STABILITY_DAYS, MAX_STABILITY_DAYS] 夹住,防止 0 除与溢出;
 *     t 为负 / NaN 按 0 处理,所以结果恒在 (0, 1]。
 *
 * 为什么是 9S 而不是 FSRS-4.5 的 81/19·S:见文件头注释(与任务约定一致)。
 */
export function retrievability(elapsedDays        , stability        )         {
  // 无穷时间(±)单独处理:+∞ → R=0;−∞/NaN 按 0 处理。
  const t = elapsedDays === Number.POSITIVE_INFINITY
    ? Number.POSITIVE_INFINITY
    : Math.max(0, finiteOr(elapsedDays, 0))
  const s = Math.min(MAX_STABILITY_DAYS, Math.max(MIN_STABILITY_DAYS, finiteOr(stability, FALLBACK_STABILITY_DAYS)))
  return 1 / (1 + t / (RETENTION_SCALE * s))
}

/** 记录的最小强度字段(与 store.CognitiveFields 同名,结构化兼容,不 import 存储层)。 */
                                 
                                           
                    
                
                     
                     
                  
               
                   
                           
                     
 

/**
 * 记录强度计算需要的最小记录形状(结构化类型:MemoryRecord / CognitiveRecord 直接可用)。
 * 只读字段,纯函数不会修改原记录。
 */
                                                        
                  
               
                     
                                          
                      
                    
                    
 

/**
 * 推导一条记录的稳定性:
 *   1) 有合法 stability 直接用(夹到上下限);
 *   2) 否则兼容老记录:以 initialStability(content, kind) 为基线,
 *      按访问次数放大 1 + ACCESS_STABILITY_GAIN·ln(1+accessCount)(用过的更牢),
 *      再按已知 difficulty 折减(难记的更弱)。
 *
 * 这是"没有认知层数据的老记录也能参与新排序"的兼容路径,不是对 FSRS 的扩展。
 */
export const ACCESS_STABILITY_GAIN = 0.5
export function stabilityOf(record                )         {
  const explicit = record.stability
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) {
    return Math.min(MAX_STABILITY_DAYS, Math.max(MIN_STABILITY_DAYS, explicit))
  }
  const base = initialStability(record.content ?? '', record.kind ?? DEFAULT_KIND)
  const uses = Math.max(0, finiteOr(record.accessCount, 0))
  const grown = base * (1 + ACCESS_STABILITY_GAIN * Math.log1p(uses))
  const difficulty = record.difficulty
  const penalty = difficulty === undefined ? 1 : 1 - 0.5 * clamp01(difficulty)
  return Math.min(MAX_STABILITY_DAYS, Math.max(MIN_STABILITY_DAYS, grown * penalty))
}

/**
 * 记录的保持度 R(t):t 从"上次取用"算起;没有取用记录时从 createdAt 算。
 * 时间戳缺失时视为刚刚用过(R = 1),避免老数据被误判为"很久没用"。
 */
export function retrievabilityOf(record                , now        )         {
  const anchor = record.lastUsedAt ?? record.createdAt
  return retrievability(daysBetween(anchor, now), stabilityOf(record))
}

// ---------------------------------------------------------------------------
// 效用:取用反馈的 EWMA + 次数置信度 + 时间衰减
// ---------------------------------------------------------------------------

/**
 * 效用分 utilityScore ∈ [0,1](考虑 useCount 与衰减):
 *   u        = clamp01(utility)                     —— 取用反馈的 EWMA(0..1)
 *   conf     = 1 − 0.5^(useCount / 2)               —— 次数置信度:0 次→0,2 次→50%,8 次→94%
 *   decay    = 0.5^(ageDays / 30)                   —— 距最近取用的衰减(半衰期 30 天)
 *   score    = u · conf · decay
 *
 * 为什么乘置信度:一次"顺利取用"的 utility 可能只是运气,次数越多越可信;
 * 为什么乘衰减:三个月没被用过的旧偏好,不应继续享受满额加权。
 * 从未取用(utility = 0)→ 0(中性,不奖励也不惩罚);时间戳缺失按"刚刚"处理。
 */
export function utilityScore(record                , now        )         {
  const u = clamp01(finiteOr(record.utility, 0))
  if (u <= 0) return 0
  const uses = Math.max(0, finiteOr(record.useCount, 0))
  const confidence = 1 - Math.pow(0.5, uses / USE_COUNT_HALF)
  const decay = Math.pow(0.5, daysBetween(record.lastUsedAt ?? record.createdAt, now) / UTILITY_HALF_LIFE_DAYS)
  return clamp01(u * confidence * decay)
}

/**
 * 效用提升因子 = 1 + weight·utilityScore,∈ [1, 1+weight]。
 * 权重默认 UTILITY_UPLIFT_WEIGHT = 0.3;weight 为 0 时完全关闭效用层。
 */
export function utilityUplift(record                , now        , weight         = UTILITY_UPLIFT_WEIGHT)         {
  return 1 + Math.max(0, finiteOr(weight, 0)) * utilityScore(record, now)
}

/** 重要度因子 = IMPORTANCE_FLOOR + (1−IMPORTANCE_FLOOR)·clamp01(importance) ∈ [0.5,1]。 */
export function importanceFactor(importance                    )         {
  return IMPORTANCE_FLOOR + (1 - IMPORTANCE_FLOOR) * clamp01(finiteOr(importance, 0))
}

// ---------------------------------------------------------------------------
// 取用后的强度更新(FSRS 式)
// ---------------------------------------------------------------------------

/** 更新后的强度状态(所有字段都有值,可直接展开回记录)。 */
                                       
                   
                    
                 
                  
                    
 

/** 评分归一:非数值 → Good;四舍五入后夹到 1..4。 */
export function normalizeQuality(quality                    )                {
  if (typeof quality !== 'number' || !Number.isFinite(quality)) return DEFAULT_QUALITY
  const rounded = Math.round(quality)
  if (rounded <= 1) return 1
  if (rounded === 2) return 2
  if (rounded === 3) return 3
  return 4
}

/**
 * 一次取用后更新强度状态。返回**新对象**,不改入参。
 *
 * 记 S = stability、D = clamp01(difficulty)、R = retrievability(距上次取用天数, S)。
 * 若状态里缺 stability/difficulty,用 initialStability/initialDifficulty 的缺省先验兜底
 * (调用方通常先走 initialStrength 初始化,这里只是防御)。
 *
 *   quality = 1(Again,取用后仍没记住):
 *     S' = max(MIN_STABILITY, S · LAPSE_MULTIPLIER)
 *     D' = clamp01(D + 0.15)
 *   quality ≥ 2(成功,H/G/E):
 *     D10 = 1 + 9D                       —— 映射回 FSRS 的 1..10 难度域
 *     S' = S · (1 + min(MAX_GROWTH, GROWTH_FACTOR · (11 − D10) · S^(−GROWTH_POWER)
 *                              · (e^(SPACING_EXP·(1−R)) − 1) · QUALITY_EASE[q]))
 *     D' = clamp01(D + QUALITY_DIFFICULTY_DELTA[q])
 *   共同:
 *     utility'  = (1−α)·u + α·QUALITY_REWARD[q]           (α = 0.25)
 *     useCount' = quality === 1 ? useCount : useCount + 1  (成功取用才计数)
 *     lastUsedAt' = now
 *
 * 三个可直接观察的性质(测试覆盖):
 *   - 质量越高 S 涨得越多;难度越高涨得越少;
 *   - 复习前 R 越低(间隔越久)S 涨得越多(间隔效应);
 *   - 遗忘会缩短 S 并抬高 D,但 S 不会低于下限。
 */
export function updateAfterUse(
  state                ,
  quality                    ,
  now        ,
)                       {
  const q = normalizeQuality(quality)
  const stability = Math.min(
    MAX_STABILITY_DAYS,
    Math.max(
      MIN_STABILITY_DAYS,
      finiteOr(state.stability, FALLBACK_STABILITY_DAYS),
    ),
  )
  const difficulty = clamp01(finiteOr(state.difficulty, FALLBACK_DIFFICULTY))
  // 复习前的保持度:从上次取用(lastUsedAt)算;没取用过则以 now 为起点(R=1)。
  const elapsed = daysBetween(state.lastUsedAt, now)
  const retention = retrievability(elapsed, stability)
  const previousUtility = clamp01(finiteOr(state.utility, 0))
  const previousUses = Math.max(0, finiteOr(state.useCount, 0))

  let nextStability        
  if (q === 1) {
    nextStability = stability * LAPSE_MULTIPLIER
  } else {
    const difficulty10 = 1 + 9 * difficulty
    const growth = GROWTH_FACTOR
      * (11 - difficulty10)
      * Math.pow(stability, -GROWTH_POWER)
      * (Math.exp(SPACING_EXP * (1 - retention)) - 1)
      * QUALITY_EASE[q]
    nextStability = stability * (1 + Math.min(MAX_GROWTH, Math.max(0, growth)))
  }

  const utility = (1 - UTILITY_ALPHA) * previousUtility + UTILITY_ALPHA * QUALITY_REWARD[q]
  const useCount = q === 1 ? previousUses : previousUses + 1
  const anchor = typeof now === 'number' && Number.isFinite(now) ? now : finiteOr(state.lastUsedAt, 0)
  return {
    stability: Math.min(MAX_STABILITY_DAYS, Math.max(MIN_STABILITY_DAYS, nextStability)),
    difficulty: clamp01(difficulty + QUALITY_DIFFICULTY_DELTA[q]),
    utility: clamp01(utility),
    useCount,
    lastUsedAt: anchor,
  }
}

/**
 * 为一条新记录生成初始强度状态(首次写入时调用):
 *   stability = initialStability(content, kind)
 *   difficulty = initialDifficulty(content, kind)
 *   utility = 0,useCount = 0,lastUsedAt = createdAt(从未取用)
 * createdAt 缺省用 now。
 */
export function initialStrength(
  content        ,
  kind        ,
  createdAt         = Date.now(),
)                       {
  return {
    stability: initialStability(content, kind),
    difficulty: initialDifficulty(content, kind),
    utility: 0,
    useCount: 0,
    lastUsedAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
  }
}

// ---------------------------------------------------------------------------
// 综合强度分
// ---------------------------------------------------------------------------

/** 综合分分解。 */
                                    
                         
                   
                    
                 
                                              
                       
                                      
                    
                             
                   
                                                     
               
 

/**
 * 综合强度分(不含查询相关度;相关度由 rank.ts 单独乘进来):
 *
 *   recordStrength = R(t) · (1 + 0.3·utilityScore) · (0.5 + 0.5·importance)
 *
 * 也就是"保持度 × 效用提升 × 重要度" —— 一条记忆"当前还有多鲜活"。
 * 它能解释三件事:R(t) 说明多久没被碰(并考虑个体稳定性),utilityScore 说明
 * 被取用后确实有用的历史,importance 是显式声明的重要性。
 *
 * 纯函数,不修改入参;weight 可显式传 0 关掉效用层。
 */
export function strengthBreakdown(
  record                ,
  now        ,
  opts                             = {},
)                    {
  const retention = retrievabilityOf(record, now)
  const utility = utilityScore(record, now)
  const uplift = 1 + Math.max(0, finiteOr(opts.utilityWeight, UTILITY_UPLIFT_WEIGHT)) * utility
  const importance = importanceFactor(record.importance)
  return {
    retention,
    utility,
    utilityUplift: uplift,
    importance,
    stability: stabilityOf(record),
    score: retention * uplift * importance,
  }
}

/** 综合强度分(标量版;面板/日志直接用)。 */
export function recordStrength(record                , now        , opts                             = {})         {
  return strengthBreakdown(record, now, opts).score
}


//# sourceURL=source/memory-local/src/retrieval/retention.ts