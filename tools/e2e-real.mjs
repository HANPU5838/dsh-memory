#!/usr/bin/env node
/**
 * 真实记忆库全链路验收（0.100.0）。
 *
 * 目的：`npm test` / `verify:all` 证明代码没坏，但证明不了「用户这台机器上的真实数据
 * 也能走通保存 → 召回 → 注入 → 审计」。本工具：
 *   ① 把真实 storeDir **复制**到临时目录（绝不改线上数据）；
 *   ② 在副本上加载真实作用域与记录，抽样内容做检索；
 *   ③ 渲染注入块、跑一次 MemoryInjector，确认链路能产出上下文；
 *   ④ 对副本跑 `doctor`，确认真实数据本身健康；
 *   ⑤ 输出 PASS/WARN/FAIL 与耗时，最后删除副本。
 *
 * 用法：
 *   npm run e2e:real                 # 默认 ~/.dsh-memory
 *   npm run e2e:real -- --store /path
 *
 * 退出码：硬失败（复制/检索/doctor FAIL）为 1；其余 0。
 */
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { LocalMemoryService } from '../source/memory-local/src/index.ts'
import { renderRecallBlock, defaultInjectConfig, MemoryInjector } from '../source/memory-inject/src/inject.ts'

const args = process.argv.slice(2)
const storeIndex = args.indexOf('--store')
const storeDir = storeIndex >= 0 && args[storeIndex + 1]
  ? args[storeIndex + 1]
  : (process.env.DSH_MEMORY_STORE || join(homedir(), '.dsh-memory'))

const checks = []
const add = (level, name, detail) => checks.push({ level, name, detail })
const fail = (name, detail) => add('fail', name, detail)
const ok = (name, detail) => add('ok', name, detail)

const started = Date.now()
const copy = mkdtempSync(join(tmpdir(), 'dsh-e2e-real-'))
let svc
try {
  // ① 复制真实库（只读验收，不动线上数据）
  try {
    cpSync(storeDir, copy, { recursive: true })
    ok('复制真实库', `${storeDir} → 临时副本`)
  } catch (error) {
    fail('复制真实库', error instanceof Error ? error.message : String(error))
    throw error
  }

  // ② 加载副本
  svc = new LocalMemoryService({
    storeDir: copy,
    scopes: { global: true, project: true, session: true, custom: true },
    retrieval: { vector: { enabled: false } },
  })
  const stats = svc.scopeStats()
  const records = stats.reduce((sum, entry) => sum + entry.records, 0)
  const health = svc.healthReport()
  ok('加载真实作用域', `${stats.length} 个作用域 / ${records} 条记录 / 健康度 ${health.score}`)
  if (records === 0) {
    add('warn', '记录为空', '真实库没有记录，跳过检索抽样')
  } else {
    // ③ 抽样真实内容做检索
    const allScopes = stats.map((entry) => entry.scope)
    const listed = await svc.list({ scopes: allScopes, limit: 200 })
    const sample = listed.filter((record) => typeof record.content === 'string' && record.content.trim().length >= 8).slice(0, 5)
    let searched = 0
    let hitsTotal = 0
    let selfHits = 0
    let renderLines = 0
    let injectedIds = 0
    for (const record of sample) {
      const query = record.content.replace(/\s+/g, ' ').slice(0, 24)
      try {
        const hits = await svc.search({ text: query, topK: 5, scopes: allScopes })
        searched += 1
        hitsTotal += hits.length
        if (hits.some((hit) => hit.record.id === record.id)) selfHits += 1
        if (renderLines === 0 && hits.length > 0) {
          const block = renderRecallBlock(hits, defaultInjectConfig, { impression: false })
          renderLines = block === null ? 0 : block.text.split('\n').length
          // ④ 跑一次真实 MemoryInjector（与 apply 层同一构造函数）
          const injector = new MemoryInjector((text) => svc.search({ text, topK: 5, scopes: allScopes }), defaultInjectConfig)
          const detailed = await injector.maybeInjectDetailed(
            { messages: [{ role: 'user', content: [{ type: 'text', text: query }] }] },
            { messages: [] },
          )
          injectedIds = detailed?.ids.length ?? 0
        }
      } catch (error) {
        fail('真实检索', `${query}：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    ok('真实内容检索', `${searched} 条查询 / ${hitsTotal} 条命中 / 自命中 ${selfHits} 条`)
    if (renderLines === 0) add('warn', '注入渲染', '抽样命中为空，未渲染注入块')
    else ok('注入渲染', `${renderLines} 行注入块 / 注入器接受 ${injectedIds} 条`)
  }

  // ⑤ 对副本跑 doctor（真实数据健康）
  try {
    execFileSync(process.execPath, ['--experimental-strip-types', join(import.meta.dirname, 'doctor.mjs'), '--store', copy], {
      encoding: 'utf8',
      timeout: 120_000,
      stdio: 'pipe',
    })
    ok('真实数据体检（doctor）', 'PASS')
  } catch (error) {
    const out = String(error && error.stdout ? error.stdout : '').split('\n').filter((line) => line.startsWith('✗') || line.startsWith('结论')).join(' | ')
    fail('真实数据体检（doctor）', out || 'doctor 退出码非 0')
  }
} finally {
  try { svc?.flushSync() } catch { /* 副本，失败无所谓 */ }
  rmSync(copy, { recursive: true, force: true })
}

const icon = { ok: '✓', warn: '⚠', fail: '✗' }
const elapsed = ((Date.now() - started) / 1000).toFixed(1)
console.log(`\nDSH 记忆系统 · 真实库全链路验收（${storeDir}）\n`)
for (const check of checks) console.log(`${icon[check.level]} ${check.name}：${check.detail}`)
const fails = checks.filter((check) => check.level === 'fail').length
const warns = checks.filter((check) => check.level === 'warn').length
console.log(`\n结论：${fails > 0 ? 'FAIL' : warns > 0 ? 'WARN' : 'PASS'}（${checks.length - fails - warns} ok / ${warns} warn / ${fails} fail，${elapsed}s）\n`)
process.exit(fails > 0 ? 1 : 0)
