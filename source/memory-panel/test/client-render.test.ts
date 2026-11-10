/**
 * Render smoke test for the memory panel client bundle.
 *
 * The panel is hand-written plain JS served through the host's ModuleLoader, so
 * nothing type-checks it and there is no local react-dom to mount it. This test
 * loads the real bundle through the real loader contract (`window.__ModuleLoader__.load`)
 * with a minimal React (useState with re-render, useEffect collected so a test
 * can run it) plus a stubbed `fetch`, then asserts what the user actually sees:
 *   - a record card is COLLAPSED by default (preview only, no full body, no actions)
 *   - expanding it surfaces the full content plus 编辑/删除
 *   - an UNCONFIGURED vector backend offers the model list + 下载并安装, and no dead switch
 *   - only a backend this app manages gets a switch (external / disabled never do)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 合并后客户端 bundle 归单包所有:期望的注册 id 就是那个包的包名。
 * 从包里读而不是写死字符串 —— 写死的那份在改名/合并时会静默过期,
 * 而这类不一致的失败形态正是「面板不出现」。
 */
const PACKAGE_NAME = (
  JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'memory-plugin', 'package.json'), 'utf8')) as { name: string }
).name

type VNode = { type: unknown; props: Record<string, unknown>; children: unknown[] }

/** Minimal React: createElement + useState (with re-render) + collectable useEffect. */
function makeReact() {
  // 每个组件实例一份状态槽:key 由 render 的路径推导(见 render 的 path 参数)。
  // 早先是一个全局数组 + cursor,嵌套组件会把父组件的槽位写坏 —— 只有在"子组件渲染
  // 发生在父组件读完自己的 state 之后"时才侥幸能过,而面板一加嵌套的有状态组件
  // (ModelPicker)就静默把父组件的 embedServer 改成了空字符串。
  const store = new Map<string, unknown[]>()
  const effects: (() => unknown)[] = []
  /** effect 返回的清理函数:resetAll 时统一执行(等价于 React 卸载)。 */
  const cleanups: Array<() => unknown> = []
  let key = 'root'
  let cursor = 0
  let pending: (() => void) | null = null

  const createElement = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): VNode => ({
    type,
    props: props ?? {},
    // 保留 null/undefined/false 槽位:React 的身份是**按位置**的,条件渲染时下标不能漂移,
    // 否则兄弟节点一变,嵌套组件的状态就被重置(踩过:chipRow 出现后 ModelPicker 被重挂)。
    children: children.flat(),
  })

  const React = {
    createElement,
    useState(initial: unknown) {
      const slots = store.get(key) ?? []
      const i = cursor++
      if (!(i in slots)) slots[i] = initial
      store.set(key, slots)
      const set = (v: unknown) => {
        slots[i] = typeof v === 'function' ? (v as (prev: unknown) => unknown)(slots[i]) : v
        if (pending) pending()
      }
      return [slots[i], set] as const
    },
    useEffect(fn: () => unknown) { effects.push(fn) },
    useRef(initial: unknown) {
      const slots = store.get(key) ?? []
      const i = cursor++
      if (!(i in slots)) slots[i] = { current: initial }
      store.set(key, slots)
      return slots[i] as { current: unknown }
    },
  }

  return {
    React,
    createElement,
    /** 进入一个组件/元素路径:它拥有自己的一组状态槽。 */
    enter: (next: string) => { key = next; cursor = 0 },
    /** Drop all hook state so each test renders a component from a clean slate. */
    resetAll: () => {
      // 先卸载:effect 的清理函数要跑(否则 setInterval 之类的句柄会留在事件循环里,
      // 测试全绿但进程永不退出)。
      for (const cleanup of cleanups.splice(0)) { try { cleanup() } catch { /* 清理失败不影响测试 */ } }
      store.clear()
      effects.length = 0
      key = 'root'
      cursor = 0
      pending = null
    },
    /** 新一轮渲染提交开始:上一轮没来得及跑的 effect 直接丢弃(见 render 的注释)。 */
    beginPass: () => { effects.length = 0 },
    setRerender: (fn: () => void) => { pending = fn },
    /** Run the effects collected during the last render (mount semantics). */
    runEffects: () => {
      const list = effects.splice(0)
      for (const fn of list) {
        const cleanup = fn()
        if (typeof cleanup === 'function') cleanups.push(cleanup as () => unknown)
      }
    },
  }
}

interface RenderNode { tag?: unknown; props?: Record<string, unknown>; text?: string; children?: RenderNode[] }

/** portal 桩:0.25.8 起「记忆权限」浮窗挂到 document.body,渲染时把 portal 里的树继续往下画。 */
interface PortalEntry { node: unknown; container: unknown }

/**
 * 一次"渲染提交"只保留**这一轮**注册的 effect。
 *
 * 不这么做的话 `effects` 会跨多轮渲染累积:测试里每次 await 都会让 load() 的 setState
 * 触发一轮同步重渲,每轮都重新注册"拉数据"与"自动刷新"effect;下一次 runEffects()
 * 会把**所有历史轮次**的 effect 一起跑掉(每个 load 又触发新一轮渲染),效应量级按
 * 轮数指数增长。0.12.7 之后审计页自动刷新把这条放大到 100MB/测试,整套用例在默认
 * 2GB 堆上直接 OOM。React 里 effect 是按提交轮次执行的,这里只保留最新一轮更贴近
 * 真实语义;跨组件累积则由 resetAll() 清空。
 */
let renderDepth = 0

function render(node: unknown, hooks: ReturnType<typeof makeReact>, path = 'root'): RenderNode | null {
  const outermost = renderDepth === 0
  if (outermost) hooks.beginPass()
  renderDepth += 1
  try {
    return renderNode(node, hooks, path)
  } finally {
    renderDepth -= 1
  }
}

function renderNode(node: unknown, hooks: ReturnType<typeof makeReact>, path = 'root'): RenderNode | null {
  if (node === null || node === undefined || node === false || node === true) return null
  if (typeof node === 'string' || typeof node === 'number') return { text: String(node) }
  if (Array.isArray(node)) return { children: node.map((n, i) => render(n, hooks, `${path}[${i}]`)).filter(Boolean) as RenderNode[] }
  // createPortal 的返回值只在真实 DOM 里"挂到别处";测试里等价于把里面的树渲染在原位,
  // 挂载目标由 portals 数组单独断言(见「浮窗 portal 到 body」用例)。
  const portal = (node as { __portal?: PortalEntry }).__portal
  if (portal !== undefined) return render(portal.node, hooks, path)
  const vnode = node as VNode
  if (typeof vnode.type === 'function') {
    const component = vnode.type as (p: Record<string, unknown>) => unknown
    const childPath = `${path}/${component.name || 'fn'}`
    hooks.enter(childPath)
    return render(component({ ...vnode.props, children: vnode.children }), hooks, childPath)
  }
  const elementPath = `${path}/${String(vnode.type)}`
  hooks.enter(elementPath)
  return {
    tag: vnode.type,
    props: vnode.props,
    children: vnode.children.map((n, i) => render(n, hooks, `${elementPath}/${i}`)).filter(Boolean) as RenderNode[],
  }
}

function collect(node: RenderNode | null, out: RenderNode[] = []): RenderNode[] {
  if (!node) return out
  out.push(node)
  for (const child of node.children ?? []) collect(child, out)
  return out
}

function toggledText(node: RenderNode | null): string {
  return (node?.children ?? []).map((child) => textOf(child)).join(' ')
}

function textOf(node: RenderNode | null): string {
  const parts: string[] = []
  for (const n of collect(node)) if (n.text !== undefined) parts.push(n.text)
  return parts.join(' ')
}

async function loadBundleImpl() {
  const hooks = makeReact()
  let registration: { id: string; factory: (require: (name: string) => unknown) => Record<string, unknown> } | null = null
  const globals = globalThis as Record<string, unknown>
  globals.window = {
    __ModuleLoader__: {
      load(reg: typeof registration) { registration = reg },
    },
  }
  globals.document = {
    createElement: () => ({ set textContent(_v: string) {}, remove() {} }),
    head: { appendChild() {} },
    body: { tagName: 'BODY' },
  }
  /**
   * react-dom 桩。bundle 只用 createPortal(把「记忆权限」浮窗挂到 body,理由见
   * client.js 文件头),这里记录每次 portal 的目标容器,并返回一个渲染器认识的标记。
   */
  const portals: PortalEntry[] = []
  const requireShim = (name: string) => {
    if (name === 'react') return hooks.React
    if (name === 'react-dom') {
      return {
        createPortal(node: unknown, container: unknown) {
          const entry: PortalEntry = { node, container }
          portals.push(entry)
          return { __portal: entry }
        },
      }
    }
    throw new Error(`unexpected require("${name}") in the client bundle`)
  }
  await import('../lib/client.js')
  assert.ok(registration, 'bundle must call window.__ModuleLoader__.load')
  const reg = registration as unknown as { id: string; factory: (r: (n: string) => unknown) => Record<string, unknown> }
  assert.equal(reg.id, PACKAGE_NAME, 'ModuleLoader id must equal the package name')
  const exports = reg.factory(requireShim)
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots'])
  return { exports, hooks, portals }
}

// ESM caches the bundle, so it can only be evaluated once per process.
let cached: Promise<{ exports: Record<string, unknown>; hooks: ReturnType<typeof makeReact>; portals: PortalEntry[] }> | null = null
function loadBundle() {
  if (!cached) cached = loadBundleImpl()
  return cached
}

function makeRecord(overrides: Record<string, unknown> = {}) {
  const content = '这是一条用于渲染冒烟测试的记忆内容,它足够长以便检查折叠预览是否生效。'.repeat(3)
  return {
    id: 'rec-1',
    scope: 'project:C:/demo',
    kind: 'fact',
    content,
    tags: ['demo'],
    importance: 0.6,
    createdAt: 1,
    updatedAt: 1,
    accessCount: 0,
    supersededBy: null,
    supersedes: null,
    embedded: true,
    ...overrides,
  }
}

test('record cards render collapsed by default (preview only, no actions)', async () => {
  const { exports, hooks } = await loadBundle()
  hooks.resetAll()
  const RecordCard = (exports.__test as { RecordCard: (p: Record<string, unknown>) => unknown }).RecordCard
  const rec = makeRecord()
  // go through createElement so the renderer resets the hook cursor for us
  const tree = render(hooks.React.createElement(RecordCard, { rec, onSaved: () => {}, onDeleted: () => {} }), hooks)

  const nodes = collect(tree)
  const classNames = nodes.map((n) => String(n.props?.className ?? ''))
  assert.ok(classNames.includes('rec'), 'card wrapper')
  assert.ok(classNames.includes('preview'), 'collapsed card shows the one-line preview')
  assert.ok(!classNames.includes('content'), 'collapsed card must NOT render the full body')

  const text = textOf(tree)
  assert.ok(text.includes('fact'), 'meta stays visible when collapsed')
  assert.ok(!text.includes('编辑'), 'edit action is hidden until expanded')
  assert.ok(!text.includes('删除'), 'delete action is hidden until expanded')
  assert.ok(text.includes(rec.content.slice(0, 20)), 'preview text present')

  // the header is the toggle affordance
  const head = nodes.find((n) => String(n.props?.className ?? '').startsWith('rec-head'))
  assert.ok(head, 'header exists')
  assert.equal(head!.props?.['aria-expanded'], false, 'collapsed by default')
  assert.equal(head!.props?.role, 'button')
})

test('expanding a card reveals the full content and the actions', async () => {
  const { exports, hooks } = await loadBundle()
  hooks.resetAll()
  const RecordCard = (exports.__test as { RecordCard: (p: Record<string, unknown>) => unknown }).RecordCard
  const rec = makeRecord()
  const element = () => hooks.React.createElement(RecordCard, { rec, onSaved: () => {}, onDeleted: () => {} })

  // wire setState → re-render so the toggle actually flips
  let current: RenderNode | null = null
  hooks.setRerender(() => { current = render(element(), hooks) })
  current = render(element(), hooks)

  const head = collect(current).find((n) => String(n.props?.className ?? '').startsWith('rec-head'))
  assert.ok(head, 'header exists')
  ;(head!.props!.onClick as () => void)()

  const nodes = collect(current)
  const classNames = nodes.map((n) => String(n.props?.className ?? ''))
  assert.ok(classNames.includes('content'), 'expanded card renders the full body')
  assert.ok(!classNames.includes('preview'), 'preview is replaced when expanded')
  const text = textOf(current)
  assert.ok(text.includes('编辑') && text.includes('删除'), 'actions available once expanded')
})

/** 面板里的「模型与硬件」会用到的报告(探测结果用假数据,理由文本断言用不到它)。 */
const modelReport = () => ({
  catalog: [
    {
      id: 'bge-m3', label: 'BGE-M3', note: '', dims: 1024, pooling: 'cls', languages: 'multilingual',
      contextTokens: 8192, sizeBytes: 437778496, installed: false,
      variants: [{ id: 'q4_k_m', label: 'Q4_K_M', bytes: 437778496, file: 'bge-m3-Q4_K_M.gguf', installed: false }],
    },
    {
      id: 'qwen3-embedding-0.6b', label: 'Qwen3-Embedding-0.6B', note: '', dims: 1024, pooling: 'last', languages: 'multilingual',
      contextTokens: 32768, sizeBytes: 639171584, installed: false,
      variants: [{ id: 'q8_0', label: 'Q8_0', bytes: 639171584, file: 'Qwen3-Embedding-0.6B-Q8_0.gguf', installed: false }],
    },
  ],
  current: {
    presetId: 'bge-m3', variantId: 'q4_k_m', modelLabel: 'BGE-M3 · Q4_K_M', file: 'bge-m3-Q4_K_M.gguf',
    dims: 1024, pooling: 'cls', flavor: 'cpu', model: 'bge-m3',
  },
  hardware: {
    platform: 'win32', arch: 'x64', cpuCount: 12, totalRamMb: 14336, freeDiskMb: 9553,
    diskPath: 'C:/x', gpu: null, flavors: ['cpu'], notes: [],
  },
  recommendation: {
    modelId: 'qwen3-embedding-0.6b', variantId: 'q8_0', flavor: 'cpu',
    reason: ['这台机器:12 核 · 14GB 内存'], warnings: [], alternatives: [], candidates: [],
  },
  locale: 'zh-CN',
  records: 3,
})

/** Stub `fetch` the way the panel's api() uses it and let the mount effect run. */
async function mountPanel(
  hooks: ReturnType<typeof makeReact>,
  state: { scopes: unknown[]; embedServer: unknown },
  report = modelReport(),
  tab = 'data',
  records: Array<Record<string, unknown>> = [],
) {
  const globals = globalThis as Record<string, unknown>
  globals.fetch = async (url: string) => ({
    status: 200,
    json: async () => (String(url).includes('/embed/model')
      ? { ok: true, value: report }
      : String(url).includes('/status')
        ? { ok: true, value: state }
        : { ok: true, value: { records } }),
  })
  const { exports } = await loadBundle()
  const MemoryPanel = (exports.__test as { MemoryPanel: (p: Record<string, unknown>) => unknown }).MemoryPanel
  const element = () => hooks.React.createElement(MemoryPanel, {})
  let current: RenderNode | null = render(element(), hooks)
  hooks.setRerender(() => { current = render(element(), hooks) })
  hooks.runEffects()
  for (let i = 0; i < 6; i++) await Promise.resolve()
  // 第二轮:清单/状态请求回来后,才会把选择抛给面板(「当前」那行由它驱动)
  hooks.runEffects()
  for (let i = 0; i < 4; i++) await Promise.resolve()
  if (tab !== 'data') {
    const label = ({ records: '服务', data: '记录', tree: '记忆树', settings: '设置' } as Record<string, string>)[tab] ?? tab
    const button = collect(current).find((n) => n.tag === 'button' && textOf(n).trim() === label)
    assert.ok(button, `找不到「${label}」标签`)
    ;(button!.props!.onClick as () => void)()
    hooks.runEffects()
    for (let i = 0; i < 8; i++) await Promise.resolve()
    hooks.runEffects()
    for (let i = 0; i < 4; i++) await Promise.resolve()
  }
  return () => current
}

/**
 * 切到指定标签。默认标签是「数据」(记忆列表),概览(统计/向量服务/维护)
 * 在「记录」里,所以涉及服务卡片/安装器的断言先调这个。
 */
async function switchTab(
  current: () => RenderNode | null,
  hooks: ReturnType<typeof makeReact>,
  label: string,
) {
  const tab = collect(current()).find((n) => n.tag === 'button' && textOf(n).trim() === label)
  assert.ok(tab, `找不到「${label}」标签`)
  ;(tab!.props!.onClick as () => void)()
  for (let i = 0; i < 4; i++) await Promise.resolve()
}

/** 树里所有标签气泡的文字(按出现顺序)。 */
function chipTexts(tree: RenderNode | null): string[] {
  return collect(tree)
    // 精确匹配 class 'chip':容器叫 'chips',用 includes 会把它也算进来
    .filter((n) => String(n.props?.className ?? '').split(/\s+/).includes('chip'))
    .map((n) => (n.children ?? []).map((c) => c.text).join(''))
}

const installIdle = (over: Record<string, unknown> = {}) => ({
  phase: 'idle', message: '', receivedBytes: 0, totalBytes: null, error: null, installed: false, root: 'D:/stack', ...over,
})

test('审计标签页:独立入口、真实空状态、不伪造数据', async () => {
  const { hooks } = await loadBundle()
  hooks.resetAll()
  const tree = await mountPanel(hooks, {
    scopes: [{ scope: 'session:sess-12345678', records: 1, pendingEmbeds: 0, label: '会话标题' }],
    embedServer: null,
  }, undefined, '审计')
  const text = textOf(tree())
  assert.ok(!text.includes('记忆审计'), '按需求移除顶部标题')
  assert.ok(!text.includes('追踪记忆注入'), '按需求移除解释文本')
  assert.ok(text.includes('自动刷新'), '自动刷新开关可见')
  assert.ok(text.includes('内存模式'), '如实显示内存模式')
  assert.ok(text.includes('当前筛选没有审计事件'), '无事件时显示真实空状态')
  assert.ok(!text.includes('已投递 42'), '不补造统计')
  hooks.resetAll()
})

test('审计标签页:真实事件渲染为事件流与详情,评估不等于投递', async () => {
  const { hooks, exports } = await loadBundle()
  hooks.resetAll()
  const entries = [
    {
      schemaVersion: 2, id: 's1:2', seq: 2, at: Date.now(), sessionId: 's1', step: 1,
      kind: 'delivery', channel: 'lifecycle', stage: 'delivery_prepared', outcome: 'unknown',
      reasonCode: 'prepared', channels: ['recall'], delivery: { status: 'unknown', appended: null, textChars: 42, textHash: 'fnv1a:abc' },
    },
    {
      schemaVersion: 2, id: 's1:1', seq: 1, at: Date.now(), sessionId: 's1', step: 1,
      kind: 'evaluation', channel: 'recall', stage: 'searched', outcome: 'success', reasonCode: 'injected',
      trigger: 'before_high_risk_tool', phase: 'release', scopes: ['session:s1', 'project:D:/repo', 'global'],
      limits: { topK: 5 }, candidates: 12, filter: { rawHits: 15, tagFiltered: 2, supersededExcluded: 1, candidates: 12 },
      selected: { contentIds: ['mem-1'], hintIds: [], newlyAddedIds: ['mem-1'], count: 1 },
      omitted: [{ id: 'mem-2', reason: 'top_k', tags: ['release'] }],
      dedup: { skipped: 3, updated: 0, lastTextSame: false, ids: ['mem-3'] },
      budgets: { recall: { budget: 500, used: 321, remaining: 179, over: false } },
      retrieval: { ok: true, count: 15 }, query: { text: '发布 token=[REDACTED:key-assignment]', chars: 32, redacted: true, hash: 'fnv1a:def' },
    },
  ]
  ;(globalThis as Record<string, unknown>).fetch = async () => ({
    status: 200,
    json: async () => ({ ok: true, value: { entries, total: 2, stats: { entries: 2, capacity: 2000, perSessionCapacity: 200, dropped: 0, writeErrors: 0, persistence: 'memory' } } }),
  })
  const AuditTab = (exports.__test as { AuditTab: (p: Record<string, unknown>) => unknown }).AuditTab
  const opened: { record?: { id: string; scope?: string }; session?: string } = {}
  const records = [{
    id: 'mem-1', scope: 'project:D:/repo', kind: 'procedure',
    content: '发布前先检查 devcred 凭据，并确认版本号与工作区状态。',
    tags: ['release', 'publish'], importance: 0.8, updatedAt: Date.now(),
  }]
  const element = () => hooks.React.createElement(AuditTab, {
    scopes: [{ scope: 'session:s1', label: '测试会话' }],
    records,
    openRecord: (id: string, scope?: string) => { opened.record = { id, scope } },
    openSession: (id: string) => { opened.session = id },
    sessionInfo: () => ({ title: '测试会话', cwd: 'D:/repo', updatedAt: Date.now(), running: true }),
  })
  let current: RenderNode | null = render(element(), hooks)
  hooks.setRerender(() => { current = render(element(), hooks) })
  hooks.runEffects()
  for (let i = 0; i < 8; i++) await Promise.resolve()
  const text = textOf(current)
  assert.ok(!text.includes('记忆审计'))
  assert.ok(text.includes('召回'), '通道名渲染')
  assert.ok(text.includes('已准备（投递未确认）'), 'unknown 投递不冒充已投递')
  assert.ok(text.includes('发布 token=[REDACTED:key-assignment]') === false, '列表不直接展示 query 原文')
  const nodes = collect(current)
  assert.ok(nodes.some((n) => String(n.props?.className ?? '').split(/\s+/).includes('audit-list')), '事件放在独立滚动容器里')
  assert.ok(nodes.some((n) => String(n.props?.className ?? '').split(/\s+/).includes('audit-table-head')), '列表有表头')
  assert.ok(nodes.some((n) => String(n.props?.className ?? '').split(/\s+/).includes('audit-budget-compact')), '行内预算使用紧凑条')
  assert.ok(text.includes('候选 / 选中 / 省略'), '表头列名可见')
  assert.ok(nodes.some((n) => String(n.props?.className ?? '').split(/\s+/).includes('audit-filter-row')), '筛选分两行布局')
  const nativeInputs = nodes.filter((n) => n.tag === 'input').map((n) => String(n.props?.type ?? ''))
  assert.ok(!nativeInputs.includes('date') && !nativeInputs.includes('checkbox'), '筛选使用自绘控件，不用原生 date/checkbox')
  const row = collect(current)
    .filter((n) => String(n.props?.className ?? '').startsWith('audit-row'))
    .find((n) => textOf(n).includes('召回'))
  assert.ok(row, '召回事件行存在')
  ;(row!.props!.onClick as () => void)()
  for (let i = 0; i < 2; i++) await Promise.resolve()
  const detail = textOf(current)
  assert.ok(detail.includes('检索与过滤'))
  assert.ok(detail.includes('原始命中'))
  assert.ok(detail.includes('省略 · 条数上限'))
  assert.ok(detail.includes('选中正文'))
  assert.ok(detail.includes('候选中的可枚举 ID'))
  assert.ok(detail.includes('fnv1a:def'), '详情展示已脱敏 query 的 hash')

  // 记忆 ID hover 显示原文浮窗，点击跳转到记录页。
  const recordChip = collect(current)
    .filter((n) => n.tag === 'button' && String(n.props?.className ?? '').split(/\s+/).includes('audit-id'))
    .find((n) => textOf(n).includes('mem-1'))
  assert.ok(recordChip, '选中记忆 ID 是按钮')
  ;(recordChip!.props!.onMouseEnter as (e: unknown) => void)({ clientX: 120, clientY: 120 })
  await new Promise((resolve) => setTimeout(resolve, 420))
  assert.ok(textOf(current).includes('发布前先检查 devcred 凭据'), 'hover 显示记忆原文')
  assert.ok(textOf(current).includes('mem-1'), '浮窗显示完整 ID')
  const tipNode = collect(current).find((n) => String(n.props?.className ?? '').split(/\s+/).includes('audit-tip'))
  assert.ok(tipNode, '浮窗已显示')
  ;(tipNode!.props!.onClick as () => void)()
  for (let i = 0; i < 2; i++) await Promise.resolve()
  assert.deepEqual(opened.record, { id: 'mem-1', scope: 'project:D:/repo' }, '点击浮窗也跳转')
  opened.record = undefined
  ;(recordChip!.props!.onClick as () => void)()
  for (let i = 0; i < 2; i++) await Promise.resolve()
  assert.deepEqual(opened.record, { id: 'mem-1', scope: 'project:D:/repo' })

  // 会话 ID hover 显示会话信息，点击打开会话。
  const sessionChip = collect(current)
    .filter((n) => n.tag === 'button' && String(n.props?.className ?? '').split(/\s+/).includes('audit-id'))
    .find((n) => textOf(n) === 's1')
  assert.ok(sessionChip, '会话 ID 是按钮')
  ;(sessionChip!.props!.onMouseEnter as (e: unknown) => void)({ clientX: 130, clientY: 130 })
  await new Promise((resolve) => setTimeout(resolve, 420))
  assert.ok(textOf(current).includes('测试会话'), 'hover 显示会话标题')
  assert.ok(textOf(current).includes('ID s1'), '浮窗显示完整会话 ID')
  ;(sessionChip!.props!.onClick as () => void)()
  for (let i = 0; i < 2; i++) await Promise.resolve()
  assert.equal(opened.session, 's1')
  hooks.resetAll()
})

