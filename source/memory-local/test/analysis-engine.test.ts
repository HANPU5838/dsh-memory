/**
 * 智能关系分析引擎（analysis/engine）：公式、阈值、关系/冲突/聚类/演化/2-hop、
 * 增量、去重/上限/确定性、输入容错。全部用构造数据，不读盘、不调 LLM。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CLUSTER_SHARED_ENTITIES,
  CONFLICT_CANDIDATE_SIMILARITY,
  CONFLICT_UPDATE_TIME_GAP_MS,
  MAX_CLUSTERS,
  MAX_CONFLICTS,
  MAX_RELATIONS,
  RELATION_MEDIUM,
  RELATION_MIN_CONFIDENCE,
  RELATION_SIMILARITY_THRESHOLD,
  RELATION_STRONG,
  RELATION_WEIGHT_COSINE,
  RELATION_WEIGHT_ENTITY,
  RELATION_WEIGHT_SOURCE,
  RELATION_WEIGHT_TIME,
  RELATION_WEAK,
  REASONING_FACTOR,
  analyzeMemories,
  cosineSimilarity,
  memoryFingerprint,
  relationConfidence,
  relationStrength,
  timeProximity,
} from '../src/analysis/engine.ts'
import type { AnalysisMemory, AnalyzeInput } from '../src/analysis/types.ts'

const NOW = 1_700_000_000_000
const HOUR = 3_600_000
const DAY = 86_400_000

function memory(id: string, content: string, updatedAt = NOW, extra: Partial<AnalysisMemory> = {}): AnalysisMemory {
  return {
    id,
    scope: 'project:analysis',
    kind: 'note',
    content,
    tags: [],
    createdAt: updatedAt - 1_000,
    updatedAt,
    sourceOrigin: 'user',
    ...extra,
  }
}

/** 与基准向量 [1,0,0,0] 余弦相似度 = cos 的单位向量。 */
function unit(cos: number): Float32Array {
  return new Float32Array([cos, Math.sqrt(Math.max(0, 1 - cos * cos)), 0, 0])
}

function vectors(entries: Array<[string, number]>): Map<string, Float32Array> {
  return new Map(entries.map(([id, cos]) => [id, unit(cos)]))
}

function analyze(input: Omit<AnalyzeInput, 'options'> & { options?: AnalyzeInput['options'] }) {
  return analyzeMemories({ ...input, options: { now: NOW, ...input.options } })
}

// ---------------------------------------------------------------- 公式 / 阈值

test('关系置信度公式：四个分量权重和为 1,极值/部分值可手算', () => {
  assert.equal(RELATION_WEIGHT_COSINE, 0.45)
  assert.equal(RELATION_WEIGHT_ENTITY, 0.25)
  assert.equal(RELATION_WEIGHT_TIME, 0.15)
  assert.equal(RELATION_WEIGHT_SOURCE, 0.15)
  assert.ok(
    Math.abs(RELATION_WEIGHT_COSINE + RELATION_WEIGHT_ENTITY + RELATION_WEIGHT_TIME + RELATION_WEIGHT_SOURCE - 1) < 1e-12,
  )
  assert.equal(relationConfidence({ cosineAvg: 1, entityJaccard: 1, timeProximity: 1, sourceCredibility: 1 }), 1)
  assert.equal(relationConfidence({ cosineAvg: 0, entityJaccard: 0, timeProximity: 0, sourceCredibility: 0 }), 0)
  // 0.45*0.9 + 0.25*1 + 0.15*1 + 0.15*1 = 0.955
  assert.ok(Math.abs(relationConfidence({ cosineAvg: 0.9, entityJaccard: 1, timeProximity: 1, sourceCredibility: 1 }) - 0.955) < 1e-9)
  // 分量会被 clamp 到 0..1（负数/超界不放大结果）
  assert.equal(relationConfidence({ cosineAvg: 2, entityJaccard: 2, timeProximity: 2, sourceCredibility: 2 }), 1)
  assert.equal(relationConfidence({ cosineAvg: -1, entityJaccard: -1, timeProximity: -1, sourceCredibility: -1 }), 0)
})

