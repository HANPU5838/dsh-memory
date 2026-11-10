/**
 * 可疑写入隔离（cognitive/guard）—— P4 投毒 / 注入内容的轻量防护。
 *
 * 记忆库是"会被模型反复读回去的持久上下文"：一条带指令注入的自动记忆可以在之后
 * 每次注入时劫持模型行为（prompt injection）；一条泄漏的 API key 会跟着明文 JSONL
 * 一起被备份/导出。本模块在**写入前后**做一层轻量检查：
 *
 *   scanMemoryContent(content, {source})  纯函数 → { risk, reasons, quarantined }
 *   quarantineRecord(store, id, reasons)  落盘 → 给记录打 quarantinedAt/quarantineReasons
 *   clearQuarantine(store, id)            复核通过后解除隔离
 *
 * 检测项（可解释，每条都带 kind / 中文说明 / 权重）：
 *   instruction-injection  指令注入（中英："忽略之前所有指令" / "ignore previous instructions"
 *                          / 你现在是 / system prompt / 角色标记 …）
 *   credential             可疑凭据（复用 secrets.ts 的密钥形状 + JWT / Authorization /
 *                          中文"密码是…"）
 *   extreme-length         极端长文本（默认 > 8000 字，容易是灌库 / 挤占上下文）
 *   hidden-characters      零宽 / 双向控制字符（用于藏指令，单独命中即 medium）
 *   control-characters     不可见控制字符（除换行/制表符）
 *
 * 风险分 = 命中项权重之和（封顶 1）：≥ high(0.7) → high；≥ medium(0.35) → medium；否则 low。
 * 隔离建议 quarantined 的判定：
 *   - risk === 'high'（任何来源）；或
 *   - 命中指令注入 **且** 来源不可信（auto / agent / subagent，即模型自动写入的内容）。
 * 用户显式写入（origin=explicit/user）的注入文本只报 medium，不自动隔离 —— 用户有权
 * 存一段 prompt，隔离面板留给人复核。
 *
 * 隔离字段已在 store.ts 的 CognitiveFields 里（Lead 已加）：quarantinedAt / quarantineReasons；
 * lifecycle.recordInvisibility 默认把隔离记录当不可见（检索/注入跳过，面板 includeQuarantined 可查）。
 */
import {
  isQuarantinedRecord,
                       
                    
                   
} from '../store.js'
import { scanSecrets } from '../secrets.js'

// ---------------------------------------------------------------- 常量

/** 极端长文本阈值（字符数）：超过它按"可疑灌库"处理。 */
export const MAX_CONTENT_CHARS = 8_000
/** 风险分达到它就判 high。 */
export const RISK_HIGH_THRESHOLD = 0.7
/** 风险分达到它就判 medium。 */
export const RISK_MEDIUM_THRESHOLD = 0.35

/** 各检测项的权重（命中一次即计入，同项多次命中只算一次）。 */
export const FINDING_WEIGHTS = {
  'instruction-injection': 0.55,
  credential: 0.5,
  'extreme-length': 0.35,
  'hidden-characters': 0.4,
  'control-characters': 0.2,
}         

/** 不可信来源：模型自动采集 / 子代理写入的记忆。 */
export const UNTRUSTED_ORIGINS                    = ['auto', 'agent', 'subagent']

/** 可信来源：用户显式写入。 */
export const TRUSTED_ORIGINS                    = ['user', 'explicit', 'tool']

// ---------------------------------------------------------------- 检测规则

                         
                                    
               
            
 

/**
 * 指令注入模式（中英）。刻意保守：只匹配"改写系统规则 / 冒充角色 / 套系统提示"这类
 * 典型形态，普通叙述里的"忽略之前的偏好"不会命中（偏好不在指令词表里）。
 */
const INJECTION_RULES                           = [
  {
    label: 'ignore-previous',
    re: /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+)?(?:of\s+)?(?:the\s+|your\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?|directives?|context)/i,
  },
  {
    label: 'role-override',
    re: /\b(?:you\s+are\s+now|from\s+now\s+on,?\s+you\s+are|acting\s+as|pretend\s+(?:to\s+be|that\s+you\s+are)|jailbreak|DAN\s+mode)\b/i,
  },
  {
    label: 'system-prompt',
    re: /\b(?:system\s+(?:prompt|message|instructions?)|developer\s+message|hidden\s+rules?)\b/i,
  },
  {
    label: 'role-marker',
    re: /<\|(?:im_start|im_end|system|user|assistant)\|>|\[\s*SYSTEM\s*\]|#{2,}\s*SYSTEM\b/i,
  },
  {
    label: 'override-rules',
    re: /\b(?:override|bypass|disable|circumvent)\s+(?:the\s+|all\s+)?(?:safety|security|policy|policies|rules|guardrails?|filters?)/i,
  },
  {
    label: 'exfiltrate-prompt',
    re: /\b(?:print|reveal|show|output|repeat)\s+(?:your\s+|the\s+)?(?:system\s+prompt|hidden\s+instructions|initial\s+prompt)/i,
  },
  { label: 'ignore-previous-zh', re: /(?:忽略|无视|忘记|忘掉|抛开|跳过)(?:掉)?(?:之前|以上|前面|先前|此前)?(?:的)?(?:所有|全部)?(?:指令|规则|提示词|要求|设定|限制)/ },
  { label: 'role-override-zh', re: /(?:你现在是|从现在开始(?:你)?是|从现在起你是|假装你是|扮演(?:一个|一下)?(?:角色|助手|管理员)|你不再是|越狱模式|开发者模式)/ },
  { label: 'system-prompt-zh', re: /(?:系统提示词?|系统指令|系统消息|开发者消息|隐藏规则)/ },
  { label: 'override-rules-zh', re: /(?:绕过|无视|关闭|禁用)(?:掉)?(?:安全|审核|安全策略|安全限制|过滤器|防护)/ },
  { label: 'exfiltrate-prompt-zh', re: /(?:输出|泄露|告诉我|打印|展示|重复)(?:你的|系统)(?:系统提示词?|提示词|指令|隐藏规则)/ },
]

