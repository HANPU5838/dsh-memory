/**
 * 工具结果的纯文本渲染。刻意不 import cordis / defineTool：apply.ts 只负责把
 * scope 键翻译成人看的标签，其余格式都在这里，单测可以直接断言模型看到的文字。
 *
 * 0.16.0 起 memory_search 只给“印象”（id / 作用域 / 类型 / 标签 / 短摘要），
 * 正文走 memory_get；memory_get 的 fields 决定渲染哪些元数据。
 *
 * 0.20.0：范围外命中被挡住时，把**真实原因**（用户拒绝 / 审批超时 / 无法审批）
 * 写进渲染文本。
 * 0.23.0：绝对限制与「不可读」开关也会被说明（不再假装"不存在"），并提示怎么调整。
 * 0.27.0：普通限制下范围外命中不再自动弹审批 —— 检索结果带 outOfScope 清单
 * （作用域聚合），审批改为 Agent 显式发起。
 * 0.28.0：范围外清单只给作用域（名字 / 条数 / 用途），**不再给条目摘要**；清单与
 * withheld 说明不再重复讲同一件事（「索引已列在下方」那句直接去掉）。
 */
import type { BlockResult, GetResult, GetField, HookRecordView, HooksResult, ListResult, MemoryBlockView, ScopesResult, ScopesToolResult, SearchResult, WithheldReason } from './index.ts'
import { scopeDisplayName } from '../../memory-local/src/scope.ts'

/** 把 scope 键渲染成展示文案（宿主能查到会话标题时用它，否则用短 id）。 */
export type ScopeLabel = (scope: string) => string

/** 有内容没返回时的原因。 */
export type WithheldInfo = { count: number; reason: WithheldReason }

/**
 * 上下文去重的提示语(0.21.0)。memory_search / memory_list 里已经出现过的条目
 * 只回 id、不再回摘要/正文；这条提示告诉模型为什么少了东西、以及怎么取全文。
 */
export const DEDUPE_NOTE = '本次请求部分记忆摘要因上下文去重机制被省略，若要获取完整内容请使用 memory_get'

export const shortId = (id: string): string => id.slice(0, 8)

const day = (value: unknown): string =>
  typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString().slice(0, 10) : ''

const joinList = (value: unknown): string =>
  Array.isArray(value) ? value.map(String).filter((v) => v !== '').join(', ') : ''

/**
 * 范围外内容为什么没返回——给模型看的真实原因。
 * 空字符串 = 没有需要说明的（没有 withheld）。
 */
export function renderWithheldNote(withheld: WithheldInfo | undefined): string {
  if (withheld === undefined || withheld.count <= 0) return ''
  const count = withheld.count
  switch (withheld.reason) {
    case 'out-of-scope':
      return `另有 ${count} 条记忆在本会话的可见域外（限制等级：普通限制），本次没有弹审批。要看正文需要显式发起：用 memory_search 带 requestApproval=true 重发同一次搜索（会弹审批），或用 memory_scopes(action="request") 申请该作用域的会话权限。`
    case 'rejected':
      return `另有 ${count} 条记忆在本会话的可见域外，用户拒绝了本次访问（限制等级：普通限制），未返回。如确实需要，请让用户调整「记忆范围」后重试。`
    case 'timeout':
      return `另有 ${count} 条记忆在本会话的可见域外，审批在 5 分钟内没有得到答复，已按拒绝处理，未返回。如确实需要，请让用户调整「记忆范围」后重试。`
    case 'unavailable':
      return `另有 ${count} 条记忆在本会话的可见域外，当前环境无法发起审批，未返回。`
    case 'partial':
      return `另有 ${count} 条记忆在本会话的可见域外，用户在本次审批中只允许了其余条目（限制等级：普通限制），未返回。如确实需要，请让用户调整「记忆范围」后重试。`
    case 'absolute':
      return `另有 ${count} 条记忆在本会话的可见域外，当前限制等级为「绝对限制」，不会发起审批，未返回。如确实是本次任务需要的内容，请让用户调整「记忆范围」后重试。`
    case 'read-disabled':
      return `另有 ${count} 条记忆所在的作用域在本会话记忆范围里被标记为「不可读」（可读/可写按钮），未返回。如确实需要，请让用户打开该作用域的「可读」状态后重试。`
    case 'scope-disabled':
      return `另有 ${count} 条记忆所在的作用域已被配置关闭（global / project / session / custom 开关），未返回。如确实需要，请让用户打开对应类型的作用域。`
    case 'blocked':
      return `另有 ${count} 条记忆被你主动屏蔽了（会话级或工作区级），未返回。要恢复请用 memory_block({action:"unblock", ...}) 解除，或用 memory_block({action:"list"}) 看当前清单。`
    default:
      return ''
  }
}

