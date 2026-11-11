/**
 * 面板「智能关系分析」API 路由测试(0.50.0)。
 *
 * 分析算法在 provider 里(独立模块),面板这层只负责三件事:
 *   1. 校验输入(缺参 / 非法枚举 → 400 ANALYSIS_INPUT_INVALID);
 *   2. 把参数**原样**(类型化后)转发给 provider 的 analysis* 方法;
 *   3. 统一响应 `{ ok: true, value }`;provider 没实现该方法 → 501 NOT_SUPPORTED。
 *
 * 所以这里用**纯 stub memory** 锁住这四类行为,不依赖 LocalMemoryService / 分析引擎
 * 是否已经合入 —— 面板路由必须能先独立验收,provider 就绪后换真实现即可。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleRequest } from '../lib/index.js'

const ROUTE = '/memory/api'
const LOOPBACK = { host: '127.0.0.1:19387' }

interface RecordedCall {
  method: string
  args: unknown[]
}

/**
 * provider 桩:每个 analysis* 方法记录「方法名 + 实参」并返回固定结构。
 * `overrides` 里给 `undefined` 可以模拟"该版本 provider 没实现这个方法"。
 */
function stubMemory(overrides: Record<string, unknown> = {}) {
  const calls: RecordedCall[] = []
  const track = (method: string, args: unknown[], value: unknown): unknown => {
    calls.push({ method, args })
    return value
  }
  const defaults: Record<string, (...args: any[]) => unknown> = {
    analysisOverview: (...args) => track('analysisOverview', args, { relations: 3, conflicts: 1 }),
    analysisLatestTask: (...args) => track('analysisLatestTask', args, { id: 'task-latest', status: 'done' }),
    analysisRun: (...args) => track('analysisRun', args, { taskId: 'task-1', status: 'queued' }),
    analysisPause: (...args) => track('analysisPause', args, { paused: true }),
    analysisRelations: (...args) => track('analysisRelations', args, [{ id: 'rel-1' }]),
    analysisRelationAction: (...args) => track('analysisRelationAction', args, {
      id: (args[0] as { id?: string })?.id,
      status: (args[0] as { action?: string })?.action,
    }),
    analysisCreateRelation: (...args) => track('analysisCreateRelation', args, {
      id: 'rel-new',
      ...(args[0] as object),
    }),
    analysisConflicts: (...args) => track('analysisConflicts', args, [{ id: 'cf-1' }]),
    analysisConflictAction: (...args) => track('analysisConflictAction', args, {
      id: (args[0] as { id?: string })?.id,
      status: (args[0] as { action?: string })?.action,
    }),
    analysisClusters: (...args) => track('analysisClusters', args, [{ id: 'cl-1' }]),
    analysisEvolution: (...args) => track('analysisEvolution', args, [{
      entity: (args[0] as { entity?: string })?.entity,
    }]),
    analysisPaths: (...args) => track('analysisPaths', args, [{ from: (args[0] as { from?: string })?.from }]),
    analysisGraph: (...args) => track('analysisGraph', args, { nodes: [], edges: [] }),
    analysisHistory: (...args) => track('analysisHistory', args, [{ id: 'task-1' }]),
  }
  return {
    memory: { ...defaults, store: {}, ...overrides },
    calls,
  }
}

function ctxWith(memory: unknown) {
  return { get: (name: string) => (name === 'memory' ? memory : undefined), logger: { warn() {} } }
}

function fakeRes() {
  const out: { status: number | null; body: any } = { status: null, body: null }
  return {
    out,
    writeHead(status: number) { out.status = status },
    end(text: string) {
      try { out.body = JSON.parse(text) } catch { out.body = text }
    },
  }
}

function getReq(url: string) {
  return { url, method: 'GET', headers: LOOPBACK }
}

function postReq(url: string, body: unknown) {
  return {
    url,
    method: 'POST',
    headers: LOOPBACK,
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) },
  }
}

async function invoke(memory: unknown, req: any) {
  const res = fakeRes()
  await handleRequest(ctxWith(memory), ROUTE, req, res)
  return res.out
}

