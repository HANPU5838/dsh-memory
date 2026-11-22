/**
 * 反思候选（kind=reflection）。
 *
 * 反思不直接进主库：先落成候选（status=candidate），由人或 Agent 确认后转正。
 * 工具层用 JSON 字符串传参；元数据存 reflection 字段，正文保持人类可读。
 */

                                                                   

                                  
                    
                                   
                             
                                          
                                               
                                               
                             
                           
                            
 

const STATUSES = new Set(['candidate', 'adopted', 'rejected'])

export class ReflectionInvalid extends Error {
           code = 'REFLECTION_INVALID'
  constructor(reason        ) {
    super(`反思字段不合法：${reason}`)
  }
}

function stringList(value         , limit        )           {
  return Array.isArray(value) ? value.map(String).filter((item) => item.trim() !== '').slice(0, limit) : []
}

/** 接受对象或 JSON 字符串；严格校验后返回规范化对象。 */
export function parseReflectionField(raw         )                  {
  let value          = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      throw new ReflectionInvalid('不是合法 JSON')
    }
  }
  if (value === null || typeof value !== 'object') throw new ReflectionInvalid('必须是对象')
  const obj = value                           
  const conclusion = String(obj.conclusion ?? '').trim()
  if (conclusion === '') throw new ReflectionInvalid('conclusion 不能为空')
  const status = String(obj.status ?? 'candidate')
  if (!STATUSES.has(status)) throw new ReflectionInvalid('status 只能是 candidate / adopted / rejected')
  const confidence = typeof obj.confidence === 'number' && Number.isFinite(obj.confidence)
    ? Math.min(1, Math.max(0, obj.confidence))
    : 0.6
  return {
    schema: 1,
    status: status                    ,
    conclusion,
    evidence: stringList(obj.evidence, 20),
    preconditions: stringList(obj.preconditions, 10),
    notApplicable: stringList(obj.notApplicable, 10),
    confidence,
    kindHint: String(obj.kindHint ?? '').slice(0, 40),
    scopeHint: String(obj.scopeHint ?? '').slice(0, 200),
  }
}


//# sourceURL=source/memory-local/src/reflection.ts