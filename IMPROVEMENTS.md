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

1. 安装校验只到「链接可解析」这一步，还没有执行 `llama-server --version` 的冒烟测试（需要子进程包装串起来）。
2. 模型下载无断点续传、无 sha256 校验。
3. llama-server 被 SIGKILL 后仍可能留下孤儿进程（自愈只负责重拉，不负责清理旧的）。
4. 60 秒一次的跨 scope 发现是全量读文件，1k→10k 条规模下 IO/内存会明显变重。
5. 面板「向量服务」卡片还没有展示 `lastError` / `restarts` / 是否 glibc 包装（后端字段已就绪）。
6. 上游无 CI；本仓库同样没有（测试靠手动跑）。
