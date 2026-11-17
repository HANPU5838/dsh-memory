/**
 * 记忆钩子（memory hooks）：给规则记忆附带可执行代码，并在明确的时机由插件运行。
 *
 * 为什么要有它
 * ------------
 * `kind=rule` 的记忆只是"写给模型看的话"。模型可能记错、漏做、或者压根不看。
 * 「概括 + ：+ 正文」这类**能写成检查**的规则，应该由代码强制，而不是靠模型自觉。
 * 所以规则记忆可以附带一段脚本，插件在三个时机运行它：
 *
 *   before-save    保存前校验。脚本可以说"不合规"从而**拒绝这次保存**（veto）。
 *   after-save     保存后观察。只记录/附注，不改写、不阻断。
 *   before-inject  注入前解析。可以改写即将进入上下文的正文，或整条丢弃。
 *
 * 三条硬约定
 * ----------
 * 1) **代码不纳入记忆检索。** 钩子存在 `<storeDir>/hooks.json`，与
 *    scopes.json / settings.json 同级；它们不是记忆记录、不进 JSONL、不进向量索引，
 *    search / list / digest / recall 都看不见。只有 memory_hooks 与面板能取到代码。
 * 2) **沙箱执行。** node:vm 新上下文、禁用 eval/new Function、无 require / process /
 *    fs / net、无定时器；数据以 JSON 文本**在沙箱内**解析，宿主对象一个都不进上下文。
 *    模块体与每次调用都套 `timeout`，死循环会被中断而不是挂住 DSH。
 * 3) **脚本崩溃不等于校验不通过。** 返回 `{ok:false}` 是它的职责（阻断写入）；
 *    脚本抛异常 / 超时是它自己坏了 —— 那就只告警、不阻断，否则一条写坏的校验器
 *    会让整个记忆系统无法写入，等于丢数据。错误计数进 lastOutcome，面板上一眼可见。
 *
 * 审批
 * ----
 * 带代码的规则在首次保存时向用户审批一次（默认开启，见 config.hooks.requireApproval）。
 * 批准记的是**代码指纹**（sha256），所以"同一段代码"不会再问第二遍，而只要代码变了
 * 就必须重新批准 —— 否则改两个字符就能让用户批准过的权限继续生效。
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as vm from 'node:vm'

// ---------------------------------------------------------------- 类型

/** 可运行脚本的三个时机。 */
                                                                      

export const HOOK_PHASES                       = ['before-save', 'after-save', 'before-inject']

/** 每个时机默认找的函数名（最后都兜底接受 `main`）。 */
const PHASE_ENTRY                              = {
  'before-save': ['verify', 'verifyMemoryContent', 'main'],
  'after-save': ['observe', 'afterSave', 'main'],
  'before-inject': ['parse', 'parseMemory', 'main'],
}

/** 一个钩子（持久化形态）。 */
                             
            
              
                  
              
                  
                                  
                  
                                 
                 
                      
                   
                   
                   
                                                  
                       
                                      
                 
                  
                    
                     
                    
                                           
                      
 

/** 新建 / 更新钩子的入参。`id` 存在 = 更新。 */
                                
             
               
                  
              
                   
                   
                  
                      
                    
                 
                             
                       
 

/** 运行脚本时喂进去的一条记忆（纯数据）。 */
                                 
             
               
              
                 
                
                    
                     
                    
                    
                    
                     
                   
 

/**
 * 钩子脚本能读到的注入设置（只读快照，随 ctx 进沙箱）。
 *
 * 只暴露"和摘要字数相关"的几项，不把整个 settings.json 倒进沙箱：
 * 脚本用它决定"冒号前的内容如果太长，按哪个上限截断"。
 * 各项与 inject-settings.ts 里的默认值一致，调用方（parseForInject）用实时设置覆盖。
 */
                                   
                                                  
                     
                              
                         
                            
                     
 

/** 一次运行的输入。 */
                               
                        
                                         
               
                    
                      
                                                 
                             
 

/** 单个钩子的运行结果。 */
                              
                                                              
                                                                       
                                                  
             
                    
                  
                                          
                  
                             
                
                                   
                
                       
                 
                                                  
               
                    
 

                               
                  
                   
                          
                      
 

export const DEFAULT_HOOK_SETTINGS               = {
  enabled: true,
  timeoutMs: 120,
  requireApproval: true,
  maxCodeChars: 16_000,
}

/** 代码指纹：审批与编译缓存都以它为准。 */
export function hashHookCode(code        )         {
  return createHash('sha256').update(code).digest('hex')
}

