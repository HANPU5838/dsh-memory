/**
 * 记忆钩子（0.35.0）。
 *
 * 这一组测试盯的是**安全边界**，不是功能好不好用：
 *   - 未批准的代码绝不执行（否则模型随手写一段就能在进程里跑）；
 *   - 改一个字符就要重新批准（否则"批准过一次"等于永久授权）；
 *   - 脚本崩了不能把记忆系统锁死（否则写坏的校验器 = 丢数据）；
 *   - 沙箱真的关住了宿主（require / process / eval / 网络）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService } from '../src/index.ts'
import {
  DEFAULT_HOOK_SETTINGS,
  HookStore,
  hashHookCode,
  hookApplies,
  hookNeedsApproval,
  normalizeHookResult,
  runHookCode,
  runHooks,
} from '../src/hooks.ts'

const dirs: string[] = []

function makeService(config: Record<string, unknown> = {}): LocalMemoryService {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mem-hooks-'))
  dirs.push(dir)
  return new LocalMemoryService({ storeDir: dir, ...config })
}

process.on('exit', () => {
  for (const dir of dirs) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败无所谓 */ }
  }
})

const MEMORY = (content: string, extra: Record<string, unknown> = {}) => ({
  scope: 'global',
  kind: 'rule',
  content,
  tags: [],
  importance: 0.8,
  ...extra,
})

const COLON_CHECK = `function verify(memory) {
  return memory.content.includes('：') ? { ok: true } : { ok: false, message: '缺少全角冒号' }
}`

// ---------------------------------------------------------------- 沙箱

test('沙箱:拿不到 require / process / eval / 网络', () => {
  const probes = [
    'function verify(){ return { ok: typeof require !== "undefined", message: "require" } }',
    'function verify(){ return { ok: typeof process !== "undefined", message: "process" } }',
    'function verify(){ return { ok: typeof fetch !== "undefined", message: "fetch" } }',
    'function verify(){ return { ok: typeof setTimeout !== "undefined", message: "setTimeout" } }',
  ]
  for (const code of probes) {
    const result = runHookCode(code, 'before-save', { memory: MEMORY('x') }, DEFAULT_HOOK_SETTINGS)
    // 拿不到 = 脚本里那个 typeof 是 'undefined'，所以 ok 应当是 false。
    assert.equal(result.ok, false, `${code} 应该拿不到宿主能力`)
  }
})

test('沙箱:eval 与 new Function 被代码生成限制挡住', () => {
  const result = runHookCode(
    'function verify(){ eval("1+1"); return true }',
    'before-save',
    { memory: MEMORY('x') },
    DEFAULT_HOOK_SETTINGS,
  )
  // 脚本抛错 → 折成 error，且 ok:true（不阻断写入）。
  assert.equal(typeof result.error, 'string')
  assert.match(result.error!, /Code generation|eval/i)
  assert.equal(result.ok, true)
})

test('沙箱:死循环被超时中断，且不阻断', () => {
  const result = runHookCode(
    'function verify(){ while (true) {} }',
    'before-save',
    { memory: MEMORY('x') },
    { ...DEFAULT_HOOK_SETTINGS, timeoutMs: 30 },
  )
  assert.equal(typeof result.error, 'string')
  assert.match(result.error!, /超时|timed out/, 'vm 超时在不同阶段暴露的消息不同（加载期 vs 执行期），两种都算中断')
  assert.equal(result.ok, true, '脚本崩了不能被当成"校验不通过"')
})

test('沙箱:模块体里的死循环同样被中断', () => {
  const result = runHookCode(
    'while (true) {}',
    'before-save',
    { memory: MEMORY('x') },
    { ...DEFAULT_HOOK_SETTINGS, timeoutMs: 30 },
  )
  assert.match(result.error ?? '', /无法加载|timed out|超时/)
  assert.equal(result.ok, true)
})

