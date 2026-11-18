/**
 * Memory injection logic (M3) — pure functions, no cordis imports.
 *
 * Injection shape follows the official docs: a user-role message whose content
 * is a single `context` block with `contextForm: 'recall'`, prepended to the
 * messages that enter the step via the agent/pre-step waterfall.
 */
                                                         
import { estimateTokens } from '../provider/rerank.js'
import { normalizeScopeInput } from '../provider/scope.js'
import { textHasTag } from './signals.js'
import { recordKindPrefix } from './digest.js'
import { digestForRecall } from './summarize.js'
import { resolveInjectionConflicts } from './conflicts.js'
import { InjectionState } from './state.js'

                               
                  
                                                    
                     
                                    
              
     
                                          
                                                                     
     
                        
 

export const defaultInjectConfig               = {
  enabled: true,
  tokenBudget: 500,
  topK: 5,
}

/** 召回注入能用到的那部分 provider 能力。 */
                                      
                                              
                                              
     
                                               
                                          
     
                                          
                                               
                                                                                                                                              
                                                           
                                             
                                                             
                                                                    
 

/** 宿主里"按会话 id 找 live session"的那一小部分能力(拿不到就不做父会话召回)。 */
                                  
                           
 

/**
 * 把 config.extraScopes 规范化成 scope 键列表;非法项忽略并记一行日志
 * (配置写错不该让整个注入半边失效)。
 */
export function normalizeExtraScopes(raw                   , warn                            = console.warn)           {
  const out           = []
  for (const item of raw) {
    const normalized = normalizeScopeInput(item)
    if (!normalized.ok) {
      warn(`[dsh-memory-inject] 忽略非法的 inject.extraScopes 项 ${JSON.stringify(item)}: ${normalized.message}`)
      continue
    }
    if (normalized.scope !== undefined && !out.includes(normalized.scope)) out.push(normalized.scope)
  }
  return out
}

/**
 * 自动召回的作用域:global + 当前会话 + 当前工作区。
 *
 * 普通每轮召回仍按用户配置使用 session + project + global(可额外加 extraScopes
 * 或 fork 父会话);但行为信号触发的自动召回只认这三个标准范围,不把额外自定义
 * 作用域 / 父会话一起搜进来。没有可用范围时返回 undefined,调用方跳过自动召回。
 */
export function autoRecallScopes(scopes                               )                       {
  if (scopes === undefined) return undefined
  const out = scopes.filter((scope) =>
    scope === 'global' || scope.startsWith('session:') || scope.startsWith('project:'))
  return out.length > 0 ? out : undefined
}

/**
 * 无显式 scope 时的召回范围:当前会话 + 当前项目 + global(provider 解析)
 * + inject.extraScopes + 父会话(fork 时,只读召回)。
 * 任何一步拿不到都只降级,绝不抛(注入路径抛错会打断整个 agent 循环)。
 */
export function resolveInjectScopes(
  memory                     ,
  agent         ,
  extraScopes                   ,
  sessions                             ,
)                       {
  // 会话设置了显式可见范围时,它就是白名单:extraScopes / 父会话都不能把它撑大。
  // 空数组也要原样返回(表示什么都不允许读),不能当成"没设置"。
  let explicit                      
  try {
    const visible = memory.visibleScopes?.(agent)
    if (Array.isArray(visible)) explicit = [...visible]
  } catch { /* 拿不到覆盖就按默认集合 */ }
  if (explicit !== undefined) return explicit

  const scopes           = []
  try {
    for (const scope of memory.resolveReadScopes?.(agent) ?? []) {
      if (!scopes.includes(scope)) scopes.push(scope)
    }
  } catch { /* 降级为 extraScopes */ }
  for (const scope of extraScopes) if (!scopes.includes(scope)) scopes.push(scope)
  // fork 出来的会话:父会话的记忆也值得召回(只读)。父会话可能已不在内存里,拿不到就跳过。
  try {
    const header = (agent                                                                                        )?.session?.header
    const parent = typeof header?.parentSession === 'string' ? header.parentSession : undefined
    if (parent !== undefined && header?.origin !== 'subagent') {
      if (sessions?.get?.(parent) !== undefined) {
        const scope = `session:${parent}`
        if (!scopes.includes(scope)) scopes.push(scope)
      }
    }
  } catch { /* 父会话召回是可选增强 */ }
  return scopes.length > 0 ? scopes : undefined
}

