import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memoryInsightTool } from '../src/index.ts'

const report = {
  generatedAt: 1_800_000_000_000,
  totals: { records: 5, recentDays: 7 },
  signals: [
    { key: 'corrections', label: '近期修正', count: 2, severity: 'watch', detail: '最近 7 天有 2 条记忆被新版本修正', ids: ['a'] },
    { key: 'health', label: '健康分', count: 100, severity: 'ok', detail: '当前健康分 100/100', ids: [] },
  ],
  suggestions: ['修正次数偏多：考虑合并同类记忆。'],
}

test('memory_insight report 只读，返回报告结构', async () => {
  let saved = 0
  const tool = memoryInsightTool({
    getService: () => ({ insightReport: () => report, save: async () => { saved += 1; return { id: 'x', scope: 'project' } } }),
  } as never)
  const out = (await tool.execute({ action: 'report' }, {} as never)) as Record<string, unknown>
  assert.equal(out.totals.records, 5)
  assert.equal(saved, 0, 'report 不应写库')
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(out)))
})

test('memory_insight reflect 写一条反思候选', async () => {
  const savedInputs: Array<Record<string, unknown>> = []
  const tool = memoryInsightTool({
    getService: () => ({
      insightReport: () => report,
      save: async (input: unknown) => { savedInputs.push(input as Record<string, unknown>); return { id: 'refl-1', scope: 'project' } },
    }),
  } as never)
  const out = (await tool.execute({ action: 'reflect' }, {} as never)) as Record<string, unknown>
  assert.equal(out.reflectionId, 'refl-1')
  assert.equal(savedInputs.length, 1)
  assert.equal(savedInputs[0]!.kind, 'reflection')
  const meta = JSON.parse(String(savedInputs[0]!.reflection))
  assert.equal(meta.status, 'candidate')
  assert.match(String(savedInputs[0]!.content), /自省报告/)
})

test('memory_insight 在 provider 不支持时明确报错', async () => {
  const tool = memoryInsightTool({ getService: () => ({}) } as never)
  await assert.rejects(tool.execute({ action: 'report' }, {} as never), /不支持自省报告/)
})
