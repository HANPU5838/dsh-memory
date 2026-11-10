/**
 * 多路排名融合(Reciprocal Rank Fusion, RRF)+ 分数归一 —— 0.36.0。
 *
 * 为什么用 RRF 而不是加权求和:
 *   检索有三路信号 —— 词法(BM25,分数无上界)、向量(余弦,0..1)、查询扩展
 *   变体(BM25 的另一组排名)。它们的分数域不同、量纲不同:BM25 一条命中可能
 *   0.8 也可能 12.3,余弦 0.83,直接加权求和必须先把三路都校准到同一分布,
 *   而校准本身又要按库调参(阈值/分位数),换库就失效。
 *
 *   RRF 只看**名次**,不看分数绝对值:
 *
 *     RRF(d) = Σ_{list∈lists} w_list / (k + rank_list(d))
 *
 *   名次天然跨通道可比,不需要任何校准;k(=60)是平滑常数,压制"单路排第一"
 *   的偶然性 —— k 越大,多路共识越重要(k→0 时退化为"名次越靠前越猛")。
 *   实测里 RRF 以几乎零调参代价追平甚至超过调好的加权和,所以作为默认融合器。
 *
 * 可解释性:
 *   输出每条命中都带 `sources`:它在哪几路出现、每路名次、该路权重、该路贡献分。
 *   面板/日志可以直接展示"这条是词法第 1 + 向量第 3 融出来的",调参时不用猜。
 *
 * 纯函数、无 I/O、零第三方依赖;输入列表按调用方给定顺序读取,但输出排序与
 * 列表顺序无关(同分按最佳名次、再按 id),因此同一组列表换序 → 同一结果。
 */

/** RRF 平滑常数默认值:60 是原论文与多数实现的默认取法。 */
export const DEFAULT_RRF_K = 60

                                  
                                     
            
                                    
                 
 

