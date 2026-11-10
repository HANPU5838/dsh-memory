/**
 * 生命周期（cognitive/lifecycle）—— 记忆的"休眠 / 软删 / 快照"三件事。
 *
 * 设计原则：**任何一步都不物理丢数据**，直到保留窗口走完：
 *   dormant   低价值旧记忆打标休眠（注入/摘要跳过，检索命中可唤醒）；
 *   tombstone forget 改成软删，保留 30 天可 restore，到期 purge 才真删；
 *   snapshot  gzip JSONL 导出/导入，可按 scope 指定，向量不带（导入后重新嵌入）。
 *
 * 这些函数直接改 store 的内存增量（ScopeStore.insert / remove），落盘交给调用方
 * 的 store.flush() / store.close()；测试里显式 flush 后再开一个新 store 验证持久化。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { Buffer } from 'node:buffer'
import { dirname } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import {
  contentHash,
  isDormantRecord,
  isTombstonedRecord,
                       
                    
                   
  MemoryStore,
} from '../store.js'

const DAY_MS = 86_400_000

/** dormant 判定：多久没被访问就算旧。 */
export const DORMANT_AFTER_DAYS = 30
/** dormant 判定：importance 低于它才算"低价值"（高于它的旧记忆不该被藏起来）。 */
export const DORMANT_MAX_IMPORTANCE = 0.3
/** tombstone 保留窗口：forget 后多少天内可 restore。 */
export const TOMBSTONE_RETENTION_DAYS = 30
/** 快照格式版本（写入 meta 行，读取时高于当前版本直接拒绝）。 */
export const SNAPSHOT_SCHEMA = 1

// ---------------------------------------------------------------- 通用判定

/**
 * 注入/摘要/检索是否应该跳过这条记录（tombstone 软删 / dormant 休眠）。
 * 老记录两个标记都没有 → 永不跳过，行为与之前完全一致。
 */
export function shouldSkipRecord(
  record              ,
  options                                                            = {},
)          {
  if (options.includeTombstoned !== true && isTombstonedRecord(record)) return true
  if (options.includeDormant !== true && isDormantRecord(record)) return true
  return false
}

/** 记录最近一次"被看见"的时间（访问 / 恢复），dormant 判定按它算年龄。 */
function lastSeenAt(record              )         {
  const cognitive = record                   
  // 0.33.2：取用（memory_get）也算"被看见" —— 否则一条天天被取用、但没被检索命中的
  // 记忆会被误判休眠（检索命中更新 lastAccessedAt，取用更新 lastUsedAt，两者都要看）。
  return Math.max(
    record.lastAccessedAt,
    typeof cognitive.restoredAt === 'number' ? cognitive.restoredAt : 0,
    typeof cognitive.lastUsedAt === 'number' ? cognitive.lastUsedAt : 0,
  )
}

// ---------------------------------------------------------------- dormant 休眠

                                 
                                           
                    
                                                      
                        
                              
                        
                                 
              
 

                                
                         
                  
                       
                 
 

/** 哪些 scope 参与本次操作：显式列表走 peek（不创建），否则全部已加载 scope。 */
function targetStores(store             , scopes                )                                       {
  if (scopes === undefined) return store.allScopes()
  const out                                       = []
  for (const scope of scopes) {
    const found = store.peek(scope)
    if (found !== undefined) out.push(found)
  }
  return out
}

/**
 * 给"N 天未访问且 importance 低"的记录打 dormant 标记。
 * 只加标记，不删不改内容；重复调用幂等（已休眠的跳过）。
 */
export function markDormant(store             , options                 = {})                {
  const now = options.now ?? Date.now()
  const afterDays = Math.max(0, options.afterDays ?? DORMANT_AFTER_DAYS)
  const maxImportance = options.maxImportance ?? DORMANT_MAX_IMPORTANCE
  const marked           = []
  let scanned = 0
  for (const scopeStore of targetStores(store, options.scopes)) {
    for (const record of [...scopeStore.records.values()]) {
      scanned++
      if (isTombstonedRecord(record) || isDormantRecord(record)) continue
      if (record.importance > maxImportance) continue
      if (now - lastSeenAt(record) < afterDays * DAY_MS) continue
      scopeStore.insert({ ...record, dormantAt: now }                   )
      marked.push(record.id)
    }
  }
  return { marked, scanned }
}

                               
             
                          
                                                     
 

/**
 * 唤醒一条休眠记录（检索命中 / 用户查看时调用）：清 dormantAt、刷新访问时间。
 * tombstone 软删的记录不走这里 —— 恢复必须显式 restore()，避免"被检索唤醒"绕过 forget。
 */
