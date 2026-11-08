/**
 * Embedding-backend lifecycle (llama-server as a child of the app process).
 *
 * Contract under test:
 *  - opt-in: disabled by default, so dev/test runs never spawn a real server
 *  - endpoint already healthy + our PID file → adopt and own it (kill on exit)
 *  - endpoint already healthy without a PID file → external, never killed
 *  - stop() kills only what we own, and always clears the PID file
 *  - Android/Termux: missing ELF interpreter → launch through Termux's glibc
 *    loader; no loader → readable error instead of a bare ENOENT
 *  - port busy before spawn → fail fast with PORT_IN_USE (no child started)
 *  - unexpected child exit → self-heal 1s/5s/30s, max 3, never after stop()
 *  - Linux: a pid is only trusted/killed when /proc/<pid>/cmdline is
 *    llama-server (PID reuse protection); other platforms keep old behaviour
 *
 * System calls (spawn/probe/kill/sleep/exists/ELF read/net connect//proc read)
 * are injected, so the lifecycle is testable without a server or real /proc.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EmbedServerManager, readElfInterpFromFile, type EmbedServerDeps } from '../src/embed-server.ts'

interface FakeChild {
  pid: number
  exitCode: number | null
  once(event: string, cb: (...args: unknown[]) => void): void
  emit(event: string, ...args: unknown[]): void
}

interface SpawnRecord {
  exe: string
  args: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
}

interface MakeDepsOptions {
  healthy: boolean
  spawnPid?: number
  portInUse?: boolean
  platform?: NodeJS.Platform
  prefix?: string
  readElfInterp?: (exe: string) => string | null
  fileExists?: (path: string) => boolean
  readProcCmdline?: (pid: number) => string | null
  sleep?: (ms: number) => Promise<void>
  /** 覆盖健康探测(动态用例:启动中不健康,过一会儿健康)。 */
  probe?: () => Promise<boolean>
}

function makeDeps(opts: MakeDepsOptions) {
  const calls = {
    spawn: [] as SpawnRecord[],
    killed: [] as number[],
    killedSignals: [] as Array<'SIGTERM' | 'SIGKILL' | undefined>,
    logs: [] as string[],
    slept: [] as number[],
    portChecks: [] as Array<{ host: string; port: number }>,
  }
  const children: FakeChild[] = []
  const deps: Partial<EmbedServerDeps> = {
    spawn: ((exe: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
      calls.spawn.push({ exe, args, cwd: options?.cwd, env: options?.env })
      const handlers = new Map<string, Array<(...a: unknown[]) => void>>()
      const child: FakeChild = {
        pid: opts.spawnPid ?? 4242,
        exitCode: null,
        once(event, cb) {
          const list = handlers.get(event) ?? []
          list.push(cb)
          handlers.set(event, list)
        },
        emit(event, ...rest) {
          for (const cb of handlers.get(event) ?? []) cb(...rest)
        },
      }
      children.push(child)
      return child
    }) as unknown as EmbedServerDeps['spawn'],
    probe: opts.probe ?? (async () => opts.healthy),
    kill: (pid: number, signal?: 'SIGTERM' | 'SIGKILL') => { calls.killed.push(pid); calls.killedSignals.push(signal) },
    log: (message: string) => { calls.logs.push(message) },
    sleep: opts.sleep ?? (async (ms: number) => { calls.slept.push(ms) }),
    portInUse: async (host: string, port: number) => {
      calls.portChecks.push({ host, port })
      return opts.portInUse === true
    },
    // 默认当作「是本机的 llama-server」:既有用例(adopt/kill)依赖这个前提。
    readProcCmdline: opts.readProcCmdline ?? (() => 'llama-server --host 127.0.0.1'),
    readElfInterp: opts.readElfInterp ?? (() => null),
    fileExists: opts.fileExists ?? (() => false),
    platform: opts.platform ?? 'linux',
    prefix: opts.prefix ?? '/data/data/com.termux/files/usr',
  }
  return { deps, calls, children }
}

/** 让排队中的 async 自愈循环跑完(注入的 sleep 都是立刻 resolve 的微任务)。 */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
}

