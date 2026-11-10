# 更新日志

本项目的版本记录。安装 id 与 npm 版本一一对应。

## 0.33.0 — 记忆强度算法 · 时间有效性 · 周期巩固（本仓库维护，2026-11-10）

**算法层**
- FSRS 式保持度：`R=(1+t/(9S))⁻¹`，`stability/difficulty/utility/useCount` 进记录（老记录零迁移）
- 取用反馈闭环：只有 `memory_get` 取用才更新 utility/stability（召回不计分）
- 可解释强度排序：相关度 × 保持度 × 效用 × 重要度 + breakdown；`strengthRanking:false` 可回退
- 动态混合权重（查询画像）+ Rocchio 查询扩展（默认关）
- 矛盾置信度：`sim × (0.65·数值/标识符差异 + 0.35·关键细节冲突)`
- 事实有效期：旧事实被推翻 → `validUntil=now` 失效但保留历史
- 周期巩固：余弦聚类 → 抽取式合并（supersedes 基底 + 其余时间失效 + consolidatedFrom/generation）

**接线 / 配置**
- search：有效期过滤、时间权重、动态融合、强度排序、可选扩展；历史浏览不整形
- save 初始化强度字段；memory_get 反馈；applyCognition 冲突失效；housekeeping 周期巩固
- ANN 热路径接线（后台建图、自动回退、增量更新；默认关）
- 新配置：`retrieval.strengthRanking/temporalWeighting/expansion`、`vector.ann`、`cognitive.consolidation`

**测试**：896 例 / 895 pass / 1 skip / 0 fail（新增 122 例）。

## 0.32.0 — 语义认知层 · 检索整形 · 嵌入性能（本仓库维护，2026-11-10）

> 本版把「档案式记忆」升级为**会整理、会遗忘、可回滚**的记忆系统，并把本地嵌入压到实际可用。

**认知层（写侧）**
- 语义近重复合并：余弦 ≥0.92 且关键细节一致 → `supersedes` 血缘 + `generation+1`（旧记录保留）
- 冲突检测：0.75~0.92 或数字/路径/标识符不一致 → `conflictWith` 标记，绝不自动改内容
- 谱系：`generation` / `supersedes` / `lineage(id)` 前后代遍历
- 生命周期：`dormant` 休眠、`tombstone` 软删（30 天可 `restore`）、`purgeTombstones`、`snapshot/restore`
- 维护任务统一：过期清理 + 容量淘汰 + 休眠标记 + 墓碑清理（归档会话作用域冻结）

**检索整形（读侧）**
- 地板分（作用于匹配强度，不误杀旧记忆）、同义结果合并（0.85）、MMR 多样性（λ=0.7）
- 查询长度自适应阈值 + 跨 scope 分数校准
- 离线评测：`recall@k / MRR / nDCG@k` + CSV

**嵌入性能**
- 批量嵌入 + 单条回退（识别 llama-server 超长输入的 HTTP 500 + body 特征）
- 文档向量持久缓存 + 查询 LRU：文档热命中 0.34ms、查询热 P50 0.03ms
- 启动预热 + 周期探活保活
- 纯 JS HNSW ANN 模块（可选 hnswlib-node，缺失自动退化；20k 查询 14.6×/召回 94%）
- 本地 chat 模型重排（可选，失败静默回退）

**行为变更（注意）**
- `memory_forget` 默认改为**软删**：记录进入墓碑，30 天内可用 `restoreRecord(id)` 恢复；到期由维护任务物理删除。
- 检索结果默认做地板分/去重/MMR；面板历史浏览不整形（看全部命中）。
- 既有 JSONL 数据零迁移（新字段全部可选）。

**测试**：771 例 / 770 pass / 1 skip / 0 fail（新增 137 例）。

## 0.31.0 — 平台适配 · 插件化 · 可靠性（本仓库维护，2026-11-08）

> 上游 `@restregular/dsh-memory` 的 npm 最新版仍是 0.30.1；本版本是本仓库在其之上的完整改进，
> 详情见 [IMPROVEMENTS.md](IMPROVEMENTS.md) 与 [docs/architecture.md](docs/architecture.md)。

**平台适配**：symbolic-link 安全的 tar 解压（llama.cpp 的 SONAME 链）、Termux glibc 自动包装
（不再依赖仓库外猴补丁）、默认 `-b/-ub 2048`、查询嵌入预算自适应、`storeDir` 绝对路径、
CPU/内存/磁盘/权限探测统一到 `platform.ts`。

**插件化**：可插拔嵌入后端（`local` / `openai` / `ollama` / `off`，面板可运行时切换并持久化）；
记忆事件总线（`memory/record-saved` / `recalled` / `record-forgotten`，经宿主 `ctx.emit` 转发）；
面板「环境自检」；面板 provider 下拉。

**可靠性**：安装后 `llama-server --version` 冒烟；下载断点续传 + 大小/sha256 校验；
孤儿进程清理（SIGTERM→SIGKILL，cmdline 校验防误杀）；自愈重拉；端口预检；
`flush` 写盘异常不冒泡；只读目录锁死循环修复；`.vec` 维度校验与压缩；访问统计落盘。

**工程**：CI（ubuntu + Node 24，`node --test`）；发现索引（`scopes.index.json`，避免每 60s
全量读所有作用域文件）；既有压缩包按 sha256 复验；面板显示自愈重拉次数；测试 630+ 例。

## 2026-11-08（第三批）— 可靠性收尾：下载续传/完整性、安装冒烟、孤儿清理、provider 切换、CI

- **下载断点续传**：同源 `.part` 续传（`Range` + `If-Range`，206 追加 / 200 覆盖 / 416 重下，换源不续）；`Content-Encoding` 不影响校验基准。
- **完整性校验**：声明总长 vs 落地字节；可选 `modelSha256` / `runtimeSha256`（字符串或按资产名），不匹配即 error 并删残片。
- **安装后冒烟**：模型就位后 `llama-server --version`（Termux 自动 glibc 包装，4s 超时），失败 → error + stderr 尾部并摘掉 exe。
- **孤儿清理**：启动时清理「pid 存活 + cmdline 是 llama-server + /health 不通」的残留进程（SIGTERM → 3s 后 SIGKILL），cmdline 不符/非 Linux 不误杀。
- **面板切换 provider**：`POST /provider` + 服务卡片下拉，运行时切 local/openai/ollama/off，持久化 `<storeDir>/vector.json`（显式配置优先）。
- **CI**：`.github/workflows/ci.yml`，ubuntu + Node 24 直接跑源码测试。
- 测试：新增 22 例；全套 **629 例 / 628 pass / 1 skipped**。

## 2026-11-08（第二批）— 插件化改造：平台适配层 / 可插拔嵌入后端 / 事件总线

- **A. 平台适配层 `platform.ts`**：Termux 检测、`$PREFIX`、glibc loader、CPU 核数兜底（`os.cpus()` 为空时用 `availableParallelism`，再兜底 4）、可用内存（MemAvailable 与 cgroup 取小）、ELF `PT_INTERP` 解析、磁盘余量、目录可写性，统一出口。`embed-server` / `hardware` / 面板共用；面板「向量服务」新增**环境自检**（平台 / glibc / 后端 / 磁盘 / 权限，逐条 ✓·✗·—）。
- **B. 嵌入后端可插拔 `embedding-providers.ts`**：`local`（默认，本机 llama-server）/ `openai`（兼容 `/v1/embeddings`，自动 Bearer）/ `ollama`（`/api/embeddings`）/ `off`（纯词法，永不联网）。只有 `local` 创建子进程管理器；provider 未配置时按 endpoint 推断（回环 = local，远程 = openai）。
- **C. 记忆事件总线 `events.ts`**：对外发 `memory/record-saved` / `memory/recalled` / `memory/record-forgotten`，`apply.ts` 经宿主 `ctx.emit` 转发（不可用时降级进程内广播）；payload 只含元数据、emit 永不抛。
- 修复：`hardware.ts` 的核数探测在 Android 上可能为 0（→ NaN 推荐），改用平台适配层兜底。
- 测试：新增 `platform.test.ts`(4) / `embedding-providers.test.ts`(15) / `events.test.ts`(10) / `provider-config.test.ts`(3)；全套 **607 例 / 606 pass / 1 skipped**。

## 2026-11-08 — 平台适配与健壮性改进（本仓库维护，上游尚未收录）

> 这一批是本仓库对项目的**实质性完善**，不是临时补丁：安装器、服务生命周期、存储层、检索超时都有对应源码改动与回归测试。
> 上游 npm 包 `@restregular/dsh-memory@0.30.1` 不含这些改动；清单与上游同步方法见 [IMPROVEMENTS.md](IMPROVEMENTS.md)。

**安装器（embed-install）**
- tar.gz 符号链接/硬链接：两遍写盘 + 多轮重试（链接可能互相依赖），软链建不出来（FAT/exFAT、共享存储）自动退化为复制真实文件；越界链接目标直接拒绝。llama.cpp 的 Linux 包靠两级 SONAME 软链，缺了就 `cannot open shared object file`。
- 解压后校验：跟随 `stat` 检查运行时目录里的 `*.so*` / `*.dylib` 链接是否都能解析，失败即 `phase:'error'` 并写明缺哪个库、原因。
- 磁盘预检：下载 400MB+ 之前检查可用空间（模型×1.25 + 运行时预留 + 200MB），不足直接报错并给出需释放的容量。

**后端生命周期（embed-server）**
- Termux/Android glibc 自动包装：Linux 上读 ELF `PT_INTERP`，若解释器（如 `/lib/ld-linux-aarch64.so.1`）不存在而 `$PREFIX/glibc/lib/` 下有对应 loader，则自动用 `loader --library-path ... <exe>` 启动。仓库内自给，不再依赖仓库外的猴补丁。
- 端口预检：spawn 前探测 host:port，被占则明确报「端口被占用」而不是 60 秒超时。
- 自愈：异常退出按 1s/5s/30s 退避重拉最多 3 次；`stop()` 后绝不重拉；耗尽后暴露 `unavailable` + 原因。
- 身份校验：Linux 上 adopt/kill 前读 `/proc/<pid>/cmdline`，PID 被复用则既不接管也不误杀。
- 默认参数：`-b 2048 -ub 2048`（默认 512 会拒绝 >512 token 的记录并静默熔断）；spawn 失败（`ENOENT/EACCES`）不再被 60 秒超时掩盖，`waitUntilReady` 立刻失败并打印真实原因。

**存储（store）**
- `flush()` 写盘异常不再冒泡：ENOSPC/EACCES 只 warn，增量保留下次重试（原来从 unref 定时器抛出成 uncaught，宿主会 `exit(1)` 带走整个 DSH）。
- 只读目录下的锁死循环：`openSync(lock,'wx')` 的 EACCES/EPERM 只有锁文件确实存在才按竞争处理，否则直接抛错（原实现 100% CPU 空转）。
- `.vec` 载入按身份头维度逐条校验，丢弃被截断的错维向量；边车写入时清理已删除记录的条目（不再只增不减）。
- 访问统计落盘：`accessCount` / `lastAccessedAt` 进入增量（它们是 recency / accessBoost 的排序输入）。

**检索与配置**
- 查询嵌入预算自适应：首查超时用更大预算重试一次，成功后把预算固定在「实测×3」（上限 4s），慢设备（ARM 手机）不再每次交互检索都降级成词法。
- `writeTimeoutMs` 10s→20s、`backfillTimeoutMs` 30s→60s、`backfillBatchSize` 32→8（CPU 上长内容/大批量更不容易整批超时）。
- `storeDir` 默认改为绝对路径 `~/.dsh-memory`：相对路径会跟着 cwd 走，换个目录启动就是一套空库，cwd 只读时 provider 还会静默消失。

**文档**：修正 7 处「五个模型工具」为「六个」；镜像横幅如实说明相对上游的改进。

测试：**575 例 / 574 pass / 1 skipped**（跳过的是需要真实 Windows 发行包的 fixture）。

## 0.30.1 — 修复 CUDA 运行时安装把 cudart 伴生包当成主包（issue #4）

- **问题（issue #4）**：面板选「CUDA（显卡）」点「下载并安装」，报「安装失败：解压完成但没找到 llama-server.exe：cudart-llama-bin-win-cuda-12.4-x64.zip 的目录结构可能变了」。根因是资产匹配正则**只锚了结尾、没锚开头**：CUDA 主包 `llama-b<构建号>-bin-win-cuda-12.4-x64.zip` 与伴生包 `cudart-llama-bin-win-cuda-12.4-x64.zip` 共享同一段 `-bin-win-cuda-12.4-x64.zip` 后缀，而 llama.cpp 的 release 资产顺序**不保证**主包在前（b12023 实测 cudart 一族排在 `llama-*` 之前）。安装器按数组顺序取第一个命中，于是把只有 cudart / cuBLAS 的伴生包当成运行时：约 267 MB 的 CUDA 主包没下，解压出来当然没有 `llama-server.exe`；随后 companion 正则又命中同一个文件，「复用」后错误信息里就出现了 cudart 包名。Linux 的 `cudart-…-bin-ubuntu-cuda-12.8-…tar.gz` 同理。
- **修复**：`runtimeAssetPattern` 所有主包分支补开头锚定（win32 / linux / darwin × cpu / vulkan / cuda，如 `/^llama-.*-bin-win-cuda-12.4-x64\.zip$/`），伴生包保持 `/^cudart-.*…/`，两类正则从此互不重叠；构建号仍写在中间、不硬编码。只有 cudart、没有主包的发行版会走既有的「找不到风味包 → 退回 CPU 包并说明原因」分支，而不是装出一个缺 exe 的目录。
- **已踩过坑的用户**：旧版误下的 `cudart-llama-bin-…zip` 正好就是新版要用的伴生包，重试时按「已存在，跳过下载」直接复用（不再白下约 373 MB），主包另下后两个包一起解压，`llama-server.exe` 落地即装完。
- 测试：`test/model-install.test.ts` 用 b12023 的 38 个真实资产名做回归——cudart 排在主包前时 CUDA 主包仍选中 `llama-*`、companion 选中 `cudart-*`；4 个受支持平台组合（win32 / linux × x64 / arm64）全覆盖；名单倒序不影响结果；6 平台 × 4 风味遍历全名单验证主包 / 伴生包正则互斥。`test/embed-install.test.ts` 的正则逐字断言同步为首尾锚定，并新增**离线全流程**用例：把 cudart 放在资产列表最前，用注入 fetch 跑完「查发行版 → 下主包 + 伴生包 → 解压 → 下模型」，断言真正请求的是 `llama-*` 主包且最终 `phase=done`、`llama-server.exe` 落地（旧代码在这个用例上必红）。另用 b12023 线上 release JSON 实跑确认 win32-x64 CUDA → `llama-b12023-bin-win-cuda-12.4-x64.zip` + `cudart-llama-bin-win-cuda-12.4-x64.zip`。全套 541 tests / 540 pass / 1 skipped（`multiprocess.test.ts` 需真起子进程）。

## 0.30.0 — 会话作用域绑定会话生命周期（创建自动建 / 归档即冻结 / 恢复即复原）

- **问题**：会话作用域此前只在第一次写记忆时才懒创建，且与宿主的会话生命周期完全脱节 —— 会话归档后，它的 `session:<id>` 作用域与记忆仍然"存在"，跨作用域检索、面板、`memory_get(id)` 都能碰到；恢复 / 归档也没有任何可见语义。用户想要的是：会话创建时作用域就已存在，归档时连同记忆一起冻结，恢复后原样回来。
- **创建**：`provider/apply.ts` 订阅宿主 `session/created`（顶层会话；子 Agent 沿用父会话作用域），调用新增的 `ensureSessionScope(sessionId)` —— 只写 `scope-meta`（用途：「会话作用域：仅本会话可见的过程记忆；随会话归档与恢复（系统自动创建）」/ `createdBy: system` / `status: ready`），**不写任何记忆**，幂等、不覆盖用户改过的用途。监听器全程 try/catch：`session/created` 抛错会回滚会话创建，记忆侧失败绝不能影响宿主。启动时 `ctx.inject(['sessions'])` 给已存在的会话补建。
- **归档 = 冻结（实时判定，不复制状态）**：`LocalMemoryService.setArchivedSessionLookup()` 注入对宿主 `workspaceRegistry.archivedSessionIds` 的**实时**读取（不缓存、不落盘）。`authorize()` 新增 `archivedScopes` 上下文：归档作用域 `discover` 仍允许（目录/面板要能看出「已归档」），`read` / `write` / `delete` 一律 `SCOPE_ARCHIVED`（`requestable=false`，没有审批放行路径）。`search` / `list` / `listSync` / `getByIds` 直接跳过归档作用域 —— 不是过滤结果，而是根本不加载它的 store，所以恢复时无需重建索引。
- **归档期间不清理**：小时级 housekeeping（过期记录清理 + 容量淘汰）与 dispose 时的清理都跳过归档作用域（新增 `runHousekeeping()` 作为定时器与测试共用的入口）；数据文件 `.jsonl` / `.vec` 原样保留。
- **目录与面板**：`scopeCatalog` 每项新增 `archived?: boolean`，`accessStatus` 新增 `'archived'`；归档作用域的 `records` 仍返回（归档不是权限边界，条数可见），`readable/writable/canRequest*` 恒 false。`memory_scopes` 渲染成「N 条 · 已归档 · 恢复会话后自动恢复读写」；面板「记录 → 作用域」每行显示「已归档」徽标（`/status` 透传 `archived`）。
- **恢复**：宿主归档集合移除该 id 后，下一次判定就恢复正常 —— `search` / `list` / `getByIds` 立即可用，`memory_get` 按原 id 可取，`authorize` 回到普通策略。没有任何"恢复动作"需要执行。
- 测试：新增 `source/memory-local/test/session-archive.test.ts`（3 个用例：自动创建与幂等 / 归档冻结与恢复复原 / 冻结期间不清理），覆盖 `search`、`listSync`、`getByIds`、`authorize`、`scopeCatalog`、`save` 拒绝与数据文件保留；全套本地 / 工具 / 注入 / 面板测试通过（`multiprocess.test.ts` 需真起子进程，在受限沙箱里 EPERM，与本改动无关）。

