/**
 * Cordis wiring for dsh-memory-local. Loaded only inside DSH.
 *
 * Per the official docs:
 *  - registers the service so consumers reach it as `ctx.memory`
 *  - the LLM rerank caller adapts `ctx.llm` (one-shot GenerateOptions with
 *    RequestUserInput) — attached lazily via ctx.get, so the plugin never sits
 *    PENDING just because no LLM adapter is loaded
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type {
  MemoryHit,
  MemoryListInput,
  MemoryQuery,
  MemoryRecord,
  MemorySaveInput,
  MemoryScope,
} from 'dsh-memory'
import { LocalMemoryService, type MemoryLocalConfig } from './index.ts'
import { MemoryEventBus, type MemoryEventSink } from './events.ts'
import type { MemoryStore } from './store.ts'

export const name = 'dsh-memory-local'

export class CordisMemoryService extends Service {
  private impl: LocalMemoryService

  constructor(ctx: Context, config: MemoryLocalConfig = {}) {
    super(ctx, 'memory')
    this.impl = new LocalMemoryService(config)
    // 会话可见范围的继承要沿 parentSession 链走;这里只放一个惰性查询,
    // sessions 服务晚于本插件就绪也能在真正解析时拿到。
    this.impl.setSessionLookup((id) => {
      try {
        return (ctx.get('sessions') as { get?(sessionId: string): unknown } | undefined)?.get?.(id)
      } catch {
        return undefined
      }
    })
    // 0.30.0：会话作用域跟随宿主会话生命周期。归档状态**实时**读取
    // `workspaceRegistry.archivedSessionIds`，不缓存、不复制 —— 归档即刻不可检索，
    // 恢复即刻复原，不需要任何同步动作。
    this.impl.setArchivedSessionLookup(() => {
      try {
        const registry = ctx.get('workspaceRegistry') as { archivedSessionIds?: unknown } | undefined
        const ids = registry?.archivedSessionIds
        return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
      } catch {
        return []
      }
    })
    this.attachSessionLifecycle(ctx)
    // 0.31.0：记忆事件总线。宿主有 `emit` 就转发成宿主事件（其他插件可 ctx.on 订阅），
    // 没有就只做进程内广播 —— 事件是旁路，不能因为宿主缺 API 让记忆加载失败。
    this.impl.setEventBus(new MemoryEventBus(hostEventSink(ctx)))
    // 0.11.1:同一个目录因为 `D:/x` 与 `D:\x` 写法不同而分叉成两个 scope 的历史数据,
    // 在装配期合并一次(每进程一次;失败只影响合并,不影响读写)。
    try {
      this.impl.reconcileScopes()
    } catch {
      // 合并失败:两个 scope 继续并存(读写仍然正常),不阻断插件加载
    }
    ctx.effect(() => () => this.impl.flushSync())
    this.attachRerank(ctx, config)
  }

  /**
   * 0.30.0：把「会话作用域」接到宿主的会话生命周期上。
   *
   * - **创建**：`session/created` 时系统自动建立会话作用域（只写用途元数据，不写记忆）；
   * - **归档 / 恢复**：不写任何东西 —— 检索与授权实时读
   *   `workspaceRegistry.archivedSessionIds`，归档即不可检索，恢复即复原；
   * - 启动补建：`sessions` 服务就绪后，给已存在的会话补上作用域。
   *
   * 监听器绝不能抛：`session/created` 的异常会回滚会话创建（宿主契约）。
   */
  private attachSessionLifecycle(ctx: Context): void {
    try {
      ctx.on('session/created', (session: unknown) => {
        try {
          const id = liveSessionIdOf(session)
          if (id !== undefined) this.impl.ensureSessionScope(id)
        } catch {
          // 记忆侧失败不能回滚会话创建。
        }
      })
    } catch {
      // 老宿主没有该事件：退化为懒创建（第一次写记忆时才建作用域）。
    }
    try {
      ctx.inject(['sessions'], (child) => {
        try {
          const sessions = child.get('sessions') as { list?(): unknown } | undefined
          const list = sessions?.list?.()
          if (!Array.isArray(list)) return
          for (const session of list) {
            try {
              const id = liveSessionIdOf(session)
              if (id !== undefined) this.impl.ensureSessionScope(id)
            } catch {
              // 单个会话失败不影响其它会话。
            }
          }
        } catch {
          // 服务形状不符：跳过补建，后续 session/created 仍会建。
        }
      })
    } catch {
      // 老宿主 / 测试环境没有 inject：只靠 session/created。
    }
  }

  /**
   * Wire the rerank stage to ctx.llm when both it and a model are configured.
   * Uses the documented one-shot shape: GenerateOptions + RequestUserInput,
   * consuming `text-delta` chunks until finish.
   */
  private attachRerank(ctx: Context, config: MemoryLocalConfig): void {
    const llmCfg = config.retrieval?.llm
    if (!llmCfg?.enabled || !llmCfg.model) return
    const llm = ctx.get('llm') as
      | { stream(options: unknown): AsyncIterable<{ type: string; textDelta?: string }> }
      | undefined
    if (!llm?.stream) return
    this.impl.setLlmInvoke(async ({ system, prompt, signal }) => {
      const chunks: string[] = []
      const stream = llm.stream({
        provider: llmCfg.provider || 'deepseek',
        model: llmCfg.model,
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens: 300,
        temperature: 0,
        signal,
      })
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta' && typeof chunk.textDelta === 'string') chunks.push(chunk.textDelta)
      }
      return chunks.join('')
    })
  }

  save(input: MemorySaveInput): Promise<MemoryRecord> {
    return this.impl.save(input)
  }

  /** Direct store access for server-side consumers (e.g. the memory panel). */
  get store(): MemoryStore {
    return this.impl.store
  }

  /** Embedding-backend lifecycle, exposed for the memory panel's buttons. */
  embedServerStatus(): ReturnType<LocalMemoryService['embedServerStatus']> {
    return this.impl.embedServerStatus()
  }

  startEmbedServerManually(): ReturnType<LocalMemoryService['startEmbedServerManually']> {
    return this.impl.startEmbedServerManually()
  }

  stopEmbedServerManually(): ReturnType<LocalMemoryService['stopEmbedServerManually']> {
    return this.impl.stopEmbedServerManually()
  }

  /** Panel: download llama.cpp + the GGML model, then adopt and start them. */
  installVectorBackend(override?: Parameters<LocalMemoryService['installVectorBackend']>[0]): void {
    this.impl.installVectorBackend(override ?? {})
  }

  /** Panel: 模型清单 + 硬件探测 + 按硬件推荐(探测有缓存,只在面板问的时候跑)。 */
  modelsReport(force = false): ReturnType<LocalMemoryService['modelsReport']> {
    return this.impl.modelsReport(force)
  }

  /** Panel: abort an in-flight download. */
  cancelVectorInstall(): void {
    this.impl.cancelVectorInstall()
  }

  /** Panel: remove the runtime + model we installed (never the memory store). */
  uninstallVectorBackend(): ReturnType<LocalMemoryService['uninstallVectorBackend']> {
    return this.impl.uninstallVectorBackend()
  }

  /** Panel: delete every record in every scope. */
  wipeAllRecords(): ReturnType<LocalMemoryService['wipeAllRecords']> {
    return this.impl.wipeAllRecords()
  }

  /** 面板：撤销软删（墓碑恢复）。 */
  restoreRecord(id: string, opts?: { force?: boolean }): ReturnType<LocalMemoryService['restoreRecord']> {
    return this.impl.restoreRecord(id, opts ?? {})
  }

  /** 面板：手动触发一次记忆巩固。 */
  consolidateNow(): ReturnType<LocalMemoryService['consolidateNow']> {
    return this.impl.consolidateNow()
  }

  /** 面板/运维：导出快照（gzip JSONL，不含向量）。 */
  snapshotStore(file: string, opts?: Parameters<LocalMemoryService['snapshotStore']>[1]): ReturnType<LocalMemoryService['snapshotStore']> {
    return this.impl.snapshotStore(file, opts ?? {})
  }

  /** 面板/运维：从快照恢复。 */
  restoreStore(file: string, opts?: Parameters<LocalMemoryService['restoreStore']>[1]): ReturnType<LocalMemoryService['restoreStore']> {
    return this.impl.restoreStore(file, opts ?? {})
  }

  search(query: MemoryQuery): Promise<MemoryHit[]> {
    return this.impl.search(query)
  }

  /** 面板「语义检索」:同一套召回排序,只读且带向量通道状态。 */
  searchForPanel(input: Parameters<LocalMemoryService['searchForPanel']>[0]): ReturnType<LocalMemoryService['searchForPanel']> {
    return this.impl.searchForPanel(input)
  }

  forget(input: { id?: string; query?: string; scope?: MemoryScope; scopes?: MemoryScope[] }): Promise<{ removed: number; ids: string[] }> {
    return this.impl.forget(input)
  }

  list(input?: MemoryListInput): Promise<MemoryRecord[]> {
    return this.impl.list(input)
  }

  /** memory_get:按 id 批量取记录。 */
  getByIds(ids: string[], opts?: { trackUse?: boolean }): MemoryRecord[] {
    return this.impl.getByIds(ids, opts ?? {})
  }

  /** 面板新建记忆 / 规则。 */
  createRecord(input: Parameters<LocalMemoryService['createRecord']>[0]): Promise<MemoryRecord> {
    return this.impl.createRecord(input)
  }

  /** 面板编辑:新建一条修正版并通过 supersedes 指向旧记录(0.23.0)。 */
  reviseRecord(input: Parameters<LocalMemoryService['reviseRecord']>[0]): ReturnType<LocalMemoryService['reviseRecord']> {
    return this.impl.reviseRecord(input)
  }

  /** 面板导出:纯文本 + 元数据,不含向量。 */
  exportAll(): ReturnType<LocalMemoryService['exportAll']> {
    return this.impl.exportAll()
  }

  /** 面板导入:逐条 save(自动重新嵌入),失败不中断。 */
  importRecords(input: unknown): ReturnType<LocalMemoryService['importRecords']> {
    return this.impl.importRecords(input)
  }

  /** 设置页显示规则条数。 */
  ruleStats(): ReturnType<LocalMemoryService['ruleStats']> {
    return this.impl.ruleStats()
  }

  /** 同步列记录(系统提示里的规则段用,不能等异步 list)。 */
  listSync(input: Parameters<LocalMemoryService['listSync']>[0]): ReturnType<LocalMemoryService['listSync']> {
    return this.impl.listSync(input)
  }

  /** 面板编辑后立即重建这一条的向量。 */
  reindexRecord(scope: MemoryScope, id: string): Promise<boolean> {
    return this.impl.reindexRecord(scope, id)
  }

  /** 维护:重建全部向量(作废旧向量并重新嵌入)。 */
  reindexAll(): ReturnType<LocalMemoryService['reindexAll']> {
    return this.impl.reindexAll()
  }

  /** 维护:作废全部向量并按当前模型后台重嵌。 */
  reindexAll(): ReturnType<LocalMemoryService['reindexAll']> {
    return this.impl.reindexAll()
  }

  /** 作用域别名(没有则 undefined)。 */
  scopeName(scope: MemoryScope): string | undefined {
    return this.impl.scopeName(scope)
  }

  /** 作用域用途等元数据(没有则 undefined)。 */
  scopeMeta(scope: MemoryScope): ReturnType<LocalMemoryService['scopeMeta']> {
    return this.impl.scopeMeta(scope)
  }

  /** 写入 / 更新 / 清空作用域用途(不创建记录)。 */
  describeScope(scope: MemoryScope, description: string, by: string): ReturnType<LocalMemoryService['describeScope']> {
    return this.impl.describeScope(scope, description, by)
  }

  /** 设置 / 移除作用域别名(只影响显示与引用,不改变作用域键)。 */
  renameScope(scope: MemoryScope, name: string | undefined | null): ReturnType<LocalMemoryService['renameScope']> {
    return this.impl.renameScope(scope, name)
  }

  /** 作用域目录:名字 / 用途 / 当前可读可写状态(工具 memory_scopes 与面板共用)。 */
  scopeCatalog(agent: unknown): ReturnType<LocalMemoryService['scopeCatalog']> {
    return this.impl.scopeCatalog(agent)
  }

  /** 注入设置(面板「设置」标签页读它)。 */
  injectSettings(): ReturnType<LocalMemoryService['injectSettings']> {
    return this.impl.injectSettings()
  }

  /** 面板改设置:落盘后广播,注入半边下一步就能按新设置跑。 */
  updateInjectSettings(patch: unknown): ReturnType<LocalMemoryService['injectSettings']> {
    const next = this.impl.updateInjectSettings(patch)
    try {
      this.ctx.emit('memory/inject-settings', next)
    } catch { /* 广播失败不影响设置本身 */ }
    return next
  }

  /** 注入半边注册审计 sink；Cordis 服务必须显式转发，否则面板拿到的是 undefined。 */
  attachInjectAudit(sink: Parameters<LocalMemoryService['attachInjectAudit']>[0]): void {
    this.impl.attachInjectAudit(sink)
  }

  /** 按 sink 身份解绑（插件半边卸载/热重载）。 */
  detachInjectAudit(sink?: unknown): void {
    this.impl.detachInjectAudit(sink)
  }

  /** 旧接口：审计条目数组。 */
  injectAudit(sessionId?: string): ReturnType<LocalMemoryService['injectAudit']> {
    return this.impl.injectAudit(sessionId)
  }

  /** v2 审计分页查询。 */
  injectAuditPage(query?: unknown): ReturnType<LocalMemoryService['injectAuditPage']> {
    return this.impl.injectAuditPage(query)
  }

  /** 审计容量/丢弃/写入错误。 */
  injectAuditStats(): ReturnType<LocalMemoryService['injectAuditStats']> {
    return this.impl.injectAuditStats()
  }

  /**
   * 当前 agent 上下文 → 默认合并读取范围(会话 + 项目 + global,按开关与 key 去重)。
   * 工具与召回注入都走它,保证与 `resolveWriteScope` 是同一套口径。
   */
  resolveReadScopes(agent: unknown): MemoryScope[] {
    return this.impl.resolveReadScopes(agent)
  }

  /** 显式「可见范围」覆盖(undefined = 未设置);工具用它判断是否限制 memory_get。 */
  visibleScopes(agent: unknown): MemoryScope[] | undefined {
    return this.impl.visibleScopes(agent)
  }

  /** 完整可见域(等级 + 每个 scope 的类型白名单 + 来源)。0.20 起永远有值。 */
  visibilityPolicy(agent: unknown): ReturnType<LocalMemoryService['visibilityPolicy']> {
    return this.impl.visibilityPolicy(agent)
  }

  /** 可见范围 = 可操作范围:写入/删除前用它判断一个 scope 是否可操作。 */
  isScopeOperable(agent: unknown, scope: string): boolean {
    return this.impl.isScopeOperable(agent, scope)
  }

  /** 某个作用域是否可读(0.23.0 的 read 开关)。 */
  isScopeReadable(agent: unknown, scope: string): boolean {
    return this.impl.isScopeReadable(agent, scope)
  }

  /** 某个作用域是否可写(0.23.0 的 write 开关)。 */
  isScopeWritable(agent: unknown, scope: string): boolean {
    return this.impl.isScopeWritable(agent, scope)
  }

  /** 统一授权判定(0.24.0)：read/write/delete/discover 的唯一规则出口。 */
  authorize(agent: unknown, request: Parameters<LocalMemoryService['authorize']>[1]): ReturnType<LocalMemoryService['authorize']> {
    return this.impl.authorize(agent, request)
  }

  /** 一次解析、多次判定(检索逐条过滤用)。 */
  accessEvaluator(agent: unknown): ReturnType<LocalMemoryService['accessEvaluator']> {
    return this.impl.accessEvaluator(agent)
  }

  /** 当前工作区 key(= 会话 cwd 解析出的 project scope)。 */
  workspaceKeyFor(agent: unknown): ReturnType<LocalMemoryService['workspaceKeyFor']> {
    return this.impl.workspaceKeyFor(agent)
  }

  /** 面板:当前工作区绑定的作用域。 */
  workspaceBindings(agent: unknown): ReturnType<LocalMemoryService['workspaceBindings']> {
    return this.impl.workspaceBindings(agent)
  }

  /** 面板:默认范围的基础集合(会话 + 项目 + global),不含工作区绑定。 */
  defaultScopes(agent: unknown): ReturnType<LocalMemoryService['defaultScopes']> {
    return this.impl.defaultScopes(agent)
  }

  /** 面板:设置当前工作区绑定的作用域。 */
  setWorkspaceBindings(agent: unknown, scopes: readonly string[]): ReturnType<LocalMemoryService['setWorkspaceBindings']> {
    return this.impl.setWorkspaceBindings(agent, scopes)
  }

  /** 某个 scope 下允许的记忆类型(undefined = 不限制)。 */
  visibleKinds(agent: unknown, scope: string): ReturnType<LocalMemoryService['visibleKinds']> {
    return this.impl.visibleKinds(agent, scope)
  }

  /** 一条记录是否落在当前可见域内。 */
  isRecordVisible(agent: unknown, scope: string, kind: string): boolean {
    return this.impl.isRecordVisible(agent, scope, kind)
  }

  /** 面板:读取某会话自己的可见域(null = 未设置)。 */
  sessionVisibility(sessionId: string): ReturnType<LocalMemoryService['sessionVisibility']> {
    return this.impl.sessionVisibility(sessionId)
  }

  /** 面板:设置/清除某会话的可见域(null = 恢复默认)。 */
  setSessionVisibility(sessionId: string, config: Parameters<LocalMemoryService['setSessionVisibility']>[1]): ReturnType<LocalMemoryService['setSessionVisibility']> {
    return this.impl.setSessionVisibility(sessionId, config)
  }

  /** 注入半边:下一次 pre-step 要注入的可见域变更通知(取走即删)。 */
  takeVisibilityNotice(agent: unknown): ReturnType<LocalMemoryService['takeVisibilityNotice']> {
    return this.impl.takeVisibilityNotice(agent)
  }

  /** 面板「记忆权限」:某会话当前有效授权(含父会话继承)。 */
  sessionGrants(sessionId: string): ReturnType<LocalMemoryService['sessionGrants']> {
    return this.impl.sessionGrants(sessionId)
  }

  /** 注入半边:下一次 pre-step 要注入的权限变更通知(取走即删)。 */
  takePermissionNotice(agent: unknown): ReturnType<LocalMemoryService['takePermissionNotice']> {
    return this.impl.takePermissionNotice(agent)
  }

  /** 面板:每个 scope 下按类型统计条数。 */
  scopeKindStats(): ReturnType<LocalMemoryService['scopeKindStats']> {
    return this.impl.scopeKindStats()
  }

  /** 普通限制:范围外访问审批(挂起,等面板回答)。 */
  requestOutOfScope(agent: unknown, input: Parameters<LocalMemoryService['requestOutOfScope']>[1]): ReturnType<LocalMemoryService['requestOutOfScope']> {
    return this.impl.requestOutOfScope(agent, input)
  }

  /** Agent 主动申请范围外作用域的会话权限（0.24.0 / D3）。 */
  requestScopeGrants(agent: unknown, input: Parameters<LocalMemoryService['requestScopeGrants']>[1]): ReturnType<LocalMemoryService['requestScopeGrants']> {
    return this.impl.requestScopeGrants(agent, input)
  }

  /** 当前会话（含父链）的有效授权。 */
  grantList(agent: unknown): ReturnType<LocalMemoryService['grantList']> {
    return this.impl.grantList(agent)
  }

  /** 面板：撤销一条会话授权。 */
  revokeGrant(sessionId: string, id: string): boolean {
    return this.impl.revokeGrant(sessionId, id)
  }

  /** 最近的审批 / 授权生命周期事件（不含正文）。 */
  approvalAuditList(limit?: number): ReturnType<LocalMemoryService['approvalAuditList']> {
    return this.impl.approvalAuditList(limit)
  }

  /** 面板:当前待审批列表。 */
  pendingVisibilityApprovals(sessionId?: string): ReturnType<LocalMemoryService['pendingVisibilityApprovals']> {
    return this.impl.pendingVisibilityApprovals(sessionId)
  }

  /** 侧边栏阻塞提醒:待审批的轻量快照(不带条目正文)。 */
  pendingVisibilityApprovalPresence(sessionId?: string): ReturnType<LocalMemoryService['pendingVisibilityApprovalPresence']> {
    return this.impl.pendingVisibilityApprovalPresence(sessionId)
  }

  /** 面板:回答一条待审批(可带逐条勾选的 allowedIds)。 */
  answerVisibilityApproval(id: string, outcome: 'allowed-once' | 'rejected', allowedIds?: readonly string[]): boolean {
    return this.impl.answerVisibilityApproval(id, outcome, allowedIds)
  }

  /** 写路径默认 scope(省略 scope 时落到哪)。 */
  resolveWriteScope(agent: unknown, requested?: string): MemoryScope {
    return this.impl.resolveWriteScope(agent, requested)
  }

  /** 当前项目 key(会话 cwd 优先)。工具层解析 `scope:'project'` 时用它,口径与读写一致。 */
  projectKeyFor(agent: unknown): MemoryScope {
    return this.impl.projectKeyFor(agent)
  }

  /** 作用域清单(名字 + 条数),面板 /status 与 memory_list 共用。 */
  scopeStats(): ReturnType<LocalMemoryService['scopeStats']> {
    return this.impl.scopeStats()
  }

  /** 作用域清单的一行文字;SCOPE_LIMIT 错误提示里会带上它。 */
  scopeInventory(limit?: number): string {
    return this.impl.scopeInventory(limit)
  }

  /** 把磁盘上已有的 scope 全部发现并加载(读 "all" / 面板枚举前调用;带 3 秒缓存)。 */
  discoverScopes(): ReturnType<LocalMemoryService['discoverScopes']> {
    return this.impl.discoverScopes()
  }

  /** 当前进程已知的 scope 键(只读,不触发发现)。 */
  knownScopes(): ReturnType<LocalMemoryService['knownScopes']> {
    return this.impl.knownScopes()
  }
}

