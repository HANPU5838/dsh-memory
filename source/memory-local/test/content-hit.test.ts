/**
 * 0.62.7：词法准入必须命中"内容词"。
 *
 * 事故：`hasStrongHit` 把任何 ≥2 字重叠都当强命中，于是「怎么办」「怎么减肥」
 * 这类查询会命中正文里带「怎么」的记忆 —— 实测「怎么办」返回 3 条无关记忆，
 * 「怎么减肥」命中了含「怎么输出」的沟通偏好。功能词重叠不是相关性证据：
 * 词法通道只认实义，语义相关交给向量通道。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasContentHit, isGenericCjkToken, tokenize } from '../src/scoring.ts'
import { LocalMemoryService } from '../src/index.ts'

const SCOPE = 'project:/w'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-mem-content-'))
}

test('功能词判定：通用词是功能词，实义词不是', () => {
  for (const token of ['怎么', '什么', '多少', '为什么', '这个', '怎么办']) {
    assert.equal(isGenericCjkToken(token), true, `${token} 应判为功能词`)
  }
  for (const token of ['存储', '语音', '磁盘', '作用域', 'dsh', 'storage', 'v0.62']) {
    assert.equal(isGenericCjkToken(token), false, `${token} 应判为内容词`)
  }
})

test('内容词命中：只有「怎么」重叠不算命中，有「存储」重叠才算', () => {
  const query = tokenize('怎么减肥')
  const genericDoc = new Set(tokenize('怎么输出内容'))
  assert.equal(hasContentHit(query, genericDoc), false, '「怎么」是功能词，不构成命中')

  const storageQuery = tokenize('手机还剩多少存储空间')
  const storageDoc = new Set(tokenize('运行环境：460GB 存储'))
  assert.equal(hasContentHit(storageQuery, storageDoc), true, '「存储」是内容词，构成命中')
})

test('集成：通用词查询不再命中无关记忆', async () => {
  const dir = tempDir()
  const svc = new LocalMemoryService({
    storeDir: join(dir, 'store'),
    scopes: { global: true, project: true },
    retrieval: { bm25: { enabled: false }, fusion: { enabled: false } },
  })
  svc.setProjectScope(SCOPE)
  try {
    await svc.save({
      scope: SCOPE,
      kind: 'preference',
      content: '用户偏好：结论直接写在回复里，不要写说明文档。怎么输出都行，别落盘。',
    })
    for (const query of ['怎么办', '怎么减肥']) {
      const hits = await svc.search({ text: query, scope: SCOPE, topK: 5 })
      assert.equal(hits.length, 0, `「${query}」只有功能词重叠，不应命中任何记忆`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('集成：实义词查询照常命中（没有误伤）', async () => {
  const dir = tempDir()
  const svc = new LocalMemoryService({
    storeDir: join(dir, 'store'),
    scopes: { global: true, project: true },
    retrieval: { bm25: { enabled: false }, fusion: { enabled: false } },
  })
  svc.setProjectScope(SCOPE)
  try {
    const rec = await svc.save({
      scope: SCOPE,
      kind: 'fact',
      content: '本机可用存储空间还有 402G。',
    })
    const hits = await svc.search({ text: '存储空间还剩多少', scope: SCOPE, topK: 5 })
    assert.equal(hits.length, 1, '「存储空间」是实义词，必须照常命中')
    assert.equal(hits[0]!.record.id, rec.id)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
