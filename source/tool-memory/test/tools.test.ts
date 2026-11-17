import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GET_FIELDS,
  memoryGetTool,
  memoryListTool,
  memorySaveTool,
  memorySearchTool,
  resolveGetFields,
  summarize,
} from '../src/index.ts'
import { DEDUPE_NOTE, renderGetResult, renderListResult, renderSearchResult } from '../src/render.ts'

const LONG = '长'.repeat(300)

const record = {
  id: 'abcdef12-3456-7890-abcd-ef1234567890',
  scope: 'global',
  kind: 'fact',
  content: LONG,
  tags: ['pnpm', 'toolchain'],
  importance: 0.8,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_086_400_000,
  expiredAt: 1_800_000_000_000,
  supersedes: '12345678-aaaa-bbbb-cccc-ddddeeeeffff',
  triggers: ['npm', 'publish'],
}

const bare = {
  id: '00000000-1111-2222-3333-444444444444',
  scope: 'session:s1',
  kind: 'note',
  content: '只有基本字段的一条',
  tags: [],
  importance: 0.2,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
}

/** 逐条允许的用例:可见域 = 当前项目,范围外 = 别的项目。 */
const PROJECT_SCOPE = 'project:D:/w'

const service = {
  save: async () => ({ id: record.id, scope: record.scope }),
  search: async () => [{ record, score: 0.812 }],
  forget: async () => ({ removed: 0, ids: [] }),
  list: async () => [],
  getByIds: (ids: string[]) => [record, bare].filter((r) => ids.some((id) => r.id === id || r.id.startsWith(id))),
}

const label = (scope: string): string => (scope === 'global' ? '全局' : scope)

test('memory_search 只返回印象：id/作用域/类型/标签/摘要，不带正文', async () => {
  const tool = memorySearchTool({ getService: () => service })
  const result = await tool.execute({ query: 'pnpm' })
  const hit = result.records[0]!
  assert.equal('content' in hit, false, '搜索结果不能带正文')
  assert.equal(hit.id, record.id)
  assert.equal(hit.kind, 'fact')
  assert.deepEqual(hit.tags, ['pnpm', 'toolchain'])
  assert.equal(hit.summary, summarize(LONG), '摘要默认 160 字 + 省略号')
  assert.equal(hit.summary.length, 161)
  assert.ok(hit.summary.endsWith('…'))
})

test('memory_search 的 summaryChars 可调，且有上下界', async () => {
  const tool = memorySearchTool({ getService: () => service })
  assert.equal((await tool.execute({ query: 'pnpm', summaryChars: 20 })).records[0]!.summary, `${'长'.repeat(20)}…`)
  // 低于 20 按 20 处理（少量摘要也不能退化成几个字）
  assert.equal((await tool.execute({ query: 'pnpm', summaryChars: 1 })).records[0]!.summary, `${'长'.repeat(20)}…`)
})

test('memory_get 默认字段与原行为一致：content + scope + kind + tags', async () => {
  const tool = memoryGetTool({ getService: () => service })
  const result = await tool.execute({ ids: [record.id] })
  assert.deepEqual(result.fields, ['content', 'scope', 'kind', 'tags'])
  assert.deepEqual(Object.keys(result.records[0]!).sort(), ['content', 'id', 'kind', 'scope', 'tags'])
  assert.equal(result.records[0]!.content, LONG)
})

test('memory_get 可按需只取摘要 / 标签 / 重要度', async () => {
  const tool = memoryGetTool({ getService: () => service })
  const result = await tool.execute({ ids: [record.id.slice(0, 8)], fields: ['summary', 'tags', 'importance'], summaryChars: 24 })
  assert.deepEqual(result.fields, ['summary', 'tags', 'importance'])
  assert.deepEqual(result.records[0], {
    id: record.id,
    summary: `${'长'.repeat(24)}…`,
    tags: ['pnpm', 'toolchain'],
    importance: 0.8,
  })
})

