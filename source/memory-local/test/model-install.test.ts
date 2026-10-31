/**
 * 运行时风味选择 + 模型落盘布局 + 配置解析(含面板选过什么的记忆)。
 *
 * 资产名用的是 llama.cpp b11678 的真实名单(2026-10-16 查的 API),包括
 * CUDA 需要的那个**命名不一致**的 cudart 伴随包 —— 靠 cuda 次版本号配对。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  detectInstalled, installPaths, pickRuntimeAsset, pickRuntimeCompanion,
  runtimeAssetPattern, runtimeCompanionPattern,
} from '../src/embed-install.ts'
import { MODEL_STATE_FILE, pickSpawnModel, resolveConfig } from '../src/index.ts'

const ASSETS = [
  'llama-b11678-bin-win-cpu-x64.zip',
  'llama-b11678-bin-win-vulkan-x64.zip',
  'llama-b11678-bin-win-cuda-12.4-x64.zip',
  'llama-b11678-bin-win-sycl-x64.zip',
  'llama-b11678-bin-ubuntu-x64.tar.gz',
  'llama-b11678-bin-ubuntu-vulkan-x64.tar.gz',
  'llama-b11678-bin-ubuntu-cuda-12.8-x64.tar.gz',
  'llama-b11678-bin-ubuntu-openvino-2026.4.1-x64.tar.gz',
  'llama-b11678-bin-macos-arm64.tar.gz',
  'cudart-llama-bin-win-cuda-12.4-x64.zip',
  'cudart-llama-b11678-bin-ubuntu-cuda-12.8-x64.tar.gz',
].map((name) => ({ name, browser_download_url: `https://example.test/${name}`, url: `https://api.test/${name}` }))

/**
 * 真实 b12023 资产名单（2026-10-31 查的 API，按 API 返回顺序逐字抄下来）。
 * 关键事实：GitHub 对 llama.cpp 的 assets 按名字升序返回，`cudart-*` 恒排在
 * `llama-*` 主包**之前**（扫过 700 个 release 都是如此）。主包正则若没有
 * `^llama-` 锚定，会先命中 `cudart-llama-bin-win-cuda-12.4-x64.zip`，把 CUDA
 * 运行库当运行时下下来，解压后找不到 llama-server.exe —— issue #4。
 */
const ASSETS_B12023_NAMES = [
  'cudart-llama-b12023-bin-ubuntu-cuda-12.8-x64.tar.gz',
  'cudart-llama-b12023-bin-ubuntu-cuda-13.4-arm64.tar.gz',
  'cudart-llama-b12023-bin-ubuntu-cuda-13.4-x64.tar.gz',
  'cudart-llama-bin-win-cuda-12.4-x64.zip',
  'cudart-llama-bin-win-cuda-13.4-arm64.zip',
  'cudart-llama-bin-win-cuda-13.4-x64.zip',
  'llama-b12023-bin-android-arm64-snapdragon.tar.gz',
  'llama-b12023-bin-android-arm64.tar.gz',
  'llama-b12023-bin-linux-arm64-snapdragon.tar.gz',
  'llama-b12023-bin-macos-arm64.tar.gz',
  'llama-b12023-bin-macos-x64.tar.gz',
  'llama-b12023-bin-ubuntu-26.04-s390x.tar.gz',
  'llama-b12023-bin-ubuntu-arm64.tar.gz',
  'llama-b12023-bin-ubuntu-cuda-12.8-x64.tar.gz',
  'llama-b12023-bin-ubuntu-cuda-13.4-arm64.tar.gz',
  'llama-b12023-bin-ubuntu-cuda-13.4-x64.tar.gz',
  'llama-b12023-bin-ubuntu-openvino-2026.4.1-x64.tar.gz',
  'llama-b12023-bin-ubuntu-rocm-10.0-x64.tar.gz',
  'llama-b12023-bin-ubuntu-s390x.tar.gz',
  'llama-b12023-bin-ubuntu-sycl-fp16-x64.tar.gz',
  'llama-b12023-bin-ubuntu-sycl-fp32-x64.tar.gz',
  'llama-b12023-bin-ubuntu-vulkan-arm64.tar.gz',
  'llama-b12023-bin-ubuntu-vulkan-x64.tar.gz',
  'llama-b12023-bin-ubuntu-x64.tar.gz',
  'llama-b12023-bin-ubuntu-zdnn-s390x.tar.gz',
  'llama-b12023-bin-win-cpu-arm64.zip',
  'llama-b12023-bin-win-cpu-x64.zip',
  'llama-b12023-bin-win-cuda-12.4-x64.zip',
  'llama-b12023-bin-win-cuda-13.4-arm64.zip',
  'llama-b12023-bin-win-cuda-13.4-x64.zip',
  'llama-b12023-bin-win-opencl-adreno-arm64.zip',
  'llama-b12023-bin-win-openvino-2026.4.1-x64.zip',
  'llama-b12023-bin-win-rocm-10.0-x64.zip',
  'llama-b12023-bin-win-sycl-x64.zip',
  'llama-b12023-bin-win-vulkan-arm64.zip',
  'llama-b12023-bin-win-vulkan-x64.zip',
  'llama-b12023-ui.tar.gz',
  'llama-b12023-xcframework.zip',
]
const ASSETS_B12023 = ASSETS_B12023_NAMES.map((name) => ({
  name,
  browser_download_url: `https://example.test/${name}`,
  url: `https://api.test/${name}`,
}))

