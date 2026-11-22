/**
 * Tool implementations as plain data + functions. Keeping them free of both
 * cordis and dsh-tools imports lets us unit-test the exact argument/response
 * contracts standalone; the DSH entry (apply.ts) wraps them with defineTool.
 *
 * scope 语义(0.5.0 起):
 *   - 省略 scope:写 → 当前会话;读 → 会话 + 项目 + global 三路合并(provider 决定具体键);
 *   - 'global' / 'project' / 任意自定义名 / 'session:<id>' / 'project:<path>' 都是显式 pin;
 *   - 'all'(或 '*')只对读路径有效,写路径报 SCOPE_NOT_WRITABLE。
 * 解析全部交给 `memory-local/scope.ts` 的 normalizeScopeInput + provider 的
 * resolveReadScopes/resolveWriteScope —— 这里**不再**有任何"smoothing over"式的静默回退。
 */
import type { MemoryScope } from 'dsh-memory'
import { resolve } from 'node:path'
import { canonicalWorkspacePath, defaultScopeDescription, isAbsoluteWorkspacePath, normalizeScopeInput, resolveScopeRef } from '../../memory-local/src/scope.ts'

/** Shape each tool shares: JSON-schema parameters + canonical output value. */
export interface ToolSpec<A, O> {
  name: string
  description: string
  parameters: unknown
  execute(args: A, exec?: unknown): Promise<O>
}

/** provider 的 getByIds 返回的记录形状（工具层只读这些字段）。 */
export interface GetSourceRecord {
  id: string
  scope: string
  kind: string
  content: string
  tags: string[]
  importance: number
  createdAt: number
  updatedAt: number
  expiredAt?: number
  supersedes?: string
  triggers?: string[]
  /** 0.24.0：作用域初始化记录（目录/说明的来源标记）。 */
  initial?: boolean
}

/** 范围外访问的处理方式(与 provider 的会话可见域一致)。 */
export type VisibilityLevel = 'absolute' | 'normal' | 'none'

/** 一次范围外审批的结局:允许一次 / 用户拒绝 / 超时未答 / 当前版本不支持审批。 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'timeout' | 'unavailable'

/**
 * 一次范围外审批的结论(0.21.0)。
 *
 * `allowed-once` 默认 = 本次请求**全部**允许;用户在审批卡里逐条勾选时，可带
 * `allowedIds` 只允许其中一部分。老 provider 可能仍直接返回字符串，工具层兼容。
 */
export interface ApprovalDecision {
  outcome: ApprovalOutcome
  /** 只允许这些条目 id;省略 = allowed-once 覆盖本次请求的全部条目。 */
  allowedIds?: string[]
}

/** provider 的 requestOutOfScope 可以返回裸字符串(旧口径)或带 allowedIds 的对象。 */
export type ApprovalAnswer = ApprovalOutcome | ApprovalDecision

/**
 * 被可见域挡住、没有返回给模型的原因。
 *   - out-of-scope = 普通限制下「作用域不在范围内」，检索默认不自动弹审批（0.27）;
 *   - rejected / timeout / unavailable / partial = 普通限制审批的结局;
 *   - absolute = 绝对限制下作用域根本不在范围内(0.23 起不再假装"不存在");
 *   - read-disabled = 作用域在范围内但「可读」开关被关掉(0.23)。
 */
export type WithheldReason = 'out-of-scope' | 'rejected' | 'timeout' | 'unavailable' | 'partial' | 'absolute' | 'read-disabled' | 'scope-disabled' | 'blocked'

export interface VisibilityRuleView {
  scope: string
  /** false = 该作用域不可读(0.23.0 的可读状态按钮)。省略 = 可读。 */
  read?: boolean
  /** false = 该作用域不可写。省略 = 可写。 */
  write?: boolean
  /** 省略/空 = 该作用域全部类型可见。 */
  kinds?: string[]
}

/**
 * provider 解析出的生效可见域。0.20.0 起 provider 永远返回一份策略:
 * 没有显式覆盖时是「会话 + 项目 + global」+ 普通限制,`source === 'default'`。
 * 老 provider 仍可能返回 undefined(视为不限制)。
 */
export interface VisibilityPolicyView {
  level: VisibilityLevel
  scopes: VisibilityRuleView[]
  /** 这份策略的来源:显式保存 / 继承父会话 / 默认策略。 */
  source?: 'explicit' | 'inherited' | 'default'
}

/** 一条范围外命中,交给审批浮层展示。 */
export interface VisibilityApprovalItem {
  id: string
  scope: string
  kind: string
  content: string
  tags: string[]
  importance: number
  updatedAt: number
  reason: 'scope' | 'kind'
}

/**
 * 一个会话的上下文去重视图(0.21.0)。由入口从注入半边提供的
 * `memoryContextDedup` 服务接进来；没有时工具保持老行为(每次都带摘要)。
 *
 * 为什么要它：memory_search / memory_list 的摘要在同一会话里重复命中时
 * 会把同样的内容反复塞回上下文。工具层只问“这条是否已经以同版本出现过”，
 * 具体状态(摘要/正文/版本)由注入半边的 InjectionState 统一维护。
 */
export interface ContextDedupView {
  /** 这批记录里哪些已经以同版本进入过上下文。 */
  seen(records: ReadonlyArray<{ id: string; updatedAt: number }>): Set<string>
  /** memory_search 返回了摘要。 */
  markSummary(records: ReadonlyArray<{ id: string; updatedAt: number }>): void
  /** memory_list 返回了正文。 */
  markContent(records: ReadonlyArray<{ id: string; updatedAt: number }>): void
}

/**
 * 目录工具的一行（与 provider 的 ScopeCatalogEntry 同形）。
 * `absolute` 下范围外条目仍会出现，但 readable/writable/canRequest* 全为 false。
 */
export interface ScopeCatalogEntryView {
  scope: string
  name?: string
  description?: string
  origin: 'global' | 'project' | 'session' | 'custom'
  records?: number
  inScope: boolean
  readable: boolean
  writable: boolean
  canRequestRead: boolean
  canRequestWrite: boolean
  accessStatus: 'default' | 'read-only' | 'read-write' | 'restricted' | 'unavailable' | 'archived'
  updatedAt: number
  /** 0.30.0：所属会话在宿主里已归档（读写冻结，恢复会话后自动复原）。 */
  archived?: boolean
  /** 0.32.0：归档来源 —— 会话归档 / 用户归档的项目作用域。 */
  archivedKind?: 'session' | 'project'
  /** 0.32.0：该作用域被 Agent 主动屏蔽（不删数据，解除后立刻复原）。 */
  blocked?: boolean
  /** 屏蔽的作用层级（`blocked=true` 时给出）。 */
  blockedLevel?: 'session' | 'workspace'
  /** 0.24.0 / D5：初始化记录正文；absolute 下不返回。 */
  initialRecords?: Array<{ id: string; kind: string; content: string; truncated?: boolean }>
}

// ---------------------------------------------------------------- 屏蔽（0.32.0）

/** 屏蔽的作用层级：会话级只影响本会话；工作区级影响该工作区所有会话。 */
export type BlockLevelView = 'session' | 'workspace'

/** provider 一条屏蔽的视图。 */
export interface MemoryBlockView {
  id: string
  level: BlockLevelView
  scope?: string
  recordId?: string
  prefix?: string
  recordKind?: string
  createdAt: number
  createdBy: string
  reason?: string
}

/** `requestBlock` 的结果。 */
export interface BlockResultView {
  outcome: 'blocked' | 'rejected' | 'timeout' | 'unavailable'
  blocks: MemoryBlockView[]
  records: Array<{ id: string; scope: string; kind: string }>
  containsRule?: boolean
  approvalId?: string
}

/** provider 统一授权判定的结果（0.24.0）。 */
export interface AccessDecisionView {
  allowed: boolean
  reason?: string
  /** 这次拒绝能否通过用户审批解决；absolute 恒为 false。 */
  requestable: boolean
}

export interface AccessRequestView {
  scope: string
  action: 'discover' | 'read' | 'write' | 'delete'
  kind?: string
}

/** 一条作用域权限申请的结果（0.24.0 / D3）。 */
export type ScopeGrantStatus =
  | 'granted'
  | 'already-allowed'
  | 'already-granted'
  | 'not-requestable'
  | 'unavailable'
  | 'denied'
  | 'timeout'
  | 'approval-unavailable'

export interface ScopeGrantResultItemView {
  scope: string
  permission: 'read' | 'write'
  status: ScopeGrantStatus
  reason?: string
}

export interface ScopeGrantRequestResultView {
  results: ScopeGrantResultItemView[]
  outcome?: 'allowed-once' | 'rejected' | 'timeout' | 'unavailable'
}

/** 只有这一层需要的能力子集(provider 在宿主里提供,测试里可以 mock)。 */
export interface MemoryToolService {
  save(input: unknown): Promise<{ id: string; scope: string }>
  search(input: unknown): Promise<Array<{ record: { id: string; scope: string; kind: string; updatedAt: number; content: string; tags?: string[]; importance?: number }; score: number }>>
  forget(input: unknown): Promise<{ removed: number; ids: string[] }>
  list(input?: unknown): Promise<Array<{ id: string; scope: string; kind: string; updatedAt: number; content: string; tags?: string[]; importance?: number; createdAt?: number; expiresAt?: number }>>
  /** 核心记忆块：身份 / 画像 / 当前目标（1.3.0）。 */
  coreBlocks?(): Partial<Record<'identity' | 'profile' | 'goal', { content: string; version: number }>>
  coreSet?(input: { slot: string; content: string; expectedVersion?: number; agent?: unknown }): { content: string; version: number; updatedAt: number; updatedBy: string }
  coreHistory?(slot: string, limit?: number): ReadonlyArray<{ content: string; version: number; updatedAt: number; updatedBy: string }>
  /** 读 "all" 前把所有磁盘上的 scope 发现出来。 */
  discoverScopes?(): MemoryScope[]
  /** 作用域清单(scope + 记录数),用于 memory_list 的尾部摘要与错误提示。 */
  scopeStats?(): Array<{ scope: string; records: number; pendingEmbeds: number; archived?: boolean }>
  /** 作用域目录(名字/用途/访问状态);老 provider 没有时 memory_scopes 明确报不支持。 */
  scopeCatalog?(agent: unknown): ScopeCatalogEntryView[]
  /**
   * 写入 / 更新 / 清空作用域用途（0.29.0）。空串 = 清空（保留元数据与 generation）。
   */
  describeScope?(scope: string, description: string, by: string): { scope: string; description: string }
  /**
   * 设置 / 移除作用域别名（0.29.0）。只影响显示与引用，不改作用域键；
   * name 为空串 / undefined = 移除别名。
   */
  renameScope?(scope: string, name?: string | null): { scope: string; name?: string }
  /**
   * 统一授权判定(0.24.0)：一次解析、多次判定。
   * 工具层用它决定“能不能读/写、要不要审批”，不再自己解释 absolute / normal / none。
   */
  accessEvaluator?(agent: unknown): ((request: AccessRequestView) => AccessDecisionView) | undefined
  /**
   * Agent 主动申请范围外作用域的会话权限（0.24.0 / D3）。
   * 只有 `requestable` 的 scope + 权限才会进入审批；once 不走这里。
   */
  requestScopeGrants?(agent: unknown, input: {
    requests: ReadonlyArray<{ scope: string; permissions: readonly ('read' | 'write')[] }>
    reason?: string
    description?: string
    signal?: AbortSignal
  }): Promise<ScopeGrantRequestResultView>
  /** 无显式 scope 时的合并读取集合(会话 + 项目 + global)。 */
  resolveReadScopes?(agent: unknown): MemoryScope[]
  /**
   * 显式「可见范围」覆盖(undefined = 未设置)。设置后工具必须把它当作白名单:
   * 显式 scope / `all` / memory_get 都不能绕过。
   */
  visibleScopes?(agent: unknown): MemoryScope[]
  /** 完整可见域(等级 + 每个 scope 的类型白名单);老 provider 可能返回 undefined。 */
  visibilityPolicy?(agent: unknown): VisibilityPolicyView | undefined
  /**
   * 某个 scope 是否可写（0.23 起 write 开关独立于 read）。provider 的权威口径；
   * 旧 provider 没有时工具层用 visibilityPolicy 自己判断。
   */
  isScopeWritable?(agent: unknown, scope: string): boolean
  /** 某个 scope 是否可读（0.23 的 read 开关）。 */
  isScopeReadable?(agent: unknown, scope: string): boolean
  /** @deprecated 0.20 的旧名（可读且可写）；新代码用 isScopeWritable。 */
  isScopeOperable?(agent: unknown, scope: string): boolean
  /**
   * 普通限制:向用户发起一次范围外访问审批(等待面板回答)。
   * 结局必须区分「拒绝 / 超时 / 不支持审批」—— 模型要看到真实原因。
   * 0.21.0 起可返回 `{ outcome, allowedIds }` 支持逐条允许。
   * `description` 是模型为这次调用写的用途说明,审批弹窗会展示给用户(0.22.0)。
   */
  requestOutOfScope?(agent: unknown, input: { tool: string; action?: 'read' | 'write' | 'delete'; query: string; description?: string; items: VisibilityApprovalItem[]; signal?: AbortSignal }): Promise<ApprovalAnswer>
  /** 按 id 批量取记录(召回摘要里带了 id,模型可直接取全文)。 */
  getByIds?(ids: string[], opts?: { trackUse?: boolean }): GetSourceRecord[]
  /** 写路径默认 scope(省略 scope 时落到哪)。 */
  resolveWriteScope?(agent: unknown, requested?: string): MemoryScope
  /**
   * 当前项目 key(会话 cwd 优先)。工具层解析 `scope:'project'` 时**必须**用它,
   * 否则工具层与服务端会各自算一个项目键(0.5.5 及以前就是这么错的)。
   */
  projectKeyFor?(agent: unknown): MemoryScope
  // ---------------------------------------------------------------- 屏蔽（0.32.0）
  /**
   * Agent 请求屏蔽无关记忆。审批矩阵由 provider 实现：
   * 按记录 id/前缀 → 不审批；按作用域 / 工作区级 / 含规则 → 审批。
   */
  requestBlock?(agent: unknown, input: {
    scope?: string
    id?: string
    level?: 'session' | 'workspace'
    reason?: string
    description?: string
    tool?: string
    signal?: AbortSignal
  }): Promise<BlockResultView>
  /** 解除屏蔽（面板 / 工具共用）。 */
  unblock?(agent: unknown, match: { level?: 'session' | 'workspace'; id?: string; scope?: string; recordId?: string; prefix?: string }): Array<{ level: 'session' | 'workspace'; removed: number }>
  /** 清空某一层级的全部屏蔽。 */
  clearBlocks?(agent: unknown, level: 'session' | 'workspace'): number
  /** 当前 agent 生效的屏蔽清单。 */
  listBlocks?(agent: unknown): MemoryBlockView[]
  /** 某个作用域是否被屏蔽（目录 / 校验用）。 */
  isScopeBlocked?(agent: unknown, scope: string): boolean
  // ---------------------------------------------------------------- 记忆钩子（0.35.0）
  /** 全部钩子（含代码）。老 provider 没有时 memory_hooks 明确报不支持。 */
  listHooks?(): HookRecordView[]
  getHook?(id: string): HookRecordView | undefined
  /** 新建 / 更新钩子。 */
  saveHook?(input: {
    id?: string
    name?: string
    phase: HookPhaseView
    code: string
    enabled?: boolean
    scopes?: string[]
    kinds?: string[]
    description?: string
    createdBy?: string
    ruleId?: string
  }): HookRecordView
  deleteHook?(id: string): boolean
  /** 记一次用户审批（把当前代码指纹记为已批准）。 */
  approveHook?(id: string): boolean
  /** 撤销代码批准（0.38.0）：代码保留、变回待批准，未批准不会运行。 */
  revokeHookApproval?(id: string): boolean
  /** 这条钩子是否还需要用户批准。 */
  hookPendingApproval?(id: string): boolean
  /** 向用户申请批准一条钩子的代码（首次保存 / 代码变更后）。 */
  requestHookApproval?(agent: unknown, id: string, options?: { description?: string; signal?: AbortSignal }): Promise<'approved' | 'rejected' | 'timeout' | 'unavailable' | 'not-needed'>
  /** 真正跑一批钩子（会执行审批门禁）。 */
  runHooks?(phase: HookPhaseView, input: unknown): HookOutcomeView[]
  /**
   * 试跑指定的一条钩子（0.35.2）：绕过审批门禁，按 id 精确运行，不写记忆、不记统计。
   * 新脚本还没批准时必须能先试跑，否则"先 run 再上线"的流程走不通。
   */
  runHookTrial?(id: string, input: unknown): HookOutcomeView[]
  /** 钩子设置（面板 / 工具展示）。 */
  hookSettings?(): { enabled: boolean; timeoutMs: number; requireApproval: boolean; maxCodeChars: number }
}

// ---------------------------------------------------------------- 记忆钩子（0.35.0）

export type HookPhaseView = 'before-save' | 'after-save' | 'before-inject'

