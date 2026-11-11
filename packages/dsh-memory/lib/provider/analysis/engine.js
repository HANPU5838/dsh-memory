/**
 * 智能关系分析引擎（analysis/engine）—— 纯函数、零外部依赖、不调 LLM。
 *
 * 输入是"记忆快照 + 向量"，输出是五类结构，全部可解释、可复现：
 *   1) 关系 relations       实体 × 实体的关联（同记忆共现 + 跨记忆高相似两个通道）
 *   2) 冲突 conflicts       记忆 × 记忆的矛盾/更新/语境提示
 *   3) 聚类 clusters        按"语义相似或共享 ≥2 实体"并查集聚出来的主题
 *   4) 演化 evolution       每个实体的时间线（created/updated/superseded/invalidated/decision）
 *   5) 推理 paths           实体图 2-hop（A-B-C 且 A-C 无直连）的推断关系
 *
 * 关系置信度公式（任务契约，权重和 = 1）：
 *   confidence = 0.45*cosineAvg + 0.25*entityJaccard + 0.15*timeProximity + 0.15*sourceCredibility
 *   - cosineAvg        两个实体的"上下文记忆"两两余弦的平均（各取最近 3 条，最多 9 对）
 *   - entityJaccard    两个实体的记忆集合 Jaccard（交集 / 并集）
 *   - timeProximity    两侧最近提及时间差的指数衰减（半衰期 30 天，同刻 = 1）
 *   - sourceCredibility 两侧最近记忆的来源可信度均值（user/explicit 1.0 > tool 0.9 > agent 0.7 > auto 0.5）
 *   strength：strong ≥0.8 / medium ≥0.6 / weak ≥0.45；**只输出 confidence ≥0.55 的关系**。
 *
 * 确定性与规模：
 *   - 所有 id 用 sha1 派生，输入相同 → 输出逐字节相同；所有数组显式排序；
 *   - 候选记忆对在库小时全量两两算（≤ maxPairs），大库退化为"实体倒排分桶"（共享实体才比较）；
 *   - 增量模式只对"涉及变化记忆"的候选对重算，未波及的既有 suggested 条目原样返回给调用方合并；
 *   - 关系/冲突/聚类/路径分别硬上限 500/200/100/100。
 *
 * 本模块不做任何 I/O；持久化见 analysis/store.ts。
 */
import { createHash } from 'node:crypto'
import { entityNodeId, extractEntities,             } from '../cognitive/graph.js'
import { hasCriticalDetailConflict } from '../cognitive/conflict.js'
import { assessContradiction } from '../cognitive/contradiction.js'
             
                 
               
                 
                
               
                 
                
                   
               
                 
                 
                 
                 
                   
                
                   
                 
                   
               
                   

// ---------------------------------------------------------------- 公式与阈值（对外公开）

/** 关系置信度各分量权重。 */
export const RELATION_WEIGHT_COSINE = 0.45
export const RELATION_WEIGHT_ENTITY = 0.25
export const RELATION_WEIGHT_TIME = 0.15
export const RELATION_WEIGHT_SOURCE = 0.15

/** 跨记忆高相似 → semantic 关系候选的余弦阈值。 */
export const RELATION_SIMILARITY_THRESHOLD = 0.78
/** 关系的最小输出置信度。 */
export const RELATION_MIN_CONFIDENCE = 0.55
/** strength 分档阈值。 */
export const RELATION_STRONG = 0.8
export const RELATION_MEDIUM = 0.6
export const RELATION_WEAK = 0.45

/** 冲突候选：共享实体或余弦 ≥ 该阈值。 */
export const CONFLICT_CANDIDATE_SIMILARITY = 0.65
/** 无细节冲突时，仅"余弦近似"才算 context 冲突的下限（与 conflict.ts 冲突区下界一致）。 */
export const CONFLICT_CONTEXT_SIMILARITY = 0.75
/** update 分类要求的新旧时间差（1 小时）。 */
export const CONFLICT_UPDATE_TIME_GAP_MS = 3_600_000

/** 聚类的相似度边阈值。 */
export const CLUSTER_SIMILARITY = 0.72
/** 聚类的共享实体边阈值。 */
export const CLUSTER_SHARED_ENTITIES = 2

/** 2-hop 路径置信度系数（路径乘积 × 0.8）。 */
export const REASONING_FACTOR = 0.8
/** 路径最小输出置信度（乘积衰减后太低的直接丢）。 */
export const REASONING_MIN_CONFIDENCE = 0.2
/** 推理时每个实体最多取多少个邻居（防 hub 实体路径爆炸）。 */
export const MAX_PATH_NEIGHBORS = 10

/** 输出硬上限。 */
export const MAX_RELATIONS = 500
export const MAX_CONFLICTS = 200
export const MAX_CLUSTERS = 100
export const MAX_PATHS = 100
export const MAX_EVOLUTION_TRACKS = 200

/** 候选对默认上限。 */
export const DEFAULT_MAX_PAIRS = 5000
/** 时间接近度的半衰期（天）。 */
export const TIME_HALF_LIFE_DAYS = 30
/** 上下文余弦平均时每侧取最近几条记忆。 */
export const CONTEXT_MEMORY_LIMIT = 3

const DAY_MS = 86_400_000

/** 来源可信度：用户显式写入最可信，自动采集最容易被模型臆测污染。 */
export const SOURCE_CREDIBILITY                                   = {
  user: 1,
  explicit: 1,
  manual: 1,
  tool: 0.9,
  agent: 0.7,
  auto: 0.5,
}

const KIND_LABELS                                   = {
  note: '笔记',
  fact: '事实',
  rule: '规则',
  state: '状态',
  decision: '决策',
  preference: '偏好',
  procedure: '流程',
  project: '项目',
  session: '会话',
}

// ---------------------------------------------------------------- 基础工具

/** 确定性字符串比较（不依赖 locale）。 */
export function cmpStr(a        , b        )         {
  return a < b ? -1 : a > b ? 1 : 0
}

