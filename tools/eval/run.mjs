#!/usr/bin/env node
/**
 * DSH 记忆检索离线评测器 —— 合成记忆集 + 16 组开关矩阵 + 可选 LoCoMo 子集。
 *
 * 这不是性能基准（那是 tools/bench/），它回答的问题是：
 *   「strengthRanking / MMR / 同义合并 / 地板分 这几个开关，到底让检索变好还是变坏？」
 *
 * 用法：
 *   node tools/eval/run.mjs                     # 自动探测 bge-m3；跑合成集 + LoCoMo 子集
 *   node tools/eval/run.mjs --mode synthetic    # 无嵌入服务时只跑合成向量（冒烟）
 *   node tools/eval/run.mjs --no-public         # 只跑合成集，不联网
 *   node tools/eval/run.mjs --seed 7 --k 10     # 换种子 / 换评测深度
 *
 * 输出：tools/eval/out/eval-<时间>.json / .md（out/ 已 gitignore），stdout 同步打印 Markdown。
 * 硬约束：退出码恒 0 —— 嵌入服务不可用、公开集下载失败都只降级/跳过并写进报告。
 *
 * Node ≥ 23.6 直接跑（会 import 项目 .ts 源码）；更老的版本加 --experimental-strip-types。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  DEFAULT_CONFIG,
  buildJson,
  buildMarkdown,
  contentHash,
  loadEmbeddings,
  loadLocomo,
  makeReport,
  fusionStatus,
  prepareIndex,
  repoRoot,
  runMatrix,
  sha256,
} from './lib.mjs'
import { SYNTHETIC_NOW, buildSyntheticCorpus } from './corpus.mjs'

const USAGE = `DSH 记忆检索离线评测器

用法: node tools/eval/run.mjs [选项]

选项:
  --mode <auto|live|synthetic>  嵌入模式。auto=探测 127.0.0.1:8078，失败退回合成（默认 auto）
  --endpoint <url>              嵌入服务地址（默认 $DSH_EVAL_EMBED_ENDPOINT 或 127.0.0.1:8078/v1/embeddings）
  --model <name>                嵌入模型名（默认 bge-m3）
  --dims <n>                    嵌入维度（live 默认 1024，synthetic 默认 256）
  --seed <n>                    合成集随机种子（默认 42；同 seed 必得同语料）
  --k <n>                       评测深度 = topK（默认 5）
  --lexical <both|classic|fusion>
                                词法通道对照。both=经典 + BM25/RRF（默认），classic=只跑经典
  --no-public                   不跑 LoCoMo 公开子集（不联网）
  --public-conv <n>             LoCoMo 用第几个 conversation（默认 0）
  --public-queries <n>          LoCoMo 最多取多少条问题（默认 120）
  --out <dir>                   输出目录（默认 tools/eval/out）
  --quiet                       不把 Markdown 打到 stdout
  --help                        显示本帮助
`

/** 需要记录 hash 的源码文件（报告里用来对齐「这次跑的是哪版实现」）。 */
const TRACKED_MODULES = [
  'source/memory-local/src/scoring.ts',
  'source/memory-local/src/scope.ts',
  'source/memory-local/src/retrieval/eval.ts',
  'source/memory-local/src/retrieval/adapt.ts',
  'source/memory-local/src/retrieval/expand.ts',
  'source/memory-local/src/retrieval/rank.ts',
  'source/memory-local/src/retrieval/retention.ts',
  'source/memory-local/src/retrieval/bm25.ts',
  'source/memory-local/src/retrieval/fusion.ts',
  'source/memory-local/src/cognitive/temporal.ts',
  'source/memory-local/src/index.ts',
  'tools/eval/corpus.mjs',
  'tools/eval/lib.mjs',
  'tools/eval/run.mjs',
]

function parseArgs(argv) {
  const args = {
    mode: 'auto',
    endpoint: undefined,
    model: 'bge-m3',
    dims: undefined,
    seed: 42,
    k: 5,
    lexical: 'both',
    public: true,
    publicConv: 0,
    publicQueries: 120,
    outDir: join(repoRoot, 'tools/eval/out'),
    quiet: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      const value = argv[++i]
      if (value === undefined) throw new Error(`参数 ${arg} 缺少取值`)
      return value
    }
    switch (arg) {
      case '--mode': args.mode = next(); break
      case '--endpoint': args.endpoint = next(); break
      case '--model': args.model = next(); break
      case '--dims': args.dims = Number(next()); break
      case '--seed': args.seed = Number(next()); break
      case '--k': args.k = Number(next()); break
      case '--lexical': args.lexical = next(); break
      case '--no-public': args.public = false; break
      case '--public-conv': args.publicConv = Number(next()); break
      case '--public-queries': args.publicQueries = Number(next()); break
      case '--out': args.outDir = next(); break
      case '--quiet': args.quiet = true; break
      case '--help': case '-h': args.help = true; break
      default: throw new Error(`未知参数：${arg}`)
    }
  }
  if (!['auto', 'live', 'synthetic'].includes(args.mode)) throw new Error(`--mode 只支持 auto/live/synthetic，收到 ${args.mode}`)
  if (!(args.seed >= 0)) throw new Error('--seed 必须是非负数')
  if (!(args.k > 0 && Number.isFinite(args.k))) throw new Error('--k 必须是正数')
  if (!(args.publicQueries > 0)) throw new Error('--public-queries 必须是正数')
  if (!['both', 'classic', 'fusion'].includes(args.lexical)) throw new Error(`--lexical 只支持 both/classic/fusion，收到 ${args.lexical}`)
  return args
}

