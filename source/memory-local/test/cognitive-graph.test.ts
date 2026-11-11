/**
 * 知识图谱后端（cognitive/graph）：实体抽取各类型 / 归一化 / 去重 / 上限、
 * 共现图聚合 / 过滤 / 截断确定性、查询接口与空输入安全。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_MAX_CONTENT_CHARS,
  MAX_ENTITIES_PER_MEMORY,
  buildEntityGraph,
  entityMemories,
  entityNodeId,
  extractEntities,
  graphStats,
  relatedEntities,
  serializeGraph,
  type Entity,
  type EntityType,
  type GraphMemory,
} from '../src/cognitive/graph.ts'

/** 某类型的归一化值（升序，便于断言）。 */
function normalized(entities: readonly Entity[], type: EntityType): string[] {
  return entities
    .filter((entity) => entity.type === type)
    .map((entity) => entity.normalized)
    .sort()
}

function mem(id: string, content: string, extra: Partial<GraphMemory> = {}): GraphMemory {
  return { id, scope: 'project:graph', kind: 'note', content, ...extra }
}

// ---------------------------------------------------------------- extractEntities：各类型

test('path：POSIX / home / Windows 盘符路径,Windows 归一成小写反斜杠', () => {
  const entities = extractEntities('看 /data/data/com.termux/files/home/dsh-memory、~/notes 以及 C:\\Users\\Foo\\bar.txt 和 /tmp')
  const paths = normalized(entities, 'path')
  assert.deepEqual(paths, [
    '/data/data/com.termux/files/home/dsh-memory',
    '/tmp',
    'c:\\users\\foo\\bar.txt',
    '~/notes',
  ])
  // 太短的单段路径（/a）不算实体
  assert.deepEqual(normalized(extractEntities('参见 /a 与 /b'), 'path'), [])
})

test('url：小写 host、去默认端口与尾斜杠,label 取 host,URL 内的端口不重复算', () => {
  const entities = extractEntities('访问 https://Example.COM:443/api/v1/ 或 http://example.com:80/x，还有 https://example.com:8080/a')
  assert.deepEqual(normalized(entities, 'url'), [
    'http://example.com/x',
    'https://example.com/api/v1',
    'https://example.com:8080/a',
  ])
  assert.equal(entities.find((entity) => entity.type === 'url')!.label, 'example.com')
  // URL 里的 :443 / :8080 属于 URL 本身，不再抽成独立 port 实体
  assert.deepEqual(normalized(entities, 'port'), [])
})

test('ip：IPv4 前导零归一,非法八位组丢弃', () => {
  const entities = extractEntities('从 192.168.001.1 连到 10.0.0.1；999.1.1.1 和 1.2.3 不是合法 IP')
  assert.deepEqual(normalized(entities, 'ip'), ['10.0.0.1', '192.168.1.1'])
})

test('port：端口上下文 / host:port / 裸 :port / 范围两种写法归一,非法端口丢弃', () => {
  const entities = extractEntities('端口 8080，监听 :3000、localhost:5173 和 127.0.0.1:9000；端口范围 8080-8085；70000 不是端口')
  assert.deepEqual(normalized(entities, 'port'), ['3000', '5173', '8080', '8085', '9000'])
  const range = extractEntities('端口范围 8000~8010')
  assert.deepEqual(normalized(range, 'port'), ['8000', '8010'])
})

test('version：v 前缀与无前缀归一成同一实体,保留 prerelease', () => {
  const entities = extractEntities('用 v1.2.3 和 1.2.3 两个版本，另需 2.0.0-beta.1')
  assert.deepEqual(normalized(entities, 'version'), ['1.2.3', '2.0.0-beta.1'])
  assert.equal(normalized(extractEntities('V1.2.3'), 'version')[0], '1.2.3')
})

