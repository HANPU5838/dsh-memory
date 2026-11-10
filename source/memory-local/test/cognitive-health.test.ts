/**
 * 记忆健康度（cognitive/health）：分类计数、嵌入覆盖、抽样重复率、扣分公式、可解释性。
 *
 * 全部围绕纯函数 computeHealth 展开：不依赖真实嵌入后端，向量直接喂 Map。
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../src/store.ts'
import {
  DEFAULT_DUPLICATE_SAMPLE,
  DEFAULT_DUPLICATE_THRESHOLD,
  HEALTH_SCORE_MAX,
  HEALTH_SCORE_RULES,
  computeHealth,
} from '../src/cognitive/health.ts'

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
function rec(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...BASE, id, content: `记忆 ${id}`, ...extra }
}

function vec(...values: number[]): Float32Array {
  return new Float32Array(values)
}

function freshStore(): MemoryStore {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cog-health-'))
  dirs.push(dir)
  return new MemoryStore(dir)
}

test('空库：满分 100，所有比例归零，解释说明"为空"', () => {
  const report = computeHealth([], { now: 10_000 })
  assert.equal(report.total, 0)
  assert.equal(report.score, HEALTH_SCORE_MAX)
  assert.equal(report.live, 0)
  assert.equal(report.embedded, 0)
  assert.equal(report.pending, 0)
  assert.equal(report.duplicateRate, 0)
  assert.equal(report.duplicateSampled, 0)
  assert.equal(report.explain.length >= 2, true)
  assert.match(report.explain[0]!, /共 0 条/)
  assert.match(report.explain.at(-1)!, /健康分 100/)
})

test('分类互斥：live + dormant + tombstoned + invalid + quarantined = total', () => {
  const now = 10_000
  const records = [
    rec('live1'),
    rec('live2'),
    rec('dormant', { dormantAt: 5_000 }),
    rec('tomb', { tombstonedAt: 5_000 }),
    rec('invalid-ttl', { expiredAt: now - 1 }),
    rec('invalid-valid', { validUntil: now - 1 }),
    rec('quarantined', { quarantinedAt: 5_000, quarantineReasons: ['injection'] }),
    rec('conflict', { conflictWith: ['live1'], conflictConfidence: 0.8 }),
  ]
  const report = computeHealth(records, { now })
  assert.equal(report.total, 8)
  assert.equal(report.live, 3, 'live1/live2/conflict 都是活跃（冲突是待裁决状态，不影响可见性）')
  assert.equal(report.dormant, 1)
  assert.equal(report.tombstoned, 1)
  assert.equal(report.invalid, 2)
  assert.equal(report.quarantined, 1)
  assert.equal(report.conflicted, 1)
  assert.equal(
    report.live + report.dormant + report.tombstoned + report.invalid + report.quarantined,
    report.total,
    '互斥分类必须覆盖全部记录',
  )
})

test('互斥优先级：墓碑 > 失效 > 隔离 > 休眠', () => {
  const now = 10_000
  const records = [
    rec('all', {
      tombstonedAt: 1,
      expiredAt: 1,
      quarantinedAt: 1,
      dormantAt: 1,
      conflictWith: ['x'],
    }),
  ]
  const report = computeHealth(records, { now })
  assert.equal(report.tombstoned, 1)
  assert.equal(report.invalid, 0)
  assert.equal(report.quarantined, 0)
  assert.equal(report.dormant, 0)
  assert.equal(report.live, 0)
  assert.equal(report.conflicted, 0, '墓碑不参与冲突统计')
})

test('嵌入覆盖：Map / 普通对象都支持，缺失的进 pending', () => {
  const records = [rec('a'), rec('b'), rec('c')]
  const asMap = new Map<string, Float32Array>([
    ['a', vec(1, 0)],
    ['b', vec(0, 1)],
  ])
  const mapReport = computeHealth(records, { vectors: asMap })
  assert.equal(mapReport.embedded, 2)
  assert.equal(mapReport.pending, 1)
  assert.equal(mapReport.pendingEmbedRate, 1 / 3)

  const asObject = { a: vec(1, 0), b: vec(0, 1), c: vec(1, 1) }
  const objectReport = computeHealth(records, { vectors: asObject })
  assert.equal(objectReport.embedded, 3)
  assert.equal(objectReport.pending, 0)

  const noVectors = computeHealth(records, {})
  assert.equal(noVectors.embedded, 0)
  assert.equal(noVectors.pending, 3)
  assert.equal(noVectors.duplicateSampled, 0, '没有向量就不做重复率估计')
  assert.match(noVectors.explain.join('\n'), /跳过重复率估计/)
})

test('重复率：抽样余弦命中重复对，比例分母是抽样锚点数', () => {
  // a≈b 是重复对；c/d 与谁都不像。
  const records = [rec('a'), rec('b'), rec('c'), rec('d')]
  const vectors = new Map<string, Float32Array>([
    ['a', vec(1, 0, 0)],
    ['b', vec(1, 0.01, 0)],
    ['c', vec(0, 1, 0)],
    ['d', vec(0, 0, 1)],
  ])
  const report = computeHealth(records, { vectors, duplicateSample: 10, now: 1 })
  assert.equal(report.duplicateSampled, 4, '抽样上限大于记录数时全量比较')
  assert.equal(report.duplicatePairs, 1)
  assert.equal(report.duplicateRate, 0.5, 'a、b 两个锚点各有一个重复邻居')
  assert.equal(report.duplicateDetails.length, 1)
  const pair = report.duplicateDetails[0]!
  assert.deepEqual(new Set([pair.a, pair.b]), new Set(['a', 'b']))
  assert.ok(pair.similarity >= DEFAULT_DUPLICATE_THRESHOLD)
})

test('重复率抽样上限：只比较 duplicateSample 个锚点，且结果确定（同样输入同样输出）', () => {
  const records = Array.from({ length: 30 }, (_, i) => rec(`r${String(i).padStart(2, '0')}`))
  const vectors = new Map<string, Float32Array>(records.map((record) => [String(record.id), vec(1, 0)]))
  const first = computeHealth(records, { vectors, duplicateSample: 6 })
  const second = computeHealth(records, { vectors, duplicateSample: 6 })
  assert.equal(first.duplicateSampled, 6)
  assert.equal(first.duplicateRate, 1)
  assert.ok(first.duplicatePairs > 0)
  assert.deepEqual(first.duplicateDetails, second.duplicateDetails, '抽样必须确定性')
  assert.deepEqual(first.breakdown, second.breakdown)
})

test('重复阈值可配：0.9 相似度在 0.92 下不算重复、在 0.85 下算', () => {
  const records = [rec('a'), rec('b')]
  // 两个单位向量的余弦 ≈ 0.9。
  const vectors = new Map<string, Float32Array>([
    ['a', vec(1, 0)],
    ['b', vec(0.9, Math.sqrt(1 - 0.9 * 0.9))],
  ])
  const strict = computeHealth(records, { vectors })
  assert.equal(strict.duplicateRate, 0)
  const loose = computeHealth(records, { vectors, duplicateThreshold: 0.85 })
  assert.equal(loose.duplicateRate, 1)
  assert.equal(loose.duplicatePairs, 1)
})

test('各项比例分母都是 total（重复率除外）', () => {
  const now = 10_000
  const records = [
    rec('tomb', { tombstonedAt: 1 }),
    rec('dormant', { dormantAt: 1 }),
    rec('invalid', { expiredAt: 1 }),
    rec('conflict', { conflictWith: ['tomb'] }),
    rec('quarantined', { quarantinedAt: 1 }),
  ]
  const report = computeHealth(records, { now })
  for (const key of ['conflictRate', 'invalidRate', 'dormantRate', 'tombstoneRate', 'quarantineRate'] as const) {
    assert.equal(report[key], 0.2, `${key} 分母应为 total`)
  }
  assert.equal(report.pendingEmbedRate, 1, '没有向量 → 全部待嵌入')
})

test('扣分公式：全墓碑库 = 100 - 墓碑 10 - 待嵌入 10 = 80', () => {
  const now = 1_000_000
  const records = Array.from({ length: 4 }, (_, i) => rec(`t${i}`, { tombstonedAt: 1 }))
  const report = computeHealth(records, { now })
  const byKey = new Map(report.breakdown.map((item) => [item.key, item]))
  assert.equal(byKey.get('tombstone')!.deduction, 10)
  assert.equal(byKey.get('pendingEmbed')!.deduction, 10)
  assert.equal(byKey.get('conflict')!.deduction, 0)
  assert.equal(report.score, 80)
})

test('健康分下限 0：多个坏项同时拉满也不会变负', () => {
  const now = 10_000
  const records: Array<Record<string, unknown>> = []
  // 2 失效 + 2 墓碑 + 2 隔离 + 2 休眠 + 2 活跃冲突（活跃两条互为重复且带向量）
  for (const id of ['i1', 'i2']) records.push(rec(id, { expiredAt: 1 }))
  for (const id of ['t1', 't2']) records.push(rec(id, { tombstonedAt: 1 }))
  for (const id of ['q1', 'q2']) records.push(rec(id, { quarantinedAt: 1 }))
  for (const id of ['d1', 'd2']) records.push(rec(id, { dormantAt: 1 }))
  for (const id of ['c1', 'c2']) records.push(rec(id, { conflictWith: ['c1', 'c2'] }))
  const vectors = new Map<string, Float32Array>([
    ['c1', vec(1, 0)],
    ['c2', vec(1, 0)],
  ])
  const report = computeHealth(records, { now, vectors })
  assert.ok(report.score >= 0 && report.score <= 100)
  assert.equal(report.score, 0, '坏项叠加到超过 100 分时封顶 0')
  const deductionSum = report.breakdown.reduce((sum, item) => sum + item.deduction, 0)
  assert.ok(deductionSum > 100)
})

test('平均保持度 / 效用：只统计带该字段的记录', () => {
  const records = [
    rec('a', { stability: 2, utility: 0.2 }),
    rec('b', { stability: 4, utility: 0.8 }),
    rec('c'),
  ]
  const report = computeHealth(records, {})
  assert.equal(report.avgStability, 3)
  assert.equal(report.avgUtility, 0.5)
  assert.deepEqual(report.samples, { stability: 2, utility: 2 })
})

test('墓碑到期统计：tombstoneExpiresAt 到点或超过保留窗口都算可清理', () => {
  const now = 100 * 86_400_000
  const records = [
    rec('expired', { tombstonedAt: now - 40 * 86_400_000, tombstoneExpiresAt: now - 1 }),
    rec('fresh', { tombstonedAt: now - 1 * 86_400_000, tombstoneExpiresAt: now + 86_400_000 }),
    rec('legacy', { tombstonedAt: now - 40 * 86_400_000 }),
  ]
  const report = computeHealth(records, { now })
  assert.equal(report.tombstoned, 3)
  assert.equal(report.tombstonePurgeable, 2, 'legacy 没有 expiresAt 时按保留窗口(30 天)推算')

  const shortWindow = computeHealth(records, { now, tombstoneDays: 60 })
  assert.equal(shortWindow.tombstonePurgeable, 1, '保留窗口调大后 legacy 还没到期')
})

test('纯函数：不修改入参记录', () => {
  const records = [
    rec('a', { dormantAt: 1 }),
    rec('b', { conflictWith: ['a'], conflictConfidence: 0.7 }),
  ]
  const snapshot = JSON.stringify(records)
  const vectors = new Map<string, Float32Array>([['a', vec(1, 0)]])
  computeHealth(records, { vectors, now: 10 })
  assert.equal(JSON.stringify(records), snapshot)
})

test('真实 store 集成：records + vectors 直接喂 computeHealth', () => {
  const store = freshStore()
  const scope = 'project:health'
  const a = store.save({ scope, kind: 'note', content: '端口 8080' } as SaveInput, DEFAULTS).record
  const b = store.save({ scope, kind: 'note', content: '端口 8080（重复）' } as SaveInput, DEFAULTS).record
  const s = store.scope(scope)
  s.setVector(a.id, vec(1, 0))
  s.setVector(b.id, vec(1, 0))
  const report = computeHealth(s.records.values(), { vectors: s.vectors, now: Date.now() })
  assert.equal(report.total, 2)
  assert.equal(report.embedded, 2)
  assert.equal(report.pending, 0)
  assert.equal(report.duplicatePairs, 1)
  assert.ok(report.score < 100, '重复对会扣分')
  assert.ok(report.explain.some((line) => line.includes('健康分')))
  assert.equal(DEFAULT_DUPLICATE_SAMPLE, 64)
  assert.equal(HEALTH_SCORE_RULES.length, 7)
})