/**
 * 范围外清单的尾部说明(0.27.0 / 0.28.0)。告诉模型这块**只有作用域**，不含任何
 * 记忆内容；真要读时该走哪条路。
 */
export const OUT_OF_SCOPE_INDEX_NOTE =
  '以上只列了作用域，不含任何记忆内容。需要正文时：用 memory_search 带 requestApproval=true 重新发起同一次搜索（会弹审批），或用 memory_scopes(action="request") 申请该作用域的本会话权限。'

/**
 * 范围外清单：每个作用域一行「名称（条数 · 可申请性）：用途」。
 * 刻意与可见域内的结果分开排版，并且**不出现任何条目 id / 摘要** ——
 * 范围外的内容不该有机会被当成「已经读到的记忆」引用。
 */
function renderOutOfScopeIndex(
  outOfScope: NonNullable<SearchResult['outOfScope']>,
  label: ScopeLabel,
): string {
  const total = outOfScope.scopes.reduce((sum, entry) => sum + entry.records, 0)
  const lines = outOfScope.scopes.map((entry) => {
    const text = typeof entry.description === 'string' ? entry.description.trim() : ''
    const description = text === '' ? '（未填写用途）' : text
    const meta = [`${entry.records} 条`]
    if (entry.requestable === false) meta.push('不可申请')
    return `- ${label(entry.scope)}（${meta.join(' · ')}）：${description}`
  })
  const head = `范围外命中（只列作用域与用途，不含条目内容）：${outOfScope.scopes.length} 个作用域 / ${total} 条`
  return [head, ...lines, '', OUT_OF_SCOPE_INDEX_NOTE].join('\n')
}

/** 「[得分] id (作用域/类型 · 标签) 摘要」；没有任何一条命中时给明确空结果。 */
export function renderSearchResult(value: SearchResult, label: ScopeLabel): string {
  const index = value.outOfScope !== undefined && value.outOfScope.scopes.length > 0
    ? renderOutOfScopeIndex(value.outOfScope, label)
    : ''
  // 0.28.0：清单自己已经把「几条 / 为什么没返回 / 怎么取」讲清楚了，
  // 再叠一段 'out-of-scope' 的 withheld 说明就是同一件事说两遍（而且旧文案还
  // 写着「索引已列在下方」，实际排在最后 —— 结构更乱）。有清单时不重复。
  const note = index !== '' && value.withheld?.reason === 'out-of-scope'
    ? ''
    : renderWithheldNote(value.withheld)
  if (value.records.length === 0) {
    if (note === '' && index === '') return '没有找到相关记忆。'
    return [`没有找到可见范围内的相关记忆。`, index, note].filter((part) => part !== '').join('\n\n')
  }
  // 已出现过的条目(上下文去重)只回 id：不带作用域/类型/标签/摘要。
  // 它们单独成块、与带摘要的条目之间空一行 —— 否则一串裸 id 看起来像上一条的
  // 续行,模型分不清哪些条目「这次有摘要」哪些「只是占位 id」(0.22.0)。
  const shown: string[] = []
  const bare: string[] = []
  for (const hit of value.records) {
    if (hit.deduped === true) {
      bare.push(shortId(hit.id))
      continue
    }
    const tags = joinList(hit.tags)
    const meta = `${label(hit.scope)}/${hit.kind}${tags === '' ? '' : ` · ${tags}`}`
    shown.push(`[${hit.score.toFixed(3)}] ${shortId(hit.id)} (${meta}) ${hit.summary}`)
  }
  const body = [shown.join('\n'), bare.join('\n')].filter((part) => part !== '').join('\n\n')
  const tail = [bare.length > 0 ? DEDUPE_NOTE : '', index, note].filter((part) => part !== '').join('\n\n')
  return tail === '' ? body : `${body}\n\n${tail}`
}