function finiteOr(value                    , fallback        )         {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 权重解析:非有限回落 1,负数按 0(该路不贡献分数)。 */
function resolveWeight(weight                    )         {
  return Math.max(0, finiteOr(weight, 1))
}

/** k 解析:非有限回落 60,负数按 0。 */
function resolveK(k                    )         {
  return Math.max(0, finiteOr(k, DEFAULT_RRF_K))
}

/**
 * 单路贡献分:`weight / (k + rank)`。
 *
 * rank 是 **1-based** 名次(第一名 = 1);非有限/小于 1 的名次按 1 处理,所以
 * 任何有效命中的单路贡献都在 (0, weight/k] 区间。纯函数。
 */
export function rrfScore(rank        , opts                  = {})         {
  const k = resolveK(opts.k)
  const weight = resolveWeight(opts.weight)
  const normalizedRank = Number.isFinite(rank) ? Math.max(1, Math.round(rank)) : 1
  const score = weight / (k + normalizedRank)
  return Number.isFinite(score) ? Math.max(0, score) : 0
}

                                   
                            
              
                            
              
 

/**
 * min-max 归一:把一组分数线性映射到 0..1。纯函数,返回新数组。
 *
 * 约定:
 *   - 空数组 → 空数组;
 *   - 非有限值(NaN/Infinity)不参与求极值,输出 0;
 *   - 传入显式 min/max 时以显式值为准(可把不同通道固定到同一坐标域),
 *     超出范围的分数夹到 0/1;
 *   - 所有有限值相等(span = 0)时无法区分相对大小:正值全部映射到 1
 *     (在该通道内并列第一),0/负值映射到 0(没有正向信号);
 *   - 不改入参数组。
 *
 * 用途:分数级融合(把 BM25/余弦压到同一量级)、面板展示、与 RRF 结果做
 * 混合重排前的预处理。
 */
export function normalizeScores(scores                   , opts                   = {})           {
  const values = Array.isArray(scores) ? scores : []
  if (values.length === 0) return []
  const finite = values.filter((value)                  => typeof value === 'number' && Number.isFinite(value))
  const explicitMin = typeof opts.min === 'number' && Number.isFinite(opts.min) ? opts.min : undefined
  const explicitMax = typeof opts.max === 'number' && Number.isFinite(opts.max) ? opts.max : undefined
  const lo = explicitMin ?? (finite.length > 0 ? Math.min(...finite) : 0)
  const hi = explicitMax ?? (finite.length > 0 ? Math.max(...finite) : 0)
  const span = hi - lo
  return values.map((value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0
    if (!(span > 0)) return value > 0 ? 1 : 0
    const normalized = (value - lo) / span
    return Math.min(1, Math.max(0, normalized))
  })
}

/** 一路排序列表:通道名 + 按相关度从高到低的 id 序列。 */
                             
                                                        
              
                                                
                        
                                             
                 
 

/** 一条命中在某一路里的来源信息。 */
                               
            
              
                        
              
               
                
                                    
               
 

/** 融合后的一条命中。 */
                           
            
                                    
               
                                           
                         
 

                             
                                 
            
     
                                 
                                                
     
                                                      
                               
                
 

/** 确定性的通道名比较(码点序)。 */
function compareText(a        , b        )         {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/** 某一路的生效权重:opts.weights 优先,其次列表自带,最后默认 1。 */
function weightOf(list            , index        , weights                       )         {
  if (Array.isArray(weights)) {
    const value = (weights                     )[index]
    return value !== undefined ? resolveWeight(value) : resolveWeight(list.weight)
  }
  if (weights !== null && typeof weights === 'object') {
    const value = (weights                          )[list.name]
    return value !== undefined ? resolveWeight(value) : resolveWeight(list.weight)
  }
  return resolveWeight(list.weight)
}

/**
 * 多路排名融合(Reciprocal Rank Fusion)。纯函数,不修改入参。
 *
 * 行为:
 *   - lists 里非对象/空 id 的条目跳过;通道名缺失时按位置补 `channel<下标+1>`
 *     (`channel1` 起),保证来源信息永远可读;
 *   - 同一路里重复的 id 只计第一次出现的名次(后面的重复不再加分);
 *   - 输出按 RRF 总分降序;同分时按"最佳名次"升序(多路里排得最高的在前),
 *     再同分按 id 升序 —— 与列表顺序无关,可复现;
 *   - `limit` 截断在排序之后。
 *
 * 返回值即"可解释的融合排名":每条带 sources(哪几路/名次/权重/贡献)。
 */
export function reciprocalRankFusion(
  lists                       ,
  opts             = {},
)             {
  const k = resolveK(opts.k)
  const usable = Array.isArray(lists) ? lists : []
  const byId = new Map                  ()
  for (let listIndex = 0; listIndex < usable.length; listIndex++) {
    const list = usable[listIndex]
    if (list === null || list === undefined || typeof list !== 'object') continue
    const name = typeof list.name === 'string' && list.name.length > 0
      ? list.name
      : `channel${listIndex + 1}`
    const weight = weightOf(list, listIndex, opts.weights)
    const ids = Array.isArray(list.ids) ? list.ids : []
    const seenInList = new Set        ()
    for (let position = 0; position < ids.length; position++) {
      const id = ids[position]
      if (typeof id !== 'string' || id.length === 0 || seenInList.has(id)) continue
      seenInList.add(id)
      const rank = position + 1 // 名次按原始位置算:即使前面有非法 id,名次也不压缩
      const contribution = rrfScore(rank, { k, weight })
      const hit = byId.get(id)
      if (hit === undefined) {
        byId.set(id, {
          id,
          score: contribution,
          sources: [{ name, rank, weight, score: contribution }],
        })
      } else {
        hit.score += contribution
        hit.sources.push({ name, rank, weight, score: contribution })
      }
    }
  }

  const hits = [...byId.values()]
  for (const hit of hits) hit.sources.sort((a, b) => compareText(a.name, b.name) || a.rank - b.rank)
  hits.sort((a, b) => b.score - a.score
    || bestRank(a) - bestRank(b)
    || compareText(a.id, b.id))

  const limit = opts.limit === undefined
    ? hits.length
    : Math.max(0, Math.min(hits.length, Number.isFinite(opts.limit) ? Math.floor(opts.limit) : 0))
  return limit >= hits.length ? hits : hits.slice(0, limit)
}

/** 一条命中的最佳(最小)名次;无来源时视为无穷大。 */
function bestRank(hit          )         {
  let best = Number.POSITIVE_INFINITY
  for (const source of hit.sources) best = Math.min(best, source.rank)
  return best
}


//# sourceURL=source/memory-local/src/retrieval/fusion.ts