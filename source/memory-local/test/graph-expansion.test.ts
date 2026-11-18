import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService } from '../src/index.ts'
import {
  buildAssociationGraph,
  personalizedPageRank,
  pickGraphExpansion,
  queryEntitySeeds,
  graphWeightFactor,
  canonicalEntityKey,
} from '../src/retrieval/graph-expansion.ts'

/**
 * 0.65.0：图增强检索（GraphRAG / HippoRAG 风格）。
 *
 * 三层断言：
 *   1. 建图：共享实体 = 边；修正谱系 = 边；顺序无关且确定性；
 *   2. PPR：种子主导、可收敛、确定性（同输入逐位相同）；
 *   3. 集成：实体桥接的第二条记忆在开启图增强时被补召回，关掉时不被召回。
 */

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

// ---------------------------------------------------------------- 建图

test('建图：共享实体连边，无关记录不连，谱系边生效', () => {
  const graph = buildAssociationGraph([
    { id: 'b', content: '/srv/app 的 nginx 配置在 /etc/nginx/sites-enabled' },
    { id: 'a', content: '用 pm2 管理 /srv/app 服务' },
    { id: 'c', content: '完全无关的一条记忆：周末去买菜' },
    { id: 'd', content: '另一条带 /srv/app 但补充了数据库的信息', supersedes: 'x' },
  ])
  // a/b/d 共享 path:/srv/app → 两两连边；c 无共享实体 → 无边。
  assert.ok(graph.adjacency.get('a')?.has('b'), 'a-b 应有实体边')
  assert.ok(graph.adjacency.get('a')?.has('d'), 'a-d 应有实体边')
  assert.equal(graph.adjacency.get('c')?.size ?? 0, 0, '无关记录不应连边')
  // 谱系边只在目标记录也在图里时建立；'x' 不在图里，所以不产生悬空边。
  assert.ok(graph.nodes.includes('a'))
  assert.ok(graph.stats.edges >= 2, `至少两条边，实际 ${graph.stats.edges}`)
})

test('建图：输入顺序无关（确定性）', () => {
  const records = [
    { id: 'a', content: '用 pm2 管理 /srv/app 服务' },
    { id: 'b', content: '/srv/app 的 nginx 配置' },
    { id: 'c', content: 'port 8080 的调试记录' },
  ]
  const forward = buildAssociationGraph(records)
  const reversed = buildAssociationGraph([...records].reverse())
  const dump = (g: ReturnType<typeof buildAssociationGraph>): string =>
    g.nodes.map((n) => `${n}:${[...(g.adjacency.get(n) ?? new Map()).entries()].map(([k, v]) => `${k}=${v.toFixed(6)}`).sort().join(',')}`).join('|')
  assert.equal(dump(forward), dump(reversed))
})

// ---------------------------------------------------------------- PPR

test('PPR：种子节点分数最高，且同一输入结果逐位相同', () => {
  const graph = buildAssociationGraph([
    { id: 'a', content: '用 pm2 管理 /srv/app 服务' },
    { id: 'b', content: '/srv/app 的 nginx 配置' },
    { id: 'c', content: '/srv/app 的数据库连接串在这里' },
    { id: 'd', content: '无关内容：今天天气不错' },
  ])
  const ppr1 = personalizedPageRank(graph, [['a', 1]])
  const ppr2 = personalizedPageRank(graph, [['a', 1]])
  assert.deepEqual([...ppr1.entries()], [...ppr2.entries()], '确定性')
  assert.ok((ppr1.get('a') ?? 0) >= (ppr1.get('b') ?? 0), '种子分数应最高')
  assert.ok((ppr1.get('b') ?? 0) > 0, '通过共享实体应扩散到 b')
  assert.equal(ppr1.get('d') ?? 0, 0, '不连通节点不应有分数')
})

test('PPR：空种子返回空结果；非法种子被忽略', () => {
  const graph = buildAssociationGraph([{ id: 'a', content: 'x' }])
  assert.equal(personalizedPageRank(graph, []).size, 0)
  assert.equal(personalizedPageRank(graph, [['missing', 1]]).size, 0)
  const ok = personalizedPageRank(graph, [['a', Number.NaN], ['a', 1]])
  assert.deepEqual([...ok.keys()], ['a'])
})

// ---------------------------------------------------------------- 筛选

