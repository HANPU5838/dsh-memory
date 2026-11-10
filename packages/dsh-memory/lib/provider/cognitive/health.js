/**
 * 记忆健康度（cognitive/health）—— 纯函数，无 I/O、无副作用、零运行时依赖。
 *
 * 回答一个维护任务 / 面板最关心的问题：**这个记忆库现在健不健康、哪里不健康**。
 * 把散落在各模块的信号（生命周期休眠/墓碑、时间有效性失效、冲突标记、隔离标记、
 * 嵌入覆盖、语义重复）聚合成一份可解释的报告 + 一个 0..100 的分数。
 *
 * 设计约束：
 *   1) **纯函数**：只读入参记录/向量，绝不改记录、不碰 store、不写盘；
 *   2) **不做 O(n²) 全量**：重复率用"抽样锚点 × 全量邻居"估计（O(sample × n)），
 *      抽样是确定性的（按 id 排序后等距取样），同样输入永远同样结果；
 *   3) **可解释**：每个扣分项都给出 count / rate / 权重 / 容忍度 / 实际扣分，
 *      另附中文 explain 明细，面板可直接展示。
 *
 * 分类语义（互斥，加起来 = total，便于校验）：
 *   tombstoned 软删 > invalid 事实失效/TTL 过期 > quarantined 可疑隔离
 *   > dormant 休眠 > live 活跃
 * 冲突数独立统计（冲突记录仍可能是 active），因为"冲突"是待裁决状态而不是不可见状态。
 */
import {
  clamp01,
  isDormantRecord,
  isQuarantinedRecord,
  isTombstonedRecord,
                       
                    
} from '../store.js'
import { MERGE_THRESHOLD } from './merge.js'
import { DORMANT_AFTER_DAYS, TOMBSTONE_RETENTION_DAYS } from './lifecycle.js'

const DAY_MS = 86_400_000

/** 重复率默认抽样锚点数：64 × n 条余弦，几千条库也是毫秒级。 */
export const DEFAULT_DUPLICATE_SAMPLE = 64
/** 重复判定阈值：与语义合并同口径（0.92 = 同一件事的不同说法）。 */
export const DEFAULT_DUPLICATE_THRESHOLD = MERGE_THRESHOLD
/** 明细里最多保留多少对重复（避免报告本身变成大对象）。 */
export const DEFAULT_DUPLICATE_DETAIL_LIMIT = 20
/** 健康分满分。 */
export const HEALTH_SCORE_MAX = 100

/**
 * 各扣分项权重与"容忍度"：
 *   deduction = weight × clamp01(rate / tolerance)
 * 即 rate 达到 tolerance 时该项扣满权重分 —— tolerance 是"业务可接受的坏比例"。
 * 权重总和 110 > 100，坏到极致时靠 clamp 兜底到 0 分（任意单项都不足以单独清零）。
 */
                                  
                                                                                                     
               
                
                   
 

export const HEALTH_SCORE_RULES                             = [
  { key: 'conflict', label: '冲突率', weight: 25, tolerance: 0.2 },
  { key: 'invalid', label: '失效率', weight: 20, tolerance: 0.2 },
  { key: 'duplicate', label: '重复率', weight: 20, tolerance: 0.2 },
  { key: 'quarantine', label: '隔离率', weight: 15, tolerance: 0.1 },
  { key: 'tombstone', label: '墓碑率', weight: 10, tolerance: 0.3 },
  { key: 'dormant', label: '休眠率', weight: 10, tolerance: 0.4 },
  { key: 'pendingEmbed', label: '待嵌入率', weight: 10, tolerance: 0.2 },
]

/** id → 向量。支持 Map（ScopeStore.vectors 就是 Map）或普通对象（测试/导入用）。 */
                                
                                                      
                                                           

                                
                                            
                              
                                 
              
                                                    
                          
                                           
                             
                                                                  
                        
                                                     
                           
                                                       
                               
     
                                            
                                   
     
                                          
 

/** 一个扣分项的可解释明细。 */
                                       
                             
               
                                 
               
                                           
              
                
                   
                                                          
                   
 

