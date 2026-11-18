# 验收与自检（怎么确认「全功能没有回归」）

本文回答一个问题：**改完代码 / 换完环境，怎么确定这个记忆系统还是好的？**

分三层，从「一条命令」到「真机手工」：

| 层 | 做什么 | 适合谁 |
| --- | --- | --- |
| 1. 自动验收 | `npm run verify:all` | 每次提交前 / CI |
| 2. 真机功能清单 | 按下表逐项点一遍 | 发布前 / 换设备后 |
| 3. 排查手册 | bootstrap.log + 面板自检 | 出问题时 |

---

## 1. 一条命令：`npm run verify:all`

脚本：`tools/verify-all.mjs`。它跑四层，任何一层失败退出码非 0（可直接当 pre-push hook 或 CI 步骤）：

| 层 | 检查内容 | 通过标准 |
| --- | --- | --- |
| 单元 / 集成测试 | `source/*/test/*.test.ts` 全量 | `fail = 0` |
| 单包构建 | source → 单包产物（客户端 id、入口布局、BUILD OK） | `BUILD OK`，文件数/体积正常 |
| 面板 API 冒烟 | 用构建产物 + 临时记忆库，真打 16 个关键接口 | 16/16 返回 `ok:true` |
| 向量后端实测 | 若本机有 llama-server：探活 + 真算一次向量 | 或 `SKIP`（没有在跑的后端） |

正常输出：

```
✓ 单元 / 集成测试：1327 例 / 1326 pass / 1 skip / 0 fail（约 27s）
✓ 单包构建：87 文件 / 约 2.5 MiB
✓ 面板 API 冒烟：16/16 接口通过
✓ 向量后端实测：http://127.0.0.1:8078/health · 1024 维
结论：PASS（4 通过 / 0 失败 / 0 跳过）
```

注意：

- 验收脚本**不会**触发自举（不会装包/下模型），用的是 `mkdtemp` 临时记忆库，不碰真实数据；
- 没有向量后端时第 4 层是 `SKIP` 而不是失败——词法模式本来就是合法的降级形态；
- 想指定端点：`DSH_MEMORY_VERIFY_ENDPOINT=http://127.0.0.1:11434/api/embeddings npm run verify:all`。

---

## 1.5 评测回归（CI 会跑，手动可选）

`verify:all` 只回答「代码没坏」；检索**质量**由三个纯本地评测脚本守着，CI（`.github/workflows/ci.yml`）
每次 push 都会跑，本地也可以单独跑：

| 脚本 | 测什么 | 通过口径 |
| --- | --- | --- |
| `npm run eval:graph` | 图增强多跳：合成「实体桥接」语料对比开关 | 桥接召回 0% → 100%，平均无关记录 0.00 |
| `npm run eval:tune` | 参数扫描：桥接/精确/巩固/干扰项语料，单因子扫图权重/种子/门槛/语义层 boost/PRF；含小库场景与设置开关对比 | 默认值在扫描区间内指标不劣化；图增强关闭桥接 100%→0%；动态预算最高行 156 字 vs 固定 130 |
| `npm run eval:summarize` | 召回摘要：关键结论都在正文后半段，对比前缀截断 vs TextRank | 关键结论保留率 0% → 100%，平均输出字数 80 → 67.5 |

两者都是**确定性**的（固定语料、无随机量），退出码恒 0（用于观察而非阻断），耗时秒级。
它们不联网、不碰真实记忆库（临时目录）。

---

## 1.6 一键体检与文档守门

```bash
npm run doctor        # 真实记忆库只读体检（数据完整性/设置/健康度/冲突/钩子/向量/备份）
npm run check:docs    # 版本 / badge / CHANGELOG / IMPROVEMENTS / architecture / README 链接 / build 版本
```

