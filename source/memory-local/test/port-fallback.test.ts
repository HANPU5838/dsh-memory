/**
 * 端口回退回归：默认端口被占时，插件应该自己换一个，而不是静默降级。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService, pickFreePort } from '../src/index.ts'

test('pickFreePort：跳过被占端口，返回第一个空闲端口', async () => {
  const busy = new Set([8078, 8079, 8080])
  const found = await pickFreePort('127.0.0.1', 8078, 5, async (_host, port) => busy.has(port))
  assert.equal(found, 8081)
})

test('pickFreePort：全都占用 → null（调用方据此降级并记录）', async () => {
  const found = await pickFreePort('127.0.0.1', 9000, 3, async () => true)
  assert.equal(found, null)
})

test('pickFreePort：起始端口就空闲 → 原样返回，不乱改', async () => {
  const found = await pickFreePort('127.0.0.1', 8078, 5, async () => false)
  assert.equal(found, 8078)
})

test('端口回退只作用于「插件托管子进程」：外部本地端点不能被改端口', async () => {
  // 占住一个随机端口，模拟「用户自己的 llama-server 正跑在这里」。
  const server = createServer(() => {})
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  const dir = mkdtempSync(join(tmpdir(), 'dsh-portguard-'))
  try {
    const endpoint = `http://127.0.0.1:${port}/v1/embeddings`
    const svc = new LocalMemoryService({
      storeDir: dir,
      scopes: { global: true, project: true },
      retrieval: {
        vector: {
          enabled: true,
          provider: 'local',
          endpoint,
          model: 'bge-m3',
          dims: 1024,
          pooling: 'cls',
          spawn: { enabled: false }, // 插件不托管 → 端口是别人的，绝不能改
        },
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 400))
    const status = await svc.embedServerStatus()
    assert.equal(status.endpoint, endpoint, '外部端点（spawn 未开）不能被端口回退改写')
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
