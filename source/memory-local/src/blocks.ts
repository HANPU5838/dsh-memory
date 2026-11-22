/**
 * 「屏蔽」持久化（0.32.0）。
 *
 * Agent 可以主动把**与当前任务无关**的记忆屏蔽掉，让它们不再进入检索、注入与
 * 目录统计。屏蔽与「归档」「可见域」是三件不同的事：
 *
 *   - 归档（0.30.0）是**宿主生命周期**事实：会话被归档 / 工作区被移除，记忆冻结，
 *     恢复后自动复原，没有审批路径；
 *   - 可见域（0.19.0+）是**用户**设定的读写边界：范围外要靠审批放行；
 *   - 屏蔽是本条记录/这个作用域**被主动藏起来**：不删数据、不改可见域，
 *     解除屏蔽即刻复原。
 *
 * 两个层级（用户口径）：
 *   - `session`  —— 只影响当前会话（含沿 parentSession 链继承的子 Agent），**不需要审批**；
 *   - `workspace` —— 影响该工作区里**所有会话**（含历史与将来），**必须审批**。
 *
 * 文件位置：
 *   - 会话级：`<root>/blocks/session/<safeName(sessionId)>.json`
 *   - 工作区级：`<root>/blocks/workspace/<sha1(workspaceKey)>.json`
 *
 * 为什么按会话 / 工作区分文件：storeDir 可能被多个进程共用（见 store.ts 的 issue #3），
 * 单文件 map 在并发写时会互相覆盖；分文件后一次写只碰自己那份。
 *
 * 容错：读写失败只退化为「没有屏蔽」，绝不把异常抛回检索 / 注入 / 面板链路。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { DEFAULT_CONFIG_FRESHNESS_TTL_MS, fileStamp } from './freshness.ts'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'

export const BLOCKS_VERSION = 1

/** 屏蔽的作用层级。 */
export type BlockLevel = 'session' | 'workspace'

/**
 * 一条屏蔽。`scope` 与 `recordId` 二选一（都给了就都生效）：
 *   - `scope`    —— 整个作用域被屏蔽；
 *   - `recordId` —— 单条记忆（`prefix` 是模型给的前缀，用于兼容 8 位短 id）。
 */
export interface MemoryBlock {
  id: string
  level: BlockLevel
  scope?: string
  /** 已解析出的完整记录 id（解析不到时只有 prefix）。 */
  recordId?: string
  /** 模型给的原始 id / 前缀；`startsWith` 匹配。 */
  prefix?: string
  /** 被屏蔽记录的 kind（规则必须走审批，写在这里供面板与审计查看）。 */
  recordKind?: string
  createdAt: number
  createdBy: string
  reason?: string
}

interface BlocksFile {
  version?: number
  key?: unknown
  level?: unknown
  blocks?: unknown
}

/**
 * `add` 的入参：`id` / `createdAt` / `createdBy` 可省略，由 store 补齐。
 * 这样调用方不用自己拼 id 与时间戳，也不会写出半条记录。
 */
export interface MemoryBlockInput {
  id?: string
  scope?: string
  recordId?: string
  prefix?: string
  recordKind?: string
  createdAt?: number
  createdBy?: string
  reason?: string
}

const MAX_BLOCKS_PER_FILE = 500

function safeSessionName(sessionId: string): string {
  const cleaned = sessionId.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80)
  if (cleaned === sessionId && cleaned !== '') return cleaned
  const base = cleaned === '' ? 'session' : cleaned.slice(0, 64)
  return `${base}-${createHash('sha1').update(sessionId).digest('hex').slice(0, 8)}`
}

function workspaceFileName(workspace: string): string {
  return `${createHash('sha1').update(workspace).digest('hex').slice(0, 20)}.json`
}

function cleanText(raw: unknown, max: number): string | undefined {
  if (typeof raw !== 'string') return undefined
  const value = raw.replace(/\s+/g, ' ').trim()
  return value === '' ? undefined : value.slice(0, max)
}

