/**
 * 会话作用域 / 自定义作用域 / 多 scope 合并 的服务层与工具层测试(0.5.0)。
 *
 * 覆盖的是 0.5.0 的核心承诺:
 *   - 写入默认落"当前会话",拿不到会话回退项目 scope(绝不报错);
 *   - 自定义 scope 首次写入才落盘,读路径绝不创建文件;
 *   - 作用域被删空后不再留空文件(0.5.1),下次写入重新创建;
 *   - scopes.custom.max 只管自定义 scope,会话/project/global 不受限;
 *   - 默认检索 = 会话 + 项目 + global 合并去重;'all' 跨全部;
 *   - 旧文件(projects/<sha1>.jsonl + project:<cwd>)照常读写。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService } from '../src/index.ts'
import { memoryTools } from '../../tool-memory/src/index.ts'

const PROJECT = 'project:/w'
const SESSION = 'session:sess-1'
const SESSION2 = 'session:sess-2'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-memory-scopes-'))
}

function newService(dir, extra = {}) {
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true, project: true }, ...extra })
  svc.setDefaultScope('session')
  svc.setProjectScope(PROJECT)
  // 0.20.0 起默认可见域是「会话 + 项目 + global」+ 普通限制:跨到自定义作用域的读写
  // 会等用户审批。这组测试只考察作用域解析,统一让审批「允许一次」,避免每个用例挂 5 分钟。
  svc.requestOutOfScope = async () => 'allowed-once'
  return svc
}

/** agent 上下文的最小形态(宿主里就是 agent.session.header)。 */
const agent = (id, extra = {}) => ({ session: { header: { id, ...extra } } })

function toolsFor(svc) {
  const tools = memoryTools({ getService: () => svc as never, defaultScope: 'session', projectScope: PROJECT })
  // 0.22.0 起「普通限制」下 memory_* 必须带 description;这组测试只考察作用域解析,
  // 统一补一条说明(description 的强制行为在 tool-memory 的单测里覆盖)。
  for (const spec of Object.values(tools)) {
    const run = spec.execute.bind(spec)
    spec.execute = (args, exec) => run({ description: '测试调用：作用域解析', ...args }, exec)
  }
  return tools
}

function projectFiles(dir) {
  const p = join(dir, 'projects')
  return existsSync(p) ? readdirSync(p) : []
}

// ------------------------------------------------------------------ 写入默认 / 回退

