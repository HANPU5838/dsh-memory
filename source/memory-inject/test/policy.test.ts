/**
 * 策略常驻段（POLICY_TEXT）的契约测试。
 *
 * 这里锁的是「模型知不知道有 memory_block 这件工具、以及什么时候该用」：
 * 0.33.0 之前的实况是工具存在、屏蔽链路也全通，但策略段与注入头部只提
 * memory_search / memory_get / memory_forget，模型于是从不想起「无关记忆可以
 * 藏起来」—— 表现为明明有大量与当前项目无关的记忆反复注入，Agent 却一直忍着。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { POLICY_TEXT } from '../src/policy.ts'
import { renderDigest } from '../src/digest.ts'
import { renderRecallBlock } from '../src/inject.ts'
import { defaultInjectSettings } from '../../memory-local/src/inject-settings.ts'
import type { MemoryRecord } from 'dsh-memory'

test('策略段列出 memory_block 并说明它是主动降噪（不删数据、可逆）', () => {
  assert.ok(POLICY_TEXT.includes('memory_block'), '工具清单必须包含 memory_block')
  assert.ok(POLICY_TEXT.includes('无关'), '必须说明什么情况下该屏蔽')
  assert.ok(POLICY_TEXT.includes('不删除'), '必须说明屏蔽不删数据')
  assert.ok(POLICY_TEXT.includes('unblock'), '必须说明可以解除')
  // 不能把屏蔽说成清理：整个域一藏影响面大，口径要拦一下。
  assert.ok(POLICY_TEXT.includes('弹审批'), '按作用域屏蔽的代价要讲清楚')
  assert.ok(POLICY_TEXT.includes('memory_forget'), '仍要保留删除的正当用途')
})

test('策略段说明 supersedes 必须显式带 scope 且需要写权限', () => {
  assert.ok(POLICY_TEXT.includes('supersedes'), '策略段必须提到 supersedes')
  assert.ok(POLICY_TEXT.includes('必须显式带 scope'), '必须写明 scope 不能省略')
  assert.ok(POLICY_TEXT.includes('写权限'), '必须写明目标作用域要有写权限')
  assert.ok(POLICY_TEXT.includes('跨作用域'), '必须写明跨作用域修正已支持')
})

test('摘要头部：无关条目优先屏蔽，memory_forget 只用于过时/写错', () => {
  const record = {
    id: 'abcdef12-0000-4000-8000-000000000000',
    scope: 'project:D:/repo',
    kind: 'fact',
    content: '发布前先检查凭据',
    tags: [],
    source: { origin: 'explicit', at: 0 },
    createdAt: 0,
    updatedAt: Date.now(),
    lastAccessedAt: 0,
    accessCount: 0,
    importance: 0.9,
  } as MemoryRecord
  const rendered = renderDigest([record], defaultInjectSettings.digest)
  assert.ok(rendered)
  assert.ok(rendered!.text.includes('memory_block'), '摘要里要提示可以屏蔽无关条目')
  assert.ok(rendered!.text.includes('memory_forget'))
})

test('召回头部：无关条目用屏蔽而不是删除', () => {
  const record = {
    id: 'abcdef12-0000-4000-8000-000000000000',
    scope: 'project:D:/repo',
    kind: 'fact',
    content: '发布前先检查凭据',
    tags: [],
    source: { origin: 'explicit', at: 0 },
    createdAt: 0,
    updatedAt: 0,
    lastAccessedAt: 0,
    accessCount: 0,
    importance: 0.9,
  } as MemoryRecord
  const block = renderRecallBlock([{ record, score: 0.9 }], {
    ...defaultInjectSettings.recall,
    tokenBudget: 500,
  })
  assert.ok(block)
  assert.ok(block!.text.includes('memory_block'), '召回头部要给出降噪动作')
  assert.ok(!block!.text.includes('memory_forget 删除'), '不能再教模型用删除来降噪')
})
