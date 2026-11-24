#!/usr/bin/env node
/**
 * 发布链路检查（0.102.0）。
 *
 * 回答「这次发布能不能被用户装到」：版本 → 产物 → tag → Release → 本地插件，逐段核对。
 *  ① 根 package.json 版本 = 产物 packages/dsh-memory/package.json 版本；
 *  ② `npm pack --dry-run` 的清单包含运行必需文件（lib/index.js、client、locale、icon…）；
 *  ③ 本地 git tag `v<version>` 存在（可选远端 tag）；
 *  ④ GitHub Release 存在（需要 gh，可 --offline 跳过）；
 *  ⑤ 本地 web profile 里已安装的插件版本 = 当前版本（可 --skip-plugin 跳过）。
 *
 * 用法：
 *   npm run release:check                 # 全检查（网络/gh 不可用时降级为警告）
 *   npm run release:check -- --offline    # 不查远端 tag / Release
 *   npm run release:check -- --strict     # 警告也当失败（发布前最后一道）
 *
 * 退出码：硬失败 1；否则 0。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const offline = args.includes('--offline')
const strict = args.includes('--strict')
const skipPlugin = args.includes('--skip-plugin')
const profileIndex = args.indexOf('--profile')
const profile = profileIndex >= 0 && args[profileIndex + 1]
  ? args[profileIndex + 1]
  : join(homedir(), '.dsh', 'profiles', 'web')

const checks = []
const add = (level, name, detail) => checks.push({ level, name, detail })
const fail = (name, detail) => add('fail', name, detail)
const warn = (name, detail) => add('warn', name, detail)
const ok = (name, detail) => add('ok', name, detail)

function run(cmd, cmdArgs, options = {}) {
  return execFileSync(cmd, cmdArgs, { encoding: 'utf8', timeout: 20_000, stdio: 'pipe', ...options })
}

const root = JSON.parse(readFileSync('package.json', 'utf8'))
const version = root.version
const tag = `v${version}`
const packedDir = join('packages', 'dsh-memory')
const packed = JSON.parse(readFileSync(join(packedDir, 'package.json'), 'utf8'))

// ① 版本一致
if (packed.version === version) ok('产物版本', `${version}（仓库与产物一致）`)
else fail('产物版本', `产物 ${packed.version} ≠ 仓库 ${version}（先 npm run build）`)

// ①b 文档一致：装的是仓库源码，包内 README/CHANGELOG 不同步 = 用户看到旧版说明。
for (const name of ['README.md', 'CHANGELOG.md']) {
  const rootText = readFileSync(name, 'utf8')
  const packedText = readFileSync(join(packedDir, name), 'utf8')
  if (rootText === packedText) ok('文档一致', name)
  else fail('文档一致', `${name} 根目录与 packages/dsh-memory/ 不一致（cp 同步后再发）`)
}

// ② npm pack 清单
try {
  const raw = run('npm', ['pack', '--dry-run', '--json'], { cwd: packedDir })
  // npm 的 --json 输出是「包名 → 清单」的对象（不是数组）。
  const parsed = JSON.parse(raw)
  const entry = Object.values(parsed)[0]
  const files = new Set((entry?.files ?? []).map((file) => file.path))
  const required = ['lib/index.js', 'lib/client.js', 'locale/zh.json', 'locale/en.json', 'icon.svg', 'README.md', 'LICENSE', 'CHANGELOG.md', 'cordis.patch.yml']
  const missing = required.filter((file) => !files.has(file))
  if (missing.length === 0) ok('npm 包清单', `${files.size} 个文件，运行必需文件齐全`)
  else fail('npm 包清单', `缺少 ${missing.join(' / ')}`)
} catch (error) {
  warn('npm 包清单', `npm pack 失败，跳过：${error instanceof Error ? error.message : String(error)}`)
}

// ③ 本地 tag
try {
  const tags = run('git', ['tag', '--list', tag]).trim()
  if (tags === tag) ok('本地 tag', tag)
  else warn('本地 tag', `${tag} 不存在（发布时需 git tag -a ${tag}）`)
} catch {
  warn('本地 tag', 'git 不可用，跳过')
}

// ④ 远端 tag / Release
if (offline) {
  warn('远端 tag / Release', '--offline 已跳过')
} else {
  try {
    const remote = run('git', ['ls-remote', '--tags', 'origin', tag])
    if (remote.includes(`refs/tags/${tag}`)) ok('远端 tag', tag)
    else warn('远端 tag', `${tag} 尚未推到 origin`)
  } catch {
    warn('远端 tag', 'git ls-remote 失败（网络不可用？），跳过')
  }
  try {
    run('gh', ['release', 'view', tag, '--json', 'tagName'])
    ok('GitHub Release', tag)
  } catch {
    warn('GitHub Release', 'gh 不可用 / Release 尚未生成，跳过')
  }
}

// ⑤ 本地插件版本
if (skipPlugin) {
  warn('本地插件版本', '--skip-plugin 已跳过')
} else {
  const installed = join(profile, 'node_modules', '@hanpu5838', 'dsh-memory', 'package.json')
  if (!existsSync(installed)) {
    warn('本地插件版本', `未安装到 ${profile}（发布后执行 remove_bundle + install_bundle）`)
  } else {
    const installedVersion = JSON.parse(readFileSync(installed, 'utf8')).version
    if (installedVersion === version) ok('本地插件版本', `${installedVersion}（已同步）`)
    else warn('本地插件版本', `已安装 ${installedVersion}，仓库 ${version}（发布后需重装插件）`)
  }
}

const icon = { ok: '✓', warn: '⚠', fail: '✗' }
console.log(`\nDSH 记忆系统 · 发布链路检查（${version}）\n`)
for (const check of checks) console.log(`${icon[check.level]} ${check.name}：${check.detail}`)
const fails = checks.filter((check) => check.level === 'fail').length
const warns = checks.filter((check) => check.level === 'warn').length
const verdict = fails > 0 || (strict && warns > 0) ? 'FAIL' : warns > 0 ? 'WARN' : 'PASS'
console.log(`\n结论：${verdict}（${checks.length - fails - warns} ok / ${warns} warn / ${fails} fail${strict ? '，strict' : ''}）\n`)
process.exit(verdict === 'FAIL' ? 1 : 0)
