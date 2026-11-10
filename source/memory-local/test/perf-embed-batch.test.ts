/**
 * 批量嵌入（任务书 §1）的回归测试。
 *
 * 契约：
 *  - 一次请求多条 input，按条数 / 总字符数自动分组；请求数 = ceil(n / batch)；
 *  - 整批因"单条输入问题"（HTTP 400/413/422）失败时自动回退单条，只把坏的那条
 *    标记为失败，同批其它条照常返回（embedBatch 的部分成功语义）；
 *  - 网络/超时/5xx/协议错误不回退（拆单只会重复同一个错误），整批算失败；
 *  - 旧接口 embed() 保持"全成功才返回数组、否则 null"；
 *  - 熔断、60s 告警节流、超时预算、Authorization 头行为不变。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EmbedClient, splitBatchGroups } from '../src/embed.ts'

const ENDPOINT = 'http://127.0.0.1:8078/v1/embeddings'
const MODEL = 'bge-m3-test'
const DIMS = 4

interface RecordedCall {
  url: string
  body: { input?: string[]; model?: string }
  headers: Record<string, string>
}

/** 记录每次 fetch 的假传输层。handler 返回 Response（或抛错模拟网络异常）。 */
function recordingFetch(handler: (body: { input: string[]; model?: string }, call: RecordedCall) => Response | Promise<Response>) {
  const calls: RecordedCall[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const body = init?.body ? (JSON.parse(String(init.body)) as { input?: string[]; model?: string }) : {}
    const call: RecordedCall = { url, body, headers: (init?.headers ?? {}) as Record<string, string> }
    calls.push(call)
    return handler({ input: body.input ?? [], model: body.model }, call)
  }) as typeof fetch
  return { fetch: impl, calls }
}

