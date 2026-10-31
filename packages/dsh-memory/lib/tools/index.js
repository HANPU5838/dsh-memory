/**
 * Tool implementations as plain data + functions. Keeping them free of both
 * cordis and dsh-tools imports lets us unit-test the exact argument/response
 * contracts standalone; the DSH entry (apply.ts) wraps them with defineTool.
 *
 * scope 语义(0.5.0 起):
 *   - 省略 scope:写 → 当前会话;读 → 会话 + 项目 + global 三路合并(provider 决定具体键);
 *   - 'global' / 'project' / 任意自定义名 / 'session:<id>' / 'project:<path>' 都是显式 pin;
 *   - 'all'(或 '*')只对读路径有效,写路径报 SCOPE_NOT_WRITABLE。
 * 解析全部交给 `memory-local/scope.ts` 的 normalizeScopeInput + provider 的
 * resolveReadScopes/resolveWriteScope —— 这里**不再**有任何"smoothing over"式的静默回退。
 */
                                             
import { isAbsolute, resolve } from 'node:path'
import { canonicalWorkspacePath, defaultScopeDescription, normalizeScopeInput, resolveScopeRef } from '../provider/scope.js'

/** Shape each tool shares: JSON-schema parameters + canonical output value. */
                                 
              
                     
                     
                                              
 

/** provider 的 getByIds 返回的记录形状（工具层只读这些字段）。 */
                                  
            
               
              
                 
                
                    
                   
                   
                    
                     
                     
                                     
                   
 

/** 范围外访问的处理方式(与 provider 的会话可见域一致)。 */
                                                            

/** 一次范围外审批的结局:允许一次 / 用户拒绝 / 超时未答 / 当前版本不支持审批。 */
                                                                                     

/**
 * 一次范围外审批的结论(0.21.0)。
 *
 * `allowed-once` 默认 = 本次请求**全部**允许;用户在审批卡里逐条勾选时，可带
 * `allowedIds` 只允许其中一部分。老 provider 可能仍直接返回字符串，工具层兼容。
 */
                                   
                          
                                                  
                       
 

/** provider 的 requestOutOfScope 可以返回裸字符串(旧口径)或带 allowedIds 的对象。 */
                                                               

/**
 * 被可见域挡住、没有返回给模型的原因。
 *   - out-of-scope = 普通限制下「作用域不在范围内」，检索默认不自动弹审批（0.27）;
 *   - rejected / timeout / unavailable / partial = 普通限制审批的结局;
 *   - absolute = 绝对限制下作用域根本不在范围内(0.23 起不再假装"不存在");
 *   - read-disabled = 作用域在范围内但「可读」开关被关掉(0.23)。
 */
                                                                                                                                                  

                                     
               
                                                 
                
                                 
                 
                           
                  
 

/**
 * provider 解析出的生效可见域。0.20.0 起 provider 永远返回一份策略:
 * 没有显式覆盖时是「会话 + 项目 + global」+ 普通限制,`source === 'default'`。
 * 老 provider 仍可能返回 undefined(视为不限制)。
 */
                                       
                        
                              
                                     
                                               
 

/** 一条范围外命中,交给审批浮层展示。 */
                                         
            
               
              
                 
                
                    
                   
                          
 

/**
 * 一个会话的上下文去重视图(0.21.0)。由入口从注入半边提供的
 * `memoryContextDedup` 服务接进来；没有时工具保持老行为(每次都带摘要)。
 *
 * 为什么要它：memory_search / memory_list 的摘要在同一会话里重复命中时
 * 会把同样的内容反复塞回上下文。工具层只问“这条是否已经以同版本出现过”，
 * 具体状态(摘要/正文/版本)由注入半边的 InjectionState 统一维护。
 */
                                   
                             
                                                                              
                             
                                                                              
                           
                                                                              
 

/**
 * 目录工具的一行（与 provider 的 ScopeCatalogEntry 同形）。
 * `absolute` 下范围外条目仍会出现，但 readable/writable/canRequest* 全为 false。
 */
                                        
               
               
                      
                                                     
                  
                  
                   
                   
                         
                          
                                                                                                  
                   
                                            
                    
                                           
                                                                                            
 

/** provider 统一授权判定的结果（0.24.0）。 */
                                     
                  
                 
                                          
                      
 

                                    
               
                                                  
               
 

/** 一条作用域权限申请的结果（0.24.0 / D3）。 */
                              
             
                     
                     
                     
                 
            
             
                          

                                           
               
                              
                          
                 
 

                                              
                                     
                                                                   
 

/** 只有这一层需要的能力子集(provider 在宿主里提供,测试里可以 mock)。 */
                                    
                                                              
                                                                                                                                                                                          
                                                                     
                                                                                                                                                              
                                     
                                  
                                                      
                                                                                                     
                                                               
                                                        
     
                                                          
     
                                                                                                        
     
                                          
                                 
     
                                                                                     
     
                              
                                                           
     
                                                                                                    
     
                                        
                                                   
     
                                              
                                                                                          
                   
                        
                        
                                          
                                              
                                                   
     
                                                
                                         
     
                                               
                                                               
                                                                     
     
                                                           
                                              
     
                                                          
                                       
                                                          
                                                          
                                                          
     
                                 
                                         
                                                  
                                                     
     
                                                                                                                                                                                                                        
                                         
                                             
                                    
                                                                     
     
                                                           
                                         
     
                                             
 

                                     
                                                                                 
                                             
                                                  
                                                 
                                                      
                       
     
                                   
                                                         
                              
     
                                                            
 

const SCOPE_DESCRIPTION =
  "省略=当前会话；'global'=所有项目共享；'project'=当前工作区；其他任意名称=自定义作用域"
  + "(memory_save 时不存在则自动创建；由 Agent 创建时必须同时提供 scopeDescription 说明用途)。"
  + "自定义作用域按裸名传（如 'dsh-plugin-dev'）；工具输出 / 摘要里看到的展示名 "
  + "'custom:<名字>' 会被自动归一成裸名，不用自己加前缀。"
  + "读取时可用 'all' 跨所有作用域。"

export class MemoryToolError extends Error {
           code        

  constructor(code        , message        ) {
    super(message)
    this.code = code
  }
}

function svc(opts                    )                    {
  const s = opts.getService()
  if (!s) throw new MemoryToolError('SERVICE_UNAVAILABLE', 'memory service is not loaded; check that dsh-memory-local is enabled')
  return s
}

function toolError(error         )                  {
  if (error instanceof MemoryToolError) return error
  const code = (error                                  )?.code
  const message = error instanceof Error ? error.message : String(error)
  return new MemoryToolError(typeof code === 'string' ? code : 'MEMORY_ERROR', message)
}

/** 供 apply.ts 使用的实例内 agent(宿主 exec.agent)。 */
function agentOf(exec         )          {
  return (exec                                   )?.agent
}

/**
 * agent → 会话 id(只给需要"这是谁改的"的元数据写入用,如作用域用途的 createdBy)。
 * 与 provider 的 rawSessionIdOf 同口径:header.id 优先,其次 session.id。
 */
function sessionIdOf(agent         )                     {
  try {
    const session = (agent                                                                         )?.session
    const id = session?.header?.id ?? session?.id
    return typeof id === 'string' && id !== '' ? id : undefined
  } catch {
    return undefined
  }
}

/**
 * 当前项目 key。优先级:**服务端解析的会话 cwd** → 显式配置 → process.cwd()。
 *
 * 服务端那一步不能省:DSH 服务进程的 process.cwd() 是 profile 目录,只有
 * `session.header.cwd` 才是工作区;而 mock / 旧 provider 没有 `projectKeyFor` 时,
 * 只能退回配置与 process.cwd()(与旧行为一致,不把测试和旧宿主打断)。
 */
function projectKey(opts                    , service                    , agent          )              {
  const resolved = service?.projectKeyFor?.(agent)
  if (typeof resolved === 'string' && resolved.length > 0) return resolved               
  return (opts.projectScope ?? `project:${process.cwd()}`)               
}

/**
 * 显式「可见范围」白名单;undefined = 本会话没有显式覆盖(注入半边用它判断
 * 要不要关掉 extraScopes,工具层不用它做读限制 —— 那是 visibilityPolicy 的事)。
 * provider 方法抛错时按"没有覆盖"处理:可见范围是防越界,不应该让一个 provider
 * 内部错误把所有读取都锁死。
 */
function visibleScopeList(service                   , agent         )                            {
  try {
    const explicit = service.visibleScopes?.(agent)
    if (Array.isArray(explicit)) return [...new Set(explicit)]
  } catch { /* 降级为不限制 */ }
  return undefined
}

/**
 * 完整可见域;老 provider / 解析失败时退化为 undefined(不限制)。
 * 0.20 的 provider 永远返回策略:没有显式覆盖时是默认策略(source='default'),
 * 默认范围 = 会话 + 项目 + global,等级 = normal。
 */
function visibilityPolicy(service                   , agent         )                                   {
  try {
    const policy = service.visibilityPolicy?.(agent)
    if (policy !== undefined && policy !== null) {
      const level                  = policy.level === 'absolute' || policy.level === 'none' ? policy.level : 'normal'
      const source = policy.source === 'explicit' || policy.source === 'inherited' || policy.source === 'default'
        ? policy.source
        : undefined
      return {
        level,
        scopes: Array.isArray(policy.scopes) ? policy.scopes : [],
        ...(source !== undefined ? { source } : {}),
      }
    }
  } catch { /* 降级为不限制 */ }
  return undefined
}

