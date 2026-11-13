/**
 * dsh-memory-local — local JSONL provider for the DSH memory service.
 *
 * This entry is intentionally cordis-free so unit tests and standalone tools
 * run without the harness. The Cordis wiring (Service subclass, effects,
 * plugin apply) lives in ./apply.ts and is only loaded inside DSH.
 */
             
            
                  
              
               
                  
              
                   
                   
import { MemoryStore, newId, scopeFileName, isDormantRecord, isTombstonedRecord,                 } from './store.js'
import {
  canonicalWorkspacePath,
  defaultScopeDescription,
  isCustomScope,
  normalizeScopeInput,
  normalizeScopeKey,
  projectScopeIdentity,
  resolveCurrentScopes,
  scopeKind,
  scopeTier,
  writeScopeForDefault,
                
} from './scope.js'
import { ScopeNames } from './scope-names.js'
import {
  SessionVisibilityStore,
  cleanVisibilityRules,
                               
                       
                      
} from './session-visibility.js'
import { WorkspaceBindingsStore } from './workspace-bindings.js'
import { SessionGrantsStore,                                       } from './grants.js'
import { ApprovalAuditStore,                         } from './approval-audit.js'
import {
  authorize as authorizeAccess,
                     
                      
                     
} from './authorize.js'
import {
  MAX_SCOPE_DESCRIPTION_CHARS,
  ScopeMetaStore,
  pruneEmptySessionScopes,
                 
                   
} from './scope-meta.js'
import { mergeInjectSettings, normalizeInjectSettings,                     } from './inject-settings.js'
import { buildStats, lexicalScore, recordScore, tokenize, cosine, normalizeInPlace, isGenericOnlyQuery, hasContentHit, finalFloor, semanticDedupe, mmrSelect } from './scoring.js'
import { adaptiveScopeThreshold, calibrateScore } from './retrieval/adapt.js'
import { blendHybrid, expandQuery, expandQueries, hybridWeights, queryProfile } from './retrieval/expand.js'
import { buildBm25Docs, bm25Score, rankByBm25 } from './retrieval/bm25.js'
import { reciprocalRankFusion, normalizeScores } from './retrieval/fusion.js'
import { explainCandidate } from './retrieval/rank.js'
import { initialStrength, updateAfterUse } from './retrieval/retention.js'
import { temporalBoost } from './cognitive/temporal.js'
import { assessContradiction } from './cognitive/contradiction.js'
import { applyConsolidationPlan, clusterRecords, planConsolidation } from './cognitive/consolidate.js'
import { computeHealth,                   } from './cognitive/health.js'
import { AnalysisRepository } from './analysis/store.js'
import { analyzeMemories } from './analysis/engine.js'
import { entityNodeId, extractEntities } from './analysis/entities.js'
import {
                      
                    
                     
                    
                      
                        
                     
                      
                      
                    
} from './analysis/types.js'
import { resolveConflict, applyConflictResolution } from './cognitive/resolve.js'
import { scanMemoryContent, quarantineRecord, clearQuarantine } from './cognitive/guard.js'
import { MERGE_THRESHOLD, planNearDuplicateMerge } from './cognitive/merge.js'
import { assessConflicts, applyConflictMarker, hasCriticalDetailConflict } from './cognitive/conflict.js'
import { isRecordVisible, revive, tombstone, purgeTombstones, markDormant, restore as restoreTombstoned, snapshot as writeSnapshot, restoreSnapshot as readSnapshotFile } from './cognitive/lifecycle.js'
import { createEmbeddingProvider,                                                    } from './embedding-providers.js'
import { discoverLocalEndpoint,                         } from './endpoint-discovery.js'
import { canExecute, describePlatform, detectPlatform, detectRuntimeEnvironment, findSystemLlamaServer, freeDiskBytes } from './platform.js'
import { DailyBudget, blendScores, rerank,                                   } from './rerank.js'
import { RerankCache } from './rerank-cache.js'
import { scanSecrets, redactSecrets } from './secrets.js'
import { EmbedServerManager,                                               } from './embed-server.js'
import { VectorInstaller, detectInstalled, installPaths, supportsManagedRuntime,                      } from './embed-install.js'
import { EmbedCache } from './embed-cache.js'
import { createAnnIndex, shouldUseAnn,                             } from './ann/index.js'
import { EmbedKeepAlive } from './embed.js'
import { MemoryEventBus } from './events.js'
import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import {
  DEFAULT_MODEL_ID,
  EMBEDDING_MODELS,
  findModel,
  findVariant,
                   
} from './models.js'
import { probeHardware,                                       } from './hardware.js'
import { pickFlavor, recommendModel } from './recommend.js'

/**
 * 一条权限变更（授予 / 撤销）。面板改名「记忆权限」后，工具授予与面板撤销
 * 都通过它进入注入链路，Agent 下一轮就能看到自己的权限边界变了。
 */
                                         
                              
               
                                
                      
 

/** 注入半边要的权限快照：本次变更 + 当前有效授权。 */
                                       
                                   
                      
 

/** Recursive byte count; 0 for anything unreadable. */
function pathSize(path        )         {
  try {
    const st = statSync(path)
    if (!st.isDirectory()) return st.size
    let total = 0
    for (const entry of readdirSync(path)) total += pathSize(join(path, entry))
    return total
  } catch {
    return 0
  }
}

