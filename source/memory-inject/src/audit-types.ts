/**
 * 注入审计 v2 的事件类型。
 *
 * 这些类型是 **memory-inject 与面板 API 的共同语义**：store 负责生成
 * `id/seq/at/schemaVersion`，调用方只提供事实字段。设计口径见
 * `docs/audit-implementation-review.md` 与 audit v2 实施计划：
 *
 *   - evaluation   评估：候选、选中、省略、预算、检索/加载结果
 *   - delivery     投递：最终消息是否真的被追加，或被什么拦下
 *   - signal       信号：观察到、入队、消费
 *   - lifecycle    生命周期：压缩、禁用、审计存储健康
 *   - error        错误：失败阶段 + 稳定错误码（不存堆栈/原文）
 *
 * 不变量：
 *   - 不存记忆正文、原始工具参数、完整提示词、异常堆栈；
 *   - 所有自由文本必须已经过 `sanitizeAuditText`；
 *   - `selected.contentIds` 只表示“被评估选中”，不等于“已投递”；
 *   - 只有拿到追加成功的事实才能写 `delivery.status='appended'`。
 */

export type AuditChannel =
  | 'digest'
  | 'recall'
  | 'rules'
  | 'rules_delta'
  | 'policy'
  | 'nudge'
  | 'signal'
  | 'lifecycle'

export type AuditKind = 'signal' | 'evaluation' | 'delivery' | 'lifecycle' | 'error'

export type AuditOutcome = 'success' | 'failed' | 'skipped' | 'partial' | 'unknown'

export type AuditDeliveryStatus = 'appended' | 'suppressed' | 'rejected' | 'unknown' | 'not_attempted'

export type AuditSuppressedBy = 'dedup' | 'malformed' | 'empty' | 'rejected' | 'aborted' | 'unknown'

export type AuditOmitReason =
  | 'top_k'
  | 'budget'
  | 'superseded'
  | 'expired'
  | 'rule'
  | 'tag_mismatch'
  | 'dedup'
  | 'excluded'
  | 'skipped'

export interface AuditBudget {
  budget: number
  used: number
  remaining: number
  over: boolean
}

export interface AuditQueryField {
  /** 已经过脱敏、限长的诊断摘要；空字符串时不写。 */
  text?: string
  /** 原始输入字符数（不是截断后的长度）。 */
  chars: number
  /** 是否命中过凭据规则。 */
  redacted: boolean
  /** 稳定短 hash，便于比较同一 query 而不保存原文。 */
  hash?: string
}

export interface AuditOmission {
  id: string
  reason: AuditOmitReason | string
  kind?: string
  tags?: string[]
}

export interface AuditFilterStats {
  /** 检索返回的原始命中数（过滤前）。 */
  rawHits: number
  /** 因 requireTag 被丢弃的数量。 */
  tagFiltered: number
  /** 因 superseded/excludeIds 被丢弃的数量。 */
  supersededExcluded: number
  /** 最终参与渲染的候选数。 */
  candidates: number
}

export interface AuditEntryV2 {
  schemaVersion: 2
  id: string
  seq: number
  at: number
  sessionId?: string
  turn?: number
  step?: number
  traceId?: string
  operationId?: string
  kind: AuditKind
  channel: AuditChannel
  /** 细阶段：observed / source_load / rendered / searched / delivery ... */
  stage: string
  trigger?: string
  phase?: string
  outcome: AuditOutcome
  reasonCode?: string
  scopes?: string[]
  limits?: {
    topK?: number
    maxItems?: number
    maxQueryChars?: number
    budgets?: Record<string, number>
  }
  query?: AuditQueryField
  candidates?: number
  /** 检索/标签/退役过滤的分阶段数量；用于核对 candidates 的来源。 */
  filter?: AuditFilterStats
  selected?: {
    /** 被评估选择的记忆 id；不等于“已投递”。 */
    contentIds: string[]
    hintIds: string[]
    /** 本次真正新增到文本里的 id（文本相同/去重时为空）。 */
    newlyAddedIds?: string[]
    count: number
  }
  omitted?: AuditOmission[]
  dedup?: {
    skipped: number
    updated: number
    lastTextSame: boolean
    ids?: string[]
  }
  budgets?: Record<string, AuditBudget>
  /** 0.67.0：图增强（PPR 多跳）本次补召回进候选的条数。 */
  graph?: { expanded: number }
  /** 摘要/规则走的是 list()/listSync()，不是检索；用 sourceLoad 表达。 */
  sourceLoad?: {
    ok: boolean
    count?: number
    errorCode?: string
  }
  retrieval?: {
    ok: boolean
    count?: number
    errorCode?: string
    durationMs?: number
  }
  rules?: {
    active?: number
    injected?: number
    mandatory?: number
    mandatoryInjected?: number
    mandatoryOmitted?: number
    injectedIds?: string[]
    omittedIds?: string[]
  }
  signal?: {
    key?: string
    reason?: string
    tool?: string
    tag?: string
    errorClass?: string
    source?: string
    /**
     * 触发这条信号的 tool call id（若信号来自工具事件）。
     * 与条目上的 `operationId` 同值；独立保留是为了让信号消费/召回事件
     * 也能把用户带回轨迹里那次具体的工具调用。
     */
    callId?: string
  }
  error?: {
    stage: string
    code: string
  }
  delivery?: {
    status: AuditDeliveryStatus
    appended: boolean | null
    suppressedBy?: AuditSuppressedBy
    textChars?: number
    textHash?: string
  }
  /** delivery 事件专用：这条消息里包含哪些通道。 */
  channels?: AuditChannel[]
}

/** store 负责生成 schemaVersion/id/seq/at；调用方只给事实。 */
export type AuditDraft = Omit<AuditEntryV2, 'schemaVersion' | 'id' | 'seq' | 'at'> & { at?: number }

export interface AuditListQuery {
  sessionId?: string
  traceId?: string
  operationId?: string
  memoryId?: string
  channel?: string
  trigger?: string
  outcome?: string
  /** 只看问题：失败 / 未投递 / 有省略 / 审计缺口。 */
  problem?: boolean
  since?: number
  until?: number
  limit?: number
  cursor?: string
}

export interface AuditStoreStats {
  entries: number
  capacity: number
  perSessionCapacity: number
  dropped: number
  writeErrors: number
  persistence: 'memory' | 'jsonl' | 'degraded'
  lastRecordedAt?: number
}

export interface AuditPage {
  entries: AuditEntryV2[]
  total: number
  nextCursor?: string
  stats: AuditStoreStats
}

export interface AuditSink {
  list(sessionId?: string): AuditEntryV2[]
  query(query?: AuditListQuery): AuditPage
  stats(): AuditStoreStats
  clear?(scope: { sessionId?: string; before?: number }): number
  dispose?(): void
}
