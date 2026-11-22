/**
 * 0.109.0：插件装配层冒烟 —— part/apply 从未被测试 import 的缺口。
 * 用最小 cordis / tools / llm 替身跑一遍 apply，断言四半边都挂上、且单半边失败不影响其它半边。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerHooks } from 'node:module'

const CORDIS_STUB = 'data:text/javascript,' + encodeURIComponent(`export class Service { constructor(ctx, name) { this.ctx = ctx; this.name = name } }`)
const TOOLS_STUB = 'data:text/javascript,' + encodeURIComponent(`export function defineTool(spec) { return spec }`)
const LLM_STUB = 'data:text/javascript,' + encodeURIComponent(`export function createUserMessage(input) { return { role: 'user', content: [{ type: 'text', text: input.text ?? '' }], source: { kind: 'memory' } } }`)

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/cordis') return { url: CORDIS_STUB, shortCircuit: true }
    if (specifier === '@deepseek-ai/dsh-tools') return { url: TOOLS_STUB, shortCircuit: true }
    if (specifier === '@deepseek-ai/dsh-llm') return { url: LLM_STUB, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

// 装配层测试跑**构建产物**（源码入口的路径是给打包器看的相对布局，直接 import 会找不到模块）。
const { apply } = await import(new URL('../../../packages/dsh-memory/lib/index.js', import.meta.url).href)

function fakeCtx() {
  const tools = []
  const routes = []
  const handlers = new Map()
  const skills = { providers: [], registerProvider(provider) { this.providers.push(provider) } }
  const holder = { memory: undefined }
  const ctx = {
    get(name) {
      if (name === 'memory') return holder.memory
      if (name === 'tools') return { register: (tool) => tools.push(tool) }
      if (name === 'webServer') return { register: (route) => routes.push(route) }
      if (name === 'skills') return skills
      return undefined
    },
    get tools() { return { register: (tool) => tools.push(tool) } },
    get memory() { return holder.memory },
    inject(_deps, callback) { callback(ctx) },
    effect(fn) { return fn() },
    plugin(Cls) { holder.memory = new Cls(ctx) },
    on(event, callback) { handlers.set(event, callback) },
    emit() {},
    logger: { warn() {}, info() {} },
  }
  return { ctx, tools, routes, handlers, skills, holder }
}

test('0.109.0：apply 装配四半边：10 个工具 + 面板路由 + 注入监听 + 技能注册', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-assembly-'))
  try {
    const env = fakeCtx()
    apply(env.ctx, { storeDir: dir, scopes: { global: true }, retrieval: { vector: { enabled: false } }, inject: { enabled: false } })
    const names = env.tools.map((tool) => tool.name).sort()
    assert.deepEqual(names, ['memory_block', 'memory_core', 'memory_forget', 'memory_get', 'memory_hooks', 'memory_list', 'memory_maintain', 'memory_save', 'memory_scopes', 'memory_search'])
    assert.ok(env.holder.memory !== undefined, 'provider 必须注册 memory 服务')
    assert.ok(env.routes.some((route) => route.path === '/memory/api'), '面板路由必须注册')
    assert.ok(env.handlers.size > 0, '注入侧必须挂上 pre-step / event 监听')
    assert.ok(env.skills.providers.length > 0, '随包技能必须注册')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.109.0：单半边失败不影响其它半边（part 的隔离语义）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-assembly-isolation-'))
  try {
    const env = fakeCtx()
    // 让面板注册抛错（webServer.register 失败）：工具/注入/技能仍必须挂上。
    env.ctx.get = (name) => {
      if (name === 'webServer') return { register() { throw new Error('webServer 坏了') } }
      if (name === 'memory') return env.holder.memory
      if (name === 'tools') return { register: (tool) => env.tools.push(tool) }
      if (name === 'skills') return env.skills
      return undefined
    }
    apply(env.ctx, { storeDir: dir, scopes: { global: true }, retrieval: { vector: { enabled: false } }, inject: { enabled: false } })
    assert.equal(env.tools.length, 10, '面板失败不应影响工具注册')
    assert.ok(env.handlers.size > 0, '面板失败不应影响注入监听')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
