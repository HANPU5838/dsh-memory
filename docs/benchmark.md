# 检索质量基准（离线 · 可复现）

> 结论先行：在 94 条合成记忆 / 48 条查询上，**强度排序（strengthRanking）是影响最大的单开关**
> （recall@5 0.7708 → 0.9167，+0.1459）；MMR 小幅正收益（+0.0209）；同义合并主要提升
> 纯度（+0.0208）；**floor 0.2 在实际分数域里是空操作**（向量通道 `minScore=0.5` 已先过滤）。
> BM25+RRF（工作树 0.40-P0 WIP）在默认配置下 recall 持平、nDCG +0.0069，在 strength 关闭时
> 反而掉点。所有数字来自本机实际运行，报告文件见 `tools/eval/out/eval-<时间>.json` / `.md`。

本文件是 `tools/eval/run.mjs` 的说明 + 实测结果存档。它不是性能基准（那是
[`tools/bench/`](../tools/bench/README.md)），回答的是**检索质量**问题：几个可调开关到底让结果变好还是变坏。

---

## 1. 评测器怎么工作

`tools/eval/run.mjs` 是一个**零依赖离线评测器**：纯 Node 脚本，直接 `import` 项目源码里的
TypeScript 纯函数（Node ≥ 23.6 的类型剥离能力；更老版本加 `--experimental-strip-types`）。

它复刻 `memory_search` 的检索路径（逐段对照 `source/memory-local/src/index.ts` 的 search 流程）：

| 阶段 | 复刻方式 | 源码 |
| --- | --- | --- |
| ① 词法通道 | `tokenize` + `lexicalScore`（正文+标签，IDF 加权），门槛 = 查询长度自适应阈值（project 0.1 / global 0.12），弱命中须过 `REAL_HIT_FLOOR=0.25` | `scoring.ts`、`retrieval/adapt.ts` |
| ② 向量通道 | 余弦 ≥ `vector.minScore=0.5` 才进候选 | `scoring.ts` |
| ③ 双通道融合 | 按查询画像（代码/数字 vs 自然语言）动态权重 `blendHybrid` | `retrieval/expand.ts` |
| ④ 排序 | 强度排序 `explainCandidate`（相关度 × 保持度 × 效用 × 重要度），关闭时回退 `recordScore`；时间有效性 `temporalBoost` | `retrieval/rank.ts`、`retrieval/retention.ts`、`cognitive/temporal.ts` |
| ⑤ 整形 | 地板分 → 同义合并（余弦 0.85）→ MMR（λ=0.7），最后截到 `topK=5` | `scoring.ts` |
| ⑥ 指标 | recall@k / MRR@k / nDCG@k，**直接复用产品里的评测函数** | `retrieval/eval.ts` |

未复刻的部分（对结论有影响，已在报告「局限」里写明）：storage 层的可见性过滤
（休眠/墓碑/过期/失效记录）、LLM 重排、Rocchio 查询扩展、ANN 索引。它们在产品默认配置里
要么关闭，要么与召回口径无关（ANN 只是性能优化）。

词法通道还有一个**可选对照**：工作树里正在开发的 BM25 + RRF（0.40.0-P0，`retrieval/bm25.ts`
+ `retrieval/fusion.ts`）。评测器会探测这两个模块，存在就多跑一组 `fusion` 矩阵：
BM25 补召回（只靠词法阈值进不来的记录给中等相关度 0.5）+ RRF 排序加成
（`1 + 0.1·bonus`，不覆盖相关度）——与工作树 `index.ts` 的实现逐行对齐。

## 2. 数据集构造

### 2.1 合成记忆集（`synthetic-v1`）

固定 seed（默认 42）+ 固定基准时间（2026-11-01T00:00:00Z），**同一 seed 在任何机器上都得到同一份语料**
（seed 只控制时间戳/重要度的小幅抖动与记录顺序，不改变语义标注）。

12 个主题（部署/数据库/嵌入/缓存/测试/设备/检索/记忆/网络/安全/面板/构建），每个主题 7 条记忆 + 10 条跨主题噪声，共 **94 条**：

