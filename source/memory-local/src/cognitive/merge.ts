/**
 * 语义合并（cognitive/merge）—— 纯函数，无 I/O、无副作用。
 *
 * 背景：store.save() 的"去重"只认**归一化文本完全相同**；语义相同但措辞不同的
 * 两条记忆会并存，检索时互相稀释权重。这里把"嵌入相似度 ≥ 阈值"的旧记录升级成
 * 一个**新版本**：内容更新、tags 并集、importance 取大、supersedes 指向旧 id、
 * generation+1 —— 旧记录**不删**（保留为已修正的历史版本，检索侧按 retired 隐藏，
 * lineage() 仍可取到）。
 *
 * 本模块只产出计划（MergePlan），落盘/嵌入仍由调用方（index.ts 的 save 路径）执行：
 *   const hits = store.findSimilar(vec, { scopes: [scope], minScore: 0.75 })
 *   const plan = planMergeAgainst({ incoming }, hits)
 *   if (plan?.action === 'merge') store.save(mergePlanToSaveInput(plan)!, defaults)
 */
import {
  clamp01,
  generationOf,
  newId,
  normalizeContent,
  isTombstonedRecord,
  type CognitiveRecord,
  type MemoryRecord,
  type MemorySaveInput,
} from '../store.ts'

/** 语义合并阈值：相似度 ≥ 0.92 视为同一件事的两种说法，合并成新版本。 */
export const MERGE_THRESHOLD = 0.92

/** 待写入的新记忆（还没入库；缺省字段沿用被合并的旧记录）。 */
export interface IncomingMemory {
  content: string
  tags?: string[]
  importance?: number
  kind?: MemoryRecord['kind']
  source?: MemoryRecord['source']
  triggers?: string[]
  /** 初始化流程创建的记录带来源标记，合并后要跟着走。 */
  initial?: boolean
}

export interface MergeRequest {
  incoming: IncomingMemory
  /** 已存在的高相似记录（findSimilar 的命中）。 */
  existing: MemoryRecord
  /** 嵌入相似度 0..1。 */
  similarity: number
  /** 合并阈值，默认 MERGE_THRESHOLD（0.92）。 */
  threshold?: number
  /**
   * 上层（LLM / 人工）重写后的合并正文；缺省用 incoming.content。
   * 语义合并真正的"内容更新"在这里发生：新内容 + 旧版本留痕。
   */
  mergedContent?: string
  /** 固定时间（测试用），缺省 Date.now()。 */
  now?: number
}

export type MergeAction = 'refresh' | 'merge' | 'keep'
export type MergeReason = 'identical-content' | 'semantic-duplicate' | 'below-threshold'

export interface MergePlan {
  action: MergeAction
  reason: MergeReason
  similarity: number
  threshold: number
  /** action='merge'：新版本记录（id 已生成；可直接 insert，或走 mergePlanToSaveInput）。 */
  record?: CognitiveRecord
  /** action='merge'：被取代的旧记录 id（旧记录保留不删）。 */
  supersedes?: string
  /** action='merge'：新版本号（旧 generation + 1）。 */
  generation?: number
  /** action='refresh'：命中的旧记录 id（同内容重写，交给 store.save 的去重分支刷新）。 */
  refreshId?: string
  /** 合并后的 tags 并集（保序：旧在前、新的补充在后）。 */
  tags: string[]
  /** 合并后的 importance（取大）。 */
  importance: number
}

/** 保序去重合并多个 tag 列表（旧的在前，新的补充在后）。 */
export function unionTags(...lists: Array<readonly string[] | undefined | null>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    for (const raw of list) {
      const tag = String(raw)
      if (tag === '' || seen.has(tag)) continue
      seen.add(tag)
      out.push(tag)
    }
  }
  return out
}

/** 取记录上的可选元数据字段（triggers/initial 不在 MemoryRecord 基础类型里）。 */
function metaOf(record: MemoryRecord): { triggers?: string[]; initial?: boolean } {
  const rec = record as MemoryRecord & { triggers?: unknown; initial?: unknown }
  return {
    triggers: Array.isArray(rec.triggers) ? rec.triggers.map(String) : undefined,
    initial: rec.initial === true,
  }
}

/**
 * 给定"新记录 vs 已存在记录"，产出合并计划：
 *   - 归一化内容相同 → 'refresh'（不产生新版本，交给 store.save 去重分支）
 *   - 相似度 < threshold → 'keep'（两条都留）
 *   - 否则 → 'merge'（新版本取代旧版本）
 */
export function planMerge(request: MergeRequest): MergePlan {
  const threshold = clamp01(request.threshold ?? MERGE_THRESHOLD)
  const similarity = clamp01(request.similarity)
  const now = request.now ?? Date.now()
  const incoming = request.incoming
  const existing = request.existing
  const tags = unionTags(existing.tags, incoming.tags)
  const importance = Math.max(clamp01(existing.importance), clamp01(incoming.importance ?? existing.importance))

  if (normalizeContent(incoming.content) === normalizeContent(existing.content)) {
    return {
      action: 'refresh',
      reason: 'identical-content',
      similarity,
      threshold,
      refreshId: existing.id,
      tags,
      importance,
    }
  }
  if (similarity < threshold) {
    return {
      action: 'keep',
      reason: 'below-threshold',
      similarity,
      threshold,
      tags,
      importance,
    }
  }

  const content = (request.mergedContent !== undefined ? request.mergedContent : incoming.content).trim()
  const oldMeta = metaOf(existing)
  const record: CognitiveRecord = {
    id: newId(),
    scope: existing.scope,
    kind: (incoming.kind ?? existing.kind) as MemoryRecord['kind'],
    content: content !== '' ? content : existing.content,
    tags,
    source: { ...existing.source, ...incoming.source },
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
    accessCount: 0,
    importance,
    // 谱系：新版本明确指向被取代的旧版本；版本号 +1。
    supersedes: existing.id,
    generation: generationOf(existing) + 1,
  }
  const triggers = unionTags(oldMeta.triggers, incoming.triggers)
  if (triggers.length > 0) (record as CognitiveRecord & { triggers?: string[] }).triggers = triggers
  if (oldMeta.initial === true || incoming.initial === true) {
    ;(record as CognitiveRecord & { initial?: boolean }).initial = true
  }
  // 过期时间只继承"还没到期"的那种：合并出来的新版本不该一落盘就被清理。
  if (existing.expiredAt !== undefined && existing.expiredAt > now) record.expiredAt = existing.expiredAt
  return {
    action: 'merge',
    reason: 'semantic-duplicate',
    similarity,
    threshold,
    record,
    supersedes: existing.id,
    generation: record.generation,
    tags,
    importance,
  }
}

