/**
 * Build publish-ready npm packages for the DSH memory plugin.
 *
 *   node tools/build-npm-packages.mjs --scope <npm-scope> [--version 0.1.0] [--out dist-npm]
 *
 * Produces two packages (the split is forced by the host: a package declaring
 * `dsh.client` may have exactly ONE active loader entry — see
 * dsh-client-modules reconcilePackage, "resolves from multiple active Loader
 * sources"):
 *
 *   <scope>/dsh-memory         provider + tools + inject   (no dsh.client → 3 entries OK)
 *   <scope>/dsh-memory-panel   panel server half + client bundle (1 entry)
 *
 * TypeScript is stripped with node:module's built-in stripper (no toolchain
 * dependency), relative `.ts` import specifiers are rewritten to `.js`, and the
 * one cross-package relative import is remapped inside the package.
 * Every emitted JS file is syntax-checked, then the entries are imported with
 * plain node (no --experimental-strip-types) to prove the artifact runs in the
 * environment a real install provides.
 */
import { stripTypeScriptTypes } from 'node:module'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
// the dev workspace keeps sources in packages/; the public repo keeps them in
// source/ and the built packages in packages/ — accept either
const PKGS = existsSync(join(ROOT, 'source')) ? join(ROOT, 'source') : join(ROOT, 'packages')

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const SCOPE = (arg('scope', '') || '').replace(/^@?/, '@')
const VERSION = arg('version', '0.1.0')
const OUT = resolve(ROOT, arg('out', 'dist-npm'))
/** Optional repo URL; emitted as `repository` so npm links the package to it. */
const REPO_URL = arg('repo', '')
if (!arg('scope', '')) {
  console.error('usage: node tools/build-npm-packages.mjs --scope <npm-scope> [--version x.y.z] [--out dir] [--repo <git url>]')
  process.exit(2)
}
const CORE_NAME = `${SCOPE}/dsh-memory`
const PANEL_NAME = `${SCOPE}/dsh-memory-panel`

function repositoryField(directory) {
  if (!REPO_URL) return {}
  return {
    repository: {
      type: 'git',
      url: REPO_URL.startsWith('git+') ? REPO_URL : `git+${REPO_URL}`,
      ...(directory ? { directory } : {}),
    },
  }
}

/** Source groups: source dir -> destination dir inside the core package. */
const CORE_GROUPS = [
  { src: join(PKGS, 'memory-local', 'src'), dest: 'lib/provider' },
  { src: join(PKGS, 'tool-memory', 'src'), dest: 'lib/tools' },
  { src: join(PKGS, 'memory-inject', 'src'), dest: 'lib/inject' },
]

/** Cross-package relative imports must resolve inside the published layout. */
const REWRITES = [
  { from: /from '\.\.\/\.\.\/memory-local\/src\/([^']+)\.js'/g, to: "from '../provider/$1.js'" },
  { from: /import\('\.\.\/\.\.\/memory-local\/src\/([^']+)\.js'\)/g, to: "import('../provider/$1.js')" },
]

const emitted = []