test('strength 分档：strong≥0.8 / medium≥0.6 / weak≥0.45 / 否则 unverified', () => {
  assert.equal(RELATION_STRONG, 0.8)
  assert.equal(RELATION_MEDIUM, 0.6)
  assert.equal(RELATION_WEAK, 0.45)
  assert.equal(RELATION_MIN_CONFIDENCE, 0.55)
  assert.equal(RELATION_SIMILARITY_THRESHOLD, 0.78)
  assert.equal(relationStrength(0.8), 'strong')
  assert.equal(relationStrength(0.7999), 'medium')
  assert.equal(relationStrength(0.6), 'medium')
  assert.equal(relationStrength(0.5999), 'weak')
  assert.equal(relationStrength(0.45), 'weak')
  assert.equal(relationStrength(0.4499), 'unverified')
})

test('timeProximity：同刻 =1,30 天半衰期 =0.5,对称', () => {
  assert.equal(timeProximity(NOW, NOW), 1)
  assert.ok(Math.abs(timeProximity(NOW, NOW + 30 * DAY) - 0.5) < 1e-12)
  assert.ok(Math.abs(timeProximity(NOW, NOW + 60 * DAY) - 0.25) < 1e-12)
  assert.equal(timeProximity(NOW, NOW + HOUR), timeProximity(NOW + HOUR, NOW))
})

test('memoryFingerprint：sha256(content)|updatedAt,内容或更新时间一变就不同', () => {
  const a = memoryFingerprint('同一段内容', 1000)
  assert.equal(a, memoryFingerprint('同一段内容', 1000))
  assert.match(a, /^[0-9a-f]{64}\|1000$/)
  assert.notEqual(a, memoryFingerprint('同一段内容', 1001))
  assert.notEqual(a, memoryFingerprint('另一段内容', 1000))
})

test('cosineSimilarity：缺向量/零向量返回 null,正常向量在 -1..1', () => {
  assert.equal(cosineSimilarity(undefined, unit(1)), null)
  assert.equal(cosineSimilarity(new Float32Array(0), new Float32Array(0)), null)
  assert.equal(cosineSimilarity(new Float32Array([0, 0]), unit(1)), null)
  assert.ok(Math.abs(cosineSimilarity(unit(1), unit(0.9))! - 0.9) < 1e-6)
  assert.ok(Math.abs(cosineSimilarity(unit(1), unit(-1))! + 1) < 1e-6)
})

// ---------------------------------------------------------------- 关系

test('关系发现：共现实体 Relation 按公式打分、evidence 写清依据', () => {
  const graph = analyze({
    memories: [memory('m1', 'npm 与 node 一起用'), memory('m2', 'npm 和 node 配合')],
    vectors: vectors([['m1', 1], ['m2', 0.9]]),
  })
  const relation = graph.relations.find(
    (item) => item.relationshipType === 'entity' && item.sourceEntityId === 'tool:node' && item.targetEntityId === 'tool:npm',
  )
  assert.notEqual(relation, undefined, '应发现 npm-node 实体关系')
  // cosineAvg 0.9, jaccard 1, time 1, source 1 → 0.955
  assert.ok(Math.abs(relation!.confidenceScore - 0.955) < 1e-9)
  assert.equal(relation!.strength, 'strong')
  assert.equal(relation!.status, 'suggested')
  assert.equal(relation!.inferred, false)
  assert.deepEqual(relation!.sourceMemoryIds, ['m1', 'm2'])
  const kinds = new Set(relation!.evidence.map((item) => item.kind))
  assert.ok(kinds.has('shared-memory'))
  assert.ok(kinds.has('entity-overlap'))
  assert.ok(kinds.has('similarity'))
  assert.ok(kinds.has('temporal'))
  assert.ok(kinds.has('source'))
  // evidence 里的说明必须提到具体依据数字，不能是空话
  assert.ok(relation!.evidence.some((item) => /0\.900|0\.955|2 条记忆/.test(item.text)))
  // 同一份输入重复分析，输出逐字节一致
  const again = analyze({
    memories: [memory('m1', 'npm 与 node 一起用'), memory('m2', 'npm 和 node 配合')],
    vectors: vectors([['m1', 1], ['m2', 0.9]]),
  })
  assert.deepEqual(again, graph)
})