test('date：短横线 / 斜杠 / 中文三种写法都归一成 YYYY-MM-DD,非法日期丢弃', () => {
  const entities = extractEntities('2026-11-10、2026/1/5、2026年12月1日；2026-13-40 不是日期')
  assert.deepEqual(normalized(entities, 'date'), ['2026-01-05', '2026-11-10', '2026-12-01'])
})

test('arch：同义归一 aarch64→arm64、amd64/x64→x86_64', () => {
  const entities = extractEntities('在 aarch64 / arm64 / amd64 / x86_64 / x86 / riscv64 上构建')
  assert.deepEqual(normalized(entities, 'arch'), ['arm64', 'riscv64', 'x86', 'x86_64'])
  assert.equal(normalized(extractEntities('x64'), 'arch')[0], 'x86_64')
})

test('os：Android/Termux/Linux/Windows/macOS 识别,别名归一且大小写不敏感', () => {
  const entities = extractEntities('在 Android 上的 Termux 里，Windows 和 macOS、linux、win11、darwin 都有')
  assert.deepEqual(normalized(entities, 'os'), ['android', 'linux', 'macos', 'termux', 'windows'])
  assert.equal(entities.find((entity) => entity.normalized === 'termux')!.label, 'Termux')
})

test('tool：任务要求的工具词表全覆盖,别名归一（node.js/NodeJS→node）', () => {
  const entities = extractEntities('用 npm、pnpm、node、python、git、llama.cpp、dsh、bge-m3、bun、deno')
  const tools = normalized(entities, 'tool')
  for (const expected of ['npm', 'pnpm', 'node', 'python', 'git', 'llama.cpp', 'dsh', 'bge-m3', 'bun', 'deno']) {
    assert.ok(tools.includes(expected), `缺少工具实体 ${expected}`)
  }
  assert.deepEqual(normalized(extractEntities('用 node.js 和 NodeJS'), 'tool'), ['node'])
  assert.equal(normalized(extractEntities('跑 llama-server'), 'tool')[0], 'llama.cpp')
})

test('tag：记录 tags 作为最高权重实体,大小写/#/空值/重复都归一', () => {
  const entities = extractEntities('正文里没有可抽的东西', { tags: ['Deploy', '#deploy', '部署流程', '', '  '] })
  const tags = entities.filter((entity) => entity.type === 'tag')
  assert.deepEqual(tags.map((entity) => entity.normalized).sort(), ['deploy', '部署流程'])
  assert.equal(tags.find((tag) => tag.normalized === 'deploy')!.weight, 1)
  // tag 权重最高 → 排在最前
  assert.equal(entities[0]!.type, 'tag')
})

test('identifier：camelCase / snake_case / 大写缩写,常见英文大写词与其他类型不重复抽', () => {
  const entities = extractEntities('配置 getUserById、max_tokens、API 与 JSON，OK 不算')
  assert.deepEqual(normalized(entities, 'identifier'), ['api', 'getuserbyid', 'json', 'maxtokens'])
  // 与词表重叠的词（Termux / npm）被更早的类型占位，不会再变成 identifier
  const mixed = extractEntities('Termux 上跑 npm')
  assert.deepEqual(normalized(mixed, 'identifier'), [])
})

test('去重 + 数量上限 + 确定性：同一输入两次结果完全一致,实体数不超过 24', () => {
  const content = 'npm npm npm node node git git llama.cpp dsh bge-m3 typescript javascript rust cargo golang java kotlin swift docker podman kubernetes sqlite postgresql mysql redis mongodb curl wget'
  const first = extractEntities(content)
  const second = extractEntities(content)
  assert.deepEqual(first, second)
  assert.ok(first.length <= MAX_ENTITIES_PER_MEMORY)
  assert.equal(MAX_ENTITIES_PER_MEMORY, 24)
  assert.equal(new Set(first.map((entity) => `${entity.type}:${entity.normalized}`)).size, first.length, '实体不重复')
  assert.equal(extractEntities(content, { maxEntities: 5 }).length, 5)
})

