/**
 * 记忆事件总线（0.31.0）测试。
 *
 * 事件是**旁路**：有宿主 sink 就转发，没有就只做进程内广播；payload 只带元数据
 * （scope / id / kind / 字数 / 去重 / 命中数 / 通道），绝不含记忆正文；订阅者或
 * sink 抛错都不能影响记忆主流程。
 *
 * 最后一组是服务层集成测试：直接验证 index.ts 的三处调用点真的发出了事件，
 * 而且正文没有跟着事件泄露。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MEMORY_EVENT, MemoryEventBus } from '../src/events.ts'
import { LocalMemoryService } from '../src/index.ts'

const PROJECT = 'project:/w'

/** 收集 sink 收到的 (name, payload)。 */
function recorder() {
  const events: { name: string; payload: Record<string, unknown> }[] = []
  const sink = (name: string, payload: unknown) => {
    events.push({ name, payload: payload as Record<string, unknown> })
  }
  return { events, sink }
}

// ------------------------------------------------------------------ 契约

test('事件名与 payload 契约固定', () => {
  assert.deepEqual(MEMORY_EVENT, {
    saved: 'memory/record-saved',
    recalled: 'memory/recalled',
    forgotten: 'memory/record-forgotten',
  })
})

test('sink 收到三条事件，字段与契约一致', () => {
  const { events, sink } = recorder()
  const bus = new MemoryEventBus(sink)
  bus.saved({ scope: 'session:s1', id: 'rec-1', kind: 'fact', chars: 42, deduped: false })
  bus.recalled({ query: '部署 备份', hits: 3, topScopes: ['session:s1', 'global'], vector: true })
  bus.forgotten({ scope: 'session:s1', ids: ['rec-1', 'rec-2'] })

  assert.deepEqual(events.map((e) => e.name), [MEMORY_EVENT.saved, MEMORY_EVENT.recalled, MEMORY_EVENT.forgotten])
  assert.deepEqual(events[0]!.payload, { scope: 'session:s1', id: 'rec-1', kind: 'fact', chars: 42, deduped: false })
  assert.deepEqual(events[1]!.payload, { query: '部署 备份', hits: 3, topScopes: ['session:s1', 'global'], vector: true })
  assert.deepEqual(events[2]!.payload, { scope: 'session:s1', ids: ['rec-1', 'rec-2'] })
})

test('setSink 后三条事件都走宿主出口；setSink(undefined) 退回进程内', () => {
  const bus = new MemoryEventBus()
  const seen: string[] = []
  bus.subscribe((name) => seen.push(name))
  // 没有 sink：进程内订阅照常，不报错。
  bus.saved({ scope: 'global', id: 'a', kind: 'fact', chars: 1, deduped: false })
  assert.deepEqual(seen, [MEMORY_EVENT.saved])

  const { events, sink } = recorder()
  bus.setSink(sink)
  bus.recalled({ query: 'q', hits: 0, topScopes: [], vector: false })
  assert.equal(events.length, 1)

  bus.setSink(undefined)
  bus.forgotten({ scope: 'global', ids: ['a'] })
  assert.equal(events.length, 1, 'setSink(undefined) 之后不再走宿主')
  assert.deepEqual(seen, [MEMORY_EVENT.saved, MEMORY_EVENT.recalled, MEMORY_EVENT.forgotten])
})

// ------------------------------------------------------------------ 安全降级

test('无 sink、无订阅者时 emit 不抛错', () => {
  const bus = new MemoryEventBus()
  assert.doesNotThrow(() => {
    bus.saved({ scope: 'global', id: 'x', kind: 'fact', chars: 0, deduped: true })
    bus.recalled({ query: '', hits: 0, topScopes: [], vector: false })
    bus.forgotten({ scope: 'global', ids: [] })
  })
})

test('监听器抛错不影响 emit，也不影响其他监听器', () => {
  const bus = new MemoryEventBus()
  const ok: string[] = []
  bus.subscribe(() => {
    throw new Error('订阅者自己的错')
  })
  bus.subscribe((name) => ok.push(name))
  assert.doesNotThrow(() => bus.saved({ scope: 'global', id: 'x', kind: 'note', chars: 2, deduped: false }))
  assert.deepEqual(ok, [MEMORY_EVENT.saved], '前一个监听器抛错不能拦住后面的监听器')
})

test('宿主 sink 抛错时 emit 不抛错', () => {
  const bus = new MemoryEventBus(() => {
    throw new Error('宿主事件监听器抛错')
  })
  assert.doesNotThrow(() => bus.recalled({ query: 'q', hits: 1, topScopes: ['global'], vector: true }))
})

// ------------------------------------------------------------------ 订阅 / 取消

