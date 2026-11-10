/**
 * 预热保活（任务书 §4）的回归测试。
 *
 * 契约：
 *  - start() 先 warmup 一次（真的发一次嵌入），随后按 interval 周期探活；
 *  - 探活失败按 2x 指数退避，封顶 maxIntervalMs；恢复成功后复位到基础间隔；
 *  - 成功探针会 markUp（后端恢复后自动结束熔断）；
 *  - stop() 幂等、立即清掉定时器；定时器全部 unref，不会把宿主进程拖住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EmbedKeepAlive, EmbedClient, type WarmupTarget } from '../src/embed.ts'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function unitVector(): Float32Array {
  return Float32Array.from([1, 0, 0, 0])
}

function makeTarget() {
  const state = {
    embedOk: true,
    healthOk: true,
    embedCalls: 0,
    healthCalls: 0,
    markUps: 0,
    lastEmbedOpts: undefined as { timeoutMs?: number } | undefined,
  }
  const target: WarmupTarget & { markUp(): void } = {
    get isHealthy() {
      return state.embedOk
    },
    async embed(texts, _signal, opts) {
      state.embedCalls += 1
      state.lastEmbedOpts = opts
      return state.embedOk ? [unitVector()] : null
    },
    async healthCheck() {
      state.healthCalls += 1
      return state.healthOk
    },
    markUp() {
      state.markUps += 1
    },
  }
  return { state, target }
}

test('warmup：成功/失败都只计数不抛，成功会 markUp', async () => {
  const { state, target } = makeTarget()
  const keeper = new EmbedKeepAlive({ target, log: () => {} })
  assert.equal(await keeper.warmup(), true)
  assert.equal(state.embedCalls, 1)
  assert.equal(keeper.keepAliveStats.warmups, 1)
  assert.equal(keeper.keepAliveStats.warmupFailures, 0)
  assert.ok(keeper.keepAliveStats.lastOkAt > 0)
  assert.equal(state.markUps, 1)
  assert.equal(state.lastEmbedOpts?.timeoutMs, 1500, '默认探针预算 1500ms')

  state.embedOk = false
  assert.equal(await keeper.warmup(), false)
  assert.equal(keeper.keepAliveStats.warmupFailures, 1)
})

test('probe：优先用 healthCheck；没有 healthCheck 时退化为 embed ping', async () => {
  const { state, target } = makeTarget()
  const keeper = new EmbedKeepAlive({ target, log: () => {} })
  assert.equal(await keeper.probe(), true)
  assert.equal(state.healthCalls, 1)
  assert.equal(state.embedCalls, 0)

  state.healthOk = false
  assert.equal(await keeper.probe(), false)
  assert.equal(keeper.keepAliveStats.probeFailures, 1)

  // 去掉 healthCheck → 走 embed
  const bare = makeTarget()
  const bareTarget: WarmupTarget = { isHealthy: true, embed: bare.target.embed }
  const bareKeeper = new EmbedKeepAlive({ target: bareTarget, log: () => {} })
  assert.equal(await bareKeeper.probe(), true)
  assert.equal(bare.state.embedCalls, 1)
})

test('后台循环：失败 2x 退避到上限，stop 后不再探活', async () => {
  const { state, target } = makeTarget()
  state.embedOk = false
  state.healthOk = false
  const keeper = new EmbedKeepAlive({ target, intervalMs: 10, maxIntervalMs: 40, probeTimeoutMs: 50, log: () => {} })
  keeper.start()
  assert.equal(keeper.isRunning, true)
  assert.equal(keeper.keepAliveStats.running, true)
  await sleep(200)
  const running = keeper.keepAliveStats
  assert.equal(running.intervalMs, 40, '退避应到上限')
  assert.ok(running.probes >= 2, `应至少探活两次，实际 ${running.probes}`)
  assert.equal(running.warmupFailures, 1, '首发 warmup 失败只记一次')
  keeper.stop()
  assert.equal(keeper.keepAliveStats.running, false)
  const probesAfterStop = keeper.keepAliveStats.probes
  await sleep(80)
  assert.equal(keeper.keepAliveStats.probes, probesAfterStop, 'stop 之后不应再有探活')
  keeper.stop() // 幂等
})

test('后台循环：后端恢复后自动 markUp 并把间隔复位', async () => {
  const { state, target } = makeTarget()
  state.embedOk = false
  state.healthOk = false
  const keeper = new EmbedKeepAlive({ target, intervalMs: 5, maxIntervalMs: 20, probeTimeoutMs: 50, log: () => {} })
  keeper.start()
  await sleep(120)
  assert.ok(keeper.keepAliveStats.intervalMs > 5, '连续失败应已退避')
  state.healthOk = true
  state.embedOk = true
  await sleep(140)
  assert.equal(keeper.keepAliveStats.intervalMs, 5, '恢复后间隔复位到基础值')
  assert.ok(keeper.keepAliveStats.lastOkAt > 0)
  assert.ok(state.markUps >= 1)
  keeper.stop()
})

test('start 幂等：重复 start 不会起两个循环', async () => {
  const { state, target } = makeTarget()
  const keeper = new EmbedKeepAlive({ target, intervalMs: 1000, log: () => {} })
  keeper.start()
  keeper.start()
  keeper.start()
  await sleep(30)
  assert.equal(keeper.keepAliveStats.warmups, 1, '只应 warmup 一次')
  assert.equal(state.embedCalls, 1)
  keeper.stop()
})

test('maxIntervalMs 小于 intervalMs 时被夹到基础间隔', async () => {
  const { state, target } = makeTarget()
  state.embedOk = false
  const keeper = new EmbedKeepAlive({ target, intervalMs: 50, maxIntervalMs: 10, log: () => {} })
  keeper.start()
  await sleep(80)
  assert.equal(keeper.keepAliveStats.intervalMs, 50)
  keeper.stop()
})

test('EmbedClient 满足 WarmupTarget：warmup 走真实嵌入路径', async () => {
  const client = new EmbedClient({
    endpoint: 'http://127.0.0.1:1/v1/embeddings',
    model: 'm',
    dims: 4,
    timeoutMs: 100,
    log: () => {},
    // 假传输：直接返回合法响应，验证 EmbedClient 可以当 warmup target 用。
    fetch: (async () =>
      new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0, 0] }] }), { status: 200 })) as typeof fetch,
  })
  const keeper = new EmbedKeepAlive({ target: client, probeTimeoutMs: 200, log: () => {} })
  assert.equal(await keeper.warmup(), true)
  assert.equal(await keeper.probe(), true, 'healthCheck 优先，也应成功')
  keeper.start()
  keeper.stop()
})
