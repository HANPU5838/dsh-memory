/**
 * 注入前的冲突消解（0.83.0）。
 *
 * 背景：认知层会检测「措辞像但事实矛盾」的记忆对，并给双方打 `conflictWith` 标记。
 * 检索阶段两条都可能进候选；如果原样一起注入，模型会拿到两个互相矛盾的结论，
 * 反而比只给一条更糟。这里在**注入前**做一次确定性裁决：
 *
 *   - 只处理「双方都在本次命中里」的冲突（引用到不存在的记录 = 忽略）；
 *   - 胜者规则：重要度更高 → 更新时间更新 → id 字典序更小（完全确定性）；
 *   - 败者从注入里去掉，但记录保留（不删数据），审计里记为 reason='conflict'；
 *   - 不改写、不猜测哪条"正确"，只保证同一上下文里不出现互相矛盾的两条。
 *
 * 纯函数、无 I/O；不改入参。
 */
                                           

                                     
                   
                   
 

                          
            
                     
                    
                        
 

function conflictIdsOf(record                )           {
  if (!Array.isArray(record.conflictWith)) return []
  return record.conflictWith.filter((id)               => typeof id === 'string' && id !== '')
}

/** 比较两条冲突记录的胜负：正数 = a 胜。 */
function compareConflict(a                , b                )         {
  const aImp = typeof a.importance === 'number' && Number.isFinite(a.importance) ? a.importance : 0
  const bImp = typeof b.importance === 'number' && Number.isFinite(b.importance) ? b.importance : 0
  if (aImp !== bImp) return aImp - bImp
  const aAt = typeof a.updatedAt === 'number' && Number.isFinite(a.updatedAt) ? a.updatedAt : 0
  const bAt = typeof b.updatedAt === 'number' && Number.isFinite(b.updatedAt) ? b.updatedAt : 0
  if (aAt !== bAt) return aAt - bAt
  // 完全并列时按 id 反向比较：id 小者胜（deterministic）。
  return b.id.localeCompare(a.id)
}

/**
 * 消解本次命中内部的冲突对。
 *
 * @returns kept（保持原顺序）与 dropped（败者 id，按命中顺序）
 */
export function resolveInjectionConflicts(hits                      )                     {
  if (!Array.isArray(hits) || hits.length < 2) return { kept: [...(hits ?? [])], dropped: [] }
  const byId = new Map                   ()
  for (const hit of hits) {
    const id = hit?.record?.id
    if (typeof id === 'string' && id !== '') byId.set(id, hit)
  }
  const dropped = new Set        ()
  const records                   = []
  for (const hit of hits) {
    const rec = hit?.record                              
    if (rec === undefined) continue
    records.push({ id: rec.id, importance: rec.importance, updatedAt: rec.updatedAt, conflictWith: rec.conflictWith })
  }
  for (const record of records) {
    for (const otherId of conflictIdsOf(record)) {
      if (otherId === record.id) continue
      const other = records.find((candidate) => candidate.id === otherId)
      if (other === undefined) continue // 冲突对手不在本次命中里：注入侧不处理
      // 胜者 = compareConflict > 0 的一方；双方都投过票时，先算一次即可（幂等）。
      const winner = compareConflict(record, other) > 0 ? record.id : other.id
      const loser = winner === record.id ? other.id : record.id
      dropped.add(loser)
    }
  }
  const droppedList           = []
  const kept              = []
  for (const hit of hits) {
    const id = hit?.record?.id
    if (typeof id === 'string' && dropped.has(id)) {
      droppedList.push(id)
      continue
    }
    kept.push(hit)
  }
  return { kept, dropped: droppedList }
}


//# sourceURL=source/memory-inject/src/conflicts.ts