/** provider 的一条钩子（代码会随 list/get 返回，但**不**进记忆检索）。 */
export interface HookRecordView {
  id: string
  name: string
  phase: HookPhaseView
  code: string
  enabled: boolean
  scopes: string[]
  kinds: string[]
  description?: string
  createdBy: string
  createdAt: number
  updatedAt: number
  ruleId?: string
  runCount: number
  errorCount: number
  rejectCount: number
  lastRunAt?: number
  lastOutcome?: 'ok' | 'rejected' | 'error'
  lastMessage?: string
  /** true = 代码改过 / 还没被用户批准过。 */
  pendingApproval?: boolean
}

/** 一次钩子运行的结果（试跑与真实运行同形）。 */
export interface HookOutcomeView {
  /** ruleId = 该钩子关联的规则记忆 id（可能没有）。 */
  hook: { id: string; name: string; phase: HookPhaseView; ruleId?: string }
  ok: boolean
  message?: string
  content?: string
  drop?: boolean
  error?: string
  logs?: string[]
  /** 脚本原始返回值（0.38.0）：试跑时展示代码的真实输出。 */
  raw?: unknown
  durationMs: number
}

export interface MemoryToolsOptions {
  /** Resolves the service lazily so tools fail with a clear message pre-load. */
  getService(): MemoryToolService | undefined
  /** 写路径默认口径(tools.defaultScope),缺省 'session'。 */
  defaultScope?: 'session' | 'project' | 'global'
  /** 当前项目 scope 键(projectScope 配置或 project:<cwd>)。 */
  projectScope?: string
  /**
   * 取当前 exec 对应的会话上下文去重视图(0.21.0)。
   * 入口从注入半边提供的 `memoryContextDedup` 服务接进来;返回 undefined =
   * 没有会话 / 服务不可用 → 不去重，保持老行为。
   */
  contextDedup?(exec: unknown): ContextDedupView | undefined
}

const SCOPE_DESCRIPTION =
  "省略=当前会话；'global'=所有项目共享；'project'=当前工作区；其他任意名称=自定义作用域"
  + "(memory_save 时不存在则自动创建；由 Agent 创建时必须同时提供 scopeDescription 说明用途)。"
  + "自定义作用域按裸名传（如 'dsh-plugin-dev'）；工具输出 / 摘要里看到的展示名 "
  + "'custom:<名字>' 会被自动归一成裸名，不用自己加前缀。"
  + "读取时可用 'all' 跨所有作用域。"

export class MemoryToolError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

function svc(opts: MemoryToolsOptions): MemoryToolService {
  const s = opts.getService()
  if (!s) throw new MemoryToolError('SERVICE_UNAVAILABLE', 'memory service is not loaded; check that dsh-memory-local is enabled')
  return s
}

function toolError(error: unknown): MemoryToolError {
  if (error instanceof MemoryToolError) return error
  const code = (error as { code?: unknown } | undefined)?.code
  const message = error instanceof Error ? error.message : String(error)
  return new MemoryToolError(typeof code === 'string' ? code : 'MEMORY_ERROR', message)
}

/** 供 apply.ts 使用的实例内 agent(宿主 exec.agent)。 */
function agentOf(exec: unknown): unknown {
  return (exec as { agent?: unknown } | undefined)?.agent
}

/**
 * agent → 会话 id(只给需要"这是谁改的"的元数据写入用,如作用域用途的 createdBy)。
 * 与 provider 的 rawSessionIdOf 同口径:header.id 优先,其次 session.id。
 */
function sessionIdOf(agent: unknown): string | undefined {
  try {
    const session = (agent as { session?: { id?: unknown; header?: { id?: unknown } } } | undefined)?.session
    const id = session?.header?.id ?? session?.id
    return typeof id === 'string' && id !== '' ? id : undefined
  } catch {
    return undefined
  }
}

/**
 * 当前项目 key。优先级:**服务端解析的会话 cwd** → 显式配置 → process.cwd()。
 *
 * 服务端那一步不能省:DSH 服务进程的 process.cwd() 是 profile 目录,只有
 * `session.header.cwd` 才是工作区;而 mock / 旧 provider 没有 `projectKeyFor` 时,
 * 只能退回配置与 process.cwd()(与旧行为一致,不把测试和旧宿主打断)。
 */
function projectKey(opts: MemoryToolsOptions, service?: MemoryToolService, agent?: unknown): MemoryScope {
  const resolved = service?.projectKeyFor?.(agent)
  if (typeof resolved === 'string' && resolved.length > 0) return resolved as MemoryScope
  return (opts.projectScope ?? `project:${process.cwd()}`) as MemoryScope
}

/**
 * 显式「可见范围」白名单;undefined = 本会话没有显式覆盖(注入半边用它判断
 * 要不要关掉 extraScopes,工具层不用它做读限制 —— 那是 visibilityPolicy 的事)。
 * provider 方法抛错时按"没有覆盖"处理:可见范围是防越界,不应该让一个 provider
 * 内部错误把所有读取都锁死。
 */
function visibleScopeList(service: MemoryToolService, agent: unknown): MemoryScope[] | undefined {
  try {
    const explicit = service.visibleScopes?.(agent)
    if (Array.isArray(explicit)) return [...new Set(explicit)]
  } catch { /* 降级为不限制 */ }
  return undefined
}

/**
 * 完整可见域;老 provider / 解析失败时退化为 undefined(不限制)。
 * 0.20 的 provider 永远返回策略:没有显式覆盖时是默认策略(source='default'),
 * 默认范围 = 会话 + 项目 + global,等级 = normal。
 */
function visibilityPolicy(service: MemoryToolService, agent: unknown): VisibilityPolicyView | undefined {
  try {
    const policy = service.visibilityPolicy?.(agent)
    if (policy !== undefined && policy !== null) {
      const level: VisibilityLevel = policy.level === 'absolute' || policy.level === 'none' ? policy.level : 'normal'
      const source = policy.source === 'explicit' || policy.source === 'inherited' || policy.source === 'default'
        ? policy.source
        : undefined
      return {
        level,
        scopes: Array.isArray(policy.scopes) ? policy.scopes : [],
        ...(source !== undefined ? { source } : {}),
      }
    }
  } catch { /* 降级为不限制 */ }
  return undefined
}

/** 是否"用户显式设过的策略"(默认策略不算):决定普通限制下要不要把范围外也搜一遍。 */
function explicitPolicy(policy: VisibilityPolicyView | undefined): boolean {
  return policy !== undefined && policy.source !== 'default'
}

function scopeInPolicy(policy: VisibilityPolicyView | undefined, scope: string): boolean {
  if (policy === undefined || policy.level === 'none') return true
  return policy.scopes.some((rule) => rule.scope === scope)
}

/** 该 scope 的规则;不在策略里时 undefined(等于范围外)。 */
function policyRule(policy: VisibilityPolicyView | undefined, scope: string): VisibilityRuleView | undefined {
  if (policy === undefined || policy.level === 'none') return undefined
  return policy.scopes.find((item) => item.scope === scope)
}

/** 这条记录是否在可见域内(旧 provider 的纯策略回退;新 provider 走 authorize)。 */
function legacyRecordAllowed(policy: VisibilityPolicyView | undefined, scope: string, kind: string): boolean {
  if (policy === undefined || policy.level === 'none') return true
  const rule = policyRule(policy, scope)
  if (rule === undefined || rule.read === false) return false
  return rule.kinds === undefined || rule.kinds.length === 0 || rule.kinds.includes(kind)
}

/** 记录在可见域外时,是"整个 scope 不可见"还是"只是类型不允许"。 */
function outsideReason(policy: VisibilityPolicyView | undefined, scope: string): 'scope' | 'kind' {
  return scopeInPolicy(policy, scope) ? 'kind' : 'scope'
}

/** provider 的授权判定器;老 provider / 拿不到会话时返回 undefined(走回退)。 */
type DecideAccess = (
  action: 'discover' | 'read' | 'write' | 'delete',
  scope: string,
  kind?: string,
) => AccessDecisionView | undefined

function decisionMaker(service: MemoryToolService, agent: unknown): DecideAccess {
  if (agent === undefined) return () => undefined
  try {
    const evaluator = service.accessEvaluator?.(agent)
    if (typeof evaluator === 'function') {
      return (action, scope, kind) => {
        try {
          return evaluator({ scope, action, ...(kind !== undefined ? { kind } : {}) })
        } catch {
          return undefined
        }
      }
    }
  } catch { /* 回退到纯策略判定 */ }
  return () => undefined
}

/** 读权限:优先 provider 的统一判定,老 provider 用纯策略回退。 */
function recordAllowed(
  decide: DecideAccess,
  policy: VisibilityPolicyView | undefined,
  scope: string,
  kind: string,
): boolean {
  const decision = decide('read', scope, kind)
  return decision !== undefined ? decision.allowed : legacyRecordAllowed(policy, scope, kind)
}

/** 这条被挡住的读能不能申请审批;absolute 与显式 read:false 都不能。 */
function recordRequestable(
  decide: DecideAccess,
  policy: VisibilityPolicyView | undefined,
  scope: string,
  kind: string,
): boolean {
  const decision = decide('read', scope, kind)
  if (decision !== undefined) return !decision.allowed && decision.requestable
  return policy?.level === 'normal' && policyRule(policy, scope) === undefined
}

/** 写权限:优先 provider 的统一判定,老 provider 用纯策略回退。 */
function scopeWritableBy(
  decide: DecideAccess,
  service: MemoryToolService,
  agent: unknown,
  policy: VisibilityPolicyView | undefined,
  scope: string,
): boolean {
  const decision = decide('write', scope)
  if (decision !== undefined) return decision.allowed
  return scopeWritable(service, agent, policy, scope)
}

/** 单条读被挡住的原因(给 withheld 用)。 */
function readDenyReason(
  decide: DecideAccess,
  policy: VisibilityPolicyView | undefined,
  scope: string,
  kind: string,
): WithheldReason {
  const decision = decide('read', scope, kind)
  switch (decision?.reason) {
    case 'ABSOLUTE_ISOLATION': return 'absolute'
    case 'SCOPE_DISABLED': return 'scope-disabled'
    case 'READ_DISABLED': return 'read-disabled'
    case 'KIND_NOT_ALLOWED': return 'read-disabled'
    case 'SCOPE_NOT_IN_RANGE': return policy?.level === 'absolute' ? 'absolute' : 'read-disabled'
  }
  return policy?.level === 'absolute' ? 'absolute' : 'read-disabled'
}

/** 范围被挡住时给模型的原因:审批结局优先,否则按实际拒绝原因聚合。 */
function withheldReasonFor(
  decide: DecideAccess,
  policy: VisibilityPolicyView | undefined,
  denied: ReadonlyArray<{ scope: string; kind: string }>,
  verdict: ApprovalVerdict | undefined,
): WithheldReason | undefined {
  if (verdict !== undefined) return verdict.outcome === 'allowed-once' ? 'partial' : verdict.outcome
  if (denied.length === 0) return undefined
  const reasons = denied.map((item) => readDenyReason(decide, policy, item.scope, item.kind))
  if (reasons.includes('absolute')) return 'absolute'
  if (reasons.includes('scope-disabled')) return 'scope-disabled'
  return 'read-disabled'
}

/**
 * 0.27.0：普通限制下**没有发起审批**的范围外命中给模型的原因。
 * 与 withheldReasonFor 的差别：「整个作用域不在范围内」（普通限制下本可审批、
 * 现在只给索引）不再报成 read-disabled，而是 'out-of-scope'；
 * absolute / read-disabled / scope-disabled 照旧如实聚合。
 */
function outOfScopeReason(
  decide: DecideAccess,
  policy: VisibilityPolicyView | undefined,
  denied: ReadonlyArray<{ scope: string; kind: string }>,
): WithheldReason | undefined {
  if (denied.length === 0) return undefined
  const reasons = denied.map((item) => readDenyReason(decide, policy, item.scope, item.kind))
  if (reasons.includes('absolute')) return 'absolute'
  if (reasons.includes('scope-disabled')) return 'scope-disabled'
  // readDenyReason 把「SCOPE_NOT_IN_RANGE + 普通限制」也归成 read-disabled；
  // 这里按"作用域是否在范围里"细分：不在范围 = out-of-scope（可申请）。
  const hasOutOfScope = denied.some((item) => !scopeInPolicy(policy, item.scope))
  return hasOutOfScope ? 'out-of-scope' : 'read-disabled'
}

/**
 * memory_save 的 supersedes 参数说明(模型可见)。
 * 检索 / 列表 / 摘要 / 规则索引里给的 id 都是 8 位短 id,而 supersedes 在 provider
 * 里是**按 id 精确查找**(records.get(id)),传短 id 只会得到 SUPERSEDES_UNKNOWN。
 * 所以必须明确要求「完整 id」,并给出拿完整 id 的路径(memory_get 首行就是完整 id)。
 */
const SUPERSEDES_PARAM_DESCRIPTION =
  '被这条新记忆修正 / 替换掉的旧记录 id。必须传**完整 id**(36 位 UUID),不能传 memory_search / memory_list / 摘要 / 规则索引里显示的 8 位短 id;手头只有短 id 时先用 memory_get 取回 —— 它结果里每段首行的 [id] 就是完整 id。旧记录会被标记为「已修正」,默认不再出现在检索、规则和自动召回里,但 memory_get 仍能查到。'
  + '传了 supersedes 时**必须显式带 scope 参数**（不接受省略 / 默认作用域）：scope 是新记录要保存到的目标作用域，本会话必须对它拥有写权限；跨作用域修正（旧记录在别的作用域）现在支持，但目标作用域必须写权限，否则直接拒绝，不做审批。'

/** 带 supersedes 时必须显式写 scope：拒绝静默落到默认作用域造成“修错地方”。 */
function requireScopeForSupersedes(args: SaveArgs, explicit: string | undefined): void {
  if (args.supersedes === undefined || args.supersedes === '') return
  const raw = args.scope?.trim()
  if (explicit === undefined || raw === undefined || raw === '') {
    throw new MemoryToolError(
      'SUPERSEDES_SCOPE_REQUIRED',
      '用 supersedes 修正旧记忆时必须显式传 scope 参数（新记录要保存到的目标作用域 key），不能省略、不能依赖默认作用域；否则拒绝保存。',
    )
  }
}

/** memory_* 的 description 参数说明(模型可见)。 */
const DESCRIPTION_PARAM_DESCRIPTION =
  '本次调用要做什么（一句话，给用户看）。本会话「记忆范围」为普通限制时必填：审批范围外记忆时，弹窗会把它展示给用户。'

/**
 * 把模型的 description 收拾成一行(审批弹窗里展示)。
 * 省略/空白 = undefined(是否合法由 requireDescription 按限制等级判断)。
 */
function descriptionOf(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const value = raw.replace(/\s+/g, ' ').trim()
  return value === '' ? undefined : value.slice(0, 500)
}

/**
 * 「记忆范围」为普通限制时,memory_* 必须写 description:审批弹窗要把 Agent 的
 * 意图展示给用户,只有工具名 + 查询词不够判断该不该放行。
 *
 * 拿不到会话(老宿主 / 测试 mock / 面板直调)时不强制 —— 没有会话就没有审批弹窗;
 * absolute / none 也不强制(前者范围外一律视为不存在,后者不需要审批)。
 */
function requireDescription(service: MemoryToolService, agent: unknown, raw: unknown): void {
  if (agent === undefined) return
  const policy = visibilityPolicy(service, agent)
  if (policy === undefined || policy.level !== 'normal') return
  if (descriptionOf(raw) !== undefined) return
  throw new MemoryToolError(
    'DESCRIPTION_REQUIRED',
    '本会话「记忆范围」为普通限制：调用 memory_* 工具时必须提供 description 字段，用一句话说明这次调用要做什么（审批范围外记忆时弹窗会展示给用户）。',
  )
}

function recordsToApprovalItems(
  policy: VisibilityPolicyView | undefined,
  records: readonly { id: string; scope: string; kind: string; content: string; tags?: string[]; importance?: number; updatedAt: number }[],
): VisibilityApprovalItem[] {
  return records.map((record) => ({
    id: record.id,
    scope: record.scope,
    kind: record.kind,
    content: record.content,
    tags: Array.isArray(record.tags) ? record.tags : [],
    importance: typeof record.importance === 'number' ? record.importance : 0,
    updatedAt: record.updatedAt,
    reason: outsideReason(policy, record.scope),
  }))
}

/**
 * 普通限制:把范围外访问交给用户审批一次。
 * 结局必须可区分:允许一次 / 用户拒绝 / 超时 / 旧 provider 不支持审批。
 * `agent` 省略 = 不审批(工具层在拿不到会话时退回 provider 的护栏)。
 * 允许写/删时要带 `approvedItems` 之类的合成条目,浮层才显示得出来。
 *
 * 0.21.0:允许的条目可以是"全部"(allowedIds 省略)或用户在审批卡里逐条勾选的
 * 一部分;后者通过 `allowedIds` 返回,调用方只放行这些 id。
 */
interface ApprovalVerdict {
  outcome: ApprovalOutcome
  /** undefined = allowed-once 覆盖本次请求的全部条目。 */
  allowedIds?: Set<string>
}

