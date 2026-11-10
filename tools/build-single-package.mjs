/**
 * 把四个源半边打成一个 npm 包:`@scope/dsh-memory`(单包单入口)。
 *
 *   node tools/build-single-package.mjs --scope @restregular [--version 0.2.0]
 *        [--out .build/single] [--repo https://github.com/...] [--no-place]
 *        [--host-modules <dir>]     # 做真实加载验证用的宿主包目录(可选)
 *
 * 为什么是「一个包一条 entry」,而不是"一个包含四条 entry":
 *   宿主的 dsh-client-modules 只在「某条活 Loader entry 能解析到包名」时才为该包
 *   提供 client bundle,并且要求一个包名只有一个解析源(reconcilePackage:
 *   "resolves from multiple active Loader sources")。一个包里同时挂 3~4 条 entry
 *   (裸名 + 子路径)今天能跑,但它依赖"子路径行对 client 扫描不可见"这一实现细节;
 *   一旦宿主收紧,同包名立刻变成多个来源 → 客户端图组合失败 → 桌面端起不来。
 *   一条 entry 则在任何解读下都成立(与 dshmarket 同形)。
 *
 * 产出布局(与旧的两个包逐文件对应,只是合并到一处):
 *   lib/index.js          单入口:组合 provider / 工具 / 注入 / 面板
 *   lib/provider/*.js     存储 + 检索 + 向量后端 + 一键安装
 *   lib/tools/*.js        四个模型工具
 *   lib/inject/*.js       agent/pre-step 召回注入
 *   lib/panel.js          面板服务端路由(含同源/登录围栏)
 *   lib/client.js         面板客户端 bundle(注册 id == 包名,由 preflight 检查)
 *   locale/*.json         插件列表的显示名 / 描述(宿主 readPluginMeta 读 meta.title)
 *   icon.svg              插件列表图标(包内 SVG,宿主按 30/36px 渲染)
 *   cordis.patch.yml      一行纯 insert(可热挂载)
 *
 * 构建方式沿用旧脚本:node 内置的类型剥离(无工具链),相对 .ts 说明符改写为 .js,
 * 跨半边相对 import 重映射,每个文件 node --check,最后用**普通 node** import 入口
 * 证明产物在真实安装环境能跑(需要宿主包,缺失时跳过并说明)。
 */
import { stripTypeScriptTypes } from 'node:module'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PKGS = existsSync(join(ROOT, 'source')) ? join(ROOT, 'source') : join(ROOT, 'packages')

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback
}
const has = (name) => process.argv.includes(`--${name}`)

const SCOPE = (arg('scope', '') || '').replace(/^@?/, '@')
if (!arg('scope', '')) {
  console.error('usage: node tools/build-single-package.mjs --scope <npm-scope> [--version x.y.z] [--out dir] [--repo url]')
  process.exit(2)
}
const VERSION = arg('version', '0.2.0')
const OUT = resolve(ROOT, arg('out', '.build/single'))
const REPO_URL = arg('repo', '')
const HOST_MODULES = arg('host-modules', process.env.DSH_HOST_MODULES ?? '')
const PLACE = !has('no-place')
const PLACE_DIR = join(ROOT, 'packages', 'dsh-memory')
const LEGACY_DIR = join(ROOT, 'packages', 'dsh-memory-panel')
const NAME = `${SCOPE}/dsh-memory`

const emitted = []

/** 源半边 → 包内目录。lib/{provider,tools,inject} 与旧核心包一致,便于对照。 */
const GROUPS = [
  { src: join(PKGS, 'memory-local', 'src'), dest: 'lib/provider' },
  { src: join(PKGS, 'tool-memory', 'src'), dest: 'lib/tools' },
  { src: join(PKGS, 'memory-inject', 'src'), dest: 'lib/inject' },
  { src: join(PKGS, 'memory-plugin', 'src'), dest: 'lib' },
]

/**
 * 半边之间的相对 import 落位重映射。源码树里每条 import 都按**源码目录**写
 * (`../memory-local/src/x` / `../../memory-local/src/x`),而产物里半边被摊平成
 * `lib/{provider,tools,inject}` 与 `lib/panel.js`,所以同一段源码落在不同半边里
 * 需要不同的目标 —— 因此 `to` 是**按输出目录算的函数**,由 OUT 下所属半边决定:
 *   lib/provider/*  → ./x.js            lib/tools/*  → ../provider/x.js
 *   lib/panel.js    → ../provider/x.js  lib/index.js → ./provider|x.js
 * 规则只认"源码形状",不认"当前文本已被改过",所以顺序无关。
 */
