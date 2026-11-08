/**
 * 平台适配层 —— 把「插件在什么机器上跑」这件事收敛到一个模块。
 *
 * 为什么需要它：记忆插件的所有平台差异（Termux 的 glibc、Android 的 CPU/内存探测、
 * 磁盘与临时目录、可执行文件解释器）以前散落在 embed-server / embed-install /
 * hardware 三处，各写一套判断。散着写的结果是：换一台设备就要重新踩一遍坑，而且
 * 仓库外还得靠猴补丁兜底。这里统一成「探测一次 → 各模块消费」，插件自包含，
 * 不改宿主、不读宿主私有文件。
 *
 * 设计约束：
 *  - 纯 Node 内置依赖，零 npm 依赖；
 *  - 所有探测都 best-effort：读不到就返回 null / 合理默认，绝不抛异常；
 *  - 所有探测入口都能注入依赖（测试不依赖真机环境）；
 *  - 只读，不写任何文件。
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statfsSync, statSync } from 'node:fs'
import { arch as osArch, availableParallelism, cpus, platform as osPlatform, tmpdir, totalmem } from 'node:os'
import { basename, dirname, join } from 'node:path'

/** Termux 的默认 $PREFIX（环境变量缺失时的兜底）。 */
export const DEFAULT_TERMUX_PREFIX = '/data/data/com.termux/files/usr'

/** glibc loader 的候选文件名（按架构优先，再兜底常见名）。 */
export const GLIBC_LOADER_NAMES = [
  'ld-linux-aarch64.so.1',
  'ld-linux-x86-64.so.2',
  'ld-linux.so.2',
]         

                               
                           
              
                                                                             
                 
                                   
                       
                                         
                            
                                             
                            
                                                            
                  
                    
                                                                 
                               
                
 

                                     
                         
                            
               
                         
                           
                                    
                                     
 

/**
 * 探测当前运行环境。所有字段都是 best-effort，不会抛。
 *
 * Android 上 `os.cpus()` 可能因为 SELinux 拦截 /proc/stat 返回空数组；空数组会让
 * 「按核数推荐线程」算出 0 或 NaN，所以这里兜底 availableParallelism()，再不行给 4。
 */
export function detectPlatform(deps                     = {})               {
  const env = deps.env ?? process.env
  const exists = deps.exists ?? existsSync
  const readFile = deps.readFile ?? ((path        ) => readFileSync(path, 'utf8'))
  const platform = deps.platform ?? osPlatform()

  const prefixRaw = (env.PREFIX ?? '').trim()
  const termux = env.TERMUX_VERSION !== undefined
    || prefixRaw.includes('com.termux')
    || (env.ANDROID_ROOT !== undefined && env.ANDROID_ROOT !== '')
    || (env.PREFIX !== undefined && prefixRaw.endsWith('/usr') && exists(join(prefixRaw, 'glibc', 'lib')))

  const prefix = termux
    ? (prefixRaw !== '' ? prefixRaw : DEFAULT_TERMUX_PREFIX)
    : null

  let glibcLoader                = null
  let glibcLibDir                = null
  if (prefix !== null) {
    const libDir = join(prefix, 'glibc', 'lib')
    for (const name of GLIBC_LOADER_NAMES) {
      const candidate = join(libDir, name)
      if (exists(candidate)) {
        glibcLoader = candidate
        glibcLibDir = libDir
        break
      }
    }
  }

  const cpu = deps.cpuCount
    ? deps.cpuCount()
    : (cpus().length || (typeof availableParallelism === 'function' ? availableParallelism() : 0) || 4)
  const totalMb = deps.totalMemMb ? deps.totalMemMb() : Math.round(totalmem() / 1048576)

  return {
    platform,
    arch: deps.arch ?? osArch(),
    termux,
    prefix,
    glibcLoader,
    glibcLibDir,
    cpuCount: Number.isFinite(cpu) && cpu > 0 ? Math.floor(cpu) : 4,
    totalMemMb: Number.isFinite(totalMb) && totalMb > 0 ? Math.floor(totalMb) : 0,
    availableMemMb: readAvailableMemMb(readFile, totalMb),
    tmpDir: (env.TMPDIR !== undefined && env.TMPDIR !== '') ? env.TMPDIR : tmpdir(),
  }
}

