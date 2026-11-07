/**
 * dsh-memory-local — 向量后端「下载并配置」安装器（零运行时依赖）。
 *
 * 背景：本地语义检索需要一个 OpenAI 兼容的 /v1/embeddings 服务，而默认没人替
 * 用户准备好后端——得自己去下 llama.cpp 的 llama-server 和 bge-m3 的 GGUF 模
 * 型，再手填两个绝对路径。本模块把那套手工动作收成一个按钮：
 *   查 GitHub 最新构建 → 下运行时压缩包 → 解压 → 下模型 → 校验布局
 * 落盘位置与「手工装好的既有布局」逐字节一致，装完由 EmbedServerManager 托管
 * 启动（见 embed-server.ts）。
 *
 * 为什么零依赖（任何 npm 包都不用）：
 *  - 这个包要被别人 `pnpm add dsh-memory-local` 直接装上就用，每多一个依赖就多
 *    一份升级、审计、甚至原生编译的负担；解压一个发行包不值得把包袱转嫁给用户；
 *  - 真正需要的能力 node 内置已经齐了：zip 要的只是「中央目录 + inflateRaw」，
 *    tar.gz 要的只是「gunzip + 512 字节头」，zlib 直接给；流式写盘用 fs 流；
 *    HTTPS/TLS 交给全局 fetch（不碰 node:https，证书与代理策略跟随宿主）。
 *
 * 硬约束（都对应一条真实教训）：
 *  - 默认绝不下载：只有显式 start() 才碰网络，构造/导入阶段零 I/O；
 *  - 幂等：已在跑、或已经装好，start() 什么都不做；
 *  - 绝不抛异常：start() 是 fire-and-forget，任何失败都变成 phase:'error' +
 *    可读 message（面板直接显示这两个字段）；
 *  - 半成品绝不落地：下载先写 <目标>.part，收流完整后 rename——否则一次断网
 *    留下的半个 gguf 会被 detectInstalled 当成「已安装」，然后 llama-server
 *    报一句莫名其妙的加载失败；
 *  - 可取消：cancel() 中止在途请求、删掉 .part、phase 回到 idle；
 *  - 解压必须防路径穿越：压缩包是远端内容，`../` 或绝对路径条目一律拒绝；
 *  - 链接必须有兜底：tar 里的 SONAME 软链在 FAT/exFAT/部分 Android 共享存储上建
 *    不出来（symlink(2) EPERM/ENOSYS），这时退化为复制真实文件；多轮重试解决
 *    链式依赖（A→B→file），失败数与明细要交给上层，不能静默跳过；
 *  - 解压后必须校验：运行时目录里的符号链接都得能解析（verifyRuntimeLinks），
 *    否则装完看着成功、启动才报 "cannot open shared object file"，最难排查；
 *  - 下载前磁盘预检：空间不够就先报错并说清要释放多少，别下到一半 ENOSPC；
 *  - 每条下载都留了备用通道：运行时是「下载直链 → GitHub API 资产端点」，模型
 *    是多个源，全部按序回退（详见 runtimeDownloadSources / MODEL_SOURCES）。
 *    这不是锦上添花——直链会 302 到 release-assets.githubusercontent.com，该主机
 *    在部分网络会被重置连接，而 api.github.com 通畅，没有备用通道就等于装不上。
 *
 * 布局（installPaths 是唯一事实来源，检测与安装都走它）：
 *   <root>/llamacpp/llama-server[.exe]   ← 运行时（同目录还有几十个 dll/so）
 *   <root>/models/bge-m3-Q4_K_M.gguf     ← 模型
 *   <root>/llama-server.log              ← 托管启动时追加的日志
 */
import { chmodSync, copyFileSync, createWriteStream, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, statfsSync, symlinkSync, writeFileSync } from 'node:fs'
import type { Dirent, WriteStream } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { gunzipSync, inflateRawSync } from 'node:zlib'
import type { RuntimeFlavor } from './hardware.ts'

/** 模型文件名：下载目标与「是否已安装」的判据都用它，不要在两处各写一遍。 */
export const MODEL_FILE_NAME = 'bge-m3-Q4_K_M.gguf'

/** 运行时的 zip/pkg 文件名（Windows 是 zip，Linux/macOS 是 tar.gz）。 */
export const RUNTIME_DIR_NAME = 'llamacpp'
export const MODELS_DIR_NAME = 'models'
export const LOG_FILE_NAME = 'llama-server.log'

/** GitHub API：查询 llama.cpp 发行版列表（不硬编码构建号）。 */
const RELEASES_API = 'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=20'
/** GitHub 要求带 UA；不带会被 403。 */
const USER_AGENT = 'dsh-memory-local-installer'

/**
 * 模型下载源，按顺序回退（同一份 Q4_K_M，仓库都是 gpustack/bge-m3-GGUF）。
 *
 * 2026-10-10 逐个核实过（只发 HEAD / Range，没有真的拉 400MB）：
 *  - hf-mirror.com   → 302 → HF CDN，content-length 437778496 ✅
 *  - modelscope.cn   → 302 → cdn-lfs-cn-1.modelscope.cn，206 + `bytes 0-0/437778496` ✅
 *  - huggingface.co  → 本机直连超时（curl 28，15s 无响应）❌ 但海外用户应该优先官方源
 * 三个源的大小都等于本机 `D:\.deepseek\memory-stack\models\bge-m3-Q4_K_M.gguf`
 * 的 437778496 字节，即同一份量化。
 *
 * 顺序取「国内可达的两个在前、官方源在最后」：本机/国内是第一现场，官方源排在
 * 列表里仍然会被尝试，海外用户只是多花一次失败请求的代价。
 */
export const MODEL_SOURCES: readonly string[] = [
  'https://hf-mirror.com/gpustack/bge-m3-GGUF/resolve/main/bge-m3-Q4_K_M.gguf',
  'https://modelscope.cn/models/gpustack/bge-m3-GGUF/resolve/master/bge-m3-Q4_K_M.gguf',
  'https://huggingface.co/gpustack/bge-m3-GGUF/resolve/main/bge-m3-Q4_K_M.gguf',
]
/**
 * 期望字节数（437778496 = 417.5 MiB）。**只用于消息里的「约 X MB」，不做硬校验**：
 * 上游随时可能重新量化/更新，把大小当断言会让一次正常的上游更新变成安装失败。
 * 真实进度一律以响应的 content-length 为准。
 */
export const MODEL_SIZE_BYTES = 437_778_496

/**
 * 磁盘预检常量。download 先写 `<目标>.part` 再 rename，所以 .part 与最终文件
 * 在同一块盘上各占一份峰值空间；模型按 1.25 倍预留就是给这份开销与文件系统
 * 元数据的。运行时按风味给保守占位（CPU 包解压后约 100MB 级，CUDA 伴生包大得
 * 多，宁可多报也不能让用户在解压到一半时撞 ENOSPC）。
 */
const MODEL_DISK_FACTOR = 1.25
const RUNTIME_RESERVE_BYTES: Record<RuntimeFlavor, number> = {
  cpu: 256 * 1024 * 1024,
  metal: 256 * 1024 * 1024,
  vulkan: 384 * 1024 * 1024,
  cuda: 1536 * 1024 * 1024,
}
/** 额外余量：日志、文件系统元数据、系统随时回收的那部分，别把盘写满到 0。 */
const EXTRA_DISK_RESERVE_BYTES = 200 * 1024 * 1024

/** 安装布局。与手工装好的既有布局一致（embed-server 直接吃这几个字段）。 */
export interface InstallPaths {
  /** 安装根目录，如 D:\.deepseek\memory-stack */
  root: string
  /** 运行时目录 `<root>/llamacpp` */
  dir: string
  /** `<root>/llamacpp/llama-server.exe`（POSIX 上无 .exe） */
  exe: string
  /** 子进程工作目录：llama.cpp 的 shim 从这里解析同目录的 dll/so */
  cwd: string
  /** `<root>/models/<所选模型的文件名>` —— 文件名来自模型清单，不再写死 */
  model: string
  /** `<root>/llama-server.log` */
  logFile: string
}

/** 要安装的模型：文件名是唯一事实来源（落盘名 + 「装没装」判据）。 */
export interface InstallModel {
  file: string
  /** 已知体积，只用于提示与磁盘校验；以响应的 content-length 为准。 */
  bytes?: number
  /** 按序回退的下载源；不给则退回内置 MODEL_SOURCES（只适用于 bge-m3）。 */
  sources?: string[]
}

