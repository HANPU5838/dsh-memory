/**
 * 认知层 store 基础能力：generation 版本号、supersedes 谱系、相似检索、近重复。
 * 全部用临时目录 + 内存向量，不碰真实记忆库。
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, generationOf } from '../src/store.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const DEFAULTS = { importance: 0.5, source: { origin: 'explicit' as const } }
type SaveInput = Parameters<MemoryStore['save']>[0]

function freshStore(): MemoryStore {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cog-store-'))
  dirs.push(dir)
  return new MemoryStore(dir)
}

function save(store: MemoryStore, scope: string, content: string, extra: Record<string, unknown> = {}) {
  return store.save({ scope, kind: 'note', content, ...extra } as SaveInput, DEFAULTS).record
}

/** 以 [1,0,0,0] 为基准，构造与它余弦相似度 ≈ similarity 的向量。 */
function vecAt(similarity: number): Float32Array {
  return new Float32Array([similarity, Math.sqrt(Math.max(0, 1 - similarity * similarity)), 0, 0])
}

test('generation:老记录缺省为 1,supersedes 一次 +1', () => {
  const store = freshStore()
  const scope = 'project:gen'
  const v1 = save(store, scope, '第一版')
  assert.equal(generationOf(v1), 1)
  assert.equal(v1.generation, undefined, '首版不落 generation 字段')
  const v2 = save(store, scope, '第二版', { supersedes: v1.id })
  assert.equal(generationOf(v2), 2)
  const v3 = save(store, scope, '第三版', { supersedes: v2.id })
  assert.equal(generationOf(v3), 3)
})

test('lineage:沿 supersedes 由旧到新,任意版本查到的都是同一条链', () => {
  const store = freshStore()
  const scope = 'project:lineage'
  const v1 = save(store, scope, '版本一')
  const v2 = save(store, scope, '版本二', { supersedes: v1.id })
  const v3 = save(store, scope, '版本三', { supersedes: v2.id })

  const fromRoot = store.lineage(v1.id)
  assert.notEqual(fromRoot, null)
  assert.equal(fromRoot!.rootId, v1.id)
  assert.equal(fromRoot!.currentId, v3.id)
  assert.equal(fromRoot!.scope, scope)
  assert.deepEqual(fromRoot!.entries.map((e) => e.generation), [1, 2, 3])
  assert.deepEqual(fromRoot!.entries.map((e) => e.id), [v1.id, v2.id, v3.id])
  assert.deepEqual(fromRoot!.entries[0]!.supersededBy, [v2.id])
  assert.equal(fromRoot!.entries[0]!.supersedes, null)
  assert.equal(fromRoot!.entries[2]!.supersedes, v2.id)
  assert.deepEqual(fromRoot!.entries[2]!.supersededBy, [])

  const fromMiddle = store.lineage(v2.id)
  assert.deepEqual(fromMiddle!.entries.map((e) => e.id), [v1.id, v2.id, v3.id])
  assert.equal(fromMiddle!.rootId, v1.id)
  assert.equal(fromMiddle!.currentId, v3.id)

  assert.equal(store.lineage('不存在的-id'), null)
})

test('lineage:单条记录自成链;人为成环也不死循环', () => {
  const store = freshStore()
  const scope = 'project:cycle'
  const single = save(store, scope, '孤立记录')
  const line = store.lineage(single.id)
  assert.equal(line!.entries.length, 1)
  assert.equal(line!.rootId, single.id)
  assert.equal(line!.currentId, single.id)

  const a = save(store, scope, '环 A')
  const b = save(store, scope, '环 B')
  const scopeStore = store.scope(scope)
  // 人为制造 a ⇄ b 的 supersedes 环（历史数据损坏 / 外部写坏文件）
  scopeStore.insert({ ...a, supersedes: b.id } as typeof a)
  scopeStore.insert({ ...b, supersedes: a.id } as typeof b)
  const cyclic = store.lineage(a.id)
  assert.notEqual(cyclic, null)
  assert.equal(cyclic!.entries.length, 2, '两个版本各出现一次,不重复不丢失')
})