function transpileFile(srcFile, destFile) {
  let code = readFileSync(srcFile, 'utf8')
  code = stripTypeScriptTypes(code, { mode: 'strip', sourceUrl: srcFile })
  // relative specifiers: .ts -> .js (the published artifact ships .js only)
  code = code.replace(/(from\s*')(\.[^']*?)\.ts(')/g, '$1$2.js$3')
  code = code.replace(/(import\(')(\.[^']*?)\.ts('\))/g, '$1$2.js$3')
  for (const r of REWRITES) code = code.replace(r.from, r.to)
  mkdirSync(dirname(destFile), { recursive: true })
  writeFileSync(destFile, code, 'utf8')
  emitted.push(destFile)
}

function copyTree(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true })
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const src = join(srcDir, entry.name)
    if (entry.isDirectory()) {
      copyTree(src, join(destDir, entry.name))
      continue
    }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts') || entry.name.endsWith('.d.ts')) continue
    transpileFile(src, join(destDir, entry.name.replace(/\.ts$/, '.js')))
  }
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

const OWNER = SCOPE.replace(/^@/, '')

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

const CORE_README = `# ${CORE_NAME}

DeepSeek Harness 的本地长期记忆插件（核心包）：JSONL 存储 + 本地向量检索 + 四个模型工具 + 自动召回注入。

## 安装

装进任意 DSH profile（例如桌面端 \`~/.dsh/profiles/desktop\`，Web 端 \`~/.dsh/profiles/web\`）：

\`\`\`bash
pnpm add ${CORE_NAME}
\`\`\`

本包同时提供三个 loader entry，装好后自动生效（bundle patch 已随包分发）：

| entry id | 作用 |
| --- | --- |
| \`dsh-memory-local\` | 提供 \`memory\` 服务：存储、检索、向量回填 |
| \`dsh-tool-memory\` | 注册 \`memory_save\` / \`memory_search\` / \`memory_list\` / \`memory_forget\` 四个工具 |
| \`dsh-memory-inject\` | 在 \`agent/pre-step\` 注入召回块（可选，可关） |

> 管理面板是独立包：**${PANEL_NAME}**（设置页里查看/编辑/删除记忆，并手动启停向量服务）。

## 配置

patch 里给 \`dsh-memory-local\` 传配置即可（默认值通常够用）：

\`\`\`yaml
- id: dsh-memory-local
  config:
    storeDir: '~/.dsh/memory-store'      # 默认 <home>/.dsh/memory-store
    scopes: { global: true, project: true }
    retrieval:
      topK: 5
      vector:
        enabled: true
        endpoint: 'http://127.0.0.1:8078/v1/embeddings'
        model: bge-m3
        dims: 1024
        timeoutMs: 300            # 交互检索预算（要紧）
        writeTimeoutMs: 10000     # 保存时嵌整条记录
        backfillTimeoutMs: 30000  # 批量回填
        backfillMaxChars: 8000
      llm: { enabled: false }     # LLM 重排（可选）
    limits: { maxRecordsPerScope: 2000, maxRecordChars: 4000 }
    secrets: { enabled: true, mode: refuse }   # 拒绝写入疑似凭据
\`\`\`

### 向量检索（可选，默认不启用）

**不配任何东西也能用**：检索自动降级为纯词法匹配（IDF + CJK bigram），保存/搜索/注入全部正常。向量检索是**按配置启用**的——写了 \`endpoint\`、配了 \`spawn\`、或面板里装了本地后端，才会去碰网络；否则一个请求都不发（不会白试、不会刷错误日志）。

三条启用路径，任选一条：

**① 面板一键装（推荐给不想折腾的人）**：设置页「记忆」→「向量服务」卡片 → 点 **下载并配置**。插件会下载 llama.cpp CPU 版运行时 + bge-m3 量化模型（约 440MB）到 \`retrieval.vector.autoInstall.dir\`（默认：显式配了 \`storeDir\` 时用它上一级目录，否则 \`~/.dsh/memory-vector\`），解压后就地托管启动，下次开机自动拉起、退出自动关闭。

**② 云端 / 自建 OpenAI 兼容服务**（不用下模型）：

\`\`\`yaml
        vector:
          enabled: true
          endpoint: 'https://api.example.com/v1/embeddings'
          model: 'bge-m3'        # 服务端要求的模型名
          dims: 1024             # 必须与服务端输出维度一致
\`\`\`

**③ 自己管进程（手填路径）**：

\`\`\`yaml
        vector:
          spawn:                    # 让插件托管 llama-server 进程（opt-in）
            enabled: true
            exe: '/path/to/llama-server.exe'
            model: '/path/to/bge-m3-Q4_K_M.gguf'
            cwd: '/path/to/llamacpp'   # 该目录须含 llama-server-impl.dll
            logFile: '/path/to/llama-server.log'
            threads: 6
\`\`\`

- 路径 ①③ 都由插件托管进程：应用启动后台拉起、应用退出自动关闭；已在跑的实例（有 PID 文件）会被接管，没有 PID 文件的外部实例不接管。路径 ② 只调用、不启停（面板会标成「外部服务」）。
- 若 \`autoInstall.dir\`（或 \`storeDir\` 上一级）里已经存在 \`llamacpp/\` + \`models/\`，插件会**直接采用**，面板只显示状态，不需要重新下载。
- 面板的开关只在"进程确实由本应用托管"时出现；未配置给下载按钮，外部服务只显示连通性，配置里关掉了就只解释原因——不会出现一个永远灰着的开关。

### 维护与卸载

面板底部有一个「维护」区，不可撤销的操作都走**两步确认**（第一次点击只是把按钮换成"确认…"）：

| 动作 | 做什么 | 安全边界 |
| --- | --- | --- |
| **卸载向量服务** | 删掉插件下载的 llama.cpp 运行时 + 模型 + 日志（约 480 MB） | 只删 \`retrieval.vector.autoInstall.dir\`（默认 storeDir 上一级）里的东西；**绝不碰记忆数据目录**；若 \`spawn.exe\` 指向该根目录之外（也就是你自己装的 llama.cpp），直接拒绝并说明原因 |
| **清空记忆数据** | 删除所有作用域的全部记录（走 store，JSONL 与 \`.vec\` 边车保持一致，不会删出半个库） | 两步确认，且接口要求显式 \`confirm: "delete"\`，缺了不执行 |

**卸载插件本身**：在 DSH 的「插件 / 插件市场」里移除本包和 \`@hanpu5838/dsh-memory-panel\`。

> ⚠️ DSH 卸载插件只是在 profile 里 \`pnpm remove\` 并去掉 bundles 条目：它**不会**给插件任何提问机会，也**不会**自动删除向量服务文件或记忆数据。所以"要不要留向量服务""要不要留记忆数据"这两件事要在卸载**之前**到面板「维护」区处理——插件卸载后那个面板也就没了。
>
> 手动清理路径：向量服务在 \`retrieval.vector.autoInstall.dir\`（默认 \`~/.dsh/memory-vector\`；显式配了 \`storeDir\` 时是它的上一级目录），记忆数据在 \`storeDir\`。

## 说明

- 存储为每作用域一个 JSONL + \`.vec\` 向量边车（含模型/维度身份头，不匹配自动重建）。
- 记忆分 \`global\` 与 \`project:<cwd>\` 两类作用域。
- 只在插件自己的生命周期内工作：任何异常都被吞掉并记日志，绝不让 DSH 启动失败。
- License: MIT
`

const PANEL_README = `# ${PANEL_NAME}

DSH 记忆管理面板：设置页里的「记忆」区块，可浏览/搜索/编辑/删除记忆，并手动启停本地向量服务。

## 安装

\`\`\`bash
pnpm add ${PANEL_NAME}
\`\`\`

面板的数据来自核心包 **${CORE_NAME}** 提供的 \`memory\` 服务；未安装核心包时面板仍会出现，但会提示「memory provider 未加载」，不会造成启动失败。

## 使用

设置页 →「记忆」：

- 概览卡片：记忆条数 / 作用域数 / 待嵌入向量数（向量未启用时显示「向量未启用」而不是假的积压数）
- 搜索：按内容、类型、标签过滤；作用域下拉切换
- 每条记忆**默认折叠**（单行预览 + 字数），点标题行展开看全文，展开后可编辑（内容/类型/标签/重要度）或删除
- 向量服务卡片按**配置形态**给不同动作：
  - 未配置 → 「下载并配置」按钮（自动下载 llama.cpp + bge-m3 并托管启动，带进度与取消）
  - 由本应用托管 → 一个启停开关（外部实例不会被误杀）
  - 外部服务（云端/自建）→ 只显示连通性与地址，不给开关
  - 配置里显式关闭 → 说明原因，不给开关
- 「维护」区（两步确认）：卸载向量服务（删运行时+模型，约 480 MB，不碰记忆数据）、清空记忆数据（删全部记录，需二次确认）

## License

MIT
`

const CORE_PATCH = `# ${CORE_NAME} bundle patch: local memory provider + model-facing tools + recall injection.
# 三个 entry 共用本包,但本包不声明 dsh.client —— 声明了客户端 bundle 的包只允许一个活跃
# entry(dsh-client-modules: "resolves from multiple active Loader sources")。
- insert:
    - id: dsh-memory-local
      name: '${CORE_NAME}'
    - id: dsh-tool-memory
      name: '${CORE_NAME}/tools'
    - id: dsh-memory-inject
      name: '${CORE_NAME}/inject'
`

const PANEL_PATCH = `# ${PANEL_NAME} bundle patch: the memory management panel.
# 数据来自 ${CORE_NAME} 提供的 memory 服务;未安装核心包时面板仍在设置页出现,
# 但会显示「memory provider 未加载」而不是让应用起不来。
- insert:
    - id: dsh-memory-panel
      name: '${PANEL_NAME}'
`

function buildCore() {
  const outDir = join(OUT, 'core')
  for (const group of CORE_GROUPS) copyTree(group.src, join(outDir, group.dest))
  writeJson(join(outDir, 'package.json'), {
    name: CORE_NAME,
    version: VERSION,
    description: 'DeepSeek Harness 本地长期记忆：JSONL 存储 + 本地向量检索（BGE-M3）+ 四个模型工具 + 自动召回注入。',
    type: 'module',
    exports: {
      '.': './lib/provider/apply.js',
      './tools': './lib/tools/apply.js',
      './inject': './lib/inject/apply.js',
      './package.json': './package.json',
    },
    files: ['lib/', 'cordis.patch.yml', 'README.md', 'LICENSE'],
    dsh: { bundle: { patch: './cordis.patch.yml' } },
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
    ...repositoryField('packages/dsh-memory'),
    keywords: ['dsh-plugin', 'deepseek-harness', 'memory', 'bge-m3', 'embeddings', 'recall'],
    engines: { node: '>=22.13.0' },
    license: 'MIT',
  })
  writeFileSync(join(outDir, 'cordis.patch.yml'), CORE_PATCH, 'utf8')
  writeFileSync(join(outDir, 'README.md'), CORE_README, 'utf8')
  writeFileSync(join(outDir, 'LICENSE'), MIT_LICENSE, 'utf8')
  return outDir
}

function buildPanel() {
  const src = join(PKGS, 'memory-panel')
  const outDir = join(OUT, 'panel')
  mkdirSync(join(outDir, 'lib'), { recursive: true })
  for (const f of ['index.js', 'client.js']) cpSync(join(src, 'lib', f), join(outDir, 'lib', f))
  cpSync(join(src, 'icon.svg'), join(outDir, 'icon.svg'))
  writeJson(join(outDir, 'package.json'), {
    name: PANEL_NAME,
    version: VERSION,
    description: 'DSH 记忆面板：设置页里浏览/搜索/编辑/删除记忆，并手动启停本地向量服务。',
    icon: './icon.svg',
    type: 'module',
    exports: {
      '.': './lib/index.js',
      './client': './lib/client.js',
      './package.json': './package.json',
    },
    files: ['lib/', 'cordis.patch.yml', 'icon.svg', 'README.md', 'LICENSE'],
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
      client: { inject: ['@deepseek-ai/dsh-client-ui-slots'], platform: 'web' },
    },
    peerDependencies: { [CORE_NAME]: `^${VERSION}` },
    peerDependenciesMeta: { [CORE_NAME]: { optional: true } },
    ...repositoryField('packages/dsh-memory-panel'),
    keywords: ['dsh-plugin', 'deepseek-harness', 'memory', 'panel', 'settings'],
    engines: { node: '>=22.13.0' },
    license: 'MIT',
  })
  writeFileSync(join(outDir, 'cordis.patch.yml'), PANEL_PATCH, 'utf8')
  writeFileSync(join(outDir, 'README.md'), PANEL_README, 'utf8')
  writeFileSync(join(outDir, 'LICENSE'), MIT_LICENSE, 'utf8')

  // The client bundle must register under the PACKAGE NAME: client-modules keys
  // its graph rows by package name, and a bundle that registers anything else
  // makes the host fall back to re-fetching it → second registration →
  // "duplicate factory registration" and the whole web boot fails. Checked here
  // because nothing else can catch it before a user restarts their app.
  const clientSource = readFileSync(join(outDir, 'lib', 'client.js'), 'utf8')
  const declared = clientSource.match(/__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/)
  if (!declared) {
    throw new Error(`${PANEL_NAME}: lib/client.js has no window.__ModuleLoader__.load({ id: '…' }) registration`)
  }
  const declaredId = declared[1].replace(/\/client$/, '')
  if (declaredId !== PANEL_NAME) {
    throw new Error(
      `${PANEL_NAME}: client bundle registers id "${declaredId}" but the package name is "${PANEL_NAME}" — `
      + 'they must be identical or the host will re-fetch the bundle and fail with a duplicate registration',
    )
  }
  console.log(`panel client id check: "${declaredId}" == package name ✓`)
  return outDir
}