test('关系阈值：只输出 confidence ≥0.55,强度分档正确', () => {
  // 无向量 + 默认来源（0.6）→ 0.25 + 0.15*1 + 0.15*0.6 = 0.49 < 0.55 → 不输出
  const weak = analyze({ memories: [memory('w1', 'npm node', NOW, { sourceOrigin: undefined }), memory('w2', 'npm node', NOW, { sourceOrigin: undefined })] })
  assert.deepEqual(weak.relations, [])

  // 中置信：cosine 0.2，jaccard 1，时间 1，来源 1 → 0.45*0.2 + 0.25 + 0.15 + 0.15 = 0.64
  const medium = analyze({ memories: [memory('m1', 'npm node'), memory('m2', 'npm node')], vectors: vectors([['m1', 1], ['m2', 0.2]]) })
  const relation = medium.relations.find((item) => item.relationshipType === 'entity' && item.sourceEntityId === 'tool:node')
  assert.ok(Math.abs(relation!.confidenceScore - 0.64) < 1e-9)
  assert.equal(relation!.strength, 'medium')

  // 弱关系：cosine 0.02 → 0.559
  const weakEdge = analyze({ memories: [memory('n1', 'npm node'), memory('n2', 'npm node')], vectors: vectors([['n1', 1], ['n2', 0.02]]) })
  const weakRelation = weakEdge.relations.find((item) => item.relationshipType === 'entity' && item.sourceEntityId === 'tool:node')
  assert.ok(Math.abs(weakRelation!.confidenceScore - 0.559) < 1e-9)
  assert.equal(weakRelation!.strength, 'weak')
})

test('跨记忆高相似通道：没有共同实体的两条相似记忆 → semantic 关系', () => {
  const graph = analyze({
    memories: [memory('s1', 'npm 部署流程'), memory('s2', 'pnpm 部署流程')],
    vectors: vectors([['s1', 1], ['s2', 1]]),
  })
  const semantic = graph.relations.filter((item) => item.relationshipType === 'semantic')
  assert.equal(semantic.length, 1)
  const relation = semantic[0]!
  assert.deepEqual([relation.sourceEntityId, relation.targetEntityId], ['tool:npm', 'tool:pnpm'])
  // cosineAvg=1, jaccard=0, time=1, source=1 → 0.75
  assert.ok(Math.abs(relation.confidenceScore - 0.75) < 1e-9)
  assert.ok(relation.evidence.some((item) => item.kind === 'similarity' && item.similarity !== undefined))
  assert.equal(relation.inferred, false)
})

test('关系排序与 pair+type 去重：同 pair 不同类型各保留一条,整体按 confidence 降序', () => {
  const graph = analyze({
    memories: [memory('d1', 'npm node'), memory('d2', 'npm node 配置')],
    vectors: vectors([['d1', 1], ['d2', 0.9]]),
  })
  const keys = graph.relations.map((item) => `${item.relationshipType}|${item.sourceEntityId}|${item.targetEntityId}`)
  assert.equal(new Set(keys).size, keys.length, 'pair+type 不重复')
  const entity = graph.relations.filter((item) => item.relationshipType === 'entity' && item.sourceEntityId === 'tool:node')
  assert.equal(entity.length, 1)
  const semantic = graph.relations.filter((item) => item.relationshipType === 'semantic' && item.sourceEntityId === 'tool:node')
  assert.equal(semantic.length, 1)
  for (let i = 1; i < graph.relations.length; i++) {
    assert.ok(graph.relations[i - 1]!.confidenceScore >= graph.relations[i]!.confidenceScore, '按 confidence 降序')
  }
})

// ---------------------------------------------------------------- 冲突

