/**
 * 可选 ANN（近似最近邻）索引的公共契约（任务书 §3）。
 *
 * 设计目标：记忆库从几千条涨到几万条后，每次查询对全量向量做余弦扫描会变成
 * 主要延迟（20k × 1024 维 ≈ 每次查询 20M 次乘加）。ANN 用图索引把候选压到
 * 几百条，召回率保持 >95%。但 ANN 必须是**可选加速**，不是硬依赖：
 *
 *   - 纯 JS 兜底实现（`ann/hnsw-lite.ts`）零依赖、永远可用；
 *   - `hnswlib-node` 是可选依赖，动态 import + try/catch，没装就跳过；
 *   - 两者都不可用时退化成 `ann/brute.ts` 的全量余弦扫描（与现有检索路径等价）。
 *
 * 所有实现的向量都会在写入时做 L2 归一化，score = cosine 相似度（0..1 语义
 * 与现有 `cosine()` 一致，可 1:1 替换检索里的全量扫描）。
 */

/** 向量来源：记忆 id → 向量。 */
                          
            
                      
 

                         
            
                                   
               
 

                                   
                                                            
                    
                                
                   
 

                           
               
                   
              
                                 
                
              
                               
                   
                                    
                  
 

                                                      

                           
                        
                       
              
                       
                                            
                                        
                              
                                                                           
                                              
                                                   
                           
                                                   
                           
                             
                          
               
                   
 

/** 校验维度并做防御性归一化：所有实现共用，保证 score 语义一致。 */
export function prepareAnnVector(vector              , dims        )               {
  if (!(vector instanceof Float32Array)) {
    throw new TypeError('ANN 向量必须是 Float32Array')
  }
  if (vector.length !== dims) {
    throw new Error(`ANN 向量维度不符：收到 ${vector.length}，期望 ${dims}`)
  }
  const copy = new Float32Array(vector)
  let sum = 0
  for (let i = 0; i < copy.length; i++) sum += copy[i]  * copy[i] 
  const norm = Math.sqrt(sum)
  if (norm > 0) for (let i = 0; i < copy.length; i++) copy[i] = copy[i]  / norm
  return copy
}


//# sourceURL=source/memory-local/src/ann/types.ts