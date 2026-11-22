/**
 * Cordis 服务包装层必须转发审计方法。
 *
 * 0.12.0/0.12.1 的 provider 实现加在 LocalMemoryService 上，但面板通过
 * ctx.get('memory') 拿到的是 CordisMemoryService 包装实例；包装层没转发时，
 * 面板就会显示“provider 未提供注入审计接口”。这里用最小 Service stub 检查
 * 包装层暴露的方法，防止再次“实现了但服务上看不到”。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const CORDIS_STUB = 'data:text/javascript,' + encodeURIComponent(`
export class Service {
  constructor(ctx, name) { this.ctx = ctx; this.name = name }
}
`)

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/cordis') return { url: CORDIS_STUB, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

const { CordisMemoryService } = await import('../src/apply.ts')

test('CordisMemoryService 暴露面板所需的审计方法', () => {
  for (const name of ['attachInjectAudit', 'detachInjectAudit', 'injectAudit', 'injectAuditPage', 'injectAuditStats']) {
    assert.equal(
      typeof (CordisMemoryService.prototype as unknown as Record<string, unknown>)[name],
      'function',
      `ctx.get('memory').${name} 必须存在，否则面板审计不可用`,
    )
  }
})

test('CordisMemoryService 暴露面板语义检索入口', () => {
  // 面板通过 ctx.get('memory') 拿到的是包装实例:漏转发 = 记录页的「语义检索」
  // 悄悄退回 provider-lexical 关键词过滤。
  const proto = CordisMemoryService.prototype as unknown as Record<string, unknown>
  assert.equal(typeof proto.searchForPanel, 'function', 'ctx.get(\'memory\').searchForPanel 必须存在')
  assert.equal(typeof proto.search, 'function', '通用检索入口仍然保留')
})

test('CordisMemoryService 暴露归档 / 屏蔽接口', () => {
  // 0.32.0 的归档与屏蔽只实现在 LocalMemoryService 上,包装层漏转发时真实 profile 里
  // ctx.get('memory').listBlocks 是 undefined:面板「解除屏蔽」按钮点了没反应、/status
  // 的 blocked 字段永远为空,而单测直接 new LocalMemoryService 完全看不见。
  const proto = CordisMemoryService.prototype as unknown as Record<string, unknown>
  for (const name of [
    'archiveScope', 'restoreScope', 'archivedProjectScopes',
    'blocksFor', 'listBlocks', 'sessionBlocks', 'workspaceBlocks',
    'isScopeBlocked', 'isRecordBlocked', 'unblock', 'clearBlocks', 'requestBlock',
  ]) {
    assert.equal(
      typeof proto[name],
      'function',
      `ctx.get('memory').${name} 必须存在，否则面板的归档 / 屏蔽功能静默失效`,
    )
  }
})

test('CordisMemoryService 暴露记忆钩子接口', () => {
  // 0.35.0：钩子的存储、运行、审批全在 LocalMemoryService 上；面板与 memory_hooks
  // 工具拿的是包装实例，漏一个就是 undefined（面板「规则代码」页空白、工具报不支持）。
  const proto = CordisMemoryService.prototype as unknown as Record<string, unknown>
  for (const name of [
    'hookSettings', 'updateHookSettings', 'listHooks', 'getHook', 'saveHook',
    'deleteHook', 'approveHook', 'hookPendingApproval', 'requestHookApproval',
    'runHooks', 'runHookTrial', 'parseForInject',
  ]) {
    assert.equal(
      typeof proto[name],
      'function',
      `ctx.get('memory').${name} 必须存在，否则记忆钩子静默失效`,
    )
  }
})

test('CordisMemoryService 转发核心记忆块方法', () => {
  // 1.6.0 的 core API 只加在 LocalMemoryService 上；包装层漏转发时，
  // memory_core 工具会报「provider 不支持核心记忆块」。
  const proto = CordisMemoryService.prototype as unknown as Record<string, unknown>
  for (const name of ['coreBlocks', 'coreGet', 'coreHistory', 'coreSet', 'coreClear']) {
    assert.equal(typeof proto[name], 'function', `ctx.get('memory').${name} 必须存在，否则 memory_core 不可用`)
  }
})