test('save 默认落当前会话;拿不到会话时回退项目 scope 且不抛错', async () => {
  const dir = tempDir()
  const svc = newService(dir)
  try {
    const tools = toolsFor(svc)
    const inSession = await tools.memory_save.execute({ content: '会话内的一条' }, { agent: agent('sess-1') })
    assert.equal(inSession.scope, SESSION)
    const noAgent = await tools.memory_save.execute({ content: '没有 agent 上下文的一条' })
    assert.equal(noAgent.scope, PROJECT, '拿不到会话 → project')
    const brokenAgent = await tools.memory_save.execute({ content: 'agent 形态意外' }, { agent: { session: {} } })
    assert.equal(brokenAgent.scope, PROJECT)
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scopes.session=false 时写回退项目 scope', async () => {
  const dir = tempDir()
  const svc = newService(dir, { scopes: { global: true, project: true, session: false } })
  try {
    const tools = toolsFor(svc)
    const saved = await tools.memory_save.execute({ content: '会话被关掉' }, { agent: agent('sess-1') })
    assert.equal(saved.scope, PROJECT)
    // 显式写一个会话 scope 才报 SCOPE_DISABLED(省略/裸 'session' 是回退,不是报错)
    await assert.rejects(
      () => svc.save({ scope: SESSION, kind: 'note', content: '显式写会话' }),
      (e: Error & { code?: string }) => e.code === 'SCOPE_DISABLED',
    )
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scope:project 按会话 cwd 落点,而不是 process.cwd()/配置(0.5.6 回归)', async () => {
  const dir = tempDir()
  // 服务端固定了 project:/w,但调用方带着会话 cwd 来 → 必须跟工作区走。
  // 0.5.5 及以前两层各自算了一份 project:<process.cwd()>,于是"当前项目"被钉成 DSH 服务
  // 进程的 cwd(= profile 目录),该 profile 下所有项目挤进同一个桶。
  const svc = newService(dir, { scopes: { global: true, project: true, custom: { enabled: true } } })
  try {
    const tools = toolsFor(svc)
    const withCwd = agent('sess-cwd', { cwd: '/work/repo' })
    const saved = await tools.memory_save.execute({ content: '关于这个仓库的一条', scope: 'project' }, { agent: withCwd })
    assert.equal(saved.scope, 'project:/work/repo', 'scope:project 必须解析成会话 cwd')

    // 工具层解析出来的键 == 服务端自己的解析(两层口径必须同一处)
    assert.equal(svc.projectKeyFor(withCwd), 'project:/work/repo')
    // 落盘也在那个 key 下(只写到一个文件,不落到固定的 project:/w)
    svc.store.flush()
    assert.ok(existsSync(join(dir, 'projects', `${createHash('sha1').update('project:/work/repo').digest('hex')}.jsonl`)))
    assert.equal(svc.store.peek('project:/work/repo')?.records.size, 1)
    // 没有 cwd 时仍然回退到配置的 project:/w(不把显式配置废掉)
    const noCwd = await tools.memory_save.execute({ content: '没有 cwd 的一条', scope: 'project' }, { agent: agent('sess-2') })
    assert.equal(noCwd.scope, PROJECT)
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('子代理会话映射到父会话 key(共享父会话的记忆)', async () => {
  const dir = tempDir()
  const svc = newService(dir)
  try {
    const tools = toolsFor(svc)
    const sub = await tools.memory_save.execute(
      { content: '子代理记的东西' },
      { agent: agent('sub-9', { origin: 'subagent', parentSession: 'parent-3' }) },
    )
    assert.equal(sub.scope, 'session:parent-3')
    const hits = await svc.search({ text: '子代理记的东西', scopes: ['session:parent-3', PROJECT, 'global'] })
    assert.equal(hits.length, 1)
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------------ 自定义 scope

test('自定义 scope:首次写入落盘,重启后能被 peek 读到', async () => {
  const dir = tempDir()
  const svc = newService(dir)
  try {
    svc.store.flush()
    const before = projectFiles(dir).length
    await svc.save({ scope: 'my notes', kind: 'note', content: '自定义作用域里的一条' })
    svc.store.flush()
    assert.equal(projectFiles(dir).length, before + 1, '首次写入才创建文件')

    const reopened = newService(dir)
    try {
      assert.equal(reopened.store.peek('my notes')?.records.size, 1, 'peek 能从磁盘读回自定义 scope')
      const records = await reopened.list({ scope: 'my notes' })
      assert.equal(records.length, 1)
      assert.equal(records[0]!.content, '自定义作用域里的一条')
    } finally {
      reopened.flushSync()
    }
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('读不存在的 scope 不创建文件、不进 allScopes、返回空', async () => {
  const dir = tempDir()
  const svc = newService(dir)
  try {
    svc.store.flush()
    const filesBefore = projectFiles(dir).length
    assert.deepEqual(await svc.list({ scope: 'nope' }), [])
    assert.deepEqual(await svc.search({ text: 'anything', scope: 'nope' }), [])
    assert.deepEqual(svc.store.allScopes(), [], 'peek 不该把不存在的 scope 加进来')
    assert.equal(svc.store.peek('session:sess-x'), undefined)
    assert.equal(projectFiles(dir).length, filesBefore, '磁盘上不该出现新文件')
    await assert.rejects(
      () => svc.forget({ query: 'anything', scope: 'nope' }),
      (e: Error & { code?: string }) => e.code === 'RECORD_NOT_FOUND',
    )
    assert.equal(projectFiles(dir).length, filesBefore, 'forget 读路径也不创建')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scopes.custom.max:达到上限后拒绝新建,但仍可写已存在的;会话 scope 不受限', async () => {
  const dir = tempDir()
  const svc = newService(dir, { scopes: { global: true, project: true, custom: { enabled: true, max: 2 } } })
  try {
    await svc.save({ scope: 'one', kind: 'note', content: 'a' })
    await svc.save({ scope: 'two', kind: 'note', content: 'b' })
    // 已存在的自定义 scope 继续写,不受限
    await svc.save({ scope: 'one', kind: 'note', content: 'a2' })
    await assert.rejects(
      () => svc.save({ scope: 'three', kind: 'note', content: 'c' }),
      (e: Error & { code?: string }) => e.code === 'SCOPE_LIMIT',
    )
    // 会话与项目 scope 既不计入也不受限
    await svc.save({ scope: SESSION, kind: 'note', content: 'session ok' })
    await svc.save({ scope: SESSION2, kind: 'note', content: 'session2 ok' })
    await svc.save({ scope: PROJECT, kind: 'note', content: 'project ok' })
    await svc.save({ scope: 'global', kind: 'note', content: 'global ok' })
    assert.equal(svc.store.customScopeCount(), 2)

    // 重启后计数依然来自磁盘(不能只数内存)
    svc.store.flush()
    const reopened = newService(dir, { scopes: { global: true, project: true, custom: { enabled: true, max: 2 } } })
    try {
      await assert.rejects(
        () => reopened.save({ scope: 'four', kind: 'note', content: 'd' }),
        (e: Error & { code?: string }) => e.code === 'SCOPE_LIMIT',
      )
    } finally {
      reopened.flushSync()
    }
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scopes.custom.enabled=false 时自定义 scope 写被拒(旧配置布尔简写也认)', async () => {
  const dir = tempDir()
  const svc = newService(dir, { scopes: { global: true, project: true, custom: false } })
  const svc2 = newService(dir, { scopes: { global: true, project: true, custom: { enabled: false } } })
  try {
    for (const s of [svc, svc2]) {
      await assert.rejects(
        () => s.save({ scope: 'blocked', kind: 'note', content: 'x' }),
        (e: Error & { code?: string }) => e.code === 'SCOPE_DISABLED',
      )
    }
  } finally {
    svc.flushSync()
    svc2.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------------ 检索 / 列表 / 遗忘

test('默认检索合并会话 + 项目 + global,并按 record id 去重', async () => {
  const dir = tempDir()
  const svc = newService(dir)
  try {
    svc.store.flush()
    await svc.save({ scope: SESSION, kind: 'note', content: 'postgres 索引优化 会话版' })
    await svc.save({ scope: PROJECT, kind: 'note', content: 'postgres 索引优化 项目版' })
    await svc.save({ scope: 'global', kind: 'note', content: 'postgres 索引优化 全局版' })
    await svc.save({ scope: 'other', kind: 'note', content: 'postgres 索引优化 别的作用域' })
    const tools = toolsFor(svc)
    const res = await tools.memory_search.execute({ query: 'postgres 索引优化', topK: 20 }, { agent: agent('sess-1') })
    const scopes = res.records.map((r) => r.scope).sort()
    assert.deepEqual(scopes, [PROJECT, SESSION, 'global'].sort(), '默认三路合并,不含其它自定义 scope')
    assert.equal(new Set(res.records.map((r) => r.id)).size, res.records.length, '不重复')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scope:all 跨全部已发现 scope;范围外只给索引,显式审批后可读', async () => {
  const dir = tempDir()
  const svc = newService(dir)
  try {
    svc.store.flush()
    await svc.save({ scope: SESSION, kind: 'note', content: 'sqlite 迁移 会话' })
    await svc.save({ scope: 'handbook', kind: 'note', content: 'sqlite 迁移 手册' })
    const tools = toolsFor(svc)
    // 0.27.0:范围外命中默认不弹审批,只回索引(withheld=out-of-scope)。
    const all = await tools.memory_search.execute({ query: 'sqlite 迁移', scope: 'all' }, { agent: agent('sess-1') })
    assert.deepEqual(all.records.map((r) => r.scope), [SESSION])
    assert.deepEqual(all.outOfScope?.scopes.map((entry) => [entry.scope, entry.records]), [['handbook', 1]])
    assert.deepEqual(all.withheld, { count: 1, reason: 'out-of-scope' })
    // 显式要求审批(0.26 及以前的行为):provider 的 mock 放行 → 命中并入 records。
    const approved = await tools.memory_search.execute(
      { query: 'sqlite 迁移', scope: 'all', requestApproval: true },
      { agent: agent('sess-1') },
    )
    assert.deepEqual(approved.records.map((r) => r.scope).sort(), [SESSION, 'handbook'].sort())
    const pinned = await tools.memory_search.execute(
      { query: 'sqlite 迁移', scope: 'handbook', requestApproval: true },
      { agent: agent('sess-1') },
    )
    assert.deepEqual(pinned.records.map((r) => r.scope), ['handbook'])
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('同分时稳定 tie-break:session 优先于 global', async () => {
  const dir = tempDir()
  const svc = newService(dir)
  try {
    svc.store.flush()
    await svc.save({ scope: 'global', kind: 'note', content: '索引设计原则' })
    await svc.save({ scope: SESSION, kind: 'note', content: '索引设计原则' })
    const hits = await svc.search({ text: '索引设计原则', scopes: [SESSION, 'global'] })
    assert.equal(hits.length, 2)
    assert.equal(hits[0]!.record.scope, SESSION, '同分时会话排前面')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('forget({query}) 默认只作用于当前会话;"all"+query 被拒', async () => {
  const dir = tempDir()
  const svc = newService(dir)
  try {
    await svc.save({ scope: SESSION, kind: 'note', content: '临时凭据 会话' })
    await svc.save({ scope: PROJECT, kind: 'note', content: '临时凭据 项目' })
    const tools = toolsFor(svc)
    const out = await tools.memory_forget.execute({ query: '临时凭据' }, { agent: agent('sess-1') })
    assert.equal(out.removed, 1, '只删会话里那条')
    assert.equal((await svc.list({ scope: PROJECT })).length, 1, '项目那条必须还在')
    await assert.rejects(
      () => tools.memory_forget.execute({ query: '临时凭据', scope: 'all' }, { agent: agent('sess-1') }),
      (e: Error & { code?: string }) => e.code === 'SCOPE_NOT_WRITABLE',
    )
    // 显式 scope 才跨出会话
    const out2 = await tools.memory_forget.execute({ query: '临时凭据', scope: 'project' }, { agent: agent('sess-1') })
    assert.equal(out2.removed, 1)
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('memory_list 默认只列当前会话,并带上作用域清单', async () => {
  const dir = tempDir()
  const svc = newService(dir)
  try {
    await svc.save({ scope: SESSION, kind: 'note', content: '会话里的' })
    await svc.save({ scope: PROJECT, kind: 'note', content: '项目里的' })
    const tools = toolsFor(svc)
    const res = await tools.memory_list.execute({}, { agent: agent('sess-1') })
    assert.deepEqual(res.records.map((r) => r.scope), [SESSION], '默认只列当前会话')
    assert.ok(Array.isArray(res.scopeStats) && res.scopeStats.length >= 2, '带作用域清单')
    const all = await tools.memory_list.execute({ scope: 'all' }, { agent: agent('sess-1') })
    assert.deepEqual(all.records.map((r) => r.scope).sort(), [PROJECT, SESSION].sort())
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('store.save 绝不把 agent 上下文写进记录(落盘 JSONL 与返回的 record 都没有 agent)', async () => {
  const dir = tempDir()
  const svc = newService(dir)
  try {
    // 工具层会把宿主 exec.agent 随 input 透给 provider(默认 scope 要靠它解析),
    // 所以这里锁住"store 自己构造 record"这条契约:多出来的字段不能跟着落盘。
    const { record } = svc.store.save(
      { scope: SESSION, kind: 'note', content: '带 agent 上下文保存的一条', agent: agent('sess-1') },
      { importance: 0.5, source: { origin: 'explicit' } },
    )
    assert.equal('agent' in record, false, '返回的 record 不能带 agent')
    assert.equal(JSON.stringify(record).includes('"agent"'), false)
    svc.store.flush()
    const file = join(dir, 'projects', `${createHash('sha1').update(SESSION).digest('hex')}.jsonl`)
    const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
    assert.equal(lines.length, 1)
    const onDisk = JSON.parse(lines[0]!)
    assert.equal(onDisk.agent, undefined, '落盘的行不能带 agent')
    assert.equal(lines[0]!.includes('"agent"'), false)
    assert.equal(onDisk.content, '带 agent 上下文保存的一条', '其余字段照常')
    assert.equal(onDisk.scope, SESSION)
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('作用域清单来自磁盘(别的进程写下的 scope 也能列出来)', async () => {
  const dir = tempDir()
  const writer = newService(dir)
  try {
    await writer.save({ scope: 'handbook', kind: 'note', content: '别的进程写的' })
    await writer.save({ scope: SESSION, kind: 'note', content: '别的进程写的会话记忆' })
    writer.flushSync()
  } finally {
    writer.flushSync()
  }
  // 全新进程:store 是懒加载的,清单必须先 discovery 才不会漏
  const fresh = newService(dir)
  try {
    assert.deepEqual(fresh.store.allScopes(), [], '起始什么都没加载')
    const stats = fresh.scopeStats()
    assert.deepEqual(stats.map((s) => s.scope).sort(), [SESSION, 'handbook'].sort())
    assert.deepEqual(fresh.store.allScopes().map((s) => s.scope).sort(), [SESSION, 'handbook'].sort(), '发现后可以被 peek 到')
    // discovery 有 3 秒缓存:紧接着再来几次不该再读目录
    const original = fresh.store.loadDiscovered.bind(fresh.store)
    let scans = 0
    fresh.store.loadDiscovered = () => { scans += 1; return original() }
    for (let i = 0; i < 4; i++) fresh.scopeStats()
    assert.equal(scans, 0, '缓存窗口内不再扫目录')
    assert.deepEqual(fresh.scopeStats().map((s) => s.scope).sort(), [SESSION, 'handbook'].sort(), '缓存期内清单仍然完整')
    assert.deepEqual(fresh.discoverScopes().sort(), [SESSION, 'handbook'].sort(), 'discoverScopes 同样受缓存约束且返回完整清单')
    assert.equal(scans, 0)
  } finally {
    fresh.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------------ 旧数据兼容

test('旧文件兼容:已存在的 projects/<sha1>.jsonl(project:<cwd>)仍可读写并出现在默认检索里', async () => {
  const dir = tempDir()
  const legacyScope = PROJECT
  const file = join(dir, 'projects', `${createHash('sha1').update(legacyScope).digest('hex')}.jsonl`)
  const record = {
    id: 'legacy-1',
    scope: legacyScope,
    kind: 'fact',
    content: '旧版本写下的项目记忆',
    tags: [],
    source: { origin: 'explicit' },
    createdAt: 1,
    updatedAt: 1,
    lastAccessedAt: 1,
    accessCount: 0,
    importance: 0.5,
  }
  const svc = newService(dir)
  try {
    writeFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
    const tools = toolsFor(svc)
    // 默认检索要能命中旧文件(它是 project 作用域)
    const hits = await tools.memory_search.execute({ query: '旧版本写下的项目记忆', topK: 5 }, { agent: agent('sess-fresh') })
    assert.equal(hits.records.length, 1)
    assert.equal(hits.records[0]!.id, 'legacy-1')
    assert.equal(hits.records[0]!.scope, legacyScope)
    // 旧文件仍可写:同一 scope 再存一条,文件里应有两行
    await svc.save({ scope: legacyScope, kind: 'note', content: '新写的一条项目记忆' })
    svc.store.flush()
    assert.equal((await svc.list({ scope: legacyScope })).length, 2)
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scope 数上限只影响自定义 scope:会话 scope 数量增长不受限', async () => {
  const dir = tempDir()
  const svc = newService(dir, { scopes: { global: true, project: true, custom: { enabled: true, max: 1 } } })
  try {
    await svc.save({ scope: 'only-custom', kind: 'note', content: 'x' })
    for (let i = 0; i < 30; i++) {
      await svc.save({ scope: `session:s${i}`, kind: 'note', content: `会话 ${i}` })
    }
    assert.equal(svc.store.customScopeCount(), 1)
    assert.equal(svc.store.allScopes().filter((s) => s.scope.startsWith('session:')).length, 30)
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------------ 删空即移除(0.5.1)

test('作用域被删空后不再留空文件,下次写入重新创建', async () => {
  // 0.32.0：forget 改为软删（墓碑可恢复），所以“删空即移除文件”改为两段式：
  //   forget 后列表不可见但文件保留（保留期内可 restore）；墓碑过期、维护任务
  //   物理清理之后，空文件才会被移除。这里用 tombstoneDays: 0 让保留期立即结束。
  const dir = tempDir()
  const svc = newService(dir, { cognitive: { lifecycle: { tombstoneDays: 0 } } })
  const scope = 'handbook'
  const file = join(dir, 'projects', `${createHash('sha1').update(scope).digest('hex')}.jsonl`)
  const vec = file.replace(/\.jsonl$/, '.vec')
  try {
    const rec = await svc.save({ scope, kind: 'note', content: '唯一一条' })
    svc.store.flush()
    assert.ok(existsSync(file), '写入后文件在')

    // 软删：列表/检索立即不可见，但文件仍在（保留期内可 restore）
    await svc.forget({ id: rec.id })
    svc.store.flush()
    assert.equal((await svc.list({ scope })).length, 0, '软删后列表不可见')
    assert.ok(existsSync(file), '墓碑保留期内文件仍在（可恢复）')

    // 墓碑过期 → 维护任务物理清理 → 空文件随之移除
    svc.runHousekeeping()
    svc.store.flush()
    assert.equal(existsSync(file), false, '墓碑过期清理后 .jsonl 应当被移除')
    assert.equal(existsSync(vec), false, '.vec 边车也一并移除')

    // 删空的作用域在**同一进程**里仍然是已知的(内存里有它的 store),只是磁盘上没了
    assert.equal(svc.store.peek(scope)?.records.size, 0)

    // 再写同一个名字:重新创建(不是"复用残留空文件")
    const again = await svc.save({ scope, kind: 'note', content: '重新写一条' })
    svc.store.flush()
    assert.ok(existsSync(file), '重新写入后文件回来')
    const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
    assert.equal(lines.length, 1)
    assert.equal(JSON.parse(lines[0]!).id, again.id)

    // 新进程:删空/移除后不会再把那个 scope 当成"存在"
    const fresh = newService(dir)
    try {
      const stats = fresh.scopeStats()
      assert.deepEqual(stats.map((s) => s.scope), ['handbook'], '只应看到还活着的那一个')
      assert.equal(stats[0]!.records, 1)
    } finally {
      fresh.flushSync()
    }
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('清空全部记忆后不留空文件(global.jsonl 是唯一例外)', async () => {
  const dir = tempDir()
  const svc = newService(dir)
  try {
    await svc.save({ scope: SESSION, kind: 'note', content: '会话' })
    await svc.save({ scope: PROJECT, kind: 'note', content: '项目' })
    await svc.save({ scope: 'handbook', kind: 'note', content: '自定义' })
    svc.store.flush()
    assert.equal(projectFiles(dir).filter((f) => f.endsWith('.jsonl')).length, 3)

    const out = svc.wipeAllRecords()
    assert.equal(out.removed, 3)
    svc.store.flush() // 清空标记为 dirty,文件移除发生在 flush
    assert.deepEqual(projectFiles(dir).filter((f) => f.endsWith('.jsonl')), [], 'projects/ 下不再有空 .jsonl')
    assert.deepEqual(projectFiles(dir), [], '边车也一起清掉')
    assert.equal(existsSync(join(dir, 'global.jsonl')), false, '这次没写过 global,自然也没有')

    // global 的例外:给它写一条再清空,它保留一个空文件(保留作用域不从磁盘上消失)
    await svc.save({ scope: 'global', kind: 'note', content: '全局' })
    svc.store.flush()
    const globalFile = join(dir, 'global.jsonl')
    assert.ok(existsSync(globalFile))
    svc.wipeAllRecords()
    svc.store.flush()
    assert.ok(existsSync(globalFile), 'global.jsonl 保留')
    assert.equal(readFileSync(globalFile, 'utf8').trim(), '', '内容清空但文件在')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------ 0.7.0 path + 作用域别名

test('path 写入项目作用域;scope 用作该作用域的显示名(别名)', async () => {
  const dir = tempDir()
  const svc = newService(dir)
  const workspace = join(tmpdir(), 'ws-demo')
  try {
    const tools = toolsFor(svc)
    const saved = await tools.memory_save.execute({
      content: '带路径的一条', path: workspace, scope: '演示项目',
    }, { agent: agent('sess-1') })
    assert.equal(saved.scope, `project:${workspace}`)
    assert.equal(saved.scopeName, '演示项目')
    assert.equal(svc.scopeName(`project:${workspace}`), '演示项目', '别名已登记')

    // 读路径可以直接用别名
    const found = await svc.search({ text: '带路径', scopes: ['演示项目'] as never })
    assert.equal(found.length, 1, '用别名能检索到该作用域')
    assert.equal(found[0]!.record.scope, `project:${workspace}`)

    // 同一路径同名幂等;不同路径同名拒绝
    await tools.memory_save.execute({ content: '同路径再写一条', path: workspace, scope: '演示项目' }, { agent: agent('sess-1') })
    await assert.rejects(
      () => tools.memory_save.execute({ content: '另一个路径抢名字', path: join(tmpdir(), 'ws-other'), scope: '演示项目' }, { agent: agent('sess-1') }),
      (error) => (error as { code?: string }).code === 'SCOPE_NAME_TAKEN',
    )
    // 保留名 / 非法名 = SCOPE_NAME_INVALID
    await assert.rejects(
      () => tools.memory_save.execute({ content: 'x', path: workspace, scope: 'global' }, { agent: agent('sess-1') }),
      (error) => (error as { code?: string }).code === 'PATH_SCOPE_CONFLICT',
    )
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('path 省略 scope 时,作用域名回退为路径本身', async () => {
  const dir = tempDir()
  const svc = newService(dir)
  const workspace = join(tmpdir(), 'ws-noname')
  try {
    const tools = toolsFor(svc)
    const saved = await tools.memory_save.execute({ content: '只给路径', path: workspace }, { agent: agent('sess-1') })
    assert.equal(saved.scope, `project:${workspace}`)
    assert.equal(saved.scopeName, undefined)
    assert.equal(svc.scopeName(`project:${workspace}`), undefined, '没有别名时显示路径本身')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('别名只能加在项目作用域上', async () => {
  const dir = tempDir()
  const svc = newService(dir)
  try {
    await assert.rejects(
      () => svc.save({ scope: 'global', kind: 'fact', content: 'x', name: '全局别名' } as never),
      (error) => (error as { code?: string }).code === 'SCOPE_NAME_UNSUPPORTED',
    )
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})
