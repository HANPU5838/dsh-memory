/**
 * 实体抽取（analysis/entities）—— 纯函数、确定性、零依赖、不写盘、不调 LLM。
 *
 * 智能关系分析需要把"记忆正文"变成"谁和谁有关系"，第一步是把正文里的高信号实体抽出来：
 *   extractEntities(content, opts)  规则抽取高信号实体（路径 / URL / 端口 / IP /
 *                                   版本 / 日期 / 架构 / 系统 / 工具词表 / tag / 标识符）。
 *
 * 为什么是规则式：记忆正文短（≤4000 字）、中文夹杂英文术语，正则 + 词表的召回
 * 足够；引入 LLM/图数据库会让"检索后端"依赖外部服务，违反本包的零依赖约束。
 * 规则刻意保守（高信号优先、宁可少抽），因为实体的噪声会直接放大到关系分析里。
 *
 * 确定性与安全：
 *   - 输出按 weight↓ / type↑ / normalized↑ 显式排序，输入顺序无关；
 *   - 实体数硬上限 24/条记忆，抽取前把正文截到 maxLength（默认 8000 字）；
 *   - 非法输入（null / 非字符串 / 缺字段记录 / 坏 tag）一律安全降级，不抛异常。
 */
import { URL } from 'node:url'

// ---------------------------------------------------------------- 类型

/** 实体类型（面板配色 / 过滤都按它分组）。 */
                        
          
         
          
        
             
          
          
        
          
         
                

/** 全部实体类型（顺序稳定，供面板渲染图例）。 */
export const ENTITY_TYPES                        = [
  'path',
  'url',
  'port',
  'ip',
  'version',
  'date',
  'arch',
  'os',
  'tool',
  'tag',
  'identifier',
]

/**
 * 一条抽出来的实体。
 *   value      原文里出现的写法（展示用，已去掉尾部标点）
 *   normalized 归一化键（跨记忆聚合用；节点 id = `${type}:${normalized}`）
 *   label      面板上的短标签
 *   weight     信号强度 0..1（类型固有；tag 最高，标识符最低）
 */
                         
                  
               
                    
               
                
 

                                 
                                             
                          
                                   
                      
                                               
                    
 

/** 单条记忆的实体数硬上限。 */
export const MAX_ENTITIES_PER_MEMORY = 24
/** 正文抽取默认截断长度（字符）。 */
export const DEFAULT_MAX_CONTENT_CHARS = 8000
/** 类型固有信号权重：显式标签 > URL/IP > 路径 > 版本/工具 > 端口/日期/架构/系统 > 标识符。 */
const TYPE_WEIGHTS                                       = {
  tag: 1,
  url: 0.95,
  ip: 0.9,
  path: 0.85,
  version: 0.8,
  tool: 0.8,
  port: 0.75,
  date: 0.7,
  arch: 0.7,
  os: 0.7,
  identifier: 0.5,
}

/** 展示值最大长度（value）。 */
const MAX_VALUE_CHARS = 200
/** 标签最大长度（label）。 */
const MAX_LABEL_CHARS = 48
/** 版本号 / 标识符最长可接受长度。 */
const MAX_TOKEN_CHARS = 64

// ---------------------------------------------------------------- 词表（可维护）
//
// 词表是 [写法, 归一化后的 canonical] 的列表，大小写不敏感、按长度降序匹配
// （所以 `llama.cpp` 不会被 `llama` 抢先、`node.js` 不会被 `node` 抢先）。
// 只收**高信号**词：像 go / make / fish / express 这类常见英文单词故意不收，
// 否则中文正文里随便一个英文词都会变成节点。

