/**
 * 会话级「记忆可见范围」的持久化。
 *
 * 位置:`<storeDir>/visibility/<session>.json`(与记忆数据同目录,便于一起备份/清理)。
 *
 * 为什么放在 provider 而不是注入半边:
 *   resolveReadScopes / memory_search / memory_get 都以 provider 为**唯一口径**;
 *   如果把覆盖范围放在注入半边,工具与注入就会各读一份,模型能看到的范围页面
 *   和工具实际能读到的范围可能不一致。provider 落盘、注入与工具都通过它解析。
 *
 * 为什么一个会话一个文件,而不是一个 JSON map:
 *   同一个 storeDir 可能被多个进程共用(见 store.ts 的 issue #3)。单文件 map 在并发
 *   写入时会互相覆盖;按会话分文件后,一个会话的写入不影响另一个会话。
 *
 * 语义(0.19.0 起):
 *   - 文件存在 = 该会话显式指定了可见域;`level` 决定范围外访问怎么处理:
 *       absolute = 一律查不到;normal = 范围外命中时向用户发起一次审批;
 *       none = 不限制(选择仅作为下次切换的偏好保留)。
 *   - 文件不存在 = 没有覆盖,继续用默认的三路集合(会话 + 项目 + global);
 *   - scopes 为空数组视为"无覆盖"(面板在保存时也会拒绝空选择),不会把会话锁死。
 *   - 每个 scope 可以带 `read` / `write`:该作用域在本会话里是否可读 / 可写。
 *     省略 = 都可(向后兼容);`read:false` 的作用域不会进入读取集合,`write:false`
 *     的作用域写入 / 删除会被拒绝(工具会把真实原因告诉 Agent)。
 *   - 每个 scope 仍可带旧的 `kinds`(0.19.1 起 provider 忽略,只为兼容旧文件)。
 *
 * 向后兼容:0.18.x 的 v1 文件只有 `scopes: string[]`,按"绝对限制 + 全部类型"读取;
 * 这样升级当天不会把原来被锁住的范围突然放开。
 *
 * 容错:读写失败都只退化为"没有覆盖",绝不把异常抛回检索/注入链路。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { DEFAULT_CONFIG_FRESHNESS_TTL_MS, fileStamp } from './freshness.js'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

export const VISIBILITY_VERSION = 3

/** 范围外访问的处理方式。 */
                                                            

export const VISIBILITY_LEVELS                             = ['absolute', 'normal', 'none']

/** 一个可见作用域;`read` / `write` 省略 = 都可;`kinds` 省略/为空 = 所有类型。 */
                                 
               
                                       
                
                                      
                 
                  
 

/** 一个会话的完整可见域配置。 */
                                          
                          
                        
 

                                                
                                                     
              
                                  
 

                            
                  
                  
                 
                     
 

/** 会话 id 通常已经是 UUID;异常字符换成 `_`,改写过的再加 8 位 hash 防碰撞。 */
function safeName(sessionId        )         {
  const cleaned = sessionId.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80)
  if (cleaned === sessionId && cleaned !== '') return cleaned
  const base = cleaned === '' ? 'session' : cleaned.slice(0, 64)
  return `${base}-${createHash('sha1').update(sessionId).digest('hex').slice(0, 8)}`
}

/** 只保留非空字符串并去重(顺序即用户勾选顺序);空数组返回 undefined。 */
function cleanStrings(raw         )                       {
  if (!Array.isArray(raw)) return undefined
  const out           = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const value = item.trim()
    if (value === '' || out.includes(value)) continue
    out.push(value)
  }
  return out.length > 0 ? out : undefined
}

function cleanLevel(raw         , fallback                  = 'absolute')                  {
  return raw === 'absolute' || raw === 'normal' || raw === 'none' ? raw : fallback
}

/**
 * 规范化 scopes 字段。接受两种形状:
 *   - v2: `[{ scope, kinds? }]`
 *   - v1:  `['project:<path>', 'global']`
 * 非法项跳过;返回 undefined 表示没有任何有效范围。
 */
export function cleanVisibilityRules(raw         )                               {
  if (!Array.isArray(raw)) return undefined
  const out                   = []
  for (const item of raw) {
    if (typeof item === 'string') {
      const scope = item.trim()
      if (scope !== '' && !out.some((rule) => rule.scope === scope)) out.push({ scope })
      continue
    }
    if (item === null || typeof item !== 'object') continue
    const scopeRaw = (item                       ).scope
    if (typeof scopeRaw !== 'string') continue
    const scope = scopeRaw.trim()
    if (scope === '' || out.some((rule) => rule.scope === scope)) continue
    const rule                 = { scope }
    // 只落"false"这两档:省略 = 默认可读可写,旧文件因此不需要迁移。
    if ((item                      ).read === false) rule.read = false
    if ((item                       ).write === false) rule.write = false
    const kinds = cleanStrings((item                       ).kinds)
    if (kinds !== undefined) rule.kinds = kinds
    out.push(rule)
  }
  return out.length > 0 ? out : undefined
}