/** 安装状态机。idle/error 都可能再次 start()。 */
export type InstallPhase =
  | 'idle'
  | 'preparing'
  | 'downloading-runtime'
  | 'extracting'
  | 'downloading-model'
  | 'done'
  | 'error'

/**
 * 面板直接渲染的快照。receivedBytes/totalBytes 是**当前这一个文件**的进度
 * （totalBytes 取 content-length，拿不到就是 null），所以百分比 =
 * receivedBytes/totalBytes 才有意义。
 */
export interface InstallProgress {
  phase: InstallPhase
  message: string
  receivedBytes: number
  totalBytes: number | null
  error: string | null
  paths: InstallPaths | null
}

export interface InstallerOptions {
  /** 安装根目录（`<root>/llamacpp` + `<root>/models` 会建在这里）。 */
  root: string
  /** 注入的 fetch，测试用；默认全局 fetch（TLS 交给它）。 */
  fetchImpl?: typeof fetch
  /** 每次状态变化都会回调一次（回调抛错会被吞掉，不影响安装）。 */
  onProgress?: (p: InstallProgress) => void
  /** 外部取消信号（面板的「取消」走 cancel()，这个给调用方复用别处的 signal）。 */
  signal?: AbortSignal
  /**
   * 要装的模型。不给则退回内置的 bge-m3 Q4_K_M —— 这样老配置(只写 modelSources)
   * 的行为与合并前逐字一致。
   */
  model?: InstallModel
  /** 运行时风味：cpu(默认) / vulkan / cuda / metal(macOS 等同 cpu 包)。 */
  flavor?: RuntimeFlavor
  /** 覆盖模型下载源列表（默认取 model.sources，其次内置 MODEL_SOURCES）。 */
  modelSources?: string[]
  /** 测试注入：只影响选中哪个运行时资产，目录布局始终跟随宿主平台。 */
  platform?: NodeJS.Platform
  /** 测试注入：同 platform。 */
  arch?: string
  /**
   * 测试注入：读安装根目录所在磁盘的可用字节数。默认 freeDiskBytes（statfsSync）；
   * 返回 null = 读不到（预检跳过，不阻塞安装）。
   */
  freeBytes?: (dir: string) => number | null
}

/** zip 中央目录里一条记录（只保留解压需要的字段）。 */
interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  /** 本地文件头偏移 */
  offset: number
}

/** tar 里一条记录。 */
interface TarEntry {
  name: string
  size: number
  /** 类型标志：'0'/'\0' 普通文件，'5' 目录，'2' 符号链接，'1' 硬链接 */
  type: string
  /** 权限位（八进制整数）；链接条目不使用。 */
  mode?: number
  linkName: string
  data: Buffer
}

export function installPaths(root: string, modelFile: string = MODEL_FILE_NAME): InstallPaths {
  const dir = join(root, RUNTIME_DIR_NAME)
  // 宿主平台决定可执行文件名：Windows 上 llama.cpp 的启动器带 .exe。
  const exeName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
  return {
    root,
    dir,
    exe: join(dir, exeName),
    cwd: dir,
    model: join(root, MODELS_DIR_NAME, modelFile),
    logFile: join(root, LOG_FILE_NAME),
  }
}

/**
 * 已安装则返回布局，否则 null（判据：exe 与**所选模型的**文件都在）。
 *
 * 只看「存在」就够：安装器永远先写 .part 再 rename，所以这两个路径上不可能
 * 出现半成品；反过来，用户手工放好的文件也会被如实采纳（这正是
 * `<root>/llamacpp` + `<root>/models` 这套既有布局的意义）。
 * 绝不抛异常：它在 resolveConfig 里被同步调用。
 */
export function detectInstalled(root: string, modelFile: string = MODEL_FILE_NAME): InstallPaths | null {
  try {
    const paths = installPaths(root, modelFile)
    if (!isFile(paths.exe) || !isFile(paths.model)) return null
    return paths
  } catch {
    return null
  }
}

/**
 * 平台 + 风味 → 发行资产名正则。按平台挑包，绝不硬编码构建号。
 *
 * 资产名逐个核实过（llama.cpp b11678，2026-10-16 查的 API）：
 *   cpu     win/linux/macos 的通用包（win-cpu-x64 / ubuntu-x64 / macos-*）
 *   vulkan  `-bin-win-vulkan-x64.zip` / `-bin-ubuntu-vulkan-x64.tar.gz` —— 自包含，驱动自带 Vulkan 即可
 *   cuda    `-bin-win-cuda-12.4-x64.zip` / `-bin-ubuntu-cuda-12.8-x64.tar.gz` —— **还需要 cudart 伴随包**
 *   metal   macOS 构建自带 Metal，资产与 cpu 相同
 *
 * 正则**首尾都要锚定**：同一批资产里还有 cuda/vulkan/sycl/openvino/rocm/adreno 变体，
 * 首端不锚定就会误命中——`cudart-llama-bin-win-cuda-12.4-x64.zip` 和
 * `llama-b12023-bin-win-cuda-12.4-x64.zip` 共享同一段后缀，而 release 的 assets
 * 数组顺序**不保证**主包在前（b12023 实测 cudart 排在前面），只锚 `$` 会把 CUDA
 * 运行库当成运行时下下来，解压后当然找不到 llama-server.exe（issue #4）。
 * 主包一律以 `llama-` 开头（构建号写在中间，不硬编码），伴生包一律以 `cudart-`
 * 开头，两个正则互不重叠。
 * CUDA 的次版本号写进正则是有意的：不同 CUDA 版本需要不同的 cudart 与之配对，
 * 让它们一起被选中才能保证两个包属于同一套工具链。
 */
export function runtimeAssetPattern(
  platform: NodeJS.Platform,
  arch: string,
  flavor: RuntimeFlavor = 'cpu',
): RegExp {
  const key = `${platform}-${arch}`
  const cpu = (): RegExp => {
    switch (key) {
      case 'win32-x64': return /^llama-.*-bin-win-cpu-x64\.zip$/
      case 'win32-arm64': return /^llama-.*-bin-win-cpu-arm64\.zip$/
      case 'linux-x64': return /^llama-.*-bin-ubuntu-x64\.(?:zip|tar\.gz)$/
      case 'linux-arm64': return /^llama-.*-bin-ubuntu-arm64\.(?:zip|tar\.gz)$/
      case 'darwin-arm64': return /^llama-.*-bin-macos-arm64\.(?:zip|tar\.gz)$/
      case 'darwin-x64': return /^llama-.*-bin-macos-x64\.(?:zip|tar\.gz)$/
      default:
        throw new Error(
          `资产匹配失败：${key}（暂不支持该平台；已支持 win32-x64 / win32-arm64 / linux-x64 / linux-arm64 / darwin-arm64 / darwin-x64）`,
        )
    }
  }
  if (flavor === 'cpu' || flavor === 'metal') return cpu()
  if (flavor === 'vulkan') {
    switch (key) {
      case 'win32-x64': return /^llama-.*-bin-win-vulkan-x64\.zip$/
      case 'win32-arm64': return /^llama-.*-bin-win-vulkan-arm64\.zip$/
      case 'linux-x64': return /^llama-.*-bin-ubuntu-vulkan-x64\.tar\.gz$/
      case 'linux-arm64': return /^llama-.*-bin-ubuntu-vulkan-arm64\.tar\.gz$/
      // macOS 没有独立的 Vulkan 包(Metal 就是它的 GPU 路径),退回 CPU 构建。
      default: return cpu()
    }
  }
  // cuda
  switch (key) {
    case 'win32-x64': return /^llama-.*-bin-win-cuda-12\.4-x64\.zip$/
    case 'win32-arm64': return /^llama-.*-bin-win-cuda-13\.4-arm64\.zip$/
    case 'linux-x64': return /^llama-.*-bin-ubuntu-cuda-12\.8-x64\.tar\.gz$/
    case 'linux-arm64': return /^llama-.*-bin-ubuntu-cuda-13\.4-arm64\.tar\.gz$/
    default: return cpu()
  }
}

/**
 * CUDA 风味需要的伴随资产(cudart:运行时 + cuBLAS 等),没有它 llama-server 起不来。
 *
 * 注意它的命名和主包**不一致**：Windows 的 cudart 包一律不带构建号
 * （`cudart-llama-bin-win-cuda-12.4-x64.zip`），Linux 的带
 * （`cudart-llama-b12023-bin-ubuntu-cuda-12.8-x64.tar.gz`），而且 Windows 的
 * 13.4 也会沿用 `cudart-llama-bin-win-cuda-13.4-…` 这种无构建号形态。所以正则
 * 不能要求 `b<号>`，只能靠 cuda 次版本号把主包与伴生包配对。
 */
