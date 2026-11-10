#!/usr/bin/env node
/**
 * DSH 记忆嵌入性能基准（任务书 §6）。
 *
 * 三件事一次跑完：
 *   1. 写入吞吐：批大小 1/4/8/16 的文档嵌入 → records/s、请求数、失败数；
 *   2. 缓存收益：同一批文档冷/热两遍 → 命中率、节省请求数、耗时对比；
 *   3. 查询延迟：单条查询嵌入 + 全量余弦扫描 → P50/P95/P99（冷 = 无查询缓存，热 = 命中）；
 *   4. 回填吞吐：模拟待嵌入队列，按批大小比较 records/s；
 *   5. ANN vs 全量：2000 → 20000 条合成向量，建索引耗时、查询 P50/P95、recall@10。
 *
 * 两种数据源：
 *   - `live`：连真实 llama-server（http://127.0.0.1:8078/v1/embeddings）。**串行小批量**、
 *     每个请求都有超时；探测失败自动跳过（退出码仍是 0，CI 不会被压测搞红）。
 *   - `synthetic`：确定性合成嵌入（无需任何后端），全流程可复现。
 *   - `auto`（默认）：健康探测通过就用 live，否则 synthetic。
 *
 * 用法（Node ≥ 23.6 直接跑；更老的 node 加 --experimental-strip-types）：
 *   node tools/bench/run.mjs
 *   node tools/bench/run.mjs --mode live --records 32 --queries 12
 *   node tools/bench/run.mjs --records 5000 --ann-sizes 2000,10000,20000 --skip-live
 *   node tools/bench/run.mjs --help
 *
 * 结果写 `tools/bench/out/bench-<timestamp>.{json,md}`（out/ 已 gitignore），
 * 同时把 Markdown 表打到 stdout。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  detectDevice,
  formatMs,
  healthUrlOf,
  makeClusteredVectors,
  makeCorpus,
  markdownTable,
  mulberry32,
  noisedVector,
  probeLive,
  round,
  sleep,
  summarizeLatencies,
  syntheticEmbed,
} from './lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

const { EmbedClient } = await import('../../source/memory-local/src/embed.ts')
const { EmbedCache, CachedEmbedder } = await import('../../source/memory-local/src/embed-cache.ts')
const { createAnnIndex, BruteAnnIndex } = await import('../../source/memory-local/src/ann/index.ts')

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

const HELP = `用法: node tools/bench/run.mjs [选项]

  --mode auto|live|synthetic   数据源（默认 auto：先探测真实后端）
  --endpoint URL               /v1/embeddings 地址（默认 http://127.0.0.1:8078/v1/embeddings）
  --model NAME                 live 模式的模型名（默认 bge-m3）
  --dims N                     嵌入维度（live 默认 1024；synthetic 默认 256）
  --records N                  写入吞吐/缓存/查询用的记录数（live 默认 32；synthetic 默认 2000）
  --backfill N                 回填队列长度（live 默认 16；synthetic 默认 400）
  --queries N                  查询条数（live 默认 12；synthetic 默认 50）
  --batch-sizes a,b,c          写入吞吐的批大小（默认 1,4,8,16）
  --backfill-batch-sizes a,b   回填批大小（默认 8,16）
  --ann-sizes a,b,c            ANN 压测规模（默认 2000,5000,10000,20000）
  --ann-dims N                 ANN 合成向量维度（默认 128）
  --ann-queries N              ANN 每次规模的查询数（默认 50）
  --timeout-ms N               live 单请求超时（默认 20000）
  --seed N                     合成数据种子（默认 42）
  --out DIR                    输出目录（默认 tools/bench/out）
  --skip-ann                   跳过 ANN 压测
  --skip-embed                 跳过嵌入阶段（写入/缓存/查询/回填），只测 ANN
  --skip-live                  强制 synthetic（不探测后端）
  --help                       显示本帮助`

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next
      i += 1
    } else {
      out[key] = true
    }
  }
  return out
}

function intArg(value, fallback) {
  if (value === undefined || value === true) return fallback
  const parsed = Number.parseInt(String(value), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function listArg(value, fallback) {
  if (value === undefined || value === true) return fallback
  const list = String(value)
    .split(',')
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0)
  return list.length > 0 ? list : fallback
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log(HELP)
  process.exit(0)
}

const seed = intArg(args.seed, 42)
const endpoint = String(args.endpoint ?? process.env.DSH_BENCH_EMBED_ENDPOINT ?? 'http://127.0.0.1:8078/v1/embeddings')
const requestedMode = String(args.mode ?? 'auto')
const notes = []

// ---------------------------------------------------------------------------
// 数据源
// ---------------------------------------------------------------------------

function makeSyntheticEmbedder(dims) {
  let requests = 0
  return {
    kind: 'synthetic',
    dims,
    stats: () => ({ requests, inputs: 0, failedItems: 0, batchRequests: requests }),
    async embed(texts) {
      requests += 1
      return texts.map((text) => syntheticEmbed(text, dims))
    },
  }
}

function makeLiveEmbedder(opts) {
  const client = new EmbedClient({
    endpoint: opts.endpoint,
    model: opts.model,
    dims: opts.dims,
    timeoutMs: opts.timeoutMs,
    maxBatchSize: 64,
    maxBatchChars: 0,
    // 压测时后端偶尔超时/重启是常见事件；只记统计，不打每一条 warn。
    log: () => {},
  })
  return {
    kind: 'live',
    dims: opts.dims,
    client,
    stats: () => client.embedStats,
    async embed(texts) {
      return client.embedBatch(texts, undefined, {
        timeoutMs: opts.timeoutMs,
        maxBatchSize: Math.max(1, texts.length),
        maxBatchChars: 0,
      })
    },
  }
}

/** 探测真实后端；mode=live 时失败也不抛，由调用方决定跳过。 */
async function resolveMode() {
  if (requestedMode === 'synthetic' || args['skip-live']) return 'synthetic'
  const healthy = await probeLive(endpoint, 2500)
  if (healthy) return 'live'
  if (requestedMode === 'live') {
    notes.push(`真实后端不可用（${healthUrlOf(endpoint)} 探测失败），所有嵌入阶段跳过`)
    return 'live'
  }
  notes.push(`真实后端不可用（${healthUrlOf(endpoint)}），回退 synthetic 合成嵌入`)
  return 'synthetic'
}