test('memory_get 元数据字段：时间 / 过期 / 触发词 / 修正链', async () => {
  const tool = memoryGetTool({ getService: () => service })
  const fields = ['createdAt', 'updatedAt', 'expiresAt', 'triggers', 'supersedes'] as const
  const result = await tool.execute({ ids: [record.id], fields: [...fields] })
  assert.deepEqual(result.records[0], {
    id: record.id,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiredAt,
    triggers: ['npm', 'publish'],
    supersedes: record.supersedes,
  })
  // 没有这些字段的记录不应该凭空补 undefined
  const minimal = await tool.execute({ ids: [bare.id], fields: [...fields] })
  assert.deepEqual(minimal.records[0], { id: bare.id, createdAt: bare.createdAt, updatedAt: bare.updatedAt })
  assert.equal('expiresAt' in minimal.records[0]!, false)
  assert.equal('triggers' in minimal.records[0]!, false)
  assert.equal('supersedes' in minimal.records[0]!, false)
})

test('memory_get fields 接受逗号分隔字符串，未知字段/空列表明确报错', async () => {
  const tool = memoryGetTool({ getService: () => service })
  const parsed = await tool.execute({ ids: [record.id], fields: 'summary, tags' })
  assert.deepEqual(parsed.fields, ['summary', 'tags'])
  assert.deepEqual(resolveGetFields(undefined), ['content', 'scope', 'kind', 'tags'])
  assert.deepEqual(resolveGetFields([...GET_FIELDS]), [...GET_FIELDS])
  assert.throws(() => resolveGetFields(['nope']), /unknown field/i)
  assert.throws(() => resolveGetFields([]), /不能为空/)
  assert.throws(() => resolveGetFields([123]), /unknown field/i)
})

test('memory_get 找不到的 id 进 missing', async () => {
  const tool = memoryGetTool({ getService: () => service })
  const result = await tool.execute({ ids: ['deadbeef'] })
  assert.equal(result.records.length, 0)
  assert.deepEqual(result.missing, ['deadbeef'])
})

test('renderSearchResult：一行一条，含分数/短 id/标签/摘要，不含全文', () => {
  const text = renderSearchResult(
    {
      records: [{
        id: record.id,
        score: 0.812,
        scope: 'global',
        kind: 'fact',
        tags: ['pnpm'],
        updatedAt: record.updatedAt,
        summary: '短摘要',
      }],
    },
    label,
  )
  assert.equal(text, '[0.812] abcdef12 (全局/fact · pnpm) 短摘要')
  assert.equal(renderSearchResult({ records: [] }, label), '没有找到相关记忆。')
})

test('renderGetResult：默认正文 + 基本元数据；只取字段时不输出正文行', () => {
  const full = renderGetResult(
    {
      records: [{ id: record.id, content: LONG, scope: 'global', kind: 'fact', tags: ['pnpm', 'toolchain'] }],
      fields: ['content', 'scope', 'kind', 'tags'],
      missing: [],
    },
    label,
  )
  assert.equal(full, `[${record.id}] (全局/fact · 标签 pnpm, toolchain)\n${LONG}`)

  const summary = renderGetResult(
    {
      records: [{ id: record.id, summary: '短摘要', tags: ['pnpm'] }],
      fields: ['summary', 'tags'],
      missing: [],
    },
    label,
  )
  assert.equal(summary, `[${record.id}] (标签 pnpm)\n摘要：短摘要`)

  const onlyTags = renderGetResult(
    { records: [{ id: record.id, tags: ['pnpm'] }], fields: ['tags'], missing: [] },
    label,
  )
  assert.equal(onlyTags, `[${record.id}] (标签 pnpm)`)

  const missing = renderGetResult({ records: [], fields: ['content'], missing: ['deadbeef'] }, label)
  assert.equal(missing, '未找到：deadbeef')
  assert.equal(renderGetResult({ records: [], fields: ['content'], missing: [] }, label), '没有找到记忆。')
})

