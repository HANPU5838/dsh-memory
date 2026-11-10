/**
 * 本地重排（可选，任务书 §5）：用**第二个 llama-server** 的 chat 模型做
 * LLM-as-judge rerank，替代/补充宿主 LLM 重排。
 *
 * 背景：现有 rerank.ts 是"纯逻辑骨架"，invoke 由宿主（ctx.llm）注入。本地
 * llama.cpp 生态里跑一个 1-4B 的 chat 模型（Qwen3-1.7B 之类）做小批量打分，
 * 在慢设备上比走云端 LLM 快且不花钱，也不占用主嵌入服务的进程。
 *
 * 行为契约（与检索管线的降级契约一致）：
 *   - 未配置 endpoint / model 或 `enabled:false` → 直接返回 null，不发请求；
 *   - 任何失败（网络、超时、HTTP 非 2xx、返回体不是合法 JSON、输出解析不出
 *     分数）→ 返回 null，调用方**保留原召回顺序**，绝不抛错、绝不阻塞；
 *   - 熔断 + 指数退避 + 60s 节流告警：后端没起来时不会每轮检索都等超时；
 *   - 复用 rerank.ts 的 prompt 构造 / 输出解析 / 每日 token 预算，
 *     于是单元测试与宿主 LLM 版本共享同一套行为。
 *
 * 接入方式（两种）：
 *   - `asInvoke()` → 直接塞进现有 `rerank({ invoke, ... })`，一行替换宿主 llm；
 *   - `rerankAndBlend(query, candidates)` → 一步拿到混合后的分数（内部走 rerank.ts）。
 */
import {
  DailyBudget,
  blendScores,
  buildRerankPrompt,
  estimateTokens,
  parseRerankOutput,
  rerank as rerankWithJudge,
                 
                       
                    
                     
} from './rerank.js'

                                     
                                                                                       
                  
                                                    
               
                                         
                   
                                        
                 
                                                  
                    
                         
               
                                                      
                 
                                      
                            
                                           
                          
                          
                      
                               
                                 
                      
                      
 

                                   
                                 
                  
                          
                  
                                    
                   
                     
                       
                       
                          
                        
                  
 

/** 把用户填的地址规范化成 /v1/chat/completions 完整 URL。 */
export function chatCompletionsUrl(endpoint        )         {
  const trimmed = endpoint.trim().replace(/\/+$/, '')
  if (trimmed === '') return '/v1/chat/completions'
  if (trimmed.endsWith('/chat/completions')) return trimmed
  if (trimmed.endsWith('/v1')) return `${trimmed}/chat/completions`
  return `${trimmed}/v1/chat/completions`
}

/** 从 chat completions 响应里取内容；格式不对返回 null。 */
export function parseChatContent(json         )                {
  const choices = (json                         )?.choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const first = choices[0]                                                       
  if (typeof first?.message?.content === 'string') return first.message.content
  if (typeof first?.text === 'string') return first.text // /v1/completions 形态
  return null
}

export class LocalReranker {
                   opts                    
                   url        
                   timeoutMs        
                   topN        
                   weight        
                   maxOutputTokens        
                   temperature        
                   fetchImpl              
                   log                           
                   budget             
          healthy = true
          lastProbe = 0
          backoffMs = 1000
          lastWarnAt = 0
          stats                  

  constructor(opts                    ) {
    this.opts = opts
    this.url = chatCompletionsUrl(opts.endpoint)
    this.timeoutMs = Math.max(50, opts.timeoutMs ?? 1500)
    this.topN = Math.max(2, Math.floor(opts.topN ?? 10))
    this.weight = Math.min(1, Math.max(0, opts.weight ?? 0.6))
    this.maxOutputTokens = Math.max(16, Math.floor(opts.maxOutputTokens ?? 256))
    this.temperature = opts.temperature ?? 0
    this.fetchImpl = opts.fetch ?? fetch
    this.log = opts.log ?? ((message        ) => console.warn(`[dsh-memory-local] ${message}`))
    this.budget = new DailyBudget(Math.max(0, opts.dailyBudgetTokens ?? 200_000))
    this.stats = {
      requests: 0,
      failures: 0,
      noOutcome: 0,
      lastLatencyMs: 0,
      budgetUsedTokens: 0,
      healthy: true,
    }
  }

  get isEnabled()          {
    return this.opts.enabled !== false && this.opts.endpoint.trim() !== '' && this.opts.model.trim() !== ''
  }

  get isHealthy()          {
    return this.healthy
  }

  /** 当前配置对应的 RerankConfig（方便宿主把 llm 配置整块交给面板显示）。 */
  get config()               {
    return {
      enabled: this.isEnabled,
      provider: 'local',
      model: this.opts.model,
      timeoutMs: this.timeoutMs,
      dailyBudgetTokens: Math.max(0, this.opts.dailyBudgetTokens ?? 200_000),
      weight: this.weight,
      topN: this.topN,
    }
  }

