/**
 * JSONL-backed store. One file per scope, append-on-write semantics with
 * atomic compaction (tmp + rename). Vectors live in memory for M1; the .vec
 * sidecar format arrives in M1.5.
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { dirname, join } from 'node:path'
import type { MemoryRecord, MemorySaveInput, MemoryScope } from 'dsh-memory'

export interface ScopeStoreEvents {
  onWarn?(message: string): void
}

/** 文件存在且是普通文件(目录同名时 existsSync 也为 true,这里只认文件)。 */
function fileExists(file: string): boolean {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * scope 键 → 文件名。**保持不变**(数据兼容的硬约束):
 *   global        → global.jsonl
 *   其他任意键     → projects/<sha1(key)>.jsonl
 * 哈希文件名的好处是结构上不可能路径穿越、也没有 Windows 保留名问题;代价是不可读,
 * 所以面板用 /status 的 label 字段负责展示(见 memory-panel/lib/index.js)。
 */
export function scopeFileName(scope: MemoryScope): string {  if (scope === 'global') return 'global.jsonl'
  const hash = createHash('sha1').update(scope).digest('hex')
  return join('projects', `${hash}.jsonl`)
}

/** 自定义 scope(既不是 global,也不是 project:/session: 前缀)。 */
export function isCustomScopeKey(scope: MemoryScope): boolean {
  return scope !== 'global' && !scope.startsWith('project:') && !scope.startsWith('session:')
}

/**
 * Read the first well-formed record's scope from a scope file. Project files are
 * named by hash, so this is the only way back to the scope key without the
 * provider having created that scope in this process already.
 */
export function firstScopeInFile(file: string): MemoryScope | null {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const rec = JSON.parse(trimmed) as { scope?: unknown }
      if (typeof rec.scope === 'string' && rec.scope) return rec.scope as MemoryScope
    } catch {
      // skip malformed line, keep looking
    }
  }
  return null
}

export function normalizeContent(content: string): string {
  return content.replace(/\s+/g, ' ').trim().toLowerCase()
}

export function contentHash(scope: MemoryScope, content: string): string {
  return createHash('sha1').update(`${scope}::${normalizeContent(content)}`).digest('hex')
}

export function newId(): string {
  return randomUUID()
}

// ---------------------------------------------------------------- 认知层基础类型
//
// 语义去重 / 冲突检测 / 生命周期都是**可选附加字段**：老记录缺省即可，不需要
// 迁移；读取侧一律走 generationOf() 之类的帮助函数拿缺省值，别直接读裸字段。
// 这些字段跟着记录一起进 JSONL —— 落盘/读盘对未知字段本就是透明的（readRecords
// 只校验 id/content/scope），所以老版本进程写回时也不会丢。

export interface CognitiveFields {
  /** 版本号：首版 = 1（不落盘，缺省即 1），每次语义合并 / 修正 +1。 */
  generation?: number
  /** 冲突标记：语义相似但内容不一致的旧记录 id（不删不改，只标记）。 */
  conflictWith?: string[]
  /** 冲突置信度 = 最高相似度，0..1。 */
  conflictConfidence?: number
  /** 休眠打标时间：低价值旧记忆，注入/摘要跳过，命中检索时再唤醒。 */
  dormantAt?: number
  /** 软删（tombstone）时间：forget 后保留窗口内可 restore。 */
  tombstonedAt?: number
  /** 软删保留窗口结束时间，到点后可 purge 物理删除。 */
  tombstoneExpiresAt?: number
  /** 恢复时间（唤醒 dormant / 撤销 tombstone）。 */
  restoredAt?: number
  // ── 0.33.0：记忆强度 / 有效期 / 巩固（全部可选，老记录缺省走旧逻辑）──
  /** 保持度参数：记忆"越用越牢"的稳定性（天）。FSRS 式 R(t) 计算的输入。 */
  stability?: number
  /** 难度 0..1：长文本 / 易变事实更难记，初期 stability 更低。 */
  difficulty?: number
  /** 效用 EWMA 0..1：被召回后确实被取用（memory_get / 后续引用）的反馈。 */
  utility?: number
  /** 成功取用次数。 */
  useCount?: number
  /** 最近一次被取用的时间。 */
  lastUsedAt?: number
  /** 事实有效期起点（缺省 = createdAt）。 */
  validFrom?: number
  /** 事实有效期终点：被新证据推翻时置为"失效时间"，默认检索不再返回（历史仍可查）。 */
  validUntil?: number
  /** 巩固来源：被合并进来的旧记录 id（episodic → semantic consolidation）。 */
  consolidatedFrom?: string[]
  /** 0.40.0：可疑写入隔离时间（P4 投毒防护）—— 隔离期间不进检索/注入，等人工复核。 */
  quarantinedAt?: number
  /** 隔离原因（来自 guard 的检测项，便于面板解释）。 */
  quarantineReasons?: string[]
}

export type CognitiveRecord = MemoryRecord & CognitiveFields

/** 记录版本号；老记录没有该字段 = 1。 */
export function generationOf(record: MemoryRecord): number {
  const value = (record as CognitiveRecord).generation
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1
}

/** 是否处于休眠状态（缺省 false：老记录不受影响）。 */
export function isDormantRecord(record: MemoryRecord): boolean {
  return (record as CognitiveRecord).dormantAt !== undefined
}

/** 是否已被软删（tombstone）。被软删的记录一律不参与检索/注入，等 restore 或 purge。 */
/** 0.40.0：可疑写入隔离（P4 投毒防护）。隔离记录默认不进检索/注入，但面板可见。 */
export function isQuarantinedRecord(record: MemoryRecord): boolean {
  return (record as CognitiveRecord).quarantinedAt !== undefined
}

export function isTombstonedRecord(record: MemoryRecord): boolean {
  return (record as CognitiveRecord).tombstonedAt !== undefined
}

/** 夹到 0..1；非数值 → 0（相似度/置信度这类字段的唯一边界处理）。 */
export function clamp01(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 0
  return Math.min(1, Math.max(0, n))
}

/**
 * 余弦相似度。防御性归一化：空向量 / 零向量返回 0，维度不同时按较短者算。
 * 与 scoring.cosine 同口径；认知层刻意用本地实现，避免跟检索侧的改动耦合。
 */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    const x = a[i]!
    const y = b[i]!
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** 一条相似命中（findSimilar 的返回项；record 自带 scope）。 */
export interface SimilarHit {
  record: MemoryRecord
  similarity: number
}

export interface SimilarOptions {
  /** 最多返回几条，默认 10。 */
  limit?: number
  /** 相似度下限（含），默认 0。 */
  minScore?: number
  /** 排除这些 id（比如本次要写入的记录自己）。 */
  excludeIds?: Iterable<string>
  /** 默认 false：已被 supersede 的历史版本不作为候选（合并只针对当前版本）。 */
  includeRetired?: boolean
  /** 默认 false：tombstone 软删的记录不参与相似检索。 */
  includeTombstoned?: boolean
}

/** 一对近重复记录。keepId 建议保留，mergeId 建议被它 supersede。 */
export interface DuplicatePair {
  a: string
  b: string
  similarity: number
  keepId: string
  mergeId: string
}

export interface NearDuplicateOptions {
  /** 最多返回几对，默认 100。 */
  limit?: number
  /**
   * 两两比较的记录数上限（默认 2000，与 maxRecordsPerScope 默认值一致）。
   * 超过时只比最近更新的那一批：n² 在 2000 条 × 1024 维上是秒级，不能放到热路径。
   */
  maxRecords?: number
  /** 默认 false：历史版本之间不再互相比较（它们已经退役）。 */
  includeRetired?: boolean
}

