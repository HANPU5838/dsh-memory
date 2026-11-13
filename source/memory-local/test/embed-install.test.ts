/**
 * 向量后端安装器（embed-install）的离线测试。
 *
 * 原则：**绝不真的下载**。400MB 的模型和 18MB 的运行时都换成注入的假 fetch，
 * 只测状态机、进度累计、解压、取消与错误分支。
 *
 * 解压用两套真实数据交叉验证：
 *  - 本机真实发行包 `D:\.deepseek\memory-stack\llamacpp\llama-b*-bin-win-cpu-x64.zip`
 *    （官方 Windows CPU x64 包，DEFLATE，51 个条目）：断言解出来的
 *    llama-server.exe / llama-server-impl.dll 大小与**zip 自己声明**的一致，
 *    exe 的字节还与测试里独立 inflate 的结果逐一比对。fixture 不存在时 skip。
 *  - tar.gz 路径用测试里现造的 ustar 数据（含顶层目录、目录项、执行位、
 *    以及 `../` 穿越条目）覆盖，不依赖网络与外部文件。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { deflateRawSync, gzipSync, inflateRawSync } from 'node:zlib'
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  MODEL_FILE_NAME,
  MODEL_SIZE_BYTES,
  VectorInstaller,
  detectInstalled,
  diskNeedBytes,
  extractArchive,
  extractArchiveReport,
  freeDiskBytes,
  installPaths,
  normalizeSha256,
  parseContentRange,
  pickRuntimeAsset,
  probeVersionDefault,
  runtimeAssetPattern,
  runtimeDownloadSources,
  verifyRuntimeLinks,
  type InstallProgress,
  type VersionProbe,
  type VersionProbeResult,
} from '../src/embed-install.ts'

// ───────────────────────────── 小工具 ─────────────────────────────

/**
 * 测试用的平台/架构：Termux/Android 的 `process.platform` 是 `'android'`，
 * 但安装器的资产匹配、解压、冒烟路径与 linux 完全一致（Android 复用 ubuntu
 * 构建，靠 glibc loader 启动）。用「注入值」而不是宿主值，Termux 上才能真的
 * 跑安装路径用例，而不是整批 skip —— 22 个 skip 等于目标平台零覆盖。
 */
const TEST_PLATFORM: NodeJS.Platform = process.platform === 'android' ? 'linux' : process.platform
const TEST_ARCH = process.arch === 'arm64' ? 'arm64' : 'x64'

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`等待超时：${what}`)
}

/** 宿主平台是否受支持（win32-ia32 之类要整条跳过）。 */
function hostSupported(): boolean {
  try {
    runtimeAssetPattern(TEST_PLATFORM, TEST_ARCH)
    return true
  } catch {
    return false
  }
}

interface ZipSpec {
  name: string
  data?: Buffer
  /** 0=stored，8=deflate；给别的值用来测「不支持的压缩方式」。 */
  method?: number
}

/**
 * 现造一个最小合法 zip（本地头 + 数据 + 中央目录 + EOCD）。
 * 不写 CRC：解压器不校验它（校验大小 + inflate 自身就会报错），写 0 即可。
 */
function buildZip(specs: readonly ZipSpec[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const spec of specs) {
    const data = spec.data ?? Buffer.alloc(0)
    const method = spec.method ?? 0
    const name = Buffer.from(spec.name, 'utf8')
    const body = method === 8 ? deflateRawSync(data) : data
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.length + name.length + body.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(specs.length, 8)
  eocd.writeUInt16LE(specs.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

interface TarSpec {
  name: string
  data?: Buffer
  /** '0'/省略=普通文件，'5'=目录，'2'=符号链接 */
  type?: string
  mode?: number
  link?: string
}

/** 现造一个 ustar 归档（512 字节头 + 数据 + 结束块）。校验和按规范算。 */
function buildTar(specs: readonly TarSpec[]): Buffer {
  const blocks: Buffer[] = []
  for (const spec of specs) {
    const data = spec.data ?? Buffer.alloc(0)
    const header = Buffer.alloc(512)
    header.write(spec.name, 0, 'utf8')
    header.write(`${(spec.mode ?? 0o644).toString(8).padStart(7, '0')}\0`, 100)
    header.write('0000000\0', 108) // uid
    header.write('0000000\0', 116) // gid
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124)
    header.write('00000000000\0', 136) // mtime
    header.write('        ', 148) // 校验和占位（8 个空格）
    header.write(spec.type ?? '0', 156)
    if (spec.link !== undefined) header.write(spec.link, 157, 'utf8')
    header.write('ustar\0', 257)
    header.write('00', 263)
    let sum = 0
    for (const byte of header) sum += byte
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
    blocks.push(header, data)
    const pad = (512 - (data.length % 512)) % 512
    if (pad > 0) blocks.push(Buffer.alloc(pad))
  }
  blocks.push(Buffer.alloc(1024)) // 两个全零块 = 归档结束
  return Buffer.concat(blocks)
}

/** 假 Response：分块给完就关流。extraHeaders 给 206/续传用例带 Content-Range 等头。 */
function streamResponse(
  chunks: readonly Uint8Array[],
  totalBytes: number | null,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  const headers: Record<string, string> = { ...extraHeaders }
  if (totalBytes !== null) headers['content-length'] = String(totalBytes)
  return new Response(stream, { status, headers })
}

/**
 * 冒烟探测的假实现。**所有走完整流程的用例都必须注入它**：解压出来的
 * `llama-server` 是测试里造的假二进制（文本），真的 spawnSync 只会 EACCES。
 */
function fakeProbe(): VersionProbe {
  return () => ({ ok: true, status: 0, version: 'version: 9999 (fake)', via: '测试注入' })
}

/** 计算 Buffer 的 sha256 十六进制（给完整性用例生成期望值，不调被测代码）。 */
function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/**
 * 永不结束的响应：先给一块，之后挂住；真正收到 abort 时按 fetch 的语义抛
 * AbortError（真 fetch 就是这个行为，取消测试依赖它收尾）。
 */
function stallResponse(signal: AbortSignal | null | undefined, first: Uint8Array, totalBytes: number): Response {
  let sent = false
  const reader = {
    read(): Promise<{ done: boolean; value?: Uint8Array }> {
      if (!sent) {
        sent = true
        return Promise.resolve({ done: false, value: first })
      }
      return new Promise((_resolve, reject) => {
        const fail = (): void => reject(new DOMException('The operation was aborted.', 'AbortError'))
        if (signal === null || signal === undefined) return
        if (signal.aborted) {
          fail()
          return
        }
        signal.addEventListener('abort', fail, { once: true })
      })
    },
    cancel: async (): Promise<void> => {},
  }
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-length': String(totalBytes) }),
    body: { getReader: () => reader },
  } as unknown as Response
}

function fakeFetch(route: (url: string, init?: RequestInit) => Response): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => route(String(input), init)) as unknown as typeof fetch
}

interface RuntimeFixture {
  name: string
  bytes: Buffer
}

/**
 * 造一个「形状正确」的运行时包：Windows 是含 llama-server.exe 的 zip，
 * POSIX 是含 `llama-b<n>/llama-server` 的 tar.gz。文件名按宿主平台拼，
 * 这样平台匹配、解压、detectInstalled 三条路径都在当前机器上真跑一遍。
 */
function buildRuntimeFixture(): RuntimeFixture {
  const arch = TEST_ARCH
  if (TEST_PLATFORM === 'win32') {
    return {
      name: `llama-b19999-bin-win-cpu-${arch}.zip`,
      bytes: buildZip([
        { name: 'llama-server.exe', data: Buffer.from('llama-server-shim') },
        { name: 'llama-common.dll', data: Buffer.alloc(4096, 3), method: 8 },
        { name: 'llama-server-impl.dll', data: Buffer.alloc(8192, 4), method: 8 },
      ]),
    }
  }
  const dirName = TEST_PLATFORM === 'darwin' ? 'macos' : 'ubuntu'
  return {
    name: `llama-b19999-bin-${dirName}-${arch}.tar.gz`,
    bytes: gzipSync(buildTar([
      { name: 'llama-b19999/', type: '5' },
      { name: 'llama-b19999/llama-server', data: Buffer.from('llama-server-bin'), mode: 0o755 },
      { name: 'llama-b19999/llama-server-impl.so', data: Buffer.alloc(8192, 4), mode: 0o755 },
      // 真实发行包的形状：两级 SONAME 软链（.so → .so.0 → .so.0.9.0），
      // 且链接条目排在真实文件**之前**。安装流程的解压后校验必须认这个。
      { name: 'llama-b19999/libllama-common.so', type: '2', link: 'libllama-common.so.0' },
      { name: 'llama-b19999/libllama-common.so.0', type: '2', link: 'libllama-common.so.0.9.0' },
      { name: 'llama-b19999/libllama-common.so.0.9.0', data: Buffer.alloc(4096, 5), mode: 0o755 },
    ])),
  }
}

interface CudaFixture {
  main: RuntimeFixture
  companion: { name: string; bytes: Buffer }
  /** 与真实 API 一致：assets 按名字升序返回，`cudart-*` 恒排在 `llama-*` 之前。 */
  assets: Array<{ name: string; browser_download_url: string }>
}

/**
 * 造一套 CUDA 风味夹具：主包（含 llama-server）+ cudart 伴生包（只有 dll，没有 exe）。
 *
 * 资产顺序**照抄真实 API**：`cudart-*` 按字典序排在 `llama-*` 主包之前（b11012–b12023
 * 共 700 个 release 全是如此）。旧版主包正则只锚结尾时，会先命中伴生包，解压后
 * 找不到 llama-server.exe —— issue #4。macOS 没有 CUDA 构建（风味退回 CPU），返回 null。
 */
function buildCudaFixture(): CudaFixture | null {
  if (TEST_PLATFORM !== 'win32' && TEST_PLATFORM !== 'linux') return null
  const arch = TEST_ARCH
  const cuda = arch === 'arm64' ? '13.4' : TEST_PLATFORM === 'linux' ? '12.8' : '12.4'
  const suffix = TEST_PLATFORM === 'win32' ? 'win' : 'ubuntu'
  const ext = TEST_PLATFORM === 'win32' ? 'zip' : 'tar.gz'
  const exe = TEST_PLATFORM === 'win32' ? 'llama-server.exe' : 'llama-server'
  const mainName = `llama-b19999-bin-${suffix}-cuda-${cuda}-${arch}.${ext}`
  const companionName = TEST_PLATFORM === 'win32'
    ? `cudart-llama-bin-win-cuda-${cuda}-${arch}.zip`
    : `cudart-llama-b19999-bin-ubuntu-cuda-${cuda}-${arch}.tar.gz`
  // 干扰项必须与要选的伴生包 cuda 次版本不同，否则它自己就会成为第一个命中。
  const decoyCuda = cuda === '12.4' ? '13.4' : '12.4'

  const mainBytes = TEST_PLATFORM === 'win32'
    ? buildZip([
        { name: exe, data: Buffer.from('llama-server-shim') },
        { name: 'llama-server-impl.dll', data: Buffer.alloc(4096, 5), method: 8 },
        { name: 'ggml-cuda.dll', data: Buffer.alloc(4096, 6), method: 8 },
      ])
    : gzipSync(buildTar([
        { name: 'llama-b19999/', type: '5' },
        { name: `llama-b19999/${exe}`, data: Buffer.from('llama-server-bin'), mode: 0o755 },
        { name: 'llama-b19999/llama-server-impl.so', data: Buffer.alloc(4096, 5), mode: 0o755 },
      ]))
  // 真实 cudart 包里只有 cudart / cuBLAS 的 dll，没有任何 llama-server*。
  const companionDlls = ['cudart64_12.dll', 'cublas64_12.dll', 'cublasLt64_12.dll']
  const companionBytes = process.platform === 'win32'
    ? buildZip(companionDlls.map((name) => ({ name, data: Buffer.alloc(512, 7) })))
    : gzipSync(buildTar(companionDlls.map((name) => ({ name, data: Buffer.alloc(512, 7) }))))

  return {
    main: { name: mainName, bytes: mainBytes },
    companion: { name: companionName, bytes: companionBytes },
    assets: [
      { name: `cudart-llama-bin-win-cuda-${decoyCuda}-${arch}.zip`, browser_download_url: 'https://example.invalid/decoy' },
      { name: companionName, browser_download_url: 'https://example.invalid/companion' },
      { name: `llama-b19999-bin-${suffix}-cpu-${arch}.${ext}`, browser_download_url: 'https://example.invalid/cpu' },
      { name: `llama-b19999-bin-${suffix}-vulkan-${arch}.${ext}`, browser_download_url: 'https://example.invalid/vulkan' },
      { name: mainName, browser_download_url: 'https://example.invalid/main' },
    ],
  }
}

