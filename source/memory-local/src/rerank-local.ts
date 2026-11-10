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
  type LlmInvoke,
  type RerankCandidate,
  type RerankConfig,
  type RerankOutcome,
} from './rerank.ts'

export interface LocalRerankOptions {
  /** llama-server 的 chat completions 地址（完整 URL 或 base URL，如 http://127.0.0.1:8079）。 */
  endpoint: string
  /** chat 模型名（llama-server 里 --alias 的名字，随便填也行）。 */
  model: string
  /** 显式关闭（默认：endpoint + model 都有就启用）。 */
  enabled?: boolean
  /** Bearer 令牌（本地 llama-server 不需要）。 */
  apiKey?: string
  /** 单次重排预算（默认 1500ms；慢设备上 1-4B 模型给 3-8s 更现实）。 */
  timeoutMs?: number
  /** 最多送多少条候选（默认 10）。 */
  topN?: number
  /** 最终分 = (1-weight)*recall + weight*llm（默认 0.6）。 */
  weight?: number
  /** 每日 token 预算（默认 200k，与宿主重排一致）。 */
  dailyBudgetTokens?: number
  /** 生成上限（默认 256 tokens：只输出一个 JSON 数组）。 */
  maxOutputTokens?: number
  /** 采样温度（默认 0，打分要稳定）。 */
  temperature?: number
  /** 告警出口（默认 console.warn）。 */
  log?: (message: string) => void
  /** 注入 fetch（测试）。 */
  fetch?: typeof fetch
}

export interface LocalRerankStats {
  /** 发出的 chat completions 请求数 */
  requests: number
  /** 失败次数（网络/超时/协议/解析） */
  failures: number
  /** 未能产出可用分数的次数（跳过 / 失败 / 解析不出） */
  noOutcome: number
  /** 最近一次请求耗时（ms） */
  lastLatencyMs: number
  /** 今日已花 token（估算） */
  budgetUsedTokens: number
  /** 当前是否处于熔断（不可用）状态 */
  healthy: boolean
}

/** 把用户填的地址规范化成 /v1/chat/completions 完整 URL。 */
export function chatCompletionsUrl(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, '')
  if (trimmed === '') return '/v1/chat/completions'
  if (trimmed.endsWith('/chat/completions')) return trimmed
  if (trimmed.endsWith('/v1')) return `${trimmed}/chat/completions`
  return `${trimmed}/v1/chat/completions`
}

/** 从 chat completions 响应里取内容；格式不对返回 null。 */
export function parseChatContent(json: unknown): string | null {
  const choices = (json as { choices?: unknown })?.choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const first = choices[0] as { message?: { content?: unknown }; text?: unknown }
  if (typeof first?.message?.content === 'string') return first.message.content
  if (typeof first?.text === 'string') return first.text // /v1/completions 形态
  return null
}

export class LocalReranker {
  private readonly opts: LocalRerankOptions
  private readonly url: string
  private readonly timeoutMs: number
  private readonly topN: number
  private readonly weight: number
  private readonly maxOutputTokens: number
  private readonly temperature: number
  private readonly fetchImpl: typeof fetch
  private readonly log: (message: string) => void
  private readonly budget: DailyBudget
  private healthy = true
  private lastProbe = 0
  private backoffMs = 1000
  private lastWarnAt = 0
  private stats: LocalRerankStats

  constructor(opts: LocalRerankOptions) {
    this.opts = opts
    this.url = chatCompletionsUrl(opts.endpoint)
    this.timeoutMs = Math.max(50, opts.timeoutMs ?? 1500)
    this.topN = Math.max(2, Math.floor(opts.topN ?? 10))
    this.weight = Math.min(1, Math.max(0, opts.weight ?? 0.6))
    this.maxOutputTokens = Math.max(16, Math.floor(opts.maxOutputTokens ?? 256))
    this.temperature = opts.temperature ?? 0
    this.fetchImpl = opts.fetch ?? fetch
    this.log = opts.log ?? ((message: string) => console.warn(`[dsh-memory-local] ${message}`))
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

  get isEnabled(): boolean {
    return this.opts.enabled !== false && this.opts.endpoint.trim() !== '' && this.opts.model.trim() !== ''
  }

  get isHealthy(): boolean {
    return this.healthy
  }

  /** 当前配置对应的 RerankConfig（方便宿主把 llm 配置整块交给面板显示）。 */
  get config(): RerankConfig {
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

  get statsSnapshot(): LocalRerankStats {
    return { ...this.stats, budgetUsedTokens: this.budget.usedToday, healthy: this.healthy }
  }

  markUp(): void {
    this.healthy = true
    this.backoffMs = 1000
  }

  markDown(): void {
    this.healthy = false
    this.lastProbe = Date.now()
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

  private warn(message: string): void {
    const now = Date.now()
    if (now - this.lastWarnAt < 60_000) return
    this.lastWarnAt = now
    this.log(`[rerank-local] ${message}`)
  }

  /**
   * 发一次 chat completions。失败抛错（由 rerank.ts 的上层 catch 静默回退），
   * 同时更新熔断/统计。`signal` 来自 rerank.ts 的 timeout 组合。
   */
  private async chat(system: string, prompt: string, signal: AbortSignal | undefined, maxTokens: number): Promise<string> {
    if (!this.usable) throw new Error('本地重排熔断中')
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    const headers: Record<string, string> = { 'content-type': 'application/json' }
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
      const json: unknown = await res.json()
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
      const name = (error as Error | null | undefined)?.name
      this.warn(name === 'TimeoutError' || name === 'AbortError'
        ? `重排请求超时（预算 ${this.timeoutMs}ms）`
        : `重排请求失败：${(error as Error)?.message ?? String(error)}`)
      throw error
    }
  }

  /**
   * 供现有 rerank.ts 直接消费的 LlmInvoke（system/prompt/signal 三件套）。
   * 这就是接入点：`this.llmInvoke = new LocalReranker(cfg).asInvoke()`。
   */
  asInvoke(): LlmInvoke {
    return (req) => this.chat(req.system, req.prompt, req.signal, this.maxOutputTokens)
  }

  /** 直接调用（等价于 asInvoke() 展开）；失败抛错，调用方应 catch。 */
  async invoke(req: { system: string; prompt: string; signal?: AbortSignal }): Promise<string> {
    return this.chat(req.system, req.prompt, req.signal, this.maxOutputTokens)
  }

  /** 真实探针：发一次 1 token 的最小请求。失败返回 false（不抛）。 */
  async healthCheck(timeoutMs = this.timeoutMs): Promise<boolean> {
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
    query: string,
    candidates: RerankCandidate[],
    opts?: { signal?: AbortSignal; budget?: DailyBudget },
  ): Promise<RerankOutcome | null> {
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
    query: string,
    candidates: RerankCandidate[],
    opts?: { signal?: AbortSignal; budget?: DailyBudget },
  ): Promise<Array<{ id: string; score: number }> | null> {
    const outcome = await this.rerank(query, candidates, opts)
    if (outcome === null) return null
    return blendScores(candidates, outcome, this.weight)
  }
}
