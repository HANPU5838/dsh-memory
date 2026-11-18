/**
 * 硬性规则段:来自 kind='rule' 的记忆,进系统提示常驻段。
 *
 * 为什么放系统提示而不是每轮消息:规则要"一直在场",但每轮复制会膨胀并稀释
 * 注意力;系统提示是每步都会看见的位置,且文本稳定时可以跟着前缀缓存。
 * 只放"不可机械校验"的规则 —— 能写成检查的规则应该进钩子(代码强制)。
 *
 * 0.9.6 起:
 *   - 已被新规则 supersede 的旧规则不进入常驻段,保留历史用于 memory_get/search;
 *   - mandatory/pinned 标签的规则排在最前,超出预算时给出明确警告,不静默丢弃;
 *   - 任何因条数/预算未展示的规则都会在段尾报告数量,并写入审计。
 *
 * 增量提醒(0.9.0 起):系统提示段每步都会按内存快照重渲染,但"规则是别的会话里
 * 新加/改过的"这件事只改文本、不产生任何对话消息;模型在旧会话里继续聊时未必会
 * 重新读一遍系统提示,而且规则段有 token 预算,新规则可能被旧规则挤出常驻段。
 * 所以 apply.ts 在每轮第一步把「新加/编辑过的规则」补成一条消息;这里只放纯函数:
 * 渲染、从系统提示/历史消息里抽取规则行、判断哪些行已经出现过。
 */
import type { MemoryRecord } from 'dsh-memory'
import { escapeTemplateBraces } from './braces.ts'
import { estimateTokens } from '../../memory-local/src/rerank.ts'
import type { RulesSettings } from '../../memory-local/src/inject-settings.ts'
import { supersededIds } from './digest.ts'

export const RULES_HEADER =
  '以下是必须遵守的硬性规则（来自 kind=rule 的记忆，只注入摘要；每条开头的短 ID 可用于取全文，' +
  '需要原文或细节时用 memory_get 按 ID 获取。除非用户明确要求破例，否则按它做）：'

export const RULES_DELTA_HEADER =
  '以下是新增或变更的硬性规则（来自 kind=rule 的记忆，只注入摘要；' +
  '需要原文或细节时用 memory_get 按 ID 获取；从现在起按它做）：'

/** mandatory/pinned 是显式的标签约定,不把全部 kind=rule 自动升级。 */
const MANDATORY_TAGS = new Set(['mandatory', 'pinned', '必含', '强制'])

export function isMandatoryRule(record: MemoryRecord): boolean {
  return (record.tags ?? []).some((tag) => {
    const value = String(tag).trim().toLowerCase()
    return MANDATORY_TAGS.has(value) || value.startsWith('mandatory:') || value.startsWith('pinned:')
  })
}

/**
 * 一条规则的渲染行。常驻段与增量块共用同一个格式 —— 增量靠"逐行比对"判断
 * 会话是否已经见过某条规则,两边只要有一个字符不同就会重复提醒。
 *
 * 0.18.0 起行首带 8 位短 ID(与摘要/召回索引同一口径):注入的是摘要,正文可能被
 * 截断,模型需要完整规则时用 memory_get(前缀) 取。
 */
export function ruleLine(record: MemoryRecord): string {
  return `- \`${record.id.slice(0, 8)}\` ${record.content.replace(/\s+/g, ' ').slice(0, 240)}`
}

/** 规则排序:mandatory 优先,其次重要度、新的在前,最后按内容稳定排序。 */
export function orderRules(records: readonly MemoryRecord[]): MemoryRecord[] {
  return [...records].sort(
    (a, b) =>
      Number(isMandatoryRule(b)) - Number(isMandatoryRule(a)) ||
      b.importance - a.importance ||
      b.updatedAt - a.updatedAt ||
      a.content.localeCompare(b.content),
  )
}