test('上下文去重:memory_search 第二次只回 id,内容更新后重新给摘要', async () => {
  // 模拟注入半边的 memoryContextDedup:按 id + updatedAt 版本记“已出现”。
  const seen = new Map<string, number>()
  const dedup = {
    seen: (records: ReadonlyArray<{ id: string; updatedAt: number }>) => new Set(records.filter((r) => seen.get(r.id) === r.updatedAt).map((r) => r.id)),
    markSummary: (records: ReadonlyArray<{ id: string; updatedAt: number }>) => { for (const r of records) seen.set(r.id, r.updatedAt) },
    markContent: (records: ReadonlyArray<{ id: string; updatedAt: number }>) => { for (const r of records) seen.set(r.id, r.updatedAt) },
  }
  const tool = memorySearchTool({ getService: () => service, contextDedup: () => dedup })
  const first = await tool.execute({ query: 'pnpm' })
  assert.equal(first.records[0]!.deduped, undefined, '第一次带摘要')
  assert.equal(renderSearchResult(first, label), '[0.812] abcdef12 (全局/fact · pnpm, toolchain) ' + summarize(LONG))

  const second = await tool.execute({ query: 'pnpm' })
  assert.equal(second.records[0]!.deduped, true, '同版本第二次命中只回 id')
  assert.equal(second.records[0]!.summary, '')
  assert.equal(renderSearchResult(second, label), `abcdef12\n\n${DEDUPE_NOTE}`)

  // 内容更新(updatedAt 变了) → 摘要重新返回,并记住新版本。
  const updated = { ...record, updatedAt: record.updatedAt + 1, content: '更新后的内容' }
  const updatedService = { ...service, search: async () => [{ record: updated, score: 0.7 }] }
  const bumped = memorySearchTool({ getService: () => updatedService, contextDedup: () => dedup })
  const third = await bumped.execute({ query: 'pnpm' })
  assert.equal(third.records[0]!.deduped, undefined, '版本变了 → 摘要要重新给')
  assert.equal(third.records[0]!.summary, '更新后的内容')
  const fourth = await bumped.execute({ query: 'pnpm' })
  assert.equal(fourth.records[0]!.deduped, true, '新版本第二次命中再次省略')
})

test('上下文去重:memory_list 返回过的正文第二次只回 id', async () => {
  const seen = new Map<string, number>()
  const dedup = {
    seen: (records: ReadonlyArray<{ id: string; updatedAt: number }>) => new Set(records.filter((r) => seen.get(r.id) === r.updatedAt).map((r) => r.id)),
    markSummary: (records: ReadonlyArray<{ id: string; updatedAt: number }>) => { for (const r of records) seen.set(r.id, r.updatedAt) },
    markContent: (records: ReadonlyArray<{ id: string; updatedAt: number }>) => { for (const r of records) seen.set(r.id, r.updatedAt) },
  }
  const listService = { ...service, list: async () => [{ ...record, content: '列表里的正文' }] }
  const tool = memoryListTool({ getService: () => listService, contextDedup: () => dedup })
  const first = await tool.execute({})
  assert.equal(first.records[0]!.deduped, undefined)
  assert.ok(renderListResult(first, label).includes('列表里的正文'))

  const second = await tool.execute({})
  assert.equal(second.records[0]!.deduped, true)
  assert.equal(second.records[0]!.content, '')
  assert.equal(renderListResult(second, label), `abcdef12\n\n${DEDUPE_NOTE}`)
})

