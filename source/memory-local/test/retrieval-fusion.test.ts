/**
 * fusion.ts 测试(0.36.0):RRF 多路排名融合 + 分数归一。
 *
 * 覆盖点:
 *   - rrfScore:k 默认 60、1-based 名次、权重、非法输入回落、k→0 的退化;
 *   - reciprocalRankFusion:多路共识 > 单路、可解释 sources(哪几路/名次/权重)、
 *     权重(数组 / 按名 / 列表自带)、k 对"单路 top vs 多路共识"的影响、limit、
 *     路内去重、非法 id、缺省通道名、空输入;
 *   - 稳定性:同分按最佳名次 + id、列表换序结果不变、重复调用深相等;
 *   - normalizeScores:min-max、显式范围、夹取、常量列表、非有限值、不改入参。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_RRF_K,
  normalizeScores,
  reciprocalRankFusion,
  rrfScore,
  type RankedList,
} from '../src/retrieval/fusion.ts'

function close(actual: number, expected: number, eps = 1e-12): void {
  assert.ok(Math.abs(actual - expected) <= eps, `expected ${expected}, got ${actual}`)
}

/** 基础三路:词法 / 向量 / 扩展。 */
function baseLists(): RankedList[] {
  return [
    { name: 'lexical', ids: ['a', 'b', 'c'] },
    { name: 'vector', ids: ['b', 'a'] },
    { name: 'expanded', ids: ['d'] },
  ]
}

// ---------------------------------------------------------------------------
// rrfScore
// ---------------------------------------------------------------------------

test('rrfScore:默认 k=60,1-based 名次 = weight/(k+rank)', () => {
  assert.equal(DEFAULT_RRF_K, 60)
  close(rrfScore(1), 1 / 61)
  close(rrfScore(2), 1 / 62)
  close(rrfScore(1, { weight: 2 }), 2 / 61)
  close(rrfScore(3, { k: 10, weight: 0.5 }), 0.5 / 13)
  assert.ok(rrfScore(1) > rrfScore(2) && rrfScore(2) > rrfScore(3))
})

test('rrfScore:名次/权重/k 的非法输入都有确定语义', () => {
  close(rrfScore(0), 1 / 61) // 名次 < 1 按 1
  close(rrfScore(Number.NaN), 1 / 61) // 非有限名次按 1
  close(rrfScore(1.4), 1 / 61) // 四舍五入到 1
  close(rrfScore(1, { k: Number.NaN }), 1 / 61) // k 非法回落 60
  close(rrfScore(1, { k: -5 }), 1) // 负 k 按 0 → 1/(0+1)
  close(rrfScore(1, { weight: -3 }), 0) // 负权重按 0
  close(rrfScore(1, { weight: Number.NaN }), 1 / 61) // 非有限权重回落 1
})

test('rrfScore:k 越小越强调单路头部,k 越大越平', () => {
  // 第 1 名相对第 2 名的优势比:(k+2)/(k+1)
  const smallK = rrfScore(1, { k: 1 }) / rrfScore(2, { k: 1 })
  const largeK = rrfScore(1, { k: 100 }) / rrfScore(2, { k: 100 })
  close(smallK, 3 / 2)
  close(largeK, 102 / 101)
  assert.ok(smallK > largeK)
})

// ---------------------------------------------------------------------------
// reciprocalRankFusion
// ---------------------------------------------------------------------------

test('reciprocalRankFusion:多路命中分数更高、单路也保留,输出按总分降序', () => {
  const fused = reciprocalRankFusion(baseLists())
  // a: 词法1 + 向量2 = 1/61 + 1/62;b 同分(对调)→ 同分按 id 升序
  assert.deepEqual(fused.map((hit) => hit.id), ['a', 'b', 'd', 'c'])
  close(fused[0]!.score, 1 / 61 + 1 / 62)
  close(fused[1]!.score, 1 / 62 + 1 / 61)
  close(fused[2]!.score, 1 / 61)
  close(fused[3]!.score, 1 / 63)
})