/** 是否"用户显式设过的策略"(默认策略不算):决定普通限制下要不要把范围外也搜一遍。 */
function explicitPolicy(policy                                  )          {
  return policy !== undefined && policy.source !== 'default'
}

function scopeInPolicy(policy                                  , scope        )          {
  if (policy === undefined || policy.level === 'none') return true
  return policy.scopes.some((rule) => rule.scope === scope)
}

/** 该 scope 的规则;不在策略里时 undefined(等于范围外)。 */
function policyRule(policy                                  , scope        )                                 {
  if (policy === undefined || policy.level === 'none') return undefined
  return policy.scopes.find((item) => item.scope === scope)
}

/** 这条记录是否在可见域内(旧 provider 的纯策略回退;新 provider 走 authorize)。 */
function legacyRecordAllowed(policy                                  , scope        , kind        )          {
  if (policy === undefined || policy.level === 'none') return true
  const rule = policyRule(policy, scope)
  if (rule === undefined || rule.read === false) return false
  return rule.kinds === undefined || rule.kinds.length === 0 || rule.kinds.includes(kind)
}

/** 记录在可见域外时,是"整个 scope 不可见"还是"只是类型不允许"。 */
function outsideReason(policy                                  , scope        )                   {
  return scopeInPolicy(policy, scope) ? 'kind' : 'scope'
}

/** provider 的授权判定器;老 provider / 拿不到会话时返回 undefined(走回退)。 */
                     
                                                   
                
                
                                   

function decisionMaker(service                   , agent         )               {
  if (agent === undefined) return () => undefined
  try {
    const evaluator = service.accessEvaluator?.(agent)
    if (typeof evaluator === 'function') {
      return (action, scope, kind) => {
        try {
          return evaluator({ scope, action, ...(kind !== undefined ? { kind } : {}) })
        } catch {
          return undefined
        }
      }
    }
  } catch { /* 回退到纯策略判定 */ }
  return () => undefined
}

/** 读权限:优先 provider 的统一判定,老 provider 用纯策略回退。 */
function recordAllowed(
  decide              ,
  policy                                  ,
  scope        ,
  kind        ,
)          {
  const decision = decide('read', scope, kind)
  return decision !== undefined ? decision.allowed : legacyRecordAllowed(policy, scope, kind)
}

/** 这条被挡住的读能不能申请审批;absolute 与显式 read:false 都不能。 */
function recordRequestable(
  decide              ,
  policy                                  ,
  scope        ,
  kind        ,
)          {
  const decision = decide('read', scope, kind)
  if (decision !== undefined) return !decision.allowed && decision.requestable
  return policy?.level === 'normal' && policyRule(policy, scope) === undefined
}

/** 写权限:优先 provider 的统一判定,老 provider 用纯策略回退。 */
function scopeWritableBy(
  decide              ,
  service                   ,
  agent         ,
  policy                                  ,
  scope        ,
)          {
  const decision = decide('write', scope)
  if (decision !== undefined) return decision.allowed
  return scopeWritable(service, agent, policy, scope)
}

/** 单条读被挡住的原因(给 withheld 用)。 */
function readDenyReason(
  decide              ,
  policy                                  ,
  scope        ,
  kind        ,
)                 {
  const decision = decide('read', scope, kind)
  switch (decision?.reason) {
    case 'ABSOLUTE_ISOLATION': return 'absolute'
    case 'SCOPE_DISABLED': return 'scope-disabled'
    case 'READ_DISABLED': return 'read-disabled'
    case 'KIND_NOT_ALLOWED': return 'read-disabled'
    case 'SCOPE_NOT_IN_RANGE': return policy?.level === 'absolute' ? 'absolute' : 'read-disabled'
  }
  return policy?.level === 'absolute' ? 'absolute' : 'read-disabled'
}

/** 范围被挡住时给模型的原因:审批结局优先,否则按实际拒绝原因聚合。 */
function withheldReasonFor(
  decide              ,
  policy                                  ,
  denied                                                ,
  verdict                             ,
)                             {
  if (verdict !== undefined) return verdict.outcome === 'allowed-once' ? 'partial' : verdict.outcome
  if (denied.length === 0) return undefined
  const reasons = denied.map((item) => readDenyReason(decide, policy, item.scope, item.kind))
  if (reasons.includes('absolute')) return 'absolute'
  if (reasons.includes('scope-disabled')) return 'scope-disabled'
  return 'read-disabled'
}

/**
 * 0.27.0：普通限制下**没有发起审批**的范围外命中给模型的原因。
 * 与 withheldReasonFor 的差别：「整个作用域不在范围内」（普通限制下本可审批、
 * 现在只给索引）不再报成 read-disabled，而是 'out-of-scope'；
 * absolute / read-disabled / scope-disabled 照旧如实聚合。
 */
function outOfScopeReason(
  decide              ,
  policy                                  ,
  denied                                                ,
)                             {
  if (denied.length === 0) return undefined
  const reasons = denied.map((item) => readDenyReason(decide, policy, item.scope, item.kind))
  if (reasons.includes('absolute')) return 'absolute'
  if (reasons.includes('scope-disabled')) return 'scope-disabled'
  // readDenyReason 把「SCOPE_NOT_IN_RANGE + 普通限制」也归成 read-disabled；
  // 这里按"作用域是否在范围里"细分：不在范围 = out-of-scope（可申请）。
  const hasOutOfScope = denied.some((item) => !scopeInPolicy(policy, item.scope))
  return hasOutOfScope ? 'out-of-scope' : 'read-disabled'
}

/**
 * memory_save 的 supersedes 参数说明(模型可见)。
 * 检索 / 列表 / 摘要 / 规则索引里给的 id 都是 8 位短 id,而 supersedes 在 provider
 * 里是**按 id 精确查找**(records.get(id)),传短 id 只会得到 SUPERSEDES_UNKNOWN。
 * 所以必须明确要求「完整 id」,并给出拿完整 id 的路径(memory_get 首行就是完整 id)。
 */
const SUPERSEDES_PARAM_DESCRIPTION =
  '被这条新记忆修正 / 替换掉的旧记录 id。必须传**完整 id**(36 位 UUID),不能传 memory_search / memory_list / 摘要 / 规则索引里显示的 8 位短 id;手头只有短 id 时先用 memory_get 取回 —— 它结果里每段首行的 [id] 就是完整 id。旧记录会被标记为「已修正」,默认不再出现在检索、规则和自动召回里,但 memory_get 仍能查到。'

/** memory_* 的 description 参数说明(模型可见)。 */
const DESCRIPTION_PARAM_DESCRIPTION =
  '本次调用要做什么（一句话，给用户看）。本会话「记忆范围」为普通限制时必填：审批范围外记忆时，弹窗会把它展示给用户。'

/**
 * 把模型的 description 收拾成一行(审批弹窗里展示)。
 * 省略/空白 = undefined(是否合法由 requireDescription 按限制等级判断)。
 */
function descriptionOf(raw         )                     {
  if (typeof raw !== 'string') return undefined
  const value = raw.replace(/\s+/g, ' ').trim()
  return value === '' ? undefined : value.slice(0, 500)
}

/**
 * 「记忆范围」为普通限制时,memory_* 必须写 description:审批弹窗要把 Agent 的
 * 意图展示给用户,只有工具名 + 查询词不够判断该不该放行。
 *
 * 拿不到会话(老宿主 / 测试 mock / 面板直调)时不强制 —— 没有会话就没有审批弹窗;
 * absolute / none 也不强制(前者范围外一律视为不存在,后者不需要审批)。
 */
function requireDescription(service                   , agent         , raw         )       {
  if (agent === undefined) return
  const policy = visibilityPolicy(service, agent)
  if (policy === undefined || policy.level !== 'normal') return
  if (descriptionOf(raw) !== undefined) return
  throw new MemoryToolError(
    'DESCRIPTION_REQUIRED',
    '本会话「记忆范围」为普通限制：调用 memory_* 工具时必须提供 description 字段，用一句话说明这次调用要做什么（审批范围外记忆时弹窗会展示给用户）。',
  )
}

function recordsToApprovalItems(
  policy                                  ,
  records                                                                                                                                  ,
)                           {
  return records.map((record) => ({
    id: record.id,
    scope: record.scope,
    kind: record.kind,
    content: record.content,
    tags: Array.isArray(record.tags) ? record.tags : [],
    importance: typeof record.importance === 'number' ? record.importance : 0,
    updatedAt: record.updatedAt,
    reason: outsideReason(policy, record.scope),
  }))
}

/**
 * 普通限制:把范围外访问交给用户审批一次。
 * 结局必须可区分:允许一次 / 用户拒绝 / 超时 / 旧 provider 不支持审批。
 * `agent` 省略 = 不审批(工具层在拿不到会话时退回 provider 的护栏)。
 * 允许写/删时要带 `approvedItems` 之类的合成条目,浮层才显示得出来。
 *
 * 0.21.0:允许的条目可以是"全部"(allowedIds 省略)或用户在审批卡里逐条勾选的
 * 一部分;后者通过 `allowedIds` 返回,调用方只放行这些 id。
 */
                           
                          
                                              
                          
 

