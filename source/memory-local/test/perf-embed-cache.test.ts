/**
 * 嵌入缓存（任务书 §2）的回归测试。
 *
 * 覆盖：文档向量持久缓存（identity + contentHash、跨实例读回、模型切换失效、
 * 损坏文件容错、容量淘汰）、查询向量 LRU、命中率/节省请求数统计、
 * CachedEmbedder（只把 miss 的拼成一次批量请求）与落盘原子性。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CachedEmbedder,
  EmbedCache,
  contentHashOf,
  embedCacheKey,
  identityKeyOf,
} from '../src/embed-cache.ts'

const DIMS = 4

function vectorOf(seed: number): Float32Array {
  const vector = new Float32Array(DIMS)
  for (let i = 0; i < DIMS; i++) vector[i] = Math.sin(seed + i * 0.7)
  let norm = 0
  for (const value of vector) norm += value * value
  const n = Math.sqrt(norm)
  for (let i = 0; i < DIMS; i++) vector[i] = vector[i]! / n
  return vector
}

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `dsh-memory-${prefix}-`))
}

function withTempDir(prefix: string, fn: (dir: string) => void): void {
  const dir = makeTempDir(prefix)
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('identity / contentHash / key 是稳定且互不相同的', () => {
  assert.equal(identityKeyOf({ model: 'bge-m3', dims: 1024 }), 'bge-m3|1024|')
  assert.equal(identityKeyOf({ model: 'bge-m3', dims: 1024, pooling: 'cls' }), 'bge-m3|1024|cls')
  const hash = contentHashOf('同样的正文')
  assert.equal(hash, contentHashOf('同样的正文'))
  assert.notEqual(hash, contentHashOf('不同的正文'))
  assert.notEqual(embedCacheKey(identityKeyOf({ model: 'a', dims: 8 }), hash), embedCacheKey(identityKeyOf({ model: 'b', dims: 8 }), hash))
})

test('文档缓存：未命中→写入→命中，统计可观测', () => {
  const cache = new EmbedCache({ identity: { model: 'm', dims: DIMS } })
  const vector = vectorOf(1)
  assert.equal(cache.getDocument('正文 A'), null)
  assert.equal(cache.statsSnapshot.docMisses, 1)
  cache.putDocument('正文 A', vector)
  assert.equal(cache.statsSnapshot.docWrites, 1)
  const hit = cache.getDocument('正文 A')
  assert.ok(hit instanceof Float32Array)
  assert.deepEqual([...hit!], [...vector])
  assert.equal(cache.statsSnapshot.docHits, 1)
  assert.equal(cache.hitRate, 0.5, '1 命中 / 2 次查询')
  assert.equal(cache.requestsSaved, 1)
  assert.equal(cache.hasDocument('正文 A'), true)
  cache.resetStats()
  assert.equal(cache.statsSnapshot.docHits, 0)
})

test('持久化：跨实例读回，向量 bit-exact', () => {
  const dir = makeTempDir('embed-cache-persist')
  try {
    const identity = { model: 'bge-m3', dims: DIMS, pooling: 'cls' }
    const first = new EmbedCache({ dir, identity })
    first.putDocument('持久化的正文', vectorOf(7))
    first.flushSync()
    first.dispose()
    const file = join(dir, 'embed-cache.jsonl')
    assert.equal(existsSync(file), true)
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    assert.ok(lines[0]!.startsWith('#dsh-memory-embed-cache\tv1\tbge-m3|4|cls'))

    const second = new EmbedCache({ dir, identity })
    assert.equal(second.documentCount, 1)
    const loaded = second.getDocument('持久化的正文')
    assert.ok(loaded instanceof Float32Array)
    assert.deepEqual([...loaded!], [...vectorOf(7)])
    second.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('换模型：旧缓存整份失效（读不回 + 落盘重写文件头）', () => {
  const dir = makeTempDir('embed-cache-identity')
  try {
    const oldIdentity = { model: 'model-a', dims: DIMS }
    const old = new EmbedCache({ dir, identity: oldIdentity })
    old.putDocument('模型 A 的记忆', vectorOf(2))
    old.flushSync()
    old.dispose()

    const swapped = new EmbedCache({ dir, identity: { model: 'model-b', dims: DIMS } })
    assert.equal(swapped.documentCount, 0, '文件头 identity 不符 → 整份忽略')
    assert.equal(swapped.getDocument('模型 A 的记忆'), null)
    swapped.putDocument('模型 B 的记忆', vectorOf(3))
    swapped.flushSync()
    swapped.dispose()

    const rewired = new EmbedCache({ dir, identity: oldIdentity })
    assert.equal(rewired.documentCount, 0, '文件已被模型 B 重写，A 也读不回旧数据')
    rewired.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('损坏文件：无法解析的行跳过，不抛错', () => {
  const dir = makeTempDir('embed-cache-corrupt')
  try {
    const identity = { model: 'm', dims: DIMS }
    const seed = new EmbedCache({ dir, identity })
    seed.putDocument('好的一行', vectorOf(4))
    seed.flushSync()
    const file = join(dir, 'embed-cache.jsonl')
    seed.dispose()
    writeFileSync(file, `${readFileSync(file, 'utf8')}garbage-line\nkey\tnot-a-valid-vector\n`, 'utf8')

    const cache = new EmbedCache({ dir, identity })
    assert.equal(cache.documentCount, 1, '好的那行仍然可用')
    assert.equal(cache.statsSnapshot.corruptLines, 2)
    assert.equal(cache.getDocument('好的一行') !== null, true)
    cache.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('setIdentity：变化时清空缓存并重写文件', () => {
  withTempDir('embed-cache-setidentity', (dir) => {
    const cache = new EmbedCache({ dir, identity: { model: 'm1', dims: DIMS } })
    cache.putDocument('x', vectorOf(1))
    cache.putQuery('q', vectorOf(2))
    assert.equal(cache.documentCount, 1)
    assert.equal(cache.setIdentity({ model: 'm1', dims: DIMS }), false, 'identity 没变 → no-op')
    assert.equal(cache.setIdentity({ model: 'm2', dims: DIMS }), true)
    assert.equal(cache.documentCount, 0)
    assert.equal(cache.queryCount, 0)
    cache.dispose()
  })
})

test('维度不符的向量不写入缓存（宁可不缓存也不污染检索）', () => {
  const cache = new EmbedCache({ identity: { model: 'm', dims: DIMS } })
  cache.putDocument('x', new Float32Array([1, 2, 3])) // 3 维 != 4
  cache.putQuery('x', new Float32Array([1, 2, 3]))
  assert.equal(cache.documentCount, 0)
  assert.equal(cache.queryCount, 0)
})

test('文档缓存 FIFO 容量上限', () => {
  const cache = new EmbedCache({ identity: { model: 'm', dims: DIMS }, maxDocEntries: 2 })
  cache.putDocument('a', vectorOf(1))
  cache.putDocument('b', vectorOf(2))
  cache.putDocument('c', vectorOf(3))
  assert.equal(cache.documentCount, 2)
  assert.equal(cache.hasDocument('a'), false, '最旧的被淘汰')
  assert.equal(cache.hasDocument('b'), true)
  assert.equal(cache.hasDocument('c'), true)
  assert.ok(cache.statsSnapshot.evictions >= 1)
})

test('查询 LRU：容量上限、命中后提升到最新', () => {
  const cache = new EmbedCache({ identity: { model: 'm', dims: DIMS }, queryCache: true, maxQueryEntries: 2 })
  cache.putQuery('q1', vectorOf(1))
  cache.putQuery('q2', vectorOf(2))
  assert.ok(cache.getQuery('q1') instanceof Float32Array) // q1 变成最新
  cache.putQuery('q3', vectorOf(3)) // 淘汰 q2
  assert.ok(cache.getQuery('q1') instanceof Float32Array)
  assert.equal(cache.getQuery('q2'), null)
  assert.ok(cache.getQuery('q3') instanceof Float32Array)
  assert.equal(cache.statsSnapshot.queryHits, 3)
  assert.equal(cache.statsSnapshot.queryMisses, 1)
})

test('落盘延迟合并：scheduleFlush 到点写盘，dispose 立即写', async () => {
  const dir = makeTempDir('embed-cache-flush')
  try {
    const cache = new EmbedCache({ dir, identity: { model: 'm', dims: DIMS }, flushDelayMs: 10 })
    cache.putDocument('延迟写', vectorOf(5))
    assert.equal(existsSync(join(dir, 'embed-cache.jsonl')), false, '未到点前不落盘')
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(existsSync(join(dir, 'embed-cache.jsonl')), true)
    cache.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CachedEmbedder：冷启动只把 miss 拼成一次批量请求，热启动零请求', async () => {
  const cache = new EmbedCache({ identity: { model: 'm', dims: DIMS } })
  const calls: string[][] = []
  const embedder = new CachedEmbedder({
    cache,
    batch: async (texts) => {
      calls.push([...texts])
      return texts.map((text) => vectorOf(text.length))
    },
  })
  const docs = ['一', '二二', '三三三', '四四四四']
  const cold = await embedder.embedDocuments(docs)
  assert.ok(cold !== null)
  assert.equal(cold!.filter(Boolean).length, 4)
  assert.deepEqual(calls, [docs], '4 条 miss 合并成 1 次批量请求')

  const warm = await embedder.embedDocuments(docs)
  assert.ok(warm !== null)
  assert.equal(calls.length, 1, '全部命中 → 不发请求')
  assert.deepEqual([...warm![0]!], [...vectorOf('一'.length)])
  assert.equal(cache.statsSnapshot.docHits, 4)
  assert.equal(cache.requestsSaved, 4)
})

test('CachedEmbedder：单条失败保持 null，不影响同批其它结果', async () => {
  const cache = new EmbedCache({ identity: { model: 'm', dims: DIMS } })
  const embedder = new CachedEmbedder({
    cache,
    batch: async (texts) => texts.map((text) => (text === 'bad' ? null : vectorOf(1))),
  })
  const out = await embedder.embedDocuments(['good', 'bad'])
  assert.ok(out !== null)
  assert.ok(out![0] instanceof Float32Array)
  assert.equal(out![1], null)
  assert.equal(cache.hasDocument('good'), true)
  assert.equal(cache.hasDocument('bad'), false)
})

test('CachedEmbedder：底层整批返回 null → 外层 null（调用方走降级路径）', async () => {
  const cache = new EmbedCache({ identity: { model: 'm', dims: DIMS } })
  const embedder = new CachedEmbedder({ cache, batch: async () => null })
  assert.equal(await embedder.embedDocuments(['x']), null)
  assert.equal(await embedder.embedQueries(['x']), null)
})

test('CachedEmbedder：文档与查询使用各自缓存（同文本互不串味）', async () => {
  const cache = new EmbedCache({ identity: { model: 'm', dims: DIMS } })
  let calls = 0
  const embedder = new CachedEmbedder({
    cache,
    batch: async (texts) => {
      calls += 1
      return texts.map(() => vectorOf(calls))
    },
  })
  await embedder.embedDocuments(['同一段文字'])
  await embedder.embedQueries(['同一段文字'])
  assert.equal(calls, 2, '文档缓存和查询缓存是两个命名空间')
  await embedder.embedDocuments(['同一段文字'])
  await embedder.embedQueries(['同一段文字'])
  assert.equal(calls, 2, '第二遍两类都命中')
})