// ---------------------------------------------------------------------------
// 各阶段
// ---------------------------------------------------------------------------

const identityOf = (embedder) => ({
  model: embedder.kind === 'live' ? `${args.model ?? 'bge-m3'}` : 'synthetic-embed',
  dims: embedder.dims,
})

/** 冷写入吞吐：每个批大小独立跑一遍（live 模式重嵌入，数字才是真的）。 */
async function benchWrite(embedder, corpus, recordCount, batchSizes) {
  const docs = corpus.records.slice(0, recordCount).map((record) => record.content)
  const results = []
  let lastVectors = []
  for (const batchSize of batchSizes) {
    const startedAt = performance.now()
    let embedded = 0
    let failed = 0
    let calls = 0
    const vectors = new Array(docs.length)
    for (let i = 0; i < docs.length; i += batchSize) {
      const chunk = docs.slice(i, i + batchSize)
      const chunkVectors = await embedder.embed(chunk)
      calls += 1
      if (chunkVectors === null) {
        failed += chunk.length
        continue
      }
      for (let j = 0; j < chunk.length; j++) {
        const vector = chunkVectors[j]
        if (vector) vectors[i + j] = vector
        else failed += 1
      }
      embedded += chunk.length - chunkVectors.filter((v) => !v).length
    }
    const elapsedMs = performance.now() - startedAt
    results.push({
      batchSize,
      records: docs.length,
      embedded,
      failed,
      calls,
      elapsedMs: round(elapsedMs, 2),
      recordsPerSec: round(embedded / Math.max(elapsedMs / 1000, 1e-6), 2),
      avgRequestMs: round(elapsedMs / Math.max(calls, 1), 2),
    })
    if (embedded > 0) lastVectors = vectors
    console.log(`  write batch=${batchSize}: ${round(embedded / Math.max(elapsedMs / 1000, 1e-6), 1)} rec/s（${formatMs(elapsedMs)}）`)
  }
  return { results, vectors: lastVectors }
}