## 0.29.0 — 作用域用途 / 别名可编辑（用户 + Agent）

- **问题**：0.28.0 之后「作用域用途」成了检索范围外清单里唯一的信息来源，但它**只能写不能改**——Agent 想补一句用途只能靠 `memory_save` 的 `scopeDescription`（还要顺带写一条记忆），面板则完全没有编辑入口；别名更只在 `memory_save({ path })` 那一瞬间能设，设错了只能改文件。于是第一次随手写的用途会一直错下去。
- **Agent：`memory_scopes` 新增 `action="edit"`**：`scope` 必填，`scopeDescription` / `scopeName` 至少给一个（省略 = 这次不动它，空串 = 清空用途 / 移除别名）。写权限与写入记忆同一把锁（`write` 开关 / 绝对限制 / 范围外），**范围外不弹隐式审批**——编辑元数据不是一条可勾选的记忆，改为明确提示先用 `action="request", permissions:["write"]` 申请。结果只回「改成了什么」（`{ scope, description?, name? }`），渲染成「用途：… / 别名：…」，空串分别渲染成「已清空（回退到按类型的默认描述）」「已移除」。
- **用户：面板「记录 → 作用域」每行「编辑」**：用途 textarea + 别名输入框（global / session 不显示别名字段，并说明原因）+ 保存 / 取消；保存走新增的 `POST /memory/api/scope-meta`，成功后重新拉 `/status`（别名会影响展示名与下拉）。用途编辑框**只预填手写的那句**：`/status` 新增 `descriptionSource: 'custom' | 'default'`，按类型补的默认描述不预填（否则一保存就把默认文案固化成手写内容）；别名留空保存即移除。
- **provider**：`describeScope` 的空白描述从「报错」改成「清空」（写空串，**保留 createdAt / generation / createdBy** —— 删元数据会让按 generation 绑定的会话授权失效）；`scopeCatalog` 对空描述回退到按类型的默认描述，与「从没写过」展示一致。新增 `renameScope(scope, name)`：非空走 `ScopeNames.claim`（统一校验、重名 `SCOPE_NAME_TAKEN`），空串 / undefined = 移除；`global` / `session` 拒绝（`SCOPE_NAME_UNSUPPORTED`，显示名跟随类型与会话 id）；别名仍可当作用域参数用（`scopeKeyForName`）。
- **接口**：`POST /memory/api/scope-meta { scope, description?, name? }`——只允许改目录里看得见的作用域（未知作用域 404，避免把用途写到一条永远读不到的元数据上），什么都没给 400，旧 provider 501；`/memory/api/status` 每项新增 `descriptionSource` 与 `name`（别名），「删光记录但写过用途」的行也带别名。
- **讲清楚**：注入的「记忆系统」常驻段新增一条「用途与别名可以改」；`memory_scopes` 的工具说明与三个 editing 参数的说明同步。
- 测试：新增 provider「清空保留 generation / 目录回退默认描述」「别名设置 / 移除 / 重名 / 非法名 / global、session 拒绝」、工具「edit 更新两项 / 只改一项 / 空串清空 / 两个都没给报错 / 范围外要求先申请写权限」、面板「POST /scope-meta 往返 / 404 / 400 / 501」「作用域页编辑保存与默认描述不预填」等用例；全套 533 tests / 532 pass / 1 skipped（`multiprocess.test.ts` 需真起子进程）。

## 0.28.0 — 范围外命中只列作用域；面板「记录」页拆成记忆 / 作用域两个子标签页

- **问题（真机工具结果）**：0.27.0 的 `outOfScope` 给的是**条目索引**（id / score / 类型 / 标签 / 短摘要），于是 `memory_search` 的结果里会跟出一大段范围外记忆的摘要——它们既不是可见结果的延续，又长得跟普通命中一样，模型很容易把这段摘要当成「已经读到的内容」直接引用。同一段文字还出现两次：清单头写「范围外命中：…（各几条）」，末尾的 `withheld` 说明又写「另有 N 条…索引已列在**下方**」——实际它排在最后，结构和顺序都是乱的。
- **检索只给作用域**：`outOfScope` 收窄成 `{ scopes: [{ scope, records, description, requestable }] }`。**不再返回任何条目级信息**（连 id / 摘要都没有）——范围外只暴露「命中了哪个作用域、几条、这个作用域是干什么的、能不能走审批」。`description` 与 `memory_scopes` 目录同源（`scope-meta` 手写优先，没写过按类型补 0.27.0 的默认描述），`requestable=false`（用户关掉可读 / 作用域被关闭）的条目标成「不可申请」，避免模型去走一条走不通的审批。
- **渲染不再重复**：清单单独成块，一行一个「名称（条数 · 可申请性）：用途」，头部写「只列作用域与用途，不含条目内容：N 个作用域 / M 条」，尾部只留一条取正文的路径说明；有清单时**不再叠加** `withheld` 的 `out-of-scope` 那段（同一件事说两遍），旧文案里「索引已列在下方」的错序也消失。
- **面板记录页拆两个子标签页**：`记录` 里新增「**记忆** / **作用域**」二级切换。记忆侧保持原样（统计 / 工具栏 / 语义检索 / 新建 / 列表）；作用域侧列出每个作用域的名字（带 `global:` / `project:` / `session:` / `custom:` 前缀）、**用途**、记忆条数、待嵌入与最近更新时间，支持按名称 / 用途 / 键筛选，点「查看记忆」直接切回记忆子标签页并按该作用域过滤。`/memory/api/status` 每项新增 `description`（来自 `scopeCatalog`；没写过用途的作用域按类型补默认描述），并补上「删光记录、但写过用途」的作用域（0 条也列出）；默认三路里尚未落盘的 global / 当前项目不会凭空多出来。
- **讲清楚**：注入的「记忆系统」常驻段与可见域等级文案同步（范围外只剩作用域用途，没有摘要可引用）；`memory_search` 工具说明与 `requestApproval` 参数说明同步。
- 测试：改写 8 处旧断言（`outOfScope.records` → 作用域级 `scopes`），新增「用途取自 scope-meta 目录 / 不可申请标注」「`/status` 带用途」「删光记录但写过用途的作用域仍列出」「记录页记忆 / 作用域子标签页与「查看记忆」过滤」等用例；全套 526 tests / 525 pass / 1 skipped（`multiprocess.test.ts` 需真起子进程）。

## 0.27.0 — 范围外命中「先索引后审批」：检索不再自动弹审批；作用域目录默认描述

- **问题**：普通限制下 `memory_search` 撞到范围外命中会**立刻弹审批**，Agent 完全没有判断依据——它还不知道范围外有什么、值不值得读，用户就要先回答一次「允许 / 拒绝」。一次跨作用域的检索动辄打断用户；而审批卡上列的正文快照又太重，多数时候用户看完只是拒绝。反过来，`scopeCatalog` 里的作用域描述全靠创建者手写，没写过的目录条目一律「（未填写用途）」，Agent 想靠目录判断「这个域是干什么的」时没有信息。
- **检索默认只给索引**：范围外命中不再触发审批，改为在结果里新增 `outOfScope` 字段——命中了哪些作用域、各几条（`scopes` 聚合），加上每条的**记忆索引**（`records`：id / score / 作用域 / 类型 / 标签 / 更新时间 / 短摘要，**不含正文**）。渲染上索引独立成块，尾部注明这是「目录印象」并给出取正文的路径。`withheld` 的口径同步细分：未发起审批的范围外命中报 `out-of-scope`（新原因，提示「索引已列出，确认后再显式申请」），审批后的结局（partial / rejected / timeout）与 absolute / read-disabled / scope-disabled 沿用原口径。
- **审批改为显式发起**：`memory_search` 新增 `requestApproval` 参数（默认 false）。Agent 看完索引确认确有需要的内容后，带 `requestApproval=true` 重发同一次查询——这时才向用户发起审批，允许的条目照旧并入 `records`（0.26 行为），没被允许的继续留在索引里。`memory_get` 拿范围外 id 读正文**本来就是显式访问**，审批路径不变；`memory_scopes request` 申请作用域会话权限的路径也不变。绝对限制下**不返回任何索引**（没有审批放行路径，索引只会引诱越权尝试）；普通限制下的 description 必填校验照旧——校验的是「这次调用的用途」，与要不要弹审批无关。
- **作用域目录默认描述**：`memory_scopes list` 里没写过用途的作用域不再显示「（未填写用途）」，按类型给一句默认说明——global「跨项目共享的通用事实与偏好」、project「绑定当前工作区路径的共享记忆」、session「仅本会话可见的过程记忆」、custom「按名字聚合的跨会话记忆（建议创建时写明用途）」。Agent 手写过的 `scopeDescription` 永远优先，默认描述不落盘、不写进 scope-meta。
- **讲清楚**：注入的「记忆系统」常驻段新增两步口径（先看索引 → 确认后再 requestApproval=true / memory_scopes request，并提醒「不要凭索引摘要直接引用范围外内容」）；可见域等级说明里 normal 的描述同步改写；`memory_search` 的工具说明与参数说明同步。
- 测试：改写 4 处断言旧行为的用例（tools / access / scope-service / session-visibility），新增「默认只给索引不弹审批」「requestApproval=true 恢复审批」「absolute 无索引」「拒绝后索引保留」「默认描述 + 手写优先」等用例；`source/memory-local/test/multiprocess.test.ts` 按惯例未在受限沙箱跑（需真起子进程）。

## 0.26.0 — 作用域参数接受 `custom:` 展示前缀：自动归一，不再写「幽灵授权」

- **问题（真机复现）**：0.25.10 / 0.25.11 把所有工具输出、注入摘要与面板统一改成展示名 `<类型>:<名字>` 后，自定义作用域在 Agent 眼里只以 `custom:dsh-plugin-dev` 出现；但参数层只放行 `project:` / `session:` 两种前缀，`custom:` 属于键空间之外。于是 `memory_scopes request({ scopes: ['custom:dsh-plugin-dev'] })` 被 `canonicalScope` 原样收下、`grants.add` 只校验权限不校验键形态 —— 一条永远匹配不到记录的 grant 就这样落盘：申请结果渲染成 `custom:custom:dsh-plugin-dev → 已授予`（`scopeDisplayName` 对未知键无条件补 `custom:`），目录里又查不到（`scopeCatalog` 不含 grants），下一次 `memory_search` 重新弹审批。本机 `grants/session-91f4b9f7….json` 里同时躺着 `custom:dsh-plugin-dev` 与 `dsh-plugin-dev` 两条，相隔 35 秒。根因还包括：`memory_scopes request` 是唯一跳过 `normalizeScopeInput` 的作用域入口（其余工具都过 `resolveScope`）。
- **输入层归一**：`normalizeScopeInput` 新增 `custom:` 分支 —— 剥一层前缀后仍按自定义名严格校验（`custom:` / `custom:foo:bar` / `custom:global` 仍 `SCOPE_INVALID`，错误文案提示 `pass the bare scope name`）。`memory_scopes request` 现在和其他工具一样走 `resolveScope`：`custom:handbook` 与 `handbook` 合并成一条申请，`all` 与非法名在弹审批前就明确报错。
- **兜住旧数据**：`canonicalScope` 与 grants 解析用 `normalizeScopeKey` 把 `custom:` 折回裸键，0.25.x 写下的幽灵授权读取时自动生效，不用手工清理；`SessionGrantsStore.add` 落盘前用 `isWellFormedScopeKey` 卡形态；`scopeDefaultName` 对已带前缀的键幂等，不再渲染成 `custom:custom:...`。
- **讲清楚**：注入的「记忆系统」常驻段新增作用域写法说明；`scope` / `memory_scopes.scopes` 的参数说明补「自定义作用域传裸名，展示名会自动归一」；`scope name must not contain ':'` 的错误补可操作提示。README 第 4 节补同口径说明。
- 测试：新增 scope 归一 / 展示幂等 / grants 形态守卫 / 旧数据折回 / 工具端到端归一 / 非法名与 `all` 拒绝等 8 个用例；全套 518 tests / 517 pass / 1 skipped（`multiprocess.test.ts` 需真起子进程）。

## 0.25.14 — 侧边栏给等待记忆审批的会话显示黄点 /「待审批」

- **问题**：范围外记忆审批以前只是插件自己画在 `conversation.input.dock` 的卡片；宿主的侧边栏会话列表并不认识它，所以工具在等审批时，那一行没有系统审批 / ask 工具那样的黄点，也不会被「待审批」水线自动顶出来。宿主这两类阻塞都来自 `ctx.uiSession` 的 pending-interaction 注册表（`dsh-client-ui-approval` 发 `kind:'approval'`，`dsh-client-ui-user-questions` 发 `kind:'question'`）。
- **做法**：客户端新增 `installApprovalPresence`，通过 `ctx.inject(['uiSession'], …)`（等 `uiSession` 就绪，不在 apply 里一次性取样）注册一个 pending-interaction domain；轮询轻量审批摘要，为每条待审批发布一个**合成 interaction** `{ sessionId, kind:'approval', key:'memory-approval:<id>', toolName }`，回答 / 超时后撤销。它**不是** `PendingApproval` 实例，所以宿主的审批卡不会抢着渲染，我们自己的审批卡仍是唯一 UI；但侧边栏黄点、紧凑文案「待审批」、悬停「等待审批」、会话水线提升、以及其它插件对 `uiSession.sessionStatus` 的读取，都和系统审批完全同构。按审批 id 增删，同一会话多条审批互不顶掉；点「拒绝 / 允许」后立即同步一次，不必等下一次轮询。
- **轻量接口**：`GET /memory/api/approvals?summary=1` 新增摘要口径，只回 `id / sessionId / tool / action / mode / createdAt / expiresAt`，不复制条目正文与查询语句；provider 新增 `pendingVisibilityApprovalPresence()`。旧 provider 没有该方法时回退完整列表，客户端只读 id + sessionId，兼容不破。
- **测试**：客户端新增「待审批发布成 approval 类型、空 sessionId 跳过、同一会话多条、回答一条只撤一条、卸载清空」用例；面板新增 `/approvals?summary=1` 的「无正文 / 按会话过滤 / grant mode / 旧 provider 回退」用例。

## 0.25.13 — 「绑定」点一下立即保存；绑定不再往上下文注入提示

- **绑定即存**：记忆权限浮窗里每个作用域的【绑定】按钮以前只是草稿，必须再点「保存」才落盘——用户点完绑定看不出任何反馈，很容易以为没生效。现在点一下就走新接口 `POST /memory/api/bindings` 立即保存（再点一次 = 解除绑定），按钮先乐观更新、失败回滚原状态并把错误显示在浮窗里；「绑定」按钮的 `title` 与浮窗提示行都写清「点一下就保存」。绑定是工作区级设置（本工作区新会话的默认可见范围），与浮窗里「勾选范围 / 可读 / 可写」那份会话级草稿无关，所以**不需要**先设草稿；点「保存」时仍会幂等带上一次绑定，旧客户端 / 老服务端按原逻辑照旧生效。
- **绑定不再注入上下文提示**：`setWorkspaceBindings` 以前会给当前会话排一条「记忆权限已更新」通知。但绑定只影响本工作区**新会话**的默认范围，当前会话自己读什么并没有变，这条通知只会让 Agent 误以为自己刚被重新授权 / 撤销。现在绑定变化**不注入任何提示**；可见范围 / 会话授权的变更照旧通知（`renderPermissionNotice` 不变）。
- **服务端**：`/bindings` 只写工作区绑定，**不动**会话可见范围（这和 `POST /visibility` 带 `bindings` 的语义不同——那条会同时重置 / 写入覆盖）。绑定校验抽成 `normalizeBindings`：只接受具体作用域键（拒绝 `all` / 当前项目 / 当前会话别名）、会话作用域不能绑到工作区、重复项去重，非法输入 400 `SCOPE_INVALID`，缺 `session` 400 `SESSION_REQUIRED`。
- 测试：客户端新增「点绑定即 POST /bindings（不点保存）、再点解除、失败回滚并报错」用例，改写原有「保存带绑定」用例（绑定 POST 与可见范围 POST 分开断言）；面板新增 `/bindings` 路由用例（立即落盘、不改会话覆盖、不排提示、空数组清除、非法输入 400）；`memory-local` 的工作区绑定用例补「绑定变化不往上下文注入提示」断言。全套 507 tests / 506 pass / 1 skipped（`memory-local/test/multiprocess.test.ts` 需真起子进程）。

## 0.25.12 — `memory_save.supersedes` 明确要求传「完整 id」

- **问题**：`supersedes` 的参数说明只有一句英文 `Record id this corrects/replaces`，没说要传完整 id。而检索 / 列表 / 摘要 / 规则索引里显示的 id 全是 **8 位短 id**（`shortId`），`memory_get` 也接受 8 位前缀 —— 模型很容易把短 id 直接塞给 `supersedes`；provider 那边是按 id **精确查找**目标记录（`records.get(id)`），短 id 必然查不到，只会得到 `SUPERSEDES_UNKNOWN`，报错里也没有提示「你用了短 id」。
- **口径**：`supersedes` 的 schema 说明改成明确的中文说明 —— 必须传**完整 id（36 位 UUID）**，不能传 `memory_search` / `memory_list` / 摘要 / 规则索引里的 8 位短 id；手头只有短 id 时先用 `memory_get` 取回（它结果里每段首行的 `[id]` 就是完整 id）。同时把语义写清楚：旧记录标记为「已修正」，默认退出检索 / 规则 / 自动召回，`memory_get` 仍可查历史。
- README 第 2 节「存一条记忆」补同一段说明；`SaveArgs.supersedes` 的注释同步（行为不变，仍是精确 id 查找，不会静默接受短 id）。
- 测试：`source/tool-memory/test/tools.test.ts` 增加守卫用例 —— `supersedes` 的说明里必须出现「完整 id」「8 位短 id」「memory_get」，防止以后再被改回一句模糊英文。全套 505 tests（新增 1）/ 504 pass / 1 skipped（`memory-local/test/multiprocess.test.ts` 需真起子进程）。

