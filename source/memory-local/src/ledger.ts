/**
 * 0.110.0：防篡改写入账本（tamper-evident ledger）。
 *
 * 来自同类插件（Soulmate793/dsh-memory 的哈希链审计）的思路：记忆库被本地
 * 篡改时，单纯改 JSONL 不会留下任何痕迹。这里给每次写入/删除/巩固追加一条
 * 前向哈希链记录：
 *
 *   hash = sha256(prev + seq + ts + event + id + scope)
 *
 * 只做**证据**，不做权限：验证失败会出现在 doctor 里，提示记忆文件可能被改过。
 * 账本本身是追加写的旁路文件，写失败绝不阻断记忆主流程。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'

export const LEDGER_FILE_NAME = 'ledger.jsonl'
const GENESIS = '0'.repeat(64)

export interface LedgerEntry {
  seq: number
  ts: number
  event: 'save' | 'forget' | 'consolidate' | 'restore'
  id: string
  scope?: string
  prev: string
  hash: string
}

function entryHash(entry: Omit<LedgerEntry, 'hash'>): string {
  return createHash('sha256')
    .update(`${entry.prev}\n${entry.seq}\n${entry.ts}\n${entry.event}\n${entry.id}\n${entry.scope ?? ''}`)
    .digest('hex')
}

export interface LedgerVerifyResult {
  ok: boolean
  entries: number
  error?: string
}

/** 校验整条链：seq 连续、prev 衔接、hash 重算一致。 */
export function verifyLedger(file: string): LedgerVerifyResult {
  if (!existsSync(file)) return { ok: true, entries: 0 }
  const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '')
  let prev = GENESIS
  let expectedSeq = 1
  for (const [index, line] of lines.entries()) {
    let entry: LedgerEntry
    try {
      entry = JSON.parse(line) as LedgerEntry
    } catch {
      return { ok: false, entries: lines.length, error: `第 ${index + 1} 行不是合法 JSON（文件可能被截断/改写）` }
    }
    if (entry.seq !== expectedSeq) return { ok: false, entries: lines.length, error: `第 ${index + 1} 行 seq=${entry.seq}，期望 ${expectedSeq}` }
    if (entry.prev !== prev) return { ok: false, entries: lines.length, error: `第 ${index + 1} 行 prev 与上一条 hash 不衔接` }
    const expected = entryHash({ ...entry, hash: undefined } as unknown as Omit<LedgerEntry, 'hash'>)
    if (entry.hash !== expected) return { ok: false, entries: lines.length, error: `第 ${index + 1} 行 hash 不匹配（内容被改过）` }
    prev = entry.hash
    expectedSeq++
  }
  return { ok: true, entries: lines.length }
}

/** 追加式账本；进程内缓存链头，写失败静默忽略（不影响记忆主流程）。 */
export class MemoryLedger {
  private readonly file: string
  private head: { seq: number; hash: string }

  constructor(storeDir: string) {
    this.file = join(storeDir, LEDGER_FILE_NAME)
    this.head = this.readHead()
  }

  private readHead(): { seq: number; hash: string } {
    try {
      if (!existsSync(this.file)) return { seq: 0, hash: GENESIS }
      const lines = readFileSync(this.file, 'utf8').split('\n').filter((line) => line.trim() !== '')
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]!) as LedgerEntry
          if (typeof entry.seq === 'number' && typeof entry.hash === 'string') return { seq: entry.seq, hash: entry.hash }
        } catch { /* 坏行跳过，继续向前找 */ }
      }
    } catch { /* 读不到就当空账本 */ }
    return { seq: 0, hash: GENESIS }
  }

  append(event: LedgerEntry['event'], id: string, scope?: string): void {
    try {
      const seq = this.head.seq + 1
      const ts = Date.now()
      const base = { seq, ts, event, id, ...(scope !== undefined ? { scope } : {}), prev: this.head.hash }
      const entry: LedgerEntry = { ...base, hash: entryHash(base) }
      mkdirSync(dirname(this.file), { recursive: true })
      appendFileSync(this.file, `${JSON.stringify(entry)}\n`, 'utf8')
      this.head = { seq, hash: entry.hash }
    } catch { /* 账本是旁路：写不进去也不能影响记忆写入 */ }
  }

  /** 账本文件路径（doctor / 测试用）。 */
  get path(): string {
    return this.file
  }
}
