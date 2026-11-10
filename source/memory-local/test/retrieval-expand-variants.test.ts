/**
 * expand.ts 的多查询变体测试(0.36.0):original / keyword / neighbor。
 *
 * 覆盖点:
 *   - 空查询、无近邻、近邻无新词等退化路径;
 *   - original 原样保留、token 与 tokenize 一致;
 *   - keyword 只留强 token(CJK 二元 / 拉丁词),丢掉单字弱 token;
 *   - neighbor 扩展只补"查询没出现过"的强词,权重阶梯 original>keyword>扩展>纯近邻词;
 *   - 两种调用约定(`{ neighbors }` / 第二参数直接给数组 / `{ vectors }` 别名);
 *   - max* 配置、确定性、纯函数不改入参。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tokenize } from '../src/scoring.ts'
import {
  DEFAULT_KEYWORD_VARIANT_WEIGHT,
  DEFAULT_MAX_QUERY_VARIANTS,
  DEFAULT_NEIGHBOR_TERMS_WEIGHT,
  DEFAULT_NEIGHBOR_VARIANT_WEIGHT,
  expandQueries,
  type QueryVariant,
} from '../src/retrieval/expand.ts'

/** 取得指定 kind 的所有变体。 */
function variantsOfKind(variants: readonly QueryVariant[], kind: QueryVariant['kind']): QueryVariant[] {
  return variants.filter((variant) => variant.kind === kind)
}

const NEIGHBORS = [
  '部署端口是 8080，llama-server 监听',
  '端口冲突时改端口',
]

// ---------------------------------------------------------------------------
// 退化路径
// ---------------------------------------------------------------------------

test('expandQueries:空 / 纯空白 / 非字符串查询不产生变体', () => {
  for (const text of ['', '   ', '\n\t', null as unknown as string, undefined as unknown as string]) {
    assert.deepEqual(expandQueries(text), [])
  }
})

test('expandQueries:没有近邻时只给 original + keyword', () => {
  const variants = expandQueries('部署端口')
  assert.equal(variants.length, 2)
  assert.deepEqual(variants.map((variant) => variant.kind), ['original', 'keyword'])
})

test('expandQueries:近邻里没有查询外的新词时不生成 neighbor 变体', () => {
  const variants = expandQueries('部署端口', { neighbors: ['部署端口'] })
  assert.equal(variantsOfKind(variants, 'neighbor').length, 0)
  assert.equal(variants.length, 2)

  // 非法近邻条目被忽略
  const junk = expandQueries('部署端口', { neighbors: [null as never, 42 as never, '' as never] })
  assert.equal(junk.length, 2)
})

test('expandQueries:原查询本身就是纯强 token 时不重复生成关键词变体', () => {
  const variants = expandQueries('alpha beta')
  assert.equal(variants.length, 1)
  assert.equal(variants[0]!.kind, 'original')
})

test('expandQueries:只有单个字符的查询只保留 original', () => {
  const variants = expandQueries('a')
  assert.equal(variants.length, 1)
  assert.deepEqual(variants[0]!.tokens, tokenize('a'))
})

// ---------------------------------------------------------------------------
// original
// ---------------------------------------------------------------------------

test('expandQueries:original 原样保留文本与 token,权重恒为 1', () => {
  const text = ' 怎么让记忆别过期 '
  const original = expandQueries(text)[0]!
  assert.equal(original.kind, 'original')
  assert.equal(original.text, text)
  assert.equal(original.weight, 1)
  assert.deepEqual(original.tokens, tokenize(text))
  assert.ok(original.reason.length > 0)
})

// ---------------------------------------------------------------------------
// keyword
// ---------------------------------------------------------------------------

test('expandQueries:keyword 只保留强 token(CJK 二元 / 拉丁词),丢掉单字', () => {
  const variants = expandQueries('怎么让记忆别过期', { maxKeywords: 10 })
  const keyword = variantsOfKind(variants, 'keyword')[0]!
  assert.ok(keyword.tokens.length > 1)
  assert.ok(keyword.tokens.every((token) => token.length >= 2), `出现弱 token: ${keyword.tokens}`)
  assert.ok(keyword.tokens.includes('记忆'))
  assert.ok(keyword.tokens.includes('过期'))
  assert.equal(keyword.text, keyword.tokens.join(' '))
  assert.equal(keyword.weight, DEFAULT_KEYWORD_VARIANT_WEIGHT)
  // 单字(记 / 忆)不在关键词变体里
  assert.ok(!keyword.tokens.includes('记'))
})

test('expandQueries:maxKeywords 限制关键词数量,0 表示不生成', () => {
  const two = expandQueries('怎么让记忆别过期', { maxKeywords: 2 })
  assert.equal(variantsOfKind(two, 'keyword')[0]!.tokens.length, 2)
  assert.equal(expandQueries('部署端口', { maxKeywords: 0 }).length, 1)
})

// ---------------------------------------------------------------------------
// neighbor
// ---------------------------------------------------------------------------

