/**
 * 面板 /memory/api 的归档与屏蔽接口（0.32.0）。
 *
 * 锁住三件事：
 *   1. `/archive` 只对项目作用域生效（global / 自定义 → SCOPE_NOT_ARCHIVABLE），
 *      解除归档立刻复原，且面板能列出「已归档的项目作用域」；
 *   2. `/blocks` 的解除按明确层级 + key 精确匹配，不需要 agent 反推；
 *   3. `/status` 把 archived / archivedKind / blocked / blockedLevel 透传给面板，
 *      面板才能默认折叠、计数、给「解除」按钮。
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

function ctxWith(service, extra = {}) {
  return {
    get: (name) => (name === 'memory' ? service : extra[name]),
    logger: { warn() {} },
    ...extra,
  }
}

function fakeRes() {
  const out = { status: null, headers: null, body: null }
  return {
    out,
    writeHead(status, headers) { out.status = status; out.headers = headers },
    end(text) { try { out.body = JSON.parse(text) } catch { out.body = text } },
  }
}

function get(url) {
  return { url, method: 'GET', headers: LOOPBACK }
}

function post(url, body) {
  return {
    url,
    method: 'POST',
    headers: LOOPBACK,
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) },
  }
}

function makeService(dir) {
  return new LocalMemoryService({ storeDir: dir, scopes: { global: true, project: true } })
}

/** 跑一次请求，返回解析后的 JSON 体。 */
async function call(svc, req) {
  const res = fakeRes()
  await handleRequest(ctxWith(svc), ROUTE, req, res)
  return { status: res.out.status, body: res.out.body }
}