export interface RulesStats {
  candidates: number
  active: number
  injected: number
  omittedTopK: number
  omittedBudget: number
  omittedSuperseded: number
  mandatory: number
  mandatoryInjected: number
  mandatoryOmitted: number
  truncated: boolean
  /** 实际进入规则段的 id。 */
  injectedIds: string[]
  /** 实际进入规则段的 id + 版本(写入会话注入状态,避免 recall 重复注入同一条规则)。 */
  injectedEntries: Array<{ id: string; updatedAt: number }>
  /** 被省略的 id 与互斥原因。 */
  omitted: Array<{ id: string; reason: 'top_k' | 'budget' | 'superseded' }>
  omittedIds: string[]
}

export interface RulesRender {
  text: string
  tokens: number
  count: number
  stats: RulesStats
}

function renderLines(
  records: readonly MemoryRecord[],
  header: string,
  cfg: RulesSettings,
  budget: number,
): RulesRender {
  const retired = supersededIds(records)
  const active: MemoryRecord[] = []
  let omittedSuperseded = 0
  const omitted: Array<{ id: string; reason: 'top_k' | 'budget' | 'superseded' }> = []
  for (const record of records) {
    if (retired.has(record.id)) {
      omittedSuperseded += 1
      omitted.push({ id: record.id, reason: 'superseded' })
      continue
    }
    active.push(record)
  }

  let tokens = estimateTokens(header) + 4
  const lines: string[] = []
  const injectedIds: string[] = []
  const injectedEntries: Array<{ id: string; updatedAt: number }> = []
  let omittedTopK = 0
  let omittedBudget = 0
  let budgetExhausted = false
  let mandatoryInjected = 0
  let mandatoryOmitted = 0
  const mandatoryTotal = active.filter(isMandatoryRule).length

  for (const [index, record] of orderRules(active).entries()) {
    const mandatory = isMandatoryRule(record)
    if (index >= cfg.maxItems) {
      omittedTopK += 1
      omitted.push({ id: record.id, reason: 'top_k' })
      if (mandatory) mandatoryOmitted += 1
      continue
    }
    if (budgetExhausted) {
      omittedBudget += 1
      omitted.push({ id: record.id, reason: 'budget' })
      if (mandatory) mandatoryOmitted += 1
      continue
    }
    const line = ruleLine(record)
    const cost = estimateTokens(line) + 1
    if (tokens + cost > budget) {
      budgetExhausted = true
      omittedBudget += 1
      omitted.push({ id: record.id, reason: 'budget' })
      if (mandatory) mandatoryOmitted += 1
      continue
    }
    lines.push(line)
    injectedIds.push(record.id)
    injectedEntries.push({ id: record.id, updatedAt: record.updatedAt })
    tokens += cost
    if (mandatory) mandatoryInjected += 1
  }

  const statsBase = {
    candidates: records.length,
    active: active.length,
    injected: lines.length,
    omittedTopK,
    omittedBudget,
    omittedSuperseded,
    mandatory: mandatoryTotal,
    mandatoryInjected,
    mandatoryOmitted,
    truncated: omitted.length > 0,
    injectedIds,
    injectedEntries,
    omitted,
    omittedIds: omitted.map((entry) => entry.id),
  }

  if (lines.length === 0 && active.length === 0) {
    return { text: '', tokens: 0, count: 0, stats: statsBase }
  }
  // 一条都装不下且不是 mandatory 溢出的情况:文本为空,但统计仍保留给审计。
  // 系统提示的调用方(renderRulesBlock)会把空文本转成 null,保持旧行为。

  const notes: string[] = []
  const noBody = lines.length === 0 && mandatoryOmitted === 0
  const omittedCount = omittedTopK + omittedBudget
  if (!noBody && omittedCount > 0) {
    const parts: string[] = []
    if (omittedTopK > 0) parts.push(`条数上限 ${omittedTopK}`)
    if (omittedBudget > 0) parts.push(`预算 ${omittedBudget}`)
    notes.push(`（另有 ${omittedCount} 条规则未展示：${parts.join(' / ')}；需要时用 memory_search 查 kind=rule）`)
  }
  if (!noBody && mandatoryOmitted > 0) {
    notes.push(`（警告：${mandatoryOmitted} 条 mandatory / pinned 规则未展示，当前规则不完整）`)
  }
  const text = [lines.length > 0 ? `${header}\n${lines.join('\n')}` : '', ...notes].filter(Boolean).join('\n')
  const extraTokens = notes.reduce((sum, note) => sum + estimateTokens(note) + 1, 0)

  return {
    text: escapeTemplateBraces(text),
    tokens: tokens + extraTokens,
    count: lines.length,
    stats: {
      ...statsBase,
      truncated: omittedCount > 0,
    },
  }
}

