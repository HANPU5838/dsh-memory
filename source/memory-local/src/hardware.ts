/**
 * 宿主硬件探测(用于"按你的机器推荐模型")。
 *
 * 三条纪律:
 *  1. **只在需要时探测**(面板打开"模型与硬件"、或点了重新检测),绝不在插件激活时跑 ——
 *     探测要 spawn 外部命令(Windows 上还要起 PowerShell),那不该挡住 DSH 启动。
 *  2. **任何一项拿不到就说拿不到**(notes 里照实写),绝不猜一个数字冒充事实:
 *     猜错的显存会直接导致"推荐了一个跑不动的模型"。
 *  3. 全程不抛异常:每个字段都是尽力而为,失败即 null/0。
 *
 * 依赖注入(spawn/fs/时间)让生命周期可以在测试里跑,不需要真的装显卡。
 */
import { existsSync, statfsSync } from 'node:fs'
import { arch as osArch, platform as osPlatform, totalmem, homedir } from 'node:os'
import { detectPlatform } from './platform.ts'
import { execFile } from 'node:child_process'
import { dirname } from 'node:path'

export type RuntimeFlavor = 'cpu' | 'vulkan' | 'cuda' | 'metal'

export interface GpuInfo {
  vendor: 'nvidia' | 'amd' | 'intel' | 'unknown'
  name: string
  /** 显存(MB);拿不到时为 null(不要用 4GB 封顶的 WMI 数值冒充)。 */
  vramMb: number | null
  /** 驱动版本字符串(nvidia-smi 提供;它决定能不能用 CUDA 12.x 运行时)。 */
  driver: string | null
}

export interface HostHardware {
  platform: NodeJS.Platform
  arch: string
  cpuCount: number
  totalRamMb: number
  /**
   * 当前**可用**内存（MB，已扣 cgroup/LMK 限制）；读不到为 null。
   * Android 上物理内存远大于 App 实际能拿到的量，模型预算必须优先按它算，
   * 否则会推荐一个刚加载就被 LMK 杀掉的模型。
   */
  availableRamMb: number | null
  /** 安装目录所在盘的空闲空间;拿不到为 null。 */
  freeDiskMb: number | null
  diskPath: string | null
  gpu: GpuInfo | null
  /** 该机可用的运行时风味,按推荐顺序。 */
  flavors: RuntimeFlavor[]
  /** 探测过程中的"说不清"的部分,面板照实显示。 */
  notes: string[]
}

export interface HardwareDeps {
  platform: NodeJS.Platform
  arch: string
  cpuCount(): number
  totalRamMb(): number
  /** 可用内存（Termux/Android 上低于 totalRamMb）；不注入则按 null 处理。 */
  availableRamMb?(): number | null
  freeDiskMb(dir: string): number | null
  /** nvidia-smi 的原始输出;不可用时 null。 */
  nvidiaSmi(): Promise<string | null>
  /** Windows 显卡查询的原始 CSV;非 Windows 或失败时 null。 */
  windowsGpu(): Promise<string | null>
  log(message: string): void
}

/**
 * 显存小于这个值就不值得为它换运行时。
 *
 * 门槛取 4GB 而不是 2GB:2026-10-16 在一台 12 核 / 14GB / AMD 核显(2GB 共享显存)
 * 的机器上实测,2GB 的核显会被判成"可用 GPU"并推荐 Vulkan —— 而共享显存的核显
 * 跑 embedding 不会比 12 个 CPU 核更快,只会多一层驱动风险。
 */
export const MIN_USEFUL_VRAM_MB = 4096
/** CUDA 12.x 构建要求的最低 NVIDIA 驱动大版本。 */
export const CUDA_MIN_DRIVER_MAJOR = 550

function run(command: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 }, (error, stdout) => {
        if (error) return resolve(null)
        resolve(String(stdout ?? ''))
      })
    } catch {
      resolve(null)
    }
  })
}

