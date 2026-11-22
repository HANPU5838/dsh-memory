/**
 * 核心记忆块（core memory blocks）。
 *
 * 三个常驻槽位（identity / profile / goal）被每轮注入系统提示，用于跨会话保持
 * 身份、用户画像与当前目标。它们不是普通记忆：不进检索/摘要/合并，单独存
 * `<storeDir>/core.json`，写入走版本链，可回滚。
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type CoreSlot = 'identity' | 'profile' | 'goal'

export const CORE_SLOTS: readonly CoreSlot[] = ['identity', 'profile', 'goal']

/** 单槽 token 上限（CJK 感知估算）。写入时校验，注入时不截断。 */
export const CORE_SLOT_TOKEN_LIMITS: Readonly<Record<CoreSlot, number>> = {
  identity: 55,
  profile: 150,
  goal: 40,
}

export const CORE_TOTAL_TOKEN_BUDGET = 300
export const CORE_HISTORY_LIMIT = 20

export type CoreWriter = 'user' | 'agent'

export interface CoreSlotState {
  readonly content: string
  readonly version: number
  readonly updatedAt: number
  readonly updatedBy: CoreWriter
}

export interface CoreFile {
  readonly version: 1
  readonly slots: Partial<Record<CoreSlot, CoreSlotState>>
  readonly history: Partial<Record<CoreSlot, ReadonlyArray<CoreSlotState>>>
}

const EMPTY: CoreFile = { version: 1, slots: {}, history: {} }

export function isCoreSlot(value: unknown): value is CoreSlot {
  return typeof value === 'string' && (CORE_SLOTS as readonly string[]).includes(value)
}

/** CJK 感知的 token 估算：汉字 1 token/字，其它约 3.2 字符/token。 */
export function estimateCoreTokens(text: string): number {
  if (text === '') return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    const isCjk = (cp >= 0x2e80 && cp <= 0x9fff)
      || (cp >= 0xf900 && cp <= 0xfaff)
      || (cp >= 0xff00 && cp <= 0xffef)
      || (cp >= 0x3000 && cp <= 0x303f)
    if (isCjk) cjk += 1
    else other += 1
  }
  return Math.ceil(cjk + other / 3.2)
}

/** 去掉控制字符与模板定界符，避免注入端被撑破或被当模板求值。 */
export function sanitizeCoreContent(content: string): string {
  return content
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\u200b|\u200c|\u200d|\ufeff/g, '')
    .replace(/\{\{/g, '{ {')
    .trim()
}

export class CoreMemoryStore {
  private readonly file: string
  private state: CoreFile

  constructor(storeDir: string) {
    this.file = join(storeDir, 'core.json')
    this.state = this.load()
  }

  private load(): CoreFile {
    if (!existsSync(this.file)) return EMPTY
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '')) as Partial<CoreFile>
      if (raw.version !== 1 || typeof raw.slots !== 'object' || raw.slots === null) return EMPTY
      return { version: 1, slots: raw.slots, history: raw.history ?? {} }
    } catch {
      // 损坏的核心块不能让整个记忆系统起不来；退回空状态，下次写入重建。
      return EMPTY
    }
  }

  private persist(): void {
    mkdirSync(join(this.file, '..'), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    const fd = openSync(tmp, 'w')
    try {
      writeFileSync(fd, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8')
      try { fsyncSync(fd) } catch { /* 不支持 fsync 的文件系统 */ }
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, this.file)
  }

  /** 导出当前状态（备份用）。 */
  snapshot(): CoreFile {
    return this.state
  }

  /** 从备份整体恢复；非法输入保持原状。 */
  replaceAll(raw: unknown): boolean {
    if (raw === null || typeof raw !== 'object') return false
    const candidate = raw as Partial<CoreFile>
    if (candidate.version !== 1 || typeof candidate.slots !== 'object' || candidate.slots === null) return false
    this.state = { version: 1, slots: candidate.slots, history: candidate.history ?? {} }
    this.persist()
    return true
  }

  get(slot: CoreSlot): CoreSlotState | undefined {
    return this.state.slots[slot]
  }

  blocks(): Readonly<Record<CoreSlot, CoreSlotState | undefined>> {
    return {
      identity: this.state.slots.identity,
      profile: this.state.slots.profile,
      goal: this.state.slots.goal,
    }
  }

  history(slot: CoreSlot, limit = CORE_HISTORY_LIMIT): ReadonlyArray<CoreSlotState> {
    const items = this.state.history[slot] ?? []
    return items.slice(-limit)
  }

  /**
   * 写入一个槽位的新版本。空内容 = 清空（版本继续递增，历史保留）。
   * `expectedVersion` 不匹配时抛 CoreVersionConflict。
   */
  set(slot: CoreSlot, content: string, writer: CoreWriter, expectedVersion?: number): CoreSlotState {
    const previous = this.state.slots[slot]
    if (expectedVersion !== undefined && previous !== undefined && previous.version !== expectedVersion) {
      throw new CoreVersionConflict(slot, previous.version, expectedVersion)
    }
    const next: CoreSlotState = {
      content,
      version: (previous?.version ?? 0) + 1,
      updatedAt: Date.now(),
      updatedBy: writer,
    }
    const history = [...(this.state.history[slot] ?? []), next].slice(-CORE_HISTORY_LIMIT)
    this.state = {
      version: 1,
      slots: { ...this.state.slots, [slot]: next },
      history: { ...this.state.history, [slot]: history },
    }
    this.persist()
    return next
  }
}

export class CoreVersionConflict extends Error {
  readonly code = 'CORE_VERSION_CONFLICT'
  readonly slot: CoreSlot
  readonly actual: number
  readonly expected: number

  constructor(slot: CoreSlot, actual: number, expected: number) {
    super(`核心块 ${slot} 版本冲突：当前 v${actual}，期望 v${expected}`)
    this.slot = slot
    this.actual = actual
    this.expected = expected
  }
}

export class CoreContentInvalid extends Error {
  readonly code = 'CORE_TEXT_INVALID'
  readonly slot: CoreSlot
  readonly reason: string

  constructor(slot: CoreSlot, reason: string) {
    super(`核心块 ${slot} 内容不合法：${reason}`)
    this.slot = slot
    this.reason = reason
  }
}

/** 写入前校验：非空、长度、token 上限。清空走空串。 */
export function validateCoreContent(slot: CoreSlot, content: string): void {
  if (content === '') return
  const limit = CORE_SLOT_TOKEN_LIMITS[slot]
  const tokens = estimateCoreTokens(content)
  if (tokens > limit) throw new CoreContentInvalid(slot, `约 ${tokens} token，超过上限 ${limit}`)
  if (content.length > 2000) throw new CoreContentInvalid(slot, '正文过长')
}
