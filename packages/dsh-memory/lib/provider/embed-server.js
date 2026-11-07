/**
 * Lifecycle manager for the local embedding backend (llama-server).
 *
 * Why: the provider degrades to lexical-only search whenever the embedding
 * backend is down, and a machine reboot silently leaves it down (observed
 * 2026-10-10 — the panel then shows 待嵌入>0 forever). The backend should live
 * exactly as long as the app does: spawned in the background on activation,
 * terminated when the plugin is disposed (which cordis does on quit).
 *
 * Rules:
 *  - opt-in: `enabled` defaults to false, so dev/test runs never spawn anything
 *  - an already-healthy endpoint is adopted instead of double-spawning; if we
 *    have a PID file for it, we also own it and will stop it on exit
 *  - every failure resolves to a state string; nothing here ever throws
 *
 * Dependency-injected (spawn/probe/fs/kill) so the whole lifecycle is testable
 * without starting a real model server.
 */
import { spawn as nodeSpawn,                   } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
                                              

                                    
                                                                                   
                   
                                             
              
                                          
                
                                                                               
              
                                                                                      
                  
                                                                                     
                  
                                          
                  
     
                                                        
                                                    
                                       
     
                    
                                                        
                     
                                          
               
                                                                    
               
                                          
                      
     
                                                         
                                               
                                   
     
                       
                                         
                    
                                                                         
                           
 

                                                                                                 

                                  
                         
                                                                  
                                                             
                                  
                             
                                
                                                       
                                      
 

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8078,
  threads: 6,
  /**
   * 默认 512 是 llama.cpp 的物理批次，单条 4000 字的记忆实测 2001 token，
   * 会被服务端 400 拒绝（input too large to process），而失败又被静默熔断，
   * 表现为「检索突然只剩词法」。给到 2048 正好覆盖单条上限；再大只是多占
   * 计算缓冲，对 embedding 没有收益。
   */
  batchSize: 2048,
  ubatchSize: 2048,
  startupTimeoutMs: 60_000,
}

async function defaultProbe(url        , timeoutMs        )                   {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok
  } catch {
    return false
  }
}

function defaultKill(pid        )       {
  try {
    process.kill(pid)
  } catch {
    // already gone, or not ours to kill
  }
}

export const defaultEmbedServerDeps                  = {
  spawn: nodeSpawn,
  probe: defaultProbe,
  kill: defaultKill,
  log: (message) => console.log(`[dsh-memory-local] ${message}`),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
}

export class EmbedServerManager {
          cfg                   
          deps                 
          child                      = null
          pid                = null
  /** True when this manager started (or adopted a PID-tracked) server. */
          owned = false
          stopping = false
  /** PID recorded by a previous run that we adopted. */
          adoptedPid                = null
  /** spawn 失败的原因（ENOENT/EACCES/端口占用…），用于让 ready 轮询立刻失败。 */
          lastError                = null

  constructor(cfg                    = {}, deps                           = {}) {
    this.cfg = cfg
    this.deps = { ...defaultEmbedServerDeps, ...deps }
  }

  get baseUrl()         {
    const host = this.cfg.host ?? DEFAULTS.host
    const port = this.cfg.port ?? DEFAULTS.port
    return `http://${host}:${port}`
  }

  get pidFile()                {
    if (this.cfg.pidFile) return this.cfg.pidFile
    if (this.cfg.logFile) return `${this.cfg.logFile}.pid`
    if (this.cfg.cwd) return join(this.cfg.cwd, 'llama-server.pid')
    if (this.cfg.exe) return join(dirname(this.cfg.exe), 'llama-server.pid')
    return null
  }

  get isOwned()          {
    return this.owned
  }

  /** Static lifecycle facts for a management UI (no network I/O). */
  info()                                                                            {
    return {
      enabled: this.cfg.enabled === true,
      owned: this.owned,
      pid: this.pid ?? this.adoptedPid,
      baseUrl: this.baseUrl,
    }
  }

  /** Probe the health endpoint right now. */
  async healthCheck(timeoutMs = 2000)                   {
    return this.deps.probe(`${this.baseUrl}/health`, timeoutMs)
  }