test('非法 / 超长输入安全：null/数字/空串/超长正文都不抛异常,按 maxLength 截断', () => {
  assert.deepEqual(extractEntities(null as unknown as string), [])
  assert.deepEqual(extractEntities(undefined as unknown as string), [])
  assert.deepEqual(extractEntities(123 as unknown as string), [])
  assert.deepEqual(extractEntities(''), [])
  assert.deepEqual(extractEntities({} as unknown as string), [])
  // 非法 tags 安全降级
  assert.deepEqual(extractEntities('', { tags: [null, 11, ''] as unknown as string[] }), [])

  const long = 'a'.repeat(9000) + ' 端口 8080'
  assert.deepEqual(normalized(extractEntities(long), 'port'), [], '默认 maxLength 把端口截在窗口外')
  assert.deepEqual(normalized(extractEntities(long, { maxLength: 20_000 }), 'port'), ['8080'])
  assert.equal(DEFAULT_MAX_CONTENT_CHARS, 8000)
  assert.doesNotThrow(() => extractEntities('中文'.repeat(50_000)))
})

// ---------------------------------------------------------------- buildEntityGraph

test('图聚合：节点 count / scopes / kinds / memoryIndex,边按共现计数', () => {
  const records = [
    mem('m1', 'npm 与 node 在 termux 上'),
    mem('m2', 'node 和 npm 配 termux', { kind: 'fact' }),
    mem('m3', 'golang 与 docker', { scope: 'global' }),
    mem('m4', 'npm node 又一次'),
  ]
  const graph = buildEntityGraph(records)
  assert.deepEqual(graph.stats, { entities: 5, edges: 4, memories: 4 })

  const node = graph.nodes.find((item) => item.id === entityNodeId('tool', 'node'))!
  assert.equal(node.count, 3)
  assert.deepEqual(node.scopes, ['project:graph'])
  assert.deepEqual(node.kinds, { fact: 1, note: 2 })
  assert.equal(node.label, 'Node.js')
  assert.deepEqual(graph.nodes[0]!.id, 'tool:node', 'count 相同时按 id 升序')

  const npmNode = graph.nodes.find((item) => item.id === 'tool:npm')!
  assert.deepEqual(entityMemories(graph, npmNode.id), ['m1', 'm2', 'm4'])
  assert.deepEqual(entityMemories(graph, 'tool:不存在'), [])
  // 每条边 a < b,且边只连最终节点
  for (const edge of graph.edges) assert.ok(edge.a < edge.b)
  // node-npm 共现 3 次（m1/m2/m4）
  assert.equal(graph.edges.find((edge) => edge.a === 'tool:node' && edge.b === 'tool:npm')!.weight, 3)
})

test('共现权重：同一条记忆内每对实体只 +1,不同记忆累计', () => {
  const graph = buildEntityGraph([
    mem('x1', 'npm node'),
    mem('x2', 'node npm'), // 同一对,顺序无关
    mem('x3', 'npm deno'),
  ])
  // 边两端按 id 字典序存（tool:node < tool:npm），这里双向查找更稳
  const edge = (a: string, b: string) => graph.edges.find((item) => (item.a === a && item.b === b) || (item.a === b && item.b === a))?.weight
  assert.equal(edge('tool:npm', 'tool:node'), 2)
  assert.equal(edge('tool:npm', 'tool:deno'), 1)
  assert.equal(edge('tool:deno', 'tool:node'), undefined, '没有共同记忆就不连边')
})

