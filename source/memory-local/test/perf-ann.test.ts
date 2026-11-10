/**
 * ANN（任务书 §3）的回归测试。
 *
 * 覆盖：纯 JS HNSW（召回率 vs 全量扫描、update/remove、确定性、维度校验）、
 * 全量扫描兜底、hnswlib-node 可选依赖的"缺失即退化"路径、以及用 fake 原生模块
 * 验证适配器（标签映射 / 墓碑删除 / 容量 resize）——不需要真的安装原生依赖。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ANN_MIN_SIZE,
  BruteAnnIndex,
  HnswLiteIndex,
  HnswlibIndex,
  createAnnIndex,
  loadHnswlib,
  resetHnswlibCache,
  shouldUseAnn,
  type HnswlibInstanceLike,
  type HnswlibModuleLike,
} from '../src/ann/index.ts'

const DIMS = 8

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function unitVector(seed: number, dims = DIMS): Float32Array {
  const random = mulberry32(seed)
  const vector = new Float32Array(dims)
  for (let i = 0; i < dims; i++) vector[i] = random() * 2 - 1
  let sum = 0
  for (const value of vector) sum += value * value
  const norm = Math.sqrt(sum)
  for (let i = 0; i < dims; i++) vector[i] = vector[i]! / norm
  return vector
}

/** 聚簇向量：真实记忆库的语义分布（同簇更近），比均匀随机更能测出 ANN 质量。 */
function clusteredItems(count: number, dims = 32, clusters = 12, seed = 11): Array<{ id: string; vector: Float32Array }> {
  const random = mulberry32(seed)
  const gaussian = () => Math.sqrt(-2 * Math.log(Math.max(random(), 1e-12))) * Math.cos(2 * Math.PI * random())
  const centers: Float32Array[] = []
  for (let c = 0; c < clusters; c++) {
    const center = new Float32Array(dims)
    for (let d = 0; d < dims; d++) center[d] = gaussian()
    let sum = 0
    for (const value of center) sum += value * value
    const norm = Math.sqrt(sum)
    for (let d = 0; d < dims; d++) center[d] = center[d]! / norm
    centers.push(center)
  }
  const items = []
  for (let i = 0; i < count; i++) {
    const center = centers[i % clusters]!
    const vector = new Float32Array(dims)
    for (let d = 0; d < dims; d++) vector[d] = center[d]! + gaussian() * 0.5
    let sum = 0
    for (const value of vector) sum += value * value
    const norm = Math.sqrt(sum)
    for (let d = 0; d < dims; d++) vector[d] = vector[d]! / norm
    items.push({ id: `m-${i}`, vector })
  }
  return items
}

function recallOf(hits: Array<{ id: string }>, truth: Array<{ id: string }>): number {
  const truthSet = new Set(truth.map((hit) => hit.id))
  let matched = 0
  for (const hit of hits) if (truthSet.has(hit.id)) matched += 1
  return truth.length === 0 ? 1 : matched / truth.length
}

// ---------------------------------------------------------------------------
// 全量扫描兜底
// ---------------------------------------------------------------------------

test('brute：build/search 排序正确，threshold 生效', () => {
  const index = new BruteAnnIndex(DIMS)
  index.build([
    { id: 'a', vector: unitVector(1) },
    { id: 'b', vector: unitVector(2) },
    { id: 'c', vector: unitVector(3) },
  ])
  assert.equal(index.kind, 'brute')
  assert.equal(index.size, 3)
  const query = unitVector(2)
  const hits = index.search(query, 3)
  assert.equal(hits.length, 3)
  assert.equal(hits[0]!.id, 'b', '与查询完全相同的向量应排第一')
  assert.ok(hits[0]!.score > hits[1]!.score)
  assert.ok(hits[1]!.score >= hits[2]!.score)
  const filtered = index.search(query, 3, { threshold: 0.99 })
  assert.deepEqual(filtered.map((hit) => hit.id), ['b'])
  assert.equal(index.search(query, 0).length, 0)
})