export const defaultHardwareDeps: HardwareDeps = {
  platform: osPlatform(),
  arch: osArch(),
  // 核数走平台适配层：Android 上 os.cpus() 可能因 SELinux 拦截 /proc/stat 返回空，
  // 空数组会让「按核数推荐线程」算出 0 / NaN —— detectPlatform 会兜底成 4。
  cpuCount: () => detectPlatform().cpuCount,
  totalRamMb: () => Math.round(totalmem() / 1048576),
  // LMK 会让 App 的实际可用内存远小于物理内存：预算按这个值算才真实。
  availableRamMb: () => detectPlatform().availableMemMb,
  freeDiskMb: (dir) => {
    // statfs 需要真实存在的路径:从目标目录往上找到第一个存在的祖先。
    let probe = dir
    for (let i = 0; i < 12 && probe !== '' && !existsSync(probe); i++) probe = dirname(probe)
    if (probe === '' || !existsSync(probe)) return null
    try {
      const fs = statfsSync(probe)
      return Math.round((Number(fs.bavail) * Number(fs.bsize)) / 1048576)
    } catch {
      return null
    }
  },
  nvidiaSmi: () => run('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'], 2500),
  windowsGpu: () => run('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Csv -NoTypeInformation',
  ], 5000),
  log: (message) => console.log(`[dsh-memory-local] ${message}`),
}

function vendorOf(name: string): GpuInfo['vendor'] {
  const lower = name.toLowerCase()
  if (/nvidia|geforce|quadro|tesla|rtx/.test(lower)) return 'nvidia'
  if (/amd|radeon|ati /.test(lower)) return 'amd'
  if (/intel|arc|iris|uhd graphics/.test(lower)) return 'intel'
  return 'unknown'
}

/**
 * `nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits`
 * 的一行输出:`NVIDIA GeForce RTX 4070, 12282, 551.86`。
 */
export function parseNvidiaSmi(stdout: string | null): GpuInfo | null {
  const line = (stdout ?? '').split('\n').map((l) => l.trim()).find((l) => l.length > 0)
  if (line === undefined) return null
  const parts = line.split(',').map((p) => p.trim())
  if (parts.length < 2 || parts[0] === '') return null
  const vram = Number.parseInt(parts[1] ?? '', 10)
  return {
    vendor: 'nvidia',
    name: parts[0]!,
    vramMb: Number.isFinite(vram) && vram > 0 ? vram : null,
    driver: parts[2] !== undefined && parts[2] !== '' ? parts[2] : null,
  }
}

/**
 * `Get-CimInstance Win32_VideoController | ConvertTo-Csv` 的输出。
 *
 * AdapterRAM 是 uint32,超过 4GB 的显卡这里读出来是错的(常见 4095 或负数),
 * 所以可疑值一律当作"拿不到",宁可说不知道也不推荐一个塞不下的模型。
 */
export function parseWindowsGpu(stdout: string | null): { gpu: GpuInfo; notes: string[] } | null {
  const lines = (stdout ?? '').split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
  if (lines.length < 2) return null
  const notes: string[] = []
  let best: GpuInfo | null = null
  for (const line of lines.slice(1)) {
    const cells = line.split(',').map((c) => c.replace(/^"|"$/g, '').trim())
    const name = cells[0] ?? ''
    if (name === '' || /microsoft basic|remote|virtual|parsec|displaylink/i.test(name)) continue
    const raw = Number.parseInt(cells[1] ?? '', 10)
    // AdapterRAM 是 uint32:**4GB 及以上的卡这里一律读不准**(常见 4095MB 或 uint32 溢出值)。
    // 4GB 是个可信的读数上限,到了这个量级就当"未知",猜错会导致推荐一个塞不下的模型。
    const plausible = Number.isFinite(raw) && raw > 0 && raw < 4000 * 1048576
    const vramMb = plausible ? Math.round(raw / 1048576) : null
    if (!plausible && raw !== 0) notes.push(`系统报告 ${name} 的显存 ≥ 4GB(Windows 这里读不准),已按"未知"处理`)
    const candidate: GpuInfo = { vendor: vendorOf(name), name, vramMb, driver: null }
    // 优先独显:厂商档位优先于"显存读到了没有" —— 一块读不准显存的 RTX 也比核显值得推。
    const rank = (g: GpuInfo): number =>
      (g.vendor === 'nvidia' ? 3 : g.vendor === 'amd' ? 2 : g.vendor === 'intel' ? 1 : 0) * 100_000 + (g.vramMb ?? 0)
    if (best === null || rank(candidate) > rank(best)) best = candidate
  }
  return best === null ? null : { gpu: best, notes }
}

