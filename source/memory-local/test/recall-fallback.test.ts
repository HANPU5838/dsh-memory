/**
 * 0.62.3：总命中为空时的保底召回（recallFallback）。
 *
 * 真实事故（中文库 + bge-m3）：词法与向量两路准入门槛同时被擦线，整条漏召回。
 *   - '手机还剩多少存储空间' → 与目标记忆余弦 0.4995（minScore 0.5，差 0.0005）
 *     词法覆盖率 0.1066（自适应 floor 0.153）→ 两路都丢；
 *   - '磁盘剩余空间' → 余弦 0.4830，词法 0.0000 → 两路都丢。
 * 用户最后看到「没有找到相关记忆」，模型只能重新踩坑 —— 这正是记忆系统存在的意义
 * 反面。保底召回只在 0 结果时放宽一次，且仍要求越过噪声地板。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService } from '../src/index.ts'

const SCOPE = 'project:/w'
const DIMS = 1024

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-mem-fallback-'))
}

/** 假 OpenAI 兼容嵌入服务：按输入文本区分「查询」与「文档」，各返回固定向量。 */
async function startEmbedServer(queryMarker: string, queryVector: number[], docVector: number[]) {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const vector = body.includes(queryMarker) ? queryVector : docVector
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

/** 1024 维单位向量：与 [1,0,0…] 的余弦恰好等于 cos。 */
function unit(cos: number): number[] {
  const v = new Array<number>(DIMS).fill(0)
  v[0] = cos
  v[1] = Math.sqrt(Math.max(0, 1 - cos * cos))
  return v
}

function vectorService(dir: string, endpoint: string, fallback?: { enabled?: boolean }) {
  const svc = new LocalMemoryService({
    storeDir: join(dir, 'store'),
    scopes: { global: true, project: true },
    retrieval: {
      vector: {
        endpoint,
        model: 'bge-m3',
        dims: DIMS,
        timeoutMs: 3_000,
        // 本机装了托管运行时也绝不能在测试里拉起子进程。
        spawn: { enabled: false },
        ...(fallback !== undefined ? { recallFallback: fallback } : {}),
      },
      // 这两个用例只考察「准入门槛擦线」这一条路径，关掉 0.40 的 BM25/RRF。
      bm25: { enabled: false },
      fusion: { enabled: false },
    },
  })
  svc.setProjectScope(SCOPE)
  return svc
}

function lexicalService(dir: string, fallback?: { enabled?: boolean }) {
  const svc = new LocalMemoryService({
    storeDir: join(dir, 'store'),
    scopes: { global: true, project: true },
    retrieval: {
      ...(fallback !== undefined ? { vector: { recallFallback: fallback } } : {}),
      bm25: { enabled: false },
      fusion: { enabled: false },
    },
  })
  svc.setProjectScope(SCOPE)
  return svc
}

test('保底召回：余弦 0.4995 擦线 minScore(=0.5) 时仍能命中', async () => {
  const dir = tempDir()
  const embed = await startEmbedServer('手机还剩多少存储空间', unit(0.4995), unit(1))
  const svc = vectorService(dir, embed.url)
  try {
    const rec = await svc.save({ scope: SCOPE, kind: 'fact', content: '运行环境：460GB 存储' })
    svc.store.peek(SCOPE)!.vectors.set(rec.id, new Float32Array(unit(1)))

    const hits = await svc.search({ text: '手机还剩多少存储空间', scope: SCOPE, topK: 5 })
    assert.equal(hits.length, 1, '擦线的语义命中应当被保底召回捞回来')
    assert.equal(hits[0]!.record.id, rec.id)
  } finally {
    await embed.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('保底召回可关闭：同一场景关掉后维持旧行为（0 命中）', async () => {
  const dir = tempDir()
  const embed = await startEmbedServer('手机还剩多少存储空间', unit(0.4995), unit(1))
  const svc = vectorService(dir, embed.url, { enabled: false })
  try {
    const rec = await svc.save({ scope: SCOPE, kind: 'fact', content: '运行环境：460GB 存储' })
    svc.store.peek(SCOPE)!.vectors.set(rec.id, new Float32Array(unit(1)))

    const hits = await svc.search({ text: '手机还剩多少存储空间', scope: SCOPE, topK: 5 })
    assert.equal(hits.length, 0, '关闭后必须回到 0.62.2 的行为，便于回退')
  } finally {
    await embed.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('保底召回不越过噪声地板：余弦 0.40 的无关文本仍然不召回', async () => {
  const dir = tempDir()
  const embed = await startEmbedServer('kubernetes 集群滚动升级', unit(0.40), unit(1))
  const svc = vectorService(dir, embed.url)
  try {
    const rec = await svc.save({ scope: SCOPE, kind: 'fact', content: '完全无关的一条记录' })
    svc.store.peek(SCOPE)!.vectors.set(rec.id, new Float32Array(unit(1)))

    const hits = await svc.search({ text: 'kubernetes 集群滚动升级', scope: SCOPE, topK: 5 })
    assert.equal(hits.length, 0, '0.40 < 地板(0.45)，保底不能把噪声放进来')
  } finally {
    await embed.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('纯词法库的保底：长查询覆盖被稀释，但有 ≥2 字真实重叠仍能召回', async () => {
  const dir = tempDir()
  const svc = lexicalService(dir)
  try {
    const rec = await svc.save({ scope: SCOPE, kind: 'fact', content: '运行环境：460GB 存储' })
    // 无向量后端：词法覆盖率 0.099 < 自适应 floor 0.153，旧行为是整条漏。
    const hits = await svc.search({ text: '手机还剩多少存储空间', scope: SCOPE, topK: 5 })
    assert.equal(hits.length, 1, '有真实词面重叠就不该整条漏')
    assert.equal(hits[0]!.record.id, rec.id)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('纯词法库的保底：无词面重叠时仍返回空（不硬凑）', async () => {
  const dir = tempDir()
  const svc = lexicalService(dir)
  try {
    await svc.save({ scope: SCOPE, kind: 'fact', content: '运行环境：460GB 存储' })
    const hits = await svc.search({ text: 'kubernetes 集群滚动升级', scope: SCOPE, topK: 5 })
    assert.equal(hits.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
