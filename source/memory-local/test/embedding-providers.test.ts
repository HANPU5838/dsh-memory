/**
 * 嵌入后端 Provider 抽象的行为测试：local(local llama-server)/openai/ollama/off。
 *
 * 全部通过注入 fetch 模拟后端，不联网、不依赖任何模型文件：
 *   - 200 成功（协议、模型名、Bearer、L2 归一化、Float32Array）
 *   - 400 失败（返回 null + 熔断 + 带 kind 的 60s 节流告警）
 *   - 网络异常（返回 null，不抛）
 *   - 维度不符（返回 null + 告警）
 *   - ollama 单条循环（每个文本一个 /api/embeddings 请求）
 *   - off 永不联网
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createEmbeddingProvider,
  type EmbeddingProviderKind,
  type EmbeddingProviderOptions,
} from '../src/embedding-providers.ts'

const DIMS = 4
const MODEL = 'bge-m3'
const ENDPOINT = 'http://127.0.0.1:8078/v1/embeddings'

type FetchHandler = (url: string, init: RequestInit) => Response | Promise<Response>

/** 记录每次请求的 fetch 替身。 */
function recordingFetch(handler: FetchHandler): { fetch: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const actual = init ?? {}
    calls.push({ url, init: actual })
    return handler(url, actual)
  }
  return { fetch: impl as unknown as typeof fetch, calls }
}

function options(overrides: Partial<EmbeddingProviderOptions>): EmbeddingProviderOptions {
  return {
    kind: 'local',
    endpoint: ENDPOINT,
    model: MODEL,
    dims: DIMS,
    timeoutMs: 1000,
    writeTimeoutMs: 5000,
    ...overrides,
  }
}

/** 故意给非单位向量：provider 必须自己做 L2 归一化。 */
function vector(index: number): number[] {
  const out = new Array<number>(DIMS).fill(0)
  out[index % DIMS] = 3
  return out
}