test('reciprocalRankFusion:可解释来源(哪几路 / 名次 / 权重 / 贡献)', () => {
  const fused = reciprocalRankFusion(baseLists())
  const a = fused[0]!
  assert.deepEqual(a.sources.map((source) => source.name), ['lexical', 'vector'])
  assert.deepEqual(a.sources.map((source) => source.rank), [1, 2])
  assert.deepEqual(a.sources.map((source) => source.weight), [1, 1])
  close(a.sources[0]!.score, 1 / 61)
  close(a.sources[1]!.score, 1 / 62)
  // 总分 = 各来源贡献之和
  close(a.score, a.sources.reduce((sum, source) => sum + source.score, 0))

  const d = fused[2]!
  assert.deepEqual(d.sources.map((source) => [source.name, source.rank]), [['expanded', 1]])
})

test('reciprocalRankFusion:同分按最佳名次、再按 id —— 与列表顺序无关', () => {
  const fused = reciprocalRankFusion(baseLists())
  const reversed = reciprocalRankFusion([...baseLists()].reverse())
  assert.deepEqual(reversed, fused) // 换序后分数/顺序/来源明细完全一致
})

test('reciprocalRankFusion:weights 数组按列表下标加权,可翻转顺序', () => {
  const lists: RankedList[] = [
    { name: 'lexical', ids: ['a', 'b'] },
    { name: 'vector', ids: ['b', 'a'] },
  ]
  // 等权:a / b 同分 → id 升序
  assert.deepEqual(reciprocalRankFusion(lists).map((hit) => hit.id), ['a', 'b'])
  // 向量路权重 3 倍:b 的向量名次更好 → b 在前
  const weighted = reciprocalRankFusion(lists, { weights: [1, 3] })
  assert.deepEqual(weighted.map((hit) => hit.id), ['b', 'a'])
  assert.equal(weighted[0]!.sources.find((source) => source.name === 'vector')!.weight, 3)
  close(weighted[0]!.score, 3 / 61 + 1 / 62)
})

test('reciprocalRankFusion:weights 对象按通道名加权;列表自带 weight 兜底', () => {
  const lists: RankedList[] = [
    { name: 'lexical', ids: ['a', 'b'] },
    { name: 'vector', ids: ['b', 'a'] },
  ]
  assert.deepEqual(
    reciprocalRankFusion(lists, { weights: { lexical: 1, vector: 3 } }).map((hit) => hit.id),
    ['b', 'a'],
  )
  // 没有 opts.weights 时用列表自带权重
  const byList = reciprocalRankFusion([
    { name: 'lexical', ids: ['a', 'b'], weight: 3 },
    { name: 'vector', ids: ['b', 'a'], weight: 1 },
  ])
  assert.deepEqual(byList.map((hit) => hit.id), ['a', 'b'])
  assert.equal(byList[0]!.sources.find((source) => source.name === 'lexical')!.weight, 3)
  // opts.weights 优先于列表自带权重
  const override = reciprocalRankFusion([
    { name: 'lexical', ids: ['a', 'b'], weight: 3 },
    { name: 'vector', ids: ['b', 'a'], weight: 1 },
  ], { weights: [1, 3] })
  assert.deepEqual(override.map((hit) => hit.id), ['b', 'a'])
  // 负权重按 0:该路不贡献分数
  const zero = reciprocalRankFusion([{ name: 'x', ids: ['a'], weight: -2 }])
  assert.equal(zero[0]!.score, 0)
  assert.equal(zero[0]!.sources[0]!.weight, 0)
})

