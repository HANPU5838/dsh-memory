/**
 * 生命周期（cognitive/lifecycle）：dormant 休眠、tombstone 软删/恢复/清理、
 * snapshot 导出与导入往返。全部临时目录，不碰真实记忆库。
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { MemoryStore, isDormantRecord, isTombstonedRecord } from '../src/store.ts'
import {
  DORMANT_AFTER_DAYS,
  DORMANT_MAX_IMPORTANCE,
  SNAPSHOT_SCHEMA,
  TOMBSTONE_RETENTION_DAYS,
  markDormant,
  purgeTombstones,
  restore,
  restoreSnapshot,
  revive,
  shouldSkipRecord,
  snapshot,
  tombstone,
} from '../src/cognitive/lifecycle.ts'

const DAY_MS = 86_400_000
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const DEFAULTS = { importance: 0.5, source: { origin: 'explicit' as const } }
type SaveInput = Parameters<MemoryStore['save']>[0]

function freshStore(prefix = 'dsh-cog-life-'): { dir: string; store: MemoryStore } {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return { dir, store: new MemoryStore(dir) }
}

function save(store: MemoryStore, scope: string, content: string, extra: Record<string, unknown> = {}) {
  return store.save({ scope, kind: 'note', content, ...extra } as SaveInput, DEFAULTS).record
}

/** 把记录的 lastAccessedAt 改到 ms 之前（模拟"很久没访问"）。 */
function ageRecord(store: MemoryStore, record: { id: string; scope: string }, ms: number): void {
  const scopeStore = store.scope(record.scope)
  const current = scopeStore.records.get(record.id)!
  scopeStore.insert({ ...current, lastAccessedAt: Date.now() - ms } as typeof current)
}

test('常量与默认值：休眠 30 天 / importance≤0.3,软删保留 30 天', () => {
  assert.equal(DORMANT_AFTER_DAYS, 30)
  assert.equal(DORMANT_MAX_IMPORTANCE, 0.3)
  assert.equal(TOMBSTONE_RETENTION_DAYS, 30)
  assert.equal(SNAPSHOT_SCHEMA, 1)
})

test('markDormant:只打"久未访问 + 低 importance"的记录,重复调用幂等', () => {
  const { store } = freshStore()
  const scope = 'project:dorm'
  const now = Date.now()
  const oldLow = save(store, scope, '很久没访问的低价值记录', { importance: 0.1 })
  const oldHigh = save(store, scope, '很久没访问但很重要', { importance: 0.9 })
  const recent = save(store, scope, '刚访问过', { importance: 0.1 })
  const exactlyLow = save(store, scope, 'importance 恰好 0.3', { importance: DORMANT_MAX_IMPORTANCE })
  ageRecord(store, oldLow, 40 * DAY_MS)
  ageRecord(store, oldHigh, 40 * DAY_MS)
  ageRecord(store, exactlyLow, 40 * DAY_MS)

  const result = markDormant(store, { now })
  assert.deepEqual([...result.marked].sort(), [oldLow.id, exactlyLow.id].sort(), 'importance 边界含 0.3')
  assert.equal(result.scanned, 4)
  assert.equal(isDormantRecord(store.findById(oldLow.id)!), true)
  assert.equal((store.findById(oldLow.id) as unknown as { dormantAt: number }).dormantAt, now)
  assert.equal(isDormantRecord(store.findById(oldHigh.id)!), false)
  assert.equal(isDormantRecord(store.findById(recent.id)!), false)

  const again = markDormant(store, { now })
  assert.deepEqual(again.marked, [], '已休眠的不重复打标(幂等)')
})

