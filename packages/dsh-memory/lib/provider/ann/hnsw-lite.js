/**
 * 纯 JS 的 HNSW 近似最近邻索引（零依赖兜底实现，任务书 §3）。
 *
 * 为什么自己实现而不是硬依赖 hnswlib-node：本插件"零运行时依赖"是硬约束，
 * 原生模块在 Android/Termux 上还要编译，用户装不上就整个插件挂掉不可接受。
 * 纯 JS 版 ~20k 条 × 128 维建图约数秒、单次查询 ~1ms 内，已经够用；
 * hnswlib-node 存在时由 `ann/index.ts` 优先/显式选用（更省内存）。
 *
 * 实现要点（与论文一致的部分）：
 *   - 多层图 + 随机层高（`floor(-ln(U) * 1/ln(M))`），上层稀疏用于快速逼近；
 *   - 插入时上层贪心下降，目标层用 efConstruction 的 beam search 选邻居，
 *     双向连边并把邻居表修剪到 M（第 0 层 2M）；
 *   - 删除用"墓碑"：节点保留在图中当路由点（与 hnswlib 的 markDelete 一致），
 *     只是不再出现在结果里，避免重建整张图；
 *   - 向量写入时防御性 L2 归一化，score 直接是 cosine（== 点积），
 *     与现有 `scoring.cosine()` 语义一致，可 1:1 替换全量扫描。
 *
 * 可复现性：传入 `seed` 后层高随机序列固定，测试/基准可重复。
 */
import {
  prepareAnnVector,
              
               
                
                        
                
} from './types.js'

                                  
              
     
                                   
                                                                     
                                                
                                              
     
            
                                          
                         
     
                                                                 
                                                         
     
                   
                                                  
                      
                       
               
                           
                    
                                 
 

                    
               
              
 

/** 查询期候选堆（按 distance 升序弹出）。 */
class MinHeap {
          labels           = []
          dists           = []

  get size()         {
    return this.labels.length
  }

  push(label        , dist        )       {
    this.labels.push(label)
    this.dists.push(dist)
    let i = this.labels.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.dists[parent]  <= this.dists[i] ) break
      const tmpL = this.labels[parent] 
      const tmpD = this.dists[parent] 
      this.labels[parent] = this.labels[i] 
      this.dists[parent] = this.dists[i] 
      this.labels[i] = tmpL
      this.dists[i] = tmpD
      i = parent
    }
  }

  pop()                  {
    if (this.labels.length === 0) return null
    const label = this.labels[0] 
    const dist = this.dists[0] 
    const lastLabel = this.labels.pop() 
    const lastDist = this.dists.pop() 
    if (this.labels.length > 0) {
      this.labels[0] = lastLabel
      this.dists[0] = lastDist
      let i = 0
      for (;;) {
        const left = i * 2 + 1
        const right = left + 1
        let smallest = i
        if (left < this.labels.length && this.dists[left]  < this.dists[smallest] ) smallest = left
        if (right < this.labels.length && this.dists[right]  < this.dists[smallest] ) smallest = right
        if (smallest === i) break
        const tmpL = this.labels[i] 
        const tmpD = this.dists[i] 
        this.labels[i] = this.labels[smallest] 
        this.dists[i] = this.dists[smallest] 
        this.labels[smallest] = tmpL
        this.dists[smallest] = tmpD
        i = smallest
      }
    }
    return { label, dist }
  }
}

/** 有序数组插入（results 规模 = ef，二分定位后 splice 即可）。 */
function insertSorted(list            , item          )       {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (list[mid] .dist <= item.dist) lo = mid + 1
    else hi = mid
  }
  list.splice(lo, 0, item)
}