/**
 * memory_list 的渲染：每条「(作用域/类型) 正文」；上下文去重过的条目只给 id。
 * `scopeStats` 的尾部摘要由 apply.ts 追加（那里能查会话标题）。
 */
export function renderListResult(value: ListResult, label: ScopeLabel): string {
  let omitted = 0
  const body = value.records.length === 0
    ? '该作用域还没有记忆。'
    : value.records.map((record) => {
      if (record.deduped === true) {
        omitted += 1
        return shortId(record.id)
      }
      const full = record.fullTime
      const timeLine = full === undefined
        ? ''
        : ` [创建 ${full.createdAt} · 更新 ${full.updatedAt}${full.expiresAt !== undefined ? ` · 过期 ${full.expiresAt}` : ''}]`
      return `(${label(record.scope)}/${record.kind})${timeLine} ${record.content}`
    }).join('\n')
  const note = renderWithheldNote(value.withheld)
  const tail = [omitted > 0 ? DEDUPE_NOTE : '', note].filter((part) => part !== '').join('\n\n')
  return tail === '' ? body : `${body}\n\n${tail}`
}

/**
 * memory_scopes 的渲染：list 只讲“有什么、干什么、能不能碰”；request 讲每个
 * scope + 权限的申请结局；edit（0.29.0）讲这次改了描述 / 别名的什么。
 * 三者共用同一个工具入口，但文案完全分开。
 */
