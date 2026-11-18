import { escapeTemplateBraces } from './braces.js'
/**
 * 流程索引:系统提示里的「相关流程」目录。
 *
 * 为什么不直接注入 procedure 全文:
 *   - 流程通常很长,全部常驻会挤爆系统提示;
 *   - 注入点在 agent/pre-step,模型决定调用工具之前拿不到工具名;
 *   - 所以这里只给"当前工作区 + 任务/工具触发词"命中的流程目录,每行
 *     `id · 触发词 → 标题`;模型需要细节时用 memory_get 取全文。
 *
 * 匹配口径:
 *   - 当前工作区的 procedure 总是可见(工作区本身就是触发条件);
 *   - 其它 scope(global/session/自定义)必须命中 triggers,没有 triggers 时用 tags;
 *   - 既没有 triggers/tags 又不在当前工作区的流程不出现,避免把无关项目带进来。
 */
                                              
import { estimateTokens } from '../provider/rerank.js'
                                                                                   
import { supersededIds } from './digest.js'
import { textHasTag } from './signals.js'

export const PROCEDURES_HEADER =
  '以下是当前工作区 / 任务相关的流程索引（按需用 memory_get <id> 取全文）：'

                                   
                                            
                
                      
                           
                                  
                                   
              
 

                                    
            
                                        
 

                                  
                    
                 
                  
                
               
                              
 

                                   
              
                
               
               
                        
 

function triggersOf(record              )           {
  const raw = (record                                         ).triggers
  if (!Array.isArray(raw)) return []
  const out           = []
  const seen = new Set        ()
  for (const value of raw) {
    if (typeof value !== 'string') continue
    const term = value.trim()
    if (term === '') continue
    const key = term.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(term)
  }
  return out
}

/** 触发词:显式 triggers 优先,没有就用 tags。 */
export function procedureTerms(record              )           {
  const triggers = triggersOf(record)
  if (triggers.length > 0) return triggers
  return (record.tags ?? []).map((tag) => String(tag).trim()).filter((tag) => tag !== '')
}

function titleOf(record              )         {
  return record.content.replace(/\s+/g, ' ').trim().slice(0, 80)
}

/** 一行目录:ID · 触发词 → 标题。不复制正文。 */
export function procedureLine(record              )         {
  const terms = procedureTerms(record).slice(0, 3)
  const trigger = terms.length > 0 ? terms.join('/') : '流程'
  return `- \`${record.id.slice(0, 8)}\` · ${trigger} → ${titleOf(record)}`
}

function matches(record              , terms                   , haystack        )          {
  if (terms.length === 0) return false
  return terms.some((term) => textHasTag(haystack, term))
}

/**
 * 渲染流程索引。没有命中项时返回 null(系统提示 section 用空串表示不注入)。
 */
export function renderProcedureIndex(
  records                         ,
  cfg                    ,
  context                   = {},
)                          {
  if (!cfg.enabled) return null
  const now = context.now ?? Date.now()
  const retired = supersededIds(records)
  const projectScopes = new Set(context.projectScopes ?? [])
  const haystack = [
    context.query ?? '',
    ...(context.tools ?? []),
    ...projectScopes,
  ].join(' ')

  const candidates                 = []
  const omitted                      = []
  for (const record of records) {
    if (record.kind !== 'procedure') continue
    if (retired.has(record.id)) continue
    if (record.expiredAt !== undefined && record.expiredAt < now) continue
    candidates.push(record)
  }

  const matched                 = []
  for (const record of candidates) {
    const terms = procedureTerms(record)
    const isProject = projectScopes.has(record.scope)
    if (isProject || matches(record, terms, haystack)) matched.push(record)
    else omitted.push({ id: record.id, reason: 'unmatch' })
  }

  // 当前工作区优先,其次重要度 / 新鲜度;稳定排序保证同一输入同样输出。
  const ordered = [...matched].sort(
    (a, b) =>
      Number(projectScopes.has(b.scope)) - Number(projectScopes.has(a.scope)) ||
      b.importance - a.importance ||
      b.updatedAt - a.updatedAt ||
      a.content.localeCompare(b.content),
  )

  let tokens = estimateTokens(PROCEDURES_HEADER) + 4
  const lines           = []
  const ids           = []
  let omittedTopK = 0
  let omittedBudget = 0
  let budgetExhausted = false
  for (const [index, record] of ordered.entries()) {
    if (index >= cfg.maxItems) {
      omittedTopK += 1
      omitted.push({ id: record.id, reason: 'top_k' })
      continue
    }
    if (budgetExhausted) {
      omittedBudget += 1
      omitted.push({ id: record.id, reason: 'budget' })
      continue
    }
    const line = procedureLine(record)
    const cost = estimateTokens(line) + 1
    if (tokens + cost > cfg.tokenBudget) {
      budgetExhausted = true
      omittedBudget += 1
      omitted.push({ id: record.id, reason: 'budget' })
      continue
    }
    lines.push(line)
    ids.push(record.id)
    tokens += cost
  }

  if (lines.length === 0) return null
  return {
    text: escapeTemplateBraces(`${PROCEDURES_HEADER}\n${lines.join('\n')}`),
    tokens,
    count: lines.length,
    ids,
    stats: {
      candidates: candidates.length,
      matched: matched.length,
      injected: lines.length,
      tokens,
      ids,
      omitted,
    },
  }
}


//# sourceURL=source/memory-inject/src/procedures.ts