/** 读盘结果统一成不可变配置(拷贝一层数组,避免调用方改到缓存)。 */
function cloneConfig(config                         )                          {
  return {
    level: config.level,
    scopes: config.scopes.map((rule) => ({
      scope: rule.scope,
      ...(rule.read === false ? { read: false } : {}),
      ...(rule.write === false ? { write: false } : {}),
      ...(rule.kinds === undefined ? {} : { kinds: [...rule.kinds] }),
    })),
  }
}

export class SessionVisibilityStore {
                   dir        
                   warn                           
  /** sessionId -> 显式配置 + 文件 stamp;null = 已确认没有文件。 */
                   cache = new Map                                                                                      ()
  /** 0.109.0：多进程下配置必须能感知别的进程写入（ttl 节流 stat）。 */
                   refreshTtlMs        
          lastCheckAt = 0

  constructor(options                               ) {
    this.dir = join(options.root, 'visibility')
    this.warn = options.warn ?? ((message) => console.warn(message))
    this.refreshTtlMs = options.refreshTtlMs ?? DEFAULT_CONFIG_FRESHNESS_TTL_MS
  }

          fileOf(sessionId        )         {
    return join(this.dir, `${safeName(sessionId)}.json`)
  }

  /** 显式可见域;undefined = 没有覆盖(用默认集合)。 */
  get(sessionId        )                                      {
    if (sessionId === '') return undefined
    const file = this.fileOf(sessionId)
    const cached = this.cache.get(sessionId)
    if (cached !== undefined) {
      // 节流：最多每 ttl 秒 stat 一次；stamp 变化说明别的进程改过这份配置。
      const now = Date.now()
      if (this.refreshTtlMs <= 0 || now - this.lastCheckAt >= this.refreshTtlMs) {
        this.lastCheckAt = now
        if (fileStamp(file) === cached.stamp) return cached.config === null ? undefined : cloneConfig(cached.config)
      } else {
        return cached.config === null ? undefined : cloneConfig(cached.config)
      }
    }
    let config                                     
    try {
      if (existsSync(file)) {
        const parsed = JSON.parse(readFileSync(file, 'utf8'))                    
        const rules = cleanVisibilityRules(parsed?.scopes)
        if (rules !== undefined) {
          // v1 没有 level:沿用旧的"白名单"语义(绝对限制),避免升级把范围放开。
          config = { scopes: rules, level: cleanLevel(parsed?.level, 'absolute') }
        }
      }
    } catch (error) {
      // 损坏文件不应该让会话失去默认可见范围;只告警一次(缓存 null)。
      this.warn(`[dsh-memory-local] 忽略损坏的会话可见范围 ${this.fileOf(sessionId)}: ${error instanceof Error ? error.message : String(error)}`)
      config = undefined
    }
    this.cache.set(sessionId, { config: config ?? null, stamp: fileStamp(file), checkedAt: Date.now() })
    return config === undefined ? undefined : cloneConfig(config)
  }

  /** 写入/清除显式配置。null 或空 scopes = 清除(恢复默认)。返回写入后的值。 */
  set(sessionId        , config                                )                                 {
    if (sessionId === '') return null
    const scopes = config === null ? undefined : cleanVisibilityRules(config.scopes)
    if (config === null || scopes === undefined) {
      try {
        const file = this.fileOf(sessionId)
        rmSync(file, { force: true })
        this.cache.set(sessionId, { config: null, stamp: fileStamp(file), checkedAt: Date.now() })
        return null
      } catch (error) {
        this.warn(`[dsh-memory-local] 无法清除会话可见范围 ${this.fileOf(sessionId)}: ${error instanceof Error ? error.message : String(error)}`)
        return this.cache.get(sessionId)?.config ?? null
      }
    }
    const cleaned                          = { scopes, level: cleanLevel(config.level, 'normal') }
    try {
      const file = this.fileOf(sessionId)
      mkdirSync(this.dir, { recursive: true })
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
      writeFileSync(tmp, `${JSON.stringify({
        version: VISIBILITY_VERSION,
        scopes: cleaned.scopes,
        level: cleaned.level,
        updatedAt: Date.now(),
      }, null, 2)}\n`, 'utf8')
      renameSync(tmp, file)
      this.cache.set(sessionId, { config: cloneConfig(cleaned), stamp: fileStamp(file), checkedAt: Date.now() })
      return cloneConfig(cleaned)
    } catch (error) {
      // 写盘失败:内存里的旧值不清空,但也不能假装成功。调用方会看到旧值。
      this.warn(`[dsh-memory-local] 无法写入会话可见范围 ${this.fileOf(sessionId)}: ${error instanceof Error ? error.message : String(error)}`)
      const previous = this.cache.get(sessionId)?.config ?? null
      return previous === null ? null : cloneConfig(previous)
    }
  }

  /** 把缓存里这个会话的值清掉(下一次 get 重新读盘);维护/测试用。 */
  invalidate(sessionId        )       {
    this.cache.delete(sessionId)
  }
}


//# sourceURL=source/memory-local/src/session-visibility.ts