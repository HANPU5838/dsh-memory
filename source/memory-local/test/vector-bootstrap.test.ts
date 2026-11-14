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
import { planVectorBootstrap, resolveConfig, shouldUseTermuxSystemRuntime, type VectorBootstrapInput } from '../src/index.ts'

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

test('默认自动：没显式配置 autoBootstrap 时是 auto（0.63.0 恢复自动检测/安装）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mem-bootstrap-default-'))
  try {
    const cfg = resolveConfig({ storeDir: join(dir, 'store') })
    assert.equal(cfg.vector.autoBootstrap, 'auto', '默认恢复为自动检测 + 自动安装')
    // Termux + 有 pkg + 无系统运行时 → 自动装包（bionic 运行时），而不是下 glibc 托管运行时。
    assert.equal(planVectorBootstrap({ ...base, autoBootstrap: cfg.vector.autoBootstrap }), 'install-package')
    // 显式 off 仍然可以完全手动。
    assert.equal(planVectorBootstrap({ ...base, autoBootstrap: 'off' }), 'none')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.63.0：Termux 无系统运行时且无 glibc 时，改走系统运行时（pkg 装）而不是下托管 glibc 运行时', () => {
  const baseInput = { termux: true, autoBootstrap: 'auto' as const, hasSystemServer: false, hasGlibcLoader: false, hasPkg: true }
  assert.equal(shouldUseTermuxSystemRuntime(baseInput), true, '这正是另一台手机踩坑的场景')
  assert.equal(shouldUseTermuxSystemRuntime({ ...baseInput, hasSystemServer: true }), false, '已有系统运行时就不抢先')
  assert.equal(shouldUseTermuxSystemRuntime({ ...baseInput, hasGlibcLoader: true }), false, '有 glibc 时托管运行时可用')
  assert.equal(shouldUseTermuxSystemRuntime({ ...baseInput, autoBootstrap: 'off' }), false, '手动模式不自动装包')
  assert.equal(shouldUseTermuxSystemRuntime({ ...baseInput, hasPkg: false }), false, '没有 pkg 装不了')
  assert.equal(shouldUseTermuxSystemRuntime({ ...baseInput, termux: false }), false, '非 Termux 不适用')
})