async function askOutOfScope(
  service: MemoryToolService,
  agent: unknown,
  policy: VisibilityPolicyView | undefined,
  tool: string,
  query: string,
  records: readonly { id: string; scope: string; kind: string; content: string; tags?: string[]; importance?: number; updatedAt: number }[],
  action: 'read' | 'write' | 'delete',
  signal?: AbortSignal,
  description?: string,
): Promise<ApprovalVerdict> {
  if (records.length === 0) return { outcome: 'allowed-once' }
  if (typeof service.requestOutOfScope !== 'function') return { outcome: 'unavailable' }
  if (signal?.aborted) return { outcome: 'rejected' }
  try {
    const answer = await service.requestOutOfScope(agent, {
      tool,
      action,
      query,
      ...(description !== undefined ? { description } : {}),
      items: recordsToApprovalItems(policy, records),
      ...(signal !== undefined ? { signal } : {}),
    })
    // 老 provider 直接返回字符串;新 provider 返回 { outcome, allowedIds }。
    const decision: ApprovalDecision = typeof answer === 'string' ? { outcome: answer } : answer ?? { outcome: 'unavailable' }
    const outcome: ApprovalOutcome = decision.outcome === 'allowed-once' || decision.outcome === 'timeout' || decision.outcome === 'unavailable'
      ? decision.outcome
      : 'rejected'
    const ids = outcome === 'allowed-once' && Array.isArray(decision.allowedIds)
      ? new Set(decision.allowedIds.map(String))
      : undefined
    // 逐条勾选但一条都没选中 = 用户拒绝了这次访问。
    if (ids !== undefined && ids.size === 0) return { outcome: 'rejected' }
    return { outcome, ...(ids !== undefined ? { allowedIds: ids } : {}) }
  } catch {
    return { outcome: 'unavailable' }
  }
}

/** 这次审批是否允许这一条(没有 allowedIds = 全部允许)。 */
function verdictAllows(verdict: ApprovalVerdict, id: string): boolean {
  if (verdict.outcome !== 'allowed-once') return false
  return verdict.allowedIds === undefined || verdict.allowedIds.has(id)
}

/** 审批没通过时给模型的真实原因(写/删路径直接抛这个错误)。 */
function visibilityError(outcome: WithheldReason, action: 'write' | 'delete', scope: string): MemoryToolError {
  const verb = action === 'write' ? '写入' : '删除'
  if (outcome === 'rejected') {
    return new MemoryToolError(
      'VISIBILITY_REJECTED',
      `用户拒绝了本次${verb}请求（作用域 ${scope}，当前限制等级：普通限制），没有执行。如需${verb}，请让用户调整「记忆范围」后重试。`,
    )
  }
  if (outcome === 'timeout') {
    return new MemoryToolError(
      'VISIBILITY_TIMEOUT',
      `等待用户审批超时（5 分钟没有答复），本次${verb}没有执行（作用域 ${scope}，当前限制等级：普通限制）。`,
    )
  }
  return new MemoryToolError(
    'VISIBILITY_UNAVAILABLE',
    `当前环境无法就范围外访问发起审批，本次${verb}没有执行（作用域 ${scope}）。`,
  )
}

/** 写入/删除被「可写」开关或绝对限制挡住时给模型的真实原因。 */
function scopeWriteBlockedError(policy: VisibilityPolicyView | undefined, scope: string, action: 'write' | 'delete'): MemoryToolError {
  const verb = action === 'write' ? '写入' : '删除'
  const rule = policyRule(policy, scope)
  if (rule !== undefined && rule.write === false) {
    return new MemoryToolError(
      'SCOPE_READ_ONLY',
      `作用域 ${scope} 在本会话记忆范围里被标记为「不可写」（可读/可写按钮），本次${verb}没有执行。如需${verb}，请让用户打开该作用域的「可写」状态。`,
    )
  }
  return new MemoryToolError(
    'VISIBILITY_ABSOLUTE',
    `作用域 ${scope} 不在本会话可见范围内（限制等级：绝对限制），本次${verb}没有执行。如需${verb}，请让用户调整「记忆范围」后重试。`,
  )
}

/** 按 id 删除时,记录存在但被可见域挡住的原因(绝对限制 / 不可写)。 */
function blockedRecordError(policy: VisibilityPolicyView | undefined, scope: string, id: string): MemoryToolError {
  const rule = policyRule(policy, scope)
  if (rule !== undefined && rule.write === false) {
    return new MemoryToolError(
      'SCOPE_READ_ONLY',
      `记忆 ${id} 所在作用域 ${scope} 在本会话记忆范围里被标记为「不可写」，本次删除没有执行。如需删除，请让用户打开该作用域的「可写」状态。`,
    )
  }
  return new MemoryToolError(
    'VISIBILITY_ABSOLUTE',
    `记忆 ${id} 不在本会话可见范围内（限制等级：绝对限制），本次删除没有执行。如需删除，请让用户调整「记忆范围」后重试。`,
  )
}

/** 按 id 删除时,记录存在但被 provider 的授权判定挡住的原因。 */
function blockedRecordDecisionError(decision: AccessDecisionView, scope: string, id: string): MemoryToolError {
  if (decision.reason === 'WRITE_DISABLED') {
    return new MemoryToolError(
      'SCOPE_READ_ONLY',
      `记忆 ${id} 所在作用域 ${scope} 在本会话记忆范围里被标记为「不可写」，本次删除没有执行。如需删除，请让用户打开该作用域的「可写」状态。`,
    )
  }
  if (decision.reason === 'SCOPE_DISABLED') {
    return new MemoryToolError('SCOPE_DISABLED', `记忆 ${id} 所在作用域 ${scope} 已被配置关闭，本次删除没有执行。`)
  }
  return new MemoryToolError(
    'VISIBILITY_ABSOLUTE',
    `记忆 ${id} 不在本会话可见范围内（限制等级：绝对限制），本次删除没有执行。如需删除，请让用户调整「记忆范围」后重试。`,
  )
}

/** 写入/删除被 provider 的授权判定挡住时给模型的真实原因。 */
function writeDecisionError(decision: AccessDecisionView, scope: string, action: 'write' | 'delete'): MemoryToolError {
  const verb = action === 'write' ? '写入' : '删除'
  if (decision.reason === 'WRITE_DISABLED') {
    return new MemoryToolError(
      'SCOPE_READ_ONLY',
      `作用域 ${scope} 在本会话记忆范围里被标记为「不可写」（可读/可写按钮），本次${verb}没有执行。如需${verb}，请让用户打开该作用域的「可写」状态。`,
    )
  }
  if (decision.reason === 'SCOPE_DISABLED') {
    return new MemoryToolError('SCOPE_DISABLED', `作用域 ${scope} 已被配置关闭，本次${verb}没有执行。`)
  }
  return new MemoryToolError(
    'VISIBILITY_ABSOLUTE',
    `作用域 ${scope} 不在本会话可见范围内（限制等级：绝对限制），本次${verb}没有执行。如需${verb}，请让用户调整「记忆范围」后重试。`,
  )
}

/** 写入/删除前判断一个 scope 是否可写(0.23 起独立于 read 开关)。 */
function scopeWritable(service: MemoryToolService, agent: unknown, policy: VisibilityPolicyView | undefined, scope: string): boolean {
  if (policy === undefined || policy.level === 'none') return true
  try {
    const verdict = service.isScopeWritable?.(agent, scope) ?? service.isScopeOperable?.(agent, scope)
    if (typeof verdict === 'boolean') return verdict
  } catch { /* 退回本地判断 */ }
  const rule = policyRule(policy, scope)
  return rule !== undefined && rule.write !== false
}

/** 规范里所有已知 scope(用来在普通限制下把范围外也搜一遍,看看有没有可审批的命中)。 */
function allKnownScopes(service: MemoryToolService): MemoryScope[] {
  try {
    service.discoverScopes?.()
    return [...new Set((service.scopeStats?.() ?? []).map((item) => item.scope))]
  } catch {
    return []
  }
}

/** 该服务/配置下"当前会话 + 当前项目 + global"的合并读取集合(去重)。 */
function readScopes(opts: MemoryToolsOptions, service: MemoryToolService, agent: unknown): MemoryScope[] {
  // 显式可见范围优先,空数组也要原样返回(表示什么都不允许读)。
  const explicit = visibleScopeList(service, agent)
  if (explicit !== undefined) return explicit
  const provided = service.resolveReadScopes?.(agent)
  if (Array.isArray(provided) && provided.length > 0) return [...new Set(provided)]
  // 服务没提供(测试 mock / 旧 provider):退回 defaultScope 口径
  const fallback = opts.defaultScope === 'global' ? 'global' : projectKey(opts, service, agent)
  return [...new Set([fallback, 'global'])]
}

/**
 * 当前会话的 scope 键(拿不到会话就 undefined)。给显式写成裸 `session` 的
 * 请求兜底 —— `resolveScope` 在读路径上会把它解析成"合并集合",申请权限时必须
 * 落到一个具体键。
 */
function currentSessionScope(service: MemoryToolService, exec: unknown): MemoryScope | undefined {
  return service.resolveReadScopes?.(agentOf(exec))?.find((scope) => scope.startsWith('session:'))
}

/** 写路径默认口径;provider 不支持时退回 project。 */
function writeDefault(opts: MemoryToolsOptions): 'session' | 'project' | 'global' {
  return opts.defaultScope ?? 'session'
}

/** 规范化 + 落到具体 key(或 all)。 */
function resolveScope(
  opts: MemoryToolsOptions,
  service: MemoryToolService,
  exec: unknown,
  raw: string | undefined,
  mode: 'read' | 'write',
): { all?: boolean; scope?: MemoryScope } {
  const normalized = normalizeScopeInput(raw)
  if (!normalized.ok) throw new MemoryToolError('SCOPE_INVALID', normalized.message)
  if (normalized.kind === 'global') return { scope: 'global' }
  const agent = agentOf(exec)
  const project = projectKey(opts, service, agent)
  // 当前会话 key 由 provider 解析(只有它知道 scopes.session 开关与子代理共享父会话的规则);
  // provider 不在(测试 mock / 旧版本)时不给 session —— 写路径会回退 project,读路径回到合并集合。
  const session = service.resolveReadScopes?.(agent)?.find((s) => s.startsWith('session:'))
  const refs = { project, ...(session !== undefined ? { session } : {}) }
  const resolved = resolveScopeRef(normalized, refs, {
    mode,
    defaultScope: writeDefault(opts),
    // provider 的合并集合里没有会话 scope ⇒ scopes.session 关着(或拿不到会话);此时
    // 省略 scope 要干净地回退项目 scope,而不是撞 SCOPE_DISABLED。provider 根本没提供
    // 合并集合(测试 mock / 只实现 save 的旧 provider)时不带这一项:交给它的 save 兜底。
    ...(service.resolveReadScopes !== undefined ? { sessionEnabled: session !== undefined } : {}),
  })
  if (!resolved.ok) throw new MemoryToolError(resolved.code, resolved.message)
  if (resolved.all) return { all: true }
  return resolved.scope !== undefined ? { scope: resolved.scope } : {}
}

export interface SaveArgs {
  content: string
  scope?: string
  /** 工作区目录路径；给出后写入 project:<路径>，此时 scope 用作该作用域的显示名。 */
  path?: string
  kind?: string
  tags?: string[]
  importance?: number
  /** 被这条新记录修正/替换的旧记录 **完整** id(不接受 8 位短 id)。 */
  supersedes?: string
  /** 过期时间（毫秒时间戳）；kind='state' 不传时按设置里的默认 TTL。 */
  expiresAt?: number
  /** 相对有效期（毫秒）；与 expiresAt 二选一，显式值优先。 */
  ttlMs?: number
  /** 流程触发词(kind=procedure)。系统提示里的流程索引按它匹配任务/工具名。 */
  triggers?: string[]
  /**
   * 新建自定义作用域时必填：一句话说明这个作用域用来做什么。
   * 已有作用域带上它是“更新用途”（不会写初始记忆）。
   */
  scopeDescription?: string
  /** 初始化时可选写一条初始规则（kind=rule），只对新作用域生效。 */
  scopeRule?: string
  /**
   * 0.35.0：给这条（规则）记忆附带的脚本源码。脚本会按 `hookPhase` 在对应时机运行。
   * 代码存在 hooks.json，**不**进记忆检索；首次保存需要用户批准一次。
   */
  hookCode?: string
  /** 脚本运行的时机；给了 hookCode 时默认 'before-save'（保存前校验）。 */
  hookPhase?: HookPhaseView
  /** 脚本的显示名（面板 / 审批卡用）；缺省用记忆内容前 24 字。 */
  hookName?: string
  /** 本次调用的用途(给用户看);普通限制下必填,审批弹窗展示。 */
  description?: string
}

export interface SaveResult {
  id: string
  /** 新记录实际保存到的目标作用域 key —— 所有 memory_save 返回都带，supersedes 时也会在提示文案里再强调一次。 */
  scope: string
  /** 作用域别名（这次写入顺带登记的名字）。 */
  scopeName?: string
  deduped: boolean
  /** supersedes 修正的场景：被修正旧记录 id 与其所在作用域（可跨作用域）。 */
  supersedes?: { id: string; scope?: string }
  /** 0.35.0：随这条记忆登记的钩子（代码挂上了但没批准时也会给 id，附审批结局）。 */
  hook?: { id: string; name: string; phase: HookPhaseView; approval: string }
}

/**
 * `path` → 绝对工作区路径。相对路径按会话 cwd 解析（拿不到就按进程 cwd），
 * 再走 `canonicalWorkspacePath` 统一写法 —— 同一个目录必须只有一种 scope 键，
 * 否则 `project:<路径>` 会分叉（`D:/x` 与 `D:\x` 曾是两个 scope，见 0.11.1）。
 */
function resolveWorkspacePath(raw: string, agent: unknown): string {
  const value = raw.trim()
  if (value === '') throw new MemoryToolError('PATH_INVALID', 'path 不能为空')
  const cwd = (agent as { session?: { header?: { cwd?: unknown } } } | undefined)?.session?.header?.cwd
  const base = typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd()
  // 同时认 POSIX 与 Windows 绝对路径写法：Linux 上的 node:path.isAbsolute 不认 `D:/x`,
  // 会把 Windows 路径当成相对路径拼到 cwd 下（同一工作区会分叉出两个 scope）。
  return canonicalWorkspacePath(isAbsoluteWorkspacePath(value) ? value : resolve(base, value))
}