async function askOutOfScope(
  service                   ,
  agent         ,
  policy                                  ,
  tool        ,
  query        ,
  records                                                                                                                                  ,
  action                             ,
  signal              ,
  description         ,
)                           {
  if (records.length === 0) return { outcome: 'allowed-once' }
  if (typeof service.requestOutOfScope !== 'function') return { outcome: 'unavailable' }
  if (signal?.aborted) return { outcome: 'rejected' }
  try {
    const answer = await service.requestOutOfScope(agent, {
      tool,
      action,
      query,
      ...(description !== undefined ? { description } : {}),
      items: recordsToApprovalItems(policy, records),
      ...(signal !== undefined ? { signal } : {}),
    })
    // 老 provider 直接返回字符串;新 provider 返回 { outcome, allowedIds }。
    const decision                   = typeof answer === 'string' ? { outcome: answer } : answer ?? { outcome: 'unavailable' }
    const outcome                  = decision.outcome === 'allowed-once' || decision.outcome === 'timeout' || decision.outcome === 'unavailable'
      ? decision.outcome
      : 'rejected'
    const ids = outcome === 'allowed-once' && Array.isArray(decision.allowedIds)
      ? new Set(decision.allowedIds.map(String))
      : undefined
    // 逐条勾选但一条都没选中 = 用户拒绝了这次访问。
    if (ids !== undefined && ids.size === 0) return { outcome: 'rejected' }
    return { outcome, ...(ids !== undefined ? { allowedIds: ids } : {}) }
  } catch {
    return { outcome: 'unavailable' }
  }
}

/** 这次审批是否允许这一条(没有 allowedIds = 全部允许)。 */
function verdictAllows(verdict                 , id        )          {
  if (verdict.outcome !== 'allowed-once') return false
  return verdict.allowedIds === undefined || verdict.allowedIds.has(id)
}

/** 审批没通过时给模型的真实原因(写/删路径直接抛这个错误)。 */
function visibilityError(outcome                , action                    , scope        )                  {
  const verb = action === 'write' ? '写入' : '删除'
  if (outcome === 'rejected') {
    return new MemoryToolError(
      'VISIBILITY_REJECTED',
      `用户拒绝了本次${verb}请求（作用域 ${scope}，当前限制等级：普通限制），没有执行。如需${verb}，请让用户调整「记忆范围」后重试。`,
    )
  }
  if (outcome === 'timeout') {
    return new MemoryToolError(
      'VISIBILITY_TIMEOUT',
      `等待用户审批超时（5 分钟没有答复），本次${verb}没有执行（作用域 ${scope}，当前限制等级：普通限制）。`,
    )
  }
  return new MemoryToolError(
    'VISIBILITY_UNAVAILABLE',
    `当前环境无法就范围外访问发起审批，本次${verb}没有执行（作用域 ${scope}）。`,
  )
}

/** 写入/删除被「可写」开关或绝对限制挡住时给模型的真实原因。 */
function scopeWriteBlockedError(policy                                  , scope        , action                    )                  {
  const verb = action === 'write' ? '写入' : '删除'
  const rule = policyRule(policy, scope)
  if (rule !== undefined && rule.write === false) {
    return new MemoryToolError(
      'SCOPE_READ_ONLY',
      `作用域 ${scope} 在本会话记忆范围里被标记为「不可写」（可读/可写按钮），本次${verb}没有执行。如需${verb}，请让用户打开该作用域的「可写」状态。`,
    )
  }
  return new MemoryToolError(
    'VISIBILITY_ABSOLUTE',
    `作用域 ${scope} 不在本会话可见范围内（限制等级：绝对限制），本次${verb}没有执行。如需${verb}，请让用户调整「记忆范围」后重试。`,
  )
}

/** 按 id 删除时,记录存在但被可见域挡住的原因(绝对限制 / 不可写)。 */
function blockedRecordError(policy                                  , scope        , id        )                  {
  const rule = policyRule(policy, scope)
  if (rule !== undefined && rule.write === false) {
    return new MemoryToolError(
      'SCOPE_READ_ONLY',
      `记忆 ${id} 所在作用域 ${scope} 在本会话记忆范围里被标记为「不可写」，本次删除没有执行。如需删除，请让用户打开该作用域的「可写」状态。`,
    )
  }
  return new MemoryToolError(
    'VISIBILITY_ABSOLUTE',
    `记忆 ${id} 不在本会话可见范围内（限制等级：绝对限制），本次删除没有执行。如需删除，请让用户调整「记忆范围」后重试。`,
  )
}

/** 按 id 删除时,记录存在但被 provider 的授权判定挡住的原因。 */
function blockedRecordDecisionError(decision                    , scope        , id        )                  {
  if (decision.reason === 'WRITE_DISABLED') {
    return new MemoryToolError(
      'SCOPE_READ_ONLY',
      `记忆 ${id} 所在作用域 ${scope} 在本会话记忆范围里被标记为「不可写」，本次删除没有执行。如需删除，请让用户打开该作用域的「可写」状态。`,
    )
  }
  if (decision.reason === 'SCOPE_DISABLED') {
    return new MemoryToolError('SCOPE_DISABLED', `记忆 ${id} 所在作用域 ${scope} 已被配置关闭，本次删除没有执行。`)
  }
  return new MemoryToolError(
    'VISIBILITY_ABSOLUTE',
    `记忆 ${id} 不在本会话可见范围内（限制等级：绝对限制），本次删除没有执行。如需删除，请让用户调整「记忆范围」后重试。`,
  )
}

/** 写入/删除被 provider 的授权判定挡住时给模型的真实原因。 */
function writeDecisionError(decision                    , scope        , action                    )                  {
  const verb = action === 'write' ? '写入' : '删除'
  if (decision.reason === 'WRITE_DISABLED') {
    return new MemoryToolError(
      'SCOPE_READ_ONLY',
      `作用域 ${scope} 在本会话记忆范围里被标记为「不可写」（可读/可写按钮），本次${verb}没有执行。如需${verb}，请让用户打开该作用域的「可写」状态。`,
    )
  }
  if (decision.reason === 'SCOPE_DISABLED') {
    return new MemoryToolError('SCOPE_DISABLED', `作用域 ${scope} 已被配置关闭，本次${verb}没有执行。`)
  }
  return new MemoryToolError(
    'VISIBILITY_ABSOLUTE',
    `作用域 ${scope} 不在本会话可见范围内（限制等级：绝对限制），本次${verb}没有执行。如需${verb}，请让用户调整「记忆范围」后重试。`,
  )
}

/** 写入/删除前判断一个 scope 是否可写(0.23 起独立于 read 开关)。 */
function scopeWritable(service                   , agent         , policy                                  , scope        )          {
  if (policy === undefined || policy.level === 'none') return true
  try {
    const verdict = service.isScopeWritable?.(agent, scope) ?? service.isScopeOperable?.(agent, scope)
    if (typeof verdict === 'boolean') return verdict
  } catch { /* 退回本地判断 */ }
  const rule = policyRule(policy, scope)
  return rule !== undefined && rule.write !== false
}

/** 规范里所有已知 scope(用来在普通限制下把范围外也搜一遍,看看有没有可审批的命中)。 */
function allKnownScopes(service                   )                {
  try {
    service.discoverScopes?.()
    return [...new Set((service.scopeStats?.() ?? []).map((item) => item.scope))]
  } catch {
    return []
  }
}

/** 该服务/配置下"当前会话 + 当前项目 + global"的合并读取集合(去重)。 */
function readScopes(opts                    , service                   , agent         )                {
  // 显式可见范围优先,空数组也要原样返回(表示什么都不允许读)。
  const explicit = visibleScopeList(service, agent)
  if (explicit !== undefined) return explicit
  const provided = service.resolveReadScopes?.(agent)
  if (Array.isArray(provided) && provided.length > 0) return [...new Set(provided)]
  // 服务没提供(测试 mock / 旧 provider):退回 defaultScope 口径
  const fallback = opts.defaultScope === 'global' ? 'global' : projectKey(opts, service, agent)
  return [...new Set([fallback, 'global'])]
}

/**
 * 当前会话的 scope 键(拿不到会话就 undefined)。给显式写成裸 `session` 的
 * 请求兜底 —— `resolveScope` 在读路径上会把它解析成"合并集合",申请权限时必须
 * 落到一个具体键。
 */
function currentSessionScope(service                   , exec         )                          {
  return service.resolveReadScopes?.(agentOf(exec))?.find((scope) => scope.startsWith('session:'))
}

/** 写路径默认口径;provider 不支持时退回 project。 */
function writeDefault(opts                    )                                   {
  return opts.defaultScope ?? 'session'
}

/** 规范化 + 落到具体 key(或 all)。 */
function resolveScope(
  opts                    ,
  service                   ,
  exec         ,
  raw                    ,
  mode                  ,
)                                         {
  const normalized = normalizeScopeInput(raw)
  if (!normalized.ok) throw new MemoryToolError('SCOPE_INVALID', normalized.message)
  if (normalized.kind === 'global') return { scope: 'global' }
  const agent = agentOf(exec)
  const project = projectKey(opts, service, agent)
  // 当前会话 key 由 provider 解析(只有它知道 scopes.session 开关与子代理共享父会话的规则);
  // provider 不在(测试 mock / 旧版本)时不给 session —— 写路径会回退 project,读路径回到合并集合。
  const session = service.resolveReadScopes?.(agent)?.find((s) => s.startsWith('session:'))
  const refs = { project, ...(session !== undefined ? { session } : {}) }
  const resolved = resolveScopeRef(normalized, refs, {
    mode,
    defaultScope: writeDefault(opts),
    // provider 的合并集合里没有会话 scope ⇒ scopes.session 关着(或拿不到会话);此时
    // 省略 scope 要干净地回退项目 scope,而不是撞 SCOPE_DISABLED。provider 根本没提供
    // 合并集合(测试 mock / 只实现 save 的旧 provider)时不带这一项:交给它的 save 兜底。
    ...(service.resolveReadScopes !== undefined ? { sessionEnabled: session !== undefined } : {}),
  })
  if (!resolved.ok) throw new MemoryToolError(resolved.code, resolved.message)
  if (resolved.all) return { all: true }
  return resolved.scope !== undefined ? { scope: resolved.scope } : {}
}

                           
                 
                
                                                        
               
               
                 
                     
                                                
                     
                                                 
                    
                                         
                
                                                    
                     
     
                                 
                              
     
                           
                                           
                    
                                      
                      
 

                             
            
               
                            
                    
                  
 