/** 文档缓存：冷跑一遍填缓存，热跑一遍看命中。 */
async function benchCache(embedder, corpus, recordCount) {
  const docs = corpus.records.slice(0, recordCount).map((record) => record.content)
  const cache = new EmbedCache({
    identity: identityOf(embedder),
    documentCache: true,
    queryCache: false,
    flushDelayMs: 10_000,
  })
  const cached = new CachedEmbedder({ cache, batch: (texts) => embedder.embed(texts) })
  const coldStart = performance.now()
  const cold = await cached.embedDocuments(docs)
  const coldMs = performance.now() - coldStart
  const afterCold = cache.statsSnapshot
  const warmStart = performance.now()
  const warm = await cached.embedDocuments(docs)
  const warmMs = performance.now() - warmStart
  const afterWarm = cache.statsSnapshot
  cache.dispose()
  const coldOk = cold === null ? 0 : cold.filter(Boolean).length
  const warmOk = warm === null ? 0 : warm.filter(Boolean).length
  return {
    records: docs.length,
    cold: { elapsedMs: round(coldMs, 2), embedded: coldOk, recordsPerSec: round(coldOk / Math.max(coldMs / 1000, 1e-6), 2) },
    warm: { elapsedMs: round(warmMs, 2), hits: warmOk, recordsPerSec: round(warmOk / Math.max(warmMs / 1000, 1e-6), 2) },
    stats: {
      docHits: afterWarm.docHits - afterCold.docHits,
      docMisses: afterWarm.docMisses - afterCold.docMisses,
      requestsSaved: afterWarm.docHits - afterCold.docHits,
      hitRate: round((afterWarm.docHits - afterCold.docHits) / Math.max(1, docs.length), 3),
    },
    speedup: round(coldMs / Math.max(warmMs, 1e-6), 1),
  }
}

/** 查询延迟：单条查询嵌入 + 全量余弦扫描；冷跑一遍再用查询 LRU 跑一遍。 */
async function benchQuery(embedder, queries, vectors) {
  const dims = embedder.dims
  const cache = new EmbedCache({ identity: identityOf(embedder), documentCache: false, queryCache: true, flushDelayMs: 10_000 })
  // cold 跑也回填缓存，这样 warm 跑是真正的"同一查询再来一次"（100% 命中）；
  // 如果 cold 不回填，warm 只是重新嵌入一遍，数字看起来"缓存没收益"，会误导读者。
  const embedQuery = async (text, useCache) => {
    if (useCache) {
      const hit = cache.getQuery(text)
      if (hit) return hit
    }
    const result = await embedder.embed([text])
    const vector = result?.[0] ?? null
    if (vector) cache.putQuery(text, vector)
    return vector
  }
  const scan = (q) => {
    // 真的扫一遍全量向量：查询延迟必须是端到端数字，不能只测嵌入。
    let best = 0
    for (const vector of vectors) {
      if (!vector) continue
      let dot = 0
      for (let i = 0; i < dims; i++) dot += q[i] * vector[i]
      if (dot > best) best = dot
    }
    return best
  }
  const run = async (useCache) => {
    const latencies = []
    let ok = 0
    for (const query of queries) {
      const startedAt = performance.now()
      const vector = await embedQuery(query.text, useCache)
      if (vector === null) continue
      scan(vector)
      latencies.push(performance.now() - startedAt)
      ok += 1
    }
    return { ...summarizeLatencies(latencies), ok }
  }
  const cold = await run(false)
  const warm = await run(true)
  cache.dispose()
  return { queries: queries.length, vectors: vectors.filter(Boolean).length, cold, warm }
}

/** 回填吞吐：模拟待嵌入队列（每批都有超时/失败计数）。 */
async function benchBackfill(embedder, texts, batchSizes) {
  const results = []
  for (const batchSize of batchSizes) {
    const startedAt = performance.now()
    let embedded = 0
    let failed = 0
    let calls = 0
    for (let i = 0; i < texts.length; i += batchSize) {
      const chunk = texts.slice(i, i + batchSize)
      const vectors = await embedder.embed(chunk)
      calls += 1
      if (vectors === null) {
        failed += chunk.length
        continue
      }
      for (const vector of vectors) {
        if (vector) embedded += 1
        else failed += 1
      }
    }
    const elapsedMs = performance.now() - startedAt
    results.push({
      batchSize,
      records: texts.length,
      embedded,
      failed,
      calls,
      elapsedMs: round(elapsedMs, 2),
      recordsPerSec: round(embedded / Math.max(elapsedMs / 1000, 1e-6), 2),
    })
    console.log(`  backfill batch=${batchSize}: ${round(embedded / Math.max(elapsedMs / 1000, 1e-6), 1)} rec/s`)
  }
  return results
}