## 0.25.11 — 「记忆权限」浮窗里能直接看到真实键；摘要里的自定义作用域补 `custom:` 前缀

- **浮窗露出完整键**：显示名与真实键不一致时（项目别名 → 完整路径、会话短 id → 完整 uuid、自定义名 → 裸键），作用域行的名字下面多一行等宽小字，就是完整键。**不做手工截断**——键保持原样，放不下由 CSS 按容器宽度省略（`text-overflow:ellipsis`），窗口变宽就多显示几个字符。名义上相同（例如没有别名的项目作用域 `project:D:\w` 显示名就是键）则不再重复一行。
- **`title` 统一成「显示名 → 真实键」**：记录卡作用域徽标、记忆树节点、审批卡的作用域 pill、浮窗行名称的悬停提示都按这个格式（显示名与键相同时只给键）。项目作用域因此一眼能看出「别名是哪，路径是哪」。
- **摘要里的自定义作用域**：会话第一步注入的摘要 / 标签索引里，作用域是**紧凑分类词**（全局 / 项目 / 会话）；自定义作用域以前直接吐裸名字（`· handbook`），和分类词混在一起分不清，现在是 `custom:handbook`。
- **不改真实键**：键仍是 `global` / `project:<路径>` / `session:<完整 uuid>` / 自定义裸名，存储、配置、授权、绑定与历史记忆都不迁移，无需重建向量。
- 测试：新增「只有显示名与键不同才渲染键行」「键行靠 CSS 省略、不手工截断」「`scopeTitle` 的显示名 → 键格式」用例与 `.mem-scope-key` 的 CSS 断言；摘要标签用例补 `custom:` 断言；全套 504 tests / 503 pass / 1 skipped。

## 0.25.10 — 作用域名字统一带类型前缀（`global:` / `project:` / `session:` / `custom:`）

- **背景**：作用域名此前是「裸名字」——项目显示成 cwd、会话显示成短 id、global 显示成「全局」、自定义作用域显示成它自己的名字。列表里几种作用域混在一起时看不出种类；尤其 `global:` 与 `custom:` 完全没有前缀可依，因为这两种 scope 的**键本身就不带前缀**（`global` 是个关键字，自定义就是裸名字）。
- **口径**：展示名一律 `<类型>:<名字>` —— `global:全局`、`project:D:\repositories\dsh-memory`、`session:session-1a2b3c4d`、`custom:handbook`。前缀由**类型**决定（`memory-local` 的 `scopeTypePrefix` / `scopeDisplayName`），不猜键的形状；别名与标题只替换冒号后面那一段：`project:<别名>`、`custom:<别名>`、`session:<标题>(session-1a2b3c4d)`。
- **覆盖范围**：`/status` 的 label（面板作用域下拉、记录卡作用域徽标、记忆树）、`/visibility` 与 `/grants` 的作用域标签、「记忆权限」浮窗的每一行（本会话那行现在是 `session:当前会话`）、审计页的会话筛选与锁定会话 pill、审批卡上的作用域 pill（精确键退到 `title`）、以及 `memory_save` / `memory_search` / `memory_list` / `memory_get` / `memory_scopes` 的工具输出（`memory_scopes` 目录里自定义作用域此前渲染成 `自定义「handbook」`，现在是 `custom:handbook`）。
- **保持不变**：注入摘要里的作用域分类标签仍是「全局 / 项目 / 会话」（那是紧凑分类而不是名字）；面向 Agent 的「记忆权限已更新」通知仍用**真实 scope 键**（Agent 要拿它当键用）。
- 测试：新增 `scopeTypePrefix` / `scopeDisplayName` 的四类型单测（global 与自定义的键没有前缀、别名与标题只换名字段）、客户端 helper 用例；`/status` 的四种 label 断言与浮窗「当前会话」断言改成带前缀；全套 503 tests / 502 pass / 1 skipped。

## 0.25.9 — 会话作用域的短 id 改成前 16 位（以前全显示成「会话 session-」）

- **问题**：真机会话 id 以 `session-` 开头，那正好是 8 个字符。以前展示会话作用域时取「id 前 8 位」，于是每个会话作用域都渲染成同一个「会话 session-」——用户无法区分是哪个会话，等于没给 id。
- **口径**：统一改成会话 id 的**前 16 位**，形如 `会话 session-1a2b3c4d`；有会话标题时是 `标题(session-1a2b3c4d)`。规则集中在 `memory-local` 的 `sessionShortId` / `sessionScopeLabel`，服务端与客户端同口径。
- **覆盖范围**（凡是显示会话作用域名字的地方）：`/status` 的 label（面板作用域下拉、记录卡与记忆树）、审计页的会话筛选选项与悬停提示、审计页锁定会话的 pill、以及 `memory_save` / `memory_search` / `memory_list` / `memory_get` / `memory_scopes` 的工具输出。
- **保持不变**：「记忆权限」浮窗里本会话那一行仍是「当前会话」（0.25.8），标签里的裸 scope 键仍留在 `title`；注入摘要里的 scope 分类标签仍是「会话」（那是分类不是名字）。
- 测试：新增 `sessionShortId` / `sessionScopeLabel` 的单测（含 `session-` 前缀的真实 id、两个会话必须不同名、异常输入不抛错）、`/status` 真实前缀 id 的回退标签用例、以及客户端 helper 用例；改写三个受口径影响的既有断言。全套 502 tests / 501 pass / 1 skipped。

## 0.25.8 — 记忆权限浮窗不再被「回到底部」按钮盖住；本会话作用域叫「当前会话」

- **层级修正（浮窗曾被「回到底部」圆钮压住）**：宿主会话在 active 阶段给输入框所在的 composer seat 上了 `position:sticky + z-index:7`，那是一个独立的层叠上下文；浮窗写在它里面，`position:fixed` 也只在那个上下文里比较层级，永远压不过兄弟层 z-index:8 的「回到底部」按钮。现在浮窗通过 `react-dom` 的 `createPortal` 挂到 `document.body`，直接参与根层叠上下文的排序；`z-index` 从 80 提到 900（会话里的浮动件都在 100 以内，宿主自己的对话框 / 提示层是 1000 起，所以压得过前者、盖不住后者）。拿不到 `react-dom` 的宿主退回原地渲染，功能一致。
- **点外面关闭仍然正确**：portal 之后浮窗不再长在按钮那棵树里，outside-click 判定补了浮窗自己的 ref，点浮窗内部（搜索框、勾选框、保存）不会被当成「点外面」。
- **本会话作用域改名「当前会话」**：作用域列表里 `session:<本会话 id>` 那一行不再显示会话标题 + 短 id（或「会话 1a2b3c4d」），统一显示「当前会话」——面板本来就是给这个会话设权限，用户不需要对号入座。**只改本会话那一条**：目录里别的会话的 scope（有记录就会被发现）仍按标题 / 短 id 显示。搜索也走显示名，输入「当前会话」能直接筛到这一行；原始 `session:<id>` 仍留在名称的 `title` 提示里。
- 测试：新增「浮窗 portal 到 document.body」与「本会话作用域显示为当前会话、别的会话照旧」两个用例，并断言浮窗 `z-index:900`（高于会话浮动件 8 / 100、低于宿主弹窗 1000）；改写两个受显示名与排序影响的既有断言。`source/memory-panel/test/*` 53/53 通过，全套 54 个文件里仅 `memory-local/test/multiprocess.test.ts` 因沙箱禁止 spawn 子进程失败（真机全权限可过）。

## 0.25.7 — 记忆权限里整张作用域卡片都能点选

- **卡片整体可点**：「记忆权限」浮窗的作用域列表里，以前只有 16px 的勾选框和名称文字能点，点计数或行内留白没反应。现在整张卡片都能点——点名称、记录数、留白等同点勾选框（选中 / 取消勾选），鼠标移到卡片上就是可点击形态。行内的【绑定】/【可读】/【可写】按钮与勾选框仍各管各的：按钮点击不会再把卡片切换第二次（事件冒泡被拦掉），勾选框也不会被切换两下。
- **配套样式**：卡片 `cursor:pointer` + `user-select:none`，拖动卡片不会误触勾选或选中文字。
- 测试：新增用例覆盖「点卡片空白处勾选 / 取消勾选」「点按钮冒泡上来不重复切换」「点勾选框或名称只切换一次」「点绑定按钮不改勾选」，并断言卡片的 `cursor` / `user-select`；`source/memory-panel/test/*` 全绿。

## 0.25.6 — 按钮数字实时跟着授权变；关浮窗即丢弃草稿

- **数字不再要「开一次浮窗」才对**：0.25.5 把输入框按钮的数字改成「可见范围 ∪ AI 授权」，但授权只在浮窗打开时按 3 秒轮询，浮窗关着 Agent 刚审批到的权限进不了这个数字（表现为「数字没有实时变化」，要手动打开面板才更新）。现在会话在就轮询（3 秒一次、`document.hidden` 时跳过），按钮数字与 `title` 随授权自己变；换会话时先清空上一个会话的授权快照，避免数字串台。
- **草稿不跨「关闭浮窗」**：点浮窗外面 / Esc / 再点按钮关掉时，取消勾选留下的「AI·待撤销」标记、`grantError` 与勾选草稿一律丢弃，重开只显示服务端真值（没保存就还原，不记住草稿）。之前 `pendingRevoke` 留在内存里，重开后 AI 行仍挂着「AI·待撤销」，与「没保存就该还原」不符。
- 测试：新增两个用例——浮窗从未打开时按钮数字也从 1 变 2（挂载即拉 `/grants`，授权到位后数字自己更新）；取消勾选标「AI·待撤销」后不保存直接关掉、重开时勾选与气泡回到真值且计数回到 2。`source/memory-panel/test/*` 全绿；全套 496 tests（`multiprocess` 需真实子进程，沙箱内 EPERM，全权限下 4/4 通过）。

## 0.25.5 — AI 授权行用自己的样式；按钮数字与「已选」都把授权算进去

- **视觉区分**：AI 授权勾上的行不再套用用户选中行的实心蓝底 + 蓝边 —— 行用虚线边框 + 中性底色（`.mem-scope-item.ai`），勾选框用虚线描边、透明底、蓝色对勾（`.mem-scope-check.on.ai .box`），一眼能看出「这条是 AI 申请来的」而不是你自己勾的。
- **计数口径**：输入框按钮上的数字改为「可见范围 ∪ AI 授权」的作用域数（`accessibleCount`），按钮 `title` 同步；弹窗头部「已选」也改成当前勾选数（含 AI 授权，标「待撤销」的不算）。上一版把 AI 授权排除在计数外，和实际可读作用域不一致。
- 测试：用例断言有 AI 授权时按钮数字为 2、已选为 2、AI 行带 `ai` class；新增 CSS 断言（虚线边框 / 中性底 / 描边勾选框）。全套 494 tests / 493 pass / 1 skipped。

## 0.25.4 — 授权撤销与列表重排都改到「保存」之后；已选计数只算可见范围

- **取消勾选只是草稿**：勾选 AI 授权的行后取消勾选，不再立刻调用 `POST /memory/api/grants`；改成标记「AI·待撤销」气泡，点「保存」时才先撤销授权、再保存可见范围。再勾回去会恢复原状。
- **保存后才重排**：列表的「已勾选在上」按**保存过的状态**排序，草稿勾选 / 取消勾选期间顺序不动，保存后（重开面板）才按新状态重排。
- **计数口径**：面板头部的「已选」只统计你自己勾选的可见范围（与输入框按钮的范围数字同口径），AI 授权不算进去；授权只以勾选 + 气泡体现。
- **取消全选**：把可撤销的授权标记为待撤销，不立即撤销；继承自父会话的授权给出提示。
- 测试：改写两个面板用例——取消勾选不触发 `/grants`、气泡变「AI·待撤销」、顺序与计数不变；点保存后才 `POST /grants` + `POST /visibility`，且重开后按新状态重排；全套 494 tests / 493 pass / 1 skipped。

## 0.25.3 — Agent 授权改用「勾选 + AI 气泡」呈现，取消勾选即撤销

- **授权结果 = 勾选**：作用域被 Agent 申请并审批通过后，该作用域直接显示为**已勾选**（即使它不在你设置的可见范围内），列表里同样排在已勾选分组。浮窗打开期间每 3 秒刷新授权，Agent 刚拿到的权限不用重开面板就能看到。
- **「AI」气泡**：授权来的作用域在名称右边挂一个「AI」气泡，`title` 写明只读 / 可写；继承自父会话的标「AI·继承」。
- **取消勾选 = 撤销**：用户取消该作用域的勾选时，面板调用 `POST /memory/api/grants` 撤销这条授权，勾选与气泡一起消失，Agent 下一次 pre-step 收到「记忆权限已更新」。「取消全选」会一并撤销可撤销的授权；继承的授权撤销不了，会明确提示到父会话操作。
- **目录里已不可见的作用域**仍保留一行（「目录中已不可见」），取消勾选即可撤销对应授权。
- **保留 0.25.2 的收敛**：仍没有独立的「Agent 授权」行与浮窗上方解释文本；勾选、`可读 / 可写`（自己勾选的作用域才可调）与授权气泡并列在同一行。
- 测试：新增用例断言授权行显示为勾选 + AI 气泡、title 含权限文案、授权行参与「已勾选在上」排序，取消勾选走 `POST /grants` 且气泡消失；全套 494 tests / 493 pass / 1 skipped。

## 0.25.2 — 记忆权限浮窗只留「勾选作用域 + 可读 / 可写」，列表按勾选与字母排序

- **移除 Agent 授权 UI**：「记忆权限」浮窗不再显示「Agent 授权：只读 / 可写」行，作用域行只剩勾选 + 【绑定】/【可读】/【可写】；继承标记、「到父会话撤销」与「目录中已不可见」的保留授权行一并去掉。
- **移除多余解释文本**：删掉浮窗上方「勾选作用域 +『可读 / 可写』= …；行内『Agent 授权』= …」那段说明。
- **列表排序**：已勾选的作用域排在列表上方、未勾选的排在下面，组内按名称字母排序（中英文走同一份 key，用 `localeCompare` + 数字比较）；勾选 / 取消勾选后立即重排。
- **客户端减负**：面板不再请求 / 轮询 `GET /memory/api/grants`，也不再提供撤销入口，相关状态、定时器与样式全部删除；服务端 `GET/POST /memory/api/grants`、`grants/<session>.json` 与审批授予逻辑保持不变，授权仍按会话（含子 Agent 继承）生效并注入告知。
- 测试：client 浮窗断言不再出现「Agent 授权」「范围外例外」等文本、不请求 `/grants`，作用域行仍有勾选框 + 绑定 / 可读 / 可写三个状态按钮；新增排序用例（勾选的在上一组、组内字母序、取消勾选后沉下去）。全套 493 tests / 492 pass / 1 skipped。

## 0.25.1 — Agent 授权不再单列，直接标在作用域行内

- **复用同一条作用域记录**：去掉「记忆权限」浮窗里独立的「Agent 会话授权」区块。同一作用域只有一条，Agent 授权直接显示在对应作用域行的下方（`Agent 授权：只读 / 可写` + `撤销`），与勾选、`可读 / 可写` 并列，不再出现同一条作用域两处显示。
- **明确区分两种权限**：勾选 + `可读 / 可写` = 用户为本会话设置的**可见范围**（保存后生效）；行内「Agent 授权」= Agent 主动申请、用户审批过的**范围外例外**（仅本会话、可单独撤销、不影响勾选）。浮窗提示同步说明这层区别。
- **撤销体验不变**：行内撤销仍走 `POST /memory/api/grants`，撤销后行内立即消失；继承自父会话的授权标「继承」「到父会话撤销」；目录中已不可见的作用域以一行「目录中已不可见」保留授权，仍可撤销。
- 服务端接口与数据格式不变（仍为 `GET/POST /memory/api/grants`、`grants/<session>.json`）。
- 测试：client 浮窗断言授权与可读 / 可写状态按钮在同一作用域行内、撤销后行内实时消失；全套 492 tests / 491 pass / 1 skipped。

## 0.25.0 — 记忆范围面板改名「记忆权限」：Agent 授权实时可见、可撤销、统一注入

- **改名**：输入框按钮、浮窗标题、`title` / `aria-label` 与注册 label 统一从「记忆范围」改为「记忆权限」。
- **面板实时显示 Agent 授权**：浮窗新增「Agent 会话授权」区块，列出本会话由 `memory_scopes request` 审批得到的授权（作用域 / 只读或可写 / 授予时间 / 是否继承）。新增 `GET /memory/api/grants?session=`；浮窗打开期间每 3 秒轮询，Agent 刚申请到的权限无需重开面板即可看到。
- **支持撤销**：新增 `POST /memory/api/grants { session, id }` → `provider.revokeGrant()`，撤销后列表实时刷新；继承自父会话的授权标「继承」且在本会话不可撤销，避免误伤父会话。重复撤销返回 `GRANT_NOT_FOUND`（404），不会对历史条目重复写审计。
- **统一权限变更注入**：provider 新增 `takePermissionNotice()`（沿 `parentSession` 链取走，附当前有效授权快照）；`memory_scopes request` 授予与面板撤销各记一条变更，注入半边用 `renderPermissionNotice()` 把「可见范围变化 + 本次授权变更 + 当前会话授权」合并成一条「【记忆权限已更新】」user 消息（含撤销后需重新申请的说明，只描述权限、不含记忆正文）。原来的「记忆可见域已更新」通知并入这条消息。
- 测试：provider 的 `sessionGrants` / `takePermissionNotice` / 撤销幂等与父链继承；面板 `/grants` GET/POST 与 inherited；client 浮窗授权区块、3 秒轮询与撤销请求载荷；注入文案与 pre-step 渲染。全套 492 tests / 491 pass / 1 skipped。

## 0.24.1 — 修复 memory_scopes 注册失败导致 memory_get 一起消失

