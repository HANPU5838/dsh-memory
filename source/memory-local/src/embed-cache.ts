/**
 * 嵌入向量缓存（任务书 §2）。
 *
 * 两个独立的缓存，因为两类向量的复用模式完全不同：
 *
 *  1. **文档向量（持久）** —— 记忆正文很少变、且每次进程重启都要重新嵌入一遍
 *     全库（慢设备上 2000 条 × 数百 ms = 几十秒）。以 `(identity, contentHash)`
 *     为键落盘成 JSONL sidecar，重启后直接命中：正文没变就不该重新算。
 *     identity = model|dims|pooling，换模型时自动失效（旧向量对新模型是错的）。
 *  2. **查询向量（内存 LRU）** —— agent 循环里同一句查询经常短时间重复（工具
 *     重试、多 scope 合并、面板刷新），缓存住最后一次结果能省掉一次 HTTP +
 *     一次 CPU 嵌入。纯内存、有容量上限、不落盘。
 *
 * 可观测性：命中/未命中/写入/淘汰/损坏行/节省请求数都有计数器，
 * `hitRate` 与 `requestsSaved` 可直接进面板或基准报告。
 *
 * 约束：零运行时依赖（node:crypto + node:fs）；所有失败（磁盘满、权限、损坏
 * 文件）都只降级成"这次没缓存"，绝不阻塞检索/写入主流程。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 生成向量的模型身份：任何一项不同，旧向量都不可复用。 */
export interface EmbedIdentity {
  model: string
  dims: number
  pooling?: string
}

export interface EmbedCacheOptions {
  /** 缓存目录；缺省 = 纯内存、不落盘（无 store 目录或测试里用）。 */
  dir?: string
  identity: EmbedIdentity
  /** 文档向量持久缓存开关（默认 true）。 */
  documentCache?: boolean
  /** 查询向量 LRU 开关（默认 true）。 */
  queryCache?: boolean
  /** 文档缓存最多保留多少条（默认 20000；1024 维 ≈ 108MB 上限）。 */
  maxDocEntries?: number
  /** 查询 LRU 容量（默认 512）。 */
  maxQueryEntries?: number
  /** 落盘延迟合并窗口（默认 1000ms）。 */
  flushDelayMs?: number
  /** 告警出口（默认 console.warn）。 */
  log?: (message: string) => void
}

export interface EmbedCacheStats {
  /** 文档缓存命中次数 */
  docHits: number
  /** 文档缓存未命中次数（真正要算嵌入的次数） */
  docMisses: number
  /** 写入文档缓存的次数 */
  docWrites: number
  queryHits: number
  queryMisses: number
  queryWrites: number
  /** 磁盘上无法解析的行数（损坏文件不算失败，跳过即可） */
  corruptLines: number
  /** 因容量上限淘汰的条数 */
  evictions: number
  /** 成功落盘次数 */
  flushes: number
  /** 落盘/读取失败次数（只告警，不影响调用方） */
  persistErrors: number
}

const EMPTY_STATS = (): EmbedCacheStats => ({
  docHits: 0,
  docMisses: 0,
  docWrites: 0,
  queryHits: 0,
  queryMisses: 0,
  queryWrites: 0,
  corruptLines: 0,
  evictions: 0,
  flushes: 0,
  persistErrors: 0,
})

/** 磁盘文件格式版本。格式变更时 +1，旧文件直接被忽略。 */
const CACHE_FILE_VERSION = 'v1'
const CACHE_HEADER_PREFIX = '#dsh-memory-embed-cache'

/** 模型身份 → 稳定字符串（写进文件头，读到不一致就整文件作废）。 */
export function identityKeyOf(identity: EmbedIdentity): string {
  return `${identity.model}|${identity.dims}|${identity.pooling ?? ''}`
}

/** 内容哈希：正文级去重（同一条记录被保存/编辑前后完全相同 → 不该重算）。 */
export function contentHashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * 文档缓存的键 = sha256(identityKey \0 contentHash)。
 * identity 进键里，即便同一个文件被换模型复用也不会串味（双保险）。
 */
export function embedCacheKey(identityKey: string, contentHash: string): string {
  return createHash('sha256').update(identityKey).update('\u0000').update(contentHash).digest('hex')
}

