/**
 * 认知节律（proactive rhythm）：让系统按自己的时间尺度做两件事——
 *   1. 周期性自省（反思不再靠人触发）；
 *   2. 从最近的记忆里提出「候选目标」（目标不再只能由用户输入）。
 *
 * 纯函数层：只判断“该不该做”和“提议什么”，写库与落状态由 provider 负责。
 */
const DAY = 86_400_000

                              
                        
                        
 

                                
              
                        
                         
                          
                         
 

export function reflectionDue(state             , options                = {})          {
  const now = options.now ?? Date.now()
  const every = options.reflectEveryMs ?? DAY
  return state.lastReflectAt === undefined || now - state.lastReflectAt >= every
}

export function proposalDue(state             , options                = {})          {
  const now = options.now ?? Date.now()
  const every = options.proposeEveryMs ?? 3 * DAY
  return state.lastProposeAt === undefined || now - state.lastProposeAt >= every
}

                                
                    
                    
                    
                     
 

                   
            
              
                 
                    
                   
 

/**
 * 目标线索只认“指向未来”的措辞。像“需要 / 必须”这种在规则、操作说明里到处都是，
 * 用来提目标会把“部署记录 / 使用规范”误报成目标（实测过）。
 */
const GOAL_HINTS = ['下一步', '待办', '计划', '准备', '接下来', '未完成', 'TODO', '之后要', '还需要']
/** 自省/提案产物本身不能再次成为目标素材，否则会自我循环。 */
const SELF_REFERENTIAL = ['候选目标', '自省报告', '节律自省']

export function inferGoalCandidates(records                       , options                = {})                  {
  const now = options.now ?? Date.now()
  const since = now - 14 * DAY
  const candidates                  = []
  for (const record of records) {
    if (record.updatedAt < since) continue
    // 只从「决策 / 状态」里提目标；procedure 是做事方法，不是目标。
    if (record.kind !== 'decision' && record.kind !== 'state') continue
    if (record.importance < 0.7) continue
    if (SELF_REFERENTIAL.some((marker) => record.content.includes(marker))) continue
    const hits = GOAL_HINTS.filter((hint) => record.content.includes(hint))
    if (hits.length === 0) continue
    candidates.push({
      conclusion: record.content.slice(0, 120),
      evidence: [`命中线索：${hits.join('、')}`, `来源记忆 ${record.id.slice(0, 8)}（${record.kind}）`],
      confidence: Math.min(0.9, 0.5 + 0.1 * hits.length + record.importance * 0.2),
      sourceIds: [record.id],
    })
  }
  return candidates.slice(0, 3)
}


/** 近期是否已有同一结论的候选：避免节律每次自省都写一条近重复记录。 */
export function hasRecentCandidate(
  records                                                                                          ,
  conclusion        ,
  options                                          = {},
)          {
  const now = options.now ?? Date.now()
  const windowMs = options.proposeEveryMs ?? 7 * DAY
  const key = conclusion.trim()
  if (key === '') return false
  return records.some((record) => record.kind === (options.kind ?? 'reflection')
    && record.updatedAt > now - windowMs
    && (record.conclusion ?? record.content).includes(key.slice(0, 40)))
}


//# sourceURL=source/memory-local/src/cognitive/rhythm.ts