function norm(v: Float32Array): number {
  let sum = 0
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!
  return Math.sqrt(sum)
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

function openAiResponse(inputs: string[]): Response {
  return jsonResponse({ data: inputs.map((_, i) => ({ embedding: vector(i) })) })
}

function headersOf(init: RequestInit): Record<string, string> {
  return (init.headers ?? {}) as Record<string, string>
}

function bodyOf(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>
}

function expectWarn(warns: string[], ...needles: string[]): void {
  const hit = warns.some((w) => needles.every((needle) => w.includes(needle)))
  assert.ok(hit, `没有匹配的告警（需要同时包含：${needles.join(' / ')}）；实际告警：\n${warns.join('\n')}`)
}

// ---------------------------------------------------------------------------
// local（复用 EmbedClient）
// ---------------------------------------------------------------------------

test('local: 200 成功 → Float32Array[]，L2 归一化，复用 /v1/embeddings 协议', async () => {
  const { fetch: fakeFetch, calls } = recordingFetch((url, init) => {
    assert.equal(url, ENDPOINT)
    const body = bodyOf(init)
    assert.equal(body.model, MODEL)
    assert.ok(Array.isArray(body.input))
    assert.equal(headersOf(init).authorization, undefined, 'local 不应带 Authorization')
    return openAiResponse(body.input as string[])
  })
  const warns: string[] = []
  const provider = createEmbeddingProvider(options({ fetch: fakeFetch, pooling: 'cls', log: (m) => warns.push(m) }))

  assert.equal(provider.kind, 'local')
  assert.equal(provider.isLocalServer, true)
  assert.deepEqual(provider.identity, { model: MODEL, dims: DIMS, pooling: 'cls' })
  assert.equal(provider.isHealthy, true)

  const out = await provider.embed(['alpha', 'beta'])
  assert.ok(out !== null)
  assert.equal(out.length, 2)
  for (const item of out!) {
    assert.ok(item instanceof Float32Array)
    assert.equal(item.length, DIMS)
    assert.ok(Math.abs(norm(item) - 1) < 1e-6, '向量应已 L2 归一化')
  }
  assert.equal(calls.length, 1, '两条文本应合并在一次请求里')
  assert.equal(warns.length, 0)
})

test('local: 空数组 → []，且不联网', async () => {
  const { fetch: fakeFetch, calls } = recordingFetch(() => openAiResponse([]))
  const provider = createEmbeddingProvider(options({ fetch: fakeFetch }))
  assert.deepEqual(await provider.embed([]), [])
  assert.equal(calls.length, 0)
})

test('local: HTTP 400 → null + 熔断 + 带 kind 的 60s 节流告警', async () => {
  const { fetch: fakeFetch, calls } = recordingFetch(() => new Response('input too large', { status: 400 }))
  const warns: string[] = []
  const provider = createEmbeddingProvider(options({ fetch: fakeFetch, log: (m) => warns.push(m) }))

  assert.equal(await provider.embed(['x']), null)
  assert.equal(provider.isHealthy, false, '失败应标记不健康（熔断）')
  expectWarn(warns, 'embedding-provider:local', 'HTTP 400', 'input too large')

  // markUp 只复位熔断，不清告警节流：同样失败 60s 内不应再打第二条 warn。
  provider.markUp()
  assert.equal(await provider.embed(['x']), null)
  assert.equal(calls.length, 2, 'markUp 后应重新发起请求')
  assert.equal(warns.length, 1, '60s 内重复失败应被节流')
})

test('local: 网络异常 → null（不抛）并告警', async () => {
  const { fetch: fakeFetch } = recordingFetch(() => {
    throw new TypeError('fetch failed')
  })
  const warns: string[] = []
  const provider = createEmbeddingProvider(options({ fetch: fakeFetch, log: (m) => warns.push(m) }))

  const out = await provider.embed(['x'])
  assert.equal(out, null)
  assert.equal(provider.isHealthy, false)
  expectWarn(warns, 'embedding-provider:local', '嵌入请求失败', 'fetch failed')
})

test('local: 维度不符 → null + 告警（模型/后端不匹配）', async () => {
  const { fetch: fakeFetch } = recordingFetch(() => jsonResponse({ data: [{ embedding: [1, 2, 3] }] }))
  const warns: string[] = []
  const provider = createEmbeddingProvider(options({ fetch: fakeFetch, log: (m) => warns.push(m) }))

  assert.equal(await provider.embed(['x']), null)
  assert.equal(provider.isHealthy, false)
  expectWarn(warns, 'embedding-provider:local', '维度不符', String(DIMS))
})

test('local: healthCheck 真实探针（200→true；已熔断也能确认恢复；400→false）', async () => {
  let mode: 'ok' | 'fail' = 'fail'
  const { fetch: fakeFetch, calls } = recordingFetch(() =>
    mode === 'ok' ? openAiResponse(['ping']) : new Response('down', { status: 400 }),
  )
  const warns: string[] = []
  const provider = createEmbeddingProvider(options({ fetch: fakeFetch, log: (m) => warns.push(m) }))

  assert.equal(await provider.embed(['x']), null)
  assert.equal(provider.isHealthy, false)
  assert.equal(calls.length, 1)

  // 熔断打开时 healthCheck 仍应真的发一次探针，并确认恢复。
  mode = 'ok'
  assert.equal(await provider.healthCheck(250), true)
  assert.equal(provider.isHealthy, true)
  assert.equal(calls.length, 2)

  // 再次失败 → false
  mode = 'fail'
  assert.equal(await provider.healthCheck(250), false)
  assert.equal(provider.isHealthy, false)
})

// ---------------------------------------------------------------------------
// openai（同协议 + Bearer）
// ---------------------------------------------------------------------------

test('openai: Bearer 头 + 同一 /v1/embeddings 协议 + 归一化', async () => {
  const { fetch: fakeFetch, calls } = recordingFetch((url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/embeddings')
    assert.equal(headersOf(init).authorization, 'Bearer sk-test-123')
    const body = bodyOf(init)
    assert.equal(body.model, 'text-embedding-3-small')
    return openAiResponse(body.input as string[])
  })
  const provider = createEmbeddingProvider(options({
    kind: 'openai',
    endpoint: 'https://api.openai.com/v1/embeddings',
    model: 'text-embedding-3-small',
    apiKey: 'sk-test-123',
    fetch: fakeFetch,
  }))

  assert.equal(provider.kind, 'openai')
  assert.equal(provider.isLocalServer, false)
  assert.deepEqual(provider.identity, { model: 'text-embedding-3-small', dims: DIMS })

  const out = await provider.embed(['hello'])
  assert.ok(out !== null)
  assert.equal(out!.length, 1)
  assert.ok(Math.abs(norm(out![0]!) - 1) < 1e-6)
  assert.equal(calls.length, 1)
  assert.equal(provider.isHealthy, true)
})

test('openai: HTTP 401 → null + 带 kind 的告警', async () => {
  const { fetch: fakeFetch } = recordingFetch(() => new Response('invalid api key', { status: 401 }))
  const warns: string[] = []
  const provider = createEmbeddingProvider(options({
    kind: 'openai',
    endpoint: 'https://api.openai.com/v1/embeddings',
    model: 'text-embedding-3-small',
    apiKey: 'sk-bad',
    fetch: fakeFetch,
    log: (m) => warns.push(m),
  }))

  assert.equal(await provider.embed(['hello']), null)
  assert.equal(provider.isHealthy, false)
  expectWarn(warns, 'embedding-provider:openai', 'HTTP 401', 'invalid api key')
})

// ---------------------------------------------------------------------------
// ollama（逐条 /api/embeddings）
// ---------------------------------------------------------------------------

test('ollama: 每个文本单独 POST /api/embeddings，串行、归一化', async () => {
  let order = 0
  const prompts: string[] = []
  const { fetch: fakeFetch, calls } = recordingFetch((url, init) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/embeddings')
    const body = bodyOf(init)
    assert.equal(body.model, 'nomic-embed-text')
    prompts.push(body.prompt as string)
    return jsonResponse({ embedding: vector(order++) })
  })
  const provider = createEmbeddingProvider(options({
    kind: 'ollama',
    endpoint: 'http://127.0.0.1:11434/', // 尾斜杠必须被吃掉
    model: 'nomic-embed-text',
    fetch: fakeFetch,
  }))

  assert.equal(provider.kind, 'ollama')
  assert.equal(provider.isLocalServer, false)
  assert.deepEqual(provider.identity, { model: 'nomic-embed-text', dims: DIMS })

  const out = await provider.embed(['one', 'two', 'three'])
  assert.ok(out !== null)
  assert.equal(out!.length, 3)
  assert.deepEqual(prompts, ['one', 'two', 'three'], '应逐条按输入顺序请求')
  assert.equal(calls.length, 3, 'ollama 不支持批量：三条文本 = 三次请求')
  for (const item of out!) assert.ok(Math.abs(norm(item) - 1) < 1e-6)
  assert.equal(provider.isHealthy, true)
})

