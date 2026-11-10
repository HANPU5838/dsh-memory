/**
 * rank.ts 测试(0.33.0):可解释排序 = 校准相关度 × 保持度 × 效用提升 × 重要度。
 *
 * 覆盖点:
 *   - 四个因子各自的单调性(只有一个变化时,排序随之变化)
 *   - 分解正确性(score 等于各因子乘积、因子范围、权重为 0 时关层)
 *   - 边界(空候选、limit、非法输入、负相关度)
 *   - 确定性(同分按 id、输入顺序无关、不改入参)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_RANK_WEIGHTS,
  rankCandidates,
  explainCandidate,
  type RankCandidate,
} from '../src/retrieval/rank.ts'
import { retrievability, utilityScore } from '../src/retrieval/retention.ts'

const DAY = 86_400_000
const NOW = 1_800_000_000_000

function close(actual: number, expected: number, eps = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= eps, `expected ${expected}, got ${actual}`)
}

/** 一条"中等"候选:稳定、3 天前取用过、重要度 0.5、从未被取用反馈。 */
function cand(id: string, patch: Partial<RankCandidate> = {}): RankCandidate {
  return {
    id,
    relevance: 0.8,
    importance: 0.5,
    stability: 3,
    lastUsedAt: NOW - 3 * DAY,
    utility: 0,
    useCount: 0,
    ...patch,
  }
}

function ids(rows: { candidate: { id: string } }[]): string[] {
  return rows.map((row) => row.candidate.id)
}

// ---------------------------------------------------------------------------
// 单因子单调性
// ---------------------------------------------------------------------------

test('rank:相关度越高排名越前', () => {
  const rows = rankCandidates([cand('low', { relevance: 0.3 }), cand('high', { relevance: 0.9 })], { now: NOW })
  assert.deepEqual(ids(rows), ['high', 'low'])
  assert.ok(rows[0]!.breakdown.relevance > rows[1]!.breakdown.relevance)
})

test('rank:重要度越高排名越前(importance 因子 = 1 − w·(1−imp))', () => {
  const rows = rankCandidates([cand('minor', { importance: 0.1 }), cand('major', { importance: 0.9 })], { now: NOW })
  assert.deepEqual(ids(rows), ['major', 'minor'])
  close(rows[0]!.breakdown.importanceFactor, 1 - DEFAULT_RANK_WEIGHTS.importance * 0.1, 1e-12)
  close(rows[1]!.breakdown.importanceFactor, 1 - DEFAULT_RANK_WEIGHTS.importance * 0.9, 1e-12)
})

test('rank:效用越高排名越前(被取用且确实有用的加成)', () => {
  const used = cand('used', { utility: 0.9, useCount: 8, lastUsedAt: NOW })
  const never = cand('never', { utility: 0, useCount: 0, lastUsedAt: NOW - 3 * DAY })
  const rows = rankCandidates([never, used], { now: NOW })
  assert.deepEqual(ids(rows), ['used', 'never'])
  close(rows[0]!.breakdown.utility, utilityScore(used, NOW), 1e-12)
  assert.ok(rows[0]!.breakdown.utilityFactor > rows[1]!.breakdown.utilityFactor)
})

test('rank:保持度越高排名越前(同样稳定,越近越前;同样时间,越稳越前)', () => {
  const recent = cand('recent', { lastUsedAt: NOW })
  const old = cand('old', { lastUsedAt: NOW - 90 * DAY })
  assert.deepEqual(ids(rankCandidates([old, recent], { now: NOW })), ['recent', 'old'])

  const stable = cand('stable', { stability: 30 })
  const fragile = cand('fragile', { stability: 1 })
  assert.deepEqual(ids(rankCandidates([fragile, stable], { now: NOW })), ['stable', 'fragile'])
  close(stableRow(stable).retention, retrievability(3, 30), 1e-12)
  close(stableRow(fragile).retention, retrievability(3, 1), 1e-12)
})

/** 单条候选的分解(测试辅助)。 */
function stableRow(candidate: RankCandidate) {
  return explainCandidate(candidate, { now: NOW })
}

test('rank:退役(superseded)记录被惩罚,权重可关掉', () => {
  const rows = rankCandidates([cand('active'), cand('retired', { superseded: true })], { now: NOW })
  assert.deepEqual(ids(rows), ['active', 'retired'])
  close(rows[1]!.breakdown.supersededFactor, DEFAULT_RANK_WEIGHTS.superseded, 1e-12)
  close(rows[1]!.score, rows[0]!.score * DEFAULT_RANK_WEIGHTS.superseded, 1e-12)

  const off = rankCandidates([cand('active'), cand('retired', { superseded: true })], {
    now: NOW,
    weights: { superseded: 1 },
  })
  // 完全同分时按 id 升序:active < retired
  assert.deepEqual(ids(off), ['active', 'retired'])
  close(off[0]!.score, off[1]!.score, 1e-12)
})

