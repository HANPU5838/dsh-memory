/**
 * 平台适配层回归：Termux/Android 的差异必须收敛在 platform.ts，且探测永不抛。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ENV_SYSTEM_LLAMA_SERVER,
  assetPlatform,
  detectPlatform,
  detectRuntimeEnvironment,
  describePlatform,
  findSystemLlamaServer,
  freeDiskBytes,
  isLinuxLike,
  readElfInterpFromFile,
} from '../src/platform.ts'

function fakeEnv(map: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return map as NodeJS.ProcessEnv
}

test('Termux 环境：识别 prefix、glibc loader、CPU 兜底', () => {
  const prefix = '/data/data/com.termux/files/usr'
  const loader = join(prefix, 'glibc', 'lib', 'ld-linux-aarch64.so.1')
  const info = detectPlatform({
    env: fakeEnv({ PREFIX: prefix, TERMUX_VERSION: '0.118', TMPDIR: join(prefix, 'tmp') }),
    platform: 'linux',
    arch: 'arm64',
    cpuCount: () => 0, // 模拟 Android 上 /proc/stat 被拦、os.cpus() 为空
    totalMemMb: () => 15_348,
    exists: (path) => path === loader || path.endsWith('/glibc/lib'),
    readFile: () => 'MemAvailable:       7737000 kB\n',
  })
  assert.equal(info.termux, true)
  assert.equal(info.prefix, prefix)
  assert.equal(info.glibcLoader, loader)
  assert.equal(info.glibcLibDir, join(prefix, 'glibc', 'lib'))
  assert.equal(info.cpuCount, 4, 'cpus() 为 0 时必须兜底成 4')
  assert.equal(info.availableMemMb, 7556, '用 MemAvailable 而不是物理内存')
  assert.ok(describePlatform(info).includes('Termux'))
  assert.ok(describePlatform(info).includes('glibc loader ✓'))
})

test('普通 Linux：不是 Termux、没有 glibc loader，也不报错', () => {
  const info = detectPlatform({
    env: fakeEnv({ HOME: '/home/x' }),
    platform: 'linux',
    arch: 'x64',
    cpuCount: () => 16,
    totalMemMb: () => 32_000,
    exists: () => false,
    readFile: () => { throw new Error('ENOENT') },
  })
  assert.equal(info.termux, false)
  assert.equal(info.prefix, null)
  assert.equal(info.glibcLoader, null)
  assert.equal(info.cpuCount, 16)
  assert.equal(info.availableMemMb, null)
  assert.ok(!describePlatform(info).includes('glibc'))
})

test('readElfInterpFromFile：解析 PT_INTERP；非 ELF 返回 null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-platform-elf-'))
  try {
    const elf = join(dir, 'fake-binary')
    const interp = '/lib/ld-linux-aarch64.so.1'
    const header = Buffer.alloc(64)
    header.writeUInt32LE(0x464c457f, 0) // \x7fELF
    header[4] = 2 // 64-bit
    header.writeBigUInt64LE(64n, 32) // e_phoff
    header.writeUInt16LE(56, 54) // e_phentsize
    header.writeUInt16LE(1, 56) // e_phnum
    const ph = Buffer.alloc(56)
    ph.writeUInt32LE(3, 0) // PT_INTERP
    ph.writeBigUInt64LE(120n, 8) // p_offset = 64(ELF header) + 56(program header)
    ph.writeBigUInt64LE(BigInt(interp.length + 1), 32) // p_filesz
    const body = Buffer.alloc(128)
    body.write(interp, 0, 'utf8')
    writeFileSync(elf, Buffer.concat([header, ph, body]))

    assert.equal(readElfInterpFromFile(elf), interp)

    const text = join(dir, 'not-elf')
    writeFileSync(text, '#!/bin/sh\necho hi\n')
    assert.equal(readElfInterpFromFile(text), null)
    assert.equal(readElfInterpFromFile(join(dir, 'missing')), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('freeDiskBytes：真实目录能读到，深路径会向上找祖先，不存在则 null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-platform-disk-'))
  try {
    const free = freeDiskBytes(dir)
    assert.ok(free !== null && free > 0, '应读到可用字节')
    assert.ok(freeDiskBytes(join(dir, 'a', 'b', 'c')) !== null, '祖先存在即可')
    // 空路径没有可回退的祖先 → 未知（真实 Linux 上 / 永远存在，用它测 null 不可靠）
    assert.equal(freeDiskBytes(''), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('findSystemLlamaServer：显式环境变量 → $PREFIX/bin → PATH，找不到返回 null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-platform-llama-'))
  try {
    const explicit = join(dir, 'custom-llama-server')
    writeFileSync(explicit, 'x')
    const prefix = join(dir, 'prefix')
    const prefixExe = join(prefix, 'bin', 'llama-server')
    mkdirSync(join(prefix, 'bin'), { recursive: true })
    writeFileSync(prefixExe, 'x')
    const pathDir = join(dir, 'pathbin')
    mkdirSync(pathDir)
    const pathExe = join(pathDir, 'llama-server')
    writeFileSync(pathExe, 'x')

    assert.equal(
      findSystemLlamaServer({ env: fakeEnv({ [ENV_SYSTEM_LLAMA_SERVER]: explicit }), exists: existsSync, prefix: null, pathEnv: '' }),
      explicit,
      '显式环境变量优先级最高',
    )
    assert.equal(
      findSystemLlamaServer({ env: fakeEnv({ LLAMA_SERVER: join(dir, 'missing') }), exists: existsSync, prefix, pathEnv: '' }),
      prefixExe,
      'LLAMA_SERVER 指向不存在的文件时回退到 $PREFIX/bin',
    )
    assert.equal(
      findSystemLlamaServer({ env: fakeEnv({}), exists: existsSync, prefix: null, pathEnv: pathDir }),
      pathExe,
      '最后回退到 PATH',
    )
    assert.equal(
      findSystemLlamaServer({ env: fakeEnv({}), exists: existsSync, prefix: null, pathEnv: join(dir, 'nope') }),
      null,
      '都没有时返回 null（调用方走托管运行时）',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('isLinuxLike / assetPlatform：Android 与 Linux 同语义（Termux 走 ubuntu 资产）', () => {
  assert.equal(isLinuxLike('linux'), true)
  assert.equal(isLinuxLike('android'), true, 'Android 也是 Linux 语义（/proc、glibc loader）')
  assert.equal(isLinuxLike('darwin'), false)
  assert.equal(assetPlatform('android'), 'linux', 'Android 复用 ubuntu 构建，靠 glibc loader 启动')
  assert.equal(assetPlatform('linux'), 'linux')
  assert.equal(assetPlatform('win32'), 'win32')
})

test('describePlatform：Termux 用系统 llama-server 时不再显示 glibc ✗', () => {
  const info = detectPlatform({
    env: fakeEnv({ PREFIX: '/data/data/com.termux/files/usr', TERMUX_VERSION: '0.118' }),
    platform: 'android',
    arch: 'arm64',
    exists: () => false,
    readFile: () => '',
  })
  const managed = describePlatform(info, { runtimeSource: 'managed' })
  assert.ok(managed.includes('glibc loader ✗'), '托管运行时仍要如实显示缺 glibc')
  const system = describePlatform(info, { runtimeSource: 'system' })
  assert.ok(system.includes('系统 llama-server ✓'), `实际：${system}`)
  assert.ok(!system.includes('glibc loader ✗'), '系统 bionic 二进制不需要 glibc，不该吓人')
})

// ─────────────── 跨平台运行环境适配层 ───────────────

test('detectRuntimeEnvironment：Linux 发行版 + apt + 系统 llama-server 一次探清', () => {
  const env = detectRuntimeEnvironment({
    env: fakeEnv({ LLAMA_SERVER: '/opt/llama/bin/llama-server', PATH: '' }),
    platform: 'linux',
    arch: 'x64',
    home: '/home/u',
    readFile: (path) => (path === '/etc/os-release' ? ['NAME="Debian"', 'ID=debian', ''].join('\n') : ''),
    exists: (path) => path === '/usr/bin/apt-get' || path === '/opt/llama/bin/llama-server',
  })
  assert.equal(env.platform, 'linux')
  assert.equal(env.termux, false)
  assert.equal(env.distro, 'debian')
  assert.equal(env.packageManager?.kind, 'apt')
  assert.deepEqual(env.packageManager?.install, ['install', '-y', 'llama.cpp'])
  assert.equal(env.systemLlamaServer, '/opt/llama/bin/llama-server')
})

test('detectRuntimeEnvironment：Termux 用 pkg；macOS 用 brew（跨平台同一套适配）', () => {
  const prefix = '/data/data/com.termux/files/usr'
  const termux = detectRuntimeEnvironment({
    env: fakeEnv({ PREFIX: prefix, TERMUX_VERSION: '0.118', PATH: '' }),
    platform: 'android',
    arch: 'arm64',
    exists: (path) => path === `${prefix}/bin/pkg`,
    readFile: () => '',
  })
  assert.equal(termux.termux, true)
  assert.equal(termux.packageManager?.kind, 'pkg')
  assert.deepEqual(termux.packageManager?.install, ['install', '-y', 'llama-cpp'])

  const mac = detectRuntimeEnvironment({
    env: fakeEnv({ PATH: '' }),
    platform: 'darwin',
    arch: 'arm64',
    home: '/Users/u',
    readFile: () => '',
    exists: (path) => path === '/opt/homebrew/bin/brew',
  })
  assert.equal(mac.termux, false)
  assert.equal(mac.distro, null)
  assert.equal(mac.packageManager?.kind, 'brew')
  assert.deepEqual(mac.packageManager?.install, ['install', 'llama.cpp'])
})

test('findSystemLlamaServer：不依赖 PATH 也能发现常见安装位置（brew/~/.local/源码编译）', () => {
  const found = findSystemLlamaServer({
    env: fakeEnv({ HOME: '/home/u', PATH: '' }),
    exists: (path) => path === '/home/u/.local/bin/llama-server',
  })
  assert.equal(found, '/home/u/.local/bin/llama-server', 'GUI 进程 PATH 不完整时也要能找到')
})

test('describePlatform：非 Termux 平台也显示系统运行时与发行版，而不是硬编码 Termux 判断', () => {
  const info = detectPlatform({ env: fakeEnv({}), platform: 'linux', arch: 'x64', exists: () => false, readFile: () => '' })
  const text = describePlatform(info, { runtimeSource: 'system', distro: 'arch' })
  assert.ok(text.includes('arch'), `应包含发行版：${text}`)
  assert.ok(text.includes('系统 llama-server ✓'), `应显示系统运行时：${text}`)
  assert.ok(!text.includes('glibc'), '非 Termux 不该出现 glibc 字样')
})
