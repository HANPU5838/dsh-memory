import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService } from '../src/index.ts'

function makeService(extra: Record<string, unknown> = {}): { svc: LocalMemoryService; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-arbiter-'))
  const svc = new LocalMemoryService({
    storeDir: dir,
    scopes: { global: true },
    retrieval: { vector: { enabled: false } },
    cognitive: { arbiter: { enabled: true } },
    ...extra,
  })
  return { svc, dir }
}

test('同义改写不会重复入库（NOOP 返回既有记录）', async () => {
  const { svc, dir } = makeService({ cognitive: { arbiter: { enabled: true, noopThreshold: 0.8 } } })
  try {
    const first = await svc.save({ content: '用户偏好用中文回复', scope: 'global', kind: 'preference' })
    const second = await svc.save({ content: '用户偏好使用中文回复', scope: 'global', kind: 'preference' })
    assert.equal(second.id, first.id)
    const listed = svc.listSync({ scopes: ['global'] })
    assert.equal(listed.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('数字变化转成 supersedes 链（UPDATE）', async () => {
  const { svc, dir } = makeService({ cognitive: { arbiter: { enabled: true, updateThreshold: 0.5 } } })
  try {
    const first = await svc.save({ content: '服务器磁盘 40G，已用 15G', scope: 'global', kind: 'fact' })
    const second = await svc.save({ content: '服务器磁盘 40G，已用 12G', scope: 'global', kind: 'fact' })
    assert.notEqual(second.id, first.id)
    assert.equal(second.supersedes, first.id)
    const listed = svc.listSync({ scopes: ['global'], includeSuperseded: true })
    assert.equal(listed.length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('shadow 模式只观察不改变写入行为', async () => {
  const { svc, dir } = makeService({ cognitive: { arbiter: { enabled: true, shadow: true } } })
  try {
    await svc.save({ content: '用户偏好用中文回复', scope: 'global', kind: 'preference' })
    await svc.save({ content: '用户偏好使用中文回复', scope: 'global', kind: 'preference' })
    assert.equal(svc.listSync({ scopes: ['global'] }).length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('关闭裁决后恢复写即存', async () => {
  const { svc, dir } = makeService({ cognitive: { arbiter: { enabled: false } } })
  try {
    await svc.save({ content: '用户偏好用中文回复', scope: 'global', kind: 'preference' })
    await svc.save({ content: '用户偏好使用中文回复', scope: 'global', kind: 'preference' })
    assert.equal(svc.listSync({ scopes: ['global'] }).length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('不同事实正常新增（ADD）', async () => {
  const { svc, dir } = makeService()
  try {
    await svc.save({ content: '用户偏好用中文回复', scope: 'global', kind: 'preference' })
    await svc.save({ content: '服务器在重庆机房，出口 443', scope: 'global', kind: 'fact' })
    assert.equal(svc.listSync({ scopes: ['global'] }).length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