| 槽位 | 内容 | 作用 |
| --- | --- | --- |
| `a-zh` | 主题知识的中文陈述 | 同义改写/跨语言查询的目标 |
| `a-en` | **同一条知识的英文陈述** | 跨语言查询的目标 |
| `a-alt` | 中文同义改写（措辞不同） | 同义合并（dedupe）的合并对象 |
| `b-old` | 同一配置的**旧值**（措辞与新值几乎一样，历史取用次数多） | 时序/冲突查询的陷阱 |
| `b-new` | 同一配置的**新值**（近期更新、重要度更高） | 时序/冲突查询的目标 |
| `n1`/`n2` | 主题内噪声（相关但不回答问题） | 考验 floor/MMR 的噪声剔除 |
| 跨主题噪声 ×10 | 同时提到多个主题关键词的记录 | 考验弱命中过滤 |

四类查询，每主题各 1 条，共 **48 条**：

| 类型 | 数量 | 构造 | 标注（group） |
| --- | --- | --- | --- |
| `paraphrase` 同义改写 | 12 | 中文复述 `a-zh` 的事实，刻意换掉大部分措辞 | `<topic>.a` |
| `cross-lingual` 跨语言 | 12 | **英文**问同一条知识 | `<topic>.a` |
| `temporal` 时序 | 12 | 中文问"现在"的配置值 | `<topic>.b`（新值） |
| `conflict-noise` 冲突+噪声 | 12 | 中文"到底是旧值还是新值？" | `<topic>.b`（新值；旧值单独 group，排上去会掉分） |

**标注是 group 级而不是 id 级**：`a-zh`/`a-en`/`a-alt` 是同一条知识的三种写法，命中任意一条就算
召回（否则 semanticDedupe 合并重复条目会"误扣"recall）。旧值 `b-old` 属于独立 group，不计入相关。

### 2.2 公开集：LoCoMo 子集（可选）

