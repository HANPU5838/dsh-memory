/**
 * 0.62.5：空会话作用域的回收。
 *
 * 系统给每个会话自动建 `session:<id>` 元数据，但从不回收——开 N 次会话就攒 N 个
 * 空作用域，目录会越拉越长。清理必须只碰"从没用过"的：有记录、还年轻、已归档、
 * 非会话作用域一律不动。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScopeMetaStore, pruneEmptySessionScopes } from '../src/scope-meta.ts'

const DAY = 86_400_000

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-mem-prune-'))
}

/** 直接落一个指定年龄的元数据文件（put() 只会写 now，测试需要可控时间）。 */
function seed(store: ScopeMetaStore, scope: string, ageMs: number, origin: 'session' | 'project') {
  const now = Date.now()
  const meta = {
    schemaVersion: 1,
    scope,
    description: '测试',
    origin,
    createdBy: 'system',
    createdAt: now - ageMs,
    updatedAt: now - ageMs,
    generation: 'g-1',
    status: 'ready',
  }
  mkdirSync(store.dir, { recursive: true })
  writeFileSync(store.fileFor(scope), `${JSON.stringify(meta)}\n`, 'utf8')
}

test('空会话作用域：过期才删，活跃的留着', () => {
  const root = tempRoot()
  try {
    const store = new ScopeMetaStore({ root })
    seed(store, 'session:old-empty', 2 * DAY, 'session')
    seed(store, 'session:young-empty', 0.1 * DAY, 'session')
    const removed = pruneEmptySessionScopes(store, {
      maxAgeMs: DAY,
      hasRecords: () => false,
    })
    assert.deepEqual(removed, ['session:old-empty'])
    assert.equal(store.has('session:old-empty'), false)
    assert.equal(store.has('session:young-empty'), true, '活跃会话的元数据不能动')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('有记录的会话作用域永不删除（哪怕很老）', () => {
  const root = tempRoot()
  try {
    const store = new ScopeMetaStore({ root })
    seed(store, 'session:has-records', 30 * DAY, 'session')
    const removed = pruneEmptySessionScopes(store, {
      maxAgeMs: DAY,
      hasRecords: (scope) => scope === 'session:has-records',
    })
    assert.deepEqual(removed, [])
    assert.equal(store.has('session:has-records'), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('只碰会话作用域：项目作用域再老也不删', () => {
  const root = tempRoot()
  try {
    const store = new ScopeMetaStore({ root })
    seed(store, 'project:/w', 365 * DAY, 'project')
    seed(store, 'session:old-empty', 2 * DAY, 'session')
    const removed = pruneEmptySessionScopes(store, { maxAgeMs: DAY, hasRecords: () => false })
    assert.deepEqual(removed, ['session:old-empty'])
    assert.equal(store.has('project:/w'), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('冻结作用域（已归档会话）跳过', () => {
  const root = tempRoot()
  try {
    const store = new ScopeMetaStore({ root })
    seed(store, 'session:archived', 30 * DAY, 'session')
    const removed = pruneEmptySessionScopes(store, {
      maxAgeMs: DAY,
      hasRecords: () => false,
      frozen: (scope) => scope === 'session:archived',
    })
    assert.deepEqual(removed, [])
    assert.equal(store.has('session:archived'), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('maxAgeMs<=0 表示禁用：一个都不删', () => {
  const root = tempRoot()
  try {
    const store = new ScopeMetaStore({ root })
    seed(store, 'session:old-empty', 30 * DAY, 'session')
    assert.deepEqual(pruneEmptySessionScopes(store, { maxAgeMs: 0, hasRecords: () => false }), [])
    assert.equal(store.has('session:old-empty'), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