test('面板 /archive：项目作用域归档 → 出现在清单里 → 解除后消失', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-archive-'))
  const svc = makeService(dir)
  try {
    svc.setProjectScope('project:D:/proj')
    const saved = await svc.save({ scope: 'project:D:/proj', kind: 'note', content: '项目里的一条记忆' })

    const archived = await call(svc, post(`${ROUTE}/archive`, { scope: 'project:D:/proj' }))
    assert.equal(archived.status, 200)
    assert.equal(archived.body.ok, true)

    const listed = await call(svc, get(`${ROUTE}/archive`))
    assert.equal(listed.status, 200)
    const rows = listed.body.value.project
    assert.equal(rows.length, 1)
    assert.match(rows[0].scope, /^project:/)
    assert.equal(rows[0].label.startsWith('project:'), true)
    assert.equal(typeof rows[0].archivedAt, 'number')

    // 归档后检索里立刻看不到（这不是权限，而是生命周期）。
    const hits = await svc.search({ text: '项目里的一条记忆', scopes: ['project:D:/proj'] })
    assert.deepEqual(hits, [])

    const restored = await call(svc, post(`${ROUTE}/archive`, { scope: 'project:D:/proj', restore: true }))
    assert.equal(restored.status, 200)
    assert.equal(restored.body.value.restored, true)

    const again = await call(svc, get(`${ROUTE}/archive`))
    assert.deepEqual(again.body.value.project, [])

    const back = await svc.getByIds([saved.id])
    assert.equal(back.length, 1, '解除归档后记忆原样回来')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /archive：global / 自定义作用域不可归档，如实报 SCOPE_NOT_ARCHIVABLE', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-archive-'))
  const svc = makeService(dir)
  try {
    for (const scope of ['global', 'handbook']) {
      const res = await call(svc, post(`${ROUTE}/archive`, { scope }))
      assert.equal(res.body.ok, false)
      assert.equal(res.body.error.code, 'SCOPE_NOT_ARCHIVABLE')
    }
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /archive：scope 为空 → 400', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-archive-'))
  const svc = makeService(dir)
  try {
    const res = await call(svc, post(`${ROUTE}/archive`, { scope: '   ' }))
    assert.equal(res.body.ok, false)
    assert.equal(res.body.error.code, 'SCOPE_INVALID')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /blocks：按作用域屏蔽后 /status 带 blocked，解除后复原', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-blocks-'))
  const svc = makeService(dir)
  try {
    svc.setProjectScope('project:D:/proj')
    const saved = await svc.save({ scope: 'project:D:/proj', kind: 'note', content: '会被屏蔽的一条' })

    const blocked = await call(svc, post(`${ROUTE}/blocks`, {
      level: 'workspace',
      workspace: 'project:D:/proj',
      scope: 'project:D:/proj',
    }))
    assert.equal(blocked.status, 200)
    assert.equal(blocked.body.value.outcome, 'blocked')

    const status = await call(svc, get(`${ROUTE}/status`))
    const row = status.body.value.scopes.find((s) => String(s.scope).startsWith('project:'))
    assert.equal(row.blocked, true)
    assert.equal(row.blockedLevel, 'workspace')

    // 工作区级屏蔽影响该工作区所有会话：换一个会话也看不到。
    const other = { session: { header: { id: 'other', cwd: 'D:/proj' } } }
    assert.equal(svc.isRecordBlocked(other, { id: saved.id, scope: saved.scope }), true)

    const listed = await call(svc, get(`${ROUTE}/blocks?workspace=project:D:/proj`))
    assert.equal(listed.body.value.workspace.length, 1)
    assert.equal(listed.body.value.workspace[0].scope, 'project:D:\\proj')

    const restored = await call(svc, post(`${ROUTE}/blocks`, {
      level: 'workspace',
      workspace: 'project:D:/proj',
      scope: 'project:D:/proj',
      restore: true,
    }))
    assert.equal(restored.body.value.removed.length, 1)
    assert.equal(svc.isRecordBlocked(other, { id: saved.id, scope: saved.scope }), false)

    const after = await call(svc, get(`${ROUTE}/status`))
    const row2 = after.body.value.scopes.find((s) => String(s.scope).startsWith('project:'))
    assert.notEqual(row2.blocked, true)
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /blocks：会话级解除按会话 id 精确匹配，不动工作区那一份', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-blocks-'))
  const svc = makeService(dir)
  try {
    svc.setProjectScope('project:D:/proj')
    await svc.save({ scope: 'project:D:/proj', kind: 'note', content: '一条记忆' })
    const agent = { session: { header: { id: 's1', cwd: 'D:/proj' } } }
    // 按作用域屏蔽一律要审批：这里直接给一个「已允许」的答复，模拟用户点过同意。
    svc.requestOutOfScope = async () => ({ outcome: 'allowed-once' })
    const blocked = await svc.requestBlock(agent, { scope: 'project:D:/proj', level: 'session', tool: 'test' })
    assert.equal(blocked.outcome, 'blocked')

    const session = await call(svc, get(`${ROUTE}/blocks?session=s1`))
    assert.equal(session.body.value.session.length, 1)

    // 工作区那一份本来就是空的：按 workspace 解除不该误删会话级。
    const wrong = await call(svc, post(`${ROUTE}/blocks`, {
      level: 'workspace',
      workspace: 'project:D:/proj',
      scope: 'project:D:/proj',
      restore: true,
    }))
    assert.equal(wrong.body.value.removed.length, 0)

    const right = await call(svc, post(`${ROUTE}/blocks`, {
      level: 'session',
      session: 's1',
      scope: 'project:D:/proj',
      restore: true,
    }))
    assert.equal(right.body.value.removed.length, 1)
    assert.equal(svc.isScopeBlocked(agent, 'project:D:/proj'), false)
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /blocks：缺 session / workspace → 400', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-blocks-'))
  const svc = makeService(dir)
  try {
    const res = await call(svc, post(`${ROUTE}/blocks`, { level: 'session', session: '' }))
    assert.equal(res.body.ok, false)
    assert.equal(res.body.error.code, 'SESSION_REQUIRED')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})