/** 断言一次调用:方法名 + 唯一实参。 */
function assertCall(calls: RecordedCall[], method: string, arg: unknown) {
  assert.equal(calls.length, 1, `应只调用一次 provider(实际 ${JSON.stringify(calls.map((c) => c.method))})`)
  assert.equal(calls[0]!.method, method)
  assert.deepEqual(calls[0]!.args, [arg])
}

async function expectError(memory: unknown, req: any, status: number, code: string) {
  const out = await invoke(memory, req)
  assert.equal(out.status, status)
  assert.equal(out.body.ok, false)
  assert.equal(out.body.error.code, code)
  return out
}

// ---------------------------------------------------------------------------
// 1. 全部路由 200 + value 形状
// ---------------------------------------------------------------------------

const LIST_ROUTES = [
  { method: 'GET', path: '/analysis/overview', check: (value: any) => assert.deepEqual(value, { relations: 3, conflicts: 1 }) },
  { method: 'GET', path: '/analysis/tasks/latest', check: (value: any) => assert.deepEqual(value, { id: 'task-latest', status: 'done' }) },
  { method: 'POST', path: '/analysis/run', body: { mode: 'incremental' }, check: (value: any) => assert.deepEqual(value, { taskId: 'task-1', status: 'queued' }) },
  { method: 'POST', path: '/analysis/pause', check: (value: any) => assert.deepEqual(value, { paused: true }) },
  { method: 'GET', path: '/analysis/relations', check: (value: any) => assert.deepEqual(value, { relations: [{ id: 'rel-1' }] }) },
  { method: 'POST', path: '/analysis/relations/action', body: { id: 'rel-1', action: 'confirm' }, check: (value: any) => assert.deepEqual(value, { id: 'rel-1', status: 'confirm' }) },
  {
    method: 'POST',
    path: '/analysis/relations/create',
    body: { sourceEntityId: 'a', targetEntityId: 'b', relationshipType: 'semantic' },
    check: (value: any) => assert.deepEqual(value, { id: 'rel-new', sourceEntityId: 'a', targetEntityId: 'b', relationshipType: 'semantic' }),
  },
  { method: 'GET', path: '/analysis/conflicts', check: (value: any) => assert.deepEqual(value, { conflicts: [{ id: 'cf-1' }] }) },
  { method: 'POST', path: '/analysis/conflicts/action', body: { id: 'cf-1', action: 'confirmed' }, check: (value: any) => assert.deepEqual(value, { id: 'cf-1', status: 'confirmed' }) },
  { method: 'GET', path: '/analysis/clusters', check: (value: any) => assert.deepEqual(value, { clusters: [{ id: 'cl-1' }] }) },
  { method: 'GET', path: '/analysis/evolution?entity=port%3A8080', check: (value: any) => assert.deepEqual(value, { tracks: [{ entity: 'port:8080' }] }) },
  { method: 'GET', path: '/analysis/paths?from=port%3A8080&to=npm', check: (value: any) => assert.deepEqual(value, [{ from: 'port:8080' }]) },
  { method: 'GET', path: '/analysis/graph', check: (value: any) => assert.deepEqual(value, { nodes: [], edges: [] }) },
  { method: 'GET', path: '/analysis/history', check: (value: any) => assert.deepEqual(value, { tasks: [{ id: 'task-1' }] }) },
]

test('14 条分析路由全部 200,统一 {ok:true,value},value 原样转发', async () => {
  const { memory } = stubMemory()
  for (const route of LIST_ROUTES) {
    const req = route.method === 'GET' ? getReq(`${ROUTE}${route.path}`) : postReq(`${ROUTE}${route.path}`, route.body ?? {})
    const out = await invoke(memory, req)
    assert.equal(out.status, 200, `${route.method} ${route.path}`)
    assert.equal(out.body.ok, true, `${route.method} ${route.path}`)
    route.check(out.body.value)
  }
})

test('/analysis/tasks/latest:还没跑过分析时 value 是 null(不是空对象)', async () => {
  const { memory } = stubMemory({ analysisLatestTask: () => null })
  const out = await invoke(memory, getReq(`${ROUTE}/analysis/tasks/latest`))
  assert.equal(out.status, 200)
  assert.equal(out.body.ok, true)
  assert.equal(out.body.value, null)
})