test('沙箱:改了进沙箱的正文不会影响真实记录', () => {
  const memory = MEMORY('原来的正文：不要被改')
  const code = 'function verify(m){ m.content = "被脚本改了"; return { ok: true } }'
  runHookCode(code, 'before-save', { memory }, DEFAULT_HOOK_SETTINGS)
  assert.equal(memory.content, '原来的正文：不要被改')
})

test('沙箱:log() 的内容随结果返回', () => {
  const result = runHookCode(
    'function verify(m){ log("看点", m.content.length); return true }',
    'before-save',
    { memory: MEMORY('abc') },
    DEFAULT_HOOK_SETTINGS,
  )
  assert.deepEqual(result.logs, ['看点 3'])
})

test('沙箱:返回 Promise 被判为错误（钩子必须同步）', () => {
  const result = runHookCode(
    'function verify(){ return Promise.resolve(true) }',
    'before-save',
    { memory: MEMORY('x') },
    DEFAULT_HOOK_SETTINGS,
  )
  assert.match(result.error ?? '', /Promise/)
})

test('沙箱:找不到入口函数时给出可操作的报错', () => {
  const result = runHookCode('const x = 1', 'before-save', { memory: MEMORY('x') }, DEFAULT_HOOK_SETTINGS)
  assert.match(result.error ?? '', /verify\(\)/)
})

// ---------------------------------------------------------------- 返回值

test('normalizeHookResult:各种返回形状', () => {
  assert.deepEqual(normalizeHookResult(undefined), { ok: true })
  assert.deepEqual(normalizeHookResult(true), { ok: true })
  assert.deepEqual(normalizeHookResult(false), { ok: false })
  assert.deepEqual(normalizeHookResult('缺冒号'), { ok: false, message: '缺冒号' })
  assert.deepEqual(normalizeHookResult({ ok: false, message: '不合规' }), { ok: false, message: '不合规' })
  // note 是 message 的别名
  assert.deepEqual(normalizeHookResult({ ok: false, note: '用 note' }), { ok: false, message: '用 note' })
  assert.deepEqual(normalizeHookResult({ reject: true }), { ok: false })
  assert.deepEqual(normalizeHookResult({ content: '改过' }), { ok: true, content: '改过' })
  assert.deepEqual(normalizeHookResult({ drop: true }), { ok: true, drop: true })
  // 乱返回不让写入卡死
  assert.deepEqual(normalizeHookResult(42), { ok: true })
  assert.deepEqual(normalizeHookResult(['x']), { ok: true })
})

// ---------------------------------------------------------------- 匹配 / 审批

test('hookApplies:空数组与 * 都表示全部', () => {
  const base = { scopes: [] as string[], kinds: [] as string[] }
  assert.equal(hookApplies(base, { scope: 'global', kind: 'rule' }), true)
  assert.equal(hookApplies({ scopes: ['*'], kinds: ['*'] }, { scope: 'x', kind: 'fact' }), true)
  assert.equal(hookApplies({ scopes: ['global'], kinds: [] }, { scope: 'global', kind: 'rule' }), true)
  assert.equal(hookApplies({ scopes: ['global'], kinds: [] }, { scope: 'session:1', kind: 'rule' }), false)
  assert.equal(hookApplies({ scopes: [], kinds: ['rule'] }, { scope: 'global', kind: 'fact' }), false)
})

test('hookNeedsApproval:代码指纹变了就要重新批准', () => {
  const code = 'function verify(){ return true }'
  const approved = { code, approvedHash: hashHookCode(code) }
  assert.equal(hookNeedsApproval(approved, DEFAULT_HOOK_SETTINGS), false)
  // 改一个字符
  assert.equal(hookNeedsApproval({ code: `${code} `, approvedHash: hashHookCode(code) }, DEFAULT_HOOK_SETTINGS), true)
  // 从没批准过
  assert.equal(hookNeedsApproval({ code }, DEFAULT_HOOK_SETTINGS), true)
  // 用户关掉审批要求
  assert.equal(hookNeedsApproval({ code }, { ...DEFAULT_HOOK_SETTINGS, requireApproval: false }), false)
})