export function revive(store             , id        , options                   = {})               {
  const located = store.scopeOf(id)
  if (located === undefined) return { ok: false, reason: 'not-found' }
  const record = located.record                   
  if (isTombstonedRecord(record)) return { ok: false, reason: 'tombstoned' }
  if (!isDormantRecord(record)) return { ok: false, reason: 'not-dormant' }
  const now = options.now ?? Date.now()
  const next                  = { ...record, lastAccessedAt: now, restoredAt: now }
  delete next.dormantAt
  located.store.insert(next)
  return { ok: true, record: next }
}

// ---------------------------------------------------------------- tombstone 软删

                                   
                                                
               
                                
                 
                                 
              
 

                                  
             
                          
                                             
 

/**
 * forget 的软删：留下记录、打 tombstonedAt + tombstoneExpiresAt 标记。
 * 记录仍在 scope 里（所以 restore 拿得到），检索/注入由 shouldSkipRecord() 跳过。
 * 幂等：已经软删过的不重复打标（返回 already-tombstoned）。
 */
export function tombstone(store             , id        , options                   = {})                  {
  const located = store.scopeOf(id)
  if (located === undefined) return { ok: false, reason: 'not-found' }
  const record = located.record                   
  if (isTombstonedRecord(record)) return { ok: true, record, reason: 'already-tombstoned' }
  const now = options.now ?? Date.now()
  const days = Math.max(0, options.days ?? TOMBSTONE_RETENTION_DAYS)
  const next                  = {
    ...record,
    tombstonedAt: now,
    tombstoneExpiresAt: now + days * DAY_MS,
  }
  if (options.reason !== undefined) {
    ;(next                                                  ).tombstoneReason = String(options.reason)
  }
  located.store.insert(next)
  return { ok: true, record: next }
}

                                 
                                 
              
                                      
                 
 

                                
             
                          
                                                                    
 

/**
 * 撤销软删。默认拒绝三种情况：
 *   expired     过了保留窗口（该 purge 了，不能复活）
 *   superseded  已有活动版本取代了它（同时恢复会出现两个活动版本）
 * force 可越过后两者检查（expired 也允许 force 恢复，恢复后清掉过期标记）。
 */
export function restore(store             , id        , options                 = {})                {
  const located = store.scopeOf(id)
  if (located === undefined) return { ok: false, reason: 'not-found' }
  const record = located.record                   
  if (!isTombstonedRecord(record)) return { ok: false, reason: 'not-tombstoned' }
  const now = options.now ?? Date.now()
  if (options.force !== true) {
    const expiresAt = record.tombstoneExpiresAt
    if (typeof expiresAt === 'number' && expiresAt <= now) return { ok: false, reason: 'expired' }
    for (const other of located.store.records.values()) {
      if (other.id === id) continue
      if (other.supersedes === id && !isTombstonedRecord(other)) return { ok: false, reason: 'superseded' }
    }
  }
  const next                  = { ...record, restoredAt: now }
  // 恢复 = 重新可见：软删标记清掉；如果是被强行复活的过期记录，一并清掉保留窗口。
  delete next.tombstonedAt
  delete next.tombstoneExpiresAt
  located.store.insert(next)
  return { ok: true, record: next }
}

                                         
                                 
              
                              
                        
                             
                 
 

/**
 * 物理删除过了保留窗口的 tombstone 记录，返回被删的 id。
 * 这是唯一一处"真删"：调用方通常是周期维护（与 purgeExpired 同一个调度点）。
 */
export function purgeTombstones(store             , options                         = {})           {
  const now = options.now ?? Date.now()
  const removed           = []
  for (const scopeStore of targetStores(store, options.scopes)) {
    for (const record of [...scopeStore.records.values()]) {
      const cognitive = record                   
      if (!isTombstonedRecord(record)) continue
      const expiresAt = cognitive.tombstoneExpiresAt
      const expired = typeof expiresAt === 'number' && expiresAt <= now
      if (options.force !== true && !expired) continue
      if (scopeStore.remove(record.id)) removed.push(record.id)
    }
  }
  return removed
}

// ---------------------------------------------------------------- snapshot 快照

                                  
                                           
                        
                                                 
                             
                         
                
                                 
              
 

                                 
              
                             
                       
                 
               
                  
 

/** 快照 meta 行（第一行）。 */
                        
                     
                   
                       
                 
 

