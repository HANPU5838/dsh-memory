import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { MemoryRecord } from 'dsh-memory'
import { digestLine, digestScopeLabel, rankForDigest, renderDigestBlock } from '../src/digest.ts'
import { renderRulesBlock } from '../src/rules.ts'
import { MemoryDigester } from '../src/inject.ts'
import { defaultInjectSettings, type DigestSettings } from '../../memory-local/src/inject-settings.ts'

function rec(content: string, options: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: content,
    scope: 'project:D:/repo',
    kind: 'fact',
    content,
    tags: [],
    source: { origin: 'explicit', at: 0 },
    createdAt: 0,
    updatedAt: 0,
    lastAccessedAt: 0,
    accessCount: 0,
    importance: 0.5,
    ...options,
  } as MemoryRecord
}

const digestCfg: DigestSettings = defaultInjectSettings.digest

test('digestScopeLabel maps scopes to short labels', () => {
  assert.equal(digestScopeLabel('global'), '全局')
  assert.equal(digestScopeLabel('project:D:/repo'), '项目')
  assert.equal(digestScopeLabel('session:abc'), '会话')
  // 0.25.11:自定义作用域补 custom: 前缀,否则摘要里是个裸名字,和上面三个分类词分不清
  assert.equal(digestScopeLabel('handbook'), 'custom:handbook')
  assert.equal(digestScopeLabel('dsh-plugin-dev'), 'custom:dsh-plugin-dev')
})

test('renderDigestBlock returns null for no records and stays within budget', () => {
  assert.equal(renderDigestBlock([], digestCfg), null)
  const many = Array.from({ length: 20 }, (_, i) => rec(`记忆 ${i} ${'内容'.repeat(40)}`, { importance: 0.9 }))
  const block = renderDigestBlock(many, { ...digestCfg, tokenBudget: 120 })
  assert.ok(block)
  assert.ok(block!.tokens <= 120)
  assert.ok(block!.count >= 1 && block!.count <= digestCfg.topK)
  // 预算连正文 header 都放不下时,不再返回 null:至少留下可检索的标签索引。
  const tiny = renderDigestBlock(many, { ...digestCfg, tokenBudget: 5 })
  assert.ok(tiny)
  assert.equal(tiny!.stats.injected, 0)
  assert.ok(tiny!.stats.hint.injected > 0)
  assert.ok(tiny!.text.includes('相关记忆索引'))
})

test('rankForDigest prefers important + fresh records, then project over global', () => {
  const now = 1_000_000_000
  const day = 86_400_000
  const old = rec('旧的但重要', { importance: 1, updatedAt: now - 20 * day })
  const fresh = rec('新的但一般', { importance: 0.3, updatedAt: now })
  const globalFresh = rec('全局', { scope: 'global', importance: 0.3, updatedAt: now })
  const projectFresh = rec('项目', { scope: 'project:x', importance: 0.3, updatedAt: now })
  const ranked = rankForDigest([old, fresh, globalFresh, projectFresh], now)
  assert.equal(ranked[0]!.content, '旧的但重要')
  assert.ok(ranked.findIndex((r) => r.content === '项目') < ranked.findIndex((r) => r.content === '全局'))
  assert.deepEqual(rankForDigest([old, fresh, globalFresh, projectFresh], now).map((r) => r.id), ranked.map((r) => r.id))
})

test('renderRulesBlock orders by importance and respects the cap', () => {
  const rules = [
    rec('低优先规则', { kind: 'rule', importance: 0.2 }),
    rec('高优先规则', { kind: 'rule', importance: 0.9 }),
    rec('中优先规则', { kind: 'rule', importance: 0.5 }),
  ]
  const block = renderRulesBlock(rules, { enabled: true, maxItems: 2, tokenBudget: 500 })
  assert.ok(block)
  assert.ok(block!.includes('高优先规则'))
  assert.ok(block!.includes('中优先规则'))
  assert.ok(!block!.includes('低优先规则'))
  assert.equal(renderRulesBlock([], { enabled: true, maxItems: 2, tokenBudget: 500 }), null)
})

test('MemoryDigester injects once per session and never retries', async () => {
  let calls = 0
  const digester = new MemoryDigester(async () => {
    calls++
    return [rec('项目里已有的结论')]
  })
  const render = (records: MemoryRecord[]) => renderDigestBlock(records, digestCfg)?.text ?? null

  const first = await digester.maybeDigest('session-a', ['project:x'], render)
  assert.ok(first?.includes('项目里已有的结论'))
  assert.equal(await digester.maybeDigest('session-a', ['project:x'], render), undefined)
  assert.equal(calls, 1, 'same session must not search twice')
  assert.ok(await digester.maybeDigest('session-b', ['project:x'], render))
  assert.equal(calls, 2)

  const empty = new MemoryDigester(async () => { calls++; return [] })
  assert.equal(await empty.maybeDigest('s1', undefined, render), undefined)
  assert.equal(await empty.maybeDigest('s1', undefined, render), undefined)
  assert.equal(calls, 3, 'empty result marks the session done')

  const failing = new MemoryDigester(async () => { calls++; throw new Error('down') })
  assert.equal(await failing.maybeDigest('s2', undefined, render), undefined)
  assert.equal(await failing.maybeDigest('s2', undefined, render), undefined)
  assert.equal(calls, 4)

  const brokenRender = new MemoryDigester(async () => [rec('项目里已有的结论')])
  const outcome = await brokenRender.maybeDigestOutcome('s3', undefined, () => { throw new Error('bad record') })
  assert.deepEqual(outcome, { status: 'failed', errorCode: 'render_failed' })
})

test('0.87.0：L1 会话摘要的长正文用 TextRank 保留关键句（不再截前缀）', () => {
  const filler = `背景信息：${'与主题无关的背景描述。'.repeat(20)}`
  const key = '关键结论：发布前必须先跑 verify:all。'
  const line = digestLine(rec(`${filler}${key}`))
  assert.ok(line.includes('关键结论'), `关键句应被保留（实际 ${line}）`)
  assert.ok(line.includes('verify:all'))
})
