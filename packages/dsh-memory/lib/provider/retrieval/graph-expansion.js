/**
 * 图增强检索（Graph-expanded recall，HippoRAG 风格）—— 纯函数、确定性、零依赖。
 *
 * 为什么需要它：词法通道只看字面重合、向量通道只看整句语义相似度，两者都**看不到
 * 「记忆之间共享的实体」**。真实记忆库里大量关联是"实体桥接"出来的，例如：
 *   A: 用 pm2 管理 /srv/app 服务
 *   B: /srv/app 的 nginx 配置在 /etc/nginx/sites-enabled
 * 查询 "pm2" 只会命中 A；B 与 A 共享实体 `/srv/app`，但它既不含 "pm2"、整句余弦也
 * 不高 —— 这正是"多跳记忆"该补回来的联想。GraphRAG/HippoRAG 的做法是：以候选为
 * 种子在实体图上跑 Personalized PageRank（带重启的随机游走），把扩散到的高分节点
 * 作为补充候选。
 *
 * 设计约束（与包内其它检索组件一致）：
 *   - 纯函数 + 确定性：输入相同 → 输出逐字节相同（节点/边按 id 排序、无随机数）；
 *   - 不建持久化图、不写盘：每次检索按当前可见记录现建，记录变了图自然跟着变；
 *   - 有界：实体数/记录数/迭代次数都有硬上限，CPU 只做几十次稀疏迭代；
 *   - 可关闭：`retrieval.graphExpansion.enabled`，关掉完全回到旧行为。
 */
import { extractEntities } from '../analysis/entities.js'

// ---------------------------------------------------------------- 类型

/** 建图需要的最小记录形状（只读，不依赖 MemoryRecord 的完整字段）。 */
                              
            
                 
                          
                                  
                     
                
 

/** 关联图：无向加权邻接表 + 统计信息。 */
                                   
                                  
                                             
                               
                 
                                
                               
                                  
                                                             
 

/** PPR 配置（幂迭代）。 */
                                  
                                      
                
                           
                        
                          
                    
 

/** 图扩散补充候选。 */
                                    
            
                           
               
                                   
                  
 

// ---------------------------------------------------------------- 常量

/** 单条记录最多用多少个实体建边（与 entities.ts 的抽取上限一致）。 */
const MAX_ENTITIES_PER_RECORD = 24
/** 实体边基础权重：共享实体 = 两个实体权重的几何平均 × idf 缩放。 */
const ENTITY_EDGE_SCALE = 0.6
/** 谱系边（supersedes）权重：修正关系比偶发实体共现更强，但弱于完全同实体。 */
const SUPERSEDES_EDGE_WEIGHT = 0.9
/** 单条记录参与的边数上限（防止热点实体把图变成完全图）。 */
const MAX_EDGES_PER_RECORD = 24

// ---------------------------------------------------------------- 建图

/**
 * 按「共享实体 + 修正谱系」构建记录关联图。
 *
 * 边权设计：
 *   - 实体边：`0.6 * sqrt(entityA.weight * entityB.weight) * log(1 + N/df)`。
 *     df 越小的实体越"专有"，桥接越可信；N/df 让常见实体（如版本号 v1）不至于
 *     把无关记录全连起来。
 *   - 谱系边：`0.9`（修正关系是强关系）。
 *   - 同一对记录多条边时取 max，而不是累加（避免共享多个常见实体后权重爆炸）。
 */