export function runtimeCompanionPattern(
  platform: NodeJS.Platform,
  arch: string,
  flavor: RuntimeFlavor,
): RegExp | null {
  if (flavor !== 'cuda') return null
  switch (`${platform}-${arch}`) {
    case 'win32-x64': return /^cudart-.*bin-win-cuda-12\.4-x64\.zip$/
    case 'win32-arm64': return /^cudart-.*bin-win-cuda-13\.4-arm64\.zip$/
    case 'linux-x64': return /^cudart-.*bin-ubuntu-cuda-12\.8-x64\.tar\.gz$/
    case 'linux-arm64': return /^cudart-.*bin-ubuntu-cuda-13\.4-arm64\.tar\.gz$/
    default: return null
  }
}

/** 一个发行资产的两条下载通道（见 runtimeDownloadSources）。 */
export interface RuntimeAsset {
  name: string
  /** `browser_download_url`：下载直链，大多数网络下的标准通道。 */
  url: string
  /** `url`：GitHub API 资产端点，需要 Accept: application/octet-stream。 */
  apiUrl: string
}

/** 在一批 GitHub 资产里按平台 + 风味挑第一个匹配的包。 */
export function pickRuntimeAsset(
  assets: readonly unknown[],
  platform: NodeJS.Platform,
  arch: string,
  flavor: RuntimeFlavor = 'cpu',
): RuntimeAsset | null {
  return matchAsset(assets, runtimeAssetPattern(platform, arch, flavor))
}

/** 挑 CUDA 的 cudart 伴随包(非 cuda 风味或无匹配时为 null)。 */
export function pickRuntimeCompanion(
  assets: readonly unknown[],
  platform: NodeJS.Platform,
  arch: string,
  flavor: RuntimeFlavor,
): RuntimeAsset | null {
  const pattern = runtimeCompanionPattern(platform, arch, flavor)
  return pattern === null ? null : matchAsset(assets, pattern)
}

function matchAsset(assets: readonly unknown[], pattern: RegExp): RuntimeAsset | null {
  for (const asset of assets) {
    if (typeof asset !== 'object' || asset === null) continue
    const name = (asset as { name?: unknown }).name
    const url = (asset as { browser_download_url?: unknown }).browser_download_url
    const apiUrl = (asset as { url?: unknown }).url
    if (typeof name !== 'string' || typeof url !== 'string') continue
    if (pattern.test(name)) return { name, url, apiUrl: typeof apiUrl === 'string' ? apiUrl : '' }
  }
  return null
}

/** 在倒序的发行版列表里找第一个含匹配资产的 release（latest 不可用，见 resolveRuntimeAsset）。 */
function findAssetInReleases(releases: readonly unknown[], pattern: RegExp): RuntimeAsset | null {
  for (const release of releases) {
    if (typeof release !== 'object' || release === null) continue
    const assets = (release as { assets?: unknown }).assets
    if (!Array.isArray(assets)) continue
    const hit = matchAsset(assets, pattern)
    if (hit !== null) return hit
  }
  return null
}

/** 一个下载候选通道。 */
interface DownloadSource {
  url: string
  /** 该通道要求的 Accept 头。 */
  accept: string
  /** 给用户看的通道名（出错信息与成功日志里都用它）。 */
  label: string
}

/**
 * 运行时的两条通道，按序回退：
 *  1. `browser_download_url`（下载直链）——标准通道，大多数网络下最快；
 *  2. `asset.url`（GitHub API 资产端点，Accept: application/octet-stream）——
 *     直链会 302 到 release-assets/objects.githubusercontent.com，这个主机在
 *     部分网络（含本机）会被重置连接，而 api.github.com 是通的，所以它是本机
 *     能一键装上的关键备用通道。
 * 实测（2026-10-10，node 全局 fetch，只读响应头）：直链 fetch failed；
 * API 端点 HTTP 200 + content-length 19518702，1.2s。
 */
export function runtimeDownloadSources(asset: RuntimeAsset): DownloadSource[] {
  const sources: DownloadSource[] = [
    { url: asset.url, accept: '*/*', label: '发行包直链' },
  ]
  const withAccept: DownloadSource = { url: asset.apiUrl, accept: 'application/octet-stream', label: 'GitHub API 资产端点' }
  if (asset.apiUrl !== '' && asset.apiUrl !== asset.url) sources.push(withAccept)
  return sources.filter((source) => source.url !== '')
}

/**
 * 按魔数解压 zip / tar.gz 到 destDir，返回写入的条目数。
 * 看魔数而不是扩展名：远端文件名不可靠，内容头是可靠的。
 *
 * 返回值与合并前逐字一致（只数成功落盘的条目）；需要知道**链接**建没建起来时
 * 用同价的 extractArchiveReport()，它额外带 links 统计。
 */
export function extractArchive(archive: Buffer, destDir: string, options: ExtractOptions = {}): number {
  return extractArchiveReport(archive, destDir, options).written
}

/**
 * 解压的可注入依赖（只给测试用：模拟不支持符号链接/硬链接的文件系统）。
 * 生产路径一律走 fs 原语，不引入任何依赖。
 */
export interface ExtractOptions {
  /** 替代 fs.symlinkSync(链接内容, 落盘路径)；抛错即视为该文件系统不支持软链。 */
  symlink?: (from: string, to: string) => void
  /** 替代 fs.linkSync(现有文件, 新路径)；抛错即退化为复制。 */
  hardlink?: (from: string, to: string) => void
}

/** tar 第二遍（建链接）的统计：上层据此判断「链接到底建没建起来」。 */
export interface ExtractLinkStats {
  /** 符号链接建成功的数量（目标暂时不存在的悬空链接也算建成功，能不能解析由 verifyRuntimeLinks 判）。 */
  symlinked: number
  /** 硬链接建成功的数量。 */
  hardlinked: number
  /** 退化为复制的数量（软链不被支持 / 硬链接不可用）。 */
  copied: number
  /** 多轮重试后仍然失败的数量（>0 时上层必须报错，不能当成功）。 */
  failed: number
  /** 建链接用了几轮（1 = 一轮就全部完成；A→B→file 的链需要多轮）。 */
  rounds: number
  /** 失败明细（`名字 -> 目标：原因`），上层拼错误消息用。 */
  failures: string[]
}

/** 解压结果。written = 普通文件 + 建成功的链接，与 extractArchive() 的返回值一致。 */
export interface ExtractReport {
  written: number
  links: ExtractLinkStats
}

function emptyLinkStats(): ExtractLinkStats {
  return { symlinked: 0, hardlinked: 0, copied: 0, failed: 0, rounds: 0, failures: [] }
}

/** 解压并带回链接统计（zip 没有链接，links 全零）。 */
export function extractArchiveReport(archive: Buffer, destDir: string, options: ExtractOptions = {}): ExtractReport {
  if (archive.length >= 4 && archive[0] === 0x50 && archive[1] === 0x4b) {
    return { written: extractZip(archive, destDir), links: emptyLinkStats() }
  }
  if (archive.length >= 2 && archive[0] === 0x1f && archive[1] === 0x8b) return extractTarGz(archive, destDir, options)
  throw new Error('不支持的压缩格式：既不是 zip（PK）也不是 gzip（1f 8b）')
}

// ───────────────────────────── zip ─────────────────────────────

/** 从尾部往前找 End of Central Directory（最多回扫 65557 字节 = 22 + 注释上限）。 */
function findEocd(buf: Buffer): number {
  const floor = Math.max(0, buf.length - 65_557)
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i
  }
  throw new Error('不是有效的 ZIP 文件：找不到中央目录结尾记录')
}

/** 读中央目录（解压前先拿到全部条目的名字/大小/压缩方式/偏移）。 */
function readZipEntries(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf)
  const count = buf.readUInt16LE(eocd + 10)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || cdOffset === 0xffffffff) {
    // 这些哨兵值代表真实信息在 ZIP64 记录里——llama.cpp 的包远没到 4GB，不实现。
    throw new Error('暂不支持 ZIP64 归档')
  }
  const entries: ZipEntry[] = []
  let p = cdOffset
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) {
      throw new Error('ZIP 中央目录已损坏（条目签名不匹配或越界）')
    }
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    entries.push({
      method: buf.readUInt16LE(p + 10),
      compressedSize: buf.readUInt32LE(p + 20),
      uncompressedSize: buf.readUInt32LE(p + 24),
      offset: buf.readUInt32LE(p + 42),
      name: buf.toString('utf8', p + 46, p + 46 + nameLen),
    })
    p += 46 + nameLen + extraLen + commentLen
  }
  if (entries.length === 0) throw new Error('ZIP 里没有任何条目')
  return entries
}

