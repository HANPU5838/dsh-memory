/**
 * Cross-encoder 重排（HTTP）—— 0.112.0。
 *
 * 与 `rerank.ts` 的 LLM-as-judge 互补，解决的是两个不同的问题：
 *   - **LLM 重排**：能理解"这条和查询到底有没有关系"，但要花 token、1.5s 预算，
 *     还得宿主配好 `ctx.llm`；小库/离线场景经常根本没配。
 *   - **Cross-encoder**：本地小模型（bge-reranker-v2-m3、jina-reranker 等）在
 *     llama.cpp 的 `--rerank` 端点上跑一次前向，就能给每个 (query, doc) 出分。
 *     不占 LLM 配额、不吃 token 预算，延迟通常在几十毫秒量级。
 *
 * 本模块只做「发请求 + 解析 + 归一化 + 融合」四件事，全部是纯函数/可注入 fetch，
 * 单测用假响应即可覆盖。**任何失败都返回 null**，调用方保持召回顺序 —— 重排永远
 * 是增强项，不能成为检索的单点故障。
 *
 * 兼容三种响应形状（字段名不同、结构一致）：
 *   llama.cpp `/v1/rerank` · Cohere rerank · Jina rerank
 *     { "results": [{ "index": 0, "relevance_score": 0.91 }, ...] }
 *   OpenAI 风格的 { "data": [...] } 与裸数组也接受。
 */

/** Cross-encoder 端点配置。endpoint 为空或 enabled=false 时整段跳过。 */
export interface HttpRerankConfig {
  enabled: boolean
  /** 完整 URL；只写 host 时自动补 `/v1/rerank`。 */
  endpoint: string
  /** 传给服务端的模型名；llama.cpp 单模型时留空。 */
  model: string
  /** 可选 Bearer token（托管 Cohere/Jina 时需要）。 */
  apiKey: string
  /** 最多送多少条候选去打分（默认 20，够覆盖 topK×2 的整形余量）。 */
  topN: number
  /** 终态分 = (1-w)×召回分 + w×cross-encoder 分。默认 0.7。 */
  weight: number
  /** 请求超时（默认 2000ms；本地 ARM 上首次前向可能更慢，可按需调大）。 */
  timeoutMs: number
}

export const defaultHttpRerankConfig: HttpRerankConfig = {
  enabled: false,
  endpoint: '',
  model: '',
  apiKey: '',
  topN: 20,
  weight: 0.7,
  timeoutMs: 2000,
}

export interface HttpRerankCandidate {
  id: string
  content: string
  recallScore: number
}

export interface HttpRerankOutcome {
  /** id → 归一化到 [0,1] 的 cross-encoder 分。 */
  scores: Map<string, number>
  /** 实际请求的模型名/端点，供审计与缓存键使用。 */
  model: string
}

export interface HttpRerankOptions {
  cfg: HttpRerankConfig
  query: string
  candidates: HttpRerankCandidate[]
  /** 调用方取消（会话中断）时一并中止。 */
  signal?: AbortSignal
  /** 测试注入；默认用全局 fetch。 */
  fetchImpl?: typeof fetch
}

/**
 * 只写 host 的 endpoint 补成 `/v1/rerank`；显式写了路径就原样使用。
 * 非法 URL 返回空串（调用方据此跳过，不抛）。
 */
export function resolveRerankEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim()
  if (trimmed === '') return ''
  try {
    const url = new URL(trimmed)
    if (url.pathname === '' || url.pathname === '/') url.pathname = '/v1/rerank'
    return url.toString()
  } catch {
    return ''
  }
}

/** 构造请求体。`model` 留空时不发该字段（llama.cpp 单模型端点不认它）。 */
export function buildHttpRerankBody(
  cfg: HttpRerankConfig,
  query: string,
  candidates: HttpRerankCandidate[],
): { model?: string; query: string; documents: string[]; top_n: number } {
  return {
    ...(cfg.model.trim() !== '' ? { model: cfg.model } : {}),
    query,
    documents: candidates.map((candidate) => candidate.content),
    top_n: candidates.length,
  }
}

interface RawRerankItem {
  index?: unknown
  score?: unknown
  relevance_score?: unknown
}

