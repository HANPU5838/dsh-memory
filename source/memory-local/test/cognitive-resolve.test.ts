/**
 * 冲突自动解决（cognitive/resolve）：四信号决策、阈值边界、落盘语义与幂等。
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, generationOf } from '../src/store.ts'
import {
  DEFAULT_SOURCE_CREDIBILITY,
  SOURCE_CREDIBILITY,
  applyConflictResolution,
  resolveConflict,
  sourceCredibility,
} from '../src/cognitive/resolve.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const DEFAULTS = { importance: 0.5, source: { origin: 'explicit' as const } }
type SaveInput = Parameters<MemoryStore['save']>[0]

const BASE = {
  scope: 'global' as const,
  kind: 'note' as const,
  tags: [] as string[],
  source: { origin: 'explicit' as const },
  createdAt: 1_000,
  updatedAt: 1_000,
  lastAccessedAt: 1_000,
  accessCount: 0,
  importance: 0.5,
}

/** 构造一条测试记录（纯对象，不落盘）。 */
function rec(id: string, content: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...BASE, id, content, ...extra }
}

function freshStore(): MemoryStore {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cog-resolve-'))
  dirs.push(dir)
  return new MemoryStore(dir)
}

function save(store: MemoryStore, scope: string, content: string, extra: Record<string, unknown> = {}) {
  return store.save({ scope, kind: 'note', content, ...extra } as SaveInput, DEFAULTS).record
}

/** 一对"事实冲突"（端口 + 工具名都变了，矛盾置信度高）。 */
function contradictoryPair(newerExtra: Record<string, unknown> = {}, olderExtra: Record<string, unknown> = {}) {
  const older = rec('older', '端口 8080 用 npm 构建', { updatedAt: 1_000, ...olderExtra })
  const newer = rec('newer', '端口 9090 用 pnpm 构建', { updatedAt: 2_000, ...newerExtra })
  return { newer, older }
}

test('内容相同：merge + 高置信，合并 tags 并集 / importance 取大', () => {
  const older = rec('older', '项目使用 pnpm 构建', { tags: ['build'], importance: 0.4 })
  const newer = rec('newer', '项目使用 pnpm 构建 ', { tags: ['build', 'tool'], importance: 0.9, updatedAt: 2_000 })
  const decision = resolveConflict({ newer, older })
  assert.equal(decision.action, 'merge')
  assert.equal(decision.reason, 'identical-content')
  assert.equal(decision.confidence, 1)
  assert.equal(decision.merge!.content, '项目使用 pnpm 构建 ')
  assert.deepEqual(decision.merge!.tags, ['build', 'tool'])
  assert.equal(decision.merge!.importance, 0.9)
})

test('矛盾度低 → merge（可共存），confidence 随矛盾度下降', () => {
  const older = rec('older', '项目使用 TypeScript 构建')
  const newer = rec('newer', '项目偏好 TypeScript 开发', { updatedAt: 2_000 })
  const decision = resolveConflict({ newer, older, evidence: { similarity: 0.8 } })
  assert.equal(decision.action, 'merge')
  assert.equal(decision.reason, 'compatible-statements')
  assert.equal(decision.contradiction, 0, '没有数值/标识符差异 → 不矛盾')
  assert.equal(decision.confidence, 1)
})

test('高矛盾 + 新陈述全面占优（同来源、时间更新）→ old 失效，validUntil = now', () => {
  const pair = contradictoryPair()
  const now = 12_345
  const decision = resolveConflict({ ...pair, evidence: { similarity: 0.95 }, options: { now } })
  assert.ok(decision.contradiction >= 0.6, `矛盾置信度应高：${decision.contradiction}`)
  assert.equal(decision.action, 'invalidate-old')
  assert.equal(decision.reason, 'newer-dominant')
  assert.equal(decision.validUntil, now)
  assert.ok(decision.confidence > 0.5 && decision.confidence <= 1)
  assert.ok(decision.explanation.some((line) => line.includes('旧记录失效')))
})

test('来源可信度：auto 新记录压不过 explicit 旧记录 → keep-both', () => {
  const pair = contradictoryPair({ source: { origin: 'auto' } })
  const decision = resolveConflict({ ...pair, evidence: { similarity: 0.95 } })
  assert.equal(decision.action, 'keep-both')
  assert.equal(decision.reason, 'balanced-evidence')
  assert.ok(decision.newerAdvantage < 0.6)
  assert.match(decision.explanation.join('\n'), /来源可信度 0\.5:1/)
})

