/**
 * 离线检索评测的共享实现（零依赖；直接 import 项目 TS 源码运行）。
 *
 * 设计原则：
 *  1) **用产品里真实的纯函数**，不在评测器里另写一套打分：词法/向量召回、混合权重、
 *     强度排序、floor/dedupe/MMR 全部 import 自 `source/memory-local/src/`。评测器只负责
 *     组装候选、跑矩阵、算指标，以及（重要的）把结果 id 映射回 **group 级标注**。
 *  2) **可复现**：合成集由固定 seed 构造；嵌入可选真实 bge-m3 或确定性合成向量；
 *     所有配置、阈值、依赖模块 hash 都写进报告。
 *  3) **失败不红**：嵌入服务不可用 → 自动退回合成嵌入并注明；公开集下载失败 →
 *     标记「未接入」并继续。脚本退出码恒 0。
 *
 * 唯一没有完全 1:1 复刻产品检索路径的部分（都在报告里注明）：
 *  - 不跑 storage / scope 可见性过滤（语料里没有休眠/墓碑/过期记录）；
 *  - 不跑 LLM 重排与 Rocchio 查询扩展（默认关闭）；
 *  - 不跑 ANN（评测集规模用全量余弦即可，且 ANN 是性能优化不是召回口径）。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { detectDevice, markdownTable, probeLive, round, sleep, syntheticEmbed } from '../bench/lib.mjs'
import { DAY_MS, SYNTHETIC_NOW, buildSyntheticCorpus } from './corpus.mjs'

import {
  buildStats,
  cosine,
  hasStrongHit,
  lexicalScore,
  mmrSelect,
  normalizeInPlace,
  recordScore,
  semanticDedupe,
  tokenize,
} from '../../source/memory-local/src/scoring.ts'
import { adaptiveScopeThreshold, calibrateScore } from '../../source/memory-local/src/retrieval/adapt.ts'
import { evaluate } from '../../source/memory-local/src/retrieval/eval.ts'
import { blendHybrid, hybridWeights, queryProfile } from '../../source/memory-local/src/retrieval/expand.ts'
import { explainCandidate } from '../../source/memory-local/src/retrieval/rank.ts'
import { scopeTier } from '../../source/memory-local/src/scope.ts'

/** 仓库根目录（tools/eval/lib.mjs → ../../）。 */
export const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

// ---------------------------------------------------------------------------
// 时间有效性加权（cognitive/temporal）——可选依赖：导入失败就降级为不加权，
// 不让"别人正在改 cognitive/"这件事把评测脚本搞崩。
// ---------------------------------------------------------------------------

let temporalBoost = () => 1
let temporalProblem = null
try {
  const mod = await import('../../source/memory-local/src/cognitive/temporal.ts')
  temporalBoost = mod.temporalBoost
} catch (error) {
  temporalProblem = `cognitive/temporal.ts 导入失败，本报告未启用时间有效性加权：${error?.message ?? error}`
}

// ---------------------------------------------------------------------------
// BM25 + RRF 词法通道（0.40.0-P0，工作树 WIP 阶段）——同样是可选依赖：
// 模块不存在/还在改就退回经典词法，报告里会写明「未接入对照」。
// ---------------------------------------------------------------------------

let bm25Module = null
let fusionModule = null
let fusionProblem = null
try {
  bm25Module = await import('../../source/memory-local/src/retrieval/bm25.ts')
  fusionModule = await import('../../source/memory-local/src/retrieval/fusion.ts')
} catch (error) {
  bm25Module = null
  fusionModule = null
  fusionProblem = `BM25/RRF 模块导入失败，词法通道对照不可用：${error?.message ?? error}`
}

/** 工作树里 BM25/RRF 可用时为 true。 */
export const FUSION_AVAILABLE = bm25Module !== null && fusionModule !== null

/** BM25/RRF 对照的可用状态（报告里要写明是"没接入"还是"没 merge"）。 */
export function fusionStatus() {
  return { available: FUSION_AVAILABLE, problem: fusionProblem }
}


// ---------------------------------------------------------------------------
// 默认配置：与 0.35.0 产品默认值一致（index.ts 的 retrieval/shaping 配置）
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG = Object.freeze({
  /** 最终返回条数（memory_search 默认 topK=5） */
  topK: 5,
  /** 召回深度：排名后先截断到 recallN，再整形到 topK */
  recallN: 30,
  /** 向量通道的余弦下限（vector.minScore） */
  vectorMinScore: 0.5,
  /** global 作用域的词法门槛 */
  globalThreshold: 0.12,
  /** project/session/custom 作用域的词法门槛 */
  projectThreshold: 0.1,
  /** 只有弱 token 命中时的绝对下限（index.ts REAL_HIT_FLOOR） */
  realHitFloor: 0.25,
  /** recency 半衰期（天） */
  halfLifeDays: 30,
  /** MMR 相关系数 */
  mmrLambda: 0.7,
  /** 同义合并余弦阈值 */
  dedupeThreshold: 0.85,
  /** 强度排序（false = 回退到 0.32 的 recordScore） */
  strengthRanking: true,
  /** 时间有效性加权（validUntil/updatedAt） */
  temporalWeighting: true,
  /** 词法通道：classic = 0.35 的 lexicalScore + 自适应阈值；fusion = 工作树 0.40-P0 的 BM25 + RRF */
  lexicalMode: 'classic',
  /** BM25 参数（与 index.ts 0.40.0-P0 默认值一致） */
  bm25K1: 1.2,
  bm25B: 0.75,
  bm25TagsWeight: 1.5,
  /** RRF 平滑常数与两路权重（与 index.ts 一致） */
  rrfK: 60,
  fusionLexicalWeight: 1,
  fusionVectorWeight: 1,
  /**
   * RRF 融合加成系数：index.ts 里写作 `1 + 0.1 * fusionBonus`（注释写 +20%，代码是 10%，
   * 以代码为准）。工作树仍在迭代，报告里会记录 index.ts 的 hash，合并后重跑对照。
   */
  fusionBonusWeight: 0.1,
})

