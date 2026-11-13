/**
 * 本机推理端点自动发现（Ollama / LM Studio / llama.cpp / 任意 OpenAI 兼容服务）。
 *
 * 为什么需要它：目标环境里很可能已经跑着给别的工具用的向量服务（Ollama、LM Studio、
 * 手工起的 llama-server……），再下载一份 400MB 运行时纯属浪费。正确做法是：
 * 先找现成的 → 用「同维度」验证它真的能产出当前模型的向量 → 直接采用，零下载。
 *
 * 纪律（全部 best-effort，绝不拖慢/拖垮启动）：
 *  - 只探 127.0.0.1 的常见端口，每个请求超时数百毫秒；
 *  - 任何网络错误都只跳过这一个候选，不抛；
 *  - **维度必须与当前模型一致**：向量空间换了会让语义检索静默错（比不检索更糟），
 *    维度不符宁可不采用；
 *  - 只读，不往别人的服务写任何东西。
 */

/** 发现到的本机端点。 */
                                     
                               
                           
                  
                                                
               
              
                                             
               
 

/** 一个候选端口 + 它的 API 形状。 */
                                    
              
                               
               
                                                       
                    
                 
                   
 

/**
 * 默认探测清单：只收「本机常见且默认端口固定」的几家。
 * 顺序有意义：先 Ollama（embedding 模型最常见），再 LM Studio，再 llama.cpp / 通用。
 */
export const DEFAULT_ENDPOINT_SPECS                               = [
  { port: 11434, provider: 'ollama', label: 'Ollama', modelsPath: '/api/tags', embedPath: '/api/embeddings' },
  { port: 1234, provider: 'openai', label: 'LM Studio', modelsPath: '/v1/models', embedPath: '/v1/embeddings' },
  { port: 8080, provider: 'openai', label: 'llama.cpp (8080)', modelsPath: '/v1/models', embedPath: '/v1/embeddings' },
  { port: 8000, provider: 'openai', label: 'OpenAI 兼容服务 (8000)', modelsPath: '/v1/models', embedPath: '/v1/embeddings' },
]

                                  
                              
                      
                                                           
                    
                          
                                                   
                    
                                      
 

/** 像 embedding 模型的模型名启发式（大小写不敏感）。 */
const EMBEDDING_MODEL_HINT = /embed|bge|nomic|e5|gte|jina|voyage|qwen3-embedding|text-embedding/iu

/** 带超时的 fetch：超时/网络错都返回 null，绝不抛。 */
async function fetchWithTimeout(
  impl              ,
  url        ,
  init             ,
  timeoutMs        ,
)                           {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    return await impl(url, { ...init, signal: controller.signal })
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 从 OpenAI / Ollama 两种模型清单里取出模型名数组。 */
function modelNames(provider                     , body         )           {
  const record = body                                        
  const list = provider === 'ollama' ? record.models : record.data
  if (!Array.isArray(list)) return []
  const names           = []
  for (const item of list) {
    const entry = item                                    
    const name = typeof entry.id === 'string' ? entry.id : typeof entry.name === 'string' ? entry.name : ''
    if (name !== '') names.push(name)
  }
  return names
}

/**
 * 在候选模型里挑一个：优先与当前配置的模型名一致（允许 `:latest` 之类后缀），
 * 其次挑名字像 embedding 模型的，最后退回第一个。
 */
export function pickEmbeddingModel(names                   , hint                    )                {
  if (names.length === 0) return null
  const wanted = (hint ?? '').trim().toLowerCase()
  if (wanted !== '') {
    const exact = names.find((name) => name.toLowerCase() === wanted)
    if (exact !== undefined) return exact
    const prefixed = names.find((name) => name.toLowerCase().startsWith(`${wanted}:`) || name.toLowerCase().startsWith(`${wanted}-`))
    if (prefixed !== undefined) return prefixed
  }
  const embeddingish = names.find((name) => EMBEDDING_MODEL_HINT.test(name))
  return embeddingish ?? names[0] ?? null
}

/** 一次向量的请求体：OpenAI 用 input，Ollama 用 prompt。 */
function embedRequest(provider                     , model        )                   {
  return {
    body: JSON.stringify(provider === 'ollama' ? { model, prompt: 'ping' } : { model, input: 'ping' }),
  }
}

/** 两家响应里取 embedding 数组。 */
function embeddingOf(provider                     , body         )                  {
  const record = body                                           
  if (provider === 'ollama') {
    return Array.isArray(record.embedding) ? (record.embedding            ) : null
  }
  const first = Array.isArray(record.data) ? (record.data[0]                                       ) : undefined
  return Array.isArray(first?.embedding) ? (first?.embedding            ) : null
}

/** 探测单个候选：列模型 → 挑 embedding 模型 → 真算一次向量 → 校验维度。 */
async function probeOne(spec                   , options                 )                                     {
  const base = `http://127.0.0.1:${spec.port}`
  const impl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 600
  const listRes = await fetchWithTimeout(impl, `${base}${spec.modelsPath}`, { method: 'GET' }, timeoutMs)
  if (listRes === null || !listRes.ok) return null
  let listed         
  try {
    listed = await listRes.json()
  } catch {
    return null
  }
  const model = pickEmbeddingModel(modelNames(spec.provider, listed), options.modelHint)
  if (model === null) return null
  const request = embedRequest(spec.provider, model)
  const embedRes = await fetchWithTimeout(impl, `${base}${spec.embedPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: request.body,
  }, timeoutMs)
  if (embedRes === null || !embedRes.ok) return null
  let embedded         
  try {
    embedded = await embedRes.json()
  } catch {
    return null
  }
  const vector = embeddingOf(spec.provider, embedded)
  if (vector === null || vector.length !== options.expectedDims) return null
  return {
    provider: spec.provider,
    endpoint: `${base}${spec.embedPath}`,
    model,
    dims: vector.length,
    label: `${spec.label}（127.0.0.1:${spec.port}）`,
  }
}

/**
 * 扫描本机候选端点，返回第一个「能产出当前维度向量」的服务；没有则 null。
 * 全部探测失败也返回 null（绝不抛）。
 */
export async function discoverLocalEndpoint(options                 )                                     {
  for (const spec of options.specs ?? DEFAULT_ENDPOINT_SPECS) {
    try {
      const found = await probeOne(spec, options)
      if (found !== null) return found
    } catch { /* 单个端口异常不影响下一个候选 */ }
  }
  return null
}


//# sourceURL=source/memory-local/src/endpoint-discovery.ts