import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService } from '../src/index.ts'
import { memoryTools } from '../../tool-memory/src/index.ts'
import type { MemoryScope } from 'dsh-memory'

const DIR = mkdtempSync(join(tmpdir(), 'dsh-memory-test-'))
const PROJECT: MemoryScope = 'project:test-workspace'

/** LocalMemoryService defaults to embedding at 127.0.0.1:8078 (llama-server);
 * in CI/offline runs the circuit breaker degrades gracefully. */
let svc: LocalMemoryService

beforeEach(() => {
  // 0.5.0:provider 自己的默认写口径是 'session'(拿不到会话时回退项目 scope)。测试里
  // 没有 agent 上下文,所以显式把"当前项目"设成固定的 PROJECT —— 这样读写两边看到的是
  // 同一个 scope,与旧用例的语义一致(旧的 setDefaultScope(PROJECT) 只影响写路径)。
  svc = new LocalMemoryService({ storeDir: DIR, scopes: { global: true, project: true } })
  svc.setDefaultScope('project')
  svc.setProjectScope(PROJECT)
})

after(() => {
  svc.flushSync()
  rmSync(DIR, { recursive: true, force: true })
})

test('save + list roundtrip, project and global separated', async () => {
  const saved = await svc.save({ scope: PROJECT, kind: 'preference', content: '用户偏好 TypeScript' })
  const g = await svc.save({ scope: 'global', kind: 'preference', content: '回答尽量简短' })
  assert.ok(saved.id && g.id)
  const proj = await svc.list({ scope: PROJECT })
  const glob = await svc.list({ scope: 'global' })
  assert.equal(proj.length, 1)
  assert.equal(glob.length, 1)
  assert.equal(proj[0]!.content, '用户偏好 TypeScript')
})

test('dedupe: same normalized content refreshes instead of duplicating', async () => {
  await svc.save({ scope: PROJECT, kind: 'note', content: 'Deploy  before migrate' })
  const again = await svc.save({ scope: PROJECT, kind: 'note', content: 'deploy before MIGRATE' })
  assert.equal(again.content, 'Deploy  before migrate')
  assert.equal((await svc.list({ scope: PROJECT })).length, 1)
})

test('scope gate rejects disabled scopes with coded error', async () => {
  const gated = new LocalMemoryService({ storeDir: DIR, scopes: { global: false, project: true } })
  await assert.rejects(
    () => gated.save({ scope: 'global', kind: 'note', content: 'x' }),
    (err: Error & { code?: string }) => err.code === 'SCOPE_DISABLED',
  )
})

test('content validation', async () => {
  await assert.rejects(() => svc.save({ scope: PROJECT, kind: 'note', content: '   ' }), /CONTENT_EMPTY/)
  await assert.rejects(() => svc.save({ scope: PROJECT, kind: 'note', content: 'x'.repeat(5000) }), /CONTENT_TOO_LONG/)
})

test('supersedes: default search excludes retired records, includeSuperseded brings history back', async () => {
  const r1 = await svc.save({ scope: PROJECT, kind: 'fact', content: 'API 端口是 3000' })
  await assert.rejects(
    () => svc.save({ scope: PROJECT, kind: 'fact', content: 'API 端口是 4000', supersedes: 'no-such-id' }),
    (err: Error & { code?: string }) => err.code === 'SUPERSEDES_UNKNOWN',
  )
  const r2 = await svc.save({ scope: PROJECT, kind: 'fact', content: 'API 端口改为 4000', supersedes: r1.id })
  assert.equal(r2.supersedes, r1.id)
  const current = await svc.search({ text: 'API 端口', scope: PROJECT })
  assert.deepEqual(current.map((h) => h.record.id), [r2.id], '默认不返回退役版本')
  const history = await svc.search({ text: 'API 端口', scope: PROJECT, includeSuperseded: true } as never)
  assert.ok(history.some((h) => h.record.id === r1.id), '显式 includeSuperseded 仍可取历史')
  assert.ok(history.some((h) => h.record.id === r2.id))
})