/** 工具 / 运行时 / 包名 / 命令行词表。 */
export const TOOL_VOCAB                                           = [
  ['npm', 'npm'],
  ['pnpm', 'pnpm'],
  ['yarn', 'yarn'],
  ['bun', 'bun'],
  ['deno', 'deno'],
  ['node.js', 'node'],
  ['nodejs', 'node'],
  ['node', 'node'],
  ['python3', 'python'],
  ['python', 'python'],
  ['pip3', 'pip'],
  ['pip', 'pip'],
  ['git', 'git'],
  ['github', 'github'],
  ['gh', 'github-cli'],
  ['llama-server', 'llama.cpp'],
  ['llama.cpp', 'llama.cpp'],
  ['llama', 'llama.cpp'],
  ['deepseek-harness', 'dsh'],
  ['dsh-memory', 'dsh-memory'],
  ['dsh', 'dsh'],
  ['bge-m3', 'bge-m3'],
  ['typescript', 'typescript'],
  ['javascript', 'javascript'],
  ['rust', 'rust'],
  ['cargo', 'cargo'],
  ['golang', 'go'],
  ['java', 'java'],
  ['kotlin', 'kotlin'],
  ['swift', 'swift'],
  ['docker', 'docker'],
  ['podman', 'podman'],
  ['kubernetes', 'kubernetes'],
  ['k8s', 'kubernetes'],
  ['sqlite', 'sqlite'],
  ['postgresql', 'postgresql'],
  ['postgres', 'postgresql'],
  ['mysql', 'mysql'],
  ['redis', 'redis'],
  ['mongodb', 'mongodb'],
  ['curl', 'curl'],
  ['wget', 'wget'],
  ['bash', 'bash'],
  ['zsh', 'zsh'],
  ['neovim', 'neovim'],
  ['nvim', 'neovim'],
  ['vim', 'vim'],
  ['ripgrep', 'ripgrep'],
  ['ffmpeg', 'ffmpeg'],
  ['jq', 'jq'],
  ['sed', 'sed'],
  ['awk', 'awk'],
  ['gcc', 'gcc'],
  ['clang', 'clang'],
  ['cmake', 'cmake'],
  ['gradle', 'gradle'],
  ['maven', 'maven'],
  ['vite', 'vite'],
  ['webpack', 'webpack'],
  ['esbuild', 'esbuild'],
  ['fastify', 'fastify'],
  ['vitest', 'vitest'],
]

/** 操作系统 / 发行版 / 运行环境词表。Termux 归到 os（运行环境）而不是工具。 */
export const OS_VOCAB                                           = [
  ['android', 'android'],
  ['termux', 'termux'],
  ['linux', 'linux'],
  ['windows', 'windows'],
  ['win32', 'windows'],
  ['win10', 'windows'],
  ['win11', 'windows'],
  ['macos', 'macos'],
  ['macosx', 'macos'],
  ['osx', 'macos'],
  ['darwin', 'macos'],
  ['mac', 'macos'],
  ['ios', 'ios'],
  ['freebsd', 'freebsd'],
  ['openbsd', 'openbsd'],
  ['netbsd', 'netbsd'],
  ['ubuntu', 'ubuntu'],
  ['debian', 'debian'],
  ['fedora', 'fedora'],
  ['alpine', 'alpine'],
  ['centos', 'centos'],
]

/** CPU 架构词表（同义归一：aarch64→arm64、amd64/x64→x86_64）。 */
export const ARCH_VOCAB                                           = [
  ['aarch64', 'arm64'],
  ['arm64', 'arm64'],
  ['x86_64', 'x86_64'],
  ['amd64', 'x86_64'],
  ['x64', 'x86_64'],
  ['armv7l', 'armv7'],
  ['armv7', 'armv7'],
  ['armhf', 'armv7'],
  ['i686', 'x86'],
  ['i386', 'x86'],
  ['x86', 'x86'],
  ['riscv64', 'riscv64'],
  ['ppc64le', 'ppc64le'],
  ['s390x', 's390x'],
  ['mips64', 'mips64'],
]

/** canonical → 展示标签（没列出的 canonical 直接当标签用）。 */
const OS_LABELS                                   = {
  android: 'Android',
  termux: 'Termux',
  linux: 'Linux',
  windows: 'Windows',
  macos: 'macOS',
  ios: 'iOS',
  freebsd: 'FreeBSD',
  openbsd: 'OpenBSD',
  netbsd: 'NetBSD',
  ubuntu: 'Ubuntu',
  debian: 'Debian',
  fedora: 'Fedora',
  alpine: 'Alpine',
  centos: 'CentOS',
}

/** canonical → 展示标签（没列出的 canonical 直接当标签用）。 */
const TOOL_LABELS                                   = {
  node: 'Node.js',
  go: 'Go',
  dsh: 'DSH',
  'bge-m3': 'BGE-M3',
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  kubernetes: 'Kubernetes',
  postgresql: 'PostgreSQL',
  github: 'GitHub',
  'github-cli': 'gh',
  neovim: 'Neovim',
  ripgrep: 'ripgrep',
  vitest: 'Vitest',
}

