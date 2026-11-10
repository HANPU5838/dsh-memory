/**
 * 嵌入/ANN 基准工具的纯函数库（零依赖，node 内置模块）。
 *
 * 三个用途：
 *  1. 合成记忆集（可复现）：同一个 seed 得到同一批记录/查询/向量；
 *  2. 合成嵌入：把文本确定性地映射成向量（词袋 + 哈希随机投影 + L2 归一化），
 *     让"没装 llama-server"的机器也能跑出有意义的批量/缓存/ANN 基准；
 *  3. 统计与输出：P50/P95/P99、设备信息、Markdown 表。
 */
import { arch, cpus, platform, release, totalmem } from 'node:os'
import { readFileSync } from 'node:fs'

// ---------------------------------------------------------------------------
// 随机数
// ---------------------------------------------------------------------------

/** mulberry32：小、快、可复现。 */
export function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 标准正态（Box-Muller），合成向量的噪声用。 */
export function gaussian(rng) {
  const u = Math.max(rng(), 1e-12)
  const v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

// ---------------------------------------------------------------------------
// 合成文本 / 嵌入
// ---------------------------------------------------------------------------

/** 与 scoring.tokenize 同思路的简化分词：拉丁词 + CJK 单字 + CJK 双字。 */
export function tokenizeForEmbedding(text) {
  const lower = text.toLowerCase()
  const tokens = []
  for (const m of lower.matchAll(/[a-z0-9][a-z0-9_+\-.]*/g)) tokens.push(m[0])
  for (const run of lower.matchAll(/[\u3400-\u4dbf\u4e00-\u9fff]+/g)) {
    const chars = [...run[0]]
    for (const c of chars) tokens.push(c)
    for (let i = 0; i + 1 < chars.length; i++) tokens.push(chars[i] + chars[i + 1])
  }
  return tokens
}

/** FNV-1a 32 位哈希。 */
export function hashToken(token) {
  let h = 0x811c9dc5
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * 合成嵌入：token → 两个哈希桶（带符号）累加，最后 L2 归一化。
 * 共享 token 的文本 cosine 高，是真实嵌入的粗糙但可用的替身。
 */
export function syntheticEmbed(text, dims) {
  const vector = new Float32Array(dims)
  let norm = 0
  for (const token of tokenizeForEmbedding(text)) {
    const h = hashToken(token)
    const i1 = h % dims
    const i2 = (h >>> 11) % dims
    const sign = (h & 1) === 1 ? 1 : -1
    vector[i1] += sign
    vector[i2] += sign * 0.5
    norm += 1.5
  }
  let sum = 0
  for (let i = 0; i < dims; i++) sum += vector[i] * vector[i]
  const scale = Math.sqrt(sum)
  if (scale > 0) for (let i = 0; i < dims; i++) vector[i] /= scale
  return vector
}

// ---------------------------------------------------------------------------
// 合成记忆集
// ---------------------------------------------------------------------------

const TOPIC_WORDS = [
  ['部署', 'release', '回滚', 'rollback', '灰度', 'canary', '流水线', 'pipeline'],
  ['数据库', 'database', '迁移', 'migration', '索引', 'index', '事务', 'transaction'],
  ['嵌入', 'embedding', '向量', 'vector', '模型', 'model', '维度', 'dims'],
  ['缓存', 'cache', '命中率', 'hitrate', 'LRU', '失效', 'invalidate', '性能'],
  ['测试', 'test', '基线', 'baseline', '回归', 'regression', '覆盖', 'coverage'],
  ['Android', 'Termux', 'arm64', 'aarch64', '设备', 'device', '电池', 'battery'],
  ['构建', 'build', '打包', 'bundle', '产物', 'artifact', '版本', 'version'],
  ['检索', 'retrieval', '召回', 'recall', '排序', 'rank', '阈值', 'threshold'],
  ['记忆', 'memory', '作用域', 'scope', '注入', 'inject', '命中', 'hit'],
  ['网络', 'network', '超时', 'timeout', '重试', 'retry', '代理', 'proxy'],
  ['安全', 'secret', '凭据', 'token', '审批', 'approval', '权限', 'permission'],
  ['面板', 'panel', '界面', 'UI', '刷新', 'refresh', '状态', 'status'],
]

const TEMPLATES = [
  (words, unique) => `${words[0]}相关的记录：${words[1]} 配置要注意 ${unique}；${words[2]} 时先看 ${words[3]}。`,
  (words, unique) => `关于 ${words[1]} 的经验：${words[2]} 失败通常因为 ${words[3]}，${words[0]} 日志里有 ${unique}。`,
  (words, unique) => `项目 ${words[0]}/${words[2]} 结论：${unique} 下 ${words[1]} 与 ${words[3]} 的关系已确认。`,
  (words, unique) => `踩坑 ${unique}：${words[0]} 的 ${words[2]} 与 ${words[1]} 互相影响，${words[3]} 需要确认。`,
]

/**
 * 生成合成记忆集：count 条记录 + queryCount 条查询 + 对应的合成向量。
 * 记录按 topic 分簇（真实记忆库的语义分布），同簇向量相近。
 */
export function makeCorpus(count, opts = {}) {
  const dims = opts.dims ?? 256
  const seed = opts.seed ?? 42
  const queryCount = opts.queryCount ?? 50
  const rng = mulberry32(seed)
  const records = []
  for (let i = 0; i < count; i++) {
    const topic = i % TOPIC_WORDS.length
    const words = TOPIC_WORDS[topic]
    const unique = `rec${i}-${(rng() * 1e6).toFixed(0)}`
    const rotate = Math.floor(rng() * words.length)
    const picked = [0, 1, 2, 3].map((k) => words[(k + rotate) % words.length])
    const content = TEMPLATES[i % TEMPLATES.length](picked, unique)
    records.push({
      id: `mem-${String(i).padStart(5, '0')}`,
      topic,
      content,
      tags: [words[1], `t${topic}`],
      vector: syntheticEmbed(content, dims),
    })
  }
  const queries = []
  for (let j = 0; j < queryCount; j++) {
    const target = records[Math.floor(rng() * Math.max(1, records.length))]
    const words = TOPIC_WORDS[target ? target.topic : 0]
    const text = target
      ? `${words[0]} ${words[1]} ${target.content.slice(0, 24)}`
      : `${words[0]} ${words[1]}`
    queries.push({ text, targetId: target?.id })
  }
  return { records, queries, dims, seed }
}

// ---------------------------------------------------------------------------
// 合成向量（ANN 基准专用）
// ---------------------------------------------------------------------------

/**
 * 生成聚簇合成向量：clusters 个中心 + 高斯噪声，模拟"真实语义空间里的
 * 记忆向量分布"（纯均匀随机在 128 维上 cosine 区分度太差，测不出召回）。
 */
export function makeClusteredVectors(count, dims, opts = {}) {
  const clusters = Math.max(2, opts.clusters ?? 48)
  const noise = opts.noise ?? 0.55
  const rng = mulberry32(opts.seed ?? 7)
  const centers = []
  for (let c = 0; c < clusters; c++) {
    const center = new Float32Array(dims)
    for (let d = 0; d < dims; d++) center[d] = gaussian(rng)
    normalizeInPlace(center)
    centers.push(center)
  }
  const items = []
  for (let i = 0; i < count; i++) {
    const center = centers[i % clusters]
    const vector = new Float32Array(dims)
    // 噪声按维度缩放：noise 是相对中心向量的“相对扰动幅度”（norm 比例），
    // 否则在 128 维上 0.55/维 的高斯会把中心彻底淹没，合成数据就没有簇结构了。
    const sigma = noise / Math.sqrt(dims)
    for (let d = 0; d < dims; d++) vector[d] = center[d] + gaussian(rng) * sigma
    normalizeInPlace(vector)
    items.push({ id: `ann-${i}`, vector })
  }
  return items
}

/** 给查询向量加噪声（模拟"查询和记忆不完全相同"）。 */
export function noisedVector(vector, noise, rng) {
  const out = new Float32Array(vector.length)
  // 同 makeClusteredVectors：noise 是相对幅度，按 sqrt(dims) 缩放。
  const sigma = noise / Math.sqrt(vector.length)
  for (let i = 0; i < vector.length; i++) out[i] = vector[i] + gaussian(rng) * sigma
  normalizeInPlace(out)
  return out
}

function normalizeInPlace(vector) {
  let sum = 0
  for (let i = 0; i < vector.length; i++) sum += vector[i] * vector[i]
  const norm = Math.sqrt(sum)
  if (norm > 0) for (let i = 0; i < vector.length; i++) vector[i] /= norm
  return vector
}

// ---------------------------------------------------------------------------
// 统计
// ---------------------------------------------------------------------------

export function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0
  const rank = Math.ceil((p / 100) * sortedAsc.length) - 1
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, rank))]
}

