/**
 * OpenAI 兼容 /v1/embeddings 客户端（本地 llama-server 为主）。
 *
 * 失败软降级：所有失败都不抛，调用方可以退回词法检索。本文件包含三块能力：
 *
 *  1. 批量嵌入 —— llama-server / OpenAI / vLLM 的 `/v1/embeddings` 都接受
 *     `input: string[]`，一次请求多条能省掉 N-1 次 HTTP 往返（实测批量 8 条比
 *     逐条快 ~3x）。按条数 + 总字符数自动分组；整批失败且原因看起来是"单条输入
 *     问题"（HTTP 400/413/422，最常见的 input too large）时自动回退单条重试，
 *     这样一条超长记录不会把同批其他记录一起拖死。
 *  2. 缓存友好接口 —— `embed()` 保持旧语义（要么全成功、要么 null），
 *     `embedBatch()` 支持"部分成功"（返回 `(Float32Array | null)[]`），
 *     给 embed-cache.ts / 回填队列用：成功的立刻落盘，失败的留给重试。
 *  3. 预热保活 —— `EmbedKeepAlive`：启动后 warmup 一次（第一次请求要加载
 *     GGUF/分配 KV，避免用户第一问吃 ~10s 冷启动），之后按退避周期探活，
 *     后端恢复时自动结束熔断。
 *
 * 零运行时依赖：只用 node 内置 fetch / AbortSignal。
 */

/** 与 embedding-providers.ts 的健康探针共用同一段文本：一次真实的小嵌入 ≈ 后端真的能服务。 */
const HEALTH_PROBE_TEXT = 'ping'

/**
 * 批量失败后"值得回退单条重试"的 HTTP 状态码白名单（说明问题在单条输入，而非后端）。
 * 400/413/422 是 OpenAI 系网关的常见形态。
 */
const ITEM_SCOPED_STATUS = new Set([400, 413, 422])

/**
 * 单条输入问题的响应体特征。**实测 llama-server 对超长输入返回的是 HTTP 500**
 * （`{"error":{"code":500,"message":"input (3603 tokens) is too large to process"}}`），
 * 只看状态码会把"一条记录太长"误判成"后端挂了"，于是整批（含正常记录）全失败、
 * 熔断打开、回填队列卡死。所以状态码之外还要看 body 里有没有超限字样。
 */
const ITEM_SCOPED_BODY = /input is too large|too large to process|too long|context (?:length|size|window)|exceeds the context|prompt is too long/i

/** 判断一次失败是否"值得拆成单条重试"（输入问题）还是"后端故障"（拆了也没用）。 */
function isItemScopedFailure(status        , body        )          {
  if (ITEM_SCOPED_STATUS.has(status)) return true
  return ITEM_SCOPED_BODY.test(body)
}

/** 默认一次请求最多多少条 input。llama-server 单请求多 input 是串行处理，32 条在 CPU 上仍可控。 */
export const DEFAULT_MAX_BATCH_SIZE = 32

/**
 * 默认一次请求的字符上限。批量在 CPU 上是串行处理，输入总量越大单个请求越久；
 * 16k 字符（约 1 条默认上下文）能在 write/backfill 预算内完成。
 * 0 = 不限制（调用方自己按条数控制）。
 */
export const DEFAULT_MAX_BATCH_CHARS = 16_000

                                     
                  
               
              
                   
     
                                                             
                                                    
     
                 
     
                                                 
     
                      
     
                                               
                                        
                                                                         
     
                                 
                                                   
                       
                                                      
                        
 

/** 单次调用的批量参数覆盖（比构造参数优先）。 */
                                    
                    
                       
                        
 

/**
 * 批量统计（可观测）。回答"批量到底省了多少请求"：
 * 请求数 / 输入条数 = 平均每请求条数，与 `inputs / requests` 对比即可算出节省。
 */
                                  
                              
                  
                       
                       
                
                          
               
                
                                       
                  
                        
                     
                    
                        
 

/** 内部：一次 HTTP 请求的结果。itemScoped=true 表示"可能只是这一条输入的问题"。 */
                     
                                         
                                                      

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

/** 一个批量请求分组：原始下标 + 文本。回填时要把向量按原顺序写回。 */
                                  
                   
                 
 

/**
 * 按条数 + 字符数把输入切成多个请求分组。顺序保持不变；单条超长文本独占一组
 * （由单条回退兜底，不会因为一条太长而整批失败）。
 */
