/**
 * 0.111.0：双时态检索（asOf）—— 回答「当时我相信什么」。
 * - 修正版创建之前：旧版本仍可见，新版本不可见；
 * - 当前：新版本可见，旧版本已退役；
 * - validUntil 过期后：该记录不再属于那个时刻。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService } from '../src/index.ts'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('0.111.0：asOf 早于修正版时返回旧版本，当前视角返回新版本', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-asof-'))
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true }, retrieval: { vector: { enabled: false } } })
  try {
    const oldRec = await svc.save({ scope: 'global', kind: 'fact', content: '服务端口是 8080，不要改' })
    await sleep(10)
    const revised = await svc.save({ scope: 'global', kind: 'fact', content: '服务端口改为 9090', supersedes: oldRec.id })
    const between = oldRec.createdAt + 5 < revised.createdAt ? oldRec.createdAt + 5 : oldRec.createdAt + 1

    const past = await svc.search({ text: '服务端口', asOf: between } as never)
    const pastIds = past.map((hit) => hit.record.id)
    assert.ok(pastIds.includes(oldRec.id), '当时旧版本应可见')
    assert.ok(!pastIds.includes(revised.id), '修正版还没创建，不应出现')

    const present = await svc.search({ text: '服务端口' } as never)
    const presentIds = present.map((hit) => hit.record.id)
    assert.ok(presentIds.includes(revised.id), '当前新版本应可见')
    assert.ok(!presentIds.includes(oldRec.id), '当前旧版本应已退役')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.111.0：asOf 尊重 validUntil（事实有效期）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-asof-valid-'))
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true }, retrieval: { vector: { enabled: false } } })
  try {
    const rec = await svc.save({ scope: 'global', kind: 'fact', content: '限时活动：本周免运费' })
    const until = rec.createdAt + 60_000
    svc.store.updateMetrics(rec.id, { validUntil: until })
    const before = await svc.search({ text: '限时活动', asOf: until - 10 } as never)
    assert.ok(before.some((hit) => hit.record.id === rec.id), '有效期内应可见')
    const after = await svc.search({ text: '限时活动', asOf: until + 10 } as never)
    assert.ok(!after.some((hit) => hit.record.id === rec.id), '有效期后不应属于该时刻')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.111.0：asOf 早于软删时记录仍可见', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-asof-tombstone-'))
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true }, retrieval: { vector: { enabled: false } } })
  try {
    const rec = await svc.save({ scope: 'global', kind: 'note', content: '一条后来被删掉的笔记' })
    const beforeForget = Date.now()
    await sleep(5)
    await svc.forget({ id: rec.id })
    const past = await svc.search({ text: '后来被删掉', asOf: beforeForget + 1 } as never)
    assert.ok(past.some((hit) => hit.record.id === rec.id), '软删之前应可见')
    const present = await svc.search({ text: '后来被删掉' } as never)
    assert.ok(!present.some((hit) => hit.record.id === rec.id), '软删之后当前不可见')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})