test('冲突分类 update：关键细节冲突 + 时间差>1h + 数值差异 → update/new', () => {
  const graph = analyze({
    memories: [
      memory('old', '端口 8080 部署在 /srv/app', NOW - 2 * HOUR),
      memory('new', '端口 9090 部署在 /srv/app', NOW),
    ],
    vectors: vectors([['old', 1], ['new', 1]]),
  })
  const conflict = graph.conflicts.find((item) => item.oldMemoryId === 'old' && item.newMemoryId === 'new')
  assert.notEqual(conflict, undefined)
  assert.equal(conflict!.kind, 'update')
  assert.equal(conflict!.status, 'new')
  assert.equal(conflict!.oldMemoryId, 'old')
  assert.equal(conflict!.newMemoryId, 'new')
  assert.ok(conflict!.similarity > 0.9)
  assert.ok(conflict!.contradiction > 0)
  assert.match(conflict!.summary, /更新/)
  assert.match(conflict!.summary, /8080/)
  assert.match(conflict!.summary, /9090/)
  const evidenceKinds = conflict!.evidence.map((item) => item.kind)
  assert.ok(evidenceKinds.includes('content'))
  assert.ok(evidenceKinds.includes('time'))
  assert.ok(evidenceKinds.includes('difference'))
  assert.ok(evidenceKinds.includes('similarity'))
  assert.ok(evidenceKinds.includes('contradiction'))
})

test('冲突分类 contradiction：关键细节冲突但时间差 ≤1h → pending_review', () => {
  const graph = analyze({
    memories: [
      memory('old', '端口 8080 部署在 /opt/app', NOW - 10 * 60_000),
      memory('new', '端口 9090 部署在 /opt/app', NOW),
    ],
    vectors: vectors([['old', 1], ['new', 1]]),
  })
  const conflict = graph.conflicts[0]!
  assert.equal(conflict.kind, 'contradiction')
  assert.equal(conflict.status, 'pending_review')
  assert.match(conflict.summary, /矛盾|人工/)
})

test('冲突分类 context：仅余弦近似、无关键细节冲突 → new', () => {
  const graph = analyze({
    memories: [
      memory('c1', '今天天气不错适合出门散步', NOW - HOUR),
      memory('c2', '今天天气挺好适合出去走走', NOW),
    ],
    vectors: vectors([['c1', 1], ['c2', 0.9]]),
  })
  const conflict = graph.conflicts.find((item) => item.oldMemoryId === 'c1')
  assert.notEqual(conflict, undefined)
  assert.equal(conflict!.kind, 'context')
  assert.equal(conflict!.status, 'new')
  assert.match(conflict!.summary, /语境|相似/)
})

test('冲突跳过：相同文字不冲突,supersedes 谱系上的新旧版本不冲突,不相关记忆不冲突', () => {
  const identical = analyze({ memories: [memory('i1', '同样的一段记忆'), memory('i2', '同样的一段记忆')] })
  assert.deepEqual(identical.conflicts, [])

  const superseded = analyze({
    memories: [
      memory('v1', '端口 8080 的旧说明', NOW - 2 * HOUR),
      memory('v2', '端口 9090 的新说明', NOW, { supersedes: 'v1' }),
    ],
  })
  assert.deepEqual(superseded.conflicts, [])

  // 完全不相干（不共享实体、相似度为 0）→ 不产生冲突
  const unrelated = analyze({
    memories: [memory('u1', 'redis 缓存策略'), memory('u2', 'docker 镜像构建')],
    vectors: new Map([
      ['u1', new Float32Array([1, 0, 0, 0])],
      ['u2', new Float32Array([0, 1, 0, 0])],
    ]),
  })
  assert.deepEqual(unrelated.conflicts, [])
})

// ---------------------------------------------------------------- 聚类