// ---------------------------------------------------------------- 存储与运行

test('HookStore:落盘在 hooks.json，不进记忆 store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mem-hookstore-'))
  dirs.push(dir)
  const store = new HookStore({ root: dir })
  const hook = store.save({ phase: 'before-save', code: COLON_CHECK, name: '规范' }, DEFAULT_HOOK_SETTINGS)
  assert.equal(hook.id.startsWith('hook-'), true)
  assert.equal(store.list().length, 1)

  const raw = readFileSync(join(dir, 'hooks.json'), 'utf8')
  assert.match(raw, /schemaVersion/)
  assert.match(raw, /function verify/)

  // 重新读盘能读回来
  const reopened = new HookStore({ root: dir })
  assert.equal(reopened.list().length, 1)
  assert.equal(reopened.list()[0]!.code, COLON_CHECK)

  // 删除
  assert.equal(store.delete(hook.id), true)
  assert.equal(store.delete(hook.id), false)
  assert.equal(store.list().length, 0)
})

test('HookStore:坏文件退化成"没有钩子"，不抛错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mem-hookbad-'))
  dirs.push(dir)
  const warnings: string[] = []
  const store = new HookStore({ root: dir, onWarn: (m) => warnings.push(m) })
  // 先写一个坏文件
  writeFileSync(join(dir, 'hooks.json'), '{ not json', 'utf8')
  assert.deepEqual(store.list(), [])
  assert.equal(warnings.length, 1)
})

test('runHooks:before-save 命中否决后不再跑后面的钩子', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mem-hookseq-'))
  dirs.push(dir)
  const store = new HookStore({ root: dir })
  const first = store.save({ phase: 'before-save', code: 'function verify(){ return { ok: false, message: "第一条就拒" } }', name: 'A' }, DEFAULT_HOOK_SETTINGS)
  store.save({ phase: 'before-save', code: 'function verify(){ return { ok: true } }', name: 'B' }, DEFAULT_HOOK_SETTINGS)
  store.approve(first.id, hashHookCode(store.get(first.id)!.code))
  for (const hook of store.list()) if (hook.id !== first.id) store.approve(hook.id, hashHookCode(hook.code))

  const outcomes = runHooks(store, 'before-save', { memory: MEMORY('x') }, DEFAULT_HOOK_SETTINGS)
  assert.equal(outcomes.length, 1, '一旦否决就停，后面的钩子不该再跑')
  assert.equal(outcomes[0]!.ok, false)

  // 统计也记上了
  assert.equal(store.get(first.id)!.rejectCount, 1)
  assert.equal(store.get(first.id)!.lastOutcome, 'rejected')
})

test('runHooks:总开关关掉时一个都不跑', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mem-hookoff-'))
  dirs.push(dir)
  const store = new HookStore({ root: dir })
  const hook = store.save({ phase: 'before-save', code: 'function verify(){ return false }', name: 'A' }, DEFAULT_HOOK_SETTINGS)
  store.approve(hook.id, hashHookCode(hook.code))
  assert.equal(runHooks(store, 'before-save', { memory: MEMORY('x') }, { ...DEFAULT_HOOK_SETTINGS, enabled: false }).length, 0)
})

// ---------------------------------------------------------------- 保存路径

test('保存路径:批准的 before-save 校验能拒绝写入，错误码 HOOK_REJECTED', async () => {
  const service = makeService()
  const hook = service.saveHook({ phase: 'before-save', code: COLON_CHECK, name: '内容规范' })
  service.approveHook(hook.id)

  await assert.rejects(
    () => service.save({ scope: 'global', kind: 'rule', content: '没有冒号的内容' }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, 'HOOK_REJECTED')
      assert.match(error.message, /缺少全角冒号/, '脚本给的 message 必须回给模型')
      return true
    },
  )
  // 合规的照常写入
  const record = await service.save({ scope: 'global', kind: 'rule', content: '内容规范：合规内容' })
  assert.equal(record.kind, 'rule')
})