/** 取一条条目的原始（未压缩）内容。stored/deflate 之外一律明确报错。 */
function readZipEntryData(buf: Buffer, entry: ZipEntry): Buffer {
  const p = entry.offset
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== 0x04034b50) {
    throw new Error(`ZIP 条目本地头损坏：${entry.name}`)
  }
  // 本地头的 name/extra 长度可能与中央目录不同（历史上被改过 extra），必须按本地头算。
  const nameLen = buf.readUInt16LE(p + 26)
  const extraLen = buf.readUInt16LE(p + 28)
  const start = p + 30 + nameLen + extraLen
  const end = start + entry.compressedSize
  if (end > buf.length) throw new Error(`ZIP 条目数据越界：${entry.name}`)
  const raw = buf.subarray(start, end)
  if (entry.method === 0) return Buffer.from(raw)
  if (entry.method === 8) {
    try {
      return inflateRawSync(raw)
    } catch (error) {
      throw new Error(`解压条目失败：${entry.name}（${describeError(error)}）`)
    }
  }
  throw new Error(`不支持的 ZIP 压缩方式：${entry.method}（仅支持 stored=0 / deflate=8）`)
}

function extractZip(buf: Buffer, destDir: string): number {
  const entries = readZipEntries(buf)
  // 先按**原始条目名**做一次安全检查：剥掉公共顶层目录之后再看就晚了
  // （`C:/x.txt` 这种绝对路径一剥就变成无害的相对路径了）。
  for (const entry of entries) assertSafeName(entry.name)
  const prefix = commonPrefix(entries.map((entry) => entry.name))
  let written = 0
  for (const entry of entries) {
    const rel = stripPrefix(entry.name, prefix)
    if (rel === '') continue
    // 目录项也要过一遍路径校验：`../` 目录同样不该被静默放行。
    const target = safeTarget(destDir, rel)
    if (rel.endsWith('/')) continue
    const data = readZipEntryData(buf, entry)
    if (data.length !== entry.uncompressedSize) {
      throw new Error(`解压校验失败：${entry.name} 声明 ${entry.uncompressedSize} 字节，实际 ${data.length} 字节`)
    }
    writeFile(target, data)
    written++
  }
  if (written === 0) throw new Error('压缩包里没有任何文件')
  return written
}

// ─────────────────────────── tar.gz ───────────────────────────

/** tar 里待创建的链接（第一遍只登记，不建）。 */
interface PendingTarLink {
  /** 归档内的相对路径（已剥公共顶层目录）。 */
  name: string
  /** 落盘绝对路径。 */
  target: string
  /** '2' 符号链接 / '1' 硬链接。 */
  type: string
  /** 归档里的链接目标：软链相对链接所在目录，硬链相对归档根。 */
  linkName: string
}

/**
 * 校验通过、进入重试队列的一条链接。
 * 软链记 relative（写进链接的内容）+ source（解析后的真实源，退化复制用）；
 * 硬链记 source（归档内的目标绝对路径）。
 */
type PreparedLink =
  | { kind: 'symlink'; link: PendingTarLink; relative: string; source: string; lastError?: unknown }
  | { kind: 'hardlink'; link: PendingTarLink; source: string; lastError?: unknown }

/**
 * tar.gz 解压：gunzip 之后就是 512 字节头 + 数据的顺序流，没有压缩，顺序读即可。
 * （Linux/macOS 的 llama.cpp 发行包是 .tar.gz，Windows 才是 zip。）
 */
function extractTarGz(buf: Buffer, destDir: string, options: ExtractOptions = {}): ExtractReport {
  let tar: Buffer
  try {
    tar = gunzipSync(buf)
  } catch (error) {
    throw new Error(`gzip 解压失败：${describeError(error)}`)
  }
  const entries = readTarEntries(tar)
  for (const entry of entries) assertSafeName(entry.name)
  const prefix = commonPrefix(entries.map((entry) => entry.name))
  let written = 0

  // 第一遍：普通文件。链接条目先记下来留到第二遍——tar 里链接可能排在目标
  // 文件**之前**，边解压边建链接会建出悬空链接。
  const links: PendingTarLink[] = []
  for (const entry of entries) {
    const rel = stripPrefix(entry.name, prefix)
    if (rel === '') continue
    const target = safeTarget(destDir, rel)
    if (entry.type === '5' || rel.endsWith('/')) continue
    if (entry.type === '2' || entry.type === '1') {
      links.push({ name: rel, target, type: entry.type, linkName: entry.linkName })
      continue
    }
    if (entry.type !== '0' && entry.type !== '\0') continue
    writeFile(target, entry.data, entry.mode)
    written++
  }

  // 第二遍：真正的链接。llama.cpp 的 Linux 发行包靠两级 SONAME 软链
  // （libllama-common.so → libllama-common.so.0 → libllama-common.so.0.9.0）
  // 让动态加载器找到库；只写普通文件的话 llama-server 会报
  // "cannot open shared object file" 并立即退出。
  const linkStats = createTarLinks(links, destDir, prefix, options)
  written += linkStats.symlinked + linkStats.hardlinked + linkStats.copied
  if (written === 0) throw new Error('压缩包里没有任何文件')
  return { written, links: linkStats }
}

/**
 * tar 第二遍：创建符号链接/硬链接，返回统计（不再静默跳过）。
 *
 * 为什么多轮：软链可以指向**另一条软链**（SONAME 就是 A→B→file 的两级链），
 * 而真实文件可能排在链接之后（见上面第一遍的注释）。每轮只重试还没建出来的
 * 那些，直到全部成功或一轮毫无进展——用轮数换顺序无关。
 *
 * 为什么退化复制：Android 共享存储（FAT/exFAT、/sdcard）不允许 symlink(2)，
 * 建链会 EPERM/ENOSYS。此时把**解析后的真实源**复制到链接位置，动态加载器
 * 照样能按 SONAME 找到库；宁可多占几 MB，也不要装完启动不了。硬链接则是
 * link(2) 不可用（跨设备/受限文件系统）时复制。
 *
 * 建不出来的不吞掉：失败数与明细进 ExtractLinkStats，由安装流程报 error。
 */
function createTarLinks(
  links: readonly PendingTarLink[],
  destDir: string,
  prefix: string,
  options: ExtractOptions,
): ExtractLinkStats {
  const stats = emptyLinkStats()
  const root = resolve(destDir)
  const symlink = options.symlink ?? symlinkSync
  const hardlink = options.hardlink ?? linkSync
  // 安全检查不通过的条目直接记失败（不重试）：恶意压缩包不该被当成「暂时失败」。
  const reject = (reason: string): void => {
    stats.failed++
    stats.failures.push(reason)
  }

  let pending: PreparedLink[] = []
  for (const link of links) {
    const rel = stripPrefix(link.linkName, prefix)
    if (link.type === '2') {
      // 安全：链接目标是归档内的相对路径，解析后必须仍在 destDir 内，
      // 否则一个恶意压缩包就能用 ../ 或绝对路径把软链指到任意位置。
      if (rel === '' || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) {
        reject(`${link.name} -> ${link.linkName}：链接目标为空或为绝对路径`)
        continue
      }
      const source = resolve(dirname(link.target), rel.replace(/\\/g, '/'))
      if (source !== root && !source.startsWith(root + sep)) {
        reject(`${link.name} -> ${link.linkName}：链接目标是安装目录之外的路径`)
        continue
      }
      pending.push({ kind: 'symlink', link, relative: rel, source })
      continue
    }
    // 硬链接：tar 的 linkName 是相对归档根的路径；link(2) 不可用就复制。
    let source: string | null = null
    let sourceError: unknown = null
    try {
      source = safeTarget(destDir, rel)
    } catch (error) {
      sourceError = error
    }
    if (source === null) {
      reject(`${link.name} -> ${link.linkName}：硬链接目标非法（${describeError(sourceError)}）`)
      continue
    }
    pending.push({ kind: 'hardlink', link, source })
  }

  while (pending.length > 0) {
    stats.rounds++
    const keep: PreparedLink[] = []
    for (const item of pending) {
      try {
        mkdirSync(dirname(item.link.target), { recursive: true })
        rmSync(item.link.target, { force: true })
        if (item.kind === 'symlink') {
          try {
            symlink(item.relative, item.link.target)
            stats.symlinked++
            continue
          } catch {
            // 软链建不出来（FAT/exFAT、Android 共享存储）→ 退化为复制真实源。
            // 源本身可能还是后一轮才建出来的链，这时复制会 ENOENT，留到下一轮。
            copyFileSync(item.source, item.link.target)
            stats.copied++
            continue
          }
        }
        try {
          hardlink(item.source, item.link.target)
          stats.hardlinked++
        } catch {
          copyFileSync(item.source, item.link.target)
          stats.copied++
        }
      } catch (error) {
        item.lastError = error
        keep.push(item)
      }
    }
    // 一整轮没有任何进展 → 剩下的永远不会成功，别死循环。
    if (keep.length === pending.length) {
      for (const item of keep) {
        reject(`${item.link.name} -> ${item.link.linkName}：${describeError(item.lastError)}`)
      }
      break
    }
    pending = keep
  }
  return stats
}

