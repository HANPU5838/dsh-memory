/**
 * 检索分数的回归测试(0.13.2)。
 *
 * 曾经有个静默了很久的 bug:`search()` 里给每条命中取分数用的是候选对象上的 `c.id`,
 * 而 `Cand` 只有 `record`/`recallScore`/`isGlobal` —— 所有候选都落到 Map 的同一个
 * `undefined` 键上。排序数组本身是对的,所以召回顺序看起来正常,但:
 *   1. 每条命中的 `score` 都是**最后一个候选**的分数(面板上表现为相关度全一样);
 *   2. 传给 LLM 重排的候选 id 全是 undefined,重排永远匹配不上、也改不了顺序。
 * 这两条各有一个用例。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService } from '../src/index.ts'

const SCOPE = 'project:/w'

function makeService(dir: string, opts: { llm?: boolean; strengthRanking?: boolean } = {}) {
  const svc = new LocalMemoryService({
    storeDir: dir,
    scopes: { global: true, project: true },
    retrieval: {
      // 这两个用例锁定的是"分数/重排管线"的语义（每条命中带自己的分、候选 id 真实），
      // 所以显式关掉 0.33.0 的强度排序，用 0.32 的 recordScore 做基准。
      ...(opts.strengthRanking === false ? { strengthRanking: false } : {}),
      temporalWeighting: false,
      ...(opts.llm ? { llm: { enabled: true, provider: 'fake', model: 'fake' } } : {}),
    },
  })
  svc.setProjectScope(SCOPE)
  return svc
}

/** 固定时间与访问次数,让"重要度"成为两条记录之间唯一的变量。 */
function pinAccess(svc: LocalMemoryService, now: number) {
  for (const rec of svc.store.peek(SCOPE)!.records.values()) {
    rec.lastAccessedAt = now
    rec.accessCount = 0
    rec.updatedAt = now
    rec.createdAt = now
  }
}

test('search:每条命中带自己的排序分,而不是所有命中共用最后一个分数', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-search-score-'))
  const svc = makeService(dir, { strengthRanking: false })
  try {
    // 同一个查询词都能命中,词法召回相同;只有重要度不同 → 分数必须不同。
    const low = await svc.save({ scope: SCOPE, kind: 'note', content: 'alpha low', importance: 0.2 })
    const high = await svc.save({ scope: SCOPE, kind: 'note', content: 'alpha high', importance: 0.9 })
    pinAccess(svc, Date.now())

    const hits = await svc.search({ text: 'alpha', scope: SCOPE, topK: 5 })
    assert.equal(hits.length, 2)
    const scores = new Map(hits.map((hit) => [hit.record.id, hit.score]))
    assert.equal(hits[0]!.record.id, high.id, '重要度高的排在前面')
    assert.ok(scores.get(high.id)! > scores.get(low.id)!,
      `每条命中必须拿到自己的分数(实际 ${JSON.stringify([...scores])})`)
    // 0.5 + 0.5 * importance → 0.95 / 0.60(recency≈1、accessCount=0)
    assert.ok(Math.abs(scores.get(high.id)! - 0.95) < 0.01, `高重要度分数应≈0.95(${scores.get(high.id)})`)
    assert.ok(Math.abs(scores.get(low.id)! - 0.6) < 0.01, `低重要度分数应≈0.60(${scores.get(low.id)})`)
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('search:重排候选带真实 id,且重排结果能改变顺序', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-search-rerank-'))
  const svc = makeService(dir, { llm: true, strengthRanking: false })
  try {
    const low = await svc.save({ scope: SCOPE, kind: 'note', content: 'alpha low', importance: 0.2 })
    const high = await svc.save({ scope: SCOPE, kind: 'note', content: 'alpha high', importance: 0.9 })
    pinAccess(svc, Date.now())

    let prompt = ''
    svc.setLlmInvoke(async ({ prompt: text }) => {
      prompt = text
      // 判官把低召回的那条判成 1、高召回的那条判成 0 → 顺序应翻转
      return JSON.stringify([[high.id, 0], [low.id, 1]])
    })

    const hits = await svc.search({ text: 'alpha', scope: SCOPE, topK: 5 })
    assert.ok(prompt.includes(`[${high.id}]`) && prompt.includes(`[${low.id}]`),
      `候选项要带真实 record id(实际 prompt:${prompt.slice(0, 200)})`)
    assert.ok(!prompt.includes('[undefined]'), '不能把 undefined 当候选 id')
    assert.equal(hits[0]!.record.id, low.id, '重排必须能改变召回顺序')
    assert.ok(hits[0]!.score > hits[1]!.score, '输出顺序与分数顺序一致')
    // blend:低召回 0.60、llm 1 → 0.4*0.60 + 0.6*1 = 0.84
    assert.ok(Math.abs(hits[0]!.score - 0.84) < 0.01, `混合分数应≈0.84(${hits[0]!.score})`)
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})