test('过滤：scopes / kinds（字符串或数组）只统计命中记录', () => {
  const records = [
    mem('a1', 'npm 与 node', { scope: 'project:x', kind: 'note' }),
    mem('a2', 'npm 与 git', { scope: 'project:x', kind: 'rule' }),
    mem('a3', 'npm 与 node', { scope: 'global', kind: 'note' }),
  ]
  const byScope = buildEntityGraph(records, { scopes: 'global' })
  assert.deepEqual(byScope.nodes.map((node) => node.id), ['tool:node', 'tool:npm'])
  assert.equal(byScope.stats.memories, 1)

  const byKind = buildEntityGraph(records, { kinds: ['rule'] })
  assert.deepEqual(byKind.nodes.map((node) => node.id), ['tool:git', 'tool:npm'])

  const minCount = buildEntityGraph(records, { minCount: 2 })
  assert.deepEqual(minCount.nodes.map((node) => node.id), ['tool:npm', 'tool:node'], 'npm 出现 3 次、node 2 次,git 只出现 1 次被过滤')
})

test('截断确定性：节点 count↓/id↑、边 weight↓/a↑/b↑,打乱输入顺序结果不变', () => {
  const records = [
    mem('t1', 'npm node git'),
    mem('t2', 'npm node'),
    mem('t3', 'npm'),
    mem('t4', 'deno'),
  ]
  const graph = buildEntityGraph(records, { maxNodes: 3, maxEdges: 1 })
  assert.deepEqual(graph.nodes.map((node) => [node.id, node.count]), [
    ['tool:npm', 3],
    ['tool:node', 2],
    ['tool:deno', 1], // 与 git 并列,按 id 升序
  ])
  assert.deepEqual(graph.edges, [{ a: 'tool:node', b: 'tool:npm', weight: 2 }])

  const permuted = buildEntityGraph([records[3]!, records[1]!, records[0]!, records[2]!], { maxNodes: 3, maxEdges: 1 })
  assert.deepEqual(permuted.nodes, graph.nodes)
  assert.deepEqual(permuted.edges, graph.edges)
  assert.deepEqual([...permuted.memoryIndex.entries()], [...graph.memoryIndex.entries()])

  // count 全相等时纯 id 升序,输入顺序无关
  const tieA = buildEntityGraph([mem('u1', 'npm'), mem('u2', 'node'), mem('u3', 'git')], { maxNodes: 2 })
  const tieB = buildEntityGraph([mem('u3', 'git'), mem('u2', 'node'), mem('u1', 'npm')], { maxNodes: 2 })
  assert.deepEqual(tieA.nodes.map((node) => node.id), ['tool:git', 'tool:node'])
  assert.deepEqual(tieB.nodes.map((node) => node.id), ['tool:git', 'tool:node'])

  const none = buildEntityGraph(records, { maxNodes: 0 })
  assert.deepEqual(none.nodes, [])
  assert.deepEqual(none.edges, [])
  assert.equal(none.stats.memories, 4, 'memories 统计参与建图的记忆数,不受节点截断影响')
})

test('过滤默认口径：软删 / 过期不进图,可显式包含;空输入与坏记录安全', () => {
  const now = 1_000_000
  const records: GraphMemory[] = [
    mem('k1', 'npm 记录', { tombstonedAt: 1 }),
    mem('k2', 'node 记录', { expiredAt: now - 1 }),
    mem('k3', 'git 记录'),
  ]
  const graph = buildEntityGraph(records, { now })
  assert.deepEqual(graph.nodes.map((node) => node.id), ['tool:git'])
  assert.equal(graph.stats.memories, 1)

  const included = buildEntityGraph(records, { now, includeTombstoned: true, includeExpired: true })
  assert.deepEqual(included.nodes.map((node) => node.id), ['tool:git', 'tool:node', 'tool:npm'])

  assert.deepEqual(buildEntityGraph([]), {
    nodes: [],
    edges: [],
    stats: { entities: 0, edges: 0, memories: 0 },
    memoryIndex: new Map(),
  })
  // 坏记录 / 重复 id / 非对象 / 空内容
  const dirty = buildEntityGraph([
    null as unknown as GraphMemory,
    { id: '' } as GraphMemory,
    { id: 'd1', content: '' },
    { id: 'd1', content: '重复 id 只算一次' },
    { id: 'd2', content: 'npm', tags: 'not-an-array' as unknown as string[] },
  ])
  assert.equal(dirty.stats.memories, 1)
  assert.deepEqual(dirty.nodes.map((node) => node.id), ['tool:npm'])
})