  /**
   * Start (or adopt) the backend. Never throws; resolves to what actually
   * happened so the caller can log it.
   */
  async ensureRunning()                            {
    if (!this.cfg.enabled) return 'disabled'
    if (!this.cfg.exe || !this.cfg.model) {
      this.deps.log('embed server: spawn.enabled 但缺少 exe/model,跳过自启')
      return 'failed'
    }
    // a manual restart must be possible after a manual stop
    this.stopping = false
    try {
      if (await this.deps.probe(`${this.baseUrl}/health`, 1500)) {
        const recorded = this.readPidFile()
        if (recorded && this.isAlive(recorded)) {
          // leftover from a previous run (or a crash) → adopt and own it
          this.adoptedPid = recorded
          this.pid = recorded
          this.owned = true
          this.deps.log(`embed server: 复用上轮实例 pid=${recorded}(${this.baseUrl}),退出时一并关闭`)
          return 'adopted-managed'
        }
        this.deps.log(`embed server: 复用外部实例(${this.baseUrl}),不接管生命周期`)
        return 'external'
      }
      return this.spawnServer()
    } catch (error) {
      this.deps.log(`embed server: 启动失败(已忽略): ${(error         )?.message ?? String(error)}`)
      return 'failed'
    }
  }

  /** Poll until the health endpoint answers or the budget runs out. */
  async waitUntilReady(timeoutMs         )                   {
    // spawn 已经失败（hasError 先于「没有子进程=外部实例」的快速路径判断）
    if (this.lastError !== null) {
      this.deps.log(`embed server: 启动失败：${this.lastError}`)
      return false
    }
    if (!this.owned && !this.child) return true
    const deadline = Date.now() + (timeoutMs ?? this.cfg.startupTimeoutMs ?? DEFAULTS.startupTimeoutMs)
    while (Date.now() < deadline) {
      if (await this.deps.probe(`${this.baseUrl}/health`, 1500)) return true
      // 子进程没了就别等到超时：spawn error（lastError）或已退出都立刻失败，
      // 让调用方马上把真实原因报出来。
      if (this.lastError !== null) {
        this.deps.log(`embed server: 启动失败：${this.lastError}`)
        return false
      }
      if (this.child === null || (this.child && this.child.exitCode !== null)) {
        if (this.lastError !== null) this.deps.log(`embed server: 启动失败：${this.lastError}`)
        return false
      }
      await this.deps.sleep(500)
    }
    return false
  }

  /**
   * Stop the backend if (and only if) this manager owns it.
   * @returns true when a process was actually signalled.
   */
  stop()          {
    if (!this.owned || this.stopping) return false
    this.stopping = true
    const pid = this.pid ?? this.adoptedPid
    let killed = false
    if (pid !== null) {
      this.deps.kill(pid)
      killed = true
      this.deps.log(`embed server: 已停止 pid=${pid}`)
    }
    this.child = null
    this.pid = null
    this.adoptedPid = null
    this.owned = false
    this.removePidFile()
    return killed
  }

