/**
 * 0.96.0：全链路一致性 —— 图增强联想标记也要出现在**注入上下文正文**里
 * （provider 召回 → renderRecallBlock），与工具输出、审计保持同一口径。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService } from '../../memory-local/src/index.ts'
import { renderRecallBlock } from '../src/inject.ts'
import { defaultInjectSettings } from '../../memory-local/src/inject-settings.ts'

test('0.96.0：真实服务召回的联想记录，在注入正文里带「（联想）」标记', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-inject-marker-'))
  const svc = new LocalMemoryService({
    storeDir: dir,
    scopes: { global: true },
    retrieval: { vector: { enabled: false }, lexicalPrf: { enabled: false } },
  })
  try {
    for (let i = 0; i < 4; i++) {
      await svc.save({ scope: 'global', kind: 'note', content: `服务 kw${i} 部署在 /srv/app${i}，端口 90${i}1` })
      await svc.save({ scope: 'global', kind: 'note', content: `/srv/app${i} 的 nginx 配置位于 /etc/nginx/app${i}.conf` })
    }
    const hits = await svc.search({ text: 'kw0 部署', topK: 5 })
    const block = renderRecallBlock(hits, defaultInjectSettings.recall)
    assert.ok(block !== null)
    assert.ok(block!.text.includes('（联想）'), `注入正文应带联想标记：\n${block!.text}`)
    // 直接命中的那条不带标记。
    const firstLine = block!.text.split('\n').find((line) => line.startsWith('- '))!
    assert.ok(!firstLine.includes('（联想）'))
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})
