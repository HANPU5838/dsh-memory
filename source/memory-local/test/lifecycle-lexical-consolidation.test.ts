/**
 * 0.88.0：无向量时的词法巩固（lifecycle 完整性）。
 *
 * 此前 `consolidateNow()` 直接跳过没有向量的作用域，而保存路径本来就去重完全相同正文，
 * 等于「纯词法部署永不巩固」。现在用 token Jaccard 做保守兜底。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService } from '../src/index.ts'
import { lexicalContentSimilarity } from '../src/cognitive/consolidate.ts'

function rec(content, extra = {}) {
  return { id: content, scope: 'global', kind: 'fact', content, tags: [], importance: 0.5, updatedAt: 100, ...extra }
}

test('0.88.0：lexicalContentSimilarity —— Dice 相似度，关键细节冲突为 0', () => {
  const a = rec('部署端口 8080 内部服务，注意防火墙放行')
  const b = rec('部署端口 8080 内部服务，注意防火墙放行，另外看日志')
  const c = rec('周末去买菜')
  assert.ok(lexicalContentSimilarity(a, b) >= 0.8, '高重叠记录应 ≥0.8')
  assert.ok(lexicalContentSimilarity(a, c) < 0.2)
  // 数字/路径不一致（互斥事实）不得参与巩固。
  assert.equal(lexicalContentSimilarity(rec('占用内存 10.4GB'), rec('占用内存 20GB')), 0)
  assert.equal(lexicalContentSimilarity(rec(''), rec('')), 0)
})

test('0.88.0：没有向量的作用域也会执行词法巩固', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lex-consolidate-'))
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true }, retrieval: { vector: { enabled: false } } })
  try {
    const a = await svc.save({ scope: 'global', kind: 'fact', content: '部署端口 8080 内部服务，注意防火墙放行' })
    const b = await svc.save({ scope: 'global', kind: 'fact', content: '部署端口 8080 内部服务，注意防火墙放行，另外看日志' })
    const c = await svc.save({ scope: 'global', kind: 'fact', content: '周末去买菜，顺便取快递' })
    const result = svc.consolidateNow()
    assert.equal(result.created.length, 1, '应产生一条巩固记录')
    assert.equal(result.merged, 1, '两条相似记录合并成一条')
    const created = svc.store.findById(result.created[0]!) as { consolidatedFrom?: string[]; tags?: string[]; content?: string }
    assert.ok(created !== undefined)
    assert.deepEqual([...(created.consolidatedFrom ?? [])].sort(), [a.id, b.id].sort())
    assert.ok((created.tags ?? []).includes('consolidated'))
    // 无关记录不应被合并进去。
    assert.ok(!(created.consolidatedFrom ?? []).includes(c.id))
    // 原记录保留（历史可查），不会被物理删除。
    assert.ok(svc.store.findById(a.id) !== undefined && svc.store.findById(b.id) !== undefined)
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.88.0：lexicalFallback=false 时回到精确聚类（不同正文不合并）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lex-off-'))
  const svc = new LocalMemoryService({
    storeDir: dir,
    scopes: { global: true },
    retrieval: { vector: { enabled: false } },
    cognitive: { consolidation: { lexicalFallback: false } },
  })
  try {
    await svc.save({ scope: 'global', kind: 'fact', content: '部署端口 8080 内部服务，注意防火墙放行' })
    await svc.save({ scope: 'global', kind: 'fact', content: '部署端口 8080 内部服务，注意防火墙放行，另外看日志' })
    const result = svc.consolidateNow()
    assert.equal(result.created.length, 0, '关闭词法兜底后不同正文不合并')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})
