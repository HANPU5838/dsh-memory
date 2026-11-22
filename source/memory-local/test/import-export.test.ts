import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService } from '../src/index.ts'

function fresh(dir) {
  return new LocalMemoryService({ storeDir: dir, scopes: { global: true, project: true, session: true } })
}

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-import-'))
  const svc = fresh(dir)
  return fn(svc, dir).finally(() => { try { svc.flushSync() } catch { /* ignore */ } rmSync(dir, { recursive: true, force: true }) })
}

test('createRecord: 只接受明确的 scope,面板不猜 project/session', async () => {
  await withDir(async (svc) => {
    const rec = await svc.createRecord({ scope: 'project:C:\\w', kind: 'rule', content: '改 lib 必须同时改 source' })
    assert.equal(rec.kind, 'rule')
    assert.equal(rec.scope, 'project:C:\\w')
    const custom = await svc.createRecord({ scope: 'handbook', content: '自定义作用域里的一条' })
    assert.equal(custom.scope, 'handbook')
    await assert.rejects(() => svc.createRecord({ scope: 'project', content: 'x' }), /SCOPE_INVALID/)
    await assert.rejects(() => svc.createRecord({ scope: 'session', content: 'x' }), /SCOPE_INVALID/)
    await assert.rejects(() => svc.createRecord({ scope: 'global', content: '   ' }), /CONTENT_EMPTY/)
  })
})

test('exportAll: 纯文本 + 元数据,不含向量', async () => {
  await withDir(async (svc) => {
    await svc.save({ scope: 'global', kind: 'fact', content: '全局事实' })
    await svc.save({ scope: 'project:C:\\w', kind: 'rule', content: '项目规则' })
    const doc = svc.exportAll()
    assert.equal(doc.version, 2)
    assert.equal(typeof doc.exportedAt, 'number')
    assert.equal(doc.records.length, 2)
    for (const r of doc.records) {
      assert.deepEqual(Object.keys(r).sort(), ['content', 'createdAt', 'importance', 'kind', 'scope', 'tags', 'updatedAt'])
    }
    assert.deepEqual(doc.records.map((r) => r.scope).sort(), ['global', 'project:C:\\w'])
  })
})

test('importRecords: 往返导入 + 重复按内容跳过', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-import-'))
  const other = mkdtempSync(join(tmpdir(), 'dsh-memory-import-'))
  const a = fresh(dir)
  const b = fresh(other)
  try {
    await a.save({ scope: 'global', kind: 'decision', content: '选择 JSONL 作为存储' })
    await a.save({ scope: 'project:C:\\w', kind: 'rule', content: '发布前必须跑 npm test' })
    const doc = a.exportAll()

    const first = await b.importRecords(doc)
    assert.deepEqual({ imported: first.imported, skipped: first.skipped, rejected: first.rejected }, { imported: 2, skipped: 0, rejected: 0 })
    const kinds = new Set(b.listSync({ scopes: ['global', 'project:C:\\w'] }).map((r) => r.kind))
    assert.ok(kinds.has('rule') && kinds.has('decision'))

    const again = await b.importRecords(doc)
    assert.deepEqual({ imported: again.imported, skipped: again.skipped, rejected: again.rejected }, { imported: 0, skipped: 2, rejected: 0 })
  } finally {
    a.flushSync(); b.flushSync()
    rmSync(dir, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true })
  }
})

test('importRecords: 状态过期时间与流程触发词随导出往返', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-import-'))
  const other = mkdtempSync(join(tmpdir(), 'dsh-memory-import-'))
  const a = fresh(dir)
  const b = fresh(other)
  try {
    const state = await a.save({
      scope: 'project:C:\\w', kind: 'state', content: '部署在测试环境',
      expiresAt: Date.now() + 86_400_000,
    })
    await a.save({
      scope: 'global', kind: 'procedure', content: '发布流程',
      triggers: ['npm', 'publish'],
    })
    const doc = a.exportAll()
    const imported = await b.importRecords(doc)
    assert.deepEqual({ imported: imported.imported, rejected: imported.rejected }, { imported: 2, rejected: 0 })
    const records = b.listSync({ scopes: ['global', 'project:C:\\w'], includeExpired: true })
    const restoredState = records.find((r) => r.kind === 'state')!
    assert.equal(restoredState.expiredAt, state.expiredAt)
    const restoredProcedure = records.find((r) => r.kind === 'procedure')!
    assert.deepEqual((restoredProcedure as never as { triggers?: string[] }).triggers, ['npm', 'publish'])
  } finally {
    a.flushSync(); b.flushSync()
    rmSync(dir, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true })
  }
})

