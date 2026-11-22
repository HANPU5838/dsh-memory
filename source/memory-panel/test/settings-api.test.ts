import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleRequest } from '../lib/index.js'
import { LocalMemoryService } from '../../memory-local/src/index.ts'

const ROUTE = '/memory/api'
const LOOPBACK = { host: '127.0.0.1:19387' }

function ctxWith(service) {
  return { get: (name) => (name === 'memory' ? service : undefined), logger: { warn() {} } }
}

function fakeRes() {
  const out = { status: null, body: null }
  return {
    out,
    writeHead(status) { out.status = status },
    end(text) { try { out.body = JSON.parse(text) } catch { out.body = text } },
  }
}

const get = (url) => ({ url, method: 'GET', headers: LOOPBACK })
const post = (url, body) => ({
  url,
  method: 'POST',
  headers: LOOPBACK,
  async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) },
})

test('面板 /settings:GET 返回默认设置', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-settings-'))
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true, project: true } })
  try {
    const res = fakeRes()
    await handleRequest(ctxWith(svc), ROUTE, get(`${ROUTE}/settings`), res)
    assert.equal(res.out.status, 200)
    assert.equal(res.out.body.ok, true)
    assert.equal(res.out.body.value.recall.enabled, true)
    assert.equal(res.out.body.value.turnEnd.enabled, true)
    // 0.72.0：图增强设置默认跟随 provider 配置（默认开、权重 0.8）。
    assert.equal(res.out.body.value.graph.enabled, true)
    assert.equal(res.out.body.value.graph.weight, 0.8)
    svc.flushSync()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /settings:POST 合并补丁、夹紧越界值,并持久化', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-settings-'))
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true, project: true } })
  try {
    const res = fakeRes()
    await handleRequest(ctxWith(svc), ROUTE, post(`${ROUTE}/settings`, { digest: { enabled: false, topK: 3 }, rules: { maxItems: 999 } }), res)
    assert.equal(res.out.status, 200)
    assert.equal(res.out.body.value.digest.enabled, false)
    assert.equal(res.out.body.value.digest.topK, 3)
    assert.equal(res.out.body.value.rules.maxItems, 40)

    const again = fakeRes()
    await handleRequest(ctxWith(svc), ROUTE, get(`${ROUTE}/settings`), again)
    assert.equal(again.out.body.value.digest.enabled, false)
    svc.flushSync()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('面板 /create:新建规则;非法 scope 返回 400', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-create-'))
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true, project: true } })
  try {
    const ok = fakeRes()
    await handleRequest(ctxWith(svc), ROUTE, post(`${ROUTE}/create`, {
      scope: 'global', kind: 'rule', content: '发布前必须跑 npm test', importance: 0.9,
    }), ok)
    assert.equal(ok.out.status, 200)
    assert.equal(ok.out.body.value.record.kind, 'rule')
    assert.equal(svc.listSync({ scopes: ['global'], kind: 'rule' }).length, 1)

    const bad = fakeRes()
    await handleRequest(ctxWith(svc), ROUTE, post(`${ROUTE}/create`, { scope: 'project', content: 'x' }), bad)
    assert.equal(bad.out.status, 400)
    assert.equal(bad.out.body.error.code, 'SCOPE_INVALID')
    svc.flushSync()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /export + /import:文本往返,重复导入跳过', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-io-'))
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true, project: true } })
  try {
    await svc.save({ scope: 'global', kind: 'fact', content: '导出用的一条' })
    const exported = fakeRes()
    await handleRequest(ctxWith(svc), ROUTE, get(`${ROUTE}/export`), exported)
    assert.equal(exported.out.status, 200)
    assert.equal(exported.out.body.value.version, 2)
    assert.equal(exported.out.body.value.records.length, 1)
    assert.equal(exported.out.body.value.records[0].content, '导出用的一条')
    assert.equal('vector' in exported.out.body.value.records[0], false)

    const imported = fakeRes()
    await handleRequest(ctxWith(svc), ROUTE, post(`${ROUTE}/import`, exported.out.body.value), imported)
    assert.equal(imported.out.status, 200)
    assert.equal(imported.out.body.value.imported, 0)
    assert.equal(imported.out.body.value.skipped, 1)
    svc.flushSync()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /records:旧记录带上 supersededBy,新记录带 supersedes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-supersede-'))
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true, project: true } })
  try {
    const old = await svc.save({ scope: 'global', kind: 'fact', content: '端口是 3000' })
    const fixed = await svc.save({ scope: 'global', kind: 'fact', content: '端口改为 4000', supersedes: old.id })
    const res = fakeRes()
    await handleRequest(ctxWith(svc), ROUTE, get(`${ROUTE}/records?scope=global`), res)
    const records = res.out.body.value.records
    assert.equal(records.find((r) => r.id === fixed.id).supersedes, old.id)
    assert.equal(records.find((r) => r.id === old.id).supersededBy, fixed.id)
    svc.flushSync()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /update:编辑内容后作废旧向量并立即请求重建', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-update-'))
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true, project: true } })
  try {
    const rec = await svc.save({ scope: 'global', kind: 'fact', content: '旧内容' })
    const scopeStore = svc.store.peek('global')!
    scopeStore.vectors.set(rec.id, new Float32Array([1, 0, 0, 0]))
    const calls: Array<[string, string]> = []
    const memory = {
      store: svc.store,
      scopeStats: () => svc.scopeStats(),
      reindexRecord: (scope: string, id: string) => { calls.push([scope, id]); return Promise.resolve(true) },
    }
    const ctx = { get: (name: string) => (name === 'memory' ? memory : undefined), logger: { warn() {} } }
    const res = fakeRes()
    await handleRequest(ctx, ROUTE, post(`${ROUTE}/update`, { id: rec.id, content: '新内容' }), res)
    assert.equal(res.out.status, 200)
    assert.equal(scopeStore.vectors.has(rec.id), false, '旧向量从内存删掉')
    assert.equal(scopeStore.vectorsDirty, true, '旧向量要从磁盘作废')
    for (let i = 0; i < 4; i++) await Promise.resolve()
    assert.deepEqual(calls, [['global', rec.id]], '立即请求重建这一条')
    svc.flushSync()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /embed/reindex:后台触发重建并返回记录数', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-reindex-'))
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true, project: true } })
  try {
    let called = 0
    const memory = {
      store: svc.store,
      scopeStats: () => [{ scope: 'global', records: 7, pendingEmbeds: 0 }],
      reindexAll: () => { called += 1; return { total: 7, queued: 7 } },
    }
    const ctx = { get: (name: string) => (name === 'memory' ? memory : undefined), logger: { warn() {} } }
    const res = fakeRes()
    await handleRequest(ctx, ROUTE, post(`${ROUTE}/embed/reindex`, {}), res)
    assert.equal(res.out.status, 200)
    assert.equal(res.out.body.value.scheduled, true)
    assert.equal(res.out.body.value.records, 7)
    assert.equal(called, 1)
    svc.flushSync()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /audit:返回注入半边挂载的审计记录,可按 session 过滤', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-audit-'))
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true, project: true } })
  try {
    svc.attachInjectAudit({
      list(sessionId?: string) {
        const entries = [
          { at: 1, sessionId: 's1', trigger: 'turn_start' },
          { at: 2, sessionId: 's2', trigger: 'tool_failure' },
        ]
        return sessionId === undefined ? entries : entries.filter((entry) => entry.sessionId === sessionId)
      },
    })
    const all = fakeRes()
    await handleRequest(ctxWith(svc), ROUTE, get(`${ROUTE}/audit`), all)
    assert.equal(all.out.status, 200)
    assert.equal(all.out.body.value.entries.length, 2)

    const one = fakeRes()
    await handleRequest(ctxWith(svc), ROUTE, get(`${ROUTE}/audit?session=s2`), one)
    assert.equal(one.out.status, 200)
    assert.deepEqual(one.out.body.value.entries.map((entry) => entry.trigger), ['tool_failure'])
    svc.flushSync()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /audit v2:查询过滤、分页游标、stats 与 store 解耦', async () => {
  const seen: unknown[] = []
  const page = {
    entries: [{ schemaVersion: 2, id: 's1:2', seq: 2, at: 2, sessionId: 's1', kind: 'evaluation', channel: 'recall', stage: 'searched', outcome: 'success' }],
    total: 9,
    nextCursor: '2',
    stats: { entries: 9, capacity: 200, perSessionCapacity: 200, dropped: 1, writeErrors: 0, persistence: 'memory', lastRecordedAt: 2 },
  }
  const memory = {
    // 故意没有 store：审计路由不应被无关的 store 检查挡住。
    injectAuditPage(query: unknown) { seen.push(query); return page },
    injectAuditStats() { return page.stats },
  }
  const res = fakeRes()
  await handleRequest(ctxWith(memory), ROUTE, get(`${ROUTE}/audit?session=s1&limit=2&channel=recall&problem=1&since=1`), res)
  assert.equal(res.out.status, 200)
  assert.equal(res.out.body.value.total, 9)
  assert.equal(res.out.body.value.nextCursor, '2')
  assert.equal(res.out.body.value.stats.dropped, 1)
  assert.equal(res.out.body.value.query.sessionId, 's1')
  assert.equal(res.out.body.value.query.limit, 2)
  assert.equal(res.out.body.value.query.problem, true)
  assert.deepEqual(seen[0], { sessionId: 's1', channel: 'recall', problem: true, since: 1, limit: 2 })

  const stats = fakeRes()
  await handleRequest(ctxWith(memory), ROUTE, get(`${ROUTE}/audit/stats`), stats)
  assert.equal(stats.out.body.value.capacity, 200)

  const badLimit = fakeRes()
  await handleRequest(ctxWith(memory), ROUTE, get(`${ROUTE}/audit?limit=999`), badLimit)
  assert.equal(badLimit.out.status, 400)
  assert.equal(badLimit.out.body.error.code, 'AUDIT_QUERY_INVALID')

  const badCursor = fakeRes()
  await handleRequest(ctxWith(memory), ROUTE, get(`${ROUTE}/audit?cursor=x`), badCursor)
  assert.equal(badCursor.out.status, 400)
  assert.equal(badCursor.out.body.error.code, 'AUDIT_CURSOR_INVALID')

  const exported = fakeRes()
  await handleRequest(ctxWith(memory), ROUTE, get(`${ROUTE}/audit/export?session=s1&format=jsonl`), exported)
  assert.equal(exported.out.status, 200)
  assert.equal(typeof exported.out.body, 'string')
  assert.ok((exported.out.body as string).includes('"id":"s1:2"'))
})

test('0.72.0：/settings 支持图增强开关与权重，越界夹紧并持久化', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-graph-'))
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true, project: true } })
  try {
    const res = fakeRes()
    await handleRequest(ctxWith(svc), ROUTE, post(`${ROUTE}/settings`, { graph: { enabled: false, weight: 9 } }), res)
    assert.equal(res.out.status, 200)
    assert.equal(res.out.body.value.graph.enabled, false)
    assert.equal(res.out.body.value.graph.weight, 1.5, '权重夹紧到 1.5')

    const again = fakeRes()
    await handleRequest(ctxWith(svc), ROUTE, get(`${ROUTE}/settings`), again)
    assert.equal(again.out.body.value.graph.enabled, false, '设置已持久化')
    svc.flushSync()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
