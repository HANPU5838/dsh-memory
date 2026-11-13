/**
 * 存储层硬化回归（2026-11-08 评审结论）：
 *  1. storeDir 默认必须是绝对路径——相对路径跟着 cwd 走，换个目录启动就"丢记忆"。
 *  2. .vec 载入必须按身份头里的维度校验——被进程中断写成截断行时，base64 长度
 *     仍是 4 的倍数，decode 会"成功"，错维向量混进余弦（按较短边算）→ 静默错分。
 *  3. 边车不能只增不减——已删除记录的向量会被原样写回，文件随删建无限增长。
 *  4. 访问统计（accessCount / lastAccessedAt）要落盘——它们是 recency/accessBoost
 *     的排序输入，只改内存等于没算。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../src/store.ts'
import { resolveConfig } from '../src/index.ts'

type SaveScope = Parameters<MemoryStore['save']>[0]['scope']

function save(store: MemoryStore, scope: SaveScope, content: string): string {
  return store.save(
    { scope, kind: 'note', content },
    { importance: 0.5, source: { origin: 'explicit' } },
  ).record.id
}

test('storeDir 默认是绝对路径（不随 cwd 漂移）', () => {
  const cfg = resolveConfig({})
  assert.ok(cfg.storeDir.startsWith('/'), `期望绝对路径，实际 ${cfg.storeDir}`)
  assert.equal(cfg.storeDir, join(homedir(), '.dsh-memory'))
})

test('.vec 里维度不符的条目被丢弃，正确维度的保留', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-vec-dims-'))
  try {
    const warns: string[] = []
    const store = new MemoryStore(dir, { onWarn: (m) => warns.push(m) })
    store.setVecIdentity('m', 4)
    const good = save(store, 'global', '正确维度的记录')
    const bad = save(store, 'global', '维度不符的记录')
    const s = store.scope('global')
    s.setVector(good, new Float32Array([1, 2, 3, 4]))
    s.setVector(bad, new Float32Array([1, 2, 3])) // 3 维：模拟截断行
    store.flush() // 记录与边车都落盘，否则 reload 时记录集为空、向量会被当成孤儿跳过

    const reloaded = new MemoryStore(dir, { onWarn: (m) => warns.push(m) })
    reloaded.setVecIdentity('m', 4)
    reloaded.loadAll(['global'])
    const rs = reloaded.scope('global')
    assert.equal(rs.vectors.has(good), true, '4 维向量应保留')
    assert.equal(rs.vectors.has(bad), false, '3 维向量应丢弃')
    assert.ok(warns.some((m) => m.includes('维度不符')), '丢弃要有 warn')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('边车不会保留已删除记录的向量（只增不减修复）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-vec-compact-'))
  const vecFile = join(dir, 'global.vec')
  try {
    const store = new MemoryStore(dir, { onWarn: () => {} })
    store.setVecIdentity('m', 4)
    const keep = save(store, 'global', '留下的记录')
    const gone = save(store, 'global', '要删掉的记录')
    const s = store.scope('global')
    s.setVector(keep, new Float32Array([1, 2, 3, 4]))
    s.setVector(gone, new Float32Array([4, 3, 2, 1]))
    store.flush()

    assert.ok(readFileSync(vecFile, 'utf8').includes(gone), '先确认它在文件里')
    s.remove(gone)
    store.flush()

    const text = existsSync(vecFile) ? readFileSync(vecFile, 'utf8') : ''
    assert.equal(text.includes(gone), false, '删除后边车里不应再有它的条目')
    assert.equal(text.includes(keep), true, '未删除的记录仍保留')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('访问统计会落盘：touch 后 reload 仍能看到 accessCount / lastAccessedAt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-touch-persist-'))
  try {
    const store = new MemoryStore(dir, { onWarn: () => {} })
    const id = save(store, 'global', '被检索命中过的记录')
    const rec = store.scope('global').records.get(id)!
    assert.equal(rec.accessCount, 0)

    rec.accessCount = 1
    rec.lastAccessedAt = Date.now() + 1000
    store.touch(rec)
    store.flush()

    const reloaded = new MemoryStore(dir, { onWarn: () => {} })
    reloaded.loadAll(['global'])
    const after = reloaded.scope('global').records.get(id)!
    assert.equal(after.accessCount, 1, 'accessCount 落盘')
    assert.equal(after.lastAccessedAt, rec.lastAccessedAt, 'lastAccessedAt 落盘')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('.vec 重复追加同一 id 有上界（超过阈值整份重写，不再只增不减）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-vec-append-'))
  try {
    const store = new MemoryStore(dir, { onWarn: () => {} })
    store.setVecIdentity('m', 4)
    const id = save(store, 'global', '重复嵌入的同一记录')
    const scope = store.allScopes().find((item) => item.scope === 'global')
    assert.ok(scope !== undefined, 'global scope 应存在')
    const vec = new Float32Array([0.1, 0.2, 0.3, 0.4])
    for (let i = 0; i < 400; i += 1) scope.appendVector(id, vec)
    const text = readFileSync(join(dir, 'global.vec'), 'utf8')
    const lines = text.split('\n').filter((line) => line !== '' && !line.startsWith('#'))
    assert.ok(lines.length <= 100, `重复追加后 .vec 行数应有上界，实际 ${lines.length}`)
    // 两次整份重写之间允许累积有限重复行（阈值 64），但绝不能是 400。
    assert.ok(lines.filter((line) => line.startsWith(`${id}\t`)).length <= 80, '重复行数必须有上界')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
