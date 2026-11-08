/**
 * 可插拔的嵌入后端 Provider。
 *
 * 本地 llama-server 只是默认实现：同一个检索管线可以换成任何 OpenAI 兼容
 * `/v1/embeddings` 服务（OpenAI、vLLM、LM Studio、one-api…）、Ollama
 * （`/api/embeddings`），或者干脆关掉向量通道（`off`）。
 *
 * 设计约束（与检索管线的降级契约一致）：
 *   - embed() **永不抛**：任何失败（HTTP 非 2xx、网络异常、超时、响应格式
 *     不符、维度不符）都返回 `null`，调用方静默降级成词法检索；
 *   - 失败同时走 60s 节流的 warn（带 provider kind + 状态码/原因前 200 字），
 *     否则「检索质量突然变差」在日志里完全无迹可查；
 *   - `local` 复用 embed.ts 的 EmbedClient，熔断/markUp/markDown/60s 节流/
 *     L2 归一化/维度校验的行为与今天完全一致；
 *   - 纯零运行时依赖：只用 node 内置能力 + 现有 EmbedClient。
 */
import { EmbedClient, toUnitVector } from './embed.js'

                                                                         

                                            
               
              
                  
 

                                    
                                      
                                                   
                                 
                                              
                             
                                                                                                             
                                                   
                
                  
 

                                           
                             
                                                                                    
                  
               
              
                  
                                                
                 
                                 
                   
     
                                                   
                                            
                                            
     
                        
             
                      
                                 
 

/** 告警节流：失败可能每轮检索都发生，最多 60s 打一条。 */
const WARN_INTERVAL_MS = 60_000
/** 日志里 HTTP 响应体 / 错误原因的最大长度。 */
const MAX_REASON_CHARS = 200
/** 健康探针用的最小文本：一次真实的小嵌入 ≈ 后端真的能服务。 */
const HEALTH_PROBE_TEXT = 'ping'

function defaultWarnSink(message        )       {
  console.warn(`[dsh-memory-local] ${message}`)
}

/** 把错误压成一段可控长度的原因（不吞根因）。 */
function reasonOf(error         )         {
  const message = (error                            )?.message ?? String(error)
  return message.slice(0, MAX_REASON_CHARS)
}

/** 统一失败告警出口：带 provider kind、60s 节流。 */
class WarnThrottle {
          lastWarnAt = 0
                   kind                       
                   log                            

  constructor(kind                       , log                            ) {
    this.kind = kind
    this.log = log
  }

  warn(detail        )       {
    const now = Date.now()
    if (now - this.lastWarnAt < WARN_INTERVAL_MS) return
    this.lastWarnAt = now
    ;(this.log ?? defaultWarnSink)(`[embedding-provider:${this.kind}] ${detail}`)
  }
}

function identityOf(opts                          )                            {
  return opts.pooling === undefined
    ? { model: opts.model, dims: opts.dims }
    : { model: opts.model, dims: opts.dims, pooling: opts.pooling }
}

/**
 * `local` / `openai`：完全同一个 OpenAI 兼容 `/v1/embeddings` 协议，
 * 差别只有「是否自带 Bearer 令牌」。复用 EmbedClient = 复用熔断与告警节流，
 * 不重写任何本地逻辑。
 */
class OpenAiCompatibleProvider                              {
           kind                       
           isLocalServer         
           identity                           
                   timeoutMs        
                   client             

  constructor(kind                    , opts                          ) {
    this.kind = kind
    this.isLocalServer = kind === 'local'
    this.identity = identityOf(opts)
    this.timeoutMs = opts.timeoutMs
    const warn = new WarnThrottle(kind, opts.log)
    this.client = new EmbedClient({
      endpoint: opts.endpoint,
      model: opts.model,
      dims: opts.dims,
      timeoutMs: opts.timeoutMs,
      apiKey: opts.apiKey,
      fetch: opts.fetch,
      // EmbedClient 自己已按 60s 节流；这里只负责在消息前补上 provider kind。
      log: (message) => warn.warn(message),
    })
  }

  get isHealthy()          {
    return this.client.isHealthy
  }

  embed(texts          , signal              , opts                         )                                 {
    return this.client.embed(texts, signal, opts)
  }

  /**
   * 真实探针（不是读缓存状态）：临时复位熔断再发一次最小嵌入，
   * 这样「后端已经恢复但熔断还开着」时 healthCheck 也能确认恢复。
   */
  async healthCheck(timeoutMs = this.timeoutMs)                   {
    this.client.markUp()
    const result = await this.client.embed([HEALTH_PROBE_TEXT], undefined, { timeoutMs })
    return result !== null
  }

  markUp()       {
    this.client.markUp()
  }

  markDown()       {
    this.client.markDown()
  }
}

