/**
 * 0.110.0：防篡改写入账本 —— 每次写入/删除/巩固追加前向哈希链，doctor 可校验。
 * 借鉴同类插件（Soulmate793/dsh-memory）的哈希链审计思路，但保持旁路：写失败不影响记忆。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryLedger, verifyLedger } from '../src/ledger.ts'
import { LocalMemoryService } from '../src/index.ts'

test('0.110.0：账本追加后哈希链完整，篡改任意一行会断链', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ledger-'))
  try {
    const ledger = new MemoryLedger(dir)
    ledger.append('save', 'rec-1', 'global')
    ledger.append('save', 'rec-2', 'project:/w')
    ledger.append('forget', 'rec-1', 'global')
    const ok = verifyLedger(ledger.path)
    assert.equal(ok.ok, true, ok.error)
    assert.equal(ok.entries, 3)

    const lines = readFileSync(ledger.path, 'utf8').trim().split('\n')
    const tampered = JSON.parse(lines[1])
    tampered.id = 'rec-evil'
    lines[1] = JSON.stringify(tampered)
    writeFileSync(ledger.path, `${lines.join('\n')}\n`)
    const broken = verifyLedger(ledger.path)
    assert.equal(broken.ok, false, '改内容不改 hash 必须断链')
    assert.match(String(broken.error), /hash/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.110.0：save / forget 都会写账本，verify 通过', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ledger-svc-'))
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true }, retrieval: { vector: { enabled: false } } })
  try {
    const rec = await svc.save({ scope: 'global', kind: 'fact', content: '一条会被记录的结论' })
    await svc.forget({ id: rec.id })
    const result = verifyLedger(join(dir, 'ledger.jsonl'))
    assert.equal(result.ok, true, result.error)
    assert.ok(result.entries >= 2, `至少 2 条，实际 ${result.entries}`)
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})