/** 矩阵开关：strengthRanking / MMR / dedupe / floor 四维全因子，外加一个「产品默认」。 */
const FLAG_COMBOS = [
  ['base', { strengthRanking: false, mmr: false, dedupe: false, floor: 0 }],
  ['+strength', { strengthRanking: true, mmr: false, dedupe: false, floor: 0 }],
  ['+mmr', { strengthRanking: false, mmr: true, dedupe: false, floor: 0 }],
  ['+dedupe', { strengthRanking: false, mmr: false, dedupe: true, floor: 0 }],
  ['+floor', { strengthRanking: false, mmr: false, dedupe: false, floor: 0.2 }],
  ['strength+mmr', { strengthRanking: true, mmr: true, dedupe: false, floor: 0 }],
  ['strength+dedupe', { strengthRanking: true, mmr: false, dedupe: true, floor: 0 }],
  ['strength+floor', { strengthRanking: true, mmr: false, dedupe: false, floor: 0.2 }],
  ['mmr+dedupe', { strengthRanking: false, mmr: true, dedupe: true, floor: 0 }],
  ['mmr+floor', { strengthRanking: false, mmr: true, dedupe: false, floor: 0.2 }],
  ['dedupe+floor', { strengthRanking: false, mmr: false, dedupe: true, floor: 0.2 }],
  ['strength+mmr+dedupe', { strengthRanking: true, mmr: true, dedupe: true, floor: 0 }],
  ['strength+mmr+floor', { strengthRanking: true, mmr: true, dedupe: false, floor: 0.2 }],
  ['strength+dedupe+floor', { strengthRanking: true, mmr: false, dedupe: true, floor: 0.2 }],
  ['mmr+dedupe+floor', { strengthRanking: false, mmr: true, dedupe: true, floor: 0.2 }],
  ['all (product default)', { strengthRanking: true, mmr: true, dedupe: true, floor: 0.2 }],
]

/** 16 组配置，`base` 在最前、产品默认在最后。 */
export const MATRIX_CONFIGS = FLAG_COMBOS.map(([label, flags]) => ({
  label,
  strengthRanking: flags.strengthRanking,
  mmr: flags.mmr,
  dedupe: flags.dedupe,
  floor: flags.floor,
}))

/** 矩阵配置展开成完整检索配置。 */
export function resolveConfig(overrides = {}) {
  const merged = { ...DEFAULT_CONFIG, ...overrides }
  return { ...merged, dedupeThreshold: merged.dedupe ? DEFAULT_CONFIG.dedupeThreshold : 0 }
}

// ---------------------------------------------------------------------------
// 杂项
// ---------------------------------------------------------------------------

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

/** 文本集合的内容指纹（用于嵌入缓存键与报告复现）。 */
export function contentHash(texts) {
  return sha256(texts.join('\u0000')).slice(0, 32)
}

const mean = (values) => (values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length)

const clamp01 = (value) => Math.min(1, Math.max(0, value))

