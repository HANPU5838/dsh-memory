/**
 * 离线检索评测:recall@k / MRR@k / nDCG@k(0.32.0)。
 *
 * 用途:改阈值、开 MMR、调 floor 之后,不能再靠"感觉结果更好了"来验收。
 * 把一批"查询 + 人工标注的相关 id + 检索器实际给出的排序"喂进来,得到一组
 * 可比较的数字;`toCsv()` 导出后可以丢进表格对比不同参数组合。
 *
 * 约定:
 *   - 输入是**纯 id 序列**,不依赖记录内容/向量 —— 评测器不碰存储,也不调用检索。
 *   - `relevant` 为空表示该死查询没有标准答案:三项指标都记 0(而不是跳过),
 *     这样宏平均不会被空查询"美化"。
 *   - 排名里重复的 id 只算第一次出现的名次。
 *   - nDCG 用**二元相关**(相关=1、不相关=0)的 `(2^rel − 1)/log2(rank+1)`;
 *     标注只有 id 列表,没有分级相关度。
 *   - `evaluateQuery(query, k)` 的三项指标都在 k 处截断(MRR@k 口径);
 *     想要全表 MRR 直接调 `reciprocalRank(ranked, relevant)`(不传 k)。
 *
 * 纯函数、无 I/O、无第三方依赖。
 */

/** 一条评测样本:查询文本、标注相关 id、检索器返回的排序(最好在前)。 */
                            
               
                          
                             
                                   
                           
 

                               
               
                   
                                   
                        
                 
 

                             
             
           
            
                 
                     
                   
                  
             
                   
                 
                        
                          
 

/** 去重并丢掉空 id,保留首次出现顺序。 */
function uniqueIds(ids                   )           {
  const out           = []
  const seen = new Set        ()
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

function clampK(k        )         {
  if (Number.isNaN(k)) return 0
  if (!Number.isFinite(k)) return Number.MAX_SAFE_INTEGER // Infinity = 不截断
  return Math.max(0, Math.floor(k))
}

/** 前 k 个名次里命中了几条标注相关 id(去重后)。 */
function hitsAtK(ranked                   , relevant                     , k        )         {
  let hit = 0
  for (const id of uniqueIds(ranked).slice(0, k)) if (relevant.has(id)) hit += 1
  return hit
}

/**
 * recall@k = |相关 ∩ 前 k| / |相关|。
 * 没有标注(相关集为空)返回 0 —— 无标准答案的查询不该被算成满分。
 */
export function recallAtK(ranked                   , relevant                   , k = 10)         {
  const rel = new Set(uniqueIds(relevant))
  if (rel.size === 0) return 0
  return hitsAtK(ranked, rel, clampK(k)) / rel.size
}

/**
 * 倒数名次(Reciprocal Rank):第一个相关结果的名次 n → 1/n;没有 → 0。
 * `k` 省略时看全表;传 k 则只看前 k(评测口径 MRR@k)。
 */
export function reciprocalRank(ranked                   , relevant                   , k = Number.POSITIVE_INFINITY)         {
  const rel = new Set(uniqueIds(relevant))
  if (rel.size === 0) return 0
  const top = uniqueIds(ranked).slice(0, clampK(k))
  for (let i = 0; i < top.length; i++) {
    if (rel.has(top[i] )) return 1 / (i + 1)
  }
  return 0
}

/**
 * 折算累计增益 DCG@k,增益用 `(2^rel − 1)/log2(rank+1)`(rank 从 1 开始)。
 * 二元相关时每项就是 1/log2(rank+1),这里保留通用形式方便以后接分级标注。
 */
export function dcgAtK(gains                   , k = 10)         {
  const depth = Math.min(clampK(k), gains.length)
  let sum = 0
  for (let i = 0; i < depth; i++) {
    const gain = gains[i] 
    if (!(gain > 0)) continue
    sum += (Math.pow(2, gain) - 1) / Math.log2(i + 2)
  }
  return sum
}

/**
 * nDCG@k(二元相关):DCG@k / IDCG@k,IDCG 是"所有相关结果排在最前"的理想排序
 * 同样截断到 k。相关集为空或 IDCG=0 时返回 0。
 */
export function ndcgAtK(ranked                   , relevant                   , k = 10)         {
  const rel = new Set(uniqueIds(relevant))
  if (rel.size === 0) return 0
  const depth = clampK(k)
  const gains = uniqueIds(ranked).slice(0, depth).map((id) => (rel.has(id) ? 1 : 0))
  const ideal = new Array        (Math.min(rel.size, depth)).fill(1)
  const idcg = dcgAtK(ideal, depth)
  return idcg === 0 ? 0 : dcgAtK(gains, depth) / idcg
}

/** 单条查询的三项指标(k 处截断)。 */
export function evaluateQuery(query           , k = 10)               {
  const depth = clampK(k)
  return {
    query: query.query,
    recallAtK: recallAtK(query.ranked, query.relevant, depth),
    reciprocalRank: reciprocalRank(query.ranked, query.relevant, depth),
    ndcgAtK: ndcgAtK(query.ranked, query.relevant, depth),
  }
}

/** 批量评测:返回宏平均 + 逐查询明细。空集合时均值为 0。 */
export function evaluate(queries                      , k = 10)             {
  const depth = clampK(k)
  const perQuery = queries.map((query) => evaluateQuery(query, depth))
  const mean = (pick                               )         =>
    perQuery.length === 0 ? 0 : perQuery.reduce((sum, row) => sum + pick(row), 0) / perQuery.length
  return {
    k: depth,
    queries: perQuery.length,
    recallAtK: mean((row) => row.recallAtK),
    mrr: mean((row) => row.reciprocalRank),
    ndcgAtK: mean((row) => row.ndcgAtK),
    perQuery,
  }
}

/** CSV 字段转义:含逗号/引号/换行时加双引号,内部引号翻倍。 */
function csvField(value        )         {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** 指标列固定 6 位小数,方便跨参数组合直接 diff / 贴表格。 */
function fixed(value        )         {
  return (Number.isFinite(value) ? value : 0).toFixed(6)
}

/**
 * 导出 CSV:表头按实际 k 命名(`recall@5` / `ndcg@5`),每条查询一行,
 * 最后一行是 `__aggregate__` 汇总行(宏平均),方便对比不同参数。
 * 行尾统一 `\n`,Excel / 表格软件可直接打开。
 */
export function toCsv(report            )         {
  const header = ['query', `recall@${report.k}`, 'rr', `ndcg@${report.k}`].join(',')
  const rows = report.perQuery.map((row) => [
    csvField(row.query),
    fixed(row.recallAtK),
    fixed(row.reciprocalRank),
    fixed(row.ndcgAtK),
  ].join(','))
  rows.push([
    csvField('__aggregate__'),
    fixed(report.recallAtK),
    fixed(report.mrr),
    fixed(report.ndcgAtK),
  ].join(','))
  return `${[header, ...rows].join('\n')}\n`
}


//# sourceURL=source/memory-local/src/retrieval/eval.ts