test('回归 issue #4：cudart 排在主包前面时，CUDA 仍必须选中 llama-*（伴生包不能当运行时）', () => {
  assert.equal(
    pickRuntimeAsset(ASSETS_B12023, 'win32', 'x64', 'cuda')?.name,
    'llama-b12023-bin-win-cuda-12.4-x64.zip',
    '主包只看 llama-*；命中 cudart-* 会解压出不满一个 llama-server.exe',
  )
  assert.equal(pickRuntimeCompanion(ASSETS_B12023, 'win32', 'x64', 'cuda')?.name, 'cudart-llama-bin-win-cuda-12.4-x64.zip')
  assert.equal(pickRuntimeAsset(ASSETS_B12023, 'linux', 'x64', 'cuda')?.name, 'llama-b12023-bin-ubuntu-cuda-12.8-x64.tar.gz')

  // 只有 cudart 资产时宁可不匹配（调用方会退回 CPU 包/明确报错），也不能把它当运行时。
  const cudartOnly = ASSETS_B12023.filter((asset) => asset.name.startsWith('cudart-'))
  assert.equal(pickRuntimeAsset(cudartOnly, 'win32', 'x64', 'cuda'), null)
  assert.equal(pickRuntimeAsset(cudartOnly, 'linux', 'x64', 'cuda'), null)
})

test('CUDA 四种受支持平台组合都只挑 llama-* 主包（b12023 真实名单）', () => {
  const cases: Array<[NodeJS.Platform, string, string, string]> = [
    ['win32', 'x64', 'llama-b12023-bin-win-cuda-12.4-x64.zip', 'cudart-llama-bin-win-cuda-12.4-x64.zip'],
    ['win32', 'arm64', 'llama-b12023-bin-win-cuda-13.4-arm64.zip', 'cudart-llama-bin-win-cuda-13.4-arm64.zip'],
    ['linux', 'x64', 'llama-b12023-bin-ubuntu-cuda-12.8-x64.tar.gz', 'cudart-llama-b12023-bin-ubuntu-cuda-12.8-x64.tar.gz'],
    ['linux', 'arm64', 'llama-b12023-bin-ubuntu-cuda-13.4-arm64.tar.gz', 'cudart-llama-b12023-bin-ubuntu-cuda-13.4-arm64.tar.gz'],
  ]
  for (const [platform, arch, main, companion] of cases) {
    assert.equal(pickRuntimeAsset(ASSETS_B12023, platform, arch, 'cuda')?.name, main, `${platform}-${arch} 主包`)
    assert.equal(pickRuntimeCompanion(ASSETS_B12023, platform, arch, 'cuda')?.name, companion, `${platform}-${arch} 伴生包`)
    assert.notEqual(main, companion, '主包与伴生包必须是两个不同的资产')
  }
})

