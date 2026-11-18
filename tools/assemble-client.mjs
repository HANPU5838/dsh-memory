/**
 * 把 `source/memory-panel/lib/` 下的**图渲染分片**装配成宿主需要的**一个**经典脚本
 * `client.js`。
 *
 * 为什么要有这一步(而不是直接拆成多个文件发布):
 *
 * 宿主 dsh-client-modules 为每个包只认**一个** client 入口 —— 由 `package.json` 的
 * `exports["./client"]` 解析出的那个文件,整个包里其它 `.js` 只有名字匹配
 * `client.<name>.js` 才会被按需 chunk 路由提供,而 chunk **只能异步加载**
 * (`require.async`)。面板的业务代码(布局、React 组件、状态)必须在首屏同步可用,
 * 塞不进 chunk。
 *
 * 所以:源码按职责拆开写,发布产物仍然是单文件。分片是**纯文本片段**(不带
 * `import` / `export`,也不是独立可执行文件),由本工具按固定顺序内联进 `client.js`
 * 里 `// @@INLINE <name> @@` 标记所在的位置 —— 内联点都在 ModuleLoader 的 factory
 * 作用域内,分片之间以及与 client.js 的其余部分共享同一套词法作用域。
 *
 * 同一份装配结果被三方共用,保证「测的就是发的」:
 *   ① `tools/build-single-package.mjs` 写 `packages/dsh-memory/lib/client.js`;
 *   ② 面板的渲染测试在内存里装配后求值(见 test/client-render.test.ts);
 *   ③ 任何人手动跑 `node tools/assemble-client.mjs` 都能看到最终产物。
 *
 * 三个硬约束(踩过):
 *   - 分片**不能**有顶层 `const`/`let` 与 client.js 重名 —— 内联后同一个作用域;
 *   - 分片**不能**出现 `import` / `export`,产物是 classic script;
 *   - 标记与分片必须一一对应,少一个直接抛错(否则会静默发出缺功能的包)。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

/** 面板源码目录(唯一真源)。 */
export const PANEL_LIB = join(ROOT, 'source', 'memory-panel', 'lib')

/**
 * 装配顺序:布局(纯函数,含 GRAPH_METRICS / GRAPH_VIEW 配置)→ 2D 视图数学
 * (依赖 GRAPH_VIEW)→ 持久化(只碰 localStorage)→ 3D 渲染(依赖以上全部)。
 * 后面依赖前面的声明,顺序不可调换。
 */
export const CLIENT_FRAGMENTS = [
  'graph-layout.js',
  'graph-2d.js',
  'graph-layout-storage.js',
  'graph-3d.js',
]

const MARKER = /^([ \t]*)\/\/ @@INLINE ([\w.-]+) @@[ \t]*$/gm

/** 把一段文本按给定缩进前缀整体右移,空行保持为空行。 */
function indent(text, prefix) {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line.length === 0 ? line : prefix + line))
    .join('\n')
}

/**
 * 读 `client.js` 并把所有 `// @@INLINE <file> @@` 标记替换成对应分片的正文。
 *
 * @param {string} [libDir] 面板 lib 目录,默认 `source/memory-panel/lib`。
 * @returns {{ source: string, used: string[] }} 装配后的完整脚本,以及实际内联的分片。
 */
export function assembleClientSource(libDir = PANEL_LIB) {
  const entry = readFileSync(join(libDir, 'client.js'), 'utf8')
  const used = []
  const source = entry.replace(MARKER, (match, indentText, fileName) => {
    if (!CLIENT_FRAGMENTS.includes(fileName)) {
      throw new Error(`client.js 引用了未登记的装配分片 "${fileName}"(见 tools/assemble-client.mjs 的 CLIENT_FRAGMENTS)`)
    }
    if (used.includes(fileName)) {
      throw new Error(`装配分片 "${fileName}" 在 client.js 里被标记了不止一次`)
    }
    used.push(fileName)
    const body = readFileSync(join(libDir, fileName), 'utf8').replace(/\r\n/g, '\n').replace(/\s+$/, '')
    if (/^\s*(?:import|export)\s/m.test(body)) {
      throw new Error(`装配分片 "${fileName}" 含有 import/export,产物必须是 classic script`)
    }
    // 标记行的缩进就是分片正文的缩进,让装配产物读起来仍然像人手写的。
    return indent(body, indentText)
  })
  const missing = CLIENT_FRAGMENTS.filter((name) => !used.includes(name))
  if (missing.length > 0) {
    throw new Error(`client.js 缺少装配标记:${missing.map((name) => `// @@INLINE ${name} @@`).join('、')}`)
  }
  return { source, used }
}

/** 装配并写出到指定文件(构建用)。 */
export function writeClientBundle(outFile, libDir = PANEL_LIB) {
  const { source } = assembleClientSource(libDir)
  writeFileSync(outFile, source, 'utf8')
  return outFile
}

// 直接执行时把产物写到 stdout,方便人工核对(不写仓库里的任何文件)。
if (process.argv[1] && join(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { source, used } = assembleClientSource()
  process.stderr.write(`assembled ${relative(ROOT, join(PANEL_LIB, 'client.js'))} + ${used.join(', ')} → ${source.length} chars\n`)
  process.stdout.write(source)
}