test('保存路径:拒绝信息自动带上关联规则 id 与 memory_get 取全文提示 (0.35.3)', async () => {
  const service = makeService()
  const ruleId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const hook = service.saveHook({ phase: 'before-save', code: COLON_CHECK, name: '内容规范', ruleId })
  service.approveHook(hook.id)

  await assert.rejects(
    () => service.save({ scope: 'global', kind: 'rule', content: '没有冒号的内容' }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, 'HOOK_REJECTED')
      assert.match(error.message, new RegExp(ruleId), '报错要带关联规则记忆的完整 id')
      assert.match(error.message, /memory_get\("aaaaaaaa"\)/, '要提示用短 id 取规则全文')
      return true
    },
  )

  // 没有关联规则的钩子（手动新建）不应凭空造出 ruleId。
  // 用不同作用域，避免与上面那条带 ruleId 的钩子（会先否决并 break）串味。
  const bareService = makeService()
  const bare = bareService.saveHook({ phase: 'before-save', code: COLON_CHECK, name: '裸钩子' })
  bareService.approveHook(bare.id)
  await assert.rejects(
    () => bareService.save({ scope: 'global', kind: 'rule', content: '没有冒号的内容' }),
    (error: Error) => {
      assert.doesNotMatch(error.message, /关联规则记忆/)
      return true
    },
  )
})

test('保存路径:未批准的钩子不执行，保存也不会被拦', async () => {
  const service = makeService()
  service.saveHook({ phase: 'before-save', code: COLON_CHECK, name: '没批准的' })
  const record = await service.save({ scope: 'global', kind: 'rule', content: '没有冒号也应该能存' })
  assert.equal(record.content, '没有冒号也应该能存')
})

test('保存路径:脚本崩溃不阻断写入（写坏的校验器不能锁死记忆）', async () => {
  const service = makeService()
  const hook = service.saveHook({ phase: 'before-save', code: 'function verify(){ throw new Error("我坏了") }', name: '坏的' })
  service.approveHook(hook.id)
  const record = await service.save({ scope: 'global', kind: 'rule', content: '照样要能存' })
  assert.equal(record.content, '照样要能存')
  // 错误被记到统计里，面板上看得见
  const after = service.listHooks()[0]!
  assert.equal(after.errorCount, 1)
  assert.equal(after.lastOutcome, 'error')
})

test('保存路径:after-save 只观察，不阻断也不改写已落盘的记录', async () => {
  const service = makeService()
  const hook = service.saveHook({
    phase: 'after-save',
    code: 'function observe(memory){ return { content: "被观察者改写了", message: "看到了" } }',
    name: '观察者',
  })
  service.approveHook(hook.id)
  const record = await service.save({ scope: 'global', kind: 'fact', content: '原文' })
  assert.equal(record.content, '原文', 'after-save 不能改写已经落盘的记录')
  const stored = service.getByIds([record.id])
  assert.equal(stored[0]!.content, '原文')
  assert.equal(service.listHooks()[0]!.runCount, 1)
})

test('保存路径:钩子只按 kinds/scopes 命中', async () => {
  const service = makeService()
  const hook = service.saveHook({ phase: 'before-save', code: 'function verify(){ return { ok: false, message: "x" } }', name: '只管 rule', kinds: ['rule'], scopes: ['global'] })
  service.approveHook(hook.id)
  // 其他类型不受影响
  const fact = await service.save({ scope: 'global', kind: 'fact', content: '这是 fact' })
  assert.equal(fact.kind, 'fact')
  // 其他作用域不受影响
  const other = await service.save({ scope: 'project:D:/x', kind: 'rule', content: '别的项目' })
  assert.match(other.scope, /^project:/)
})