/**
 * Prove the artifact runs where TS support is absent: import every entry with a
 * plain node process (no --experimental-strip-types).
 *
 * Host packages are exposed through ONE junction placed *outside* both package
 * dirs (OUT/node_modules), so resolution from lib/… walks up and finds them
 * without polluting the published artifact, and it is removed afterwards.
 */
function verifyLoads() {
  const hostAi = join(ROOT, 'tools', 'asar-extract', 'dsh', 'node_modules', '@deepseek-ai')
  const nm = join(OUT, 'node_modules')
  rmSync(nm, { recursive: true, force: true })
  if (!existsSync(hostAi)) {
    // public checkouts do not carry the extracted host packages; the syntax and
    // patch assertions still ran, so skip the load proof instead of failing
    console.log('skip load proof: host packages not available at tools/asar-extract/...')
    return { ok: true, stdout: '', stderr: '', skipped: true }
  }
  mkdirSync(nm, { recursive: true })
  try {
    symlinkSync(hostAi, join(nm, '@deepseek-ai'), 'junction')
  } catch (error) {
    return { ok: false, stdout: '', stderr: `junction failed: ${error.message}` }
  }
  const targets = [
    join(OUT, 'core', 'lib/provider/apply.js'),
    join(OUT, 'core', 'lib/tools/apply.js'),
    join(OUT, 'core', 'lib/inject/apply.js'),
    join(OUT, 'panel', 'lib/index.js'),
  ]
  const script = `
const targets = ${JSON.stringify(targets.map((t) => t.replace(/\\/g, '/')))}
for (const t of targets) {
  const mod = await import('file:///' + t)
  const kind = typeof mod.apply === 'function' ? 'apply' : Object.keys(mod).join(',')
  console.log('loaded', t.split('/').slice(-2).join('/'), '->', kind, '| name=' + (mod.name ?? '(none)'))
}
`
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
  rmSync(nm, { recursive: true, force: true })
  return { ok: res.status === 0, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

// ---------------------------------------------------------------- run
rmSync(OUT, { recursive: true, force: true })
const coreDir = buildCore()
const panelDir = buildPanel()

let bad = 0
for (const file of emitted) {
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (res.status !== 0) {
    console.error(`SYNTAX FAIL ${relative(ROOT, file)}\n${res.stderr}`)
    bad++
  }
  // a surviving .ts specifier would only fail at install time on the user's machine
  const leftovers = [...readFileSync(file, 'utf8').matchAll(/from\s*'(\.[^']*\.ts)'/g)].map((m) => m[1])
  if (leftovers.length > 0) {
    console.error(`TS SPECIFIER LEFT ${relative(ROOT, file)}: ${leftovers.join(', ')}`)
    bad++
  }
}

// the patch ships to users, so parse it with the same js-yaml DSH uses
try {
  const { createRequire } = await import('node:module')
  const require = createRequire(import.meta.url)
  const yaml = require(join(ROOT, 'tools', 'asar-extract', 'dsh', 'node_modules', 'js-yaml'))
  for (const dir of [coreDir, panelDir]) {
    const patchFile = join(dir, 'cordis.patch.yml')
    const doc = yaml.load(readFileSync(patchFile, 'utf8'))
    const inserts = doc?.filter?.((e) => e.insert) ?? []
    const rows = inserts.flatMap((e) => e.insert)
    console.log(`patch ${relative(ROOT, patchFile)}: ${rows.length} insert(s) -> ${rows.map((r) => `${r.id}=${r.name}`).join(', ')}`)
    if (rows.length === 0) { console.error('PATCH EMPTY'); bad++ }
  }
} catch (error) {
  console.error('PATCH VALIDATION FAIL:', error.message)
  bad++
}

const verify = verifyLoads()
console.log(verify.stdout.trim())
if (!verify.ok) {
  console.error('LOAD FAIL\n' + verify.stderr)
  bad++
}

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
for (const [label, dir] of [['core', coreDir], ['panel', panelDir]]) {
  const { n, bytes } = count(dir)
  console.log(`${label}: ${n} files, ${(bytes / 1024).toFixed(1)} KiB -> ${relative(ROOT, dir)}`)
}
console.log(bad === 0 ? '\nBUILD OK' : `\nBUILD FAILED (${bad} problem(s))`)
process.exit(bad === 0 ? 0 : 1)