export function splitBatchGroups(
  texts                   ,
  maxBatchSize         = DEFAULT_MAX_BATCH_SIZE,
  maxBatchChars         = DEFAULT_MAX_BATCH_CHARS,
)                    {
  const size = Math.max(1, Math.floor(maxBatchSize))
  const groups                    = []
  let current                  = { indexes: [], texts: [] }
  let chars = 0
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i] 
    const overCount = current.texts.length >= size
    const overChars = maxBatchChars > 0 && current.texts.length > 0 && chars + text.length > maxBatchChars
    if (current.texts.length > 0 && (overCount || overChars)) {
      groups.push(current)
      current = { indexes: [], texts: [] }
      chars = 0
    }
    current.indexes.push(i)
    current.texts.push(text)
    chars += text.length
  }
  if (current.texts.length > 0) groups.push(current)
  return groups
}

const emptyStats = ()                  => ({
  requests: 0,
  batchRequests: 0,
  fallbackRequests: 0,
  inputs: 0,
  failures: 0,
  failedItems: 0,
  fallbackGroups: 0,
})

export class EmbedClient {
          healthy = true
          lastProbe = 0
  /** 告警节流：失败可能每轮都发生，最多 60s 打一次。 */
          lastWarnAt = 0
          backoffMs = 1000
                   opts                    
                   maxBatchSize        
                   maxBatchChars        
          stats                  = emptyStats()

