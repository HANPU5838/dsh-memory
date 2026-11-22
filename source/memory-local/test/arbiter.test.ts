import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decideWrite,
  diceSimilarity,
  noveltyRatio,
  extractFactTokens,
  detectFactConflict,
  hasNegationFlip,
  negationProfile,
  DEFAULT_NOOP_THRESHOLD,
  DEFAULT_UPDATE_THRESHOLD,
} from '../src/cognitive/arbiter.ts'

const neighbor = (id: string, content: string) => ({ id, content })

test('空作用域直接 ADD', () => {
  const r = decideWrite({ content: '用户偏好中文', neighbors: [] })
  assert.equal(r.action, 'ADD')
  assert.equal(r.reason, 'below-threshold')
})

test('完全相同的正文判 NOOP（identical-content）', () => {
  const r = decideWrite({ content: '用户偏好中文', neighbors: [neighbor('a1', '用户偏好中文')] })
  assert.equal(r.action, 'NOOP')
  assert.equal(r.reason, 'identical-content')
  assert.equal(r.targetId, 'a1')
})

test('同义改写判 NOOP（duplicate）', () => {
  const r = decideWrite({ content: '用户偏好用中文回复', neighbors: [neighbor('a2', '用户偏好使用中文回复')] })
  assert.equal(r.action, 'NOOP')
  assert.equal(r.reason, 'duplicate')
})

test('同主题但新增了细节 → ADD（new-detail）', () => {
  const r = decideWrite({
    content: '用户偏好用中文回复，并且喜欢简洁的段落',
    neighbors: [neighbor('a3', '用户偏好用中文回复')],
    updateThreshold: 0.5,
    noopThreshold: 0.95,
    noveltyFloor: 0.1,
  })
  assert.equal(r.action, 'ADD')
  assert.equal(r.reason, 'new-detail')
})

test('数字变化判 UPDATE（fact-conflict）', () => {
  const r = decideWrite({
    content: '服务器磁盘 40G，已用 15G',
    neighbors: [neighbor('a4', '服务器磁盘 40G，已用 12G')],
    updateThreshold: 0.5,
  })
  assert.equal(r.action, 'UPDATE')
  assert.equal(r.reason, 'fact-conflict')
  assert.equal(r.evidence.numbers, true)
})

test('路径变化判 UPDATE（含 Windows 反斜杠路径）', () => {
  const r = decideWrite({
    content: '记忆库位于 /data/local/memory 下',
    neighbors: [neighbor('a5', '记忆库位于 /data/termux/memory 下')],
    updateThreshold: 0.5,
  })
  assert.equal(r.action, 'UPDATE')
  assert.equal(r.evidence.paths, true)

  const w = decideWrite({
    content: '项目在 D:\\repo\\x 下',
    neighbors: [neighbor('a5b', '项目在 D:\\repo\\y 下')],
    updateThreshold: 0.5,
  })
  assert.equal(w.action, 'UPDATE')
  assert.equal(w.evidence.paths, true)
})

test('否定极性翻转判 UPDATE，同向否定不误判', () => {
  const r = decideWrite({
    content: '不要在生产环境使用 root 运行',
    neighbors: [neighbor('a6', '要在生产环境使用 root 运行')],
    updateThreshold: 0.5,
  })
  assert.equal(r.action, 'UPDATE')
  assert.equal(r.reason, 'negation-flip')

  const same = decideWrite({
    content: '不允许在生产环境使用 root 运行',
    neighbors: [neighbor('a6b', '禁止在生产环境使用 root 运行')],
    updateThreshold: 0.5,
  })
  assert.notEqual(same.reason, 'negation-flip')
})

test('有向量时优先余弦：词面不同但向量相同 → NOOP', () => {
  const vectors = new Map<string, ArrayLike<number>>([['a7', [1, 0, 0]]])
  const r = decideWrite({
    content: '完全不一样的措辞',
    neighbors: [neighbor('a7', '另一种表达方式')],
    vector: [1, 0, 0],
    neighborVectors: vectors,
  })
  assert.equal(r.action, 'NOOP')
  assert.equal(r.reason, 'duplicate')
})

test('向量正交且正文不同 → ADD', () => {
  const vectors = new Map<string, ArrayLike<number>>([['a8', [0, 1, 0]]])
  const r = decideWrite({
    content: '用户偏好中文',
    neighbors: [neighbor('a8', '服务器磁盘已满')],
    vector: [1, 0, 0],
    neighborVectors: vectors,
  })
  assert.equal(r.action, 'ADD')
})

test('缺少近邻向量时退回词法', () => {
  const r = decideWrite({
    content: '用户偏好中文',
    neighbors: [neighbor('a9', '用户偏好中文')],
    vector: [1, 0, 0],
    neighborVectors: new Map(),
  })
  assert.equal(r.action, 'NOOP')
  assert.equal(r.reason, 'identical-content')
})

test('显式 supersedes 优先于 NOOP', () => {
  const r = decideWrite({
    content: '用户偏好中文',
    neighbors: [neighbor('a10', '用户偏好中文')],
    supersedes: 'a10',
  })
  assert.equal(r.action, 'UPDATE')
  assert.equal(r.reason, 'explicit-supersedes')
  assert.equal(r.targetId, 'a10')
})

test('sameKindOnly：跨 kind 不参与近似判定', () => {
  const r = decideWrite({
    content: '用户偏好中文',
    kind: 'preference',
    neighbors: [{ id: 'a11', content: '用户偏好中文', kind: 'fact' }],
    sameKindOnly: true,
  })
  assert.equal(r.action, 'ADD')
})

test('确定性：候选顺序打乱结果一致', () => {
  const ns = [neighbor('b1', '用户偏好使用中文回复'), neighbor('b2', '用户偏好用中文回复')]
  const r1 = decideWrite({ content: '用户偏好用中文回复', neighbors: ns })
  const r2 = decideWrite({ content: '用户偏好用中文回复', neighbors: [...ns].reverse() })
  assert.equal(r1.action, r2.action)
  assert.equal(r1.targetId, r2.targetId)
})

test('diceSimilarity / noveltyRatio 基础性质', () => {
  assert.equal(diceSimilarity('abc', 'abc'), 1)
  assert.equal(diceSimilarity('', 'abc'), 0)
  assert.ok(noveltyRatio('alpha beta gamma', 'alpha beta') > 0.3)
  assert.equal(noveltyRatio('alpha beta', 'alpha beta'), 0)
})

test('事实 token 抽取与冲突检测', () => {
  const t = extractFactTokens('服务器 62.234.3.144 上 /srv//app 已用 15G')
  assert.ok(t.numbers.has('62.234.3.144'))
  assert.ok(t.numbers.has('15'))
  assert.ok(t.paths.has('/srv/app'))
  assert.equal(detectFactConflict('版本 1.1.0', '版本 1.1.0').conflict, false)
  assert.equal(detectFactConflict('版本 1.1.0', '版本 1.2.0').conflict, true)
  assert.equal(hasNegationFlip('允许推送', '不允许推送'), true)
  assert.equal(negationProfile('不要动它').negated, true)
})

test('默认阈值常量符合设计', () => {
  assert.equal(DEFAULT_NOOP_THRESHOLD, 0.92)
  assert.equal(DEFAULT_UPDATE_THRESHOLD, 0.75)
})