/**
 * 在多个相似候选里挑最像的一条并出合并计划；没有候选达到阈值 → null
 * （= 调用方按普通新记录保存）。
 *
 * 候选通常来自 store.findSimilar()；软删记录一律跳过（不能合并进一个已 forget 的东西）。
 */
export function planMergeAgainst(
  request: Omit<MergeRequest, 'existing' | 'similarity'>,
  candidates: Iterable<{ record: MemoryRecord; similarity: number }>,
): MergePlan | null {
  const threshold = clamp01(request.threshold ?? MERGE_THRESHOLD)
  let best: { record: MemoryRecord; similarity: number } | undefined
  for (const candidate of candidates) {
    if (candidate.record === undefined) continue
    if (isTombstonedRecord(candidate.record)) continue
    if (!Number.isFinite(candidate.similarity)) continue
    if (candidate.similarity < threshold) continue
    if (best === undefined || candidate.similarity > best.similarity) best = candidate
  }
  if (best === undefined) return null
  return planMerge({ ...request, existing: best.record, similarity: best.similarity, threshold })
}

/**
 * 维护路径：把**两条已存在的近重复记录**合并成一条（原地升级 keep，不产生第三条）。
 *
 * 与 planMerge 的区别：planMerge 面向"新记录 vs 旧记录"（新 id + supersedes 旧 id）；
 * 这里面向存量去重（nearDuplicates 找出来的对），让较新的 keep 直接 supersedes 较旧
 * 的 drop —— drop 自动变成退役版本（保留不删），keep 原地升级（tags 并集 / importance
 * 取大 / generation 提升 / 清掉休眠与冲突标记，因为合并已经解决了分歧）。
 *
 * 谱系约束：keep 自己已经有前驱（supersedes 指向别的记录）时返回 null —— 单值
 * supersedes 无法同时接上新旧两条链，这种情况交给人工/面板处理，绝不硬拼。
 */
export function planNearDuplicateMerge(
  keep: MemoryRecord,
  drop: MemoryRecord,
  similarity: number,
  options: { threshold?: number; mergedContent?: string; now?: number } = {},
): MergePlan | null {
  if (keep.id === drop.id) return null
  const threshold = clamp01(options.threshold ?? MERGE_THRESHOLD)
  const sim = clamp01(similarity)
  if (sim < threshold) return null
  const previous = typeof keep.supersedes === 'string' && keep.supersedes !== '' ? keep.supersedes : undefined
  if (previous !== undefined && previous !== drop.id) return null
  const now = options.now ?? Date.now()
  const tags = unionTags(keep.tags, drop.tags)
  const importance = Math.max(clamp01(keep.importance), clamp01(drop.importance))
  const record: CognitiveRecord = {
    ...keep,
    tags,
    importance,
    supersedes: drop.id,
    generation: Math.max(generationOf(keep), generationOf(drop)) + 1,
    updatedAt: now,
    lastAccessedAt: now,
  }
  const mergedContent = options.mergedContent?.trim()
  if (mergedContent !== undefined && mergedContent !== '') record.content = mergedContent
  // 合并掉的分歧不再成立：休眠 / 冲突标记一起清掉。
  delete record.dormantAt
  delete record.conflictWith
  delete record.conflictConfidence
  return {
    action: 'merge',
    reason: 'semantic-duplicate',
    similarity: sim,
    threshold,
    record,
    supersedes: drop.id,
    generation: record.generation,
    tags,
    importance,
  }
}

/**
 * 把合并计划转成 store.save() 的入参（Lead 集成入口）。
 * action !== 'merge' 时返回 null —— 'refresh' 直接按普通保存走（store.save 自己去重），
 * 'keep' 表示不合并、按新记录保存。
 */
export function mergePlanToSaveInput(plan: MergePlan): MemorySaveInput | null {
  if (plan.action !== 'merge' || plan.record === undefined) return null
  const record = plan.record
  const triggers = (record as CognitiveRecord & { triggers?: string[] }).triggers
  return {
    scope: record.scope,
    kind: record.kind,
    content: record.content,
    tags: [...record.tags],
    source: record.source,
    importance: record.importance,
    supersedes: record.supersedes,
    // store.save() 会按 supersedes 目标自动算 generation；这里显式带上保证一致。
    generation: record.generation,
    ...(record.expiredAt !== undefined ? { expiredAt: record.expiredAt } : {}),
    ...(Array.isArray(triggers) ? { triggers: [...triggers] } : {}),
    ...((record as CognitiveRecord & { initial?: boolean }).initial === true ? { initial: true } : {}),
  } as MemorySaveInput
}