/** Minimal structural view of the messages we inspect (role + text blocks). */
                                   
              
                                                         
                                                   
                            
 

                              
                                       
                      
     
                                                 
                                                                   
                                                         
     
                            
                                                         
                                           
                                        
                    
 

                                      
                                       
 

/**
 * Extract the retrieval query: the text of the LAST **human** user message.
 *
 * Synthetic context messages are also role=user (memory recall, runtime/time
 * context, skill catalog, file notices...). Taking the last user-role message
 * blindly makes the next recall query the previous recall block itself — a
 * cross-project self-recall loop (observed in a dsh-pocket session pulling a
 * dsh-memory global record). Skip every known synthetic source; messages with
 * no source (unit-test scaffolds / older hosts) are treated as human.
 */
export function pickQueryText(messages                             )         {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] 
    if (m.role !== 'user') continue
    const kind = m.source?.kind
    if (kind !== undefined && kind !== '' && kind !== 'user') continue
    const text = (m.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text )
      .join(' ')
      .trim()
    if (text) return text
  }
  return ''
}

/**
 * 这一步的 messages 里是否已经有一条内容完全相同的召回块。
 *
 * 正常情况下永远不会命中:一个激活只有一个 MemoryInjector,而它自己用
 * 会话级 lastText 去重。但只要宿主把这条 entry 应用了两次(热重载/重新启用时
 * 旧 fiber 的 agent/pre-step 监听没被清掉),两个注入器就会各追加一条逐字相同的消息 ——
 * 表现在会话轨迹里就是同一轮「上下轮」卡片连着出现两次(2026-10-17 实况)。
 * 注入本身是"多一条也无害、少一条也不坏"的提示块,所以这里按内容做一次幂等:
 * 另一个实例已经放进去的同一段,就不要再放。
 */
export function hasRecallMessage(
  messages                                                                  ,
  text        ,
)          {
  for (const m of messages) {
    if (m.role !== 'user') continue
    if (m.source?.kind !== 'memory') continue
    const joined = (m.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text )
      .join('\n')
    if (joined === text) return true
  }
  return false
}

/** 召回的两种形态:旧的长文(300 字)与新的"印象"(短摘要 + 指路取全文)。 */
                                      
                                    
                
                   
                      
                                                
                    
     
                                
                                                
     
                   
     
                                                   
                               
     
                  
                                     
                    
     
                                          
                                                    
                                                          
     
                                                                                                                                              
 

                                 
            
                                                  
 

                              
              
                
                    
               
                           
 

