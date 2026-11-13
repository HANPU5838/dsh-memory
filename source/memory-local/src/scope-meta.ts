/**
 * 作用域元数据（scope meta）。
 *
 * 为什么需要它：作用域键本身只说明"叫什么"，不说明"用来做什么"。Agent 在申请
 * 范围外作用域之前，必须先能看见它的用途；用户也需要一个地方写"这个作用域只放
 * 什么"。这些信息不属于任何一条记忆：记录会被 supersede / forget / 过期，而作用域
 * 的生命周期更长。
 *
 * 存储选择：**每个作用域一个文件**（`<root>/scope-meta/<sha1(scope)>.json`），
 * 而不是一份全局 map。原因和 `visibility/<session>.json` 一样：
 *   - 同一个 storeDir 可能被多个进程共用（宿主 + 面板 + 多个 agent）；
 *   - 全局 map 的读改写会互相覆盖，而 `scopes.json` 现在就没锁；
 *   - 按作用域分文件后，创建 / 更新只碰自己那份，天然并发安全（原子 rename）。
 *
 * 兼容：没有元数据的旧作用域照常工作；`get()` 返回 undefined，调用方按
 * "未填写用途" 处理，绝不因为升级就要求补齐。项目作用域的显示名仍以
 * `scopes.json`（ScopeNames）为准，这里只存可选的覆盖名。
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { scopeKind, type ScopeKind } from './scope.ts'

export const SCOPE_META_VERSION = 1

/** 用途说明的长度上限。太长就不是"一句话用途"而是又一条记忆了。 */
export const MAX_SCOPE_DESCRIPTION_CHARS = 500

export type ScopeOrigin = ScopeKind

/** 初始化流程状态：pending = 元数据已落盘、初始记录可能还没写完。 */
export type ScopeMetaStatus = 'pending' | 'ready'

export interface ScopeMeta {
  schemaVersion: number
  /** 作用域键（scopeId）。第一阶段继续用既有字符串键，避免迁移所有记录。 */
  scope: string
  /** 可选的显示名覆盖；项目作用域通常仍由 scopes.json 的别名负责。 */
  name?: string
  description: string
  origin: ScopeOrigin
  createdBy: string
  createdAt: number
  updatedAt: number
  /**
   * 创建代次：同一个作用域键被删除后重建时必须换一个。
   * 会话授权按它绑定，避免"同名重建"复活旧授权（S6）。
   */
  generation: string
  status: ScopeMetaStatus
}

/** 作用域键 → 元数据文件名（与记录文件同款 SHA-1 寻址，不暴露路径/名称）。 */
export function scopeMetaFileName(scope: string): string {
  return `${createHash('sha1').update(scope).digest('hex')}.json`
}

export interface ScopeMetaWriteInput {
  description: string
  createdBy: string
  name?: string
  status?: ScopeMetaStatus
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function asTime(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * 读盘校验。坏文件 / 形状不符一律当"没有元数据"，绝不把异常抛回检索或保存链路。
 * `scope` 字段必须与请求的键一致，防止文件被挪动后张冠李戴。
 */
function parseMeta(raw: unknown, wanted?: string): ScopeMeta | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  const scope = asString(value.scope)
  if (scope === undefined) return undefined
  if (wanted !== undefined && scope !== wanted) return undefined
  const description = typeof value.description === 'string' ? value.description : ''
  const originRaw = value.origin
  const origin: ScopeOrigin = originRaw === 'global' || originRaw === 'project' || originRaw === 'session' || originRaw === 'custom'
    ? originRaw
    : scopeKind(scope)
  const generation = asString(value.generation) ?? randomUUID()
  const status: ScopeMetaStatus = value.status === 'pending' ? 'pending' : 'ready'
  const createdAt = asTime(value.createdAt) || Date.now()
  return {
    schemaVersion: SCOPE_META_VERSION,
    scope,
    ...(asString(value.name) !== undefined ? { name: asString(value.name) } : {}),
    description,
    origin,
    createdBy: asString(value.createdBy) ?? 'unknown',
    createdAt,
    updatedAt: asTime(value.updatedAt) || createdAt,
    generation,
    status,
  }
}

export interface ScopeMetaStoreOptions {
  /** provider 的数据根目录；元数据写到 `<root>/scope-meta/`。 */
  root: string
}

export class ScopeMetaStore {
  readonly dir: string

  constructor(options: ScopeMetaStoreOptions) {
    this.dir = join(options.root, 'scope-meta')
  }

  fileFor(scope: string): string {
    return join(this.dir, scopeMetaFileName(scope))
  }

