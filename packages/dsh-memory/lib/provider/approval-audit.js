/**
 * 审批审计（approvals.jsonl）。
 *
 * 只记“谁在什么时候申请了什么、用户怎么决定”，**不记记忆正文**——审计不能变成
 * 第二份敏感记忆库。与注入审计（inject audit）分开：那份记注入评估，这份记
 * 权限申请与授权生命周期。
 *
 * 每行一个不可变事件，追加写（O_APPEND），跨进程写小行不会互相撕裂。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

                                    
               
              
            
             
             
             

/**
 * 审批卡类型（0.32.0 起三种）：
 *   - `records` 记忆条目照常放行；
 *   - `grant`   作用域会话授权；
 *   - `block`   屏蔽（按作用域 / 工作区级 / 规则）。
 */
                                                                 

                                     
            
                               
                                                     
            
                   
              
                
                    
                         
                   
                                       
                           
                
                      
                  
 

export class ApprovalAuditStore {
           file        

  constructor(options                  ) {
    this.file = join(options.root, 'approvals.jsonl')
  }

  append(event                    )       {
    try {
      if (!existsSync(this.file)) mkdirSync(dirname(this.file), { recursive: true })
      appendFileSync(this.file, `${JSON.stringify(event)}\n`, 'utf8')
    } catch {
      // 审计写失败不能影响审批本身
    }
  }

  /** 最近 N 条（面板 / 诊断用），坏行跳过。 */
  list(limit = 200)                       {
    let text        
    try {
      text = readFileSync(this.file, 'utf8')
    } catch {
      return []
    }
    const out                       = []
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const value = JSON.parse(trimmed)                      
        if (value !== null && typeof value === 'object' && typeof value.event === 'string') out.push(value)
      } catch { /* 坏行跳过 */ }
    }
    return out.slice(-Math.max(1, Math.min(2000, limit))).reverse()
  }
}


//# sourceURL=source/memory-local/src/approval-audit.ts