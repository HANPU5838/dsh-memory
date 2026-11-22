import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memoryBlockTool, memoryTools } from '../src/index.ts'
import { renderBlockResult } from '../src/render.ts'

/**
 * 0.32.0：`memory_block` 工具。
 *
 * 断言的重点不是 store（那在 memory-local 的 block-archive.test.ts 里覆盖），
 * 而是**工具层口径**：参数校验、审批矩阵如何转述给模型、渲染文案是否说清
 * 「这是屏蔽、不是删除、可以解除」。
 */

const agent = { session: { header: { id: 's1', cwd: 'D:/w' } } }
const exec = { agent }

interface FakeCalls {
  blocks: Array<Record<string, unknown>>
  unblocks: Array<Record<string, unknown>>
}

function fakeService(overrides: Record<string, unknown> = {}): { service: Record<string, unknown>; calls: FakeCalls } {
  const calls: FakeCalls = { blocks: [], unblocks: [] }
  const service: Record<string, unknown> = {
    requestBlock: async (_agent: unknown, input: Record<string, unknown>) => {
      calls.blocks.push(input)
      return {
        outcome: 'blocked',
        blocks: [{ id: 'blk-1', level: input.level ?? 'session', scope: input.scope ?? 'global', createdAt: 1, createdBy: 's1' }],
        records: input.id !== undefined ? [{ id: String(input.id), scope: 'global', kind: 'note' }] : [],
        containsRule: input.id === 'rule0001',
      }
    },
    unblock: (_agent: unknown, match: Record<string, unknown>) => {
      calls.unblocks.push(match)
      return [{ level: match.level ?? 'session', removed: 1 }]
    },
    listBlocks: () => [{ id: 'blk-1', level: 'session', scope: 'global', createdAt: 1, createdBy: 's1' }],
    ...overrides,
  }
  return { service, calls }
}

test('memory_block：按 id 屏蔽，工具把 level 默认成 session 并转述"无需审批"', async () => {
  const { service, calls } = fakeService()
  const tool = memoryBlockTool({ getService: () => service })
  const result = await tool.execute({ id: 'abcd1234', description: '降噪' }, exec)
  assert.equal(result.action, 'block')
  assert.equal(result.outcome, 'blocked')
  assert.equal(calls.blocks.length, 1)
  assert.equal(calls.blocks[0]!.level, 'session')
  assert.equal(calls.blocks[0]!.id, 'abcd1234')
  assert.equal(calls.blocks[0]!.tool, 'memory_block')
  assert.match(result.note ?? '', /会话级/)
  assert.match(result.note ?? '', /解除/)
})

test('memory_block：工作区级要审批，note 明确说明影响面', async () => {
  const { service, calls } = fakeService()
  const tool = memoryBlockTool({ getService: () => service })
  const result = await tool.execute({ id: 'abcd1234', level: 'workspace', description: '降噪' }, exec)
  assert.equal(calls.blocks[0]!.level, 'workspace')
  assert.match(result.note ?? '', /工作区级/)
  assert.match(result.note ?? '', /所有会话/)
})

test('memory_block：目标是规则时 note 说明"规则必须用户确认"', async () => {
  const { service } = fakeService()
  const tool = memoryBlockTool({ getService: () => service })
  const result = await tool.execute({ id: 'rule0001', description: '降噪' }, exec)
  assert.equal(result.containsRule, true)
  assert.match(result.note ?? '', /规则/)
  assert.match(result.note ?? '', /审批/)
})

test('memory_block：拒绝 / 超时 / 不可用分别有清楚的结局文案', async () => {
  for (const [outcome, pattern] of [['rejected', /拒绝/], ['timeout', /超时/], ['unavailable', /无法发起/]] as const) {
    const { service } = fakeService({
      requestBlock: async () => ({ outcome, blocks: [], records: [] }),
    })
    const tool = memoryBlockTool({ getService: () => service })
    const result = await tool.execute({ id: 'abcd1234', description: '降噪' }, exec)
    assert.equal(result.outcome, outcome)
    assert.match(result.note ?? '', pattern)
  }
})