test('supersedes 跨作用域：目标旧记录在别的 scope 也能修正，且旧记录全局退役', async () => {
  const oldInA = await svc.save({ scope: PROJECT, kind: 'fact', content: 'project 旧结论：端口 3000' })
  // 新记录落 global，supersedes 指向 project 里的旧记录（跨作用域）
  const fixed = await svc.save({ scope: 'global', kind: 'fact', content: 'global 修正：端口 4000', supersedes: oldInA.id })
  assert.equal(fixed.scope, 'global')
  assert.equal(fixed.supersedes, oldInA.id)
  // 旧记录按 id 全局退役：project 搜索默认不再返回它，includeSuperseded 能取回
  const current = await svc.search({ text: '端口 3000', scope: PROJECT })
  assert.equal(current.some((h) => h.record.id === oldInA.id), false, '跨作用域修正后旧记录默认退役')
  const history = await svc.search({ text: '端口 3000', scope: PROJECT, includeSuperseded: true } as never)
  assert.ok(history.some((h) => h.record.id === oldInA.id), 'includeSuperseded 能取回历史')
  // 未知目标仍要报错，且文案是 any scope
  await assert.rejects(
    () => svc.save({ scope: PROJECT, kind: 'fact', content: '指向不存在', supersedes: 'no-such-id' }),
    (err: Error & { code?: string }) => err.code === 'SUPERSEDES_UNKNOWN' && /any scope/.test(err.message),
  )
})

test('state: default TTL, expired hidden from search/list, getByIds still returns it', async () => {  const state = await svc.save({
    scope: PROJECT, kind: 'state', content: '当前部署在测试环境，验证后需要回滚',
    ttlMs: 30,
  } as never)
  assert.ok(state.expiredAt && state.expiredAt > Date.now() - 1000)
  assert.equal((await svc.list({ scope: PROJECT })).some((r) => r.id === state.id), true, '未过期时可见')
  await new Promise((resolve) => setTimeout(resolve, 45))
  assert.equal((await svc.list({ scope: PROJECT })).some((r) => r.id === state.id), false, '过期后默认 list 隐藏')
  assert.equal((await svc.search({ text: '部署 测试环境 回滚', scope: PROJECT })).some((h) => h.record.id === state.id), false)
  assert.ok(svc.getByIds([state.id]).some((r) => r.id === state.id), 'memory_get 仍可取过期正文')
})

test('forget by id and by query', async () => {
  const a = await svc.save({ scope: PROJECT, kind: 'note', content: '临时凭据存放在 vault' })
  const b = await svc.save({ scope: PROJECT, kind: 'note', content: '临时凭据的轮换周期是 90 天' })
  const byId = await svc.forget({ id: a.id })
  assert.deepEqual(byId.ids, [a.id])
  const byQuery = await svc.forget({ query: '临时凭据', scope: PROJECT })
  assert.deepEqual([...byQuery.ids].sort(), [b.id])
  await assert.rejects(() => svc.forget({ query: '临时凭据', scope: PROJECT }), /RECORD_NOT_FOUND/)
  await assert.rejects(() => svc.forget({}), /forget requires/)
})

test('search respects topK and scope pinning', async () => {
  for (let i = 0; i < 8; i++) {
    await svc.save({ scope: PROJECT, kind: 'note', content: `第 ${i} 条关于 postgres 索引优化的记录 ${'x'.repeat(i)}` })
  }
  const hits = await svc.search({ text: 'postgres 索引优化', scope: PROJECT, topK: 3 })
  assert.ok(hits.length <= 3)
  const none = await svc.search({ text: 'postgres 索引优化', scope: 'global' })
  assert.equal(none.length, 0)
})

test('search includes tags: 标签可作为检索词命中正文里没有该词的记忆', async () => {
  const saved = await svc.save({ scope: PROJECT, kind: 'procedure', content: '部署前先检查凭据和回退方案', tags: ['release', 'credentials'] })
  const hits = await svc.search({ text: 'release', scope: PROJECT, topK: 5 })
  assert.ok(hits.some((hit) => hit.record.id === saved.id), 'tag release 应命中')
  const none = await svc.search({ text: 'not-a-real-tag-xyz', scope: PROJECT, topK: 5 })
  assert.equal(none.length, 0)
})

test('persistence: records survive reopen from disk', async () => {
  const r = await svc.save({ scope: PROJECT, kind: 'decision', content: '选择 JSONL 而非 sqlite 作为 M1 存储' })
  svc.flushSync()
  const reopened = new LocalMemoryService({ storeDir: DIR, scopes: { global: true, project: true } })
  reopened.setDefaultScope('project')
  reopened.setProjectScope(PROJECT)
  const records = await reopened.list({ scope: PROJECT })
  assert.ok(records.some((x) => x.id === r.id))
  reopened.flushSync()
})