// ─────────────────────── 解压后校验：运行时链接 ───────────────────────

/** 一条解析不了的符号链接。 */
export interface RuntimeLinkIssue {
  /** 符号链接名（如 libllama-common.so.0），报错时直接告诉用户缺哪个库。 */
  name: string
  /** 链接里写的目标（原样，便于判断是链断了还是根本没解出来）。 */
  target: string
  /** 解析失败原因（ENOENT = 目标缺失；ELOOP = 链成环）。 */
  reason: string
}

/** verifyRuntimeLinks 的结果。 */
export interface RuntimeLinkCheck {
  /** 全部 SONAME 链接都能解析才为 true。 */
  ok: boolean
  /** 检查了多少条 SONAME 链接（0 表示这个包装本来就没有链接）。 */
  checked: number
  issues: RuntimeLinkIssue[]
}

/**
 * 只把「动态加载器会按名字去找的」链接算作必须能解析：`.so` / `.so.0` /
 * `.so.0.9.0` / macOS 的 `.dylib`。发行包里偶尔会有指向文档/目录的杂项软链，
 * 它们解析不了不影响 llama-server 启动，不该把安装判成失败。
 */
const SONAME_LINK = /\.(?:so(?:\.\d+)*|dylib)$/i

/**
 * 解压后校验：运行时目录里每条 SONAME 符号链接都必须能解析到真实文件。
 *
 * 为什么必须做：llama-server 是动态链接的，llama.cpp 的发行包用 SONAME 软链
 * 把 `libllama-common.so` → `.so.0` → `.so.0.9.0` 串起来。链接一旦缺失/悬空，
 * 安装流程本身「成功」了，用户点启动才看到
 * `cannot open shared object file` —— 那时根本不知道是哪个库、也不知道是
 * 文件系统不支持软链。所以解压完立刻跟随链接 stat 一遍，把库名与原因报出来。
 *
 * 只扫 destDir 之内、不跟随软链目录（避免环）；链接本身用 statSync 跟随解析。
 */
export function verifyRuntimeLinks(dir: string): RuntimeLinkCheck {
  const issues: RuntimeLinkIssue[] = []
  const links: string[] = []
  const walk = (current: string, depth: number): void => {
    if (depth > 3) return
    for (const entry of listEntries(current)) {
      const full = join(current, entry.name)
      // 注意：软链指向目录时 Dirent.isDirectory() 也是 false，所以这里不会跟进去。
      if (entry.isSymbolicLink()) {
        if (SONAME_LINK.test(entry.name)) links.push(full)
        continue
      }
      if (entry.isDirectory()) walk(full, depth + 1)
    }
  }
  walk(dir, 0)
  for (const link of links) {
    try {
      statSync(link) // 跟随软链：悬空 / 成环都会抛
    } catch (error) {
      let target = ''
      try {
        target = readlinkSync(link)
      } catch {
        // 读不到链接内容也不影响报错（名字已经能定位）
      }
      issues.push({ name: basename(link), target, reason: describeError(error) })
    }
  }
  return { ok: issues.length === 0, checked: links.length, issues }
}

function readTarEntries(tar: Buffer): TarEntry[] {
  const entries: TarEntry[] = []
  let offset = 0
  let longName: string | null = null
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (isZeroBlock(header)) break // 归档结束标记：两个全零块
    const size = readOctal(header, 124, 12)
    const mode = readOctal(header, 100, 8)
    const type = String.fromCharCode(header[156] ?? 0)
    const dataStart = offset + 512
    const dataEnd = dataStart + size
    if (dataEnd > tar.length) throw new Error('tar 归档已损坏（条目数据越界）')
    const namePrefix = readText(header, 345, 155) // ustar 的长路径前缀
    let name = readText(header, 0, 100)
    if (namePrefix !== '') name = `${namePrefix}/${name}`
    if (longName !== null) {
      name = longName
      longName = null
    }
    const next = dataStart + pad512(size)
    if (type === 'L') {
      // GNU 长文件名：这一条的数据就是下一条的名字。
      longName = tar.toString('utf8', dataStart, dataEnd).replace(/\0+$/, '')
      offset = next
      continue
    }
    if (type === 'x' || type === 'g') {
      // pax 扩展头（含 UTF-8 路径等元数据）：忽略内容，不影响普通条目。
      offset = next
      continue
    }
    entries.push({
      name,
      size,
      type,
      mode,
      linkName: readText(header, 157, 100),
      data: tar.subarray(dataStart, dataEnd),
    })
    offset = next
  }
  if (entries.length === 0) throw new Error('tar 归档里没有任何条目')
  return entries
}

function isZeroBlock(block: Buffer): boolean {
  for (const byte of block) {
    if (byte !== 0) return false
  }
  return true
}

/** tar 的数字字段是八进制 ASCII；GNU 的大文件用 base-256（首字节最高位为 1）。 */
function readOctal(buf: Buffer, offset: number, length: number): number {
  const first = buf[offset]
  if (first !== undefined && (first & 0x80) !== 0) {
    let value = first & 0x7f
    for (let i = 1; i < length; i++) value = value * 256 + (buf[offset + i] ?? 0)
    return value
  }
  const text = buf.toString('latin1', offset, offset + length).replace(/\0/g, ' ').trim()
  const value = Number.parseInt(text, 8)
  return Number.isFinite(value) ? value : 0
}

function readText(buf: Buffer, offset: number, length: number): string {
  return buf.toString('utf8', offset, offset + length).replace(/\0.*$/, '').trim()
}

function pad512(size: number): number {
  return Math.ceil(size / 512) * 512
}

// ─────────────────────── 路径安全 / 小工具 ───────────────────────

/**
 * 压缩包里所有条目共享的第一段目录（如 `llama-b11429/`），没有就返回 ''。
 * 剥掉它，解压结果才是「llamacpp/ 下直接躺着 llama-server.exe」这种既有布局；
 * 只有当**每一条**都带这个前缀时才剥，避免误伤顶层散落的文件。
 */
function commonPrefix(names: readonly string[]): string {
  const first = names[0]
  if (first === undefined) return ''
  const cut = first.indexOf('/')
  if (cut <= 0) return ''
  const head = first.slice(0, cut + 1)
  for (const name of names) {
    if (!name.startsWith(head)) return ''
  }
  return head
}

function stripPrefix(name: string, prefix: string): string {
  return prefix !== '' && name.startsWith(prefix) ? name.slice(prefix.length) : name
}

/**
 * 条目名的原始安全检查：绝对路径（`/x`、`C:/x`、`\\server\share`）与任何
 * `..` 段一律拒绝。必须在剥公共顶层目录**之前**做，否则 `C:/x.txt` 会先被
 * 剥成 `x.txt`，检查就形同虚设。
 */
function assertSafeName(rel: string): void {
  const clean = rel.replace(/\\/g, '/')
  if (clean.startsWith('/') || /^[A-Za-z]:/.test(clean)) {
    throw new Error(`压缩包条目使用了绝对路径：${rel}`)
  }
  for (const part of clean.split('/')) {
    if (part === '..') throw new Error(`压缩包条目试图跳出安装目录：${rel}`)
  }
}

/**
 * 把条目相对路径解析到 destDir 之内，越界就抛。
 * 压缩包是远端内容，绝对路径与 `..` 段都必须拒绝，否则一个恶意/被篡改的发行
 * 包就能往安装目录外写文件。这里再做一次解析边界校验，兜住拼接层面的意外。
 */
