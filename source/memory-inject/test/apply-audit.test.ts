/**
 * apply.ts 的审计链路测试。
 *
 * apply.ts 依赖宿主运行时 @deepseek-ai/dsh-llm（createUserMessage）。测试用
 * Node 的 module.registerHooks 把这个包映射成一个最小 stub，从而在不启动 DSH 的
 * 情况下真实跑一遍 pre-step：evaluation → delivery、失败、信号脱敏。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerHooks } from 'node:module'
import { InjectAuditStore } from '../src/audit.ts'
import { memorySaveResultIds } from '../src/signals.ts'
import { defaultInjectSettings } from '../../memory-local/src/inject-settings.ts'

const STUB = 'data:text/javascript,' + encodeURIComponent(`
export function createUserMessage(input) {
  return {
    id: 'msg-' + Math.random().toString(36).slice(2),
    role: 'user',
    content: input.content,
    source: input.source,
  }
}
`)

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-llm') {
      return { url: STUB, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

const { apply, renderPermissionNotice } = await import('../src/apply.ts')

function record(id: string, content: string, tags: string[] = []): Record<string, unknown> {
  return {
    id, scope: 'project:D:/repo', kind: 'procedure', content, tags,
    source: { origin: 'explicit', at: 0 }, createdAt: 0, updatedAt: 1,
    lastAccessedAt: 0, accessCount: 0, importance: 0.8,
  }
}

function setup(options: {
  settings?: Record<string, unknown>
  list?: () => Promise<unknown[]>
  search?: (input: unknown) => Promise<unknown[]>
  listSync?: (input: unknown) => unknown[]
  getByIds?: (ids: string[]) => unknown[]
  sessionState?: Record<string, unknown>
  visibilityNotice?: { config: { level: 'absolute' | 'normal' | 'none'; scopes: Array<{ scope: string }> } | null }
  permissionNotice?: {
    changes?: Array<{ event?: string; scope?: string; permissions?: string[] }>
    grants?: Array<{ scope?: string; permissions?: string[] }>
  }
  visibilityPolicy?: { level: string; scopes: Array<{ scope: string }> }
} = {}) {
  const handlers = new Map<string, (...args: any[]) => unknown>()
  const settings = options.settings ?? defaultInjectSettings
  const memory = {
    injectSettings: () => settings,
    resolveReadScopes: () => ['session:s1', 'project:D:/repo', 'global'],
    supersededIds: () => [],
    search: options.search ?? (async () => []),
    getByIds: options.getByIds,
    list: options.list ?? (async () => []),
    listSync: options.listSync ?? (() => []),
    attachInjectAudit: (_value: unknown) => {},
    takeVisibilityNotice: options.visibilityNotice !== undefined ? () => options.visibilityNotice : undefined,
    takePermissionNotice: options.permissionNotice !== undefined ? () => options.permissionNotice : undefined,
    visibilityPolicy: () => options.visibilityPolicy ?? {
      level: 'normal',
      scopes: [{ scope: 'session:s1' }, { scope: 'project:D:/repo' }, { scope: 'global' }],
    },
  }
  // attachInjectAudit 的真实语义是 provider 保存 sink；这里直接把 sink 暴露给断言。
  const attached = { current: null as InjectAuditStore | null }
  memory.attachInjectAudit = (value: any) => { attached.current = value }
  const sections: any[] = []
  const systemPrompt = { section: (section: unknown) => sections.push(section) }
  const ctx = {
    get: (name: string) => (name === 'memory' ? memory : undefined),
    on: (name: string, fn: (...args: any[]) => unknown) => { handlers.set(name, fn) },
    inject: (_names: string[], callback: (scoped: any) => void) => callback({ systemPrompt }),
  }
  // 默认关闭持久化：测试不往 D:/repo 写运行时状态；持久化用例显式传 sessionState。
  apply(ctx as never, { sessionState: options.sessionState ?? { enabled: false } })
  return { handlers, attached, sections, memory, settings }
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    agent: { session: { id: 's1', header: { cwd: 'D:/repo' } } },
    step: 1,
    messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '准备发布' }] }],
    ...overrides,
  }
}

async function runPreStep(handlers: Map<string, (...args: any[]) => unknown>, decision?: Record<string, unknown>, overrides?: Record<string, unknown>) {
  const handler = handlers.get('agent/pre-step')
  assert.ok(handler)
  return handler!(input(overrides), async () => decision ?? { kind: 'continue', messages: [] })
}

test('pre-step: 可见范围变更 → 统一「记忆权限已更新」通知', async () => {
  const { handlers } = setup({ visibilityNotice: { config: { level: 'normal', scopes: [{ scope: 'session:s1' }, { scope: 'global' }] } } })
  const decision = await runPreStep(handlers) as { messages: any[] }
  assert.equal(decision.messages.length, 1)
  const text = decision.messages[0]?.content?.[0]?.text ?? ''
  assert.ok(text.includes('【记忆权限已更新】'))
  assert.ok(text.includes('session:s1'))
  assert.ok(text.includes('普通限制'))
})

test('pre-step: 授权变更（授予 + 撤销）→ 注入变更与当前授权', async () => {
  const { handlers } = setup({
    permissionNotice: {
      changes: [
        { event: 'granted', scope: 'handbook', permissions: ['read'] },
        { event: 'revoked', scope: 'dsh-pocket', permissions: ['write'] },
      ],
      grants: [{ scope: 'handbook', permissions: ['read'] }],
    },
  })
  const decision = await runPreStep(handlers) as { messages: any[] }
  assert.equal(decision.messages.length, 1)
  const text = decision.messages[0]?.content?.[0]?.text ?? ''
  assert.ok(text.includes('本次授权变更'))
  assert.ok(text.includes('已授予：handbook（只读）'))
  assert.ok(text.includes('已撤销：dsh-pocket（写入 / 删除）'))
  assert.ok(text.includes('当前会话授权：handbook（只读）'))
  assert.ok(text.includes('memory_scopes request'))
})

test('renderPermissionNotice: 恢复默认 + 无授权时文案完整', () => {
  const text = renderPermissionNotice({ visibilityChanged: true, visibility: null, grants: [] })
  assert.ok(text.includes('已恢复默认'))
  assert.ok(text.includes('当前会话授权：（无）'))
})

test('pre-step: 评估事件与 delivery 事件分离，未拿到宿主回执记 unknown', async () => {
  const hit = { record: record('mem-1', '发布前先检查 devcred 凭据', ['release']), score: 0.9 }
  const { handlers, attached } = setup({ search: async () => [hit] })
  const decision = await runPreStep(handlers) as { messages: unknown[] }
  assert.equal(decision.messages.length, 1, '真实追加了一条记忆消息')
  const entries = attached.current!.list()
  const delivery = entries.find((entry) => entry.kind === 'delivery')
  assert.ok(delivery)
  assert.equal(delivery!.delivery?.status, 'unknown')
  assert.equal(delivery!.delivery?.appended, null)
  assert.equal(delivery!.reasonCode, 'prepared')
  assert.ok((delivery!.delivery?.textChars ?? 0) > 0)
  const recall = entries.find((entry) => entry.channel === 'recall' && entry.kind === 'evaluation')
  assert.ok(recall)
  assert.ok(recall!.selected!.newlyAddedIds!.includes('mem-1'))
  assert.ok(recall!.scopes!.includes('project:D:/repo'))
  assert.ok(recall!.limits && recall!.limits.topK === 5)
  assert.equal(recall!.retrieval?.ok, true)
})

test('pre-step: 消息被重复保护拦下时 delivery=suppressed/dedup', async () => {
  const hit = { record: record('mem-1', '发布前先检查 devcred 凭据', ['release']), score: 0.9 }
  const first = setup({ search: async () => [hit] })
  const firstDecision = await runPreStep(first.handlers) as { messages: any[] }
  const memoryMessage = firstDecision.messages[0]
  const second = setup({ search: async () => [hit] })
  const decision = await runPreStep(second.handlers, { kind: 'continue', messages: [memoryMessage] }) as { messages: unknown[] }
  assert.equal(decision.messages.length, 1, '没有追加第二条')
  const delivery = second.attached.current!.list().find((entry) => entry.kind === 'delivery')
  assert.equal(delivery!.delivery?.status, 'suppressed')
  assert.equal(delivery!.delivery?.suppressedBy, 'dedup')
})

test('pre-step: digest 加载失败留下稳定错误码，而不是静默消失', async () => {
  const settings = {
    ...defaultInjectSettings,
    recall: { ...defaultInjectSettings.recall, enabled: false },
    digest: { ...defaultInjectSettings.digest, enabled: true },
    rules: { ...defaultInjectSettings.rules, enabled: false },
    policy: { ...defaultInjectSettings.policy, enabled: false },
    turnEnd: { ...defaultInjectSettings.turnEnd, enabled: false },
  }
  const { handlers, attached } = setup({
    settings,
    list: async () => { throw new Error('down') },
  })
  const decision = await runPreStep(handlers) as { messages: unknown[] }
  assert.equal(decision.messages.length, 0)
  const entries = attached.current!.list()
  const digest = entries.find((entry) => entry.channel === 'digest')
  assert.ok(digest)
  assert.equal(digest!.outcome, 'failed')
  assert.equal(digest!.error?.code, 'source_load_failed')
  const delivery = entries.find((entry) => entry.kind === 'delivery')
  assert.equal(delivery!.delivery?.status, 'not_attempted')
})

test('信号观察: query 在写审计前脱敏', async () => {
  const settings = {
    ...defaultInjectSettings,
    autoRecall: { ...defaultInjectSettings.autoRecall, enabled: true, useMemoryTags: false, tags: ['release'] },
    recall: { ...defaultInjectSettings.recall, enabled: false },
  }
  const { handlers, attached } = setup({ settings })
  const onEvent = handlers.get('session/event')
  assert.ok(onEvent)
  onEvent!({ id: 's1' }, {
    type: 'tool/call',
    data: {
      name: 'ops_bash',
      callId: 'c1',
      arguments: JSON.stringify({ description: '发布 token=abcdefgh12345678' }),
    },
  })
  const signal = attached.current!.list().find((entry) => entry.kind === 'signal')
  assert.ok(signal)
  assert.ok(!(signal!.query?.text ?? '').includes('abcdefgh12345678'))
  assert.equal(signal!.query?.redacted, true)
  assert.ok(signal!.query?.text?.includes('[REDACTED:'))
})

test('工具信号携带 operationId/turn/step，审计可以直接锚回轨迹', async () => {
  const settings = {
    ...defaultInjectSettings,
    autoRecall: { ...defaultInjectSettings.autoRecall, enabled: true, useMemoryTags: false, tags: ['release'] },
    recall: { ...defaultInjectSettings.recall, enabled: false },
  }
  const { handlers, attached } = setup({ settings })
  const onEvent = handlers.get('session/event')
  onEvent!({ id: 's1' }, {
    type: 'tool/call',
    data: {
      name: 'ops_bash', callId: 'call-9', turn: 3, step: 2,
      arguments: JSON.stringify({ description: '发布前检查' }),
    },
  })
  const signal = attached.current!.list().find((entry) => entry.kind === 'signal' && entry.stage === 'signal_queued')
  assert.ok(signal)
  assert.equal(signal!.operationId, 'call-9')
  assert.equal(signal!.turn, 3)
  assert.equal(signal!.step, 2)
  assert.equal(signal!.signal?.callId, 'call-9')
})

test('记忆工具调用即使自动召回关闭也留一条轨迹锚点', () => {
  const settings = {
    ...defaultInjectSettings,
    autoRecall: { ...defaultInjectSettings.autoRecall, enabled: false },
  }
  const { handlers, attached } = setup({ settings })
  const onEvent = handlers.get('session/event')
  onEvent!({ id: 's1' }, {
    type: 'tool/call',
    data: { name: 'memory_search', callId: 'call-mem', turn: 2, step: 4, arguments: '{}' },
  })
  const entry = attached.current!.list().find((candidate) => candidate.stage === 'tool_call')
  assert.ok(entry, '记忆工具调用本身应被记录')
  assert.equal(entry!.operationId, 'call-mem')
  assert.equal(entry!.trigger, 'memory_tool')
  assert.equal(entry!.turn, 2)
  assert.equal(entry!.step, 4)
  assert.equal(entry!.signal?.callId, 'call-mem')
})

test('记忆工具和没有 description 的工具不触发高风险召回信号', () => {
  const settings = {
    ...defaultInjectSettings,
    autoRecall: { ...defaultInjectSettings.autoRecall, enabled: true, useMemoryTags: false, tags: ['release', 'memory'] },
    recall: { ...defaultInjectSettings.recall, enabled: false },
  }
  const { handlers, attached } = setup({ settings })
  const onEvent = handlers.get('session/event')
  assert.ok(onEvent)
  // memory_search 的参数里有 release/memory，但它本身就是取记忆，不能再触发一次召回。
  onEvent!({ id: 's1' }, {
    type: 'tool/call',
    data: {
      name: 'memory_search', callId: 'call-mem', turn: 1, step: 1,
      arguments: JSON.stringify({ query: 'release memory 发布', topK: 5 }),
    },
  })
  // 其它没有 description 字段的工具同样不触发。
  onEvent!({ id: 's1' }, {
    type: 'tool/call',
    data: { name: 'write', callId: 'call-write', turn: 1, step: 2, arguments: JSON.stringify({ path: 'x', content: 'npm publish' }) },
  })
  onEvent!({ id: 's1' }, {
    type: 'tool/call',
    data: { name: 'ops_bash', callId: 'call-bash', turn: 1, step: 3, arguments: JSON.stringify({ command: 'npm publish' }) },
  })
  const entries = attached.current!.list()
  assert.equal(entries.filter((entry) => entry.kind === 'signal' && entry.stage === 'signal_queued').length, 0, '没有 description 的调用不排队信号')
  const anchor = entries.find((entry) => entry.stage === 'tool_call')
  assert.ok(anchor, 'memory_search 仍保留轨迹锚点')
  assert.equal(anchor!.operationId, 'call-mem')
})

test('memory_block 也被当成记忆工具：留轨迹锚点、不因参数里的标签触发高风险召回', () => {
  const settings = {
    ...defaultInjectSettings,
    autoRecall: { ...defaultInjectSettings.autoRecall, enabled: true, useMemoryTags: false, tags: ['release', 'memory'] },
    recall: { ...defaultInjectSettings.recall, enabled: false },
  }
  const { handlers, attached } = setup({ settings })
  const onEvent = handlers.get('session/event')
  assert.ok(onEvent)
  // memory_block 的 reason/description 里可能恰好出现标签词（"与 release 流程无关"），
  // 它是降噪动作而不是任务行为，不能反过来再触发一次召回。
  onEvent!({ id: 's1' }, {
    type: 'tool/call',
    data: {
      name: 'memory_block', callId: 'call-block', turn: 1, step: 2,
      arguments: JSON.stringify({ id: 'abcdef12', reason: '与 release 流程无关', description: '屏蔽无关的 memory 发布记忆' }),
    },
  })
  const entries = attached.current!.list()
  assert.equal(entries.filter((entry) => entry.kind === 'signal' && entry.stage === 'signal_queued').length, 0)
  const anchor = entries.find((entry) => entry.stage === 'tool_call')
  assert.ok(anchor, 'memory_block 也要有轨迹锚点')
  assert.equal(anchor!.operationId, 'call-block')
})

test('同一轮最多一次 signal 召回:第二个信号只落 drop 审计,不再检索', async () => {
  const settings = {
    ...defaultInjectSettings,
    autoRecall: { ...defaultInjectSettings.autoRecall, enabled: true, useMemoryTags: false, tags: ['release', 'deploy'] },
    recall: { ...defaultInjectSettings.recall, enabled: true },
    digest: { ...defaultInjectSettings.digest, enabled: false },
    rules: { ...defaultInjectSettings.rules, enabled: false },
    policy: { ...defaultInjectSettings.policy, enabled: false },
  }
  let searches = 0
  const hit = { record: record('mem-sig', '发布前先检查凭据', ['release']), score: 0.9 }
  const { handlers, attached } = setup({
    settings,
    search: async () => { searches += 1; return [hit] },
  })
  const onEvent = handlers.get('session/event')!
  onEvent({ id: 's1' }, {
    type: 'tool/call',
    data: { name: 'ops_bash', callId: 'c1', turn: 1, step: 1, arguments: JSON.stringify({ description: '准备发布' }) },
  })
  await runPreStep(handlers, undefined, { turn: 1, step: 1 })
  assert.equal(searches, 1)

  onEvent({ id: 's1' }, {
    type: 'tool/call',
    data: { name: 'ops_bash', callId: 'c2', turn: 1, step: 2, arguments: JSON.stringify({ description: '部署第二个环境' }) },
  })
  await runPreStep(handlers, undefined, { turn: 1, step: 2 })
  assert.equal(searches, 1, '同一轮第二个信号不能再次检索;普通召回也因同一 query 去重')
  const dropped = attached.current!.list().find((entry) => entry.stage === 'signal_dropped')
  assert.ok(dropped)
  assert.ok(['same_tag', 'same_query', 'turn_capped'].includes(dropped!.reasonCode ?? ''))
})

test('规则正文写进会话注入状态后,recall 不再重复注入同一条规则', async () => {
  const settings = {
    ...defaultInjectSettings,
    autoRecall: { ...defaultInjectSettings.autoRecall, enabled: false },
    recall: { ...defaultInjectSettings.recall, enabled: true },
    digest: { ...defaultInjectSettings.digest, enabled: false },
    rules: { ...defaultInjectSettings.rules, enabled: true },
    policy: { ...defaultInjectSettings.policy, enabled: false },
    turnEnd: { ...defaultInjectSettings.turnEnd, enabled: false },
  }
  const rule = { ...record('rule-1', '发布前必须检查凭据', ['release']), kind: 'rule' }
  const { handlers, attached } = setup({
    settings,
    listSync: (query) => (query as { kind?: string }).kind === 'rule' ? [rule] : [],
    search: async () => [{ record: rule, score: 0.9 }],
  })
  const decision = await runPreStep(handlers, undefined, { turn: 1, step: 1 }) as { messages: unknown[] }
  assert.equal(decision.messages.length, 0, '规则只应在系统提示里出现一次')
  const recall = attached.current!.list().find((entry) => entry.channel === 'recall' && entry.kind === 'evaluation')
  assert.ok(recall)
  assert.ok((recall!.dedup?.skipped ?? 0) >= 1)
  assert.deepEqual(recall!.selected?.newlyAddedIds ?? [], [])
})

test('系统提示流程索引:当前工作区 + 本轮查询命中的 procedure 才会出现', async () => {
  const settings = {
    ...defaultInjectSettings,
    autoRecall: { ...defaultInjectSettings.autoRecall, enabled: false },
    recall: { ...defaultInjectSettings.recall, enabled: false },
    digest: { ...defaultInjectSettings.digest, enabled: false },
    rules: { ...defaultInjectSettings.rules, enabled: false },
    policy: { ...defaultInjectSettings.policy, enabled: false },
    turnEnd: { ...defaultInjectSettings.turnEnd, enabled: false },
    procedures: { ...defaultInjectSettings.procedures, enabled: true },
  }
  const local = record('local-proc', '本仓库发布流程', [])
  const global = record('global-proc', 'npm 发布前先检查凭据', ['publish'])
  const unrelated = { ...record('other-proc', 'k8s 部署流程', ['kubectl']), scope: 'global' }
  const { handlers, sections } = setup({
    settings,
    listSync: (query) => (query as { kind?: string }).kind === 'procedure' ? [local, global, unrelated] : [],
  })
  await runPreStep(handlers, undefined, { turn: 1, step: 1 })
  const section = sections.find((entry) => entry.name === 'memory:procedures')
  assert.ok(section)
  const text = section.text({ agent: { session: { id: 's1', header: { cwd: 'D:/repo' } } } }) as string
  assert.ok(text.includes('local-proc'.slice(0, 8)), '当前工作区流程不需要触发词')
  assert.ok(text.includes('global-proc'.slice(0, 8)), '查询命中 publish 别名“发布”')
  assert.ok(!text.includes('other-proc'.slice(0, 8)))
})

// memory_get 的正文去重必须走真实事件链路：tool/call → tool/result → injectionState → 下一次 recall。
const MEM_GET_ID = 'abcdef12-3456-7890-abcd-ef1234567890'

function contentOnlySettings() {
  return {
    ...defaultInjectSettings,
    // 故意关闭自动召回：正文去重不应依赖 autoRecall 开关
    autoRecall: { ...defaultInjectSettings.autoRecall, enabled: false },
    recall: { ...defaultInjectSettings.recall, enabled: true },
    digest: { ...defaultInjectSettings.digest, enabled: false },
    rules: { ...defaultInjectSettings.rules, enabled: false, delta: false },
    policy: { ...defaultInjectSettings.policy, enabled: false },
    turnEnd: { ...defaultInjectSettings.turnEnd, enabled: false },
  }
}

function fireMemoryGet(
  handlers: Map<string, (...args: any[]) => unknown>,
  options: { fields?: unknown; text?: string; callId?: string; session?: unknown } = {},
): void {
  const onEvent = handlers.get('session/event')
  assert.ok(onEvent)
  const callId = options.callId ?? 'call-get'
  const session = options.session ?? { id: 's1' }
  onEvent!(session, {
    type: 'tool/call',
    data: {
      name: 'memory_get',
      callId,
      arguments: JSON.stringify({ ids: [MEM_GET_ID], ...(options.fields !== undefined ? { fields: options.fields } : {}) }),
    },
  })
  onEvent!(session, {
    type: 'tool/result',
    data: {
      message: {
        role: 'tool',
        isError: false,
        source: { callId },
        content: [{ type: 'text', text: options.text ?? `[${MEM_GET_ID}] (全局/fact)\n完整正文` }],
      },
    },
  })
}

test('memory_get 取正文后：下一次召回不再重复注入同一条', async () => {
  const hit = { record: { ...record(MEM_GET_ID, '发布前检查 devcred 凭据', ['release']), updatedAt: 100 }, score: 0.9 }
  const { handlers, attached } = setup({
    settings: contentOnlySettings(),
    search: async () => [hit],
    getByIds: () => [{ id: MEM_GET_ID, updatedAt: 100 }],
  })
  fireMemoryGet(handlers)
  const decision = await runPreStep(handlers, undefined, { turn: 2, step: 2 }) as { messages: unknown[] }
  assert.equal(decision.messages.length, 0, '正文已由 memory_get 放进上下文，不应再追加召回消息')
  const recall = attached.current!.list().find((entry) => entry.channel === 'recall' && entry.kind === 'evaluation')
  assert.ok(recall)
  assert.ok((recall!.dedup?.skipped ?? 0) >= 1, '审计要能看到被去重的那条')
  assert.deepEqual(recall!.dedup?.ids ?? [], [MEM_GET_ID])
})

test('memory_get 后记录有更新：下一次召回重新注入新版本', async () => {
  const updated = { ...record(MEM_GET_ID, '发布前检查 devcred 凭据（已更新）', ['release']), updatedAt: 200 }
  const { handlers } = setup({
    settings: contentOnlySettings(),
    search: async () => [{ record: updated, score: 0.9 }],
    // 取正文时记录还是版本 100；下一次召回看到 200，必须视为有更新
    getByIds: () => [{ id: MEM_GET_ID, updatedAt: 100 }],
  })
  fireMemoryGet(handlers)
  const decision = await runPreStep(handlers, undefined, { turn: 2, step: 2 }) as { messages: unknown[] }
  assert.equal(decision.messages.length, 1, '版本变化后应重新注入')
})

test('memory_get 只取 summary / tags 不算正文：仍可被召回注入全文', async () => {
  const hit = { record: { ...record(MEM_GET_ID, '发布前检查 devcred 凭据', ['release']), updatedAt: 100 }, score: 0.9 }
  const { handlers } = setup({
    settings: contentOnlySettings(),
    search: async () => [hit],
    getByIds: () => [{ id: MEM_GET_ID, updatedAt: 100 }],
  })
  fireMemoryGet(handlers, { fields: ['summary'] })
  const decision = await runPreStep(handlers, undefined, { turn: 2, step: 2 }) as { messages: unknown[] }
  assert.equal(decision.messages.length, 1, '只看了摘要，正文仍应通过召回补上')
})

test('去重状态持久化：摘要每会话一次，插件重载后不重复注入', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-memory-digest-state-'))
  const dir = join(workspace, '.dsh', 'dsh-memory')
  const settings = {
    ...defaultInjectSettings,
    autoRecall: { ...defaultInjectSettings.autoRecall, enabled: false },
    recall: { ...defaultInjectSettings.recall, enabled: false },
    digest: { ...defaultInjectSettings.digest, enabled: true },
    rules: { ...defaultInjectSettings.rules, enabled: false, delta: false },
    policy: { ...defaultInjectSettings.policy, enabled: false },
    turnEnd: { ...defaultInjectSettings.turnEnd, enabled: false },
  }
  const memo = record('digest-1', '这是一个已有记忆', [])
  try {
    const first = setup({
      settings,
      list: async () => [memo],
      sessionState: { enabled: true, dir, debounceMs: 1000 },
    })
    const injected = await runPreStep(first.handlers, undefined, {
      turn: 1,
      step: 1,
      agent: { session: { id: 's1', header: { cwd: workspace } } },
    }) as { messages: unknown[] }
    assert.ok(injected.messages.length > 0, '第一次注入摘要')
    first.handlers.get('agent/turn-stopping')!({})
    assert.equal(existsSync(join(dir, 'sessions', 's1.jsonl')), true)

    const reopened = setup({
      settings,
      list: async () => [memo],
      sessionState: { enabled: true, dir, debounceMs: 1000 },
    })
    const skipped = await runPreStep(reopened.handlers, undefined, {
      turn: 1,
      step: 1,
      agent: { session: { id: 's1', header: { cwd: workspace } } },
    }) as { messages: unknown[] }
    assert.equal(skipped.messages.length, 0, '重载后摘要不再重复注入')
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('去重状态持久化：插件重载后从工作区 .dsh/dsh-memory 恢复；记录更新后仍会重注入', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-memory-inject-state-'))
  const dir = join(workspace, '.dsh', 'dsh-memory')
  const settings = contentOnlySettings()
  const stale = { ...record(MEM_GET_ID, '发布前检查 devcred 凭据', ['release']), updatedAt: 100 }
  const updated = { ...record(MEM_GET_ID, '发布前检查 devcred 凭据（已更新）', ['release']), updatedAt: 200 }
  try {
    const first = setup({
      settings,
      search: async () => [{ record: stale, score: 0.9 }],
      getByIds: () => [{ id: MEM_GET_ID, updatedAt: 100 }],
      sessionState: { enabled: true, dir, debounceMs: 1000 },
    })
    fireMemoryGet(first.handlers, { session: { id: 's1', header: { cwd: workspace } } })
    // 轮末强制 flush，不依赖 debounce 计时器
    first.handlers.get('agent/turn-stopping')!({})
    assert.equal(existsSync(join(dir, 'sessions', 's1.jsonl')), true, '状态写到工作区插件目录')

    // 模拟插件重载：新的 apply 实例读同一个文件
    const reopened = setup({
      settings,
      search: async () => [{ record: stale, score: 0.9 }],
      getByIds: () => [{ id: MEM_GET_ID, updatedAt: 100 }],
      sessionState: { enabled: true, dir, debounceMs: 1000 },
    })
    const deduped = await runPreStep(reopened.handlers, undefined, {
      turn: 2,
      step: 2,
      agent: { session: { id: 's1', header: { cwd: workspace } } },
    }) as { messages: unknown[] }
    assert.equal(deduped.messages.length, 0, '重载后同一版本仍应被去重')

    // 记录在持久化之后被更新：版本不同，必须重新注入
    const afterUpdate = setup({
      settings,
      search: async () => [{ record: updated, score: 0.9 }],
      getByIds: () => [{ id: MEM_GET_ID, updatedAt: 100 }],
      sessionState: { enabled: true, dir, debounceMs: 1000 },
    })
    const reinjected = await runPreStep(afterUpdate.handlers, undefined, {
      turn: 3,
      step: 2,
      agent: { session: { id: 's1', header: { cwd: workspace } } },
    }) as { messages: unknown[] }
    assert.equal(reinjected.messages.length, 1, '记录更新后应重新注入新版本')
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

// memory_save = 模型自己把正文写进上下文（tool/call 的参数）。成功后必须和
// memory_get 取正文一样记为 content_injected，否则下一次召回会把刚保存的记忆再塞一遍。
const SAVE_ID = '11112222-3333-4444-5555-666677778888'

function fireMemorySave(
  handlers: Map<string, (...args: any[]) => unknown>,
  options: { callId?: string; text?: string; isError?: boolean; session?: unknown; result?: boolean } = {},
): void {
  const onEvent = handlers.get('session/event')
  assert.ok(onEvent)
  const callId = options.callId ?? 'call-save'
  const session = options.session ?? { id: 's1' }
  onEvent!(session, {
    type: 'tool/call',
    data: {
      name: 'memory_save',
      callId,
      turn: 1,
      step: 3,
      arguments: JSON.stringify({ content: '发布前检查 devcred 凭据', tags: ['release'] }),
    },
  })
  if (options.result === false) return
  onEvent!(session, {
    type: 'tool/result',
    data: {
      turn: 1,
      step: 3,
      message: {
        role: 'tool',
        isError: options.isError ?? false,
        source: { callId },
        content: [{ type: 'text', text: options.text ?? `已保存记忆 ${SAVE_ID} @ D:/repo` }],
      },
    },
  })
}

test('memory_save 结果解析：按 UUID 取记录 id，不看文案', () => {
  const event = (text: string) => ({ data: { message: { content: [{ type: 'text', text }] } } })
  assert.deepEqual(memorySaveResultIds(event(`已保存记忆 ${SAVE_ID} @ D:/repo`)), [SAVE_ID])
  assert.deepEqual(memorySaveResultIds(event(`已更新既有记忆（内容相同，去重）：${SAVE_ID} @ 项目`)), [SAVE_ID])
  // 本地化 / 措辞变化不影响：只要文本里有记录 id 就能取到。
  assert.deepEqual(memorySaveResultIds(event(`Saved memory ${SAVE_ID} in global`)), [SAVE_ID])
  assert.deepEqual(memorySaveResultIds(event('没有 id 的说明文本')), [])
  assert.deepEqual(memorySaveResultIds({}), [])
})

test('memory_save 成功后：下一次召回不再把刚保存的记忆注入一遍，审计留 content_pinned', async () => {
  const hit = { record: { ...record(SAVE_ID, '发布前检查 devcred 凭据', ['release']), updatedAt: 100 }, score: 0.9 }
  const { handlers, attached } = setup({
    settings: contentOnlySettings(),
    search: async () => [hit],
    getByIds: () => [{ id: SAVE_ID, updatedAt: 100 }],
  })
  fireMemorySave(handlers)
  const pinned = attached.current!.list().find((entry) => entry.stage === 'content_pinned')
  assert.ok(pinned, '保存成功要留下会话级去重标记的审计')
  assert.equal(pinned!.reasonCode, 'saved_in_context')
  assert.equal(pinned!.operationId, 'call-save')
  assert.deepEqual(pinned!.selected?.contentIds ?? [], [SAVE_ID])

  const decision = await runPreStep(handlers, undefined, { turn: 2, step: 2 }) as { messages: unknown[] }
  assert.equal(decision.messages.length, 0, '正文已在保存时进入上下文，召回不应再追加')
  const recall = attached.current!.list().find((entry) => entry.channel === 'recall' && entry.kind === 'evaluation')
  assert.ok(recall)
  assert.ok((recall!.dedup?.skipped ?? 0) >= 1)
  assert.deepEqual(recall!.dedup?.ids ?? [], [SAVE_ID])
})

test('memory_save 失败：不标记，后续召回照常注入', async () => {
  const hit = { record: { ...record(SAVE_ID, '发布前检查 devcred 凭据', ['release']), updatedAt: 100 }, score: 0.9 }
  const { handlers, attached } = setup({
    settings: contentOnlySettings(),
    search: async () => [hit],
    getByIds: () => [{ id: SAVE_ID, updatedAt: 100 }],
  })
  fireMemorySave(handlers, { isError: true, text: 'memory_save failed: SCOPE_DISABLED' })
  assert.equal(attached.current!.list().some((entry) => entry.stage === 'content_pinned'), false)
  const decision = await runPreStep(handlers, undefined, { turn: 2, step: 2 }) as { messages: unknown[] }
  assert.equal(decision.messages.length, 1, '保存失败不能吃掉后续召回')
})

test('memory_save 后记录有更新：仍可重新注入新版本', async () => {
  const updated = { ...record(SAVE_ID, '发布前检查 devcred 凭据（已更新）', ['release']), updatedAt: 200 }
  const { handlers } = setup({
    settings: contentOnlySettings(),
    search: async () => [{ record: updated, score: 0.9 }],
    getByIds: () => [{ id: SAVE_ID, updatedAt: 100 }],
  })
  fireMemorySave(handlers)
  const decision = await runPreStep(handlers, undefined, { turn: 2, step: 2 }) as { messages: unknown[] }
  assert.equal(decision.messages.length, 1, '版本变化后应重新注入')
})

test('memory_save 去重命中（内容相同）同样算正文已在上下文', async () => {
  const hit = { record: { ...record(SAVE_ID, '发布前检查 devcred 凭据', ['release']), updatedAt: 300 }, score: 0.9 }
  const { handlers } = setup({
    settings: contentOnlySettings(),
    search: async () => [hit],
    getByIds: () => [{ id: SAVE_ID, updatedAt: 300 }],
  })
  fireMemorySave(handlers, { text: `已更新既有记忆（内容相同，去重）：${SAVE_ID} @ 项目` })
  const decision = await runPreStep(handlers, undefined, { turn: 2, step: 2 }) as { messages: unknown[] }
  assert.equal(decision.messages.length, 0)
})





