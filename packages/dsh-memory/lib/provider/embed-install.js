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
 *  - 断了要能接上：.part 续传（Range + If-Range），400MB+ 的 GGUF 断一次不该重下；
 *    但**换源不续**（不同镜像可能不是同一份文件），且续传结果必须过总长校验；
 *  - 收完必须验完整：总长对不上就删 .part；配置了 sha256 就必须逐字节对上——
 *    镜像篡改/拼接错位这类事后很难查的问题，在下载结束这一刻就要拦住；
 *  - 装完必须冒烟：解压校验通过、模型就位后再跑一次 `exe --version`。链接检查
 *    只能证明文件在，冒烟能证明「这台机器真的跑得起来」（缺 glibc loader、CPU
 *    指令集不匹配、解压被截断都在这时候暴露），失败就把 exe 摘掉，免得下次
 *    start() 因为 detectInstalled 直接报「已就绪」把坏安装当成功；
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
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, createReadStream, createWriteStream, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, statfsSync, symlinkSync, writeFileSync } from 'node:fs'
                                                  
import { basename, dirname, join, resolve, sep } from 'node:path'
import { gunzipSync, inflateRawSync } from 'node:zlib'
                                                  
import { assetPlatform, detectPlatform, glibcLoaderFor, isLinuxLike, readElfInterpFromFile } from './platform.js'

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
export const MODEL_SOURCES                    = [
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
const RUNTIME_RESERVE_BYTES                                = {
  cpu: 256 * 1024 * 1024,
  metal: 256 * 1024 * 1024,
  vulkan: 384 * 1024 * 1024,
  cuda: 1536 * 1024 * 1024,
}
/** 额外余量：日志、文件系统元数据、系统随时回收的那部分，别把盘写满到 0。 */
const EXTRA_DISK_RESERVE_BYTES = 200 * 1024 * 1024

/** 安装布局。与手工装好的既有布局一致（embed-server 直接吃这几个字段）。 */
                               
                                          
              
                                
             
                                                          
             
                                                  
             
                                                     
               
                                  
                 
     
                                                                             
                                               
     
                  
 

/** 要安装的模型：文件名是唯一事实来源（落盘名 + 「装没装」判据）。 */
                               
              
                                                
                
                                                     
                    
     
                                              
                                                   
                                      
     
                 
 

/** 安装状态机。idle/error 都可能再次 start()。 */
                          
          
               
                         
                
                       
               
          
           

/**
 * 面板直接渲染的快照。receivedBytes/totalBytes 是**当前这一个文件**的进度
 * （totalBytes 取 content-length，拿不到就是 null），所以百分比 =
 * receivedBytes/totalBytes 才有意义。
 */
                                  
                     
                 
                       
                           
                      
                            
 

                                   
                                                          
              
                                           
                          
                                      
                                           
                                                      
                      
     
                                                           
                 
     
                      
                                                               
                        
                                                         
                         
                                        
                            
                         
               
     
                                                        
                               
     
                                            
     
                                                   
          
                                              
                                             
                      
     
                                                           
     
                                                               
                                                       
                               
     
                             
     
                                                           
                                             
                                         
     
                           
     
                                                            
              
     
                        
 

/** zip 中央目录里一条记录（只保留解压需要的字段）。 */
                    
              
                
                        
                          
                
                
 

/** tar 里一条记录。 */
                    
              
              
                                                   
              
                            
               
                  
              
 

export function installPaths(root        , modelFile         = MODEL_FILE_NAME)               {
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
 * 已安装则返回布局，否则 null（判据：**所选模型的**文件在，且运行时可用）。
 *
 * 运行时可以是两种来源：
 *  - 托管：`<root>/llamacpp/llama-server`（一键安装下载的）
 *  - 系统：`options.systemExe`（如 Termux `pkg install llama-cpp` 的
 *    `$PREFIX/bin/llama-server`），此时只有模型需要下载 —— 这是 Termux /
 *    Android 的原生路径：bionic 二进制，不需要 glibc loader 兼容层。
 *
 * 只看「存在」就够：安装器永远先写 .part 再 rename，所以这两个路径上不可能
 * 出现半成品；反过来，用户手工放好的文件也会被如实采纳（这正是
 * `<root>/llamacpp` + `<root>/models` 这套既有布局的意义）。
 * 绝不抛异常：它在 resolveConfig 里被同步调用。
 */
                                         
                                                
                           
                                                           
                        
 

export function detectInstalled(
  root        ,
  modelFile         = MODEL_FILE_NAME,
  options                         = {},
)                      {
  try {
    const paths = installPaths(root, modelFile)
    if (!isFile(paths.model)) return null
    const systemCandidate = options.systemExe ?? null
    const systemExe = systemCandidate !== null && isFile(systemCandidate) ? systemCandidate : null
    const asSystem = ()               => ({ ...paths, exe: systemExe          , cwd: dirname(systemExe          ), system: true })
    if (options.preferSystem === true && systemExe !== null) return asSystem()
    if (isFile(paths.exe)) return paths
    if (systemExe !== null) return asSystem()
    return null
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
  platform                 ,
  arch        ,
  flavor                = 'cpu',
)         {
  const key = `${assetPlatform(platform)}-${arch}`
  const cpu = ()         => {
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
/** 该平台 + 架构是否有可用的托管运行时发行资产（决定 autoBootstrap=always 能不能兜底）。 */
export function supportsManagedRuntime(platform                 , arch        )          {
  try {
    runtimeAssetPattern(platform, arch)
    return true
  } catch {
    return false
  }
}

export function runtimeCompanionPattern(
  platform                 ,
  arch        ,
  flavor               ,
)                {
  if (flavor !== 'cuda') return null
  switch (`${assetPlatform(platform)}-${arch}`) {
    case 'win32-x64': return /^cudart-.*bin-win-cuda-12\.4-x64\.zip$/
    case 'win32-arm64': return /^cudart-.*bin-win-cuda-13\.4-arm64\.zip$/
    case 'linux-x64': return /^cudart-.*bin-ubuntu-cuda-12\.8-x64\.tar\.gz$/
    case 'linux-arm64': return /^cudart-.*bin-ubuntu-cuda-13\.4-arm64\.tar\.gz$/
    default: return null
  }
}

/** 一个发行资产的两条下载通道（见 runtimeDownloadSources）。 */
                               
              
                                                 
             
                                                                   
                
 

/** 在一批 GitHub 资产里按平台 + 风味挑第一个匹配的包。 */
export function pickRuntimeAsset(
  assets                    ,
  platform                 ,
  arch        ,
  flavor                = 'cpu',
)                      {
  return matchAsset(assets, runtimeAssetPattern(platform, arch, flavor))
}

/** 挑 CUDA 的 cudart 伴随包(非 cuda 风味或无匹配时为 null)。 */
export function pickRuntimeCompanion(
  assets                    ,
  platform                 ,
  arch        ,
  flavor               ,
)                      {
  const pattern = runtimeCompanionPattern(platform, arch, flavor)
  return pattern === null ? null : matchAsset(assets, pattern)
}

function matchAsset(assets                    , pattern        )                      {
  for (const asset of assets) {
    if (typeof asset !== 'object' || asset === null) continue
    const name = (asset                      ).name
    const url = (asset                                      ).browser_download_url
    const apiUrl = (asset                     ).url
    if (typeof name !== 'string' || typeof url !== 'string') continue
    if (pattern.test(name)) return { name, url, apiUrl: typeof apiUrl === 'string' ? apiUrl : '' }
  }
  return null
}

/** 在倒序的发行版列表里找第一个含匹配资产的 release（latest 不可用，见 resolveRuntimeAsset）。 */
function findAssetInReleases(releases                    , pattern        )                      {
  for (const release of releases) {
    if (typeof release !== 'object' || release === null) continue
    const assets = (release                        ).assets
    if (!Array.isArray(assets)) continue
    const hit = matchAsset(assets, pattern)
    if (hit !== null) return hit
  }
  return null
}

/** 一个下载候选通道。 */
                          
             
                         
                
                                 
               
 

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
export function runtimeDownloadSources(asset              )                   {
  const sources                   = [
    { url: asset.url, accept: '*/*', label: '发行包直链' },
  ]
  const withAccept                 = { url: asset.apiUrl, accept: 'application/octet-stream', label: 'GitHub API 资产端点' }
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
export function extractArchive(archive        , destDir        , options                 = {})         {
  return extractArchiveReport(archive, destDir, options).written
}

/**
 * 解压的可注入依赖（只给测试用：模拟不支持符号链接/硬链接的文件系统）。
 * 生产路径一律走 fs 原语，不引入任何依赖。
 */
                                 
                                                       
                                              
                                            
                                               
 

/** tar 第二遍（建链接）的统计：上层据此判断「链接到底建没建起来」。 */
                                   
                                                                   
                   
                   
                    
                                   
                
                                        
                
                                              
                
                                      
                    
 

/** 解压结果。written = 普通文件 + 建成功的链接，与 extractArchive() 的返回值一致。 */
                                
                 
                         
 

function emptyLinkStats()                   {
  return { symlinked: 0, hardlinked: 0, copied: 0, failed: 0, rounds: 0, failures: [] }
}

/** 解压并带回链接统计（zip 没有链接，links 全零）。 */
export function extractArchiveReport(archive        , destDir        , options                 = {})                {
  if (archive.length >= 4 && archive[0] === 0x50 && archive[1] === 0x4b) {
    return { written: extractZip(archive, destDir), links: emptyLinkStats() }
  }
  if (archive.length >= 2 && archive[0] === 0x1f && archive[1] === 0x8b) return extractTarGz(archive, destDir, options)
  throw new Error('不支持的压缩格式：既不是 zip（PK）也不是 gzip（1f 8b）')
}

// ───────────────────────────── zip ─────────────────────────────

/** 从尾部往前找 End of Central Directory（最多回扫 65557 字节 = 22 + 注释上限）。 */
function findEocd(buf        )         {
  const floor = Math.max(0, buf.length - 65_557)
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i
  }
  throw new Error('不是有效的 ZIP 文件：找不到中央目录结尾记录')
}

/** 读中央目录（解压前先拿到全部条目的名字/大小/压缩方式/偏移）。 */
function readZipEntries(buf        )             {
  const eocd = findEocd(buf)
  const count = buf.readUInt16LE(eocd + 10)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || cdOffset === 0xffffffff) {
    // 这些哨兵值代表真实信息在 ZIP64 记录里——llama.cpp 的包远没到 4GB，不实现。
    throw new Error('暂不支持 ZIP64 归档')
  }
  const entries             = []
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

/** zip 单条解压上限（llama.cpp 运行时里最大的文件 ~200MB，留足余量）。 */
const MAX_ZIP_ENTRY_BYTES = 1_500 * 1024 * 1024
/** 单个归档解压总量上限：多条小条目累计解压同样能打爆低内存 Android。 */
const MAX_ZIP_TOTAL_BYTES = 2_500 * 1024 * 1024

/** 取一条条目的原始（未压缩）内容。stored/deflate 之外一律明确报错。 */
function readZipEntryData(buf        , entry          )         {
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
    // 解压炸弹防护：中央目录声明的解压尺寸就是上限（+1 字节让「实际更大」
    // 变成一个明确的解压失败，而不是悄悄吃掉几百 MB 内存）。
    const limit = Math.min(entry.uncompressedSize, MAX_ZIP_ENTRY_BYTES) + 1
    try {
      return inflateRawSync(raw, { maxOutputLength: Math.max(1, limit) })
    } catch (error) {
      throw new Error(`解压条目失败：${entry.name}（${describeError(error)}）`)
    }
  }
  throw new Error(`不支持的 ZIP 压缩方式：${entry.method}（仅支持 stored=0 / deflate=8）`)
}

function extractZip(buf        , destDir        )         {
  const entries = readZipEntries(buf)
  // 先按**原始条目名**做一次安全检查：剥掉公共顶层目录之后再看就晚了
  // （`C:/x.txt` 这种绝对路径一剥就变成无害的相对路径了）。
  for (const entry of entries) assertSafeName(entry.name)
  const prefix = commonPrefix(entries.map((entry) => entry.name))
  let written = 0
  let totalBytes = 0
  for (const entry of entries) {
    const rel = stripPrefix(entry.name, prefix)
    if (rel === '') continue
    // 目录项也要过一遍路径校验：`../` 目录同样不该被静默放行。
    const target = safeTarget(destDir, rel)
    if (rel.endsWith('/')) continue
    const data = readZipEntryData(buf, entry)
    totalBytes += data.length
    if (totalBytes > MAX_ZIP_TOTAL_BYTES) {
      throw new Error(`解压总量超过上限 ${MAX_ZIP_TOTAL_BYTES} 字节，拒绝继续（疑似解压炸弹或损坏的归档）`)
    }
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
                          
                            
              
                
                
                            
              
                                     
                  
 

/**
 * 校验通过、进入重试队列的一条链接。
 * 软链记 relative（写进链接的内容）+ source（解析后的真实源，退化复制用）；
 * 硬链记 source（归档内的目标绝对路径）。
 */
                   
                                                                                                    
                                                                                   

/**
 * tar.gz 解压：gunzip 之后就是 512 字节头 + 数据的顺序流，没有压缩，顺序读即可。
 * （Linux/macOS 的 llama.cpp 发行包是 .tar.gz，Windows 才是 zip。）
 */
function extractTarGz(buf        , destDir        , options                 = {})                {
  let tar        
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
  const links                   = []
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
  links                           ,
  destDir        ,
  prefix        ,
  options                ,
)                   {
  const stats = emptyLinkStats()
  const root = resolve(destDir)
  const symlink = options.symlink ?? symlinkSync
  const hardlink = options.hardlink ?? linkSync
  // 安全检查不通过的条目直接记失败（不重试）：恶意压缩包不该被当成「暂时失败」。
  const reject = (reason        )       => {
    stats.failed++
    stats.failures.push(reason)
  }

  let pending                 = []
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
    let source                = null
    let sourceError          = null
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
    const keep                 = []
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
                                   
                                                     
              
                                      
                
                                           
                
 

/** verifyRuntimeLinks 的结果。 */
                                   
                                 
             
                                           
                 
                            
 

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
export function verifyRuntimeLinks(dir        )                   {
  const issues                     = []
  const links           = []
  const walk = (current        , depth        )       => {
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

function readTarEntries(tar        )             {
  const entries             = []
  let offset = 0
  let longName                = null
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

function isZeroBlock(block        )          {
  for (const byte of block) {
    if (byte !== 0) return false
  }
  return true
}

/** tar 的数字字段是八进制 ASCII；GNU 的大文件用 base-256（首字节最高位为 1）。 */
function readOctal(buf        , offset        , length        )         {
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

function readText(buf        , offset        , length        )         {
  return buf.toString('utf8', offset, offset + length).replace(/\0.*$/, '').trim()
}

function pad512(size        )         {
  return Math.ceil(size / 512) * 512
}

// ─────────────────────── 路径安全 / 小工具 ───────────────────────

/**
 * 压缩包里所有条目共享的第一段目录（如 `llama-b11429/`），没有就返回 ''。
 * 剥掉它，解压结果才是「llamacpp/ 下直接躺着 llama-server.exe」这种既有布局；
 * 只有当**每一条**都带这个前缀时才剥，避免误伤顶层散落的文件。
 */
function commonPrefix(names                   )         {
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

function stripPrefix(name        , prefix        )         {
  return prefix !== '' && name.startsWith(prefix) ? name.slice(prefix.length) : name
}

/**
 * 条目名的原始安全检查：绝对路径（`/x`、`C:/x`、`\\server\share`）与任何
 * `..` 段一律拒绝。必须在剥公共顶层目录**之前**做，否则 `C:/x.txt` 会先被
 * 剥成 `x.txt`，检查就形同虚设。
 */
function assertSafeName(rel        )       {
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
function safeTarget(destDir        , rel        )         {
  assertSafeName(rel)
  const root = resolve(destDir)
  const target = resolve(root, rel.replace(/\\/g, '/'))
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`压缩包条目试图跳出安装目录：${rel}`)
  }
  return target
}

function writeFile(target        , data        , mode         )       {
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

function ensureDir(dir        , what        )       {
  try {
    mkdirSync(dir, { recursive: true })
  } catch (error) {
    throw diskError(what, error)
  }
}

function isFile(path        )          {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** readdir 的安全版：目录读不了（权限/刚被删）就当空目录，绝不抛。 */
function listEntries(dir        )           {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function fileSize(path        )         {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function parseContentLength(header               )                {
  if (header === null) return null
  const value = Number.parseInt(header, 10)
  return Number.isFinite(value) && value >= 0 ? value : null
}

function isAbortError(error         )          {
  if (typeof error !== 'object' || error === null) return false
  return (error                      ).name === 'AbortError'
}

function describeError(error         )         {
  if (error instanceof Error) return error.message
  return String(error)
}

/** 把底层 fs 错误翻译成面板能看懂的话（缺权限 / 磁盘满是最常见的两种）。 */
function diskError(what        , error         )        {
  const code = (error                             )?.code
  const detail = describeError(error)
  if (typeof code === 'string' && ['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EBUSY', 'EMFILE', 'ENFILE'].includes(code)) {
    return new Error(`磁盘写入失败（${what}）：${detail}`)
  }
  return error instanceof Error ? error : new Error(`${what}：${detail}`)
}

function formatBytes(bytes        )         {
  if (bytes < 1024) return `${bytes} B`
  const mb = bytes / (1024 * 1024)
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  return `${(mb / 1024).toFixed(2)} GB`
}

/** 「需要释放多少」固定用 GB 说：MB 级差额对用户没有意义，GB 才是决策单位。 */
function formatGb(bytes        )         {
  return `${(Math.max(0, bytes) / (1024 * 1024 * 1024)).toFixed(2)}GB`
}

/** 模型下载要预留的字节数：已存在则 0，否则按已知体积 ×1.25（.part + 元数据）。 */
function modelDiskNeedBytes(paths              , model              )         {
  if (isFile(paths.model)) return 0
  const bytes = model.bytes !== undefined && model.bytes > 0 ? model.bytes : MODEL_SIZE_BYTES
  return Math.ceil(bytes * MODEL_DISK_FACTOR)
}

/** 运行时解压要预留的字节数：exe 已在（上次已解开）就不重复算。 */
function runtimeDiskNeedBytes(paths              , flavor               )         {
  return isFile(paths.exe) ? 0 : (RUNTIME_RESERVE_BYTES[flavor] ?? RUNTIME_RESERVE_BYTES.cpu)
}

/**
 * 下载前磁盘预检：模型 ×1.25 + 运行时解压余量 + 200MB 额外余量。
 * 已经就位的部分不重复计——断点续装（运行时已解开、只差模型）不会被误拦。
 */
export function diskNeedBytes(paths              , model              , flavor               )         {
  return modelDiskNeedBytes(paths, model) + runtimeDiskNeedBytes(paths, flavor) + EXTRA_DISK_RESERVE_BYTES
}

/**
 * statfsSync 读 dir 所在文件系统的可用字节数；读不到（老内核 / 权限 / 非常规
 * 文件系统）返回 null —— 预检失败就跳过预检，绝不能因为「读不到」把安装拦死。
 * 与 hardware.ts 的 freeDiskMb 同一思路，但这里不依赖 hardware（零耦合）。
 */
export function freeDiskBytes(dir        )                {
  try {
    const stat = statfsSync(dir)
    const bytes = Number(stat.bavail) * Number(stat.bsize)
    return Number.isFinite(bytes) && bytes >= 0 ? bytes : null
  } catch {
    return null
  }
}

function urlHost(url        )         {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** 等一个背压 drain；顺手把流错误也变成 reject，免得卡死。 */
function waitDrain(stream             )                {
  return new Promise((resolve, reject) => {
    const onDrain = ()       => { cleanup(); resolve() }
    const onError = (error       )       => { cleanup(); reject(error) }
    const cleanup = ()       => {
      stream.off('drain', onDrain)
      stream.off('error', onError)
    }
    stream.once('drain', onDrain)
    stream.once('error', onError)
  })
}

function closeStream(stream             )                {
  return new Promise((resolve, reject) => {
    stream.once('error', reject)
    stream.end(() => resolve())
  })
}

// ─────────────────── 下载：断点续传 ───────────────────

/** `Content-Range: bytes <start>-<end>/<total>` 的解析结果。 */
                               
                                        
               
                     
             
                                               
                      
 

/**
 * 解析 Content-Range。解析不了返回 null（调用方必须把「206 但没有可信
 * Content-Range」当成失败：续传位置无从校验，拼错一个字节模型就废了）。
 */
export function parseContentRange(header               )                      {
  if (header === null) return null
  const match = /^\s*bytes\s+(\d+)-(\d+)\/(\d+|\*)\s*$/i.exec(header)
  if (match === null) return null
  const start = Number.parseInt(match[1] ?? '', 10)
  const end = Number.parseInt(match[2] ?? '', 10)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
  const total = match[3] === '*' ? null : Number.parseInt(match[3] ?? '', 10)
  if (total !== null && (!Number.isFinite(total) || total < end + 1)) return null
  return { start, end, total }
}

/**
 * `.part` 旁边的续传元数据（`<dest>.part.meta`，一行 JSON）。
 *
 * 为什么要落盘而不是只放内存：续传的意义是「上次进程已经死了、这次接着下」，
 * 内存里的校验器活不过重启。它和 `.part` 同生命周期：下载成功（rename）、
 * 取消、完整性失败时会一起删掉，不会留下孤儿文件。
 */
                           
                                           
             
                                                
               
                                                   
                     
                             
 

function partMetaFile(part        )         {
  return `${part}.meta`
}

/** 读续传元数据：不存在 / JSON 坏了 / 字段不合法都当「没有」，绝不抛。 */
function readPartMeta(part        )                         {
  try {
    const raw          = JSON.parse(readFileSync(partMetaFile(part), 'utf8'))
    if (typeof raw !== 'object' || raw === null) return null
    const state = raw                            
    if (typeof state.url !== 'string' || state.url === '') return null
    if (typeof state.bytes !== 'number' || !Number.isFinite(state.bytes) || state.bytes < 0) return null
    return {
      url: state.url,
      bytes: state.bytes,
      etag: typeof state.etag === 'string' && state.etag !== '' ? state.etag : null,
      lastModified: typeof state.lastModified === 'string' && state.lastModified !== '' ? state.lastModified : null,
    }
  } catch {
    return null
  }
}

/** 写续传元数据：写失败只意味着下次少了校验器，不该把这次下载搞失败。 */
function writePartMeta(part        , state                 )       {
  try {
    mkdirSync(dirname(part), { recursive: true })
    writeFileSync(partMetaFile(part), JSON.stringify(state))
  } catch { /* 尽力而为 */ }
}

/** 删掉 .part 与它的元数据（残留不可信时才调用）。 */
function clearPart(part        )       {
  try { rmSync(part, { force: true }) } catch { /* 尽力而为 */ }
  try { rmSync(partMetaFile(part), { force: true }) } catch { /* 尽力而为 */ }
}

/** 续传请求头：Range + If-Range（有校验器才带，远端文件变了会自动回 200）。 */
function resumeHeaders(offset        , state                        )                         {
  const headers                         = { range: `bytes=${offset}-` }
  // If-Range 只认强校验器：ETag 优先，其次 Last-Modified 的 HTTP-date。
  const validator = state?.etag ?? state?.lastModified ?? null
  if (validator !== null) headers['if-range'] = validator
  return headers
}

// ─────────────────── 下载：完整性校验 ───────────────────

/** 流式算 sha256（400MB 的 GGUF 不能一次读进内存）。 */
/**
 * 已存在的压缩包能不能直接复用。
 *
 * 复用的前提：文件非空；配置了 sha256 时必须匹配（截断/被替换的旧包不能再拿去解压，
 * 否则会把「上一轮下载失败但留下坏包」误当成好东西）。
 */
export async function existingArchiveUsable(path        , expectedSha256        )                   {
  if (fileSize(path) <= 0) return false
  if (expectedSha256 === '') return true
  try {
    return (await sha256File(path)) === expectedSha256
  } catch {
    return false
  }
}

function sha256File(path        )                  {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', (error) => reject(diskError(`读取 ${path}`, error)))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/** 归一化 sha256 配置：大小写不敏感，允许 `sha256:` 前缀与前后空白。 */
export function normalizeSha256(value        )         {
  return value.trim().toLowerCase().replace(/^sha256:/, '').trim()
}

/** 把可能为 undefined 的哈希折成一个「要么没有、要么有」的校验参数。 */
function expectSha256(hash                    )                      {
  return hash === undefined || hash.trim() === '' ? {} : { sha256: hash }
}

/**
 * 按资产名取期望的运行时 sha256：
 *  - 字符串配置只覆盖**主**运行时包（CUDA 的伴生包不硬套同一个哈希）；
 *  - 记录配置按资产名精确匹配，主包与伴生包可以各配各的。
 */
function assetSha256(
  configured                                                       ,
  name        ,
  main         ,
)                     {
  if (configured === undefined) return undefined
  if (typeof configured === 'string') return main ? configured : undefined
  const hash = configured[name]
  return typeof hash === 'string' && hash.trim() !== '' ? hash : undefined
}

// ─────────────────── 安装后冒烟：跑一次 exe --version ───────────────────

/** 冒烟探测的默认超时。llama-server 打印版本是毫秒级，超时只是兜住卡死。 */
export const DEFAULT_PROBE_TIMEOUT_MS = 4000

/** 冒烟探测结果。失败时 stderr 尾部会原样进 phase:'error' 的 message。 */
                                     
             
                                              
                        
                                          
                         
                                         
                 
                                                      
              
 

/** 可注入的冒烟探测。返回 null = 跳过探测（CI / 交叉安装环境用）。 */
                                                                                                          

/** 一种探测启动方式。 */
                               
              
                
             
 

/**
 * 探测要从哪启动：
 *  - 普通 Linux / 非 Linux：直接 `exe --version`；
 *  - Android/Termux：下回来的 llama-server 是 ubuntu glibc ELF，PT_INTERP 指向
 *    `/lib/ld-linux-aarch64.so.1`，Android 上不存在，直接 exec 只会得到 ENOENT。
 *    这时和 embed-server 的启动一样，用 `$PREFIX/glibc/lib/<loader>
 *    --library-path <libdir> <exe> --version` 包一层——**在解压现场**验证
 *    「这台机器真能跑」，而不是等托管启动时才暴露。
 * 解释器存在的普通 Linux 不多包一层（loader 路径可能反而更旧）。
 */
function versionProbeCommands(exe        )                        {
  const direct                      = { file: exe, args: ['--version'], via: '直接执行' }
  if (!isLinuxLike(process.platform)) return [direct]
  try {
    const interp = readElfInterpFromFile(exe)
    if (interp === null || existsSync(interp)) return [direct]
    const info = detectPlatform()
    const loader = glibcLoaderFor(info, interp)
    if (loader === null) return [direct]
    const args = info.glibcLibDir === null
      ? [exe, '--version']
      : ['--library-path', info.glibcLibDir, exe, '--version']
    return [{ file: loader, args, via: 'Termux glibc loader 包装' }, direct]
  } catch {
    return [direct]
  }
}

/**
 * 跑一次探测命令。任何异常都翻译成 ok:false + 可读原因，绝不抛。
 *
 * 用异步 spawn 而不是 spawnSync：冒烟探测最长 4s，在 Termux 上还要先试
 * glibc loader、再直连重试（两轮），spawnSync 会把**整个 DSH 事件循环**
 * 卡住近 8 秒（面板、会话、心跳全停）。异步版本用定时器强杀，宿主全程可响应。
 */
function runVersionProbe(command                     , timeoutMs        )                              {
  return new Promise((resolve) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    let timer                                       = null
    const finish = (result                    )       => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      resolve(result)
    }
    let child                          
    try {
      child = spawn(command.file, command.args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // cwd 与托管启动一致：llama.cpp 的 shim 从这里解析同目录的 dll/so。
        cwd: dirname(command.file),
      })
    } catch (error) {
      finish({ ok: false, status: null, stderr: `无法执行 ${command.file}：${describeError(error)}`, via: command.via })
      return
    }
    child.stdout?.on('data', (chunk                 ) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk                 ) => { stderr += String(chunk) })
    timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      finish({
        ok: false,
        status: null,
        stderr: `无法执行 ${command.file}：超过 ${timeoutMs}ms 未返回，已强制结束`,
        via: command.via,
      })
    }, timeoutMs)
    timer.unref?.()
    child.on('error', (error       ) => {
      finish({ ok: false, status: null, stderr: `无法执行 ${command.file}：${describeError(error)}`, via: command.via })
    })
    child.on('close', (code               ) => {
      const status = typeof code === 'number' ? code : null
      if (status === 0) {
        finish({ ok: true, status: 0, version: versionLine(stdout, stderr), via: command.via })
        return
      }
      finish({ ok: false, status, stderr: `${stdout}\n${stderr}`.trim(), via: command.via })
    })
  })
}

/** 从输出里摘一行版本（优先带 version 字样的那行)。 */
function versionLine(stdout        , stderr        )                {
  const lines = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  const hit = lines.find((line) => /version/i.test(line)) ?? lines[0]
  if (hit === undefined) return null
  return hit.length > 160 ? `${hit.slice(0, 160)}…` : hit
}

/** 失败输出只留尾部几行：面板 message 得可读，但排障要看的是最后那几句。 */
function stderrTail(text                    , maxLines = 8, maxChars = 800)         {
  if (text === undefined) return ''
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '')
  const tail = lines.slice(-maxLines).join('\n')
  return tail.length > maxChars ? `…${tail.slice(-maxChars)}` : tail
}

/**
 * 默认冒烟探测：`exe --version`，4s 超时。Termux 上先用 glibc loader 包装试，
 * 不行再直连兜底；两者都失败时返回后者的结果（错误信息更贴近「程序本身坏」）。
 */
export async function probeVersionDefault(exe        , timeoutMs         = DEFAULT_PROBE_TIMEOUT_MS)                              {
  const commands = versionProbeCommands(exe)
  let last                     = { ok: false, status: null, stderr: `没有可用的探测方式：${exe}` }
  for (const command of commands) {
    const result = await runVersionProbe(command, timeoutMs)
    if (result.ok) return result
    last = result
  }
  return last
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
                   opts                  
          state                  = {
    phase: 'idle',
    message: '',
    receivedBytes: 0,
    totalBytes: null,
    error: null,
    paths: null,
  }
          running = false
          cancelled = false
  /** 每轮 cancel 自增：在途 run() 用它判断自己是否已经过期（别再改状态）。 */
          generation = 0
          controller                         = null
  /** 当前正在写的 .part 与它的流（取消时要立刻销毁，否则 fd 悬着）。 */
          sink                                                            = null

  constructor(opts                  ) {
    this.opts = opts
  }

  /** 状态快照（返回副本，调用方改不动内部状态）。 */
  get progress()                  {
    return { ...this.state }
  }

  /** 幂等：已在跑、或已装好，直接返回。 */
  start()       {
    if (this.running) return
    const installed = detectInstalled(
      this.opts.root,
      this.opts.model?.file ?? MODEL_FILE_NAME,
      { systemExe: this.opts.systemExe ?? null, preferSystem: this.opts.preferSystem === true },
    )
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
      .catch((error         ) => {
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
  cancel()       {
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

          async run(gen        )                {
    const root = this.opts.root
    const platform = this.opts.platform ?? process.platform
    const arch = this.opts.arch ?? process.arch
    // 所选模型:不给就是内置的 bge-m3 Q4_K_M(与合并前行为一致)。
    const model               = this.opts.model ?? {
      file: MODEL_FILE_NAME,
      bytes: MODEL_SIZE_BYTES,
      ...(this.opts.modelSources ? { sources: this.opts.modelSources } : {}),
    }
    const flavor                = this.opts.flavor ?? 'cpu'
    const paths = installPaths(root, model.file)
    try {
      const systemExe = this.opts.systemExe ?? null
      if (systemExe !== null) {
        // 系统运行时（Termux `pkg install llama-cpp` 等）：只下模型，不碰运行时。
        await this.installWithSystemRuntime(gen, paths, model, systemExe)
        return
      }
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
      const expectedRuntimeSha = expectSha256(assetSha256(this.opts.runtimeSha256, asset.name, true))
      // 上轮下完但解压/下模型失败：压缩包还在，别白下第二遍 —— 但如果配了
      // sha256 而旧包对不上，说明它是坏包/半包，必须删掉重下。
      const reuse = await existingArchiveUsable(archivePath, expectedRuntimeSha)
      if (reuse) {
        this.setPhase(gen, 'downloading-runtime', `已存在 ${asset.name}，跳过下载（校验通过）`, { receivedBytes: 0, totalBytes: null })
      } else {
        if (fileSize(archivePath) > 0) {
          rmSync(archivePath, { force: true })
          this.report(gen, { message: `已存在的 ${asset.name} 校验不通过，重新下载` })
        }
        this.setPhase(gen, 'downloading-runtime', `正在下载 llama.cpp 运行时 ${asset.name}`)
        const got = await this.downloadFrom(
          gen,
          runtimeDownloadSources(asset),
          archivePath,
          'llama.cpp 运行时',
          'downloading-runtime',
          '通道',
          expectedRuntimeSha,
        )
        // 成功日志里写清走的哪条通道：直链还是 API 资产端点，排障时第一眼要看的就是它。
        this.report(gen, { message: `运行时下载完成（${formatBytes(got.bytes)}，通道：${got.source.label}）` })
      }

      this.setPhase(gen, 'extracting', `正在解压 ${asset.name}`)
      let archive        
      try {
        archive = readFileSync(archivePath)
      } catch (error) {
        throw diskError(`读取 ${archivePath}`, error)
      }
      let written = 0
      // 链接失败要跨「主包 + CUDA 伴生包」累计：任何一个包里的 SONAME 链接建不
      // 起来，装完都会启动失败，不能因为失败发生在不同压缩包里就漏报。
      let failedLinks = 0
      const linkFailures           = []
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
          const got = await this.downloadFrom(
            gen,
            runtimeDownloadSources(companion),
            companionPath,
            'CUDA 运行库',
            'downloading-runtime',
            '通道',
            expectSha256(assetSha256(this.opts.runtimeSha256, companion.name, false)),
          )
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
        const problems           = []
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

      // 最后一道闸：文件齐了不等于跑得起来。跑一次 `llama-server --version`，
      // 把「缺 glibc loader / 指令集不匹配 / 解压被截断」这类问题在安装流程里
      // 就暴露出来，而不是等用户第一次检索时才看到后端起不来。
      await this.smokeTest(gen, paths)

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
          async resolveRuntimeAsset(
    gen        ,
    platform                 ,
    arch        ,
    flavor               ,
  )                        {
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
          async resolveRuntimeCompanion(
    gen        ,
    platform                 ,
    arch        ,
    flavor               ,
  )                               {
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
          async downloadModel(gen        , dest        , model              )                                                     {
    const urls                    = model.sources ?? this.opts.modelSources ?? MODEL_SOURCES
    const sources = urls.map((url)                 => ({ url, accept: '*/*', label: urlHost(url) }))
    return this.downloadFrom(gen, sources, dest, model.file, 'downloading-model', '源', expectSha256(model.sha256))
  }

  /**
   * 按候选顺序下载，当前候选失败（网络错误 / 非 2xx / 中途断流 / 完整性不符）
   * 就换下一个。续传只在**同一个来源 URL** 上生效（见 download）：换源等于换文件，
   * 不同镜像的残片不能拼在一起。
   * 全部失败时把所有候选各自的原因一起报出来——只报一句「下载失败」的话，用户
   * 根本分不清是墙、是 DNS、还是磁盘满。
   */
          async downloadFrom(
    gen        ,
    sources                           ,
    dest        ,
    what        ,
    phase              ,
    noun        ,
    expect                      = {},
  )                                                     {
    const failures           = []
    for (const source of sources) {
      try {
        const bytes = await this.download(gen, source, dest, what, phase, expect)
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
   * 流式下载到 dest：先写 `<dest>.part`，完整收流 + 完整性校验通过后 rename。
   * 每收到一块就上报一次 receivedBytes（面板的百分比来源）。
   *
   * 断点续传（400MB 的 GGUF 断一次就重下没人受得了）：
   *  - `<dest>.part.meta` 记着上次的来源 URL 与校验器；
   *  - 同源且已有 N 字节 → 发 `Range: bytes=N-` + `If-Range`（ETag/Last-Modified），
   *    服务端回 **206 且 Content-Range 起点 = N** 就追加写；起点对不上说明残片
   *    不可信，删掉报错；
   *  - 服务端不支持 Range（回 200）→ 从头覆盖（flags 'w'），
   *    用 content-length 当总长；
   *  - 416（残片比远端还长 / 远端文件变小）→ 丢掉残片，退化成整段重下；
   *  - **换源不续**：镜像之间可能不是同一份文件，拼错了只有 sha256 能救，索性不复用。
   *
   * 完整性（两关，都失败即删 .part，绝不留半成品）：
   *  - 总长：content-length（200）或 Content-Range 的 total（206）vs 落地字节；
   *  - sha256：配置里声明了就必须匹配（GGUF 多数没有官方哈希，至少保住 size）。
   */
          async download(
    gen        ,
    source                ,
    dest        ,
    what        ,
    phase              ,
    expect                      = {},
  )                  {
    const url = source.url
    const part = `${dest}.part`
    // 只有「同一个来源 URL」的 .part 才敢续：换源时先清掉（模型的多镜像、
    // 运行时的直链/API 两条通道都是不同 URL）。
    const previous = readPartMeta(part)
    const sameSource = previous !== null && previous.url === url
    if (!sameSource) clearPart(part)
    let startAt = sameSource ? fileSize(part) : 0

    let res = await this.request(url, source.accept, startAt > 0 ? resumeHeaders(startAt, previous) : undefined)
    if (res.status === 416 && startAt > 0) {
      // 残片比远端总长还大（或远端文件被换成了更小的）：这份残片永远拼不回来。
      clearPart(part)
      startAt = 0
      this.report(gen, { message: `${what}：续传被拒（HTTP 416），丢弃残片后从头下载`, receivedBytes: 0, totalBytes: null })
      res = await this.request(url, source.accept)
    }
    if (!res.ok) {
      throw new Error(`下载${what}失败：HTTP ${res.status}${res.statusText !== '' ? ` ${res.statusText}` : ''}（${url}）`)
    }

    // 总长与续传起点：206 必须自报 Content-Range，否则无从确认拼接位置。
    let total               
    let append = false
    if (res.status === 206) {
      const range = parseContentRange(res.headers.get('content-range'))
      if (range === null) {
        // 位置不明的追加写会把文件写坏，宁可这份残片不要。
        clearPart(part)
        throw new Error(`下载${what}失败：服务器返回 206 却没有可解析的 Content-Range（${urlHost(url)}），无法确认续传位置`)
      }
      if (range.start !== startAt) {
        clearPart(part)
        throw new Error(
          `下载${what}失败：续传起点不一致（本地已有 ${startAt} 字节，服务器从 ${range.start} 字节开始），` +
          `已删除残片；请重试（会从 0 重新下载）`,
        )
      }
      const length = parseContentLength(res.headers.get('content-length'))
      total = range.total ?? (length === null ? null : startAt + length)
      append = startAt > 0
    } else {
      // 200 = 服务端不支持 Range（或这是第一次下载）：从 0 覆盖写。
      total = parseContentLength(res.headers.get('content-length')) // 拿不到就是 null
    }
    // fetch 会**自动解码** Content-Encoding：这时 content-length/Content-Range 说的
    // 是压缩后的字节数，拿来校验落地字节必然误报；而且按区间续传拼的是解码后的
    // 数据流，区间语义不再成立。这类响应只能当「总长未知」下完，靠 sha256 兜底。
    const contentEncoding = (res.headers.get('content-encoding') ?? '').trim().toLowerCase()
    if (contentEncoding !== '' && contentEncoding !== 'identity') {
      if (startAt > 0) {
        clearPart(part)
        throw new Error(
          `下载${what}失败：服务器对这份内容启用了 Content-Encoding（${contentEncoding}），` +
          `无法按字节区间续传，已删除残片；请重试（会从 0 重新下载）`,
        )
      }
      total = null
    }
    // 覆盖写时进度/落地字节的基准是 0：startAt 那一截已经被截掉了。
    const base = append ? startAt : 0
    const body = res.body
    if (body === null) throw new Error(`下载${what}失败：响应没有可读的数据流`)
    const reader = body.getReader()
    const stream = createWriteStream(part, { flags: append ? 'a' : 'w' })
    this.sink = { gen, part, stream }
    // 先落续传元数据：下一秒断网，下一次也能带着同一个校验器接着续。
    writePartMeta(part, {
      url,
      bytes: base,
      etag: res.headers.get('etag'),
      lastModified: res.headers.get('last-modified'),
    })
    // 用容器而不是裸 let：错误在回调里赋值、在循环里读，容器能让 TS 的类型收窄
    // 保持可预测（裸 let 在闭包里赋值后收窄会被重置/变 never）。
    const failure                          = { error: null }
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
        // 进度按「这个文件已收多少」报，续传时要把既有的那一截算上。
        this.report(gen, { phase, receivedBytes: base + received, totalBytes: total, error: null })
      }
      await closeStream(stream)
      if (failure.error !== null) throw failure.error
    } catch (error) {
      try { stream.destroy() } catch { /* 已经坏了 */ }
      if (this.sink?.part === part) this.sink = null
      // 这里**不删** .part：网络抖动/断流留下的残片正是下次续传的本钱。
      // 只有「残片不可信」（取消、416、Content-Range 不一致、完整性失败）才删。
      // 写盘失败（磁盘满/无权限）要说得明白，别把 ERR_STREAM 之类的丢给用户。
      if (failure.error !== null && !isAbortError(error)) throw diskError(`写入 ${part}`, failure.error)
      throw error
    }

    const landed = base + received
    this.ensureActive(gen)
    // 完整性第一关：声明了多少就必须落地多少。短了是断流，长了是拼接错位。
    if (total !== null && landed !== total) {
      clearPart(part)
      throw new Error(
        `下载${what}不完整：服务器声明 ${total} 字节，实际落地 ${landed} 字节` +
        `（来源 ${urlHost(url)}${append ? `，其中续传 ${formatBytes(startAt)}` : ''}），已删除残片`,
      )
    }
    // 完整性第二关：配置了 sha256 就必须逐字节对上（镜像篡改 / 镜像换版 / 拼接错位）。
    const expected = expect.sha256 === undefined ? '' : normalizeSha256(expect.sha256)
    if (expected !== '') {
      let actual        
      try {
        actual = await sha256File(part)
      } catch (error) {
        clearPart(part)
        throw error
      }
      this.ensureActive(gen)
      if (actual !== expected) {
        clearPart(part)
        throw new Error(
          `下载${what}校验失败：sha256 不匹配（期望 ${expected}，实际 ${actual}）。` +
          `文件可能在镜像上被替换/篡改，或续传拼错了内容，已删除残片（来源 ${urlHost(url)}）；请换一个源或稍后重试`,
        )
      }
    }
    try {
      renameSync(part, dest)
    } catch (error) {
      if (this.sink?.part === part) this.sink = null
      throw diskError(`重命名 ${dest}`, error)
    }
    // rename 只带走了 .part，元数据要单独清，别留孤儿文件。
    try { rmSync(partMetaFile(part), { force: true }) } catch { /* 尽力而为 */ }
    if (this.sink?.part === part) this.sink = null
    this.report(gen, { phase, receivedBytes: landed, totalBytes: total, error: null })
    return landed
  }

  /**
   * 系统运行时安装路径：运行时用系统的 llama-server（Termux `pkg install
   * llama-cpp` / PATH 里的 llama-server），只负责把模型下到
   * `<root>/models/`，然后冒烟 + 校验。
   *
   * 为什么值得单独一条路：托管路径要下载约 100MB~1GB 的运行时装 ubuntu
   * glibc 二进制，在 Android 上还得靠 Termux glibc loader 兼容层才能启动；
   * 而 Termux 官方仓库的 llama-cpp 是 bionic 原生构建，直接 exec 就能跑，
   * 版本与系统库天然匹配。这条路把「跑不起来」的整条故障面砍掉了。
   */
          async installWithSystemRuntime(
    gen        ,
    paths              ,
    model              ,
    systemExe        ,
  )                {
    ensureDir(paths.root, '创建安装根目录')
    ensureDir(dirname(paths.model), '创建模型目录')
    this.setPhase(gen, 'preparing', `使用系统 llama-server：${systemExe}（跳过运行时下载）`)
    if (model.bytes !== undefined) {
      const need = Math.round(model.bytes * MODEL_DISK_FACTOR) + EXTRA_DISK_RESERVE_BYTES
      const free = (this.opts.freeBytes ?? freeDiskBytes)(paths.root)
      this.setPhase(gen, 'preparing', `磁盘预检：需要约 ${formatBytes(need)}，可用 ${free === null ? '未知（跳过预检）' : formatBytes(free)}`)
      if (free !== null && free < need) {
        throw new Error(
          `磁盘空间不足：模型约需 ${formatBytes(need)}，安装目录 ${paths.root} 所在磁盘只剩 ${formatBytes(free)}`,
        )
      }
    }
    if (fileSize(paths.model) > 0) {
      this.setPhase(gen, 'downloading-model', '模型已存在，跳过下载', { receivedBytes: 0, totalBytes: null })
    } else {
      this.setPhase(gen, 'downloading-model', `正在下载 ${model.file}${model.bytes !== undefined ? `（约 ${formatBytes(model.bytes)}）` : ''}`)
      const got = await this.downloadModel(gen, paths.model, model)
      this.report(gen, { message: `模型下载完成（已下载 ${formatBytes(got.bytes)}，来源：${got.source.label}）` })
    }
    const systemPaths               = { ...paths, exe: systemExe, cwd: dirname(systemExe), system: true }
    await this.smokeTest(gen, systemPaths)
    const installed = detectInstalled(paths.root, model.file, { systemExe, preferSystem: true })
    if (installed === null) throw new Error('安装校验失败：模型文件缺失')
    this.report(gen, {
      phase: 'done',
      message: `安装完成：模型 ${formatBytes(fileSize(installed.model))}，运行时 系统 llama-server（${basename(systemExe)}）`,
      error: null,
      receivedBytes: 0,
      totalBytes: null,
      paths: installed,
    })
  }

  /**
   * 安装后冒烟：文件齐了不等于跑得起来，跑一次 `exe --version` 才算装完。
   *
   * 探测方式是注入的（默认异步 spawn，4s 超时；Termux 上自动用 glibc loader
   * 包装，与托管启动保持一致）。失败时：
   *  - message 带 stderr 尾部（缺哪个 .so、哪条 loader，用户一眼能看到）；
   *  - 顺手把 exe 摘掉：detectInstalled 只看文件在不在，留着它下次 start()
   *    会直接报「已就绪，无需下载」，把坏安装当成功——静默失效最难排查。
   *    压缩包还在，重试只需要重新解压+校验，不会白下几十 MB。
   */
          async smokeTest(gen        , paths              )                {
    const probe = this.opts.probeVersion ?? probeVersionDefault
    this.setPhase(gen, 'verifying', `冒烟测试：${basename(paths.exe)} --version`)
    this.ensureActive(gen)
    let result                           
    try {
      result = await probe(paths.exe)
    } catch (error) {
      // 注入的探测实现自己炸了也要变成可读的 error，而不是一句裸异常。
      throw new Error(`安装后冒烟测试失败：探测 ${basename(paths.exe)} 时出错（${describeError(error)}）`)
    }
    this.ensureActive(gen)
    if (result === null) {
      this.report(gen, { message: '冒烟测试：已跳过（probeVersion 返回 null）' })
      return
    }
    if (!result.ok) {
      const tail = stderrTail(result.stderr)
      const how = result.status === null || result.status === undefined ? '无法执行' : `退出码 ${result.status}`
      const via = result.via === undefined ? '' : `（${result.via}）`
      // 系统运行时是别人的文件（$PREFIX/bin/llama-server），绝不能因为冒烟失败
      // 就把它删了；只有托管运行时（我们下载到 <root>/llamacpp 的）才清。
      if (paths.system !== true) {
        try { rmSync(paths.exe, { force: true }) } catch { /* 尽力而为 */ }
      }
      throw new Error(
        `安装后冒烟测试失败：${basename(paths.exe)} --version ${how}${via}` +
        (tail === '' ? '' : `\nstderr 尾部：\n${tail}`) +
        `\n运行时可能缺少依赖库、与当前系统不兼容，或解压不完整。已移除 ${basename(paths.exe)}，` +
        `以免下次启动把坏安装当成「已就绪」；压缩包还在，重试会重新解压并再次冒烟`,
      )
    }
    const version = result.version === null || result.version === undefined || result.version === ''
      ? ''
      : `：${result.version}`
    this.report(gen, { message: `冒烟测试通过${version}` })
  }

  /** 发一个带 UA 的请求；extraHeaders 给续传（Range/If-Range）用。 */
          async request(url        , accept        , extraHeaders                         )                    {
    const impl = this.opts.fetchImpl ?? fetch
    const signal = this.requestSignal()
    try {
      return await impl(url, {
        headers: { accept, 'user-agent': USER_AGENT, ...extraHeaders },
        signal,
        redirect: 'follow',
      })
    } catch (error) {
      if (isAbortError(error)) throw error
      throw new Error(`网络请求失败（${urlHost(url)}）：${describeError(error)}`)
    }
  }

          async fetchJson(url        , what        )                   {
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
          requestSignal()              {
    const external = this.opts.signal
    const controller = this.controller
    if (controller === null) return external ?? new AbortController().signal
    return external === undefined ? controller.signal : AbortSignal.any([controller.signal, external])
  }

  /** 销毁在途的 .part 流并删文件（取消路径；残片与它的元数据一起清掉）。 */
          dropSink()       {
    const sink = this.sink
    this.sink = null
    if (sink === null) return
    try { sink.stream.destroy() } catch { /* 已经坏了 */ }
    try { rmSync(sink.part, { force: true }) } catch { /* 尽力而为 */ }
    try { rmSync(partMetaFile(sink.part), { force: true }) } catch { /* 尽力而为 */ }
  }

  /**
   * 在长操作的等待点之间检查「这一轮还作数吗」。
   * 已取消 → 抛 AbortError（run() 的 catch 会把它收成 idle，而不是 error）。
   */
          ensureActive(gen        )       {
    if (!this.cancelled && gen === this.generation) return
    const error = new Error('已取消')
    error.name = 'AbortError'
    throw error
  }

          fail(error         )       {
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
          report(gen        , patch                          )       {
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
          setPhase(gen        , phase              , message        , extra                           = {})       {
    this.report(gen, { phase, message, error: null, receivedBytes: 0, totalBytes: null, ...extra })
  }
}


//# sourceURL=source/memory-local/src/embed-install.ts