test('资产顺序不影响选择：b12023 名单倒过来也一样', () => {
  const reversed = [...ASSETS_B12023].reverse()
  assert.equal(pickRuntimeAsset(reversed, 'win32', 'x64', 'cuda')?.name, 'llama-b12023-bin-win-cuda-12.4-x64.zip')
  assert.equal(pickRuntimeCompanion(reversed, 'win32', 'x64', 'cuda')?.name, 'cudart-llama-bin-win-cuda-12.4-x64.zip')
  assert.equal(pickRuntimeAsset(reversed, 'linux', 'arm64', 'cuda')?.name, 'llama-b12023-bin-ubuntu-cuda-13.4-arm64.tar.gz')
})

test('主包 / 伴生包正则互斥：b12023 全名单 × 6 平台 × 4 风味不互相误命中', () => {
  const combos: Array<[NodeJS.Platform, string]> = [
    ['win32', 'x64'], ['win32', 'arm64'],
    ['linux', 'x64'], ['linux', 'arm64'],
    ['darwin', 'arm64'], ['darwin', 'x64'],
  ]
  const flavors = ['cpu', 'vulkan', 'cuda', 'metal'] as const
  for (const [platform, arch] of combos) {
    for (const flavor of flavors) {
      const main = pickRuntimeAsset(ASSETS_B12023, platform, arch, flavor)
      const companion = pickRuntimeCompanion(ASSETS_B12023, platform, arch, flavor)
      if (main !== null) {
        assert.ok(main.name.startsWith('llama-'), `${platform}-${arch} ${flavor} 主包误选 ${main.name}`)
      }
      if (companion !== null) {
        assert.ok(companion.name.startsWith('cudart-'), `${platform}-${arch} ${flavor} 伴生包误选 ${companion.name}`)
        assert.notEqual(main?.name, companion.name, `${platform}-${arch} ${flavor} 主包与伴生包撞成同一个资产`)
      }
    }
  }
})

test('CPU 风味挑通用包,绝不误选 vulkan/cuda/openvino', () => {
  assert.equal(pickRuntimeAsset(ASSETS, 'win32', 'x64', 'cpu')?.name, 'llama-b11678-bin-win-cpu-x64.zip')
  assert.equal(pickRuntimeAsset(ASSETS, 'linux', 'x64', 'cpu')?.name, 'llama-b11678-bin-ubuntu-x64.tar.gz')
  assert.equal(pickRuntimeAsset(ASSETS, 'darwin', 'arm64', 'cpu')?.name, 'llama-b11678-bin-macos-arm64.tar.gz')
})

test('Vulkan 风味挑 vulkan 包;macOS 没有独立 vulkan 包时退回 CPU 构建', () => {
  assert.equal(pickRuntimeAsset(ASSETS, 'win32', 'x64', 'vulkan')?.name, 'llama-b11678-bin-win-vulkan-x64.zip')
  assert.equal(pickRuntimeAsset(ASSETS, 'linux', 'x64', 'vulkan')?.name, 'llama-b11678-bin-ubuntu-vulkan-x64.tar.gz')
  // macOS 的 GPU 路径就是 Metal,资产与 cpu 相同
  assert.equal(pickRuntimeAsset(ASSETS, 'darwin', 'arm64', 'metal')?.name, 'llama-b11678-bin-macos-arm64.tar.gz')
})

test('CUDA 风味挑 12.4/12.8 包,并配上同一套工具链的 cudart', () => {
  assert.equal(pickRuntimeAsset(ASSETS, 'win32', 'x64', 'cuda')?.name, 'llama-b11678-bin-win-cuda-12.4-x64.zip')
  assert.equal(pickRuntimeCompanion(ASSETS, 'win32', 'x64', 'cuda')?.name, 'cudart-llama-bin-win-cuda-12.4-x64.zip')
  assert.equal(pickRuntimeAsset(ASSETS, 'linux', 'x64', 'cuda')?.name, 'llama-b11678-bin-ubuntu-cuda-12.8-x64.tar.gz')
  assert.equal(pickRuntimeCompanion(ASSETS, 'linux', 'x64', 'cuda')?.name, 'cudart-llama-b11678-bin-ubuntu-cuda-12.8-x64.tar.gz')
})

