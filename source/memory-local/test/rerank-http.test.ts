/**
 * cross-encoder HTTP 重排（0.112.0）的单元测试。
 *
 * 覆盖四类行为，全部不碰网络：
 *   1. 端点/请求体构造（只写 host 补路径、model 空不发、apiKey 进 header）
 *   2. 响应解析（Cohere / llama.cpp / Jina 三种形状、索引越界、坏字段）
 *   3. 分数归一化（已在 [0,1] 原样保留、logits 走 min-max、常量不炸）
 *   4. 失败降级（禁用 / 无端点 / 候选不足 / 超时 / 非 2xx / 坏 JSON 都返回 null）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService } from '../src/index.ts'
import {
  blendHttpScores,
  buildHttpRerankBody,
  defaultHttpRerankConfig,
  httpRerank,
  normalizeRerankScores,
  parseHttpRerankResponse,
  resolveRerankEndpoint,
  type HttpRerankCandidate,
  type HttpRerankConfig,
} from '../src/rerank-http.ts'

const candidates: HttpRerankCandidate[] = [
  { id: 'a', content: '第一条记忆', recallScore: 0.9 },
  { id: 'b', content: '第二条记忆', recallScore: 0.5 },
  { id: 'c', content: '第三条记忆', recallScore: 0.3 },
]

function cfg(overrides: Partial<HttpRerankConfig> = {}): HttpRerankConfig {
  return { ...defaultHttpRerankConfig, enabled: true, endpoint: 'http://127.0.0.1:8079', ...overrides }
}

function fakeFetch(response: Response | (() => Response)): {
  calls: Array<{ url: string; init: RequestInit }>
  fetchImpl: typeof fetch
} {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return typeof response === 'function' ? response() : response
  }) as typeof fetch
  return { calls, fetchImpl }
}

test('resolveRerankEndpoint：只写 host 补 /v1/rerank，显式路径原样保留', () => {
  assert.equal(resolveRerankEndpoint('http://127.0.0.1:8079'), 'http://127.0.0.1:8079/v1/rerank')
  assert.equal(resolveRerankEndpoint('http://127.0.0.1:8079/'), 'http://127.0.0.1:8079/v1/rerank')
  assert.equal(resolveRerankEndpoint('https://api.cohere.com/v2/rerank'), 'https://api.cohere.com/v2/rerank')
  assert.equal(resolveRerankEndpoint('   '), '')
  assert.equal(resolveRerankEndpoint('不是 URL'), '')
})

test('buildHttpRerankBody：model 为空时不发该字段，documents 按候选顺序', () => {
  const body = buildHttpRerankBody(cfg({ model: '' }), '查询', candidates)
  assert.deepEqual(body, { query: '查询', documents: ['第一条记忆', '第二条记忆', '第三条记忆'], top_n: 3 })
  assert.ok(!('model' in body))

  const withModel = buildHttpRerankBody(cfg({ model: 'bge-reranker-v2-m3' }), '查询', candidates)
  assert.equal(withModel.model, 'bge-reranker-v2-m3')
})

test('parseHttpRerankResponse：Cohere/llama.cpp 的 results+index 形状', () => {
  const scores = parseHttpRerankResponse(
    { results: [{ index: 2, relevance_score: 0.95 }, { index: 0, relevance_score: 0.1 }] },
    candidates,
  )
  assert.equal(scores.get('c'), 0.95)
  assert.equal(scores.get('a'), 0.1)
  assert.equal(scores.has('b'), false, '没被打分的候选不应出现在结果里')
})

test('parseHttpRerankResponse：data 形状、裸数组、score 字段名都接受', () => {
  assert.deepEqual([...parseHttpRerankResponse({ data: [{ index: 1, score: 0.7 }] }, candidates)], [['b', 0.7]])
  assert.deepEqual([...parseHttpRerankResponse([{ index: 0, score: 0.4 }], candidates)], [['a', 0.4]])
})

test('parseHttpRerankResponse：越界索引、坏分数、未知形状都被丢弃', () => {
  assert.equal(parseHttpRerankResponse({ results: [{ index: 9, score: 0.9 }] }, candidates).size, 0)
  assert.equal(parseHttpRerankResponse({ results: [{ index: -1, score: 0.9 }] }, candidates).size, 0)
  assert.equal(parseHttpRerankResponse({ results: [{ index: 0, score: 'NaN' }] }, candidates).size, 0)
  assert.equal(parseHttpRerankResponse({ results: [{ index: 0.5, score: 0.9 }] }, candidates).size, 0)
  assert.equal(parseHttpRerankResponse({ oops: true }, candidates).size, 0)
  assert.equal(parseHttpRerankResponse(null, candidates).size, 0)
})

test('normalizeRerankScores：落在 [0,1] 原样保留，不会把窄分布拉满', () => {
  const kept = normalizeRerankScores(new Map([['a', 0.91], ['b', 0.88]]))
  assert.equal(kept.get('a'), 0.91)
  assert.equal(kept.get('b'), 0.88)
})

test('normalizeRerankScores：负 logits 走 min-max，常量退化为 0.5', () => {
  const scaled = normalizeRerankScores(new Map([['a', -2], ['b', 0], ['c', 2]]))
  assert.equal(scaled.get('a'), 0)
  assert.equal(scaled.get('b'), 0.5)
  assert.equal(scaled.get('c'), 1)

  const flat = normalizeRerankScores(new Map([['a', 7], ['b', 7]]))
  assert.equal(flat.get('a'), 0.5)
  assert.equal(flat.get('b'), 0.5)
})

test('httpRerank：禁用 / 无端点 / 候选不足时直接返回 null，不发请求', async () => {
  const spy = fakeFetch(new Response('{}'))
  assert.equal(await httpRerank({ cfg: cfg({ enabled: false }), query: 'q', candidates, fetchImpl: spy.fetchImpl }), null)
  assert.equal(await httpRerank({ cfg: cfg({ endpoint: '' }), query: 'q', candidates, fetchImpl: spy.fetchImpl }), null)
  assert.equal(await httpRerank({ cfg: cfg(), query: 'q', candidates: candidates.slice(0, 1), fetchImpl: spy.fetchImpl }), null)
  assert.equal(spy.calls.length, 0)
})

test('httpRerank：成功时按 index 回填，请求带 query/documents/top_n 与 apiKey', async () => {
  const spy = fakeFetch(new Response(JSON.stringify({
    results: [{ index: 0, relevance_score: 0.2 }, { index: 1, relevance_score: 0.8 }],
  }), { status: 200, headers: { 'content-type': 'application/json' } }))

  const outcome = await httpRerank({
    cfg: cfg({ model: 'reranker-x', apiKey: 'sk-test' }),
    query: '查询',
    candidates,
    fetchImpl: spy.fetchImpl,
  })

  assert.ok(outcome)
  assert.equal(outcome.model, 'reranker-x@http://127.0.0.1:8079/v1/rerank')
  assert.equal(outcome.scores.get('a'), 0.2)
  assert.equal(outcome.scores.get('b'), 0.8)

  assert.equal(spy.calls.length, 1)
  const [call] = spy.calls
  assert.equal(call.url, 'http://127.0.0.1:8079/v1/rerank')
  assert.equal((call.init.headers as Record<string, string>).authorization, 'Bearer sk-test')
  const sent = JSON.parse(String(call.init.body)) as { model: string; query: string; documents: string[]; top_n: number }
  assert.equal(sent.model, 'reranker-x')
  assert.equal(sent.query, '查询')
  assert.deepEqual(sent.documents, ['第一条记忆', '第二条记忆', '第三条记忆'])
  assert.equal(sent.top_n, 3)
})

test('httpRerank：服务端非 2xx、坏 JSON、fetch 抛错都降级为 null', async () => {
  const notOk = fakeFetch(new Response('boom', { status: 500 }))
  assert.equal(await httpRerank({ cfg: cfg(), query: 'q', candidates, fetchImpl: notOk.fetchImpl }), null)

  const badJson = fakeFetch(new Response('{not json', { status: 200 }))
  assert.equal(await httpRerank({ cfg: cfg(), query: 'q', candidates, fetchImpl: badJson.fetchImpl }), null)

  const throwing = fakeFetch(() => { throw new Error('connect refused') })
  assert.equal(await httpRerank({ cfg: cfg(), query: 'q', candidates, fetchImpl: throwing.fetchImpl }), null)
})

test('httpRerank：空 results 视为不可用（不把召回顺序改坏）', async () => {
  const empty = fakeFetch(new Response(JSON.stringify({ results: [] }), { status: 200 }))
  assert.equal(await httpRerank({ cfg: cfg(), query: 'q', candidates, fetchImpl: empty.fetchImpl }), null)
})

test('httpRerank：topN 截断只给前 N 条打分', async () => {
  const spy = fakeFetch(new Response(JSON.stringify({
    results: [{ index: 0, relevance_score: 0.9 }, { index: 1, relevance_score: 0.1 }],
  }), { status: 200 }))
  const outcome = await httpRerank({ cfg: cfg({ topN: 2 }), query: 'q', candidates, fetchImpl: spy.fetchImpl })
  assert.ok(outcome)
  const sent = JSON.parse(String(spy.calls[0]!.init.body)) as { documents: string[] }
  assert.equal(sent.documents.length, 2)
})

test('blendHttpScores：按权重融合，没被打分的候选保持召回分', () => {
  const blended = blendHttpScores(candidates, new Map([['a', 0.0], ['b', 1.0]]), 0.5)
  const byId = new Map(blended.map((entry) => [entry.id, entry.score]))
  assert.equal(byId.get('a'), 0.45) // 0.5*0.9 + 0.5*0
  assert.equal(byId.get('b'), 0.75) // 0.5*0.5 + 0.5*1
  assert.equal(byId.get('c'), 0.3) // 没打分 → 原样
})

test('blendHttpScores：权重越界被夹到 [0,1]', () => {
  const high = blendHttpScores(candidates, new Map([['a', 0]]), 5)
  assert.equal(high.find((entry) => entry.id === 'a')!.score, 0)
  const low = blendHttpScores(candidates, new Map([['a', 0]]), -5)
  assert.equal(low.find((entry) => entry.id === 'a')!.score, 0.9)
})

// ---------------------------------------------------------------------------
// 检索管线集成：cross-encoder 真的能改变召回顺序，失败时保持原顺序
// ---------------------------------------------------------------------------

function makeService(dir: string, rerank = {} as HttpRerankConfig) {
  const svc = new LocalMemoryService({
    storeDir: dir,
    scopes: { global: true, project: true },
    retrieval: {
      // 锁定"重排管道"语义：关掉强度排序与 BM25/RRF，让重要度成为唯一排序变量。
      strengthRanking: false,
      temporalWeighting: false,
      bm25: { enabled: false },
      fusion: { enabled: false },
      rerank,
    },
  })
  svc.setProjectScope('project:/w')
  return svc
}

/** 固定时间与访问次数，避免 recency 影响顺序。 */
function pinAccess(svc: LocalMemoryService, scope: string, now: number) {
  for (const rec of svc.store.peek(scope as never)!.records.values()) {
    rec.lastAccessedAt = now
    rec.accessCount = 0
    rec.updatedAt = now
    rec.createdAt = now
  }
}