- **现象**：升级到 0.24.0 后，模型侧看不到 `memory_scopes`，连原本正常的 `memory_get` 也变成 `unknown tool`；`memory_search` / `memory_list` / `memory_save` / `memory_forget` 仍在。
- **根因**：`memory_scopes` 的 `requests` 参数用了嵌套对象 schema。DSH `defineTool` 的 authoring DSL 要求对象类型必须显式写 `additionalProperties`（嵌套对象的 `required` 也不在允许关键字里），注册期抛错 → 整个 tool-memory apply 中断，排在 `memory_scopes` 后面的 `memory_get` 没有注册。
- **修复**：`action="request"` 改为扁平参数 `scopes: string[]` + `permissions: ["read"|"write"][]`（作用于本次所有 scopes），不再使用 `object` / `properties` 参数；provider 的内部请求结构不变。
- **回归守卫**：新增测试，禁止任何 `memory_*` 工具参数出现 `type:"object"` / `properties`，避免同类 schema 再次把后续工具注册带崩。
- 验证：484 tests / 483 pass / 1 skipped；`npm run verify` BUILD OK。

## 0.24.0 — 作用域目录与用途元数据；自定义作用域原子初始化

- **作用域元数据（`<storeDir>/scope-meta/<sha1(scope)>.json`）**：每个作用域可以带一句话用途，独立于记忆记录——删光记录、记录被 supersede / 过期都不会丢。旧作用域没有元数据时按「未填写用途」处理，不做迁移、不要求补齐。项目别名仍以 `scopes.json` 为准。
- **自定义作用域创建（Agent 路径）必须说明用途**：`memory_save` 新增可选 `scopeDescription` / `scopeRule`。Agent 首次写入一个不存在的自定义作用域时缺 `scopeDescription` → `SCOPE_DESCRIPTION_REQUIRED`；提供后在同一次调用里原子完成：元数据先写 `pending`、写入初始事实（带 `initial: true`）、可选写一条初始规则（`kind: rule`，也带 `initial`）、最后转 `ready`。中途失败保留 `pending`，下次保存继续完成。面板 / 导入等没有 agent 上下文的路径不受强制。
- **新工具 `memory_scopes`（本版仅 `action="list"`）**：返回作用域名字 / 用途 / 来源 / 当前可读可写状态；范围外条目不返回记录数、不返回任何正文。`includeOutOfScope: false` 只看范围内，`limit` 默认 50。
- **统一授权判定（D2）**：新增纯函数 `authorize(request, context)`（`source/memory-local/src/authorize.ts`），`discover / read / write / delete` 共用一套规则；provider 的 `visibilityFilterFor`、`isRecordVisible`、`isScopeReadable`、`isScopeWritable`、`assertOperable` 与目录工具全部改为走它，工具层通过 `accessEvaluator(agent)` 一次解析、逐条判定，不再自己解释 `absolute / normal / none`。工具层只在 `requestable=true` 时发起审批；`absolute`、显式 `read:false` / `write:false`、作用域类型关闭都不产生审批卡，并给模型真实原因（新增 `withheld.reason='scope-disabled'`）。
- **会话授权 + 主动申请（D3）**：
  - 新增独立存储 `grants/<session>.json`（每个会话一个文件、原子写），与 `visibility/<session>.json` 的策略分开：只读 / 可写独立、可撤销、带 `scopeGeneration`（作用域删除重建后旧授权自动失效）、子 Agent 沿 `parentSession` 链继承。
  - `memory_scopes` 新增 `action="request"`：按统一授权判定逐条筛，已允许 / 已有授权 / 不可申请（`absolute`、显式 read/write 关闭、作用域关闭）都不弹卡；只有普通限制下的范围外条目进入审批。
  - 审批卡新增 `mode="grant"`：按 scope + 权限逐条勾选，**默认只勾只读**，写权限必须用户主动勾选；批准后写入本会话 grants，工具返回 `granted / already-allowed / already-granted / not-requestable / denied / timeout` 等逐项状态。
  - 一次性访问仍走 `memory_*` 的隐式 `allowed-once` 审批，不塞进申请工具；`workspace` / `global` 长期授权留给后续版本。
- **绝对限制语义写死**：`absolute` 下范围外作用域**目录可见**（名字 / 用途），但正文永不可读、不可写、`canRequestRead/Write` 恒为 false——**没有任何审批放行路径**；普通限制下范围外条目才标记「可申请」。
- **initial 正文（D5）**：`normal / none` 下 `memory_scopes list` 会带上每个作用域的初始化记录正文（`initial: true`，最多 3 条、每条截到 800 字），Agent 不必先申请就能读到“这个作用域主要放什么”；`absolute` 下连初始正文也不返回（用途仍可见）。
- **审批审计（D6）**：新增 `<storeDir>/approvals.jsonl`，记录 `requested / approved / denied / timeout / granted / revoked`，只写 scope、权限、工具、会话与理由，**不写记忆正文**；provider 暴露 `approvalAuditList()` 与 `revokeGrant()`，面板与诊断可直接消费。作用域显式删除的生命周期留到后续版本（当前没有“删除作用域”操作，grant 已用 `scopeGeneration` 防止同名重建复活）。
- **`initial` 来源标记全链路**：`memory_get` 的 `fields` 新增 `initial`，导出 / 导入、`reviseRecord` 修正版都会保留；旧记录缺省 = 非初始，绝不当作公开或授权凭据。
- **测试**：作用域元数据生命周期、目录在 normal / absolute / `customEnabled=false` 下的行为、缺失用途拒绝、原子初始化的初始事实与规则、`initial` 的 get / 导出 / 导入、目录工具契约与渲染。全套通过。

## 0.23.1 — 默认作用域显示为已绑定；绑定保存后可恢复

- **修复「绑定后重开又变成未绑定」的观感与保存范围**：
  - 默认可见范围自带的 **会话 + 项目 + global** 现在由 provider 的 `defaultScopes()` 明确返回，面板把它们显示为「绑定已开」且不可取消（`defaultBound`），只有额外作用域才需要点「绑定」。这解决了「默认的那几个作用域本来就是默认可见，却显示成未绑定」的困惑。
  - 客户端保存时**只提交额外绑定**（`bound && !defaultBound && !session:`），不会把默认作用域或会话作用域写进 `bindings`；服务端仍拒绝会话作用域绑定。
  - `GET /memory/api/visibility` 新增 `defaultScopes` 与每个目录项的 `defaultBound`；`bindings` 仍是显式绑定的额外作用域。旧服务端没有 `defaultScopes` 时客户端按会话 / 项目 / global 兜底。
- **注意（本次「保存后又变未绑定」的根因）**：0.23.0 安装后，客户端 bundle 已更新（所以能看到绑定按钮），但宿主进程仍是 14:05 启动时加载的旧服务端代码，旧 `POST /visibility` 会忽略 `bindings`，只保存会话可见范围。**升级到 0.23.1 后需要重启一次 DSH**（或让插件管理器真正重载服务端），绑定才会落盘到 `<storeDir>/bindings/<hash>.json`；之后重开面板会从 `GET /visibility` 恢复。
- 测试：默认 / 额外绑定的服务端载荷、客户端按钮默认锁定、只提交额外绑定、`defaultScopes` 不包含额外绑定。全套通过。

## 0.23.0 — 修正版编辑与记录页筛选；作用域绑定 / 可读 / 可写状态

- **编辑记忆 = 新建修正版（不再原地修改）**：
  - 面板 `POST /memory/api/update` 改为调用 provider 的 `reviseRecord()`：新建一条记录、把 `supersedes` 指向旧记录，旧记录内容与元数据保持原样。
  - 内容、类型、标签、重要度、触发词、过期时间都按提交值写入新记录；内容为空 / 超长 / 命中凭据扫描时的行为与 `memory_save` 一致。
  - 返回 `{ record, superseded }`；`/records` 反查 `supersededBy`，旧记录仍可 `memory_get` / 面板历史查看，检索默认隐藏。
- **记录页「是否被修正」筛选**：默认「隐藏已修正」；可切到「显示全部」「只看已修正」。审计 / 审批跳转过来的目标记录即使被隐藏也会补一张卡并展开。
- **每个作用域的【绑定 / 可读 / 可写】状态按钮**：
  - **绑定**是工作区级：写入 `<storeDir>/bindings/<hash>.json`；同一工作区里没有显式覆盖的会话，默认范围额外包含已绑定作用域（`resolveReadScopes` / `visibilityPolicy` 同口径）。会话作用域不可绑定。
  - **可读 / 可写**是会话级、独立生效：`read:false` 的作用域不进入读取集合，搜索命中 / `memory_get` 返回 `withheld.reason='read-disabled'` 且不会发起审批；`write:false` 的保存 / 删除直接拒绝并返回 `SCOPE_READ_ONLY`。
  - 状态按钮与 `Scope visibility` 一起提交：`visibility.scopes[{ scope, read?, write? }]` + `bindings: string[]`；只落 `false`，旧文件 / 旧客户端默认都可读可写。
- **失败回复讲真实原因**：绝对限制下被挡住的读取 / 写入 / 删除不再伪装成「不存在」。
  - 读：`memory_search` / `memory_list` / `memory_get` 返回 `withheld.reason='absolute'`；被挡住的 id 不再进 `missing`，渲染层提示「绝对限制，不会发起审批」及调整方式。
  - 写 / 删：工具返回 `VISIBILITY_ABSOLUTE`（绝对限制）或 `SCOPE_READ_ONLY`（可写开关关闭）；普通限制的拒绝 / 超时 / 无法审批保持原有真实原因。
- **测试**：provider 的 read/write 开关、工作区绑定持久化与默认范围、`reviseRecord` 修正链、`/update` 旧记录保留、记录页筛选、状态按钮与 POST 载荷、绝对限制 `withheld` / 删除错误原因。全套通过（441 tests / 0 fail）。

## 0.22.3 — 审批卡高度与宿主同口径，矮窗口也给列表留空间

- 0.22.2 把详情行锁成 `flex:none` 后，矮窗口里 `max-height: min(--dsh-composer-text-max-height, 46vh)` 那层 `46vh` 会让头部占满高度、条目列表只剩十几像素（437px 高窗口实测 ~18px）。
- 审批卡 body 改为只受 `--dsh-composer-text-max-height` 约束（与宿主 `dsh-client-ui-approval` 同一口径），不再叠 `46vh`；同样窗口下列表恢复到 ~181px（headless Chrome 实测）。
- 测试：CSS 断言锁定 `max-height:var(--dsh-composer-text-max-height,…)` 且不再出现 `46vh`。

## 0.22.2 — 修复审批卡不显示 Agent 查询 / 说明

- **现象**：审批条目一多（例如 18 条）时，审批卡里只看到标题、提示和条目列表，`Agent 查询` 与 `Agent 说明` 两行完全消失。
- **根因**：`.mem-approval-command` / `.mem-approval-desc` 带 `overflow:auto`。在 flex 列布局里，非 `visible` 的 `overflow` 会把自动最小尺寸变成 0；条目列表的自然高度很大，把 `.mem-approval-body` 顶到 `max-height` 后，flex 按基准尺寸分配收缩量，这两行被压成 ~1px（headless Chrome 实测 1.06px / 1.02px）。
- **修复**：给 `.mem-approval-headline` / `-hint` / `-command` / `-desc` / `-bulk` 全部加 `flex:none`，只允许 `.mem-approval-list` 收缩并滚动。headless Chrome 实测修复后两行高度 20px / 19.4px。
- **测试**：CSS 回归断言锁定五行 `flex:none` 与列表 `min-height:0`；面板渲染用例照旧。全套通过。

## 0.22.1 — 审批卡可折叠、整行点击选中

- **审批卡可折叠**：strip 右侧新增「折叠 / 展开」按钮。折叠只收起详情（标题、说明、查询、条目列表），strip 与「拒绝 / 允许」动作行保留，折叠状态在 strip 上显示「已选 N/总数」，不必展开就能审批。切换会话或新审批进来时默认展开。
- **整行点击选中**：读审批的记忆条目整行可点 —— 点勾选框、记忆 ID 以外的任何位置都会切换该条选中状态，不需要精确点中小勾选框。点记忆 ID 仍是跳转面板「记录」页；勾选框与 ID 按钮都 `stopPropagation`，不会误触选中。条目 hover 有边框 / 底色反馈与「点击选择 / 取消」提示。
- **测试**：整行点选、折叠后详情隐藏但动作行可用、再次展开恢复。全套通过。

## 0.22.0 — 审批卡全选/取消全选、点 ID 跳面板记录页、工具新增 description

- **审批卡支持批量勾选**：逐条勾选之外新增「全选 / 取消全选」，并显示「已选 N / 总数」；全选后按钮仍是「允许一次」（提交时不带 `allowedIds`），取消全选后允许按钮禁用（要拒绝请点「拒绝」）。
- **点记忆 ID 跳面板**：审批卡里的记忆 ID 变成按钮，点击后打开记忆面板「记录」标签页、选中并滚动到该条、自动展开（复用 `dsh-memory:record-focus` 焦点总线；列表里没有该条时用审批载荷里的快照补一张卡）。写 / 删审批的合成条目不是真实记录，ID 保持纯文本。
- **工具新增 `description`（普通限制下必填）**：五个 `memory_*` 工具都新增 `description` 参数（一句话说明这次调用要做什么）。当本会话生效的「记忆范围」限制等级为**普通限制**（默认）时，省略或空白会被 `DESCRIPTION_REQUIRED` 拒绝；绝对限制 / 无限制下可省略。拿不到会话上下文的调用（老宿主 / 面板直调）不强制。
  - 审批弹窗展示 `Agent 说明：<description>`，与查询关键词一起给用户判断依据。
  - `requestOutOfScope` 的输入与 pending 视图新增 `description`；`/memory/api/approvals` 原样返回；系统提示策略段同步说明这条口径。
- **`memory_search` 去重 ID 单独成块**：上下文去重导致只回记忆 ID 时，这些裸 ID 与带摘要的条目之间空一行（不再看起来像上一条的续行）；末尾仍保留「摘要因上下文去重被省略」提示。
- **测试**：审批卡全选/取消全选、description 展示与 ID 跳转焦点；普通限制下缺 `description` 拒绝 / 提供后随审批载荷传递；绝对限制 / 无限制不强制；去重 ID 与摘要条目之间的空行。全套通过。

## 0.21.0 — 审批卡进会话内、逐条允许；memory_search / memory_list 上下文去重

- **范围外审批卡重做（行为 + 样式对齐系统权限审批弹窗）**：
  - 注册位置从 `shell.overlay`（全局 fixed 浮层）改为 `conversation.input.dock`（会话作用域的输入框上方）。审批**只在发起它的那个会话里显示**：切到别的会话看不到，也不会盖住设置页 / 别的会话；组件按标准 `sessionId` prop 轮询 `/memory/api/approvals?session=…`。
  - 版式照抄宿主 `dsh-client-ui-approval` 的审批卡：警告色 strip（「等待审批」+ 工具名）、`mem-approval-body` 标题 / 查询语句、右对齐的「拒绝 / 允许」动作行；卡片宽度、圆角、底色、阴影、strip 配色都使用与系统审批卡同一批主题 token（`state-warn-secondary` / `state-warn-tertiary` / `dsw-radius-xl` / `specific-input-major` / `dsw-shadow-lv2`，缺变量时带同色回退）。Enter = 允许、Esc = 拒绝（焦点在卡片内）。
  - **逐条允许**：读审批默认全选，可以取消其中一条或多条，按钮变成「允许选中的 N 条」；全选时仍是「允许一次」。工具侧按 `{ outcome: 'allowed-once', allowedIds }` 只放行勾选的 id，其余条目计入 `withheld: { count, reason: 'partial' }` 并渲染真实原因；写 / 删审批是单条，不显示勾选框。
  - provider：`requestOutOfScope()` 返回 `{ outcome, allowedIds? }`（老的字符串返回仍兼容）；`answerVisibilityApproval(id, outcome, allowedIds?)` 会丢弃不属于本次请求的 id；全选退化为不带 `allowedIds`（= 全部允许，包括超过浮层展示上限的条目）；空勾选按拒绝处理。面板 `POST /memory/api/approvals` 接受 `allowedIds`，非数组报 `APPROVAL_IDS_INVALID`。
- **memory_search / memory_list 的上下文去重**：
  - 注入半边的会话去重状态新增 `summary_injected`（`memory_search` 返回摘要 / `memory_list` 返回正文分别记 `summary_injected` / `content_injected`），持久化状态 code = 3；`markHint` 不再把摘要 / 正文降级成标签。
  - 注入半边新增 `memoryContextDedup` 服务（`ctx.provide`）：`seen` / `markSummary` / `markContent`。工具半边在**每次执行时**惰性 `ctx.get`（不在 apply 里取样），拿不到就自然退化为不去重。
  - 规则：同一条记忆、同一 `updatedAt` 版本已经以摘要或正文进入过上下文 → `memory_search` / `memory_list` 只回记忆 ID；内容更新（版本变化）→ 照常返回摘要 / 正文并记住新版本。
  - 返回文本在去重发生时追加固定提示：「本次请求部分记忆摘要因上下文去重机制被省略，若要获取完整内容请使用 memory_get」。`memory_get` 不去重（显式取正文）。系统提示策略段同步说明这条口径。
- **测试**：InjectionState 的 summary/seen/降级保护；工具层 search/list 的二次去重、版本更新重新返回、逐条允许与 `partial`；面板 `allowedIds`（部分 / 全选 / 空）；客户端审批卡按会话过滤 + 逐条勾选 + 提交 `allowedIds` + 样式 token 断言。全套 429 通过 / 1 跳过。

## 0.20.0 — 写入护栏、真实失败原因、默认记忆范围、按钮边框表达限制等级

- **默认记忆范围（新会话）**：以前没有显式覆盖 = 完全不限制；现在没有显式覆盖时按默认设置生效：**当前会话 + 当前项目 + global** 三个作用域 + **普通限制**。`visibilityPolicy()` 因此永远返回一份策略，并带 `source: 'explicit' | 'inherited' | 'default'`。
  - 默认策略下普通检索只搜这三个作用域，不会每次都弹审批；显式 `scope:'all'` 或 `memory_get` 命中范围外记录时才发起审批。
  - `visibleScopes()` 语义不变（只代表**显式**覆盖），注入半边的 `inject.extraScopes` / fork 父会话召回不受默认策略影响。
