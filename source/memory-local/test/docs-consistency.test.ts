/**
 * 0.92.0：文档一致性守门 —— 仓库当前状态必须通过 `npm run check:docs`。
 * 任何一次发版漏改 badge/CHANGELOG/architecture 都会让这个测试失败。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..', '..')

test('0.92.0：check:docs 在仓库当前状态必须 PASS', () => {
  const output = execFileSync(process.execPath, [join(ROOT, 'tools', 'check-docs.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  })
  assert.match(output, /结论：PASS/)
})