/** 快照默认范围：已加载的内存 scope ∪ 磁盘上发现的作用域（并集，避免漏掉刚写还没落盘的）。 */
function snapshotScopes(store             )                {
  const seen = new Set             ()
  const out                = []
  for (const scopeStore of store.allScopes()) {
    if (seen.has(scopeStore.scope)) continue
    seen.add(scopeStore.scope)
    out.push(scopeStore.scope)
  }
  for (const scope of store.loadDiscovered()) {
    if (seen.has(scope)) continue
    seen.add(scope)
    out.push(scope)
  }
  return out
}

/**
 * 导出快照：gzip JSONL，第一行 meta，之后每行一条记录（原样 JSON，不带向量）。
 *
 * 向量刻意不导出：嵌入模型/维度/池化方式随时会换，带过去大概率是错的；导入后由
 * 嵌入层按当前模型重算（与文本导出 memory_export 同口径）。
 */
export function snapshot(store             , file        , options                  = {})                 {
  const now = options.now ?? Date.now()
  const gzipped = options.gzip !== false
  const scopes = options.scopes ?? snapshotScopes(store)
  const recordLines           = []
  const usedScopes                = []
  for (const scope of scopes) {
    const scopeStore = store.peek(scope)
    if (scopeStore === undefined) continue
    let count = 0
    for (const record of scopeStore.records.values()) {
      if (options.includeTombstoned !== true && isTombstonedRecord(record)) continue
      recordLines.push(JSON.stringify(record))
      count++
    }
    if (count > 0) usedScopes.push(scope)
  }
  const meta               = {
    '#snapshot': SNAPSHOT_SCHEMA,
    createdAt: now,
    scopes: usedScopes,
    records: recordLines.length,
  }
  const text = `${[JSON.stringify(meta), ...recordLines].join('\n')}\n`
  const payload = gzipped ? gzipSync(Buffer.from(text, 'utf8')) : Buffer.from(text, 'utf8')
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${now}.tmp`
  writeFileSync(tmp, payload)
  renameSync(tmp, file)
  return { file, scopes: usedScopes, records: recordLines.length, bytes: payload.byteLength, gzipped }
}

                                         
                                               
                           
                                             
                     
                                             
                  
 

                                        
                  
                 
                       
 

/** 判定 payload 是不是 gzip（魔数 1f 8b），兼容手工解压后的纯 JSONL。 */
function looksGzipped(raw        )          {
  return raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b
}

/**
 * 导入快照。逐行解析、坏行计数跳过而不是整体失败；gzip 魔数自动识别。
 *
 * 合并语义（不做物理替换）：
 *   - 记录 id 已存在：overwrite=true 覆盖，否则跳过；
 *   - 同作用域内已有归一化内容相同的记录：dedupe=true（默认）跳过；
 *   - 其余按原 id / createdAt / 认知层字段原样插入（谱系、休眠、冲突标记都保留）。
 */
export function restoreSnapshot(
  store             ,
  file        ,
  options                         = {},
)                        {
  const raw = readFileSync(file)
  const text = (looksGzipped(raw) ? gunzipSync(raw) : raw).toString('utf8')
  const result                        = { imported: 0, skipped: 0, scopes: [] }
  const usedScopes = new Set             ()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed         
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      result.skipped++
      continue
    }
    if (parsed === null || typeof parsed !== 'object') {
      result.skipped++
      continue
    }
    const obj = parsed                           
    // meta 行
    if (typeof obj['#snapshot'] === 'number') {
      const version = obj['#snapshot']
      if (version > SNAPSHOT_SCHEMA) {
        throw new Error(`snapshot schema ${String(version)} 高于当前支持的 ${SNAPSHOT_SCHEMA}（请升级后再导入）`)
      }
      continue
    }
    // 记录行
    if (typeof obj.id !== 'string' || obj.id === '' || typeof obj.content !== 'string' || typeof obj.scope !== 'string' || obj.scope === '') {
      result.skipped++
      continue
    }
    const record = obj                           
    const scope = options.targetScope ?? record.scope
    const scopeStore = store.scope(scope) // 导入路径:缺的 scope 需要建出来
    if (record.id !== '' && scopeStore.records.has(record.id)) {
      if (options.overwrite !== true) {
        result.skipped++
        continue
      }
    }
    if (options.dedupe !== false) {
      const hash = contentHash(scope, record.content)
      let duplicate = false
      for (const existing of scopeStore.records.values()) {
        if (existing.id === record.id) continue
        if (contentHash(existing.scope, existing.content) === hash) {
          duplicate = true
          break
        }
      }
      if (duplicate) {
        result.skipped++
        continue
      }
    }
    scopeStore.insert({ ...record, scope }                   )
    result.imported++
    usedScopes.add(scope)
  }
  result.scopes = [...usedScopes]
  return result
}



//# sourceURL=source/memory-local/src/cognitive/lifecycle.ts