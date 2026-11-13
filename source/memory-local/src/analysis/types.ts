/**
 * 智能关系分析引擎 —— 类型契约（analysis/types）。
 *
 * 这一层把"记忆库"整理成可呈现/可推理的结构：实体之间的关系、记忆之间的矛盾、
 * 主题聚类、实体演化轨迹、2-hop 推理路径。全部类型都是**纯数据**：可以被 JSONL
 * 持久化（AnalysisRepository）、可以原样回传面板、可以跨进程合并。
 *
 * 设计约定：
 *   - `confidenceScore` 是系统评估（0..1 的加权得分），**不是概率**；面板/工具文案
 *     不要写"置信度 xx% 概率"。
 *   - 所有 id 都是确定性生成的（见 engine.ts），同一份输入重复分析得到同样的 id，
 *     调用方可以据此 merge 而不是整份替换。
 *   - 时间统一用毫秒时间戳。
 */

// ---------------------------------------------------------------- 记忆输入

/**
 * 分析引擎看到的记忆视图（与 store 的 MemoryRecord 结构兼容的超集/子集）。
 * 刻意不复用 MemoryRecord 类型：分析层只依赖这里的字段，方便单测直接造数据。
 */
export interface AnalysisMemory {
  id: string
  scope: string
  kind: string
  content: string
  tags: string[]
  createdAt: number
  updatedAt: number
  importance?: number
  /** 来源：user / explicit / tool / agent / auto（未知按中性处理）。 */
  sourceOrigin?: string
  /** 版本谱系：本记录取代的旧记录 id。 */
  supersedes?: string
  /** 事实有效期终点（被推翻的时刻）；已失效的记忆仍参与演化分析。 */
  validUntil?: number
  /** TTL 物理过期时刻；过期的记忆默认不参与分析。 */
  expiredAt?: number
  /** 软删标记；软删的记忆默认不参与分析。 */
  tombstonedAt?: number
}

// ---------------------------------------------------------------- 关系

export type RelationStatus = 'suggested' | 'confirmed' | 'rejected' | 'ignored' | 'pending_review'
export type RelationType = 'semantic' | 'entity' | 'temporal' | 'reasoning' | 'manual'
export type RelationStrength = 'strong' | 'medium' | 'weak' | 'unverified'

/** 一条关系的单条证据（面板点开关系时逐条展示）。 */
export interface RelationEvidence {
  kind:
    /** 两个实体共同出现在同一批记忆里。 */
    | 'shared-memory'
    /** 记忆之间的语义相似度（嵌入余弦）。 */
    | 'similarity'
    /** 记忆的实体集合重叠（Jaccard）。 */
    | 'entity-overlap'
    /** 时间接近程度。 */
    | 'temporal'
    /** 来源可信度。 */
    | 'source'
    /** 2-hop 推理路径。 */
    | 'reasoning-path'
  /** 人类可读的依据说明（中文，含具体数字）。 */
  text: string
  /** 语义相似度（0..1），kind='similarity' 时给。 */
  similarity?: number
  /** 重叠/共享的实体 label。 */
  sharedEntities?: string[]
  /** 推理路径上的实体 id（kind='reasoning-path' 时给）。 */
  path?: string[]
  /** 支撑这条证据的记忆 id。 */
  memoryIds: string[]
}

export interface RelationRecord {
  /** 确定性 id（pair + type 派生）。 */
  id: string
  /** 关系两端实体 id（`type:normalized`，字典序 source < target，关系视为无向）。 */
  sourceEntityId: string
  targetEntityId: string
  relationshipType: RelationType
  status: RelationStatus
  /** 系统评估分 0..1（非概率）。 */
  confidenceScore: number
  strength: RelationStrength
  evidence: RelationEvidence[]
  /** 支撑这条关系的全部记忆 id（升序）。 */
  sourceMemoryIds: string[]
  /** 是否由推理得出（2-hop），实体直连关系为 false。 */
  inferred: boolean
  analysisVersion: string
  createdAt: number
  updatedAt: number
  /** 调用方/面板备注（用户确认/拒绝的理由等）。 */
  note?: string
}