export function memorySaveTool(opts: MemoryToolsOptions): ToolSpec<SaveArgs, SaveResult> {
  return {
    name: 'memory_save',
    description: 'Save a durable memory (fact, decision, preference, procedure, rule, state) for future sessions.',
    parameters: {
      content: { type: 'string', description: 'Self-contained declarative sentence, readable without context', required: true },
      scope: { type: 'string', description: `${SCOPE_DESCRIPTION};配合 path 时表示该工作区作用域的显示名（别名）` },
      path: { type: 'string', description: '工作区目录路径；给出后写入 project:<路径>，此时 scope 用作该作用域的显示名（别名，可省略 = 用路径本身）' },
      kind: { type: 'string', enum: ['fact', 'decision', 'preference', 'procedure', 'note', 'rule', 'state'] },
      tags: { type: 'array', items: { type: 'string' } },
      importance: { type: 'number', description: '0~1, higher = more important' },
      supersedes: { type: 'string', description: SUPERSEDES_PARAM_DESCRIPTION },
      expiresAt: { type: 'number', description: '过期时间(毫秒时间戳)。kind=state 不传时按设置里的默认 TTL(7 天)' },
      ttlMs: { type: 'number', description: '相对有效期(毫秒)。与 expiresAt 二选一，expiresAt 优先' },
      triggers: { type: 'array', items: { type: 'string' }, description: '流程触发词(kind=procedure)：工具名/关键词/路径；缺省用 tags' },
      scopeDescription: { type: 'string', description: '新建自定义作用域时必填：一句话说明这个作用域用来做什么（已有作用域带上它 = 更新用途）' },
      scopeRule: { type: 'string', description: '初始化时可选写一条初始规则(kind=rule)：只对新自定义作用域生效，用于约定该作用域只记录什么、不记录什么' },
      hookCode: {
        type: 'string',
        description: '给这条规则附带的校验脚本源码（0.35.0）：同步函数，按 hookPhase 在对应时机运行。'
          + '代码存在 hooks.json，不进记忆检索；首次保存会向用户申请批准一次。'
          + '写脚本前先加载技能 memory-hook-scripts（`skill` 工具，名字就叫 memory-hook-scripts）——它写了入口函数名、可用 API、返回约定与现成范例。',
      },
      hookPhase: {
        type: 'string',
        enum: ['before-save', 'after-save', 'before-inject'],
        description: '脚本运行时机（默认 before-save）：before-save=保存前校验，返回 {ok:false} 直接拒绝这次保存；'
          + 'after-save=保存后观察，只能附注不阻断；before-inject=注入前解析，可改写正文或 drop 掉整条。',
      },
      hookName: { type: 'string', description: '脚本的显示名（面板与审批卡用）；缺省取内容前 24 字' },
      description: { type: 'string', description: DESCRIPTION_PARAM_DESCRIPTION },
    },
    async execute(args: SaveArgs, exec?: unknown): Promise<SaveResult> {
      const service = svc(opts)
      const agent = agentOf(exec)
      requireDescription(service, agent, args.description)
      if (typeof args.content !== 'string' || args.content.trim().length === 0) {
        throw new MemoryToolError('CONTENT_EMPTY', 'content must be a non-empty string')
      }
      if (args.importance !== undefined && (args.importance < 0 || args.importance > 1)) {
        throw new MemoryToolError('IMPORTANCE_RANGE', 'importance must be between 0 and 1')
      }
      const content = args.content.trim()
      // 写路径:省略 scope → provider 按 tools.defaultScope(缺省 session,拿不到会话回退
      // project)。默认值的最终权威是 provider 的 `save` —— 省略时干脆不带 scope 字段,
      // 但要把会话上下文(exec.agent)带过去,否则它没法知道"当前会话"是谁。
      const requested = args.scope?.trim()
      const pathArg = typeof args.path === 'string' ? args.path.trim() : ''

      let explicit: string | undefined
      let alias: string | undefined
      if (pathArg !== '') {
        // path 给出 = 项目作用域;scope 此时是它的显示名,不再当 scope 选择器用。
        if (requested !== undefined && requested !== '' && requested !== 'project') {
          if (requested === 'global' || requested === 'session' || requested === 'all') {
            throw new MemoryToolError('PATH_SCOPE_CONFLICT', `path 只能配合项目作用域使用,不能再指定 scope="${requested}"`)
          }
          alias = requested
        }
        explicit = `project:${resolveWorkspacePath(pathArg, agent)}`
      } else {
        const resolved = requested === undefined || requested === ''
          ? undefined
          : resolveScope(opts, service, exec, requested, 'write').scope
        if (requested !== undefined && requested !== '' && resolved === undefined) {
          throw new MemoryToolError('SCOPE_INVALID', 'scope could not be resolved')
        }
        explicit = resolved
      }

      // 0.36.0：带 supersedes 时 scope 必须显式给出（见 requireScopeForSupersedes），
      // 且本会话必须对目标作用域已有写权限 —— 不触发范围外审批，权限不足直接拒绝。
      requireScopeForSupersedes(args, explicit)
      const isSupersedes = args.supersedes !== undefined && args.supersedes !== ''

      // 写入护栏（0.20.0 / 0.23.0）：write 开关与范围等级分开判断。
      //   - 作用域在范围内但「可写」关掉 → 直接拒绝并说明开关;
      //   - absolute 且作用域不在范围内 → 直接拒绝并说明绝对限制;
      //   - normal 且作用域不在范围内 → 先向用户审批一次,拒绝/超时讲真实原因;
      //   - none → 不限制。
      // 拿不到会话(老宿主 / 无 exec)时不判断:没有会话就没有"本会话的可见域"。
      const policy = agent === undefined ? undefined : visibilityPolicy(service, agent)
      const decide = decisionMaker(service, agent)
      const level = policy?.level ?? 'none'
      const target = explicit ?? (typeof service.resolveWriteScope === 'function' ? service.resolveWriteScope(agent) : undefined)
      let approved = false
      if (isSupersedes && level !== 'none' && target !== undefined && !scopeWritableBy(decide, service, agent, policy, target)) {
        // supersedes 是"改旧记忆"的写操作：必须已有写权限，不走范围外审批。
        // 不论拒绝原因是绝对限制 / 只读 / 范围外，统一用一个 dedicated 错误码与文案，
        // 避免把 "SCOPE_NOT_IN_RANGE" 误报成 VISIBILITY_ABSOLUTE（见 0.36.0）。
        throw new MemoryToolError(
          'SUPERSEDES_SCOPE_NOT_WRITABLE',
          `用 supersedes 修正旧记忆要求当前会话对目标作用域 ${target} 已有写权限（作用域不在本会话可写范围内），本次保存没有执行。请先让用户授予该作用域写权限，或改用本会话可写的作用域。`,
        )
      }
      if (!isSupersedes && level !== 'none' && target !== undefined && !scopeWritableBy(decide, service, agent, policy, target)) {
        const decision = decide('write', target)
        if (decision !== undefined) {
          // provider 已经给出统一判定：不可申请就直接讲原因（absolute / 关闭 / 只读）。
          if (!decision.requestable) throw writeDecisionError(decision, target, 'write')
        } else if (policyRule(policy, target) !== undefined || level === 'absolute') {
          // 老 provider 没有授权判定时保持原有纯策略判断。
          throw scopeWriteBlockedError(policy, target, 'write')
        }
        const draft = {
          id: 'new-record',
          scope: target,
          kind: args.kind ?? 'note',
          content: content,
          tags: Array.isArray(args.tags) ? args.tags : [],
          importance: typeof args.importance === 'number' ? args.importance : 0,
          updatedAt: Date.now(),
        }
        const verdict = await askOutOfScope(
          service,
          agent,
          policy,
          'memory_save',
          summarize(content, 80),
          [draft],
          'write',
          (exec as { signal?: AbortSignal } | undefined)?.signal,
          descriptionOf(args.description),
        )
        if (!verdictAllows(verdict, draft.id)) {
          throw visibilityError(verdict.outcome === 'allowed-once' ? 'rejected' : verdict.outcome, 'write', target)
        }
        approved = true
      }

      try {
        const record = await service.save({
          ...(explicit !== undefined ? { scope: explicit } : {}),
          ...(alias !== undefined ? { name: alias } : {}),
          ...(agent !== undefined ? { agent } : {}),
          ...(approved ? { visibilityApproved: true } : {}),
          kind: args.kind ?? 'note',
          content: content,
          ...(args.tags ? { tags: args.tags } : {}),
          ...(args.importance !== undefined ? { importance: args.importance } : {}),
          ...(args.supersedes ? { supersedes: args.supersedes } : {}),
          ...(typeof args.expiresAt === 'number' ? { expiresAt: args.expiresAt } : {}),
          ...(typeof args.ttlMs === 'number' ? { ttlMs: args.ttlMs } : {}),
          ...(Array.isArray(args.triggers) ? { triggers: args.triggers.map(String) } : {}),
          ...(typeof args.scopeDescription === 'string' && args.scopeDescription.trim() !== ''
            ? { scopeDescription: args.scopeDescription }
            : {}),
          ...(typeof args.scopeRule === 'string' && args.scopeRule.trim() !== ''
            ? { scopeRule: args.scopeRule }
            : {}),
          source: { origin: 'explicit' },
        })
        // 0.35.0：带代码的规则 —— 记忆先落盘（脚本可能正是用来校验别人写的记忆），
        // 再登记钩子并申请一次批准。登记失败不该让保存变成"失败"，只附一句告知。
        let hookInfo: SaveResult['hook']
        const hookCode = typeof args.hookCode === 'string' ? args.hookCode.trim() : ''
        if (hookCode !== '') {
          hookInfo = await registerHookForSave(service, agent, exec, {
            code: hookCode,
            phase: args.hookPhase ?? 'before-save',
            name: typeof args.hookName === 'string' && args.hookName.trim() !== ''
              ? args.hookName.trim()
              : content.replace(/\s+/g, ' ').slice(0, 24),
            ruleId: record.id,
            scopes: [record.scope],
            description: args.description,
          })
        }
        let oldScope: string | undefined
        if (isSupersedes) {
          try {
            const hit = (await service.getByIds?.([args.supersedes!]))?.[0]
            oldScope = hit?.scope
          } catch { /* 取不到旧记录作用域只影响提示，不影响保存成功 */ }
        }
        return {
          id: record.id,
          scope: record.scope,
          ...(alias !== undefined ? { scopeName: alias } : {}),
          deduped: false,
          ...(isSupersedes ? { supersedes: { id: args.supersedes!, ...(oldScope !== undefined ? { scope: oldScope } : {}) } } : {}),
          ...(hookInfo !== undefined ? { hook: hookInfo } : {}),
        }
      } catch (error) {
        throw toolError(error)
      }
    },
  }
}

/**
 * 登记一条随记忆保存的钩子，并向用户申请一次批准。
 *
 * 顺序很关键：**先保存钩子（未批准）再申请审批**。反过来的话，用户批准时
 * 钩子还不存在，批准就无处可记；而且 `requireApproval=false` 时也不需要弹窗。
 */
async function registerHookForSave(
  service: MemoryToolService,
  agent: unknown,
  exec: unknown,
  input: {
    code: string
    phase: HookPhaseView
    name: string
    ruleId: string
    scopes: string[]
    description?: string
  },
): Promise<{ id: string; name: string; phase: HookPhaseView; approval: string }> {
  if (typeof service.saveHook !== 'function') {
    return { id: '', name: input.name, phase: input.phase, approval: 'unsupported' }
  }
  let hook: HookRecordView
  try {
    hook = service.saveHook({
      name: input.name,
      phase: input.phase,
      code: input.code,
      scopes: input.scopes,
      ruleId: input.ruleId,
      createdBy: 'agent',
    })
  } catch (error) {
    return { id: '', name: input.name, phase: input.phase, approval: `save-failed: ${toolError(error).message}` }
  }
  let approval = 'not-needed'
  if (typeof service.requestHookApproval === 'function') {
    try {
      approval = await service.requestHookApproval(agent, hook.id, {
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...((exec as { signal?: AbortSignal } | undefined)?.signal !== undefined
          ? { signal: (exec as { signal?: AbortSignal }).signal }
          : {}),
      })
    } catch {
      approval = 'unavailable'
    }
  }
  return { id: hook.id, name: hook.name, phase: hook.phase, approval }
}

/** memory_search / memory_get(summary) 的默认摘要长度（字符）。 */
export const DEFAULT_SUMMARY_CHARS = 160

/** 摘要字数上限：默认 160，允许调用方在 20~2000 之间调整。 */
export /**
 * 0.111.0：把 memory_search 的 asOf 参数规范成毫秒时间戳。
 * 接受毫秒数字、秒级数字（<1e12 视为秒）、ISO 字符串；无法解析返回 undefined（按当前检索）。
 */
function parseAsOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function resolveSummaryChars(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return DEFAULT_SUMMARY_CHARS
  return Math.min(2000, Math.max(20, Math.round(n)))
}

/** 空白折叠 + 截断。memory_search 的“少量摘要”和 memory_get 的 summary 字段共用。 */
export function summarize(content: string, chars: number = DEFAULT_SUMMARY_CHARS): string {
  const flat = String(content).replace(/\s+/g, ' ').trim()
  return flat.length <= chars ? flat : `${flat.slice(0, chars)}…`
}

/**
 * memory_search 的上下文去重(0.21.0):
 *   - 同一条记忆、同一个 updatedAt 版本已经出现在上下文里 → 摘要置空并标 deduped;
 *   - 没出现过的（含内容更新后的新版本）→ 照常带摘要，并记为“摘要已出现”。
 * 注入半边不在时 `contextDedup` 返回 undefined，保持老行为。
 */
function applySummaryDedupe(opts: MemoryToolsOptions, exec: unknown, records: SearchHit[]): void {
  if (records.length === 0) return
  const dedup = opts.contextDedup?.(exec)
  if (dedup === undefined) return
  const seen = dedup.seen(records)
  const newlyShown: SearchHit[] = []
  for (const record of records) {
    if (seen.has(record.id)) {
      record.summary = ''
      record.deduped = true
    } else {
      newlyShown.push(record)
    }
  }
  // 只把这次真的带摘要返回的条目记为已出现;被省略的本来就是已出现。
  if (newlyShown.length > 0) dedup.markSummary(newlyShown)
}

export interface SearchArgs {
  query: string
  scope?: string
  topK?: number
  /** 默认 false:已被 supersede 的旧版本不返回;历史核对时显式打开。 */
  includeSuperseded?: boolean
  /** 每条摘要的字数上限；默认 160。 */
  summaryChars?: number
  /** 本次调用的用途(给用户看);普通限制下必填,审批弹窗展示。 */
  description?: string
  /**
   * 0.27.0：默认 false。true = 范围外命中时立即向用户发起一次审批，
   * 允许的条目直接并入 records（0.26 及以前的行为）；默认改为只返回范围外
   * 索引（outOfScope 字段），由 Agent 判断值得读再显式发起。
   */
  requestApproval?: boolean
}

export interface SearchHit {
  id: string
  score: number
  scope: string
  kind: string
  tags: string[]
  updatedAt: number
  /** 只给开头一段（默认 160 字），正文用 memory_get 取。 */
  summary: string
  /**
   * true = 这一条已经以同版本出现在本会话上下文中，摘要被省略，
   * 渲染只给 id（0.21.0 上下文去重）。
   */
  deduped?: boolean
  /**
   * 0.94.0：这条是图增强（PPR 多跳）补召回进来的联想结果。provider 早就带了这个
   * 标记，但工具层此前把它丢了 —— 模型无法区分"直接命中"与"联想补召回"。
   */
  graphExpanded?: boolean
}

/**
 * 0.28.0：范围外命中的**作用域级**索引——只给「命中了哪个作用域、几条、这个作用域
 * 是干什么的」，**不再给条目摘要**。
 *
 * 为什么收窄：0.27.0 的条目索引会带短摘要，模型很容易把那段摘要当成「已经读到的东西」
 * 直接引用；而它其实是可见域外的内容。现在范围外只暴露作用域用途，模型据此判断
 * 要不要为某个作用域显式发起审批（requestApproval / memory_scopes request）。
 */
export interface OutOfScopeScopeEntry {
  scope: string
  records: number
  /** 作用域用途：scope-meta 手写过就用它，没写过按类型给默认描述。 */
  description: string
  /** 这个作用域的命中能否走审批放行（read:false / 已关闭的作用域不能）。 */
  requestable: boolean
}

export interface SearchResult {
  records: SearchHit[]
  /**
   * 有命中被可见域挡住、没有返回时告知模型数量与真实原因(不泄露正文)。
   * 0.23 起绝对限制 / 「不可读」开关也会出现在这里(不再假装不存在)。
   */
  withheld?: { count: number; reason: WithheldReason }
  /**
   * 0.28.0：范围外命中的作用域清单（条数 + 用途，不含任何记忆内容）。
   * 模型据此判断哪个作用域值得显式发起审批。
   */
  outOfScope?: { scopes: OutOfScopeScopeEntry[] }
}

/**
 * 范围外清单要展示的作用域用途：优先取 provider 目录里手写过的 description，
 * 拿不到（旧 provider / 目录里没有这个 scope）时按类型给默认描述。
 */
function scopeDescriptions(service: MemoryToolService, agent: unknown): Map<string, string> {
  const out = new Map<string, string>()
  if (typeof service.scopeCatalog !== 'function') return out
  try {
    for (const entry of service.scopeCatalog(agent)) {
      const description = typeof entry.description === 'string' ? entry.description.trim() : ''
      if (description !== '') out.set(entry.scope, description)
    }
  } catch {
    // 目录是增强：拿不到就退回类型默认描述，不让检索因此失败。
  }
  return out
}

