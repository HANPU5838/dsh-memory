#!/usr/bin/env node
/**
 * 召回摘要评测（0.81.0）—— 离线、确定性、零依赖。
 *
 * 对比两种「正文超预算」策略在 topK 注入里的信息保留率：
 *   - prefix：旧行为，直接截正文前 N 字；
 *   - digest：TextRank 摘要（summarize.ts），按查询相关性选句。
 *
 * 语料：每条记忆 = 3 句无关背景（在前）+ 1 句关键结论（在后，含查询关键词）。
 * 指标：关键句保留率（注入文本里是否出现关键结论）、平均输出字数。
 *
 * 用法：npm run eval:summarize
 */
import { digestForRecall } from '../../source/memory-inject/src/summarize.ts'

const DOCS = 20
const CHARS = 80
const QUERIES = DOCS

function buildCorpus() {
  const docs = []
  for (let i = 0; i < DOCS; i++) {
    const keyword = `kw${i}方案`
    const background = [
      '这是一段与问题无关的背景说明，用于占位和填充，确保关键信息不会出现在开头。',
      '历史记录显示系统曾经做过一些调整，但没有形成稳定判断，只是讨论。',
      '相关同事讨论过一些备选方向，但未定论，需要更多实验数据。',
      '补充说明：更多背景信息，仍然与查询无关，只是用来占位。',
    ].join('')
    const keySentence = `关键结论：${keyword} 必须先在预发环境验证，通过后再上线。`
    docs.push({ id: `doc${i}`, content: `${background}${keySentence}`, keyword, keySentence })
  }
  return docs
}

const docs = buildCorpus()
let prefixHits = 0
let digestHits = 0
let prefixChars = 0
let digestChars = 0

for (let i = 0; i < QUERIES; i++) {
  const doc = docs[i]
  const query = doc.keyword
  const prefix = doc.content.replace(/\s+/g, ' ').slice(0, CHARS)
  const digest = digestForRecall(doc.content, CHARS, query)
  prefixChars += prefix.length
  digestChars += digest.length
  if (prefix.includes('关键结论')) prefixHits += 1
  if (digest.includes('关键结论')) digestHits += 1
}

const pct = (value) => `${(value * 100).toFixed(1)}%`
console.log(`## 召回摘要评测（${DOCS} 条记忆，每条预算 ${CHARS} 字，关键结论都在正文后半段）\n`)
console.log('| 策略 | 关键结论保留率 | 平均输出字数 |')
console.log('| --- | --- | --- |')
console.log(`| prefix（截前缀） | ${pct(prefixHits / QUERIES)} | ${(prefixChars / QUERIES).toFixed(1)} |`)
console.log(`| digest（TextRank） | ${pct(digestHits / QUERIES)} | ${(digestChars / QUERIES).toFixed(1)} |`)
console.log(`
> 说明：关键句都在背景之后，前缀截断天然拿不到；TextRank 按句子重要度 + 查询相关性选句，
> 因此能在同一字数预算内保留结论。分数只对本合成集有效；退出码恒 0。
`)
process.exit(0)