function safeTarget(destDir: string, rel: string): string {
  assertSafeName(rel)
  const root = resolve(destDir)
  const target = resolve(root, rel.replace(/\\/g, '/'))
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`压缩包条目试图跳出安装目录：${rel}`)
  }
  return target
}

function writeFile(target: string, data: Buffer, mode?: number): void {
  try {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, data)
    // tar 保留了权限位：不加这一步，Linux/macOS 上的 llama-server 落地就没有
    // 执行权限，spawn 直接 EACCES。
    if (mode !== undefined && process.platform !== 'win32') chmodSync(target, mode & 0o777)
  } catch (error) {
    throw diskError(`写入 ${target}`, error)
  }
}

function ensureDir(dir: string, what: string): void {
  try {
    mkdirSync(dir, { recursive: true })
  } catch (error) {
    throw diskError(what, error)
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** readdir 的安全版：目录读不了（权限/刚被删）就当空目录，绝不抛。 */
function listEntries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function fileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function parseContentLength(header: string | null): number | null {
  if (header === null) return null
  const value = Number.parseInt(header, 10)
  return Number.isFinite(value) && value >= 0 ? value : null
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  return (error as { name?: unknown }).name === 'AbortError'
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** 把底层 fs 错误翻译成面板能看懂的话（缺权限 / 磁盘满是最常见的两种）。 */
function diskError(what: string, error: unknown): Error {
  const code = (error as { code?: unknown } | null)?.code
  const detail = describeError(error)
  if (typeof code === 'string' && ['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EBUSY', 'EMFILE', 'ENFILE'].includes(code)) {
    return new Error(`磁盘写入失败（${what}）：${detail}`)
  }
  return error instanceof Error ? error : new Error(`${what}：${detail}`)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const mb = bytes / (1024 * 1024)
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  return `${(mb / 1024).toFixed(2)} GB`
}

/** 「需要释放多少」固定用 GB 说：MB 级差额对用户没有意义，GB 才是决策单位。 */
function formatGb(bytes: number): string {
  return `${(Math.max(0, bytes) / (1024 * 1024 * 1024)).toFixed(2)}GB`
}

/** 模型下载要预留的字节数：已存在则 0，否则按已知体积 ×1.25（.part + 元数据）。 */
function modelDiskNeedBytes(paths: InstallPaths, model: InstallModel): number {
  if (isFile(paths.model)) return 0
  const bytes = model.bytes !== undefined && model.bytes > 0 ? model.bytes : MODEL_SIZE_BYTES
  return Math.ceil(bytes * MODEL_DISK_FACTOR)
}

/** 运行时解压要预留的字节数：exe 已在（上次已解开）就不重复算。 */
function runtimeDiskNeedBytes(paths: InstallPaths, flavor: RuntimeFlavor): number {
  return isFile(paths.exe) ? 0 : (RUNTIME_RESERVE_BYTES[flavor] ?? RUNTIME_RESERVE_BYTES.cpu)
}

/**
 * 下载前磁盘预检：模型 ×1.25 + 运行时解压余量 + 200MB 额外余量。
 * 已经就位的部分不重复计——断点续装（运行时已解开、只差模型）不会被误拦。
 */
export function diskNeedBytes(paths: InstallPaths, model: InstallModel, flavor: RuntimeFlavor): number {
  return modelDiskNeedBytes(paths, model) + runtimeDiskNeedBytes(paths, flavor) + EXTRA_DISK_RESERVE_BYTES
}

/**
 * statfsSync 读 dir 所在文件系统的可用字节数；读不到（老内核 / 权限 / 非常规
 * 文件系统）返回 null —— 预检失败就跳过预检，绝不能因为「读不到」把安装拦死。
 * 与 hardware.ts 的 freeDiskMb 同一思路，但这里不依赖 hardware（零耦合）。
 */
export function freeDiskBytes(dir: string): number | null {
  try {
    const stat = statfsSync(dir)
    const bytes = Number(stat.bavail) * Number(stat.bsize)
    return Number.isFinite(bytes) && bytes >= 0 ? bytes : null
  } catch {
    return null
  }
}

function urlHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** 等一个背压 drain；顺手把流错误也变成 reject，免得卡死。 */
function waitDrain(stream: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    const onDrain = (): void => { cleanup(); resolve() }
    const onError = (error: Error): void => { cleanup(); reject(error) }
    const cleanup = (): void => {
      stream.off('drain', onDrain)
      stream.off('error', onError)
    }
    stream.once('drain', onDrain)
    stream.once('error', onError)
  })
}

function closeStream(stream: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once('error', reject)
    stream.end(() => resolve())
  })
}

// ────────────────────────── 安装器本体 ──────────────────────────

/**
 * 下载 + 解压 + 校验。用法（面板按钮）：
 *   const installer = new VectorInstaller({ root, onProgress: p => render(p) })
 *   installer.start()    // fire-and-forget，绝不抛
 *   installer.cancel()   // 中止并清理 .part
 *   installer.progress   // 随时读快照
 */
export class VectorInstaller {
  private readonly opts: InstallerOptions
  private state: InstallProgress = {
    phase: 'idle',
    message: '',
    receivedBytes: 0,
    totalBytes: null,
    error: null,
    paths: null,
  }
  private running = false
  private cancelled = false
  /** 每轮 cancel 自增：在途 run() 用它判断自己是否已经过期（别再改状态）。 */
  private generation = 0
  private controller: AbortController | null = null
  /** 当前正在写的 .part 与它的流（取消时要立刻销毁，否则 fd 悬着）。 */
  private sink: { gen: number; part: string; stream: WriteStream } | null = null

  constructor(opts: InstallerOptions) {
    this.opts = opts
  }

  /** 状态快照（返回副本，调用方改不动内部状态）。 */
  get progress(): InstallProgress {
    return { ...this.state }
  }

  /** 幂等：已在跑、或已装好，直接返回。 */
  start(): void {
    if (this.running) return
    const installed = detectInstalled(this.opts.root)
    if (installed) {
      this.report(this.generation, {
        phase: 'done',
        message: '向量后端已就绪，无需下载',
        error: null,
        receivedBytes: 0,
        totalBytes: null,
        paths: installed,
      })
      return
    }
    const gen = this.generation
    this.running = true
    this.cancelled = false
    this.controller = new AbortController()
    // 关键：不 await、不 rethrow。start() 的调用方是 UI 事件处理器，
    // 一个未捕获的 rejection 会在宿主里变成 unhandledRejection。
    void this.run(gen)
      .catch((error: unknown) => {
        if (gen !== this.generation || this.cancelled) return
        this.fail(error)
      })
      .finally(() => {
        if (gen === this.generation) {
          this.running = false
          this.controller = null
        }
      })
  }

  /** 取消：中止在途请求、销毁 .part、phase 回到 idle。没在跑就是 no-op。 */
  cancel(): void {
    if (!this.running && this.controller === null) return
    this.generation++
    this.cancelled = true
    this.running = false
    const controller = this.controller
    this.controller = null
    controller?.abort()
    this.dropSink()
    this.report(this.generation, {
      phase: 'idle',
      message: '已取消',
      error: null,
      receivedBytes: 0,
      totalBytes: null,
      paths: null,
    })
  }

