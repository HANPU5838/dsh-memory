/**
 * 会话摘要(L1):会话第一步给一次"这个项目/全局已经记了什么"的全景。
 *
 * 与逐轮召回的分工:召回按这一轮的问题找;摘要不按问题,按重要度 × 新鲜度
 * 挑几条,让模型一开始就知道有哪些旧结论可复用,而不是先搜一遍。
 *
 * 0.9.6 起,摘要不再静默截断:
 *   - 返回完整的候选/注入/省略统计与每条省略原因(top_k / budget / superseded / expired / rule);
 *   - 被省略的正文会生成一段**独立的标签索引**,让模型知道哪些领域还有未展开的记忆;
 *   - 标签索引有自己的 token 预算与条数上限,不会反过来挤爆正文;
 *   - 退役(superseded)记录默认不进入摘要正文,也不生成索引;
 *   - kind=rule 的记录不进摘要:硬性规则已经常驻系统提示,再列一遍是跨通道重复。
 */
                                              
import { estimateTokens } from '../provider/rerank.js'
                                                                               

const HEADER =
  '以下是本项目 / 全局已有的记忆摘要（按重要度挑出的前几条；' +
  '需要原文用 memory_get，定位用 memory_search；无关条目用 memory_block 屏蔽，过时/写错的才用 memory_forget 删除）：'

const HINT_HEADER = '相关记忆索引（正文未注入）：'
const HINT_FOOTER = '这些条目的正文尚未加载；遇到相关任务时，按 ID 用 memory_get 取正文，按标签用 memory_search 定位；与本轮无关的用 memory_block 屏蔽。'

/** 一条正文被省略的原因。统计口径互斥:每条记录只归入一个原因。 */
                                                                                     

                                 
            
                          
                         
               
                 
 

                                  
                    
                  
                     
                       
                
                
                  
 

                              
                    
                
                  
                     
                       
                           
                        
                      
                    
                           
                       
                                   
                   
                                 
                   
                                       
                                                       
                                                       
 

                               
              
                                             
                
               
                    
 

/**
 * scope 的紧凑分类标签:global/项目/会话/自定义。
 *
 * 前三种是**分类词**(摘要按预算只给类型,不给完整名字);自定义作用域没有分类可归,
 * 所以给 `custom:<名字>` —— 0.25.11 起补上前缀,否则摘要里它是个裸名字,和全局/项目/
 * 会话这些分类词混在一起看不出是什么。
 */
export function digestScopeLabel(scope        )         {
  if (scope === 'global') return '全局'
  if (scope === 'project' || scope.startsWith('project:')) return '项目'
  if (scope === 'session' || scope.startsWith('session:')) return '会话'
  return `custom:${scope}`
}

/**
 * 摘要排序:与淘汰规则同一套"新鲜度(30 天半衰期)× 重要度",并列时按作用域
 * 优先级(会话 > 项目 > 自定义 > 全局),再按 accessCount(弱辅助)、内容稳定排序 ——
 * 同样的输入必须给出同样的摘要,否则两个注入实例的内容会对不上。
 *
 * accessCount 只在分数与作用域都相同时作为弱 tie-break,不能压过任务相关性。
 */
export function rankForDigest(records                         , now = Date.now())                 {
  const weight = (scope        )         => {
    if (scope.startsWith('session:')) return 3
    if (scope.startsWith('project:')) return 2
    if (scope === 'global') return 0
    return 1
  }
  const score = (record              )         =>
    Math.pow(0.5, Math.max(0, now - record.updatedAt) / 86_400_000 / 30) * (0.1 + record.importance)
  return [...records].sort((a, b) => {
    const ra = score(a)
    const rb = score(b)
    if (rb !== ra) return rb - ra
    const wa = weight(a.scope)
    const wb = weight(b.scope)
    if (wa !== wb) return wb - wa
    if ((b.accessCount ?? 0) !== (a.accessCount ?? 0)) return (b.accessCount ?? 0) - (a.accessCount ?? 0)
    return a.content.localeCompare(b.content)
  })
}

