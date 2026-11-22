/**
 * 0.95.0：端到端一致性 —— 图增强联想标记必须贯穿「provider 召回 → 工具透传 → 渲染输出」。
 * 这是上一轮单测的补强：不 mock 服务，用真实 LocalMemoryService 验证整条链路。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService } from '../../memory-local/src/index.ts'
import { memorySearchTool } from '../src/index.ts'
import { renderSearchResult } from '../src/render.ts'

const label = (scope: string): string => (scope === 'global' ? '全局' : scope)

test('0.95.0：图增强补召回在真实服务 → 工具输出 → 渲染里都带「联想」标记', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-e2e-graph-'))
  const svc = new LocalMemoryService({
      cognitive: { arbiter: { enabled: false } },
    storeDir: dir,
    scopes: { global: true },
    retrieval: { vector: { enabled: false }, lexicalPrf: { enabled: false } },
  })
  try {
    // 4 组桥接记录：A 有查询词与路径，B 只有同一路径（没有查询词）——B 只能靠图多跳补召回。
    const bees: string[] = []
    for (let i = 0; i < 4; i++) {
      await svc.save({ scope: 'global', kind: 'note', content: `服务 kw${i} 部署在 /srv/app${i}，端口 90${i}1` })
      const b = await svc.save({ scope: 'global', kind: 'note', content: `/srv/app${i} 的 nginx 配置位于 /etc/nginx/app${i}.conf` })
      bees.push(b.id)
    }
    const tool = memorySearchTool({ getService: () => svc })
    const result = await tool.execute({ query: 'kw0 部署', topK: 5 })
    const assoc = result.records.find((hit) => bees.includes(hit.id))
    assert.ok(assoc !== undefined, `桥接记录 B0 应被图增强补召回（实际 ${result.records.map((hit) => hit.id).join(',')}）`)
    assert.equal(assoc.graphExpanded, true, '工具输出必须透传 graphExpanded')
    const text = renderSearchResult(result, label)
    assert.ok(text.includes('联想'), '渲染输出必须带「联想」标记')
    assert.ok(text.includes(assoc.id.slice(0, 8)), '被标记的正是那条记录')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})
