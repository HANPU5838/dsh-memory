/**
 * bm25.ts 测试(0.36.0):正式 BM25 词法打分。
 *
 * 覆盖点:
 *   - 建索引口径(n / df / 加权长度 / avgdl / 重复 id / 脏输入);
 *   - 公式正确性(k1=0 退化为 IDF 和的金标准;默认参数下与手算公式一致);
 *   - 单调性:词频↑分↑(且饱和)、稀有词分高、更长文档分低(b>0 时);
 *   - b 的作用:0 关闭长度归一、1 最强归一、分数比随 b 单调;
 *   - 字段权重:tagsWeight / contentWeight 各自可关;
 *   - 中文:复用 tokenize 的一元 + 二元口径;
 *   - 边界:空语料 / 空查询 / 未登录词 / null;纯函数不改入参;排序确定。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tokenize } from '../src/scoring.ts'
import {
  DEFAULT_BM25_B,
  DEFAULT_BM25_K1,
  DEFAULT_CONTENT_WEIGHT,
  DEFAULT_TAGS_WEIGHT,
  bm25Idf,
  bm25Score,
  buildBm25Docs,
  rankByBm25,
  type Bm25DocInput,
} from '../src/retrieval/bm25.ts'

function close(actual: number, expected: number, eps = 1e-12): void {
  assert.ok(Math.abs(actual - expected) <= eps, `expected ${expected}, got ${actual}`)
}

/** 取文档索引,缺失直接失败(避免测试里到处 `!`)。 */
function docOf(index: ReturnType<typeof buildBm25Docs>, id: string) {
  const doc = index.docs.get(id)
  assert.ok(doc !== undefined, `索引里没有文档 ${id}`)
  return doc
}

// ---------------------------------------------------------------------------
// 默认参数 / 建索引
// ---------------------------------------------------------------------------

test('buildBm25Docs:默认参数 k1=1.2 / b=0.75 / 正文权重 1 / 标签权重 1.5', () => {
  const index = buildBm25Docs([{ id: 'a', content: 'alpha' }])
  assert.equal(index.k1, DEFAULT_BM25_K1)
  assert.equal(index.b, DEFAULT_BM25_B)
  assert.equal(index.contentWeight, DEFAULT_CONTENT_WEIGHT)
  assert.equal(index.tagsWeight, DEFAULT_TAGS_WEIGHT)
  assert.equal(DEFAULT_BM25_K1, 1.2)
  assert.equal(DEFAULT_BM25_B, 0.75)
  assert.ok(DEFAULT_TAGS_WEIGHT > DEFAULT_CONTENT_WEIGHT)
})

test('buildBm25Docs:非法参数回落默认;k1 负数按 0、b 夹到 0..1', () => {
  const fallback = buildBm25Docs([{ id: 'a', content: 'alpha' }], {
    k1: Number.NaN,
    b: -0.5,
    contentWeight: -3,
    tagsWeight: Number.POSITIVE_INFINITY,
  })
  assert.equal(fallback.k1, DEFAULT_BM25_K1)
  assert.equal(fallback.b, 0)
  // 负权重按 0(关闭该字段),不是回落默认值
  assert.equal(fallback.contentWeight, 0)
  assert.equal(fallback.tagsWeight, DEFAULT_TAGS_WEIGHT)

  const clamped = buildBm25Docs([{ id: 'a', content: 'alpha' }], { k1: -2, b: 9 })
  assert.equal(clamped.k1, 0)
  assert.equal(clamped.b, 1)
})

test('buildBm25Docs:统计 N / df / 加权长度 / avgdl', () => {
  const docs = [
    { id: 'a', content: 'alpha beta' },
    { id: 'b', content: 'alpha gamma beta beta' },
    { id: 'c', content: 'delta' },
  ]
  const index = buildBm25Docs(docs)
  assert.equal(index.n, 3)
  assert.equal(index.avgLength, 7 / 3)
  assert.equal(index.df.get('alpha'), 2)
  assert.equal(index.df.get('beta'), 2)
  assert.equal(index.df.get('gamma'), 1)
  assert.equal(index.df.get('delta'), 1)
  assert.equal(index.avgLength, ([...index.docs.values()].reduce((sum, d) => sum + d.length, 0)) / 3)

  const b = docOf(index, 'b')
  assert.equal(b.length, 4)
  assert.equal(b.termFreq.get('beta'), 2)
  assert.equal(b.termFreq.get('alpha'), 1)
  assert.equal(b.termFreq.get('delta'), undefined)
})

