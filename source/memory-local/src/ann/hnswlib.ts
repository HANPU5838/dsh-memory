/**
 * `hnswlib-node` 可选适配器（任务书 §3）。
 *
 * hnswlib-node 是原生模块（C++ 绑定），比纯 JS 版省内存、查询更快，但它**不是
 * 运行时依赖**：没装 / 原生编译失败 / Android ABI 不匹配时，整个插件必须照常
 * 工作。因此：
 *
 *   - 加载走**动态 import + try/catch**，specifier 用变量传，打包/静态分析不会
 *     提前解析它；
 *   - 加载失败返回 null，`ann/index.ts` 自动回退纯 JS HNSW 或全量扫描；
 *   - 类里所有 hnswlib 调用都包在 try/catch 里（原生模块的错误形态不可控），
 *     出错就退化成"本次查询无结果"，绝不让检索抛错。
 *
 * 标签映射：hnswlib 只认 0..maxElements-1 的数字 label，所以插件用单调递增的
 * 内部 label 对应记忆 id；update = 旧 label markDelete + 新 label addPoint，
 * remove = markDelete（hnswlib 的删除本身就是墓碑语义）。
 */
import {
  prepareAnnVector,
  type AnnHit,
  type AnnItem,
  type AnnIndex,
  type AnnSearchOptions,
  type AnnStats,
} from './types.ts'

/** hnswlib-node 的实例接口（只列我们用的方法，避免硬依赖它的类型）。 */
export interface HnswlibInstanceLike {
  initIndex(maxElements?: number, M?: number, efConstruction?: number): void
  setEf(ef: number): void
  addPoint(vector: ArrayLike<number>, label: number): void
  markDelete(label: number): void
  searchKnn(query: ArrayLike<number>, k: number): { neighbors: number[]; distances: number[] }
  getCurrentCount(): number
  resizeIndex(newSize: number): void
}

export interface HnswlibModuleLike {
  HierarchicalNSW: new (metric: string, dims: number) => HnswlibInstanceLike
}

export interface HnswlibIndexOptions {
  dims: number
  M?: number
  efConstruction?: number
  efSearch?: number
  /** 初始容量（默认 20_000；超出自动 resize）。 */
  maxElements?: number
}

/** 动态 import 的 specifier 用变量：静态分析不会把可选依赖变成硬依赖。 */
const HNSWLIB_SPECIFIER = 'hnswlib-node'

interface LoadedState {
  checked: boolean
  module: HnswlibModuleLike | null
}

const loaded: LoadedState = { checked: false, module: null }

/**
 * 尝试加载 hnswlib-node；没装/编译失败/导出形状不对都返回 null（并缓存结果，
 * 不会每次查询都反复尝试 import）。测试可用 `resetHnswlibCache()` 重置。
 */
export async function loadHnswlib(): Promise<HnswlibModuleLike | null> {
  if (loaded.checked) return loaded.module
  loaded.checked = true
  try {
    const mod = (await import(HNSWLIB_SPECIFIER)) as unknown
    const resolved = ((mod as { default?: unknown } | null)?.default ?? mod) as Partial<HnswlibModuleLike> | null
    loaded.module = typeof resolved?.HierarchicalNSW === 'function' ? (resolved as HnswlibModuleLike) : null
  } catch {
    loaded.module = null
  }
  return loaded.module
}

/** 测试用：忘掉加载结果，模拟"装过/没装"的不同状态。 */
export function resetHnswlibCache(): void {
  loaded.checked = false
  loaded.module = null
}

export class HnswlibIndex implements AnnIndex {
  readonly kind = 'hnswlib' as const
  readonly dims: number
  private readonly module: HnswlibModuleLike
  private readonly M: number
  private readonly efConstruction: number
  private efSearch: number
  private maxElements: number
  private instance: HnswlibInstanceLike
  private idToLabel = new Map<string, number>()
  private labelToId: Array<string | undefined> = []
  private nextLabel = 0
  private lastBuildMs: number | undefined

  private constructor(opts: HnswlibIndexOptions, module: HnswlibModuleLike) {
    this.module = module
    this.dims = opts.dims
    this.M = Math.max(4, Math.floor(opts.M ?? 24))
    this.efConstruction = Math.max(this.M, Math.floor(opts.efConstruction ?? 200))
    this.efSearch = Math.max(1, Math.floor(opts.efSearch ?? 128))
    this.maxElements = Math.max(16, Math.floor(opts.maxElements ?? 20_000))
    this.instance = this.buildEmpty()
  }

