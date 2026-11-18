#!/usr/bin/env node
/**
 * 记忆库自检（0.89.0）——「一键体检」，只读不写。
 *
 * 回答一个问题：*这个记忆库现在健康吗？* 逐项检查最容易悄悄坏掉的角落：
 *   ① 数据文件：JSONL 损坏行、作用域文件数、记录总数；
 *   ② 元数据：settings.json 是否损坏 / 是否缺少新设置键（缺键 = 默认值生效，属提示级）；
 *   ③ 健康度：0-100 分、冲突率、重复率、失效/休眠/隔离/待嵌入；
 *   ④ 冲突中心：带冲突标记的活记录数；
 *   ⑤ 规则代码：钩子数量、是否有待审批、最近是否有崩溃；
 *   ⑥ 向量服务：默认端点健康检查（不可达只提示，不算失败）；
 *   ⑦ 备份：备份文件数量。
 *
 * 用法：
 *   npm run doctor                    # 体检 ~/.dsh-memory
 *   npm run doctor -- --store /path   # 指定其它库
 *
 * 退出码：有 ✗（数据损坏级）→ 1；否则 0。全程只读，不触发迁移/修复。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService } from '../source/memory-local/src/index.ts'

const args = process.argv.slice(2)
const storeIndex = args.indexOf('--store')
const storeDir = storeIndex >= 0 && args[storeIndex + 1]
  ? args[storeIndex + 1]
  : (process.env.DSH_MEMORY_STORE || join(homedir(), '.dsh-memory'))

const checks = []
const add = (level, name, detail, hint) => checks.push({ level, name, detail, ...(hint ? { hint } : {}) })
const pct = (value) => `${(Number(value) * 100).toFixed(1)}%`

// ① 数据文件级检查（直接读盘，不依赖服务）
let malformed = 0
let malformedSamples = []
let recordLines = 0
let scopeFiles = 0
const projectsDir = join(storeDir, 'projects')
if (!existsSync(storeDir)) {
  add('fail', '记忆库目录', `不存在：${storeDir}`, '确认 storeDir 配置；首次使用会创建。')
} else {
  add('ok', '记忆库目录', storeDir)
  // 作用域文件只有两处：global.jsonl 在库根目录，其余作用域在 projects/ 下。
  // 根目录还有 approvals.jsonl 等**其它格式**的旁路日志，不能按记忆记录校验。
  const scopeFilesOnDisk = []
  if (existsSync(join(storeDir, 'global.jsonl'))) scopeFilesOnDisk.push(join(storeDir, 'global.jsonl'))
  if (existsSync(projectsDir)) {
    for (const file of readdirSync(projectsDir)) {
      if (file.endsWith('.jsonl')) scopeFilesOnDisk.push(join(projectsDir, file))
    }
  }
  for (const path of scopeFilesOnDisk) {
    const file = path.slice(path.lastIndexOf('/') + 1)
    scopeFiles += 1
    let text = ''
    try { text = readFileSync(path, 'utf8') } catch { add('fail', '数据文件读取', `读不了 ${path}`); continue }
    let lineNo = 0
    for (const line of text.split('\n')) {
      lineNo += 1
      const trimmed = line.trim()
      if (!trimmed) continue
      recordLines += 1
      try {
        const rec = JSON.parse(trimmed)
        if (!rec || typeof rec.id !== 'string' || typeof rec.content !== 'string' || typeof rec.scope !== 'string') throw new Error('bad shape')
      } catch {
        malformed += 1
        if (malformedSamples.length < 3) malformedSamples.push(`${file}:${lineNo}`)
      }
    }
  }
  add(malformed === 0 ? 'ok' : 'fail', 'JSONL 完整性',
    malformed === 0 ? `${scopeFiles} 个作用域文件 / ${recordLines} 行记录，全部可解析` : `${malformed} 行损坏（${malformedSamples.join('、')}）`,
    malformed === 0 ? undefined : '损坏行会被加载器跳过；建议备份后手工修复或让维护任务重写。')
  if (scopeFiles === 0) add('warn', '作用域数据', '库里还没有任何 JSONL 记录（空库或尚未初始化）')
  // ⑦ 备份（0.107.0：超过保留上限只提示，不自动删）
  const backupDir = join(storeDir, 'backups')
  const backups = existsSync(backupDir) ? readdirSync(backupDir).filter((f) => f.endsWith('.jsonl.gz')) : []
  add(backups.length <= 20 ? 'ok' : 'warn', '备份',
    backups.length === 0 ? '暂无备份（面板「维护 → 立即备份」可创建）' : `${backups.length} 个本地备份`,
    backups.length <= 20 ? undefined : '备份超过 20 份：备份为纯手动策略，插件不会自动创建/删除；可手动清理 backups/ 或显式调用 pruneBackups。')
  // ⑦b 审批旁路日志大小（0.107.0 起自动轮转，这里只做可见性检查）
  try {
    const approvalsLog = join(storeDir, 'approvals.jsonl')
    if (existsSync(approvalsLog)) {
      const bytes = statSync(approvalsLog).size
      add(bytes <= 5 * 1024 * 1024 ? 'ok' : 'warn', '审批日志',
        `${(bytes / 1024).toFixed(0)} KB`,
        bytes <= 5 * 1024 * 1024 ? undefined : '超过 5MB：下次审批写入会自动轮转保留最近 2000 行。')
    }
  } catch { /* 读不到不影响其它检查 */ }
  // ② settings.json
  const settingsPath = join(storeDir, 'settings.json')
  if (!existsSync(settingsPath)) {
    // 全新库没有 settings.json 是正常状态（= 全部默认值），不算问题。
    add('ok', 'settings.json', '不存在（全部使用默认设置）')
  } else {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
      const missing = []
      if (settings.impression?.dynamic === undefined) missing.push('impression.dynamic')
      if (settings.graph === undefined) missing.push('graph')
      add(missing.length === 0 ? 'ok' : 'warn', 'settings.json',
        missing.length === 0 ? '可解析，新设置键齐全' : `缺少 ${missing.join(' / ')}（默认值仍在生效）`,
        missing.length === 0 ? undefined : '在面板「设置」里改动一次即可落盘；不影响功能。')
    } catch (error) {
      add('fail', 'settings.json', `解析失败：${error instanceof Error ? error.message : String(error)}`, '备份后删除该文件可回到默认设置。')
    }
  }
}

