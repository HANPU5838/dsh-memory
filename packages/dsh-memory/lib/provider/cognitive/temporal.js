/**
 * 时间有效性（cognitive/temporal）—— 纯函数 + 一个显式落盘入口，无隐藏副作用。
 *
 * 解决的问题：记忆里的事实**会过期**。旧记忆不该被删（历史要可查），但默认检索/注入
 * 不该再把它当成"现在仍然成立"的事实返回。store.ts 已经预留两个可选字段：
 *   validFrom  事实有效期起点（缺省 = createdAt，老记录天然成立）
 *   validUntil 事实有效期终点（缺省 = ∞；被新证据推翻时置为"失效时刻"）
 *
 * 与 `expiredAt`（TTL 物理清理时间）的区别：validUntil 只影响"是否还算有效事实"，
 * 记录永远保留、历史可查；expiredAt 到点由 maintenance 物理删除。两者互不替代。
 *
 * 区间语义：有效期是**左闭右开** [validFrom, validUntil)。因为 validUntil 写的是
 * "失效时刻"，t == validUntil 的那一刻起就不该再算有效（planValidityOnConflict 正是
 * 把 validUntil 设成 now）。validFrom 同理：到点即生效。
 */
import {
  clamp01,
  isTombstonedRecord,
  normalizeContent,
                       
                    
                   
} from '../store.js'
import { CONFLICT_MIN_SIMILARITY, hasCriticalDetailConflict } from './conflict.js'
import { assessContradiction, CONTRADICTION_MEDIUM,                              } from './contradiction.js'

const DAY_MS = 86_400_000

/** "刚更新"窗口：updatedAt 在这么多天内算新鲜，给小幅正向权重。 */
export const FRESH_WINDOW_DAYS = 3
/** 新鲜度最大加成（+12%）。 */
export const FRESH_BONUS = 0.12
/** "临近失效"窗口：validUntil 在这么多天内到点，开始降权。 */
export const NEAR_EXPIRY_DAYS = 7
/** 临近失效的最大降权（-25%）。 */
export const EXPIRY_PENALTY = 0.25

// ---------------------------------------------------------------- 有效期判定

/** 事实有效期起点：显式 validFrom 优先，缺省用 createdAt（老记录天然成立）。 */
export function validFromOf(record              )         {
  const value = (record                   ).validFrom
  return typeof value === 'number' && Number.isFinite(value) ? value : record.createdAt
}

/** 事实有效期终点：显式 validUntil 优先，缺省 +∞（不会失效）。 */
export function validUntilOf(record              )         {
  const value = (record                   ).validUntil
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.POSITIVE_INFINITY
}

/** 记录在时刻 t 是否处于有效期 [validFrom, validUntil)。 */
export function isValidAt(record              , t        )          {
  return validFromOf(record) <= t && t < validUntilOf(record)
}

                            
                             
                   
                               
                 
                       
                
                                
             

/**
 * 如果记录在 now 时刻不可用，返回第一个命中的原因；可用返回 undefined。
 * 顺序：软删 > TTL > 未生效 > 已失效（最容易解释的优先）。
 */
export function inactiveReason(record              , now         = Date.now())                             {
  if (isTombstonedRecord(record)) return 'tombstoned'
  const expiredAt = record.expiredAt
  if (typeof expiredAt === 'number' && Number.isFinite(expiredAt) && expiredAt <= now) return 'expired'
  const from = validFromOf(record)
  if (now < from) return 'not-yet-valid'
  if (now >= validUntilOf(record)) return 'invalidated'
  return undefined
}

/** 记录在 now 时刻是否"当前有效"（时间有效 + 未软删 + 未过 TTL）。 */
export function isActiveNow(record              , now         = Date.now())          {
  return inactiveReason(record, now) === undefined
}

// ---------------------------------------------------------------- 冲突 → 失效计划

                                
                            
                              
                                 
                   
                           
                       
                            
               
                                   
                     

                                        
                       
                         
                
                    
                            
                    
                                 
              
                                                
                        
 

                               
                                        
                        
                                                       
                                
                            
                                                         
                    
                             
                                     
 

/**
 * 冲突时的有效期决策：**关键细节冲突**才把旧记录 validUntil 设为 now
 * （失效但保留历史，历史版本仍可 lineage/get 查到）；其余情况只标冲突、不动有效期。
 *
 * 判"关键细节冲突"用两道闸：
 *   1) conflict.ts 的 hasCriticalDetailConflict（双方都有细节但集合不一致）；
 *   2) 矛盾置信度 >= medium（数值差异率 / 标识符差异率 / 语义相似度的组合）。
 * 两道都满足才失效 —— 新陈述只是更模糊（比如旧的是"内存 10.4GB"、新的是"内存很大"）
 * 不构成推翻，不该让旧事实失效。
 */