/** 被任何一条记录 supersedes 指向的记录 id(只读扫描,不修改存储)。 */
export function supersededIds(records                         )              {
  const ids = new Set        ()
  for (const record of records) {
    if (typeof record.supersedes === 'string' && record.supersedes.length > 0) ids.add(record.supersedes)
  }
  return ids
}

function tagsOf(record              )           {
  return (record.tags ?? [])
    .map((tag) => String(tag).trim())
    .filter((tag) => tag.length > 0)
}

/** 标签索引的一行:ID / 主题标签 / 类型 / 作用域。不复制正文。 */
export function digestHintLine(record              )         {
  const tags = tagsOf(record).slice(0, 4)
  const topic = tags.length > 0 ? tags.join('/') : record.content.replace(/\s+/g, ' ').trim().slice(0, 30)
  return `- \`${record.id.slice(0, 8)}\` · ${topic} · ${record.kind} · ${digestScopeLabel(record.scope)}`
}

/** 标签索引的主题优先词:操作流程/发布/部署/凭据。 */
const OPERATIONAL_TAGS = new Set([
  'release', 'publish', 'deploy', 'deployment', 'credentials', 'credential',
  'npm', 'git', 'github', 'push', 'rollback', '发布', '推送', '部署', '凭据',
])

/**
 * 被截断记录的索引优先级:mandatory/pinned 最前,其次是操作型标签/类型,
 * 最后才按原摘要排名。避免索引预算被一堆普通事实占满,真正需要的发布流程却进不来。
 */
function hintPriority(record              )         {
  const tags = tagsOf(record).map((tag) => tag.toLowerCase())
  let score = 0
  if (tags.some((tag) => tag === 'mandatory' || tag === 'pinned' || tag === '必含' || tag === '强制')) score += 100
  if (tags.some((tag) => OPERATIONAL_TAGS.has(tag) || tag.startsWith('phase:'))) score += 60
  if (record.kind === 'procedure' || record.kind === 'rule') score += 20
  return score
}

function prioritizeHints(records                         )                 {
  return [...records]
    .map((record, index) => ({ record, index, priority: hintPriority(record) }))
    .sort((a, b) => b.priority - a.priority || a.index - b.index)
    .map((entry) => entry.record)
}

/** 生成被省略记录的标签索引;预算/条数独立于正文。 */
function renderHintIndex(omitted                         , cfg                )   
                     
                
                  
                     
                       
                       
  {
  if (omitted.length === 0) {
    return { text: null, tokens: 0, injected: 0, omittedTopK: 0, omittedBudget: 0, injectedIds: [] }
  }
  let tokens = estimateTokens(HINT_HEADER) + 4
  const lines           = []
  const injectedIds           = []
  let omittedTopK = 0
  let omittedBudget = 0
  for (const record of prioritizeHints(omitted)) {
    if (lines.length >= cfg.hintMaxItems) { omittedTopK += 1; continue }
    const line = digestHintLine(record)
    const cost = estimateTokens(line) + 1
    if (tokens + cost > cfg.hintBudget) { omittedBudget += 1; continue }
    lines.push(line)
    injectedIds.push(record.id)
    tokens += cost
  }
  if (lines.length === 0) {
    return { text: null, tokens: 0, injected: 0, omittedTopK, omittedBudget, injectedIds }
  }
  let text = `${HINT_HEADER}\n${lines.join('\n')}\n${HINT_FOOTER}`
  const extra           = []
  if (omittedTopK > 0) extra.push(`条数上限 ${omittedTopK}`)
  if (omittedBudget > 0) extra.push(`预算 ${omittedBudget}`)
  if (extra.length > 0) text += `\n（另有 ${extra.join(' / ')} 条索引未展示）`
  return { text, tokens, injected: lines.length, omittedTopK, omittedBudget, injectedIds }
}

/** 一条记录在摘要/召回里的行首标签。状态型记忆必须提示“使用前验证”。 */
export function recordKindPrefix(record              )         {
  return record.kind === 'state' ? '【状态，使用前验证】' : ''
}

export function digestLine(record              )         {
  return `- ${record.id.slice(0, 8)} [${digestScopeLabel(record.scope)}/${record.kind}] ${recordKindPrefix(record)}${record.content.replace(/\s+/g, ' ').slice(0, 160)}`
}