function clamp01(value        )         {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** 置信度统一四舍五入到 4 位，避免浮点噪声进 JSONL / 测试。 */
function round4(value        )         {
  return Math.round(clamp01(value) * 10_000) / 10_000
}

function sha1Hex(text        )         {
  return createHash('sha1').update(text).digest('hex')
}

function hashId(prefix        , payload        )         {
  return `${prefix}${sha1Hex(payload).slice(0, 16)}`
}

/** 记忆指纹：`sha256(content)|updatedAt`（增量分析的依据）。 */
export function memoryFingerprint(content        , updatedAt        )         {
  return `${createHash('sha256').update(content).digest('hex')}|${Math.floor(updatedAt)}`
}

/** 余弦相似度；任一向量缺失/零向量返回 null（= 没有语义依据，走词面兜底）。 */
export function cosineSimilarity(a                               , b                               )                {
  if (a === undefined || b === undefined) return null
  const n = Math.min(a.length, b.length)
  if (n === 0) return null
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    const x = a[i] 
    const y = b[i] 
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return null
  return Math.min(1, Math.max(-1, dot / (Math.sqrt(na) * Math.sqrt(nb))))
}

/** 来源可信度（未知来源给中性 0.6）。 */
export function memorySourceCredibility(origin                    )         {
  if (origin === undefined) return 0.6
  return SOURCE_CREDIBILITY[origin] ?? 0.6
}

/** 时间接近度：|Δt| 按 30 天半衰期指数衰减；同一时刻 = 1。 */
export function timeProximity(a        , b        )         {
  const delta = Math.abs(a - b)
  return Math.pow(0.5, delta / DAY_MS / TIME_HALF_LIFE_DAYS)
}

/** 关系置信度（权重和 = 1；各分量先 clamp 到 0..1）。 */
export function relationConfidence(parts   
                   
                       
                       
                           
 )         {
  return clamp01(
    RELATION_WEIGHT_COSINE * clamp01(parts.cosineAvg) +
      RELATION_WEIGHT_ENTITY * clamp01(parts.entityJaccard) +
      RELATION_WEIGHT_TIME * clamp01(parts.timeProximity) +
      RELATION_WEIGHT_SOURCE * clamp01(parts.sourceCredibility),
  )
}

/** 置信度 → strength 分档。 */
export function relationStrength(confidence        )                   {
  const value = clamp01(confidence)
  if (value >= RELATION_STRONG) return 'strong'
  if (value >= RELATION_MEDIUM) return 'medium'
  if (value >= RELATION_WEAK) return 'weak'
  return 'unverified'
}

// ---------------------------------------------------------------- 文本格式化

function snippet(content        , max = 40)         {
  const text = content.replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function formatScore(value        )         {
  return value.toFixed(3)
}

function formatDuration(ms        )         {
  const delta = Math.abs(ms)
  if (delta < 60_000) return `${Math.max(0, Math.round(delta / 1000))} 秒`
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)} 分钟`
  if (delta < DAY_MS) return `${(delta / 3_600_000).toFixed(1)} 小时`
  return `${(delta / DAY_MS).toFixed(1)} 天`
}

function formatTime(at        )         {
  if (!Number.isFinite(at) || at <= 0) return '未知时间'
  return new Date(at).toISOString().replace('T', ' ').slice(0, 16)
}

function jaccard(left                     , right                     )         {
  if (left.size === 0 || right.size === 0) return 0
  let inter = 0
  for (const item of left) if (right.has(item)) inter++
  const union = left.size + right.size - inter
  return union === 0 ? 0 : clamp01(inter / union)
}

/** 归一化内容（与 store.contentHash 同口径）：判断"完全同样的文字"。 */
function normalizeContent(content        )         {
  return content.replace(/\s+/g, ' ').trim().toLowerCase()
}

// ---------------------------------------------------------------- 内部数据结构

                      
            
               
              
                                                  
                
 

                             
                              
             
                   
               
                              
                            
 

                             
             
                    
           
           
                    
                              
                        
 

                     
                          
                                   
 

function createUnionFind(ids                   )            {
  const parent = new Map                ()
  for (const id of ids) parent.set(id, id)
  const find = (id        )         => {
    let root = id
    while (parent.get(root) !== root) {
      const next = parent.get(root) 
      // 路径压缩
      parent.set(root, parent.get(next) ?? next)
      root = next
    }
    return root
  }
  return {
    find,
    union(a        , b        )       {
      const ra = find(a)
      const rb = find(b)
      if (ra === rb) return
      // 小 id 当根，保证结果与输入顺序无关
      if (cmpStr(ra, rb) <= 0) parent.set(rb, ra)
      else parent.set(ra, rb)
    },
  }
}

                                 
             
                        
 

// ---------------------------------------------------------------- 主入口

/**
 * 分析一批记忆，返回关系/冲突/聚类/演化/推理路径。
 *
 * 纯函数：同样的 `input`（含 `options.now`）→ 完全相同的输出；不读盘、不写盘、不联网。
 */
export function analyzeMemories(input              )                 {
  const options                 = {
    mode: input.options?.mode ?? 'full',
    ...(input.options?.entityTypes !== undefined ? { entityTypes: input.options.entityTypes } : {}),
    ...(input.options?.since !== undefined ? { since: input.options.since } : {}),
    ...(input.options?.until !== undefined ? { until: input.options.until } : {}),
    ...(input.options?.maxPairs !== undefined ? { maxPairs: input.options.maxPairs } : {}),
    ...(input.options?.now !== undefined ? { now: input.options.now } : {}),
    ...(input.options?.analysisVersion !== undefined ? { analysisVersion: input.options.analysisVersion } : {}),
  }
  const now = Number.isFinite(options.now          ) ? (options.now          ) : Date.now()
  const mode               = options.mode === 'incremental' ? 'incremental' : 'full'
  const analysisVersion = options.analysisVersion ?? '1'
  const maxPairs = Math.max(1, Math.min(100_000, Math.floor(options.maxPairs ?? DEFAULT_MAX_PAIRS)))
  const entityTypeFilter = Array.isArray(options.entityTypes) && options.entityTypes.length > 0
    ? new Set(options.entityTypes.map(String))
    : undefined

  // 1) 记忆过滤与排序（软删 / TTL 过期 / 时间窗）
  const memories = prepareMemories(input.memories ?? [], options, now)
  const byId = new Map                        ()
  for (const memory of memories) byId.set(memory.id, memory)

  // 2) 实体抽取（复用 graph.ts 的规则式抽取；tag 来自记录 tags）
  const entitiesByMemory = new Map                      ()
  const entityIdsByMemory = new Map                     ()
  const memoryIdsByEntity = new Map                  ()
  const labelByEntity = new Map                ()
  for (const memory of memories) {
    const extracted           = extractEntities(memory.content, { tags: memory.tags })
      .filter((entity) => entityTypeFilter === undefined || entityTypeFilter.has(entity.type))
    const infos               = []
    const ids = new Set        ()
    for (const entity of extracted) {
      const id = entityNodeId(entity.type, entity.normalized)
      if (ids.has(id)) continue
      ids.add(id)
      infos.push({ id, label: entity.label, type: entity.type, weight: entity.weight })
      if (!labelByEntity.has(id)) labelByEntity.set(id, entity.label)
      const list = memoryIdsByEntity.get(id)
      if (list === undefined) memoryIdsByEntity.set(id, [memory.id])
      else if (!list.includes(memory.id)) list.push(memory.id)
    }
    entitiesByMemory.set(memory.id, infos)
    entityIdsByMemory.set(memory.id, ids)
  }
  for (const list of memoryIdsByEntity.values()) list.sort(cmpStr)

  // 3) 指纹 / 变化检测
  const fingerprints                         = {}
  for (const memory of memories) fingerprints[memory.id] = memoryFingerprint(memory.content, memory.updatedAt)
  const previousFingerprints = input.previousFingerprints ?? {}
  const changed = new Set        ()
  if (mode === 'incremental') {
    for (const memory of memories) {
      if (previousFingerprints[memory.id] !== fingerprints[memory.id]) changed.add(memory.id)
    }
  } else {
    for (const memory of memories) changed.add(memory.id)
  }
  const removed = Object.keys(previousFingerprints).filter((id) => !byId.has(id)).length

  // 4) 相似度（懒计算 + 缓存；无向量返回 null）
  const vectors = input.vectors
  const similarityCache = new Map                       ()
  const similarity = (a        , b        )                => {
    if (a === b) return 1
    const [x, y] = cmpStr(a, b) <= 0 ? [a, b] : [b, a]
    const key = `${x}\u0000${y}`
    if (similarityCache.has(key)) return similarityCache.get(key) ?? null
    const value = vectors === undefined ? null : cosineSimilarity(vectors.get(a), vectors.get(b))
    similarityCache.set(key, value)
    return value
  }

  // 5) 候选记忆对
  const memoryPairs = collectMemoryPairs(memories, entitiesByMemory, changed, mode, maxPairs)

  // 6) 关系：实体共现通道 + 跨记忆语义通道
  const relationCandidates = new Map                           ()
  collectEntityRelations(relationCandidates, memories, entitiesByMemory, memoryIdsByEntity, labelByEntity, byId, similarity, changed, mode, maxPairs)
  collectSemanticRelations(relationCandidates, memoryPairs, entitiesByMemory, entityIdsByMemory, byId, similarity)
  const relations = finalizeRelations(relationCandidates, analysisVersion, now)

  // 7) 冲突
  const conflicts = detectConflicts(memoryPairs, byId, entityIdsByMemory, similarity, now)

  // 8) 聚类
  const clusters = buildClusters(memories, memoryPairs, entitiesByMemory, entityIdsByMemory, labelByEntity, byId, similarity)

  // 9) 演化
  const evolution = buildEvolution(entitiesByMemory, memoryIdsByEntity, labelByEntity, byId, now)

  // 10) 2-hop 推理
  const paths = buildReasoningPaths(relations, labelByEntity, memoryIdsByEntity, now, analysisVersion)

  // 11) 增量保留（未波及的既有条目交还调用方合并）
  const recomputedRelationKeys = new Set(relations.map((relation) => relationKey(relation.relationshipType, relation.sourceEntityId, relation.targetEntityId)))
  const recomputedConflictKeys = new Set(conflicts.map((conflict) => pairKey(conflict.oldMemoryId, conflict.newMemoryId)))
  const preservedRelations                   = []
  const preservedConflicts                   = []
  if (mode === 'incremental') {
    for (const existing of input.existingRelations ?? []) {
      if (existing.status !== 'suggested') continue
      if (recomputedRelationKeys.has(relationKey(existing.relationshipType, existing.sourceEntityId, existing.targetEntityId))) continue
      const touched = existing.sourceMemoryIds.some((id) => changed.has(id) || !byId.has(id))
      if (touched) continue
      preservedRelations.push({
        ...existing,
        evidence: existing.evidence.map((evidence) => ({ ...evidence, memoryIds: [...evidence.memoryIds] })),
        sourceMemoryIds: [...existing.sourceMemoryIds],
      })
    }
    for (const existing of input.existingConflicts ?? []) {
      if (existing.status !== 'new' && existing.status !== 'pending_review') continue
      if (recomputedConflictKeys.has(pairKey(existing.oldMemoryId, existing.newMemoryId))) continue
      if (!byId.has(existing.oldMemoryId) || !byId.has(existing.newMemoryId)) continue
      if (changed.has(existing.oldMemoryId) || changed.has(existing.newMemoryId)) continue
      preservedConflicts.push({
        ...existing,
        evidence: existing.evidence.map((evidence) => ({ ...evidence })),
      })
    }
    preservedRelations.sort((a, b) => cmpStr(a.id, b.id))
    preservedConflicts.sort((a, b) => cmpStr(a.id, b.id))
  }

  const stats                = {
    mode,
    memories: memories.length,
    analyzed: mode === 'incremental' ? changed.size : memories.length,
    changed: changed.size,
    removed,
    entities: memoryIdsByEntity.size,
    entityPairs: relationCandidates.size,
    memoryPairs: memoryPairs.length,
    relations: relations.length,
    conflicts: conflicts.length,
    clusters: clusters.length,
    paths: paths.length,
    evolution: evolution.length,
    preservedRelations: preservedRelations.length,
    preservedConflicts: preservedConflicts.length,
  }

  return { relations, conflicts, clusters, evolution, paths, fingerprints, preservedRelations, preservedConflicts, stats }
}

// ---------------------------------------------------------------- 记忆过滤

function prepareMemories(
  input                           ,
  options                ,
  now        ,
)                   {
  const since = options.since
  const until = options.until
  const seen = new Set        ()
  const out                   = []
  for (const raw of input) {
    if (raw === null || typeof raw !== 'object') continue
    if (typeof raw.id !== 'string' || raw.id === '' || typeof raw.content !== 'string') continue
    if (seen.has(raw.id)) continue
    seen.add(raw.id)
    const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : 0
    const memory                 = {
      id: raw.id,
      scope: typeof raw.scope === 'string' ? raw.scope : '',
      kind: typeof raw.kind === 'string' && raw.kind !== '' ? raw.kind : 'note',
      content: raw.content,
      tags: Array.isArray(raw.tags) ? raw.tags.filter((tag)                => typeof tag === 'string') : [],
      createdAt,
      updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt,
      ...(Number.isFinite(raw.importance) ? { importance: raw.importance } : {}),
      ...(typeof raw.sourceOrigin === 'string' ? { sourceOrigin: raw.sourceOrigin } : {}),
      ...(typeof raw.supersedes === 'string' ? { supersedes: raw.supersedes } : {}),
      ...(Number.isFinite(raw.validUntil) ? { validUntil: raw.validUntil } : {}),
      ...(Number.isFinite(raw.expiredAt) ? { expiredAt: raw.expiredAt } : {}),
      ...(raw.tombstonedAt !== undefined ? { tombstonedAt: raw.tombstonedAt } : {}),
    }
    // 软删 / TTL 过期的记忆不参与分析（历史由记忆库自身保留）。
    if (memory.tombstonedAt !== undefined) continue
    if (memory.expiredAt !== undefined && memory.expiredAt < now) continue
    if (since !== undefined && memory.updatedAt < since) continue
    if (until !== undefined && memory.updatedAt > until) continue
    out.push(memory)
  }
  out.sort((a, b) => cmpStr(a.id, b.id))
  return out
}

// ---------------------------------------------------------------- 候选对

/**
 * 候选记忆对：full 模式库小时全量两两；库大时退化为实体倒排分桶（共享实体才比较）；
 * incremental 模式只取"变化记忆 × 全部记忆"。结果按 (a,b) 字典序稳定，数量受 maxPairs 限制。
 */
function collectMemoryPairs(
  memories                           ,
  entitiesByMemory                                            ,
  changed                     ,
  mode              ,
  maxPairs        ,
)                          {
  const pairs                          = []
  const seen = new Set        ()
  const ids = memories.map((memory) => memory.id)
  const add = (a        , b        )          => {
    if (a === b) return false
    if (pairs.length >= maxPairs) return true
    const [x, y] = cmpStr(a, b) <= 0 ? [a, b] : [b, a]
    const key = `${x}\u0000${y}`
    if (seen.has(key)) return false
    seen.add(key)
    pairs.push([x, y])
    return pairs.length >= maxPairs
  }
  if (mode === 'incremental') {
    for (const a of ids) {
      if (!changed.has(a)) continue
      for (const b of ids) {
        if (add(a, b)) return pairs
      }
    }
    return pairs
  }
  const totalPairs = (ids.length * (ids.length - 1)) / 2
  if (totalPairs <= maxPairs) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        if (add(ids[i] , ids[j] )) return pairs
      }
    }
    return pairs
  }
  // 大库：实体倒排分桶，只比较共享过实体的记忆（语义强关联的记忆通常会共享实体）
  const buckets = new Map                  ()
  for (const memory of memories) {
    for (const entity of entitiesByMemory.get(memory.id) ?? []) {
      const list = buckets.get(entity.id)
      if (list === undefined) buckets.set(entity.id, [memory.id])
      else if (list[list.length - 1] !== memory.id) list.push(memory.id)
    }
  }
  for (const entityId of [...buckets.keys()].sort(cmpStr)) {
    const bucket = buckets.get(entityId) 
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        if (add(bucket[i] , bucket[j] )) return pairs
      }
    }
  }
  return pairs
}

// ---------------------------------------------------------------- 关系：实体共现通道

                        
           
           
                        
 

function collectCooccurrences(
  memories                           ,
  entitiesByMemory                                            ,
  changed                     ,
  mode              ,
  budget        ,
)                 {
  const pairs = new Map                      ()
  for (const memory of memories) {
    // 增量模式下只有变化记忆会"产生新候选对"；已有对的重算由 existingRelations 保留逻辑兜住
    if (mode === 'incremental' && !changed.has(memory.id)) continue
    const ids = [...new Set((entitiesByMemory.get(memory.id) ?? []).map((entity) => entity.id))].sort(cmpStr)
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const [a, b] = cmpStr(ids[i] , ids[j] ) <= 0 ? [ids[i] , ids[j] ] : [ids[j] , ids[i] ]
        const key = `${a}\u0000${b}`
        let entry = pairs.get(key)
        if (entry === undefined) {
          if (pairs.size >= budget) continue
          entry = { a, b, memoryIds: new Set        () }
          pairs.set(key, entry)
        }
        entry.memoryIds.add(memory.id)
      }
    }
  }
  return [...pairs.values()]
}

/** 某实体最近被提及的记忆（updatedAt 降序、id 升序），最多 limit 条。 */
function latestMemories(ids                   , byId                                     , limit = CONTEXT_MEMORY_LIMIT)                   {
  const list                   = []
  for (const id of ids) {
    const memory = byId.get(id)
    if (memory !== undefined) list.push(memory)
  }
  list.sort((a, b) => b.updatedAt - a.updatedAt || cmpStr(a.id, b.id))
  return list.slice(0, limit)
}

/** 两个实体"上下文记忆"两两余弦的平均（各取最近 3 条，最多 9 对）。 */
function contextCosineAverage(
  leftIds                   ,
  rightIds                   ,
  byId                                     ,
  similarity                                         ,
)                    {
  const left = latestMemories(leftIds, byId)
  const right = latestMemories(rightIds, byId)
  let sum = 0
  let count = 0
  let best                                                       
  for (const a of left) {
    for (const b of right) {
      if (a.id === b.id) continue
      const value = similarity(a.id, b.id)
      if (value === null) continue
      sum += value
      count++
      if (best === undefined || value > best.value) best = { value, pair: [a.id, b.id] }
    }
  }
  return { avg: count === 0 ? 0 : clamp01(sum / count), count, ...(best !== undefined ? { example: best.pair } : {}) }
}

function collectEntityRelations(
  candidates                                ,
  memories                           ,
  entitiesByMemory                                            ,
  memoryIdsByEntity                                        ,
  labelByEntity                             ,
  byId                                     ,
  similarity                                         ,
  changed                     ,
  mode              ,
  maxPairs        ,
)       {
  const cooccurrences = collectCooccurrences(memories, entitiesByMemory, changed, mode, maxPairs)
  for (const cooccurrence of cooccurrences) {
    const leftIds = memoryIdsByEntity.get(cooccurrence.a)
    const rightIds = memoryIdsByEntity.get(cooccurrence.b)
    if (leftIds === undefined || rightIds === undefined) continue
    const leftLatest = latestMemories(leftIds, byId, 1)[0]
    const rightLatest = latestMemories(rightIds, byId, 1)[0]
    if (leftLatest === undefined || rightLatest === undefined) continue
    const context = contextCosineAverage(leftIds, rightIds, byId, similarity)
    const leftSet = new Set(leftIds)
    const rightSet = new Set(rightIds)
    const overlap = jaccard(leftSet, rightSet)
    const proximity = timeProximity(leftLatest.updatedAt, rightLatest.updatedAt)
    const source = (memorySourceCredibility(leftLatest.sourceOrigin) + memorySourceCredibility(rightLatest.sourceOrigin)) / 2
    const confidence = round4(relationConfidence({
      cosineAvg: context.avg,
      entityJaccard: overlap,
      timeProximity: proximity,
      sourceCredibility: source,
    }))
    if (confidence < RELATION_MIN_CONFIDENCE) continue
    const sharedMemoryIds = [...cooccurrence.memoryIds].sort(cmpStr)
    const labelA = labelByEntity.get(cooccurrence.a) ?? cooccurrence.a
    const labelB = labelByEntity.get(cooccurrence.b) ?? cooccurrence.b
    const memoryIds = new Set        ([...sharedMemoryIds, leftLatest.id, rightLatest.id])
    const evidence                     = [
      {
        kind: 'shared-memory',
        text: `实体「${labelA}」与「${labelB}」共同出现在 ${sharedMemoryIds.length} 条记忆里`,
        sharedEntities: [labelA, labelB],
        memoryIds: sharedMemoryIds.slice(0, 5),
      },
      {
        kind: 'entity-overlap',
        text: `两者的记忆集合重叠度 ${formatScore(overlap)}（交集 ${leftSet.size + rightSet.size - new Set([...leftIds, ...rightIds]).size} / 并集 ${new Set([...leftIds, ...rightIds]).size}）`,
        sharedEntities: [labelA, labelB],
        memoryIds: sharedMemoryIds.slice(0, 5),
      },
      {
        kind: 'temporal',
        text: `最近提及时间相差 ${formatDuration(Math.abs(leftLatest.updatedAt - rightLatest.updatedAt))}（接近度 ${formatScore(proximity)}）`,
        memoryIds: [leftLatest.id, rightLatest.id],
      },
    ]
    if (context.count > 0) {
      evidence.push({
        kind: 'similarity',
        text: `上下文记忆两两余弦平均 ${formatScore(context.avg)}（共 ${context.count} 对）`,
        similarity: round4(context.avg),
        memoryIds: context.example !== undefined ? [...context.example] : [],
      })
    }
    evidence.push({
      kind: 'source',
      text: `两侧来源可信度均值 ${formatScore(source)}`,
      memoryIds: [leftLatest.id, rightLatest.id],
    })
    const key = relationKey('entity', cooccurrence.a, cooccurrence.b)
    if (!candidates.has(key)) {
      candidates.set(key, {
        key,
        type: 'entity',
        a: cooccurrence.a,
        b: cooccurrence.b,
        confidence,
        evidence,
        memoryIds,
      })
    }
  }
}

// ---------------------------------------------------------------- 关系：跨记忆语义通道

/** 取一条记忆的"主题实体"：优先非 tag、按 weight/类型排序后的第一个；exclude 用于避开同 id。 */
function topEntity(entities                       , excludeId         )                         {
  const sorted = [...entities].sort((a, b) => {
    const aTag = a.type === 'tag' ? 1 : 0
    const bTag = b.type === 'tag' ? 1 : 0
    if (aTag !== bTag) return aTag - bTag
    if (a.weight !== b.weight) return b.weight - a.weight
    return cmpStr(a.id, b.id)
  })
  for (const entity of sorted) {
    if (excludeId !== undefined && entity.id === excludeId) continue
    return entity
  }
  return undefined
}

function collectSemanticRelations(
  candidates                                ,
  memoryPairs                                  ,
  entitiesByMemory                                            ,
  entityIdsByMemory                                          ,
  byId                                     ,
  similarity                                         ,
)       {
  for (const [leftId, rightId] of memoryPairs) {
    const value = similarity(leftId, rightId)
    if (value === null || value < RELATION_SIMILARITY_THRESHOLD) continue
    const left = byId.get(leftId)
    const right = byId.get(rightId)
    if (left === undefined || right === undefined) continue
    const leftEntities = entitiesByMemory.get(leftId) ?? []
    const rightEntities = entitiesByMemory.get(rightId) ?? []
    const sourceEntity = topEntity(leftEntities)
    if (sourceEntity === undefined) continue
    const targetEntity = topEntity(rightEntities, sourceEntity.id)
    if (targetEntity === undefined || sourceEntity.id === targetEntity.id) continue
    const overlap = jaccard(new Set(entityIdsByMemory.get(leftId) ?? []), new Set(entityIdsByMemory.get(rightId) ?? []))
    const proximity = timeProximity(left.updatedAt, right.updatedAt)
    const source = (memorySourceCredibility(left.sourceOrigin) + memorySourceCredibility(right.sourceOrigin)) / 2
    const confidence = round4(relationConfidence({
      cosineAvg: clamp01(value),
      entityJaccard: overlap,
      timeProximity: proximity,
      sourceCredibility: source,
    }))
    if (confidence < RELATION_MIN_CONFIDENCE) continue
    const [a, b] = cmpStr(sourceEntity.id, targetEntity.id) <= 0
      ? [sourceEntity.id, targetEntity.id]
      : [targetEntity.id, sourceEntity.id]
    const sharedEntities = [...(entityIdsByMemory.get(leftId) ?? [])]
      .filter((id) => entityIdsByMemory.get(rightId)?.has(id) === true)
      .sort(cmpStr)
      .map((id) => labelByEntityLookup(id, leftEntities, rightEntities))
      .filter((label)                  => label !== undefined)
      .slice(0, 5)
    const evidence                     = [
      {
        kind: 'similarity',
        text: `记忆「${snippet(left.content, 24)}」与「${snippet(right.content, 24)}」语义相似度 ${formatScore(value)}`,
        similarity: round4(value),
        memoryIds: [leftId, rightId],
      },
      {
        kind: 'entity-overlap',
        text: `两条记忆实体集合 Jaccard ${formatScore(overlap)}${sharedEntities.length > 0 ? `，共享实体：${sharedEntities.join('、')}` : ''}`,
        ...(sharedEntities.length > 0 ? { sharedEntities } : {}),
        memoryIds: [leftId, rightId],
      },
      {
        kind: 'temporal',
        text: `两条记忆更新时间相差 ${formatDuration(Math.abs(left.updatedAt - right.updatedAt))}（接近度 ${formatScore(proximity)}）`,
        memoryIds: [leftId, rightId],
      },
      {
        kind: 'source',
        text: `两侧来源可信度均值 ${formatScore(source)}`,
        memoryIds: [leftId, rightId],
      },
    ]
    const key = relationKey('semantic', a, b)
    const incoming                    = {
      key,
      type: 'semantic',
      a,
      b,
      confidence,
      evidence,
      memoryIds: new Set([leftId, rightId]),
    }
    mergeRelationCandidate(candidates, incoming)
  }
}

function labelByEntityLookup(id        , ...lists                                      )                     {
  for (const list of lists) {
    for (const entity of list) if (entity.id === id) return entity.label
  }
  return undefined
}

function mergeRelationCandidate(candidates                                , incoming                   )       {
  const existing = candidates.get(incoming.key)
  if (existing === undefined) {
    candidates.set(incoming.key, incoming)
    return
  }
  const memoryIds = new Set        ([...existing.memoryIds, ...incoming.memoryIds])
  const primary = incoming.confidence > existing.confidence ? incoming : existing
  const secondary = primary === existing ? incoming : existing
  const evidence = [...primary.evidence]
  for (const item of secondary.evidence) {
    if (evidence.length >= 5) break
    if (evidence.some((current) => current.kind === item.kind && current.text === item.text)) continue
    evidence.push(item)
  }
  candidates.set(primary.key, { ...primary, memoryIds, evidence })
}

function relationKey(type              , a        , b        )         {
  const [x, y] = cmpStr(a, b) <= 0 ? [a, b] : [b, a]
  return `${type}\u0000${x}\u0000${y}`
}

function pairKey(a        , b        )         {
  const [x, y] = cmpStr(a, b) <= 0 ? [a, b] : [b, a]
  return `${x}\u0000${y}`
}

function finalizeRelations(
  candidates                                ,
  analysisVersion        ,
  now        ,
)                   {
  const relations                   = []
  for (const candidate of candidates.values()) {
    const confidence = round4(candidate.confidence)
    if (confidence < RELATION_MIN_CONFIDENCE) continue
    relations.push({
      id: hashId('rel_', candidate.key),
      sourceEntityId: candidate.a,
      targetEntityId: candidate.b,
      relationshipType: candidate.type,
      status: 'suggested',
      confidenceScore: confidence,
      strength: relationStrength(confidence),
      evidence: candidate.evidence.map((evidence) => ({ ...evidence, memoryIds: [...evidence.memoryIds] })),
      sourceMemoryIds: [...candidate.memoryIds].sort(cmpStr),
      inferred: false,
      analysisVersion,
      createdAt: now,
      updatedAt: now,
    })
  }
  relations.sort(
    (a, b) =>
      b.confidenceScore - a.confidenceScore ||
      cmpStr(a.sourceEntityId, b.sourceEntityId) ||
      cmpStr(a.targetEntityId, b.targetEntityId) ||
      cmpStr(a.relationshipType, b.relationshipType),
  )
  return relations.slice(0, MAX_RELATIONS)
}

// ---------------------------------------------------------------- 冲突

function detectConflicts(
  memoryPairs                                  ,
  byId                                     ,
  entityIdsByMemory                                          ,
  similarity                                         ,
  now        ,
)                   {
  const records                   = []
  const seen = new Set        ()
  for (const [leftId, rightId] of memoryPairs) {
    const left = byId.get(leftId)
    const right = byId.get(rightId)
    if (left === undefined || right === undefined) continue
    const pair = pairKey(leftId, rightId)
    if (seen.has(pair)) continue

    const value = similarity(leftId, rightId)
    const leftEntities = entityIdsByMemory.get(leftId) ?? new Set        ()
    const rightEntities = entityIdsByMemory.get(rightId) ?? new Set        ()
    let sharedCount = 0
    for (const id of leftEntities) if (rightEntities.has(id)) sharedCount++
    if (sharedCount === 0 && (value === null || value < CONFLICT_CANDIDATE_SIMILARITY)) continue
    if (normalizeContent(left.content) === normalizeContent(right.content)) continue
    // 版本谱系上的新旧版本不是冲突（已被 supersede 处理）。
    if (left.supersedes === right.id || right.supersedes === left.id) continue

    const critical = hasCriticalDetailConflict(left.content, right.content)
    const assessment = assessContradiction(left.content, right.content, value !== null ? { similarity: clamp01(value) } : {})
    let kind              
    let status                
    if (critical) {
      const timeGap = Math.abs(left.updatedAt - right.updatedAt)
      const numericDiff = assessment.comparison.numericRate > 0
      const pathDiff = assessment.comparison.pathsMissing.length > 0 || assessment.comparison.pathsExtra.length > 0
      if (timeGap > CONFLICT_UPDATE_TIME_GAP_MS && (numericDiff || pathDiff)) {
        kind = 'update'
        status = 'new'
      } else {
        kind = 'contradiction'
        status = 'pending_review'
      }
    } else if (value !== null && value >= CONFLICT_CONTEXT_SIMILARITY) {
      kind = 'context'
      status = 'new'
    } else {
      continue
    }

    seen.add(pair)
    const [oldMemory, newMemory] = compareAge(left, right) <= 0 ? [left, right] : [right, left]
    const timeGap = Math.abs(newMemory.updatedAt - oldMemory.updatedAt)
    const similarityValue = value === null ? 0 : round4(clamp01(value))
    const contradictionValue = round4(assessment.confidence)
    const details = assessment.comparison.details.slice(0, 3)
    const detailText = details.length > 0
      ? details.join('；')
      : `数值差异率 ${formatScore(assessment.comparison.numericRate)}，标识符差异率 ${formatScore(assessment.comparison.identifierRate)}`
    const summary = buildConflictSummary(kind, oldMemory, newMemory, detailText, similarityValue, timeGap)
    const evidence                     = [
      { kind: 'content', text: `旧记忆（${formatTime(oldMemory.updatedAt)}）：「${snippet(oldMemory.content)}」`, memoryId: oldMemory.id },
      { kind: 'content', text: `新记忆（${formatTime(newMemory.updatedAt)}）：「${snippet(newMemory.content)}」`, memoryId: newMemory.id },
      { kind: 'time', text: `更新时间相差 ${formatDuration(timeGap)}`, memoryId: newMemory.id },
      { kind: 'difference', text: detailText, memoryId: newMemory.id },
      { kind: 'similarity', text: `语义相似度 ${formatScore(similarityValue)}`, similarity: similarityValue },
      { kind: 'contradiction', text: `矛盾置信度 ${formatScore(contradictionValue)}`, contradiction: contradictionValue },
    ]
    records.push({
      id: hashId('cf_', pairKey(oldMemory.id, newMemory.id)),
      kind,
      status,
      oldMemoryId: oldMemory.id,
      newMemoryId: newMemory.id,
      similarity: similarityValue,
      contradiction: contradictionValue,
      summary,
      evidence,
      createdAt: now,
      updatedAt: now,
    })
  }
  const kindRank                               = { update: 0, contradiction: 1, context: 2, unknown: 3 }
  records.sort(
    (a, b) =>
      kindRank[a.kind] - kindRank[b.kind] ||
      b.contradiction - a.contradiction ||
      b.similarity - a.similarity ||
      cmpStr(a.id, b.id),
  )
  return records.slice(0, MAX_CONFLICTS)
}

/** 新旧比较：updatedAt → createdAt → id；负数 = 左边更旧。 */
function compareAge(left                , right                )         {
  if (left.updatedAt !== right.updatedAt) return left.updatedAt - right.updatedAt
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt
  return cmpStr(left.id, right.id)
}

function buildConflictSummary(
  kind              ,
  oldMemory                ,
  newMemory                ,
  detailText        ,
  similarity        ,
  timeGap        ,
)         {
  const oldSnippet = snippet(oldMemory.content, 30)
  const newSnippet = snippet(newMemory.content, 30)
  if (kind === 'update') {
    return snippet(
      `记忆更新：「${oldSnippet}」→「${newSnippet}」。差异：${detailText}。新记忆晚 ${formatDuration(timeGap)}，建议以新记忆为准。`,
      200,
    )
  }
  if (kind === 'contradiction') {
    return snippet(
      `记忆矛盾：「${oldSnippet}」与「${newSnippet}」关键细节不一致（${detailText}），无法判断哪条更新，需要人工裁决。`,
      200,
    )
  }
  return snippet(
    `语境相近（相似度 ${formatScore(similarity)}）：「${oldSnippet}」与「${newSnippet}」，未发现关键细节冲突，可能只是同一话题的不同表述。`,
    200,
  )
}

// ---------------------------------------------------------------- 聚类

function buildClusters(
  memories                           ,
  memoryPairs                                  ,
  entitiesByMemory                                            ,
  entityIdsByMemory                                          ,
  labelByEntity                             ,
  byId                                     ,
  similarity                                         ,
)                     {
  if (memories.length === 0) return []
  const unionFind = createUnionFind(memories.map((memory) => memory.id))
  for (const [leftId, rightId] of memoryPairs) {
    const leftSet = entityIdsByMemory.get(leftId) ?? new Set        ()
    const rightSet = entityIdsByMemory.get(rightId) ?? new Set        ()
    let shared = 0
    for (const id of leftSet) if (rightSet.has(id)) shared++
    if (shared >= CLUSTER_SHARED_ENTITIES) {
      unionFind.union(leftId, rightId)
      continue
    }
    const value = similarity(leftId, rightId)
    if (value !== null && value >= CLUSTER_SIMILARITY) unionFind.union(leftId, rightId)
  }

  const groups = new Map                  ()
  for (const memory of memories) {
    const root = unionFind.find(memory.id)
    const group = groups.get(root)
    if (group === undefined) groups.set(root, [memory.id])
    else group.push(memory.id)
  }

                            
              
                 
                       
                                
                 
                          
                               
   

  const working                   = []
  for (const memoryIds of groups.values()) {
    const sortedIds = [...memoryIds].sort(cmpStr)
    const entityCounts = new Map                ()
    for (const memoryId of sortedIds) {
      for (const entityId of entityIdsByMemory.get(memoryId) ?? []) {
        entityCounts.set(entityId, (entityCounts.get(entityId) ?? 0) + 1)
      }
    }
    const topEntities                  = [...entityCounts.entries()]
      .sort((a, b) => b[1] - a[1] || cmpStr(a[0], b[0]))
      .slice(0, 5)
      .map(([id, count]) => ({ id, label: labelByEntity.get(id) ?? id, count }))
    const topicEntities = topEntities
      .filter((item) => !item.id.startsWith('tag:'))
      .slice(0, 3)
      .map((item) => item.label)
    const topic = topicEntities.length > 0 ? topicEntities.join(' · ') : clusterFallbackTopic(sortedIds, byId)
    working.push({
      id: hashId('cl_', `${topic}|${sortedIds[0]}`),
      topic,
      memoryIds: sortedIds,
      topEntities,
      count: sortedIds.length,
      entityIds: new Set(entityCounts.keys()),
      relatedClusterIds: [],
    })
  }

  // 相关聚类：按"共享非 tag 实体数"排序（用实体倒排做两两计数，避免 O(c²) 全连）
  const entityClusters = new Map                  ()
  for (const cluster of working) {
    for (const entityId of cluster.entityIds) {
      if (entityId.startsWith('tag:')) continue
      const list = entityClusters.get(entityId)
      if (list === undefined) entityClusters.set(entityId, [cluster.id])
      else list.push(cluster.id)
    }
  }
  const relatedCount = new Map                ()
  for (const clusterIds of entityClusters.values()) {
    if (clusterIds.length < 2) continue
    const sorted = [...clusterIds].sort(cmpStr)
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const key = `${sorted[i]}\u0000${sorted[j]}`
        relatedCount.set(key, (relatedCount.get(key) ?? 0) + 1)
      }
    }
  }
  const relatedByCluster = new Map                                              ()
  for (const [key, count] of relatedCount) {
    const [leftId, rightId] = key.split('\u0000')
    const leftList = relatedByCluster.get(leftId )
    if (leftList === undefined) relatedByCluster.set(leftId , [{ id: rightId , count }])
    else leftList.push({ id: rightId , count })
    const rightList = relatedByCluster.get(rightId )
    if (rightList === undefined) relatedByCluster.set(rightId , [{ id: leftId , count }])
    else rightList.push({ id: leftId , count })
  }
  for (const cluster of working) {
    const list = relatedByCluster.get(cluster.id) ?? []
    list.sort((a, b) => b.count - a.count || cmpStr(a.id, b.id))
    cluster.relatedClusterIds = list.slice(0, 10).map((item) => item.id)
  }

  working.sort((a, b) => b.count - a.count || cmpStr(a.topic, b.topic) || cmpStr(a.id, b.id))
  const kept = working.slice(0, MAX_CLUSTERS)
  const keptIds = new Set(kept.map((cluster) => cluster.id))
  return kept.map((cluster) => ({
    id: cluster.id,
    topic: cluster.topic,
    memoryIds: cluster.memoryIds,
    topEntities: cluster.topEntities,
    count: cluster.count,
    relatedClusterIds: cluster.relatedClusterIds.filter((id) => keptIds.has(id)),
  }))
}

/** 没有实体时的 topic：用聚类内最常见的 kind 中文。 */
function clusterFallbackTopic(memoryIds                   , byId                                     )         {
  const kindCounts = new Map                ()
  for (const memoryId of memoryIds) {
    const memory = byId.get(memoryId)
    if (memory === undefined) continue
    kindCounts.set(memory.kind, (kindCounts.get(memory.kind) ?? 0) + 1)
  }
  const best = [...kindCounts.entries()].sort((a, b) => b[1] - a[1] || cmpStr(a[0], b[0]))[0]
  if (best === undefined) return '其他'
  return KIND_LABELS[best[0]] ?? best[0]
}

// ---------------------------------------------------------------- 演化

function buildEvolution(
  entitiesByMemory                                            ,
  memoryIdsByEntity                                        ,
  labelByEntity                             ,
  byId                                     ,
  now        ,
)                   {
  const tracks                   = []
  for (const [entityId, memoryIds] of memoryIdsByEntity) {
    if (memoryIds.length < 2) continue
    const timeline = memoryIds
      .map((id) => byId.get(id))
      .filter((memory)                           => memory !== undefined)
      .sort((a, b) => a.createdAt - b.createdAt || cmpStr(a.id, b.id))
    if (timeline.length < 2) continue
    const events                   = []
    for (const memory of timeline) {
      events.push({
        id: hashId('ev_', `${entityId}|created|${memory.id}`),
        entityId,
        type: 'created',
        memoryId: memory.id,
        at: memory.createdAt,
        detail: `记忆「${snippet(memory.content, 30)}」提到该实体`,
      })
      if (memory.updatedAt > memory.createdAt) {
        events.push({
          id: hashId('ev_', `${entityId}|updated|${memory.id}|${memory.updatedAt}`),
          entityId,
          type: 'updated',
          memoryId: memory.id,
          at: memory.updatedAt,
          detail: '该记忆被更新',
        })
      }
      if (typeof memory.supersedes === 'string' && memory.supersedes !== '') {
        events.push({
          id: hashId('ev_', `${entityId}|superseded|${memory.id}`),
          entityId,
          type: 'superseded',
          memoryId: memory.id,
          at: memory.updatedAt,
          supersededId: memory.supersedes,
          detail: '新版本记忆取代了旧版本',
        })
      }
      if (typeof memory.validUntil === 'number' && memory.validUntil <= now) {
        events.push({
          id: hashId('ev_', `${entityId}|invalidated|${memory.id}`),
          entityId,
          type: 'invalidated',
          memoryId: memory.id,
          at: memory.validUntil,
          detail: '该记忆陈述的事实已过有效期',
        })
      }
      if (memory.kind === 'decision') {
        events.push({
          id: hashId('ev_', `${entityId}|decision|${memory.id}`),
          entityId,
          type: 'decision',
          memoryId: memory.id,
          at: memory.createdAt,
          detail: '该实体出现在决策记录中',
        })
      }
    }
    events.sort((a, b) => a.at - b.at || cmpStr(a.type, b.type) || cmpStr(a.memoryId, b.memoryId))
    const firstAt = timeline[0] .createdAt
    const lastAt = timeline.reduce((max, memory) => Math.max(max, memory.updatedAt), firstAt)
    tracks.push({
      entityId,
      label: labelByEntity.get(entityId) ?? entityId,
      memoryIds: timeline.map((memory) => memory.id),
      events,
      firstAt,
      lastAt,
      count: timeline.length,
    })
  }
  tracks.sort((a, b) => b.count - a.count || cmpStr(a.entityId, b.entityId))
  return tracks.slice(0, MAX_EVOLUTION_TRACKS)
}

// ---------------------------------------------------------------- 2-hop 推理

                          
            
                    
                     
 

function buildReasoningPaths(
  relations                           ,
  labelByEntity                             ,
  memoryIdsByEntity                                        ,
  now        ,
  analysisVersion        ,
)                  {
  const direct = new Map                ()
  const adjacency = new Map                          ()
  for (const relation of relations) {
    if (relation.relationshipType !== 'entity') continue
    direct.set(pairKey(relation.sourceEntityId, relation.targetEntityId), Math.max(
      direct.get(pairKey(relation.sourceEntityId, relation.targetEntityId)) ?? 0,
      relation.confidenceScore,
    ))
    const push = (from        , to        )       => {
      const list = adjacency.get(from)
      const item                 = { id: to, confidence: relation.confidenceScore, memoryIds: relation.sourceMemoryIds }
      if (list === undefined) adjacency.set(from, [item])
      else list.push(item)
    }
    push(relation.sourceEntityId, relation.targetEntityId)
    push(relation.targetEntityId, relation.sourceEntityId)
  }
  for (const list of adjacency.values()) {
    list.sort((a, b) => b.confidence - a.confidence || cmpStr(a.id, b.id))
    if (list.length > MAX_PATH_NEIGHBORS) list.length = MAX_PATH_NEIGHBORS
  }

  const paths                  = []
  const seen = new Set        ()
  const fromIds = [...adjacency.keys()].sort(cmpStr)
  for (const fromId of fromIds) {
    const firstHop = adjacency.get(fromId) ?? []
    for (const middle of firstHop) {
      if (middle.id === fromId) continue
      const secondHop = adjacency.get(middle.id) ?? []
      for (const tail of secondHop) {
        const toId = tail.id
        if (toId === fromId || toId === middle.id) continue
        // A-C 不能有直接关系（那就不叫推理了）
        if (direct.has(pairKey(fromId, toId))) continue
        const confidence = round4(clamp01(middle.confidence * tail.confidence * REASONING_FACTOR))
        if (confidence < REASONING_MIN_CONFIDENCE) continue
        const forward = cmpStr(fromId, toId) <= 0
        const from = forward ? fromId : toId
        const to = forward ? toId : fromId
        const path = forward ? [fromId, middle.id, toId] : [toId, middle.id, fromId]
        const pathKey = path.join('>')
        if (seen.has(pathKey)) continue
        seen.add(pathKey)
        const labels = path.map((id) => labelByEntity.get(id) ?? id)
        const memoryIdSet = new Set        ([...middle.memoryIds, ...tail.memoryIds])
        for (const id of [from, middle.id, to]) {
          for (const memoryId of memoryIdsByEntity.get(id) ?? []) memoryIdSet.add(memoryId)
        }
        const sourceMemoryIds = [...memoryIdSet].sort(cmpStr)
        paths.push({
          id: hashId('path_', pathKey),
          fromEntityId: from,
          toEntityId: to,
          path,
          labels,
          confidence,
          inferred: true,
          relationshipType: 'reasoning',
          evidence: [
            {
              kind: 'reasoning-path',
              text: `推理链：${labels.join(' → ')}（两端没有直接共现关系）`,
              path: [...path],
              sharedEntities: [...labels],
              memoryIds: sourceMemoryIds.slice(0, 5),
            },
          ],
          sourceMemoryIds,
          analysisVersion,
          createdAt: now,
          updatedAt: now,
        })
      }
    }
  }
  paths.sort((a, b) => b.confidence - a.confidence || cmpStr(a.id, b.id))
  return paths.slice(0, MAX_PATHS)
}


//# sourceURL=source/memory-local/src/analysis/engine.ts