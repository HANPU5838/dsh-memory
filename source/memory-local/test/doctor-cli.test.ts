/**
 * 0.89.0：`npm run doctor` 自检 CLI —— 正常库 PASS、损坏行 FAIL。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { LocalMemoryService } from '../src/index.ts'

const ROOT = join(import.meta.dirname, '..', '..', '..')

function runDoctor(storeDir: string): { status: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [
      '--experimental-strip-types', join(ROOT, 'tools', 'doctor.mjs'), '--store', storeDir,
    ], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 })
    return { status: 0, output }
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

test('0.89.0：doctor 对健康库输出 PASS；损坏行令其 FAIL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-doctor-'))
  try {
    // 用真实服务写入，保证作用域索引/文件布局与生产一致。
    const seed = new LocalMemoryService({ storeDir: dir, scopes: { global: true }, retrieval: { vector: { enabled: false } } })
    await seed.save({ scope: 'global', kind: 'fact', content: '健康记录' })
    seed.flushSync()
    const healthy = runDoctor(dir)
    assert.equal(healthy.status, 0, healthy.output)
    // 纯词法库会有"待嵌入"提示，因此 PASS 或 WARN 都算健康；关键是不能 FAIL。
    assert.match(healthy.output, /结论：(PASS|WARN)/)
    assert.match(healthy.output, /[1-9]\d* 个作用域文件/, '应扫描到作用域文件')

    writeFileSync(join(dir, 'projects', 'global.jsonl'), '{"broken": true\n')
    const broken = runDoctor(dir)
    assert.equal(broken.status, 1, broken.output)
    assert.match(broken.output, /JSONL 完整性/)
    assert.match(broken.output, /结论：FAIL/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