test('集成：cross-encoder 重排后顺序翻转，且请求体是候选正文', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-http-rerank-'))
  const svc = makeService(dir, { ...defaultHttpRerankConfig, enabled: true, endpoint: 'http://127.0.0.1:8079', weight: 1 })
  try {
    const low = await svc.save({ scope: 'project:/w' as never, kind: 'note', content: 'alpha low', importance: 0.2 })
    const high = await svc.save({ scope: 'project:/w' as never, kind: 'note', content: 'alpha high', importance: 0.9 })
    pinAccess(svc, 'project:/w', Date.now())

    let sentDocuments: string[] = []
    svc.setRerankFetch((async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { documents: string[] }
      sentDocuments = body.documents
      // 把 low 判成 1、high 判成 0 —— 与召回顺序相反
      const results = body.documents.map((doc, index) => ({
        index,
        relevance_score: doc.includes('low') ? 1 : 0,
      }))
      return new Response(JSON.stringify({ results }), { status: 200 })
    }) as typeof fetch)

    const hits = await svc.search({ text: 'alpha', scope: 'project:/w' as never, topK: 5 })
    assert.equal(hits.length, 2)
    assert.equal(sentDocuments.length, 2, '请求里应有两条候选正文')
    assert.ok(sentDocuments.some((doc) => doc.includes('alpha low')))
    assert.equal(hits[0]!.record.id, low.id, 'cross-encoder 判 low 更相关 → 应排第一')
    assert.ok(Math.abs(hits[0]!.score - 1) < 0.01, `权重 1 时分数应等于重排分(${hits[0]!.score})`)
    assert.equal(hits[1]!.record.id, high.id)
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('集成：重排端点失败时保持召回顺序，不抛错', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-http-rerank-fail-'))
  const svc = makeService(dir, { ...defaultHttpRerankConfig, enabled: true, endpoint: 'http://127.0.0.1:8079' })
  try {
    const low = await svc.save({ scope: 'project:/w' as never, kind: 'note', content: 'alpha low', importance: 0.2 })
    const high = await svc.save({ scope: 'project:/w' as never, kind: 'note', content: 'alpha high', importance: 0.9 })
    pinAccess(svc, 'project:/w', Date.now())

    svc.setRerankFetch((async () => new Response('boom', { status: 500 })) as typeof fetch)
    const hits = await svc.search({ text: 'alpha', scope: 'project:/w' as never, topK: 5 })
    assert.equal(hits.length, 2)
    assert.equal(hits[0]!.record.id, high.id, '端点挂了 → 找回顺序（重要度高的在前）')
    assert.notEqual(hits[0]!.record.id, low.id)
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})
