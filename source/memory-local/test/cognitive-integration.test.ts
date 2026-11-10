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
    await svc.getByIds([rec.id], { trackUse: true })
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
    for (let i = 0; i < 5; i++) await svc.getByIds([used.id], { trackUse: true })
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

test('休眠判定：memory_get 取用也算"被看见"，不会误判休眠', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-magic-dormant-'))
  const svc = makeService(dir)
  try {
    const rec = await svc.save({ scope: SCOPE, kind: 'note', content: '经常被取用的笔记' })
    // 很久以前检索过（lastAccessedAt 老），但刚刚被 memory_get 取用（lastUsedAt 新）
    const raw = svc.store.peek(SCOPE)!.records.get(rec.id) as { lastAccessedAt: number }
    raw.lastAccessedAt = Date.now() - 90 * 86_400_000
    await svc.getByIds([rec.id])
    const result = svc.runHousekeeping()
    assert.ok(!result.dormant.includes(rec.id), '刚被取用的记忆不该休眠')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('容量淘汰不会提前删掉墓碑记录（保留 30 天可恢复的承诺）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-magic-evict-'))
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true, project: true }, limits: { maxRecordsPerScope: 2 } })
  svc.setProjectScope(SCOPE)
  try {
    const tomb = await svc.save({ scope: SCOPE, kind: 'note', content: '会被删除的记录 alpha' })
    await svc.forget({ id: tomb.id })
    // 再写 3 条活记录，触发容量淘汰
    for (let i = 0; i < 3; i++) await svc.save({ scope: SCOPE, kind: 'note', content: `活记录 ${i} alpha` })
    svc.runHousekeeping()
    const raw = svc.store.peek(SCOPE)!.records.get(tomb.id)
    assert.ok(raw, '墓碑记录不应被容量淘汰提前物理删除')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('取用反馈只由显式 memory_get 触发：内部/注入读取不涨 utility', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-magic-trackuse-'))
  const svc = makeService(dir)
  try {
    const rec = await svc.save({ scope: SCOPE, kind: 'note', content: '取用反馈口径测试' })
    const read = () => svc.store.peek(SCOPE)!.records.get(rec.id) as { useCount?: number; utility?: number }
    assert.equal(read().useCount ?? 0, 0, '刚保存不应有取用次数')
    // 注入层/去重标记/删除校验这类内部读取：默认不计
    svc.getByIds([rec.id])
    assert.equal(read().useCount ?? 0, 0, '内部 getByIds 不计取用')
    assert.equal(read().utility ?? 0, 0, '内部读取不提升 utility')
    // memory_get 工具路径：显式 trackUse
    svc.getByIds([rec.id], { trackUse: true })
    assert.equal(read().useCount, 1, '只有显式取用才 +1')
    assert.ok((read().utility ?? 0) > 0, '显式取用提升 utility')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})
