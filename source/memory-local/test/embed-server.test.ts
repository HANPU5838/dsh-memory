/**
 * Embedding-backend lifecycle (llama-server as a child of the app process).
 *
 * Contract under test:
 *  - opt-in: disabled by default, so dev/test runs never spawn a real server
 *  - endpoint already healthy + our PID file → adopt and own it (kill on exit)
 *  - endpoint already healthy without a PID file → external, never killed
 *  - stop() kills only what we own, and always clears the PID file
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EmbedServerManager, type EmbedServerDeps } from '../src/embed-server.ts'

interface FakeChild {
  pid: number
  exitCode: number | null
  once(event: string, cb: (...args: unknown[]) => void): void
  emit(event: string, ...args: unknown[]): void
}

function makeDeps(opts: { healthy: boolean; spawnPid?: number }) {
  const calls = { spawn: [] as Array<{ exe: string; args: string[]; cwd?: string }>, killed: [] as number[], logs: [] as string[] }
  const children: FakeChild[] = []
  const deps: Partial<EmbedServerDeps> = {
    spawn: ((exe: string, args: string[], options: { cwd?: string }) => {
      calls.spawn.push({ exe, args, cwd: options?.cwd })
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
    probe: async () => opts.healthy,
    kill: (pid: number) => { calls.killed.push(pid) },
    log: (message: string) => { calls.logs.push(message) },
    sleep: async () => {},
  }
  return { deps, calls, children }
}

const EXE = 'D:/stack/llamacpp/llama-server.exe'
const MODEL = 'D:/stack/models/bge-m3.gguf'

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
