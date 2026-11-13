import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService } from '../src/index.ts'

const SCOPE = 'project:/analysis'

function makeService(dir: string) {
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true, project: true } })
  svc.setProjectScope(SCOPE)
  return svc
}

const waitTask = async (svc: LocalMemoryService) => {
  for (let i = 0; i < 400; i++) {
    const task = svc.analysisLatestTask()
    if (task !== null && task.status !== 'running' && task.status !== 'queued') return task
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('分析任务超时')
}

test('智能关系分析：全量分析产出关系/冲突/聚类，确认后进入图谱', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-analysis-provider-'))
  const svc = makeService(dir)
  try {
    const a = await svc.save({ scope: SCOPE, kind: 'fact', content: '项目使用 PostgreSQL 数据库存储' })
    const b = await svc.save({ scope: SCOPE, kind: 'fact', content: '项目已迁移到 Neo4j 数据库' })
    const c = await svc.save({ scope: SCOPE, kind: 'fact', content: '构建端口是 8080，使用 npm 构建' })
    const d = await svc.save({ scope: SCOPE, kind: 'fact', content: '构建端口是 9090，使用 npm 构建' })
    const e = await svc.save({ scope: SCOPE, kind: 'fact', content: '设备架构是 arm64，Termux 环境' })
    // 注入合成向量（分析用；不依赖嵌入服务）
    const store = svc.store.peek(SCOPE)!
    const vectors: Array<[string, number[]]> = [
      [a.id, [1, 0, 0]], [b.id, [0.9, 0.1, 0]], [c.id, [0, 1, 0]], [d.id, [0, 0.9, 0.1]], [e.id, [0.8, 0, 0.2]],
    ]
    for (const [id, values] of vectors) {
      const vec = Float32Array.from(values)
      store.appendVector(id, vec)
    }

    const started = await svc.analysisRun({ mode: 'full' })
    assert.equal(started.mode, 'full')
    const task = await waitTask(svc)
    assert.equal(task.status, 'done', task.error ?? '')

    assert.ok(existsSync(join(dir, 'analysis', 'snapshot.json')), '分析快照（聚类/演化/路径）应落盘')
    assert.equal(existsSync(join(dir, 'analysis', 'graph.json')), false, '图谱改为即时构建,不再落盘 graph.json')
    const overview = svc.analysisOverview()
    assert.ok(overview.analyzedMemories >= 5)
    assert.ok(overview.suggested >= 1, '应发现潜在关系')
    assert.ok(overview.conflictsPending >= 1, '应发现冲突')

    const relations = svc.analysisRelations({ status: 'suggested' })
    assert.ok(relations.length >= 1)
    const relation = relations[0]!
    assert.ok(relation.evidence.length >= 1, '关系必须有依据')
    assert.ok(relation.confidenceScore > 0 && relation.confidenceScore <= 1)
    const confirmed = svc.analysisRelationAction({ id: relation.id, action: 'confirm' })
    assert.equal(confirmed.status, 'confirmed')
    assert.equal(svc.analysisOverview().confirmed >= 1, true)

    const graph = svc.analysisGraph()
    assert.ok(graph.edges.some((edge) => edge.status === 'confirmed'), '确认后的关系应进入图谱')

    const conflicts = svc.analysisConflicts()
    assert.ok(conflicts.length >= 1)
    const resolved = svc.analysisConflictAction({ id: conflicts[0]!.id, action: 'resolved' })
    assert.equal(resolved.status, 'resolved')

    assert.ok(Array.isArray(svc.analysisClusters()))
    assert.ok(Array.isArray(svc.analysisEvolution({ limit: 10 })))
    assert.ok(Array.isArray(svc.analysisPaths({ from: 'tool:postgresql', to: 'tool:neo4j' }).paths))
    assert.ok(svc.analysisHistory({ limit: 5 }).length >= 1)
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('智能关系分析：增量只分析新增/变化记忆，手动关系可创建', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-analysis-incr-'))
  const svc = makeService(dir)
  try {
    const a = await svc.save({ scope: SCOPE, kind: 'fact', content: '缓存使用 Redis 实现' })
    svc.store.peek(SCOPE)!.appendVector(a.id, Float32Array.from([1, 0, 0]))
    await svc.analysisRun({ mode: 'full' })
    const first = await waitTask(svc)
    assert.equal(first.status, 'done')

    const b = await svc.save({ scope: SCOPE, kind: 'fact', content: '缓存使用 Redis 集群，构建端口 8080，使用 npm' })
    svc.store.peek(SCOPE)!.appendVector(b.id, Float32Array.from([0.95, 0.05, 0]))
    await svc.analysisRun({ mode: 'incremental' })
    const second = await waitTask(svc)
    assert.equal(second.status, 'done', second.error ?? '')
    assert.ok(second.analyzed >= 1, '增量应至少分析新记忆')
    assert.ok(second.analyzed < second.total + 1)

    const graphNodes = svc.analysisGraph().nodes
    assert.ok(graphNodes.length >= 2, '图谱至少有 2 个实体')
    const manual = svc.analysisCreateRelation({
      sourceEntityId: graphNodes[0]!.id, targetEntityId: graphNodes[1]!.id, relationshipType: 'manual',
      evidenceText: '用户手动建立', sourceMemoryIds: [a.id],
    })
    assert.equal(manual.status, 'confirmed')
    assert.equal(manual.relationshipType, 'manual')
    assert.ok(svc.analysisGraph().edges.some((edge) => edge.type === 'manual'))
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})
