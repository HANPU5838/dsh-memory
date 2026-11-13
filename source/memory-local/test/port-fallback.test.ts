/**
 * 端口回退回归：默认端口被占时，插件应该自己换一个，而不是静默降级。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickFreePort } from '../src/index.ts'

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
