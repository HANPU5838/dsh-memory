/**
 * 0.83.0：注入前冲突消解 —— 互相矛盾的记忆不同时注入。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveInjectionConflicts } from '../src/conflicts.ts'

function hit(id, patch = {}) {
  return {
    score: 0.8,
    record: {
      id,
      scope: 'global',
      kind: 'fact',
      content: `内容 ${id}`,
      tags: [],
      importance: 0.5,
      updatedAt: 100,
      ...patch,
    },
  }
}

test('冲突对：保留重要度更高的一条，另一条进 dropped', () => {
  const a = hit('a', { importance: 0.9, conflictWith: ['b'] })
  const b = hit('b', { importance: 0.2, conflictWith: ['a'] })
  const { kept, dropped } = resolveInjectionConflicts([a, b])
  assert.deepEqual(kept.map((x) => x.record.id), ['a'])
  assert.deepEqual(dropped, ['b'])
})

test('重要度相同：更新时间新的胜；再相同按 id 小者胜', () => {
  const a = hit('a', { importance: 0.5, updatedAt: 200, conflictWith: ['b'] })
  const b = hit('b', { importance: 0.5, updatedAt: 100, conflictWith: ['a'] })
  assert.deepEqual(resolveInjectionConflicts([a, b]).kept.map((x) => x.record.id), ['a'])

  const c = hit('z', { importance: 0.5, updatedAt: 100, conflictWith: ['y'] })
  const d = hit('y', { importance: 0.5, updatedAt: 100, conflictWith: ['z'] })
  assert.deepEqual(resolveInjectionConflicts([c, d]).kept.map((x) => x.record.id), ['y'], 'id 小者胜')
})

test('不冲突 / 冲突对手不在命中里：原样保留；保持输入顺序', () => {
  const a = hit('a', { conflictWith: ['missing'] })
  const b = hit('b')
  const c = hit('c', { conflictWith: ['a'], importance: 0.1 })
  const result = resolveInjectionConflicts([b, a, c])
  assert.deepEqual(result.kept.map((x) => x.record.id), ['b', 'a'])
  assert.deepEqual(result.dropped, ['c'])
  // 确定性：两次一致。
  assert.deepEqual(resolveInjectionConflicts([b, a, c]), result)
})
