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
import { BruteAnnIndex } from './brute.ts'
import { HnswLiteIndex } from './hnsw-lite.ts'
import { HnswlibIndex, loadHnswlib, resetHnswlibCache, type HnswlibModuleLike } from './hnswlib.ts'
import type { AnnIndex, AnnKind } from './types.ts'

export * from './types.ts'
export { BruteAnnIndex } from './brute.ts'
export { HnswLiteIndex } from './hnsw-lite.ts'
export { HnswlibIndex, loadHnswlib, resetHnswlibCache } from './hnswlib.ts'
export type { HnswlibIndexOptions, HnswlibInstanceLike, HnswlibModuleLike } from './hnswlib.ts'
export type { HnswLiteOptions } from './hnsw-lite.ts'

/** 低于这个条数不值得建图索引（图遍历常数 + 图内存 > 全量扫描收益）。 */
export const ANN_MIN_SIZE = 2000

/** 判定当前库规模是否值得用 ANN。 */
export function shouldUseAnn(size: number, threshold = ANN_MIN_SIZE): boolean {
  return size >= threshold
}

export interface AnnFactoryOptions {
  dims: number
  /** 每层连接数（默认 24：纯 JS 版实测 20k 条 recall@10 从 0.90 提到 0.96）。 */
  M?: number
  /** 建图 beam 宽度（默认 200）。 */
  efConstruction?: number
  /** 查询 beam 宽度（默认 128；20k 条实测 ef=128 召回 ~0.97、P50 ~1.5ms）。 */
  efSearch?: number
  /** 容量提示（hnswlib 用；纯 JS 自动扩容）。 */
  maxElements?: number
  /** 纯 JS 实现的层高随机种子（测试/基准可复现）。 */
  seed?: number
  /** 选型；默认 'auto'（纯 JS HNSW）。 */
  prefer?: AnnKind | 'auto'
  log?: (message: string) => void
  /** 仅测试：注入 fake hnswlib 模块（避免依赖原生模块）。 */
  hnswlibModule?: HnswlibModuleLike
}

/**
 * 创建 ANN 索引。永不抛（未知 prefer 除外——那是配置错误，构造期暴露）。
 * 返回的实现一定满足 `AnnIndex` 接口，调用方不需要判空。
 */
export async function createAnnIndex(opts: AnnFactoryOptions): Promise<AnnIndex> {
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
    ;(opts.log ?? ((message: string) => console.warn(`[dsh-memory-local] ${message}`)))(
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