/** 产物文件所在的半边(用 posix 分隔判断,跨平台一致)。 */
function halfOf(destFile) {
  const posix = destFile.split('\\').join('/')
  if (posix.endsWith('/lib/panel.js') || posix.endsWith('/lib/index.js')) return 'entry'
  if (posix.includes('/lib/provider/')) return 'provider'
  if (posix.includes('/lib/tools/')) return 'tools'
  if (posix.includes('/lib/inject/')) return 'inject'
  return 'unknown'
}

const REWRITES = [
  {
    // 工具 / 注入 / 面板半边引用 provider(源码树里的 `../../memory-local/src/x`)。
    // 产物里:lib/tools|inject/ 与 lib/provider 同级 → ../provider/;lib/panel.js 也在
    // lib/ 下 → ./provider/;provider 自己 → ./。
    from: /(?:\.\.\/){2}memory-local\/src\/(.+)/,
    to: (half, file) => (half === 'provider' ? `./${file}` : half === 'entry' ? `./provider/${file}` : `../provider/${file}`),
  },
  {
    // `../memory-local/src/x` —— 单入口(lib/index.js)与 provider 半边自己。
    // 用"从字符串开头匹配"而不是 `^(\.\.\/)` 组:前一条规则已经处理过 `../../`。
    from: /^\.\.\/memory-local\/src\/(.+)/,
    to: (half, file) => (half === 'provider' || half === 'tools' || half === 'inject' ? `../provider/${file}` : `./provider/${file}`),
  },
  // 单入口引用的另外半边:工具 / 注入 / 面板
  {
    from: /^\.\.\/(tool-memory|memory-inject)\/src\/(.+)/,
    to: (_half, group, file) => `${group === 'tool-memory' ? './tools' : './inject'}/${file}`,
  },
  { from: /^\.\.\/memory-panel\/lib\/(.+)/, to: (_half, file) => (file === 'index.js' ? './panel.js' : `./${file}`) },
]

/** 按"半边"重写一条 specifier;未匹配任何规则时原样返回。 */
function rewriteSpecifier(spec, half) {
  for (const rule of REWRITES) {
    const match = rule.from.exec(spec)
    rule.from.lastIndex = 0
    if (!match) continue
    const target = rule.to(half, ...match.slice(1))
    return spec.slice(0, match.index) + target + spec.slice(match.index + match[0].length)
  }
  return spec
}

