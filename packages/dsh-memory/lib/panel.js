/**
 * dsh-memory-panel — 服务端(entry)。
 *
 * 架构照抄 dsh-meme 的铁律(2026-10-10 crash 的教训):
 *   - 不导出 inject:一切服务 ctx.get() 被动获取,缺谁就降级跳过,
 *     绝不让 fiber 进入 FAILED(desktop fail-loud,一个 entry 失败=整个应用起不来);
 *   - 路由注册 try/catch:冲突则复用/记日志,不抛;
 *   - apply 整体兜底 catch:任何意外都不允许向外抛。
 *
 * 提供管理员 API(前缀路由 /memory/api):
 *   GET  /status    各 scope 记录数 + 待嵌入数 + 展示标签 + 用途描述(0.28.0)
 *   POST /scope-meta {scope, description?, name?}  编辑作用域用途 / 别名(0.29.0)
 *   GET  /records   ?scope=&q=  枚举/过滤记录
 *   GET  /search    ?scope=&q=&topK=  语义检索(向量 + 词法,provider 排序)
 *   POST /update    {id, content?, kind?, importance?, tags?, triggers?, expiresAt?/ttlMs?}
 *                   → 新建一条修正版(supersedes=id),旧记录保留(0.23.0)
 *   POST /delete    {id}
 * scope 惰性加载是同步的(store.peek(),**读路径不创建**),无需 ready 门。内容编辑会作废旧
 * 向量并加入 embedPending,由 provider 的回填队列重新嵌入。
 *
 * 安全(每个路由都过 refuseRequest,见下):
 *   注册在裸 webServer 上的路由**既不在宿主的 /api 围栏之后,也不在浏览器登录
 *   之后** —— 宿主的围栏是一个给别的路由主动调用的服务方法(connection.requestRejection),
 *   不是自动套上的中间件(dsh-market #603 的结论:裸 webServer 路由在登录开启时
 *   可被无 session 调用 = 任意代码执行)。这里的读接口能读出全部记忆,写接口能改写、
 *   删除、清空,还能拉起/卸载向量服务,所以必须自己问一次。
 */
// scope 规范化与 provider 共用同一份实现。路径按**源码树位置**写:构建脚本的改写表
// 会把它落成产物里的 `../provider/scope.js`(`lib/panel.js` → `lib/provider/scope.js`),
// 在源码树里同一路径直接命中 source/memory-local/src —— 测试与真实加载都能解析。
import { normalizeScopeInput, resolveCurrentScopes, scopeDisplayName, sessionShortId } from './provider/scope.js'


function writeJson(res, body, status = 200) {
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  } catch { /* 客户端已断开 */ }
}

/** provider 侧的"调用方输入有问题"错误码 → 400;其余未标注的仍算 500。 */
const CLIENT_ERROR_CODES = new Set([
  'SCOPE_INVALID', 'SCOPE_DISABLED', 'CONTENT_EMPTY', 'CONTENT_TOO_LONG',
  'SECRET_DETECTED', 'IMPORT_INVALID', 'IMPORT_TOO_LARGE', 'KIND_INVALID',
  'QUERY_EMPTY', 'QUERY_INVALID', 'SESSION_REQUIRED', 'SCOPE_EMPTY', 'SCOPE_NOT_VISIBLE',
  // 0.29.0：作用域用途 / 别名的编辑错误（名字非法 / 重名 / 不支持 / 用途过长）
  'SCOPE_NAME_INVALID', 'SCOPE_NAME_TAKEN', 'SCOPE_NAME_UNSUPPORTED', 'SCOPE_DESCRIPTION_TOO_LONG',
])

function writeError(res, error) {
  const code = typeof error?.code === 'string' ? error.code : 'internal'
  const status = Number(error?.status) || (CLIENT_ERROR_CODES.has(code) ? 400 : code === 'SCOPE_LIMIT' ? 409 : 500)
  writeJson(res, { ok: false, error: { code, message: error?.message || String(error) } }, status)
}

class ApiError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** 只认本机权威(loopback),没有宿主围栏时的兜底。 */
const LOOPBACK_AUTHORITY = /^(?:127(?:\.\d{1,3}){3}|\[::1\]|::1|localhost)(?::\d+)?$/i

