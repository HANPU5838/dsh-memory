/**
 * 记忆巩固（cognitive/consolidate）：聚类、抽取式合并计划、落盘与谱系。
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MemoryStore,
  cosineSimilarity,
  scopeFileName,
  type CognitiveRecord,
  type MemoryRecord,
  type MemoryScope,
} from '../src/store.ts'
import { isActiveNow } from '../src/cognitive/temporal.ts'
import {
  CONSOLIDATION_THRESHOLD,
  applyConsolidationPlan,
  clusterRecords,
  consolidationScore,
  planConsolidation,
  splitPoints,
  type RecordCluster,
} from '../src/cognitive/consolidate.ts'

const DAY = 86_400_000
// 固定在一个月后的时间点：记录都是"现在"写入的，在 NOW 时刻它们已经生效。
const NOW = Date.now() + 30 * DAY

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const DEFAULTS = { importance: 0.5, source: { origin: 'explicit' as const } }
type SaveInput = Parameters<MemoryStore['save']>[0]

function freshStore(): { store: MemoryStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cog-consolidate-'))
  dirs.push(dir)
  return { store: new MemoryStore(dir), dir }
}

function save(
  store: MemoryStore,
  content: string,
  extra: Record<string, unknown> = {},
  scope: MemoryScope = 'project:c',
): CognitiveRecord {
  return store.save({ scope, kind: 'note', content, ...extra } as SaveInput, DEFAULTS).record as CognitiveRecord
}

/** 手搓一条记录（纯函数测试用，不落 store）。 */
let seq = 0
function rec(content: string, extra: Partial<CognitiveRecord> = {}): CognitiveRecord {
  seq++
  const createdAt = extra.createdAt ?? NOW - 1000 + seq
  return {
    id: `id-${seq}`,
    scope: 'project:c',
    kind: 'note',
    content,
    tags: [],
    source: { origin: 'explicit' },
    createdAt,
    updatedAt: extra.updatedAt ?? createdAt,
    lastAccessedAt: createdAt,
    accessCount: 0,
    importance: 0.5,
    ...extra,
  } as CognitiveRecord
}

function clusterOf(records: MemoryRecord[], cohesion = 0.95): RecordCluster {
  return {
    scope: records[0]?.scope ?? 'project:c',
    ids: records.map((record) => record.id),
    records,
    cohesion,
  }
}

function vec(x: number, y: number, z = 0): Float32Array {
  return Float32Array.from([x, y, z])
}

// ---------------------------------------------------------------- 聚类（纯函数）

test('clusterRecords：按余弦阈值聚簇，返回 cohesion，未达阈值的单独留下', () => {
  const a = rec('端点 A 的记忆')
  const b = rec('端点 B 的记忆')
  const c = rec('完全无关的记忆')
  const d = rec('端点 D 的记忆')
  const vectors = new Map<string, Float32Array>([
    [a.id, vec(1, 0, 0)],
    [b.id, vec(0.99, 0.1, 0)],
    [c.id, vec(0, 1, 0)],
    [d.id, vec(0.98, 0.15, 0.1)],
  ])
  const result = clusterRecords([a, b, c, d], { vectors })
  assert.equal(result.clusters.length, 1, '无关记录不构成簇')
  const cluster = result.clusters[0]!
  assert.deepEqual([...cluster.ids].sort(), [a.id, b.id, d.id].sort())
  assert.equal(cluster.scope, 'project:c')
  const expected = (cosineSimilarity(vec(1, 0, 0), vec(0.99, 0.1, 0))
    + cosineSimilarity(vec(1, 0, 0), vec(0.98, 0.15, 0.1))
    + cosineSimilarity(vec(0.99, 0.1, 0), vec(0.98, 0.15, 0.1))) / 3
  assert.ok(Math.abs(cluster.cohesion - expected) < 1e-9, `cohesion=${cluster.cohesion} expected=${expected}`)
})

