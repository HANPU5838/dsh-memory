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
✓ 单元 / 集成测试：1093 例 / 1092 pass / 0 fail（20s）
✓ 单包构建：78 文件 / 2143.5 KiB
✓ 面板 API 冒烟：16/16 接口通过
✓ 向量后端实测：http://127.0.0.1:8078/health · 1024 维
结论：PASS（4 通过 / 0 失败 / 0 跳过）
```

注意：

- 验收脚本**不会**触发自举（不会装包/下模型），用的是 `mkdtemp` 临时记忆库，不碰真实数据；
- 没有向量后端时第 4 层是 `SKIP` 而不是失败——词法模式本来就是合法的降级形态；
- 想指定端点：`DSH_MEMORY_VERIFY_ENDPOINT=http://127.0.0.1:11434/api/embeddings npm run verify:all`。

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
| 自举 | 删掉 llama-cpp 后重启（Termux） | 自动 `pkg install` + 起服务；日志在 `<installRoot>/bootstrap.log` |
| 本机端点发现 | 本机跑 Ollama 后重启 | 日志 `discovery found Ollama… adopted`，不下载任何东西 |

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

## 4. 建议的 CI 接法

```yaml
# .github/workflows/verify.yml（示例）
- run: npm run verify:all
```

CI 里第 4 层会 `SKIP`（没有本机 llama-server），前 3 层是硬门槛。真机层（第 2 节）建议在每次发版前手工过一遍，尤其换设备 / 换平台时。