  private async run(gen: number): Promise<void> {
    const root = this.opts.root
    const platform = this.opts.platform ?? process.platform
    const arch = this.opts.arch ?? process.arch
    // 所选模型:不给就是内置的 bge-m3 Q4_K_M(与合并前行为一致)。
    const model: InstallModel = this.opts.model ?? {
      file: MODEL_FILE_NAME,
      bytes: MODEL_SIZE_BYTES,
      ...(this.opts.modelSources ? { sources: this.opts.modelSources } : {}),
    }
    const flavor: RuntimeFlavor = this.opts.flavor ?? 'cpu'
    const paths = installPaths(root, model.file)
    try {
      this.setPhase(gen, 'preparing', `准备安装目录 ${root}`)
      ensureDir(root, '创建安装根目录')
      ensureDir(paths.dir, '创建运行时目录')
      ensureDir(dirname(paths.model), '创建模型目录')

      // 下载前磁盘预检：statfs 只有目标路径存在才量得准，所以放在建目录之后、
      // **任何下载之前**。空间不够就先报错——下到一半 ENOSPC 会留下半个文件，
      // 用户还得自己找地方清理。
      const need = diskNeedBytes(paths, model, flavor)
      const free = (this.opts.freeBytes ?? freeDiskBytes)(root)
      this.setPhase(gen, 'preparing', `磁盘预检：需要约 ${formatBytes(need)}，可用 ${free === null ? '未知（跳过预检）' : formatBytes(free)}`)
      if (free !== null && free < need) {
        throw new Error(
          `磁盘空间不足：安装需要约 ${formatBytes(need)}（模型按体积 ×1.25 预留 + 运行时解压 + 200MB 余量），` +
          `安装目录 ${root} 所在磁盘只剩 ${formatBytes(free)}，请至少再释放约 ${formatGb(need - free)} 后重试`,
        )
      }

      const asset = await this.resolveRuntimeAsset(gen, platform, arch, flavor)
      const archivePath = join(paths.dir, asset.name)
      if (fileSize(archivePath) > 0) {
        // 上轮下完但解压/下模型失败：压缩包还在，别白下第二遍。
        this.setPhase(gen, 'downloading-runtime', `已存在 ${asset.name}，跳过下载`, { receivedBytes: 0, totalBytes: null })
      } else {
        this.setPhase(gen, 'downloading-runtime', `正在下载 llama.cpp 运行时 ${asset.name}`)
        const got = await this.downloadFrom(gen, runtimeDownloadSources(asset), archivePath, 'llama.cpp 运行时', 'downloading-runtime', '通道')
        // 成功日志里写清走的哪条通道：直链还是 API 资产端点，排障时第一眼要看的就是它。
        this.report(gen, { message: `运行时下载完成（${formatBytes(got.bytes)}，通道：${got.source.label}）` })
      }

      this.setPhase(gen, 'extracting', `正在解压 ${asset.name}`)
      let archive: Buffer
      try {
        archive = readFileSync(archivePath)
      } catch (error) {
        throw diskError(`读取 ${archivePath}`, error)
      }
      let written = 0
      // 链接失败要跨「主包 + CUDA 伴生包」累计：任何一个包里的 SONAME 链接建不
      // 起来，装完都会启动失败，不能因为失败发生在不同压缩包里就漏报。
      let failedLinks = 0
      const linkFailures: string[] = []
      try {
        const report = extractArchiveReport(archive, paths.dir)
        written += report.written
        failedLinks += report.links.failed
        linkFailures.push(...report.links.failures)
      } catch (error) {
        // 解压失败说明压缩包本身坏了：删掉它，下次点击会重新下载，
        // 而不是每次都撞同一个坏文件（.part 早就没了，这个包是「完整但损坏」）。
        try { rmSync(archivePath, { force: true }) } catch { /* 尽力而为 */ }
        throw error
      }
      // CUDA 风味:主包只有 llama-server 本体,cuBLAS/cudart 在**另一个**资产里,
      // 两个包必须来自同一套工具链(靠 cuda 次版本号配对),所以一起下一起解压。
      const companion = await this.resolveRuntimeCompanion(gen, platform, arch, flavor)
      if (companion !== null) {
        const companionPath = join(paths.dir, companion.name)
        if (fileSize(companionPath) === 0) {
          this.setPhase(gen, 'downloading-runtime', `正在下载 CUDA 运行库 ${companion.name}`)
          const got = await this.downloadFrom(gen, runtimeDownloadSources(companion), companionPath, 'CUDA 运行库', 'downloading-runtime', '通道')
          this.report(gen, { message: `CUDA 运行库下载完成（${formatBytes(got.bytes)}，通道：${got.source.label}）` })
        }
        try {
          const report = extractArchiveReport(readFileSync(companionPath), paths.dir)
          written += report.written
          failedLinks += report.links.failed
          linkFailures.push(...report.links.failures)
        } catch (error) {
          try { rmSync(companionPath, { force: true }) } catch { /* 尽力而为 */ }
          throw error
        }
      }
      if (!existsSync(paths.exe)) {
        throw new Error(`解压完成但没找到 ${basename(paths.exe)}：${asset.name} 的目录结构可能变了`)
      }
      if (platform !== 'win32') {
        // tar 的权限位在大多数归档里是齐的，这里再兜一次底。
        try { chmodSync(paths.exe, 0o755) } catch { /* 尽力而为 */ }
      }
      // 解压后校验：SONAME 软链必须都能解析。链接缺失/悬空的包在「装完」这一刻
      // 是看不出来的，用户点启动才报 cannot open shared object file——所以在这里
      // 拦住，并把缺哪个库、为什么（软链不支持/目标缺失）写进 message。
      const linkCheck = verifyRuntimeLinks(paths.dir)
      if (failedLinks > 0 || !linkCheck.ok) {
        const problems: string[] = []
        if (failedLinks > 0) {
          const shown = linkFailures.slice(0, 3).join('；')
          problems.push(`${failedLinks} 个链接既没建成软链也复制失败（${shown}${linkFailures.length > 3 ? '；…' : ''}）`)
        }
        for (const issue of linkCheck.issues.slice(0, 5)) {
          problems.push(`链接 ${issue.name} -> ${issue.target === '' ? '?' : issue.target} 无法解析（${issue.reason}）`)
        }
        if (linkCheck.issues.length > 5) problems.push(`还有 ${linkCheck.issues.length - 5} 条链接无法解析`)
        throw new Error(
          `运行时校验失败：${problems.join('；')}。llama-server 启动会报 cannot open shared object file。` +
          `若安装目录在不支持符号链接的文件系统（FAT/exFAT、部分 Android 共享存储）上，请把安装目录换到 ext4/f2fs 分区后重试`,
        )
      }
      this.setPhase(gen, 'extracting', `已解压 ${written} 个文件（检查 ${linkCheck.checked} 条链接）`)

      if (fileSize(paths.model) > 0) {
        // 模型几百 MB 起步，重下一次代价太大：已经在就直接用。
        this.setPhase(gen, 'downloading-model', '模型已存在，跳过下载', { receivedBytes: 0, totalBytes: null })
      } else {
        this.setPhase(gen, 'downloading-model', `正在下载 ${model.file}${model.bytes !== undefined ? `（约 ${formatBytes(model.bytes)}）` : ''}`)
        const got = await this.downloadModel(gen, paths.model, model)
        this.report(gen, { message: `模型下载完成（已下载 ${formatBytes(got.bytes)}，来源：${got.source.label}）` })
      }

      const installed = detectInstalled(root, model.file)
      if (installed === null) throw new Error('安装校验失败：llama-server 或模型文件缺失')
      this.report(gen, {
        phase: 'done',
        message: `安装完成：模型 ${formatBytes(fileSize(installed.model))}，运行时 ${basename(installed.exe)}`,
        error: null,
        receivedBytes: 0,
        totalBytes: null,
        paths: installed,
      })
    } catch (error) {
      // 取消不是错误：清掉半成品，回到 idle（面板据此把进度条收起来）。
      if (this.cancelled || gen !== this.generation || isAbortError(error)) {
        if (this.sink?.gen === gen) this.dropSink()
        this.setPhase(gen, 'idle', '已取消')
        return
      }
      throw error
    }
  }

  /**
   * 查发行版列表 → 按平台 + 风味挑包。latest 不可用（见下），按时间倒序取第一个命中的。
   *
   * 风味包找不到时**退回 CPU 包**并说明原因：装得上但慢,好过装不上。
   */
  private async resolveRuntimeAsset(
    gen: number,
    platform: NodeJS.Platform,
    arch: string,
    flavor: RuntimeFlavor,
  ): Promise<RuntimeAsset> {
    const pattern = runtimeAssetPattern(platform, arch, flavor)
    const label = `${platform}-${arch} ${flavor}`
    this.report(gen, { message: `正在查询 llama.cpp 最新构建（${label}）` })
    // 注意：不要用 /releases/latest。llama.cpp 的 b#### 构建线全部带
    // prerelease:true，而 latest 只认正式版，现在返回的是一个与本项目无关的
    // v0.6.0（资产只有 nightly-tag.txt）——照它匹配必然失败。正确做法是拉倒序
    // 列表，取第一个含匹配资产的 release（prerelease 与否无关）。
    const releases = await this.fetchJson(RELEASES_API, '查询 llama.cpp 发行版')
    if (!Array.isArray(releases)) throw new Error('llama.cpp 发行版接口返回的数据格式异常')
    const wanted = flavor === 'metal' ? 'cpu' : flavor
    const hit = findAssetInReleases(releases, pattern)
    if (hit !== null) return hit
    if (wanted !== 'cpu') {
      const fallback = findAssetInReleases(releases, runtimeAssetPattern(platform, arch, 'cpu'))
      if (fallback !== null) {
        this.report(gen, {
          message: `最近 20 个发行版里没有 ${wanted} 运行时（匹配 ${String(pattern)}），已改用 CPU 运行时；想在 GPU 上跑可以自己装好再把 spawn.exe 指过去`,
        })
        return fallback
      }
    }
    throw new Error(`资产匹配失败：${label}（最近 20 个发行版里没有匹配 ${String(pattern)} 的包）`)
  }

