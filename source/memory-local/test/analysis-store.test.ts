/**
 * 分析结果持久化（analysis/store）：目录布局、原子写、JSONL 容错、历史上限。
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AnalysisRepository, ANALYSIS_STATE_VERSION, DEFAULT_HISTORY_LIMIT } from '../src/analysis/store.ts'
import type {
  AnalysisState,
  AnalysisTask,
  ConflictRecord,
  EvolutionEvent,
  RelationRecord,
} from '../src/analysis/types.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-analysis-store-'))
  dirs.push(dir)
  return dir
}

function relation(id: string, extra: Partial<RelationRecord> = {}): RelationRecord {
  return {
    id,
    sourceEntityId: 'tool:npm',
    targetEntityId: 'tool:node',
    relationshipType: 'entity',
    status: 'suggested',
    confidenceScore: 0.955,
    strength: 'strong',
    evidence: [{ kind: 'shared-memory', text: '共同出现在 2 条记忆里', memoryIds: ['m1', 'm2'] }],
    sourceMemoryIds: ['m1', 'm2'],
    inferred: false,
    analysisVersion: '1',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...extra,
  }
}

function conflict(id: string): ConflictRecord {
  return {
    id,
    kind: 'update',
    status: 'new',
    oldMemoryId: 'old',
    newMemoryId: 'new',
    similarity: 0.96,
    contradiction: 0.57,
    summary: '记忆更新：端口 8080 → 9090',
    evidence: [{ kind: 'time', text: '更新时间相差 2.0 小时', memoryId: 'new' }],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  }
}

function event(id: string, at: number): EvolutionEvent {
  return { id, entityId: 'tool:npm', type: 'created', memoryId: 'm1', at, detail: '创建' }
}

function task(id: string, status: AnalysisTask['status'] = 'done'): AnalysisTask {
  return {
    id,
    mode: 'full',
    status,
    progress: 1,
    total: 2,
    analyzed: 2,
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_001_000,
  }
}

// ---------------------------------------------------------------- 目录 / 状态

test('目录布局：文件都在 <dir>/analysis/ 下,构造时懒创建', () => {
  const dir = freshDir()
  const repo = new AnalysisRepository(dir)
  assert.equal(repo.analysisDir, join(dir, 'analysis'))
  assert.equal(repo.filePath('relations'), join(dir, 'analysis', 'relations.jsonl'))
  assert.equal(repo.filePath('conflicts'), join(dir, 'analysis', 'conflicts.jsonl'))
  assert.equal(repo.filePath('events'), join(dir, 'analysis', 'events.jsonl'))
  assert.equal(repo.filePath('tasks'), join(dir, 'analysis', 'tasks.jsonl'))
  assert.equal(repo.filePath('state'), join(dir, 'analysis', 'state.json'))
  assert.equal(existsSync(repo.analysisDir), false, '构造不落盘')
})

test('loadState：文件缺失/损坏 → 默认状态,不抛异常', () => {
  const dir = freshDir()
  const repo = new AnalysisRepository(dir)
  assert.deepEqual(repo.loadState(), { version: ANALYSIS_STATE_VERSION, fingerprints: {} })
  assert.equal(ANALYSIS_STATE_VERSION, 1)
  assert.equal(DEFAULT_HISTORY_LIMIT, 500)

  mkdirSync(repo.analysisDir, { recursive: true })
  writeFileSync(repo.filePath('state'), '{ 这不是 JSON', 'utf8')
  assert.deepEqual(repo.loadState(), { version: ANALYSIS_STATE_VERSION, fingerprints: {} })
  writeFileSync(repo.filePath('state'), JSON.stringify({ version: 1, fingerprints: { a: 'x' } }), 'utf8')
  assert.deepEqual(repo.loadState().fingerprints, { a: 'x' })
})

test('saveState/loadState：指纹与 lastAnalyzedAt 往返,写的是纯 JSON', () => {
  const dir = freshDir()
  const repo = new AnalysisRepository(dir)
  const state: AnalysisState = {
    version: 1,
    fingerprints: { m1: 'sha256|100', m2: 'sha256|200' },
    lastAnalyzedAt: 1_700_000_000_000,
  }
  repo.saveState(state)
  assert.equal(existsSync(repo.filePath('state')), true)
  const parsed = JSON.parse(readFileSync(repo.filePath('state'), 'utf8'))
  assert.equal(parsed.version, 1)
  assert.deepEqual(parsed.fingerprints, state.fingerprints)
  assert.equal(parsed.lastAnalyzedAt, state.lastAnalyzedAt)

  const fresh = new AnalysisRepository(dir)
  assert.deepEqual(fresh.loadState(), state)

  // 覆盖写：清空指纹也要生效
  fresh.saveState({ version: 1, fingerprints: {} })
  assert.deepEqual(new AnalysisRepository(dir).loadState(), { version: 1, fingerprints: {} })
})

test('原子写：写入后不残留 tmp 文件', () => {
  const dir = freshDir()
  const repo = new AnalysisRepository(dir)
  repo.saveRelations([relation('r1'), relation('r2')])
  repo.saveConflicts([conflict('c1')])
  repo.saveState({ version: 1, fingerprints: { m1: 'x|1' } })
  const leftovers = readdirSync(repo.analysisDir).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [])
})

// ---------------------------------------------------------------- relations / conflicts

test('relations：整份写读往返,空数组写出空文件', () => {
  const dir = freshDir()
  const repo = new AnalysisRepository(dir)
  assert.deepEqual(repo.listRelations(), [], '缺失文件 → 空')

  const records = [relation('rel_a'), relation('rel_b', { strength: 'medium', confidenceScore: 0.64, status: 'confirmed' })]
  repo.saveRelations(records)
  assert.equal(existsSync(repo.filePath('relations')), true)
  assert.deepEqual(repo.listRelations(), records)

  repo.saveRelations([])
  assert.equal(existsSync(repo.filePath('relations')), true, '空快照也保留文件')
  assert.deepEqual(repo.listRelations(), [])
})

test('relations JSONL 容错：坏行跳过,好行照读', () => {
  const dir = freshDir()
  const repo = new AnalysisRepository(dir)
  const lines = [
    JSON.stringify(relation('good1')),
    '这不是 JSON',
    '',
    JSON.stringify(relation('good2')),
  ]
  mkdirSync(repo.analysisDir, { recursive: true })
  writeFileSync(repo.filePath('relations'), `${lines.join('\n')}\n`, 'utf8')
  assert.deepEqual(repo.listRelations().map((item) => item.id), ['good1', 'good2'])
})

test('conflicts：整份写读往返', () => {
  const dir = freshDir()
  const repo = new AnalysisRepository(dir)
  const records = [conflict('cf_1'), conflict('cf_2')]
  repo.saveConflicts(records)
  assert.deepEqual(repo.listConflicts(), records)
  assert.deepEqual(new AnalysisRepository(dir).listConflicts(), records)
})

// ---------------------------------------------------------------- events / tasks（追加 + 历史上限）

test('events：追加写,historyLimit 只限制读取条数（历史不丢）', () => {
  const dir = freshDir()
  const repo = new AnalysisRepository(dir, { historyLimit: 2 })
  for (let i = 0; i < 5; i++) repo.appendEvent(event(`ev_${i}`, 1000 + i))
  assert.deepEqual(repo.listEvents().map((item) => item.id), ['ev_3', 'ev_4'], '默认取最近 historyLimit 条')
  assert.deepEqual(repo.listEvents(3).map((item) => item.id), ['ev_2', 'ev_3', 'ev_4'])
  assert.equal(repo.listEvents(0).length, 0)
  // 文件里确实保留了全部 5 条
  assert.equal(readFileSync(repo.filePath('events'), 'utf8').trim().split('\n').length, 5)
})

test('tasks：追加写并保留状态字段,默认按最近 historyLimit 返回', () => {
  const dir = freshDir()
  const repo = new AnalysisRepository(dir)
  repo.appendTask(task('t1', 'running'))
  repo.appendTask(task('t2', 'failed'))
  const tasks = repo.listTasks()
  assert.deepEqual(tasks.map((item) => item.id), ['t1', 't2'])
  assert.deepEqual(tasks.map((item) => item.status), ['running', 'failed'])
  assert.equal(tasks[1]!.finishedAt, 1_700_000_001_000)
  assert.deepEqual(repo.listTasks(1).map((item) => item.id), ['t2'])
})

test('events 容错：坏行跳过;跨实例追加不丢历史', () => {
  const dir = freshDir()
  const repo = new AnalysisRepository(dir)
  repo.appendEvent(event('ev_1', 1))
  const second = new AnalysisRepository(dir)
  second.appendEvent(event('ev_2', 2))
  // 人为插入一行坏数据
  writeFileSync(second.filePath('events'), `${readFileSync(second.filePath('events'), 'utf8')}{bad\n`, 'utf8')
  const third = new AnalysisRepository(dir)
  assert.deepEqual(third.listEvents().map((item) => item.id), ['ev_1', 'ev_2'])
})

test('多实例共享同一目录：各自新开实例都能读到最新数据', () => {
  const dir = freshDir()
  const first = new AnalysisRepository(dir)
  first.appendTask(task('t1'))
  first.saveRelations([relation('r1')])
  const second = new AnalysisRepository(dir)
  assert.deepEqual(second.listTasks().map((item) => item.id), ['t1'])
  assert.deepEqual(second.listRelations().map((item) => item.id), ['r1'])
  second.appendTask(task('t2'))
  assert.deepEqual(first.listTasks().map((item) => item.id), ['t1', 't2'])
})

test('historyLimit 非法值回退默认', () => {
  const dir = freshDir()
  assert.equal(new AnalysisRepository(dir, { historyLimit: 0 }).historyLimit, DEFAULT_HISTORY_LIMIT)
  assert.equal(new AnalysisRepository(dir, { historyLimit: -5 }).historyLimit, DEFAULT_HISTORY_LIMIT)
  assert.equal(new AnalysisRepository(dir, { historyLimit: 7 }).historyLimit, 7)
})