/** 一条重复对明细（抽样估计的证据）。 */
                                      
           
           
                    
 

                               
                                                                       
               
              
                 
                    
                 
                     
                                                  
                    
                                       
                            

               
                  
                 

                     
                                      
                          
                      
                        
                                
                       
                                         

                              
                      
                     
                     
                       
                        
                          

                          
                      
                    
                                                 

                
                               
               
                                   
                               
                   
 

/** 保留 1 位小数。 */
function round1(value        )         {
  return Math.round(value * 10) / 10
}

/** 有限数值才算样本；undefined / NaN / Infinity → undefined。 */
function finiteOf(value         )                     {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 统一读取向量：Map 走 get，普通对象走 hasOwnProperty（避免原型链误命中）。 */
function vectorOf(vectors                                , id        )                                {
  if (vectors === undefined) return undefined
  if (typeof (vectors                                                      ).get === 'function') {
    return (vectors                                                      ).get(id)
  }
  const obj = vectors                                                           
  return Object.prototype.hasOwnProperty.call(obj, id) ? obj[id] : undefined
}

/** 记录是否"事实失效"：TTL 过期或 validUntil 已到（与 temporal.inactiveReason 同口径）。 */
function isInvalidFact(record                 , now        )          {
  const expiredAt = finiteOf(record.expiredAt)
  if (expiredAt !== undefined && expiredAt <= now) return true
  const validUntil = finiteOf(record.validUntil)
  return validUntil !== undefined && validUntil <= now
}

/** 确定性等距取样：按已排序的下标均匀取 size 个（size >= length 时全取）。 */
function evenlySpacedIndices(length        , size        )           {
  if (size <= 0 || length <= 0) return []
  if (size >= length) return Array.from({ length }, (_, i) => i)
  const out           = []
  for (let i = 0; i < size; i++) out.push(Math.floor((i * length) / size))
  return out
}

/** 向量范数（0 = 零向量，余弦无意义，按 0 处理）。 */
function normOf(vec                   )         {
  let sum = 0
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i] 
    sum += v * v
  }
  return Math.sqrt(sum)
}

/**
 * 计算一份记忆健康度报告。
 *
 * @param records 记录集合（任何可迭代的 MemoryRecord：数组 / Map.values() / ScopeStore.records.values()）
 * @param options 向量、时间、抽样参数等（全部可选）
 */
