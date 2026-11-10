/**
 * 0.33.0：记忆强度 / 有效期 / 巩固字段的持久化与 updateMetrics。
 *
 * 这些字段是"算法层"的输入输出（FSRS 保持度、效用反馈、时间有效性、巩固谱系），
 * 必须能落盘、能增量更新、老记录缺省不报错。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../src/store.ts'

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-metrics-'))
  const store = new MemoryStore(dir)
  return { dir, store }
}

test('保存时透传 stability/difficulty/utility/useCount/validFrom/validUntil/consolidatedFrom', () => {
  const { dir, store } = makeStore()
  try {
    // 通过 MemoryStore.save 写入，验证落盘字段
    const saved = store.save({
      scope: 'project:/metrics',
      kind: 'fact',
      content: '记忆强度字段测试',
      stability: 12.5,
      difficulty: 0.4,
      utility: 0.7,
      useCount: 3,
      lastUsedAt: 1_700_000_000_000,
      validFrom: 1_600_000_000_000,
      validUntil: 1_800_000_000_000,
      consolidatedFrom: ['a', 'b'],
    } as never, { importance: 0.8, source: { origin: 'explicit' } })
    const rec = saved.record as Record<string, unknown>
    assert.equal(rec.stability, 12.5)
    assert.equal(rec.difficulty, 0.4)
    assert.equal(rec.utility, 0.7)
    assert.equal(rec.useCount, 3)
    assert.equal(rec.lastUsedAt, 1_700_000_000_000)
    assert.equal(rec.validFrom, 1_600_000_000_000)
    assert.equal(rec.validUntil, 1_800_000_000_000)
    assert.deepEqual(rec.consolidatedFrom, ['a', 'b'])
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('updateMetrics 就地更新并保持字段范围', () => {
  const { dir, store } = makeStore()
  try {
    const saved = store.save({ scope: 'project:/metrics2', kind: 'note', content: '效用反馈测试' } as never, { importance: 0.7, source: { origin: 'explicit' } })
    const updated = store.updateMetrics(saved.record.id, { utility: 1.8, useCount: 2.9, stability: -5, difficulty: 2 })
    assert.ok(updated)
    const rec = updated as Record<string, unknown>
    assert.equal(rec.utility, 1, 'utility 夹紧到 0..1')
    assert.equal(rec.useCount, 2, 'useCount 取整')
    assert.equal(rec.stability, 0, 'stability 不为负')
    assert.equal(rec.difficulty, 1, 'difficulty 夹紧到 0..1')
    assert.equal(store.updateMetrics('not-exist', { utility: 0.5 }), undefined)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('老记录没有这些字段时读取不报错（零迁移）', () => {
  const { dir, store } = makeStore()
  try {
    const saved = store.save({ scope: 'project:/legacy', kind: 'note', content: '老记录' } as never, { importance: 0.7, source: { origin: 'explicit' } })
    const rec = saved.record as Record<string, unknown>
    assert.equal(rec.stability, undefined)
    assert.equal(rec.utility, undefined)
    assert.equal(rec.consolidatedFrom, undefined)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