/** 谱系里的一版。 */
export interface LineageEntry {
  id: string
  generation: number
  /** 直接前驱（被它取代的老版本 id）；null = 链根。 */
  supersedes: string | null
  /** 直接后继（取代它的记录 id）；空 = 当前活动版本。 */
  supersededBy: string[]
  content: string
  createdAt: number
  updatedAt: number
  importance: number
}

/** 一条记忆的完整版本谱系（由旧到新）。 */
export interface Lineage {
  id: string
  scope: MemoryScope
  /** 链根 id（最老的版本）。 */
  rootId: string
  /** 该记录所在连通分量里的所有版本，按 generation → createdAt 升序。 */
  entries: LineageEntry[]
  /** 链尾 id（当前活动版本；历史数据分叉时取最新的一版）。 */
  currentId: string
}

// ---------------------------------------------------------------- 跨进程写锁

/** 等锁的上限:超过就告警并"不带锁照写"(宁可少一次合并,也不要丢掉这次写入)。 */
const LOCK_TIMEOUT_MS = 5_000
/** 超过这个时长没被碰过的锁视为陈旧(进程被 kill -9 时不会自己清理)。 */
const LOCK_STALE_MS = 10_000

/** 同步睡眠,不占 CPU:锁等待用(必须同步 —— flush/close 的调用方都是同步路径)。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM = 进程存在但没有权限发信号
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 锁是不是陈旧的(拥有者已死 / 太久没动)?是则删掉并返回 true。 */
function breakStaleLock(lockPath: string): boolean {
  let age: number
  try {
    age = Date.now() - statSync(lockPath).mtimeMs
  } catch {
    return true // 已经不在了,直接重试
  }
  if (age > LOCK_STALE_MS) {
    try { rmSync(lockPath, { force: true }) } catch { /* 下一轮再试 */ }
    return true
  }
  let pid = 0
  try { pid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10) } catch { pid = 0 }
  if (pid > 0 && !processAlive(pid)) {
    try { rmSync(lockPath, { force: true }) } catch { /* 下一轮再试 */ }
    return true
  }
  return false
}

/** 本进程已持有的锁(可重入:flush 持锁时会再调 writeSidecar,不能自己把自己锁死)。 */
const heldLocks = new Map<string, number>()

/**
 * 取某个 scope 的写锁(锁文件 = `${数据文件}.lock`,`openSync(wx)` 的 O_EXCL 语义)。
 *
 * 为什么需要它:`loadScope()` 只读盘一次、`flush()` 又全量重写 —— 两个进程共用一个
 * storeDir 时,后 flush 的那个会用自己那份旧快照把对方的记录整条抹掉(见 issue #3)。
 * 现在所有写都是"锁内重新读盘 → 合并增量 → 原子写",锁只是把这两步串起来。
 *
 * Windows:`openSync(wx)` 在"文件已存在、但正处于删除过程中"时报 EPERM/EACCES 而不是
 * EEXIST,所以这两个码也按"已存在"处理,否则并发下会直接崩。
 */
function withScopeLock<T>(lockPath: string, fn: () => T, onWarn?: (m: string) => void): T {
  const depth = heldLocks.get(lockPath)
  if (depth !== undefined) {
    heldLocks.set(lockPath, depth + 1)
    try {
      return fn()
    } finally {
      const left = (heldLocks.get(lockPath) ?? 1) - 1
      if (left <= 0) heldLocks.delete(lockPath)
      else heldLocks.set(lockPath, left)
    }
  }
  mkdirSync(dirname(lockPath), { recursive: true })
  let fd: number | null = null
  let delay = 2
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  while (fd === null) {
    try {
      fd = openSync(lockPath, 'wx')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      // EPERM/EACCES 只在「锁文件确实存在」时才可以当成竞争处理；否则是目录
      // 不可写、只读挂载之类的硬错误——继续重试就是死循环（原实现会 100% CPU
      // 空转到天亮）。硬错误直接抛，交给上层（flush 已逐 scope 兜住）。
      if (code === 'EEXIST' || ((code === 'EPERM' || code === 'EACCES') && existsSync(lockPath))) {
        const broke = breakStaleLock(lockPath)
        if (broke && !existsSync(lockPath)) continue // 陈旧锁已删，立即重试
        if (Date.now() >= deadline) {
          onWarn?.(`store: lock ${lockPath} timed out after ${LOCK_TIMEOUT_MS}ms; writing without it`)
          return fn()
        }
        if (!broke) {
          sleepSync(delay)
          delay = Math.min(delay * 2, 50)
        }
      } else {
        throw err
      }
    }
  }
  try { writeFileSync(fd, String(process.pid), 'utf8') } catch { /* pid 只是给接管用的提示 */ }
  heldLocks.set(lockPath, 1)
  try {
    return fn()
  } finally {
    heldLocks.delete(lockPath)
    try { closeSync(fd) } catch { /* 已经关了 */ }
    try { rmSync(lockPath, { force: true }) } catch { /* 下一次 breakStale 会兜底 */ }
  }
}

