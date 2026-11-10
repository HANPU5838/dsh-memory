/**
 * 冲突检测（cognitive/conflict）—— 纯函数，只打标，绝不自动删改。
 *
 * 相似度落在 [0.75, 0.92) 这个区间意味着：两句话说的是同一类事，但内容对不上
 * （新事实与旧事实矛盾，或只是部分重叠）。这时自动合并会吃掉信息、自动删除更危险，
 * 所以只给记录打上 `conflictWith` / `conflictConfidence` 标记，把决策权交给上层
 * （工具回执提示用户 / 面板人工裁决 / 后续按访问反馈淘汰）。
 *
 * 边界（与 merge 模块同口径）：
 *   < 0.75          → 不相干
 *   [0.75, 0.92)    → 冲突区（本模块）
 *   >= 0.92         → 语义重复区（cognitive/merge 合并）
 */
import {
  clamp01,
  isTombstonedRecord,
  normalizeContent,
                       
                       
                    
                   
} from '../store.js'
import { MERGE_THRESHOLD } from './merge.js'

/** 冲突区间下界（含）。低于它 = 不相干。 */
export const CONFLICT_MIN_SIMILARITY = 0.75
/** 冲突区间上界（不含）。到达它 = 语义重复，归 merge 管。 */
export const CONFLICT_MAX_SIMILARITY = MERGE_THRESHOLD
/** 置信度高于它按"高冲突"处理（更容易被上层优先展示/处理）。 */
export const CONFLICT_HIGH_SIMILARITY = 0.85

/** 候选：已存在的记录 + 与新内容的嵌入相似度。 */
                                    
                      
                    
 

                                  
            
                    
 

                                  
                         
              
                          
              
                               
                
 

                                     
                     
                       
                             
                                
           
                          
                              
   
                                   
 

/** 相似度是否落在冲突区间 [min, max)。 */
export function inConflictBand(similarity        , options                  = {})          {
  const min = clamp01(options.min ?? CONFLICT_MIN_SIMILARITY)
  const max = clamp01(options.max ?? CONFLICT_MAX_SIMILARITY)
  const sim = clamp01(similarity)
  return sim >= min && sim < max
}

/**
 * 评估"新内容 vs 一组相似候选"，产出冲突标记。
 *
 * 归一化后内容完全相同的候选不算冲突（那是重复，归 refresh/merge）；
 * 软删记录不参与；返回结果**不含任何写操作**，打标由 markConflict() 显式执行。
 */
export function assessConflicts(input   
                 
                                         
                           
 )                     {
  const options = input.options ?? {}
  const min = clamp01(options.min ?? CONFLICT_MIN_SIMILARITY)
  const max = clamp01(options.max ?? CONFLICT_MAX_SIMILARITY)
  const limit = Math.max(0, Math.floor(options.limit ?? 5))
  const incoming = normalizeContent(input.content)
  const findings                    = []
  for (const candidate of input.candidates) {
    if (candidate.record === undefined || isTombstonedRecord(candidate.record)) continue
    if (!Number.isFinite(candidate.similarity)) continue
    const similarity = clamp01(candidate.similarity)
    if (similarity < min || similarity >= max) continue
    // 内容相同 = 重复而非冲突（重复交给 merge 的 identical-content 分支）。
    if (normalizeContent(candidate.record.content) === incoming) continue
    findings.push({ id: candidate.record.id, similarity })
  }
  findings.sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id))
  const kept = findings.slice(0, limit)
  return {
    conflicted: kept.length > 0,
    findings: kept,
    marker: {
      conflictWith: kept.map((f) => f.id),
      conflictConfidence: kept.length > 0 ? kept[0] .similarity : 0,
    },
    severity: kept.length === 0 ? 'none' : kept[0] .similarity >= CONFLICT_HIGH_SIMILARITY ? 'high' : 'low',
  }
}

/** 记录是否带冲突标记（缺省 false：老记录不受影响）。 */
export function isConflicted(record              )          {
  const ids = (record                   ).conflictWith
  return Array.isArray(ids) && ids.length > 0
}

/**
 * 把冲突标记写到记录上（原地修改并返回同一引用）。
 * **只打标**：内容、tags、importance、过期时间一律不动，也不删任何记录。
 */
export function markConflict                        (record   , assessment                    )    {
  const target = record                       
  if (!assessment.conflicted) {
    clearConflict(record)
    return record
  }
  target.conflictWith = [...assessment.marker.conflictWith]
  target.conflictConfidence = clamp01(assessment.marker.conflictConfidence)
  return record
}

/** 清除冲突标记（冲突被人工裁决 / 旧记录被合并后调用）。 */
export function clearConflict(record              )       {
  const target = record                   
  delete target.conflictWith
  delete target.conflictConfidence
}

