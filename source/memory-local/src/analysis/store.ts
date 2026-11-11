/**
 * 分析结果持久化（analysis/store）—— 一个很薄的 JSONL / JSON 仓库，零外部依赖。
 *
 * 目录布局（`dir` 一般是记忆库根目录）：
 *   <dir>/analysis/relations.jsonl   关系（整份覆盖写：分析输出是快照）
 *   <dir>/analysis/conflicts.jsonl   冲突（整份覆盖写）
 *   <dir>/analysis/events.jsonl      演化事件（追加写，历史不丢）
 *   <dir>/analysis/tasks.jsonl       分析任务记录（追加写）
 *   <dir>/analysis/state.json        指纹状态 { version, fingerprints, lastAnalyzedAt? }
 *
 * 硬性约定：
 *   - **原子写**：先写同目录 tmp 文件再 rename，读者永远看不到半截 JSON；
 *   - **读取容错**：JSONL 里坏行（进程被杀/手改）跳过而不是整份失败；state.json
 *     坏了退化成默认状态，绝不让分析的恢复逻辑炸掉主流程；
 *   - 追加写（events/tasks）不做 trim，`historyLimit` 只限制**读取时返回**最近多少条，
 *     这样历史永远可审计。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type {
  AnalysisState,
  AnalysisTask,
  ConflictRecord,
  EvolutionEvent,
  RelationRecord,
} from './types.ts'

/** state.json 的 schema 版本。 */
export const ANALYSIS_STATE_VERSION = 1
/** 默认历史读取上限（events / tasks）。 */
export const DEFAULT_HISTORY_LIMIT = 500

export interface AnalysisRepositoryOptions {
  /** listEvents / listTasks 默认返回最近多少条，默认 500。 */
  historyLimit?: number
}

/** 一次保存到磁盘的关系/冲突快照。 */
export type RelationsSnapshot = readonly RelationRecord[]
export type ConflictsSnapshot = readonly ConflictRecord[]

export class AnalysisRepository {
  /** 记忆库根目录（analysis 文件在 `<dir>/analysis/` 下）。 */
  readonly dir: string
  /** 历史读取上限。 */
  readonly historyLimit: number
  private readonly analysisDirPath: string

  constructor(dir: string, options: AnalysisRepositoryOptions = {}) {
    this.dir = dir
    this.analysisDirPath = join(dir, 'analysis')
    const limit = Math.floor(options.historyLimit ?? DEFAULT_HISTORY_LIMIT)
    this.historyLimit = Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_HISTORY_LIMIT
  }

  /** `<dir>/analysis`（目录在第一次写入时才创建）。 */
  get analysisDir(): string {
    return this.analysisDirPath
  }

  /** 某个分析数据文件的绝对路径（面板/维护任务需要直接看文件时用）。 */
  filePath(file: 'relations' | 'conflicts' | 'events' | 'tasks' | 'state'): string {
    return join(this.analysisDirPath, file === 'state' ? 'state.json' : `${file}.jsonl`)
  }

  // ------------------------------------------------------------ state

