/**
 * Memory injection logic (M3) — pure functions, no cordis imports.
 *
 * Injection shape follows the official docs: a user-role message whose content
 * is a single `context` block with `contextForm: 'recall'`, prepended to the
 * messages that enter the step via the agent/pre-step waterfall.
 */
import type { MemoryHit, MemoryRecord } from 'dsh-memory'
import { estimateTokens } from '../../memory-local/src/rerank.ts'
import { normalizeScopeInput } from '../../memory-local/src/scope.ts'
import { textHasTag } from './signals.ts'
import { recordKindPrefix } from './digest.ts'
import { InjectionState } from './state.ts'

export interface InjectConfig {
  enabled: boolean
  /** Token budget for the injected recall block. */
  tokenBudget: number
  /** Max memories per injection. */
  topK: number
  /**
   * 额外参与召回的 scope 名(走同一套规范化);非法项忽略并记一行日志。
   * 默认集合是 provider 给的 [当前会话, 当前项目, global] —— 与 memory_search 的默认一致。
   */
  extraScopes?: string[]
}

export const defaultInjectConfig: InjectConfig = {
  enabled: true,
  tokenBudget: 500,
  topK: 5,
}

/** 召回注入能用到的那部分 provider 能力。 */
export interface InjectMemoryService {
  search(input: unknown): Promise<MemoryHit[]>
  resolveReadScopes?(agent: unknown): string[]
  /**
   * 显式「记忆可见范围」覆盖(undefined = 未设置)。设置后它就是完整白名单:
   * 不并入 inject.extraScopes,也不追加 fork 父会话。
   */
  visibleScopes?(agent: unknown): string[]
  /** 完整可见域(等级 + 每个 scope 的类型白名单);用于按类型收窄召回。 */
  visibilityPolicy?(agent: unknown): { level: 'absolute' | 'normal' | 'none'; scopes: Array<{ scope: string; kinds?: string[] }> } | undefined
  /** 当前已退役的记录 id;可选,老 provider 没有时注入层自己按 supersedes 扫描。 */
  supersededIds?(scopes?: string[]): string[]
  /** 按 id / 前缀取记录(memory_get 正文去重用);老 provider 没有时跳过去重标记。 */
  getByIds?(ids: string[]): Array<{ id: string; updatedAt: number }>
}

/** 宿主里"按会话 id 找 live session"的那一小部分能力(拿不到就不做父会话召回)。 */
export interface SessionRegistry {
  get?(id: string): unknown
}

/**
 * 把 config.extraScopes 规范化成 scope 键列表;非法项忽略并记一行日志
 * (配置写错不该让整个注入半边失效)。
 */