  /** CUDA 风味的 cudart 伴随包;非 cuda 或无匹配返回 null(不阻塞安装)。 */
  private async resolveRuntimeCompanion(
    gen: number,
    platform: NodeJS.Platform,
    arch: string,
    flavor: RuntimeFlavor,
  ): Promise<RuntimeAsset | null> {
    const pattern = runtimeCompanionPattern(platform, arch, flavor)
    if (pattern === null) return null
    const releases = await this.fetchJson(RELEASES_API, '查询 llama.cpp 发行版')
    if (!Array.isArray(releases)) return null
    const hit = findAssetInReleases(releases, pattern)
    if (hit === null) {
      this.report(gen, { message: `没有找到 CUDA 运行库（匹配 ${String(pattern)}）：llama-server 可能起不来，可改用 Vulkan 或 CPU 运行时` })
    }
    return hit
  }

  /** 模型下载：多源顺序回退（noun 只影响报错文案）。 */
  private async downloadModel(gen: number, dest: string, model: InstallModel): Promise<{ bytes: number; source: DownloadSource }> {
    const urls: readonly string[] = model.sources ?? this.opts.modelSources ?? MODEL_SOURCES
    const sources = urls.map((url): DownloadSource => ({ url, accept: '*/*', label: urlHost(url) }))
    return this.downloadFrom(gen, sources, dest, model.file, 'downloading-model', '源')
  }

  /**
   * 按候选顺序下载，当前候选失败（网络错误 / 非 2xx / 中途断流）就换下一个，
   * 每个候选都从 0 重新下（不做断点续传，失败时 download() 已经清掉 .part）。
   * 全部失败时把所有候选各自的原因一起报出来——只报一句「下载失败」的话，用户
   * 根本分不清是墙、是 DNS、还是磁盘满。
   */
  private async downloadFrom(
    gen: number,
    sources: readonly DownloadSource[],
    dest: string,
    what: string,
    phase: InstallPhase,
    noun: string,
  ): Promise<{ bytes: number; source: DownloadSource }> {
    const failures: string[] = []
    for (const source of sources) {
      try {
        const bytes = await this.download(gen, source, dest, what, phase)
        return { bytes, source }
      } catch (error) {
        if (this.cancelled || isAbortError(error)) throw error
        const reason = describeError(error)
        const host = urlHost(source.url)
        // 通道名里已经含主机名（模型源就是这么标的）时不要重复一遍。
        const who = source.label.includes(host) ? source.label : `${source.label}（${host}）`
        failures.push(`${who}：${reason}`)
        this.report(gen, {
          message: `${who} 下载失败（${reason}），换下一个${noun}重试`,
          receivedBytes: 0,
          totalBytes: null,
        })
      }
    }
    if (failures.length === 0) throw new Error(`下载${what}失败：没有配置任何下载${noun}`)
    throw new Error(`下载${what}失败：所有${noun}都失败\n${failures.map((line) => ` - ${line}`).join('\n')}`)
  }

  /**
   * 流式下载到 dest：先写 `<dest>.part`，完整收流后 rename。
   * 每收到一块就上报一次 receivedBytes（面板的百分比来源）。
   */
  private async download(
    gen: number,
    source: DownloadSource,
    dest: string,
    what: string,
    phase: InstallPhase,
  ): Promise<number> {
    const url = source.url
    const part = `${dest}.part`
    const res = await this.request(url, source.accept)
    if (!res.ok) {
      throw new Error(`下载${what}失败：HTTP ${res.status}${res.statusText !== '' ? ` ${res.statusText}` : ''}（${url}）`)
    }
    const total = parseContentLength(res.headers.get('content-length')) // 拿不到就是 null
    const body = res.body
    if (body === null) throw new Error(`下载${what}失败：响应没有可读的数据流`)
    const reader = body.getReader()
    const stream = createWriteStream(part, { flags: 'w' })
    this.sink = { gen, part, stream }
    // 用容器而不是裸 let：错误在回调里赋值、在循环里读，容器能让 TS 的类型收窄
    // 保持可预测（裸 let 在闭包里赋值后收窄会被重置/变 never）。
    const failure: { error: Error | null } = { error: null }
    stream.on('error', (error) => { failure.error = error })
    let received = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        const value = chunk.value
        if (value === undefined || value.byteLength === 0) continue
        received += value.byteLength
        if (!stream.write(value)) await waitDrain(stream)
        if (failure.error !== null) throw failure.error
        this.report(gen, { phase, receivedBytes: received, totalBytes: total, error: null })
      }
      await closeStream(stream)
      if (failure.error !== null) throw failure.error
    } catch (error) {
      try { stream.destroy() } catch { /* 已经坏了 */ }
      try { rmSync(part, { force: true }) } catch { /* 尽力而为 */ }
      if (this.sink?.part === part) this.sink = null
      // 写盘失败（磁盘满/无权限）要说得明白，别把 ERR_STREAM 之类的丢给用户。
      if (failure.error !== null && !isAbortError(error)) throw diskError(`写入 ${part}`, failure.error)
      throw error
    }
    try {
      renameSync(part, dest)
    } catch (error) {
      if (this.sink?.part === part) this.sink = null
      throw diskError(`重命名 ${dest}`, error)
    }
    if (this.sink?.part === part) this.sink = null
    this.report(gen, { phase, receivedBytes: received, totalBytes: total, error: null })
    return received
  }

  /** 发一个带 UA 的请求；网络层错误翻译成人话，但 AbortError 原样上抛。 */
  private async request(url: string, accept: string): Promise<Response> {
    const impl = this.opts.fetchImpl ?? fetch
    const signal = this.requestSignal()
    try {
      return await impl(url, { headers: { accept, 'user-agent': USER_AGENT }, signal, redirect: 'follow' })
    } catch (error) {
      if (isAbortError(error)) throw error
      throw new Error(`网络请求失败（${urlHost(url)}）：${describeError(error)}`)
    }
  }

  private async fetchJson(url: string, what: string): Promise<unknown> {
    const res = await this.request(url, 'application/vnd.github+json')
    if (res.status === 403 || res.status === 429) {
      throw new Error('GitHub API 限流（未认证请求每小时 60 次），请稍后重试')
    }
    if (!res.ok) throw new Error(`${what}失败：HTTP ${res.status}（${url}）`)
    try {
      return await res.json()
    } catch (error) {
      throw new Error(`${what}返回的不是合法 JSON：${describeError(error)}`)
    }
  }

  /** 自带 controller + 调用方 signal 的合并信号。 */
  private requestSignal(): AbortSignal {
    const external = this.opts.signal
    const controller = this.controller
    if (controller === null) return external ?? new AbortController().signal
    return external === undefined ? controller.signal : AbortSignal.any([controller.signal, external])
  }

  /** 销毁在途的 .part 流并删文件（取消路径）。 */
  private dropSink(): void {
    const sink = this.sink
    this.sink = null
    if (sink === null) return
    try { sink.stream.destroy() } catch { /* 已经坏了 */ }
    try { rmSync(sink.part, { force: true }) } catch { /* 尽力而为 */ }
  }

  private fail(error: unknown): void {
    this.dropSink()
    const message = describeError(error)
    this.report(this.generation, {
      phase: 'error',
      message,
      error: message,
      totalBytes: null,
      paths: detectInstalled(this.opts.root),
    })
  }

  /** 状态上报；gen 过期（已被 cancel 顶掉）就整条丢掉，不污染新一轮。 */
  private report(gen: number, patch: Partial<InstallProgress>): void {
    if (gen !== this.generation) return
    this.state = { ...this.state, ...patch }
    const listener = this.opts.onProgress
    if (listener === undefined) return
    try {
      listener({ ...this.state })
    } catch {
      // 面板回调自己出错，不能把安装带崩
    }
  }

  /** 切阶段：进度一律清零，免得面板把上一个文件的字节数算到新阶段头上。 */
  private setPhase(gen: number, phase: InstallPhase, message: string, extra: Partial<InstallProgress> = {}): void {
    this.report(gen, { phase, message, error: null, receivedBytes: 0, totalBytes: null, ...extra })
  }
}