export function summarizeLatencies(values) {
  if (values.length === 0) return { count: 0, mean: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  const sum = sorted.reduce((acc, v) => acc + v, 0)
  return {
    count: sorted.length,
    mean: round(sum / sorted.length, 3),
    p50: round(percentile(sorted, 50), 3),
    p95: round(percentile(sorted, 95), 3),
    p99: round(percentile(sorted, 99), 3),
    min: round(sorted[0], 3),
    max: round(sorted[sorted.length - 1], 3),
  }
}

export function round(value, digits = 2) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

// ---------------------------------------------------------------------------
// 设备信息
// ---------------------------------------------------------------------------

function readCpuModel() {
  // Android/Termux 的 /proc/cpuinfo 往往没有 model name（processor: 0 不算型号），
  // device-tree 里的 machine 才是最像“设备/SoC 名”的信息；最后才退回 os.cpus()。
  try {
    const soc = readFileSync('/proc/device-tree/model', 'utf8').replaceAll('\u0000', '').trim()
    if (soc !== '') return soc
  } catch {
    /* 非 ARM/非 Linux 平台 */
  }
  try {
    const info = readFileSync('/proc/cpuinfo', 'utf8')
    for (const line of info.split('\n')) {
      const match = /^(?:model name|Hardware|Processor|SOC)\s*:\s*(.+)$/i.exec(line)
      if (match === null) continue
      const value = match[1].trim()
      if (value === '' || /^\d+$/.test(value)) continue // "processor : 0" 是核心编号，不是型号
      return value
    }
  } catch {
    /* 非 Linux 平台 */
  }
  const model = cpus()[0]?.model
  return model === undefined || model === 'unknown' || model === '' ? 'unknown' : model
}

export function detectDevice() {
  return {
    platform: platform(),
    release: release(),
    arch: arch(),
    node: process.version,
    cpuModel: readCpuModel(),
    cpuCount: cpus().length,
    totalMemMB: Math.round(totalmem() / 1024 / 1024),
    measuredAt: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

export function markdownTable(headers, rows) {
  const escape = (value) => String(value).replaceAll('|', '\\|')
  const lines = [
    `| ${headers.map(escape).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(escape).join(' | ')} |`),
  ]
  return lines.join('\n')
}

export function formatMs(ms) {
  if (ms >= 1000) return `${round(ms / 1000, 2)}s`
  return `${round(ms, 2)}ms`
}

/** 从 /v1/embeddings 地址推出 llama-server 的健康检查地址。 */
export function healthUrlOf(endpoint) {
  try {
    const url = new URL(endpoint)
    if (url.pathname.includes('/v1/')) return `${url.origin}/health`
    return `${url.origin}/health`
  } catch {
    return endpoint
  }
}

/** 带超时的健康探测；失败返回 false（绝不抛）。 */
export async function probeLive(endpoint, timeoutMs = 2000) {
  try {
    const res = await fetch(healthUrlOf(endpoint), { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok
  } catch {
    return false
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