/**
 * `path` → 绝对工作区路径。相对路径按会话 cwd 解析（拿不到就按进程 cwd），
 * 再走 `canonicalWorkspacePath` 统一写法 —— 同一个目录必须只有一种 scope 键，
 * 否则 `project:<路径>` 会分叉（`D:/x` 与 `D:\x` 曾是两个 scope，见 0.11.1）。
 */
function resolveWorkspacePath(raw        , agent         )         {
  const value = raw.trim()
  if (value === '') throw new MemoryToolError('PATH_INVALID', 'path 不能为空')
  const cwd = (agent                                                            )?.session?.header?.cwd
  const base = typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd()
  return canonicalWorkspacePath(isAbsolute(value) ? value : resolve(base, value))
}

export function memorySaveTool(opts                    )                                 {
  return {
    name: 'memory_save',
    description: 'Save a durable memory (fact, decision, preference, procedure, rule, state) for future sessions.',
    parameters: {
      content: { type: 'string', description: 'Self-contained declarative sentence, readable without context', required: true },
      scope: { type: 'string', description: `${SCOPE_DESCRIPTION};配合 path 时表示该工作区作用域的显示名（别名）` },
      path: { type: 'string', description: '工作区目录路径；给出后写入 project:<路径>，此时 scope 用作该作用域的显示名（别名，可省略 = 用路径本身）' },
      kind: { type: 'string', enum: ['fact', 'decision', 'preference', 'procedure', 'note', 'rule', 'state'] },
      tags: { type: 'array', items: { type: 'string' } },
      importance: { type: 'number', description: '0~1, higher = more important' },
      supersedes: { type: 'string', description: SUPERSEDES_PARAM_DESCRIPTION },
      expiresAt: { type: 'number', description: '过期时间(毫秒时间戳)。kind=state 不传时按设置里的默认 TTL(7 天)' },
      ttlMs: { type: 'number', description: '相对有效期(毫秒)。与 expiresAt 二选一，expiresAt 优先' },
      triggers: { type: 'array', items: { type: 'string' }, description: '流程触发词(kind=procedure)：工具名/关键词/路径；缺省用 tags' },
      scopeDescription: { type: 'string', description: '新建自定义作用域时必填：一句话说明这个作用域用来做什么（已有作用域带上它 = 更新用途）' },
      scopeRule: { type: 'string', description: '初始化时可选写一条初始规则(kind=rule)：只对新自定义作用域生效，用于约定该作用域只记录什么、不记录什么' },
      description: { type: 'string', description: DESCRIPTION_PARAM_DESCRIPTION },
    },
    async execute(args          , exec          )                      {
      const service = svc(opts)
      const agent = agentOf(exec)
      requireDescription(service, agent, args.description)
      if (typeof args.content !== 'string' || args.content.trim().length === 0) {
        throw new MemoryToolError('CONTENT_EMPTY', 'content must be a non-empty string')
      }
      if (args.importance !== undefined && (args.importance < 0 || args.importance > 1)) {
        throw new MemoryToolError('IMPORTANCE_RANGE', 'importance must be between 0 and 1')
      }
      const content = args.content.trim()
      // 写路径:省略 scope → provider 按 tools.defaultScope(缺省 session,拿不到会话回退
      // project)。默认值的最终权威是 provider 的 `save` —— 省略时干脆不带 scope 字段,
      // 但要把会话上下文(exec.agent)带过去,否则它没法知道"当前会话"是谁。
      const requested = args.scope?.trim()
      const pathArg = typeof args.path === 'string' ? args.path.trim() : ''

      let explicit                    
      let alias                    
      if (pathArg !== '') {
        // path 给出 = 项目作用域;scope 此时是它的显示名,不再当 scope 选择器用。
        if (requested !== undefined && requested !== '' && requested !== 'project') {
          if (requested === 'global' || requested === 'session' || requested === 'all') {
            throw new MemoryToolError('PATH_SCOPE_CONFLICT', `path 只能配合项目作用域使用,不能再指定 scope="${requested}"`)
          }
          alias = requested
        }
        explicit = `project:${resolveWorkspacePath(pathArg, agent)}`
      } else {
        const resolved = requested === undefined || requested === ''
          ? undefined
          : resolveScope(opts, service, exec, requested, 'write').scope
        if (requested !== undefined && requested !== '' && resolved === undefined) {
          throw new MemoryToolError('SCOPE_INVALID', 'scope could not be resolved')
        }
        explicit = resolved
      }

      // 写入护栏（0.20.0 / 0.23.0）：write 开关与范围等级分开判断。
      //   - 作用域在范围内但「可写」关掉 → 直接拒绝并说明开关;
      //   - absolute 且作用域不在范围内 → 直接拒绝并说明绝对限制;
      //   - normal 且作用域不在范围内 → 先向用户审批一次,拒绝/超时讲真实原因;
      //   - none → 不限制。
      // 拿不到会话(老宿主 / 无 exec)时不判断:没有会话就没有"本会话的可见域"。
      const policy = agent === undefined ? undefined : visibilityPolicy(service, agent)
      const decide = decisionMaker(service, agent)
      const level = policy?.level ?? 'none'
      const target = explicit ?? (typeof service.resolveWriteScope === 'function' ? service.resolveWriteScope(agent) : undefined)
      let approved = false
      if (level !== 'none' && target !== undefined && !scopeWritableBy(decide, service, agent, policy, target)) {
        const decision = decide('write', target)
        if (decision !== undefined) {
          // provider 已经给出统一判定：不可申请就直接讲原因（absolute / 关闭 / 只读）。
          if (!decision.requestable) throw writeDecisionError(decision, target, 'write')
        } else if (policyRule(policy, target) !== undefined || level === 'absolute') {
          // 老 provider 没有授权判定时保持原有纯策略判断。
          throw scopeWriteBlockedError(policy, target, 'write')
        }
        const draft = {
          id: 'new-record',
          scope: target,
          kind: args.kind ?? 'note',
          content: content,
          tags: Array.isArray(args.tags) ? args.tags : [],
          importance: typeof args.importance === 'number' ? args.importance : 0,
          updatedAt: Date.now(),
        }
        const verdict = await askOutOfScope(
          service,
          agent,
          policy,
          'memory_save',
          summarize(content, 80),
          [draft],
          'write',
          (exec                                        )?.signal,
          descriptionOf(args.description),
        )
        if (!verdictAllows(verdict, draft.id)) {
          throw visibilityError(verdict.outcome === 'allowed-once' ? 'rejected' : verdict.outcome, 'write', target)
        }
        approved = true
      }

      try {
        const record = await service.save({
          ...(explicit !== undefined ? { scope: explicit } : {}),
          ...(alias !== undefined ? { name: alias } : {}),
          ...(agent !== undefined ? { agent } : {}),
          ...(approved ? { visibilityApproved: true } : {}),
          kind: args.kind ?? 'note',
          content: content,
          ...(args.tags ? { tags: args.tags } : {}),
          ...(args.importance !== undefined ? { importance: args.importance } : {}),
          ...(args.supersedes ? { supersedes: args.supersedes } : {}),
          ...(typeof args.expiresAt === 'number' ? { expiresAt: args.expiresAt } : {}),
          ...(typeof args.ttlMs === 'number' ? { ttlMs: args.ttlMs } : {}),
          ...(Array.isArray(args.triggers) ? { triggers: args.triggers.map(String) } : {}),
          ...(typeof args.scopeDescription === 'string' && args.scopeDescription.trim() !== ''
            ? { scopeDescription: args.scopeDescription }
            : {}),
          ...(typeof args.scopeRule === 'string' && args.scopeRule.trim() !== ''
            ? { scopeRule: args.scopeRule }
            : {}),
          source: { origin: 'explicit' },
        })
        return { id: record.id, scope: record.scope, ...(alias !== undefined ? { scopeName: alias } : {}), deduped: false }
      } catch (error) {
        throw toolError(error)
      }
    },
  }
}

/** memory_search / memory_get(summary) 的默认摘要长度（字符）。 */
export const DEFAULT_SUMMARY_CHARS = 160

/** 摘要字数上限：默认 160，允许调用方在 20~2000 之间调整。 */
export function resolveSummaryChars(value         )         {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return DEFAULT_SUMMARY_CHARS
  return Math.min(2000, Math.max(20, Math.round(n)))
}

/** 空白折叠 + 截断。memory_search 的“少量摘要”和 memory_get 的 summary 字段共用。 */
export function summarize(content        , chars         = DEFAULT_SUMMARY_CHARS)         {
  const flat = String(content).replace(/\s+/g, ' ').trim()
  return flat.length <= chars ? flat : `${flat.slice(0, chars)}…`
}

/**
 * memory_search 的上下文去重(0.21.0):
 *   - 同一条记忆、同一个 updatedAt 版本已经出现在上下文里 → 摘要置空并标 deduped;
 *   - 没出现过的（含内容更新后的新版本）→ 照常带摘要，并记为“摘要已出现”。
 * 注入半边不在时 `contextDedup` 返回 undefined，保持老行为。
 */