test('响应里的 ok 只来自面板,provider 返回值不会被拆包/改名', async () => {
  const marker = { ok: false, weird: ['x'] } // provider 返回同名 ok=false 也原样放进 value
  const { memory } = stubMemory({ analysisOverview: () => marker })
  const out = await invoke(memory, getReq(`${ROUTE}/analysis/overview`))
  assert.equal(out.status, 200)
  assert.equal(out.body.ok, true, '外层 ok 永远是面板的')
  assert.deepEqual(out.body.value, marker)
})

// ---------------------------------------------------------------------------
// 2. 查询参数 / 请求体正确转发
// ---------------------------------------------------------------------------

test('relations / conflicts:status + limit 解析后转发;两者都缺省时传空对象', async () => {
  {
    const { memory, calls } = stubMemory()
    await invoke(memory, getReq(`${ROUTE}/analysis/relations?status=suggested&limit=42`))
    assertCall(calls, 'analysisRelations', { status: 'suggested', limit: 42 })
  }
  {
    const { memory, calls } = stubMemory()
    await invoke(memory, getReq(`${ROUTE}/analysis/relations`))
    assertCall(calls, 'analysisRelations', {})
  }
  {
    const { memory, calls } = stubMemory()
    await invoke(memory, getReq(`${ROUTE}/analysis/conflicts?status=pending_review&limit=7`))
    assertCall(calls, 'analysisConflicts', { status: 'pending_review', limit: 7 })
  }
  {
    // 空 status 等价于"全部",不能作为空字符串传给 provider
    const { memory, calls } = stubMemory()
    await invoke(memory, getReq(`${ROUTE}/analysis/conflicts?status=&limit=`))
    assertCall(calls, 'analysisConflicts', {})
  }
})

test('evolution / history:entity + limit 解析后转发', async () => {
  {
    const { memory, calls } = stubMemory()
    await invoke(memory, getReq(`${ROUTE}/analysis/evolution?entity=port%3A8080&limit=7`))
    assertCall(calls, 'analysisEvolution', { entity: 'port:8080', limit: 7 })
  }
  {
    // 面板「演化」视图默认传 limit、不传 entity = 看全部实体的轨迹
    const { memory, calls } = stubMemory()
    await invoke(memory, getReq(`${ROUTE}/analysis/evolution?limit=200`))
    assertCall(calls, 'analysisEvolution', { limit: 200 })
  }
  {
    // 空 entity 等价于"全部",不能把空串传给 provider
    const { memory, calls } = stubMemory()
    await invoke(memory, getReq(`${ROUTE}/analysis/evolution?entity=&limit=3`))
    assertCall(calls, 'analysisEvolution', { limit: 3 })
  }
  {
    const { memory, calls } = stubMemory()
    await invoke(memory, getReq(`${ROUTE}/analysis/history?limit=5`))
    assertCall(calls, 'analysisHistory', { limit: 5 })
  }
  {
    const { memory, calls } = stubMemory()
    await invoke(memory, getReq(`${ROUTE}/analysis/history`))
    assertCall(calls, 'analysisHistory', {})
  }
})

test('paths:from / to 必填,maxHops 只在给出时转发', async () => {
  {
    const { memory, calls } = stubMemory()
    await invoke(memory, getReq(`${ROUTE}/analysis/paths?from=port%3A8080&to=npm&maxHops=3`))
    assertCall(calls, 'analysisPaths', { from: 'port:8080', to: 'npm', maxHops: 3 })
  }
  {
    const { memory, calls } = stubMemory()
    await invoke(memory, getReq(`${ROUTE}/analysis/paths?from=a&to=b`))
    assertCall(calls, 'analysisPaths', { from: 'a', to: 'b' })
  }
})

test('run:mode/scopes/entityTypes/since/until 全量转发,时间统一成毫秒', async () => {
  const iso = '2026-11-11T00:00:00.000Z'
  const { memory, calls } = stubMemory()
  const out = await invoke(memory, postReq(`${ROUTE}/analysis/run`, {
    mode: 'full',
    scopes: ['global', 'project:/w'],
    entityTypes: ['port', 'tool'],
    since: 1_700_000_000_000,
    until: iso,
  }))
  assert.equal(out.status, 200)
  assertCall(calls, 'analysisRun', {
    mode: 'full',
    scopes: ['global', 'project:/w'],
    entityTypes: ['port', 'tool'],
    since: 1_700_000_000_000,
    until: Date.parse(iso),
  })
})