/** 从任意受支持的响应形状里抽出 [{index, score}]；形状不认识就返回空数组。 */
export function extractRawRerankItems(payload: unknown): RawRerankItem[] {
  if (Array.isArray(payload)) return payload.filter((item): item is RawRerankItem => typeof item === 'object' && item !== null)
  if (typeof payload !== 'object' || payload === null) return []
  const record = payload as { results?: unknown; data?: unknown; rerank?: unknown }
  for (const field of [record.results, record.data, record.rerank]) {
    if (Array.isArray(field)) return field.filter((item): item is RawRerankItem => typeof item === 'object' && item !== null)
  }
  return []
}

/**
 * 把任意量纲的分数归一化到 [0,1]。
 *
 * cross-encoder 的原始分可能是 logits（负值、无上界），也可能是已 sigmoid 的
 * 0–1。**全部落在 [0,1] 时原样保留**（信任服务端标定，避免把 0.91/0.88 这种
 * 很窄的分布拉成 1/0）；只要有一个越界就整体 min-max，否则负 logits 会被
 * clamp(0) 抹成一片 0、重排完全失效。
 */
export function normalizeRerankScores(raw: ReadonlyMap<string, number>): Map<string, number> {
  const out = new Map<string, number>()
  if (raw.size === 0) return out
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const value of raw.values()) {
    if (value < min) min = value
    if (value > max) max = value
  }
  const inUnitRange = min >= 0 && max <= 1
  if (inUnitRange) {
    for (const [id, value] of raw) out.set(id, value)
    return out
  }
  const span = max - min
  for (const [id, value] of raw) out.set(id, span <= 0 ? 0.5 : (value - min) / span)
  return out
}

/**
 * 解析响应：按 `index` 映射回候选 id，丢弃越界/非数字/重复的条目。
 * 返回归一化后的分数；一条有效条目都没有时返回空 Map（调用方据此放弃重排）。
 */
export function parseHttpRerankResponse(
  payload: unknown,
  candidates: readonly HttpRerankCandidate[],
): Map<string, number> {
  const items = extractRawRerankItems(payload)
  const raw = new Map<string, number>()
  for (const item of items) {
    const index = typeof item.index === 'number' ? item.index : Number(item.index)
    if (!Number.isInteger(index) || index < 0 || index >= candidates.length) continue
    const candidate = candidates[index]
    if (candidate === undefined) continue
    const value = typeof item.relevance_score === 'number'
      ? item.relevance_score
      : typeof item.score === 'number'
        ? item.score
        : Number(item.relevance_score ?? item.score)
    if (!Number.isFinite(value)) continue
    raw.set(candidate.id, value)
  }
  return normalizeRerankScores(raw)
}

/**
 * 跑一次 cross-encoder 重排。返回 null 表示"这次不重排"：
 * 未启用、没有端点、候选不足 2 条、请求失败、响应不可用，一律降级。
 */
export async function httpRerank(opts: HttpRerankOptions): Promise<HttpRerankOutcome | null> {
  const { cfg, query, candidates } = opts
  if (!cfg.enabled) return null
  const endpoint = resolveRerankEndpoint(cfg.endpoint)
  if (endpoint === '') return null
  if (candidates.length < 2) return null // 一条候选没有可重排的顺序

  const batch = candidates.slice(0, Math.max(2, cfg.topN))
  const body = buildHttpRerankBody(cfg, query, batch)
  const timeout = AbortSignal.timeout(Math.max(1, cfg.timeoutMs))
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') return null

  let response: Response
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.apiKey.trim() !== '' ? { authorization: `Bearer ${cfg.apiKey.trim()}` } : {}),
      },
      body: JSON.stringify(body),
      signal,
    })
  } catch {
    return null // 超时 / 连接拒绝 / 被取消 —— 保持召回顺序
  }

  // 服务端不是 2xx 时 body 可能是错误页，不要去解析它。
  if (!response.ok) return null

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return null
  }

  const scores = parseHttpRerankResponse(payload, batch)
  if (scores.size === 0) return null
  return { scores, model: cfg.model.trim() === '' ? endpoint : `${cfg.model}@${endpoint}` }
}

/** 把 cross-encoder 分融进召回分；没被打分的候选保持召回分不变。 */
export function blendHttpScores(
  candidates: readonly HttpRerankCandidate[],
  scores: ReadonlyMap<string, number>,
  weight: number,
): Array<{ id: string; score: number }> {
  const w = Math.min(1, Math.max(0, weight))
  return candidates.map((candidate) => {
    const reranked = scores.get(candidate.id)
    return {
      id: candidate.id,
      score: reranked === undefined ? candidate.recallScore : (1 - w) * candidate.recallScore + w * reranked,
    }
  })
}
