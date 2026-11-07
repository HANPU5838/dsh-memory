/**
 * JSONL-backed store. One file per scope, append-on-write semantics with
 * atomic compaction (tmp + rename). Vectors live in memory for M1; the .vec
 * sidecar format arrives in M1.5.
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { dirname, join } from 'node:path'
                                                                            

                                   
                                
 

/** 文件存在且是普通文件(目录同名时 existsSync 也为 true,这里只认文件)。 */
function fileExists(file        )          {
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
export function scopeFileName(scope             )         {  if (scope === 'global') return 'global.jsonl'
  const hash = createHash('sha1').update(scope).digest('hex')
  return join('projects', `${hash}.jsonl`)
}

/** 自定义 scope(既不是 global,也不是 project:/session: 前缀)。 */
export function isCustomScopeKey(scope             )          {
  return scope !== 'global' && !scope.startsWith('project:') && !scope.startsWith('session:')
}

/**
 * Read the first well-formed record's scope from a scope file. Project files are
 * named by hash, so this is the only way back to the scope key without the
 * provider having created that scope in this process already.
 */
export function firstScopeInFile(file        )                     {
  let text        
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const rec = JSON.parse(trimmed)                       
      if (typeof rec.scope === 'string' && rec.scope) return rec.scope               
    } catch {
      // skip malformed line, keep looking
    }
  }
  return null
}

export function normalizeContent(content        )         {
  return content.replace(/\s+/g, ' ').trim().toLowerCase()
}

export function contentHash(scope             , content        )         {
  return createHash('sha1').update(`${scope}::${normalizeContent(content)}`).digest('hex')
}

export function newId()         {
  return randomUUID()
}

// ---------------------------------------------------------------- 跨进程写锁

/** 等锁的上限:超过就告警并"不带锁照写"(宁可少一次合并,也不要丢掉这次写入)。 */
const LOCK_TIMEOUT_MS = 5_000
/** 超过这个时长没被碰过的锁视为陈旧(进程被 kill -9 时不会自己清理)。 */
const LOCK_STALE_MS = 10_000

/** 同步睡眠,不占 CPU:锁等待用(必须同步 —— flush/close 的调用方都是同步路径)。 */
function sleepSync(ms        )       {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function processAlive(pid        )          {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM = 进程存在但没有权限发信号
    return (err                         ).code === 'EPERM'
  }
}

