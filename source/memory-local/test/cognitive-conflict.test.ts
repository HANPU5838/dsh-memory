/**
 * 冲突检测（cognitive/conflict）：区间边界、只打标不改数据、标记持久化。
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../src/store.ts'
import {
  CONFLICT_HIGH_SIMILARITY,
  CONFLICT_MAX_SIMILARITY,
  CONFLICT_MIN_SIMILARITY,
  applyConflictMarker,
  assessConflicts,
  clearConflict,
  conflictFields,
  inConflictBand,
  isConflicted,
  markConflict,
} from '../src/cognitive/conflict.ts'
import { tombstone } from '../src/cognitive/lifecycle.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const DEFAULTS = { importance: 0.5, source: { origin: 'explicit' as const } }
type SaveInput = Parameters<MemoryStore['save']>[0]

function freshStore(): MemoryStore {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cog-conflict-'))
  dirs.push(dir)
  return new MemoryStore(dir)
}

function save(store: MemoryStore, scope: string, content: string, extra: Record<string, unknown> = {}) {
  return store.save({ scope, kind: 'note', content, ...extra } as SaveInput, DEFAULTS).record
}

test('冲突区间是 [0.75, 0.92):下界含、上界不含', () => {
  assert.equal(CONFLICT_MIN_SIMILARITY, 0.75)
  assert.equal(CONFLICT_MAX_SIMILARITY, 0.92)
  assert.equal(inConflictBand(0.7499), false)
  assert.equal(inConflictBand(0.75), true)
  assert.equal(inConflictBand(0.85), true)
  assert.equal(inConflictBand(0.9199), true)
  assert.equal(inConflictBand(0.92), false, '到达合并阈值就不算冲突')
  assert.equal(inConflictBand(0.99), false)
  // 自定义边界
  assert.equal(inConflictBand(0.6, { min: 0.5, max: 0.7 }), true)
  assert.equal(inConflictBand(0.7, { min: 0.5, max: 0.7 }), false)
})

test('assessConflicts:区间内且内容不同才标记,置信度取最高相似度', () => {
  const store = freshStore()
  const scope = 'project:c'
  const old = save(store, scope, '旧事实:端口是 8080')
  const overlap = save(store, scope, '相关但不同的旧事实')
  const stale = save(store, scope, '完全无关')
  const twin = save(store, scope, '和新的说法一模一样')

  const assessment = assessConflicts({
    content: '新事实:端口是 9090',
    candidates: [
      { record: old, similarity: 0.8 },
      { record: overlap, similarity: 0.76 },
      { record: stale, similarity: 0.2 },
    ],
  })
  assert.equal(assessment.conflicted, true)
  assert.deepEqual(assessment.findings.map((f) => f.id), [old.id, overlap.id])
  assert.deepEqual(assessment.marker.conflictWith, [old.id, overlap.id])
  assert.equal(assessment.marker.conflictConfidence, 0.8)
  assert.equal(assessment.severity, 'low')

  // 内容相同 = 重复而不是冲突
  const identical = assessConflicts({
    content: '和新的说法一模一样',
    candidates: [
      { record: twin, similarity: 0.88 },
      { record: old, similarity: 0.8 },
    ],
  })
  assert.deepEqual(identical.findings.map((f) => f.id), [old.id])

  // 高于合并阈值 → 归 merge,不是冲突
  const tooSimilar = assessConflicts({ content: '新说法', candidates: [{ record: old, similarity: 0.92 }] })
  assert.equal(tooSimilar.conflicted, false)
  assert.deepEqual(tooSimilar.marker, { conflictWith: [], conflictConfidence: 0 })
  assert.equal(tooSimilar.severity, 'none')

  // 高置信
  const high = assessConflicts({ content: '另一条新事实', candidates: [{ record: old, similarity: CONFLICT_HIGH_SIMILARITY }] })
  assert.equal(high.severity, 'high')

  // limit 截断(按相似度降序)
  const limited = assessConflicts({
    content: '再一条新事实',
    candidates: [
      { record: old, similarity: 0.78 },
      { record: overlap, similarity: 0.9 },
      { record: twin, similarity: 0.8 },
    ],
    options: { limit: 2 },
  })
  assert.deepEqual(limited.findings.map((f) => f.id), [overlap.id, twin.id])
})

test('assessConflicts:纯函数,不删不改任何记录;软删记录不参与冲突', () => {
  const store = freshStore()
  const scope = 'project:c-pure'
  const old = save(store, scope, '旧事实')
  const gone = save(store, scope, '被软删的旧事实')
  tombstone(store, gone.id)
  const goneNow = store.findById(gone.id)!
  const before = { content: old.content, tags: [...old.tags], count: store.scope(scope).records.size }

  const assessment = assessConflicts({
    content: '矛盾的新事实',
    candidates: [
      { record: old, similarity: 0.8 },
      { record: goneNow, similarity: 0.81 },
    ],
  })
  assert.deepEqual(assessment.findings.map((f) => f.id), [old.id], '软删记录不参与')
  assert.equal(store.scope(scope).records.size, before.count)
  assert.equal(old.content, before.content)
  assert.deepEqual(old.tags, before.tags)
  assert.equal(isConflicted(old), false, '评估阶段绝不自动打标')
})

test('markConflict:只写冲突字段,内容/标签/importance 一律不动', () => {
  const store = freshStore()
  const scope = 'project:c-mark'
  const record = save(store, scope, '旧事实', { tags: ['t'], importance: 0.7 })
  const snapshot = JSON.stringify(record)
  const assessment = assessConflicts({
    content: '矛盾的新事实',
    candidates: [{ record, similarity: 0.83 }],
  })
  const returned = markConflict(record, assessment)
  assert.equal(returned, record, '原地修改并返回同一引用')
  assert.equal(isConflicted(record), true)
  assert.deepEqual((record as unknown as { conflictWith: string[] }).conflictWith, [assessment.findings[0]!.id])
  assert.equal((record as unknown as { conflictConfidence: number }).conflictConfidence, 0.83)
  // 除冲突字段外其它内容原样
  const stripped = JSON.parse(JSON.stringify(record))
  delete stripped.conflictWith
  delete stripped.conflictConfidence
  assert.equal(JSON.stringify(stripped), snapshot)

  clearConflict(record)
  assert.equal(isConflicted(record), false)
  assert.equal(JSON.stringify(record), snapshot, '清标记后与打标前完全一致')

  // 无冲突评估 → conflictFields 为空
  assert.deepEqual(conflictFields({ conflicted: false, findings: [], marker: { conflictWith: [], conflictConfidence: 0 }, severity: 'none' }), {})
  const fields = conflictFields(assessment)
  assert.deepEqual(fields.conflictWith, assessment.findings.map((f) => f.id))
  assert.equal(fields.conflictConfidence, 0.83)
})

test('冲突标记能落盘并在重开后读回（save 透传 + flush）', () => {
  const scope = 'project:c-persist'
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cog-conflict-persist-'))
  dirs.push(dir)
  const first = new MemoryStore(dir)
  const old = save(first, scope, '旧事实')
  const record = save(first, scope, '矛盾的新事实', {
    conflictWith: [old.id],
    conflictConfidence: 0.81,
  })
  assert.equal(isConflicted(record), true)
  first.close()

  const second = new MemoryStore(dir)
  second.loadDiscovered()
  const reloaded = second.findById(record.id)
  assert.notEqual(reloaded, undefined)
  assert.deepEqual((reloaded as unknown as { conflictWith: string[] }).conflictWith, [old.id])
  assert.equal((reloaded as unknown as { conflictConfidence: number }).conflictConfidence, 0.81)
  second.close()
})

test('applyConflictMarker:标记能落盘重开可读,无冲突时清除旧标记', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cog-conflict-apply-'))
  dirs.push(dir)
  const scope = 'project:c-apply'
  const first = new MemoryStore(dir)
  const old = save(first, scope, '旧事实:端口 8080')
  const assessment = assessConflicts({ content: '新事实:端口 9090', candidates: [{ record: old, similarity: 0.81 }] })
  assert.equal(applyConflictMarker(first, old.id, assessment), true)
  assert.equal(isConflicted(first.findById(old.id)!), true)
  assert.equal(applyConflictMarker(first, '不存在的-id', assessment), false)
  first.close()

  const second = new MemoryStore(dir)
  second.loadDiscovered()
  const marked = second.findById(old.id)!
  assert.equal(isConflicted(marked), true)
  assert.deepEqual((marked as unknown as { conflictWith: string[] }).conflictWith, [old.id])
  assert.equal((marked as unknown as { conflictConfidence: number }).conflictConfidence, 0.81)

  // 人工裁决后清标记(无冲突评估 → 清除)
  const none = assessConflicts({ content: '新事实', candidates: [] })
  assert.equal(applyConflictMarker(second, old.id, none), true)
  assert.equal(isConflicted(second.findById(old.id)!), false)
  second.close()
})