/** ANN vs 全量：建图耗时、查询 P50/P95、recall@10（以全量扫描为 ground truth）。 */
async function benchAnn(annDims, sizes, queryCount) {
  const maxSize = Math.max(...sizes)
  console.log(`  生成 ${maxSize} 条 ${annDims} 维聚簇合成向量…`)
  const items = makeClusteredVectors(maxSize, annDims, { clusters: 48, noise: 0.55, seed: 7 })
  const rng = mulberry32(seed + 99)
  const results = []
  for (const size of sizes) {
    const slice = items.slice(0, size)
    const queries = []
    for (let q = 0; q < queryCount; q++) {
      const item = slice[Math.floor(rng() * size)]
      queries.push(noisedVector(item.vector, 0.3, rng))
    }
    const ann = await createAnnIndex({ dims: annDims, M: 24, efConstruction: 200, efSearch: 128, seed: 7 })
    const buildStart = performance.now()
    ann.build(slice)
    const annBuildMs = performance.now() - buildStart
    const brute = new BruteAnnIndex(annDims)
    const bruteBuildStart = performance.now()
    brute.build(slice)
    const bruteBuildMs = performance.now() - bruteBuildStart
    const annLatencies = []
    const bruteLatencies = []
    let recallSum = 0
    for (const query of queries) {
      const annStart = performance.now()
      const annHits = ann.search(query, 10)
      annLatencies.push(performance.now() - annStart)
      const bruteStart = performance.now()
      const bruteHits = brute.search(query, 10)
      bruteLatencies.push(performance.now() - bruteStart)
      const truth = new Set(bruteHits.map((hit) => hit.id))
      let hits = 0
      for (const hit of annHits) if (truth.has(hit.id)) hits += 1
      recallSum += hits / 10
    }
    results.push({
      size,
      kind: ann.kind,
      dims: annDims,
      annBuildMs: round(annBuildMs, 2),
      bruteBuildMs: round(bruteBuildMs, 2),
      annQuery: summarizeLatencies(annLatencies),
      bruteQuery: summarizeLatencies(bruteLatencies),
      recallAt10: round(recallSum / queries.length, 3),
      speedupP50: round(
        summarizeLatencies(bruteLatencies).p50 / Math.max(summarizeLatencies(annLatencies).p50, 1e-6),
        1,
      ),
    })
    console.log(
      `  ANN size=${size} kind=${ann.kind} build=${formatMs(annBuildMs)} recall@10=${round(recallSum / queries.length, 3)} ` +
        `p50 ANN=${round(summarizeLatencies(annLatencies).p50, 2)}ms / brute=${round(summarizeLatencies(bruteLatencies).p50, 2)}ms`,
    )
  }
  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function buildMarkdown(payload) {
  const { meta, write, cache, query, backfill, ann } = payload
  const parts = []
  parts.push('# DSH 记忆嵌入性能基准')
  parts.push('')
  parts.push(
    markdownTable(
      ['项目', '值'],
      [
        ['时间', meta.measuredAt],
        ['设备', `${meta.device.platform}/${meta.device.arch} · ${meta.device.cpuModel} · ${meta.device.cpuCount} 核 · ${meta.device.totalMemMB}MB RAM`],
        ['Node', meta.device.node],
        ['模式', meta.mode === 'live' ? `live（${meta.model} @ ${meta.endpoint}）` : 'synthetic（合成嵌入）'],
        ['嵌入维度', meta.dims],
        ['记录数 / 查询数', `${meta.records} / ${meta.queries}`],
        ['ANN 规模 / 维度', `${meta.annSizes.join(', ')} / ${meta.annDims}`],
      ],
    ),
  )
  parts.push('')
  if (write.length > 0) {
    parts.push('## 写入吞吐（冷，无缓存）')
    parts.push(markdownTable(
      ['批大小', '条数', '成功', '失败', '请求数', '耗时', 'records/s', '平均请求'],
      write.map((row) => [
        row.batchSize, row.records, row.embedded, row.failed, row.calls,
        formatMs(row.elapsedMs), row.recordsPerSec, formatMs(row.avgRequestMs),
      ]),
    ))
    parts.push('')
  }
  if (cache) {
    parts.push('## 文档向量缓存')
    parts.push(markdownTable(
      ['场景', '条数', '命中/嵌入', '耗时', 'records/s'],
      [
        ['冷（缓存空）', cache.records, cache.cold.embedded, formatMs(cache.cold.elapsedMs), cache.cold.recordsPerSec],
        ['热（命中缓存）', cache.records, cache.warm.hits, formatMs(cache.warm.elapsedMs), cache.warm.recordsPerSec],
      ],
    ))
    parts.push('')
    parts.push(`- 命中率：**${round(cache.stats.hitRate * 100, 1)}%**，节省嵌入请求：**${cache.stats.requestsSaved}** 次，提速 **${cache.speedup}x**`)
    parts.push('')
  }
  if (query) {
    parts.push('## 查询延迟（嵌入 + 全量余弦扫描）')
    parts.push(markdownTable(
      ['场景', '查询数', '成功', 'mean', 'P50', 'P95', 'P99', 'max'],
      [
        ['冷（无缓存）', query.queries, query.cold.ok, formatMs(query.cold.mean), formatMs(query.cold.p50), formatMs(query.cold.p95), formatMs(query.cold.p99), formatMs(query.cold.max)],
        ['热（查询 LRU）', query.queries, query.warm.ok, formatMs(query.warm.mean), formatMs(query.warm.p50), formatMs(query.warm.p95), formatMs(query.warm.p99), formatMs(query.warm.max)],
      ],
    ))
    parts.push('')
  }
  if (backfill.length > 0) {
    parts.push('## 回填吞吐（模拟待嵌入队列）')
    parts.push(markdownTable(
      ['批大小', '条数', '成功', '失败', '请求数', '耗时', 'records/s'],
      backfill.map((row) => [row.batchSize, row.records, row.embedded, row.failed, row.calls, formatMs(row.elapsedMs), row.recordsPerSec]),
    ))
    parts.push('')
  }
  if (ann.length > 0) {
    parts.push('## ANN vs 全量余弦（合成聚簇向量）')
    parts.push(markdownTable(
      ['条目数', '实现', '建图', '查询 mean', '查询 P50', '查询 P95', '全量 P50', '全量 P95', 'recall@10', 'P50 提速'],
      ann.map((row) => [
        row.size, row.kind, formatMs(row.annBuildMs),
        formatMs(row.annQuery.mean), formatMs(row.annQuery.p50), formatMs(row.annQuery.p95),
        formatMs(row.bruteQuery.p50), formatMs(row.bruteQuery.p95),
        `${round(row.recallAt10 * 100, 1)}%`, `${row.speedupP50}x`,
      ]),
    ))
    parts.push('')
  }
  if (notes.length > 0) {
    parts.push('## 备注 / 跳过')
    for (const note of notes) parts.push(`- ${note}`)
    parts.push('')
  }
  return parts.join('\n')
}

async function main() {
  const mode = await resolveMode()
  const dims = intArg(args.dims, mode === 'live' ? 1024 : 256)
  const recordCount = intArg(args.records, mode === 'live' ? 32 : 2000)
  const backfillCount = intArg(args.backfill, mode === 'live' ? 16 : 400)
  const queryCount = intArg(args.queries, mode === 'live' ? 12 : 50)
  const batchSizes = listArg(args['batch-sizes'], [1, 4, 8, 16])
  const backfillBatchSizes = listArg(args['backfill-batch-sizes'], [8, 16])
  const annSizes = listArg(args['ann-sizes'], [2000, 5000, 10000, 20000])
  const annDims = intArg(args['ann-dims'], 128)
  const annQueries = intArg(args['ann-queries'], 50)
  const timeoutMs = intArg(args['timeout-ms'], 20_000)
  const outDir = resolve(String(args.out ?? join(HERE, 'out')))

  const device = detectDevice()
  console.log(`DSH memory bench · mode=${mode} · ${device.platform}/${device.arch} · node ${device.node}`)
  console.log(`  CPU: ${device.cpuModel} (${device.cpuCount} 核) · RAM ${device.totalMemMB}MB`)

  const embedder = mode === 'live' ? makeLiveEmbedder({ endpoint, model: String(args.model ?? 'bge-m3'), dims, timeoutMs }) : makeSyntheticEmbedder(dims)

  const corpus = makeCorpus(Math.max(recordCount, 1), { dims, seed, queryCount })
  const payload = {
    meta: {
      measuredAt: device.measuredAt,
      device: {
        platform: device.platform,
        release: device.release,
        arch: device.arch,
        node: device.node,
        cpuModel: device.cpuModel,
        cpuCount: device.cpuCount,
        totalMemMB: device.totalMemMB,
      },
      mode,
      endpoint: mode === 'live' ? endpoint : undefined,
      model: mode === 'live' ? String(args.model ?? 'bge-m3') : 'synthetic-embed',
      dims,
      records: recordCount,
      backfill: backfillCount,
      queries: queryCount,
      annSizes: args['skip-ann'] ? [] : annSizes,
      annDims,
      seed,
    },
    write: [],
    cache: null,
    query: null,
    backfill: [],
    ann: [],
    notes,
  }

  // 1) 写入吞吐 -------------------------------------------------------------
  if (args['skip-embed']) {
    notes.push('嵌入阶段按 --skip-embed 跳过')
  } else if (mode === 'live' && !(await probeLive(endpoint, 2500))) {
    notes.push('写入/缓存/查询/回填阶段跳过：真实后端不可用')
  } else {
    try {
      console.log('› 写入吞吐（冷）')
      const write = await benchWrite(embedder, corpus, recordCount, batchSizes)
      payload.write = write.results
      // 2) 缓存 -------------------------------------------------------------
      console.log('› 文档向量缓存')
      payload.cache = await benchCache(embedder, corpus, recordCount)
      console.log(`  命中率 ${round(payload.cache.stats.hitRate * 100, 1)}% · 提速 ${payload.cache.speedup}x`)
      // 3) 查询 -------------------------------------------------------------
      console.log('› 查询延迟')
      payload.query = await benchQuery(embedder, corpus.queries.slice(0, queryCount), write.vectors)
      console.log(
        `  冷 P50 ${formatMs(payload.query.cold.p50)} / P95 ${formatMs(payload.query.cold.p95)} · ` +
          `热 P50 ${formatMs(payload.query.warm.p50)}`,
      )
      // 4) 回填 -------------------------------------------------------------
      console.log('› 回填吞吐')
      const backlog = makeCorpus(backfillCount, { dims, seed: seed + 1, queryCount: 1 })
      payload.backfill = await benchBackfill(embedder, backlog.records.map((record) => record.content), backfillBatchSizes)
    } catch (error) {
      notes.push(`嵌入阶段失败已跳过：${error?.message ?? String(error)}`)
      console.error(`  嵌入阶段失败：${error?.message ?? error}`)
    }
  }

  // 5) ANN ------------------------------------------------------------------
  if (!args['skip-ann']) {
    try {
      console.log('› ANN vs 全量')
      payload.ann = await benchAnn(annDims, annSizes, annQueries)
    } catch (error) {
      notes.push(`ANN 压测失败已跳过：${error?.message ?? String(error)}`)
      console.error(`  ANN 压测失败：${error?.message ?? error}`)
    }
  }
  // 压测结果不参与任何断言；sleep 一下让 live 后端的请求彻底收尾（不影响退出码）。
  await sleep(0)

  const markdown = buildMarkdown(payload)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  try {
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, `bench-${stamp}.json`), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    writeFileSync(join(outDir, `bench-${stamp}.md`), `${markdown}\n`, 'utf8')
    console.log(`\n结果已写入 ${outDir}/bench-${stamp}.{json,md}`)
  } catch (error) {
    console.error(`写结果失败（${outDir}）：${error?.message ?? error}`)
  }
  console.log('')
  console.log(markdown)
}

try {
  await main()
} catch (error) {
  // 压测工具永不把 CI/调用方搞红：失败打印后正常退出。
  console.error(`bench 异常退出（已忽略，退出码 0）：${error?.stack ?? error}`)
}
process.exitCode = 0
