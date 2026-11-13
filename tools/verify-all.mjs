#!/usr/bin/env node
/**
 * 全功能验收：一条命令回答「现在到底有没有问题」。
 *
 * 它跑四层，任何一层失败都会让退出码非 0（可直接进 CI / pre-push hook）：
 *   1. 单元 / 集成测试（全量）
 *   2. 单包构建（source → packages/dsh-memory，签名/客户端 id/布局检查）
 *   3. 面板 API 冒烟（用构建产物起一个临时记忆库，真打 16 个关键接口）
 *   4. 向量后端实测（若本机有在跑的 llama-server：探活 + 真算一次 1024 维向量）
 *
 * 设计约束：
 *  - 不碰用户真实记忆库：第 3 步用 mkdtemp 的临时 storeDir；
 *  - 不下载任何东西：第 4 步只探本机已有服务，连不上就 SKIP；
 *  - 输出人话表格，失败项直接给出定位线索。
 *
 * 用法：`npm run verify:all`（或 `node tools/verify-all.mjs`）
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const OUT = join(ROOT, '.verify-run')

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const results = []
function report(id, label, status, detail) {
  results.push({ id, label, status, detail })
  console.log(`${status === 'PASS' ? '✓' : status === 'SKIP' ? '·' : '✗'} ${label}：${detail}`)
}
function run(args, options = {}) {
  return spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: options.timeoutMs ?? 600_000, ...options })
}

// ───────────────────────── 1. 全量测试 ─────────────────────────
function collectTests() {
  const files = []
  const sourceDir = join(ROOT, 'source')
  for (const pkgDir of readdirSync(sourceDir)) {
    const testDir = join(sourceDir, pkgDir, 'test')
    let entries = []
    try { entries = readdirSync(testDir) } catch { continue }
    for (const entry of entries) {
      if (entry.endsWith('.test.ts')) files.push(join(testDir, entry))
    }
  }
  return files
}

function stepTests() {
  const files = collectTests()
  if (files.length === 0) {
    report('tests', '单元 / 集成测试', 'FAIL', '没有找到任何 *.test.ts')
    return false
  }
  console.log(`… 运行 ${files.length} 个测试文件`)
  const startedAt = Date.now()
  const result = run(['--experimental-strip-types', '--test', ...files], { timeoutMs: 900_000 })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const tests = /ℹ tests (\d+)/u.exec(output)?.[1]
  const pass = /ℹ pass (\d+)/u.exec(output)?.[1]
  const fail = /ℹ fail (\d+)/u.exec(output)?.[1]
  const seconds = Math.round((Date.now() - startedAt) / 1000)
  const ok = result.status === 0 && (fail === '0' || fail === undefined)
  report('tests', '单元 / 集成测试', ok ? 'PASS' : 'FAIL',
    `${tests ?? '?'} 例 / ${pass ?? '?'} pass / ${fail ?? '?'} fail（${seconds}s）`)
  if (!ok) {
    const failing = output.split('\n').filter((line) => line.startsWith('✖') || line.includes('not ok')).slice(0, 10)
    if (failing.length > 0) console.log(failing.join('\n'))
  }
  return ok
}

// ───────────────────────── 2. 构建单包 ─────────────────────────
function stepBuild() {
  rmSync(OUT, { recursive: true, force: true })
  const result = run(['tools/build-single-package.mjs', '--scope', '@restregular', '--version', pkg.version, '--out', OUT, '--no-place'], { timeoutMs: 600_000 })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const ok = result.status === 0 && output.includes('BUILD OK')
  const line = /built ([^:]+): (\d+) files, ([^\n]+) ->/u.exec(output)
  report('build', '单包构建', ok ? 'PASS' : 'FAIL', line === null ? (ok ? 'BUILD OK' : output.trim().split('\n').slice(-3).join(' / ')) : `${line[2]} 文件 / ${line[3].trim()}`)
  return ok
}

// ───────────────────── 3. 面板 API 冒烟 ─────────────────────
async function stepPanelSmoke() {
  const lib = join(OUT, 'lib')
  let handleRequest
  let LocalMemoryService
  try {
    ;({ handleRequest } = await import(`file://${join(lib, 'panel.js')}`))
    ;({ LocalMemoryService } = await import(`file://${join(lib, 'provider/index.js')}`))
  } catch (error) {
    report('panel', '面板 API 冒烟', 'FAIL', `产物无法加载：${error?.message ?? error}`)
    return false
  }
  const storeDir = mkdtempSync(join(tmpdir(), 'dsh-verify-'))
  const svc = new LocalMemoryService({ storeDir, scopes: { global: true, project: true } })
  const ctx = { get: (name) => (name === 'memory' ? svc : undefined), logger: { warn() {} } }
  const ROUTE = '/memory/api'
  const call = (method, path, body) => new Promise((resolveCall) => {
    const out = { status: null, body: null }
    const res = { writeHead(status) { out.status = status }, end(text) { try { out.body = JSON.parse(text) } catch { out.body = String(text) } } }
    const req = {
      url: ROUTE + path,
      method,
      headers: { host: '127.0.0.1:19387' },
      async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) },
    }
    Promise.resolve(handleRequest(ctx, ROUTE, req, res)).then(() => resolveCall(out))
  })
  const checks = [
    ['GET', '/status', undefined, (v) => v != null],
    ['GET', '/records?scope=global', undefined, (v) => Array.isArray(v?.records)],
    ['POST', '/create', { scope: 'global', kind: 'fact', content: 'verify-all 冒烟样本' }, (v) => typeof (v?.id ?? v?.record?.id) === 'string'],
    ['GET', '/search?q=verify', undefined, (v) => v != null],
    ['GET', '/health', undefined, (v) => v != null],
    ['GET', '/conflicts', undefined, (v) => Array.isArray(v?.conflicts)],
    ['GET', '/backups', undefined, (v) => Array.isArray(v?.backups)],
    ['POST', '/backups', {}, (v) => typeof v?.name === 'string'],
    ['GET', '/audit', undefined, (v) => v != null],
    ['GET', '/visibility?session=verify-all', undefined, (v) => v != null],
    ['GET', '/embed/status', undefined, (v) => typeof v?.provider === 'string'],
    ['GET', '/analysis/overview', undefined, (v) => v != null],
    ['GET', '/export', undefined, (v) => v != null],
    ['GET', '/selfcheck', undefined, (v) => Array.isArray(v?.checks)],
    ['GET', '/anchor?q=verify', undefined, () => true],
    ['POST', '/provider', { provider: 'off' }, () => true],
  ]
  const failed = []
  for (const [method, path, body, verify] of checks) {
    try {
      const out = await call(method, path, body)
      if (out.status !== 200 || out.body?.ok !== true || !verify(out.body?.value)) {
        failed.push(`${method} ${path} → HTTP ${out.status} ${out.body?.error?.message ?? ''}`)
      }
    } catch (error) {
      failed.push(`${method} ${path} → 抛错 ${error?.message ?? error}`)
    }
  }
  rmSync(storeDir, { recursive: true, force: true })
  const ok = failed.length === 0
  report('panel', '面板 API 冒烟', ok ? 'PASS' : 'FAIL', ok ? `${checks.length}/${checks.length} 接口通过` : `失败 ${failed.length}：${failed.slice(0, 3).join('；')}`)
  return ok
}

// ───────────────────── 4. 向量后端实测（可选）─────────────────────
async function stepVector() {
  const endpoint = process.env.DSH_MEMORY_VERIFY_ENDPOINT ?? 'http://127.0.0.1:8078/v1/embeddings'
  const healthUrl = new URL('../health', endpoint).toString()
  let healthy = false
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(1500) })
    healthy = res.ok
  } catch { /* 没有在跑的服务 */ }
  if (!healthy) {
    report('vector', '向量后端实测', 'SKIP', `未发现运行中的服务（${healthUrl}）；装了 llm 后端时可用 DSH_MEMORY_VERIFY_ENDPOINT 指定`)
    return true
  }
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: ['verify-all 探针'], model: 'bge-m3' }),
      signal: AbortSignal.timeout(30_000),
    })
    const body = await res.json()
    const dims = body?.data?.[0]?.embedding?.length ?? 0
    const ok = res.ok && dims > 0
    report('vector', '向量后端实测', ok ? 'PASS' : 'FAIL', ok ? `${healthUrl} · ${dims} 维` : `HTTP ${res.status}`)
    return ok
  } catch (error) {
    report('vector', '向量后端实测', 'FAIL', `请求失败：${error?.message ?? error}`)
    return false
  }
}

