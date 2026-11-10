/**
 * 记忆事件总线（0.31.0）：把「写入 / 召回 / 删除」作为**旁路事件**广播出去，
 * 让其他插件可以订阅记忆的变化（「万物皆插件」的协作层）。
 *
 * 三条硬约束（都是为了让事件绝不反过来伤害记忆主流程）：
 *  1. emit 永不抛 —— 宿主没有 `emit`、订阅者抛错、sink 抛错，全部吞掉；
 *  2. 同步 emit —— 保存/检索/删除返回前事件已经派发完，订阅者看到的就是当前状态；
 *  3. payload 只含元数据（scope / id / kind / 字数 / 去重 / 命中数 / 通道），
 *     **绝不含记忆正文**：订阅者拿到 id 后要正文应当走 `memory_get`，受可见域约束。
 *
 * 两条出口：
 *  - `sink`：宿主事件出口（apply.ts 里用 cordis `ctx.emit` 实现），转成宿主事件；
 *  - `subscribe`：本进程内的订阅，测试与同进程消费者用。
 *  两者都没有时只做空广播，不报错。
 */

/** 对外事件名（宿主事件名 / 进程内订阅名一致）。 */
export const MEMORY_EVENT = {
  saved: 'memory/record-saved',
  recalled: 'memory/recalled',
  forgotten: 'memory/record-forgotten',
}         

                                                                              

/** 一条记忆落库之后。只描述「发生了什么」，不含正文。 */
                                     
               
            
              
                      
               
                                  
                  
 

/** 一次检索完成之后。只报计数与通道状态，不含命中正文。 */
                                        
               
              
                                 
                     
                                    
                 
                                               
                 
 

/** 一次删除之后。ids 是被删掉的记录 id，正文已经不在。 */
                                         
               
               
 

/** 宿主事件出口（apply.ts 用 ctx.emit 实现）；拿不到宿主时安全降级。 */
                                                                      

/** 进程内订阅者。 */
                                                                          

export class MemoryEventBus {
          sink                             
                   listeners = new Set                     ()

  constructor(sink                  ) {
    if (typeof sink === 'function') this.sink = sink
  }

  /** 本进程内的订阅（测试与其他代码用）；返回取消函数（可重复调用）。 */
  subscribe(listener                     )             {
    if (typeof listener !== 'function') return () => {}
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  setSink(sink                             )       {
    this.sink = typeof sink === 'function' ? sink : undefined
  }

  saved(payload                    )       {
    this.emit(MEMORY_EVENT.saved, payload)
  }

  recalled(payload                       )       {
    this.emit(MEMORY_EVENT.recalled, payload)
  }

  forgotten(payload                        )       {
    this.emit(MEMORY_EVENT.forgotten, payload)
  }

  /**
   * 同步派发：先给本进程订阅者，再给宿主 sink。
   * 任何一环抛错都只丢这一环，不影响其他订阅者，更不会冒泡到 caller。
   */
          emit(name                 , payload         )       {
    // 浅冻结一份快照：订阅者改自己的副本不会污染其他订阅者，总线本身也不持有引用。
    const event = payload !== null && typeof payload === 'object'
      ? Object.freeze({ ...(payload                           ) })
      : payload
    for (const listener of [...this.listeners]) {
      try {
        listener(name, event)
      } catch {
        // 订阅者自己的错：记事件是旁路，不能因此让保存/检索/删除失败。
      }
    }
    const sink = this.sink
    if (sink === undefined) return
    try {
      sink(name, event)
    } catch {
      // 宿主没有该事件 / 宿主监听器抛错：丢掉这一条事件即可。
    }
  }
}


//# sourceURL=source/memory-local/src/events.ts