/** 空数组 / 含 '*' → 匹配全部。 */
function matchesFilter(list                   , value        )          {
  if (list.length === 0) return true
  return list.some((item) => item === '*' || item === value)
}

export function hookApplies(hook                                      , input                                 )          {
  return matchesFilter(hook.scopes, input.scope) && matchesFilter(hook.kinds, input.kind)
}

/** 这个钩子当前是否还需要用户批准（代码改过也算需要）。 */
export function hookNeedsApproval(
  hook                                           ,
  settings              ,
)          {
  if (!settings.requireApproval) return false
  return hook.approvedHash !== hashHookCode(hook.code)
}

// ---------------------------------------------------------------- 沙箱

/** 编译产物：一个已建好的上下文 + 入口函数名。 */
                    
                     
                   
 

/**
 * 沙箱预置的**纯计算**全局。
 *
 * 刻意**不放**：require / process / Buffer / setTimeout / fetch / console 之外的宿主对象。
 * `globalThis` 在 vm 上下文里指向沙箱自己，逃不出去；`codeGeneration.strings=false`
 * 已经把 eval 与 new Function 关掉。
 */
const SANDBOX_PRELUDE = `
  'use strict';
  globalThis.__dshHookLogs = [];
  globalThis.log = function () {
    var parts = [];
    for (var i = 0; i < arguments.length; i++) {
      var value = arguments[i];
      var text;
      if (typeof value === 'string') text = value;
      else {
        try { text = JSON.stringify(value); } catch (e) { text = String(value); }
        if (typeof text !== 'string') text = String(value);
      }
      parts.push(text.slice(0, 500));
    }
    __dshHookLogs.push(parts.join(' ').slice(0, 1000));
  };
`

/**
 * 把一段用户代码编译进新的 vm 上下文。
 *
 * 约定：代码是**模块体**，需要定义入口函数。按 phase 找 `verify` / `observe` / `parse`
 * （`main` 兜底）。入口函数同步返回结论，见 normalizeHookResult。
 */
function compile(code        , phase           , label        , timeoutMs        )           {
  const context = vm.createContext(Object.create(null), {
    // 关掉从字符串生成代码：`eval` 与 `new Function` 都被禁。
    codeGeneration: { strings: false, wasm: false },
  })
  // 预置 log()：每次运行前清空，脚本里的 log 会随结果回给调用方。
  new vm.Script(SANDBOX_PRELUDE, { filename: 'memory-hook:prelude' })
    .runInContext(context, { timeout: Math.max(50, timeoutMs) })
  // 只执行模块体（定义函数），同样受超时约束，防止顶层死循环。
  new vm.Script(code, { filename: `memory-hook:${label}` })
    .runInContext(context, { timeout: Math.max(50, timeoutMs) })

  for (const name of PHASE_ENTRY[phase]) {
    const candidate = (context                           )[name]
    if (typeof candidate === 'function') return { context, entryName: name }
  }
  const expected = PHASE_ENTRY[phase].slice(0, -1).map((n) => `${n}()`).join(' 或 ')
  throw new Error(`脚本里找不到入口函数：需要定义 ${expected}（main() 也可以）`)
}

/**
 * 规范化脚本返回值。
 *
 * 接受：undefined / true / false / 字符串 / {ok,message,note,content,drop,reject}。
 * 其余（数字、数组…）当"通过"处理并忽略 —— 不让一个笔误把写入永久卡住。
 */
export function normalizeHookResult(raw         )                                                                      {
  if (raw === undefined || raw === null || raw === true) return { ok: true }
  if (raw === false) return { ok: false }
  if (typeof raw === 'string') {
    const text = raw.trim()
    return text === '' ? { ok: true } : { ok: false, message: text }
  }
  if (typeof raw === 'object') {
    const value = raw                           
    const ok = value.ok !== undefined ? value.ok !== false : value.reject !== true
    const out                                                                      = { ok }
    const message = typeof value.message === 'string' && value.message.trim() !== ''
      ? value.message.trim()
      : typeof value.note === 'string' && value.note.trim() !== '' ? value.note.trim() : undefined
    if (message !== undefined) out.message = message.slice(0, 500)
    if (typeof value.content === 'string') out.content = value.content
    if (value.drop === true) out.drop = true
    return out
  }
  return { ok: true }
}

/** 编译缓存：key = `${phase}:${codeHash}`。代码一改就自然换 key。 */
const compileCache = new Map                  ()
const COMPILE_CACHE_MAX = 64

/**
 * 运行一段脚本。**永不抛错** —— 所有失败都折成 `{ ok:true, error }`，
 * 由调用方决定是告警还是阻断。
 *
 * 调用也走 `runInContext`（而不是直接调 fn），这样 `timeout` 对**函数体**同样生效。
 */
