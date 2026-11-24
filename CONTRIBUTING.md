# 参与贡献

感谢你愿意花时间。这个项目是**单机 DSH 插件**，目标是「装上就能用、数据不出版机」，
所以对依赖、网络请求和运行时行为的改动会比较谨慎。

## 先聊再写

- **Bug**：直接开 Issue（用 Bug 模板），附上复现步骤、DSH 版本、系统与 Node 版本。
- **新功能 / 行为变更**：先开 Issue 说清楚场景，避免写完才发现方向不一致。
- **小修（错别字、文档、注释）**：直接提 PR 即可。

## 环境

- Node **≥ 22.13**（测试用到 `--experimental-strip-types`）
- 不需要安装任何运行时依赖；仓库没有 `node_modules` 依赖树

```bash
git clone https://github.com/HANPU5838/dsh-memory.git
cd dsh-memory
node --version
```

## 目录结构

| 路径 | 内容 |
| --- | --- |
| `source/memory-local` | 存储、检索、认知层（本项目的核心） |
| `source/memory-inject` | 自动召回与上下文注入 |
| `source/memory-panel` | 面板服务端与 HTTP 接口 |
| `source/memory-plugin` | DSH 插件入口与工具注册 |
| `source/tool-memory` | 11 个 `memory_*` 工具 |
| `packages/dsh-memory/lib` | **构建产物**（`npm run build` 生成，不要手改） |
| `tools/` | 构建、验收、评测、体检脚本 |
| `docs/` | 架构、基准、对比、验收文档 |

`source/` 是唯一的事实来源；`packages/dsh-memory/lib` 由 `npm run build` 从 `source/` 生成，
源码与产物不同步是本项目最容易犯的错——PR 前请重跑构建。

## 提交前自检

```bash
npm test          # 全量测试（Node 原生 test runner）
npm run check:docs   # 版本 / 徽章 / CHANGELOG / 链接一致性
npm run verify:all   # 四层验收：测试 → 单包构建 → 面板接口冒烟 → 向量后端（无后端则 SKIP）
```

改到检索、注入、面板或工具注册时，`verify:all` 必须通过；只改文档时可以只跑 `check:docs`。
涉及检索排序的改动，建议附上 `npm run eval:graph` / `eval:tune` / `eval:summarize` 的输出，
证明不是「看起来更好」。

## 提交规范

- 提交信息用 `fix:` / `feat:` / `docs:` / `refactor:` / `test:` / `chore:` 前缀，中文或英文都可以；
- 一个 PR 只做一件事，行为变更单独说明动机与影响面；
- PR 描述里写：改了什么、为什么、怎么验证的。

## 发版流程

维护者操作，`check:docs` 会守门：

1. 改 `package.json` 的 `version`；
2. 同步 README 的 version badge 与「当前版本 / 当前最新」行；
3. 在 `CHANGELOG.md` 顶部加条目、在 `IMPROVEMENTS.md` 顶部加同版本段落；
4. 更新 `docs/architecture.md` 标题里的版本；
5. `npm run check:docs && npm run release:check`；
6. 打 `vX.Y.Z` tag 并推送——`.github/workflows/release.yml` 会从 CHANGELOG 抽段落建 Release。

## 不要提交

- 任何凭据、token、私钥、真实记忆数据（`~/.dsh-memory` 不在这棵仓库里）；
- `node_modules/`、构建产物之外的临时文件；
- 未经说明的遥测、外部网络请求或新增依赖——这会影响「零依赖、离线可用」的定位。

## 文档翻译

`README.en.md` 是对外传播的主力文档之一。发现英文表述不自然、术语不一致或与中文版脱节，
欢迎直接提 PR；翻译类 PR 不需要跑全量测试，但 `check:docs` 仍需通过。