/** Render hits into a recall text block, greedily within the token budget. */
export function renderRecallBlock(
  hits             ,
  cfg              ,
  options                      = {},
)                     {
  if (hits.length === 0) return null
  // 0.35.4：before-inject 钩子先解析召回记录 —— 可改写正文或丢弃整条。
  // 丢弃的要计入 omitted（审计要能解释"为什么某条没进上下文"）。
  let effectiveHits = hits
  const droppedIds = new Set        ()
  if (options.transform !== undefined) {
    try {
      const transformed = options.transform(hits.map((h) => h.record), options.sessionId)
      const byId = new Map(transformed.records.map((record) => [record.id, record]))
      effectiveHits = hits
        .filter((h) => byId.has(h.record.id))
        .map((h) => ({ ...h, record: byId.get(h.record.id)  }))
      for (const id of transformed.droppedIds ?? []) droppedIds.add(id)
      // 变换后没给 droppedIds 但记录变少了：按差集兜底。
      if (transformed.droppedIds === undefined) {
        for (const h of hits) if (!byId.has(h.record.id)) droppedIds.add(h.record.id)
      }
    } catch { /* 解析失败 = 没解析：记录原样进入上下文 */ }
  }
  // 0.83.0：冲突消解 —— 互相矛盾的记忆不能同时进上下文（保留更重要/更新的一条）。
  const conflictResolution = resolveInjectionConflicts(effectiveHits)
  effectiveHits = conflictResolution.kept

  const impression = options.impression === true
  const chars = impression ? (options.chars ?? 120) : 300
  // 0.69.0：按相对相关度动态分配「每条保留多少字」（0.55×–1.30×，下限 48 字）。
  // 总 tokenBudget 不变：高相关记忆多给正文、低相关收紧摘要，避免平均主义把预算
  // 摊给弱命中。相关度取 hit.score / 本轮最高分；分数缺失/非法时按 1 处理（不惩罚）。
  const maxScore = effectiveHits.reduce((max, h) => (Number.isFinite(h.score) && h.score > max ? h.score : max), 0)
  const dynamic = options.dynamic !== false
  const charsFor = (hit           )         => {
    if (!dynamic) return chars
    const ratio = maxScore > 0 && Number.isFinite(hit.score) ? Math.max(0, Math.min(1, hit.score / maxScore)) : 1
    return Math.max(48, Math.round(chars * (0.55 + 0.75 * ratio)))
  }
  const header = impression
    ? '以下是与你这次请求可能相关的记忆摘要：'
    : '以下是与此请求可能相关的记忆，供参考（需要正文用 memory_get；与本轮无关的用 memory_block 屏蔽，可逆、不删数据）：'
  let tokens = estimateTokens(header) + 4
  const lines           = []
  const ids           = []
  const omitted                   = []
  let budgetExhausted = false
  // 被钩子丢弃的记录：审计里要给出原因，不能凭空消失。
  for (const h of hits) {
    if (droppedIds.has(h.record.id)) omitted.push({ id: h.record.id, reason: 'hook' })
  }
  // 冲突败者：记录保留、只是不进本轮上下文，审计写清原因。
  for (const id of conflictResolution.dropped) omitted.push({ id, reason: 'conflict' })
  for (const [index, h] of effectiveHits.entries()) {
    if (index >= cfg.topK) {
      omitted.push({ id: h.record.id, reason: 'top_k' })
      continue
    }
    if (budgetExhausted) {
      omitted.push({ id: h.record.id, reason: 'budget' })
      continue
    }
    const cap = charsFor(h)
    const shown = options.digest === false
      ? h.record.content.replace(/\s+/g, ' ').slice(0, cap)
      : digestForRecall(h.record.content, cap, options.queryText ?? '')
    const line = `- ${h.record.id.slice(0, 8)} ${recordKindPrefix(h.record)}${shown}`
    const cost = estimateTokens(line) + 1
    if (tokens + cost > cfg.tokenBudget) {
      budgetExhausted = true
      omitted.push({ id: h.record.id, reason: 'budget' })
      continue
    }
    lines.push(line)
    ids.push(h.record.id)
    tokens += cost
  }
  if (lines.length === 0) {
    // 所有候选都超预算时也要保留 omitted 原因：审计需要解释“为什么什么都没注入”。
    return { text: '', tokens: 0, ids: [], omitted }
  }
  return { text: `${header}\n${lines.join('\n')}`, tokens, ids, omitted }
}

/** The context block we prepend (matches the documented ContextForm 'recall'). */
export function recallText(text        )         {
  return text
}

/** 配置既可以给静态值,也可以给 getter —— 面板改了设置,下一步就生效。 */
                                    

                                       
                    
                               
                
                                 
                  
                                  
                                  
                                      
                 
                                             
              
                      
 

                               
               
                                  
               
                                      
                          
                   
                     
                    
                      
                   
                           
               
                
                    
                  
                      
                             
                          
                        
                                                                               
                                          
                        
 

/**
 * Turn-agnostic injector: searches memory for the step's query and returns the
 * recall text to append. The host middleware (apply.ts) wraps that text into a
 * real message via createUserMessage.
 *
 * 去重从 0.9.6 起按 sessionId + 记忆 id/版本管理:
 *   - 已注入正文且内容未变 → 跳过;
 *   - 只注入过标签 → 允许补正文;
 *   - 内容更新 → 重新注入;
 *   - 同一段文本 = 最后一道幂等。
 */
export class MemoryInjector {
                   search                                                                                                                                                          
                   cfg                            
                   renderOptions                                   
                   state                

  constructor(
    search                                                                                                                                                          ,
    cfg                            ,
    renderOptions                                    = {},
    state                 = new InjectionState(),
  ) {
    this.search = search
    this.cfg = cfg
    this.renderOptions = renderOptions
    this.state = state
  }