test('时间优先：新记录其实更旧 → keep-both（old-dominant）', () => {
  const pair = contradictoryPair({ source: { origin: 'auto' }, updatedAt: 500 }, { updatedAt: 2_000 })
  const decision = resolveConflict({ ...pair, evidence: { similarity: 0.95 } })
  assert.equal(decision.action, 'keep-both')
  assert.equal(decision.reason, 'older-dominant')
  assert.equal(decision.signals.timeFavorsNewer, 0)
})

test('证据计数：同向记录多可以压过来源劣势', () => {
  const pair = contradictoryPair({ source: { origin: 'auto' } })
  const supported = resolveConflict({ ...pair, evidence: { similarity: 0.95, supportNewer: 5 } })
  assert.equal(supported.action, 'invalidate-old', '5 条同向证据足以让新陈述占优')
  assert.equal(supported.evidence.supportNewer, 5)

  const opposed = resolveConflict({ ...pair, evidence: { similarity: 0.95, supportOlder: 5 } })
  assert.equal(opposed.action, 'keep-both', '5 条反向证据让新陈述优势跌破边界')
})

test('上层可覆盖矛盾置信度（evidence.contradiction）', () => {
  const pair = contradictoryPair()
  const decision = resolveConflict({ ...pair, evidence: { similarity: 0.95, contradiction: 0.1 } })
  assert.equal(decision.action, 'merge')
  assert.equal(decision.reason, 'compatible-statements')
  assert.equal(decision.contradiction, 0.1)
  assert.equal(decision.evidence.contradictionOverride, 0.1)
})

test('阈值可配置：提高 invalidateThreshold 后改为保留双方', () => {
  const pair = contradictoryPair()
  const decision = resolveConflict({
    ...pair,
    evidence: { similarity: 0.95 },
    options: { invalidateThreshold: 0.9 },
  })
  assert.equal(decision.action, 'keep-both')
  assert.equal(decision.thresholds.invalidateThreshold, 0.9)
})

test('跨作用域：不自动失效/合并（supersedes 是作用域内语义）', () => {
  const older = rec('older', '端口 8080', { scope: 'project:a' })
  const newer = rec('newer', '端口 9090', { scope: 'project:b', updatedAt: 2_000 })
  const decision = resolveConflict({ newer, older })
  assert.equal(decision.action, 'keep-both')
  assert.equal(decision.reason, 'cross-scope')
})

test('谱系约束：新记录已有别的前驱 → 不合并（keep-both lineage-conflict）', () => {
  const older = rec('older', '项目使用 TypeScript 构建')
  const newer = rec('newer', '项目偏好 TypeScript 开发', { supersedes: 'some-other', updatedAt: 2_000 })
  const decision = resolveConflict({ newer, older })
  assert.equal(decision.action, 'keep-both')
  assert.equal(decision.reason, 'lineage-conflict')
})

test('权重归一化：全 0 / 非法权重回落到默认 0.45/0.35/0.20', () => {
  const pair = contradictoryPair()
  const decision = resolveConflict({
    ...pair,
    evidence: { similarity: 0.95 },
    options: { evidenceWeight: 0, credibilityWeight: 0, timeWeight: 0 },
  })
  assert.ok(Math.abs(decision.signals.weights.evidence - 0.45) < 1e-9)
  assert.ok(Math.abs(decision.signals.weights.credibility - 0.35) < 1e-9)
  assert.ok(Math.abs(decision.signals.weights.time - 0.2) < 1e-9)
  assert.ok(Math.abs(decision.signals.weights.evidence + decision.signals.weights.credibility + decision.signals.weights.time - 1) < 1e-9)
})

test('来源可信度表：user/explicit 最高、auto 最低、未知走默认值', () => {
  assert.equal(SOURCE_CREDIBILITY.explicit, 1)
  assert.equal(SOURCE_CREDIBILITY.user, 1)
  assert.ok(SOURCE_CREDIBILITY.auto! < SOURCE_CREDIBILITY.agent!)
  assert.equal(sourceCredibility(rec('a', 'x')), 1)
  assert.equal(sourceCredibility(rec('a', 'x', { source: { origin: 'auto' } })), 0.5)
  assert.equal(sourceCredibility(rec('a', 'x', { source: { origin: 'mystery' } })), DEFAULT_SOURCE_CREDIBILITY)
  assert.equal(sourceCredibility(rec('a', 'x', { source: {} })), DEFAULT_SOURCE_CREDIBILITY)
})

test('同一对记录必须不同，否则抛错', () => {
  const only = rec('same', '内容')
  assert.throws(() => resolveConflict({ newer: only, older: only }), /必须是两条不同的记录/)
})

