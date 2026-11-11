/**
 * 知识图谱后端（cognitive/graph）—— 纯函数、确定性、零依赖、不写盘、不调 LLM。
 *
 * 目标：把"记忆正文"变成可以回答"谁和谁有关系"的图，给检索/面板/维护任务用。
 * 两条主线：
 *   extractEntities(content, opts)  规则抽取高信号实体（路径 / URL / 端口 / IP /
 *                                   版本 / 日期 / 架构 / 系统 / 工具词表 / tag / 标识符）；
 *   buildEntityGraph(records, opts) 实体当节点（跨记忆 count + scope/kind 分布），
 *                                   同一条记忆里共现 ⇔ 一条边（weight = 共现次数）。
 *
 * 为什么是规则式：记忆正文短（≤4000 字）、中文夹杂英文术语，正则 + 词表的召回
 * 足够；引入 LLM/图数据库会让"检索后端"依赖外部服务，违反本包的零依赖约束。
 * 规则刻意保守（高信号优先、宁可少抽），因为图谱的噪声会直接放大到面板画图上。
 *
 * 确定性与安全：
 *   - 所有输出都显式排序（节点 count↓ / id↑，边 weight↓ / a↑ / b↑），输入顺序无关；
 *   - 实体数硬上限 24/条记忆，抽取前把正文截到 maxLength（默认 8000 字）；
 *   - 非法输入（null / 非字符串 / 缺字段记录 / 坏 tag）一律安全降级，不抛异常。
 *
 * 过滤口径：与 store 保持一致 —— 软删（tombstonedAt）默认不进图，过期的
 * （expiredAt < now）默认不进图，休眠（dormantAt）仍然进图（休眠只是降权，不是删除）。
 */
import { URL } from 'node:url'

// ---------------------------------------------------------------- 类型

/** 实体类型（面板配色 / 过滤都按它分组）。 */
export type EntityType =
  | 'path'
  | 'url'
  | 'port'
  | 'ip'
  | 'version'
  | 'date'
  | 'arch'
  | 'os'
  | 'tool'
  | 'tag'
  | 'identifier'