/** 把评估结果转成可直接写进新记录的字段（save 路径用）。 */
export function conflictFields(assessment                    )                  {
  if (!assessment.conflicted) return {}
  return {
    conflictWith: [...assessment.marker.conflictWith],
    conflictConfidence: clamp01(assessment.marker.conflictConfidence),
  }
}

/**
 * 把冲突标记写进 store（按 id 定位 → 复制记录 → 打标 → insert 进增量）。
 *
 * 这是"标记落盘"的唯一入口：assessConflicts 是纯函数、markConflict 只改内存对象，
 * 上层（memory_save / 维护任务）调这一个就好。返回 false 表示 id 不存在/未加载。
 * 不自动 flush —— 与 store 其它写路径一致，由调用方 scheduleFlush()/flush()。
 */
export function applyConflictMarker(
  store             ,
  id        ,
  assessment                    ,
)          {
  const located = store.scopeOf(id)
  if (located === undefined) return false
  const next = { ...located.record }                   
  if (assessment.conflicted) {
    next.conflictWith = [...assessment.marker.conflictWith]
    next.conflictConfidence = clamp01(assessment.marker.conflictConfidence)
  } else {
    delete next.conflictWith
    delete next.conflictConfidence
  }
  located.store.insert(next)
  return true
}

/**
 * 关键细节抽取：数字（含小数/百分比）、路径、代码标识符、日期。
 * 两条记忆"措辞几乎一样但关键细节不同"（如 10.4GB vs 20GB、端口 8080 vs 8078）
 * 属于**事实冲突**，绝不能当成同义重复自动合并 —— 这是纯向量相似度的盲区：
 * 这种对的余弦往往 >0.95，比真正的同义改写还高。
 */
/**
 * 0.41.4：标识符同义归一化。
 * `aarch64` / `arm64`、`x86_64` / `amd64` 是同一事实的不同写法；
 * 若不归一，会被 criticalDetails 当成"关键标识符不一致"，把正常记忆误判成冲突。
 */
const IDENTIFIER_SYNONYMS = new Map                ([
  ['aarch64', 'arm64'], ['arm64', 'arm64'],
  ['x86_64', 'x86_64'], ['amd64', 'x86_64'], ['x64', 'x86_64'],
  ['armv7', 'arm32'], ['armhf', 'arm32'],
  ['nodejs', 'node'],
])
export function canonicalIdentifier(token        )         {
  return IDENTIFIER_SYNONYMS.get(token) ?? token
}

export function criticalDetails(content        )              {
  const out = new Set        ()
  // 数字（含小数、千分位、百分比、单位前的数值）
  for (const m of content.matchAll(/\d+(?:[.,]\d+)*/g)) out.add(`n:${m[0].replace(/,/g, '')}`)
  // 路径 / URL / 端口
  for (const m of content.matchAll(/(?:\/[\w.\-]+){2,}|https?:\/\/\S+/g)) out.add(`p:${m[0]}`)
  // 拉丁标识符（单词长度 ≥3，排除常见英文停用词）
  for (const m of content.toLowerCase().matchAll(/[a-z][a-z0-9_+.\-]{2,}/g)) {
    if (!STOP_WORDS.has(m[0])) out.add(`w:${canonicalIdentifier(m[0])}`)
  }
  return out
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were', 'have', 'has',
  'not', 'but', 'you', 'your', 'can', 'will', 'all', 'any', 'our', 'out', 'use', 'only',
])

/**
 * 两条正文是否存在"关键细节冲突"：
 * 双方都带关键细节、但细节集合不一致 → true（应标冲突，不能合并）。
 * 一方完全没有关键细节（如"随便聊聊"）→ false（无从判断，交给相似度）。
 */
export function hasCriticalDetailConflict(a        , b        )          {
  const left = criticalDetails(a)
  const right = criticalDetails(b)
  if (left.size === 0 || right.size === 0) return false
  // 0.41.4：**子集不算冲突**。
  // 旧逻辑只要集合大小或成员不同就判冲突，导致「设备是 arm64 Android」vs
  // 「设备架构是 arm64」这种"一边多说了个细节"被当成矛盾，进而误失效旧记忆。
  // 真正的冲突是"双方都给了同一类细节、但值互相排斥"（8080 vs 9090、npm vs pnpm），
  // 这种集合互不为子集；子集关系只是详细程度不同。
  const isSubset = (x             , y             )          => {
    for (const token of x) if (!y.has(token)) return false
    return true
  }
  if (isSubset(left, right) || isSubset(right, left)) return false
  return true
}



//# sourceURL=source/memory-local/src/cognitive/conflict.ts