import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  memorySaveTool,
  memorySearchTool,
  type AccessDecisionView,
  type VisibilityPolicyView,
} from '../src/index.ts'

const PROJECT = 'project:D:/w'

const records = [
  {
    record: { id: 'g1', scope: 'global', kind: 'fact', content: '全局记忆', tags: [], importance: 0.5, updatedAt: 1 },
    score: 0.9,
  },
  {
    record: { id: 'h1', scope: 'handbook', kind: 'fact', content: '范围外记忆', tags: [], importance: 0.5, updatedAt: 2 },
    score: 0.8,
  },
]

interface Harness {
  tool: ReturnType<typeof memorySaveTool> | ReturnType<typeof memorySearchTool>
  asked: number
  saved: Array<Record<string, unknown>>
}

function harness(
  policy: VisibilityPolicyView,
  decisions: Record<string, AccessDecisionView>,
  kind: 'save' | 'search',
): Harness {
  const asked = { count: 0 }
  const saved: Array<Record<string, unknown>> = []
  const service = {
    save: async (input: unknown) => {
      saved.push(input as Record<string, unknown>)
      return { id: 'new-id', scope: 'handbook' }
    },
    search: async () => records,
    list: async () => records.map((item) => item.record),
    forget: async () => ({ removed: 0, ids: [] }),
    getByIds: (ids: string[]) => [
      ...(ids.includes(OLD_ID) ? [{ id: OLD_ID, scope: 'global', kind: 'fact', content: '旧记录', tags: [], importance: 0.5, updatedAt: 0 }] : []),
      ...records.filter((item) => ids.includes(item.record.id)).map((item) => item.record),
    ],
    visibilityPolicy: () => policy,
    accessEvaluator: () => (request: { action: string; scope: string }) =>
      decisions[`${request.action}:${request.scope}`] ?? { allowed: true, requestable: false },
    requestOutOfScope: async () => {
      asked.count += 1
      return 'rejected'
    },
  }
  const tool = kind === 'save'
    ? memorySaveTool({ getService: () => service })
    : memorySearchTool({ getService: () => service })
  return {
    tool,
    get asked() { return asked.count },
    saved,
  }
}

const agentExec = { agent: { session: { header: { id: 's1', cwd: 'D:/w' } } } }

const ABSOLUTE: VisibilityPolicyView = { level: 'absolute', scopes: [{ scope: 'global' }], source: 'explicit' }
const NORMAL: VisibilityPolicyView = { level: 'normal', scopes: [{ scope: 'global' }], source: 'explicit' }

test('absolute：search 不发起审批，withheld=absolute', async () => {
  const h = harness(ABSOLUTE, {
    'read:global': { allowed: true, requestable: false },
    'read:handbook': { allowed: false, reason: 'ABSOLUTE_ISOLATION', requestable: false },
  }, 'search')
  const result = await h.tool.execute({ query: '记忆', description: '查记忆' }, agentExec)
  assert.equal(result.records.length, 1)
  assert.deepEqual(result.withheld, { count: 1, reason: 'absolute' })
  assert.equal(h.asked, 0, 'absolute 下不能弹审批')
})

test('normal：范围外 search 默认只给索引，不发起审批（0.27.0）', async () => {
  const h = harness(NORMAL, {
    'read:global': { allowed: true, requestable: false },
    'read:handbook': { allowed: false, reason: 'SCOPE_NOT_IN_RANGE', requestable: true },
  }, 'search')
  const result = await h.tool.execute({ query: '记忆', description: '查记忆' }, agentExec)
  assert.equal(result.records.length, 1)
  assert.deepEqual(result.withheld, { count: 1, reason: 'out-of-scope' })
  assert.equal(h.asked, 0, '默认不弹审批')
  assert.deepEqual(result.outOfScope?.scopes.map((entry) => [entry.scope, entry.records]), [['handbook', 1]])
  assert.ok(result.outOfScope?.scopes.every((entry) => typeof entry.description === 'string' && entry.description.length > 0), '范围外清单带作用域用途')
})