/** Float32Array ↔ base64（bit-exact，4 bytes/float）。 */
function encodeVector(vector: Float32Array): string {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64')
}

function decodeVector(text: string, dims: number): Float32Array | null {
  let buf: Buffer
  try {
    buf = Buffer.from(text, 'base64')
  } catch {
    return null
  }
  if (buf.byteLength !== dims * 4) return null
  // 必须拷贝：Buffer 的内存池是共享的，直接 view 会随 GC 变化。
  const copy = new Float32Array(dims)
  for (let i = 0; i < dims; i++) copy[i] = buf.readFloatLE(i * 4)
  return copy
}

/**
 * 嵌入向量缓存。生命周期与 store 同寿：构造时读盘，写入后延迟合并落盘，
 * 退出时 `flushSync()`（或 `dispose()`）。
 */
export class EmbedCache {
  private readonly opts: EmbedCacheOptions
  private identity: EmbedIdentity
  private identityKey: string
  private dir: string | undefined
  private file: string | undefined
  private docs = new Map<string, Float32Array>()
  private queries = new Map<string, Float32Array>()
  private stats: EmbedCacheStats = EMPTY_STATS()
  private dirty = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastWarnAt = 0

  constructor(opts: EmbedCacheOptions) {
    this.opts = opts
    this.identity = { ...opts.identity }
    this.identityKey = identityKeyOf(this.identity)
    if (opts.dir !== undefined && opts.documentCache !== false) {
      this.dir = opts.dir
      this.file = join(opts.dir, 'embed-cache.jsonl')
      this.load()
    }
  }

  // --- 基本属性 -----------------------------------------------------------

  get identityInfo(): EmbedIdentity {
    return { ...this.identity }
  }

  /** 持久缓存文件路径（不持久化时为 undefined，测试用）。 */
  get filePath(): string | undefined {
    return this.file
  }

  get documentCacheEnabled(): boolean {
    return this.opts.documentCache !== false
  }

  get queryCacheEnabled(): boolean {
    return this.opts.queryCache !== false
  }

  get documentCount(): number {
    return this.docs.size
  }

  get queryCount(): number {
    return this.queries.size
  }

  get statsSnapshot(): EmbedCacheStats {
    return { ...this.stats }
  }

  /** 总命中率 0..1（没有任何查询时返回 0）。 */
  get hitRate(): number {
    const lookups = this.stats.docHits + this.stats.docMisses + this.stats.queryHits + this.stats.queryMisses
    if (lookups === 0) return 0
    return (this.stats.docHits + this.stats.queryHits) / lookups
  }

  /** 一共省掉了多少次嵌入计算（= 命中次数，文档 + 查询）。 */
  get requestsSaved(): number {
    return this.stats.docHits + this.stats.queryHits
  }

  resetStats(): void {
    this.stats = EMPTY_STATS()
  }

  // --- 文档向量（持久） ---------------------------------------------------

  /** 查文档向量；未命中返回 null（同时记一次 miss）。 */
  getDocument(text: string): Float32Array | null {
    if (!this.documentCacheEnabled) return null
    const key = this.keyFor(text)
    const hit = this.docs.get(key)
    if (hit === undefined) {
      this.stats.docMisses += 1
      return null
    }
    this.stats.docHits += 1
    return hit
  }

  hasDocument(text: string): boolean {
    return this.documentCacheEnabled && this.docs.has(this.keyFor(text))
  }

  /** 写入文档向量（按 contentHash 去重，超容量 FIFO 淘汰）。 */
  putDocument(text: string, vector: Float32Array): void {
    if (!this.documentCacheEnabled) return
    this.putDocumentByHash(contentHashOf(text), vector)
  }

  private putDocumentByHash(contentHash: string, vector: Float32Array): void {
    const key = embedCacheKey(this.identityKey, contentHash)
    if (vector.length !== this.identity.dims) return // 维度不符：宁可不缓存也不污染
    this.docs.set(key, vector)
    this.stats.docWrites += 1
    const cap = Math.max(1, this.opts.maxDocEntries ?? 20_000)
    while (this.docs.size > cap) {
      const oldest = this.docs.keys().next().value
      if (oldest === undefined) break
      this.docs.delete(oldest)
      this.stats.evictions += 1
    }
    this.dirty = true
    this.scheduleFlush()
  }

