/**
 * 0.107.0：长期运行的两处磁盘增长必须有界 —— approvals.jsonl 轮转、本地备份保留上限。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApprovalAuditStore } from '../src/approval-audit.ts'
import { LocalMemoryService } from '../src/index.ts'

test('0.107.0：approvals.jsonl 超过上限后保留最近 N 行（不无界增长）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-approval-rotate-'))
  try {
    const store = new ApprovalAuditStore({ root: dir, maxBytes: 500, keepLines: 5 })
    for (let i = 0; i < 40; i++) {
      store.append({
        at: i, event: 'requested', id: `vis-${i}`, sessionId: 's1', tool: 'memory_search',
        action: 'read', mode: 'records', count: 1, description: `第 ${i} 次申请`,
      })
    }
    const size = statSync(store.file).size
    assert.ok(size <= 1500, `轮转后文件应接近上限，实际 ${size} 字节`)
    const recent = store.list(50)
    assert.ok(recent.length <= 5, `只保留最近 5 行，实际 ${recent.length}`)
    assert.equal(recent[0]?.id, 'vis-39', '最新事件仍在')
    assert.ok(!recent.some((event) => event.id === 'vis-0'), '最旧事件已被裁掉')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.107.0：本地备份超过 20 份时裁掉最旧的，且不碰非 snapshot 文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-backup-prune-'))
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true }, retrieval: { vector: { enabled: false } } })
  try {
    const backupDir = join(dir, 'backups')
    mkdirSync(backupDir, { recursive: true })
    for (let i = 0; i < 25; i++) {
      writeFileSync(join(backupDir, `snapshot-2026-01-${String(i + 1).padStart(2, '0')}T00-00-00-000Z.jsonl.gz`), 'x')
    }
    writeFileSync(join(backupDir, 'user-notes.txt'), '不要删我')
    const removed = svc.pruneBackups()
    assert.equal(removed, 5, '25 份裁到 20 份')
    const snapshots = readdirSync(backupDir).filter((name) => name.startsWith('snapshot-'))
    assert.equal(snapshots.length, 20)
    assert.ok(readdirSync(backupDir).includes('user-notes.txt'), '非 snapshot 文件不受影响')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.108.0：createBackup 不自动裁剪（备份纯手动，只有显式 pruneBackups 才清理）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-backup-manual-'))
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true }, retrieval: { vector: { enabled: false } } })
  try {
    const backupDir = join(dir, 'backups')
    mkdirSync(backupDir, { recursive: true })
    for (let i = 0; i < 25; i++) {
      writeFileSync(join(backupDir, `snapshot-2026-02-${String(i + 1).padStart(2, '0')}T00-00-00-000Z.jsonl.gz`), 'x')
    }
    svc.createBackup()
    assert.equal(readdirSync(backupDir).filter((name) => name.startsWith('snapshot-')).length, 26, '创建备份不应自动删除旧备份')
    assert.equal(svc.pruneBackups(), 6, '显式清理才裁到 20 份')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})
