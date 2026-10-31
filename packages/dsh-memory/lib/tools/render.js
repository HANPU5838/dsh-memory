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
                                                                                                                               
import { scopeDisplayName } from '../provider/scope.js'

/** 把 scope 键渲染成展示文案（宿主能查到会话标题时用它，否则用短 id）。 */
                                                  

/** 有内容没返回时的原因。 */
                                                                    

/**
 * 上下文去重的提示语(0.21.0)。memory_search / memory_list 里已经出现过的条目
 * 只回 id、不再回摘要/正文；这条提示告诉模型为什么少了东西、以及怎么取全文。
 */
export const DEDUPE_NOTE = '本次请求部分记忆摘要因上下文去重机制被省略，若要获取完整内容请使用 memory_get'

export const shortId = (id        )         => id.slice(0, 8)

const day = (value         )         =>
  typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString().slice(0, 10) : ''

const joinList = (value         )         =>
  Array.isArray(value) ? value.map(String).filter((v) => v !== '').join(', ') : ''

/**
 * 范围外内容为什么没返回——给模型看的真实原因。
 * 空字符串 = 没有需要说明的（没有 withheld）。
 */
export function renderWithheldNote(withheld                          )         {
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
  outOfScope                                         ,
  label            ,
)         {
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
export function renderSearchResult(value              , label            )         {
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
  const shown           = []
  const bare           = []
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
export function renderListResult(value            , label            )         {
  let omitted = 0
  const body = value.records.length === 0
    ? '该作用域还没有记忆。'
    : value.records.map((record) => {
      if (record.deduped === true) {
        omitted += 1
        return shortId(record.id)
      }
      return `(${label(record.scope)}/${record.kind}) ${record.content}`
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
export function renderScopesResult(value                  , label            )         {
  if ('results' in value) {
    if (value.results.length === 0) return '没有需要申请的作用域权限。'
    const statusText = (status        )         => {
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
    const reasonText = (reason                    )         => {
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
    const meta           = []
    if (item.records !== undefined) meta.push(`${item.records} 条`)
    if (item.archived === true) {
      // 0.30.0：归档不是权限拒绝，而是会话生命周期 —— 数据仍在，恢复会话即复原。
      meta.push('已归档 · 恢复会话后自动恢复读写')
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
export function renderGetResult(value           , label            )         {
  const fields = new Set          (value.fields)
  const body = value.records.map((record) => {
    const meta           = []
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


//# sourceURL=source/tool-memory/src/render.ts