test('clusterRecords：阈值是闭区间下界（恰好等于阈值 → 聚成一簇）', () => {
  const a = rec('甲')
  const b = rec('乙')
  const atThreshold = clusterRecords([a, b], { similarity: () => 0.9, threshold: 0.9 })
  assert.equal(atThreshold.clusters.length, 1)
  const aboveThreshold = clusterRecords([a, b], { similarity: () => 0.9, threshold: 0.900001 })
  assert.equal(aboveThreshold.clusters.length, 0)
})

test('clusterRecords：跨 scope 不合并（作用域边界优先）', () => {
  const a = rec('同一条经验', { scope: 'project:one' })
  const b = rec('同一条经验', { scope: 'project:two' })
  const result = clusterRecords([a, b], { similarity: () => 1, threshold: 0.9 })
  assert.equal(result.clusters.length, 0)
  assert.equal(result.comparedPairs, 0)
})

test('clusterRecords：没传 vectors / similarity 时按归一化内容精确聚类', () => {
  const a = rec('Hello   World')
  const b = rec('hello world')
  const c = rec('完全不同的内容')
  const result = clusterRecords([a, b, c])
  assert.equal(result.clusters.length, 1)
  assert.deepEqual([...result.clusters[0]!.ids].sort(), [a.id, b.id].sort())
  assert.equal(result.clusters[0]!.cohesion, 1)
})

test('clusterRecords：tombstone 软删记录默认跳过', () => {
  const a = rec('同样的内容')
  const b = rec('同样的内容', { tombstonedAt: NOW })
  assert.equal(clusterRecords([a, b]).clusters.length, 0)
  const included = clusterRecords([a, b], { includeTombstoned: true })
  assert.equal(included.clusters.length, 1)
})

test('clusterRecords：缺向量的记录进 skippedNoVector，不参与比较', () => {
  const a = rec('有向量')
  const b = rec('缺向量')
  const vectors = new Map<string, Float32Array>([[a.id, vec(1, 0, 0)]])
  const result = clusterRecords([a, b], { vectors })
  assert.deepEqual(result.skippedNoVector, [b.id])
  assert.equal(result.clusters.length, 0)
})

test('clusterRecords：maxRecords 截断时保留最近更新的那批', () => {
  const old = rec('旧', { updatedAt: NOW - 3000 })
  const middle = rec('中', { updatedAt: NOW - 2000 })
  const fresh = rec('新', { updatedAt: NOW - 1000 })
  const result = clusterRecords([old, middle, fresh], { similarity: () => 1, maxRecords: 2 })
  const ids = result.clusters.flatMap((cluster) => cluster.ids)
  assert.ok(!ids.includes(old.id), '最老的记录被截断')
  assert.ok(ids.includes(middle.id) && ids.includes(fresh.id))
})

test('clusterRecords：多个簇按规模降序', () => {
  const one = rec('一')
  const two = rec('二')
  const three = rec('三')
  const four = rec('四')
  const five = rec('五')
  // 前三相似成 3 簇，后两相似成 2 簇。
  const groups: Array<MemoryRecord[]> = [
    [one, two, three],
    [four, five],
  ]
  const similarity = (a: MemoryRecord, b: MemoryRecord): number => {
    for (const group of groups) if (group.includes(a) && group.includes(b)) return 1
    return 0
  }
  const result = clusterRecords([one, two, three, four, five], { similarity, threshold: 0.9 })
  assert.equal(result.clusters.length, 2)
  assert.equal(result.clusters[0]!.ids.length, 3)
  assert.equal(result.clusters[1]!.ids.length, 2)
})

test('splitPoints：按中英文句末标点与换行切分，保留句末标点', () => {
  assert.deepEqual(splitPoints('第一句。第二句！第三句？'), ['第一句。', '第二句！', '第三句？'])
  assert.deepEqual(splitPoints('一行\n二行'), ['一行', '二行'])
  assert.deepEqual(splitPoints('短'), [], '单字符碎片丢弃')
})

// ---------------------------------------------------------------- 合并计划（纯函数）

