# 本仓库相对上游的改进

> 原作者：**RestRegular**（上游原项目 [RestRegular/dsh-memory](https://github.com/RestRegular/dsh-memory)，MIT）。
> 本项目 [HANPU5838/dsh-memory](https://github.com/HANPU5838/dsh-memory) 在其 **v0.30.1** 基础上持续维护，
> 以下是相对上游的完整改进清单（有源码改动 + 回归测试，不是临时补丁）。

## 0.57–0.61（本仓库自维护版相对 0.56 的变更）

> 这一段不是「相对上游」，而是本仓库在 0.56 之后的六个版本的变更总览；逐版本的细节、
> 测试数字与验证方式见 [CHANGELOG.md](CHANGELOG.md) 与 [docs/verification.md](verification.md)。

- **0.57 移除知识图谱**：删除实体共现图（建图/序列化/`/graph` 路由/面板视图/`graph.json`）；
  实体抽取迁到 `analysis/entities.ts`，**「关系分析」完整保留**。桌面端与移动端 API 都少了一个功能面。
- **0.57 Termux 原生运行时**：新增 `retrieval.vector.runtime`（auto/managed/system）；
  系统 `llama-server` 优先，只下模型、不走 glibc 兼容层；修复 Android 平台判定（`isLinuxLike`/`assetPlatform`）。
- **0.62.5 空会话作用域回收**：每小时维护任务清理「无记录且超期」的 session 作用域元数据
  （默认保留 1 天，`limits.sessionScopeMaxAgeDays` 可调），有记录/活跃/冻结一律不动；
- **0.62.4 向量后端默认手动安装**：`autoBootstrap` 默认 `off`（不自动探测端点/装包/下模型），
  下载与安装由面板按钮显式触发；显式设 `auto`/`always` 才恢复自动自举；
- **0.62.3 保底召回**：两路准入门槛同时擦线时整条漏召回，新增 `recallFallback`
  （默认开，只在 0 结果时放宽一次，仍高于噪声地板）；
- **0.58 零配置自举**：`autoBootstrap`（auto/off/always）：Termux 自动装包 → 只下模型 → 托管启动；
  决策抽成纯函数并有回归用例；过程落盘 `<installRoot>/bootstrap.log`。
- **0.59 跨平台适配层**：`detectRuntimeEnvironment()`（平台/发行版/包管理器/系统 llama-server）；
  系统 llama-server 发现覆盖 brew/`/usr/local/bin`/`~/.local/bin` 等；自检新增「系统 llama-server」项。
- **0.60 更强自适应**：本机端点自动发现（Ollama/LM Studio/llama.cpp，同模型同维度才采用，零下载）；
  端口冲突自动回退；Linux `lspci` GPU 探测（AMD/Intel → Vulkan）。
- **0.61 可重复验收**：`npm run verify:all` 四层验收（测试/构建/面板 16 接口/向量实测）；
  新增 [docs/verification.md](verification.md)（真机 16 项清单 + 排障手册 + CI 接法）。

## 一、改进清单

### 安装器（`embed-install.ts`）

| # | 类型 | 改进 | 解决的真实问题 |
|---|---|---|---|
| I1 | **P0** | tar.gz 支持符号链接/硬链接：两遍写盘 + 多轮重试（链接可能互相依赖），软链失败退化为复制真实文件，越界目标拒绝 | llama.cpp 的 Linux 包靠两级 SONAME 软链（`libfoo.so → libfoo.so.0 → libfoo.so.0.9.0`）让动态加载器找库；跳过链接 → `llama-server` 启动即报 `cannot open shared object file` 并秒退 |
| I2 | P1 | 解压后校验：跟随 `stat` 检查 `*.so*` / `*.dylib` 链接是否都能解析，失败即 `phase:'error'` 并写明缺哪个库、原因 | 原来看似「安装成功」，启动才发现坏；FAT/exFAT 不支持软链时更是无声失败 |
| I3 | P1 | 磁盘预检：下载前检查可用空间（模型×1.25 + 运行时预留 + 200MB），不足直接报错并给出需释放容量 | 手机上 400MB+ 下载到一半 `ENOSPC`，`.part` 删掉重来 |
| I4 | P2 | `extractArchiveReport()` 返回链接统计（软链/硬链/复制/失败/轮次），`extractArchive()` 保持返回 number 向后兼容 | 链接失败数以前不可见 |

### 后端生命周期（`embed-server.ts`）

| # | 类型 | 改进 | 解决的真实问题 |
|---|---|---|---|
| I5 | **P1** | Termux/Android glibc 自动包装：读 ELF `PT_INTERP`，解释器不存在时用 `$PREFIX/glibc/lib/ld-linux-*.so.1 --library-path ... <exe>` 启动（`glibcWrap: 'auto' \| 'on' \| 'off'`） | 插件只下 ubuntu-arm64 glibc 二进制，Android 上 `/lib/ld-linux-aarch64.so.1` 不存在 → `ENOENT`；此前只能靠仓库外猴补丁 |
| I6 | P1 | 端口预检：spawn 前探测 host:port，被占直接报 `PORT_IN_USE` 并提示改配置 | 原来是子进程 bind 失败 → 60 秒「启动超时」，看不出原因 |
| I7 | P1 | 自愈重启：异常退出 1s/5s/30s 最多 3 次；`stop()` 后绝不重拉；耗尽后 `unavailable` + 原因 | Android 上后台被杀是常态，被杀后整场会话静默走词法 |
| I8 | P1 | pid 身份校验：Linux 上 adopt/kill 前读 `/proc/<pid>/cmdline` 含 `llama-server` | PID 复用时会误杀同 UID 的其它进程 / 误接管别人的服务 |
| I9 | **P0** | 默认 `-b 2048 -ub 2048`；用户 `extraArgs` 显式给了 batch 参数时不重复传 | 默认 512 会拒绝 >512 token 的记录（4000 汉字≈2001 token），失败又静默熔断 → 语义检索无声退化成词法 |
| I10 | P1 | 秒退诊断：启动 15s 内退出时把日志文件末尾 12 行带进主日志；spawn `error` 记入 `lastError`，`waitUntilReady` 立刻失败 | 原来只剩一句「进程已退出」/ 空转到 60 秒超时 |

### 存储（`store.ts`）

| # | 类型 | 改进 | 解决的真实问题 |
|---|---|---|---|
| I11 | **P0** | `flush()` 写盘异常不冒泡：逐 scope `try/catch` + warn，增量保留下次重试 | 原来从 unref 定时器抛出成 uncaught，宿主 `installFailLoud` 直接 `exit(1)`，一次 ENOSPC 带走整个 DSH |
| I12 | P1 | 只读/不可写目录下的锁死循环修复：EACCES/EPERM 只有锁文件确实存在才按竞争处理，否则抛错交上层 | 原实现把「目录不可写」当「锁已存在」→ 删不掉又立即重试，100% CPU 空转 |
| I13 | P1 | `.vec` 载入按身份头维度逐条校验，丢弃被截断的错维向量 | 进程被杀留下截断行时 base64 长度仍合法，错维向量混进余弦计算 → 相似度静默算错 |
| I14 | P1 | 边车写入清理已删除记录的条目 | 边车「只增不减」，删记录/重建后文件无限增长 |
| I15 | P1 | 访问统计落盘：`accessCount` / `lastAccessedAt` 进入增量 | 只在内存加一，recency / accessBoost 长期失真（实库 25/25 条 accessCount=0） |

### 检索与配置（`index.ts`）

| # | 类型 | 改进 | 解决的真实问题 |
|---|---|---|---|
| I16 | P1 | 查询嵌入预算自适应：首查超时用更大预算重试一次，成功后固定「实测×3」（上限 4s） | 默认 300ms 是桌面预算；ARM 手机单次查询嵌入 0.3–1.8s，每次交互检索都超时降级 |
| I17 | P2 | `writeTimeoutMs` 10s→20s、`backfillTimeoutMs` 30s→60s、`backfillBatchSize` 32→8 | 4000 字记录实测 9.7s 贴边；32 条大批量在 CPU 上整批超时 → 毒批永久 pending |
| I18 | P1 | `storeDir` 默认绝对路径 `~/.dsh-memory`（相对配置也按 homedir 解析） | 相对路径跟着 cwd 走：换启动目录 = 一套空库；cwd 只读时 provider 静默消失 |

### 文档

| # | 改进 |
|---|---|
| I19 | 修正 7 处「五个模型工具」为「六个」（README ×2、两个 package.json、locale zh/en） |
| I20 | 镜像横幅如实说明「上游 v0.30.1 + 本仓库改进」，不再声称「代码未改」 |

**测试**：`node --test source/*/test/*.test.ts` → **575 例 / 574 pass / 1 skipped**（跳过的是需要真实 Windows zip fixture 的用例）。

## 一之二、插件化改造（A/B/C，2026-11-08 第二批）

> 目标：不再「往项目里贴适配」，而是把差异与能力收敛成层，插件自包含、可组合、可替换。
> 全程不改 DSH 源码、不注入 NODE_OPTIONS、不打宿主补丁。

### A. 平台适配层（`platform.ts`）

| 能力 | 说明 |
|---|---|
| `detectPlatform()` | 一次探测出：是否 Termux、`$PREFIX`、glibc loader 路径、CPU 核数（`os.cpus()` 为 0 时兜底 `availableParallelism`，再兜底 4）、可用内存（`MemAvailable` 与 cgroup 限制取小）、临时目录 |
| `readElfInterpFromFile()` | ELF `PT_INTERP` 解析（从 embed-server 收敛过来，原导出路径保持兼容） |
| `freeDiskBytes()` / `canExecute()` | 磁盘余量、目录可写性（noexec/只读挂载的常见坑） |
| `describePlatform()` | 一行环境摘要，日志与面板共用 |
| 消费方 | `embed-server`（ELF/loader）、`hardware`（核数兜底）、面板「环境自检」 |

面板「向量服务」卡片新增 **环境自检**：一次只读探测并逐条展示 平台 / glibc loader / 嵌入后端 / 安装目录磁盘 / 安装目录权限 / 记忆目录权限；后端失败时同时显示最近一次真实原因。

### B. 嵌入后端可插拔（`embedding-providers.ts`）

```ts
retrieval.vector.provider: 'local' | 'openai' | 'ollama' | 'off'   // 默认按 endpoint 推断
retrieval.vector.apiKey?: string                                    // 也接受环境变量 DSH_MEMORY_API_KEY
```

| provider | 用途 |
|---|---|
| `local`（默认） | 本机 llama-server（插件自己下载/托管）——原来的行为 |
| `openai` | 任意 OpenAI 兼容 `/v1/embeddings`（含云服务），自动带 `Authorization: Bearer` |
| `ollama` | `/api/embeddings`，逐条请求 |
| `off` | 纯词法检索，永不联网 |

- 只有 `local` 会创建 `EmbedServerManager` 拉起子进程；其余 provider 生命周期归外部。
- 未知 provider 在构造期报错（配置脏数据不静默退化）。
- endpoint 未配 / 回环地址 → `local`；远程地址 → `openai`。

### C. 事件总线（`events.ts`）

```ts
memory/record-saved    { scope, id, kind, chars, deduped }
memory/recalled        { query, hits, topScopes, vector }
memory/record-forgotten{ scope, ids }
```

- `apply.ts` 用宿主 `ctx.emit` 转发（拿不到 `ctx.emit` 时退化为纯进程内广播），其他插件 `ctx.on('memory/record-saved', …)` 即可订阅。
- emit 永不抛、payload 只含元数据（**不含记忆正文**）、监听器抛错不影响主流程。
- `MemoryEventBus.subscribe()` 也支持进程内订阅（测试与内部消费者用）。

**测试**：`node --test source/*/test/*.test.ts` → **607 例 / 606 pass / 1 skipped**。

## 一之三、可靠性收尾（2026-11-08 第三批）

| # | 类型 | 改进 | 解决的真实问题 |
|---|---|---|---|
| I21 | P1 | **下载断点续传**：`.part.meta` 记录来源/ETag/Last-Modified，同源才发 `Range` + `If-Range`；206 起点匹配→追加，200→从头，416→丢残片，换源不续 | 400MB+ 模型下到一半失败要整包重下，手机流量/弱网代价大 |
| I22 | P1 | **完整性校验**：声明总长 vs 落地字节；可选 `modelSha256` / `runtimeSha256`（按资产名）；不匹配 → `phase:'error'` + 删残片 | 截断但「长度合法」的 GGUF 会落地，直到 llama-server 加载才报错 |
| I23 | P1 | **安装后冒烟**：模型就位后跑 `llama-server --version`（Termux 自动 glibc 包装，4s 超时），失败 → error + stderr 尾部，并摘掉 exe 防止被误判「已就绪」 | 装完看着成功、启动才发现缺库/不兼容 |
| I24 | P1 | **孤儿进程清理**：启动时若 pid 存活 + cmdline 是 llama-server + /health 不通 → SIGTERM，3s 未退升级 SIGKILL；cmdline 不符 / 非 Linux / 读不到 /proc 一律不动 | 插件被 SIGKILL/LMK 强杀后，孤儿 llama-server 继续占 797MB RSS 与端口，新实例 bind 失败 |
| I25 | P2 | **面板切换嵌入后端**：`POST /provider` + 服务卡片下拉，运行时切换 local/openai/ollama/off 并持久化到 `<storeDir>/vector.json`（配置文件显式写 provider 时优先） | 换后端要改 YAML 重启 |
| I26 | P2 | **旧压缩包复验**：配置了 `runtimeSha256` 时，复用的既有压缩包必须匹配哈希，不匹配就删掉重下 | 上一轮失败留下的坏包会被直接解压 |
| I27 | P2 | **CI**：`.github/workflows/ci.yml`（ubuntu + Node 24），push/PR 到 main 跑 `node --test source/*/test/*.test.ts` | 上游无 CI，回归只能靠手动跑 |

**测试**：`node --test source/*/test/*.test.ts` → **629 例 / 628 pass / 1 skipped**（新增下载续传/校验/冒烟 17、孤儿清理 4、provider 切换 1）。

### 与原「未做项」的对照

- ✅ 模型下载断点续传 + sha256 校验 → I21/I22
- ✅ 安装后 `--version` 冒烟 → I23
- ✅ SIGKILL 孤儿进程清理 → I24
- ✅ CI → I26
- ✅ 面板展示/切换 provider 与自检 → I25 + 环境自检
- ⬜ 60s 全量发现（1k→10k 条）的 IO/内存优化仍是已知项（见下文）

## 二、如何构建与安装

```bash
git clone https://github.com/HANPU5838/dsh-memory
node tools/build-single-package.mjs --scope @restregular --version 0.30.1 \
  --repo https://github.com/HANPU5838/dsh-memory
# 把 packages/dsh-memory/ 覆盖进 DSH profile：
#   <profile>/node_modules/@restregular/dsh-memory/
```

> DSH 实际加载的是 `packages/dsh-memory/lib/**`，只改 `source/` 不构建不生效。

## 二之三、0.32.0 —— 语义认知层 · 检索整形 · 嵌入性能（2026-11-10）

> 目标：把「档案」升级成「真正的记忆系统」——会语义整理、会冲突告警、会遗忘与恢复、可回滚；
> 同时把本地嵌入模型的吞吐/延迟/成本压到实际可用。

### 1. 认知层（写侧）

| # | 能力 | 说明 | 解决的真实问题 |
|---|---|---|---|
| C1 | **语义近重复合并** | 写后再嵌入向量与同 scope 已有向量比对；余弦 ≥ `merge.threshold`（默认 0.92）且**关键细节一致**时，新记录接管旧记录（`supersedes` 指向旧 id、`generation+1`、tags 并集、importance 取大），旧记录保留为已修正 | 同义记忆并存互相挤占召回名额；只按 `contentHash` 去重挡不住"换个说法" |
| C2 | **冲突检测（只打标）** | 0.75~0.92 相似度，或**数字/路径/标识符不一致**（`hasCriticalDetailConflict`）→ 打 `conflictWith/conflictConfidence`，绝不自动改内容 | 纯余弦会把"措辞几乎一样但事实矛盾"的两条合并（实测 10.4GB vs 20GB 余弦高于同义改写） |
| C3 | **谱系** | 记录级 `generation`、`supersedes` 链、`lineage(id)` 前驱/后继遍历（防环） | 只知道"被修正过"，查不到"从哪一版演进而来" |
| C4 | **生命周期** | `dormant`（30 天未访问且 importance ≤0.3 → 不进摘要/召回，命中唤醒）、`tombstone`（forget 软删，30 天可 restore）、`purgeTombstones`（到期物理删）、`snapshot/restore`（gzip JSONL 快照） | 只增不减、误删不可恢复、没有备份/迁移手段 |
| C5 | **维护任务** | 每小时：过期清理 + 容量淘汰 + dormant 标记 + 墓碑清理；归档会话作用域全部冻结 | 生命周期逻辑散落、没有统一周期 |

### 2. 检索整形（读侧）

| # | 能力 | 说明 | 解决的真实问题 |
|---|---|---|---|
| R1 | **地板分** | 作用于**匹配强度**（词法校准分/余弦），不是衰减后的终态分 | 弱相关噪声进 topK；直接作用在终态分又会误杀"相关但久未访问"的旧记忆 |
| R2 | **同义结果合并** | 余弦 ≥0.85 的命中只留分最高的一条，被合并 id 进事件 | 两条同义记忆同时占位（实测余弦 0.865） |
| R3 | **MMR 多样性** | `λ·rel − (1−λ)·max sim`，无向量时退化分数去重 | 结果高度重复、覆盖不了不同侧面 |
| R4 | **自适应阈值 + 跨 scope 校准** | 短查询放宽、长查询收紧；global 与 project 词法分先校准再同槽排序 | 两档固定阈值 + 分数域不可比 |
| R5 | **离线评测** | `recall@k / MRR / nDCG@k` + CSV 导出（`retrieval/eval.ts`） | 改检索参数只能"感觉变好了"，无法量化 |

### 3. 嵌入性能

| # | 能力 | 说明 | 实测 |
|---|---|---|---|
| E1 | **批量嵌入** | `embedBatch` 按条数+字符分组；**部分成功语义**（单条失败为 null）；外层 null = 后端不可用 | 回填 batch=8 3.2 rec/s；超长记录不再毒死整批 |
| E2 | **单条回退** | llama-server 对超长输入返回 **HTTP 500 + "input too large"**（不是 400），按 body 识别后拆单重试 | 3 条里 2 条正常、超长那条单独失败，后端保持 healthy |
| E3 | **向量缓存** | 文档缓存持久化（identity+contentHash，换模型整体失效）+ 查询 LRU | 文档热命中 **0.34ms**（≈6200×）；查询热 **P50 0.03ms** |
| E4 | **预热保活** | 启动 warmup + 周期探活退避；后端恢复自动结束熔断 | 避免首问吃冷启动；后台被杀可自愈 |
| E5 | **ANN 模块** | 纯 JS HNSW（零依赖）+ 可选 `hnswlib-node` 动态加载，缺失自动退化全量扫描 | 20k 条 P50 1.73ms vs 全量 25.2ms（14.6×），召回 94% |
| E6 | ~~本地重排~~ | 0.55.0 审计发现该模块从未接入检索链路（死代码），已移除；需要时再重新设计接入 | — |

> ANN 模块（E5）已交付并测试，**尚未接进 `search()`**（默认走全量扫描，2000 条内更快）；
> 接线方式是 `shouldUseAnn(size)` + 增量 insert，留待下一版在真实大库上验证后默认开启。

### 4. 配置新增

```yaml
retrieval:
  finalFloor: 0.2            # 匹配强度地板分（0 关闭）
  dedupeThreshold: 0.85      # 同义结果合并（0 关闭）
  mmr: true                  # MMR 多样性
  mmrLambda: 0.7
  vector:
    cache: true              # 向量缓存（<storeDir>/embed-cache）
    keepAlive: true          # 预热 + 探活
cognitive:
  merge: { enabled: true, threshold: 0.92 }
  conflict: { enabled: true, minSimilarity: 0.75 }
  lifecycle: { dormantAfterDays: 30, dormantMaxImportance: 0.3, tombstoneDays: 30 }
```

**测试**：771 例 / 770 pass / 1 skip / 0 fail（新增 137 例：认知层 36、检索 28、性能 73）。

## 二之四、0.33.0 —— 记忆强度算法 · 时间有效性 · 周期巩固（2026-11-10）

> 目标：让"记忆"变成有强度、会退化、能巩固、能失效的对象，而不是一堆静态文本。
> 公式全部在代码注释 + 本节，参数全部可配置、可 A/B。

### 1. 强度与排序（`retrieval/retention.ts`、`rank.ts`、`expand.ts`）

| # | 能力 | 公式/口径 | 解决的竞品短板 |
|---|---|---|---|
| A1 | **FSRS 式保持度** | `R=(1+t/(9S))⁻¹`；`S₀=类型先验/(1+0.12·log₂(1+chars/200))`；`updateAfterUse` 按质量/难度/间隔增益，单次 ×≤4 | 竞品多用固定半衰期或纯余弦，旧但正确的记忆会沉底 |
| A2 | **效用反馈闭环** | 只有 `memory_get` 取用才更新 `utility`（EWMA）与 `useCount`；召回本身不计分 | 用"被使用"而非"被召回"作为信号，避免自我强化刷分 |
| A3 | **可解释排序** | `score = relevance × (1−0.5(1−R)) × (1+0.3U) × (1−0.4(1−importance)) × (退役?0.3:1)`，附 breakdown | 排序结果可解释、可回归，不是黑盒 |
| A4 | **动态混合权重** | 查询画像（CJK 比例/标识符/数字/路径）→ 词法权重 0.2~0.9；`blendHybrid` 融合双通道 | 代码/端口查询偏词法，自然语言偏向量 |
| A5 | **Rocchio 查询扩展** | `q' = normalize(αq + β·mean(top文档向量))`，默认关 | 对"换个说法搜不到"的补救；需按库调 beta |

### 2. 时间与矛盾（`cognitive/temporal.ts`、`contradiction.ts`）

| # | 能力 | 口径 |
|---|---|---|
| B1 | **事实有效期** | `[validFrom, validUntil)` 左闭右开；旧事实被推翻 → `validUntil=now` 失效但保留（历史可查） |
| B2 | **矛盾置信度** | `conf = sim × (0.65·detailDiff + 0.35·criticalConflict)`；`detailDiff=0.6·numericRate+0.4·identifierRate`；数值不等至少 0.5；≥0.6 high / ≥0.3 medium |
| B3 | **冲突判定收紧** | 只有"关键细节不一致 + 置信度 ≥ medium"才标冲突；同义改写不再被误标（否则既进不了巩固又误导用户） |
| B4 | **时间权重** | `(1+0.12·freshness)·(1−0.25·(1−urgency))`，失效为 0 |

### 3. 巩固（`cognitive/consolidate.ts`）

- 并查集按余弦 ≥0.9 聚类（**跨 scope 不合并**）；只处理"活着、非退役、非休眠、非失效、无冲突标记"的记录。
- 合并计划：基底 `0.6·utility+0.4·importance`；正文 = 基底原文 + 簇内独有句（截断 `maxChars`）；tags 并集；
  `generation=max+1`、`consolidatedFrom=全簇`、`stability/utility/difficulty` 取最大、`useCount` 求和。
- 落盘：新记录 `supersedes` 基底；其余来源 `validUntil=now`（时间失效、历史保留）；新记录自动进 `embedPending`。
- 调度：每小时维护任务，`maxClusters` 限流；也可手动 `service.consolidateNow()`。

### 4. 接线（index.ts）

- `save` 初始化强度字段；`memory_get` 触发取用反馈；`search` 有效期过滤 + 时间权重 + 动态融合 + 强度排序 + 可选扩展；
- `applyCognition` 冲突时失效旧事实（不再合并矛盾记忆）；历史浏览（`includeExpired`）跳过整形与时间过滤；
- ANN 热路径接线（0.33.0 补上 0.32 遗留项）：后台建图、未就绪自动回退、增量 insert/update；默认关。

**测试**：896 例 / 895 pass / 1 skip / 0 fail（新增 122 例：retention 22 / expand 17 / rank 16 / temporal 21 / contradiction 19 / consolidate 24 / 集成 3）。

## 二之五、0.33.1 —— 全链路一致性修复（2026-11-10）

| # | 位置 | 问题 | 修法 |
|---|---|---|---|
| F1 | `listSync`（memory-inject 的规则/流程/摘要） | 不过滤 dormant / tombstone / 失效事实 → **删掉的规则还会注入系统提示** | 与 `search` 同口径加 `shouldSkipRecord` + `isActiveNow`，有回归测试 |
| F2 | `getByIds`（memory_get） | 给软删/失效记录也加 utility/stability | 只对 `isActiveNow && !dormant && !tombstoned` 的记录反馈 |
| F3 | `save` | `initialStrength()` 覆盖导入/快照显式带的强度字段 | 只合并显式强度字段（`explicitStrengthFields`），且不再整份展开 saveInput（曾导致 scope 分叉回归） |
| F4 | 面板 `POST /delete` | 物理删除，与工具 `forget` 软删语义不一致，删了不可恢复 | 统一走 `memory.forget`（墓碑），新增 `POST /restore` |
| F5 | 面板记录卡 | 看不到墓碑/失效/冲突/强度，也无法恢复 | 徽章 + 强度行 + 「恢复这条记忆」按钮 + 删除文案提示 30 天可恢复 |
| F6 | 面板维护区 | 没有手动巩固入口 | 新增「立即巩固」按钮（`POST /consolidate`） |

**真机安装验证**（本机 profile web，原地升级 0.30.1 → 0.33.1 构建产物）：
- 备份：`~/dsh-plugin-backup-20261110-222436/`（回滚：拷回即可）
- 验证：安装位置 `import lib/provider/index.js` OK；save/search/软删/恢复/规则注入链路 OK；
  `dsh --profile web --dump-config` 能正确组合 `dsh-memory` entry
- 生效方式：重启 `dsh web`；记忆数据 `~/.dsh-memory` 零迁移（老版本可读新字段）

| F7 | `cognitive/lifecycle.ts` | dormant 只看 lastAccessedAt，天天 `memory_get` 的记忆会被误判休眠 | `lastSeenAt` 纳入 `lastUsedAt` |
| F8 | `store.enforceLimit` | 容量淘汰只看新鲜度×重要度，会把常被使用的记忆淘汰 | 适应度加入效用 `(1+0.3·utility)`，与排序口径一致 |

## 二之六、0.34.0 —— 全链路不变量 · 单一可见性判定 · 面板缩放（2026-11-10）

| # | 改进 | 说明 |
|---|---|---|
| G1 | **单一可见性判定** | `recordInvisibility(record, {includeDormant, includeTombstoned, includeExpired, now})` 返回 `tombstoned / dormant / expired / invalid / undefined`；所有消费路径（search / list / listSync / 巩固 / 取用反馈 / 面板）统一调用，杜绝"修了 search、漏了 listSync" |
| G2 | **全链路不变量测试** | `pipeline-invariants.test.ts` 锁住：四状态各归其位、三读路径一致、三写路径同 scope、删→恢复→删往返、配置矩阵不崩。任何一条路径再被改坏，测试会直接指出 |
| G3 | **面板整体缩放** | A− / 100% / A+（70%~160%），localStorage 持久化；记忆树画布保留独立缩放 |
| G4 | 清理 | 移除 index.ts 里已不再需要的 isActiveNow/shouldSkipRecord 直接调用，避免再出现"第二套判定" |

**测试**：906 例 / 905 pass / 1 skip / 0 fail。

| G5 | **记忆树自由缩放（0.34.1）** | 20%~300%，−/%/+/100%/适应；Ctrl/⌘+滚轮锚定指针连续缩放；localStorage 记忆比例（0.34.0 误做在整个面板，已撤销） |
| G6 | **容量淘汰跳过墓碑** | `enforceLimit` 不淘汰 tombstone，避免容量压力破坏"30 天可恢复"承诺；`wipeAllRecords` 同时丢弃 ANN 索引 |

| G7 | **取用反馈污染（0.34.2）** | 注入层去重标记调用 `getByIds()` 被当成取用，导致 utility/useCount 虚增；改为 `trackUse` 显式开关，只有 memory_get 计分 |

| G8 | **记忆树 v2（0.35.0）** | 删除/失效/休眠/冲突状态可视化（样式 + 徽章 + 图例）、记忆强度条（stability 分档 + 效用点）、「只看问题」过滤 |
## 二之七、0.40.0 —— P0–P4 全面完善（2026-11-10）

| 项 | 内容 |
|---|---|
| **P0 检索核心** | `retrieval/bm25.ts`（正式 BM25 + 字段加权）、`retrieval/fusion.ts`（RRF，可解释来源）、`expandQueries`（4 个确定性查询变体）；index.ts 接入 BM25 词法路 + RRF 加成（默认不注入新候选，防污染召回） |
| **P1 健康度** | `cognitive/health.ts`：互斥分类 + 抽样余弦重复率 + 7 项扣分公式（0–100 分）；provider `healthReport()`；面板健康卡片；`/health` API |
| **P2 冲突自动解决** | `cognitive/resolve.ts`：矛盾度 0.6 + 优势 0.4（证据/来源/时间三信号）→ invalidate-old / merge / keep-both；`applyCognition` 接入；面板冲突中心 + `/conflicts`、`/conflicts/resolve` |
| **P3 评测证据** | `tools/eval/`（合成集 94 条/48 查询/16 组开关）+ `docs/benchmark.md`（真实 bge-m3 数字与复现命令）+ `docs/comparison.md`（9 竞品 × 9 维度 + 来源链接） |
| **P4 安全/运维** | `cognitive/guard.ts`：指令注入/凭据/零宽字符扫描 + 自动隔离（agent/auto 高风险）+ 面板解除；本地备份 API/面板按钮（固定 backups 目录、防路径穿越）；记忆树隔离徽章 |

**关键评测数字（真实 bge-m3，k=5，合成集）**：base recall@5 `0.7708`；+强度排序 `0.9167`；
产品默认（全开）`0.9167 / MRR 0.7483 / nDCG 0.7912`。

**测试**：1009 例 / 1008 pass / 1 skip / 0 fail。

| G9 | **冷启动闸门（0.40.1）** | 本地 llama-server 模型加载期间跳过语义召回（只走词法），不再刷 300ms/1.5s 超时；就绪自动恢复；外部 endpoint 不受影响 |

| G10 | **并发查询串行化（0.40.2）** | llama-server 4 slots 下并发查询互抢导致超时；查询嵌入串行链 + 默认预算 1000ms/上限 8s，实测 5 路并发 459ms 全部完成 |

| G11 | **记忆树列表视图（0.41.0）** | 手机屏幕下画布太空/节点挤右 → 默认列表视图（作用域→类型→记录可折叠、状态徽章/强度条/详情面板）；「列表/画布」可切换并持久化 |
| G12 | **健康卡片去重入口（0.41.0）** | 重复率 >5% 时显示「去重巩固」，一键 consolidate + 重新体检 |

| G13 | **维护覆盖全部作用域（0.41.1）** | `healthReport`/`runHousekeeping`/`listConflicts`/`consolidateNow`/`wipeAllRecords` 先 `discoverScopes()`，不再只扫已加载 scope |
| G14 | **重复率排除历史版本（0.41.1）** | superseded 旧版本不计入重复率；真实库 72.9→92.9 分、22%→0% |

| G15 | **记忆树还原（0.41.2）** | 撤销 0.41.0 列表视图，恢复原画布模式；保留健康卡片去重入口与 0.41.1 修复 |

| G16 | **文档嵌入并发闸门（0.41.3）** | save-time/回填嵌入最多占 2 个 slot，避免批量写占满 llama-server 的 4 个 slot 导致查询超时 |

| G17 | **冲突误判收敛（0.41.4）** | 同义标识符归一化（arm64/aarch64）+ 子集细节不算冲突 + 只有数值/路径差异才自动裁决；删除兜底失效旧记录的旧逻辑 |
| G18 | **巩固冲突闸门（0.41.5）** | 关键细节冲突的记录绝不参与巩固（余弦再高也不行），防止漏判时把互斥事实合并 |
| G19 | **连写竞态重查（0.41.5）** | 保存后首轮相似度无命中时延迟 300ms 重查一次，捕获同一轮连续写入 |
| G20 | **记忆树任意缩放（0.42.0）** | 5%–1000%；滚轮/双指/滑块/按钮/双击适应；对数刻度滑块、锚定指针缩放、边界放行页面滚动 |
| G21 | **知识图谱（0.42.0）** | `cognitive/graph.ts`：11 类实体规则抽取 + 共现图 + 确定性截断；面板图谱视图（力导向/类型筛选/实体详情/关联记忆）；`docs/graph.md` |
| G22 | **交互流畅度（0.42.1）** | 图谱节点展开/位置缓动、悬停边高亮、详情滑入、spinner 骨架、tab/按钮过渡、「全部类型」、prefers-reduced-motion 降级 |
| G23 | **图谱视觉重做（0.42.2）** | 类型分簇力导向 + 包围盒归一化、节点放大与标签防重叠、曲线边、选中聚焦/悬停高亮、Top30/60/120/全部、仅强关系、tag 同名去重、悬停信息条 |
| G24 | **3D 知识球（0.43.0）** | 球面类型分簇 + 透视投影 + 上下左右拖动旋转 + 自动旋转/重置 + 深度排序/透明 + 前向标签防重叠；rAF 限频保证流畅 |
| G25 | **图谱回退 2D + 全向拖动 + 自适应（0.44.0）** | 移除 3D 球/自动旋转；图谱按容器尺寸布局、上下左右拖动平移；树/图容器高度按设备视口收敛，底部不再被裁 |
| G26 | **图谱交互修复（0.44.1）** | 稳定签名触发展开动画、kgSize 前不布局、拖动阈值抑制点击、触屏交原生滚动、双指中点锚定/边界阻止、图例控件补回、缩放记忆不被覆盖 |
| G27 | **智能关系分析（0.50.0）** | 六引擎（关系发现/冲突/聚类/演化/推理/校验）+ 关系状态机（suggested/confirmed/rejected/ignored/pending_review）+ 增量指纹 + 任务队列 + 面板五区域/四视图 + 14 条 API |
| G28 | **图谱降噪（0.50.2）** | 节点 5–13px、标签 9px 防重叠、布局更散、默认 60 实体；移除图谱底部缩放条，滚轮/双指/双击/键盘 +−0F 缩放 |
| G29 | **移除全部缩放条（0.50.3）** | 树/图都不再显示底部缩放条；滚轮/双指/双击 + 键盘 +−0F；焦点描边；清理死代码 |
| G30 | **图谱视觉升级（0.51.0）** | GitNexus 风格暗色宇宙画布、力导向/类型环视图、顶部选中信息条、玻璃详情、mono 标签；仍零依赖 SVG |
| G31 | **图谱回归原生风格 + 文件落盘（0.52.0）** | 撤掉暗色/GitNexus 装饰，用插件浅色 token；图谱写入 analysis/graph.json 并在关系变更后同步 |
| G32 | **图谱文件视图 + 搜索（0.53.0）** | 类型文件夹 → 实体文件行 → 关联记忆；实体/记忆全文搜索；文件/图谱切换；默认文件视图 |
| G33 | **文件视图标注清晰（0.54.0）** | 文件行 = 类型·名称 + 关联记忆摘要 + 条数；搜索命中自动展开；README/docs 全面对齐 0.54.0 |
| G34 | **死代码/UI 审计（0.55.0）** | 删除未接线 rerank-local 与过时审计文档；标签页横向滚动、分析卡自适应、搜索提示、文件全部展开/收起 |
| G35 | **图谱矢量缩放 + 垃圾清理（0.56.0）** | SVG 按 zoom 重绘（不糊）、语义标签缩放；备份后清理 12 条 agent 日志/自检记录、`.build`/eval out/工作区临时文件，健康分回到 100 |
| G36 | **文档版本对齐（0.56.1）** | README 边界/安装到 0.56.0 + 明确“闭环本地记忆系统”判断；docs 标题同步；清理 .build |
## 三、如何从上游同步

```bash
git remote add upstream https://github.com/RestRegular/dsh-memory
git fetch upstream && git rebase upstream/main
node tools/build-single-package.mjs --scope @restregular --version <新版本> \
  --repo https://github.com/HANPU5838/dsh-memory
node --test source/*/test/*.test.ts
```

上游若已收录其中某条，从本清单删掉对应行，避免重复改动。

## 四、已知但本次未做

1. 冒烟探测是阻塞的 spawnSync（≤4s，用户点按钮才会触发），阻塞期间不响应取消（可改为异步 spawn）。
2. 10k 条以上时向量仍常驻内存（增量索引已解决「每 60s 全量读文件」，内存占用本身未做分层/淘汰）。
3. ANN 已接进检索热路径（默认关）；默认全量扫描，规模上限仍受 `maxRecordsPerScope` 约束。
4. 语义合并只在写入时触发；存量近重复靠周期巩固（0.33.0）消化，但仍不是全量巡检。
5. 面板尚未暴露 restore / snapshot / 冲突提示 UI（服务层 API 已就绪）。
