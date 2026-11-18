#!/usr/bin/env node
/**
 * 检索参数扫描 / 调参（0.77.0）—— 离线、确定性、零依赖。
 *
 * 目的：回答「图增强/语义层这些参数到底该取多少」。用三类合成查询分别衡量：
 *   - bridge      实体桥接多跳：查询词只在 A，B 只与 A 共享实体 → 考验图增强；
 *   - exact       精确标识符：一段唯一 token → 考验词法不被图/偏好干扰；
 *   - consolidated 巩固产物：原始记录 + 带 consolidated 标记的提炼记录 → 考验语义层偏好。
 *
 * 单因子扫描（其余参数固定为当前默认）：
 *   graphExpansion.weight  ∈ {0.4, 0.6, 0.8, 1.0, 1.2}
 *   graphExpansion.seedCount ∈ {3, 6, 9}
 *   graphExpansion.minRelative ∈ {0.02, 0.08, 0.15}
 *   semanticLayerBoost     ∈ {0, 0.04, 0.1, 0.2}
 *
 * 输出 Markdown 表格与「综合分最高」的建议值；退出码恒 0（纯本地，不联网）。
 *
 * 用法：npm run eval:tune
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService } from '../../source/memory-local/src/index.ts'

const TOP_K = 5
const TOPICS = 12
const EXACT = 8
const CONSOLIDATED = 6

function buildCorpus() {
  const records = []
  const queries = []
  // bridge：A 含查询词，B 不含，只共享实体
  for (let t = 0; t < TOPICS; t++) {
    // A 同时含「唯一关键词 + 部署」两个查询词，保证它是词法真命中（图增强要有种子才能扩散）；
    // B 不含任何查询词，只能通过共享实体 /srv/appN 被桥接回来。
    records.push({ key: `a${t}`, content: `服务 kw${t} 的部署批次 bt${t} 已完成，代码在 /srv/app${t}`, kind: 'bridgeA', topic: t })
    records.push({ key: `b${t}`, content: `/srv/app${t} 的 nginx 配置位于 /etc/nginx/sites-enabled/app${t}.conf`, kind: 'bridgeB', topic: t })
    // 干扰项：C 与 A 共享查询词与实体（但不能回答「怎么部署」），D 只共享实体。
    // 没有它们，图增强怎么调都是 100%，扫描学不到东西。
    records.push({ key: `c${t}`, content: `服务 kw${t} 的部署批次 bt${t} 的日志已清理，路径 /srv/app${t}/logs`, kind: 'distractor', topic: t })
    records.push({ key: `d${t}`, content: `关于 /srv/app${t} 的监控告警记录`, kind: 'distractor', topic: t })
    // 查询用「唯一关键词 + 唯一批次号」，避免跨主题的公共词把候选集淹掉（那会把图增强
    // 变成多主题混合 PPR，失去可解释性）。
    queries.push({ text: `kw${t} bt${t}`, kind: 'bridge', topic: t })
  }
  // exact：唯一标识符，词法应稳拿 top1
  for (let e = 0; e < EXACT; e++) {
    records.push({ key: `exact${e}`, content: `阶段码 ZXQ${e} 对应的发布批次记录`, kind: 'exact', topic: -1 })
    queries.push({ text: `ZXQ${e}`, kind: 'exact', topic: -1, exactKey: `exact${e}` })
  }
  // consolidated：同一主题的原始记录 + 提炼记录
  for (let c = 0; c < CONSOLIDATED; c++) {
    records.push({ key: `orig${c}`, content: `部署端口 90${c}0 内部服务，注意防火墙放行`, kind: 'original', topic: c })
    // 内容必须与原始记录不同（否则 save 会按内容去重，semantic 记录根本不会落库）。
    records.push({ key: `sem${c}`, content: `部署端口 90${c}0 内部服务，注意防火墙放行（已提炼为稳定结论）`, kind: 'consolidated', topic: c, tags: ['consolidated'] })
    queries.push({ text: `端口 90${c}0 部署`, kind: 'consolidated', topic: c })
  }
  // PRF：查询词 phN 只出现在 A；B 与 A 共享 deployN.sh，不含查询词。
  for (let i = 0; i < 6; i++) {
    records.push({ key: `pra${i}`, content: `ph${i} 发布流程：先跑 deploy${i}.sh，失败看日志`, kind: 'prfPseudo', topic: i })
    records.push({ key: `prb${i}`, content: `deploy${i}.sh 支持 --dry-run 预演，避免线上问题`, kind: 'prfTarget', topic: i })
    queries.push({ text: `ph${i}`, kind: 'prf', topic: i })
  }
  // 噪声
  for (let n = 0; n < 5; n++) records.push({ key: `noise${n}`, content: `无关记录 ${n}：今天天气不错，随手记一笔`, kind: 'noise', topic: -1 })
  return { records, queries }
}

function contentFor(record) {
  return record.content
}

async function evaluate(overrides) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-eval-tune-'))
  const svc = new LocalMemoryService({
    storeDir: dir,
    scopes: { global: true, project: true },
    retrieval: {
      // 参数扫描只看 词法 + 图增强 + 语义层偏好：关掉向量通道，避免嵌入服务的
      // 跨主题相似度噪声掩盖参数差异（向量是独立通道，不在本次扫描范围内）。
      vector: { enabled: false },
      graphExpansion: {
        enabled: true, minRecords: 4, seedCount: 6, limit: 6, minRelative: 0.08, weight: 0.8,
        ...(overrides.graphExpansion ?? {}),
      },
      ...(overrides.semanticLayerBoost !== undefined ? { semanticLayerBoost: overrides.semanticLayerBoost } : {}),
      ...(overrides.lexicalPrf !== undefined ? { lexicalPrf: overrides.lexicalPrf } : {}),
    },
  })
  try {
    const { records, queries } = buildCorpus()
    const ids = new Map()
    for (const record of records) {
      const saved = await svc.save({
        content: contentFor(record),
        scope: 'global',
        kind: 'note',
        ...(record.tags !== undefined ? { tags: record.tags } : {}),
      })
      ids.set(record.key, saved.id)
    }
    const byKey = (key) => ids.get(key)
    let bridgeHits = 0
    let bridgeTotal = 0
    let exactTop1 = 0
    let exactTotal = 0
    let consolidatedTop1 = 0
    let consolidatedTotal = 0
    let prfHits = 0
    let prfTotal = 0
    let noise = 0
    let hitsTotal = 0
    for (const query of queries) {
      const hits = await svc.search({ text: query.text, topK: TOP_K })
      const hitIds = hits.map((hit) => hit.record.id)
      hitsTotal += hitIds.length
      let relevant
      if (query.kind === 'bridge') {
        relevant = new Set([byKey(`a${query.topic}`), byKey(`b${query.topic}`)].filter(Boolean))
        bridgeTotal += 1
        if (hitIds.includes(byKey(`b${query.topic}`))) bridgeHits += 1
      } else if (query.kind === 'exact') {
        const exactId = byKey(query.exactKey)
        relevant = new Set([exactId].filter(Boolean))
        exactTotal += 1
        if (hitIds[0] === exactId) exactTop1 += 1
      } else if (query.kind === 'consolidated') {
        relevant = new Set([byKey(`orig${query.topic}`), byKey(`sem${query.topic}`)].filter(Boolean))
        consolidatedTotal += 1
        if (hitIds[0] === byKey(`sem${query.topic}`)) consolidatedTop1 += 1
      } else {
        // PRF：桥接目标 B 不含查询词，只能靠伪相关反馈捞回来。
        relevant = new Set([byKey(`pra${query.topic}`), byKey(`prb${query.topic}`)].filter(Boolean))
        prfTotal += 1
        if (hitIds.includes(byKey(`prb${query.topic}`))) prfHits += 1
      }
      noise += hitIds.filter((id) => !relevant.has(id)).length
    }
    return {
      bridgeRecall: bridgeTotal === 0 ? 0 : bridgeHits / bridgeTotal,
      exactTop1: exactTotal === 0 ? 0 : exactTop1 / exactTotal,
      consolidatedTop1: consolidatedTotal === 0 ? 0 : consolidatedTop1 / consolidatedTotal,
      prfRecall: prfTotal === 0 ? 0 : prfHits / prfTotal,
      noiseRate: hitsTotal === 0 ? 0 : noise / hitsTotal,
    }
  } finally {
    try { svc.flushSync() } catch { /* 已 flush */ }
    rmSync(dir, { recursive: true, force: true })
  }
}