/**
 * 可用内存：`/proc/meminfo` 的 MemAvailable 与 cgroup 限制取较小值。
 * Android 上物理内存（totalmem）往往远大于 App 实际能用的量（LMK 会杀），
 * 用 totalmem 做「能装多大模型」的判断必然偏乐观。
 */
function readAvailableMemMb(readFile                          , totalMb        )                {
  let best                = null
  try {
    const info = readFile('/proc/meminfo')
    const match = /^MemAvailable:\s+(\d+)\s+kB/mu.exec(info)
    if (match !== null) {
      const kb = Number.parseInt(match[1] , 10)
      if (Number.isFinite(kb) && kb > 0) best = Math.round(kb / 1024)
    }
  } catch { /* 读不到就跳过 */ }
  try {
    const raw = readFile('/sys/fs/cgroup/memory.max').trim()
    if (raw !== '' && raw !== 'max') {
      const bytes = Number.parseInt(raw, 10)
      if (Number.isFinite(bytes) && bytes > 0) {
        const mb = Math.round(bytes / 1048576)
        best = best === null ? mb : Math.min(best, mb)
      }
    }
  } catch { /* cgroup v1 或不存在 */ }
  if (best !== null && totalMb > 0) best = Math.min(best, totalMb)
  return best
}

/**
 * 只读 ELF header（前 64 字节）+ program headers 找 PT_INTERP 的文件路径。
 * 不需要完整 ELF 解析，也不加载目标程序；非 ELF / 静态链接 / 读取失败都返回 null。
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
      const text = interp.toString('utf8').replace(/\0+$/u, '').trim()
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
 * 目录所在文件系统的可用字节数；路径不存在时向上找最近的已存在祖先。
 * 读不到（老内核 / 权限 / 非常规文件系统）返回 null —— 调用方应「跳过检查」。
 */
export function freeDiskBytes(dir        )                {
  let probe = dir
  for (let i = 0; i < 12 && probe !== '' && !existsSync(probe); i += 1) probe = dirname(probe)
  if (probe === '' || !existsSync(probe)) return null
  try {
    const fs = statfsSync(probe)
    const bytes = Number(fs.bavail) * Number(fs.bsize)
    // 0 通常意味着「这个挂载点读不到真实空间」（例如 Android 的只读分区），
    // 当成"未知"比当成"没有空间"更安全：预检不该因为读不到就把安装拦死。
    return Number.isFinite(bytes) && bytes > 0 ? bytes : null
  } catch {
    return null
  }
}

/** 目录是否允许执行（noexec 挂载 / 共享存储是 Android 上常见的「装了跑不起来」原因）。 */
export function canExecute(dir        )                 {
  try {
    const st = statSync(dir)
    if (!st.isDirectory()) return null
    // 只读挂载 / noexec 无法可靠从 stat 判断；这里给「目录可写」这个必要条件。
    return (st.mode & 0o200) !== 0
  } catch {
    return null
  }
}

/**
 * 一行人类可读的环境摘要（日志与面板自检共用）。
 * 例：`linux arm64 · Termux · 8 核 · 内存 7.5/15.0GB · glibc loader ✓`
 */
export function describePlatform(info               = detectPlatform())         {
  const parts           = [`${info.platform} ${info.arch}`]
  if (info.termux) parts.push('Termux')
  if (info.cpuCount > 0) parts.push(`${info.cpuCount} 核`)
  if (info.totalMemMb > 0) {
    const total = (info.totalMemMb / 1024).toFixed(1)
    const avail = info.availableMemMb === null ? '?' : (info.availableMemMb / 1024).toFixed(1)
    parts.push(`内存 ${avail}/${total}GB`)
  }
  if (info.termux) parts.push(info.glibcLoader === null ? 'glibc loader ✗' : 'glibc loader ✓')
  return parts.join(' · ')
}

/** 供 spawn 侧判断的「ELF 解释器是否需要被 Termux glibc loader 包装」。 */
export function glibcLoaderFor(info              , interp        )                {
  if (info.glibcLibDir === null || info.glibcLoader === null) return null
  const byName = join(info.glibcLibDir, basename(interp))
  if (existsSync(byName)) return byName
  return info.glibcLoader
}


//# sourceURL=source/memory-local/src/platform.ts