const EXE = 'D:/stack/llamacpp/llama-server.exe'
const MODEL = 'D:/stack/models/bge-m3.gguf'
const TERMUX_PREFIX = '/data/data/com.termux/files/usr'
const TERMUX_LOADER = join(TERMUX_PREFIX, 'glibc', 'lib', 'ld-linux-aarch64.so.1')
const TERMUX_LIB = join(TERMUX_PREFIX, 'glibc', 'lib')

test('disabled by default: no spawn, no probe side effects', async () => {
  const { deps, calls } = makeDeps({ healthy: false })
  const mgr = new EmbedServerManager({ exe: EXE, model: MODEL }, deps)
  assert.equal(await mgr.ensureRunning(), 'disabled')
  assert.equal(calls.spawn.length, 0)
  assert.equal(mgr.isOwned, false)
})

test('spawns the server with the embedding flags, writes a PID file, and stops it on exit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-embed-server-'))
  const logFile = join(dir, 'llama-server.log')
  try {
    const { deps, calls, children } = makeDeps({ healthy: false, spawnPid: 5150 })
    const mgr = new EmbedServerManager({
      enabled: true, exe: EXE, model: MODEL, cwd: dir, logFile, threads: 4,
    }, deps)

    assert.equal(await mgr.ensureRunning(), 'spawned')
    assert.equal(calls.spawn.length, 1)
    const [spawned] = calls.spawn
    assert.equal(spawned!.exe, EXE)
    assert.equal(spawned!.cwd, dir)
    const args = spawned!.args
    assert.deepEqual(args.slice(0, 2), ['-m', MODEL])
    for (const flag of ['--embeddings', '--pooling', 'cls', '--host', '--port', '-t']) {
      assert.ok(args.includes(flag), `missing ${flag} in ${args.join(' ')}`)
    }
    assert.equal(args[args.indexOf('--pooling') + 1], 'cls')
    assert.equal(args[args.indexOf('-t') + 1], '4')
    assert.equal(args[args.indexOf('--port') + 1], '8078')

    // P0：默认必须带 -b/-ub（512 会拒绝 >512 token 的记录，嵌入静默失败）
    assert.equal(args[args.indexOf('-b') + 1], '2048')
    assert.equal(args[args.indexOf('-ub') + 1], '2048')

    // PID file lets a later run recognise the leftover instance as ours
    const pidFile = `${logFile}.pid`
    assert.ok(existsSync(pidFile), 'pid file written')
    assert.equal(readFileSync(pidFile, 'utf8').trim(), '5150')

    mgr.stop()
    assert.deepEqual(calls.killed, [5150], 'owned child is killed')
    assert.equal(existsSync(pidFile), false, 'pid file cleared on stop')
    assert.equal(children.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('子进程秒退：主日志带出日志文件末尾的真实死因', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-embed-crash-'))
  const logFile = join(dir, 'llama-server.log')
  try {
    const { deps, calls, children } = makeDeps({ healthy: false })
    const mgr = new EmbedServerManager({ enabled: true, exe: EXE, model: MODEL, cwd: dir, logFile }, deps)

    assert.equal(await mgr.ensureRunning(), 'spawned')
    // 模拟 llama-server 因缺 .so 秒退：死因只写在子进程日志里
    writeFileSync(
      logFile,
      'llama-server: error while loading shared libraries: libllama-common.so.0: cannot open shared object file\n',
      'utf8',
    )
    children[0]!.exitCode = 1
    children[0]!.emit('exit', 1, null)

    const text = calls.logs.join('\n')
    assert.match(text, /进程已退出\(code=1 signal=none/, '退出信息带退出码')
    assert.match(text, /启动失败详情/, '主日志解释了死因')
    assert.match(text, /libllama-common\.so\.0/, '死因来自子进程日志末尾')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('adopts a leftover instance recorded in the PID file and owns it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-embed-adopt-'))
  const logFile = join(dir, 'llama-server.log')
  try {
    // the current process is guaranteed alive; the injected kill only records
    // the call, so nothing real is ever signalled
    writeFileSync(`${logFile}.pid`, String(process.pid), 'utf8')
    const { deps, calls } = makeDeps({ healthy: true })
    const mgr = new EmbedServerManager({ enabled: true, exe: EXE, model: MODEL, logFile }, deps)

    assert.equal(await mgr.ensureRunning(), 'adopted-managed')
    assert.equal(mgr.isOwned, true)
    assert.equal(calls.spawn.length, 0, 'no duplicate server started')

    mgr.stop()
    assert.deepEqual(calls.killed, [process.pid], 'adopted instance is stopped with the app')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('leaves a genuinely external instance alone (no PID file)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-embed-external-'))
  try {
    const { deps, calls } = makeDeps({ healthy: true })
    const mgr = new EmbedServerManager({
      enabled: true, exe: EXE, model: MODEL, logFile: join(dir, 'llama-server.log'),
    }, deps)

    assert.equal(await mgr.ensureRunning(), 'external')
    assert.equal(mgr.isOwned, false)
    mgr.stop()
    assert.deepEqual(calls.killed, [], 'external server must survive app exit')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('missing exe/model fails soft instead of throwing', async () => {
  const { deps } = makeDeps({ healthy: false })
  const mgr = new EmbedServerManager({ enabled: true }, deps)
  assert.equal(await mgr.ensureRunning(), 'failed')
})

test('a manual stop can be followed by a manual start (panel buttons)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-embed-restart-'))
  const logFile = join(dir, 'llama-server.log')
  try {
    const { deps, calls } = makeDeps({ healthy: false, spawnPid: 777 })
    const mgr = new EmbedServerManager({ enabled: true, exe: EXE, model: MODEL, logFile }, deps)

    assert.equal(await mgr.ensureRunning(), 'spawned')
    assert.equal(mgr.stop(), true, 'stop reports that it killed the child')
    assert.equal(mgr.isOwned, false)
    assert.equal(mgr.stop(), false, 'a second stop is a no-op')

    // the stopping flag must not latch, otherwise the start button is dead
    assert.equal(await mgr.ensureRunning(), 'spawned')
    assert.equal(mgr.isOwned, true)
    assert.equal(calls.spawn.length, 2, 'restart spawns a new child')
    assert.equal(mgr.stop(), true)
    assert.deepEqual(calls.killed, [777, 777])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('用户 extraArgs 里自己给了 --batch-size 时不重复传 -b/-ub', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-embed-batch-'))
  try {
    const { deps, calls } = makeDeps({ healthy: false })
    const mgr = new EmbedServerManager({
      enabled: true, exe: EXE, model: MODEL, cwd: dir, logFile: join(dir, 'log'),
      extraArgs: ['--batch-size', '4096'],
    }, deps)
    await mgr.ensureRunning()
    const args = calls.spawn[0]!.args
    assert.equal(args.filter((a) => a === '--batch-size' || a === '-b').length, 1, 'batch 参数只出现一次')
    assert.equal(args.includes('-ub'), true, 'ubatch 仍取默认')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('spawn error（ENOENT/EACCES）：ready 轮询立刻失败并报出真实原因，不空转超时', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-embed-error-'))
  try {
    const { deps, calls, children } = makeDeps({ healthy: false })
    // 关掉快速路径：确保是 lastError 让它提前返回，而不是 sleep 恰好结束
    const mgr = new EmbedServerManager({ enabled: true, exe: EXE, model: MODEL, cwd: dir, logFile: join(dir, 'log') }, deps)
    assert.equal(await mgr.ensureRunning(), 'spawned')
    children[0]!.emit('error', new Error('spawn llama-server EACCES'))
    const started = Date.now()
    const ok = await mgr.waitUntilReady(60_000)
    assert.equal(ok, false)
    assert.ok(Date.now() - started < 5_000, '不应等到 60s 超时')
    assert.match(calls.logs.join('\n'), /启动失败：spawn llama-server EACCES/)
    assert.equal(mgr.lastError, 'spawn llama-server EACCES')
    assert.equal(mgr.unavailable, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── 1. Android/Termux glibc 自动包装 ───────────────────────────

test('glibc auto：ELF 解释器在本机不存在时改用 Termux glibc loader 启动', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-embed-glibc-'))
  try {
    const { deps, calls } = makeDeps({
      healthy: false,
      readElfInterp: () => '/lib/ld-linux-aarch64.so.1',
      fileExists: (path) => path === TERMUX_LOADER,
    })
    const mgr = new EmbedServerManager({ enabled: true, exe: EXE, model: MODEL, cwd: dir, logFile: join(dir, 'log') }, deps)

    assert.equal(await mgr.ensureRunning(), 'spawned')
    assert.equal(calls.spawn.length, 1)
    const launched = calls.spawn[0]!
    assert.equal(launched.exe, TERMUX_LOADER, '用 glibc loader 作为 spawn 目标')
    assert.deepEqual(launched.args.slice(0, 3), ['--library-path', TERMUX_LIB, EXE])
    assert.deepEqual(launched.args.slice(3, 5), ['-m', MODEL], '原始参数原样跟在 exe 后面')
    assert.ok(launched.args.includes('--embeddings'))
    assert.equal(launched.args[launched.args.indexOf('-b') + 1], '2048')
    assert.equal(mgr.launch?.wrapped, true)
    assert.match(calls.logs.join('\n'), /glibc 包装/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('glibc auto：找不到 loader 时给出可读错误，而不是裸 ENOENT（且不 spawn）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-embed-glibc-miss-'))
  try {
    const { deps, calls } = makeDeps({
      healthy: false,
      readElfInterp: () => '/lib/ld-linux-aarch64.so.1',
      fileExists: () => false,
    })
    const mgr = new EmbedServerManager({ enabled: true, exe: EXE, model: MODEL, cwd: dir, logFile: join(dir, 'log') }, deps)

    assert.equal(await mgr.ensureRunning(), 'failed')
    assert.equal(calls.spawn.length, 0, 'loader 缺失时不 spawn（spawn 只会 ENOENT）')
    const text = calls.logs.join('\n')
    assert.match(text, /glibc loader 缺失/)
    assert.match(text, /\/lib\/ld-linux-aarch64\.so\.1/, '错误里带上真实解释器路径')
    assert.match(text, /glibc/, '错误里告诉用户装 glibc')
    assert.match(text, /glibcWrap/, '错误里给出关闭开关')
    assert.match(mgr.lastError ?? '', /glibc loader 缺失/)
    assert.equal(mgr.unavailable, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('glibc auto：解释器存在（普通 Linux）时直接启动，不包装', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-embed-glibc-direct-'))
  try {
    const { deps, calls } = makeDeps({
      healthy: false,
      readElfInterp: () => '/lib/ld-linux-aarch64.so.1',
      fileExists: (path) => path === '/lib/ld-linux-aarch64.so.1',
    })
    const mgr = new EmbedServerManager({ enabled: true, exe: EXE, model: MODEL, cwd: dir, logFile: join(dir, 'log') }, deps)

    assert.equal(await mgr.ensureRunning(), 'spawned')
    assert.equal(calls.spawn[0]!.exe, EXE)
    assert.deepEqual(calls.spawn[0]!.args.slice(0, 2), ['-m', MODEL])
    assert.equal(mgr.launch?.wrapped, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("glibcWrap='off'：即使解释器缺失也直接启动（用户明确关掉包装）", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-embed-glibc-off-'))
  try {
    const { deps, calls } = makeDeps({
      healthy: false,
      readElfInterp: () => '/lib/ld-linux-aarch64.so.1',
      fileExists: () => false,
    })
    const mgr = new EmbedServerManager({ enabled: true, exe: EXE, model: MODEL, cwd: dir, logFile: join(dir, 'log'), glibcWrap: 'off' }, deps)

    assert.equal(await mgr.ensureRunning(), 'spawned')
    assert.equal(calls.spawn[0]!.exe, EXE)
    assert.equal(mgr.launch?.wrapped, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("glibcWrap='on'：解释器存在也强制走 Termux glibc loader", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-embed-glibc-on-'))
  try {
    const { deps, calls } = makeDeps({
      healthy: false,
      readElfInterp: () => '/lib/ld-linux-aarch64.so.1',
      fileExists: (path) => path === '/lib/ld-linux-aarch64.so.1' || path === TERMUX_LOADER,
    })
    const mgr = new EmbedServerManager({ enabled: true, exe: EXE, model: MODEL, cwd: dir, logFile: join(dir, 'log'), glibcWrap: 'on' }, deps)

    assert.equal(await mgr.ensureRunning(), 'spawned')
    assert.equal(calls.spawn[0]!.exe, TERMUX_LOADER)
    assert.equal(mgr.launch?.wrapped, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('非 Linux：不做 glibc 包装（保持旧行为）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-embed-glibc-win-'))
  try {
    const { deps, calls } = makeDeps({
      healthy: false,
      platform: 'win32',
      readElfInterp: () => '/lib/ld-linux-aarch64.so.1',
      fileExists: () => false,
    })
    const mgr = new EmbedServerManager({ enabled: true, exe: EXE, model: MODEL, cwd: dir, logFile: join(dir, 'log') }, deps)

    assert.equal(await mgr.ensureRunning(), 'spawned')
    assert.equal(calls.spawn[0]!.exe, EXE)
    assert.equal(mgr.launch?.wrapped, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ELF 解析：从 PT_INTERP 读出解释器；非 ELF / 文件不存在返回 null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-embed-elf-'))
  try {
    // 造一个最小 ELF64:a 64 字节头 + 1 个 PT_INTERP program header + 解释器字符串。
    const interp = '/lib/ld-linux-aarch64.so.1'
    const interpBuf = Buffer.from(`${interp}\0`, 'utf8')
    const phoff = 64
    const phentsize = 56
    const interpOff = phoff + phentsize
    const elf = Buffer.alloc(interpOff + interpBuf.length)
    elf[0] = 0x7f; elf[1] = 0x45; elf[2] = 0x4c; elf[3] = 0x46 // \x7fELF
    elf[4] = 2; elf[5] = 1; elf[6] = 1 // 64 位 / 小端 / 当前版本
    elf.writeUInt16LE(2, 16) // e_type = ET_EXEC
    elf.writeUInt16LE(0xb7, 18) // e_machine = aarch64
    elf.writeBigUInt64LE(0n, 24) // e_entry
    elf.writeBigUInt64LE(BigInt(phoff), 32) // e_phoff
    elf.writeUInt16LE(64, 52) // e_ehsize
    elf.writeUInt16LE(phentsize, 54) // e_phentsize
    elf.writeUInt16LE(1, 56) // e_phnum
    elf.writeUInt32LE(3, phoff) // p_type = PT_INTERP
    elf.writeBigUInt64LE(BigInt(interpOff), phoff + 8) // p_offset
    elf.writeBigUInt64LE(BigInt(interpBuf.length), phoff + 32) // p_filesz
    elf.writeBigUInt64LE(BigInt(interpBuf.length), phoff + 40) // p_memsz
    interpBuf.copy(elf, interpOff)
    const elfPath = join(dir, 'llama-server')
    writeFileSync(elfPath, elf)
    assert.equal(readElfInterpFromFile(elfPath), interp)

    const textPath = join(dir, 'not-elf.bin')
    writeFileSync(textPath, '#!/bin/sh\necho hi\n', 'utf8')
    assert.equal(readElfInterpFromFile(textPath), null)
    assert.equal(readElfInterpFromFile(join(dir, 'missing')), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── 2. spawn 前端口预检 ───────────────────────────────────────

test('端口被占用：不 spawn，返回 failed 并给出 PORT_IN_USE 的可执行建议', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-embed-port-'))
  try {
    const { deps, calls } = makeDeps({ healthy: false, portInUse: true })
    const mgr = new EmbedServerManager({ enabled: true, exe: EXE, model: MODEL, cwd: dir, logFile: join(dir, 'log') }, deps)

    assert.equal(await mgr.ensureRunning(), 'failed')
    assert.equal(calls.spawn.length, 0, '端口被占时不打子进程')
    assert.deepEqual(calls.portChecks, [{ host: '127.0.0.1', port: 8078 }], '探测的是配置的 host:port')
    const text = calls.logs.join('\n')
    assert.match(text, /PORT_IN_USE/)
    assert.match(text, /retrieval\.vector\.spawn\.port/, '日志给出改端口的建议')
    assert.match(mgr.lastError ?? '', /PORT_IN_USE/)
    assert.equal(mgr.unavailable, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── 3. 非主动退出自愈 ────────────────────────────────────────

test('自愈：按 1s/5s/30s 退避最多重拉 3 次，耗尽后暴露 lastError/restarts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-embed-heal-'))
  try {
    const { deps, calls, children } = makeDeps({ healthy: false })
    const mgr = new EmbedServerManager({ enabled: true, exe: EXE, model: MODEL, cwd: dir, logFile: join(dir, 'log') }, deps)

    assert.equal(await mgr.ensureRunning(), 'spawned')
    assert.equal(children.length, 1)
    assert.equal(mgr.restarts, 0)

    children[0]!.emit('exit', 1, null)
    await flush()
    assert.equal(children.length, 2, '第 1 次自愈重拉')
    assert.equal(mgr.restarts, 1)

    children[1]!.emit('exit', 1, null)
    await flush()
    assert.equal(children.length, 3, '第 2 次自愈重拉')
    assert.equal(mgr.restarts, 2)

    children[2]!.emit('exit', 1, null)
    await flush()
    assert.equal(children.length, 4, '第 3 次自愈重拉')
    assert.equal(mgr.restarts, 3)
    assert.deepEqual(calls.slept, [1_000, 5_000, 30_000], '退避序列 1s/5s/30s')

    // 第 4 次异常退出：次数已用完，不再重拉，标记不可用
    children[3]!.emit('exit', 1, null)
    await flush()
    assert.equal(children.length, 4, '超过 3 次后不再重拉')
    assert.equal(mgr.restarts, 3)
    assert.equal(mgr.unavailable, true)
    assert.match(mgr.lastError ?? '', /连续异常退出.*已重试 3 次/)
    assert.match(calls.logs.join('\n'), /自愈失败/)

    // 手动 start 必须能把后端从「不可用」里救回来（计数与 lastError 归零）
    assert.equal(await mgr.ensureRunning(), 'spawned')
    assert.equal(children.length, 5)
    assert.equal(mgr.restarts, 0)
    assert.equal(mgr.lastError, null)
    assert.equal(mgr.unavailable, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('自愈重拉期间 ready 轮询不会提前返回「外部实例已就绪」', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-embed-heal-ready-'))
  try {
    let healthy = false
    // 这个用例需要真实时间推进(退避 + 轮询交错),把 sleep 压到 2ms。
    const shortSleep = (ms: number): Promise<void> => new Promise<void>((resolve) => { setTimeout(resolve, Math.min(ms, 2)) })
    const { deps, children } = makeDeps({ healthy: false, probe: async () => healthy, sleep: shortSleep })
    const mgr = new EmbedServerManager({ enabled: true, exe: EXE, model: MODEL, cwd: dir, logFile: join(dir, 'log') }, deps)

    assert.equal(await mgr.ensureRunning(), 'spawned')
    children[0]!.emit('exit', 1, null)
    // 崩溃后立刻开始 ready 轮询:此时没有子进程,但正在自愈重拉,不能当作"外部实例"返回 true
    const ready = mgr.waitUntilReady(10_000)
    for (let i = 0; i < 100 && children.length < 2; i += 1) await shortSleep(2)
    assert.equal(children.length, 2, '自愈已拉起新子进程')
    healthy = true
    assert.equal(await ready, true, '重拉成功后轮询应等到健康')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('并发 start 只拉起一个子进程（启动闸门）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-embed-gate-'))
  try {
    const { deps, calls, children } = makeDeps({ healthy: false })
    const gates: Array<() => void> = []
    // 把端口预检卡住,制造「启动流程进行中」的窗口
    deps.portInUse = () => new Promise<boolean>((resolve) => { gates.push(() => resolve(false)) })
    const mgr = new EmbedServerManager({ enabled: true, exe: EXE, model: MODEL, cwd: dir, logFile: join(dir, 'log') }, deps)

    const first = mgr.ensureRunning()
    await flush()
    assert.equal(gates.length, 1, '第一次 start 卡在端口预检')
    assert.equal(await mgr.ensureRunning(), 'failed', '第二次 start 被启动闸门挡下')
    gates[0]!()
    assert.equal(await first, 'spawned')
    assert.equal(children.length, 1, '只 spawn 了一个子进程')
    assert.match(calls.logs.join('\n'), /跳过重复启动/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stop() 之后退出不再重拉（主动停止不触发自愈）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-embed-heal-stop-'))
  try {
    const { deps, calls, children } = makeDeps({ healthy: false })
    const mgr = new EmbedServerManager({ enabled: true, exe: EXE, model: MODEL, cwd: dir, logFile: join(dir, 'log') }, deps)

    assert.equal(await mgr.ensureRunning(), 'spawned')
    assert.equal(mgr.stop(), true)
    children[0]!.emit('exit', 0, 'SIGTERM')
    await flush()

    assert.equal(children.length, 1, '主动 stop 不重拉')
    assert.equal(mgr.restarts, 0)
    assert.doesNotMatch(calls.logs.join('\n'), /自愈重拉/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('退避等待期间手动 stop()：取消在途重拉，不 spawn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-embed-heal-cancel-'))
  try {
    const pending: Array<() => void> = []
    const { deps, calls, children } = makeDeps({
      healthy: false,
      sleep: (ms: number) => {
        calls.slept.push(ms)
        return new Promise<void>((resolve) => { pending.push(resolve) })
      },
    })
    const mgr = new EmbedServerManager({ enabled: true, exe: EXE, model: MODEL, cwd: dir, logFile: join(dir, 'log') }, deps)

    assert.equal(await mgr.ensureRunning(), 'spawned')
    children[0]!.emit('exit', 1, null)
    await flush()
    assert.equal(mgr.restarts, 1)
    assert.equal(pending.length, 1, '正在 1s 退避等待')

    mgr.stop() // 子进程已退出（owned=false），stop 仍必须能取消在途重拉
    pending[0]!()
    await flush()

    assert.equal(children.length, 1, '取消后不再重拉')
    assert.match(calls.logs.join('\n'), /取消自愈重拉/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── 4. Linux pid 身份校验（防 PID 复用误杀） ─────────────────

test('adopt 前校验 /proc/<pid>/cmdline：PID 已被复用则不接管并清理陈旧 pid 文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-embed-pid-reuse-'))
  const logFile = join(dir, 'llama-server.log')
  try {
    writeFileSync(`${logFile}.pid`, String(process.pid), 'utf8')
    // 同一个 pid 现在是别的程序（PID 复用）→ 不能当成自家 llama-server
    const { deps, calls } = makeDeps({ healthy: true, readProcCmdline: () => '/usr/bin/node --test' })
    const mgr = new EmbedServerManager({ enabled: true, exe: EXE, model: MODEL, logFile }, deps)

    assert.equal(await mgr.ensureRunning(), 'external', '不接管、也不杀')
    assert.equal(mgr.isOwned, false)
    assert.equal(calls.spawn.length, 0)
    assert.equal(existsSync(`${logFile}.pid`), false, '陈旧 pid 文件被清理')
    assert.match(calls.logs.join('\n'), /PID 复用|不是本机的 llama-server/)
    assert.equal(mgr.stop(), false)
    assert.deepEqual(calls.killed, [], 'PID 复用时不发 kill')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('读不到 /proc/<pid>/cmdline 时保持旧行为（仍按存活接管）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-embed-pid-unknown-'))
  const logFile = join(dir, 'llama-server.log')
  try {
    writeFileSync(`${logFile}.pid`, String(process.pid), 'utf8')
    const { deps, calls } = makeDeps({ healthy: true, readProcCmdline: () => null })
    const mgr = new EmbedServerManager({ enabled: true, exe: EXE, model: MODEL, logFile }, deps)

    assert.equal(await mgr.ensureRunning(), 'adopted-managed')
    assert.equal(mgr.isOwned, true)
    mgr.stop()
    assert.deepEqual(calls.killed, [process.pid])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('非 Linux 时不做 /proc 校验（保持旧行为）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-embed-pid-win-'))
  const logFile = join(dir, 'llama-server.log')
  try {
    writeFileSync(`${logFile}.pid`, String(process.pid), 'utf8')
    const { deps, calls } = makeDeps({ healthy: true, platform: 'win32', readProcCmdline: () => 'C:/other.exe' })
    const mgr = new EmbedServerManager({ enabled: true, exe: EXE, model: MODEL, logFile }, deps)

    assert.equal(await mgr.ensureRunning(), 'adopted-managed')
    mgr.stop()
    assert.deepEqual(calls.killed, [process.pid])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stop 前校验 /proc/<pid>/cmdline：PID 被复用则不误杀', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-embed-kill-guard-'))
  try {
    const { deps, calls } = makeDeps({
      healthy: false,
      spawnPid: 6000,
      readProcCmdline: () => '/usr/bin/unrelated-process',
    })
    const mgr = new EmbedServerManager({ enabled: true, exe: EXE, model: MODEL, cwd: dir, logFile: join(dir, 'log') }, deps)

    assert.equal(await mgr.ensureRunning(), 'spawned')
    // 模拟子进程崩溃后 pid 被别人复用：stop 不能杀下去
    assert.equal(mgr.stop(), false, '没有进程被信号')
    assert.deepEqual(calls.killed, [], '不误杀无关进程')
    assert.match(calls.logs.join('\n'), /PID 已复用|不含 llama-server/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ────────────────────────── 孤儿进程清理 ──────────────────────────

test('清理孤儿：pid 存活 + cmdline 是 llama-server + 健康检查不通 → SIGTERM 后重新启动', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-embed-orphan-'))
  const logFile = join(dir, 'llama-server.log')
  try {
    writeFileSync(`${logFile}.pid`, String(process.pid), 'utf8')
    const { deps, calls } = makeDeps({ healthy: false })
    const mgr = new EmbedServerManager({ enabled: true, exe: EXE, model: MODEL, cwd: dir, logFile }, deps)

    assert.equal(await mgr.ensureRunning(), 'spawned')
    assert.equal(calls.killed[0], process.pid, '孤儿被 kill')
    assert.equal(calls.killedSignals[0], 'SIGTERM', '先温柔终止')
    // 测试里 kill 是注入的（进程其实杀不掉），所以会升级 SIGKILL —— 真实环境同理。
    assert.ok(calls.killedSignals.includes('SIGKILL'), 'SIGTERM 无效升级 SIGKILL')
    assert.ok(calls.logs.some((m) => m.includes('清理孤儿')), '要有清理日志')
    assert.equal(calls.spawn.length, 1, '清理后照常启动新实例')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cmdline 不是 llama-server：isAlive 身份校验直接判否，绝不误杀', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-embed-notorphan-'))
  const logFile = join(dir, 'llama-server.log')
  try {
    writeFileSync(`${logFile}.pid`, String(process.pid), 'utf8')
    const { deps, calls } = makeDeps({ healthy: false, readProcCmdline: () => '/bin/bash -c foo' })
    const mgr = new EmbedServerManager({ enabled: true, exe: EXE, model: MODEL, cwd: dir, logFile }, deps)

    await mgr.ensureRunning()
    assert.deepEqual(calls.killed, [], '绝不误杀别的进程')
    assert.ok(!calls.logs.some((m) => m.includes('清理孤儿')), '不应尝试清理')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SIGTERM 无效时升级 SIGKILL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-embed-orphan-kill-'))
  const logFile = join(dir, 'llama-server.log')
  try {
    writeFileSync(`${logFile}.pid`, String(process.pid), 'utf8')
    const { deps, calls } = makeDeps({ healthy: false })
    const mgr = new EmbedServerManager({ enabled: true, exe: EXE, model: MODEL, cwd: dir, logFile }, deps)

    await mgr.ensureRunning()
    assert.ok(calls.killedSignals.includes('SIGKILL'), '顽固进程要升级 SIGKILL')
    assert.ok(calls.logs.some((m) => m.includes('升级 SIGKILL')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('非 Linux：不做孤儿清理（保持旧行为）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-embed-orphan-win-'))
  const logFile = join(dir, 'llama-server.log')
  try {
    writeFileSync(`${logFile}.pid`, String(process.pid), 'utf8')
    const { deps, calls } = makeDeps({ healthy: false, platform: 'win32' })
    const mgr = new EmbedServerManager({ enabled: true, exe: EXE, model: MODEL, cwd: dir, logFile }, deps)

    await mgr.ensureRunning()
    assert.deepEqual(calls.killed, [], '非 Linux 不清理')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
