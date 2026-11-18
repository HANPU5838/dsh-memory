/**
 * 0.80.0：词法伪相关反馈（BM25 PRF）集成测试。
 *
 * 场景：查询词 phN 只出现在 A；B 与 A 共享 deployN.sh，但完全不包含查询词 ——
 * 词法/无向量时 B 不可达。PRF 从首轮 top 文档 A 的措辞里选出 deployN.sh 做二次检索。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService } from '../src/index.ts'

async function seedAndSearch(enabled) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-prf-'))
  const svc = new LocalMemoryService({
    storeDir: dir,
    scopes: { global: true, project: true },
    retrieval: { vector: { enabled: false }, lexicalPrf: { enabled } },
  })
  try {
    const ids = {}
    for (let i = 0; i < 6; i++) {
      ids[`a${i}`] = (await svc.save({ scope: 'global', kind: 'note', content: `ph${i} 发布流程：先跑 deploy${i}.sh，失败看日志` })).id
      ids[`b${i}`] = (await svc.save({ scope: 'global', kind: 'note', content: `deploy${i}.sh 支持 --dry-run 预演，避免线上问题` })).id
    }
    let recalled = 0
    for (let i = 0; i < 6; i++) {
      const hits = await svc.search({ text: `ph${i}`, topK: 5 })
      if (hits.some((hit) => hit.record.id === ids[`b${i}`])) recalled += 1
    }
    return { recalled, total: 6 }
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('0.80.0：PRF 关闭时词法够不着的记录不被召回', async () => {
  const { recalled } = await seedAndSearch(false)
  assert.equal(recalled, 0, '关闭 PRF 时只靠查询词无法召回 B')
})

test('0.80.0：PRF 开启后用记忆措辞补全查询，召回 6/6', async () => {
  const { recalled } = await seedAndSearch(true)
  assert.equal(recalled, 6, `PRF 应能召回全部桥接记录（实际 ${recalled}/6）`)
})