export function memorySearchTool(opts: MemoryToolsOptions): ToolSpec<SearchArgs, SearchResult> {
  return {
    name: 'memory_search',
    description: 'Search saved memories by keyword or meaning (lexical + local vector recall). Returns id/scope/kind/tags and a short summary; use memory_get for full content. Hits recovered by multi-hop graph expansion (not a direct keyword/vector match) are marked 联想 in the rendered output and carry graphExpanded=true. Out-of-scope hits return only the list of scopes (name, hit count, purpose — no record summaries) in the outOfScope field instead of auto-raising approval; pass requestApproval=true only when those scopes are genuinely relevant.',
    parameters: {
      query: { type: 'string', required: true },
      scope: { type: 'string', description: SCOPE_DESCRIPTION },
      topK: { type: 'number', description: '1~20' },
      includeSuperseded: { type: 'boolean', description: '默认 false；true 时把已被 supersede 的旧版本也返回（历史核对）' },
      summaryChars: { type: 'number', description: `每条摘要的字数上限（默认 ${DEFAULT_SUMMARY_CHARS}，20~2000）` },
      asOf: { type: 'string', description: '双时态检索时间点（ISO 时间或毫秒时间戳）：只返回该时刻存在且成立的记忆，例如「当时我相信什么」。省略 = 当前。已物理清理的墓碑无法恢复。' },
      description: { type: 'string', description: DESCRIPTION_PARAM_DESCRIPTION },
      requestApproval: { type: 'boolean', description: '默认 false：范围外命中只返回作用域清单（scope + 条数 + 用途，不含任何记忆内容），不自动弹审批；true = 立即向用户发起审批，允许的条目并入 records。确认这些作用域的用途确实与本次任务相关后再传 true。' },
    },
    async execute(args: SearchArgs, exec?: unknown): Promise<SearchResult> {
      const service = svc(opts)
      const agent = agentOf(exec)
      requireDescription(service, agent, args.description)
      if (typeof args.query !== 'string' || args.query.trim().length === 0) {
        throw new MemoryToolError('QUERY_EMPTY', 'query must be a non-empty string')
      }
      const resolved = resolveScope(opts, service, exec, args.scope, 'read')
      const policy = visibilityPolicy(service, agent)
      const decide = decisionMaker(service, agent)
      const level = policy?.level ?? 'none'
      // level=none 时策略里的 scopes 只是偏好,不参与限制(等价于没有可见域)。
      const visible = policy !== undefined && policy.level !== 'none' ? policy.scopes.map((rule) => rule.scope) : undefined
      // 用户显式设过的策略(absolute / normal)才把磁盘上其它 scope 也搜一遍:
      // 既为普通限制找"可审批的命中",也让绝对限制能告诉 Agent「有几条被挡住」。
      // 默认策略不主动外扩,避免普通检索每次都扫全盘/弹审批。
      const expand = explicitPolicy(policy) && level !== 'none'
      let scopes: MemoryScope[] | undefined
      if (resolved.all) {
        if (visible !== undefined) {
          // 'all' 在有可见范围限制时只等于"所有可见范围",不是磁盘上的全部 scope。
          // 但显式 'all' 本身就表达"跨作用域",所以仍把磁盘上其它 scope 搜一遍:
          // 普通限制据此发起审批,绝对限制据此告诉 Agent 被挡住了几条。
          scopes = [...new Set([...visible, ...allKnownScopes(service)])]
        } else {
          scopes = allKnownScopes(service)
        }
      } else if (resolved.scope === undefined) {
        // 省略 scope:三路合并(会话 + 项目 + global),或显式可见范围。
        const merged = readScopes(opts, service, agent)
        scopes = expand ? [...new Set([...merged, ...allKnownScopes(service)])] : merged
      }
      const chars = resolveSummaryChars(args.summaryChars)
      try {
        const wantedTopK = args.topK !== undefined ? Math.min(20, Math.max(1, args.topK)) : undefined
        const asOf = parseAsOf(args.asOf)
        const hits = await service.search({
          text: args.query,
          ...(asOf !== undefined ? { asOf } : {}),
          // 0.106.0：必须把 agent 传下去，provider 才能按会话/工作区解析 memory_block。
          // 之前只传文本与作用域，导致 memory_block 对显式检索完全无效（只影响注入侧）。
          ...(agent !== undefined ? { agent } : {}),
          ...(resolved.scope !== undefined ? { scope: resolved.scope } : {}),
          ...(scopes !== undefined ? { scopes } : {}),
          // 多取一些候选,避免范围外命中挤掉范围内的结果。
          topK: Math.min(60, Math.max(10, (wantedTopK ?? 10) * 3)),
          ...(args.includeSuperseded === true ? { includeSuperseded: true } : {}),
        })
        const inside = hits.filter((hit) => recordAllowed(decide, policy, hit.record.scope, hit.record.kind))
        const outside = hits.filter((hit) => !recordAllowed(decide, policy, hit.record.scope, hit.record.kind))
        // 只有“作用域不在范围里”才可能审批;absolute 与 read:false 都不 requestable。
        const needsApproval = outside.filter((hit) => recordRequestable(decide, policy, hit.record.scope, hit.record.kind))
        // 0.27.0：普通限制下范围外命中**不再自动弹审批**。先把索引交给模型
        //（outOfScope 字段），要读正文时由 Agent 显式传 requestApproval=true。
        // 绝对限制 / 不可读 / 已关闭作用域照旧只进 withheld（它们没有审批路径）。
        const wantsApproval = args.requestApproval === true
        let verdict: ApprovalVerdict | undefined
        if (needsApproval.length > 0 && level === 'normal' && wantsApproval) {
          verdict = await askOutOfScope(
            service,
            agent,
            policy,
            'memory_search',
            args.query,
            needsApproval.map((hit) => hit.record),
            'read',
            (exec as { signal?: AbortSignal } | undefined)?.signal,
            descriptionOf(args.description),
          )
        }
        // verdict 为空 = 没有发起审批(绝对限制 / read:false / 没有范围外命中):范围外不放行。
        const approvedOutside = verdict === undefined
          ? []
          : verdict.outcome !== 'allowed-once'
            ? []
            : verdict.allowedIds === undefined
              ? needsApproval
              : needsApproval.filter((hit) => verdict!.allowedIds!.has(hit.record.id))
        const insideIds = new Set(inside.map((hit) => hit.record.id))
        const approvedOutsideIds = new Set(approvedOutside.map((hit) => hit.record.id))
        const selected = hits.filter((hit) => insideIds.has(hit.record.id) || approvedOutsideIds.has(hit.record.id))
        const result: SearchResult = {
          records: selected.map((h) => ({
            id: h.record.id,
            score: h.score,
            scope: h.record.scope,
            kind: h.record.kind,
            tags: Array.isArray(h.record.tags) ? h.record.tags : [],
            updatedAt: h.record.updatedAt,
            summary: summarize(h.record.content, chars),
            ...((h as { graphExpanded?: boolean }).graphExpanded === true ? { graphExpanded: true } : {}),
          })),
        }
        // 0.23:被挡住时告诉模型真实原因(绝对限制 / 不可读 / 审批拒绝…),不再假装不存在。
        const denied = outside.length - approvedOutside.length
        if (denied > 0) {
          const approvedIds = new Set(approvedOutside.map((hit) => hit.record.id))
          const deniedRecords = outside.filter((hit) => !approvedIds.has(hit.record.id))
          // 0.27.0：普通限制下没发起审批的范围外命中 = 'out-of-scope'（索引已在
          // outOfScope 字段给出）；审批后的结局（partial/rejected/timeout）与
          // absolute / read-disabled / scope-disabled 沿用原口径。
          const reason = verdict !== undefined
            ? withheldReasonFor(decide, policy, deniedRecords.map((hit) => ({ scope: hit.record.scope, kind: hit.record.kind })), verdict)
            : outOfScopeReason(decide, policy, deniedRecords.map((hit) => ({ scope: hit.record.scope, kind: hit.record.kind })))
          if (reason !== undefined) result.withheld = { count: denied, reason }
        }
        // 0.28.0：范围外清单（不含任何记忆内容）——命中了哪些作用域、各几条、
        // 这些作用域是干什么的。只在普通限制下给出：absolute 没有任何审批放行路径，
        // 清单只会引诱越权尝试。未发起审批（默认）或审批没全过时都会给出。
        // 条目摘要刻意**不再**返回：范围外的内容不进入上下文，避免模型把摘要当正文引用。
        const pendingOutside = outside.filter((hit) => !approvedOutsideIds.has(hit.record.id))
        if (pendingOutside.length > 0 && level === 'normal') {
          const requestableIds = new Set(needsApproval.map((hit) => hit.record.id))
          const byScope = new Map<string, { records: number; requestable: boolean }>()
          for (const hit of pendingOutside) {
            const entry = byScope.get(hit.record.scope) ?? { records: 0, requestable: false }
            entry.records += 1
            if (requestableIds.has(hit.record.id)) entry.requestable = true
            byScope.set(hit.record.scope, entry)
          }
          const descriptions = scopeDescriptions(service, agent)
          result.outOfScope = {
            scopes: [...byScope].map(([scope, entry]) => ({
              scope,
              records: entry.records,
              description: descriptions.get(scope) ?? defaultScopeDescription(scope),
              requestable: entry.requestable,
            })),
          }
        }
        if (wantedTopK !== undefined) result.records = result.records.slice(0, wantedTopK)
        // 上下文去重:同一条记忆同版本已经出现过 → 只回 id,摘要让 memory_get 按需取。
        applySummaryDedupe(opts, exec, result.records)
        return result
      } catch (error) {
        throw toolError(error)
      }
    },
  }
}

export interface ForgetArgs {
  id?: string
  query?: string
  scope?: string
  /** 本次调用的用途(给用户看);普通限制下必填,审批弹窗展示。 */
  description?: string
}

export interface ForgetResult {
  removed: number
  ids: string[]
}

export function memoryForgetTool(opts: MemoryToolsOptions): ToolSpec<ForgetArgs, ForgetResult> {
  return {
    name: 'memory_forget',
    description: 'Delete a memory by id (any scope), or all memories matching a query in one scope (default: current session).',
    parameters: {
      id: { type: 'string', description: '记录 id：完整 id 或 8 位前缀（与 memory_get 一致）' },
      query: { type: 'string', description: 'Substring match; by default only the current session scope' },
      scope: { type: 'string', description: "省略=当前会话；显式指定只删那一个作用域。'all' 不能与 query 同用(防批量误删)。" },
      description: { type: 'string', description: DESCRIPTION_PARAM_DESCRIPTION },
    },
    async execute(args: ForgetArgs, exec?: unknown): Promise<ForgetResult> {
      const service = svc(opts)
      const agent = agentOf(exec)
      requireDescription(service, agent, args.description)
      if (!args.id && !args.query) throw new MemoryToolError('TARGET_REQUIRED', 'provide id or query')
      if (args.id && args.query) throw new MemoryToolError('TARGET_AMBIGUOUS', 'provide id or query, not both')
      // 没有会话就不判断可见域:护栏只对"本会话的 Agent"生效(与 provider 一致)。
      const policy = agent === undefined ? undefined : visibilityPolicy(service, agent)
      const decide = decisionMaker(service, agent)
      const level = policy?.level ?? 'none'
      const signal = (exec as { signal?: AbortSignal } | undefined)?.signal
      // ---- 按 id 删除:先查出这条记录在哪个 scope,再按可写范围判断 ----
      if (args.id) {
        // 支持 8 位短 id（与 memory_get 一致）：检索结果/注入摘要里展示的就是短 id，
        // 用户复制过来应该能直接删。前缀命中多条时明确报歧义，绝不误删。
        // 老 provider 没有 getByIds 时保持原行为：直接把 id 交给 forget，不做前缀解析。
        // 注意：工具参数对象在运行时可能是冻结的（宿主防篡改），绝不能回写 args.id，
        // 解析结果放局部变量 targetId。
        let targetId = args.id
        const wanted = targetId.trim()
        const candidates = typeof service.getByIds === 'function' ? service.getByIds([wanted]) : null
        if (candidates !== null) {
          const exact = candidates.find((record) => record.id === wanted)
          if (exact === undefined && candidates.length === 0) {
            throw new MemoryToolError('RECORD_NOT_FOUND', `id ${wanted} not found`)
          }
          if (exact === undefined && candidates.length > 1) {
            throw new MemoryToolError('TARGET_AMBIGUOUS', `id ${wanted} 命中 ${candidates.length} 条记忆，请提供更长的 id 前缀`)
          }
          targetId = exact?.id ?? candidates[0]!.id
        }
        const matches = candidates === null ? [] : candidates.filter((record) => record.id === targetId)
        const blocked = matches.filter((record) => !scopeWritableBy(decide, service, agent, policy, record.scope))
        let approved = false
        if (blocked.length > 0) {
          const decision = decide('write', blocked[0]!.scope)
          if (decision !== undefined) {
            if (!decision.requestable) throw blockedRecordDecisionError(decision, blocked[0]!.scope, targetId)
          } else if (level === 'absolute' || policyRule(policy, blocked[0]!.scope) !== undefined) {
            // 老 provider 没有授权判定时保持原有纯策略判断。
            throw blockedRecordError(policy, blocked[0]!.scope, targetId)
          }
          if (level === 'normal') {
            const verdict = await askOutOfScope(
              service,
              agent,
              policy,
              'memory_forget',
              targetId,
              blocked,
              'delete',
              signal,
              descriptionOf(args.description),
            )
            if (!verdictAllows(verdict, targetId)) {
              throw visibilityError(verdict.outcome === 'allowed-once' ? 'rejected' : verdict.outcome, 'delete', blocked[0]!.scope)
            }
            approved = true
          }
        }
        try {
          return await service.forget({
            id: targetId,
            ...(agent !== undefined ? { agent } : {}),
            ...(approved ? { visibilityApproved: true } : {}),
          })
        } catch (error) {
          throw toolError(error)
        }
      }
      // ---- 按 query 删除:目标 scope 必须可写 ----
      const resolved = resolveScope(opts, service, exec, args.scope, 'read')
      if (resolved.all) {
        throw new MemoryToolError('SCOPE_NOT_WRITABLE', "scope 'all' cannot be combined with query; name the scope you mean")
      }
      const scope = resolved.scope ?? readScopes(opts, service, agent)[0]
      let approved = false
      if (level !== 'none' && scope !== undefined && !scopeWritableBy(decide, service, agent, policy, scope)) {
        const decision = decide('write', scope)
        if (decision !== undefined) {
          if (!decision.requestable) throw writeDecisionError(decision, scope, 'delete')
        } else if (policyRule(policy, scope) !== undefined || level === 'absolute') {
          // 老 provider 没有授权判定时保持原有纯策略判断。
          throw scopeWriteBlockedError(policy, scope, 'delete')
        }
        const verdict = await askOutOfScope(
          service,
          agent,
          policy,
          'memory_forget',
          `删除 ${scope} 中匹配「${args.query}」的记忆`,
          [{
            id: `query:${scope}`,
            scope,
            kind: 'note',
            content: `按关键词「${args.query}」删除该作用域中匹配的记忆`,
            tags: [],
            importance: 0,
            updatedAt: Date.now(),
          }],
          'delete',
          signal,
          descriptionOf(args.description),
        )
        if (!verdictAllows(verdict, `query:${scope}`)) {
          throw visibilityError(verdict.outcome === 'allowed-once' ? 'rejected' : verdict.outcome, 'delete', scope)
        }
        approved = true
      }
      try {
        return await service.forget({
          query: args.query,
          ...(scope !== undefined ? { scope } : {}),
          ...(agent !== undefined ? { agent } : {}),
          ...(approved ? { visibilityApproved: true } : {}),
        })
      } catch (error) {
        throw toolError(error)
      }
    },
  }
}

/** 毫秒时间戳 → ISO 8601 精确到秒（去掉毫秒）。非法值返回 undefined。 */
function isoSecond(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return new Date(value).toISOString().slice(0, 19) + 'Z'
}

/** memory_list 的 fields 解析：目前只认 full_time。 */
function listWantsFullTime(fields: readonly string[] | undefined): boolean {
  return Array.isArray(fields) && fields.some((field) => String(field).trim() === 'full_time')
}

export interface ListArgs {
  scope?: string
  kind?: string
  limit?: number
  /**
   * 可选字段选择。`full_time` = 每条记忆给出精确到秒的完整时间戳
   * （createdAt / updatedAt / expiresAt，ISO 8601 到秒）；不传则不带时间字段。
   */
  fields?: string[]
  /** 本次调用的用途(给用户看);普通限制下必填,审批弹窗展示。 */
  description?: string
}

export interface ListResult {
  records: Array<{
    id: string
    scope: string
    kind: string
    updatedAt: number
    content: string
    deduped?: boolean
    /** fields 含 full_time 时给出，ISO 8601 精确到秒（无该时间则为 undefined）。 */
    fullTime?: { createdAt: string; updatedAt: string; expiresAt?: string }
  }>
  /** 作用域清单(名字 + 条数);文案由 apply.ts 统一渲染(那里能查会话标题)。 */
  scopeStats?: Array<{ scope: string; records: number; pendingEmbeds: number; archived?: boolean }>
  /**
   * 有记录被可见域挡住时告知模型数量与真实原因(不泄露正文)。
   * 0.23 起绝对限制 / 「不可读」开关也会出现在这里。
   */
  withheld?: { count: number; reason: WithheldReason }
}