test('findSimilar:按相似度排序 / minScore / limit / excludeIds / 无向量不参与', () => {
  const store = freshStore()
  const scope = 'project:similar'
  const near = save(store, scope, '附近')
  const mid = save(store, scope, '中间')
  const far = save(store, scope, '很远')
  const noVec = save(store, scope, '没有向量')
  const s = store.scope(scope)
  s.setVector(near.id, vecAt(0.95))
  s.setVector(mid.id, vecAt(0.8))
  s.setVector(far.id, vecAt(0.2))

  const query = new Float32Array([1, 0, 0, 0])
  const all = store.findSimilar(query, { scope, minScore: 0.1, limit: 10 })
  assert.deepEqual(all.map((h) => h.record.id), [near.id, mid.id, far.id])
  assert.ok(Math.abs(all[0]!.similarity - 0.95) < 1e-5)
  assert.ok(!all.some((h) => h.record.id === noVec.id), '没向量的记录不可比')

  const filtered = store.findSimilar(query, { scope, minScore: 0.75 })
  assert.deepEqual(filtered.map((h) => h.record.id), [near.id, mid.id])

  const limited = store.findSimilar(query, { scope, limit: 1 })
  assert.deepEqual(limited.map((h) => h.record.id), [near.id])

  const excluded = store.findSimilar(query, { scope, excludeIds: [near.id] })
  assert.deepEqual(excluded.map((h) => h.record.id), [mid.id, far.id])

  // scope 缺省 = 扫全部已加载 scope（这里只有同一个 scope 有向量）
  assert.equal(store.findSimilar(query, { limit: 1 })[0]!.record.id, near.id)
})

test('findSimilar:默认跳过已退役版本和 tombstone,可显式包含', () => {
  const store = freshStore()
  const scope = 'project:similar-retired'
  const old = save(store, scope, '旧版本')
  const next = save(store, scope, '新版本', { supersedes: old.id })
  const gone = save(store, scope, '被软删的')
  const s = store.scope(scope)
  s.setVector(old.id, vecAt(0.99))
  s.setVector(next.id, vecAt(0.98))
  s.setVector(gone.id, vecAt(0.97))
  // 直接打 tombstone 标记（软删的语义在 lifecycle 模块，这里只验证检索过滤）
  s.insert({ ...gone, tombstonedAt: Date.now() } as typeof gone)

  const query = new Float32Array([1, 0, 0, 0])
  const active = store.findSimilar(query, { scope })
  assert.deepEqual(active.map((h) => h.record.id), [next.id])

  const withRetired = store.findSimilar(query, { scope, includeRetired: true })
  assert.deepEqual(withRetired.map((h) => h.record.id), [old.id, next.id])

  const withTombstoned = store.findSimilar(query, { scope, includeTombstoned: true })
  assert.deepEqual(withTombstoned.map((h) => h.record.id), [next.id, gone.id])
})

test('nearDuplicates:阈值内的同一 scope 记录成对,keepId 取更新/更高版本', () => {
  const store = freshStore()
  const scope = 'project:dup'
  const a = save(store, scope, '重复内容 A')
  const b = save(store, scope, '重复内容 B')
  const unrelated = save(store, scope, '完全无关')
  const s = store.scope(scope)
  const base = new Float32Array([1, 0, 0, 0])
  s.setVector(a.id, base)
  s.setVector(b.id, vecAt(0.95))
  s.setVector(unrelated.id, new Float32Array([0, 0, 1, 0]))
  // 同一毫秒写入时 updatedAt 可能相等,显式拉开一档,让 keepId 判定确定
  s.insert({ ...b, updatedAt: a.updatedAt + 1000 } as typeof b)

  const pairs = store.nearDuplicates(scope, 0.92)
  assert.equal(pairs.length, 1, '只有 a/b 相似,unrelated 不参与成对')
  const pair = pairs[0]!
  assert.deepEqual([pair.a, pair.b].sort(), [a.id, b.id].sort())
  assert.ok(Math.abs(pair.similarity - 0.95) < 1e-5)
  // b 更晚写入 → keepId 必须是 b
  assert.equal(pair.keepId, b.id)
  assert.equal(pair.mergeId, a.id)

  assert.deepEqual(store.nearDuplicates(scope, 0.99), [], '阈值 0.99 时 0.95 的那对不算')
  // 不存在的 scope:读路径返回空,不创建
  assert.deepEqual(store.nearDuplicates('project:not-exist', 0.92), [])
  assert.equal(store.peek('project:not-exist'), undefined)
})

test('nearDuplicates:跳过退役版本;maxRecords 限流不报错', () => {
  const store = freshStore()
  const scope = 'project:dup-retired'
  const old = save(store, scope, '旧版重复')
  const next = save(store, scope, '新版重复', { supersedes: old.id })
  const other = save(store, scope, '另一个重复')
  const s = store.scope(scope)
  s.setVector(old.id, new Float32Array([1, 0, 0, 0]))
  s.setVector(next.id, vecAt(0.97))
  s.setVector(other.id, vecAt(0.96))

  const pairs = store.nearDuplicates(scope, 0.92)
  const ids = pairs.flatMap((p) => [p.a, p.b])
  assert.ok(!ids.includes(old.id), '退役的旧版本不参与近重复')
  assert.ok(ids.includes(next.id))
  assert.ok(ids.includes(other.id))

  // maxRecords=2 时只比较最近更新的两条,仍能正常工作
  const limited = store.nearDuplicates(scope, 0.92, { maxRecords: 2, limit: 5 })
  assert.ok(limited.length <= 1)
})
