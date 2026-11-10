/**
 * 0.34.0：**全链路不变量测试**。
 *
 * 目的不是测某个函数，而是锁住"同一条记录在所有消费路径上的可见性必须一致"。
 * 之前踩过的坑：search 修好了过滤，但注入用的 listSync 没修 → 删掉的规则继续注入。
 * 这组用例一旦失败，说明某条路径又各自写了一套判定。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService } from '../src/index.ts'
import { recordInvisibility } from '../src/cognitive/lifecycle.ts'

const SCOPE = 'project:/invariants'

function makeService(dir: string) {
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true, project: true } })
  svc.setProjectScope(SCOPE)
  return svc
}

/** 造出五种状态的记录：可见 / 休眠 / 软删 / 过期 / 失效。 */
async function seed(svc: LocalMemoryService) {
  const now = Date.now()
  const visible = await svc.save({ scope: SCOPE, kind: 'note', content: '不变量 alpha 可见' })
  const dormant = await svc.save({ scope: SCOPE, kind: 'note', content: '不变量 alpha 休眠' })
  const tomb = await svc.save({ scope: SCOPE, kind: 'note', content: '不变量 alpha 软删' })
  const expired = await svc.save({ scope: SCOPE, kind: 'state', content: '不变量 alpha 过期', ttlMs: 1 } as never)
  const invalid = await svc.save({ scope: SCOPE, kind: 'fact', content: '不变量 alpha 失效' })
  const store = svc.store.peek(SCOPE)!
  ;(store.records.get(dormant.id) as { dormantAt?: number }).dormantAt = now - 60_000
  await svc.forget({ id: tomb.id })
  svc.store.updateMetrics(expired.id, {})
  ;(store.records.get(expired.id) as { expiredAt?: number }).expiredAt = now - 1000
  svc.store.updateMetrics(invalid.id, { validUntil: now - 1000 })
  return { visible, dormant, tomb, expired, invalid }
}

/** 读路径：默认可见集合必须完全一致（list 是异步、listSync 是同步）。 */
async function visibleIdsByPath(svc: LocalMemoryService): Promise<Record<string, string[]>> {
  const list = (await svc.list({ scope: SCOPE })).map((r) => r.id).sort()
  const listSync = svc.listSync({ scopes: [SCOPE] }).map((r) => r.id).sort()
  return { list, listSync }
}

test('不变量：可见性判定是单一事实来源（四种状态各归其位）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-invariant-vis-'))
  const svc = makeService(dir)
  try {
    const seeded = await seed(svc)
    const now = Date.now()
    const store = svc.store.peek(SCOPE)!
    assert.equal(recordInvisibility(store.records.get(seeded.visible.id)!, { now }), undefined)
    assert.equal(recordInvisibility(store.records.get(seeded.dormant.id)!, { now }), 'dormant')
    assert.equal(recordInvisibility(store.records.get(seeded.tomb.id)!, { now }), 'tombstoned')
    assert.equal(recordInvisibility(store.records.get(seeded.expired.id)!, { now }), 'expired')
    assert.equal(recordInvisibility(store.records.get(seeded.invalid.id)!, { now }), 'invalid')
    // include 全开 → 全部可见（面板历史浏览语义）
    for (const rec of store.records.values()) {
      assert.equal(recordInvisibility(rec, { now, includeDormant: true, includeTombstoned: true, includeExpired: true }), undefined)
    }
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('不变量：默认读路径（list / listSync / search）返回同一批可见记录', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-invariant-paths-'))
  const svc = makeService(dir)
  try {
    const seeded = await seed(svc)
    const byPath = await visibleIdsByPath(svc)
    assert.deepEqual(byPath.list, [seeded.visible.id].sort(), 'list 只返回可见记录')
    assert.deepEqual(byPath.listSync, byPath.list, 'listSync 必须与 list 一致（否则注入路径漏过滤）')
    const hits = await svc.search({ text: '不变量 alpha', scope: SCOPE, topK: 10 })
    assert.deepEqual(hits.map((h) => h.record.id).sort(), byPath.list, 'search 与 list 一致')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('不变量：所有写路径都产出规范 scope（工具/面板/导入口径一致）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-invariant-write-'))
  const svc = makeService(dir)
  try {
    const viaSave = await svc.save({ scope: SCOPE, kind: 'note', content: '写路径 A' })
    const viaPanel = await svc.createRecord({ scope: SCOPE, kind: 'note', content: '写路径 B' })
    const imported = await svc.importRecords({ records: [{ scope: SCOPE, kind: 'note', content: '写路径 C' }] })
    assert.equal(viaSave.scope, SCOPE)
    assert.equal(viaPanel.scope, SCOPE)
    assert.equal(imported.imported, 1)
    const scopes = new Set((await svc.list({ scope: SCOPE })).map((r) => r.scope))
    assert.deepEqual([...scopes], [SCOPE], '不能写出第二个 project scope')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('不变量：删除→恢复→再删除 的往返状态一致', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-invariant-roundtrip-'))
  const svc = makeService(dir)
  try {
    const rec = await svc.save({ scope: SCOPE, kind: 'note', content: '往返测试 alpha' })
    assert.equal((await svc.list({ scope: SCOPE })).length, 1)
    await svc.forget({ id: rec.id })
    assert.equal((await svc.list({ scope: SCOPE })).length, 0)
    assert.equal((await svc.search({ text: '往返测试', scope: SCOPE })).length, 0)
    assert.equal(svc.restoreRecord(rec.id).restored, true)
    assert.equal((await svc.list({ scope: SCOPE })).length, 1)
    assert.equal((await svc.search({ text: '往返测试', scope: SCOPE })).length, 1)
    await svc.forget({ id: rec.id })
    assert.equal((await svc.search({ text: '往返测试', scope: SCOPE })).length, 0)
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('不变量：配置矩阵（强度排序/时间权重/整形/巩固 开与关）都不崩且可见性一致', async () => {
  const configs = [
    {},
    { retrieval: { strengthRanking: false, temporalWeighting: false, mmr: false, dedupeThreshold: 0, finalFloor: 0 } },
    { cognitive: { consolidation: { enabled: false }, merge: { enabled: false }, conflict: { enabled: false } } },
  ]
  for (const config of configs) {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-invariant-config-'))
    const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true, project: true }, ...config })
    svc.setProjectScope(SCOPE)
    try {
      const rec = await svc.save({ scope: SCOPE, kind: 'note', content: '配置矩阵 alpha' })
      assert.equal((await svc.list({ scope: SCOPE })).length, 1)
      assert.equal((await svc.search({ text: '配置矩阵', scope: SCOPE, topK: 5 })).length, 1)
      assert.ok(svc.listSync({ scopes: [SCOPE] }).some((r) => r.id === rec.id))
      svc.runHousekeeping()
      assert.ok((await svc.list({ scope: SCOPE })).some((r) => r.id === rec.id), '维护后可见记录仍在')
    } finally {
      svc.flushSync()
      rmSync(dir, { recursive: true, force: true })
    }
  }
})
