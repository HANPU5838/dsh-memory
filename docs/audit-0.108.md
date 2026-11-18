# 0.108.0 全面审计结论（4 位审计员 + Lead）

> 审计方式：3 位只读代码审计员（检索/生命周期/安全、面板 UI/接口、测试与文档）+ Lead 直接检索
> 历史会话（`sessiongraph`）。所有结论都带文件:行号与复现；本轮修复的项见「已修」。

## 已修（本轮）

### 安全 P1
- **面板 `/embed/install` 路径穿越**：`custom.file` 可写任意可写文件。
  修复：面板层只允许 `^[\w.-]+\.gguf$` 纯文件名；`installPaths()` 再加一层 basename 防护。
- **密钥扫描绕过**：此前只扫 `content`，`tags` / `scopeRule` / `scopeDescription` 可把明文密钥写进 JSONL。
  修复：统一走 `scanField()`，refuse 模式全拒、redact 模式全脱敏。
- **钩子试跑绕过审批**：`memory_hooks run` 会执行未批准代码（vm 不是安全边界）。
  修复：保留「先试跑再批准」的工作流，但试跑结果明确标记 `unapproved:true` 并提示风险；
  正式运行仍受审批门禁。

### 正确性/性能 P2
- **冷进程跨作用域 `supersedes` 误报 SUPERSEDES_UNKNOWN**：先 `discoverScopes()` 再按 id 定位。
- **规则/偏好被静默休眠**：`markDormant` 跳过 `rule` / `preference`（硬约束不能消失）。
- **before-inject 钩子 N² 执行**：`runHooks` 增加 `only` 过滤，N 个钩子只执行 N 次。
- **巩固跨作用域退役**：`consolidateNow` 改用全局 `supersededIds()`，避免把已被取代的旧事实复活。
- **备份策略**：按用户要求改为**纯手动** —— 不自动创建、也不在创建时自动删除；
  `pruneBackups()` 仅显式调用。
- **代码标识符检索**（历史群聊点名的开发场景缺点）：分词器拆分 camelCase / PascalCase /
  缩写词 / snake_case，整词保留；新增 `identifier-tokenize` 测试。
- **审批日志 / 嵌入缓存 tmp 文件**：tmp 名带 pid+随机串，避免多进程互相覆盖。

### 文档
- README 测试数字/当前最新、verification 数字与自举矛盾、comparison 快照版本、
  architecture 工具与事件清单、analysis 模块引用、README `revoke-approval` 等全部对齐。
- `check:docs` 新增「README 当前最新 vX」校验。

## 待办 backlog（未阻塞 0.108.0，按优先级）

### 检索/生命周期/安全
1. 多进程配置缓存 fail-open：`visibility` / `blocks` / `scope-archive` 的进程内缓存不感知其它进程写入
   （建议 mtime:size 节流刷新）——安全相关，建议下轮优先。
2. `globalThreshold` 被当向量余弦地板（量纲混用）；应改用 `vector.minScore` 或独立配置。
3. 跨 scope 分数校准使用硬编码默认门槛，未跟随运行时 `globalThreshold/projectThreshold`。
4. `pickGraphExpansion` 的 maxScore 把被排除种子算进相对门槛。
5. 图增强预算在 BM25/PRF 之前算 deficit，稀疏查询可能补多。
6. 前缀屏蔽缺最小长度（建议未解析前缀 ≥8 位）。
7. 巩固合并会截断半句、`break outer` 放弃后续要点；应只追加完整要点。
8. `resolveConflictRecord` 只清一侧冲突标记；`restore()` 只查同 scope 取代关系。
9. 跨 scope `supersedes` 时 generation 不递增（`store.save` 只查同 scope target）。
10. 空查询未短路、ANN 过滤墓碑后可能不足 k、隔离回执未提示（待验证/低危）。
11. `HookStore.recordRun` 每次整份重写 hooks.json（与 N² 放大叠加）。

### 面板
1. 审计列表在 1000–1180px 被裁列且无横向滚动；短视口（360px 高）审计区可能 0 高。
2. 自绘 Dropdown 键盘不可选（全部筛选/表单）。
3. 编辑 state 记录已修「未动 TTL 不延寿」；仍需「编辑即续期」的显式提示。
4. `/scope-meta`、`/visibility` 多字段写入非原子（先校验再写/失败回滚）。
5. 设置自动保存用模块级 timer（切面板丢改动/失败不回滚）；规则代码开关乐观更新不回滚。
6. 作用域级屏蔽 0 记录时无 UI 解除入口；新建记录后不重置作用域筛选。
7. 关系分析页无 loading/error 态，0 冒充真实数据；审批 GET 无 session 返回全部会话内容。
8. 省略原因缺 `rule`/`hook` 本地化；硬编码颜色对比度不足；reduced-motion 覆盖不全；
   复制 ID 未处理剪贴板失败。

### 测试/文档
1. 插件装配层（`memory-plugin/src/index.ts` 的 part/apply）零行为覆盖；
   建议 fake cordis ctx 断言 8 工具 + 面板路由 + inject 回调 + 异常隔离。
2. 自动自举主流程（runBootstrapFlow/adopt/installVectorBackend）无集成测试。
3. 面板 `/hooks` API 无测试；写入期冲突自动裁决无端到端测试；跨进程锁接管/超时分支无测试。
4. `e2e:real` 固定关向量；`verify:all` 面板冒烟绕过真实入口（直接 import panel.js）。
5. 验收脚本自身（check-docs/check-release/flake-probe）缺测试。