test('store writes valid JSONL atomically (no .tmp leftovers)', async () => {
  await svc.save({ scope: PROJECT, kind: 'note', content: '检查无 tmp 残留' })
  svc.flushSync()
  const files = readdirSync(DIR)
  assert.ok(!files.some((f) => f.endsWith('.tmp')), `no tmp files expected, got ${files}`)
  assert.ok(existsSync(join(DIR, 'projects')))
  const projFile = readdirSync(join(DIR, 'projects')).find((f) => f.endsWith('.jsonl'))
  assert.ok(projFile, 'project jsonl exists')
  const text = readFileSync(join(DIR, 'projects', projFile!), 'utf8')
  for (const line of text.split('\n').filter((l) => l.trim())) JSON.parse(line) // every line valid JSON
})

// ---- tool layer contract tests (mock-backed, no I/O) ----

function toolOptsWith(mock: Record<string, Function>) {
  return {
    getService: () => mock as never,
    defaultScope: 'project' as const,
    projectScope: PROJECT,
  }
}

test('tools: save validates and forwards scope resolution', async () => {
  const calls: unknown[] = []
  const opts = toolOptsWith({
    save: async (input: unknown) => {
      calls.push(input)
      return { id: 'id-1', scope: 'project:test-workspace', content: 'x' }
    },
  })
  const tools = memoryTools(opts)
  const res = await tools.memory_save.execute({ content: '记住这件事', scope: 'project' })
  assert.equal(res.id, 'id-1')
  assert.deepEqual(calls[0], { scope: PROJECT, kind: 'note', content: '记住这件事', source: { origin: 'explicit' } })
  await assert.rejects(() => tools.memory_save.execute({ content: '' }), (e: Error & { code?: string }) => e.code === 'CONTENT_EMPTY')
  await assert.rejects(() => tools.memory_save.execute({ content: 'x', importance: 2 }), /importance/)
})

test('tools: 省略 scope 时由 provider 落点(会话优先),不再猜测', async () => {
  const calls: Array<Record<string, unknown>> = []
  const service = {
    save: async (input: Record<string, unknown>) => {
      calls.push(input)
      return { id: 'id-2', scope: (input.scope as string) ?? 'session:s1', content: 'x' }
    },
    // 有会话的 provider:写路径落 session:s1
    resolveReadScopes: () => ['session:s1', PROJECT, 'global'],
  }
  const tools = memoryTools({ getService: () => service as never, defaultScope: 'session', projectScope: PROJECT })
  const saved = await tools.memory_save.execute({ content: '会话内记一条' })
  assert.equal(saved.scope, 'session:s1', '省略 scope → 当前会话')
  // 没有会话上下文的 provider:回退到项目 scope(不报错)
  const noSessionCalls: Array<Record<string, unknown>> = []
  const noSessionService = {
    save: async (input: Record<string, unknown>) => {
      noSessionCalls.push(input)
      return { id: 'id-3', scope: (input.scope as string) ?? PROJECT, content: 'x' }
    },
    resolveReadScopes: () => [PROJECT, 'global'],
  }
  const tools2 = memoryTools({ getService: () => noSessionService as never, defaultScope: 'session', projectScope: PROJECT })
  const saved2 = await tools2.memory_save.execute({ content: '无会话上下文' })
  assert.equal(saved2.scope, PROJECT, '拿不到会话 → 回退项目 scope')
  assert.equal(noSessionCalls.length, 1, '保存只发生一次')
  // 省略 scope 时不带 scope 字段:provider 的 save 是默认值的唯一权威
  assert.equal('scope' in noSessionCalls[0]!, false)
})

test('tools: 非法 scope 报 SCOPE_INVALID,不再静默回退', async () => {
  const opts = toolOptsWith({ save: async () => ({ id: 'x', scope: 'x', content: 'x' }) })
  const tools = memoryTools(opts)
  await assert.rejects(
    () => tools.memory_save.execute({ content: 'x', scope: '../etc/passwd' }),
    (e: Error & { code?: string }) => e.code === 'SCOPE_INVALID',
  )
})

test('tools: forget enforces xor(id, query)', async () => {
  const opts = toolOptsWith({ forget: async () => ({ removed: 1, ids: ['a'] }) })
  const tools = memoryTools(opts)
  await assert.rejects(() => tools.memory_forget.execute({}), /provide id or query/i)
  await assert.rejects(() => tools.memory_forget.execute({ id: 'a', query: 'b' }), /not both/i)
  const res = await tools.memory_forget.execute({ id: 'a' })
  assert.equal(res.removed, 1)
})

test('tools: unavailable service fails with clear code', async () => {
  const tools = memoryTools({ getService: () => undefined, defaultScope: 'project', projectScope: PROJECT })
  await assert.rejects(() => tools.memory_search.execute({ query: 'x' }), /not loaded/)
})
