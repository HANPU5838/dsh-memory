import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryBlocksStore } from '../src/blocks.ts'

test('按 8 位前缀也能解除屏蔽（与 block 的入参保持一致）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-block-prefix-'))
  try {
    const store = new MemoryBlocksStore({ root: dir })
    store.add('session', 's1', { recordId: '04a3fbc0-ac9a-415f-a946-ad50bf3ce140', recordKind: 'note', prefix: '04a3fbc0' })
    assert.equal(store.list('session', 's1').length, 1)
    assert.equal(store.remove('session', 's1', { recordId: '04a3fbc0' }).length, 0)
    assert.equal(store.remove('session', 's1', { recordId: 'deadbeef' }).length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
