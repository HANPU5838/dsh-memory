import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  autoRecallScopes,
  pickQueryText,
  renderRecallBlock,
  hasRecallMessage,
  MemoryInjector,
  defaultInjectConfig,
  type MemoryHit,
} from '../src/inject.ts'
import type { MemoryRecord } from 'dsh-memory'

function hit(content: string, score = 0.8, id = content): MemoryHit {
  const record: MemoryRecord = {
    id,
    scope: 'project:t',
    kind: 'note',
    content,
    tags: [],
    source: { origin: 'explicit', at: 0 },
    createdAt: 0,
    updatedAt: 0,
    lastAccessedAt: 0,
    accessCount: 0,
    importance: 0.5,
  }
  return { record, score }
}

const msg = (role: string, text: string) => ({ role, content: [{ type: 'text', text }] })

test('pickQueryText takes the last user message text', () => {
  const messages = [
    msg('user', '第一条'),
    msg('assistant', '回复'),
    msg('user', '帮我查 postgres 索引'),
  ]
  assert.equal(pickQueryText(messages), '帮我查 postgres 索引')
  assert.equal(pickQueryText([msg('assistant', 'only assistant')]), '')
  assert.equal(pickQueryText([]), '')
})

test('renderRecallBlock respects token budget and topK', () => {
  const cfg = { ...defaultInjectConfig, tokenBudget: 80, topK: 5 }
  const hits = Array.from({ length: 8 }, (_, i) => hit(`记忆 ${i}：${'内容'.repeat(20)}`, 0.9, `id-${i}`))
  const block = renderRecallBlock(hits, cfg)
  assert.ok(block)
  assert.ok(block!.tokens <= 80, `within budget, got ${block!.tokens}`)
  assert.ok(block!.text.includes('memory_get'))
  // topK cap
  const rich = { ...defaultInjectConfig, tokenBudget: 10_000, topK: 3 }
  const block2 = renderRecallBlock(hits, rich)!
  assert.equal(block2.text.split('\n').length - 1, 3)
  // empty hits → null
  assert.equal(renderRecallBlock([], defaultInjectConfig), null)
  // budget smaller than the header alone → 空文本，但保留 omitted 原因给审计
  const tooTight = renderRecallBlock(hits, { ...defaultInjectConfig, tokenBudget: 10 })
  assert.ok(tooTight)
  assert.equal(tooTight!.text, '')
  assert.equal(tooTight!.ids.length, 0)
  assert.ok(tooTight!.omitted.length > 0)
  assert.ok(tooTight!.omitted.every((entry) => entry.reason === 'budget' || entry.reason === 'top_k'))
})

test('0.35.4: renderRecallBlock 的 transform(before-inject) 可改写正文与丢弃记录', () => {
  const cfg = { ...defaultInjectConfig, tokenBudget: 5000, topK: 10 }
  const hits = [
    hit('原始内容甲：正文', 0.9, 'id-a'),
    hit('原始内容乙：正文', 0.8, 'id-b'),
  ]
  let seenSid: string | undefined
  const block = renderRecallBlock(hits, cfg, {
    transform: (records, sid) => {
      seenSid = sid
      return {
        // 改写甲，丢弃乙
        records: [{ ...records[0]!, content: '改写后内容甲：正文' }],
        droppedIds: new Set(['id-b']),
      }
    },
    sessionId: 'session-test',
  })!
  assert.equal(seenSid, 'session-test', 'transform 要能拿到会话 id')
  assert.match(block.text, /改写后内容甲/, '改写后的正文要进上下文')
  assert.doesNotMatch(block.text, /原始内容甲/, '原正文不能漏进去')
  assert.doesNotMatch(block.text, /原始内容乙/, '被丢弃的记录不能进上下文')
  assert.ok(block.omitted.some((entry) => entry.id === 'id-b' && entry.reason === 'hook'), '被丢弃的要计入 hook 省略')
})

test('0.35.4: transform 抛错时记录原样进入上下文（钩子坏掉不吞记忆）', () => {
  const cfg = { ...defaultInjectConfig, tokenBudget: 5000, topK: 10 }
  const hits = [hit('原始内容：正文', 0.9, 'id-x')]
  const block = renderRecallBlock(hits, cfg, {
    transform: () => { throw new Error('钩子崩了') },
  })!
  assert.match(block.text, /原始内容/, '解析失败要原样注入')
})

