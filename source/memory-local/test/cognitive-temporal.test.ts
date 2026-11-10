/**
 * 时间有效性（cognitive/temporal）：有效期边界、失效计划、时间权重、落盘入口。
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, type CognitiveRecord } from '../src/store.ts'
import { tombstone } from '../src/cognitive/lifecycle.ts'
import {
  EXPIRY_PENALTY,
  FRESH_BONUS,
  applyValidityPlan,
  inactiveReason,
  isActiveNow,
  isValidAt,
  planValidityOnConflict,
  temporalBoost,
  temporalBoostDetail,
  validFromOf,
  validUntilOf,
} from '../src/cognitive/temporal.ts'

const DAY = 86_400_000
// 固定在一个月后的时间点：记录都是"现在"写入的，在 NOW 时刻它们已经生效。
const NOW = Date.now() + 30 * DAY

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const DEFAULTS = { importance: 0.5, source: { origin: 'explicit' as const } }
type SaveInput = Parameters<MemoryStore['save']>[0]

function freshStore(): MemoryStore {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cog-temporal-'))
  dirs.push(dir)
  return new MemoryStore(dir)
}

function save(store: MemoryStore, content: string, extra: Record<string, unknown> = {}): CognitiveRecord {
  return store.save({ scope: 'project:t', kind: 'fact', content, ...extra } as SaveInput, DEFAULTS).record as CognitiveRecord
}

// ---------------------------------------------------------------- 有效期字段

test('validFromOf / validUntilOf：缺省取 createdAt / +∞', () => {
  const store = freshStore()
  const record = save(store, '设备是 aarch64')
  assert.equal(validFromOf(record), record.createdAt)
  assert.equal(validUntilOf(record), Number.POSITIVE_INFINITY)
})

test('validFromOf / validUntilOf：显式字段优先', () => {
  const store = freshStore()
  const record = save(store, '端口是 8080', { validFrom: 1000, validUntil: 5000 })
  assert.equal(validFromOf(record), 1000)
  assert.equal(validUntilOf(record), 5000)
})

test('isValidAt：左闭右开 [validFrom, validUntil)', () => {
  const store = freshStore()
  const record = save(store, '端口是 8080', { validFrom: 1000, validUntil: 5000 })
  assert.equal(isValidAt(record, 999), false, '生效前无效')
  assert.equal(isValidAt(record, 1000), true, '起点闭区间：到点即生效')
  assert.equal(isValidAt(record, 4999), true)
  assert.equal(isValidAt(record, 5000), false, 'validUntil 是失效时刻：到点即失效')
  assert.equal(isValidAt(record, 6000), false)
})

test('isValidAt：缺省 validUntil=∞，任意未来时刻都有效', () => {
  const store = freshStore()
  const record = save(store, '设备是 aarch64')
  assert.equal(isValidAt(record, record.createdAt), true)
  assert.equal(isValidAt(record, NOW + 1000 * DAY), true)
})

// ---------------------------------------------------------------- 当前可用性

test('isActiveNow：普通老记录天然有效（缺省字段不影响旧行为）', () => {
  const store = freshStore()
  const record = save(store, '普通记录')
  assert.equal(isActiveNow(record, NOW), true)
  assert.equal(inactiveReason(record, NOW), undefined)
})

test('isActiveNow：tombstone / TTL / 未来生效 / 已失效 都算不可用', () => {
  const store = freshStore()
  const tombstoned = save(store, '被软删的')
  tombstone(store, tombstoned.id, { now: NOW })
  const tombstonedRecord = store.findById(tombstoned.id) as CognitiveRecord
  assert.equal(isActiveNow(tombstonedRecord, NOW), false)
  assert.equal(inactiveReason(tombstonedRecord, NOW), 'tombstoned')

  const expired = save(store, 'TTL 到点的', { expiredAt: NOW - 1 })
  assert.equal(inactiveReason(expired, NOW), 'expired')

  const future = save(store, '未来才生效的', { validFrom: NOW + DAY })
  assert.equal(isActiveNow(future, NOW), false)
  assert.equal(inactiveReason(future, NOW), 'not-yet-valid')
  assert.equal(isActiveNow(future, NOW + DAY), true, '到点生效')

  const stale = save(store, '已失效的', { validUntil: NOW - 1 })
  assert.equal(isActiveNow(stale, NOW), false)
  assert.equal(inactiveReason(stale, NOW), 'invalidated')
})

test('inactiveReason：软删优先级最高（即使同时过期）', () => {
  const store = freshStore()
  const record = save(store, '又过期又软删', { validUntil: NOW - 10, expiredAt: NOW - 5 })
  tombstone(store, record.id, { now: NOW })
  assert.equal(inactiveReason(store.findById(record.id) as CognitiveRecord, NOW), 'tombstoned')
})

// ---------------------------------------------------------------- 冲突 → 失效计划

test('planValidityOnConflict：关键细节（数值）被推翻 → 旧记录 validUntil=now', () => {
  const store = freshStore()
  const old = save(store, '内存上限是 10.4GB')
  const plan = planValidityOnConflict({ oldRecord: old, newContent: '内存上限是 20GB', similarity: 0.96, now: NOW })
  assert.equal(plan.invalidateOld, true)
  assert.equal(plan.validUntil, NOW)
  assert.equal(plan.reason, 'critical-detail-conflict')
  assert.equal(plan.assessment.level, 'high')
  assert.ok(plan.confidence >= 0.6, `置信度 ${plan.confidence} 应达到 high`)
})

test('planValidityOnConflict：端口这种"差异率极小但确实变了"的也失效', () => {
  const store = freshStore()
  const old = save(store, '服务端口是 8080')
  const plan = planValidityOnConflict({ oldRecord: old, newContent: '服务端口是 8078', similarity: 0.98, now: NOW })
  assert.equal(plan.invalidateOld, true)
  assert.equal(plan.reason, 'critical-detail-conflict')
  assert.ok(plan.confidence >= 0.3, '关键细节不一致的布尔证据兜底，不该因为差异率小而判低')
  assert.equal(plan.assessment.signals.criticalDetailConflict, true)
})

test('planValidityOnConflict：同内容重述 → 刷新，不失效', () => {
  const store = freshStore()
  const old = save(store, '设备是 aarch64')
  const plan = planValidityOnConflict({ oldRecord: old, newContent: '  设备是 AARCH64 ', similarity: 0.99, now: NOW })
  assert.equal(plan.invalidateOld, false)
  assert.equal(plan.reason, 'identical-content')
  assert.equal(plan.validUntil, undefined)
})

test('planValidityOnConflict：相似度不到冲突区 → 不相干，不失效', () => {
  const store = freshStore()
  const old = save(store, '内存上限是 10.4GB')
  const plan = planValidityOnConflict({ oldRecord: old, newContent: '内存上限是 20GB', similarity: 0.5, now: NOW })
  assert.equal(plan.invalidateOld, false)
  assert.equal(plan.reason, 'unrelated')
})

test('planValidityOnConflict：相关但无关键细节冲突 → 只标冲突，不失效', () => {
  const store = freshStore()
  const old = save(store, '使用 pnpm 安装依赖')
  const plan = planValidityOnConflict({ oldRecord: old, newContent: '用 pnpm 安装依赖包', similarity: 0.85, now: NOW })
  assert.equal(plan.invalidateOld, false)
  assert.equal(plan.reason, 'soft-conflict')
  assert.equal(plan.validUntil, undefined)
})

test('planValidityOnConflict：旧记录已失效 → 幂等，不重复写', () => {
  const store = freshStore()
  const old = save(store, '内存上限是 10.4GB', { validUntil: NOW - 1 })
  const plan = planValidityOnConflict({ oldRecord: old, newContent: '内存上限是 20GB', similarity: 0.96, now: NOW })
  assert.equal(plan.invalidateOld, false)
  assert.equal(plan.reason, 'already-invalid')
})

test('planValidityOnConflict：自定义冲突下界生效', () => {
  const store = freshStore()
  const old = save(store, '内存上限是 10.4GB')
  const plan = planValidityOnConflict({ oldRecord: old, newContent: '内存上限是 20GB', similarity: 0.8, now: NOW, minSimilarity: 0.9 })
  assert.equal(plan.reason, 'unrelated')
  assert.equal(plan.invalidateOld, false)
})

test('applyValidityPlan：把 validUntil 落进 store，记录保留但默认不可用', () => {
  const store = freshStore()
  const old = save(store, '内存上限是 10.4GB')
  const plan = planValidityOnConflict({ oldRecord: old, newContent: '内存上限是 20GB', similarity: 0.96, now: NOW })
  assert.equal(applyValidityPlan(store, old.id, plan), true)
  const updated = store.findById(old.id) as CognitiveRecord
  assert.equal(updated.validUntil, NOW)
  assert.equal(updated.content, '内存上限是 10.4GB', '正文不动，只失效')
  assert.equal(isActiveNow(updated, NOW), false)
  assert.equal(isActiveNow(updated, NOW - 1), true, '失效前的时间点历史查询仍有效')
})

test('applyValidityPlan：不失效 / 找不到 id 时返回 false 且不写', () => {
  const store = freshStore()
  const old = save(store, '使用 pnpm 安装依赖')
  const soft = planValidityOnConflict({ oldRecord: old, newContent: '用 pnpm 安装依赖包', similarity: 0.85, now: NOW })
  assert.equal(applyValidityPlan(store, old.id, soft), false)
  assert.equal((store.findById(old.id) as CognitiveRecord).validUntil, undefined)

  const plan = planValidityOnConflict({ oldRecord: old, newContent: '内存上限是 20GB', similarity: 0.96, now: NOW })
  assert.equal(applyValidityPlan(store, '不存在-id', plan), false)
})

// ---------------------------------------------------------------- 时间权重

test('temporalBoost：刚更新的记录获得加成，范围 (1, 1+FRESH_BONUS]', () => {
  const store = freshStore()
  const record = save(store, '刚确认的事实')
  // save 的 updatedAt 是真实 Date.now()，这里用记录自身时间当 now 保证 age=0。
  const boost = temporalBoost(record, record.updatedAt)
  assert.ok(boost > 1 && boost <= 1 + FRESH_BONUS + 1e-12, `boost=${boost}`)
})

test('temporalBoost：老记录退化为 1（不再新鲜，也没有失效风险）', () => {
  const store = freshStore()
  const record = save(store, '很久以前的事实')
  const boost = temporalBoost(record, record.updatedAt + 30 * DAY)
  assert.equal(boost, 1)
})

test('temporalBoost：临近失效降权，越近越低', () => {
  const store = freshStore()
  const record = save(store, '即将过期的事实', { validUntil: NOW + 6 * DAY })
  const base = { ...record, updatedAt: NOW - 30 * DAY } as CognitiveRecord
  const near = temporalBoost(base, NOW)
  const nearer = temporalBoost(base, NOW + 5 * DAY)
  assert.ok(near < 1, '进入临近失效窗口就开始降权')
  assert.ok(nearer < near, `越接近失效降权越多（${nearer} < ${near}）`)
  assert.ok(near >= 1 - EXPIRY_PENALTY - 1e-12)
})

test('temporalBoost：失效 / 软删 / 过期记录权重为 0', () => {
  const store = freshStore()
  const stale = save(store, '已失效', { validUntil: NOW - 1 })
  assert.equal(temporalBoost(stale, NOW), 0)
  const expired = save(store, 'TTL 到点', { expiredAt: NOW - 1 })
  assert.equal(temporalBoost(expired, NOW), 0)
  const doomed = save(store, '软删')
  tombstone(store, doomed.id, { now: NOW })
  assert.equal(temporalBoost(store.findById(doomed.id) as CognitiveRecord, NOW), 0)
})

test('temporalBoostDetail：分解因子可解释、乘积等于 boost', () => {
  const store = freshStore()
  const record = save(store, '刚更新但快失效', { validUntil: NOW + 2 * DAY })
  const detail = temporalBoostDetail({ ...record, updatedAt: NOW } as CognitiveRecord, NOW)
  assert.equal(detail.active, true)
  assert.ok(detail.freshFactor > 1)
  assert.ok(detail.expiryFactor < 1)
  assert.ok(Math.abs(detail.boost - detail.freshFactor * detail.expiryFactor) < 1e-12)
  assert.equal(detail.remainingDays, 2)

  const invalid = temporalBoostDetail(record, record.createdAt + 400 * DAY)
  assert.equal(invalid.boost, 0)
  assert.equal(invalid.active, false)
})