const pct = (value) => `${(value * 100).toFixed(1)}%`
const composite = (m) => 0.35 * m.bridgeRecall + 0.25 * m.exactTop1 + 0.15 * m.consolidatedTop1 + 0.25 * m.prfRecall

const base = await evaluate({})
console.log(`## 检索参数扫描（合成语料：${TOPICS} 主题桥接 + ${EXACT} 精确 + ${CONSOLIDATED} 巩固，topK=${TOP_K}）\n`)
console.log('基线（当前默认：weight=0.8 / seedCount=6 / minRelative=0.08 / semanticLayerBoost=0.04）\n')
console.log('| 指标 | 值 |')
console.log('| --- | --- |')
console.log(`| 桥接召回 | ${pct(base.bridgeRecall)} |`)
console.log(`| 精确 top1 | ${pct(base.exactTop1)} |`)
console.log(`| 巩固 top1 | ${pct(base.consolidatedTop1)} |`)
console.log(`| PRF 召回 | ${pct(base.prfRecall)} |`)
console.log(`| 无关命中率 | ${pct(base.noiseRate)} |`)
console.log(`| 综合分 | ${composite(base).toFixed(3)} |\n`)

const sweeps = [
  { name: 'graphExpansion.weight', values: [0.4, 0.6, 0.8, 1.0, 1.2], apply: (v) => ({ graphExpansion: { weight: v } }) },
  { name: 'graphExpansion.seedCount', values: [3, 6, 9], apply: (v) => ({ graphExpansion: { seedCount: v } }) },
  { name: 'graphExpansion.minRelative', values: [0.02, 0.08, 0.15], apply: (v) => ({ graphExpansion: { minRelative: v } }) },
  { name: 'semanticLayerBoost', values: [0, 0.04, 0.1, 0.2], apply: (v) => ({ semanticLayerBoost: v }) },
  // lexicalPrf.maxTerms：先测开启（默认 maxTerms=2），再扫 1/2/3。
  { name: 'lexicalPrf', values: [false, 1, 2, 3], apply: (v) => v === false ? { lexicalPrf: { enabled: false } } : { lexicalPrf: { enabled: true, maxTerms: v } } },
]