test('normal：requestApproval=true 发起审批，拒绝后 withheld=rejected 且索引保留', async () => {
  const h = harness(NORMAL, {
    'read:global': { allowed: true, requestable: false },
    'read:handbook': { allowed: false, reason: 'SCOPE_NOT_IN_RANGE', requestable: true },
  }, 'search')
  const result = await h.tool.execute({ query: '记忆', description: '查记忆', requestApproval: true }, agentExec)
  assert.equal(result.records.length, 1)
  assert.deepEqual(result.withheld, { count: 1, reason: 'rejected' })
  assert.equal(h.asked, 1)
  assert.deepEqual(result.outOfScope?.scopes.map((entry) => [entry.scope, entry.records]), [['handbook', 1]], '被拒的命中仍以作用域清单给出')
})

test('absolute：memory_save 直接拒绝，不弹审批', async () => {
  const h = harness(ABSOLUTE, {
    'write:handbook': { allowed: false, reason: 'ABSOLUTE_ISOLATION', requestable: false },
  }, 'save')
  await assert.rejects(
    h.tool.execute({ content: '新内容', scope: 'handbook', description: '写入测试' }, agentExec),
    (error: Error & { code?: string }) => error.code === 'VISIBILITY_ABSOLUTE',
  )
  assert.equal(h.asked, 0)
  assert.equal(h.saved.length, 0)
})

test('normal：范围外 memory_save 先审批；用户拒绝则失败', async () => {
  const h = harness(NORMAL, {
    'write:handbook': { allowed: false, reason: 'SCOPE_NOT_IN_RANGE', requestable: true },
  }, 'save')
  await assert.rejects(
    h.tool.execute({ content: '新内容', scope: 'handbook', description: '写入测试' }, agentExec),
    (error: Error & { code?: string }) => error.code === 'VISIBILITY_REJECTED',
  )
  assert.equal(h.asked, 1)
  assert.equal(h.saved.length, 0)
})

test('显式 write:false 不弹审批，直接 SCOPE_READ_ONLY', async () => {
  const h = harness(NORMAL, {
    'write:handbook': { allowed: false, reason: 'WRITE_DISABLED', requestable: false },
  }, 'save')
  await assert.rejects(
    h.tool.execute({ content: '新内容', scope: 'handbook', description: '写入测试' }, agentExec),
    (error: Error & { code?: string }) => error.code === 'SCOPE_READ_ONLY',
  )
  assert.equal(h.asked, 0)
})

const OLD_ID = '12345678-aaaa-bbbb-cccc-ddddeeeeffff'

test('supersedes 省略 scope 直接拒绝（SUPERSEDES_SCOPE_REQUIRED），不落盘', async () => {
  const h = harness(NORMAL, {}, 'save')
  await assert.rejects(
    h.tool.execute({ content: '修正旧记忆', supersedes: OLD_ID, description: '修正测试' }, agentExec),
    (error: Error & { code?: string }) => error.code === 'SUPERSEDES_SCOPE_REQUIRED',
  )
  assert.equal(h.saved.length, 0)
  assert.equal(h.asked, 0)
})

test('supersedes 目标作用域无写权限直接拒绝（SUPERSEDES_SCOPE_NOT_WRITABLE），不弹审批', async () => {
  const h = harness(NORMAL, {
    'write:handbook': { allowed: false, reason: 'SCOPE_NOT_IN_RANGE', requestable: true },
  }, 'save')
  await assert.rejects(
    h.tool.execute({ content: '修正旧记忆', scope: 'handbook', supersedes: OLD_ID, description: '修正测试' }, agentExec),
    (error: Error & { code?: string }) => error.code === 'SUPERSEDES_SCOPE_NOT_WRITABLE',
  )
  assert.equal(h.saved.length, 0)
  assert.equal(h.asked, 0, 'supersedes 不走范围外审批')
})

test('supersedes 有写权限时保存成功，返回值带目标作用域 key 与修正关系', async () => {
  const h = harness(NORMAL, {}, 'save')
  const result = await h.tool.execute(
    { content: '修正旧记忆', scope: 'handbook', supersedes: OLD_ID, description: '修正测试' },
    agentExec,
  ) as { id: string; scope: string; supersedes?: { id: string; scope?: string } }
  assert.equal(result.scope, 'handbook', '返回值带保存到的目标作用域 key')
  assert.deepEqual(result.supersedes, { id: OLD_ID, scope: 'global' }, '返回值带修正关系（旧记录作用域可不同）')
  const input = h.saved[0] as Record<string, unknown>
  assert.equal(input.scope, 'handbook', 'scope 显式传给 provider')
  assert.equal(input.supersedes, OLD_ID)
})