test('单条记忆实体上限会约束共现边数量（不会 O(n²) 爆炸）', () => {
  const many = 'npm pnpm yarn bun deno node python pip git llama.cpp dsh bge-m3 typescript javascript rust cargo golang java kotlin swift docker podman kubernetes sqlite postgresql mysql redis mongodb curl wget'
  const graph = buildEntityGraph([mem('big', many)])
  assert.ok(graph.nodes.length <= MAX_ENTITIES_PER_MEMORY)
  const maxPairs = (MAX_ENTITIES_PER_MEMORY * (MAX_ENTITIES_PER_MEMORY - 1)) / 2
  assert.ok(graph.edges.length <= maxPairs)

  const capped = buildEntityGraph([mem('big', many)], { maxEntitiesPerMemory: 3 })
  assert.equal(capped.nodes.length, 3)
  assert.equal(capped.edges.length, 3, '3 个实体两两共现 = 3 条边')
})

// ---------------------------------------------------------------- 查询 / 摘要

test('relatedEntities：按边权重↓/count↓/id↑ 排序,支持 limit,未知实体返回空', () => {
  const graph = buildEntityGraph([
    mem('r1', 'npm node git'),
    mem('r2', 'npm node'),
  ])
  const related = relatedEntities(graph, 'tool:npm')
  assert.deepEqual(related.map((item) => [item.id, item.weight, item.count]), [
    ['tool:node', 2, 2],
    ['tool:git', 1, 1],
  ])
  assert.deepEqual(relatedEntities(graph, 'tool:npm', 1).map((item) => item.id), ['tool:node'])
  assert.deepEqual(relatedEntities(graph, 'tool:npm', 0), [])
  assert.deepEqual(relatedEntities(graph, 'tool:不存在'), [])
  assert.deepEqual(relatedEntities(null as unknown as ReturnType<typeof buildEntityGraph>, 'tool:npm'), [])
})

test('graphStats：byType 键升序、topEntities 按 count↓/id↑,与 stats 一致', () => {
  const graph = buildEntityGraph([
    mem('s1', 'npm node'),
    mem('s2', 'npm node'),
    mem('s3', 'git'),
  ])
  const stats = graphStats(graph)
  assert.equal(stats.entities, 3)
  assert.equal(stats.edges, 1)
  assert.equal(stats.memories, 3)
  assert.deepEqual(Object.keys(stats.byType), ['tool'])
  assert.equal(stats.byType.tool, 3)
  assert.deepEqual(stats.topEntities, [
    { id: 'tool:node', type: 'tool', label: 'Node.js', count: 2 },
    { id: 'tool:npm', type: 'tool', label: 'npm', count: 2 },
    { id: 'tool:git', type: 'tool', label: 'git', count: 1 },
  ])
  assert.deepEqual(graphStats(graph, 1).topEntities.length, 1)
})

test('serializeGraph：memoryIndex 变普通对象,可 JSON 序列化（面板传输用）', () => {
  const graph = buildEntityGraph([mem('j1', 'npm node'), mem('j2', 'npm')])
  const serialized = serializeGraph(graph)
  assert.equal(Array.isArray(serialized.nodes), true)
  assert.equal(serialized.memoryIndex instanceof Map, false)
  assert.deepEqual(serialized.memoryIndex['tool:npm'], ['j1', 'j2'])
  assert.doesNotThrow(() => JSON.stringify(serialized))
  assert.deepEqual(JSON.parse(JSON.stringify(serialized)).memoryIndex['tool:node'], ['j1'])
})