test('memory_search 范围外命中默认只给索引,不弹审批;requestApproval=true 才逐条允许', async () => {
  const outside = {
    id: 'outside-1',
    scope: 'other-project',
    kind: 'fact',
    content: '范围外 A',
    tags: [],
    importance: 0.5,
    createdAt: 1,
    updatedAt: 1,
  }
  const outside2 = { ...outside, id: 'outside-2', content: '范围外 B' }
  const scoped = {
    ...service,
    search: async () => [
      { record: { ...record, scope: PROJECT_SCOPE }, score: 0.9 },
      { record: outside, score: 0.8 },
      { record: outside2, score: 0.7 },
    ],
    visibilityPolicy: () => ({ level: 'normal' as const, scopes: [{ scope: PROJECT_SCOPE }], source: 'explicit' as const }),
  }

  // 默认:完全不发起审批,范围外命中只给作用域清单(条数 + 用途,不含条目摘要)。
  let asked = 0
  const quietService = {
    ...scoped,
    requestOutOfScope: async () => {
      asked += 1
      return { outcome: 'allowed-once' as const }
    },
  }
  const tool = memorySearchTool({ getService: () => quietService })
  const result = await tool.execute({ query: 'x', description: '查范围外的发布规则' }, { agent: { session: { id: 's1' } } })
  assert.equal(asked, 0, '默认不弹审批')
  assert.deepEqual(result.records.map((r) => r.id), ['abcdef12-3456-7890-abcd-ef1234567890'], '范围内结果照常')
  assert.deepEqual(result.outOfScope?.scopes.map((entry) => [entry.scope, entry.records, entry.requestable]), [
    ['other-project', 2, true],
  ], '范围外按作用域聚合条数')
  assert.ok(result.outOfScope?.scopes.every((entry) => typeof entry.description === 'string' && entry.description.length > 0), '每个作用域都带用途描述')
  assert.equal('records' in (result.outOfScope ?? {}), false, '范围外清单不再带条目索引')
  assert.deepEqual(result.withheld, { count: 2, reason: 'out-of-scope' }, '普通限制下未审批的范围外命中 = out-of-scope')

  const text = renderSearchResult(result, label)
  assert.match(text, /范围外命中（只列作用域与用途，不含条目内容）：1 个作用域 \/ 2 条/)
  assert.match(text, /- other-project（2 条）：自定义作用域/)
  assert.match(text, /requestApproval=true/)
  assert.doesNotMatch(text, /范围外 A|范围外 B/, '范围外条目的摘要不进上下文')
  assert.doesNotMatch(text, /本次没有弹审批/, '清单已经把话说清,不再重复 withheld 说明')

  // 显式 requestApproval=true:恢复 0.26 的审批行为,允许的条目并入 records。
  let payload: string[] = []
  const partialService = {
    ...scoped,
    requestOutOfScope: async (_agent: unknown, input: { items: Array<{ id: string }> }) => {
      payload = input.items.map((item) => item.id)
      return { outcome: 'allowed-once' as const, allowedIds: ['outside-1'] }
    },
  }
  const approvalTool = memorySearchTool({ getService: () => partialService })
  const approved = await approvalTool.execute(
    { query: 'x', description: '查范围外的发布规则', requestApproval: true },
    { agent: { session: { id: 's1' } } },
  )
  assert.deepEqual(payload.sort(), ['outside-1', 'outside-2'], '审批载荷带上全部范围外命中')
  assert.deepEqual(approved.records.map((r) => r.id).sort(), ['abcdef12-3456-7890-abcd-ef1234567890', 'outside-1'])
  assert.deepEqual(approved.withheld, { count: 1, reason: 'partial' })
  assert.deepEqual(approved.outOfScope?.scopes.map((entry) => [entry.scope, entry.records]), [['other-project', 1]], '没被允许的那条仍以作用域清单给出')
  assert.match(renderSearchResult(approved, label), /只允许了其余条目/)
})

