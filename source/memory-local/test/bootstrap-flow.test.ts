/**
 * 0.112.0：自举主流程（runBootstrapFlow）的编排测试。
 *
 * 不触发真实下载/装包：把 runBootstrap / tryAdoptLocalEndpoint / bootstrapLog
 * 换成测试桩，验证「采用本机端点就短路」「决策后调用执行」「任何异常都只写日志」。
 * 这是审计 backlog 里最后一条未覆盖的主流程。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService } from '../src/index.ts'

function service(dir: string) {
  return new LocalMemoryService({ storeDir: dir, scopes: { global: true }, retrieval: { vector: { enabled: false } } })
}

test('0.112.0：发现并采用本机端点后不再执行安装', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bootstrap-adopt-'))
  const svc = service(dir)
  try {
    const logs: string[] = []
    const installed: string[] = []
    ;(svc as unknown as Record<string, unknown>).tryAdoptLocalEndpoint = async () => true
    ;(svc as unknown as Record<string, unknown>).runBootstrap = async (decision: string) => { installed.push(decision) }
    ;(svc as unknown as Record<string, unknown>).bootstrapLog = (line: string) => { logs.push(line) }
    await (svc as unknown as { runBootstrapFlow(): Promise<void> }).runBootstrapFlow()
    assert.deepEqual(installed, [], '采用端点后不能再去安装/下载')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.112.0：决策不是 none 时把决策交给执行器，并记录 decision 日志', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bootstrap-run-'))
  const svc = service(dir)
  try {
    const logs: string[] = []
    const installed: string[] = []
    ;(svc as unknown as Record<string, unknown>).tryAdoptLocalEndpoint = async () => false
    // 覆写公开的 execute 方法：无论本机环境如何，只要决定不是 none 就必须被调用。
    ;(svc as unknown as Record<string, unknown>).runBootstrap = async (decision: string) => { installed.push(decision) }
    ;(svc as unknown as Record<string, unknown>).bootstrapLog = (line: string) => { logs.push(line) }
    await (svc as unknown as { runBootstrapFlow(): Promise<void> }).runBootstrapFlow()
    assert.ok(logs.some((line) => line.includes('decision=')), '必须记录自举决策')
    const decision = logs.find((line) => line.includes('decision='))?.replace(/^.*decision=(\S+).*$/, '$1')
    if (decision === 'none') assert.deepEqual(installed, [], 'none 不能执行安装')
    else assert.deepEqual(installed, [decision], '决策必须原样交给执行器')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.112.0：自举流程抛错只写日志，不向外抛', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bootstrap-error-'))
  const svc = service(dir)
  try {
    const logs: string[] = []
    ;(svc as unknown as Record<string, unknown>).tryAdoptLocalEndpoint = async () => { throw new Error('discovery 崩了') }
    ;(svc as unknown as Record<string, unknown>).bootstrapLog = (line: string) => { logs.push(line) }
    await assert.doesNotReject(() => (svc as unknown as { runBootstrapFlow(): Promise<void> }).runBootstrapFlow())
    assert.ok(logs.some((line) => line.includes('自举流程失败')), '异常必须落到 bootstrap.log')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})
