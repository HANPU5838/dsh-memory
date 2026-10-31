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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync, gzipSync, inflateRawSync } from 'node:zlib'
import {
  MODEL_FILE_NAME,
  VectorInstaller,
  detectInstalled,
  extractArchive,
  installPaths,
  pickRuntimeAsset,
  runtimeAssetPattern,
  runtimeDownloadSources,
  type InstallProgress,
} from '../src/embed-install.ts'

// ───────────────────────────── 小工具 ─────────────────────────────

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
    runtimeAssetPattern(process.platform, process.arch)
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

/** 假 Response：分块给完就关流。 */
function streamResponse(chunks: readonly Uint8Array[], totalBytes: number | null, status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  const headers: Record<string, string> = {}
  if (totalBytes !== null) headers['content-length'] = String(totalBytes)
  return new Response(stream, { status, headers })
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
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  if (process.platform === 'win32') {
    return {
      name: `llama-b19999-bin-win-cpu-${arch}.zip`,
      bytes: buildZip([
        { name: 'llama-server.exe', data: Buffer.from('llama-server-shim') },
        { name: 'llama-common.dll', data: Buffer.alloc(4096, 3), method: 8 },
        { name: 'llama-server-impl.dll', data: Buffer.alloc(8192, 4), method: 8 },
      ]),
    }
  }
  const dirName = process.platform === 'darwin' ? 'macos' : 'ubuntu'
  return {
    name: `llama-b19999-bin-${dirName}-${arch}.tar.gz`,
    bytes: gzipSync(buildTar([
      { name: 'llama-b19999/', type: '5' },
      { name: 'llama-b19999/llama-server', data: Buffer.from('llama-server-bin'), mode: 0o755 },
      { name: 'llama-b19999/llama-server-impl.so', data: Buffer.alloc(8192, 4), mode: 0o755 },
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
  if (process.platform !== 'win32' && process.platform !== 'linux') return null
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const cuda = arch === 'arm64' ? '13.4' : process.platform === 'linux' ? '12.8' : '12.4'
  const suffix = process.platform === 'win32' ? 'win' : 'ubuntu'
  const ext = process.platform === 'win32' ? 'zip' : 'tar.gz'
  const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
  const mainName = `llama-b19999-bin-${suffix}-cuda-${cuda}-${arch}.${ext}`
  const companionName = process.platform === 'win32'
    ? `cudart-llama-bin-win-cuda-${cuda}-${arch}.zip`
    : `cudart-llama-b19999-bin-ubuntu-cuda-${cuda}-${arch}.tar.gz`
  // 干扰项必须与要选的伴生包 cuda 次版本不同，否则它自己就会成为第一个命中。
  const decoyCuda = cuda === '12.4' ? '13.4' : '12.4'

  const mainBytes = process.platform === 'win32'
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
    assert.equal(extractArchive(tar, dest), 2, '只写普通文件，目录项与符号链接都跳过')
    assert.equal(readFileSync(join(dest, 'llama-server'), 'utf8'), 'binary')
    assert.equal(readFileSync(join(dest, 'docs', 'README.md'), 'utf8'), '# readme')
    assert.equal(existsSync(join(dest, 'llama-b12345')), false, '顶层目录被剥掉')
    if (process.platform !== 'win32') {
      assert.equal(statSync(join(dest, 'llama-server')).mode & 0o111, 0o111, '执行位保留')
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
    const installer = new VectorInstaller({ root, fetchImpl, onProgress: (p) => reports.push(p) })

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
    const installer = new VectorInstaller({ root, fetchImpl, flavor: 'cuda' })

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
    const installer = new VectorInstaller({ root, fetchImpl, onProgress: (p) => reports.push(p) })
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
    const installer = new VectorInstaller({ root, fetchImpl })
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
    const installer = new VectorInstaller({ root, fetchImpl, onProgress: (p) => reports.push(p) })
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
    const installer = new VectorInstaller({ root, fetchImpl, onProgress: (p) => reports.push(p) })

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
  const installer = new VectorInstaller({ root: 'D:/nonexistent-root-should-not-be-touched' })
  installer.cancel()
  assert.equal(installer.progress.phase, 'idle')
  assert.equal(existsSync('D:/nonexistent-root-should-not-be-touched'), false)
})

// ─────────────────────────── 错误分支 ───────────────────────────

test('GitHub API 限流：phase=error 且 message 可读', async () => {
  const root = tempDir('dsh-install-403-')
  try {
    const fetchImpl = fakeFetch(() => new Response('rate limited', { status: 403 }))
    const installer = new VectorInstaller({ root, fetchImpl })
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
    const installer = new VectorInstaller({ root, fetchImpl, platform: 'win32', arch: 'x64' })
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
    const installer = new VectorInstaller({ root, fetchImpl })
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
    const installer = new VectorInstaller({ root, fetchImpl, modelSources: sources, onProgress: (p) => reports.push(p) })
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
    const installer = new VectorInstaller({
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
    const installer = new VectorInstaller({ root, fetchImpl })
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
