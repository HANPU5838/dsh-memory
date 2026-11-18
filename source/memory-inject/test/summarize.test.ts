/**
 * 0.81.0：抽取式摘要（TextRank）—— 纯函数、确定性、不编造。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { digestForRecall, splitSentences, summarizeText } from '../src/summarize.ts'

const FILLER = '背景信息：'.padEnd(10, '。') + '这是一段与查询无关的背景描述。'.repeat(8)
const KEY = '发布前必须先跑 pnpm run verify:all 校验，失败不要重启服务。'
const TEXT = `${FILLER}${KEY}${'补充说明：'.repeat(30)}`

test('splitSentences：中文标点 / 换行 / 英文句号都能切', () => {
  const sentences = splitSentences('第一句。第二句！第三句？\n第四句; fifth.')
  assert.ok(sentences.length >= 5, `实际 ${JSON.stringify(sentences)}`)
  assert.equal(sentences[0], '第一句。')
})

test('summarizeText：超过字数时选关键句，而不是只留开头', () => {
  const out = summarizeText(TEXT, { maxChars: 80, queryText: 'verify:all 校验' })
  assert.ok(out.length <= 80, `不超过字数上限（实际 ${out.length}）`)
  assert.ok(out.includes('verify'), `应保留查询相关的关键句（实际 ${out}）`)
  assert.ok(out.includes('发布前必须先跑'), '关键句应完整保留')
  assert.ok(out.length < TEXT.length, '摘要应短于原文')
  // 确定性：两次结果一致。
  assert.equal(summarizeText(TEXT, { maxChars: 80, queryText: 'verify:all 校验' }), out)
})

test('digestForRecall：短内容原样返回；长内容走摘要', () => {
  assert.equal(digestForRecall('短记忆正文', 120), '短记忆正文')
  const long = digestForRecall('短记忆。' + '无关内容。'.repeat(40) + '关键句：端口 8080。', 60, '端口')
  assert.ok(long.length <= 60)
  assert.ok(long.includes('端口'), `关键句应保留（实际 ${long}）`)
})

test('summarizeText：空文本 / 单句安全回退', () => {
  assert.equal(summarizeText(''), '')
  assert.equal(summarizeText('只有一句话。'), '只有一句话。')
})