/** tmp 名带 pid + 随机后缀:两个进程并发写同一个 scope 时不会撞名破坏原子性。 */
function tmpPathFor(file: string): string {
  return `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
}

/** 原子写整个 JSONL(tmp + rename)。调用方必须持有该 scope 的锁。 */
function writeJsonlAtomic(file: string, records: Map<string, MemoryRecord>): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = tmpPathFor(file)
  const lines = [...records.values()].map((r) => JSON.stringify(r))
  writeFileSync(tmp, lines.length ? `${lines.join('\n')}\n` : '', 'utf8')
  renameSync(tmp, file)
}

/** 文件的时间戳快照,用来判断"别的进程有没有改过它"。 */
function stampOf(file: string): string {
  try {
    const st = statSync(file)
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return 'missing'
  }
}

/** 读一个 scope 文件成 Map(坏行跳过;scope 不符的行忽略,flush 时会清掉)。 */
function readRecords(file: string, scope: MemoryScope, onWarn?: (m: string) => void): Map<string, MemoryRecord> {
  const out = new Map<string, MemoryRecord>()
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') onWarn?.(`store: cannot read ${file}: ${(err as Error).message}`)
    return out
  }
  let lineNo = 0
  for (const line of text.split('\n')) {
    lineNo++
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const rec = JSON.parse(trimmed) as MemoryRecord
      if (!rec || typeof rec.id !== 'string' || typeof rec.content !== 'string' || typeof rec.scope !== 'string') {
        throw new Error('bad shape')
      }
      if (rec.scope !== scope) continue
      out.set(rec.id, rec)
    } catch {
      onWarn?.(`store: skipping malformed ${file}:${lineNo}`)
    }
  }
  return out
}

export class ScopeStore {
  readonly scope: MemoryScope
  readonly records = new Map<string, MemoryRecord>()
  readonly vectors = new Map<string, Float32Array>()
  /** ids saved while the embed backend was down; retried opportunistically. */
  readonly embedPending = new Set<string>()
  /**
   * 待落盘的**增量**(不是整份快照)。flush 时把它合并进"锁内重新读到的磁盘内容",
   * 而不是拿内存覆盖磁盘 —— 这是多个进程共用同一个 storeDir 时互不抹数据的前提。
   */
  readonly upserts = new Map<string, MemoryRecord>()
  /** 本进程删掉的 id;flush 时从磁盘内容里移除。 */
  readonly deletes = new Set<string>()
  /** true once vectors were touched since the last .vec flush. */
  vectorsDirty = false
  /** 数据文件路径(写、以及删空后移除都走它)。 */
  readonly file: string
  /** 最近一次与磁盘同步后的 `mtime:size`;用于发现别的进程改过这个 scope。 */
  stamp = ''
  /** 上次检查外部改动的时间(读路径限流用)。 */
  checkedAt = 0
  private vecFile: string
  private events: ScopeStoreEvents
  /** Embedding identity for sidecar validation; set via setVecIdentity(). */
  private vecIdentity = ''

  /** 有增量待写才算脏(只有向量变动时不脏,走 vectorsDirty)。 */
  get dirty(): boolean {
    return this.upserts.size > 0 || this.deletes.size > 0
  }

  /** 当前向量模型的维度；用于丢弃截断/错维度的边车条目。 */
  private expectedDims: number | null = null
  /** 这个 scope 的跨进程写锁(JSONL 与 .vec 共用一把,避免两边交叉覆盖)。 */
  get lockPath(): string {
    return `${this.file}.lock`
  }

  constructor(scope: MemoryScope, root: string, events: ScopeStoreEvents = {}) {
    this.scope = scope
    this.file = join(root, scopeFileName(scope))
    this.vecFile = join(root, scopeFileName(scope).replace(/\.jsonl$/, '.vec'))
    this.events = events
  }

  /**
   * Declare which model+dims produced the in-memory vectors. When it differs
   * from the sidecar header on load, the sidecar is discarded and every record
   * re-enters the embed queue — old vectors for a new model are wrong, not
   * merely stale.
   */
  setVecIdentity(model: string, dims: number, pooling?: string): void {
    this.vecIdentity = pooling !== undefined && pooling !== '' && pooling !== 'auto'
      ? `${model}\t${dims}\t${pooling}`
      : `${model}\t${dims}`
    this.expectedDims = Number.isFinite(dims) && dims > 0 ? dims : null
  }

  /**
   * 边车身份对不对。老边车只有 `model\tdims` 两段(0.10.0 之前不记 pooling),
   * 缺 pooling 时按兼容接受 —— 不能因为多记了一个字段就让所有人的向量全量作废。
   * 两边都有 pooling 时才严格比:这正是 issue #3 里那条「用错 --pooling 会静默
   * 把整份边车作废、而且 identity 校验会放行」的修法。
   */
  private identityMatches(header: string): boolean {
    if (!this.vecIdentity) return true
    if (!header) return false
    const mine = this.vecIdentity.split('\t')
    const theirs = header.split('\t')
    if (mine[0] !== theirs[0] || mine[1] !== theirs[1]) return false
    if (mine[2] !== undefined && theirs[2] !== undefined) return mine[2] === theirs[2]
    return true
  }

  get size(): number {
    return this.records.size
  }

  insert(record: MemoryRecord): void {
    this.records.set(record.id, record)
    this.upserts.set(record.id, record)
    this.deletes.delete(record.id)
  }

  remove(id: string): boolean {
    const had = this.records.delete(id)
    if (had) {
      this.vectors.delete(id)
      this.embedPending.delete(id)
      this.upserts.delete(id)
      this.deletes.add(id)
      this.vectorsDirty = true
    }
    return had
  }

  /** 合并后把缓存换成磁盘上的内容(增量已并入),清掉已落盘的那部分增量。 */
  replaceRecords(next: Map<string, MemoryRecord>): void {
    this.records.clear()
    for (const [id, rec] of next) this.records.set(id, rec)
  }

  /**
   * Delete this scope's data files(.jsonl 与 .vec 边车)。
   *
   * 只在 flush 时、且该 scope **内存里已经没有记录**的情况下调用 —— 也就是"作用域被删空了"。
   * 留一个 0 字节的 .jsonl + 只有一个身份头的 .vec 在磁盘上没有任何价值:数据已经空,
   * 而作用域本身是懒加载的(下次写同一个名字会重新创建)。global 永不适用(调用方 guard)。
   */
  removeFiles(): boolean {
    let removed = false
    for (const file of [this.file, this.vecFile]) {
      try {
        rmSync(file, { force: true })
        removed = true
      } catch (err) {
        // 删不掉不影响正确性(空文件无数据);下一次 flush 还会再试一次
        this.events.onWarn?.(`store: cannot remove ${file}: ${(err as Error).message}`)
      }
    }
    return removed
  }

  setVector(id: string, vec: Float32Array): void {
    this.vectors.set(id, vec)
    this.vectorsDirty = true
  }

  /**
   * Append a record to the sidecar: `<id> \t <base64 dim vec>` per line.
   * Vectors are written immediately on embed (single-line append) and fully
   * rewritten on delete/compact — embeddings are expensive to recompute.
   * A freshly created file starts with the `#model\tdims` identity header.
   */
  appendVector(id: string, vec: Float32Array): void {
    this.setVector(id, vec)
    try {
      mkdirSync(dirname(this.vecFile), { recursive: true })
      withScopeLock(this.lockPath, () => {
        const header = this.readHeader()
        // 缺文件 / 别人的模型 / 旧的两段头(得把 pooling 记进去)→ 整份重写
        const staleHeader = this.vecIdentity !== '' &&
          (!this.identityMatches(header) || header.split('\t').length < this.vecIdentity.split('\t').length)
        if (staleHeader) {
          this.writeSidecarLocked()
          this.vectorsDirty = false
          return
        }
        appendFileSync(this.vecFile, `${id}\t${encodeVec(vec)}\n`, 'utf8')
        this.vectorsDirty = false
      }, this.events.onWarn)
    } catch (err) {
      this.vectorsDirty = true // full rewrite on next flushVectors
      this.events.onWarn?.(`vec: append failed: ${(err as Error).message}`)
    }
  }

  /** First line of the sidecar if it is a header; '' when absent/headerless. */
  private readHeader(): string {
    if (!existsSync(this.vecFile)) return ''
    try {
      const first = readFileSync(this.vecFile, 'utf8').split('\n', 1)[0] ?? ''
      return first.startsWith('#') ? first.slice(1) : ''
    } catch {
      return ''
    }
  }

  /** Atomic full rewrite: identity header + every in-memory vector (merged with disk). */
  private writeSidecar(): void {
    withScopeLock(this.lockPath, () => this.writeSidecarLocked(), this.events.onWarn)
  }

  /** 持锁版本:先读盘上同身份的条目再合并,别的进程刚追加的向量不会被覆盖掉。 */
  private writeSidecarLocked(): void {
    mkdirSync(dirname(this.vecFile), { recursive: true })
    const lines: string[] = []
    if (this.vecIdentity) lines.push(`#${this.vecIdentity}`)
    const merged = this.readSidecarEntries()
    for (const [id, v] of this.vectors) merged.set(id, `${id}\t${encodeVec(v)}`)
    // 边车以前"只增不减"：磁盘上遗留的、属于已删除记录的条目会被原样写回，
    // 文件随着删除/重建无限增长。以当前记录集为准清理一次。
    for (const id of merged.keys()) {
      if (!this.records.has(id)) merged.delete(id)
    }
    for (const line of merged.values()) lines.push(line)
    const tmp = tmpPathFor(this.vecFile)
    writeFileSync(tmp, lines.length ? `${lines.join('\n')}\n` : '', 'utf8')
    renameSync(tmp, this.vecFile)
  }

  /**
   * 磁盘边车里"身份一致"的条目(id → 原始行)。身份不同就返回空(整份重写),
   * 没头的旧文件也不合并 —— 那些向量不属于当前模型。
   */
  private readSidecarEntries(): Map<string, string> {
    const out = new Map<string, string>()
    if (!existsSync(this.vecFile)) return out
    try {
      const text = readFileSync(this.vecFile, 'utf8')
      let sawHeader = false
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        if (trimmed.startsWith('#')) {
          sawHeader = true
          if (!this.identityMatches(trimmed.slice(1))) return new Map()
          continue
        }
        if (!sawHeader && this.vecIdentity) return new Map()
        const tab = trimmed.indexOf('\t')
        if (tab <= 0) continue
        out.set(trimmed.slice(0, tab), trimmed)
      }
    } catch {
      return new Map()
    }
    return out
  }

  /** Rewrite the whole sidecar (after deletes / compaction / append failures). */
  flushVectors(): void {
    if (!this.vectorsDirty) return
    try {
      this.writeSidecar()
      this.vectorsDirty = false
    } catch (err) {
      this.events.onWarn?.(`vec: flush failed: ${(err as Error).message}`)
    }
  }

  /**
   * Load vectors from the sidecar. The first line must be a `#model\tdims`
   * header when an identity is configured — mismatch or a legacy headerless
   * file discards the whole sidecar (re-embed). Unknown ids are skipped.
   */
  loadVectors(): void {
    if (!existsSync(this.vecFile)) return
    try {
      const text = readFileSync(this.vecFile, 'utf8')
      let sawHeader = false
      let sawData = false
      const discard = (why: string) => {
        this.events.onWarn?.(`vec: ${why}; discarding sidecar for re-embed`)
        this.vectors.clear()
        this.vectorsDirty = true
      }
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        if (trimmed.startsWith('#')) {
          if (!this.identityMatches(trimmed.slice(1))) {
            discard(`identity mismatch (${trimmed.slice(1)} != ${this.vecIdentity})`)
            return
          }
          // Loading before the identity is declared means NO validation happens
          // (the guards below are all identity-gated). That ordering bug shipped
          // once — see RestRegular/dsh-memory#1 — so make any recurrence visible.
          if (!this.vecIdentity) {
            this.events.onWarn?.(`${this.scope}: loading a vector sidecar before setVecIdentity(); its ${trimmed.slice(1)} vectors are accepted unvalidated`)
          }
          sawHeader = true
          continue
        }
        if (!sawData) {
          sawData = true
          if (this.vecIdentity && !sawHeader) {
            discard('legacy sidecar without identity header')
            return
          }
        }
        const tab = trimmed.indexOf('\t')
        if (tab <= 0) continue
        const id = trimmed.slice(0, tab)
        if (!this.records.has(id)) continue // stale vector for a deleted record
        const vec = decodeVec(trimmed.slice(tab + 1))
        if (!vec) continue
        // 进程被杀时可能留下被截断的行：base64 长度仍是 4 的倍数，decode 会"成功"，
        // 于是维度不对的向量混进余弦计算（长度不等时按较短者算，结果静默错）。
        // 身份头里就写着维度，这里必须逐条校验，不符就丢弃（下次检索会重新嵌入）。
        if (this.expectedDims !== null && vec.length !== this.expectedDims) {
          this.events.onWarn?.(`vec: 丢弃维度不符的向量 ${id}（${vec.length} != ${this.expectedDims}）`)
          continue
        }
        this.vectors.set(id, vec)
      }
    } catch (err) {
      this.events.onWarn?.(`vec: load failed: ${(err as Error).message}`)
    }
  }

  // ------------------------------------------------------------ 认知层:相似度

  /** 本 scope 里被别的记录 supersedes 指向的 id（=历史版本）。读路径，不落盘。 */
  retiredIds(): Set<string> {
    const ids = new Set<string>()
    for (const rec of this.records.values()) {
      if (typeof rec.supersedes === 'string' && rec.supersedes) ids.add(rec.supersedes)
    }
    return ids
  }

  /**
   * 在**本 scope** 内按向量找相似记录（只搜有向量的记录）。
   *
   * 读路径：不读盘、不落盘。默认排除已退役的历史版本和 tombstone 软删记录，
   * 因为合并/冲突决策只应该发生在"当前有效版本"之间。
   */
  findSimilar(vec: Float32Array, opts: SimilarOptions = {}): SimilarHit[] {
    const limit = Math.max(0, Math.floor(opts.limit ?? 10))
    const minScore = opts.minScore ?? 0
    const excluded = new Set(opts.excludeIds ?? [])
    const retired = opts.includeRetired === true ? null : this.retiredIds()
    const out: SimilarHit[] = []
    for (const [id, other] of this.vectors) {
      if (excluded.has(id)) continue
      const rec = this.records.get(id)
      if (rec === undefined) continue
      if (retired?.has(id) === true) continue
      if (opts.includeTombstoned !== true && isTombstonedRecord(rec)) continue
      const similarity = cosineSimilarity(vec, other)
      if (similarity < minScore) continue
      out.push({ record: rec, similarity })
    }
    out.sort((a, b) => b.similarity - a.similarity || a.record.id.localeCompare(b.record.id))
    return out.slice(0, limit)
  }

  /**
   * 本 scope 内的近重复对（两两比较余弦相似度，>= threshold 才算）。
   *
   * 只比较有向量、未退役、未软删的记录。`maxRecords` 防止大 scope 的 O(n²) 把
   * 维护线程卡死（默认 2000；超过时保留最近更新的那批）。
   */
  nearDuplicates(threshold = 0.92, opts: NearDuplicateOptions = {}): DuplicatePair[] {
    const limit = Math.max(0, Math.floor(opts.limit ?? 100))
    const maxRecords = Math.max(2, Math.floor(opts.maxRecords ?? 2000))
    const retired = opts.includeRetired === true ? null : this.retiredIds()
    const candidates: Array<{ id: string; rec: MemoryRecord; vec: Float32Array }> = []
    for (const [id, vec] of this.vectors) {
      const rec = this.records.get(id)
      if (rec === undefined) continue
      if (retired?.has(id) === true) continue
      if (isTombstonedRecord(rec)) continue
      candidates.push({ id, rec, vec })
    }
    candidates.sort((a, b) => b.rec.updatedAt - a.rec.updatedAt || a.id.localeCompare(b.id))
    const chosen = candidates.slice(0, maxRecords)
    const pairs: DuplicatePair[] = []
    for (let i = 0; i < chosen.length; i++) {
      for (let j = i + 1; j < chosen.length; j++) {
        const similarity = cosineSimilarity(chosen[i]!.vec, chosen[j]!.vec)
        if (similarity < threshold) continue
        const preferred = preferredVersion(chosen[i]!.rec, chosen[j]!.rec)
        pairs.push({
          a: chosen[i]!.id,
          b: chosen[j]!.id,
          similarity,
          keepId: preferred.keepId,
          mergeId: preferred.mergeId,
        })
      }
    }
    pairs.sort((a, b) => b.similarity - a.similarity || a.keepId.localeCompare(b.keepId) || a.mergeId.localeCompare(b.mergeId))
    return pairs.slice(0, limit)
  }
}