test('brute：insert/update/remove/has/clear 与维度校验', () => {
  const index = new BruteAnnIndex(DIMS)
  assert.equal(index.insert('a', unitVector(1)), true)
  assert.equal(index.insert('a', unitVector(1)), false, '重复 id 不应插入')
  assert.equal(index.has('a'), true)
  assert.equal(index.update('missing', unitVector(1)), false)
  index.insert('b', unitVector(2))
  index.update('b', unitVector(3))
  assert.equal(index.search(unitVector(3), 1)[0]!.id, 'b')
  assert.equal(index.remove('missing'), false)
  assert.equal(index.remove('a'), true)
  assert.equal(index.size, 1)
  assert.throws(() => index.insert('bad', new Float32Array([1, 2, 3])), /维度不符/)
  assert.throws(() => new BruteAnnIndex(0), /dims 非法/)
  index.clear()
  assert.equal(index.size, 0)
})

// ---------------------------------------------------------------------------
// 纯 JS HNSW
// ---------------------------------------------------------------------------

test('hnswlite：1000 条聚簇向量 recall@10 >= 0.95（以全量扫描为 ground truth）', () => {
  const items = clusteredItems(1000)
  const ann = new HnswLiteIndex({ dims: 32, M: 24, seed: 7 })
  ann.build(items)
  const brute = new BruteAnnIndex(32)
  brute.build(items)
  assert.equal(ann.size, 1000)
  const random = mulberry32(123)
  let recall = 0
  const queries = 40
  for (let i = 0; i < queries; i++) {
    const base = items[Math.floor(random() * items.length)]!
    const query = new Float32Array(base.vector)
    for (let d = 0; d < query.length; d++) query[d] += (random() * 2 - 1) * 0.15
    recall += recallOf(ann.search(query, 10), brute.search(query, 10))
  }
  recall /= queries
  assert.ok(recall >= 0.95, `recall@10=${recall.toFixed(3)} 低于阈值`)
  const stats = ann.stats()
  assert.equal(stats.kind, 'hnswlite')
  assert.equal(stats.size, 1000)
  assert.equal(stats.nodes, 1000)
  assert.ok(typeof stats.maxLevel === 'number')
})

test('hnswlite：同 seed 可复现（两次 build 的查询结果一致）', () => {
  const items = clusteredItems(200, 16, 8, 5)
  const build = () => {
    const index = new HnswLiteIndex({ dims: 16, seed: 42, efConstruction: 100, efSearch: 40 })
    index.build(items)
    return index
  }
  const a = build()
  const b = build()
  const query = items[0]!.vector
  assert.deepEqual(a.search(query, 5).map((hit) => hit.id), b.search(query, 5).map((hit) => hit.id))
})

test('hnswlite：insert / update / remove / has，删除后不再出现在结果里', () => {
  const items = clusteredItems(300, 16, 8, 9)
  const ann = new HnswLiteIndex({ dims: 16, seed: 3 })
  ann.build(items.slice(0, 250))
  // 增量插入
  for (const item of items.slice(250)) assert.equal(ann.insert(item.id, item.vector), true)
  assert.equal(ann.size, 300)
  assert.equal(ann.insert(items[0]!.id, items[0]!.vector), false, '重复 id 返回 false')

  // update 成与查询完全相同的向量 → 必然 top1
  const target = items[200]!
  const query = unitVector(999, 16)
  ann.update(target.id, query)
  assert.deepEqual(ann.search(query, 1).map((hit) => hit.id), [target.id])

  // remove 后不再返回；其余保持可用
  assert.equal(ann.remove(target.id), true)
  assert.equal(ann.remove(target.id), false)
  assert.equal(ann.has(target.id), false)
  assert.equal(ann.size, 299)
  assert.deepEqual(ann.search(query, 5).map((hit) => hit.id).includes(target.id), false)
  assert.equal(ann.update('missing-id', query), false)
  ann.clear()
  assert.equal(ann.size, 0)
  assert.deepEqual(ann.search(query, 5), [])
})