test('relations/action:可选字段只在出现时转发', async () => {
  {
    const { memory, calls } = stubMemory()
    await invoke(memory, postReq(`${ROUTE}/analysis/relations/action`, {
      id: 'rel-1',
      action: 'reopen',
      relationshipType: 'temporal',
      note: '  人工复核  ',
    }))
    assertCall(calls, 'analysisRelationAction', {
      id: 'rel-1',
      action: 'reopen',
      relationshipType: 'temporal',
      note: '人工复核',
    })
  }
  {
    const { memory, calls } = stubMemory()
    await invoke(memory, postReq(`${ROUTE}/analysis/relations/action`, { id: 'rel-1', action: 'reject' }))
    assertCall(calls, 'analysisRelationAction', { id: 'rel-1', action: 'reject' })
  }
})

test('relations/create:sourceMemoryIds 与 evidenceText 正确转发', async () => {
  const { memory, calls } = stubMemory()
  await invoke(memory, postReq(`${ROUTE}/analysis/relations/create`, {
    sourceEntityId: 'port:8080',
    targetEntityId: 'tool:npm',
    relationshipType: 'manual',
    evidenceText: '同一条记忆里同时出现',
    sourceMemoryIds: ['mem-1', 'mem-2'],
  }))
  assertCall(calls, 'analysisCreateRelation', {
    sourceEntityId: 'port:8080',
    targetEntityId: 'tool:npm',
    relationshipType: 'manual',
    evidenceText: '同一条记忆里同时出现',
    sourceMemoryIds: ['mem-1', 'mem-2'],
  })
})

test('conflicts/action:resolution 可以是对象,原样转发(不能当字符串丢掉)', async () => {
  const resolution = { action: 'merge', memoryId: 'mem-9', note: '取新弃旧' }
  const { memory, calls } = stubMemory()
  await invoke(memory, postReq(`${ROUTE}/analysis/conflicts/action`, { id: 'cf-1', action: 'resolved', resolution }))
  assertCall(calls, 'analysisConflictAction', { id: 'cf-1', action: 'resolved', resolution })
})

// ---------------------------------------------------------------------------
// 3. limit 夹取 1..500
// ---------------------------------------------------------------------------

test('limit 夹取到 1..500:0 → 1、9999 → 500', async () => {
  {
    const { memory, calls } = stubMemory()
    await invoke(memory, getReq(`${ROUTE}/analysis/history?limit=0`))
    assertCall(calls, 'analysisHistory', { limit: 1 })
  }
  {
    const { memory, calls } = stubMemory()
    await invoke(memory, getReq(`${ROUTE}/analysis/relations?limit=9999`))
    assertCall(calls, 'analysisRelations', { limit: 500 })
  }
})

test('limit 不是整数 → 400,且不会调用 provider', async () => {
  const { memory, calls } = stubMemory()
  await expectError(memory, getReq(`${ROUTE}/analysis/history?limit=abc`), 400, 'ANALYSIS_INPUT_INVALID')
  assert.deepEqual(calls, [])
})

// ---------------------------------------------------------------------------
// 4. 缺参 / 非法输入 → 400(且不调用 provider)
// ---------------------------------------------------------------------------

