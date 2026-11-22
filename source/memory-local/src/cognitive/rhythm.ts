/**
 * 认知节律（proactive rhythm）：让系统按自己的时间尺度做两件事——
 *   1. 周期性自省（反思不再靠人触发）；
 *   2. 从最近的记忆里提出「候选目标」（目标不再只能由用户输入）。
 *
 * 纯函数层：只判断“该不该做”和“提议什么”，写库与落状态由 provider 负责。
 */
const DAY = 86_400_000

export interface RhythmState {
  lastReflectAt?: number
  lastProposeAt?: number
}

export interface RhythmOptions {
  now?: number
  /** 多久跑一次自省，默认 24h。 */
  reflectEveryMs?: number
  /** 多久提一次候选目标，默认 72h。 */
  proposeEveryMs?: number
}

export function reflectionDue(state: RhythmState, options: RhythmOptions = {}): boolean {
  const now = options.now ?? Date.now()
  const every = options.reflectEveryMs ?? DAY
  return state.lastReflectAt === undefined || now - state.lastReflectAt >= every
}

export function proposalDue(state: RhythmState, options: RhythmOptions = {}): boolean {
  const now = options.now ?? Date.now()
  const every = options.proposeEveryMs ?? 3 * DAY
  return state.lastProposeAt === undefined || now - state.lastProposeAt >= every
}

export interface GoalCandidate {
  conclusion: string
  evidence: string[]
  confidence: number
  sourceIds: string[]
}

type GoalRecord = {
  id: string
  kind: string
  content: string
  importance: number
  updatedAt: number
}

/** 目标线索：用户近期说过的、带“下一步/待办/需要/计划/准备”的决策或状态记忆。 */
const GOAL_HINTS = ['下一步', '待办', '需要', '计划', '准备', '接下来', '还没', '未完成', 'TODO']

export function inferGoalCandidates(records: readonly GoalRecord[], options: RhythmOptions = {}): GoalCandidate[] {
  const now = options.now ?? Date.now()
  const since = now - 14 * DAY
  const candidates: GoalCandidate[] = []
  for (const record of records) {
    if (record.updatedAt < since) continue
    if (record.kind !== 'decision' && record.kind !== 'state' && record.kind !== 'procedure') continue
    if (record.importance < 0.6) continue
    const hits = GOAL_HINTS.filter((hint) => record.content.includes(hint))
    if (hits.length === 0) continue
    candidates.push({
      conclusion: record.content.slice(0, 120),
      evidence: [`命中线索：${hits.join('、')}`, `来源记忆 ${record.id.slice(0, 8)}（${record.kind}）`],
      confidence: Math.min(0.9, 0.5 + 0.1 * hits.length + record.importance * 0.2),
      sourceIds: [record.id],
    })
  }
  return candidates.slice(0, 3)
}