- `doctor` 有数据损坏时退出码 1；全新库缺 `settings.json` 视为正常。
- `check:docs` 在 `npm test` 与 CI 中都会跑：任何一次发版漏改版本号或文档链接都会直接失败。
- 0.91.0 起检索层按记录缓存分词/实体提取，1200 条库图关 75→31ms、图开 181→121ms（见 CHANGELOG）。
- 0.98.0 起设置生效性有行为级回归（graph.enabled 实时生效、impression.dynamic 影响字数、设置持久化）。

## 1.7 真实库全链路验收

```bash
npm run e2e:real                  # 复制 ~/.dsh-memory 到临时目录
npm run e2e:real -- --store /path # 指定其它库
```

只读验收，不改线上数据：复制真实库 → 加载真实作用域 → 抽样真实内容检索 → 渲染注入块并跑
`MemoryInjector` → 对副本跑 `doctor`。硬失败（检索/doctor）退出码 1，其余 0。
本机实测（0.100.0）：2 个作用域 / 71 条记录 / 5 条查询 25 条命中 / 注入块 4 行 / doctor PASS。

### 1.8 偶发失败定位

```bash
npm run probe:flake -- 10
```

同一套全量测试连续跑 N 轮（默认 5），逐轮列出失败用例；任何一轮失败退出码非 0。
`verify:all` 测试失败时还会把完整输出写到 `.verify-last-tests.log`，四段（测试/构建/面板/向量）
分别归因，不会把测试失败误报成「构建失败」。

---

## 2. 真机功能清单

`npm run verify:all` 覆盖「代码没坏」，这一节覆盖「你面前这台机器上能用」。逐项打勾即可：

| 功能 | 怎么验 | 通过标准 |
| --- | --- | --- |
| 插件加载 | 设置 → 插件列表 / 侧栏「记忆系统」入口 | 面板能打开，无报错 |
| 向量服务 | 服务页顶部圆点 + `/health` | 显示「运行中」，`8078/health` 返回 200 |
| 环境自检 | 服务页 →「环境自检」 | 运行环境 / 系统 llama-server / 后端 / 磁盘 / 目录全 ✓ |
| 写入记忆 | 记录页新建一条 / 让 Agent「记住：…」 | 出现在列表，`global.jsonl` 行数 +1 |
| 语义检索 | 记录页语义检索，用**换个说法**的问题 | 能命中语义相关的旧记录（不必字面相同） |
| 自动注入 | 新开会话问一个与旧记忆相关的问题 | 回答里带出旧结论（或 `memory_search` 能召回） |
| 规则 | 存一条 `kind: rule` 的记忆 | 新会话系统提示里能看到它 |
| 软删/恢复 | 删除一条记录 | 列表消失、30 天内可在面板恢复 |
| 冲突/健康 | 服务页「记忆健康」+ 冲突中心 | 分数能显示，不是「读取失败」 |
| 关系分析 | 关系分析页「开始分析」 | 有任务进度，产出关系/冲突/聚类 |
| 备份/恢复 | 维护 → 立即备份 → 恢复最近备份 | 备份文件出现在 `<storeDir>/backups`，恢复只补齐不覆盖 |
| 导入/导出 | 设置页导出 / 导入 | 导出 JSONL 可读，导入结果有新增/跳过计数 |
| 审计 | 审计页 | 有事件记录，导出可用 |
| 端口冲突 | 先占用 8078 再重启插件 | 自动换到 8079，日志可见「端口 8078 被占用，自动改用 8079」 |
| 自动安装（默认，0.63.0 恢复） | 全新环境（无运行时/模型）启动 | 自动 `pkg install`（Termux）+ 只下模型；日志在 `<installRoot>/bootstrap.log` |
| Termux 无 glibc | Termux 未装 glibc、无系统 llama-server 时点面板安装 | **改走 pkg 装系统运行时**，不下载 glibc 托管运行时（旧行为会 ENOENT 失败） |
| 自举（默认 auto；`autoBootstrap: 'off'` 可关） | 删掉 llama-cpp 重启（Termux） | 自动 `pkg install` + 起服务；日志在 `<installRoot>/bootstrap.log` |
| 本机端点发现 | 本机跑 Ollama 后重启 | 日志 `discovery found Ollama… adopted`，不下载任何东西 |
| 联想标记（0.94–0.97） | 两条共享路径/URL 的记忆，查询只命中 A | 工具输出与注入正文里 B 带「联想」；审计「图增强联想（补召回）」分组列出 B |
| 设置生效（0.98–0.99） | 面板关闭「图增强」后重复上面的查询 | 不再出现联想补召回；重新开启后恢复 |
| 动态预算（0.98） | 面板开启/关闭「按相关度动态分配」 | 开启时高相关记忆占更多字数；关闭后每条同上限 |
| 密钥安全（0.90） | `memory_save` 写一条含 `password: hunter2…` 或 `sk-…` 的内容 | 默认拒绝保存；`secrets.mode=redact` 时保存为 `[REDACTED:…]` |
| UI 焦点（0.93） | Tab 键在输入框/下拉/折叠头之间移动 | 每个控件有 2px 品牌色焦点轮廓 |
| 真实库验收（0.100） | `npm run e2e:real` | 复制真实库后全链路 PASS，线上数据不变 |
| 文档守门（0.92） | `npm run check:docs` | 版本/badge/CHANGELOG/链接一致 → PASS |