test('pickGraphExpansion：排除已有候选、按相对分门槛与上限挑选', () => {
  const ppr = new Map([
    ['a', 1],
    ['b', 0.6],
    ['c', 0.4],
    ['d', 0.01],
    ['e', 0.5],
  ])
  const picked = pickGraphExpansion({ ppr, avoid: new Set(['a']), limit: 2, minRelative: 0.3 })
  assert.deepEqual(picked.map((hit) => hit.id), ['b', 'e'], '排除 a、按分数降序、最多 2 条')
  assert.equal(picked[0]!.relative, 0.6, '相对分以全图最高 PPR 分为分母（含被排除的种子）')
  const none = pickGraphExpansion({ ppr: new Map(), avoid: new Set() })
  assert.deepEqual(none, [])
})

// ---------------------------------------------------------------- 集成

test('集成：实体桥接的第二条记忆被图增强补召回，关闭后不召回', async () => {
  const dir = tempDir('dsh-memory-graph-')
  const svc = new LocalMemoryService({
    storeDir: dir,
    scopes: { global: true, project: true },
    retrieval: {
      graphExpansion: { enabled: true, minRecords: 2, seedCount: 4, limit: 4, minRelative: 0.02 },
    },
  })
  try {
    const a = await svc.save({ content: '用 pm2 管理 /srv/app 服务', scope: 'global', kind: 'note' })
    const b = await svc.save({ content: '/srv/app 的 nginx 配置在 /etc/nginx/sites-enabled', scope: 'global', kind: 'note' })

    const hits = await svc.search({ text: 'pm2', topK: 5 })
    const ids = hits.map((hit) => hit.record.id)
    assert.ok(ids.includes(a.id), '字面命中必须召回')
    assert.ok(ids.includes(b.id), `实体桥接记忆应被补召回（实际 ${JSON.stringify(ids)}）`)
    // 0.67.0：补召回的那条要在结果里显式标记，审计/解释才能区分"联想"与"真命中"。
    const bHit = hits.find((hit) => hit.record.id === b.id)!
    assert.equal(bHit.graphExpanded, true, '图增强补召回的结果应带 graphExpanded 标记')
    const aHit = hits.find((hit) => hit.record.id === a.id)!
    assert.equal(aHit.graphExpanded, undefined, '词法真命中不应被标记成图增强')

    // 同一条查询、只关掉图增强：b 不应出现（它既不含 pm2、也没有向量通道）。
    const plainDir = tempDir('dsh-memory-graph-off-')
    const plain = new LocalMemoryService({
      storeDir: plainDir,
      scopes: { global: true, project: true },
      retrieval: { graphExpansion: { enabled: false } },
    })
    try {
      await plain.save({ content: '用 pm2 管理 /srv/app 服务', scope: 'global', kind: 'note' })
      await plain.save({ content: '/srv/app 的 nginx 配置在 /etc/nginx/sites-enabled', scope: 'global', kind: 'note' })
      const plainHits = await plain.search({ text: 'pm2', topK: 5 })
      assert.deepEqual(plainHits.map((hit) => hit.record.id).length, 1, '关闭图增强后只应召回字面命中')
    } finally {
      try { plain.flushSync() } catch { /* 已 flush */ }
      rmSync(plainDir, { recursive: true, force: true })
    }
  } finally {
    try { svc.flushSync() } catch { /* 已 flush */ }
    rmSync(dir, { recursive: true, force: true })
  }
})

test('queryEntitySeeds：查询里的实体直接映射成种子（不依赖词法命中）', () => {
  const graph = buildAssociationGraph([
    { id: 'a', content: '用 pm2 管理 /srv/app 服务' },
    { id: 'b', content: '/srv/app 的 nginx 配置在 /etc/nginx/sites-enabled' },
    { id: 'c', content: '无关内容：周末去买菜' },
  ])
  const seeds = queryEntitySeeds('想知道 /srv/app 的部署方式', graph)
  const ids = seeds.map(([id]) => id)
  assert.ok(ids.includes('a') && ids.includes('b'), `共享实体应同时命中两条（实际 ${JSON.stringify(ids)}）`)
  assert.ok(!ids.includes('c'), '无关记录不应成为种子')
  // 权重按 idf 计算且确定性：同一查询两次一致。
  assert.deepEqual(queryEntitySeeds('/srv/app', graph), queryEntitySeeds('/srv/app', graph))
  // 查询里没有实体 / 空查询 → 空种子。
  assert.deepEqual(queryEntitySeeds('今天天气不错', graph), [])
  assert.deepEqual(queryEntitySeeds('', graph), [])
})

