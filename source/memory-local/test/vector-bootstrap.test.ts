/**
 * 自举决策回归：按「这台机器实际有什么」自动适配，而不是把某个设备写死。
 *   - Termux + 无 llama-server + 有 pkg → 自动装包
 *   - 任何平台 + 已有系统 llama-server → 只补模型
 *   - autoBootstrap=always + 有托管资产 → 托管下载
 *   - 显式配置 / 非 local provider / off 一律不动
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planVectorBootstrap, resolveConfig, type VectorBootstrapInput } from '../src/index.ts'

const base: VectorBootstrapInput = {
  autoBootstrap: 'auto',
  provider: 'local',
  endpointConfigured: false,
  spawnExplicit: false,
  configured: false,
  termux: true,
  hasSystemServer: false,
  hasPkg: true,
  managedSupported: true,
}

test('自举：关掉开关 / 显式配置 / 非 local provider 一律不动', () => {
  assert.equal(planVectorBootstrap({ ...base, autoBootstrap: 'off' }), 'none')
  assert.equal(planVectorBootstrap({ ...base, provider: 'openai' }), 'none', 'provider 不是 local 不抢')
  assert.equal(planVectorBootstrap({ ...base, provider: 'off' }), 'none')
  assert.equal(planVectorBootstrap({ ...base, endpointConfigured: true }), 'none', '显式 endpoint 优先')
  assert.equal(planVectorBootstrap({ ...base, spawnExplicit: true }), 'none', '显式 spawn 优先')
  assert.equal(planVectorBootstrap({ ...base, configured: true }), 'none', '已配置交给正常启动路径')
})

test('自举：系统已有 llama-server → 任何平台都只补模型（跨平台通用分支）', () => {
  assert.equal(planVectorBootstrap({ ...base, termux: false, hasSystemServer: true, hasPkg: false }), 'download-model')
  assert.equal(planVectorBootstrap({ ...base, termux: false, hasSystemServer: true, managedSupported: false }), 'download-model')
})

test('自举：Termux 无系统运行时 → 先装包；装不了且未开 always → 不动', () => {
  assert.equal(planVectorBootstrap(base), 'install-package')
  assert.equal(planVectorBootstrap({ ...base, hasPkg: false }), 'none', 'auto 模式不在非 Termux 悄悄装包')
})

test('自举：桌面端默认不下载托管运行时，除非显式 always', () => {
  const desktop = { ...base, termux: false, hasPkg: false }
  assert.equal(planVectorBootstrap(desktop), 'none', 'auto 模式桌面端不擅自下 400MB')
  assert.equal(planVectorBootstrap({ ...desktop, autoBootstrap: 'always' }), 'managed-install')
  assert.equal(planVectorBootstrap({ ...desktop, autoBootstrap: 'always', managedSupported: false }), 'none', '平台没有资产时兜底失败')
})

test('默认手动：没显式配置 autoBootstrap 时就是 off，不会自动装包/下模型', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mem-bootstrap-default-'))
  try {
    const cfg = resolveConfig({ storeDir: join(dir, 'store') })
    assert.equal(cfg.vector.autoBootstrap, 'off', '默认必须是手动，下载/安装由面板按钮显式触发')
    // 同样的输入在旧默认（auto）下会决策成 install-package / download-model。
    assert.equal(planVectorBootstrap({ ...base, autoBootstrap: cfg.vector.autoBootstrap }), 'none')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
