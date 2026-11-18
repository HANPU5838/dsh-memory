/**
 * 把 vendored 的 three.js ESM 源码转换成「自注册 classic script chunk」。
 *
 * 为什么需要这一步(而不是直接 npm i three):
 *
 * 面板的 client bundle 由宿主的 dsh-client-modules 以 **经典 `<script>`** 形式加载
 * (combo 脚本,见 buildComboScript),不是 ES module —— `import` / `export` 语句会直接
 * 语法错误。宿主唯一支持的代码分割原语是 `require.async('./client.<name>.js')`:
 * 服务端按 `<包>/client.<name>.js` 就近取文件,浏览器端再以 `<script>` 塞进 head。
 * 所以 three.js 必须以「不依赖任何模块语法的独立脚本」形态随包发布。
 *
 * three r187 的 `build/` 只有两个 ESM 文件:
 *   - three.core.js   —— 单条 `export {...}`(448 个名字),无 import、无动态 import、
 *                        无 import.meta、无顶层 await;
 *   - three.module.js —— 头部 `import {...197 个名字...} from './three.core.js'`,
 *                        接着 `export {...248 个名字...} from './three.core.js'`(纯转发),
 *                        结尾 `export {...195 个名字...}`(模块内声明 + 转发已 import 的绑定)。
 *
 * 关键陷阱:两个文件里**有 7 个模块级声明同名**(_m1$1 / _v0 / _id / _projScreenMatrix /
 * _lightPositionWorld / _lookTarget / _m1)。如果简单地拼接进同一个作用域,`const` 重复
 * 声明会直接抛错。因此这里把两者各自包进**独立 IIFE**:core 返回自己的导出命名空间,
 * module 的作用域里用解构把 197 个 import 名字从那个命名空间取出来 —— 语义与 ESM 的
 * 模块作用域一一对应。
 *
 * 另外 ESM 天然是严格模式,而 classic script 默认是宽松模式(顶层 `this` 指向 window、
 * 隐式全局赋值等语义不同),所以两个 IIFE 都显式加 `'use strict'`,保持原语义。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const VENDOR = join(ROOT, 'source', 'memory-panel', 'vendor')

/** three 的发行版版本号,仅用于生成的注释头。 */
export const THREE_VERSION = '0.187.0'

/** 拆分一行 `a, b, c` 形式的模块名列表。 */
function splitNames(list) {
  return list.split(',').map((name) => name.trim()).filter(Boolean)
}

/**
 * 从源码里切出一条 `import {…} from '…'` / `export {…} from '…'` / `export {…}` 语句。
 * 三个文件都是「语句整行」,但这里不假设单行,按大括号配对扫描,免得上游格式化后失效。
 */
function takeStatement(source, startPattern) {
  const match = startPattern.exec(source)
  if (match === null) throw new Error(`vendor-three: 找不到语句 ${startPattern}`)
  const start = match.index
  const open = source.indexOf('{', start)
  const close = source.indexOf('}', open)
  if (open < 0 || close < 0) throw new Error(`vendor-three: 语句 ${startPattern} 的大括号不配对`)
  const names = splitNames(source.slice(open + 1, close))
  let end = close + 1
  // 吃掉尾随的 ` from '…'` / `;` 以及其后换行
  const rest = /^\s*(?:from\s*'(?:[^'\\]|\\.)*'\s*)?;?[ \t]*\r?\n?/.exec(source.slice(end))
  if (rest !== null) end += rest[0].length
  const removed = source.slice(start, end)
  return { names, removed, start, end }
}

/** 断言名字列表里没有 `a as b` 形式(有的话需要额外的本地别名处理)。 */
function assertPlainNames(names, label) {
  const aliased = names.filter((name) => /\s+as\s+/.test(name))
  if (aliased.length > 0) throw new Error(`vendor-three: ${label} 里出现别名(需扩展转换器):${aliased.slice(0, 5).join(', ')}`)
  const bad = names.filter((name) => !/^[A-Za-z_$][\w$]*$/.test(name))
  if (bad.length > 0) throw new Error(`vendor-three: ${label} 里出现非法标识符:${bad.slice(0, 5).join(', ')}`)
  if (new Set(names).size !== names.length) throw new Error(`vendor-three: ${label} 里有重复名字`)
}

