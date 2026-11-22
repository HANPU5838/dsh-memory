import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService } from '../src/index.ts'
import {
  defaultInjectSettings,
  mergeInjectSettings,
  normalizeInjectSettings,
} from '../src/inject-settings.ts'

function fresh(dir, config = {}) {
  return new LocalMemoryService({ storeDir: dir, scopes: { global: true, project: true }, ...config })
}

test('normalizeInjectSettings: 默认值、越界夹紧、脏数据不炸', () => {
  assert.deepEqual(normalizeInjectSettings(undefined), defaultInjectSettings)
  assert.deepEqual(normalizeInjectSettings('nonsense'), defaultInjectSettings)
  const clamped = normalizeInjectSettings({
    recall: { topK: 999, tokenBudget: 1 },
    impression: { chars: 5 },
    rules: { maxItems: 0 },
  })
  assert.equal(clamped.recall.topK, 20)
  assert.equal(clamped.recall.tokenBudget, 50)
  assert.equal(clamped.impression.chars, 40)
  assert.equal(clamped.rules.maxItems, 1)
  // 规则变更提醒默认开:老 settings.json 没有这个字段时不能静默关掉
  assert.equal(clamped.rules.delta, true)
  assert.equal(normalizeInjectSettings({ rules: { delta: false } }).rules.delta, false)
})

test('normalizeInjectSettings: 老的扁平 inject 配置映射到 recall', () => {
  const settings = normalizeInjectSettings({ enabled: false, topK: 3, tokenBudget: 222 })
  assert.equal(settings.recall.enabled, false)
  assert.equal(settings.recall.topK, 3)
  assert.equal(settings.recall.tokenBudget, 222)
  // 摘要 / 规则等新开关保持默认
  assert.equal(settings.digest.enabled, defaultInjectSettings.digest.enabled)
  assert.equal(settings.rules.enabled, defaultInjectSettings.rules.enabled)
})

test('mergeInjectSettings: 只合并已知字段,其余保持原值', () => {
  const merged = mergeInjectSettings(defaultInjectSettings, {
    digest: { enabled: false },
    nope: { enabled: true },
  })
  assert.equal(merged.digest.enabled, false)
  assert.equal(merged.digest.topK, defaultInjectSettings.digest.topK)
  assert.equal(merged.recall.enabled, true)
  assert.equal(Object.hasOwn(merged, 'nope'), false)
})