test('markDormant:跳过 tombstone 软删记录;可限定 scopes', () => {
  const { store } = freshStore()
  const scopeA = 'project:dorm-a'
  const scopeB = 'project:dorm-b'
  const gone = save(store, scopeA, '已软删的低价值记录', { importance: 0.1 })
  const aliveA = save(store, scopeA, 'A 里的旧低价值', { importance: 0.1 })
  const aliveB = save(store, scopeB, 'B 里的旧低价值', { importance: 0.1 })
  ageRecord(store, gone, 40 * DAY_MS)
  ageRecord(store, aliveA, 40 * DAY_MS)
  ageRecord(store, aliveB, 40 * DAY_MS)
  tombstone(store, gone.id)

  const onlyA = markDormant(store, { scopes: [scopeA] })
  assert.deepEqual(onlyA.marked, [aliveA.id])
  assert.equal(isDormantRecord(store.findById(gone.id)!), false)
  assert.equal(isDormantRecord(store.findById(aliveB.id)!), false)
})

test('shouldSkipRecord:dormant 与 tombstone 默认跳过,可显式包含', () => {
  const { store } = freshStore()
  const scope = 'project:skip'
  const normal = save(store, scope, '普通记录')
  const dormant = save(store, scope, '休眠记录', { importance: 0.1 })
  ageRecord(store, dormant, 40 * DAY_MS)
  markDormant(store)
  const gone = save(store, scope, '软删记录')
  tombstone(store, gone.id)

  assert.equal(shouldSkipRecord(store.findById(normal.id)!), false)
  assert.equal(shouldSkipRecord(store.findById(dormant.id)!), true)
  assert.equal(shouldSkipRecord(store.findById(dormant.id)!, { includeDormant: true }), false)
  const goneNow = store.findById(gone.id)!
  assert.equal(shouldSkipRecord(goneNow), true)
  assert.equal(shouldSkipRecord(goneNow, { includeTombstoned: true }), false)
})

test('revive:清除休眠标记并刷新访问时间;tombstone 记录不能靠 revive 复活', () => {
  const { store } = freshStore()
  const scope = 'project:revive'
  const dormant = save(store, scope, '休眠中的记录', { importance: 0.1 })
  ageRecord(store, dormant, 40 * DAY_MS)
  markDormant(store)

  const now = Date.now()
  const result = revive(store, dormant.id, { now })
  assert.equal(result.ok, true)
  assert.equal(isDormantRecord(store.findById(dormant.id)!), false)
  assert.equal(store.findById(dormant.id)!.lastAccessedAt, now)
  assert.deepEqual(revive(store, dormant.id), { ok: false, reason: 'not-dormant' })
  assert.deepEqual(revive(store, '不存在'), { ok: false, reason: 'not-found' })

  const gone = save(store, scope, '软删中的记录', { importance: 0.1 })
  ageRecord(store, gone, 40 * DAY_MS)
  markDormant(store)
  tombstone(store, gone.id)
  assert.deepEqual(revive(store, gone.id), { ok: false, reason: 'tombstoned' })
})

test('tombstone:软删不删数据、可持久化、重复调用幂等', () => {
  const { dir, store } = freshStore('dsh-cog-tomb-')
  const scope = 'project:tomb'
  const record = save(store, scope, '要 forget 的记录')
  const now = Date.now()
  const result = tombstone(store, record.id, { now, reason: 'user forget' })
  assert.equal(result.ok, true)
  assert.equal(store.scope(scope).records.size, 1, '软删后记录仍在 scope 里,等 restore/purge')
  const tombstoned = store.findById(record.id)!
  assert.equal(isTombstonedRecord(tombstoned), true)
  assert.equal((tombstoned as unknown as { tombstoneExpiresAt: number }).tombstoneExpiresAt, now + 30 * DAY_MS)
  assert.equal((tombstoned as unknown as { tombstoneReason: string }).tombstoneReason, 'user forget')
  assert.equal(shouldSkipRecord(tombstoned), true)

  const again = tombstone(store, record.id)
  assert.equal(again.reason, 'already-tombstoned')
  assert.deepEqual(tombstone(store, '不存在'), { ok: false, reason: 'not-found' })

  store.close()
  const reopened = new MemoryStore(dir)
  reopened.loadDiscovered()
  const reloaded = reopened.findById(record.id)!
  assert.equal(isTombstonedRecord(reloaded), true, '软删标记落盘并在重开后读回')
  assert.equal((reloaded as unknown as { tombstoneExpiresAt: number }).tombstoneExpiresAt, now + 30 * DAY_MS)
  reopened.close()
})