export function apply(ctx: Context, config: MemoryLocalConfig = {}) {
  class ScopedMemoryService extends CordisMemoryService {
    constructor(ctx2: Context) {
      super(ctx2, config)
      // 写路径默认口径来自 tools 小节(defaultScope 缺省 = 会话)。项目键**只在显式配置**
      // 时才固定下来;缺省由每次调用的 `session.header.cwd` 解析(那才是工作区)。
      // 以前这里写成 `?? project:${process.cwd()}`,而 DSH 服务进程的 cwd 是 profile 目录,
      // 等于把"当前项目"钉成了 profile —— 项目级记忆于是跨项目混在一起。
      const tools = (config as { tools?: { defaultScope?: 'session' | 'project' | 'global'; projectScope?: string } }).tools
      if (tools?.projectScope !== undefined) this.impl.setProjectScope(tools.projectScope as MemoryScope)
      if (tools?.defaultScope !== undefined) this.impl.setDefaultScope(tools.defaultScope)
    }
  }
  ctx.plugin(ScopedMemoryService)
}

/**
 * 宿主事件出口（0.31.0）：cordis Context 的 `emit` 存在时，把记忆事件名原样转发给宿主，
 * 其他插件 `ctx.on('memory/record-saved', …)` 即可订阅；老宿主 / 测试环境没有 `emit`
 * 时返回 undefined，事件总线退化为纯进程内广播（不报错）。
 */
function hostEventSink(ctx: Context): MemoryEventSink | undefined {
  const emit = (ctx as unknown as { emit?: unknown }).emit
  if (typeof emit !== 'function') return undefined
  return (name, payload) => {
    try {
      (emit as (this: Context, event: string, value: unknown) => void).call(ctx, name, payload)
    } catch {
      // 宿主没有声明该事件 / 宿主监听器抛错：丢掉这一条事件，不影响记忆主流程。
    }
  }
}

/**
 * 从宿主的 session 对象取出「需要建立作用域」的会话 id（0.30.0）。
 *
 * 只给顶层会话建：子 Agent 沿用父会话的记忆作用域（见 `resolveCurrentScopes`），
 * 单独建只会制造一批空的作用域。形状兼容 `session.id` 与 `session.header.id`。
 */
function liveSessionIdOf(session: unknown): string | undefined {
  const value = session as { id?: unknown; header?: { id?: unknown; origin?: unknown } } | undefined
  const raw = typeof value?.id === 'string' && value.id !== ''
    ? value.id
    : value?.header?.id
  if (typeof raw !== 'string' || raw === '') return undefined
  if (value?.header?.origin === 'subagent') return undefined
  return raw
}
