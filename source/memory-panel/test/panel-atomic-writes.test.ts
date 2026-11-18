/**
 * 0.109.0：面板多字段写入的原子性 —— 一个保存动作里两处写入必须一起成功或回滚，
 * 不能出现「返回失败但一半已经生效」（审计 P2）。
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
const ctxWith = (service) => ({ get: (name) => (name === 'memory' ? service : undefined), logger: { warn() {} } })
const fakeRes = () => {
  const out = { status: null, headers: null, body: null }
  return { out, writeHead(status, headers) { out.status = status; out.headers = headers }, end(text) { try { out.body = JSON.parse(text) } catch { out.body = text } } }
}
const post = (url, body) => ({ url, method: 'POST', headers: LOOPBACK, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } })
const get = (url) => ({ url, method: 'GET', headers: LOOPBACK })

test('0.109.0：/scope-meta 别名冲突时用途不被改写（回滚/先校验）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-panel-atomic-meta-'))
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true, custom: true }, retrieval: { vector: { enabled: false } } })
  try {
    await svc.save({ scope: 'handbook', kind: 'fact', content: '手册内容足够长', scopeDescription: '旧用途' })
    await svc.save({ scope: 'handbook2', kind: 'fact', content: '另一个内容足够长', scopeDescription: '另一个域' })
    svc.renameScope('handbook2', 'taken')
    const res = fakeRes()
    await handleRequest(ctxWith(svc), ROUTE, post(`${ROUTE}/scope-meta`, { scope: 'handbook', name: 'taken', description: '新用途' }), res)
    assert.ok(res.out.status >= 400, `别名冲突应失败，实际 ${res.out.status}`)
    const entry = (svc.scopeCatalog(undefined) ?? []).find((item) => item.scope === 'handbook')
    assert.equal(entry?.description, '旧用途', '失败后用途必须保持原值')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.109.0：/scope-meta 成功时用途与别名都生效', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-panel-atomic-meta-ok-'))
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true, custom: true }, retrieval: { vector: { enabled: false } } })
  try {
    await svc.save({ scope: 'handbook3', kind: 'fact', content: '内容足够长的记录', scopeDescription: '旧用途' })
    const res = fakeRes()
    await handleRequest(ctxWith(svc), ROUTE, post(`${ROUTE}/scope-meta`, { scope: 'handbook3', name: '手册', description: '新用途' }), res)
    assert.equal(res.out.status, 200, JSON.stringify(res.out.body))
    const entry = (svc.scopeCatalog(undefined) ?? []).find((item) => item.scope === 'handbook3')
    assert.equal(entry?.description, '新用途')
    assert.equal(entry?.name, '手册')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.109.0：/visibility 绑定失败时可见范围回滚', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-panel-atomic-vis-'))
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true, project: true }, retrieval: { vector: { enabled: false } } })
  try {
    svc.setWorkspaceBindings = () => { throw new Error('SCOPE_INVALID: 绑定失败（模拟）') }
    const res = fakeRes()
    await handleRequest(ctxWith(svc), ROUTE, post(`${ROUTE}/visibility`, {
      session: 's1',
      visibility: { scopes: [{ scope: 'global' }], level: 'absolute' },
      bindings: ['handbook'],
    }), res)
    assert.ok(res.out.status >= 400, `绑定失败应整体失败，实际 ${res.out.status}`)
    assert.equal(svc.sessionVisibility('s1'), null, '可见范围必须回滚到写入前（无覆盖）')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.109.0：/hooks API 覆盖审批、撤销、试跑与删除', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-panel-hooks-api-'))
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true }, retrieval: { vector: { enabled: false } } })
  try {
    const hook = svc.saveHook({ phase: 'before-save', name: '长度校验', code: 'function verify(input){ return { ok: input.memory.content.length > 3 } }' })

    const listRes = fakeRes()
    await handleRequest(ctxWith(svc), ROUTE, get(`${ROUTE}/hooks`), listRes)
    assert.equal(listRes.out.status, 200)
    assert.equal(listRes.out.body.value.hooks[0].pendingApproval, true, '新钩子应 pendingApproval')

    const approveRes = fakeRes()
    await handleRequest(ctxWith(svc), ROUTE, post(`${ROUTE}/hooks`, { action: 'approve', id: hook.id }), approveRes)
    assert.equal(approveRes.out.body.value.approved, true)

    const runRes = fakeRes()
    await handleRequest(ctxWith(svc), ROUTE, post(`${ROUTE}/hooks`, { action: 'run', id: hook.id, content: '一段样例正文' }), runRes)
    assert.equal(runRes.out.status, 200)
    assert.ok(Array.isArray(runRes.out.body.value.outcomes))

    const revokeRes = fakeRes()
    await handleRequest(ctxWith(svc), ROUTE, post(`${ROUTE}/hooks`, { action: 'revoke-approval', id: hook.id }), revokeRes)
    assert.equal(revokeRes.out.body.value.revoked, true)

    const deleteRes = fakeRes()
    await handleRequest(ctxWith(svc), ROUTE, post(`${ROUTE}/hooks`, { action: 'delete', id: hook.id }), deleteRes)
    assert.equal(deleteRes.out.body.value.removed, 1)
    assert.equal(svc.listHooks().length, 0)
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})