test('作用域下拉用服务端给的 label(会话标题 / project 的 cwd)', async () => {
  const { hooks } = await loadBundle()
  hooks.resetAll()
  const tree = await mountPanel(hooks, {
    scopes: [
      { scope: 'global', records: 1, pendingEmbeds: 0, label: 'global:全局' },
      { scope: 'project:C:/demo', records: 1, pendingEmbeds: 0, label: 'C:/demo' },
      { scope: 'session:sess-12345678', records: 1, pendingEmbeds: 0, label: 'session:重构记忆作用域(sess-12345678)' },
      { scope: 'handbook', records: 1, pendingEmbeds: 0, label: 'handbook' },
    ],
    embedServer: null,
  })
  // 统计卡与作用域下拉都在「记录」页(默认标签)
  assert.ok(textOf(tree()).includes('4'), '作用域数来自 /status 的动态枚举')
  // 打开作用域下拉(结构里第二个 aria-haspopup=listbox;第一个是模型/运行时下拉),
  // 选项文字必须用 label(而不是原始 scope 键)
  const dropdowns = collect(tree()).filter((n) => n.props?.['aria-haspopup'] === 'listbox')
  assert.ok(dropdowns.length >= 1, '找到自绘下拉')
  const scopeDropdown = dropdowns.find((n) => textOf(n).includes('全部作用域'))
  assert.ok(scopeDropdown, '找到作用域下拉')
  ;(scopeDropdown.props!.onClick as () => void)()
  hooks.runEffects()
  const optionTexts = collect(tree())
    .filter((n) => n.props?.role === 'option')
    .map((n) => textOf(n))
  assert.ok(optionTexts.includes('session:重构记忆作用域(sess-12345678)'), `下拉里显示会话标题(实际:${JSON.stringify(optionTexts)})`)
  assert.ok(optionTexts.includes('C:/demo'), 'project scope 显示 cwd')
  assert.ok(!optionTexts.includes('session:sess-12345678'), '不再回退成裸 scope 键')
})

test('记录页:记忆 / 作用域 子标签页;作用域页展示名称 · 条数 · 用途', async () => {
  const { hooks } = await loadBundle()
  hooks.resetAll()
  const state = {
    scopes: [
      { scope: 'handbook', records: 2, pendingEmbeds: 0, label: 'custom:handbook', description: '团队约定与发布流程', updatedAt: 1_700_000_000_000 },
      { scope: 'global', records: 1, pendingEmbeds: 0, label: 'global:全局', description: '全局作用域：跨项目共享的通用事实与偏好', updatedAt: 1_600_000_000_000 },
      { scope: 'project:C:/demo', records: 0, pendingEmbeds: 0, label: 'project:C:/demo' },
    ],
    embedServer: null,
  }
  const tree = await mountPanel(hooks, state)
  // 默认落在「记忆」子标签页:记忆列表 / 工具栏在,作用域用途不在
  const memoriesTab = () => collect(tree()).find((n) => n.tag === 'button' && textOf(n).trim() === '记忆')
  const scopesTab = () => collect(tree()).find((n) => n.tag === 'button' && textOf(n).trim() === '作用域')
  assert.ok(memoriesTab(), '记录页有「记忆」子标签页')
  assert.ok(scopesTab(), '记录页有「作用域」子标签页')
  assert.ok(String(memoriesTab()!.props?.className).includes('on'), '默认选中「记忆」')
  assert.ok(!textOf(tree()).includes('团队约定与发布流程'), '记忆子标签页不列作用域')

  ;(scopesTab()!.props!.onClick as () => void)()
  hooks.runEffects()
  const text = textOf(tree())
  assert.ok(text.includes('团队约定与发布流程'), '作用域页展示手写用途')
  assert.match(text, /全局作用域/, '没写过用途的按类型补默认描述')
  assert.ok(text.includes('2 条记忆') && text.includes('1 条记忆'), '展示各作用域的记忆条数')
  assert.ok(text.includes('custom:handbook') && text.includes('global:全局'), '名称带类型前缀')
  assert.ok(text.includes('（未填写用途）'), '既没有手写也没有默认描述时如实写「未填写用途」')
  assert.ok(!textOf(tree()).includes('新建'), '作用域页没有「新建记忆」的入口')

  // 「查看记忆」→ 切回记忆子标签页,并按该作用域重新拉列表
  const calls: string[] = []
  const savedFetch = (globalThis as Record<string, unknown>).fetch
  ;(globalThis as Record<string, unknown>).fetch = async (url: string) => {
    calls.push(String(url))
    return { status: 200, json: async () => ({ ok: true, value: String(url).includes('/status') ? state : { records: [] } }) }
  }
  try {
    const view = collect(tree()).find((n) => n.tag === 'button' && textOf(n).trim() === '查看记忆')
    assert.ok(view, '有记录的作用域带「查看记忆」')
    ;(view!.props!.onClick as () => void)()
    for (let i = 0; i < 6; i++) await Promise.resolve()
    hooks.runEffects()
    for (let i = 0; i < 6; i++) await Promise.resolve()
    assert.ok(calls.some((url) => url.includes('records?scope=handbook')), `按作用域过滤重新拉列表(实际:${calls.join(', ')})`)
    assert.ok(String(memoriesTab()!.props?.className).includes('on'), '切回「记忆」子标签页')
    assert.ok(!textOf(tree()).includes('团队约定与发布流程'), '回到记忆列表')
  } finally {
    ;(globalThis as Record<string, unknown>).fetch = savedFetch
  }
  hooks.resetAll()
})

test('作用域页:编辑用途 / 别名(别名可选),保存走 /scope-meta 并刷新;默认描述不预填', async () => {
  const { hooks } = await loadBundle()
  hooks.resetAll()
  const state = {
    scopes: [
      { scope: 'handbook', records: 2, pendingEmbeds: 0, label: 'custom:handbook', name: '工作手册', description: '团队约定与发布流程', descriptionSource: 'custom', updatedAt: 3 },
      { scope: 'global', records: 1, pendingEmbeds: 0, label: 'global:全局', description: '全局作用域：跨项目共享', descriptionSource: 'default', updatedAt: 2 },
      { scope: 'session:sess-1', records: 0, pendingEmbeds: 0, label: 'session:sess-1', description: '会话作用域：仅本会话可见', descriptionSource: 'default', updatedAt: 1 },
    ],
    embedServer: null,
  }
  const tree = await mountPanel(hooks, state)
  ;(collect(tree()).find((n) => n.tag === 'button' && textOf(n).trim() === '作用域')!.props!.onClick as () => void)()
  hooks.runEffects()

  const rows = () => collect(tree()).filter((n) => String(n.props?.className ?? '') === 'scope-row')
  const rowOf = (needle: string) => rows().find((n) => textOf(n).includes(needle))!
  const buttonOf = (node: RenderNode, label: string) => collect(node).find((n) => n.tag === 'button' && textOf(n).trim() === label)!
  const textarea = () => collect(tree()).find((n) => n.tag === 'textarea')
  const aliasInput = () => collect(tree()).find((n) => n.tag === 'input' && String(n.props?.placeholder ?? '').includes('移除别名'))

  // 默认描述的行：编辑框不预填，保存时不允许把默认文案固化成手写内容。
  ;(buttonOf(rowOf('global:全局'), '编辑').props!.onClick as () => void)()
  assert.equal(textarea()!.props?.value, '', '默认描述不预填')
  assert.ok(textOf(tree()).includes('默认描述'), '默认描述有标注')
  ;(buttonOf(rows().find((n) => textOf(n).includes('global:全局'))!, '取消').props!.onClick as () => void)()

  // global / session 不支持别名：编辑框里不给别名字段，只说明一句。
  ;(buttonOf(rowOf('session:sess-1'), '编辑').props!.onClick as () => void)()
  assert.equal(aliasInput(), undefined, 'session 作用域没有别名字段')
  assert.ok(textOf(tree()).includes('不支持别名'), '说明为什么不给别名')
  ;(buttonOf(rows().find((n) => textOf(n).includes('session:sess-1'))!, '取消').props!.onClick as () => void)()

  // 手写用途 + 别名：都预填，改完保存 → POST /scope-meta。
  ;(buttonOf(rowOf('custom:handbook'), '编辑').props!.onClick as () => void)()
  assert.equal(textarea()!.props?.value, '团队约定与发布流程', '手写用途预填')
  ;(textarea()!.props!.onChange as (e: unknown) => void)({ target: { value: '团队约定、发布与回滚流程' } })
  assert.equal(aliasInput()!.props?.value, '工作手册', '别名预填')
  ;(aliasInput()!.props!.onChange as (e: unknown) => void)({ target: { value: '团队手册' } })

  const calls: Array<{ url: string; body: string | undefined }> = []
  const savedFetch = (globalThis as Record<string, unknown>).fetch
  ;(globalThis as Record<string, unknown>).fetch = async (url: string, init?: { body?: string }) => {
    calls.push({ url: String(url), body: init?.body })
    // 保存后组件会重新拉 /status 与 /records：两个形状都得给全，否则列表拿到 undefined。
    return {
      status: 200,
      json: async () => ({ ok: true, value: String(url).includes('/status') ? state : { records: [] } }),
    }
  }
  try {
    ;(buttonOf(rows().find((n) => textOf(n).includes('custom:handbook'))!, '保存').props!.onClick as () => void)()
    for (let i = 0; i < 8; i++) await Promise.resolve()
    const call = calls.find((item) => item.url.endsWith('/scope-meta'))
    assert.ok(call, `应该 POST /scope-meta（实际:${calls.map((c) => c.url).join(', ')}）`)
    assert.deepEqual(JSON.parse(String(call!.body)), {
      scope: 'handbook',
      description: '团队约定、发布与回滚流程',
      name: '团队手册',
    })
    assert.equal(textarea(), undefined, '保存后编辑框关闭')
    assert.ok(textOf(tree()).includes('已保存'), '保存后有反馈')
  } finally {
    ;(globalThis as Record<string, unknown>).fetch = savedFetch
  }
  hooks.resetAll()
})

test('会话作用域展示名:客户端也取会话 id 前 16 位(前 8 位恒为 session-)', async () => {
  const { exports } = await loadBundle()
  const helpers = exports.__test as {
    sessionShortId: (id: string) => string
    scopeDisplayName: (scope: string, humanName?: string) => string
    scopeTypePrefix: (scope: string) => string
    scopeTitle: (scope: string, label?: string) => string
    scopeLabel: (scope: string, labels?: Record<string, string>) => string
  }
  const real = 'session-1a2b3c4d-0000-4000-8000-000000000001'
  // 真机 id 以 `session-` 开头(正好 8 个字符):8 位会让所有会话都显示成同一个名字。
  assert.equal(helpers.sessionShortId(real), 'session-1a2b3c4d')
  assert.equal(helpers.scopeDisplayName(`session:${real}`), 'session:session-1a2b3c4d')
  assert.equal(helpers.scopeLabel(`session:${real}`, {}), 'session:session-1a2b3c4d', '回退标签同口径')
  // 服务端给了 label 就用服务端的(服务端能查会话标题)
  assert.equal(helpers.scopeLabel(`session:${real}`, { [`session:${real}`]: 'session:修层级(1a2b3c4d)' }), 'session:修层级(1a2b3c4d)')
  // 两个会话不能显示成同一个名字
  assert.notEqual(
    helpers.scopeDisplayName(`session:${real}`),
    helpers.scopeDisplayName('session:session-99887766-0000-4000-8000-000000000002'),
  )
  // 短 id 原样返回;异常输入不抛错
  assert.equal(helpers.sessionShortId('sess-abc12345'), 'sess-abc12345')
  assert.doesNotThrow(() => helpers.sessionShortId(undefined as unknown as string))
  // 四种类型的名字都自带前缀(global 与自定义的键本来没有前缀)
  assert.equal(helpers.scopeLabel('global', {}), 'global:全局')
  assert.equal(helpers.scopeLabel('project:/w', {}), 'project:/w')
  assert.equal(helpers.scopeLabel('handbook', {}), 'custom:handbook')
  assert.equal(helpers.scopeDisplayName('handbook', '工作笔记'), 'custom:工作笔记')
  assert.equal(helpers.scopeTypePrefix('global'), 'global:')
  assert.equal(helpers.scopeTypePrefix('handbook'), 'custom:')
  // 悬停提示:`显示名 → 真实键`;名字与键相同时不重复(0.25.11)
  const pocketKey = String.raw`project:D:\DeepseekHarnessProjects\dsh-pocket`
  assert.equal(helpers.scopeTitle(pocketKey, 'project:dsh-pocket'), `project:dsh-pocket → ${pocketKey}`)
  assert.equal(helpers.scopeTitle('project:D:\w', 'project:D:\w'), 'project:D:\w', '名字与键相同不重复')
  assert.equal(helpers.scopeTitle('global'), 'global:全局 → global')
})
test('记忆权限浮窗:只有显示名与真实键不同才多出一行完整键;键行靠 CSS 省略而不是手工截断', async () => {
  const { exports, hooks } = await loadBundle()
  hooks.resetAll()
  // CSS:完整键要能按容器宽度自动省略(不写死截断长度)
  const css = (exports.__test as { CSS: string }).CSS
  assert.match(css, /\.mem-scope-key\{[^}]*white-space:nowrap[^}]*overflow:hidden[^}]*text-overflow:ellipsis/, '键行按容器宽度省略')
  assert.match(css, /\.mem-scope-key\{[^}]*font-size:10px/, '键行比名字小一档')

  const Button = (exports.__test as { MemoryVisibilityButton: (p: Record<string, unknown>) => unknown }).MemoryVisibilityButton
  const payload = {
    sessionId: 's1',
    override: null,
    effective: { level: 'normal', scopes: [{ scope: 'session:s1' }, { scope: 'project:D:\w' }] },
    source: 'default',
    inherited: false,
    defaults: ['session:s1', 'project:D:\w'],
    defaultScopes: ['session:s1', 'project:D:\w'],
    bindings: [],
    scopes: [
      { scope: 'session:s1', label: 'session:当前会话', records: 1 },
      // 没有别名的项目作用域:显示名就是完整键,不该再多一行
      { scope: 'project:D:\w', label: 'project:D:\w', records: 2 },
      { scope: 'handbook', label: 'custom:handbook', records: 1 },
    ],
  }
  const savedFetch = (globalThis as Record<string, unknown>).fetch
  ;(globalThis as Record<string, unknown>).fetch = async (url: string) => {
    if (url.startsWith('/memory/api/grants?')) {
      return { status: 200, json: async () => ({ ok: true, value: { sessionId: 's1', grants: [] } }) }
    }
    return { status: 200, json: async () => ({ ok: true, value: payload }) }
  }
  try {
    let current: RenderNode | null = null
    const element = () => hooks.React.createElement(Button, { sessionId: 's1' })
    hooks.setRerender(() => { current = render(element(), hooks) })
    current = render(element(), hooks)
    hooks.runEffects()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const button = collect(current).find((n) => n.tag === 'button' && String(n.props?.className ?? '').includes('mem-scope-btn'))
    ;(button!.props!.onClick as (event: unknown) => void)({ currentTarget: { getBoundingClientRect: () => ({ left: 40, top: 500 }) } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    hooks.runEffects()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const keyLines = collect(current)
      .filter((n) => String(n.props?.className ?? '') === 'mem-scope-key')
      .map((n) => textOf(n))
    assert.ok(keyLines.includes('session:s1'), '会话行:显示名(session:当前会话)与键不同 → 露出键')
    assert.ok(keyLines.includes('handbook'), '自定义行:显示名(custom:handbook)与键不同 → 露出裸键')
    assert.ok(!keyLines.includes('project:D:\w'), '项目行:显示名与键相同 → 不重复渲染')
    // 键行也不许手工截断(不能出现自己加的省略号)
    assert.ok(!keyLines.some((line) => line.includes('…')), '完整键保持原样,省略交给 CSS')
  } finally {
    ;(globalThis as Record<string, unknown>).fetch = savedFetch
  }
  hooks.resetAll()
})

test('未配置的后端:展开「模型与硬件」给出模型列表与安装按钮,而不是一个死开关', async () => {
  const { hooks } = await loadBundle()
  hooks.resetAll()
  const state = {
    scopes: [{ scope: 'global', records: 3, pendingEmbeds: 3 }],
    embedServer: {
      enabled: false, configured: false, mode: 'off', endpoint: 'http://127.0.0.1:8078/v1/embeddings', model: 'bge-m3',
      spawnConfigured: false, owned: false, pid: null, baseUrl: '', reachable: false, pendingEmbeds: 3,
      install: installIdle(),
    },
  }
  // 统计卡在「记录」页:没有向量后端时不能假装有嵌入积压
  const dataTree = await mountPanel(hooks, state, undefined, '记录')
  assert.ok(textOf(dataTree()).includes('向量未启用'), 'the stats card does not pretend there is an embed backlog')
  hooks.resetAll()

  const tree = await mountPanel(hooks, state, undefined, '服务')
  const nodes = collect(tree())
  assert.equal(nodes.filter((n) => n.props?.role === 'switch').length, 0, 'no switch before a backend is configured')
  assert.ok(textOf(tree()).includes('向量检索为可选功能'), '可选说明紧跟在「模型与硬件」旁边')

  // 展开「模型与硬件」→ 才会去拉清单(硬件探测要等这一次请求)
  const details = nodes.find((n) => n.tag === 'details')
  assert.ok(details, '「模型与硬件」是折叠区块')
  ;(details!.props!.onToggle as (e: unknown) => void)({ target: { open: true } })
  // 展开触发重渲染,新收集到的 effect 要显式跑一次(测试脚手架的 mount 语义)
  hooks.runEffects()
  for (let i = 0; i < 8; i++) await Promise.resolve()

  const text = textOf(tree())
  assert.ok(chipTexts(tree()).includes('推荐'), `推荐项在列表里带「推荐」气泡(实际:${JSON.stringify(chipTexts(tree()))})`)
  assert.ok(!text.includes('这台机器'), '不再显示推荐理由')
  assert.ok(text.includes('下载并安装'), '安装按钮在模型区块里')

  // 点它必须 POST 到安装接口,并带上选中的模型(默认就是推荐项)
  const calls: Array<{ url: string; body: string | undefined }> = []
  ;(globalThis as Record<string, unknown>).fetch = async (url: string, init?: { body?: string }) => {
    calls.push({ url: String(url), body: init?.body })
    return { status: 200, json: async () => ({ ok: true, value: { install: installIdle() } }) }
  }
  const button = collect(tree()).find((n) => n.tag === 'button' && (n.children ?? []).some((c) => c.text === '下载并安装'))
  assert.ok(button, 'installer button found')
  ;(button!.props!.onClick as () => void)()
  await Promise.resolve()
  const install = calls.find((c) => c.url.endsWith('/embed/install'))
  assert.ok(install, `expected an install POST, got ${calls.map((c) => c.url).join(', ')}`)
  assert.match(String(install!.body), /qwen3-embedding-0\.6b/, '安装请求带上推荐(默认选中)的模型')
})

test('「本机配置」「当前模型」两行:都带标题、都横向滚动,安装按钮在当前模型行右边', async () => {
  const { hooks, exports } = await loadBundle()
  hooks.resetAll()
  // 未配置:挂载后立刻就有内容(不等展开),当前模型 = 默认选中的推荐项
  const tree = await mountPanel(hooks, {
    scopes: [{ scope: 'global', records: 0, pendingEmbeds: 0 }],
    embedServer: {
      enabled: false, configured: false, mode: 'off', endpoint: 'http://127.0.0.1:8078/v1/embeddings', model: 'bge-m3',
      spawnConfigured: false, owned: false, pid: null, baseUrl: '', reachable: false, pendingEmbeds: 0, install: installIdle(),
    },
  }, undefined, 'records')
  const all = chipTexts(tree())
  // 本机配置在上面一行,当前模型在下面一行
  assert.deepEqual(all.slice(0, 4), ['12 核', '14GB 内存', '无独立显卡', '磁盘剩余 9GB'], `本机配置气泡:${JSON.stringify(all.slice(0, 4))}`)
  assert.deepEqual(all.slice(4, 9), ['Qwen3-Embedding-0.6B', 'Q8_0', '1024 维', 'last', 'cpu'], `当前模型气泡:${JSON.stringify(all.slice(4, 9))}`)

  const text = textOf(tree())
  assert.ok(text.includes('本机配置：'), '本机配置行有标题')
  assert.ok(text.includes('当前模型：'), '当前模型行有标题')
  assert.ok(text.includes('▸') && text.includes('模型与硬件'), '折叠标题左边有展开标志')

  // 两行结构:[标题][气泡(横向滚动)][动作按钮(居右)]
  const lines = collect(tree()).filter((n) => String(n.props?.className ?? '') === 'chipline')
  assert.equal(lines.length, 2, '两行:本机配置 / 当前模型')
  const row1 = lines[0]!.children ?? []
  const row2 = lines[1]!.children ?? []
  assert.deepEqual(row1[0]!.children!.map((c) => c.text), ['本机配置：'])
  assert.equal(String(row1[1]!.props?.className), 'chips')
  assert.deepEqual(row1[2]!.children!.map((c) => c.text), ['重新检测硬件'], '重新检测硬件在本机配置行最右边')
  assert.deepEqual(row2[0]!.children!.map((c) => c.text), ['当前模型：'])
  assert.equal(String(row2[1]!.props?.className), 'chips')
  assert.ok(String(row2[2]!.props?.className).includes('install'), '安装按钮在当前模型行、居右')
  assert.ok(text.includes('下载并安装'))

  // 两行都用同一套"不换行 + 横向滚动"的样式(CSS 契约)
  const css = (exports.__test as { CSS: string }).CSS
  const chipsRule = /\.memp \.chips\{([^}]*)\}/.exec(css)?.[1] ?? ''
  assert.match(chipsRule, /flex-wrap:nowrap/, `气泡行不换行:${chipsRule}`)
  assert.match(chipsRule, /overflow-x:auto/, `气泡行横向滚动:${chipsRule}`)
  assert.match(chipsRule, /scrollbar-width:none/, `气泡行不显示滚动条:${chipsRule}`)
  assert.match(css, /\.memp \.chips::-webkit-scrollbar\{display:none/, 'Chromium 下也藏掉滚动条')
  assert.match(css, /button:hover\{[^}]*brand-primary/, '按钮统一有 hover 反馈')

  // 已配置:显示实际配置(不受列表里的默认选择影响)
  hooks.resetAll()
  const configuredTree = await mountPanel(hooks, {
    scopes: [{ scope: 'global', records: 0, pendingEmbeds: 0 }],
    embedServer: {
      enabled: true, configured: true, mode: 'managed', endpoint: 'http://127.0.0.1:8078/v1/embeddings', model: 'bge-m3',
      modelLabel: 'BGE-M3 · Q4_K_M', presetId: 'bge-m3', variantId: 'q4_k_m', dims: 1024, pooling: 'cls', flavor: 'cpu',
      spawnConfigured: true, owned: true, pid: 7, baseUrl: 'http://127.0.0.1:8078', reachable: true, pendingEmbeds: 0, install: installIdle({ installed: true }),
    },
  }, undefined, 'records')
  const configured = chipTexts(configuredTree())
  assert.deepEqual(configured.slice(4, 9), ['BGE-M3', 'Q4_K_M', '1024 维', 'cls', 'cpu'], `已配置时的当前模型:${JSON.stringify(configured)}`)

  // 自绘下拉:服务页是模型 / 运行时,作用域下拉在记录页;全站没有原生 select
  const nodes = collect(configuredTree())
  assert.equal(nodes.filter((n) => n.tag === 'select').length, 0, '不再使用原生 select')
  assert.equal(nodes.filter((n) => n.props?.['aria-haspopup'] === 'listbox').length, 2, '服务页有模型 / 运行时两个自绘下拉')
  await switchTab(configuredTree, hooks, '记录')
  assert.equal(collect(configuredTree()).filter((n) => n.props?.['aria-haspopup'] === 'listbox').length, 2, '记录页有作用域 + 是否被修正两个下拉')
  await switchTab(configuredTree, hooks, '服务')

  // 已装好的那一档:按钮显示「已安装」且不可点(点它只会重复下载)
  const installBtn = nodes.find((n) => String(n.props?.className ?? '') === 'install')
  assert.ok(installBtn, '安装按钮存在')
  assert.equal((installBtn!.children ?? []).map((c) => c.text).join(''), '已安装', '已装好的档位按钮文案')
  assert.equal(installBtn!.props?.disabled, true, '已装好的档位按钮不可点')

  // 换一个还没装的档 → 已经装了 bge-m3,所以这里必须要求先卸载,而不是直接再装一个
  // (第一个 listbox 触发器就是模型下拉:它在树里排在运行时/作用域前面)
  const trigger = collect(configuredTree()).find((n) => n.props?.['aria-haspopup'] === 'listbox')!
  ;(trigger.props!.onClick as () => void)()          // 展开
  const option = collect(configuredTree()).find((n) => n.props?.role === 'option' && textOf(n).includes('Qwen3-Embedding-0.6B'))!
  assert.ok(option, '下拉里能找到未安装的那一档')
  ;(option.props!.onClick as () => void)()           // 选中 qwen3(未安装)
  const after = collect(configuredTree()).find((n) => String(n.props?.className ?? '') === 'install')
  assert.equal((after!.children ?? []).map((c) => c.text).join(''), '需先卸载', '已装过模型时不许再装第二个')
  assert.equal(after!.props?.disabled, true, '必须先卸载才能换模型')
})