const INVALID_ROUTES = [
  { method: 'POST', path: '/analysis/run', body: {}, label: 'run 缺 mode' },
  { method: 'POST', path: '/analysis/run', body: { mode: 'partial' }, label: 'run 非法 mode' },
  { method: 'POST', path: '/analysis/run', body: { mode: 'full', scopes: 'global' }, label: 'scopes 不是数组' },
  { method: 'POST', path: '/analysis/run', body: { mode: 'full', entityTypes: [''] }, label: 'entityTypes 含空串' },
  { method: 'POST', path: '/analysis/run', body: { mode: 'full', since: '不是时间' }, label: 'since 非法' },
  { method: 'POST', path: '/analysis/relations/action', body: { action: 'confirm' }, label: 'action 缺 id' },
  { method: 'POST', path: '/analysis/relations/action', body: { id: 'rel-1' }, label: '缺 action' },
  { method: 'POST', path: '/analysis/relations/action', body: { id: 'rel-1', action: 'approve' }, label: '非法 action' },
  { method: 'POST', path: '/analysis/relations/create', body: { targetEntityId: 'b', relationshipType: 'manual' }, label: 'create 缺 sourceEntityId' },
  { method: 'POST', path: '/analysis/relations/create', body: { sourceEntityId: 'a', relationshipType: 'manual' }, label: 'create 缺 targetEntityId' },
  { method: 'POST', path: '/analysis/relations/create', body: { sourceEntityId: 'a', targetEntityId: 'b' }, label: 'create 缺 relationshipType' },
  { method: 'POST', path: '/analysis/relations/create', body: { sourceEntityId: 'a', targetEntityId: 'b', relationshipType: 'manual', sourceMemoryIds: 'mem-1' }, label: 'sourceMemoryIds 不是数组' },
  { method: 'POST', path: '/analysis/conflicts/action', body: { action: 'resolved' }, label: 'conflict action 缺 id' },
  { method: 'POST', path: '/analysis/conflicts/action', body: { id: 'cf-1' }, label: 'conflict 缺 action' },
  { method: 'POST', path: '/analysis/conflicts/action', body: { id: 'cf-1', action: 'pending_review' }, label: 'conflict 非法 action' },
  { method: 'GET', path: '/analysis/paths?to=b', label: 'paths 缺 from' },
  { method: 'GET', path: '/analysis/paths?from=a', label: 'paths 缺 to' },
  { method: 'GET', path: '/analysis/paths?from=a&to=b&maxHops=x', label: 'maxHops 非数字' },
  { method: 'GET', path: '/analysis/paths?from=a&to=b&maxHops=0', label: 'maxHops 小于 1' },
]

test('缺参 / 非法枚举 / 错误类型 → 400 ANALYSIS_INPUT_INVALID,且不调用 provider', async () => {
  for (const route of INVALID_ROUTES) {
    const { memory, calls } = stubMemory()
    const req = route.method === 'GET' ? getReq(`${ROUTE}${route.path}`) : postReq(`${ROUTE}${route.path}`, route.body)
    const out = await invoke(memory, req)
    assert.equal(out.status, 400, route.label)
    assert.equal(out.body.ok, false, route.label)
    assert.equal(out.body.error.code, 'ANALYSIS_INPUT_INVALID', route.label)
    assert.deepEqual(calls, [], `${route.label}:校验失败不应调用 provider`)
  }
})

// ---------------------------------------------------------------------------
// 5. provider 未实现 → 501 NOT_SUPPORTED
// ---------------------------------------------------------------------------

const NOT_SUPPORTED_ROUTES = [
  { method: 'GET', path: '/analysis/overview', provider: 'analysisOverview' },
  { method: 'GET', path: '/analysis/tasks/latest', provider: 'analysisLatestTask' },
  { method: 'POST', path: '/analysis/run', body: { mode: 'incremental' }, provider: 'analysisRun' },
  { method: 'POST', path: '/analysis/pause', provider: 'analysisPause' },
  { method: 'GET', path: '/analysis/relations', provider: 'analysisRelations' },
  { method: 'POST', path: '/analysis/relations/action', body: { id: 'rel-1', action: 'confirm' }, provider: 'analysisRelationAction' },
  { method: 'POST', path: '/analysis/relations/create', body: { sourceEntityId: 'a', targetEntityId: 'b', relationshipType: 'semantic' }, provider: 'analysisCreateRelation' },
  { method: 'GET', path: '/analysis/conflicts', provider: 'analysisConflicts' },
  { method: 'POST', path: '/analysis/conflicts/action', body: { id: 'cf-1', action: 'confirmed' }, provider: 'analysisConflictAction' },
  { method: 'GET', path: '/analysis/clusters', provider: 'analysisClusters' },
  { method: 'GET', path: '/analysis/evolution?entity=port%3A8080', provider: 'analysisEvolution' },
  { method: 'GET', path: '/analysis/paths?from=a&to=b', provider: 'analysisPaths' },
  { method: 'GET', path: '/analysis/graph', provider: 'analysisGraph' },
  { method: 'GET', path: '/analysis/history', provider: 'analysisHistory' },
]