export function normalizeExtraScopes(raw: readonly string[], warn: (message: string) => void = console.warn): string[] {
  const out: string[] = []
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
export function autoRecallScopes(scopes: readonly string[] | undefined): string[] | undefined {
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
  memory: InjectMemoryService,
  agent: unknown,
  extraScopes: readonly string[],
  sessions: SessionRegistry | undefined,
): string[] | undefined {
  // 会话设置了显式可见范围时,它就是白名单:extraScopes / 父会话都不能把它撑大。
  // 空数组也要原样返回(表示什么都不允许读),不能当成"没设置"。
  let explicit: string[] | undefined
  try {
    const visible = memory.visibleScopes?.(agent)
    if (Array.isArray(visible)) explicit = [...visible]
  } catch { /* 拿不到覆盖就按默认集合 */ }
  if (explicit !== undefined) return explicit

  const scopes: string[] = []
  try {
    for (const scope of memory.resolveReadScopes?.(agent) ?? []) {
      if (!scopes.includes(scope)) scopes.push(scope)
    }
  } catch { /* 降级为 extraScopes */ }
  for (const scope of extraScopes) if (!scopes.includes(scope)) scopes.push(scope)
  // fork 出来的会话:父会话的记忆也值得召回(只读)。父会话可能已不在内存里,拿不到就跳过。
  try {
    const header = (agent as { session?: { header?: { parentSession?: unknown; origin?: unknown } } } | undefined)?.session?.header
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
export interface InputMessageView {
  role: string
  content: ReadonlyArray<{ type: string; text?: string }>
  /** 宿主消息来源;人类输入是 user,记忆/runtime/time 等是合成上下文。 */
  source?: { kind?: string }
}

export interface PreStepView {
  messages: readonly InputMessageView[]
  signal?: AbortSignal
  /**
   * 召回范围(scope 键列表:当前会话 + 当前项目 + global + 额外配置)。
   * 由宿主侧 apply.ts 解析 —— 会话 id / cwd 只在 agent/pre-step 的 payload 里,
   * 这里是纯函数层,拿不到也不该去猜。缺省(undefined)时由 provider 用它自己的默认集合。
   */
  scopes?: readonly string[]
  /** 可见域按 scope 的类型白名单(scope → 允许的 kind);缺省 = 不按类型过滤。 */
  kinds?: Record<string, readonly string[]>
  /** 当前会话 id;按会话管理去重状态,缺省时退化为单进程兜底桶。 */
  sessionId?: string
}

export interface PreStepDecisionView {
  messages: readonly InputMessageView[]
}

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
export function pickQueryText(messages: readonly InputMessageView[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role !== 'user') continue
    const kind = m.source?.kind
    if (kind !== undefined && kind !== '' && kind !== 'user') continue
    const text = (m.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text!)
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
  messages: ReadonlyArray<InputMessageView & { source?: { kind?: string } }>,
  text: string,
): boolean {
  for (const m of messages) {
    if (m.role !== 'user') continue
    if (m.source?.kind !== 'memory') continue
    const joined = (m.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text!)
      .join('\n')
    if (joined === text) return true
  }
  return false
}

/** 召回的两种形态:旧的长文(300 字)与新的"印象"(短摘要 + 指路取全文)。 */
export interface RecallRenderOptions {
  /** 每条保留多少字(仅 impression 形态生效)。 */
  chars?: number
  /** 是否用"印象"形态。 */
  impression?: boolean
  /** 0.35.4：当前会话 id，传给 transform（钩子按会话判断时用）。 */
  sessionId?: string
  /**
   * 0.70.0：按相对相关度动态分配每条字数（默认开）。
   * `false` = 回到固定 `chars` 字（面板「设置 → 印象形态」可切换）。
   */
  dynamic?: boolean
  /**
   * 0.35.4：渲染前对召回记录做解析（before-inject 钩子）。
   * 返回改写后的记录数组；被丢弃的 id 会以 reason='hook' 计入 omitted。
   * 由 apply 层把 provider 的 parseForInject 包装进来，渲染函数本身保持纯净。
   */
  transform?: (records: readonly MemoryRecord[], sessionId?: string) => { records: readonly MemoryRecord[]; droppedIds?: ReadonlySet<string> }
}

export interface RecallOmission {
  id: string
  reason: 'top_k' | 'budget' | 'hook'
}

export interface RecallBlock {
  text: string
  tokens: number
  /** 正文实际写入的 id。 */
  ids: string[]
  omitted: RecallOmission[]
}

/** Render hits into a recall text block, greedily within the token budget. */
export function renderRecallBlock(
  hits: MemoryHit[],
  cfg: InjectConfig,
  options: RecallRenderOptions = {},
): RecallBlock | null {
  if (hits.length === 0) return null
  // 0.35.4：before-inject 钩子先解析召回记录 —— 可改写正文或丢弃整条。
  // 丢弃的要计入 omitted（审计要能解释"为什么某条没进上下文"）。
  let effectiveHits = hits
  const droppedIds = new Set<string>()
  if (options.transform !== undefined) {
    try {
      const transformed = options.transform(hits.map((h) => h.record), options.sessionId)
      const byId = new Map(transformed.records.map((record) => [record.id, record]))
      effectiveHits = hits
        .filter((h) => byId.has(h.record.id))
        .map((h) => ({ ...h, record: byId.get(h.record.id)! }))
      for (const id of transformed.droppedIds ?? []) droppedIds.add(id)
      // 变换后没给 droppedIds 但记录变少了：按差集兜底。
      if (transformed.droppedIds === undefined) {
        for (const h of hits) if (!byId.has(h.record.id)) droppedIds.add(h.record.id)
      }
    } catch { /* 解析失败 = 没解析：记录原样进入上下文 */ }
  }
  const impression = options.impression === true
  const chars = impression ? (options.chars ?? 120) : 300
  // 0.69.0：按相对相关度动态分配「每条保留多少字」（0.55×–1.30×，下限 48 字）。
  // 总 tokenBudget 不变：高相关记忆多给正文、低相关收紧摘要，避免平均主义把预算
  // 摊给弱命中。相关度取 hit.score / 本轮最高分；分数缺失/非法时按 1 处理（不惩罚）。
  const maxScore = effectiveHits.reduce((max, h) => (Number.isFinite(h.score) && h.score > max ? h.score : max), 0)
  const dynamic = options.dynamic !== false
  const charsFor = (hit: MemoryHit): number => {
    if (!dynamic) return chars
    const ratio = maxScore > 0 && Number.isFinite(hit.score) ? Math.max(0, Math.min(1, hit.score / maxScore)) : 1
    return Math.max(48, Math.round(chars * (0.55 + 0.75 * ratio)))
  }
  const header = impression
    ? '以下是与你这次请求可能相关的记忆摘要：'
    : '以下是与此请求可能相关的记忆，供参考（需要正文用 memory_get；与本轮无关的用 memory_block 屏蔽，可逆、不删数据）：'
  let tokens = estimateTokens(header) + 4
  const lines: string[] = []
  const ids: string[] = []
  const omitted: RecallOmission[] = []
  let budgetExhausted = false
  // 被钩子丢弃的记录：审计里要给出原因，不能凭空消失。
  for (const h of hits) {
    if (droppedIds.has(h.record.id)) omitted.push({ id: h.record.id, reason: 'hook' })
  }
  for (const [index, h] of effectiveHits.entries()) {
    if (index >= cfg.topK) {
      omitted.push({ id: h.record.id, reason: 'top_k' })
      continue
    }
    if (budgetExhausted) {
      omitted.push({ id: h.record.id, reason: 'budget' })
      continue
    }
    const line = `- ${h.record.id.slice(0, 8)} ${recordKindPrefix(h.record)}${h.record.content.replace(/\s+/g, ' ').slice(0, charsFor(h))}`
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
export function recallText(text: string): string {
  return text
}

/** 配置既可以给静态值,也可以给 getter —— 面板改了设置,下一步就生效。 */
type ConfigSource<T> = T | (() => T)

export interface RecallTriggerOptions {
  sessionId?: string
  /** 行为信号触发的查询;缺省用最后一条用户消息。 */
  query?: string
  /** 触发原因,写入审计;默认 turn_start。 */
  trigger?: string
  /** 这些 id 已被 supersede,不注入正文。 */
  excludeIds?: ReadonlySet<string>
  /** 即使与上次查询相同也重新检索(用于明确的失败/阶段事件)。 */
  force?: boolean
  /** 标签触发时命中的标签;requireTag 打开时只接受带该标签的记录。 */
  tag?: string
  requireTag?: boolean
}

export interface RecallResult {
  text?: string
  /** 正文注入的 id（评估选中，不必然等于本次新增）。 */
  ids: string[]
  /** 本次真正新增到文本里的 id；文本与上次相同/去重时为空。 */
  newlyAddedIds?: string[]
  /** 被去重跳过的 id。 */
  dedupIds?: string[]
  candidates: number
  dedupSkipped: number
  updated: string[]
  omitted: RecallOmission[]
  query: string
  tokens: number
  /** 阶段计数，供审计核对。 */
  rawHits?: number
  tagFiltered?: number
  supersededExcluded?: number
  expiredExcluded?: number
  lastTextSame?: boolean
  retrieval: { ok: boolean; count: number; error?: string; errorCode?: string }
  /** 0.67.0：本次候选中由图增强（PPR 多跳）补召回进来的条数。 */
  graphExpanded?: number
}

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
  private readonly search: (query: string, signal?: AbortSignal, scopes?: readonly string[], kinds?: Record<string, readonly string[]>, sessionId?: string) => Promise<MemoryHit[]>
  private readonly cfg: ConfigSource<InjectConfig>
  private readonly renderOptions: ConfigSource<RecallRenderOptions>
  private readonly state: InjectionState

  constructor(
    search: (query: string, signal?: AbortSignal, scopes?: readonly string[], kinds?: Record<string, readonly string[]>, sessionId?: string) => Promise<MemoryHit[]>,
    cfg: ConfigSource<InjectConfig>,
    renderOptions: ConfigSource<RecallRenderOptions> = {},
    state: InjectionState = new InjectionState(),
  ) {
    this.search = search
    this.cfg = cfg
    this.renderOptions = renderOptions
    this.state = state
  }

  async maybeInject(
    input: PreStepView,
    _decision: PreStepDecisionView,
    options: RecallTriggerOptions = {},
  ): Promise<string | undefined> {
    const result = await this.maybeInjectDetailed(input, _decision, options)
    return result?.text
  }

  async maybeInjectDetailed(
    input: PreStepView,
    _decision: PreStepDecisionView,
    options: RecallTriggerOptions = {},
  ): Promise<RecallResult | undefined> {
    const cfg = typeof this.cfg === 'function' ? this.cfg() : this.cfg
    if (!cfg.enabled) return undefined
    const query = options.query ?? pickQueryText(input.messages)
    if (!query) return undefined
    const sessionId = options.sessionId ?? input.sessionId

    let hits: MemoryHit[]
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
    const block = renderRecallBlock(freshHits, cfg, { ...optionsForRender, sessionId })
    const graphExpanded = candidates.filter((hit) => (hit as { graphExpanded?: boolean }).graphExpanded === true).length
    const base: RecallResult = {
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
      const record = freshHits.find((hit) => hit.record.id === id)!.record
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
export function sessionIdOf(agent: unknown): string | undefined {
  const id = (agent as { session?: { id?: unknown } } | undefined)?.session?.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/** 摘要注入最多记住多少个会话(一个进程里开过的会话上界,防止 Set 无限长)。 */
const MAX_DIGESTED_SESSIONS = 500

/**
 * 会话摘要注入器:一个会话只注入一次"已有哪些记忆"的摘要。
 * 检索失败或结果为空也标记为已完成 —— 摘要不是必需品,不能每步重试。
 */
export class MemoryDigester {
  private readonly done = new Set<string>()
  private readonly list: (scopes: readonly string[] | undefined, agent?: unknown) => Promise<MemoryRecord[]>

  constructor(
    list: (scopes: readonly string[] | undefined, agent?: unknown) => Promise<MemoryRecord[]>,
  ) {
    this.list = list
  }

  async maybeDigest(
    sessionId: string | undefined,
    scopes: readonly string[] | undefined,
    render: (records: MemoryRecord[]) => string | null,
  ): Promise<string | undefined> {
    if (sessionId === undefined || this.done.has(sessionId)) return undefined
    this.markDone(sessionId)
    let records: MemoryRecord[]
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
  async maybeDigestDetailed<T>(
    sessionId: string | undefined,
    scopes: readonly string[] | undefined,
    render: (records: MemoryRecord[]) => T | null,
  ): Promise<T | undefined> {
    const outcome = await this.maybeDigestOutcome(sessionId, scopes, render)
    return outcome.status === 'ok' ? outcome.value : undefined
  }

  /**
   * 带状态的摘要评估：审计需要区分“没有会话 / 已经做过 / 加载失败 / 成功但为空”。
   * 仍然保持旧行为：每个会话只尝试一次（加载失败也不重试），避免每步打网络。
   */
  async maybeDigestOutcome<T>(
    sessionId: string | undefined,
    scopes: readonly string[] | undefined,
    render: (records: MemoryRecord[]) => T | null,
    agent?: unknown,
  ): Promise<
    | { status: 'ok'; value?: T; empty: boolean; candidates: number }
    | { status: 'failed'; errorCode: string }
    | { status: 'skipped'; reasonCode: 'no_session' | 'already_done' }
  > {
    if (sessionId === undefined) return { status: 'skipped', reasonCode: 'no_session' }
    if (this.done.has(sessionId)) return { status: 'skipped', reasonCode: 'already_done' }
    this.markDone(sessionId)
    let records: MemoryRecord[]
    try {
      records = await this.list(scopes, agent)
    } catch {
      return { status: 'failed', errorCode: 'source_load_failed' }
    }
    let value: T | null
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

  private markDone(sessionId: string): void {
    this.done.add(sessionId)
    if (this.done.size > MAX_DIGESTED_SESSIONS) {
      const oldest = this.done.values().next()
      if (!oldest.done) this.done.delete(oldest.value)
    }
  }

  /** 从持久化状态恢复「这个会话已经做过摘要」,避免插件重载后重复注入。 */
  seedDone(sessionId: string | undefined): void {
    if (sessionId !== undefined) this.markDone(sessionId)
  }

  isDone(sessionId: string | undefined): boolean {
    return sessionId !== undefined && this.done.has(sessionId)
  }

  /** 上下文被压缩/重建后重新允许摘要评估(旧摘要可能已不在上下文里)。 */
  reset(sessionId: string | undefined): void {
    if (sessionId !== undefined) this.done.delete(sessionId)
  }
}
