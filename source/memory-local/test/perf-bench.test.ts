/**
 * 基准工具库（tools/bench/lib.mjs）的冒烟测试。
 *
 * 压测脚本本身不进 CI（`npm test` 不跑它），但它的合成数据/统计/表格代码是
 * 基准数字可信度的来源：这里只验"可复现、归一化、统计口径、输出格式"，
 * 不跑任何真实后端，也不跑 2000→20000 的大规模建图。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  detectDevice,
  formatMs,
  healthUrlOf,
  makeClusteredVectors,
  makeCorpus,
  markdownTable,
  mulberry32,
  noisedVector,
  percentile,
  probeLive,
  round,
  summarizeLatencies,
  syntheticEmbed,
  tokenizeForEmbedding,
} from '../../../tools/bench/lib.mjs'

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!
  return sum
}

test('合成嵌入：确定、单位长度、共享词更相近', () => {
  const a = syntheticEmbed('部署 release 回滚 rollback 流水线', 64)
  const b = syntheticEmbed('部署 release 回滚 rollback 流水线', 64)
  const related = syntheticEmbed('部署 release 回滚 rollback 灰度', 64)
  const unrelated = syntheticEmbed('数据库 transaction 索引 migration', 64)
  assert.deepEqual([...a], [...b], '同文本必须完全一致（缓存的正确性依赖它）')
  assert.ok(Math.abs(dot(a, a) - 1) < 1e-6, '必须 L2 归一化')
  assert.ok(dot(a, related) > dot(a, unrelated), '共享 token 的文本余弦应更高')
})

test('分词：拉丁词 + CJK 单字/双字', () => {
  const tokens = tokenizeForEmbedding('部署 release 2.0')
  assert.ok(tokens.includes('release'))
  assert.ok(tokens.includes('部'))
  assert.ok(tokens.includes('部署'))
})

test('makeCorpus：同 seed 完全可复现，记录/查询数量正确', () => {
  const first = makeCorpus(20, { dims: 32, seed: 7, queryCount: 5 })
  const second = makeCorpus(20, { dims: 32, seed: 7, queryCount: 5 })
  assert.equal(first.records.length, 20)
  assert.equal(first.queries.length, 5)
  assert.deepEqual(first.records.map((record) => record.content), second.records.map((record) => record.content))
  assert.deepEqual(first.records[0]!.vector, second.records[0]!.vector)
  assert.ok(first.records[0]!.content.length > 0)
  const other = makeCorpus(20, { dims: 32, seed: 8, queryCount: 5 })
  assert.notDeepEqual(first.records.map((record) => record.content), other.records.map((record) => record.content))
})

test('makeClusteredVectors：条数/维度/归一化/可复现', () => {
  const items = makeClusteredVectors(30, 16, { clusters: 4, seed: 3 })
  assert.equal(items.length, 30)
  assert.equal(items[0]!.vector.length, 16)
  for (const item of items) assert.ok(Math.abs(dot(item.vector, item.vector) - 1) < 1e-6)
  const again = makeClusteredVectors(30, 16, { clusters: 4, seed: 3 })
  assert.deepEqual(items[0]!.vector, again[0]!.vector)
  // 同簇相似度高于异簇（i 对 i+clusters 同簇）
  assert.ok(dot(items[0]!.vector, items[4]!.vector) > dot(items[0]!.vector, items[1]!.vector))
})

test('noisedVector：方向保持但不再相同', () => {
  const base = makeClusteredVectors(1, 64, { clusters: 1, seed: 9 })[0]!.vector
  const noisy = noisedVector(base, 0.3, mulberry32(5))
  assert.ok(dot(base, noisy) > 0.5)
  assert.notDeepEqual([...base], [...noisy])
  assert.ok(Math.abs(dot(noisy, noisy) - 1) < 1e-6)
})

test('统计口径：percentile / summarizeLatencies / round / formatMs', () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  assert.equal(percentile(values, 50), 5)
  assert.equal(percentile(values, 95), 10)
  assert.equal(percentile([], 95), 0)
  const summary = summarizeLatencies(values)
  assert.equal(summary.count, 10)
  assert.equal(summary.mean, 5.5)
  assert.equal(summary.p50, 5)
  assert.equal(summary.min, 1)
  assert.equal(summary.max, 10)
  assert.equal(summarizeLatencies([]).count, 0)
  assert.equal(round(1.2345, 2), 1.23)
  assert.equal(formatMs(12.345), '12.35ms')
  assert.equal(formatMs(1500), '1.5s')
})

test('markdownTable：表头/分隔/转义', () => {
  const table = markdownTable(['a', 'b'], [[1, 'x|y']])
  const lines = table.split('\n')
  assert.equal(lines[0], '| a | b |')
  assert.equal(lines[1], '| --- | --- |')
  assert.equal(lines[2], '| 1 | x\\|y |')
})

test('healthUrlOf：从 /v1/embeddings 推出 /health', () => {
  assert.equal(healthUrlOf('http://127.0.0.1:8078/v1/embeddings'), 'http://127.0.0.1:8078/health')
  assert.equal(healthUrlOf('http://127.0.0.1:8078'), 'http://127.0.0.1:8078/health')
  assert.equal(healthUrlOf('not a url'), 'not a url')
})

test('probeLive：后端不可达返回 false（带超时，不抛）', async () => {
  assert.equal(await probeLive('http://127.0.0.1:1/v1/embeddings', 300), false)
})

test('detectDevice：给出可存档的设备信息', () => {
  const device = detectDevice()
  assert.equal(typeof device.platform, 'string')
  assert.equal(typeof device.arch, 'string')
  assert.ok(device.node.startsWith('v'))
  assert.equal(typeof device.cpuModel, 'string')
  assert.ok(device.cpuModel.length > 0)
  assert.ok(device.cpuCount >= 1)
  assert.ok(device.totalMemMB > 0)
  assert.ok(device.measuredAt.includes('T'))
})