/**
 * 两条近重复记录里该保留哪条：版本号大 > 更新得更晚 > 更重要 > id 字典序（稳定）。
 * 合并计划就按这个顺序决定"谁被 supersede"。
 */
export function preferredVersion(a: MemoryRecord, b: MemoryRecord): { keepId: string; mergeId: string } {
  const byGeneration = generationOf(a) - generationOf(b)
  if (byGeneration !== 0) return byGeneration > 0 ? { keepId: a.id, mergeId: b.id } : { keepId: b.id, mergeId: a.id }
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? { keepId: a.id, mergeId: b.id } : { keepId: b.id, mergeId: a.id }
  if (a.importance !== b.importance) return a.importance > b.importance ? { keepId: a.id, mergeId: b.id } : { keepId: b.id, mergeId: a.id }
  return a.id.localeCompare(b.id) <= 0 ? { keepId: a.id, mergeId: b.id } : { keepId: b.id, mergeId: a.id }
}

// --- base64 vector codec (4 bytes per float, bit-exact) ---

function encodeVec(vec: Float32Array): string {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).toString('base64')
}

function decodeVec(text: string): Float32Array | null {
  try {
    const buf = Buffer.from(text, 'base64')
    if (buf.length === 0 || buf.length % 4 !== 0) return null
    return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4)
  } catch {
    return null
  }
}