- **写入护栏（可见范围 = 可操作范围）**：`memory_save` / `memory_forget` 与读取共用同一份可见域。
  - `absolute`：范围外写入报「作用域 … 不存在或不可写」，范围外 id 删除按「不存在」处理，范围外按 query 删除静默无匹配 —— 都不暴露可见域配置。
  - `normal`：范围外写入 / 删除先向用户发一次审批（浮层区分读 / 写 / 删）；拒绝、超时、无法审批各自返回真实原因（`VISIBILITY_REJECTED` / `VISIBILITY_TIMEOUT` / `VISIBILITY_UNAVAILABLE`）。
  - `none`：不限制。没有会话上下文的调用（老宿主 / 无 `exec`）不启用护栏。
  - provider 层同样守一道：有 `agent` 且未审批时 `save` 直接拒绝（`SCOPE_NOT_WRITABLE` / `VISIBILITY_APPROVAL_REQUIRED`）；面板写入不带 agent，仍是用户本人的操作。
- **失败信息讲真实原因**：工具结果里的 `withheld` 改为 `{ count, reason: 'rejected' | 'timeout' | 'unavailable' }`，渲染层把原因写进模型可见文本（「用户拒绝了本次访问」「审批在 5 分钟内没有得到答复」「当前环境无法发起审批」）。
  - `absolute` 不再产生 `withheld`，也不再把显式询问范围外 scope 变成 `SCOPE_NOT_VISIBLE` 报错 —— 一律视为不存在。
  - 审批超时与用户主动拒绝已区分：provider 的超时返回 `'timeout'`（以前和拒绝一样）。
- **记忆范围按钮**：数字 = 生效作用域数量；边框样式 = 限制等级：**绝对限制 = 橙黄（`state-warn-primary`）实线**、**普通限制 = 蓝色（`state-business-primary`）实线**、**无限制 = 灰色虚线**；`title` 里写明「已设置 / 使用默认 / 继承父会话 + 数量 + 等级」。
- **审批浮层**：区分读取 / 写入 / 删除三种动作（标题、说明文案），写入审批直接展示将被写入的内容。
- **可见域通知**：恢复默认的注入文案改成「默认 = 会话 + 项目 + global + 普通限制」，并说明写入 / 删除也受同一份可见域约束。
- 测试：默认策略与默认检索不弹审批、显式 all 的审批 / 拒绝 / 超时、写入与删除护栏（三档 × 工具层与 provider 层）、`withheld` 渲染文案、按钮三档边框与数字。

## 0.19.2 — 深色模式下勾选框 / 保存按钮配色修正，浮窗再收紧

- **根因**：宿主深色主题里 `--dsw-alias-brand-primary` 是近白色；0.19.1 把它当填充色，导致选中的勾选框变成白块（勾不可见）、保存按钮变成白底白字。
- **修正**：勾选框选中态、保存按钮、限制等级选中态改用 `--dsw-alias-state-business-primary`（亮色 #4176e6 / 暗色 #7aaaff）；勾/按钮文字用可翻转的 `--dsw-alias-label-primary-foreground`（亮色白、暗色深），两种主题下都有足够对比度。
- 未选中勾选框：底色用 `label-primary` 5% 的轻填充，边框用 `label-secondary` 52% 混 `border-l1`，深色下不再是几乎看不见的空框。
- 选中行 / 等级卡的边框与底色也统一成 business-primary 的淡色，避免深色主题里出现白色描边。
- **高度收紧**：滚动列表 `max-height` 从 `min(300px,40vh)` 降到 `min(220px,32vh)`；浮窗整体从 `min(600px,80vh)` 降到 `min(520px,72vh)`，padding 14→12。
- 测试：CSS 断言锁定 business-primary + primary-foreground 的组合与新的高度上限；用 headless Chrome 在深色 token 下渲染确认勾选框、保存按钮、等级卡的对比度。
- 重新构建并发布；0.19.1 的结构与行为不变。

## 0.19.1 — 记忆范围按钮常驻数字、默认范围预选、取消类型限制、深色模式与阴影收敛

- **按钮只显示数字**：去掉「记忆可见域」文字，保存/继承后只显示当前生效的作用域数量；有显式覆盖时仍然高亮，完整说明放在 `title` 里。
- **打开会话就加载**：按钮挂载时（以及 `sessionId` 变化时）就请求 `GET /memory/api/visibility`，不再需要先点一次按钮才知道这个会话的范围。
- **默认范围预选**：没有显式覆盖时，面板按服务端返回的 `defaults`（会话 + 项目 + global）预选；服务端目录里缺这些 scope 时客户端会自己补齐，不会再出现「一打开什么都没选」。
- **取消记忆类型限制**：移除浮窗里的类型 chips；`POST /visibility` 不再写入 `kinds`，provider 在规范化 / 读取旧配置时也忽略 `kinds`。0.19.0 的 v2 文件仍可读，只是类型白名单不再生效；同一作用域下所有类型都可读。
- **深色模式**：浮窗、等级按钮、勾选框、类型说明、审批卡的背景 / 边框 / 文字全部走宿主主题 token；去掉只在浅色下协调的白色内阴影，深色主题下对比度正常。
- **阴影收敛**：浮窗与审批卡的投影从 `0 22px 60px` 级别收紧为 `0 10px 26~28px`，去掉明显的大面积阴影；面板宽度从 360 收到 340。
- **测试**：按钮挂载即加载、只显示数字、默认范围预选（含服务端目录缺失时的补齐）、保存只带 scope、后端忽略 kinds、类型限制取消后的 search/get 行为、旧配置兼容。

## 0.19.0 — 记忆可见域 2.0：按类型收窄 + 三档限制 + 范围外审批 + 浮窗重做

- **可见域从「作用域白名单」升级为「作用域 × 记忆类型 × 限制等级」**：每个作用域可以只允许部分 `kind`（例如 `global` 仅 `rule`、当前项目仅 `fact`）；限制等级三档：
  - `absolute` 绝对限制：范围外一律查不到，工具内部命中也不返回；
  - `normal` 普通限制（新默认）：范围外命中时由工具向用户发起一次审批；
  - `none` 无限制：不做范围过滤（选择保留，供下次切换）。
- **会话级持久化保持并升级**：`<storeDir>/visibility/<session>.json` 改为 v2（`scopes: [{ scope, kinds? }] + level`）；0.18 的 v1 文件按「绝对限制 + 全部类型」读取，升级不放开旧范围。「恢复默认」删除文件。
- **范围外访问审批**：
  - `memory_search` / `memory_list` / `memory_get` 在普通限制下把范围外命中交给用户审批；工具等待期间会在界面底部显示审批浮窗（查询关键词、工具名、范围外记忆摘要）。
  - 浮窗里的记忆 ID 悬浮 350ms 显示完整内容浮窗（复用审计详情的 `.audit-tip` 行为与样式）；点击 ID 跳到「记录」页并展开卡片。
  - 「拒绝 / 允许一次」二选一；允许一次只对本次调用生效；拒绝或 5 分钟超时按拒绝处理；调用被中止时立即释放，不留下悬浮的待审批。
  - 工具结果新增 `withheld: { count, reason }`（不泄露正文），让模型知道有命中被可见域挡住。
- **可见域变更注入上下文**：面板保存后，下一次 `agent/pre-step` 以 user 消息注入「记忆可见域已更新」，列出作用域 / 类型 / 限制等级与后续行为要求；子 Agent 也会收到父会话的变更。
- **注入侧按类型收窄**：摘要、每轮召回、硬性规则、流程索引都按可见域的类型白名单过滤，避免「只允许 global 的 rule」之后又从别的类型召回正文。
- **浮窗面板 UI 重做**：
  - 按钮在保存过范围后显示「记忆可见域 n」；
  - 毛玻璃背景（半透明 + `backdrop-filter`，不支持时退回实心底），不再透出底下的输入框；
  - 自定义勾选框与类型 chips（不再使用原生 checkbox）；
  - 作用域搜索、全选 / 取消全选；列表最大高度 `min(300px, 40vh)`，超出在浮窗内滚动；
  - 「恢复默认」与「保存」按钮重新设计（次级描边 / 品牌渐变主按钮），并保留三档限制等级的说明文字。
- **面板 API**：`GET/POST /memory/api/visibility` 返回/接受 v2 结构（同时兼容 0.18 的 `{ scopes: string[] }`）；新增 `GET /memory/api/approvals?session=` 与 `POST /memory/api/approvals { id, outcome }`；`GET /visibility` 额外返回每个作用域的类型统计与已知类型目录。
- 测试：v1→v2 兼容、按类型过滤（search / list / get / 注入）、三档限制（绝对 / 普通审批 / 无限制）、审批队列与回答幂等、可见域变更通知、浮窗按钮渲染与保存请求、审批浮层注册。

## 0.18.0 — 会话级「记忆可见范围」+ 规则注入带 ID / 摘要说明

- **输入框新增「记忆范围」按钮**：挂在宿主 `conversation.input.right` 槽（会话输入框工具行右侧），点开按当前会话列出可选作用域（当前会话 / 当前项目 / global / 自定义），勾选后立即生效。有覆盖时按钮显示「记忆 N」并高亮。
- **可见范围是会话级白名单**：本会话的 Agent 及其子 Agent 只检索、只注入、只 `memory_get` 勾选范围内的记忆。
  - `memory_search` / `memory_list` 的默认集合与 `scope:'all'` 都收窄到白名单；显式询问范围外的 scope 返回 `SCOPE_NOT_VISIBLE`。
  - `memory_get` 按 id 取正文时也会过滤：范围外记录的正文不会被取出（`missing` 里照常报告）。
  - 召回 / 摘要 / 规则 / 流程索引 / 行为召回都走同一份 `resolveReadScopes`，不需要分别改。
  - 显式可见范围设置后，`inject.extraScopes` 与 fork 父会话都不再撑大读取集合；空数组保持为空。
- **子 Agent 继承**：子 Agent 的 session scope 继续映射到父会话；可见范围沿真实会话 id + `parentSession` 链向上查找，根会话设置一次即可覆盖整棵子 Agent 树。子 Agent 自己再设置只影响它自己。
- **持久化**：覆盖按会话写到 `<storeDir>/visibility/<session>.json`（临时文件 + rename），与记忆数据同目录；没有文件 = 使用默认三路集合。「恢复默认」删除文件。
- **面板 API**：新增 `GET /memory/api/visibility?session=<id>` 与 `POST /memory/api/visibility { session, scopes: string[] | null }`，返回自己的覆盖 / 实际生效集合 / 是否继承 / 可勾选目录；`scopes` 必须是具体作用域键，空数组与 `all` / 裸 `project` / 裸 `session` 会被拒绝。
- **硬性规则带 ID 并标注摘要**：系统提示「硬性规则」段与新规则增量块每行改为 ``- `<8位id>` <正文摘要>``；段头明确说明注入的是摘要，需要完整规则时用 `memory_get` 按 ID 取全文。规则去重仍按整行比对，格式变更会在旧会话触发一次全量提醒（带上了 ID，属于预期的一次性迁移）。
- 测试：provider 覆盖解析 / 子 Agent 链式继承 / scope 开关过滤 / 落盘重读、工具层白名单（search / list / get / all / 显式 scope）、面板 GET/POST /visibility、输入框按钮渲染与保存请求、规则行格式与段头文案、注入范围不被 extraScopes 撑大。

## 0.17.1 — memory_save 成功即把这条记忆记为「正文已注入」

- **现象**：在同一个会话里 `memory_save` 成功后，下一轮（或同一轮后续步骤）的召回会把刚保存的那条记忆再注入一遍，然后再被会话级去重标记。实况样本：某会话 turn 1 末尾保存一条发布记录，turn 2 第一步的召回又把它作为「相关记忆」塞回上下文，之后同一条再也不出现。
- **根因**：0.16.1 只把 `memory_get` 取正文记成 `content_injected`；`memory_save` 的正文其实也进了上下文 —— 写入语句就是模型产出的 `tool/call` 参数 —— 但保存路径没有写会话注入状态，于是下一次召回把它当成「还没注入过的新记忆」。
- **修复**：`session/event` 里跟踪 `memory_save` 的 `callId`；`tool/result` 成功、且能从结果里解析出记录 id 时（`getByIds` 再校验存在性），把该记录按 `updatedAt` 记为 `content_injected`。
  - 只按 UUID 形态解析记录 id，不依赖结果文案，本地化 / 措辞改动不会让去重失效。
  - 保存失败 / 被拒绝不标记；记录之后被更新（`updatedAt` 变化）仍会重新评估并重新注入。
  - 去重标记独立于 `autoRecall` 开关，和 `memory_get` 的口径一致；compaction 时随会话状态一起清空。
- **审计**：保存成功时写一条 `kind=lifecycle / stage=content_pinned / reasonCode=saved_in_context` 事件（带 `operationId` = 这次 save 的 callId、`selected.contentIds`），面板按记忆 id 能查到「它为什么后面被去重跳过」。
- 回归测试：结果解析（保存 / 去重命中 / 非中文文案 / 无 id）、成功后下一次召回被去重且审计可见、保存失败不标记、版本变化重新注入、去重命中同样标记。

## 0.17.0 — 会话去重状态持久化到工作区 `.dsh/dsh-memory`

- **状态现在可以跨插件重载 / 宿主重启恢复**：`InjectionState` 可按会话挂一个持久化 store，首次接触会话时读一次盘，之后写入由 store 合并。
- **位置**：`<会话工作区>/.dsh/dsh-memory/sessions/<session>.jsonl`。只存记录 id、状态、版本（`updatedAt`）和时间戳；**不存正文，也不存查询**（避免把凭据写进状态文件）。
- **运行效率**：JSONL 增量日志 + 默认 250ms 合并窗口，一次召回/摘要的多次标记只 append 一行；写延迟与状态大小无关。轮末与插件卸载会强制 flush。
- **存储效率**：行数 / 字节超过阈值时 compact 成一行快照，用临时文件 + rename 原子替换；每个工作区默认保留 30 天、最多 1000 个会话文件，首次接触该工作区时清理一次。
- **容错**：目录不可写、文件损坏、写盘失败都只退化为内存去重并告警一次，绝不阻断注入链路；`compaction` 清空状态时同步删掉对应文件。
- **接线**：`session/event` 与 `agent/pre-step` 都会在第一次拿到 `header.cwd` 时挂载 store；拿不到工作区时保持纯内存。配置项 `sessionState.{enabled,dir,debounceMs,maxAgeDays,maxFiles}` 可覆盖，默认开启并写到工作区。
- 回归测试：JSONL 往返、合并写一行、阈值 compact、evict 同步、remove/坏行容错、30 天清理、异常 sessionId 安全文件名；以及 `apply` 层“重载后仍去重、记录更新后重新注入”的端到端用例。

## 0.16.2 — memory_get 去重的审计与端到端覆盖

- **补审计缺口**：所有候选都被会话级去重时，`renderRecallBlock` 返回 `null`，`dedupIds` 没有写进结果，审计只能看到 `dedupSkipped` 数量、看不到具体跳过了哪些 id。现在 `dedupIds` 在“全部去重”和“预算省略”路径上也会返回。
- **端到端测试**：新增真实 `session/event` 链路测试（`tool/call` → `tool/result` → `injectionState` → 下一次 pre-step）：
  - `memory_get` 取正文后，下一次普通召回不再追加同一条消息，审计能列出被去重的 id；
  - 记录 `updatedAt` 变化后，下一次召回重新注入新版本；
  - 只取 `summary` 时不算正文，仍可通过召回补全文；
  - 自动召回关闭时去重标记仍然生效。
- 语义保持不变：`memory_get` 默认和显式 `fields: ["content"]` 都显示完整正文；只有正文进入上下文才记为 `content_injected`。

## 0.16.1 — memory_get 取正文也参与会话级去重

- **补上去重缺口**：0.16.0 把正文入口从 `memory_search` 移到 `memory_get` 后，工具读到的正文没有记进会话注入状态，后续普通召回 / 摘要 / 自动召回仍可能把同一条记忆再塞一遍。
- 现在 `memory_get` 的 `tool/result` 会被解析：`fields` 省略或包含 `content` 时，把结果里的记录 id 记为 `content_injected`（按 `updatedAt` 版本去重）。只取 `summary` / `tags` / 元数据时不标记，正文仍可被召回。
- 去重标记独立于「自动召回」开关：即使行为信号召回关闭，普通每轮召回也会跳过已取过正文的记录。
- 解析同时兼容渲染文本（`[id]` 行首）和结构化 JSON（`records[].id`）；正文里普通的方括号文本不会被误认成 id，最终还会用 `getByIds` 校验一次。
- 回归测试：`fields` 是否含 content 的判定、文本/JSON 两种结果解析、写入 `content_injected` 后同会话召回被去重、版本变化允许重注入、另一会话不受影响。

## 0.16.0 — memory_search 只回印象，memory_get 按字段取

- **`memory_search` 不再返回正文**：每条结果只给 8 位 id、作用域、类型、标签和一段短摘要（默认 160 字），避免一次检索把整篇记忆塞进上下文。摘要长度可用 `summaryChars` 调整（20~2000）。返回结构从 `content` 改为 `summary`，正文统一走 `memory_get`。
- **`memory_get` 新增 `fields`**：可选择性地取 `content` / `summary` / `scope` / `kind` / `tags` / `importance` / `createdAt` / `updatedAt` / `expiresAt` / `triggers` / `supersedes`。省略时保持旧视图（`content + scope + kind + tags`）；`id` 始终返回。未知字段明确报 `FIELDS_INVALID`，空列表报 `FIELDS_EMPTY`。`summary` 支持 `summaryChars`（默认 160，20~2000）。
- 渲染逻辑抽到不依赖宿主的 `tool-memory/src/render.ts`：检索一行一条、取记录时按 fields 拼元数据，只取元数据时不输出正文行；单测直接断言模型看到的文字。
- 提示文案同步：系统提示的「记忆使用策略」、会话摘要页脚、旧式召回头部都改为“先 `memory_search` 定位、再 `memory_get` 取正文”，不再让模型去 `memory_search` 里找原文。
- 回归测试：搜索不带正文、摘要截断与上下界；`fields` 的选择性取用 / 逗号字符串 / 未知字段 / 空列表 / missing；默认视图不变；搜索与取记录的文本渲染格式。