/** 额外凭据形态（secrets.ts 已覆盖常见云厂商 key / 私钥 / Bearer，这里补 JWT 与中文写法）。 */
                          
              
            
 

const EXTRA_CREDENTIAL_RULES                            = [
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: 'authorization-header', re: /\bauthorization\s*:\s*(?:bearer|basic|token)\s+\S{8,}/gi },
  { kind: 'credential-assignment-zh', re: /(?:密码|口令|私钥|密钥|令牌|api\s*密钥)\s*(?:是|为|[:：=])\s*\S{6,}/gi },
]

const HIDDEN_CHAR_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/

// ---------------------------------------------------------------- 类型

                                                 

/** 一条命中项。 */
                               
                                    
                                     
                
                
                                
                  
 

/** scanMemoryContent 的入参。 */
                               
                                                                     
                                                                            
                                            
                   
                                        
                                                 
                                                        
                                        
 

                              
                 
                               
               
                                
                   
                                       
                      
                          
                                    
                  
                                       
                 
 

                                    
                                 
              
 

// ---------------------------------------------------------------- 工具函数

/** 从 GuardOptions.source 里取 origin 字符串。 */
function originOf(source                        )                     {
  if (source === undefined || source === null) return undefined
  if (typeof source === 'string') return source !== '' ? source : undefined
  const origin = (source                        ).origin
  return typeof origin === 'string' && origin !== '' ? origin : undefined
}

/** 命中的注入规则名（去重、保序）。 */
function injectionLabels(content        )           {
  const labels           = []
  for (const rule of INJECTION_RULES) {
    rule.re.lastIndex = 0
    if (rule.re.test(content) && !labels.includes(rule.label)) labels.push(rule.label)
  }
  return labels
}

/** 命中的凭据种类（secrets.ts 的规则 + 本模块补充规则；只回种类，不回原文）。 */
function credentialKinds(content        )           {
  const kinds           = []
  for (const finding of scanSecrets(content)) {
    if (!kinds.includes(finding.kind)) kinds.push(finding.kind)
  }
  for (const rule of EXTRA_CREDENTIAL_RULES) {
    rule.re.lastIndex = 0
    if (rule.re.test(content) && !kinds.includes(rule.kind)) kinds.push(rule.kind)
  }
  return kinds
}

/** 风险分 → 等级。 */
function riskLevel(score        , medium        , high        )            {
  if (score >= high) return 'high'
  if (score >= medium) return 'medium'
  return 'low'
}

// ---------------------------------------------------------------- 纯函数：扫描

/**
 * 扫描一段待写入记忆的正文，给出风险等级 + 原因 + 是否建议隔离。
 *
 * 纯函数：不改入参、不落盘、无副作用；同一输入永远同一结果。
 */
