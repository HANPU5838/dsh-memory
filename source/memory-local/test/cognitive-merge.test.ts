/**
 * 语义合并计划（cognitive/merge）：阈值边界、合并字段、谱系接续、上层集成入口。
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, generationOf } from '../src/store.ts'
import {
  MERGE_THRESHOLD,
  mergePlanToSaveInput,
  planMerge,
  planMergeAgainst,
  planNearDuplicateMerge,
  unionTags,
} from '../src/cognitive/merge.ts'
import { tombstone } from '../src/cognitive/lifecycle.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const DEFAULTS = { importance: 0.5, source: { origin: 'explicit' as const } }
type SaveInput = Parameters<MemoryStore['save']>[0]

function freshStore(): MemoryStore {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cog-merge-'))
  dirs.push(dir)
  return new MemoryStore(dir)
}

function save(store: MemoryStore, scope: string, content: string, extra: Record<string, unknown> = {}) {
  return store.save({ scope, kind: 'note', content, ...extra } as SaveInput, DEFAULTS).record
}

test('unionTags:保序去重,容忍空值', () => {
  assert.deepEqual(unionTags(['a', 'b'], ['b', 'c']), ['a', 'b', 'c'])
  assert.deepEqual(unionTags(undefined, []), [])
  assert.deepEqual(unionTags(['x'], null), ['x'])
})

test('planMerge:归一化内容相同 → refresh,不产生新版本', () => {
  const store = freshStore()
  const existing = save(store, 'project:m', '同一段内容')
  const plan = planMerge({
    incoming: { content: '同一段内容 ' },
    existing,
    similarity: 0.99,
  })
  assert.equal(plan.action, 'refresh')
  assert.equal(plan.reason, 'identical-content')
  assert.equal(plan.refreshId, existing.id)
  assert.equal(plan.record, undefined)
  assert.equal(mergePlanToSaveInput(plan), null)
})

test('planMerge:阈值边界 —— 0.9199 不合并,恰好 0.92 合并', () => {
  assert.equal(MERGE_THRESHOLD, 0.92)
  const store = freshStore()
  const existing = save(store, 'project:m', '旧内容')
  const below = planMerge({
    incoming: { content: '意思相近的新内容' },
    existing,
    similarity: 0.9199,
  })
  assert.equal(below.action, 'keep')
  assert.equal(below.reason, 'below-threshold')
  assert.equal(mergePlanToSaveInput(below), null)

  const at = planMerge({
    incoming: { content: '意思相近的新内容' },
    existing,
    similarity: 0.92,
  })
  assert.equal(at.action, 'merge', '阈值是闭区间下界: == 0.92 应该合并')
  assert.notEqual(at.record, undefined)

  const above = planMerge({
    incoming: { content: '意思相近的新内容' },
    existing,
    similarity: 0.97,
  })
  assert.equal(above.action, 'merge')
})

test('planMerge:tags 并集 / importance 取大 / supersedes / generation+1 / 内容更新', () => {
  const store = freshStore()
  const scope = 'project:m'
  const v1 = save(store, scope, '旧版本内容', { tags: ['旧标签', '共同'], importance: 0.4 })
  const v2 = save(store, scope, '第二版内容', { tags: ['共同'], importance: 0.5, supersedes: v1.id })
  assert.equal(generationOf(v2), 2)

  const plan = planMerge({
    incoming: { content: '语义相同但重写过的内容', tags: ['新标签', '共同'], importance: 0.9 },
    existing: v2,
    similarity: 0.95,
    now: 1_000_000,
  })
  assert.equal(plan.action, 'merge')
  assert.equal(plan.reason, 'semantic-duplicate')
  assert.equal(plan.supersedes, v2.id)
  assert.equal(plan.generation, 3, '旧版本 generation=2 → 新版本 3')
  assert.equal(plan.record!.generation, 3)
  assert.equal(plan.record!.supersedes, v2.id)
  assert.equal(plan.record!.content, '语义相同但重写过的内容', '默认用 incoming 内容做更新')
  assert.deepEqual(plan.record!.tags, ['共同', '新标签'], 'tags 并集(并到当前版本上):旧在前、新的补充在后')
  assert.equal(plan.record!.importance, 0.9, 'importance 取大')
  assert.equal(plan.record!.createdAt, 1_000_000)
  assert.equal(plan.record!.scope, scope)
  assert.notEqual(plan.record!.id, v2.id)

  // 上层/LLM 给出合并正文时以它为准
  const rewritten = planMerge({
    incoming: { content: '新内容' },
    existing: v2,
    similarity: 0.95,
    mergedContent: '  合并后的正文  ',
  })
  assert.equal(rewritten.record!.content, '合并后的正文')
})

test('planMerge:保留 triggers/initial/未来过期时间,丢弃已过期时间', () => {
  const store = freshStore()
  const scope = 'project:m-meta'
  const now = Date.now()
  const existing = save(store, scope, '带元数据的旧记录', {
    triggers: ['工具名', '关键词'],
    initial: true,
    expiredAt: now + 60_000,
  })
  const plan = planMerge({
    incoming: { content: '相似的新内容', triggers: ['新触发词'] },
    existing,
    similarity: 0.96,
    now,
  })
  assert.deepEqual((plan.record as unknown as { triggers?: string[] }).triggers, ['工具名', '关键词', '新触发词'])
  assert.equal((plan.record as unknown as { initial?: boolean }).initial, true)
  assert.equal(plan.record!.expiredAt, now + 60_000)

  const expired = save(store, scope, '已过期的旧记录', { expiredAt: now - 1_000 })
  const expiredPlan = planMerge({
    incoming: { content: '跟过期记录相似的新内容' },
    existing: expired,
    similarity: 0.96,
    now,
  })
  assert.equal(expiredPlan.record!.expiredAt, undefined, '已过期的记录不该把过期时间传给新版本')
})

test('落地:store.save(mergePlanToSaveInput) 生成新版本,旧记录保留且成为退役版本', () => {
  const store = freshStore()
  const scope = 'project:m-land'
  const old = save(store, scope, '旧内容', { tags: ['a'], importance: 0.3 })
  const plan = planMerge({
    incoming: { content: '新内容', tags: ['b'], importance: 0.8 },
    existing: old,
    similarity: 0.95,
  })
  const input = mergePlanToSaveInput(plan)
  assert.notEqual(input, null)
  const saved = store.save(input!, DEFAULTS)
  assert.equal(saved.deduped, false)
  assert.equal(saved.record.content, '新内容')
  assert.equal(saved.record.supersedes, old.id)
  assert.equal(generationOf(saved.record), 2)
  assert.equal(saved.record.generation, plan.generation)
  assert.deepEqual([...saved.record.tags].sort(), ['a', 'b'])
  assert.equal(saved.record.importance, 0.8)

  // 旧记录还在（不删），检索侧靠 retired 隐藏
  assert.notEqual(store.findById(old.id), undefined)
  assert.equal(store.scope(scope).records.size, 2)
  const retired = store.scope(scope).retiredIds()
  assert.ok(retired.has(old.id))

  // 谱系接上：两版一条链
  const lineage = store.lineage(saved.record.id)
  assert.deepEqual(lineage!.entries.map((entry) => entry.id), [old.id, saved.record.id])
  assert.equal(lineage!.currentId, saved.record.id)
})

test('planMergeAgainst:挑最相似的候选;无候选/全部不达标 → null;跳过软删记录', () => {
  const store = freshStore()
  const scope = 'project:m-cand'
  const a = save(store, scope, '候选 A')
  const b = save(store, scope, '候选 B')
  const gone = save(store, scope, '已软删的候选')
  tombstone(store, gone.id)
  // tombstone 写入的是新对象,拿 store 里的最新引用(调用方用 findSimilar 也是同口径)
  const goneNow = store.findById(gone.id)!

  const plan = planMergeAgainst(
    { incoming: { content: '新内容' } },
    [
      { record: a, similarity: 0.93 },
      { record: b, similarity: 0.99 },
      { record: goneNow, similarity: 0.999 },
    ],
  )
  assert.equal(plan!.supersedes, b.id, '最相似且未软删的候选胜出')

  assert.equal(planMergeAgainst({ incoming: { content: '新内容' } }, []), null)
  assert.equal(planMergeAgainst({ incoming: { content: '新内容' } }, [{ record: a, similarity: 0.5 }]), null)
  assert.equal(
    planMergeAgainst({ incoming: { content: '新内容' } }, [{ record: goneNow, similarity: 0.999 }]),
    null,
    '软删记录不能被合并目标',
  )
})

test('planNearDuplicateMerge:存量两条近重复原地合并,较旧的一条退役但保留', () => {
  const store = freshStore()
  const scope = 'project:m-pair'
  const older = save(store, scope, '重复的旧内容', { tags: ['旧标签'], importance: 0.3 })
  const newer = save(store, scope, '重复的新内容', { tags: ['新标签'], importance: 0.6 })

  const plan = planNearDuplicateMerge(newer, older, 0.97, { now: 2_000_000 })
  assert.notEqual(plan, null)
  assert.equal(plan!.action, 'merge')
  assert.equal(plan!.supersedes, older.id)
  assert.equal(plan!.generation, 2)
  assert.equal(plan!.record!.id, newer.id, '原地升级：不产生第三条记录')
  assert.equal(plan!.record!.content, '重复的新内容', '内容保留较新的那条')
  assert.deepEqual(plan!.record!.tags, ['新标签', '旧标签'])
  assert.equal(plan!.record!.importance, 0.6)
  assert.equal(plan!.record!.updatedAt, 2_000_000)

  // 落地后:drop 成为退役版本,keep 仍是活动版本,谱系连成一条
  store.scope(scope).insert(plan!.record!)
  const scopeStore = store.scope(scope)
  assert.equal(scopeStore.retiredIds().has(older.id), true)
  assert.equal(scopeStore.retiredIds().has(newer.id), false)
  assert.deepEqual(store.lineage(newer.id)!.entries.map((entry) => entry.id), [older.id, newer.id])
  assert.equal(store.findById(older.id)!.content, '重复的旧内容', '被合并的旧记录正文不删')

  // 阈值以下不合并
  assert.equal(planNearDuplicateMerge(newer, older, 0.9), null)
  // keep 自己已有别的更早版本 → 单值 supersedes 接不了两条链,交人工
  const root = save(store, scope, '更早的根版本')
  const keep = save(store, scope, '已有前驱的版本', { supersedes: root.id })
  const drop = save(store, scope, '另一条重复')
  assert.equal(planNearDuplicateMerge(keep, drop, 0.99), null)
  // 合并会清掉休眠 / 冲突标记(分歧已被合并解决)
  const dormant = save(store, scope, '睡着的重复', { importance: 0.1, conflictWith: [older.id], conflictConfidence: 0.8 })
  const awake = save(store, scope, '醒着的重复')
  scopeStore.insert({ ...dormant, dormantAt: 1 })
  const merged = planNearDuplicateMerge(awake, store.findById(dormant.id)!, 0.95)!
  assert.equal((merged.record as unknown as { dormantAt?: number }).dormantAt, undefined)
  assert.equal((merged.record as unknown as { conflictWith?: string[] }).conflictWith, undefined)
})
