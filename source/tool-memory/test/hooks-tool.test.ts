/**
 * memory_hooks 工具与 memory_save.hookCode 的行为测试。
 *
 * 用最小 service stub 驱动工具 spec 的 execute —— 关注工具层自己的职责：
 * 参数校验、审批结局回给模型、unsupported 的诚实报错、hookCode 登记。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memorySaveTool, memoryHooksTool, memoryTools, type MemoryToolService } from '../src/index.ts'

const record = (content: string, id = 'rec-1') => ({
  id,
  scope: 'global',
  kind: 'rule',
  content,
  tags: [] as string[],
  importance: 1,
  updatedAt: Date.now(),
})

const CODE = 'function verify(memory){ return memory.content.includes("：") ? {ok:true} : {ok:false,message:"缺冒号"} }'

function stubHooks(overrides: Partial<MemoryToolService> = {}): MemoryToolService {
  const hooks = new Map<string, Record<string, unknown>>()
  let seq = 0
  const approvals: string[] = []

  const base: MemoryToolService = {
    async save(input) { return record(String((input as { content?: string }).content ?? ''), 'rec-1') },
    async search() { return [] },
    async forget() { return { removed: 0, ids: [] } },
    async list() { return [] },
    listHooks() { return [...hooks.values()] as never },
    getHook(id) { return hooks.get(id) as never },
    saveHook(input) {
      const id = typeof (input as { id?: string }).id === 'string' && (input as { id?: string }).id !== ''
        ? (input as { id: string }).id
        : `hook-${++seq}`
      const previous = hooks.get(id)
      const hook = {
        id,
        name: (input as { name?: string }).name ?? (previous?.name as string) ?? 'x',
        phase: (input as { phase?: string }).phase ?? (previous?.phase as string) ?? 'before-save',
        code: (input as { code?: string }).code ?? (previous?.code as string) ?? '',
        enabled: (input as { enabled?: boolean }).enabled ?? true,
        scopes: (input as { scopes?: string[] }).scopes ?? [],
        kinds: (input as { kinds?: string[] }).kinds ?? [],
        ruleId: (input as { ruleId?: string }).ruleId ?? (previous?.ruleId as string | undefined),
        createdBy: 'agent',
        createdAt: (previous?.createdAt as number) ?? Date.now(),
        updatedAt: Date.now(),
        runCount: 0,
        errorCount: 0,
        rejectCount: 0,
      }
      hooks.set(hook.id, hook)
      return hook as never
    },
    deleteHook(id) { return hooks.delete(id) },
    approveHook(id) { approvals.push(id); return hooks.has(id) },
    revokeHookApproval(id) { const h = hooks.get(id) as { approvedHash?: string } | undefined; if (!h || h.approvedHash === undefined) return false; delete h.approvedHash; return true },
    hookPendingApproval() { return false },
    async requestHookApproval(_agent, id) { approvals.push(id); return 'approved' },
    runHookTrial(id, input) {
      const hook = hooks.get(id)
      if (hook === undefined) return []
      return [{
        hook: {
          id: hook.id,
          name: hook.name,
          phase: hook.phase,
          ...(hook.ruleId !== undefined ? { ruleId: hook.ruleId as string } : {}),
        },
        ok: !String((input as { memory: { content?: string } }).memory.content ?? '').includes('缺'),
        durationMs: 1,
      } as never]
    },
    runHooks(phase, input) {
      const target = (input as { memory: { scope: string; kind: string } }).memory
      const out: never[] = []
      for (const hook of hooks.values()) {
        if (hook.phase !== phase) continue
        if (Array.isArray(hook.scopes) && hook.scopes.length > 0 && !hook.scopes.includes(target.scope)) continue
        out.push({
          hook: { id: hook.id, name: hook.name, phase },
          ok: !String((input as { memory: { content?: string } }).memory.content ?? '').includes('缺'),
          durationMs: 1,
        } as never)
      }
      return out
    },
    hookSettings() { return { enabled: true, timeoutMs: 120, requireApproval: true, maxCodeChars: 16000 } },
    ...overrides,
  }
  return base
}

const getService = (s: MemoryToolService) => () => s
const exec = {} // none 限制下不要求 description

// ---------------------------------------------------------------- memory_save + hookCode

test('memory_save 带 hookCode:登记脚本并回传审批结局', async () => {
  const service = stubHooks()
  const tool = memorySaveTool({ getService: getService(service) })
  const result = await tool.execute({
    content: '记忆内容规范：正文',
    kind: 'rule',
    hookCode: CODE,
    hookPhase: 'before-save',
    hookName: '内容规范',
  }, exec)
  assert.equal(result.id, 'rec-1')
  assert.ok(result.hook, '结果里要带钩子信息')
  assert.equal(result.hook!.name, '内容规范')
  assert.equal(result.hook!.phase, 'before-save')
  assert.equal(result.hook!.approval, 'approved')
  // 钩子确实登记了，且没进记忆正文
  const hooks = service.listHooks!()
  assert.equal(hooks.length, 1)
  assert.equal(hooks[0]!.code, CODE)
  assert.equal(hooks[0]!.ruleId, 'rec-1')
})

test('memory_save:旧 provider 不支持钩子时保存照常成功，只标注 unsupported', async () => {
  const service = stubHooks({ saveHook: undefined, requestHookApproval: undefined })
  const tool = memorySaveTool({ getService: getService(service) })
  const result = await tool.execute({ content: '正文：内容', kind: 'rule', hookCode: CODE }, exec)
  assert.equal(result.id, 'rec-1')
  assert.equal(result.hook!.approval, 'unsupported')
})

test('memory_save:审批被拒时如实回给模型，不谎报成功', async () => {
  const service = stubHooks({ async requestHookApproval() { return 'rejected' } })
  const tool = memorySaveTool({ getService: getService(service) })
  const result = await tool.execute({ content: '正文：内容', kind: 'rule', hookCode: CODE }, exec)
  assert.equal(result.hook!.approval, 'rejected')
})

// ---------------------------------------------------------------- memory_hooks

test('memory_hooks.list:先加载技能引导写进了 description', () => {
  const tool = memoryHooksTool({ getService: getService(stubHooks()) })
  assert.match(tool.description, /memory-hook-scripts/)
  assert.match(tool.parameters.action.enum.join(), /save/)
})

test('memory_hooks.save:代码必填，缺了给明确错误', async () => {
  const tool = memoryHooksTool({ getService: getService(stubHooks()) })
  await assert.rejects(
    () => tool.execute({ action: 'save', code: '  ' }, exec),
    (error: Error & { code?: string }) => error.code === 'HOOK_CODE_REQUIRED',
  )
})

test('memory_hooks.save:新建后回传审批结局', async () => {
  const tool = memoryHooksTool({ getService: getService(stubHooks()) })
  const result = await tool.execute({
    action: 'save', code: CODE, name: '内容规范', phase: 'before-save',
  }, exec)
  assert.equal(result.hooks.length, 1)
  assert.match(result.note ?? '', /用户已批准/)
  assert.equal(result.hooks[0]!.phase, 'before-save')
})

test('memory_hooks.save:不传 ruleId 建通用钩子（不挂任何记忆）', async () => {
  const tool = memoryHooksTool({ getService: getService(stubHooks()) })
  const result = await tool.execute({
    action: 'save', code: CODE, name: '通用格式校验', phase: 'before-save',
    scopes: [], kinds: [],
  }, exec)
  assert.equal(result.hooks.length, 1)
  assert.equal(result.hooks[0]!.ruleId, undefined, '通用钩子没有 ruleId')
  assert.deepEqual(result.hooks[0]!.scopes, [], '空 scopes = 全部作用域')
})

test('memory_hooks.save:显式 ruleId 关联到规则记忆', async () => {
  const tool = memoryHooksTool({ getService: getService(stubHooks()) })
  const result = await tool.execute({
    action: 'save', code: CODE, name: '规则专属', ruleId: 'abcd1234-0000-0000-0000-000000000000',
  }, exec)
  assert.equal(result.hooks[0]!.ruleId, 'abcd1234-0000-0000-0000-000000000000')
})

test('memory_hooks.get:按 id 或唯一前缀取到代码', async () => {
  const service = stubHooks()
  service.saveHook!({ code: CODE, name: '内容规范', phase: 'before-save' })
  const tool = memoryHooksTool({ getService: getService(service) })
  const full = await tool.execute({ action: 'get', id: 'hook-1' }, exec)
  assert.equal(full.hooks[0]!.code, CODE)
})

test('memory_hooks.revoke-approval:撤销批准（代码保留、变回待批准），enable/disable 为其旧别名 (0.38.0)', async () => {
  const service = stubHooks()
  // stub 的 saveHook 不写 approvedHash；手动置一个表示"已批准"。
  const saved = service.saveHook!({ code: CODE, name: 'x', phase: 'before-save' }) as { id: string; approvedHash?: string }
  saved.approvedHash = 'approved-hash'
  const tool = memoryHooksTool({ getService: getService(service) })

  const result = await tool.execute({ action: 'revoke-approval', id: saved.id }, exec)
  assert.match(result.note ?? '', /撤销批准|不会运行/)
  assert.equal((service.getHook!(saved.id) as { approvedHash?: string }).approvedHash, undefined, '指纹被清掉 = 待批准')

  // disable 是旧别名，同样撤销批准
  saved.approvedHash = 'approved-hash'
  const legacy = await tool.execute({ action: 'disable', id: saved.id }, exec)
  assert.match(legacy.note ?? '', /撤销批准/)
  assert.equal((service.getHook!(saved.id) as { approvedHash?: string }).approvedHash, undefined)
})

test('memory_hooks.delete:二次确认——第一次只给预览不删，confirm 匹配才真删', async () => {
  const service = stubHooks()
  const saved = service.saveHook!({ code: CODE, name: 'x', phase: 'before-save' })
  const tool = memoryHooksTool({ getService: getService(service) })

  // 第一次：不带 confirm → 只给待删预览，钩子还在
  const preview = await tool.execute({ action: 'delete', id: saved.id }, exec)
  assert.equal(preview.requiresConfirmation, true)
  assert.equal(preview.removed, 0)
  assert.equal(preview.hooks.length, 1, '预览里钩子仍在')
  assert.match(preview.note ?? '', /不可逆|confirm/)
  assert.ok(service.getHook!(saved.id), '第一次调用绝不删除')

  // confirm 写错 → 仍是预览，不删
  const wrong = await tool.execute({ action: 'delete', id: saved.id, confirm: 'not-the-name' }, exec)
  assert.equal(wrong.requiresConfirmation, true)
  assert.equal(wrong.removed, 0)
  assert.ok(service.getHook!(saved.id), 'confirm 不符不删除')

  // confirm 等于 name → 真删
  const done = await tool.execute({ action: 'delete', id: saved.id, confirm: 'x' }, exec)
  assert.equal(done.requiresConfirmation, undefined)
  assert.equal(done.removed, 1)
  assert.equal(done.hooks.length, 0)
  assert.equal(service.getHook!(saved.id), undefined, '确认后钩子真的被删')
})

test('memory_hooks.run:返回脚本判定与 message', async () => {
  const service = stubHooks()
  const saved = service.saveHook!({ code: CODE, name: 'x', phase: 'before-save', scopes: ['global'] })
  const tool = memoryHooksTool({ getService: getService(service) })
  const result = await tool.execute({ action: 'run', id: saved.id, content: '缺冒号' }, exec)
  assert.equal(result.outcomes![0]!.ok, false)
  assert.match(result.note ?? '', /不通过/)
})

test('memory_hooks:provider 不支持时给升级提示，不静默失败', async () => {
  const service = stubHooks({ listHooks: undefined })
  const tool = memoryHooksTool({ getService: getService(service) })
  await assert.rejects(
    () => tool.execute({ action: 'list' }, exec),
    (error: Error & { code?: string }) => error.code === 'HOOKS_UNSUPPORTED',
  )
})

test('memoryTools:七个工具都在，含 memory_hooks', () => {
  const names = Object.keys(memoryTools({ getService: () => undefined })).sort()
  assert.deepEqual(names, [
    'memory_block', 'memory_core', 'memory_forget', 'memory_get', 'memory_hooks',
    'memory_list', 'memory_maintain', 'memory_save', 'memory_scopes', 'memory_search',
  ])
})