export function renderScopesResult(value: ScopesToolResult, label: ScopeLabel): string {
  if ('results' in value) {
    if (value.results.length === 0) return '没有需要申请的作用域权限。'
    const statusText = (status: string): string => {
      switch (status) {
        case 'granted': return '已授予（本会话）'
        case 'already-allowed': return '本来就允许'
        case 'already-granted': return '已有本会话授权'
        case 'not-requestable': return '不可申请'
        case 'unavailable': return '作用域不可用'
        case 'denied': return '用户拒绝'
        case 'timeout': return '审批超时'
        case 'approval-unavailable': return '当前环境无法审批'
        default: return status
      }
    }
    const reasonText = (reason: string | undefined): string => {
      switch (reason) {
        case 'ABSOLUTE_ISOLATION': return '（绝对限制）'
        case 'SCOPE_DISABLED': return '（作用域已关闭）'
        case 'READ_DISABLED': return '（用户已关闭可读）'
        case 'WRITE_DISABLED': return '（用户已关闭可写）'
        default: return ''
      }
    }
    const body = value.results.map((item) =>
      `- ${label(item.scope)}：${item.permission === 'read' ? '只读' : '写入 / 删除'} → ${statusText(item.status)}${reasonText(item.reason)}`,
    ).join('\n')
    return `作用域权限申请结果：\n${body}`
  }
  // edit（0.29.0）：只回「改成了什么」。没动过的字段不出现，空串表示清空 / 移除。
  if ('scope' in value) {
    const name = value.name !== undefined && value.name !== '' ? scopeDisplayName(value.scope, value.name) : label(value.scope)
    const lines = [`作用域已更新：${name}（${value.scope}）`]
    if (value.description !== undefined) {
      lines.push(value.description === ''
        ? '- 用途：已清空（回退到按类型的默认描述）'
        : `- 用途：${value.description}`)
    }
    if (value.name !== undefined) {
      lines.push(value.name === '' ? '- 别名：已移除（显示名回退到作用域键）' : `- 别名：${value.name}`)
    }
    return lines.join('\n')
  }
  if (value.scopes.length === 0) return '当前没有可列出的作用域。'
  const body = value.scopes.map((item) => {
    // 别名(项目 / 自定义作用域)也带类型前缀:自定义作用域的键本身没有前缀,
    // 直接吐裸名字会和 global / project 混在一起分不清种类。
    const name = item.name !== undefined && item.name !== '' ? scopeDisplayName(item.scope, item.name) : label(item.scope)
    const description = item.description !== undefined && item.description.trim() !== ''
      ? item.description.trim()
      : '（未填写用途）'
    const meta: string[] = []
    if (item.records !== undefined) meta.push(`${item.records} 条`)
    if (item.archived === true) {
      // 0.30.0：归档不是权限拒绝，而是会话生命周期 —— 数据仍在，恢复会话即复原。
      meta.push(item.archivedKind === 'project'
        ? '已归档 · 面板里解除归档即恢复'
        : '已归档 · 恢复会话后自动恢复读写')
    } else if (item.blocked === true) {
      // 0.32.0：屏蔽不是权限拒绝，是 Agent 主动降噪 —— 数据仍在，解除后立刻复原。
      meta.push(`已屏蔽（${item.blockedLevel === 'workspace' ? '工作区级' : '会话级'}）· 解除后立刻复原`)
    } else if (item.inScope) {
      meta.push(item.accessStatus === 'default'
        ? '范围内'
        : item.accessStatus === 'read-only'
          ? '范围内 · 只读'
          : item.accessStatus === 'read-write'
            ? '范围内 · 读写'
            : '范围内 · 受限')
    } else if (item.readable || item.writable) {
      meta.push(`范围外 · 已授权${item.readable && item.writable ? '读写' : item.readable ? '只读' : '可写'}`)
    } else {
      const canRead = item.canRequestRead
      const canWrite = item.canRequestWrite
      meta.push(canRead || canWrite
        ? `范围外 · 可申请${canRead ? '只读' : ''}${canWrite ? (canRead ? '/读写' : '读写') : ''}`
        : '范围外 · 不可申请')
    }
    const initial = Array.isArray(item.initialRecords) && item.initialRecords.length > 0
      ? `\n  初始记录：${item.initialRecords.map((record) => `[${record.kind}] ${record.content}`).join(' / ')}`
      : ''
    return `- ${name}（${item.scope}）：${description}（${meta.join(' · ')}）${initial}`
  }).join('\n')
  const tail = value.omitted > 0 ? `\n…另有 ${value.omitted} 个作用域未列出，可调整 limit。` : ''
  return `作用域目录（共 ${value.total} 个）：\n${body}${tail}`
}

/**
 * memory_get 的渲染：
 *   - 元数据按 fields 拼在首行括号里；
 *   - content 优先于 summary（两者都给时正文已经足够）；
 *   - 只取元数据时不输出正文行。
 */
export function renderGetResult(value: GetResult, label: ScopeLabel): string {
  const fields = new Set<GetField>(value.fields)
  const body = value.records.map((record) => {
    const meta: string[] = []
    const scope = typeof record.scope === 'string' ? record.scope : ''
    const kind = typeof record.kind === 'string' ? record.kind : ''
    if (fields.has('scope') && fields.has('kind')) meta.push(`${label(scope)}/${kind}`)
    else if (fields.has('scope')) meta.push(label(scope))
    else if (fields.has('kind')) meta.push(kind)
    if (fields.has('tags')) {
      const tags = joinList(record.tags)
      if (tags !== '') meta.push(`标签 ${tags}`)
    }
    if (fields.has('importance') && typeof record.importance === 'number') meta.push(`重要度 ${record.importance}`)
    if (fields.has('createdAt')) {
      const created = day(record.createdAt)
      if (created !== '') meta.push(`创建 ${created}`)
    }
    if (fields.has('updatedAt')) {
      const updated = day(record.updatedAt)
      if (updated !== '') meta.push(`更新 ${updated}`)
    }
    if (fields.has('expiresAt')) {
      const expires = day(record.expiresAt)
      if (expires !== '') meta.push(`过期 ${expires}`)
    }
    if (fields.has('triggers')) {
      const triggers = joinList(record.triggers)
      if (triggers !== '') meta.push(`触发词 ${triggers}`)
    }
    if (fields.has('supersedes') && typeof record.supersedes === 'string' && record.supersedes !== '') {
      meta.push(`修正 ${shortId(record.supersedes)}`)
    }
    if (fields.has('initial') && record.initial === true) meta.push('初始记录')
    const head = `[${record.id}]${meta.length > 0 ? ` (${meta.join(' · ')})` : ''}`
    const content = typeof record.content === 'string' ? record.content : undefined
    const summary = typeof record.summary === 'string' ? record.summary : undefined
    const text = content ?? (summary === undefined ? '' : `摘要：${summary}`)
    return text === '' ? head : `${head}\n${text}`
  }).join('\n\n')
  const missing = value.missing.length > 0 ? `未找到：${value.missing.join(', ')}` : ''
  // 被可见域挡住的那几条:把真实原因(拒绝 / 超时 / 绝对限制 / 不可读)告诉模型。
  const note = renderWithheldNote(value.withheld)
  const tail = [missing, note].filter((part) => part !== '').join('\n\n')
  if (body === '') return tail === '' ? '没有找到记忆。' : tail
  return tail === '' ? body : `${body}\n\n${tail}`
}