// ---------------------------------------------------------------- 注入前解析

test('注入前解析:可以改写正文', () => {
  const service = makeService()
  const hook = service.saveHook({
    phase: 'before-inject',
    code: 'function parse(memory){ return { content: memory.content.replace(/密钥/g, "<已脱敏>") } }',
    name: '脱敏',
  })
  service.approveHook(hook.id)
  const parsed = service.parseForInject([
    { id: 'a', scope: 'global', kind: 'fact', content: '这里有个密钥', tags: [], importance: 1, createdAt: 1, updatedAt: 1, lastAccessedAt: 1, accessCount: 0, source: {} } as never,
  ], 'session-1')
  assert.equal(parsed.records[0]!.content, '这里有个<已脱敏>')
  assert.deepEqual(parsed.changed, [{ id: 'a', hook: '脱敏', option: 'rewritten' }])
})

test('注入前解析:可以丢弃整条', () => {
  const service = makeService()
  const hook = service.saveHook({
    phase: 'before-inject',
    code: 'function parse(memory){ return memory.kind === "state" ? { drop: true } : true }',
    name: '丢状态',
  })
  service.approveHook(hook.id)
  const parsed = service.parseForInject([
    { id: 'a', scope: 'global', kind: 'state', content: '过期状态', tags: [], importance: 1, createdAt: 1, updatedAt: 1, lastAccessedAt: 1, accessCount: 0, source: {} } as never,
    { id: 'b', scope: 'global', kind: 'fact', content: '事实', tags: [], importance: 1, createdAt: 1, updatedAt: 1, lastAccessedAt: 1, accessCount: 0, source: {} } as never,
  ])
  assert.deepEqual(parsed.records.map((record) => record.id), ['b'])
  assert.deepEqual(parsed.changed, [{ id: 'a', hook: '丢状态', option: 'dropped' }])
})

test('注入前解析:脚本能读到 ctx.settings 的摘要字数限制 (0.37.0)', () => {
  const service = makeService()
  // 用 log 把 ctx.settings 带出来验证；同时按 digestChars 截断。
  const hook = service.saveHook({
    phase: 'before-inject',
    code: 'function parse(memory, ctx){ log("LIMIT=" + ctx.settings.digestChars); '
      + 'var limit = ctx.settings.digestChars; return { content: memory.content.slice(0, limit) } }',
    name: '读设置',
  })
  service.approveHook(hook.id)
  const parsed = service.parseForInject([
    { id: 'a', scope: 'global', kind: 'fact', content: 'X'.repeat(200), tags: [], importance: 1, createdAt: 1, updatedAt: 1, lastAccessedAt: 1, accessCount: 0, source: {} } as never,
  ])
  assert.equal(parsed.records[0]!.content.length, 160, '按 ctx.settings.digestChars=160 截断')
})

test('注入前解析:印象字数上限随面板设置变化传给脚本 (0.37.0)', () => {
  const service = makeService()
  service.updateInjectSettings({ impression: { chars: 77 } })
  const hook = service.saveHook({
    phase: 'before-inject',
    code: 'function parse(memory, ctx){ return { content: String(ctx.settings.impressionChars) } }',
    name: '读印象上限',
  })
  service.approveHook(hook.id)
  const parsed = service.parseForInject([
    { id: 'a', scope: 'global', kind: 'fact', content: '随便', tags: [], importance: 1, createdAt: 1, updatedAt: 1, lastAccessedAt: 1, accessCount: 0, source: {} } as never,
  ])
  assert.equal(parsed.records[0]!.content, '77', 'impressionChars 跟随实时设置')
})