/** 记录本次运行用到的源码文件 hash（读不到就 null，不让它中断评测）。 */
function moduleHashes() {
  const rows = {}
  for (const relative of TRACKED_MODULES) {
    try {
      rows[relative] = sha256(readFileSync(join(repoRoot, relative), 'utf8')).slice(0, 12)
    } catch {
      rows[relative] = null
    }
  }
  return rows
}

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[:]/g, '')
}

async function evaluateDataset(label, dataset, options, log) {
  const texts = [...dataset.records.map((record) => record.content), ...dataset.queries.map((query) => query.text)]
  const embeddings = await loadEmbeddings(texts, {
    mode: options.mode,
    endpoint: options.endpoint,
    model: options.model,
    dims: options.dims,
    log,
  })
  if (!embeddings.ok) return { status: 'skipped', reason: `嵌入不可用：${embeddings.reason}` }

  const recordCount = dataset.records.length
  const indexVectors = embeddings.vectors.slice(0, recordCount)
  const queryVectors = embeddings.vectors.slice(recordCount)
  const index = prepareIndex(dataset, indexVectors)
  const matrix = runMatrix(dataset, index, queryVectors, { k: options.k, log, lexicalModes: options.lexicalModes })

  return { status: 'ok', embeddings: { kind: embeddings.kind, model: embeddings.model, dims: embeddings.dims, cached: embeddings.cached, note: embeddings.note }, matrix }
}