test('14 条路由:provider 没有对应分析方法时 501 NOT_SUPPORTED(不是 500)', async () => {
  const overrides: Record<string, undefined> = {}
  for (const route of NOT_SUPPORTED_ROUTES) overrides[route.provider] = undefined
  const { memory } = stubMemory(overrides)
  for (const route of NOT_SUPPORTED_ROUTES) {
    const req = route.method === 'GET' ? getReq(`${ROUTE}${route.path}`) : postReq(`${ROUTE}${route.path}`, route.body ?? {})
    const out = await invoke(memory, req)
    assert.equal(out.status, 501, `${route.method} ${route.path}`)
    assert.equal(out.body.ok, false)
    assert.equal(out.body.error.code, 'NOT_SUPPORTED')
    assert.ok(out.body.error.message.includes(route.provider), '错误消息要点出缺的方法名')
  }
})

// ---------------------------------------------------------------------------
// 6. provider 方法以 memory 为 this 调用
// ---------------------------------------------------------------------------

test('provider 方法以 memory 实例为 this 调用', async () => {
  let seenThis: unknown
  const { memory } = stubMemory({
    analysisOverview() {
      seenThis = this
      return { relations: 0 }
    },
  })
  const out = await invoke(memory, getReq(`${ROUTE}/analysis/overview`))
  assert.equal(out.status, 200)
  assert.equal(seenThis, memory)
})

test('面板分析路由走真实 provider：run → overview → relations → confirm → graph', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { LocalMemoryService } = await import('../../memory-local/src/index.ts')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-panel-analysis-real-'))
  const SCOPE = 'project:/panel-analysis'
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true, project: true } })
  svc.setProjectScope(SCOPE)
  const ctx = { get: (name: string) => (name === 'memory' ? svc : undefined), logger: { warn() {} } }
  const res = () => {
    const out: { status: number | null; body: any } = { status: null, body: null }
    return { out, writeHead(status: number) { out.status = status }, end(text: string) { try { out.body = JSON.parse(text) } catch { out.body = text } } }
  }
  const post = (url: string, body: unknown) => ({ url, method: 'POST', headers: LOOPBACK, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } })
  const get = (url: string) => ({ url, method: 'GET', headers: LOOPBACK })
  try {
    const a = await svc.save({ scope: SCOPE, kind: 'fact', content: '项目使用 PostgreSQL 数据库' })
    const b = await svc.save({ scope: SCOPE, kind: 'fact', content: '项目已迁移到 Neo4j 数据库' })
    svc.store.peek(SCOPE)!.appendVector(a.id, Float32Array.from([1, 0, 0]))
    svc.store.peek(SCOPE)!.appendVector(b.id, Float32Array.from([0.9, 0.1, 0]))

    const run = res()
    await handleRequest(ctx, ROUTE, post(`${ROUTE}/analysis/run`, { mode: 'full' }), run)
    assert.equal(run.out.status, 200)
    assert.equal(typeof run.out.body.value.id, 'string')

    let overview: any = null
    for (let i = 0; i < 200; i++) {
      const got = res()
      await handleRequest(ctx, ROUTE, get(`${ROUTE}/analysis/overview`), got)
      overview = got.out.body.value
      if (overview.suggested > 0 || overview.conflictsPending > 0) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.ok(overview.suggested >= 1 || overview.conflictsPending >= 1, '真实分析应产出建议或冲突')

    const relations = res()
    await handleRequest(ctx, ROUTE, get(`${ROUTE}/analysis/relations?status=suggested&limit=50`), relations)
    assert.ok(Array.isArray(relations.out.body.value.relations))
    if (relations.out.body.value.relations.length > 0) {
      const id = relations.out.body.value.relations[0].id
      const act = res()
      await handleRequest(ctx, ROUTE, post(`${ROUTE}/analysis/relations/action`, { id, action: 'confirm' }), act)
      assert.equal(act.out.status, 200)
      assert.equal(act.out.body.value.status, 'confirmed')

      const graph = res()
      await handleRequest(ctx, ROUTE, get(`${ROUTE}/analysis/graph`), graph)
      assert.ok(graph.out.body.value.nodes.length >= 1)
      assert.ok(graph.out.body.value.edges.some((edge: { status: string }) => edge.status === 'confirmed'))
    }
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})
