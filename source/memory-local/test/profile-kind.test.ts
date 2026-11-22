import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService } from '../src/index.ts'
import { parseProfileField, ProfileInvalid } from '../src/profile.ts'

function makeService(): { svc: LocalMemoryService; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-profile-'))
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true }, retrieval: { vector: { enabled: false } } })
  return { svc, dir }
}

test('画像记录持久化结构化字段', async () => {
  const { svc, dir } = makeService()
  try {
    const record = await svc.save({
      scope: 'global',
      kind: 'profile',
      content: '用户偏好本地优先的方案。',
      profile: JSON.stringify({ type: 'preference', topic: '技术环境', statement: '本地优先', confidence: 0.8, evidence: ['session-1'] }),
    })
    const listed = svc.listSync({ scopes: ['global'], kind: 'profile' })
    assert.equal(listed.length, 1)
    const stored = listed[0] as typeof listed[0] & { profile?: { topic: string; confidence: number; evidence: string[] } }
    assert.equal(record.kind, 'profile')
    assert.equal(stored.profile?.topic, '技术环境')
    assert.equal(stored.profile?.confidence, 0.8)
    assert.deepEqual(stored.profile?.evidence, ['session-1'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('画像 JSON 非法时拒绝写入', async () => {
  const { svc, dir } = makeService()
  try {
    await assert.rejects(
      svc.save({ scope: 'global', kind: 'profile', content: 'x', profile: '{bad json' }),
      (error: Error) => (error as { code?: string }).code === 'PROFILE_INVALID',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('缺 type / statement 时拒绝', async () => {
  const { svc, dir } = makeService()
  try {
    await assert.rejects(
      svc.save({ scope: 'global', kind: 'profile', content: 'x', profile: JSON.stringify({ topic: 't' }) }),
      (error: Error) => (error as { code?: string }).code === 'PROFILE_INVALID',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('不带画像字段的 profile 记录也允许保存', async () => {
  const { svc, dir } = makeService()
  try {
    const record = await svc.save({ scope: 'global', kind: 'profile', content: '用户的零散画像观察。' })
    assert.equal(record.kind, 'profile')
    assert.equal(svc.listSync({ scopes: ['global'], kind: 'profile' }).length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('parseProfileField 归一化置信度并限制证据条数', () => {
  const field = parseProfileField({ type: 'habit', topic: '工作', statement: '夜间工作', confidence: 2, evidence: Array.from({ length: 30 }, (_, i) => `e${i}`) })
  assert.equal(field.confidence, 1)
  assert.equal(field.evidence.length, 20)
  assert.equal(field.schema, 1)
  assert.throws(() => parseProfileField({ type: 'unknown', topic: 't', statement: 's' }), ProfileInvalid)
})
