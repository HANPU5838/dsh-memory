/**
 * 全量余弦扫描的 ANN 接口实现（退化路径 / 基准对照）。
 *
 * 这就是现有检索管线在做的事：每条记录算一次 cosine，排序取 top-k。
 * 当 HNSW 不可用或数据量太小（< 约 2000 条）时它就是最优解——图索引的
 * 常驻内存和建图开销不划算。同时它是基准里衡量 ANN 召回率的 ground truth。
 */
import { prepareAnnVector,                                                                                } from './types.js'

export class BruteAnnIndex                     {
           kind = 'brute'         
           dims        
          vectors = new Map                      ()
          buildStart = 0
          lastBuildMs                    

  constructor(dims        ) {
    if (!Number.isInteger(dims) || dims <= 0) throw new Error(`ANN dims 非法：${String(dims)}`)
    this.dims = dims
  }

  get size()         {
    return this.vectors.size
  }

  build(items                    )       {
    this.buildStart = Date.now()
    this.vectors.clear()
    for (const item of items) this.vectors.set(item.id, prepareAnnVector(item.vector, this.dims))
    this.lastBuildMs = Date.now() - this.buildStart
  }

  search(query              , k        , opts                   )           {
    if (k <= 0 || this.vectors.size === 0) return []
    const q = prepareAnnVector(query, this.dims)
    const threshold = opts?.threshold
    const hits           = []
    for (const [id, vector] of this.vectors) {
      let dot = 0
      for (let i = 0; i < this.dims; i++) dot += q[i]  * vector[i] 
      if (threshold !== undefined && dot < threshold) continue
      hits.push({ id, score: dot })
    }
    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, k)
  }

  insert(id        , vector              )          {
    if (this.vectors.has(id)) return false
    this.vectors.set(id, prepareAnnVector(vector, this.dims))
    return true
  }

  update(id        , vector              )          {
    if (!this.vectors.has(id)) return false
    this.vectors.set(id, prepareAnnVector(vector, this.dims))
    return true
  }

  remove(id        )          {
    return this.vectors.delete(id)
  }

  has(id        )          {
    return this.vectors.has(id)
  }

  clear()       {
    this.vectors.clear()
  }

  stats()           {
    return { kind: this.kind, size: this.vectors.size, dims: this.dims, buildMs: this.lastBuildMs }
  }
}


//# sourceURL=source/memory-local/src/ann/brute.ts