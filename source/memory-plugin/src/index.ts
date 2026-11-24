/**
 * @hanpu5838/dsh-memory —— 单入口插件(一个包,一条 Loader entry)。
 *
 * 为什么必须是一条 entry:
 *   宿主的 dsh-client-modules 只为「有活 Loader entry、且那条 entry 能解析到包名」
 *   的包提供 client bundle(reconcilePackage 要求一个包名只能有一个解析源,见
 *   "resolves from multiple active Loader sources")。而声明了 dsh.client 的包一旦
 *   被两个来源命中,整个客户端图组合就失败(fail-loud,桌面上表现为起不来)。
 *   所以「一个包 + 一个面板」的唯一稳定形态就是:一个包名,一条 entry,两侧都在。
 *   与 dshmarket 同形(1 包 / 1 行 / dsh.bundle + dsh.client)。
 *
 * 四个半边(provider / 模型工具 / 召回注入 / 面板服务端)都在这一行里组合,但各自
 * 独立降级:任何一半抛错都只写一行日志,绝不让 DSH 启动失败 —— 这是本仓库从第一版
 * 起就有的铁律,合并后由 part() 继续兜住。
 *
 * 每个半边的 apply 都是原样复用(不复制代码),它们的单元测试因此继续有效。
 */
import type { Context } from '@deepseek-ai/cordis'
import { apply as providerApply } from '../memory-local/src/apply.ts'
import type { MemoryLocalConfig } from '../memory-local/src/index.ts'
import { apply as toolsApply, type ToolMemoryConfig } from '../tool-memory/src/apply.ts'
import { apply as injectApply, type MemoryInjectConfig } from '../memory-inject/src/apply.ts'
import { apply as panelApply } from '../memory-panel/lib/index.js'
import { mountBundledSkills } from './skills.ts'

export const name = 'dsh-memory'

/**
 * 合并后的配置形态:provider 的配置保持在顶层(与既有文档、既有 profile 配置兼容),
 * 工具 / 注入 / 面板各自一个小节。原来靠「多条 entry 各自一个 config 块」实现的
 * 独立开关,现在由小节里的 enabled / defaultScope 表达。
 */
export interface MemoryPluginConfig extends MemoryLocalConfig {
  /** 模型工具:defaultScope('global' | 'project')与 projectScope(默认 project:<cwd>)。 */
  tools?: ToolMemoryConfig
  /** 自动召回注入。 */
  inject?: MemoryInjectConfig
  /** 面板服务端路由。 */
  panel?: { route?: string }
}

/** 跑一个半边:失败只记日志,不影响其它半边,也不影响宿主启动。 */
function part(ctx: Context, label: string, fn: () => void): void {
  try {
    fn()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[dsh-memory] ${label} 未能加载(已忽略,其余部分照常): ${message}`)
  }
}

export function apply(ctx: Context, config: MemoryPluginConfig = {}): void {
  // 1) provider:注册 ctx.memory(JSONL 存储 + 双通道检索 + 向量后端生命周期)。
  //    它是其余半边的前置:注册不成本插件时,工具会拿到 undefined 并明确报错,
  //    面板会显示「memory provider 未加载」,注入则静默跳过。
  part(ctx, 'provider', () => providerApply(ctx, config))

  // 2) 召回注入:自身惰性取 memory(ctx.get),所以不需要等待任何服务即可挂上。
  part(ctx, 'inject', () => injectApply(ctx, config.inject ?? {}))

  // 3) 面板服务端路由:内部 ctx.inject(['webServer']),没有 webServer 就只是没有 UI。
  part(ctx, 'panel', () => panelApply(ctx, config.panel ?? {}))

  // 4) 随包技能:记忆钩子的脚本 API 文档必须和代码同版本(0.35.0)。
  //    skills 服务由宿主核心提供,可能在本插件 apply 之后才提供 —— 用 ctx.inject
  //    等它就绪再挂,不能在 apply 里 `ctx.get('skills')` 一次性取样(取到 undefined
  //    就永久丢失,表现为「插件启用着但技能目录里没有」,重启或 toggle 才恢复)。
  //    和 tools 一样放在独立 inject 回调里:技能是增强,缺它绝不能把整条 entry
  //    拖成 PENDING(那会连 provider / 工具 / 面板一起起不来)。
  ctx.inject(['skills'], (c: Context) => {
    part(c, 'skills', () => mountBundledSkills(c as unknown as Parameters<typeof mountBundledSkills>[0]))
  })

  // 5) 模型工具:同时需要工具注册表与本插件提供的 memory 服务。
  //    用 ctx.inject 而不是模块级 inject —— 缺服务时只是这四个工具不出现,
  //    而不是让整条 entry 挂在 PENDING 上(那会连 provider 一起拖住)。
  ctx.inject(['tools', 'memory'], (c: Context) => {
    part(c, 'tools', () => toolsApply(c, config.tools ?? {}))
  })
}