// ---------------------------------------------------------------------------
// 分解与权重
// ---------------------------------------------------------------------------

test('rank:breakdown 各因子范围正确,score = 四因子乘积', () => {
  const rows = rankCandidates([cand('a')], { now: NOW })
  const { breakdown, score } = rows[0]!
  close(score, breakdown.score, 1e-12)
  close(breakdown.score, breakdown.relevance
    * breakdown.retentionFactor
    * breakdown.utilityFactor
    * breakdown.importanceFactor
    * breakdown.supersededFactor, 1e-12)
  assert.ok(breakdown.retention > 0 && breakdown.retention <= 1)
  assert.ok(breakdown.retentionFactor >= 1 - DEFAULT_RANK_WEIGHTS.retention - 1e-12)
  assert.ok(breakdown.retentionFactor <= 1 + 1e-12)
  assert.ok(breakdown.utility >= 0 && breakdown.utility <= 1)
  assert.ok(breakdown.utilityFactor >= 1 && breakdown.utilityFactor <= 1 + DEFAULT_RANK_WEIGHTS.utility + 1e-12)
  assert.ok(breakdown.importance >= 0 && breakdown.importance <= 1)
  assert.ok(breakdown.importanceFactor >= 1 - DEFAULT_RANK_WEIGHTS.importance - 1e-12)
  assert.ok(breakdown.importanceFactor <= 1 + 1e-12)
  assert.equal(breakdown.supersededFactor, 1)
})

test('rank:全默认的手算校验(0.8 × 0.95 × 1 × 0.8 = 0.608)', () => {
  const row = rankCandidates([cand('a')], { now: NOW })[0]!
  close(row.breakdown.retention, 0.9, 1e-12) // t=3,S=3 → (1+3/27)^-1
  close(row.breakdown.retentionFactor, 0.95, 1e-12) // 1 − 0.5·0.1
  close(row.breakdown.utilityFactor, 1, 1e-12)
  close(row.breakdown.importanceFactor, 0.8, 1e-12) // 1 − 0.4·0.5
  close(row.score, 0.8 * 0.95 * 0.8, 1e-12)
})

test('rank:权重全 0 时只剩相关度(每一层都能单独关掉)', () => {
  const rows = rankCandidates(
    [
      cand('a', { relevance: 0.6, importance: 0, lastUsedAt: NOW - 365 * DAY, superseded: true }),
      cand('b', { relevance: 0.9, importance: 0, lastUsedAt: NOW - 365 * DAY, superseded: true }),
    ],
    { now: NOW, weights: { retention: 0, utility: 0, importance: 0, superseded: 1 } },
  )
  close(rows[0]!.score, 0.9, 1e-12)
  close(rows[1]!.score, 0.6, 1e-12)
})

test('rank:自定义权重改变排序(相关度略低但重要度高时可反超)', () => {
  const candidates = [
    cand('relevant', { relevance: 0.85, importance: 0.1 }),
    cand('important', { relevance: 0.7, importance: 1 }),
  ]
  // 默认权重:important 因子 1.0 vs 0.52,important 反超
  const byDefault = rankCandidates(candidates, { now: NOW })
  assert.deepEqual(ids(byDefault), ['important', 'relevant'])
  // 关掉重要度层:相关度优先
  const relevanceOnly = rankCandidates(candidates, { now: NOW, weights: { importance: 0 } })
  assert.deepEqual(ids(relevanceOnly), ['relevant', 'important'])
})

// ---------------------------------------------------------------------------
// 老记录兼容 / 半衰期退化
// ---------------------------------------------------------------------------

test('rank:没有 stability 的老记录按内容/kind/accessCount 推导保持度', () => {
  const derived = rankCandidates(
    [
      { id: 'fresh', relevance: 0.8, content: 'x', kind: 'fact', createdAt: NOW },
      { id: 'old', relevance: 0.8, content: 'x', kind: 'fact', createdAt: NOW - 30 * DAY },
    ],
    { now: NOW },
  )
  assert.deepEqual(ids(derived), ['fresh', 'old'])
  for (const row of derived) assert.ok(row.breakdown.retention > 0 && row.breakdown.retention <= 1)

  // 访问次数多的老记录,推导出的稳定性更高 → 相同年龄下保持度更高
  const withUses = explainCandidate(
    { id: 'used', relevance: 1, content: 'x', kind: 'fact', createdAt: NOW - 30 * DAY, accessCount: 20 },
    { now: NOW },
  )
  const withoutUses = explainCandidate(
    { id: 'unused', relevance: 1, content: 'x', kind: 'fact', createdAt: NOW - 30 * DAY, accessCount: 0 },
    { now: NOW },
  )
  assert.ok(withUses.retention > withoutUses.retention)
})