test('已经装了模型就不许再装:必须先卸载;卸载后按钮恢复可点', async () => {
  const { hooks } = await loadBundle()
  hooks.resetAll()

  // 起点:装着 bge-m3(后端快照 + 清单都标已装),面板处于托管态
  const report = modelReport()
  report.catalog[0]!.installed = true
  report.catalog[0]!.variants[0]!.installed = true
  const state: { scopes: unknown[]; embedServer: Record<string, unknown> } = {
    scopes: [{ scope: 'global', records: 0, pendingEmbeds: 0 }],
    embedServer: {
      enabled: true, configured: true, mode: 'managed', endpoint: 'http://127.0.0.1:8078/v1/embeddings', model: 'bge-m3',
      modelLabel: 'BGE-M3 · Q4_K_M', presetId: 'bge-m3', variantId: 'q4_k_m', dims: 1024, pooling: 'cls', flavor: 'cpu',
      spawnConfigured: true, owned: true, pid: 7, baseUrl: 'http://127.0.0.1:8078', reachable: true, pendingEmbeds: 0,
      install: installIdle({ installed: true }),
    },
  }
  const tree = await mountPanel(hooks, state, report, 'records')
  const installBtn = () => collect(tree()).find((n) => String(n.props?.className ?? '') === 'install')
  const label = () => (installBtn()!.children ?? []).map((c) => c.text).join('')
  assert.equal(label(), '已安装', '装好的那一档显示已安装')
  assert.equal(installBtn()!.props?.disabled, true, '已安装不可点')

  // 选一个没装的档:不许直接再装一个 → 「需先卸载」
  const trigger = collect(tree()).find((n) => n.props?.['aria-haspopup'] === 'listbox')!
  ;(trigger.props!.onClick as () => void)()
  const option = collect(tree()).find((n) => n.props?.role === 'option' && textOf(n).includes('Qwen3-Embedding-0.6B'))!
  assert.ok(option, '下拉里能找到未安装的那一档')
  ;(option.props!.onClick as () => void)()
  assert.equal(label(), '需先卸载', '已装过模型时不许再装第二个')
  assert.equal(installBtn()!.props?.disabled, true, '必须先卸载')

  // 卸载:后端快照与清单都不再有已装档 → 点「刷新」重新取状态,按钮应当恢复
  report.catalog[0]!.installed = false
  report.catalog[0]!.variants[0]!.installed = false
  state.embedServer = {
    enabled: false, configured: false, mode: 'off', endpoint: '', model: 'bge-m3', spawnConfigured: false,
    owned: false, pid: null, baseUrl: '', reachable: false, pendingEmbeds: 0, install: installIdle({ installed: false }),
    maintenance: { usageBytes: 0, records: 0, storeDir: 'D:/stack/store' },
  }
  await switchTab(tree, hooks, '记录')
  const refresh = collect(tree()).find((n) => n.tag === 'button' && textOf(n).includes('刷新'))!
  assert.ok(refresh, '刷新按钮在数据页工具栏')
  ;(refresh.props!.onClick as () => void)()
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 6; i++) await Promise.resolve()
    hooks.runEffects()
  }
  await switchTab(tree, hooks, '服务')
  assert.equal(label(), '下载并安装', '卸载之后按钮回到「下载并安装」')
  assert.notEqual(installBtn()!.props?.disabled, true, '卸载之后可以装了')
})

test('记录卡编辑态的类型下拉也是自绘的(全站没有原生 select)', async () => {
  const { exports, hooks } = await loadBundle()
  hooks.resetAll()
  const RecordCard = (exports.__test as { RecordCard: (p: Record<string, unknown>) => unknown }).RecordCard
  let tree: RenderNode | null = null
  const element = () => hooks.React.createElement(RecordCard, { rec: makeRecord({ kind: 'note' }), onSaved: () => {}, onDeleted: () => {} })
  hooks.setRerender(() => { tree = render(element(), hooks) })
  tree = render(element(), hooks)
  const head = collect(tree).find((n) => String(n.props?.className ?? '').startsWith('rec-head'))
  assert.ok(head, '卡片头存在')
  ;(head!.props!.onClick as () => void)()
  const edit = collect(tree).find((n) => n.tag === 'button' && (n.children ?? []).some((c) => c.text === '编辑'))
  assert.ok(edit, '展开后能看到编辑按钮')
  ;(edit!.props!.onClick as () => void)()
  assert.equal(collect(tree).filter((n) => n.tag === 'select').length, 0, '编辑态没有原生 select')
  const dropdowns = collect(tree).filter((n) => n.props?.['aria-haspopup'] === 'listbox')
  assert.equal(dropdowns.length, 1, '类型是一个自绘下拉')
  // 打开后能选到别的类型
  ;(dropdowns[0]!.props!.onClick as () => void)()
  const options = collect(tree).filter((n) => n.props?.role === 'option').map((n) => textOf(n))
  assert.ok(options.includes('decision') && options.includes('note'), `类型选项:${JSON.stringify(options)}`)
})

test('空状态:还没有记忆,居中一行', async () => {
  const { hooks } = await loadBundle()
  hooks.resetAll()
  const tree = await mountPanel(hooks, {
    scopes: [], embedServer: null,
  })
  const empty = collect(tree()).find((n) => String(n.props?.className ?? '') === 'empty')
  assert.ok(empty, '空状态节点存在')
  assert.equal((empty!.children ?? []).map((c) => c.text).join(''), '还没有记忆')
})

test('下拉列表:点选项选中,点列表外面(或 Esc)关闭', async () => {
  const { hooks } = await loadBundle()
  hooks.resetAll()
  // 脚手架里的 document 只有 createElement/head —— 补一个记录监听器的最小实现
  const listeners: Record<string, Array<(e: unknown) => void>> = {}
  const doc = (globalThis as Record<string, unknown>).document as Record<string, unknown>
  doc.addEventListener = (type: string, fn: (e: unknown) => void) => { (listeners[type] ??= []).push(fn) }
  doc.removeEventListener = (type: string, fn: (e: unknown) => void) => {
    listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn)
  }

  const tree = await mountPanel(hooks, {
    scopes: [{ scope: 'global', records: 0, pendingEmbeds: 0 }],
    embedServer: {
      enabled: false, configured: false, mode: 'off', endpoint: 'http://127.0.0.1:8078/v1/embeddings', model: 'bge-m3',
      spawnConfigured: false, owned: false, pid: null, baseUrl: '', reachable: false, pendingEmbeds: 0, install: installIdle(),
    },
  })
  const openList = () => {
    const btn = collect(tree()).find((n) => n.props?.['aria-haspopup'] === 'listbox')!
    ;(btn.props!.onClick as () => void)()
    hooks.runEffects()
  }
  const options = () => collect(tree()).filter((n) => n.props?.role === 'option')

  assert.equal(options().length, 0, '默认不展开')
  openList()
  assert.ok(options().length >= 2, '点开后列出所有档位')
  assert.equal((listeners.click ?? []).length, 1, '打开时挂了外部点击监听')

  // 点在列表里面:不关
  for (const fn of listeners.click ?? []) fn({ target: { closest: () => ({}) } })
  assert.ok(options().length >= 2, '点列表内部不关')

  // 点在列表外面:关
  for (const fn of listeners.click ?? []) fn({ target: { closest: () => null } })
  assert.equal(options().length, 0, '点列表外面关闭')

  // Esc 也能关
  openList()
  for (const fn of listeners.keydown ?? []) fn({ key: 'Escape' })
  assert.equal(options().length, 0, 'Esc 关闭')
})

test('only a managed backend renders a switch; external and config-disabled do not', async () => {
  const { hooks } = await loadBundle()

  const managed = {
    enabled: true, configured: true, mode: 'managed', endpoint: 'http://127.0.0.1:8078/v1/embeddings', model: 'bge-m3',
    spawnConfigured: true, owned: true, pid: 42, baseUrl: 'http://127.0.0.1:8078', reachable: true, pendingEmbeds: 0,
    install: installIdle({ installed: true }),
  }

  hooks.resetAll()
  const managedTree = await mountPanel(hooks, { scopes: [], embedServer: managed }, undefined, 'records')
  const switches = collect(managedTree()).filter((n) => n.props?.role === 'switch')
  assert.equal(switches.length, 1, 'exactly one switch when this app owns the process')
  assert.ok(String(switches[0]!.props?.className).includes('toggle'), 'switch uses the toggle styling')
  assert.equal(switches[0]!.props?.['aria-checked'], true, 'on while reachable')
  assert.ok(textOf(managedTree()).includes('由本应用托管'), 'explains who owns the process')

  hooks.resetAll()
  const externalTree = await mountPanel(hooks, {
    scopes: [],
    embedServer: { ...managed, mode: 'external', spawnConfigured: false, owned: false, pid: null, install: installIdle() },
  }, undefined, 'records')
  assert.equal(collect(externalTree()).filter((n) => n.props?.role === 'switch').length, 0, 'no switch for an external service')
  assert.ok(textOf(externalTree()).includes('外部服务'), 'labels the service as external')

  hooks.resetAll()
  const offTree = await mountPanel(hooks, { scopes: [], embedServer: { ...managed, enabled: false } }, undefined, 'records')
  assert.equal(collect(offTree()).filter((n) => n.props?.role === 'switch').length, 0, 'no switch when the config disables vectors')
  assert.ok(textOf(offTree()).includes('已在配置里关闭'), 'says the config disabled it')
})

test('clicking install keeps polling even while the provider still reports idle', async () => {
  const { exports } = await loadBundle()
  const shouldPoll = (exports.__test as { shouldPollInstall: (phase: string, requested: boolean) => boolean }).shouldPollInstall
  assert.equal(shouldPoll('idle', false), false, 'nothing to poll before anything is running')
  // The regression this pins: POST /embed/install returns before the provider
  // flips the phase, so the very next status can still be 'idle' — polling must
  // already be on, otherwise the panel never shows a single progress update.
  assert.equal(shouldPoll('idle', true), true, 'a requested install polls even at idle')
  assert.equal(shouldPoll('downloading-runtime', false), true)
  assert.equal(shouldPoll('extracting', false), true)
  assert.equal(shouldPoll('done', true), false, 'stop polling once it settled')
  assert.equal(shouldPoll('error', true), false, 'stop polling after a failure')
})

test('maintenance asks before destroying: two-step confirm, and the right request', async () => {
  const { hooks } = await loadBundle()
  hooks.resetAll()
  const state = {
    scopes: [{ scope: 'global', records: 4, pendingEmbeds: 0 }],
    embedServer: {
      enabled: true, configured: true, mode: 'managed', endpoint: 'http://127.0.0.1:8078/v1/embeddings', model: 'bge-m3',
      spawnConfigured: true, owned: true, pid: 7, baseUrl: 'http://127.0.0.1:8078', reachable: true, pendingEmbeds: 0,
      install: installIdle({ installed: true }),
      maintenance: { usageBytes: 507510784, paths: ['D:/stack/llamacpp', 'D:/stack/models'], storeDir: 'D:/store', records: 4 },
    },
  }
  const tree = await mountPanel(hooks, state, undefined, 'records')

  const text = textOf(tree())
  assert.ok(text.includes('维护'), 'maintenance section is rendered')
  assert.ok(text.includes('卸载插件不会移除已配置的向量服务与记忆文件'), '说明卸载不会删文件')
  assert.ok(!text.includes('卸载插件不会删除这里的文件'), '旧的那句已经移除')
  assert.ok(text.includes('向量服务：484.0 MB'), `shows the size an uninstall would free (got: ${text.slice(0, 200)})`)
  assert.ok(text.includes('记忆数据：4 条'), 'shows how much data a wipe would remove')
  assert.ok(text.includes('重建全部向量'), '维护区有重建全部向量按钮')

  // Swap in a capturing stub: the panel's actions go through the global fetch.
  // Status/records keep answering, so the reload that follows an action renders
  // the same panel instead of blanking it.
  const calls: Array<{ url: string; body: unknown }> = []
  ;(globalThis as Record<string, unknown>).fetch = async (url: string, init?: { body?: string }) => {
    const target = String(url)
    if (target.includes('/status')) return { status: 200, json: async () => ({ ok: true, value: state }) }
    if (target.includes('/records')) return { status: 200, json: async () => ({ ok: true, value: { records: [] } }) }
    calls.push({ url: target, body: init?.body ? JSON.parse(init.body) : undefined })
    // The real routes answer with the whole spread status, not a fragment.
    return { status: 200, json: async () => ({ ok: true, value: { ...state.embedServer, install: installIdle() } }) }
  }
  // The panel reloads after any action (records + status), so only count the actions themselves.
  const actionCalls = () => calls.filter((c) => /\/embed\/|\/data\//.test(c.url))
  const findButton = (label: string) => collect(tree()).find((n) => n.tag === 'button'
    && (n.children ?? []).some((c) => typeof c.text === 'string' && c.text.includes(label)))

  // Uninstall: the first click only arms the confirmation, the second sends it.
  const uninstall = findButton('卸载向量服务')
  assert.ok(uninstall, 'uninstall button present')
  ;(uninstall!.props!.onClick as () => void)()
  assert.ok(textOf(tree()).includes('确认卸载'), 'first click asks for confirmation')
  assert.equal(actionCalls().length, 0, 'nothing is deleted on the first click')
  ;(findButton('确认卸载')!.props!.onClick as () => void)()
  for (let i = 0; i < 6; i++) await Promise.resolve()
  assert.equal(actionCalls().length, 1, `the confirmed click issues exactly one request (got ${actionCalls().length})`)
  assert.ok(actionCalls()[0]!.url.endsWith('/embed/uninstall'), `uninstall posts to its route (${actionCalls()[0]!.url})`)

  // Wipe: same two-step dance, and the irreversible call carries the token the
  // server demands (a bare click must never be enough).
  const wipe = findButton('清空记忆数据')
  assert.ok(wipe, 'wipe button present')
  ;(wipe!.props!.onClick as () => void)()
  assert.ok(textOf(tree()).includes('确认清空'), 'first click asks for confirmation')
  assert.equal(actionCalls().length, 1, 'nothing is wiped on the first click')
  ;(findButton('确认清空')!.props!.onClick as () => void)()
  for (let i = 0; i < 6; i++) await Promise.resolve()
  assert.equal(actionCalls().length, 2, `the confirmed click issues the wipe (got ${actionCalls().length})`)
  assert.ok(actionCalls()[1]!.url.endsWith('/data/wipe'), `wipe posts to its route (${actionCalls()[1]!.url})`)
  assert.deepEqual(actionCalls()[1]!.body, { confirm: 'delete' }, 'wipe carries the irreversible-action token')
})

test('the installer shows progress while downloading and an error with a retry', async () => {
  const { hooks } = await loadBundle()

  hooks.resetAll()
  const runningTree = await mountPanel(hooks, {
    scopes: [],
    embedServer: {
      enabled: false, configured: false, mode: 'off', endpoint: '', model: 'bge-m3', spawnConfigured: false,
      owned: false, pid: null, baseUrl: '', reachable: false, pendingEmbeds: 0,
      install: installIdle({ phase: 'downloading-model', message: '正在下载 bge-m3 模型', receivedBytes: 104857600, totalBytes: 437780480, installed: false }),
    },
  }, undefined, 'records')
  const runningText = textOf(runningTree())
  assert.ok(runningText.includes('正在下载 bge-m3 模型'), 'shows the installer message')
  assert.ok(/\d+%/.test(runningText), 'shows a percentage')
  assert.ok(runningText.includes('取消'), 'offers cancel while running')
  // 下载中「下载并安装」必须不可用(否则能反复点,重复发起下载)
  const installBtn = collect(runningTree()).find((n) => String(n.props?.className ?? '').includes('install'))
  assert.ok(installBtn, '安装按钮在树上')
  assert.equal(installBtn!.props?.disabled, true, '下载中安装按钮不可用')
  assert.equal((installBtn!.children ?? []).map((c) => c.text).join(''), '下载中…', '按钮文案变成「下载中…」')

  hooks.resetAll()
  const failedTree = await mountPanel(hooks, {
    scopes: [],
    embedServer: {
      enabled: false, configured: false, mode: 'off', endpoint: '', model: 'bge-m3', spawnConfigured: false,
      owned: false, pid: null, baseUrl: '', reachable: false, pendingEmbeds: 0,
      install: installIdle({ phase: 'error', message: 'GitHub API 限流', error: 'GitHub API 限流', installed: false }),
    },
  }, undefined, 'records')
  const failedText = textOf(failedTree())
  assert.ok(failedText.includes('GitHub API 限流'), 'surfaces the failure reason')
  assert.ok(failedText.includes('重试下载'), 'offers a retry')
})

test('设置标签页:读取注入设置、渲染各组开关并能保存', async () => {
  const { exports, hooks } = await loadBundle()
  hooks.resetAll()
  const settingsValue = {
    recall: { enabled: true, topK: 5, tokenBudget: 500 },
    digest: { enabled: true, topK: 8, tokenBudget: 400 },
    impression: { enabled: true, chars: 120 },
    policy: { enabled: true },
    rules: { enabled: true, maxItems: 10, tokenBudget: 300, delta: true },
    turnEnd: { enabled: false },
  }
  const calls: Array<{ url: string; method?: string; body?: string }> = []
  let posted: Record<string, unknown> | null = null
  ;(globalThis as Record<string, unknown>).fetch = async (url: unknown, init?: { method?: string; body?: string }) => {
    const u = String(url)
    calls.push({ url: u, method: init?.method, body: init?.body })
    if (u.includes('/settings')) {
      if (init?.method === 'POST') {
        posted = JSON.parse(String(init.body))
        return { status: 200, json: async () => ({ ok: true, value: posted }) }
      }
      return { status: 200, json: async () => ({ ok: true, value: settingsValue }) }
    }
    if (u.includes('/status')) return { status: 200, json: async () => ({ ok: true, value: { scopes: [], embedServer: null } }) }
    if (u.includes('/embed/model')) return { status: 200, json: async () => ({ ok: true, value: modelReport() }) }
    return { status: 200, json: async () => ({ ok: true, value: { records: [] } }) }
  }

  const MemoryPanel = (exports.__test as { MemoryPanel: (p: Record<string, unknown>) => unknown }).MemoryPanel
  const element = () => hooks.React.createElement(MemoryPanel, {})
  let current: RenderNode | null = render(element(), hooks)
  hooks.setRerender(() => { current = render(element(), hooks) })
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
  hooks.runEffects(); await flush(); hooks.runEffects(); await flush()

  const tab = collect(current).find((n) => n.tag === 'button' && textOf(n).trim() === '设置')
  assert.ok(tab, '面板里有「设置」标签')
  ;(tab!.props!.onClick as () => void)()
  hooks.runEffects(); await flush(); hooks.runEffects(); await flush()

  const text = textOf(current)
  for (const label of ['每轮召回', '印象形态', '会话摘要', '记忆使用策略', '硬性规则', '轮末提醒']) {
    assert.ok(text.includes(label), `设置页应显示「${label}」`)
  }

  // 没有「保存设置」按钮:拨动第一个开关(recall.enabled)后自动 POST
  assert.equal(collect(current).some((n) => n.tag === 'button' && textOf(n).trim() === '保存设置'), false)
  const firstSwitch = collect(current).find((n) => n.tag === 'button' && n.props?.role === 'switch')
  assert.ok(firstSwitch, '设置页用开关按钮')
  ;(firstSwitch!.props!.onClick as () => void)()
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.ok(posted, '改动即自动保存')
  assert.equal((posted as Record<string, unknown>).recall && ((posted as Record<string, unknown>).recall as { enabled?: boolean }).enabled, false)
  assert.ok(calls.some((c) => c.method === 'POST' && c.url.includes('/settings')))

  // 每个开关必须有可见的 label 与状态，不能只靠 tooltip。
  const groupSwitches = collect(current).filter((n) => String(n.props?.className ?? '') === 'setcard-enable')
  assert.ok(groupSwitches.length >= 5, `卡片头应有显式启用开关，实际 ${groupSwitches.length}`)
  for (const node of groupSwitches) {
    const label = textOf(node)
    assert.ok(label.includes('启用'), `卡片开关缺少可见「启用」: ${label}`)
    assert.ok(label.includes('已开启') || label.includes('已关闭'), `卡片开关缺少状态文案: ${label}`)
  }
  const fieldSwitches = collect(current)
    .filter((n) => String(n.props?.className ?? '') === 'setfield')
    .filter((n) => collect(n).some((child) => child.props?.role === 'switch'))
  assert.ok(fieldSwitches.length >= 2, '字段级开关也应存在')
  for (const field of fieldSwitches) {
    const label = collect(field).find((n) => String(n.props?.className ?? '') === 'setfield-label')
    assert.ok(label && textOf(label).trim().length > 0, '字段级开关缺少 label')
    assert.ok(collect(field).some((n) => String(n.props?.className ?? '') === 'setfield-hint'), '字段级开关缺少 hint')
    const text = textOf(field)
    assert.ok(text.includes('已开启') || text.includes('已关闭'), `字段级开关缺少状态文案: ${text}`)
  }
})

test('记录页:点「新建」出现表单,可选 rule 类型;设置页有导入/导出', async () => {
  const { exports, hooks } = await loadBundle()
  hooks.resetAll()
  ;(globalThis as Record<string, unknown>).fetch = async (url: unknown) => {
    const u = String(url)
    if (u.includes('/status')) return { status: 200, json: async () => ({ ok: true, value: { scopes: [], embedServer: null, rules: { total: 0, scopes: 0 } } }) }
    if (u.includes('/embed/model')) return { status: 200, json: async () => ({ ok: true, value: modelReport() }) }
    if (u.includes('/settings')) return { status: 200, json: async () => ({ ok: true, value: {
      recall: { enabled: true, topK: 5, tokenBudget: 500 },
      digest: { enabled: true, topK: 8, tokenBudget: 400 },
      impression: { enabled: true, chars: 120 },
      policy: { enabled: true },
      rules: { enabled: true, maxItems: 10, tokenBudget: 300, delta: true },
      turnEnd: { enabled: false },
    } }) }
    return { status: 200, json: async () => ({ ok: true, value: { records: [] } }) }
  }

  const MemoryPanel = (exports.__test as { MemoryPanel: (p: Record<string, unknown>) => unknown }).MemoryPanel
  const element = () => hooks.React.createElement(MemoryPanel, {})
  let current: RenderNode | null = render(element(), hooks)
  hooks.setRerender(() => { current = render(element(), hooks) })
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
  hooks.runEffects(); await flush(); hooks.runEffects(); await flush()

  const createBtn = collect(current).find((n) => n.tag === 'button' && textOf(n).trim() === '新建')
  assert.ok(createBtn, '记录页有「新建」按钮')
  ;(createBtn!.props!.onClick as () => void)()
  hooks.runEffects(); await flush()
  const afterOpen = textOf(current)
  assert.ok(afterOpen.includes('保存'), '表单有保存按钮')
  assert.ok(afterOpen.includes('取消'), '表单有取消按钮')

  // 切到设置页,确认数据区在
  const settingsTab = collect(current).find((n) => n.tag === 'button' && textOf(n).trim() === '设置')
  assert.ok(settingsTab)
  ;(settingsTab!.props!.onClick as () => void)()
  hooks.runEffects(); await flush(); hooks.runEffects(); await flush()
  const text = textOf(current)
  assert.ok(text.includes('导出全部'), '设置页有导出按钮')
  assert.ok(text.includes('导入文件'), '设置页有导入入口')
  assert.ok(text.includes('0 条规则'), '设置页显示规则条数')
})

test('记录页语义检索:开关、/search 请求、结果说明与相关度徽标', async () => {
  const { exports, hooks } = await loadBundle()
  hooks.resetAll()
  const state = {
    scopes: [{ scope: 'project:C:/demo', records: 2, pendingEmbeds: 0, label: 'C:/demo' }],
    embedServer: {
      enabled: true, configured: true, mode: 'managed', endpoint: 'http://127.0.0.1:8078/v1/embeddings', model: 'bge-m3',
      modelLabel: 'BGE-M3 · Q4_K_M', presetId: 'bge-m3', variantId: 'q4_k_m', dims: 1024, pooling: 'cls', flavor: 'cpu',
      spawnConfigured: true, owned: true, pid: 7, baseUrl: 'http://127.0.0.1:8078', reachable: true, pendingEmbeds: 0,
      install: installIdle({ installed: true }),
    },
  }
  const hits = [{ ...makeRecord({ id: 'mem-1', scope: 'project:C:/demo', content: '发布前检查 devcred 凭据' }), score: 0.8 }]
  const calls: string[] = []
  ;(globalThis as Record<string, unknown>).fetch = async (url: unknown) => {
    const u = String(url)
    calls.push(u)
    if (u.includes('/search')) return { status: 200, json: async () => ({ ok: true, value: { hits, mode: 'vector', embedded: 2, total: 2 } }) }
    if (u.includes('/status')) return { status: 200, json: async () => ({ ok: true, value: state }) }
    return { status: 200, json: async () => ({ ok: true, value: { records: [] } }) }
  }

  const MemoryPanel = (exports.__test as { MemoryPanel: (p: Record<string, unknown>) => unknown }).MemoryPanel
  const element = () => hooks.React.createElement(MemoryPanel, {})
  let current: RenderNode | null = render(element(), hooks)
  hooks.setRerender(() => { current = render(element(), hooks) })
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
  hooks.runEffects(); await flush(); hooks.runEffects(); await flush()

  /** 语义检索控件是一个真正的 toggle(轨道 + 圆点 + 可见状态),不是普通按钮。 */
  const findSemanticToggle = () => collect(current)
    .find((n) => n.tag === 'button' && n.props?.role === 'switch' && textOf(n).includes('语义检索'))

  // 输入查询词(不回车),再打开语义检索 → 有查询词时应立即按新模式重跑
  const input = collect(current).find((n) => n.tag === 'input')
  assert.ok(input, '记录页有搜索框')
  ;(input!.props!.onChange as (e: unknown) => void)({ target: { value: '发布凭据' } })
  await flush()
  calls.length = 0
  const toggle = findSemanticToggle()
  assert.ok(toggle, '搜索框旁有「语义检索」开关')
  assert.equal(toggle!.props?.role, 'switch', '控件是 switch,不是普通按钮')
  assert.equal(toggle!.props?.['aria-checked'], false, '默认关闭(关键词过滤)')
  assert.ok(String(toggle!.props?.className).split(/\s+/).includes('toggle'), '沿用向量服务的 toggle 造型')
  const toggleClassNames = collect(toggle).map((n) => String(n.props?.className ?? ''))
  assert.ok(toggleClassNames.includes('toggle-track'), '有轨道')
  assert.ok(toggleClassNames.includes('toggle-knob'), '有圆点')
  assert.ok(toggledText(toggle).includes('已关闭'), '关闭态有可见状态文案')
  ;(toggle!.props!.onClick as () => void)()
  // 不跑 runEffects:测试脚手架的 mount effect 每次 runEffects 都会重放,
  // 会把搜索词清空后的 /records 结果覆盖回来(真实 React 里 mount effect 只跑一次)。
  await flush()

  const searchCall = calls.find((u) => u.includes('/search?'))
  assert.ok(searchCall, `开启后应请求 /search(实际:${JSON.stringify(calls)})`)
  assert.ok(searchCall!.includes('q='), '查询词随请求发出')
  assert.equal(calls.some((u) => u.includes('/records?') || u.endsWith('/records')), false, '语义模式不再走关键词过滤')

  const text = textOf(current)
  assert.ok(text.includes('语义排序'), `结果说明标出向量参与了排序(${text.slice(0, 200)})`)
  assert.ok(text.includes('命中 1 条'), '结果条数')
  assert.ok(text.includes('向量覆盖 2/2 条'), '向量覆盖率')
  assert.ok(text.includes('得分 0.80'), '结果卡显示检索得分')
  assert.match(text, /发布前检查 devcred 凭据/, '命中内容来自 /search')
  const pressed = findSemanticToggle()
  assert.equal(pressed!.props?.['aria-checked'], true, '开关状态跟随')
  assert.ok(String(pressed!.props?.className).split(/\s+/).includes('on'), '开启态加上 .on(轨道变品牌色)')
  assert.ok(toggledText(pressed).includes('已开启'), '开启态有可见状态文案')
  // 深色模式:颜色全部来自宿主 token,不能写死色值
  const css = (exports.__test as { CSS: string }).CSS
  const stateRule = /\.memp \.toolbar \.semantic-state\{([^}]*)\}/.exec(css)?.[1] ?? ''
  const stateOnRule = /\.memp \.toolbar \.semantic\.on \.semantic-state\{([^}]*)\}/.exec(css)?.[1] ?? ''
  assert.match(stateRule, /var\(--dsw-alias-label-secondary\)/, `关闭态状态文字用次要标题色:${stateRule}`)
  assert.match(stateOnRule, /var\(--dsw-alias-brand-primary\)/, `开启态状态文字用品牌色:${stateOnRule}`)
  assert.doesNotMatch(stateRule + stateOnRule, /#[0-9a-f]{3,8}/i, '语义开关的状态文字不能写死颜色')
  hooks.resetAll()
})

