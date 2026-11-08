/**
 * discovery 索引回归（2026-11-08 性能收尾）。
 *
 * 以前 loadDiscovered() 对每个 projects/*.jsonl 都 readFileSync 整份文件、只为拿
 * 第一行的 scope —— 7000 条实测 RSS 125MB，而且每 60 秒随 embed 重试再跑一遍。
 * 现在用 <storeDir>/scopes.index.json（文件名 → scope）加速：readdir + 一次小文件
 * 读取即可，索引缺失/损坏才回退读内容。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, scopeFileName } from '../src/store.ts'

type SaveScope = Parameters<MemoryStore['save']>[0]['scope']

function save(store: MemoryStore, scope: SaveScope, content: string): string {
  return store.save({ scope, kind: 'note', content }, { importance: 0.5, source: { origin: 'explicit' } }).record.id
}

test('落盘后写入索引；索引缺失时回退重建', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-discover-'))
  try {
    const scope = 'project:/tmp/dsh-discover' as SaveScope
    const store = new MemoryStore(dir)
    save(store, scope, '一条自定义作用域的记忆')
    store.flush()
    store.close()

    const indexPath = join(dir, 'scopes.index.json')
    assert.ok(existsSync(indexPath), '索引文件已生成')
    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as { files: Record<string, string> }
    assert.equal(index.files[scopeFileName(scope)], scope, '文件名映射到 scope')

    // 删掉索引 → 仍然能发现（readdir + 回退读文件），并重建索引
    rmSync(indexPath, { force: true })
    const reopened = new MemoryStore(dir)
    const found = reopened.loadDiscovered()
    assert.deepEqual(found, [scope])
    assert.ok(existsSync(indexPath), '回退路径会重建索引')
    reopened.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('有索引时 discovery 不读文件内容（内容损坏也照样发现）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-discover-lazy-'))
  try {
    const scope = 'project:/tmp/dsh-discover-lazy' as SaveScope
    const store = new MemoryStore(dir)
    save(store, scope, '先正常写一条')
    store.flush()
    store.close()

    // 把数据文件内容改成垃圾：如果 discovery 还去读内容，就会拿不到 scope。
    const file = join(dir, scopeFileName(scope))
    writeFileSync(file, 'not-json-at-all\n', 'utf8')

    const reopened = new MemoryStore(dir)
    const found = reopened.loadDiscovered()
    assert.deepEqual(found, [scope], '索引命中 → 不需要读内容')
    reopened.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('文件被删除后索引项会被清理', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-discover-prune-'))
  try {
    const scope = 'project:/tmp/dsh-discover-prune' as SaveScope
    const store = new MemoryStore(dir)
    save(store, scope, '待会删掉的作用域')
    store.flush()
    store.close()

    rmSync(join(dir, scopeFileName(scope)), { force: true })
    const reopened = new MemoryStore(dir)
    assert.deepEqual(reopened.loadDiscovered(), [], '文件没了就不该再被发现')
    const index = JSON.parse(readFileSync(join(dir, 'scopes.index.json'), 'utf8')) as { files: Record<string, string> }
    assert.equal(index.files[scopeFileName(scope)], undefined, '索引项被清理')
    reopened.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