test('注入前解析:脚本崩溃时记录原样保留', () => {
  const service = makeService()
  const hook = service.saveHook({ phase: 'before-inject', code: 'function parse(){ throw new Error("坏了") }', name: '坏解析' })
  service.approveHook(hook.id)
  const parsed = service.parseForInject([
    { id: 'a', scope: 'global', kind: 'fact', content: '正文', tags: [], importance: 1, createdAt: 1, updatedAt: 1, lastAccessedAt: 1, accessCount: 0, source: {} } as never,
  ])
  assert.equal(parsed.records[0]!.content, '正文')
  assert.equal(parsed.warnings.length, 1)
})

test('注入前解析:总开关关掉时原样返回', () => {
  const service = makeService({ hooks: { enabled: false } })
  const hook = service.saveHook({ phase: 'before-inject', code: 'function parse(){ return { drop: true } }', name: 'x' })
  service.approveHook(hook.id)
  const records = [{ id: 'a', scope: 'global', kind: 'fact', content: '正文', tags: [], importance: 1, createdAt: 1, updatedAt: 1, lastAccessedAt: 1, accessCount: 0, source: {} } as never]
  const parsed = service.parseForInject(records)
  assert.equal(parsed.records.length, 1)
})

// ---------------------------------------------------------------- 审批通道

test('试跑:未批准也能按 id 精确试跑，且不记统计', () => {
  const service = makeService()
  const hook = service.saveHook({ phase: 'before-save', code: COLON_CHECK, name: '未批准的', kinds: ['rule'] })
  assert.equal(service.hookPendingApproval(hook.id), true, '这条钩子确实未批准')

  // 真实运行会被门禁挡掉
  assert.equal(service.runHooks('before-save', { memory: MEMORY('没有冒号') }).length, 0)
  // 试跑必须能命中 —— 技能里"先 run 试跑再上线"的流程依赖它
  const trial = service.runHookTrial(hook.id, { memory: MEMORY('没有冒号') })
  assert.equal(trial.length, 1)
  assert.equal(trial[0]!.ok, false)
  assert.match(trial[0]!.message ?? '', /缺少全角冒号/)
  // 试跑不记统计（不是真实运行）
  assert.equal(service.listHooks()[0]!.runCount, 0)
})

test('试跑:outcome 带回关联规则 id (0.35.3)', () => {
  const service = makeService()
  const ruleId = '11111111-2222-3333-4444-555555555555'
  const hook = service.saveHook({ phase: 'before-save', code: COLON_CHECK, name: '规范', ruleId })
  const trial = service.runHookTrial(hook.id, { memory: MEMORY('没有冒号') })
  assert.equal(trial[0]!.hook.ruleId, ruleId)
})

test('试跑:不存在的 id 返回空', () => {
  const service = makeService()
  assert.deepEqual(service.runHookTrial('hook-nope', { memory: MEMORY('x') }), [])
})

test('审批:没有审批通道时保守拒绝，代码不生效', async () => {
  const service = makeService()
  const hook = service.saveHook({ phase: 'before-save', code: COLON_CHECK, name: 'x' })
  // 不传 agent：requestOutOfScope 拿不到会话 → unavailable
  const outcome = await service.requestHookApproval(undefined, hook.id)
  assert.equal(outcome, 'unavailable')
  assert.equal(service.hookPendingApproval(hook.id), true)
  // 仍未批准 → 不跑
  assert.equal(service.runHooks('before-save', { memory: MEMORY('没有冒号') }).length, 0)
})

test('审批:关掉 requireApproval 时直接记批准、不弹窗', async () => {
  const service = makeService({ hooks: { requireApproval: false } })
  const hook = service.saveHook({ phase: 'before-save', code: COLON_CHECK, name: 'x' })
  assert.equal(service.hookPendingApproval(hook.id), false)
  assert.equal(service.runHooks('before-save', { memory: MEMORY('没有冒号') })[0]!.ok, false)
})