test('记录页语义检索:向量不可用时开关禁用;服务端回退时说明原因', async () => {
  const { exports, hooks } = await loadBundle()
  hooks.resetAll()

  // 没有配置向量后端:开关可见但不可点(点了也只会给词法结果,容易误解)
  const offState = {
    scopes: [{ scope: 'global', records: 1, pendingEmbeds: 0 }],
    embedServer: {
      enabled: false, configured: false, mode: 'off', endpoint: '', model: 'bge-m3', spawnConfigured: false,
      owned: false, pid: null, baseUrl: '', reachable: false, pendingEmbeds: 0, install: installIdle(),
    },
  }
  let current = await mountPanel(hooks, offState)
  const offToggle = collect(current()).find((n) => n.tag === 'button' && n.props?.role === 'switch' && textOf(n).includes('语义检索'))
  assert.ok(offToggle, '未配置向量时开关仍然可见')
  assert.equal(offToggle!.props?.disabled, true, '未配置向量时不可开启')
  assert.equal(offToggle!.props?.['aria-checked'], false, '禁用时仍如实报告关闭')
  hooks.resetAll()

  // 已配置但这次嵌入失败:服务端返回 lexical + embed-failed,面板要写明回退原因
  const state = {
    scopes: [{ scope: 'project:C:/demo', records: 2, pendingEmbeds: 0, label: 'C:/demo' }],
    embedServer: {
      enabled: true, configured: true, mode: 'managed', endpoint: 'http://127.0.0.1:8078/v1/embeddings', model: 'bge-m3',
      spawnConfigured: true, owned: true, pid: 7, baseUrl: 'http://127.0.0.1:8078', reachable: false, pendingEmbeds: 0,
      install: installIdle({ installed: true }),
    },
  }
  ;(globalThis as Record<string, unknown>).fetch = async (url: unknown) => {
    const u = String(url)
    if (u.includes('/search')) {
      return {
        status: 200,
        json: async () => ({ ok: true, value: { hits: [], mode: 'lexical', reason: 'embed-failed', embedded: 2, total: 2 } }),
      }
    }
    if (u.includes('/status')) return { status: 200, json: async () => ({ ok: true, value: state }) }
    return { status: 200, json: async () => ({ ok: true, value: { records: [] } }) }
  }
  const MemoryPanel = (exports.__test as { MemoryPanel: (p: Record<string, unknown>) => unknown }).MemoryPanel
  const element = () => hooks.React.createElement(MemoryPanel, {})
  current = render(element(), hooks)
  hooks.setRerender(() => { current = render(element(), hooks) })
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
  hooks.runEffects(); await flush(); hooks.runEffects(); await flush()

  const input = collect(current).find((n) => n.tag === 'input')!
  ;(input.props!.onChange as (e: unknown) => void)({ target: { value: '任何查询' } })
  await flush()
  const toggle = collect(current).find((n) => n.tag === 'button' && n.props?.role === 'switch' && textOf(n).includes('语义检索'))!
  ;(toggle.props!.onClick as () => void)()
  await flush()

  const text = textOf(current)
  assert.ok(text.includes('关键词回退'), `回退结果要有明确标注(${text.slice(0, 200)})`)
  assert.ok(text.includes('向量服务没有响应'), '说明回退原因是向量服务不可用')
  assert.ok(text.includes('没有语义相关的记忆'), '零命中时给出语义空状态')
  hooks.resetAll()
})

test('记录卡:标签渲染成气泡,修正关系两个方向都有明确徽标', async () => {
  const { exports, hooks } = await loadBundle()
  hooks.resetAll()
  const RecordCard = (exports.__test as { RecordCard: (p: Record<string, unknown>) => unknown }).RecordCard

  let tree: RenderNode | null = null
  let current: Record<string, unknown> = makeRecord({ tags: ['pnpm', '工具链'], supersedes: 'abcdef1234567890' })
  const element = () => hooks.React.createElement(RecordCard, { rec: current, onSaved: () => {}, onDeleted: () => {} })
  hooks.setRerender(() => { tree = render(element(), hooks) })
  tree = render(element(), hooks)

  // 折叠时不显示标签(避免列表变吵)
  assert.ok(!textOf(tree).includes('pnpm'), '折叠状态不显示标签')
  // 展开后:内容、完整 id、标签一起出现
  const head = collect(tree).find((n) => String(n.props?.className ?? '') === 'rec-head')
  assert.ok(head, '卡片头存在')
  ;(head!.props!.onClick as () => void)()
  const text = textOf(tree)
  assert.ok(text.includes('pnpm') && text.includes('工具链'), `标签在展开区(${text})`)
  assert.ok(text.includes('rec-1'), '展开后显示记录 id')
  assert.ok(text.includes('修正自 abcdef12'), '修正版徽标带旧记录 id 前缀')

  current = makeRecord({ tags: [], supersededBy: 'ffff000011112222' })
  tree = render(element(), hooks)
  assert.ok(textOf(tree).includes('已被修正'), '被修正的记录有「已被修正」徽标')
})

test('记录页「是否被修正」筛选:默认隐藏旧版本,可切到全部 / 只看已修正', async () => {
  const { hooks } = await loadBundle()
  hooks.resetAll()
  const old = makeRecord({ id: 'old', content: '旧事实正文', supersededBy: 'new' })
  const fresh = makeRecord({ id: 'new', content: '新事实正文', supersedes: 'old' })
  const tree = await mountPanel(hooks, {
    scopes: [{ scope: 'project:C:/demo', records: 2, pendingEmbeds: 0 }],
    embedServer: null,
  }, undefined, 'data', [old, fresh])
  const drop = () => {
    const list = collect(tree()).filter((n) => n.props?.['aria-haspopup'] === 'listbox')
    return list[list.length - 1]
  }
  assert.ok(drop(), '记录页有「是否被修正」下拉')
  assert.ok(textOf(tree()).includes('新事实正文'), '默认显示未修正记录')
  assert.ok(!textOf(tree()).includes('旧事实正文'), '默认隐藏被修正的旧记录')

  ;(drop()!.props!.onClick as () => void)()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const allOption = collect(tree()).find((n) => n.props?.role === 'option' && textOf(n).includes('显示全部'))
  assert.ok(allOption, '筛选包含「显示全部」')
  ;(allOption!.props!.onClick as () => void)()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.ok(textOf(tree()).includes('旧事实正文'), '显示全部时旧记录出现')

  ;(drop()!.props!.onClick as () => void)()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const onlyOption = collect(tree()).find((n) => n.props?.role === 'option' && textOf(n).includes('只看已修正'))
  assert.ok(onlyOption, '筛选包含「只看已修正」')
  ;(onlyOption!.props!.onClick as () => void)()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const text = textOf(tree())
  assert.ok(text.includes('旧事实正文'), '只看已修正时显示旧记录')
  assert.ok(!text.includes('新事实正文'), '只看已修正时隐藏新记录')
  hooks.resetAll()
})

test('服务页底部:Star 与 issue 链接', async () => {
  const { hooks } = await loadBundle()
  hooks.resetAll()
  const tree = await mountPanel(hooks, { scopes: [], embedServer: null }, undefined, 'records')
  const text = textOf(tree())
  assert.ok(text.includes('去 GitHub 点个 Star'), `底部有 Star 文案(${text.slice(-80)})`)
  assert.ok(text.includes('反馈建议 / 提 issue'), '底部有 issue 文案')
  const links = collect(tree()).filter((n) => n.tag === 'a').map((n) => String(n.props?.href))
  assert.ok(links.includes('https://github.com/HANPU5838/dsh-memory'), `Star 链接正确(${JSON.stringify(links)})`)
  assert.ok(links.includes('https://github.com/HANPU5838/dsh-memory/issues/new'), 'issue 链接正确')
})

test('侧栏图标是单色线稿:16 网格、1.3 描边、currentColor,不带渐变', async () => {
  // 这条断言守的是"侧栏里冒出一块彩色瓦片"的回归:插件列表用彩色 icon.svg,但
  // 左侧栏 / 设置侧栏那一列全是单色线稿,记号必须用 currentColor 画。
  const { exports, hooks } = await loadBundle()
  hooks.resetAll()
  type DomNode = { tag: string; attrs: Record<string, string | number>; children?: DomNode[] }
  const { NavLineIcon, NAV_DOM } = exports.__test as {
    NavLineIcon: (p: Record<string, unknown>) => unknown
    NAV_DOM: DomNode[]
  }

  const tree = render(hooks.createElement(NavLineIcon, { size: 16 }), hooks)
  assert.ok(tree, 'NavLineIcon 应渲染出 SVG')
  assert.equal(tree!.tag, 'svg')
  assert.equal(tree!.props!.viewBox, '0 0 16 16', '与宿主侧栏图标共用 16 网格')
  assert.equal(tree!.props!.fill, 'none')

  const nodes = collect(tree)
  const shapes = nodes.filter((n) => n.tag === 'rect' || n.tag === 'path')
  assert.equal(shapes.length, 2, '线稿只有瓦片轮廓 + 年轮螺旋两条图形')
  for (const shape of shapes) {
    assert.equal(String(shape.props?.fill), 'none', `${String(shape.tag)} 必须是描边,不能填色`)
    assert.equal(String(shape.props?.stroke), 'currentColor', `${String(shape.tag)} 必须跟随文字色`)
    assert.equal(Number(shape.props?.strokeWidth), 1.3, `${String(shape.tag)} 线宽必须与宿主图标一致(1.3)`)
  }
  const spiral = nodes.find((n) => n.tag === 'path')
  assert.ok(String(spiral?.props?.d).includes('A'), '年轮用圆弧画,不是折线')
  assert.ok(!nodes.some((n) => n.tag === 'linearGradient' || n.tag === 'stop'), '侧栏图标不能带渐变')

  // 设置侧栏走 DOM 那条路:两条图形必须与 React 侧完全一致
  assert.equal(NAV_DOM.length, 2)
  assert.equal(NAV_DOM.find((n) => n.tag === 'path')?.attrs.d, spiral?.props?.d)
  for (const shape of NAV_DOM) {
    assert.equal(String(shape.attrs.fill), 'none')
    assert.equal(String(shape.attrs.stroke), 'currentColor')
    assert.equal(String(shape.attrs['stroke-width']), '1.3')
  }
})

test('记忆树布局:按作用域 / 类型分层,并连出修正与被修正的关系', async () => {
  const { exports } = await loadBundle()
  const build = (exports.__test as {
    buildMemoryTree: (records: unknown[], options?: Record<string, unknown>) => {
      nodes: Array<Record<string, unknown>>
      edges: Array<Record<string, unknown>>
      corrections: Array<Record<string, unknown>>
      counts: Record<string, number>
      width: number
      height: number
    }
  }).buildMemoryTree

  const records = [
    makeRecord({ id: 'old', scope: 'project:/w', kind: 'fact', content: '旧事实', updatedAt: 1, supersedes: null, supersededBy: 'new' }),
    makeRecord({ id: 'new', scope: 'project:/w', kind: 'fact', content: '新事实', updatedAt: 2, supersedes: 'old', supersededBy: null }),
    makeRecord({ id: 'rule', scope: 'global', kind: 'rule', content: '硬性规则', updatedAt: 3, supersedes: null, supersededBy: null }),
  ]

  const layout = build(records, { labels: { 'project:/w': '演示项目', global: '全局' } })
  assert.equal(layout.counts.records, 3)
  assert.equal(layout.counts.scopes, 2)
  assert.equal(layout.counts.kinds, 2)
  assert.equal(layout.corrections.length, 1, '新记录 supersedes 旧记录 → 一条修正连线')

  const scopes = layout.nodes.filter((n) => n.type === 'scope')
  assert.deepEqual(scopes.map((n) => n.scope), ['global', 'project:/w'], 'global 排在最前')
  assert.equal(scopes.find((n) => n.scope === 'global')?.label, '全局')
  assert.equal(scopes.find((n) => n.scope === 'project:/w')?.label, '演示项目')

  const kinds = layout.nodes.filter((n) => n.type === 'kind')
  assert.deepEqual(
    kinds.filter((n) => n.scope === 'project:/w').map((n) => n.kind),
    ['fact'],
    '同一作用域下按固定类型顺序分组',
  )

  const correction = layout.corrections[0]!
  assert.equal(correction.fromId, 'new')
  assert.equal(correction.toId, 'old')
  assert.equal(layout.nodes.find((n) => n.key === correction.fromKey)?.type, 'record')
  assert.equal(layout.nodes.find((n) => n.key === correction.toKey)?.type, 'record')

  // 父节点在自己子树高度里居中:作用域节点的中心应落在它所含记录块的中心
  const scope = scopes.find((n) => n.scope === 'project:/w')!
  const recordNodes = layout.nodes.filter((n) => n.type === 'record' && n.scope === 'project:/w')
  const minY = Math.min(...recordNodes.map((n) => Number(n.y)))
  const maxY = Math.max(...recordNodes.map((n) => Number(n.y) + Number(n.h)))
  assert.ok(Math.abs((Number(scope.y) + Number(scope.h) / 2) - (minY + maxY) / 2) < 0.01, '作用域节点垂直居中')
  assert.ok(layout.width > 0 && layout.height > 0)
})

test('记忆树布局:折叠作用域 / 按类型筛选都会重排,并丢掉不可见的修正边', async () => {
  const { exports } = await loadBundle()
  const build = (exports.__test as {
    buildMemoryTree: (records: unknown[], options?: Record<string, unknown>) => {
      nodes: Array<Record<string, unknown>>
      corrections: unknown[]
      counts: Record<string, number>
    }
  }).buildMemoryTree

  const records = [
    makeRecord({ id: 'old', scope: 'project:/w', kind: 'fact', content: '旧事实', updatedAt: 1, supersedes: null, supersededBy: 'new' }),
    makeRecord({ id: 'new', scope: 'project:/w', kind: 'fact', content: '新事实', updatedAt: 2, supersedes: 'old', supersededBy: null }),
    makeRecord({ id: 'rule', scope: 'global', kind: 'rule', content: '硬性规则', updatedAt: 3 }),
  ]

  const collapsed = build(records, { collapsed: new Set(['scope:project:/w']) })
  assert.equal(collapsed.nodes.filter((n) => n.type === 'scope').length, 2)
  assert.equal(collapsed.nodes.filter((n) => n.type === 'record').length, 1, '折叠的作用域下不渲染记录')
  assert.equal(collapsed.corrections.length, 0, '被折叠的记录不能留下悬空修正边')

  const onlyRule = build(records, { activeKinds: new Set(['rule']) })
  assert.deepEqual(onlyRule.nodes.filter((n) => n.type === 'record').map((n) => n.rec?.id), ['rule'])
  assert.equal(onlyRule.counts.scopes, 1)

  // 修正边只有在**两端都可见**时才存在:只留 fact 时 old/new 都可见,只留 rule 时两端都不可见
  const onlyFact = build(records, { activeKinds: new Set(['fact']) })
  assert.equal(onlyFact.corrections.length, 1)
})

test('记忆树标签页:从面板能切过去,空数据也有统计、类型图例与空状态', async () => {
  const { hooks } = await loadBundle()
  hooks.resetAll()
  const tree = await mountPanel(hooks, {
    scopes: [{ scope: 'global', records: 0, pendingEmbeds: 0, label: 'global:全局' }],
    embedServer: null,
  }, undefined, 'tree')

  const text = textOf(tree())
  assert.ok(text.includes('记忆树'), '标签栏里有「记忆树」')
  assert.ok(text.includes('条记忆'), '统计卡显示记忆总数')
  assert.ok(text.includes('个作用域'), '统计卡显示作用域数')
  assert.ok(text.includes('种类型'), '统计卡显示类型数')
  assert.ok(text.includes('处修正'), '统计卡显示修正关系数')
  assert.ok(text.includes('类型'), '类型图例存在')
  assert.ok(text.includes('还没有记忆'), '没有记录时给出空状态引导')

  const classNames = collect(tree()).map((n) => String(n.props?.className ?? ''))
  assert.ok(classNames.includes('tree-tab'), '渲染的是记忆树标签页')
  assert.ok(classNames.includes('tree-wrap'), '树画布存在')
  assert.ok(classNames.includes('tree-stats'), '统计区存在')
})