/**
 * memory_block 的渲染（0.32.0）。让模型一眼看清：屏蔽生效在哪个层级、影响什么、
 * 怎么解除 —— 屏蔽是 Agent 自己做的降噪动作，它必须知道这是可逆的。
 */
export function renderBlockResult(value: BlockResult, label: ScopeLabel): string {
  const levelText = (level: string): string => level === 'workspace' ? '工作区级（影响该工作区所有会话）' : '会话级（只影响本会话）'
  const describe = (block: MemoryBlockView): string => {
    const target = block.scope !== undefined
      ? label(block.scope)
      : block.recordId !== undefined
        ? `记录 ${shortId(block.recordId)}${block.recordKind !== undefined ? `（${block.recordKind}）` : ''}`
        : `前缀 ${block.prefix ?? '?'}`
    return `- ${target} · ${levelText(block.level)}${block.reason !== undefined ? ` · ${block.reason}` : ''}`
  }
  if (value.action === 'list') {
    if (value.blocks.length === 0) return '当前没有屏蔽任何记忆。'
    return `当前屏蔽（${value.blocks.length} 条）：\n${value.blocks.map(describe).join('\n')}`
  }
  if (value.action === 'unblock') {
    if (value.outcome !== 'unblocked') return value.note ?? '没有找到匹配的屏蔽记录。'
    const rest = value.blocks.length === 0 ? '现在没有生效的屏蔽。' : `剩余 ${value.blocks.length} 条屏蔽：\n${value.blocks.map(describe).join('\n')}`
    return `已解除 ${value.removed ?? 0} 条屏蔽。${rest}`
  }
  if (value.outcome !== 'blocked') {
    return value.note ?? (value.outcome === 'rejected'
      ? '用户拒绝了这次屏蔽；记忆保持原样。'
      : value.outcome === 'timeout'
        ? '审批超时，屏蔽没有生效。'
        : '当前环境无法发起屏蔽。')
  }
  const head = value.blocks.length === 1
    ? `已屏蔽 ${describe(value.blocks[0]!).slice(2)}。`
    : `已屏蔽 ${value.blocks.length} 条：\n${value.blocks.map(describe).join('\n')}`
  const records = value.records !== undefined && value.records.length > 0
    ? `\n涉及记录：${value.records.map((record) => `[${shortId(record.id)}] ${label(record.scope)}/${record.kind}`).join('、')}`
    : ''
  const note = value.note !== undefined ? `\n${value.note}` : ''
  // 屏蔽是「藏起来」而不是删除：这句话必须出现，否则模型容易把屏蔽当成不可逆操作而不敢用。
  return `${head}${records}${note}\n（屏蔽不删除任何记忆，数据原样保留；解除后立刻复原。）`
}

/**
 * memory_hooks 的渲染（0.35.0）。
 *
 * 三件事必须让模型看懂，否则它会误判「脚本已经生效」：
 *   1. 代码是否已获用户批准（未批准 = 不会运行）；
 *   2. 运行时机与适用范围；
 *   3. 最近的运行结局（校验器坏了 / 一直在拒，都要一眼看见）。
 *
 * 代码正文**不在 list 里打印**（那是 get 的事）：一次列十几段脚本会把上下文撑爆。
 */