test('buildBm25Docs:字段权重计入长度与词频(tf\' 与 dl 加权)', () => {
  const index = buildBm25Docs([
    { id: 'tagged', content: ['ordinary', 'words'], tags: ['release'] },
  ])
  const doc = docOf(index, 'tagged')
  assert.equal(doc.length, 2 * DEFAULT_CONTENT_WEIGHT + 1 * DEFAULT_TAGS_WEIGHT)
  assert.equal(doc.termFreq.get('release'), DEFAULT_TAGS_WEIGHT)
  assert.equal(doc.termFreq.get('ordinary'), DEFAULT_CONTENT_WEIGHT)

  // tagsWeight=0 时标签既不进词频也不进长度
  const noTags = buildBm25Docs([
    { id: 'tagged', content: ['ordinary'], tags: ['release'] },
  ], { tagsWeight: 0 })
  assert.equal(noTags.docs.get('tagged')!.termFreq.get('release'), undefined)
  assert.equal(noTags.docs.get('tagged')!.length, 1)
})

test('buildBm25Docs:重复 id 后者覆盖、空 id 忽略、数组 token 直接使用', () => {
  const index = buildBm25Docs([
    { id: 'a', content: 'alpha' },
    { id: 'a', content: 'beta beta' },
    { id: '', content: 'gamma' },
  ])
  assert.equal(index.n, 1)
  assert.equal(index.docs.size, 1)
  assert.equal(index.df.get('alpha'), undefined)
  assert.equal(index.df.get('beta'), 1)
  assert.equal(index.df.get('gamma'), undefined)

  // content 给 token 数组 = 调用方已分词,不再二次 tokenize
  const tokens = buildBm25Docs([{ id: 'x', content: ['部署端口', '8080'] }])
  assert.equal(tokens.docs.get('x')!.length, 2)
  assert.equal(tokens.docs.get('x')!.termFreq.get('部署端口'), 1)
})

// ---------------------------------------------------------------------------
// 公式正确性
// ---------------------------------------------------------------------------

test('bm25Score:k1=0 时退化为命中词 IDF 之和(金标准)', () => {
  const docs = [
    { id: 'a', content: 'alpha beta' },
    { id: 'b', content: 'alpha gamma beta beta' },
    { id: 'c', content: 'delta' },
  ]
  const index = buildBm25Docs(docs, { k1: 0 })
  const docB = docOf(index, 'b')
  // N=3, df(alpha)=2 → idf = ln(1 + (3−2+0.5)/(2+0.5)) = ln(1.6)
  close(bm25Score(['alpha'], docB, index), Math.log(1.6))
  // 两个命中词 = 两个 IDF 之和
  close(bm25Score(['alpha', 'beta'], docB, index), 2 * Math.log(1.6))
  // 查询 token 重复不再放大
  close(bm25Score(['alpha', 'alpha'], docB, index), Math.log(1.6))
})

test('bm25Score:默认参数下与标准公式手算一致', () => {
  const docs = [
    { id: 'a', content: 'alpha beta' },
    { id: 'b', content: 'alpha gamma beta beta' },
    { id: 'c', content: 'delta' },
  ]
  const index = buildBm25Docs(docs)
  const docB = docOf(index, 'b')
  const idf = Math.log(1 + (3 - 2 + 0.5) / (2 + 0.5))
  const avg = 7 / 3
  const lengthNorm = 1 - 0.75 + 0.75 * (4 / avg)
  const expected = idf * (1 * (1.2 + 1)) / (1 + 1.2 * lengthNorm)
  close(bm25Score(['alpha'], docB, index), expected, 1e-12)
})

test('bm25Idf:df 越小分越高、df=N 仍非负、越界夹取、n<=0 为 0', () => {
  assert.ok(bm25Idf(1, 10) > bm25Idf(5, 10))
  assert.ok(bm25Idf(5, 10) > bm25Idf(10, 10))
  assert.ok(bm25Idf(10, 10) > 0)
  close(bm25Idf(20, 10), bm25Idf(10, 10)) // df > N 夹到 N
  close(bm25Idf(-5, 10), bm25Idf(0, 10)) // 负 df 夹到 0
  assert.equal(bm25Idf(3, 0), 0)
})

