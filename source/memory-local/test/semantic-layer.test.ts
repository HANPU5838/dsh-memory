/**
 * 0.75.0：语义层偏好 —— 巩固产物（tag=consolidated）的终态分乘 (1+boost)。
 *
 * 说明：consolidated 标签本身会被词法/BM25 计入文档长度，因此同内容记录的原始相关度
 * 并不完全相等；测试用「关闭 boost」与「加大 boost」两种配置对比同一对记录，
 * 验证偏好因子确实改变了排序，而不是缩窄到某个具体分数。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService } from '../src/index.ts'

async function seed(svc) {
  const normal = await svc.save({ scope: 'global', kind: 'note', content: '端口 8080 内部服务' })
  const semantic = await svc.save({ scope: 'global', kind: 'note', content: '8080 内部服务 端口', tags: ['consolidated'] })
  return { normal, semantic }
}

async function order(boost) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-semantic-layer-'))
  const svc = new LocalMemoryService({
    storeDir: dir,
    scopes: { global: true },
    retrieval: { semanticLayerBoost: boost },
  })
  try {
    const { normal, semantic } = await seed(svc)
    const hits = await svc.search({ text: '端口 8080', topK: 5 })
    const ids = hits.map((hit) => hit.record.id)
    return { ids, normal: normal.id, semantic: semantic.id }
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('0.75.0：boost=0 时按原始终态分排序（巩固标记不额外加权）', async () => {
  const { ids, normal, semantic } = await order(0)
  assert.ok(ids.includes(normal) && ids.includes(semantic))
  assert.ok(ids.indexOf(normal) < ids.indexOf(semantic), `关闭偏好后短正文的普通记录应排前（实际 ${ids.join(',')}）`)
})

test('0.75.0：boost=0.2 时巩固产物反超同内容普通记录（偏好因子生效且可配）', async () => {
  const { ids, normal, semantic } = await order(0.2)
  assert.ok(ids.indexOf(semantic) < ids.indexOf(normal), `语义层偏好应让 consolidated 排前（实际 ${ids.join(',')}）`)
})