function transpileFile(srcFile, destFile) {
  let code = readFileSync(srcFile, 'utf8')
  // sourceUrl 必须是**仓库相对 posix 路径**:传绝对路径会把构建者的 checkout
  // 位置(例如 D:\.deepseek\memory-plugin\… 或 C:\Users\…\dsh-memory\…)写进每个
  // 产出文件。那既泄露本机路径,又让同一份源码在不同机器上产出不同字节 ——
  // 于是"提交的产物必须等于源码重建"这条护栏会对所有人假报错(dsh-market
  // #472/#563/#570 是同一类问题的三个不同表现)。
  const sourceUrl = relative(ROOT, srcFile).split('\\').join('/')
  const half = halfOf(destFile)
  code = stripTypeScriptTypes(code, { mode: 'strip', sourceUrl })
  code = code.replace(/(from\s*')(\.[^']*?)\.ts(')/g, '$1$2.js$3')
  code = code.replace(/(import\(')(\.[^']*?)\.ts('\))/g, '$1$2.js$3')
  // 只重写 specifier 本身,不动 import 语句的形状:源码里的 import 可能是多行的
  // (`import {\n a,\n b,\n} from '../x'`),按整条语句匹配会漏掉它们。
  // 匹配 `'./` / `'../` 开头的相对 specifier,再交给 rewriteSpecifier。
  code = code.replace(/(['"])(\.\.?\/[^'"]*)\1/g, (whole, quote, spec) => {
    const target = rewriteSpecifier(spec, half)
    return target === spec ? whole : `${quote}${target}${quote}`
  })
  mkdirSync(dirname(destFile), { recursive: true })
  writeFileSync(destFile, code, 'utf8')
  emitted.push(destFile)
}

function copyTree(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true })
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const src = join(srcDir, entry.name)
    if (entry.isDirectory()) { copyTree(src, join(destDir, entry.name)); continue }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts') || entry.name.endsWith('.d.ts')) continue
    transpileFile(src, join(destDir, entry.name.replace(/\.ts$/, '.js')))
  }
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

const OWNER = SCOPE.replace(/^@/, '')

const PATCH = `# ${NAME} bundle patch: 单包单入口 —— provider + 模型工具 + 召回注入 + 面板(服务端与客户端同包)。
#
# 只有一行,而且必须是包名:宿主的 client-modules 只为「能解析到包名的活 entry」
# 提供 client bundle(见 dsh-client-modules reconcilePackage)。纯 insert、不带
# config,是为了让这一行可被宿主热挂载(带 config 只能重启生效)。
- insert:
    - id: dsh-memory
      name: '${NAME}'
`

const MIT_LICENSE = `MIT License

Copyright (c) 2026 ${OWNER}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`

// 包的 README 直接用仓库根目录那份:单一来源,免得 npm 页面上讲的还是旧按钮/旧按钮名。
const README = readFileSync(join(ROOT, 'README.md'), 'utf8')
const CHANGELOG = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')


// ------------------------------------------------------------------ build

rmSync(OUT, { recursive: true, force: true })
for (const group of GROUPS) copyTree(group.src, join(OUT, group.dest))

// 面板:服务端半边 → lib/panel.js。它本来也走 copyTree 的改写(0.5.0 起因与 provider
// 共用 scope 规范化而有了相对 import),所以这里用 transpileFile —— client.js 是浏览器
// bundle,必须逐字节原样复制。`stripTypeScriptTypes` 对纯 JS 是恒等的,产物不变。
const panelDir = join(PKGS, 'memory-panel')
mkdirSync(join(OUT, 'lib'), { recursive: true })
transpileFile(join(panelDir, 'lib', 'index.js'), join(OUT, 'lib', 'panel.js'))
cpSync(join(panelDir, 'lib', 'client.js'), join(OUT, 'lib', 'client.js'))
cpSync(join(panelDir, 'icon.svg'), join(OUT, 'icon.svg'))
// 显示名 / 描述由宿主的 readPluginMeta 读 `<包>/locale/<lang>.json` 的 meta.title /
// meta.description,并且**必须通过 exports 能解析到**(Node ESM 解析)。所以 locale
// 目录要原样进包,exports 也要放行。
cpSync(join(panelDir, 'locale'), join(OUT, 'locale'), { recursive: true })

writeJson(join(OUT, 'package.json'), {
  name: NAME,
  version: VERSION,
  description: 'DeepSeek Harness 记忆系统(单包单入口):JSONL 存储 + 本地向量检索(BGE-M3)+ 五个模型工具 + 自动召回注入 + 管理面板。',
  icon: './icon.svg',
  type: 'module',
  exports: {
    '.': './lib/index.js',
    './client': './lib/client.js',
    './locale/en.json': './locale/en.json',
    './locale/zh.json': './locale/zh.json',
    './package.json': './package.json',
  },
  files: ['lib/', 'locale/', 'cordis.patch.yml', 'icon.svg', 'README.md', 'CHANGELOG.md', 'LICENSE'],
  dsh: {
    bundle: { patch: './cordis.patch.yml' },
    client: { inject: ['@deepseek-ai/dsh-client-ui-slots'], platform: 'web' },
  },
  peerDependencies: {
    '@deepseek-ai/cordis': '*',
    '@deepseek-ai/dsh-tools': '*',
    '@deepseek-ai/dsh-llm': '*',
  },
  peerDependenciesMeta: {
    '@deepseek-ai/cordis': { optional: true },
    '@deepseek-ai/dsh-tools': { optional: true },
    '@deepseek-ai/dsh-llm': { optional: true },
  },
  ...(REPO_URL
    ? {
        repository: { type: 'git', url: REPO_URL.startsWith('git+') ? REPO_URL : `git+${REPO_URL}`, directory: 'packages/dsh-memory' },
        homepage: `${REPO_URL.replace(/^git\+/, '').replace(/\.git$/, '')}#readme`,
        bugs: { url: `${REPO_URL.replace(/^git\+/, '').replace(/\.git$/, '')}/issues` },
      }
    : {}),
  // 原作者署名：MIT 要求保留原始版权声明；维护者信息放在 contributors。
  author: 'RestRegular (original author)',
  contributors: [{ name: 'HANPU5838', url: 'https://github.com/HANPU5838' }],
  // 作用域包默认是私有可见性,发 npm 必须显式 public —— 写进包里,`npm publish` 不加参数也不会错。
  publishConfig: { access: 'public' },
  keywords: ['dsh-plugin', 'deepseek-harness', 'memory', 'bge-m3', 'embeddings', 'recall', 'panel'],
  engines: { node: '>=22.13.0' },
  license: 'MIT',
})
writeFileSync(join(OUT, 'cordis.patch.yml'), PATCH, 'utf8')
writeFileSync(join(OUT, 'README.md'), README, 'utf8')
writeFileSync(join(OUT, 'CHANGELOG.md'), CHANGELOG, 'utf8')
writeFileSync(join(OUT, 'LICENSE'), MIT_LICENSE, 'utf8')

// ------------------------------------------------------------------ checks

let bad = 0
for (const file of emitted) {
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (res.status !== 0) { console.error(`SYNTAX FAIL ${relative(ROOT, file)}\n${res.stderr}`); bad++ }
  const leftovers = [...readFileSync(file, 'utf8').matchAll(/from\s*'(\.[^']*\.ts)'/g)].map((m) => m[1])
  if (leftovers.length > 0) { console.error(`TS SPECIFIER LEFT ${relative(ROOT, file)}: ${leftovers.join(', ')}`); bad++ }
}
// 入口的跨半边改写必须真的生效(少了它,产物装到用户机器上才会 Cannot find module)
const entry = readFileSync(join(OUT, 'lib', 'index.js'), 'utf8')
for (const spec of ['./provider/apply.js', './tools/apply.js', './inject/apply.js', './panel.js']) {
  if (!entry.includes(`'${spec}'`)) { console.error(`ENTRY IMPORT MISSING ${spec} (rewrite did not apply)`); bad++ }
}

// patch:必须只有一行 insert,且 name 就是包名(这条在 dsh-market 那边叫 preflight:
// dsh-market → dshmarket 改名后,1.0.0 与 1.0.1 都因为这类裸字符串发过坏包)
const patchText = readFileSync(join(OUT, 'cordis.patch.yml'), 'utf8')
const patchNames = [...patchText.matchAll(/^\s*name:\s*'([^']+)'/gm)].map((m) => m[1])
if (patchNames.length !== 1 || patchNames[0] !== NAME) {
  console.error(`PATCH NAME FAIL: expected exactly one name '${NAME}', got ${JSON.stringify(patchNames)}`)
  bad++
}
// package.json:单包必须同时带 dsh.bundle 与 dsh.client,并且导出 ./client
const meta = JSON.parse(readFileSync(join(OUT, 'package.json'), 'utf8'))
if (meta.name !== NAME) { console.error(`PACKAGE NAME FAIL: ${meta.name} != ${NAME}`); bad++ }
if (meta.dsh?.bundle?.patch === undefined) { console.error('PACKAGE FAIL: missing dsh.bundle.patch'); bad++ }
if (meta.dsh?.client?.platform !== 'web') { console.error('PACKAGE FAIL: missing dsh.client.platform=web'); bad++ }
if (meta.exports?.['./client'] !== './lib/client.js') { console.error('PACKAGE FAIL: missing exports["./client"]'); bad++ }
// 显示名 / 描述:宿主只读包内 locale/<lang>.json,而且必须能通过 exports 解析到
// (Node ESM 解析)。缺任何一步都**静默**回退成包名 / package.json description ——
// 插件列表里就还是 @restregular/dsh-memory 那一长串。
for (const lang of ['en', 'zh']) {
  const file = join(OUT, 'locale', `${lang}.json`)
  if (!existsSync(file)) { console.error(`LOCALE FAIL: missing locale/${lang}.json`); bad++; continue }
  let locale
  try { locale = JSON.parse(readFileSync(file, 'utf8')) } catch (error) { console.error(`LOCALE FAIL: locale/${lang}.json is not JSON: ${error.message}`); bad++; continue }
  if (typeof locale?.meta?.title !== 'string' || locale.meta.title.trim() === '') { console.error(`LOCALE FAIL: locale/${lang}.json lacks meta.title`); bad++ }
  if (typeof locale?.meta?.description !== 'string' || locale.meta.description.trim() === '') { console.error(`LOCALE FAIL: locale/${lang}.json lacks meta.description`); bad++ }
  if (meta.exports?.[`./locale/${lang}.json`] !== `./locale/${lang}.json`) { console.error(`LOCALE FAIL: exports is missing "./locale/${lang}.json"`); bad++ }
}
// 图标:宿主只接受包内 svg/png/jpeg/webp 且 ≤256 KiB。
const iconFile = join(OUT, 'icon.svg')
if (!existsSync(iconFile)) { console.error('ICON FAIL: missing icon.svg'); bad++ }
else if (statSync(iconFile).size > 256 * 1024) { console.error(`ICON FAIL: icon.svg exceeds 256 KiB (${statSync(iconFile).size} bytes)`); bad++ }
else if (!readFileSync(iconFile, 'utf8').trimStart().startsWith('<svg')) { console.error('ICON FAIL: icon.svg is not an SVG document'); bad++ }
// 客户端 bundle:注册 id 必须 == 包名(client-modules 按包名建图行)
const client = readFileSync(join(OUT, 'lib', 'client.js'), 'utf8')
const declared = client.match(/__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/)
if (!declared) { console.error('CLIENT FAIL: no window.__ModuleLoader__.load({ id: … }) registration'); bad++ }
else if (declared[1] !== NAME) { console.error(`CLIENT ID FAIL: bundle registers "${declared[1]}" but the package is "${NAME}"`); bad++ }
else console.log(`client id check: "${declared[1]}" == package name ✓`)

// 加载验证:用**普通 node**(没有 --experimental-strip-types)import 入口,
// 证明产物在真实安装环境里能解析、能被加载。
//
// HOST_MODULES 要指向一个 **@deepseek-ai 目录**(即里面直接是 cordis / dsh-tools /
// dsh-llm … 这些包目录)。整棵树用一个 junction 挂到 <out>/node_modules/@deepseek-ai:
// 这样每个宿主包要的兄弟包都会命中同一层 parent/node_modules/@deepseek-ai/<name>,
// 与真实 profile 的解析路径一致。
function verifyLoads() {
  if (!HOST_MODULES) {
    console.log('skip load proof: pass --host-modules <dir-of-@deepseek-ai> (or set DSH_HOST_MODULES) to enable it')
    return
  }
  if (!existsSync(join(HOST_MODULES, 'cordis'))) {
    console.error(`LOAD FAIL: ${HOST_MODULES} 不像 @deepseek-ai 目录(里面应有 cordis/、dsh-tools/ 等)`)
    bad++
    return
  }
  const nm = join(OUT, 'node_modules')
  rmSync(nm, { recursive: true, force: true })
  mkdirSync(nm, { recursive: true })
  try { symlinkSync(resolve(HOST_MODULES), join(nm, '@deepseek-ai'), 'junction') } catch (error) {
    console.error(`junction failed: ${error.message}`); bad++; return
  }
  const targets = [join(OUT, 'lib', 'index.js'), join(OUT, 'lib', 'panel.js')]
  const script = `
const targets = ${JSON.stringify(targets.map((t) => t.replace(/\\/g, '/')))}
for (const t of targets) {
  const mod = await import('file:///' + t)
  console.log('loaded', t.split('/').slice(-2).join('/'), '-> apply=' + typeof mod.apply, 'name=' + (mod.name ?? '(none)'))
}
`
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
  rmSync(nm, { recursive: true, force: true })
  process.stdout.write(res.stdout ?? '')
  if (res.status !== 0) { console.error(`LOAD FAIL\n${res.stderr ?? ''}`); bad++ }
}
verifyLoads()

const count = (dir) => {
  let n = 0, bytes = 0
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else { n++; bytes += statSync(p).size }
    }
  }
  walk(dir)
  return { n, bytes }
}
const { n, bytes } = count(OUT)
console.log(`\nbuilt ${NAME}@${VERSION}: ${n} files, ${(bytes / 1024).toFixed(1)} KiB -> ${relative(ROOT, OUT)}`)

// ------------------------------------------------------------------ place

if (PLACE) {
  rmSync(PLACE_DIR, { recursive: true, force: true })
  mkdirSync(dirname(PLACE_DIR), { recursive: true })
  cpSync(OUT, PLACE_DIR, { recursive: true, filter: (src) => !src.includes(`${'node_modules'}`) })
  console.log(`placed ${relative(ROOT, PLACE_DIR)}`)
  if (existsSync(LEGACY_DIR)) {
    console.log(`note: ${relative(ROOT, LEGACY_DIR)} 是旧的独立面板包,合并后已无构建来源 —— 验证通过后可删除`)
  }
}

console.log(bad === 0 ? '\nBUILD OK' : `\nBUILD FAILED (${bad} problem(s))`)
process.exit(bad === 0 ? 0 : 1)
