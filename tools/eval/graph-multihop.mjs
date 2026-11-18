#!/usr/bin/env node
/**
 * 图增强多跳召回评测（0.68.0）—— 离线、确定性、零依赖。
 *
 * 目的：量化「实体桥接」这类查询上，图增强通道到底有没有用、有没有引入噪声。
 *
 * 语料构造（每主题两条 + 噪声，共 TOPICS×2 + 5 条记录）：
 *   A: `服务 kwN 由 pm2 管理，代码在 /srv/appN`      ← 查询词 kwN 只出现在这里
 *   B: `/srv/appN 的 nginx 配置位于 …`                ← 不含 kwN，只与 A 共享实体 /srv/appN
 *   N: 若干与主题无关的噪声记录
 *
 * 查询：每主题一条 `kwN 怎么部署`。
 *   - 词法/向量通道只能命中 A（B 里没有查询词）；
 *   - 只有图增强（PPR 多跳）能把 B 联想出来，B 即「桥接命中」。
 *
 * 指标：
 *   bridgeRecall  桥接记录 B 出现在 topK 的比例（越高越好）
 *   extraHits     每个查询平均多带出来的无关记录数（越低越好）
 *
 * 用法：npm run eval:graph
 * 输出 Markdown 表格；退出码恒 0（纯本地，不联网）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService } from '../../source/memory-local/src/index.ts'

const TOPICS = 20
const TOP_K = 5

function buildCorpus() {
  const records = []
  const queries = []
  for (let t = 0; t < TOPICS; t++) {
    const keyword = `kw${t}`
    const path = `/srv/app${t}`
    records.push({ id: `a${t}`, content: `服务 ${keyword} 由 pm2 管理，代码在 ${path}`, bridge: false, topic: t })
    records.push({ id: `b${t}`, content: `${path} 的 nginx 配置位于 /etc/nginx/sites-enabled/app${t}.conf`, bridge: true, topic: t })
    queries.push({ text: `${keyword} 怎么部署`, bridgeId: `b${t}`, topic: t })
  }
  for (let n = 0; n < 5; n++) {
    records.push({ id: `noise${n}`, content: `无关记录 ${n}：今天天气不错，随手记一笔`, bridge: false, topic: -1 })
  }
  return { records, queries }
}

async function run(enableGraph) {
  const dir = mkdtempSync(join(tmpdir(), enableGraph ? 'dsh-eval-graph-on-' : 'dsh-eval-graph-off-'))
  const svc = new LocalMemoryService({
    storeDir: dir,
    scopes: { global: true, project: true },
    retrieval: {
      graphExpansion: { enabled: enableGraph, minRecords: 4, seedCount: 6, limit: 6, minRelative: 0.02 },
    },
  })
  try {
    const { records, queries } = buildCorpus()
    const ids = new Map()
    for (const record of records) {
      const saved = await svc.save({ content: record.content, scope: 'global', kind: 'note' })
      ids.set(record.id, saved.id)
    }
    const bridgeById = new Map()
    for (const record of records) {
      if (record.bridge) bridgeById.set(record.id, ids.get(record.id))
    }
    const bridgeIds = new Map()
    for (const query of queries) bridgeIds.set(query.text, ids.get(query.bridgeId))

    let bridgeHits = 0
    let extraTotal = 0
    for (const query of queries) {
      const hits = await svc.search({ text: query.text, topK: TOP_K })
      const hitIds = hits.map((hit) => hit.record.id)
      const expected = bridgeIds.get(query.text)
      if (expected !== undefined && hitIds.includes(expected)) bridgeHits += 1
      // 无关记录：命中里既不是 A(topic 主记录) 也不是 B(桥接) 的那些。
      const allowed = new Set([...bridgeById.values(), ...idsOfTopicA(ids, query.topic)])
      extraTotal += hitIds.filter((id) => !allowed.has(id)).length
    }
    return {
      bridgeRecall: bridgeHits / queries.length,
      extraHits: extraTotal / queries.length,
    }
  } finally {
    try { svc.flushSync() } catch { /* 已 flush */ }
    rmSync(dir, { recursive: true, force: true })
  }
}

function idsOfTopicA(ids, topic) {
  const id = ids.get(`a${topic}`)
  return id === undefined ? [] : [id]
}

const on = await run(true)
const off = await run(false)
const pct = (value) => `${(value * 100).toFixed(1)}%`
console.log(`
## 图增强多跳召回评测（合成语料，${TOPICS} 主题 × ${TOP_K} topK）

| 指标 | 图增强关 | 图增强开 |
| --- | --- | --- |
| 桥接召回率（B 出现在 topK） | ${pct(off.bridgeRecall)} | ${pct(on.bridgeRecall)} |
| 平均无关记录数 | ${off.extraHits.toFixed(2)} | ${on.extraHits.toFixed(2)} |

> 说明：桥接记录 B 不含查询词、与查询的整句余弦也低，只有图增强（共享实体 + PPR 多跳）
> 能召回。分数只对本合成集与当前参数有效，不代表其它语料；本脚本退出码恒 0。
`)
process.exit(0)
