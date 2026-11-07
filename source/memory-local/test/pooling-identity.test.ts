/**
 * 回归:`.vec` 的身份头必须带上 pooling(RestRegular/dsh-memory#3 第三条)。
 *
 * 同一个模型换 `--pooling` 就是一个新的向量空间(实测 qwen3-embedding 上 last 与 cls
 * 的余弦只有 0.35,而无关文本之间是 0.99),但老身份只有 `model\tdims`,校验会放行,
 * 于是"另一个工具用错 pooling 写的边车"会被静默当成有效向量。
 *
 * 兼容策略:身份头升级成三段 `model\tdims\tpooling`;读到**两段的旧头**按兼容接受
 * (不能因为多记一个字段就让所有用户的向量全量重嵌),下一次写向量时顺手升级成三段。
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, scopeFileName } from '../src/store.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-vecpool-'))
  dirs.push(dir)
  return { dir, store: new MemoryStore(dir) }
}

function saveOne(store: MemoryStore, scope: string, content: string) {
  const { record } = store.save(
    { scope, kind: 'note', content } as Parameters<MemoryStore['save']>[0],
    { importance: 0.5, source: { origin: 'explicit' as const } },
  )
  return record
}

function vecPath(dir: string, scope: string): string {
  return join(dir, scopeFileName(scope).replace(/\.jsonl$/, '.vec'))
}


/** 长度与身份维度一致的向量：维度不符的边车条目现在会被丢弃（截断行防护）。 */
function vec(dims: number, first = 1): Float32Array {
  const out = new Float32Array(dims)
  out[0] = first
  return out
}

function firstLine(file: string): string {
  return readFileSync(file, 'utf8').split('\n')[0]!
}

test('identity records the pooling when it is known', () => {
  const { dir, store } = freshStore()
  store.setVecIdentity('qwen3-embedding-0.6b', 1024, 'last')
  const rec = saveOne(store, 'project:p', '带 pooling 的身份')
  store.scope('project:p').appendVector(rec.id, vec(1024))
  store.close()

  assert.equal(firstLine(vecPath(dir, 'project:p')), '#qwen3-embedding-0.6b\t1024\tlast')

  const same = new MemoryStore(dir)
  same.setVecIdentity('qwen3-embedding-0.6b', 1024, 'last')
  same.loadAll(['project:p'])
  assert.ok(same.scope('project:p').vectors.has(rec.id), '同模型同 pooling → 向量可用')
  assert.equal(same.scope('project:p').embedPending.size, 0)

  const wrongPooling = new MemoryStore(dir)
  wrongPooling.setVecIdentity('qwen3-embedding-0.6b', 1024, 'cls')
  wrongPooling.loadAll(['project:p'])
  const s = wrongPooling.scope('project:p')
  assert.equal(s.vectors.size, 0, '换 pooling = 换了向量空间,必须作废')
  assert.ok(s.embedPending.has(rec.id), '记录要重新嵌入')
})

test('a legacy two-field header is accepted, then upgraded on the next vector write', () => {
  const { dir, store } = freshStore()
  // 0.10.0 之前:身份只有 model + dims
  store.setVecIdentity('bge-m3', 4)
  const rec = saveOne(store, 'project:legacy', '旧身份头')
  store.scope('project:legacy').appendVector(rec.id, vec(4))
  store.close()
  assert.equal(firstLine(vecPath(dir, 'project:legacy')), '#bge-m3\t4', 'precondition: 两段旧头')

  // 新版本带上了 pooling:老数据不能因此重嵌
  const upgraded = new MemoryStore(dir)
  upgraded.setVecIdentity('bge-m3', 4, 'cls')
  upgraded.loadAll(['project:legacy'])
  const s = upgraded.scope('project:legacy')
  assert.ok(s.vectors.has(rec.id), '旧头按兼容接受,不做全量重嵌')

  // 下一次写向量时把头部升级成三段,之后的校验才真正带上 pooling
  s.appendVector(rec.id, vec(4, 0))
  upgraded.close()
  assert.equal(firstLine(vecPath(dir, 'project:legacy')), '#bge-m3\t4\tcls')

  const strict = new MemoryStore(dir)
  strict.setVecIdentity('bge-m3', 4, 'last')
  strict.loadAll(['project:legacy'])
  assert.equal(strict.scope('project:legacy').vectors.size, 0, '升级后的头开始严格比对 pooling')
})

test('a legacy two-field header still discards on a model change', () => {
  const { dir, store } = freshStore()
  store.setVecIdentity('bge-m3', 4)
  const rec = saveOne(store, 'project:m', '旧头 + 换模型')
  store.scope('project:m').appendVector(rec.id, vec(4))
  store.close()

  const other = new MemoryStore(dir)
  other.setVecIdentity('other-model', 4, 'cls')
  other.loadAll(['project:m'])
  const s = other.scope('project:m')
  assert.equal(s.vectors.size, 0)
  assert.ok(s.embedPending.has(rec.id))
})

test('a sidecar without any header is still discarded', () => {
  const { dir, store } = freshStore()
  store.setVecIdentity('bge-m3', 4, 'cls')
  const rec = saveOne(store, 'project:h', '无头边车')
  store.close()
  const file = vecPath(dir, 'project:h')
  writeFileSync(file, `${rec.id}\t${Buffer.from(vec(4).buffer).toString('base64')}\n`, 'utf8')

  const reopened = new MemoryStore(dir)
  reopened.setVecIdentity('bge-m3', 4, 'cls')
  reopened.loadAll(['project:h'])
  assert.equal(reopened.scope('project:h').vectors.size, 0, '无头文件不可信')
})