test('importRecords: 坏条目计入 rejected,不中断其余条目', async () => {
  await withDir(async (svc) => {
    const result = await svc.importRecords({
      records: [
        { scope: 'global', content: '' },
        { scope: '../escape', content: '坏作用域' },
        { scope: 'global', kind: 'rule', content: '合法的一条' },
      ],
    })
    assert.equal(result.imported, 1)
    assert.equal(result.rejected, 2)
    assert.equal(result.errors.length, 2)
    assert.equal(svc.listSync({ scopes: ['global'], kind: 'rule' }).length, 1)
  })
})

test('importRecords: 拒绝非文档格式与超量导入', async () => {
  await withDir(async (svc) => {
    await assert.rejects(() => svc.importRecords({ nope: true }), /IMPORT_INVALID/)
    await assert.rejects(() => svc.importRecords(Array.from({ length: 5001 }, () => ({ scope: 'global', content: 'x' }))), /IMPORT_TOO_LARGE/)
  })
})
test('memory_get: 完整 id 与 8 位前缀都能取到,找不到的进 missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-get-'))
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true, project: true } })
  try {
    const rec = await svc.save({ scope: 'global', kind: 'fact', content: '按 id 取的一条' })
    const prefix = rec.id.slice(0, 8)
    assert.deepEqual(svc.getByIds([rec.id]).map((r) => r.id), [rec.id])
    assert.deepEqual(svc.getByIds([prefix]).map((r) => r.id), [rec.id])
    assert.deepEqual(svc.getByIds(['deadbeef']), [])
    svc.flushSync()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reindexRecord:后端不可达时保留 pending,并把旧向量标脏(重启不会误判为已嵌入)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-reindex-'))
  const svc = new LocalMemoryService({
    storeDir: dir,
    scopes: { global: true, project: true },
    retrieval: { vector: { enabled: true, endpoint: 'http://127.0.0.1:9/v1/embeddings', model: 'm', dims: 4, writeTimeoutMs: 150, backfillTimeoutMs: 150 } },
  })
  try {
    const rec = await svc.save({ scope: 'global', kind: 'fact', content: '旧内容' })
    const s = svc.store.peek('global')!
    s.vectors.set(rec.id, new Float32Array([1, 0, 0, 0]))
    const ok = await svc.reindexRecord('global', rec.id)
    assert.equal(ok, false, '后端不可达 → 重建失败')
    assert.equal(s.vectors.has(rec.id), false, '旧向量必须从内存删掉')
    assert.equal(s.vectorsDirty, true, '旧向量必须从磁盘作废')
    assert.equal(s.embedPending.has(rec.id), true, '留在待嵌入队列里等重试')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reindexRecord:未配置向量时是 no-op', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-reindex-'))
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true, project: true } })
  try {
    const rec = await svc.save({ scope: 'global', kind: 'fact', content: 'x' })
    assert.equal(await svc.reindexRecord('global', rec.id), false)
    assert.equal(svc.store.peek('global')!.embedPending.size, 0)
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reindexAll:作废全部向量并排队;后端不可达时留在 pending', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-reindex-all-'))
  const svc = new LocalMemoryService({
    storeDir: dir,
    scopes: { global: true, project: true },
    retrieval: { vector: { enabled: true, endpoint: 'http://127.0.0.1:9/v1/embeddings', model: 'm', dims: 4, writeTimeoutMs: 150, backfillTimeoutMs: 150 } },
  })
  try {
    const rec = await svc.save({ scope: 'global', kind: 'fact', content: '要重建的一条' })
    const s = svc.store.peek('global')!
    s.embedPending.delete(rec.id)
    s.vectors.set(rec.id, new Float32Array([1, 0, 0, 0]))
    const out = svc.reindexAll()
    assert.equal(out.total, 1, '同步部分把所有记录排队')
    assert.equal(s.vectors.has(rec.id), false, '旧向量作废')
    assert.equal(s.vectorsDirty, true, '磁盘上的旧向量也要作废')
    assert.equal(s.embedPending.has(rec.id), true, '留在待嵌入队列')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})
