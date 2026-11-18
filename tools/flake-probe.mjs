#!/usr/bin/env node
/**
 * 偶发失败探针（0.103.0）。
 *
 * 全量测试偶发 1 例失败时，单跑一次通过 => 只能靠反复跑定位。本工具把同一套测试
 * 连续跑 N 次（默认 5），记录每次的失败项并汇总；任何一次失败都以退出码 1 结束。
 *
 * 用法：npm run probe:flake [-- 10]
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runsArg = process.argv[2]
const runs = Number.isFinite(Number(runsArg)) && Number(runsArg) > 0 ? Math.min(20, Number(runsArg)) : 5

function collectTests() {
  const files = []
  for (const group of readdirSync(join(ROOT, 'source'), { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    let testDir
    try { testDir = readdirSync(join(ROOT, 'source', group.name, 'test')) } catch { continue }
    for (const file of testDir) {
      if (file.endsWith('.test.ts')) files.push(join(ROOT, 'source', group.name, 'test', file))
    }
  }
  return files.sort()
}

const files = collectTests()
console.log(`\n偶发失败探针：${files.length} 个测试文件 × ${runs} 轮\n`)
const failures = []
for (let i = 1; i <= runs; i++) {
  const started = Date.now()
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--test', ...files], {
    cwd: ROOT, encoding: 'utf8', timeout: 900_000,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const fail = Number(/ℹ fail (\d+)/u.exec(output)?.[1] ?? (result.status === 0 ? 0 : 1))
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  if (fail > 0) {
    const failing = output.split('\n').filter((line) => line.startsWith('✖')).slice(0, 10)
    failures.push({ run: i, failing })
    console.log(`✗ 第 ${i} 轮失败（${seconds}s）`)
    for (const line of failing) console.log(`  ${line}`)
  } else {
    console.log(`✓ 第 ${i} 轮通过（${seconds}s）`)
  }
}
const icon = failures.length === 0 ? 'PASS' : 'FAIL'
console.log(`\n结论：${icon}（${runs - failures.length}/${runs} 轮通过）\n`)
process.exit(failures.length === 0 ? 0 : 1)
