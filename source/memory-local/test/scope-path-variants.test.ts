/**
 * 作用域路径写法统一(0.11.1)。
 *
 * 事故现场:0.7.0 的 `memory_save({ path })` 只削掉末尾分隔符,
 * `D:/repositories/dsh-memory` 与宿主会话 cwd 的 `D:\repositories\dsh-memory`
 * 落成两个 `project:` scope —— 前者的记忆在工作区里永远读不到,面板/清单里还会
 * 出现两个同名绝对路径。
 *
 * 这里的护栏:
 *   - canonicalWorkspacePath 只做"绝不可能指向另一个目录"的改写(分隔符、盘符大小写、
 *     `.`/`..`、末尾分隔符),POSIX 路径与大小写保持原样;
 *   - 写路径(工具 path 参数 / 显式 project:<路径> / 会话 cwd)落到同一个键;
 *   - 历史分叉在 reconcileScopes() 里合并到规范键,别名跟着走、旧文件删掉。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService } from '../src/index.ts'
import { MemoryStore } from '../src/store.ts'
import { canonicalWorkspacePath, projectScopeIdentity, resolveCurrentScopes } from '../src/scope.ts'
import { memoryTools } from '../../tool-memory/src/index.ts'

const WIN = 'project:D:\\Edge Cases\\repo'
const WIN_VARIANT = 'project:D:/Edge Cases/repo/'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-memory-path-variants-'))
}

function projectFile(dir, scope) {
  return join(dir, 'projects', `${createHash('sha1').update(scope).digest('hex')}.jsonl`)
}

function agent(cwd, id = 'sess-1') {
  return { session: { header: { id, cwd } } }
}

// ------------------------------------------------------------------ 纯函数

test('canonicalWorkspacePath: Windows 绝对路径只有一种写法', () => {
  assert.equal(canonicalWorkspacePath('D:/repositories/x'), 'D:\\repositories\\x')
  assert.equal(canonicalWorkspacePath('D:\\repositories\\x'), 'D:\\repositories\\x')
  assert.equal(canonicalWorkspacePath('D:/repositories/x/'), 'D:\\repositories\\x')
  assert.equal(canonicalWorkspacePath('D:\\repositories\\x\\\\'), 'D:\\repositories\\x')
  assert.equal(canonicalWorkspacePath('d:\\repositories\\x'), 'D:\\repositories\\x', '盘符统一大写')
  assert.equal(canonicalWorkspacePath('D:/repositories/./x/../x'), 'D:\\repositories\\x', '消掉 . 与 ..')
  assert.equal(canonicalWorkspacePath('  D:/x  '), 'D:\\x', '去掉首尾空白')
  // 根目录不能被剥成 `D:`
  assert.equal(canonicalWorkspacePath('D:/'), 'D:\\')
  assert.equal(canonicalWorkspacePath('/'), '/')
})

test('canonicalWorkspacePath: POSIX / 相对路径不乱改', () => {
  assert.equal(canonicalWorkspacePath('/work/repo'), '/work/repo')
  assert.equal(canonicalWorkspacePath('/work/repo/'), '/work/repo')
  assert.equal(canonicalWorkspacePath('/work/./repo/../repo2'), '/work/repo2')
  // 非绝对路径不能拿 process.cwd() 去猜(那是 DSH profile 目录)
  assert.equal(canonicalWorkspacePath('fixed'), 'fixed')
  assert.equal(canonicalWorkspacePath('relative/path/'), 'relative/path')
  // 大小写只在 Windows 盘符路径上折叠
  assert.equal(projectScopeIdentity('D:/Repo'), projectScopeIdentity('D:\\repo'))
  assert.notEqual(projectScopeIdentity('/Users/A'), projectScopeIdentity('/users/a'))
})

test('resolveCurrentScopes: 宿主给的正斜杠 cwd 与 path 参数落同一个键', () => {
  assert.equal(resolveCurrentScopes(agent('D:/repositories/x')).project, 'project:D:\\repositories\\x')
  assert.equal(resolveCurrentScopes(agent('d:\\repositories\\x\\')).project, 'project:D:\\repositories\\x')
  // POSIX cwd 原样(不因为跑在 Windows 上就被解释成盘符路径)
  assert.equal(resolveCurrentScopes(agent('/work/repo')).project, 'project:/work/repo')
})

// ------------------------------------------------------------------ 写路径

test('save: 显式 project:<路径> 的不同写法落到同一个 scope', async () => {
  const dir = tempDir()
  const svc = new LocalMemoryService({
      cognitive: { arbiter: { enabled: false } }, storeDir: dir, scopes: { global: true, project: true } })
  try {
    const first = await svc.save({ scope: WIN_VARIANT, kind: 'note', content: '正斜杠写入的一条' })
    assert.equal(first.scope, WIN, '落盘键必须是规范写法')
    const second = await svc.save({ scope: WIN, kind: 'note', content: '反斜杠写入的一条' })
    assert.equal(second.scope, WIN)
    assert.equal((await svc.list({ scope: WIN })).length, 2)
    assert.equal((await svc.list({ scope: WIN_VARIANT })).length, 2, '旧写法读取也要命中')
    // 会话(宿主 cwd 是 Windows 写法)→ 默认读取集合里能看到
    assert.deepEqual(svc.resolveReadScopes(agent('D:\\Edge Cases\\repo')), ['session:sess-1', WIN, 'global'])
    assert.equal(svc.listSync({ scopes: [WIN_VARIANT] }).length, 2, '注入路径(listSync)同样统一')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('memory_save({ path }): 正斜杠 / 反斜杠路径写同一个 scope,别名照旧生效', async () => {
  const dir = tempDir()
  const svc = new LocalMemoryService({
      cognitive: { arbiter: { enabled: false } }, storeDir: dir, scopes: { global: true, project: true } })
  try {
    const tools = memoryTools({ getService: () => svc as never, defaultScope: 'project' })
    const forward = await tools.memory_save.execute({ content: 'path 参数的一条', path: 'D:/Edge Cases/repo', scope: '演示项目' })
    const backward = await tools.memory_save.execute({ content: '另一种写法的 path', path: 'D:\\Edge Cases\\repo', scope: '演示项目' })
    assert.equal(forward.scope, WIN)
    assert.equal(backward.scope, WIN, '同一个目录只能有一个键(0.11.1 的回归点)')
    assert.equal(svc.scopeName(WIN), '演示项目')
    assert.equal(svc.store.allScopes().filter((s) => s.scope.startsWith('project:')).length, 1, '不能出现第二个 project scope')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------------ 历史数据合并

test('reconcileScopes: 历史分叉的 scope 并到规范键,别名跟着走、旧文件删掉', async () => {
  const dir = tempDir()
  // 模拟旧版本留下的两个 scope(直接写 store,绕过 0.11.1 的规范化)
  const seed = new MemoryStore(dir)
  seed.save(
    { scope: WIN, kind: 'note', content: '规范写法下的一条' },
    { importance: 0.5, source: { origin: 'explicit' } },
  )
  seed.save(
    { scope: WIN_VARIANT, kind: 'fact', content: '分叉的 scope 里的一条' },
    { importance: 0.5, source: { origin: 'explicit' } },
  )
  seed.close()
  assert.ok(existsSync(projectFile(dir, WIN_VARIANT)), 'precondition: 两个文件都在')

  const svc = new LocalMemoryService({
      cognitive: { arbiter: { enabled: false } }, storeDir: dir, scopes: { global: true, project: true } })
  try {
    const { merged } = svc.reconcileScopes()
    assert.equal(merged, 1, '合并掉一个变体')
    assert.equal(svc.store.peek(WIN)?.records.size, 2, '记录都并进规范键')
    const scopes = svc.scopeStats()
    assert.equal(scopes.find((s) => s.scope === WIN)?.records, 2)
    assert.equal(scopes.find((s) => s.scope === WIN_VARIANT)?.records ?? 0, 0, '变体不再有记录')
    assert.equal(existsSync(projectFile(dir, WIN_VARIANT)), false, '变体的文件被删掉')
    // 再跑一次是 no-op(每进程只合并一次)
    assert.deepEqual(svc.reconcileScopes(), { merged: 0 })
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('discoverScopes 会顺带合并(面板 / memory_list 这么发现作用域)', async () => {
  const dir = tempDir()
  const seed = new MemoryStore(dir)
  seed.save({ scope: WIN_VARIANT, kind: 'note', content: '只有变体里的一条' }, { importance: 0.5, source: { origin: 'explicit' } })
  seed.close()

  const svc = new LocalMemoryService({
      cognitive: { arbiter: { enabled: false } }, storeDir: dir, scopes: { global: true, project: true } })
  try {
    const found = svc.discoverScopes()
    assert.ok(found.includes(WIN), '规范键出现在发现结果里')
    assert.equal(svc.store.peek(WIN)?.records.size, 1)
    assert.equal(existsSync(projectFile(dir, WIN_VARIANT)), false)
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})