  /**
   * 创建适配器；模块不可用时返回 null（调用方回退纯 JS 实现）。
   * `moduleOverride` 只给测试注入 fake 模块，生产路径不传。
   */
  static async create(opts: HnswlibIndexOptions, moduleOverride?: HnswlibModuleLike): Promise<HnswlibIndex | null> {
    const module = moduleOverride ?? (await loadHnswlib())
    if (!module) return null
    try {
      return new HnswlibIndex(opts, module)
    } catch {
      return null // 原生模块初始化失败：当作"不可用"，让调用方降级
    }
  }

  private buildEmpty(): HnswlibInstanceLike {
    const instance = new this.module.HierarchicalNSW('cosine', this.dims)
    instance.initIndex(this.maxElements, this.M, this.efConstruction)
    instance.setEf(this.efSearch)
    return instance
  }

  get size(): number {
    return this.idToLabel.size
  }

  build(items: readonly AnnItem[]): void {
    const started = Date.now()
    this.idToLabel.clear()
    this.labelToId = []
    this.nextLabel = 0
    this.instance = this.buildEmpty()
    for (const item of items) this.insert(item.id, item.vector)
    this.lastBuildMs = Date.now() - started
  }

  insert(id: string, vector: Float32Array): boolean {
    if (this.idToLabel.has(id)) return false
    const prepared = prepareAnnVector(vector, this.dims)
    const label = this.nextLabel
    this.ensureCapacity(label + 1)
    this.instance.addPoint(prepared, label)
    this.idToLabel.set(id, label)
    this.labelToId[label] = id
    this.nextLabel = Math.max(this.nextLabel, label + 1)
    return true
  }

  update(id: string, vector: Float32Array): boolean {
    if (!this.idToLabel.has(id)) return false
    this.removeLabel(id)
    return this.insert(id, vector)
  }

  remove(id: string): boolean {
    if (!this.idToLabel.has(id)) return false
    this.removeLabel(id)
    return true
  }

  private removeLabel(id: string): void {
    const label = this.idToLabel.get(id)
    this.idToLabel.delete(id)
    if (label === undefined) return
    try {
      this.instance.markDelete(label)
    } catch {
      /* 原生模块删除失败：索引里留下一条脏数据，比抛错给检索好 */
    }
    this.labelToId[label] = undefined
  }

  has(id: string): boolean {
    return this.idToLabel.has(id)
  }

  clear(): void {
    this.idToLabel.clear()
    this.labelToId = []
    this.nextLabel = 0
    this.instance = this.buildEmpty()
    this.lastBuildMs = undefined
  }

  search(query: Float32Array, k: number, opts?: AnnSearchOptions): AnnHit[] {
    if (k <= 0 || this.idToLabel.size === 0) return []
    const q = prepareAnnVector(query, this.dims)
    // hnswlib 的 cosine 距离 = 1 - cosine；多要几条以便过滤墓碑后仍能凑够 k。
    const wanted = Math.min(k + this.nextLabel - this.idToLabel.size, this.nextLabel)
    let outcome: { neighbors: number[]; distances: number[] }
    try {
      outcome = this.instance.searchKnn(q, Math.max(k, wanted))
    } catch {
      return []
    }
    const threshold = opts?.threshold
    const hits: AnnHit[] = []
    for (let i = 0; i < outcome.neighbors.length; i++) {
      const id = this.labelToId[outcome.neighbors[i]!]
      if (id === undefined) continue
      const score = 1 - (outcome.distances[i] ?? 1)
      if (threshold !== undefined && score < threshold) continue
      hits.push({ id, score })
      if (hits.length >= k) break
    }
    return hits
  }

  stats(): AnnStats {
    return {
      kind: this.kind,
      size: this.idToLabel.size,
      nodes: this.nextLabel,
      dims: this.dims,
      buildMs: this.lastBuildMs,
    }
  }

  /** 容量不够就 resize（hnswlib 的 resizeIndex 会保留已有点）。 */
  private ensureCapacity(needed: number): void {
    if (needed <= this.maxElements) return
    let next = Math.max(this.maxElements * 2, needed)
    if (next <= 0) next = 16
    try {
      this.instance.resizeIndex(next)
      this.maxElements = next
    } catch {
      this.maxElements = Math.max(this.maxElements, needed)
    }
  }
}