/** `+0.0312` / `-0.0100` 这类带符号差值。 */
export function signed(value, digits = 4) {
  const n = Number.isFinite(value) ? value : 0
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}`
}

/** 3~4 位有效数字的百分比展示。 */
export function pct(value, digits = 1) {
  return `${(value * 100).toFixed(digits)}%`
}

// ---------------------------------------------------------------------------
// 嵌入：真实 bge-m3（/v1/embeddings）或确定性合成向量
// ---------------------------------------------------------------------------

/**
 * 取嵌入。返回 `{ ok, kind, model, dims, vectors, cached, note }` 或
 * `{ ok:false, reason }`（live 模式失败时由调用方决定是否降级）。
 *
 * @param {string[]} texts
 * @param {object} options
 */
export async function loadEmbeddings(texts, options = {}) {
  const opts = {
    mode: 'auto', // auto | live | synthetic
    endpoint: undefined,
    model: 'bge-m3',
    dims: undefined,
    batchSize: 16,
    timeoutMs: 30_000,
    cacheDir: join(repoRoot, 'tools/eval/out/cache'),
    log: () => {},
    ...options,
  }
  // 注意：调用方常把 --endpoint 默认值传成 undefined，不能用 undefined 覆盖掉默认地址。
  opts.endpoint = opts.endpoint ?? process.env.DSH_EVAL_EMBED_ENDPOINT ?? process.env.DSH_BENCH_EMBED_ENDPOINT ?? 'http://127.0.0.1:8078/v1/embeddings'

  if (opts.mode === 'synthetic') {
    return syntheticResult(texts, opts, '按参数要求强制使用合成嵌入')
  }

  const alive = await probeLive(opts.endpoint, 2_500)
  if (!alive) {
    if (opts.mode === 'live') return { ok: false, reason: `嵌入服务不可用：${opts.endpoint}` }
    opts.log('[embed] 嵌入服务不可用 → 退回合成嵌入')
    return syntheticResult(texts, opts, `嵌入服务不可用（${opts.endpoint}），本次数字来自合成嵌入，仅供离线冒烟`)
  }

  const live = await liveEmbeddings(texts, opts)
  if (!live.ok && opts.mode !== 'live') {
    opts.log(`[embed] 真实嵌入失败（${live.reason}）→ 退回合成嵌入`)
    return syntheticResult(texts, opts, `真实嵌入失败（${live.reason}），本次数字来自合成嵌入，仅供离线冒烟`)
  }
  return live
}

function syntheticResult(texts, opts, note) {
  const dims = opts.dims ?? 256
  const vectors = texts.map((text) => syntheticEmbed(text, dims))
  return {
    ok: true,
    kind: 'synthetic',
    model: 'hash-bag-of-words',
    dims,
    vectors,
    cached: false,
    note,
  }
}

async function liveEmbeddings(texts, opts) {
  const dims = opts.dims ?? 1024
  const hash = contentHash(texts)
  const cacheFile = join(opts.cacheDir, `emb-${sha256(`${opts.model}|${dims}|${hash}`).slice(0, 16)}.json`)

  // 缓存：同一份文本 + 同一个模型 → 直接复用，CI 里只付一次嵌入成本。
  if (existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, 'utf8'))
      if (cached?.hash === hash && cached?.model === opts.model && cached?.dims === dims
        && cached?.count === texts.length && Array.isArray(cached?.vectors) && cached.vectors.length === texts.length) {
        return {
          ok: true,
          kind: 'live',
          model: opts.model,
          dims,
          vectors: cached.vectors.map((row) => normalizeInPlace(Float32Array.from(row))),
          cached: true,
          cacheFile,
          note: null,
        }
      }
    } catch {
      /* 缓存损坏 → 重新嵌入 */
    }
  }

  const vectors = []
  const startedAt = Date.now()
  for (let start = 0; start < texts.length; start += opts.batchSize) {
    const batch = texts.slice(start, start + opts.batchSize)
    let rows
    try {
      rows = await embedBatch(batch, opts)
    } catch (error) {
      return { ok: false, reason: `嵌入请求失败（第 ${start}-${start + batch.length} 条）：${error?.message ?? error}` }
    }
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== dims) return { ok: false, reason: `嵌入维度不符（期望 ${dims}，得到 ${row?.length}）` }
      const vector = Float32Array.from(row)
      normalizeInPlace(vector)
      vectors.push(vector)
    }
    opts.log(`[embed] ${Math.min(start + opts.batchSize, texts.length)}/${texts.length}（${((Date.now() - startedAt) / 1000).toFixed(1)}s）`)
  }

  try {
    mkdirSync(opts.cacheDir, { recursive: true })
    const rounded = vectors.map((vector) => Array.from(vector, (value) => Math.round(value * 1e6) / 1e6))
    writeFileSync(cacheFile, JSON.stringify({ model: opts.model, dims, hash, count: texts.length, vectors: rounded }))
    opts.log(`[embed] 缓存写入 ${cacheFile}`)
  } catch (error) {
    opts.log(`[embed] 缓存写入失败（不影响本次结果）：${error?.message ?? error}`)
  }

  return { ok: true, kind: 'live', model: opts.model, dims, vectors, cached: false, cacheFile, note: null }
}

async function embedBatch(batch, opts) {
  let lastError = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(opts.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: opts.model, input: batch }),
        signal: AbortSignal.timeout(opts.timeoutMs),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      const data = json?.data
      if (!Array.isArray(data) || data.length !== batch.length) {
        throw new Error(`返回条数不符（期望 ${batch.length}，得到 ${data?.length}）`)
      }
      data.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      return data.map((item) => item.embedding)
    } catch (error) {
      lastError = error
      if (attempt < 2) await sleep(400 * (attempt + 1))
    }
  }
  throw lastError ?? new Error('未知嵌入错误')
}

// ---------------------------------------------------------------------------
// 检索：用产品纯函数复刻 memory_search 的候选 → 排序 → 整形流程
// ---------------------------------------------------------------------------

/** 预计算语料的词法索引与 id→group 映射。 */
export function prepareIndex(dataset, vectors) {
  const records = dataset.records
  const tokenSets = records.map((record) => new Set(tokenize(`${record.content} ${(record.tags ?? []).join(' ')}`)))
  const stats = buildStats(tokenSets)
  const groupOf = new Map(records.map((record) => [record.id, record.group ?? record.id]))
  const recordById = new Map(records.map((record) => [record.id, record]))
  // BM25 索引只在需要 fusion 对照时才有意义；单 scope 语料 → 一个索引。
  const bm25Index = FUSION_AVAILABLE
    ? bm25Module.buildBm25Docs(
      records.map((record) => ({ id: record.id, content: record.content, tags: record.tags ?? [] })),
      { k1: DEFAULT_CONFIG.bm25K1, b: DEFAULT_CONFIG.bm25B, tagsWeight: DEFAULT_CONFIG.bm25TagsWeight },
    )
    : null
  return { dataset, records, vectors, tokenSets, stats, groupOf, recordById, bm25Index }
}

/**
 * 单条查询的候选集合（与配置无关：门槛/阈值是固定的产品默认值）。
 * 对应 memory_search 的 channel 1（词法）+ channel 2（向量）+ 双通道混合。
 */
export function prepareQueryCandidates(query, index, queryVector, cfg) {
  const queryTokens = tokenize(query.text)
  const candidates = new Map()

  // --- channel 1: lexical（正文 + 标签）---
  for (let i = 0; i < index.records.length; i++) {
    const record = index.records[i]
    const tokenSet = index.tokenSets[i]
    const lex = lexicalScore(queryTokens, tokenSet, index.stats)
    if (lex <= 0) continue
    const scope = record.scope ?? 'project'
    const floor = adaptiveScopeThreshold(query.text, scope, {
      globalThreshold: cfg.globalThreshold,
      projectThreshold: cfg.projectThreshold,
    })
    // 只有弱 token 命中时必须过 REAL_HIT_FLOOR，和线上一致。
    const effective = hasStrongHit(queryTokens, tokenSet) ? floor : Math.max(floor, cfg.realHitFloor)
    if (lex < effective) continue
    const calibrated = calibrateScore(lex, scope)
    candidates.set(record.id, { record, index: i, recallScore: calibrated, lexScore: calibrated, vecScore: undefined })
  }

  // --- channel 2: vector（余弦 ≥ vector.minScore）---
  if (queryVector != null) {
    for (let i = 0; i < index.records.length; i++) {
      const sim = cosine(queryVector, index.vectors[i])
      if (!(sim >= cfg.vectorMinScore)) continue
      const record = index.records[i]
      const existing = candidates.get(record.id)
      if (existing) {
        existing.vecScore = Math.max(existing.vecScore ?? 0, sim)
        continue
      }
      candidates.set(record.id, { record, index: i, recallScore: sim, vecScore: sim })
    }
  }

  // --- 双通道融合：按查询画像动态调权（代码/数字偏词法，自然语言偏向量）---
  const weights = hybridWeights(queryProfile(query.text))
  for (const candidate of candidates.values()) {
    if (candidate.lexScore !== undefined && candidate.vecScore !== undefined) {
      candidate.recallScore = blendHybrid(candidate.lexScore, candidate.vecScore, weights)
    } else if (candidate.lexScore !== undefined) {
      candidate.recallScore = candidate.lexScore
    } else if (candidate.vecScore !== undefined) {
      candidate.recallScore = candidate.vecScore
    }
  }

  // --- 0.40.0-P0 词法通道：BM25 补召回 + RRF 排序加成（复刻 index.ts 3660-3770）---
  // 注意：经典词法（lexicalScore + 自适应阈值）仍是准入门槛；BM25 只补充候选，
  // RRF 只做排序加成（不覆盖相关度），这样 floor/dedupe/MMR 的分数域不变。
  if (cfg.lexicalMode === 'fusion' && FUSION_AVAILABLE && index.bm25Index !== null) {
    const uniqueQueryTokens = [...new Set(queryTokens)]
    const byLexical = [...candidates.values()]
      .filter((candidate) => candidate.lexScore !== undefined)
      .sort((a, b) => (b.lexScore ?? 0) - (a.lexScore ?? 0) || a.record.id.localeCompare(b.record.id))
      .map((candidate) => candidate.record.id)
    const byVector = [...candidates.values()]
      .filter((candidate) => candidate.vecScore !== undefined)
      .sort((a, b) => (b.vecScore ?? 0) - (a.vecScore ?? 0) || a.record.id.localeCompare(b.record.id))
      .map((candidate) => candidate.record.id)

    const bm25Ids = bm25Module.rankByBm25(uniqueQueryTokens, index.bm25Index, cfg.recallN * 2)
      .map((hit) => hit.id)

    // 只靠 BM25 补回来的记录给中等相关度 0.5（能过地板分），排序交给 RRF 加成 + 强度。
    for (const id of bm25Ids) {
      if (candidates.has(id)) continue
      const record = index.recordById.get(id)
      if (record === undefined) continue
      candidates.set(id, {
        record,
        index: index.records.indexOf(record),
        recallScore: 0.5,
        lexScore: undefined,
        vecScore: undefined,
      })
    }

    if (candidates.size > 0) {
      const lexicalList = bm25Ids.length > 0 ? bm25Ids : byLexical
      const lists = [
        { name: 'lexical', ids: lexicalList, weight: cfg.fusionLexicalWeight },
        { name: 'vector', ids: byVector, weight: cfg.fusionVectorWeight },
      ].filter((list) => list.ids.length > 0)
      if (lists.length > 0) {
        const fused = fusionModule.reciprocalRankFusion(lists, {
          k: cfg.rrfK,
          limit: Math.max(cfg.recallN * 3, candidates.size),
        })
        const normalized = fusionModule.normalizeScores(fused.map((hit) => hit.score))
        for (let i = 0; i < fused.length; i++) {
          const candidate = candidates.get(fused[i].id)
          if (candidate === undefined) continue
          candidate.fusionBonus = clamp01(normalized[i] ?? 0)
        }
      }
    }
  }

  return [...candidates.values()]
}

/** 排序 + 结果整形，返回命中的记录 id 序列（≤ topK）。 */
export function rankAndShape(candidates, cfg, index, now) {
  const scoreCache = new Map()
  const scoreOf = (candidate) => {
    const record = candidate.record
    const cached = scoreCache.get(record.id)
    if (cached !== undefined) return cached
    const relevance = clamp01(candidate.recallScore)
    const base = cfg.strengthRanking
      ? explainCandidate({
        id: record.id,
        relevance,
        importance: record.importance,
        content: record.content,
        kind: record.kind,
        accessCount: record.accessCount,
        createdAt: record.createdAt,
        lastUsedAt: record.lastUsedAt,
        superseded: false,
      }, { now, halfLifeDays: cfg.halfLifeDays }).score
      : recordScore(candidate.recallScore, record.importance, record.accessCount, record.lastAccessedAt, {
        now,
        halfLifeDays: cfg.halfLifeDays,
        superseded: false,
      })
    let score = base
    if (cfg.temporalWeighting) {
      const boost = temporalBoost(record, now)
      score = base * (Number.isFinite(boost) ? boost : 1)
    }
    // 0.40.0-P0：RRF 融合加成（只影响排序，不覆盖相关度语义）。
    if (cfg.lexicalMode === 'fusion') score *= 1 + cfg.fusionBonusWeight * (candidate.fusionBonus ?? 0)
    scoreCache.set(record.id, score)
    return score
  }

  // 稳定 tie-break：同分时 session/project/custom/global 分档，再按 id —— 与线上一致。
  const ranked = [...candidates]
    .sort((a, b) => scoreOf(b) - scoreOf(a)
      || scopeTier(a.record.scope ?? 'project') - scopeTier(b.record.scope ?? 'project')
      || a.record.id.localeCompare(b.record.id))
    .slice(0, cfg.recallN)

  let shaped = ranked.map((candidate) => ({
    ...candidate,
    id: candidate.record.id,
    score: scoreOf(candidate),
    vector: index.vectors[candidate.index],
  }))

  // 结果整形：地板分（作用在匹配强度上）→ 同义合并 → MMR 多样性。
  if (cfg.floor > 0) shaped = shaped.filter((hit) => hit.recallScore >= cfg.floor)
  if (cfg.dedupeThreshold > 0 && shaped.length > 1) shaped = semanticDedupe(shaped, cfg.dedupeThreshold).hits
  const pickN = Math.min(shaped.length, cfg.topK)
  shaped = cfg.mmr && shaped.length > 1 ? mmrSelect(shaped, cfg.mmrLambda, pickN) : shaped.slice(0, pickN)

  return shaped.map((hit) => hit.id)
}

// ---------------------------------------------------------------------------
// 矩阵评测
// ---------------------------------------------------------------------------

function metricBundle(evalQueries, extras, k) {
  const report = evaluate(evalQueries, k)
  return {
    recallAtK: round(report.recallAtK, 4),
    mrr: round(report.mrr, 4),
    ndcgAtK: round(report.ndcgAtK, 4),
    /** 返回条目里相关条目的比例（1 = 没有噪声混进来） */
    purity: round(mean(extras.map((row) => row.precision)), 4),
    /** 每条查询平均混进多少条「非相关记录」 */
    noiseSlots: round(mean(extras.map((row) => row.returned - row.hits)), 3),
    /** 每条查询平均空出多少个 topK 名额（floor 砍掉后不补位） */
    emptySlots: round(mean(extras.map((row) => k - row.returned)), 3),
    avgReturned: round(mean(extras.map((row) => row.returned)), 3),
  }
}

/**
 * 跑 16 组配置 × 词法通道（classic / fusion）的完整矩阵。
 *
 * @param {object} dataset {records, queries, now}
 * @param {object} index   prepareIndex()
 * @param {Array<Float32Array>} queryVectors 与 dataset.queries 对齐
 * @param {{k?: number, log?: Function, lexicalModes?: string[]}} options
 */
export function runMatrix(dataset, index, queryVectors, options = {}) {
  const k = options.k ?? DEFAULT_CONFIG.topK
  const log = options.log ?? (() => {})
  const lexicalModes = options.lexicalModes ?? ['classic']
  const types = [...new Set(dataset.queries.map((query) => query.type))]
  const matrices = {}

  for (const lexicalMode of lexicalModes) {
    const preparedConfig = { ...DEFAULT_CONFIG, lexicalMode }
    const prepared = dataset.queries.map((query, i) => ({
      query,
      candidates: prepareQueryCandidates(query, index, queryVectors[i] ?? null, preparedConfig),
    }))
    log(`[matrix] 候选预计算完成：${dataset.queries.length} 条查询（lexical=${lexicalMode}）`)

    const configs = MATRIX_CONFIGS.map((overrides) => {
      const cfg = { ...resolveConfig(overrides), lexicalMode }
      const evalQueries = []
      const extras = []
      const perQuery = []
      for (const { query, candidates } of prepared) {
        const rankedIds = rankAndShape(candidates, cfg, index, dataset.now)
        const rankedGroups = rankedIds.map((id) => index.groupOf.get(id))
        evalQueries.push({ query: query.text, relevant: query.labels, ranked: rankedGroups })
        const labelSet = new Set(query.labels)
        const hits = rankedIds.filter((id) => labelSet.has(index.groupOf.get(id))).length
        const row = {
          returned: rankedIds.length,
          hits,
          precision: rankedIds.length === 0 ? 0 : hits / rankedIds.length,
        }
        extras.push(row)
        // 逐查询明细只给基线/产品默认两个配置留档（16 组全存会让 JSON 膨胀几倍）。
        if (overrides.label === 'base' || overrides.label === 'all (product default)') {
          perQuery.push({
            id: query.id,
            type: query.type,
            labels: query.labels,
            ranked: rankedIds,
            rankedGroups,
            hits,
            returned: rankedIds.length,
          })
        }
      }

      const overall = metricBundle(evalQueries, extras, k)
      const byType = {}
      for (const type of types) {
        const indices = dataset.queries.map((query, i) => (query.type === type ? i : -1)).filter((i) => i >= 0)
        byType[type] = metricBundle(indices.map((i) => evalQueries[i]), indices.map((i) => extras[i]), k)
      }

      log(`[matrix] ${lexicalMode} / ${cfg.label}`)
      return {
        config: {
          label: cfg.label,
          strengthRanking: cfg.strengthRanking,
          mmr: cfg.mmr,
          dedupe: cfg.dedupe,
          floor: cfg.floor,
          lexicalMode,
        },
        overall,
        byType,
        perQuery,
      }
    })

    matrices[lexicalMode] = { k, configs }
  }

  return { k, lexicalModes, matrices }
}

// ---------------------------------------------------------------------------
// 公开集：LoCoMo（可选。网络不通/格式变化 → 返回 skipped，不抛）
// ---------------------------------------------------------------------------

export const LOCOMO_URL = 'https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json'

/** LoCoMo 问题类别（5 = adversarial，无真实答案，直接跳过）。 */
const LOCOMO_CATEGORIES = { 1: 'multi-hop', 2: 'temporal', 3: 'open-domain', 4: 'single-hop' }

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 }

/** 解析 LoCoMo 的 "1:56 pm on 8 May, 2023"；失败返回 undefined。 */
function parseSessionDate(text) {
  if (typeof text !== 'string') return undefined
  const m = /(\d{1,2}):(\d{2})\s*(am|pm)\s+on\s+(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})/i.exec(text)
  if (!m) return undefined
  const hour = (Number(m[1]) % 12) + (m[3].toLowerCase() === 'pm' ? 12 : 0)
  const month = MONTHS[m[5].toLowerCase().slice(0, 3)]
  if (month === undefined) return undefined
  return Date.UTC(Number(m[6]), month, Number(m[4]), hour, Number(m[2]))
}

/**
 * 载入 LoCoMo：优先本地缓存（tools/eval/out/public/），没有就下载。
 * 取一个 conversation 的对话轮次当记忆库、问题当查询、evidence dia_id 当标注。
 * 这是**单会话检索**的近似任务，不是 LoCoMo 官方 QA 评分（报告里会写明）。
 */
export async function loadLocomo(options = {}) {
  const opts = {
    cacheFile: join(repoRoot, 'tools/eval/out/public/locomo10.json'),
    conversation: 0,
    maxQueries: 120,
    timeoutMs: 20_000,
    log: () => {},
    ...options,
  }

  let raw = null
  if (existsSync(opts.cacheFile)) {
    try {
      raw = readFileSync(opts.cacheFile, 'utf8')
    } catch {
      /* 读失败 → 走下载 */
    }
  }
  if (raw === null) {
    try {
      opts.log(`[public] 下载 ${LOCOMO_URL}`)
      const res = await fetch(LOCOMO_URL, { signal: AbortSignal.timeout(opts.timeoutMs) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      raw = await res.text()
      mkdirSync(join(repoRoot, 'tools/eval/out/public'), { recursive: true })
      writeFileSync(opts.cacheFile, raw)
      opts.log(`[public] 已缓存到 ${opts.cacheFile}`)
    } catch (error) {
      return { status: 'skipped', reason: `下载 LoCoMo 失败：${error?.message ?? error}` }
    }
  }

  let data
  try {
    data = JSON.parse(raw)
  } catch (error) {
    return { status: 'skipped', reason: `LoCoMo JSON 解析失败：${error?.message ?? error}` }
  }
  if (!Array.isArray(data) || data.length === 0) return { status: 'skipped', reason: 'LoCoMo 数据格式不符（顶层不是数组）' }

  const conv = data[opts.conversation]
  if (!conv || typeof conv.conversation !== 'object' || !Array.isArray(conv.qa)) {
    return { status: 'skipped', reason: `LoCoMo 第 ${opts.conversation} 个会话缺少 conversation/qa` }
  }

  const sessionKeys = Object.keys(conv.conversation)
    .filter((key) => /^session_\d+$/.test(key))
    .sort((a, b) => Number(a.slice('session_'.length)) - Number(b.slice('session_'.length)))

  const records = []
  let fallbackDate = Date.UTC(2023, 4, 1)
  sessionKeys.forEach((key, sessionIndex) => {
    const turns = conv.conversation[key]
    if (!Array.isArray(turns)) return
    const parsed = parseSessionDate(conv.conversation[`${key}_date_time`])
    const date = parsed ?? fallbackDate + sessionIndex * 7 * DAY_MS
    for (const turn of turns) {
      if (!turn || typeof turn.text !== 'string' || typeof turn.dia_id !== 'string' || turn.text.trim() === '') continue
      records.push({
        id: turn.dia_id,
        group: turn.dia_id,
        content: `${turn.speaker ?? 'unknown'}: ${turn.text}`,
        tags: [],
        scope: 'project',
        kind: 'fact',
        importance: 0.5,
        accessCount: 1,
        createdAt: date,
        updatedAt: date,
        lastAccessedAt: date,
        lastUsedAt: date,
      })
    }
  })
  if (records.length === 0) return { status: 'skipped', reason: 'LoCoMo 会话里没有可用对话轮次' }

  const recordIds = new Set(records.map((record) => record.id))
  const queries = []
  for (const qa of conv.qa) {
    if (!qa || qa.category === 5 || typeof qa.question !== 'string' || qa.question.trim() === '') continue
    const evidence = Array.isArray(qa.evidence) ? [...new Set(qa.evidence.filter((id) => recordIds.has(id)))] : []
    if (evidence.length === 0) continue
    queries.push({
      id: `locomo-c${opts.conversation}-${queries.length + 1}`,
      type: LOCOMO_CATEGORIES[qa.category] ?? `category-${qa.category}`,
      text: qa.question,
      labels: evidence,
    })
    if (queries.length >= opts.maxQueries) break
  }
  if (queries.length === 0) return { status: 'skipped', reason: 'LoCoMo 没有带可定位 evidence 的问题' }

  const now = Math.max(...records.map((record) => record.createdAt)) + DAY_MS
  const byType = {}
  for (const query of queries) byType[query.type] = (byType[query.type] ?? 0) + 1

  return {
    status: 'ok',
    dataset: { records, queries, now, meta: { name: `locomo10-conv${opts.conversation}`, sourceUrl: LOCOMO_URL, conversation: opts.conversation, sampleId: conv.sample_id ?? null, sessions: sessionKeys.length, records: records.length, queries: queries.length, byType } },
  }
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

/** git 快照（只读，不 commit）。 */
function gitSnapshot() {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
    const porcelain = execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).trim()
    return { head, dirty: porcelain !== '', dirtyFiles: porcelain === '' ? [] : porcelain.split('\n').length }
  } catch {
    return { head: null, dirty: null, dirtyFiles: 0 }
  }
}

export function makeReport(parts) {
  return {
    schemaVersion: 1,
    tool: 'tools/eval/run.mjs',
    generatedAt: new Date().toISOString(),
    device: detectDevice(),
    environment: { node: process.version, execArgv: process.execArgv.join(' ') || '(none)' },
    source: gitSnapshot(),
    ...parts,
  }
}

const METRIC_HEADERS = ['配置', 'S', 'M', 'D', 'F', 'recall@5', 'MRR@5', 'nDCG@5', 'purity', '噪声条/查询', '空槽/查询', '返回条数']

/** 取某个词法通道的矩阵；不存在返回 null。 */
export function matrixOf(matrix, mode) {
  return matrix?.matrices?.[mode] ?? null
}

/** 词法通道的展示名（报告里要一眼看出跑的是哪条路径）。 */
const MODE_LABELS = {
  classic: '经典词法（0.35 路径：lexicalScore + 自适应阈值）',
  fusion: 'BM25+RRF（工作树 0.40-P0，WIP 未 merge）',
}

function modeLabel(mode) {
  return MODE_LABELS[mode] ?? mode
}

function matrixRows(matrix) {
  return matrix.configs.map((row) => [
    row.config.label,
    row.config.strengthRanking ? 'on' : 'off',
    row.config.mmr ? 'on' : 'off',
    row.config.dedupe ? 'on' : 'off',
    row.config.floor > 0 ? row.config.floor.toFixed(1) : '0',
    row.overall.recallAtK.toFixed(4),
    row.overall.mrr.toFixed(4),
    row.overall.ndcgAtK.toFixed(4),
    row.overall.purity.toFixed(4),
    row.overall.noiseSlots.toFixed(3),
    row.overall.emptySlots.toFixed(3),
    row.overall.avgReturned.toFixed(2),
  ])
}

function typeRows(matrix, label) {
  const row = matrix.configs.find((entry) => entry.config.label === label)
  if (!row) return []
  return Object.entries(row.byType).map(([type, metrics]) => [
    type,
    metrics.recallAtK.toFixed(4),
    metrics.mrr.toFixed(4),
    metrics.ndcgAtK.toFixed(4),
    metrics.purity.toFixed(4),
    metrics.noiseSlots.toFixed(3),
  ])
}

function findRow(matrix, label) {
  return matrix.configs.find((row) => row.config.label === label)
}

/** 同一配置在 classic / fusion 两条词法路径上的对照（只比 recall/nDCG/purity）。 */
function lexicalComparisonRows(matrix) {
  const [first, second] = matrix.lexicalModes
  if (first === undefined || second === undefined) return []
  const rowsFirst = matrixOf(matrix, first).configs
  const rowsSecond = matrixOf(matrix, second).configs
  const rows = []
  for (let i = 0; i < rowsFirst.length; i++) {
    const a = rowsFirst[i]
    const b = rowsSecond[i]
    if (b === undefined) continue
    rows.push([
      a.config.label,
      a.overall.recallAtK.toFixed(4), b.overall.recallAtK.toFixed(4),
      a.overall.ndcgAtK.toFixed(4), b.overall.ndcgAtK.toFixed(4),
      a.overall.purity.toFixed(4), b.overall.purity.toFixed(4),
    ])
  }
  return rows
}

/** 分查询类型 × 两条词法路径（产品默认配置）。 */
function perTypeComparisonRows(matrix, label) {
  const [first, second] = matrix.lexicalModes
  const rowsFirst = typeRows(matrixOf(matrix, first), label)
  const rowsSecond = second === undefined ? [] : typeRows(matrixOf(matrix, second), label)
  return rowsFirst.map((rowA, i) => {
    const rowB = rowsSecond[i]
    return rowB === undefined
      ? [rowA[0], rowA[1], rowA[2], rowA[3], rowA[4], '—', '—', '—']
      : [rowA[0], rowA[1], rowA[2], rowA[3], rowA[4], rowB[1], rowB[2], rowB[3]]
  })
}

/** 生成 Markdown 报告（docs/benchmark.md 的数字就从这里抄）。 */
export function buildMarkdown(report) {
  const { options, dataset, matrix, publicDataset } = report
  const [primaryMode, secondMode] = matrix.lexicalModes ?? ['classic']
  const primary = matrixOf(matrix, primaryMode)
  const baseline = primary === null ? undefined : findRow(primary, 'base')
  const product = primary === null ? undefined : findRow(primary, 'all (product default)')
  const productSecond = secondMode === undefined || primary === null
    ? null
    : findRow(matrixOf(matrix, secondMode), 'all (product default)')
  const lines = []

  lines.push('# DSH 记忆检索离线基准报告')
  lines.push('')
  lines.push(`> 自动生成：\`${options.command ?? 'node tools/eval/run.mjs'}\` · ${report.generatedAt} · 所有数字来自本次实际运行，不引用他人分数。`)
  lines.push('')

  lines.push('## 运行环境')
  lines.push('')
  lines.push(markdownTable(['项', '值'], [
    ['设备', `${report.device.platform} ${report.device.arch} · ${report.device.cpuModel}`],
    ['CPU 核数 / 内存', `${report.device.cpuCount} / ${report.device.totalMemMB} MB`],
    ['Node', report.environment.node],
    ['嵌入模式', options.mode],
    ['嵌入', `${report.embedding.kind} · ${report.embedding.model} · ${report.embedding.dims}d${report.embedding.cached ? ' · 缓存命中' : ''}`],
    ['词法通道', (matrix.lexicalModes ?? []).map(modeLabel).join(' ／ ')],
    ['BM25/RRF 可用', secondMode === undefined ? '否（只有经典词法）' : '是'],
    ['git HEAD', report.source.head ?? 'unknown'],
    ['index.ts / bm25.ts / fusion.ts hash', ['source/memory-local/src/index.ts', 'source/memory-local/src/retrieval/bm25.ts', 'source/memory-local/src/retrieval/fusion.ts']
      .map((path) => report.sourceModules?.[path] ?? '—').join(' / ')],
    ['工作树干净', report.source.dirty === null ? 'unknown' : report.source.dirty ? `否（${report.source.dirtyFiles} 个文件改动）` : '是'],
  ]))
  lines.push('')

  if (primary === null) {
    lines.push('## 合成评测集（主结果）')
    lines.push('')
    lines.push(`**未完成**：${report.notes.find((note) => note.includes('合成集未能评测')) ?? '嵌入不可用或评测异常'}（详见「局限」）。`)
    lines.push('')
  } else {
    lines.push('## 合成评测集（主结果）')
    lines.push('')
  lines.push(`- 数据集：\`${dataset.name}\`，seed=\`${dataset.seed}\`，${dataset.records} 条记忆 / ${dataset.queries} 条查询（${Object.entries(dataset.byType).map(([type, count]) => `${type} ${count}`).join('、')}）`)
  lines.push(`- 主表词法通道：**${modeLabel(primaryMode)}**；评测深度 k=${matrix.k}（与产品默认 topK 一致）`)
  lines.push('- 标注为 group 级：同一条知识的中/英/同义三条记录命中任意一条即算召回；旧值记录属于独立 group，排到它上面会正常掉分')
  lines.push('- 指标：recall@k / MRR@k / nDCG@k（复用 `retrieval/eval.ts`）；purity = 返回条目中相关占比；噪声条/查询 = 平均混入的非相关条数；空槽 = topK 未填满的名额')
  lines.push('')
  lines.push(markdownTable(METRIC_HEADERS, matrixRows(primary)))
  lines.push('')

  if (secondMode !== undefined) {
    lines.push(`### 词法通道对照：classic vs ${modeLabel(secondMode)}`)
    lines.push('')
    lines.push('BM25 负责补召回（只靠词法阈值进不来的记录），RRF 只做排序加成（`1 + 0.1·bonus`，不覆盖相关度）；其余召回/排序/整形逻辑相同。')
    lines.push('')
    lines.push(markdownTable([
      '配置',
      'classic recall@5', 'fusion recall@5',
      'classic nDCG@5', 'fusion nDCG@5',
      'classic purity', 'fusion purity',
    ], lexicalComparisonRows(matrix)))
    lines.push('')
    if (product !== undefined && productSecond !== null) {
      const r = productSecond.overall
      lines.push(`产品默认配置下：recall@5 ${product.overall.recallAtK.toFixed(4)} → ${r.recallAtK.toFixed(4)}（${signed(r.recallAtK - product.overall.recallAtK)}），nDCG@5 ${product.overall.ndcgAtK.toFixed(4)} → ${r.ndcgAtK.toFixed(4)}（${signed(r.ndcgAtK - product.overall.ndcgAtK)}），purity ${product.overall.purity.toFixed(4)} → ${r.purity.toFixed(4)}（${signed(r.purity - product.overall.purity)}）。`)
      lines.push('')
    }
  }

  lines.push('### 分查询类型（基线 vs 产品默认 · 两种词法通道）')
  lines.push('')
  lines.push(markdownTable(
    ['查询类型', 'classic recall@5', 'classic MRR@5', 'classic nDCG@5', 'classic purity', 'fusion recall@5', 'fusion MRR@5', 'fusion nDCG@5'],
    perTypeComparisonRows(matrix, 'all (product default)'),
  ))
  lines.push('')
  const baseTypes = typeRows(primary, 'base')
  const prodTypes = typeRows(primary, 'all (product default)')
  if (baseTypes.length > 0 && prodTypes.length > 0) {
    lines.push(markdownTable(
      ['查询类型', '基线 recall@5', '产品默认 recall@5', '基线 nDCG@5', '产品默认 nDCG@5', '基线噪声条', '产品默认噪声条'],
      baseTypes.map((rowA, i) => {
        const rowB = prodTypes[i]
        return rowB === undefined
          ? [rowA[0], rowA[1], '—', rowA[3], '—', rowA[5], '—']
          : [rowA[0], rowA[1], rowB[1], rowA[3], rowB[3], rowA[5], rowB[5]]
      }),
    ))
    lines.push('')
  }

  lines.push('## 关键结论（本次运行）')
  lines.push('')
  if (baseline !== undefined && product !== undefined) {
    lines.push(`- **产品默认 vs 裸召回基线（${primaryMode}）**：recall@5 ${baseline.overall.recallAtK.toFixed(4)} → ${product.overall.recallAtK.toFixed(4)}（${signed(product.overall.recallAtK - baseline.overall.recallAtK)}），nDCG@5 ${baseline.overall.ndcgAtK.toFixed(4)} → ${product.overall.ndcgAtK.toFixed(4)}（${signed(product.overall.ndcgAtK - baseline.overall.ndcgAtK)}），purity ${baseline.overall.purity.toFixed(4)} → ${product.overall.purity.toFixed(4)}（${signed(product.overall.purity - baseline.overall.purity)}）。`)
    const floorRow = findRow(primary, '+floor')
    if (floorRow !== undefined) {
      const deltaNoise = floorRow.overall.noiseSlots - baseline.overall.noiseSlots
      const deltaEmpty = floorRow.overall.emptySlots - baseline.overall.emptySlots
      const noop = deltaNoise === 0 && deltaEmpty === 0
        && floorRow.overall.recallAtK === baseline.overall.recallAtK
        && floorRow.overall.ndcgAtK === baseline.overall.ndcgAtK
      lines.push(`- **单独开 floor 0.2**：recall@5 ${signed(floorRow.overall.recallAtK - baseline.overall.recallAtK)}，nDCG@5 ${signed(floorRow.overall.ndcgAtK - baseline.overall.ndcgAtK)}，噪声条 ${baseline.overall.noiseSlots.toFixed(3)} → ${floorRow.overall.noiseSlots.toFixed(3)}（${signed(deltaNoise)}），空槽 ${baseline.overall.emptySlots.toFixed(3)} → ${floorRow.overall.emptySlots.toFixed(3)}（${signed(deltaEmpty)}）。${noop ? '本次 floor 没有任何可砍的条目：向量通道 minScore=0.5 已经先于 floor 过滤，floor=0.2 落在实际分数域的空档里，等于空操作。' : ''}`)
    }
    for (const label of ['+strength', '+mmr', '+dedupe']) {
      const row = findRow(primary, label)
      if (!row) continue
      lines.push(`- **单独开 ${label.slice(1)}**：recall@5 ${baseline.overall.recallAtK.toFixed(4)} → ${row.overall.recallAtK.toFixed(4)}（${signed(row.overall.recallAtK - baseline.overall.recallAtK)}），nDCG@5 ${signed(row.overall.ndcgAtK - baseline.overall.ndcgAtK)}，purity ${signed(row.overall.purity - baseline.overall.purity)}。`)
    }
    const best = [...primary.configs].sort((a, b) => b.overall.ndcgAtK - a.overall.ndcgAtK)[0]
    lines.push(`- **${primaryMode} 下 nDCG@5 最高的配置**：\`${best.config.label}\`（nDCG@5 ${best.overall.ndcgAtK.toFixed(4)}，recall@5 ${best.overall.recallAtK.toFixed(4)}）。`)
    if (productSecond !== null && productSecond !== undefined) {
      const bestSecond = [...matrixOf(matrix, secondMode).configs].sort((a, b) => b.overall.ndcgAtK - a.overall.ndcgAtK)[0]
      lines.push(`- **${secondMode} 下 nDCG@5 最高的配置**：\`${bestSecond.config.label}\`（nDCG@5 ${bestSecond.overall.ndcgAtK.toFixed(4)}，recall@5 ${bestSecond.overall.recallAtK.toFixed(4)}）。`)
    }
  }
  lines.push('')

  }

  lines.push('## 公开集（LoCoMo 子集）')
  lines.push('')
  if (publicDataset.status !== 'ok') {
    lines.push(`**未接入**：${publicDataset.reason}`)
  } else {
    const pub = publicDataset
    const pubModes = pub.matrix.lexicalModes ?? ['classic']
    const pubPrimary = matrixOf(pub.matrix, pubModes[0])
    const pubProduct = pubPrimary === null ? undefined : findRow(pubPrimary, 'all (product default)')
    if (pubPrimary === null) {
      lines.push('**未完成**：公开集嵌入或评测失败。')
    } else {
    lines.push(`- 数据集：\`${pub.dataset.meta.name}\`（sample=${pub.dataset.meta.sampleId ?? 'n/a'}，${pub.dataset.meta.sessions} 个 session），${pub.dataset.meta.records} 条对话轮次 / ${pub.dataset.meta.queries} 条问题（${Object.entries(pub.dataset.meta.byType).map(([type, count]) => `${type} ${count}`).join('、')}）`)
    lines.push(`- 来源：${pub.dataset.meta.sourceUrl}；只用 evidence dia_id 做标注，**不是** LoCoMo 官方 QA 评分口径`)
    lines.push(`- 嵌入：${pub.embedding.kind} · ${pub.embedding.model} · ${pub.embedding.dims}d${pub.embedding.cached ? ' · 缓存命中' : ''}`)
    lines.push('')
    lines.push(markdownTable(METRIC_HEADERS, matrixRows(pubPrimary)))
    lines.push('')
    const pubComparison = lexicalComparisonRows(pub.matrix)
    if (pubComparison.length > 0) {
      lines.push('### 词法通道对照（LoCoMo 子集）')
      lines.push('')
      lines.push(markdownTable([
        '配置',
        'classic recall@5', 'fusion recall@5',
        'classic nDCG@5', 'fusion nDCG@5',
        'classic purity', 'fusion purity',
      ], pubComparison))
      lines.push('')
    }
    lines.push('### 按问题类别（产品默认 · 两种词法通道）')
    lines.push('')
    lines.push(markdownTable(
      ['问题类别', 'classic recall@5', 'classic MRR@5', 'classic nDCG@5', 'classic purity', 'fusion recall@5', 'fusion MRR@5', 'fusion nDCG@5'],
      perTypeComparisonRows(pub.matrix, 'all (product default)'),
    ))
    if (pubProduct !== undefined) {
      lines.push('')
      lines.push(`产品默认在公开子集上（classic）：recall@5 ${pubProduct.overall.recallAtK.toFixed(4)}，MRR@5 ${pubProduct.overall.mrr.toFixed(4)}，nDCG@5 ${pubProduct.overall.ndcgAtK.toFixed(4)}，purity ${pubProduct.overall.purity.toFixed(4)}。`)
    }
    }
  }
  lines.push('')

  lines.push('## 复现')
  lines.push('')
  lines.push('```bash')
  lines.push('# 1) 默认：自动探测 127.0.0.1:8078 的 bge-m3，跑合成集 + LoCoMo 子集（含 BM25/RRF 对照）')
  lines.push('node tools/eval/run.mjs')
  lines.push('')
  lines.push('# 2) 没有嵌入服务也能跑（合成向量，只适合冒烟，不具语义意义）')
  lines.push('node tools/eval/run.mjs --mode synthetic')
  lines.push('')
  lines.push('# 3) 不联网/不跑公开集，只跑合成集')
  lines.push('node tools/eval/run.mjs --no-public')
  lines.push('')
  lines.push('# 4) 只跑经典词法（关掉 BM25/RRF 对照）')
  lines.push('node tools/eval/run.mjs --lexical classic')
  lines.push('')
  lines.push('# 5) 换 seed / 换评测深度 / 换后端')
  lines.push('node tools/eval/run.mjs --seed 7 --k 10 --endpoint http://127.0.0.1:8078/v1/embeddings')
  lines.push('```')
  lines.push('')
  lines.push('结果同时写入 `tools/eval/out/eval-<时间>.json` 与 `.md`（`out/` 已 gitignore），stdout 打印同样的 Markdown。退出码恒为 0：嵌入/网络失败会降级或跳过，不会把 CI 搞红。')
  lines.push('')

  lines.push('## 局限（如实写明）')
  lines.push('')
  for (const note of report.notes) lines.push(`- ${note}`)
  lines.push('')

  return `${lines.join('\n')}\n`
}

/** 生成「同一份报告」的 JSON 版本（本来就是纯对象）。 */
export function buildJson(report) {
  return JSON.stringify(report, null, 2)
}