test('rank:极简候选(只有 id/相关度/时间)退化为指数半衰期', () => {
  const candidate: RankCandidate = { id: 'minimal', relevance: 1, createdAt: NOW - 30 * DAY, importance: 0 }
  const thirty = explainCandidate(candidate, { now: NOW, halfLifeDays: 30 })
  close(thirty.retention, 0.5, 1e-12)
  const one = explainCandidate(candidate, { now: NOW, halfLifeDays: 1 })
  assert.ok(one.retention < thirty.retention)
  // 非法 halfLifeDays 用默认值
  close(explainCandidate(candidate, { now: NOW, halfLifeDays: 0 }).retention, 0.5, 1e-12)
  close(explainCandidate(candidate, { now: NOW, halfLifeDays: Number.NaN }).retention, 0.5, 1e-12)
})

// ---------------------------------------------------------------------------
// 边界 / 确定性
// ---------------------------------------------------------------------------

test('rank:空候选 → 空数组;limit 生效且不改动完整排序', () => {
  assert.deepEqual(rankCandidates([], { now: NOW }), [])
  const candidates = [cand('a', { relevance: 0.9 }), cand('b', { relevance: 0.5 }), cand('c', { relevance: 0.7 })]
  assert.deepEqual(ids(rankCandidates(candidates, { now: NOW })), ['a', 'c', 'b'])
  assert.deepEqual(ids(rankCandidates(candidates, { now: NOW, limit: 2 })), ['a', 'c'])
  assert.deepEqual(rankCandidates(candidates, { now: NOW, limit: 0 }), [])
  assert.deepEqual(ids(rankCandidates(candidates, { now: NOW, limit: -1 })), [])
  assert.deepEqual(ids(rankCandidates(candidates, { now: NOW, limit: 99 })), ['a', 'c', 'b'])
})

test('rank:同分按 id 升序,与输入顺序无关(可复现)', () => {
  const a: RankCandidate = cand('aaa')
  const b: RankCandidate = cand('zzz')
  assert.deepEqual(ids(rankCandidates([b, a], { now: NOW })), ['aaa', 'zzz'])
  assert.deepEqual(ids(rankCandidates([a, b], { now: NOW })), ['aaa', 'zzz'])
  // 重复调用结果稳定
  const first = rankCandidates([b, a], { now: NOW })
  const second = rankCandidates([b, a], { now: NOW })
  assert.deepEqual(ids(first), ids(second))
  assert.deepEqual(first.map((row) => row.score), second.map((row) => row.score))
})

test('rank:非法输入防御(负/NaN 相关度、缺失重要度、NaN now)', () => {
  const rows = rankCandidates(
    [
      cand('negative', { relevance: -1 }),
      cand('nan', { relevance: Number.NaN }),
      cand('ok', { relevance: 0.5, importance: undefined }),
    ],
    { now: NOW },
  )
  const byId = new Map(rows.map((row) => [row.candidate.id, row]))
  close(byId.get('negative')!.breakdown.relevance, 0, 1e-12)
  close(byId.get('nan')!.breakdown.relevance, 0, 1e-12)
  close(byId.get('ok')!.breakdown.importance, 0, 1e-12)
  assert.equal(ids(rows)[0], 'ok')
  for (const row of rows) assert.ok(Number.isFinite(row.score), '分数必须有限')

  // now 非法 → 按 0 处理,不产生 NaN
  const weird = rankCandidates([cand('a')], { now: Number.NaN })
  assert.ok(Number.isFinite(weird[0]!.score))
})

test('rank:不修改候选对象与数组', () => {
  const candidates = [cand('a'), cand('b', { utility: 0.5, useCount: 3 })]
  const snapshot = JSON.stringify(candidates)
  const rows = rankCandidates(candidates, { now: NOW })
  assert.equal(JSON.stringify(candidates), snapshot, '候选对象不能被修改')
  assert.equal(rows.length, 2)
  for (const original of candidates) {
    assert.ok(rows.some((row) => row.candidate === original), 'candidate 应保持原对象引用')
  }
})

test('explainCandidate:与 rankCandidates 的分数一致', () => {
  const candidate = cand('a', { importance: 0.7, utility: 0.4, useCount: 3, lastUsedAt: NOW - 10 * DAY })
  const viaRank = rankCandidates([candidate], { now: NOW })[0]!
  const direct = explainCandidate(candidate, { now: NOW })
  assert.deepEqual(viaRank.breakdown, direct)
  close(viaRank.score, direct.score, 0)
})