/** 渲染规则段(系统提示常驻)及其审计统计。没有可展示的规则时 text 为空串。 */
export function renderRules(records: readonly MemoryRecord[], cfg: RulesSettings): RulesRender {
  return renderLines(records, RULES_HEADER, cfg, cfg.tokenBudget)
}

/** 渲染规则段(系统提示常驻),只要文本;空文本返回 null。 */
export function renderRulesBlock(records: readonly MemoryRecord[], cfg: RulesSettings): string | null {
  const text = renderRules(records, cfg).text
  return text === '' ? null : text
}

/**
 * 渲染"新增/变更的规则"块。预算比常驻段留宽一点:增量块本来就是常驻段装不下
 * 时才需要的补充,用同一个 300 token 的上限容易把最该提醒的一条又截掉。
 */
export function renderRulesDelta(records: readonly MemoryRecord[], cfg: RulesSettings): RulesRender {
  return renderLines(records, RULES_DELTA_HEADER, cfg, Math.max(cfg.tokenBudget, 600))
}

export function renderRulesDeltaBlock(records: readonly MemoryRecord[], cfg: RulesSettings): string | null {
  const text = renderRulesDelta(records, cfg).text
  return text === '' ? null : text
}

/** 模型可见历史里的一小部分形状(只读;不依赖宿主的 Message 类型)。 */
export interface HistoryMessageView {
  role: string
  content: ReadonlyArray<{ type: string; text?: string }>
  source?: { kind?: string }
}

/** 一条消息的纯文本(多个 text 块用换行连接)。 */
export function messageText(message: HistoryMessageView): string {
  return (message.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
}

/**
 * 从一段提示文本里抽出以 `header` 开头的段。段与段之间用一个空行分隔,
 * 段内的行都是单行(渲染时已把空白折叠成空格)。
 */
export function extractSection(text: string, header: string): string | undefined {
  const at = text.indexOf(header)
  if (at < 0) return undefined
  const rest = text.slice(at + header.length)
  const end = rest.indexOf('\n\n')
  return end < 0 ? rest : rest.slice(0, end)
}

/** 段里的条目行(以 `- ` 开头、已 trim 的行)。 */
export function sectionLines(section: string | undefined): string[] {
  if (!section) return []
  return section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
}

/** 模型可见历史里最新的那条非空系统提示(宿主可能在历史里追加多个系统节点)。 */
export function latestSystemText(history: readonly HistoryMessageView[]): string | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i]
    if (message?.role !== 'system') continue
    const text = messageText(message)
    if (text.length > 0) return text
  }
  return undefined
}

/**
 * 这个会话"已经看见过"的规则行 = 最新系统提示里的规则段
 * ∪ 历史上注入过的增量块(同一条规则只会提醒一次,重启宿主也不会重复)。
 */
export function seenRuleLines(history: readonly HistoryMessageView[]): Set<string> {
  const seen = new Set<string>()
  const systemText = latestSystemText(history)
  if (systemText !== undefined) {
    for (const line of sectionLines(extractSection(systemText, RULES_HEADER))) seen.add(line)
  }
  for (const message of history) {
    if (message.role !== 'user' || message.source?.kind !== 'memory') continue
    for (const line of sectionLines(extractSection(messageText(message), RULES_DELTA_HEADER))) seen.add(line)
  }
  return seen
}