/** 每个文本映射成一个可辨认的向量（第 0 维 = 文本长度 + 1，其余补零，客户端会归一化）。 */
function openAiResponse(inputs: string[]): Response {
  const data = inputs.map((text) => ({
    embedding: Array.from({ length: DIMS }, (_, i) => (i === 0 ? text.length + 1 : 0)),
  }))
  return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function makeClient(fetchImpl: typeof fetch, maxBatchSize = 32, maxBatchChars = 100_000): EmbedClient {
  return new EmbedClient({
    endpoint: ENDPOINT,
    model: MODEL,
    dims: DIMS,
    timeoutMs: 500,
    fetch: fetchImpl,
    maxBatchSize,
    maxBatchChars,
    log: () => {},
  })
}

test('splitBatchGroups：按条数分组，保留原下标，单条超长文本独占一组', () => {
  const texts = ['a', 'b', 'c', 'd', 'e']
  const bySize = splitBatchGroups(texts, 2, 0)
  assert.deepEqual(bySize.map((group) => group.texts), [['a', 'b'], ['c', 'd'], ['e']])
  assert.deepEqual(bySize.map((group) => group.indexes), [[0, 1], [2, 3], [4]])

  const byChars = splitBatchGroups(['aaaa', 'bbbb', 'cc', 'dddd'], 32, 8)
  assert.deepEqual(byChars.map((group) => group.texts), [['aaaa', 'bbbb'], ['cc', 'dddd']])

  // 单条就超过字符上限：自己独占一组（由单条路径兜底），不会把后面的文本带进来。
  const oversized = splitBatchGroups(['x'.repeat(30), 'y', 'z'], 32, 10)
  assert.deepEqual(oversized.map((group) => group.texts), [['x'.repeat(30)], ['y', 'z']])
})

test('批量：10 条 / batch=4 → 3 次请求，向量按原顺序返回', async () => {
  const { fetch, calls } = recordingFetch(({ input }) => openAiResponse(input))
  const client = makeClient(fetch, 4)
  const texts = Array.from({ length: 10 }, (_, i) => `text-${i}`)
  const out = await client.embedBatch(texts)
  assert.ok(out !== null)
  assert.equal(out!.length, 10)
  assert.equal(calls.length, 3, '应合并成 3 个请求')
  assert.deepEqual(calls.map((call) => call.body.input!.length), [4, 4, 2])
  for (let i = 0; i < texts.length; i++) {
    assert.ok(out![i] instanceof Float32Array)
    assert.equal(out![i]!.length, DIMS)
    // 第 0 维是 1（单位向量）；顺序错误则这里会拿到别的文本的向量长度，看不出区别。
    assert.ok(Math.abs(out![i]![0]! - 1) < 1e-6)
  }
  const stats = client.embedStats
  assert.equal(stats.inputs, 10)
  assert.equal(stats.requests, 3)
  assert.equal(stats.batchRequests, 3)
  assert.equal(stats.failedItems, 0)
  assert.equal(client.isHealthy, true)
})

test('批量部分失败：整批 400 自动回退单条，只坏一条', async () => {
  const { fetch, calls } = recordingFetch(({ input }) => {
    // 单条也 400：模拟"这条文本本身超出模型上下文"，批量/单条都无法嵌入。
    if (input.includes('oversized')) return new Response('input too large', { status: 400 })
    return openAiResponse(input)
  })
  const client = makeClient(fetch, 8)
  const texts = ['alpha', 'oversized', 'gamma', 'delta']
  const out = await client.embedBatch(texts)
  assert.ok(out !== null)
  assert.equal(out!.length, 4)
  assert.equal(out![1], null, '超长的那条应单独失败')
  assert.ok(out![0] instanceof Float32Array)
  assert.ok(out![2] instanceof Float32Array)
  assert.ok(out![3] instanceof Float32Array)
  // 1 次批量失败 + 4 次单条回退
  assert.equal(calls.length, 5, `应回退为单条，实际请求：${calls.length}`)
  const stats = client.embedStats
  assert.equal(stats.fallbackGroups, 1)
  assert.equal(stats.fallbackRequests, 4)
  assert.equal(stats.failedItems, 1)
  assert.equal(client.isHealthy, true, '只坏一条不算后端故障')
})

test('实测 llama-server 形态:HTTP 500 + "input too large" body → 仍按单条输入问题回退', async () => {
  // 真实 llama-server 对超长输入返回 500（不是 400），只按状态码判断会把整批判死。
  const { fetch, calls } = recordingFetch(({ input }) => {
    if (input.some((text) => text.length > 200)) {
      return new Response(
        JSON.stringify({ error: { code: 500, message: 'input (3603 tokens) is too large to process. increase the physical batch size' } }),
        { status: 500 },
      )
    }
    return openAiResponse(input)
  })
  const client = makeClient(fetch, 8)
  const out = await client.embedBatch(['正常短文本', '超长'.repeat(150), '另一条正常'])
  assert.ok(out !== null)
  assert.ok(out![0] instanceof Float32Array, '同批的正常记录必须保住')
  assert.equal(out![1], null, '超长那条单独失败')
  assert.ok(out![2] instanceof Float32Array)
  assert.equal(client.isHealthy, true, '输入超限不是后端故障，不应熔断')
  assert.equal(calls.length, 4, '1 次批量 + 3 次单条回退')
  assert.equal(client.embedStats.fallbackGroups, 1)
})

test('embed() 旧契约：部分失败 → 整体 null（老调用方行为不变）', async () => {
  const { fetch } = recordingFetch(({ input }) =>
    input.includes('boom') ? new Response('bad request', { status: 400 }) : openAiResponse(input),
  )
  const client = makeClient(fetch, 8)
  assert.equal(await client.embed(['ok', 'boom']), null)
})

test('网络异常不回退单条（拆单只会重复同一个错误），并熔断', async () => {
  let calls = 0
  const client = makeClient((async () => {
    calls += 1
    throw new TypeError('fetch failed')
  }) as typeof fetch)
  const out = await client.embedBatch(['a', 'b', 'c'])
  assert.ok(out !== null)
  assert.deepEqual(out, [null, null, null])
  assert.equal(calls, 1, '整体网络错误不应拆成 3 次重试')
  assert.equal(client.isHealthy, false)
  // 熔断打开：紧接着的调用不联网。
  assert.equal(await client.embedBatch(['d']), null)
  assert.equal(calls, 1)
})

test('HTTP 5xx 不回退单条（同属后端故障）', async () => {
  let calls = 0
  const client = makeClient((async () => {
    calls += 1
    return new Response('overloaded', { status: 503 })
  }) as typeof fetch)
  const out = await client.embedBatch(['a', 'b'])
  assert.deepEqual(out, [null, null])
  assert.equal(calls, 1)
  assert.equal(client.isHealthy, false)
})

test('超时：预算耗尽返回 null 项且不抛，告警带"超时"', async () => {
  const warnings: string[] = []
  const client = new EmbedClient({
    endpoint: ENDPOINT,
    model: MODEL,
    dims: DIMS,
    timeoutMs: 20,
    log: (message) => warnings.push(message),
    fetch: ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (signal) {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
        }
      })) as typeof fetch,
  })
  const out = await client.embedBatch(['slow'])
  assert.deepEqual(out, [null])
  assert.equal(client.isHealthy, false)
  assert.ok(warnings.some((message) => message.includes('超时')), warnings.join('\n'))
})

