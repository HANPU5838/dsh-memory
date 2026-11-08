/**
 * 平台适配层回归：Termux/Android 的差异必须收敛在 platform.ts，且探测永不抛。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  detectPlatform,
  describePlatform,
  freeDiskBytes,
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
