/**
 * 0.33.0 集成回归：强度排序、取用反馈、事实有效期过滤。
 * 算法本身在 retrieval 与 cognitive 的单测里；这里锁定「接到 provider 上」的行为。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService } from '../src/index.ts'

const SCOPE = 'project:/integ'

function makeService(dir: string, retrieval: Record<string, unknown> = {}) {
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true, project: true }, retrieval })
  svc.setProjectScope(SCOPE)
  return svc
}

test('memory_get 触发取用反馈：utility / useCount / stability 都会增长', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-magic-feedback-'))
  const svc = makeService(dir)
  try {
    const rec = await svc.save({ scope: SCOPE, kind: 'procedure', content: '发布前先跑回归测试。' })
    const before = svc.store.peek(SCOPE)!.records.get(rec.id) as { utility?: number; useCount?: number; stability?: number }
    assert.equal(before.useCount ?? 0, 0)
    await svc.getByIds([rec.id])
    const after = svc.store.peek(SCOPE)!.records.get(rec.id) as { utility?: number; useCount?: number; stability?: number }
    assert.equal(after.useCount, 1, '成功取用一次')
    assert.ok((after.utility ?? 0) > 0, 'utility 被 EWMA 提升')
    assert.ok((after.stability ?? 0) > (before.stability ?? 0), 'stability 越用越大')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('强度排序：同等相关度下，被取用过的记忆排在未被取用的前面', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-magic-strength-'))
  const svc = makeService(dir)
  try {
    const used = await svc.save({ scope: SCOPE, kind: 'note', content: 'alpha 常用记录' })
    await svc.save({ scope: SCOPE, kind: 'note', content: 'alpha 冷记录' })
    // 模拟"这条被反复取用"（相当于多轮 memory_get 的反馈）
    for (let i = 0; i < 5; i++) await svc.getByIds([used.id])
    const hits = await svc.search({ text: 'alpha', scope: SCOPE, topK: 5 })
    assert.equal(hits.length, 2)
    assert.equal(hits[0]!.record.id, used.id, '被取用过的记忆应优先')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('事实有效期：失效记录默认不返回，includeExpired 时作为历史返回', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-magic-temporal-'))
  const svc = makeService(dir)
  try {
    const oldRec = await svc.save({ scope: SCOPE, kind: 'fact', content: '服务端口是 8080' })
    // 直接置失效（写入路径的失效由 cognitive/conflict + temporal 负责）
    svc.store.updateMetrics(oldRec.id, { validUntil: Date.now() - 1000 })
    const fresh = await svc.save({ scope: SCOPE, kind: 'fact', content: '服务端口是 8078' })
    const hits = await svc.search({ text: '服务端口', scope: SCOPE, topK: 5 })
    assert.ok(hits.some((h) => h.record.id === fresh.id))
    assert.ok(!hits.some((h) => h.record.id === oldRec.id), '失效记录默认不返回')
    const history = await svc.search({ text: '服务端口', scope: SCOPE, topK: 5, includeExpired: true } as never)
    assert.ok(history.some((h) => h.record.id === oldRec.id), '历史浏览仍能看到失效版本')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('注入/规则路径（listSync）与检索同口径：软删、休眠、失效的记录不再进入系统提示', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-magic-listsync-'))
  const svc = makeService(dir)
  try {
    const rule = await svc.save({ scope: SCOPE, kind: 'rule', content: '旧规则：所有提交必须带 issue 号。' })
    const fact = await svc.save({ scope: SCOPE, kind: 'fact', content: '服务端口是 8080。' })
    assert.equal(svc.listSync({ scopes: [SCOPE], kind: 'rule' }).length, 1)
    // 软删规则 → 不再进系统提示
    await svc.forget({ id: rule.id })
    assert.equal(svc.listSync({ scopes: [SCOPE], kind: 'rule' }).length, 0, '软删的规则不能继续注入')
    // 失效事实 → 默认 listSync 不返回，历史浏览（includeExpired）能查到
    svc.store.updateMetrics(fact.id, { validUntil: Date.now() - 1000 })
    assert.equal(svc.listSync({ scopes: [SCOPE] }).some((r) => r.id === fact.id), false, '失效事实不进注入')
    assert.equal(svc.listSync({ scopes: [SCOPE], includeExpired: true }).some((r) => r.id === fact.id), true, '历史浏览仍可查')
    // 休眠 → 不进注入
    const dormant = await svc.save({ scope: SCOPE, kind: 'note', content: '很久没用的笔记。' })
    svc.store.updateMetrics(dormant.id, {})
    ;(svc.store.peek(SCOPE)!.records.get(dormant.id) as { dormantAt?: number }).dormantAt = Date.now()
    assert.equal(svc.listSync({ scopes: [SCOPE] }).some((r) => r.id === dormant.id), false, '休眠记录不进注入')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})
