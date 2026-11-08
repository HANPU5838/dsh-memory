/**
 * 已存在压缩包的复用判定（2026-11-08 收尾）。
 *
 * 复用的前提是「包可信」：没配 sha256 时只要求非空；配了 sha256 就必须匹配，
 * 否则上一轮失败留下的坏包会被当成好东西直接解压，装完才发现坏。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existingArchiveUsable } from '../src/embed-install.ts'

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

test('existingArchiveUsable：空文件不可复用；没配 sha256 时非空即可复用', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-archive-reuse-'))
  try {
    const missing = join(dir, 'missing.tgz')
    assert.equal(await existingArchiveUsable(missing, ''), false, '文件不存在 → 不可复用')

    const empty = join(dir, 'empty.tgz')
    writeFileSync(empty, '')
    assert.equal(await existingArchiveUsable(empty, ''), false, '空文件 → 不可复用')

    const good = join(dir, 'good.tgz')
    writeFileSync(good, 'llama.cpp runtime bytes')
    assert.equal(await existingArchiveUsable(good, ''), true, '没配校验时非空即可复用')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('existingArchiveUsable：配了 sha256 时必须匹配', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-archive-sha-'))
  try {
    const file = join(dir, 'runtime.tgz')
    const content = 'exact bytes'
    writeFileSync(file, content)
    assert.equal(await existingArchiveUsable(file, sha256(content)), true, '匹配 → 复用')
    assert.equal(await existingArchiveUsable(file, sha256('other bytes')), false, '不匹配 → 重下')
    assert.equal(await existingArchiveUsable(file, 'not-a-valid-hash'), false, '非法哈希 → 重下')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