test('非 CUDA 风味没有伴随包;不支持的平台明确报错', () => {
  assert.equal(runtimeCompanionPattern('win32', 'x64', 'vulkan'), null)
  assert.equal(runtimeCompanionPattern('win32', 'x64', 'cpu'), null)
  assert.equal(pickRuntimeCompanion(ASSETS, 'win32', 'x64', 'cpu'), null)
  assert.throws(() => runtimeAssetPattern('freebsd', 'x64', 'cpu'), /暂不支持该平台/)
})

test('模型文件名参与布局与"装没装"判定:换模型不会把老文件当成已安装', () => {
  const paths = installPaths('D:/stack', 'nomic-embed-text-v1.5.Q4_K_M.gguf')
  assert.ok(paths.model.endsWith(join('models', 'nomic-embed-text-v1.5.Q4_K_M.gguf')))
  assert.ok(paths.exe.endsWith(process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'))

  const root = mkdtempSync(join(tmpdir(), 'dsh-mem-model-'))
  mkdirSync(join(root, 'llamacpp'), { recursive: true })
  mkdirSync(join(root, 'models'), { recursive: true })
  const exeName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
  writeFileSync(join(root, 'llamacpp', exeName), 'x')
  writeFileSync(join(root, 'models', 'a.gguf'), 'x')

  assert.ok(detectInstalled(root, 'a.gguf'), 'exe + 该模型文件都在 → 已安装')
  assert.equal(detectInstalled(root, 'b.gguf'), null, '文件是别的模型时不算已安装')
})

function vectorConfig(over: Record<string, unknown> = {}) {
  return resolveConfig({ storeDir: join(mkdtempSync(join(tmpdir(), 'dsh-mem-cfg-')), 'store'), retrieval: { vector: over as never } })
}

test('默认(不配任何模型项)= 老的 bge-m3 Q4_K_M + CPU + cls', () => {
  const cfg = vectorConfig({ enabled: false })
  assert.equal(cfg.vector.presetId, 'bge-m3')
  assert.equal(cfg.vector.variantId, 'q4_k_m')
  assert.equal(cfg.vector.installModel.file, 'bge-m3-Q4_K_M.gguf')
  assert.equal(cfg.vector.dims, 1024)
  assert.equal(cfg.vector.pooling, 'cls')
  assert.equal(cfg.vector.flavor, 'cpu')
  assert.equal(cfg.vector.gpuLayers, 0)
  assert.equal(cfg.vector.model, 'bge-m3')
})

test('预设决定维度与 pooling(写错维度会让检索静默退化,所以必须跟着模型走)', () => {
  const qwen = vectorConfig({ enabled: false, preset: 'qwen3-embedding-0.6b' })
  assert.equal(qwen.vector.dims, 1024)
  assert.equal(qwen.vector.pooling, 'last')
  assert.equal(qwen.vector.model, 'qwen3-embedding-0.6b')
  assert.equal(qwen.vector.installModel.file, 'Qwen3-Embedding-0.6B-Q8_0.gguf')

  const small = vectorConfig({ enabled: false, preset: 'bge-small-zh-v1.5' })
  assert.equal(small.vector.dims, 512)
  assert.equal(small.vector.pooling, 'cls')
})

test('显式 dims / pooling 覆盖预设(用户自己知道服务端输出什么)', () => {
  const cfg = vectorConfig({ enabled: false, preset: 'bge-m3', dims: 768, pooling: 'mean' })
  assert.equal(cfg.vector.dims, 768)
  assert.equal(cfg.vector.pooling, 'mean')
})

test('自定义模型:文件名取自 URL,源就是它,pooling 默认交给元数据', () => {
  const cfg = vectorConfig({ enabled: false, customModel: { url: 'https://example.test/x/my-model-Q8_0.gguf', dims: 1024 } })
  assert.equal(cfg.vector.presetId, 'custom')
  assert.equal(cfg.vector.installModel.file, 'my-model-Q8_0.gguf')
  assert.deepEqual(cfg.vector.installModel.sources, ['https://example.test/x/my-model-Q8_0.gguf'])
  assert.equal(cfg.vector.pooling, 'auto')
  assert.equal(cfg.vector.dims, 1024)
  assert.equal(cfg.vector.model, 'my-model-Q8_0')
})

test('GPU 风味:gpuLayers 跟着走(99 层 = 整块卸载),pooling 仍然跟着模型', () => {
  const cfg = vectorConfig({ enabled: false, preset: 'qwen3-embedding-4b', flavor: 'cuda' })
  assert.equal(cfg.vector.flavor, 'cuda')
  assert.equal(cfg.vector.gpuLayers, 99)
  assert.equal(cfg.vector.spawn.gpuLayers, 99)
  assert.equal(cfg.vector.spawn.pooling, 'last')
})

test('model 字符串命中清单 id 时按它选预设;认不出则不改身份、只用默认安装模型', () => {
  const nomic = vectorConfig({ enabled: false, model: 'nomic-embed-text-v1.5' })
  assert.equal(nomic.vector.presetId, 'nomic-embed-text-v1.5')
  assert.equal(nomic.vector.dims, 768)
  assert.equal(nomic.vector.queryPrefix, 'search_query: ')
  assert.equal(nomic.vector.documentPrefix, 'search_document: ')

  const cloud = vectorConfig({ enabled: false, endpoint: 'https://api.example.com/v1/embeddings', model: 'my-cloud-model', dims: 1024 })
  assert.equal(cloud.vector.model, 'my-cloud-model', '请求里的模型名必须保持原样')
  assert.equal(cloud.vector.presetId, 'bge-m3', '安装器退回默认模型')
})

test('面板选过什么:安装目录里的状态文件生效,但配置永远优先', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mem-state-'))
  writeFileSync(join(root, MODEL_STATE_FILE), JSON.stringify({ presetId: 'bge-large-zh-v1.5', variantId: 'f16', flavor: 'vulkan' }))
  const storeDir = join(root, 'store')

  const fromState = resolveConfig({ storeDir, retrieval: { vector: { enabled: false, autoInstall: { dir: root } } } })
  assert.equal(fromState.vector.presetId, 'bge-large-zh-v1.5')
  assert.equal(fromState.vector.dims, 1024)
  assert.equal(fromState.vector.flavor, 'vulkan', '面板选的风味也要记住')
  assert.equal(fromState.vector.gpuLayers, 99)

  const fromConfig = resolveConfig({
    storeDir,
    retrieval: { vector: { enabled: false, preset: 'bge-m3', autoInstall: { dir: root } } },
  })
  assert.equal(fromConfig.vector.presetId, 'bge-m3', '配置里写了 preset 就以配置为准')
  assert.equal(fromConfig.vector.installModel.file, 'bge-m3-Q4_K_M.gguf')
})

test('状态文件坏掉/是垃圾时不能影响启动(退回配置或默认)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mem-state-bad-'))
  writeFileSync(join(root, MODEL_STATE_FILE), '{ not json')
  const cfg = resolveConfig({ storeDir: join(root, 'store'), retrieval: { vector: { enabled: false, autoInstall: { dir: root } } } })
  assert.equal(cfg.vector.presetId, 'bge-m3')
})

test('接管后端时不能用上一个模型的路径(模型和 dims/pooling 必须配套)', () => {
  // 配置里指着新模型 → 用刚装好的那份
  assert.equal(pickSpawnModel('bge-m3-Q4_K_M.gguf', 'D:/old/other-model.gguf', 'D:/stack/models/bge-m3-Q4_K_M.gguf'), 'D:/stack/models/bge-m3-Q4_K_M.gguf')
  // 配置里指的就是当前模型(可能放在别处)→ 尊重用户路径
  assert.equal(pickSpawnModel('bge-m3-Q4_K_M.gguf', 'D:/mine/bge-m3-Q4_K_M.gguf', 'D:/stack/models/bge-m3-Q4_K_M.gguf'), 'D:/mine/bge-m3-Q4_K_M.gguf')
  // 没有显式配置 → 用刚装好的
  assert.equal(pickSpawnModel('x.gguf', undefined, 'D:/stack/models/x.gguf'), 'D:/stack/models/x.gguf')
})