const recommendations = []
for (const sweep of sweeps) {
  console.log(`### ${sweep.name}\n`)
  console.log('| 取值 | 桥接召回 | 精确 top1 | 巩固 top1 | PRF 召回 | 无关命中率 | 综合分 |')
  console.log('| --- | --- | --- | --- | --- | --- | --- |')
  let best = null
  for (const value of sweep.values) {
    const metrics = await evaluate(sweep.apply(value))
    const score = composite(metrics)
    // 无关命中率明显变差（> 基线 +5%）的配置不参与推荐。
    const ok = metrics.noiseRate <= base.noiseRate + 0.05
    // 分数并列时优先「当前默认值」，避免把等价配置误报成更优。
    const currentDefault = { 'graphExpansion.weight': 0.8, 'graphExpansion.seedCount': 6, 'graphExpansion.minRelative': 0.08, 'semanticLayerBoost': 0.04, 'lexicalPrf': 2 }[sweep.name]
    if (ok && (best === null || score > best.score + 1e-9
      || (Math.abs(score - best.score) <= 1e-9 && value === currentDefault))) best = { value, score }
    console.log(`| ${value} | ${pct(metrics.bridgeRecall)} | ${pct(metrics.exactTop1)} | ${pct(metrics.consolidatedTop1)} | ${pct(metrics.prfRecall)} | ${pct(metrics.noiseRate)} | ${score.toFixed(3)} |`)
  }
  console.log('')
  if (best !== null) recommendations.push({ name: sweep.name, value: best.value, score: best.score })
}

console.log('### 建议值（综合分最高且无关命中率不明显变差）\n')
console.log('| 参数 | 建议值 | 综合分 |')
console.log('| --- | --- | --- |')
for (const item of recommendations) console.log(`| ${item.name} | ${item.value} | ${item.score.toFixed(3)} |`)
console.log(`
> 本工具只做**单因子扫描**：每次只改一个参数、其余保持当前默认，因此建议值用于判断
> 参数方向，不构成联合最优。分数只对本合成集与当前算法版本有效；退出码恒 0。
`)
process.exit(0)