test('memory_search 范围外清单:用途取自作用域目录,不可申请的作用域如实标注', async () => {
  const outside = {
    id: 'outside-1',
    scope: 'handbook',
    kind: 'fact',
    content: '范围外 A',
    tags: [],
    importance: 0.5,
    createdAt: 1,
    updatedAt: 1,
  }
  const entry = {
    scope: 'handbook',
    description: '团队约定与发布流程',
    origin: 'custom' as const,
    inScope: false,
    readable: false,
    writable: false,
    canRequestRead: false,
    canRequestWrite: false,
    accessStatus: 'restricted' as const,
    updatedAt: 1,
  }
  const tool = memorySearchTool({
    getService: () => ({
      ...service,
      search: async () => [{ record: outside, score: 0.8 }],
      visibilityPolicy: () => ({ level: 'normal' as const, scopes: [{ scope: PROJECT_SCOPE }], source: 'explicit' as const }),
      // 作用域被用户关掉了可读:命中被挡,但没有审批路径。
      accessEvaluator: () => (request: { action: string; scope: string }) => (request.scope === 'handbook'
        ? { allowed: false, reason: 'READ_DISABLED', requestable: false }
        : { allowed: true, requestable: false }),
      scopeCatalog: () => [entry],
    }),
  })
  const result = await tool.execute({ query: 'x', description: '查团队约定' }, { agent: { session: { id: 's1' } } })
  assert.deepEqual(result.outOfScope?.scopes, [{
    scope: 'handbook',
    records: 1,
    description: '团队约定与发布流程',
    requestable: false,
  }], '用途来自 scope-meta(目录),可申请性来自授权判定')
  assert.match(renderSearchResult(result, label), /- handbook（1 条 · 不可申请）：团队约定与发布流程/)
})

test('memory_search 范围外索引:绝对限制不出现,拒绝/超时后索引用审批结局', async () => {
  const outside = {
    id: 'outside-1',
    scope: 'other-project',
    kind: 'fact',
    content: '范围外 A',
    tags: [],
    importance: 0.5,
    createdAt: 1,
    updatedAt: 1,
  }
  const exec = { agent: { session: { id: 's1' } } }
  const scoped = {
    ...service,
    search: async () => [{ record: outside, score: 0.8 }],
    visibilityPolicy: () => ({ level: 'normal' as const, scopes: [{ scope: PROJECT_SCOPE }], source: 'explicit' as const }),
  }

  // absolute:范围外命中不产生索引(withheld=absolute),也不可申请。
  const absoluteTool = memorySearchTool({
    getService: () => ({
      ...scoped,
      visibilityPolicy: () => ({ level: 'absolute' as const, scopes: [{ scope: PROJECT_SCOPE }], source: 'explicit' as const }),
    }),
  })
  const denied = await absoluteTool.execute({ query: 'x' }, exec)
  assert.equal(denied.outOfScope, undefined, 'absolute 下没有索引(没有审批路径)')
  assert.deepEqual(denied.withheld, { count: 1, reason: 'absolute' })

  // requestApproval=true 被拒绝:范围外照旧给索引(让模型知道拒绝的是什么),原因如实。
  let asked = 0
  const rejectedTool = memorySearchTool({
    getService: () => ({
      ...scoped,
      requestOutOfScope: async () => {
        asked += 1
        return 'rejected' as const
      },
    }),
  })
  const rejected = await rejectedTool.execute({ query: 'x', description: '查范围外', requestApproval: true }, exec)
  assert.equal(asked, 1, '显式要求时发起审批')
  assert.equal(rejected.records.length, 0)
  assert.deepEqual(rejected.withheld, { count: 1, reason: 'rejected' })
  assert.deepEqual(rejected.outOfScope?.scopes.map((entry) => [entry.scope, entry.records]), [['other-project', 1]], '拒绝后清单仍在,模型能再判断')
})

test('renderListResult:去重条目只给 id,提示用 memory_get 取全文', () => {
  const text = renderListResult({
    records: [
      { id: record.id, scope: 'global', kind: 'fact', updatedAt: 1, content: '正文一' },
      { id: bare.id, scope: 'session:s1', kind: 'note', updatedAt: 2, content: '', deduped: true },
    ],
  }, label)
  assert.ok(text.includes(`(全局/fact) 正文一`))
  assert.ok(text.includes('00000000'), '去重条目只显示短 id')
  assert.ok(!text.includes('只有基本字段的一条'))
  assert.ok(text.endsWith(DEDUPE_NOTE))
})