function applySummaryDedupe(opts                    , exec         , records             )       {
  if (records.length === 0) return
  const dedup = opts.contextDedup?.(exec)
  if (dedup === undefined) return
  const seen = dedup.seen(records)
  const newlyShown              = []
  for (const record of records) {
    if (seen.has(record.id)) {
      record.summary = ''
      record.deduped = true
    } else {
      newlyShown.push(record)
    }
  }
  // 只把这次真的带摘要返回的条目记为已出现;被省略的本来就是已出现。
  if (newlyShown.length > 0) dedup.markSummary(newlyShown)
}

                             
               
                
               
                                                 
                             
                          
                       
                                      
                      
     
                                              
                                              
                                          
     
                           
 

                            
            
               
               
              
                
                   
                                           
                 
     
                                      
                           
     
                   
 

/**
 * 0.28.0：范围外命中的**作用域级**索引——只给「命中了哪个作用域、几条、这个作用域
 * 是干什么的」，**不再给条目摘要**。
 *
 * 为什么收窄：0.27.0 的条目索引会带短摘要，模型很容易把那段摘要当成「已经读到的东西」
 * 直接引用；而它其实是可见域外的内容。现在范围外只暴露作用域用途，模型据此判断
 * 要不要为某个作用域显式发起审批（requestApproval / memory_scopes request）。
 */
                                       
               
                 
                                             
                     
                                                 
                      
 

                               
                      
     
                                       
                                          
     
                                                      
     
                                          
                         
     
                                                 
 

/**
 * 范围外清单要展示的作用域用途：优先取 provider 目录里手写过的 description，
 * 拿不到（旧 provider / 目录里没有这个 scope）时按类型给默认描述。
 */
function scopeDescriptions(service                   , agent         )                      {
  const out = new Map                ()
  if (typeof service.scopeCatalog !== 'function') return out
  try {
    for (const entry of service.scopeCatalog(agent)) {
      const description = typeof entry.description === 'string' ? entry.description.trim() : ''
      if (description !== '') out.set(entry.scope, description)
    }
  } catch {
    // 目录是增强：拿不到就退回类型默认描述，不让检索因此失败。
  }
  return out
}

export function memorySearchTool(opts                    )                                     {
  return {
    name: 'memory_search',
    description: 'Search saved memories by keyword or meaning (lexical + local vector recall). Returns id/scope/kind/tags and a short summary; use memory_get for full content. Out-of-scope hits return only the list of scopes (name, hit count, purpose — no record summaries) in the outOfScope field instead of auto-raising approval; pass requestApproval=true only when those scopes are genuinely relevant.',
    parameters: {
      query: { type: 'string', required: true },
      scope: { type: 'string', description: SCOPE_DESCRIPTION },
      topK: { type: 'number', description: '1~20' },
      includeSuperseded: { type: 'boolean', description: '默认 false；true 时把已被 supersede 的旧版本也返回（历史核对）' },
      summaryChars: { type: 'number', description: `每条摘要的字数上限（默认 ${DEFAULT_SUMMARY_CHARS}，20~2000）` },
      description: { type: 'string', description: DESCRIPTION_PARAM_DESCRIPTION },
      requestApproval: { type: 'boolean', description: '默认 false：范围外命中只返回作用域清单（scope + 条数 + 用途，不含任何记忆内容），不自动弹审批；true = 立即向用户发起审批，允许的条目并入 records。确认这些作用域的用途确实与本次任务相关后再传 true。' },
    },
    async execute(args            , exec          )                        {
      const service = svc(opts)
      const agent = agentOf(exec)
      requireDescription(service, agent, args.description)
      if (typeof args.query !== 'string' || args.query.trim().length === 0) {
        throw new MemoryToolError('QUERY_EMPTY', 'query must be a non-empty string')
      }
      const resolved = resolveScope(opts, service, exec, args.scope, 'read')
      const policy = visibilityPolicy(service, agent)
      const decide = decisionMaker(service, agent)
      const level = policy?.level ?? 'none'
      // level=none 时策略里的 scopes 只是偏好,不参与限制(等价于没有可见域)。
      const visible = policy !== undefined && policy.level !== 'none' ? policy.scopes.map((rule) => rule.scope) : undefined
      // 用户显式设过的策略(absolute / normal)才把磁盘上其它 scope 也搜一遍:
      // 既为普通限制找"可审批的命中",也让绝对限制能告诉 Agent「有几条被挡住」。
      // 默认策略不主动外扩,避免普通检索每次都扫全盘/弹审批。
      const expand = explicitPolicy(policy) && level !== 'none'
      let scopes                           
      if (resolved.all) {
        if (visible !== undefined) {
          // 'all' 在有可见范围限制时只等于"所有可见范围",不是磁盘上的全部 scope。
          // 但显式 'all' 本身就表达"跨作用域",所以仍把磁盘上其它 scope 搜一遍:
          // 普通限制据此发起审批,绝对限制据此告诉 Agent 被挡住了几条。
          scopes = [...new Set([...visible, ...allKnownScopes(service)])]
        } else {
          scopes = allKnownScopes(service)
        }
      } else if (resolved.scope === undefined) {
        // 省略 scope:三路合并(会话 + 项目 + global),或显式可见范围。
        const merged = readScopes(opts, service, agent)
        scopes = expand ? [...new Set([...merged, ...allKnownScopes(service)])] : merged
      }
      const chars = resolveSummaryChars(args.summaryChars)
      try {
        const wantedTopK = args.topK !== undefined ? Math.min(20, Math.max(1, args.topK)) : undefined
        const hits = await service.search({
          text: args.query,
          ...(resolved.scope !== undefined ? { scope: resolved.scope } : {}),
          ...(scopes !== undefined ? { scopes } : {}),
          // 多取一些候选,避免范围外命中挤掉范围内的结果。
          topK: Math.min(60, Math.max(10, (wantedTopK ?? 10) * 3)),
          ...(args.includeSuperseded === true ? { includeSuperseded: true } : {}),
        })
        const inside = hits.filter((hit) => recordAllowed(decide, policy, hit.record.scope, hit.record.kind))
        const outside = hits.filter((hit) => !recordAllowed(decide, policy, hit.record.scope, hit.record.kind))
        // 只有“作用域不在范围里”才可能审批;absolute 与 read:false 都不 requestable。
        const needsApproval = outside.filter((hit) => recordRequestable(decide, policy, hit.record.scope, hit.record.kind))
        // 0.27.0：普通限制下范围外命中**不再自动弹审批**。先把索引交给模型
        //（outOfScope 字段），要读正文时由 Agent 显式传 requestApproval=true。
        // 绝对限制 / 不可读 / 已关闭作用域照旧只进 withheld（它们没有审批路径）。
        const wantsApproval = args.requestApproval === true
        let verdict                             
        if (needsApproval.length > 0 && level === 'normal' && wantsApproval) {
          verdict = await askOutOfScope(
            service,
            agent,
            policy,
            'memory_search',
            args.query,
            needsApproval.map((hit) => hit.record),
            'read',
            (exec                                        )?.signal,
            descriptionOf(args.description),
          )
        }
        // verdict 为空 = 没有发起审批(绝对限制 / read:false / 没有范围外命中):范围外不放行。
        const approvedOutside = verdict === undefined
          ? []
          : verdict.outcome !== 'allowed-once'
            ? []
            : verdict.allowedIds === undefined
              ? needsApproval
              : needsApproval.filter((hit) => verdict .allowedIds .has(hit.record.id))
        const insideIds = new Set(inside.map((hit) => hit.record.id))
        const approvedOutsideIds = new Set(approvedOutside.map((hit) => hit.record.id))
        const selected = hits.filter((hit) => insideIds.has(hit.record.id) || approvedOutsideIds.has(hit.record.id))
        const result               = {
          records: selected.map((h) => ({
            id: h.record.id,
            score: h.score,
            scope: h.record.scope,
            kind: h.record.kind,
            tags: Array.isArray(h.record.tags) ? h.record.tags : [],
            updatedAt: h.record.updatedAt,
            summary: summarize(h.record.content, chars),
          })),
        }
        // 0.23:被挡住时告诉模型真实原因(绝对限制 / 不可读 / 审批拒绝…),不再假装不存在。
        const denied = outside.length - approvedOutside.length
        if (denied > 0) {
          const approvedIds = new Set(approvedOutside.map((hit) => hit.record.id))
          const deniedRecords = outside.filter((hit) => !approvedIds.has(hit.record.id))
          // 0.27.0：普通限制下没发起审批的范围外命中 = 'out-of-scope'（索引已在
          // outOfScope 字段给出）；审批后的结局（partial/rejected/timeout）与
          // absolute / read-disabled / scope-disabled 沿用原口径。
          const reason = verdict !== undefined
            ? withheldReasonFor(decide, policy, deniedRecords.map((hit) => ({ scope: hit.record.scope, kind: hit.record.kind })), verdict)
            : outOfScopeReason(decide, policy, deniedRecords.map((hit) => ({ scope: hit.record.scope, kind: hit.record.kind })))
          if (reason !== undefined) result.withheld = { count: denied, reason }
        }
        // 0.28.0：范围外清单（不含任何记忆内容）——命中了哪些作用域、各几条、
        // 这些作用域是干什么的。只在普通限制下给出：absolute 没有任何审批放行路径，
        // 清单只会引诱越权尝试。未发起审批（默认）或审批没全过时都会给出。
        // 条目摘要刻意**不再**返回：范围外的内容不进入上下文，避免模型把摘要当正文引用。
        const pendingOutside = outside.filter((hit) => !approvedOutsideIds.has(hit.record.id))
        if (pendingOutside.length > 0 && level === 'normal') {
          const requestableIds = new Set(needsApproval.map((hit) => hit.record.id))
          const byScope = new Map                                                   ()
          for (const hit of pendingOutside) {
            const entry = byScope.get(hit.record.scope) ?? { records: 0, requestable: false }
            entry.records += 1
            if (requestableIds.has(hit.record.id)) entry.requestable = true
            byScope.set(hit.record.scope, entry)
          }
          const descriptions = scopeDescriptions(service, agent)
          result.outOfScope = {
            scopes: [...byScope].map(([scope, entry]) => ({
              scope,
              records: entry.records,
              description: descriptions.get(scope) ?? defaultScopeDescription(scope),
              requestable: entry.requestable,
            })),
          }
        }
        if (wantedTopK !== undefined) result.records = result.records.slice(0, wantedTopK)
        // 上下文去重:同一条记忆同版本已经出现过 → 只回 id,摘要让 memory_get 按需取。
        applySummaryDedupe(opts, exec, result.records)
        return result
      } catch (error) {
        throw toolError(error)
      }
    },
  }
}

                             
             
                
                
                                      
                      
 

                               
                 
               
 