/** 不依赖被测代码的第二实现：只读 zip 中央目录，供交叉核对。 */
function declaredZipEntries(buf: Buffer): Map<string, { usize: number; csize: number; offset: number; method: number }> {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  assert.ok(eocd >= 0, 'EOCD 存在')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const out = new Map<string, { usize: number; csize: number; offset: number; method: number }>()
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, '中央目录条目签名')
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    out.set(buf.toString('utf8', p + 46, p + 46 + nameLen), {
      method: buf.readUInt16LE(p + 10),
      csize: buf.readUInt32LE(p + 20),
      usize: buf.readUInt32LE(p + 24),
      offset: buf.readUInt32LE(p + 42),
    })
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

/** 本机真实发行包的位置（可用 DSH_LLAMACPP_DIR 覆盖）。 */
const FIXTURE_DIR = process.env.DSH_LLAMACPP_DIR ?? 'D:/.deepseek/memory-stack/llamacpp'

function findFixtureZip(): string | null {
  try {
    for (const name of readdirSync(FIXTURE_DIR)) {
      if (/^llama-b\d+-bin-win-cpu-x64\.zip$/.test(name)) return join(FIXTURE_DIR, name)
    }
  } catch {
    return null
  }
  return null
}

// ───────────────────────── 布局与检测 ─────────────────────────

