## 改了什么

<!-- 一句话说清这个 PR 的目的 -->

## 为什么

<!-- 关联 Issue / 场景 / 动机；行为变更请写清影响面 -->

Closes #

## 类型

- [ ] Bug 修复
- [ ] 新功能
- [ ] 重构 / 性能
- [ ] 文档
- [ ] 测试 / 构建

## 验证

<!-- 贴命令与结果，不要只写「测过了」 -->

```bash
npm test
npm run check:docs
npm run verify:all
```

## 提交前检查

- [ ] `source/` 改过之后重新跑了 `npm run build`，`packages/dsh-memory/lib` 已同步
- [ ] 新增/修改的行为有对应测试
- [ ] 没有提交凭据、token、真实记忆数据或临时文件
- [ ] 没有引入新的运行时依赖或外部网络请求（若引入，已在「为什么」里说明）
- [ ] 文档（README / docs / CHANGELOG）已同步更新
