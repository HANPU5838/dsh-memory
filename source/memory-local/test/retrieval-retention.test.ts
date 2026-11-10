/**
 * retention.ts 测试(0.33.0):FSRS 式保持度 / 初始强度 / 取用更新 / 效用 / 综合分。
 *
 * 覆盖点:
 *   - 公式单调性(时间↓、稳定性↑、质量↑、难度↓、间隔效应)
 *   - 边界(空内容、零/负参数、NaN、上下限夹取)
 *   - 确定性(纯函数、不改入参、同输入同输出)
 * 期望值优先用公式现场推导,少量手算常数。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_KIND,
  FALLBACK_DIFFICULTY,
  FALLBACK_STABILITY_DAYS,
  GROWTH_FACTOR,
  GROWTH_POWER,
  IMPORTANCE_FLOOR,
  KIND_DIFFICULTY,
  KIND_STABILITY_DAYS,
  LAPSE_MULTIPLIER,
  LENGTH_DIFFICULTY_MAX,
  MAX_STABILITY_DAYS,
  MIN_STABILITY_DAYS,
  QUALITY_DIFFICULTY_DELTA,
  QUALITY_EASE,
  QUALITY_REWARD,
  SPACING_EXP,
  UTILITY_ALPHA,
  UTILITY_UPLIFT_WEIGHT,
  daysBetween,
  importanceFactor,
  initialDifficulty,
  initialStability,
  initialStrength,
  normalizeQuality,
  recordStrength,
  retrievability,
  retrievabilityOf,
  stabilityOf,
  strengthBreakdown,
  updateAfterUse,
  utilityScore,
  utilityUplift,
} from '../src/retrieval/retention.ts'

function close(actual: number, expected: number, eps = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= eps, `expected ${expected}, got ${actual}`)
}

const DAY = 86_400_000
const NOW = 1_800_000_000_000

// ---------------------------------------------------------------------------
// 初始强度
// ---------------------------------------------------------------------------

test('initialStability:kind 先验满足"稳定类型 > 易变类型"', () => {
  assert.ok(initialStability('', 'preference') > initialStability('', 'decision'))
  assert.ok(initialStability('', 'decision') > initialStability('', 'fact'))
  assert.ok(initialStability('', 'fact') > initialStability('', 'note'))
  assert.ok(initialStability('', 'note') > initialStability('', 'state'))
  close(initialStability('', 'fact'), KIND_STABILITY_DAYS.fact!)
  close(initialStability('', 'state'), KIND_STABILITY_DAYS.state!)
  close(initialStability('', 'unknown-kind'), FALLBACK_STABILITY_DAYS, 1e-12)
  close(initialStability('', ''), KIND_STABILITY_DAYS[DEFAULT_KIND]!, 1e-12)
})

test('initialStability:长内容略低(log 饱和),且始终落在上下限内', () => {
  const short = initialStability('x'.repeat(10), 'fact')
  const medium = initialStability('x'.repeat(400), 'fact')
  const long = initialStability('x'.repeat(4000), 'fact')
  assert.ok(short > medium && medium > long, '越长初始稳定性越低')
  // 饱和度有限:4000 字与 40000 字差距远小于 400 与 4000 的差距
  const huge = initialStability('x'.repeat(40_000), 'fact')
  assert.ok(long - huge < medium - long)

  for (const kind of ['fact', 'state', 'note', 'rule', 'unknown']) {
    for (const text of ['', 'x'.repeat(10_000)]) {
      const s = initialStability(text, kind)
      assert.ok(s >= MIN_STABILITY_DAYS && s <= MAX_STABILITY_DAYS, `越界:${s}`)
      assert.ok(Number.isFinite(s))
    }
  }
})

test('initialDifficulty:易变 / 长内容更难,结果夹在 0..1', () => {
  assert.ok(initialDifficulty('', 'state') > initialDifficulty('', 'note'))
  assert.ok(initialDifficulty('', 'note') > initialDifficulty('', 'procedure'))
  assert.ok(initialDifficulty('', 'procedure') > initialDifficulty('', 'rule'))
  close(initialDifficulty('', 'fact'), KIND_DIFFICULTY.fact!)
  close(initialDifficulty('', 'nope'), FALLBACK_DIFFICULTY, 1e-12)
  close(initialDifficulty(''), FALLBACK_DIFFICULTY, 1e-12)

  const short = initialDifficulty('x'.repeat(10), 'fact')
  const medium = initialDifficulty('x'.repeat(300), 'fact')
  const long = initialDifficulty('x'.repeat(3000), 'fact')
  assert.ok(short < medium && medium < long, '越长越难')
  // 长度项有上限:LENGTH_DIFFICULTY_MAX,所以长内容不会把难度顶满 1
  assert.ok(long - KIND_DIFFICULTY.fact! <= LENGTH_DIFFICULTY_MAX + 1e-12)
  assert.ok(initialDifficulty('x'.repeat(100_000), 'state') <= 1)
  assert.ok(initialDifficulty('', 'state') >= 0)
})

// ---------------------------------------------------------------------------
// 保持度 R(t)
// ---------------------------------------------------------------------------

test('retrievability:t=0 → 1;t=9S → 0.5;严格递减且夹在 (0,1]', () => {
  close(retrievability(0, 3), 1, 1e-12)
  close(retrievability(9 * 3, 3), 0.5, 1e-12)
  close(retrievability(30, 3), 1 / (1 + 30 / 27), 1e-12)

  let prev = Number.POSITIVE_INFINITY
  for (const t of [0, 1, 5, 10, 50, 100, 1000, 3650]) {
    const r = retrievability(t, 3)
    assert.ok(r > 0 && r <= 1, `R 越界:${r}`)
    assert.ok(r < prev, 'R 必须随 t 严格递减')
    prev = r
  }
})

test('retrievability:稳定性越高保持度越高,同一时刻严格单调', () => {
  let prev = -1
  for (const s of [0.5, 1, 3, 10, 100, 10_000]) {
    const r = retrievability(30, s)
    assert.ok(r > prev, 'S 越大 R 越大')
    prev = r
  }
})

test('retrievability:负时间/NaN/零稳定性等边界不产生 NaN 或越界', () => {
  close(retrievability(-5, 3), 1, 1e-12)
  close(retrievability(Number.NaN, 3), 1, 1e-12)
  const zeroStability = retrievability(10, 0)
  close(zeroStability, retrievability(10, MIN_STABILITY_DAYS), 1e-12)
  close(retrievability(10, Number.NaN), retrievability(10, FALLBACK_STABILITY_DAYS), 1e-12)
  close(retrievability(Number.POSITIVE_INFINITY, 3), 0, 1e-12, )
  assert.ok(Number.isFinite(retrievability(Number.POSITIVE_INFINITY, 3)), '无穷时间给 0,不是 NaN')
})

test('daysBetween:单位是天,未来时间按 0', () => {
  close(daysBetween(NOW, NOW + 3 * DAY), 3, 1e-12)
  close(daysBetween(NOW + 10 * DAY, NOW), 0, 1e-12)
  close(daysBetween(undefined, NOW), 0, 1e-12)
  close(daysBetween(Number.NaN, NOW), 0, 1e-12)
})

test('stabilityOf:显式 stability 优先;老记录按内容/kind/访问次数推导', () => {
  close(stabilityOf({ stability: 5 }), 5, 1e-12)
  // 非法显式值回退到推导
  const fallback = stabilityOf({ content: 'x', kind: 'fact' })
  assert.ok(fallback > 0 && fallback <= MAX_STABILITY_DAYS)
  // 相同内容:访问次数越多,兼容稳定性越高(1+0.5·ln(1+n))
  const used = stabilityOf({ content: 'x', kind: 'fact', accessCount: 8 })
  const fresh = stabilityOf({ content: 'x', kind: 'fact', accessCount: 0 })
  assert.ok(used > fresh)
  close(used / fresh, (1 + 0.5 * Math.log1p(8)) / 1, 1e-12)
  // 已知难度会折减兼容稳定性
  const hard = stabilityOf({ content: 'x', kind: 'fact', difficulty: 1 })
  close(hard / fresh, 0.5, 1e-12)
})

test('retrievabilityOf:锚点优先 lastUsedAt,其次 createdAt;缺失视为刚刚', () => {
  close(retrievabilityOf({ stability: 3, lastUsedAt: NOW - 3 * DAY }, NOW), retrievability(3, 3), 1e-12)
  close(
    retrievabilityOf({ stability: 3, lastUsedAt: NOW - 3 * DAY, createdAt: NOW - 100 * DAY }, NOW),
    retrievability(3, 3),
    1e-12,
    'lastUsedAt 优先于 createdAt',
  )
  close(retrievabilityOf({ stability: 3, createdAt: NOW - 3 * DAY }, NOW), retrievability(3, 3), 1e-12)
  close(retrievabilityOf({ stability: 3 }, NOW), 1, 1e-12)
})

// ---------------------------------------------------------------------------
// 取用更新
// ---------------------------------------------------------------------------

/** 复习前 R≈0.9 的状态(便于比较质量增益,不会撞到增长上限)。 */
const REVIEWED_STATE = { stability: 3, difficulty: 0.4, utility: 0.4, useCount: 2, lastUsedAt: NOW - 3 * DAY }