/** mulberry32：小而稳定的可复现伪随机数（层高用）。 */
function mulberry32(seed        )               {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export class HnswLiteIndex                     {
           kind = 'hnswlite'         
           dims        
                   M        
                   M0        
                   efConstruction        
          efSearch        
                   levelMult        
                   random              

  /** label（= 单调递增下标）→ 节点数据。删除的节点保留向量当路由点。 */
          vectors                 = []
          levels           = []
          alive            = []
          ids           = []
  /** 存活 id → label；删除时移除（update 会分配新 label）。 */
          labels = new Map                ()
  /** 每层邻接表：level → (label → 邻居 label 列表)。 */
          links                               = []
          entry = -1
          maxLevel = -1
          aliveCount = 0
          lastBuildMs                    

  constructor(opts                 ) {
    if (!Number.isInteger(opts.dims) || opts.dims <= 0) throw new Error(`ANN dims 非法：${String(opts.dims)}`)
    this.dims = opts.dims
    this.M = Math.max(4, Math.floor(opts.M ?? 24))
    this.M0 = this.M * 2
    this.efConstruction = Math.max(this.M, Math.floor(opts.efConstruction ?? 200))
    this.efSearch = Math.max(1, Math.floor(opts.efSearch ?? 128))
    this.levelMult = opts.levelMult ?? 1 / Math.log(this.M)
    this.random = opts.seed === undefined ? Math.random : mulberry32(opts.seed)
  }

  get size()         {
    return this.aliveCount
  }

  /** 节点总数（含删除墓碑）。 */
  get nodeCount()         {
    return this.vectors.length
  }

  build(items                    )       {
    const started = Date.now()
    this.clear()
    for (const item of items) this.insertNode(item.id, prepareAnnVector(item.vector, this.dims))
    this.lastBuildMs = Date.now() - started
  }

  insert(id        , vector              )          {
    if (this.labels.has(id)) return false
    this.insertNode(id, prepareAnnVector(vector, this.dims))
    return true
  }

  update(id        , vector              )          {
    if (!this.labels.has(id)) return false
    const prepared = prepareAnnVector(vector, this.dims)
    // 墓碑旧节点 + 用新 label 重新建边：比原地改向量更简单且保证图质量。
    this.remove(id)
    this.insertNode(id, prepared)
    return true
  }

  remove(id        )          {
    const label = this.labels.get(id)
    if (label === undefined) return false
    this.labels.delete(id)
    this.alive[label] = false
    this.aliveCount -= 1
    return true
  }

  has(id        )          {
    return this.labels.has(id)
  }

  clear()       {
    this.vectors = []
    this.levels = []
    this.alive = []
    this.ids = []
    this.labels.clear()
    this.links = []
    this.entry = -1
    this.maxLevel = -1
    this.aliveCount = 0
    this.lastBuildMs = undefined
  }

  search(query              , k        , opts                   )           {
    if (k <= 0 || this.aliveCount === 0 || this.entry < 0) return []
    const q = prepareAnnVector(query, this.dims)
    const ef = Math.max(1, Math.floor(opts?.efSearch ?? this.efSearch), Math.min(k, this.aliveCount))
    let ep = this.entry
    for (let level = this.maxLevel; level > 0; level--) ep = this.greedySearch(q, ep, level)
    const results = this.searchLayer(q, [ep], ef, 0)
    const threshold = opts?.threshold
    const hits           = []
    for (const result of results) {
      if (!this.alive[result.label]) continue
      const score = 1 - result.dist
      if (threshold !== undefined && score < threshold) continue
      hits.push({ id: this.ids[result.label] , score })
      if (hits.length >= k) break
    }
    return hits
  }

  stats()           {
    return {
      kind: this.kind,
      size: this.aliveCount,
      nodes: this.vectors.length,
      dims: this.dims,
      maxLevel: this.maxLevel,
      buildMs: this.lastBuildMs,
    }
  }

  // --- 图算法 -------------------------------------------------------------

  /** distance = 1 - cosine（向量已归一化 → 点积即 cosine）。 */
          distance(a              , b              )         {
    const dims = this.dims
    let dot = 0
    for (let i = 0; i < dims; i++) dot += a[i]  * b[i] 
    return 1 - dot
  }

          randomLevel()         {
    const u = Math.max(this.random(), 1e-12)
    return Math.min(Math.floor(-Math.log(u) * this.levelMult), 32)
  }

          ensureLinks(maxLevel        )       {
    while (this.links.length <= maxLevel) this.links.push(new Map())
  }

          insertNode(id        , vector              )       {
    const level = this.randomLevel()
    const label = this.vectors.length
    this.vectors.push(vector)
    this.levels.push(level)
    this.alive.push(true)
    this.ids.push(id)
    this.labels.set(id, label)
    this.aliveCount += 1
    if (this.entry < 0) {
      this.entry = label
      this.maxLevel = level
      this.ensureLinks(level)
      return
    }
    this.ensureLinks(Math.max(this.maxLevel, level))
    let ep = this.entry
    // 1) 高于新节点层级的层：只做贪心下降（不建边）
    for (let l = this.maxLevel; l > level; l--) ep = this.greedySearch(vector, ep, l)
    // 2) 新节点层级跟 maxLevel 的较小值往下逐层：beam search 选邻居、双向连边
    for (let l = Math.min(level, this.maxLevel); l >= 0; l--) {
      const candidates = this.searchLayer(vector, [ep], this.efConstruction, l)
      const selected = candidates.slice(0, this.M).map((c) => c.label)
      this.links[l] .set(label, selected)
      for (const neighbor of selected) this.addLink(l, neighbor, label)
      if (candidates.length > 0) ep = candidates[0] .label
    }
    if (level > this.maxLevel) {
      this.maxLevel = level
      this.entry = label
    }
  }

  /** 给 from 加一条到 to 的边；超过上限按"到 from 的距离"保留最近的。 */
          addLink(level        , from        , to        )       {
    const map = this.links[level] 
    const list = map.get(from)
    if (list === undefined) {
      map.set(from, [to])
      return
    }
    if (list.includes(to)) return
    list.push(to)
    const max = level === 0 ? this.M0 : this.M
    if (list.length <= max) return
    const base = this.vectors[from] 
    const scored = list.map((label) => ({ label, dist: this.distance(base, this.vectors[label] ) }))
    scored.sort((a, b) => a.dist - b.dist)
    map.set(from, scored.slice(0, max).map((entry) => entry.label))
  }

  /** 单层贪心下降：只走比当前更近的邻居。 */
          greedySearch(query              , entry        , level        )         {
    let current = entry
    let currentDist = this.distance(query, this.vectors[current] )
    let improved = true
    while (improved) {
      improved = false
      const neighbors = this.links[level]?.get(current)
      if (neighbors === undefined) break
      for (const neighbor of neighbors) {
        const dist = this.distance(query, this.vectors[neighbor] )
        if (dist < currentDist) {
          current = neighbor
          currentDist = dist
          improved = true
        }
      }
    }
    return current
  }

  /** 单层 beam search：返回按距离升序的前 ef 个候选（含墓碑节点）。 */
          searchLayer(query              , entries                   , ef        , level        )             {
    const visited = new Set        ()
    const candidates = new MinHeap()
    const results             = []
    for (const entry of entries) {
      if (visited.has(entry)) continue
      visited.add(entry)
      const dist = this.distance(query, this.vectors[entry] )
      candidates.push(entry, dist)
      insertSorted(results, { label: entry, dist })
      if (results.length > ef) results.pop()
    }
    while (candidates.size > 0) {
      const current = candidates.pop() 
      const farthest = results[results.length - 1]
      if (results.length >= ef && farthest !== undefined && current.dist > farthest.dist) break
      const neighbors = this.links[level]?.get(current.label)
      if (neighbors === undefined) continue
      for (const neighbor of neighbors) {
        if (visited.has(neighbor)) continue
        visited.add(neighbor)
        const dist = this.distance(query, this.vectors[neighbor] )
        const worst = results.length >= ef ? results[results.length - 1] .dist : Infinity
        if (results.length < ef || dist < worst) {
          candidates.push(neighbor, dist)
          insertSorted(results, { label: neighbor, dist })
          if (results.length > ef) results.pop()
        }
      }
    }
    return results
  }
}


//# sourceURL=source/memory-local/src/ann/hnsw-lite.ts