export interface MemoryStoreEvents {
  onWarn?(message: string): void
  /**
   * 读路径多久 stat 一次磁盘看别的进程有没有改(默认 1000ms;0 = 关掉)。
   * 多进程共用同一个 storeDir 时,不 stat 就只会在重启后看到别人写的记录。
   */
  refreshTtlMs?: number
}

export class MemoryStore {
  readonly root: string
  private scopes = new Map<string, ScopeStore>()
  /** scopes whose jsonl has been loaded from disk (lazy, once per scope). */
  private loaded = new Set<string>()
  /** scope -> its jsonl filename, so reload can map files back to scopes. */
  private fileNames = new Map<MemoryScope, string>()
  /**
   * 磁盘文件名 → scope 键的索引。
   *
   * discovery 以前对每个 projects/*.jsonl 都 readFileSync 整份文件、只为拿第一行的
   * scope（7000 条实测 RSS 125MB、每 60 秒全量重读）。索引把这一步变成一次
   * 小文件读取 + readdir；未知文件才回退去读内容。
   */
  private scopeIndex = new Map<string, MemoryScope>()
  private scopeIndexLoaded = false
  private scopeIndexDirty = false
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private events: MemoryStoreEvents
  private refreshTtlMs: number
  /** `model\tdims[\tpooling]` handed to every ScopeStore for sidecar validation. */
  private vecIdentity = ''

  constructor(root: string, events: MemoryStoreEvents = {}) {
    this.root = root
    this.events = events
    this.refreshTtlMs = events.refreshTtlMs ?? 1_000
    mkdirSync(join(root, 'projects'), { recursive: true })
  }

  /** Declare the embedding identity; applies to existing and future scopes. */
  setVecIdentity(model: string, dims: number, pooling?: string): void {
    this.vecIdentity = pooling !== undefined && pooling !== '' && pooling !== 'auto'
      ? `${model}\t${dims}\t${pooling}`
      : `${model}\t${dims}`
    for (const s of this.scopes.values()) s.setVecIdentity(model, dims, pooling)
  }

  /** Preload specific scopes eagerly (e.g. defaults); others load on first access. */
  loadAll(wanted: MemoryScope[]): void {
    for (const scope of wanted) this.scope(scope)
  }

  private loadScope(scope: MemoryScope): void {
    const file = this.fileFor(scope)
    const store = this.scope(scope)
    if (!fileExists(file)) {
      store.stamp = 'missing'
      store.checkedAt = Date.now()
      return
    }
    store.replaceRecords(readRecords(file, scope, (m) => this.events.onWarn?.(m)))
    // sidecar vectors second; anything still un-embedded joins the backfill queue
    store.loadVectors()
    for (const id of store.records.keys()) {
      if (!store.vectors.has(id)) store.embedPending.add(id)
    }
    store.stamp = stampOf(file)
    store.checkedAt = Date.now()
  }

  /**
   * 别的进程可能改了同一个 scope:读路径按 refreshTtlMs 限流地 stat 一次,
   * mtime/size 变了就重新读盘(还没落盘的增量交给 flush 在锁内合并)。
   */
  private refreshFromDisk(s: ScopeStore): void {
    if (this.refreshTtlMs <= 0) return
    const now = Date.now()
    if (now - s.checkedAt < this.refreshTtlMs) return
    s.checkedAt = now
    if (s.dirty) return
    const file = this.fileFor(s.scope)
    const stamp = stampOf(file)
    if (stamp === s.stamp) return
    s.replaceRecords(stamp === 'missing' ? new Map() : readRecords(file, s.scope, (m) => this.events.onWarn?.(m)))
    s.stamp = stamp
  }

  scope(scope: MemoryScope): ScopeStore {
    let s = this.scopes.get(scope)
    if (!s) {
      s = new ScopeStore(scope, this.root, this.events)
      if (this.vecIdentity) {
        const [model, dims, pooling] = this.vecIdentity.split('\t')
        s.setVecIdentity(model!, Number(dims), pooling)
      }
      this.scopes.set(scope, s)
      this.fileNames.set(scope, scopeFileName(scope))
    }
    if (!this.loaded.has(scope)) {
      this.loaded.add(scope)
      this.loadScope(scope)
    } else {
      this.refreshFromDisk(s)
    }
    return s
  }

  /**
   * 读路径的 scope 访问:已加载就返回;**磁盘上有数据**就加载并返回;都没有则 `undefined`。
   *
   * 与 `scope()` 的区别是这里绝不创建:早先 `search`/`list`/`forget`/面板 /records 都走
   * `scope()`,于是"查一个不存在的 scope"会在内存里造出一个空 store,`allScopes()` 立刻把它
   * 算进"作用域数",后续任何一次 flush 还会给它落一个空文件。读路径必须无副作用。
   */
  peek(scope: MemoryScope): ScopeStore | undefined {
    const existing = this.scopes.get(scope)
    if (existing) {
      this.refreshFromDisk(existing)
      return existing
    }
    const file = join(this.root, scopeFileName(scope))
    if (!fileExists(file)) return undefined
    return this.scope(scope)
  }

  /** 自定义 scope 数(去重后);用于 scopes.custom.max 限额,会话/项目/global 不计入。 */
  customScopeCount(): number {
    const seen = new Set<MemoryScope>()
    for (const s of this.scopes.values()) {
      if (isCustomScopeKey(s.scope)) seen.add(s.scope)
    }
    const projDir = join(this.root, 'projects')
    if (existsSync(projDir)) {
      for (const file of readdirSync(projDir)) {
        if (!file.endsWith('.jsonl')) continue
        const scope = firstScopeInFile(join(projDir, file))
        if (scope !== null && isCustomScopeKey(scope)) seen.add(scope)
      }
    }
    return seen.size
  }

  allScopes(): ScopeStore[] {
    return [...this.scopes.values()]
  }

  /**
   * Eagerly load every scope that has data on disk and return the scope keys.
   *
   * Scopes are otherwise created lazily, so a long-lived process only knows the
   * scopes it has already touched — a management UI (the memory panel) would
   * silently miss project memories written in earlier sessions. Project files
   * are named by scope hash, so the scope key is recovered from the first
   * record inside each file.
   */
  loadDiscovered(): MemoryScope[] {
    this.ensureScopeIndex()
    const discovered: MemoryScope[] = []
    const seen = new Set<string>()
    if (existsSync(join(this.root, 'global.jsonl'))) {
      discovered.push('global')
      seen.add('global.jsonl')
      this.scopeIndex.set('global.jsonl', 'global')
    }
    const projDir = join(this.root, 'projects')
    if (existsSync(projDir)) {
      for (const file of readdirSync(projDir)) {
        if (!file.endsWith('.jsonl')) continue
        // 索引键与 scopeFileName() 一致：相对 root 的路径（含 projects/ 前缀）。
        const key = `projects/${file}`
        seen.add(key)
        let scope = this.scopeIndex.get(key)
        if (scope === undefined) {
          // 索引里没有（首次运行 / 别的进程刚写的文件）→ 才去读文件内容。
          const found = firstScopeInFile(join(projDir, file))
          if (found) {
            scope = found
            this.scopeIndex.set(key, found)
            this.scopeIndexDirty = true
          }
        }
        if (scope !== undefined) discovered.push(scope)
      }
    }
    // 清理已经被删掉的文件对应的索引项。
    for (const file of [...this.scopeIndex.keys()]) {
      if (!seen.has(file)) {
        this.scopeIndex.delete(file)
        this.scopeIndexDirty = true
      }
    }
    if (this.scopeIndexDirty) this.saveScopeIndex()
    for (const scope of discovered) this.scope(scope) // triggers lazy disk load
    return discovered
  }