export function memoryListTool(opts: MemoryToolsOptions): ToolSpec<ListArgs, ListResult> {
  return {
    name: 'memory_list',
    description: 'List saved memories, most recently updated first.',
    parameters: {
      scope: { type: 'string', description: "省略=当前会话；'all'=所有作用域；其他值只列该作用域。" },
      kind: { type: 'string' },
      limit: { type: 'number', description: '1~200' },
      description: { type: 'string', description: DESCRIPTION_PARAM_DESCRIPTION },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description: '可选字段。`full_time` = 每条记忆给出精确到秒的完整时间戳（createdAt / updatedAt / expiresAt）；不传则不带。',
      },
    },
    async execute(args: ListArgs, exec?: unknown): Promise<ListResult> {
      const service = svc(opts)
      const agent = agentOf(exec)
      requireDescription(service, agent, args.description)
      const resolved = resolveScope(opts, service, exec, args.scope, 'read')
      const policy = visibilityPolicy(service, agent)
      const decide = decisionMaker(service, agent)
      const level = policy?.level ?? 'none'
      // level=none 时策略里的 scopes 只是偏好,不参与限制(等价于没有可见域)。
      const visible = policy !== undefined && policy.level !== 'none' ? policy.scopes.map((rule) => rule.scope) : undefined
      const readable = policy !== undefined && policy.level !== 'none'
        ? policy.scopes.filter((rule) => rule.read !== false).map((rule) => rule.scope)
        : undefined
      const expand = explicitPolicy(policy) && level !== 'none'
      let scopes: MemoryScope[] | undefined
      if (resolved.all) {
        if (visible !== undefined) {
          scopes = [...new Set([...visible, ...allKnownScopes(service)])]
        } else {
          scopes = allKnownScopes(service)
        }
      } else if (resolved.scope === undefined) {
        // 省略 scope:默认**只列当前会话**(按需求;读全部请显式 'all')。
        // 这是有意为之的窄口径,不因为"普通限制"就去列范围外的东西。
        scopes = readScopes(opts, service, agent).slice(0, 1)
      }
      let records: ListResult['records']
      let withheld: ListResult['withheld']
      try {
        const limit = args.limit !== undefined ? Math.min(200, Math.max(1, args.limit)) : 50
        const raw = await service.list({
          ...(resolved.scope !== undefined ? { scope: resolved.scope } : {}),
          ...(scopes !== undefined ? { scopes } : {}),
          ...(args.kind ? { kind: args.kind } : {}),
          // 多取一些候选,避免范围外记录挤掉范围内结果。
          limit: Math.min(200, Math.max(limit, limit * 2)),
        })
        const inside = raw.filter((record) => recordAllowed(decide, policy, record.scope, record.kind))
        const outside = raw.filter((record) => !recordAllowed(decide, policy, record.scope, record.kind))
        const needsApproval = outside.filter((record) => recordRequestable(decide, policy, record.scope, record.kind))
        let verdict: ApprovalVerdict | undefined
        if (needsApproval.length > 0 && level === 'normal') {
          verdict = await askOutOfScope(
            service,
            agent,
            policy,
            'memory_list',
            resolved.scope ?? args.scope ?? 'all',
            needsApproval,
            'read',
            (exec as { signal?: AbortSignal } | undefined)?.signal,
            descriptionOf(args.description),
          )
        }
        const approvedOutside = verdict === undefined
          ? []
          : verdict.outcome !== 'allowed-once'
            ? []
            : verdict.allowedIds === undefined
              ? needsApproval
              : needsApproval.filter((record) => verdict!.allowedIds!.has(record.id))
        const insideIds = new Set(inside.map((record) => record.id))
        const approvedOutsideIds = new Set(approvedOutside.map((record) => record.id))
        const selected = raw
          .filter((record) => insideIds.has(record.id) || approvedOutsideIds.has(record.id))
          .slice(0, limit)
        const wantFullTime = listWantsFullTime(args.fields)
        records = selected.map((r) => ({
          id: r.id,
          scope: r.scope,
          kind: r.kind,
          updatedAt: r.updatedAt,
          content: r.content,
          ...(wantFullTime
            ? {
                fullTime: {
                  createdAt: isoSecond(r.createdAt) ?? isoSecond(r.updatedAt) ?? '',
                  updatedAt: isoSecond(r.updatedAt) ?? '',
                  ...(r.expiresAt !== undefined && Number.isFinite(r.expiresAt)
                    ? { expiresAt: isoSecond(r.expiresAt)! }
                    : {}),
                },
              }
            : {}),
        }))
        const denied = outside.length - approvedOutside.length
        if (denied > 0) {
          const approvedIdSet = new Set(approvedOutside.map((record) => record.id))
          const deniedRecords = outside.filter((record) => !approvedIdSet.has(record.id))
          const reason = withheldReasonFor(decide, policy, deniedRecords.map((record) => ({ scope: record.scope, kind: record.kind })), verdict)
          if (reason !== undefined) withheld = { count: denied, reason }
        }
        // 上下文去重:同版本已经出现过 → 只回 id,正文让 memory_get 按需取。
        const dedup = opts.contextDedup?.(exec)
        if (dedup !== undefined && records.length > 0) {
          const seen = dedup.seen(records)
          const newlyShown: ListResult['records'] = []
          records = records.map((record) => {
            if (!seen.has(record.id)) {
              newlyShown.push(record)
              return record
            }
            return { ...record, content: '', deduped: true }
          })
          // 这次真的把正文放进上下文的条目,后续检索/召回都按"已出现"处理。
          if (newlyShown.length > 0) dedup.markContent(newlyShown)
        }
      } catch (error) {
        throw toolError(error)
      }
      const statsAll = service.scopeStats?.()
      const stats = statsAll !== undefined && readable !== undefined
        ? statsAll.filter((s) => readable.includes(s.scope))
        : statsAll
      return {
        records,
        ...(stats !== undefined ? { scopeStats: stats } : {}),
        ...(withheld !== undefined ? { withheld } : {}),
      }
    },
  }
}

export interface ScopesArgs {
  action?: 'list' | 'request' | 'edit'
  /** 默认 true；false 时只列当前可见域内的作用域。 */
  includeOutOfScope?: boolean
  limit?: number
  /**
   * action='request' 时要申请的作用域（1~5 个）。
   * 这里刻意用扁平字符串数组：DSH 的 defineTool 对象参数要求显式
   * `additionalProperties`，嵌套对象 schema 很容易在注册期抛错（0.24.0 踩过）。
   */
  scopes?: string[]
  /** action='request' 的权限，作用于上面所有 scopes；省略 = 只读。 */
  permissions?: Array<'read' | 'write'>
  /** action='request' 时的申请理由（展示在审批卡上）。 */
  reason?: string
  /** action='edit' 要编辑的作用域键（目录里显示的那个，如 `handbook` / `project:<路径>`）。 */
  scope?: string
  /**
   * action='edit'：新的用途（一句话）。空串 = 清空，回退到按类型的默认描述。
   * 省略 = 这次不改用途（与 scopeName 至少给一个）。
   */
  scopeDescription?: string
  /** action='edit'：新的别名。省略 = 不改；空串 = 移除别名。 */
  scopeName?: string
  /** 本次调用的用途(给用户看);普通限制下必填。 */
  description?: string
}

export interface ScopesResult {
  scopes: ScopeCatalogEntryView[]
  /** 过滤后（limit 之前）的总数。 */
  total: number
  /** 因 limit 被省略的条数。 */
  omitted: number
}

/**
 * action='edit' 的结果（0.29.0）：只回「改成了什么」，不回记忆内容。
 * 字段缺省 = 这次没动它；空串 = 已清空（用途）或已移除（别名）。
 */
export interface ScopeEditResultView {
  scope: string
  description?: string
  name?: string
}

export type ScopesToolResult = ScopesResult | ScopeGrantRequestResultView | ScopeEditResultView

/**
 * 作用域目录 / 权限申请工具（0.24.0）。
 *
 * list：只返回目录元信息与访问状态，**不返回任何记忆正文**；范围外条目的记录数
 * 也刻意不返回（条数会泄露“有没有内容”）。
 *
 * request：只申请**本会话**的授权（默认只读，写权限独立申请）。一次性访问不走这里，
 * 继续由 memory_* 的隐式审批处理；absolute 下所有申请都会得到 not-requestable。
 */
export function memoryScopesTool(opts: MemoryToolsOptions): ToolSpec<ScopesArgs, ScopesToolResult> {
  return {
    name: 'memory_scopes',
    description: 'List memory scopes with their purpose and access status (metadata only, no content), request session access to out-of-scope scopes, or edit a scope\'s purpose and alias. action="edit" updates the scope description (empty = clear, falls back to the type default) and/or alias (empty = remove); the scope must be writable in this session. action="request" defaults to read-only and requires a reason; absolute restriction never grants access.',
    parameters: {
      action: { type: 'string', enum: ['list', 'request', 'edit'], description: 'list = 目录；request = 申请范围外作用域的会话权限（默认只读）；edit = 编辑某个作用域的描述 / 别名（需要该作用域可写）' },
      includeOutOfScope: { type: 'boolean', description: 'list：默认 true；false 时只列当前可见域内的作用域。' },
      limit: { type: 'number', description: 'list：1~200，默认 50' },
      scopes: {
        type: 'array',
        items: { type: 'string' },
        description: 'request：要申请的作用域，最多 5 个（一次申请多个时共用同一组 permissions）；自定义作用域传裸名，如 "dsh-plugin-dev"（"custom:dsh-plugin-dev" 会自动归一）',
      },
      permissions: {
        type: 'array',
        items: { type: 'string', enum: ['read', 'write'] },
        description: 'request：申请哪些权限，省略 = 只读；写权限必须显式加 "write"',
      },
      reason: { type: 'string', description: 'request：一句话申请理由，展示在审批卡上' },
      scope: { type: 'string', description: 'edit：要编辑的作用域键（目录里显示的那个，如 handbook / project:<路径>）。当前会话范围外时先用 action="request" 申请写权限' },
      scopeDescription: { type: 'string', description: 'edit：新的用途（一句话，最多 500 字）。空串 = 清空并回退到按类型的默认描述；与本参数一起省略 scopeName 则报错。' },
      scopeName: { type: 'string', description: 'edit：新的别名（只影响显示与引用，不改作用域键；项目 / 自定义作用域支持）。空串 = 移除别名；省略 = 这次不改别名。' },
      description: { type: 'string', description: DESCRIPTION_PARAM_DESCRIPTION },
    },
    async execute(args: ScopesArgs, exec?: unknown): Promise<ScopesToolResult> {
      const service = svc(opts)
      const agent = agentOf(exec)
      requireDescription(service, agent, args.description)

      // ---- action='edit'：编辑作用域描述 / 别名（0.29.0）----
      // 只改**目录元数据**，不碰任何记忆记录；需要该作用域可写（范围外先用
      // action='request' 拿写权限，不走隐式审批 —— 审批卡里没有"一条记忆"可展示）。
      if (args.action === 'edit') {
        const rawScope = typeof args.scope === 'string' ? args.scope.trim() : ''
        if (rawScope === '') throw new MemoryToolError('SCOPE_REQUIRED', 'action="edit" 需要 scope（要编辑的作用域键，目录里显示的那个）')
        const wantDescription = typeof args.scopeDescription === 'string'
        const wantName = typeof args.scopeName === 'string'
        if (!wantDescription && !wantName) {
          throw new MemoryToolError('EDIT_NOTHING_TO_UPDATE', 'action="edit" 至少要给 scopeDescription 或 scopeName 之一（想清空用途传空串，想移除别名传空串）')
        }
        if (typeof service.describeScope !== 'function' && wantDescription) {
          throw new MemoryToolError('SCOPES_UNAVAILABLE', '当前 provider 不支持编辑作用域用途（请升级 @restregular/dsh-memory）')
        }
        if (typeof service.renameScope !== 'function' && wantName) {
          throw new MemoryToolError('SCOPES_UNAVAILABLE', '当前 provider 不支持编辑作用域别名（请升级 @restregular/dsh-memory）')
        }
        const resolved = resolveScope(opts, service, exec, rawScope, 'write')
        if (resolved.all === true) {
          throw new MemoryToolError('SCOPE_NOT_WRITABLE', "scope 'all' cannot be edited; name one scope")
        }
        const scope = resolved.scope ?? currentSessionScope(service, exec)
        if (scope === undefined) {
          throw new MemoryToolError('SCOPE_INVALID', `scope "${rawScope}" could not be resolved; use the concrete scope key shown by action="list"`)
        }
        // 可写护栏：与写入记忆同一把锁（write 开关 / absolute / 范围外）。
        const policy = visibilityPolicy(service, agent)
        const decide = decisionMaker(service, agent)
        const level = policy?.level ?? 'none'
        if (level !== 'none' && !scopeWritableBy(decide, service, agent, policy, scope)) {
          const decision = decide('write', scope)
          if (decision !== undefined) {
            if (!decision.requestable) throw writeDecisionError(decision, scope, 'write')
            throw new MemoryToolError(
              'SCOPE_NOT_WRITABLE',
              `作用域 ${scope} 不在本会话的可写范围内；编辑作用域信息需要写权限，先用 memory_scopes({ action: "request", scopes: ["${scope}"], permissions: ["write"] }) 申请，批准后重试。`,
            )
          }
          if (policy?.level === 'normal') {
            // 老 provider 没有统一判定：普通限制下范围外就是"可申请"，别报成绝对限制。
            throw new MemoryToolError(
              'SCOPE_NOT_WRITABLE',
              `作用域 ${scope} 不在本会话的可写范围内；编辑作用域信息需要写权限，先用 memory_scopes({ action: "request", scopes: ["${scope}"], permissions: ["write"] }) 申请，批准后重试。`,
            )
          }
          throw scopeWriteBlockedError(policy, scope, 'write')
        }
        const description = wantDescription ? String(args.scopeDescription) : undefined
        const name = wantName ? String(args.scopeName) : undefined
        const by = sessionIdOf(agent) ?? 'agent'
        try {
          const edited: ScopeEditResultView = { scope }
          if (description !== undefined) edited.description = service.describeScope!(scope, description, by).description
          if (name !== undefined) edited.name = service.renameScope!(scope, name).name ?? ''
          return edited
        } catch (error) {
          throw toolError(error)
        }
      }

      if (args.action === 'request') {
        if (typeof service.requestScopeGrants !== 'function') {
          throw new MemoryToolError('SCOPES_UNAVAILABLE', '当前 provider 不支持作用域权限申请（请升级 @restregular/dsh-memory）')
        }
        const rawScopes = Array.isArray(args.scopes)
          ? args.scopes.map((scope) => String(scope).trim()).filter((scope) => scope !== '')
          : []
        if (rawScopes.length === 0) {
          throw new MemoryToolError('REQUESTS_REQUIRED', 'action="request" 需要 scopes 数组（要申请的作用域键）')
        }
        // 0.26.0:作用域参数先过与其他 memory_* 相同的规范层。展示形式 `custom:<名字>`
        // 归一成裸名;非法名 / 'all' 在这里明确报错,而不是把 "custom:dsh-plugin-dev"
        // 这类键原样写进 grants —— 那种授权永远匹配不到记录,却会显示"已授予"。
        const normalizedScopes: string[] = []
        for (const raw of rawScopes) {
          const resolved = resolveScope(opts, service, exec, raw, 'read')
          if (resolved.all === true) {
            throw new MemoryToolError('SCOPE_NOT_WRITABLE', "scope 'all' cannot be requested; name one scope")
          }
          const scope = resolved.scope ?? currentSessionScope(service, exec)
          if (scope === undefined) {
            throw new MemoryToolError('SCOPE_INVALID', `scope "${raw}" could not be resolved; use a concrete scope name (e.g. 'dsh-plugin-dev')`)
          }
          if (!normalizedScopes.includes(scope)) normalizedScopes.push(scope)
        }
        if (normalizedScopes.length > 5) {
          throw new MemoryToolError('REQUESTS_TOO_MANY', '一次最多申请 5 个作用域；请分批申请')
        }
        const scopes = normalizedScopes
        const permissions = Array.isArray(args.permissions)
          ? [...new Set(args.permissions.filter((permission): permission is 'read' | 'write' => permission === 'read' || permission === 'write'))]
          : ['read' as const]
        const requested = permissions.length > 0 ? permissions : ['read' as const]
        const requests = scopes.map((scope) => ({ scope, permissions: requested }))
        const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
        try {
          const result = await service.requestScopeGrants(agent, {
            requests,
            ...(reason !== '' ? { reason } : {}),
            ...(args.description !== undefined ? { description: args.description } : {}),
            ...(exec as { signal?: AbortSignal } | undefined)?.signal !== undefined
              ? { signal: (exec as { signal?: AbortSignal }).signal }
              : {},
          })
          return {
            results: result.results,
            ...(result.outcome !== undefined ? { outcome: result.outcome } : {}),
          }
        } catch (error) {
          throw toolError(error)
        }
      }

      if (typeof service.scopeCatalog !== 'function') {
        throw new MemoryToolError('SCOPES_UNAVAILABLE', '当前 provider 不支持作用域目录（请升级 @restregular/dsh-memory）')
      }
      let all: ScopeCatalogEntryView[]
      try {
        all = service.scopeCatalog(agent)
      } catch (error) {
        throw toolError(error)
      }
      const filtered = args.includeOutOfScope === false ? all.filter((item) => item.inScope) : all
      const limit = args.limit !== undefined ? Math.min(200, Math.max(1, args.limit)) : 50
      return {
        scopes: filtered.slice(0, limit),
        total: filtered.length,
        omitted: Math.max(0, filtered.length - limit),
      }
    },
  }
}

/** memory_get 可按需取得的字段。id 始终返回，不在此列。 */
export const GET_FIELDS = [
  'content',
  'summary',
  'scope',
  'kind',
  'tags',
  'importance',
  'createdAt',
  'updatedAt',
  'expiresAt',
  'triggers',
  'supersedes',
  'initial',
] as const

export type GetField = (typeof GET_FIELDS)[number]

/** 省略 fields 时的默认视图：与旧版 memory_get 看到的内容一致。 */
export const DEFAULT_GET_FIELDS: GetField[] = ['content', 'scope', 'kind', 'tags']

export interface GetArgs {
  ids: string[]
  /** 只取这些字段；省略 = content + scope + kind + tags。 */
  fields?: GetField[] | string
  /** summary 字段的字数上限；默认 160。 */
  summaryChars?: number
  /** 本次调用的用途(给用户看);普通限制下必填,审批弹窗展示。 */
  description?: string
}

export type GetRecord = { id: string } & Partial<Record<GetField, unknown>>

export interface GetResult {
  records: GetRecord[]
  /** 本次实际生效的字段（渲染与调用方都不必再猜默认值）。 */
  fields: GetField[]
  missing: string[]
  /**
   * 有 id 命中但被可见域挡住时告知模型数量与真实原因(不泄露正文)。
   * 0.23 起绝对限制 / 「不可读」开关也会出现在这里;被挡住的 id 不再进 missing。
   */
  withheld?: { count: number; reason: WithheldReason }
}

const FIELD_BY_LOWER = new Map<string, GetField>(GET_FIELDS.map((field) => [field.toLowerCase(), field]))