test('聚类：共享 ≥2 实体并查集合并,topic 取前 3 个非 tag 实体', () => {
  const graph = analyze({
    memories: [memory('a1', 'npm node'), memory('a2', 'npm 与 node 配置'), memory('a3', 'redis mysql')],
  })
  assert.equal(CLUSTER_SHARED_ENTITIES, 2)
  const cluster = graph.clusters.find((item) => item.memoryIds.length === 2)
  assert.deepEqual(cluster!.memoryIds, ['a1', 'a2'])
  assert.equal(cluster!.count, 2)
  assert.ok(cluster!.topic.includes('Node.js') && cluster!.topic.includes('npm'))
  assert.equal(cluster!.topEntities[0]!.id, 'tool:node')
  assert.ok(cluster!.topEntities.every((item) => item.count >= 1))
  // 单条记忆也是独立聚类
  const singleton = graph.clusters.find((item) => item.memoryIds.length === 1)
  assert.deepEqual(singleton!.memoryIds, ['a3'])
  assert.equal(singleton!.topic, 'mysql · redis')
})

test('相关聚类：按共享实体数排序,relatedClusterIds 双向且不引用已截断的聚类', () => {
  const graph = analyze({
    memories: [
      memory('a1', 'npm node'),
      memory('a2', 'npm 与 node'),
      memory('b1', 'npm git'),
      memory('b2', 'npm 与 git'),
    ],
  })
  const clusterA = graph.clusters.find((item) => item.memoryIds.includes('a1'))!
  const clusterB = graph.clusters.find((item) => item.memoryIds.includes('b1'))!
  assert.notEqual(clusterA.id, clusterB.id)
  assert.deepEqual(clusterA.relatedClusterIds, [clusterB.id])
  assert.deepEqual(clusterB.relatedClusterIds, [clusterA.id])
})

// ---------------------------------------------------------------- 演化

test('演化：实体出现 ≥2 条记忆 → created/updated/superseded/invalidated/decision 时间线', () => {
  const graph = analyze({
    memories: [
      memory('e1', 'npm 部署流程', NOW - 5_000, { supersedes: 'e0', validUntil: NOW - 1_000 }),
      memory('e2', 'npm 决策改用 pnpm', NOW - 1_000, { kind: 'decision' }),
    ],
  })
  const track = graph.evolution.find((item) => item.entityId === 'tool:npm')
  assert.notEqual(track, undefined)
  assert.deepEqual(track!.memoryIds, ['e1', 'e2'])
  assert.equal(track!.count, 2)
  assert.equal(track!.firstAt, NOW - 6_000) // e1.createdAt = updatedAt - 1000
  const types = new Set(track!.events.map((event) => event.type))
  for (const type of ['created', 'updated', 'superseded', 'invalidated', 'decision']) {
    assert.ok(types.has(type as never), `缺少 ${type} 事件`)
  }
  assert.ok(track!.events.every((event) => track!.memoryIds.includes(event.memoryId)), '事件保留原始记忆 id')
  assert.ok(track!.events[0]!.at <= track!.events[track!.events.length - 1]!.at, '事件按时间升序')
  // 只出现一次的记忆不产生演化轨道
  assert.equal(graph.evolution.some((item) => item.entityId === 'tool:pnpm'), false)
})

// ---------------------------------------------------------------- 2-hop 推理

test('2-hop 推理：A-B-C 且 A-C 无直连 → inferred 路径,confidence=乘积×0.8', () => {
  const graph = analyze({
    memories: [
      memory('m1', 'npm node', NOW - 4_000),
      memory('m2', 'npm 与 node 配置', NOW - 3_000),
      memory('m3', 'node git', NOW - 2_000),
      memory('m4', 'node 与 git 工具', NOW - 1_000),
    ],
    vectors: vectors([['m1', 1], ['m2', 1], ['m3', 1], ['m4', 1]]),
  })
  assert.equal(REASONING_FACTOR, 0.8)
  const path = graph.paths[0]!
  assert.notEqual(path, undefined)
  assert.equal(path.inferred, true)
  assert.deepEqual(path.labels, ['git', 'Node.js', 'npm'])
  assert.deepEqual(path.path, ['tool:git', 'tool:node', 'tool:npm'])
  const entityRelations = new Map(
    graph.relations
      .filter((relation) => relation.relationshipType === 'entity')
      .map((relation) => [`${relation.sourceEntityId}|${relation.targetEntityId}`, relation.confidenceScore]),
  )
  const left = entityRelations.get('tool:git|tool:node')!
  const right = entityRelations.get('tool:node|tool:npm')!
  assert.ok(Math.abs(path.confidence - left * right * REASONING_FACTOR) < 1e-4)
  assert.ok(path.confidence >= 0.2)
  assert.ok(path.evidence.some((item) => item.kind === 'reasoning-path' && item.path?.length === 3))
  // A-C 没有直接实体关系，所以才是"推理"而不是已有关系
  assert.equal(entityRelations.has('tool:git|tool:npm'), false)
})