/** True when `child` is `parent` or lives under it (both resolved). */
function isInside(parent        , child        )          {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

                                    
                                                  
                   
     
                                                                    
                                                                
     
            
                    
                     
                     
                                                          
   
               
                 
                    
                                                     
                            
                                                                                    
                             
                                
              
                       
         
                                                        
                                                 
                                                                         
                                                          
         
                                             
         
                                                   
                                     
        
                                                 
                                                   
                                                   
                                  
        
                                                       
                                   
                                                          
         
                                               
         
                                                      
                                                              
                                                      
         
                                                      
                                                              
                     
                       
                                                      
                    
                   
         
                                                           
                                 
         
                     
                                                       
                      
                                               
                     
                   
                                  
                     
                    
                             
                      
                                    
                          
       
                                                                    
                           
                                                          
                                     
                                                             
                        
                                                            
                        
                                                               
                             
                                                                               
                                
                                                                             
                               
                       
         
                                 
        
                                                       
                                                         
                                                  
                                                
                                                          
         
                                                                                 
                                          
                          
                                                   
                                                     
                                
                                   
                     
                                                    
                       
                                      
                         
                                                                
             
                         
                        
                                 
                  
                               
                         
       
                                                                                      
                               
         
                                                                               
                                                                   
                                                                             
                                                                             
                                                                      
         
                     
                    
           
                                                                      
                                                                             
                                                                      
           
                               
       
     
                               
                                             
                       
                                      
                            
                                   
                 
                                                   
                      
                                                   
                             
                                          
                               
                                                       
                                                    
                                
                                                                              
                               
                                                                                                                                           
                                       
                                                                                 
   
                                                                                                                                         
                                               
               
                                                     
                                                            
                                                                                                    
                                                         
                                                                                   
   
                                                                           
                                                             
 

                                 
                  
                        
                         
                                                               
                         
                                                     
                        
                                                  
                         
              
                 
                         
                          
                      
           
                    
                                                                                      
                       
                               
                            
                                                                                   
                       
                                                                                    
                                  
                                                              
                                                                      
                                              
                    
                     
                      
                                                     
                        
                                            
                                  
                               
                     
                                           
                        
                           
                                
                                   
                                              
                             
                                                      
                  
                    
                 
                
                     
                          
                             
                            
                    
                       
                                                              
                             
                            
                  
                    
                            
                      
                           
          
                      
                     
                              
                
                             
                       
     
                            
                        
                                              
                                                              
                            
                                    
                                                
                         
                                            
                                                      
                          
   
                   
                            
                                
                        
                                                          
                                       
            
                 
                           
                
                     
   
                                      
              
                         
                          
                            
                                 
                            
                                
                         
                                 
                                  
                                    
   
 

/** vector 配置节的类型别名,给下面的模型解析helpers 用。 */
                                                                                           

/** 面板可以在安装时临时指定的模型选择。 */
                                
                 
                  
                                                                                                                  
                                 
 

/**
 * 「面板选过什么」的记忆,落在安装目录里(<installRoot>/selected-model.json)。
 *
 * 为什么需要它:面板没法改写 profile 配置,而"选了模型 → 重启后配置又指回老模型"
 * 会让装好的模型认不出来。这里是**低于配置**的一层记忆:配置里写了 preset/customModel
 * 就听配置的,没写才用这份。
 */
export const MODEL_STATE_FILE = 'selected-model.json'

                      
                   
                    
                                       
                                 
 

function readModelState(root        )                    {
  try {
    const text = readFileSync(join(root, MODEL_STATE_FILE), 'utf8')
    const parsed = JSON.parse(text)              
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function writeModelState(root        , state            )       {
  try {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, MODEL_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  } catch {
    // 记不住不影响本次安装;下次面板仍会显示配置文件里的选择。
  }
}

/** 系统语言(用来判断"中文优先");拿不到就当英文环境。 */
function safeLocale()         {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || 'en'
  } catch {
    return 'en'
  }
}

/** 该模型某个档位的体积(不指定档位时用默认档),用于清单展示与磁盘校验。 */
function variantBytes(model                                                                         , variantId         )         {
  const variant = variantId !== undefined ? model.variants.find((v) => v.id === variantId) : undefined
  return (variant ?? model.variants.find((v) => v.isDefault) ?? model.variants[0] ).bytes
}

                          
                  
                   
               
              
                
                   
              
                      
                                           
                   
                      
                         
                                 
 

/**
 * 把配置里的模型选择解析成安装器要的形态(文件名 / 体积 / 源 / 维度 / pooling / 前缀)。
 *
 * 优先级:customModel(完全自定义) → preset(清单 id) → 用 `model` 字符串去清单里找
 * → 内置默认(bge-m3 Q4_K_M,与老行为逐字一致)。
 * 认不出的 `model` 字符串**不改身份**(请求与边车仍用它),只是安装器退回默认模型 ——
 * 用户指向云端/自建服务时本来就该只写 endpoint + model + dims。
 */
function resolveModelSelection(v                   , root         )                 {
  const state = root !== undefined ? readModelState(root) : null
  const custom = v.customModel ?? state?.customModel
  if (custom !== undefined) {
    let file = custom.file
    if (file === undefined || file === '') {
      try {
        file = basename(new URL(custom.url).pathname) || 'custom-model.gguf'
      } catch {
        file = 'custom-model.gguf'
      }
    }
    return {
      presetId: 'custom',
      variantId: 'custom',
      label: file,
      file,
      ...(custom.bytes !== undefined ? { bytes: custom.bytes } : {}),
      sources: custom.sources ?? [custom.url],
      dims: custom.dims,
      pooling: custom.pooling ?? 'auto',
      modelName: v.model ?? file.replace(/\.gguf$/i, ''),
      ...(v.flavor ?? state?.flavor ? { flavor: v.flavor ?? state?.flavor } : {}),
    }
  }
  // 配置 > 面板的记忆 > 用 model 字符串去清单里找 > 内置默认。
  const presetId = v.preset
    ?? state?.presetId
    ?? (findModel(v.model) !== undefined ? v.model           : DEFAULT_MODEL_ID)
  const model = findModel(presetId) ?? findModel(DEFAULT_MODEL_ID) 
  const variant = findVariant(model, v.variant ?? state?.variantId)
  return {
    presetId: model.id,
    variantId: variant.id,
    label: `${model.label} · ${variant.label}`,
    file: variant.file,
    bytes: variant.bytes,
    sources: [...variant.sources],
    dims: model.dims,
    pooling: model.pooling,
    modelName: v.model ?? model.id,
    ...(model.queryPrefix !== undefined ? { queryPrefix: model.queryPrefix } : {}),
    ...(model.documentPrefix !== undefined ? { documentPrefix: model.documentPrefix } : {}),
    ...(v.flavor ?? state?.flavor ? { flavor: v.flavor ?? state?.flavor } : {}),
  }
}

/**
 * 接管已装好的后端时,spawn 该用哪个模型文件。
 *
 * 坑:换模型时 `spawn.model` 可能还留着**上一个**模型的路径(显式配置或上次 adopt
 * 写进去的),而 dims/pooling 已经跟着新模型变了 —— 那会启动一个"模型与参数不匹配"
 * 的服务,而且不报错,只是检索质量悄悄变差。所以只有"配置的模型就是当前选中的那个"
 * 才沿用它,否则一律用刚落盘的那份。
 */
export function pickSpawnModel(currentFile        , configuredModel                    , installedModel        )         {
  if (configuredModel !== undefined && basename(configuredModel) === currentFile) return configuredModel
  return installedModel
}

const VECTOR_OVERRIDE_FILE = 'vector.json'

/** 读取面板持久化的 provider 覆盖；文件不存在 / 内容非法都返回 null。 */
function readProviderOverride(storeDir        )                               {
  try {
    const raw = JSON.parse(readFileSync(join(storeDir, VECTOR_OVERRIDE_FILE), 'utf8'))                          
    const kind = raw.provider
    return kind === 'local' || kind === 'openai' || kind === 'ollama' || kind === 'off' ? kind : null
  } catch {
    return null
  }
}

/**
 * endpoint 没配 provider 时按地址推断后端类型：
 *  - 未配置 / 回环地址（127.0.0.1、localhost、::1）→ local（插件自己拉 llama-server）
 *  - 其它地址 → openai（任意 OpenAI 兼容服务；这是最常见的「远程/云端」用法）
 * 显式配置的 provider 永远优先。
 */
export function inferProviderKind(endpoint                    )                        {
  if (endpoint === undefined || endpoint.trim() === '') return 'local'
  try {
    const host = new URL(endpoint).hostname.toLowerCase()
    if (host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]') return 'local'
    return 'openai'
  } catch {
    return 'local'
  }
}

/**
 * 0.33.0：只挑出调用方**显式给的**记忆强度字段（导入 / 快照恢复会带）。
 * 用来覆盖 initialStrength() 的默认值，同时避免把整份 saveInput 再展开一次
 * （那份里含未规范化的 scope/content，会覆盖已经归一好的值）。
 */
function explicitStrengthFields(input                         )                         {
  const out                         = {}
  for (const key of ['stability', 'difficulty', 'utility', 'useCount', 'lastUsedAt']         ) {
    const value = input[key]
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
  }
  return out
}

/**
 * 探测 host:port 是否已被占用（能连上 = 被占）。超时/连不上都算空闲。
 * 端口回退用：8078 被别的进程占着时，不要直接让后端启动失败。
 */
export function probePortBusy(host        , port        , timeoutMs = 250)                   {
  return new Promise((resolve) => {
    let settled = false
    const socket = createConnection({ host, port })
    const finish = (busy         )       => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch { /* best effort */ }
      resolve(busy)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

/** 从 start 起找第一个空闲端口（最多扫 count 个）；全占满返回 null。导出便于测试。 */
export async function pickFreePort(
  host        ,
  start        ,
  count = 20,
  isBusy                                                   = probePortBusy,
)                         {
  for (let port = start; port < start + count; port += 1) {
    if (!(await isBusy(host, port))) return port
  }
  return null
}

/**
 * 自举动作：
 *  - none           什么也不做
 *  - install-package 用系统包管理器装 llama.cpp（目前只对 Termux 自动执行）
 *  - download-model  系统已有 llama-server，只补模型
 *  - managed-install 让插件下载托管运行时 + 模型（任何被支持的平台）
 */
                                                                                                     

                                       
                                                           
                                          
                                 
                             
                        
                     
                                                      
                 
                                                    
                          
                                            
                 
                                                    
                           
 

/**
 * 自举决策（纯函数，便于测试）：让插件按「这台机器实际有什么」自动适配，
 * 而不是把某个设备写死。决策顺序：
 *
 *  1. 任何显式配置优先（endpoint / spawn / 已安装）——自举只补「什么都没配」；
 *  2. provider 必须是 local（用户指定 openai/ollama/off 时不抢）；
 *  3. 系统已有 llama-server → 只补模型（跨平台通用，省一整份运行时下载）；
 *  4. Termux/Android 且能 `pkg install` → 自动装包（bionic 原生，免 glibc）；
 *  5. `autoBootstrap: 'always'` 且本平台有托管资产 → 下载托管运行时 + 模型；
 *  6. 其余一律不动（桌面端默认不被悄悄下 400MB）。
 */
export function planVectorBootstrap(input                      )                        {
  if (input.autoBootstrap === 'off') return 'none'
  if (input.provider !== 'local') return 'none'
  if (input.endpointConfigured || input.spawnExplicit || input.configured) return 'none'
  if (input.hasSystemServer) return 'download-model'
  if (input.termux && input.hasPkg) return 'install-package'
  if (input.autoBootstrap === 'always' && input.managedSupported) return 'managed-install'
  return 'none'
}

export function resolveConfig(config                    = {})                 {
  const v = config.retrieval?.vector ?? {}
  // Do not touch an embedding backend the user never asked for: pointing at the
  // stock localhost endpoint on a machine that has nothing listening means
  // failed embeds, a tripped breaker and scary log lines for a feature that is
  // optional. Vector retrieval is therefore opt-in by CONFIGURATION — writing
  // `endpoint` (any OpenAI-compatible service), configuring `spawn`, or having
  // the panel's installer put a backend on disk implies intent; an explicit
  // `enabled` always wins.
  // 默认必须是**绝对路径**：相对路径会跟着进程 cwd 走，换个目录启动 `dsh web`
  // 就会得到一套全新的空库（旧记忆"凭空消失"），cwd 只读时甚至让整个 provider
  // 静默消失。默认落到 ~/.dsh-memory；显式配了相对路径也按 homedir 解析，保证
  // 同一个配置在任何启动目录下都是同一个库。
  const storeDir = config.storeDir === undefined
    ? join(homedir(), '.dsh-memory')
    : (isAbsolute(config.storeDir) ? config.storeDir : join(homedir(), config.storeDir))
  // Installer target: explicit config → that directory; explicit storeDir →
  // its parent (so a hand-made `<root>/llamacpp` + `<root>/models` layout is
  // recognised as-is); otherwise a stable per-user directory under ~/.dsh.
  const installRoot = v.autoInstall?.dir
    ?? (config.storeDir !== undefined ? dirname(resolve(storeDir)) : join(homedir(), '.dsh', 'memory-vector'))
  // 模型选择:自定义 → 显式 preset → 用 model 字符串去清单里找 → 内置默认。
  // 这一步必须在 detectInstalled 之前:安装判据是「exe + **所选模型的**文件」。
  const selection = resolveModelSelection(v, installRoot)
  // 运行时来源：能 `pkg install llama-cpp` 的环境（Termux/Android）优先用系统
  // llama-server —— bionic 原生二进制，既不用下载 ubuntu 构建，也不用 Termux
  // glibc 兼容层。托管运行时已存在时保持原行为（auto 下托管优先）。
  const runtimeMode = v.runtime ?? 'auto'
  const systemExe = runtimeMode === 'managed' ? null : findSystemLlamaServer()
  const installed = detectInstalled(installRoot, selection.file, {
    systemExe,
    preferSystem: runtimeMode === 'system',
  })
  const endpointConfigured = v.endpoint !== undefined
  // A configured spawn path that no longer exists (plugin uninstalled the
  // backend, or the user moved it) must not count as configured: that would
  // leave the panel showing a managed server that can never start, instead of
  // offering the download button again.
  const spawnExe = v.spawn?.exe
  const spawnExeUsable = spawnExe === undefined || spawnExe === '' || existsSync(spawnExe)
  const spawnExplicit = (v.spawn?.exe ?? '') !== '' || v.spawn?.enabled === true
  const spawnConfigured = (spawnExplicit && spawnExeUsable) || installed !== null
  const configured = endpointConfigured || spawnConfigured
  const vectorEnabled = v.enabled ?? configured
  const flavor = selection.flavor ?? 'cpu'
  // scopes.custom 既可能是布尔(简写)也可能是对象 —— 两种都要认,旧配置(只有
  // global/project 两个布尔)当然照常工作。
  const customCfg = config.scopes?.custom
  const customEnabled = typeof customCfg === 'boolean' ? customCfg : (customCfg?.enabled ?? true)
  const customMax = typeof customCfg === 'object' && customCfg !== null && typeof customCfg.max === 'number'
    ? customCfg.max
    : 200
  return {
    storeDir,
    globalEnabled: config.scopes?.global ?? true,
    projectEnabled: config.scopes?.project ?? true,
    sessionEnabled: config.scopes?.session ?? true,
    customEnabled,
    customMaxScopes: customMax,
    topK: config.retrieval?.topK ?? 5,
    recallN: config.retrieval?.recallN ?? 30,
    globalThreshold: config.retrieval?.globalThreshold ?? 0.12,
    projectThreshold: config.retrieval?.projectThreshold ?? 0.1,
    halfLifeDays: config.retrieval?.recencyHalfLifeDays ?? 30,
    vector: {
      enabled: vectorEnabled,
      configured,
      endpointConfigured,
      spawnConfigured,
      installRoot,
      runtimeMode,
      systemExe,
      runtimeSource: installed === null ? 'none' : (installed.system === true ? 'system' : 'managed'),
      autoBootstrap: v.autoBootstrap ?? 'off',
      spawnExplicit,
      ...(v.autoInstall?.modelSources ? { installModelSources: v.autoInstall.modelSources } : {}),
      installModel: {
        file: selection.file,
        ...(selection.bytes !== undefined ? { bytes: selection.bytes } : {}),
        ...(selection.sources.length > 0 ? { sources: selection.sources } : {}),
      },
      presetId: selection.presetId,
      variantId: selection.variantId,
      modelLabel: selection.label,
      pooling: v.pooling ?? selection.pooling,
      flavor,
      gpuLayers: v.gpuLayers ?? (flavor === 'cpu' || flavor === 'auto' ? 0 : 99),
      ...(selection.queryPrefix !== undefined ? { queryPrefix: selection.queryPrefix } : {}),
      ...(selection.documentPrefix !== undefined ? { documentPrefix: selection.documentPrefix } : {}),
      provider: v.provider ?? inferProviderKind(v.endpoint),
      providerExplicit: v.provider !== undefined,
      apiKey: v.apiKey ?? (typeof process.env.DSH_MEMORY_API_KEY === 'string' ? process.env.DSH_MEMORY_API_KEY : ''),
      endpoint: v.endpoint ?? 'http://127.0.0.1:8078/v1/embeddings',
      model: v.model ?? selection.modelName,
      dims: v.dims ?? selection.dims,
      timeoutMs: v.timeoutMs ?? 1_000,
      // Full contents are orders of magnitude slower than a short query on CPU
      // (measured 3143ms for three ~600-char records), so write/backfill paths
      // get their own generous budgets instead of the interactive 300ms.
      // 慢设备实测：4000 字记录单条嵌入约 9.7s，10s 预算贴边。
      writeTimeoutMs: v.writeTimeoutMs ?? 20_000,
      backfillTimeoutMs: v.backfillTimeoutMs ?? 60_000,
      backfillMaxChars: v.backfillMaxChars ?? 8_000,
      // BGE CLS baseline noise floor measured ~0.42 on unrelated pairs
      minScore: v.minScore ?? 0.5,
      // 0.62.3：保底召回（见 search() 里同名注释）。relax 与 minScore 同域（余弦），
      // noiseFloor 是无关文本对的实测地板——保底可以放宽准入，但绝不允许跌到噪声区。
      //
      // 0.62.6：relax 0.05 → 0.02（地板 0.45 → 0.48）。实测 15 条无关查询对 9 条活跃
      // 记忆的最大余弦：2 条落在 0.45–0.50（0.459 / 0.454），而真命中在 0.483 / 0.4995
      // ——0.45 会把这 2 条无关查询也捞出来，0.48 正好卡在两组之间。
      recallFallback: {
        enabled: v.recallFallback?.enabled ?? true,
        relax: v.recallFallback?.relax ?? 0.02,
        noiseFloor: v.recallFallback?.noiseFloor ?? 0.42,
      },
      modelSha256: v.modelSha256 ?? '',
      runtimeSha256: v.runtimeSha256,
      // 回填是批量等长内容里最慢的路径：32 条 × 数千 token 在 CPU 上会超时，
      // 整批失败后记录永久留在 pending；小批更容易在预算内完成。
      backfillBatchSize: v.backfillBatchSize ?? 8,
      cache: v.cache ?? true,
      cacheDir: v.cacheDir ?? join(storeDir, 'embed-cache'),
      keepAlive: v.keepAlive ?? true,
      ann: {
        enabled: v.ann?.enabled ?? false,
        minSize: v.ann?.minSize ?? 2000,
        prefer: v.ann?.prefer ?? 'auto',
        ...(v.ann?.M !== undefined ? { M: v.ann.M } : {}),
        ...(v.ann?.efConstruction !== undefined ? { efConstruction: v.ann.efConstruction } : {}),
        ...(v.ann?.efSearch !== undefined ? { efSearch: v.ann.efSearch } : {}),
      },
      // Port defaults to the one in the embeddings endpoint so the two can never
      // drift apart; opt-in (enabled:false) keeps dev/test runs from spawning.
      // A backend the panel installed (or a hand-made one at installRoot) is
      // adopted as the spawn target when the user configured no explicit paths.
      spawn: {
        ...(v.spawn ?? {}),
        enabled: v.spawn?.enabled ?? installed !== null,
        ...(installed
          ? {
              exe: v.spawn?.exe ?? installed.exe,
              model: v.spawn?.model ?? installed.model,
              cwd: v.spawn?.cwd ?? installed.cwd,
              logFile: v.spawn?.logFile ?? installed.logFile,
            }
          : {}),
        // 模型自带 pooling 与 GPU 层数:llama-server 拿不到就是错的检索结果,
        // 所以跟着所选模型一起传下去(extraArgs 仍在最后,可覆盖)。
        pooling: v.pooling ?? selection.pooling,
        gpuLayers: v.gpuLayers ?? (flavor === 'cpu' || flavor === 'auto' ? 0 : 99),
        port: v.spawn?.port ?? portOf(v.endpoint ?? 'http://127.0.0.1:8078/v1/embeddings') ?? 8078,
      },
    },
    llm: {
      enabled: config.retrieval?.llm?.enabled ?? false,
      provider: config.retrieval?.llm?.provider ?? '',
      model: config.retrieval?.llm?.model ?? '',
      timeoutMs: config.retrieval?.llm?.timeoutMs ?? 1500,
      dailyBudgetTokens: config.retrieval?.llm?.dailyBudgetTokens ?? 200_000,
      weight: config.retrieval?.llm?.weight ?? 0.6,
      topN: config.retrieval?.llm?.topN ?? 10,
    },
    maxRecordsPerScope: config.limits?.maxRecordsPerScope ?? 2000,
    // 0.62.5：空会话作用域的保留天数。默认 1 天——空作用域没有数据，重建零成本。
    sessionScopeMaxAgeDays: config.limits?.sessionScopeMaxAgeDays ?? 1,
    maxRecordChars: config.limits?.maxRecordChars ?? 4000,
    secrets: {
      enabled: config.secrets?.enabled ?? true,
      mode: config.secrets?.mode ?? 'refuse',
    },
    // 0.33.0：强度排序默认开；查询扩展默认关（需要按真实库用 eval 调 beta）。
    strengthRanking: config.retrieval?.strengthRanking ?? true,
    temporalWeighting: config.retrieval?.temporalWeighting ?? true,
    // 0.40.0：P0 检索核心。BM25 + RRF 融合默认开（有旧路径可关掉做 A/B）；
    // 查询变体默认关（每个变体多一次 BM25 全扫，先由 eval 决定是否默认开）。
    bm25: {
      enabled: config.retrieval?.bm25?.enabled ?? true,
      k1: config.retrieval?.bm25?.k1 ?? 1.2,
      b: config.retrieval?.bm25?.b ?? 0.75,
      tagsWeight: config.retrieval?.bm25?.tagsWeight ?? 1.5,
    },
    fusion: {
      enabled: config.retrieval?.fusion?.enabled ?? true,
      k: config.retrieval?.fusion?.k ?? 60,
      weights: {
        lexical: config.retrieval?.fusion?.weights?.lexical ?? 1,
        vector: config.retrieval?.fusion?.weights?.vector ?? 1,
        expanded: config.retrieval?.fusion?.weights?.expanded ?? 0.6,
      },
      // 默认只重排已有候选，不注入"仅 BM25 命中"的新候选 —— 实测后者会在
      // strengthRanking 关闭时用低相关度挤掉真命中（recall -0.04）。需要补召回时再开。
      addCandidates: config.retrieval?.fusion?.addCandidates ?? false,
    },
    variants: {
      enabled: config.retrieval?.variants?.enabled ?? false,
      maxVariants: config.retrieval?.variants?.maxVariants ?? 3,
      maxNeighbors: config.retrieval?.variants?.maxNeighbors ?? 3,
    },
    expansion: {
      enabled: config.retrieval?.expansion?.enabled ?? false,
      beta: config.retrieval?.expansion?.beta ?? 0.35,
    },
    // 0.32.0：结果整形。floor 默认 0.2（与 REAL_HIT_FLOOR 同源），dedupe 0.85
    // 略低于实测同义对 0.865，既能合并重复又不误伤「相关但不同」的条目。
    shaping: {
      floor: config.retrieval?.finalFloor ?? 0.2,
      dedupeThreshold: config.retrieval?.dedupeThreshold ?? 0.85,
      mmr: config.retrieval?.mmr ?? true,
      mmrLambda: config.retrieval?.mmrLambda ?? 0.7,
    },
    // 0.32.0：认知层默认开启；任何一项都可以单独关掉回到 0.31 的行为。
    cognitive: {
      mergeEnabled: config.cognitive?.merge?.enabled ?? true,
      mergeThreshold: config.cognitive?.merge?.threshold ?? 0.92,
      conflictEnabled: config.cognitive?.conflict?.enabled ?? true,
      conflictMinSimilarity: config.cognitive?.conflict?.minSimilarity ?? 0.75,
      dormantAfterDays: config.cognitive?.lifecycle?.dormantAfterDays ?? 30,
      dormantMaxImportance: config.cognitive?.lifecycle?.dormantMaxImportance ?? 0.3,
      tombstoneDays: config.cognitive?.lifecycle?.tombstoneDays ?? 30,
      // 巩固默认开，但只在**有向量的作用域**跑（纯词法库不做合并，避免误伤）。
      consolidationEnabled: config.cognitive?.consolidation?.enabled ?? true,
      consolidationThreshold: config.cognitive?.consolidation?.threshold ?? 0.9,
      consolidationMaxClusters: config.cognitive?.consolidation?.maxClusters ?? 2,
    },
  }
}

/** 面板语义检索的一次结果:排序规则与 memory_search 相同,但不写访问计数。 */
                                 
                      
               
 

                                    
                        
                                                            
                            
                                   
                                                                           
                                 
                  
               
 

/**
 * 生效中的可见域(已剔除被 scope 开关禁用的项)。
 *
 * 0.20.0 起**永远有值**:没有显式覆盖时返回默认策略 ——
 * 「当前会话 + 当前项目 + global」+ 普通限制。`source` 说明这份策略从哪来:
 *   - `explicit`  = 本会话自己保存过可见范围;
 *   - `inherited` = 沿 parentSession 链继承来的显式范围;
 *   - `default`   = 没有显式覆盖,用的默认策略。
 * 工具层用 `source === 'default'` 区分"默认普通限制"(普通检索不主动把范围外
 * 也搜一遍)与"用户显式设的普通限制"。
 */
                                       
                        
                          
                                              
 

/**
 * 目录工具（memory_scopes list）的一行：作用域的“身份证 + 当前访问状态”。
 *
 * 0.24.0 起目录可见与正文可读是两件事：
 *   - `absolute` 下范围外作用域仍列出名字/用途（`accessStatus='restricted'`），
 *     但 `readable/writable` 恒为 false，`canRequest*` 也恒为 false —— absolute
 *     没有任何审批放行路径；
 *   - `normal` 下范围外可申请，`canRequest*` 才是 true；
 *   - 自定义作用域开关关闭时整个条目不出现（不是 `unavailable`）。
 */
                                    
                    
               
                      
                     
                                    
                  
                  
                   
                   
                         
                          
                                                                                                  
                   
     
                                            
                        
     
                    
     
                                                             
                                           
     
                                                                                            
 

/** 范围外访问的动作(读取 / 写入 / 删除);审批浮层按它换文案。 */
                                                          

/** 一条"范围外"命中:给审批浮层展示的完整快照(不落盘,进程内存)。 */
                                         
            
               
              
                 
                
                    
                   
                                           
                          
                                               
                                   
 

                                         
            
                   
              
                                 
                          
                                       
               
                                            
                      
     
                                                   
                                              
     
                            
                                 
                   
                   
 

/**
 * 侧边栏「阻塞提醒」用的轻量待审批快照(0.25.14)。
 *
 * 客户端要模仿宿主 approval / question 的传播方式：把「某会话正在等用户审批」
 * 发布成宿主 `uiSession` 的 pending interaction，侧边栏才会显示黄点。这个轮询
 * 只需要审批的身份与会话，**不需要条目正文** —— 正文仍由完整 `/approvals` 接口
 * 按会话取，避免每 1.5 秒把几十 KB 的条目内容传到客户端。
 */
                                             
            
                   
              
                          
                            
                   
                   
 

/** 一次审批的结局:允许(可只允许其中几条) / 拒绝 / 超时。 */
                                                                               

/** 一条作用域权限申请的处理结果（0.24.0 / D3）。 */
                                     
             
                     
                     
                     
                 
            
             
                          

                                              
                    
                             
                                 
                                                                                
                 
 

                                          
                                        
                                                     
                           
                      
 

/**
 * 审批结论(0.21.0)。`allowedIds` 省略 = 本次请求的所有条目都允许;
 * 用户在审批卡里逐条勾选时只带被勾选的条目 id。
 */
                                           
                                    
                       
 

                                                                    
                                                 
                                                  
 

/** 普通限制下一次审批最多等多久;超时按拒绝处理(工具不会无限挂住)。 */
const VISIBILITY_APPROVAL_TTL_MS = 5 * 60_000
/** 审批浮层一次最多展示多少条范围外命中(工具侧仍会返回全部允许的命中)。 */
const VISIBILITY_APPROVAL_MAX_ITEMS = 20

/**
 * 没有显式覆盖时的默认限制等级(0.20.0 起)。
 * 默认范围 = 当前会话 + 当前项目 + global;范围外命中走一次审批。
 */
export const DEFAULT_VISIBILITY_LEVEL                  = 'normal'

export class LocalMemoryService                             {
           cfg                
           store             
           embed                   
  /** 0.32.0：文档/查询向量缓存（命中即免一次嵌入请求；换模型自动失效）。 */
          embedCache                    = null
  /** 0.32.0：启动预热 + 周期探活，llama-server 被杀后能自动恢复。 */
          embedKeepAlive                        = null
  /** 0.40.1：本地嵌入服务是否已就绪（模型加载完成）。冷启动期间跳过语义召回，避免超时刷屏。 */
          embedServerReady = false
  /** 本次托管启动的时刻；用于给「冷启动跳过语义召回」设截止时间。 */
          embedServerWarmSince                = null
          warmSkipLogged = false
  /**
   * 0.40.2：查询嵌入串行链。
   * llama-server 只有 n_slots=4 个槽位，插件一次注入/召回若并发发多个查询嵌入，
   * 会互相排队（实测 8 路短请求最慢 1.55s）→ 交互预算必超时。这里把**查询**嵌入串起来，
   * 让每个查询等前一个完成（热路径单条 ~130ms），避免自己打自己。
   */
          queryEmbedChain                = Promise.resolve()
  /**
   * 0.41.3：文档嵌入并发闸门。
   * llama-server 只有 4 个 slot；批量写/回填时如果 4 个 slot 全被长文档占住，
   * 交互查询就会排队超时（实测批量写 20 条后，首个查询 1000ms 超时）。
   * 这里限制文档嵌入最多同时占 2 个 slot，给查询留至少 2 个。
   */
          docEmbedInFlight = 0
                   docEmbedMax = 2
          docEmbedWaiters                    = []
          async withDocEmbedSlot   (run                  )             {
    while (this.docEmbedInFlight >= this.docEmbedMax) {
      await new Promise      ((resolve) => this.docEmbedWaiters.push(resolve))
    }
    this.docEmbedInFlight += 1
    try {
      return await run()
    } finally {
      this.docEmbedInFlight -= 1
      this.docEmbedWaiters.shift()?.()
    }
  }
  /** 0.33.0：每个 scope 的 ANN 索引（size 与 store.vectors 不一致即视为过期，回退全量扫描）。 */
          annIndexes = new Map                                           ()
          annBuilding = new Set        ()
          rerankBudget             
          rerankCache = new RerankCache()
  /** Host-provided one-shot LLM call; null = rerank disabled (recall order). */
          llmInvoke                   = null
  /** 写路径的默认口径(tools.defaultScope);'session' 拿不到会话时回退 project。 */
          defaultWriteScope                                   = 'session'
  /** 显式配置的项目 scope 键(未配置 = undefined,由 resolveCurrentScopes 按会话 cwd 决定)。 */
          projectScope                         
  /** 上次发现磁盘 scope 的时间(限流用;0 = 还没发现过)。 */
          discoveredAt = 0
  /** "同一目录不同写法"的项目作用域是否已经合并过(每个进程只做一次)。 */
          scopesReconciled = false
  /** 作用域别名(project:<路径> → 显示名),落盘 <storeDir>/scopes.json。 */
          names            
  /** 作用域用途等元数据；每作用域一个文件，旧作用域按需懒合成。 */
                   meta                
  /** 注入设置(面板「设置」标签页可改;落盘在 <storeDir>/settings.json)。 */
          inject                
  /** 会话级「记忆可见范围」覆盖;没有覆盖时沿用默认集合。 */
                   visibility                        
  /** 工作区级「绑定作用域」:默认范围会额外并入这些作用域。 */
                   bindings                        
  /** 会话级授权（Agent 申请、用户批准）；独立于 visibility 策略。 */
                   grants                    
  /** 权限申请 / 授权生命周期审计（approvals.jsonl，不含正文）。 */
                   approvalAudit                    
  /** 可见域变更通知:下一次 pre-step 注入给 Agent 后删除(按会话)。 */
                   visibilityNotices = new Map                                                                ()
  /** 权限变更通知(0.25.0):授予 / 撤销；下一次 pre-step 注入给 Agent 后删除。 */
                   permissionNotices = new Map                                                           ()
  /** 普通限制下等待用户审批的范围外访问(按审批 id)。 */
                   pendingApprovals = new Map                                   ()
          approvalSeq = 0
  /**
   * 会话 id → live session 的只读查询(用于沿 parentSession 链继承可见范围)。
   * 宿主侧 apply.ts 注入;旧宿主 / 测试里没有时退化为只看当前会话。
   */
          sessionLookup                                       
  /**
   * 宿主归档会话查询（0.30.0）：`workspaceRegistry.archivedSessionIds` 的惰性读取。
   * 宿主侧 apply.ts 注入；没有时按「没有归档」处理（纯本地 / 测试环境）。
   */
          archivedLookup                                                   
  /** 0.31.0 记忆事件总线（旁路）：宿主 apply.ts 注入；未注入时默认实例安全空转。 */
          events                 = new MemoryEventBus()
  /** 注入半边的审计收集器(可选;没有注入半边时保持 null)。 */
          injectAuditSink   
                                      
                                    
                     
                                                                   
                    
           = null

  constructor(config                    = {}) {
    this.cfg = resolveConfig(config)
    // 面板里切换过的 provider 存在 <storeDir>/vector.json；只有配置没显式写
    // provider 时才让它生效（配置文件永远优先，避免"面板改过就再也改不回来"）。
    const override = readProviderOverride(this.cfg.storeDir)
    if (override !== null && !this.cfg.vector.providerExplicit) this.cfg.vector.provider = override
    this.inject = this.loadInjectSettings((config                        ).inject)
    this.names = new ScopeNames(join(this.cfg.storeDir, 'scopes.json'))
    this.meta = new ScopeMetaStore({ root: this.cfg.storeDir })
    this.visibility = new SessionVisibilityStore({ root: this.cfg.storeDir })
    this.bindings = new WorkspaceBindingsStore({ root: this.cfg.storeDir })
    this.grants = new SessionGrantsStore({ root: this.cfg.storeDir })
    this.approvalAudit = new ApprovalAuditStore({ root: this.cfg.storeDir })
    this.rerankBudget = new DailyBudget(this.cfg.llm.dailyBudgetTokens)
    this.queryTimeoutMs = this.cfg.vector.timeoutMs
    this.store = new MemoryStore(this.cfg.storeDir, { onWarn: (m) => console.warn(`[dsh-memory-local] ${m}`) })
    // Identity BEFORE the eager load (issue #1): ScopeStore skips its sidecar
    // validation entirely while the identity is unset (`if (this.vecIdentity && …)`),
    // so loading first would accept vectors from a previous embedding model
    // whenever the dimensions matched — and the next flush would then rewrite the
    // header as the new model, making the mismatch permanent.
    // pooling 也进身份(issue #3):同一个模型换 --pooling 等于换了一个向量空间
    // (last 与 cls 的余弦只有 0.35),以前它不在 identity 里,校验会静默放行。
    this.store.setVecIdentity(this.cfg.vector.model, this.cfg.vector.dims, this.cfg.vector.pooling)
    // 会话 scope 是按会话动态生成的,**不能**在这里 eager 加载(加载谁?);只预载
    // project 与 global 这两个稳定作用域。其余按需 peek/loadDiscovered。
    // eager 只加载"已存在"的 scope(peek),不会为不存在的 scope 建空文件。
    // 项目键此刻还看不到会话(没传 agent),所以这里只能预载"没有显式配置时的兜底键"
    // (= project:<process.cwd()>);真正的项目键在每次调用时按会话 cwd 解析。
    const eager                = []
    if (this.cfg.projectEnabled) eager.push(this.defaultProjectScope)
    if (this.cfg.globalEnabled) eager.push('global')
    for (const scope of eager) this.store.peek(scope)
    this.embed = this.createEmbed()
    this.embedCache = this.createEmbedCache()
    this.startMaintenance()
    this.startEmbedServer()
    // Termux 自举：环境匹配就自己把向量后端搭起来（后台跑，绝不挡住宿主启动）。
    this.bootstrapVectorBackend()
  }

  /** 设置文件:与记忆数据同目录,便于一起备份/清理。 */
  get settingsPath()         {
    return join(this.cfg.storeDir, 'settings.json')
  }

  /** 读取注入设置(归一化后的快照)。 */
  injectSettings()                 {
    return normalizeInjectSettings(this.inject, this.inject)
  }

  /** 注入半边注册审计收集器。重复注册时后一个覆盖前一个(激活重载)。 */
  attachInjectAudit(sink   
                                      
                                    
                     
                                                                   
                    
          )       {
    // 显式解绑:插件半边 dispose 时必须清掉，否则面板会继续读到已停止更新的旧 store。
    if (sink === null) {
      try { this.injectAuditSink?.dispose?.() } catch { /* 审计清理失败不影响 provider */ }
    } else if (this.injectAuditSink !== null && this.injectAuditSink !== sink) {
      // 多激活实例不应悄悄覆盖：保留诊断日志，查询边界仍以最后注册者为准。
      console.warn('[dsh-memory-local] audit sink replaced by another activation')
    }
    this.injectAuditSink = sink
  }

  /** 显式解绑:只有当前 sink 或未指定 sink 时才清理，避免旧实例卸载误清新实例。 */
  detachInjectAudit(sink          )       {
    if (sink !== undefined && this.injectAuditSink !== null && sink !== this.injectAuditSink) return
    try { this.injectAuditSink?.dispose?.() } catch { /* 审计清理失败不影响 provider */ }
    this.injectAuditSink = null
  }

  /** 兼容旧调用：返回审计条目数组（最新在前）；没有注入半边时为空。 */
  injectAudit(sessionId         )          {
    try { return this.injectAuditSink?.list?.(sessionId) ?? [] } catch { return [] }
  }

  /** v2 查询：优先用类型化 sink；旧 sink 只有 list 时降级包装成单页。 */
  injectAuditPage(query          )          {
    try {
      const sink = this.injectAuditSink
      if (sink?.query !== undefined) return sink.query(query)
      const q = (query && typeof query === 'object' ? query : {})                          
      const entries = sink?.list?.(q.sessionId) ?? []
      return {
        entries,
        total: Array.isArray(entries) ? entries.length : 0,
        stats: this.injectAuditStats(),
      }
    } catch {
      return { entries: [], total: 0, stats: this.injectAuditStats() }
    }
  }

  /** 审计容量/丢弃/写入错误等健康状态。 */
  injectAuditStats()          {
    try {
      return this.injectAuditSink?.stats?.() ?? {
        entries: 0, capacity: 0, perSessionCapacity: 0, dropped: 0,
        writeErrors: 0, persistence: 'memory',
      }
    } catch {
      return {
        entries: 0, capacity: 0, perSessionCapacity: 0, dropped: 0,
        writeErrors: 0, persistence: 'degraded',
      }
    }
  }

  /** 面板改设置:合并补丁 → 落盘 → 返回新值。写盘失败只告警,不影响运行中的设置。 */
  updateInjectSettings(patch         )                 {
    this.inject = mergeInjectSettings(this.inject, patch)
    try {
      mkdirSync(this.cfg.storeDir, { recursive: true })
      writeFileSync(this.settingsPath, `${JSON.stringify(this.inject, null, 2)}\n`, 'utf8')
    } catch (error) {
      console.warn(`[dsh-memory-local] 无法写入注入设置 ${this.settingsPath}: ${error instanceof Error ? error.message : String(error)}`)
    }
    return this.injectSettings()
  }

  /** 配置先给底,磁盘上的 settings.json 覆盖它;坏文件忽略而不是启动失败。 */
          loadInjectSettings(fromConfig         )                 {
    const base = normalizeInjectSettings(fromConfig)
    try {
      if (existsSync(this.settingsPath)) {
        const parsed = JSON.parse(readFileSync(this.settingsPath, 'utf8'))           
        const digest = (parsed                                               )?.digest
        // 0.9.5 及以前的默认 digest 预算是 400,且没有 hintBudget 字段。
        // 升级到 0.9.6 时把"旧默认值"迁到新默认 800;显式写过 hintBudget 的配置不动。
        const oldDigestDefault = digest !== undefined && digest !== null
          && typeof digest === 'object' && digest.hintBudget === undefined
          && Number(digest.tokenBudget) === 400
        const merged = mergeInjectSettings(base, parsed)
        if (oldDigestDefault) merged.digest.tokenBudget = base.digest.tokenBudget
        return merged
      }
    } catch (error) {
      console.warn(`[dsh-memory-local] 忽略损坏的注入设置 ${this.settingsPath}: ${error instanceof Error ? error.message : String(error)}`)
    }
    return base
  }

  /**
   * 被其他记录 supersedes 指向的记录 id(=已退役)。scope 缺省时扫描全部已加载 scope。
   * 只读、不发现、不创建;注入半边/规则段/自动召回共用这一份口径。
   */
  supersededIds(scopes                )           {
    const ids = new Set        ()
    const stores = scopes === undefined
      ? this.store.allScopes()
      : scopes.map((scope) => this.store.peek(scope)).filter((s)                             => s !== undefined)
    for (const store of stores) {
      for (const record of store.records.values()) {
        if (typeof record.supersedes === 'string' && record.supersedes.length > 0) ids.add(record.supersedes)
      }
    }
    return [...ids]
  }

  /**
   * 同步列记录(只读、不触发磁盘发现)。系统提示里的「硬性规则」段每步都要
   * 渲染,必须是同步的;这里直接读已加载 scope 的内存快照。
   *
   * 默认排除已被 supersede 的旧记录;需要历史/审计时显式 includeSuperseded。
   */
  listSync(input                                                                                                                                    = {})                 {
    const wanted = (input.scopes ?? []).map((scope) => this.canonicalScope(scope))
    // 注入侧必须按可见域的类型白名单过滤;工具侧不传 agent(它需要范围外命中来发起审批)。
    const visibleFilter = input.agent !== undefined ? this.visibilityFilterFor(input.agent) : undefined
    const seen = new Set             ()
    const stores               = []
    const archivedScopes = this.archivedSessionScopes()
    for (const scope of wanted) {
      if (seen.has(scope)) continue
      seen.add(scope)
      // 0.30.0：归档会话作用域在归档期间不参与枚举 / 注入。
      if (archivedScopes.has(scope)) continue
      const s = this.store.peek(scope)
      if (s) stores.push(s)
    }
    const retired = input.includeSuperseded ? new Set        () : new Set(this.supersededIds(wanted))
    const now = Date.now()
    const out                 = []
    for (const s of stores) {
      for (const rec of s.records.values()) {
        if (retired.has(rec.id)) continue
        // 过期 state 默认不参与任何自动注入/规则渲染;memory_get(id) 与面板仍可取。
        if (!input.includeExpired && rec.expiredAt !== undefined && rec.expiredAt < now) continue
        // 0.34.0：统一可见性判定（单一事实来源）—— 注入/规则/流程索引与检索同口径，
        // 休眠、软删、过期、失效事实一律不进系统提示。
        if (!isRecordVisible(rec, { includeExpired: input.includeExpired === true, now })) continue
        if (input.kind !== undefined && rec.kind !== input.kind) continue
        if (visibleFilter !== undefined && !visibleFilter(rec.scope, rec.kind)) continue
        out.push(rec)
      }
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt)
    return out.slice(0, input.limit ?? 100)
  }

  /** 按当前配置构造 provider（构造器与运行时切换共用）。 */
          createEmbed()                    {
    return createEmbeddingProvider({
      kind: this.cfg.vector.provider,
      endpoint: this.cfg.vector.endpoint,
      model: this.cfg.vector.model,
      dims: this.cfg.vector.dims,
      pooling: this.cfg.vector.pooling,
      apiKey: this.cfg.vector.apiKey,
      timeoutMs: this.cfg.vector.timeoutMs,
      writeTimeoutMs: this.cfg.vector.writeTimeoutMs,
      log: (message) => console.warn(`[dsh-memory-local] ${message}`),
    })
  }

  /** 0.33.0：把新向量增量同步进已建好的 ANN 索引（没建或维度不符就跳过）。 */
          syncAnnIndex(scope        , id        , vector              )       {
    const entry = this.annIndexes.get(scope)
    if (entry === undefined) return
    const scopeStore = this.store.peek(scope)
    if (scopeStore === undefined) return
    try {
      if (entry.index.has(id)) entry.index.update(id, vector)
      else entry.index.insert(id, vector)
      entry.size = scopeStore.vectors.size
    } catch {
      // 索引不同步就让 size 失配，下次查询回退全量扫描并重建
    }
  }

  /** 0.32.0：构造向量缓存。identity 跟着 model/dims/pooling 走，换模型整体失效。 */
          createEmbedCache()             {
    return new EmbedCache({
      dir: this.cfg.vector.cache ? this.cfg.vector.cacheDir : undefined,
      identity: {
        model: this.cfg.vector.model,
        dims: this.cfg.vector.dims,
        ...(this.cfg.vector.pooling !== undefined && this.cfg.vector.pooling !== 'auto' ? { pooling: this.cfg.vector.pooling } : {}),
      },
    })
  }

  /** 记住面板里选的 provider（配置文件显式写 provider 时它不生效）。 */
          persistProviderOverride(kind                       )       {
    try {
      writeFileSync(join(this.cfg.storeDir, 'vector.json'), `${JSON.stringify({ provider: kind, updatedAt: Date.now() }, null, 2)}\n`, 'utf8')
    } catch (error) {
      console.warn(`[dsh-memory-local] 保存 provider 选择失败：${(error         )?.message ?? String(error)}`)
    }
  }

  /**
   * 面板「切换嵌入后端」：local / openai / ollama / off，运行时生效并持久化。
   *
   * 只重启 provider 与（仅 local 的）子进程管理器；记忆数据与向量边车不动 ——
   * model/dims/pooling 没变时向量仍可复用，变了由既有的身份校验自动作废旧向量。
   */
  async setEmbeddingProvider(kind                       )                                                                              {
    const allowed                          = ['local', 'openai', 'ollama', 'off']
    if (!allowed.includes(kind)) {
      return { ok: false, provider: this.cfg.vector.provider, message: `未知 provider：${String(kind)}` }
    }
    if (kind === this.cfg.vector.provider) {
      return { ok: true, provider: kind, message: '未变化' }
    }
    // 切走之前先停掉本地下游（只有 local 才有子进程）。
    try { this.embedServer?.stop() } catch { /* best effort */ }
    this.embedServer = null
    this.cfg.vector.provider = kind
    this.embedKeepAlive?.stop()
    this.embedKeepAlive = null
    this.embedServerReady = false
    this.embedServerWarmSince = null
    this.warmSkipLogged = false
    this.embed = this.createEmbed()
    // 缓存身份跟着模型/维度/pooling：不一致时 setIdentity 会整体作废旧缓存。
    this.embedCache?.setIdentity({
      model: this.cfg.vector.model,
      dims: this.cfg.vector.dims,
      ...(this.cfg.vector.pooling !== undefined && this.cfg.vector.pooling !== 'auto' ? { pooling: this.cfg.vector.pooling } : {}),
    })
    this.persistProviderOverride(kind)
    // 切回 local 且已配置 → 重新托管启动；其它 provider 不碰子进程。
    if (kind === 'local' && this.cfg.vector.enabled && this.cfg.vector.configured) this.startEmbedServer()
    return {
      ok: true,
      provider: kind,
      message: kind === 'off'
        ? '已切换到 off：纯词法检索，不联网'
        : `已切换到 ${kind}；endpoint 需要指向对应服务`,
    }
  }

  /** Own the embedding backend's lifetime: spawn on activation, stop on dispose. */          startEmbedServer()       {
    // 新的一轮托管：等 waitUntilReady 成功后才把就绪标记置 true。
    this.embedServerReady = false
    this.embedServerWarmSince = Date.now()
    // Nothing configured and retrieval switched off → do not even build the
    // manager, so no probe, no spawn attempt, no misleading panel state.
    if (!this.cfg.vector.enabled || !this.cfg.vector.configured) return
    // 只有本地 provider 需要（也才有资格）托管 llama-server 子进程；
    // openai / ollama / off 都是遥控别人的服务，插件不该拉起任何进程。
    if (!this.embed.isLocalServer) return
    // fire-and-forget: 端口回退 → 建 manager → 启动；activation 绝不阻塞在模型加载上。
    void (async () => {
      try { await this.applyPortFallback() } catch { /* 端口探测失败就按原配置启动 */ }
      this.embedServer = new EmbedServerManager(this.cfg.vector.spawn)
      await this.ensureEmbedServer(60_000)
    })().catch(() => { /* lifecycle never breaks activation */ })
  }

  /**
   * 端口回退：默认端口（8078）被占用时自动找一个空闲端口并同步改写 endpoint。
   *
   * 为什么需要：插件托管的服务是后台子进程，端口冲突时旧行为是「启动失败、
   * 静默降级成词法」——用户只会看到语义检索时好时坏。端口是内部实现细节，
   * 除非用户**显式**指定，否则不该成为故障点。
   */
          async applyPortFallback()                {
    const cfg = this.cfg.vector
    // 只有「插件真的要拉起子进程」时才谈端口回退：
    //  - spawn 没开（external 端点、openai/ollama、或用户自己的本地服务）→ 端口是
    //    别人的，改了只会把用户配置改坏；
    //  - 用户显式写了 spawn.port：尊重用户选择，不做回退。
    if (cfg.spawn.enabled !== true) return
    if (cfg.spawnExplicit || cfg.spawn.port === undefined) return
    const host = cfg.spawn.host ?? '127.0.0.1'
    const current = cfg.spawn.port
    if (!(await probePortBusy(host, current))) return
    const free = await pickFreePort(host, current + 1, 20)
    if (free === null) {
      console.warn(`[dsh-memory-local] 端口 ${current} 被占用且后续 20 个端口都不可用，向量服务可能启动失败`)
      return
    }
    cfg.spawn.port = free
    try {
      const url = new URL(cfg.endpoint)
      url.port = String(free)
      cfg.endpoint = url.toString()
    } catch { /* endpoint 不是合法 URL 就只改 spawn 端口 */ }
    console.warn(`[dsh-memory-local] 端口 ${current} 被占用，向量服务自动改用 ${free}`)
  }

  /**
   * Start (or adopt) the embedding backend and arm the exit safety net.
   * Shared by the activation path and the panel's manual start button.
   */
  /** 0.32.0：启动预热保活（幂等；provider 切换/退出时先 stop）。 */
          startEmbedKeepAlive()       {
    if (!this.cfg.vector.keepAlive || this.embedKeepAlive !== null) return
    this.embedKeepAlive = new EmbedKeepAlive({
      target: this.embed,
      log: (message        ) => console.warn(`[dsh-memory-local] ${message}`),
    })
    this.embedKeepAlive.start()
  }

          async ensureEmbedServer(waitMs         )                            {
    const mgr = this.embedServer
    if (!mgr) return 'disabled'
    const state = await mgr.ensureRunning()
    if (state !== 'spawned' && state !== 'adopted-managed') return state
    // hard-exit safety net: cordis disposal covers a clean quit; this covers
    // the host dying without disposing us (the child must not be orphaned)
    if (!this.exitHook) {
      this.exitHook = () => { this.embedServer?.stop() }
      process.once('exit', this.exitHook)
    }
    const ready = await mgr.waitUntilReady(waitMs)
    this.embedServerReady = ready
    if (ready) {
      this.embedServerWarmSince = null
      this.warmSkipLogged = false
    }
    // 0.32.0：服务就绪后预热一次并开始周期探活（后台被杀能自动恢复）。
    if (ready) this.startEmbedKeepAlive()
    if (!ready) console.warn('[dsh-memory-local] embed server: 启动超时,检索继续走词法降级')
    return state
  }

  /** Manual start from the memory panel (same semantics as activation). */
  startEmbedServerManually()                            {
    return this.ensureEmbedServer(25_000)
  }

  /**
   * Manual stop from the memory panel. An instance we do not own is left alone
   * (it was started outside the app), so the UI can explain the refusal.
   */
  stopEmbedServerManually()                                                                                {
    const mgr = this.embedServer
    if (!mgr) return { stopped: false, reason: 'NOT_RUNNING' }
    if (!mgr.isOwned) return { stopped: false, reason: 'EXTERNAL_INSTANCE' }
    return { stopped: mgr.stop(), reason: mgr.isOwned ? 'NOT_RUNNING' : 'STOPPED' }
  }

  /**
   * Lifecycle snapshot for the memory panel.
   *
   * `mode` is what the panel needs to decide whether a start/stop switch even
   * makes sense:
   *   - 'off'      nothing configured → no switch, show how to opt in
   *   - 'external' we only know an endpoint (cloud or a server the user runs)
   *                → no switch, we must not claim ownership of that process
   *   - 'managed'  spawn is configured → the switch toggles OUR child process
   * `enabled` is the retrieval switch from config; when it is false while a
   * backend IS configured the panel explains the config instead of showing a
   * switch that cannot turn retrieval on.
   */
  async embedServerStatus()           
                    
                       
                                        
                    
                 
                                     
                      
                    
                     
                                      
                     
                
                        
                                  
                            
                  
                      
                   
                      
                                         
                            
                                      
                    
                                          
                        
                                                        
                    
                                                      
                                   
                                                                                            
                           
                                                          
                                                
                                                                 
                            
                         
                                                                   
                                                                               
                                                                                           
     {
    const mgr = this.embedServer
    const cfg = this.cfg.vector
    const pendingEmbeds = this.pendingEmbedCount
    const mode = !cfg.configured
      ? 'off'
      : cfg.provider !== 'local'
        ? 'external'
        : cfg.spawnConfigured ? 'managed' : 'external'
    const usage = this.vectorInstallUsage()
    const base = {
      enabled: cfg.enabled,
      configured: cfg.configured,
      mode,
      endpoint: cfg.endpoint,
      model: cfg.model,
      modelLabel: cfg.modelLabel,
      presetId: cfg.presetId,
      variantId: cfg.variantId,
      modelFile: cfg.installModel.file,
      dims: cfg.dims,
      pooling: cfg.pooling,
      flavor: cfg.flavor,
      spawnConfigured: cfg.spawnConfigured,
      provider: cfg.provider,
      platformSummary: describePlatform(detectPlatform(), {
        runtimeSource: this.cfg.vector.runtimeSource,
        distro: detectRuntimeEnvironment().distro,
        packageManager: detectRuntimeEnvironment().packageManager?.kind ?? null,
      }),
      runtimeSource: this.cfg.vector.runtimeSource,
      systemExe: this.cfg.vector.systemExe,
      environment: this.environmentSnapshot(),
      pendingEmbeds,
      install: this.installSnapshot(),
      maintenance: {
        usageBytes: usage.bytes,
        paths: usage.paths,
        // NOTE: `cfg` is the VECTOR config here, not the whole config — reading
        // cfg.storeDir would silently yield undefined (and JSON drops it).
        storeDir: this.cfg.storeDir,
        records: this.store.allScopes().reduce((n, s) => n + s.records.size, 0),
      },
    }         
    if (!mgr) {
      return {
        ...base, owned: false, pid: null, baseUrl: '', reachable: false,
        lastError: null, restarts: 0, unavailable: false, wrapped: false,
        provider: cfg.provider,
        platformSummary: describePlatform(detectPlatform(), {
          runtimeSource: cfg.runtimeSource,
          distro: detectRuntimeEnvironment().distro,
          packageManager: detectRuntimeEnvironment().packageManager?.kind ?? null,
        }),
        environment: this.environmentSnapshot(),
        runtimeSource: cfg.runtimeSource,
        systemExe: cfg.systemExe,
      }
    }
    const reachable = await mgr.healthCheck()
    return {
      ...base,
      ...mgr.info(),
      reachable,
      lastError: mgr.lastError,
      restarts: mgr.restarts,
      unavailable: mgr.unavailable,
      wrapped: mgr.launch?.wrapped ?? false,
      pendingEmbeds,
    }
  }

  /**
   * 面板「环境自检」：一次把「这台机器能不能跑、后端通不通、磁盘/权限够不够」列清楚。
   *
   * 只做只读探测；local 后端只探 /health，不触发嵌入请求。openai/ollama 会真的探一次
   * 远端（用户主动点自检时才会发生，不在插件激活路径上）。
   */
  async selfCheck()           
               
                                                                       
                                                                                   
     
                   
                                   
                                                                                    
     {
    const info = detectPlatform()
    const env = detectRuntimeEnvironment()
    const checks                                                                           = []
    checks.push({
      id: 'platform',
      label: '运行环境',
      ok: true,
      detail: describePlatform(info, {
        runtimeSource: this.cfg.vector.runtimeSource,
        distro: env.distro,
        packageManager: env.packageManager?.kind ?? null,
      }),
    })
    checks.push({
      id: 'system-llama',
      label: '系统 llama-server',
      ok: env.systemLlamaServer !== null,
      detail: env.systemLlamaServer ?? (env.packageManager === null
        ? '未检测到包管理器；可手动安装 llama.cpp 后重启（或设 autoBootstrap: always 用托管运行时）'
        : `未安装；可执行 \`${env.packageManager.bin} ${env.packageManager.install.join(' ')}\` 后重启`),
    })
    // 还没配置后端时，顺手告诉用户「本机其实已经有现成服务」——比装一套省事。
    if (this.cfg.vector.provider === 'local' && !this.cfg.vector.configured && this.cfg.vector.autoBootstrap !== 'off') {
      const found = await discoverLocalEndpoint({
        expectedDims: this.cfg.vector.dims,
        modelHint: this.cfg.vector.model,
        timeoutMs: 400,
      }).catch(() => null)
      checks.push({
        id: 'local-endpoints',
        label: '本机现成端点',
        ok: found !== null,
        detail: found === null
          ? '未发现 Ollama(11434)/LM Studio(1234)/llama.cpp(8080) 等本机服务'
          : `${found.label} ${found.endpoint}（${found.dims} 维）—— 可直接采用，无需下载`,
      })
    }
    // glibc 只在「Termux + 用托管运行时」时才需要检查：系统 bionic 二进制不用 glibc。
    if (info.termux && this.cfg.vector.runtimeSource !== 'system') {
      checks.push({
        id: 'glibc',
        label: 'glibc loader',
        ok: info.glibcLoader !== null,
        detail: info.glibcLoader ?? '未找到 $PREFIX/glibc/lib/ld-linux-*.so.1（pkg install glibc）',
      })
    }
    if (this.embedServer) {
      const ok = await this.embedServer.healthCheck(1500).catch(() => false)
      checks.push({
        id: 'backend',
        label: '嵌入后端',
        ok,
        detail: ok ? this.embedServer.baseUrl : (this.embedServer.lastError ?? '健康检查未通过'),
      })
    } else if (this.cfg.vector.provider === 'off') {
      // 显式关闭向量检索：不联网、不判成功，只说清楚现在是纯词法。
      checks.push({ id: 'backend', label: '嵌入后端', ok: null, detail: '已关闭（纯词法检索）' })
    } else if (!this.cfg.vector.configured) {
      // 没配置后端时不发任何请求：自检也不该替用户"试一下"一个不存在的服务。
      checks.push({ id: 'backend', label: '嵌入后端', ok: null, detail: '未配置（纯词法检索）' })
    } else {
      const ok = await this.embed.healthCheck(2000).catch(() => false)
      checks.push({
        id: 'backend',
        label: '嵌入后端',
        ok,
        detail: ok ? this.cfg.vector.endpoint : `${this.cfg.vector.endpoint} 无法访问`,
      })
    }
    const free = freeDiskBytes(this.cfg.vector.installRoot)
    checks.push({
      id: 'disk',
      label: '安装目录磁盘',
      ok: free === null ? null : free > 512 * 1024 * 1024,
      detail: free === null ? '读不到（跳过检查）' : `剩余 ${(free / 1073741824).toFixed(1)} GB`,
    })
    const installDirOk = canExecute(this.cfg.vector.installRoot)
    checks.push({
      id: 'install-dir',
      label: '安装目录权限',
      ok: installDirOk,
      detail: installDirOk === null ? '目录不存在（尚未安装）' : (installDirOk ? '可写' : '不可写：安装会失败'),
    })
    const storeDirOk = canExecute(this.cfg.storeDir)
    checks.push({
      id: 'store',
      label: '记忆目录',
      ok: storeDirOk,
      detail: storeDirOk === null ? this.cfg.storeDir : (storeDirOk ? '可写' : '不可写：记忆无法落盘'),
    })
    return {
      platform: {
        platform: info.platform,
        arch: info.arch,
        termux: info.termux,
        cpuCount: info.cpuCount,
        totalMemMb: info.totalMemMb,
        availableMemMb: info.availableMemMb,
        glibcLoader: info.glibcLoader,
      },
      summary: describePlatform(info, {
        runtimeSource: this.cfg.vector.runtimeSource,
        distro: env.distro,
        packageManager: env.packageManager?.kind ?? null,
      }),
      provider: this.cfg.vector.provider,
      checks,
    }
  }

  /** 面板用的一行环境快照（跨平台：发行版 / 包管理器 / 系统运行时）。 */
          environmentSnapshot()                                                                                                                       {
    const env = detectRuntimeEnvironment()
    return {
      os: env.platform,
      arch: env.arch,
      distro: env.distro,
      packageManager: env.packageManager?.kind ?? null,
      systemLlamaServer: env.systemLlamaServer,
    }
  }

  /** detectInstalled / 安装器统一用的系统运行时选项。 */
          systemRuntimeOptions()                                                      {
    return {
      systemExe: this.cfg.vector.runtimeMode === 'managed' ? null : this.cfg.vector.systemExe,
      preferSystem: this.cfg.vector.runtimeMode === 'system',
    }
  }

  /** Installer state for the panel (idle when nothing was ever requested). */
          installSnapshot()                                                         {
    const root = this.cfg.vector.installRoot
    const modelFile = this.cfg.vector.installModel.file
    const detected = detectInstalled(root, modelFile, this.systemRuntimeOptions())
    const installed = detected !== null
    const progress = this.installer?.progress ?? {
      phase: 'idle'         ,
      message: '',
      receivedBytes: 0,
      totalBytes: null,
      error: null,
      paths: detected ?? null,
    }
    return { ...progress, installed, root }
  }

  /**
   * 面板的"模型与硬件"报告:清单 + 当前选择 + 硬件 + 推荐。
   *
   * 硬件探测会 spawn 外部命令(Windows 上还有 PowerShell),所以**只在面板问的时候**跑,
   * 并且结果缓存 10 分钟 —— 绝不在插件激活路径上。
   */
  async modelsReport(force = false)           
                    
                                                                                 
                                                                                     
                                                                                                     
      
                                                                                                                                                                         
                                 
                                                            
                  
                   
     {
    const root = this.cfg.vector.installRoot
    const catalog = EMBEDDING_MODELS.map((model) => ({
      id: model.id,
      label: model.label,
      note: model.note,
      dims: model.dims,
      pooling: model.pooling,
      languages: model.languages,
      contextTokens: model.contextTokens,
      sizeBytes: variantBytes(model, this.cfg.vector.presetId === model.id ? this.cfg.vector.variantId : undefined),
      installed: model.variants.some((variant) => detectInstalled(root, variant.file, this.systemRuntimeOptions()) !== null),
      // 逐档判断"装没装":bge-m3 装了 Q4_K_M 不等于 Q8_0 也装了。
      // 判据与 detectInstalled 一致 —— 运行时 exe + 该档模型文件都在。
      variants: model.variants.map((variant) => ({
        id: variant.id, label: variant.label, bytes: variant.bytes, file: variant.file,
        installed: detectInstalled(root, variant.file, this.systemRuntimeOptions()) !== null,
      })),
    }))
    const records = this.store.allScopes().reduce((n, s) => n + s.records.size, 0)
    const locale = safeLocale()
    let hardware                      = null
    try {
      hardware = await this.hardwareSnapshot(force)
    } catch {
      hardware = null // 探测失败就只显示清单,不给推荐 —— 不猜
    }
    const recommendation = hardware === null
      ? null
      : recommendModel({ hardware, locale, recordCount: records, currentModelId: this.cfg.vector.presetId })
    return {
      catalog,
      current: {
        presetId: this.cfg.vector.presetId,
        variantId: this.cfg.vector.variantId,
        modelLabel: this.cfg.vector.modelLabel,
        file: this.cfg.vector.installModel.file,
        dims: this.cfg.vector.dims,
        pooling: this.cfg.vector.pooling,
        flavor: this.cfg.vector.flavor,
        model: this.cfg.vector.model,
      },
      hardware,
      recommendation,
      locale,
      records,
    }
  }

  /** 硬件探测结果缓存(默认 10 分钟),'auto' 风味与推荐共用它。 */
          async hardwareSnapshot(force = false)                        {
    const now = Date.now()
    if (!force && this.hardwareCache !== null && now - this.hardwareAt < 600_000) return this.hardwareCache
    const hw = await probeHardware({ dir: this.cfg.vector.installRoot })
    this.hardwareCache = hw
    this.hardwareAt = now
    return hw
  }

  /** 把 'auto' 风味解析成具体风味(需要探测;失败则退回 CPU)。 */
          async resolveFlavor()                         {
    const configured = this.cfg.vector.flavor
    if (configured !== 'auto') return configured
    try {
      return pickFlavor(await this.hardwareSnapshot())
    } catch {
      return 'cpu'
    }
  }

  /** 面板选了模型/风味之后,把选择写进安装目录的 state 文件并更新运行中的配置。 */
          applyModelSelection(override               )                         {
    const synthetic                    = override.custom !== undefined
      ? { customModel: override.custom }
      : { ...(override.preset !== undefined ? { preset: override.preset } : {}), ...(override.variant !== undefined ? { variant: override.variant } : {}) }
    const sel = resolveModelSelection(synthetic)
    const cfg = this.cfg.vector
    cfg.installModel = {
      file: sel.file,
      ...(sel.bytes !== undefined ? { bytes: sel.bytes } : {}),
      ...(sel.sources.length > 0 ? { sources: sel.sources } : {}),
    }
    cfg.presetId = sel.presetId
    cfg.variantId = sel.variantId
    cfg.modelLabel = sel.label
    cfg.pooling = sel.pooling
    cfg.dims = sel.dims
    cfg.model = sel.modelName
    cfg.spawn.pooling = sel.pooling
    if (override.flavor !== undefined) cfg.flavor = override.flavor
    cfg.spawn.gpuLayers = cfg.flavor === 'cpu' || cfg.flavor === 'auto' ? 0 : (cfg.spawn.gpuLayers || 99)
    writeModelState(cfg.installRoot, {
      presetId: sel.presetId === 'custom' ? undefined : sel.presetId,
      variantId: sel.variantId === 'custom' ? undefined : sel.variantId,
      ...(override.custom !== undefined ? { customModel: override.custom } : {}),
      ...(override.flavor !== undefined ? { flavor: override.flavor } : {}),
    })
    return cfg.flavor
  }

  /**
   * Panel action: download llama.cpp + the GGML model into installRoot, then
   * adopt them (start the managed server). Never runs on its own — a fresh
   * install downloads nothing until the user asks.
   *
   * `override` 是面板的选择(预设/档位/自定义 URL/风味):它会先落进安装目录的
   * state 文件(下次启动仍然生效),再按新选择下载。配置里写了 preset/customModel
   * 的话,配置永远优先 —— state 只是"面板选过什么"的记忆。
   */
  /**
   * Termux 自举：在「和本机同款」的环境里把向量后端自己搭起来。
   *
   * 为什么：目标环境（Android/Termux）本来就能 `pkg install llama-cpp` 拿到
   * bionic 原生的 llama-server，唯一缺的是「模型 + 配置」这一步。让用户先翻
   * README、再手填 spawn.exe、再自己 curl 一个 438MB 的 GGUF，是把最容易出错
   * 的环节留给用户。这里把它变成：环境匹配 → 自动装包 → 自动下模型 → 自动托管。
   *
   * 全程 fire-and-forget：任何一步失败都只记日志并退回词法检索，绝不挡住宿主
   * 启动，也绝不覆盖用户显式写的 endpoint / spawn 配置。
   */
          bootstrapVectorBackend()       {
    // 测试环境绝不自动装包/下模型：node:test 的每个用例都会构造一次服务实例，
    // 真按 Termux 自举走会拉起 `pkg install` 和 438MB 下载。Node 在测试子进程里
    // 会设置 NODE_TEST_CONTEXT，用它做闸门比猜配置可靠。
    if (process.env.NODE_TEST_CONTEXT !== undefined) return
    if ((process.env.DSH_MEMORY_AUTO_BOOTSTRAP ?? '').trim() === 'off') return
    if (this.bootstrapping) return
    this.bootstrapping = true
    void this.runBootstrapFlow().finally(() => { this.bootstrapping = false })
  }

  /**
   * 自举主流程（后台跑，绝不挡住宿主启动）：
   *   1. 先找本机已经在跑的 embedding 服务（Ollama / LM Studio / llama.cpp…）——
   *      有就直接采用，**零下载**；
   *   2. 没有再按「系统 llama-server / 包管理器 / 托管资产」决定装包或下模型；
   *   3. 任何一步失败都只记 bootstrap.log，检索退回词法。
   */
          async runBootstrapFlow()                {
    const cfg = this.cfg.vector
    try {
      if (await this.tryAdoptLocalEndpoint()) return
      const env = detectRuntimeEnvironment()
    const termux = env.termux || env.platform === 'android'
    const hasSystemServer = (cfg.systemExe ?? env.systemLlamaServer) !== null
    const hasPkg = env.packageManager?.kind === 'pkg'
    const managedSupported = supportsManagedRuntime(env.platform, env.arch)
    const decided = planVectorBootstrap({
      autoBootstrap: cfg.autoBootstrap,
      provider: cfg.provider,
      endpointConfigured: cfg.endpointConfigured,
      spawnExplicit: cfg.spawnExplicit,
      configured: cfg.configured,
      termux,
      hasSystemServer,
      hasPkg,
      managedSupported,
    })
    this.bootstrapLog(
      `decision=${decided} os=${env.platform}/${env.arch} distro=${env.distro ?? '-'} pm=${env.packageManager?.kind ?? '-'} ` +
      `termux=${termux} sys=${hasSystemServer} managed=${managedSupported} configured=${cfg.configured} ` +
      `endpointExplicit=${cfg.endpointConfigured} spawnExplicit=${cfg.spawnExplicit} provider=${cfg.provider}`,
    )
      if (decided === 'none') {
        // 环境里有包管理器、但既没装 llama-server 也没开 always：给出「地道」的安装命令。
        if (!cfg.configured && !hasSystemServer && env.packageManager !== null && cfg.autoBootstrap !== 'always') {
          this.bootstrapLog(
            `hint 未自动安装：可执行 \`${env.packageManager.bin} ${env.packageManager.install.join(' ')}\` 后重启；` +
            `或设 retrieval.vector.autoBootstrap: 'always' 让插件托管下载运行时与模型`,
          )
        }
        return
      }
      await this.runBootstrap(decided)
    } catch (error) {
      this.bootstrapLog(`自举流程失败（已忽略）：${(error         )?.message ?? String(error)}`)
    }
  }

  /**
   * 发现并采用本机现成端点：找到且模型一致才采用。
   * 返回 true = 已采用（后续不再装包/下模型）。
   */
          async tryAdoptLocalEndpoint()                   {
    const cfg = this.cfg.vector
    if (cfg.configured || cfg.endpointConfigured || cfg.spawnExplicit) return false
    if (cfg.provider !== 'local' || cfg.autoBootstrap === 'off') return false
    const found = await discoverLocalEndpoint({ expectedDims: cfg.dims, modelHint: cfg.model })
    if (found === null) {
      this.bootstrapLog('discovery none（未发现可用的本机端点）')
      return false
    }
    this.bootstrapLog(`discovery found ${found.label} ${found.endpoint} model=${found.model} dims=${found.dims}`)
    const wanted = cfg.model.toLowerCase()
    const sameModel = found.model.toLowerCase() === wanted || found.model.toLowerCase().startsWith(`${wanted}:`)
    if (!sameModel) {
      this.bootstrapLog(
        `discovery 找到 ${found.label}，但模型 ${found.model} 与当前 ${cfg.model} 不一致，未采用（避免向量空间混用）；` +
        `可把 retrieval.vector.model 改成 ${found.model} 后重启`,
      )
      return false
    }
    cfg.provider = found.provider
    cfg.endpoint = found.endpoint
    cfg.configured = true
    cfg.enabled = true
    cfg.endpointConfigured = true
    cfg.spawnConfigured = false
    cfg.runtimeSource = 'none'
    this.embed = this.createEmbed()
    this.persistProviderOverride(found.provider)
    this.startEmbedKeepAlive()
    this.bootstrapLog(`adopted ${found.label}：provider=${found.provider} endpoint=${found.endpoint}（零下载）`)
    return true
  }

  /** 自举日志落盘：服务器 stdout 看不到，排查「为什么没自动装」全靠它。 */
          bootstrapLog(line        )       {
    try {
      mkdirSync(this.cfg.vector.installRoot, { recursive: true })
      appendFileSync(join(this.cfg.vector.installRoot, 'bootstrap.log'), `${new Date().toISOString()} ${line}\n`, 'utf8')
    } catch { /* 落盘失败不影响自举 */ }
  }

          async runBootstrap(action                       )                {
    const log = (message        )       => {
      console.warn(`[dsh-memory-local] Termux 自举：${message}`)
      this.bootstrapLog(message)
    }
    try {
      if (action === 'install-package') {
        log('未检测到 llama-server，执行 pkg install -y llama-cpp（约 22MB）…')
        const ok = await this.installSystemLlamaCpp()
        if (!ok) {
          log('pkg install llama-cpp 失败，向量后端保持关闭（检索走词法）；之后可在面板手动安装')
          return
        }
        const exe = findSystemLlamaServer()
        if (exe === null) {
          log('安装完成但没找到 llama-server，向量后端保持关闭')
          return
        }
        this.cfg.vector.systemExe = exe
        this.cfg.vector.runtimeMode = 'system'
        this.cfg.vector.runtimeSource = 'system'
        log(`系统 llama-server 就绪：${exe}`)
      }
      if (action === 'managed-install') {
        log('本机没有系统 llama-server（autoBootstrap=always），改走托管下载：运行时 + 模型')
      } else if (action === 'download-model') {
        // resolveConfig 可能因为进程 PATH 不完整没找到系统二进制，这里再探一次并回填。
        const exe = this.cfg.vector.systemExe ?? findSystemLlamaServer()
        if (exe !== null) {
          this.cfg.vector.systemExe = exe
          if (this.cfg.vector.runtimeMode !== 'managed') this.cfg.vector.runtimeMode = 'system'
          this.cfg.vector.runtimeSource = 'system'
        }
        log(`系统 llama-server 就绪：${exe ?? '(未找到，回退托管)'}；只下模型，不需要运行时下载`)
      }
      // 模型已在 → 内部直接 adopt 并启动；缺失 → 按来源下载（系统运行时只下模型）。
      this.installVectorBackend()
    } catch (error) {
      log(`自举失败（已忽略）：${(error         )?.message ?? String(error)}`)
    }
  }

  /** 跑 `pkg install -y llama-cpp`；只在 Termux 上可用。返回是否成功。 */
          installSystemLlamaCpp()                   {
    return new Promise((resolve) => {
      const info = detectPlatform()
      const prefix = info.prefix
      if (prefix === null) return resolve(false)
      const pkg = join(prefix, 'bin', 'pkg')
      if (!existsSync(pkg)) return resolve(false)
      let settled = false
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
        finish(false)
      }, 15 * 60_000)
      timer.unref?.()
      const finish = (ok         )       => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(ok)
      }
      let child                          
      try {
        child = spawn(pkg, ['install', '-y', 'llama-cpp'], {
          env: { ...process.env, PATH: `${join(prefix, 'bin')}:${process.env.PATH ?? ''}` },
          stdio: 'ignore',
          windowsHide: true,
        })
      } catch {
        finish(false)
        return
      }
      child.on('error', () => finish(false))
      child.on('close', (code) => finish(code === 0))
    })
  }

  installVectorBackend(override                = {})       {
    const flavor = this.applyModelSelection(override)
    const model = this.cfg.vector.installModel
    if (detectInstalled(this.cfg.vector.installRoot, model.file, this.systemRuntimeOptions())) {
      this.adoptInstalledBackend()
      return
    }
    // 换模型时把上一个安装器的进度丢掉:它描述的是另一个文件。
    this.installer?.cancel()
    this.installer = new VectorInstaller({
      root: this.cfg.vector.installRoot,
      model: {
        file: model.file,
        ...(model.bytes !== undefined ? { bytes: model.bytes } : {}),
        ...(model.sources !== undefined ? { sources: model.sources } : {}),
        ...(this.cfg.vector.modelSha256 !== '' ? { sha256: this.cfg.vector.modelSha256 } : {}),
      },
      ...(flavor === 'auto' ? {} : { flavor }),
      ...(this.cfg.vector.runtimeSha256 !== undefined ? { runtimeSha256: this.cfg.vector.runtimeSha256 } : {}),
      ...(this.cfg.vector.installModelSources && model.sources === undefined ? { modelSources: this.cfg.vector.installModelSources } : {}),
      // 系统运行时（Termux `pkg install llama-cpp`）：只下模型，不碰运行时下载。
      ...(this.cfg.vector.runtimeMode !== 'managed' && this.cfg.vector.systemExe !== null
        ? { systemExe: this.cfg.vector.systemExe }
        : {}),
      ...(this.cfg.vector.runtimeMode === 'system' ? { preferSystem: true } : {}),
      onProgress: (() => {
        // 安装器每写一块都会回调：只记 phase 变化，否则日志被刷屏。
        let lastPhase = ''
        return (progress                 ) => {
          if (progress.phase !== lastPhase) {
            lastPhase = progress.phase
            this.bootstrapLog(`installer phase=${progress.phase} ${progress.message}`)
          }
          if (progress.phase === 'done') this.adoptInstalledBackend()
        }
      })(),
    })
    this.installer.start()
  }

  /** Panel action: abort an in-flight download. */
  cancelVectorInstall()       {
    this.installer?.cancel()
  }

  /**
   * What the installer put on disk, so the panel can say "释放 xxx MB" before
   * offering to remove it. Counts only our own layout (runtime dir, models dir,
   * log + pid), never the memory store.
   */
  vectorInstallUsage()                                     {
    const paths = installPaths(this.cfg.vector.installRoot, this.cfg.vector.installModel.file)
    const roots = [paths.dir, join(this.cfg.vector.installRoot, 'models')]
    const files = [paths.logFile, `${paths.logFile}.pid`, `${paths.logFile}.err`]
    let bytes = 0
    const seen           = []
    for (const p of [...roots, ...files]) {
      if (!existsSync(p)) continue
      seen.push(p)
      bytes += pathSize(p)
    }
    return { bytes, paths: seen }
  }

  /**
   * Remove the vector backend we installed (runtime + model + logs).
   *
   * Refuses when the configured backend lives outside installRoot: that is a
   * server the user installed and manages, and deleting it would be destroying
   * something we never created. The memory store is never touched — it lives
   * beside the runtime, not inside it.
   */
  uninstallVectorBackend()   
                    
                                                            
                      
                   
    {
    const root = this.cfg.vector.installRoot
    const configuredExe = this.cfg.vector.spawn.exe
    if (configuredExe && !isInside(root, configuredExe)) {
      return { removed: false, reason: 'EXTERNAL_BACKEND', freedBytes: 0, paths: [] }
    }
    const usage = this.vectorInstallUsage()
    if (usage.paths.length === 0) {
      return { removed: false, reason: 'NOT_INSTALLED', freedBytes: 0, paths: [] }
    }
    // Stop our child first: on Windows the executable and its DLLs are locked
    // while it runs, so removal would fail with EBUSY/EPERM.
    try { this.embedServer?.stop() } catch { /* best effort */ }
    const removedPaths           = []
    for (const p of usage.paths) {
      // Belt and braces: never step outside the install root, and never delete
      // the memory store even if someone pointed storeDir inside it.
      if (!isInside(root, p)) continue
      if (isInside(p, this.cfg.storeDir) || resolve(p) === resolve(this.cfg.storeDir)) continue
      try {
        rmSync(p, { recursive: true, force: true })
        removedPaths.push(p)
      } catch { /* leave it; the panel reports what went */ }
    }
    this.cfg.vector.configured = false
    this.cfg.vector.spawnConfigured = false
    this.cfg.vector.enabled = false
    this.embedServer = null
    return { removed: true, reason: 'REMOVED', freedBytes: usage.bytes, paths: removedPaths }
  }

  /**
   * Delete every memory record in every scope (the panel's "delete all data"
   * action, used when someone wants the plugin gone without leaving notes
   * behind). Goes through the store so the JSONL + vector sidecars stay
   * consistent instead of ripping files out from under a live store.
   */
  wipeAllRecords()                                        {
    this.discoverScopes()
    let removed = 0
    const scopes           = []
    for (const scope of this.store.allScopes()) {
      const ids = [...scope.records.keys()]
      if (ids.length === 0) continue
      let local = 0
      for (const id of ids) if (scope.remove(id)) local += 1
      removed += local
      scopes.push(scope.scope)
    }
    // 清空后 ANN 索引与缓存里的条目都失效：直接丢弃索引，下次按需重建。
    this.annIndexes.clear()
    try { this.store.flush() } catch { /* scheduled flush covers it */ }
    return { removed, scopes }
  }

  /**
   * Switch the provider over to a backend that is now on disk: fill the spawn
   * config from the installed layout and start it. Idempotent.
   */
          adoptInstalledBackend()       {
    const paths = detectInstalled(this.cfg.vector.installRoot, this.cfg.vector.installModel.file, this.systemRuntimeOptions())
    if (!paths) return
    this.cfg.vector.configured = true
    this.cfg.vector.spawnConfigured = true
    this.cfg.vector.enabled = true
    this.cfg.vector.runtimeSource = paths.system === true ? 'system' : 'managed'
    this.cfg.vector.spawn = {
      ...this.cfg.vector.spawn,
      enabled: true,
      exe: this.cfg.vector.spawn.exe ?? paths.exe,
      // 模型路径必须跟着**当前选择的模型**:换了模型就不能继续用上一个的文件(见 pickSpawnModel)。
      model: pickSpawnModel(this.cfg.vector.installModel.file, this.cfg.vector.spawn.model, paths.model),
      cwd: this.cfg.vector.spawn.cwd ?? paths.cwd,
      logFile: this.cfg.vector.spawn.logFile ?? paths.logFile,
      pooling: this.cfg.vector.pooling,
      gpuLayers: this.cfg.vector.flavor === 'cpu' || this.cfg.vector.flavor === 'auto' ? 0 : (this.cfg.vector.spawn.gpuLayers || 99),
      port: this.cfg.vector.spawn.port,
    }
    if (!this.embedServer) {
      this.startEmbedServer()
      return
    }
    void this.ensureEmbedServer(60_000).catch(() => { /* panel shows the outcome */ })
  }

  /**
   * 过期清理 + 容量淘汰（小时定时器与测试共用）。
   *
   * 0.30.0：归档会话作用域在归档期间**冻结** —— 过期与容量都不碰它们，
   * 恢复会话后记忆原样回来；恢复后下一次 housekeeping 再按原规则清理。
   */
  /**
   * 0.33.0：记忆巩固（手动 / 维护任务调用）。
   *
   * 只对**有向量的作用域**做（纯词法库没有语义聚类能力，强行按内容合并会误伤）；
   * 每轮最多处理 maxClusters 个簇，避免一次维护把 CPU 打满。巩固产生的新记录
   * 自动进 embedPending，由回填队列补向量。
   */
  consolidateNow()                                        {
    const created           = []
    let merged = 0
    if (!this.cfg.cognitive.consolidationEnabled) return { created, merged }
    this.discoverScopes()
    const now = Date.now()
    for (const scopeStore of this.store.allScopes()) {
      if (scopeStore.vectors.size === 0) continue
      // 只巩固"活着且不冲突"的记录：
      //  - 退役（superseded）、休眠、软删、过期/失效的都不参与；
      //  - 带 conflictWith 标记的记录**绝不合并** —— 它们是"措辞像但事实矛盾"的对，
      //    合并会把两个互相矛盾的事实揉成一条，比不巩固更糟。
      const retired = new Set        ()
      for (const rec of scopeStore.records.values()) {
        if ((rec                           ).supersedes !== undefined) retired.add((rec                          ).supersedes)
      }
      const candidates = [...scopeStore.records.values()].filter((rec) => {
        if (retired.has(rec.id)) return false
        if (!isRecordVisible(rec, { now })) return false
        const extra = rec                                                    
        if (Array.isArray(extra.conflictWith) && extra.conflictWith.length > 0) return false
        if (extra.validUntil !== undefined) return false
        return true
      })
      if (candidates.length < 2) continue
      let clusters                                               
      try {
        clusters = clusterRecords(candidates, {
          threshold: this.cfg.cognitive.consolidationThreshold,
          vectors: scopeStore.vectors,
        }).clusters.slice(0, this.cfg.cognitive.consolidationMaxClusters)
      } catch {
        continue
      }
      for (const cluster of clusters) {
        try {
          const plan = planConsolidation(cluster, { maxChars: this.cfg.maxRecordChars, now })
          if (plan === null) continue
          const applied = applyConsolidationPlan(this.store, plan)
          if (applied.record !== undefined) {
            created.push(applied.record.id)
            // applied.superseded 是基底 id（string）；本簇被合并掉的条数 = 簇大小 - 1。
            merged += Math.max(0, plan.supersedes.length - 1)
          }
        } catch { /* 单个簇失败不影响其它 */ }
      }
    }
    if (created.length > 0) this.store.scheduleFlush()
    return { created, merged }
  }

  /**
   * 0.33.0：后台维护 ANN 索引。
   *
   * 建图很贵（纯 JS HNSW 2 万条约 45s），**绝不能放在查询路径上**：这里只在
   * 维护定时器 / 回填完成后调用，建好之前检索继续走全量扫描，行为与 0.32 完全一致。
   * 索引以 scope 为粒度；size 与 store.vectors 不一致就视为过期并重建。
   */
          async maintainAnnIndexes()                {
    if (!this.cfg.vector.ann.enabled) return
    for (const scopeStore of this.store.allScopes()) {
      const scope = scopeStore.scope
      const total = scopeStore.vectors.size
      if (!shouldUseAnn(total, this.cfg.vector.ann.minSize)) continue
      const current = this.annIndexes.get(scope)
      if (current !== undefined && current.size === total) continue
      if (this.annBuilding.has(scope)) continue
      this.annBuilding.add(scope)
      try {
        const index = await createAnnIndex({
          dims: this.cfg.vector.dims,
          prefer: this.cfg.vector.ann.prefer,
          ...(this.cfg.vector.ann.M !== undefined ? { M: this.cfg.vector.ann.M } : {}),
          ...(this.cfg.vector.ann.efConstruction !== undefined ? { efConstruction: this.cfg.vector.ann.efConstruction } : {}),
          ...(this.cfg.vector.ann.efSearch !== undefined ? { efSearch: this.cfg.vector.ann.efSearch } : {}),
          log: (message        ) => console.warn(`[dsh-memory-local] ${message}`),
        })
        const items = [...scopeStore.vectors]
          .filter(([id]) => scopeStore.records.has(id))
          .map(([id, vector]) => ({ id, vector }))
        index.build(items)
        this.annIndexes.set(scope, { index, size: total })
      } catch {
        // 建图失败保持全量扫描，不影响正确性
      } finally {
        this.annBuilding.delete(scope)
      }
    }
  }

  runHousekeeping()                                                                                                                                                                                                                                                  {
    // 0.41.1：维护任务必须覆盖**磁盘上所有作用域**，不能只扫本进程已加载的。
    //（懒加载机制下，没被本会话碰过的旧 scope 不会被加载，否则休眠/墓碑清理/
    // 巩固/健康度都会漏掉它们。）
    this.discoverScopes()
    const frozen = (scope        )          => this.isArchivedSessionScope(scope)
    const purged = this.store.purgeExpired(Date.now(), frozen)
    const evicted = this.store.enforceLimit(this.cfg.maxRecordsPerScope, Date.now(), frozen)
    // 0.32.0：生命周期维护 —— 长期未访问且不重要的记录转休眠（不删），
    // 墓碑超过保留期的才物理删除。归档会话作用域一律冻结。
    const liveScopes = this.store.allScopes().map((s) => s.scope).filter((scope) => !frozen(scope))
    const dormant = this.cfg.cognitive.dormantAfterDays > 0
      ? markDormant(this.store, {
          afterDays: this.cfg.cognitive.dormantAfterDays,
          maxImportance: this.cfg.cognitive.dormantMaxImportance,
          scopes: liveScopes,
        }).marked
      : []
    const tombstones = purgeTombstones(this.store, { now: Date.now(), ...(liveScopes.length > 0 ? { scopes: liveScopes } : {}) })
    // 0.33.0：周期巩固（把同簇 episodic 记忆合并成一条 semantic 摘要）。
    const consolidated = this.consolidateNow().created
    // 0.62.5：回收"从没用过"的历史会话作用域（元数据只增不减会越攒越多）。
    const prunedScopes = pruneEmptySessionScopes(this.meta, {
      maxAgeMs: this.cfg.sessionScopeMaxAgeDays * 86_400_000,
      now: Date.now(),
      hasRecords: (scope) => {
        const scopeStore = this.store.peek(scope)
        return scopeStore !== undefined && scopeStore.records.size > 0
      },
      frozen: (scope) => frozen(scope),
    })
    // 0.40.0：P1 健康度快照（维护任务顺带算一次，面板可轮询）。
    let health
    try {
      const report = this.healthReport()
      health = { score: report.score, conflictRate: report.conflictRate, duplicateRate: report.duplicateRate, quarantined: report.quarantined, pending: report.pending }
    } catch { /* 健康度是增强，失败不影响维护 */ }
    return { purged, evicted, dormant, tombstones, consolidated, prunedScopes, ...(health !== undefined ? { health } : {}) }
  }

  /**
   * Hourly expired-record purge + capacity eviction. M4 housekeeping; the
   * timer is unref'd so it never holds the process open, and cleared by
   * flushSync()/dispose.
   */
          maintenanceTimer                                        = null

          startMaintenance()       {
    this.maintenanceTimer = setInterval(() => {
      this.runHousekeeping()
      void this.maintainAnnIndexes()
      this.store.scheduleFlush(0)
    }, 3_600_000)
    this.maintenanceTimer.unref?.()
    // Pending-embed drain: the store queues ids whose embed failed (backend
    // down at save time, or vectors restored from a jsonl-only backup). Until
    // this timer existed nothing ever drained that queue — a single outage
    // stranded them forever (observable as 待嵌入>0 in the memory panel).
    this.embedRetryTimer = setInterval(() => {
      void this.retryPendingEmbeds().catch(() => {})
    }, 60_000)
    this.embedRetryTimer.unref?.()
    // First drain shortly after boot, when the backend is usually already up.
    const initial = setTimeout(() => {
      this.initialDrainTimer = null
      void this.retryPendingEmbeds().catch(() => {})
    }, 5_000)
    initial.unref?.()
    this.initialDrainTimer = initial
  }

          embedRetryTimer                                        = null
          initialDrainTimer                                       = null
  /** Owns the llama-server child process when vector.spawn.enabled. */
          embedServer                            = null
  /**
   * 交互检索（查询嵌入）的可变预算。
   *
   * 默认 300ms 是为桌面 CPU 调的；在 ARM 手机 / 低功耗设备上单次查询嵌入实测
   * 0.3–1.8s，300ms 预算会让**每一次**交互检索都超时、静默退化成纯词法。
   * 这里按实测自适应：超时一次就用 4 倍预算重试，成功后再按耗时把预算钉在
   * 「实测 × 3」（上限 4s），之后不再反复超时。
   */
          queryTimeoutMs        
  /** Lazily created by the panel's "download and configure" action. */
          installer                         = null
  /** 自举是否在进行（避免重复触发）。 */
          bootstrapping = false
  /** 硬件探测缓存(面板问了才探测,10 分钟内复用)。 */
          hardwareCache                      = null
          hardwareAt = 0
          exitHook                      = null

  /**
   * Drain the pending-embed queue, probing through the circuit breaker first so
   * a backend that came back online is noticed (backfillEmbeddings itself
   * refuses to touch the network while marked unhealthy, and embed() is the
   * only path that can flip that flag back to healthy).
   */
  async retryPendingEmbeds()                  {
    // Vector retrieval opt-in: with no configured backend there is nothing to
    // retry, and probing would only produce failed requests in the log.
    if (!this.cfg.vector.enabled || !this.cfg.vector.configured) return 0
    // Scopes load lazily, so without discovery the queue of an untouched scope
    // (e.g. a project store written by a previous session) is invisible here and
    // would never drain — exactly the 待嵌入>0 the panel showed on 2026-10-10.
    try { this.store.loadDiscovered() } catch { /* discovery is best-effort */ }
    if (this.pendingEmbedCount === 0) return 0
    if (!this.embed.isHealthy) {
      const probe = await this.embed.embed(['ping'], undefined, { timeoutMs: this.cfg.vector.writeTimeoutMs }).catch(() => null)
      if (!probe) return 0
    }
    return this.backfillAll({ throttleMs: 100 })
  }

  /**
   * 写路径默认 scope 口径(tools.defaultScope 取值)。
   * 兼容:旧调用方传的是**具体 scope 键**(如 'project:<cwd>'),此时按"固定项目"处理。
   */
  setDefaultScope(scope                                                )       {
    if (scope === 'session' || scope === 'project' || scope === 'global') {
      this.defaultWriteScope = scope
      return
    }
    this.defaultWriteScope = 'project'
    this.projectScope = scope               
  }

  /** 固定项目 scope(只有**显式配置**才调);缺省由会话 cwd 决定。 */
  setProjectScope(scope             )       {
    this.projectScope = scope
  }

  /**
   * 拿不到会话时的项目键:显式配置优先,否则 `project:<process.cwd()>`
   * (用于构造期预载、以及任何没有 agent 上下文的兜底读写)。
   */
          get defaultProjectScope()              {
    return (this.projectScope ?? `project:${process.cwd()}`)               
  }

  /**
   * Provide the one-shot LLM caller used by the rerank stage. Passing null
   * (or never calling) keeps retrieval on recall-order only. The cordis
   * wiring adapts `ctx.llm` into this; it is optional by design — the service
   * must never sit PENDING just because no LLM adapter is loaded.
   */
  setLlmInvoke(invoke                  )       {
    this.llmInvoke = invoke
  }

  /** 写路径默认口径('session' | 'project' | 'global')。 */
  get activeDefaultScope()                                   {
    return this.defaultWriteScope
  }

  /**
   * 当前项目键(诊断/测试用)。没有会话时就是兜底键 —— 真实调用请用 `scopeRefs(agent)`,
   * 那里的优先级是 会话 cwd > 显式配置 > process.cwd()。
   */
  get activeProjectScope()              {
    return this.defaultProjectScope
  }

          assertScopeAllowed(scope             )       {
    if (scope === 'global') {
      if (!this.cfg.globalEnabled) throw memoryError('SCOPE_DISABLED', 'global scope is disabled by configuration')
      return
    }
    if (scope.startsWith('project:')) {
      if (!this.cfg.projectEnabled) throw memoryError('SCOPE_DISABLED', 'project scope is disabled by configuration')
      return
    }
    if (scope.startsWith('session:')) {
      if (!this.cfg.sessionEnabled) throw memoryError('SCOPE_DISABLED', 'session scope is disabled by configuration')
      return
    }
    if (!this.cfg.customEnabled) throw memoryError('SCOPE_DISABLED', 'custom scopes are disabled by configuration')
  }

  /**
   * scopes.custom.max 只统计**新建**的自定义 scope,而且只统计自定义的
   * (会话 / project / global 既不计入也不受限)。
   *
   * 计数走 `store.customScopeCount()`,它会顺带扫一遍磁盘 —— 只在"内存里的已加载数已经触到
   * 上限"时才真扫,否则直接放行,避免每次保存都读一遍 projects/ 目录。
   */
          assertCustomScopeBudget(scope             )       {
    if (!isCustomScope(scope)) return
    // 已有记录或已有元数据都算“已存在”：删光记录但保留元数据的作用域不该再占一个新名额。
    if (this.store.peek(scope) !== undefined || this.meta.has(scope)) return
    const loaded = this.store.allScopes().filter((s) => isCustomScope(s.scope)).length
    if (loaded < this.cfg.customMaxScopes && this.store.customScopeCount() < this.cfg.customMaxScopes) return
    throw memoryError(
      'SCOPE_LIMIT',
      `custom scope limit reached (${this.cfg.customMaxScopes}); reuse an existing scope instead. ${this.scopeInventory(5)}`,
    )
  }

  /** 作用域清单(名字 + 条数),给 SCOPE_LIMIT 之类的错误提示用。 */
  scopeInventory(limit = 20)         {
    const scopes = this.scopeStats()
    const lines = scopes.slice(0, limit).map((s) => `${s.scope}(${s.records})`)
    const rest = scopes.length - lines.length
    return rest > 0 ? `${lines.join(', ')}, …另有 ${rest} 个` : lines.join(', ')
  }

  /**
   * 写路径的 scope 解析:agent 上下文 → 当前会话 / 当前项目;模型省略 scope 时按
   * `tools.defaultScope`(默认 'session')落点。拿不到会话信息就回退 project,**不抛错**。
   */
  resolveWriteScope(agent         , requested         )              {
    const refs = this.scopeRefs(agent)
    const want = requested?.trim()
    if (want === undefined || want === '' || want.toLowerCase() === 'session') {
      // scopes.session 关掉时"当前会话"不存在:按 defaultScope 口径回退(默认口径是
      // session 而会话被关 → project),而不是让写撞上 SCOPE_DISABLED。
      const session = this.cfg.sessionEnabled ? refs.session : undefined
      return writeScopeForDefault(this.defaultWriteScope, { ...refs, session })
    }
    if (want.toLowerCase() === 'project') return refs.project
    if (want.toLowerCase() === 'global') return 'global'
    return requested                // 具体键(project:/session:/自定义名)由工具层 normalize 后传入
  }

  /** agent 上下文 → { session?, project }(会话能否用由调用方按 scopes.session 决定)。 */
  scopeRefs(agent         )                                                  {
    return resolveCurrentScopes(agent, { projectScope: this.projectScope })
  }

  /**
   * 当前项目 key(= `scopeRefs(agent).project`)。工具层用它解析 `scope:'project'`,保证与服务端
   * 读/写口径**同一处** —— 0.5.5 及以前工具层自己算了一份 `project:<process.cwd()>`,于是同一个
   * 概念在两个层各有各的答案。
   */
  projectKeyFor(agent         )              {
    return this.scopeRefs(agent).project
  }

  /** 宿主注入 live session 查询(用于沿 parentSession 链继承可见范围)。 */
  setSessionLookup(lookup                                       )       {
    this.sessionLookup = lookup
  }

  /**
   * 宿主注入归档会话查询（0.30.0）。每次判定都实时读取，不缓存：
   * 归档/恢复是宿主 `workspaceRegistry` 的持久状态，读它才能保证
   * 「归档后检索不到、恢复后立刻能检索」与宿主的会话生命周期一致。
   * 服务未就绪 / 老宿主拿不到时按「没有归档」处理。
   */
  setArchivedSessionLookup(lookup                                                   )       {
    this.archivedLookup = lookup
  }

  /** 宿主注入记忆事件总线（0.31.0）；事件只是旁路，未注入时进程内空转。 */
  setEventBus(bus                )       {
    this.events = bus
  }

  /** 宿主当前归档的会话 id 集合（实时读取；容错为空集合）。 */
  archivedSessionIds()              {
    const out = new Set        ()
    if (this.archivedLookup === undefined) return out
    try {
      const ids = this.archivedLookup()
      if (Array.isArray(ids)) {
        for (const id of ids) {
          if (typeof id === 'string' && id !== '') out.add(id)
        }
      }
    } catch {
      // 宿主服务未就绪：当作没有归档，绝不能因为生命周期查询失败而让检索挂掉。
    }
    return out
  }

  /** 已归档的**会话作用域键**集合（`session:<id>`）。 */
          archivedSessionScopes()              {
    const out = new Set        ()
    for (const id of this.archivedSessionIds()) out.add(`session:${id}`)
    return out
  }

  /** 这个作用域是否是已归档会话的作用域（只有 session: 键会命中）。 */
  isArchivedSessionScope(scope        )          {
    if (typeof scope !== 'string' || !scope.startsWith('session:')) return false
    return this.archivedSessionIds().has(scope.slice('session:'.length))
  }

  /**
   * 会话创建时**系统自动建立**会话作用域（0.30.0）。
   *
   * 只写 scope-meta（用途 + 创建者 system），不写任何记忆记录；用户 / Agent
   * 之后的第一条 `memory_save` 仍走原来的懒创建路径。已有元数据（用户改过用途、
   * 或之前保存过）时不覆盖。会话作用域类型被关闭时不动。
   *
   * @returns 是否新建了元数据。
   */
  ensureSessionScope(sessionId        )          {
    const id = typeof sessionId === 'string' ? sessionId.trim() : ''
    if (id === '' || !this.cfg.sessionEnabled) return false
    const scope = `session:${id}`               
    if (this.meta.get(scope) !== undefined) return false
    this.meta.put(scope, {
      description: '会话作用域：仅本会话可见的过程记忆；随会话归档与恢复（系统自动创建）。',
      createdBy: 'system',
      status: 'ready',
    })
    return true
  }

  /** 只保留当前配置允许的 scope(覆盖集合里若含被禁用的 scope,静默剔除)。 */
          filterEnabledRules(rules                           )                   {
    const out                   = []
    // 已归档会话的作用域不在「可见域」里：用户归档前勾选过也一并剔除，
    // 恢复会话后规则会自动重新生效（规则本身没被改写）。
    const archived = this.archivedSessionScopes()
    for (const raw of rules) {
      const scope = this.canonicalScope(raw.scope)
      if (archived.has(scope)) continue
      if (out.some((rule) => rule.scope === scope)) continue
      switch (scopeKind(scope)) {
        case 'global': if (!this.cfg.globalEnabled) continue; break
        case 'project': if (!this.cfg.projectEnabled) continue; break
        case 'session': if (!this.cfg.sessionEnabled) continue; break
        default: if (!this.cfg.customEnabled) continue; break
      }
      // 0.19.1 起不再按记忆类型收窄:旧文件里的 kinds 忽略,只保留作用域;
      // 0.23.0 保留每个作用域的 read / write 状态(false 才落)。
      out.push({
        scope,
        ...(raw.read === false ? { read: false } : {}),
        ...(raw.write === false ? { write: false } : {}),
      })
    }
    return out
  }

  /**
   * 从会话 id 沿 parentSession 链找最近的显式可见域。
   *
   * 起点用**当前会话自己的 id**(不是 resolveCurrentScopes 映射后的父会话):
   * 子 Agent 自己也可以有一份覆盖;没有时才沿链继承父会话 / 根会话。
   * `inherited` = 找到的那份覆盖不属于当前会话自己。
   */
          resolveVisibility(
    sessionId                    ,
  )                                                                      {
    const own = sessionId ?? ''
    let id = own
    const seen = new Set        ()
    while (id !== '' && !seen.has(id)) {
      seen.add(id)
      const found = this.visibility.get(id)
      if (found !== undefined) return { config: found, inherited: id !== own }
      let parent                    
      try {
        const session = this.sessionLookup?.(id)                                                        
        parent = typeof session?.header?.parentSession === 'string' && session.header.parentSession !== ''
          ? session.header.parentSession
          : undefined
      } catch { parent = undefined }
      id = parent ?? ''
    }
    return undefined
  }

  /** agent 上真实的会话 id(不映射到父会话);用于可见范围自己的文件。 */
          rawSessionIdOf(agent         )                     {
    try {
      const session = (agent                                                                         )?.session
      const id = session?.header?.id ?? session?.id
      return typeof id === 'string' && id !== '' ? id : undefined
    } catch {
      return undefined
    }
  }

  /**
   * 沿 parentSession 链收集 grant（当前会话在前、父会话在后）。
   * 子 Agent 与父会话是同一个任务，应该继承父会话获批的权限。
   */
          resolveGrantChain(sessionId        )               {
    const out               = []
    const seen = new Set        ()
    let id = sessionId
    while (id !== '' && !seen.has(id)) {
      seen.add(id)
      out.push(...this.grants.list(id))
      let parent                    
      try {
        const session = this.sessionLookup?.(id)                                                        
        parent = typeof session?.header?.parentSession === 'string' && session.header.parentSession !== ''
          ? session.header.parentSession
          : undefined
      } catch { parent = undefined }
      id = parent ?? ''
    }
    return out
  }

  /**
   * 当前 agent 的有效 grant：作用域仍启用、作用域代次一致（同名重建不复用旧授权）。
   * `grants.list()` 已过滤撤销 / 过期；这里再按 provider 的 canonicalScope 统一键。
   */
          validGrants(agent         )               {
    const sessionId = this.rawSessionIdOf(agent)
    if (sessionId === undefined) return []
    const out               = []
    for (const grant of this.resolveGrantChain(sessionId)) {
      const scope = this.canonicalScope(grant.scope)
      if (!this.scopeEnabled(scope)) continue
      const meta = this.meta.get(scope)
      if (meta !== undefined && grant.scopeGeneration !== meta.generation) continue
      out.push({ ...grant, scope })
    }
    return out
  }

  /** 面板/诊断：当前会话（含父链）的有效授权快照。 */
  activeGrants(agent         )               {
    return this.validGrants(agent)
  }

  /** 没有显式覆盖时的默认可见域范围(会话 + 项目 + global + 工作区绑定的作用域)。 */
  /** 默认三路(会话 + 项目 + global),**不含**工作区绑定;各自开关生效。 */
          baseDefaultScopes(agent         )                {
    const refs = this.scopeRefs(agent)
    const out                = []
    const push = (scope                         , enabled         )       => {
      if (scope === undefined || !enabled || out.includes(scope)) return
      out.push(scope)
    }
    push(refs.session, this.cfg.sessionEnabled)
    push(refs.project, this.cfg.projectEnabled)
    push('global', this.cfg.globalEnabled)
    return out
  }

  /**
   * 面板:默认可见范围的**基础集合**(会话 + 项目 + global)。
   * 这些作用域天然包含在默认范围里,面板把它们显示为「已绑定」且不可取消;
   * 工作区绑定只用于**额外**并入的作用域。
   */
  defaultScopes(agent         )                {
    return this.baseDefaultScopes(agent)
  }

  /** 没有显式覆盖时的默认可见域范围(基础三路 + 工作区绑定的额外作用域)。 */
          defaultReadScopes(agent         )                {
    const out = this.baseDefaultScopes(agent)
    const archived = this.archivedSessionScopes()
    const push = (scope             )       => {
      if (archived.has(scope)) return
      if (out.includes(scope)) return
      out.push(scope)
    }
    // 0.23.0:工作区绑定的作用域默认可见。会话作用域不能绑定,这里再守一次。
    const refs = this.scopeRefs(agent)
    for (const raw of this.bindings.get(refs.project)) {
      const scope = this.canonicalScope(raw)
      if (scopeKind(scope) === 'session') continue
      if (!this.scopeEnabled(scope)) continue
      push(scope)
    }
    return out
  }

  /** 某个具体作用域在当前配置下是否启用(global/project/session/custom 各自开关)。 */
          scopeEnabled(scope             )          {
    switch (scopeKind(scope)) {
      case 'global': return this.cfg.globalEnabled
      case 'project': return this.cfg.projectEnabled
      case 'session': return this.cfg.sessionEnabled
      default: return this.cfg.customEnabled
    }
  }

  /**
   * 生效的「记忆可见域」。**永远有值**(0.20.0 起):没有显式覆盖时返回默认策略。
   * level='none' 时 scopes 仍保留(供面板/下次切换),但**不参与**读写限制。
   */
  visibilityPolicy(agent         )                       {
    const resolved = this.resolveVisibility(this.rawSessionIdOf(agent))
    if (resolved === undefined) {
      return {
        level: DEFAULT_VISIBILITY_LEVEL,
        scopes: this.defaultReadScopes(agent).map((scope) => ({ scope })),
        source: 'default',
      }
    }
    return {
      level: resolved.config.level,
      scopes: this.filterEnabledRules(resolved.config.scopes),
      source: resolved.inherited ? 'inherited' : 'explicit',
    }
  }

  /**
   * **显式**「可见范围」的 scope 键列表(不含默认策略,注入半边用它判断是否被
   * 显式白名单收窄,并决定要不要把 inject.extraScopes 关掉)。
   * undefined = 本会话没有显式覆盖(或等级为 none);
   * [] = 显式设置了范围但全部被 scope 开关禁用,调用方必须按空处理。
   */
  visibleScopes(agent         )                            {
    const resolved = this.resolveVisibility(this.rawSessionIdOf(agent))
    if (resolved === undefined || resolved.config.level === 'none') return undefined
    return this.filterEnabledRules(resolved.config.scopes)
      .filter((rule) => rule.read !== false)
      .map((rule) => this.canonicalScope(rule.scope))
  }

  /** 某个 scope 下允许的记忆类型;undefined = 不限制(可见且没有类型白名单)。 */
  visibleKinds(agent         , scope        )                       {
    const policy = this.visibilityPolicy(agent)
    if (policy.level === 'none') return undefined
    const key = this.canonicalScope(scope)
    const rule = policy.scopes.find((item) => this.canonicalScope(item.scope) === key)
    if (rule === undefined) return []
    if (rule.read === false) return []
    return rule.kinds !== undefined && rule.kinds.length > 0 ? [...rule.kinds] : undefined
  }

  /**
   * 把 agent 解析成一次性授权上下文（可见域只解析一次）。
   * 纯函数 `authorize()` 是唯一规则出口；这里只负责把配置 / 策略翻译成上下文。
   */
          accessContext(agent         )                {
    const policy = this.visibilityPolicy(agent)
    return {
      level: policy.level,
      scopes: policy.scopes,
      enabled: {
        global: this.cfg.globalEnabled,
        project: this.cfg.projectEnabled,
        session: this.cfg.sessionEnabled,
        custom: this.cfg.customEnabled,
      },
      originOf: (scope) => scopeKind(scope),
      grants: this.validGrants(agent),
      archivedScopes: this.archivedSessionScopes(),
    }
  }

  /**
   * 统一授权判定：discover / read / write / delete 全部走这里。
   * 工具层、检索过滤、目录与注入都应以它为准，不再各自解释 absolute / normal / none。
   */
  authorize(agent         , request               )                 {
    return authorizeAccess(
      { ...request, scope: this.canonicalScope(request.scope) },
      this.accessContext(agent),
    )
  }

  /**
   * 一次解析、多次判定的版本：检索会逐条判定命中，不能每条都重新解析可见域
   * （那会重复读会话文件、重复走 parentSession 链）。
   */
  accessEvaluator(agent         )                                             {
    const context = this.accessContext(agent)
    return (request) => authorizeAccess(
      { ...request, scope: this.canonicalScope(request.scope) },
      context,
    )
  }

  /** 一条记录(scope + kind)是否可读。 */
  isRecordVisible(agent         , scope        , kind        )          {
    return this.authorize(agent, { scope, action: 'read', kind }).allowed
  }

  /** 某个作用域是否可读(0.23.0:read 开关);等级 none 时恒为 true。 */
  isScopeReadable(agent         , scope        )          {
    return this.authorize(agent, { scope, action: 'read' }).allowed
  }

  /** 某个作用域是否可写(0.23.0:write 开关);等级 none 时恒为 true。 */
  isScopeWritable(agent         , scope        )          {
    return this.authorize(agent, { scope, action: 'write' }).allowed
  }

  /**
   * 一个作用域是否可写。0.20 的旧名保留给旧调用方;0.23 起 write 开关独立于 read,
   * 权威判断见 `isScopeWritable`。
   */
  isScopeOperable(agent         , scope        )          {
    return this.isScopeWritable(agent, scope)
  }

  /**
   * 批量过滤用的可见域判定(策略只解析一次,避免每条记录都走一遍 parentSession 链)。
   * undefined = 不限制。
   */
          visibilityFilterFor(agent         )                                                         {
    if (this.visibilityPolicy(agent).level === 'none') return undefined
    const evaluate = this.accessEvaluator(agent)
    return (scope, kind) => evaluate({ scope, action: 'read', kind }).allowed
  }

  /** 面板:读取某会话自己的覆盖(null = 没有覆盖,继续用默认集合)。 */
  sessionVisibility(sessionId        )                                 {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') return null
    const config = this.visibility.get(sessionId.trim())
    return config === undefined ? null : config
  }

  /**
   * 面板:写入/清除某会话的覆盖。null = 恢复默认。
   * 也接受 0.18 的 `string[]`(按绝对限制 + 全部类型),避免外部调用方升级即断。
   */
  setSessionVisibility(sessionId        , config                                                    )                                 {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') return null
    const normalized                                 = config === null
      ? null
      : Array.isArray(config)
        ? { scopes: (config                     ).map((scope) => ({ scope })), level: 'absolute'                    }
        : config                           
    const cleaned = normalized === null ? null : this.normalizeVisibilityConfig(normalized)
    const written = this.visibility.set(sessionId.trim(), cleaned)
    // 变更通知:下一次 pre-step 以 user 消息注入,让 Agent 知道新范围与新规则。
    this.visibilityNotices.set(sessionId.trim(), { config: written, at: Date.now() })
    return written
  }

  /** 当前工作区 key(= 会话 cwd 解析出的 project scope)。 */
  workspaceKeyFor(agent         )              {
    return this.scopeRefs(agent).project
  }

  /** 面板:当前工作区绑定的作用域(默认可见范围会额外并入它们)。 */
  workspaceBindings(agent         )                {
    const workspace = this.workspaceKeyFor(agent)
    return this.bindings.get(workspace).map((scope) => this.canonicalScope(scope))
  }

  /**
   * 面板:设置当前工作区绑定的作用域。
   *
   * 绑定只接受具体作用域键;会话作用域不能绑定(它属于某一次会话,不属于工作区)。
   * 空数组 = 取消全部绑定。
   *
   * 0.25.13:绑定**不**注入「记忆权限已更新」上下文提示。绑定是工作区级设置
   * (影响本工作区**新会话**的默认可见范围),当前会话自己读什么并没有变,给
   * Agent 塞一条权限通知只会误导它以为自己刚刚被重新授权 / 撤销。
   */
  setWorkspaceBindings(agent         , scopes                   )                {
    const workspace = this.workspaceKeyFor(agent)
    const out                = []
    for (const raw of scopes) {
      const normalized = normalizeScopeInput(typeof raw === 'string' ? raw : '')
      if (!normalized.ok) throw memoryError(normalized.code, normalized.message)
      if (normalized.kind === 'all' || normalized.kind === 'current-session' || normalized.kind === 'current-project' || normalized.scope === undefined) {
        throw memoryError('SCOPE_INVALID', `绑定必须是具体作用域键: ${JSON.stringify(raw)}`)
      }
      const scope = this.canonicalScope(normalized.scope)
      if (scopeKind(scope) === 'session') {
        throw memoryError('SCOPE_INVALID', '会话作用域不能绑定到工作区(它只属于某一次会话)')
      }
      if (!this.scopeEnabled(scope)) throw memoryError('SCOPE_DISABLED', `作用域 ${scope} 已被禁用,不能绑定`)
      if (out.includes(scope)) continue
      out.push(scope)
    }
    const written = this.bindings.set(workspace, out)
    return written.map((scope) => this.canonicalScope(scope))
  }

  /** 校验并规范化面板提交的可见域(必须是具体作用域键;不接受 all/current-*)。 */
          normalizeVisibilityConfig(config                         )                          {
    const rules = cleanVisibilityRules(config.scopes)
    if (rules === undefined || rules.length === 0) {
      throw memoryError('SCOPE_EMPTY', '至少选择一个可见的记忆范围')
    }
    const out                   = []
    for (const rule of rules) {
      const normalized = normalizeScopeInput(rule.scope)
      if (!normalized.ok) throw memoryError(normalized.code, normalized.message)
      if (normalized.kind === 'all' || normalized.kind === 'current-session' || normalized.kind === 'current-project') {
        throw memoryError('SCOPE_INVALID', `可见范围必须是具体作用域键: ${JSON.stringify(rule.scope)}`)
      }
      if (normalized.scope === undefined) continue
      const scope = this.canonicalScope(normalized.scope)
      if (out.some((item) => item.scope === scope)) continue
      // 不再支持按记忆类型收窄:提交里的 kinds 一律忽略;read/write 只保留 false。
      out.push({
        scope,
        ...(rule.read === false ? { read: false } : {}),
        ...(rule.write === false ? { write: false } : {}),
      })
    }
    if (out.length === 0) throw memoryError('SCOPE_EMPTY', '至少选择一个可见的记忆范围')
    const level                  = config.level === 'normal' || config.level === 'none' ? config.level : 'absolute'
    return { scopes: out, level }
  }

  /**
   * 取出并删除某会话待注入的「可见域变更」通知。
   * 沿 parentSession 链找:子 Agent 继承父会话的范围,也应该收到父会话的变更。
   */
  takeVisibilityNotice(agent         )                                                         {
    let id = this.rawSessionIdOf(agent) ?? ''
    const seen = new Set        ()
    while (id !== '' && !seen.has(id)) {
      seen.add(id)
      const found = this.visibilityNotices.get(id)
      if (found !== undefined) {
        this.visibilityNotices.delete(id)
        return { config: found.config }
      }
      let parent                    
      try {
        const session = this.sessionLookup?.(id)                                                        
        parent = typeof session?.header?.parentSession === 'string' && session.header.parentSession !== ''
          ? session.header.parentSession
          : undefined
      } catch { parent = undefined }
      id = parent ?? ''
    }
    return undefined
  }

  /** 每个 scope 下按类型统计条数(面板「类型」选择器用)。 */
  scopeKindStats()                                                               {
    const out                                                               = []
    for (const scope of this.store.allScopes()) {
      const counts = new Map                ()
      for (const record of scope.records.values()) counts.set(record.kind, (counts.get(record.kind) ?? 0) + 1)
      for (const [kind, records] of [...counts].sort((a, b) => a[0].localeCompare(b[0]))) {
        out.push({ scope: scope.scope, kind, records })
      }
    }
    return out
  }

  /**
   * 普通限制:范围外命中时创建一条待审批,等待面板回答。
   * 超时返回 `'timeout'`(和用户主动拒绝区分开,工具层要把真实原因告诉模型);
   * 调用被中止按拒绝处理。
   */
  requestOutOfScope(
    agent         ,
    input   
                  
                                         
                               
                   
                                           
                          
                                           
                                
                                              
                          
     ,
  )                                    {
    if (input.items.length === 0) return Promise.resolve({ outcome: 'allowed-once' })
    if (input.signal?.aborted) return Promise.resolve({ outcome: 'rejected' })
    const sessionId = this.rawSessionIdOf(agent) ?? ''
    const id = `vis-${Date.now().toString(36)}-${++this.approvalSeq}`
    const createdAt = Date.now()
    const expiresAt = createdAt + VISIBILITY_APPROVAL_TTL_MS
    const description = typeof input.description === 'string' ? input.description.replace(/\s+/g, ' ').trim().slice(0, 500) : ''
    const auditBase                     = {
      at: createdAt,
      event: 'requested',
      id,
      sessionId,
      tool: input.tool,
      action: input.action ?? 'read',
      mode: input.mode ?? 'records',
      scopes: [...new Set(input.items.map((item) => item.scope))],
      count: input.items.length,
      ...(description !== '' ? { description } : {}),
    }
    this.approvalAudit.append(auditBase)
    return new Promise((resolve) => {
      let timer                                           
      const onAbort = () => finish({ outcome: 'rejected' }, 'aborted')
      const finish = (answer                          , why                       )       => {
        const pending = this.pendingApprovals.get(id)
        if (pending === undefined) return
        this.pendingApprovals.delete(id)
        if (timer !== undefined) clearTimeout(timer)
        try { input.signal?.removeEventListener('abort', onAbort) } catch { /* 已卸载 */ }
        this.approvalAudit.append({
          ...auditBase,
          at: Date.now(),
          event: why === 'timeout' ? 'timeout' : 'denied',
          outcome: answer.outcome,
        })
        pending.resolve(answer)
      }
      timer = setTimeout(() => finish({ outcome: 'timeout' }, 'timeout'), VISIBILITY_APPROVAL_TTL_MS)
      timer.unref?.()
      this.pendingApprovals.set(id, {
        id,
        sessionId,
        tool: input.tool,
        action: input.action ?? 'read',
        query: input.query,
        ...(description !== '' ? { description } : {}),
        ...(input.mode !== undefined ? { mode: input.mode } : {}),
        items: input.items.slice(0, VISIBILITY_APPROVAL_MAX_ITEMS).map((item) => ({
          ...item,
          tags: [...item.tags],
        })),
        createdAt,
        expiresAt,
        resolve: resolve,
        timer,
      })
      try { input.signal?.addEventListener('abort', onAbort, { once: true }) } catch { /* 已中止 */ }
    })
  }

  /** 面板:当前所有待审批(可按会话过滤)。 */
  pendingVisibilityApprovals(sessionId         )                           {
    const out                           = []
    for (const pending of this.pendingApprovals.values()) {
      if (sessionId !== undefined && sessionId !== '' && pending.sessionId !== sessionId) continue
      out.push({
        id: pending.id,
        sessionId: pending.sessionId,
        tool: pending.tool,
        action: pending.action,
        query: pending.query,
        ...(pending.description !== undefined ? { description: pending.description } : {}),
        ...(pending.mode !== undefined ? { mode: pending.mode } : {}),
        // 轮询载荷保持轻量:正文截到 1200 字,悬浮需要全文时面板再按 id 取一次。
        items: pending.items.map((item) => ({
          ...item,
          content: item.content.length > 1200 ? `${item.content.slice(0, 1200)}…` : item.content,
          tags: [...item.tags],
        })),
        createdAt: pending.createdAt,
        expiresAt: pending.expiresAt,
      })
    }
    return out.sort((a, b) => a.createdAt - b.createdAt)
  }

  /**
   * 侧边栏阻塞提醒用的轻量快照(0.25.14)：只要审批身份 + 会话。
   *
   * 与 `pendingVisibilityApprovals` 同一份内存真值，但**不复制条目正文**：
   * 客户端全局轮询它来发布 `pendingInteraction`，让宿主侧边栏给等待审批的会话
   * 显示黄色圆点 /「待审批」；完整 payload 仍由 dock 按当前会话拉取。
   */
  pendingVisibilityApprovalPresence(sessionId         )                               {
    const out                               = []
    for (const pending of this.pendingApprovals.values()) {
      if (sessionId !== undefined && sessionId !== '' && pending.sessionId !== sessionId) continue
      out.push({
        id: pending.id,
        sessionId: pending.sessionId,
        tool: pending.tool,
        action: pending.action,
        ...(pending.mode !== undefined ? { mode: pending.mode } : {}),
        createdAt: pending.createdAt,
        expiresAt: pending.expiresAt,
      })
    }
    return out.sort((a, b) => a.createdAt - b.createdAt)
  }

  /** 面板:回答一条待审批。返回 false = 已经不存在/已超时。 */
  answerVisibilityApproval(id        , outcome                             , allowedIds                    )          {
    const pending = this.pendingApprovals.get(id)
    if (pending === undefined) return false
    this.pendingApprovals.delete(id)
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    let answer                          
    if (outcome !== 'allowed-once') {
      answer = { outcome }
    } else if (Array.isArray(allowedIds)) {
      const known = new Set(pending.items.map((item) => item.id))
      const picked = [...new Set(allowedIds.map(String).filter((itemId) => known.has(itemId)))]
      // 一条都没勾选 = 拒绝;全部勾选退化成老口径(不传 allowedIds = 全部允许)。
      answer = picked.length === 0
        ? { outcome: 'rejected' }
        : picked.length === known.size
          ? { outcome: 'allowed-once' }
          : { outcome: 'allowed-once', allowedIds: picked }
    } else {
      answer = { outcome: 'allowed-once' }
    }
    this.approvalAudit.append({
      at: Date.now(),
      event: answer.outcome === 'allowed-once' ? 'approved' : 'denied',
      id,
      sessionId: pending.sessionId,
      tool: pending.tool,
      action: pending.action,
      mode: pending.mode ?? 'records',
      scopes: [...new Set(pending.items.map((item) => item.scope))],
      count: pending.items.length,
      outcome: answer.outcome,
    })
    pending.resolve(answer)
    return true
  }

  /**
   * Agent 主动申请范围外作用域的会话权限（0.24.0 / D3）。
   *
   * 流程：先按统一授权判定逐条筛（已允许 / 已授权 / 不可申请都不弹卡），
   * 只把**可申请**的 scope + 权限合成审批卡（`mode='grant'`），用户批准后
   * 写入 `grants/<session>.json`（仅本会话，子 Agent 沿 parentSession 继承）。
   *
   * 一次性访问**不在**这里：它继续由 memory_* 的隐式审批处理；本工具只申请会话授权。
   */
  async requestScopeGrants(
    agent         ,
    input   
                                                                                         
                     
                          
                          
     ,
  )                                   {
    const sessionId = this.rawSessionIdOf(agent)
    const results                                = []
    const describe = (request                                             )                    =>
      [...new Set(request.permissions.filter((item)                          => item === 'read' || item === 'write'))]
    if (sessionId === undefined) {
      for (const request of input.requests) {
        const scope = this.canonicalScope(request.scope)
        for (const permission of describe(request)) results.push({ scope, permission, status: 'unavailable' })
      }
      return { results, outcome: 'unavailable', grants: [] }
    }

    const pending                                                                         = []
    const seen = new Set        ()
    for (const request of input.requests) {
      const scope = this.canonicalScope(request.scope)
      for (const permission of describe(request)) {
        const key = `${scope}\0${permission}`
        if (seen.has(key)) continue
        seen.add(key)
        const decision = this.authorize(agent, { scope, action: permission === 'read' ? 'read' : 'write' })
        if (decision.allowed) {
          results.push({
            scope,
            permission,
            status: decision.source === 'grant' ? 'already-granted' : 'already-allowed',
          })
          continue
        }
        if (!decision.requestable) {
          results.push({ scope, permission, status: 'not-requestable', ...(decision.reason !== undefined ? { reason: decision.reason } : {}) })
          continue
        }
        pending.push({ id: `grant:${scope}:${permission}`, scope, permission })
      }
    }
    if (pending.length === 0) return { results, grants: [] }

    const reason = typeof input.reason === 'string' ? input.reason.replace(/\s+/g, ' ').trim().slice(0, 500) : ''
    const answer = await this.requestOutOfScope(agent, {
      tool: 'memory_scopes',
      action: 'read',
      query: reason === '' ? [...new Set(pending.map((item) => item.scope))].join(' ') : reason,
      ...(input.description !== undefined ? { description: input.description } : {}),
      mode: 'grant',
      items: pending.map((item) => ({
        id: item.id,
        scope: item.scope,
        kind: 'grant',
        content: item.permission === 'read' ? '只读访问' : '写入 / 删除',
        tags: [],
        importance: 0,
        updatedAt: Date.now(),
        reason: 'scope'         ,
        grantPermission: item.permission,
      })),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    })

    if (answer.outcome !== 'allowed-once') {
      const status                          = answer.outcome === 'timeout' ? 'timeout' : answer.outcome === 'unavailable' ? 'approval-unavailable' : 'denied'
      for (const item of pending) {
        results.push({ scope: item.scope, permission: item.permission, status })
      }
      return { results, outcome: answer.outcome, grants: [] }
    }

    const approved = answer.allowedIds === undefined
      ? new Set(pending.map((item) => item.id))
      : new Set(answer.allowedIds)
    const granted               = []
    for (const item of pending) {
      if (!approved.has(item.id)) {
        results.push({ scope: item.scope, permission: item.permission, status: 'denied' })
        continue
      }
      const meta = this.meta.get(item.scope)
      const grant = this.grants.add(sessionId, {
        scope: item.scope,
        permissions: [item.permission],
        grantedBy: 'user',
        ...(meta !== undefined ? { scopeGeneration: meta.generation } : {}),
      })
      granted.push(grant)
      this.recordPermissionNotice(sessionId, {
        event: 'granted',
        scope: item.scope,
        permissions: [item.permission],
        by: 'agent',
      })
      this.approvalAudit.append({
        at: Date.now(),
        event: 'granted',
        id: grant.id,
        sessionId,
        tool: 'memory_scopes',
        action: 'grant',
        mode: 'grant',
        scopes: [item.scope],
        permissions: [item.permission],
        outcome: 'granted',
      })
      results.push({ scope: item.scope, permission: item.permission, status: 'granted' })
    }
    return { results, outcome: 'allowed-once', grants: granted }
  }

  /** 面板 / 诊断：当前会话的有效授权（含父会话继承）。 */
  grantList(agent         )               {
    return this.validGrants(agent)
  }

  /**
   * 面板「记忆权限」：某会话当前有效授权（含父会话继承）。
   * grant.sessionId 标明授权来自哪个会话；与入参不同 = 继承自父会话，面板不可直接撤销。
   */
  sessionGrants(sessionId        )               {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') return []
    const agentLike = { session: { header: { id: sessionId.trim() } } }
    try {
      return this.validGrants(agentLike)
    } catch {
      return []
    }
  }

  /**
   * 取出并删除待注入的「权限变更」通知（0.25.0），同时附上当前有效授权快照。
   * 沿 parentSession 链找：子 Agent 继承父会话的授权，也应当收到父会话的授权变化。
   */
  takePermissionNotice(agent         )                                   {
    let id = this.rawSessionIdOf(agent) ?? ''
    const seen = new Set        ()
    while (id !== '' && !seen.has(id)) {
      seen.add(id)
      const found = this.permissionNotices.get(id)
      if (found !== undefined) {
        this.permissionNotices.delete(id)
        let grants               = []
        try { grants = this.validGrants(agent) } catch { grants = [] }
        return { changes: [...found.changes], grants }
      }
      let parent                    
      try {
        const session = this.sessionLookup?.(id)                                                        
        parent = typeof session?.header?.parentSession === 'string' && session.header.parentSession !== ''
          ? session.header.parentSession
          : undefined
      } catch { parent = undefined }
      id = parent ?? ''
    }
    return undefined
  }

  /** 记一条待注入的权限变更（同一会话合并，pre-step 一次性取走）。 */
          recordPermissionNotice(sessionId        , change                        )       {
    if (typeof sessionId !== 'string' || sessionId === '') return
    const existing = this.permissionNotices.get(sessionId)
    if (existing === undefined) {
      this.permissionNotices.set(sessionId, { at: Date.now(), changes: [change] })
      return
    }
    existing.changes.push(change)
    existing.at = Date.now()
  }

  /** 面板：撤销某会话的一条授权。已撤销 / 已过期的 id 返回 false（幂等语义下也算未找到）。 */
  revokeGrant(sessionId        , id        )          {
    if (typeof sessionId !== 'string' || sessionId === '') return false
    // list() 已过滤撤销 / 过期：拿不到 before 说明这条授权已经不在生效集合里，
    // 不能再让 store.revoke() 对历史条目再写一次撤销（否则面板会 404 之外还误报成功）。
    const before = this.grants.list(sessionId).find((grant) => grant.id === id)
    if (before === undefined) return false
    const ok = this.grants.revoke(sessionId, id)
    if (ok) {
      this.approvalAudit.append({
        at: Date.now(),
        event: 'revoked',
        id,
        sessionId,
        tool: 'memory_scopes',
        action: 'revoke',
        mode: 'grant',
        scopes: [before.scope],
        permissions: before.permissions,
        outcome: 'revoked',
      })
      this.recordPermissionNotice(sessionId, {
        event: 'revoked',
        scope: before.scope,
        permissions: [...before.permissions],
        by: 'user',
      })
    }
    return ok
  }

  /** 面板 / 诊断：最近的审批与授权事件（不含记忆正文）。 */
  approvalAuditList(limit = 200)                       {
    return this.approvalAudit.list(limit)
  }

  /**
   * 无显式 scope 时的**读取**合并集合:当前会话 + 当前项目 + global(各自开关生效、按 key 去重)。
   * 工具 / 注入都用它。会话设置了「可见范围」时以覆盖为准(不再并入默认集合)。
   * 没有显式覆盖时返回默认三路集合 —— 与默认可见域(`visibilityPolicy().source==='default'`)
   * 完全相同,所以"默认并没有限制"这句话在 0.20 之后不再成立。
   */
  resolveReadScopes(agent         )                {
    const explicit = this.visibleScopes(agent)
    // level='none' 时 visibleScopes 返回 undefined:不限制读取,继续用默认三路集合。
    if (explicit !== undefined) return explicit
    return this.defaultReadScopes(agent)
  }

  /**
   * 写入/删除护栏（0.20.0，0.23.0 起区分 read / write 状态）。
   *
   * - 作用域在范围内但 `write:false` → SCOPE_READ_ONLY，说明是「可写」开关关掉了；
   * - absolute 且作用域不在范围内 → SCOPE_NOT_WRITABLE，明确告诉 Agent 是绝对限制；
   * - normal 且作用域不在范围内 → VISIBILITY_APPROVAL_REQUIRED（工具层先审批）；
   * - none：不限制。
   */
          assertOperable(agent         , scope             )       {
    const decision = this.authorize(agent, { scope, action: 'write' })
    if (decision.allowed) return
    switch (decision.reason) {
      case 'SCOPE_ARCHIVED':
        throw memoryError('SCOPE_ARCHIVED', `作用域 ${scope} 所属的会话已归档：作用域与记忆被冻结，恢复会话后即可继续读写。`)
      case 'WRITE_DISABLED':
        throw memoryError('SCOPE_READ_ONLY', `作用域 ${scope} 在本会话记忆范围里被标记为「不可写」（可读/可写按钮），本次写入/删除没有执行。如需写入，请让用户打开该作用域的「可写」状态。`)
      case 'SCOPE_DISABLED':
        throw memoryError('SCOPE_DISABLED', `作用域 ${scope} 已被配置关闭，本次写入/删除没有执行。`)
      case 'ABSOLUTE_ISOLATION':
        throw memoryError('SCOPE_NOT_WRITABLE', `作用域 ${scope} 不在本会话可见范围内（限制等级：绝对限制），本次写入/删除没有执行。如需写入，请让用户调整「记忆范围」后重试。`)
      default:
        // normal 且作用域不在范围内：工具层会先审批，批准后带 visibilityApproved 再来。
        throw memoryError('VISIBILITY_APPROVAL_REQUIRED', `作用域 ${scope} 不在本会话的可操作范围内,需要用户审批`)
    }
  }

  async save(input                 )                        {
    // 省略 scope 时按当前会话落点 —— 会话上下文必须**从调用方带进来**
    // (工具 handler 拿得到 exec.agent,provider 自己看不到)。
    const saveAgent = (input                                         ).agent
    const requestedScope = input.scope ?? this.resolveWriteScope(saveAgent)
    const scope = this.canonicalScope(requestedScope)
    this.assertScopeAllowed(scope)
    // 写入护栏:可见范围 = 可操作范围。工具层在普通限制下会先审批,批准后带
    // `visibilityApproved` 再来;面板写入不带 agent,不受会话可见域约束(用户本人操作)。
    if (saveAgent !== undefined && (input                                    ).visibilityApproved !== true) {
      this.assertOperable(saveAgent, scope)
    }
    // 0.7.0:项目作用域可以带一个显示名(别名)。同一路径同名幂等,不同路径同名拒绝。
    const requestedName = (input                                        ).name
    if (requestedName !== undefined && requestedName !== null && String(requestedName).trim() !== '') {
      if (!scope.startsWith('project:')) {
        throw memoryError('SCOPE_NAME_UNSUPPORTED', '只有项目作用域支持重命名(需要 path 或 project:<路径>)')
      }
      this.names.claim(scope, String(requestedName))
    }
    // 自定义 scope 的**新建**受 scopes.custom.max 限制;写已存在的 scope 不受限。
    this.assertCustomScopeBudget(scope)
    let content = input.content?.trim()
    if (!content) throw memoryError('CONTENT_EMPTY', 'content must be a non-empty string')
    if (content.length > this.cfg.maxRecordChars) {
      throw memoryError('CONTENT_TOO_LONG', `content exceeds ${this.cfg.maxRecordChars} chars`)
    }
    if (input.supersedes && !this.store.scope(scope).records.get(input.supersedes)) {
      throw memoryError('SUPERSEDES_UNKNOWN', `supersedes target ${input.supersedes} not found in ${scope}`)
    }
    // 状态型记忆(state)默认带 TTL:写入时算一次绝对 expiresAt,读取时只比较时间。
    // 显式 expiresAt 优先;ttlMs 对任何 kind 都生效(便于测试/特殊用途)。
    const timing = input                                                              
    const explicitExpiresAt = typeof timing.expiresAt === 'number' && Number.isFinite(timing.expiresAt)
      ? timing.expiresAt
      : undefined
    const explicitTtl = typeof timing.ttlMs === 'number' && Number.isFinite(timing.ttlMs) && timing.ttlMs > 0
      ? timing.ttlMs
      : undefined
    const stateTtl = input.kind === 'state' ? this.injectSettings().state.ttlMs : undefined
    const expiresAt = explicitExpiresAt
      ?? (explicitTtl !== undefined ? Date.now() + explicitTtl
        : stateTtl !== undefined ? Date.now() + stateTtl : undefined)
    const saveInput = expiresAt !== undefined ? { ...input, expiredAt: expiresAt } : input
    // design §11: keep credentials out of the plaintext store and the embedder
    if (this.cfg.secrets.enabled) {
      const findings = scanSecrets(content)
      if (findings.length > 0) {
        if (this.cfg.secrets.mode === 'refuse') {
          throw memoryError('SECRET_DETECTED', `content matches credential denylist: ${[...new Set(findings.map((f) => f.kind))].join(', ')}`)
        }
        content = redactSecrets(content)
      }
    }
    // 0.24.0：自定义作用域的“创建”与“普通写入”分开判断。
    //   - Agent 新建自定义作用域必须带 scopeDescription（面板 / 导入等无 agent 路径不受限）；
    //   - 元数据存在但 status='pending'（上次初始化半途失败）时继续完成初始化；
    //   - 已有作用域带 scopeDescription = 更新用途，不写初始记忆。
    const initInput = input                                                                         
    const description = normalizeScopeDescription(initInput.scopeDescription)
    const ruleText = typeof initInput.scopeRule === 'string' ? initInput.scopeRule.trim() : ''
    const metaBefore = this.meta.get(scope)
    const newCustom = isCustomScope(scope) && this.store.peek(scope) === undefined && metaBefore === undefined
    const pendingInit = metaBefore?.status === 'pending'
    const effectiveDescription = description !== '' ? description : (metaBefore?.description ?? '')
    const agentWrite = saveAgent !== undefined
    if ((newCustom || pendingInit) && agentWrite && effectiveDescription === '') {
      throw memoryError(
        'SCOPE_DESCRIPTION_REQUIRED',
        `新建自定义作用域 ${scope} 必须提供 scopeDescription（一句话说明这个作用域用来做什么）。`,
      )
    }
    if (effectiveDescription.length > MAX_SCOPE_DESCRIPTION_CHARS) {
      throw memoryError('SCOPE_DESCRIPTION_TOO_LONG', `作用域用途最多 ${MAX_SCOPE_DESCRIPTION_CHARS} 字`)
    }
    if (ruleText !== '' && ruleText.length > this.cfg.maxRecordChars) {
      throw memoryError('SCOPE_RULE_TOO_LONG', `scopeRule 超过 ${this.cfg.maxRecordChars} 字`)
    }
    const createdBy = agentWrite ? (this.rawSessionIdOf(saveAgent) ?? 'agent') : 'user'
    const carryInitial = (input                                           ).initial === true
    const initialized = (newCustom || pendingInit) && effectiveDescription !== ''
    if (initialized) {
      // 先落 pending 元数据：进程在写记录途中退出时，下一次保存能识别并重试，
      // 目录工具也能看到“这个作用域正在初始化”。
      this.meta.put(scope, { description: effectiveDescription, createdBy, status: 'pending' })
    } else if (description !== '' && (metaBefore === undefined || description !== metaBefore.description)) {
      this.meta.put(scope, { description, createdBy: metaBefore?.createdBy ?? createdBy, status: 'ready' })
    }

    let record              
    let deduped = false
    try {
      const saved = this.store.save(
        {
          ...saveInput,
          scope,
          content,
          // 0.33.0：新记录初始化"记忆强度"（FSRS 式 stability/difficulty + 效用计数），
          // 排序与遗忘曲线都基于它；老记录缺省时由 stabilityOf() 兼容推导。
          // 注意：这里只合并**强度字段**，不能整份 ...saveInput —— 那会用未规范化的
          // scope/content 覆盖掉上面已经算好的规范值（回归：project: 路径写法分叉）。
          ...initialStrength(content, String(input.kind ?? 'fact')),
          ...explicitStrengthFields(saveInput),
          ...(initialized || carryInitial ? { initial: true } : {}),
        },
        { importance: input.source?.origin === 'auto' ? 0.4 : 0.8, source: { origin: 'explicit' } },
      )
      record = saved.record
      deduped = saved.deduped
      // 初始规则：只有初始化流程（新作用域 / 半途重试）才写；普通写入带 scopeRule 不生效。
      if (initialized && ruleText !== '') {
        const ruleSaved = this.store.save(
          { ...saveInput, scope, kind: 'rule', content: ruleText, tags: ['scope-init'], initial: true },
          { importance: 0.8, source: { origin: 'explicit' } },
        )
        void this.embedRecord(ruleSaved.record).catch(() => {})
      }
      if (initialized) {
        this.meta.put(scope, { description: effectiveDescription, createdBy: metaBefore?.createdBy ?? createdBy, status: 'ready' })
      }
      // 0.40.0：可疑写入隔离（P4 投毒防护）。用户显式写入的疑似注入只报风险不隔离；
      // auto/agent 来源的高风险内容直接隔离（不进检索/注入，等人工复核）。
      try {
        const guard = scanMemoryContent(content, { source: { origin: agentWrite ? 'agent' : 'user' } })
        if (guard.quarantined) {
          quarantineRecord(this.store, record.id, guard.reasons)
          this.store.scheduleFlush()
        }
      } catch { /* 防护失败不影响写入 */ }
    } catch (error) {
      // 保留 pending 元数据（而不是删掉）：下一次保存可以接着完成初始化，
      // 目录工具也能明确看到这个作用域尚未就绪。
      throw error
    }
    // 0.31.0：记录已落库，广播保存事件（旁路；只带元数据，不含正文）。
    this.events.saved({ scope, id: record.id, kind: record.kind, chars: record.content.length, deduped })
    void this.embedRecord(record).catch(() => {})
    this.store.scheduleFlush()
    return record
  }

          async embedRecord(record              )                {
    if (!this.cfg.vector.enabled || !this.cfg.vector.configured) return
    const s = this.store.scope(record.scope)
    const text = `${this.cfg.vector.documentPrefix ?? ''}${record.content}`
    // 0.32.0：先查文档向量缓存 —— 同内容重写 / 迁移 / 重新索引时不必再请求嵌入服务。
    const cached = this.embedCache?.getDocument(text) ?? null
    if (cached !== null) {
      s.appendVector(record.id, cached)
      this.syncAnnIndex(record.scope, record.id, cached)
      this.applyCognition(record, cached)
      return
    }
    // save-time budget: one full record, much slower than a search query
    // 记录按"文档"嵌入:有些模型(nomic/e5)要求文档与查询带不同前缀,不带质量会掉。
    const vec = await this.withDocEmbedSlot(() => this.embed.embed([text], undefined, { timeoutMs: this.cfg.vector.writeTimeoutMs })).catch(() => null)
    if (vec?.[0]) {
      const normalized = normalizeInPlace(vec[0])
      s.appendVector(record.id, normalized)
      this.syncAnnIndex(record.scope, record.id, normalized)
      this.embedCache?.putDocument(text, normalized)
      // 0.32.0：拿到向量后做一次语义整理（近重复合并 / 冲突打标）。
      // 放在嵌入之后是因为这一步要靠向量；失败不影响主流程。
      this.applyCognition(record, normalized)
    } else {
      s.embedPending.add(record.id) // backfill queue; the retry timer drains it
    }
  }

  /**
   * 0.32.0：写后语义整理。
   * - 余弦 ≥ mergeThreshold：视为同一条记忆的不同说法，新记录原地接管（supersedes 旧记录，
   *   tags 并集、importance 取大、generation+1），旧记录保留为已修正而不是删除；
   * - 余弦在 [conflictMinSimilarity, mergeThreshold)：只打冲突标记，绝不自动改内容。
   * 整个函数 best-effort：任何异常都吞掉，写记忆本身不能因为整理失败而失败。
   */
          applyCognition(record              , vec              , retried = false)       {
    try {
      const hits = this.store.findSimilar(vec, {
        scope: record.scope,
        minScore: this.cfg.cognitive.conflictMinSimilarity,
        excludeIds: [record.id],
        limit: 3,
      })
      if (hits.length === 0) {
        // 0.41.5：连写两条时嵌入几乎同时完成，先完成的记录可能还看不到对方的向量
        // → 冲突/合并漏判。延迟 300ms 重查一次（只重试一次，timer unref 不阻塞退出）。
        if (!retried && !isTombstonedRecord(record)) {
          const timer = setTimeout(() => this.applyCognition(record, vec, true), 300)
          if (typeof timer.unref === 'function') timer.unref()
        }
        return
      }
      // 相似度 ≥ 合并阈值 **且** 关键细节不冲突才合并。
      // 只看余弦会把「占用 10.4GB」和「占用 20GB」这种措辞几乎一样、事实却矛盾的
      // 两条合并掉（这种对的余弦往往比同义改写还高）。
      const similar = hits.find((hit) => hit.similarity >= this.cfg.cognitive.mergeThreshold)
      const mergeSafe = similar !== undefined && !hasCriticalDetailConflict(record.content, similar.record.content)
      if (this.cfg.cognitive.mergeEnabled && mergeSafe && similar !== undefined) {
        const plan = planNearDuplicateMerge(record, similar.record, similar.similarity, {
          threshold: this.cfg.cognitive.mergeThreshold,
        })
        if (plan?.record !== undefined) {
          this.store.scope(record.scope).insert(plan.record)
          this.store.scheduleFlush()
          return
        }
      }
      if (this.cfg.cognitive.conflictEnabled) {
        // 0.33.0：冲突只由"关键细节不一致"判定，且置信度要达到 medium。
        // 纯余弦落在 0.75~0.92 的往往是**同义改写**（措辞不同、事实相同），
        // 不该被打成冲突 —— 否则它们既进不了巩固、又会让用户误以为记忆互相矛盾。
        const detailConflict = hits.find((hit) => hasCriticalDetailConflict(record.content, hit.record.content))
        const assessment = detailConflict === undefined
          ? { conflicted: false, findings: [], marker: { conflictWith: [], conflictConfidence: 0 }, severity: 'none'          }
          : assessConflicts({ content: record.content, candidates: [detailConflict] })
        if (detailConflict !== undefined) {
          const contradiction = assessContradiction(record.content, detailConflict.record.content, {
            similarity: detailConflict.similarity,
          })
          // 0.41.4：**只有数值/路径真的变了才自动裁决**。
          // 标识符差异（npm vs pnpm、task-1 vs task-2、带/不带 Android）一律保留双方并打标，
          // 避免把"不同任务/不同详细程度"的记录误判成矛盾而失效。
          const decisive = contradiction.comparison.numericDiffs.length > 0
            || contradiction.comparison.pathsMissing.length > 0
            || contradiction.comparison.pathsExtra.length > 0
          if (decisive) {
            try {
              const decision = resolveConflict({
                newer: record,
                older: detailConflict.record,
                evidence: { similarity: detailConflict.similarity, contradiction: contradiction.confidence },
              })
              if (decision.action === 'invalidate-old' || decision.action === 'merge') {
                const applied = applyConflictResolution(this.store, decision)
                if (applied.applied) {
                  this.store.scheduleFlush()
                  return
                }
              }
            } catch { /* 自动裁决失败退回"只打标" */ }
          }
          applyConflictMarker(this.store, record.id, {
            conflicted: true,
            findings: [{ id: detailConflict.record.id, similarity: detailConflict.similarity }],
            marker: {
              conflictWith: [detailConflict.record.id],
              conflictConfidence: Math.max(detailConflict.similarity, contradiction.confidence),
            },
            severity: contradiction.level,
          })
          this.store.scheduleFlush()
        }
      }
    } catch {
      // 整理失败不影响记忆本身
    }
  }

  /**
   * Retry pending embeddings in batches; returns number embedded.
   * Batches are bounded by count AND total characters, and use the backfill
   * budget: full record contents on CPU take seconds per batch, so the
   * interactive timeout would abort every attempt.
   */
  async backfillEmbeddings()                  {
    if (!this.cfg.vector.enabled || !this.cfg.vector.configured) return 0
    if (!this.embed.isHealthy) return 0
    let done = 0
    for (const s of this.store.allScopes()) {
      if (s.embedPending.size === 0) continue
      const texts           = []
      const valid           = []
      let chars = 0
      for (const id of s.embedPending) {
        if (valid.length >= this.cfg.vector.backfillBatchSize) break
        const t = s.records.get(id)?.content
        if (!t) continue
        if (valid.length > 0 && chars + t.length > this.cfg.vector.backfillMaxChars) break
        texts.push(`${this.cfg.vector.documentPrefix ?? ''}${t}`)
        valid.push(id)
        chars += t.length
      }
      if (texts.length === 0) continue
      // 0.32.0：优先用批量接口（部分成功语义）。旧实现只要有一条失败就整批作废、
      // 而且无论成功与否都 del pending —— 超长记录会永远重试，正常记录也白跑。
      const vecs                                    = await this.withDocEmbedSlot(() => (
        this.embed.embedBatch !== undefined
          ? this.embed.embedBatch(texts, undefined, { timeoutMs: this.cfg.vector.backfillTimeoutMs })
          : this.embed.embed(texts, undefined, { timeoutMs: this.cfg.vector.backfillTimeoutMs })
      )).catch(() => null)
      if (vecs === null) return done // 外层 null = 后端整体不可用，整轮到此为止
      for (let i = 0; i < valid.length; i++) {
        const vector = vecs[i]
        if (s.records.has(valid[i] ) && vector) {
          const normalized = normalizeInPlace(vector)
          s.appendVector(valid[i] , normalized)
          this.syncAnnIndex(s.scope, valid[i] , normalized)
          this.embedCache?.putDocument(texts[i] , normalized)
          s.embedPending.delete(valid[i] )
          done++
        }
        // 失败的条目保留在 pending 里等下一轮（不再无条件删除）
      }
    }
    return done
  }

  /**
   * 编辑之后立即重建**这一条**的向量，不等 60s 的回填窗口。
   * 旧向量同时从内存与磁盘作废（vectorsDirty），失败则留在 pending 里由重试兜底 ——
   * 绝不能让"新内容 + 旧向量"在重启后被当成已嵌入。
   */
  async reindexRecord(scope             , id        )                   {
    if (!this.cfg.vector.enabled || !this.cfg.vector.configured) return false
    const s = this.store.peek(scope)
    const record = s?.records.get(id)
    if (!s || !record) return false
    s.vectors.delete(id)
    s.vectorsDirty = true
    s.embedPending.add(id)
    try {
      await this.embedRecord(record)
    } catch { /* 失败留给重试定时器 */ }
    if (!s.vectors.has(id)) return false
    s.embedPending.delete(id)
    this.store.scheduleFlush()
    return true
  }

  /**
   * 作废全部向量并按当前模型重新嵌入。给"换模型残留了旧向量 / 怀疑向量有问题"用:
   * 同步部分只清空 + 排队,真正的重嵌在后台跑(别让 HTTP 等几分钟)。
   * 返回排队条数;进度由面板的「待嵌入」计数与自动刷新体现。
   */
  reindexAll()                                    {
    if (!this.cfg.vector.enabled || !this.cfg.vector.configured) return { total: 0, queued: this.pendingEmbedCount }
    this.discoverScopes()
    let total = 0
    for (const s of this.store.allScopes()) {
      for (const id of s.records.keys()) {
        s.vectors.delete(id)
        s.embedPending.add(id)
        total += 1
      }
      s.vectorsDirty = true
    }
    this.store.scheduleFlush()
    void this.backfillAll({ throttleMs: 50 }).catch(() => { /* 失败留给 60s 重试 */ })
    return { total, queued: this.pendingEmbedCount }
  }

  /**
   * First-fill: embed the ENTIRE backlog (unlike backfillEmbeddings' single
   * batch per scope), in throttled batches so a big import does not hammer
   * llama-server or block the caller. Yields to the event loop between
   * batches and stops early on abort/unhealthy embedder.
   */
  async backfillAll(opts                                                = {})                  {
    const throttle = opts.throttleMs ?? 50
    let done = 0
    while (!opts.signal?.aborted) {
      const n = await this.backfillEmbeddings()
      done += n
      if (n === 0) break // per-scope batch was empty → backlog drained
      if (!this.embed.isHealthy) break
      await new Promise((r) => setTimeout(r, throttle))
    }
    return done
  }

  async search(query             )                       {
    // 多 scope 合并由调用方显式给出(工具层传"会话 + 项目 + global");宿主类型里的
    // MemoryQuery 只有单值 scope,所以这里按结构化读一次可选数组,保持原语义不变。
    const queryScopes = (query                                            ).scopes
    // 显式空集合 = 什么都不允许读(会话可见范围把所有勾选项都禁用了)。不能退回
    // 默认项目 + global,否则"看不见任何范围"反而会搜出默认范围的记录。
    if (query.scope === undefined && queryScopes !== undefined && queryScopes.length === 0) return []
    const topK = query.topK ?? this.cfg.topK
    const recallN = query.recallN ?? this.cfg.recallN
    const now = Date.now()
    const queryTokens = [...new Set(tokenize(query.text))]
    // 面板的语义检索复用这条流水线,但它是"看一眼"的浏览:不写访问计数,也不在
    // 没有任何向量时白跑一次嵌入请求。这两个开关只给面板的 searchForPanel 用,
    // 工具 / 注入调用不会传。
    const internal = query                                                                                                                                                                                                                
    // 0.62.8：整条查询**没有任何内容词**（「怎么办」「为什么」这类）时，语义通道也不参与。
    // 依据：BGE-M3 对「短泛化中文查询 × 长中文记忆」的基线余弦本身就有 0.50–0.53，
    // minScore=0.5 会被这类查询直接捅穿 —— 实测「怎么办」命中 3 条无关记忆
    // （content-only 余弦 0.512/0.529/0.502）。没有实义的查询不存在可匹配的语义目标。
    // 0.62.9：只有"纯功能词中文查询"才短路语义通道。分词为空的语种（韩/泰/阿/俄…）
    // 不能判成无实义 —— 0.62.8 曾因此把它们整类查询的语义通道关掉。
    const queryIsGenericOnly = isGenericOnlyQuery(queryTokens)
    const allowVector = !queryIsGenericOnly && internal.vector !== false && this.cfg.vector.enabled && this.cfg.vector.configured
    const includeSuperseded = internal.includeSuperseded === true
    const includeExpired = internal.includeExpired === true
    // 0.32.0：休眠/墓碑记录默认不参与召回（面板历史浏览显式打开时才显示）。
    const includeDormant = internal.includeDormant === true
    const includeTombstoned = internal.includeTombstoned === true
    // 面板/历史浏览不做结果整形（不去噪/不合并/不做 MMR）：用户要看到全部命中。
    // includeExpired 通常意味着"查历史版本"，这时同义去重会把新旧版本合并掉，必须跳过。
    const shapingEnabled = internal.shaping !== false && !includeExpired
    // 注入侧按可见域的类型白名单检索(scope → 允许的类型;未列出的 scope 不限制)。
    // 工具侧不传 kinds:它需要看到范围外命中,才能发起审批。
    const kindFilter = internal.kinds === undefined
      ? undefined
      : (scope        , kind        )          => {
          const allowed = internal.kinds [this.canonicalScope(scope)]
          return allowed === undefined || allowed.length === 0 || allowed.includes(kind)
        }

    // 候选 scope:显式 pin(单值)优先;否则用调用方给的合并集合(query.scopes,
    // 工具 / 注入传"会话 + 项目 + global");两者都没有才退回旧的 project + global。
    // `peek` 而不是 `scope`:读路径不创建,不存在的 scope 直接跳过。
    const wanted                = (query.scope
      ? [query.scope]
      : (queryScopes ?? []).length > 0
        ? queryScopes 
        : [this.defaultProjectScope, 'global']).map((scope) => this.canonicalScope(scope))
    const stores                                                                 = []
    const seen = new Set             ()
    const archivedScopes = this.archivedSessionScopes()
    for (const scope of wanted) {
      if (seen.has(scope)) continue // 按 scope key 去重(也顺手消掉 defaultScope==='global' 时的重复 push)
      seen.add(scope)
      // 0.30.0：归档会话作用域在归档期间**完全不参与检索** —— 连词法/向量候选都不进，
      // 这样恢复会话后不需要重建任何索引，记忆原样回来。
      if (archivedScopes.has(scope)) continue
      const store = this.store.peek(scope)
      if (!store) continue
      stores.push({ store, scope, isGlobal: scope === 'global' })
    }

    // 退役(superseded)记录默认不参与召回:它们只是被新记录修正过的历史版本,
    // 继续返回会让模型拿旧结论当现行事实。memory_get(id)/面板历史仍可直接取。
    const retired = new Set        ()
    for (const { store } of stores) {
      for (const record of store.records.values()) {
        if (record.supersedes) retired.add(record.supersedes)
      }
    }

    // --- channel 1: lexical recall, scored per scope with local IDF ---
                                                                                                                                                                         
    const candidates = new Map              ()
    for (const { store, isGlobal } of stores) {
      const all = [...store.records.values()]
      // 词法通道把标签也当可检索文本:自动召回用标签做触发词时,记忆正文里
      // 不一定出现这个标签(例如 tags=['release'] 但正文是中文),不并进来就搜不到。
      const searchableText = (record              )         =>
        `${record.content} ${(record.tags ?? []).join(' ')}`
      const tokenSets = all.map((r) => new Set(tokenize(searchableText(r))))
      const stats = buildStats(tokenSets)
      for (let i = 0; i < all.length; i++) {
        const rec = all[i] 
        if (!includeExpired && rec.expiredAt && rec.expiredAt < now) continue
        if (!includeSuperseded && retired.has(rec.id)) continue
        // 0.32.0：休眠/墓碑记录不进召回（forget 变软删后，靠这里立即不可见）。
        // 0.34.0：统一可见性（休眠/软删/过期/失效），面板历史浏览时 include 全开。
        if (!isRecordVisible(rec, { includeDormant, includeTombstoned, includeExpired, now })) continue
        if (kindFilter !== undefined && !kindFilter(rec.scope, rec.kind)) continue
        const lex = lexicalScore(queryTokens, tokenSets[i] , stats)
        if (lex <= 0) continue
        // Weak-only overlap (no shared word/bigram) must clear the "real hit"
        // floor, not the permissive threshold — kills single-char collisions.
        // 0.32.0：阈值改成按查询长度自适应（短查询放宽、长查询收紧），
        // 且词法分先做跨 scope 校准，这样 global 与 project 的分数可以同槽排序。
        const floor = adaptiveScopeThreshold(query.text, rec.scope, {
          globalThreshold: this.cfg.globalThreshold,
          projectThreshold: this.cfg.projectThreshold,
        })
        // 0.62.7：功能词重叠不算相关性证据（见 hasContentHit 注释）——只由「怎么/什么/
        // 多少」这类功能词构成的词面重叠**直接拒绝**，不靠抬高门槛（实测 0.357 仍会过线）。
        // 语义相关交给向量通道，词法通道只认实义词。
        if (!hasContentHit(queryTokens, tokenSets[i] )) continue
        const effective = floor
        if (lex < effective) continue
        const calibrated = calibrateScore(lex, rec.scope)
        candidates.set(rec.id, { record: rec, recallScore: calibrated, lexScore: calibrated, isGlobal, vector: store.vectors.get(rec.id) ?? null })
      }
    }

    // --- channel 2: vector recall over embedded records ---
    // Skipped entirely when no backend is configured (lexical recall above
    // already produced the candidates; a request here would just fail).
    // 0.40.1：本地服务冷启动（模型还在加载）时**不**发查询嵌入 —— 300ms 预算必然超时，
    // 只会刷一屏"嵌入请求超时"并白等。本轮先走词法，模型就绪后自动恢复语义召回。
    // 只对**本地托管**的服务做冷启动跳闸：外部 endpoint（openai/ollama/自建服务）没有
    // 模型加载阶段，不能套用这个判断，否则会一直跳过语义召回。
    // 冷启动窗口必须有截止时间：llama-server 在低配机上可能 60s 内没 ready，
    // 而 ensureEmbedServer 的超时只记一句日志、不会把 unavailable 置真 —— 若只看
    // 「!ready && !unavailable」，整个进程生命周期都会跳过查询嵌入，语义召回静默
    // 失效（手机冷加载 >60s 完全可能）。超过 WARMING_MAX_MS 就恢复尝试。
    const warmElapsed = this.embedServerWarmSince === null ? 0 : Date.now() - this.embedServerWarmSince
    const vectorWarming = this.cfg.vector.enabled && this.cfg.vector.configured && this.cfg.vector.spawnConfigured
      && this.embedServer !== null && !this.embedServerReady && !this.embedServer.unavailable
      && warmElapsed < WARMING_MAX_MS
    if (vectorWarming && !this.warmSkipLogged) {
      this.warmSkipLogged = true
      console.warn('[dsh-memory-local] 嵌入模型加载中：本轮语义召回先跳过，就绪后自动恢复（避免启动期超时刷屏）')
    }
    const queryText = `${this.cfg.vector.queryPrefix ?? ''}${query.text}`
    const cachedQuery = allowVector && !vectorWarming ? (this.embedCache?.getQuery(queryText) ?? null) : null
    let qvec                        = cachedQuery !== null ? [cachedQuery] : null
    const embedQuerySerially = async (timeoutMs        )                                 => {
      // 串行链：前一次查询嵌入结束后再发下一个，避免并发占满 llama-server 的 slot。
      const next = this.queryEmbedChain.then(() => this.embed.embed([queryText], query.signal, { timeoutMs }).catch(() => null))
      this.queryEmbedChain = next.then(() => undefined, () => undefined)
      return next
    }
    if (allowVector && !vectorWarming && qvec === null) {
      qvec = await embedQuerySerially(this.queryTimeoutMs)
    }
    // 慢设备自适应：首查超时就用更大预算重试一次，成功后把预算钉到实测的 3 倍。
    // 不做这一步的话，ARM 手机上 300ms 预算意味着语义召回永远不生效。
    if (allowVector && !vectorWarming && qvec === null) {
      const bumped = Math.min(8_000, Math.max(1_500, this.queryTimeoutMs * 4))
      if (bumped > this.queryTimeoutMs) {
        const startedAt = Date.now()
        this.queryTimeoutMs = bumped
        // 熔断器在超时后会把后端标记为不健康并退避，这里是我们主动的重试，
        // 直接放开一次，否则 embed() 会跳过网络直接返回 null。
        this.embed.markUp()
        qvec = await embedQuerySerially(bumped)
        if (qvec !== null) {
          this.queryTimeoutMs = Math.min(8_000, Math.max(bumped, (Date.now() - startedAt) * 3))
        }
      }
    }
    if (qvec?.[0] !== undefined && cachedQuery === null) this.embedCache?.putQuery(queryText, qvec[0])
    if (qvec?.[0]) {
      const vectorScores = new Map                ()
      let needAnnRefresh = false
      for (const { store } of stores) {
        // 0.33.0：索引就绪且条数一致才走 ANN（未就绪/已过期一律回退全量扫描，
        // 正确性不依赖索引；建图交给维护定时器，不在查询路径上做）。
        const ann = this.cfg.vector.ann.enabled ? this.annIndexes.get(store.scope) : undefined
        if (ann !== undefined && ann.size === store.vectors.size) {
          const hits = ann.index.search(qvec[0] , Math.max(recallN * 2, topK), {
            threshold: this.cfg.vector.minScore,
            ...(this.cfg.vector.ann.efSearch !== undefined ? { efSearch: this.cfg.vector.ann.efSearch } : {}),
          })
          for (const hit of hits) {
            if (!store.records.has(hit.id)) continue
            vectorScores.set(hit.id, hit.score)
          }
          continue
        }
        if (this.cfg.vector.ann.enabled) needAnnRefresh = true
        for (const [id, vec] of store.vectors) {
          if (!store.records.has(id)) continue
          const sim = cosine(qvec[0] , vec)
          if (sim >= this.cfg.vector.minScore) vectorScores.set(id, sim)
        }
      }
      if (needAnnRefresh) void this.maintainAnnIndexes()
      for (const [id, sim] of vectorScores) {
        if (!includeSuperseded && retired.has(id)) continue
        const existing = candidates.get(id)
        if (existing) {
          existing.vecScore = Math.max(existing.vecScore ?? 0, sim)
          continue
        }
        const rec = this.findById(id)
        if (!rec) continue
        if (!includeExpired && rec.expiredAt !== undefined && rec.expiredAt < now) continue
        if (!isRecordVisible(rec, { includeDormant, includeTombstoned, includeExpired, now })) continue
        if (kindFilter !== undefined && !kindFilter(rec.scope, rec.kind)) continue
        if (!(rec.scope === 'global' && sim < this.cfg.globalThreshold)) {
          const store = stores.find((s) => s.scope === rec.scope)?.store
          candidates.set(id, { record: rec, recallScore: sim, vecScore: sim, isGlobal: rec.scope === 'global', vector: store?.vectors.get(id) ?? null })
        }
      }
    }

    // 0.33.0：Rocchio 伪相关反馈（默认关）。用首轮向量的 top 文档质心扩展查询，
    // 再扫一遍取 max —— 对"换个说法就搜不到"的查询有实测收益，但要按库调 beta。
    if (this.cfg.expansion.enabled && qvec?.[0] !== undefined && candidates.size > 0) {
      const topDocs = [...candidates.values()]
        .filter((c) => c.vector !== null && c.vector !== undefined)
        .sort((a, b) => (b.vecScore ?? 0) - (a.vecScore ?? 0))
        .slice(0, 5)
        .map((c) => c.vector )
      const expanded = expandQuery(qvec[0], topDocs, { alpha: 1, beta: this.cfg.expansion.beta })
      if (expanded !== null) {
        for (const { store } of stores) {
          for (const [id, vec] of store.vectors) {
            if (!store.records.has(id)) continue
            const record = store.records.get(id) 
            if (!isRecordVisible(record, { includeDormant, includeTombstoned, includeExpired, now })) continue
            const sim = cosine(expanded, vec)
            if (sim < this.cfg.vector.minScore) continue
            const existing = candidates.get(id)
            if (existing) existing.vecScore = Math.max(existing.vecScore ?? 0, sim)
            else candidates.set(id, { record, recallScore: sim, vecScore: sim, isGlobal: record.scope === 'global', vector: vec })
          }
        }
      }
    }

    // 0.33.0：双通道融合 —— 按查询特征动态调词法/向量权重（代码/数字查询偏词法，
    // 自然语言偏向量），比原来 max() 取大更贴近信号强度。
    const hybrid = hybridWeights(queryProfile(query.text))
    for (const cand of candidates.values()) {
      const lex = cand.lexScore
      const vec = cand.vecScore
      if (lex !== undefined && vec !== undefined) cand.recallScore = blendHybrid(lex, vec, hybrid)
      else if (lex !== undefined) cand.recallScore = lex
      else if (vec !== undefined) cand.recallScore = vec
    }

    // 0.40.0（P0）：BM25 + RRF 融合。RRF 只产出 max +20% 的排序加成，不覆盖相关度。
    const fusionBonus = new Map                ()

    // 0.40.0（P0）：BM25 + RRF 融合。
    // 设计取舍：旧路径（lexicalScore + 自适应阈值）继续做**准入门槛**，BM25 与 RRF 只负责
    // 「补召回 + 排序」—— 阈值/地板分的分数域保持不变，融合不会把老库行为整体推翻。
    if (this.cfg.bm25.enabled || this.cfg.fusion.enabled) {
      const perScope                                                                                                                                 = []
      for (const { store, scope } of stores) {
        const visible = [...store.records.values()].filter((rec) => {
          if (!includeSuperseded && retired.has(rec.id)) return false
          if (!isRecordVisible(rec, { includeDormant, includeTombstoned, includeExpired, now })) return false
          if (kindFilter !== undefined && !kindFilter(rec.scope, rec.kind)) return false
          return true
        })
        if (visible.length === 0) continue
        const index = buildBm25Docs(
          visible.map((rec) => ({ id: rec.id, content: rec.content, tags: rec.tags ?? [] })),
          { k1: this.cfg.bm25.k1, b: this.cfg.bm25.b, tagsWeight: this.cfg.bm25.tagsWeight },
        )
        perScope.push({ scope, store, index, docsById: new Map(visible.map((r) => [r.id, r])) })
      }
      const byLexical = [...candidates.values()]
        .filter((c) => c.lexScore !== undefined)
        .sort((a, b) => (b.lexScore ?? 0) - (a.lexScore ?? 0) || a.record.id.localeCompare(b.record.id))
        .map((c) => c.record.id)
      const byVector = [...candidates.values()]
        .filter((c) => c.vecScore !== undefined)
        .sort((a, b) => (b.vecScore ?? 0) - (a.vecScore ?? 0) || a.record.id.localeCompare(b.record.id))
        .map((c) => c.record.id)
      const bm25Ids           = []
      if (this.cfg.bm25.enabled) {
        for (const part of perScope) {
          for (const hit of rankByBm25(queryTokens, part.index, recallN * 2)) bm25Ids.push(hit.id)
        }
      }
      // 变体扩展（默认关）：只跑词法 BM25，不再为每个变体发嵌入请求（手机上不可行）。
      let expandedIds           = []
      if (this.cfg.variants.enabled && perScope.length > 0) {
        const neighbors = [...candidates.values()]
          .sort((a, b) => b.recallScore - a.recallScore)
          .slice(0, this.cfg.variants.maxNeighbors)
          .map((c) => ({ content: c.record.content, tags: c.record.tags ?? [] }))
        const variants = expandQueries(query.text, { neighbors, maxVariants: this.cfg.variants.maxVariants })
        const seen = new Set        ()
        for (const variant of variants) {
          if (variant.kind === 'original') continue
          for (const part of perScope) {
            const scored = [...part.index.docs.values()]
              .map((doc) => ({ id: doc.id, score: bm25Score(variant.tokens, doc, part.index) }))
              .filter((hit) => hit.score > 0)
              .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
              .slice(0, recallN * 2)
            for (const hit of scored) seen.add(hit.id)
          }
        }
        expandedIds = [...seen]
      }
      const ensureCandidate = (id        )          => {
        if (candidates.has(id)) return true
        for (const part of perScope) {
          const rec = part.docsById.get(id)
          if (rec === undefined) continue
          // 只靠 BM25/变体补回来的记录：**给低相关度**（不能和词法/向量真命中平起平坐，
          // 实测固定 0.5 会在 strengthRanking 关闭时压过真命中，recall 掉 0.04）。
          candidates.set(id, { record: rec, recallScore: 0.2, isGlobal: rec.scope === 'global', vector: part.store.vectors.get(id) ?? null, synthetic: true })
          return true
        }
        return false
      }
      if (this.cfg.fusion.addCandidates) for (const id of [...bm25Ids, ...expandedIds]) ensureCandidate(id)

      if (this.cfg.fusion.enabled && candidates.size > 0 && perScope.length > 0) {
        const lexicalList = this.cfg.bm25.enabled && bm25Ids.length > 0 ? bm25Ids : byLexical
        const lists = [
          { name: 'lexical', ids: lexicalList, weight: this.cfg.fusion.weights.lexical },
          { name: 'vector', ids: byVector, weight: this.cfg.fusion.weights.vector },
          ...(expandedIds.length > 0 ? [{ name: 'expanded', ids: expandedIds, weight: this.cfg.fusion.weights.expanded }] : []),
        ].filter((list) => list.ids.length > 0)
        if (lists.length > 0) {
          const fused = reciprocalRankFusion(lists, { k: this.cfg.fusion.k, limit: Math.max(recallN * 3, candidates.size) })
          const normalized = normalizeScores(fused.map((hit) => hit.score))
          for (let i = 0; i < fused.length; i++) {
            const id = fused[i] .id
            if (!candidates.has(id)) continue
            // 关键：RRF **不覆盖**原相关度（那会让"重要度/效用/保持度"失效，
            // 实测会把同相关度的两条按 id 排序）。它只作为一个加成信号，
            // 在 shape() 里以 (1 + 0.2·bonus) 的形式参与最终排序。
            const bonus = Math.max(0, Math.min(1, normalized[i] ?? 0))
            fusionBonus.set(id, bonus)
            // BM25-only 候选：只允许拿到 0.2~0.6 的相关度（低于词法/向量的真命中），
            // 既能让它参与排序，又不会把真命中挤下去。
            const cand = candidates.get(id)
            if (cand !== undefined && cand.synthetic === true) cand.recallScore = Math.min(cand.recallScore, 0.2 + 0.4 * bonus)
          }
        }
      }
    }

    // 0.62.3：保底召回 —— 只在**两路都零命中**时触发一次，正常路径分毫不动。
    //
    // 实测依据（中文记忆库，bge-m3）：'手机还剩多少存储空间' 与目标记忆的余弦是
    // 0.4995（门槛 0.5，差 0.0005 被砍）；'磁盘剩余空间' 是 0.4830。同两条的词法
    // 覆盖率又被长查询的 IDF 分母稀释到自适应 floor 以下 —— 两路同时失手，整条
    // 漏召回，用户看到「没有找到相关记忆」。这比给一条弱命中更糟：模型会因此
    // 重新踩同一个坑（记忆系统存在的意义就是避免这个）。
    //
    // 设计约束：① 只在 0 结果时触发，有命中就不放宽；② 放宽后仍有安全地板
    // max(noiseFloor, minScore − relax)，纯噪声（BGE CLS 实测地板 ~0.42）进不来。
    // 保底命中的分数天然低于准入门槛，若再被结果整形的「地板分」二次砍掉，
    // 保底就形同虚设 —— 记下 id，在整形阶段显式豁免（见 shaping 那段）。
    const fallbackIdSet = new Set        ()
    if (candidates.size === 0 && this.cfg.vector.recallFallback.enabled) {
      const fallback = this.cfg.vector.recallFallback
      const rescueFloor = Math.max(fallback.noiseFloor, this.cfg.vector.minScore - fallback.relax)
      let best                                                     
      if (allowVector && qvec?.[0] !== undefined) {
        for (const { store } of stores) {
          for (const [id, vec] of store.vectors) {
            const rec = store.records.get(id)
            if (rec === undefined) continue
            if (!includeSuperseded && retired.has(rec.id)) continue
            if (!isRecordVisible(rec, { includeDormant, includeTombstoned, includeExpired, now })) continue
            if (kindFilter !== undefined && !kindFilter(rec.scope, rec.kind)) continue
            const sim = cosine(qvec[0] , vec)
            if (sim < rescueFloor) continue
            if (best === undefined || sim > best.score) best = { record: rec, score: sim }
          }
        }
        if (best !== undefined) {
          const store = stores.find((entry) => entry.scope === best .record.scope)?.store
          candidates.set(best.record.id, {
            record: best.record,
            recallScore: best.score,
            vecScore: best.score,
            isGlobal: best.record.scope === 'global',
            vector: store?.vectors.get(best.record.id) ?? null,
          })
          fallbackIdSet.add(best.record.id)
        }
      }
      // 纯词法库（没有向量后端）同样需要保底：覆盖率被长查询稀释 ≠ 没有词面重叠，
      // hasStrongHit 是那道语义保险（要求至少共享一个 ≥2 字的 token）。
      if (candidates.size === 0) {
        let bestLex = 0
        let bestRec                          
        for (const { store } of stores) {
          const all = [...store.records.values()]
          const tokenSets = all.map((r) => new Set(tokenize(`${r.content} ${(r.tags ?? []).join(' ')}`)))
          const stats = buildStats(tokenSets)
          for (let i = 0; i < all.length; i++) {
            const rec = all[i] 
            if (!includeSuperseded && retired.has(rec.id)) continue
            if (!isRecordVisible(rec, { includeDormant, includeTombstoned, includeExpired, now })) continue
            if (kindFilter !== undefined && !kindFilter(rec.scope, rec.kind)) continue
            if (!hasContentHit(queryTokens, tokenSets[i] )) continue
            const lex = lexicalScore(queryTokens, tokenSets[i] , stats)
            if (lex > bestLex) {
              bestLex = lex
              bestRec = rec
            }
          }
        }
        if (bestRec !== undefined) {
          const store = stores.find((entry) => entry.scope === bestRec .scope)?.store
          candidates.set(bestRec.id, {
            record: bestRec,
            recallScore: bestLex,
            isGlobal: bestRec.scope === 'global',
            vector: store?.vectors.get(bestRec.id) ?? null,
          })
          fallbackIdSet.add(bestRec.id)
        }
      }
    }

    // shape with recency/importance, sort, cut
    // 0.33.0：默认用"可解释强度排序"（相关度 × 保持度 × 效用提升 × 重要度），
    // 并提供 breakdown；老库没有 strength 字段时由 stabilityOf() 兼容推导，零迁移。
    // strengthRanking=false 可回退到 0.32 的 recordScore（A/B 对比用）。
    const strengthOf = (c      )         => {
      const rec = c.record                    
                                                                                                         
       
      return explainCandidate({
        id: rec.id,
        relevance: Math.min(1, Math.max(0, c.recallScore)),
        importance: rec.importance,
        content: rec.content,
        kind: rec.kind,
        accessCount: rec.accessCount,
        createdAt: rec.createdAt,
        ...(rec.stability !== undefined ? { stability: rec.stability } : {}),
        ...(rec.difficulty !== undefined ? { difficulty: rec.difficulty } : {}),
        ...(rec.utility !== undefined ? { utility: rec.utility } : {}),
        ...(rec.useCount !== undefined ? { useCount: rec.useCount } : {}),
        ...(rec.lastUsedAt !== undefined ? { lastUsedAt: rec.lastUsedAt } : {}),
        superseded: retired.has(rec.id),
      }, { now, halfLifeDays: this.cfg.halfLifeDays }).score
    }
    const shape = (c      )         => {
      const base = this.cfg.strengthRanking
        ? strengthOf(c)
        : recordScore(c.recallScore, c.record.importance, c.record.accessCount, c.record.lastAccessedAt, {
            now,
            halfLifeDays: this.cfg.halfLifeDays,
            superseded: retired.has(c.record.id),
          })
      // 事实时间权重：新近更新/临近失效的光谱（已失效为 0，但检索侧已过滤）。
      const temporal = includeExpired || !this.cfg.temporalWeighting ? 1 : temporalBoost(c.record, now)
      // 0.40.0：RRF 融合加成（最多 +20%），只影响排序、不影响相关度语义。
      const fusion = 1 + 0.1 * (fusionBonus.get(c.record.id) ?? 0)
      return base * temporal * fusion
    }

    // 稳定 tie-break:同分时 session > project > 自定义 > global,再同分按 record id ——
    // 否则 Map 的插入顺序(取决于 scope 顺序)会让同一查询在不同进程间给出不同结果。
    const ranked = [...candidates.values()]
      .sort((a, b) => shape(b) - shape(a)
        || scopeTier(a.record.scope) - scopeTier(b.record.scope)
        || a.record.id.localeCompare(b.record.id))
      .slice(0, recallN)

    // 0.32.0：结果整形 —— 地板分 → 同义去重 → MMR 多样性。
    // 之前直接拿召回排序截断，实测「5 条里 3 条弱相关噪声」，同义记忆还会同时占位；
    // 现在先按终态分砍噪声，再合并同义条目，最后用 MMR 选一组既相关又不重复的结果。
                                                          
    // 注意：整形函数（finalFloor/semanticDedupe/mmrSelect）按 **item.id** 去重，
    // 候选里没有 id 字段时它们会把所有条目当成同一个 `undefined` 合并掉。
    let shaped               = ranked.map((c) => ({ ...c, id: c.record.id, score: shape(c) }))
    const mergedIds           = []
    if (shapingEnabled) {
      // 地板分作用在**匹配强度**(recallScore: 词法校准分/余弦)上，而不是衰减后的
      // 终态分 —— 否则一条很相关但很久没被访问的记忆会被 recency 压到线下误杀。
      if (this.cfg.shaping.floor > 0) shaped = shaped.filter((c) => c.recallScore >= this.cfg.shaping.floor || fallbackIdSet.has(c.id))
      if (this.cfg.shaping.dedupeThreshold > 0 && shaped.length > 1) {
        const dedupe = semanticDedupe(shaped, this.cfg.shaping.dedupeThreshold)
        shaped = dedupe.hits
        mergedIds.push(...dedupe.merged)
      }
      // 有 LLM 重排时给两倍余量，让重排有得选；没有就按 topK 直接收敛。
      const pickN = this.cfg.llm.enabled
        ? Math.min(shaped.length, Math.max(topK * 2, topK))
        : Math.min(shaped.length, topK)
      shaped = this.cfg.shaping.mmr && shaped.length > 1
        ? mmrSelect(shaped, this.cfg.shaping.mmrLambda, pickN)
        : shaped.slice(0, pickN)
    }

    // --- channel 3: LLM rerank (optional; any skip/failure keeps recall order) ---
    // 键必须是 **record.id**。这里曾经写成 `c.id`(Cand 上没有 id 字段),所有候选都落到
    // 同一个 `undefined` 键上:排序数组本身是对的,但每条命中拿到的都是最后一个候选的
    // 分数(面板上表现为「每条相关度都一样」),重排的候选 id 也全成了 undefined。
    const finalScores = new Map                (shaped.map((c) => [c.record.id, c.score]))
    if (this.cfg.llm.enabled && this.llmInvoke && shaped.length >= 2) {
      const asCands = shaped.map((c) => ({ id: c.record.id, content: c.record.content, recallScore: finalScores.get(c.record.id)  }))
      const cacheKey = RerankCache.key(query.text, shaped.map((c) => c.record.id), this.cfg.llm.model)
      let outcome = this.rerankCache.get(cacheKey)
      if (!outcome) {
        outcome = await rerank({
          invoke: this.llmInvoke,
          cfg: this.cfg.llm,
          query: query.text,
          candidates: asCands,
          budget: this.rerankBudget,
          signal: query.signal,
        })
        if (outcome) this.rerankCache.set(cacheKey, outcome)
      }
      if (outcome) {
        for (const { id, score } of blendScores(asCands, outcome, this.cfg.llm.weight)) {
          finalScores.set(id, score)
        }
      }
      // 重排必须能改变顺序,否则它只改了显示分数、召回序列原样输出。没有重排时
      // finalScores 就等于 shape(),这个二次排序与原顺序完全一致(同一套 tie-break)。
      shaped.sort((a, b) => finalScores.get(b.record.id)  - finalScores.get(a.record.id) 
        || scopeTier(a.record.scope) - scopeTier(b.record.scope)
        || a.record.id.localeCompare(b.record.id))
    }

    const hits              = shaped.map((c) => ({
      record: internal.touch === false ? c.record : touch(c.record),
      score: round4(finalScores.get(c.record.id) ?? c.score),
    }))
    // 0.32.0：命中即唤醒休眠记忆（与 save 清 dormantAt 同口径），否则休眠记录
    // 永远只能靠写回唤醒。唤醒只发生在真正被访问时，面板浏览不会触发。
    if (internal.touch !== false) {
      for (const hit of hits) if (isDormantRecord(hit.record)) revive(this.store, hit.record.id)
    }
    // 访问统计要落盘：recency / accessBoost 是排序输入，只在内存里加一等于没算。
    if (internal.touch !== false) for (const hit of hits) this.store.touch(hit.record)

    // 0.31.0：广播召回摘要（query / 命中数 / 涉及作用域 / 向量通道是否参与），不含正文。
    const recalled = hits.slice(0, topK)
    this.events.recalled({
      query: query.text,
      hits: recalled.length,
      topScopes: [...new Set(recalled.map((hit) => hit.record.scope))],
      vector: qvec?.[0] !== undefined,
      ...(mergedIds.length > 0 ? { merged: mergedIds.length } : {}),
    })
    this.store.scheduleFlush()
    return recalled
  }

  /**
   * 面板「语义检索」:和 memory_search 走**同一套**双通道召回与打分(向量 + 词法 +
   * 可选重排),区别只有两点:
   *   1. 只读浏览器:不 `touch` 记录(访问计数/最近访问时间是检索排序的输入,
   *      面板里浏览一次不该把排序带偏);
   *   2. 报告这一次向量通道到底有没有参与 —— 面板得如实写「语义排序」还是
   *      「向量没跑起来,按关键词排」,而不是把词法结果冒充语义结果。
   *
   * `scopes` 由面板显式给出(全部作用域或下拉选中的那个),不做"默认项目"回退。
   */
  async searchForPanel(input                                                        )                             {
    const scopes                = []
    const seen = new Set             ()
    let total = 0
    let embedded = 0
    for (const raw of input.scopes) {
      const scope = this.canonicalScope(raw)
      if (seen.has(scope)) continue
      seen.add(scope)
      const store = this.store.peek(scope) // 只读:不创建 scope
      if (!store) continue
      scopes.push(scope)
      total += store.records.size
      embedded += store.vectors.size
    }
    const configured = this.cfg.vector.enabled && this.cfg.vector.configured
    // 空集合不能交给 search():它在 scopes 为空时会退回"默认项目 + global",
    // 那等于用户点了一个不存在的 scope 却搜出别的 scope 的记录。
    if (scopes.length === 0) {
      return {
        hits: [],
        mode: 'lexical',
        reason: 'no-records',
        embedded: 0,
        total: 0,
      }
    }
    // 没有向量 / 嵌入服务已被熔断时不要白打一次请求:直接走词法通道。
    const vector = configured && embedded > 0 && this.embed.isHealthy
    const hits = await this.search({
      text: input.text,
      scopes,
      topK: input.topK ?? 20,
      // 面板是**历史浏览器**:退役/过期/休眠/墓碑记录也要能搜到,否则用户无法从面板
      // 确认旧版本、也无法找回误删的记录(0.32.0 起 forget 是软删)。
      includeSuperseded: true,
      includeExpired: true,
      includeDormant: true,
      includeTombstoned: true,
      // 历史浏览器不做结果整形：用户要看到全部命中，而不是被去噪/合并后的子集。
      shaping: false,
      vector,
      touch: false,
    }                                                                                                                                                                                 )
    // 嵌入请求失败会被 EmbedClient 熔断(markDown),所以"跑完还健康"就等于向量通道
    // 真的产出了分数;否则这次只能算词法排序。
    const vectorRan = vector && this.embed.isHealthy
    return {
      hits,
      mode: vectorRan ? 'vector' : 'lexical',
      ...(vectorRan ? {} : { reason: !configured ? 'vector-disabled'          : total === 0 ? 'no-records'          : embedded === 0 ? 'no-vectors'          : 'embed-failed'          }),
      embedded,
      total,
    }
  }

          findById(id        )                           {
    for (const s of this.store.allScopes()) {
      const r = s.records.get(id)
      if (r) return r
    }
    return undefined
  }

  /**
   * 删除记录。`agent` + 未审批时按可见域护栏处理(0.20.0):
   * 范围外一律**当作不存在** —— id 找不到、query 没有匹配,不泄露"被限制";
   * 普通限制下工具层会先审批,批准后带 `visibilityApproved` 再调进来。
   */
  async forget(input   
               
                  
                       
                          
                   
                                
   )                                              {
    const guardAgent = input.agent
    const approved = input.visibilityApproved === true
    const operable = (scope             )          =>
      guardAgent === undefined || approved || this.isScopeOperable(guardAgent, scope)
    const ids           = []
    // 0.31.0：按 scope 汇总被删 id，删除完成后逐个 scope 广播（旁路，只带 id 不带正文）。
    const removedByScope                                     = []
    if (input.id) {
      // 按 id 删除天然跨 scope:调用方给的是精确 id,不存在误删别的 scope 的风险。
      // tombstone 需要 MemoryStore（它要按 id 定位 scope），不能传 ScopeStore。
      const located = this.store.scopeOf(input.id)
      if (located !== undefined && operable(located.store.scope)) {
        // 0.32.0：forget 改为软删（墓碑），默认保留 30 天可 restore；
        // 物理删除交给维护任务 purgeTombstones，避免误删不可恢复。
        const t = tombstone(this.store, input.id, { days: this.cfg.cognitive.tombstoneDays, reason: 'forget' })
        if (t.ok && t.reason !== 'already-tombstoned') {
          ids.push(input.id)
          removedByScope.push({ scope: located.store.scope, ids: [input.id] })
        }
      }
      if (ids.length === 0) throw memoryError('RECORD_NOT_FOUND', `id ${input.id} not found`)
    } else if (input.query) {
      // 按 query 删除的默认范围由工具层显式给出(默认只有当前会话);这里不再回退到
      // provider 的默认 scope —— 那正是"以为删了会话记忆、其实删了 global"的来源。
      const targets = (input.scope !== undefined
        ? [input.scope]
        : (input.scopes ?? []).length > 0
          ? input.scopes 
          : [this.defaultProjectScope]).map((scope) => this.canonicalScope(scope))
      const seen = new Set             ()
      for (const scope of targets) {
        if (seen.has(scope)) continue
        seen.add(scope)
        if (!operable(scope)) continue
        const store = this.store.peek(scope) // 读/删路径不创建
        if (!store) continue
        const hit = this.store.findIdsByQuery(scope, input.query)
        const removedHere           = []
        for (const id of hit) {
          const rec = store.records.get(id)
          // 已经被软删过的记录不再重复“删除”，否则第二次 forget 会返回一堆旧 id，
          // 也让 RECORD_NOT_FOUND 的语义失效。
          if (rec === undefined || isTombstonedRecord(rec)) continue
          const t = tombstone(this.store, id, { days: this.cfg.cognitive.tombstoneDays, reason: 'forget' })
          if (t.ok) removedHere.push(id)
        }
        if (removedHere.length > 0) {
          ids.push(...removedHere)
          removedByScope.push({ scope, ids: removedHere })
        }
      }
      if (ids.length === 0) throw memoryError('RECORD_NOT_FOUND', `no record matching query in ${targets.join(', ')}`)
    } else {
      throw memoryError('RECORD_NOT_FOUND', 'forget requires id or query')
    }
    for (const group of removedByScope) this.events.forgotten(group)
    this.store.scheduleFlush()
    return { removed: ids.length, ids }
  }

  /**
   * 0.32.0：撤销 forget（从墓碑恢复）。默认只在保留窗口内有效；
   * 记录已被活动新版本取代 / 窗口已过时需要显式 force。
   */
  restoreRecord(id        , opts                      = {})                                         {
    const result = restoreTombstoned(this.store, id, opts.force === true ? { force: true } : {})
    if (result.ok) this.store.scheduleFlush()
    return { restored: result.ok, ...(result.reason !== undefined ? { reason: result.reason } : {}) }
  }

  // -------------------------------------------------------------------------
  // 0.50.0：智能关系分析（六引擎 + 任务队列 + 可审核关系）
  // -------------------------------------------------------------------------
          analysisRepoInstance                            = null
          analysisTask                      = null
          analysisPauseRequested = false

          get analysisRepo()                     {
    if (this.analysisRepoInstance === null) this.analysisRepoInstance = new AnalysisRepository(this.cfg.storeDir)
    return this.analysisRepoInstance
  }

          get analysisSnapshotPath()         {
    return join(this.cfg.storeDir, 'analysis', 'snapshot.json')
  }

          readAnalysisSnapshot()                                                                                                                                         {
    try {
      const raw = JSON.parse(readFileSync(this.analysisSnapshotPath, 'utf8'))                           
      return {
        clusters: Array.isArray(raw.clusters) ? raw.clusters                       : [],
        evolution: Array.isArray(raw.evolution) ? raw.evolution : [],
        paths: Array.isArray(raw.paths) ? raw.paths                    : [],
        stats: raw.stats,
        ...(typeof raw.version === 'string' ? { version: raw.version } : {}),
        ...(typeof raw.analyzedAt === 'number' ? { analyzedAt: raw.analyzedAt } : {}),
      }
    } catch {
      return { clusters: [], evolution: [], paths: [] }
    }
  }

          writeAnalysisSnapshot(value                         )       {
    try {
      mkdirSync(dirname(this.analysisSnapshotPath), { recursive: true })
      const tmp = `${this.analysisSnapshotPath}.tmp-${process.pid}`
      writeFileSync(tmp, JSON.stringify(value), 'utf8')
      renameSync(tmp, this.analysisSnapshotPath)
    } catch { /* 快照失败不影响主流程 */ }
  }

  /** 收集分析用记忆（含退役历史，用于演化；软删/过期的由引擎过滤）。 */
          collectAnalysisMemories(scopes           )                                                                     {
    this.discoverScopes()
    const wanted = scopes !== undefined && scopes.length > 0
      ? scopes.map((scope) => this.canonicalScope(scope               ))
      : undefined
    const memories                   = []
    const vectors = new Map                      ()
    for (const scopeStore of this.store.allScopes()) {
      if (wanted !== undefined && !wanted.includes(scopeStore.scope)) continue
      for (const rec of scopeStore.records.values()) {
        const extra = rec                    
                                      
                             
                             
                            
                               
         
        memories.push({
          id: rec.id,
          scope: rec.scope,
          kind: rec.kind,
          content: rec.content,
          tags: rec.tags ?? [],
          createdAt: rec.createdAt,
          updatedAt: rec.updatedAt,
          importance: rec.importance,
          ...(extra.source?.origin !== undefined ? { sourceOrigin: extra.source.origin } : {}),
          ...(extra.supersedes !== undefined ? { supersedes: extra.supersedes } : {}),
          ...(extra.validUntil !== undefined ? { validUntil: extra.validUntil } : {}),
          ...(extra.expiredAt !== undefined ? { expiredAt: extra.expiredAt } : {}),
          ...(extra.tombstonedAt !== undefined ? { tombstonedAt: extra.tombstonedAt } : {}),
        })
        const vec = scopeStore.vectors.get(rec.id)
        if (vec !== undefined) vectors.set(rec.id, vec)
      }
    }
    return { memories, vectors }
  }

  analysisOverview()   
                            
                     
                     
                     
                            
                    
                           
                           
                                
    {
    const repo = this.analysisRepo
    const state = repo.loadState()
    const relations = repo.listRelations()
    const conflicts = repo.listConflicts()
    const snapshot = this.readAnalysisSnapshot()
    const { memories } = this.collectAnalysisMemories()
    return {
      analyzedMemories: memories.length,
      relations: relations.filter((item) => item.status === 'confirmed' || item.status === 'suggested').length,
      suggested: relations.filter((item) => item.status === 'suggested').length,
      confirmed: relations.filter((item) => item.status === 'confirmed').length,
      conflictsPending: conflicts.filter((item) => item.status === 'new' || item.status === 'pending_review').length,
      clusters: snapshot.clusters.length,
      ...(state.lastAnalyzedAt !== undefined ? { lastAnalyzedAt: state.lastAnalyzedAt } : {}),
      analysisVersion: snapshot.version ?? '1',
      running: this.analysisTask !== null && (this.analysisTask.status === 'running' || this.analysisTask.status === 'queued') ? this.analysisTask : null,
    }
  }

  analysisLatestTask()                      {
    return this.analysisTask ?? this.analysisRepo.listTasks(1)[0] ?? null
  }

  analysisHistory(input                     = {})                 {
    const limit = Math.max(1, Math.min(500, Math.floor(Number(input.limit) || 20)))
    return this.analysisRepo.listTasks(limit)
  }

  analysisPause()                      {
    this.analysisPauseRequested = true
    return { paused: true }
  }

  async analysisRun(input                                                                                                     = {})                        {
    const running = this.analysisTask
    if (running !== null && (running.status === 'running' || running.status === 'queued')) {
      throw memoryError('ANALYSIS_BUSY', '已有分析任务在运行，请等待完成或暂停。')
    }
    const mode               = input.mode === 'incremental' ? 'incremental' : 'full'
    const task               = {
      id: `ana-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      mode,
      status: 'running',
      progress: 0,
      total: 0,
      analyzed: 0,
      startedAt: Date.now(),
      options: {
        ...(Array.isArray(input.scopes) && input.scopes.length > 0 ? { scopes: input.scopes.map(String) } : {}),
        ...(Array.isArray(input.entityTypes) && input.entityTypes.length > 0 ? { entityTypes: input.entityTypes.map(String) } : {}),
        ...(typeof input.since === 'number' ? { since: input.since } : {}),
        ...(typeof input.until === 'number' ? { until: input.until } : {}),
      },
    }
    this.analysisPauseRequested = false
    this.analysisTask = task
    this.analysisRepo.appendTask({ ...task })
    void this.executeAnalysis(task, input).catch(() => { /* 任务内部已记录失败 */ })
    return task
  }

          async executeAnalysis(task              , input                                                                               )                {
    const repo = this.analysisRepo
    const finish = (patch                       )               => {
      const next = { ...task, ...patch }
      this.analysisTask = next
      repo.appendTask(next)
      return next
    }
    try {
      const { memories, vectors } = this.collectAnalysisMemories(input.scopes)
      task.total = memories.length
      task.progress = 0.05
      repo.appendTask({ ...task })
      const state = repo.loadState()
      const result = analyzeMemories({
        memories,
        vectors,
        previousFingerprints: task.mode === 'incremental' ? state.fingerprints : undefined,
        existingRelations: repo.listRelations(),
        existingConflicts: repo.listConflicts(),
        options: {
          mode: task.mode,
          ...(input.entityTypes !== undefined ? { entityTypes: input.entityTypes } : {}),
          ...(input.since !== undefined ? { since: input.since } : {}),
          ...(input.until !== undefined ? { until: input.until } : {}),
          analysisVersion: '1',
        },
      })
      task.progress = 0.9
      // 合并：用户已确认/拒绝/忽略的关系与已处理冲突**优先保留**，重算只覆盖 suggested/new。
      const mergedRelations = mergeAnalysisRelations(repo.listRelations(), result.relations, result.preservedRelations)
      const mergedConflicts = mergeAnalysisConflicts(repo.listConflicts(), result.conflicts, result.preservedConflicts)
      repo.saveRelations(mergedRelations)
      repo.saveConflicts(mergedConflicts)
      const nextState                = {
        version: 1,
        fingerprints: result.fingerprints,
        lastAnalyzedAt: Date.now(),
      }
      repo.saveState(nextState)
      this.writeAnalysisSnapshot({
        version: '1',
        analyzedAt: nextState.lastAnalyzedAt,
        mode: task.mode,
        stats: result.stats,
        clusters: result.clusters,
        evolution: result.evolution,
        paths: result.paths,
      })
      finish({
        status: this.analysisPauseRequested ? 'paused' : 'done',
        progress: 1,
        analyzed: result.stats.analyzed,
        finishedAt: Date.now(),
      })
    } catch (error) {
      finish({ status: 'failed', error: String((error         )?.message ?? error), finishedAt: Date.now() })
    }
  }

  analysisRelations(input                                      = {})                   {
    const limit = Math.max(1, Math.min(500, Math.floor(Number(input.limit) || 200)))
    const status = typeof input.status === 'string' && input.status !== '' ? input.status : undefined
    return this.analysisRepo.listRelations()
      .filter((item) => status === undefined || item.status === status)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
  }

  analysisRelationAction(input                                                                          )                 {
    const repo = this.analysisRepo
    const relations = repo.listRelations()
    const index = relations.findIndex((item) => item.id === input.id)
    if (index < 0) throw memoryError('RELATION_NOT_FOUND', `关系 ${input.id} 不存在`)
    const current = relations[index] 
    const statusMap                                 = { confirm: 'confirmed', reject: 'rejected', ignore: 'ignored', reopen: 'suggested', pending: 'pending_review' }
    const status = statusMap[input.action]
    if (status === undefined) throw memoryError('RELATION_ACTION_INVALID', `不支持的关系操作：${input.action}`)
    const relationshipType = typeof input.relationshipType === 'string' && input.relationshipType !== ''
      ? input.relationshipType                
      : current.relationshipType
    const next                 = {
      ...current,
      status,
      relationshipType,
      ...(typeof input.note === 'string' ? { note: input.note } : {}),
      updatedAt: Date.now(),
    }
    relations[index] = next
    repo.saveRelations(relations)
    return next
  }

  analysisCreateRelation(input                                                                                                                                  )                 {
    if (typeof input.sourceEntityId !== 'string' || input.sourceEntityId === '' || typeof input.targetEntityId !== 'string' || input.targetEntityId === '') {
      throw memoryError('RELATION_INPUT_INVALID', 'sourceEntityId / targetEntityId 必填')
    }
    const repo = this.analysisRepo
    const relations = repo.listRelations()
    const type = (input.relationshipType ?? 'manual')                
    const existing = relations.find((item) => (
      (item.sourceEntityId === input.sourceEntityId && item.targetEntityId === input.targetEntityId)
      || (item.sourceEntityId === input.targetEntityId && item.targetEntityId === input.sourceEntityId)
    ) && item.relationshipType === type)
    if (existing !== undefined) throw memoryError('RELATION_EXISTS', '这两个实体之间已存在同类型关系')
    const now = Date.now()
    const record                 = {
      id: `rel-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      sourceEntityId: input.sourceEntityId,
      targetEntityId: input.targetEntityId,
      relationshipType: type,
      status: 'confirmed',
      confidenceScore: type === 'manual' ? 1 : 0.8,
      strength: type === 'manual' ? 'strong' : 'medium',
      evidence: [{ kind: type === 'reasoning' ? 'reasoning' : 'manual', text: input.evidenceText ?? '用户手动建立的关系', memoryIds: Array.isArray(input.sourceMemoryIds) ? input.sourceMemoryIds.map(String) : [] }],
      sourceMemoryIds: Array.isArray(input.sourceMemoryIds) ? input.sourceMemoryIds.map(String) : [],
      inferred: type === 'reasoning',
      analysisVersion: '1',
      createdAt: now,
      updatedAt: now,
    }
    relations.push(record)
    repo.saveRelations(relations)
    return record
  }

  analysisConflicts(input                                      = {})                   {
    const limit = Math.max(1, Math.min(500, Math.floor(Number(input.limit) || 200)))
    const status = typeof input.status === 'string' && input.status !== '' ? input.status : undefined
    return this.analysisRepo.listConflicts()
      .filter((item) => status === undefined || item.status === status)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
  }

  analysisConflictAction(input                                                      )                 {
    const repo = this.analysisRepo
    const conflicts = repo.listConflicts()
    const index = conflicts.findIndex((item) => item.id === input.id)
    if (index < 0) throw memoryError('CONFLICT_NOT_FOUND', `冲突 ${input.id} 不存在`)
    const statusMap                                           = { confirmed: 'confirmed', resolved: 'resolved', ignored: 'ignored', pending: 'pending_review' }
    const status = statusMap[input.action]
    if (status === undefined) throw memoryError('CONFLICT_ACTION_INVALID', `不支持的冲突操作：${input.action}`)
    const current = conflicts[index] 
    const next                 = {
      ...current,
      status,
      updatedAt: Date.now(),
      ...(status === 'resolved' ? { resolution: { action: 'resolved', note: typeof input.resolution === 'string' ? input.resolution : undefined, decidedAt: Date.now() } } : {}),
    }
    conflicts[index] = next
    repo.saveConflicts(conflicts)
    return next
  }

  analysisClusters()                     {
    return this.readAnalysisSnapshot().clusters
  }

  analysisEvolution(input                                      = {})            {
    const limit = Math.max(1, Math.min(500, Math.floor(Number(input.limit) || 200)))
    const tracks = this.readAnalysisSnapshot().evolution                                
    const entity = typeof input.entity === 'string' && input.entity !== '' ? input.entity : undefined
    return tracks.filter((track) => entity === undefined || track.entityId === entity).slice(0, limit)
  }

  analysisPaths(input                                                )                             {
    if (typeof input.from !== 'string' || input.from === '' || typeof input.to !== 'string' || input.to === '') {
      throw memoryError('ANALYSIS_INPUT_INVALID', 'from / to 必填')
    }
    const from = input.from, to = input.to
    if (from === to) return { paths: [] }
    const maxHops = Math.max(2, Math.min(3, Math.floor(Number(input.maxHops) || 3)))
    const graph = this.analysisGraph()
    const labelOf = new Map(graph.nodes.map((node) => [node.id, node.label]))
    if (!labelOf.has(from) || !labelOf.has(to)) return { paths: [] }
    // 无向邻接：只沿 confirmed/suggested 关系走；BFS 最多 maxHops 跳，取前 5 条最短路径。
    const adjacency = new Map                                                                       ()
    for (const edge of graph.edges) {
      const entry = { to: edge.b, confidence: edge.confidence, confirmed: edge.status === 'confirmed' }
      const reverse = { to: edge.a, confidence: edge.confidence, confirmed: edge.status === 'confirmed' }
      if (!adjacency.has(edge.a)) adjacency.set(edge.a, [])
      if (!adjacency.has(edge.b)) adjacency.set(edge.b, [])
      adjacency.get(edge.a) .push(entry)
      adjacency.get(edge.b) .push(reverse)
    }
    const found                                                                   = []
                                                                                     
    let frontier         = [{ id: from, ids: [from], confidence: 1, confirmed: true }]
    const seenDepth = new Map                ([[from, 0]])
    for (let hop = 1; hop <= maxHops && found.length < 5; hop++) {
      const next         = []
      for (const node of frontier) {
        for (const edge of adjacency.get(node.id) ?? []) {
          if (node.ids.includes(edge.to)) continue
          const candidate       = {
            id: edge.to,
            ids: [...node.ids, edge.to],
            confidence: node.confidence * edge.confidence,
            confirmed: node.confirmed && edge.confirmed,
          }
          if (edge.to === to) { found.push({ ids: candidate.ids, confidence: candidate.confidence, confirmed: candidate.confirmed }) ; continue }
          const previousDepth = seenDepth.get(edge.to)
          if (previousDepth !== undefined && previousDepth <= hop) continue
          seenDepth.set(edge.to, hop)
          next.push(candidate)
        }
      }
      frontier = next
    }
    const now = Date.now()
    return {
      paths: found.slice(0, 5).map((item) => ({
        id: `path-${item.ids.join('-')}`,
        fromEntityId: from,
        toEntityId: to,
        path: item.ids,
        labels: item.ids.map((id) => labelOf.get(id) ?? id),
        confidence: Math.min(1, item.confidence),
        inferred: !item.confirmed,
        relationshipType: 'reasoning',
        evidence: [{ kind: 'reasoning', text: `多跳路径：${item.ids.map((id) => labelOf.get(id) ?? id).join(' → ')}`, memoryIds: [] }],
        sourceMemoryIds: [],
        analysisVersion: '1',
        createdAt: now,
        updatedAt: now,
      })),
    }
  }

  /**
   * 从当前可见记忆 + 已确认/推荐关系即时构建图谱（节点=实体，边=关系）。
   * 节点聚合口径与旧构建一致：count = 出现在多少条记忆里，按 count↓ / id↑ 排序取前 200；
   * 标签用抽取时的展示标签（首次出现的写法归一而来）。
   */
          buildAnalysisGraph()   
                                                                            
                                                                                                                               
                        
    {
    this.discoverScopes()
    const now = Date.now()
    // 活记忆 + 休眠：墓碑/失效/隔离不进图（休眠只是降权，不算删除）。
    const nodeById = new Map                                                                    ()
    const seenMemoryIds = new Set        ()
    for (const scopeStore of this.store.allScopes()) {
      for (const rec of scopeStore.records.values()) {
        if (!isRecordVisible(rec, { now, includeDormant: true })) continue
        if (seenMemoryIds.has(rec.id)) continue
        seenMemoryIds.add(rec.id)
        for (const entity of extractEntities(rec.content, { tags: rec.tags })) {
          const id = entityNodeId(entity.type, entity.normalized)
          const node = nodeById.get(id)
          if (node === undefined) nodeById.set(id, { id, label: entity.label, type: entity.type, count: 1 })
          else node.count++
        }
      }
    }
    const nodes = [...nodeById.values()]
      .sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, 200)
    const relations = this.analysisRepo.listRelations().filter((item) => item.status === 'confirmed' || item.status === 'suggested')
    const nodeIds = new Set(nodes.map((node) => node.id))
    const edges = relations
      .filter((relation) => nodeIds.has(relation.sourceEntityId) && nodeIds.has(relation.targetEntityId))
      .map((relation) => ({ a: relation.sourceEntityId, b: relation.targetEntityId, weight: Math.max(1, Math.round(relation.confidenceScore * 10)), status: relation.status, type: relation.relationshipType, confidence: relation.confidenceScore, inferred: relation.inferred }))
    return { nodes, edges, generatedAt: Date.now() }
  }

  analysisGraph()   
                                                                            
                                                                                                                               
    {
    return this.buildAnalysisGraph()
  }

  /** 0.40.0（P1）：记忆健康度报告（抽样重复率 + 冲突/失效/隔离/休眠/嵌入覆盖 + 0-100 分）。 */
  healthReport()               {
    this.discoverScopes()
    const records                 = []
    const vectors = new Map                      ()
    // 历史版本（被别的记录 supersedes 指向的旧记录）不参与重复率统计：
    // 旧版 vs 新版天然高相似，算进去会让健康分误扣（实测 22% 里 4 对全是历史版本）。
    const retired = new Set        ()
    for (const scopeStore of this.store.allScopes()) {
      for (const rec of scopeStore.records.values()) {
        records.push(rec)
        if (rec.supersedes !== undefined) retired.add(rec.supersedes)
      }
      for (const [id, vec] of scopeStore.vectors) vectors.set(id, vec)
    }
    return computeHealth(records, { vectors, now: Date.now(), excludeFromDuplicates: retired })
  }

  /** 0.40.0（P1）：冲突中心 —— 列出带冲突标记的活记录（按置信度降序）。 */
  listConflicts()                                                                                                                               {
    this.discoverScopes()
    const out                                                                                                                               = []
    for (const scopeStore of this.store.allScopes()) {
      for (const rec of scopeStore.records.values()) {
        const cognitive = rec                                                            
        if (!Array.isArray(cognitive.conflictWith) || cognitive.conflictWith.length === 0) continue
        out.push({
          id: rec.id,
          scope: rec.scope,
          content: rec.content,
          conflictWith: cognitive.conflictWith,
          conflictConfidence: Number.isFinite(cognitive.conflictConfidence) ? Number(cognitive.conflictConfidence) : 0,
          updatedAt: rec.updatedAt,
        })
      }
    }
    return out.sort((a, b) => b.conflictConfidence - a.conflictConfidence || b.updatedAt - a.updatedAt)
  }

  /** 0.40.0（P2）：对一条冲突记录做自动解决（证据/来源/时间三信号）。 */
  resolveConflictRecord(id        )                                                                                              {
    const located = this.store.scopeOf(id)
    if (located === undefined) throw memoryError('RECORD_NOT_FOUND', `id ${id} not found`)
    const record = located.record                                              
    const targetId = (record.conflictWith ?? [])[0]
    if (targetId === undefined) throw memoryError('CONFLICT_NOT_FOUND', `record ${id} has no conflict target`)
    const older = this.store.scopeOf(targetId)?.record
    if (older === undefined) throw memoryError('CONFLICT_NOT_FOUND', `conflict target ${targetId} not found`)
    const decision = resolveConflict({ newer: record, older })
    const applied = applyConflictResolution(this.store, decision)
    if (applied.applied) {
      // 解决后清掉冲突标记，冲突中心不再反复出现同一条。
      const current = this.store.scopeOf(id)?.record                                                                           
      if (current !== undefined && applied.action !== 'keep-both') {
        const next = { ...current }
        delete next.conflictWith
        delete next.conflictConfidence
        this.store.scopeOf(id)?.store.insert(next)
      }
      this.store.scheduleFlush()
    }
    return { applied: applied.applied, action: applied.action, reason: applied.reason, confidence: decision.confidence, updated: applied.updated }
  }

  /** 0.40.0（P4）：人工复核后解除隔离。 */
  releaseQuarantine(id        )                        {
    const released = clearQuarantine(this.store, id)
    if (released) this.store.scheduleFlush()
    return { released }
  }

  /** 0.40.0：备份目录（固定 <storeDir>/backups，面板只用这里，避免任意路径写入）。 */
  get backupDir()         {
    return join(this.cfg.storeDir, 'backups')
  }

  /** 0.40.0：列出本地备份（时间倒序）。 */
  listBackups()                                                            {
    const dir = this.backupDir
    const out                                                            = []
    try {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.jsonl.gz') && !name.endsWith('.jsonl')) continue
        try {
          const stat = statSync(join(dir, name))
          out.push({ name, bytes: stat.size, createdAt: stat.mtimeMs })
        } catch { /* 单个文件失败跳过 */ }
      }
    } catch { /* 目录不存在 = 无备份 */ }
    return out.sort((a, b) => b.createdAt - a.createdAt)
  }

  /** 0.40.0：立即创建本地备份，返回文件名与大小。 */
  createBackup()                                                   {
    const dir = this.backupDir
    mkdirSync(dir, { recursive: true })
    const name = `snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl.gz`
    const file = join(dir, name)
    const result = this.snapshotStore(file)
    return { name, bytes: result.bytes, records: result.records }
  }

  /** 0.40.0：从本地备份恢复（只允许 backupDir 下的文件名，防路径穿越）。 */
  restoreBackup(name        )                                        {
    const base = basename(String(name ?? ''))
    if (base === '' || base !== name || !/^[\w.\-]+\.jsonl(\.gz)?$/.test(base)) {
      throw memoryError('BACKUP_NAME_INVALID', `备份文件名非法：${String(name)}`)
    }
    return this.restoreStore(join(this.backupDir, base))
  }

  /** 0.32.0：导出记忆快照（gzip JSONL，不含向量；导入后按当前模型重新嵌入）。 */
  snapshotStore(file        , opts                                                          = {})                                                   {
    const result = writeSnapshot(this.store, file, opts)
    return { file: result.file, records: result.records, bytes: result.bytes }
  }

  /** 0.32.0：从快照恢复（默认跳过已存在 id、同 scope 内容去重）。 */
  restoreStore(file        , opts                                                     = {})                                        {
    const result = readSnapshotFile(this.store, file, opts)
    this.store.scheduleFlush()
    return { imported: result.imported, skipped: result.skipped }
  }

  /**
   * 列记录。显式 scope 只列它;`scopes` 数组用于"全部作用域";两者都没有时退回项目 scope。
   * 一律走 `peek`,所以列一个不存在的 scope 只会得到空数组,不会造出文件。
   */
  async list(input                  = {})                          {
    const internal = input                                                                                                
    // 注入侧(摘要)传入 agent 时按可见域的类型白名单过滤;工具侧不传,以便处理范围外审批。
    const visibleFilter = internal.agent !== undefined ? this.visibilityFilterFor(internal.agent) : undefined
    // 显式空集合 = 无可见范围(见 search 的同口径说明)。
    if (input.scope === undefined && input.scopes !== undefined && input.scopes.length === 0) return []
    const wanted = (input.scope !== undefined
      ? [input.scope]
      : (input.scopes ?? []).length > 0
        ? input.scopes 
        : [this.defaultProjectScope]).map((scope) => this.canonicalScope(scope))
    const seen = new Set             ()
    const stores               = []
    const archivedScopes = this.archivedSessionScopes()
    for (const scope of wanted) {
      if (seen.has(scope)) continue
      seen.add(scope)
      if (archivedScopes.has(scope)) continue
      const store = this.store.peek(scope)
      if (store) stores.push(store)
    }
    const retired = internal.includeSuperseded ? new Set        () : new Set(this.supersededIds(wanted))
    const now = Date.now()
    const includeDormant = (input                                ).includeDormant === true
    const includeTombstoned = (input                                   ).includeTombstoned === true
    let records                 = []
    for (const store of stores) {
      for (const rec of store.records.values()) {
        if (retired.has(rec.id)) continue
        if (internal.includeExpired !== true && rec.expiredAt !== undefined && rec.expiredAt < now) continue
        // 0.34.0：统一可见性（休眠/软删/过期/失效），历史浏览显式打开。
        if (!isRecordVisible(rec, { includeDormant, includeTombstoned, includeExpired: internal.includeExpired === true, now })) continue
        records.push(rec)
      }
    }
    if (input.kind) records = records.filter((r) => r.kind === input.kind)
    if (visibleFilter !== undefined) records = records.filter((r) => visibleFilter(r.scope, r.kind))
    records.sort((a, b) => b.updatedAt - a.updatedAt)
    return records.slice(0, input.limit ?? 50)
  }

  /**
   * 按 id 批量取记录(memory_get)。接受完整 id,也接受摘要里给出的前 8 位前缀
   * (前缀命中多条时全部返回,由调用方/模型自行判断)。取全文不需要再检索。
   */
  getByIds(ids          , opts                         = {})                 {
    this.discoverScopes()
    const scopes = this.store.allScopes()
    const archivedScopes = this.archivedSessionScopes()
    const out                 = []
    const seen = new Set        ()
    for (const token of ids) {
      if (typeof token !== 'string' || token.length === 0) continue
      for (const s of scopes) {
        if (archivedScopes.has(s.scope)) continue
        for (const rec of s.records.values()) {
          if (seen.has(rec.id)) continue
          if (rec.id === token || rec.id.startsWith(token)) {
            seen.add(rec.id)
            out.push(rec)
          }
        }
      }
    }
    // 0.33.0：取用反馈闭环 —— 只有**显式 memory_get** 取到正文才算"真的用到了"，
    // 用 FSRS 式 updateAfterUse 提升 stability / utility；召回本身、以及注入层
    // 做去重标记时的内部读取都不算（0.34.2 修：它们会让 utility/useCount 虚增）。
    if (opts.trackUse === true && out.length > 0) {
      const now = Date.now()
      for (const rec of out) {
        // 历史查询（软删/失效/休眠）不产生"取用"信号，否则恢复出来的记忆会莫名高分。
        if (!isRecordVisible(rec, { now })) continue
        try {
          const next = updateAfterUse({
            stability: (rec                          ).stability,
            difficulty: (rec                           ).difficulty,
            utility: (rec                        ).utility,
            useCount: (rec                         ).useCount,
            lastUsedAt: (rec                           ).lastUsedAt,
          }, 3, now)
          this.store.updateMetrics(rec.id, next)
        } catch { /* 反馈失败不影响读取 */ }
      }
      this.store.scheduleFlush()
    }
    return out
  }

  /**
   * 面板新建一条记忆 / 规则。scope 必须是**明确的键**(global / project:<路径> /
   * session:<id> / 自定义名)—— 面板拿不到会话上下文,'project'/'session' 这种
   * 相对写法没法解析,直接拒绝比猜一个错的强。
   */
  async createRecord(input   
                  
                 
                    
                   
                       
                  
                      
   )                        {
    const normalized = normalizeScopeInput(input.scope)
    if (!normalized.ok) throw memoryError('SCOPE_INVALID', normalized.message)
    if (normalized.scope === undefined) {
      throw memoryError('SCOPE_INVALID', '面板写入需要明确的 scope(global / project:<路径> / session:<id> / 自定义名)')
    }
    return this.save({
      scope: normalized.scope               ,
      kind: (input.kind ?? 'note')                        ,
      content: String(input.content ?? ''),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.importance !== undefined ? { importance: input.importance } : {}),
      ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    }                   )
  }

  /**
   * 面板编辑（0.23.0）：**不原地改旧记录**，而是新建一条修正版并在 `supersedes`
   * 指向旧记录。旧记录保留（面板历史 / memory_get 仍可取，检索默认隐藏它）。
   *
   * 返回 `{ record, superseded }`。内容为空 / 超长 / 命中凭据扫描时的行为与 save 一致。
   */
  async reviseRecord(input   
              
                    
                 
                   
                       
                       
                                                  
                             
                                     
                  
   )                                                        {
    this.discoverScopes()
    let found                                                         
    for (const store of this.store.allScopes()) {
      const record = store.records.get(input.id)
      if (record !== undefined) { found = { store, record }; break }
    }
    if (found === undefined) throw memoryError('RECORD_NOT_FOUND', `no record ${input.id}`)
    const { store, record: old } = found
    let content = input.content !== undefined ? String(input.content).trim() : old.content
    if (content === '') throw memoryError('CONTENT_EMPTY', 'content must be a non-empty string')
    if (content.length > this.cfg.maxRecordChars) {
      throw memoryError('CONTENT_TOO_LONG', `content exceeds ${this.cfg.maxRecordChars} chars`)
    }
    if (this.cfg.secrets.enabled) {
      const findings = scanSecrets(content)
      if (findings.length > 0) {
        if (this.cfg.secrets.mode === 'refuse') {
          throw memoryError('SECRET_DETECTED', `content matches credential denylist: ${[...new Set(findings.map((f) => f.kind))].join(', ')}`)
        }
        content = redactSecrets(content)
      }
    }
    const now = Date.now()
    const kind = (input.kind !== undefined ? String(input.kind) : old.kind)                        
    const next               = {
      id: newId(),
      scope: old.scope,
      kind,
      content,
      tags: input.tags !== undefined ? input.tags.map(String) : [...old.tags],
      source: { origin: 'explicit' },
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
      accessCount: 0,
      importance: input.importance !== undefined
        ? Math.min(1, Math.max(0, Number(input.importance) || 0))
        : old.importance,
      supersedes: old.id,
    }
    const triggers = input.triggers !== undefined
      ? input.triggers.map(String)
      : (old                                          ).triggers
    if (Array.isArray(triggers)) (next                                          ).triggers = [...triggers]
    // 编辑初始记录 = 修正该作用域的“自我介绍”，来源标记要跟着走。
    if ((old                                        ).initial === true) {
      ;(next                                        ).initial = true
    }
    if (input.expiresAt === null) {
      // 显式清除:不设置 expiredAt。
    } else if (typeof input.expiresAt === 'number' && Number.isFinite(input.expiresAt)) {
      next.expiredAt = input.expiresAt
    } else if (typeof input.ttlMs === 'number' && Number.isFinite(input.ttlMs) && input.ttlMs > 0) {
      next.expiredAt = now + input.ttlMs
    } else if (old.expiredAt !== undefined) {
      next.expiredAt = old.expiredAt
    }
    store.insert(next)
    this.store.scheduleFlush()
    void this.embedRecord(next).catch(() => {})
    return { record: next, superseded: old.id }
  }

  /**
   * 导出全部记忆为**纯文本**文档(不含向量)。向量在导入时按当前模型重新算,
   * 所以换过模型也照样导得回去。
   */
  exportAll(now = Date.now())   
              
                      
                    
                        
                  
                     
                    
                        
                       
                       
                               
                         
                                   
                        
                                             
                       
      
    {
    this.discoverScopes()
    const records = []
    for (const s of this.store.allScopes()) {
      for (const rec of s.records.values()) {
        records.push({
          scope: rec.scope,
          kind: rec.kind,
          content: rec.content,
          tags: rec.tags,
          importance: rec.importance,
          createdAt: rec.createdAt,
          updatedAt: rec.updatedAt,
          ...(Array.isArray((rec                                         ).triggers)
            ? { triggers: ((rec                                         ).triggers             ).map(String) }
            : {}),
          ...(rec.expiredAt !== undefined ? { expiredAt: rec.expiredAt } : {}),
          ...((rec                                        ).initial === true ? { initial: true } : {}),
        })
      }
    }
    records.sort((a, b) => a.scope.localeCompare(b.scope) || a.createdAt - b.createdAt)
    return { version: 1, exportedAt: now, records }
  }

  /**
   * 导入文本记忆。逐条走 `save()`(凭据扫描 / 上限 / 去重 / 向量回填都在那条路上),
   * 所以导入的记录会自动按当前模型重新嵌入。返回计数,失败不中断其余条目。
   */
  async importRecords(input         )                                                                                     {
    const list = Array.isArray(input)
      ? input
      : (input && typeof input === 'object' && Array.isArray((input                         ).records))
        ? (input                          ).records
        : null
    if (list === null) throw memoryError('IMPORT_INVALID', '导入格式不对:需要 {version, records:[...]} 或记录数组')
    if (list.length > 5000) throw memoryError('IMPORT_TOO_LARGE', `一次最多导入 5000 条(收到 ${list.length} 条)`)

    let imported = 0
    let skipped = 0
    let rejected = 0
    const errors           = []
    for (const [index, raw] of list.entries()) {
      try {
        const rec = raw     
                                                                                                  
                                                                    
         
        const content = typeof rec.content === 'string' ? rec.content : ''
        if (content.trim().length === 0) throw new Error('content 为空')
        const normalized = normalizeScopeInput(typeof rec.scope === 'string' ? rec.scope : undefined)
        if (!normalized.ok) throw new Error(normalized.message)
        if (normalized.scope === undefined) throw new Error('缺少明确的 scope')
        const scope = normalized.scope               
        if (this.store.hasContent(scope, content)) {
          skipped += 1
          continue
        }
        await this.save({
          scope,
          kind: (typeof rec.kind === 'string' && rec.kind.length > 0 ? rec.kind : 'note')                        ,
          content,
          ...(Array.isArray(rec.tags) ? { tags: rec.tags.map(String) } : {}),
          ...(typeof rec.importance === 'number' ? { importance: rec.importance } : {}),
          ...(Array.isArray(rec.triggers) ? { triggers: rec.triggers.map(String) } : {}),
          ...(typeof rec.expiredAt === 'number' && Number.isFinite(rec.expiredAt) ? { expiresAt: rec.expiredAt } : {}),
          ...(rec.initial === true ? { initial: true } : {}),
        }                   )
        imported += 1
      } catch (error) {
        rejected += 1
        if (errors.length < 20) errors.push(`#${index}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    this.store.scheduleFlush()
    return { imported, skipped, rejected, errors }
  }

  /** 规则条数(面板设置页显示;只数已加载/已发现的作用域,排除退役规则)。 */
  ruleStats()                                    {
    this.discoverScopes()
    const retired = new Set(this.supersededIds())
    let total = 0
    let scopes = 0
    for (const s of this.store.allScopes()) {
      const n = [...s.records.values()].filter((r) => r.kind === 'rule' && !retired.has(r.id)).length
      if (n > 0) { total += n; scopes += 1 }
    }
    return { total, scopes }
  }

  /** 作用域别名（没有则 undefined，调用方回退到路径/键本身）。 */
  scopeName(scope             )                     {
    return this.names.nameOf(scope)
  }

  /** 作用域用途等元数据（没有则 undefined；调用方按“未填写用途”处理）。 */
  scopeMeta(scope             )                        {
    return this.meta.get(this.canonicalScope(scope))
  }

  /**
   * 写入 / 更新 / 清空作用域用途。**不会**创建记录，也不触发初始化；给面板、
   * `memory_scopes` 的 edit 动作与 memory_save 的 scopeDescription 用。
   *
   * 0.29.0：空白描述 = **清空**（保留元数据与 generation —— 删元数据会让按
   * generation 绑定的会话授权失效，所以清空只把 description 写成空串）。
   * 清空后目录按类型补默认描述，与"从没写过"的展示一致。
   */
  describeScope(scope             , description        , by        )            {
    const key = this.canonicalScope(scope)
    this.assertScopeAllowed(key)
    this.assertCustomScopeBudget(key)
    const text = typeof description === 'string' ? description.replace(/\s+/g, ' ').trim() : ''
    if (text.length > MAX_SCOPE_DESCRIPTION_CHARS) {
      throw memoryError('SCOPE_DESCRIPTION_TOO_LONG', `作用域用途最多 ${MAX_SCOPE_DESCRIPTION_CHARS} 字`)
    }
    return this.meta.put(key, { description: text, createdBy: by, status: 'ready' })
  }

  /**
   * 设置 / 移除作用域别名（0.29.0）。别名只影响**显示与引用**，不改变作用域键：
   * 项目作用域的身份永远是 `project:<绝对路径>`，自定义作用域永远是名字本身。
   *
   * - 非空名字 → `ScopeNames.claim`（统一校验、去重；重名报 SCOPE_NAME_TAKEN）；
   * - 空串 / undefined → 移除别名，显示名回退到键本身（项目路径 / 自定义名）；
   * - global 与 session 不支持别名：它们的显示名跟随类型与会话 id，改名只会让
   *   同一个域出现两种叫法，没有收益。
   */
  renameScope(scope             , name                           )                                        {
    const key = this.canonicalScope(scope)
    this.assertScopeAllowed(key)
    const kind = scopeKind(key)
    if (kind === 'global' || kind === 'session') {
      throw memoryError('SCOPE_NAME_UNSUPPORTED', 'global 与 session 作用域不支持别名：它们的显示名跟随类型与会话 id（项目 / 自定义作用域可以设别名）')
    }
    const text = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : ''
    if (text === '') {
      this.names.release(key)
      return { scope: key }
    }
    return { scope: key, name: this.names.claim(key, text) }
  }

  /** 名字 → 作用域键：读路径允许直接用别名找作用域。 */
  scopeKeyForName(name        )                          {
    return this.names.scopeOf(name)                           
  }

  /**
   * 作用域键归一:自定义名可能是别名 → 转回真实键;`project:<路径>` 统一路径写法;
   * 展示前缀 `custom:` 剥掉(0.26.0)。
   *
   * 项目键必须过 `canonicalWorkspacePath`:工具层的 `path`、模型显式给的
   * `project:D:/x`、面板 HTTP 写入都从这里落盘,同一个目录不能因为 `/` 与 `\` 的差别
   * 变成两个 scope(0.11.1;读路径的键来自 resolveCurrentScopes,也走同一套规范化)。
   */
          canonicalScope(scope             )              {
    if (scope === 'global' || scope.startsWith('session:')) return scope
    if (scope.startsWith('project:')) {
      const path = scope.slice('project:'.length)
      if (path === '') return scope
      const canonical = canonicalWorkspacePath(path)
      return (canonical === path ? scope : `project:${canonical}`)               
    }
    // 0.26.0:展示形式 `custom:<名字>` 与裸名是同一个作用域。旧数据(grants / visibility /
    // bindings)里若留下过带前缀的键,读的时候自动折回真实键,不再出现"幽灵授权"。
    const bare = normalizeScopeKey(scope)
    if (bare !== scope) return (this.names.scopeOf(bare)                           ) ?? (bare               )
    return (this.names.scopeOf(scope)                           ) ?? scope
  }

  /**
   * 作用域清单(名字 + 条数 + 待嵌入 + 最近活跃时间),给面板 /status 与 memory_list 的尾部清单用。
   *
   * 先 `discoverScopes()`:进程内 store 是懒加载的,只列"已加载"的 scope 会让面板/清单
   * 漏掉别的进程(上一次会话、另一个 agent)写下的作用域。
   * 排序键是"最近活跃"(`updatedAt`):面板据此只给最近活跃的前 N 个会话 scope 查标题。
   */
  scopeStats()                                                                                                                              {
    this.discoverScopes()
    const archived = this.archivedSessionScopes()
    return this.store.allScopes()
      .map((s) => {
        // 0.32.0：墓碑记录不算“记录数”（forget 变软删后，删掉的记忆不该继续
        // 出现在目录/待嵌入统计里；物理删除由 purgeTombstones 负责）。
        const live = [...s.records.values()].filter((r) => !isTombstonedRecord(r))
        const pending = [...s.embedPending].filter((id) => {
          const rec = s.records.get(id)
          return rec !== undefined && !isTombstonedRecord(rec)
        })
        return {
          scope: s.scope,
          ...(this.names.nameOf(s.scope) !== undefined ? { name: this.names.nameOf(s.scope) } : {}),
          records: live.length,
          pendingEmbeds: pending.length,
          updatedAt: live.reduce((max, r) => Math.max(max, r.updatedAt), 0),
          ...(archived.has(s.scope) ? { archived: true } : {}),
        }
      })
      .sort((a, b) => b.updatedAt - a.updatedAt || b.records - a.records || a.scope.localeCompare(b.scope))
  }

  /**
   * 作用域目录（memory_scopes list / 未来面板的“作用域”页）。
   *
   * 与 `scopeStats()` 的区别：这里回答的是“有哪些作用域、各自干什么、我现在能不能
   * 读/写/申请”，而不是“每个作用域有多少条”。三条语义写死：
   *   - 没有记录但有元数据的作用域也会出现（删光记录不等于作用域消失）；
   *   - 关闭的作用域类型（含 `customEnabled=false`）整条不出现；
   *   - `absolute` 下范围外条目的名字/用途仍可见，但 readable/writable/canRequest*
   *     全为 false —— 目录可见不等于正文可读，且 absolute 没有审批放行路径。
   */
  /**
   * 作用域初始化记录（`initial: true`）的目录视图。只给 normal / none 用；
   * absolute 由调用方跳过。正文截断到 800 字，每个作用域最多 3 条。
   */
          initialRecordsOf(scope             )                                                                                        {
    const store = this.store.peek(scope)
    if (store === undefined) return undefined
    const out                                                                            = []
    for (const record of store.records.values()) {
      if ((record                                        ).initial !== true) continue
      const content = record.content.trim()
      out.push({
        id: record.id,
        kind: record.kind,
        content: content.length > 800 ? `${content.slice(0, 800)}…` : content,
        ...(content.length > 800 ? { truncated: true } : {}),
      })
      if (out.length >= 3) break
    }
    return out.length > 0 ? out : undefined
  }

  scopeCatalog(agent         )                      {
    const policy = this.visibilityPolicy(agent)
    const stats = new Map(this.scopeStats().map((item) => [this.canonicalScope(item.scope), item]))
    const metas = new Map(this.meta.list().map((item) => [this.canonicalScope(item.scope), item]))
    const keys = new Set             ()
    for (const scope of this.baseDefaultScopes(agent)) keys.add(this.canonicalScope(scope))
    for (const scope of this.bindings.get(this.workspaceKeyFor(agent))) keys.add(this.canonicalScope(scope))
    for (const scope of stats.keys()) keys.add(this.canonicalScope(scope))
    for (const scope of metas.keys()) keys.add(scope)

    const out                      = []
    const evaluate = this.accessEvaluator(agent)
    const archivedScopes = this.archivedSessionScopes()
    for (const scope of keys) {
      // 目录发现本身也是一条授权判定：作用域类型被关闭时连名字/用途都不出现。
      if (!evaluate({ scope, action: 'discover' }).allowed) continue
      const meta = metas.get(scope)
      const stat = stats.get(scope)
      const rule = policy.scopes.find((item) => this.canonicalScope(item.scope) === scope)
      const inScope = policy.level === 'none' || rule !== undefined
      // 别的会话的 session scope 默认不进目录：它们没有用途、也不该被 Agent 主动申请，
      // 全列出来只会把目录变成历史会话列表。有元数据（被人描述过）则保留。
      if (!inScope && meta === undefined && scopeKind(scope) === 'session') continue
      // 0.30.0：归档会话的作用域保留在目录里，但读写/申请全部冻结 —— 这不是权限
      // 边界，而是会话生命周期：恢复会话后自动复原，不需要任何额外操作。
      const archived = archivedScopes.has(scope)
      const readDecision = evaluate({ scope, action: 'read' })
      const writeDecision = evaluate({ scope, action: 'write' })
      const readable = !archived && readDecision.allowed
      const writable = !archived && writeDecision.allowed
      // 只有“整个作用域不在范围内”（SCOPE_NOT_IN_RANGE）才可申请；absolute 与
      // 用户显式关掉的 read/write 都不会 requestable；归档也不可申请。
      const canRequestRead = !archived && !readable && readDecision.requestable
      const canRequestWrite = !archived && !writable && writeDecision.requestable
      const accessStatus                                    = archived
        ? 'archived'
        : !inScope
          // 范围外但已有会话授权：如实显示“可读 / 可写”，而不是继续标 restricted。
          ? readable && writable
            ? 'read-write'
            : readable
              ? 'read-only'
              : 'restricted'
          : policy.source === 'default'
            ? 'default'
            : readable && writable
              ? 'read-write'
              : readable
                ? 'read-only'
                : 'restricted'
      const name = meta?.name ?? this.names.nameOf(scope)
      const initialRecords = policy.level === 'absolute' ? undefined : this.initialRecordsOf(scope)
      // 0.27.0：scope-meta 没写用途时按作用域类型给默认描述，
      // 让目录里每一条都自带「这个域是干什么的」。
      // 0.29.0：被显式清空（描述为空串）与从没写过同样处理，都回退到默认描述。
      const written = typeof meta?.description === 'string' ? meta.description.trim() : ''
      const description = written !== '' ? written : defaultScopeDescription(scope)
      out.push({
        scope,
        ...(name !== undefined ? { name } : {}),
        ...(description !== '' ? { description } : {}),
        origin: meta?.origin ?? scopeKind(scope),
        ...(inScope || archived ? { records: stat?.records ?? 0 } : {}),
        inScope,
        readable,
        writable,
        canRequestRead,
        canRequestWrite,
        accessStatus,
        updatedAt: stat?.updatedAt ?? meta?.updatedAt ?? 0,
        ...(archived ? { archived: true } : {}),
        ...(initialRecords !== undefined ? { initialRecords } : {}),
      })
    }
    return out.sort((a, b) => Number(b.inScope) - Number(a.inScope)
      || (b.records ?? 0) - (a.records ?? 0)
      || b.updatedAt - a.updatedAt
      || a.scope.localeCompare(b.scope))
  }

  /**
   * 发现磁盘上的 scope(带时间缓存)。面板每次 /status、每次 memory_list 都要一份完整
   * 清单,而 discovery 要读每个文件的第一条记录 —— 限流到最短 3 秒一次,既保证清单够新,
   * 也不至于把 projects/ 目录读成热路径(面板侧还有一层同样时长的缓存,旧 provider 也能受益)。
   */
  /**
   * 当前进程已知的 scope 键:**只读**,不触发发现(要完整清单用 discoverScopes()/scopeStats())。
   */
  knownScopes()                {
    return this.store.allScopes().map((s) => s.scope)
  }

  /**
   * 发现磁盘上的 scope(带时间缓存)。面板每次 /status、每次 memory_list 都要一份完整
   * 清单,而 discovery 要读每个文件的第一条记录 —— 限流到最短 3 秒一次,既保证清单够新,
   * 也不至于把 projects/ 目录读成热路径(面板侧还有一层同样时长的缓存,旧 provider 也能受益)。
   */
  discoverScopes()                {
    const now = Date.now()
    if (this.discoveredAt === 0 || now - this.discoveredAt >= DISCOVER_TTL_MS) {
      this.discoveredAt = now
      try {
        this.store.loadDiscovered()
      } catch {
        // 发现失败不影响读写,清单里少几个而已
      }
      try {
        this.reconcileScopes()
      } catch {
        // 合并失败同样不影响读写:留着两个 scope 也比丢数据强
      }
    }
    return this.knownScopes()
  }

  /**
   * 把"同一个目录的不同写法"合并成一个项目作用域(0.11.1,每个进程只跑一次)。
   *
   * 0.7.0 引入 `memory_save({ path })` 之后, `D:/repositories/x` 与 `D:\repositories\x`
   * 会落成两个 scope 文件;工作区里的会话用宿主给的 `header.cwd`,于是另一份里的记忆
   * 永远读不到(面板里还会看到两个同名作用域)。写入侧已在 `canonicalScope` 统一写法,
   * 这里负责把**历史数据**并到规范键上:
   *   - 同组的判定走 `projectScopeIdentity`(Windows 盘符路径再折叠大小写,POSIX 不动);
   *   - 目标键优先选"写法已经规范"的那一个,其次记录多的(稳定时按键名);**只有变体存在时
   *     改名**到规范键(否则会话读规范键、永远看不到这份记忆);
   *   - 记录按 id 并入目标(目标已有同 id 就跳过);向量长度与当前配置一致时一起搬;
   *   - 别名跟着走(目标没有别名时才接管),迁空的 scope 由 flush 顺手删掉文件。
   * 多进程并发时,flush 的"锁内重新读盘 + 只合并本进程增量"兜底:这里只发 upsert/delete,
   * 不会把别的进程刚写的内容覆盖掉。
   */
  reconcileScopes()                     {
    if (this.scopesReconciled) return { merged: 0 }
    this.scopesReconciled = true
    // 直接调用(装配期)时还没有发现过磁盘 scope:先发现,否则只能看到已加载的那两个,
    // 合并会漏、而且这唯一一次机会被浪费掉。
    if (this.discoveredAt === 0) {
      this.discoveredAt = Date.now()
      try {
        this.store.loadDiscovered()
      } catch {
        // 发现失败:清单少几个,不影响读写
      }
    }
    const groups = new Map                                                                      ()
    for (const store of this.store.allScopes()) {
      if (!store.scope.startsWith('project:')) continue
      const path = store.scope.slice('project:'.length)
      if (path === '') continue
      const identity = projectScopeIdentity(path)
      const list = groups.get(identity)
      const entry = { scope: store.scope, store, records: store.records.size }
      if (list === undefined) groups.set(identity, [entry])
      else list.push(entry)
    }
    let merged = 0
    for (const list of groups.values()) {
      const canonicalOf = (scope             )              =>
        `project:${canonicalWorkspacePath(scope.slice('project:'.length))}`               
      // 1) 写法已经规范的优先 2) 记录多的 3) 键名字典序(稳定,避免每次合并目标漂移)
      list.sort((a, b) =>
        Number(canonicalOf(b.scope) === b.scope) - Number(canonicalOf(a.scope) === a.scope)
        || b.records - a.records
        || a.scope.localeCompare(b.scope))
      const targetScope = list[0] .scope
      // 只有变体存在时(用 path 参数写进来的记忆,会话还没写过那个目录)也要**改名**:
      // 会话读的是规范键,不改名等于这份记忆永远看不见。改名后 records 一条不少。
      const canonicalTarget = canonicalOf(targetScope)
      const finalTarget = canonicalTarget === targetScope ? targetScope : canonicalTarget
      const sources = list.filter((entry) => entry.scope !== finalTarget)
      if (sources.length === 0) continue
      const targetStore = this.store.scope(finalTarget)
      for (const source of sources) {
        for (const record of [...source.store.records.values()]) {
          if (!targetStore.records.has(record.id)) {
            targetStore.insert({ ...record, scope: finalTarget })
            const vector = source.store.vectors.get(record.id)
            // 向量只有在维度与当前配置一致时才可信(换过模型/池化的边车已被 loadScope 校验过,
            // 这里再按维度兜一层);搬不动的留给回填/重启后重新嵌入。
            if (vector !== undefined && vector.length === this.cfg.vector.dims) {
              targetStore.setVector(record.id, vector)
            }
          }
          source.store.remove(record.id)
        }
        const alias = this.names.nameOf(source.scope)
        if (alias !== undefined) {
          this.names.release(source.scope)
          if (this.names.nameOf(finalTarget) === undefined) {
            try {
              this.names.claim(finalTarget, alias)
            } catch {
              // 名字已被别的 scope 占用 → 放弃别名(路径本身仍可引用)
            }
          }
        }
        merged += 1
      }
    }
    if (merged > 0) {
      this.store.flush()
      console.warn(`[dsh-memory-local] 已合并 ${merged} 个"同一目录不同写法"的项目作用域`)
    }
    return { merged }
  }

  /** Force a synchronous flush (dispose/HMR path). */
  flushSync()       {
    // 审计 sink 属于注入半边：provider 退出时解绑并释放，避免面板继续读旧 store。
    try { this.injectAuditSink?.dispose?.() } catch { /* 审计清理失败不影响 provider */ }
    this.injectAuditSink = null
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer)
      this.maintenanceTimer = null
    }
    if (this.embedRetryTimer) {
      clearInterval(this.embedRetryTimer)
      this.embedRetryTimer = null
    }
    if (this.initialDrainTimer) {
      clearTimeout(this.initialDrainTimer)
      this.initialDrainTimer = null
    }
    this.embedKeepAlive?.stop()
    this.embedKeepAlive = null
    try { this.embedCache?.dispose() } catch { /* 缓存落盘失败不影响退出 */ }
    this.embedCache = null
    if (this.embedServer) this.embedServer.stop()
    if (this.exitHook) {
      process.removeListener('exit', this.exitHook)
      this.exitHook = null
    }
    // 归档会话作用域在归档期间冻结：dispose 时也不做过期清理 / 容量淘汰。
    const frozen = (scope        )          => this.isArchivedSessionScope(scope)
    this.store.purgeExpired(undefined, frozen)
    this.store.enforceLimit(this.cfg.maxRecordsPerScope, undefined, frozen)
    this.store.close()
  }

  get pendingEmbedCount()         {
    return this.store.allScopes().reduce((n, s) => n + s.embedPending.size, 0)
  }
}

function touch(record              )               {
  record.lastAccessedAt = Date.now()
  record.accessCount += 1
  return record
}

function round4(n        )         {
  return Math.round(n * 10_000) / 10_000
}

/** Port of an http(s) endpoint, or null when it cannot be parsed. */
function portOf(endpoint        )                {
  try {
    const port = new URL(endpoint).port
    return port ? Number.parseInt(port, 10) : null
  } catch {
    return null
  }
}

/**
 * Measured score floor of genuine lexical hits; below this only single-char
 * coincidences live. Used to gate weak-only overlaps regardless of config.
 */
/** 本地嵌入服务冷启动窗口：超过它与「服务就绪」无关，必须恢复语义召回。 */
const WARMING_MAX_MS = 180_000
const REAL_HIT_FLOOR = 0.25

function memoryError(code        , message        )                           {
  const err = new Error(`[memory:${code}] ${message}`)                            
  err.code = code
  return err
}

/** 作用域用途统一成一行（与工具的 description 同款收敛口径）。 */
function normalizeScopeDescription(raw         )         {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : ''
}

/** discoverScopes() 的最短间隔:清单要够新,但 projects/ 目录不该被读成热路径。 */
const DISCOVER_TTL_MS = 3000

export function createMemoryService(config                    = {})                     {
  return new LocalMemoryService(config)
}

/**
 * 关系合并：既有关系里用户已决策的（confirmed/rejected/ignored/pending_review）优先，
 * 重算结果只覆盖 suggested；未触及的 suggested 原样保留。同 id 去重。
 */
function mergeAnalysisRelations(existing                           , fresh                           , preserved                           )                   {
  const map = new Map                        ()
  for (const item of existing) map.set(item.id, item)
  for (const item of [...fresh, ...preserved]) {
    const previous = map.get(item.id)
    if (previous !== undefined && previous.status !== 'suggested') continue
    map.set(item.id, item)
  }
  return [...map.values()]
}

/** 冲突合并：已确认/已解决/已忽略的冲突保留；new/pending_review 用重算或保留结果覆盖。 */
function mergeAnalysisConflicts(existing                           , fresh                           , preserved                           )                   {
  const map = new Map                        ()
  for (const item of existing) map.set(item.id, item)
  for (const item of [...fresh, ...preserved]) {
    const previous = map.get(item.id)
    if (previous !== undefined && previous.status !== 'new' && previous.status !== 'pending_review') continue
    map.set(item.id, item)
  }
  return [...map.values()]
}


//# sourceURL=source/memory-local/src/index.ts