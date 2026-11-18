# 架构说明（本仓库独立维护版 0.87.0）

> 本文说明这套记忆插件「为什么是插件」：哪些属于宿主、哪些属于插件、平台差异放在哪里。
> 本仓库 **[HANPU5838/dsh-memory](https://github.com/HANPU5838/dsh-memory)** 是 DSH 记忆系统的独立维护版
> （基于原作者 RestRegular 的 MIT 代码，版权与署名保留）：平台适配层、可插拔嵌入后端、事件总线、
> 语义认知层、检索整形（BM25/RRF/MMR）、记忆强度算法、健康度/冲突中心、可疑写入隔离与**智能关系分析**
> 都在本仓库持续演进（清单见 [IMPROVEMENTS.md](../IMPROVEMENTS.md)，分析架构见 [analysis.md](analysis.md)）。
> 安装、发布、更新**只以本仓库为准**，不依赖 npm 或第三方仓库。

## 1. 三层结构

```
┌──────────────────────────────────────────────────────────────┐
│  宿主桥接层（host bridge）—— 只用 DSH 官方扩展点              │
│  · Cordis service：ctx.memory                                │
│  · 工具：memory_save / search / list / get / forget / scopes  │
│  · 面板：client slot + 服务端路由 /memory/api/*               │
│  · 生命周期：ctx.inject / ctx.on('session/created') / ctx.effect │
│  · 事件出口：ctx.emit('memory/record-saved' …)                │
├──────────────────────────────────────────────────────────────┤
│  记忆内核（core）—— 与平台无关                                │
│  · 存储：JSONL（记录）+ .vec（向量边车，身份头 model/dims/pooling）│
│  · 检索：BM25（中文 unigram+bigram）+ 向量余弦 + RRF 融合 + 强度排序 │
│  · 作用域：session / project / global / custom（含授权与归档冻结）│
│  · 注入：自动召回、规则常驻段、流程索引、上下文去重            │
├──────────────────────────────────────────────────────────────┤
│  平台适配层（platform）—— 所有环境差异都在这里收敛             │
│  · detectPlatform：Termux / $PREFIX / glibc loader / CPU 兜底  │
│    / 可用内存（MemAvailable 与 cgroup 取小）/ TMPDIR           │
│  · detectRuntimeEnvironment（0.59）：平台 / 发行版 / 包管理器   │
│    / 系统 llama-server —— 自举与自检的唯一依据                 │
│  · isLinuxLike / assetPlatform：Android 与 Linux 同语义归一    │
│  · readElfInterpFromFile：判断二进制是否需要 glibc loader 包装 │
│  · freeDiskBytes / canExecute：磁盘余量、目录可写性            │
│  · describePlatform：日志与面板自检共用的一行摘要              │
└──────────────────────────────────────────────────────────────┘
```

**零宿主改动**：不修改 DSH 源码、不注入 `NODE_OPTIONS`、不 patch `node_modules` 以外的
宿主文件。插件缺失时 DSH 只是没有这几个工具与面板，不会报错或阻塞启动。

## 2. 嵌入后端是可插拔的

```
retrieval.vector.provider
  ├─ local   : 本机 llama-server（插件下载/托管子进程）—— 默认
  ├─ openai  : 任意 OpenAI 兼容 /v1/embeddings（自动 Bearer）
  ├─ ollama  : /api/embeddings（逐条）
  └─ off     : 纯词法，永不联网
```

- `embedding-providers.ts` 是唯一构造入口；`EmbedClient` 只负责 OpenAI 兼容传输。
- 只有 `local` 会创建 `EmbedServerManager`，其生命周期（spawn/adopt/自愈/清理）与
  provider 无关的路径完全解耦。
- `provider` 未配置时按 endpoint 推断（回环 = local，远程 = openai）；面板可运行时切换，
  选择持久化在 `<storeDir>/vector.json`，**配置文件显式写 provider 时优先**。

## 3. 数据布局

```
<storeDir>/                    默认 ~/.dsh-memory（绝对路径，不随 cwd 漂移）
  global.jsonl / global.vec
  projects/<sha1(scope)>.jsonl / .vec
  scopes.index.json            # 文件名 → scope 索引（discovery 加速）
  scope-meta/<sha>.json        # 作用域用途/别名/创建代次
  settings.json / grants/ / visibility/ / bindings.json
  vector.json                  # 面板选的 provider（覆盖用）
<installRoot>/                 默认 ~/.dsh/memory-vector
  llamacpp/…                   # llama-server 与运行时库（SONAME 软链）
  models/*.gguf                # 嵌入模型
  llama-server.log[.pid]       # 子进程日志与 pid
```

不变量：

- 向量边车第一行必须是 `#<model>\t<dims>[\t<pooling>]`，身份不符 → 整份作废重嵌；
- 每条向量长度必须等于身份维度（截断行会被丢弃并 warn）；
- 记录与向量的删除一起发生（边车不会只增不减）；
- `flush` 写盘失败只 warn、增量保留（绝不把异常抛出定时器）。

## 4. 自举流程（0.58–0.63.0）

**默认自动执行（0.63.0 恢复）**：`autoBootstrap` 默认 `'auto'` —— 启动时自动探测本机端点、
按平台补齐运行时与模型。0.62.4–0.63.0 曾默认 `'off'`（完全手动），因会连带关掉系统运行时
采纳而回退。下面是自动流程：

```
1. 本机端点发现（endpoint-discovery.ts）
   127.0.0.1: Ollama 11434 / LM Studio 1234 / llama.cpp 8080 / 通用 8000
   → 列模型 → 挑 embedding 模型 → 真算一次向量 → 维度与当前模型一致才采用（零下载）

2. 若没有现成端点，按环境决策（planVectorBootstrap，纯函数可测）
   系统已有 llama-server（任意平台）→ 只补模型
   Termux + pkg                 → pkg install -y llama-cpp → 只补模型
   autoBootstrap: 'always'      → 托管下载运行时 + 模型（桌面端 'auto' 不走这条）
   autoBootstrap: 'off'         → 全部跳过（手动模式）
   Termux 无系统运行时 + 无 glibc → 走 pkg 装 bionic 运行时（绝不下载 glibc 托管运行时）

3. 启动托管服务
   端口被占 → 自动回退到下一个空闲端口（显式 spawn.port 除外）
   失败 → 只记日志，检索退回词法，绝不挡住宿主启动
```

产物与日志：`<installRoot>/bootstrap.log`（决策 + 发现 + 安装进度）、
`<installRoot>/llama-server.log`（后端输出）。相关模块：
`platform.ts` / `endpoint-discovery.ts` / `embed-install.ts` / `embed-server.ts` /
`index.ts` 的 `runBootstrapFlow`。

## 5. 平台矩阵

| 能力 | Linux (x64/arm64) | Termux (Android, glibc) | macOS | Windows |
|---|---|---|---|---|
| 本机 llama-server | ✅ | ✅（自动 `$PREFIX/glibc/lib/ld-linux-*` 包装） | ✅ | ✅（zip 发行包） |
| 无 glibc loader 时 | 直接执行 | 明确报错（提示装 glibc 或 `glibcWrap:'off'`） | — | — |
| CPU 核数探测 | `os.cpus()` | 为空时兜底 `availableParallelism`→4 | 同 Linux | 同 Linux |
| 磁盘/权限自检 | ✅ | ✅ | ✅ | ✅ |
| 孤儿清理 / pid 身份校验 | ✅ `/proc` | ✅ `/proc` | 不启用（保持旧行为） | 不启用 |
| 安装后冒烟 | ✅（Termux 走 loader） | ✅ | ✅ | ✅ |
| 系统 llama-server 自动发现 | ✅ | ✅ | ✅ | ✅ |
| 自动装 llama.cpp | 提示命令 | ✅ `pkg install` | 提示 `brew install` | 提示 winget/choco |
| 本机端点发现 | ✅ | ✅ | ✅ | ✅ |
| 端口冲突回退 | ✅ | ✅ | ✅ | ✅ |

## 6. 对外事件（可组合点）

```
memory/record-saved      { scope, id, kind, chars, deduped }
memory/recalled          { query, hits, topScopes, vector }
memory/record-forgotten  { scope, ids }
```

- 经宿主 `ctx.emit` 转发；拿不到 `ctx.emit` 时降级为进程内广播。
- payload 只含元数据（不含正文），emit 永不抛，监听器异常不影响主流程。

## 7. 排障入口

1. 面板「向量服务 → 环境自检」：平台 / glibc loader / 后端 / 磁盘 / 权限逐条 `✓ ✗ —`。
2. `~/.dsh/memory-vector/llama-server.log`：子进程真实日志（秒退时末尾会带进主日志）。
3. 状态字段：`lastError`、`restarts`、`unavailable`、`wrapped`（是否 glibc 包装）。
4. 测试：`node --test source/*/test/*.test.ts`（CI 在 ubuntu + Node 24 上跑同一命令）。

## 8. 版本与发布（本仓库为唯一源头）

本仓库是唯一维护源：代码、Release、Issue、安装与更新都在
**[HANPU5838/dsh-memory](https://github.com/HANPU5838/dsh-memory)**。
发布流程（不依赖 npm / 任何第三方仓库）：

```bash
# 1) 改版本号：package.json 的 version + build/verify scripts 三处 + CHANGELOG 新条目
# 2) 构建与验收
npm run build
npm test
npm run verify:all
# 3) 提交、打 tag、推送；在 GitHub Releases 写说明
git commit -am "release: v<新版本>"
git tag -a v<新版本> -m "v<新版本>"
git push origin main --tags
```

安装 / 更新端只认本仓库 spec（`github:HANPU5838/dsh-memory`）；升级走「先移除再安装」的
热更新路径（见 README「更新到最新版」），记忆数据不受影响。

## 9. 图增强检索（0.65.0）

词法通道只看字面重合，向量通道只看整句语义相似度 —— 两者都看不到「记忆之间共享实体」
这层关联。0.65.0 增加了一条**图增强通道**（GraphRAG / HippoRAG 风格）：

```
候选（词法 + 向量）
   ↓ 取 top-N 作为种子
建图（当前可见记录）:
   节点 = 记录；边 = 共享实体（idf 加权）/ 修正谱系（supersedes）
   ↓
Personalized PageRank（带重启随机游走，alpha=0.85，最多 24 次幂迭代）
   ↓
相对分 ≥ 8% 的未命中节点 → 补充候选（低相关度 0.22–0.60，不压过真命中）
   ↓
作为 RRF 的额外通道参与融合（权重 0.8）→ 结果整形
```

约束：
- **纯函数、确定性**：节点/边按 id 排序，无随机数；同输入逐位相同。
- **不越权**：只对通过本次全部过滤（可见性 / 归档 / 过期 / 类型 / 屏蔽）的记录建图，
  补召回不会绕过权限与屏蔽。
- **有界**：实体数 ≤24/条、边 ≤24/条、迭代 ≤24 次，手机毫秒级。
- **可关**：`retrieval.graphExpansion.enabled: false` 完全回到旧行为；参数见 README 配置示例。
- **可观测**：`memory/recalled` 事件新增 `graphExpanded`（本次图增强进入结果的条数）。
- **实体消歧（0.76.0）**：抽取层支持反斜杠/重复分隔符路径；图节点键经 `canonicalEntityKey()`
  统一 path / url / tag / version 写法，不同写法的同一实体共享节点与多跳边。
- **语义层偏好（0.75.0）**：巩固产物（tag=consolidated）终态分乘 `1+retrieval.semanticLayerBoost`
  （默认 0.04），semantic 记录在与 episodic 记录相关度接近时优先。
- **注入冲突消解（0.83.0）**：`resolveInjectionConflicts()` 在渲染前淘汰同批命中的冲突败者
  （重要度→更新时间→id 确定性），败者保留不删、审计 reason=conflict。
- **图边权与社区（0.82.0）**：边权乘实体类型因子（具体对象 > 泛标签）；`detectCommunities()`
  标签传播划分主题社区，补充候选按社区限流（`maxPerCommunity`，默认 3）。
- **上下文摘要统一（0.87.0）**：逐轮召回与 L1 会话摘要共用 `digestForRecall()`（TextRank 选句），
  消除「召回是摘要、摘要是截断」的双实现。
- **召回摘要（0.81.0）**：`summarize.ts` 对超预算正文做 TextRank 抽句（近重复去重 +
  查询相关句强加权），只抽取原文、不编造，`eval:summarize` 守住关键句保留率。
- **词法 PRF（0.80.0）**：`prfTokens()` 从首轮 top 文档选稀有共现词做二次 BM25；
  只在首轮候选稀疏（≤2）时启用，扩展候选低分 + RRF 权重 0.6，避免噪声。
- **评测与调参（0.68/0.77）**：`npm run eval:graph` 守住桥接召回；`npm run eval:tune` 单因子
  扫描图增强与语义层参数，默认值在扫描区间内稳健（见 docs/verification.md §1.5）。

### 可解释性（0.67.0）

图增强补召回的记忆在检索结果里带 `graphExpanded: true`；注入侧汇总成 `RecallResult.graphExpanded`
并写进召回审计条目的 `graph.expanded`，面板「审计 → 检索与过滤」直接展示「图增强多跳：N」。
链路：`search() → MemoryHit.graphExpanded → injector 统计 → audit.graph → 面板详情`。

### 自适应权重与评测（0.68.0）

图增强的 RRF 通道权重不再是固定值：`graphWeightFactor(queryProfile)` 按查询画像返回
0.5–1.05 的系数（代码/标识符型查询降权、自然语言提权），乘在 `retrieval.graphExpansion.weight` 上。
`npm run eval:graph` 用合成「实体桥接」语料对比开关（桥接召回 0% → 100%、无关记录 0.00），
作为回归参考进 CI，不对外承诺跨语料分数。