// ② ~ ⑥ 服务层检查（只读；禁用向量自举避免副作用）
try {
  const svc = new LocalMemoryService({
    storeDir,
    scopes: { global: true, project: true, session: true, custom: true },
    retrieval: { vector: { enabled: false, autoBootstrap: 'off' } },
  })
  try {
    const stats = svc.scopeStats()
    const records = stats.reduce((sum, item) => sum + item.records, 0)
    const pending = stats.reduce((sum, item) => sum + item.pendingEmbeds, 0)
    add(pending === 0 ? 'ok' : 'warn', '记录与向量', `${records} 条记录 / ${stats.length} 个作用域 / ${pending} 条待嵌入`,
      pending === 0 ? undefined : '向量服务恢复后会自动回填；纯词法模式可忽略。')
    const health = svc.healthReport()
    add(health.score >= 80 ? 'ok' : health.score >= 60 ? 'warn' : 'fail', '健康度',
      `${health.score}/100（活跃 ${health.live} · 休眠 ${health.dormant} · 失效 ${health.invalid} · 软删 ${health.tombstoned} · 冲突 ${health.conflicted} · 隔离 ${health.quarantined}）`,
      health.score >= 80 ? undefined : '看面板「服务 → 记忆健康」与冲突中心定位原因。')
    if (health.duplicateSampled > 0) add('ok', '重复率', `${pct(health.duplicateRate)}（抽样 ${health.duplicateSampled} 个锚点）`)
    const conflicts = svc.listConflicts()
    add(conflicts.length === 0 ? 'ok' : 'warn', '冲突中心', conflicts.length === 0 ? '没有待裁决冲突' : `${conflicts.length} 条带冲突标记`,
      conflicts.length === 0 ? undefined : '面板「关系分析 → 冲突中心」可自动/逐条裁决。')
    const hooks = svc.listHooks()
    const settings = svc.hookSettings()
    const pendingHooks = hooks.filter((hook) => svc.hookPendingApproval(hook.id)).length
    add(pendingHooks === 0 ? 'ok' : 'warn', '规则代码',
      `钩子 ${hooks.length} 个（${settings.enabled ? '启用' : '停用'}）${pendingHooks > 0 ? `，${pendingHooks} 个待审批` : ''}`,
      pendingHooks === 0 ? undefined : '面板「规则代码」逐行审查后批准；未批准不会执行。')
  } finally {
    try { svc.flushSync() } catch { /* 只读体检，flush 失败不影响结论 */ }
  }
} catch (error) {
  add('fail', '服务层', `初始化失败：${error instanceof Error ? error.message : String(error)}`)
}

// ⑥ 向量服务可达性（只提示）
try {
  const response = await fetch('http://127.0.0.1:8078/health', { signal: AbortSignal.timeout(1500) })
  const body = await response.json()
  add('ok', '向量服务', `127.0.0.1:8078 → ${body.status ?? response.status}`)
} catch {
  add('warn', '向量服务', '127.0.0.1:8078 不可达（纯词法模式仍可用）', '面板「服务 → 向量服务」可安装/启动。')
}

// 输出
const icon = { ok: '✓', warn: '⚠', fail: '✗' }
console.log(`\nDSH 记忆系统 · 自检（${storeDir}）\n`)
for (const check of checks) {
  console.log(`${icon[check.level]} ${check.name}：${check.detail}`)
  if (check.hint) console.log(`   ↳ ${check.hint}`)
}
const fails = checks.filter((check) => check.level === 'fail').length
const warns = checks.filter((check) => check.level === 'warn').length
console.log(`\n结论：${fails > 0 ? 'FAIL' : warns > 0 ? 'WARN' : 'PASS'}（${checks.length - fails - warns} ok / ${warns} warn / ${fails} fail）\n`)
process.exit(fails > 0 ? 1 : 0)