/** 请求头里的 Host,小写归一;缺失返回空串。 */
function hostHeader(req) {
  const value = req?.headers?.host
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

/** 部署自己声明的权威(宿主 connection 的 trustedHosts);拿不到就空数组。 */
function trustedAuthorities(ctx) {
  try {
    const connection = ctx?.get?.('connection')
    return Array.isArray(connection?.trustedHosts)
      ? connection.trustedHosts.filter((entry) => typeof entry === 'string').map((entry) => entry.toLowerCase())
      : []
  } catch {
    return []
  }
}

/**
 * 该不该拒绝这个请求。
 *
 * 两层,顺序有讲究:
 *  1. 宿主发布了 connection.requestRejection 时**以它为准** —— 它同时含 Host/Origin
 *     围栏(防 DNS rebinding 与跨站调用)与浏览器登录(login-token cookie)。
 *     围栏自己抛错时返回 403:抛错意味着"什么都没放行",此处失败关闭,不能放行。
 *  2. 旧宿主没有这个服务时自己来:Host 必须是 loopback 或宿主声明的权威,
 *     sec-fetch-site 不得是 cross-site,带 Origin 就必须与 Host 相等。
 *     (注意 content-type: text/plain 也能携带合法 JSON 体且不触发预检,
 *      所以"要求 JSON 体"挡不住跨站 —— 承重的是 Host/Origin 这一层。)
 *
 * @returns 需要拒绝时返回状态码(401 未登录 / 403 不受信任),否则 undefined。
 */
export function refuseRequest(ctx, req) {
  let connection
  try { connection = ctx?.get?.('connection') } catch { connection = undefined }
  const gate = connection?.requestRejection
  if (typeof gate === 'function') {
    try {
      const status = gate.call(connection, req)
      return typeof status === 'number' ? status : undefined
    } catch {
      return 403
    }
  }
  const host = hostHeader(req)
  if (host === '') return 403
  if (!LOOPBACK_AUTHORITY.test(host) && !trustedAuthorities(ctx).includes(host)) return 403
  if (String(req?.headers?.['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return 403
  const origin = req?.headers?.origin
  if (origin !== undefined) {
    try {
      if (new URL(String(origin)).host.toLowerCase() !== host) return 403
    } catch {
      return 403
    }
  }
  return undefined
}

/** 拒绝时的响应体:给人话,不说内部概念。 */
function writeRefusal(res, status) {
  writeJson(res, {
    ok: false,
    error: {
      code: status === 401 ? 'LOGIN_REQUIRED' : 'UNTRUSTED_REQUEST',
      message: status === 401
        ? '需要先登录 DSH:请重新打开启动时打印的那个网址。'
        : '这个请求来自不受信任的来源,已拒绝。',
    },
  }, status)
}

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw.length > 0 ? JSON.parse(raw) : {}
}

/**
 * scope 键 → **不需要查宿主服务**的展示名(带类型前缀)。
 *   global        → `global:全局`
 *   project:<cwd> → `project:<cwd>`
 *   session:<id>  → `session:session-1a2b3c4d`(会话 id 前 16 位)
 *   自定义         → `custom:<名字>`(自定义 scope 的键本身没有前缀,靠类型补)
 *
 * 细节都有两处坑:①会话 id 以 `session-` 开头(正好 8 个字符),取 8 位会让所有会话
 * 作用域都显示成同一个名字,所以取 16 位;②自定义作用域与 global 的键天然不带前缀,
 * 必须按类型补 —— 规则集中在 provider 的 scopeDisplayName。
 */
function fallbackScopeLabel(scope) {
  return scopeDisplayName(scope)
}

/**
 * scope 键 → 展示名。在 fallback 之上多一步:会话 scope 尽力取会话标题
 * (宿主 `sessionTitle` 服务的 `get(session)` → `{ title }`,见 @deepseek-ai/dsh-session-title)。
 * 所有宿主服务访问都在 try/catch 里:面板绝不能因为拿不到标题而失败。
 *
 * 带标题时形如 `session:修层级(1a2b3c4d)` —— 类型前缀仍在最前面,名字部分换成标题。
 */
function scopeLabel(ctx, scope) {
  if (!scope.startsWith('session:')) return scopeDisplayName(scope)
  const id = scope.slice('session:'.length)
  const short = sessionShortId(id)
  try {
    const session = ctx?.get?.('sessions')?.get?.(id)
    if (session !== undefined) {
      const title = ctx.get('sessionTitle')?.get?.(session)?.title
      if (typeof title === 'string' && title.length > 0) return scopeDisplayName(scope, `${title}(${short})`)
    }
  } catch { /* 标题是尽力而为 */ }
  return scopeDisplayName(scope)
}

/** 会话 scope 查标题的上限:标题要读会话事件日志,scope 多了它就成了 /status 的大头。 */
const TITLE_LOOKUP_LIMIT = 50
/** discovery(读每个 scope 文件的第一条记录)结果的缓存时长。 */
const DISCOVER_CACHE_MS = 3000
/** 每个 memory 服务的发现缓存。面板看不到进程数,所以按服务实例各存一份。 */
const discoveryCache = new WeakMap()

/**
 * 发现磁盘上的 scope,3 秒内只做一次。
 * 面板每个请求都想要一份完整清单(别的进程写下的 scope 也要看得见),而 discovery 要
 * 读每个文件的第一条记录 —— 没有缓存的话刷新一下就是一次全目录扫描。
 */
function discoverScopes(memory, store) {
  const now = Date.now()
  const cached = discoveryCache.get(memory)
  if (cached !== undefined && now - cached.at < DISCOVER_CACHE_MS) return
  discoveryCache.set(memory, { at: now })
  try {
    if (typeof memory.discoverScopes === 'function') memory.discoverScopes()
    else store.loadDiscovered?.()
  } catch { /* discovery is best-effort */ }
}

function wireRecord(rec, scopeStore, supersededBy = null) {
  return {
    id: rec.id,
    scope: rec.scope,
    kind: rec.kind,
    content: rec.content,
    tags: rec.tags ?? [],
    importance: rec.importance,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    accessCount: rec.accessCount ?? 0,
    supersededBy,
    supersedes: rec.supersedes ?? null,
    triggers: rec.triggers ?? [],
    expiredAt: rec.expiredAt ?? null,
    expired: rec.expiredAt !== undefined && rec.expiredAt < Date.now(),
    embedded: !scopeStore.embedPending.has(rec.id) && scopeStore.vectors.has(rec.id),
  }
}

function collectScope(scopeStore) {
  // supersedes 是"新记录 → 旧记录"的指向;反查一次,给旧记录标上"已被修正"。
  const correctedBy = new Map()
  for (const rec of scopeStore.records.values()) {
    if (rec.supersedes) correctedBy.set(rec.supersedes, rec.id)
  }
  const out = []
  for (const rec of scopeStore.records.values()) out.push(wireRecord(rec, scopeStore, correctedBy.get(rec.id) ?? null))
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

/** 审计时间参数：Unix ms 或可解析的 ISO 字符串。 */
function parseAuditTime(value, name) {
  if (value === null || value === undefined || value === '') return undefined
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return numeric
  const parsed = Date.parse(value)
  if (Number.isFinite(parsed)) return parsed
  throw new ApiError(400, 'AUDIT_QUERY_INVALID', `${name} 必须是毫秒时间戳或 ISO 时间`)
}

/** 面板查询参数 → audit sink 的 AuditListQuery。 */
const AUDIT_CHANNELS = new Set(['digest', 'recall', 'rules', 'rules_delta', 'policy', 'nudge', 'signal', 'lifecycle'])
const AUDIT_OUTCOMES = new Set(['success', 'failed', 'skipped', 'partial', 'unknown'])
function parseAuditQuery(url) {
  const text = (name) => {
    const value = url.searchParams.get(name)
    const trimmed = value === null ? '' : value.trim()
    return trimmed === '' ? undefined : trimmed
  }
  const limitRaw = text('limit')
  let limit
  if (limitRaw !== undefined) {
    if (!/^\d+$/.test(limitRaw)) throw new ApiError(400, 'AUDIT_QUERY_INVALID', 'limit 必须是 1..200 的整数')
    limit = Number(limitRaw)
    if (limit < 1 || limit > 200) throw new ApiError(400, 'AUDIT_QUERY_INVALID', 'limit 必须在 1..200 之间')
  }
  const cursor = text('cursor')
  if (cursor !== undefined && !/^\d+$/.test(cursor)) {
    throw new ApiError(400, 'AUDIT_CURSOR_INVALID', 'cursor 必须是 seq 数字')
  }
  const channel = text('channel')
  if (channel !== undefined && !AUDIT_CHANNELS.has(channel)) {
    throw new ApiError(400, 'AUDIT_QUERY_INVALID', `未知 channel: ${channel}`)
  }
  const outcome = text('outcome')
  if (outcome !== undefined && !AUDIT_OUTCOMES.has(outcome)) {
    throw new ApiError(400, 'AUDIT_QUERY_INVALID', `未知 outcome: ${outcome}`)
  }
  const since = parseAuditTime(text('since'), 'since')
  const until = parseAuditTime(text('until'), 'until')
  if (since !== undefined && until !== undefined && since > until) {
    throw new ApiError(400, 'AUDIT_QUERY_INVALID', 'since 不能晚于 until')
  }
  return {
    ...(text('session') !== undefined ? { sessionId: text('session') } : {}),
    ...(text('trace') !== undefined ? { traceId: text('trace') } : {}),
    ...(text('operation') !== undefined ? { operationId: text('operation') } : {}),
    ...(text('memory') !== undefined ? { memoryId: text('memory') } : {}),
    ...(channel !== undefined ? { channel } : {}),
    ...(text('trigger') !== undefined ? { trigger: text('trigger') } : {}),
    ...(outcome !== undefined ? { outcome } : {}),
    ...(url.searchParams.get('problem') === '1' ? { problem: true } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  }
}

function publicAuditQuery(query) {
  return {
    ...(query.sessionId !== undefined ? { sessionId: query.sessionId } : {}),
    ...(query.traceId !== undefined ? { traceId: query.traceId } : {}),
    ...(query.operationId !== undefined ? { operationId: query.operationId } : {}),
    ...(query.memoryId !== undefined ? { memoryId: query.memoryId } : {}),
    ...(query.channel !== undefined ? { channel: query.channel } : {}),
    ...(query.trigger !== undefined ? { trigger: query.trigger } : {}),
    ...(query.outcome !== undefined ? { outcome: query.outcome } : {}),
    ...(query.problem === true ? { problem: true } : {}),
    ...(query.since !== undefined ? { since: query.since } : {}),
    ...(query.until !== undefined ? { until: query.until } : {}),
    limit: query.limit ?? 50,
    ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
    scope: query.sessionId !== undefined ? 'session' : 'all',
  }
}

function emptyAuditStats() {
  return {
    entries: 0, capacity: 0, perSessionCapacity: 0, dropped: 0,
    writeErrors: 0, persistence: 'memory',
  }
}

function auditStats(memory) {
  try {
    const stats = typeof memory?.injectAuditStats === 'function' ? memory.injectAuditStats() : undefined
    return stats && typeof stats === 'object' ? stats : emptyAuditStats()
  } catch {
    return { ...emptyAuditStats(), persistence: 'degraded' }
  }
}

/** 旧 provider 只有 injectAudit(list) 时，在面板侧补最小过滤/分页。 */
function legacyAuditPage(memory, query) {
  const all = (() => {
    try { return typeof memory?.injectAudit === 'function' ? memory.injectAudit(query.sessionId) : [] } catch { return [] }
  })()
  const entries = Array.isArray(all) ? all : []
  const filtered = entries.filter((entry) => {
    if (!entry || typeof entry !== 'object') return false
    if (query.channel !== undefined && entry.channel !== query.channel) return false
    if (query.trigger !== undefined && entry.trigger !== query.trigger) return false
    if (query.outcome !== undefined && entry.outcome !== query.outcome) return false
    if (query.problem === true) {
      const delivery = entry.delivery
      const omitted = Array.isArray(entry.omitted) ? entry.omitted.length : 0
      if (!(entry.outcome === 'failed' || entry.outcome === 'partial' || omitted > 0 || (delivery && delivery.status !== 'appended' && delivery.status !== 'unknown'))) return false
    }
    if (query.memoryId !== undefined) {
      const ids = [
        ...(entry.contentIds ?? []), ...(entry.hintIds ?? []),
        ...((entry.selected && entry.selected.contentIds) ?? []),
        ...((entry.omitted ?? []).map((item) => item.id)),
      ]
      if (!ids.includes(query.memoryId)) return false
    }
    if (query.since !== undefined && !(entry.at >= query.since)) return false
    if (query.until !== undefined && !(entry.at <= query.until)) return false
    return true
  })
  const limit = query.limit ?? 50
  const start = query.cursor === undefined ? 0 : Number(query.cursor)
  const page = filtered.slice(start, start + limit)
  return {
    entries: page,
    total: filtered.length,
    ...(start + limit < filtered.length ? { nextCursor: String(start + limit) } : {}),
    stats: emptyAuditStats(),
  }
}

/**
 * 把一个审计条目的 turn/step 锚点解析成轨迹可直接聚焦的 tool call id。
 *
 * Trajectory 的深链只接受 callId（它的 `toolCallFocus` 就是同一性映射），所以
 * 没有 operationId 的审计事件（摘要/规则等按步注入）需要回到会话事件里找该步
 * 的第一个 `tool/call`。找不到工具调用时不伪造：返回 null，由客户端退化成
 * “只切到轨迹页”。
 *
 * @param ctx - Host 插件上下文。
 * @param query - `{ sessionId, turn?, step?, callId? }`。
 * @returns 锚点结果（永不抛错）。
 */
export function findTrajectoryAnchor(ctx, query) {
  const sessionId = typeof query?.sessionId === 'string' ? query.sessionId.trim() : ''
  if (sessionId === '') return { callId: null, reason: 'session_required' }
  let session
  try { session = ctx?.get?.('sessions')?.get?.(sessionId) } catch { session = undefined }
  if (session === undefined || typeof session?.ownEvents !== 'function') {
    return { callId: null, reason: 'session_unavailable' }
  }
  const turn = typeof query.turn === 'number' ? query.turn : undefined
  const step = typeof query.step === 'number' ? query.step : undefined
  // 已有 callId 时校验它确实属于这个会话，避免把跨会话/伪造 id 送进轨迹。
  const wanted = typeof query.callId === 'string' && query.callId !== '' ? query.callId : undefined
  try {
    for (const event of session.ownEvents()) {
      if (event?.type !== 'tool/call') continue
      const data = event.data ?? {}
      if (turn !== undefined && data.turn !== turn) continue
      if (step !== undefined && data.step !== step) continue
      const callId = typeof data.callId === 'string' ? data.callId : undefined
      if (callId === undefined) continue
      if (wanted !== undefined && callId !== wanted) continue
      return {
        callId,
        tool: typeof data.name === 'string' ? data.name : undefined,
        turn: typeof data.turn === 'number' ? data.turn : undefined,
        step: typeof data.step === 'number' ? data.step : undefined,
        reason: wanted !== undefined ? 'operation' : 'step_tool',
      }
    }
  } catch { /* 事件窗口读取失败：按找不到处理 */ }
  return { callId: null, reason: wanted !== undefined ? 'operation_not_found' : 'no_tool_in_step' }
}

function auditPage(memory, query) {  if (memory === undefined || memory === null) {
    throw new ApiError(503, 'AUDIT_UNAVAILABLE', 'memory provider 未加载')
  }
  try {
    if (typeof memory.injectAuditPage === 'function') {
      const page = memory.injectAuditPage(query)
      if (page && typeof page === 'object' && Array.isArray(page.entries)) {
        return {
          entries: page.entries,
          total: typeof page.total === 'number' ? page.total : page.entries.length,
          ...(typeof page.nextCursor === 'string' ? { nextCursor: page.nextCursor } : {}),
          stats: page.stats && typeof page.stats === 'object' ? page.stats : emptyAuditStats(),
        }
      }
    }
    if (typeof memory.injectAudit === 'function') return legacyAuditPage(memory, query)
    throw new ApiError(503, 'AUDIT_UNAVAILABLE', 'provider 未提供注入审计接口（请升级 @restregular/dsh-memory）')
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (error && typeof error.code === 'string' && error.code.startsWith('AUDIT_')) {
      throw new ApiError(400, error.code, error.message || '审计查询参数无效')
    }
    throw error
  }
}

/** 导出：按当前筛选循环取页（上限 200/页，最多 50 页 = 10000 条）。 */
function collectAuditEntries(memory, query) {
  const out = []
  let cursor
  for (let i = 0; i < 50; i++) {
    const page = auditPage(memory, { ...query, ...(cursor !== undefined ? { cursor } : {}), limit: 200 })
    out.push(...page.entries)
    if (page.nextCursor === undefined) break
    cursor = page.nextCursor
  }
  return out
}

/** scope 选择 → 实际存在的 ScopeStore(读路径只用 peek,绝不通过 store.scope() 创建)。 */
function selectedStores(store, selection) {
  if (selection === null) return store.allScopes()
  return (Array.isArray(selection) ? selection : [selection])
    .map((s) => store.peek(s))
    .filter((s) => s !== undefined)
}

/**
 * 面板的 scope 参数 → 要看的 scope 集合。
 *   null      = 全部作用域
 *   string[]  = 规范化后的 scope 键(current-session / current-project 由 provider 解析)
 * 非法输入抛 400,合法但不存在的 scope 由 selectedStores 自然过滤成空集合。
 */
function resolveScopeSelection(memory, rawScope) {
  if (rawScope === null || rawScope === undefined || rawScope.trim() === '') return null
  const normalized = normalizeScopeInput(rawScope)
  if (!normalized.ok) throw new ApiError(400, normalized.code, normalized.message)
  if (normalized.kind === 'all') return null
  if (normalized.kind === 'current-session' || normalized.kind === 'current-project') {
    // 面板不在某个 agent 里:按 provider 的读取集合解析('project' → 当前项目键);
    // 解析不出会话时就退化为全部,而不是报错。
    const refs = typeof memory.resolveReadScopes === 'function' ? memory.resolveReadScopes(undefined) : []
    return refs.length > 0 ? refs : null
  }
  return normalized.scope ?? null
}

/** 面板已知的记忆类型(与工具的 kind enum 一致)。 */
/**
 * 会话「记忆可见域」的完整快照:自己的覆盖 + 生效策略 + 可选范围目录。
 *
 * 自己的覆盖(null = 没设置)用于面板上的"恢复默认";effective 用于预选(子 Agent
 * 会话会继承父会话的覆盖);defaults 是"没有显式覆盖时 Agent 实际会读的集合",
 * 首次打开面板时按它预选,而不是显示成什么都没选。
 *
 * 0.19.1 起不再支持按记忆类型收窄:目录只返回 scope,不再返回 kinds。
 */
function visibilityPayload(ctx, memory, sessionId) {
  let session
  try { session = ctx.get('sessions')?.get?.(sessionId) } catch { session = undefined }
  const agentLike = { session: session !== undefined ? session : { id: sessionId } }
  const own = typeof memory.sessionVisibility === 'function' ? memory.sessionVisibility(sessionId) : null
  let effective = null
  let inherited = false
  // 0.20.0 起 provider 永远给一份生效策略(没有显式覆盖时是默认策略)。
  // source 告诉面板这份策略是"自己的 / 继承的 / 默认的"。
  let source = own === null ? 'default' : 'explicit'
  try {
    if (typeof memory.visibilityPolicy === 'function') {
      const policy = memory.visibilityPolicy(agentLike)
      if (policy !== undefined && policy !== null) {
        effective = policy
        source = policy.source === 'explicit' || policy.source === 'inherited' || policy.source === 'default'
          ? policy.source
          : (own === null ? 'default' : 'explicit')
        inherited = source === 'inherited'
      }
    }
  } catch { /* 可见域是增强;拿不到就只返回自己的覆盖 */ }

  let refs
  try { if (session !== undefined) refs = resolveCurrentScopes({ session }) } catch { refs = undefined }
  // 没有显式覆盖时,面板仍预选"当前默认读取集合"(会话 + 项目 + global + 工作区绑定),
  // 让用户看到 Agent 现在实际能看到什么;保存后才变成显式覆盖。
  let defaults = []
  try {
    const resolved = memory.resolveReadScopes?.(agentLike)
    if (Array.isArray(resolved)) defaults = resolved
  } catch { /* 降级为空 */ }

  // 0.23.0:工作区级绑定 + 每个作用域的 read / write 状态。
  let workspace = null
  let bindings = []
  try {
    if (typeof memory.projectKeyFor === 'function') workspace = memory.projectKeyFor(agentLike)
    if (typeof memory.workspaceBindings === 'function') {
      const list = memory.workspaceBindings(agentLike)
      if (Array.isArray(list)) bindings = list
    }
  } catch { /* 绑定是增强;拿不到就按"没有绑定"处理 */ }
  const bound = new Set(bindings)
  const rules = new Map()
  for (const rule of (Array.isArray(effective?.scopes) ? effective.scopes : [])) {
    if (rule && typeof rule.scope === 'string' && !rules.has(rule.scope)) rules.set(rule.scope, rule)
  }

  const stats = typeof memory.scopeStats === 'function' ? memory.scopeStats() : []
  const byScope = new Map()
  for (const item of Array.isArray(stats) ? stats : []) {
    if (item && typeof item.scope === 'string') byScope.set(item.scope, { ...item })
  }
  // 即使还没有任何记录 / 宿主没给 sessions,也要能把默认集合里的 scope 勾出来。
  const ensure = (scope) => {
    if (typeof scope === 'string' && scope !== '' && !byScope.has(scope)) {
      byScope.set(scope, { scope, records: 0, pendingEmbeds: 0 })
    }
  }
  const sessionScope = refs?.session ?? defaults.find((scope) => scope.startsWith('session:'))
  const projectScope = refs?.project ?? defaults.find((scope) => scope.startsWith('project:'))
  // 默认范围的**基础集合** = 会话 + 项目 + global。它们天然包含在默认范围里,
  // 面板按「已绑定」展示且不可取消;工作区绑定只负责额外并入其它作用域。
  let defaultScopes = []
  try {
    const list = typeof memory.defaultScopes === 'function' ? memory.defaultScopes(agentLike) : undefined
    if (Array.isArray(list)) defaultScopes = list.filter((scope) => typeof scope === 'string' && scope !== '')
  } catch { /* 旧 provider:退回下面的本地面包 */ }
  if (defaultScopes.length === 0) {
    defaultScopes = [sessionScope, projectScope, 'global'].filter((scope) => typeof scope === 'string' && scope !== '')
  }
  const defaultBound = new Set(defaultScopes)
  ensure(sessionScope)
  ensure(projectScope)
  ensure('global')
  for (const scope of defaults) ensure(scope)
  for (const scope of bindings) ensure(scope)
  const rank = (scope) => scope === sessionScope ? 0 : scope === projectScope ? 1 : scope === 'global' ? 2 : 3
  const scopes = [...byScope.values()]
    .sort((a, b) => rank(a.scope) - rank(b.scope) || String(a.scope).localeCompare(String(b.scope)))
    .map((item) => {
      const rule = rules.get(item.scope)
      return {
        ...item,
        // 别名也带类型前缀:项目别名 → `project:<别名>`,自定义 → `custom:<别名>`。
        label: typeof item.name === 'string' && item.name !== ''
          ? scopeDisplayName(item.scope, item.name)
          : scopeLabel(ctx, item.scope),
        read: rule === undefined ? true : rule.read !== false,
        write: rule === undefined ? true : rule.write !== false,
        // bound = 显式绑定或默认范围自带;defaultBound 告诉客户端这一项不能取消。
        bound: bound.has(item.scope) || defaultBound.has(item.scope),
        defaultBound: defaultBound.has(item.scope),
        bindable: !String(item.scope).startsWith('session:') && !defaultBound.has(item.scope),
      }
    })
  return {
    sessionId,
    override: own,
    effective,
    inherited,
    source,
    defaults,
    defaultScopes,
    workspace,
    bindings: [...bound],
    scopes,
  }
}

/**
 * 校验并规范化「工作区绑定」提交（0.25.13）。
 *
 * `/visibility` 与 `/bindings` 共用同一套规则：只接受**具体作用域键**
 * （不接受 `all` / 当前项目 / 当前会话这类别名），会话作用域不能绑定到工作区
 * （它只属于某一次会话），重复项去重保序。
 *
 * @param rawBindings - 客户端提交的绑定数组（任意值都按非法处理）。
 * @returns 规范化后的作用域键数组。
 */
function normalizeBindings(rawBindings) {
  if (!Array.isArray(rawBindings)) throw new ApiError(400, 'SCOPE_INVALID', 'bindings 必须是字符串数组')
  const bindings = []
  for (const raw of rawBindings) {
    if (typeof raw !== 'string' || raw.trim() === '') throw new ApiError(400, 'SCOPE_INVALID', '绑定项必须是非空字符串')
    const normalized = normalizeScopeInput(raw)
    if (!normalized.ok) throw new ApiError(400, normalized.code, normalized.message)
    if (normalized.kind === 'all' || normalized.kind === 'current-project' || normalized.kind === 'current-session' || normalized.scope === undefined) {
      throw new ApiError(400, 'SCOPE_INVALID', `绑定必须是具体作用域键: ${JSON.stringify(raw)}`)
    }
    if (normalized.scope.startsWith('session:')) {
      throw new ApiError(400, 'SCOPE_INVALID', '会话作用域不能绑定到工作区')
    }
    if (!bindings.includes(normalized.scope)) bindings.push(normalized.scope)
  }
  return bindings
}

/**
 * 面板「记忆权限」的授权快照（0.25.0）。
 *
 * grants 由 Agent 通过 memory_scopes request 申请、用户批准产生；这里只暴露
 * scope / 权限 / 授予时间，不返回任何记忆正文。`inherited` 表示这条授权属于父会话。
 */
function grantsPayload(ctx, memory, sessionId) {
  const list = []
  let grants = []
  try {
    grants = typeof memory.sessionGrants === 'function' ? memory.sessionGrants(sessionId) : []
  } catch { grants = [] }
  for (const grant of Array.isArray(grants) ? grants : []) {
    if (!grant || typeof grant.scope !== 'string' || grant.scope === '') continue
    const permissions = Array.isArray(grant.permissions)
      ? grant.permissions.filter((permission) => permission === 'read' || permission === 'write')
      : []
    if (permissions.length === 0) continue
    const ownerSession = typeof grant.sessionId === 'string' && grant.sessionId !== '' ? grant.sessionId : sessionId
    list.push({
      id: typeof grant.id === 'string' ? grant.id : '',
      scope: grant.scope,
      label: scopeLabel(ctx, grant.scope),
      permissions,
      grantedAt: typeof grant.grantedAt === 'number' ? grant.grantedAt : 0,
      ownerSession,
      inherited: ownerSession !== sessionId,
    })
  }
  list.sort((a, b) => a.grantedAt - b.grantedAt || a.scope.localeCompare(b.scope))
  return { sessionId, grants: list }
}

async function handle(ctx, routePath, req, res) {
  const url = new URL(req.url ?? '/', 'http://dsh.local')
  const path = url.pathname.slice(routePath.length) || '/'
  const method = req.method ?? 'GET'
  // 围栏在最前面:任何路由(读也一样)都先过宿主,再谈记忆。
  const refused = refuseRequest(ctx, req)
  if (refused !== undefined) {
    writeRefusal(res, refused)
    return
  }
  try {
    const memory = ctx.get('memory')
    // 审计路由只依赖注入半边挂载的 sink，不依赖记忆 store；先于 store 检查。
    if (method === 'GET' && path === '/audit') {
      const query = parseAuditQuery(url)
      const value = auditPage(memory, query)
      writeJson(res, { ok: true, value: { ...value, query: publicAuditQuery(query) } })
      return
    }
    // 环境自检：只读探测（平台 / glibc / 后端 / 磁盘 / 权限），面板排障用。
    if (method === 'GET' && path === '/selfcheck') {
      const report = typeof memory?.selfCheck === 'function' ? await memory.selfCheck() : null
      writeJson(res, { ok: true, value: report })
      return
    }
    if (method === 'GET' && path === '/audit/stats') {
      writeJson(res, { ok: true, value: auditStats(memory) })
      return
    }
    if (method === 'GET' && path === '/anchor') {
      const numeric = (name) => {
        const raw = url.searchParams.get(name)
        if (raw === null || raw.trim() === '') return undefined
        if (!/^-?\d+$/.test(raw.trim())) throw new ApiError(400, 'ANCHOR_QUERY_INVALID', `${name} 必须是整数`)
        return Number(raw)
      }
      const query = {
        sessionId: url.searchParams.get('session') ?? '',
        turn: numeric('turn'),
        step: numeric('step'),
        callId: url.searchParams.get('callId') ?? undefined,
      }
      writeJson(res, { ok: true, value: findTrajectoryAnchor(ctx, query) })
      return
    }
    if (method === 'GET' && path === '/audit/export') {
      const query = parseAuditQuery(url)
      const format = url.searchParams.get('format') === 'jsonl' ? 'jsonl' : 'json'
      const entries = collectAuditEntries(memory, query)
      const body = format === 'jsonl'
        ? entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length > 0 ? '\n' : '')
        : JSON.stringify({
            schemaVersion: 2,
            exportedAt: Date.now(),
            query: publicAuditQuery(query),
            count: entries.length,
            entries,
          }, null, 2) + '\n'
      try {
        res.writeHead(200, {
          'content-type': format === 'jsonl' ? 'application/x-ndjson; charset=utf-8' : 'application/json; charset=utf-8',
          'content-disposition': `attachment; filename="dsh-memory-audit.${format === 'jsonl' ? 'jsonl' : 'json'}"`,
          'cache-control': 'no-store',
        })
        res.end(body)
      } catch { /* client disconnected */ }
      return
    }
    if (!memory?.store) throw new ApiError(503, 'MEMORY_UNAVAILABLE', 'memory provider 未加载')
    const store = memory.store
    // Scopes are created lazily, so a fresh process only knows the ones it has
    // touched. A management view must see everything written on disk (project
    // memories from earlier sessions included) — best-effort discovery, cached.
    discoverScopes(memory, store)

    // 会话级「记忆可见范围」:输入框旁的按钮读写这一对接口。
    if (method === 'GET' && path === '/visibility') {
      if (typeof memory.sessionVisibility !== 'function') {
        throw new ApiError(501, 'NOT_SUPPORTED', 'provider 未提供会话可见范围接口（请升级 @restregular/dsh-memory）')
      }
      const sessionId = (url.searchParams.get('session') ?? '').trim()
      if (sessionId === '') throw new ApiError(400, 'SESSION_REQUIRED', 'session 参数不能为空')
      writeJson(res, { ok: true, value: visibilityPayload(ctx, memory, sessionId) })
      return
    }
    if (method === 'POST' && path === '/visibility') {
      if (typeof memory.setSessionVisibility !== 'function') {
        throw new ApiError(501, 'NOT_SUPPORTED', 'provider 未提供会话可见范围接口（请升级 @restregular/dsh-memory）')
      }
      const body = await readJsonBody(req)
      const sessionId = typeof body?.session === 'string' ? body.session.trim() : ''
      if (sessionId === '') throw new ApiError(400, 'SESSION_REQUIRED', 'session 不能为空')
      let next = null
      const rawConfig = body?.visibility
      // 新协议:{ visibility: { scopes: [{ scope, read?, write? }], level } } | null
      // 兼容 0.19.0 的 { scopes: [{ scope, kinds? }] } 与 0.18 的 { scopes: string[] }:
      // 0.19.1 起不再限制记忆类型,提交里的 kinds 一律忽略。
      const rawScopes = rawConfig !== null && rawConfig !== undefined && typeof rawConfig === 'object'
        ? rawConfig.scopes
        : body?.scopes
      if (rawScopes !== null && rawScopes !== undefined) {
        if (!Array.isArray(rawScopes)) throw new ApiError(400, 'SCOPE_INVALID', 'scopes 必须是数组或 null')
        if (rawScopes.length === 0) throw new ApiError(400, 'SCOPE_EMPTY', '至少选择一个可见范围')
        const scopes = []
        for (const raw of rawScopes) {
          const scopeRaw = typeof raw === 'string' ? raw : raw?.scope
          if (typeof scopeRaw !== 'string' || scopeRaw.trim() === '') {
            throw new ApiError(400, 'SCOPE_INVALID', 'scope 必须是非空字符串')
          }
          const normalized = normalizeScopeInput(scopeRaw)
          if (!normalized.ok) throw new ApiError(400, normalized.code, normalized.message)
          if (normalized.kind === 'all' || normalized.kind === 'current-project' || normalized.kind === 'current-session') {
            throw new ApiError(400, 'SCOPE_INVALID', `可见范围必须是具体作用域键: ${JSON.stringify(scopeRaw)}`)
          }
          if (normalized.scope === undefined || scopes.some((item) => item.scope === normalized.scope)) continue
          // 0.23.0:read / write 状态。省略 = 可读可写;只有显式 false 才落盘。
          const read = typeof raw === 'object' && raw !== null && raw.read === false
          const write = typeof raw === 'object' && raw !== null && raw.write === false
          scopes.push({
            scope: normalized.scope,
            ...(read ? { read: false } : {}),
            ...(write ? { write: false } : {}),
          })
        }
        const levelRaw = rawConfig !== null && rawConfig !== undefined && typeof rawConfig === 'object' ? rawConfig.level : 'absolute'
        const level = levelRaw === 'normal' || levelRaw === 'none' ? levelRaw : 'absolute'
        next = { scopes, level }
      }
      // 工作区级绑定:省略 = 不改;数组 = 整体替换。与可见范围同一个保存动作提交。
      const rawBindings = body?.bindings
      if (rawBindings !== undefined) {
        if (typeof memory.setWorkspaceBindings !== 'function') {
          throw new ApiError(501, 'NOT_SUPPORTED', 'provider 未提供工作区绑定接口（请升级 @restregular/dsh-memory）')
        }
        const bindings = normalizeBindings(rawBindings)
        let session
        try { session = ctx.get('sessions')?.get?.(sessionId) } catch { session = undefined }
        memory.setWorkspaceBindings({ session: session !== undefined ? session : { id: sessionId } }, bindings)
      }
      memory.setSessionVisibility(sessionId, next)
      writeJson(res, { ok: true, value: visibilityPayload(ctx, memory, sessionId) })
      return
    }

    // 记忆权限浮窗的「绑定」按钮**单独保存**（0.25.13）:绑定是工作区级设置
    // (本工作区新会话的默认可见范围),和「勾选范围 / 可读可写」的草稿无关,
    // 所以点一下立即落盘,不需要用户再点「保存」;也不注入上下文提示。
    if (method === 'POST' && path === '/bindings') {
      if (typeof memory.setWorkspaceBindings !== 'function') {
        throw new ApiError(501, 'NOT_SUPPORTED', 'provider 未提供工作区绑定接口（请升级 @restregular/dsh-memory）')
      }
      const body = await readJsonBody(req)
      const sessionId = typeof body?.session === 'string' ? body.session.trim() : ''
      if (sessionId === '') throw new ApiError(400, 'SESSION_REQUIRED', 'session 不能为空')
      const bindings = normalizeBindings(body?.bindings)
      let session
      try { session = ctx.get('sessions')?.get?.(sessionId) } catch { session = undefined }
      const written = memory.setWorkspaceBindings({ session: session !== undefined ? session : { id: sessionId } }, bindings)
      writeJson(res, {
        ok: true,
        value: { sessionId, bindings: Array.isArray(written) ? written : bindings },
      })
      return
    }

    // 普通限制下的范围外访问审批:客户端浮层轮询待审批,用户点「拒绝 / 允许一次」后回写。
    // `summary=1` 是 0.25.14 新增的轻量口径:侧边栏阻塞提醒只需要 id + sessionId,
    // 不带条目正文,避免全局 1.5s 轮询把审批内容一遍遍传一遍。
    if (method === 'GET' && path === '/approvals') {
      if (typeof memory.pendingVisibilityApprovals !== 'function') {
        throw new ApiError(501, 'NOT_SUPPORTED', 'provider 未提供可见域审批接口（请升级 @restregular/dsh-memory）')
      }
      const sessionId = (url.searchParams.get('session') ?? '').trim()
      const summary = url.searchParams.get('summary') === '1'
      const approvals = summary && typeof memory.pendingVisibilityApprovalPresence === 'function'
        ? memory.pendingVisibilityApprovalPresence(sessionId === '' ? undefined : sessionId)
        : memory.pendingVisibilityApprovals(sessionId === '' ? undefined : sessionId)
      writeJson(res, { ok: true, value: { approvals } })
      return
    }
    if (method === 'POST' && path === '/approvals') {
      if (typeof memory.answerVisibilityApproval !== 'function') {
        throw new ApiError(501, 'NOT_SUPPORTED', 'provider 未提供可见域审批接口（请升级 @restregular/dsh-memory）')
      }
      const body = await readJsonBody(req)
      const id = typeof body?.id === 'string' ? body.id.trim() : ''
      if (id === '') throw new ApiError(400, 'APPROVAL_ID_REQUIRED', 'id 不能为空')
      const outcome = body?.outcome === 'allowed-once' ? 'allowed-once' : body?.outcome === 'rejected' ? 'rejected' : ''
      if (outcome === '') throw new ApiError(400, 'APPROVAL_OUTCOME_INVALID', 'outcome 必须是 allowed-once 或 rejected')
      // 0.21.0:逐条允许。省略 = 全部允许;空数组 = 一条都不允许(按拒绝处理)。
      const rawIds = body?.allowedIds
      if (rawIds !== undefined && rawIds !== null && !Array.isArray(rawIds)) {
        throw new ApiError(400, 'APPROVAL_IDS_INVALID', 'allowedIds 必须是字符串数组')
      }
      const allowedIds = Array.isArray(rawIds) ? rawIds.filter((value) => typeof value === 'string' && value !== '') : undefined
      const answered = allowedIds === undefined
        ? memory.answerVisibilityApproval(id, outcome)
        : memory.answerVisibilityApproval(id, outcome, allowedIds)
      writeJson(res, { ok: true, value: { answered } })
      return
    }

    // 面板「记忆权限」：Agent 申请到的会话授权 + 撤销（0.25.0）。
    if (method === 'GET' && path === '/grants') {
      if (typeof memory.sessionGrants !== 'function') {
        throw new ApiError(501, 'NOT_SUPPORTED', 'provider 未提供会话授权接口（请升级 @restregular/dsh-memory）')
      }
      const sessionId = (url.searchParams.get('session') ?? '').trim()
      if (sessionId === '') throw new ApiError(400, 'SESSION_REQUIRED', 'session 参数不能为空')
      writeJson(res, { ok: true, value: grantsPayload(ctx, memory, sessionId) })
      return
    }
    if (method === 'POST' && path === '/grants') {
      if (typeof memory.revokeGrant !== 'function') {
        throw new ApiError(501, 'NOT_SUPPORTED', 'provider 未提供授权撤销接口（请升级 @restregular/dsh-memory）')
      }
      const body = await readJsonBody(req)
      const sessionId = typeof body?.session === 'string' ? body.session.trim() : ''
      const id = typeof body?.id === 'string' ? body.id.trim() : ''
      if (sessionId === '') throw new ApiError(400, 'SESSION_REQUIRED', 'session 不能为空')
      if (id === '') throw new ApiError(400, 'GRANT_ID_REQUIRED', 'id 不能为空')
      const revoked = memory.revokeGrant(sessionId, id)
      if (!revoked) throw new ApiError(404, 'GRANT_NOT_FOUND', '没有找到这条授权（可能已撤销或已过期）')
      const view = typeof body?.view === 'string' && body.view.trim() !== '' ? body.view.trim() : sessionId
      writeJson(res, { ok: true, value: grantsPayload(ctx, memory, view) })
      return
    }

    if (method === 'GET' && path === '/status') {
      const stats = typeof memory.scopeStats === 'function'
        ? memory.scopeStats()
        : store.allScopes().map((s) => ({ scope: s.scope, records: s.records.size, pendingEmbeds: s.embedPending.size }))
      // 作用域用途(0.28.0)：面板「记录 → 作用域」子标签页要展示的「这个域是干什么的」。
      // 与 memory_scopes 目录 / memory_search 的范围外清单同源(scope-meta 手写优先，
      // 没写过按类型给默认描述)，所以三处看到的用途永远一致。
      const catalog = new Map()
      try {
        if (typeof memory.scopeCatalog === 'function') {
          for (const entry of memory.scopeCatalog(undefined) ?? []) {
            if (entry && typeof entry.scope === 'string') catalog.set(entry.scope, entry)
          }
        }
      } catch { /* 目录是增强：拿不到就只有名称与条数 */ }
      // 会话标题是尽力而为的增强,而且要读会话事件日志:只给最近活跃的前 N 个查,
      // 其余直接用「会话 <id 前 16 位>」。列表本身**始终**完整(不受这个上限影响)。
      // 手写用途与默认描述的区分(0.29.0)：面板要能编辑「用途」，就得知道现在显示的是
      // 自己写的那句，还是按类型补的默认描述 —— 编辑框只预填手写的，否则一保存就把
      // 默认文案固化成手写内容。`descriptionSource` 就是给这个用的。
      const customDescriptionOf = (scope) => {
        try {
          const meta = typeof memory.scopeMeta === 'function' ? memory.scopeMeta(scope) : undefined
          return typeof meta?.description === 'string' ? meta.description.trim() : ''
        } catch {
          return ''
        }
      }
      const scopes = stats.map((s, index) => {
        const entry = catalog.get(s.scope)
        const custom = customDescriptionOf(s.scope)
        return {
          ...s,
          // 别名(项目 / 自定义作用域)也要带类型前缀;没有别名时退回按类型算的展示名。
          label: typeof s.name === 'string' && s.name !== ''
            ? scopeDisplayName(s.scope, s.name)
            : (index < TITLE_LOOKUP_LIMIT ? scopeLabel(ctx, s.scope) : fallbackScopeLabel(s.scope)),
          ...(custom !== ''
            ? { description: custom, descriptionSource: 'custom' }
            : entry !== undefined && typeof entry.description === 'string' && entry.description.trim() !== ''
              ? { description: entry.description.trim(), descriptionSource: 'default' }
              : {}),
          ...(entry !== undefined && typeof entry.origin === 'string' ? { origin: entry.origin } : {}),
        }
      })
      // 删光记录不等于作用域消失：目录里有用途、却没有记录的作用域也列出来。
      // 只收**有元数据**的（updatedAt 来自 scope-meta）：默认三路里的 global / 当前项目
      // 也会出现在目录里，但它们未必真的落过盘，全塞进列表就是凭空多出两个作用域。
      // 别的会话的 session scope 不列 —— 它们的用途是空的，只会把清单变长。
      const seen = new Set(scopes.map((s) => s.scope))
      for (const [key, entry] of catalog) {
        if (seen.has(key) || key.startsWith('session:')) continue
        if (typeof entry.description !== 'string' || entry.description.trim() === '') continue
        if (!(typeof entry.updatedAt === 'number' && entry.updatedAt > 0)) continue
        scopes.push({
          scope: key,
          records: 0,
          pendingEmbeds: 0,
          updatedAt: entry.updatedAt,
          ...(typeof entry.name === 'string' && entry.name !== '' ? { name: entry.name } : {}),
          label: typeof entry.name === 'string' && entry.name !== ''
            ? scopeDisplayName(key, entry.name)
            : fallbackScopeLabel(key),
          description: entry.description.trim(),
          descriptionSource: customDescriptionOf(key) !== '' ? 'custom' : 'default',
          ...(typeof entry.origin === 'string' ? { origin: entry.origin } : {}),
          ...(entry.archived === true ? { archived: true } : {}),
        })
      }
      let embedServer = null
      // older providers have no lifecycle API — the panel simply omits the card
      try { embedServer = (await memory.embedServerStatus?.()) ?? null } catch { embedServer = null }
      let rules = null
      try { rules = typeof memory.ruleStats === 'function' ? memory.ruleStats() : null } catch { rules = null }
      writeJson(res, { ok: true, value: { scopes, embedServer, rules } })
      return
    }
    if (method === 'POST' && path === '/scope-meta') {
      // 用户编辑作用域的描述 / 别名(0.29.0)。面板是用户本人的操作,不带会话可见域;
      // 但只允许改**目录里看得见**的作用域,免得手滑把用途写到一条永远读不到的元数据上。
      if (typeof memory.describeScope !== 'function' && typeof memory.renameScope !== 'function') {
        throw new ApiError(501, 'NOT_SUPPORTED', 'provider 未提供作用域编辑接口（请升级 @restregular/dsh-memory）')
      }
      const body = await readJsonBody(req)
      const scope = typeof body?.scope === 'string' ? body.scope.trim() : ''
      if (scope === '') throw new ApiError(400, 'SCOPE_INVALID', 'scope 不能为空')
      const wantDescription = typeof body?.description === 'string'
      const wantName = typeof body?.name === 'string'
      if (!wantDescription && !wantName) {
        throw new ApiError(400, 'SCOPE_NOTHING_TO_UPDATE', '至少提供 description（用途）或 name（别名）之一')
      }
      if (typeof memory.scopeCatalog === 'function') {
        let known = false
        try {
          known = (memory.scopeCatalog(undefined) ?? []).some((item) => item?.scope === scope)
        } catch { known = true /* 目录不可用时不拦：让 provider 自己校验 */ }
        if (!known) throw new ApiError(404, 'SCOPE_UNKNOWN', `目录里没有作用域 ${scope}（可能刚被删除或改名）`)
      }
      let description
      if (wantDescription) {
        if (typeof memory.describeScope !== 'function') throw new ApiError(501, 'NOT_SUPPORTED', 'provider 未提供作用域用途编辑接口')
        description = memory.describeScope(scope, String(body.description), 'user').description
      }
      let name
      if (wantName) {
        if (typeof memory.renameScope !== 'function') throw new ApiError(501, 'NOT_SUPPORTED', 'provider 未提供作用域别名编辑接口')
        name = memory.renameScope(scope, String(body.name)).name ?? ''
      }
      writeJson(res, {
        ok: true,
        value: {
          scope,
          ...(wantDescription ? { description } : {}),
          ...(wantName ? { name } : {}),
        },
      })
      return
    }
    if (method === 'GET' && path === '/settings') {
      if (typeof memory.injectSettings !== 'function') throw new ApiError(501, 'NOT_SUPPORTED', 'provider 未提供注入设置接口（请升级 @restregular/dsh-memory）')
      writeJson(res, { ok: true, value: memory.injectSettings() })
      return
    }
    if (method === 'POST' && path === '/settings') {
      if (typeof memory.updateInjectSettings !== 'function') throw new ApiError(501, 'NOT_SUPPORTED', 'provider 未提供注入设置接口（请升级 @restregular/dsh-memory）')
      const body = await readJsonBody(req)
      writeJson(res, { ok: true, value: memory.updateInjectSettings(body) })
      return
    }
    if (method === 'POST' && path === '/create') {
      if (typeof memory.createRecord !== 'function') throw new ApiError(501, 'NOT_SUPPORTED', 'provider 未提供新建接口（请升级 @restregular/dsh-memory）')
      const body = await readJsonBody(req)
      const record = await memory.createRecord({
        ...(typeof body.scope === 'string' ? { scope: body.scope } : {}),
        ...(typeof body.kind === 'string' ? { kind: body.kind } : {}),
        ...(typeof body.content === 'string' ? { content: body.content } : {}),
        ...(Array.isArray(body.tags) ? { tags: body.tags.map(String) } : {}),
        ...(typeof body.importance === 'number' ? { importance: body.importance } : {}),
        ...(typeof body.ttlMs === 'number' ? { ttlMs: body.ttlMs } : {}),
        ...(typeof body.expiresAt === 'number' ? { expiresAt: body.expiresAt } : {}),
        ...(Array.isArray(body.triggers) ? { triggers: body.triggers.map(String) } : {}),
      })
      console.log(`[dsh-memory-panel] 新建 ${record.kind} @ ${record.scope}: ${record.id}`)
      writeJson(res, { ok: true, value: { record } })
      return
    }
    if (method === 'GET' && path === '/export') {
      if (typeof memory.exportAll !== 'function') throw new ApiError(501, 'NOT_SUPPORTED', 'provider 未提供导出接口（请升级 @restregular/dsh-memory）')
      writeJson(res, { ok: true, value: memory.exportAll() })
      return
    }
    if (method === 'POST' && path === '/import') {
      if (typeof memory.importRecords !== 'function') throw new ApiError(501, 'NOT_SUPPORTED', 'provider 未提供导入接口（请升级 @restregular/dsh-memory）')
      const body = await readJsonBody(req)
      const result = await memory.importRecords(body)
      console.log(`[dsh-memory-panel] 导入完成: 新增 ${result.imported} / 跳过 ${result.skipped} / 失败 ${result.rejected}`)
      writeJson(res, { ok: true, value: result })
      return
    }
    if (method === 'GET' && path === '/embed/status') {      if (typeof memory.embedServerStatus !== 'function') throw new ApiError(501, 'NOT_SUPPORTED', 'provider 未提供向量服务管理接口')
      writeJson(res, { ok: true, value: await memory.embedServerStatus() })
      return
    }
    if (method === 'POST' && path === '/embed/start') {
      if (typeof memory.startEmbedServerManually !== 'function') throw new ApiError(501, 'NOT_SUPPORTED', 'provider 未提供向量服务管理接口')
      const state = await memory.startEmbedServerManually()
      console.log(`[dsh-memory-panel] 手动启动向量服务 -> ${state}`)
      writeJson(res, { ok: true, value: { state, ...(await memory.embedServerStatus()) } })
      return
    }
    if (method === 'POST' && path === '/embed/stop') {
      if (typeof memory.stopEmbedServerManually !== 'function') throw new ApiError(501, 'NOT_SUPPORTED', 'provider 未提供向量服务管理接口')
      const out = memory.stopEmbedServerManually()
      console.log(`[dsh-memory-panel] 手动停止向量服务 -> ${out.reason}`)
      writeJson(res, { ok: true, value: { ...out, ...(await memory.embedServerStatus()) } })
      return
    }
    if (method === 'GET' && path === '/embed/model') {
      if (typeof memory.modelsReport !== 'function') throw new ApiError(501, 'NOT_SUPPORTED', 'provider 未提供模型清单接口（请升级 @restregular/dsh-memory）')
      writeJson(res, { ok: true, value: await memory.modelsReport(false) })
      return
    }
    if (method === 'POST' && path === '/embed/model/refresh') {
      if (typeof memory.modelsReport !== 'function') throw new ApiError(501, 'NOT_SUPPORTED', 'provider 未提供模型清单接口（请升级 @restregular/dsh-memory）')
      // 强制重探硬件:用户点了「重新检测」,缓存必须让路。
      writeJson(res, { ok: true, value: await memory.modelsReport(true) })
      return
    }
    if (method === 'POST' && path === '/embed/install') {
      if (typeof memory.installVectorBackend !== 'function') throw new ApiError(501, 'NOT_SUPPORTED', 'provider 未提供自动安装接口（请升级 @restregular/dsh-memory）')
      // 面板可以带选择:预设 / 档位 / 风味,或者一个完全自定义的 GGUF。
      const body = await readJsonBody(req)
      const override = {}
      if (typeof body.preset === 'string' && body.preset !== '') override.preset = body.preset
      if (typeof body.variant === 'string' && body.variant !== '') override.variant = body.variant
      if (typeof body.flavor === 'string' && body.flavor !== '') override.flavor = body.flavor
      if (body.custom !== undefined && typeof body.custom === 'object' && body.custom !== null) {
        const url = String(body.custom.url ?? '')
        const dims = Number(body.custom.dims)
        if (url === '' || !Number.isFinite(dims) || dims <= 0) throw new ApiError(400, 'CUSTOM_MODEL_INVALID', '自定义模型需要 url 与 dims')
        override.custom = {
          url,
          dims,
          ...(body.custom.file ? { file: String(body.custom.file) } : {}),
          ...(body.custom.pooling ? { pooling: String(body.custom.pooling) } : {}),
        }
      }
      memory.installVectorBackend(override)
      console.log(`[dsh-memory-panel] 开始下载向量服务 ${JSON.stringify(override)}`)
      writeJson(res, { ok: true, value: { ...(await memory.embedServerStatus()) } })
      return
    }
    if (method === 'POST' && path === '/embed/install/cancel') {
      if (typeof memory.cancelVectorInstall !== 'function') throw new ApiError(501, 'NOT_SUPPORTED', 'provider 未提供自动安装接口（请升级 @restregular/dsh-memory）')
      memory.cancelVectorInstall()
      console.log('[dsh-memory-panel] 取消下载本地向量服务')
      writeJson(res, { ok: true, value: { ...(await memory.embedServerStatus()) } })
      return
    }
    if (method === 'POST' && path === '/embed/uninstall') {
      if (typeof memory.uninstallVectorBackend !== 'function') throw new ApiError(501, 'NOT_SUPPORTED', 'provider 未提供卸载接口（请升级 @restregular/dsh-memory）')
      const out = memory.uninstallVectorBackend()
      console.log(`[dsh-memory-panel] 卸载向量服务 -> ${out.reason}，释放 ${(out.freedBytes / 1048576).toFixed(1)} MB`)
      writeJson(res, { ok: true, value: { ...out, ...(await memory.embedServerStatus()) } })
      return
    }
    if (method === 'POST' && path === '/embed/reindex') {
      if (typeof memory.reindexAll !== 'function') throw new ApiError(501, 'NOT_SUPPORTED', 'provider 未提供向量重建接口（请升级 @restregular/dsh-memory）')
      // 同步部分只作废旧向量 + 排队,真正的重嵌在后台跑,不阻塞请求;进度看 /status 的待嵌入计数。
      const result = memory.reindexAll() ?? {}
      const total = typeof result.total === 'number' ? result.total : 0
      console.log(`[dsh-memory-panel] 开始重建全部向量:${total} 条`)
      writeJson(res, { ok: true, value: { scheduled: true, records: total } })
      return
    }
    if (method === 'POST' && path === '/data/wipe') {
      if (typeof memory.wipeAllRecords !== 'function') throw new ApiError(501, 'NOT_SUPPORTED', 'provider 未提供数据清理接口（请升级 @restregular/dsh-memory）')
      const body = await readJsonBody(req)
      // Deleting everything is irreversible: require the caller to say so out
      // loud, not just to click a button.
      if (String(body.confirm ?? '') !== 'delete') throw new ApiError(400, 'CONFIRM_REQUIRED', '需要 confirm: "delete" 才执行删除')
      const out = memory.wipeAllRecords()
      console.log(`[dsh-memory-panel] 清空记忆数据 -> ${out.removed} 条 / ${out.scopes.length} 个作用域`)
      writeJson(res, { ok: true, value: { ...out, ...(await memory.embedServerStatus()) } })
      return
    }
    if (method === 'GET' && path === '/records') {
      const rawScope = url.searchParams.get('scope')
      const query = (url.searchParams.get('q') ?? '').trim().toLowerCase()
      const idQuery = (url.searchParams.get('id') ?? '').trim()
      // scope 先过同一套规范化:非法 → 400(而不是当成一个陌生 scope 去建文件);
      // 合法但不存在的 scope → 空列表。`peek`/`peekScope`,**绝不通过 store.scope() 创建**。
      const stores = selectedStores(store, resolveScopeSelection(memory, rawScope))
      let records = []
      for (const s of stores) records.push(...collectScope(s))
      if (query) {
        records = records.filter((r) =>
          r.content.toLowerCase().includes(query)
          || r.kind.toLowerCase().includes(query)
          || r.tags.some((t) => t.toLowerCase().includes(query)))
      }
      if (idQuery) {
        records = records.filter((r) => r.id === idQuery || r.id.startsWith(idQuery))
      }
      writeJson(res, { ok: true, value: { records } })
      return
    }
    // 记录页的「语义检索」:和 memory_search 同一套召回排序(向量 + 词法 + 可选重排),
    // 由 provider 的 searchForPanel 执行 —— 只读、不写访问计数,并报告向量通道是否
    // 真的参与,面板据此如实标注「语义排序」还是「退回关键词」。
    if (method === 'GET' && path === '/search') {
      const text = (url.searchParams.get('q') ?? '').trim()
      if (text === '') throw new ApiError(400, 'QUERY_EMPTY', '搜索内容不能为空')
      let topK = 20
      const rawTopK = (url.searchParams.get('topK') ?? '').trim()
      if (rawTopK !== '') {
        if (!/^\d+$/.test(rawTopK)) throw new ApiError(400, 'QUERY_INVALID', 'topK 必须是 1..50 的整数')
        topK = Number(rawTopK)
        if (topK < 1 || topK > 50) throw new ApiError(400, 'QUERY_INVALID', 'topK 必须在 1..50 之间')
      }
      const scopes = selectedStores(store, resolveScopeSelection(memory, url.searchParams.get('scope')))
      const keys = scopes.map((s) => s.scope)
      // 空集合不能交给旧 provider 的 search():它会退回"默认项目 + global",
      // 等于点了一个不存在的 scope 却搜出别的 scope 的记录。
      if (keys.length === 0) {
        writeJson(res, { ok: true, value: { hits: [], mode: 'lexical', reason: 'no-records', embedded: 0, total: 0 } })
        return
      }
      const totalRecords = scopes.reduce((n, s) => n + s.records.size, 0)
      const wireHit = (hit) => {
        const scopeStore = store.peek(hit.record.scope)
        let supersededBy = null
        if (scopeStore !== undefined) {
          for (const other of scopeStore.records.values()) {
            if (other.supersedes === hit.record.id) { supersededBy = other.id; break }
          }
        }
        const record = wireRecord(
          hit.record,
          scopeStore ?? { embedPending: new Map(), vectors: new Map() },
          supersededBy,
        )
        return typeof hit.score === 'number' ? { ...record, score: hit.score } : record
      }
      let result
      if (typeof memory.searchForPanel === 'function') {
        result = await memory.searchForPanel({ text, scopes: keys, topK })
      } else if (typeof memory.search === 'function') {
        // 旧 provider 没有面板专用入口:退回通用检索(会写访问计数),向量是否参与
        // 只能按"有没有向量"来推断。
        let embedded = 0
        for (const s of scopes) embedded += s.vectors.size
        const hits = await memory.search({ text, scopes: keys, topK })
        result = {
          hits,
          mode: embedded > 0 ? 'vector' : 'lexical',
          ...(embedded > 0 ? {} : { reason: 'no-vectors' }),
          embedded,
          total: totalRecords,
        }
      } else {
        // 连检索接口都没有:退回 /records?q= 同口径的关键词过滤,面板不至于空转。
        const lowercase = text.toLowerCase()
        const hits = []
        for (const s of scopes) {
          for (const r of collectScope(s)) {
            if (r.content.toLowerCase().includes(lowercase)
              || r.kind.toLowerCase().includes(lowercase)
              || r.tags.some((t) => t.toLowerCase().includes(lowercase))) hits.push({ record: r })
          }
        }
        result = { hits: hits.slice(0, topK), mode: 'lexical', reason: 'provider-lexical', embedded: 0, total: totalRecords }
      }
      writeJson(res, {
        ok: true,
        value: {
          hits: result.hits.slice(0, topK).map(wireHit),
          mode: result.mode,
          ...(result.reason !== undefined ? { reason: result.reason } : {}),
          embedded: result.embedded ?? 0,
          total: result.total ?? totalRecords,
        },
      })
      return
    }
    if (method === 'POST' && path === '/update') {
      const body = await readJsonBody(req)
      const id = String(body.id ?? '')
      // 0.23.0:编辑 = 新建一条修正版,旧记录不原地修改。旧 provider 没有
      // reviseRecord 时才退回原来的原地编辑,避免版本错配直接报错。
      if (typeof memory.reviseRecord === 'function') {
        const input = { id }
        if (body.content !== undefined) input.content = String(body.content)
        if (body.kind !== undefined) input.kind = String(body.kind)
        if (body.importance !== undefined) input.importance = Number(body.importance)
        if (body.tags !== undefined) input.tags = Array.isArray(body.tags) ? body.tags.map(String) : []
        if (body.triggers !== undefined) input.triggers = Array.isArray(body.triggers) ? body.triggers.map(String) : []
        if (body.expiredAt === null) input.expiresAt = null
        else if (typeof body.expiresAt === 'number') input.expiresAt = body.expiresAt
        else if (typeof body.ttlMs === 'number' && body.ttlMs > 0) input.ttlMs = body.ttlMs
        const { record, superseded } = await memory.reviseRecord(input)
        const scopeStore = store.peek(record.scope) ?? { embedPending: new Map(), vectors: new Map() }
        let supersededBy = null
        for (const other of scopeStore.records.values()) {
          if (other.supersedes === record.id) { supersededBy = other.id; break }
        }
        console.log(`[dsh-memory-panel] 修正记忆 ${superseded} -> ${record.id}`)
        writeJson(res, { ok: true, value: { record: wireRecord(record, scopeStore, supersededBy), superseded } })
        return
      }
      let target = null
      for (const s of store.allScopes()) {
        const rec = s.records.get(id)
        if (rec) { target = { s, rec }; break }
      }
      if (!target) throw new ApiError(404, 'RECORD_NOT_FOUND', `no record ${id}`)
      const { s, rec } = target
      let reindex = false
      if (body.content !== undefined) {
        const content = String(body.content)
        if (!content.trim()) throw new ApiError(400, 'CONTENT_EMPTY', 'content 不能为空')
        if (content !== rec.content) {
          rec.content = content
          // 旧向量作废:内存 + 磁盘一起丢掉(vectorsDirty),再排队重建。
          // 只删内存不标 dirty 的话,重启后 load 会看到旧向量、把它当成"已嵌入"。
          s.vectors.delete(id)
          s.vectorsDirty = true
          s.embedPending.add(id)
          reindex = true
        }
      }
      if (body.kind !== undefined) rec.kind = String(body.kind)
      if (body.importance !== undefined) rec.importance = Math.min(1, Math.max(0, Number(body.importance) || 0))
      if (body.tags !== undefined) rec.tags = Array.isArray(body.tags) ? body.tags.map(String) : []
      if (body.triggers !== undefined) rec.triggers = Array.isArray(body.triggers) ? body.triggers.map(String) : []
      if (body.supersededBy !== undefined) rec.supersedes = body.supersededBy === null ? undefined : String(body.supersededBy)
      // 过期时间:null 清除;expiresAt 绝对时间优先;ttlMs 相对当前时间。
      if (body.expiredAt === null) delete rec.expiredAt
      else if (typeof body.expiresAt === 'number') rec.expiredAt = body.expiresAt
      else if (typeof body.ttlMs === 'number' && body.ttlMs > 0) rec.expiredAt = Date.now() + body.ttlMs
      rec.updatedAt = Date.now()
      // 改动本身要进增量(flush 只落增量,不再整份快照覆盖);向量作废靠 vectorsDirty。
      s.insert(rec)
      store.scheduleFlush()
      // 立即重建向量(不等 60s 的定时回填);失败就留在 pending 里由重试兜底。
      if (reindex && typeof memory.reindexRecord === 'function') {
        void memory.reindexRecord(rec.scope, id).catch(() => {})
      }
      writeJson(res, { ok: true, value: { record: wireRecord(rec, s) } })
      return
    }
    if (method === 'POST' && path === '/delete') {
      const body = await readJsonBody(req)
      let removed = false
      for (const s of store.allScopes()) {
        if (s.records.has(String(body.id))) { removed = s.remove(String(body.id)); break }
      }
      if (!removed) throw new ApiError(404, 'RECORD_NOT_FOUND', `no record ${body.id}`)
      store.scheduleFlush()
      writeJson(res, { ok: true, value: { removed: 1 } })
      return
    }
    throw new ApiError(404, 'not_found', `unknown endpoint ${method} ${path}`)
  } catch (error) {
    ctx?.logger?.warn?.(error instanceof Error ? error : new Error(String(error)))
    writeError(res, error)
  }
}

export const name = 'dsh-memory-panel'
/** 路由处理器(导出供测试直接调用:围栏、规范化、peek 行为都在这里)。 */
export { handle as handleRequest }
export function apply(ctx, config = {}) {
  const routePath = String(config.route || '/memory/api').replace(/\/$/, '')
  try {
    // 动态注入(cordis ctx.inject):webServer 已就绪则立即回调,否则等它出现,
    // 不阻塞 entry 激活,也绝不让缺服务变成 fiber FAILED(dsh-client-modules 同款)。
    ctx.inject(['webServer'], (svcCtx) => {
      try {
        const webServer = svcCtx.get('webServer')
        if (!webServer || typeof webServer.register !== 'function') {
          console.log('[dsh-memory-panel] webServer 不可用,面板 API 不注册(记忆工具不受影响)')
          return
        }
        webServer.register({
          kind: 'prefix',
          path: routePath,
          // returning the promise is ignored by the http server but makes the
          // handler awaitable in tests/host-sim
          handler: (req, res) => Promise.resolve(handle(ctx, routePath, req, res))
            .catch((error) => writeError(res, error)),
        })
        console.log(`[dsh-memory-panel] 路由已注册 ${routePath}`)
      } catch (error) {
        console.log('[dsh-memory-panel] 路由注册失败(可能已存在,复用):', error?.message)
      }
    })
  } catch (error) {
    // 铁律:面板绝不允许把异常抛回 cordis(desktop fail-loud 会拖垮整个启动)
    console.error('[dsh-memory-panel] apply 意外失败(已吞掉,不影响启动):', error?.message)
  }
}


//# sourceURL=source/memory-panel/lib/index.js