/** 锁是不是陈旧的(拥有者已死 / 太久没动)?是则删掉并返回 true。 */
function breakStaleLock(lockPath        )          {
  let age        
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
const heldLocks = new Map                ()

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
function withScopeLock   (lockPath        , fn         , onWarn                      )    {
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
  let fd                = null
  let delay = 2
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  while (fd === null) {
    try {
      fd = openSync(lockPath, 'wx')
    } catch (err) {
      const code = (err                         ).code
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
function tmpPathFor(file        )         {
  return `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
}

/** 原子写整个 JSONL(tmp + rename)。调用方必须持有该 scope 的锁。 */
function writeJsonlAtomic(file        , records                           )       {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = tmpPathFor(file)
  const lines = [...records.values()].map((r) => JSON.stringify(r))
  writeFileSync(tmp, lines.length ? `${lines.join('\n')}\n` : '', 'utf8')
  renameSync(tmp, file)
}

/** 文件的时间戳快照,用来判断"别的进程有没有改过它"。 */
function stampOf(file        )         {
  try {
    const st = statSync(file)
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return 'missing'
  }
}

/** 读一个 scope 文件成 Map(坏行跳过;scope 不符的行忽略,flush 时会清掉)。 */
function readRecords(file        , scope             , onWarn                      )                            {
  const out = new Map                      ()
  let text        
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    if ((err                         ).code !== 'ENOENT') onWarn?.(`store: cannot read ${file}: ${(err         ).message}`)
    return out
  }
  let lineNo = 0
  for (const line of text.split('\n')) {
    lineNo++
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const rec = JSON.parse(trimmed)                
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
           scope             
           records = new Map                      ()
           vectors = new Map                      ()
  /** ids saved while the embed backend was down; retried opportunistically. */
           embedPending = new Set        ()
  /**
   * 待落盘的**增量**(不是整份快照)。flush 时把它合并进"锁内重新读到的磁盘内容",
   * 而不是拿内存覆盖磁盘 —— 这是多个进程共用同一个 storeDir 时互不抹数据的前提。
   */
           upserts = new Map                      ()
  /** 本进程删掉的 id;flush 时从磁盘内容里移除。 */
           deletes = new Set        ()
  /** true once vectors were touched since the last .vec flush. */
  vectorsDirty = false
  /** 数据文件路径(写、以及删空后移除都走它)。 */
           file        
  /** 最近一次与磁盘同步后的 `mtime:size`;用于发现别的进程改过这个 scope。 */
  stamp = ''
  /** 上次检查外部改动的时间(读路径限流用)。 */
  checkedAt = 0
          vecFile        
          events                  
  /** Embedding identity for sidecar validation; set via setVecIdentity(). */
          vecIdentity = ''

  /** 有增量待写才算脏(只有向量变动时不脏,走 vectorsDirty)。 */
  get dirty()          {
    return this.upserts.size > 0 || this.deletes.size > 0
  }

  /** 当前向量模型的维度；用于丢弃截断/错维度的边车条目。 */
          expectedDims                = null
  /** 这个 scope 的跨进程写锁(JSONL 与 .vec 共用一把,避免两边交叉覆盖)。 */
  get lockPath()         {
    return `${this.file}.lock`
  }

  constructor(scope             , root        , events                   = {}) {
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
  setVecIdentity(model        , dims        , pooling         )       {
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
          identityMatches(header        )          {
    if (!this.vecIdentity) return true
    if (!header) return false
    const mine = this.vecIdentity.split('\t')
    const theirs = header.split('\t')
    if (mine[0] !== theirs[0] || mine[1] !== theirs[1]) return false
    if (mine[2] !== undefined && theirs[2] !== undefined) return mine[2] === theirs[2]
    return true
  }

  get size()         {
    return this.records.size
  }

  insert(record              )       {
    this.records.set(record.id, record)
    this.upserts.set(record.id, record)
    this.deletes.delete(record.id)
  }

  remove(id        )          {
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
  replaceRecords(next                           )       {
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
  removeFiles()          {
    let removed = false
    for (const file of [this.file, this.vecFile]) {
      try {
        rmSync(file, { force: true })
        removed = true
      } catch (err) {
        // 删不掉不影响正确性(空文件无数据);下一次 flush 还会再试一次
        this.events.onWarn?.(`store: cannot remove ${file}: ${(err         ).message}`)
      }
    }
    return removed
  }

  setVector(id        , vec              )       {
    this.vectors.set(id, vec)
    this.vectorsDirty = true
  }

  /**
   * Append a record to the sidecar: `<id> \t <base64 dim vec>` per line.
   * Vectors are written immediately on embed (single-line append) and fully
   * rewritten on delete/compact — embeddings are expensive to recompute.
   * A freshly created file starts with the `#model\tdims` identity header.
   */
  appendVector(id        , vec              )       {
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
      this.events.onWarn?.(`vec: append failed: ${(err         ).message}`)
    }
  }

  /** First line of the sidecar if it is a header; '' when absent/headerless. */
          readHeader()         {
    if (!existsSync(this.vecFile)) return ''
    try {
      const first = readFileSync(this.vecFile, 'utf8').split('\n', 1)[0] ?? ''
      return first.startsWith('#') ? first.slice(1) : ''
    } catch {
      return ''
    }
  }

  /** Atomic full rewrite: identity header + every in-memory vector (merged with disk). */
          writeSidecar()       {
    withScopeLock(this.lockPath, () => this.writeSidecarLocked(), this.events.onWarn)
  }

  /** 持锁版本:先读盘上同身份的条目再合并,别的进程刚追加的向量不会被覆盖掉。 */
          writeSidecarLocked()       {
    mkdirSync(dirname(this.vecFile), { recursive: true })
    const lines           = []
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
          readSidecarEntries()                      {
    const out = new Map                ()
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
  flushVectors()       {
    if (!this.vectorsDirty) return
    try {
      this.writeSidecar()
      this.vectorsDirty = false
    } catch (err) {
      this.events.onWarn?.(`vec: flush failed: ${(err         ).message}`)
    }
  }

  /**
   * Load vectors from the sidecar. The first line must be a `#model\tdims`
   * header when an identity is configured — mismatch or a legacy headerless
   * file discards the whole sidecar (re-embed). Unknown ids are skipped.
   */
  loadVectors()       {
    if (!existsSync(this.vecFile)) return
    try {
      const text = readFileSync(this.vecFile, 'utf8')
      let sawHeader = false
      let sawData = false
      const discard = (why        ) => {
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
      this.events.onWarn?.(`vec: load failed: ${(err         ).message}`)
    }
  }
}

// --- base64 vector codec (4 bytes per float, bit-exact) ---

function encodeVec(vec              )         {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).toString('base64')
}

function decodeVec(text        )                      {
  try {
    const buf = Buffer.from(text, 'base64')
    if (buf.length === 0 || buf.length % 4 !== 0) return null
    return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4)
  } catch {
    return null
  }
}

                                    
                                
     
                                                
                                                
     
                       
 

export class MemoryStore {
           root        
          scopes = new Map                    ()
  /** scopes whose jsonl has been loaded from disk (lazy, once per scope). */
          loaded = new Set        ()
  /** scope -> its jsonl filename, so reload can map files back to scopes. */
          fileNames = new Map                     ()
          flushTimer                                       = null
          events                   
          refreshTtlMs        
  /** `model\tdims[\tpooling]` handed to every ScopeStore for sidecar validation. */
          vecIdentity = ''

  constructor(root        , events                    = {}) {
    this.root = root
    this.events = events
    this.refreshTtlMs = events.refreshTtlMs ?? 1_000
    mkdirSync(join(root, 'projects'), { recursive: true })
  }

  /** Declare the embedding identity; applies to existing and future scopes. */
  setVecIdentity(model        , dims        , pooling         )       {
    this.vecIdentity = pooling !== undefined && pooling !== '' && pooling !== 'auto'
      ? `${model}\t${dims}\t${pooling}`
      : `${model}\t${dims}`
    for (const s of this.scopes.values()) s.setVecIdentity(model, dims, pooling)
  }

  /** Preload specific scopes eagerly (e.g. defaults); others load on first access. */
  loadAll(wanted               )       {
    for (const scope of wanted) this.scope(scope)
  }

          loadScope(scope             )       {
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
          refreshFromDisk(s            )       {
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

  scope(scope             )             {
    let s = this.scopes.get(scope)
    if (!s) {
      s = new ScopeStore(scope, this.root, this.events)
      if (this.vecIdentity) {
        const [model, dims, pooling] = this.vecIdentity.split('\t')
        s.setVecIdentity(model , Number(dims), pooling)
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
  peek(scope             )                         {
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
  customScopeCount()         {
    const seen = new Set             ()
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

  allScopes()               {
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
  loadDiscovered()                {
    const discovered                = []
    if (existsSync(join(this.root, 'global.jsonl'))) discovered.push('global')
    const projDir = join(this.root, 'projects')
    if (existsSync(projDir)) {
      for (const file of readdirSync(projDir)) {
        if (!file.endsWith('.jsonl')) continue
        const scope = firstScopeInFile(join(projDir, file))
        if (scope) discovered.push(scope)
      }
    }
    for (const scope of discovered) this.scope(scope) // triggers lazy disk load
    return discovered
  }

          fileFor(scope             )         {
    return join(this.root, this.fileNames.get(scope) ?? scopeFileName(scope))
  }

  /**
   * 这个 scope 删空后能不能把文件删掉。
   * 只有 `global` 例外:它是唯一一个"永远存在"的保留作用域(所有人共享),文件不该被
   * 任何一次清空动作从磁盘上抹掉 —— 即使将来某条路径把它删空了,也只写一个空文件。
   */
          isRemovable(scope             )          {
    return scope !== 'global'
  }

  anyDirty()          {
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
  touch(record              )       {
    const s = this.scopes.get(record.scope)
    if (!s || !s.records.has(record.id)) return
    s.insert(record)
  }

  scheduleFlush(delayMs = 500)       {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      try {
        this.flush()
      } catch (error) {
        // 兜底：flush 内部已逐 scope 兜住，这里再防一层，保证定时器回调永不抛。
        this.events.onWarn?.(`自动 flush 失败：${(error         )?.message ?? String(error)}`)
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
  flush()       {
    for (const s of this.scopes.values()) {
      if (!s.dirty) continue
      // 单个 scope 写盘失败（ENOSPC / EACCES / 只读目录）绝不能冒泡：
      // flush 常常从 unref 的定时器里跑，抛出去就是 uncaught exception，
      // 宿主会当成致命错误直接退出整个 DSH。保留 dirty 与增量，下次再试。
      try {
        this.flushScope(s)
      } catch (error) {
        this.events.onWarn?.(`flush 失败（增量保留，稍后重试）：${(error         )?.message ?? String(error)}`)
      }
    }
    // vectors flush too: they are the expensive-to-recompute half
    for (const s of this.scopes.values()) {
      try {
        s.flushVectors()
      } catch (error) {
        this.events.onWarn?.(`vec flush 失败（稍后重试）：${(error         )?.message ?? String(error)}`)
      }
    }
  }

  /** 锁内合并一个 scope 的增量(同步;调用方不持有这把锁)。 */
          flushScope(s            )       {
    const file = this.fileFor(s.scope)
    // 增量在等锁期间不会变(同步执行),先拷一份,锁里只做合并与写
    const upserts = new Map(s.upserts)
    const deletes = new Set(s.deletes)
    withScopeLock(s.lockPath, () => {
      const merged = fileExists(file)
        ? readRecords(file, s.scope, (m) => this.events.onWarn?.(m))
        : new Map                      ()
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
      }
      s.replaceRecords(merged)
      for (const id of upserts.keys()) s.upserts.delete(id)
      for (const id of deletes) s.deletes.delete(id)
      s.stamp = stampOf(file)
      s.checkedAt = Date.now()
    }, this.events.onWarn)
  }

  /** Synchronous final flush — call on dispose. */
  close()       {
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
    input                 ,
    defaults                                                        ,
  )                                             {
    const s = this.scope(input.scope)
    const hash = contentHash(input.scope, input.content)
    for (const rec of s.records.values()) {
      if (contentHash(rec.scope, rec.content) === hash) {
        rec.updatedAt = Date.now()
        rec.accessCount += 1
        rec.importance = Math.max(rec.importance, input.importance ?? defaults.importance)
        if (input.supersedes) rec.supersedes = input.supersedes
        // 同一内容重写 = 刷新状态:TLL 重新计时;显式去掉过期时间时一并清掉。
        if (input.expiredAt !== undefined) rec.expiredAt = input.expiredAt
        else delete rec.expiredAt
        // 初始化流程重试时，去重命中的旧记录也要补上 initial 来源标记。
        if ((input                                           ).initial === true) {
          ;(rec                                        ).initial = true
        }
        // 流程触发词是可编辑元数据:重写同一条流程时跟着更新。
        const triggers = (input                                            ).triggers
        if (Array.isArray(triggers)) (rec                                          ).triggers = triggers.map(String)
        s.insert(rec) // 去重命中的也是一次写:进增量,flush 时落盘
        return { record: rec, deduped: true }
      }
    }
    const now = Date.now()
    const record               = {
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
      ...(input.expiredAt ? { expiredAt: input.expiredAt } : {}),
      ...(Array.isArray((input                                            ).triggers)
        ? { triggers: ((input                                            ).triggers             ).map(String) }
        : {}),
      // 0.24.0：初始化流程创建的记录带来源标记（可选字段，旧记录缺省 = 非初始）。
      ...((input                                           ).initial === true ? { initial: true } : {}),
    }
    if (record.kind === 'state' && record.expiredAt === undefined) {
      // provider 已经按默认 TTL 算出 expiredAt;这里只兜底直接调 store 的调用方。
      record.expiredAt = now + 7 * 86_400_000
    }
    s.insert(record)
    return { record, deduped: false }
  }

  /** 该 scope 里是否已有相同内容(导入去重计数用;只读,不建文件)。 */
  hasContent(scope             , content        )          {
    const s = this.peek(scope)
    if (!s) return false
    const hash = contentHash(scope, content)
    for (const rec of s.records.values()) {
      if (contentHash(rec.scope, rec.content) === hash) return true
    }
    return false
  }

  /** Substring match over normalized content, used by forget-by-query. */
  findIdsByQuery(scope             , query        )           {
    // 读/删路径:用 peek,不存在的 scope 返回空,绝不创建。
    const s = this.peek(scope)
    if (!s) return []
    const needle = normalizeContent(query)
    if (!needle) return []
    const ids           = []
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
  purgeExpired(now = Date.now(), skip                                  )           {
    const removed           = []
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
  enforceLimit(maxPerScope        , now = Date.now(), skip                                  )           {
    const removed           = []
    for (const s of this.scopes.values()) {
      if (skip?.(s.scope)) continue
      if (s.records.size <= maxPerScope) continue
      const ranked = [...s.records.values()]
        .map((r) => ({
          id: r.id,
          rank: Math.pow(0.5, Math.max(0, now - r.updatedAt) / 86_400_000 / 30) * (0.1 + r.importance),
        }))
        .sort((a, b) => b.rank - a.rank)
      for (const r of ranked.slice(maxPerScope)) {
        s.remove(r.id)
        removed.push(r.id)
      }
    }
    return removed
  }
}


//# sourceURL=source/memory-local/src/store.ts