test('ollama: 单条失败 → 整批 null + 告警 + 熔断后不再发请求', async () => {
  const prompts: string[] = []
  const { fetch: fakeFetch, calls } = recordingFetch((_url, init) => {
    const body = bodyOf(init)
    prompts.push(body.prompt as string)
    if (body.prompt === 'bad') return new Response('model not found', { status: 400 })
    return jsonResponse({ embedding: vector(0) })
  })
  const warns: string[] = []
  const provider = createEmbeddingProvider(options({
    kind: 'ollama',
    endpoint: 'http://127.0.0.1:11434',
    fetch: fakeFetch,
    log: (m) => warns.push(m),
  }))

  assert.equal(await provider.embed(['ok', 'bad', 'never']), null)
  assert.deepEqual(prompts, ['ok', 'bad'], '失败后应立即停止，不再请求剩余文本')
  assert.equal(provider.isHealthy, false)
  expectWarn(warns, 'embedding-provider:ollama', 'HTTP 400', 'model not found')

  // 熔断打开：紧接着的调用不联网。
  assert.equal(await provider.embed(['y']), null)
  assert.equal(calls.length, 2)
})

test('ollama: 维度不符 → null + 告警', async () => {
  const { fetch: fakeFetch } = recordingFetch(() => jsonResponse({ embedding: [1, 2] }))
  const warns: string[] = []
  const provider = createEmbeddingProvider(options({
    kind: 'ollama',
    endpoint: 'http://127.0.0.1:11434',
    fetch: fakeFetch,
    log: (m) => warns.push(m),
  }))

  assert.equal(await provider.embed(['x']), null)
  assert.equal(provider.isHealthy, false)
  expectWarn(warns, 'embedding-provider:ollama', '维度不符', String(DIMS))
})

