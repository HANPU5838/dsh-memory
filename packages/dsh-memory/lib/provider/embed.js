/**
 * Minimal OpenAI-compatible /v1/embeddings client for a local llama-server.
 * Fails soft: every failure resolves to `null` so callers can degrade.
 */

                                     
                  
               
              
                   
     
                                                             
                                                    
     
                 
     
                                                 
     
                      
     
                                               
                                        
                                                                         
     
                                 
 

/**
 * 把 API 返回的 `number[]` 拷成 Float32Array 并做 L2 归一化（就地）。
 *
 * llama-server / OpenAI 都返回 L2 归一化向量，这里再防御性地归一一次：部分
 * OpenAI 兼容网关（vLLM、LM Studio 的某些模型）返回的是未归一化向量，不归一
 * 会让 cosine 阈值在整个库的尺度上漂移。导出给 embedding-providers.ts 复用，
 * 保证「协议校验 + 归一化」只有一份实现。
 */
export function toUnitVector(values          )               {
  const v = new Float32Array(values)
  let norm = 0
  for (let i = 0; i < v.length; i++) norm += v[i]  * v[i] 
  const n = Math.sqrt(norm)
  if (n > 0) for (let i = 0; i < v.length; i++) v[i] = v[i]  / n
  return v
}

export class EmbedClient {
          healthy = true
          lastProbe = 0
  /** 告警节流：失败可能每轮都发生，最多 60s 打一次。 */
          lastWarnAt = 0
          backoffMs = 1000
          opts                    

  constructor(opts                    ) {
    this.opts = opts
  }

  /** Cheap circuit breaker: skip the network while marked unhealthy. */
          get usable()          {
    const now = Date.now()
    if (this.healthy) return true
    if (now - this.lastProbe >= this.backoffMs) {
      // allow a retry; double the backoff on continued failure
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000)
      return true
    }
    return false
  }

          warn(message        )       {
    const now = Date.now()
    if (now - this.lastWarnAt < 60_000) return
    this.lastWarnAt = now
    ;(this.opts.log ?? ((text        ) => console.warn(`[dsh-memory-local] ${text}`)))(message)
  }

  markDown()       {
    this.healthy = false
    this.lastProbe = Date.now()
  }

  markUp()       {
    this.healthy = true
    this.backoffMs = 1000
  }

  get isHealthy()          {
    return this.healthy
  }

  /**
   * Embed texts.
   *
   * `opts.timeoutMs` overrides the configured budget per call: the default
   * (interactive) budget is tuned for short search queries, while writing or
   * backfilling FULL record contents on CPU can take seconds. Using the
   * interactive budget there silently failed every long record and poisoned the
   * circuit breaker (measured 3143ms for three ~600-char records on 2026-10-10).
   */
  async embed(texts          , signal              , opts                         )                                 {
    if (texts.length === 0) return []
    if (!this.usable) return null
    const timeout = AbortSignal.timeout(opts?.timeoutMs ?? this.opts.timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    const doFetch = this.opts.fetch ?? fetch
    const headers                         = { 'content-type': 'application/json' }
    // 只有显式配置令牌才带 Authorization：本地 llama-server 不认这个头。
    if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`
    try {
      const res = await doFetch(this.opts.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ input: texts, model: this.opts.model }),
        signal: combined,
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        this.warn(`嵌入失败 HTTP ${res.status}（${this.opts.endpoint}）：${body.slice(0, 200)}`)
        this.markDown()
        return null
      }
      const json = (await res.json())                                              
      const data = json.data
      if (!Array.isArray(data) || data.length !== texts.length) {
        this.warn(`嵌入响应不符合预期：data=${Array.isArray(data) ? data.length : typeof data}，期望 ${texts.length} 条`)
        this.markDown()
        return null
      }
      const out                 = []
      for (const item of data) {
        const arr = item.embedding
        if (!Array.isArray(arr) || arr.length !== this.opts.dims) {
          this.warn(`嵌入维度不符：收到 ${Array.isArray(arr) ? arr.length : typeof arr}，期望 ${this.opts.dims}（模型/后端不匹配？）`)
          this.markDown()
          return null
        }
        const v = toUnitVector(arr)
        out.push(v)
      }
      this.markUp()
      return out
    } catch (error) {
      const message = (error         )?.name === 'TimeoutError' || (error         )?.name === 'AbortError'
        ? `嵌入请求超时（预算 ${opts?.timeoutMs ?? this.opts.timeoutMs}ms）`
        : `嵌入请求失败：${(error         )?.message ?? String(error)}`
      this.warn(message)
      this.markDown()
      return null
    }
  }
}


//# sourceURL=source/memory-local/src/embed.ts