/**
 * 0.100.0：真实库全链路验收工具（tools/e2e-real.mjs）的 CLI 集成测试。
 * 用临时种子库跑一遍，确认它复制库、检索、注入渲染、doctor 全链路 PASS。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { LocalMemoryService } from '../src/index.ts'

const ROOT = join(import.meta.dirname, '..', '..', '..')

test('0.100.0：e2e:real 在种子库上 PASS（复制→检索→注入→doctor）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-e2e-real-cli-'))
  const seed = new LocalMemoryService({ storeDir: dir, scopes: { global: true }, retrieval: { vector: { enabled: false } } })
  try {
    await seed.save({ scope: 'global', kind: 'fact', content: '部署服务需要先备份数据库，回滚时使用上一版快照 /srv/app 端口 9001' })
    await seed.save({ scope: 'global', kind: 'fact', content: 'nginx 配置位于 /etc/nginx/sites-enabled/app.conf，修改后 reload' })
    await seed.save({ scope: 'global', kind: 'note', content: '发布前跑 verify:all，确认面板 API 16/16 通过' })
    seed.flushSync()

    const output = execFileSync(process.execPath, [
      '--experimental-strip-types', join(ROOT, 'tools', 'e2e-real.mjs'), '--store', dir,
    ], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 })
    assert.match(output, /结论：PASS/)
    assert.match(output, /真实内容检索/)
    assert.match(output, /真实数据体检（doctor）/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