test('ollama: 网络异常 → null（不抛）', async () => {
  const { fetch: fakeFetch } = recordingFetch(() => {
    throw new TypeError('ECONNREFUSED')
  })
  const warns: string[] = []
  const provider = createEmbeddingProvider(options({
    kind: 'ollama',
    endpoint: 'http://127.0.0.1:11434',
    fetch: fakeFetch,
    log: (m) => warns.push(m),
  }))

  assert.equal(await provider.embed(['x']), null)
  expectWarn(warns, 'embedding-provider:ollama', 'ECONNREFUSED')
})

test('ollama: healthCheck 200→true，500→false', async () => {
  const ok = createEmbeddingProvider(options({
    kind: 'ollama',
    endpoint: 'http://127.0.0.1:11434',
    fetch: recordingFetch(() => jsonResponse({ embedding: vector(0) })).fetch,
  }))
  assert.equal(await ok.healthCheck(250), true)

  const bad = createEmbeddingProvider(options({
    kind: 'ollama',
    endpoint: 'http://127.0.0.1:11434',
    fetch: recordingFetch(() => new Response('boom', { status: 500 })).fetch,
  }))
  assert.equal(await bad.healthCheck(250), false)
  assert.equal(bad.isHealthy, false)
})

// ---------------------------------------------------------------------------
// off（永不联网）
// ---------------------------------------------------------------------------

test('off: 永不联网，embed/healthCheck 恒为 null/false', async () => {
  let calls = 0
  const { fetch: fakeFetch } = recordingFetch(() => {
    calls += 1
    return openAiResponse(['x'])
  })
  const warns: string[] = []
  const provider = createEmbeddingProvider(options({ kind: 'off', fetch: fakeFetch, log: (m) => warns.push(m) }))

  assert.equal(provider.kind, 'off')
  assert.equal(provider.isLocalServer, false)
  assert.equal(provider.isHealthy, false)
  assert.deepEqual(provider.identity, { model: MODEL, dims: DIMS })

  assert.equal(await provider.embed(['x']), null)
  assert.equal(await provider.embed([]), null, 'off 连空数组也返回 null（契约）')
  assert.equal(await provider.healthCheck(), false)
  provider.markUp()
  assert.equal(provider.isHealthy, false, 'off 的 markUp 不应改变状态')
  provider.markDown()
  assert.equal(provider.isHealthy, false)

  assert.equal(calls, 0, 'off 绝不能联网')
  assert.equal(warns.length, 0, 'off 是显式关闭，不应打失败告警')
})

// ---------------------------------------------------------------------------
// 构造
// ---------------------------------------------------------------------------

test('未知 kind → 构造期抛错（不静默退化成词法检索）', () => {
  assert.throws(
    () => createEmbeddingProvider(options({ kind: 'bogus' as EmbeddingProviderKind })),
    /未知的嵌入后端/,
  )
})