          spawnServer()                   {
    this.lastError = null
    const host = this.cfg.host ?? DEFAULTS.host
    const port = this.cfg.port ?? DEFAULTS.port
    const pooling              = this.cfg.pooling ?? 'cls'
    const gpuLayers = this.cfg.gpuLayers ?? 0
    const extraArgs = this.cfg.extraArgs ?? []
    // 用户自己写了 -b/-ub 就以用户为准，避免同一参数出现两次。
    const hasBatch = extraArgs.some((a) => a === '-b' || a === '--batch-size')
    const hasUbatch = extraArgs.some((a) => a === '-ub' || a === '--ubatch-size')
    const args = [
      '-m', this.cfg.model          ,
      '--embeddings',
      // 池化跟着模型走;'auto' 不传,让 llama.cpp 用元数据里的值。
      ...(pooling === 'auto' ? [] : ['--pooling', pooling]),
      '--host', host,
      '--port', String(port),
      '-t', String(this.cfg.threads ?? DEFAULTS.threads),
      // 有显卡时把层卸载到显存;CPU 风味不传(等价于 0)。
      ...(gpuLayers > 0 ? ['-ngl', String(gpuLayers)] : []),
      ...(hasBatch ? [] : ['-b', String(this.cfg.batchSize ?? DEFAULTS.batchSize)]),
      ...(hasUbatch ? [] : ['-ub', String(this.cfg.ubatchSize ?? DEFAULTS.ubatchSize)]),
      ...extraArgs,
    ]
    const logFile = this.cfg.logFile
    if (logFile) {
      try { mkdirSync(dirname(logFile), { recursive: true }) } catch { /* best effort */ }
    }
    let out                    = 'ignore'
    if (logFile) {
      try { out = openSync(logFile, 'a') } catch { out = 'ignore' }
    }
    const child = this.deps.spawn(this.cfg.exe          , args, {
      cwd: this.cfg.cwd,
      windowsHide: true,
      detached: false,
      stdio: out === 'ignore' ? 'ignore' : ['ignore', out, out],
    })
    this.child = child
    this.owned = true
    this.pid = child.pid ?? null
    if (this.pid !== null) this.writePidFile(this.pid)
    if (logFile) {
      appendLogLine(logFile, `\n=== ${new Date().toISOString()} llama-server 由 DSH 启动 pid=${child.pid ?? '?'} args=${args.join(' ')}`)
    }
    const startedAt = Date.now()
    child.once('exit', (code, signal) => {
      if (!this.stopping) {
        const aliveMs = Date.now() - startedAt
        this.deps.log(`embed server: 进程已退出(code=${code ?? 'null'} signal=${signal ?? 'none'}，存活 ${aliveMs}ms)`)
        // 启动几秒就退出几乎一定是启动失败（缺 .so、端口被占、模型文件损坏…）。
        // 子进程的 stdout/stderr 都进了日志文件，这里把末尾几行带出来——否则
        // 主日志里只剩一句「进程已退出」，等于什么都没说（这正是 lib*.so.0
        // 缺失时最难查的地方）。
        if (aliveMs < 15_000) {
          const tail = readLogTail(logFile, 12)
          if (tail !== '') this.deps.log(`embed server: 启动失败详情（${logFile} 末尾）：\n${tail}`)
        }
      }
      this.child = null
      this.owned = false
      this.removePidFile()
    })
    child.once('error', (error) => {
      // spawn 失败（exe 不存在、无执行权限、glibc 解释器缺失）不会触发 exit，
      // 必须记下来，否则 ready 轮询会空转到 60s 超时，真实原因只留在 console。
      this.lastError = error.message
      this.deps.log(`embed server: 进程错误(已忽略): ${error.message}`)
      this.child = null
      this.owned = false
      this.removePidFile()
    })
    this.deps.log(`embed server: 已后台启动 pid=${child.pid ?? '?'}(${this.baseUrl})`)
    return 'spawned'
  }

          readPidFile()                {
    const file = this.pidFile
    if (!file || !existsSync(file)) return null
    try {
      const pid = Number.parseInt(readFileSync(file, 'utf8').trim(), 10)
      return Number.isFinite(pid) && pid > 0 ? pid : null
    } catch {
      return null
    }
  }

          writePidFile(pid        )       {
    const file = this.pidFile
    if (!file) return
    try { writeFileSync(file, String(pid), 'utf8') } catch { /* best effort */ }
  }

          removePidFile()       {
    const file = this.pidFile
    if (!file || !existsSync(file)) return
    try { rmSync(file, { force: true }) } catch { /* best effort */ }
  }

          isAlive(pid        )          {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
}

/** Append a line to a log file (used by callers that want their own tracing). */
export function appendLogLine(file        , line        )       {
  try { appendFileSync(file, `${line}\n`, 'utf8') } catch { /* best effort */ }
}

/**
 * 读日志文件末尾若干行（最多回读 16 KiB）。
 * 子进程秒退时用它把真正的死因带进主日志，避免只剩一句「进程已退出」。
 */
function readLogTail(file                    , maxLines        )         {
  if (!file) return ''
  let fd                = null
  try {
    fd = openSync(file, 'r')
    const size = statSync(file).size
    const start = Math.max(0, size - 16 * 1024)
    const buf = Buffer.alloc(size - start)
    if (buf.length > 0) readSync(fd, buf, 0, buf.length, start)
    const lines = buf.toString('utf8')
      .split('\n')
      .map((line) => line.replace(/\s+$/, ''))
      .filter((line) => line !== '')
    return lines.slice(-maxLines).join('\n')
  } catch {
    return ''
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* best effort */ }
    }
  }
}


//# sourceURL=source/memory-local/src/embed-server.ts