  async maybeInject(
    input             ,
    _decision                     ,
    options                       = {},
  )                              {
    const result = await this.maybeInjectDetailed(input, _decision, options)
    return result?.text
  }

  async maybeInjectDetailed(
    input             ,
    _decision                     ,
    options                       = {},
  )                                    {
    const cfg = typeof this.cfg === 'function' ? this.cfg() : this.cfg
    if (!cfg.enabled) return undefined
    const query = options.query ?? pickQueryText(input.messages)
    if (!query) return undefined
    const sessionId = options.sessionId ?? input.sessionId

    let hits             
    try {
      hits = await this.search(query, input.signal, input.scopes, input.kinds, sessionId)
    } catch {
      // 检索失败不能打断 agent 循环;审计会区分"失败"与"成功但无结果"。
      return {
        ids: [], candidates: 0, dedupSkipped: 0, updated: [], omitted: [], query,
        tokens: 0, rawHits: 0, tagFiltered: 0, supersededExcluded: 0, graphExpanded: 0,
        retrieval: { ok: false, count: 0, error: 'retrieval_failed', errorCode: 'retrieval_failed' },
      }
    }
    // 过期状态由 provider 的检索层过滤;这里再兜一道,防止旧 provider 把过期
    // state 当成当前事实注入。memory_get(id) 仍可直接取到历史正文。
    const now = Date.now()
    const retrieved = hits
    hits = hits.filter((hit) => !(hit.record.expiredAt !== undefined && hit.record.expiredAt < now))
    const expiredExcluded = retrieved.length - hits.length
    // 成功检索后记住查询(即使没有新正文):同一 query 的后续 step 不再重复全量检索。
    this.state.setLastQuery(sessionId, query)

    // 标签触发的自动召回:只接受真正带该标签(或同义词)的记录。
    // 否则一个泛标签(如 git)会把向量上勉强相关、但完全没有该标签的全局记忆
    // 带进当前项目 —— 实测 dsh-pocket 会话因此注入过 dsh-memory 的 digest 记忆。
    const requiredTag = options.requireTag === true && typeof options.tag === 'string' && options.tag.trim() !== ''
      ? options.tag.trim()
      : ''
    const taggedHits = requiredTag === ''
      ? hits
      : hits.filter((hit) => (hit.record.tags ?? []).some((tag) => textHasTag(String(tag), requiredTag)))
    const tagFiltered = hits.length - taggedHits.length
    const seenIds = options.excludeIds
    const candidates = seenIds === undefined ? taggedHits : taggedHits.filter((hit) => !seenIds.has(hit.record.id))
    const supersededExcluded = taggedHits.length - candidates.length
    const { fresh, deduplicated, updated } = this.state.filterNewContent(
      sessionId,
      candidates.map((hit) => hit.record),
    )
    const freshIds = new Set(fresh.map((record) => record.id))
    const freshHits = candidates.filter((hit) => freshIds.has(hit.record.id))
    const optionsForRender = typeof this.renderOptions === 'function' ? this.renderOptions() : this.renderOptions
    // 0.35.4：把会话 id 传给 transform（before-inject 钩子按会话判断时用）。
    const block = renderRecallBlock(freshHits, cfg, { ...optionsForRender, sessionId, queryText: query })
    const graphExpanded = candidates.filter((hit) => (hit                               ).graphExpanded === true).length
    const base               = {
      ids: [], candidates: candidates.length, dedupSkipped: deduplicated.length, updated, omitted: [], query,
      ...(graphExpanded > 0 ? { graphExpanded } : {}),
      // 全部候选都被去重时 block 为 null；把 id 留在结果里，审计才能解释"跳过了哪条"。
      dedupIds: deduplicated,
      tokens: 0, rawHits: hits.length, tagFiltered, supersededExcluded, expiredExcluded,
      retrieval: { ok: true, count: hits.length },
    }
    if (!block) return base
    if (block.text === '') {
      // 有候选但全部被 top_k/预算省略：保留原因，但不标记已注入。
      return { ...base, omitted: block.omitted }
    }
    if (block.text === this.state.lastTextOf(sessionId)) {
      return {
        ...base,
        ids: block.ids,
        newlyAddedIds: [],
        dedupIds: [...deduplicated, ...block.ids],
        omitted: block.omitted,
        tokens: block.tokens,
        dedupSkipped: deduplicated.length + block.ids.length,
        lastTextSame: true,
      }
    }

    this.state.markContent(sessionId, block.ids.map((id) => {
      const record = freshHits.find((hit) => hit.record.id === id) .record
      return { id, updatedAt: record.updatedAt }
    }))
    this.state.setLastText(sessionId, block.text)
    this.state.setLastQuery(sessionId, query)
    return {
      ...base,
      text: block.text,
      ids: block.ids,
      newlyAddedIds: block.ids,
      dedupIds: deduplicated,
      omitted: block.omitted,
      tokens: block.tokens,
      lastTextSame: false,
    }
  }
}

