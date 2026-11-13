/**
 * Termux 自举决策回归：环境「和本机同款」才自动装包/下模型，任何显式配置都优先。
 * 决策本身是纯函数；真正的 pkg install / 下载在 index.ts 里 fire-and-forget 执行。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planVectorBootstrap, type VectorBootstrapInput } from '../src/index.ts'

const base: VectorBootstrapInput = {
  autoBootstrap: 'auto',
  provider: 'local',
  endpointConfigured: false,
  spawnExplicit: false,
  configured: false,
  termux: true,
  hasSystemServer: false,
  hasPkg: true,
}

test('自举：关掉开关 / 显式配置 / 非 Termux 一律不动', () => {
  assert.equal(planVectorBootstrap({ ...base, autoBootstrap: 'off' }), 'none')
  assert.equal(planVectorBootstrap({ ...base, termux: false }), 'none', '桌面端不该被塞模型')
  assert.equal(planVectorBootstrap({ ...base, provider: 'openai' }), 'none', 'provider 不是 local 不抢')
  assert.equal(planVectorBootstrap({ ...base, provider: 'off' }), 'none')
  assert.equal(planVectorBootstrap({ ...base, endpointConfigured: true }), 'none', '显式 endpoint 优先')
  assert.equal(planVectorBootstrap({ ...base, spawnExplicit: true }), 'none', '显式 spawn 优先')
  assert.equal(planVectorBootstrap({ ...base, configured: true }), 'none', '已配置交给正常启动路径')
})

test('自举：Termux 上先看系统 llama-server，再看能不能装包', () => {
  assert.equal(planVectorBootstrap({ ...base, hasSystemServer: true, hasPkg: false }), 'download-model', '已有系统 llama-server → 只下模型')
  assert.equal(planVectorBootstrap({ ...base, hasSystemServer: false, hasPkg: true }), 'install-package', '没有 llama-server 但能 pkg install → 先装包')
  assert.equal(planVectorBootstrap({ ...base, hasSystemServer: false, hasPkg: false }), 'none', '既没有服务也装不了包 → 不折腾')
})
