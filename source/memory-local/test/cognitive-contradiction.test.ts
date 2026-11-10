/**
 * 矛盾置信度（cognitive/contradiction）：断言抽取、数值/标识符差异率、置信度等级。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { MemoryRecord } from '../src/store.ts'
import {
  CONTRADICTION_HIGH,
  CONTRADICTION_MEDIUM,
  assessContradiction,
  assessRecordContradiction,
  compareClaims,
  contradictionLevel,
  extractClaims,
  identifierDifferenceRate,
  lexicalSimilarity,
  numericDifferenceRate,
  textTokens,
} from '../src/cognitive/contradiction.ts'

function approx(actual: number, expected: number, message?: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, message ?? `${actual} ≈ ${expected}`)
}

function record(content: string): MemoryRecord {
  const now = Date.now()
  return {
    id: `id-${content.length}-${content.slice(0, 4)}`,
    scope: 'project:x',
    kind: 'fact',
    content,
    tags: [],
    source: { origin: 'explicit' },
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
    accessCount: 0,
    importance: 0.5,
  }
}

// ---------------------------------------------------------------- 断言抽取

test('extractClaims：数值（含小数/千分位）、路径、标识符', () => {
  const claims = extractClaims('端口是 8080，内存 10.4GB，路径 /opt/app，用 pnpm 装，预算 1,024')
  assert.deepEqual(claims.numbers, [8080, 10.4, 1024])
  assert.deepEqual(claims.paths, ['/opt/app'])
  assert.ok(claims.identifiers.includes('pnpm'))
  assert.ok(claims.identifiers.includes('opt'), '路径片段也算拉丁标识符（集合比较用）')
})

test('extractClaims：数值去重且保序；停用词不算标识符', () => {
  const claims = extractClaims('端口 8080 和端口 8080，use the port')
  assert.deepEqual(claims.numbers, [8080])
  assert.ok(!claims.identifiers.includes('the'))
  assert.ok(!claims.identifiers.includes('use'))
  assert.ok(claims.identifiers.includes('port'))
})

test('extractClaims：无断言 → 三个空数组', () => {
  const claims = extractClaims('这是一句纯中文描述')
  assert.deepEqual(claims, { numbers: [], paths: [], identifiers: [] })
})

// ---------------------------------------------------------------- 差异率

test('numericDifferenceRate：相等 → 0，差异越大越大', () => {
  assert.equal(numericDifferenceRate([], []), 0)
  assert.equal(numericDifferenceRate([5], [5]), 0)
  approx(numericDifferenceRate([10.4], [20]), 0.74)
  // 8080 vs 8078 幅度率极小，但"不相等就至少 0.5"的兜底让它仍然可判。
  approx(numericDifferenceRate([8080], [8078]), 0.5001237623762376)
  approx(numericDifferenceRate([1], [100]), 0.995)
})

test('numericDifferenceRate：一边缺失记 1，多出来的数值也记 1', () => {
  assert.equal(numericDifferenceRate([], [5]), 1)
  assert.equal(numericDifferenceRate([5], []), 1)
  approx(numericDifferenceRate([1, 2], [1]), 0.5)
})

test('identifierDifferenceRate：集合差异占比', () => {
  assert.equal(identifierDifferenceRate([], []), 0)
  assert.equal(identifierDifferenceRate(['pnpm'], ['pnpm']), 0)
  assert.equal(identifierDifferenceRate(['pnpm'], ['npm']), 1)
  approx(identifierDifferenceRate(['a', 'b', 'c'], ['a', 'b', 'd']), 0.5)
})

// ---------------------------------------------------------------- 差异明细

test('compareClaims：数值 / 标识符 / 路径逐项明细', () => {
  const comparison = compareClaims('服务端口是 8080，部署在 /opt/app，使用 pnpm', '服务端口是 8078，部署在 /srv/app，使用 npm')
  assert.equal(comparison.differs, true)
  assert.ok(comparison.details.some((line) => line.includes('8080 → 8078')), comparison.details.join(' | '))
  assert.ok(comparison.details.some((line) => line.includes('标识符/路径缺失')))
  assert.ok(comparison.pathsMissing.includes('/opt/app'))
  assert.ok(comparison.pathsExtra.includes('/srv/app'))
  assert.ok(comparison.identifiersMissing.includes('pnpm'))
  assert.ok(comparison.identifiersExtra.includes('npm'))
  assert.ok(comparison.numericRate > 0)
  assert.ok(comparison.identifierRate > 0)
})

test('compareClaims：内容相同 → 无差异明细、rates 为 0', () => {
  const comparison = compareClaims('设备是 aarch64', '设备是 aarch64')
  assert.equal(comparison.differs, false)
  assert.equal(comparison.numericRate, 0)
  assert.equal(comparison.identifierRate, 0)
  assert.deepEqual(comparison.details, [])
})

// ---------------------------------------------------------------- 置信度与等级

test('assessContradiction：内容相同 → 0 分 low', () => {
  const result = assessContradiction('设备是 aarch64', '设备是 aarch64', { similarity: 0.99 })
  assert.equal(result.confidence, 0)
  assert.equal(result.level, 'low')
  assert.equal(result.signals.criticalDetailConflict, false)
})

test('assessContradiction：语义相同但数值被改写 → high（向量相似度的盲区）', () => {
  const result = assessContradiction('内存上限是 10.4GB', '内存上限是 20GB', { similarity: 0.96 })
  assert.equal(result.level, 'high')
  assert.ok(result.confidence >= CONTRADICTION_HIGH)
  assert.equal(result.signals.criticalDetailConflict, true)
  assert.ok(result.signals.detail > 0.4)
})

test('assessContradiction：端口只差一点 → 关键细节布尔证据兜底到 medium', () => {
  const result = assessContradiction('服务端口是 8080', '服务端口是 8078', { similarity: 0.98 })
  assert.equal(result.level, 'medium')
  assert.ok(result.signals.numeric >= 0.5)
  assert.equal(result.signals.criticalDetailConflict, true)
})

test('assessContradiction：标识符被替换（pnpm → npm）→ medium', () => {
  const result = assessContradiction('使用 pnpm 安装依赖', '使用 npm 安装依赖', { similarity: 0.9 })
  assert.equal(result.level, 'medium')
  assert.equal(result.signals.identifier, 1)
  assert.ok(result.comparison.details.some((line) => line.includes('pnpm')))
})

test('assessContradiction：路径被改写 → 至少 medium', () => {
  const result = assessContradiction('部署在 /opt/app', '部署在 /srv/app', { similarity: 0.95 })
  assert.ok(result.confidence >= CONTRADICTION_MEDIUM)
  assert.ok(result.comparison.pathsMissing.includes('/opt/app'))
})

test('assessContradiction：话题不同 → 细节差异再大也是 low', () => {
  const result = assessContradiction('版本 1.2.3', '端口 8080', { similarity: 0.2 })
  assert.equal(result.level, 'low')
  assert.ok(result.confidence < CONTRADICTION_MEDIUM)
})

test('assessContradiction：语义相似度越高，置信度单调不降', () => {
  const confidences = [0.3, 0.5, 0.75, 0.9, 0.99].map(
    (similarity) => assessContradiction('内存上限是 10.4GB', '内存上限是 20GB', { similarity }).confidence,
  )
  for (let i = 1; i < confidences.length; i++) {
    assert.ok(confidences[i]! >= confidences[i - 1]!, `第 ${i} 档不应下降`)
  }
  assert.ok(confidences[4]! > confidences[0]!)
})

test('assessContradiction：不传 similarity 时用词面 Jaccard 兜底', () => {
  const left = '内存上限是 10.4GB'
  const right = '内存上限是 20GB'
  const result = assessContradiction(left, right)
  approx(result.similarity, lexicalSimilarity(left, right))
  approx(result.similarity, 2 / 3)
  assert.ok(result.confidence > 0)
})

test('contradictionLevel：阈值边界与越界夹取', () => {
  assert.equal(contradictionLevel(1), 'high')
  assert.equal(contradictionLevel(CONTRADICTION_HIGH), 'high')
  assert.equal(contradictionLevel(CONTRADICTION_HIGH - 0.0001), 'medium')
  assert.equal(contradictionLevel(CONTRADICTION_MEDIUM), 'medium')
  assert.equal(contradictionLevel(CONTRADICTION_MEDIUM - 0.0001), 'low')
  assert.equal(contradictionLevel(0), 'low')
  assert.equal(contradictionLevel(2), 'high', '越界按 1 夹取')
  assert.equal(contradictionLevel(-1), 'low', '越界按 0 夹取')
})

// ---------------------------------------------------------------- 文本工具

test('textTokens / lexicalSimilarity：CJK bigram + 拉丁 token', () => {
  const tokens = textTokens('设备是 aarch64')
  assert.ok(tokens.includes('aarch64'))
  assert.ok(tokens.includes('设备'))
  assert.equal(lexicalSimilarity('完全一样的内容', '完全一样的内容'), 1)
  assert.equal(lexicalSimilarity('甲', '乙'), 0)
  assert.equal(lexicalSimilarity('', ''), 0)
})

test('assessRecordContradiction：记录版等价于正文版', () => {
  const a = record('内存上限是 10.4GB')
  const b = record('内存上限是 20GB')
  const byRecords = assessRecordContradiction(a, b, { similarity: 0.96 })
  const byContent = assessContradiction(a.content, b.content, { similarity: 0.96 })
  assert.equal(byRecords.confidence, byContent.confidence)
  assert.equal(byRecords.level, 'high')
})
