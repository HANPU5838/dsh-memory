/**
 * 0.108.0：工程师审计确认的 P1/P2 回归测试
 * （路径穿越、密钥绕过、跨作用域 supersedes 冷加载、规则休眠、before-inject N²、试跑审批）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService } from '../src/index.ts'
import { installPaths } from '../src/embed-install.ts'
import { markDormant } from '../src/cognitive/lifecycle.ts'

function open(dir: string, scopes = { global: true, project: true, session: true, custom: true }) {
  return new LocalMemoryService({ storeDir: dir, scopes, retrieval: { vector: { enabled: false } } })
}

test('0.108.0：installPaths 拒绝模型文件名路径穿越', () => {
  assert.throws(() => installPaths('/tmp/root', '../../.bashrc'))
  assert.throws(() => installPaths('/tmp/root', 'dir/model.gguf'))
  assert.equal(installPaths('/tmp/root', 'model.gguf').model, join('/tmp/root', 'models', 'model.gguf'))
})

test('0.108.0：密钥扫描覆盖 tags / scopeRule / scopeDescription', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-secret-fields-'))
  const svc = open(dir)
  try {
    const secret = 'sk-abcdefghijklmnop123456'
    await assert.rejects(
      () => svc.save({ scope: 'global', kind: 'note', content: '内容足够长的普通记录', tags: [`api_key: ${secret}`] }),
      /SECRET_DETECTED/,
      'tags 里的密钥必须被拒绝',
    )
    await assert.rejects(
      () => svc.save({ scope: 'handbook2', kind: 'fact', content: '内容足够长的普通记录', scopeDescription: 'x', scopeRule: `password: ${secret}` }),
      /SECRET_DETECTED/,
      'scopeRule 里的密钥必须被拒绝',
    )
    await assert.rejects(
      () => svc.save({ scope: 'handbook3', kind: 'fact', content: '内容足够长的普通记录', scopeDescription: `token: ${secret}` }),
      /SECRET_DETECTED/,
      'scopeDescription 里的密钥必须被拒绝',
    )
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.108.0：冷进程跨作用域 supersedes 不再误报 SUPERSEDES_UNKNOWN', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-supersede-cross-'))
  try {
    const first = open(dir)
    const old = await first.save({ scope: 'handbook', kind: 'fact', content: '旧结论：端口 8080', scopeDescription: '手册' })
    first.flushSync()

    // 新实例：不 touch handbook，直接写 global 修正版。
    const cold = open(dir)
    const revised = await cold.save({ scope: 'global', kind: 'fact', content: '新结论：端口 9090', supersedes: old.id })
    assert.ok(revised.id !== old.id)
    assert.equal(revised.supersedes, old.id)
    cold.flushSync()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.108.0：markDormant 不把 rule / preference 静默休眠', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-dormant-rule-'))
  const svc = open(dir)
  try {
    const note = await svc.save({ scope: 'global', kind: 'note', content: '一条普通低重要度备注', importance: 0.1 })
    const rule = await svc.save({ scope: 'global', kind: 'rule', content: '发布前必须跑 verify:all', importance: 0.1 })
    const pref = await svc.save({ scope: 'global', kind: 'preference', content: '偏好：回复用中文', importance: 0.1 })
    const old = Date.now() - 90 * 86_400_000
    for (const rec of [note, rule, pref]) svc.store.updateMetrics(rec.id, { lastUsedAt: old, lastAccessedAt: old } as never)
    const result = markDormant(svc.store, { afterDays: 0, maxImportance: 1 })
    assert.ok(result.marked.includes(note.id), '普通 note 应休眠')
    assert.ok(!result.marked.includes(rule.id), 'rule 不能被休眠')
    assert.ok(!result.marked.includes(pref.id), 'preference 不能被休眠')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.108.0：before-inject 每个钩子只执行一次（不再 N²）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-inject-hooks-once-'))
  const svc = open(dir)
  try {
    svc.updateHookSettings({ requireApproval: false, timeoutMs: 200 })
    const h1 = svc.saveHook({ phase: 'before-inject', name: 'h1', code: 'function parse(input){ return { ok: true } }' })
    const h2 = svc.saveHook({ phase: 'before-inject', name: 'h2', code: 'function parse(input){ return { ok: true } }' })
    const record = await svc.save({ scope: 'global', kind: 'note', content: '一条会被注入的记录' })
    svc.parseForInject([record])
    const hooks = svc.listHooks()
    assert.equal(hooks.find((hook) => hook.id === h1.id)?.runCount, 1, 'h1 只能执行一次')
    assert.equal(hooks.find((hook) => hook.id === h2.id)?.runCount, 1, 'h2 只能执行一次')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.108.0：未批准脚本试跑时可执行，但结果明确标记 unapproved 并提示 vm 非安全边界', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hook-trial-'))
  const svc = open(dir)
  try {
    const hook = svc.saveHook({ phase: 'before-save', name: '未批准', code: 'function verify(){ return { ok: true } }' })
    assert.equal(svc.hookPendingApproval(hook.id), true)
    const outcomes = svc.runHookTrial(hook.id, {
      memory: { id: 'x', scope: 'global', kind: 'note', content: '内容', tags: [], importance: 0.5, createdAt: 0, updatedAt: 0 },
    })
    assert.equal(outcomes.length, 1)
    const outcome = outcomes[0] as { unapproved?: boolean; message?: string }
    assert.equal(outcome.unapproved, true, '必须标记 unapproved')
    assert.match(String(outcome.message ?? ''), /未批准/)
    assert.equal(svc.listHooks().find((item) => item.id === hook.id)?.runCount ?? 0, 0, '试跑不记正式统计')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})