  constructor(opts                    ) {
    this.opts = opts
    this.maxBatchSize = opts.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE
    this.maxBatchChars = opts.maxBatchChars ?? DEFAULT_MAX_BATCH_CHARS
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

  /** 批量统计快照（拷贝，外部改不到内部状态）。 */
  get embedStats()                  {
    return { ...this.stats }
  }

  resetEmbedStats()       {
    this.stats = emptyStats()
  }

  /** 组装请求头：只有显式配置令牌才带 Authorization——本地 llama-server 不认这个头。 */
          headers()                         {
    const headers                         = { 'content-type': 'application/json' }
    if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`
    return headers
  }

  /**
   * 发一次 HTTP 请求（不改变健康状态，由调用方按回退结果决定）。永不抛。
   * 入参是同一批要一起送的多条文本；响应必须与入参一一对应、维度精确匹配。
   */
          async requestBatch(
    texts                   ,
    signal                         ,
    timeoutMs        ,
    fallback = false,
  )                          {
    this.stats.requests += 1
    if (texts.length > 1) this.stats.batchRequests += 1
    if (fallback) this.stats.fallbackRequests += 1
    const timeout = AbortSignal.timeout(timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    const doFetch = this.opts.fetch ?? fetch
    try {
      const res = await doFetch(this.opts.endpoint, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ input: texts, model: this.opts.model }),
        signal: combined,
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        const reason = `嵌入失败 HTTP ${res.status}（${this.opts.endpoint}）：${body.slice(0, 200)}`
        this.warn(reason)
        return { ok: false, itemScoped: isItemScopedFailure(res.status, body), reason }
      }
      const json = (await res.json())                                              
      const data = json.data
      if (!Array.isArray(data) || data.length !== texts.length) {
        const reason = `嵌入响应不符合预期：data=${Array.isArray(data) ? data.length : typeof data}，期望 ${texts.length} 条`
        this.warn(reason)
        return { ok: false, itemScoped: false, reason }
      }
      const out                 = []
      for (const item of data) {
        const arr = item.embedding
        if (!Array.isArray(arr) || arr.length !== this.opts.dims) {
          const reason = `嵌入维度不符：收到 ${Array.isArray(arr) ? arr.length : typeof arr}，期望 ${this.opts.dims}（模型/后端不匹配？）`
          this.warn(reason)
          return { ok: false, itemScoped: false, reason }
        }
        out.push(toUnitVector(arr))
      }
      return { ok: true, vectors: out }
    } catch (error) {
      const message = (error         )?.name === 'TimeoutError' || (error         )?.name === 'AbortError'
        ? `嵌入请求超时（预算 ${timeoutMs}ms）`
        : `嵌入请求失败：${(error         )?.message ?? String(error)}`
      this.warn(message)
      return { ok: false, itemScoped: false, reason: message }
    }
  }

  /**
   * 批量嵌入：自动分组，整批因"单条输入问题"失败时回退单条重试。
   *
   * 返回数组与入参一一对应：
   *   - `Float32Array` = 成功；
   *   - `null`          = 这一条失败（其它条可能成功，回填队列应只保留失败的）；
   *   - 外层 `null`     = 本次调用没有可用的后端（熔断中/致命失败），一条都没成功。
   *
   * 旧调用方请继续用 `embed()`：它对"部分失败"仍然整体返回 null，保持原契约。
   */
  async embedBatch(
    texts          ,
    signal              ,
    opts                    ,
  )                                             {
    if (texts.length === 0) return []
    if (!this.usable) return null
    const timeoutMs = opts?.timeoutMs ?? this.opts.timeoutMs
    const groups = splitBatchGroups(
      texts,
      opts?.maxBatchSize ?? this.maxBatchSize,
      opts?.maxBatchChars ?? this.maxBatchChars,
    )
    const out                             = new Array(texts.length).fill(null)
    let down = false
    for (const group of groups) {
      const res = await this.requestBatch(group.texts, signal, timeoutMs)
      if (res.ok) {
        for (let i = 0; i < group.indexes.length; i++) out[group.indexes[i] ] = res.vectors[i] 
        continue
      }
      this.stats.failures += 1
      // 只有"看起来是单条输入问题"且确实有多条时才值得拆开重试：
      // 网络断/超时/5xx 拆成 N 条只会把同一个错误重复 N 次。
      if (res.itemScoped && group.texts.length > 1) {
        this.stats.fallbackGroups += 1
        let groupOk = 0
        for (let j = 0; j < group.texts.length; j++) {
          const one = await this.requestBatch([group.texts[j] ], signal, timeoutMs, true)
          if (one.ok) {
            out[group.indexes[j] ] = one.vectors[0] 
            groupOk += 1
            continue
          }
          this.stats.failedItems += 1
          if (!one.itemScoped) {
            down = true // 连单条都遇到网络/协议故障 → 后端不可用
            break
          }
        }
        if (down) break
        // 整组单条回退全失败：不是个别超长输入的问题，按后端故障处理。
        if (groupOk === 0) {
          down = true
          break
        }
        continue
      }
      // 无回退价值：非 2xx（非 400/413/422）、超时、网络异常、响应格式/维度不符。
      this.stats.failedItems += group.indexes.length
      down = true
      break
    }
    this.stats.inputs += texts.length
    if (down) this.markDown()
    else this.markUp()
    return out
  }

  /**
   * Embed texts（旧接口，契约不变：全部成功才返回数组，任何一条失败返回 null）。
   *
   * `opts.timeoutMs` overrides the configured budget per call: the default
   * (interactive) budget is tuned for short search queries, while writing or
   * backfilling FULL record contents on CPU can take seconds. Using the
   * interactive budget there silently failed every long record and poisoned the
   * circuit breaker (measured 3143ms for three ~600-char records on 2026-10-10).
   */
  async embed(texts          , signal              , opts                         )                                 {
    const batch = await this.embedBatch(texts, signal, opts)
    if (batch === null) return null
    for (const vector of batch) if (vector === null) return null
    return batch                  
  }

  /**
   * 真实探针（不是读缓存状态）：临时复位熔断再发一次最小嵌入，
   * 这样「后端已经恢复但熔断还开着」时也能确认恢复。失败会顺带 markDown。
   */
  async healthCheck(timeoutMs = this.opts.timeoutMs)                   {
    this.markUp()
    const batch = await this.embedBatch([HEALTH_PROBE_TEXT], undefined, { timeoutMs })
    return batch !== null && batch[0] !== null && batch[0] !== undefined
  }
}

// ---------------------------------------------------------------------------
// 预热 + 健康探活保活
// ---------------------------------------------------------------------------

/** 保活只需要这一小组能力：EmbedClient / EmbeddingProvider 都天然满足。 */
                               
                             
                                                                                                             
                                        
                                                    
                 
 

                                        
                      
                          
                     
                             
                        
                                                       
                         
                         
                     
                                 
 

                                      
                 
                        
                
                       
                     
                  
                                                           
                    
                  
 

/**
 * 启动 warmup 一次 + 周期探活保活（设计目标见任务书 §4）。
 *
 * - warmup 让 GGUF 进 page cache、llama-server 预热计算图，用户第一条查询不必吃冷启动；
 * - 探活按指数退避（成功 → 基础间隔；失败 → 2x 到上限），后端恢复后自动 markUp 结束熔断；
 * - 定时器全部 `unref()`：插件里跑着它也不会阻止进程退出；`stop()` 幂等。
 */
export class EmbedKeepAlive {
                   target              
                   baseIntervalMs        
                   maxIntervalMs        
                   probeTimeoutMs        
                   warmupText        
                   log                           
          running = false
          currentIntervalMs        
          timer                                       = null
          wake                      = null
          stats                     

  constructor(opts                       ) {
    this.target = opts.target
    this.baseIntervalMs = Math.max(1, opts.intervalMs ?? 30_000)
    this.maxIntervalMs = Math.max(this.baseIntervalMs, opts.maxIntervalMs ?? 300_000)
    this.probeTimeoutMs = Math.max(1, opts.probeTimeoutMs ?? 1500)
    this.warmupText = opts.warmupText ?? HEALTH_PROBE_TEXT
    this.log = opts.log ?? ((message        ) => console.warn(`[dsh-memory-local] ${message}`))
    this.currentIntervalMs = this.baseIntervalMs
    this.stats = {
      warmups: 0,
      warmupFailures: 0,
      probes: 0,
      probeFailures: 0,
      lastProbeAt: 0,
      lastOkAt: 0,
      intervalMs: this.currentIntervalMs,
      running: false,
    }
  }

  /** 只启动一次；重复调用是 no-op。 */
  start()       {
    if (this.running) return
    this.running = true
    this.stats.running = true
    void this.loop().catch(() => {
      /* 保活线程永不把异常抛给宿主 */
    })
  }

  /** 停止并释放定时器；幂等。 */
  stop()       {
    if (!this.running) return
    this.running = false
    this.stats.running = false
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const wake = this.wake
    this.wake = null
    wake?.()
  }

  get isRunning()          {
    return this.running
  }

  get keepAliveStats()                      {
    return { ...this.stats }
  }

  /** 预热一次：真的发一次最小嵌入。失败不抛。 */
  async warmup()                   {
    this.stats.warmups += 1
    this.stats.lastProbeAt = Date.now()
    let ok = false
    try {
      const result = await this.target.embed([this.warmupText], undefined, { timeoutMs: this.probeTimeoutMs })
      ok = result !== null && result[0] !== null && result[0] !== undefined
    } catch {
      ok = false
    }
    if (ok) {
      this.stats.lastOkAt = Date.now()
      this.target.markUp?.()
    } else {
      this.stats.warmupFailures += 1
      this.log('嵌入后端预热失败（首条查询可能吃冷启动延迟）')
    }
    return ok
  }

  /** 探活一次（healthCheck 优先，否则 embed ping）。失败不抛。 */
  async probe()                   {
    this.stats.probes += 1
    this.stats.lastProbeAt = Date.now()
    let ok = false
    try {
      ok = this.target.healthCheck
        ? await this.target.healthCheck(this.probeTimeoutMs)
        : ((await this.target.embed([this.warmupText], undefined, { timeoutMs: this.probeTimeoutMs })) !== null)
    } catch {
      ok = false
    }
    if (ok) {
      this.stats.lastOkAt = Date.now()
      this.target.markUp?.()
    } else {
      this.stats.probeFailures += 1
    }
    return ok
  }

  /** 按当前结果更新退避间隔（成功复位，失败 2x 到上限）。返回新间隔。 */
          applyBackoff(ok         )         {
    this.currentIntervalMs = ok
      ? this.baseIntervalMs
      : Math.min(this.maxIntervalMs, Math.max(this.baseIntervalMs, this.currentIntervalMs * 2))
    this.stats.intervalMs = this.currentIntervalMs
    return this.currentIntervalMs
  }

          async loop()                {
    let first = true
    while (this.running) {
      const ok = first ? await this.warmup() : await this.probe()
      first = false
      if (!this.running) break
      const wait = this.applyBackoff(ok)
      await this.sleep(wait)
    }
  }

          sleep(ms        )                {
    return new Promise      ((resolve) => {
      this.wake = () => {
        this.timer = null
        this.wake = null
        resolve()
      }
      const timer = setTimeout(() => {
        this.timer = null
        const wake = this.wake
        this.wake = null
        wake?.()
      }, ms)
      timer.unref?.()
      this.timer = timer
    })
  }
}


//# sourceURL=source/memory-local/src/embed.ts