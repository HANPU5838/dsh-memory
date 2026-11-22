/**
 * 元认知自省（metacognition）：把「记忆系统自己的运行信号」汇总成一份报告，
 * 并据此生成反思候选。
 *
 * 设计约束：
 *  - 纯函数：只读记录与外部信号，不写库、不调模型，便于测试与复用；
 *  - 信号必须是**可观测事实**（修正次数、冲突、长期未用、规则陈旧、钩子否决率），
 *    不是猜出来的“感觉”；
 *  - 不自动改记忆：报告与候选反射由人或 Agent 确认后才进主库。
 */
                                              

const DAY = 86_400_000

                                 
              
                   
                     
                    
                        
                              
                     
                                            
                    
                                      
                      
                                
                       
 

                                                    

                                
                                                                                                          
               
               
                           
                
               
 

                                
                     
                                                 
                          
                       
 

                                     
                  
                      
                     
                         
 

function severity(count        , watch        , act        )                  {
  if (count >= act) return 'act'
  if (count >= watch) return 'watch'
  return 'ok'
}

export function buildInsight(records                         , options                 = {})                {
  const now = options.now ?? Date.now()
  const recentDays = options.recentDays ?? 7
  const staleRuleDays = options.staleRuleDays ?? 30
  const lowUtility = options.lowUtility ?? 0.3
  const since = now - recentDays * DAY
  const list = records                   

  const corrections = list.filter((record) => record.supersedes !== undefined && record.updatedAt >= since)
  const conflicts = options.conflicts ?? list.filter((record) => Array.isArray(record.conflictWith) && record.conflictWith.length > 0).length
  const lowUtilityRecords = list.filter((record) =>
    typeof record.utility === 'number' && record.utility < lowUtility && (record.accessCount ?? 0) === 0)
  const staleRules = list.filter((record) =>
    record.kind === 'rule' && now - record.updatedAt > staleRuleDays * DAY)
  const neverAccessed = list.filter((record) =>
    (record.accessCount ?? 0) === 0 && now - record.createdAt > staleRuleDays * DAY)

  const signals                  = [
    {
      key: 'corrections',
      label: '近期修正',
      count: corrections.length,
      severity: severity(corrections.length, 1, 4),
      detail: `最近 ${recentDays} 天有 ${corrections.length} 条记忆被新版本修正`,
      ids: corrections.map((record) => record.id),
    },
    {
      key: 'conflicts',
      label: '待裁决冲突',
      count: conflicts,
      severity: severity(conflicts, 1, 3),
      detail: conflicts === 0 ? '没有待裁决冲突' : `${conflicts} 条记录带冲突标记`,
      ids: [],
    },
    {
      key: 'lowUtility',
      label: '低价值未用',
      count: lowUtilityRecords.length,
      severity: severity(lowUtilityRecords.length, 2, 6),
      detail: `效用 < ${lowUtility} 且从未被访问的记忆 ${lowUtilityRecords.length} 条`,
      ids: lowUtilityRecords.map((record) => record.id),
    },
    {
      key: 'staleRules',
      label: '陈旧规则',
      count: staleRules.length,
      severity: severity(staleRules.length, 1, 3),
      detail: `超过 ${staleRuleDays} 天未更新的规则 ${staleRules.length} 条`,
      ids: staleRules.map((record) => record.id),
    },
    {
      key: 'neverAccessed',
      label: '长期未用',
      count: neverAccessed.length,
      severity: severity(neverAccessed.length, 3, 8),
      detail: `超过 ${staleRuleDays} 天从未被检索到的记忆 ${neverAccessed.length} 条`,
      ids: neverAccessed.map((record) => record.id),
    },
    {
      key: 'hookVeto',
      label: '钩子否决率',
      count: Math.round((options.hookVetoRate ?? 0) * 100),
      severity: severity((options.hookVetoRate ?? 0) * 100, 20, 40),
      detail: `钩子拒绝占比 ${Math.round((options.hookVetoRate ?? 0) * 100)}%`,
      ids: [],
    },
  ]

  if (options.healthScore !== undefined) {
    signals.push({
      key: 'health',
      label: '健康分',
      count: Math.round(options.healthScore),
      severity: options.healthScore >= 90 ? 'ok' : options.healthScore >= 70 ? 'watch' : 'act',
      detail: `当前健康分 ${options.healthScore}/100`,
      ids: [],
    })
  }

  const suggestions           = []
  if (corrections.length >= 3) suggestions.push('修正次数偏多：检查是否有同类记忆反复被版本化，考虑合并为一条规则或流程。')
  if (conflicts > 0) suggestions.push('存在待裁决冲突：用冲突中心逐条确认，避免新旧版本同时被召回。')
  if (lowUtilityRecords.length >= 3) suggestions.push('低价值未用记忆偏多：考虑提高写入门槛或清理，减少注入噪声。')
  if (staleRules.length > 0) suggestions.push('规则陈旧：复核是否仍然成立，过期规则应降级为假设或删除。')
  if ((options.hookVetoRate ?? 0) > 0.2) suggestions.push('钩子否决率偏高：确认规则是否过严，或保存内容确实不合规。')
  if (options.healthScore !== undefined && options.healthScore < 90) suggestions.push('健康分未满：先跑 memory_maintain，再处理剩余扣分项。')

  return {
    generatedAt: now,
    totals: { records: list.length, recentDays },
    signals,
    suggestions,
  }
}

/** 把报告压成一条可读的反思正文（候选记录用）。 */
export function summarizeInsight(report               )         {
  const active = report.signals.filter((signal) => signal.severity !== 'ok')
  const lines = [
    `自省报告（${new Date(report.generatedAt).toISOString().slice(0, 10)}）：共 ${report.totals.records} 条记忆。`,
    ...active.map((signal) => `- ${signal.label}：${signal.detail}`),
  ]
  if (report.suggestions.length > 0) lines.push(`建议：${report.suggestions.join(' ')}`)
  return lines.join('\n')
}


//# sourceURL=source/memory-local/src/insight.ts