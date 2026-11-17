/**
 * 随包技能:`skills/<name>/SKILL.md` → 注册表候选。
 *
 * 为什么随包发而不是写进用户目录:记忆钩子的脚本 API(入口函数名、沙箱能力、
 * 返回约定)是**这个插件的**约定,必须和代码同版本、同一次安装。写进
 * `~/.agents/skills` 就成了"另一份需要单独维护的副本",改代码忘了改文档。
 *
 * 注册成 provider 而不是 runtime skill:技能带 `references/examples.md`
 * 这类资源文件,只有 `resourceBase` 能让模型解析相对路径(见 skill-authoring
 * 的 plugin-bundled 说明)。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 随包技能目录(产物里是 `<pkg>/skills/`,源码树里是 `source/memory-plugin/skills/`)。 */
const SKILLS_ROOT = fileURLToPath(new URL('../skills/', import.meta.url))

/** 与 `@deepseek-ai/dsh-skill` 的 BUNDLED_SKILL_RANK 对齐:项目 / 用户技能可以覆盖它。 */
const BUNDLED_SKILL_RANK = 600

/** provider 名必须是本包名的一部分,且不能是保留字 `runtime`。 */
const PROVIDER = 'dsh-memory'

interface SkillCandidate {
  name: string
  description: string
  invocation: { modelInvocable: boolean; userInvocable: boolean }
  provider: string
  source: string
  rank: number
  resourceBase: { kind: 'directory'; path: string }
  locator: string
  path: string
}

/** 取 frontmatter 里某个单行字段(只处理 `key: value` / `key: "value"`)。 */
function frontmatterField(text: string, key: string): string | undefined {
  if (!text.startsWith('---')) return undefined
  const end = text.indexOf('\n---', 3)
  if (end < 0) return undefined
  const block = text.slice(3, end)
  for (const line of block.split(/\r?\n/)) {
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (match === null || match[1] !== key) continue
    let value = match[2]!.trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    return value.trim() === '' ? undefined : value
  }
  return undefined
}

/** frontmatter 之后的部分。 */
function skillBody(text: string): string {
  if (!text.startsWith('---')) return text.trim()
  const end = text.indexOf('\n---', 3)
  if (end < 0) return text.trim()
  const after = text.indexOf('\n', end + 1)
  return (after < 0 ? '' : text.slice(after + 1)).trim()
}

/**
 * 读一个技能目录成候选。**这里就把错误抛出来**:注册表要求候选合法,否则整批
 * 观察失败;宁可启动时看见一行明确日志,也不要"技能悄悄不存在"。
 */
function candidateFor(name: string): SkillCandidate {
  const directory = join(SKILLS_ROOT, name)
  const path = join(directory, 'SKILL.md')
  const text = readFileSync(path, 'utf8')
  const description = frontmatterField(text, 'description')
  if (description === undefined) {
    throw new Error(`随包技能 "${name}" 的 SKILL.md 缺少 description:${path}`)
  }
  return {
    name,
    description,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: PROVIDER,
    source: 'bundled',
    rank: BUNDLED_SKILL_RANK,
    resourceBase: { kind: 'directory', path: directory },
    locator: path,
    path,
  }
}

/** 磁盘上实际存在的技能名(目录里有 SKILL.md 的)。 */
function skillNames(): string[] {
  try {
    if (!existsSync(SKILLS_ROOT)) return []
    return readdirSync(SKILLS_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(SKILLS_ROOT, entry.name, 'SKILL.md')))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * 注册随包技能。失败只记一行日志:技能资产出问题不该把记忆插件(含工具与面板)
 * 一起带下水 —— 与仓库"任何半边抛错只写一行日志"的铁律一致。
 */
export function mountBundledSkills(ctx: {
  skills?: { registerProvider?: (factory: () => unknown) => unknown }
  get?: (name: string) => unknown
  effect?: (run: () => unknown, label?: string) => unknown
  logger?: { warn?: (message: string) => void }
}): void {
  // 0.35.1 修复：调用方现在通过 ctx.inject(['skills'], scope => ...) 在服务**就绪后**
  // 才进来，所以这里拿到的 ctx 就是已注入的 scope，skills 一定在。
  // 保留 ctx.get 兜底是为了兼容仍在 apply 里直接调用它的老路径（测试 / 独立加载）。
  let skills: { registerProvider?: (factory: () => unknown) => unknown } | undefined
  try {
    skills = (ctx.skills ?? ctx.get?.('skills')) as typeof skills | undefined
  } catch {
    skills = undefined
  }
  if (skills === undefined || typeof skills.registerProvider !== 'function') {
    ctx.logger?.warn?.('dsh-memory: skills 服务尚未就绪，随包技能未注册（记忆功能不受影响）')
    return
  }

  const names = skillNames()
  if (names.length === 0) {
    ctx.logger?.warn?.(`dsh-memory: 没找到随包技能目录 ${SKILLS_ROOT}`)
    return
  }

  const build = (): { name: string; list: () => Promise<SkillCandidate[]>; get: (winner: SkillCandidate) => Promise<unknown> } => {
    const candidates = names.map(candidateFor)
    const byName = new Map(candidates.map((candidate) => [candidate.name, candidate]))
    return {
      name: PROVIDER,
      list: () => Promise.resolve(candidates),
      // 正文每次现读:改 SKILL.md 下一次加载就生效(注册表只缓存目录)。
      get: (winner: SkillCandidate) => {
        const known = byName.get(winner?.name)
        if (known === undefined) throw new Error(`随包技能 "${String(winner?.name)}" 不存在`)
        const { rank: _rank, locator: _locator, ...summary } = known
        return Promise.resolve({ ...summary, content: skillBody(readFileSync(known.path, 'utf8')) })
      },
    }
  }

  try {
    if (typeof ctx.effect === 'function') ctx.effect(() => skills!.registerProvider!(build), 'dsh-memory: bundled skills')
    else skills.registerProvider(build)
  } catch (error) {
    ctx.logger?.warn?.(`dsh-memory: 随包技能未能注册:${error instanceof Error ? error.message : String(error)}`)
  }
}
