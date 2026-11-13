# 架构说明（本仓库维护版 0.62.4）

> 本文说明这套记忆插件「为什么是插件」：哪些属于宿主、哪些属于插件、平台差异放在哪里。
> 上游 `@restregular/dsh-memory@0.30.1` 的原始设计见其 README；本仓库在上游之上做了
> 平台适配层、可插拔嵌入后端、事件总线与可靠性收尾；0.32–0.41 又加入了语义认知层、
> 检索整形（BM25/RRF/MMR）、记忆强度算法、健康度/冲突中心、可疑写入隔离与**智能关系分析**（清单见 [IMPROVEMENTS.md](../IMPROVEMENTS.md)，分析架构见 [analysis.md](analysis.md)）。

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

## 4. 自举流程（0.58–0.62.4）

**默认不执行（0.62.4 起）**：`autoBootstrap` 默认 `'off'` —— 启动时既不探测本机端点、
也不装包/下模型，向量后端由面板「下载并安装」显式发起。下面是显式设为 `'auto'`/`'always'`
后的流程：

```
1. 本机端点发现（endpoint-discovery.ts）
   127.0.0.1: Ollama 11434 / LM Studio 1234 / llama.cpp 8080 / 通用 8000
   → 列模型 → 挑 embedding 模型 → 真算一次向量 → 维度与当前模型一致才采用（零下载）

2. 若没有现成端点，按环境决策（planVectorBootstrap，纯函数可测）
   系统已有 llama-server（任意平台）→ 只补模型
   Termux + pkg                 → pkg install -y llama-cpp → 只补模型
   autoBootstrap: 'always'      → 托管下载运行时 + 模型（桌面端 'auto' 不走这条）
   autoBootstrap: 'off'（默认）  → 全部跳过，bootstrap.log 记 decision=none + 安装提示

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

## 8. 从上游同步

```bash
git remote add upstream https://github.com/RestRegular/dsh-memory
git fetch upstream && git rebase upstream/main
node tools/build-single-package.mjs --scope @restregular --version <新版本> \
  --repo https://github.com/HANPU5838/dsh-memory
node --test source/*/test/*.test.ts
```

上游若已收录某条改进，从 [IMPROVEMENTS.md](../IMPROVEMENTS.md) 删掉对应行，避免重复。