export function memoryForgetTool(opts                    )                                     {
  return {
    name: 'memory_forget',
    description: 'Delete a memory by id (any scope), or all memories matching a query in one scope (default: current session).',
    parameters: {
      id: { type: 'string', description: 'Exact record id' },
      query: { type: 'string', description: 'Substring match; by default only the current session scope' },
      scope: { type: 'string', description: "省略=当前会话；显式指定只删那一个作用域。'all' 不能与 query 同用(防批量误删)。" },
      description: { type: 'string', description: DESCRIPTION_PARAM_DESCRIPTION },
    },
    async execute(args            , exec          )                        {
      const service = svc(opts)
      const agent = agentOf(exec)
      requireDescription(service, agent, args.description)
      if (!args.id && !args.query) throw new MemoryToolError('TARGET_REQUIRED', 'provide id or query')
      if (args.id && args.query) throw new MemoryToolError('TARGET_AMBIGUOUS', 'provide id or query, not both')
      // 没有会话就不判断可见域:护栏只对"本会话的 Agent"生效(与 provider 一致)。
      const policy = agent === undefined ? undefined : visibilityPolicy(service, agent)
      const decide = decisionMaker(service, agent)
      const level = policy?.level ?? 'none'
      const signal = (exec                                        )?.signal
      // ---- 按 id 删除:先查出这条记录在哪个 scope,再按可写范围判断 ----
      if (args.id) {
        const matches = (service.getByIds?.([args.id]) ?? []).filter((record) => record.id === args.id)
        const blocked = matches.filter((record) => !scopeWritableBy(decide, service, agent, policy, record.scope))
        let approved = false
        if (blocked.length > 0) {
          const decision = decide('write', blocked[0] .scope)
          if (decision !== undefined) {
            if (!decision.requestable) throw blockedRecordDecisionError(decision, blocked[0] .scope, args.id)
          } else if (level === 'absolute' || policyRule(policy, blocked[0] .scope) !== undefined) {
            // 老 provider 没有授权判定时保持原有纯策略判断。
            throw blockedRecordError(policy, blocked[0] .scope, args.id)
          }
          if (level === 'normal') {
            const verdict = await askOutOfScope(
              service,
              agent,
              policy,
              'memory_forget',
              args.id,
              blocked,
              'delete',
              signal,
              descriptionOf(args.description),
            )
            if (!verdictAllows(verdict, args.id)) {
              throw visibilityError(verdict.outcome === 'allowed-once' ? 'rejected' : verdict.outcome, 'delete', blocked[0] .scope)
            }
            approved = true
          }
        }
        try {
          return await service.forget({
            id: args.id,
            ...(agent !== undefined ? { agent } : {}),
            ...(approved ? { visibilityApproved: true } : {}),
          })
        } catch (error) {
          throw toolError(error)
        }
      }
      // ---- 按 query 删除:目标 scope 必须可写 ----
      const resolved = resolveScope(opts, service, exec, args.scope, 'read')
      if (resolved.all) {
        throw new MemoryToolError('SCOPE_NOT_WRITABLE', "scope 'all' cannot be combined with query; name the scope you mean")
      }
      const scope = resolved.scope ?? readScopes(opts, service, agent)[0]
      let approved = false
      if (level !== 'none' && scope !== undefined && !scopeWritableBy(decide, service, agent, policy, scope)) {
        const decision = decide('write', scope)
        if (decision !== undefined) {
          if (!decision.requestable) throw writeDecisionError(decision, scope, 'delete')
        } else if (policyRule(policy, scope) !== undefined || level === 'absolute') {
          // 老 provider 没有授权判定时保持原有纯策略判断。
          throw scopeWriteBlockedError(policy, scope, 'delete')
        }
        const verdict = await askOutOfScope(
          service,
          agent,
          policy,
          'memory_forget',
          `删除 ${scope} 中匹配「${args.query}」的记忆`,
          [{
            id: `query:${scope}`,
            scope,
            kind: 'note',
            content: `按关键词「${args.query}」删除该作用域中匹配的记忆`,
            tags: [],
            importance: 0,
            updatedAt: Date.now(),
          }],
          'delete',
          signal,
          descriptionOf(args.description),
        )
        if (!verdictAllows(verdict, `query:${scope}`)) {
          throw visibilityError(verdict.outcome === 'allowed-once' ? 'rejected' : verdict.outcome, 'delete', scope)
        }
        approved = true
      }
      try {
        return await service.forget({
          query: args.query,
          ...(scope !== undefined ? { scope } : {}),
          ...(agent !== undefined ? { agent } : {}),
          ...(approved ? { visibilityApproved: true } : {}),
        })
      } catch (error) {
        throw toolError(error)
      }
    },
  }
}

                           
                
               
                
                                      
                      
 

                             
                                                                                                                    
                                                    
                                                                                                   
     
                                  
                                 
     
                                                      
 

export function memoryListTool(opts                    )                                 {
  return {
    name: 'memory_list',
    description: 'List saved memories, most recently updated first.',
    parameters: {
      scope: { type: 'string', description: "省略=当前会话；'all'=所有作用域；其他值只列该作用域。" },
      kind: { type: 'string' },
      limit: { type: 'number', description: '1~200' },
      description: { type: 'string', description: DESCRIPTION_PARAM_DESCRIPTION },
    },
    async execute(args          , exec          )                      {
      const service = svc(opts)
      const agent = agentOf(exec)
      requireDescription(service, agent, args.description)
      const resolved = resolveScope(opts, service, exec, args.scope, 'read')
      const policy = visibilityPolicy(service, agent)
      const decide = decisionMaker(service, agent)
      const level = policy?.level ?? 'none'
      // level=none 时策略里的 scopes 只是偏好,不参与限制(等价于没有可见域)。
      const visible = policy !== undefined && policy.level !== 'none' ? policy.scopes.map((rule) => rule.scope) : undefined
      const readable = policy !== undefined && policy.level !== 'none'
        ? policy.scopes.filter((rule) => rule.read !== false).map((rule) => rule.scope)
        : undefined
      const expand = explicitPolicy(policy) && level !== 'none'
      let scopes                           
      if (resolved.all) {
        if (visible !== undefined) {
          scopes = [...new Set([...visible, ...allKnownScopes(service)])]
        } else {
          scopes = allKnownScopes(service)
        }
      } else if (resolved.scope === undefined) {
        // 省略 scope:默认**只列当前会话**(按需求;读全部请显式 'all')。
        // 这是有意为之的窄口径,不因为"普通限制"就去列范围外的东西。
        scopes = readScopes(opts, service, agent).slice(0, 1)
      }
      let records                       
      let withheld                        
      try {
        const limit = args.limit !== undefined ? Math.min(200, Math.max(1, args.limit)) : 50
        const raw = await service.list({
          ...(resolved.scope !== undefined ? { scope: resolved.scope } : {}),
          ...(scopes !== undefined ? { scopes } : {}),
          ...(args.kind ? { kind: args.kind } : {}),
          // 多取一些候选,避免范围外记录挤掉范围内结果。
          limit: Math.min(200, Math.max(limit, limit * 2)),
        })
        const inside = raw.filter((record) => recordAllowed(decide, policy, record.scope, record.kind))
        const outside = raw.filter((record) => !recordAllowed(decide, policy, record.scope, record.kind))
        const needsApproval = outside.filter((record) => recordRequestable(decide, policy, record.scope, record.kind))
        let verdict                             
        if (needsApproval.length > 0 && level === 'normal') {
          verdict = await askOutOfScope(
            service,
            agent,
            policy,
            'memory_list',
            resolved.scope ?? args.scope ?? 'all',
            needsApproval,
            'read',
            (exec                                        )?.signal,
            descriptionOf(args.description),
          )
        }
        const approvedOutside = verdict === undefined
          ? []
          : verdict.outcome !== 'allowed-once'
            ? []
            : verdict.allowedIds === undefined
              ? needsApproval
              : needsApproval.filter((record) => verdict .allowedIds .has(record.id))
        const insideIds = new Set(inside.map((record) => record.id))
        const approvedOutsideIds = new Set(approvedOutside.map((record) => record.id))
        const selected = raw
          .filter((record) => insideIds.has(record.id) || approvedOutsideIds.has(record.id))
          .slice(0, limit)
        records = selected.map((r) => ({
          id: r.id,
          scope: r.scope,
          kind: r.kind,
          updatedAt: r.updatedAt,
          content: r.content,
        }))
        const denied = outside.length - approvedOutside.length
        if (denied > 0) {
          const approvedIdSet = new Set(approvedOutside.map((record) => record.id))
          const deniedRecords = outside.filter((record) => !approvedIdSet.has(record.id))
          const reason = withheldReasonFor(decide, policy, deniedRecords.map((record) => ({ scope: record.scope, kind: record.kind })), verdict)
          if (reason !== undefined) withheld = { count: denied, reason }
        }
        // 上下文去重:同版本已经出现过 → 只回 id,正文让 memory_get 按需取。
        const dedup = opts.contextDedup?.(exec)
        if (dedup !== undefined && records.length > 0) {
          const seen = dedup.seen(records)
          const newlyShown                        = []
          records = records.map((record) => {
            if (!seen.has(record.id)) {
              newlyShown.push(record)
              return record
            }
            return { ...record, content: '', deduped: true }
          })
          // 这次真的把正文放进上下文的条目,后续检索/召回都按"已出现"处理。
          if (newlyShown.length > 0) dedup.markContent(newlyShown)
        }
      } catch (error) {
        throw toolError(error)
      }
      const statsAll = service.scopeStats?.()
      const stats = statsAll !== undefined && readable !== undefined
        ? statsAll.filter((s) => readable.includes(s.scope))
        : statsAll
      return {
        records,
        ...(stats !== undefined ? { scopeStats: stats } : {}),
        ...(withheld !== undefined ? { withheld } : {}),
      }
    },
  }
}

                             
                                      
                                     
                             
                
     
                                      
                                           
                                                             
     
                   
                                                     
                                       
                                          
                 
                                                                        
                
     
                                                 
                                    
     
                           
                                              
                    
                               
                      
 

                               
                                 
                          
               
                        
                 
 