test('updateAfterUse:成功取用提升稳定性,质量越高提升越大', () => {
  const hard = updateAfterUse(REVIEWED_STATE, 2, NOW)
  const good = updateAfterUse(REVIEWED_STATE, 3, NOW)
  const easy = updateAfterUse(REVIEWED_STATE, 4, NOW)
  assert.ok(hard.stability > REVIEWED_STATE.stability)
  assert.ok(hard.stability < good.stability && good.stability < easy.stability)
})

test('updateAfterUse:间隔效应 —— 复习前保持度越低,增益越大', () => {
  const base = { stability: 5, difficulty: 0.4, utility: 0, useCount: 0 }
  const immediate = updateAfterUse({ ...base, lastUsedAt: NOW }, 3, NOW)
  const oneInterval = updateAfterUse({ ...base, lastUsedAt: NOW - 5 * DAY }, 3, NOW)
  const longInterval = updateAfterUse({ ...base, lastUsedAt: NOW - 100 * DAY }, 3, NOW)
  close(immediate.stability, 5, 1e-12, ) // R=1 ⇒ 间隔收益项为 0,原样保留
  assert.ok(oneInterval.stability > immediate.stability)
  assert.ok(longInterval.stability > oneInterval.stability)
})

test('updateAfterUse:难度越高,单次复习的稳定性增益越小', () => {
  const easyToRecall = updateAfterUse({ ...REVIEWED_STATE, difficulty: 0.1 }, 3, NOW)
  const hardToRecall = updateAfterUse({ ...REVIEWED_STATE, difficulty: 0.9 }, 3, NOW)
  assert.ok(easyToRecall.stability > hardToRecall.stability)
})