/** ollama 只提供单条接口：POST <base>/api/embeddings，body `{model, prompt}`。 */
function ollamaEmbeddingsUrl(endpoint        )         {
  const trimmed = endpoint.trim().replace(/\/+$/, '')
  if (trimmed === '') return '/api/embeddings'
  // 容忍用户直接填了完整路径，避免 /api/embeddings/api/embeddings。
  return trimmed.endsWith('/api/embeddings') ? trimmed : `${trimmed}/api/embeddings`
}

/**
 * `ollama`：同样零依赖、同样失败软降级，只是协议不同（没有批量接口），
 * 且需要自己维护一份与 EmbedClient 同形的熔断/节流状态。
 */
class OllamaProvider                              {
           kind = 'ollama'         
           isLocalServer = false
           identity                           
                   endpoint        
                   model        
                   dims        
                   timeoutMs        
                   fetchImpl              
                   warn              
          healthy = true
          lastProbe = 0
          backoffMs = 1000

  constructor(opts                          ) {
    this.identity = identityOf(opts)
    this.endpoint = ollamaEmbeddingsUrl(opts.endpoint)
    this.model = opts.model
    this.dims = opts.dims
    this.timeoutMs = opts.timeoutMs
    this.fetchImpl = opts.fetch ?? fetch
    this.warn = new WarnThrottle('ollama', opts.log)
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

  get isHealthy()          {
    return this.healthy
  }

  markUp()       {
    this.healthy = true
    this.backoffMs = 1000
  }

  markDown()       {
    this.healthy = false
    this.lastProbe = Date.now()
  }

  async embed(texts          , signal              , opts                         )                                 {
    if (texts.length === 0) return []
    if (!this.usable) return null
    const timeoutMs = opts?.timeoutMs ?? this.timeoutMs
    const out                 = []
    // ollama 的 /api/embeddings 一次只吃一条 prompt，所以逐条串行请求；
    // 任一条失败整批返回 null（部分成功的半批向量会破坏「同一批同一次模型」假设）。
    for (const text of texts) {
      const value = await this.embedOne(text, signal, timeoutMs)
      if (value === null) return null
      out.push(value)
    }
    this.markUp()
    return out
  }

          async embedOne(text        , signal                         , timeoutMs        )                               {
    const timeout = AbortSignal.timeout(timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, prompt: text }),
        signal: combined,
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        this.warn.warn(`嵌入失败 HTTP ${res.status}（${this.endpoint}）：${body.slice(0, MAX_REASON_CHARS)}`)
        this.markDown()
        return null
      }
      const json = (await res.json())                           
      const embedding = json.embedding
      if (!Array.isArray(embedding) || embedding.length !== this.dims) {
        this.warn.warn(`嵌入维度不符：收到 ${Array.isArray(embedding) ? embedding.length : typeof embedding}，期望 ${this.dims}（模型/后端不匹配？）`)
        this.markDown()
        return null
      }
      return toUnitVector(embedding            )
    } catch (error) {
      const name = (error                            )?.name
      const detail = name === 'TimeoutError' || name === 'AbortError'
        ? `嵌入请求超时（预算 ${timeoutMs}ms）`
        : `嵌入请求失败：${reasonOf(error)}`
      this.warn.warn(detail)
      this.markDown()
      return null
    }
  }

  /** 真实探针（绕过熔断），失败走同一份节流告警。 */
  async healthCheck(timeoutMs = this.timeoutMs)                   {
    const value = await this.embedOne(HEALTH_PROBE_TEXT, undefined, timeoutMs)
    if (value === null) return false
    this.markUp()
    return true
  }
}

/**
 * `off`：显式关闭向量通道。永不联网、永不抛，embed 恒为 null（含空数组），
 * isHealthy/healthCheck 恒为 false。这是用户主动选择而非故障，因此**不打 warn**，
 * 否则每轮检索都会刷一条无意义日志。
 */
class OffEmbeddingProvider                              {
           kind = 'off'         
           isLocalServer = false
           identity                           

  constructor(opts                          ) {
    this.identity = identityOf(opts)
  }

  get isHealthy()          {
    return false
  }

  async embed(_texts          , _signal              , _opts                         )                                 {
    return null
  }

  async healthCheck(_timeoutMs         )                   {
    return false
  }

  markUp()       {
    /* 恒关闭：没有可恢复的健康状态 */
  }

  markDown()       {
    /* 恒关闭 */
  }
}

/**
 * 按配置创建嵌入后端。kind 由类型限定为四种；运行时拿到未知值说明配置/面板
 * 传了脏数据，直接抛错（构造期暴露，而不是让检索静默退化成词法）。
 */
export function createEmbeddingProvider(opts                          )                    {
  switch (opts.kind) {
    case 'local':
      return new OpenAiCompatibleProvider('local', opts)
    case 'openai':
      return new OpenAiCompatibleProvider('openai', opts)
    case 'ollama':
      return new OllamaProvider(opts)
    case 'off':
      return new OffEmbeddingProvider(opts)
    default:
      throw new Error(`未知的嵌入后端 kind=${String((opts                      ).kind)}（支持 local/openai/ollama/off）`)
  }
}


//# sourceURL=source/memory-local/src/embedding-providers.ts