/**
 * expand.ts 测试(0.33.0):Rocchio 伪相关反馈 + 查询画像 + 动态混合权重。
 *
 * 覆盖点:公式单调性(查询越像代码 → 词法权重越高;越自然语言 → 向量越高)、
 * 边界(空查询、零向量、维度不一致、权重非法)、确定性(纯函数、不改入参)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cosine } from '../src/scoring.ts'
import {
  DEFAULT_ALPHA,
  DEFAULT_BETA,
  LEXICAL_NATURAL_PENALTY,
  MAX_LEXICAL_WEIGHT,
  MIN_LEXICAL_WEIGHT,
  blendHybrid,
  expandQuery,
  hybridWeights,
  queryProfile,
} from '../src/retrieval/expand.ts'

function close(actual: number, expected: number, eps = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= eps, `expected ${expected}, got ${actual}`)
}

function closeVec(actual: ArrayLike<number>, expected: ArrayLike<number>, eps = 1e-6): void {
  assert.equal(actual.length, expected.length, '维度不同')
  for (let i = 0; i < expected.length; i++) close(actual[i]!, expected[i]!, eps)
}

// ---------------------------------------------------------------------------
// 查询画像
// ---------------------------------------------------------------------------

test('queryProfile:纯 CJK 查询的 CJK 比例/标识符/数字/路径特征', () => {
  const p = queryProfile('我上次说的那个部署端口是什么来着')
  assert.equal(p.chars, 16)
  assert.equal(p.significant, p.chars)
  close(p.cjkRatio, 1, 1e-12)
  close(p.latinRatio, 0, 1e-12)
  close(p.identifierRatio, 0, 1e-12)
  close(p.digitRatio, 0, 1e-12)
  assert.equal(p.hasPath, false)
  close(p.codeSignal, 0, 1e-12)
  close(p.naturalSignal, 1, 1e-12)
})

test('queryProfile:代码/路径查询识别标识符、数字、路径', () => {
  const p = queryProfile('src/retrieval/adapt.ts')
  assert.equal(p.significant, 22)
  close(p.identifierRatio, 1, 1e-12)
  assert.equal(p.hasPath, true)
  close(p.pathRatio, 1, 1e-12)
  close(p.codeSignal, 0.55 + 0.2, 1e-12) // identifier 满 + path 满
  close(p.cjkRatio, 0, 1e-12)

  // 无目录但有常见扩展名也算路径
  assert.equal(queryProfile('adapt.ts').hasPath, true)
  // 纯版本号不是路径(扩展名必须是字母)
  const version = queryProfile('v0.33.0')
  assert.equal(version.hasPath, false)
  close(version.identifierRatio, 1, 1e-12)
  // 数字占比:纯数字串进 digitRatio,不冒充标识符
  const digits = queryProfile('端口 8080')
  close(digits.digitRatio, 4 / 6, 1e-12)
  close(digits.identifierRatio, 0, 1e-12)
  close(digits.codeSignal, 0.25 * 1, 1e-12) // min(1, digitRatio·4)=1
})

test('queryProfile:空查询/空白查询无 NaN,比例全 0', () => {
  for (const text of ['', '   ', '\n\t']) {
    const p = queryProfile(text)
    assert.equal(p.significant, 0)
    for (const key of ['cjkRatio', 'latinRatio', 'digitRatio', 'identifierRatio', 'pathRatio', 'codeSignal'] as const) {
      assert.ok(Number.isFinite(p[key]), `${key} 必须是有限数`)
      assert.equal(p[key], 0)
    }
    assert.equal(p.hasPath, false)
  }
  // 非字符串输入按空串处理
  assert.equal(queryProfile(undefined as unknown as string).significant, 0)
})

test('queryProfile:codeSignal / naturalSignal 在 0..1 且方向相反', () => {
  const queries = [
    'getById',
    'src/a/b.ts',
    'v0.33.0',
    '部署 8080 端口',
    '为什么搜索没有结果',
    '',
  ]
  for (const query of queries) {
    const p = queryProfile(query)
    assert.ok(p.codeSignal >= 0 && p.codeSignal <= 1, `codeSignal 越界:${p.codeSignal}`)
    assert.ok(p.naturalSignal >= 0 && p.naturalSignal <= 1, `naturalSignal 越界:${p.naturalSignal}`)
    assert.ok(p.cjkRatio >= 0 && p.cjkRatio <= 1)
    assert.ok(p.identifierRatio >= 0 && p.identifierRatio <= 1)
  }
  assert.ok(queryProfile('getById').codeSignal > queryProfile('为什么搜索没有结果').codeSignal)
  assert.ok(queryProfile('为什么搜索没有结果').naturalSignal > queryProfile('getById').naturalSignal)
})

// ---------------------------------------------------------------------------
// 动态混合权重
// ---------------------------------------------------------------------------

test('hybridWeights:权重和为 1,且都落在 [0.2,0.9]', () => {
  for (const query of ['getById', 'src/retrieval/adapt.ts', '为什么搜索没有结果', '部署 8080', '']) {
    const w = hybridWeights(queryProfile(query))
    close(w.lexical + w.vector, 1, 1e-12)
    assert.ok(w.lexical >= MIN_LEXICAL_WEIGHT - 1e-12 && w.lexical <= MAX_LEXICAL_WEIGHT + 1e-12)
    assert.ok(w.vector > 0 && w.vector < 1)
  }
})

test('hybridWeights:标识符/数字重的查询偏词法,自然语言偏向量', () => {
  const code = hybridWeights(queryProfile('src/retrieval/adapt.ts adaptiveThreshold'))
  const version = hybridWeights(queryProfile('v0.33.0 的 getById 实现'))
  const digits = hybridWeights(queryProfile('端口 8080'))
  const natural = hybridWeights(queryProfile('我上次说的那个部署向量服务的端口是什么来着'))

  assert.ok(code.lexical > 0.75, `代码查询应偏词法:${code.lexical}`)
  assert.ok(version.lexical > 0.6)
  assert.ok(digits.lexical > 0.55)
  assert.ok(natural.lexical < 0.4, `自然语言应偏向量:${natural.lexical}`)
  assert.ok(code.lexical > digits.lexical && digits.lexical > natural.lexical)
  close(natural.lexical, 0.5 - LEXICAL_NATURAL_PENALTY * 1, 1e-12)
})

test('hybridWeights:极端画像被上下限夹住,空查询回到 50/50', () => {
  const empty = hybridWeights(queryProfile(''))
  close(empty.lexical, 0.5, 1e-12)
  close(empty.vector, 0.5, 1e-12)

  // 代码信号顶格:0.5 + 0.45 = 0.95 → 夹到 0.9
  const maxed = hybridWeights({ ...queryProfile(''), codeSignal: 1, cjkRatio: 0 })
  close(maxed.lexical, MAX_LEXICAL_WEIGHT, 1e-12)
  // 自然语言顶格且代码信号为 0:0.5 − 0.15 = 0.35,不会被夹
  const natural = hybridWeights({ ...queryProfile(''), codeSignal: 0, cjkRatio: 1 })
  close(natural.lexical, 0.5 - LEXICAL_NATURAL_PENALTY, 1e-12)
  // 人为把 codeSignal/cjkRatio 变成越界值也不产生非法权重
  const weird = hybridWeights({ ...queryProfile(''), codeSignal: 2, cjkRatio: -1 })
  assert.ok(weird.lexical >= MIN_LEXICAL_WEIGHT && weird.lexical <= MAX_LEXICAL_WEIGHT)
  close(weird.lexical + weird.vector, 1, 1e-12)
})

// ---------------------------------------------------------------------------
// blendHybrid
// ---------------------------------------------------------------------------

test('blendHybrid:归一化加权平均,与权重是否和为 1 无关', () => {
  close(blendHybrid(0.8, 0.2, { lexical: 0.5, vector: 0.5 }), 0.5, 1e-12)
  close(blendHybrid(0.8, 0.2, { lexical: 0.75, vector: 0.25 }), 0.65, 1e-12)
  close(blendHybrid(0.8, 0.2, { lexical: 3, vector: 1 }), 0.65, 1e-12)
  close(blendHybrid(0.8, 0.2, { lexical: 1, vector: 0 }), 0.8, 1e-12)
  close(blendHybrid(0.8, 0.2, { lexical: 0, vector: 1 }), 0.2, 1e-12)
})

test('blendHybrid:非法输入防御(负权重 / NaN / 全零权重)', () => {
  close(blendHybrid(0.8, 0.2, { lexical: -1, vector: 1 }), 0.2, 1e-12)
  close(blendHybrid(0.8, 0.2, { lexical: 0, vector: 0 }), 0.5, 1e-12, )
  close(blendHybrid(Number.NaN, 0.4, { lexical: 0.5, vector: 0.5 }), 0.2, 1e-12)
  close(blendHybrid(0.8, 0.2, { lexical: Number.NaN, vector: Number.NaN }), 0.5, 1e-12)
  assert.ok(Number.isFinite(blendHybrid(0.8, 0.2, { lexical: 0.5, vector: 0.5 })))
})

// ---------------------------------------------------------------------------
// Rocchio 查询扩展
// ---------------------------------------------------------------------------

test('expandQuery:没有查询向量 → null', () => {
  assert.equal(expandQuery(null, [new Float32Array([1, 0])]), null)
  assert.equal(expandQuery(undefined, []), null)
  assert.equal(expandQuery(new Float32Array(0), []), null)
  assert.equal(expandQuery(new Float32Array([0, 0]), [new Float32Array([1, 1])]), null, '零向量 = 不可用')
})

test('expandQuery:没有伪相关文档 → 归一化后的原查询', () => {
  const q = new Float32Array([3, 4])
  const expanded = expandQuery(q, [])
  assert.ok(expanded)
  closeVec(expanded!, [0.6, 0.8])
  // 维度不一致 / 全零的文档不算"可用文档"
  closeVec(expandQuery(q, [new Float32Array([1, 2, 3]), new Float32Array([0, 0])])!, [0.6, 0.8])
})

test('expandQuery:默认 α=1、β=0.5,结果 = normalize(q + 0.5·mean(docs)) 且为单位向量', () => {
  const q = new Float32Array([1, 0])
  const docs = [new Float32Array([0, 1])]
  const expected = new Float32Array([1, 0.5])
  const norm = Math.sqrt(1 + 0.25)
  expected[0] = 1 / norm
  expected[1] = 0.5 / norm
  const expanded = expandQuery(q, docs)!
  closeVec(expanded, expected)

  // 单位向量
  let sum = 0
  for (const value of expanded) sum += value * value
  close(Math.sqrt(sum), 1, 1e-6)
  // 方向落在 q 与文档质心之间
  const centroid = docs[0]!
  assert.ok(cosine(expanded, q) > 0 && cosine(expanded, q) < 1)
  assert.ok(cosine(expanded, centroid) > 0 && cosine(expanded, centroid) < 1)
})

test('expandQuery:α/β 的行为符合 Rocchio(α=1,β=0 → 原查询;α=0,β=1 → 文档质心)', () => {
  const q = new Float32Array([1, 0])
  const docs = [new Float32Array([0, 2]), new Float32Array([0, 4])]
  closeVec(expandQuery(q, docs, { beta: 0 })!, [1, 0])
  closeVec(expandQuery(q, docs, { alpha: 0, beta: 1 })!, [0, 1])
  // 显式 α=0 时结果完全由质心决定
  closeVec(expandQuery(q, docs, { alpha: 0, beta: 0.5 })!, [0, 1])

  // 缺省参数与显式默认值一致
  const implicit = expandQuery(q, docs)!
  const explicit = expandQuery(q, docs, { alpha: DEFAULT_ALPHA, beta: DEFAULT_BETA })!
  closeVec(implicit, explicit, 1e-12)
})

test('expandQuery:多篇文档取质心(平均)而不是求和', () => {
  const q = new Float32Array([0, 1])
  const docs = [new Float32Array([1, 1]), new Float32Array([1, -1])]
  const expanded = expandQuery(q, docs, { alpha: 1, beta: 1 })!
  const half = Math.SQRT1_2
  closeVec(expanded, [half, half], 1e-6)
})

test('expandQuery:维度不一致的文档被忽略,不会静默错位', () => {
  const q = new Float32Array([1, 0])
  const good = new Float32Array([0, 1])
  const bad = new Float32Array([9, 9, 9])
  const withBad = expandQuery(q, [bad, good])!
  const withGood = expandQuery(q, [good])!
  closeVec(withBad, withGood, 1e-12)
})

test('expandQuery:α+β 抵消成零向量时回退到原查询,不返回 NaN', () => {
  const q = new Float32Array([1, 0])
  const docs = [new Float32Array([-1, 0])]
  const result = expandQuery(q, docs, { alpha: 1, beta: 1 })!
  closeVec(result, [1, 0])
  for (const value of result) assert.ok(Number.isFinite(value))
})

test('expandQuery:不改入参、确定性(同输入同输出)', () => {
  const q = new Float32Array([0.2, 0.3, 0.5])
  const docs = [new Float32Array([0.1, 0.9, 0]), new Float32Array([0, 0.4, 0.6])]
  const qSnapshot = Array.from(q)
  const docsSnapshot = docs.map((doc) => Array.from(doc))

  const a = expandQuery(q, docs)!
  const b = expandQuery(q, docs)!
  closeVec(a, b, 1e-12)
  assert.deepEqual(Array.from(q), qSnapshot, 'qvec 不能被修改')
  assert.deepEqual(docs.map((doc) => Array.from(doc)), docsSnapshot, '文档向量不能被修改')

  // NaN 元素按 0 处理,不污染结果
  const dirty = new Float32Array([1, Number.NaN, 0])
  const expanded = expandQuery(dirty, [new Float32Array([0, 1, 0])])!
  for (const value of expanded) assert.ok(Number.isFinite(value))
})
