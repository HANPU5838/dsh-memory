import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService } from '../src/index.ts'
import { ScopeArchiveStore } from '../src/scope-archive.ts'
import { MemoryBlocksStore, blockMatchesRecord } from '../src/blocks.ts'

/**
 * 0.32.0：项目作用域归档 + Agent 屏蔽。
 *
 * 归档与屏蔽是**两个不同概念**，测试刻意分开断言：
 *   - 归档 = 用户层面的生命周期状态（项目作用域绑定工作区，工作区删除时
 *     自动归档、重新加入时自动恢复），没有审批路径；
 *   - 屏蔽 = Agent 主动降噪（会话级 / 工作区级），按 id 不审批、按作用域审批。
 */

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function makeService(): { svc: LocalMemoryService; dir: string; done(): void } {
  const dir = tempDir('dsh-memory-block-')
  const svc = new LocalMemoryService({ storeDir: dir })
  return {
    svc,
    dir,
    done: () => {
      try { svc.flushSync() } catch { /* 已 flush */ }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const agent = (id = 's1', cwd = 'D:/w') => ({ session: { header: { id, cwd } } })

// ---------------------------------------------------------------- ScopeArchiveStore

test('ScopeArchiveStore：归档 / 解除 / 幂等，只接受 project: 键', () => {
  const dir = tempDir('dsh-memory-archive-store-')
  try {
    const store = new ScopeArchiveStore({ root: dir })
    assert.deepEqual(store.list(), [])
    assert.equal(store.archive('session:s1', 'user'), undefined, 'session 键不由这里持久化')
    const entry = store.archive('project:D:/w', 'user', '旧项目')
    assert.ok(entry)
    assert.equal(entry!.scope, 'project:D:/w')
    assert.equal(entry!.note, '旧项目')
    assert.equal(store.has('project:D:/w'), true)
    // 幂等：重复归档不产生第二条，也不改原归档时间。
    const again = store.archive('project:D:/w', 'user')
    assert.equal(again!.archivedAt, entry!.archivedAt)
    assert.equal(store.list().length, 1)
    // 落盘格式
    const raw = JSON.parse(readFileSync(join(dir, 'archive', 'project.json'), 'utf8'))
    assert.equal(raw.version, 1)
    assert.equal(raw.entries.length, 1)
    // 新实例从盘上读回
    const reopened = new ScopeArchiveStore({ root: dir })
    assert.equal(reopened.has('project:D:/w'), true)
    assert.equal(reopened.restore('project:D:/w'), true)
    assert.equal(reopened.restore('project:D:/w'), false, '再解除一次返回 false')
    assert.equal(reopened.list().length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ScopeArchiveStore：损坏文件退化为"没有归档"，不抛错', () => {
  const dir = tempDir('dsh-memory-archive-bad-')
  try {
    mkdirSync(join(dir, 'archive'), { recursive: true })
    writeFileSync(join(dir, 'archive', 'project.json'), '{ 不是 json', 'utf8')
    const warned: string[] = []
    const store = new ScopeArchiveStore({ root: dir, warn: (m) => warned.push(m) })
    assert.deepEqual(store.list(), [])
    assert.equal(warned.length, 1)
    // 写一次就把文件修好了
    assert.ok(store.archive('project:D:/w', 'user'))
    assert.equal(new ScopeArchiveStore({ root: dir }).has('project:D:/w'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ScopeArchiveStore.reconcile：工作区消失 → dormant；重新出现 → 自动解除归档', () => {
  const dir = tempDir('dsh-memory-archive-reconcile-')
  try {
    const store = new ScopeArchiveStore({ root: dir })
    store.archive('project:D:/a', 'user')
    store.archive('project:D:/b', 'user')
    let present = new Set(['D:/a', 'D:/b'])
    const exists = (scope: string): boolean => present.has(scope.slice('project:'.length))
    assert.deepEqual(store.reconcile(exists), [], '都在 → 不动')
    // D:/b 被删除：归档保留，但标 dormant。
    present = new Set(['D:/a'])
    assert.deepEqual(store.reconcile(exists), [])
    assert.equal(store.list().find((e) => e.scope === 'project:D:/b')!.dormant, true)
    assert.equal(store.list().find((e) => e.scope === 'project:D:/a')!.dormant, undefined)
    // D:/b 重新加入：自动解除归档。
    present = new Set(['D:/a', 'D:/b'])
    assert.deepEqual(store.reconcile(exists), ['project:D:/b'])
    assert.deepEqual(store.list().map((e) => e.scope), ['project:D:/a'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ScopeArchiveStore.reconcile：宿主查询抛错时保持现状（绝不误删归档）', () => {
  const dir = tempDir('dsh-memory-archive-throw-')
  try {
    const store = new ScopeArchiveStore({ root: dir })
    store.archive('project:D:/a', 'user')
    const restored = store.reconcile(() => { throw new Error('registry down') })
    assert.deepEqual(restored, [])
    assert.equal(store.has('project:D:/a'), true)
    assert.equal(store.list()[0]!.dormant, undefined, '查询失败不算"工作区没了"')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- 服务侧归档

test('项目作用域归档：检索 / 枚举 / 取回立刻不可见，解除后原样回来', async () => {
  const { svc, dir, done } = makeService()
  try {
    const scope = 'project:D:/proj'
    await svc.save({ content: '项目里的一条记忆', scope, kind: 'fact' })
    assert.equal(svc.listSync({ scopes: [scope] }).length, 1)
    assert.equal((await svc.search({ text: '项目', scopes: [scope], topK: 5 })).length, 1)

    const entry = svc.archiveScope(scope, 'user')
    assert.equal(entry.kind, 'project')
    assert.equal(svc.isArchivedScope(scope), true)
    assert.equal(svc.listSync({ scopes: [scope] }).length, 0, '归档后不参与枚举')
    assert.equal((await svc.search({ text: '项目', scopes: [scope], topK: 5 })).length, 0, '归档后不参与检索')
    assert.equal(svc.getByIds(['']).length, 0)
    // 数据文件还在（scope 在存储里是规范形：Windows 路径用反斜杠）
    const stat = svc.scopeStats().find((s) => s.scope.startsWith('project:'))!
    assert.equal(stat.records, 1, '记忆没被删')
    // 目录如实标出归档 + 来源
    const row = svc.scopeCatalog(agent()).find((item) => item.scope === stat.scope)
    assert.equal(row?.archived, true)
    assert.equal(row?.archivedKind, 'project')
    // 写入被拒（带 agent 才走可见域授权，归档在授权里报 SCOPE_ARCHIVED）
    await assert.rejects(
      () => svc.save({ content: '归档后写入', scope, kind: 'fact', agent: agent() } as never),
      (error: { code?: string }) => error.code === 'SCOPE_ARCHIVED',
    )
    // 解除归档后立刻复原
    assert.equal(svc.restoreScope(scope), true)
    assert.equal(svc.isArchivedScope(scope), false)
    assert.equal(svc.listSync({ scopes: [scope] }).length, 1)
    assert.equal((await svc.search({ text: '项目', scopes: [scope], topK: 5 })).length, 1)
  } finally {
    done()
  }
})

test('只有 project: 键可归档；global / 自定义 / session 明确报 SCOPE_NOT_ARCHIVABLE', () => {
  const { svc, done } = makeService()
  try {
    for (const scope of ['global', 'handbook', 'session:s1']) {
      assert.throws(
        () => svc.archiveScope(scope, 'user'),
        (error: { code?: string }) => error.code === 'SCOPE_NOT_ARCHIVABLE',
        `${scope} 不应可归档`,
      )
    }
    assert.ok(svc.archiveScope('project:D:/x', 'user'))
  } finally {
    done()
  }
})

test('宿主对账：工作区删除 → 仍不参与检索；重新加入 → 自动恢复', async () => {
  const { svc, done } = makeService()
  try {
    const scope = 'project:D:/proj'
    await svc.save({ content: '项目记忆', scope, kind: 'fact' })
    svc.archiveScope(scope, 'user')
    let present = true
    svc.setWorkspaceExistsLookup(() => present)
    svc.reconcileArchivedScopesNow(true)
    assert.equal(svc.listSync({ scopes: [scope] }).length, 0, '工作区还在时归档照旧')
    // 工作区被删除：归档转 dormant，记忆继续隐藏。
    present = false
    svc.reconcileArchivedScopesNow(true)
    assert.equal(svc.listSync({ scopes: [scope] }).length, 0)
    assert.equal(svc.archivedProjectScopes()[0]!.dormant, true)
    // 工作区重新加入：自动解除归档（作用域键在存储里是规范形）。
    present = true
    const restored = svc.reconcileArchivedScopesNow(true)
    assert.deepEqual(restored, ['project:D:\\proj'])
    assert.equal(svc.listSync({ scopes: [scope] }).length, 1, '重新加入后自动恢复')
  } finally {
    done()
  }
})

// ---------------------------------------------------------------- 屏蔽

test('MemoryBlocksStore：会话级 / 工作区级落不同文件，按作用域与按 id 都能命中', () => {
  const dir = tempDir('dsh-memory-blocks-store-')
  try {
    const store = new MemoryBlocksStore({ root: dir })
    const sessionList = store.add('session', 's1', { scope: 'session:s1', createdBy: 's1', reason: '噪声' })
    assert.equal(sessionList.length, 1)
    const sessionBlock = sessionList[0]!
    assert.ok(sessionBlock.id)
    const workspaceList = store.add('workspace', 'project:D:/w', { prefix: 'abcd1234', createdBy: 's1' })
    const workspaceBlock = workspaceList[0]!
    assert.ok(workspaceBlock.id)
    assert.notEqual(sessionBlock.id, workspaceBlock.id)
    assert.equal(store.list('session', 's1').length, 1)
    assert.equal(store.list('workspace', 'project:D:/w').length, 1)
    assert.equal(store.list('workspace', 'project:D:/other').length, 0, '工作区之间不串')
    // 命中判定
    assert.equal(blockMatchesRecord(sessionBlock, { id: 'x', scope: 'session:s1' }), true)
    assert.equal(blockMatchesRecord(sessionBlock, { id: 'x', scope: 'session:s2' }), false)
    assert.equal(blockMatchesRecord(workspaceBlock, { id: 'abcd1234ef', scope: 'global' }), true)
    assert.equal(blockMatchesRecord(workspaceBlock, { id: 'zzz', scope: 'global' }), false)
    // 同目标去重
    store.add('session', 's1', { scope: 'session:s1', createdBy: 's1' })
    assert.equal(store.list('session', 's1').length, 1, '同一目标不重复')
    // 落盘
    const files = readFileSync(join(dir, 'blocks', 'session', 's1.json'), 'utf8')
    assert.match(files, /"level": "session"/)
    // 新实例读回
    assert.equal(new MemoryBlocksStore({ root: dir }).list('session', 's1').length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('MemoryBlocksStore：损坏文件退化为空，key 不匹配时忽略（防 hash 碰撞串数据）', () => {
  const dir = tempDir('dsh-memory-blocks-bad-')
  try {
    const warned: string[] = []
    mkdirSync(join(dir, 'blocks', 'session'), { recursive: true })
    writeFileSync(join(dir, 'blocks', 'session', 's1.json'), 'not json', 'utf8')
    const store = new MemoryBlocksStore({ root: dir, warn: (m) => warned.push(m) })
    assert.deepEqual(store.list('session', 's1'), [])
    assert.equal(warned.length, 1)
    // key 不匹配 = 忽略
    writeFileSync(join(dir, 'blocks', 'session', 's2.json'), JSON.stringify({
      version: 1, key: 'other', level: 'session', blocks: [{ id: 'x', level: 'session', scope: 'session:s2', createdAt: 1, createdBy: 'u' }],
    }), 'utf8')
    store.invalidate('session', 's2')
    assert.deepEqual(store.list('session', 's2'), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('屏蔽按 id：不弹审批，记录立刻从检索 / 枚举 / 取回里消失', async () => {
  const { svc, done } = makeService()
  try {
    const saved = await svc.save({ content: '无关的记忆', scope: 'global', kind: 'note' })
    let approvals = 0
    svc.requestOutOfScope = async () => { approvals++; return 'allowed-once' }
    const result = await svc.requestBlock(agent(), { id: saved.id.slice(0, 8), description: '降噪' })
    assert.equal(result.outcome, 'blocked')
    assert.equal(approvals, 0, '按 id 屏蔽不需要审批')
    assert.equal(result.blocks.length, 1)
    assert.equal(result.blocks[0]!.recordId, saved.id, '解析到了就写精确 id')
    assert.equal(svc.isRecordBlocked(agent(), { id: saved.id, scope: saved.scope }), true)
    assert.equal((await svc.search({ text: '无关', topK: 5, agent: agent() } as never)).length, 0)
    assert.equal(svc.listSync({ scopes: ['global'], sessionId: 's1' }).length, 0)
    assert.equal(svc.getByIds([saved.id], agent()).length, 0)
    // 别的会话不受会话级屏蔽影响
    assert.equal(svc.getByIds([saved.id], agent('other')).length, 1)
    // 解除后复原
    assert.equal(svc.unblock(agent(), { recordId: saved.id }).length > 0, true)
    assert.equal((await svc.search({ text: '无关', topK: 5, agent: agent() } as never)).length, 1)
  } finally {
    done()
  }
})

test('屏蔽按作用域：必须弹审批；用户拒绝则不生效', async () => {
  const { svc, done } = makeService()
  try {
    await svc.save({ content: '另一条', scope: 'global', kind: 'note' })
    let approvals = 0
    svc.requestOutOfScope = async () => { approvals++; return 'rejected' }
    const rejected = await svc.requestBlock(agent(), { scope: 'global', description: '降噪' })
    assert.equal(approvals, 1, '按作用域屏蔽必须弹审批')
    assert.equal(rejected.outcome, 'rejected')
    assert.equal(svc.isScopeBlocked(agent(), 'global'), false)
    assert.equal((await svc.search({ text: '另一条', topK: 5, agent: agent() } as never)).length, 1, '拒绝后记忆照旧')
    // 允许后生效
    svc.requestOutOfScope = async () => 'allowed-once'
    const allowed = await svc.requestBlock(agent(), { scope: 'global', description: '降噪' })
    assert.equal(allowed.outcome, 'blocked')
    assert.equal(svc.isScopeBlocked(agent(), 'global'), true)
    assert.equal((await svc.search({ text: '另一条', topK: 5, agent: agent() } as never)).length, 0)
  } finally {
    done()
  }
})

test('屏蔽规则：即使按 id 也必须弹审批（重要规则不能被静默丢弃）', async () => {
  const { svc, done } = makeService()
  try {
    const rule = await svc.save({ content: '永远先读 CHANGELOG', scope: 'global', kind: 'rule' })
    let approvals = 0
    svc.requestOutOfScope = async () => { approvals++; return 'rejected' }
    const result = await svc.requestBlock(agent(), { id: rule.id.slice(0, 8), description: '降噪' })
    assert.equal(approvals, 1, '规则屏蔽必须审批')
    assert.equal(result.containsRule, true)
    assert.equal(result.outcome, 'rejected')
    assert.equal(svc.isRecordBlocked(agent(), { id: rule.id, scope: rule.scope }), false)
  } finally {
    done()
  }
})

test('工作区级屏蔽影响同工作区的其它会话，且必须审批', async () => {
  const { svc, done } = makeService()
  try {
    const saved = await svc.save({ content: '工作区噪声', scope: 'global', kind: 'note' })
    let approvals = 0
    svc.requestOutOfScope = async () => { approvals++; return 'allowed-once' }
    const result = await svc.requestBlock(agent('s1', 'D:/w'), {
      id: saved.id.slice(0, 8),
      level: 'workspace',
      description: '降噪',
    })
    assert.equal(approvals, 1, '工作区级必须审批')
    assert.equal(result.outcome, 'blocked')
    assert.equal(result.blocks[0]!.level, 'workspace')
    // 同工作区的另一个会话也看不到
    assert.equal(svc.getByIds([saved.id], agent('s2', 'D:/w')).length, 0)
    // 别的工作区不受影响
    assert.equal(svc.getByIds([saved.id], agent('s3', 'D:/other')).length, 1)
  } finally {
    done()
  }
})

test('会话级屏蔽按 id 不审批，且不跨会话', async () => {
  const { svc, done } = makeService()
  try {
    const saved = await svc.save({ content: '会话噪声', scope: 'global', kind: 'note' })
    let approvals = 0
    svc.requestOutOfScope = async () => { approvals++; return 'allowed-once' }
    const result = await svc.requestBlock(agent('s1'), { id: saved.id, level: 'session', description: '降噪' })
    assert.equal(approvals, 0, '会话级按 id 不需要审批')
    assert.equal(result.outcome, 'blocked')
    assert.equal(svc.isRecordBlocked(agent('s1'), { id: saved.id, scope: saved.scope }), true)
    assert.equal(svc.isRecordBlocked(agent('s2'), { id: saved.id, scope: saved.scope }), false, '不跨会话')
  } finally {
    done()
  }
})

test('blockFilterFor：注入侧用 sessionId + scopes 也能过滤（没有 agent 对象）', async () => {
  const { svc, done } = makeService()
  try {
    await svc.save({ content: '注入噪声', scope: 'session:s1', kind: 'note' })
    svc.requestOutOfScope = async () => 'allowed-once'
    await svc.requestBlock(agent('s1'), { scope: 'session:s1', level: 'session', description: '降噪' })
    assert.equal(svc.listSync({ scopes: ['session:s1'], sessionId: 's1' }).length, 0, '按 sessionId 过滤')
    assert.equal(svc.listSync({ scopes: ['session:s1'], sessionId: 's2' }).length, 1, '别的会话不受影响')
  } finally {
    done()
  }
})
