---
name: memory-hook-scripts
description: "Use when writing or editing the executable script that rides along with a memory rule — memory_save's hookCode / hookPhase parameters, or the memory_hooks tool (save / get / run / approve). Covers the three run phases, the sandbox API, the return contract, and ready-made validators for the 「概括：正文」 format and similar content rules."
---

# Memory hook scripts

一段规则可以带一段脚本，插件在固定时机替你运行它。这让"能写成检查的规则"从
**写给模型看的话**变成**代码强制**——模型看漏了也不会漏校验。

脚本存在 `hooks.json`，**不进记忆检索**：`memory_search` / `memory_list` / 摘要 /
自动召回都看不到代码，只有 `memory_hooks` 和面板能读。

## 三个时机

| phase | 什么时候跑 | 能否否决 | 能改正文吗 |
|---|---|---|---|
| `before-save` | `memory_save` 落盘**之前** | ✅ 返回 `{ok:false}` 直接拒绝这次保存 | 否 |
| `after-save` | 记录已经落盘**之后** | ❌ 只能附注 | 否 |
| `before-inject` | 记忆即将进入上下文**之前** | ✅（`drop:true` 丢弃整条） | ✅ 返回 `{content}` 改写 |

默认是 `before-save`。绝大多数"规范类"规则都用它。

## 写一个脚本

代码是**模块体**：里面定义一个入口函数即可，不需要 `export`，也不要写 `require`。

入口函数名按时机取：

- `before-save` → `function verify(memory, ctx)`
- `after-save` → `function observe(memory, ctx)`
- `before-inject` → `function parse(memory, ctx)`

（`main` 是所有时机的兜底名。）

```js
// 记忆内容规范：必须是「概括句 + ： + 正文」
function verify(memory) {
  const text = memory.content
  if (!text.includes('：')) {
    return { ok: false, message: '记忆内容必须是「概括句：正文」格式，缺少全角冒号「：」' }
  }
  const head = text.slice(0, text.indexOf('：')).trim()
  if (head.length === 0) {
    return { ok: false, message: '冒号前必须是能独立看懂的概括句，现在是空的' }
  }
  if (head.length > 60) {
    return { ok: false, message: '概括句太长（' + head.length + ' 字），控制在 60 字以内' }
  }
  return { ok: true }
}
```

## 能拿到什么

`memory` 是一条记忆的**纯数据拷贝**（改了也不影响真实记录）：

```js
{
  id, scope, kind, content, tags: [], importance,
  triggers, createdAt, updatedAt, expiresAt, supersedes, initial
}
```

`ctx` 描述这次调用：

```js
{ phase, tool, sessionId, description, now }
```

`tool` 是触发者（`'memory_save'` / `'memory_hooks'` / `'inject'`），可以据此分支：

```js
function verify(memory, ctx) {
  if (ctx.tool !== 'memory_save') return true   // 只拦显式保存
  ...
}
```

## 返回什么

| 返回 | 含义 |
|---|---|
| `true` / `undefined` | 通过 |
| `false` | 不通过（没有说明，模型只能看到"未通过"） |
| `{ ok: true }` | 通过 |
| `{ ok: false, message: '…' }` | 不通过，`message` 会**原样回给模型**——写清楚"哪里错、怎么改" |
| `'一段话'` | 不通过，这段话就是理由 |
| `{ ok: true, message: '…' }` | 通过，并把这句话附在工具结果里 |
| `{ content: '新正文' }` | 改写正文（`before-inject` / `after-save` 生效） |
| `{ drop: true }` | 整条丢弃（`before-inject`） |

**`message` 是写给模型看的**。它决定了模型下一次能不能自己改对，所以要说
"缺什么、应该怎样"，而不是"格式错误"。

## 沙箱里有什么

可以：`JSON` `Math` `Date` `String` `Number` `Boolean` `Array` `Object` `RegExp`
`Map` `Set` `Error` `parseInt` `parseFloat` `isNaN` `isFinite` `encodeURIComponent`
`decodeURIComponent`，以及 `log(...)`（内容会随结果回给调用方）。

**没有**：`require` / `process` / `fs` / `fetch` / `setTimeout` / `console`，
也没有 `eval` 和 `new Function`。脚本必须是**同步**的——返回 Promise 会被判为错误。

超过超时（默认 120ms）会被强制中断。

## 关键约定

**脚本自己崩了，不等于校验不通过。** 抛异常 / 超时只会记一次告警并**放行**这次
操作——否则一段写坏的校验器会让整个记忆系统无法写入，等于丢数据。所以：

- 想让保存失败，就**正常返回** `{ ok: false }`；
- 不要用 `throw` 表达"不合规"。

## 上手流程

```
1. skill 工具加载本技能（你正在读）
2. memory_hooks({ action: 'run', id: '<hook id>', content: '<试跑正文>' })
   —— 先看脚本对一段样例的判断，别直接上线
3. memory_save({ ..., hookCode: '...', hookPhase: 'before-save' })
   —— 随规则一起登记；用户会看到代码并批准一次
4. memory_hooks({ action: 'list' })
   —— 确认 pendingApproval 不是 true（未批准 = 不会运行）
```

改代码之后要重新批准：审批记的是**代码指纹**，改一个字符就会重新变回待批准。

## 常见错误

| 现象 | 原因 |
|---|---|
| `脚本里找不到入口函数` | 没定义 `verify` / `observe` / `parse` / `main` |
| `脚本无法加载` | 用了 `require` / `import` / 顶层 `await` |
| `脚本执行超时` | 死循环，或对超大字符串做了正则回溯 |
| 判定总是通过 | 忘了 `return`，函数隐式返回 `undefined`（= 通过） |
| 代码改了却不生效 | 还是待批准状态，跑一次 `action: 'approve'` |

## 更多范例

`references/examples.md` 里有：长度/标签/类型规范、重复检测、注入前脱敏与摘要压缩、
按作用域分支的校验。写新脚本前先看一眼，多数场景是改一改现成的。