test('审批:同一份代码不重复打扰，改代码后重新变回待批准', () => {
  const service = makeService()
  const hook = service.saveHook({ phase: 'before-save', code: COLON_CHECK, name: 'x' })
  assert.equal(service.hookPendingApproval(hook.id), true)
  service.approveHook(hook.id)
  assert.equal(service.hookPendingApproval(hook.id), false)
  // 原样再存一次（比如只改名字）不改指纹
  service.saveHook({ id: hook.id, phase: 'before-save', code: COLON_CHECK, name: '改了名字' })
  assert.equal(service.hookPendingApproval(hook.id), false)
  // 改代码 → 重新待批准
  service.saveHook({ id: hook.id, phase: 'before-save', code: `${COLON_CHECK}\n// 加个注释`, name: '改了名字' })
  assert.equal(service.hookPendingApproval(hook.id), true)
  // 统计清零（换了校验器，旧统计没有意义）
  assert.equal(service.listHooks()[0]!.runCount, 0)
})

// ---------------------------------------------------------------- 设置

test('设置:超时与代码长度被夹在安全区间', () => {
  const service = makeService({ hooks: { timeoutMs: 999_999, maxCodeChars: 5 } })
  const settings = service.hookSettings()
  assert.equal(settings.timeoutMs, 5000)
  assert.equal(settings.maxCodeChars, 500)
  assert.equal(settings.enabled, true, '默认开启')
  assert.equal(settings.requireApproval, true, '默认要求批准')
})

test('设置:落盘到 settings.json 的 hooks 小节，重启后仍生效', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mem-hooksettings-'))
  dirs.push(dir)
  const first = new LocalMemoryService({ storeDir: dir })
  first.updateHookSettings({ requireApproval: false, timeoutMs: 200 })
  const raw = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as { hooks?: { requireApproval?: boolean; timeoutMs?: number } }
  assert.equal(raw.hooks?.requireApproval, false)
  assert.equal(raw.hooks?.timeoutMs, 200)

  const second = new LocalMemoryService({ storeDir: dir })
  assert.equal(second.hookSettings().requireApproval, false)
  assert.equal(second.hookSettings().timeoutMs, 200)
})

test('审批:撤销批准把代码变回待批准，不再运行；代码保留 (0.38.0)', () => {
  const service = makeService()
  const hook = service.saveHook({ phase: 'before-save', code: 'function verify(){ return {ok:true} }', name: 'x' })
  service.approveHook(hook.id)
  assert.equal(service.hookPendingApproval(hook.id), false)
  assert.equal(service.revokeHookApproval(hook.id), true)
  assert.equal(service.hookPendingApproval(hook.id), true, '撤销后变回待批准')
  assert.equal(service.getHook(hook.id)!.code, hook.code, '代码保留')
  // 未批准 → forRun 不命中（runHooks 会因待批准跳过它）
  const hooks = service.runHooks('before-save', { memory: { scope: 'global', kind: 'fact', content: 'x', tags: [], importance: 1 } })
  assert.equal(hooks.length, 0, '撤销后不再运行')
  assert.equal(service.revokeHookApproval(hook.id), false, '重复撤销返回 false')
})

test('试跑:outcome 带回脚本真实输出 raw (0.38.0)', () => {
  const service = makeService()
  const hook = service.saveHook({
    phase: 'before-inject',
    code: 'function parse(){ log("hi"); return { content: "改写", extra: 42 } }',
    name: 'raw',
  })
  const outcomes = service.runHookTrial(hook.id, { memory: { scope: 'global', kind: 'fact', content: 'x', tags: [], importance: 1 }, tool: 'memory_hooks' })
  assert.deepEqual(outcomes[0]!.raw, { content: '改写', extra: 42 }, 'raw 是脚本返回的完整对象')
})

test('设置:代码超过上限时拒绝保存', () => {
  const service = makeService({ hooks: { maxCodeChars: 500 } })
  assert.throws(
    () => service.saveHook({ phase: 'before-save', code: `function verify(){}\n${'//'.padEnd(600, 'x')}`, name: 'x' }),
    /字符上限/,
  )
})