// ---------------------------------------------------------------------------
// 单调性 / 长度归一
// ---------------------------------------------------------------------------

test('bm25Score:词频单调上升且收益递减(b=0 排除长度干扰)', () => {
  const index = buildBm25Docs([
    { id: 't1', content: ['alpha', 'x'] },
    { id: 't2', content: ['alpha', 'alpha', 'x'] },
    { id: 't3', content: ['alpha', 'alpha', 'alpha', 'x'] },
  ], { b: 0 })
  const s1 = bm25Score(['alpha'], docOf(index, 't1'), index)
  const s2 = bm25Score(['alpha'], docOf(index, 't2'), index)
  const s3 = bm25Score(['alpha'], docOf(index, 't3'), index)
  assert.ok(s1 > 0 && s2 > s1 && s3 > s2, `词频单调性失败: ${s1} ${s2} ${s3}`)
  // 饱和:第 2 次的增量大于第 3 次的增量
  assert.ok(s2 - s1 > s3 - s2, `饱和性失败: ${s2 - s1} vs ${s3 - s2}`)
})

test('bm25Score:稀有词分高于常见词(同一文档内)', () => {
  const index = buildBm25Docs([
    { id: 'd1', content: ['alpha', 'gamma'] },
    { id: 'd2', content: ['alpha'] },
    { id: 'd3', content: ['alpha'] },
  ], { b: 0 })
  const doc = docOf(index, 'd1')
  // 同一文档、同一 tf、同一长度 → 差异只来自 IDF
  assert.ok(bm25Score(['gamma'], doc, index) > bm25Score(['alpha'], doc, index))
})

test('bm25Score:b=0 关闭长度归一,相同词频的短/长文档同分', () => {
  const index = buildBm25Docs([
    { id: 'short', content: ['alpha'] },
    { id: 'long', content: ['alpha', 'x1', 'x2', 'x3', 'x4', 'x5'] },
  ], { b: 0 })
  const short = bm25Score(['alpha'], docOf(index, 'short'), index)
  const long = bm25Score(['alpha'], docOf(index, 'long'), index)
  close(short, long, 1e-12)
  assert.ok(short > 0)
})

test('bm25Score:b 越大长文档惩罚越强,短/长比随 b 单调上升', () => {
  const docs = [
    { id: 'short', content: ['alpha'] },
    { id: 'long', content: ['alpha', 'x1', 'x2', 'x3', 'x4', 'x5'] },
  ]
  let previous = 0
  for (const b of [0, 0.25, 0.5, 0.75, 1]) {
    const index = buildBm25Docs(docs, { b })
    const short = bm25Score(['alpha'], docOf(index, 'short'), index)
    const long = bm25Score(['alpha'], docOf(index, 'long'), index)
    assert.ok(short >= long, `b=${b} 时短文档不该低于长文档`)
    const ratio = short / long
    if (b > 0) assert.ok(ratio > previous, `b=${b} 时长度惩罚没有变强`)
    previous = ratio
  }
  // b=0 时两者相等(ratio=1);b=1 时差距最大
  assert.ok(previous > 1)
})

// ---------------------------------------------------------------------------
// 字段权重
// ---------------------------------------------------------------------------

test('bm25Score:标签命中默认强于正文命中;权重可单独关闭', () => {
  const docs = [
    { id: 'tagged', content: 'ordinary words here', tags: ['release'] },
    { id: 'content', content: 'release notes here' },
  ]
  // 默认 tagsWeight=1.5 > contentWeight=1
  const index = buildBm25Docs(docs)
  assert.ok(bm25Score(['release'], docOf(index, 'tagged'), index) > 0)
  assert.ok(bm25Score(['release'], docOf(index, 'tagged'), index) > bm25Score(['release'], docOf(index, 'content'), index))

  // tagsWeight=0:标签完全不算分
  const noTags = buildBm25Docs(docs, { tagsWeight: 0 })
  assert.equal(bm25Score(['release'], docOf(noTags, 'tagged'), noTags), 0)
  assert.ok(bm25Score(['release'], docOf(noTags, 'content'), noTags) > 0)

  // contentWeight=0:正文完全不算分,只有标签算
  const tagsOnly = buildBm25Docs([
    { id: 'tagged', content: 'ordinary words here', tags: ['release'] },
    { id: 'content', content: 'release notes here' },
  ], { contentWeight: 0, tagsWeight: 1 })
  assert.equal(bm25Score(['release'], docOf(tagsOnly, 'content'), tagsOnly), 0)
  assert.ok(bm25Score(['release'], docOf(tagsOnly, 'tagged'), tagsOnly) > 0)
})