/**
 * action='edit' 的结果（0.29.0）：只回「改成了什么」，不回记忆内容。
 * 字段缺省 = 这次没动它；空串 = 已清空（用途）或已移除（别名）。
 */
                                      
               
                      
               
 

                                                                                               

/**
 * 作用域目录 / 权限申请工具（0.24.0）。
 *
 * list：只返回目录元信息与访问状态，**不返回任何记忆正文**；范围外条目的记录数
 * 也刻意不返回（条数会泄露“有没有内容”）。
 *
 * request：只申请**本会话**的授权（默认只读，写权限独立申请）。一次性访问不走这里，
 * 继续由 memory_* 的隐式审批处理；absolute 下所有申请都会得到 not-requestable。
 */
export function memoryScopesTool(opts                    )                                         {
  return {
    name: 'memory_scopes',
    description: 'List memory scopes with their purpose and access status (metadata only, no content), request session access to out-of-scope scopes, or edit a scope\'s purpose and alias. action="edit" updates the scope description (empty = clear, falls back to the type default) and/or alias (empty = remove); the scope must be writable in this session. action="request" defaults to read-only and requires a reason; absolute restriction never grants access.',
    parameters: {
      action: { type: 'string', enum: ['list', 'request', 'edit'], description: 'list = 目录；request = 申请范围外作用域的会话权限（默认只读）；edit = 编辑某个作用域的描述 / 别名（需要该作用域可写）' },
      includeOutOfScope: { type: 'boolean', description: 'list：默认 true；false 时只列当前可见域内的作用域。' },
      limit: { type: 'number', description: 'list：1~200，默认 50' },
      scopes: {
        type: 'array',
        items: { type: 'string' },
        description: 'request：要申请的作用域，最多 5 个（一次申请多个时共用同一组 permissions）；自定义作用域传裸名，如 "dsh-plugin-dev"（"custom:dsh-plugin-dev" 会自动归一）',
      },
      permissions: {
        type: 'array',
        items: { type: 'string', enum: ['read', 'write'] },
        description: 'request：申请哪些权限，省略 = 只读；写权限必须显式加 "write"',
      },
      reason: { type: 'string', description: 'request：一句话申请理由，展示在审批卡上' },
      scope: { type: 'string', description: 'edit：要编辑的作用域键（目录里显示的那个，如 handbook / project:<路径>）。当前会话范围外时先用 action="request" 申请写权限' },
      scopeDescription: { type: 'string', description: 'edit：新的用途（一句话，最多 500 字）。空串 = 清空并回退到按类型的默认描述；与本参数一起省略 scopeName 则报错。' },
      scopeName: { type: 'string', description: 'edit：新的别名（只影响显示与引用，不改作用域键；项目 / 自定义作用域支持）。空串 = 移除别名；省略 = 这次不改别名。' },
      description: { type: 'string', description: DESCRIPTION_PARAM_DESCRIPTION },
    },
    async execute(args            , exec          )                            {
      const service = svc(opts)
      const agent = agentOf(exec)
      requireDescription(service, agent, args.description)

      // ---- action='edit'：编辑作用域描述 / 别名（0.29.0）----
      // 只改**目录元数据**，不碰任何记忆记录；需要该作用域可写（范围外先用
      // action='request' 拿写权限，不走隐式审批 —— 审批卡里没有"一条记忆"可展示）。
      if (args.action === 'edit') {
        const rawScope = typeof args.scope === 'string' ? args.scope.trim() : ''
        if (rawScope === '') throw new MemoryToolError('SCOPE_REQUIRED', 'action="edit" 需要 scope（要编辑的作用域键，目录里显示的那个）')
        const wantDescription = typeof args.scopeDescription === 'string'
        const wantName = typeof args.scopeName === 'string'
        if (!wantDescription && !wantName) {
          throw new MemoryToolError('EDIT_NOTHING_TO_UPDATE', 'action="edit" 至少要给 scopeDescription 或 scopeName 之一（想清空用途传空串，想移除别名传空串）')
        }
        if (typeof service.describeScope !== 'function' && wantDescription) {
          throw new MemoryToolError('SCOPES_UNAVAILABLE', '当前 provider 不支持编辑作用域用途（请升级 @restregular/dsh-memory）')
        }
        if (typeof service.renameScope !== 'function' && wantName) {
          throw new MemoryToolError('SCOPES_UNAVAILABLE', '当前 provider 不支持编辑作用域别名（请升级 @restregular/dsh-memory）')
        }
        const resolved = resolveScope(opts, service, exec, rawScope, 'write')
        if (resolved.all === true) {
          throw new MemoryToolError('SCOPE_NOT_WRITABLE', "scope 'all' cannot be edited; name one scope")
        }
        const scope = resolved.scope ?? currentSessionScope(service, exec)
        if (scope === undefined) {
          throw new MemoryToolError('SCOPE_INVALID', `scope "${rawScope}" could not be resolved; use the concrete scope key shown by action="list"`)
        }
        // 可写护栏：与写入记忆同一把锁（write 开关 / absolute / 范围外）。
        const policy = visibilityPolicy(service, agent)
        const decide = decisionMaker(service, agent)
        const level = policy?.level ?? 'none'
        if (level !== 'none' && !scopeWritableBy(decide, service, agent, policy, scope)) {
          const decision = decide('write', scope)
          if (decision !== undefined) {
            if (!decision.requestable) throw writeDecisionError(decision, scope, 'write')
            throw new MemoryToolError(
              'SCOPE_NOT_WRITABLE',
              `作用域 ${scope} 不在本会话的可写范围内；编辑作用域信息需要写权限，先用 memory_scopes({ action: "request", scopes: ["${scope}"], permissions: ["write"] }) 申请，批准后重试。`,
            )
          }
          if (policy?.level === 'normal') {
            // 老 provider 没有统一判定：普通限制下范围外就是"可申请"，别报成绝对限制。
            throw new MemoryToolError(
              'SCOPE_NOT_WRITABLE',
              `作用域 ${scope} 不在本会话的可写范围内；编辑作用域信息需要写权限，先用 memory_scopes({ action: "request", scopes: ["${scope}"], permissions: ["write"] }) 申请，批准后重试。`,
            )
          }
          throw scopeWriteBlockedError(policy, scope, 'write')
        }
        const description = wantDescription ? String(args.scopeDescription) : undefined
        const name = wantName ? String(args.scopeName) : undefined
        const by = sessionIdOf(agent) ?? 'agent'
        try {
          const edited                      = { scope }
          if (description !== undefined) edited.description = service.describeScope (scope, description, by).description
          if (name !== undefined) edited.name = service.renameScope (scope, name).name ?? ''
          return edited
        } catch (error) {
          throw toolError(error)
        }
      }

      if (args.action === 'request') {
        if (typeof service.requestScopeGrants !== 'function') {
          throw new MemoryToolError('SCOPES_UNAVAILABLE', '当前 provider 不支持作用域权限申请（请升级 @restregular/dsh-memory）')
        }
        const rawScopes = Array.isArray(args.scopes)
          ? args.scopes.map((scope) => String(scope).trim()).filter((scope) => scope !== '')
          : []
        if (rawScopes.length === 0) {
          throw new MemoryToolError('REQUESTS_REQUIRED', 'action="request" 需要 scopes 数组（要申请的作用域键）')
        }
        // 0.26.0:作用域参数先过与其他 memory_* 相同的规范层。展示形式 `custom:<名字>`
        // 归一成裸名;非法名 / 'all' 在这里明确报错,而不是把 "custom:dsh-plugin-dev"
        // 这类键原样写进 grants —— 那种授权永远匹配不到记录,却会显示"已授予"。
        const normalizedScopes           = []
        for (const raw of rawScopes) {
          const resolved = resolveScope(opts, service, exec, raw, 'read')
          if (resolved.all === true) {
            throw new MemoryToolError('SCOPE_NOT_WRITABLE', "scope 'all' cannot be requested; name one scope")
          }
          const scope = resolved.scope ?? currentSessionScope(service, exec)
          if (scope === undefined) {
            throw new MemoryToolError('SCOPE_INVALID', `scope "${raw}" could not be resolved; use a concrete scope name (e.g. 'dsh-plugin-dev')`)
          }
          if (!normalizedScopes.includes(scope)) normalizedScopes.push(scope)
        }
        if (normalizedScopes.length > 5) {
          throw new MemoryToolError('REQUESTS_TOO_MANY', '一次最多申请 5 个作用域；请分批申请')
        }
        const scopes = normalizedScopes
        const permissions = Array.isArray(args.permissions)
          ? [...new Set(args.permissions.filter((permission)                                 => permission === 'read' || permission === 'write'))]
          : ['read'         ]
        const requested = permissions.length > 0 ? permissions : ['read'         ]
        const requests = scopes.map((scope) => ({ scope, permissions: requested }))
        const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
        try {
          const result = await service.requestScopeGrants(agent, {
            requests,
            ...(reason !== '' ? { reason } : {}),
            ...(args.description !== undefined ? { description: args.description } : {}),
            ...(exec                                        )?.signal !== undefined
              ? { signal: (exec                            ).signal }
              : {},
          })
          return {
            results: result.results,
            ...(result.outcome !== undefined ? { outcome: result.outcome } : {}),
          }
        } catch (error) {
          throw toolError(error)
        }
      }

      if (typeof service.scopeCatalog !== 'function') {
        throw new MemoryToolError('SCOPES_UNAVAILABLE', '当前 provider 不支持作用域目录（请升级 @restregular/dsh-memory）')
      }
      let all                         
      try {
        all = service.scopeCatalog(agent)
      } catch (error) {
        throw toolError(error)
      }
      const filtered = args.includeOutOfScope === false ? all.filter((item) => item.inScope) : all
      const limit = args.limit !== undefined ? Math.min(200, Math.max(1, args.limit)) : 50
      return {
        scopes: filtered.slice(0, limit),
        total: filtered.length,
        omitted: Math.max(0, filtered.length - limit),
      }
    },
  }
}