test('updateAfterUse:增益有上限,不会单次爆炸', () => {
  // 极低保持度 + 极低难度:原始增益远超 MAX_GROWTH
  const result = updateAfterUse({ stability: 3, difficulty: 0, lastUsedAt: NOW - 3650 * DAY }, 4, NOW)
  const rawGrowth = GROWTH_FACTOR
    * (11 - (1 + 9 * 0))
    * Math.pow(3, -GROWTH_POWER)
    * (Math.exp(SPACING_EXP * (1 - retrievability(3650, 3))) - 1)
    * QUALITY_EASE[4]!
  assert.ok(rawGrowth > 3)
  close(result.stability, Math.min(MAX_STABILITY_DAYS, 3 * 4), 1e-9)
})

test('updateAfterUse:遗忘(quality=1)缩短稳定性、抬高难度,但不低于下限', () => {
  const result = updateAfterUse({ stability: 3, difficulty: 0.4, utility: 0.6, useCount: 5, lastUsedAt: NOW - DAY }, 1, NOW)
  close(result.stability, 3 * LAPSE_MULTIPLIER, 1e-12)
  close(result.difficulty, 0.4 + QUALITY_DIFFICULTY_DELTA[1]!, 1e-12)
  assert.equal(result.useCount, 5, '遗忘不算成功取用')
  close(result.utility, (1 - UTILITY_ALPHA) * 0.6 + UTILITY_ALPHA * QUALITY_REWARD[1]!, 1e-12)

  // 已经是下限:再遗忘不会变成 0 / 负数
  const floor = updateAfterUse({ stability: MIN_STABILITY_DAYS, useCount: 0 }, 1, NOW)
  close(floor.stability, MIN_STABILITY_DAYS, 1e-12)
  assert.ok(floor.stability > 0)
})