test('两个开关的配色跟随宿主 switch token,深色主题下轨道和圆点都能看清', async () => {
  const { exports } = await loadBundle()
  const css = (exports.__test as { CSS: string }).CSS
  const rule = (selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(escaped + '\\{([^}]*)\\}').exec(css)?.[1] ?? ''
  }

  // 宿主 switch 的配色(--dsw-alias-*):关闭态轨道 border-l3、圆点 switch-thumb;
  // 开启态轨道 brand-primary、圆点 label-primary-foreground。深色主题的 brand-primary
  // 是近白色,所以圆点不能写死 #fff,关闭态轨道也不能用几乎透明的 border-l1(#ffffff0f)。
  const pairs = [
    { name: '设置开关', track: '.memp .switch', on: '.memp .switch.on', knob: '.memp .switch .knob', knobOn: '.memp .switch.on .knob' },
    { name: '向量服务开关', track: '.memp .toggle-track', on: '.memp .toggle.on .toggle-track', knob: '.memp .toggle-knob', knobOn: '.memp .toggle.on .toggle-knob' },
  ]
  for (const p of pairs) {
    const track = rule(p.track)
    assert.match(track, /background:var\(--dsw-alias-border-l3\)/, `${p.name}:关闭态轨道用 border-l3:${track}`)
    assert.doesNotMatch(track, /border-l1/, `${p.name}:关闭态轨道不能再用几乎透明的 border-l1`)
    assert.match(rule(p.on), /background:var\(--dsw-alias-brand-primary\)/, `${p.name}:开启态轨道用品牌色`)
    const knob = rule(p.knob)
    assert.match(knob, /background:var\(--dsw-alias-switch-thumb\)/, `${p.name}:关闭态圆点用 switch-thumb:${knob}`)
    assert.doesNotMatch(knob, /#fff/i, `${p.name}:圆点不能写死白色`)
    assert.match(rule(p.knobOn), /background:var\(--dsw-alias-label-primary-foreground\)/, `${p.name}:开启态圆点用 label-primary-foreground`)
  }
})

test('审计条目的轨迹锚点解析：operationId 优先，其次 signal.callId', async () => {
  const { exports } = await loadBundle()
  const testApi = exports.__test as {
    auditEntryCallId: (entry: unknown) => string | undefined
    trajectoryRowCallId: (row: unknown) => string | undefined
    requestAuditFocus: (target: unknown) => void
    takeAuditFocus: (audience?: string) => { sessionId?: string; callId?: string; audience?: string } | null
  }
  assert.equal(testApi.auditEntryCallId({ operationId: 'call-1' }), 'call-1')
  assert.equal(testApi.auditEntryCallId({ operationId: '', signal: { callId: 'call-2' } }), 'call-2')
  assert.equal(testApi.auditEntryCallId({ signal: { callId: 'call-3' } }), 'call-3')
  assert.equal(testApi.auditEntryCallId({}), undefined)

  // Trajectory 的行 key：kind\0call\0<callId>，但 DOM 属性经过 encodeURIComponent。
  assert.equal(testApi.trajectoryRowCallId({
    getAttribute: (name: string) => name === 'data-trajectory-row-key' ? 'tool%00call%00call-9' : null,
  }), 'call-9')
  assert.equal(testApi.trajectoryRowCallId({
    getAttribute: (name: string) => name === 'data-trajectory-row-key' ? 'tool\u0000call\u0000call-9' : null,
  }), 'call-9', '未编码的旧格式也认')
  assert.equal(testApi.trajectoryRowCallId({
    getAttribute: () => 'tool%00call%00call-9%00summary%00turn',
  }), 'call-9', 'collapsed summary 后缀不影响 callId')
  assert.equal(testApi.trajectoryRowCallId({ getAttribute: () => 'message%00abc' }), undefined)
  assert.equal(testApi.trajectoryRowCallId(null), undefined)

  // 焦点总线只把目标交给匹配的受众（主面板 vs 会话内视图）。
  testApi.requestAuditFocus({ audience: 'view', sessionId: 's1', callId: 'call-9' })
  assert.equal(testApi.takeAuditFocus('panel'), null, '面板不能抢走给会话视图的焦点')
  const taken = testApi.takeAuditFocus('view')
  assert.equal(taken?.sessionId, 's1')
  assert.equal(taken?.callId, 'call-9')
  assert.equal(testApi.takeAuditFocus('view'), null, '取过一次就清掉')
})

test('主面板通过 conversation.session 的 store 调 openView 跳轨迹', async () => {
  const { exports } = await loadBundle()
  const testApi = exports.__test as {
    setClientCtx: (ctx: unknown) => void
    conversationStoreFor: (sessionId: string) => { actions?: Record<string, unknown> } | undefined
    setConversationView: (sessionId: string, view: string, focus?: string) => boolean
  }
  const handle = { kind: 'conversation-store' }
  const seen: [string, string | undefined][] = []
  const store = {
    actions: {
      openView: (view: string, focus?: string) => { seen.push([view, focus]) },
      setView: (view: string) => { seen.push([view, undefined]) },
    },
  }
  const slots = {
    entries: (key: string) => key === 'conversation.session' ? [{ store: handle }] : [],
    _stores: new Map([[handle, { instances: new Map([['s1', store]]) }]]),
  }
  testApi.setClientCtx({ get: (name: string) => name === 'slots' ? slots : undefined })
  assert.equal(testApi.conversationStoreFor('s1'), store)
  assert.equal(testApi.setConversationView('s1', 'trajectory', 'call-9'), true)
  assert.deepEqual(seen, [['trajectory', 'call-9']])
  testApi.setClientCtx(null)
})

test('client apply 注册记忆视图、轨迹徽标与详情页签', async () => {
  const { exports } = await loadBundle()
  const registered: { spec: Record<string, unknown>; component: unknown }[] = []
  const injected: string[] = []
  const slots = {
    entries: () => [],
    inject(key: string, callback: () => unknown) {
      injected.push(key)
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    register(spec: Record<string, unknown>, component: unknown) {
      registered.push({ spec, component })
      return () => {}
    },
  }
  const ctx = {
    get: (name: string) => name === 'slots' ? slots : undefined,
    effect: (fn: () => unknown) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
  }
  const globals = globalThis as Record<string, unknown>
  const saved = {
    window: globals.window,
    document: globals.document,
    MutationObserver: globals.MutationObserver,
    fetch: globals.fetch,
  }
  const errors: string[] = []
  const originalError = console.error
  globals.window = {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    location: { hash: '' },
  }
  globals.document = {
    createElement: () => ({ set textContent(_v: string) {}, remove() {} }),
    head: { appendChild() {} },
    body: {},
    querySelectorAll: () => [],
  }
  globals.MutationObserver = class { observe() {} disconnect() {} }
  globals.fetch = async () => ({ status: 200, json: async () => ({ ok: true, value: { sidebar: { enabled: true } } }) })
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')) }
  try {
    ;(exports.apply as (ctx: unknown) => void)(ctx)
    await new Promise((resolve) => setTimeout(resolve, 20))
  } finally {
    globals.window = saved.window
    globals.document = saved.document
    globals.MutationObserver = saved.MutationObserver
    globals.fetch = saved.fetch
    console.error = originalError
    ;(exports.__test as { setClientCtx: (v: unknown) => void }).setClientCtx(null)
  }
  assert.deepEqual(errors, [], '注册过程不应吞掉异常并打 console.error')
  const spec = (name: string) => registered.find((entry) => entry.spec.name === name)?.spec
  assert.equal(spec('settings.section')?.id, 'memory')
  assert.equal(spec('main')?.key, 'memory')
  assert.equal(spec('sidebar.panellist')?.id, 'memory')
  assert.equal(spec('conversation.view')?.id, 'memory', '会话内「记忆」视图已注册')
  assert.ok(!registered.some((entry) => entry.spec.name === 'conversation.session.header.actions'), '会话头部不再注册记忆按钮')
  const overlays = registered.filter((entry) => entry.spec.name === 'shell.overlay').map((entry) => entry.spec.id)
  assert.deepEqual(overlays.sort(), ['memory-audit-badge', 'memory-audit-detail', 'memory-audit-marks'], '轨迹标记/徽标/详情页签已注册')
  // 0.21.0:审批不再是全局浮层,而是会话内的 dock(只在对应会话里出现)。
  const dock = registered.find((entry) => entry.spec.name === 'conversation.input.dock')
  assert.equal(dock?.spec.id, 'memory-access-approval', '审批卡注册在会话内的输入框 dock')
  assert.ok(injected.includes('conversation.input.dock'))
  assert.ok(injected.includes('conversation.view'))
  assert.ok(!injected.includes('conversation.session.header.actions'))
  assert.ok(injected.includes('shell.overlay'))
  const visibility = registered.find((entry) => entry.spec.name === 'conversation.input.right')
  assert.equal(visibility?.spec.id, 'memory-visibility', '输入框里的记忆可见范围按钮已注册')
  assert.ok(injected.includes('conversation.input.right'))
})

test('输入框记忆范围按钮:打开会话就显示数字、默认范围预选、保存带 scope + 读写状态 + 绑定', async () => {
  const { exports, hooks } = await loadBundle()
  hooks.resetAll()
  const Button = (exports.__test as { MemoryVisibilityButton: (p: Record<string, unknown>) => unknown }).MemoryVisibilityButton
  const calls: Array<{ url: string; init?: { method?: string; body?: string } }> = []
  // 故意不返回 session scope 的目录项,验证客户端会用 defaults 自己补齐并预选。
  const payload = {
    sessionId: 's1',
    override: null,
    effective: null,
    inherited: false,
    defaults: ['session:s1', 'global'],
    defaultScopes: ['session:s1', 'global'],
    bindings: [],
    scopes: [
      { scope: 'global', label: 'global:全局', records: 5, pendingEmbeds: 0, read: true, write: true, bound: true, defaultBound: true, bindable: false },
      { scope: 'handbook', label: 'custom:handbook', records: 1, pendingEmbeds: 0, read: true, write: true, bound: false, defaultBound: false, bindable: true },
    ],
  }
  const savedFetch = (globalThis as Record<string, unknown>).fetch
  ;(globalThis as Record<string, unknown>).fetch = async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, init })
    if (init === undefined || init.method === 'GET') {
      return { status: 200, json: async () => ({ ok: true, value: payload }) }
    }
    const body = JSON.parse(String(init.body ?? '{}')) as { visibility?: { scopes: unknown[]; level: string } | null; bindings?: string[] }
    // 0.25.13：绑定走独立的 /bindings，立即落盘，响应只回写绑定集合。
    if (String(url).endsWith('/bindings')) {
      return { status: 200, json: async () => ({ ok: true, value: { sessionId: 's1', bindings: body.bindings ?? [] } }) }
    }
    return {
      status: 200,
      json: async () => ({
        ok: true,
        value: {
          ...payload,
          override: body.visibility ?? null,
          effective: body.visibility ?? payload.effective,
          bindings: body.bindings ?? [],
        },
      }),
    }
  }
  try {
    let current: RenderNode | null = null
    const element = () => hooks.React.createElement(Button, { sessionId: 's1' })
    hooks.setRerender(() => { current = render(element(), hooks) })
    current = render(element(), hooks)
    hooks.runEffects()
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.equal(calls[0]?.url, '/memory/api/visibility?session=s1', '打开会话就加载')
    assert.equal(calls[0]?.init?.method, 'GET')
    const button = collect(current).find((n) => n.tag === 'button' && String(n.props?.className ?? '').includes('mem-scope-btn'))
    assert.ok(button, '输入框里渲染了记忆范围按钮')
    assert.equal(textOf(button), '2', '按钮只显示数字,不再显示文字')
    assert.match(String(button!.props!.className), /is-normal/, '没有生效策略时按默认的普通限制画边框')
    assert.match(String(button!.props!.title), /2 个作用域/)
    assert.match(String(button!.props!.title), /普通限制/)
    ;(button!.props!.onClick as (event: unknown) => void)({ currentTarget: { getBoundingClientRect: () => ({ left: 40, top: 500 }) } })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const text = textOf(current)
    assert.ok(text.includes('记忆权限'))
    // 0.25.8:本会话的 session scope 在列表里显示为「当前会话」。
    assert.ok(text.includes('session:当前会话'), '本会话 session scope 显示为 session:当前会话')
    // 0.25.11:显示名与真实键不一致时,完整键单独一行(raw),并且 title 是「显示名 → 键」。
    const keyLines = collect(current)
      .filter((n) => n.tag === 'div' && String(n.props?.className ?? '') === 'mem-scope-key')
      .map((n) => textOf(n))
    assert.ok(keyLines.includes('session:s1'), `会话行露出完整键(实际:${JSON.stringify(keyLines)})`)
    assert.ok(keyLines.includes('global'), 'global 行露出裸键 global(显示名是 global:全局)')
    assert.ok(keyLines.includes('handbook'), '自定义作用域露出裸键 handbook(显示名是 custom:handbook)')
    const sessionLabel = collect(current).find((n) => n.tag === 'button'
      && String(n.props?.className ?? '') === 'mem-scope-label' && String(n.props?.title ?? '').startsWith('session:当前会话'))
    assert.ok(sessionLabel, 'label 的 title 带显示名')
    assert.match(String(sessionLabel!.props!.title), /→ session:s1$/, 'title 里同时给出真实键')
    assert.ok(text.includes('全局'))
    assert.ok(text.includes('绝对限制') && text.includes('普通限制') && text.includes('无限制'), '三档限制等级')
    assert.ok(!text.includes('事实') && !text.includes('规则'), '不再显示类型 chips')
    const boxes = collect(current).filter((n) => n.tag === 'button' && String(n.props?.className ?? '').includes('mem-scope-check'))
    assert.equal(boxes.length, 3, '目录里的三个作用域都渲染')
    assert.equal(boxes.filter((box) => box.props?.['aria-checked'] === true).length, 2, '默认范围的两个作用域预选')

    // 0.23.1:状态按钮 —— 绑定 / 可读 | 可写。默认的会话 + global 显示为已绑定且不可取消。
    const stateButtons = collect(current).filter((n) => n.tag === 'button' && String(n.props?.className ?? '').includes('mem-scope-state'))
    assert.equal(stateButtons.filter((node) => textOf(node) === '可读').length, 3, '每个作用域都有可读')
    assert.equal(stateButtons.filter((node) => textOf(node) === '可写').length, 3, '可读与可写并列')
    const bindButtons = stateButtons.filter((node) => textOf(node) === '绑定')
    assert.equal(bindButtons.length, 3, '每个作用域都有绑定状态')
    const defaultLocked = bindButtons.filter((node) => node.props?.disabled === true)
    assert.equal(defaultLocked.length, 2, '默认范围(会话 + global)默认绑定且不可取消')
    assert.deepEqual(defaultLocked.map((node) => node.props?.['aria-pressed']), [true, true], '默认作用域显示为已绑定')
    const bind = bindButtons.find((node) => node.props?.disabled !== true)
    assert.ok(bind, '额外作用域可绑定到工作区')
    assert.equal(bind!.props?.['aria-pressed'], false)
    ;(bind!.props!.onClick as () => void)()
    await new Promise((resolve) => setTimeout(resolve, 0))
    // 0.25.13：点「绑定」立即保存（不用再点「保存」），提交整份额外绑定。
    const bindPost = calls.find((call) => call.init?.method === 'POST' && String(call.url).endsWith('/bindings'))
    assert.ok(bindPost, '点绑定立刻 POST /bindings')
    const bindBody = JSON.parse(String(bindPost?.init?.body ?? '{}')) as { session: string; bindings: string[] }
    assert.equal(bindBody.session, 's1')
    assert.deepEqual(bindBody.bindings, ['handbook'], '立即提交额外绑定(默认作用域不写入)')
    assert.equal(
      collect(current).filter((node) => node.tag === 'button' && String(node.props?.className ?? '').includes('mem-scope-state')
        && textOf(node) === '绑定' && node.props?.['aria-pressed'] === true).length,
      3,
      '保存后额外作用域也显示为已绑定',
    )
    const writable = stateButtons.filter((node) => textOf(node) === '可写' && node.props?.disabled !== true)
    assert.equal(writable.length, 2, '已勾选的两个作用域都能调可写状态')
    // 按行找全局作用域的「可写」:列表顺序跟着显示名走(本会话那行现在叫「当前会话」),
    // 用下标取会很脆。
    const globalRow = collect(current).find((n) => n.tag === 'div'
      && String(n.props?.className ?? '').split(' ').includes('mem-scope-item')
      && textOf(n).includes('全局'))!
    assert.ok(globalRow, '全局作用域行存在')
    const globalWrite = collect(globalRow).find((n) => n.tag === 'button'
      && String(n.props?.className ?? '').includes('mem-scope-state')
      && String(n.props?.className ?? '').includes('write'))!
    assert.ok(globalWrite && globalWrite.props?.disabled !== true, '全局作用域的可写按钮可点')
    ;(globalWrite.props!.onClick as () => void)()

    const save = collect(current).find((n) => n.tag === 'button' && textOf(n).trim() === '保存')
    assert.ok(save, '保存按钮存在')
    ;(save!.props!.onClick as () => void)()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const post = calls.find((call) => call.init?.method === 'POST' && String(call.url).endsWith('/visibility'))
    assert.ok(post, '保存走 POST /visibility')
    const posted = JSON.parse(String(post?.init?.body ?? '{}')) as { session: string; visibility: { scopes: Array<{ scope: string; read?: boolean; write?: boolean }>; level: string }; bindings: string[] }
    assert.equal(posted.session, 's1')
    assert.deepEqual(posted.visibility.scopes.map((item) => item.scope).sort(), ['global', 'session:s1'])
    assert.deepEqual(Object.keys(posted.visibility.scopes[0]!).sort(), ['read', 'scope', 'write'], '提交可读/可写状态')
    const globalScope = posted.visibility.scopes.find((item) => item.scope === 'global')!
    assert.equal(globalScope.read, true)
    assert.equal(globalScope.write, false, '关掉可写后按 false 提交')
    assert.deepEqual(posted.bindings, ['handbook'], '只提交额外绑定(默认作用域不写入)')
    assert.equal(posted.visibility.level, 'normal')
  } finally {
    ;(globalThis as Record<string, unknown>).fetch = savedFetch
  }
  hooks.resetAll()
})


test('记忆权限浮窗:「绑定」点一下就落盘(再点一次解除),不用再点「保存」;失败回滚并报错', async () => {
  const { exports, hooks } = await loadBundle()
  hooks.resetAll()
  const Button = (exports.__test as { MemoryVisibilityButton: (p: Record<string, unknown>) => unknown }).MemoryVisibilityButton
  const calls: Array<{ url: string; init?: { method?: string; body?: string } }> = []
  let bindFails = false
  const payload = {
    sessionId: 's1',
    override: { level: 'normal', scopes: [{ scope: 'session:s1' }, { scope: 'global' }] },
    effective: { level: 'normal', scopes: [{ scope: 'session:s1' }, { scope: 'global' }] },
    source: 'explicit',
    inherited: false,
    defaults: ['session:s1', 'global'],
    defaultScopes: ['session:s1', 'global'],
    bindings: [],
    scopes: [
      { scope: 'session:s1', label: 'session:当前会话', records: 1 },
      { scope: 'global', label: 'global:全局', records: 2 },
      { scope: 'handbook', label: 'handbook', records: 1 },
    ],
  }
  const savedFetch = (globalThis as Record<string, unknown>).fetch
  ;(globalThis as Record<string, unknown>).fetch = async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, init })
    if (init === undefined || init.method === 'GET') {
      return { status: 200, json: async () => ({ ok: true, value: payload }) }
    }
    const body = JSON.parse(String(init.body ?? '{}')) as { bindings?: string[] }
    if (bindFails) {
      return { status: 500, json: async () => ({ ok: false, error: { code: 'BIND_FAILED', message: '工作区绑定写入失败' } }) }
    }
    return { status: 200, json: async () => ({ ok: true, value: { sessionId: 's1', bindings: body.bindings ?? [] } }) }
  }
  try {
    let current: RenderNode | null = null
    const element = () => hooks.React.createElement(Button, { sessionId: 's1' })
    hooks.setRerender(() => { current = render(element(), hooks) })
    current = render(element(), hooks)
    hooks.runEffects()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const button = collect(current).find((n) => n.tag === 'button' && String(n.props?.className ?? '').includes('mem-scope-btn'))
    ;(button!.props!.onClick as (event: unknown) => void)({ currentTarget: { getBoundingClientRect: () => ({ left: 40, top: 500 }) } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    hooks.runEffects()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const handbookBind = () => {
      const row = collect(current).find((n) => n.tag === 'div'
        && String(n.props?.className ?? '').split(' ').includes('mem-scope-item')
        && textOf(n).includes('handbook'))!
      assert.ok(row, 'handbook 作用域行存在')
      return collect(row).find((n) => n.tag === 'button'
        && String(n.props?.className ?? '').includes('mem-scope-state') && textOf(n) === '绑定')!
    }
    const bindPostCount = () => calls.filter((call) => call.init?.method === 'POST' && String(call.url).endsWith('/bindings')).length

    assert.equal(handbookBind().props?.['aria-pressed'], false)
    ;(handbookBind().props!.onClick as () => void)()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(bindPostCount(), 1, '点一下就发一次 /bindings,没点「保存」')
    const bindBody = JSON.parse(String(calls.filter((call) => String(call.url).endsWith('/bindings')).at(-1)?.init?.body ?? '{}')) as { session: string; bindings: string[] }
    assert.equal(bindBody.session, 's1')
    assert.deepEqual(bindBody.bindings, ['handbook'])
    assert.equal(handbookBind().props?.['aria-pressed'], true, '按钮立刻变成已绑定')
    assert.ok(!calls.some((call) => call.init?.method === 'POST' && String(call.url).endsWith('/visibility')), '没有顺带保存草稿')

    // 再点一次 = 解除绑定:同样立即落盘,提交空数组。
    ;(handbookBind().props!.onClick as () => void)()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(bindPostCount(), 2)
    const unbound = JSON.parse(String(calls.filter((call) => String(call.url).endsWith('/bindings')).at(-1)?.init?.body ?? '{}')) as { bindings: string[] }
    assert.deepEqual(unbound.bindings, [], '取消绑定 = 提交空数组')
    assert.equal(handbookBind().props?.['aria-pressed'], false)

    // 写入失败:回滚按钮状态,并把错误显示出来。
    bindFails = true
    ;(handbookBind().props!.onClick as () => void)()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(handbookBind().props?.['aria-pressed'], false, '失败回滚,不显示没落盘的绑定')
    assert.ok(textOf(current).includes('工作区绑定写入失败'), '失败原因显示在浮窗里')
  } finally {
    ;(globalThis as Record<string, unknown>).fetch = savedFetch
  }
  hooks.resetAll()
})