## 0.15.2 — 导出 / 导入保留流程触发词与状态过期时间

- 0.15.0 / 0.15.1 新增的 `triggers` 与 `expiredAt` 之前没有进入 `exportAll`，导出再导入会把流程触发词丢掉、把状态记忆重新当成新状态（TTL 重算）。现在两者都随纯文本导出往返；`expiredAt` 导入时作为绝对时间写回，不再重算 TTL。
- 回归测试：状态记录的 `expiredAt` 与流程的 `triggers` 导出 → 导入到另一个 store 后逐字段一致。

## 0.15.1 — 流程索引：procedure 目录进入系统提示

0.15.0 的流程记忆只能等模型主动 `memory_search`。这一版把「这个工作区有哪些流程」提前放进系统提示，
但仍不复制正文：

- 新增 `kind=procedure` 的**触发词** `triggers`（工具名 / 关键词 / 路径；缺省用 `tags`），`memory_save` 与面板新建 / 编辑都可写。
- 系统提示新增 `memory:procedures` 段：当前工作区的流程总是可见；其他作用域的流程必须命中
  本轮用户消息、本会话最近用过的工具名或当前项目路径。每行只写 `id · 触发词 → 标题`，
  模型需要细节时用 `memory_get` 取全文。
- 条数（默认 10）与 token 预算（默认 500）可调；没有命中项时不注入；退役 / 过期流程不出现。
- 面板设置新增「流程索引」开关；记录详情展示触发词。
- 回归测试：工作区流程无条件出现、全局流程按 query/tool 触发、无关流程不出现；条数 / 预算 / 空结果；退役与过期过滤；系统提示 section 与 pre-step 的查询上下文连通。

## 0.15.0 — 去重与时效：退役记录默认隐藏、规则不进摘要、信号每轮一次、状态记忆

这一版先解决评审里最扎眼的两件事：**旧结论仍在注入**和**同一批记忆从多个通道重复进入上下文**。

- **退役记录默认隐藏**：被 `supersedes` 指向的旧记录不再进入 `memory_search`、`memory_list`、摘要、规则段和自动召回。检索层直接过滤，而不是只靠分数降权。
  - `memory_search` 新增 `includeSuperseded`（默认 `false`）；历史核对时显式打开。
  - `memory_get(id)` 与面板「记录 / 记忆树」仍能查看旧版本，数据不删除。
  - 面板的语义检索按历史浏览器处理，内部允许返回退役与过期记录。
- **摘要与规则跨通道去重**：摘要现在排除 `kind=rule`（规则已经常驻系统提示），并把每条被排除记录归入 `rule` 统计；规则段和规则增量实际渲染的 id + 版本会写进会话注入状态，后续 `recall` 不会再重复注入同一条规则。
- **行为信号降噪**：同一轮最多触发一次 signal 驱动召回；同 tag / 同 query 的重复信号只落一条 `signal_dropped` 审计，不再重复检索。工具失败信号与 0.14.7 的「必须有 description、`memory_*` 除外」规则保持不变。
- **新增 `kind=state`（状态记忆）**：
  - 写入时默认 7 天 TTL（`memory_save` 可传 `ttlMs` / `expiresAt`，显式 `expiresAt` 优先；设置项 `state.ttlMs` 可改默认值）。
  - 过期后默认从检索 / 摘要 / 召回 / 列表隐藏，但**不自动删除**；`memory_get` 和面板仍可取到正文。
  - 注入与摘要行带「状态，使用前验证」前缀，避免把临时状态当成持久事实。
  - 面板新建 / 编辑支持 `state` 与有效期，记录卡与详情显示「已过期」和剩余时间。
- 回归测试：默认检索不含退役/过期记录、`includeSuperseded` 可取历史；摘要不含规则；同轮第二个信号不检索；规则正文不会在 recall 里重复；状态过期隐藏但 `getByIds` 可取。

## 0.14.7 — memory_search / 无 description 的工具不再触发自动召回

- **根因**：`tool/call` 的高风险召回信号不看 `description` 是否存在，直接把工具名 + 参数拼进匹配文本。`memory_search` 的 `query` 一旦含标签（包括默认的记忆标签），就会排队一次 `before_high_risk_tool` 信号；下一步强制召回，和已经注入的摘要/正文重复。
- **修复**：只有带非空 `description` 的工具调用才允许触发高风险召回；`memory_*` 工具一律跳过（它本身就在读记忆）。工具失败信号保持原行为，不受此限制。
- 记忆工具调用仍保留一条 `stage: tool_call` 的审计锚点，只用于轨迹关联，**不会排队召回**。
- 回归测试：`memory_search`、无 `description` 的 `write` / `ops_bash` 都不产生 `signal_queued`；`memory_search` 的轨迹锚点仍在。

## 0.14.6 — 审计记忆 ID 跳转后自动展开并滚到目标记录

- **现象**：在审计详情里点某个记忆 ID，会切到记录页，但目标记录没有展开，看起来像没跳成功。
- **原因**：`openRecord` 只设置了 `focusRecord`，没有把目标记录滚进可视区；目标记录如果不在当前筛选/已加载结果里，列表里甚至没有这张卡，自然也无法展开。
- **修复**：`RecordCard` 在 `focus` 时先展开，再用 `scrollIntoView({block:'center'})` 把卡片滚到视口中央；`openRecord` 同时接收记录对象，目标不在当前列表时把它补到列表最前面，保证跳过去一定能看到并展开。
- 回归测试：带 `focus` 的记录卡自动展开。

## 0.14.5 — 修复记忆面板审计「在轨迹中定位」不生效

- **根因**：主面板把 `jumpAuditEntryToTrajectory`（签名是 `(entry) => Promise`）当成 `openTrajectory(focus)` 回调传给 `AuditTab`。按钮把 `callId` 字符串传进去，`jumpAuditEntryToTrajectory` 读不到 `entry.sessionId`，直接按 `no_session` 返回，实际什么都没发生；UI 还误报“已定位到轨迹”。
- **修复**：主面板不再传 `openTrajectory`，`AuditTab` 走模块内的 `jumpAuditEntryToTrajectory(selected)`：先 `openSession`，等 per-session store 可用后 `openView('trajectory', callId)`，Trajectory 会选中该记录并自动打开右侧详情面板。会话内「记忆」视图仍走 `openView` 回调，回调现在返回 `{opened, focused}`，提示文案按真实结果展示。
- 回归测试：主面板路径断言 `openSession('s1')` + `openView('trajectory','call-9')`。

## 0.14.4 — 轨迹行图标同时按 composer 上沿裁剪

- **根因**：0.14.3 只用 `_tablePane` 的底边做下界。Trajectory 的表格会一直延伸到浮动 composer 后面，`_tablePane` 的底边在 composer 下方；行滚到底部、被 composer 遮住时，fixed 图标仍在表格底边以内，所以继续显示。
- **修复**：可见区域下界取 `min(tablePane.bottom, composerSeat.top)`（composer 隐藏/高度为 0 时退回 tablePane 底边）；行不完全落在上下界内就不渲染标记。选中行徽标同样裁剪。
- 回归测试：表头上方的 call-3、composer 后面的 call-4 即使有审计也不标记；完全可见的 call-1 正常标记。

## 0.14.3 — 轨迹行图标按滚动容器裁剪

- **根因**：行左侧的年轮图标是 `shell.overlay` 里的 `position:fixed` 元素，不受轨迹表格 `overflow` 裁剪。行滚到表头/工具栏上方后，它的 `getBoundingClientRect()` 仍可能落在浏览器视口内，图标就留在原地，看起来“超出范围还显示”。
- **修复**：用 `row.closest('[class*="_tablePane"]')` 的上下边界，再扣掉 sticky 表头（`thead.getBoundingClientRect().bottom`）作为可见界；行不完全落在界内就不渲染标记。选中行的「记忆 N」徽标同样做这个裁剪。
- 回归测试：表头上方的 call-3 即使有审计也不标记；完全可见的 call-1 正常标记。

## 0.14.2 — 修复轨迹 callId 解析，审计页签不再全空；行内有审计图标

- **根因**：Trajectory 把 `trajectoryVirtualRecordKey()` 的结果写入 `data-trajectory-row-key`，而该函数会先 `encodeURIComponent`，DOM 上实际是 `tool%00call%00<callId>`。旧解析按原始 `\0call\0` 分隔符找，永远拿不到 callId，详情页签就用空锚点查询，所以无论点哪条记录都没有审计内容；行徽标也因此从不出现。现在先 `decodeURIComponent` 再解析，并剥掉 `\0summary\0<kind>` 后缀；未编码的旧格式也继续兼容。
- **轨迹行图标**：有记忆审计的调用行左侧显示产品年轮线条图标（12px、`fill:none`、1.3 描边、跟随 currentColor），点击直接打开该调用的记忆审计；没有审计的行不显示。图标用 `shell.overlay` 固定定位，不插轨迹表格 DOM。
- 回归测试：编码 key / 未编码 key / collapsed summary 后缀；详情页签能拿到 call-1；行标记只命中 call-1、不命中 call-2。

## 0.14.1 — 移除头部入口，记忆视图内滚，轨迹详情加审计页签

- **移除会话头部的「记忆审计」按钮**：入口收敛到会话内的「记忆」视图和轨迹详情页签，不再占用标题行。
- **记忆视图不再撑高外层**：视图声明 `data-conversation-composer-overlay`，与 Trajectory 用同一套壳层机制把 viewArea 压成固定高度；审计列表在自己的滚动容器里滚动，外层会话界面不需要跟着滚。底部为浮动 composer 预留高度。
- **轨迹详情新增「记忆审计」页签**：Trajectory 没有页签级 slot，所以页签按钮和面板放在 `shell.overlay` 里，用 fixed 定位贴着右侧详情面板（页签行预留 96px，不改 React 管理的 DOM）。点击后展示该记录的 callId 对应审计事件，底部按钮跳到本会话记忆审计面板；没有 callId 的记录明确提示无法精确过滤。选择器用 CSS Modules 稳定后缀（`_details` / `_detailTabs` / `_detailBody`），失配时静默隐藏。

## 0.14.0 — 记忆审计与会话轨迹互相精准跳转

- **审计可定位到轨迹**：审计详情新增「在轨迹中定位」。条目上的 `operationId`（记忆工具调用、触发召回的工具调用）直接作为 Trajectory 的 callId 深链；没有 `operationId` 的按轮/步事件请求新增的 `GET /memory/api/anchor`，由 Host 在会话事件窗口里找该 turn/step 的第一个 `tool/call`。找不到时只切到轨迹页，不伪造锚点。
- **轨迹行可回到审计**：新增 `shell.overlay` 徽标，只读观察 Trajectory 选中行的 `data-trajectory-row-key`，按 callId 查出相关审计并在行右侧显示「记忆 N」；点击打开记忆面板「审计」页并按 `op:<callId>` 过滤。会话标题行同时提供固定入口「记忆审计」。
- **会话内新增「记忆」视图**：与 Chat / 轨迹同一个 view ring，按当前会话展示审计；使用宿主传给每个 view 的 `openView` 完成跳转，属于官方扩展路径。主面板不在 view ring 内，通过 `conversation.session` 的 per-session store 调同一个 action（拿不到时退化为只打开会话/轨迹页）。
- **记忆工具调用入审计**：`memory_save/search/list/get/forget` 的每次调用都会记一条 `stage: tool_call` 的锚点（`operationId` = callId，带 turn/step），即使自动召回关闭也保留；信号事件同步写入 `operationId`、`turn`、`step` 与 `signal.callId`，便于把审计和轨迹对上。
- 新增 Host 纯函数 `findTrajectoryAnchor` 与回归测试；客户端新增锚点解析、焦点总线、主面板 store 桥、审计详情跳转的渲染测试。

## 0.13.2 — 修复检索分数全部相同

- **根因**：`search()` 组装最终分数时写成了 `c.id`，而候选对象只有 `c.record`，于是所有候选都落到
  `finalScores` 的同一个 `undefined` 键上 —— 每条命中拿到的都是**最后一个候选**的分数。召回顺序
  一直是对的（排序用的是 `shape`），所以只有分数是错的：工具返回的 `score`、记录页语义检索的
  「得分」全都一样。
- 同一处 `c.id` 还让传给 LLM 重排的候选 id 全变成 `undefined`，重排永远匹配不上；另外重排成功后
  只改了分数、没有重排数组，即使匹配上也不会改变结果顺序。现在两处都修好：候选用
  `c.record.id`，重排成功后按混合分数重新排序（无重排时该排序与原顺序完全一致）。
- 记录页结果卡的「相关度」改名为「得分」：这是排序分（向量/词法命中 × 重要度 × 时效 × 访问次数），
  不是 0~1 的概率，访问次数多时可能大于 1；结果顺序与它一致。
- 回归测试（`search-scores.test.ts`）：只有重要度不同的两条记录必须拿到不同分数（≈0.95 / ≈0.60）；
  重排 prompt 必须包含真实 record id，且重排能把结果顺序翻转（混合分 ≈0.84）。

## 0.13.1 — 语义检索改成 toggle 开关

- 记录页的「语义检索」从普通文字按钮改成真正的 **toggle 开关**：轨道 + 圆点 + 可见的
  「已开启 / 已关闭」，`role="switch"` + `aria-checked`，不再只靠按钮高亮表示状态。
- 造型与「向量服务」开关完全一致，配色全部走宿主主题 token：关闭态轨道 `--dsw-alias-border-l3`
  （不是几乎透明的 border-l1）、圆点 `--dsw-alias-switch-thumb`；开启态轨道
  `--dsw-alias-brand-primary`、圆点 `--dsw-alias-label-primary-foreground`。深色主题下
  轨道与圆点都有足够对比度，没有写死任何色值。
- 向量未配置时开关保持可见但禁用（半透明、轨道仍可辨认），`aria-checked` 仍如实报告 `false`。
- 测试补充：语义控件必须是 `role="switch"`、含 `toggle-track` / `toggle-knob`、开启态带 `.on`，
  状态文案随开关变化；并断言开关文字颜色来自主题 token、不含硬编码色值。

## 0.13.0 — 记录页语义检索与测试内存修复

- **记录页可以主动做语义检索**：搜索框旁边新增「语义检索」开关。开启后搜索不再做关键词过滤，
  而是走 `GET /memory/api/search`，用与 `memory_search` 同一套召回排序（向量 + 词法 + 可选重排）
  返回按相关度排好的结果，卡片上带「相关度」得分；作用域下拉、新建 / 编辑 / 删除照常可用。
- **如实标注检索出处**：结果说明会写明是「语义排序」还是「关键词回退」，并给出向量覆盖率
  （`已嵌入 / 总记录数`）；向量未启用、记录还没嵌入、向量服务无响应、旧 provider 四种情况分别说明原因，
  不把词法结果冒充成语义结果。嵌入完成后面板会自动重跑并刷成语义结果。
- **语义检索是只读浏览**：新增 provider 方法 `searchForPanel`，复用 `search()` 的召回与打分，
  但不写 `accessCount` / `lastAccessedAt`（这两个值是召回排序的输入，面板里看一眼不该把排序带偏），
  并在结果里报告向量通道是否真的参与。`search()` 新增两个内部开关（`vector` / `touch`），
  工具与注入的调用路径不受影响。
- **面板 `/search` 路由**：`q` 为空或 `topK` 非法返回 400；非法 scope 与 `/records` 同口径返回 400；
  不存在的 scope 返回空结果且不创建任何文件；旧 provider（只有 `search` 或只有 `store`）有明确的降级路径。
- **修复 client 渲染测试的堆爆炸**：测试脚手架的 `useEffect` 会跨多轮渲染累积，`runEffects()`
  把历史轮次的 effect 全部重放，效应量级按轮数指数增长（审计页自动刷新后约 100MB/测试，
  在默认 2GB 堆上直接 OOM）。改为每轮渲染只保留本轮 effect（更贴近 React 的提交语义），
  用例从 45 秒 / OOM 降到 3 秒内跑完。
- 测试：新增 provider `searchForPanel`（向量 / 词法 / 无向量 / 嵌入失败）、面板 `/search`
  （校验、作用域、降级、只读、不建文件）、客户端（开关、请求、结果说明、相关度、禁用态与回退文案）
  与包装层转发用例；全量 337 项 336 通过 1 跳过。

## 0.12.7 — 审计详情滚动与锚定浮窗

- **详情底部不再被裁切**：审计页高度收紧到 `100vh - 210px`；详情面板改为 `height:auto` +
  `max-height:calc(100vh - 340px)` + `overflow-y:auto`，并加 20px 底部内边距；「原始结构化事件」
  等底部内容可以完整滚入视口。
- **浮窗不再跟随鼠标**：浮窗改为根据 ID 气泡的 `getBoundingClientRect()` 固定定位（下方优先，
  空间不足自动翻到上方），不再随 mousemove 移动。
- **hover 延迟 + 可移入浮窗**：进入 ID 气泡后等待 350ms 才显示；显示后鼠标移到浮窗内不会隐藏，
  离开气泡/浮窗 220ms 后隐藏；不再需要重新 hover 才能看到完整 ID（浮窗标题/内容已含完整 ID）。
- 浮窗改为 `pointer-events:auto` 且可滚动，长正文可以直接在浮窗内查看/滚动。
- **点击直接跳转**：点击 ID 气泡或浮窗本身都直接执行跳转（记忆 → 记录页并展开，会话 → 打开会话）。
- 测试更新：hover 延迟后显示完整 ID、记忆原文/会话标题，点击回调仍正确。

## 0.12.6 — 审计详情分类、滚动与关联跳转

