/**
 * 单包产物契约测试。
 *
 * 这几条断言对应的都是**静默失败**:错了不会报错,只会「面板不见了」「更新装不上」
 * 或者「桌面端起不来」。所以要有一条会失败的检查,而不是靠人记得。
 *
 * 读的是已构建并提交的 packages/dsh-memory(与 dsh-market 的 preflight 同一思路:
 * 护栏放在产物上,而不是放在人的习惯里)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const PKG = join(ROOT, 'packages', 'dsh-memory')

function need(file) {
  const path = join(PKG, file)
  assert.ok(existsSync(path), `${file} 不存在 —— 先跑 npm run build`)
  return readFileSync(path, 'utf8')
}

test('0.102.0：files 清单里的每个路径都真实存在（缺文件 = 安装后静默失效）', () => {
  const meta = JSON.parse(need('package.json'))
  for (const entry of meta.files ?? []) {
    assert.ok(existsSync(join(PKG, entry)), `${entry} 在 files 里但产物中不存在`)
  }
  for (const required of ['lib/index.js', 'lib/client.js', 'locale/zh.json', 'locale/en.json', 'icon.png', 'README.md', 'CHANGELOG.md', 'LICENSE', 'cordis.patch.yml']) {
    assert.ok(existsSync(join(PKG, required)), `${required} 缺失`)
  }
})

test('0.102.0：locale 可解析且中英键位一致', () => {
  const zh = JSON.parse(need('locale/zh.json'))
  const en = JSON.parse(need('locale/en.json'))
  const keys = (obj) => Object.keys(obj).sort()
  assert.deepEqual(keys(zh), keys(en), 'zh/en 顶层键必须一致')
  assert.ok(typeof zh.meta?.title === 'string' && zh.meta.title.length > 0, 'zh 不能是空壳')
})

test('0.102.0：产物版本与根 package.json 版本一致', () => {
  const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const packed = JSON.parse(need('package.json'))
  assert.equal(packed.version, root.version, '产物版本落后于仓库版本——先跑 npm run build')
  assert.equal(packed.name, '@restregular/dsh-memory')
})

test('单包声明:一个包同时带 host patch 与 client bundle', () => {
  const meta = JSON.parse(need('package.json'))
  assert.equal(meta.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(meta.dsh?.client?.platform, 'web')
  // 客户端 bundle 必须能从包外解析(exports["./client"]),否则宿主拿不到它
  assert.equal(meta.exports?.['./client'], './lib/client.js')
  assert.equal(meta.exports?.['.'], './lib/index.js')
  assert.deepEqual(meta.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-slots'])
})

test('patch 只有一行,而且 name 就是包名', () => {
  const meta = JSON.parse(need('package.json'))
  const patch = need('cordis.patch.yml')
  const names = [...patch.matchAll(/^\s*name:\s*'([^']+)'/gm)].map((m) => m[1])
  const ids = [...patch.matchAll(/^\s*-\s*id:\s*(\S+)/gm)].map((m) => m[1])
  // 一个包名只能有一个解析源:多行(哪怕是子路径)会让 dsh-client-modules 的
  // reconcilePackage 抛 "resolves from multiple active Loader sources"。
  assert.equal(names.length, 1, `patch 必须恰好一行 insert,实际 ${names.length} 行`)
  assert.equal(ids.length, 1)
  assert.equal(names[0], meta.name)
  // 纯 insert(不带 config)才能被宿主热挂载
  assert.ok(!/^\s*config:/m.test(patch), 'patch 不应含 config 行(会让热挂载退化为重启生效)')
})

test('客户端 bundle 的注册 id 等于包名', () => {
  const meta = JSON.parse(need('package.json'))
  const client = need('lib/client.js')
  const declared = client.match(/__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/)
  assert.ok(declared, 'lib/client.js 缺少 window.__ModuleLoader__.load({ id: … }) 注册')
  // 声明成别的名字 → 宿主按包名找不到图行 → 回退重拉 → 二次注册 → web 启动失败
  assert.equal(declared[1], meta.name)
})

test('插件列表里显示中文名 / 描述,而不是包名', () => {
  const meta = JSON.parse(need('package.json'))
  const expected = [
    ['zh', '记忆系统'],
    ['en', 'Memory System'],
  ] as const
  for (const [lang, title] of expected) {
    // 宿主用 Node ESM 解析 `<包>/locale/<lang>.json`;exports 少一行就静默回退成包名
    assert.equal(meta.exports?.[`./locale/${lang}.json`], `./locale/${lang}.json`, `exports 必须导出 locale/${lang}.json`)
    const locale = JSON.parse(need(`locale/${lang}.json`))
    assert.equal(locale.meta?.title, title)
    assert.ok(locale.meta?.description?.length > 0, `locale/${lang}.json 缺描述`)
  }
})

test('图标:包内 PNG,体积在宿主上限(512 KiB)内', () => {
  const meta = JSON.parse(need('package.json'))
  assert.equal(meta.icon, './icon.png')
  const bytes = readFileSync(join(PKG, 'icon.png'))
  assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'icon.png 必须是 PNG 图像')
  assert.ok(bytes.length < 512 * 1024, 'icon.png 超过宿主 512 KiB 上限')
})

test('入口是一个,并且四条半边都在里面', () => {
  const entry = need('lib/index.js')
  for (const spec of ['./provider/apply.js', './tools/apply.js', './inject/apply.js', './panel.js']) {
    assert.ok(entry.includes(`'${spec}'`), `入口缺少 ${spec}(构建的相对路径改写没生效?)`)
  }
  // 半边各自 try/catch:任何一半抛错都不许把 DSH 启动带崩
  assert.match(entry, /catch/)
})

test('产物里没有残留的 .ts 说明符', () => {
  for (const file of ['lib/index.js', 'lib/provider/apply.js', 'lib/tools/apply.js', 'lib/inject/apply.js']) {
    const code = need(file)
    assert.ok(!/from\s*'\.[^']*\.ts'/.test(code), `${file} 仍 import 了 .ts`)
  }
})