// ---------------------------------------------------------------- 冲突

export type ConflictKind =
  /** 同一事实被更新：关键细节变了、时间上有先后（建议以新记忆为准）。 */
  | 'update'
  /** 互相矛盾：关键细节冲突但无法判定谁更新，需要人工裁决。 */
  | 'contradiction'
  /** 只是语境相近（语义近似但没有细节冲突），提示性信息。 */
  | 'context'
  /** 无法归类。 */
  | 'unknown'

export type ConflictStatus = 'new' | 'pending_review' | 'confirmed' | 'resolved' | 'ignored'

export interface ConflictEvidence {
  kind: 'content' | 'time' | 'difference' | 'similarity' | 'contradiction'
  text: string
  memoryId?: string
  similarity?: number
  contradiction?: number
}

export interface ConflictRecord {
  id: string
  kind: ConflictKind
  status: ConflictStatus
  /** 较旧的记忆（按 updatedAt / createdAt / id 判定）。 */
  oldMemoryId: string
  /** 较新的记忆。 */
  newMemoryId: string
  similarity: number
  /** 矛盾置信度（contradiction.ts 的 assessment.confidence）。 */
  contradiction: number
  /** 人类可读摘要（中文，≤200 字）。 */
  summary: string
  evidence: ConflictEvidence[]
  createdAt: number
  updatedAt: number
  /** 人工/自动裁决结果。 */
  resolution?: ConflictResolution
}

export interface ConflictResolution {
  action: 'kept-old' | 'kept-new' | 'merged' | 'dismissed'
  at: number
  by?: string
  note?: string
}

// ---------------------------------------------------------------- 聚类

export interface ClusterEntity {
  id: string
  label: string
  /** 在该聚类内出现在几条记忆里。 */
  count: number
}

export interface KnowledgeCluster {
  /** 确定性 id（topic + 代表记忆）。 */
  id: string
  /** 主题：前 3 个非 tag 实体 label，用 ` · ` 连接；没有实体时用 kind 中文。 */
  topic: string
  /** 聚类内记忆 id（升序）。 */
  memoryIds: string[]
  topEntities: ClusterEntity[]
  count: number
  /** 共享实体数 > 0 的其它聚类，按共享数降序、id 升序。 */
  relatedClusterIds: string[]
}

// ---------------------------------------------------------------- 演化

export type EvolutionEventType = 'created' | 'updated' | 'superseded' | 'invalidated' | 'decision'

export interface EvolutionEvent {
  id: string
  entityId: string
  type: EvolutionEventType
  /** 产生该事件的记忆 id。 */
  memoryId: string
  at: number
  /** 事件说明（中文）。 */
  detail?: string
  /** superseded 事件指向被取代的旧记忆 id。 */
  supersededId?: string
}

export interface EvolutionTrack {
  entityId: string
  label: string
  /** 该实体出现过的记忆 id，按时间升序。 */
  memoryIds: string[]
  events: EvolutionEvent[]
  firstAt: number
  lastAt: number
  count: number
}

// ---------------------------------------------------------------- 推理路径

export interface ReasoningPath {
  id: string
  /** 路径两端（字典序 from < to，路径视为无向）。 */
  fromEntityId: string
  toEntityId: string
  /** 实体 id 序列（长度 3：A-B-C）。 */
  path: string[]
  /** 与 path 对应的实体 label。 */
  labels: string[]
  /** 路径乘积 × REASONING_FACTOR（0..1）。 */
  confidence: number
  inferred: true
  relationshipType: 'reasoning'
  evidence: RelationEvidence[]
  sourceMemoryIds: string[]
  analysisVersion: string
  createdAt: number
  updatedAt: number
}

// ---------------------------------------------------------------- 任务 / 状态

