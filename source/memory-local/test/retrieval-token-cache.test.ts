/**
 * 0.91.0：检索分词/实体缓存 —— 重复查询结果稳定，新增/删除记录立即可见（缓存不挡写路径）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService } from '../src/index.ts'

function open(dir: string) {
  return new LocalMemoryService({ storeDir: dir, scopes: { global: true }, retrieval: { vector: { enabled: false } } })
}

test('0.91.0：分词缓存不改变重复查询结果，且新增/删除记录立即可见', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-token-cache-'))
  const svc = open(dir)
  try {
    const alpha = await svc.save({ scope: 'global', kind: 'fact', content: 'alpha 部署 /srv/alpha 端口 9001' })
    const first = await svc.search({ text: 'alpha 部署', topK: 5 })
    assert.ok(first.some((hit) => hit.record.id === alpha.id))
    const again = await svc.search({ text: 'alpha 部署', topK: 5 })
    assert.deepEqual(again.map((hit) => hit.record.id), first.map((hit) => hit.record.id))

    const gamma = await svc.save({ scope: 'global', kind: 'fact', content: 'gamma 备份 /srv/gamma 端口 9002' })
    const gammaHits = await svc.search({ text: 'gamma 备份', topK: 5 })
    assert.ok(gammaHits.some((hit) => hit.record.id === gamma.id), '新增记录必须命中')

    await svc.forget({ id: alpha.id })
    const afterForget = await svc.search({ text: 'alpha 部署', topK: 5 })
    assert.ok(!afterForget.some((hit) => hit.record.id === alpha.id), '删除记录必须消失')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})
