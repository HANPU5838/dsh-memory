/**
 * 0.98.0：设置生效性 —— 面板/配置里的开关必须真的改变行为，而不是"存了但没人读"。
 *
 * 覆盖最容易被误以为摆设的三项：图增强开关（检索实时生效）、印象动态预算（渲染行为）、
 * 设置的持久化（updateInjectSettings → settings.json）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService } from '../../memory-local/src/index.ts'
import { renderRecallBlock, type MemoryHit } from '../src/inject.ts'
import { defaultInjectConfig } from '../src/inject.ts'

test('0.98.0：settings 的 graph.enabled 实时改变检索（关闭后没有联想补召回）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-settings-graph-'))
  const svc = new LocalMemoryService({
      cognitive: { arbiter: { enabled: false } },
    storeDir: dir,
    scopes: { global: true },
    retrieval: { vector: { enabled: false }, lexicalPrf: { enabled: false } },
  })
  try {
    let beeId = ''
    for (let i = 0; i < 4; i++) {
      await svc.save({ scope: 'global', kind: 'note', content: `服务 kw${i} 部署在 /srv/app${i}，端口 90${i}1` })
      const b = await svc.save({ scope: 'global', kind: 'note', content: `/srv/app${i} 的 nginx 配置位于 /etc/nginx/app${i}.conf` })
      if (i === 0) beeId = b.id
    }
    const on = await svc.search({ text: 'kw0 部署', topK: 5 })
    assert.ok(on.some((hit) => hit.record.id === beeId && hit.graphExpanded === true), '开启时应联想补召回')

    svc.updateInjectSettings({ graph: { enabled: false } })
    const off = await svc.search({ text: 'kw0 部署', topK: 5 })
    assert.ok(!off.some((hit) => hit.record.id === beeId), '关闭图增强后不应再联想补召回')

    svc.updateInjectSettings({ graph: { enabled: true } })
    const back = await svc.search({ text: 'kw0 部署', topK: 5 })
    assert.ok(back.some((hit) => hit.record.id === beeId && hit.graphExpanded === true), '重新开启后恢复联想')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.98.0：settings 持久化 —— updateInjectSettings 写入 settings.json 并可读回', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-settings-persist-'))
  const svc = new LocalMemoryService({
      cognitive: { arbiter: { enabled: false } }, storeDir: dir, scopes: { global: true }, retrieval: { vector: { enabled: false } } })
  try {
    svc.updateInjectSettings({ graph: { enabled: false, weight: 0.55 }, impression: { dynamic: false } })
    svc.flushSync()
    const raw = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
    assert.equal(raw.graph.enabled, false)
    assert.equal(raw.graph.weight, 0.55)
    assert.equal(raw.impression.dynamic, false)
    const live = svc.injectSettings()
    assert.equal(live.graph.enabled, false)
    assert.equal(live.impression.dynamic, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.98.0：印象动态预算真正影响每条保留字数（高相关多、低相关少）', () => {
  const long = (label: string, n: number) => ({ label, text: `${label}：${'内容'.repeat(n)}` })
  const record = (label: string): MemoryHit['record'] => ({
    id: label, scope: 'global', kind: 'fact', content: long(label, 200).text, tags: [],
    source: { origin: 'explicit', at: 0 }, createdAt: 0, updatedAt: 0, lastAccessedAt: 0, accessCount: 0, importance: 0.5,
  })
  const hits: MemoryHit[] = [
    { record: record('高分'), score: 1 },
    { record: record('低分'), score: 0.2 },
  ]
  const cfg = defaultInjectConfig
  const dynamic = renderRecallBlock(hits, cfg, { impression: true, chars: 120, dynamic: true })!
  const flat = renderRecallBlock(hits, cfg, { impression: true, chars: 120, dynamic: false })!
  const lineLengths = (block: { text: string }) => block.text.split('\n').filter((line) => line.startsWith('- ')).map((line) => line.length)
  const dyn = lineLengths(dynamic)
  const fixed = lineLengths(flat)
  assert.ok(dyn[0]! > dyn[1]!, `动态预算：高相关行应更长（${dyn.join(' / ')}）`)
  assert.equal(fixed[0], fixed[1], `固定预算：两行同字数上限（${fixed.join(' / ')}）`)
})