/** canonical → 展示标签（没列出的 canonical 直接当标签用）。 */
const ARCH_LABELS                                   = {
  x86_64: 'x86_64',
  arm64: 'arm64',
  armv7: 'armv7',
  x86: 'x86',
  riscv64: 'riscv64',
  ppc64le: 'ppc64le',
  s390x: 's390x',
  mips64: 'mips64',
}

/** 全大写缩写里要忽略的常见英文词（避免 THE / AND 之类变成节点）。 */
const UPPER_STOPWORDS                      = new Set([
  'THE', 'AND', 'FOR', 'NOT', 'ALL', 'NEW', 'ARE', 'BUT', 'YOU', 'CAN', 'OUT',
  'THIS', 'THAT', 'WITH', 'FROM', 'HAVE', 'WILL', 'HOW', 'WHY', 'WHAT', 'WHEN',
  'OK', 'ID', 'OS', 'UI', 'MS', 'CS', 'PM', 'AM',
])

// ---------------------------------------------------------------- 小工具

/** 确定性字符串比较（不依赖 locale）。 */
function cmpStr(a        , b        )         {
  return a < b ? -1 : a > b ? 1 : 0
}

function clip(value        , max        )         {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

function escapeRe(text        )         {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 尾部标点：实体值不该把句子标点吞进去。 */
const TRAILING_PUNCT = /[.,;:!?)\]}>"'`，。；：！？、】）》」』…]+$/

function trimTail(raw        )         {
  return raw.replace(TRAILING_PUNCT, '')
}

/** 词表 → 大小写不敏感、按写法长度降序（最长优先）的正则。 */
function buildVocabRegex(entries                                          )         {
  const aliases = entries.map(([alias]) => alias).sort((a, b) => b.length - a.length)
  return new RegExp(`(?<![A-Za-z0-9_])(?:${aliases.map(escapeRe).join('|')})(?![A-Za-z0-9_])`, 'gi')
}

function vocabMap(entries                                          )                              {
  const map = new Map                ()
  for (const [alias, canonical] of entries) map.set(alias.toLowerCase(), canonical)
  return map
}

const TOOL_MAP = vocabMap(TOOL_VOCAB)
const OS_MAP = vocabMap(OS_VOCAB)
const ARCH_MAP = vocabMap(ARCH_VOCAB)
const TOOL_RE = buildVocabRegex(TOOL_VOCAB)
const OS_RE = buildVocabRegex(OS_VOCAB)
const ARCH_RE = buildVocabRegex(ARCH_VOCAB)

                
               
             
 

// ---------------------------------------------------------------- 各类型的正则

// URL 在中文标点处结束：否则「https://x/a，还有」会把后面的中文吞进 path
const URL_RE = /https?:\/\/[^\s<>"'`，。；：！？、（）【】《》「」『』…]+/gi
const IPV4_RE = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g
const POSIX_PATH_RE = /(?<![\w:.\/~-])\/(?:[A-Za-z0-9_.@+-]+\/?)+/g
const HOME_PATH_RE = /(?<![\w:.\/~-])~\/[A-Za-z0-9_.@+/-]*/g
const WINDOWS_PATH_RE = /(?<![\w])[A-Za-z]:[\\/][^\s"'`<>|]*/g
const DATE_RE = /(?<![\d])(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})(?![\d])/g
const CN_DATE_RE = /(20\d{2})年(\d{1,2})月(\d{1,2})日/g
const VERSION_RE = /(?<![\w.])v?\d+\.\d+(?:\.\d+)*(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?![\w.])/gi
const PORT_RANGE_RE = /(?:端口号?|ports?)(?:\s*(?:范围|区间))?\s*(?:[:：=]|为|是)?\s*(\d{1,5})\s*(?:[-~～至到])\s*(\d{1,5})/gi
const PORT_CONTEXT_RE = /(?:端口号?|ports?)\s*(?:[:：=]|为|是)?\s*(\d{1,5})(?!\d)/gi
const PORT_SUFFIX_RE = /(\d{1,5})\s*(?:号?\s*端口|ports?)(?![\d])/gi
// 前置 lookbehind 是性能护栏:不锚定的话长数字串上 host 交替会让引擎 O(n²) 回溯
const PORT_HOSTISH_RE = /(?<![\w.-])(?:localhost|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+):(\d{2,5})(?!\d)/g
const PORT_COLON_RE = /(?<![\w]):(\d{2,5})(?!\d)/g
const IDENT_CAMEL_RE = /(?<![A-Za-z0-9_])[a-z][a-z0-9]*(?:[A-Z][A-Za-z0-9]*)+(?![A-Za-z0-9_])/g
const IDENT_SNAKE_RE = /(?<![A-Za-z0-9_])[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?![A-Za-z0-9_])/g
const IDENT_UPPER_RE = /(?<![A-Za-z0-9_])[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*(?![A-Za-z0-9_])/g

// ---------------------------------------------------------------- 归一化

/** URL：小写 host、去掉默认端口、去掉尾部斜杠与 fragment。 */
function normalizeUrl(raw        )         {
  try {
    const url = new URL(raw)
    url.hash = ''
    if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
      url.port = ''
    }
    let out = url.toString()
    if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1)
    return out
  } catch {
    return raw.toLowerCase()
  }
}

