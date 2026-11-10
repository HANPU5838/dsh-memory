/**
 * ANN 工厂（任务书 §3）：统一入口，按可用性自动降级。
 *
 * 选型策略：
 *   - `prefer: 'auto'`（默认）→ 纯 JS HNSW（零依赖、任何设备可用）；
 *   - `prefer: 'hnswlib'` → 动态加载 hnswlib-node，失败自动回退纯 JS；
 *   - `prefer: 'brute'` → 全量余弦扫描（小库或基准对照）。
 *
 * 记忆库规模不大时（< `ANN_MIN_SIZE` 约 2000 条）全量扫描反而更快：没有图
 * 遍历常数、没有常驻图内存。`shouldUseAnn(size)` 给出这个判断，接入方可以
 * 直接用它决定"用图索引还是继续全量扫描"。
 */
import { BruteAnnIndex } from './brute.js'
import { HnswLiteIndex } from './hnsw-lite.js'
import { HnswlibIndex, loadHnswlib, resetHnswlibCache,                        } from './hnswlib.js'
                                                   

export * from './types.js'
export { BruteAnnIndex } from './brute.js'
export { HnswLiteIndex } from './hnsw-lite.js'
export { HnswlibIndex, loadHnswlib, resetHnswlibCache } from './hnswlib.js'
                                                                                               
                                                     

/** 低于这个条数不值得建图索引（图遍历常数 + 图内存 > 全量扫描收益）。 */
export const ANN_MIN_SIZE = 2000

/** 判定当前库规模是否值得用 ANN。 */
export function shouldUseAnn(size        , threshold = ANN_MIN_SIZE)          {
  return size >= threshold
}

                                    
              
                                                              
            
                            
                         
                                                               
                   
                                   
                      
                                  
               
                                 
                           
                                 
                                          
                                   
 

/**
 * 创建 ANN 索引。永不抛（未知 prefer 除外——那是配置错误，构造期暴露）。
 * 返回的实现一定满足 `AnnIndex` 接口，调用方不需要判空。
 */
export async function createAnnIndex(opts                   )                    {
  const prefer = opts.prefer ?? 'auto'
  if (prefer === 'brute') return new BruteAnnIndex(opts.dims)
  if (prefer === 'auto' || prefer === 'hnswlite') {
    return new HnswLiteIndex({
      dims: opts.dims,
      ...(opts.M !== undefined ? { M: opts.M } : {}),
      ...(opts.efConstruction !== undefined ? { efConstruction: opts.efConstruction } : {}),
      ...(opts.efSearch !== undefined ? { efSearch: opts.efSearch } : {}),
      ...(opts.maxElements !== undefined ? { maxElements: opts.maxElements } : {}),
      ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
    })
  }
  if (prefer === 'hnswlib') {
    const native = await HnswlibIndex.create(
      {
        dims: opts.dims,
        M: opts.M ?? 24,
        ...(opts.efConstruction !== undefined ? { efConstruction: opts.efConstruction } : {}),
        ...(opts.efSearch !== undefined ? { efSearch: opts.efSearch } : {}),
        ...(opts.maxElements !== undefined ? { maxElements: opts.maxElements } : {}),
      },
      opts.hnswlibModule,
    )
    if (native !== null) return native
    ;(opts.log ?? ((message        ) => console.warn(`[dsh-memory-local] ${message}`)))(
      '可选依赖 hnswlib-node 不可用（未安装或原生加载失败），回退纯 JS HNSW',
    )
    return new HnswLiteIndex({
      dims: opts.dims,
      ...(opts.M !== undefined ? { M: opts.M } : {}),
      ...(opts.efConstruction !== undefined ? { efConstruction: opts.efConstruction } : {}),
      ...(opts.efSearch !== undefined ? { efSearch: opts.efSearch } : {}),
      ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
    })
  }
  throw new Error(`未知的 ANN 选型 prefer=${String(prefer)}（支持 auto/hnswlite/hnswlib/brute）`)
}


//# sourceURL=source/memory-local/src/ann/index.ts