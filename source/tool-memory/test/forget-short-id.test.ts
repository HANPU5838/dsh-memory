/**
 * memory_forget 的 id 解析回归：
 *  - 支持 8 位短 id（和 memory_get 一致）——检索结果/注入摘要里展示的就是短 id；
 *  - 短 id 命中多条时必须报歧义，绝不误删；
 *  - 不存在时明确 RECORD_NOT_FOUND。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memoryForgetTool } from '../src/index.ts'

const base = {
  scope: 'global',
  kind: 'fact',
  content: '短 id 删除测试',
  tags: [],
  importance: 0.5,
  createdAt: 1,
  updatedAt: 1,
}

function serviceWith(records) {
  return {
    getByIds: (ids) => records.filter((record) => ids.some((token) => record.id === token || record.id.startsWith(token))),
    forget: async ({ id }) => {
      const hit = records.filter((record) => record.id === id)
      return { removed: hit.length, ids: hit.map((record) => record.id) }
    },
  }
}

test('memory_forget：8 位短 id 解析成完整 id 后删除', async () => {
  const tool = memoryForgetTool({ getService: () => serviceWith([{ ...base, id: 'abcdef12-3456-7890-abcd-ef1234567890' }]) })
  // 宿主运行时会冻结工具参数（防篡改），这里必须用冻结对象回归，否则会漏掉回写 args 的错误
  const out = await tool.execute(Object.freeze({ id: 'abcdef12' }))
  assert.equal(out.removed, 1)
  assert.deepEqual(out.ids, ['abcdef12-3456-7890-abcd-ef1234567890'])
})

test('memory_forget：短 id 不存在 → RECORD_NOT_FOUND（而不是静默删 0 条）', async () => {
  const tool = memoryForgetTool({ getService: () => serviceWith([{ ...base, id: 'abcdef12-3456-7890-abcd-ef1234567890' }]) })
  await assert.rejects(() => tool.execute(Object.freeze({ id: 'deadbeef' })), (error) => error?.code === 'RECORD_NOT_FOUND')
})

test('memory_forget：短 id 命中多条 → 报歧义、不误删', async () => {
  const records = [
    { ...base, id: 'abcdef12-3456-7890-abcd-ef1234567890' },
    { ...base, id: 'abcdef12-9999-0000-1111-222233334444' },
  ]
  const tool = memoryForgetTool({ getService: () => serviceWith(records) })
  await assert.rejects(() => tool.execute(Object.freeze({ id: 'abcdef12' })), (error) => error?.code === 'TARGET_AMBIGUOUS')
})