test('被可见域挡住时渲染真实原因:拒绝/超时/无法审批;绝对限制不出现 withheld', () => {
  const rejected = renderSearchResult({ records: [], withheld: { count: 3, reason: 'rejected' } }, label)
  assert.match(rejected, /没有找到可见范围内的相关记忆/)
  assert.match(rejected, /另有 3 条记忆/)
  assert.match(rejected, /用户拒绝了本次访问/)
  assert.match(rejected, /调整「记忆范围」/)

  const timeout = renderGetResult(
    { records: [], fields: ['content'], missing: ['deadbeef'], withheld: { count: 1, reason: 'timeout' } },
    label,
  )
  assert.match(timeout, /未找到：deadbeef/)
  assert.match(timeout, /5 分钟内没有得到答复/)
  assert.match(timeout, /按拒绝处理/)

  const unavailable = renderSearchResult({ records: [], withheld: { count: 2, reason: 'unavailable' } }, label)
  assert.match(unavailable, /无法发起审批/)

  // 有命中也有 withheld:正文照常渲染,原因跟在后面。
  const mixed = renderSearchResult({
    records: [{
      id: record.id,
      score: 0.5,
      scope: 'global',
      kind: 'fact',
      tags: [],
      updatedAt: record.updatedAt,
      summary: '短摘要',
    }],
    withheld: { count: 1, reason: 'rejected' },
  }, label)
  assert.match(mixed, /\[0\.500\] abcdef12 \(全局\/fact\) 短摘要/)
  assert.match(mixed, /用户拒绝了本次访问/)
})

test('renderSearchResult:去重 ID 单独成块,与带摘要条目之间空一行', () => {
  const text = renderSearchResult({
    records: [
      { id: 'aaaaaaaa-1111', score: 0.9, scope: 'global', kind: 'fact', tags: [], updatedAt: 1, summary: '摘要 A' },
      { id: 'bbbbbbbb-2222', score: 0.8, scope: 'global', kind: 'fact', tags: [], updatedAt: 1, summary: '', deduped: true },
      { id: 'cccccccc-3333', score: 0.7, scope: 'global', kind: 'fact', tags: [], updatedAt: 1, summary: '摘要 C' },
    ],
  }, label)
  assert.equal(
    text,
    `[0.900] aaaaaaaa (全局/fact) 摘要 A\n[0.700] cccccccc (全局/fact) 摘要 C\n\nbbbbbbbb\n\n${DEDUPE_NOTE}`,
    '裸 ID 与含摘要条目之间必须空一行,否则看起来像上一条的续行',
  )
})

test('普通限制:memory_* 缺少 description 拒绝执行,提供后随审批载荷传给面板', async () => {
  const outside = {
    id: 'outside-1',
    scope: 'other-project',
    kind: 'fact',
    content: '范围外 A',
    tags: [],
    importance: 0.5,
    createdAt: 1,
    updatedAt: 1,
  }
  const scoped = {
    ...service,
    search: async () => [{ record: outside, score: 0.8 }],
    visibilityPolicy: () => ({ level: 'normal' as const, scopes: [{ scope: PROJECT_SCOPE }], source: 'explicit' as const }),
  }
  let asked: { description?: string } | undefined
  const spy = {
    ...scoped,
    requestOutOfScope: async (_agent: unknown, input: { description?: string }) => {
      asked = input
      return 'allowed-once' as const
    },
  }
  const exec = { agent: { session: { id: 's1' } } }
  const tool = memorySearchTool({ getService: () => spy })
  await assert.rejects(
    () => tool.execute({ query: 'x' }, exec),
    (error: { code?: string }) => error.code === 'DESCRIPTION_REQUIRED',
    '普通限制下缺 description 直接拒绝,不发起审批',
  )
  const result = await tool.execute({ query: 'x', description: '  查发布流程的坑  ', requestApproval: true }, exec)
  assert.equal(result.records.length, 1)
  assert.equal(asked?.description, '查发布流程的坑', 'description 折叠空白后随审批载荷传给面板')
})

