/**
 * Minimal OpenAI-compatible /v1/embeddings client for a local llama-server.
 * Fails soft: every failure resolves to `null` so callers can degrade.
 */

export interface EmbedClientOptions {
  endpoint: string
  model: string
  dims: number
  timeoutMs: number
  /**
   * OpenAI 兼容后端的 Bearer 令牌（如 `sk-...`）。缺省=不发 `Authorization`
   * 头，即今天本地 llama-server 的行为；OpenAI/兼容网关缺了它会直接 401。
   */
  apiKey?: string
  /**
   * 注入的 fetch 实现（测试/自定义传输）。缺省=全局 fetch——不影响既有行为。
   */
  fetch?: typeof fetch
  /**
   * 失败时的告警出口（默认 console.warn）。嵌入失败会被静默降级成词法检索，
   * 没有这条日志的话「检索质量突然变差」完全无迹可查——本机最常见的失败是
   * llama-server 的 HTTP 400「input too large」（默认 batch 512 时 >512 token）。
   */
  log?: (message: string) => void
}

/**
 * 把 API 返回的 `number[]` 拷成 Float32Array 并做 L2 归一化（就地）。
 *
 * llama-server / OpenAI 都返回 L2 归一化向量，这里再防御性地归一一次：部分
 * OpenAI 兼容网关（vLLM、LM Studio 的某些模型）返回的是未归一化向量，不归一
 * 会让 cosine 阈值在整个库的尺度上漂移。导出给 embedding-providers.ts 复用，
 * 保证「协议校验 + 归一化」只有一份实现。
 */
export function toUnitVector(values: number[]): Float32Array {
  const v = new Float32Array(values)
  let norm = 0
  for (let i = 0; i < v.length; i++) norm += v[i]! * v[i]!
  const n = Math.sqrt(norm)
  if (n > 0) for (let i = 0; i < v.length; i++) v[i] = v[i]! / n
  return v
}

export class EmbedClient {
  private healthy = true
  private lastProbe = 0
  /** 告警节流：失败可能每轮都发生，最多 60s 打一次。 */
  private lastWarnAt = 0
  private backoffMs = 1000
  private opts: EmbedClientOptions

  constructor(opts: EmbedClientOptions) {
    this.opts = opts
  }

  /** Cheap circuit breaker: skip the network while marked unhealthy. */
  private get usable(): boolean {
    const now = Date.now()
    if (this.healthy) return true
    if (now - this.lastProbe >= this.backoffMs) {
      // allow a retry; double the backoff on continued failure
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000)
      return true
    }
    return false
  }

  private warn(message: string): void {
    const now = Date.now()
    if (now - this.lastWarnAt < 60_000) return
    this.lastWarnAt = now
    ;(this.opts.log ?? ((text: string) => console.warn(`[dsh-memory-local] ${text}`)))(message)
  }

  markDown(): void {
    this.healthy = false
    this.lastProbe = Date.now()
  }

  markUp(): void {
    this.healthy = true
    this.backoffMs = 1000
  }

  get isHealthy(): boolean {
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
  async embed(texts: string[], signal?: AbortSignal, opts?: { timeoutMs?: number }): Promise<Float32Array[] | null> {
    if (texts.length === 0) return []
    if (!this.usable) return null
    const timeout = AbortSignal.timeout(opts?.timeoutMs ?? this.opts.timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    const doFetch = this.opts.fetch ?? fetch
    const headers: Record<string, string> = { 'content-type': 'application/json' }
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
      const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> }
      const data = json.data
      if (!Array.isArray(data) || data.length !== texts.length) {
        this.warn(`嵌入响应不符合预期：data=${Array.isArray(data) ? data.length : typeof data}，期望 ${texts.length} 条`)
        this.markDown()
        return null
      }
      const out: Float32Array[] = []
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
      const message = (error as Error)?.name === 'TimeoutError' || (error as Error)?.name === 'AbortError'
        ? `嵌入请求超时（预算 ${opts?.timeoutMs ?? this.opts.timeoutMs}ms）`
        : `嵌入请求失败：${(error as Error)?.message ?? String(error)}`
      this.warn(message)
      this.markDown()
      return null
    }
  }
}