test('consolidationScore：utility 缺省中性 0.5，importance 参与加权', () => {
  const withUtility = rec('a', { utility: 1, importance: 1 })
  const noUtility = rec('b', { importance: 1 })
  const low = rec('c', { utility: 0.1, importance: 0.2 })
  assert.ok(consolidationScore(withUtility) > consolidationScore(noUtility))
  assert.ok(consolidationScore(noUtility) > consolidationScore(low))
  assert.ok(Math.abs(consolidationScore(noUtility) - (0.6 * 0.5 + 0.4 * 1)) < 1e-9)
})

test('planConsolidation：基底 = utility/importance 得分最高者，正文抽取式追加独有要点', () => {
  const a = rec('设备是 aarch64。使用 pnpm 管理依赖。', { utility: 0.2, importance: 0.3 })
  const b = rec('设备是 aarch64。', { utility: 0.9, importance: 0.5 })
  const c = rec('运行 uname -m 返回 aarch64。', { utility: 0.4, importance: 0.9 })
  const plan = planConsolidation(clusterOf([a, b, c]), { now: NOW, maxChars: 2000 })!
  assert.equal(plan.baseId, b.id, 'B 的 utility+importance 最高')
  assert.ok(plan.content.startsWith('设备是 aarch64。'))
  assert.ok(plan.content.includes('使用 pnpm 管理依赖。'), '从 A 抽到的独有要点')
  assert.ok(plan.content.includes('运行 uname -m 返回 aarch64。'), '从 C 抽到的独有要点')
  assert.ok(!plan.content.includes('使用 pnpm 管理依赖。\n设备是'), '基底没被重复追加')
  assert.deepEqual([...plan.addedPoints].sort(), ['使用 pnpm 管理依赖。', '运行 uname -m 返回 aarch64。'].sort())
})

test('planConsolidation：簇内重复要点不追加（基底已覆盖 → addedPoints 为空）', () => {
  const a = rec('设备是 aarch64。', { importance: 0.6 })
  const b = rec('设备是 aarch64。', { importance: 0.4 })
  const plan = planConsolidation(clusterOf([a, b]), { now: NOW })!
  assert.deepEqual(plan.addedPoints, [])
  assert.equal(plan.content, '设备是 aarch64。')
})

test('planConsolidation：tags 并集 / importance 取大 / generation=max+1 / supersedes 全簇', () => {
  const a = rec('甲记录。', { tags: ['a', 'b'], importance: 0.2, generation: 1 })
  const b = rec('乙记录。', { tags: ['b', 'c'], importance: 0.8, generation: 3 })
  const c = rec('丙记录。', { tags: [], importance: 0.5, generation: 2 })
  const plan = planConsolidation(clusterOf([a, b, c]), { now: NOW })!
  assert.equal(plan.baseId, b.id)
  assert.deepEqual([...plan.tags].sort(), ['a', 'b', 'c'])
  assert.equal(plan.importance, 0.8)
  assert.equal(plan.generation, 4, '簇内最大 generation=3 → 4')
  assert.deepEqual(plan.supersedes, [b.id, c.id, a.id], '基底排第一，其余按得分降序')
  assert.deepEqual([...plan.consolidatedFrom].sort(), [a.id, b.id, c.id].sort(), 'consolidatedFrom 记全部来源')
  assert.equal(plan.scope, 'project:c')
  assert.equal(plan.cohesion, 0.95)
})

test('planConsolidation：stability/utility 取最大，useCount 求和，lastUsedAt 取最新', () => {
  const a = rec('甲。', { stability: 2, utility: 0.2, useCount: 2, lastUsedAt: NOW - 2000, difficulty: 0.2 })
  const b = rec('乙。', { stability: 5, utility: 0.9, useCount: 0, lastUsedAt: NOW - 5000, difficulty: 0.7 })
  const c = rec('丙。', { stability: 3, utility: 0.4, useCount: 3, lastUsedAt: NOW - 1000, difficulty: 0.4 })
  const plan = planConsolidation(clusterOf([a, b, c]), { now: NOW })!
  assert.equal(plan.stability, 5)
  assert.equal(plan.utility, 0.9)
  assert.equal(plan.difficulty, 0.7)
  assert.equal(plan.useCount, 5)
  assert.equal(plan.lastUsedAt, NOW - 1000)
})