/**
 * 摘要的完整计划:正文 + 截断统计 + 标签索引。
 *
 * 统计口径:先按规则/退役/过期过滤,再按排序依次尝试注入;`selected` 以外的记录
 * 只会归入 `top_k`、`budget`、`superseded`、`expired`、`rule` 之一。
 */
export function renderDigest(records                         , cfg                , now = Date.now())                      {
  if (records.length === 0) return null

  const retired = supersededIds(records)
  const active                 = []
  const omitted                   = []
  let omittedSuperseded = 0
  let omittedExpired = 0
  let omittedRules = 0
  for (const record of records) {
    // 规则已经常驻系统提示(rules 段);摘要再列一遍就是同一个 id 在两个通道出现。
    if (record.kind === 'rule') {
      omittedRules += 1
      omitted.push({ id: record.id, reason: 'rule', kind: record.kind, tags: tagsOf(record) })
      continue
    }
    if (retired.has(record.id)) {
      omittedSuperseded += 1
      omitted.push({ id: record.id, reason: 'superseded', kind: record.kind, tags: tagsOf(record) })
      continue
    }
    if (record.expiredAt !== undefined && record.expiredAt < now) {
      omittedExpired += 1
      omitted.push({ id: record.id, reason: 'expired', kind: record.kind, tags: tagsOf(record) })
      continue
    }
    active.push(record)
  }

  const ranked = rankForDigest(active, now)
  const selected                 = []
  const hintCandidates                 = []
  let tokens = estimateTokens(HEADER) + 4
  let omittedTopK = 0
  let omittedBudget = 0
  let budgetExhausted = false
  for (const record of ranked) {
    if (selected.length >= cfg.topK) {
      omittedTopK += 1
      hintCandidates.push(record)
      omitted.push({ id: record.id, reason: 'top_k', kind: record.kind, tags: tagsOf(record) })
      continue
    }
    if (budgetExhausted) {
      omittedBudget += 1
      hintCandidates.push(record)
      omitted.push({ id: record.id, reason: 'budget', kind: record.kind, tags: tagsOf(record) })
      continue
    }
    const line = digestLine(record)
    const cost = estimateTokens(line) + 1
    if (tokens + cost > cfg.tokenBudget) {
      budgetExhausted = true
      omittedBudget += 1
      hintCandidates.push(record)
      omitted.push({ id: record.id, reason: 'budget', kind: record.kind, tags: tagsOf(record) })
      continue
    }
    selected.push(record)
    tokens += cost
  }

  const hint = renderHintIndex(hintCandidates, cfg)
  const bodyText = selected.length > 0
    ? `${HEADER}\n${selected.map((record) => digestLine(record)).join('\n')}`
    : ''
  const text = [bodyText, hint.text].filter((part) => part !== null && part !== '').join('\n\n')
  if (text === '') return null

  const stats              = {
    candidates: records.length,
    active: active.length,
    injected: selected.length,
    omittedTopK,
    omittedBudget,
    omittedSuperseded,
    omittedExpired,
    omittedRules,
    truncated: omitted.length > 0,
    omitted,
    hint: {
      candidates: hintCandidates.length,
      injected: hint.injected,
      omittedTopK: hint.omittedTopK,
      omittedBudget: hint.omittedBudget,
      tokens: hint.tokens,
      budget: cfg.hintBudget,
      maxItems: cfg.hintMaxItems,
    },
    bodyIds: selected.map((record) => record.id),
    hintIds: hint.injectedIds,
    bodyEntries: selected.map((record) => ({ id: record.id, updatedAt: record.updatedAt })),
    hintEntries: hintCandidates
      .filter((record) => hint.injectedIds.includes(record.id))
      .map((record) => ({ id: record.id, updatedAt: record.updatedAt })),
  }

  return { text, tokens, count: selected.length, stats }
}

/** 兼容旧调用:只要文本。新代码应使用 renderDigest 以取得截断统计与 hintIds。 */
export function renderDigestBlock(
  records                         ,
  cfg                ,
  now = Date.now(),
)                      {
  return renderDigest(records, cfg, now)
}


//# sourceURL=source/memory-inject/src/digest.ts