test('injector returns the recall text for the host to wrap into a real message', async () => {
  const hits = [hit('用户偏好 TypeScript', 0.9)]
  const search = async () => hits
  const injector = new MemoryInjector(search, defaultInjectConfig)
  const input = { messages: [msg('user', '写一个插件')] }
  const decision = { messages: [msg('user', '写一个插件')] }

  const first = await injector.maybeInject(input, decision)
  assert.ok(first, 'first call yields recall text')
  assert.equal(typeof first, 'string')
  assert.ok(first!.includes('用户偏好 TypeScript'))
  // the host builds the message; this layer must never hand back a bare object
  assert.equal(typeof first === 'object', false)

  const second = await injector.maybeInject(input, decision)
  assert.equal(second, undefined, 'identical recall suppressed')

  const changed = { messages: [msg('user', '另一个问题')] }
  const third = await injector.maybeInject(changed, changed)
  // same hits → same rendered block → still suppressed
  assert.equal(third, undefined)
})

test('injector passes through on empty query or search failure', async () => {
  const injector = new MemoryInjector(async () => [hit('x')], defaultInjectConfig)
  assert.equal(await injector.maybeInject({ messages: [] }, { messages: [] }), undefined)
  const failing = new MemoryInjector(async () => { throw new Error('down') }, defaultInjectConfig)
  const input = { messages: [msg('user', 'q')] }
  assert.equal(await failing.maybeInject(input, input), undefined)
})

test('injector respects disabled config and empty hit list', async () => {
  const off = new MemoryInjector(async () => [hit('x')], { ...defaultInjectConfig, enabled: false })
  const input = { messages: [msg('user', 'q')] }
  assert.equal(await off.maybeInject(input, input), undefined)
  const empty = new MemoryInjector(async () => [], defaultInjectConfig)
  assert.equal(await empty.maybeInject(input, input), undefined)
})

test('hasRecallMessage catches a duplicate recall block from a second activation', () => {
  const text = '以下是与此请求可能相关的记忆，供参考（可用 memory_search 核实，用 memory_forget 删除）：\n- 一条记忆'
  const sourced = (role: string, body: string, kind?: string) => ({
    role,
    content: [{ type: 'text', text: body }],
    ...(kind === undefined ? {} : { source: { kind } }),
  })
  // 同一段召回块已经在 decision 里 → 第二次注入必须跳过
  assert.equal(hasRecallMessage([sourced('user', '你好'), sourced('user', text, 'memory')], text), true)
  // 普通用户消息不算
  assert.equal(hasRecallMessage([sourced('user', text, 'user')], text), false)
  // 记忆消息但内容不同 / 角色不是 user → 不算
  assert.equal(hasRecallMessage([sourced('user', '别的块', 'memory')], text), false)
  assert.equal(hasRecallMessage([sourced('assistant', text, 'memory')], text), false)
  assert.equal(hasRecallMessage([], text), false)
})

test('autoRecallScopes 只保留 global + 当前会话 + 当前工作区,排除自定义作用域', () => {
  assert.deepEqual(
    autoRecallScopes(['session:s1', 'project:D:/repo', 'global', 'handbook', 'team']),
    ['session:s1', 'project:D:/repo', 'global'],
  )
  assert.equal(autoRecallScopes(['handbook']), undefined)
  assert.equal(autoRecallScopes(undefined), undefined)
})

test('pickQueryText ignores synthetic memory/runtime user messages', () => {
  const human = { role: 'user', content: [{ type: 'text', text: '真正的人类问题' }], source: { kind: 'user' } }
  const memory = { role: 'user', content: [{ type: 'text', text: '以下是与你这次请求可能相关的记忆摘要：...' }], source: { kind: 'memory' } }
  const time = { role: 'user', content: [{ type: 'text', text: 'Time sampled while preparing...' }], source: { kind: 'time-context' } }
  assert.equal(pickQueryText([human, memory, time]), '真正的人类问题')
  assert.equal(pickQueryText([memory, time]), '')
})

test('0.67.0: 详细召回统计图增强补召回条数（graphExpanded）', async () => {
  const hits: MemoryHit[] = [
    { ...hit('词法直接命中', 0.9, 'id-a') },
    { ...hit('多跳联想回来的记忆', 0.5, 'id-b'), graphExpanded: true } as MemoryHit,
  ]
  const injector = new MemoryInjector(async () => hits, { ...defaultInjectConfig, tokenBudget: 5000, topK: 10 })
  const input = { messages: [msg('user', '查一下部署')] }
  const detailed = await injector.maybeInjectDetailed(input, input)
  assert.ok(detailed, '应有详细结果')
  assert.equal(detailed!.graphExpanded, 1, '候选中的图增强条数要如实上报')
  assert.equal(detailed!.candidates, 2)
})