  private scopeIndexFilePath(): string {
    return join(this.root, 'scopes.index.json')
  }

  private ensureScopeIndex(): void {
    if (this.scopeIndexLoaded) return
    this.scopeIndexLoaded = true
    try {
      const raw = JSON.parse(readFileSync(this.scopeIndexFilePath(), 'utf8')) as { files?: unknown }
      const files = raw.files
      if (files !== null && typeof files === 'object') {
        for (const [file, scope] of Object.entries(files as Record<string, unknown>)) {
          if (typeof scope === 'string' && scope !== '') this.scopeIndex.set(file, scope as MemoryScope)
        }
      }
    } catch { /* 首次运行 / 损坏 → 空索引，靠 readdir 重建 */ }
  }

  private saveScopeIndex(): void {
    this.scopeIndexDirty = false
    try {
      const files: Record<string, string> = {}
      for (const [file, scope] of this.scopeIndex) files[file] = scope
      const tmp = `${this.scopeIndexFilePath()}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
      writeFileSync(tmp, `${JSON.stringify({ schemaVersion: 1, files }, null, 2)}\n`, 'utf8')
      renameSync(tmp, this.scopeIndexFilePath())
    } catch { /* 索引只是加速，写失败不影响正确性 */ }
  }

  /** 写盘后登记「文件名 → scope」，让下一次 discovery 不用读文件内容。 */
  private rememberScopeFile(scope: MemoryScope): void {
    if (!this.scopeIndexLoaded) this.ensureScopeIndex()
    const file = this.fileNames.get(scope) ?? scopeFileName(scope)
    if (this.scopeIndex.get(file) !== scope) {
      this.scopeIndex.set(file, scope)
      this.scopeIndexDirty = true
      this.saveScopeIndex()
    }
  }

  private fileFor(scope: MemoryScope): string {
    return join(this.root, this.fileNames.get(scope) ?? scopeFileName(scope))
  }

  /**
   * 这个 scope 删空后能不能把文件删掉。
   * 只有 `global` 例外:它是唯一一个"永远存在"的保留作用域(所有人共享),文件不该被
   * 任何一次清空动作从磁盘上抹掉 —— 即使将来某条路径把它删空了,也只写一个空文件。
   */
  private isRemovable(scope: MemoryScope): boolean {
    return scope !== 'global'
  }

  anyDirty(): boolean {
    for (const s of this.scopes.values()) if (s.dirty) return true
    return false
  }

  /**
   * 记录一次「访问」：把更新过 accessCount / lastAccessedAt 的记录排进落盘增量。
   *
   * 不落盘的话这两个字段永远是 0 —— 而 recency（最近访问）与 accessBoost
   * （访问频率）正是检索排序的输入，召回质量会随使用慢慢偏掉。
   * 只有确实在内存里、且没被别的进程删掉的记录才会入增量。
   */
  touch(record: MemoryRecord): void {
    const s = this.scopes.get(record.scope)
    if (!s || !s.records.has(record.id)) return
    s.insert(record)
  }

  scheduleFlush(delayMs = 500): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      try {
        this.flush()
      } catch (error) {
        // 兜底：flush 内部已逐 scope 兜住，这里再防一层，保证定时器回调永不抛。
        this.events.onWarn?.(`自动 flush 失败：${(error as Error)?.message ?? String(error)}`)
      }
    }, delayMs)
    // a debounced flush must not hold the event loop open
    this.flushTimer.unref?.()
  }

  /**
   * Write the pending deltas of every dirty scope.
   *
   * 每个 scope 走一次"锁内重新读盘 → 合并增量 → 原子写":不再用内存快照整份覆盖,
   * 所以另一个进程(比如把同一个 storeDir 挂在 MCP server 上)刚写的记录不会消失。
   * 一个被删空的 scope(合并后 0 条记录)**不再落 0 字节文件**,而是把 .jsonl 与 .vec
   * 一起删掉 —— 但前提是磁盘上确实也空了(别人写的记录不算"删空")。
   * `global` 永不自动删除(见 isRemovable)。
   */
  flush(): void {
    for (const s of this.scopes.values()) {
      if (!s.dirty) continue
      // 单个 scope 写盘失败（ENOSPC / EACCES / 只读目录）绝不能冒泡：
      // flush 常常从 unref 的定时器里跑，抛出去就是 uncaught exception，
      // 宿主会当成致命错误直接退出整个 DSH。保留 dirty 与增量，下次再试。
      try {
        this.flushScope(s)
      } catch (error) {
        this.events.onWarn?.(`flush 失败（增量保留，稍后重试）：${(error as Error)?.message ?? String(error)}`)
      }
    }
    // vectors flush too: they are the expensive-to-recompute half
    for (const s of this.scopes.values()) {
      try {
        s.flushVectors()
      } catch (error) {
        this.events.onWarn?.(`vec flush 失败（稍后重试）：${(error as Error)?.message ?? String(error)}`)
      }
    }
  }

  /** 锁内合并一个 scope 的增量(同步;调用方不持有这把锁)。 */
  private flushScope(s: ScopeStore): void {
    const file = this.fileFor(s.scope)
    // 增量在等锁期间不会变(同步执行),先拷一份,锁里只做合并与写
    const upserts = new Map(s.upserts)
    const deletes = new Set(s.deletes)
    withScopeLock(s.lockPath, () => {
      const merged = fileExists(file)
        ? readRecords(file, s.scope, (m) => this.events.onWarn?.(m))
        : new Map<string, MemoryRecord>()
      for (const [id, rec] of upserts) merged.set(id, rec)
      for (const id of deletes) merged.delete(id)
      if (merged.size === 0 && this.isRemovable(s.scope)) {
        s.removeFiles()
        // 边车已经被一起删掉了;别让随后的 flushVectors 又把它写回来
        s.vectors.clear()
        s.embedPending.clear()
        s.vectorsDirty = false
      } else {
        writeJsonlAtomic(file, merged)
        this.rememberScopeFile(s.scope)
      }
      s.replaceRecords(merged)
      for (const id of upserts.keys()) s.upserts.delete(id)
      for (const id of deletes) s.deletes.delete(id)
      s.stamp = stampOf(file)
      s.checkedAt = Date.now()
    }, this.events.onWarn)
  }

  /** Synchronous final flush — call on dispose. */
  close(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.flush()
  }

  /**
   * Dedupe-aware save: identical normalized content in the scope refreshes the
   * existing record instead of duplicating it.
   */
  save(
    input: MemorySaveInput,
    defaults: { importance: number; source: MemoryRecord['source'] },
  ): { record: MemoryRecord; deduped: boolean } {
    const s = this.scope(input.scope)
    const hash = contentHash(input.scope, input.content)
    for (const rec of s.records.values()) {
      // 软删记录不能被"同内容重写"复活：否则 forget 之后一句重述就绕过了 tombstone。
      // 要恢复必须显式走 lifecycle.restore()（或重新写入并产生新 id）。
      if (isTombstonedRecord(rec)) continue
      if (contentHash(rec.scope, rec.content) === hash) {
        rec.updatedAt = Date.now()
        rec.accessCount += 1
        rec.importance = Math.max(rec.importance, input.importance ?? defaults.importance)
        // 同内容重写 = 一次访问：休眠标记顺手清掉（低价值记忆被再次确认就该醒）。
        delete (rec as CognitiveRecord).dormantAt
        if (input.supersedes) {
          rec.supersedes = input.supersedes
          const target = s.records.get(input.supersedes)
          if (target !== undefined && target.id !== rec.id) {
            // 谱系版本号只增不减：重写同一内容时也要接上被取代版本的后一位。
            rec.generation = Math.max(generationOf(rec), generationOf(target) + 1)
          }
        }
        // 同一内容重写 = 刷新状态:TLL 重新计时;显式去掉过期时间时一并清掉。
        if (input.expiredAt !== undefined) rec.expiredAt = input.expiredAt
        else delete rec.expiredAt
        // 初始化流程重试时，去重命中的旧记录也要补上 initial 来源标记。
        if ((input as MemorySaveInput & { initial?: unknown }).initial === true) {
          ;(rec as MemoryRecord & { initial?: boolean }).initial = true
        }
        // 流程触发词是可编辑元数据:重写同一条流程时跟着更新。
        const triggers = (input as MemorySaveInput & { triggers?: unknown }).triggers
        if (Array.isArray(triggers)) (rec as MemoryRecord & { triggers?: string[] }).triggers = triggers.map(String)
        s.insert(rec) // 去重命中的也是一次写:进增量,flush 时落盘
        return { record: rec, deduped: true }
      }
    }
    const now = Date.now()
    const cognitive = input as MemorySaveInput & CognitiveFields
    const explicitGeneration = typeof cognitive.generation === 'number' && Number.isFinite(cognitive.generation) && cognitive.generation >= 1
      ? Math.floor(cognitive.generation)
      : undefined
    const supersededTarget = input.supersedes !== undefined ? s.records.get(input.supersedes) : undefined
    // 版本号：显式给的优先；否则「取代某条」= 被取代者 +1；普通新记录 = 1（不落盘）。
    const generation = explicitGeneration ?? (supersededTarget !== undefined ? generationOf(supersededTarget) + 1 : 1)
    const record: MemoryRecord = {
      id: newId(),
      scope: input.scope,
      kind: input.kind,
      content: input.content,
      tags: input.tags ?? [],
      source: { ...defaults.source, ...input.source },
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
      accessCount: 0,
      importance: input.importance ?? defaults.importance,
      ...(input.supersedes ? { supersedes: input.supersedes } : {}),
      ...(generation > 1 ? { generation } : {}),
      // 冲突标记由上层（cognitive/conflict）算好后带进来；这里只负责持久化，
      // 绝不在 store 里自动判定"谁跟谁冲突"。
      ...(Array.isArray(cognitive.conflictWith) && cognitive.conflictWith.length > 0
        ? {
            conflictWith: cognitive.conflictWith.map(String),
            conflictConfidence: clamp01(cognitive.conflictConfidence ?? 0),
          }
        : {}),
      ...(input.expiredAt ? { expiredAt: input.expiredAt } : {}),
      ...(Array.isArray((input as MemorySaveInput & { triggers?: unknown }).triggers)
        ? { triggers: ((input as MemorySaveInput & { triggers?: unknown }).triggers as unknown[]).map(String) }
        : {}),
      // 0.24.0：初始化流程创建的记录带来源标记（可选字段，旧记录缺省 = 非初始）。
      ...((input as MemorySaveInput & { initial?: unknown }).initial === true ? { initial: true } : {}),
      // 0.33.0：记忆强度 / 有效期 / 巩固字段（可选；由认知层算好后带进来，store 只负责持久化）。
      ...(typeof cognitive.stability === 'number' && Number.isFinite(cognitive.stability) ? { stability: Math.max(0, cognitive.stability) } : {}),
      ...(typeof cognitive.difficulty === 'number' && Number.isFinite(cognitive.difficulty) ? { difficulty: clamp01(cognitive.difficulty) } : {}),
      ...(typeof cognitive.utility === 'number' && Number.isFinite(cognitive.utility) ? { utility: clamp01(cognitive.utility) } : {}),
      ...(typeof cognitive.useCount === 'number' && Number.isFinite(cognitive.useCount) ? { useCount: Math.max(0, Math.floor(cognitive.useCount)) } : {}),
      ...(typeof cognitive.lastUsedAt === 'number' && Number.isFinite(cognitive.lastUsedAt) ? { lastUsedAt: cognitive.lastUsedAt } : {}),
      ...(typeof cognitive.validFrom === 'number' && Number.isFinite(cognitive.validFrom) ? { validFrom: cognitive.validFrom } : {}),
      ...(typeof cognitive.validUntil === 'number' && Number.isFinite(cognitive.validUntil) ? { validUntil: cognitive.validUntil } : {}),
      ...(Array.isArray(cognitive.consolidatedFrom) && cognitive.consolidatedFrom.length > 0
        ? { consolidatedFrom: cognitive.consolidatedFrom.map(String) }
        : {}),
      ...(typeof cognitive.quarantinedAt === 'number' && Number.isFinite(cognitive.quarantinedAt)
        ? {
            quarantinedAt: cognitive.quarantinedAt,
            ...(Array.isArray(cognitive.quarantineReasons) && cognitive.quarantineReasons.length > 0
              ? { quarantineReasons: cognitive.quarantineReasons.map(String) }
              : {}),
          }
        : {}),
    }
    if (record.kind === 'state' && record.expiredAt === undefined) {
      // provider 已经按默认 TTL 算出 expiredAt;这里只兜底直接调 store 的调用方。
      record.expiredAt = now + 7 * 86_400_000
    }
    s.insert(record)
    return { record, deduped: false }
  }

  /** 该 scope 里是否已有相同内容(导入去重计数用;只读,不建文件)。 */
  hasContent(scope: MemoryScope, content: string): boolean {
    const s = this.peek(scope)
    if (!s) return false
    const hash = contentHash(scope, content)
    for (const rec of s.records.values()) {
      if (contentHash(rec.scope, rec.content) === hash) return true
    }
    return false
  }

  /** Substring match over normalized content, used by forget-by-query. */
  findIdsByQuery(scope: MemoryScope, query: string): string[] {
    // 读/删路径:用 peek,不存在的 scope 返回空,绝不创建。
    const s = this.peek(scope)
    if (!s) return []
    const needle = normalizeContent(query)
    if (!needle) return []
    const ids: string[] = []
    for (const rec of s.records.values()) {
      if (normalizeContent(rec.content).includes(needle)) ids.push(rec.id)
    }
    return ids
  }

  /**
   * Remove every expired record across scopes; returns removed ids.
   *
   * `skip` 让调用方按作用域排除（0.30.0：已归档会话作用域在归档期间冻结，
   * 过期清理不碰它们 —— 恢复会话后记忆仍在）。
   */
  purgeExpired(now = Date.now(), skip?: (scope: MemoryScope) => boolean): string[] {
    const removed: string[] = []
    for (const s of this.scopes.values()) {
      if (skip?.(s.scope)) continue
      for (const rec of [...s.records.values()]) {
        if (rec.expiredAt !== undefined && rec.expiredAt < now) {
          s.remove(rec.id)
          removed.push(rec.id)
        }
      }
    }
    return removed
  }

  /**
   * Evict lowest-ranked records until each scope is within its cap. Ranking:
   * recency (30d half-life) × importance — keep what retrieval would favor.
   *
   * `skip` 与 purgeExpired 同口径：冻结的作用域不参与容量淘汰。
   */
  enforceLimit(maxPerScope: number, now = Date.now(), skip?: (scope: MemoryScope) => boolean): string[] {
    const removed: string[] = []
    for (const s of this.scopes.values()) {
      if (skip?.(s.scope)) continue
      if (s.records.size <= maxPerScope) continue
      const ranked = [...s.records.values()]
        // 软删（墓碑）记录不参与容量淘汰：它们的保留期与"可恢复"承诺是独立的，
        // 超容量时应该淘汰活记录（或等 purgeTombstones 到期清理），不能提前把
        // 用户还没恢复的东西删掉。
        .filter((r) => !isTombstonedRecord(r))
        .map((r) => ({
          id: r.id,
          // 0.33.2：淘汰也要看"有没有用" —— 只看新鲜度 × 重要度会把经常被取用、
          // 但很久没改写的记忆淘汰掉。效用提升与排序里的权重保持一致（0.3）。
          rank: Math.pow(0.5, Math.max(0, now - r.updatedAt) / 86_400_000 / 30)
            * (0.1 + r.importance)
            * (1 + 0.3 * clamp01((r as CognitiveRecord).utility ?? 0)),
        }))
        .sort((a, b) => b.rank - a.rank)
      for (const r of ranked.slice(maxPerScope)) {
        s.remove(r.id)
        removed.push(r.id)
      }
    }
    return removed
  }

  // ------------------------------------------------------------ 认知层:相似检索

  /** 按 id 在本进程已加载的 scope 里找记录（读路径：不发现、不创建、不读盘）。 */
  findById(id: string): MemoryRecord | undefined {
    return this.scopeOf(id)?.record
  }

  /** 按 id 定位记录所在的 ScopeStore（lineage / lifecycle 需要拿到可写的 scope）。 */
  /**
   * 0.33.0：就地更新一条记录的"记忆强度"字段（stability/difficulty/utility/useCount/
   * lastUsedAt/validUntil）。认知层算好增量、这里只做持久化；不 flush，由调用方调度。
   * 返回更新后的记录；找不到 id 时返回 undefined。
   */
  updateMetrics(
    id: string,
    patch: Partial<Pick<CognitiveFields, 'stability' | 'difficulty' | 'utility' | 'useCount' | 'lastUsedAt' | 'validFrom' | 'validUntil' | 'consolidatedFrom' | 'quarantinedAt' | 'quarantineReasons'>>,
  ): MemoryRecord | undefined {
    const located = this.scopeOf(id)
    if (located === undefined) return undefined
    const record = located.record as CognitiveRecord
    const next: CognitiveRecord = { ...record }
    if (typeof patch.stability === 'number' && Number.isFinite(patch.stability)) next.stability = Math.max(0, patch.stability)
    if (typeof patch.difficulty === 'number' && Number.isFinite(patch.difficulty)) next.difficulty = clamp01(patch.difficulty)
    if (typeof patch.utility === 'number' && Number.isFinite(patch.utility)) next.utility = clamp01(patch.utility)
    if (typeof patch.useCount === 'number' && Number.isFinite(patch.useCount)) next.useCount = Math.max(0, Math.floor(patch.useCount))
    if (typeof patch.lastUsedAt === 'number' && Number.isFinite(patch.lastUsedAt)) next.lastUsedAt = patch.lastUsedAt
    if (typeof patch.validFrom === 'number' && Number.isFinite(patch.validFrom)) next.validFrom = patch.validFrom
    if (typeof patch.validUntil === 'number' && Number.isFinite(patch.validUntil)) next.validUntil = patch.validUntil
    if (Array.isArray(patch.consolidatedFrom)) next.consolidatedFrom = patch.consolidatedFrom.map(String)
    if (typeof patch.quarantinedAt === 'number' && Number.isFinite(patch.quarantinedAt)) next.quarantinedAt = patch.quarantinedAt
    if (Array.isArray(patch.quarantineReasons)) next.quarantineReasons = patch.quarantineReasons.map(String)
    located.store.insert(next)
    return next
  }

  scopeOf(id: string): { store: ScopeStore; record: MemoryRecord } | undefined {
    for (const store of this.scopes.values()) {
      const record = store.records.get(id)
      if (record !== undefined) return { store, record }
    }
    return undefined
  }

  /** 某个 scope 内的近重复对（scope 不存在/未加载 → 空；读路径不建 scope）。 */
  nearDuplicates(scope: MemoryScope, threshold = 0.92, opts: NearDuplicateOptions = {}): DuplicatePair[] {
    const store = this.peek(scope)
    return store === undefined ? [] : store.nearDuplicates(threshold, opts)
  }

  /**
   * 按向量找相似记录。`opts.scope` 缺省时扫**全部已加载** scope（需要全量时先
   * loadDiscovered()）；传单个 scope 或数组可限定作用域。结果按相似度降序。
   *
   * 只搜有向量的记录 —— 向量由嵌入层写入，没嵌入成功的记录肉眼不可比。
   */
  findSimilar(
    vec: Float32Array,
    opts: SimilarOptions & { scope?: MemoryScope | MemoryScope[]; perScope?: number } = {},
  ): SimilarHit[] {
    const limit = Math.max(0, Math.floor(opts.limit ?? 10))
    const perScope = Math.max(limit, Math.floor(opts.perScope ?? limit))
    const scopes: ScopeStore[] = []
    if (opts.scope === undefined) {
      scopes.push(...this.scopes.values())
    } else {
      for (const scope of Array.isArray(opts.scope) ? opts.scope : [opts.scope]) {
        const store = this.peek(scope) // 读路径:不存在就跳过,不创建
        if (store !== undefined) scopes.push(store)
      }
    }
    const out: SimilarHit[] = []
    for (const store of scopes) out.push(...store.findSimilar(vec, { ...opts, limit: perScope }))
    out.sort((a, b) => b.similarity - a.similarity || a.record.id.localeCompare(b.record.id))
    return out.slice(0, limit)
  }

  /**
   * 版本谱系：沿 `supersedes` 往前回溯链根，再沿"谁 supersede 了它"收集全部后代，
   * 按 generation → createdAt 由旧到新排列。历史数据成环/断链都不会死循环。
   *
   * 找不到 id（或所在 scope 未加载）→ null。
   */
  lineage(id: string): Lineage | null {
    const located = this.scopeOf(id)
    if (located === undefined) return null
    const { store, record } = located
    // 反向索引：被取代 id → 取代它的记录 id（同一 scope；supersedes 本就只在 scope 内）。
    const children = new Map<string, string[]>()
    for (const rec of store.records.values()) {
      const parent = typeof rec.supersedes === 'string' && rec.supersedes ? rec.supersedes : null
      if (parent === null) continue
      const list = children.get(parent)
      if (list === undefined) children.set(parent, [rec.id])
      else list.push(rec.id)
    }
    // 1) 往前找链根（visited 防环）
    const visited = new Set<string>()
    let rootId = record.id
    let cursor: MemoryRecord | undefined = record
    while (cursor !== undefined && !visited.has(cursor.id)) {
      visited.add(cursor.id)
      rootId = cursor.id
      const parentId = typeof cursor.supersedes === 'string' ? cursor.supersedes : undefined
      cursor = parentId !== undefined ? store.records.get(parentId) : undefined
    }
    // 2) 从链根 BFS 收集整个连通分量（含分叉）
    const component: MemoryRecord[] = []
    const seen = new Set<string>()
    const queue: string[] = [rootId]
    while (queue.length > 0) {
      const nextId = queue.shift()!
      if (seen.has(nextId)) continue
      seen.add(nextId)
      const rec = store.records.get(nextId)
      if (rec === undefined) continue
      component.push(rec)
      for (const childId of children.get(nextId) ?? []) queue.push(childId)
    }
    if (!seen.has(id)) return null
    component.sort(
      (a, b) =>
        generationOf(a) - generationOf(b) ||
        a.createdAt - b.createdAt ||
        a.id.localeCompare(b.id),
    )
    const entries: LineageEntry[] = component.map((rec) => ({
      id: rec.id,
      generation: generationOf(rec),
      supersedes: typeof rec.supersedes === 'string' && rec.supersedes ? rec.supersedes : null,
      supersededBy: [...(children.get(rec.id) ?? [])],
      content: rec.content,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      importance: rec.importance,
    }))
    return {
      id,
      scope: store.scope,
      rootId,
      entries,
      currentId: entries[entries.length - 1]!.id,
    }
  }
}