test('记忆权限浮窗:移除 Agent 授权行与解释文本,只留勾选 + 可读/可写', async () => {
  const { exports, hooks } = await loadBundle()
  hooks.resetAll()
  const Button = (exports.__test as { MemoryVisibilityButton: (p: Record<string, unknown>) => unknown }).MemoryVisibilityButton
  const calls: Array<{ url: string; init?: { method?: string; body?: string } }> = []
  const payload = {
    sessionId: 's1',
    override: null,
    effective: { level: 'normal', scopes: [{ scope: 'session:s1' }, { scope: 'global' }] },
    source: 'default',
    inherited: false,
    defaults: ['session:s1', 'global'],
    defaultScopes: ['session:s1', 'global'],
    bindings: [],
    scopes: [
      { scope: 'session:s1', label: 'session:当前会话', records: 1 },
      { scope: 'global', label: 'global:全局', records: 2 },
      { scope: 'handbook', label: 'handbook', records: 1 },
    ],
  }
  const savedFetch = (globalThis as Record<string, unknown>).fetch
  ;(globalThis as Record<string, unknown>).fetch = async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, init })
    if (url.startsWith('/memory/api/grants?')) {
      return { status: 200, json: async () => ({ ok: true, value: { sessionId: 's1', grants: [] } }) }
    }
    return { status: 200, json: async () => ({ ok: true, value: payload }) }
  }
  try {
    let current: RenderNode | null = null
    const element = () => hooks.React.createElement(Button, { sessionId: 's1' })
    hooks.setRerender(() => { current = render(element(), hooks) })
    current = render(element(), hooks)
    hooks.runEffects()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const button = collect(current).find((n) => n.tag === 'button' && String(n.props?.className ?? '').includes('mem-scope-btn'))
    assert.ok(button, '记忆权限按钮存在')
    assert.match(String(button!.props!.title), /记忆权限/, '按钮 title 已改名记忆权限')
    ;(button!.props!.onClick as (event: unknown) => void)({ currentTarget: { getBoundingClientRect: () => ({ left: 40, top: 500 }) } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    hooks.runEffects()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const opened = textOf(current)
    assert.ok(opened.includes('记忆权限'), '浮窗标题是记忆权限')
    assert.ok(!opened.includes('Agent 授权'), '不再展示独立的 Agent 授权行(授权改用勾选 + AI 气泡)')
    assert.ok(!opened.includes('范围外例外'), '不再展示授权与可见范围区别的解释文本')
    assert.ok(!opened.includes('勾选作用域 +'), '移除浮窗上方多余的解释文本')
    assert.ok(calls.some((call) => call.url.startsWith('/memory/api/grants?session=s1')), '打开即拉取本会话授权')

    const item = collect(current).find((n) => n.tag === 'div' && String(n.props?.className ?? '').includes('mem-scope-item')
      && textOf(n).includes('handbook'))
    assert.ok(item, '作用域行存在')
    assert.ok(collect(item).some((n) => n.tag === 'button' && String(n.props?.className ?? '').includes('mem-scope-check')), '行内有勾选框')
    const states = collect(item).filter((n) => n.tag === 'button' && String(n.props?.className ?? '').includes('mem-scope-state'))
    assert.equal(states.length, 3, '行内只有绑定 / 可读 / 可写三个状态按钮')
    assert.ok(textOf(item).includes('可读') && textOf(item).includes('可写'), '保留可读 / 可写操作权限')
    assert.ok(!textOf(item).includes('撤销'), '作用域行内不再有撤销授权的动作')
    assert.ok(!collect(item).some((n) => String(n.props?.className ?? '').includes('mem-scope-ai')), '没有授权就不挂 AI 气泡')
  } finally {
    ;(globalThis as Record<string, unknown>).fetch = savedFetch
  }
  hooks.resetAll()
})

