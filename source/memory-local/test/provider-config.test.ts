/**
 * 嵌入后端可插拔（A/B/C 里的 B）与平台自检的回归。
 *
 * 关注点：
 *  1. provider 默认按 endpoint 推断：回环地址 = local（插件托管 llama-server），
 *     远程地址 = openai（任意兼容服务）；显式配置永远优先。
 *  2. 非 local provider 不会创建 EmbedServerManager（不该拉起子进程）。
 *  3. 面板「环境自检」返回结构稳定，未配置后端时不发任何请求。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService, inferProviderKind, resolveConfig } from '../src/index.ts'

test('inferProviderKind：回环 = local，远程 = openai，非法/未配置 = local', () => {
  assert.equal(inferProviderKind(undefined), 'local')
  assert.equal(inferProviderKind(''), 'local')
  assert.equal(inferProviderKind('http://127.0.0.1:8078/v1/embeddings'), 'local')
  assert.equal(inferProviderKind('http://localhost:11434/v1/embeddings'), 'local')
  assert.equal(inferProviderKind('https://api.openai.com/v1/embeddings'), 'openai')
  assert.equal(inferProviderKind('not a url'), 'local')
})

test('resolveConfig：provider 可显式覆盖，apiKey 透传', () => {
  const local = resolveConfig({})
  assert.equal(local.vector.provider, 'local', '默认没有 endpoint → local')

  const remote = resolveConfig({ retrieval: { vector: { endpoint: 'https://api.example.com/v1/embeddings', apiKey: 'sk-test' } } })
  assert.equal(remote.vector.provider, 'openai', '远程 endpoint 推断为 openai')
  assert.equal(remote.vector.apiKey, 'sk-test')

  const explicit = resolveConfig({ retrieval: { vector: { endpoint: 'https://api.example.com/v1/embeddings', provider: 'ollama' } } })
  assert.equal(explicit.vector.provider, 'ollama', '显式 provider 永远优先')
})

test('非 local provider 不创建后端管理器；selfCheck 结构稳定', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-provider-'))
  try {
    const svc = new LocalMemoryService({
      storeDir: dir,
      retrieval: { vector: { enabled: true, provider: 'off', endpoint: 'http://127.0.0.1:9/v1/embeddings' } },
    })
    try {
      const report = await svc.selfCheck()
      assert.equal(report.provider, 'off')
      assert.equal(typeof report.summary, 'string')
      const ids = report.checks.map((c) => c.id)
      assert.equal(ids[0], 'platform', '平台检查排最前')
      assert.ok(ids.includes('backend'), '必须有后端检查（Termux 上中间还会插一条 glibc）')
      const backend = report.checks.find((c) => c.id === 'backend')
      assert.ok(backend, '必须有 backend 检查项')
      assert.equal(backend.ok, null, 'off/未配置后端不应判成功也不应联网探测')
    } finally {
      svc.dispose?.()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
