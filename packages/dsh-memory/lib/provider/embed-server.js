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
 *  - Android/Termux: the downloaded llama-server is an ubuntu-arm64 glibc ELF
 *    whose PT_INTERP (`/lib/ld-linux-aarch64.so.1`) does not exist on Android.
 *    Auto-wrap the launch through Termux's glibc loader (see `glibcWrap`).
 *  - a child that dies without us asking for it is restarted (1s/5s/30s, max 3)
 *    so a transient crash does not silently degrade retrieval to lexical-only.
 *  - Linux: a PID from the pid file is only trusted (for adopt/kill) when
 *    /proc/<pid>/cmdline still looks like llama-server (PID reuse protection).
 *
 * Dependency-injected (spawn/probe/fs/elf/netproc/kill) so the whole lifecycle
 * is testable without starting a real model server or touching real /proc.
 */
import { spawn as nodeSpawn,                                      } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { basename, dirname, join } from 'node:path'
                                              

                                    
                                                                                   
                   
                                             
              
                                          
                
                                                                               
              
                                                                                      
                  
                                                                                     
                  
                                          
                  
     
                                                        
                                                    
                                       
     
                    
                                                        
                     
                                          
               
                                                                    
               
                                          
                      
     
                                                         
                                               
                                   
     
                       
                                         
                    
     
                                                                
                                                                      
                                                     
                                                                      
                                  
                                                     
                                               
                  
                                             
     
                                             
                                                                         
                           
 

                                                                                                 

                                  
                         
                                                                  
                                                             
                                  
                             
                                
                                                       
                                      
                                                  
                                       
                                                             
                                                   
                                                     
                                                                                
                                                                 
                                                 
                                                            
                           
                                                     
                
 

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

/** Android/Termux 的默认前缀(真机上总是由 $PREFIX 覆盖)。 */
const DEFAULT_TERMUX_PREFIX = '/data/data/com.termux/files/usr'

/** 自愈退避:1s / 5s / 30s,最多 3 次。 */
const RESTART_BACKOFF_MS = [1_000, 5_000, 30_000]

/** 存活超过这个时长再崩,视为「稳定运行过」,重置自愈计数。 */
const STABLE_RUN_MS = 60_000

/** spawn 前端口探测的超时(端口在 listen 时 connect 会立即成功)。 */
const PORT_PROBE_TIMEOUT_MS = 400

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

function defaultFileExists(path        )          {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

function defaultReadProcCmdline(pid        )                {
  try {
    // /proc/<pid>/cmdline 是用 \0 分隔的 argv;只要判断里面有没有 llama-server。
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8')
  } catch {
    return null
  }
}

/**
 * 只读 ELF header(前 64 字节)+ program headers 找 PT_INTERP(type=3) 的
 * 文件路径 —— 不需要完整 ELF 解析,也不加载目标程序。
 * 非 ELF / 静态链接(无 PT_INTERP)/ 读取失败都返回 null。
 */
export function readElfInterpFromFile(exePath        )                {
  let fd                = null
  try {
    fd = openSync(exePath, 'r')
    const header = Buffer.alloc(64)
    const headerLen = readSync(fd, header, 0, 64, 0)
    if (headerLen < 52) return null
    if (header[0] !== 0x7f || header[1] !== 0x45 || header[2] !== 0x4c || header[3] !== 0x46) return null
    const is64 = header[4] === 2
    if (is64 && headerLen < 64) return null
    const phoff = is64 ? Number(header.readBigUInt64LE(32)) : header.readUInt32LE(28)
    const phentsize = is64 ? header.readUInt16LE(54) : header.readUInt16LE(42)
    const phnum = is64 ? header.readUInt16LE(56) : header.readUInt16LE(44)
    if (phoff <= 0 || phentsize < (is64 ? 56 : 32) || phnum === 0 || phnum > 4096) return null
    const ph = Buffer.alloc(phentsize)
    for (let i = 0; i < phnum; i += 1) {
      if (readSync(fd, ph, 0, phentsize, phoff + i * phentsize) < phentsize) continue
      if (ph.readUInt32LE(0) !== 3) continue // PT_INTERP
      const offset = is64 ? Number(ph.readBigUInt64LE(8)) : ph.readUInt32LE(4)
      const size = is64 ? Number(ph.readBigUInt64LE(32)) : ph.readUInt32LE(16)
      if (size <= 0 || size > 4096) return null
      const interp = Buffer.alloc(size)
      if (readSync(fd, interp, 0, size, offset) <= 0) return null
      const text = interp.toString('utf8').replace(/\0+$/, '').trim()
      return text === '' ? null : text
    }
    return null
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* best effort */ }
    }
  }
}