test('记忆权限浮窗:portal 到 document.body,不再被输入框那层 sticky 容器压住', async () => {
  const { exports, hooks, portals } = await loadBundle()
  hooks.resetAll()
  const Button = (exports.__test as { MemoryVisibilityButton: (p: Record<string, unknown>) => unknown }).MemoryVisibilityButton
  const payload = {
    sessionId: 's1',
    override: null,
    effective: { level: 'normal', scopes: [{ scope: 'session:s1' }, { scope: 'global' }] },
    source: 'default',
    inherited: false,
    defaults: ['session:s1', 'global'],
    defaultScopes: ['session:s1', 'global'],
    bindings: [],
    scopes: [
      { scope: 'session:s1', label: 'session:当前会话', records: 1 },
      { scope: 'global', label: 'global:全局', records: 2 },
    ],
  }
  const savedFetch = (globalThis as Record<string, unknown>).fetch
  ;(globalThis as Record<string, unknown>).fetch = async (url: string) => {
    if (url.startsWith('/memory/api/grants?')) {
      return { status: 200, json: async () => ({ ok: true, value: { sessionId: 's1', grants: [] } }) }
    }
    return { status: 200, json: async () => ({ ok: true, value: payload }) }
  }
  try {
    let current: RenderNode | null = null
    const element = () => hooks.React.createElement(Button, { sessionId: 's1' })
    hooks.setRerender(() => { current = render(element(), hooks) })
    current = render(element(), hooks)
    hooks.runEffects()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const before = portals.length

    const button = collect(current).find((n) => n.tag === 'button' && String(n.props?.className ?? '').includes('mem-scope-btn'))
    assert.ok(button, '记忆权限按钮存在')
    ;(button!.props!.onClick as (event: unknown) => void)({ currentTarget: { getBoundingClientRect: () => ({ left: 40, top: 500 }) } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    hooks.runEffects()
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.ok(portals.length > before, '浮窗走 createPortal 渲染')
    const last = portals[portals.length - 1]!
    const doc = (globalThis as Record<string, unknown>).document as { body: unknown }
    assert.equal(last.container, doc.body, 'portal 目标是 document.body')
    assert.equal(String((last.node as RenderNode).props?.className), 'mem-scope-pop', '挂出去的是浮窗本身')
    assert.ok(textOf(current).includes('记忆权限'), '浮窗内容仍然渲染出来')

    // 关掉浮窗后不再往 body 挂东西。重新取按钮:上面那个节点的 onClick 闭包里 open 还是
    // false,再点它是「又打开一次」而不是「关掉」。
    const closeButton = collect(current).find((n) => n.tag === 'button' && String(n.props?.className ?? '').includes('mem-scope-btn'))
    assert.equal(closeButton!.props?.['aria-expanded'], true, '浮窗现在是打开的')
    ;(closeButton!.props!.onClick as (event: unknown) => void)({ currentTarget: { getBoundingClientRect: () => ({ left: 40, top: 500 }) } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const afterClose = portals.length
    hooks.setRerender(() => { current = render(element(), hooks) })
    current = render(element(), hooks)
    assert.equal(portals.length, afterClose, '浮窗关掉后不再 portal')
    assert.ok(!collect(current).some((n) => String(n.props?.className) === 'mem-scope-pop'), '浮窗已从树上移除')
  } finally {
    ;(globalThis as Record<string, unknown>).fetch = savedFetch
  }
  hooks.resetAll()
})

test('记忆权限浮窗:本会话的 session scope 显示为「当前会话」,别的会话照旧', async () => {
  const { exports, hooks } = await loadBundle()
  hooks.resetAll()
  const Button = (exports.__test as { MemoryVisibilityButton: (p: Record<string, unknown>) => unknown }).MemoryVisibilityButton
  const payload = {
    sessionId: 's1',
    override: null,
    effective: { level: 'normal', scopes: [{ scope: 'session:s1' }, { scope: 'global' }] },
    source: 'default',
    inherited: false,
    defaults: ['session:s1', 'global'],
    defaultScopes: ['session:s1', 'global'],
    bindings: [],
    scopes: [
      { scope: 'session:s1', label: '修浮窗层级(11111111)', records: 3 },
      { scope: 'session:s2', label: 'session:session-22222222', records: 1 },
      { scope: 'global', label: 'global:全局', records: 2 },
    ],
  }
  const savedFetch = (globalThis as Record<string, unknown>).fetch
  ;(globalThis as Record<string, unknown>).fetch = async (url: string) => {
    if (url.startsWith('/memory/api/grants?')) {
      return { status: 200, json: async () => ({ ok: true, value: { sessionId: 's1', grants: [] } }) }
    }
    return { status: 200, json: async () => ({ ok: true, value: payload }) }
  }
  try {
    let current: RenderNode | null = null
    const element = () => hooks.React.createElement(Button, { sessionId: 's1' })
    hooks.setRerender(() => { current = render(element(), hooks) })
    current = render(element(), hooks)
    hooks.runEffects()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const button = collect(current).find((n) => n.tag === 'button' && String(n.props?.className ?? '').includes('mem-scope-btn'))
    assert.ok(button, '记忆权限按钮存在')
    ;(button!.props!.onClick as (event: unknown) => void)({ currentTarget: { getBoundingClientRect: () => ({ left: 40, top: 500 }) } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    hooks.runEffects()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const labels = () => collect(current)
      .filter((n) => n.tag === 'button' && String(n.props?.className ?? '') === 'mem-scope-label')
      .map((n) => textOf(n))
    assert.ok(labels().includes('session:当前会话'), '本会话的 session scope 叫 session:当前会话(带类型前缀)')
    assert.ok(!labels().some((name) => name.includes('11111111')), '不再把会话标题 / 短 id 当名字')
    assert.ok(labels().includes('session:session-22222222'), '别的会话的 scope 仍按原标签显示,不跟着叫当前会话')

    // 搜索按显示名走:「当前会话」能命中本会话作用域。
    const search = collect(current).find((n) => n.tag === 'input' && n.props?.type === 'search')
    assert.ok(search, '有搜索框')
    ;(search!.props!.onChange as (event: unknown) => void)({ target: { value: '当前会话' } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(labels(), ['session:当前会话'], '搜索当前会话只留本会话作用域')
  } finally {
    ;(globalThis as Record<string, unknown>).fetch = savedFetch
  }
  hooks.resetAll()
})

test('记忆权限浮窗:Agent 授权用勾选 + AI 气泡呈现,取消勾选后点保存才撤销', async () => {
  const { exports, hooks } = await loadBundle()
  hooks.resetAll()
  const Button = (exports.__test as { MemoryVisibilityButton: (p: Record<string, unknown>) => unknown }).MemoryVisibilityButton
  const calls: Array<{ url: string; init?: { method?: string; body?: string } }> = []
  const payload = {
    sessionId: 's1',
    override: null,
    effective: { level: 'normal', scopes: [{ scope: 'zulu' }] },
    source: 'default',
    inherited: false,
    defaults: [],
    defaultScopes: [],
    bindings: [],
    scopes: [
      { scope: 'zulu', label: 'zulu', records: 1 },
      { scope: 'handbook', label: 'handbook', records: 1 },
    ],
  }
  let grants = [{
    id: 'grant-1',
    scope: 'handbook',
    label: 'handbook',
    permissions: ['read'],
    grantedAt: 1792844000000,
    ownerSession: 's1',
    inherited: false,
  }]
  const savedFetch = (globalThis as Record<string, unknown>).fetch
  ;(globalThis as Record<string, unknown>).fetch = async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, init })
    if (url.startsWith('/memory/api/grants?')) {
      return { status: 200, json: async () => ({ ok: true, value: { sessionId: 's1', grants } }) }
    }
    if (url === '/memory/api/grants' && init?.method === 'POST') {
      grants = []
      return { status: 200, json: async () => ({ ok: true, value: { sessionId: 's1', grants } }) }
    }
    return { status: 200, json: async () => ({ ok: true, value: payload }) }
  }
  try {
    let current: RenderNode | null = null
    const element = () => hooks.React.createElement(Button, { sessionId: 's1' })
    hooks.setRerender(() => { current = render(element(), hooks) })
    current = render(element(), hooks)
    hooks.runEffects()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const button = collect(current).find((n) => n.tag === 'button' && String(n.props?.className ?? '').includes('mem-scope-btn'))
    ;(button!.props!.onClick as (event: unknown) => void)({ currentTarget: { getBoundingClientRect: () => ({ left: 40, top: 500 }) } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    hooks.runEffects()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const handbook = () => collect(current).find((n) => n.tag === 'div'
      && String(n.props?.className ?? '').includes('mem-scope-item') && textOf(n).includes('handbook'))!
    assert.ok(handbook(), 'handbook 作用域行存在')
    const check = () => collect(handbook()).find((n) => n.tag === 'button' && String(n.props?.className ?? '').includes('mem-scope-check'))!
    assert.equal(String(check().props?.['aria-checked']), 'true', '有 AI 授权的行显示为已勾选')
    assert.ok(collect(handbook()).some((n) => String(n.props?.className ?? '').includes('mem-scope-ai')), '名称右边有 AI 气泡')
    assert.match(String(collect(handbook()).find((n) => String(n.props?.className ?? '').includes('mem-scope-ai'))?.props?.title ?? ''), /只读/, '气泡 title 写明授权权限')
    assert.ok(!textOf(current).includes('Agent 授权'), '授权不再以独立行 / 文本块出现')
    // AI 授权也算进数字：已选 2 = zulu（范围）+ handbook（AI 授权）；输入框按钮同样显示 2。
    assert.ok(textOf(current).includes('已选 2'), '已选把 AI 授权算进去')
    const btnNow = collect(current).find((n) => n.tag === 'button' && String(n.props?.className ?? '').includes('mem-scope-btn'))
    assert.equal(textOf(btnNow).trim(), '2', '按钮数字包含 AI 授权')
    assert.ok(collect(handbook()).some((n) => String(n.props?.className ?? '').split(' ').includes('ai')), 'AI 授权的行用 .ai 样式与用户勾选区分')
    const names = () => collect(current)
      .filter((n) => n.tag === 'div' && String(n.props?.className ?? '').split(' ').includes('mem-scope-item'))
      .map((n) => textOf(collect(n).find((c) => c.tag === 'button' && String(c.props?.className ?? '') === 'mem-scope-label') ?? null))
    assert.deepEqual(names(), ['handbook', 'zulu'], '授权行算已勾选，排在未勾选前面')

    // 取消勾选只是草稿：不撤销、不重排、计数不变，气泡改标「待撤销」。
    ;(check().props!.onClick as () => void)()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.ok(!calls.some((call) => call.url === '/memory/api/grants' && call.init?.method === 'POST'), '取消勾选不立即撤销')
    assert.equal(String(check().props?.['aria-checked']), 'false', '草稿里立即取消勾选')
    assert.ok(textOf(handbook()).includes('AI·待撤销'), '气泡改成待撤销标记')
    assert.deepEqual(names(), ['handbook', 'zulu'], '保存前不重新排序')
    assert.ok(textOf(current).includes('已选 1'), '草稿取消勾选后计数立即少 1')

    // 点保存：先撤销授权，再保存可见范围。
    const saveButton = collect(current).find((n) => n.tag === 'button' && String(n.props?.className ?? '').includes('mem-scope-save'))
    assert.ok(saveButton, '保存按钮存在')
    ;(saveButton!.props!.onClick as () => void)()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const posted = calls.find((call) => call.url === '/memory/api/grants' && call.init?.method === 'POST')
    assert.ok(posted, '保存时才撤回授权（POST /grants）')
    assert.deepEqual(JSON.parse(String(posted?.init?.body ?? '{}')), { session: 's1', id: 'grant-1', view: 's1' })
    const visibilityPost = calls.find((call) => call.url === '/memory/api/visibility' && call.init?.method === 'POST')
    assert.ok(visibilityPost, '保存仍走 POST /visibility')
    const savedBody = JSON.parse(String(visibilityPost?.init?.body ?? '{}')) as {
      visibility: { scopes: { scope: string }[]; level: string }
    }
    assert.deepEqual(savedBody.visibility.scopes.map((rule) => rule.scope), ['zulu'], 'AI 授权不会混进可见范围')
  } finally {
    ;(globalThis as Record<string, unknown>).fetch = savedFetch
  }
  hooks.resetAll()
})

test('记忆权限按钮:浮窗没打开时数字也随 Agent 授权实时变(挂载即轮询 grants)', async () => {
  const { exports, hooks } = await loadBundle()
  hooks.resetAll()
  const Button = (exports.__test as { MemoryVisibilityButton: (p: Record<string, unknown>) => unknown }).MemoryVisibilityButton
  const payload = {
    sessionId: 's1',
    override: null,
    effective: { level: 'normal', scopes: [{ scope: 'zulu' }] },
    source: 'default',
    inherited: false,
    defaults: [],
    defaultScopes: [],
    bindings: [],
    scopes: [
      { scope: 'zulu', label: 'zulu', records: 1 },
      { scope: 'handbook', label: 'handbook', records: 1 },
    ],
  }
  let grants: Array<Record<string, unknown>> = []
  let grantPolls = 0
  const savedFetch = (globalThis as Record<string, unknown>).fetch
  ;(globalThis as Record<string, unknown>).fetch = async (url: string) => {
    if (url.startsWith('/memory/api/grants?')) {
      grantPolls += 1
      return { status: 200, json: async () => ({ ok: true, value: { sessionId: 's1', grants } }) }
    }
    return { status: 200, json: async () => ({ ok: true, value: payload }) }
  }
  try {
    let current: RenderNode | null = null
    const element = () => hooks.React.createElement(Button, { sessionId: 's1' })
    hooks.setRerender(() => { current = render(element(), hooks) })
    current = render(element(), hooks)
    hooks.runEffects()
    await new Promise((resolve) => setTimeout(resolve, 0))
    hooks.runEffects()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const button = () => collect(current).find((n) => n.tag === 'button' && String(n.props?.className ?? '').includes('mem-scope-btn'))!
    assert.equal(textOf(button()).trim(), '1', '没有授权时按钮数字只算可见范围')
    assert.ok(grantPolls >= 1, '浮窗没打开也要拉本会话授权')
    assert.ok(!textOf(current).includes('已选'), '浮窗从头到尾没有打开')

    // 模拟下一轮 3 秒轮询:Agent 刚拿到 handbook 的只读授权。
    grants = [{ id: 'grant-1', scope: 'handbook', label: 'handbook', permissions: ['read'], grantedAt: 1792844000000, ownerSession: 's1', inherited: false }]
    hooks.runEffects()
    await new Promise((resolve) => setTimeout(resolve, 0))
    hooks.runEffects()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(textOf(button()).trim(), '2', 'Agent 拿到授权后按钮数字自己变,不用开浮窗')
    assert.match(String(button().props!.title), /2 个作用域/, '按钮 title 与数字同口径')
    assert.ok(!textOf(current).includes('已选'), '全程没打开过浮窗')
  } finally {
    ;(globalThis as Record<string, unknown>).fetch = savedFetch
  }
  hooks.resetAll()
})

test('记忆权限浮窗:没保存就关掉,再打开草稿还原(不记住待撤销)', async () => {
  const { exports, hooks } = await loadBundle()
  hooks.resetAll()
  const Button = (exports.__test as { MemoryVisibilityButton: (p: Record<string, unknown>) => unknown }).MemoryVisibilityButton
  const payload = {
    sessionId: 's1',
    override: null,
    effective: { level: 'normal', scopes: [{ scope: 'zulu' }] },
    source: 'default',
    inherited: false,
    defaults: [],
    defaultScopes: [],
    bindings: [],
    scopes: [
      { scope: 'zulu', label: 'zulu', records: 1 },
      { scope: 'handbook', label: 'handbook', records: 1 },
    ],
  }
  const grants = [{ id: 'grant-1', scope: 'handbook', label: 'handbook', permissions: ['read'], grantedAt: 1792844000000, ownerSession: 's1', inherited: false }]
  const savedFetch = (globalThis as Record<string, unknown>).fetch
  ;(globalThis as Record<string, unknown>).fetch = async (url: string) => {
    if (url.startsWith('/memory/api/grants?')) {
      return { status: 200, json: async () => ({ ok: true, value: { sessionId: 's1', grants } }) }
    }
    return { status: 200, json: async () => ({ ok: true, value: payload }) }
  }
  try {
    let current: RenderNode | null = null
    const element = () => hooks.React.createElement(Button, { sessionId: 's1' })
    hooks.setRerender(() => { current = render(element(), hooks) })
    current = render(element(), hooks)
    hooks.runEffects()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const button = () => collect(current).find((n) => n.tag === 'button' && String(n.props?.className ?? '').includes('mem-scope-btn'))!
    const togglePanel = async () => {
      ;(button().props!.onClick as (event: unknown) => void)({ currentTarget: { getBoundingClientRect: () => ({ left: 40, top: 500 }) } })
      await new Promise((resolve) => setTimeout(resolve, 0))
      hooks.runEffects()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const handbook = () => collect(current).find((n) => n.tag === 'div'
      && String(n.props?.className ?? '').includes('mem-scope-item') && textOf(n).includes('handbook'))!
    const check = () => collect(handbook()).find((n) => n.tag === 'button' && String(n.props?.className ?? '').includes('mem-scope-check'))!

    await togglePanel()
    assert.equal(String(check().props?.['aria-checked']), 'true', 'AI 授权的行默认勾选')
    // 取消勾选 = 草稿「待撤销」，然后直接关掉浮窗（不保存）。
    ;(check().props!.onClick as () => void)()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.ok(textOf(handbook()).includes('AI·待撤销'), '草稿里标成待撤销')
    await togglePanel()
    assert.ok(!textOf(current).includes('已选'), '浮窗已关闭')

    // 重开：草稿不能记住，勾选与气泡回到服务端真值。
    await togglePanel()
    assert.equal(String(check().props?.['aria-checked']), 'true', '没保存就关掉，重开时勾选还原')
    assert.ok(textOf(handbook()).includes('AI'), '气泡还在')
    assert.ok(!textOf(handbook()).includes('待撤销'), '「待撤销」草稿不跨关闭')
    assert.ok(textOf(current).includes('已选 2'), '计数也回到真值')
  } finally {
    ;(globalThis as Record<string, unknown>).fetch = savedFetch
  }
  hooks.resetAll()
})

test('记忆权限浮窗:已勾选在上、未勾选在下按字母序;取消勾选后点保存才重排', async () => {
  const { exports, hooks } = await loadBundle()
  hooks.resetAll()
  const Button = (exports.__test as { MemoryVisibilityButton: (p: Record<string, unknown>) => unknown }).MemoryVisibilityButton
  const payload = {
    sessionId: 's1',
    override: null,
    effective: { level: 'normal', scopes: [{ scope: 'beta' }, { scope: 'gamma' }] },
    source: 'default',
    inherited: false,
    defaults: [],
    defaultScopes: [],
    bindings: [],
    scopes: [
      { scope: 'delta', label: 'delta', records: 0 },
      { scope: 'gamma', label: 'gamma', records: 0 },
      { scope: 'beta', label: 'Beta', records: 0 },
      { scope: 'alpha', label: 'alpha', records: 0 },
    ],
  }
  // 保存后只剩 beta 勾选:重开面板时顺序应当按这个新状态重排。
  const updated = { ...payload, effective: { level: 'normal', scopes: [{ scope: 'beta' }] } }
  let saved = false
  const savedFetch = (globalThis as Record<string, unknown>).fetch
  ;(globalThis as Record<string, unknown>).fetch = async (url: string, init?: { method?: string; body?: string }) => {
    if (url === '/memory/api/visibility' && init?.method === 'POST') saved = true
    return { status: 200, json: async () => ({ ok: true, value: saved ? updated : payload }) }
  }
  try {
    let current: RenderNode | null = null
    const element = () => hooks.React.createElement(Button, { sessionId: 's1' })
    hooks.setRerender(() => { current = render(element(), hooks) })
    current = render(element(), hooks)
    hooks.runEffects()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const button = () => collect(current).find((n) => n.tag === 'button' && String(n.props?.className ?? '').includes('mem-scope-btn'))!
    ;(button().props!.onClick as (event: unknown) => void)({ currentTarget: { getBoundingClientRect: () => ({ left: 40, top: 500 }) } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    hooks.runEffects()
    await new Promise((resolve) => setTimeout(resolve, 0))

    /** 列表里的作用域名称,按渲染顺序(DOM 顺序)。 */
    const labels = () => collect(current)
      .filter((n) => n.tag === 'div' && String(n.props?.className ?? '').split(' ').includes('mem-scope-item'))
      .map((n) => textOf(collect(n).find((c) => c.tag === 'button' && String(c.props?.className ?? '') === 'mem-scope-label') ?? null))
    assert.deepEqual(labels(), ['Beta', 'gamma', 'alpha', 'delta'], '已勾选的 Beta / gamma 在上面,组内按字母排序')

    // 取消勾选 gamma:草稿里勾选立即消失,但顺序不动(要保存后才重排)。
    const gammaItem = collect(current).find((n) => n.tag === 'div'
      && String(n.props?.className ?? '').split(' ').includes('mem-scope-item')
      && textOf(n).includes('gamma'))
    assert.ok(gammaItem, 'gamma 作用域行存在')
    const gammaCheck = collect(gammaItem).find((n) => n.tag === 'button'
      && String(n.props?.className ?? '').split(' ').includes('mem-scope-check'))
    assert.ok(gammaCheck, 'gamma 行内有勾选框')
    ;(gammaCheck!.props!.onClick as () => void)()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(labels(), ['Beta', 'gamma', 'alpha', 'delta'], '保存前不重排')

    // 点保存 → 面板关闭；重开时按保存后的勾选重排（gamma 沉到未勾选区）。
    const saveButton = collect(current).find((n) => n.tag === 'button' && String(n.props?.className ?? '').includes('mem-scope-save'))
    assert.ok(saveButton, '保存按钮存在')
    ;(saveButton!.props!.onClick as () => void)()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    ;(button().props!.onClick as (event: unknown) => void)({ currentTarget: { getBoundingClientRect: () => ({ left: 40, top: 500 }) } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    hooks.runEffects()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(labels(), ['Beta', 'alpha', 'delta', 'gamma'], '保存后按新勾选重排,未勾选组内仍按字母序')
  } finally {
    ;(globalThis as Record<string, unknown>).fetch = savedFetch
  }
  hooks.resetAll()
})

test('记忆权限浮窗:整张作用域卡片可点选(按钮与勾选框除外)', async () => {
  const { exports, hooks } = await loadBundle()
  hooks.resetAll()
  const Button = (exports.__test as { MemoryVisibilityButton: (p: Record<string, unknown>) => unknown }).MemoryVisibilityButton
  const payload = {
    sessionId: 's1',
    override: null,
    effective: { level: 'normal', scopes: [{ scope: 'session:s1' }] },
    source: 'default',
    inherited: false,
    defaults: ['session:s1'],
    defaultScopes: ['session:s1'],
    bindings: [],
    scopes: [
      { scope: 'session:s1', label: 'session:当前会话', records: 1 },
      { scope: 'handbook', label: 'handbook', records: 1 },
    ],
  }
  const savedFetch = (globalThis as Record<string, unknown>).fetch
  ;(globalThis as Record<string, unknown>).fetch = async (url: string) => {
    if (url.startsWith('/memory/api/grants?')) {
      return { status: 200, json: async () => ({ ok: true, value: { sessionId: 's1', grants: [] } }) }
    }
    return { status: 200, json: async () => ({ ok: true, value: payload }) }
  }
  try {
    let current: RenderNode | null = null
    const element = () => hooks.React.createElement(Button, { sessionId: 's1' })
    hooks.setRerender(() => { current = render(element(), hooks) })
    current = render(element(), hooks)
    hooks.runEffects()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const button = () => collect(current).find((n) => n.tag === 'button' && String(n.props?.className ?? '').includes('mem-scope-btn'))!
    ;(button().props!.onClick as (event: unknown) => void)({ currentTarget: { getBoundingClientRect: () => ({ left: 40, top: 500 }) } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    hooks.runEffects()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const item = () => collect(current).find((n) => n.tag === 'div'
      && String(n.props?.className ?? '').split(' ').includes('mem-scope-item')
      && textOf(n).includes('handbook'))!
    const check = () => collect(item()).find((n) => n.tag === 'button'
      && String(n.props?.className ?? '').split(' ').includes('mem-scope-check'))!
    /** 模拟一次「点卡片空白处」:target 不是任何可交互元素。 */
    const clickCard = async (target: unknown = { closest: () => null }) => {
      ;(item().props!.onClick as (event: unknown) => void)({ target })
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    /** 模拟点行内某个 button:事件从按钮冒泡到卡片。 */
    const buttonTarget = { closest: (selector: string) => (selector.includes('button') ? {} : null) }

    assert.equal(String(check().props?.['aria-checked']), 'false', '初始未勾选')
    // 卡片留白 / 名称 / 计数区域都能勾选,不用去戳 16px 的小方块。
    await clickCard()
    assert.equal(String(check().props?.['aria-checked']), 'true', '点卡片即可勾选')
    assert.ok(textOf(current).includes('已选 2'), '计数跟着勾选走')

    // 按钮自己处理点击:冒泡上来的按钮事件不再切换第二次。
    await clickCard(buttonTarget)
    assert.equal(String(check().props?.['aria-checked']), 'true', '点按钮不额外切换卡片')

    // 点勾选框 + 冒泡到卡片:只切换一次。
    ;(check().props!.onClick as () => void)()
    await clickCard(buttonTarget)
    assert.equal(String(check().props?.['aria-checked']), 'false', '点勾选框只切换一次')

    // 点名称按钮(它自己也绑定 toggle)+ 冒泡到卡片:仍然只切换一次。
    const label = collect(item()).find((n) => n.tag === 'button' && String(n.props?.className ?? '') === 'mem-scope-label')!
    ;(label.props!.onClick as () => void)()
    await clickCard(buttonTarget)
    assert.equal(String(check().props?.['aria-checked']), 'true', '点名称只切换一次')
    // 再次点卡片空白处取消勾选。
    await clickCard()
    assert.equal(String(check().props?.['aria-checked']), 'false', '再点卡片可取消勾选')

    // 状态按钮(绑定 / 可读 / 可写)不触发勾选切换。
    const bind = collect(item()).find((n) => n.tag === 'button'
      && String(n.props?.className ?? '').split(' ').includes('bind'))!
    ;(bind.props!.onClick as () => void)()
    await clickCard(buttonTarget)
    assert.equal(String(check().props?.['aria-checked']), 'false', '点绑定按钮不改变勾选')
  } finally {
    ;(globalThis as Record<string, unknown>).fetch = savedFetch
  }
  hooks.resetAll()
})

test('记忆范围浮窗:深色模式用 business-primary + 前景色,列表高度收紧', async () => {
  const { exports } = await loadBundle()
  const css = (exports.__test as { CSS: string }).CSS
  assert.match(css, /\.mem-scope-check\.on \.box\{[^}]*state-business-primary[^}]*label-primary-foreground/, '选中勾选框用主题业务色 + 可翻转前景色')
  assert.match(css, /\.mem-scope-save\{[^}]*state-business-primary[^}]*label-primary-foreground/, '保存按钮不再用近白色的 brand-primary 填充')
  assert.match(css, /\.mem-scope-list\{[^}]*max-height:min\(220px,32vh\)/, '滚动列表高度收紧')
  assert.match(css, /\.mem-scope-pop\{[^}]*max-height:min\(520px,72vh\)/, '浮窗整体高度收紧')
  // 0.25.8：浮窗 portal 到 body，层级要压过会话里的「回到底部」圆钮（z-index:8），
  // 又不能盖住宿主自己的对话框 / 提示层（1000 起）。
  assert.match(css, /\.mem-scope-pop\{[^}]*position:fixed[^}]*z-index:900/, '浮窗层级在会话浮动件之上、宿主弹窗之下')
  // 0.25.5：AI 授权勾选的行与用户勾选的行样式分开（虚线 + 描边勾选框，不套实心蓝底）。
  assert.match(css, /\.mem-scope-item\.ai\{[^}]*border-style:dashed/, 'AI 授权的行用虚线边框')
  assert.match(css, /\.mem-scope-item\.ai\{[^}]*background:color-mix\(in srgb,var\(--dsw-alias-label-primary\) 3%/, 'AI 授权的行不用用户选中的蓝色底')
  assert.match(css, /\.mem-scope-check\.on\.ai \.box\{[^}]*background:transparent[^}]*border-style:dashed/, 'AI 授权勾选框是描边虚线，不是实心蓝底')
  // 0.25.7：整张卡片可点选，鼠标形态与拖选行为要跟着变。
  assert.match(css, /\.mem-scope-item\{[^}]*cursor:pointer/, '作用域卡片显示可点击')
  assert.match(css, /\.mem-scope-item\{[^}]*user-select:none/, '拖选不会误触勾选')
})

test('记忆范围按钮:数字展示范围,边框样式展示限制等级(橙黄实线/蓝色实线/灰色虚线)', async () => {
  const { exports } = await loadBundle()
  const css = (exports.__test as { CSS: string }).CSS
  assert.match(css, /\.mem-scope-btn\.is-absolute\{[^}]*border-color:var\(--dsw-alias-state-warn-primary/, '绝对限制 = 橙黄实线边框')
  assert.match(css, /\.mem-scope-btn\.is-normal\{[^}]*border-color:var\(--dsw-alias-state-business-primary/, '普通限制 = 蓝色实线边框')
  assert.match(css, /\.mem-scope-btn\.is-none\{[^}]*border:1px dashed/, '无限制 = 灰色虚线边框')

  // 三种等级各自渲染对应的 class,按钮文字仍然只有数字。
  const { exports: full, hooks } = await loadBundle()
  const Button = (full.__test as { MemoryVisibilityButton: (p: Record<string, unknown>) => unknown }).MemoryVisibilityButton
  const savedFetch = (globalThis as Record<string, unknown>).fetch
  for (const [level, expected] of [['absolute', 'is-absolute'], ['normal', 'is-normal'], ['none', 'is-none']] as const) {
    hooks.resetAll()
    ;(globalThis as Record<string, unknown>).fetch = async () => ({
      status: 200,
      json: async () => ({
        ok: true,
        value: {
          sessionId: 's1',
          override: null,
          effective: { level, scopes: [{ scope: 'session:s1' }, { scope: 'global' }] },
          source: 'default',
          inherited: false,
          defaults: ['session:s1', 'global'],
          scopes: [{ scope: 'session:s1', label: 'session:当前会话', records: 1 }, { scope: 'global', label: 'global:全局', records: 2 }],
        },
      }),
    })
    let current: RenderNode | null = null
    const element = () => hooks.React.createElement(Button, { sessionId: 's1' })
    hooks.setRerender(() => { current = render(element(), hooks) })
    current = render(element(), hooks)
    hooks.runEffects()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const button = collect(current).find((n) => n.tag === 'button' && String(n.props?.className ?? '').includes('mem-scope-btn'))
    assert.ok(button, `${level}:按钮存在`)
    assert.match(String(button!.props!.className), new RegExp(expected), `${level}:边框样式`)
    assert.equal(textOf(button), '2', `${level}:按钮只显示作用域数量`)
  }
  hooks.resetAll()
  ;(globalThis as Record<string, unknown>).fetch = savedFetch
})

test('审批卡:只在所属会话显示,读审批可逐条允许', async () => {
  const { exports, hooks } = await loadBundle()
  hooks.resetAll()
  const Dock = (exports.__test as { MemoryApprovalDock: (p: Record<string, unknown>) => unknown }).MemoryApprovalDock
  const calls: Array<{ url: string; init?: { method?: string; body?: string } }> = []
  const item = (id: string, content: string) => ({
    id,
    scope: 'global',
    kind: 'rule',
    content,
    tags: ['release'],
    importance: 0.9,
    updatedAt: 1,
    reason: 'scope',
  })
  const approval = {
    id: 'a1',
    sessionId: 's1',
    tool: 'memory_search',
    action: 'read',
    query: '发布流程',
    items: [item('abcdef1234567890', '范围外规则：发布前必须跑完整测试。'), item('12345678abcdef00', '另一条范围外记忆。')],
    createdAt: 1,
    expiresAt: 2,
  }
  // 另一个会话的审批不该出现在当前会话里。
  const other = {
    id: 'a2',
    sessionId: 's2',
    tool: 'memory_get',
    action: 'read',
    query: '别的会话',
    items: [item('ffffffff00000000', '别的会话的内容。')],
    createdAt: 3,
    expiresAt: 4,
  }
  const savedFetch = (globalThis as Record<string, unknown>).fetch
  ;(globalThis as Record<string, unknown>).fetch = async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, init })
    if (init === undefined || init.method === 'GET') {
      return { status: 200, json: async () => ({ ok: true, value: { approvals: [other, approval] } }) }
    }
    return { status: 200, json: async () => ({ ok: true, value: { answered: true } }) }
  }
  try {
    let current: RenderNode | null = null
    const element = () => hooks.React.createElement(Dock, { sessionId: 's1' })
    hooks.setRerender(() => { current = render(element(), hooks) })
    current = render(element(), hooks)
    hooks.runEffects()
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.equal(calls[0]?.url, '/memory/api/approvals?session=s1', '按会话轮询待审批')
    const text = textOf(current)
    assert.ok(text.includes('等待审批'), '与系统审批弹窗一致的等待条')
    assert.ok(text.includes('工具 memory_search 请求读取可见域外的记忆'), '标题带工具名与动作')
    assert.ok(text.includes('发布流程'), '展示 Agent 的查询关键词')
    assert.ok(text.includes('范围外规则：发布前必须跑完整测试。'), '展示范围外记忆摘要')
    assert.ok(!text.includes('别的会话的内容。'), '别的会话的审批不显示在当前会话')
    const checks = collect(current).filter((n) => n.tag === 'button' && String(n.props?.className ?? '').includes('mem-approval-check'))
    assert.equal(checks.length, 2, '读审批每条一个勾选框')
    assert.deepEqual(checks.map((box) => box.props?.['aria-checked']), [true, true], '默认全选')
    assert.ok(text.includes('拒绝') && text.includes('允许一次'), '两个审批动作')

    // 全选 = 老口径,不带 allowedIds。
    const allow = collect(current).find((n) => n.tag === 'button' && textOf(n).trim() === '允许一次')
    assert.ok(allow, '允许一次按钮')
    ;(allow!.props!.onClick as () => void)()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(calls[1]?.url, '/memory/api/approvals')
    const posted = JSON.parse(String(calls[1]?.init?.body ?? '{}')) as { id: string; outcome: string; allowedIds?: string[] }
    assert.deepEqual(posted, { id: 'a1', outcome: 'allowed-once' })
  } finally {
    ;(globalThis as Record<string, unknown>).fetch = savedFetch
  }
  hooks.resetAll()
})

test('侧边栏阻塞提示:把待审批发布成宿主 approval 类型的 pending interaction', async () => {
  const { exports } = await loadBundle()
  const testApi = exports.__test as {
    installApprovalPresence: (ctx: unknown) => void
    approvalPresenceSync: () => (() => void) | null
  }
  const published: Array<{ interaction: Record<string, unknown>; delegate: () => void }> = []
  const removed: string[] = []
  let effectDispose: (() => void) | null = null
  const uiSession = {
    registerPendingInteraction(precedence: (interaction: unknown) => number) {
      assert.equal(typeof precedence, 'function')
      assert.equal(precedence({ kind: 'approval' }), 0, '与宿主导入的 approval 同优先级')
      return (interaction: Record<string, unknown>, delegate: () => void) => {
        published.push({ interaction, delegate })
        return () => { removed.push(String(interaction.key)) }
      }
    },
  }
  const ctx = {
    inject(deps: string[], callback: (scope: unknown) => void) {
      assert.deepEqual(deps, ['uiSession'])
      callback({
        uiSession,
        effect(fn: () => unknown) {
          const dispose = fn()
          effectDispose = typeof dispose === 'function' ? dispose as () => void : null
          return dispose
        },
      })
      return () => {}
    },
  }
  const savedFetch = (globalThis as Record<string, unknown>).fetch
  const calls: string[] = []
  let payload: unknown[] = [
    { id: 'a1', sessionId: 's1', tool: 'memory_search', action: 'read', createdAt: 1, expiresAt: 2 },
    // 同一会话的第二条审批也要发布，回答其中一条时不能把另一条一起撤掉。
    { id: 'a2', sessionId: 's1', tool: 'memory_get', action: 'read', createdAt: 2, expiresAt: 3 },
    // 拿不到会话的旧审批（sessionId 为空）没有侧边栏行可标，跳过。
    { id: 'a3', sessionId: '', tool: 'memory_search', action: 'read', createdAt: 3, expiresAt: 4 },
  ]
  ;(globalThis as Record<string, unknown>).fetch = async (url: string) => {
    calls.push(url)
    return { status: 200, json: async () => ({ ok: true, value: { approvals: payload } }) }
  }
  try {
    testApi.installApprovalPresence(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(calls, ['/memory/api/approvals?summary=1'], '只拉轻量摘要')
    assert.equal(published.length, 2, '每个有会话的待审批发布一条')
    const first = published[0].interaction
    assert.equal(first.kind, 'approval', '侧边栏按 approval 类型显示黄点/待审批')
    assert.equal(first.sessionId, 's1')
    assert.equal(first.key, 'memory-approval:a1')
    assert.equal(first.toolName, 'memory_search')
    assert.deepEqual(published.map((entry) => entry.interaction.key), ['memory-approval:a1', 'memory-approval:a2'])

    // 回答 a1 后，下一次同步只撤销 a1，a2 的黄点必须保留。
    payload = [payload[1]]
    testApi.approvalPresenceSync()?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(removed, ['memory-approval:a1'])
    assert.equal(published.length, 2, 'a1 已经发布过，不重复发布')
  } finally {
    ;(globalThis as Record<string, unknown>).fetch = savedFetch
    if (effectDispose !== null) (effectDispose as () => void)()
  }
  assert.deepEqual(removed.sort(), ['memory-approval:a1', 'memory-approval:a2'], '插件卸载时清掉全部阻塞提示')
  assert.equal(testApi.approvalPresenceSync(), null, '卸载后不再保留同步器')
})

test('审批卡:grant 模式默认只勾只读,允许后只提交只读权限', async () => {
  const { exports, hooks } = await loadBundle()
  hooks.resetAll()
  const Dock = (exports.__test as { MemoryApprovalDock: (p: Record<string, unknown>) => unknown }).MemoryApprovalDock
  const calls: Array<{ url: string; init?: { method?: string; body?: string } }> = []
  const approval = {
    id: 'g1',
    sessionId: 's1',
    tool: 'memory_scopes',
    action: 'read',
    mode: 'grant',
    query: '需要团队约定',
    items: [
      { id: 'grant:handbook:read', scope: 'handbook', kind: 'grant', content: '只读访问', tags: [], importance: 0, updatedAt: 1, reason: 'scope', grantPermission: 'read' },
      { id: 'grant:handbook:write', scope: 'handbook', kind: 'grant', content: '写入 / 删除', tags: [], importance: 0, updatedAt: 2, reason: 'scope', grantPermission: 'write' },
    ],
    createdAt: 1,
    expiresAt: 2,
  }
  const savedFetch = (globalThis as Record<string, unknown>).fetch
  ;(globalThis as Record<string, unknown>).fetch = async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, init })
    if (init === undefined || init.method === 'GET') {
      return { status: 200, json: async () => ({ ok: true, value: { approvals: [approval] } }) }
    }
    return { status: 200, json: async () => ({ ok: true, value: { answered: true } }) }
  }
  try {
    let current: RenderNode | null = null
    const element = () => hooks.React.createElement(Dock, { sessionId: 's1' })
    hooks.setRerender(() => { current = render(element(), hooks) })
    current = render(element(), hooks)
    hooks.runEffects()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const text = textOf(current)
    assert.ok(text.includes('申请访问可见域外的作用域'), 'grant 模式用申请文案')
    assert.ok(text.includes('授权仅在本会话有效'), '说明授权范围')
    assert.ok(text.includes('只读') && text.includes('可写'), '两种权限都展示')
    const checks = collect(current).filter((n) => n.tag === 'button' && String(n.props?.className ?? '').includes('mem-approval-check'))
    assert.deepEqual(checks.map((box) => box.props?.['aria-checked']), [true, false], '默认只勾只读')

    const allow = collect(current).find((n) => n.tag === 'button' && String(n.props?.className ?? '').includes('mem-approval-allow'))
    assert.ok(String(textOf(allow)).includes('允许选中的 1 项（本会话）'))
    ;(allow!.props!.onClick as () => void)()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const posted = JSON.parse(String(calls[1]?.init?.body ?? '{}')) as { id: string; outcome: string; allowedIds?: string[] }
    assert.deepEqual(posted, { id: 'g1', outcome: 'allowed-once', allowedIds: ['grant:handbook:read'] })
  } finally {
    ;(globalThis as Record<string, unknown>).fetch = savedFetch
  }
  hooks.resetAll()
})

test('审批卡:取消勾选后只允许选中的部分记忆', async () => {
  const { exports, hooks } = await loadBundle()
  hooks.resetAll()
  const Dock = (exports.__test as { MemoryApprovalDock: (p: Record<string, unknown>) => unknown }).MemoryApprovalDock
  const calls: Array<{ url: string; init?: { method?: string; body?: string } }> = []
  const approval = {
    id: 'a1',
    sessionId: 's1',
    tool: 'memory_search',
    action: 'read',
    query: '发布流程',
    items: ['abcdef1234567890', '12345678abcdef00'].map((id) => ({
      id,
      scope: 'global',
      kind: 'rule',
      content: `内容 ${id}`,
      tags: [],
      importance: 0.5,
      updatedAt: 1,
      reason: 'scope',
    })),
    createdAt: 1,
    expiresAt: 2,
  }
  const savedFetch = (globalThis as Record<string, unknown>).fetch
  ;(globalThis as Record<string, unknown>).fetch = async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, init })
    if (init === undefined || init.method === 'GET') {
      return { status: 200, json: async () => ({ ok: true, value: { approvals: [approval] } }) }
    }
    return { status: 200, json: async () => ({ ok: true, value: { answered: true } }) }
  }
  try {
    let current: RenderNode | null = null
    const element = () => hooks.React.createElement(Dock, { sessionId: 's1' })
    hooks.setRerender(() => { current = render(element(), hooks) })
    current = render(element(), hooks)
    hooks.runEffects()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const checks = collect(current).filter((n) => n.tag === 'button' && String(n.props?.className ?? '').includes('mem-approval-check'))
    assert.equal(checks.length, 2)
    ;(checks[0]!.props!.onClick as () => void)()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const allow = collect(current).find((n) => n.tag === 'button' && String(n.props?.className ?? '').includes('mem-approval-allow'))
    assert.ok(allow, '允许按钮存在')
    assert.equal(textOf(allow).trim(), '允许选中的 1 条', '按勾选数量换按钮文案')
    ;(allow!.props!.onClick as () => void)()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const post = calls.find((call) => call.init?.method === 'POST')
    assert.ok(post, '回答走 POST')
    const posted = JSON.parse(String(post?.init?.body ?? '{}')) as { id: string; outcome: string; allowedIds?: string[] }
    assert.deepEqual(posted, { id: 'a1', outcome: 'allowed-once', allowedIds: ['12345678abcdef00'] }, '只把勾选的 id 交给服务端')
  } finally {
    ;(globalThis as Record<string, unknown>).fetch = savedFetch
  }
  hooks.resetAll()
})

test('审批卡样式对齐系统审批弹窗:警告色 strip + 同一批主题 token', async () => {
  const { exports } = await loadBundle()
  const css = (exports.__test as { CSS: string }).CSS
  assert.match(css, /\.mem-approval-card\{[^}]*state-warn-secondary[^}]*dsw-radius-xl[^}]*specific-input-major[^}]*dsw-shadow-lv2/, '卡片边框/圆角/底色/阴影与系统审批卡同一批 token')
  assert.match(css, /\.mem-approval-strip\{[^}]*state-warn-tertiary[^}]*state-warn-primary/, '等待条用警告色')
  assert.doesNotMatch(css, /\.mem-approval\{[^}]*position:fixed/, '不再是全局 fixed 浮层')
  // 0.22.2 回归:command/desc 带 overflow:auto,flex 自动最小尺寸会变成 0;
  // 条目一多,列表把整张卡顶到 max-height 时它们会被压成 0 高(查询/说明消失)。
  for (const cls of ['headline', 'hint', 'command', 'desc', 'bulk']) {
    assert.match(css, new RegExp(`\\.mem-approval-${cls}\\{[^}]*flex:none`), `详情行 ${cls} 必须锁住,不能被列表压缩`)
  }
  assert.match(css, /\.mem-approval-list\{[^}]*min-height:0/, '只有条目列表可以收缩')
  // 0.22.3:26vh 那层上限会让矮窗口里的列表只剩十几像素;与宿主审批卡同口径,
  // 只受 composer 文本区最大高度约束。
  assert.match(css, /\.mem-approval-body\{[^}]*max-height:var\(--dsh-composer-text-max-height/, '审批卡高度与宿主审批卡同口径')
  assert.doesNotMatch(css, /\.mem-approval-body\{[^}]*46vh/, '不再叠一层 46vh 上限')
})

test('审批卡:全选/取消全选、展示 Agent 说明、点记忆 ID 跳到面板记录页', async () => {
  const { exports, hooks } = await loadBundle()
  hooks.resetAll()
  const Dock = (exports.__test as { MemoryApprovalDock: (p: Record<string, unknown>) => unknown }).MemoryApprovalDock
  const testApi = exports.__test as {
    takeRecordFocus: () => { id?: string; scope?: string } | null
    requestRecordFocus: (target: unknown) => void
  }
  const item = (id: string, content: string) => ({
    id,
    scope: 'global',
    kind: 'rule',
    content,
    tags: [],
    importance: 0.5,
    updatedAt: 1,
    reason: 'scope',
  })
  const approval = {
    id: 'a1',
    sessionId: 's1',
    tool: 'memory_search',
    action: 'read',
    query: '发布流程',
    description: '查发布流程是否踩过坑',
    items: [item('abcdef1234567890', '范围外规则 A'), item('12345678abcdef00', '范围外规则 B')],
    createdAt: 1,
    expiresAt: 2,
  }
  const savedFetch = (globalThis as Record<string, unknown>).fetch
  ;(globalThis as Record<string, unknown>).fetch = async (url: string, init?: { method?: string }) => {
    if (init === undefined || init.method === 'GET') {
      return { status: 200, json: async () => ({ ok: true, value: { approvals: [approval] } }) }
    }
    return { status: 200, json: async () => ({ ok: true, value: { answered: true } }) }
  }
  const bulk = (label: string) => collect(current).find((n) =>
    n.tag === 'button' && ['全选', '取消全选'].includes(textOf(n).trim()) && textOf(n).trim() === label)
  const checks = () => collect(current).filter((n) => n.tag === 'button' && String(n.props?.className ?? '').includes('mem-approval-check'))
  let current: RenderNode | null = null
  try {
    const element = () => hooks.React.createElement(Dock, { sessionId: 's1' })
    hooks.setRerender(() => { current = render(element(), hooks) })
    current = render(element(), hooks)
    hooks.runEffects()
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.ok(textOf(current).includes('Agent 说明：查发布流程是否踩过坑'), '审批卡展示工具调用的 description')
    assert.ok(bulk('全选') && bulk('取消全选'), '逐条勾选之外还有全选 / 取消全选')

    ;(bulk('取消全选')!.props!.onClick as () => void)()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(checks().map((box) => box.props?.['aria-checked']), [false, false], '取消全选清空所有勾选')
    const allow = collect(current).find((n) => n.tag === 'button' && String(n.props?.className ?? '').includes('mem-approval-allow'))
    assert.equal(allow?.props?.disabled, true, '一条都没选时允许按钮禁用')

    ;(bulk('全选')!.props!.onClick as () => void)()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(checks().map((box) => box.props?.['aria-checked']), [true, true], '全选重新勾上所有条目')

    const idButton = collect(current).find((n) => n.tag === 'button' && String(n.props?.className ?? '') === 'mem-approval-id')
    assert.ok(idButton, '记忆 ID 是可点击按钮')
    ;(idButton!.props!.onClick as () => void)()
    const target = testApi.takeRecordFocus()
    assert.equal(target?.id, 'abcdef1234567890', '点击 ID 把焦点交给面板记录页')
    assert.equal(target?.scope, 'global')
    assert.equal((target as { record?: { content?: string } } | null)?.record?.content, '范围外规则 A', '带上记录快照,列表里没有时也能展开')
  } finally {
    ;(globalThis as Record<string, unknown>).fetch = savedFetch
    testApi.takeRecordFocus()
  }
  hooks.resetAll()
})

test('审批卡:整行点击即可选中条目,详情可折叠但动作行仍可用', async () => {
  const { exports, hooks } = await loadBundle()
  hooks.resetAll()
  const Dock = (exports.__test as { MemoryApprovalDock: (p: Record<string, unknown>) => unknown }).MemoryApprovalDock
  const item = (id: string, content: string) => ({
    id,
    scope: 'global',
    kind: 'rule',
    content,
    tags: [],
    importance: 0.5,
    updatedAt: 1,
    reason: 'scope',
  })
  const approval = {
    id: 'a1',
    sessionId: 's1',
    tool: 'memory_search',
    action: 'read',
    query: '发布流程',
    description: '查发布流程是否踩过坑',
    items: [item('abcdef1234567890', '范围外规则 A'), item('12345678abcdef00', '范围外规则 B')],
    createdAt: 1,
    expiresAt: 2,
  }
  const savedFetch = (globalThis as Record<string, unknown>).fetch
  ;(globalThis as Record<string, unknown>).fetch = async (url: string, init?: { method?: string }) => {
    if (init === undefined || init.method === 'GET') {
      return { status: 200, json: async () => ({ ok: true, value: { approvals: [approval] } }) }
    }
    return { status: 200, json: async () => ({ ok: true, value: { answered: true } }) }
  }
  let current: RenderNode | null = null
  const rows = () => collect(current).filter((n) => n.tag === 'div' && String(n.props?.className ?? '').split(/\s+/).includes('mem-approval-item'))
  const checks = () => collect(current).filter((n) => n.tag === 'button' && String(n.props?.className ?? '').includes('mem-approval-check'))
  try {
    const element = () => hooks.React.createElement(Dock, { sessionId: 's1' })
    hooks.setRerender(() => { current = render(element(), hooks) })
    current = render(element(), hooks)
    hooks.runEffects()
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.equal(rows().length, 2, '两条记忆各一行')
    assert.match(String(rows()[0]!.props!.className), /is-clickable/, '整行可点选')
    ;(rows()[0]!.props!.onClick as () => void)()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(checks().map((box) => box.props?.['aria-checked']), [false, true], '点击行本身就能取消该条')

    const toggle = collect(current).find((n) => n.tag === 'button' && String(n.props?.className ?? '').includes('mem-approval-toggle'))
    assert.ok(toggle, 'strip 上有折叠按钮')
    assert.equal(toggle!.props?.['aria-expanded'], true)
    ;(toggle!.props!.onClick as () => void)()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.ok(!textOf(current).includes('Agent 查询：'), '折叠后隐藏详情')
    assert.ok(!textOf(current).includes('范围外规则 A'), '折叠后隐藏记忆摘要')
    assert.ok(textOf(current).includes('等待审批'), 'strip 仍在')
    assert.ok(textOf(current).includes('拒绝') && textOf(current).includes('允许选中的 1 条'), '折叠后仍可直接审批')
    assert.equal(collect(current).find((n) => String(n.props?.className ?? '').includes('mem-approval-toggle'))?.props?.['aria-expanded'], false)

    ;((collect(current).find((n) => String(n.props?.className ?? '').includes('mem-approval-toggle'))!).props!.onClick as () => void)()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.ok(textOf(current).includes('Agent 查询：'), '再点一次恢复展开')
  } finally {
    ;(globalThis as Record<string, unknown>).fetch = savedFetch
  }
  hooks.resetAll()
})


test('记忆视图用 composer overlay 占满高度，滚动只发生在审计列表里', async () => {
  const { exports, hooks } = await loadBundle()
  hooks.resetAll()
  const View = (exports.__test as { MemoryAuditView: (p: Record<string, unknown>) => unknown }).MemoryAuditView
  const tree = render(hooks.React.createElement(View, {
    sessionId: 's1',
    openView: () => {},
    sessionInfo: () => ({}),
  }), hooks)
  assert.equal(tree?.props?.['data-conversation-composer-overlay'], '', '声明 composer overlay，让壳层压住外层滚动')
  const css = (exports.__test as { CSS: string }).CSS
  assert.match(css, /\.mem-view\{[^}]*height:100%/, '记忆视图占满 viewArea')
  assert.match(css, /\.mem-view-body\{[^}]*overflow:hidden/, '外层内容不滚动')
  assert.match(css, /\.mem-view \.audit\{height:100%/, '审计页填满剩余高度')
  assert.doesNotMatch(css, /\.mem-head-btn/, '会话头部按钮样式已移除')
})

test('轨迹详情页签展示该 callId 的审计并可打开本会话面板', async () => {
  const { exports, hooks } = await loadBundle()
  hooks.resetAll()
  const testApi = exports.__test as {
    TrajectoryDetailAudit: (p: Record<string, unknown>) => unknown
    setClientCtx: (ctx: unknown) => void
    requestAuditFocus: (target: unknown) => void
  }
  const rect = (left: number, top: number, width: number, height: number) => ({
    left, top, right: left + width, bottom: top + height, width, height,
  })
  const tabs = { style: {} as Record<string, string>, getBoundingClientRect: () => rect(100, 100, 300, 34) }
  const body = { getBoundingClientRect: () => rect(100, 134, 300, 366) }
  const details = {
    getBoundingClientRect: () => rect(100, 60, 300, 440),
    querySelector: (selector: string) => selector.includes('_detailTabs') ? tabs : selector.includes('_detailBody') ? body : null,
  }
  const row = {
    getAttribute: (name: string) => name === 'data-trajectory-row-key' ? 'tool%00call%00call-9' : null,
    getBoundingClientRect: () => rect(0, 180, 700, 30),
  }
  const fakeDocument = {
    body: {},
    querySelector: (selector: string) => {
      if (selector.includes('tr[data-selected')) return row
      if (selector.includes('_details')) return details
      if (selector.includes('_composerSeat')) return null
      return null
    },
    addEventListener() {},
    removeEventListener() {},
  }
  const globals = globalThis as Record<string, unknown>
  const saved = { window: globals.window, document: globals.document, fetch: globals.fetch }
  globals.window = { innerWidth: 1200, addEventListener() {}, removeEventListener() {} }
  globals.document = fakeDocument
  globals.fetch = async () => ({
    status: 200,
    json: async () => ({
      ok: true,
      value: {
        entries: [{
          id: 'audit-1', seq: 1, at: Date.now(), sessionId: 's1', kind: 'signal',
          channel: 'signal', stage: 'tool_call', trigger: 'memory_tool', outcome: 'success',
          operationId: 'call-9', selected: { contentIds: ['mem-1'], hintIds: [], count: 1 },
        }],
        total: 1,
        stats: { entries: 1, capacity: 2000, perSessionCapacity: 200, dropped: 0, writeErrors: 0, persistence: 'memory' },
      },
    }),
  })
  testApi.setClientCtx({
    get: (name: string) => name === 'uiWorkspace'
      ? { sessions: { list: { getSnapshot: () => ({ byId: { s1: { id: 's1', retainedBy: { mainView: 1 } } } }) } } }
      : undefined,
  })
  const Component = testApi.TrajectoryDetailAudit
  const element = () => hooks.React.createElement(Component, {})
  let current: RenderNode | null = render(element(), hooks)
  hooks.setRerender(() => { current = render(element(), hooks) })
  hooks.runEffects()
  await new Promise((resolve) => setTimeout(resolve, 40))
  for (let i = 0; i < 6; i++) await Promise.resolve()
  const tab = collect(current).find((n) => String(n.props?.className ?? '').split(/\s+/).includes('mem-traj-audit-tab'))
  assert.ok(tab, '详情页签行出现「记忆审计」页签')
  assert.ok(textOf(tab).includes('记忆审计'))
  assert.equal(tabs.style.paddingRight, '96px', '为页签预留右侧空间')
  ;(tab!.props!.onClick as () => void)()
  for (let i = 0; i < 4; i++) await Promise.resolve()
  const pane = collect(current).find((n) => String(n.props?.className ?? '').split(/\s+/).includes('mem-traj-audit-pane'))
  assert.ok(pane, '页签打开后出现审计面板')
  const paneText = textOf(pane)
  assert.ok(paneText.includes('memory_tool'), '展示该 callId 的审计')
  assert.ok(paneText.includes('打开本会话记忆审计'), '提供跳回会话审计面板的按钮')
  ;(testApi.setClientCtx as (v: unknown) => void)(null)
  globals.window = saved.window
  globals.document = saved.document
  globals.fetch = saved.fetch
  hooks.resetAll()
})

test('轨迹列表给有审计的调用加产品线条图标', async () => {
  const { exports, hooks } = await loadBundle()
  hooks.resetAll()
  const testApi = exports.__test as {
    TrajectoryMemoryMarks: (p: Record<string, unknown>) => unknown
    setClientCtx: (ctx: unknown) => void
  }
  const rect = (left: number, top: number, width: number, height: number) => ({
    left, top, right: left + width, bottom: top + height, width, height,
  })
  const pane = { getBoundingClientRect: () => rect(0, 100, 700, 700) }
  const head = { getBoundingClientRect: () => rect(0, 100, 700, 30) }
  const composer = { getBoundingClientRect: () => rect(0, 700, 700, 152) }
  const root = { querySelector: (selector: string) => selector.includes('_composerSeat') ? composer : null }
  const table = { querySelector: (selector: string) => selector === 'thead' ? head : null }
  const row = (key: string, top: number) => ({
    getAttribute: (name: string) => name === 'data-trajectory-row-key' ? key : null,
    getBoundingClientRect: () => rect(100, top, 700, 30),
    closest: (selector: string) => {
      if (selector.includes('_tablePane')) return pane
      if (selector === 'table') return table
      if (selector.includes('_scrollBody')) return root
      return null
    },
  })
  const rows = [
    row('tool%00call%00call-1', 200),
    row('tool%00call%00call-2', 240),
    // 已经滚到 sticky 表头上方：即使有审计也不该留下 fixed 图标。
    row('tool%00call%00call-3', 80),
    // 在 composer 后面：行仍在 tablePane 内，但已被 composer 遮住。
    row('tool%00call%00call-4', 680),
  ]
  const globals = globalThis as Record<string, unknown>
  const saved = { window: globals.window, document: globals.document, fetch: globals.fetch }
  globals.window = { innerWidth: 1200, innerHeight: 900, addEventListener() {}, removeEventListener() {} }
  globals.document = {
    body: {},
    querySelector: (selector: string) => selector.includes('_composerSeat') ? composer : null,
    querySelectorAll: (selector: string) => selector.includes('tr[data-trajectory-row-key]') ? rows : [],
  }
  globals.fetch = async () => ({
    status: 200,
    json: async () => ({
      ok: true,
      value: {
        entries: [
          { id: 'a1', seq: 1, at: Date.now(), sessionId: 's1', kind: 'signal', channel: 'signal', stage: 'tool_call', outcome: 'success', operationId: 'call-1' },
          { id: 'a2', seq: 2, at: Date.now(), sessionId: 's1', kind: 'signal', channel: 'signal', stage: 'tool_call', outcome: 'success', operationId: 'call-1' },
          { id: 'a3', seq: 3, at: Date.now(), sessionId: 's1', kind: 'signal', channel: 'signal', stage: 'tool_call', outcome: 'success', operationId: 'call-3' },
          { id: 'a4', seq: 4, at: Date.now(), sessionId: 's1', kind: 'signal', channel: 'signal', stage: 'tool_call', outcome: 'success', operationId: 'call-4' },
        ],
        total: 4,
        stats: { entries: 4, capacity: 2000, perSessionCapacity: 200, dropped: 0, writeErrors: 0, persistence: 'memory' },
      },
    }),
  })
  testApi.setClientCtx({
    get: (name: string) => name === 'uiWorkspace'
      ? { sessions: { list: { getSnapshot: () => ({ byId: { s1: { id: 's1', retainedBy: { mainView: 1 } } } }) } } }
      : undefined,
  })
  const Component = testApi.TrajectoryMemoryMarks
  const element = () => hooks.React.createElement(Component, {})
  let current: RenderNode | null = render(element(), hooks)
  hooks.setRerender(() => { current = render(element(), hooks) })
  try {
    hooks.runEffects()
    await new Promise((resolve) => setTimeout(resolve, 160))
    for (let i = 0; i < 8; i++) await Promise.resolve()
    const markNodes = collect(current).filter((n) => String(n.props?.className ?? '').split(/\s+/).includes('mem-traj-mark'))
    assert.equal(markNodes.length, 1, '只有完整可见的 call-1 标记；call-2 无审计、call-3 被表头裁掉、call-4 被 composer 遮住')
    assert.ok(String(markNodes[0].props?.title ?? '').includes('2 条记忆审计'), '图标 title 带审计条数')
    assert.ok(Number(markNodes[0].props?.style?.top) > 200, '图标跟随行位置')
  } finally {
    ;(testApi.setClientCtx as (v: unknown) => void)(null)
    globals.window = saved.window
    globals.document = saved.document
    globals.fetch = saved.fetch
    hooks.resetAll()
  }
})

test('主面板审计详情走 jumpAuditEntryToTrajectory（不需要 openTrajectory 回调）', async () => {
  const { exports, hooks } = await loadBundle()
  hooks.resetAll()
  const testApi = exports.__test as {
    AuditTab: (p: Record<string, unknown>) => unknown
    setClientCtx: (ctx: unknown) => void
  }
  const handle = {}
  const seen: [string, string | undefined][] = []
  const opened: string[] = []
  const store = { actions: { openView: (view: string, focus?: string) => { seen.push([view, focus]) } } }
  const slots = {
    entries: (key: string) => key === 'conversation.session' ? [{ store: handle }] : [],
    _stores: new Map([[handle, { instances: new Map([['s1', store]]) }]]),
  }
  testApi.setClientCtx({
    get: (name: string) => name === 'slots' ? slots : name === 'uiWorkspace' ? {
      openSession: (id: string) => { opened.push(id) },
      sessions: { list: { getSnapshot: () => ({ byId: { s1: { id: 's1', retainedBy: { mainView: 1 } } } }) } },
    } : undefined,
  })
  ;(globalThis as Record<string, unknown>).fetch = async () => ({
    status: 200,
    json: async () => ({
      ok: true,
      value: {
        entries: [{
          id: 'audit-1', seq: 1, at: Date.now(), sessionId: 's1', turn: 2, step: 1,
          kind: 'signal', channel: 'signal', stage: 'tool_call', trigger: 'memory_tool',
          outcome: 'success', operationId: 'call-9',
        }],
        total: 1,
        stats: { entries: 1, capacity: 2000, perSessionCapacity: 200, dropped: 0, writeErrors: 0, persistence: 'memory' },
      },
    }),
  })
  const AuditTab = testApi.AuditTab
  const element = () => hooks.React.createElement(AuditTab, {
    scopes: [],
    records: [],
    lockSession: 's1',
    audience: 'panel',
    // 关键：主面板不传 openTrajectory，走模块内的 jumpAuditEntryToTrajectory
  })
  let current: RenderNode | null = render(element(), hooks)
  hooks.setRerender(() => { current = render(element(), hooks) })
  try {
    hooks.runEffects()
    for (let i = 0; i < 8; i++) await Promise.resolve()
    const row = collect(current).find((n) => String(n.props?.className ?? '').startsWith('audit-row'))
    assert.ok(row)
    ;(row!.props!.onClick as () => void)()
    hooks.runEffects()
    for (let i = 0; i < 4; i++) await Promise.resolve()
    const jump = collect(current).find((n) => String(n.props?.className ?? '').split(/\s+/).includes('audit-jump'))
    assert.ok(jump)
    await (jump!.props!.onClick as () => Promise<void>)()
    for (let i = 0; i < 4; i++) await Promise.resolve()
    assert.deepEqual(opened, ['s1'], '先打开会话')
    assert.deepEqual(seen, [['trajectory', 'call-9']], '再把 trajectory 切到该 callId')
    assert.ok(textOf(current).includes('已定位到轨迹'))
  } finally {
    ;(testApi.setClientCtx as (v: unknown) => void)(null)
    hooks.resetAll()
  }
})

test('从审计跳到记录页时,带 focus 的记录卡自动展开', async () => {
  const { exports, hooks } = await loadBundle()
  hooks.resetAll()
  const RecordCard = (exports.__test as { RecordCard: (p: Record<string, unknown>) => unknown }).RecordCard
  const rec = makeRecord()
  const element = () => hooks.React.createElement(RecordCard, { rec, focus: true, onSaved: () => {}, onDeleted: () => {} })
  let current: RenderNode | null = render(element(), hooks)
  hooks.setRerender(() => { current = render(element(), hooks) })
  hooks.runEffects()
  for (let i = 0; i < 3; i++) await Promise.resolve()
  const classNames = collect(current).map((n) => String(n.props?.className ?? ''))
  assert.ok(classNames.includes('rec focus'), '目标记录带 focus 高亮')
  assert.ok(classNames.includes('content'), '目标记录自动展开,不需要再点一次')
  hooks.resetAll()
})

test('审计详情能把 operationId 精确送到轨迹视图', async () => {
  const { exports, hooks } = await loadBundle()
  hooks.resetAll()
  const entries = [{
    id: 'audit-1',
    seq: 1,
    at: Date.now(),
    sessionId: 's1',
    turn: 2,
    step: 1,
    kind: 'signal',
    channel: 'signal',
    stage: 'tool_call',
    trigger: 'memory_tool',
    outcome: 'success',
    operationId: 'call-9',
    signal: { key: 'call-9', reason: 'memory_tool', tool: 'memory_search', callId: 'call-9' },
  }]
  ;(globalThis as Record<string, unknown>).fetch = async () => ({
    status: 200,
    json: async () => ({
      ok: true,
      value: {
        entries,
        total: 1,
        stats: { entries: 1, capacity: 2000, perSessionCapacity: 200, dropped: 0, writeErrors: 0, persistence: 'memory' },
      },
    }),
  })
  const AuditTab = (exports.__test as { AuditTab: (p: Record<string, unknown>) => unknown }).AuditTab
  const seen: (string | undefined)[] = []
  const element = () => hooks.React.createElement(AuditTab, {
    scopes: [],
    records: [],
    lockSession: 's1',
    audience: 'view',
    openTrajectory: (focus?: string) => { seen.push(focus) },
  })
  let current: RenderNode | null = render(element(), hooks)
  hooks.setRerender(() => { current = render(element(), hooks) })
  hooks.runEffects()
  for (let i = 0; i < 8; i++) await Promise.resolve()

  const row = collect(current).find((n) => String(n.props?.className ?? '').startsWith('audit-row'))
  assert.ok(row, '审计行存在')
  ;(row!.props!.onClick as () => void)()
  hooks.runEffects()
  for (let i = 0; i < 4; i++) await Promise.resolve()

  const jump = collect(current).find((n) => String(n.props?.className ?? '').split(/\s+/).includes('audit-jump'))
  assert.ok(jump, '详情头部有「在轨迹中定位」')
  await (jump!.props!.onClick as () => Promise<void>)()
  for (let i = 0; i < 4; i++) await Promise.resolve()
  assert.deepEqual(seen, ['call-9'], '把 operationId 原样交给 openView')
  assert.ok(textOf(current).includes('已定位到轨迹'))
  hooks.resetAll()
})

test('面板缩放：提供 A− / A+ / 百分比控件，根节点应用 zoom', async () => {
  const hooks = makeReact()
  const current = await mountPanel(hooks, { scopes: [], embedServer: null })
  const root = collect(current()).find((n) => String(n.props?.className ?? '') === 'memp')
  assert.ok(root, '面板根节点存在')
  assert.equal(Number(root!.props?.style?.zoom), 1, '默认 100%')

  const plus = collect(current()).find((n) => n.tag === 'button' && textOf(n).trim() === 'A+')
  const minus = collect(current()).find((n) => n.tag === 'button' && textOf(n).trim() === 'A−')
  assert.ok(plus && minus, '有放大/缩小按钮（面板可随意缩大缩小）')
  const pct = collect(current()).find((n) => n.tag === 'button' && /^\d+%$/.test(textOf(n).trim()))
  assert.ok(pct, '有当前缩放百分比（点击重置为 100%）')
  assert.equal(textOf(pct!).trim(), '100%')
  hooks.resetAll()
})
