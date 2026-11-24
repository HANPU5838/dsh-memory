/**
 * Verify the PUBLISHED packages the way a user's install looks.
 *
 *   node tools/verify-installed-packages.mjs <node_modules-parent-dir> [--scope @hanpu5838]
 *
 * The dir must contain node_modules/@scope/dsh-memory and .../dsh-memory-panel
 * (i.e. the result of `npm install @scope/dsh-memory @scope/dsh-memory-panel`).
 *
 * Checks, in order:
 *   1. both package dirs exist with their expected files
 *   2. each cordis.patch.yml parses and names only specifiers from this scope
 *   3. every entry imports under plain node (the host's packages are exposed
 *      through a junction, exactly like the real host resolves them)
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const dir = resolve(process.argv[2] ?? '')
const scopeArg = process.argv.indexOf('--scope')
const SCOPE = scopeArg >= 0 ? process.argv[scopeArg + 1] : '@hanpu5838'
const CORE = `${SCOPE}/dsh-memory`
const PANEL = `${SCOPE}/dsh-memory-panel`
if (!dir || !existsSync(join(dir, 'node_modules'))) {
  console.error('usage: node tools/verify-installed-packages.mjs <dir-with-node_modules> [--scope @scope]')
  process.exit(2)
}

const hostAi = resolve(import.meta.dirname, 'asar-extract', 'dsh', 'node_modules', '@deepseek-ai')
const coreDir = join(dir, 'node_modules', ...CORE.split('/'))
const panelDir = join(dir, 'node_modules', ...PANEL.split('/'))
let bad = 0

// 1) layout -----------------------------------------------------------------
for (const [label, pkgDir, mustHave] of [
  ['core', coreDir, ['package.json', 'cordis.patch.yml', 'README.md', 'LICENSE', 'lib/provider/apply.js', 'lib/tools/apply.js', 'lib/inject/apply.js']],
  ['panel', panelDir, ['package.json', 'cordis.patch.yml', 'README.md', 'lib/index.js', 'lib/client.js']],
]) {
  if (!existsSync(pkgDir)) { console.error(`MISSING package dir: ${label} (${pkgDir})`); bad++; continue }
  for (const rel of mustHave) {
    if (!existsSync(join(pkgDir, rel))) { console.error(`MISSING ${label}/${rel}`); bad++ }
  }
  const meta = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  console.log(`${label}: ${meta.name}@${meta.version} — ${meta.description?.slice(0, 48) ?? ''}`)

  // Invariant that cost a boot failure on 2026-10-10: a client bundle must
  // register under the PACKAGE NAME. client-modules keys graph rows by package
  // name; a bundle declaring anything else makes the host fall back to
  // re-fetching it, which registers the factory twice and aborts the web boot
  // with "duplicate factory registration".
  if (meta.dsh?.client && existsSync(join(pkgDir, 'lib', 'client.js'))) {
    const source = readFileSync(join(pkgDir, 'lib', 'client.js'), 'utf8')
    const declared = source.match(/__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/)?.[1]?.replace(/\/client$/, '')
    if (declared !== meta.name) {
      console.error(`  CLIENT ID MISMATCH: bundle registers "${declared}" but the package is "${meta.name}"`)
      bad++
    } else {
      console.log('  client id matches package name ✓')
    }
  }
}

// 2) patches ----------------------------------------------------------------
const yaml = require(join(import.meta.dirname, 'asar-extract', 'dsh', 'node_modules', 'js-yaml'))
for (const [label, pkgDir] of [['core', coreDir], ['panel', panelDir]]) {
  if (!existsSync(join(pkgDir, 'cordis.patch.yml'))) continue
  try {
    const doc = yaml.load(readFileSync(join(pkgDir, 'cordis.patch.yml'), 'utf8'))
    const rows = (doc ?? []).filter((e) => e.insert).flatMap((e) => e.insert)
    console.log(`patch ${label}: ${rows.length} insert(s) -> ${rows.map((r) => r.id).join(', ')}`)
    for (const r of rows) {
      if (typeof r.name !== 'string' || !r.name.startsWith(`${SCOPE}/`)) {
        console.error(`  BAD specifier in ${label}: ${r.id} = ${r.name}`); bad++
      }
    }
  } catch (error) {
    console.error(`patch ${label} FAILED to parse: ${error.message}`); bad++
  }
}

// 3) entries load -----------------------------------------------------------
const aiDir = join(dir, 'node_modules', '@deepseek-ai')
const createdJunction = !existsSync(aiDir)
if (createdJunction) {
  try { symlinkSync(hostAi, aiDir, 'junction') } catch { /* fall through to the import error */ }
}
const entries = [
  `${CORE}/lib/provider/apply.js`,
  `${CORE}/lib/tools/apply.js`,
  `${CORE}/lib/inject/apply.js`,
  `${PANEL}/lib/index.js`,
]
for (const rel of entries) {
  const target = join(dir, 'node_modules', ...rel.split('/'))
  if (!existsSync(target)) { console.error(`MISSING entry ${rel}`); bad++; continue }
  try {
    const mod = await import(pathToFileURL(target).href)
    const ok = typeof mod.apply === 'function'
    console.log(`loaded ${rel} -> apply=${typeof mod.apply} name=${mod.name ?? '(none)'} inject=${JSON.stringify(mod.inject ?? [])}`)
    if (!ok) bad++
  } catch (error) {
    console.error(`LOAD FAIL ${rel}: ${error.message}`); bad++
  }
}
if (createdJunction) rmSync(aiDir, { recursive: true, force: true })

// a human-readable size summary, ignoring the injected junction
let files = 0, bytes = 0
for (const pkgDir of [coreDir, panelDir]) {
  if (!existsSync(pkgDir)) continue
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else { files++; bytes += statSync(p).size }
    }
  }
  walk(pkgDir)
}
console.log(`installed payload: ${files} files, ${(bytes / 1024).toFixed(1)} KiB`)
console.log(bad === 0 ? '\nVERIFY OK' : `\nVERIFY FAILED (${bad} problem(s))`)
void mkdtempSync; void tmpdir
process.exit(bad === 0 ? 0 : 1)