export function renderHooksResult(value: HooksResult, label: ScopeLabel): string {
  const phaseText: Record<string, string> = {
    'before-save': '保存前校验（可拒绝保存）',
    'after-save': '保存后观察（不阻断）',
    'before-inject': '注入前解析（可改写/丢弃）',
  }
  const pending = (hook: HookRecordView): boolean => hook.pendingApproval === true

  const describe = (hook: HookRecordView): string => {
    const parts = [`[${shortId(hook.id)}] ${hook.name}`, phaseText[hook.phase] ?? hook.phase]
    if (!hook.enabled) parts.push('已停用')
    if (pending(hook)) parts.push('⏳ 待用户批准（不会运行）')
    if (hook.scopes.length > 0) parts.push(`作用域 ${hook.scopes.map(label).join('/')}`)
    if (hook.kinds.length > 0) parts.push(`类型 ${hook.kinds.join('/')}`)
    if (hook.runCount > 0) parts.push(`运行 ${hook.runCount}${hook.rejectCount > 0 ? ` / 拒 ${hook.rejectCount}` : ''}${hook.errorCount > 0 ? ` / 错 ${hook.errorCount}` : ''}`)
    if (hook.lastOutcome === 'error') parts.push(`最近出错：${hook.lastMessage ?? '（无说明）'}`)
    else if (hook.lastOutcome === 'rejected') parts.push(`最近拒绝：${hook.lastMessage ?? '（无说明）'}`)
    return `- ${parts.join(' · ')}`
  }

  const settingsLine = (): string => {
    const s = value.settings
    if (s === undefined) return ''
    const state = s.enabled ? '开启' : '关闭'
    return `钩子总开关：${state}；超时 ${s.timeoutMs}ms；带代码的规则${s.requireApproval ? '需要用户批准一次' : '不要求批准（已关闭审批）'}。`
  }

  if (value.action === 'get') {
    const hook = value.hooks[0]
    if (hook === undefined) return '这个钩子不存在。'
    const head = describe(hook)
    const body = hook.code.split('\n').map((line, index) => `${String(index + 1).padStart(3, ' ')}| ${line}`).join('\n')
    const tail = pending(hook) ? '\n\n⚠ 这段代码还没被用户批准，**当前不会运行**。' : ''
    return `${head}\n\n\`\`\`js\n${body}\n\`\`\`${tail}`
  }

  if (value.action === 'run') {
    const hook = value.hooks[0]
    const head = hook !== undefined ? describe(hook) : ''
    const outcomes = value.outcomes ?? []
    const detail = outcomes.length === 0
      ? '（脚本没有命中这次输入）'
      : outcomes.map((outcome) => {
          const lines: string[] = []
          if (outcome.error !== undefined) lines.push(`运行失败：${outcome.error}`)
          else lines.push(outcome.ok ? '判定：通过' : `判定：不通过${outcome.message !== undefined ? ` —— ${outcome.message}` : ''}`)
          if (outcome.content !== undefined) lines.push(`改写后正文：${outcome.content.slice(0, 400)}`)
          if (outcome.logs !== undefined && outcome.logs.length > 0) lines.push(`日志：${outcome.logs.join(' / ')}`)
          lines.push(`耗时 ${outcome.durationMs}ms`)
          return lines.join('\n')
        }).join('\n')
    return [head, detail, value.note ?? ''].filter((part) => part !== '').join('\n')
  }

  const list = value.hooks
  if (list.length === 0) {
    return [value.note ?? '', '当前没有任何记忆钩子。']
      .filter((part) => part !== '')
      .concat('在 memory_save 里带上 hookCode 就能随规则一起登记一段校验脚本。')
      .join('\n')
  }
  const body = list.map(describe).join('\n')
  const note = value.note !== undefined ? `${value.note}\n` : ''
  const settings = settingsLine()
  return `${body}${settings !== '' ? `\n\n${settings}` : ''}${note !== '' ? `\n${note}` : ''}`
}