- **详情完整可滚动**：审计页采用固定视口高度 + `grid-template-rows:minmax(0,1fr)`，详情面板 `height:100%` 独立滚动，长内容可以滚到底部；整页不滚动。
- **选择与省略分类展示**：详情里按组显示「选中正文 / 本次新增 / 标签索引 / 省略（按原因分组）/ 去重跳过」，每组有数量；候选与可枚举 ID 的关系有说明，不再混成一排。
- **记忆 ID 浮窗**：hover 显示记录类型、作用域、重要度、标签与原文摘要；点击跳到「记录」页并自动展开该记录（`RecordCard` 新增 focus 展开）。记录不在当前列表时通过 `/records?id=` 精确补查。
- **会话 ID 浮窗与跳转**：hover 显示会话标题/cwd/更新时间/运行状态；点击通过宿主 `uiWorkspace.openSession` 打开会话（旧宿主退回 hash 路由）。
- 面板 `/records` 新增 `id`（精确或前缀）过滤，供审计详情按 ID 补查。
- 测试补充：详情 ID 分组、记忆/会话 ID hover 浮窗与点击回调、记录页自动展开；全量 323 项 322 通过 1 跳过。

## 0.12.5 — 审计表头与行严格对齐

- 表头移入滚动容器内部并设为 sticky：表头与行共享同一个内容宽度（含滚动条），不再出现标题比内容偏左。
- 表头与行统一 `box-sizing: border-box`，使用相同的 1px 透明/实线边框与 9px 水平内边距，列起点逐像素一致。
- 重新分配列宽：通道 140、触发/阶段 `minmax(150px,1.3fr)`、候选 `minmax(110px,.8fr)`、预算 112、
  投递 `minmax(108px,.9fr)`、结果 92；总宽度仍自适应，触发和投递不再被截断。
- 行内预算改为紧凑条（flex：进度条 + `used/budget`），不再套用详情页的三列预算网格，避免数字被裁切。
- 测试新增：表头存在、行内预算为紧凑条、表头列名可见。

## 0.12.4 — 审计页自动刷新与窗口内布局

- **自动刷新**：默认开启，间隔 0.5 秒；可关闭，并可在 0.5 / 1 / 2 / 5 / 10 秒之间切换。
  刷新在页面隐藏时跳过；静默刷新不显示加载态、不影响当前筛选与选中详情。
- **精简顶部**：移除“记忆审计”标题、解释文本和右侧“内存模式”气泡；保留带边框的内存模式提示。
- **窗口内布局**：审计页固定为视口高度，整页不再上下滚动；只有事件列表与详情各自滚动。
- **列表标题栏**：新增与行对齐的表头（时间 / 通道·事件 / 触发·阶段 / 候选·选中·省略 / 预算 / 投递 / 结果）；
  收窄触发/阶段列，放宽结果列，数值列自适应。
- **操作反馈就地显示**：“已复制”显示在复制按钮旁，导出结果显示在导出按钮旁，不再固定在顶部。
- 测试补充：审计页无标题/解释文本、自动刷新开关可见、列表位于滚动容器、筛选用自绘控件、两行筛选布局。

## 0.12.3 — 审计页筛选与滚动布局优化

- 筛选区改为两行紧凑布局：会话/通道/结果/时间范围/搜索/仅看问题/刷新在第一行，
  触发源、自定义日期、清空筛选与导出在第二行；搜索框自适应占满剩余宽度。
- 时间范围改为自绘下拉（全部 / 15 分钟 / 1 小时 / 24 小时 / 7 天 / 30 天 / 自定义）；
  “仅看问题”改用与设置页一致的自绘开关，不再使用原生 checkbox/date 控件。
- 审计事件列表放入独立纵向滚动容器（`max-height: min(58vh, 620px)`，细滚动条，
  `overscroll-behavior: contain`），筛选/详情区域保持固定，不再让整页随事件变长。
- 补充渲染测试：审计列表必须位于滚动容器、筛选分两行、筛选区不含原生 date/checkbox。

## 0.12.2 — 修复面板审计接口未转发

- **根因**：审计方法加在 `LocalMemoryService` 上，但面板通过 `ctx.get('memory')` 拿到的是
  `CordisMemoryService` 包装实例；包装层没有转发 `injectAudit / injectAuditPage /
  injectAuditStats / attachInjectAudit / detachInjectAudit`，所以 0.12.1 的「审计」页显示
  “provider 未提供注入审计接口”。
- 在 `CordisMemoryService` 上补齐五个转发方法；新增 `service-delegation.test.ts` 直接断言
  包装层暴露这些方法，防止再次“实现了但服务上看不到”。
- 升级后需要重启 DSH（或让宿主重新加载 provider），只刷新页面仍会命中旧的服务实例。

## 0.12.1 — 审计 v2 收尾

- 审计详情键值对使用唯一 key；补充日期/搜索/触发源输入的可访问标签；会话选择器回填当前选择。
- 工具栏增加「导出 JSON」（与 JSONL 同样走当前筛选）；导出仍只包含脱敏字段。
- 摘要渲染抛错也记 `source_load` 失败（`render_failed`），不再把异常带进 pre-step。
- 召回有正文但有省略时 outcome 记为 `partial`（`injected_partial`），避免把“部分注入”当成完全成功。

## 0.12.0 — 注入审计 v2

- **审计 schema v2**：事件统一带 `schemaVersion / id / seq / at / kind / channel / stage / outcome / reasonCode`，
  区分 `evaluation / delivery / signal / lifecycle / error`；新增 `filter`、`sourceLoad`、`limits`、`scopes`、
  `delivery`、`rules.injectedIds/omittedIds` 等可核对字段。旧字段仍保留兼容。
- **评估与投递分离**：评估先收集，最终消息通过保护检查后再写 `delivery`。宿主没有回执时记
  `delivery.status="unknown"`（面板显示“已准备（投递未确认）”），不把评估中的“选中”说成“已投递”；
  被重复保护/格式保护拦下时记 `suppressed` / `rejected` 与原因。
- **失败与跳过可见**：摘要加载失败、规则加载失败、无候选、全部超预算、标签过滤、退役排除、同一 query 跳过、
  关闭开关、空 query、compaction 都留下事件或明确计数，不再静默消失。
- **安全边界统一**：信号观察也走 `sanitizeAuditText`；先限制扫描长度再脱敏，最后截 200 字。审计不再保存原始
  `signal.query`。面板仍只暴露脱敏后的文本/哈希/字符数。
- **有界存储**：全局容量 2000、每会话 200，优先保留 digest / rules / delivery / error；暴露
  `capacity / dropped / writeErrors / persistence`，容量淘汰可解释。仍为内存模式，重启后丢失，文档与 UI 均明确提示。
- **类型化 sink / 生命周期**：provider 支持 `injectAuditPage / injectAuditStats / detachInjectAudit`；
  注入半边 dispose 时按 sink 身份解绑，provider 退出时释放，避免面板读到已停止更新的旧 store。
- **面板 API**：`GET /audit` 支持 `session / trace / operation / memory / channel / trigger / outcome / problem /
  since / until / limit / cursor`，稳定 `seq` 游标分页；新增 `/audit/stats` 与 `/audit/export`（JSON/JSONL，
  导出当前筛选）。旧的 `?session=` 调用保持兼容。
- **独立「审计」标签页**：事件流、概览统计、筛选工具栏、分页、详情抽屉（作用域/限制/过滤/省略/预算/投递/错误/
  原始 JSON）、复制 ID/JSON、导出、真实空状态与内存模式/丢弃/写入失败提示。
- **测试**：新增 apply 审计链路测试（stub 宿主 `createUserMessage`）、store v2 / 分页 / 副本 / 脱敏测试、
  API v2 / 导出 / store 解耦测试、provider 解绑与透传测试、审计标签页渲染测试。全量 322 项中 321 通过（1 跳过）。

## 0.11.1 — 项目作用域路径写法统一

- **事故**：0.7.0 引入 `memory_save({ path })` 时只削掉末尾分隔符，于是 Windows 上 `D:/repo` 与
  `D:\repo` 算成两个 `project:` 键、落成两个 scope 文件（sha1 不同）。写入用的是正斜杠，
  而会话读路径用的是宿主给的 `header.cwd`（反斜杠），那份记忆在工作区里**永远读不到**，
  面板/清单里还会出现两个同名绝对路径。
- **写路径统一**：`canonicalWorkspacePath()` 只做"绝不可能指向另一个目录"的改写 ——
  Windows 绝对路径统一分隔符、消掉 `.`/`..` 与末尾分隔符、盘符大写；POSIX 路径原样；
  非绝对路径不动（不拿 profile 目录去猜）。工具 `path` 参数、显式 `project:<路径>`、
  宿主会话 cwd 三处都过这一遍，读写口径一致。
- **历史数据自愈**：启动（Cordis 装配）时 `reconcileScopes()` 按 `projectScopeIdentity()`
  把"同一目录的不同写法"并到规范键：记录按 id 迁移（向量维度匹配时一起搬）、别名跟着走、
  迁空的 scope 文件由 flush 删除。只有变体存在时也会改名，否则会话读规范键仍然看不到。
  每进程只跑一次；多进程并发由 flush 的"锁内重读 + 只合并本进程增量"兜底。
- **读路径**：`listSync`（注入用）也过规范化，避免"工具读得到、注入读不到"。
- 新增 `scope-path-variants.test.ts`（写法归一、`path` 参数、历史分叉合并、`discoverScopes` 顺带合并）
  并调整既有导入/导出测试到规范写法。
- 已知限制：仅大小写不同的项目键（`D:\Repo` vs `D:\repo`）不会在写入时折叠，按记录数归到同一个
  scope 后，下次启动若出现新的写法差异仍会再合并一次；分隔符差异（本次事故）已完全统一。

## 0.11.0 — 更名「记忆系统」+ README 重写

- 插件显示名从「长期记忆」改为「记忆系统」（en: **Memory System**），覆盖插件列表、设置侧栏、左侧栏入口与面板标题。
- README 重写并补齐新截图：记录、记忆树、设置、向量服务。图片改为绝对地址，npm 页面也能正常显示。
- 无 API、配置项或数据格式变更；从旧版升级后重启一次 DSH 即可看到新名字。

## 历史版本

- **0.10.1** —— 修复深色模式下开关看不清:
  - 设置卡片的 `.switch` 与向量服务的 `.toggle` 都把圆点写死成 `#fff`,而深色主题的 `--dsw-alias-brand-primary` 是近白色(`#f9fafb`),开启态白点直接融进白轨道(对比度约 1.05:1);关闭态轨道用 `--dsw-alias-border-l1`(约 6% 透明度),在深浅色下都几乎不可见。
  - 两套开关改为跟随宿主 `[role=switch]` 的 token:关闭态轨道 `--dsw-alias-border-l3`、圆点 `--dsw-alias-switch-thumb`;开启态圆点 `--dsw-alias-label-primary-foreground`。浅色模式行为不变,深色模式轨道和圆点都可辨。
  - 新增回归测试:断言两套开关使用上述 token,不再出现 `#fff` 与 `border-l1`。
