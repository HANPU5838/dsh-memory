/**
 * eval.ts 测试(0.32.0):recall@k / MRR@k / nDCG@k 的数值正确性 + CSV 导出。
 * 期望值按公式手算(二元相关的 DCG 就是 Σ 1/log2(rank+1))。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  dcgAtK,
  evaluate,
  evaluateQuery,
  ndcgAtK,
  recallAtK,
  reciprocalRank,
  toCsv,
  type EvalQuery,
} from '../src/retrieval/eval.ts'

function close(actual: number, expected: number, eps = 1e-12): void {
  assert.ok(Math.abs(actual - expected) <= eps, `expected ${expected}, got ${actual}`)
}

test('recallAtK:前 k 命中数 / 相关总数', () => {
  const ranked = ['a', 'b', 'c', 'd']
  const relevant = ['b', 'e']
  close(recallAtK(ranked, relevant, 3), 0.5)
  close(recallAtK(ranked, relevant, 1), 0)
  close(recallAtK(ranked, relevant, 4), 0.5)
  close(recallAtK(ranked, ['a', 'd'], 0), 0)
})

test('recallAtK:空标注记 0,排名里的重复 id 只算一次', () => {
  close(recallAtK(['a'], [], 5), 0)
  close(recallAtK(['a', 'a', 'b'], ['b'], 3), 1)
  close(recallAtK(['a', 'a', 'b'], ['b'], 2), 1) // 去重后前 2 = [a, b]
})

test('reciprocalRank:第一个相关结果的倒数名次;传 k 则截断', () => {
  close(reciprocalRank(['x', 'y', 'z'], ['z']), 1 / 3)
  close(reciprocalRank(['x', 'y', 'z'], ['z'], 2), 0)
  close(reciprocalRank(['x', 'y', 'z'], ['z'], 3), 1 / 3)
  close(reciprocalRank(['x'], []), 0)
})

test('dcgAtK / ndcgAtK:二元相关的解析值与理想排序', () => {
  // gains [1,0,1]:1/log2(2) + 1/log2(4) = 1.5
  close(dcgAtK([1, 0, 1], 3), 1.5)
  const ranked = ['a', 'b', 'c']
  const relevant = ['a', 'c']
  // IDCG = 1 + 1/log2(3) = 1.6309297535714574
  const idcg = 1 + 1 / Math.log2(3)
  close(ndcgAtK(ranked, relevant, 3), 1.5 / idcg)
  // 理想排序(相关结果都在最前)= 1
  close(ndcgAtK(['c', 'a', 'b'], relevant, 3), 1)
  close(ndcgAtK(['a', 'b', 'c'], relevant, 1), 1) // 前 1 里有一条相关,IDCG 也只取 1 条
  close(ndcgAtK(['b', 'a', 'c'], relevant, 3), (1 / Math.log2(3) + 1 / Math.log2(4)) / idcg)
  close(ndcgAtK(['a'], [], 3), 0)
  close(ndcgAtK(['a'], relevant, 0), 0)
})

test('evaluateQuery:三项指标在 k 处截断(MRR@k 口径)', () => {
  const metrics = evaluateQuery({ query: 'q', relevant: ['c'], ranked: ['a', 'b', 'c'] }, 2)
  assert.equal(metrics.query, 'q')
  close(metrics.recallAtK, 0)
  close(metrics.reciprocalRank, 0)
  close(metrics.ndcgAtK, 0)
  close(evaluateQuery({ query: 'q', relevant: ['c'], ranked: ['a', 'b', 'c'] }, 3).reciprocalRank, 1 / 3)
})

test('evaluate:宏平均 + 逐查询明细;空集合全 0', () => {
  const queries: EvalQuery[] = [
    { query: 'perfect', relevant: ['a'], ranked: ['a', 'b'] },
    { query: 'miss', relevant: ['z'], ranked: ['a', 'b'] },
  ]
  const report = evaluate(queries, 3)
  assert.equal(report.k, 3)
  assert.equal(report.queries, 2)
  assert.equal(report.perQuery.length, 2)
  close(report.recallAtK, 0.5)
  close(report.mrr, 0.5) // perfect 的 RR=1,miss 的 RR=0
  close(report.ndcgAtK, 0.5)
  assert.deepEqual(report.perQuery.map((row) => row.query), ['perfect', 'miss'])

  const empty = evaluate([], 5)
  assert.equal(empty.queries, 0)
  assert.equal(empty.recallAtK, 0)
  assert.equal(empty.mrr, 0)
  assert.equal(empty.ndcgAtK, 0)
  assert.deepEqual(empty.perQuery, [])
})

test('toCsv:表头带 k、逐查询行 + __aggregate__ 汇总行、字段转义', () => {
  const report = evaluate([
    { query: 'a,"b"', relevant: ['x'], ranked: ['x'] },
    { query: 'q2', relevant: ['y'], ranked: [] },
  ], 3)
  const csv = toCsv(report)
  assert.ok(csv.endsWith('\n'), 'CSV 行尾统一换行')
  const lines = csv.trimEnd().split('\n')
  assert.equal(lines.length, 4, '表头 + 2 条查询 + 汇总')
  assert.equal(lines[0], 'query,recall@3,rr,ndcg@3')
  assert.equal(lines[1], '"a,""b""",1.000000,1.000000,1.000000', '含逗号/引号的查询要转义')
  assert.equal(lines[2], 'q2,0.000000,0.000000,0.000000')
  assert.equal(lines[3], '__aggregate__,0.500000,0.500000,0.500000')
})