test('reciprocalRankFusion:k 越大越看多路共识,k 越小越看单路头部', () => {
  // p 只在 A 路排第 1;q 在 B、C 两路都只排第 3
  const lists: RankedList[] = [
    { name: 'A', ids: ['p', 'x'] },
    { name: 'B', ids: ['y1', 'y2', 'q'] },
    { name: 'C', ids: ['z1', 'z2', 'q'] },
  ]
  const rankOf = (fused: ReturnType<typeof reciprocalRankFusion>, id: string): number =>
    fused.findIndex((hit) => hit.id === id)

  const flat = reciprocalRankFusion(lists, { k: 60 })
  assert.ok(rankOf(flat, 'q') < rankOf(flat, 'p'), '大 k:两路共识应高于单路头部')
  const steep = reciprocalRankFusion(lists, { k: 0 })
  assert.ok(rankOf(steep, 'p') < rankOf(steep, 'q'), '小 k:单路第 1 应高于两路第 3')
})

test('reciprocalRankFusion:路内重复 id 只算最佳名次,名次按原始位置', () => {
  const fused = reciprocalRankFusion([{ name: 'x', ids: ['a', 'a', 'b'] }])
  const a = fused.find((hit) => hit.id === 'a')!
  const b = fused.find((hit) => hit.id === 'b')!
  assert.equal(a.sources.length, 1)
  close(a.score, 1 / 61) // 第一次出现的名次 1
  close(b.score, 1 / 63) // 保持原始位置 3,不压缩
  assert.deepEqual(fused.map((hit) => hit.id), ['a', 'b'])
})

test('reciprocalRankFusion:非法 id 跳过;缺省通道名按位置补 channelN', () => {
  const fused = reciprocalRankFusion([
    { name: '', ids: ['', 'a', null as unknown as string, 'b'] },
  ])
  // 名次按原始下标算:a 在第 2 位、b 在第 4 位
  const a = fused.find((hit) => hit.id === 'a')!
  const b = fused.find((hit) => hit.id === 'b')!
  assert.equal(a.sources[0]!.name, 'channel1')
  assert.equal(a.sources[0]!.rank, 2)
  assert.equal(b.sources[0]!.rank, 4)
  assert.equal(fused.length, 2)

  const second = reciprocalRankFusion([{ name: 'v', ids: ['a'] }])
  assert.equal(second[0]!.sources[0]!.name, 'v')
})

test('reciprocalRankFusion:limit 截断、空输入返回空、重复调用深相等', () => {
  assert.equal(reciprocalRankFusion(baseLists(), { limit: 2 }).length, 2)
  assert.deepEqual(reciprocalRankFusion(baseLists(), { limit: 0 }), [])
  assert.deepEqual(reciprocalRankFusion([]), [])
  assert.deepEqual(reciprocalRankFusion(baseLists()), reciprocalRankFusion(baseLists()))
})

// ---------------------------------------------------------------------------
// normalizeScores
// ---------------------------------------------------------------------------

test('normalizeScores:min-max 归一到 0..1', () => {
  assert.deepEqual(normalizeScores([0, 5, 10]), [0, 0.5, 1])
  assert.deepEqual(normalizeScores([10]), [1]) // 单元素:有正向信号 → 1
  assert.deepEqual(normalizeScores([]), [])
})

test('normalizeScores:显式范围、超出范围夹取', () => {
  assert.deepEqual(normalizeScores([5, 10], { min: 0, max: 20 }), [0.25, 0.5])
  assert.deepEqual(normalizeScores([-5, 15, 25], { min: 0, max: 20 }), [0, 0.75, 1])
  // 只给一侧时另一侧用数据极值
  assert.deepEqual(normalizeScores([10, 20], { min: 0 }), [0.5, 1])
})

test('normalizeScores:常量列表无法区分相对大小 —— 正值全 1,0/负值全 0', () => {
  assert.deepEqual(normalizeScores([3, 3, 3]), [1, 1, 1])
  assert.deepEqual(normalizeScores([0, 0]), [0, 0])
  assert.deepEqual(normalizeScores([-2, -2]), [0, 0])
})

test('normalizeScores:非有限值输出 0,不参与极值;不改入参', () => {
  assert.deepEqual(normalizeScores([Number.NaN, 4, Number.POSITIVE_INFINITY]), [0, 1, 0])
  const input = [1, 2, 3]
  normalizeScores(input)
  assert.deepEqual(input, [1, 2, 3])
})
