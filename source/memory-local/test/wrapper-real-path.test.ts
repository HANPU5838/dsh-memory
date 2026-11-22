/**
 * 真实路径集成测试：单测常用 `new LocalMemoryService()` 直连，会绕过
 * `CordisMemoryService` 包装层（宿主实际拿到的就是它）。这里从包装层走一遍
 * 保存 / 检索 / 核心块 / 维护，防止“单测全绿、真机报错”。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerHooks } from 'node:module'

const CORDIS_STUB = 'data:text/javascript,' + encodeURIComponent(`
export class Service { constructor(ctx, name) { this.ctx = ctx; this.name = name } }
`)
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/cordis') return { url: CORDIS_STUB, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

const { CordisMemoryService } = await import('../src/apply.ts')

test('通过包装层走完 保存 → 检索 → 核心块 → 维护 → 健康分', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wrapper-path-'))
  const ctx = { effect() {}, get() { return undefined }, inject() {}, on() {} }
  const svc = new CordisMemoryService(ctx as never, {
    storeDir: dir,
    scopes: { global: true },
    retrieval: { vector: { enabled: false } },
  } as never)
  try {
    const saved = await svc.save({ scope: 'global', kind: 'fact', content: '包装层路径验证记录' })
    assert.ok(saved.id)
    const found = await svc.search({ text: '包装层路径验证记录', scope: 'global' } as never)
    assert.ok(found.some((hit) => (hit.record?.id ?? hit.id) === saved.id), '包装层检索应命中刚保存的记录')
    svc.coreSet({ slot: 'goal', content: '包装层目标' })
    assert.equal(svc.coreGet('goal')?.content, '包装层目标')
    const report = svc.runHousekeeping()
    assert.equal(typeof report.health?.score, 'number')
    assert.ok(report.health.score >= 80, `维护后健康分异常：${report.health.score}`)
  } finally {
    svc.flushSync?.()
    rmSync(dir, { recursive: true, force: true })
  }
})