export function buildAssociationGraph(
  records                        ,
  options                                    = {},
)                   {
  const adjacency = new Map                             ()
  const entityDf = new Map                ()
  const maxEntities = Math.min(options.maxEntitiesPerRecord ?? MAX_ENTITIES_PER_RECORD, MAX_ENTITIES_PER_RECORD)

  // 1) 确定性排序：图结构不受调用方传入顺序影响。
  const sorted = [...records]
    .filter((r) => r !== null && typeof r === 'object' && typeof r.id === 'string' && r.id !== '')
    .sort((a, b) => a.id.localeCompare(b.id))

  const addEdge = (a        , b        , weight        )       => {
    if (a === b || !(weight > 0)) return
    const left = adjacency.get(a) ?? new Map                ()
    const right = adjacency.get(b) ?? new Map                ()
    left.set(b, Math.max(left.get(b) ?? 0, weight))
    right.set(a, Math.max(right.get(a) ?? 0, weight))
    adjacency.set(a, left)
    adjacency.set(b, right)
  }

  // 2) 抽实体：entityKey → 记录 id 列表。
  const entityToRecords = new Map                  ()
  const recordEntities = new Map                                                ()
  for (const record of sorted) {
    const entities = extractEntities(record.content, {
      ...(record.tags !== undefined ? { tags: [...record.tags] } : {}),
    })
    const picked = entities.slice(0, maxEntities)
    const list                                         = []
    for (const entity of picked) {
      const key = entityNodeKey(entity)
      list.push({ key, weight: entity.weight })
      const hits = entityToRecords.get(key) ?? []
      hits.push(record.id)
      entityToRecords.set(key, hits)
    }
    recordEntities.set(record.id, list)
  }
  for (const [key, ids] of entityToRecords) entityDf.set(key, new Set(ids).size)

  // 3) 实体边：同一实体下的记录两两相连（df 太大时跳过，避免热点实体爆炸）。
  const totalRecords = sorted.length
  const maxDf = Math.max(8, Math.floor(totalRecords * 0.5))
  for (const [key, ids] of [...entityToRecords.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const df = entityDf.get(key) ?? 0
    if (df < 2 || df > maxDf) continue
    const idf = Math.log(1 + totalRecords / df)
    const unique = [...new Set(ids)].sort()
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const a = unique[i] 
        const b = unique[j] 
        const wa = recordEntities.get(a)?.find((e) => e.key === key)?.weight ?? 1
        const wb = recordEntities.get(b)?.find((e) => e.key === key)?.weight ?? 1
        const weight = ENTITY_EDGE_SCALE * Math.sqrt(Math.max(0, wa) * Math.max(0, wb)) * idf
        addEdge(a, b, weight)
      }
    }
  }

  // 4) 谱系边：修正关系。
  for (const record of sorted) {
    if (typeof record.supersedes !== 'string' || record.supersedes === '') continue
    if (!recordEntities.has(record.supersedes)) continue
    addEdge(record.id, record.supersedes, SUPERSEDES_EDGE_WEIGHT)
  }

  // 5) 裁剪：每条记录只保留权重最高的 maxEdges 条边（确定性排序）。
  let edgeCount = 0
  for (const [node, neighbors] of adjacency) {
    const trimmed = [...neighbors.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, MAX_EDGES_PER_RECORD)
    adjacency.set(node, new Map(trimmed))
    edgeCount += trimmed.length
  }

  return {
    adjacency,
    nodes: sorted.map((r) => r.id),
    entityDf,
    stats: { records: sorted.length, entities: entityDf.size, edges: edgeCount / 2 },
  }
}

/** 实体的归一化图节点键（type + normalized，与 analysis/entities 的节点 id 同构）。 */
function entityNodeKey(entity                                      )         {
  return `${entity.type}:${entity.normalized}`
}

// ---------------------------------------------------------------- PPR

/**
 * Personalized PageRank（带重启的随机游走），幂迭代实现。
 *
 * 增量式 PPR（HippoRAG 2 / GraphRAG 的常用近似）在这里不需要：记录数有上限
 * （maxRecordsPerScope），一次稀疏迭代几十轮在手机上也是毫秒级，正确性优先。
 *
 * @param graph  buildAssociationGraph() 的结果
 * @param seeds  种子分布（记录 id → 权重）；权重会归一化，非法种子忽略
 * @returns      记录 id → 分数（只含图内节点；无种子时返回空 Map）
 */