/** URL 的 host（面板标签用）：`https://x.com/a` → `x.com`。 */
function urlHost(raw        )                     {
  try {
    return new URL(raw).hostname
  } catch {
    return undefined
  }
}

/** 路径：折叠重复分隔符、去尾部斜杠；Windows 盘符路径统一小写 + 反斜杠。 */
function normalizePath(raw        )         {
  let path = raw.trim()
  if (/^[A-Za-z]:[\\/]/.test(path)) {
    path = path.replace(/\//g, '\\').replace(/\\{2,}/g, '\\')
    if (!/^[A-Za-z]:\\$/.test(path)) path = path.replace(/\\+$/, '')
    return path.toLowerCase()
  }
  path = path.replace(/\/{2,}/g, '/')
  if (path.length > 1) path = path.replace(/\/+$/, '')
  return path
}

/** 单段路径太短（如 `/a`）不算实体；非根路径至少要 3 个字符。 */
function acceptPosixPath(raw        )          {
  const segments = raw.split('/').filter((segment) => segment !== '')
  if (segments.length === 0) return false
  if (raw.length < 4) return false
  if (segments.length === 1 && segments[0] .length < 3) return false
  return true
}

function normalizeDate(year        , month        , day        )                     {
  const y = Number.parseInt(year, 10)
  const m = Number.parseInt(month, 10)
  const d = Number.parseInt(day, 10)
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return undefined
  if (m < 1 || m > 12 || d < 1 || d > 31) return undefined
  const pad = (value        )         => String(value).padStart(2, '0')
  return `${y}-${pad(m)}-${pad(d)}`
}

function normalizePort(raw        )                     {
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value < 1 || value > 65535) return undefined
  return value
}

function normalizeVersion(raw        )         {
  return raw.toLowerCase().replace(/^v(?=\d)/, '')
}