export function scanMemoryContent(content        , options               = {})              {
  const text = typeof content === 'string' ? content : String(content ?? '')
  const origin = originOf(options.source)
  const trusted = origin !== undefined && TRUSTED_ORIGINS.includes(origin)
  const untrusted = origin !== undefined && UNTRUSTED_ORIGINS.includes(origin)
  const maxChars = Math.max(1, Math.floor(options.maxChars ?? MAX_CONTENT_CHARS))
  const medium = Math.min(1, Math.max(0, options.thresholds?.medium ?? RISK_MEDIUM_THRESHOLD))
  const high = Math.min(1, Math.max(medium, options.thresholds?.high ?? RISK_HIGH_THRESHOLD))
  const quarantineUntrustedInjection = options.quarantineUntrustedInjection !== false

  const findings                 = []
  const reasons           = []

  // 1) 指令注入
  const injections = injectionLabels(text)
  if (injections.length > 0) {
    findings.push({
      kind: 'instruction-injection',
      detail: `疑似指令注入：命中 ${injections.length} 条模式（${injections.slice(0, 3).join(', ')}${injections.length > 3 ? '…' : ''}）`,
      weight: FINDING_WEIGHTS['instruction-injection'],
      labels: injections,
    })
    reasons.push(`疑似指令注入（${injections.slice(0, 3).join(', ')}）`)
  }

  // 2) 可疑凭据
  const credentials = credentialKinds(text)
  if (credentials.length > 0) {
    findings.push({
      kind: 'credential',
      detail: `疑似凭据泄漏：命中 ${credentials.length} 类密钥形状（${credentials.slice(0, 3).join(', ')}）`,
      weight: FINDING_WEIGHTS.credential,
      labels: credentials,
    })
    reasons.push(`疑似凭据（${credentials.slice(0, 3).join(', ')}），不应明文入库`)
  }

  // 3) 极端长文本
  if (text.length > maxChars) {
    findings.push({
      kind: 'extreme-length',
      detail: `极端长文本：${text.length} 字 > ${maxChars} 字上限`,
      weight: FINDING_WEIGHTS['extreme-length'],
      labels: [],
    })
    reasons.push(`极端长文本（${text.length} 字，超过 ${maxChars} 字上限）`)
  }

  // 4) 隐藏字符（零宽 / 双向控制，常用来藏指令）
  if (HIDDEN_CHAR_RE.test(text)) {
    findings.push({
      kind: 'hidden-characters',
      detail: '包含零宽 / 双向控制字符（可能用于隐藏指令）',
      weight: FINDING_WEIGHTS['hidden-characters'],
      labels: [],
    })
    reasons.push('包含零宽 / 双向控制字符')
  }

  // 5) 其它不可见控制字符
  if (CONTROL_CHAR_RE.test(text)) {
    findings.push({
      kind: 'control-characters',
      detail: '包含不可见控制字符（正常记忆文本不应出现）',
      weight: FINDING_WEIGHTS['control-characters'],
      labels: [],
    })
    reasons.push('包含不可见控制字符')
  }

  let score = 0
  for (const finding of findings) score += finding.weight
  score = Math.min(1, Math.max(0, score))
  const risk = riskLevel(score, medium, high)
  const quarantined =
    risk === 'high' || (quarantineUntrustedInjection && injections.length > 0 && untrusted)

  return { risk, score, reasons, quarantined, findings, trusted, ...(origin !== undefined ? { origin } : {}) }
}

// ---------------------------------------------------------------- 落盘（唯一写入口）

/**
 * 给一条记录打隔离标记（quarantinedAt / quarantineReasons）。
 *
 * 用 store.updateMetrics 只写这两个字段，其它字段不动；记录保留、可复核、可解除。
 * **不 flush** —— 与 store 其它写路径一致，由调用方 scheduleFlush()/flush()。
 *
 * @returns 找到并写入返回 true；id 不存在 / 未加载返回 false。
 */
export function quarantineRecord(
  store             ,
  id        ,
  reasons                   ,
  options                    = {},
)          {
  if (typeof id !== 'string' || id === '') return false
  const now = options.now ?? Date.now()
  const list = (Array.isArray(reasons) ? reasons : [reasons])
    .map((reason) => String(reason).trim())
    .filter((reason) => reason !== '')
  // 空原因也要留下可解释的标记（面板至少能显示"人工隔离"）。
  const safeReasons = list.length > 0 ? list : ['manual']
  const updated = store.updateMetrics(id, { quarantinedAt: now, quarantineReasons: safeReasons })
  return updated !== undefined
}

/**
 * 解除隔离（人工复核通过后）。清掉 quarantinedAt / quarantineReasons，
 * 记录重新可见。已经不在隔离状态的返回 false（幂等，无写入）。
 */
export function clearQuarantine(store             , id        )          {
  const located = store.scopeOf(id)
  if (located === undefined) return false
  const record = located.record                   
  if (!isQuarantinedRecord(record)) return false
  const next                  = { ...record }
  delete next.quarantinedAt
  delete next.quarantineReasons
  located.store.insert(next)
  return true
}

/**
 * 便捷入口：扫描正文，命中建议隔离时直接给**已存在的记录**打标。
 * 返回扫描结果 + 是否落盘（记录不存在时 scanned.quarantined 可能为 true 但 applied=false）。
 */
export function guardRecord(
  store             ,
  id        ,
  options                                   = {},
)                                            {
  const located = store.scopeOf(id)
  if (located === undefined) {
    return { result: scanMemoryContent('', options), applied: false }
  }
  const record = located.record
  // 没显式给来源时用记录自己的来源（auto/agent 自动写入的注入内容才该被隔离）。
  const source = options.source !== undefined ? options.source : record.source
  const result = scanMemoryContent(record.content, { ...options, source })
  if (!result.quarantined) return { result, applied: false }
  const applied = quarantineRecord(store, id, result.reasons, options)
  return { result, applied }
}


//# sourceURL=source/memory-local/src/cognitive/guard.ts