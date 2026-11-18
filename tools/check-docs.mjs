#!/usr/bin/env node
/**
 * 文档一致性检查（0.92.0）—— 发布前守门，防止版本/链接漂移。
 *
 * 检查项：
 *   ① package.json 版本 vs README badge / 「当前版本」行；
 *   ② CHANGELOG 顶部条目、IMPROVEMENTS 顶部条目、architecture 标题里的版本；
 *   ③ README 里引用的本地文档、截图是否真实存在；
 *   ④ build 脚本里的 --version 是否与 package.json 一致；
 *   ⑤ README 是否有尚未替换的占位符（如 0.84.0 这类旧 badge 漂移会被抓出来）。
 *
 * 用法：node tools/check-docs.mjs   （在仓库根目录；CI 与 npm test 都会跑）
 * 退出码：全部一致 0；有 ✗ 1。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'

const read = (path) => readFileSync(path, 'utf8')
const checks = []
const ok = (name, detail) => checks.push({ level: 'ok', name, detail })
const fail = (name, detail) => checks.push({ level: 'fail', name, detail })
const warn = (name, detail) => checks.push({ level: 'warn', name, detail })

const pkg = JSON.parse(read('package.json'))
const version = String(pkg.version ?? '')
if (!/^\d+\.\d+\.\d+$/.test(version)) fail('package.json 版本', `格式异常：${version}`)
const tag = `v${version}`

// ① README badge / 当前版本行
const readme = read('README.md')
const badge = readme.match(/badge\/version-(v[\d.]+)-/)
if (badge === null) fail('README badge', '找不到 version badge')
else if (badge[1] !== tag) fail('README badge', `badge 是 ${badge[1]}，package.json 是 ${tag}`)
else ok('README badge', tag)
const versionLine = readme.split('\n').find((line) => line.includes('当前版本')) ?? ''
if (versionLine.includes(tag)) ok('README 当前版本行', versionLine.trim())
else fail('README 当前版本行', `「当前版本」行未包含 ${tag}：${versionLine.trim() || '(缺失)'}`)

// ② CHANGELOG / IMPROVEMENTS / architecture
const changelog = read('CHANGELOG.md')
const changelogTop = changelog.split('\n').find((line) => line.startsWith('## ')) ?? ''
if (changelogTop.startsWith(`## ${version} `) || changelogTop.startsWith(`## ${version}·`) || changelogTop.startsWith(`## ${version} —`)) {
  ok('CHANGELOG 顶部条目', changelogTop.trim())
} else {
  fail('CHANGELOG 顶部条目', `期望以「## ${version}」开头，实际：${changelogTop.trim() || '(空)'}`)
}
const improvements = read('IMPROVEMENTS.md')
if (improvements.includes(`## ${version}`)) ok('IMPROVEMENTS 条目', version)
else fail('IMPROVEMENTS 条目', `缺少「## ${version}」`)

const architecture = read('docs/architecture.md')
if (architecture.split('\n')[0]?.includes(version)) ok('architecture 标题版本', version)
else fail('architecture 标题版本', `首行：${architecture.split('\n')[0]}`)

// ③ README 链接与截图存在
const linked = [...readme.matchAll(/\]\(([^)\s]+\.md)\)/g)].map((match) => match[1])
  .filter((path) => !path.startsWith('http'))
for (const path of new Set(linked)) {
  if (path === 'LICENSE') continue
  if (existsSync(path)) ok('README 链接', path)
  else fail('README 链接', `${path} 不存在`)
}
const previews = new Set([...readme.matchAll(/preview\/([\w-]+\.png)/g)].map((match) => match[1]))
for (const file of previews) {
  if (existsSync(`preview/${file}`)) ok('README 截图', `preview/${file}`)
  else fail('README 截图', `preview/${file} 不存在`)
}

// ④ build 脚本版本
const build = String(pkg.scripts?.build ?? '')
if (build.includes(`--version ${version}`)) ok('build 脚本版本', version)
else fail('build 脚本版本', `build 脚本未指向 ${version}：${build}`)

// ⑤ 已知旧版本残留（badge 类漂移）
const staleBadges = [...readme.matchAll(/badge\/version-(v[\d.]+)-/g)].map((m) => m[1]).filter((v) => v !== tag)
if (staleBadges.length === 0) ok('README 旧版本残留', '无')
else fail('README 旧版本残留', staleBadges.join(', '))

// ⑥b README「当前最新 vX」不能落后于 package.json（0.108.0）
const latestLine = readme.split('\n').find((line) => line.includes('当前最新')) ?? ''
const latestMatch = /当前最新：\*\*(v\d+\.\d+\.\d+)\*\*/.exec(latestLine)
if (latestMatch === null) warn('README 当前最新', '没有找到「当前最新：**vX.Y.Z**」行')
else if (latestMatch[1] === tag) ok('README 当前最新', tag)
else fail('README 当前最新', `README 写 ${latestMatch[1]}，package.json 是 ${tag}`)

// ⑥ 文档里引用的 npm 命令与工具路径必须真实存在（0.105.0）
const docFiles = ['README.md', ...readdirSync('docs').filter((file) => file.endsWith('.md')).map((file) => `docs/${file}`)]
const referencedScripts = new Set()
const referencedTools = new Set()
for (const file of docFiles) {
  if (!existsSync(file)) continue
  const text = read(file)
  for (const match of text.matchAll(/npm run ([a-z0-9:]+)/g)) referencedScripts.add(match[1])
  for (const match of text.matchAll(/tools\/[A-Za-z0-9_./-]+\.(?:mjs|md|json|yml|yaml|ts)/g)) referencedTools.add(match[0])
}
for (const name of [...referencedScripts].sort()) {
  if (pkg.scripts !== undefined && Object.prototype.hasOwnProperty.call(pkg.scripts, name)) ok('文档命令', `npm run ${name}`)
  else fail('文档命令', `文档引用了 npm run ${name}，但 package.json 里没有这个 script`)
}
for (const path of [...referencedTools].sort()) {
  if (existsSync(path)) ok('文档工具路径', path)
  else fail('文档工具路径', `${path} 不存在（文档引用已失效）`)
}

const fails = checks.filter((check) => check.level === 'fail')
const icon = { ok: '✓', fail: '✗' }
console.log('\n文档一致性检查\n')
for (const check of checks) console.log(`${icon[check.level]} ${check.name}：${check.detail}`)
console.log(`\n结论：${fails.length > 0 ? 'FAIL' : 'PASS'}（${checks.length - fails.length} ok / ${fails.length} fail）\n`)
process.exit(fails.length > 0 ? 1 : 0)
