/**
 * 本机推理端点自动发现回归。
 *
 * 原则：只探本机、维度必须一致、任何失败都只返回 null（绝不打断启动）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_ENDPOINT_SPECS,
  discoverLocalEndpoint,
  pickEmbeddingModel,
} from '../src/endpoint-discovery.ts'

function fakeFetch(handler: (url: string, init?: RequestInit) => Response | null): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const res = handler(String(input), init)
    if (res === null) throw new Error('connection refused')
    return res
  }) as unknown as typeof fetch
}

test('pickEmbeddingModel：优先与当前模型同名，其次像 embedding 的模型，最后第一个', () => {
  assert.equal(pickEmbeddingModel(['llama3:8b', 'bge-m3:latest'], 'bge-m3'), 'bge-m3:latest')
  assert.equal(pickEmbeddingModel(['llama3:8b', 'nomic-embed-text'], 'unknown-model'), 'nomic-embed-text')
  assert.equal(pickEmbeddingModel(['a', 'b'], 'x'), 'a')
  assert.equal(pickEmbeddingModel([], 'x'), null)
})

test('discoverLocalEndpoint：Ollama 有同模型且维度一致 → 返回可采用的端点', async () => {
  const seen: string[] = []
  const fetchImpl = fakeFetch((url, init) => {
    seen.push(`${init?.method ?? 'GET'} ${url}`)
    if (url === 'http://127.0.0.1:11434/api/tags') {
      return new Response(JSON.stringify({ models: [{ name: 'bge-m3:latest' }, { name: 'llama3:8b' }] }), { status: 200 })
    }
    if (url === 'http://127.0.0.1:11434/api/embeddings') {
      return new Response(JSON.stringify({ embedding: Array(1024).fill(0.01) }), { status: 200 })
    }
    return null
  })
  const found = await discoverLocalEndpoint({ expectedDims: 1024, modelHint: 'bge-m3', fetchImpl, timeoutMs: 200 })
  assert.ok(found !== null)
  assert.equal(found.provider, 'ollama')
  assert.equal(found.endpoint, 'http://127.0.0.1:11434/api/embeddings')
  assert.equal(found.model, 'bge-m3:latest')
  assert.equal(found.dims, 1024)
  assert.ok(seen.some((line) => line.includes('/api/embeddings')), '必须真算一次向量来验证维度')
})

test('discoverLocalEndpoint：维度不一致 → 绝不采用（避免向量空间混用）', async () => {
  const fetchImpl = fakeFetch((url) => {
    if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'bge-m3' }] }), { status: 200 })
    if (url.endsWith('/api/embeddings')) return new Response(JSON.stringify({ embedding: Array(768).fill(0) }), { status: 200 })
    return null
  })
  const found = await discoverLocalEndpoint({ expectedDims: 1024, modelHint: 'bge-m3', fetchImpl, timeoutMs: 200 })
  assert.equal(found, null)
})

test('discoverLocalEndpoint：端口全都不通 → null（不抛、不阻塞启动）', async () => {
  const fetchImpl = fakeFetch(() => null)
  const found = await discoverLocalEndpoint({ expectedDims: 1024, fetchImpl, timeoutMs: 100 })
  assert.equal(found, null)
})

test('默认候选清单只含本机常见端口（不扫外网）', () => {
  for (const spec of DEFAULT_ENDPOINT_SPECS) {
    assert.ok(Number.isInteger(spec.port) && spec.port > 0 && spec.port <= 65535)
    assert.ok(spec.modelsPath.startsWith('/') && spec.embedPath.startsWith('/'))
  }
})