  /** 读状态；文件缺失/损坏 → 默认状态（版本 1、空指纹）。 */
  loadState(): AnalysisState {
    const fallback: AnalysisState = { version: ANALYSIS_STATE_VERSION, fingerprints: {} }
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.filePath('state'), 'utf8'))
    } catch {
      return fallback
    }
    if (raw === null || typeof raw !== 'object') return fallback
    const obj = raw as Record<string, unknown>
    const fingerprints: Record<string, string> = {}
    if (obj.fingerprints !== null && typeof obj.fingerprints === 'object') {
      for (const [id, value] of Object.entries(obj.fingerprints as Record<string, unknown>)) {
        if (typeof value === 'string' && value !== '') fingerprints[id] = value
      }
    }
    const version = typeof obj.version === 'number' && Number.isFinite(obj.version)
      ? Math.floor(obj.version)
      : ANALYSIS_STATE_VERSION
    const lastAnalyzedAt = typeof obj.lastAnalyzedAt === 'number' && Number.isFinite(obj.lastAnalyzedAt)
      ? obj.lastAnalyzedAt
      : undefined
    return {
      version,
      fingerprints,
      ...(lastAnalyzedAt !== undefined ? { lastAnalyzedAt } : {}),
    }
  }

  /** 原子写状态（tmp + rename）。 */
  saveState(state: AnalysisState): void {
    this.ensureDir()
    this.writeAtomic(this.filePath('state'), `${JSON.stringify({
      version: ANALYSIS_STATE_VERSION,
      fingerprints: state.fingerprints,
      ...(state.lastAnalyzedAt !== undefined ? { lastAnalyzedAt: state.lastAnalyzedAt } : {}),
    }, null, 2)}\n`)
  }

  // ------------------------------------------------------------ relations / conflicts（快照覆盖）

  listRelations(): RelationRecord[] {
    return this.readJsonl<RelationRecord>(this.filePath('relations'))
  }

  saveRelations(records: RelationsSnapshot): void {
    this.ensureDir()
    this.writeJsonl(this.filePath('relations'), records)
  }

  listConflicts(): ConflictRecord[] {
    return this.readJsonl<ConflictRecord>(this.filePath('conflicts'))
  }

  saveConflicts(records: ConflictsSnapshot): void {
    this.ensureDir()
    this.writeJsonl(this.filePath('conflicts'), records)
  }

  // ------------------------------------------------------------ events（追加）

  appendEvent(event: EvolutionEvent): void {
    this.ensureDir()
    this.appendJsonl(this.filePath('events'), event)
  }

  /** 最近 `limit` 条事件（文件顺序 = 追加顺序）；缺省用 historyLimit。 */
  listEvents(limit = this.historyLimit): EvolutionEvent[] {
    return tail(this.readJsonl<EvolutionEvent>(this.filePath('events')), limit)
  }

  // ------------------------------------------------------------ tasks（追加）

  appendTask(task: AnalysisTask): void {
    this.ensureDir()
    this.appendJsonl(this.filePath('tasks'), task)
  }

  /** 最近 `limit` 条任务；缺省用 historyLimit。 */
  listTasks(limit = this.historyLimit): AnalysisTask[] {
    return tail(this.readJsonl<AnalysisTask>(this.filePath('tasks')), limit)
  }

  // ------------------------------------------------------------ 内部

  private ensureDir(): void {
    mkdirSync(this.analysisDirPath, { recursive: true })
  }

  /** JSONL 容错读取：坏行/非对象行跳过；文件不存在 → []。 */
  private readJsonl<T>(file: string): T[] {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      return []
    }
    const out: T[] = []
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        const parsed = JSON.parse(trimmed) as unknown
        if (parsed !== null && typeof parsed === 'object') out.push(parsed as T)
      } catch {
        // 坏行（进程被杀时可能只写了半行）跳过，继续读后面的
      }
    }
    return out
  }

  /** 追加一行 JSONL（同步，进程内调用顺序即落盘顺序）。 */
  private appendJsonl(file: string, value: unknown): void {
    appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8')
  }

  /** 整份覆盖写 JSONL（空数组 → 空文件），tmp + rename 保证原子。 */
  private writeJsonl(file: string, values: readonly unknown[]): void {
    const lines = values.map((value) => JSON.stringify(value))
    this.writeAtomic(file, lines.length > 0 ? `${lines.join('\n')}\n` : '')
  }

  private writeAtomic(file: string, text: string): void {
    const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, file)
  }
}

/** 取数组末尾 limit 条（limit <= 0 → 空；非有限 → 全部）。 */
function tail<T>(items: readonly T[], limit: number): T[] {
  if (!Number.isFinite(limit)) return [...items]
  const count = Math.max(0, Math.floor(limit))
  return count === 0 ? [] : items.slice(Math.max(0, items.length - count))
}