/** 全部实体类型（顺序稳定，供面板渲染图例）。 */
export const ENTITY_TYPES: readonly EntityType[] = [
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
export interface Entity {
  type: EntityType
  value: string
  normalized: string
  label: string
  weight: number
}

export interface ExtractOptions {
  /** 记录自带的 tags —— 用户显式标注，作为 tag 实体并排在最前。 */
  tags?: readonly string[]
  /** 单条记忆最多返回几个实体，默认 24，上限 100。 */
  maxEntities?: number
  /** 正文截断长度，默认 8000 字（防超长正文拖死正则），上限 100000。 */
  maxLength?: number
}

/** 单条记忆的实体数硬上限。 */
export const MAX_ENTITIES_PER_MEMORY = 24
/** 正文抽取默认截断长度（字符）。 */
export const DEFAULT_MAX_CONTENT_CHARS = 8000
/** 图节点数默认上限。 */
export const DEFAULT_MAX_NODES = 200
/** 图边数默认上限。 */
export const DEFAULT_MAX_EDGES = 500

/** 类型固有信号权重：显式标签 > URL/IP > 路径 > 版本/工具 > 端口/日期/架构/系统 > 标识符。 */
const TYPE_WEIGHTS: Readonly<Record<EntityType, number>> = {
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
export const TOOL_VOCAB: ReadonlyArray<readonly [string, string]> = [
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
export const OS_VOCAB: ReadonlyArray<readonly [string, string]> = [
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
export const ARCH_VOCAB: ReadonlyArray<readonly [string, string]> = [
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
const OS_LABELS: Readonly<Record<string, string>> = {
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
const TOOL_LABELS: Readonly<Record<string, string>> = {
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
const ARCH_LABELS: Readonly<Record<string, string>> = {
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
const UPPER_STOPWORDS: ReadonlySet<string> = new Set([
  'THE', 'AND', 'FOR', 'NOT', 'ALL', 'NEW', 'ARE', 'BUT', 'YOU', 'CAN', 'OUT',
  'THIS', 'THAT', 'WITH', 'FROM', 'HAVE', 'WILL', 'HOW', 'WHY', 'WHAT', 'WHEN',
  'OK', 'ID', 'OS', 'UI', 'MS', 'CS', 'PM', 'AM',
])

// ---------------------------------------------------------------- 小工具

/** 确定性字符串比较（不依赖 locale）。 */
function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 尾部标点：实体值不该把句子标点吞进去。 */
const TRAILING_PUNCT = /[.,;:!?)\]}>"'`，。；：！？、】）》」』…]+$/

function trimTail(raw: string): string {
  return raw.replace(TRAILING_PUNCT, '')
}

/** 词表 → 大小写不敏感、按写法长度降序（最长优先）的正则。 */
function buildVocabRegex(entries: ReadonlyArray<readonly [string, string]>): RegExp {
  const aliases = entries.map(([alias]) => alias).sort((a, b) => b.length - a.length)
  return new RegExp(`(?<![A-Za-z0-9_])(?:${aliases.map(escapeRe).join('|')})(?![A-Za-z0-9_])`, 'gi')
}

function vocabMap(entries: ReadonlyArray<readonly [string, string]>): ReadonlyMap<string, string> {
  const map = new Map<string, string>()
  for (const [alias, canonical] of entries) map.set(alias.toLowerCase(), canonical)
  return map
}

const TOOL_MAP = vocabMap(TOOL_VOCAB)
const OS_MAP = vocabMap(OS_VOCAB)
const ARCH_MAP = vocabMap(ARCH_VOCAB)
const TOOL_RE = buildVocabRegex(TOOL_VOCAB)
const OS_RE = buildVocabRegex(OS_VOCAB)
const ARCH_RE = buildVocabRegex(ARCH_VOCAB)

interface Span {
  start: number
  end: number
}

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
function normalizeUrl(raw: string): string {
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
function urlHost(raw: string): string | undefined {
  try {
    return new URL(raw).hostname
  } catch {
    return undefined
  }
}

/** 路径：折叠重复分隔符、去尾部斜杠；Windows 盘符路径统一小写 + 反斜杠。 */
function normalizePath(raw: string): string {
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
function acceptPosixPath(raw: string): boolean {
  const segments = raw.split('/').filter((segment) => segment !== '')
  if (segments.length === 0) return false
  if (raw.length < 4) return false
  if (segments.length === 1 && segments[0]!.length < 3) return false
  return true
}

function normalizeDate(year: string, month: string, day: string): string | undefined {
  const y = Number.parseInt(year, 10)
  const m = Number.parseInt(month, 10)
  const d = Number.parseInt(day, 10)
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return undefined
  if (m < 1 || m > 12 || d < 1 || d > 31) return undefined
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${y}-${pad(m)}-${pad(d)}`
}

function normalizePort(raw: string): number | undefined {
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value < 1 || value > 65535) return undefined
  return value
}

function normalizeVersion(raw: string): string {
  return raw.toLowerCase().replace(/^v(?=\d)/, '')
}

function normalizeTag(raw: string): string {
  return raw.trim().replace(/^#+/, '').replace(/\s+/g, ' ').toLowerCase()
}

function normalizeIdentifier(raw: string): string {
  return raw.toLowerCase().replace(/_/g, '')
}

/** 实体 → 节点 id（面板/检索都用这个键）。 */
export function entityNodeId(type: EntityType, normalized: string): string {
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
export function extractEntities(content: string, options: ExtractOptions = {}): Entity[] {
  const found = new Map<string, Entity>()
  const spans: Span[] = []

  const add = (type: EntityType, value: string, normalized: string, label: string, span?: Span): void => {
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
      const normalized = normalizeDate(match[1]!, match[2]!, match[3]!)
      if (normalized === undefined) continue
      const start = match.index ?? 0
      add('date', match[0], normalized, normalized, { start, end: start + match[0].length })
    }
    for (const match of text.matchAll(CN_DATE_RE)) {
      const normalized = normalizeDate(match[1]!, match[2]!, match[3]!)
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
      for (const raw of [match[1]!, match[2]!]) {
        const value = normalizePort(raw)
        if (value === undefined) continue
        add('port', String(value), String(value), String(value))
      }
    }
    for (const match of text.matchAll(PORT_CONTEXT_RE)) {
      const value = normalizePort(match[1]!)
      if (value === undefined) continue
      const start = match.index ?? 0
      add('port', String(value), String(value), String(value), { start, end: start + match[0].length })
    }
    for (const match of text.matchAll(PORT_SUFFIX_RE)) {
      const value = normalizePort(match[1]!)
      if (value === undefined) continue
      const start = match.index ?? 0
      add('port', String(value), String(value), String(value), { start, end: start + match[0].length })
    }
    for (const match of text.matchAll(PORT_HOSTISH_RE)) {
      const value = normalizePort(match[1]!)
      if (value === undefined) continue
      // 只占 ":" + 数字这一段（host 部分可能已被 IP 规则消费）
      const start = (match.index ?? 0) + match[0].lastIndexOf(':')
      add('port', String(value), String(value), String(value), { start, end: (match.index ?? 0) + match[0].length })
    }
    for (const match of text.matchAll(PORT_COLON_RE)) {
      const value = normalizePort(match[1]!)
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

// ---------------------------------------------------------------- 共现图

/**
 * buildEntityGraph 的输入记录：与 `MemoryRecord` 结构兼容（这里只依赖下面列出的字段，
 * 方便测试直接喂字面量，也方便 provider 传 store 里的记录）。
 */
export interface GraphMemory {
  id: string
  scope?: string
  kind?: string
  content?: string
  tags?: readonly string[]
  expiredAt?: number
  tombstonedAt?: number
  [key: string]: unknown
}

export interface EntityGraphOptions {
  /** 只统计这些作用域（字符串或数组）；缺省 = 全部。 */
  scopes?: readonly string[] | string
  /** 只统计这些记忆类型（字符串或数组）；缺省 = 全部。 */
  kinds?: readonly string[] | string
  /** 实体至少出现在几条记忆里才保留，默认 1。 */
  minCount?: number
  /** 节点数上限，默认 200。 */
  maxNodes?: number
  /** 边数上限，默认 500。 */
  maxEdges?: number
  /** 判定"过期"的时间点，默认 Date.now()。 */
  now?: number
  /** 是否包含 TTL 已过期的记录，默认 false。 */
  includeExpired?: boolean
  /** 是否包含软删（tombstone）记录，默认 false。 */
  includeTombstoned?: boolean
  /** 单条记忆最多抽几个实体，默认 24。 */
  maxEntitiesPerMemory?: number
}

export interface EntityNode {
  /** 节点 id = `${type}:${normalized}`。 */
  id: string
  type: EntityType
  /** 第一次出现的原文写法（展示用）。 */
  value: string
  /** 面板短标签。 */
  label: string
  /** 出现在多少条记忆里。 */
  count: number
  /** 出现过的作用域（升序）。 */
  scopes: string[]
  /** 记忆类型分布：{ note: 2, rule: 1 }（键升序）。 */
  kinds: Record<string, number>
  /** 类型固有信号权重。 */
  weight: number
}

export interface EntityEdge {
  /** 两端节点 id（字典序 a < b，保证同一条边只有一种写法）。 */
  a: string
  b: string
  /** 共现次数（同一条记忆里共同出现一次 +1）。 */
  weight: number
}

export interface EntityGraphStats {
  entities: number
  edges: number
  /** 参与建图的记忆数（通过过滤且至少抽出 1 个实体）。 */
  memories: number
}

export interface EntityGraph {
  nodes: EntityNode[]
  edges: EntityEdge[]
  stats: EntityGraphStats
  /** 节点 id → 包含该实体的记忆 id（升序，只含最终节点）。 */
  memoryIndex: Map<string, string[]>
}

interface MutableNode {
  id: string
  type: EntityType
  value: string
  label: string
  count: number
  scopes: Set<string>
  kinds: Map<string, number>
  weight: number
}

function toFilter(value: readonly string[] | string | undefined): Set<string> | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return new Set([value])
  const set = new Set<string>()
  for (const item of value) if (typeof item === 'string') set.add(item)
  return set
}

function compareNode(a: MutableNode, b: MutableNode): number {
  return b.count - a.count || cmpStr(a.id, b.id)
}

function compareEdge(a: EntityEdge, b: EntityEdge): number {
  return b.weight - a.weight || cmpStr(a.a, b.a) || cmpStr(a.b, b.b)
}

/**
 * 从一组记忆构建实体共现图（纯函数、确定性）。
 *
 * 过滤：scopes / kinds / minCount / 过期 / 软删。截断：节点按 `count↓ → id↑`
 * 取前 maxNodes，边按 `weight↓ → a↑ → b↑` 取前 maxEdges，且边只连最终留下的节点
 * —— 输入顺序不影响输出，面板刷新不会闪来闪去。
 *
 * 复杂度：每条记忆最多抽 24 个实体 → 最多 276 对，与记忆数线性；不会 O(n²) 全表
 * 两两比较，也不会把整库塞进内存（只保留节点/边/索引）。
 */
export function buildEntityGraph(records: readonly GraphMemory[], options: EntityGraphOptions = {}): EntityGraph {
  const now = typeof options.now === 'number' && Number.isFinite(options.now) ? options.now : Date.now()
  const scopeFilter = toFilter(options.scopes)
  const kindFilter = toFilter(options.kinds)
  const minCount = Math.max(1, Math.floor(options.minCount ?? 1))
  const maxNodes = Math.max(0, Math.floor(options.maxNodes ?? DEFAULT_MAX_NODES))
  const maxEdges = Math.max(0, Math.floor(options.maxEdges ?? DEFAULT_MAX_EDGES))
  const maxEntitiesPerMemory = Math.max(
    1,
    Math.min(100, Math.floor(options.maxEntitiesPerMemory ?? MAX_ENTITIES_PER_MEMORY)),
  )

  const nodeById = new Map<string, MutableNode>()
  const memoryEntities: Array<{ memoryId: string; ids: string[] }> = []
  const seenMemoryIds = new Set<string>()
  let memories = 0

  for (const record of records ?? []) {
    if (record === null || typeof record !== 'object') continue
    const memoryId = typeof record.id === 'string' ? record.id.trim() : ''
    if (memoryId === '') continue
    if (seenMemoryIds.has(memoryId)) continue
    seenMemoryIds.add(memoryId)

    const scope = typeof record.scope === 'string' ? record.scope : ''
    const kind = typeof record.kind === 'string' ? record.kind : ''
    if (scopeFilter !== undefined && !scopeFilter.has(scope)) continue
    if (kindFilter !== undefined && !kindFilter.has(kind)) continue
    if (options.includeExpired !== true && typeof record.expiredAt === 'number' && record.expiredAt < now) continue
    if (options.includeTombstoned !== true && record.tombstonedAt !== undefined) continue

    const entities = extractEntities(typeof record.content === 'string' ? record.content : '', {
      tags: Array.isArray(record.tags) ? record.tags : undefined,
      maxEntities: maxEntitiesPerMemory,
    })
    if (entities.length === 0) continue
    memories++

    const ids: string[] = []
    for (const entity of entities) {
      const id = entityNodeId(entity.type, entity.normalized)
      ids.push(id)
      let node = nodeById.get(id)
      if (node === undefined) {
        node = {
          id,
          type: entity.type,
          value: entity.value,
          label: entity.label,
          count: 0,
          scopes: new Set<string>(),
          kinds: new Map<string, number>(),
          weight: entity.weight,
        }
        nodeById.set(id, node)
      }
      node.count++
      node.scopes.add(scope)
      node.kinds.set(kind, (node.kinds.get(kind) ?? 0) + 1)
    }
    ids.sort(cmpStr)
    memoryEntities.push({ memoryId, ids })
  }

  // 节点：minCount 过滤 → count↓/id↑ 截断
  const nodes: EntityNode[] = [...nodeById.values()]
    .filter((node) => node.count >= minCount)
    .sort(compareNode)
    .slice(0, maxNodes)
    .map((node) => ({
      id: node.id,
      type: node.type,
      value: node.value,
      label: node.label,
      count: node.count,
      scopes: [...node.scopes].filter((scope) => scope !== '').sort(cmpStr),
      kinds: Object.fromEntries([...node.kinds.entries()].filter(([kind]) => kind !== '').sort((a, b) => cmpStr(a[0], b[0]))),
      weight: node.weight,
    }))
  const kept = new Set(nodes.map((node) => node.id))

  // 边：只连最终节点，pair 在每条记忆内生成（每对 (a,b) 只 +1，防同记忆重复计权）
  const edgeWeights = new Map<string, number>()
  for (const memory of memoryEntities) {
    const ids = memory.ids.filter((id) => kept.has(id))
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const key = `${ids[i]}\u0000${ids[j]}`
        edgeWeights.set(key, (edgeWeights.get(key) ?? 0) + 1)
      }
    }
  }
  const edges: EntityEdge[] = [...edgeWeights.entries()]
    .map(([key, weight]) => {
      const [a, b] = key.split('\u0000')
      return { a: a!, b: b!, weight }
    })
    .sort(compareEdge)
    .slice(0, maxEdges)

  // 反向索引：节点 → 记忆 id（升序）
  const memoryIndex = new Map<string, string[]>()
  for (const node of nodes) memoryIndex.set(node.id, [])
  for (const memory of memoryEntities) {
    for (const id of memory.ids) {
      const list = memoryIndex.get(id)
      if (list !== undefined) list.push(memory.memoryId)
    }
  }
  for (const list of memoryIndex.values()) list.sort(cmpStr)

  return { nodes, edges, stats: { entities: nodes.length, edges: edges.length, memories }, memoryIndex }
}

// ---------------------------------------------------------------- 查询

export interface RelatedEntity {
  id: string
  type: EntityType
  value: string
  label: string
  /** 共现边的权重（共同出现的记忆数）。 */
  weight: number
  /** 邻居节点自身的出现次数。 */
  count: number
}

/** 与某个实体直接相连的邻居，按边权重↓ / 出现次数↓ / id↑ 排序。 */
export function relatedEntities(graph: EntityGraph, entityId: string, limit = 20): RelatedEntity[] {
  if (graph === null || graph === undefined || typeof entityId !== 'string') return []
  const cap = Math.max(0, Math.floor(Number.isFinite(limit) ? limit : 20))
  if (cap === 0) return []
  const nodeById = new Map<string, EntityNode>()
  for (const node of graph.nodes) nodeById.set(node.id, node)
  const out: RelatedEntity[] = []
  for (const edge of graph.edges) {
    const otherId = edge.a === entityId ? edge.b : edge.b === entityId ? edge.a : undefined
    if (otherId === undefined) continue
    const node = nodeById.get(otherId)
    if (node === undefined) continue
    out.push({ id: node.id, type: node.type, value: node.value, label: node.label, weight: edge.weight, count: node.count })
  }
  out.sort((a, b) => b.weight - a.weight || b.count - a.count || cmpStr(a.id, b.id))
  return out.slice(0, cap)
}

/** 某个实体出现在哪些记忆里（不知道该实体 → []）。 */
export function entityMemories(graph: EntityGraph, entityId: string): string[] {
  if (graph === null || graph === undefined) return []
  const list = graph.memoryIndex.get(entityId)
  return list === undefined ? [] : [...list]
}

export interface EntityGraphSummary {
  entities: number
  edges: number
  memories: number
  /** 各实体类型的节点数（键升序）。 */
  byType: Record<string, number>
  /** 出现最多的实体（默认前 10），面板摘要/图例用。 */
  topEntities: Array<{ id: string; type: EntityType; label: string; count: number }>
}

/** 图的统计摘要（provider 的 graphStats() 建议直接返回它）。 */
export function graphStats(graph: EntityGraph, topLimit = 10): EntityGraphSummary {
  const cap = Math.max(0, Math.floor(Number.isFinite(topLimit) ? topLimit : 10))
  const byType = new Map<string, number>()
  for (const node of graph?.nodes ?? []) byType.set(node.type, (byType.get(node.type) ?? 0) + 1)
  const topEntities = [...(graph?.nodes ?? [])]
    .sort((a, b) => b.count - a.count || cmpStr(a.id, b.id))
    .slice(0, cap)
    .map((node) => ({ id: node.id, type: node.type, label: node.label, count: node.count }))
  return {
    entities: graph?.stats.entities ?? 0,
    edges: graph?.stats.edges ?? 0,
    memories: graph?.stats.memories ?? 0,
    byType: Object.fromEntries([...byType.entries()].sort((a, b) => cmpStr(a[0], b[0]))),
    topEntities,
  }
}

export interface SerializableEntityGraph {
  nodes: EntityNode[]
  edges: EntityEdge[]
  stats: EntityGraphStats
  /** Map 不能 JSON 序列化：面板传输用普通对象（键升序）。 */
  memoryIndex: Record<string, string[]>
}

/** 面板/工具回执用的可 JSON 化版本（Map → 普通对象）。 */
export function serializeGraph(graph: EntityGraph): SerializableEntityGraph {
  const memoryIndex: Record<string, string[]> = {}
  for (const [id, memories] of [...graph.memoryIndex.entries()].sort((a, b) => cmpStr(a[0], b[0]))) {
    memoryIndex[id] = [...memories]
  }
  return { nodes: graph.nodes, edges: graph.edges, stats: graph.stats, memoryIndex }
}