  /** 直接按预先算好的内容哈希查（批量写路径上哈希只算一次）。 */
  getDocumentByHash(contentHash: string): Float32Array | null {
    if (!this.documentCacheEnabled) return null
    const hit = this.docs.get(embedCacheKey(this.identityKey, contentHash))
    if (hit === undefined) {
      this.stats.docMisses += 1
      return null
    }
    this.stats.docHits += 1
    return hit
  }

  // --- 查询向量（内存 LRU） ----------------------------------------------

  getQuery(text: string): Float32Array | null {
    if (!this.queryCacheEnabled) return null
    const hit = this.queries.get(text)
    if (hit === undefined) {
      this.stats.queryMisses += 1
      return null
    }
    // LRU：命中后重新插入到末尾。
    this.queries.delete(text)
    this.queries.set(text, hit)
    this.stats.queryHits += 1
    return hit
  }

  putQuery(text: string, vector: Float32Array): void {
    if (!this.queryCacheEnabled) return
    if (vector.length !== this.identity.dims) return
    // 重复写也按"最新一次"算：先删后插保证 LRU 顺序。
    this.queries.delete(text)
    this.queries.set(text, vector)
    this.stats.queryWrites += 1
    const cap = Math.max(1, this.opts.maxQueryEntries ?? 512)
    while (this.queries.size > cap) {
      const oldest = this.queries.keys().next().value
      if (oldest === undefined) break
      this.queries.delete(oldest)
      this.stats.evictions += 1
    }
  }

  // --- 身份 / 生命周期 ----------------------------------------------------

  /**
   * 换模型：identity 变了，旧向量全部失效并清空（磁盘文件在下次落盘时重写）。
   * 返回是否真的发生了变化。
   */
  setIdentity(identity: EmbedIdentity): boolean {
    const nextKey = identityKeyOf(identity)
    if (nextKey === this.identityKey) return false
    this.identity = { ...identity }
    this.identityKey = nextKey
    this.docs.clear()
    this.queries.clear()
    this.dirty = true
    this.scheduleFlush()
    return true
  }

  /** 清空全部缓存（下一次落盘写一个只有文件头的空文件）。 */
  clear(): void {
    this.docs.clear()
    this.queries.clear()
    this.dirty = true
    this.scheduleFlush()
  }

  private keyFor(text: string): string {
    return embedCacheKey(this.identityKey, contentHashOf(text))
  }

  // --- 持久化 -------------------------------------------------------------

  private warn(message: string): void {
    const now = Date.now()
    if (now - this.lastWarnAt < 60_000) return
    this.lastWarnAt = now
    ;(this.opts.log ?? ((text: string) => console.warn(`[dsh-memory-local] ${text}`)))(message)
  }

  private load(): void {
    if (this.file === undefined) return
    let raw: string
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch {
      return // 首次运行：没有文件不是错误
    }
    const lines = raw.split('\n')
    const header = lines[0]?.split('\t') ?? []
    const identityMatches = header[0] === CACHE_HEADER_PREFIX
      && header[1] === CACHE_FILE_VERSION
      && header[2] === this.identityKey
      && header[3] === String(this.identity.dims)
    if (!identityMatches) {
      // 模型/格式变了：旧缓存整份作废（不删文件，下次落盘覆盖）。
      return
    }
    const cap = Math.max(1, this.opts.maxDocEntries ?? 20_000)
    let loaded = 0
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!
      if (line === '') continue
      const tab = line.indexOf('\t')
      if (tab <= 0) {
        this.stats.corruptLines += 1
        continue
      }
      const vector = decodeVector(line.slice(tab + 1), this.identity.dims)
      if (vector === null) {
        this.stats.corruptLines += 1
        continue
      }
      this.docs.set(line.slice(0, tab), vector)
      loaded += 1
    }
    // 文件里可能超过当前上限（上限调小过）：保留最后写入的 cap 条。
    while (this.docs.size > cap) {
      const oldest = this.docs.keys().next().value
      if (oldest === undefined) break
      this.docs.delete(oldest)
    }
    if (loaded > cap) this.dirty = true
  }

  /** 延迟合并落盘：写入路径上只标脏，避免每次保存都同步写几百 KB。 */
  scheduleFlush(): void {
    if (this.file === undefined || this.timer !== null) return
    const delay = Math.max(1, this.opts.flushDelayMs ?? 1000)
    const timer = setTimeout(() => {
      this.timer = null
      this.flushSync()
    }, delay)
    timer.unref?.()
    this.timer = timer
  }

  /**
   * 立即落盘（同步、原子写：先写 .tmp 再 rename）。
   * 退出/测试里调用；错误只告警不抛。
   */
  flushSync(): void {
    if (this.file === undefined || !this.dirty) return
    const file = this.file
    const tmp = `${file}.tmp`
    const lines: string[] = [`${CACHE_HEADER_PREFIX}\t${CACHE_FILE_VERSION}\t${this.identityKey}\t${this.identity.dims}`]
    for (const [key, vector] of this.docs) lines.push(`${key}\t${encodeVector(vector)}`)
    try {
      mkdirSync(this.dir!, { recursive: true })
      writeFileSync(tmp, lines.join('\n') + '\n', 'utf8')
      renameSync(tmp, file)
      this.dirty = false
      this.stats.flushes += 1
    } catch (error) {
      this.stats.persistErrors += 1
      this.warn(`嵌入缓存落盘失败（${file}）：${(error as Error)?.message ?? String(error)}`)
    }
  }

  /** 停止定时器并落盘。 */
  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.flushSync()
  }
}