export type AnalysisMode = 'incremental' | 'full'
export type AnalysisTaskStatus = 'queued' | 'running' | 'paused' | 'done' | 'failed'

export interface AnalysisTaskOptions {
  scopes?: string[]
  entityTypes?: string[]
  since?: number
  until?: number
  maxPairs?: number
}

export interface AnalysisTask {
  id: string
  mode: AnalysisMode
  status: AnalysisTaskStatus
  /** 0..1 进度。 */
  progress: number
  total: number
  analyzed: number
  startedAt: number
  finishedAt?: number
  error?: string
  options?: AnalysisTaskOptions
}

export interface AnalysisState {
  /** 状态文件 schema 版本。 */
  version: number
  /** 记忆 id → `sha256(content)|updatedAt`，增量分析的依据。 */
  fingerprints: Record<string, string>
  lastAnalyzedAt?: number
}

// ---------------------------------------------------------------- 引擎输入 / 输出

export interface AnalyzeOptions {
  mode: AnalysisMode
  /** 只分析这些实体类型（缺省全部）；与 entities.extractEntities 的类型一致。 */
  entityTypes?: string[]
  /** 只分析 updatedAt >= since 的记忆。 */
  since?: number
  /** 只分析 updatedAt <= until 的记忆。 */
  until?: number
  /** 候选对上限（实体对 / 记忆对、增量比较对），默认 5000。 */
  maxPairs?: number
  /** 固定当前时刻（测试用），默认 Date.now()。 */
  now?: number
  /** 分析版本号（写进每条关系/路径），默认 '1'。 */
  analysisVersion?: string
}

export interface AnalyzeInput {
  memories: readonly AnalysisMemory[]
  /** 记忆 id → 单位向量（可缺省/不完整：没有向量的记忆只参与实体通道）。 */
  vectors?: ReadonlyMap<string, Float32Array>
  /** 上一次分析产出的 fingerprints（增量模式对比用）。 */
  previousFingerprints?: Record<string, string>
  /** 既有关系（已入库的）。增量模式下未被波及的 suggested 会原样放回 preservedRelations。 */
  existingRelations?: readonly RelationRecord[]
  /** 既有冲突（已入库的）。增量模式下未被波及的 new/pending_review 会原样放回 preservedConflicts。 */
  existingConflicts?: readonly ConflictRecord[]
  options?: Partial<AnalyzeOptions>
}

export interface AnalysisStats {
  mode: AnalysisMode
  /** 参与分析的记忆数（过滤软删/过期/时间窗之后）。 */
  memories: number
  /** 本次实际重新分析的对象数（full = memories；incremental = 变化记忆数）。 */
  analyzed: number
  /** 新增/变化（fingerprint 不同）的记忆数。 */
  changed: number
  /** 上次有、这次没有（被删/被过滤）的记忆数。 */
  removed: number
  /** 候选实体的数量（去重后）。 */
  entities: number
  /** 参与打分的候选实体对数量。 */
  entityPairs: number
  /** 参与相似度计算的候选记忆对数量。 */
  memoryPairs: number
  relations: number
  conflicts: number
  clusters: number
  paths: number
  evolution: number
  preservedRelations: number
  preservedConflicts: number
}

export interface AnalysisResult {
  /** 本次重新计算的关系（full 全量；incremental 只含涉及变化记忆的）。 */
  relations: RelationRecord[]
  conflicts: ConflictRecord[]
  clusters: KnowledgeCluster[]
  evolution: EvolutionTrack[]
  paths: ReasoningPath[]
  /** 本次产出的指纹（调用方存进 AnalysisState，下次作为 previousFingerprints）。 */
  fingerprints: Record<string, string>
  /** incremental：未涉及变化记忆、已入库且仍是 suggested 的关系（调用方原样合并）。 */
  preservedRelations: RelationRecord[]
  /** incremental：未涉及变化记忆、仍是 new/pending_review 的冲突（调用方原样合并）。 */
  preservedConflicts: ConflictRecord[]
  stats: AnalysisStats
}