  /** 读取元数据；没有 / 坏文件 → undefined（不触发任何写入）。 */
  get(scope: string): ScopeMeta | undefined {
    let text: string
    try {
      text = readFileSync(this.fileFor(scope), 'utf8')
    } catch {
      return undefined
    }
    try {
      return parseMeta(JSON.parse(text) as unknown, scope)
    } catch {
      return undefined
    }
  }

  has(scope: string): boolean {
    try {
      return statSync(this.fileFor(scope)).isFile()
    } catch {
      return false
    }
  }

  /** 已落盘的全部元数据（供目录工具 / 面板枚举）。坏文件跳过。 */
  list(): ScopeMeta[] {
    let entries: string[]
    try {
      entries = readdirSync(this.dir)
    } catch {
      return []
    }
    const out: ScopeMeta[] = []
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      let text: string
      try {
        text = readFileSync(join(this.dir, entry), 'utf8')
      } catch {
        continue
      }
      try {
        const meta = parseMeta(JSON.parse(text) as unknown)
        if (meta !== undefined) out.push(meta)
      } catch {
        // 坏文件跳过：元数据不是权威数据，不能因此让目录工具失败
      }
    }
    return out
  }

  /**
   * 写入（新建或更新）。已存在时保留 `createdAt` / `generation` / `createdBy`，
   * 只更新 `description` / `name` / `status` / `updatedAt`。
   * 原子写：tmp + rename，别的进程要么看到旧版本，要么看到新版本。
   */
  put(scope: string, input: ScopeMetaWriteInput): ScopeMeta {
    const existing = this.get(scope)
    const now = Date.now()
    const name = input.name ?? existing?.name
    const meta: ScopeMeta = {
      schemaVersion: SCOPE_META_VERSION,
      scope,
      ...(name !== undefined ? { name } : {}),
      description: input.description,
      origin: scopeKind(scope),
      createdBy: existing?.createdBy ?? input.createdBy,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      generation: existing?.generation ?? randomUUID(),
      status: input.status ?? existing?.status ?? 'ready',
    }
    this.write(meta)
    return meta
  }

  /** 删除元数据（回滚未完成的初始化 / 未来的显式作用域删除）。 */
  remove(scope: string): void {
    try {
      rmSync(this.fileFor(scope), { force: true })
    } catch {
      // 删不掉就留着；下次写入会覆盖
    }
  }

  private write(meta: ScopeMeta): void {
    mkdirSync(this.dir, { recursive: true })
    const file = this.fileFor(meta.scope)
    const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
    writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
  }
}

/** 清理空会话作用域的选项。 */
export interface PruneEmptySessionScopesOptions {
  /** 超过这个年龄（毫秒）才删；<= 0 表示禁用。 */
  maxAgeMs: number
  /** 当前时间（测试可注入）。 */
  now?: number
  /** 该作用域是否已有记录；有记录一律不删（只清"从没用过"的作用域）。 */
  hasRecords: (scope: string) => boolean
  /** 冻结判定（如已归档会话）：返回 true 一律不删。 */
  frozen?: (scope: string) => boolean
}

/**
 * 0.62.5：清理"从没用过的历史会话作用域"。
 *
 * 为什么需要：系统会为每个会话自动创建 `session:<id>` 作用域元数据，但**从不回收** ——
 * 开 N 次会话就攒 N 个空作用域，`memory_scopes` 目录会越来越长，用户也分不清哪些是
 * 真在用的。会话作用域只有元数据（没有记录时不落 JSONL），所以清理是安全的：下次真
 * 往里写记忆时会自动重建。
 *
 * 安全边界（三道）：
 *   1. 只删 `origin === 'session'` 且**没有任何记录**的作用域（有记录的永不删）；
 *   2. 只删 `updatedAt` 早于 `maxAgeMs` 的（活跃会话天然受保护）；
 *   3. 冻结作用域（已归档会话）跳过。
 */
export function pruneEmptySessionScopes(
  store: ScopeMetaStore,
  options: PruneEmptySessionScopesOptions,
): string[] {
  if (!(options.maxAgeMs > 0)) return []
  const now = options.now ?? Date.now()
  const removed: string[] = []
  for (const meta of store.list()) {
    if (meta.origin !== 'session') continue
    if (options.frozen?.(meta.scope) === true) continue
    if (options.hasRecords(meta.scope)) continue
    const age = now - (meta.updatedAt ?? meta.createdAt)
    if (!(age >= options.maxAgeMs)) continue
    store.remove(meta.scope)
    removed.push(meta.scope)
  }
  return removed
}