/** 解析并校验 fields：接受数组，也接受逗号/空格分隔的字符串。 */
export function resolveGetFields(raw: GetArgs['fields']): GetField[] {
  if (raw === undefined || raw === null) return [...DEFAULT_GET_FIELDS]
  const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,\s]+/) : null
  if (items === null) {
    throw new MemoryToolError('FIELDS_INVALID', `fields must be an array or a comma-separated string; allowed: ${GET_FIELDS.join(', ')}`)
  }
  const fields: GetField[] = []
  const invalid: string[] = []
  for (const item of items) {
    const key = String(item).trim().toLowerCase()
    if (key === '') continue
    const field = FIELD_BY_LOWER.get(key)
    if (field !== undefined) {
      if (!fields.includes(field)) fields.push(field)
    } else if (!invalid.includes(key)) {
      invalid.push(key)
    }
  }
  if (invalid.length > 0) {
    throw new MemoryToolError('FIELDS_INVALID', `unknown field(s): ${invalid.join(', ')}; allowed: ${GET_FIELDS.join(', ')}`)
  }
  if (fields.length === 0) {
    throw new MemoryToolError('FIELDS_EMPTY', `fields 不能为空；可用：${GET_FIELDS.join(', ')}`)
  }
  return fields
}

function pickGetFields(
  record: GetSourceRecord,
  fields: GetField[],
  summaryChars: number,
): GetRecord {
  const out: GetRecord = { id: record.id }
  for (const field of fields) {
    switch (field) {
      case 'content': out.content = record.content; break
      case 'summary': out.summary = summarize(record.content, summaryChars); break
      case 'scope': out.scope = record.scope; break
      case 'kind': out.kind = record.kind; break
      case 'tags': out.tags = Array.isArray(record.tags) ? record.tags : []; break
      case 'importance': out.importance = record.importance; break
      case 'createdAt': out.createdAt = record.createdAt; break
      case 'updatedAt': out.updatedAt = record.updatedAt; break
      case 'expiresAt': if (record.expiredAt !== undefined) out.expiresAt = record.expiredAt; break
      case 'triggers': if (Array.isArray(record.triggers)) out.triggers = record.triggers; break
      case 'supersedes': if (record.supersedes !== undefined && record.supersedes !== '') out.supersedes = record.supersedes; break
      case 'initial': if (record.initial === true) out.initial = true; break
    }
  }
  return out
}

export function memoryGetTool(opts: MemoryToolsOptions): ToolSpec<GetArgs, GetResult> {
  return {
    name: 'memory_get',
    description: 'Fetch memories by id or by the 8-char id prefix shown in search/recall/digest output. Default fields: content + scope + kind + tags; pass fields to fetch only what you need (e.g. ["summary"], ["tags"], ["updatedAt"]).',
    parameters: {
      ids: { type: 'array', items: { type: 'string' }, description: '记忆 id 或摘要开头的 8 位前缀,1~50 个', required: true },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description: `只取这些字段，省略=${DEFAULT_GET_FIELDS.join('+')}；可选：${GET_FIELDS.join(' / ')}（id 始终返回）`,
      },
      summaryChars: { type: 'number', description: `summary 字段的字数上限（默认 ${DEFAULT_SUMMARY_CHARS}，20~2000）` },
      description: { type: 'string', description: DESCRIPTION_PARAM_DESCRIPTION },
    },
    async execute(args: GetArgs, exec?: unknown): Promise<GetResult> {
      const service = svc(opts)
      const agent = agentOf(exec)
      requireDescription(service, agent, args.description)
      const ids = Array.isArray(args.ids)
        ? [...new Set(args.ids.map(String).filter((id) => id.trim() !== ''))].slice(0, 50)
        : []
      if (ids.length === 0) throw toolError(new Error('ids 不能为空'))
      if (typeof service.getByIds !== 'function') {
        throw toolError(new Error('当前 provider 不支持 memory_get（请升级 @restregular/dsh-memory）'))
      }
      const fields = resolveGetFields(args.fields)
      const chars = resolveSummaryChars(args.summaryChars)
      try {
        // memory_get 是**模型真的取用了正文**：只有这一处触发取用反馈。
        const all = service.getByIds(ids, { trackUse: true })
        // 可见域是白名单:即使知道 id,也不能直接读别的范围/别的类型的正文。
        const policy = visibilityPolicy(service, agent)
        const decide = decisionMaker(service, agent)
        const level = policy?.level ?? 'none'
        const inside = all.filter((record) => recordAllowed(decide, policy, record.scope, record.kind))
        const outside = all.filter((record) => !recordAllowed(decide, policy, record.scope, record.kind))
        // read:false / absolute 都不 requestable;只有"作用域不在范围里"才审批。
        const needsApproval = outside.filter((record) => recordRequestable(decide, policy, record.scope, record.kind))
        let verdict: ApprovalVerdict | undefined
        if (needsApproval.length > 0 && level === 'normal') {
          verdict = await askOutOfScope(
            service,
            agent,
            policy,
            'memory_get',
            ids.join(' '),
            needsApproval,
            'read',
            (exec as { signal?: AbortSignal } | undefined)?.signal,
            descriptionOf(args.description),
          )
        }
        // verdict 为空 = 没有发起审批(绝对限制 / read:false):范围外不放行。
        const approvedOutside = verdict === undefined
          ? []
          : verdict.outcome !== 'allowed-once'
            ? []
            : verdict.allowedIds === undefined
              ? needsApproval
              : needsApproval.filter((record) => verdict!.allowedIds!.has(record.id))
        const insideIds = new Set(inside.map((record) => record.id))
        const approvedIds = new Set(approvedOutside.map((record) => record.id))
        const found = all.filter((record) => insideIds.has(record.id) || approvedIds.has(record.id))
        const denied = outside.length - approvedOutside.length
        const approvedIdSet = new Set(approvedOutside.map((record) => record.id))
        const deniedRecords = outside.filter((record) => !approvedIdSet.has(record.id))
        const reason = denied > 0
          ? withheldReasonFor(decide, policy, deniedRecords.map((record) => ({ scope: record.scope, kind: record.kind })), verdict)
          : undefined
        return {
          records: found.map((r) => pickGetFields(r, fields, chars)),
          fields,
          // 被可见域挡住的 id 不是"不存在":它们进 withheld 说明原因,不进 missing。
          missing: ids.filter((token) => !all.some((r) => r.id === token || r.id.startsWith(token))),
          ...(reason !== undefined
            ? { withheld: { count: denied, reason } }
            : {}),
        }
      } catch (error) {
        throw toolError(error)
      }
    },
  }
}

export interface BlockArgs {
  /** `block` = 屏蔽（默认）；`unblock` = 解除；`list` = 看当前屏蔽清单。 */
  action?: 'block' | 'unblock' | 'list'
  /**
   * 要屏蔽 / 解除的作用域键。**按作用域屏蔽需要审批** —— 会把整个域从本会话
   * （或整个工作区）的检索、注入、目录里藏起来。
   */
  scope?: string
  /** 要屏蔽 / 解除的记录 id 或 8 位前缀。按 id 屏蔽不需要审批。 */
  id?: string
  /**
   * 作用层级：`session`（默认，只影响本会话，不需要审批）/
   * `workspace`（影响该工作区所有会话，含历史与将来，**必须审批**）。
   */
  level?: 'session' | 'workspace'
  /** 为什么屏蔽（展示在面板与审批卡上）。 */
  reason?: string
  /** 本次调用的用途（普通限制下必填）。 */
  description?: string
}

export interface BlockResult {
  action: 'block' | 'unblock' | 'list'
  outcome: 'blocked' | 'rejected' | 'timeout' | 'unavailable' | 'unblocked' | 'listed'
  /** 现在生效的屏蔽（`action='list'` 时是完整清单）。 */
  blocks: MemoryBlockView[]
  /** 按 id 屏蔽时解析到的记录。 */
  records?: Array<{ id: string; scope: string; kind: string }>
  /** 被解除的条数（`action='unblock'`）。 */
  removed?: number
  /** 目标里含规则 —— 规则一律走审批，工具会明确告诉模型。 */
  containsRule?: boolean
  note?: string
}

const BLOCK_NOTE_SESSION =
  '会话级屏蔽只影响本会话（含子 Agent），随时用 memory_block({action:"unblock"}) 解除。'
const BLOCK_NOTE_WORKSPACE =
  '工作区级屏蔽影响该工作区所有会话（含历史与将来），需要用户审批；解除同样需要审批。'
const BLOCK_NOTE_RULE =
  '目标里含「硬性规则」：规则被屏蔽必须由用户确认，已提交审批。'

/**
 * 屏蔽工具（0.32.0）。
 *
 * 用途：Agent 发现某段记忆与本轮任务无关时，主动让它**不再出现**在检索、注入
 * 与目录里，而不是每次都被噪声打断。与 `memory_forget` 的区别：屏蔽不删数据，
 * 解除后原样回来；与「可见域」的区别：屏蔽不改读写权限，只把它藏起来。
 *
 * 审批矩阵（产品口径，不能改）：
 *   - 按记录 id / 前缀屏蔽 → **不弹审批**；
 *   - 按作用域屏蔽 → **弹审批**；
 *   - 目标是规则（kind='rule'）→ **一律弹审批**，即使按 id 屏蔽；
 *   - 会话级 → 不弹审批（只影响自己）；
 *   - 工作区级 → **一律弹审批**（影响所有会话）。
 */
export function memoryBlockTool(opts: MemoryToolsOptions): ToolSpec<BlockArgs, BlockResult> {
  return {
    name: 'memory_block',
    description: 'Hide memories that are irrelevant to the current task so they stop appearing in search, injection and the scope catalog — without deleting anything. Use it proactively: when recall/digest keeps injecting records that clearly belong to another project or stack, block them by record id (no approval, reversible) instead of tolerating the noise or deleting them. Blocking by record id/prefix needs no approval; blocking a whole scope, a rule (kind="rule"), or anything at workspace level raises an approval dialog for the user. action="unblock" removes a block; action="list" shows the active blocks. Blocks are recoverable: the data is never touched.',
    parameters: {
      action: {
        type: 'string',
        enum: ['block', 'unblock', 'list'],
        description: 'block = 屏蔽（默认）；unblock = 解除；list = 查看当前屏蔽清单',
      },
      scope: {
        type: 'string',
        description: '要屏蔽 / 解除的作用域键（如 global / project:<路径> / session:<id> / 自定义名）。按作用域屏蔽需要用户审批。',
      },
      id: {
        type: 'string',
        description: '要屏蔽 / 解除的记录 id 或 8 位前缀。按 id 屏蔽不需要审批；但目标是规则时仍需审批。',
      },
      level: {
        type: 'string',
        enum: ['session', 'workspace'],
        description: 'session（默认）= 只影响本会话，不审批；workspace = 影响该工作区所有会话（含历史与将来），必须审批。',
      },
      reason: { type: 'string', description: '为什么屏蔽（一句话，展示在面板与审批卡上）' },
      description: { type: 'string', description: '本次调用的用途（普通限制下必填，审批弹窗会展示给用户）' },
    },
    async execute(args, exec) {
      const service = svc(opts)
      const agent = agentOf(exec)
      requireDescription(service, agent, args.description)
      const action = args.action ?? 'block'
      if (action === 'list') {
        const blocks = typeof service.listBlocks === 'function' ? service.listBlocks(agent) : []
        return { action, outcome: 'listed', blocks }
      }
      if (typeof service.requestBlock !== 'function') {
        throw toolError(new MemoryToolError('UNSUPPORTED', '当前 provider 不支持屏蔽（请升级 @restregular/dsh-memory 到 0.32.0+）'))
      }
      const level: 'session' | 'workspace' = args.level === 'workspace' ? 'workspace' : 'session'
      const scope = typeof args.scope === 'string' ? args.scope.trim() : ''
      const id = typeof args.id === 'string' ? args.id.trim() : ''
      if (action === 'unblock') {
        if (scope === '' && id === '') {
          throw toolError(new MemoryToolError('TARGET_REQUIRED', 'unblock 需要 scope 或 id'))
        }
        if (typeof service.unblock !== 'function') {
          throw toolError(new MemoryToolError('UNSUPPORTED', '当前 provider 不支持解除屏蔽（请升级 @restregular/dsh-memory 到 0.32.0+）'))
        }
        const results = service.unblock(agent, {
          ...(args.level !== undefined ? { level } : {}),
          ...(scope !== '' ? { scope } : {}),
          ...(id !== '' ? { recordId: id } : {}),
        })
        const removed = results.reduce((sum, item) => sum + item.removed, 0)
        const blocks = typeof service.listBlocks === 'function' ? service.listBlocks(agent) : []
        return {
          action,
          outcome: removed > 0 ? 'unblocked' : 'unavailable',
          blocks,
          removed,
          ...(removed === 0 ? { note: '没有找到匹配的屏蔽记录（可能已经被解除）。' } : {}),
        }
      }
      if (scope === '' && id === '') {
        throw toolError(new MemoryToolError('TARGET_REQUIRED', 'block 需要 scope 或 id：按 id 屏蔽不需要审批，按作用域屏蔽会弹审批'))
      }
      try {
        const result = await service.requestBlock(agent, {
          ...(scope !== '' ? { scope } : {}),
          ...(id !== '' ? { id } : {}),
          level,
          ...(args.reason !== undefined ? { reason: args.reason } : {}),
          ...(args.description !== undefined ? { description: args.description } : {}),
          tool: 'memory_block',
          ...((exec as { signal?: AbortSignal } | undefined)?.signal !== undefined
            ? { signal: (exec as { signal?: AbortSignal }).signal }
            : {}),
        })
        const notes: string[] = []
        if (result.outcome === 'blocked') {
          notes.push(level === 'workspace' ? BLOCK_NOTE_WORKSPACE : BLOCK_NOTE_SESSION)
          if (result.containsRule === true) notes.push(BLOCK_NOTE_RULE)
        } else if (result.outcome === 'rejected') {
          notes.push('用户拒绝了这次屏蔽；记忆保持原样。')
        } else if (result.outcome === 'timeout') {
          notes.push('审批超时，屏蔽没有生效；记忆保持原样。')
        } else {
          notes.push('当前环境无法发起屏蔽（缺少会话或工作区上下文）。')
        }
        return {
          action,
          outcome: result.outcome,
          blocks: result.blocks,
          ...(result.records.length > 0 ? { records: result.records } : {}),
          ...(result.containsRule === true ? { containsRule: true } : {}),
          note: notes.join(' '),
        }
      } catch (error) {
        throw toolError(error)
      }
    },
  }
}

/** `memory_hooks` 支持的 action。 */
export type HookAction = 'list' | 'get' | 'save' | 'delete' | 'approve' | 'revoke-approval' | 'enable' | 'disable' | 'run'

export interface HooksArgs {
  action: HookAction
  /** get / delete / approve / enable / disable / run 的钩子 id（也接受唯一前缀）。 */
  id?: string
  /** save 时的脚本源码。 */
  code?: string
  /** save 时的时机；省略 = 沿用旧值（更新）或 'before-save'（新建）。 */
  phase?: HookPhaseView
  name?: string
  /**
   * 0.35.4：可选，把这条钩子关联到一条规则记忆（报错时会带上它、可用 memory_get 取全文）。
   * **省略 = 通用钩子**：不挂任何记忆，仅靠 scopes / kinds / phase 与脚本里的 ctx 决定何时自动执行。
   * 更新时省略 = 保留旧关联。
   */
  ruleId?: string
  /** 适用作用域键；省略 = 更新时保留、新建时全部适用。 */
  scopes?: string[]
  /** 适用记忆类型；省略 = 更新时保留、新建时全部适用。 */
  kinds?: string[]
  /** run 试跑时喂给脚本的正文。 */
  content?: string
  /**
   * delete 的二次确认：删除是不可逆的（hooks.json 直接覆盖、无回收站），
   * 必须显式传一次 —— 值等于目标钩子的 name 或 id 才执行删除。
   * 省略时只返回待确认清单（requiresConfirmation），不会删除。
   */
  confirm?: string
  /** 本次调用的用途(给用户看);普通限制下必填,审批弹窗展示。 */
  description?: string
}

export interface HooksResult {
  action: HookAction
  hooks: HookRecordView[]
  settings?: { enabled: boolean; timeoutMs: number; requireApproval: boolean; maxCodeChars: number }
  /** run 的试跑结果。 */
  outcomes?: HookOutcomeView[]
  /** 面向模型的一句话说明（审批结局等）。 */
  note?: string
  /** delete 未带正确 confirm 时 = true，此时 hooks 是"待删除"预览、removed=0。 */
  requiresConfirmation?: boolean
  removed?: number
}

/** 按 id 或唯一前缀找钩子（模型看不到完整 uuid 时也能操作）。 */
function findHook(service: MemoryToolService, raw: string): HookRecordView {
  const needle = raw.trim()
  if (needle === '') throw new MemoryToolError('HOOK_ID_REQUIRED', '需要 id：先用 action="list" 看现有钩子')
  if (typeof service.listHooks !== 'function') {
    throw new MemoryToolError('HOOKS_UNSUPPORTED', '当前 memory provider 不支持记忆钩子（请升级 @restregular/dsh-memory）')
  }
  const all = service.listHooks()
  const exact = all.find((hook) => hook.id === needle)
  if (exact !== undefined) return exact
  const matches = all.filter((hook) => hook.id.startsWith(needle) || hook.name === needle)
  if (matches.length === 1) return matches[0]!
  if (matches.length === 0) throw new MemoryToolError('HOOK_NOT_FOUND', `没有找到钩子 ${needle}`)
  throw new MemoryToolError('HOOK_AMBIGUOUS', `前缀 ${needle} 命中 ${matches.length} 个钩子，请给更长的 id`)
}

