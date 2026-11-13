/**
 * 按宿主硬件推荐模型与运行时(纯函数,零 I/O —— 便于用假硬件做测试)。
 *
 * 打分是**可解释**的:推荐结果旁边必须能说出"为什么是它",以及"为什么不是更大的那个"。
 * 面板直接显示 reason/warnings,所以这里输出的都是人话,不是分数。
 *
 * 规则(全部可测):
 *   质量 ×2  +  语言契合(中文环境优先中文/多语言)  +  速度契合(CPU 上惩罚大模型)
 *            +  上下文契合(≤512 截断扣分)  +  显存余量充足时的 +1(鼓励用大模型)
 *   装不下的候选不参与竞争,但仍列在 candidates 里并带上原因,面板可以解释清楚。
 */
import { EMBEDDING_MODELS, defaultVariant, type EmbeddingModel, type ModelVariant } from './models.ts'
import { MIN_USEFUL_VRAM_MB, type HostHardware, type RuntimeFlavor } from './hardware.ts'

/** 权重 1.15 ≈ 权重 + 运行时缓冲;再加一段固定开销给 KV/上下文。 */
export function estimateFootprintMb(bytes: number, onGpu: boolean): number {
  return Math.round((bytes / 1048576) * 1.15) + (onGpu ? 250 : 400)
}

/** 留给宿主与系统的余量:总内存的 60% 再扣 512MB。 */
export function usableRamMb(totalRamMb: number): number {
  return Math.max(512, Math.round(totalRamMb * 0.6) - 512)
}

/** 显存只用到 85%,留出驱动与碎片的空间。 */
export function usableVramMb(vramMb: number): number {
  return Math.round(vramMb * 0.85)
}

export function pickFlavor(hardware: HostHardware): RuntimeFlavor {
  return hardware.flavors[0] ?? 'cpu'
}

function languageFit(model: EmbeddingModel, chineseUi: boolean): number {
  if (chineseUi) return model.languages === 'zh' ? 3 : model.languages === 'multilingual' ? 2 : 0
  return model.languages === 'en' ? 2 : 2
}

function speedFit(model: EmbeddingModel, onGpu: boolean): number {
  // GPU 上速度差异不重要(整块在显存里),CPU 上 speed<=2 的模型是**每分钟级**的
  // 差别(4B/8B 每次检索要几秒),所以给很重的惩罚。
  if (onGpu) return 2
  return model.speed >= 5 ? 4 : model.speed === 4 ? 3 : model.speed === 3 ? 2 : model.speed === 2 ? -3 : -6
}

function contextFit(model: EmbeddingModel): number {
  return model.contextTokens >= 8192 ? 1 : model.contextTokens >= 1024 ? 0 : -1
}

export interface ScoredCandidate {
  modelId: string
  variantId: string
  label: string
  bytes: number
  footprintMb: number
  onGpu: boolean
  score: number
  /** 有值表示这台机器上装不下/不该选,内容是原因(仍列出来供面板解释)。 */
  blocked: string | null
}

export interface Recommendation {
  modelId: string
  variantId: string
  flavor: RuntimeFlavor
  reason: string[]
  warnings: string[]
  alternatives: Array<{ modelId: string; variantId: string; label: string; why: string }>
  candidates: ScoredCandidate[]
}

export interface RecommendationInput {
  hardware: HostHardware
  /** 宿主/系统语言,如 'zh-CN' —— 决定"中文优先"。 */
  locale: string
  /** 现有记忆条数:换模型要全部重嵌,必须提前告知。 */
  recordCount: number
  currentModelId?: string
}

function label(model: EmbeddingModel, variant: ModelVariant): string {
  return `${model.label} · ${variant.label}`
}

/** 磁盘文案:MB 就是 MB,不足 1GB 时不要显示成 "0GB"。 */
export function diskText(freeDiskMb: number): string {
  return freeDiskMb >= 1024 ? `${(freeDiskMb / 1024).toFixed(0)}GB` : `${freeDiskMb.toFixed(0)}MB`
}

