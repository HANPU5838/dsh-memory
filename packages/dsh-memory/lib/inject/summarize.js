/**
 * 抽取式摘要（TextRank）—— 0.81.0。
 *
 * 问题：逐轮召回把每条记忆按"开头 N 字"截断注入。很多记忆的开头是背景/寒暄，
 * 真正有用的结论在中间；平均主义截断会把上下文预算浪费在低信息量句子上。
 *
 * 做法（纯本地、确定性、零依赖）：
 *   1. 句子切分（中文标点 + 换行 + 英文句号）；
 *   2. 句子相似度 = token 集合 Jaccard（CJK 二元 + 拉丁词，与 scoring.tokenize 无关，
 *      只用于句间关系，避免把注入半边绑死在检索分词上）；
 *   3. TextRank 幂迭代（阻尼 0.85，30 轮）；
 *   4. 若给了查询：按查询 token 覆盖率给句子加权（查询相关的句子优先）；
 *   5. 按分数贪心选句直到字数上限，最后按原文顺序输出。
 *
 * 输出不新增正文、不编造内容：所有句子都来自原文。
 */

                                   
                         
                   
                     
                       
                              
                    
 

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/
const SENTENCE_SPLIT_RE = /(?<=[。！？；!?;])|[\n\r]+/g

/** 句子切分：保留标点、去空白、丢掉空句；确定性。 */
export function splitSentences(text        )           {
  const source = String(text === null || text === undefined ? '' : text).replace(/\s+/g, ' ')
  if (source === '') return []
  const parts = source.split(SENTENCE_SPLIT_RE)
  const out           = []
  for (const part of parts) {
    const sentence = part.trim()
    if (sentence.length < 2) continue
    out.push(sentence)
    if (out.length >= 120) break
  }
  return out
}

/** 摘要用的轻量 token：CJK 二元 + 拉丁/数字词（小写）。 */
export function summaryTokens(text        )           {
  const source = String(text === null || text === undefined ? '' : text).toLowerCase()
  const tokens = new Set        ()
  for (const match of source.matchAll(/[a-z0-9][a-z0-9_.-]*/g)) tokens.add(match[0] )
  let cjkRun = ''
  const flush = () => {
    if (cjkRun.length === 1) tokens.add(cjkRun)
    else for (let i = 0; i + 1 < cjkRun.length; i++) tokens.add(cjkRun.slice(i, i + 2))
    cjkRun = ''
  }
  for (const ch of source) {
    if (CJK_RE.test(ch)) cjkRun += ch
    else flush()
  }
  flush()
  return [...tokens]
}

/** 两个 token 集合的 Jaccard 相似度（空集为 0）。 */
function jaccard(a                     , b                     )         {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const token of a) if (b.has(token)) inter += 1
  return inter / (a.size + b.size - inter)
}

                                
               
              
                     
               
 

/** TextRank + 查询加权，返回带分数的句子（按原序）。 */
export function rankSentences(sentences                   , queryText = '')                  {
  const rows                  = sentences.map((text, index) => ({
    index,
    text,
    tokens: new Set(summaryTokens(text)),
    score: 1,
  }))
  if (rows.length === 0) return rows
  // 邻接权重（对称）。
  const weights             = rows.map(() => rows.map(() => 0))
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const sim = jaccard(rows[i] .tokens, rows[j] .tokens)
      weights[i] [j] = sim
      weights[j] [i] = sim
    }
  }
  const damping = 0.85
  const queryTokens = new Set(summaryTokens(queryText))
  let scores = rows.map(() => 1)
  for (let iteration = 0; iteration < 30; iteration++) {
    const next = rows.map((row, i) => {
      let incoming = 0
      for (let j = 0; j < rows.length; j++) {
        if (j === i) continue
        const wji = weights[j] [i] 
        if (wji <= 0) continue
        const outSum = weights[j] .reduce((sum, value) => sum + value, 0)
        if (outSum <= 0) continue
        incoming += (wji / outSum) * scores[j] 
      }
      let score = (1 - damping) + damping * incoming
      if (queryTokens.size > 0) {
        let overlap = 0
        for (const token of row.tokens) if (queryTokens.has(token)) overlap += 1
        const coverage = overlap / queryTokens.size
        // 查询相关句必须显著压过 TextRank 的"套话簇"中心性（背景句彼此相似会虚高）。
        score *= 1 + 6 * Math.min(1, coverage)
      }
      return score
    })
    scores = next
  }
  for (let i = 0; i < rows.length; i++) rows[i] .score = scores[i] 
  return rows
}

/**
 * 抽取式摘要：按分数选句直到 maxChars，最后按原文顺序拼接。
 *
 * @returns 摘要文本；句子太少或超限时回退为原文开头 maxChars 字。
 */
export function summarizeText(text        , options                   = {})         {
  const maxChars = Math.max(20, Math.floor(options.maxChars ?? 240))
  const maxSentences = Math.max(1, Math.min(20, Math.floor(options.maxSentences ?? 8)))
  const source = String(text === null || text === undefined ? '' : text).replace(/\s+/g, ' ').trim()
  if (source === '') return ''
  if (source.length <= maxChars) return source
  const sentences = splitSentences(source)
  if (sentences.length <= 1) return source.slice(0, maxChars)
  // 近重复句去重：重复的模板/套话在 TextRank 里会互相抬高分数，把真正关键的一句挤掉。
  // 保留首次出现的那句；判定用 token 集合 Jaccard ≥ 0.85。
  const unique           = []
  const seen                     = []
  for (const sentence of sentences) {
    const tokens = new Set(summaryTokens(sentence))
    if (seen.some((existing) => jaccard(existing, tokens) >= 0.85)) continue
    unique.push(sentence)
    seen.push(tokens)
  }
  if (unique.length <= 1) return source.slice(0, maxChars)
  const ranked = rankSentences(unique, options.queryText ?? '')
    .sort((a, b) => b.score - a.score || a.index - b.index)
  const picked                  = []
  let used = 0
  for (const row of ranked) {
    if (picked.length >= maxSentences) break
    if (used + row.text.length > maxChars && picked.length > 0) continue
    picked.push(row)
    used += row.text.length
  }
  if (picked.length === 0) return source.slice(0, maxChars)
  picked.sort((a, b) => a.index - b.index)
  const out = picked.map((row) => row.text).join(' ')
  return out.length > maxChars ? out.slice(0, maxChars) : out
}

/**
 * 召回卡片正文：内容短就原样；长内容用 TextRank 摘要（不超过 chars 字）。
 * 与"直接 cut 前缀"相比保留的是信息量最高的句子，不添加任何原文没有的内容。
 */
export function digestForRecall(content        , chars        , queryText = '')         {
  const normalized = String(content === null || content === undefined ? '' : content).replace(/\s+/g, ' ').trim()
  const limit = Math.max(20, Math.floor(chars))
  if (normalized.length <= limit) return normalized
  const summary = summarizeText(normalized, { maxChars: limit, queryText })
  return summary === '' ? normalized.slice(0, limit) : summary
}


//# sourceURL=source/memory-inject/src/summarize.ts