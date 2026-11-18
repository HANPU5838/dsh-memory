# 现成范例

这些都是能直接用的脚本。改的时候只动判断条件，别动返回值形状 —— 形状是
`memory-hook-scripts` 正文里的约定。

## 1. 「概括：正文」格式（before-save）

最常见的规则：这条记忆必须以一句能独立看懂的概括句开头，后面用全角冒号接正文。

```js
function verify(memory) {
  const text = memory.content
  const at = text.indexOf('：')
  if (at < 0) {
    return { ok: false, message: '必须以「概括句：正文」格式保存：先写一句能独立看懂的概括，再用全角冒号「：」接正文' }
  }
  const head = text.slice(0, at).trim()
  const body = text.slice(at + 1).trim()
  if (head === '') return { ok: false, message: '冒号前是空的：概括句必须能独立看懂，不能省略' }
  if (body === '') return { ok: false, message: '冒号后是空的：正文不能省略' }
  if (head.length > 80) {
    return { ok: false, message: '概括句 ' + head.length + ' 字，太长；压到 80 字以内，把细节挪到正文' }
  }
  return { ok: true }
}
```

注意用 `indexOf('：')` 而不是 `includes`：半角 `:` 不算，避免模型偷懒用英文冒号。

## 2. 规则记忆必须能独立读懂（before-save，只拦 rule）

模型很容易写出「同上」「按上次说的做」这种离开上下文就没用的规则。

```js
function verify(memory, ctx) {
  if (memory.kind !== 'rule') return true
  const vague = ['同上', '如前所述', '按上次', '照旧', '同上条', '见上文']
  const hit = vague.filter(function (word) { return memory.content.indexOf(word) >= 0 })
  if (hit.length > 0) {
    return { ok: false, message: '规则里出现了「' + hit.join('、') + '」这类离开上下文就看不懂的指代；把被指代的内容直接写出来' }
  }
  if (memory.content.trim().length < 12) {
    return { ok: false, message: '规则太短（' + memory.content.trim().length + ' 字），很可能不完整；补上"什么时候做、具体做什么"' }
  }
  return { ok: true }
}
```

## 3. 必须带标签（before-save）

按作用域约定标签，方便以后按标签检索。

```js
function verify(memory) {
  if (memory.scope !== 'dsh-plugin-dev') return true
  const required = ['plugin']
  const have = (memory.tags || []).map(function (t) { return String(t).toLowerCase() })
  const missing = required.filter(function (tag) { return have.indexOf(tag) < 0 })
  if (missing.length > 0) {
    return { ok: false, message: '这个作用域的记录必须带标签 ' + missing.join('、') + '；请在 tags 里补上再保存' }
  }
  return { ok: true }
}
```

## 4. 凭证不入库（before-save）

比 provider 自带的密钥扫描更早、更严格的一道闸。

```js
function verify(memory) {
  const text = memory.content
  const patterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\bsk-[A-Za-z0-9]{20,}\b/,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./
  ]
  for (let i = 0; i < patterns.length; i++) {
    if (patterns[i].test(text)) {
      return { ok: false, message: '正文里出现了疑似凭据（私钥 / API key / JWT）。凭据不要写进记忆：改成"用 devcred 里的 <名字>"这种指代' }
    }
  }
  return { ok: true }
}
```

## 5. 注入前压缩长记录（before-inject）

摘要预算有限，长记录会挤掉别人。把超长正文截断成首段 + 提示。

```js
function parse(memory) {
  const limit = 400
  if (memory.content.length <= limit) return true
  const cut = memory.content.slice(0, limit)
  const at = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('\n'))
  const head = at > limit * 0.5 ? cut.slice(0, at + 1) : cut
  return {
    content: head.trim() + ' …（原文 ' + memory.content.length + ' 字，需要全文用 memory_get ' + String(memory.id).slice(0, 8) + '）'
  }
}
```

## 6. 注入前脱敏（before-inject）

把 IP / 内网地址换成占位符，避免把环境细节喷进上下文。

```js
function parse(memory) {
  const cleaned = memory.content
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<IP>')
    .replace(/\/Users\/[^\s，。；]+/g, '<PATH>')
    .replace(/[A-Z]:\\[^\s，。；]+/g, '<PATH>')
  if (cleaned === memory.content) return true
  return { content: cleaned }
}
```

## 7. 注入前丢弃过期口吻（before-inject）

「目前 / 现在」这类词在记忆里会随时间失真，干脆别注入。

```js
function parse(memory) {
  if (memory.kind !== 'state') return true
  const age = Date.now() - Number(memory.updatedAt || 0)
  const days = age / 86400000
  if (days > 30) return { drop: true }   // 30 天前的状态型记忆不再注入
  return true
}
```

## 8. 保存后观察：把可疑内容记下来（after-save）

观察者不能改结果，但能留下痕迹（`log()` 的内容会随结果回给调用方）。

```js
function observe(memory) {
  if (memory.content.length > 1500) {
    log('超长记录', memory.id, memory.content.length + ' 字')
    return { message: '这条记录偏长（' + memory.content.length + ' 字），考虑拆成两条便于检索' }
  }
  return true
}
```

## 调试脚本

不要靠猜。用 `run` 拿几段样例跑一遍：

```
memory_hooks({ action: 'run', id: '<id>', content: '这段没有冒号' })
memory_hooks({ action: 'run', id: '<id>', content: '记忆内容规范：这段合规' })
```

`run` 只跑脚本、不写记忆，是验证判断边界最快的方式。注意 `run` 用的是脚本保存时
记下的 `scopes` / `kinds` 的第一个值；要让脚本命中，样例的 `kind` 必须匹配。