// ───────────────────────── 汇总 ─────────────────────────
async function main() {
  // 验收脚本本身绝不触发自举（装包/下模型）：冒烟用的临时服务实例也会跑构造函数，
  // 不关掉就会去 /tmp 下 438MB 模型。需要验收真实自举请单独跑，不走本脚本。
  if ((process.env.DSH_MEMORY_AUTO_BOOTSTRAP ?? '').trim() === '') process.env.DSH_MEMORY_AUTO_BOOTSTRAP = 'off'
  console.log(`\nDSH 记忆系统 · 全功能验收（v${pkg.version}）\n`)
  let ok = true
  ok = stepTests() && ok
  ok = stepBuild() && ok
  if (ok) ok = (await stepPanelSmoke()) && ok
  else report('panel', '面板 API 冒烟', 'SKIP', '构建失败，跳过')
  ok = (await stepVector()) && ok
  rmSync(OUT, { recursive: true, force: true })

  const pass = results.filter((item) => item.status === 'PASS').length
  const fail = results.filter((item) => item.status === 'FAIL').length
  const skip = results.filter((item) => item.status === 'SKIP').length
  console.log(`\n结论：${fail === 0 ? 'PASS' : 'FAIL'}（${pass} 通过 / ${fail} 失败 / ${skip} 跳过）\n`)
  process.exit(fail === 0 && ok ? 0 : 1)
}

main().catch((error) => {
  console.error('验收脚本自身出错：', error)
  process.exit(2)
})
