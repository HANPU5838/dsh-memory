/**
 * 回归：flush 的写盘错误绝不能冒泡。
 *
 * flush 常常从 `scheduleFlush()` 的 unref 定时器里跑；定时器回调里抛异常就是
 * uncaught exception，宿主的 installFailLoud 会把整个 DSH 进程 exit(1)——一次
 * ENOSPC / EACCES（只读目录、存储写满）就能把用户的会话全带走。
 *
 * 期望：写盘失败只产生一条 warn，增量保留；环境恢复后下一次 flush 补写成功。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../src/store.ts'

type SaveScope = Parameters<MemoryStore['save']>[0]['scope']

test('flush 写盘失败不抛；增量保留，恢复权限后能补写', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flush-fail-'))
  const scope = 'project:/tmp/dsh-flush-fail' as SaveScope
  try {
    const warns: string[] = []
    const store = new MemoryStore(dir, { onWarn: (message) => warns.push(message) })
    store.save(
      { scope, kind: 'note', content: '写盘失败也要活着' },
      { importance: 0.5, source: { origin: 'explicit' } },
    )

    // 只读目录：数据文件在 <root>/projects/ 下，两层都要收紧，
    // 否则新建 .tmp / .lock 仍然成功，测不到失败路径。
    chmodSync(join(dir, 'projects'), 0o555)
    chmodSync(dir, 0o555)
    assert.doesNotThrow(() => store.flush(), 'flush 必须自己兜住写盘错误')
    assert.ok(warns.some((m) => m.includes('flush 失败')), '失败要有 warn，不能静默')

    chmodSync(dir, 0o755)
    chmodSync(join(dir, 'projects'), 0o755)
    store.flush()

    const reloaded = new MemoryStore(dir)
    assert.equal(reloaded.peek(scope)?.records.size, 1, '恢复后增量被补写进磁盘')
    store.close()
    reloaded.close()
  } finally {
    try { chmodSync(join(dir, 'projects'), 0o755) } catch { /* ignore */ }
    chmodSync(dir, 0o755)
    rmSync(dir, { recursive: true, force: true })
  }
})