test('subscribe 返回取消函数；取消后不再收到事件，重复取消安全', () => {
  const bus = new MemoryEventBus()
  const seen: string[] = []
  const off = bus.subscribe((name) => seen.push(name))
  bus.saved({ scope: 'global', id: '1', kind: 'fact', chars: 1, deduped: false })
  assert.equal(seen.length, 1)

  off()
  off() // 幂等
  bus.forgotten({ scope: 'global', ids: ['1'] })
  assert.equal(seen.length, 1, '取消后不再收到事件')
})

test('多个订阅者互不影响；payload 是快照（订阅者改它不污染别人）', () => {
  const bus = new MemoryEventBus()
  const got: Record<string, unknown>[] = []
  bus.subscribe((_name, payload) => {
    got.push(payload as Record<string, unknown>)
  })
  bus.subscribe((_name, payload) => {
    try {
      ;(payload as Record<string, unknown>).hits = 999
    } catch {
      // 冻结的快照：静默失败也可以
    }
  })
  bus.recalled({ query: 'q', hits: 2, topScopes: ['global'], vector: false })
  assert.equal(got.length, 1)
  assert.equal(got[0]!.hits, 2)
})

// ------------------------------------------------------------------ 服务层集成：三处调用点

test('保存 / 检索 / 删除三处都发事件，且 payload 绝不含正文', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-events-'))
  const bus = new MemoryEventBus()
  const { events, sink } = recorder()
  bus.setSink(sink)
  const svc = new LocalMemoryService({ storeDir: dir, retrieval: { vector: { enabled: false } } })
  svc.setDefaultScope('session')
  svc.setProjectScope(PROJECT)
  svc.setEventBus(bus)
  const content = '部署前必须先备份数据库，回滚时用上一版快照'
  try {
    const record = await svc.save({ content, kind: 'procedure', tags: ['release'] })
    const saved = events.find((e) => e.name === MEMORY_EVENT.saved)
    assert.ok(saved, '保存后必须发 record-saved')
    assert.equal(saved!.payload.id, record.id)
    assert.equal(saved!.payload.scope, record.scope)
    assert.equal(saved!.payload.kind, 'procedure')
    assert.equal(saved!.payload.chars, content.length)
    assert.equal(saved!.payload.deduped, false)
    assert.deepEqual(Object.keys(saved!.payload).sort(), ['chars', 'deduped', 'id', 'kind', 'scope'])

    const hits = await svc.search({ text: '备份数据库', scopes: [record.scope] })
    assert.ok(hits.length >= 1, '词法检索应当命中刚写的记录')
    const recalled = events.find((e) => e.name === MEMORY_EVENT.recalled)
    assert.ok(recalled, '检索后必须发 memory/recalled')
    assert.equal(recalled!.payload.query, '备份数据库')
    assert.equal(recalled!.payload.hits, hits.length)
    assert.equal(recalled!.payload.vector, false, '向量关闭时如实报告')
    assert.deepEqual(recalled!.payload.topScopes, [record.scope])
    assert.deepEqual(Object.keys(recalled!.payload).sort(), ['hits', 'query', 'topScopes', 'vector'])

    const removed = await svc.forget({ id: record.id })
    assert.deepEqual(removed.ids, [record.id])
    const forgotten = events.find((e) => e.name === MEMORY_EVENT.forgotten)
    assert.ok(forgotten, '删除后必须发 record-forgotten')
    assert.equal(forgotten!.payload.scope, record.scope)
    assert.deepEqual(forgotten!.payload.ids, [record.id])
    assert.deepEqual(Object.keys(forgotten!.payload).sort(), ['ids', 'scope'])

    // 三条事件的任何序列化形态里都不能出现正文（或正文片段）。
    for (const event of events) {
      const wire = JSON.stringify(event.payload)
      assert.ok(!wire.includes(content), `${event.name} 的 payload 泄露了正文`)
      assert.ok(!wire.includes('回滚时用上一版快照'), `${event.name} 的 payload 泄露了正文片段`)
    }
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('未注入事件总线时保存 / 检索 / 删除照常工作（默认总线不报错）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-events-'))
  const svc = new LocalMemoryService({ storeDir: dir, retrieval: { vector: { enabled: false } } })
  svc.setDefaultScope('session')
  svc.setProjectScope(PROJECT)
  try {
    const record = await svc.save({ content: '没有事件订阅者的普通一条', kind: 'fact' })
    const hits = await svc.search({ text: '普通一条', scopes: [record.scope] })
    assert.ok(hits.length >= 1)
    const removed = await svc.forget({ id: record.id })
    assert.equal(removed.removed, 1)
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})
