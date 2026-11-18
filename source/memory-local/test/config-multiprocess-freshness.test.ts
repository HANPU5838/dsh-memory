/**
 * 0.109.0：配置类文件（可见域 / 屏蔽 / 归档）在多进程共用 storeDir 时必须感知外部写入。
 * 此前进程内缓存永不刷新 → 另一个进程加了 absolute 限制/屏蔽/归档，本进程仍 fail-open。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionVisibilityStore } from '../src/session-visibility.ts'
import { MemoryBlocksStore } from '../src/blocks.ts'
import { ScopeArchiveStore } from '../src/scope-archive.ts'

test('0.109.0：可见域缓存感知另一个进程的写入（refreshTtlMs=0 每次 stat）', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-visibility-fresh-'))
  try {
    const reader = new SessionVisibilityStore({ root, refreshTtlMs: 0 })
    assert.equal(reader.get('s1'), undefined, '初始没有覆盖')
    const writer = new SessionVisibilityStore({ root, refreshTtlMs: 0 })
    writer.set('s1', { level: 'absolute', scopes: [{ scope: 'global' }] })
    const seen = reader.get('s1')
    assert.equal(seen?.level, 'absolute', '另一个实例写入后必须可见')
    assert.deepEqual(seen?.scopes.map((rule) => rule.scope), ['global'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('0.109.0：屏蔽缓存感知另一个进程的写入/解除', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-blocks-fresh-'))
  try {
    const reader = new MemoryBlocksStore({ root, refreshTtlMs: 0 })
    assert.equal(reader.list('session', 's1').length, 0)
    const writer = new MemoryBlocksStore({ root, refreshTtlMs: 0 })
    writer.add('session', 's1', { scope: 'global' })
    assert.equal(reader.list('session', 's1').length, 1, '另一个实例写入后必须可见')
    writer.remove('session', 's1', { scope: 'global' })
    assert.equal(reader.list('session', 's1').length, 0, '另一个实例解除后必须消失')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('0.109.0：归档缓存感知另一个进程的归档/恢复', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-archive-fresh-'))
  try {
    const reader = new ScopeArchiveStore({ root, refreshTtlMs: 0 })
    assert.equal(reader.has('project:/w'), false)
    const writer = new ScopeArchiveStore({ root, refreshTtlMs: 0 })
    writer.archive('project:/w', 'user')
    assert.equal(reader.has('project:/w'), true, '另一个实例归档后必须不可见')
    writer.restore('project:/w')
    assert.equal(reader.has('project:/w'), false, '恢复后必须重新可见')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
