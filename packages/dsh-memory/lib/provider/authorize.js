/**
 * 统一的访问判定（0.24.0 / D2）。
 *
 * 目标：**所有入口只解释一套规则**。此前可见域判定散落在工具层（`recordAllowed` /
 * `scopeWritable`）、provider（`visibilityFilterFor` / `isScopeReadable` /
 * `isScopeWritable` / `assertOperable`）和注入层（`autoRecallScopes` /
 * `visibleKinds`），同一份策略在不同入口可能给出不同答案。
 *
 * 这里的语义是产品决策，不是实现细节：
 *   - `absolute`：**没有审批放行路径**。范围外一律拒绝，`requestable` 恒为 false；
 *   - `normal`：范围外可被拒绝但可审批（`requestable=true`）；用户显式关掉
 *     `read` / `write` 的作用域不可审批，必须先由用户打开开关；
 *   - `none`：不限制（策略里的 scopes 只是偏好）；
 *   - `discover` 只受作用域类型开关约束：`absolute` 下名字/用途仍可发现，
 *     这正是“目录可见、正文不可读”的边界；
 *   - 作用域类型被配置关闭（如 `customEnabled=false`）时，连 discover 都拒绝。
 *
 * 纯函数、无 I/O；provider 负责把 agent 上下文解析成 `AccessContext`。
 */
                                                                              
                                           

                                                                   

                                
                                               
               
                      
                                          
               
 

                              
                    
                        
                   
                    
                      
                        
                                                 
                    

                                 
                  
                           
                                          
                      
                                                              
                               
                       
 

/** 会话授权（0.24.0 / D3）；只有 normal 等级、且作用域在范围外时才参与判定。 */
                            
               
                                            
 

                                
                        
                           
                                   
                    
                                     
                                         
                                    
                                            
                               
     
                                                   
                                       
     
                                      
 

function outsideDecision(level                 )                 {
  return level === 'absolute'
    ? { allowed: false, reason: 'ABSOLUTE_ISOLATION', requestable: false }
    : { allowed: false, reason: 'SCOPE_NOT_IN_RANGE', requestable: level === 'normal' }
}

export function authorize(request               , context               )                 {
  if (!context.enabled[context.originOf(request.scope)]) {
    return { allowed: false, reason: 'SCOPE_DISABLED', requestable: false }
  }
  // 归档是宿主生命周期事实，不是可见域策略：没有审批放行路径，也**不允许**申请。
  // discover 仍然允许（目录/面板要能看出「这个作用域已归档」），正文一律不可读。
  if (context.archivedScopes?.has(request.scope) === true) {
    if (request.action === 'discover') return { allowed: true, source: 'directory' }
    return { allowed: false, reason: 'SCOPE_ARCHIVED', requestable: false }
  }
  if (request.action === 'discover') {
    return { allowed: true, source: 'directory' }
  }
  if (context.level === 'none') {
    return { allowed: true, source: 'unrestricted' }
  }
  const rule = context.scopes.find((item) => item.scope === request.scope)
  /** 范围外时先看会话 grant；**只在 normal 下**，absolute 没有任何例外。 */
  const granted = (permission                  )          =>
    context.level === 'normal' && context.grants?.some((grant) =>
      grant.scope === request.scope && grant.permissions.includes(permission)) === true
  if (request.action === 'read') {
    if (rule === undefined) {
      return granted('read')
        ? { allowed: true, source: 'grant' }
        : outsideDecision(context.level)
    }
    if (rule.read === false) return { allowed: false, reason: 'READ_DISABLED', requestable: false, rule }
    if (rule.kinds !== undefined && rule.kinds.length > 0
      && (request.kind === undefined || !rule.kinds.includes(request.kind))) {
      return { allowed: false, reason: 'KIND_NOT_ALLOWED', requestable: false, rule }
    }
    return { allowed: true, source: 'in-range', rule }
  }
  // write / delete：0.24 起删除仍归在 write；独立 delete 权限留给后续版本。
  if (rule === undefined) {
    return granted('write')
      ? { allowed: true, source: 'grant' }
      : outsideDecision(context.level)
  }
  if (rule.write === false) return { allowed: false, reason: 'WRITE_DISABLED', requestable: false, rule }
  return { allowed: true, source: 'in-range', rule }
}


//# sourceURL=source/memory-local/src/authorize.ts