// ---------------------------------------------------------------- 增量

test('增量：只重算涉及变化记忆的候选,未波及的既有 suggested 原样保留', () => {
  const full = analyze({
    memories: [
      memory('m1', 'npm node', NOW),
      memory('m2', 'npm node', NOW - 1_000),
      memory('m3', 'git docker', NOW - 2_000),
    ],
  })
  assert.equal(full.relations.length, 2, 'npm-node 与 git-docker 两条关系')
  assert.equal(full.fingerprints['m1'], memoryFingerprint('npm node', NOW))

  const incremental = analyze({
    memories: [
      memory('m1', 'npm node', NOW),
      memory('m2', 'npm node 更新过', NOW),
      memory('m3', 'git docker', NOW - 2_000),
    ],
    previousFingerprints: { ...full.fingerprints, ghost: 'sha256|0' },
    existingRelations: full.relations,
    options: { mode: 'incremental' },
  })
  assert.equal(incremental.stats.mode, 'incremental')
  assert.equal(incremental.stats.memories, 3)
  assert.equal(incremental.stats.changed, 1)
  assert.equal(incremental.stats.analyzed, 1)
  assert.equal(incremental.stats.removed, 1, 'ghost 记忆被移除')
  // 重算的只有 npm-node（m2 涉及的候选）
  assert.deepEqual(
    incremental.relations.map((item) => [item.sourceEntityId, item.targetEntityId]),
    [['tool:node', 'tool:npm']],
  )
  // 没被波及的 git-docker 原样交还调用方合并
  assert.deepEqual(
    incremental.preservedRelations.map((item) => [item.sourceEntityId, item.targetEntityId]),
    [['tool:docker', 'tool:git']],
  )
  assert.equal(incremental.fingerprints['m2'], memoryFingerprint('npm node 更新过', NOW))
})

test('full 模式不保留旧条目（输出就是全量快照）', () => {
  const full = analyze({ memories: [memory('m1', 'npm node'), memory('m2', 'npm node')] })
  assert.deepEqual(full.preservedRelations, [])
  assert.deepEqual(full.preservedConflicts, [])
  assert.equal(full.relations.length, 1)
})

// ---------------------------------------------------------------- 上限 / 确定性 / 容错

test('上限：relations≤500 / conflicts≤200 / clusters≤100,截断按确定性排序', () => {
  assert.equal(MAX_RELATIONS, 500)
  assert.equal(MAX_CONFLICTS, 200)
  assert.equal(MAX_CLUSTERS, 100)

  // 600 条记忆各带一对唯一 tag → 600 个实体对，被 relations 上限截到 500
  const tagMemories: AnalysisMemory[] = []
  for (let i = 0; i < 600; i++) {
    tagMemories.push(memory(`cap${String(i).padStart(4, '0')}`, '占位', NOW, { tags: [`tagA${i}`, `tagB${i}`] }))
  }
  const capped = analyze({ memories: tagMemories })
  assert.equal(capped.relations.length, MAX_RELATIONS)
  assert.equal(capped.clusters.length, MAX_CLUSTERS, '600 个单记忆聚类被截到 100')

  // 210 对互不相关的 update 冲突 → 截到 200
  const conflictMemories: AnalysisMemory[] = []
  for (let i = 0; i < 210; i++) {
    conflictMemories.push(memory(`c${i}a`, `端口 ${8000 + i} 部署在 /srv/app${i}`, NOW - 2 * HOUR))
    conflictMemories.push(memory(`c${i}b`, `端口 ${9000 + i} 部署在 /srv/app${i}`, NOW))
  }
  const conflicts = analyze({ memories: conflictMemories })
  assert.equal(conflicts.conflicts.length, MAX_CONFLICTS)
  assert.ok(conflicts.conflicts.every((item) => item.kind === 'update'))
})

