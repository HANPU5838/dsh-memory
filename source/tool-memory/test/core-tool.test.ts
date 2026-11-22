import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memoryCoreTool } from '../src/index.ts'

function toolWith(blocks: Record<string, { content: string; version: number } | undefined>) {
  const service = {
    coreSet: () => ({ content: '', version: 1, updatedAt: 0, updatedBy: 'user' as const }),
    coreBlocks: () => blocks,
    coreHistory: () => [],
  }
  return memoryCoreTool({ getService: () => service } as never)
}

const exec = { agent: undefined } as never

test('memory_core get 只返回有内容的槽位（输出必须是合法 JSON）', async () => {
  const tool = toolWith({ identity: { content: '身份', version: 1 }, profile: undefined, goal: undefined })
  const out = (await tool.execute({ action: 'get' }, exec)) as { blocks: Record<string, unknown> }
  assert.deepEqual(Object.keys(out.blocks), ['identity'])
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(out)))
})

test('memory_core get 空库返回空对象而不是 undefined', async () => {
  const tool = toolWith({ identity: undefined, profile: undefined, goal: undefined })
  const out = (await tool.execute({ action: 'get' }, exec)) as { blocks: Record<string, unknown> }
  assert.deepEqual(out.blocks, {})
})
