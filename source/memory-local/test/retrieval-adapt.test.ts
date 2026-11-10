/**
 * adapt.ts 测试(0.32.0):查询长度自适应阈值 + 跨 scope 分数校准。
 * 期望值全部手算,不依赖实现(阈值公式本身是被测对象)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_GLOBAL_THRESHOLD,
  DEFAULT_PROJECT_THRESHOLD,
  DEFAULT_SHORT_RELAX,
  MAX_ADAPTIVE_THRESHOLD,
  MIN_ADAPTIVE_THRESHOLD,
  adaptiveScopeThreshold,
  adaptiveThreshold,
  calibrateHits,
  calibrateScore,
  classifyQuery,
  createScopeCalibration,
  profileQuery,
  scopeThresholdBase,
} from '../src/retrieval/adapt.ts'
function close(actual: number, expected: number, eps = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= eps, `expected ${expected}, got ${actual}`)
}

const SHORT = '部署' // 3 tokens(2 字 + 1 二元)
const MEDIUM = '怎么部署向量服务' // 15 tokens(8 字 + 7 二元)
const LONG = '我上次教你部署向量服务的时候用的是哪个端口你还记得吗' // 51 tokens(26 字 + 25 二元)

test('profileQuery:字符/token/唯一 token 数按 tokenize 口径统计', () => {
  const p = profileQuery(SHORT)
  assert.equal(p.chars, 2)
  assert.equal(p.tokens, 3)
  assert.equal(p.uniqueTokens, 3)
  assert.equal(p.class, 'short')
  assert.equal(profileQuery('  ').words, 0)

  assert.equal(profileQuery(MEDIUM).tokens, 15)
  assert.equal(profileQuery(MEDIUM).class, 'medium')
  assert.equal(profileQuery(LONG).class, 'long')
})

test('classifyQuery:8 个 token 及以下算短,24 个及以上算长', () => {
  assert.equal(classifyQuery(0), 'short')
  assert.equal(classifyQuery(8), 'short')
  assert.equal(classifyQuery(9), 'medium')
  assert.equal(classifyQuery(24), 'long')
  assert.equal(classifyQuery(100), 'long')
})

test('adaptiveThreshold:短查询放宽、长查询收紧、中间线性过渡', () => {
  const base = 0.12
  const short = adaptiveThreshold(SHORT, { base })
  const medium = adaptiveThreshold(MEDIUM, { base })
  const long = adaptiveThreshold(LONG, { base })

  close(short, base - DEFAULT_SHORT_RELAX)
  close(medium, 0.135625) // -0.05 + (15-8)/16 * 0.15
  close(long, base + 0.1)
  assert.ok(short < base && base < medium && medium < long)
})

test('adaptiveThreshold:结果被 min/max 夹住', () => {
  close(adaptiveThreshold(SHORT, { base: 0.03 }), MIN_ADAPTIVE_THRESHOLD)
  close(adaptiveThreshold(LONG, { base: 0.85 }), MAX_ADAPTIVE_THRESHOLD)
  close(adaptiveThreshold(LONG, { base: 0.5, max: 0.55 }), 0.55)
  close(adaptiveThreshold(SHORT, { base: 0.4, relax: 0 }), 0.4)
})

test('scopeThresholdBase:global 一档、project/session/custom 一档', () => {
  assert.equal(scopeThresholdBase('global'), DEFAULT_GLOBAL_THRESHOLD)
  assert.equal(scopeThresholdBase('project:/w'), DEFAULT_PROJECT_THRESHOLD)
  assert.equal(scopeThresholdBase('session:s1'), DEFAULT_PROJECT_THRESHOLD)
  assert.equal(scopeThresholdBase('my-custom'), DEFAULT_PROJECT_THRESHOLD)
  assert.equal(scopeThresholdBase('global', { globalThreshold: 0.2 }), 0.2)
  assert.equal(scopeThresholdBase('project:/w', { projectThreshold: 0.05 }), 0.05)
})

test('adaptiveScopeThreshold:一步完成 scope→配置门槛→查询自适应', () => {
  close(adaptiveScopeThreshold(SHORT, 'global'), 0.12 - 0.05)
  close(adaptiveScopeThreshold(MEDIUM, 'project:/w'), 0.1 + 0.015625)
  close(adaptiveScopeThreshold(LONG, 'project:/w'), 0.2)
})

test('scope 校准:默认让每个 tier 的门槛分映射到参考门槛', () => {
  const cal = createScopeCalibration()
  assert.equal(cal.reference, 'project')
  close(cal.scale('global'), DEFAULT_PROJECT_THRESHOLD / DEFAULT_GLOBAL_THRESHOLD)
  close(cal.scale('project:/w'), 1)
  close(cal.scale('session:s1'), 1)
  close(cal.scale('my-custom'), 1)

  // 每个 tier 恰好压线的分数 → 同一个参考门槛(0.10)
  close(cal.apply(DEFAULT_GLOBAL_THRESHOLD, 'global'), DEFAULT_PROJECT_THRESHOLD)
  close(cal.apply(DEFAULT_PROJECT_THRESHOLD, 'project:/w'), DEFAULT_PROJECT_THRESHOLD)
  close(cal.apply(DEFAULT_PROJECT_THRESHOLD, 'session:s1'), DEFAULT_PROJECT_THRESHOLD)
})

test('scope 校准:参考 tier 可换,门槛可配,显式 scale/offset 优先', () => {
  const toGlobal = createScopeCalibration({ reference: 'global' })
  close(toGlobal.apply(0.1, 'project:/w'), 0.12)

  const custom = createScopeCalibration({ globalThreshold: 0.2, projectThreshold: 0.05 })
  close(custom.scale('global'), 0.25)
  close(custom.apply(0.2, 'global'), 0.05)

  const overridden = createScopeCalibration({ scales: { global: 2 }, offsets: { global: 0.05 } })
  close(overridden.apply(0.1, 'global'), 0.25)

  // 门槛为 0 时不能除零:乘数退回 1
  const degenerate = createScopeCalibration({ globalThreshold: 0, projectThreshold: 0 })
  close(degenerate.scale('global'), 1)
})

test('calibrateScore / calibrateHits:校准词法分且不改入参', () => {
  close(calibrateScore(0.12, 'global'), 0.1)
  close(calibrateScore(0.1, 'project:/w'), 0.1)

  const hits = [
    { score: 0.12, record: { scope: 'global' } },
    { score: 0.1, record: { scope: 'project:/w' } },
  ]
  const calibrated = calibrateHits(hits, (hit) => hit.record.scope)
  close(calibrated[0]!.score, 0.1)
  close(calibrated[1]!.score, 0.1)
  assert.equal(hits[0]!.score, 0.12, '原数组不变')
  assert.notEqual(calibrated[0], hits[0], '返回浅拷贝')
})

test('scope 分类:global 走 global 门槛缩放,project/session/custom 走 project 档', () => {
  // 校准器对 tier 的判定通过 scale 体现:只有 global 键会偏离 1。
  const scopes = ['global', 'project:/a/b', 'session:abc', 'my-custom', 'custom:foo']
  const cal = createScopeCalibration()
  for (const scope of scopes) {
    const expectedScale = scope === 'global' ? DEFAULT_PROJECT_THRESHOLD / DEFAULT_GLOBAL_THRESHOLD : 1
    close(cal.scale(scope), expectedScale)
  }
})
