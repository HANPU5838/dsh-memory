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
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasContentHit, isGenericCjkToken, isGenericOnlyQuery, tokenize } from '../src/scoring.ts'
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

/** 假嵌入服务：对任何输入都返回同一段高相似向量（把向量通道开成"必定放行"）。 */
async function startEmbedServer() {
  const vector = new Array<number>(1024).fill(0)
  vector[0] = 1
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ embedding: vector }] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0
  return {
    url: `http://127.0.0.1:${port}/v1/embeddings`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

function vectorService(dir: string, endpoint: string) {
  const svc = new LocalMemoryService({
    storeDir: join(dir, 'store'),
    scopes: { global: true, project: true },
    retrieval: {
      vector: { endpoint, model: 'bge-m3', dims: 1024, timeoutMs: 3000, spawn: { enabled: false } },
    },
  })
  svc.setProjectScope(SCOPE)
  return svc
}

test('0.62.8：整条查询没有内容词时，语义通道也不参与（向量相似度再高也不放行）', async () => {
  const dir = tempDir()
  const embed = await startEmbedServer()
  const svc = vectorService(dir, embed.url)
  try {
    await svc.save({ scope: SCOPE, kind: 'preference', content: '用户偏好：结论直接写在回复里，怎么输出都行。' })
    // 假服务让向量相似度恒为 1.0；如果没这道门禁，「怎么办」一定会命中。
    const hits = await svc.search({ text: '怎么办', scope: SCOPE, topK: 5 })
    assert.equal(hits.length, 0, '没有实义的查询不该命中任何记忆')
  } finally {
    await embed.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.62.8：有内容词的查询照常走语义通道', async () => {
  const dir = tempDir()
  const embed = await startEmbedServer()
  const svc = vectorService(dir, embed.url)
  try {
    const rec = await svc.save({ scope: SCOPE, kind: 'fact', content: '本机磁盘还有 402G。' })
    const hits = await svc.search({ text: '磁盘', scope: SCOPE, topK: 5 })
    assert.equal(hits.length, 1, '「磁盘」是内容词，语义通道应正常放行')
    assert.equal(hits[0]!.record.id, rec.id)
  } finally {
    await embed.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.62.9：纯功能词判定——空分词（其它语种）与单字实义词都不算纯功能词', () => {
  assert.equal(isGenericOnlyQuery([]), false, '分词为空（韩/泰/阿/俄…）必须放行语义通道')
  assert.equal(isGenericOnlyQuery(['怎', '么', '办']), true, '「怎么办」全部是功能词')
  assert.equal(isGenericOnlyQuery(['怎', '么', '存储']), false, '含实义词就不算纯功能词')
  assert.equal(isGenericOnlyQuery(tokenize('怎么办')), true, '「怎么办」只由功能词组成')
  assert.equal(isGenericOnlyQuery(tokenize('为什么')), true)
  assert.equal(isGenericOnlyQuery(tokenize('盘')), false, '单字实义词要放行')
  assert.equal(isGenericOnlyQuery(tokenize('이 기기의 남은 저장 공간은')), false, '韩语分词为空 → 放行')
})

test('0.62.9：韩语查询仍走语义通道（0.62.8 的回归已修复）', async () => {
  const dir = tempDir()
  const embed = await startEmbedServer()
  const svc = vectorService(dir, embed.url)
  try {
    const rec = await svc.save({ scope: SCOPE, kind: 'fact', content: '本机存储空间还有 402G。' })
    const hits = await svc.search({ text: '이 기기의 남은 저장 공간은 얼마나 되나요', scope: SCOPE, topK: 5 })
    assert.equal(hits.length, 1, '非中英语种查询必须仍然可以走语义通道')
    assert.equal(hits[0]!.record.id, rec.id)
  } finally {
    await embed.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.62.9：中文纯功能词查询仍被短路（回归修复没有回退 0.62.8 的行为）', async () => {
  const dir = tempDir()
  const embed = await startEmbedServer()
  const svc = vectorService(dir, embed.url)
  try {
    await svc.save({ scope: SCOPE, kind: 'preference', content: '用户偏好：结论直接写在回复里，怎么输出都行。' })
    for (const query of ['怎么办', '为什么', '这个怎么弄']) {
      const hits = await svc.search({ text: query, scope: SCOPE, topK: 5 })
      assert.equal(hits.length, 0, `「${query}」仍必须返回空`)
    }
  } finally {
    await embed.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