test('hnswlite：k 超过条目数、threshold、维度校验', () => {
  const items = clusteredItems(20, 8, 4, 21)
  const ann = new HnswLiteIndex({ dims: 8, seed: 1 })
  ann.build(items)
  const hits = ann.search(items[0]!.vector, 100)
  assert.equal(hits.length, 20, 'k > size 时返回全部存活条目')
  assert.deepEqual(ann.search(items[0]!.vector, 5, { threshold: 2 }).length, 0)
  assert.throws(() => ann.search(new Float32Array([1, 2]), 5), /维度不符/)
  assert.throws(() => ann.build([{ id: 'x', vector: new Float32Array([1, 2]) }]), /维度不符/)
})

test('hnswlite：阈值过滤与 score 降序', () => {
  const items = clusteredItems(100, 8, 4, 31)
  const ann = new HnswLiteIndex({ dims: 8, seed: 2 })
  ann.build(items)
  const hits = ann.search(items[0]!.vector, 10)
  for (let i = 1; i < hits.length; i++) assert.ok(hits[i - 1]!.score >= hits[i]!.score)
  const filtered = ann.search(items[0]!.vector, 10, { threshold: hits[0]!.score - 1e-9 })
  assert.deepEqual(filtered.map((hit) => hit.id), [hits[0]!.id])
})

// ---------------------------------------------------------------------------
// hnswlib-node 可选依赖
// ---------------------------------------------------------------------------

test('loadHnswlib：未安装返回 null（装了则返回合法模块），不抛错', async () => {
  resetHnswlibCache()
  const module = await loadHnswlib()
  if (module === null) {
    assert.equal(module, null)
  } else {
    assert.equal(typeof module.HierarchicalNSW, 'function')
  }
})

test('createAnnIndex：可选依赖缺失时 prefer=hnswlib 自动回退纯 JS，并打一条说明', async () => {
  resetHnswlibCache()
  const logs: string[] = []
  const index = await createAnnIndex({ dims: DIMS, prefer: 'hnswlib', log: (message) => logs.push(message) })
  if ((await loadHnswlib()) === null) {
    assert.equal(index.kind, 'hnswlite', '未安装原生模块 → 回退纯 JS HNSW')
    assert.ok(logs.some((message) => message.includes('hnswlib-node')), logs.join('\n'))
  } else {
    assert.equal(index.kind, 'hnswlib')
  }
  index.build([{ id: 'a', vector: unitVector(1) }])
  assert.equal(index.search(unitVector(1), 1)[0]!.id, 'a')
})

test('createAnnIndex：auto → 纯 JS HNSW；brute → 全量扫描；未知选型抛错', async () => {
  const auto = await createAnnIndex({ dims: DIMS })
  assert.equal(auto.kind, 'hnswlite')
  const brute = await createAnnIndex({ dims: DIMS, prefer: 'brute' })
  assert.equal(brute.kind, 'brute')
  await assert.rejects(() => createAnnIndex({ dims: DIMS, prefer: 'nope' as never }), /未知的 ANN 选型/)
})

test('shouldUseAnn：小库继续全量扫描，大库才值得建图', () => {
  assert.equal(shouldUseAnn(0), false)
  assert.equal(shouldUseAnn(ANN_MIN_SIZE - 1), false)
  assert.equal(shouldUseAnn(ANN_MIN_SIZE), true)
  assert.equal(shouldUseAnn(20_000), true)
})

// ---------------------------------------------------------------------------
// hnswlib 适配器（fake 原生模块，不依赖真实安装）
// ---------------------------------------------------------------------------

/** 精确余弦检索的 fake：只验证适配器的标签映射/墓碑/resize，不测近似算法。 */
class FakeHnswlib {
  static instances: FakeHnswlib[] = []
  points = new Map<number, Float32Array>()
  deleted = new Set<number>()
  initLog: Array<{ maxElements: number; M: number; efConstruction: number }> = []
  resizes: number[] = []
  ef = 0
  private dims: number

  constructor(_space: string, dims: number) {
    this.dims = dims
    FakeHnswlib.instances.push(this)
  }

  initIndex(maxElements = 1000, M = 16, efConstruction = 200): void {
    this.initLog.push({ maxElements, M, efConstruction })
  }

  setEf(ef: number): void {
    this.ef = ef
  }

