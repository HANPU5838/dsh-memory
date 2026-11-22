/**
 * 用户画像（kind=profile）。
 *
 * 一条记录 = 一个可复用的画像单元（一个偏好 / 习惯 / 约束），正文保持人类可读，
 * 结构化元数据放 profile 字段。工具层用 JSON 字符串传参（DSH 的参数 schema 只允许扁平类型）。
 */

                               
                    
                                                                                    
                        
                            
                             
                                          
 

const PROFILE_TYPES = new Set(['preference', 'trait', 'habit', 'constraint', 'skill', 'event'])

export class ProfileInvalid extends Error {
           code = 'PROFILE_INVALID'
  constructor(reason        ) {
    super(`画像字段不合法：${reason}`)
  }
}

/** 接受对象或 JSON 字符串；严格校验后返回规范化对象。 */
export function parseProfileField(raw         )               {
  let value          = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      throw new ProfileInvalid('不是合法 JSON')
    }
  }
  if (value === null || typeof value !== 'object') throw new ProfileInvalid('必须是对象')
  const obj = value                           
  const type = String(obj.type ?? '')
  if (!PROFILE_TYPES.has(type)) throw new ProfileInvalid(`type 只能是 ${[...PROFILE_TYPES].join(' / ')}`)
  const topic = String(obj.topic ?? '').trim()
  if (topic === '') throw new ProfileInvalid('topic 不能为空')
  const statement = String(obj.statement ?? '').trim()
  if (statement === '') throw new ProfileInvalid('statement 不能为空')
  const confidence = typeof obj.confidence === 'number' && Number.isFinite(obj.confidence)
    ? Math.min(1, Math.max(0, obj.confidence))
    : 0.6
  const evidence = Array.isArray(obj.evidence) ? obj.evidence.map(String).slice(0, 20) : []
  return {
    schema: 1,
    type: type                        ,
    topic,
    statement,
    confidence,
    evidence,
  }
}


//# sourceURL=source/memory-local/src/profile.ts