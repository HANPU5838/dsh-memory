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
import { EmbedClient, toUnitVector } from './embed.ts'

export type EmbeddingProviderKind = 'local' | 'openai' | 'ollama' | 'off'

export interface EmbeddingProviderIdentity {
  model: string
  dims: number
  pooling?: string
}

export interface EmbeddingProvider {
  readonly kind: EmbeddingProviderKind
  /** 是否需要插件自己拉起本地 llama-server（只有 local 为 true） */
  readonly isLocalServer: boolean
  readonly identity: EmbeddingProviderIdentity
  readonly isHealthy: boolean
  embed(texts: string[], signal?: AbortSignal, opts?: { timeoutMs?: number }): Promise<Float32Array[] | null>
  /**
   * 批量嵌入（可选）：与 `embed()` 的区别是允许**部分成功** —— 返回与入参等长的
   * 数组，单条失败为 `null`；外层 `null` 表示后端整体不可用（一条都没成）。
   * 没有批量能力的 provider 可以不实现，调用方（回填队列）会回退到 `embed()`。
   */
  embedBatch?(texts: string[], signal?: AbortSignal, opts?: { timeoutMs?: number; maxBatchSize?: number; maxBatchChars?: number }): Promise<Array<Float32Array | null> | null>
  healthCheck(timeoutMs?: number): Promise<boolean>
  markUp(): void
  markDown(): void
}

export interface EmbeddingProviderOptions {
  kind: EmbeddingProviderKind
  /** OpenAI 兼容 /v1/embeddings 完整 URL，或 ollama base URL（如 http://127.0.0.1:11434） */
  endpoint: string
  model: string
  dims: number
  pooling?: string
  /** openai 用的 Bearer 令牌；local/ollama/off 忽略 */
  apiKey?: string
  /** 交互式（查询）预算，provider 的默认预算 */
  timeoutMs: number
  /**
   * 写入/回填时调用方传给 `embed(..., { timeoutMs })` 的更长预算。
   * provider 自身不直接使用它（由调用方按场景传入），保留在选项里是为了让
   * index.ts 的 vector 配置能整块透传，不必按 kind 拆字段。
   */
  writeTimeoutMs: number
  /** 测试注入 */
  fetch?: typeof fetch
  log?: (message: string) => void
}

/** 告警节流：失败可能每轮检索都发生，最多 60s 打一条。 */
const WARN_INTERVAL_MS = 60_000
/** 日志里 HTTP 响应体 / 错误原因的最大长度。 */
const MAX_REASON_CHARS = 200
/** 健康探针用的最小文本：一次真实的小嵌入 ≈ 后端真的能服务。 */
const HEALTH_PROBE_TEXT = 'ping'

function defaultWarnSink(message: string): void {
  console.warn(`[dsh-memory-local] ${message}`)
}

/** 把错误压成一段可控长度的原因（不吞根因）。 */
function reasonOf(error: unknown): string {
  const message = (error as Error | null | undefined)?.message ?? String(error)
  return message.slice(0, MAX_REASON_CHARS)
}

/** 统一失败告警出口：带 provider kind、60s 节流。 */
class WarnThrottle {
  private lastWarnAt = 0
  private readonly kind: EmbeddingProviderKind
  private readonly log?: (message: string) => void

  constructor(kind: EmbeddingProviderKind, log?: (message: string) => void) {
    this.kind = kind
    this.log = log
  }

  warn(detail: string): void {
    const now = Date.now()
    if (now - this.lastWarnAt < WARN_INTERVAL_MS) return
    this.lastWarnAt = now
    ;(this.log ?? defaultWarnSink)(`[embedding-provider:${this.kind}] ${detail}`)
  }
}

function identityOf(opts: EmbeddingProviderOptions): EmbeddingProviderIdentity {
  return opts.pooling === undefined
    ? { model: opts.model, dims: opts.dims }
    : { model: opts.model, dims: opts.dims, pooling: opts.pooling }
}

/**
 * `local` / `openai`：完全同一个 OpenAI 兼容 `/v1/embeddings` 协议，
 * 差别只有「是否自带 Bearer 令牌」。复用 EmbedClient = 复用熔断与告警节流，
 * 不重写任何本地逻辑。
 */
class OpenAiCompatibleProvider implements EmbeddingProvider {
  readonly kind: EmbeddingProviderKind
  readonly isLocalServer: boolean
  readonly identity: EmbeddingProviderIdentity
  private readonly timeoutMs: number
  private readonly client: EmbedClient

  constructor(kind: 'local' | 'openai', opts: EmbeddingProviderOptions) {
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

  get isHealthy(): boolean {
    return this.client.isHealthy
  }

  embed(texts: string[], signal?: AbortSignal, opts?: { timeoutMs?: number }): Promise<Float32Array[] | null> {
    return this.client.embed(texts, signal, opts)
  }

  embedBatch(texts: string[], signal?: AbortSignal, opts?: { timeoutMs?: number; maxBatchSize?: number; maxBatchChars?: number }): Promise<Array<Float32Array | null> | null> {
    return this.client.embedBatch(texts, signal, opts)
  }

  /**
   * 真实探针（不是读缓存状态）：临时复位熔断再发一次最小嵌入，
   * 这样「后端已经恢复但熔断还开着」时 healthCheck 也能确认恢复。
   */
  async healthCheck(timeoutMs = this.timeoutMs): Promise<boolean> {
    this.client.markUp()
    const result = await this.client.embed([HEALTH_PROBE_TEXT], undefined, { timeoutMs })
    return result !== null
  }

  markUp(): void {
    this.client.markUp()
  }

  markDown(): void {
    this.client.markDown()
  }
}

/** ollama 只提供单条接口：POST <base>/api/embeddings，body `{model, prompt}`。 */
function ollamaEmbeddingsUrl(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, '')
  if (trimmed === '') return '/api/embeddings'
  // 容忍用户直接填了完整路径，避免 /api/embeddings/api/embeddings。
  return trimmed.endsWith('/api/embeddings') ? trimmed : `${trimmed}/api/embeddings`
}