- **0.10.0** —— 存储层可多进程共用 + 向量身份带上 pooling(issue #3):
  - **跨进程安全**:不再"每个 scope 只读盘一次 + 内存快照整份重写"。每个 scope 一把锁文件(`openSync(…, 'wx')`,Windows 上 `EPERM`/`EACCES` 也按"已存在"处理),`flush()` 在锁内**重新读盘**、只把本次的增量(新增/更新/删除)合并进去;tmp 文件名带 pid + 随机后缀,两个进程并发写不会撞名破坏原子性。陈旧锁(持有者已死或 10s 未动)会被接管。
  - **读路径能看见别的进程的写入**:每 1s 限流 stat 一次,`mtime:size` 变了就重新读盘,不用重启。
  - **向量边车同样先读后写**:整份重写前先合并磁盘上同身份的条目,不覆盖别人刚追加的向量。
  - **`pooling` 进身份头**:`.vec` 首行从 `#model\tdims` 变成 `#model\tdims\tpooling`。同一个模型换 `--pooling` 就是一个新的向量空间(实测 qwen3-embedding 上 `last` 与 `cls` 的余弦只有 0.35),以前校验会静默放行。**老边车(两段)按兼容接受**,不做全量重嵌;下一次写向量时自动升级成三段。
  - **删空 scope 的判定改成"合并之后"**:别的进程写进去的记录不会被误判成"删空"而连文件一起删掉。
  - 顺手修掉 `wipeAllRecords()` 里的 `store.flushSync()`(MemoryStore 没有这个方法,异常被 catch 吞掉,实际没有同步落盘)。
  - 新增测试:`multiprocess.test.ts`(两实例交错写、删除不复活、跨实例可见性、**4 个真实子进程并发写零丢失**、不留 `.lock`/`.tmp`)与 `pooling-identity.test.ts`(三段身份、旧头兼容与升级、换 pooling 作废、无头边车丢弃)。
- **0.9.10** —— 修复 `memory_get` 没有注册:
  - `memoryTools()` 一直有 `memory_get` 的实现，但工具注册层漏了 `register(tools.memory_get, …)`，所以模型侧只能看到 save/search/forget/list 四个工具。
  - 现在注册完整五个工具；`memory_get` 输出完整 id、作用域、类型、标签和全文，找不到的 id 单独列出。
  - 新增静态守卫测试：`memoryTools` 里的每个工具都必须在 `apply.ts` 注册，防止再次“实现了但没注册”。
- **0.9.9** —— 收敛自动召回作用域与相关性:
  - 自动召回只检索 **global + 当前会话 + 当前工作区** 三个标准作用域。
  - 不再把 `inject.extraScopes` 的自定义作用域或 fork 父会话带进自动召回;普通每轮召回仍按原配置。
  - 标签触发的召回要求命中记录真的带该标签(或同义词);一个泛标签不会再靠向量相似度把完全无关的全局记忆带进来。
  - `pickQueryText` 只取**人类 user 消息**,跳过 memory / runtime / time / skill 等合成上下文,避免把上一块召回摘要当成下一轮查询。
  - `autoRecallScopes()`、合成消息过滤、标签过滤都有单元测试。
- **0.9.8** —— 设置页重写为卡片式:
  - 每个开关都有可见 label、说明和「已开启 / 已关闭」状态,不再只靠 tooltip;数值项也有独立 label 与提示。
  - 分组改成卡片:每轮召回 / 印象形态 / 会话摘要 / 记忆使用策略 / 硬性规则 / 自动召回 / 轮末提醒 / 侧栏入口;规则卡显示当前规则条数与作用域数。
  - 自动召回标签编辑器并入「自动召回」卡,保存按钮与说明同屏;数据导出 / 导入独立成卡。
  - 窄面板自动单列;新增回归测试,断言每个开关都有可见 label、hint 和状态文案。
- **0.9.7** —— 行为召回从“固定发布/部署模式”改成**标签匹配**:
  - `autoRecall.tags` 是可编辑标签列表,不再要求写正则;默认并入记忆库里已有的标签(`useMemoryTags`),所以不需要把每个标签抄进设置。
  - 匹配源扩到可见 `assistant/message` text 块、`todo/write` 任务清单、`command/run`、`goal/change`、`tool/call` 的 name/description/参数,以及 `tool/result` 失败描述;不读取 hidden reasoning。
  - 工具失败始终用该调用自己的 `description` 做检索查询;取不到才退回错误类别。
  - 标签支持中英最小同义词(`deploy` ↔ 部署、`database` ↔ 数据库等);词法检索把记录标签并入可检索文本。
  - 面板新增自动召回设置与标签编辑器;审计 signal 记录命中标签与来源。
  - 测试覆盖标签触发、description 优先、assistant text/todo/command/goal 提取、跨语言标签、标签检索与设置归一化。
- **0.9.6** —— 注入可靠性改造:
  - 摘要默认正文预算 400 → 800;旧版 `settings.json` 里仍是 400 且没有 `hintBudget` 的配置会在加载时迁移到 800,显式带 `hintBudget` 的配置不动。新增候选/正文/`top_k`/预算/退役/过期互斥统计,任何截断都有原因。
  - 被截断记录生成独立标签索引(id + 标签/主题 + 类型 + 作用域),标签有独立预算与条数上限;mandatory/pinned 与发布/部署/凭据类标签优先保留。
  - `supersedes` 旧记录统一从摘要、规则段、自动召回中退役;`memory_search` / `memory_get` 仍保留历史。
  - 规则段支持 `mandatory` / `pinned` 标签,超出预算时输出警告;规则溢出不再静默。
  - 按会话 + 记忆 id/版本去重,区分 `hint_injected` 与 `content_injected`;只给过标签的记忆可在任务命中后补正文,内容更新会重新评估;compaction 后重置摘要与去重状态。
  - 监听 `session/event` 的 `tool/call` / `tool/result`,对 `npm publish`、`git push`、部署和工具失败做定向增量召回;失败按 `MISSING_CREDENTIAL` / `PERMISSION_DENIED` / `TIMEOUT` / `ABORTED_UNKNOWN` 分类。
  - 新增内存审计环与 `GET /memory/api/audit`;记录触发原因、阶段、候选、正文、标签、去重、省略原因和各通道预算,不记录凭据。
  - 测试新增摘要截断/标签索引/退役/mandatory/会话级状态/审计/行为信号,以及一次完整的「摘要标签 → 高风险工具 → 正文召回 → 工具失败诊断」链路。
- **0.9.5** —— 新增「记忆树」标签页:
  - 所有作用域的记忆按 **作用域 → 类型 → 记录** 分层展示,根节点是总数;记录卡按类型着色(事实 / 决策 / 偏好 / 流程 / 笔记 / 规则),修正/被修正各有徽标。
  - `supersedes` 是点对点关系、不是层级,所以不改树结构:金色虚线从修正版弯到旧版的右缘,悬停或选中任意一端时,两端与整条修正链一起点亮;关闭「修正连线」可只看结构。
  - 交互:搜索(命中高亮、其余淡出)、按类型逐个开关(带计数)、作用域筛选、折叠作用域 / 类型、全部展开 / 只看作用域、缩放 / 适应;点记录打开详情抽屉(全文、标签、重要度、时间、id、双向修正链,关系项可直接跳到另一端)。
  - 布局用固定三层列 + 父节点在子树高度里居中,首次进入按画布宽度自动缩放并把根节点滚到视口中央;记录多时纵向滚动,不把面板撑长。
  - 测试:布局纯函数(分组、折叠、类型筛选、修正边只连两端都可见的记录)+ 面板标签切换冒烟;README 增加预览图。
- **0.9.4** —— 侧栏图标改回单色线稿:
  - 0.9.3 把彩色年轮瓦片放进了左侧栏入口和设置侧栏,和那一列 16px 单色线稿图标不一致。现在两处都画成**年轮线稿**:圆角瓦片轮廓 + 1.75 圈螺旋,16 网格、`fill:none`、`stroke:currentColor`、1.3 描边,深浅主题自动跟随文字色。
  - 插件列表的彩色 `icon.svg` 不变 —— 那是插件的品牌美术,只服务 30/36px 的插件卡片/行,不参与侧栏。
  - 冒烟测试改成断言侧栏图形是两条描边(`currentColor` / 1.3)、没有渐变,且 React 与 DOM 两条渲染路径的路径数据一致。
- **0.9.3** —— 侧栏图标统一成插件美术:
  - 左侧栏「记忆」入口和设置侧栏那一行原来各画各的(单色线稿芯片 / 宿主回退的齿轮),和插件列表里的年轮对不上。现在两处都直接使用 **`icon.svg` 的年轮瓦片本体**,按 `viewBox` 缩放到 16px(瓦片约 12.4px、年轮约 1.13px),三个入口是同一只图形。
  - 设置侧栏仍是把宿主那颗 16px `svg` 的孩子换掉、`viewBox` 改到 36 网格,不动布局;两处渐变的 id 分开(`logo` / `nav`),同页同时出现也不会撞 id。
  - 渲染冒烟测试新增几何/配色对账:侧栏路径必须逐字等于 `icon.svg` 的螺旋,深咖/香槟金四种颜色必须一致 —— 防止以后又退回线稿。
- **0.9.2** —— 规则增量的去重口径改成「**上一轮开始时的规则快照**」:
  - 以前按「历史里出现过的规则行」去重,而系统提示是每步重渲染的:一条规则被编辑后,如果系统提示在同一步里已经刷新成新文本,下一轮就**不会再补**,编辑等于被吞掉。
  - 现在每个会话记住每条规则 id 在**上一轮开始时**的渲染行:新增 → 补;同一 id 的行变了(编辑)→ 补,即使系统提示已经刷新;没变 → 不补。编辑回旧文本也算"变了",会补一次。
  - 宿主重启 / 第一次见到某个会话时没有快照,用「系统提示 + 历史增量块」里已经出现的规则行做种子,所以不会整批重提醒。
- **0.9.1** —— 插件列表只显示包名的问题:**加了显示名与图标**。
  - 宿主 `readPluginMeta` 只读包内 `locale/<lang>.json` 的 `meta.title` / `meta.description`(且必须能通过 `exports` 解析),缺失就回退成包名 —— 所以插件列表里一直是 `@restregular/dsh-memory` + 一长串 `package.json` 描述。现在 `locale/zh.json` 显示「**长期记忆**」,`locale/en.json` 显示「Long-term Memory」,描述也压成一行。
  - 图标从蓝色芯片换成**年轮**:深咖 `#3B2D20 → #120E0A` 圆角瓦片 + 香槟金 `#F8E2B4 → #BF8230` 螺旋(记忆是时间累积出来的年轮)。刻意避开插件列表里扎堆的蓝/白底,30px 行高下仍是一条完整的线。
  - **升级后需要重启一次 DSH**:宿主的 Node 进程会缓存 `package.json` 的 `exports` 映射。如果宿主启动时解析过**没有 locale 导出**的旧版,原地更新后列表会暂时仍显示包名(图标/描述已经是新的 —— 它们直接读文件);重启一次桌面端就恢复,之后的版本更新不再需要。
  - 构建与产物测试补了护栏:`locale` 两个文件 + `exports` 放行 + `icon.svg` 体积/格式,任何一项缺失都会构建失败(否则只会静默显示成包名)。
- **0.9.0** —— **规则变更会跟进旧会话**:
  - 以前在别的会话里新加一条 `kind=rule`,旧会话继续聊时只有系统提示段的文本会刷新 —— 不产生对话消息,模型未必会重读;而且规则段有 300 token 预算,新规则可能被更重要的旧规则挤出常驻段。
  - 现在每轮第一步比一次「该系统提示里的规则行 ∪ 历史里注入过的增量行」与当前规则,把新增/改过的补成一条 `source.kind='memory'` 消息(与召回/摘要同一条卡片来源),只提醒没出现过的;新会话第一步不补(系统提示本来就全有)。
  - 面板「设置 → 硬性规则」新增**变更提醒**开关(`rules.delta`,默认开);关掉只停这条提醒,常驻段与检索不受影响。
- **0.8.0** —— 「服务 → 维护」新增**重建全部向量**:
  - 一键把所有记录的向量(内存 + 磁盘)作废、重新排队并按当前模型重嵌,用于换过模型或怀疑向量与内容对不上时修复;只显示在两个条件都满足时(配置了后端且启用),两步确认,后台执行、不阻塞请求。
  - 进度看「待嵌入向量」:面板在有待嵌入时每 **1.5s** 自动刷新列表徽标与计数(上限 300 次);从其它标签切回「记录」也会立即刷新一次。
  - 重建期间向量检索暂时只用词法,完成一条恢复一条。
- **0.7.3** —— 修复「编辑一条记忆后一直显示待嵌入」:
  - 面板 `/update` 改内容时只删了内存里的向量、**没有把 `.vec` 标脏**,重启后旧向量仍在磁盘上,会被当成“已嵌入”继续用(而且内容已经变了)。现在旧向量在内存与磁盘上一并作废。
  - 编辑后**立即重建这一条**的向量(不再等 60s 的定时回填);重建失败才留在队列里由重试兜底。
  - 面板在有「待嵌入」时每 2s 自动刷新列表与统计(最多 30 次),徽标与计数会自己归零,不用切标签/重进面板。
- **0.7.2** —— Star / issue 那行改为居中展示。
- **0.7.1** —— 「服务」页底部加了 Star / issue 入口:「觉得好用？⭐ 去 GitHub 点个 Star · 💬 反馈建议 / 提 issue」,两段都是外链(仓库主页 / 新建 issue)。
- **0.7.0** —— 作用域语义:**`path` 指定工作区,`scope` 用作作用域显示名(别名)**。
  - `memory_save({ path: "D:/proj", scope: "我的项目" })` 写入 `project:D:/proj`;省略 `scope` 时名字就是路径。
  - 项目作用域的身份仍是 `project:<绝对路径>`,别名只是显示/引用层,不迁移数据;别名支持在读路径直接使用。
  - 同一路径同名幂等,不同路径同名**拒绝保存**(`SCOPE_NAME_TAKEN`);只有项目作用域可重命名(`global`/`session` 报 `SCOPE_NAME_UNSUPPORTED`);`path` 与 `scope:"global"/"session"` 组合报 `PATH_SCOPE_CONFLICT`。
  - 相对 `path` 按会话 cwd 解析,末尾分隔符会被归一,别名落盘 `<storeDir>/scopes.json`。
- **0.6.7** —— 记录卡展开后显示**完整 id**(等宽字体,点击复制)与**标签**;折叠时只保留预览与徽标,列表更安静。
- **0.6.6** —— 记录卡显示**标签气泡**(之前标签只存不显示,新建后看不到,容易误以为没保存);“修正”关系双向标注:修正版显示「修正自 <旧 id 前 8 位>」,被覆盖的旧记录显示「已被修正」(旧记录仍可检索,只是排序降权 0.3×);面板 `/records` 补齐 `supersededBy` 反查;新建表单的标签输入加了标签名与示例。
- **0.6.5** —— 统计卡从「服务」移到「**记录**」页顶部(和记忆列表放在一起),滚动容器高度相应扣掉统计卡那一档。
- **0.6.4** —— 标签命名对齐:概览页改名「**服务**」,记忆列表页改名「**记录**」(默认打开);从侧栏入口打开时,记录列表的滚动容器跟着窗口高度长高,不再停在设置面板那档 62vh。
- **0.6.3** —— 面板拆成三个标签:服务(统计 / 向量服务 / 维护)、**记录**(记忆列表,默认打开;列表放进独立滚动容器,滚动条为自定义细圆头样式,记忆再多也不把面板撑长)、设置(注入开关与导入导出)。
- **0.6.2** —— 设置页**去掉「保存设置」按钮**:开关拨动、数值改动即保存(连续调数值会合并成一次请求),页内只留一行“已保存”提示;顶部说明改成与行为一致的一句话(“设置保存在记忆数据目录的 settings.json”),不再写“保存后生效/无需重启”这类与实际操作不符的描述。
- **0.6.1** —— 面板与工具打磨:
  - **标签页**改成分段式按钮(选中项浅底 + 品牌色),记录页各区块之间补上间距。
  - **设置项**统一成开关按钮(不再用复选框 + “启用”文字),每条提示压到一行。
  - **侧栏入口**:新增设置开关(默认关),开启后在左侧栏「插件」下方出现「记忆」,点击在主界面打开面板;设置页里的入口不变。
  - **`memory_get`**:召回 / 摘要每行开头带 8 位 id 前缀,可按 id 或前缀直接取全文,省掉一次检索(检索耗时随模型/配置浮动)。
  - **提示词**:策略段改成“更新过时的记忆并明确告诉用户哪些过时记忆已变更”;会话摘要去掉“省得你重复摸索”;召回提示改为“以下是与你这次请求可能相关的记忆摘要”。
  - **规则可见性**:关闭「硬性规则」只影响系统提示常驻段,`memory_search` / `memory_list` / `memory_get` 仍能拿到 `kind=rule` 的记录(开关是注入开关,不是数据访问开关;面板里已写明)。
- **0.6.0** —— 注入分层,面板加「设置」标签页:
  - **印象形态召回**:每轮召回默认只给每条记忆的开头(默认 120 字)+「需要细节用 memory_search」的指引,不再一次灌 300 字全文;面板可关掉退回长文。
  - **会话摘要**:会话第一步注入一次概览 —— 项目 + global 按「新鲜度(30 天半衰期)× 重要度」挑 8 条,同分时会话 > 项目 > 自定义 > 全局。
  - **记忆使用策略**:系统提示常驻段,写清什么时候该查、查到怎么复用、查不到时低风险推断 / 高风险先问用户、什么时候该写。
  - **硬性规则**:新增记忆类型 `rule`,`kind=rule` 的记忆进系统提示常驻段(限量 10 条 / 300 token);能机械校验的规则建议做成钩子。
  - **轮末提醒**:可选(默认关),本轮跑过多步时,下一轮开头提醒「若产生了可复用结论先 memory_save」。
  - **面板设置页**:以上逐项开关 + 数值(条数 / 预算 / 每条字数),保存即生效;落盘 `<storeDir>/settings.json`。
  - **新建记忆 / 规则**:记录页「新建」,作用域可选现有作用域或直接填 `project:<路径>` / `session:<id>` / 自定义名,类型含 `rule`。
  - **导入 / 导出**:导出纯文本 JSON(不含向量),导入时按当前模型重新嵌入,按「作用域 + 内容」去重,单次上限 5000 条。
  - 摘要 / 召回 / 提醒合并成**同一条** `source.kind='memory'` 消息,不再一步两张卡片;注入按内容幂等,重复激活也不会出现两份。
- **0.5.6** —— **`project:` 作用域此前是失效的**。项目键本应跟着工作区走,但代码把 `project:${process.cwd()}` 当"显式配置"抢先传进解析函数,而 `process.cwd()` 在 DSH 里是**服务进程的启动目录 = profile 目录**(`~/.dsh/profiles/<name>`),不是工作区。后果:该 profile 下**所有项目的项目级记忆挤进同一个桶**(`project:C:\Users\…\.dsh\profiles\desktop`),互相被检索到,而真正的 `project:<工作区>` 永远是空的;面板「当前项目」也指向那里。三处同一份逻辑(服务解析、装配层默认、工具层各算一份)全部统一:**会话 `cwd` > 显式配置 `projectScope` > `process.cwd()`**,工具层改为向服务端要解析结果(`projectKeyFor`),不再自己算。显式配置现在会正确脱掉 `project:` 前缀,不再拼出 `project:project:/x`。之前写进错误桶里的数据不会自动搬家(那需要判断哪条属于哪个项目),受影响的话请手动重存。
- **0.5.5** —— 侧栏图标改成**与那一列同风格**的线稿芯片。0.5.4 虽然修好了"空一格",但画的是"蓝色瓦片 + 深墨蓝芯片"的实心方块,那是**插件管理器卡片/行**(36/30px,`icon.svg`)那套插件美术;而设置侧栏这一列全是 16px 单色细线图标(宿主内置 `Icon*OutlineMedium`:16 网格、`fill:none`、`stroke:currentColor`、线宽 1.3),实心蓝块混在里面格格不入。现在只用宿主渲染的那颗 svg 的**子节点**画线稿芯片(圆角方 + 内方 + 四引脚,1.3 描边、跟随主题),尺寸/对齐/行高仍由宿主保证。三条被验证过走不通的路都写进了代码注释:`::before` 补一个(盒子不成形 → 空一格)、给 svg 上背景(画不出描边线稿)、`content: url(...)` 替换 svg 内容(SVG 不支持 content 替换)。
- **0.5.4** —— 修 0.5.3 的图标空洞。0.5.3 是"把齿轮 `display:none` 藏掉、再用 `::before` 在同一格补一个记号",真机上出现**齿轮没了、记号也没画出来**,只剩一个空位。改成**就地覆盖**那颗 svg(不再隐藏、不再插节点)。同时删掉 0.1.0 遗留的空壳目录 `packages/dsh-memory-panel`(0.4.0 起已被单包取代),免得它继续干扰"哪个子包才是可安装的"这类判断。
- **0.5.3** —— 设置页侧栏「记忆」那一行的图标。宿主 `dsh-client-ui-settings-general` 把导航图标写死在 `navIcon(id)` 里:只有 `account` / `models` / `agent-presets` / `plugins` / `archived-sessions` 五个 id 有专属图标,其余(含 `memory`)一律回退成**齿轮**;`settings.section` 的注册契约里没有 icon 字段,宿主也不读包的 `icon`(那个只用于插件管理器)。所以插件侧按宿主的类名约定做了一次**定向覆盖**。标记只打在"文案等于「记忆」"的那个按钮上,其它区块不受影响;宿主类名约定一旦改变,规则匹配不到就自动退回齿轮。
- **0.5.2** —— 新图标:插件图标换成"芯片"记号(内存条的直白隐喻)。仍是宿主内置插件美术那套规范(36×36 画布、蓝色渐变圆角瓦片 `#69B9FF → #324DE2`、外层统一缩到 26/28),但记号改用**深墨蓝 `#0E1C58` 的圆角方 + 中心点**,而不是白色细描边 —— 这个图标同时出现在**浅色主题**下(插件管理器的卡片/行、设置导航),瓦片顶部是亮蓝,白描边在 36px 就糊成"蓝方块+白点";深墨蓝在整块渐变上都够暗,缩到 16px 仍可辨。同时去掉 SVG 里的固定 `width/height`,显示尺寸交给宿主(行 30 / 卡片 36)。
- **0.5.1** —— 清理空作用域文件:作用域被删空后(删掉最后一条、或 `POST /data/wipe`),它的 `.jsonl` 与 `.vec` 会在下一次落盘时一起移除,不再留 0 字节文件与只剩身份头的边车;下次写同一个名字会重新创建。`global.jsonl` 是唯一例外(保留作用域只清内容、留文件)。同版本的旧文件行为不变,无数据迁移。
- **0.5.0** —— 作用域重构:
  - **默认作用域 = 当前会话**:`memory_save` 省略 `scope` 时写进 `session:<会话 id>`(子代理共享父会话;拿不到会话信息或 `scopes.session: false` 时回退当前项目,不报错)。
  - **读写默认一致**:0.4.x 的写路径默认是 `project:<cwd>`、而 provider 的读路径默认是 `global` —— 写进去的记忆默认检索不到。现在两边都是「会话 + 项目 + global」合并去重(同分时 session > project > 自定义 > global)。
  - **自定义作用域**:`scope` 可以填任意名字(如 `handbook`、`项目笔记`),首次写入时自动创建;新增 `scopes.custom.enabled` / `scopes.custom.max`(默认 200,只统计自定义的)与 `SCOPE_LIMIT` / `SCOPE_INVALID` 明确报错 —— **取消了"认不出的 scope 静默回退默认值"**。
  - **`scope: 'all'`**(或 `*`)跨所有已发现作用域读取;写入路径明确报错。`memory_forget({query})` 默认只作用于当前会话,`all` + query 直接拒绝,防批量误删。
  - **读路径不再创建文件**:`memory_search` / `memory_list` / `memory_forget` / 面板对不存在的 scope 返回空结果;只有 `memory_save` 才会建文件。
  - 面板:作用域下拉与「作用域数」动态枚举现存作用域,会话 scope 显示会话标题(拿不到就「会话 <id 前 8 位>」)。
  - **不迁移、不重命名任何文件**:旧的 `global.jsonl` 与 `projects/<sha1>.jsonl` 仍按原路径原样读写;`tools.defaultScope` 保留,新增取值 `session` 并作为默认。
  - 要完全保持 0.4.x 的写行为:`tools.defaultScope: project`。
- **0.4.0** —— 单包合并里程碑:面板并入主包(一条 entry)、模型清单与硬件推荐、自定义 GGUF、运行时风味、"一次只保留一份"。
- **0.3.x 及更早** —— 拆分结构(provider / tools / inject / panel 各自独立 entry)。从 0.3.x 升级请按上面的单行 entry 重新挂载,并把旧的多条 entry 删掉。