test('updateAfterUse:utility 是 EWMA,useCount 只统计成功取用,lastUsedAt=now', () => {
  const good = updateAfterUse(REVIEWED_STATE, 3, NOW)
  close(good.utility, (1 - UTILITY_ALPHA) * 0.4 + UTILITY_ALPHA * QUALITY_REWARD[3]!, 1e-12)
  assert.equal(good.useCount, 3)
  assert.equal(good.lastUsedAt, NOW)
  // 难度按评分增量更新(Good 略微下降)
  close(good.difficulty, Math.min(1, Math.max(0, 0.4 + QUALITY_DIFFICULTY_DELTA[3]!)), 1e-12)
})

test('updateAfterUse:缺省状态/时间防御,结果字段齐全且有限', () => {
  const fromEmpty = updateAfterUse({}, 3, NOW)
  for (const key of ['stability', 'difficulty', 'utility', 'useCount', 'lastUsedAt'] as const) {
    assert.ok(Number.isFinite(fromEmpty[key]), `${key} 必须是有限数`)
  }
  assert.equal(fromEmpty.useCount, 1, '首次成功取用计数为 1')
  const badQuality = updateAfterUse(REVIEWED_STATE, Number.NaN, NOW)
  const defaultQuality = updateAfterUse(REVIEWED_STATE, 3, NOW)
  close(badQuality.stability, defaultQuality.stability, 1e-12)
  close(badQuality.utility, defaultQuality.utility, 1e-12)
  assert.equal(updateAfterUse(REVIEWED_STATE, 3, Number.NaN).lastUsedAt, REVIEWED_STATE.lastUsedAt)
})

test('normalizeQuality:夹到 1..4,非数值 → Good', () => {
  assert.equal(normalizeQuality(1), 1)
  assert.equal(normalizeQuality(2), 2)
  assert.equal(normalizeQuality(3), 3)
  assert.equal(normalizeQuality(4), 4)
  assert.equal(normalizeQuality(0.2), 1)
  assert.equal(normalizeQuality(9), 4)
  assert.equal(normalizeQuality(-3), 1)
  assert.equal(normalizeQuality(Number.NaN), 3)
  assert.equal(normalizeQuality(undefined), 3)
})

test('updateAfterUse:确定性 —— 同输入同输出且不修改入参', () => {
  const state = { ...REVIEWED_STATE }
  const snapshot = JSON.stringify(state)
  const a = updateAfterUse(state, 3, NOW)
  const b = updateAfterUse(state, 3, NOW)
  assert.deepEqual(a, b)
  assert.equal(JSON.stringify(state), snapshot, '入参不能被修改')
})

