/**
 * Publish @hanpu5838/dsh-memory to npm.
 *
 *   node tools/publish-npm-packages.mjs --scope @hanpu5838 [--version 0.5.0] [--dry-run]
 *        [--credential npm-agent-use]     # devcred 凭据名(默认 npm-agent-use)
 *        [--token-file <npmrc-or-token-file>]
 *        [--skip-checks]
 *
 * 发布的是**单包**产物 `packages/dsh-memory`(0.4.0 起一个包一条 entry —— 0.3.x 那套
 * core+panel 双包已被 build-npm-packages.mjs 淘汰,见 README「为什么是一个包」)。
 *
 * Token handling(绝不经过 argv 或对话):
 *   default      `devcred inject` 把 NPM_TOKEN 交给一个只写文件、不回显的 node 子进程,
 *                由它写成私有 .npmrc;发布后连临时目录一起删掉
 *   --token-file 用一个已有的 npmrc / 裸 token 文件
 *
 * 发布前默认先跑 `npm test` 与 `npm run verify`(--skip-checks 可跳过),再 `npm whoami`
 * 做一次鉴权预检 —— 任何一步失败都在"什么都没发出去"的状态下中止。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PUBLISH_DIR = join(ROOT, 'packages', 'dsh-memory')

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : fallback
}
const SCOPE_ARG = typeof arg('scope', '') === 'string' ? arg('scope', '') : ''
const VERSION = typeof arg('version', '') === 'string' ? arg('version', '') : ''
const CREDENTIAL = typeof arg('credential', 'npm-agent-use') === 'string' ? arg('credential', 'npm-agent-use') : 'npm-agent-use'
const TOKEN_FILE = typeof arg('token-file', '') === 'string' ? arg('token-file', '') : ''
const DRY_RUN = arg('dry-run', false) === true
const SKIP_CHECKS = arg('skip-checks', false) === true
if (!SCOPE_ARG) {
  console.error('usage: node tools/publish-npm-packages.mjs --scope <npm-scope> [--version x.y.z] [--dry-run] [--token-file <file>]')
  process.exit(2)
}
const SCOPE = SCOPE_ARG.startsWith('@') ? SCOPE_ARG : `@${SCOPE_ARG}`
const NODE = process.execPath
const NPM_CLI = join(dirname(NODE), 'node_modules', 'npm', 'bin', 'npm-cli.js')
if (!existsSync(NPM_CLI)) {
  console.error(`npm CLI not found at ${NPM_CLI}`)
  process.exit(2)
}

const work = mkdtempSync(join(tmpdir(), 'dsh-memory-publish-'))
const npmrc = join(work, '.npmrc')
let cleaned = false
function cleanup() {
  if (cleaned) return
  cleaned = true
  rmSync(work, { recursive: true, force: true })
}
process.on('exit', cleanup)

/** 找到 devcred 可执行文件(Windows 上是 .exe;避免用 shell 拼接参数触发 DEP0190)。 */
function devcredPath() {
  if (process.platform !== 'win32') return 'devcred'
  const found = spawnSync('where.exe', ['devcred'], { encoding: 'utf8' })
  const first = (found.stdout ?? '').split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0)
  return first ?? 'devcred'
}

/**
 * 把 token 变成一份私有 .npmrc。**只写文件、不回显**:devcred 把 NPM_TOKEN 交给下面这个
 * node 包装脚本,它把值写进 <work>/token.txt;本进程再读该文件拼 .npmrc(整个过程没有任何
 * 一步把 token 写进 argv 或 stdout)。
 */
