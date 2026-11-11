# 与公开记忆系统的对比

> 快照时间：2026-11-10。信息全部来自各项目公开的 README / 官方文档 / 仓库元数据（链接见每节），
> **未逐项安装复现能力细节**；这些项目迭代很快，以链接里的最新文档为准。
> 本文**不引用也不背书**任何第三方的基准分数（见文末「关于分数」），本项目的数字只来自
> [`docs/benchmark.md`](benchmark.md) 里自己跑出来的结果。

先说结论：**DSH 记忆系统不是同类产品**。左边是"记忆/上下文平台或框架"，我们是跑在
DeepSeek Harness 里的**单机 DSH 插件**。它的竞争力不在"更大的图、更多模态、更强抽取"，
而在**完全离线、零运行时依赖、带强度/生命周期、开箱即用且不离开本机**；短板同样明确：
没有图/多跳、没有 LLM 抽取管线、规模上限是单进程。

## 1. 部署、许可与规模

| 系统 | 形态 / 部署 | 完全离线可跑 | 规模（公开口径） | 许可 |
| --- | --- | --- | --- | --- |
| **DSH 记忆（本项目）** | DSH 插件（单 npm 包 / cordis）；本地 JSONL + 本地 llama.cpp `bge-m3`；零运行时依赖 | ✅ 是（模型下载一次后不再联网） | 单进程内存索引 + 可选 HNSW（本仓库压测到 2 万合成向量量级）；无分布式/多租户，未做大规模生产验证 | MIT |
| **[Mem0](https://github.com/mem0ai/mem0)** | OSS 自托管（自选向量库/LLM，SQL+向量库+实体存储）或官方托管 Platform | ⚠️ OSS 可（需自配模型/向量库；Platform 负责托管） | 面向生产的托管服务；OSS 规模取决于所选向量库 | Apache-2.0 |
| **[Zep / Graphiti](https://github.com/getzep/graphiti)** | Zep 是托管/企业服务；Graphiti 是**自托管框架**，需自带图库（Neo4j/FalkorDB/Neptune）+ LLM + embedder | ⚠️ Graphiti 自托管可，但要运维图数据库 | 企业级（图库水平扩展）；Zep 宣称 sub-200ms/@scale | Apache-2.0（Graphiti） |
| **[Letta](https://github.com/letta-ai/letta)**（原 MemGPT） | 自托管 server（`letta server`）/ Letta Cloud；当前源码在 [`letta-code`](https://github.com/letta-ai/letta-code)，旧 V1 API server 已归档 | ⚠️ server 可自托管，但要有 LLM 后端 | 面向 agent 平台，Postgres 支撑，可多用户 | Apache-2.0 |
| **[Hindsight](https://github.com/vectorize-io/hindsight)** | Docker / pip / Helm / 嵌入式 `hindsight-all` / Cloud；25+ LLM provider（含 ollama/llamacpp，可全本地）；自带开源决策/重排/嵌入模型 | ✅ 设计上支持全本地（含 air-gapped 文档） | 生产级（自述 Fortune 500 在用）；PG/Oracle 存储 | MIT |
| **[Cognee](https://github.com/topoteretes/cognee)** | pip / Docker / Cloud；无 LLM key 时用本地 GLiNER 抽取 + 本地嵌入；1.0 起可整套跑在单个 Postgres 上 | ✅ 文本摄取/检索可完全本地（LLM 增强阶段自动跳过） | 取决于后端；企业部署模板 | Apache-2.0 |
| **[SuperMemory](https://github.com/supermemoryai/supermemory)** | 自托管二进制（Docker/一条命令，lite 许可上限 1 万文档；**服务端源码不开源**）+ 官方托管 | ✅ 自托管可（本地嵌入默认 `bge-base-en`，可接本地 LLM） | 托管版面向大规模；自托管轻量 | MIT（仓库/SDK）；自托管二进制为独立闭源 |
| **[LangMem](https://github.com/langchain-ai/langmem)** | Python 库，不带服务；存储走 LangGraph Long-term Store（内存/Postgres 等） | ✅ 库本身可离线（模型由你配置） | 取决于 LangGraph store | MIT |
| **[LlamaIndex Memory](https://github.com/run-llama/llama_index/blob/main/docs/src/content/docs/framework/module_guides/deploying/agents/memory.mdx)** | 库模块（`Memory` 类），不带服务 | ✅ 库本身可离线（模型/存储由你配置） | 取决于你接的存储/向量库 | MIT |

## 2. 能力维度

| 系统 | 检索策略 | 语义合并 | 冲突处理 | 生命周期 | 谱系 / 来源 | 注入方式 |
| --- | --- | --- | --- | --- | --- | --- |
| **DSH 记忆（本项目）** | **BM25**（字段加权）+ 向量（bge-m3）+ **RRF 融合**（查询变体/本地重排可选），再按**强度排序**（FSRS 保持度×效用×重要度）→ floor/同义合并/MMR | 余弦 ≥0.92 自动合并为**新版本**（`supersedes`+generation，旧记录保留可查）；检索期 0.85 同义合并 | 余弦 0.75–0.92 或关键细节冲突 → 打 `conflictWith` 标记 + **0.40 起自动裁决**（矛盾度/证据计数/来源可信度/时间 → 失效旧事实/合并/保留），面板冲突中心可复核 | **较强**：FSRS 强度/保持度、休眠、软删 tombstone 30 天可恢复、TTL 过期、周期巩固、**0–100 健康度 + 本地备份/恢复** | `supersedes` 链 + generation + 面板历史 + 审计事件；无 Graphiti 式 episode 全量溯源 | DSH 原生**自动召回注入**（token 预算默认 1200）+ 六个模型工具 + 管理面板 + **可疑写入隔离**；**智能关系分析**（证据/审核）+ 知识图谱文件视图/画布（graph.json 落盘） |
| **Mem0** | 语义 + 关键词 + 实体加权（Platform 还有图记忆与时间信号；**OSS 无图记忆**）；可选重排 | LLM 抽取 → 去重 + 嵌入 + 实体链接；新版算法是 **ADD-only**，不静默改写旧事实（要显式 update/delete） | 靠显式 update/delete 与 `expiration_date`；不自动裁决冲突 | 记忆过期（`expiration_date`）、删除；无强度/衰减模型 | 每条记忆的历史记录 + 元数据；Platform 侧更强 | 应用在调模型前 `search` 后自行拼 prompt；官方也有集成/MCP |
| **Zep / Graphiti** | **混合检索：语义 + BM25 + 图遍历**，增量更新、精确历史查询 | 实体/关系去重与合并；无 LLM 摘要是其卖点 | **最强项**：双时间轴（bi-temporal）事实有效期，新事实**自动失效**旧事实、旧事实不删 | 事实有效期天然覆盖"现在/曾经"；图与 episode 持续演化 | **最强项**：一切派生事实可溯源到原始 episode | 框架不自带注入，需自己把检索结果拼进 prompt |
| **Letta** | **核心记忆块**（常驻上下文，agent 可编辑，按字符配额）+ recall memory（完整对话史，可检索）+ archival memory（外部向量/图库，工具检索） | 由 agent / sleep-time agent 自主重写记忆块；没有强制的自动语义合并 | 由 agent 决策（可编写专门的 sleep-time 规则） | 消息缓冲驱逐 + 递归摘要 + 记忆块重写；无内建 FSRS 式衰减 | 对话历史即来源；归档条目无强 provenance | **核心记忆块常驻上下文** + 工具检索归档；LLM 包装/平台注入 |
| **Hindsight** | **并行 4 路：语义 + BM25 + 图 + 时间**，RRF 融合 + cross-encoder 重排，按 token 预算裁剪 | 后台把事实**巩固为 observations**：去重、保留证据引文与 proof count，新证据"精炼"而非覆盖 | 观测随证据增强/削弱；时间与实体关系参与召回；另有 decision model 做"是否/如何更新"判断 | observations / mental models / pages 持续演化；bank 级隔离与 disposition | 证据引文 + proof count（较强） | LLM wrapper（2 行代码）/ MCP / 各类集成；也可纯 API 调用 |
| **Cognee** | **知识图谱 + 向量 + 文本块**联合检索；管线（remember/cognify）构图；session distillation 沉淀长期记忆 | 图实体/关系消解由管线完成；无 LLM 时走本地 GLiNER | 不是 README 的一等能力，主要靠图谱重建/更新管线（细节需看文档） | 未见独立的衰减/休眠/软删模型；以图谱与数据集生命周期为主 | 图谱结构即来源，但溯源粒度弱于 Graphiti | 插件 / MCP / REST API；需自己拼 prompt |
| **SuperMemory** | **混合语义检索 + 图引擎**；RAG（文档）与 Memory（用户画像）合一；用户画像 ~50ms | 自动抽取事实、维护用户画像、处理知识更新 | README 明确宣称处理 contradictions（具体算法未公开） | 宣称自动遗忘过期信息；细节未公开 | 文档/来源可追溯；闭源实现不透明 | SDK / 插件 / MCP / Connectors；托管为主 |
| **LangMem** | 委托给 LangGraph Store 的向量检索；提供 hot-path 记忆工具与后台 memory manager | 后台 manager 做抽取、整合、更新（依赖 LLM） | 由"整合/更新"prompt 处理，无独立冲突模型 | 无内建衰减/软删；由你的 store 策略决定 | 无内建谱系 | 工具调用（agent 主动存/取）+ hot-path 预注入 prompt |
| **LlamaIndex Memory** | 短期 FIFO 缓冲（token 上限）+ 长期 Memory Block（Static / FactExtraction / VectorMemoryBlock）联合注入 | `FactExtractionMemoryBlock` 可抽取/合并事实；`VectorMemoryBlock` 只存不合并 | 无内建冲突处理 | 按 token 比例把旧消息 flush 到长期块；无衰减/软删模型 | 无内建谱系 | 记忆块合并进 system/user message（`priority` 排序） |

## 3. 逐个说人话（优势 / 短板）

### Mem0（最像"记忆层 API"的一家）
- 优势：接入成本最低、生态最广；OSS 与 Platform API 基本一致；新算法的 ADD-only 抽取对"旧事实不被静默改写"友好；有记忆过期与历史记录。
- 短板（对我们而言）：OSS **没有图记忆**（图是 Platform 能力），冲突/更新依赖显式调用或 LLM 判断；离线部署要自己解决向量库+模型；不是 DSH 插件，没有自动召回注入这一层。
- 来源：[repo](https://github.com/mem0ai/mem0)、[How Mem0 works](https://docs.mem0.ai/core-concepts/how-it-works)、[Platform vs OSS](https://docs.mem0.ai/platform/platform-vs-oss)。

### Zep / Graphiti（时间图谱的天花板）
- 优势：**双时间轴 + episode 溯源 + 混合检索**是同类里做得最完整的；旧事实自动失效但历史保留；增量构图，适合"事实一直在变"的领域。
- 短板：Graphiti 是**框架**不是产品——图库、LLM、embedder、服务层全要自己搭；Zep 托管/企业版不便宜；社区版（Zep Community Edition）已停止支持，开源重心转向 Graphiti（[官方公告](https://www.getzep.com/blog/announcing-a-new-direction-for-zeps-open-source-strategy/)）。
- 来源：[repo](https://github.com/getzep/graphiti)、[论文 arXiv:2501.13956](https://arxiv.org/abs/2501.13956)。

### Letta（agent 自管理记忆的路线）
- 优势：把"记忆"做成 **agent 可自我编辑的上下文结构**（核心记忆块 + recall + archival），sleep-time agent 异步整理；对"agent 应该有主观记忆"的场景最贴。
- 短板：记忆质量强依赖 agent/模型行为，没有强一致的合并/冲突规则；持久化与多用户要跑 server；对"个人本地记忆库"偏重。
- 来源：[repo](https://github.com/letta-ai/letta)、[Agent Memory 长文](https://www.letta.com/blog/agent-memory/)。

### Hindsight（当前公开叙事里最激进的"记忆会学习"）
- 优势：**4 路并行召回 + RRF + cross-encoder 重排**；observations 把事实巩固成带证据的信念而非覆盖；自带开源决策/重排/嵌入模型，可全本地；工程化程度高（Docker/Helm/嵌入式/Cloud）。
- 短板：系统复杂度高（Postgres/Oracle、后台任务、模型全家桶）；全新项目，长期稳定性待观察；其基准是厂商自述 + 部分第三方复现，**我们不背书**。
- 来源：[repo](https://github.com/vectorize-io/hindsight)、[文档](https://hindsight.vectorize.io)、[论文 arXiv:2512.12818](https://arxiv.org/abs/2512.12818)。

### Cognee（"本地小模型 + 图谱"的实用派）
- 优势：**无 LLM key 也能建图**（GLiNER + 本地嵌入），对隐私/离线场景友好；1.0 起可整套跑在单个 Postgres；管线化（remember/cognify）。
- 短板：冲突/生命周期不是一等能力（要靠图谱更新管线）；本地小模型的抽取质量有限；注入层要自己接。
- 来源：[repo](https://github.com/topoteretes/cognee)、[文档](https://docs.cognee.ai)、[论文 arXiv:2505.24478](https://arxiv.org/abs/2505.24478)。

### SuperMemory（产品化最完整的"记忆 API"）
- 优势：RAG + Memory 合一、用户画像快（~50ms）、插件/MCP/Connectors 齐全；自托管一条命令起（lite 1 万文档）。
- 短板：**自托管服务端二进制闭源**（仓库是 SDK/应用层，MIT），核心算法不可审计；声称的 contradiction/forgetting 细节不公开；托管是主要商业化路径。
- 来源：[repo](https://github.com/supermemoryai/supermemory)、[Self-hosting 文档](https://supermemory.ai/docs/self-hosting/overview)。

### LangMem（最"轻"的记忆原语）
- 优势：不绑定存储，任何 LangGraph store 都能用；记忆工具 + 后台 manager + prompt 优化三件套清晰；适合已有 LangGraph 技术栈。
- 短板：只提供原语，合并/冲突/生命周期都要自己写；没有服务化、没有注入层。
- 来源：[repo](https://github.com/langchain-ai/langmem)、[文档](https://langchain-ai.github.io/langmem/)。

### LlamaIndex Memory（框架内建的那块）
- 优势：`Memory` 类把短期缓冲与长期块组合得很干净（Static/FactExtraction/Vector），token 预算与 flush 策略可配；对已用 LlamaIndex 的 agent 零额外系统。
- 短板：记忆只是 agent 模块的一部分，无独立存储/服务/生命周期；冲突与谱系基本没有。
- 来源：[repo](https://github.com/run-llama/llama_index)、[Memory 文档](https://github.com/run-llama/llama_index/blob/main/docs/src/content/docs/framework/module_guides/deploying/agents/memory.mdx)。

## 4. 我们（DSH 记忆）的真实位置

**强项（有实测/有代码支撑）**
1. **完全离线 + 零运行时依赖**：`bge-m3` 走本地 llama.cpp，存储是 JSONL，不需要 Postgres/图库/向量库/API key。
   表格里"完全离线可跑"打 ✅ 的只有我们、Hindsight、Cognee、SuperMemory（后两者要装 Docker/二进制，SuperMemory 服务端还闭源）。
2. **强度 + 生命周期是内建的一等能力**：FSRS 保持度、休眠、软删可恢复、TTL、周期巩固——大多数对手只做"存/查/覆盖"，不做"遗忘曲线"。
3. **DSH 原生注入**：自动召回 + token 预算 + 面板/工具，用户零接线；对手都要你自己在应用层拼 prompt 或接 SDK。
4. **合并保留历史**：`supersedes` + generation，旧版本不物理删除，检索侧隐藏、面板可查。
5. **开源许可干净**：MIT，无"开源壳 + 闭源核心"的拆分（这点比 SuperMemory 的自托管形态更透明）。

**短板（必须直说）**
1. **没有图/实体/关系检索**：拿不到 Graphiti/Hindsight 的多跳与实体推理能力；查询只有"单跳相似度"。
2. **没有 LLM 抽取管线**：记忆靠模型工具显式写入，不会从对话里自动抽取事实（Mem0/Hindsight/Cognee 都有）。
3. **规模是单进程**：JSONL + 内存索引 + 可选 HNSW，量级约 10^4；没有分布式、多租户、水平扩展——不是"平台"。
4. **谱系薄弱**：只有 supersedes 链与审计事件，没有 episode 级全量溯源。
5. **评测覆盖有限**：合成集 94 条 + LoCoMo 单会话子集，尚无 LongMemEval/真实用户日志；benchmark 里 LoCoMo 的绝对分数很低（阈值不适配对话轮次），**不能**拿它跟任何公开分数比。
6. **没有托管服务与生态**：插件/MCP/连接器生态远不如 Mem0/SuperMemory/Hindsight。

**一句话**：如果需求是"在一台设备上、完全离线、给 DSH agent 一个带遗忘曲线和冲突标记的个人记忆库"，
我们的形态更贴；如果需求是"企业级、跨数据源、多跳推理、托管 API"，上面多数项目比我们成熟得多。

## 5. 关于分数（不背书声明）

- 本项目使用的所有数字来自 [`docs/benchmark.md`](benchmark.md)，由 `tools/eval/run.mjs` 在本机跑出，可复现。
- 各项目 README/官网中常见的公开宣称包括：Mem0 新算法在 LoCoMo / LongMemEval 上的高分（且明确说明部分来自托管平台的专有优化，OSS 只"方向一致"）、
  SuperMemory 声称在 LongMemEval/LoCoMo/ConvoMem 上第一、Hindsight 声称 LongMemEval SOTA（部分由第三方复现）。
  **这些分数我们没有复现、无法验证，也不背书**；它们大多是不同的模型栈、不同的 top-k/答案生成口径下的厂商自述。
- 本项目的基准也不是 LoCoMo 官方口径：它是"合成记忆集 + 证据级单会话检索"，用来做**内部相对比较**，
  不用于与任何外部系统排名。

## 6. 参考链接汇总

| 项目 | 主要来源 |
| --- | --- |
| Mem0 | https://github.com/mem0ai/mem0 · https://docs.mem0.ai/core-concepts/how-it-works · https://docs.mem0.ai/platform/platform-vs-oss |
| Zep / Graphiti | https://github.com/getzep/graphiti · https://arxiv.org/abs/2501.13956 · https://www.getzep.com/blog/announcing-a-new-direction-for-zeps-open-source-strategy/ |
| Letta | https://github.com/letta-ai/letta · https://github.com/letta-ai/letta-code · https://www.letta.com/blog/agent-memory/ |
| Hindsight | https://github.com/vectorize-io/hindsight · https://hindsight.vectorize.io · https://arxiv.org/abs/2512.12818 |
| Cognee | https://github.com/topoteretes/cognee · https://docs.cognee.ai · https://arxiv.org/abs/2505.24478 |
| SuperMemory | https://github.com/supermemoryai/supermemory · https://supermemory.ai/docs/self-hosting/overview |
| LangMem | https://github.com/langchain-ai/langmem · https://langchain-ai.github.io/langmem/ |
| LlamaIndex Memory | https://github.com/run-llama/llama_index · https://github.com/run-llama/llama_index/blob/main/docs/src/content/docs/framework/module_guides/deploying/agents/memory.mdx |
| 本项目 | [docs/architecture.md](architecture.md) · [docs/benchmark.md](benchmark.md) · [tools/eval/](../tools/eval/) |