test('installPaths 与手工装好的既有布局逐字段一致', () => {
  const paths = installPaths('D:/stack')
  assert.equal(paths.root, 'D:/stack')
  assert.equal(paths.dir, join('D:/stack', 'llamacpp'))
  assert.equal(paths.cwd, paths.dir, '子进程工作目录 = 运行时目录（dll 在这里解析）')
  assert.equal(paths.exe, join('D:/stack', 'llamacpp', process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'))
  assert.equal(paths.model, join('D:/stack', 'models', MODEL_FILE_NAME))
  assert.equal(paths.model.endsWith('bge-m3-Q4_K_M.gguf'), true)
  assert.equal(paths.logFile, join('D:/stack', 'llama-server.log'))
})

test('detectInstalled 只在 exe 与 model 都在时才认；目录不存在也不抛', () => {
  const root = tempDir('dsh-install-detect-')
  try {
    const paths = installPaths(root)
    assert.equal(detectInstalled(root), null, '空目录 = 未安装')
    assert.equal(detectInstalled(join(root, 'nope')), null, '不存在的目录不抛异常')

    mkdirSync(paths.dir, { recursive: true })
    writeFileSync(paths.exe, 'shim')
    assert.equal(detectInstalled(root), null, '只有 exe 不算装好')

    mkdirSync(join(root, 'models'), { recursive: true })
    writeFileSync(paths.model, 'gguf')
    const found = detectInstalled(root)
    assert.ok(found !== null, '两个文件都在 → 已安装')
    assert.deepEqual(found, paths, '返回的正是同一套布局')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ─────────────────────────── zip 解压 ───────────────────────────

test('真实发行包：解压后 exe/dll 存在且大小与 zip 内声明一致', (t) => {
  const fixture = findFixtureZip()
  if (fixture === null) {
    t.skip(`未找到真实 fixture zip（${FIXTURE_DIR}\\llama-b*-bin-win-cpu-x64.zip），跳过`)
    return
  }
  const dest = tempDir('dsh-install-zip-')
  try {
    const zip = readFileSync(fixture)
    const declared = declaredZipEntries(zip)
    const written = extractArchive(zip, dest)

    const dirCount = [...declared.keys()].filter((name) => name.endsWith('/')).length
    assert.equal(written, declared.size - dirCount, '写入的文件数 = 中央目录里的文件条目数')
    assert.ok(declared.size > 10, `fixture 条目数看起来不对：${declared.size}`)

    for (const name of ['llama-server.exe', 'llama-server-impl.dll']) {
      const info = declared.get(name)
      assert.ok(info !== undefined, `${name} 在 zip 里有声明`)
      const target = join(dest, name)
      assert.ok(existsSync(target), `${name} 被解压出来`)
      assert.equal(statSync(target).size, info.usize, `${name} 大小与声明一致`)
    }

    // 内容级核对：独立 inflate 出 llama-server.exe，与解压结果逐字节比对
    const info = declared.get('llama-server.exe')
    assert.ok(info !== undefined)
    const p = info.offset
    const nameLen = zip.readUInt16LE(p + 26)
    const extraLen = zip.readUInt16LE(p + 28)
    const raw = zip.subarray(p + 30 + nameLen + extraLen, p + 30 + nameLen + extraLen + info.csize)
    const expected = info.method === 8 ? inflateRawSync(raw) : Buffer.from(raw)
    assert.deepEqual(readFileSync(join(dest, 'llama-server.exe')), expected, 'exe 内容与独立解压结果一致')
  } finally {
    rmSync(dest, { recursive: true, force: true })
  }
})

test('zip：stored 与 deflate 都支持，嵌套路径会建目录', () => {
  const dest = tempDir('dsh-install-mixed-')
  try {
    // 故意用两个不同的顶层目录：所有条目共享同一个顶层目录时会被当发行包的
    // 外层目录剥掉（另有专门用例覆盖），这里要测的是普通的嵌套解压。
    const zip = buildZip([
      { name: 'a/stored.txt', data: Buffer.from('stored-bytes'), method: 0 },
      { name: 'b/deep/nested.txt', data: Buffer.from('deflate-bytes'.repeat(50)), method: 8 },
    ])
    assert.equal(extractArchive(zip, dest), 2)
    assert.equal(readFileSync(join(dest, 'a', 'stored.txt'), 'utf8'), 'stored-bytes')
    assert.equal(readFileSync(join(dest, 'b', 'deep', 'nested.txt'), 'utf8'), 'deflate-bytes'.repeat(50))
  } finally {
    rmSync(dest, { recursive: true, force: true })
  }
})

test('zip：目录项被跳过、顶层公共目录被剥掉', () => {
  const dest = tempDir('dsh-install-prefix-')
  try {
    const zip = buildZip([
      { name: 'llama-b12345/', data: Buffer.alloc(0) },
      { name: 'llama-b12345/llama-server.exe', data: Buffer.from('exe') },
      { name: 'llama-b12345/sub/', data: Buffer.alloc(0) },
      { name: 'llama-b12345/sub/ggml.dll', data: Buffer.from('dll') },
    ])
    assert.equal(extractArchive(zip, dest), 2)
    assert.ok(existsSync(join(dest, 'llama-server.exe')), '顶层目录被剥掉，文件直接落在目标目录')
    assert.ok(existsSync(join(dest, 'sub', 'ggml.dll')))
    assert.equal(existsSync(join(dest, 'llama-b12345')), false)
  } finally {
    rmSync(dest, { recursive: true, force: true })
  }
})

test('zip：`../` 穿越条目被拒绝，且不写任何文件', () => {
  const dest = tempDir('dsh-install-evil-')
  try {
    const zip = buildZip([
      { name: 'ok.txt', data: Buffer.from('ok') },
      { name: '../escaped.txt', data: Buffer.from('pwned') },
    ])
    assert.throws(() => extractArchive(zip, dest), /跳出安装目录/)
    assert.equal(existsSync(join(dest, '..', 'escaped.txt')), false)
  } finally {
    rmSync(dest, { recursive: true, force: true })
  }
})

test('zip：绝对路径条目被拒绝', () => {
  const dest = tempDir('dsh-install-abs-')
  try {
    assert.throws(
      () => extractArchive(buildZip([{ name: '/tmp/escaped.txt', data: Buffer.from('x') }]), dest),
      /绝对路径/,
    )
    assert.throws(
      () => extractArchive(buildZip([{ name: 'C:/escaped.txt', data: Buffer.from('x') }]), dest),
      /绝对路径/,
    )
  } finally {
    rmSync(dest, { recursive: true, force: true })
  }
})

test('zip：损坏归档与非法压缩方式都明确报错', () => {
  const dest = tempDir('dsh-install-bad-')
  try {
    const good = buildZip([{ name: 'a.txt', data: Buffer.from('hello') }])
    // 砍掉中央目录与 EOCD
    assert.throws(() => extractArchive(good.subarray(0, 20), dest), /找不到中央目录结尾记录/)
    // 自洽的 EOCD，但中央目录偏移是垃圾
    const broken = Buffer.from(good)
    broken.writeUInt32LE(0xffff, broken.length - 22 + 16)
    assert.throws(() => extractArchive(broken, dest), /中央目录已损坏|找不到/)
    // bzip2（method 12）不在支持范围
    assert.throws(
      () => extractArchive(buildZip([{ name: 'b.txt', data: Buffer.from('x'), method: 12 }]), dest),
      /不支持的 ZIP 压缩方式：12/,
    )
    // 既不是 zip 也不是 gzip
    assert.throws(() => extractArchive(Buffer.from('not an archive at all'), dest), /不支持的压缩格式/)
  } finally {
    rmSync(dest, { recursive: true, force: true })
  }
})

// ────────────────────────── tar.gz 解压 ──────────────────────────

test('tar.gz：顶层目录剥离、目录项跳过、执行位保留', () => {
  const dest = tempDir('dsh-install-tar-')
  try {
    const tar = gzipSync(buildTar([
      { name: 'llama-b12345/', type: '5', mode: 0o755 },
      { name: 'llama-b12345/llama-server', data: Buffer.from('binary'), mode: 0o755 },
      { name: 'llama-b12345/docs/', type: '5', mode: 0o755 },
      { name: 'llama-b12345/docs/README.md', data: Buffer.from('# readme'), mode: 0o644 },
      { name: 'llama-b12345/link.so', type: '2', link: 'llama-server' },
    ]))
    assert.equal(extractArchive(tar, dest), 3, '2 个普通文件 + 1 个符号链接；目录项跳过')
    assert.equal(readFileSync(join(dest, 'llama-server'), 'utf8'), 'binary')
    assert.equal(readFileSync(join(dest, 'docs', 'README.md'), 'utf8'), '# readme')
    assert.equal(existsSync(join(dest, 'llama-b12345')), false, '顶层目录被剥掉')
    if (process.platform !== 'win32') {
      assert.equal(statSync(join(dest, 'llama-server')).mode & 0o111, 0o111, '执行位保留')
      assert.equal(readlinkSync(join(dest, 'link.so')), 'llama-server', '符号链接按 linkName 建出来')
    }
  } finally {
    rmSync(dest, { recursive: true, force: true })
  }
})

test('tar.gz：两级 SONAME 软链 + 硬链接；链接出现在目标之前也能建对', () => {
  const dest = tempDir('dsh-install-link-')
  try {
    const tar = gzipSync(buildTar([
      // 链接条目故意排在真实文件**之前**：边解压边建链接会得到悬空链接
      { name: 'llama-b1/libfoo.so', type: '2', link: 'libfoo.so.0' },
      { name: 'llama-b1/libfoo.so.0', type: '2', link: 'libfoo.so.0.9.0' },
      { name: 'llama-b1/libfoo.so.0.9.0', data: Buffer.from('ELF'), mode: 0o755 },
      // 硬链接：tar 的 linkName 相对归档根
      { name: 'llama-b1/llama-server', data: Buffer.from('bin'), mode: 0o755 },
      { name: 'llama-b1/llama-cli', type: '1', link: 'llama-b1/llama-server' },
      // 越界软链必须被拒绝（不能被解压器写到 destDir 之外）
      { name: 'llama-b1/evil', type: '2', link: '../../etc/passwd' },
    ]))
    extractArchive(tar, dest)
    if (process.platform !== 'win32') {
      assert.equal(readlinkSync(join(dest, 'libfoo.so')), 'libfoo.so.0')
      assert.equal(readlinkSync(join(dest, 'libfoo.so.0')), 'libfoo.so.0.9.0')
      assert.equal(readFileSync(join(dest, 'libfoo.so'), 'utf8'), 'ELF', '两级软链最终能读到真实文件')
      assert.equal(readFileSync(join(dest, 'llama-cli'), 'utf8'), 'bin', '硬链接可读')
      assert.equal(existsSync(join(dest, 'evil')), false, '越界软链被拒绝')
    }
  } finally {
    rmSync(dest, { recursive: true, force: true })
  }
})

test('tar.gz：`../` 穿越条目同样被拒绝', () => {
  const dest = tempDir('dsh-install-tarevil-')
  try {
    const tar = gzipSync(buildTar([
      { name: 'ok.txt', data: Buffer.from('ok') },
      { name: '../escaped.txt', data: Buffer.from('pwned') },
    ]))
    assert.throws(() => extractArchive(tar, dest), /跳出安装目录/)
  } finally {
    rmSync(dest, { recursive: true, force: true })
  }
})

// ──────────────────── 链接兜底与解压后校验 ────────────────────

test('tar.gz：软链建不出来（FAT/exFAT）时退化为复制，链式依赖分多轮完成', () => {
  const dest = tempDir('dsh-install-copylink-')
  try {
    // 两级 SONAME 链，且链接排在真实文件之前——软链不可用时，第二轮才可能
    // 复制到真实内容（第一轮 libfoo.so 的源 libfoo.so.0 还是个待建的链接）。
    const tar = gzipSync(buildTar([
      { name: 'llama-b1/libfoo.so', type: '2', link: 'libfoo.so.0' },
      { name: 'llama-b1/libfoo.so.0', type: '2', link: 'libfoo.so.0.9.0' },
      { name: 'llama-b1/libfoo.so.0.9.0', data: Buffer.from('ELF'), mode: 0o755 },
    ]))
    const report = extractArchiveReport(tar, dest, {
      symlink: () => { throw Object.assign(new Error('EPERM: operation not permitted, symlink'), { code: 'EPERM' }) },
    })
    assert.equal(report.written, 3, '1 个普通文件 + 2 条退化复制出来的链接')
    assert.equal(report.links.symlinked, 0)
    assert.equal(report.links.copied, 2, '两条软链都退化为复制')
    assert.equal(report.links.failed, 0, '退化成功不算失败')
    assert.ok(report.links.rounds >= 2, `链式依赖需要多轮重试（实际 ${report.links.rounds} 轮）`)
    // 退化后必须是**真实文件**（内容 = 最终目标），否则动态加载器仍然找不到库
    assert.equal(lstatSync(join(dest, 'libfoo.so')).isSymbolicLink(), false)
    assert.equal(lstatSync(join(dest, 'libfoo.so.0')).isSymbolicLink(), false)
    assert.equal(readFileSync(join(dest, 'libfoo.so'), 'utf8'), 'ELF')
    assert.equal(readFileSync(join(dest, 'libfoo.so.0'), 'utf8'), 'ELF')
    // 兼容：extractArchive 仍然只返回数字（既有调用方/测试的语义不变）
    const dest2 = tempDir('dsh-install-copylink2-')
    try {
      assert.equal(typeof extractArchive(tar, dest2, { symlink: () => { throw new Error('EPERM') } }), 'number')
    } finally {
      rmSync(dest2, { recursive: true, force: true })
    }
  } finally {
    rmSync(dest, { recursive: true, force: true })
  }
})

test('tar.gz：链接多轮都建不出来时，失败数与明细进返回值，不再静默吞掉', () => {
  const dest = tempDir('dsh-install-linkfail-')
  try {
    const tar = gzipSync(buildTar([
      { name: 'llama-b1/libfoo.so', type: '2', link: 'libfoo.so.0' }, // 目标本体根本不存在
      { name: 'llama-b1/ok.txt', data: Buffer.from('ok') },
    ]))
    const report = extractArchiveReport(tar, dest, { symlink: () => { throw new Error('ENOSYS: symlink not supported') } })
    assert.equal(report.written, 1, '只有普通文件算进 written')
    assert.equal(report.links.failed, 1, '建不出来的链接必须报数')
    assert.match(report.links.failures[0] ?? '', /libfoo\.so/, '失败明细带库名，上层才能写进 message')
    assert.match(report.links.failures[0] ?? '', /ENOENT|no such file/i)
  } finally {
    rmSync(dest, { recursive: true, force: true })
  }
})

test('verifyRuntimeLinks：能解析的 SONAME 链 → ok；悬空链接 → 报出库名、目标与原因', (t) => {
  const dir = tempDir('dsh-install-verify-')
  try {
    writeFileSync(join(dir, 'libllama-common.so.0.9.0'), 'ELF')
    try {
      symlinkSync('libllama-common.so.0.9.0', join(dir, 'libllama-common.so.0'))
      symlinkSync('libllama-common.so.0', join(dir, 'libllama-common.so'))
    } catch {
      t.skip('当前文件系统不支持符号链接，跳过')
      return
    }
    const healthy = verifyRuntimeLinks(dir)
    assert.equal(healthy.ok, true)
    assert.equal(healthy.checked, 2, '两条链接都检查到')
    assert.deepEqual(healthy.issues, [])

    // 悬空链接（目标文件没解出来）：安装后启动就会 cannot open shared object file
    symlinkSync('libmissing.so.0', join(dir, 'libmissing.so'))
    const broken = verifyRuntimeLinks(dir)
    assert.equal(broken.ok, false)
    assert.equal(broken.checked, 3)
    assert.deepEqual(broken.issues.map((issue) => issue.name), ['libmissing.so'])
    assert.equal(broken.issues[0]?.target, 'libmissing.so.0')
    assert.match(broken.issues[0]?.reason ?? '', /ENOENT/)

    // 不叫 *.so / *.dylib 的杂项软链（指向文档/目录）不参与判定：
    // 它解析不了也不影响动态加载，不该把安装判成失败。
    symlinkSync('nowhere/README', join(dir, 'docs-link'))
    const noisy = verifyRuntimeLinks(dir)
    assert.equal(noisy.checked, 3, '只检查 SONAME 链接')
    assert.equal(noisy.ok, false, '悬空的 SONAME 链接仍然要报')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─────────────────────── 磁盘预检 ───────────────────────

test('diskNeedBytes：模型 ×1.25 + 运行时预留 + 200MB 余量，已就位的不重复计', () => {
  const root = tempDir('dsh-install-need-')
  try {
    const paths = installPaths(root)
    const model = { file: 'm.gguf', bytes: 1_000_000 }
    const need = diskNeedBytes(paths, model, 'cpu')
    // 1.25MB 模型 + 256MB 运行时 + 200MB 余量
    assert.ok(need >= 1_250_000 + 456 * 1024 * 1024, `CPU 预检偏小：${need}`)
    assert.ok(need < 458 * 1024 * 1024, `CPU 预检偏大：${need}`)
    assert.ok(diskNeedBytes(paths, model, 'cuda') > need, 'CUDA 伴生包要预留更多空间')

    // 已装好的部分不重复算：只剩 200MB 余量（断点续装不会被误拦）
    mkdirSync(join(root, 'models'), { recursive: true })
    writeFileSync(paths.model, 'x')
    mkdirSync(paths.dir, { recursive: true })
    writeFileSync(paths.exe, 'x')
    assert.equal(diskNeedBytes(paths, model, 'cpu'), 200 * 1024 * 1024)

    // 模型没给 bytes 时按内置 bge-m3 体积算
    const noBytes = diskNeedBytes(installPaths(join(root, 'other')), { file: 'x.gguf' }, 'cpu')
    assert.ok(noBytes >= Math.ceil(MODEL_SIZE_BYTES * 1.25) + 200 * 1024 * 1024)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('freeDiskBytes：statfsSync 能读到真实可用空间，读不到时返回 null 不抛', () => {
  const dir = tempDir('dsh-install-statfs-')
  try {
    const free = freeDiskBytes(dir)
    assert.notEqual(free, null, '目标目录存在时 statfs 应该能读到空间')
    assert.ok((free ?? -1) >= 0)
    // 不存在的路径 → 读不到也不许抛（预检失败只能跳过，不能拦死安装）
    assert.equal(freeDiskBytes(join(dir, 'nope', 'deeper')), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ────────────────────────── 平台资产匹配 ──────────────────────────

test('平台 → 资产正则：只认 CPU 包，不误选 cuda/vulkan/cudart', () => {
  const cases: Array<[NodeJS.Platform, string, RegExp]> = [
    ['win32', 'x64', /^llama-.*-bin-win-cpu-x64\.zip$/],
    ['win32', 'arm64', /^llama-.*-bin-win-cpu-arm64\.zip$/],
    ['linux', 'x64', /^llama-.*-bin-ubuntu-x64\.(?:zip|tar\.gz)$/],
    ['linux', 'arm64', /^llama-.*-bin-ubuntu-arm64\.(?:zip|tar\.gz)$/],
    ['darwin', 'arm64', /^llama-.*-bin-macos-arm64\.(?:zip|tar\.gz)$/],
    ['darwin', 'x64', /^llama-.*-bin-macos-x64\.(?:zip|tar\.gz)$/],
  ]
  for (const [platform, arch, expected] of cases) {
    assert.equal(String(runtimeAssetPattern(platform, arch)), String(expected), `${platform}-${arch}`)
  }
  assert.throws(() => runtimeAssetPattern('linux', 'ia32'), /资产匹配失败：linux-ia32/)
  assert.throws(() => runtimeAssetPattern('freebsd', 'x64'), /资产匹配失败/)

  // 真实 b11541 资产名（2026-10-10 实测）：只有 CPU 包应该被选中
  const realNames = [
    'llama-b11541-bin-win-cuda-12.4-x64.zip',
    'llama-b11541-bin-win-vulkan-x64.zip',
    'llama-b11541-bin-win-cpu-x64.zip',
    // 伴生包与 CUDA 主包共享后缀，绝不能当成运行时（issue #4）
    'cudart-llama-bin-win-cuda-12.4-x64.zip',
  ]
  const win = pickRuntimeAsset(realNames.map((name) => ({ name, browser_download_url: `https://x/${name}` })), 'win32', 'x64')
  assert.equal(win?.name, 'llama-b11541-bin-win-cpu-x64.zip')

  const linuxNames = [
    'llama-b11541-bin-ubuntu-vulkan-x64.tar.gz',
    'llama-b11541-bin-ubuntu-cuda-12.8-x64.tar.gz',
    'llama-b11541-bin-ubuntu-x64.tar.gz',
  ]
  const linux = pickRuntimeAsset(linuxNames.map((name) => ({ name, browser_download_url: `https://x/${name}` })), 'linux', 'x64')
  assert.equal(linux?.name, 'llama-b11541-bin-ubuntu-x64.tar.gz')

  assert.equal(pickRuntimeAsset([{ name: 'unrelated.txt', browser_download_url: 'https://x' }], 'win32', 'x64'), null)
  assert.equal(pickRuntimeAsset([{ name: 42 }, null], 'win32', 'x64'), null, '脏数据不炸')
})

test('运行时候选通道：直链优先，API 资产端点带 Accept: application/octet-stream', () => {
  const sources = runtimeDownloadSources({
    name: 'llama-b19999-bin-win-cpu-x64.zip',
    url: 'https://github.com/ggml-org/llama.cpp/releases/download/b19999/x.zip',
    apiUrl: 'https://api.github.com/repos/ggml-org/llama.cpp/releases/assets/627383570',
  })
  assert.equal(sources.length, 2)
  assert.equal(sources[0]?.url, 'https://github.com/ggml-org/llama.cpp/releases/download/b19999/x.zip')
  assert.equal(sources[0]?.accept, '*/*')
  assert.equal(sources[1]?.url, 'https://api.github.com/repos/ggml-org/llama.cpp/releases/assets/627383570')
  assert.equal(sources[1]?.accept, 'application/octet-stream', 'API 资产端点必须带这个 Accept 才回二进制')
  // 老响应可能没有 asset.url：只剩直链
  assert.equal(runtimeDownloadSources({ name: 'x.zip', url: 'https://github.com/x', apiUrl: '' }).length, 1)
  // 两者相同时不重复请求同一个 URL
  assert.equal(runtimeDownloadSources({ name: 'x.zip', url: 'https://x', apiUrl: 'https://x' }).length, 1)
})

// ────────────────────────── 完整流程 ──────────────────────────

test('完整流程：查发行版 → 下运行时 → 解压 → 下模型 → done', async (t) => {
  if (!hostSupported()) {
    t.skip(`宿主平台 ${process.platform}-${process.arch} 不在支持列表，跳过`)
    return
  }
  const root = tempDir('dsh-install-flow-')
  try {
    const paths = installPaths(root)
    const runtime = buildRuntimeFixture()
    const modelBytes = Buffer.alloc(384 * 1024, 6)
    const modelChunks = [
      modelBytes.subarray(0, 100_000),
      modelBytes.subarray(100_000, 300_000),
      modelBytes.subarray(300_000),
    ]
    const calls: string[] = []
    const fetchImpl = fakeFetch((url) => {
      calls.push(url)
      if (url.includes('api.github.com')) {
        return jsonResponse([{
          assets: [
            // 干扰项：非 CPU 包必须被跳过
            { name: 'llama-b19999-bin-win-cuda-12.4-x64.zip', browser_download_url: 'https://example.invalid/wrong.zip' },
            { name: runtime.name, browser_download_url: 'https://example.invalid/runtime' },
          ],
        }])
      }
      if (url === 'https://example.invalid/runtime') return streamResponse([runtime.bytes], runtime.bytes.length)
      if (url.includes(MODEL_FILE_NAME)) return streamResponse(modelChunks, modelBytes.length)
      return new Response('unexpected', { status: 404 })
    })
    const reports: InstallProgress[] = []
    const installer = new VectorInstaller({ platform: TEST_PLATFORM, arch: TEST_ARCH, root, fetchImpl, onProgress: (p) => reports.push(p), probeVersion: fakeProbe() })

    installer.start()
    installer.start() // 幂等：第二次必须被忽略（否则会下两遍）
    await waitFor(() => installer.progress.phase === 'done' || installer.progress.phase === 'error', '安装结束')

    assert.equal(installer.progress.phase, 'done', installer.progress.error ?? installer.progress.message)
    assert.equal(installer.progress.error, null)

    // 落地结果
    const installed = detectInstalled(root)
    assert.ok(installed !== null, 'detectInstalled 认了这次安装')
    assert.deepEqual(installed, paths)
    assert.equal(statSync(paths.model).size, modelBytes.length, '模型字节数完整')
    assert.ok(statSync(paths.exe).size > 0, '运行时 exe 落地')
    assert.ok(existsSync(join(paths.dir, runtime.name)), '压缩包留在运行时目录（与既有布局一致）')

    // 半成品清理干净
    const leftover = [
      ...readdirSync(paths.dir).filter((name) => name.endsWith('.part')),
      ...readdirSync(join(root, 'models')).filter((name) => name.endsWith('.part')),
    ]
    assert.deepEqual(leftover, [], '没有 .part 残留')

    // 只查了一次发行版接口（幂等）
    assert.equal(calls.filter((url) => url.includes('api.github.com')).length, 1)

    // 阶段顺序单调推进
    const order = ['preparing', 'downloading-runtime', 'extracting', 'downloading-model', 'done']
    let cursor = -1
    for (const report of reports) {
      const index = order.indexOf(report.phase)
      if (index === -1) continue
      assert.ok(index >= cursor, `阶段不能回退：${report.phase}`)
      cursor = index
    }
    assert.equal(cursor, order.length - 1, '走完了全部阶段')

    // 进度累计：运行时用 zip 的字节数，模型用三块累加到总长
    const runtimeReports = reports.filter((p) => p.phase === 'downloading-runtime')
    const lastRuntime = runtimeReports.at(-1)
    assert.ok(lastRuntime !== undefined)
    assert.equal(lastRuntime.receivedBytes, runtime.bytes.length, '运行时字节数累加正确')
    assert.equal(lastRuntime.totalBytes, runtime.bytes.length, 'totalBytes 来自 content-length')

    const modelReports = reports.filter((p) => p.phase === 'downloading-model' && p.receivedBytes > 0)
    let previous = 0
    for (const report of modelReports) {
      assert.ok(report.receivedBytes >= previous, '模型进度只增不减')
      previous = report.receivedBytes
    }
    const lastModel = modelReports.at(-1)
    assert.ok(lastModel !== undefined)
    assert.equal(lastModel.receivedBytes, modelBytes.length, '模型字节数累加正确')
    assert.equal(lastModel.totalBytes, modelBytes.length)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('回归 issue #4：cudart 资产排在主包前面时，CUDA 安装仍下 llama-* 主包并装完', async (t) => {
  if (!hostSupported()) {
    t.skip(`宿主平台 ${process.platform}-${process.arch} 不在支持列表，跳过`)
    return
  }
  const fixture = buildCudaFixture()
  if (fixture === null) {
    t.skip('该平台没有 CUDA 构建（macOS 的 GPU 路径是 Metal），不涉及 cudart 伴生包')
    return
  }
  const root = tempDir('dsh-install-cuda-')
  try {
    const paths = installPaths(root)
    const modelBytes = Buffer.alloc(128 * 1024, 9)
    const calls: string[] = []
    const fetchImpl = fakeFetch((url) => {
      calls.push(url)
      if (url.includes('api.github.com')) return jsonResponse([{ assets: fixture.assets }])
      if (url === 'https://example.invalid/main') return streamResponse([fixture.main.bytes], fixture.main.bytes.length)
      if (url === 'https://example.invalid/companion') return streamResponse([fixture.companion.bytes], fixture.companion.bytes.length)
      if (url.includes(MODEL_FILE_NAME)) return streamResponse([modelBytes], modelBytes.length)
      return new Response('unexpected', { status: 404 })
    })
    const installer = new VectorInstaller({ platform: TEST_PLATFORM, arch: TEST_ARCH, root, fetchImpl, flavor: 'cuda', probeVersion: fakeProbe() })

    installer.start()
    await waitFor(() => installer.progress.phase === 'done' || installer.progress.phase === 'error', 'CUDA 安装结束')

    assert.equal(installer.progress.phase, 'done', installer.progress.error ?? installer.progress.message)
    assert.ok(calls.includes('https://example.invalid/main'), '必须下载 llama-* 主包（旧版在这里误下 cudart，解压后没有 exe）')
    assert.ok(calls.includes('https://example.invalid/companion'), 'cudart 伴生包也要下')
    assert.ok(existsSync(paths.exe), 'llama-server 落地')
    assert.ok(existsSync(join(paths.dir, fixture.main.name)), '主包压缩包留在运行时目录（重试可复用）')
    assert.ok(existsSync(join(paths.dir, fixture.companion.name)), '伴生包压缩包留在运行时目录（重试可复用）')
    assert.ok(detectInstalled(root) !== null, '装完 detectInstalled 认可')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('运行时通道回退：直链被重置 → 改用 GitHub API 资产端点并装完', async (t) => {
  if (!hostSupported()) {
    t.skip(`宿主平台 ${process.platform}-${process.arch} 不在支持列表，跳过`)
    return
  }
  const root = tempDir('dsh-install-channel-')
  try {
    const paths = installPaths(root)
    const runtime = buildRuntimeFixture()
    const modelBytes = Buffer.alloc(64 * 1024, 7)
    const directUrl = 'https://github.com/ggml-org/llama.cpp/releases/download/b19999/runtime'
    const apiAssetUrl = 'https://api.github.com/repos/ggml-org/llama.cpp/releases/assets/627383570'
    const seen: Array<{ url: string; accept: string }> = []
    const fetchImpl = fakeFetch((url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      seen.push({ url, accept: headers.accept ?? '' })
      if (url.includes('/releases?')) {
        return jsonResponse([{ assets: [{ name: runtime.name, browser_download_url: directUrl, url: apiAssetUrl }] }])
      }
      if (url === directUrl) throw new TypeError('fetch failed') // 直链 302 到被重置的主机
      if (url === apiAssetUrl) return streamResponse([runtime.bytes], runtime.bytes.length)
      if (url.includes(MODEL_FILE_NAME)) return streamResponse([modelBytes], modelBytes.length)
      return new Response('unexpected', { status: 404 })
    })
    const reports: InstallProgress[] = []
    const installer = new VectorInstaller({ platform: TEST_PLATFORM, arch: TEST_ARCH, root, fetchImpl, onProgress: (p) => reports.push(p), probeVersion: fakeProbe() })
    installer.start()
    await waitFor(() => installer.progress.phase === 'done' || installer.progress.phase === 'error', '安装结束')

    assert.equal(installer.progress.phase, 'done', installer.progress.error ?? installer.progress.message)
    // 先试直链，再退到 API 资产端点，且备用通道带对了 Accept
    const direct = seen.findIndex((call) => call.url === directUrl)
    const api = seen.findIndex((call) => call.url === apiAssetUrl)
    assert.ok(direct >= 0 && api > direct, `直链先失败再走 API 端点：${JSON.stringify(seen.map((c) => c.url))}`)
    assert.equal(seen[api]?.accept, 'application/octet-stream', 'API 资产端点必须带 application/octet-stream')
    assert.equal(seen[direct]?.accept, '*/*')

    assert.ok(existsSync(join(paths.dir, runtime.name)), '备用通道下回来的运行时压缩包落了盘')
    assert.equal(detectInstalled(root)?.exe, paths.exe)
    assert.ok(reports.some((p) => /换下一个通道重试/.test(p.message)), '给出换通道提示')
    assert.ok(
      reports.some((p) => /通道：GitHub API 资产端点/.test(p.message)),
      '成功日志注明走的哪条通道',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('运行时两条通道都失败：报出每个通道与原因', async () => {
  const root = tempDir('dsh-install-chanfail-')
  try {
    const runtime = buildRuntimeFixture()
    const directUrl = 'https://github.com/ggml-org/llama.cpp/releases/download/b19999/runtime'
    const apiAssetUrl = 'https://api.github.com/repos/ggml-org/llama.cpp/releases/assets/1'
    const fetchImpl = fakeFetch((url) => {
      if (url.includes('/releases?')) {
        return jsonResponse([{ assets: [{ name: runtime.name, browser_download_url: directUrl, url: apiAssetUrl }] }])
      }
      if (url === directUrl) throw new TypeError('fetch failed')
      if (url === apiAssetUrl) return new Response('nope', { status: 502, statusText: 'Bad Gateway' })
      return new Response('unexpected', { status: 404 })
    })
    const installer = new VectorInstaller({ platform: TEST_PLATFORM, arch: TEST_ARCH, root, fetchImpl })
    installer.start()
    await waitFor(() => installer.progress.phase === 'error', '进入 error')

    assert.match(installer.progress.message, /所有通道都失败/)
    assert.match(installer.progress.message, /发行包直链/)
    assert.match(installer.progress.message, /GitHub API 资产端点/)
    assert.match(installer.progress.message, /HTTP 502/)
    assert.equal(existsSync(`${join(installPaths(root).dir, runtime.name)}.part`), false, '没有 .part 残留')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('完整流程：响应没有 content-length 时 totalBytes 为 null', async (t) => {
  if (!hostSupported()) {
    t.skip(`宿主平台 ${process.platform}-${process.arch} 不在支持列表，跳过`)
    return
  }
  const root = tempDir('dsh-install-nolen-')
  try {
    const runtime = buildRuntimeFixture()
    const modelBytes = Buffer.alloc(64 * 1024, 2)
    const fetchImpl = fakeFetch((url) => {
      if (url.includes('api.github.com')) {
        return jsonResponse([{ assets: [{ name: runtime.name, browser_download_url: 'https://example.invalid/runtime' }] }])
      }
      if (url === 'https://example.invalid/runtime') return streamResponse([runtime.bytes], null)
      return streamResponse([modelBytes], null)
    })
    const reports: InstallProgress[] = []
    const installer = new VectorInstaller({ platform: TEST_PLATFORM, arch: TEST_ARCH, root, fetchImpl, onProgress: (p) => reports.push(p), probeVersion: fakeProbe() })
    installer.start()
    await waitFor(() => installer.progress.phase === 'done' || installer.progress.phase === 'error', '安装结束')

    assert.equal(installer.progress.phase, 'done', installer.progress.error ?? installer.progress.message)
    assert.equal(reports.find((p) => p.phase === 'downloading-runtime')?.totalBytes, null)
    assert.equal(reports.find((p) => p.phase === 'downloading-model')?.totalBytes, null)
    assert.equal(detectInstalled(root)?.model, installPaths(root).model)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ──────────────────────────── 取消 ────────────────────────────

test('cancel：中止在途下载、删掉 .part、phase 回到 idle', async (t) => {
  if (!hostSupported()) {
    t.skip(`宿主平台 ${process.platform}-${process.arch} 不在支持列表，跳过`)
    return
  }
  const root = tempDir('dsh-install-cancel-')
  try {
    const paths = installPaths(root)
    const runtime = buildRuntimeFixture()
    const fetchImpl = fakeFetch((url, init) => {
      if (url.includes('api.github.com')) {
        return jsonResponse([{ assets: [{ name: runtime.name, browser_download_url: 'https://example.invalid/runtime' }] }])
      }
      return stallResponse(init?.signal, Buffer.alloc(32 * 1024, 9), 8 * 1024 * 1024)
    })
    const reports: InstallProgress[] = []
    const installer = new VectorInstaller({ platform: TEST_PLATFORM, arch: TEST_ARCH, root, fetchImpl, onProgress: (p) => reports.push(p) })

    installer.start()
    const part = `${join(paths.dir, runtime.name)}.part`
    await waitFor(() => existsSync(part), '.part 被创建')
    await waitFor(() => reports.some((p) => p.phase === 'downloading-runtime' && p.receivedBytes > 0), '收到第一块')

    installer.cancel()
    assert.equal(installer.progress.phase, 'idle', '取消后回到 idle')
    assert.equal(installer.progress.error, null)
    assert.equal(existsSync(part), false, '.part 被清理')
    assert.equal(detectInstalled(root), null, '没有装出半成品')

    // 在途的 run() 收尾后不能把状态改回 error，也不能再把 .part 写出来
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(installer.progress.phase, 'idle', '过期的 run 不能覆盖状态')
    assert.equal(existsSync(part), false)
    assert.equal(reports.at(-1)?.phase, 'idle')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cancel 在没有任务时是 no-op', () => {
  const installer = new VectorInstaller({ platform: TEST_PLATFORM, arch: TEST_ARCH, root: 'D:/nonexistent-root-should-not-be-touched' })
  installer.cancel()
  assert.equal(installer.progress.phase, 'idle')
  assert.equal(existsSync('D:/nonexistent-root-should-not-be-touched'), false)
})

// ─────────────────────────── 错误分支 ───────────────────────────

test('GitHub API 限流：phase=error 且 message 可读', async () => {
  const root = tempDir('dsh-install-403-')
  try {
    const fetchImpl = fakeFetch(() => new Response('rate limited', { status: 403 }))
    const installer = new VectorInstaller({ platform: TEST_PLATFORM, arch: TEST_ARCH, root, fetchImpl })
    installer.start()
    await waitFor(() => installer.progress.phase === 'error', '进入 error')
    assert.equal(installer.progress.phase, 'error')
    assert.match(installer.progress.message, /GitHub API 限流/)
    assert.equal(installer.progress.error, installer.progress.message)
    assert.equal(installer.progress.paths, null)
    assert.equal(existsSync(installPaths(root).dir), true, '目录已经建好，只是没下东西')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('资产匹配失败：报出平台与正则', async () => {
  const root = tempDir('dsh-install-nomatch-')
  try {
    const fetchImpl = fakeFetch(() => jsonResponse([{ assets: [{ name: 'llama-b1-bin-ubuntu-x64.tar.gz', browser_download_url: 'https://x' }] }]))
    const installer = new VectorInstaller({ platform: TEST_PLATFORM, arch: TEST_ARCH, root, fetchImpl, platform: 'win32', arch: 'x64' })
    installer.start()
    await waitFor(() => installer.progress.phase === 'error', '进入 error')
    assert.match(installer.progress.message, /资产匹配失败：win32-x64/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('网络层失败（fetch reject）被翻译成人话，不逃逸出 start()', async () => {
  const root = tempDir('dsh-install-net-')
  try {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    const installer = new VectorInstaller({ platform: TEST_PLATFORM, arch: TEST_ARCH, root, fetchImpl })
    installer.start() // 不能抛
    await waitFor(() => installer.progress.phase === 'error', '进入 error')
    assert.match(installer.progress.message, /网络请求失败/)
    assert.match(installer.progress.message, /fetch failed/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('模型多源回退：前一个源失败就换下一个，直到成功', async (t) => {
  if (!hostSupported()) {
    t.skip(`宿主平台 ${process.platform}-${process.arch} 不在支持列表，跳过`)
    return
  }
  const root = tempDir('dsh-install-src-')
  try {
    const runtime = buildRuntimeFixture()
    const modelBytes = Buffer.alloc(64 * 1024, 5)
    const sources = ['https://a.invalid/m.gguf', 'https://b.invalid/m.gguf']
    const hits: string[] = []
    const fetchImpl = fakeFetch((url) => {
      if (url.includes('api.github.com')) {
        return jsonResponse([{ assets: [{ name: runtime.name, browser_download_url: 'https://example.invalid/rt' }] }])
      }
      if (url === 'https://example.invalid/rt') return streamResponse([runtime.bytes], runtime.bytes.length)
      hits.push(url)
      if (url.startsWith('https://a.invalid')) return new Response('boom', { status: 500, statusText: 'Server Error' })
      return streamResponse([modelBytes], modelBytes.length)
    })
    const reports: InstallProgress[] = []
    const installer = new VectorInstaller({ platform: TEST_PLATFORM, arch: TEST_ARCH, root, fetchImpl, modelSources: sources, onProgress: (p) => reports.push(p), probeVersion: fakeProbe() })
    installer.start()
    await waitFor(() => installer.progress.phase === 'done' || installer.progress.phase === 'error', '安装结束')

    assert.equal(installer.progress.phase, 'done', installer.progress.error ?? installer.progress.message)
    assert.deepEqual(hits, sources, '按顺序尝试了第一个源，失败后换第二个')
    assert.ok(
      reports.some((p) => /换下一个源重试/.test(p.message)),
      '换源时给出可读提示',
    )
    assert.equal(detectInstalled(root)?.model, installPaths(root).model)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('模型所有源都失败：报出每个源自己的原因', async (t) => {
  if (!hostSupported()) {
    t.skip(`宿主平台 ${process.platform}-${process.arch} 不在支持列表，跳过`)
    return
  }
  const root = tempDir('dsh-install-srcfail-')
  try {
    const runtime = buildRuntimeFixture()
    const fetchImpl = fakeFetch((url) => {
      if (url.includes('api.github.com')) {
        return jsonResponse([{ assets: [{ name: runtime.name, browser_download_url: 'https://example.invalid/rt' }] }])
      }
      if (url === 'https://example.invalid/rt') return streamResponse([runtime.bytes], runtime.bytes.length)
      return new Response('down', { status: 503, statusText: 'Unavailable' })
    })
    const installer = new VectorInstaller({ platform: TEST_PLATFORM, arch: TEST_ARCH,
      root,
      fetchImpl,
      modelSources: ['https://a.invalid/m.gguf', 'https://b.invalid/m.gguf'],
    })
    installer.start()
    await waitFor(() => installer.progress.phase === 'error', '进入 error')

    assert.match(installer.progress.message, /所有源都失败/)
    assert.match(installer.progress.message, /a\.invalid：/)
    assert.match(installer.progress.message, /b\.invalid：/)
    assert.match(installer.progress.message, /HTTP 503/)
    assert.equal(existsSync(`${installPaths(root).model}.part`), false, '失败后没有 .part 残留')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('已安装时 start() 什么都不做：不查 GitHub、不覆盖既有文件', async () => {
  const root = tempDir('dsh-install-ready-')
  try {
    const paths = installPaths(root)
    mkdirSync(paths.dir, { recursive: true })
    mkdirSync(join(root, 'models'), { recursive: true })
    writeFileSync(paths.exe, 'hand-made-shim')
    writeFileSync(paths.model, 'hand-made-gguf')

    let called = 0
    const fetchImpl = (async () => {
      called++
      return new Response('nope', { status: 500 })
    }) as unknown as typeof fetch
    const installer = new VectorInstaller({ platform: TEST_PLATFORM, arch: TEST_ARCH, root, fetchImpl })
    installer.start()
    await new Promise((resolve) => setTimeout(resolve, 30))

    assert.equal(called, 0, '一次网络请求都不发')
    assert.equal(installer.progress.phase, 'done')
    assert.deepEqual(installer.progress.paths, paths)
    assert.equal(readFileSync(paths.exe, 'utf8'), 'hand-made-shim', '既有文件不被覆盖')
    assert.equal(readFileSync(paths.model, 'utf8'), 'hand-made-gguf')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('安装流程：解压后 SONAME 链接解析不了 → phase=error 且写明缺哪个库，不报 done', async (t) => {
  if (!hostSupported()) {
    t.skip(`宿主平台 ${process.platform}-${process.arch} 不在支持列表，跳过`)
    return
  }
  if (process.platform === 'win32') {
    t.skip('Windows 运行时是 zip（没有符号链接），这条只覆盖 tar.gz 路径')
    return
  }
  const root = tempDir('dsh-install-badso-')
  try {
    const dirName = process.platform === 'darwin' ? 'macos' : 'ubuntu'
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    const runtimeName = `llama-b19999-bin-${dirName}-${arch}.tar.gz`
    // 只有 SONAME 软链，缺 .so.0.9.0 本体：解压本身「成功」，但链接是悬空的
    const runtimeBytes = gzipSync(buildTar([
      { name: 'llama-b19999/', type: '5' },
      { name: 'llama-b19999/llama-server', data: Buffer.from('llama-server-bin'), mode: 0o755 },
      { name: 'llama-b19999/libllama-common.so', type: '2', link: 'libllama-common.so.0' },
      { name: 'llama-b19999/libllama-common.so.0', type: '2', link: 'libllama-common.so.0.9.0' },
    ]))
    const paths = installPaths(root)
    let modelRequested = false
    const fetchImpl = fakeFetch((url) => {
      if (url.includes('api.github.com')) {
        return jsonResponse([{ assets: [{ name: runtimeName, browser_download_url: 'https://example.invalid/rt' }] }])
      }
      if (url === 'https://example.invalid/rt') return streamResponse([runtimeBytes], runtimeBytes.length)
      modelRequested = true
      return new Response('should not download model', { status: 500 })
    })
    const installer = new VectorInstaller({ platform: TEST_PLATFORM, arch: TEST_ARCH, root, fetchImpl })
    installer.start()
    await waitFor(() => installer.progress.phase === 'error' || installer.progress.phase === 'done', '安装结束')

    assert.equal(installer.progress.phase, 'error', '悬空 SONAME 链接必须在解压后拦下，不能报 done')
    assert.match(installer.progress.message, /运行时校验失败/)
    assert.match(installer.progress.message, /libllama-common\.so/, 'message 必须写明缺哪个库')
    assert.match(installer.progress.message, /cannot open shared object file|不支持符号链接/, 'message 必须写清原因/后果')
    assert.equal(installer.progress.error, installer.progress.message)
    assert.equal(modelRequested, false, '链接校验失败就不该继续下模型')
    assert.equal(existsSync(paths.model), false, '模型没被下载')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('磁盘预检：空间不够 → phase=error 并给出要释放多少 GB，且一次网络请求都不发', async () => {
  const root = tempDir('dsh-install-nodisk-')
  try {
    let calls = 0
    const fetchImpl = fakeFetch(() => {
      calls++
      return new Response('nope', { status: 500 })
    })
    const reports: InstallProgress[] = []
    const installer = new VectorInstaller({ platform: TEST_PLATFORM, arch: TEST_ARCH,
      root,
      fetchImpl,
      freeBytes: () => 100 * 1024 * 1024, // 只剩 100MB
      onProgress: (p) => reports.push(p),
    })
    installer.start()
    await waitFor(() => installer.progress.phase === 'error', '进入 error')

    assert.match(installer.progress.message, /磁盘空间不足/)
    assert.match(installer.progress.message, /请至少再释放约 [\d.]+GB/, '要给出需要释放的 GB 数')
    assert.equal(calls, 0, '预检必须在任何下载之前完成')
    assert.ok(reports.some((p) => /磁盘预检/.test(p.message)), '给出预检阶段提示')
    assert.equal(existsSync(installPaths(root).dir), true, '目录已建好（statfs 需要真实路径）')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('磁盘预检：读不到可用空间时跳过预检，不拦死安装', async () => {
  const root = tempDir('dsh-install-nodisk-unknown-')
  try {
    let calls = 0
    const fetchImpl = fakeFetch(() => {
      calls++
      return new Response('rate limited', { status: 403 })
    })
    const installer = new VectorInstaller({ platform: TEST_PLATFORM, arch: TEST_ARCH, root, fetchImpl, freeBytes: () => null })
    installer.start()
    await waitFor(() => installer.progress.phase === 'error', '进入 error')

    assert.ok(calls > 0, 'statfs 读不到空间时必须放行，而不是把安装拦死')
    assert.match(installer.progress.message, /GitHub API 限流/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ─────────────── 断点续传 / 完整性校验 / 安装后冒烟 ───────────────

/** 假运行时的下载直链（续传用例里被反复访问的就是它）。 */
const RUNTIME_URL = 'https://example.invalid/runtime'

/** 预置「上次进程下到一半」的现场：.part 有前 split 字节，旁边有 .part.meta。 */
function seedPart(
  archivePath: string,
  bytes: Buffer,
  split: number,
  url: string,
  etag: string | null = '"etag-v1"',
): string {
  const part = `${archivePath}.part`
  mkdirSync(dirname(archivePath), { recursive: true })
  writeFileSync(part, bytes.subarray(0, split))
  writeFileSync(`${part}.meta`, JSON.stringify({ url, bytes: split, etag, lastModified: null }))
  return part
}

interface FlowOptions {
  runtimeName: string
  /** 运行时那次请求的响应（续传用例在这里断言请求头、造 206/200/416）。 */
  runtimeResponse: (headers: Record<string, string>) => Response
  modelBytes: Buffer
  /** 模型响应覆盖（完整性用例要造「声明长度和实际不符」）。 */
  modelResponse?: () => Response
  /** 每次请求的回调（断言 Range/If-Range 用）。 */
  onRequest?: (url: string, headers: Record<string, string>) => void
}

/** 完整流程的假 fetch：打开发行版接口、下运行时、下模型，全部离线。 */
function flowFetch(opts: FlowOptions): typeof fetch {
  return fakeFetch((url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    opts.onRequest?.(url, headers)
    if (url.includes('api.github.com')) {
      return jsonResponse([{ assets: [{ name: opts.runtimeName, browser_download_url: RUNTIME_URL }] }])
    }
    if (url === RUNTIME_URL) return opts.runtimeResponse(headers)
    if (url.includes(MODEL_FILE_NAME)) {
      return opts.modelResponse === undefined
        ? streamResponse([opts.modelBytes], opts.modelBytes.length)
        : opts.modelResponse()
    }
    return new Response('unexpected', { status: 404 })
  })
}

function waitDone(installer: VectorInstaller, what: string): Promise<void> {
  return waitFor(() => installer.progress.phase === 'done' || installer.progress.phase === 'error', what)
}

test('parseContentRange：解析 bytes 区间、total=* 与各种坏格式', () => {
  assert.deepEqual(parseContentRange('bytes 100-199/2000'), { start: 100, end: 199, total: 2000 })
  assert.deepEqual(parseContentRange(' bytes 0-0/* '), { start: 0, end: 0, total: null })
  assert.equal(parseContentRange(null), null)
  assert.equal(parseContentRange(''), null)
  assert.equal(parseContentRange('items 1-2/3'), null, '单位必须是 bytes')
  assert.equal(parseContentRange('bytes 100-/2000'), null)
  assert.equal(parseContentRange('bytes 200-100/2000'), null, 'end < start 不合法')
  assert.equal(parseContentRange('bytes 0-9/5'), null, 'total 小于区间上界不合法')
  assert.equal(parseContentRange('bytes 0-9/abc'), null)
})

test('normalizeSha256：大小写不敏感、允许 sha256: 前缀', () => {
  const hex = 'a'.repeat(64)
  assert.equal(normalizeSha256(hex), hex)
  assert.equal(normalizeSha256(`  SHA256:${hex.toUpperCase()} `), hex)
})

test('probeVersionDefault：真跑一次 --version；跑不起来的可执行文件给出原因', async () => {
  // 拿 node 自己当「一定能跑起来的 exe」：默认实现必须真的 spawn 成功。
  const ok = await probeVersionDefault(process.execPath)
  assert.equal(ok.ok, true, ok.stderr ?? '')
  assert.equal(ok.status, 0)
  assert.match(ok.version ?? '', /v\d+/, `摘出的版本行：${String(ok.version)}`)

  const missing = await probeVersionDefault(join(tmpdir(), `dsh-probe-missing-${process.pid}`))
  assert.equal(missing.ok, false)
  assert.match(missing.stderr ?? '', /无法执行|ENOENT/i)
  assert.ok(DEFAULT_PROBE_TIMEOUT_MS >= 3000 && DEFAULT_PROBE_TIMEOUT_MS <= 5000, '超时取 3-5 秒')
})

test('断点续传：206 + Content-Range 起点匹配 → 追加写，装完无 .part/.meta 残留', async (t) => {
  if (!hostSupported()) {
    t.skip(`宿主平台 ${process.platform}-${process.arch} 不在支持列表，跳过`)
    return
  }
  const root = tempDir('dsh-install-resume-')
  try {
    const paths = installPaths(root)
    const runtime = buildRuntimeFixture()
    const split = Math.floor(runtime.bytes.length / 3)
    const archivePath = join(paths.dir, runtime.name)
    const part = seedPart(archivePath, runtime.bytes, split, RUNTIME_URL)
    const rest = runtime.bytes.subarray(split)
    const modelBytes = Buffer.alloc(32 * 1024, 4)
    const seen: Record<string, string> = {}
    const fetchImpl = flowFetch({
      runtimeName: runtime.name,
      runtimeResponse: (headers) => {
        seen['range'] = headers.range ?? ''
        seen['if-range'] = headers['if-range'] ?? ''
        // 服务端认可续传：只给剩下的字节 + 完整的 Content-Range
        return streamResponse([rest], rest.length, 206, {
          'content-range': `bytes ${split}-${runtime.bytes.length - 1}/${runtime.bytes.length}`,
        })
      },
      modelBytes,
      onRequest: (url, headers) => {
        if (url !== RUNTIME_URL) return
        seen['range'] = headers.range ?? ''
        seen['if-range'] = headers['if-range'] ?? ''
      },
    })
    const reports: InstallProgress[] = []
    const installer = new VectorInstaller({ platform: TEST_PLATFORM, arch: TEST_ARCH,
      root,
      fetchImpl,
      onProgress: (p) => reports.push(p),
      probeVersion: fakeProbe(),
    })
    installer.start()
    await waitDone(installer, '续传安装结束')

    assert.equal(installer.progress.phase, 'done', installer.progress.error ?? installer.progress.message)
    assert.equal(seen['range'], `bytes=${split}-`, '必须按已下载字节发 Range')
    assert.equal(seen['if-range'], '"etag-v1"', '带着 .meta 里的校验器发 If-Range')
    assert.deepEqual(readFileSync(archivePath), runtime.bytes, '追加写后压缩包逐字节等于原文件')
    assert.equal(existsSync(part), false, '.part 收尾清理')
    assert.equal(existsSync(`${part}.meta`), false, '.part.meta 收尾清理')
    // 进度要把续传的那一截算进去，否则面板百分比会从 0 再跳一次
    const runtimeReports = reports.filter((p) => p.phase === 'downloading-runtime' && p.totalBytes !== null)
    assert.equal(runtimeReports.at(-1)?.receivedBytes, runtime.bytes.length)
    assert.equal(runtimeReports.at(-1)?.totalBytes, runtime.bytes.length)
    assert.ok(reports.some((p) => p.phase === 'verifying'), '走完冒烟阶段')
    assert.equal(detectInstalled(root)?.model, paths.model)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('断点续传：服务端不支持 Range 回 200 → 从头覆盖，不会拼出重复内容', async (t) => {
  if (!hostSupported()) {
    t.skip(`宿主平台 ${process.platform}-${process.arch} 不在支持列表，跳过`)
    return
  }
  const root = tempDir('dsh-install-resume200-')
  try {
    const paths = installPaths(root)
    const runtime = buildRuntimeFixture()
    const split = Math.floor(runtime.bytes.length / 2)
    const archivePath = join(paths.dir, runtime.name)
    const part = seedPart(archivePath, runtime.bytes, split, RUNTIME_URL)
    let range: string | null = null
    const fetchImpl = flowFetch({
      runtimeName: runtime.name,
      runtimeResponse: () => streamResponse([runtime.bytes], runtime.bytes.length), // 200 = 忽略 Range
      modelBytes: Buffer.alloc(16 * 1024, 4),
      onRequest: (url, headers) => {
        if (url === RUNTIME_URL) range = headers.range ?? null
      },
    })
    const installer = new VectorInstaller({ platform: TEST_PLATFORM, arch: TEST_ARCH, root, fetchImpl, probeVersion: fakeProbe() })
    installer.start()
    await waitDone(installer, '安装结束')

    assert.equal(installer.progress.phase, 'done', installer.progress.error ?? installer.progress.message)
    assert.equal(range, `bytes=${split}-`, '仍然会尝试续传（服务端自己决定认不认）')
    assert.deepEqual(readFileSync(archivePath), runtime.bytes, '回 200 必须从头覆盖，不能把整份接在残片后面')
    assert.equal(existsSync(part), false)
    assert.equal(existsSync(`${part}.meta`), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('换源不续传：.part 来自另一个 URL 时从头下载（不同镜像可能是不同文件）', async (t) => {
  if (!hostSupported()) {
    t.skip(`宿主平台 ${process.platform}-${process.arch} 不在支持列表，跳过`)
    return
  }
  const root = tempDir('dsh-install-resume-src-')
  try {
    const paths = installPaths(root)
    const runtime = buildRuntimeFixture()
    const archivePath = join(paths.dir, runtime.name)
    // 残片来自别的镜像（内容其实一样，但按规矩不能拼）
    const part = seedPart(archivePath, runtime.bytes, 10, 'https://other.invalid/old-runtime')
    let range: string | null = 'unset'
    const fetchImpl = flowFetch({
      runtimeName: runtime.name,
      runtimeResponse: () => streamResponse([runtime.bytes], runtime.bytes.length),
      modelBytes: Buffer.alloc(8 * 1024, 4),
      onRequest: (url, headers) => {
        if (url === RUNTIME_URL) range = headers.range ?? null
      },
    })
    const installer = new VectorInstaller({ platform: TEST_PLATFORM, arch: TEST_ARCH, root, fetchImpl, probeVersion: fakeProbe() })
    installer.start()
    await waitDone(installer, '安装结束')

    assert.equal(installer.progress.phase, 'done', installer.progress.error ?? installer.progress.message)
    assert.equal(range, null, '换源时不能带 Range')
    assert.deepEqual(readFileSync(archivePath), runtime.bytes)
    assert.equal(existsSync(part), false)
    assert.equal(existsSync(`${part}.meta`), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('断点续传：Content-Range 起点对不上 → error 且删残片，不拼出坏文件', async (t) => {
  if (!hostSupported()) {
    t.skip(`宿主平台 ${process.platform}-${process.arch} 不在支持列表，跳过`)
    return
  }
  const root = tempDir('dsh-install-resume-offset-')
  try {
    const paths = installPaths(root)
    const runtime = buildRuntimeFixture()
    const split = Math.floor(runtime.bytes.length / 3)
    const archivePath = join(paths.dir, runtime.name)
    const part = seedPart(archivePath, runtime.bytes, split, RUNTIME_URL)
    const fetchImpl = flowFetch({
      runtimeName: runtime.name,
      // 起点故意错开一位（真发生过：CDN 忽略 Range 又硬编 206）
      runtimeResponse: () => streamResponse([runtime.bytes], runtime.bytes.length, 206, {
        'content-range': `bytes ${split - 1}-${runtime.bytes.length - 1}/${runtime.bytes.length}`,
      }),
      modelBytes: Buffer.alloc(1024, 4),
    })
    const installer = new VectorInstaller({ platform: TEST_PLATFORM, arch: TEST_ARCH, root, fetchImpl, probeVersion: fakeProbe() })
    installer.start()
    await waitDone(installer, '进入 error')

    assert.equal(installer.progress.phase, 'error')
    assert.match(installer.progress.message, /续传起点不一致/)
    assert.equal(existsSync(part), false, '起点对不上说明残片不可信，必须删掉')
    assert.equal(existsSync(`${part}.meta`), false)
    assert.equal(existsSync(archivePath), false, '没有把坏文件落到正式文件名上')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('断点续传：HTTP 416（残片比远端还长）→ 丢弃残片从头下，装完', async (t) => {
  if (!hostSupported()) {
    t.skip(`宿主平台 ${process.platform}-${process.arch} 不在支持列表，跳过`)
    return
  }
  const root = tempDir('dsh-install-resume416-')
  try {
    const paths = installPaths(root)
    const runtime = buildRuntimeFixture()
    const archivePath = join(paths.dir, runtime.name)
    // 残片比远端总长还大：典型的「远端换了更小的文件」
    const part = seedPart(archivePath, runtime.bytes, runtime.bytes.length + 100, RUNTIME_URL)
    writeFileSync(part, Buffer.concat([runtime.bytes, Buffer.alloc(100, 1)]))
    let attempts = 0
    const fetchImpl = flowFetch({
      runtimeName: runtime.name,
      runtimeResponse: () => {
        attempts++
        if (attempts === 1) return new Response(null, { status: 416, statusText: 'Range Not Satisfiable' })
        return streamResponse([runtime.bytes], runtime.bytes.length)
      },
      modelBytes: Buffer.alloc(4 * 1024, 4),
    })
    const reports: InstallProgress[] = []
    const installer = new VectorInstaller({ platform: TEST_PLATFORM, arch: TEST_ARCH,
      root,
      fetchImpl,
      onProgress: (p) => reports.push(p),
      probeVersion: fakeProbe(),
    })
    installer.start()
    await waitDone(installer, '安装结束')

    assert.equal(installer.progress.phase, 'done', installer.progress.error ?? installer.progress.message)
    assert.equal(attempts, 2, '416 之后不带 Range 重试一次')
    assert.ok(reports.some((p) => /续传被拒（HTTP 416）/.test(p.message)), '给出丢弃残片的提示')
    assert.deepEqual(readFileSync(archivePath), runtime.bytes)
    assert.equal(existsSync(part), false)
    assert.equal(existsSync(`${part}.meta`), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('完整性：落地字节与声明总长不符 → error 且删 .part/.meta，不留半成品', async (t) => {
  if (!hostSupported()) {
    t.skip(`宿主平台 ${process.platform}-${process.arch} 不在支持列表，跳过`)
    return
  }
  const root = tempDir('dsh-install-size-')
  try {
    const paths = installPaths(root)
    const runtime = buildRuntimeFixture()
    const modelBytes = Buffer.alloc(64 * 1024, 3)
    const declared = modelBytes.length + 1024 // 声明比实际多 1KB（模拟断流）
    const fetchImpl = flowFetch({
      runtimeName: runtime.name,
      runtimeResponse: () => streamResponse([runtime.bytes], runtime.bytes.length),
      modelBytes,
      modelResponse: () => streamResponse([modelBytes.subarray(0, modelBytes.length - 512)], declared),
    })
    const installer = new VectorInstaller({ platform: TEST_PLATFORM, arch: TEST_ARCH, root, fetchImpl, probeVersion: fakeProbe() })
    installer.start()
    await waitDone(installer, '进入 error')

    assert.equal(installer.progress.phase, 'error')
    assert.match(installer.progress.message, /不完整/)
    assert.match(installer.progress.message, new RegExp(`声明 ${declared} 字节，实际落地 ${modelBytes.length - 512} 字节`))
    assert.equal(existsSync(paths.model), false, '半成品不落到正式文件名')
    assert.equal(existsSync(`${paths.model}.part`), false, '.part 被删')
    assert.equal(existsSync(`${paths.model}.part.meta`), false, '.part.meta 被删')
    assert.equal(detectInstalled(root), null, '不会被误判成已安装')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('完整性：响应带 Content-Encoding 时不拿声明长度当校验基准（fetch 会解码）', async (t) => {
  if (!hostSupported()) {
    t.skip(`宿主平台 ${process.platform}-${process.arch} 不在支持列表，跳过`)
    return
  }
  const root = tempDir('dsh-install-encoded-')
  try {
    const paths = installPaths(root)
    const runtime = buildRuntimeFixture()
    const modelBytes = Buffer.alloc(16 * 1024, 7)
    const fetchImpl = flowFetch({
      runtimeName: runtime.name,
      runtimeResponse: () => streamResponse([runtime.bytes], runtime.bytes.length),
      modelBytes,
      // content-length 是**压缩后**的长度（多 500 字节），body 是 fetch 解码后的
      // 明文。照 content-length 校验落地字节就会把一次正常下载误报成「不完整」。
      modelResponse: () => streamResponse([modelBytes], modelBytes.length + 500, 200, { 'content-encoding': 'gzip' }),
    })
    const installer = new VectorInstaller({ platform: TEST_PLATFORM, arch: TEST_ARCH, root, fetchImpl, probeVersion: fakeProbe() })
    installer.start()
    await waitDone(installer, '安装结束')

    assert.equal(installer.progress.phase, 'done', installer.progress.error ?? installer.progress.message)
    assert.equal(statSync(paths.model).size, modelBytes.length, '内容按解码后的字节落地')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('完整性：配置了 sha256 就必须匹配 —— 不匹配 error 并删残片，匹配 → done', async (t) => {
  if (!hostSupported()) {
    t.skip(`宿主平台 ${process.platform}-${process.arch} 不在支持列表，跳过`)
    return
  }
  const ok = Buffer.alloc(32 * 1024, 8)
  const right = sha256Hex(ok)
  const roots: string[] = []
  try {
    // 1) 哈希不对：镜像被换/被篡改
    const badRoot = tempDir('dsh-install-sha-bad-')
    roots.push(badRoot)
    const runtime = buildRuntimeFixture()
    const badPaths = installPaths(badRoot)
    const bad = new VectorInstaller({ platform: TEST_PLATFORM, arch: TEST_ARCH,
      root: badRoot,
      fetchImpl: flowFetch({
        runtimeName: runtime.name,
        runtimeResponse: () => streamResponse([runtime.bytes], runtime.bytes.length),
        modelBytes: ok,
      }),
      model: { file: MODEL_FILE_NAME, bytes: ok.length, sha256: 'f'.repeat(64) },
      probeVersion: fakeProbe(),
    })
    bad.start()
    await waitDone(bad, '进入 error')
    assert.equal(bad.progress.phase, 'error')
    assert.match(bad.progress.message, /sha256 不匹配/)
    assert.match(bad.progress.message, /期望 f{64}/, 'message 里带期望值')
    assert.equal(existsSync(`${badPaths.model}.part`), false, '不匹配的残片必须删')
    assert.equal(existsSync(`${badPaths.model}.part.meta`), false)
    assert.equal(existsSync(badPaths.model), false)

    // 2) 哈希对上（允许 sha256: 前缀 + 大写）：正常装完
    const goodRoot = tempDir('dsh-install-sha-ok-')
    roots.push(goodRoot)
    const goodPaths = installPaths(goodRoot)
    const good = new VectorInstaller({ platform: TEST_PLATFORM, arch: TEST_ARCH,
      root: goodRoot,
      fetchImpl: flowFetch({
        runtimeName: runtime.name,
        runtimeResponse: () => streamResponse([runtime.bytes], runtime.bytes.length),
        modelBytes: ok,
      }),
      model: { file: MODEL_FILE_NAME, bytes: ok.length, sha256: `sha256:${right.toUpperCase()}` },
      probeVersion: fakeProbe(),
    })
    good.start()
    await waitDone(good, '安装结束')
    assert.equal(good.progress.phase, 'done', good.progress.error ?? good.progress.message)
    assert.deepEqual(readFileSync(goodPaths.model), ok, '校验通过后模型原样落地')
    assert.equal(existsSync(`${goodPaths.model}.part.meta`), false)
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  }
})

test('完整性：运行时资产按名字配 sha256 —— 主包匹配 → done', async (t) => {
  if (!hostSupported()) {
    t.skip(`宿主平台 ${process.platform}-${process.arch} 不在支持列表，跳过`)
    return
  }
  const root = tempDir('dsh-install-runtime-sha-')
  try {
    const paths = installPaths(root)
    const runtime = buildRuntimeFixture()
    const installer = new VectorInstaller({ platform: TEST_PLATFORM, arch: TEST_ARCH,
      root,
      fetchImpl: flowFetch({
        runtimeName: runtime.name,
        runtimeResponse: () => streamResponse([runtime.bytes], runtime.bytes.length),
        modelBytes: Buffer.alloc(8 * 1024, 2),
      }),
      runtimeSha256: { [runtime.name]: sha256Hex(runtime.bytes) },
      probeVersion: fakeProbe(),
    })
    installer.start()
    await waitDone(installer, '安装结束')
    assert.equal(installer.progress.phase, 'done', installer.progress.error ?? installer.progress.message)
    assert.ok(existsSync(paths.exe))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('完整性：运行时 sha256 不符 → error，且不会去解压/下模型', async (t) => {
  if (!hostSupported()) {
    t.skip(`宿主平台 ${process.platform}-${process.arch} 不在支持列表，跳过`)
    return
  }
  const root = tempDir('dsh-install-runtime-sha-bad-')
  try {
    const paths = installPaths(root)
    const runtime = buildRuntimeFixture()
    let modelRequested = false
    const fetchImpl = flowFetch({
      runtimeName: runtime.name,
      runtimeResponse: () => streamResponse([runtime.bytes], runtime.bytes.length),
      modelBytes: Buffer.alloc(1024, 2),
      onRequest: (url) => {
        if (url.includes(MODEL_FILE_NAME)) modelRequested = true
      },
    })
    const installer = new VectorInstaller({ platform: TEST_PLATFORM, arch: TEST_ARCH,
      root,
      fetchImpl,
      runtimeSha256: '0'.repeat(64),
      probeVersion: fakeProbe(),
    })
    installer.start()
    await waitDone(installer, '进入 error')

    assert.equal(installer.progress.phase, 'error')
    assert.match(installer.progress.message, /sha256 不匹配/)
    assert.match(installer.progress.message, /llama\.cpp 运行时校验失败/, 'message 要写明是哪一件下载物')
    assert.equal(existsSync(join(paths.dir, runtime.name)), false, '校验失败的压缩包不落到正式文件名')
    assert.equal(existsSync(join(paths.dir, `${runtime.name}.part`)), false)
    assert.equal(modelRequested, false, '运行时都没过校验，不该继续下模型')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('安装后冒烟：成功后 done，并把版本行写进日志', async (t) => {
  if (!hostSupported()) {
    t.skip(`宿主平台 ${process.platform}-${process.arch} 不在支持列表，跳过`)
    return
  }
  const root = tempDir('dsh-install-smoke-ok-')
  try {
    const paths = installPaths(root)
    const runtime = buildRuntimeFixture()
    const probed: string[] = []
    const reports: InstallProgress[] = []
    const installer = new VectorInstaller({ platform: TEST_PLATFORM, arch: TEST_ARCH,
      root,
      fetchImpl: flowFetch({
        runtimeName: runtime.name,
        runtimeResponse: () => streamResponse([runtime.bytes], runtime.bytes.length),
        modelBytes: Buffer.alloc(8 * 1024, 6),
      }),
      onProgress: (p) => reports.push(p),
      probeVersion: (exe) => {
        probed.push(exe)
        return { ok: true, status: 0, version: 'version: 9999 (abcdef0)', via: '测试注入' }
      },
    })
    installer.start()
    await waitDone(installer, '安装结束')

    assert.equal(installer.progress.phase, 'done', installer.progress.error ?? installer.progress.message)
    assert.deepEqual(probed, [paths.exe], '冒烟探测的就是装好的 llama-server')
    assert.ok(reports.some((p) => p.phase === 'verifying'), '上报 verifying 阶段')
    assert.ok(reports.some((p) => /冒烟测试通过：version: 9999/.test(p.message)), '完成日志里带版本')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('安装后冒烟：失败 → error 带 stderr 尾部，并摘掉 exe 免得被当成已安装', async (t) => {
  if (!hostSupported()) {
    t.skip(`宿主平台 ${process.platform}-${process.arch} 不在支持列表，跳过`)
    return
  }
  const root = tempDir('dsh-install-smoke-bad-')
  try {
    const paths = installPaths(root)
    const runtime = buildRuntimeFixture()
    const stderr = [
      'llama-server: error while loading shared libraries: libllama-common.so.0: cannot open shared object file: No such file or directory',
      'second line that should be kept in the tail',
    ].join('\n')
    const installer = new VectorInstaller({ platform: TEST_PLATFORM, arch: TEST_ARCH,
      root,
      fetchImpl: flowFetch({
        runtimeName: runtime.name,
        runtimeResponse: () => streamResponse([runtime.bytes], runtime.bytes.length),
        modelBytes: Buffer.alloc(8 * 1024, 6),
      }),
      probeVersion: (): VersionProbeResult => ({ ok: false, status: 127, stderr, via: '测试注入' }),
    })
    installer.start()
    await waitDone(installer, '进入 error')

    assert.equal(installer.progress.phase, 'error', '冒烟失败绝不能报 done')
    assert.equal(installer.progress.error, installer.progress.message)
    assert.match(installer.progress.message, /冒烟测试失败/)
    assert.match(installer.progress.message, /退出码 127/)
    assert.match(installer.progress.message, /stderr 尾部/)
    assert.match(installer.progress.message, /libllama-common\.so\.0/, 'stderr 尾部要原样带出来')
    assert.match(installer.progress.message, /已移除 llama-server/, '说明为什么会摘掉可执行文件')
    assert.equal(existsSync(paths.exe), false, 'exe 被摘掉：否则下次 start() 会直接报「已就绪」')
    assert.equal(detectInstalled(root), null, 'detectInstalled 不再认为装好了（重试会重新解压+冒烟）')
    assert.equal(existsSync(paths.model), true, '模型没被牵连删除（几百 MB 别白下）')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('安装后冒烟：probeVersion 返回 null = 跳过探测，仍然 done', async (t) => {
  if (!hostSupported()) {
    t.skip(`宿主平台 ${process.platform}-${process.arch} 不在支持列表，跳过`)
    return
  }
  const root = tempDir('dsh-install-smoke-skip-')
  try {
    const runtime = buildRuntimeFixture()
    const reports: InstallProgress[] = []
    const installer = new VectorInstaller({ platform: TEST_PLATFORM, arch: TEST_ARCH,
      root,
      fetchImpl: flowFetch({
        runtimeName: runtime.name,
        runtimeResponse: () => streamResponse([runtime.bytes], runtime.bytes.length),
        modelBytes: Buffer.alloc(4 * 1024, 6),
      }),
      onProgress: (p) => reports.push(p),
      probeVersion: () => null,
    })
    installer.start()
    await waitDone(installer, '安装结束')
    assert.equal(installer.progress.phase, 'done', installer.progress.error ?? installer.progress.message)
    assert.ok(reports.some((p) => /冒烟测试：已跳过/.test(p.message)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cancel：在途下载被中止时 .part 与 .part.meta 一起清掉', async (t) => {
  if (!hostSupported()) {
    t.skip(`宿主平台 ${process.platform}-${process.arch} 不在支持列表，跳过`)
    return
  }
  const root = tempDir('dsh-install-cancel-meta-')
  try {
    const paths = installPaths(root)
    const runtime = buildRuntimeFixture()
    const fetchImpl = fakeFetch((url, init) => {
      if (url.includes('api.github.com')) {
        return jsonResponse([{ assets: [{ name: runtime.name, browser_download_url: RUNTIME_URL }] }])
      }
      return stallResponse(init?.signal, Buffer.alloc(16 * 1024, 9), 8 * 1024 * 1024)
    })
    const reports: InstallProgress[] = []
    const installer = new VectorInstaller({ platform: TEST_PLATFORM, arch: TEST_ARCH,
      root,
      fetchImpl,
      onProgress: (p) => reports.push(p),
      probeVersion: fakeProbe(),
    })
    installer.start()
    const part = `${join(paths.dir, runtime.name)}.part`
    await waitFor(() => existsSync(`${part}.meta`), '.part.meta 被创建')
    await waitFor(() => reports.some((p) => p.phase === 'downloading-runtime' && p.receivedBytes > 0), '收到第一块')

    installer.cancel()
    assert.equal(installer.progress.phase, 'idle')
    assert.equal(existsSync(part), false, '.part 被清理')
    assert.equal(existsSync(`${part}.meta`), false, '.part.meta 也一起清理（不留孤儿文件）')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ─────────────── 系统运行时（Termux pkg install llama-cpp 等） ───────────────

test('detectInstalled：模型 + 系统 llama-server → 视为可用，并标 system', () => {
  const root = tempDir('dsh-install-sys-')
  try {
    const paths = installPaths(root)
    mkdirSync(dirname(paths.model), { recursive: true })
    writeFileSync(paths.model, 'gguf')
    const sysExe = join(root, 'sys-bin', 'llama-server')
    mkdirSync(dirname(sysExe), { recursive: true })
    writeFileSync(sysExe, 'bin')

    const detected = detectInstalled(root, MODEL_FILE_NAME, { systemExe: sysExe })
    assert.ok(detected !== null, '只有模型 + 系统运行时也算可用')
    assert.equal(detected.system, true)
    assert.equal(detected.exe, sysExe)
    assert.equal(detected.model, paths.model)

    // 托管运行时存在时默认优先托管；显式 preferSystem 才改用系统运行时。
    mkdirSync(dirname(paths.exe), { recursive: true })
    writeFileSync(paths.exe, 'bin')
    assert.equal(detectInstalled(root, MODEL_FILE_NAME, { systemExe: sysExe })?.system, undefined)
    assert.equal(detectInstalled(root, MODEL_FILE_NAME, { systemExe: sysExe, preferSystem: true })?.exe, sysExe)

    // 没有模型时，系统运行时也救不了。
    rmSync(paths.model, { force: true })
    assert.equal(detectInstalled(root, MODEL_FILE_NAME, { systemExe: sysExe }), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('系统运行时安装：只下模型，完全不碰 GitHub 发行版与托管运行时', async () => {
  const root = tempDir('dsh-install-sysrun-')
  try {
    const sysExe = join(root, 'sys', 'llama-server')
    mkdirSync(dirname(sysExe), { recursive: true })
    writeFileSync(sysExe, 'bin')
    let releaseCalls = 0
    const fetchImpl = fakeFetch((url) => {
      if (/api\.github\.com/u.test(url)) {
        releaseCalls += 1
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(Buffer.from('GGUFfake'), { status: 200, headers: { 'content-length': '8' } })
    })
    const installer = new VectorInstaller({ platform: TEST_PLATFORM, arch: TEST_ARCH,
      root,
      fetchImpl,
      systemExe: sysExe,
      model: { file: 'custom-test.gguf', sources: ['https://example.test/custom-test.gguf'] },
      probeVersion: () => ({ ok: true, status: 0, version: '0.9.0 android', via: '直接执行' }),
    })
    installer.start()
    await waitFor(() => installer.progress.phase === 'done', '安装完成')
    assert.equal(releaseCalls, 0, '系统运行时不查 GitHub 发行版')
    assert.equal(existsSync(installPaths(root, 'custom-test.gguf').exe), false, '不下载托管运行时')
    assert.equal(existsSync(installPaths(root, 'custom-test.gguf').model), true, '模型已落地')
    assert.equal(installer.progress.paths?.system, true)
    assert.equal(installer.progress.paths?.exe, sysExe)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('解压炸弹防护：中央目录声明尺寸远小于实际解压量 → 明确报错而不是吃满内存', () => {
  const dir = tempDir('dsh-zip-bomb-')
  try {
    const big = Buffer.alloc(2 * 1024 * 1024, 7) // 2MB 可压缩数据
    const zip = buildZip([{ name: 'llama-server', data: big, method: 8 }])
    // 把中央目录里的 uncompressedSize 改成 1KB（损坏/恶意归档的典型形状）。
    const cd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    assert.ok(cd > 0, '中央目录签名应存在')
    zip.writeUInt32LE(1024, cd + 24)
    assert.throws(() => extractArchive(zip, dir), /解压条目失败|解压/, '超过声明尺寸必须失败而不是静默解压')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