/** 解析一条屏蔽；形状不对就丢掉（宁可少一条屏蔽，也不要拿坏数据去过滤）。 */
function parseBlock(raw: unknown, level: BlockLevel): MemoryBlock | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const item = raw as Record<string, unknown>
  const scope = cleanText(item.scope, 512)
  const recordId = cleanText(item.recordId, 128)
  const prefix = cleanText(item.prefix, 128)
  if (scope === undefined && recordId === undefined && prefix === undefined) return undefined
  const id = cleanText(item.id, 128) ?? randomUUID()
  const createdAt = typeof item.createdAt === 'number' && Number.isFinite(item.createdAt) ? item.createdAt : 0
  return {
    id,
    level,
    ...(scope !== undefined ? { scope } : {}),
    ...(recordId !== undefined ? { recordId } : {}),
    ...(prefix !== undefined ? { prefix } : {}),
    ...(cleanText(item.recordKind, 64) !== undefined ? { recordKind: cleanText(item.recordKind, 64)! } : {}),
    createdAt,
    createdBy: cleanText(item.createdBy, 128) ?? 'agent',
    ...(cleanText(item.reason, 500) !== undefined ? { reason: cleanText(item.reason, 500)! } : {}),
  }
}

function cleanBlocks(raw: unknown, level: BlockLevel): MemoryBlock[] {
  if (!Array.isArray(raw)) return []
  const out: MemoryBlock[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const block = parseBlock(item, level)
    if (block === undefined) continue
    const key = block.scope !== undefined
      ? `scope:${block.scope}`
      : `record:${block.recordId ?? block.prefix ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(block)
    if (out.length >= MAX_BLOCKS_PER_FILE) break
  }
  return out
}

export interface MemoryBlocksStoreOptions {
  /** provider 的数据根目录；屏蔽文件写到 `<root>/blocks/`。 */
  root: string
  warn?: (message: string) => void
}

/**
 * 会话级 + 工作区级屏蔽的读写。两个层级共用一套解析 / 原子写，只是文件目录不同。
 */
export class MemoryBlocksStore {
  private readonly dir: string
  private readonly warn: (message: string) => void
  /** `session:<id>` / `workspace:<key>` → 屏蔽列表 + 文件 stamp。 */
  private readonly cache = new Map<string, { blocks: MemoryBlock[]; stamp: string; checkedAt: number }>()
  /** 0.109.0：多进程下屏蔽配置必须能感知别的进程写入。 */
  private readonly refreshTtlMs: number
  private lastCheckAt = 0

  constructor(options: MemoryBlocksStoreOptions) {
    this.dir = join(options.root, 'blocks')
    this.warn = options.warn ?? ((message) => console.warn(message))
    this.refreshTtlMs = options.refreshTtlMs ?? DEFAULT_CONFIG_FRESHNESS_TTL_MS
  }

  private fileOf(level: BlockLevel, key: string): string {
    return level === 'session'
      ? join(this.dir, 'session', `${safeSessionName(key)}.json`)
      : join(this.dir, 'workspace', workspaceFileName(key))
  }

  private cacheKey(level: BlockLevel, key: string): string {
    return `${level}:${key}`
  }

  /** 读一份屏蔽列表（拷贝）。key 对 session 是会话 id，对 workspace 是 `project:<路径>`。 */
  list(level: BlockLevel, key: string): MemoryBlock[] {
    if (typeof key !== 'string' || key.trim() === '') return []
    const trimmed = key.trim()
    const cacheKey = this.cacheKey(level, trimmed)
    const cached = this.cache.get(cacheKey)
    const file = this.fileOf(level, trimmed)
    if (cached !== undefined) {
      const now = Date.now()
      if (this.refreshTtlMs > 0 && now - this.lastCheckAt < this.refreshTtlMs) {
        return cached.blocks.map((block) => ({ ...block }))
      }
      this.lastCheckAt = now
      if (fileStamp(file) === cached.stamp) return cached.blocks.map((block) => ({ ...block }))
    }
    let blocks: MemoryBlock[] = []
    try {
      if (existsSync(file)) {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as BlocksFile
        // 文件里记录的 key 必须与查询一致：hash 碰撞时宁可当没有，也不串会话 / 工作区。
        if (typeof parsed?.key === 'string' && parsed.key === trimmed) {
          blocks = cleanBlocks(parsed.blocks, level)
        }
      }
    } catch (error) {
      this.warn(`[dsh-memory-local] 忽略损坏的屏蔽文件 ${this.fileOf(level, trimmed)}: ${error instanceof Error ? error.message : String(error)}`)
      blocks = []
    }
    this.cache.set(cacheKey, { blocks, stamp: fileStamp(file), checkedAt: Date.now() })
    return blocks.map((block) => ({ ...block }))
  }

  /** 追加一条屏蔽（同目标已存在时替换）。返回写入后的完整列表。 */
  add(level: BlockLevel, key: string, block: MemoryBlockInput): MemoryBlock[] {
    const current = this.list(level, key)
    const full: MemoryBlock = {
      id: block.id ?? `blk-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
      level,
      ...(block.scope !== undefined ? { scope: block.scope } : {}),
      ...(block.recordId !== undefined ? { recordId: block.recordId } : {}),
      ...(block.prefix !== undefined ? { prefix: block.prefix } : {}),
      ...(block.recordKind !== undefined ? { recordKind: block.recordKind } : {}),
      createdAt: block.createdAt ?? Date.now(),
      createdBy: block.createdBy ?? 'agent',
      ...(block.reason !== undefined ? { reason: block.reason } : {}),
    }
    const rest = current.filter((item) => !sameTarget(item, full))
    return this.write(level, key, [...rest, full])
  }

  /** 按屏蔽 id 或目标移除；返回写入后的列表。 */
  remove(level: BlockLevel, key: string, match: { id?: string; scope?: string; recordId?: string; prefix?: string }): MemoryBlock[] {
    const current = this.list(level, key)
    const rest = current.filter((item) => {
      if (match.id !== undefined && item.id === match.id) return false
      if (match.scope !== undefined && item.scope === match.scope) return false
      const target = match.recordId ?? match.prefix
      if (target !== undefined) {
        if (item.recordId === target || item.prefix === target) return false
        // block 接受 8 位前缀，unblock 也必须接受：否则「屏蔽用前缀、解除要全 id」的
        // 不对称会让用户以为解除失败（0.32.0 起就存在）。
        if (target.length >= 8 && target.length < 36
          && ((item.recordId ?? '').startsWith(target) || (item.prefix ?? '').startsWith(target))) return false
      }
      return true
    })
    return this.write(level, key, rest)
  }

  /** 清空某一层级的全部屏蔽。 */
  clear(level: BlockLevel, key: string): MemoryBlock[] {
    return this.write(level, key, [])
  }

  /** 清掉缓存（下一次 list 重新读盘）；测试 / 维护用。 */
  invalidate(level: BlockLevel, key: string): void {
    this.cache.delete(this.cacheKey(level, key.trim()))
  }

  private write(level: BlockLevel, key: string, blocks: MemoryBlock[]): MemoryBlock[] {
    const trimmed = typeof key === 'string' ? key.trim() : ''
    if (trimmed === '') return []
    const cleaned = blocks.slice(0, MAX_BLOCKS_PER_FILE)
    const file = this.fileOf(level, trimmed)
    try {
      if (cleaned.length === 0) {
        rmSync(file, { force: true })
        this.cache.set(this.cacheKey(level, trimmed), { blocks: [], stamp: fileStamp(file), checkedAt: Date.now() })
        return []
      }
      mkdirSync(join(this.dir, level === 'session' ? 'session' : 'workspace'), { recursive: true })
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
      writeFileSync(tmp, `${JSON.stringify({
        version: BLOCKS_VERSION,
        key: trimmed,
        level,
        blocks: cleaned,
        updatedAt: Date.now(),
      }, null, 2)}\n`, 'utf8')
      renameSync(tmp, file)
      this.cache.set(this.cacheKey(level, trimmed), { blocks: cleaned, stamp: fileStamp(file), checkedAt: Date.now() })
      return cleaned.map((block) => ({ ...block }))
    } catch (error) {
      this.warn(`[dsh-memory-local] 无法写入屏蔽文件 ${file}: ${error instanceof Error ? error.message : String(error)}`)
      return this.list(level, trimmed)
    }
  }
}

/** 两条屏蔽是否指向同一个目标（scope 或同一条记录）。 */
function sameTarget(a: MemoryBlock, b: MemoryBlock): boolean {
  if (a.scope !== undefined && b.scope !== undefined) return a.scope === b.scope
  if (a.scope !== undefined || b.scope !== undefined) return false
  return (a.recordId ?? a.prefix) === (b.recordId ?? b.prefix)
}

/** 一条记录是否命中某条屏蔽。 */
export function blockMatchesRecord(block: MemoryBlock, record: { id: string; scope: string }): boolean {
  if (block.scope !== undefined) return block.scope === record.scope
  if (block.recordId !== undefined && block.recordId === record.id) return true
  if (block.prefix !== undefined && record.id.startsWith(block.prefix)) return true
  return false
}
