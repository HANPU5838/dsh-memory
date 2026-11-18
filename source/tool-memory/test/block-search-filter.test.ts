/**
 * 0.106.0：memory_block 必须真的过滤 memory_search（此前工具搜索不传 agent/sessionId，
 * provider 的屏蔽过滤拿不到会话 → 会话级屏蔽只影响注入、不影响显式检索）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService } from '../../memory-local/src/index.ts'
import { memorySearchTool } from '../src/index.ts'

test('0.106.0：会话级 memory_block 对 memory_search 生效（解除后恢复）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-block-search-'))
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true }, retrieval: { vector: { enabled: false } } })
  const agent = { session: { id: 'sess-block-search' } }
  try {
    const record = await svc.save({
      scope: 'global',
      kind: 'fact',
      content: 'X11 项目使用 Termux:X11 启动安卓桌面，loader 需要注入主程序',
    })
    const tool = memorySearchTool({ getService: () => svc })
    const before = await tool.execute({ query: 'X11 Termux loader', description: '查 X11 记录' }, { agent })
    assert.ok(before.records.some((hit) => hit.id === record.id), '屏蔽前应能搜到')

    await svc.requestBlock(agent, { id: record.id, level: 'session', reason: '不同项目，降噪' })
    const blocked = await tool.execute({ query: 'X11 Termux loader', description: '查 X11 记录' }, { agent })
    assert.ok(!blocked.records.some((hit) => hit.id === record.id), '会话级屏蔽后 memory_search 必须不再返回')

    svc.unblock(agent, { recordId: record.id })
    const restored = await tool.execute({ query: 'X11 Termux loader', description: '查 X11 记录' }, { agent })
    assert.ok(restored.records.some((hit) => hit.id === record.id), '解除屏蔽后恢复')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})