/** 该机可用的运行时风味,按推荐顺序(cuda 需要够新的 NVIDIA 驱动)。 */
export function flavorsFor(hw: { platform: NodeJS.Platform; gpu: GpuInfo | null }): RuntimeFlavor[] {
  if (hw.platform === 'darwin') return ['metal', 'cpu']
  const gpu = hw.gpu
  if (gpu === null) return ['cpu']
  const usable = gpu.vramMb === null || gpu.vramMb >= MIN_USEFUL_VRAM_MB
  if (!usable) return ['cpu']
  if (gpu.vendor === 'nvidia') {
    const major = Number.parseInt((gpu.driver ?? '').split('.')[0] ?? '', 10)
    const driverOk = Number.isFinite(major) && major >= CUDA_MIN_DRIVER_MAJOR
    // 驱动读不到就不推 CUDA:装完起不来比慢一点更糟。
    return driverOk ? ['cuda', 'vulkan', 'cpu'] : ['vulkan', 'cpu']
  }
  return ['vulkan', 'cpu']
}

export async function probeHardware(
  opts: { dir?: string } = {},
  deps: HardwareDeps = defaultHardwareDeps,
): Promise<HostHardware> {
  const notes: string[] = []
  const dir = opts.dir ?? homedir()
  let gpu: GpuInfo | null = null

  if (deps.platform === 'darwin') {
    // macOS 上 llama.cpp 自带 Metal,不需要探测显卡。
    notes.push('macOS:llama.cpp 走 Metal,无需选择显卡运行时')
  } else {
    const smi = parseNvidiaSmi(await deps.nvidiaSmi().catch(() => null))
    if (smi !== null) gpu = smi
    else if (deps.platform === 'win32') {
      const win = parseWindowsGpu(await deps.windowsGpu().catch(() => null))
      if (win !== null) { gpu = win.gpu; notes.push(...win.notes) }
      else notes.push('未能探测到显卡(nvidia-smi 与系统查询都没结果),将以 CPU 运行')
    } else {
      notes.push('未能探测到显卡,将以 CPU 运行')
    }
    if (gpu !== null && gpu.vramMb === null) notes.push(`${gpu.name} 的显存未能读到,推荐时会按"不确定"处理`)
    if (gpu !== null && gpu.vendor === 'nvidia' && gpu.driver === null) notes.push('NVIDIA 驱动版本未读到,不会推荐 CUDA 运行时')
  }

  const freeDiskMb = (() => {
    try { return deps.freeDiskMb(dir) } catch { return null } // 探测失败就说不知道,不许把插件带崩
  })()
  if (freeDiskMb === null) notes.push('未能读到磁盘剩余空间')

  const hw: HostHardware = {
    platform: deps.platform,
    arch: deps.arch,
    cpuCount: Math.max(1, deps.cpuCount()),
    totalRamMb: Math.max(0, deps.totalRamMb()),
    availableRamMb: (() => {
      try { return deps.availableRamMb?.() ?? null } catch { return null }
    })(),
    freeDiskMb,
    diskPath: freeDiskMb === null ? null : dir,
    gpu,
    flavors: [],
    notes,
  }
  hw.flavors = flavorsFor(hw)
  deps.log(`硬件:${hw.cpuCount} 核 / ${Math.round(hw.totalRamMb / 1024)}GB 内存 / 显卡 ${gpu?.name ?? '无'} / 可用运行时 ${hw.flavors.join(',')}`)
  return hw
}
