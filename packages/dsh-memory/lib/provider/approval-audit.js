/**
 * 审批审计（approvals.jsonl）。
 *
 * 只记“谁在什么时候申请了什么、用户怎么决定”，**不记记忆正文**——审计不能变成
 * 第二份敏感记忆库。与注入审计（inject audit）分开：那份记注入评估，这份记
 * 权限申请与授权生命周期。
 *
 * 每行一个不可变事件，追加写（O_APPEND），跨进程写小行不会互相撕裂。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

                                    
               
              
            
             
             
             

/**
 * 审批卡类型（0.32.0 起三种）：
 *   - `records` 记忆条目照常放行；
 *   - `grant`   作用域会话授权；
 *   - `block`   屏蔽（按作用域 / 工作区级 / 规则）。
 */
                                                                 

                                     
            
                               
                                                     
            
                   
              
                
                    
                         
                   
                                       
                           
                
                      
                  
 

export class ApprovalAuditStore {
           file        
  /** 0.107.0：文件超过该字节数就保留最近 keepLines 行重写（防长期使用无界增长）。 */
                   maxBytes        
                   keepLines        

  constructor(options                                                         ) {
    this.file = join(options.root, 'approvals.jsonl')
    this.maxBytes = Math.max(256, options.maxBytes ?? 1_000_000)
    this.keepLines = Math.max(5, options.keepLines ?? 2000)
  }

  append(event                    )       {
    try {
      if (!existsSync(this.file)) mkdirSync(dirname(this.file), { recursive: true })
      appendFileSync(this.file, `${JSON.stringify(event)}\n`, 'utf8')
      this.rotateIfNeeded()
    } catch {
      // 审计写失败不能影响审批本身
    }
  }

  /**
   * 0.107.0：超过上限时保留最近 keepLines 行重写（tmp + rename，避免半截文件）。
   * 审批审计是低频旁路日志；这里只控制磁盘占用，不改变 list() 的语义（仍按时间倒序）。
   */
          rotateIfNeeded()       {
    try {
      if (statSync(this.file).size <= this.maxBytes) return
      const lines = readFileSync(this.file, 'utf8').split('\n').filter((line) => line.trim() !== '')
      const kept = lines.slice(-this.keepLines)
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, kept.length === 0 ? '' : `${kept.join('\n')}\n`, 'utf8')
      renameSync(tmp, this.file)
    } catch { /* 轮转失败不影响后续追加 */ }
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