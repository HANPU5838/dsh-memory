import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService } from '../src/index.ts'

function makeService(): { svc: LocalMemoryService; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-backup-'))
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true }, retrieval: { vector: { enabled: false } } })
  return { svc, dir }
}

test('备份与恢复同时覆盖核心块', () => {
  const { svc, dir } = makeService()
  try {
    svc.coreSet({ slot: 'identity', content: '旧身份' })
    svc.coreSet({ slot: 'goal', content: '旧目标' })
    const backup = svc.createBackup()
    svc.coreSet({ slot: 'identity', content: '新身份' })
    svc.coreSet({ slot: 'goal', content: '新目标' })
    svc.restoreBackup(backup.name)
    assert.equal(svc.coreGet('identity')?.content, '旧身份')
    assert.equal(svc.coreGet('goal')?.content, '旧目标')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('导出为 v2 并保留 profile / supersedes 字段', async () => {
  const { svc, dir } = makeService()
  try {
    const first = await svc.save({ scope: 'global', kind: 'fact', content: '端口 8080' })
    await svc.save({ scope: 'global', kind: 'fact', content: '端口 9090', supersedes: first.id })
    await svc.save({
      scope: 'global',
      kind: 'profile',
      content: '用户偏好本地优先。',
      profile: JSON.stringify({ type: 'preference', topic: '环境', statement: '本地优先' }),
    })
    const dump = svc.exportAll()
    assert.equal(dump.version, 2)
    const withSupersedes = dump.records.find((record) => 'supersedes' in record && record.supersedes === first.id)
    assert.ok(withSupersedes !== undefined, '导出应保留 supersedes')
    const withProfile = dump.records.find((record) => record.kind === 'profile')
    assert.ok(withProfile !== undefined && 'profile' in withProfile, '导出应保留 profile 字段')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