test('provider: updateInjectSettings 落盘,重启后读回来', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-settings-'))
  try {
    const svc = fresh(dir)
    const next = svc.updateInjectSettings({ impression: { enabled: false, chars: 88 }, turnEnd: { enabled: true } })
    assert.equal(next.impression.enabled, false)
    assert.equal(next.impression.chars, 88)
    assert.equal(next.turnEnd.enabled, true)
    assert.ok(existsSync(join(dir, 'settings.json')))
    const onDisk = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
    assert.equal(onDisk.impression.chars, 88)
    svc.flushSync()

    const reopened = fresh(dir)
    assert.equal(reopened.injectSettings().impression.enabled, false)
    assert.equal(reopened.injectSettings().impression.chars, 88)
    assert.equal(reopened.injectSettings().turnEnd.enabled, true)
    reopened.flushSync()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('provider: listSync 只读已加载的 scope,按 kind 过滤', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-settings-'))
  try {
    const svc = fresh(dir)
    await svc.save({ scope: 'project:x', kind: 'rule', content: '规则甲' })
    await svc.save({ scope: 'project:x', kind: 'note', content: '普通记录' })
    await svc.save({ scope: 'global', kind: 'rule', content: '全局规则' })
    const rules = svc.listSync({ scopes: ['project:x', 'global'], kind: 'rule' })
    assert.deepEqual(rules.map((r) => r.content).sort(), ['全局规则', '规则甲'])
    assert.equal(svc.listSync({ scopes: ['project:x'], kind: 'note' }).length, 1)
    svc.flushSync()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('sidebar: 默认开启,面板可把它关掉', () => {
  assert.equal(normalizeInjectSettings(undefined).sidebar.enabled, true)
  const merged = mergeInjectSettings(defaultInjectSettings, { sidebar: { enabled: false } })
  assert.equal(merged.sidebar.enabled, false)
})

test('provider: listSync 默认退役 superseded 旧规则,includeSuperseded 可取回历史', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-supersede-'))
  try {
    const svc = fresh(dir)
    const old = await svc.save({ scope: 'project:x', kind: 'rule', content: '旧规则' })
    const next = await svc.save({ scope: 'project:x', kind: 'rule', content: '新规则', supersedes: old.id })
    assert.deepEqual(svc.supersededIds(['project:x']), [old.id])
    assert.deepEqual(svc.listSync({ scopes: ['project:x'], kind: 'rule' }).map((r) => r.content), ['新规则'])
    assert.deepEqual(
      svc.listSync({ scopes: ['project:x'], kind: 'rule', includeSuperseded: true }).map((r) => r.content).sort(),
      ['新规则', '旧规则'],
    )
    assert.equal(next.supersedes, old.id)
    svc.flushSync()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('provider: injectAudit 由注入半边挂载后可查询,未挂载时为空', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-audit-'))
  try {
    const svc = fresh(dir)
    assert.deepEqual(svc.injectAudit(), [])
    svc.attachInjectAudit({ list: (sessionId?: string) => [{ sessionId: sessionId ?? 'all' }] })
    assert.deepEqual(svc.injectAudit('s1'), [{ sessionId: 's1' }])
    assert.equal((svc.injectAuditPage({ sessionId: 's1', limit: 2 }) as { total: number }).total, 1)
    assert.equal((svc.injectAuditStats() as { persistence: string }).persistence, 'memory')
    // 显式解绑：插件半边卸载后不能再读到旧 store。
    svc.attachInjectAudit(null)
    assert.deepEqual(svc.injectAudit(), [])
    svc.flushSync()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('provider: 类型化 audit sink 的 query/stats 直接透传,dispose 只调用一次', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-audit-v2-'))
  try {
    const svc = fresh(dir)
    let disposed = 0
    const page = { entries: [{ id: 'e1' }], total: 1, nextCursor: '1', stats: { capacity: 200 } }
    svc.attachInjectAudit({
      list: () => [],
      query: (query?: unknown) => ({ ...page, query }),
      stats: () => ({ entries: 1, capacity: 200, dropped: 0, writeErrors: 0, persistence: 'memory' }),
      dispose: () => { disposed += 1 },
    })
    const value = svc.injectAuditPage({ sessionId: 's1' }) as { total: number; query: unknown }
    assert.equal(value.total, 1)
    assert.deepEqual(value.query, { sessionId: 's1' })
    assert.equal((svc.injectAuditStats() as { capacity: number }).capacity, 200)
    svc.flushSync()
    assert.equal(disposed, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('provider: 0.9.5 的旧默认 digest 400 迁移到 800,显式 hintBudget 的配置不动', () => {
  const oldDir = mkdtempSync(join(tmpdir(), 'dsh-memory-migrate-'))
  const explicitDir = mkdtempSync(join(tmpdir(), 'dsh-memory-migrate-'))
  try {
    writeFileSync(join(oldDir, 'settings.json'), JSON.stringify({ digest: { enabled: true, topK: 8, tokenBudget: 400 } }))
    const oldSvc = fresh(oldDir)
    assert.equal(oldSvc.injectSettings().digest.tokenBudget, 800)
    assert.equal(oldSvc.injectSettings().digest.hintBudget, 160)
    oldSvc.flushSync()

    writeFileSync(join(explicitDir, 'settings.json'), JSON.stringify({ digest: { enabled: true, topK: 8, tokenBudget: 400, hintBudget: 80 } }))
    const explicitSvc = fresh(explicitDir)
    assert.equal(explicitSvc.injectSettings().digest.tokenBudget, 400)
    assert.equal(explicitSvc.injectSettings().digest.hintBudget, 80)
    explicitSvc.flushSync()
  } finally {
    rmSync(oldDir, { recursive: true, force: true })
    rmSync(explicitDir, { recursive: true, force: true })
  }
})

test('autoRecall: 默认标签覆盖多个域,自定义标签可增删去重', () => {
  const defaults = normalizeInjectSettings(undefined)
  assert.equal(defaults.autoRecall.enabled, true)
  assert.equal(defaults.autoRecall.useToolDescription, true)
  assert.equal(defaults.autoRecall.useMemoryTags, true)
  assert.ok(defaults.autoRecall.tags.length >= 20)
  for (const tag of ['release', 'deploy', 'database', 'migration', 'credentials', 'delete', '发布', '部署']) {
    assert.ok(defaults.autoRecall.tags.includes(tag), `默认标签缺少 ${tag}`)
  }

  const custom = normalizeInjectSettings({
    autoRecall: {
      enabled: false,
      useToolDescription: false,
      useMemoryTags: false,
      maxQueryChars: 9999,
      tags: ['release', 'Release', ' custom ', '', 42, 'custom'],
    },
  })
  assert.equal(custom.autoRecall.enabled, false)
  assert.equal(custom.autoRecall.useToolDescription, false)
  assert.equal(custom.autoRecall.useMemoryTags, false)
  assert.equal(custom.autoRecall.maxQueryChars, 500)
  assert.deepEqual(custom.autoRecall.tags, ['release', 'custom'])

  const empty = normalizeInjectSettings({ autoRecall: { tags: [] } })
  assert.deepEqual(empty.autoRecall.tags, [], '显式空额外标签;仍会使用记忆库标签/failure 召回')
})

test('0.70.0: impression.dynamic 默认开启、可显式关闭', () => {
  const defaults = normalizeInjectSettings({})
  assert.equal(defaults.impression.dynamic, true)
  const off = normalizeInjectSettings({ impression: { dynamic: false } })
  assert.equal(off.impression.dynamic, false)
})

test('0.72.0: graph 设置默认开/权重 0.8，可关闭与夹紧', () => {
  const defaults = normalizeInjectSettings({})
  assert.deepEqual(defaults.graph, { enabled: true, weight: 0.8 })
  const off = normalizeInjectSettings({ graph: { enabled: false } })
  assert.equal(off.graph.enabled, false)
  assert.equal(normalizeInjectSettings({ graph: { weight: 9 } }).graph.weight, 1.5)
  assert.equal(normalizeInjectSettings({ graph: { weight: 0.01 } }).graph.weight, 0.2)
  assert.equal(normalizeInjectSettings({ graph: { weight: 'abc' } }).graph.weight, 0.8, '非法值回落默认')
})