/** 从 vendored 源码生成 chunk 正文(不含注册外壳)。 */
export function buildThreeNamespace() {
  const core = readFileSync(join(VENDOR, 'three.core.js'), 'utf8')
  const mod = readFileSync(join(VENDOR, 'three.module.js'), 'utf8')

  // ---- three.core.js:一条 export,摘掉后整段就是模块体
  const coreExport = takeStatement(core, /^export\s*\{/m)
  assertPlainNames(coreExport.names, 'three.core.js export')
  const coreBody = (core.slice(0, coreExport.start) + core.slice(coreExport.end)).trimEnd()
  if (/^\s*(?:import|export)\b/m.test(coreBody)) throw new Error('vendor-three: three.core.js 里还有模块语法')

  // ---- three.module.js:import / 纯转发 export / 本地 export 三条
  const modImport = takeStatement(mod, /^import\s*\{/m)
  assertPlainNames(modImport.names, 'three.module.js import')
  if (!/from\s*'\.\/three\.core\.js'/.test(modImport.removed)) throw new Error('vendor-three: three.module.js 的 import 不是从 three.core.js')

  let rest = mod.slice(modImport.end)
  const modReExport = takeStatement(rest, /^export\s*\{/m)
  assertPlainNames(modReExport.names, 'three.module.js re-export')
  if (!/from\s*'\.\/three\.core\.js'/.test(modReExport.removed)) throw new Error('vendor-three: 第二条 export 不是转发')

  rest = rest.slice(0, modReExport.start) + rest.slice(modReExport.end)
  const modLocalExport = takeStatement(rest, /^export\s*\{/m)
  assertPlainNames(modLocalExport.names, 'three.module.js local export')
  if (/from\s*'/.test(modLocalExport.removed)) throw new Error('vendor-three: 最后一条 export 不应带 from')

  const modBody = (rest.slice(0, modLocalExport.start) + rest.slice(modLocalExport.end)).trimEnd()
  if (/^\s*(?:import|export)\b/m.test(modBody)) throw new Error('vendor-three: three.module.js 里还有模块语法')

  // ---- 一致性校验:import 的名字必须都在 core 的导出里;两条 export 不能重名
  const coreSet = new Set(coreExport.names)
  const importedSet = new Set(modImport.names)
  const missing = modImport.names.filter((name) => !coreSet.has(name))
  if (missing.length > 0) throw new Error(`vendor-three: three.module.js import 了 core 没导出的名字:${missing.slice(0, 5).join(', ')}`)

  const reSet = new Set(modReExport.names)
  const localSet = new Set(modLocalExport.names)
  const dup = [...localSet].filter((name) => reSet.has(name))
  if (dup.length > 0) throw new Error(`vendor-three: 导出名重复(会 SyntaxError):${dup.slice(0, 5).join(', ')}`)

  // 本地导出的名字必须来自 import 或模块内声明
  const undeclared = modLocalExport.names.filter((name) => {
    if (importedSet.has(name)) return false
    return !new RegExp(`(?:^|\\n)(?:class|function|const|let|var)\\s+${name.replace(/\$/g, '\\$')}\\b`).test(modBody)
  })
  if (undeclared.length > 0) throw new Error(`vendor-three: 本地导出了既没 import 也没声明的名字:${undeclared.slice(0, 5).join(', ')}`)

  // ---- 生成命名空间:对外暴露的就是 three 入口的那份(转发 248 + 本地 195)
  const reFromCore = [...reSet].filter((name) => !localSet.has(name))
  const localEntries = modLocalExport.names

  const indent = (text, pad) => text.split('\n').map((line) => (line.length > 0 ? pad + line : line)).join('\n')

  return `// ---- three.core.js(${coreExport.names.length} 个导出)----
const __threeCore = (function () {
'use strict';
${coreBody}

return {
${coreExport.names.map((name) => `  ${name}: ${name},`).join('\n')}
};
})();

// ---- three.module.js(import ${modImport.names.length} / 转发 ${modReExport.names.length} / 本地 ${modLocalExport.names.length})----
const __threeModule = (function () {
'use strict';
// ESM 的 import 绑定在 classic script 里等价于一次解构:同名、只读、来自同一个命名空间。
const {
${indent(modImport.names.join(',\n'), '  ')}
} = __threeCore;
${modBody}

return {
${reFromCore.map((name) => `  ${name}: __threeCore.${name},`).join('\n')}
${localEntries.map((name) => `  ${name}: ${name},`).join('\n')}
};
})();

return Object.assign({}, __threeModule);
`
}

/**
 * 生成可直接以 `<script>` 加载的 chunk 源码。
 * @param {string} packageName 宿主 graph 行里的包名,决定 chunk id 的前缀。
 */
export function buildThreeChunk(packageName) {
  const namespace = buildThreeNamespace()
  return `/**
 * @license
 * three.js r187 — MIT, Copyright 2010-2026 Three.js Authors
 * https://github.com/mrdoob/three.js
 *
 * 自动生成,请勿手改。来源:source/memory-panel/vendor/three.{core,module}.js,
 * 由 tools/vendor-three.mjs 转成 classic script chunk(原因见该文件的注释)。
 * 只在用户第一次进入 3D 星图时由 client.js 用 require.async('./client.three.js') 加载。
 */
window.__ModuleLoader__.load({
  id: ${JSON.stringify(packageName)},
  chunk: 'client.three.js',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const THREE = (function () {
${namespace.replace(/^/gm, '      ').replace(/^ +$/gm, '')}
    })()
    for (const key of Object.keys(THREE)) exports[key] = THREE[key]
    exports.default = THREE
    return module.exports
  },
})
`
}

// ------------------------------------------------------------------ CLI
// 用法:node tools/vendor-three.mjs [输出路径]
if (process.argv[1] !== undefined && process.argv[1].endsWith('vendor-three.mjs')) {
  const out = process.argv[2]
  if (out === undefined) {
    console.error('用法:node tools/vendor-three.mjs <输出文件>')
    process.exit(1)
  }
  const { writeFileSync, mkdirSync } = await import('node:fs')
  const { dirname: dir } = await import('node:path')
  mkdirSync(dir(out), { recursive: true })
  writeFileSync(out, buildThreeChunk('@restregular/dsh-memory'), 'utf8')
  console.log(`vendor-three: 已写入 ${out}`)
}
