import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memoryMaintainTool } from '../src/index.ts'

function toolWith(runHousekeeping: (options?: { forcePurgeTombstones?: boolean }) => unknown) {
  return memoryMaintainTool({ getService: () => ({ runHousekeeping }) } as never)
}

test('memory_maintain 返回各类清理计数与健康分', async () => {
  const calls: Array<{ forcePurgeTombstones?: boolean } | undefined> = []
  const tool = toolWith((options) => {
    calls.push(options)
    return {
      purged: ['a'], evicted: [], dormant: ['b'], tombstones: ['c'],
      consolidated: [], prunedScopes: [],
      health: { score: 100, conflictRate: 0, duplicateRate: 0, quarantined: 0, pending: 0 },
    }
  })
  const out = (await tool.execute({ purgeTombstones: true }, {} as never)) as Record<string, unknown>
  assert.deepEqual(calls, [{ forcePurgeTombstones: true }])
  assert.equal(out.purged, 1)
  assert.equal(out.tombstones, 1)
  assert.deepEqual(out.health, { score: 100, conflictRate: 0, duplicateRate: 0, quarantined: 0, pending: 0 })
})

test('memory_maintain 默认不清墓碑', async () => {
  const calls: Array<{ forcePurgeTombstones?: boolean } | undefined> = []
  const tool = toolWith((options) => {
    calls.push(options)
    return { purged: [], evicted: [], dormant: [], tombstones: [], consolidated: [], prunedScopes: [] }
  })
  await tool.execute({}, {} as never)
  assert.deepEqual(calls, [{ forcePurgeTombstones: false }])
})