/** memory_get 可按需取得的字段。id 始终返回，不在此列。 */
export const GET_FIELDS = [
  'content',
  'summary',
  'scope',
  'kind',
  'tags',
  'importance',
  'createdAt',
  'updatedAt',
  'expiresAt',
  'triggers',
  'supersedes',
  'initial',
]         

                                                  

/** 省略 fields 时的默认视图：与旧版 memory_get 看到的内容一致。 */
export const DEFAULT_GET_FIELDS             = ['content', 'scope', 'kind', 'tags']

                          
               
                                                   
                              
                                
                       
                                      
                      
 

                                                                           

                            
                      
                                   
                    
                   
     
                                       
                                                     
     
                                                      
 

const FIELD_BY_LOWER = new Map                  (GET_FIELDS.map((field) => [field.toLowerCase(), field]))

/** 解析并校验 fields：接受数组，也接受逗号/空格分隔的字符串。 */
export function resolveGetFields(raw                   )             {
  if (raw === undefined || raw === null) return [...DEFAULT_GET_FIELDS]
  const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,\s]+/) : null
  if (items === null) {
    throw new MemoryToolError('FIELDS_INVALID', `fields must be an array or a comma-separated string; allowed: ${GET_FIELDS.join(', ')}`)
  }
  const fields             = []
  const invalid           = []
  for (const item of items) {
    const key = String(item).trim().toLowerCase()
    if (key === '') continue
    const field = FIELD_BY_LOWER.get(key)
    if (field !== undefined) {
      if (!fields.includes(field)) fields.push(field)
    } else if (!invalid.includes(key)) {
      invalid.push(key)
    }
  }
  if (invalid.length > 0) {
    throw new MemoryToolError('FIELDS_INVALID', `unknown field(s): ${invalid.join(', ')}; allowed: ${GET_FIELDS.join(', ')}`)
  }
  if (fields.length === 0) {
    throw new MemoryToolError('FIELDS_EMPTY', `fields 不能为空；可用：${GET_FIELDS.join(', ')}`)
  }
  return fields
}

function pickGetFields(
  record                 ,
  fields            ,
  summaryChars        ,
)            {
  const out            = { id: record.id }
  for (const field of fields) {
    switch (field) {
      case 'content': out.content = record.content; break
      case 'summary': out.summary = summarize(record.content, summaryChars); break
      case 'scope': out.scope = record.scope; break
      case 'kind': out.kind = record.kind; break
      case 'tags': out.tags = Array.isArray(record.tags) ? record.tags : []; break
      case 'importance': out.importance = record.importance; break
      case 'createdAt': out.createdAt = record.createdAt; break
      case 'updatedAt': out.updatedAt = record.updatedAt; break
      case 'expiresAt': if (record.expiredAt !== undefined) out.expiresAt = record.expiredAt; break
      case 'triggers': if (Array.isArray(record.triggers)) out.triggers = record.triggers; break
      case 'supersedes': if (record.supersedes !== undefined && record.supersedes !== '') out.supersedes = record.supersedes; break
      case 'initial': if (record.initial === true) out.initial = true; break
    }
  }
  return out
}

export function memoryGetTool(opts                    )                               {
  return {
    name: 'memory_get',
    description: 'Fetch memories by id or by the 8-char id prefix shown in search/recall/digest output. Default fields: content + scope + kind + tags; pass fields to fetch only what you need (e.g. ["summary"], ["tags"], ["updatedAt"]).',
    parameters: {
      ids: { type: 'array', items: { type: 'string' }, description: '记忆 id 或摘要开头的 8 位前缀,1~50 个', required: true },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description: `只取这些字段，省略=${DEFAULT_GET_FIELDS.join('+')}；可选：${GET_FIELDS.join(' / ')}（id 始终返回）`,
      },
      summaryChars: { type: 'number', description: `summary 字段的字数上限（默认 ${DEFAULT_SUMMARY_CHARS}，20~2000）` },
      description: { type: 'string', description: DESCRIPTION_PARAM_DESCRIPTION },
    },
    async execute(args         , exec          )                     {
      const service = svc(opts)
      const agent = agentOf(exec)
      requireDescription(service, agent, args.description)
      const ids = Array.isArray(args.ids)
        ? [...new Set(args.ids.map(String).filter((id) => id.trim() !== ''))].slice(0, 50)
        : []
      if (ids.length === 0) throw toolError(new Error('ids 不能为空'))
      if (typeof service.getByIds !== 'function') {
        throw toolError(new Error('当前 provider 不支持 memory_get（请升级 @restregular/dsh-memory）'))
      }
      const fields = resolveGetFields(args.fields)
      const chars = resolveSummaryChars(args.summaryChars)
      try {
        const all = service.getByIds(ids)
        // 可见域是白名单:即使知道 id,也不能直接读别的范围/别的类型的正文。
        const policy = visibilityPolicy(service, agent)
        const decide = decisionMaker(service, agent)
        const level = policy?.level ?? 'none'
        const inside = all.filter((record) => recordAllowed(decide, policy, record.scope, record.kind))
        const outside = all.filter((record) => !recordAllowed(decide, policy, record.scope, record.kind))
        // read:false / absolute 都不 requestable;只有"作用域不在范围里"才审批。
        const needsApproval = outside.filter((record) => recordRequestable(decide, policy, record.scope, record.kind))
        let verdict                             
        if (needsApproval.length > 0 && level === 'normal') {
          verdict = await askOutOfScope(
            service,
            agent,
            policy,
            'memory_get',
            ids.join(' '),
            needsApproval,
            'read',
            (exec                                        )?.signal,
            descriptionOf(args.description),
          )
        }
        // verdict 为空 = 没有发起审批(绝对限制 / read:false):范围外不放行。
        const approvedOutside = verdict === undefined
          ? []
          : verdict.outcome !== 'allowed-once'
            ? []
            : verdict.allowedIds === undefined
              ? needsApproval
              : needsApproval.filter((record) => verdict .allowedIds .has(record.id))
        const insideIds = new Set(inside.map((record) => record.id))
        const approvedIds = new Set(approvedOutside.map((record) => record.id))
        const found = all.filter((record) => insideIds.has(record.id) || approvedIds.has(record.id))
        const denied = outside.length - approvedOutside.length
        const approvedIdSet = new Set(approvedOutside.map((record) => record.id))
        const deniedRecords = outside.filter((record) => !approvedIdSet.has(record.id))
        const reason = denied > 0
          ? withheldReasonFor(decide, policy, deniedRecords.map((record) => ({ scope: record.scope, kind: record.kind })), verdict)
          : undefined
        return {
          records: found.map((r) => pickGetFields(r, fields, chars)),
          fields,
          // 被可见域挡住的 id 不是"不存在":它们进 withheld 说明原因,不进 missing。
          missing: ids.filter((token) => !all.some((r) => r.id === token || r.id.startsWith(token))),
          ...(reason !== undefined
            ? { withheld: { count: denied, reason } }
            : {}),
        }
      } catch (error) {
        throw toolError(error)
      }
    },
  }
}

export function memoryTools(opts                    ) {
  return {
    memory_save: memorySaveTool(opts),
    memory_search: memorySearchTool(opts),
    memory_forget: memoryForgetTool(opts),
    memory_list: memoryListTool(opts),
    memory_scopes: memoryScopesTool(opts),
    memory_get: memoryGetTool(opts),
  }
}


//# sourceURL=source/tool-memory/src/index.ts