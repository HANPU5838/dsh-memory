#!/usr/bin/env node
/**
 * 打包产物安装验证：按 **装进用户机器后的样子** 验证，而不是看仓库源码。
 *
 * 背景：1.7.0–1.7.5 换图标时连出 6 个补丁，其中「318 KB 图标超过宿主 256 KiB
 * 上限」会让插件整个被停用 —— 构建能过、测试能过，只有真正安装才暴露。
 *
 * 这里做的事：
 *   1. 只把 package.json `files` 白名单里的东西复制到临时目录（= 安装后的形态）；
 *   2. 按宿主规则校验图标（存在 / ≤256 KiB / PNG 或 SVG 签名）、exports 目标；
 *   3. 从临时目录加载入口与四个半边，确认能 import；
 *   4. 断言工具注册表是 10 个。
 *
 * 用法：node tools/verify-packed-install.mjs [--package packages/dsh-memory]
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerHooks } from 'node:module'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PKG_ARG = process.argv.includes('--package')
  ? process.argv[process.argv.indexOf('--package') + 1]
  : 'packages/dsh-memory'
// resolve 而不是 join：--package 允许绝对路径（verify:all 传的就是绝对路径）。
const PKG = resolve(ROOT, PKG_ARG)

const ICON_LIMIT = 256 * 1024
const problems = []
const ok = (label, detail = '') => console.log(`✓ ${label}${detail ? `：${detail}` : ''}`)
const bad = (label, detail) => { problems.push(`${label}：${detail}`); console.log(`✗ ${label}：${detail}`) }

const meta = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'))
const iconField = typeof meta.icon === 'string' ? meta.icon.replace(/^\.\//, '') : ''

const dir = mkdtempSync(join(tmpdir(), 'dsh-packed-install-'))
try {
  // ── 1. 只复制 files 白名单：这正是 pnpm 安装时保留的内容 ──
  const files = Array.isArray(meta.files) ? meta.files : []
  if (files.length === 0) bad('files 白名单', 'package.json 没有 files，安装内容不可控')
  for (const entry of files) {
    const from = join(PKG, entry)
    if (!existsSync(from)) { bad('白名单文件缺失', entry); continue }
    const to = join(dir, entry.replace(/\/$/, ''))
    cpSync(from, to, { recursive: true })
  }
  ok('files 白名单复制', `${files.length} 项`)

  // ── 2. 宿主元数据规则 ──
  if (iconField === '') bad('图标', 'package.json 没有 icon 字段')
  else {
    const iconPath = join(dir, iconField)
    if (!existsSync(iconPath)) bad('图标缺失', iconField)
    else {
      const size = statSync(iconPath).size
      const head = readFileSync(iconPath).subarray(0, 4)
      const isPng = head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      const isSvg = readFileSync(iconPath, 'utf8').trimStart().startsWith('<svg')
      if (!isPng && !isSvg) bad('图标格式', `${iconField} 既不是 PNG 也不是 SVG`)
      else if (size > ICON_LIMIT) bad('图标超限', `${size} 字节，宿主上限 ${ICON_LIMIT}（超限会让插件被停用）`)
      else ok('图标', `${iconField} ${size} 字节 ${isPng ? 'PNG' : 'SVG'}`)
    }
  }
  for (const [sub, target] of Object.entries(meta.exports ?? {})) {
    const file = String(target).replace(/^\.\//, '')
    // package.json 由 npm 强制打包，不在 files 白名单里也一定存在。
    if (file === 'package.json' || existsSync(join(dir, file))) continue
    bad('exports 目标缺失', `${sub} → ${file}`)
  }

  // ── 3. 从「安装后的目录」加载，确认没有依赖仓库里没打包的文件 ──
  const CORDIS = 'data:text/javascript,' + encodeURIComponent('export class Service { constructor(ctx, name) { this.ctx = ctx; this.name = name } }')
  const TOOLS = 'data:text/javascript,' + encodeURIComponent('export function defineTool(spec) { return spec }')
  const LLM = 'data:text/javascript,' + encodeURIComponent('export function createUserMessage(input) { return { role: "user", content: [], source: { kind: "memory" } } }')
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === '@deepseek-ai/cordis') return { url: CORDIS, shortCircuit: true }
      if (specifier === '@deepseek-ai/dsh-tools') return { url: TOOLS, shortCircuit: true }
      if (specifier === '@deepseek-ai/dsh-llm') return { url: LLM, shortCircuit: true }
      return nextResolve(specifier, context)
    },
  })
  const entry = await import(new URL(`file://${join(dir, 'lib', 'index.js')}`))
  if (typeof entry.apply !== 'function') bad('入口', 'lib/index.js 没有导出 apply')
  else ok('入口加载', 'lib/index.js')

  for (const half of ['provider/apply.js', 'tools/apply.js', 'inject/apply.js', 'panel.js']) {
    try {
      await import(new URL(`file://${join(dir, 'lib', half)}`))
      ok('半边加载', half)
    } catch (error) {
      bad('半边加载失败', `${half} — ${error.message.split('\n')[0]}`)
    }
  }

  const toolsModule = await import(new URL(`file://${join(dir, 'lib', 'tools', 'index.js')}`))
  const names = Object.keys(toolsModule.memoryTools({ getService: () => ({}) })).sort()
  if (names.length === 10) ok('工具注册', names.join(','))
  else bad('工具数量', `期望 10 个，实际 ${names.length}：${names.join(',')}`)

  // ── 4. 客户端 bundle 必须注册自己的包名 ──
  const client = readFileSync(join(dir, 'lib', 'client.js'), 'utf8')
  const declared = client.match(/__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/)
  if (declared?.[1] !== meta.name) bad('客户端 bundle', `注册 id ${declared?.[1] ?? '(无)'} != 包名 ${meta.name}`)
  else ok('客户端 bundle', declared[1])
} catch (error) {
  bad('安装验证异常', error.message.split('\n')[0])
} finally {
  rmSync(dir, { recursive: true, force: true })
}

if (problems.length > 0) {
  console.error(`\n安装验证失败（${problems.length} 项）`)
  process.exit(1)
}
console.log('\n安装验证通过：装进去的就是能跑的')
