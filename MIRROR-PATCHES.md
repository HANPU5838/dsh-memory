# 镜像补丁清单（相对上游 v0.30.1）

本仓库是 [RestRegular/dsh-memory](https://github.com/RestRegular/dsh-memory) 的镜像。
在**上游 v0.30.1 源码**之上，本镜像叠加了下面这些「Android / Termux(glibc) 适配」补丁；
**上游 npm 包 `@restregular/dsh-memory@0.30.1` 不含它们**，直接安装上游包会覆盖。

安装本镜像的补丁版本：把仓库复制到 DSH profile 后重建，或按下方「如何应用」把改动的文件覆盖过去。

## 一、补丁列表

| # | 类型 | 改动文件（源码 / 构建产物） | 问题 | 修复 |
|---|---|---|---|---|
| P1 | **P0** 安装 | `source/memory-local/src/embed-install.ts` / `lib/provider/embed-install.js` | llama.cpp 的 Linux 发行包用两级 SONAME 软链（`libfoo.so → libfoo.so.0 → libfoo.so.0.9.0`），解压器只写普通文件、静默跳过链接 → `llama-server` 启动即报 `cannot open shared object file` 并秒退 | 两遍写盘（先普通文件，再链接；链接排在目标之前也不会悬空）；软链目标做安装目录边界校验；硬链接 `link()` 失败退化为复制 |
| P2 | P1 可诊断性 | `embed-install.ts` / `embed-install.js`、`embed-server.ts` / `embed-server.js` | 子进程秒退时主日志只有一句「进程已退出」，真实死因（缺 `.so`、端口占用、模型损坏）埋在 `llama-server.log` | 启动 15s 内退出时把日志文件末尾 12 行带进主日志 |
| P3 | P1 平台 | `source/memory-local/src/scope.ts` / `lib/provider/scope.js`、`source/tool-memory/src/index.ts` / `lib/tools/index.js` | Linux 上 `node:path.isAbsolute` 不认 `D:/x`，`memory_save({ path })` 把 Windows 路径拼到 cwd 下，同一工作区分叉出第二个 project scope | 新增 `isAbsoluteWorkspacePath()`，同时认 POSIX 与 Windows 绝对路径 |
| P4 | **P0** 默认参数 | `embed-server.ts` / `embed-server.js` | llama.cpp 物理批次默认 512；单条记忆上限 4000 字实测约 2001 token，超 512 的输入被服务端 400 拒绝，失败又被静默熔断 → 语义检索无声退化成词法 | 默认传 `-b 2048 -ub 2048`；`spawn.extraArgs` 里显式给了 batch 参数时不再重复传 |
| P5 | P1 可观测性 | `source/memory-local/src/embed.ts` / `lib/provider/embed.js`、`index.ts` | 嵌入失败（HTTP 非 2xx、响应格式/维度不符、超时、网络错误）完全静默，用户只能感到「检索变差了」 | 60 秒节流打 `warn`，带 HTTP 状态码与响应体前 200 字 |
| P6 | P1 生命周期 | `embed-server.ts` / `embed-server.js` | spawn 的 `error`（`ENOENT`/`EACCES`：exe 不存在、无执行权限、glibc 解释器缺失）不触发 `exit`，就绪轮询空转到 60 秒只报「启动超时」 | 记入 `lastError`，`waitUntilReady()` 立刻返回 false 并打印真实原因 |
| P8 | **P0** 数据可用性 | `source/memory-local/src/store.ts` / `lib/provider/store.js` | `flush()` 的写盘异常（ENOSPC / EACCES）从 unref 定时器抛出成 uncaught exception，宿主会 `exit(1)`，整个 DSH 退出 | 逐 scope `try/catch` + warn，增量保留、下次重试；定时器回调再兜一层 |
| P9 | P1 并发 | `store.ts` / `store.js` | 只读/不可写目录下 `openSync(lock,'wx')` 返回 EACCES 被当成「锁已存在」，删不掉又不休眠 → 死循环 100% CPU | 只有锁文件确实存在才按竞争处理（重试+deadline），否则抛错交给上层兜底 |
| P7 | 文档 | `README.md`、`packages/dsh-memory/README.md`、两个 `package.json`、`locale/zh.json`、`locale/en.json`、`CHANGELOG.md` | 工具数「五个 / 六个」自相矛盾（实际 6 个） | 统一为「六个模型工具」，CHANGELOG 增补本节 |

**测试**：`node --test source/*/test/*.test.ts` → **545 pass / 1 skipped**（跳过的 `multiprocess.test.ts` 需真起子进程）。

## 二、如何应用（改源码）

```bash
# 1) 拿到本镜像的源码
git clone https://github.com/HANPU5838/dsh-memory
# 2) 改完之后重新构建单包产物（无需全局依赖，Node ≥ 22 直接跑）
node tools/build-single-package.mjs --scope @restregular --version 0.30.1 \
  --repo https://github.com/HANPU5838/dsh-memory
# 3) 把 packages/dsh-memory/ 覆盖进 DSH profile
#    <profile>/node_modules/@restregular/dsh-memory/
```

> 只改源码不重建 `packages/` 是不生效的：DSH 实际加载的是 `packages/dsh-memory/lib/**`。

## 三、如何从上游同步

```bash
git remote add upstream https://github.com/RestRegular/dsh-memory
git fetch upstream
git rebase upstream/main          # 或 merge：冲突集中在 embed-install/embed-server/embed 三处
node tools/build-single-package.mjs --scope @restregular --version <新版本> \
  --repo https://github.com/HANPU5838/dsh-memory
node --test source/*/test/*.test.ts
```

上游若已修复其中某条（例如未来的 0.31 把软链解压修了），直接从本页表格里删掉对应行，避免重复补丁。

## 四、本机（Android/Termux）环境额外说明

本镜像的补丁**不包含**下面这些「仓库外兜底」，换机器时仍需要，或等上游支持：

| 项 | 现状 | 说明 |
|---|---|---|
| glibc 包装 | `~/.hangaijin/patches/glibc-compat.js`（`NODE_OPTIONS=-r` 注入） | 上游只下 `ubuntu-arm64` 的 glibc 版 `llama-server`，其 `PT_INTERP=/lib/ld-linux-aarch64.so.1` 在 Android 上不存在；本机补丁拦 `child_process.spawn` 后用 `$PREFIX/glibc/lib/ld-linux-aarch64.so.1 --library-path ...` 包装执行。插件自身仍无 Android 感知 |
| 运行参数 | profile 里 `spawn.threads: 6`、`extraArgs: --batch-size 2048 --ubatch-size 2048` | P4 之后 `-b/-ub` 已是默认，profile 里那两行可以删；线程 6 是本机 8 核实测最优 |
| 端口 | 默认 `127.0.0.1:8078` | 被占时会启动失败（P6 现在能看到原因），可改 `retrieval.vector.spawn.port` |

## 五、已知但本次未修（建议上游跟进）

按 `reviews/platform.md` 的审计结论，以下问题仍存在，供后续排期：

1. 安装完成判据只看 exe 是否存在，软链建失败静默跳过仍报「已就绪」。
2. `storeDir` 默认相对 cwd，换启动目录会分库；cwd 不可写时 provider 静默消失。
3. 文件锁 5 秒拿不到就无锁写入，Android 后台冻结时可能丢记录。
4. 下载 400+ MB 前无磁盘空间预检；模型无断点续传与校验和。
5. llama-server 被 SIGKILL（LMK/Doze）后无自愈重启，孤儿进程占内存与端口。
6. 交互检索超时 300ms，实测冷启动首次嵌入 1.8s，首查必然降级。
