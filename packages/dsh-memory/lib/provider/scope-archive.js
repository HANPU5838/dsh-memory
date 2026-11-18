/**
 * 项目作用域的归档（0.32.0）。
 *
 * 0.30.0 已经实现了**会话作用域**的归档，但那是宿主生命周期驱动的：
 * 会话在侧边栏里被归档 → `workspaceRegistry.archivedSessionIds` 里有它 →
 * 记忆读写冻结，恢复会话后自动复原。项目作用域没有对应的宿主概念，
 * 所以这里给它一份自己的持久化。
 *
 * 产品口径（与需求一一对应）：
 *   - 只有 **session** 与 **project** 作用域可以归档；global / 自定义作用域不提供
 *     归档按钮（它们的生命周期不属于某个工作区，归档只会变成"悄悄藏起来"）；
 *   - 项目作用域**绑定工作区**：工作区从侧边栏删除时，归档记录转为 dormant
 *     （记忆仍然保留、仍然不参与检索），工作区重新加入时归档自动解除 ——
 *     也就是"删除时自动归档、重新加入时自动恢复"；
 *   - 归档不等于屏蔽：归档是用户层面的生命周期状态，没有审批路径，解除也无需审批；
 *     屏蔽是 Agent 主动降噪，两者在 UI 与拒绝原因上都分开。
 *
 * 文件：`<storeDir>/archive/project.json`，内容
 *   `{ version: 1, entries: ScopeArchiveEntry[], updatedAt }`
 *
 * 容错：读写失败一律退化为「没有归档」，绝不把异常抛回检索 / 注入链路。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { DEFAULT_CONFIG_FRESHNESS_TTL_MS, fileStamp } from './freshness.js'
import { join } from 'node:path'

export const SCOPE_ARCHIVE_VERSION = 1

/** 可归档的作用域类型（session 由宿主驱动，这里只持久化 project）。 */
                                                       

                                    
                                            
               
                 
                    
                              
                   
                        
               
     
                                    
                          
     
                   
 

                       
                  
                   
                     
 

function cleanEntry(raw         )                                {
  if (raw === null || typeof raw !== 'object') return undefined
  const item = raw                           
  const scope = typeof item.scope === 'string' ? item.scope.trim() : ''
  if (scope === '' || !scope.startsWith('project:')) return undefined
  const archivedAt = typeof item.archivedAt === 'number' && Number.isFinite(item.archivedAt) ? item.archivedAt : Date.now()
  const createdBy = typeof item.createdBy === 'string' && item.createdBy !== '' ? item.createdBy : 'user'
  const note = typeof item.note === 'string' && item.note.trim() !== '' ? item.note.trim() : undefined
  return {
    scope,
    kind: 'project',
    archivedAt,
    createdBy,
    ...(note !== undefined ? { note } : {}),
    ...(item.dormant === true ? { dormant: true } : {}),
  }
}

                                           
                                                  
              
                                  
 

export class ScopeArchiveStore {
                   dir        
                   file        
                   warn                           
  /** undefined = 还没读过盘。 */
          cache                                 
  /** 0.109.0：多进程下归档配置必须能感知别的进程写入。 */
                   refreshTtlMs        
          lastCheckAt = 0
          stamp = ''

  constructor(options                          ) {
    this.dir = join(options.root, 'archive')
    this.file = join(this.dir, 'project.json')
    this.warn = options.warn ?? ((message) => console.warn(message))
    this.refreshTtlMs = options.refreshTtlMs ?? DEFAULT_CONFIG_FRESHNESS_TTL_MS
  }