export function recommendModel(input: RecommendationInput): Recommendation {
  const hw = input.hardware
  const chineseUi = input.locale.toLowerCase().startsWith('zh')
  const flavor = pickFlavor(hw)
  const gpuCapable = flavor === 'cuda' || flavor === 'vulkan' || flavor === 'metal'
  // 内存预算优先用「可用内存」：Android/Termux 上物理内存 15GB 而 LMK 下实际
  // 常只有 2–4GB，按 totalRamMb 算会推荐一个刚加载就被杀掉的模型。
  const ramBasis = hw.availableRamMb != null && hw.availableRamMb > 0
    ? Math.min(hw.totalRamMb, hw.availableRamMb)
    : hw.totalRamMb
  const ramBudget = usableRamMb(ramBasis)
  const vramBudget = hw.gpu?.vramMb != null ? usableVramMb(hw.gpu.vramMb) : 0

  const candidates: ScoredCandidate[] = []
  for (const model of EMBEDDING_MODELS) {
    for (const variant of model.variants) {
      const rawFootprint = estimateFootprintMb(variant.bytes, false)
      // 能整块放进显存才算"上了 GPU";否则仍然按内存算(只是跑得慢)。
      const onGpu = gpuCapable && vramBudget > 0 && estimateFootprintMb(variant.bytes, true) <= vramBudget
      const footprintMb = estimateFootprintMb(variant.bytes, onGpu)
      // 权重走 mmap,显存放得下时内存压力小得多,所以内存门槛按一半算(再加固定开销)。
      const ramNeed = onGpu ? Math.min(footprintMb, Math.round(footprintMb * 0.5) + 200) : footprintMb
      // 质量优先;速度只在 CPU 上参与(GPU 上恒为常数),上下文太短扣一分。
      const score = model.quality * 2 + languageFit(model, chineseUi) + speedFit(model, onGpu) + contextFit(model)
      let blocked: string | null = null
      if (ramNeed > ramBudget) {
        blocked = `约需 ${(ramNeed / 1024).toFixed(1)}GB 可用内存,当前可用约 ${(ramBudget / 1024).toFixed(1)}GB`
      } else if (hw.freeDiskMb !== null && hw.freeDiskMb < (variant.bytes / 1048576) * 1.2 + 800) {
        blocked = `磁盘剩余 ${(hw.freeDiskMb / 1024).toFixed(1)}GB 不够(模型约 ${(variant.bytes / 1048576 / 1024).toFixed(2)}GB)`
      }
      candidates.push({
        modelId: model.id, variantId: variant.id, label: label(model, variant),
        bytes: variant.bytes, footprintMb, onGpu, score, blocked,
      })
    }
  }

  const viable = candidates.filter((c) => c.blocked === null)
  // 一个都装不下时退到**体积最小**的那个(不是评分最高的:这台机器装不下任何模型,
  // 小一点才有可能装上),并把原因写进 warnings,而不是抛错。
  const ranked = (viable.length > 0
    ? viable.slice().sort((a, b) => b.score - a.score || a.bytes - b.bytes)
    : candidates.slice().sort((a, b) => a.bytes - b.bytes))
  const best = ranked[0]!

  const bestModel = EMBEDDING_MODELS.find((m) => m.id === best.modelId)!
  const reason: string[] = []
  const machine = [
    `${hw.cpuCount} 核`,
    hw.totalRamMb > 0 ? `${Math.round(hw.totalRamMb / 1024)}GB 内存` : null,
    hw.gpu !== null ? `显卡 ${hw.gpu.name}${hw.gpu.vramMb !== null ? `（${Math.round(hw.gpu.vramMb / 1024)}GB 显存）` : ''}` : '未检测到独立显卡',
    hw.freeDiskMb !== null ? `磁盘剩余 ${diskText(hw.freeDiskMb)}` : null,
  ].filter(Boolean).join(' · ')
  reason.push(`这台机器:${machine}`)
  reason.push(`推荐 ${best.label}:${bestModel.note}${best.onGpu ? ',可整块放进显存' : `,占用约 ${(best.footprintMb / 1024).toFixed(1)}GB 内存`}`)
  if (flavor === 'cuda') reason.push('运行时选 CUDA:检测到 NVIDIA 显卡与够新的驱动,llama.cpp 会把计算交给显卡')
  else if (flavor === 'vulkan') reason.push('运行时选 Vulkan:显卡可用且不需要 CUDA 环境,是最省事的加速方式')
  else if (flavor === 'metal') reason.push('运行时选 Metal:macOS 上 llama.cpp 默认走 Metal')
  else reason.push(`运行时选 CPU:没有检测到可用显卡,或显存不足 ${(MIN_USEFUL_VRAM_MB / 1024).toFixed(0)}GB`)
  if (chineseUi) reason.push('系统语言是中文:优先多语言/中文模型')

  const warnings: string[] = []
  if (input.recordCount > 0) {
    warnings.push(`换模型会让已存的 ${input.recordCount} 条记忆重新嵌入(向量作废重算),期间检索暂时退化为词法匹配`)
  }
  if (!viable.includes(best)) warnings.push('没有找到完全适配这台机器的模型,已退到体积最小的那个')
  if (flavor === 'cpu' && bestModel.speed <= 2) warnings.push('这个模型在 CPU 上每次检索要几秒;有显卡的话建议改用 Vulkan/CUDA 运行时')
  if (hw.gpu !== null && hw.gpu.vendor === 'nvidia' && (hw.gpu.driver === null || Number.parseInt(hw.gpu.driver.split('.')[0] ?? '', 10) < 550)) {
    warnings.push('NVIDIA 驱动版本读不到或偏旧,已按 Vulkan 推荐(CUDA 12.x 需要驱动 ≥ 550)')
  }
  if (flavor === 'vulkan' && hw.platform === 'linux') warnings.push('Linux 上 Vulkan 需要系统装了 Vulkan 驱动(通常 mesa-vulkan-drivers)')

  const alternatives = ranked.slice(1, 4).map((c) => {
    const model = EMBEDDING_MODELS.find((m) => m.id === c.modelId)!
    const sizeGb = (c.bytes / 1048576 / 1024).toFixed(2)
    const why = c.blocked !== null
      ? `装不了:${c.blocked}`
      : c.bytes > best.bytes
        ? `更大(${sizeGb}GB),质量略高但更吃内存`
        : `更小(${sizeGb}GB),更省内存${model.speed >= 4 ? '、更快' : ''}`
    return { modelId: c.modelId, variantId: c.variantId, label: c.label, why }
  })

  return {
    modelId: best.modelId,
    variantId: best.variantId,
    flavor,
    reason,
    warnings,
    alternatives,
    candidates,
  }
}

/** 面板/日志用:把推荐结果压成一行。 */
export function describeRecommendation(rec: Recommendation): string {
  const model = EMBEDDING_MODELS.find((m) => m.id === rec.modelId)
  const variant = model !== undefined ? (model.variants.find((v) => v.id === rec.variantId) ?? defaultVariant(model)) : undefined
  return variant !== undefined ? `${model!.label} · ${variant.label}（${rec.flavor}）` : `${rec.modelId}/${rec.variantId}（${rec.flavor}）`
}
