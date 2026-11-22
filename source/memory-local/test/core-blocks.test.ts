import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService } from '../src/index.ts'
import { CoreVersionConflict, CoreContentInvalid } from '../src/core.ts'

function makeService(): { svc: LocalMemoryService; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-core-'))
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true }, retrieval: { vector: { enabled: false } } })
  return { svc, dir }
}

test('核心块写入后可按槽位读取，版本从 1 开始', () => {
  const { svc, dir } = makeService()
  try {
    const st = svc.coreSet({ slot: 'identity', content: '本机长期协作 Agent，先验证再动手。' })
    assert.equal(st.version, 1)
    assert.equal(st.updatedBy, 'user')
    assert.equal(svc.coreGet('identity')?.content, '本机长期协作 Agent，先验证再动手。')
    assert.equal(svc.coreBlocks().goal, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('重复写入递增版本并保留历史', () => {
  const { svc, dir } = makeService()
  try {
    svc.coreSet({ slot: 'goal', content: '完成核心记忆块' })
    svc.coreSet({ slot: 'goal', content: '完成核心记忆块与画像' })
    assert.equal(svc.coreGet('goal')?.version, 2)
    assert.equal(svc.coreHistory('goal').length, 2)
    assert.equal(svc.coreHistory('goal')[0]?.content, '完成核心记忆块')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('expectedVersion 不匹配时拒绝覆盖', () => {
  const { svc, dir } = makeService()
  try {
    svc.coreSet({ slot: 'identity', content: 'v1' })
    assert.throws(() => svc.coreSet({ slot: 'identity', content: 'v2', expectedVersion: 99 }), CoreVersionConflict)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('清空写入空内容但保留版本链', () => {
  const { svc, dir } = makeService()
  try {
    svc.coreSet({ slot: 'goal', content: '临时目标' })
    const cleared = svc.coreClear('goal')
    assert.equal(cleared.content, '')
    assert.equal(cleared.version, 2)
    assert.equal(svc.coreHistory('goal').length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('超过槽位 token 上限时拒绝写入', () => {
  const { svc, dir } = makeService()
  try {
    const tooLong = '身'.repeat(80)
    assert.throws(() => svc.coreSet({ slot: 'identity', content: tooLong }), CoreContentInvalid)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('写入时清洗零宽字符与模板定界符', () => {
  const { svc, dir } = makeService()
  try {
    const st = svc.coreSet({ slot: 'goal', content: '目标\u200b{{x}}' })
    assert.equal(st.content.includes('\u200b'), false)
    assert.equal(st.content.includes('{{'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('重新实例化后核心块仍在（持久化）', () => {
  const { svc, dir } = makeService()
  try {
    svc.coreSet({ slot: 'profile', content: '用户偏好本地优先。' })
    const again = new LocalMemoryService({ storeDir: dir, scopes: { global: true }, retrieval: { vector: { enabled: false } } })
    assert.equal(again.coreGet('profile')?.content, '用户偏好本地优先。')
    assert.equal(again.coreGet('profile')?.version, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('core.json 损坏时退回空状态而不是抛错', () => {
  const { svc, dir } = makeService()
  try {
    writeFileSync(join(dir, 'core.json'), '{not json', 'utf8')
    const again = new LocalMemoryService({ storeDir: dir, scopes: { global: true }, retrieval: { vector: { enabled: false } } })
    assert.equal(again.coreGet('identity'), undefined)
    again.coreSet({ slot: 'identity', content: '重建' })
    assert.equal(again.coreGet('identity')?.content, '重建')
    void svc
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
