/**
 * 跨进程配置文件的「新鲜度」判定（0.109.0）。
 *
 * 可见域 / 屏蔽 / 归档是**配置类文件**，多个进程（面板、两个激活实例、CLI）
 * 共用一个 storeDir 时，进程内缓存必须能感知别的进程写入了新配置 —— 否则会出现
 * 「另一个进程加了 absolute 限制 / 屏蔽 / 归档，本进程仍按旧策略放行」的 fail-open。
 *
 * 判定 = mtimeMs + size 组成的 stamp；读取前按 ttl 节流 stat（默认 1s），
 * 变化则整份重读。与 MemoryStore.refreshFromDisk 的「磁盘为准」语义一致，
 * 但不影响热路径（每秒最多次 stat）。
 */
import { statSync } from 'node:fs'

export const DEFAULT_CONFIG_FRESHNESS_TTL_MS = 1000

/** 文件不存在返回 ''；每次变化都会改变返回值。 */
export function fileStamp(file        )         {
  try {
    const stat = statSync(file)
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return ''
  }
}

/**
 * 节流后的「文件是否变了」判断。
 *
 * 用法：读取前调用 `changed(file)`；返回 true 就重新读盘并更新缓存，
 * 返回 false 就用缓存。内部按 ttl 节流（ttl=0 表示每次都 stat）。
 */
export class FreshnessGate {
          lastCheck = 0
          lastStamp = ''
                   ttlMs        

  constructor(ttlMs         = DEFAULT_CONFIG_FRESHNESS_TTL_MS) {
    this.ttlMs = ttlMs
  }

  changed(file        )          {
    const now = Date.now()
    if (this.ttlMs > 0 && now - this.lastCheck < this.ttlMs) return false
    this.lastCheck = now
    const next = fileStamp(file)
    if (next === this.lastStamp) return false
    this.lastStamp = next
    return true
  }

  /** 本进程刚写完文件后调用，避免下一次读误判为“外部变化”。 */
  sync(file        )       {
    this.lastStamp = fileStamp(file)
    this.lastCheck = Date.now()
  }
}


//# sourceURL=source/memory-local/src/freshness.ts