/**
 * 端口是否已被监听:connect 成功 = 有人占着;ECONNREFUSED/超时 = 空闲。
 * 只用于 spawn 前预检,任何异常都按「空闲」处理(不能因为探测失败就不启动)。
 */
function defaultPortInUse(host        , port        , timeoutMs        )                   {
  return new Promise((resolve) => {
    let settled = false
    const socket = createConnection({ host, port })
    const finish = (inUse         )       => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch { /* best effort */ }
      resolve(inUse)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

export const defaultEmbedServerDeps                  = {
  spawn: nodeSpawn,
  probe: defaultProbe,
  kill: defaultKill,
  log: (message) => console.log(`[dsh-memory-local] ${message}`),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  fileExists: defaultFileExists,
  readElfInterp: readElfInterpFromFile,
  portInUse: defaultPortInUse,
  readProcCmdline: defaultReadProcCmdline,
  platform: process.platform,
  prefix: process.env.PREFIX || DEFAULT_TERMUX_PREFIX,
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
  /** spawn/启动失败的原因（ENOENT/EACCES/端口占用/loader 缺失…）。 */
          lastErrorText                = null
  /** 已执行的自愈重拉次数(手动 start/stop 归零)。 */
          restartAttempts = 0
  /** 每次手动 start/stop 自增,用来作废在途的退避循环。 */
          restartSeq = 0
  /** true while the self-heal backoff loop is running. */
          restartLoopActive = false
  /** true while a spawn is in flight(端口预检是异步的,别并发拉起两个子进程)。 */
          starting = false
  /** 最近一次解析出的启动方式(看是否走了 glibc 包装)。 */
          lastLaunchPlan                    = null

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

  /**
   * 最近一次启动失败的原因;启动成功后归 null。
   * 自愈耗尽(连续 3 次重拉失败)时这里会是一条可读的说明。
   */
  get lastError()                {
    return this.lastErrorText
  }

  /** 本次手动 start 以来执行过的自愈重拉次数(0..3)。 */
  get restarts()         {
    return this.restartAttempts
  }

  /**
   * 后端当前是否不可用:最近一次启动/自愈失败且没有成功拉起子进程。
   * 面板可以据此把「检索走词法降级」的原因显示出来。
   */
  get unavailable()          {
    return this.lastErrorText !== null
  }

  /** 最近一次解析出的启动命令(含 glibc 包装信息);未启动过 → null。 */
  get launch()                    {
    return this.lastLaunchPlan === null ? null : { ...this.lastLaunchPlan, args: [...this.lastLaunchPlan.args] }
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
    // 手动 start:作废在途的自愈重拉,并清掉上一次的失败状态,
    // 否则「手动 stop 后手动 start」会被旧计数/旧 lastError 卡住。
    this.stopping = false
    this.restartSeq += 1
    this.restartAttempts = 0
    this.lastErrorText = null
    try {
      if (await this.deps.probe(`${this.baseUrl}/health`, 1500)) {
        const recorded = this.readPidFile()
        if (recorded !== null && this.isAlive(recorded)) {
          // leftover from a previous run (or a crash) → adopt and own it
          this.adoptedPid = recorded
          this.pid = recorded
          this.owned = true
          this.deps.log(`embed server: 复用上轮实例 pid=${recorded}（${this.baseUrl}）,退出时一并关闭`)
          return 'adopted-managed'
        }
        if (recorded !== null) {
          // pid 文件还在,但那个 pid 已经不是 llama-server(崩溃后 PID 被复用)
          // 或已经退出 —— 不接管、更不能杀,顺手清掉陈旧记录。
          this.deps.log(`embed server: pid 文件里的 ${recorded} 不是本机的 llama-server(PID 复用或已退出),不接管,清理陈旧 pid 文件`)
          this.removePidFile()
        }
        this.deps.log(`embed server: 复用外部实例(${this.baseUrl}),不接管生命周期`)
        return 'external'
      }
      return await this.spawnServer()
    } catch (error) {
      this.deps.log(`embed server: 启动失败(已忽略): ${(error         )?.message ?? String(error)}`)
      return 'failed'
    }
  }

  /** Poll until the health endpoint answers or the budget runs out. */
  async waitUntilReady(timeoutMs         )                   {
    // spawn 已经失败（hasError 先于「没有子进程=外部实例」的快速路径判断）
    if (this.lastErrorText !== null) {
      this.deps.log(`embed server: 启动失败：${this.lastErrorText}`)
      return false
    }
    if (this.stopping) return false
    // 自愈重拉中:别把「没有子进程」当成「外部实例已就绪」,继续等重拉结果。
    const healInProgress = ()          => this.restartLoopActive || this.restartAttempts > 0
    if (!this.owned && !this.child && !healInProgress()) return true
    const deadline = Date.now() + (timeoutMs ?? this.cfg.startupTimeoutMs ?? DEFAULTS.startupTimeoutMs)
    while (Date.now() < deadline) {
      if (await this.deps.probe(`${this.baseUrl}/health`, 1500)) return true
      // 子进程没了就别等到超时：spawn error（lastErrorText）或已退出都立刻失败，
      // 让调用方马上把真实原因报出来。
      if (this.lastErrorText !== null) {
        this.deps.log(`embed server: 启动失败：${this.lastErrorText}`)
        return false
      }
      if (this.stopping) return false
      const childGone = this.child === null || (this.child !== null && this.child.exitCode !== null)
      if (childGone && !healInProgress()) return false
      await this.deps.sleep(500)
    }
    return false
  }

  /**
   * Stop the backend if (and only if) this manager owns it.
   * @returns true when a process was actually signalled.
   */
  stop()          {
    if (this.stopping) return false
    // 手动 stop 之后绝不能再被自愈重拉:作废所有在途的退避循环。
    this.restartSeq += 1
    if (!this.owned) return false
    this.stopping = true
    this.lastErrorText = null
    const pid = this.pid ?? this.adoptedPid
    let killed = false
    if (pid !== null) {
      if (this.pidIdentity(pid) === 'foreign') {
        // /proc/<pid>/cmdline 已不是 llama-server → 崩溃后 PID 被别的进程复用。
        // 杀下去就是误杀无关进程,宁可不杀。
        this.deps.log(`embed server: pid=${pid} 的 cmdline 不含 llama-server（PID 已复用）,不杀`)
      } else {
        this.deps.kill(pid)
        killed = true
        this.deps.log(`embed server: 已停止 pid=${pid}`)
      }
    }
    this.child = null
    this.pid = null
    this.adoptedPid = null
    this.owned = false
    this.removePidFile()
    return killed
  }

  /**
   * 启动入口(串行化):端口预检是异步的,若用户手动 start 恰好撞上自愈重拉,
   * 两次启动会同时穿过预检各拉起一个子进程 —— 用一个 starting 闸门挡掉。
   */
          async spawnServer()                            {
    if (this.starting) {
      this.deps.log('embed server: 已有一次启动流程在进行,跳过重复启动')
      return 'failed'
    }
    this.starting = true
    try {
      return await this.spawnServerInner()
    } finally {
      this.starting = false
    }
  }

          async spawnServerInner()                            {
    this.lastErrorText = null
    const host = this.cfg.host ?? DEFAULTS.host
    const port = this.cfg.port ?? DEFAULTS.port
    // 端口预检:端口被占时新进程绑定失败会秒退,日志里只剩一句
    // "address already in use",排查成本极高。先探一下,被占就直接失败。
    let portBusy = false
    try {
      portBusy = await this.deps.portInUse(host, port, PORT_PROBE_TIMEOUT_MS)
    } catch {
      portBusy = false
    }
    if (portBusy) {
      this.lastErrorText = `PORT_IN_USE：${host}:${port} 已被占用`
      this.deps.log(`embed server: PORT_IN_USE —— ${host}:${port} 已被占用,不启动子进程;改 retrieval.vector.spawn.port 或先停掉占用端口的进程`)
      return 'failed'
    }
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
    // Android/Termux:glibc ELF 的解释器在 Android 上不存在,直接 exec 只会
    // ENOENT。需要的话把启动改成 `ld.so --library-path <lib> <exe> ...`。
    const launch = this.resolveLaunch(args)
    if ('error' in launch) {
      this.lastErrorText = launch.error
      this.deps.log(`embed server: 启动失败：${launch.error}`)
      return 'failed'
    }
    this.lastLaunchPlan = launch
    const logFile = this.cfg.logFile
    if (logFile) {
      try { mkdirSync(dirname(logFile), { recursive: true }) } catch { /* best effort */ }
    }
    let out                    = 'ignore'
    if (logFile) {
      try { out = openSync(logFile, 'a') } catch { out = 'ignore' }
    }
    const stdio                                      = out === 'ignore' ? 'ignore' : ['ignore', out, out]
    const spawnOptions               = {
      cwd: this.cfg.cwd,
      windowsHide: true,
      detached: false,
      stdio,
      ...(launch.wrapped ? { env: this.wrappedEnv() } : {}),
    }
    const child = this.deps.spawn(launch.file, launch.args, spawnOptions)
    this.child = child
    this.owned = true
    this.pid = child.pid ?? null
    if (this.pid !== null) this.writePidFile(this.pid)
    if (logFile) {
      appendLogLine(logFile, `\n=== ${new Date().toISOString()} llama-server 由 DSH 启动 pid=${child.pid ?? '?'}${launch.wrapped ? '（glibc 包装）' : ''} cmd=${launch.file} ${launch.args.join(' ')}`)
    }
    const startedAt = Date.now()
    child.once('exit', (code, signal) => {
      const aliveMs = Date.now() - startedAt
      this.child = null
      this.owned = false
      this.removePidFile()
      // 主动 stop() 触发的退出:不重拉、只安静收尾(stopping 由下一次手动 start 复位)。
      if (this.stopping) return
      this.deps.log(`embed server: 进程已退出(code=${code ?? 'null'} signal=${signal ?? 'none'}，存活 ${aliveMs}ms)`)
      // 启动几秒就退出几乎一定是启动失败（缺 .so、端口被占、模型文件损坏…）。
      // 子进程的 stdout/stderr 都进了日志文件，这里把末尾几行带出来——否则
      // 主日志里只剩一句「进程已退出」，等于什么都没说（这正是 lib*.so.0
      // 缺失时最难查的地方）。
      if (aliveMs < 15_000) {
        const tail = readLogTail(logFile, 12)
        if (tail !== '') this.deps.log(`embed server: 启动失败详情（${logFile} 末尾）：\n${tail}`)
      }
      // 稳定跑了很久才崩(而不是启动即崩)→ 重新给满 3 次自愈机会。
      if (aliveMs > STABLE_RUN_MS) this.restartAttempts = 0
      void this.scheduleRestart(`进程异常退出(code=${code ?? 'null'} signal=${signal ?? 'none'})`)
    })
    child.once('error', (error) => {
      // spawn 失败（exe 不存在、无执行权限、glibc 解释器缺失）不会触发 exit，
      // 必须记下来，否则 ready 轮询会空转到 60s 超时，真实原因只留在 console。
      this.lastErrorText = error.message
      this.deps.log(`embed server: 进程错误(已忽略): ${error.message}`)
      this.child = null
      this.owned = false
      this.removePidFile()
    })
    this.deps.log(`embed server: 已后台启动 pid=${child.pid ?? '?'}（${this.baseUrl}）`)
    return 'spawned'
  }

  /**
   * 非主动退出后的自愈重拉:1s / 5s / 30s 退避,最多 3 次。
   * stop() 之后(restartSeq 变化)立刻放弃,绝不把用户手动停掉的服务拉起来。
   */
          async scheduleRestart(exitReason        )                {
    if (this.restartLoopActive) return
    this.restartLoopActive = true
    const seq = this.restartSeq
    try {
      while (this.restartAttempts < RESTART_BACKOFF_MS.length) {
        if (this.stopping || seq !== this.restartSeq) {
          this.deps.log('embed server: 已手动停止,取消自愈重拉')
          return
        }
        const delay = RESTART_BACKOFF_MS[this.restartAttempts]          
        this.restartAttempts += 1
        this.deps.log(`embed server: ${exitReason}，${delay}ms 后自愈重拉（第 ${this.restartAttempts}/${RESTART_BACKOFF_MS.length} 次）`)
        await this.deps.sleep(delay)
        if (this.stopping || seq !== this.restartSeq) {
          this.deps.log('embed server: 已手动停止,取消自愈重拉')
          return
        }
        // 退避窗口里用户可能已经手动 start 了,别重复拉起。
        if (this.child !== null) {
          this.deps.log('embed server: 已有实例在运行,跳过自愈重拉')
          return
        }
        const state = await this.spawnServer()
        if (state === 'spawned') return // 新子进程的 exit 会再次触发本循环
        // spawn 失败(端口被占 / loader 缺失):继续按下一档退避重试。
      }
      this.markUnavailable(`llama-server 连续异常退出（${exitReason}），已重试 ${RESTART_BACKOFF_MS.length} 次`)
    } finally {
      this.restartLoopActive = false
    }
  }

          markUnavailable(reason        )       {
    this.lastErrorText = reason
    this.deps.log(`embed server: 自愈失败 —— ${reason};后端标记不可用(检索继续走词法降级)`)
  }

          glibcMode()                {
    const raw = this.cfg.glibcWrap
    if (raw === false) return 'off'
    if (raw === true) return 'on'
    if (raw === 'off' || raw === 'on' || raw === 'auto') return raw
    return 'auto'
  }

          glibcLibDir()         {
    return join(this.deps.prefix || DEFAULT_TERMUX_PREFIX, 'glibc', 'lib')
  }

          findGlibcLoader(interp        )                {
    const dir = this.glibcLibDir()
    // 优先与 ELF 解释器同名(真机上是 ld-linux-aarch64.so.1);再兜底常见名。
    for (const name of [basename(interp), 'ld-linux-aarch64.so.1', 'ld-linux-x86-64.so.2', 'ld-linux.so.2']) {
      const candidate = join(dir, name)
      if (this.deps.fileExists(candidate)) return candidate
    }
    return null
  }

  /**
   * 决定最终用什么命令启动:
   *  - Linux 上 ELF 的 PT_INTERP 指向一个本机不存在的 loader(Android) →
   *    改用 `$PREFIX/glibc/lib/<loader> --library-path $PREFIX/glibc/lib <exe>`;
   *  - 找不到可用 loader → 返回可读错误(而不是让 spawn 抛裸 ENOENT);
   *  - 普通 Linux(解释器存在)/ 非 Linux / glibcWrap='off' → 原样启动。
   */
          resolveLaunch(args          )                                 {
    const exe = this.cfg.exe          
    const mode = this.glibcMode()
    const direct             = { file: exe, args, wrapped: false }
    if (mode === 'off') return direct
    if (this.deps.platform !== 'linux') {
      if (mode === 'on') this.deps.log(`embed server: glibcWrap='on' 只在 Linux 上生效,本机是 ${this.deps.platform},直接启动`)
      return direct
    }
    const interp = this.deps.readElfInterp(exe)
    if (interp === null) {
      // 非 ELF(脚本/Windows exe)或静态链接 → 不需要包装。
      if (mode === 'on') {
        return { error: `glibcWrap='on' 但读不到 ${exe} 的 ELF PT_INTERP(不是 ELF 或读取失败)` }
      }
      return direct
    }
    const interpPresent = this.deps.fileExists(interp)
    // auto:本机已经有这个解释器(普通 Linux)→ 不需要包装。
    if (mode === 'auto' && interpPresent) return direct
    const loader = this.findGlibcLoader(interp)
    if (loader === null) {
      const libDir = this.glibcLibDir()
      return {
        error: `glibc loader 缺失：${exe} 的 ELF 解释器 ${interp} 在本机不存在,且 ${libDir} 下找不到可用 loader;`
          + `请安装 glibc(pkg install glibc),或把 spawn.glibcWrap 设为 'off' 并换成本机可直接执行的 exe`,
      }
    }
    this.deps.log(`embed server: glibc 包装 —— 解释器 ${interp}${interpPresent ? "（glibcWrap='on' 强制）" : ' 在本机不存在'},改用 ${loader} 启动`)
    return { file: loader, args: ['--library-path', dirname(loader), exe, ...args], wrapped: true }
  }

  /**
   * glibc 包装时给子进程的环境:清掉 bionic 的 LD_PRELOAD。
   * Termux 的 libtermux-exec.so 混进 glibc 进程会让 ld.so 报
   * "Could not find a PHDR",而 glibc 子进程根本不需要它。
   */
          wrappedEnv()                    {
    const env                    = { ...process.env }
    delete env.LD_PRELOAD
    return env
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
    } catch {
      return false
    }
    // Linux 上还要看它到底是不是 llama-server:崩溃后 pid 可能被别的进程复用。
    return this.pidIdentity(pid) !== 'foreign'
  }

  /**
   * pid 身份:Linux 上 /proc/<pid>/cmdline 含 "llama-server" 才认作自家实例。
   * 非 Linux 或读不到 /proc(hidepid、进程刚死)时返回 'unknown' —— 按旧行为
   * 当作「是」,避免在拿不到证据时把服务弄丢。
   */
          pidIdentity(pid        )                                 {
    if (this.deps.platform !== 'linux') return 'unknown'
    let cmdline               
    try {
      cmdline = this.deps.readProcCmdline(pid)
    } catch {
      cmdline = null
    }
    if (cmdline === null) return 'unknown'
    return cmdline.includes('llama-server') ? 'ours' : 'foreign'
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