test('expandQueries:近邻变体只补查询没出现过的强词,原查询保留', () => {
  const variants = expandQueries('部署端口', { neighbors: NEIGHBORS })
  assert.equal(DEFAULT_MAX_QUERY_VARIANTS, 4)
  assert.equal(variants.length, 4)

  const original = variants[0]!
  const expanded = variants[2]!
  const termsOnly = variants[3]!
  assert.equal(expanded.kind, 'neighbor')
  assert.equal(termsOnly.kind, 'neighbor')
  assert.ok(expanded.text.startsWith('部署端口 '))
  assert.ok(expanded.tokens.includes('8080'))
  assert.ok(termsOnly.tokens.includes('8080'))
  // 查询已有的词不再重复加进"纯近邻词"变体
  assert.ok(!termsOnly.tokens.includes('端口'))
  assert.ok(!termsOnly.tokens.includes('部'))
  // 扩展变体的 token = 原查询 token + 近邻新词
  assert.equal(expanded.tokens.length, original.tokens.length + termsOnly.tokens.length)
})

test('expandQueries:权重阶梯 original > keyword > 扩展 > 纯近邻词', () => {
  const [original, keyword, expanded, termsOnly] = expandQueries('部署端口', { neighbors: NEIGHBORS })
  assert.equal(original!.weight, 1)
  assert.equal(keyword!.weight, DEFAULT_KEYWORD_VARIANT_WEIGHT)
  assert.equal(expanded!.weight, DEFAULT_NEIGHBOR_VARIANT_WEIGHT)
  assert.equal(termsOnly!.weight, DEFAULT_NEIGHBOR_TERMS_WEIGHT)
  assert.ok(original!.weight > keyword!.weight)
  assert.ok(keyword!.weight > expanded!.weight)
  assert.ok(expanded!.weight > termsOnly!.weight)
})

test('expandQueries:靠前的近邻权重更高;maxNeighbors 限制使用条数', () => {
  const lists = [
    'alpha one',
    'alpha two',
  ]
  const all = expandQueries('alpha', { neighbors: lists })
  const terms = variantsOfKind(all, 'neighbor')[1]!
  assert.deepEqual(terms.tokens, ['one', 'two']) // 第一条近邻的词排前面

  const onlyFirst = expandQueries('alpha', { neighbors: lists, maxNeighbors: 1 })
  assert.deepEqual(variantsOfKind(onlyFirst, 'neighbor')[1]!.tokens, ['one'])

  const onlyOneTerm = expandQueries('alpha', { neighbors: lists, maxNeighborTerms: 1 })
  assert.deepEqual(variantsOfKind(onlyOneTerm, 'neighbor')[1]!.tokens, ['one'])
})

test('expandQueries:重复的近邻文本不会重复加词', () => {
  const variants = expandQueries('部署端口', { neighbors: ['部署端口 8080', '部署端口 8080'] })
  const terms = variantsOfKind(variants, 'neighbor')[1]!
  assert.deepEqual(terms.tokens, ['8080'])
})

test('expandQueries:对象型近邻取 text / content,兼容 MemoryRecord', () => {
  const fromContent = expandQueries('deploy port', { neighbors: [{ content: 'deploy port 8080' }] })
  const fromText = expandQueries('deploy port', { neighbors: [{ text: 'deploy port 8080' }] })
  assert.deepEqual(fromContent, fromText)
  assert.ok(variantsOfKind(fromContent, 'neighbor')[0]!.tokens.includes('8080'))
})

// ---------------------------------------------------------------------------
// 调用约定
// ---------------------------------------------------------------------------

test('expandQueries:{ vectors } 是 neighbors 的别名,结果一致', () => {
  const byNeighbors = expandQueries('部署端口', { neighbors: NEIGHBORS })
  const byVectors = expandQueries('部署端口', { vectors: NEIGHBORS })
  assert.deepEqual(byVectors, byNeighbors)
})

test('expandQueries:第二参数直接给近邻数组(位置参数写法)等价于 options.neighbors', () => {
  const positional = expandQueries('部署端口', NEIGHBORS)
  assert.deepEqual(positional, expandQueries('部署端口', { neighbors: NEIGHBORS }))
  // 第三个参数仍可覆盖配置
  assert.equal(expandQueries('部署端口', NEIGHBORS, { maxVariants: 2 }).length, 2)
})

test('expandQueries:maxVariants 统一截断,调小先保留 original', () => {
  assert.deepEqual(
    expandQueries('部署端口', { neighbors: NEIGHBORS, maxVariants: 2 }).map((variant) => variant.kind),
    ['original', 'keyword'],
  )
  assert.deepEqual(
    expandQueries('部署端口', { neighbors: NEIGHBORS, maxVariants: 3 }).map((variant) => variant.kind),
    ['original', 'keyword', 'neighbor'],
  )
  assert.equal(expandQueries('部署端口', { neighbors: NEIGHBORS, maxVariants: 1 }).length, 1)
  assert.deepEqual(expandQueries('部署端口', { neighbors: NEIGHBORS, maxVariants: 0 }), [])
})

// ---------------------------------------------------------------------------
// 确定性 / 纯函数
// ---------------------------------------------------------------------------

test('expandQueries:同一输入两次调用深相等,且不修改入参', () => {
  const neighbors = [...NEIGHBORS]
  const options = { neighbors, maxVariants: 4 }
  const snapshot = JSON.stringify(options)
  const first = expandQueries('部署端口', options)
  const second = expandQueries('部署端口', options)
  assert.deepEqual(first, second)
  assert.equal(JSON.stringify(options), snapshot)
  assert.deepEqual(neighbors, NEIGHBORS)
  for (const variant of first) {
    assert.ok(Number.isFinite(variant.weight))
    assert.ok(variant.reason.length > 0)
    assert.ok(Array.isArray(variant.tokens))
  }
})
