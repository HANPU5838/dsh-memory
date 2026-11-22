import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildInsight, summarizeInsight } from '../src/insight.ts'
import type { MemoryRecord } from 'dsh-memory'

const DAY = 86_400_000
const now = 1_800_000_000_000

function record(partial: Partial<MemoryRecord> & Record<string, unknown>): MemoryRecord {
  return {
    id: 'r', scope: 'global', kind: 'fact', content: 'c', tags: [], importance: 0.5,
    createdAt: now, updatedAt: now, ...partial,
  } as unknown as MemoryRecord
}

test('自省报告识别近期修正 / 冲突 / 低价值 / 陈旧规则', () => {
  const records = [
    record({ id: 'a', supersedes: 'old', updatedAt: now - DAY }),
    record({ id: 'b', supersedes: 'old2', updatedAt: now - DAY }),
    record({ id: 'c', conflictWith: ['x'] }),
    record({ id: 'd', utility: 0.1, accessCount: 0 }),
    record({ id: 'e', kind: 'rule', updatedAt: now - 60 * DAY }),
    record({ id: 'f', accessCount: 0, createdAt: now - 60 * DAY }),
  ]
  const report = buildInsight(records, { now, conflicts: 1, healthScore: 88 })
  const byKey = Object.fromEntries(report.signals.map((signal) => [signal.key, signal]))
  assert.equal(byKey.corrections.count, 2)
  assert.equal(byKey.conflicts.count, 1)
  assert.equal(byKey.lowUtility.count, 1)
  assert.deepEqual(byKey.staleRules.ids, ['e'])
  assert.equal(byKey.health.count, 88)
  assert.ok(report.suggestions.length >= 2)
  assert.match(summarizeInsight(report), /自省报告/)
})

test('健康分与低信号时应给出 ok / 少量建议', () => {
  const report = buildInsight([record({ id: 'a' })], { now, conflicts: 0, healthScore: 100 })
  const byKey = Object.fromEntries(report.signals.map((signal) => [signal.key, signal]))
  assert.equal(byKey.health.severity, 'ok')
  assert.equal(byKey.corrections.count, 0)
  assert.equal(report.suggestions.length, 0)
})