test('0.69.0: 召回按相对相关度动态分配字数（高相关更长、总预算仍受控）', () => {
  const cfg = { ...defaultInjectConfig, tokenBudget: 10_000, topK: 5 }
  const hits = [
    hit(`高相关记忆：${'甲'.repeat(300)}`, 0.9, 'id-top'),
    hit(`低相关记忆：${'乙'.repeat(300)}`, 0.3, 'id-weak'),
  ]
  const block = renderRecallBlock(hits, cfg, { impression: true, chars: 100 })!
  const lines = block.text.split('\n').slice(1)
  assert.equal(lines.length, 2, '两条都应注入（预算充足）')
  const topLine = lines.find((line) => line.includes('id-top'))!
  const weakLine = lines.find((line) => line.includes('id-weak'))!
  assert.ok(topLine.length > weakLine.length, `高相关行应更长（top=${topLine.length}, weak=${weakLine.length}）`)
  // 下限 48 字：即使相关度很低也不会被截成空行。
  assert.ok(weakLine.length > 48, '低相关记录仍保留下限字数')
  assert.ok(block.tokens <= cfg.tokenBudget, '总预算不超')
  // 同一输入两次渲染逐字相同（确定性）。
  assert.equal(renderRecallBlock(hits, cfg, { impression: true, chars: 100 })!.text, block.text)
})

test('0.70.0: dynamic=false 时回到固定字数（面板可关）', () => {
  const cfg = { ...defaultInjectConfig, tokenBudget: 10_000, topK: 5 }
  const hits = [
    hit(`高相关：${'甲'.repeat(300)}`, 0.9, 'id-a1'),
    hit(`低相关：${'乙'.repeat(300)}`, 0.3, 'id-b2'),
  ]
  const block = renderRecallBlock(hits, cfg, { impression: true, chars: 100, dynamic: false })!
  const lines = block.text.split('\n').slice(1)
  assert.equal(lines.length, 2)
  const lengths = lines.map((line) => line.replace(/^- \w+ /, '').length)
  assert.equal(lengths[0], lengths[1], '关闭动态分配后两条字数一致')
})

test('0.81.0：长记忆召回用 TextRank 摘要保留关键句（不是只截开头）', () => {
  const cfg = { ...defaultInjectConfig, tokenBudget: 10_000, topK: 3 }
  const filler = '背景信息：' + '与问题无关的背景描述。'.repeat(12)
  const content = `${filler}发布前必须先跑 pnpm run verify:all 校验，失败不要重启服务。`
  const hits = [{ ...hit(content, 0.9, 'id-long') }]
  const block = renderRecallBlock(hits, cfg, { impression: true, chars: 70, queryText: 'verify:all 校验' })!
  assert.ok(block.text.includes('verify'), `关键句应被保留（实际 ${block.text}）`)
  assert.ok(block.text.includes('发布前必须先跑'), '关键句应完整出现')
  assert.ok(block.tokens <= cfg.tokenBudget)
})

test('0.83.0：冲突记忆只注入胜者，败者记为省略（reason=conflict）', () => {
  const cfg = { ...defaultInjectConfig, tokenBudget: 5000, topK: 5 }
  const winner = { ...hit('新结论：端口 8080 已改为 8090。', 0.9, 'id-new') }
  winner.record.importance = 0.9
  winner.record.updatedAt = 200
  const loser = { ...hit('旧结论：端口 8080 保持不变。', 0.9, 'id-old') }
  loser.record.importance = 0.3
  loser.record.updatedAt = 100
  winner.record.conflictWith = ['id-old']
  loser.record.conflictWith = ['id-new']
  const block = renderRecallBlock([winner, loser], cfg, { impression: true, chars: 100 })!
  assert.ok(block.text.includes('8090'), '胜者应注入')
  assert.ok(!block.text.includes('保持不变'), '败者不应注入')
  assert.deepEqual(block.omitted, [{ id: 'id-old', reason: 'conflict' }])
  assert.deepEqual(block.ids, ['id-new'])
})
