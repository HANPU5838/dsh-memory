/**
 * 随包技能（0.35.0）与审批卡（0.35.1 修复）的回归守卫。
 *
 * 两个真实踩坑：
 *   1. 0.35.0 在 apply 里 `ctx.get('skills')` 一次性取样 —— skills 服务由宿主核心
 *      提供，若晚于本插件 apply 就绪，取到 undefined 且永不重试，技能永久消失。
 *      必须走 `ctx.inject(['skills'], ...)` 等服务就绪后再挂。
 *   2. hook 审批卡若套用普通"写入 / 读取"文案，用户看不懂"这段代码要执行"而误点，
 *      代码还会被压成一行看不清。客户端必须有 hookMode 专属分支。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..', '..')

test('dsh-memory 通过 ctx.inject(["skills"]) 注册随包技能，不在 apply 里直接取样', () => {
  const index = readFileSync(join(root, 'source', 'memory-plugin', 'src', 'index.ts'), 'utf8')
  // 关键：必须有一句 inject(['skills'], ...) 包住 mountBundledSkills。
  assert.match(
    index,
    /ctx\.inject\(\['skills'\][\s\S]{0,240}?mountBundledSkills/,
    '必须在 ctx.inject(["skills"], ...) 回调里调用 mountBundledSkills，否则 skills 服务晚到就永久丢注册',
  )
  // 不能再有 apply 里那句裸调用（part(ctx,'skills',...) 直接传 ctx）。
  assert.doesNotMatch(
    index,
    /part\(ctx,\s*'skills',\s*\(\)\s*=>\s*mountBundledSkills\(ctx/,
    'apply 里直接 mountBundledSkills(ctx) 是冷启动丢注册的写法，必须用 inject 回调里的 scope',
  )
})

test('随包技能 frontmatter 合法、name 与目录名一致、引用了 examples.md', () => {
  const skill = readFileSync(
    join(root, 'source', 'memory-plugin', 'skills', 'memory-hook-scripts', 'SKILL.md'),
    'utf8',
  )
  assert.ok(skill.startsWith('---\n'), 'SKILL.md 必须以 --- 开头（不能有 BOM）')
  assert.match(skill, /^name: memory-hook-scripts$/m)
  assert.match(skill, /^description: .+/m)
  assert.match(skill, /references\/examples\.md/, '正文要引导模型在写脚本前看范例')
  // 前端契约用的是 kebab-case 键，不是被 skill-authoring 拒绝的 camelCase。
  assert.doesNotMatch(skill, /disableModelInvocation|modelInvocable/)
})

test('工具描述引导 Agent 加载 memory-hook-scripts 技能', () => {
  const toolSrc = readFileSync(join(root, 'source', 'tool-memory', 'src', 'index.ts'), 'utf8')
  assert.match(toolSrc, /memory-hook-scripts/, 'memory_hooks / memory_save 的 description 要点名技能名')
  assert.match(toolSrc, /`skill` 工具/, '要告诉 Agent 用 skill 工具加载')
})

test('memory_save 的结果渲染回传钩子登记 / 审批结局', () => {
  const apply = readFileSync(join(root, 'source', 'tool-memory', 'src', 'apply.ts'), 'utf8')
  assert.match(apply, /value\.hook/, 'memory_save 渲染必须读 value.hook，否则 Agent 不知道脚本挂没挂上')
  assert.match(apply, /不会运行/, '未批准 / 拒绝 / 超时都要明确说"不会运行"')
})

test('HOOK_REJECTED 报错自动带关联规则 id 与 memory_get 提示 (0.35.3)', () => {
  const provider = readFileSync(join(root, 'source', 'memory-local', 'src', 'index.ts'), 'utf8')
  assert.match(provider, /veto\.hook\.ruleId/, '拒绝分支必须读钩子的 ruleId')
  assert.match(provider, /关联规则记忆/, '报错要显式列出关联规则 id')
  assert.match(provider, /memory_get/, '要提示用 memory_get 取规则全文')
  const hooks = readFileSync(join(root, 'source', 'memory-local', 'src', 'hooks.ts'), 'utf8')
  assert.match(hooks, /ruleId\?: string/, 'HookOutcome.hook 要带 ruleId 字段')
})

test('memory_hooks run 走 runHookTrial（按 id 精确试跑，绕过审批门禁）', () => {
  const toolSrc = readFileSync(join(root, 'source', 'tool-memory', 'src', 'index.ts'), 'utf8')
  assert.match(toolSrc, /runHookTrial\?\(/, 'MemoryToolService 要声明 runHookTrial')
  assert.match(toolSrc, /service\.runHookTrial\(hook\.id/, 'run 必须按 id 试跑，不再用 phase+scope/kind 过滤')
  const providerSrc = readFileSync(join(root, 'source', 'memory-local', 'src', 'index.ts'), 'utf8')
  assert.match(providerSrc, /runHookTrial\(id: string/, 'provider 要实现 runHookTrial')
})

test('删除钩子有二次确认：工具层 confirm 参数 + 面板 confirm 弹窗 (0.36.1)', () => {
  const toolSrc = readFileSync(join(root, 'source', 'tool-memory', 'src', 'index.ts'), 'utf8')
  assert.match(toolSrc, /confirm\?: string/, 'HooksArgs 要有 confirm 参数')
  assert.match(toolSrc, /requiresConfirmation/, '第一次删除只给预览、不真删')
  assert.match(toolSrc, /confirmation === hook\.name \|\| confirmation === hook\.id/, 'confirm 必须精确匹配 name 或 id')
  const client = readFileSync(join(root, 'source', 'memory-panel', 'lib', 'client.js'), 'utf8')
  assert.match(client, /window\.confirm\(`确定删除钩子/, '面板删除要弹二次确认')
  const skill = readFileSync(join(root, 'source', 'memory-plugin', 'skills', 'memory-hook-scripts', 'SKILL.md'), 'utf8')
  assert.match(skill, /删除钩子要二次确认/, '技能文档要写清删除的两步流程')
})

test('面板规则代码卡片：批准/撤销、默认折叠、筛选、试跑输出可关 (0.38.0)', () => {
  const client = readFileSync(join(root, 'source', 'memory-panel', 'lib', 'client.js'), 'utf8')
  assert.match(client, /action: 'revoke-approval'/, '有撤销批准按钮')
  assert.match(client, /action: 'approve'/, '有批准按钮')
  assert.equal(/hook\.enabled === false \? '启用' : '停用'/.test(client), false, '不能再有启用/停用按钮')
  assert.match(client, /useState\(new Set\(\)\)/, '折叠状态默认空 = 全部折叠')
  assert.match(client, /filterPhase/, '按时机筛选')
  assert.match(client, /filterScope/, '按作用域筛选')
  assert.match(client, /filterApproval/, '按批准状态筛选')
  assert.match(client, /hook-trial-close/, '试跑输出有关闭按钮')
  assert.match(client, /脚本真实输出/, '试跑回显真实输出')
  // provider / API 有撤销批准入口
  const panel = readFileSync(join(root, 'source', 'memory-panel', 'lib', 'index.js'), 'utf8')
  assert.match(panel, /action === 'revoke-approval'/, '面板 API 支持撤销批准')
  const provider = readFileSync(join(root, 'source', 'memory-local', 'src', 'index.ts'), 'utf8')
  assert.match(provider, /revokeHookApproval/, 'provider 实现 revokeHookApproval')
})

test('hook 审批卡有专属文案与代码展示，不套用普通写入审批', () => {
  const client = readFileSync(join(root, 'source', 'memory-panel', 'lib', 'client.js'), 'utf8')
  // 必须具备 hookMode 变量与专属文案。
  assert.match(client, /const hookMode = pending\.mode === 'hook'/)
  assert.match(client, /批准这段代码/, '允许按钮要说"批准这段代码"而不是"允许一次"')
  assert.match(client, /mem-approval-code/, '代码必须用 <pre> 原样展示，不能压成一行')
  assert.match(client, /规则代码运行审批/, 'aria-label 要标识这是代码审批')
  // headline 不能把 hook 说成"写入可见域外的记忆"。
  assert.match(client, /hookMode[\s\S]{0,120}?提交了一段规则代码/)
})