test('planConsolidation：validFrom 取最早、validUntil 全有限时取最晚', () => {
  const a = rec('甲。', { validFrom: 100, validUntil: 500, importance: 0.6 })
  const b = rec('乙。', { validFrom: 50, validUntil: 900 })
  const c = rec('丙。', { validFrom: 200, validUntil: 700 })
  const plan = planConsolidation(clusterOf([a, b, c]), { now: NOW })!
  assert.equal(plan.validFrom, 50)
  assert.equal(plan.validUntil, 900)
})

test('planConsolidation：任一来源永不过期 → 合并版本也永不过期', () => {
  const a = rec('甲。', { importance: 0.6, validUntil: 500 })
  const b = rec('乙。')
  const plan = planConsolidation(clusterOf([a, b]), { now: NOW })!
  assert.equal(plan.validUntil, undefined)
})

test('planConsolidation：maxChars 截断正文，且不超过上限', () => {
  const base = rec('短基底。', { importance: 0.9 })
  const other = rec('使用 pnpm 管理项目依赖并且保持所有机器上的版本完全一致。')
  const plan = planConsolidation(clusterOf([base, other]), { now: NOW, maxChars: 20 })!
  assert.equal(plan.content.length, 20)
  assert.ok(plan.content.startsWith('短基底。'))
  assert.equal(plan.addedPoints.length, 1)
  assert.ok(plan.content.endsWith(plan.addedPoints[0]!))
})

test('planConsolidation：成员 < 2 / 全软删 → null（单条记录不需要巩固）', () => {
  assert.equal(planConsolidation(clusterOf([]), { now: NOW }), null)
  assert.equal(planConsolidation(clusterOf([rec('单独一条')]), { now: NOW }), null)
  const doomedA = rec('甲。', { tombstonedAt: NOW })
  const doomedB = rec('乙。', { tombstonedAt: NOW })
  assert.equal(planConsolidation(clusterOf([doomedA, doomedB]), { now: NOW }), null)
})

// ---------------------------------------------------------------- 落盘

test('applyConsolidationPlan：写入合并记录，基底退役，其余来源时间失效', () => {
  const { store } = freshStore()
  const base = save(store, '设备是 aarch64。', { tags: ['设备', '旧'], importance: 0.7, utility: 0.8, generation: 2 })
  const other = save(store, '使用 pnpm 管理依赖。', { tags: ['工具'], importance: 0.5 })
  const plan = planConsolidation(clusterOf([base, other], 0.97), { now: NOW })!
  assert.equal(plan.baseId, base.id)

  const result = applyConsolidationPlan(store, plan)
  const merged = store.findById(result.record.id) as CognitiveRecord
  assert.notEqual(merged, undefined)
  assert.equal(merged.scope, 'project:c')
  assert.equal(merged.content, plan.content)
  assert.equal(merged.generation, 3, '基底 generation=2 → 3')
  assert.deepEqual(merged.tags, plan.tags)
  assert.deepEqual(merged.consolidatedFrom, plan.consolidatedFrom)
  assert.equal(merged.supersedes, base.id)
  assert.equal(merged.stability, plan.stability)
  assert.equal(merged.utility, 0.8)
  assert.equal(result.superseded, base.id)
  assert.deepEqual(result.invalidated, [other.id])

  // 基底：被 supersedes 指向 = 退役历史版本（不删）
  assert.equal(store.scope('project:c').retiredIds().has(base.id), true)
  assert.notEqual(store.findById(base.id), undefined, '旧记录不删')
  // 其余来源：时间上失效，但保留历史
  const invalidated = store.findById(other.id) as CognitiveRecord
  assert.equal(invalidated.validUntil, NOW)
  assert.equal(isActiveNow(invalidated, NOW), false)

  // 谱系：新记录 → 基底
  const lineage = store.lineage(merged.id)!
  assert.equal(lineage.currentId, merged.id)
  assert.ok(lineage.entries.some((entry) => entry.id === base.id))
})

