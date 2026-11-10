/**
 * 0.33.0：面板删除 = 软删（与 memory_forget 同语义），并可恢复。
 * 原来面板 /delete 直接物理删除，删了就没法恢复 —— 这条链路必须锁住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleRequest } from '../lib/index.js'
import { LocalMemoryService } from '../../memory-local/src/index.ts'

const ROUTE = '/memory/api'
const LOOPBACK = { host: '127.0.0.1:19387' }
const SCOPE = 'project:/panel-cog'

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
function post(url, body) {
  return { url, method: 'POST', headers: LOOPBACK, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } }
}
function get(url) {
  return { url, method: 'GET', headers: LOOPBACK }
}

test('面板 /delete 是软删：记录变墓碑、/records 可见、/restore 能恢复', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-panel-cognitive-'))
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true, project: true } })
  svc.setProjectScope(SCOPE)
  try {
    const rec = await svc.save({ scope: SCOPE, kind: 'note', content: '面板软删测试' })
    svc.flushSync()

    const res1 = fakeRes()
    await handleRequest(ctxWith(svc), ROUTE, post(`${ROUTE}/delete`, { id: rec.id }), res1)
    assert.equal(res1.out.status, 200)
    assert.equal(res1.out.body.value.removed, 1)
    assert.equal(res1.out.body.value.restorable, true)

    // 物理上还在（墓碑），只是检索/注入不可见
    const raw = svc.store.peek(SCOPE).records.get(rec.id)
    assert.ok(raw, '软删后记录仍在库内')
    assert.ok((raw as { tombstonedAt?: number }).tombstonedAt !== undefined, '带墓碑时间戳')

    // /records 能看到它，并带 tombstoned 标记（面板据此渲染「恢复」）
    const res2 = fakeRes()
    await handleRequest(ctxWith(svc), ROUTE, get(`${ROUTE}/records?scope=${encodeURIComponent(SCOPE)}`), res2)
    const item = res2.out.body.value.records.find((r) => r.id === rec.id)
    assert.ok(item, '面板列表应能看到墓碑记录')
    assert.equal(item.tombstoned, true)

    // /restore 恢复
    const res3 = fakeRes()
    await handleRequest(ctxWith(svc), ROUTE, post(`${ROUTE}/restore`, { id: rec.id }), res3)
    assert.equal(res3.out.status, 200)
    assert.equal(res3.out.body.value.restored, true)
    const restored = svc.store.peek(SCOPE).records.get(rec.id) as { tombstonedAt?: number }
    assert.equal(restored.tombstonedAt, undefined, '恢复后墓碑标记清除')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /consolidate 走服务层巩固接口（无向量时安全返回 0）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-panel-consist-'))
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true, project: true } })
  try {
    await svc.save({ scope: 'global', kind: 'note', content: '巩固接口测试' })
    const res = fakeRes()
    await handleRequest(ctxWith(svc), ROUTE, post(`${ROUTE}/consolidate`, {}), res)
    assert.equal(res.out.status, 200)
    assert.ok(Array.isArray(res.out.body.value.created))
    assert.equal(typeof res.out.body.value.merged, 'number')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板备份接口：创建 / 列出 / 恢复最近备份', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-panel-backup-'))
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true, project: true } })
  const ctx = ctxWith(svc)
  try {
    await svc.save({ scope: 'global', kind: 'note', content: '面板备份测试' })
    const created = fakeRes()
    await handleRequest(ctx, ROUTE, post(`${ROUTE}/backups`, {}), created)
    assert.equal(created.out.status, 200)
    assert.ok(created.out.body.value.name)

    const listed = fakeRes()
    await handleRequest(ctx, ROUTE, get(`${ROUTE}/backups`), listed)
    assert.equal(listed.out.status, 200)
    assert.equal(listed.out.body.value.backups.length, 1)

    const restored = fakeRes()
    await handleRequest(ctx, ROUTE, post(`${ROUTE}/backups/restore`, {}), restored)
    assert.equal(restored.out.status, 200)
    assert.ok(typeof restored.out.body.value.restoredFrom === 'string')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板健康度/冲突/隔离接口可用', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-panel-health-'))
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true, project: true } })
  const ctx = ctxWith(svc)
  try {
    await svc.save({ scope: 'global', kind: 'note', content: '健康度接口测试' })
    const health = fakeRes()
    await handleRequest(ctx, ROUTE, get(`${ROUTE}/health`), health)
    assert.equal(health.out.status, 200)
    assert.equal(typeof health.out.body.value.score, 'number')
    assert.ok(Array.isArray(health.out.body.value.explain))

    const conflicts = fakeRes()
    await handleRequest(ctx, ROUTE, get(`${ROUTE}/conflicts`), conflicts)
    assert.equal(conflicts.out.status, 200)
    assert.ok(Array.isArray(conflicts.out.body.value.conflicts))

    const release = fakeRes()
    await handleRequest(ctx, ROUTE, post(`${ROUTE}/quarantine/release`, { id: 'nope' }), release)
    assert.equal(release.out.status, 200)
    assert.equal(release.out.body.value.released, false)
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})
