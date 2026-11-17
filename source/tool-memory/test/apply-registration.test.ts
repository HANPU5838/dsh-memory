import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { memoryTools } from '../src/index.ts'

/**
 * 守卫:memoryTools 里声明的每个工具,apply.ts 必须逐个注册。
 *
 * 0.9.9 及以前 apply.ts 漏了 memory_get:实现和测试都在,但模型侧完全看不到
 * 这个工具。这里直接对源码做静态对账,防止再出现“实现了但没注册”。
 */
test('apply registers every memoryTools entry (including memory_get)', () => {
  const names = Object.keys(memoryTools({ getService: () => undefined }))
  assert.deepEqual(names.sort(), ['memory_block', 'memory_forget', 'memory_get', 'memory_hooks', 'memory_list', 'memory_save', 'memory_scopes', 'memory_search'])
  const here = dirname(fileURLToPath(import.meta.url))
  const apply = readFileSync(join(here, '..', 'src', 'apply.ts'), 'utf8')
  for (const name of names) {
    assert.match(apply, new RegExp(`register\\(tools\\.${name}\\b`), `${name} 必须在 apply.ts 里注册`)
  }
})

/**
 * 守卫:参数只用扁平 schema。
 *
 * DSH 的 defineTool 对象参数要求显式 `additionalProperties`，而且嵌套对象的
 * `required` 也不在 authoring DSL 允许的关键字里。0.24.0 的 `memory_scopes.requests`
 * 用了嵌套 object，注册期抛错 → apply 中断 → 排在后面的 memory_get 一起消失。
 * 这里禁止任何 object/properties 参数，避免同类问题再进模型侧。
 */
test('工具参数只用扁平 schema，不使用嵌套 object', () => {
  const tools = memoryTools({ getService: () => undefined })
  for (const [name, tool] of Object.entries(tools)) {
    const text = JSON.stringify(tool.parameters)
    assert.equal(text.includes('"type":"object"'), false, `${name} 不能使用 object 参数`)
    assert.equal(text.includes('"properties"'), false, `${name} 不能使用 properties 参数`)
  }
})

/**
 * 0.36.0：memory_save 的返回提示必须统一带上「保存到的目标作用域 key」，
 * supersedes 场景再补一条修正关系。这里对渲染源码做静态守卫，防止以后改文案时
 * 把这条模型可见的关键信息删掉（模型要靠它确认记忆落在哪个作用域）。
 */
test('memory_save 渲染统一带目标作用域 key 与 supersedes 修正提示', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const apply = readFileSync(join(here, '..', 'src', 'apply.ts'), 'utf8')
  assert.ok(apply.includes('保存到的目标作用域 key'), '返回提示必须带目标作用域 key')
  assert.ok(apply.includes('value.scope'), '提示里必须用记录实际保存到的 scope')
  assert.ok(apply.includes('value.supersedes'), 'supersedes 场景必须额外说明修正关系')
})