`loadLocomo()` 会尝试从 GitHub 拉取 [LoCoMo](https://github.com/snap-research/locomo)（`data/locomo10.json`，
约 2.8MB，缓存到 `tools/eval/out/public/`；下载失败自动跳过并在报告注明「未接入」）。

- 取第 0 个 conversation（sample=conv-26，19 个 session，**419 条对话轮次**）；
- 每条轮次 `speaker: text` 当一条记忆（无重要性/强度字段，统一 0.5）；
- 问题取非 adversarial（category≠5）且 evidence dia_id 可定位的，最多 **120 条**；
- 标注 = evidence dia_id 列表（group 即记录 id）；
- 检索库只有这 419 条轮次——这是**单会话对话检索**，不是 LoCoMo 官方 QA 准确率口径，
  **不能**与任何公开发表的 LoCoMo 分数直接比较。

## 3. 指标定义

| 指标 | 定义 |
| --- | --- |
| `recall@k` | 前 k 条里命中的相关 group 数 / 全部相关 group 数（`retrieval/eval.ts`） |
| `MRR@k` | 第一个相关结果名次的倒数（k 内），无命中为 0 |
| `nDCG@k` | 二元相关的 `(2^rel−1)/log2(rank+1)` 归一化（`retrieval/eval.ts`） |
| `purity` | 返回条目中属于相关 group 的比例（1 = 没有噪声混进来） |
| `噪声条/查询` | 平均每条查询混进多少条非相关记录 |
| `空槽/查询` | 平均每条查询空出多少个 topK 名额（floor 砍掉后不补位） |

## 4. 实测结果

**运行快照**（2026-11-10，本机 Termux aarch64 · Node v26.13.0 · git HEAD `8ae94a1`）：

- 嵌入：真实 **bge-m3 1024 维**（`http://127.0.0.1:8078/v1/embeddings`，命中本地缓存）
- 评测深度 k=5；16 组开关矩阵（strengthRanking / MMR / dedupe / floor 全因子）
- 词法通道：classic（0.35 已提交路径，主表）+ fusion（工作树 0.40-P0 WIP，对照表）
- 工作树当时还有其他工程师未提交的改动（22 个文件），`index.ts`/`bm25.ts`/`fusion.ts` 的 hash 都记录在 JSON 里

### 4.1 主矩阵（合成集 · classic 词法）

| 配置 | S | M | D | F | recall@5 | MRR@5 | nDCG@5 | purity | 噪声条/查询 | 空槽/查询 | 返回条数 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| base | off | off | off | 0 | 0.7708 | 0.6094 | 0.6502 | 0.1917 | 4.042 | 0.000 | 5.00 |
| +strength | on | off | off | 0 | **0.9167** | **0.7483** | **0.7912** | 0.2583 | 3.708 | 0.000 | 5.00 |
| +mmr | off | on | off | 0 | 0.7917 | 0.6146 | 0.6592 | 0.1875 | 4.063 | 0.000 | 5.00 |
| +dedupe | off | off | on | 0 | 0.7708 | 0.6094 | 0.6502 | 0.2125 | 3.938 | 0.000 | 5.00 |
| +floor | off | off | off | 0.2 | 0.7708 | 0.6094 | 0.6502 | 0.1917 | 4.042 | 0.000 | 5.00 |
| strength+mmr | on | on | off | 0 | 0.9167 | 0.7483 | 0.7912 | 0.2417 | 3.792 | 0.000 | 5.00 |
| strength+dedupe | on | off | on | 0 | 0.9167 | 0.7483 | 0.7912 | 0.2542 | 3.729 | 0.000 | 5.00 |
| strength+floor | on | off | off | 0.2 | 0.9167 | 0.7483 | 0.7912 | 0.2583 | 3.708 | 0.000 | 5.00 |
| mmr+dedupe | off | on | on | 0 | 0.7917 | 0.6146 | 0.6592 | 0.1917 | 4.042 | 0.000 | 5.00 |
| mmr+floor | off | on | off | 0.2 | 0.7917 | 0.6146 | 0.6592 | 0.1875 | 4.063 | 0.000 | 5.00 |
| dedupe+floor | off | off | on | 0.2 | 0.7708 | 0.6094 | 0.6502 | 0.2125 | 3.938 | 0.000 | 5.00 |
| strength+mmr+dedupe | on | on | on | 0 | 0.9167 | 0.7483 | 0.7912 | 0.2417 | 3.792 | 0.000 | 5.00 |
| strength+mmr+floor | on | on | off | 0.2 | 0.9167 | 0.7483 | 0.7912 | 0.2417 | 3.792 | 0.000 | 5.00 |
| strength+dedupe+floor | on | off | on | 0.2 | 0.9167 | 0.7483 | 0.7912 | 0.2542 | 3.729 | 0.000 | 5.00 |
| mmr+dedupe+floor | off | on | on | 0.2 | 0.7917 | 0.6146 | 0.6592 | 0.1917 | 4.042 | 0.000 | 5.00 |
| all (product default) | on | on | on | 0.2 | 0.9167 | 0.7483 | 0.7912 | 0.2417 | 3.792 | 0.000 | 5.00 |

（S=strengthRanking，M=MMR，D=dedupe，F=floor；粗体是单开关里最好的组合。）

### 4.2 词法通道对照：classic vs BM25+RRF（WIP）

| 配置 | classic recall@5 | fusion recall@5 | classic nDCG@5 | fusion nDCG@5 | classic purity | fusion purity |
| --- | --- | --- | --- | --- | --- | --- |
| base | 0.7708 | 0.7292 | 0.6502 | 0.6055 | 0.1917 | 0.1625 |
| +strength | 0.9167 | 0.9167 | 0.7912 | 0.7981 | 0.2583 | 0.2375 |
| +mmr | 0.7917 | 0.7083 | 0.6592 | 0.5965 | 0.1875 | 0.1542 |
| +dedupe | 0.7708 | 0.7292 | 0.6502 | 0.6055 | 0.2125 | 0.1667 |
| +floor | 0.7708 | 0.7292 | 0.6502 | 0.6055 | 0.1917 | 0.1625 |
| strength+mmr | 0.9167 | 0.9167 | 0.7912 | 0.7981 | 0.2417 | 0.2167 |
| strength+dedupe | 0.9167 | 0.9167 | 0.7912 | 0.7981 | 0.2542 | 0.2375 |
| strength+floor | 0.9167 | 0.9167 | 0.7912 | 0.7981 | 0.2583 | 0.2375 |
| mmr+dedupe | 0.7917 | 0.7083 | 0.6592 | 0.5965 | 0.1917 | 0.1542 |
| mmr+floor | 0.7917 | 0.7083 | 0.6592 | 0.5965 | 0.1875 | 0.1542 |
| dedupe+floor | 0.7708 | 0.7292 | 0.6502 | 0.6055 | 0.2125 | 0.1667 |
| strength+mmr+dedupe | 0.9167 | 0.9167 | 0.7912 | 0.7981 | 0.2417 | 0.2167 |
| strength+mmr+floor | 0.9167 | 0.9167 | 0.7912 | 0.7981 | 0.2417 | 0.2167 |
| strength+dedupe+floor | 0.9167 | 0.9167 | 0.7912 | 0.7981 | 0.2542 | 0.2375 |
| mmr+dedupe+floor | 0.7917 | 0.7083 | 0.6592 | 0.5965 | 0.1917 | 0.1542 |
| all (product default) | 0.9167 | 0.9167 | 0.7912 | 0.7981 | 0.2417 | 0.2167 |

产品默认下：recall@5 0.9167 → 0.9167（+0.0000），nDCG@5 0.7912 → 0.7981（+0.0069），
purity 0.2417 → 0.2167（−0.0250）。**strength 关闭时 fusion 掉点明显**（0.7708 → 0.7292）：
BM25 补回来的记录统一拿 0.5 相关度，会盖过只过了词法门槛、分数更低的真命中；强度排序把
保持度/重要度算进来之后差距被抹平。

### 4.3 分查询类型（产品默认 · 两种词法）

| 查询类型 | classic recall@5 | classic MRR@5 | classic nDCG@5 | classic purity | fusion recall@5 | fusion MRR@5 | fusion nDCG@5 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| paraphrase | 0.7500 | 0.5486 | 0.5994 | 0.2333 | 0.7500 | 0.5556 | 0.6052 |
| cross-lingual | 0.9167 | 0.7361 | 0.7827 | 0.3333 | 0.9167 | 0.6944 | 0.7520 |
| temporal | 1.0000 | 0.9028 | 0.9276 | 0.2000 | 1.0000 | 0.9583 | 0.9692 |
| conflict-noise | 1.0000 | 0.8056 | 0.8552 | 0.2000 | 1.0000 | 0.8194 | 0.8661 |

基线 → 产品默认的分类型变化（classic）：

| 查询类型 | 基线 recall@5 | 产品默认 recall@5 | 基线 nDCG@5 | 产品默认 nDCG@5 | 基线噪声条 | 产品默认噪声条 |
| --- | --- | --- | --- | --- | --- | --- |
| paraphrase | 0.3333 | 0.7500 | 0.1660 | 0.5994 | 4.500 | 3.833 |
| cross-lingual | 0.7500 | 0.9167 | 0.4962 | 0.7827 | 3.667 | 3.333 |
| temporal | 1.0000 | 1.0000 | 1.0000 | 0.9276 | 4.000 | 4.000 |
| conflict-noise | 1.0000 | 1.0000 | 0.9385 | 0.8552 | 4.000 | 4.000 |

注意 temporal / conflict-noise 两类基线 recall 已是 1.0（语料里新值的词法/向量信号本来就强），
但产品默认的 nDCG/MRR 反而略低——排序里混进了高相似噪声，说明这两类还有优化空间。

### 4.4 LoCoMo 子集（公开集，单会话检索）

419 条对话轮次 / 120 条问题（temporal 37、open-domain 11、multi-hop 31、single-hop 41），
bge-m3 嵌入，classic 词法，16 组矩阵（此处只摘产品默认与两个关键行）：

| 配置 | recall@5 | MRR@5 | nDCG@5 | purity | 噪声条/查询 |
| --- | --- | --- | --- | --- | --- |
| base | 0.0250 | 0.0142 | 0.0160 | 0.0067 | 4.967 |
| +strength | 0.0875 | 0.0404 | 0.0505 | 0.0200 | 4.900 |
| strength+dedupe | 0.1125 | 0.0461 | 0.0607 | 0.0250 | 4.875 |
| all (product default) | 0.1042 | 0.0486 | 0.0597 | 0.0233 | 4.883 |

fusion 词法在产品默认下：recall@5 0.1042 → **0.1208**，nDCG@5 0.0597 → **0.0736**。

按问题类别（产品默认 · classic）：temporal 0.1622 / open-domain 0.0455 / multi-hop 0.0323 /
single-hop 0.1220（recall@5）。

**怎么读**：绝对值很低（10% 量级）不是"系统完全不能用"，而是**产品默认阈值不适配对话轮次**：
`vector.minScore=0.5` 是给"完整记忆句子"调的，LoCoMo 的短对话轮次与问题余弦大多低于 0.5，
向量通道几乎不产生候选，只剩很弱的词法候选；同时 5 条名额里大部分是语料内的近邻噪声。
公开集在这里的价值是**相对比较**（哪种词法通道更好、哪个开关有收益），不是绝对分数。

## 5. 本次结论（可复用的口径）

1. **strengthRanking 是最大收益项**：+0.1459 recall@5 / +0.1410 nDCG@5（单开关里唯一的大幅提升），
   paraphrase 从 0.3333 → 0.7500。它应该保持默认开启。
2. **floor 0.2 实测无效**：向量通道 `minScore=0.5` 已经先过滤，floor 作用在 `recallScore` 上时
   没有任何低于 0.2 的条目可砍（单独开 floor 的所有指标与基线逐位相同）。要么把 floor 提到
   0.5 以上（但那会和向量门槛重复），要么承认它在有向量的库里是装饰性参数。
3. **MMR 小幅正收益**（recall +0.0209，nDCG +0.0090），但会拉低 purity（−0.0042）；
   在 LoCoMo 上 strength+mmr 反而不如 strength+dedupe。不是万能开关。
4. **dedupe 不改变 recall（group 级标注下符合预期），把 purity 从 0.1917 提到 0.2125**，
   在 LoCoMo 上 strength+dedupe 是本轮最好的组合（0.1125 / nDCG 0.0607）。
5. **产品默认与单开 strength 打平**：nDCG@5 都是 0.7912、recall@5 都是 0.9167，但默认还多开了
   MMR+dedupe+floor，purity 反而从 0.2583 降到 0.2417、噪声条从 3.708 升到 3.792。
   也就是说这三个整形开关在本轮语料上没有带来召回/排序收益，只是在"多样性/去重"上有轻微取舍
   ——这与 0.32 引入它们时的调参场景（真实库里同义冗余更多）可能不同，值得在真实库上复测。
6. **BM25+RRF（WIP）方向正确但需要调**：默认配置下 nDCG 略升、recall 持平、purity 略降；
   strength 关闭时掉点（0.7708 → 0.7292），说明"BM25 补回来的记录固定 0.5 相关度"在
   缺少强度排序时副作用明显。合并前建议加一个"BM25-only 候选的相关度衰减"。

## 6. 复现

```bash
# 1) 默认：自动探测 127.0.0.1:8078 的 bge-m3，跑合成集 + LoCoMo 子集（含 BM25/RRF 对照）
node tools/eval/run.mjs

# 2) 没有嵌入服务也能跑（合成向量，只适合冒烟，不具语义意义）
node tools/eval/run.mjs --mode synthetic

# 3) 不联网 / 不跑公开集，只跑合成集
node tools/eval/run.mjs --no-public

# 4) 只跑经典词法（关掉 BM25/RRF 对照）
node tools/eval/run.mjs --lexical classic

# 5) 换 seed / 换评测深度 / 换后端
node tools/eval/run.mjs --seed 7 --k 10 --endpoint http://127.0.0.1:8078/v1/embeddings
```

- 结果写到 `tools/eval/out/eval-<时间>.json` + `.md`（`out/` 已 gitignore），stdout 打印同样的 Markdown；
  同时写一份 `latest.json` / `latest.md`。
- **嵌入缓存**：`tools/eval/out/cache/emb-<hash>.json`，同一份文本 + 同一个模型只付一次嵌入成本。
  本机首次全量（合成 + LoCoMo）约 5~6 分钟；命中缓存后一次全矩阵约 **15 秒**。
- 退出码恒为 0：嵌入服务不可用会自动降级到合成向量并注明，公开集下载失败标记「未接入」，
  不会把 CI 搞红（失败原因在 JSON/日志里）。

## 7. 局限与未接入

- **合成集是"记忆检索"的同构近似**，不是真实用户查询分布；查询与标注由我们构造，
  对"同义改写/跨语言/时序/冲突"四类的覆盖是设计出来的，不能替代真实用户日志。
- 语料只有 94 条、单 scope（project），**不覆盖多 scope 合并排序、跨用户隔离、ANN 召回**。
- group 级标注让 dedupe 不会因合并重复而扣 recall，但也意味着"同一条知识的多份记忆"
  在 recall 上不区分——这与产品"合并重复即正确"的语义一致，但与经典 IR 口径不同。
- **LoCoMo 子集不是官方评测**：单会话、证据级标注、没有 LLM 生成答案、没有时间/多跳推理评分，
  绝对值不可与论文/厂商分数比较；仅作相对对照。
- 未接入 LongMemEval：其数据以 parquet 分发，需要 HF datasets 或额外依赖，与"零依赖离线"目标冲突；
  本次只接入了 LoCoMo（`data/locomo10.json` 是 JSON，可直接解析）。
- fusion 矩阵复刻的是**工作树未提交的 0.40-P0 WIP**（`index.ts` 的 BM25 补召回 + RRF 加成，
  以及 `retrieval/bm25.ts`、`retrieval/fusion.ts`）。它们合并后需要重跑对照；
  评测器会在下一次运行时自动探测模块是否可用，并把相关文件的 hash 记进 JSON。
- 我们**只报自己跑出来的数字**；不引用、不背书任何其他项目的公开分数。

## 8. 建议怎么接进 CI

1. **每次 PR 的快速门禁**（不需要嵌入服务，约 2 秒）：
   `node tools/eval/run.mjs --mode synthetic --no-public --quiet`，断言退出码 0 且
   `latest.json` 里 `matrix.matrices.classic.configs[0].overall.recallAtK` 不低于基线 −0.01。
   合成向量的绝对分数没有语义意义，但**同一份语料 + 同一套代码的回归**是可比的。
2. **有嵌入服务的自托管 CI 或 nightly**：
   `node tools/eval/run.mjs --no-public`（bge-m3 可用时约 1 分钟，命中缓存约 15 秒），
   把 `latest.json` 存档为构建产物；对 `base` / `+strength` / `all (product default)` 三行的
   recall@5、nDCG@5 设阈值。
3. **参数改动（floor/dedupe/mmr/lambda）必须先跑评测再合并**：本文件 4.1 的矩阵就是为此存在的；
   建议在 PR 模板里要求贴 `latest.md` 的关键三行。
4. 阈值建议（本机实测，供起步用）：合成集 `base` recall@5 ≥ 0.74、`+strength` ≥ 0.89、
   product default 的 nDCG@5 ≥ 0.76。数字随语料/嵌入式模型升版会漂，**漂了就重新定基线，别硬调**。

## 0.40.0 最终产品口径（本仓库）

评测器里的「fusion」列是**工作树 WIP 的近似复刻**（会补回 BM25-only 候选）；0.40.0 产品默认已经调整：

- `retrieval.fusion.addCandidates` 默认 **false**：BM25/RRF **只给已有候选做 ≤10% 的排序加成**，
  不注入「仅 BM25 命中」的新候选（实测后者会在强度排序关闭时用低相关度挤掉真命中，recall -0.04）。
- 因此产品默认行为 ≈「经典召回 + 强度排序」，RRF 只带来排序层面的小幅收益；
  需要补召回时显式打开 `retrieval.fusion.addCandidates: true`，并用本评测器做 A/B。

产品默认配置（强度排序+MMR+dedupe+floor）在真实 bge-m3 / 合成集上的实测：
`recall@5 = 0.9167`、`MRR@5 = 0.7483`、`nDCG@5 = 0.7912`（基线 0.7708 / 0.6094 / 0.6502）。
**强度排序是唯一带来大幅收益的开关（recall +0.1459）**；floor=0.2 在向量 minScore=0.5 之后是空操作。