// ---------------------------------------------------------------------------
// 中文 / tokenize 复用
// ---------------------------------------------------------------------------

test('bm25Score:中文复用 tokenize 的一元 + 二元口径', () => {
  const index = buildBm25Docs([{ id: 'port', content: '部署端口是 8080' }])
  const doc = docOf(index, 'port')
  assert.ok(bm25Score(tokenize('部署端口'), doc, index) > 0)
  assert.ok(bm25Score(['端口'], doc, index) > 0) // CJK 二元命中
  assert.ok(bm25Score(['8080'], doc, index) > 0) // 数字 token
  assert.equal(bm25Score(['数据库'], doc, index), 0)
})

test('bm25Score:字符串输入与预先 tokenize 的数组输入完全等价', () => {
  const fromText = buildBm25Docs([{ id: 'x', content: '部署端口 8080 llama-server' }])
  const fromTokens = buildBm25Docs([{ id: 'x', content: tokenize('部署端口 8080 llama-server') }])
  close(
    bm25Score(['端口', 'llama-server'], docOf(fromText, 'x'), fromText),
    bm25Score(['端口', 'llama-server'], docOf(fromTokens, 'x'), fromTokens),
  )
})

// ---------------------------------------------------------------------------
// 边界 / 纯函数 / 排序
// ---------------------------------------------------------------------------

test('bm25Score:空语料 / 空查询 / 未登录词 / null 一律 0', () => {
  const empty = buildBm25Docs([])
  assert.equal(empty.n, 0)
  assert.equal(empty.avgLength, 0)
  assert.equal(bm25Score(['alpha'], empty.docs.get('a'), empty), 0)
  assert.equal(bm25Score(['alpha'], null, empty), 0)

  const index = buildBm25Docs([{ id: 'a', content: 'alpha beta' }])
  const doc = docOf(index, 'a')
  assert.equal(bm25Score([], doc, index), 0)
  assert.equal(bm25Score(['none'], doc, index), 0)
  assert.equal(bm25Score(['alpha'], doc, null), 0)
})

test('buildBm25Docs / bm25Score:纯函数,不改入参', () => {
  const docs: Bm25DocInput[] = [
    { id: 'a', content: ['alpha'], tags: ['t1'] },
    { id: 'b', content: 'beta gamma' },
  ]
  const snapshot = JSON.stringify(docs)
  const index = buildBm25Docs(docs)
  const first = bm25Score(['alpha'], docOf(index, 'a'), index)
  const second = bm25Score(['alpha'], docOf(index, 'a'), index)
  assert.equal(JSON.stringify(docs), snapshot)
  close(first, second) // 反复打分结果一致
})

test('rankByBm25:分数降序 + 同分 id 升序 + limit + 确定性', () => {
  const index = buildBm25Docs([
    { id: 'b', content: ['alpha'] },
    { id: 'a', content: ['alpha'] },
    { id: 'c', content: ['beta'] },
  ])
  const ranked = rankByBm25(['alpha'], index)
  // a / b 同分(df=2、tf=1、长度相同)→ 按 id 升序;c 未命中不出现
  assert.deepEqual(ranked.map((hit) => hit.id), ['a', 'b'])
  assert.ok(ranked[0]!.score > 0)
  assert.deepEqual(ranked, rankByBm25(['alpha'], index)) // 确定性

  assert.deepEqual(rankByBm25(['alpha'], index, 1).map((hit) => hit.id), ['a'])
  assert.deepEqual(rankByBm25(['alpha'], index, 0), [])
  assert.deepEqual(rankByBm25(['alpha'], emptyIndex()), [])
})

function emptyIndex() {
  return buildBm25Docs([])
}
