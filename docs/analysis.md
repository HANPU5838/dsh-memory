# 智能关系分析（0.60.0）

> 目标：让记忆系统从「存 + 查」升级为「**理解关系、发现关联、识别冲突、跟踪演化、给出可审核的推理**」。
> 全部基于本地规则与向量，**零依赖、不调 LLM、不伪造数据**；推断与事实分开存储。

## 1. 六大能力

| 能力 | 做法 | 关键约束 |
| --- | --- | --- |
| **潜在关系发现** | 实体共现 + 跨记忆语义相似 → 关系候选；`confidence = 0.45·cosineAvg + 0.25·entityJaccard + 0.15·timeProximity + 0.15·sourceCredibility`；附 evidence（共享记忆/相似度/时间/来源） | 只输出建议（suggested），必须人工确认；语义相似≠真实关系 |
| **冲突检测** | 关键细节冲突（数字/路径/标识符）+ 矛盾置信度 + 时间；分类 `update`（信息更新）/`contradiction`（真实冲突）/`context`（不同语境） | 绝不自动删改原记忆；不确定→pending_review |
| **知识聚类** | 并查集：余弦 ≥0.72 或共享 ≥2 实体；主题名取簇内 top 实体（非 tag） | 不只用关键词；簇间关系按共享实体 |
| **记忆演化** | 按实体聚合记忆，按时间排事件：created/updated/superseded/invalidated/decision | 保留原始记忆 id 与时间，可追溯 |
| **关系强度** | 强/中/弱/待验证四档；评分是系统评估指标，**不是客观概率** | 展示证据完整度与依据 |
| **智能推理** | 实体图 2-hop（A-B-C，A-C 无直接关系）；confidence=路径乘积×0.8；`inferred=true` | 推断关系单独存 suggested；不写事实记忆；用户确认后才建立关系 |

## 2. 模块架构

```
Memory Data Loader       读取记忆（不在分析中修改任何记忆）
Entity Extractor         复用 cognitive/graph.ts 的规则实体抽取（11 类）
Semantic Analyzer        复用存储的 bge-m3 向量（cosine）
Relationship Detector    实体共现 + 语义相似 → 候选关系 + 证据 + 置信度
Conflict Detector        critical-detail + contradiction + 时间演化分类
Clustering Engine        并查集聚类 + 主题名生成
Evolution Analyzer       实体时间线（新增/更新/替代/失效/决策）
Reasoning Engine         2-hop 路径推理（inferred）
Result Validator         去重/阈值/上限/确定性排序
Graph Writer             仅 confirmed 关系进入事实图；suggested 单独存
```

持久化（`<storeDir>/analysis/`）：
- `relations.jsonl`：关系（含 status/confidence/evidence/analysis_version）
- `conflicts.jsonl`：冲突（含状态与处理结果）
- `state.json`：分析版本、记忆指纹（增量依据）、最近分析时间
- `tasks.jsonl`：任务历史（queued/running/paused/done/failed）
- `events.jsonl`：关系/冲突操作留痕（确认/拒绝/忽略/创建/改类型）
- `snapshot.json`：最近一次聚类/演化/推理快照

## 3. 关系数据模型

```ts
RelationRecord {
  id, sourceEntityId, targetEntityId,
  relationshipType: semantic | entity | temporal | reasoning | manual,
  status: suggested | pending_review | confirmed | rejected | ignored,
  confidenceScore: 0..1,        // 系统评估，不是概率
  strength: strong | medium | weak | unverified,
  evidence: { kind, text, similarity?, sharedEntities?, path?, memoryIds }[],
  sourceMemoryIds: string[],
  inferred: boolean,            // 推断 ≠ 事实
  analysisVersion, createdAt, updatedAt, note?
}
```

- 事实关系（manual/确认后）与推断关系（inferred/suggested）分开；
- 去重：实体对（无序）+ 类型；
- 确认/拒绝/忽略/重开/改类型全部持久化并写事件；
- 分析失败任务保留 status=failed + error，可重新运行（增量会跳过已分析指纹）。

## 4. 增量与性能

- 每条记忆指纹 = `sha256(content)|updatedAt`；增量只对新增/变化记忆相关的候选对计算；
- 未受影响的既有 suggested 关系保留，不重复消耗计算；
- 候选对上限 `maxPairs`（默认 5000），输出上限 relations 500 / conflicts 200 / clusters 100 / paths 100；
- 分析结果按版本记录（analysis_version），可追溯；
- 任务队列：同一时刻只跑一个任务；暂停在阶段边界生效；失败可重跑恢复。

## 5. 页面（五个区域）

- **A 概览**：已分析记忆 / 已建立关系 / 潜在关系 / 待确认冲突 / 知识簇 / 最近分析时间（全部真实数据）。
- **B 控制台**：增量分析、全量分析、暂停、分析历史、范围/实体类型/时间筛选；真实任务状态与进度轮询。
- **C 关系发现中心**：列表 + 证据 + 强度/置信度 + 确认/拒绝/忽略/详情；批量审核。
- **D 冲突中心**：按 new/pending_review/confirmed/resolved/ignored 分类；展示新旧记忆、相似度、矛盾度、摘要与处理入口。
- **E 可视化**：关系网络（confirmed 绿 / suggested 橙 / 推断虚线）、知识聚类、演化时间轴、多跳推理路径（可确认建立关系）。

## 6. 已知限制（如实说明）

- 无 LLM 抽取/实体消指；中文实体主要来自 tags 与拉丁标识符。
- 关系类型目前是规则分类，没有「依赖/导致/属于」等语义关系学习。
- 推理只做 2-hop（最多 3 跳路径查询），不做全图推理。
- 大库分析是单进程同步计算，进度按阶段上报；超大库建议增量运行。
- 冲突「不同语境」判断是启发式，需要人工确认。