  get statsSnapshot()                   {
    return { ...this.stats, budgetUsedTokens: this.budget.usedToday, healthy: this.healthy }
  }

  markUp()       {
    this.healthy = true
    this.backoffMs = 1000
  }

  markDown()       {
    this.healthy = false
    this.lastProbe = Date.now()
  }

  /** 与 EmbedClient 同形的廉价熔断：不健康时跳过网络，按指数退避放行一次探测。 */
          get usable()          {
    const now = Date.now()
    if (this.healthy) return true
    if (now - this.lastProbe >= this.backoffMs) {
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000)
      return true
    }
    return false
  }

          warn(message        )       {
    const now = Date.now()
    if (now - this.lastWarnAt < 60_000) return
    this.lastWarnAt = now
    this.log(`[rerank-local] ${message}`)
  }

  /**
   * 发一次 chat completions。失败抛错（由 rerank.ts 的上层 catch 静默回退），
   * 同时更新熔断/统计。`signal` 来自 rerank.ts 的 timeout 组合。
   */
          async chat(system        , prompt        , signal                         , maxTokens        )                  {
    if (!this.usable) throw new Error('本地重排熔断中')
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    const headers                         = { 'content-type': 'application/json' }
    if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`
    const startedAt = Date.now()
    this.stats.requests += 1
    try {
      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.opts.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
          temperature: this.temperature,
          max_tokens: maxTokens,
          stream: false,
        }),
        signal: combined,
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        this.stats.failures += 1
        this.markDown()
        this.warn(`重排失败 HTTP ${res.status}（${this.url}）：${body.slice(0, 200)}`)
        throw new Error(`rerank HTTP ${res.status}`)
      }
      const json          = await res.json()
      const content = parseChatContent(json)
      this.stats.lastLatencyMs = Date.now() - startedAt
      if (content === null || content.trim() === '') {
        this.stats.failures += 1
        this.warn('重排响应缺少 choices[0].message.content')
        throw new Error('rerank 空响应')
      }
      this.markUp()
      return content
    } catch (error) {
      this.stats.lastLatencyMs = Date.now() - startedAt
      // 上面已经记过失败的路径不要重复计数。
      if (!(error instanceof Error && error.message.startsWith('rerank '))) {
        this.stats.failures += 1
      }
      this.markDown()
      const name = (error                            )?.name
      this.warn(name === 'TimeoutError' || name === 'AbortError'
        ? `重排请求超时（预算 ${this.timeoutMs}ms）`
        : `重排请求失败：${(error         )?.message ?? String(error)}`)
      throw error
    }
  }

  /**
   * 供现有 rerank.ts 直接消费的 LlmInvoke（system/prompt/signal 三件套）。
   * 这就是接入点：`this.llmInvoke = new LocalReranker(cfg).asInvoke()`。
   */
  asInvoke()            {
    return (req) => this.chat(req.system, req.prompt, req.signal, this.maxOutputTokens)
  }

  /** 直接调用（等价于 asInvoke() 展开）；失败抛错，调用方应 catch。 */
  async invoke(req                                                          )                  {
    return this.chat(req.system, req.prompt, req.signal, this.maxOutputTokens)
  }

  /** 真实探针：发一次 1 token 的最小请求。失败返回 false（不抛）。 */
  async healthCheck(timeoutMs = this.timeoutMs)                   {
    this.markUp() // 绕过熔断，确认"后端恢复了但熔断还开着"
    const originalTimeout = this.timeoutMs
    try {
      // chat() 用固定 timeoutMs；探针预算更短时用传入值包装一层 AbortSignal。
      const signal = timeoutMs < originalTimeout ? AbortSignal.timeout(timeoutMs) : undefined
      await this.chat('ping', 'ping', signal, 1)
      return true
    } catch {
      return false
    }
  }

  /**
   * 重排一组候选。任何失败/跳过都返回 null —— 调用方保留原顺序。
   * 复用 rerank.ts：同一套 prompt、解析、每日预算。
   */
  async rerank(
    query        ,
    candidates                   ,
    opts                                                 ,
  )                                {
    if (!this.isEnabled) return null
    const cfg = this.config
    const outcome = await rerankWithJudge({
      invoke: this.asInvoke(),
      cfg,
      query,
      candidates,
      budget: opts?.budget ?? this.budget,
      ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
    }).catch(() => null)
    if (outcome === null) {
      this.stats.noOutcome += 1
      return null
    }
    if (outcome.scores.size === 0) this.stats.noOutcome += 1
    return outcome
  }

  /**
   * 一步到位：重排 + 混分。失败返回 null（= 保持原顺序原分数）。
   * 成功时返回与 candidates 同序的 id/score 数组（顺序由调用方排）。
   */
  async rerankAndBlend(
    query        ,
    candidates                   ,
    opts                                                 ,
  )                                                       {
    const outcome = await this.rerank(query, candidates, opts)
    if (outcome === null) return null
    return blendScores(candidates, outcome, this.weight)
  }
}


//# sourceURL=source/memory-local/src/rerank-local.ts