test('memory_block：scope 与 id 都缺时明确报错（不静默什么都不做）', async () => {
  const { service } = fakeService()
  const tool = memoryBlockTool({ getService: () => service })
  await assert.rejects(
    () => tool.execute({ description: '降噪' }, exec),
    (error: { code?: string }) => error.code === 'TARGET_REQUIRED',
  )
})

test('memory_block unblock：按作用域解除，返回 removed 与剩余清单', async () => {
  const { service, calls } = fakeService()
  const tool = memoryBlockTool({ getService: () => service })
  const result = await tool.execute({ action: 'unblock', scope: 'global', description: '恢复' }, exec)
  assert.equal(result.action, 'unblock')
  assert.equal(result.outcome, 'unblocked')
  assert.equal(result.removed, 1)
  assert.equal(calls.unblocks[0]!.scope, 'global')
})

test('memory_block unblock：没有匹配时 outcome=unavailable 并说明可能已解除', async () => {
  const { service } = fakeService({ unblock: () => [] })
  const tool = memoryBlockTool({ getService: () => service })
  const result = await tool.execute({ action: 'unblock', scope: 'global', description: '恢复' }, exec)
  assert.equal(result.outcome, 'unavailable')
  assert.match(result.note ?? '', /已经/)
})

test('memory_block list：返回当前生效的屏蔽清单', async () => {
  const { service } = fakeService()
  const tool = memoryBlockTool({ getService: () => service })
  const result = await tool.execute({ action: 'list' }, exec)
  assert.equal(result.outcome, 'listed')
  assert.equal(result.blocks.length, 1)
})

test('memory_block：旧 provider 没有 requestBlock 时明确提示升级', async () => {
  const { service } = fakeService({ requestBlock: undefined })
  const tool = memoryBlockTool({ getService: () => service })
  await assert.rejects(
    () => tool.execute({ id: 'abcd1234', description: '降噪' }, exec),
    (error: { code?: string }) => error.code === 'UNSUPPORTED',
  )
})

test('memoryTools 注册 7 个工具，含 memory_block', () => {
  const { service } = fakeService()
  assert.deepEqual(Object.keys(memoryTools({ getService: () => service })).sort(), [
    'memory_block', 'memory_core', 'memory_forget', 'memory_get', 'memory_hooks', 'memory_list', 'memory_save', 'memory_scopes', 'memory_search',
  ])
})

test('renderBlockResult：屏蔽 / 解除 / 清单三种结局都有可读文案', () => {
  const label = (scope: string): string => (scope === 'global' ? '全局' : scope)
  const blocked = renderBlockResult({
    action: 'block',
    outcome: 'blocked',
    blocks: [{ id: 'blk-1', level: 'workspace', scope: 'global', createdAt: 1, createdBy: 's1' }],
    note: '工作区级屏蔽影响该工作区所有会话（含历史与将来），需要用户审批；解除同样需要审批。',
  }, label)
  assert.match(blocked, /屏蔽/)
  assert.match(blocked, /工作区级/)
  assert.match(blocked, /不删除/)

  const unblocked = renderBlockResult({ action: 'unblock', outcome: 'unblocked', blocks: [], removed: 2 }, label)
  assert.match(unblocked, /解除/)
  assert.match(unblocked, /2/)

  const listed = renderBlockResult({
    action: 'list',
    outcome: 'listed',
    blocks: [
      { id: 'blk-1', level: 'session', scope: 'global', createdAt: 1, createdBy: 's1' },
      { id: 'blk-2', level: 'workspace', recordId: 'abcd1234', recordKind: 'note', createdAt: 2, createdBy: 's1' },
    ],
  }, label)
  assert.match(listed, /全局/)
  assert.match(listed, /abcd1234/)
})