const HOOKS_TOOL_DESCRIPTION =
  'Manage executable memory hooks: scripts attached to rule memories that the plugin runs at a fixed phase. '
  + 'before-save validates a memory and can REJECT the save; after-save only observes; before-inject parses text before it enters context. '
  + 'Hook code lives in hooks.json and is NEVER part of memory search/list/digest. '
  + 'Deleting a hook is IRREVERSIBLE — action="delete" requires a two-step confirmation: first call without confirm to get a preview, then repeat with confirm="<hook name or id>". '
  + 'Load the `memory-hook-scripts` skill (via the `skill` tool) before writing code — it documents the entry-function names, the sandbox API, the return contract and ready-made examples.'

export function memoryHooksTool(opts: MemoryToolsOptions): ToolSpec<HooksArgs, HooksResult> {
  return {
    name: 'memory_hooks',
    description: HOOKS_TOOL_DESCRIPTION,
    parameters: {
      action: {
        type: 'string',
        enum: ['list', 'get', 'save', 'delete', 'approve', 'revoke-approval', 'enable', 'disable', 'run'],
        required: true,
        description: 'list=列全部（不含代码）；get=读代码；save=新建/更新；delete=删除（不可逆，**必须二次确认**：先不带 confirm 调用拿预览，再带 confirm="<钩子的 name 或 id>" 重复调用才真删）；approve=批准代码使其运行；revoke-approval=撤销批准（代码保留、变回待批准、不再运行）；enable/disable=旧别名（等同 approve/revoke-approval）；run=拿一段正文试跑（不写记忆）。',
      },
      id: { type: 'string', description: '钩子 id（或唯一前缀 / 名字）；get/delete/approve/revoke-approval/enable/disable/run 必填' },
      confirm: { type: 'string', description: 'delete 专用二次确认：值必须等于目标钩子的 name 或完整 id。删除不可逆（hooks.json 直接覆盖、无回收站），不带或写错只返回待删预览、不会删除。' },
      code: { type: 'string', description: '脚本源码（save 必填）。入口函数名与返回约定见技能 memory-hook-scripts。' },
      phase: {
        type: 'string',
        enum: ['before-save', 'after-save', 'before-inject'],
        description: '运行时机；省略 = 更新时沿用旧值，新建默认 before-save。',
      },
      name: { type: 'string', description: '显示名（面板与审批卡用）' },
      ruleId: {
        type: 'string',
        description: '可选：把钩子关联到一条规则记忆（报错时带 id，可用 memory_get 取全文）。'
          + '**省略 = 通用钩子**（不挂任何记忆，靠 scopes/kinds/phase 与脚本里的 ctx 决定何时自动执行）。更新时省略 = 保留旧关联。',
      },
      scopes: { type: 'array', items: { type: 'string' }, description: '适用作用域键；省略 = 全部适用（更新时保留旧值）' },
      kinds: { type: 'array', items: { type: 'string' }, description: '适用记忆类型（fact/rule/...）；省略 = 全部适用' },
      content: { type: 'string', description: 'run 试跑用的正文（只跑脚本，不写记忆）' },
      description: { type: 'string', description: DESCRIPTION_PARAM_DESCRIPTION },
    },
    async execute(args: HooksArgs, exec?: unknown): Promise<HooksResult> {
      const service = svc(opts)
      const agent = agentOf(exec)
      requireDescription(service, agent, args.description)
      if (typeof service.listHooks !== 'function') {
        throw new MemoryToolError('HOOKS_UNSUPPORTED', '当前 memory provider 不支持记忆钩子（请升级 @restregular/dsh-memory）')
      }
      const action = args.action
      const settings = typeof service.hookSettings === 'function' ? service.hookSettings() : undefined
      const withApproval = (hook: HookRecordView): HookRecordView =>
        typeof service.hookPendingApproval === 'function'
          ? { ...hook, pendingApproval: service.hookPendingApproval(hook.id) }
          : hook

      if (action === 'list') {
        return {
          action,
          hooks: service.listHooks().map(withApproval),
          ...(settings !== undefined ? { settings } : {}),
        }
      }

      if (action === 'get') {
        const hook = findHook(service, args.id ?? '')
        return { action, hooks: [withApproval(hook)], ...(settings !== undefined ? { settings } : {}) }
      }

      if (action === 'save') {
        const code = typeof args.code === 'string' ? args.code : ''
        if (code.trim() === '') throw new MemoryToolError('HOOK_CODE_REQUIRED', 'save 需要 code（脚本源码）')
        if (typeof service.saveHook !== 'function') {
          throw new MemoryToolError('HOOKS_UNSUPPORTED', '当前 memory provider 不支持记忆钩子（请升级 @restregular/dsh-memory）')
        }
        // 更新时省略的字段沿用旧值：脚本改了但作用域不想动是最常见的情况。
        const existing = args.id !== undefined && args.id !== '' ? findHook(service, args.id) : undefined
        const phase = args.phase ?? existing?.phase ?? 'before-save'
        let saved: HookRecordView
        try {
          saved = service.saveHook({
            ...(existing !== undefined ? { id: existing.id } : {}),
            ...(args.name !== undefined ? { name: args.name } : existing !== undefined ? { name: existing.name } : {}),
            phase,
            code,
            ...(args.scopes !== undefined ? { scopes: args.scopes.map(String) } : { scopes: existing?.scopes ?? [] }),
            ...(args.kinds !== undefined ? { kinds: args.kinds.map(String) } : { kinds: existing?.kinds ?? [] }),
            ...(args.description !== undefined ? { description: args.description } : {}),
            createdBy: 'agent',
            // 0.35.4：显式给了就更新；否则沿用旧关联；新建时省略 = 通用钩子（无 ruleId）。
            ...(args.ruleId !== undefined
              ? { ruleId: args.ruleId }
              : existing?.ruleId !== undefined ? { ruleId: existing.ruleId } : {}),
          })
        } catch (error) {
          throw toolError(error)
        }
        // 保存即申请批准：代码改过 / 首次创建都要用户点头。
        let approval = 'not-needed'
        if (typeof service.requestHookApproval === 'function') {
          try {
            approval = await service.requestHookApproval(agent, saved.id, {
              ...(args.description !== undefined ? { description: args.description } : {}),
              ...((exec as { signal?: AbortSignal } | undefined)?.signal !== undefined
                ? { signal: (exec as { signal?: AbortSignal }).signal }
                : {}),
            })
          } catch {
            approval = 'unavailable'
          }
        }
        return {
          action,
          hooks: [withApproval(saved)],
          ...(settings !== undefined ? { settings } : {}),
          note: approvalNote(approval),
        }
      }

      if (action === 'delete') {
        const hook = findHook(service, args.id ?? '')
        if (typeof service.deleteHook !== 'function') {
          throw new MemoryToolError('HOOKS_UNSUPPORTED', '当前 memory provider 不支持记忆钩子')
        }
        // 0.36.1：删除不可逆（hooks.json 硬覆盖、无回收站），必须二次确认。
        // 第一次调用不带 confirm → 只给"待删除"预览，不删；模型要把 name/id 回填到
        // confirm 再调一次才真删。确认值必须精确等于目标的 name 或 id，杜绝误删别的钩子。
        const confirmation = typeof args.confirm === 'string' ? args.confirm.trim() : ''
        const matches = confirmation !== '' && (confirmation === hook.name || confirmation === hook.id)
        if (!matches) {
          return {
            action,
            hooks: [withApproval(hook)],
            requiresConfirmation: true,
            removed: 0,
            note: `删除钩子「${hook.name}」是不可逆的（直接从 hooks.json 移除，没有回收站）。这是第一次确认：如确要删除，请用同样的 id 再调用一次并带上 confirm="${hook.name}"（或 confirm="${hook.id}"）；confirm 不符则不会删除。`,
          }
        }
        const deleted = service.deleteHook(hook.id)
        return {
          action,
          hooks: service.listHooks().map(withApproval),
          removed: deleted ? 1 : 0,
          note: deleted ? `已删除钩子 ${hook.name}。` : '这个钩子已经不存在了。',
        }
      }

      if (action === 'approve') {
        const hook = findHook(service, args.id ?? '')
        if (typeof service.requestHookApproval !== 'function') {
          throw new MemoryToolError('HOOKS_UNSUPPORTED', '当前 memory provider 不支持记忆钩子审批')
        }
        let outcome: string
        try {
          outcome = await service.requestHookApproval(agent, hook.id, {
            ...(args.description !== undefined ? { description: args.description } : {}),
            ...((exec as { signal?: AbortSignal } | undefined)?.signal !== undefined
              ? { signal: (exec as { signal?: AbortSignal }).signal }
              : {}),
          })
        } catch {
          outcome = 'unavailable'
        }
        const fresh = typeof service.getHook === 'function' ? service.getHook(hook.id) : undefined
        return {
          action,
          hooks: fresh !== undefined ? [withApproval(fresh)] : [],
          note: approvalNote(outcome),
        }
      }

      if (action === 'revoke-approval') {
        // 0.38.0：撤销批准 = 代码保留、变回待批准；未批准不会运行。与"停用"彻底分开。
        const hook = findHook(service, args.id ?? '')
        if (typeof service.revokeHookApproval !== 'function') {
          throw new MemoryToolError('HOOKS_UNSUPPORTED', '当前 memory provider 不支持撤销批准（请升级 @restregular/dsh-memory）')
        }
        const revoked = service.revokeHookApproval(hook.id)
        const fresh = typeof service.getHook === 'function' ? service.getHook(hook.id) : undefined
        return {
          action,
          hooks: fresh !== undefined ? [withApproval(fresh)] : [],
          note: revoked
            ? `已撤销「${hook.name}」的批准：代码保留，但变回待批准，**不会运行**。`
            : `「${hook.name}」本来就没有批准过。`,
        }
      }

      if (action === 'enable' || action === 'disable') {
        // 0.38.0：保留 action 仅为向后兼容 —— 启用/停用语义已移除，统一映射到批准/撤销批准。
        const hook = findHook(service, args.id ?? '')
        if (action === 'disable') {
          if (typeof service.revokeHookApproval !== 'function') {
            throw new MemoryToolError('HOOKS_UNSUPPORTED', '当前 memory provider 不支持撤销批准（请升级 @restregular/dsh-memory）')
          }
          const revoked = service.revokeHookApproval(hook.id)
          const fresh = typeof service.getHook === 'function' ? service.getHook(hook.id) : undefined
          return {
            action,
            hooks: fresh !== undefined ? [withApproval(fresh)] : [],
            note: `「停用」已更名为「撤销批准」：${revoked ? '已撤销批准，代码保留但**不会运行**。' : '本来就未批准。'}`,
          }
        }
        if (typeof service.approveHook !== 'function') {
          throw new MemoryToolError('HOOKS_UNSUPPORTED', '当前 memory provider 不支持批准')
        }
        service.approveHook(hook.id)
        const fresh = typeof service.getHook === 'function' ? service.getHook(hook.id) : undefined
        return {
          action,
          hooks: fresh !== undefined ? [withApproval(fresh)] : [],
          note: '「启用」已更名为「批准」：已批准这段代码，从现在起会运行。',
        }
      }

      // run：拿一段正文试跑，不写记忆。这是唯一能"先看效果再上线"的入口。
      const hook = findHook(service, args.id ?? '')
      if (typeof service.runHookTrial !== 'function') {
        throw new MemoryToolError('HOOKS_UNSUPPORTED', '当前 memory provider 不支持记忆钩子试跑（请升级 @restregular/dsh-memory）')
      }
      const content = typeof args.content === 'string' && args.content.trim() !== ''
        ? args.content
        : throwErr(new MemoryToolError('HOOK_CONTENT_REQUIRED', 'run 需要 content：拿一段正文让脚本跑一次'))
      // 0.35.2：按 id 精确试跑这一条，绕过审批门禁。老写法用 phase+scope/kind
      // 再过滤一遍，未批准的钩子会被门禁挡掉、表现为"脚本没有命中"，与
      // 技能里"先 run 试跑再上线"的流程直接矛盾。
      const input = {
        memory: {
          scope: (args.scopes ?? hook.scopes)[0] ?? 'global',
          kind: (args.kinds ?? hook.kinds)[0] ?? 'rule',
          content,
          tags: [],
          importance: 0.8,
        },
        tool: 'memory_hooks',
        // 0.37.0：试跑也带设置快照，脚本里读 ctx.settings.* 不会是 undefined。
        settings: { digestChars: 160, impressionChars: 120, recallChars: 300 },
      }
      const mine = service.runHookTrial(hook.id, input)
      const verdict = mine[0]
      const ruleRef = verdict?.hook.ruleId !== undefined && verdict.hook.ruleId !== ''
        ? `（关联规则记忆 ${verdict.hook.ruleId}，可用 memory_get 取全文）`
        : ''
      const note = verdict === undefined
        ? '脚本没有命中这次输入（作用域/类型过滤把它排除了）。'
        : verdict.error !== undefined
          ? `脚本运行失败：${verdict.error}`
          : verdict.ok
            ? `脚本判定：通过。${ruleRef}`
            : `脚本判定：不通过 —— ${verdict.message ?? '（脚本没给 message）'}${ruleRef}`
      return { action, hooks: [withApproval(hook)], outcomes: mine, note }
    },
  }
}

/** 抛出一个值（给不能在表达式位置写 throw 的地方用）。 */
function throwErr(error: Error): never {
  throw error
}

/** 审批结局 → 给模型的一句话。 */
function approvalNote(outcome: string): string {
  switch (outcome) {
    case 'approved':
      return '用户已批准这段代码，从现在起会按这个时机运行。'
    case 'not-needed':
      return '这段代码之前已经批准过（同一份代码不会重复打扰用户）。'
    case 'rejected':
      return '用户拒绝运行这段代码：钩子已保存但**处于未批准状态，不会运行**。改脚本或让用户批准后才能生效。'
    case 'timeout':
      return '等待用户批准超时：钩子已保存但**不会运行**，需要用户批准后才生效。'
    default:
      return '当前环境无法发起代码审批：钩子已保存但**不会运行**。'
  }
}

export function memoryCoreTool(opts: MemoryToolsOptions): ToolSpec<Record<string, unknown>, Record<string, unknown>> {
  return {
    name: 'memory_core',
    description: 'Read or update the three always-in-context core memory blocks: identity (who this agent is), profile (stable facts about the user), goal (what the current work is about). These blocks are injected into every turn and are NOT searchable records — use memory_save for ordinary memories. action="get" shows the current blocks; action="set" writes a new version (empty content clears it); action="history" lists recent versions; action="restore" brings back a version by number.',
    parameters: {
      action: { type: 'string', enum: ['get', 'set', 'history', 'restore'], description: 'get（默认）/ set / history / restore' },
      slot: { type: 'string', enum: ['identity', 'profile', 'goal'], description: '要操作的槽位' },
      content: { type: 'string', description: 'set 时的正文；传空串表示清空该槽位' },
      version: { type: 'number', description: 'restore 时要恢复的版本号' },
      expectedVersion: { type: 'number', description: 'set 时的乐观并发校验：版本不匹配则拒绝' },
    },
    async execute(args, exec) {
      const service = svc(opts)
      const agent = agentOf(exec)
      const action = typeof args.action === 'string' ? args.action : 'get'
      if (typeof service.coreSet !== 'function') {
        throw toolError(new MemoryToolError('UNSUPPORTED', '当前 provider 不支持核心记忆块（请升级 @restregular/dsh-memory）'))
      }
      if (action === 'get') {
        return { blocks: service.coreBlocks?.() ?? {} }
      }
      const slot = String(args.slot ?? '')
      if (slot !== 'identity' && slot !== 'profile' && slot !== 'goal') {
        throw toolError(new MemoryToolError('CORE_SLOT_INVALID', 'slot 只能是 identity / profile / goal'))
      }
      if (action === 'history') {
        return { slot, versions: service.coreHistory?.(slot) ?? [] }
      }
      if (action === 'restore') {
        const version = Number(args.version)
        const versions = service.coreHistory?.(slot) ?? []
        const target = versions.find((item) => item.version === version)
        if (target === undefined) {
          throw toolError(new MemoryToolError('CORE_VERSION_UNKNOWN', `没有找到 ${slot} 的 v${version}`))
        }
        const state = service.coreSet({ slot, content: target.content, agent })
        return { slot, restoredFrom: version, state }
      }
      const content = typeof args.content === 'string' ? args.content : ''
      const expectedVersion = typeof args.expectedVersion === 'number' ? args.expectedVersion : undefined
      const state = service.coreSet({ slot, content, agent, ...(expectedVersion !== undefined ? { expectedVersion } : {}) })
      return { slot, state }
    },
  }
}

export function memoryTools(opts: MemoryToolsOptions) {
  return {
    memory_save: memorySaveTool(opts),
    memory_core: memoryCoreTool(opts),
    memory_search: memorySearchTool(opts),
    memory_forget: memoryForgetTool(opts),
    memory_list: memoryListTool(opts),
    memory_scopes: memoryScopesTool(opts),
    memory_get: memoryGetTool(opts),
    memory_block: memoryBlockTool(opts),
    memory_hooks: memoryHooksTool(opts),
  }
}