/** 从 agent 上取会话 id;取不到就没有"每个会话只发一次摘要"的锚点。 */
export function sessionIdOf(agent         )                     {
  const id = (agent                                              )?.session?.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/** 摘要注入最多记住多少个会话(一个进程里开过的会话上界,防止 Set 无限长)。 */
const MAX_DIGESTED_SESSIONS = 500

/**
 * 会话摘要注入器:一个会话只注入一次"已有哪些记忆"的摘要。
 * 检索失败或结果为空也标记为已完成 —— 摘要不是必需品,不能每步重试。
 */
export class MemoryDigester {
                   done = new Set        ()
                   list                                                                                     

  constructor(
    list                                                                                     ,
  ) {
    this.list = list
  }

  async maybeDigest(
    sessionId                    ,
    scopes                               ,
    render                                            ,
  )                              {
    if (sessionId === undefined || this.done.has(sessionId)) return undefined
    this.markDone(sessionId)
    let records                
    try {
      records = await this.list(scopes)
    } catch {
      return undefined
    }
    return render(records) ?? undefined
  }

  /**
   * 与 maybeDigest 相同,但把渲染结果原样返回(含统计与 hintIds),
   * 供 apply.ts 写审计、标记 hint/content 状态。
   */
  async maybeDigestDetailed   (
    sessionId                    ,
    scopes                               ,
    render                                       ,
  )                         {
    const outcome = await this.maybeDigestOutcome(sessionId, scopes, render)
    return outcome.status === 'ok' ? outcome.value : undefined
  }

  /**
   * 带状态的摘要评估：审计需要区分“没有会话 / 已经做过 / 加载失败 / 成功但为空”。
   * 仍然保持旧行为：每个会话只尝试一次（加载失败也不重试），避免每步打网络。
   */
  async maybeDigestOutcome   (
    sessionId                    ,
    scopes                               ,
    render                                       ,
    agent          ,
  )          
                                                                     
                                             
                                                                      
    {
    if (sessionId === undefined) return { status: 'skipped', reasonCode: 'no_session' }
    if (this.done.has(sessionId)) return { status: 'skipped', reasonCode: 'already_done' }
    this.markDone(sessionId)
    let records                
    try {
      records = await this.list(scopes, agent)
    } catch {
      return { status: 'failed', errorCode: 'source_load_failed' }
    }
    let value          
    try {
      value = render(records)
    } catch {
      return { status: 'failed', errorCode: 'render_failed' }
    }
    return {
      status: 'ok',
      ...(value !== null && value !== undefined ? { value } : {}),
      empty: value === null || value === undefined,
      candidates: records.length,
    }
  }

          markDone(sessionId        )       {
    this.done.add(sessionId)
    if (this.done.size > MAX_DIGESTED_SESSIONS) {
      const oldest = this.done.values().next()
      if (!oldest.done) this.done.delete(oldest.value)
    }
  }

  /** 从持久化状态恢复「这个会话已经做过摘要」,避免插件重载后重复注入。 */
  seedDone(sessionId                    )       {
    if (sessionId !== undefined) this.markDone(sessionId)
  }

  isDone(sessionId                    )          {
    return sessionId !== undefined && this.done.has(sessionId)
  }

  /** 上下文被压缩/重建后重新允许摘要评估(旧摘要可能已不在上下文里)。 */
  reset(sessionId                    )       {
    if (sessionId !== undefined) this.done.delete(sessionId)
  }
}


//# sourceURL=source/memory-inject/src/inject.ts