test('普通限制+范围外命中:默认不发审批,description 校验不受新流程影响', async () => {
  const outside = {
    id: 'outside-1',
    scope: 'other-project',
    kind: 'fact',
    content: '范围外 A',
    tags: [],
    importance: 0.5,
    createdAt: 1,
    updatedAt: 1,
  }
  const scoped = {
    ...service,
    search: async () => [{ record: outside, score: 0.8 }],
    visibilityPolicy: () => ({ level: 'normal' as const, scopes: [{ scope: PROJECT_SCOPE }], source: 'explicit' as const }),
  }
  let asked: { description?: string } | undefined
  const spy = {
    ...scoped,
    requestOutOfScope: async (_agent: unknown, input: { description?: string }) => {
      asked = input
      return 'allowed-once' as const
    },
  }
  const exec = { agent: { session: { id: 's1' } } }
  const tool = memorySearchTool({ getService: () => spy })
  await assert.rejects(
    () => tool.execute({ query: 'x' }, exec),
    (error: { code?: string }) => error.code === 'DESCRIPTION_REQUIRED',
    '普通限制下缺 description 直接拒绝(即使这次根本不会弹审批)',
  )
  const result = await tool.execute({ query: 'x', description: '查发布流程的坑' }, exec)
  assert.equal(asked, undefined, '默认不发审批')
  assert.deepEqual(result.withheld, { count: 1, reason: 'out-of-scope' })
  assert.equal(result.outOfScope?.scopes[0]?.scope, 'other-project')
})

test('普通限制:绝对限制 / 无限制下不要求 description', async () => {
  const exec = { agent: { session: { id: 's1' } } }
  for (const level of ['absolute', 'none'] as const) {
    const tool = memorySearchTool({
      getService: () => ({
        ...service,
        visibilityPolicy: () => ({ level, scopes: [{ scope: 'global' }], source: 'explicit' as const }),
      }),
    })
    const result = await tool.execute({ query: 'pnpm' }, exec)
    assert.equal(result.records.length, 1, `${level}: 不传 description 也能执行`)
  }
})

/**
 * 0.25.12：`supersedes` 必须传完整 id。
 *
 * 检索 / 列表 / 摘要 / 规则索引给的都是 8 位短 id，`memory_get` 也接受 8 位前缀，
 * 但 `supersedes` 在 provider 里是按 id 精确查找 —— 说明里不写清楚，模型就会把短 id
 * 直接传进来，只会换到一个 SUPERSEDES_UNKNOWN。这条守卫锁住说明里的三件事：
 * 「完整 id」、「不能用 8 位短 id」、「怎么拿到完整 id(memory_get)」。
 */
test('memory_save.supersedes 的参数说明要求完整 id，并禁止 8 位短 id', () => {
  const tool = memorySaveTool({ getService: () => service })
  const params = tool.parameters as Record<string, { description?: string }>
  const text = params.supersedes?.description ?? ''
  assert.ok(text.length > 0, 'supersedes 必须有参数说明')
  assert.ok(text.includes('完整 id'), '必须写明要传完整 id')
  assert.ok(text.includes('8 位短 id'), '必须明确禁止 8 位短 id')
  assert.ok(text.includes('memory_get'), '必须给出拿完整 id 的办法（memory_get）')
  assert.ok(text.includes('36 位 UUID'), '必须给出完整 id 的形状')
  assert.ok(text.includes('必须显式带 scope'), '必须写明 supersedes 时 scope 不能省略')
  assert.ok(text.includes('写权限'), '必须写明目标作用域要有写权限')
})