async function main(argv) {
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write(USAGE)
    return 0
  }
  const log = args.quiet ? () => {} : (message) => process.stderr.write(`${message}\n`)
  const notes = []

  // 词法通道：classic（0.35 已提交路径）与 fusion（工作树 0.40-P0 的 BM25+RRF）。
  // fusion 模块不存在/导入失败时自动只跑 classic，并写进「局限」。
  const fusionInfo = fusionStatus()
  const lexicalModes = args.lexical === 'classic'
    ? ['classic']
    : args.lexical === 'fusion'
      ? (fusionInfo.available ? ['fusion'] : ['classic'])
      : (fusionInfo.available ? ['classic', 'fusion'] : ['classic'])
  args.lexicalModes = lexicalModes
  if ((args.lexical === 'both' || args.lexical === 'fusion') && !fusionInfo.available) {
    notes.push(`BM25/RRF 对照未接入：${fusionInfo.problem ?? '工作树没有 retrieval/bm25.ts 与 retrieval/fusion.ts'}`)
  }
  if (lexicalModes.includes('fusion')) {
    notes.push('fusion 词法通道复刻的是工作树 0.40-P0 WIP（index.ts 的 BM25 补召回 + RRF 排序加成；bm25.ts/fusion.ts 尚未 merge/定稿），这组数字只作对照，合并后需重跑。')
  }
  notes.push('classic 词法通道复刻 0.35 已提交路径：lexicalScore + 查询长度自适应阈值 + 双通道 hybrid 加权。')

  log(`[eval] 仓库 ${repoRoot}`)
  log(`[eval] 模式 ${args.mode}，seed ${args.seed}，k ${args.k}，词法通道 ${lexicalModes.join('+')}`)

  // --- 1) 合成集 ---
  const dataset = buildSyntheticCorpus(args.seed)
  dataset.now = SYNTHETIC_NOW
  const datasetFingerprint = contentHash([...dataset.records.map((record) => record.content), ...dataset.queries.map((query) => query.text)])
  log(`[eval] 合成集：${dataset.records.length} 条记忆 / ${dataset.queries.length} 条查询（${Object.entries(dataset.meta.byType).map(([type, count]) => `${type}=${count}`).join(' ')}）`)

  const syntheticRun = await evaluateDataset('synthetic', dataset, args, log)
  if (syntheticRun.status !== 'ok') {
    notes.push(`合成集未能评测：${syntheticRun.reason}`)
  } else if (syntheticRun.embeddings.note) {
    notes.push(syntheticRun.embeddings.note)
  }

  // --- 2) 公开集（可选）---
  let publicDataset = { status: 'skipped', reason: '按 --no-public 跳过' }
  if (args.public) {
    log('[eval] 载入 LoCoMo 公开子集…')
    const locomo = await loadLocomo({
      conversation: args.publicConv,
      maxQueries: args.publicQueries,
      log,
    })
    if (locomo.status !== 'ok') {
      publicDataset = { status: 'skipped', reason: locomo.reason }
      notes.push(`公开集未接入：${locomo.reason}`)
    } else {
      const run = await evaluateDataset('locomo', locomo.dataset, args, log)
      if (run.status !== 'ok') {
        publicDataset = { status: 'skipped', reason: run.reason }
        notes.push(`LoCoMo 子集未能评测：${run.reason}`)
      } else {
        publicDataset = {
          status: 'ok',
          dataset: locomo.dataset,
          embedding: run.embeddings,
          matrix: run.matrix,
        }
        if (run.embeddings.note) notes.push(`LoCoMo 子集：${run.embeddings.note}`)
      }
    }
  }

  // --- 3) 汇总 ---
  notes.push('评测器复刻的是 memory_search 的纯函数检索路径：词法+向量双通道召回 → 强度排序 → floor/dedupe/MMR 整形；不包含 storage 可见性过滤、LLM 重排、Rocchio 查询扩展、ANN（默认关闭或与召回口径无关）。')
  notes.push('合成集是 group 级标注（同一条知识的中/英/同义三条记录视为同一个答案），dedupe 合并重复条目不扣 recall；旧值记录属于独立 group，排到它上面会正常掉分。')
  notes.push('所有配置共用产品默认门槛（topK=5、recallN=30、vector.minScore=0.5、词法门槛 0.1/0.12、REAL_HIT_FLOOR=0.25），只切换 strengthRanking/MMR/dedupe/floor 四个开关。')
  notes.push('LoCoMo 子集是"单会话对话轮次检索"，标注用 evidence dia_id，不是 LoCoMo 官方 QA 准确率口径，不能与任何公开发表的 LoCoMo 分数直接比较。')
  notes.push('本报告只报告本次运行实测数字，不引用、不背书其他项目的基准分数。')
  if (syntheticRun.status === 'ok' && syntheticRun.embeddings.kind === 'synthetic') {
    notes.push('本次嵌入是合成向量（词袋哈希），只能反映词法重合，跨语言/同义改写的数字不代表 bge-m3 的真实表现；基线对比仍然有效，但绝对分数不可外推。')
    notes.push('合成向量模式下 LoCoMo 子集的召回同样只具词法意义。')
  }

  const source = moduleHashes()
  const report = makeReport({
    options: {
      command: `node tools/eval/run.mjs${process.argv.slice(2).map((part) => ` ${part}`).join('')}`,
      mode: args.mode,
      endpoint: args.endpoint ?? process.env.DSH_EVAL_EMBED_ENDPOINT ?? process.env.DSH_BENCH_EMBED_ENDPOINT ?? 'http://127.0.0.1:8078/v1/embeddings',
      model: args.model,
      seed: args.seed,
      k: args.k,
      lexicalModes,
      public: args.public,
      publicConversation: args.publicConv,
      publicQueries: args.publicQueries,
    },
    sourceModules: source,
    dataset: {
      ...dataset.meta,
      contentHash: datasetFingerprint,
      // 报告里不存整份语料（体积/隐私），只存指纹；要复现直接跑脚本。
    },
    embedding: syntheticRun.status === 'ok' ? syntheticRun.embeddings : { kind: 'unavailable', model: args.model, dims: 0, cached: false },
    matrix: syntheticRun.status === 'ok' ? syntheticRun.matrix : { k: args.k, lexicalModes, matrices: {} },
    publicDataset,
    notes,
  })

  // 矩阵里每条查询的明细只在 JSON 里保留，Markdown 不展开（48 条 × 16 组太长）。
  if (!args.quiet) {
    const markdown = buildMarkdown(report)
    mkdirSync(args.outDir, { recursive: true })
    const slug = timestampSlug()
    const jsonPath = join(args.outDir, `eval-${slug}.json`)
    const mdPath = join(args.outDir, `eval-${slug}.md`)
    writeFileSync(jsonPath, buildJson(report))
    writeFileSync(mdPath, markdown)
    writeFileSync(join(args.outDir, 'latest.json'), buildJson(report))
    writeFileSync(join(args.outDir, 'latest.md'), markdown)
    process.stdout.write(markdown)
    log(`[eval] 输出：${jsonPath}`)
    log(`[eval] 输出：${mdPath}`)
  } else {
    mkdirSync(args.outDir, { recursive: true })
    const slug = timestampSlug()
    writeFileSync(join(args.outDir, `eval-${slug}.json`), buildJson(report))
    writeFileSync(join(args.outDir, `eval-${slug}.md`), buildMarkdown(report))
    writeFileSync(join(args.outDir, 'latest.json'), buildJson(report))
    writeFileSync(join(args.outDir, 'latest.md'), buildMarkdown(report))
    log(`[eval] 完成（--quiet，结果写入 ${args.outDir}）`)
  }

  return 0
}

// 退出码恒 0：评测脚本失败不应把 CI 搞红（报告/日志里能看到原因）。
try {
  await main(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`[eval] 评测失败（exit 0）：${error?.stack ?? error}\n`)
}
process.exitCode = 0