function normalizeTag(raw        )         {
  return raw.trim().replace(/^#+/, '').replace(/\s+/g, ' ').toLowerCase()
}

function normalizeIdentifier(raw        )         {
  return raw.toLowerCase().replace(/_/g, '')
}

/** 实体 → 节点 id（面板/检索都用这个键）。 */
export function entityNodeId(type            , normalized        )         {
  return `${type}:${normalized}`
}

// ---------------------------------------------------------------- 抽取

/**
 * 从一段正文里抽取高信号实体（纯函数、确定性）。
 *
 * 匹配策略是"高信号类型先占位"：URL/IP/路径等先匹配并把命中区间标记为已消费，
 * 后面的版本/端口/词表/标识符不会再从这段文字里重复抽取（例如 URL 里的 `:8080`
 * 不会被再当成独立端口）。最终按 weight↓ / type↑ / normalized↑ 排序并截断。
 */
export function extractEntities(content        , options                 = {})           {
  const found = new Map                ()
  const spans         = []

  const add = (type            , value        , normalized        , label        , span       )       => {
    const trimmedValue = value.trim()
    if (trimmedValue === '' || normalized === '') return
    if (span !== undefined) {
      for (const seen of spans) {
        if (span.start < seen.end && seen.start < span.end) return
      }
    }
    const key = entityNodeId(type, normalized)
    if (!found.has(key)) {
      found.set(key, {
        type,
        value: clip(trimmedValue, MAX_VALUE_CHARS),
        normalized,
        label: clip(label.trim() === '' ? normalized : label.trim(), MAX_LABEL_CHARS),
        weight: TYPE_WEIGHTS[type],
      })
    }
    if (span !== undefined) spans.push(span)
  }

  const maxLength = Math.max(
    0,
    Math.min(100_000, Math.floor(options.maxLength ?? DEFAULT_MAX_CONTENT_CHARS)),
  )
  const text = typeof content === 'string' ? content.slice(0, maxLength) : ''

  if (text !== '') {
    // 1) URL（最高信号，先占位）
    for (const match of text.matchAll(URL_RE)) {
      const start = match.index ?? 0
      const raw = trimTail(match[0])
      if (raw.length < 8) continue
      add('url', raw, normalizeUrl(raw), urlHost(raw) ?? clip(raw, MAX_LABEL_CHARS), { start, end: start + raw.length })
    }

    // 2) IPv4（八位组校验 + 前导零归一）
    for (const match of text.matchAll(IPV4_RE)) {
      const start = match.index ?? 0
      const raw = match[0]
      const octets = raw.split('.').map((part) => Number.parseInt(part, 10))
      if (octets.length !== 4 || octets.some((octet) => !Number.isFinite(octet) || octet < 0 || octet > 255)) continue
      const normalized = octets.join('.')
      add('ip', raw, normalized, normalized, { start, end: start + raw.length })
    }

    // 3) 路径（POSIX / home / Windows）
    for (const match of text.matchAll(POSIX_PATH_RE)) {
      const start = match.index ?? 0
      const raw = trimTail(match[0]).replace(/\/+$/, '')
      if (!acceptPosixPath(raw)) continue
      add('path', raw, normalizePath(raw), raw, { start, end: start + raw.length })
    }
    for (const match of text.matchAll(HOME_PATH_RE)) {
      const start = match.index ?? 0
      const raw = trimTail(match[0]).replace(/\/+$/, '')
      if (raw.length < 3) continue
      add('path', raw, normalizePath(raw), raw, { start, end: start + raw.length })
    }
    for (const match of text.matchAll(WINDOWS_PATH_RE)) {
      const start = match.index ?? 0
      const raw = trimTail(match[0])
      const body = raw.slice(2)
      if (body.replace(/^[\\/]+/, '').length === 0) continue
      add('path', raw, normalizePath(raw), raw, { start, end: start + raw.length })
    }

    // 4) 日期（先于版本：2026.11.10 更可能是日期）
    for (const match of text.matchAll(DATE_RE)) {
      const normalized = normalizeDate(match[1] , match[2] , match[3] )
      if (normalized === undefined) continue
      const start = match.index ?? 0
      add('date', match[0], normalized, normalized, { start, end: start + match[0].length })
    }
    for (const match of text.matchAll(CN_DATE_RE)) {
      const normalized = normalizeDate(match[1] , match[2] , match[3] )
      if (normalized === undefined) continue
      const start = match.index ?? 0
      add('date', match[0], normalized, normalized, { start, end: start + match[0].length })
    }

    // 5) 版本号（v1.2.3 与 1.2.3 归一成同一个实体）
    for (const match of text.matchAll(VERSION_RE)) {
      const raw = match[0]
      if (raw.length > MAX_TOKEN_CHARS) continue
      const start = match.index ?? 0
      const normalized = normalizeVersion(raw)
      add('version', raw, normalized, normalized, { start, end: start + raw.length })
    }

    // 6) 端口：范围 → 上下文（端口 8080）→ 后缀（8080 端口）→ host:port → 裸 :8080
    for (const match of text.matchAll(PORT_RANGE_RE)) {
      const start = match.index ?? 0
      const end = start + match[0].length
      // 范围两端是两条独立实体：整个范围先占位（防止后面的规则再从里面抠端口），
      // 然后两端分别入图（它们共用同一段区间，不能走 add 的重叠检查）。
      spans.push({ start, end })
      for (const raw of [match[1] , match[2] ]) {
        const value = normalizePort(raw)
        if (value === undefined) continue
        add('port', String(value), String(value), String(value))
      }
    }
    for (const match of text.matchAll(PORT_CONTEXT_RE)) {
      const value = normalizePort(match[1] )
      if (value === undefined) continue
      const start = match.index ?? 0
      add('port', String(value), String(value), String(value), { start, end: start + match[0].length })
    }
    for (const match of text.matchAll(PORT_SUFFIX_RE)) {
      const value = normalizePort(match[1] )
      if (value === undefined) continue
      const start = match.index ?? 0
      add('port', String(value), String(value), String(value), { start, end: start + match[0].length })
    }
    for (const match of text.matchAll(PORT_HOSTISH_RE)) {
      const value = normalizePort(match[1] )
      if (value === undefined) continue
      // 只占 ":" + 数字这一段（host 部分可能已被 IP 规则消费）
      const start = (match.index ?? 0) + match[0].lastIndexOf(':')
      add('port', String(value), String(value), String(value), { start, end: (match.index ?? 0) + match[0].length })
    }
    for (const match of text.matchAll(PORT_COLON_RE)) {
      const value = normalizePort(match[1] )
      if (value === undefined) continue
      const start = (match.index ?? 0) + match[0].indexOf(':')
      add('port', String(value), String(value), String(value), { start, end: start + match[0].length })
    }

    // 7) 架构 / 系统 / 工具（词表；最长优先、边界保护）
    for (const match of text.matchAll(ARCH_RE)) {
      const canonical = ARCH_MAP.get(match[0].toLowerCase())
      if (canonical === undefined) continue
      const start = match.index ?? 0
      add('arch', match[0], canonical, ARCH_LABELS[canonical] ?? canonical, { start, end: start + match[0].length })
    }
    for (const match of text.matchAll(OS_RE)) {
      const canonical = OS_MAP.get(match[0].toLowerCase())
      if (canonical === undefined) continue
      const start = match.index ?? 0
      add('os', match[0], canonical, OS_LABELS[canonical] ?? canonical, { start, end: start + match[0].length })
    }
    for (const match of text.matchAll(TOOL_RE)) {
      const canonical = TOOL_MAP.get(match[0].toLowerCase())
      if (canonical === undefined) continue
      const start = match.index ?? 0
      add('tool', match[0], canonical, TOOL_LABELS[canonical] ?? canonical, { start, end: start + match[0].length })
    }

    // 8) 标识符（camelCase / snake_case / 大写缩写），最后兜底
    for (const match of text.matchAll(IDENT_CAMEL_RE)) {
      const raw = match[0]
      if (raw.length < 4 || raw.length > MAX_TOKEN_CHARS) continue
      const start = match.index ?? 0
      add('identifier', raw, normalizeIdentifier(raw), raw, { start, end: start + raw.length })
    }
    for (const match of text.matchAll(IDENT_SNAKE_RE)) {
      const raw = match[0]
      if (raw.length < 4 || raw.length > MAX_TOKEN_CHARS) continue
      const start = match.index ?? 0
      add('identifier', raw, normalizeIdentifier(raw), raw, { start, end: start + raw.length })
    }
    for (const match of text.matchAll(IDENT_UPPER_RE)) {
      const raw = match[0]
      if (raw.length > MAX_TOKEN_CHARS) continue
      const hasUnderscore = raw.includes('_')
      if (!hasUnderscore && raw.length < 3) continue
      if (UPPER_STOPWORDS.has(raw)) continue
      const start = match.index ?? 0
      add('identifier', raw, normalizeIdentifier(raw), raw, { start, end: start + raw.length })
    }
  }

  // 9) 记录 tags：用户显式标注 → 最高权重实体（不受正文截断影响）
  if (Array.isArray(options.tags)) {
    for (const tag of options.tags) {
      if (typeof tag !== 'string') continue
      const value = tag.trim()
      if (value === '') continue
      add('tag', value, normalizeTag(value), value)
    }
  }

  const maxEntities = Math.max(1, Math.min(100, Math.floor(options.maxEntities ?? MAX_ENTITIES_PER_MEMORY)))
  return [...found.values()]
    .sort((a, b) => b.weight - a.weight || cmpStr(a.type, b.type) || cmpStr(a.normalized, b.normalized))
    .slice(0, maxEntities)
}


//# sourceURL=source/memory-local/src/analysis/entities.ts