test('restore:窗口内可恢复;过期/被新版本取代默认拒绝,force 可强恢复', () => {
  const { store } = freshStore()
  const scope = 'project:restore'
  const record = save(store, scope, '被 forget 的记录')
  const now = Date.now()
  tombstone(store, record.id, { now })

  // 未过窗口 → 恢复成功,标记清干净
  const restored = restore(store, record.id, { now: now + 1_000 })
  assert.equal(restored.ok, true)
  assert.equal(isTombstonedRecord(store.findById(record.id)!), false)
  assert.equal(shouldSkipRecord(store.findById(record.id)!), false)
  assert.equal((store.findById(record.id) as unknown as { restoredAt: number }).restoredAt, now + 1_000)
  assert.deepEqual(restore(store, record.id), { ok: false, reason: 'not-tombstoned' })
  assert.deepEqual(restore(store, '不存在'), { ok: false, reason: 'not-found' })

  // 过了保留窗口 → 默认拒绝(force 可救)
  const expired = save(store, scope, '过期软删记录')
  tombstone(store, expired.id, { now })
  const afterWindow = now + 31 * DAY_MS
  assert.deepEqual(restore(store, expired.id, { now: afterWindow }), { ok: false, reason: 'expired' })
  assert.equal(restore(store, expired.id, { now: afterWindow, force: true }).ok, true)

  // 已有活动版本取代 → 默认拒绝,避免出现两个活动版本
  const oldVersion = save(store, scope, '被取代后又软删的旧版本')
  tombstone(store, oldVersion.id, { now })
  const newVersion = save(store, scope, '取代它的新版本', { supersedes: oldVersion.id })
  assert.deepEqual(restore(store, oldVersion.id, { now: now + 1_000 }), { ok: false, reason: 'superseded' })
  assert.equal(restore(store, oldVersion.id, { now: now + 1_000, force: true }).ok, true)
  assert.equal(isTombstonedRecord(store.findById(newVersion.id)!), false)
})

test('purgeTombstones:只清过窗口的软删记录,force 清全部', () => {
  const { store } = freshStore()
  const scope = 'project:purge'
  const now = Date.now()
  const fresh = save(store, scope, '刚软删的记录')
  const old = save(store, scope, '软删很久的记录')
  const alive = save(store, scope, '正常记录')
  tombstone(store, fresh.id, { now })
  tombstone(store, old.id, { now: now - 31 * DAY_MS })

  const removed = purgeTombstones(store, { now })
  assert.deepEqual(removed, [old.id])
  assert.equal(store.findById(old.id), undefined, '过期软删被物理删除')
  assert.notEqual(store.findById(fresh.id), undefined, '窗口内的保留')
  assert.notEqual(store.findById(alive.id), undefined)

  const forced = purgeTombstones(store, { now, force: true })
  assert.deepEqual(forced, [fresh.id])
  assert.equal(store.scope(scope).records.size, 1)
})

test('tombstone 的记录不会被"同内容重写"复活', () => {
  const { store } = freshStore()
  const scope = 'project:resurrect'
  const record = save(store, scope, '同一段内容')
  tombstone(store, record.id)
  const again = store.save({ scope, kind: 'note', content: '同一段内容' } as SaveInput, DEFAULTS)
  assert.equal(again.deduped, false, '软删记录不参与同内容去重')
  assert.notEqual(again.record.id, record.id, '必须生成新记录,不能悄悄复用 tombstone')
  assert.equal(store.scope(scope).records.size, 2)
})