export function planValidityOnConflict(input                       )               {
  const now = input.now ?? Date.now()
  const old = input.oldRecord
  const similarity = clamp01(input.similarity)
  const assessment = assessContradiction(old.content, input.newContent, { similarity })
  const base = { confidence: assessment.confidence, assessment }

  if (inactiveReason(old, now) !== undefined) {
    return { invalidateOld: false, validUntil: undefined, reason: 'already-invalid', ...base }
  }
  if (normalizeContent(old.content) === normalizeContent(input.newContent)) {
    return { invalidateOld: false, validUntil: undefined, reason: 'identical-content', ...base }
  }
  const min = clamp01(input.minSimilarity ?? CONFLICT_MIN_SIMILARITY)
  if (similarity < min) {
    return { invalidateOld: false, validUntil: undefined, reason: 'unrelated', ...base }
  }
  const critical = hasCriticalDetailConflict(old.content, input.newContent)
  if (critical && assessment.confidence >= CONTRADICTION_MEDIUM) {
    return { invalidateOld: true, validUntil: now, reason: 'critical-detail-conflict', ...base }
  }
  return { invalidateOld: false, validUntil: undefined, reason: 'soft-conflict', ...base }
}

/**
 * 把"旧记录失效"落进 store（唯一写路径）。用 store.updateMetrics 只写 validUntil，
 * 其它字段一概不动；记录保留、历史可查。不 flush —— 与 store 其它写路径一致。
 *
 * 返回 false 表示 id 不存在 / 未加载。
 */
export function applyValidityPlan(store             , id        , plan              )          {
  if (!plan.invalidateOld || plan.validUntil === undefined) return false
  if (store.scopeOf(id) === undefined) return false
  store.updateMetrics(id, { validUntil: plan.validUntil })
  return true
}

// ---------------------------------------------------------------- 时间权重

/**
 * 时间维度的检索权重调整（乘到相关度上，1 = 不调整）：
 *
 *   freshness = clamp01(1 - ageDays / FRESH_WINDOW_DAYS)
 *   urgency   = clamp01(remainingDays / NEAR_EXPIRY_DAYS)
 *   boost     = (1 + FRESH_BONUS * freshness) * (1 - EXPIRY_PENALTY * (1 - urgency))
 *
 * 直觉：刚被确认/更新的事实更值得信（小幅加成）；马上就要过期的旧事实该让位给
 * 更新的事实（小幅降权）。已失效 / 软删 / 过期 → 0（默认检索根本不该用它）。
 * 范围约 [0.75, 1.12]，乘性因子不会喧宾夺主压过相关度。
 */
export function temporalBoost(record              , now         = Date.now())         {
  if (!isActiveNow(record, now)) return 0
  const ageDays = Math.max(0, now - record.updatedAt) / DAY_MS
  const freshness = clamp01(1 - ageDays / FRESH_WINDOW_DAYS)
  let boost = 1 + FRESH_BONUS * freshness
  const until = validUntilOf(record)
  if (Number.isFinite(until)) {
    const remainingDays = Math.max(0, until - now) / DAY_MS
    const urgency = clamp01(remainingDays / NEAR_EXPIRY_DAYS)
    boost *= 1 - EXPIRY_PENALTY * (1 - urgency)
  }
  return boost
}

/** temporalBoost 的可解释分解（面板/调试用）：三因子分开给。 */
export function temporalBoostDetail(
  record              ,
  now         = Date.now(),
)                                                                                                              {
  const active = isActiveNow(record, now)
  if (!active) return { boost: 0, freshFactor: 0, expiryFactor: 0, active: false, remainingDays: null }
  const ageDays = Math.max(0, now - record.updatedAt) / DAY_MS
  const freshness = clamp01(1 - ageDays / FRESH_WINDOW_DAYS)
  const freshFactor = 1 + FRESH_BONUS * freshness
  const until = validUntilOf(record)
  const remainingDays = Number.isFinite(until) ? Math.max(0, until - now) / DAY_MS : null
  let expiryFactor = 1
  if (remainingDays !== null) {
    const urgency = clamp01(remainingDays / NEAR_EXPIRY_DAYS)
    expiryFactor = 1 - EXPIRY_PENALTY * (1 - urgency)
  }
  return { boost: freshFactor * expiryFactor, freshFactor, expiryFactor, active, remainingDays }
}


//# sourceURL=source/memory-local/src/cognitive/temporal.ts