// ---------------------------------------------------------------------------
// 批量 + 缓存组合：把「缓存命中」和「一次批量请求」拼起来
// ---------------------------------------------------------------------------

/** 底层批量嵌入实现（EmbedClient.embedBatch 的同形函数）。 */
export type BatchEmbedFn = (
  texts: string[],
  signal?: AbortSignal,
  opts?: { timeoutMs?: number },
) => Promise<Array<Float32Array | null> | null>

export interface CachedEmbedderOptions {
  cache: EmbedCache
  batch: BatchEmbedFn
}

/**
 * 带缓存的批量嵌入器：
 *   - 先逐条查缓存，只有 miss 的才拼成一次批量请求（命中率高时请求数骤降）；
 *   - 成功的向量回写缓存（文档进持久缓存，查询进 LRU）；
 *   - 单条失败保持 null，不拖累同批其它结果（交给回填队列重试）。
 *
 * 注意：调用方负责加 query/document 前缀（缓存键就是最终送嵌入的文本）。
 */
export class CachedEmbedder {
  private readonly cache: EmbedCache
  private readonly batch: BatchEmbedFn

  constructor(opts: CachedEmbedderOptions) {
    this.cache = opts.cache
    this.batch = opts.batch
  }

  /** 批量嵌入"文档"（正文），走持久缓存。 */
  async embedDocuments(
    texts: string[],
    signal?: AbortSignal,
    opts?: { timeoutMs?: number },
  ): Promise<Array<Float32Array | null> | null> {
    return this.embedWith(texts, signal, opts, true)
  }

  /** 批量嵌入"查询"，走内存 LRU。 */
  async embedQueries(
    texts: string[],
    signal?: AbortSignal,
    opts?: { timeoutMs?: number },
  ): Promise<Array<Float32Array | null> | null> {
    return this.embedWith(texts, signal, opts, false)
  }

  private async embedWith(
    texts: string[],
    signal: AbortSignal | undefined,
    opts: { timeoutMs?: number } | undefined,
    documents: boolean,
  ): Promise<Array<Float32Array | null> | null> {
    if (texts.length === 0) return []
    const out: Array<Float32Array | null> = new Array(texts.length).fill(null)
    const miss: number[] = []
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i]!
      const hit = documents ? this.cache.getDocument(text) : this.cache.getQuery(text)
      if (hit === null) miss.push(i)
      else out[i] = hit
    }
    if (miss.length === 0) return out
    const vectors = await this.batch(miss.map((i) => texts[i]!), signal, opts)
    if (vectors === null) return null
    for (let j = 0; j < miss.length; j++) {
      const vector = vectors[j]
      if (vector === null || vector === undefined) continue
      const index = miss[j]!
      out[index] = vector
      if (documents) this.cache.putDocument(texts[index]!, vector)
      else this.cache.putQuery(texts[index]!, vector)
    }
    return out
  }
}