  addPoint(vector: ArrayLike<number>, label: number): void {
    if (label < 0) throw new Error('bad label')
    this.points.set(label, Float32Array.from(vector))
  }

  markDelete(label: number): void {
    this.deleted.add(label)
  }

  searchKnn(query: ArrayLike<number>, k: number): { neighbors: number[]; distances: number[] } {
    const scored: Array<{ label: number; distance: number }> = []
    for (const [label, vector] of this.points) {
      if (this.deleted.has(label)) continue
      let dot = 0
      for (let i = 0; i < this.dims; i++) dot += query[i]! * vector[i]!
      scored.push({ label, distance: 1 - dot })
    }
    scored.sort((a, b) => a.distance - b.distance)
    return {
      neighbors: scored.slice(0, k).map((entry) => entry.label),
      distances: scored.slice(0, k).map((entry) => entry.distance),
    }
  }

  getCurrentCount(): number {
    return this.points.size
  }

  resizeIndex(newSize: number): void {
    this.resizes.push(newSize)
  }
}

const fakeModule = { HierarchicalNSW: FakeHnswlib } as unknown as HnswlibModuleLike

test('hnswlib 适配器：标签映射 / 查询 / update / remove / 墓碑过滤', async () => {
  FakeHnswlib.instances = []
  const index = await HnswlibIndex.create({ dims: DIMS, maxElements: 16 }, fakeModule)
  assert.ok(index !== null)
  assert.equal(index!.kind, 'hnswlib')

  index!.build([{ id: 'a', vector: unitVector(1) }, { id: 'b', vector: unitVector(2) }])
  assert.equal(index!.size, 2)
  assert.deepEqual(index!.search(unitVector(2), 1).map((hit) => hit.id), ['b'])
  assert.equal(index!.has('a'), true)

  // update：旧标签 markDelete，新标签 addPoint；新向量必须生效。
  assert.equal(index!.update('a', unitVector(3)), true)
  assert.deepEqual(index!.search(unitVector(3), 1).map((hit) => hit.id), ['a'])
  assert.equal(index!.insert('a', unitVector(1)), false, 'id 仍存在 → 不重复插入')
  assert.equal(index!.insert('c', unitVector(4)), true)

  assert.equal(index!.remove('b'), true)
  assert.equal(index!.has('b'), false)
  assert.equal(index!.search(unitVector(2), 3).some((hit) => hit.id === 'b'), false)
  assert.equal(index!.remove('missing'), false)

  const stats = index!.stats()
  assert.equal(stats.kind, 'hnswlib')
  assert.equal(stats.size, 2, 'a + c')
})

test('hnswlib 适配器：超过初始容量自动 resize', async () => {
  FakeHnswlib.instances = []
  const index = await HnswlibIndex.create({ dims: DIMS, maxElements: 16 }, fakeModule)
  assert.ok(index !== null)
  for (let i = 0; i < 20; i++) index!.insert(`m-${i}`, unitVector(i + 1))
  assert.equal(index!.size, 20)
  const instance = FakeHnswlib.instances.at(-1)!
  assert.ok(instance.resizes.length >= 1, '容量不够时必须 resizeIndex')
})

test('hnswlib 适配器：threshold 过滤与空查询', async () => {
  const index = await HnswlibIndex.create({ dims: DIMS }, fakeModule)
  assert.ok(index !== null)
  assert.deepEqual(index!.search(unitVector(1), 5), [])
  index!.build([{ id: 'a', vector: unitVector(1) }])
  assert.equal(index!.search(unitVector(1), 5, { threshold: 2 }).length, 0)
  assert.equal(index!.search(unitVector(1), 5)[0]!.id, 'a')
  index!.clear()
  assert.equal(index!.size, 0)
})

test('hnswlib 适配器：原生模块初始化抛错 → create 返回 null（调用方降级）', async () => {
  const broken = {
    HierarchicalNSW: class {
      constructor() {
        throw new Error('ABI mismatch')
      }
    },
  } as unknown as HnswlibModuleLike
  assert.equal(await HnswlibIndex.create({ dims: DIMS }, broken), null)
})
