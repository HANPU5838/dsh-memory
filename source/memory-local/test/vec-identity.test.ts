import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, scopeFileName } from '../src/store.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-vecid-'))
  dirs.push(dir)
  return { dir, store: new MemoryStore(dir) }
}


/** 长度与身份维度一致的向量：维度不符的边车条目现在会被丢弃（截断行防护）。 */
function vec(dims: number, first = 1): Float32Array {
  const out = new Float32Array(dims)
  out[0] = first
  return out
}

function saveOne(store: MemoryStore, scope: string, content: string) {
  const { record } = store.save(
    { scope, kind: 'note', content } as Parameters<MemoryStore['save']>[0],
    { importance: 0.5, source: { origin: 'explicit' as const } },
  )
  return record
}

test('sidecar carries identity header and matching identity loads', () => {
  const { dir, store } = freshStore()
  store.setVecIdentity('bge-m3', 1024)
  const rec = saveOne(store, 'project:t', '向量身份验证')
  store.scope('project:t').appendVector(rec.id, vec(1024))
  store.flush()

  const projDir = join(dir, 'projects')
  const sidecar = readdirSync(projDir).find((f) => f.endsWith('.vec'))
  assert.ok(sidecar, 'sidecar exists')
  const firstLine = readFileSync(join(projDir, sidecar!), 'utf8').split('\n')[0]
  assert.equal(firstLine, '#bge-m3\t1024')

  // reopen with the SAME identity → vectors restored
  const store2 = new MemoryStore(dir)
  store2.setVecIdentity('bge-m3', 1024)
  store2.loadAll(['project:t'])
  const s2 = store2.scope('project:t')
  assert.ok(s2.vectors.has(rec.id), 'same identity keeps vectors')
  assert.equal(s2.embedPending.size, 0)
})

test('model change discards sidecar and queues re-embed', () => {
  const { dir, store } = freshStore()
  store.setVecIdentity('bge-m3', 1024)
  const rec = saveOne(store, 'project:t', '模型切换测试')
  store.scope('project:t').appendVector(rec.id, vec(1024))
  store.close()

  const store2 = new MemoryStore(dir)
  store2.setVecIdentity('other-model', 768)
  store2.loadAll(['project:t'])
  const s2 = store2.scope('project:t')
  assert.equal(s2.vectors.size, 0, 'old-model vectors discarded')
  assert.ok(s2.embedPending.has(rec.id), 'record queued for re-embed')
  // and the stale sidecar gets rewritten with the new header on flush
  store2.scope('project:t').appendVector(rec.id, vec(768, 0.5))
  store2.close()
  const store3 = new MemoryStore(dir)
  store3.setVecIdentity('other-model', 768)
  store3.loadAll(['project:t'])
  assert.ok(store3.scope('project:t').vectors.has(rec.id), 'new identity roundtrips')
})

test('legacy headerless sidecar is discarded when identity configured', () => {
  const { dir, store } = freshStore()
  store.setVecIdentity('bge-m3', 1024)
  const rec = saveOne(store, 'project:t', '旧格式迁移')
  store.close() // jsonl must exist for the reopen to see the record
  // simulate a pre-header sidecar: data lines only
  const vecPath = join(dir, scopeFileName('project:t').replace(/\.jsonl$/, '.vec'))
  writeFileSync(vecPath, `${rec.id}\t${Buffer.from(vec(1024).buffer).toString('base64')}\n`, 'utf8')

  const store2 = new MemoryStore(dir)
  store2.setVecIdentity('bge-m3', 1024)
  store2.loadAll(['project:t'])
  const s2 = store2.scope('project:t')
  assert.equal(s2.vectors.size, 0, 'legacy file not trusted')
  assert.ok(s2.embedPending.has(rec.id))
})