export function computeHealth(records                        , options                = {})               {
  const now = options.now ?? Date.now()
  const tombstoneDays = Math.max(0, options.tombstoneDays ?? TOMBSTONE_RETENTION_DAYS)
  const dormantAfterDays = Math.max(0, options.dormantAfterDays ?? DORMANT_AFTER_DAYS)
  const duplicateThreshold = clamp01(options.duplicateThreshold ?? DEFAULT_DUPLICATE_THRESHOLD)
  const duplicateSample = Math.max(0, Math.floor(options.duplicateSample ?? DEFAULT_DUPLICATE_SAMPLE))
  const duplicateDetailLimit = Math.max(0, Math.floor(options.duplicateDetailLimit ?? DEFAULT_DUPLICATE_DETAIL_LIMIT))

  const list                    = []
  for (const record of records) {
    if (record === null || typeof record !== 'object') continue
    list.push(record                   )
  }
  const total = list.length

  // ── 1. 分类计数（互斥优先级：墓碑 > 失效 > 隔离 > 休眠 > 活跃）──
  let live = 0
  let dormant = 0
  let tombstoned = 0
  let invalid = 0
  let quarantined = 0
  let conflicted = 0
  let tombstonePurgeable = 0
  let stabilitySum = 0
  let stabilityCount = 0
  let utilitySum = 0
  let utilityCount = 0

  for (const record of list) {
    const importedTombstone = isTombstonedRecord(record)
    if (importedTombstone) {
      tombstoned++
      const expiresAt = finiteOf(record.tombstoneExpiresAt)
      const deadAt = expiresAt ?? (finiteOf(record.tombstonedAt) ?? now) + tombstoneDays * DAY_MS
      if (deadAt <= now) tombstonePurgeable++
    } else if (isInvalidFact(record, now)) {
      invalid++
    } else if (isQuarantinedRecord(record)) {
      quarantined++
    } else if (isDormantRecord(record)) {
      dormant++
    } else {
      live++
    }
    // 冲突是"待裁决"状态，独立统计（不参与互斥分类）。
    if (!importedTombstone) {
      const conflictWith = record.conflictWith
      if (Array.isArray(conflictWith) && conflictWith.length > 0) conflicted++
    }
    // 强度均值只统计真的带该字段的记录（老记录缺省，不拉低均值）。
    const stability = finiteOf(record.stability)
    if (stability !== undefined && stability >= 0) {
      stabilitySum += stability
      stabilityCount++
    }
    const utility = finiteOf(record.utility)
    if (utility !== undefined) {
      utilitySum += clamp01(utility)
      utilityCount++
    }
  }

  // ── 2. 嵌入覆盖 ──
  let embedded = 0
  const embeddedRecords                    = []
  for (const record of list) {
    const vec = vectorOf(options.vectors, record.id)
    if (vec !== undefined && vec.length > 0) {
      embedded++
      embeddedRecords.push(record)
    }
  }
  const pending = total - embedded

  // ── 3. 重复率（抽样：锚点 × 全量邻居，O(sample × n)，确定性）──
  const excludedFromDuplicates = new Set        (options.excludeFromDuplicates ?? [])
  const duplicateCandidates = embeddedRecords
    .filter((record) => !isTombstonedRecord(record) && !isQuarantinedRecord(record))
    .filter((record) => !excludedFromDuplicates.has(record.id))
    .sort((a, b) => a.id.localeCompare(b.id))
  const sampleSize = Math.min(duplicateSample, duplicateCandidates.length)
  let duplicatePairs = 0
  let duplicateAnchors = 0
  const duplicateDetails                        = []
  const pairKeys = new Set        ()

  if (sampleSize >= 2) {
    // 预取向量与范数：避免每个配对都重复计算范数。
    const vecs                      = duplicateCandidates.map((record) => vectorOf(options.vectors, record.id) )
    const norms           = vecs.map((vec) => normOf(vec))
    const anchors = evenlySpacedIndices(duplicateCandidates.length, sampleSize)
    for (const anchorIndex of anchors) {
      const anchorVec = vecs[anchorIndex] 
      const anchorNorm = norms[anchorIndex] 
      const anchorId = duplicateCandidates[anchorIndex] .id
      let hit = false
      for (let j = 0; j < duplicateCandidates.length; j++) {
        if (j === anchorIndex) continue
        if (anchorNorm === 0 || norms[j] === 0) continue
        const other = vecs[j] 
        const length = Math.min(anchorVec.length, other.length)
        let dot = 0
        for (let k = 0; k < length; k++) dot += anchorVec[k]  * other[k] 
        const similarity = clamp01(dot / (anchorNorm * norms[j] ))
        if (similarity < duplicateThreshold) continue
        hit = true
        const otherId = duplicateCandidates[j] .id
        const key = anchorId < otherId ? `${anchorId}\u0000${otherId}` : `${otherId}\u0000${anchorId}`
        if (pairKeys.has(key)) continue
        pairKeys.add(key)
        duplicateDetails.push({ a: anchorId, b: otherId, similarity: Math.round(similarity * 1000) / 1000 })
      }
      if (hit) duplicateAnchors++
    }
    duplicatePairs = pairKeys.size
    duplicateDetails.sort((a, b) => b.similarity - a.similarity || a.a.localeCompare(b.a) || a.b.localeCompare(b.b))
    if (duplicateDetails.length > duplicateDetailLimit) duplicateDetails.length = duplicateDetailLimit
  }
  const duplicateRate = sampleSize > 0 ? duplicateAnchors / sampleSize : 0

  // ── 4. 比例与分数 ──
  const rateOf = (count        )         => (total === 0 ? 0 : count / total)
  const conflictRate = rateOf(conflicted)
  const invalidRate = rateOf(invalid)
  const dormantRate = rateOf(dormant)
  const tombstoneRate = rateOf(tombstoned)
  const quarantineRate = rateOf(quarantined)
  const pendingEmbedRate = rateOf(pending)

  const counts                                         = {
    conflict: conflicted,
    invalid,
    duplicate: duplicateAnchors,
    quarantine: quarantined,
    tombstone: tombstoned,
    dormant,
    pendingEmbed: pending,
  }
  const rates                                         = {
    conflict: conflictRate,
    invalid: invalidRate,
    duplicate: duplicateRate,
    quarantine: quarantineRate,
    tombstone: tombstoneRate,
    dormant: dormantRate,
    pendingEmbed: pendingEmbedRate,
  }

  const breakdown                         = []
  let deductionSum = 0
  for (const rule of HEALTH_SCORE_RULES) {
    const rate = rates[rule.key]
    const deduction = round1(rule.weight * clamp01(rate / rule.tolerance))
    deductionSum += deduction
    breakdown.push({
      key: rule.key,
      label: rule.label,
      count: counts[rule.key],
      rate,
      weight: rule.weight,
      tolerance: rule.tolerance,
      deduction,
    })
  }
  const score = round1(Math.min(HEALTH_SCORE_MAX, Math.max(0, HEALTH_SCORE_MAX - deductionSum)))

  const avgStability = stabilityCount > 0 ? round1(stabilitySum / stabilityCount) : 0
  const avgUtility = utilityCount > 0 ? round1(utilitySum / utilityCount) : 0

  // ── 5. 中文解释明细 ──
  const explain           = []
  explain.push(
    `共 ${total} 条：活跃 ${live} / 休眠 ${dormant} / 墓碑 ${tombstoned} / 失效 ${invalid} / 隔离 ${quarantined}；冲突 ${conflicted} 条。`,
  )
  if (total === 0) {
    explain.push('记忆库为空：健康分 100（无记录可评）。')
  } else {
    explain.push(`嵌入覆盖 ${embedded}/${total}（待嵌入 ${pending}，休眠阈值 ${dormantAfterDays} 天，墓碑保留 ${tombstoneDays} 天）。`)
    if (sampleSize === 0) {
      explain.push('没有可用向量，跳过重复率估计（重复率按 0 计）。')
    } else {
      const scope = sampleSize < duplicateCandidates.length
        ? `抽样 ${sampleSize}/${duplicateCandidates.length} 条锚点`
        : `全量 ${sampleSize} 条锚点`
      explain.push(
        `重复率 ${fmtPercent(duplicateRate)}（${scope}，阈值 ${duplicateThreshold.toFixed(2)}，命中 ${duplicatePairs} 对）。`,
      )
    }
    for (const item of breakdown) {
      if (item.deduction <= 0) continue
      // 重复率的分母是抽样锚点数，不是 total —— 解释文案要写对，否则像"2/7 的重复率 50%"。
      const scale = item.key === 'duplicate' ? `${item.count}/${sampleSize} 个抽样锚点` : `${item.count}/${total}`
      explain.push(
        `${item.label} ${fmtPercent(item.rate)}（${scale}）→ 扣 ${item.deduction.toFixed(1)} 分` +
          `（权重 ${item.weight}，容忍度 ${fmtPercent(item.tolerance)}）。`,
      )
    }
    if (stabilityCount > 0 || utilityCount > 0) {
      explain.push(`平均保持度 ${avgStability}（${stabilityCount} 条样本），平均效用 ${avgUtility}（${utilityCount} 条样本）。`)
    }
    if (tombstonePurgeable > 0) {
      explain.push(`其中 ${tombstonePurgeable} 条墓碑已过保留窗口，下次维护可物理清理。`)
    }
    explain.push(`健康分 ${score.toFixed(1)} / ${HEALTH_SCORE_MAX}。`)
  }

  return {
    total,
    live,
    dormant,
    tombstoned,
    invalid,
    quarantined,
    conflicted,
    tombstonePurgeable,
    embedded,
    pending,
    duplicateSampled: sampleSize,
    duplicatePairs,
    duplicateRate,
    duplicateDetails,
    conflictRate,
    invalidRate,
    dormantRate,
    tombstoneRate,
    quarantineRate,
    pendingEmbedRate,
    avgStability,
    avgUtility,
    samples: { stability: stabilityCount, utility: utilityCount },
    score,
    breakdown,
    explain,
  }
}

/** 百分比格式：<0.1% 也写出来，避免面板显示 0% 却扣分。 */
function fmtPercent(rate        )         {
  const value = clamp01(rate) * 100
  if (value <= 0) return '0%'
  if (value < 0.1) return '<0.1%'
  return `${value.toFixed(1)}%`
}


//# sourceURL=source/memory-local/src/cognitive/health.ts