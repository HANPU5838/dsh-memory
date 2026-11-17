/**
 * Cordis wiring for dsh-tool-memory. Loaded only inside DSH: wraps the pure
 * tool specs with the official defineTool DSL and registers them.
 *
 * inject: ['tools', 'memory'] is REQUIRED:
 *  - 'tools'  → the tool registry must be ready
 *  - 'memory' → this fiber stays PENDING until the provider provides the
 *    service, so `ctx.memory` is guaranteed active when apply runs (accessing
 *    it without declaring made apply throw and the entry silently die)
 *
 * 0.5.0 起 scope 的默认值是**当前会话**:handler 必须把宿主的 `exec` 透传给工具实现
 * (会话 id / cwd 全在 `exec.agent.session.header` 上),这里同时负责把 scope 键渲染成
 * 人看得懂的标签(会话标题只有这一层能拿到)。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  memoryTools,
                        
                         
                          
                
} from './index.js'
import { renderBlockResult, renderGetResult, renderHooksResult, renderListResult, renderScopesResult, renderSearchResult } from './render.js'
import { resolveCurrentScopes, scopeDisplayName, sessionShortId,               } from '../provider/scope.js'

export const name = 'dsh-tool-memory'
export const inject = ['tools', 'memory']

                                   
                                                                         
                                                 
                                                     
                       
     
                                                     
                                  
     
                        
 

/** 注入半边提供的服务(只在单包里存在;独立安装工具半边时可能没有)。 */
                               
                                                                                                 
                                                                                                 
                                                                                                 
 

/** 工具执行时的会话 id(与注入半边同一口径:agent.session.id)。 */
function sessionIdOf(exec         )                     {
  const session = (exec                                                          )?.agent?.session
  const id = session?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

export function apply(ctx     , config                   = {}) {
  const memory = ctx.memory                     
  /** 调用时的项目键:显式配置 > 会话 cwd > 进程 cwd。 */
  const projectScopeFor = (exec         )         => {
    if (config.projectScope !== undefined) return config.projectScope
    return resolveCurrentScopes((exec                                   )?.agent).project
  }
  /**
   * 惰性取注入半边的去重服务:apply 执行时它可能还没 provide(两边不保证顺序),
   * 所以每次工具执行时再 ctx.get,而不是在 apply 里取样(见记忆里的冷启动丢注册坑)。
   */
  const contextDedup = (exec         )                               => {
    if (config.contextDedup === false) return undefined
    const sessionId = sessionIdOf(exec)
    if (sessionId === undefined) return undefined
    try {
      const service = ctx.get('memoryContextDedup')                                   
      if (service === undefined || typeof service.seen !== 'function') return undefined
      return {
        seen: (records) => service.seen(sessionId, records),
        markSummary: (records) => service.markSummary(sessionId, records),
        markContent: (records) => service.markContent(sessionId, records),
      }
    } catch {
      // 去重是纯优化;服务不可用时照常返回摘要。
      return undefined
    }
  }
  const opts                     = {
    getService: () => memory,
    defaultScope: config.defaultScope ?? 'session',
    projectScope: config.projectScope,
    contextDedup,
  }
  const tools = memoryTools(opts)

  /**
   * scope 键 → 展示名(带类型前缀:`global:全局` / `project:<cwd>` / `session:xxx` /
   * `custom:<名字>`)。会话标题只有宿主服务能给:`ctx.get('sessionTitle')` 的
   * `get(session)` 返回 `{ title }`(见 @deepseek-ai/dsh-session-title);整套访问都在
   * try/catch 里 —— 旧宿主没有这个服务、会话已经不在内存里,都不能影响工具结果,
   * 回退成「会话 id 前 16 位」。
   */
  const labelFor = (scope          , agent         )         => {
    if (!scope.startsWith('session:')) return scopeDisplayName(scope)
    const id = scope.slice('session:'.length)
    const short = sessionShortId(id)
    try {
      const session = (agent                                             )?.session
      if (session?.id === id) {
        const titles = ctx.get?.('sessionTitle')
        const snapshot = titles?.get?.(session)
        const title = snapshot?.title
        if (typeof title === 'string' && title.length > 0) return scopeDisplayName(scope, `${title}(${short})`)
      }
    } catch { /* 拿不到标题就用短 id */ }
    return scopeDisplayName(scope)
  }

  // 自定义作用域也一样:`custom:<名字>`(它的键本来没有前缀,由类型补上)。
  const renderScope = (scope          , agent         )         => labelFor(scope, agent)

  /** 作用域清单文案(名字 + 条数);最多 20 个,其余写"…另有 N 个"。 */
  const scopeSummary = (value                                                            , agent         )         => {
    const stats = value.scopeStats ?? []
    if (stats.length === 0) return ''
    const lines = stats.slice(0, 20).map((s) => `${renderScope(s.scope, agent)}(${s.records})`)
    const rest = stats.length - lines.length
    return `作用域：${lines.join('、')}${rest > 0 ? `，…另有 ${rest} 个` : ''}`
  }

  const register =       (spec                , render                                              )       => {
    ctx.tools.register(defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters         ,
      output: {
        schema: { type: 'json' },
        render: (_args         , value   , exec          ) => [{ type: 'text', text: render(value, _args     , exec) }],
      },
      execute: (args   , exec       ) => spec.execute(args, exec),
    }))
  }

  register(tools.memory_save, (value, _args, exec) => {
    const agent = (exec                                   )?.agent
    return value.deduped
      ? `已更新既有记忆（内容相同，去重）：${value.id} @ ${renderScope(value.scope, agent)}`
      : `已保存记忆 ${value.id} @ ${renderScope(value.scope, agent)}`
  })

  register(tools.memory_search, (value, _args, exec) => {
    const agent = (exec                                   )?.agent
    return renderSearchResult(value, (scope) => renderScope(scope, agent))
  })

  register(tools.memory_forget, (value) => (value.removed === 0 ? '没有匹配的记忆。' : `已删除 ${value.removed} 条记忆。`))

  register(tools.memory_list, (value, _args, exec) => {
    const agent = (exec                                   )?.agent
    const body = renderListResult(value, (scope) => renderScope(scope, agent))
    const summary = scopeSummary(value, agent)
    return [body, summary].filter((part) => part !== '').join('\n')
  })

  register(tools.memory_scopes, (value, _args, exec) => {
    const agent = (exec                                   )?.agent
    return renderScopesResult(value, (scope) => renderScope(scope, agent))
  })

  register(tools.memory_get, (value, _args, exec) => {
    const agent = (exec                                   )?.agent
    return renderGetResult(value, (scope) => renderScope(scope, agent))
  })

  register(tools.memory_block, (value, _args, exec) => {
    const agent = (exec                                   )?.agent
    return renderBlockResult(value, (scope) => renderScope(scope, agent))
  })

  register(tools.memory_hooks, (value, _args, exec) => {
    const agent = (exec                                   )?.agent
    return renderHooksResult(value, (scope) => renderScope(scope, agent))
  })
}


//# sourceURL=source/tool-memory/src/apply.ts