export function runHookCode(
  code        ,
  phase           ,
  input              ,
  settings              ,
)                                                                                                                     {
  const timeout = Math.max(20, Math.min(5000, settings.timeoutMs))
  const key = `${phase}:${hashHookCode(code)}`
  let compiled = compileCache.get(key)
  if (compiled === undefined) {
    try {
      compiled = compile(code, phase, phase, timeout)
    } catch (error) {
      return { ok: true, error: `脚本无法加载：${error instanceof Error ? error.message : String(error)}`, logs: [] }
    }
    if (compileCache.size >= COMPILE_CACHE_MAX) compileCache.clear()
    compileCache.set(key, compiled)
  }

  const context = compiled.context                           
  // 每次运行清空 log 缓冲，避免上一次的日志串到这一次。
  context.__dshHookLogs = []
  // 数据以 **JSON 文本**进沙箱，在沙箱内 parse —— 宿主对象一个都不进上下文。
  const memoryJson = JSON.stringify({ ...input.memory })
  const ctxJson = JSON.stringify({
    phase,
    ...(input.tool !== undefined ? { tool: input.tool } : {}),
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    // 0.37.0：只读设置快照进沙箱 ctx.settings —— 脚本能按当前摘要字数限制截断。
    ...(input.settings !== undefined ? { settings: input.settings } : {}),
    now: Date.now(),
  })
  const driver = new vm.Script(
    `__dshHookResult = ${compiled.entryName}(JSON.parse(${JSON.stringify(memoryJson)}), JSON.parse(${JSON.stringify(ctxJson)}));`,
    { filename: 'memory-hook:invoke' },
  )
  try {
    driver.runInContext(compiled.context, { timeout })
    const raw = context.__dshHookResult
    const logs = readLogs(context)
    if (raw !== null && typeof raw === 'object' && typeof (raw                      ).then === 'function') {
      return { ok: true, error: '脚本返回了 Promise：钩子必须是同步函数（不允许 await）', logs }
    }
    // 0.38.0：raw 只保留可 JSON 序列化的部分，避免宿主对象/循环引用流到外面。
    let safeRaw         
    try { safeRaw = JSON.parse(JSON.stringify(raw ?? null)) } catch { safeRaw = String(raw) }
    return { ...normalizeHookResult(raw), logs, raw: safeRaw }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const timedOut = /timed out|Script execution timed out/i.test(message)
    return {
      ok: true,
      error: timedOut ? `脚本执行超时（上限 ${timeout}ms）` : `脚本抛错：${message}`,
      logs: readLogs(context),
    }
  }
}

/** 取走沙箱里 log() 攒下的内容。 */
function readLogs(context                         )           {
  const buffer = context.__dshHookLogs
  if (!Array.isArray(buffer)) return []
  const copy = buffer.slice(0, 20).map((item) => String(item).slice(0, 500))
  context.__dshHookLogs = []
  return copy
}

// ---------------------------------------------------------------- 存储

                     
                  
                     
 

const FILE_VERSION = 1

/**
 * 钩子存储：单个 JSON 文件 + 原子写。
 *
 * 与记忆分开存放是**功能要求**而不是实现细节：记忆记录会进向量索引、会被
 * search/recall/digest 读出来，而代码不该出现在任何一条"记忆"里。
 */
export class HookStore {
           file        
          hooks               = []
          loaded = false
                   onWarn                           

  constructor(options                                                      ) {
    this.file = join(options.root, 'hooks.json')
    this.onWarn = options.onWarn ?? (() => {})
  }

          load()       {
    if (this.loaded) return
    this.loaded = true
    try {
      if (!existsSync(this.file)) return
      const text = readFileSync(this.file, 'utf8')
      if (text.trim() === '') return
      const parsed = JSON.parse(text)                      
      const list = Array.isArray(parsed.hooks) ? parsed.hooks : []
      this.hooks = list.filter((hook)                     =>
        hook !== null && typeof hook === 'object' && typeof hook.id === 'string' && typeof hook.code === 'string')
        // 老文件可能缺统计字段：补齐，避免调用方到处判空。
        .map((hook) => {
          // 0.38.0：移除启用/停用语义，审批成为唯一闸门。老数据里 enabled:false
          // 的钩子等同于"用户不想让它跑" → 迁成"未批准"（清掉指纹），避免它突然生效。
          const migrated             = {
            ...hook,
            enabled: true,
            scopes: Array.isArray(hook.scopes) ? hook.scopes : [],
            kinds: Array.isArray(hook.kinds) ? hook.kinds : [],
            runCount: Number(hook.runCount) || 0,
            errorCount: Number(hook.errorCount) || 0,
            rejectCount: Number(hook.rejectCount) || 0,
          }
          if (hook.enabled === false) delete migrated.approvedHash
          return migrated
        })
    } catch (error) {
      // 坏文件不能让记忆整体不可用：退化成"没有钩子"，并在日志里说清楚。
      this.onWarn(`hooks.json 读取失败（按无钩子继续）：${error instanceof Error ? error.message : String(error)}`)
      this.hooks = []
    }
  }

