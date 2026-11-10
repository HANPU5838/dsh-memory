/**
 * 本地重排（任务书 §5）的回归测试。
 *
 * 契约：
 *  - 用第二个 llama-server 的 /v1/chat/completions 做 LLM-as-judge 打分；
 *  - 复用 rerank.ts 的 prompt / 解析 / 每日预算（asInvoke 直接插进现有骨架）；
 *  - 未配置 / 失败 / 超时 / 输出解析不出来 → 一律返回 null，调用方保留原顺序，
 *    绝不抛错、不阻塞；
 *  - 失败熔断 + 指数退避，后端没起来时不会每轮检索都等超时。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LocalReranker, chatCompletionsUrl, parseChatContent } from '../src/rerank-local.ts'
import { DailyBudget, rerank as rerankWithJudge, type RerankCandidate } from '../src/rerank.ts'

const ENDPOINT = 'http://127.0.0.1:8079/v1/chat/completions'
const MODEL = 'qwen3-1.7b'

function chatResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

interface ChatCall {
  url: string
  body: { model?: string; messages?: Array<{ role: string; content: string }>; max_tokens?: number; temperature?: number; stream?: boolean }
  headers: Record<string, string>
}

function recordingFetch(handler: (body: ChatCall['body'], init: RequestInit | undefined) => Response | Promise<Response>) {
  const calls: ChatCall[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const body = init?.body ? (JSON.parse(String(init.body)) as ChatCall['body']) : {}
    const call: ChatCall = { url, body, headers: (init?.headers ?? {}) as Record<string, string> }
    calls.push(call)
    return handler(body, init)
  }) as typeof fetch
  return { fetch: impl, calls }
}

function candidates(): RerankCandidate[] {
  return [
    { id: 'a', content: '候选 A', recallScore: 0.5 },
    { id: 'b', content: '候选 B', recallScore: 0.4 },
    { id: 'c', content: '候选 C', recallScore: 0.3 },
  ]
}

function makeReranker(overrides: Partial<ConstructorParameters<typeof LocalReranker>[0]> = {}) {
  return new LocalReranker({
    endpoint: ENDPOINT,
    model: MODEL,
    timeoutMs: 500,
    log: () => {},
    ...overrides,
  })
}

test('chatCompletionsUrl：base URL / /v1 / 完整 URL / 尾斜杠都能规范化', () => {
  assert.equal(chatCompletionsUrl('http://127.0.0.1:8079'), 'http://127.0.0.1:8079/v1/chat/completions')
  assert.equal(chatCompletionsUrl('http://127.0.0.1:8079/'), 'http://127.0.0.1:8079/v1/chat/completions')
  assert.equal(chatCompletionsUrl('http://127.0.0.1:8079/v1'), 'http://127.0.0.1:8079/v1/chat/completions')
  assert.equal(chatCompletionsUrl('http://127.0.0.1:8079/v1/chat/completions'), 'http://127.0.0.1:8079/v1/chat/completions')
  assert.equal(chatCompletionsUrl('  '), '/v1/chat/completions')
})

test('parseChatContent：兼容 chat completions 与 completions 两种响应形态', () => {
  assert.equal(parseChatContent({ choices: [{ message: { content: 'hi' } }] }), 'hi')
  assert.equal(parseChatContent({ choices: [{ text: 'legacy' }] }), 'legacy')
  assert.equal(parseChatContent({ choices: [] }), null)
  assert.equal(parseChatContent({}), null)
  assert.equal(parseChatContent(null), null)
})

test('未配置 endpoint/model 或 enabled:false：直接 null，不联网', async () => {
  const { fetch, calls } = recordingFetch(() => chatResponse('[]'))
  assert.equal(makeReranker({ endpoint: '', fetch }).isEnabled, false)
  assert.equal(makeReranker({ model: '', fetch }).isEnabled, false)
  assert.equal(await makeReranker({ endpoint: '', fetch }).rerank('查询', candidates()), null)
  assert.equal(await makeReranker({ enabled: false, fetch }).rerank('查询', candidates()), null)
  assert.equal(calls.length, 0)
})

test('重排成功：解析 [[id, score]] 并按时混分', async () => {
  const { fetch, calls } = recordingFetch(() => chatResponse('```json\n[["a", 0.2], ["b", 0.9]]\n```'))
  const reranker = makeReranker({ fetch, weight: 0.6 })
  const outcome = await reranker.rerank('部署回滚', candidates())
  assert.ok(outcome !== null)
  assert.equal(outcome!.scores.get('a'), 0.2)
  assert.equal(outcome!.scores.get('b'), 0.9)
  assert.equal(outcome!.scores.has('c'), false, '模型没打分的候选不伪造分数')

  const blended = await reranker.rerankAndBlend('部署回滚', candidates())
  assert.ok(blended !== null)
  const byId = new Map(blended!.map((entry) => [entry.id, entry.score]))
  assert.ok(Math.abs(byId.get('a')! - (0.4 * 0.5 + 0.6 * 0.2)) < 1e-9)
  assert.ok(Math.abs(byId.get('b')! - (0.4 * 0.4 + 0.6 * 0.9)) < 1e-9)
  assert.ok(Math.abs(byId.get('c')! - 0.3) < 1e-9, '未打分的候选保持原召回分')

  const call = calls[0]!
  assert.equal(call.url, ENDPOINT)
  assert.equal(call.body.model, MODEL)
  assert.equal(call.body.messages?.[0]?.role, 'system')
  assert.ok(call.body.messages?.[1]?.content.includes('部署回滚'))
  assert.equal(call.body.temperature, 0)
  assert.equal(call.body.stream, false)
  assert.equal(call.headers.authorization, undefined, '本地 llama-server 不需要 Bearer')
})

test('apiKey 配置时才发 Authorization', async () => {
  const { fetch, calls } = recordingFetch(() => chatResponse('[["a", 0.5]]'))
  await makeReranker({ fetch, apiKey: 'sk-local' }).rerank('q', candidates())
  assert.equal(calls[0]!.headers.authorization, 'Bearer sk-local')
})

test('asInvoke 与现有 rerank.ts 骨架兼容（直接替换宿主 llm）', async () => {
  const { fetch } = recordingFetch(() => chatResponse('[["a", 1], ["b", 0]]'))
  const reranker = makeReranker({ fetch })
  const outcome = await rerankWithJudge({
    invoke: reranker.asInvoke(),
    cfg: reranker.config,
    query: 'q',
    candidates: candidates(),
    budget: new DailyBudget(100_000),
  })
  assert.ok(outcome !== null)
  assert.equal(outcome!.scores.get('a'), 1)
  assert.equal(outcome!.scores.get('b'), 0)
})

test('HTTP 500 → null（不抛）+ 熔断 + 统计；熔断后不再发请求', async () => {
  const { fetch, calls } = recordingFetch(() => new Response('model not loaded', { status: 500 }))
  const reranker = makeReranker({ fetch })
  assert.equal(await reranker.rerank('q', candidates()), null)
  assert.equal(reranker.isHealthy, false)
  assert.ok(reranker.statsSnapshot.failures >= 1)
  const requestsAfterFailure = calls.length
  assert.equal(await reranker.rerank('q', candidates()), null)
  assert.equal(calls.length, requestsAfterFailure, '熔断打开后应跳过网络')
})

test('网络异常 → null（不抛）', async () => {
  const reranker = makeReranker({
    fetch: (async () => {
      throw new TypeError('ECONNREFUSED')
    }) as typeof fetch,
  })
  assert.equal(await reranker.rerank('q', candidates()), null)
  assert.equal(reranker.isHealthy, false)
})

test('超时 → null（不阻塞检索）', async () => {
  const reranker = makeReranker({
    timeoutMs: 20,
    fetch: ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })) as typeof fetch,
  })
  const startedAt = Date.now()
  assert.equal(await reranker.rerank('q', candidates()), null)
  assert.ok(Date.now() - startedAt < 1000, '超时预算应生效')
  assert.equal(reranker.isHealthy, false)
})

test('输出解析不出分数 → null 且 noOutcome 计数', async () => {
  const { fetch } = recordingFetch(() => chatResponse('我觉得候选 A 很好')) // 没有 JSON 数组
  const reranker = makeReranker({ fetch })
  assert.equal(await reranker.rerank('q', candidates()), null)
  assert.equal(reranker.statsSnapshot.noOutcome, 1)
})

test('每日 token 预算耗尽 → 跳过（不发请求）', async () => {
  const { fetch, calls } = recordingFetch(() => chatResponse('[["a", 0.5]]'))
  const reranker = makeReranker({ fetch })
  assert.equal(await reranker.rerank('q', candidates(), { budget: new DailyBudget(1) }), null)
  assert.equal(calls.length, 0)
})

test('候选少于 2 条：不值得调模型（rerank.ts 骨架直接跳过）', async () => {
  const { fetch, calls } = recordingFetch(() => chatResponse('[["a", 0.5]]'))
  const reranker = makeReranker({ fetch })
  assert.equal(await reranker.rerank('q', [{ id: 'a', content: 'only', recallScore: 0.5 }]), null)
  assert.equal(calls.length, 0)
})

test('healthCheck：200 → true；400 → false（真实探针，能确认恢复）', async () => {
  let ok = false
  const { fetch } = recordingFetch(() => (ok ? chatResponse('ok') : new Response('down', { status: 400 })))
  const reranker = makeReranker({ fetch })
  assert.equal(await reranker.healthCheck(200), false)
  ok = true
  assert.equal(await reranker.healthCheck(200), true)
  assert.equal(reranker.isHealthy, true)
})

test('config 暴露给宿主/面板，enabled 跟随配置', () => {
  const reranker = makeReranker({ enabled: false, weight: 0.75, topN: 8 })
  const config = reranker.config
  assert.equal(config.provider, 'local')
  assert.equal(config.model, MODEL)
  assert.equal(config.enabled, false)
  assert.equal(config.weight, 0.75)
  assert.equal(config.topN, 8)
  assert.equal(reranker.isEnabled, false)
})