test('maxPairs 限制候选对数量（不会全库两两爆炸）', () => {
  const memories: AnalysisMemory[] = []
  for (let i = 0; i < 20; i++) {
    memories.push(memory(`p${String(i).padStart(2, '0')}`, '占位', NOW, { tags: [`x${i}`, `y${i}`, `z${i}`] }))
  }
  const graph = analyze({ memories, options: { maxPairs: 20 } })
  assert.ok(graph.stats.entityPairs <= 20)
  assert.ok(graph.relations.length <= 20)
})

test('确定性：打乱输入顺序输出完全一致,id 可复现', () => {
  const memories = [
    memory('z1', 'npm node', NOW - 2_000),
    memory('z2', 'npm 与 node', NOW - 1_000),
    memory('z3', 'node git', NOW),
  ]
  const first = analyze({ memories })
  const second = analyze({ memories: [memories[2]!, memories[0]!, memories[1]!] })
  assert.deepEqual(second, first)
  const ids = first.relations.map((item) => item.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.ok(ids.every((id) => id.startsWith('rel_')))
})

test('输入容错：空输入 / 坏记录 / 软删 / 过期 / 时间窗', () => {
  const empty = analyze({ memories: [] })
  assert.deepEqual(empty.relations, [])
  assert.deepEqual(empty.conflicts, [])
  assert.deepEqual(empty.paths, [])
  assert.deepEqual(empty.fingerprints, {})
  assert.equal(empty.stats.memories, 0)

  const dirty = analyze({
    memories: [
      null as unknown as AnalysisMemory,
      { id: 'no-content' } as unknown as AnalysisMemory,
      { id: 'bad', content: 123 } as unknown as AnalysisMemory,
      memory('ok1', 'npm node'),
      memory('ok2', 'npm node'),
      memory('dup', 'npm node'),
      memory('dup', 'npm node'),
      memory('tomb', 'npm node', NOW, { tombstonedAt: NOW }),
      memory('expired', 'npm node', NOW, { expiredAt: NOW - 1 }),
      memory('early', 'npm node', NOW - 10 * DAY),
    ],
    options: { since: NOW - 5 * DAY },
  })
  assert.deepEqual(Object.keys(dirty.fingerprints).sort(), ['dup', 'ok1', 'ok2'])
  assert.equal(dirty.stats.memories, 3)

  const windowed = analyze({
    memories: [memory('w1', 'npm node', NOW - 10 * DAY), memory('w2', 'npm node', NOW)],
    options: { since: NOW - DAY },
  })
  assert.deepEqual(Object.keys(windowed.fingerprints), ['w2'])
})

test('entityTypes 过滤：只分析指定实体类型', () => {
  const memories = [memory('t1', 'npm node', NOW, { tags: ['共用标签'] }), memory('t2', 'npm node', NOW, { tags: ['共用标签'] })]
  const toolsOnly = analyze({ memories, options: { entityTypes: ['tool'] } })
  assert.deepEqual(
    toolsOnly.relations.map((item) => `${item.sourceEntityId}|${item.targetEntityId}`),
    ['tool:node|tool:npm'],
  )
  const tagsOnly = analyze({ memories, options: { entityTypes: ['tag'] } })
  assert.equal(tagsOnly.stats.entities, 1)
  assert.deepEqual(tagsOnly.relations, [], '每条记忆只有一个 tag 实体，凑不成实体对')
  assert.equal(tagsOnly.fingerprints['t1'], memoryFingerprint('npm node', NOW))
})