test('applyConflictResolution：invalidate-old 只写 validUntil，不 flush', () => {
  const store = freshStore()
  const scope = 'global'
  const older = save(store, scope, '端口 8080 用 npm 构建')
  const newer = save(store, scope, '端口 9090 用 pnpm 构建')
  const now = 777_000
  const decision = resolveConflict({
    newer,
    older,
    evidence: { similarity: 0.95 },
    options: { now },
  })
  assert.equal(decision.action, 'invalidate-old')
  const result = applyConflictResolution(store, decision)
  assert.equal(result.applied, true)
  assert.deepEqual(result.updated, [older.id])
  const stored = store.findById(older.id)!
  assert.equal((stored as { validUntil?: number }).validUntil, now, '只写 validUntil')
  assert.equal(stored.content, '端口 8080 用 npm 构建', '内容不动')
  assert.equal(store.anyDirty(), true, '进增量等调用方 flush')
  assert.equal(existsSync(join(store.root, 'global.jsonl')), false, 'apply 不 flush')
})

test('applyConflictResolution：merge 原地升级新记录（supersedes/tags/importance/清冲突标记）', () => {
  const store = freshStore()
  const scope = 'global'
  const older = save(store, scope, '项目使用 TypeScript 构建')
  const savedNewer = save(store, scope, '项目偏好 TypeScript 开发')
  // 模拟冲突打标：applyCognition 会给新记录写 conflictWith。
  store.scopeOf(savedNewer.id)!.store.insert({
    ...savedNewer,
    conflictWith: [older.id],
    conflictConfidence: 0.8,
    generation: 1,
  } as never)
  const newer = store.findById(savedNewer.id)!
  const decision = resolveConflict({ newer, older })
  assert.equal(decision.action, 'merge')

  const result = applyConflictResolution(store, decision)
  assert.equal(result.applied, true)
  const merged = store.findById(newer.id)!
  assert.equal((merged as { supersedes?: string }).supersedes, older.id)
  assert.equal(generationOf(merged), 2)
  assert.equal((merged as { conflictWith?: string[] }).conflictWith, undefined, '合并解决分歧 → 清冲突标记')
  assert.equal((merged as { dormantAt?: number }).dormantAt, undefined)
  assert.ok(store.findById(older.id) !== undefined, '旧记录保留为历史版本，不删除')
  assert.equal(existsSync(join(store.root, 'global.jsonl')), false, 'apply 不 flush')

  // 幂等：再 apply 一次不会重复提升版本号
  const again = applyConflictResolution(store, decision)
  assert.equal(again.applied, false)
  assert.equal(again.reason, 'already-merged')
  assert.equal(generationOf(store.findById(newer.id)!), 2)
})

test('applyConflictResolution：keep-both 不写任何东西', () => {
  const store = freshStore()
  const pair = contradictoryPair({ source: { origin: 'auto' } })
  const decision = resolveConflict({ ...pair, evidence: { similarity: 0.95 } })
  assert.equal(decision.action, 'keep-both')
  const result = applyConflictResolution(store, decision)
  assert.equal(result.applied, false)
  assert.equal(result.reason, 'keep-both')
  assert.deepEqual(result.updated, [])
})

test('applyConflictResolution：记录不存在 / 谱系冲突时安全失败', () => {
  const store = freshStore()
  const scope = 'global'
  const older = save(store, scope, '端口 8080 用 npm 构建')
  const newer = save(store, scope, '端口 9090 用 pnpm 构建')
  // 两条记录常在同一毫秒写入，单靠时间不足以占优 → 用同向证据把新陈述推过边界。
  const decision = resolveConflict({
    newer,
    older,
    evidence: { similarity: 0.95, supportNewer: 5 },
  })
  assert.equal(decision.action, 'invalidate-old')

  // 旧记录不存在
  store.scopeOf(older.id)!.store.remove(older.id)
  const missing = applyConflictResolution(store, decision)
  assert.equal(missing.applied, false)
  assert.equal(missing.reason, 'not-found')

  // merge 时新记录已有别的前驱 → lineage-conflict（不改任何字段）
  const fresh = freshStore()
  const a = save(fresh, 'global', '项目使用 TypeScript 构建')
  const b = save(fresh, 'global', '项目偏好 TypeScript 开发')
  fresh.scopeOf(b.id)!.store.insert({ ...b, supersedes: 'other' } as never)
  const base = resolveConflict({ newer: fresh.findById(b.id)!, older: a })
  const manual = {
    ...base,
    action: 'merge' as const,
    newerId: b.id,
    olderId: a.id,
    merge: { content: '合并正文', tags: [], importance: 0.5 },
  }
  const res = applyConflictResolution(fresh, manual)
  assert.equal(res.applied, false)
  assert.equal(res.reason, 'lineage-conflict')
  assert.equal((fresh.findById(b.id) as { supersedes?: string }).supersedes, 'other', '不覆盖已有谱系')
})