test('响应条数 / 维度不符 → 整批失败并熔断', async () => {
  const short = makeClient(recordingFetch(() =>
    new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3, 4] }] }), { status: 200 }),
  ).fetch, 8)
  assert.deepEqual(await short.embedBatch(['a', 'b']), [null, null])
  assert.equal(short.isHealthy, false)

  const wrongDims = makeClient(recordingFetch(() =>
    new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3] }] }), { status: 200 }),
  ).fetch, 8)
  assert.deepEqual(await wrongDims.embedBatch(['a']), [null])
  assert.equal(wrongDims.isHealthy, false)
})

test('Authorization 只在配置了 apiKey 时发送', async () => {
  const { fetch, calls } = recordingFetch(({ input }) => openAiResponse(input))
  const client = new EmbedClient({ endpoint: ENDPOINT, model: MODEL, dims: DIMS, timeoutMs: 500, fetch })
  await client.embedBatch(['x'])
  assert.equal(calls[0]!.headers.authorization, undefined)

  const authed = new EmbedClient({ endpoint: ENDPOINT, model: MODEL, dims: DIMS, timeoutMs: 500, apiKey: 'sk-test', fetch })
  await authed.embedBatch(['x'])
  assert.equal(calls[1]!.headers.authorization, 'Bearer sk-test')
})

test('空数组：不联网，返回 []', async () => {
  let calls = 0
  const client = makeClient((async () => {
    calls += 1
    return openAiResponse([])
  }) as typeof fetch)
  assert.deepEqual(await client.embedBatch([]), [])
  assert.deepEqual(await client.embed([]), [])
  assert.equal(calls, 0)
})

test('healthCheck：真实探针，熔断中也能确认恢复', async () => {
  let mode: 'ok' | 'fail' = 'fail'
  const { fetch, calls } = recordingFetch(() => (mode === 'ok' ? openAiResponse(['ping']) : new Response('down', { status: 400 })))
  const client = makeClient(fetch)
  assert.equal(await client.embedBatch(['x']).then((out) => out === null || out[0] === null), true)
  const before = calls.length
  mode = 'ok'
  assert.equal(await client.healthCheck(200), true)
  assert.equal(client.isHealthy, true)
  assert.equal(calls.length, before + 1, '探针必须真的发一次请求')
})

test('统计可观测：resetEmbedStats 清零', async () => {
  const { fetch } = recordingFetch(({ input }) => openAiResponse(input))
  const client = makeClient(fetch, 2)
  await client.embedBatch(['a', 'b', 'c'])
  assert.equal(client.embedStats.inputs, 3)
  assert.equal(client.embedStats.requests, 2)
  client.resetEmbedStats()
  assert.equal(client.embedStats.requests, 0)
  assert.equal(client.embedStats.inputs, 0)
})
