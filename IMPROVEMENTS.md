# 本仓库相对上游的改进

本仓库是 [RestRegular/dsh-memory](https://github.com/RestRegular/dsh-memory) 的镜像，
在上游 **v0.30.1** 基础上做了一批**平台适配与健壮性改进**（有源码改动 + 回归测试，不是临时补丁）。
上游 npm 包 `@restregular/dsh-memory@0.30.1` 不含这些改动。

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