/**
 * `ollama`：同样零依赖、同样失败软降级，只是协议不同（没有批量接口），
 * 且需要自己维护一份与 EmbedClient 同形的熔断/节流状态。
 */
class OllamaProvider implements EmbeddingProvider {
  readonly kind = 'ollama' as const
  readonly isLocalServer = false
  readonly identity: EmbeddingProviderIdentity
  private readonly endpoint: string
  private readonly model: string
  private readonly dims: number
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch
  private readonly warn: WarnThrottle
  private healthy = true
  private lastProbe = 0
  private backoffMs = 1000

  constructor(opts: EmbeddingProviderOptions) {
    this.identity = identityOf(opts)
    this.endpoint = ollamaEmbeddingsUrl(opts.endpoint)
    this.model = opts.model
    this.dims = opts.dims
    this.timeoutMs = opts.timeoutMs
    this.fetchImpl = opts.fetch ?? fetch
    this.warn = new WarnThrottle('ollama', opts.log)
  }

  /** 与 EmbedClient 同形的廉价熔断：不健康时跳过网络，按指数退避放行一次探测。 */
  private get usable(): boolean {
    const now = Date.now()
    if (this.healthy) return true
    if (now - this.lastProbe >= this.backoffMs) {
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000)
      return true
    }
    return false
  }

  get isHealthy(): boolean {
    return this.healthy
  }

  markUp(): void {
    this.healthy = true
    this.backoffMs = 1000
  }

  markDown(): void {
    this.healthy = false
    this.lastProbe = Date.now()
  }

  async embed(texts: string[], signal?: AbortSignal, opts?: { timeoutMs?: number }): Promise<Float32Array[] | null> {
    if (texts.length === 0) return []
    if (!this.usable) return null
    const timeoutMs = opts?.timeoutMs ?? this.timeoutMs
    const out: Float32Array[] = []
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

  /**
   * ollama 没有批量接口，这里逐条串行并保留"部分成功"语义：
   * 单条失败只留 null，不牵连其它条（超长记录不会再毒死整批回填）。
   */
  async embedBatch(
    texts: string[],
    signal?: AbortSignal,
    opts?: { timeoutMs?: number; maxBatchSize?: number; maxBatchChars?: number },
  ): Promise<Array<Float32Array | null> | null> {
    if (texts.length === 0) return []
    if (!this.usable) return null
    const timeoutMs = opts?.timeoutMs ?? this.timeoutMs
    const out: Array<Float32Array | null> = []
    let ok = 0
    for (const text of texts) {
      const value = await this.embedOne(text, signal, timeoutMs)
      if (value !== null) ok += 1
      out.push(value)
    }
    if (ok > 0) this.markUp()
    return out
  }

  private async embedOne(text: string, signal: AbortSignal | undefined, timeoutMs: number): Promise<Float32Array | null> {
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
      const json = (await res.json()) as { embedding?: unknown }
      const embedding = json.embedding
      if (!Array.isArray(embedding) || embedding.length !== this.dims) {
        this.warn.warn(`嵌入维度不符：收到 ${Array.isArray(embedding) ? embedding.length : typeof embedding}，期望 ${this.dims}（模型/后端不匹配？）`)
        this.markDown()
        return null
      }
      return toUnitVector(embedding as number[])
    } catch (error) {
      const name = (error as Error | null | undefined)?.name
      const detail = name === 'TimeoutError' || name === 'AbortError'
        ? `嵌入请求超时（预算 ${timeoutMs}ms）`
        : `嵌入请求失败：${reasonOf(error)}`
      this.warn.warn(detail)
      this.markDown()
      return null
    }
  }

  /** 真实探针（绕过熔断），失败走同一份节流告警。 */
  async healthCheck(timeoutMs = this.timeoutMs): Promise<boolean> {
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
class OffEmbeddingProvider implements EmbeddingProvider {
  readonly kind = 'off' as const
  readonly isLocalServer = false
  readonly identity: EmbeddingProviderIdentity

  constructor(opts: EmbeddingProviderOptions) {
    this.identity = identityOf(opts)
  }

  get isHealthy(): boolean {
    return false
  }

  async embed(_texts: string[], _signal?: AbortSignal, _opts?: { timeoutMs?: number }): Promise<Float32Array[] | null> {
    return null
  }

  async healthCheck(_timeoutMs?: number): Promise<boolean> {
    return false
  }

  markUp(): void {
    /* 恒关闭：没有可恢复的健康状态 */
  }

  markDown(): void {
    /* 恒关闭 */
  }
}

/**
 * 按配置创建嵌入后端。kind 由类型限定为四种；运行时拿到未知值说明配置/面板
 * 传了脏数据，直接抛错（构造期暴露，而不是让检索静默退化成词法）。
 */
export function createEmbeddingProvider(opts: EmbeddingProviderOptions): EmbeddingProvider {
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
      throw new Error(`未知的嵌入后端 kind=${String((opts as { kind?: unknown }).kind)}（支持 local/openai/ollama/off）`)
  }
}