          persist()       {
    const payload            = { schemaVersion: FILE_VERSION, hooks: this.hooks }
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      renameSync(tmp, this.file)
    } catch (error) {
      this.onWarn(`hooks.json 写入失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  list()               {
    this.load()
    return [...this.hooks]
  }

  get(id        )                         {
    this.load()
    return this.hooks.find((hook) => hook.id === id)
  }

  /**
   * 命中某次运行的全部钩子（已启用 + 作用域/类型匹配 + **已获批准**）。
   *
   * 审批是在这里守住的：一个还没被用户批准的脚本，`list()` 里看得见、面板里能编辑，
   * 但**永远不会被执行**。把闸门放在存储层而不是各个调用点，是因为调用点有四个
   * （保存前 / 保存后 / 注入前 / 试跑），漏一个就是一条绕过审批的路径。
   */
  forRun(phase           , target                                 , settings              , ignoreApproval = false)               {
    this.load()
    // 0.38.0：不再看 enabled（启用/停用语义已移除）—— 唯一闸门是"是否被批准"。
    return this.hooks.filter((hook) =>
      hook.phase === phase
      && hookApplies(hook, target)
      && (ignoreApproval || !hookNeedsApproval(hook, settings)))
  }

  save(input               , settings              )             {
    this.load()
    const code = input.code
    if (typeof code !== 'string' || code.trim() === '') throw new Error('code 不能为空')
    if (code.length > settings.maxCodeChars) throw new Error(`code 超过 ${settings.maxCodeChars} 字符上限`)
    if (!HOOK_PHASES.includes(input.phase)) throw new Error(`phase 必须是 ${HOOK_PHASES.join(' / ')}`)

    const now = Date.now()
    const existing = input.id !== undefined && input.id !== ''
      ? this.hooks.find((hook) => hook.id === input.id)
      : undefined
    if (existing !== undefined) {
      const codeChanged = existing.code !== code
      existing.name = (input.name ?? existing.name).trim() || existing.name
      existing.phase = input.phase
      existing.code = code
      // 0.38.0：enabled 不再是开关，统一保持 true；"不让跑"请用撤销批准。
      existing.enabled = true
      if (Array.isArray(input.scopes)) existing.scopes = input.scopes.map(String)
      if (Array.isArray(input.kinds)) existing.kinds = input.kinds.map(String)
      if (input.description !== undefined) existing.description = input.description
      if (input.ruleId !== undefined) existing.ruleId = input.ruleId
      existing.updatedAt = now
      // 代码变了 = 旧的审批作废；明确给新指纹（审批就是针对新代码做的）时采用它。
      if (input.approvedHash !== undefined) existing.approvedHash = input.approvedHash
      else if (codeChanged) delete existing.approvedHash
      if (codeChanged) {
        // 换了代码就是换了一个校验器：旧统计不再有意义。
        existing.runCount = 0
        existing.errorCount = 0
        existing.rejectCount = 0
        delete existing.lastOutcome
        delete existing.lastMessage
        delete existing.lastRunAt
      }
      this.persist()
      return existing
    }

    const hook             = {
      id: `hook-${randomUUID().slice(0, 8)}`,
      name: (input.name ?? '').trim() || `${input.phase} 规则`,
      phase: input.phase,
      code,
      enabled: true, // 0.38.0：审批是唯一闸门，enabled 恒 true（保留字段只为兼容旧数据）。
      scopes: Array.isArray(input.scopes) ? input.scopes.map(String) : [],
      kinds: Array.isArray(input.kinds) ? input.kinds.map(String) : [],
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.ruleId !== undefined ? { ruleId: input.ruleId } : {}),
      ...(input.approvedHash !== undefined ? { approvedHash: input.approvedHash } : {}),
      createdBy: input.createdBy ?? 'agent',
      createdAt: now,
      updatedAt: now,
      runCount: 0,
      errorCount: 0,
      rejectCount: 0,
    }
    this.hooks.push(hook)
    this.persist()
    return hook
  }

  delete(id        )          {
    this.load()
    const before = this.hooks.length
    this.hooks = this.hooks.filter((hook) => hook.id !== id)
    if (this.hooks.length === before) return false
    this.persist()
    return true
  }

  /** 记一次运行结果（统计 + 最近一次结局）。 */
  recordRun(id        , outcome                                                     )       {
    this.load()
    const hook = this.hooks.find((item) => item.id === id)
    if (hook === undefined) return
    hook.runCount += 1
    hook.lastRunAt = Date.now()
    if (outcome.crashed) {
      hook.errorCount += 1
      hook.lastOutcome = 'error'
    } else if (!outcome.ok) {
      hook.rejectCount += 1
      hook.lastOutcome = 'rejected'
    } else {
      hook.lastOutcome = 'ok'
    }
    if (outcome.message !== undefined) hook.lastMessage = outcome.message.slice(0, 300)
    else if (hook.lastOutcome === 'ok') delete hook.lastMessage
    this.persist()
  }

  /** 记一次审批指纹。 */
  approve(id        , hash        )          {
    this.load()
    const hook = this.hooks.find((item) => item.id === id)
    if (hook === undefined) return false
    hook.approvedHash = hash
    hook.updatedAt = Date.now()
    this.persist()
    return true
  }

  /**
   * 撤销批准（0.38.0）：清掉已批准的指纹 → 代码变回"待批准、不会运行"。
   * 代码本身保留，用户可随时再批准回来；不改变 enabled（批准语义与启用彻底分开）。
   */
  revoke(id        )          {
    this.load()
    const hook = this.hooks.find((item) => item.id === id)
    if (hook === undefined) return false
    if (hook.approvedHash === undefined) return false
    delete hook.approvedHash
    hook.updatedAt = Date.now()
    this.persist()
    return true
  }

  /** 测试用：绕过缓存重新读盘。 */
  reload()       {
    this.loaded = false
    this.load()
  }
}

// ---------------------------------------------------------------- 运行器

/**
 * 按时机运行一批钩子。
 *
 * - 顺序执行；任一 before-save 返回 ok:false 就**立即停止**（后面的钩子没必要跑）。
 * - 崩溃 / 超时只告警，不阻断（见文件头注释第 3 条）。
 */
export function runHooks(
  store           ,
  phase           ,
  input              ,
  settings              ,
  options                               = {},
)                {
  if (!settings.enabled) return []
  const out                = []
  for (const hook of store.forRun(
    phase,
    { scope: input.memory.scope, kind: input.memory.kind },
    settings,
    options.ignoreApproval === true,
  )) {
    const started = Date.now()
    const result = runHookCode(hook.code, phase, input, settings)
    const crashed = result.error !== undefined
    const outcome              = {
      hook: {
        id: hook.id,
        name: hook.name,
        phase,
        ...(hook.ruleId !== undefined ? { ruleId: hook.ruleId } : {}),
      },
      // 崩溃时 ok 恒 true —— 调用方据此"不阻断"。
      ok: crashed ? true : result.ok,
      durationMs: Date.now() - started,
      ...(result.message !== undefined ? { message: result.message } : {}),
      ...(result.content !== undefined ? { content: result.content } : {}),
      ...(result.drop === true ? { drop: true } : {}),
      ...(crashed ? { error: result.error } : {}),
      ...(result.logs.length > 0 ? { logs: result.logs.slice(0, 20) } : {}),
      ...(result.raw !== undefined ? { raw: result.raw } : {}),
    }
    try {
      store.recordRun(hook.id, {
        ok: outcome.ok,
        crashed,
        ...(outcome.message !== undefined ? { message: outcome.message } : {}),
      })
    } catch { /* 统计写失败不影响本次运行 */ }
    out.push(outcome)
    // before-save 的否决不需要再跑后续钩子：结论已经定了。
    if (phase === 'before-save' && !crashed && !result.ok) break
  }
  return out
}

/** 把一批结果折成给模型看的一段文字（没有内容时返回空串）。 */
export function describeOutcomes(outcomes                        )         {
  const lines           = []
  for (const outcome of outcomes) {
    if (outcome.error !== undefined) {
      lines.push(`⚠ 钩子「${outcome.hook.name}」运行失败（不影响结果）：${outcome.error}`)
      continue
    }
    if (!outcome.ok && outcome.message !== undefined) lines.push(outcome.message)
    else if (outcome.message !== undefined) lines.push(`钩子「${outcome.hook.name}」：${outcome.message}`)
  }
  return lines.join('\n')
}


//# sourceURL=source/memory-local/src/hooks.ts