  /** 全部归档记录（拷贝）。 */
  list()                      {
    if (this.cache !== undefined) {
      const now = Date.now()
      if (this.refreshTtlMs <= 0 || now - this.lastCheckAt >= this.refreshTtlMs) {
        this.lastCheckAt = now
        if (fileStamp(this.file) === this.stamp) return this.cache.map((entry) => ({ ...entry }))
      } else {
        return this.cache.map((entry) => ({ ...entry }))
      }
    }
    let entries                      = []
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8'))               
        if (Array.isArray(parsed?.entries)) {
          for (const raw of parsed.entries) {
            const entry = cleanEntry(raw)
            if (entry === undefined) continue
            if (entries.some((existing) => existing.scope === entry.scope)) continue
            entries.push(entry)
          }
        }
      }
    } catch (error) {
      // 损坏的归档文件不能让检索挂掉：当成"没有归档"（记忆恢复可见是更安全的方向，
      // 用户能立刻看到并在面板里重新归档）。
      this.warn(`[dsh-memory-local] 忽略损坏的作用域归档 ${this.file}: ${error instanceof Error ? error.message : String(error)}`)
      entries = []
    }
    this.cache = entries
    this.stamp = fileStamp(this.file)
    return entries.map((entry) => ({ ...entry }))
  }

  get(scope        )                                {
    const key = typeof scope === 'string' ? scope.trim() : ''
    if (key === '') return undefined
    return this.list().find((entry) => entry.scope === key)
  }

  has(scope        )          {
    return this.get(scope) !== undefined
  }

  /** 归档一个项目作用域（幂等）。 */
  archive(scope        , by        , note         )                                {
    const key = typeof scope === 'string' ? scope.trim() : ''
    if (key === '' || !key.startsWith('project:')) return undefined
    const entries = this.list()
    const existing = entries.find((entry) => entry.scope === key)
    if (existing !== undefined) {
      // 重新归档时清掉 dormant：用户显式要求归档，就按"已归档"处理。
      if (existing.dormant !== true) return existing
      existing.dormant = undefined
      this.write(entries)
      return { ...existing }
    }
    const entry                    = {
      scope: key,
      kind: 'project',
      archivedAt: Date.now(),
      createdBy: typeof by === 'string' && by !== '' ? by : 'user',
      ...(note !== undefined && note.trim() !== '' ? { note: note.trim() } : {}),
    }
    entries.push(entry)
    this.write(entries)
    return { ...entry }
  }

  /** 解除归档；返回是否真的删掉了一条。 */
  restore(scope        )          {
    const key = typeof scope === 'string' ? scope.trim() : ''
    if (key === '') return false
    const entries = this.list()
    const next = entries.filter((entry) => entry.scope !== key)
    if (next.length === entries.length) return false
    this.write(next)
    return true
  }

  /**
   * 工作区存在性对账（0.32.0 的"删除自动归档 / 重新加入自动恢复"）：
   *   - 归档时工作区还在 → 正常归档；
   *   - 工作区被删掉 → 记录标 dormant（记忆继续隐藏，但归档状态可被复原）；
   *   - 工作区被重新加入（此前 dormant）→ **自动解除归档**，记忆立刻回到检索里。
   *
   * @param exists 判断项目作用域对应的工作区当前是否还在侧边栏里。
   * @returns 本次对账里被自动解除归档的作用域。
   */
  reconcile(exists                            )           {
    const entries = this.list()
    if (entries.length === 0) return []
    const restored           = []
    let changed = false
    const next                      = []
    for (const entry of entries) {
      let present = false
      try {
        present = exists(entry.scope) === true
      } catch {
        // 宿主服务不可用：保持现状，绝不在查询失败时改动用户的归档。
        next.push(entry)
        continue
      }
      if (!present) {
        if (entry.dormant !== true) {
          entry.dormant = true
          changed = true
        }
        next.push(entry)
        continue
      }
      if (entry.dormant === true) {
        // 工作区回来了：自动恢复。
        restored.push(entry.scope)
        changed = true
        continue
      }
      next.push(entry)
    }
    if (changed) this.write(next)
    return restored
  }

  /** 清掉缓存（下一次读盘）；测试 / 维护用。 */
  invalidate()       {
    this.cache = undefined
  }

          write(entries                     )       {
    this.cache = entries.map((entry) => ({ ...entry }))
    try {
      mkdirSync(this.dir, { recursive: true })
      const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`
      writeFileSync(tmp, `${JSON.stringify({
        version: SCOPE_ARCHIVE_VERSION,
        entries,
        updatedAt: Date.now(),
      }, null, 2)}\n`, 'utf8')
      renameSync(tmp, this.file)
      this.stamp = fileStamp(this.file)
      this.lastCheckAt = Date.now()
    } catch (error) {
      this.warn(`[dsh-memory-local] 无法写入作用域归档 ${this.file}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}


//# sourceURL=source/memory-local/src/scope-archive.ts