---

## 3. 排查手册

| 现象 | 先看哪里 | 常见原因 / 处理 |
| --- | --- | --- |
| 面板某页报 `unknown endpoint GET /xxx` | 进程是否在旧代码上 | 面板路由是「已存在就复用」：重启 `dsh web` 一次；或先把插件 disable→enable |
| 语义检索时好时坏 / 一直词法 | 服务页向量状态、`<installRoot>/bootstrap.log` | 后端没起来（端口占用会自动回退，看日志）；或查询超时后自适应预算还没生效 |
| 「记忆健康：健康度读取失败」 | 同上 | 旧面板路由残留 → 重启；新版本 `/health` 路由在隔离测试里是 200 |
| 自举没触发 | `bootstrap.log` 的 `decision=` 行 | `configured=true`（已装好，正常）；`decision=none` + `hint` 行会给出该执行的安装命令 |
| 模型下载卡住/失败 | `bootstrap.log` 的 `installer phase=` 行 | 换模型源（`retrieval.vector.autoInstall.modelSources`）或手动放 GGUF 到 `<installRoot>/models/` |
| 换了模型后检索全乱 | 向量身份（模型/维度/pooling） | 换模型会作废旧向量并重嵌入；等「待嵌入」清零再判断质量 |
| 插件卸载后 `llama-cpp` 还在 | —— | 预期行为：系统包不归插件删 |

### 日志位置速查

| 文件 | 内容 |
| --- | --- |
| `<installRoot>/bootstrap.log` | 自举决策（os/distro/pm/sys/configured）、发现的本机端点、安装器进度 |
| `<installRoot>/llama-server.log` | 托管 llama-server 的 stdout/stderr（启动失败、模型加载错误） |
| `<storeDir>/analysis/` | 关系分析产物（关系/冲突/聚类/演化快照） |
| `<storeDir>/backups/` | gzip JSONL 备份 |

---

## 3.5 发布链路检查（发版前最后一道）

```bash
npm run release:check              # 全检查；网络/gh 不可用时降级为警告
npm run release:check -- --strict  # 警告也当失败（正式发版用）
npm run release:check -- --offline # 跳过远端 tag / Release
```

核对五段：产物版本 = 仓库版本 → `npm pack` 清单含运行必需文件 → 本地 tag → 远端 tag/Release →
本地 web profile 已安装插件版本。任何一段漂移都是「用户装不到新版」的静默故障。

---

## 4. 建议的 CI 接法

```yaml
# .github/workflows/verify.yml（示例）
- run: npm run verify:all
```

CI 里第 4 层会 `SKIP`（没有本机 llama-server），前 3 层是硬门槛。真机层（第 2 节）建议在每次发版前手工过一遍，尤其换设备 / 换平台时。