test('initialStrength:按内容 + kind 初始化,utility/useCount 从 0 开始', () => {
  const created = NOW - 5 * DAY
  const init = initialStrength('部署端口是 8080', 'fact', created)
  close(init.stability, initialStability('部署端口是 8080', 'fact'), 1e-12)
  close(init.difficulty, initialDifficulty('部署端口是 8080', 'fact'), 1e-12)
  assert.equal(init.utility, 0)
  assert.equal(init.useCount, 0)
  assert.equal(init.lastUsedAt, created)
})

// ---------------------------------------------------------------------------
// 效用 / 重要度 / 综合分
// ---------------------------------------------------------------------------

test('utilityScore:从未取用为 0;次数置信度递增;30 天衰减一半', () => {
  const base = { utility: 0.8, useCount: 2, lastUsedAt: NOW }
  close(utilityScore({ ...base, utility: 0 }, NOW), 0, 1e-12)
  close(utilityScore(base, NOW), 0.8 * (1 - Math.pow(0.5, 1)), 1e-12)
  close(utilityScore({ ...base, useCount: 4 }, NOW), 0.8 * (1 - Math.pow(0.5, 2)), 1e-12)
  close(utilityScore({ ...base, useCount: 8 }, NOW), 0.8 * (1 - Math.pow(0.5, 4)), 1e-12)
  close(utilityScore(base, NOW + 30 * DAY), utilityScore(base, NOW) * 0.5, 1e-12)
  for (const useCount of [0, 1, 2, 10, 100]) {
    const score = utilityScore({ utility: 0.9, useCount, lastUsedAt: NOW }, NOW)
    assert.ok(score >= 0 && score <= 1, `utilityScore 越界:${score}`)
  }
})

test('utilityUplift / importanceFactor:范围与单调', () => {
  close(utilityUplift({}, NOW), 1, 1e-12)
  const used = utilityUplift({ utility: 1, useCount: 100, lastUsedAt: NOW }, NOW)
  assert.ok(used > 1 && used <= 1 + UTILITY_UPLIFT_WEIGHT + 1e-12)
  close(utilityUplift({ utility: 1, useCount: 100, lastUsedAt: NOW }, NOW, 0), 1, 1e-12)

  close(importanceFactor(undefined), IMPORTANCE_FLOOR, 1e-12)
  close(importanceFactor(1), 1, 1e-12)
  close(importanceFactor(0.5), IMPORTANCE_FLOOR + (1 - IMPORTANCE_FLOOR) * 0.5, 1e-12)
  assert.ok(importanceFactor(2) <= 1 && importanceFactor(-1) >= IMPORTANCE_FLOOR)
})

test('recordStrength:综合分 = 保持度 × 效用提升 × 重要度因子,且不改入参', () => {
  const record = {
    content: '部署端口是 8080',
    kind: 'fact',
    importance: 1,
    utility: 1,
    useCount: 100,
    lastUsedAt: NOW,
    createdAt: NOW,
  }
  const snapshot = JSON.stringify(record)
  const breakdown = strengthBreakdown(record, NOW)
  close(breakdown.retention, 1, 1e-12)
  close(breakdown.utility, utilityScore(record, NOW), 1e-12)
  close(breakdown.importance, 1, 1e-12)
  close(breakdown.score, breakdown.retention * breakdown.utilityUplift * breakdown.importance, 1e-12)
  close(recordStrength(record, NOW), breakdown.score, 1e-12)
  assert.equal(JSON.stringify(record), snapshot, '入参不能被修改')

  // 重要性 0 → 只保留 50%;老记录(无 stability)也能算出综合分
  const plain = { content: 'x', kind: 'fact', createdAt: NOW - 10 * DAY }
  close(strengthBreakdown({ ...plain, importance: 0 }, NOW).importance, IMPORTANCE_FLOOR, 1e-12)
  const old = recordStrength(plain, NOW)
  assert.ok(old > 0 && old < 1)
})