test('applyConsolidationPlan：不 flush（内存增量，调用方调度落盘）', () => {
  const { store, dir } = freshStore()
  const base = save(store, '甲。', { importance: 0.7 })
  const other = save(store, '乙。', { importance: 0.5 })
  store.flush()
  const plan = planConsolidation(clusterOf([base, other]), { now: NOW })!
  applyConsolidationPlan(store, plan)
  assert.equal(store.anyDirty(), true, '只进内存增量')
  store.flush()

  // 重开进程（新 store）能读回合并记录与失效标记
  const reopened = new MemoryStore(dir)
  reopened.loadAll(['project:c'])
  const mergedRecord = [...reopened.scope('project:c').records.values()].find(
    (record) => Array.isArray(record.consolidatedFrom) && record.consolidatedFrom.length === 2,
  )
  assert.notEqual(mergedRecord, undefined)
  assert.equal(mergedRecord!.content, plan.content)
  assert.notEqual(reopened.findById(plan.baseId), undefined, '旧记录保留在磁盘上')
  assert.equal((reopened.findById(other.id) as CognitiveRecord).validUntil, NOW)
})

test('applyConsolidationPlan：来源记录已被物理删除 → 记进 missing，不中断', () => {
  const { store } = freshStore()
  const base = save(store, '甲。', { importance: 0.7 })
  const other = save(store, '乙。', { importance: 0.5 })
  const plan = planConsolidation(clusterOf([base, other]), { now: NOW })!
  store.scope('project:c').remove(other.id)
  const result = applyConsolidationPlan(store, plan)
  assert.deepEqual(result.missing, [other.id])
  assert.deepEqual(result.invalidated, [])
  assert.notEqual(store.findById(result.record.id), undefined, '合并记录照常写入')
})

test('applyConsolidationPlan：baseId 不在 supersedes 里 → 早失败', () => {
  const { store } = freshStore()
  const a = save(store, '甲。')
  const b = save(store, '乙。')
  const plan = planConsolidation(clusterOf([a, b]), { now: NOW })!
  const broken = { ...plan, baseId: '不属于这个簇的-id' }
  assert.throws(() => applyConsolidationPlan(store, broken), /baseId/)
})

// ---------------------------------------------------------------- 端到端

test('端到端：聚类 → 计划 → 落盘，簇内只剩一个当前有效版本', () => {
  const { store } = freshStore()
  const records = [
    save(store, '设备是 aarch64。', { utility: 0.9, importance: 0.8 }),
    save(store, '设备是 aarch64。使用 pnpm 管理依赖。', { utility: 0.3, importance: 0.5 }),
    save(store, '运行 uname -m 返回 aarch64。', { utility: 0.2, importance: 0.4 }),
  ]
  const vectors = new Map<string, Float32Array>([
    [records[0]!.id, vec(1, 0, 0)],
    [records[1]!.id, vec(0.99, 0.1, 0)],
    [records[2]!.id, vec(0.97, 0.2, 0.05)],
  ])
  const clustered = clusterRecords(records, { vectors })
  assert.equal(clustered.clusters.length, 1)
  const plan = planConsolidation(clustered.clusters[0]!, { now: NOW })!
  applyConsolidationPlan(store, plan)

  const retired = store.scope('project:c').retiredIds()
  const active = [...store.scope('project:c').records.values()].filter(
    (record) => !retired.has(record.id) && isActiveNow(record, NOW),
  )
  assert.equal(active.length, 1, '默认可见的只剩合并后的新版本')
  assert.equal(active[0]!.generation, 2)
  assert.ok(active[0]!.consolidatedFrom !== undefined && active[0]!.consolidatedFrom.length === 3)
})

test('CONSOLIDATION_THRESHOLD 默认 0.9（略低于语义合并的 0.92）', () => {
  assert.equal(CONSOLIDATION_THRESHOLD, 0.9)
  assert.equal(splitPoints('第一句，第二句。').length, 1, '逗号不是句子边界')
})
