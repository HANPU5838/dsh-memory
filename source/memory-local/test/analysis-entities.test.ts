/**
 * 实体抽取（analysis/entities）：实体抽取各类型 / 归一化 / 去重 / 上限、
 * 非法输入安全降级。实体抽取供智能关系分析复用（关系 = 实体 × 实体的关联）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_MAX_CONTENT_CHARS,
  MAX_ENTITIES_PER_MEMORY,
  entityNodeId,
  extractEntities,
  type Entity,
  type EntityType,
} from '../src/analysis/entities.ts'

/** 某类型的归一化值（升序，便于断言）。 */
function normalized(entities: readonly Entity[], type: EntityType): string[] {
  return entities
    .filter((entity) => entity.type === type)
    .map((entity) => entity.normalized)
    .sort()
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

test('entityNodeId：节点 id = `${type}:${normalized}`,确定性且类型隔离', () => {
  assert.equal(entityNodeId('tool', 'node'), 'tool:node')
  assert.equal(entityNodeId('path', '/tmp'), 'path:/tmp')
  assert.notEqual(entityNodeId('tool', 'x'), entityNodeId('os', 'x'))
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
