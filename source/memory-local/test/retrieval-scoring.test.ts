/**
 * 结果整形的单元测试(0.32.0):
 *   finalFloor 砍弱相关 → semanticDedupe 合并同义 → mmrSelect 去冗余。
 * 最后一条用例复刻 Lead 实测的"5 条结果只有 2 条相关、同义记忆挤占名额"场景。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_MMR_LAMBDA,
  DEFAULT_SEMANTIC_DEDUPE_THRESHOLD,
  FINAL_SCORE_FLOOR,
  finalFloor,
  mmrSelect,
  semanticDedupe,
  type ScoredItem,
} from '../src/scoring.ts'

function close(actual: number, expected: number, eps = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= eps, `expected ${expected}, got ${actual}`)
}

const vec = (x: number, y: number, z = 0): Float32Array => new Float32Array([x, y, z])

interface Hit extends ScoredItem {
  content?: string
}

// ---------------------------------------------------------------------------
// finalFloor
// ---------------------------------------------------------------------------

test('finalFloor:丢掉低于绝对下限的弱相关,保留等于下限的', () => {
  const hits: Hit[] = [
    { id: 'a', score: 0.9 },
    { id: 'b', score: FINAL_SCORE_FLOOR },
    { id: 'c', score: 0.2 },
  ]
  const kept = finalFloor(hits)
  assert.deepEqual(kept.map((h) => h.id), ['a', 'b'])
  // 纯函数:不改入参、原顺序
  assert.equal(hits.length, 3)
})

test('finalFloor:floor<=0 关闭这一层,自定义 floor 生效', () => {
  const hits: Hit[] = [{ id: 'a', score: 0.5 }, { id: 'b', score: 0.1 }]
  assert.deepEqual(finalFloor(hits, 0).map((h) => h.id), ['a', 'b'])
  assert.deepEqual(finalFloor(hits, 0.3).map((h) => h.id), ['a'])
  assert.equal(FINAL_SCORE_FLOOR, 0.25)
})

// ---------------------------------------------------------------------------
// semanticDedupe
// ---------------------------------------------------------------------------

test('semanticDedupe:余弦≥阈值的同义结果合并,保留最高分并记录被合并 id', () => {
  const hits: Hit[] = [
    { id: 'syn', score: 0.86, vector: vec(1, 0.02) },
    { id: 'top', score: 0.9, vector: vec(1, 0) },
    { id: 'other', score: 0.7, vector: vec(0, 1) },
  ]
  assert.equal(DEFAULT_SEMANTIC_DEDUPE_THRESHOLD, 0.85)
  const { hits: kept, merged, mergeMap } = semanticDedupe(hits)
  assert.deepEqual(kept.map((h) => h.id), ['top', 'other'], '同义条目的名额让给更高的那条')
  assert.deepEqual(merged, ['syn'])
  assert.equal(mergeMap.get('syn'), 'top')
})

test('semanticDedupe:阈值高到不合并时保留两条;无向量不误合并', () => {
  const near: Hit[] = [
    { id: 'a', score: 0.9, vector: vec(1, 0) },
    { id: 'b', score: 0.85, vector: vec(1, 0.02) },
  ]
  assert.equal(semanticDedupe(near, 0.9999).hits.length, 2)

  const noVec: Hit[] = [{ id: 'a', score: 0.9 }, { id: 'b', score: 0.85 }]
  const res = semanticDedupe(noVec, 0.5)
  assert.equal(res.hits.length, 2, '没有向量就没有"同义"证据,不能合并')
  assert.deepEqual(res.merged, [])
})

test('semanticDedupe:没有向量时可用 similarityOf 按正文合并跨 scope 重复', () => {
  const hits: Hit[] = [
    { id: 'p', score: 0.8, content: '用户偏好 TypeScript' },
    { id: 'g', score: 0.75, content: '用户偏好 TypeScript' },
    { id: 'x', score: 0.6, content: '别的事' },
  ]
  const res = semanticDedupe(hits, 0.99, {
    similarityOf: (a, b) => (a.content === b.content ? 1 : 0),
  })
  assert.deepEqual(res.hits.map((h) => h.id), ['p', 'x'])
  assert.deepEqual(res.merged, ['g'])
  assert.equal(res.mergeMap.get('g'), 'p')
})

test('semanticDedupe:输出按分数降序、同分按 id 升序,保证跨进程确定性', () => {
  const hits: Hit[] = [
    { id: 'b', score: 0.5, vector: vec(0, 1) },
    { id: 'a', score: 0.5, vector: vec(1, 0) },
    { id: 'c', score: 0.9, vector: vec(0, 0, 1) },
  ]
  const res = semanticDedupe(hits, 0.9)
  assert.deepEqual(res.hits.map((h) => h.id), ['c', 'a', 'b'])
})

// ---------------------------------------------------------------------------
// mmrSelect
// ---------------------------------------------------------------------------

test('mmrSelect:低 λ 时用多样性顶掉几乎重复的候选', () => {
  const cands: Hit[] = [
    { id: 'a', score: 0.9, vector: vec(1, 0) },
    { id: 'b', score: 0.84, vector: vec(0.99, 0.01) }, // 与 a 几乎同向
    { id: 'c', score: 0.62, vector: vec(0, 1) }, // 与 a 正交
  ]
  const picked = mmrSelect(cands, 0.5, 2)
  assert.deepEqual(picked.map((c) => c.id), ['a', 'c'], 'b 的分数只高一点,但和 a 冗余')
})

test('mmrSelect:高 λ 时退化为相关性优先(冗余惩罚压不过分数差)', () => {
  const cands: Hit[] = [
    { id: 'a', score: 0.9, vector: vec(1, 0) },
    { id: 'b', score: 0.84, vector: vec(0.99, 0.01) },
    { id: 'c', score: 0.62, vector: vec(0, 1) },
  ]
  assert.deepEqual(mmrSelect(cands, 0.9, 2).map((c) => c.id), ['a', 'b'])
})

test('mmrSelect:无向量时退化为按分数去重,且同 id 只留最高分', () => {
  const cands: Hit[] = [
    { id: 'a', score: 0.5 },
    { id: 'b', score: 0.8 },
    { id: 'a', score: 0.7 },
    { id: 'c', score: 0.6 },
  ]
  assert.deepEqual(mmrSelect(cands, DEFAULT_MMR_LAMBDA, 2).map((c) => c.id), ['b', 'a'])
  // 全零向量同样视为"没有可用向量"
  const zero: Hit[] = [
    { id: 'a', score: 0.9, vector: new Float32Array(0) },
    { id: 'b', score: 0.8, vector: new Float32Array(0) },
  ]
  assert.deepEqual(mmrSelect(zero, 0.5, 2).map((c) => c.id), ['a', 'b'])
})

test('mmrSelect:k 越界/空输入/同分时的确定性', () => {
  const cands: Hit[] = [
    { id: 'b', score: 0.5, vector: vec(1, 0) },
    { id: 'a', score: 0.5, vector: vec(0, 1) },
  ]
  assert.deepEqual(mmrSelect(cands, 0.7, 10).map((c) => c.id).sort(), ['a', 'b'])
  assert.deepEqual(mmrSelect(cands, 0.7, 0), [])
  assert.deepEqual(mmrSelect([], 0.7, 3), [])
  assert.equal(mmrSelect(cands, 0.7, 1)[0]!.id, 'a', '同分按 id 升序')
})

// ---------------------------------------------------------------------------
// 整条整形流水线:复刻实测噪声场景
// ---------------------------------------------------------------------------

test('整形流水线 floor→dedupe→MMR:5 条召回里只留下 2 条真命中', () => {
  const recall: Hit[] = [
    { id: 'r1', score: 0.95, vector: vec(1, 0, 0) },
    { id: 'r2', score: 0.9, vector: vec(0, 1, 0) },
    { id: 'syn', score: 0.88, vector: vec(1, 0.01, 0) }, // r1 的同义记忆(余弦≈1)
    { id: 'n1', score: 0.3, vector: vec(0, 0, 1) }, // 弱相关噪声
    { id: 'n2', score: 0.18 }, // 更弱的噪声(无向量)
  ]
  const afterFloor = finalFloor(recall)
  assert.deepEqual(afterFloor.map((h) => h.id), ['r1', 'r2', 'syn', 'n1'])

  const deduped = semanticDedupe(afterFloor, 0.85)
  assert.deepEqual(deduped.merged, ['syn'])

  const shaped = mmrSelect(deduped.hits, 0.7, 2)
  assert.deepEqual(shaped.map((h) => h.id), ['r1', 'r2'], 'top-2 全是相关结果,同义和噪声都不占名额')
})
