/**
 * 硬件探测测试。
 *
 * 原则:拿不到就说拿不到("未知"不能冒充 4GB),探测失败绝不抛异常 ——
 * 猜错的显存会直接导致"推荐一个跑不动的模型"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MIN_USEFUL_VRAM_MB,
  flavorsFor,
  parseLspciGpu,
  parseNvidiaSmi,
  parseWindowsGpu,
  probeHardware,
  type HardwareDeps,
} from '../src/hardware.ts'

test('nvidia-smi 输出解析:名字 / 显存 / 驱动', () => {
  const gpu = parseNvidiaSmi('NVIDIA GeForce RTX 4070, 12282, 551.86\n')
  assert.deepEqual(gpu, { vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4070', vramMb: 12282, driver: '551.86' })
  assert.equal(parseNvidiaSmi(''), null)
  assert.equal(parseNvidiaSmi(null), null)
  // 只有名字、没有显存时:显存必须是 null,不能编一个数
  const partial = parseNvidiaSmi('Some GPU, N/A, 550.1')
  assert.equal(partial?.vramMb, null)
})

test('Windows 显卡 CSV:跳过虚拟显卡,4GB 封顶的数值当未知', () => {
  const csv = [
    '"Name","AdapterRAM"',
    '"Microsoft Basic Render Driver","0"',
    '"NVIDIA GeForce RTX 4070","4293918720"',
    '"Intel(R) UHD Graphics 630","1073741824"',
  ].join('\n')
  const parsed = parseWindowsGpu(csv)
  assert.ok(parsed)
  assert.equal(parsed.gpu.vendor, 'nvidia')
  assert.equal(parsed.gpu.vramMb, null, 'uint32 封顶值不能当成真实显存')
  assert.ok(parsed.notes.some((n) => n.includes('读不准')))
  assert.equal(parseWindowsGpu('"Name","AdapterRAM"'), null, '只有表头 = 没探到')
})

test('Windows CSV 里的小显存核显可以读出真实值', () => {
  const parsed = parseWindowsGpu('"Name","AdapterRAM"\n"Intel(R) UHD Graphics 630","1073741824"')
  assert.equal(parsed?.gpu.vramMb, 1024)
  assert.equal(parsed?.gpu.vendor, 'intel')
})

test('风味判定:CUDA 需要够新的驱动,显存太小一律 CPU', () => {
  const nv = (driver: string | null, vramMb: number | null) => ({ platform: 'win32' as const, gpu: { vendor: 'nvidia' as const, name: 'RTX', vramMb, driver } })
  assert.deepEqual(flavorsFor(nv('551.86', 12288)), ['cuda', 'vulkan', 'cpu'])
  assert.deepEqual(flavorsFor(nv('470.14', 12288)), ['vulkan', 'cpu'], '旧驱动不推 CUDA')
  assert.deepEqual(flavorsFor(nv(null, 12288)), ['vulkan', 'cpu'], '驱动读不到不推 CUDA')
  assert.deepEqual(flavorsFor(nv('551.86', MIN_USEFUL_VRAM_MB - 1)), ['cpu'])
  assert.deepEqual(flavorsFor({ platform: 'win32', gpu: { vendor: 'amd', name: 'RX 6800', vramMb: 16384, driver: null } }), ['vulkan', 'cpu'])
  assert.deepEqual(flavorsFor({ platform: 'win32', gpu: null }), ['cpu'])
  assert.deepEqual(flavorsFor({ platform: 'darwin', gpu: null }), ['metal', 'cpu'])
})

function deps(over: Partial<HardwareDeps> = {}): HardwareDeps {
  return {
    platform: 'win32',
    arch: 'x64',
    cpuCount: () => 8,
    totalRamMb: () => 32768,
    freeDiskMb: () => 100 * 1024,
    nvidiaSmi: async () => 'NVIDIA GeForce RTX 4070, 12288, 551.86',
    windowsGpu: async () => null,
    log: () => {},
    ...over,
  }
}

test('探测:nvidia-smi 有结果就走它,不碰 PowerShell(省几秒)', async () => {
  let windowsQueried = false
  const hw = await probeHardware({ dir: 'D:/x' }, deps({ windowsGpu: async () => { windowsQueried = true; return null } }))
  assert.equal(hw.gpu?.vendor, 'nvidia')
  assert.deepEqual(hw.flavors, ['cuda', 'vulkan', 'cpu'])
  assert.equal(windowsQueried, false)
  assert.equal(hw.cpuCount, 8)
  assert.equal(hw.totalRamMb, 32768)
})

test('探测:nvidia-smi 没有时退回 Windows 查询', async () => {
  const hw = await probeHardware({ dir: 'D:/x' }, deps({
    nvidiaSmi: async () => null,
    // 6GB 在 WMI 里读不准(≥4GB 一律按未知),但"未知显存"不等于"不可用":独显仍然推 Vulkan
    windowsGpu: async () => '"Name","AdapterRAM"\n"AMD Radeon RX 6800","6442450944"',  }))
  assert.equal(hw.gpu?.vendor, 'amd')
  assert.deepEqual(hw.flavors, ['vulkan', 'cpu'])
})

test('探测:都没有显卡时说明"将以 CPU 运行",而不是留空', async () => {
  const hw = await probeHardware({ dir: 'D:/x' }, deps({ nvidiaSmi: async () => null, windowsGpu: async () => null }))
  assert.equal(hw.gpu, null)
  assert.deepEqual(hw.flavors, ['cpu'])
  assert.ok(hw.notes.some((n) => n.includes('CPU')))
})

test('探测:磁盘读不到时如实标注,不猜数字', async () => {
  const hw = await probeHardware({ dir: 'D:/x' }, deps({ freeDiskMb: () => null }))
  assert.equal(hw.freeDiskMb, null)
  assert.equal(hw.diskPath, null)
  assert.ok(hw.notes.some((n) => n.includes('磁盘')))
})

test('探测:外部命令抛错也不许把插件带崩', async () => {
  const hw = await probeHardware({ dir: 'D:/x' }, deps({
    nvidiaSmi: async () => { throw new Error('nvidia-smi 不存在') },
    windowsGpu: async () => { throw new Error('powershell 被策略拦了') },
    freeDiskMb: () => { throw new Error('statfs 不支持') },
  }))
  assert.equal(hw.gpu, null)
  assert.equal(hw.freeDiskMb, null)
  assert.deepEqual(hw.flavors, ['cpu'])
})

// ─────────────── Linux：lspci 兜底（AMD/Intel 机器） ───────────────

test('lspci 解析：识别 NVIDIA/AMD/Intel，显存一律未知，多卡优先独显', () => {
  const out = [
    '00:02.0 VGA compatible controller [0300]: Intel Corporation Raptor Lake-P [Iris Xe Graphics] [8086:a7a0]',
    '01:00.0 VGA compatible controller [0300]: NVIDIA Corporation AD103 [GeForce RTX 4070] [10de:2706]',
    '03:00.0 3D controller [0302]: Advanced Micro Devices, Inc. [AMD/ATI] Navi 31 [Radeon RX 7900 XTX] [1002:744c]',
  ].join('\n')
  const gpu = parseLspciGpu(out)
  assert.ok(gpu !== null)
  assert.equal(gpu.vendor, 'nvidia', '多卡时优先 NVIDIA')
  assert.equal(gpu.name, 'NVIDIA Corporation AD103 [GeForce RTX 4070]')
  assert.equal(gpu.vramMb, null, 'lspci 不提供显存，不能编一个数')
  assert.equal(parseLspciGpu(''), null)
  assert.equal(parseLspciGpu(null), null)
})

test('探测：Linux 上 nvidia-smi 失败时用 lspci 补 AMD 卡 → 推荐 Vulkan', async () => {
  const hw = await probeHardware({ dir: '/tmp/x' }, deps({
    platform: 'linux',
    nvidiaSmi: async () => null,
    lspci: async () => '03:00.0 VGA compatible controller [0300]: Advanced Micro Devices, Inc. [AMD/ATI] Navi 31 [Radeon RX 7900 XTX] [1002:744c]',
  }))
  assert.equal(hw.gpu?.vendor, 'amd')
  assert.deepEqual(hw.flavors, ['vulkan', 'cpu'])
  assert.ok(hw.notes.some((n) => n.includes('lspci')), '如实说明是 lspci 发现的')
})