function prepareNpmrc() {
  if (TOKEN_FILE) {
    const text = readFileSync(TOKEN_FILE, 'utf8')
    const m = text.match(/:\s*_authToken\s*=\s*(\S+)/) ?? text.match(/^\s*(\S{20,})\s*$/)
    if (!m) throw new Error(`${TOKEN_FILE} carries no _authToken and no bare token`)
    writeFileSync(npmrc, `//registry.npmjs.org/:_authToken=${m[1]}\n`, 'ascii')
    console.log(`token source: file (${m[1].length} chars)`)
    return
  }
  const wrapper = join(work, 'token-writer.cjs')
  const target = join(work, 'token.txt')
  writeFileSync(wrapper, 'require("node:fs").writeFileSync(process.argv[2], process.env.NPM_TOKEN ?? "")\n', 'ascii')
  const injected = spawnSync(devcredPath(), ['inject', '--only', CREDENTIAL, '--', NODE, wrapper, target], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (injected.status !== 0 || !existsSync(target)) {
    throw new Error(`devcred inject failed (exit ${injected.status}): ${(injected.stderr ?? injected.stdout ?? '').trim().slice(0, 300)}`)
  }
  const value = readFileSync(target, 'utf8').trim()
  rmSync(target, { force: true })
  if (value.length < 20) throw new Error(`devcred credential "${CREDENTIAL}" produced no usable token`)
  writeFileSync(npmrc, `//registry.npmjs.org/:_authToken=${value}\n`, 'ascii')
  console.log(`token source: devcred vault (${CREDENTIAL}, ${value.length} chars)`)
}

function npm(args, opts = {}) {
  return spawnSync(NODE, [NPM_CLI, ...args, '--userconfig', npmrc, '--registry', 'https://registry.npmjs.org'], {
    encoding: 'utf8',
    cwd: opts.cwd ?? ROOT,
    env: { ...process.env, npm_config_loglevel: opts.loglevel ?? 'warn' },
  })
}

function run(label, args, cwd = ROOT) {
  console.log(`\n$ ${label}`)
  const res = spawnSync(NODE, [NPM_CLI, ...args], { encoding: 'utf8', cwd, env: { ...process.env, npm_config_loglevel: 'warn' } })
  process.stdout.write(res.stdout ?? '')
  if (res.status !== 0) {
    console.error(res.stderr ?? '')
    throw new Error(`${label} failed (exit ${res.status})`)
  }
}

try {
  prepareNpmrc()

  const who = npm(['whoami'])
  const user = (who.stdout ?? '').trim()
  if (who.status !== 0 || !user) {
    console.error(`npm whoami failed (exit ${who.status}) — the token is not usable: ${(who.stderr ?? '').trim().split('\n').slice(-3).join(' | ')}`)
    process.exit(1)
  }
  console.log(`authenticated as: ${user}`)

  if (!existsSync(join(PUBLISH_DIR, 'package.json'))) {
    throw new Error(`${PUBLISH_DIR} is missing — run \`npm run build\` first`)
  }
  const meta = JSON.parse(readFileSync(join(PUBLISH_DIR, 'package.json'), 'utf8'))
  const expected = `${SCOPE}/dsh-memory`
  if (meta.name !== expected) throw new Error(`built package name mismatch: ${meta.name} != ${expected}`)
  if (VERSION && meta.version !== VERSION) {
    throw new Error(`built package version ${meta.version} != --version ${VERSION}; rebuild with \`npm run build\``)
  }
  console.log(`package: ${meta.name}@${meta.version}`)

  if (!SKIP_CHECKS) {
    run('npm test', ['test'])
    run('npm run verify', ['run', 'verify'])
  }

  const packArgs = ['pack', '--json', '--dry-run', '--pack-destination', work]
  const packed = spawnSync(NODE, [NPM_CLI, ...packArgs], { encoding: 'utf8', cwd: PUBLISH_DIR })
  if (packed.status !== 0) throw new Error(`npm pack --dry-run failed: ${(packed.stderr ?? '').trim()}`)
  const info = JSON.parse((packed.stdout ?? '[]').trim() || '[]')[0]
  console.log(`\n${meta.name}@${meta.version}: ${info?.entryCount ?? '?'} files, ${((info?.size ?? 0) / 1024).toFixed(1)} KiB packed`)
  const files = (info?.files ?? []).map((f) => f.path)
  for (const required of ['package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js', 'lib/provider/scope.js', 'icon.svg', 'locale/en.json', 'locale/zh.json']) {
    if (!files.includes(required)) throw new Error(`package is missing ${required}`)
  }
  const stray = files.filter((f) => /node_modules|\.ts$|\.test\./.test(f))
  if (stray.length > 0) throw new Error(`package carries stray files: ${stray.join(', ')}`)

  if (DRY_RUN) {
    console.log('\nDRY RUN OK (nothing published)')
  } else {
    const pub = npm(['publish', '--access', 'public'], { cwd: PUBLISH_DIR })
    process.stdout.write(pub.stdout ?? '')
    if (pub.status !== 0) {
      // npm 的失败原因几乎都在 stderr(例如 409 staged version / EOTP 2FA / E401)
      process.stderr.write(pub.stderr ?? '')
      throw new Error(`npm publish failed (exit ${pub.status})`)
    }
    console.log(`\nPUBLISH OK: ${meta.name}@${meta.version}`)
  }
} catch (error) {
  console.error(`\nFAILED: ${error.message}`)
  process.exit(1)
} finally {
  cleanup()
}