test('snapshot:gzip 魔数 + meta 行,可按 scope 导出,默认导出全部', () => {
  const { dir, store } = freshStore('dsh-cog-snap-')
  const scopeA = 'project:snap-a'
  const scopeB = 'project:snap-b'
  save(store, 'global', '全局记录')
  const a = save(store, scopeA, 'A 记录')
  save(store, scopeB, 'B 记录')
  store.flush()

  const fileA = join(dir, 'snap-a.jsonl.gz')
  const onlyA = snapshot(store, fileA, { scopes: [scopeA] })
  assert.equal(onlyA.records, 1)
  assert.deepEqual(onlyA.scopes, [scopeA])
  assert.equal(onlyA.gzipped, true)
  assert.ok(onlyA.bytes > 0)
  const raw = readFileSync(fileA)
  assert.equal(raw[0], 0x1f)
  assert.equal(raw[1], 0x8b, '快照默认是 gzip')
  const lines = gunzipSync(raw).toString('utf8').trim().split('\n')
  assert.equal(lines.length, 2, 'meta 行 + 1 条记录')
  const meta = JSON.parse(lines[0]!)
  assert.equal(meta['#snapshot'], SNAPSHOT_SCHEMA)
  assert.equal(meta.records, 1)
  assert.deepEqual(meta.scopes, [scopeA])
  assert.equal(JSON.parse(lines[1]!).id, a.id)

  const fileAll = join(dir, 'snap-all.jsonl.gz')
  const all = snapshot(store, fileAll)
  assert.equal(all.records, 3)
  assert.deepEqual([...all.scopes].sort(), ['global', scopeA, scopeB].sort())
})

test('snapshot:默认不含软删记录,includeTombstoned 可带上', () => {
  const { dir, store } = freshStore('dsh-cog-snap-tomb-')
  const scope = 'project:snap-tomb'
  save(store, scope, '正常记录')
  const gone = save(store, scope, '软删记录')
  tombstone(store, gone.id)
  store.flush()

  const without = snapshot(store, join(dir, 'without.jsonl.gz'), { scopes: [scope] })
  assert.equal(without.records, 1)
  const withGone = snapshot(store, join(dir, 'with.jsonl.gz'), { scopes: [scope], includeTombstoned: true })
  assert.equal(withGone.records, 2)
})

test('snapshot 往返:新目录 restore 后 id/内容/认知字段保留,gzip/纯 JSONL 都能读', () => {
  const { dir, store } = freshStore('dsh-cog-roundtrip-')
  const scope = 'project:rt'
  const v1 = save(store, scope, '第一版正文', { tags: ['tag1'], importance: 0.4 })
  const v2 = save(store, scope, '第二版正文', { supersedes: v1.id, importance: 0.6, tags: ['tag1'] })
  const conflicted = save(store, scope, '带冲突标记的正文', { conflictWith: [v2.id], conflictConfidence: 0.8 })
  store.flush()

  const gzFile = join(dir, 'rt.jsonl.gz')
  snapshot(store, gzFile, { scopes: [scope] })
  const plainFile = join(dir, 'rt.jsonl')
  snapshot(store, plainFile, { scopes: [scope], gzip: false })
  assert.notEqual(readFileSync(plainFile)[0], 0x1f, 'gzip:false 写出纯 JSONL')

  for (const file of [gzFile, plainFile]) {
    const { dir: targetDir, store: target } = freshStore('dsh-cog-roundtrip-target-')
    assert.notEqual(targetDir, dir)
    const result = restoreSnapshot(target, file)
    assert.equal(result.imported, 3)
    assert.deepEqual(result.scopes, [scope])
    assert.equal(target.scope(scope).records.size, 3)

    const restoredV2 = target.findById(v2.id)!
    assert.equal(restoredV2.content, '第二版正文')
    assert.equal(restoredV2.supersedes, v1.id)
    assert.deepEqual([...restoredV2.tags], ['tag1'])
    assert.equal((restoredV2 as unknown as { generation: number }).generation, 2)
    const restoredConflict = target.findById(conflicted.id)!
    assert.deepEqual((restoredConflict as unknown as { conflictWith: string[] }).conflictWith, [v2.id])
    assert.equal((restoredConflict as unknown as { conflictConfidence: number }).conflictConfidence, 0.8)
    assert.deepEqual(target.lineage(v2.id)!.entries.map((entry) => entry.id), [v1.id, v2.id])
    target.close()

    // 再导一遍:已存在 id 全部跳过(幂等)
    const again = restoreSnapshot(target, file)
    assert.deepEqual(again, { imported: 0, skipped: 3, scopes: [] })
  }
})