test('graphWeightFactor：代码型查询降权、自然语言提权、有界', () => {
  const code = graphWeightFactor({ codeSignal: 1, naturalSignal: 0 })
  const natural = graphWeightFactor({ codeSignal: 0, naturalSignal: 1 })
  const neutral = graphWeightFactor({ codeSignal: 0, naturalSignal: 0 })
  assert.ok(code < neutral, `代码型应低于中性（${code} < ${neutral}）`)
  assert.ok(natural > neutral, `自然语言应高于中性（${natural} > ${neutral}）`)
  assert.ok(code >= 0.5 && natural <= 1.05, '系数保持在 0.5–1.05')
  // 非法输入安全降级为中性值。
  assert.equal(graphWeightFactor({}), neutral)
})

test('0.72.0：面板关闭图增强后不再多跳补召回（settings 实时生效）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-graph-toggle-'))
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true, project: true }, retrieval: { graphExpansion: { enabled: true, minRecords: 2 } } })
  try {
    const a = await svc.save({ scope: 'global', kind: 'note', content: '用 pm2 管理 /srv/app 服务' })
    const b = await svc.save({ scope: 'global', kind: 'note', content: '/srv/app 的 nginx 配置在 /etc/nginx/sites-enabled' })
    const before = await svc.search({ text: 'pm2', topK: 5 })
    assert.ok(before.some((hit) => hit.record.id === b.id), '默认开启时多跳应补召回 B')
    // 面板改设置（等价于 POST /settings），下一步检索立即生效。
    svc.updateInjectSettings({ graph: { enabled: false } })
    const after = await svc.search({ text: 'pm2', topK: 5 })
    assert.ok(after.some((hit) => hit.record.id === a.id), '词法真命中仍保留')
    assert.ok(!after.some((hit) => hit.record.id === b.id), '关闭后不应再补召回 B')
    // 恢复开启
    svc.updateInjectSettings({ graph: { enabled: true } })
    const again = await svc.search({ text: 'pm2', topK: 5 })
    assert.ok(again.some((hit) => hit.record.id === b.id), '重新开启后恢复多跳')
    svc.flushSync()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.76.0：实体消歧 —— 路径/标签的不同写法落到同一个图节点并合并边', () => {
  // path：反斜杠、双斜杠、尾斜杠都归一
  assert.equal(canonicalEntityKey({ type: 'path', normalized: '/srv//app/' }), canonicalEntityKey({ type: 'path', normalized: '/srv/app' }))
  assert.equal(canonicalEntityKey({ type: 'path', normalized: '\\srv\\app' }), canonicalEntityKey({ type: 'path', normalized: '/srv/app' }))
  // tag / version：大小写不敏感
  assert.equal(canonicalEntityKey({ type: 'tag', normalized: 'Deploy' }), canonicalEntityKey({ type: 'tag', normalized: 'deploy' }))
  assert.equal(canonicalEntityKey({ type: 'version', normalized: 'V1.2.3' }), canonicalEntityKey({ type: 'version', normalized: '1.2.3' }))

  // 图：两条记录用不同写法引用同一路径/标签 → 同一条边，能互相桥接
  const graph = buildAssociationGraph([
    { id: 'a', content: '/srv//app 部署服务', tags: ['Deploy'] },
    { id: 'b', content: '\\srv\\app 的 nginx 配置', tags: ['deploy'] },
    { id: 'c', content: '无关内容：周末买菜' },
  ])
  assert.deepEqual([...graph.entityDf.keys()].sort(), ['path:/srv/app', 'tag:deploy'], '不同写法应合并成两个实体')
  assert.equal(graph.entityDf.get('path:/srv/app'), 2)
  assert.equal(graph.entityDf.get('tag:deploy'), 2)

  // 查询用任一写法都能同时命中两条记录
  const seeds = queryEntitySeeds('/srv/app 怎么部署', graph).map(([id]) => id)
  assert.ok(seeds.includes('a') && seeds.includes('b'), `查询实体种子应覆盖两种写法（实际 ${JSON.stringify(seeds)}）`)
  assert.ok(!seeds.includes('c'))
})
