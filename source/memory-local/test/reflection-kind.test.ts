import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService } from '../src/index.ts'
import { parseReflectionField, ReflectionInvalid } from '../src/reflection.ts'

function makeService(): { svc: LocalMemoryService; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-reflect-'))
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true }, retrieval: { vector: { enabled: false } } })
  return { svc, dir }
}

test('反思候选持久化结构化字段，默认 status=candidate', async () => {
  const { svc, dir } = makeService()
  try {
    await svc.save({
      scope: 'global',
      kind: 'reflection',
      content: '改注入段时必须同步更新 docs-consistency 测试。',
      reflection: JSON.stringify({
        conclusion: '改注入段要同步文档检查',
        evidence: ['npm test 失败于 docs-consistency'],
        preconditions: ['本仓库'],
        notApplicable: ['只改测试实现'],
        confidence: 0.72,
        kindHint: 'procedure',
      }),
    })
    const listed = svc.listSync({ scopes: ['global'], kind: 'reflection' })
    assert.equal(listed.length, 1)
    const stored = listed[0] as typeof listed[0] & { reflection?: { status: string; confidence: number; preconditions: string[] } }
    assert.equal(stored.reflection?.status, 'candidate')
    assert.equal(stored.reflection?.confidence, 0.72)
    assert.deepEqual(stored.reflection?.preconditions, ['本仓库'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('反思 JSON 非法或缺 conclusion 时拒绝', async () => {
  const { svc, dir } = makeService()
  try {
    await assert.rejects(
      svc.save({ scope: 'global', kind: 'reflection', content: 'x', reflection: '{bad' }),
      (error: Error) => (error as { code?: string }).code === 'REFLECTION_INVALID',
    )
    await assert.rejects(
      svc.save({ scope: 'global', kind: 'reflection', content: 'x', reflection: JSON.stringify({ confidence: 0.5 }) }),
      (error: Error) => (error as { code?: string }).code === 'REFLECTION_INVALID',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('parseReflectionField 归一化状态与置信度', () => {
  const field = parseReflectionField({ conclusion: 'c', status: 'adopted', confidence: 5, evidence: Array.from({ length: 30 }, (_, i) => `e${i}`) })
  assert.equal(field.status, 'adopted')
  assert.equal(field.confidence, 1)
  assert.equal(field.evidence.length, 20)
  assert.throws(() => parseReflectionField({ conclusion: 'c', status: 'unknown' }), ReflectionInvalid)
})

test('不带反思字段的 reflection 记录也允许保存', async () => {
  const { svc, dir } = makeService()
  try {
    const record = await svc.save({ scope: 'global', kind: 'reflection', content: '零散反思。' })
    assert.equal(record.kind, 'reflection')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