test('restoreSnapshot:同内容去重 / overwrite 覆盖 / targetScope 重定向', () => {
  const { dir, store } = freshStore('dsh-cog-restore-opts-')
  const scope = 'project:ro'
  const original = save(store, scope, '原始正文')
  store.flush()
  const file = join(dir, 'ro.jsonl.gz')
  snapshot(store, file, { scopes: [scope] })

  // 目标目录里已有同内容(不同 id)的记录 → 默认按内容去重跳过
  const { store: dedupeTarget } = freshStore('dsh-cog-restore-dedupe-')
  save(dedupeTarget, scope, '原始正文')
  const deduped = restoreSnapshot(dedupeTarget, file)
  assert.deepEqual(deduped, { imported: 0, skipped: 1, scopes: [] })
  assert.equal(dedupeTarget.scope(scope).records.size, 1)

  // id 相同、内容被改过 → overwrite=true 覆盖回快照内容
  const { store: overwriteTarget } = freshStore('dsh-cog-restore-overwrite-')
  restoreSnapshot(overwriteTarget, file)
  const scopeStore = overwriteTarget.scope(scope)
  scopeStore.insert({ ...scopeStore.records.get(original.id)!, content: '被本地改坏' })
  const skipped = restoreSnapshot(overwriteTarget, file)
  assert.equal(skipped.imported, 0, '默认不覆盖已存在 id')
  assert.equal(scopeStore.records.get(original.id)!.content, '被本地改坏')
  const overwritten = restoreSnapshot(overwriteTarget, file, { overwrite: true })
  assert.equal(overwritten.imported, 1)
  assert.equal(scopeStore.records.get(original.id)!.content, '原始正文')

  // targetScope:全部导入到指定作用域(跨机器重建)
  const { store: remapTarget } = freshStore('dsh-cog-restore-remap-')
  const remapped = restoreSnapshot(remapTarget, file, { targetScope: 'project:imported' })
  assert.deepEqual(remapped, { imported: 1, skipped: 0, scopes: ['project:imported'] })
  assert.equal(remapTarget.scope('project:imported').records.size, 1)
  assert.equal(remapTarget.scope('project:imported').records.get(original.id)!.scope, 'project:imported')
})

test('restoreSnapshot:坏行跳过、高版本 schema 拒绝', () => {
  const { dir, store } = freshStore('dsh-cog-restore-bad-')
  const scope = 'project:bad'
  const record = save(store, scope, '正常记录')
  store.flush()

  const file = join(dir, 'bad.jsonl')
  const meta = JSON.stringify({ '#snapshot': SNAPSHOT_SCHEMA, createdAt: Date.now(), scopes: [scope], records: 1 })
  const good = JSON.stringify(JSON.parse(JSON.stringify(record)))
  writeFileSync(file, `${meta}\n这不是 JSON\n{"id":"x"}\n${good}\n`, 'utf8')

  const { store: target } = freshStore('dsh-cog-restore-bad-target-')
  const result = restoreSnapshot(target, file)
  assert.equal(result.imported, 1, '坏行跳过,好行照导')
  assert.equal(result.skipped, 2)

  const future = join(dir, 'future.jsonl.gz')
  writeFileSync(future, gzipSync(Buffer.from(`${JSON.stringify({ '#snapshot': 99 })}\n`, 'utf8')))
  const { store: target2 } = freshStore('dsh-cog-restore-future-')
  assert.throws(() => restoreSnapshot(target2, future), /schema/)
})

test('快照文件路径不存在时抛错,不静默成功', () => {
  const { store } = freshStore()
  assert.throws(() => restoreSnapshot(store, '/definitely/not/exists/snap.jsonl.gz'))
  assert.equal(existsSync('/definitely/not/exists/snap.jsonl.gz'), false)
})