export function personalizedPageRank(
  graph                  ,
  seeds                                                                        ,
  options                  = {},
)                      {
  const alpha = clampNumber(options.alpha ?? 0.85, 0, 0.99)
  const maxIterations = Math.max(1, Math.min(Math.floor(options.maxIterations ?? 24), 100))
  const tolerance = Math.max(0, options.tolerance ?? 1e-6)
  const nodes = graph.nodes
  if (nodes.length === 0) return new Map()

  // 归一化种子（只保留图内节点；权重 ≤0 或非有限值丢弃）。
  const seedEntries                          = []
  const seen = new Set        ()
  const seedSource = seeds instanceof Map ? [...seeds.entries()] : [...seeds]
  for (const [id, weight] of seedSource) {
    if (typeof id !== 'string' || seen.has(id)) continue
    if (!graph.adjacency.has(id) && !nodes.includes(id)) continue
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) continue
    seen.add(id)
    seedEntries.push([id, weight])
  }
  if (seedEntries.length === 0) return new Map()
  const seedTotal = seedEntries.reduce((sum, [, w]) => sum + w, 0)
  const personalization = new Map                (seedEntries.map(([id, w]) => [id, w / seedTotal]))

  // 出度（悬挂节点把质量按 personalization 重新分配）。
  const outDegree = new Map                ()
  for (const node of nodes) {
    let deg = 0
    for (const w of graph.adjacency.get(node)?.values() ?? []) deg += w
    outDegree.set(node, deg)
  }

  let score = new Map                (personalization)
  for (let iter = 0; iter < maxIterations; iter++) {
    const next = new Map                ()
    // 悬挂节点质量（按 personalization 分配，保持总和为 1）。
    let dangling = 0
    for (const node of nodes) {
      const s = score.get(node) ?? 0
      const deg = outDegree.get(node) ?? 0
      if (deg <= 0) {
        dangling += s
        continue
      }
      const neighbors = graph.adjacency.get(node)
      if (neighbors === undefined) continue
      for (const [target, weight] of neighbors) {
        next.set(target, (next.get(target) ?? 0) + (alpha * s * weight) / deg)
      }
    }
    if (dangling > 0) {
      for (const [id, p] of personalization) next.set(id, (next.get(id) ?? 0) + alpha * dangling * p)
    }
    for (const [id, p] of personalization) next.set(id, (next.get(id) ?? 0) + (1 - alpha) * p)

    // L1 收敛判定。
    let diff = 0
    for (const node of nodes) diff += Math.abs((next.get(node) ?? 0) - (score.get(node) ?? 0))
    score = next
    if (diff < tolerance) break
  }
  return score
}

// ---------------------------------------------------------------- 候选筛选

/**
 * 从 PPR 结果里挑出要补充给检索的候选。
 *
 * 筛选口径：
 *   - 排除已有候选（avoid）与调用方明确排除的 id（exclude）；
 *   - 绝对分 ≥ minAbsolute，且 ≥ maxScore × minRelative（防止长尾噪声）；
 *   - 最多 limit 条，按分数降序 + id 升序（确定性）。
 */
export function pickGraphExpansion(input   
                                  
                             
                
                      
                      
 )                      {
  const avoid = input.avoid ?? new Set        ()
  const limit = Math.max(0, Math.min(Math.floor(input.limit ?? 8), 50))
  const minRelative = clampNumber(input.minRelative ?? 0.08, 0, 1)
  const minAbsolute = Math.max(0, input.minAbsolute ?? 1e-4)
  const hits                                       = []
  let maxScore = 0
  for (const [id, score] of input.ppr) {
    if (typeof score !== 'number' || !Number.isFinite(score) || score <= 0) continue
    if (score > maxScore) maxScore = score
    if (avoid.has(id)) continue
    if (score < minAbsolute) continue
    hits.push({ id, score })
  }
  if (maxScore <= 0) return []
  const floor = maxScore * minRelative
  const picked = hits
    .filter((hit) => hit.score >= floor)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit)
  return picked.map((hit) => ({ id: hit.id, score: hit.score, relative: hit.score / maxScore }))
}

function clampNumber(value        , min        , max        )         {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, value))
}


//# sourceURL=source/memory-local/src/retrieval/graph-expansion.ts