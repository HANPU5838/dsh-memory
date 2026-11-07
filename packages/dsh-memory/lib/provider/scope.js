/**
 * 作用域(scope)规范 —— 纯函数,无 cordis / 无 fs 依赖。
 *
 * 为什么需要这一层:早先 scope 的解析分散在四个工具、provider、面板与注入里,规则还不一致
 * (`tool-memory/src/index.ts` 的 scopeOr 把**任何**认不出的值静默回退成默认 scope,于是
 * "写到了别的 scope"这种错永远不报);而 provider 自己的默认值又是 `global`,与工具的
 * `project:<cwd>` 不一致 —— 读路径与写路径各说各话。现在只有一个入口:
 *
 *   normalizeScopeInput(raw)   模型/HTTP 传进来的字符串 → 规范化的 scope 或明确错误
 *   resolveCurrentScopes(agent)宿主会话上下文 → 当前会话 / 当前项目两个 key
 *   resolveScopeRef(...)       把上面两者的 kind 落到具体 key(读 / 写两种口径)
 *
 * 保留名与键空间:
 *   global                 所有项目共享(文件 global.jsonl)
 *   project:<cwd>          一个工作区(文件 projects/<sha1>.jsonl)
 *   session:<id>           一个会话(同一个 projects/<sha1>.jsonl 体系)
 *   <自定义名>              自由命名,内部键仍是自定义名本身
 * 三者都由 `scopeFileName()` 映射到文件名,因此**自定义名里出现 ':' 一律拒绝**,否则
 * `foo:bar` 会与保留前缀撞成同一个键空间,用户也能靠它伪造 `project:` 键。唯一的例外
 * 是**展示前缀** `custom:`(0.26.0 起在 normalizeScopeInput 里剥掉一层再校验)——
 * 它只会出现在工具输出 / 摘要 / 面板里,不属于键空间。
 */
import { createHash } from 'node:crypto'
import { posix, win32 } from 'node:path'
import { isCustomScopeKey } from './store.js'

/** 作用域键:除 'global' 外的形态由 resolveCurrentScopes / normalizeScopeInput 产生。 */
                             

                                                                   

/** normalizeScopeInput 的判别结果(scope 为 undefined 表示"未传")。 */
                                  
                                                                 
                                                
                  
 

                                  
                                    
                                                         

/** 自定义名长度上限(码点)。 */
export const MAX_SCOPE_NAME_CHARS = 64
/** project: / session: 前缀值的长度上限(路径与 uuid 都可能很长)。 */
export const MAX_PREFIXED_SCOPE_CHARS = 512

/** 保留名:不能作为自定义 scope,也不允许被自定义名覆盖(一律小写比较)。 */
export const RESERVED_SCOPE_NAMES = new Set(['global', 'project', 'session', 'all'])

const KEBAB = '-'

/** 控制字符(C0 + DEL + C1)一律拒绝:它们能进文件名映射的输入、也能把日志搅烂。 */
function hasControlChar(value        )          {
  for (const char of value) {
    const code = char.codePointAt(0) 
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return true
  }
  return false
}

/**
 * 自定义名允许的字符:Unicode 字母 / 数字(含中文)、空格、'-'、'_'、'.'。
 * 用 `\p{L}\p{N}` 而不是 ASCII 白名单,是因为中文 scope 名("项目笔记")是预期用法;
 * 文件名的歧义由 `scopeFileName()` 的 SHA-1 兜底,这里只负责禁止会造成键空间混淆的字符。
 */
const CUSTOM_NAME_ALLOWED = /^[\p{L}\p{N} _.-]+$/u

/** 码点长度({ length } 会把 emoji 数成 2,K 说"按码点")。 */
function codePointLength(value        )         {
  return [...value].length
}

/**
 * 规范化"自定义名"。
 *   - 内部空白(含制表/换行)折叠为单个空格;
 *   - 转小写(大小写折叠,免出 `Foo` 与 `foo` 两个 scope);
 *   - 长度 1~64 码点;
 *   - 禁止 ':'、路径分隔符、控制字符、'..'、纯点/空格组成的名字、保留名。
 */
function normalizeCustomName(raw        )                                                              {
  const collapsed = raw.replace(/\s+/gu, ' ').trim()
  if (collapsed.length === 0) return { ok: false, message: 'scope name is empty after normalization' }
  if (hasControlChar(collapsed)) return { ok: false, message: 'scope name must not contain control characters' }
  const name = collapsed.toLowerCase()
  if (codePointLength(name) > MAX_SCOPE_NAME_CHARS) {
    return { ok: false, message: `scope name exceeds ${MAX_SCOPE_NAME_CHARS} characters` }
  }
  if (name === '..' || name === '.') return { ok: false, message: "scope name must not be '.' or '..'" }
  if (/^[. ]+$/u.test(name)) return { ok: false, message: 'scope name must contain more than dots and spaces' }
  if (name.includes('..')) return { ok: false, message: "scope name must not contain '..'" }
  if (name.includes(':')) {
    return { ok: false, message: "scope name must not contain ':'; pass the bare scope name (e.g. 'dsh-plugin-dev')" }
  }
  if (name.includes('/') || name.includes('\\')) {
    return { ok: false, message: 'scope name must not contain path separators' }
  }
  if (RESERVED_SCOPE_NAMES.has(name)) {
    // 'global'/'project'/'session' 在到达这里之前已经各自命中保留分支,所以这里实际拦的是 'all'。
    return { ok: false, message: `scope name "${name}" is reserved` }
  }
  if (!CUSTOM_NAME_ALLOWED.test(name)) {
    return { ok: false, message: 'scope name may only contain letters, digits, spaces, "-", "_" and "."' }
  }
  return { ok: true, name }
}

/**
 * 规范化 `project:` / `session:` 前缀值(旧键与宿主键,原样放行以便读写既有数据)。
 * 只做最小清洗:trim、拒绝控制字符、拒绝空、限长 —— 绝不改写内容,否则旧文件再也找不到。
 */
function normalizePrefixed(key        , label                       )                                                             {
  const value = key.slice(`${label}:`.length).trim()
  if (value.length === 0) return { ok: false, message: `${label}: scope requires a non-empty value` }
  if (hasControlChar(value)) return { ok: false, message: `${label}: scope value must not contain control characters` }
  if (codePointLength(key) > MAX_PREFIXED_SCOPE_CHARS) {
    return { ok: false, message: `${label}: scope exceeds ${MAX_PREFIXED_SCOPE_CHARS} characters` }
  }
  return { ok: true, key: `${label}:${value}` }
}

/** 作用域“显示名/别名”的校验:与自定义作用域名同一套规则(保留名也不许用)。 */
export function normalizeScopeName(raw        )                                                              {
  return normalizeCustomName(raw)
}

/**
 * 把模型 / HTTP query 传进来的原始字符串规范化。
 *
 * 关键语义:
 *   - `undefined` / 空串 → `kind: 'current-session'`(调用方按写/读口径决定落到哪里);
 *   - 'global' | 'project' | 'session' → 各自的**种类**,不在这里解析 cwd/会话(纯函数拿不到);
 *   - 'all' | '*' → 跨所有作用域(仅读路径合法,写路径由 assertWritableScope 拒绝);
 *   - 'project:*' | 'session:*' → 原样放行(显式 pin 某个项目 / 某个会话);
 *   - 'custom:*' → 归一成裸名(0.26.0:展示层就是这么渲染自定义作用域的);
 *   - 其余 → 自定义名,严格校验。
 *
 * 不合法**不再静默回退**,一律返回 SCOPE_INVALID。
 */
export function normalizeScopeInput(raw                           )                       {
  // NFC 归一化:同一个中文 scope 从不同输入法过来可能是不同码点序列,不归一化就会分裂成两个 scope。
  const value = typeof raw === 'string' ? raw.normalize('NFC').trim() : ''
  if (value.length === 0) return { ok: true, kind: 'current-session' }
  if (value === '*') return { ok: true, kind: 'all' }
  const lower = value.toLowerCase()
  if (lower === 'global') return { ok: true, kind: 'global', scope: 'global' }
  if (lower === 'project') return { ok: true, kind: 'current-project' }
  if (lower === 'session') return { ok: true, kind: 'current-session' }
  if (lower === 'all') return { ok: true, kind: 'all' }
  if (lower.startsWith('project:')) {
    const prefixed = normalizePrefixed(value, 'project')
    return prefixed.ok
      ? { ok: true, kind: 'project', scope: prefixed.key }
      : { ok: false, code: 'SCOPE_INVALID', message: prefixed.message }
  }
  if (lower.startsWith('session:')) {
    const prefixed = normalizePrefixed(value, 'session')
    return prefixed.ok
      ? { ok: true, kind: 'session', scope: prefixed.key }
      : { ok: false, code: 'SCOPE_INVALID', message: prefixed.message }
  }
  // 展示形式 `custom:<名字>` 归一到裸名(0.26.0)。0.25.10 起工具输出、注入摘要、面板
  // 全部用 `custom:<名字>` 渲染,而自定义作用域的**键本身没有前缀**;模型照抄回来时
  // 不该落到另一个(永远匹配不到记录的)键上。这里只剥一层,剩下的部分仍按自定义名规则
  // 严格校验 —— 所以 `custom:foo:bar` / `custom:` 依然是 SCOPE_INVALID。
  if (lower.startsWith('custom:')) {
    const bare = value.slice('custom:'.length).trim()
    if (bare.length === 0) {
      return { ok: false, code: 'SCOPE_INVALID', message: "custom: must be followed by a scope name (e.g. 'dsh-plugin-dev')" }
    }
    if (RESERVED_SCOPE_NAMES.has(bare.toLowerCase())) {
      return { ok: false, code: 'SCOPE_INVALID', message: `custom: cannot wrap the reserved name "${bare.toLowerCase()}"; use the bare scope name instead` }
    }
    const custom = normalizeCustomName(bare)
    return custom.ok
      ? { ok: true, kind: 'custom', scope: custom.name }
      : { ok: false, code: 'SCOPE_INVALID', message: custom.message }
  }
  const custom = normalizeCustomName(value)
  return custom.ok
    ? { ok: true, kind: 'custom', scope: custom.name }
    : { ok: false, code: 'SCOPE_INVALID', message: custom.message }
}

/**
 * 把"可能是展示形式"的作用域字符串归一到真实键(0.26.0)。
 *
 * 只剥**一层** `custom:`:自定义作用域的键本身没有前缀,`custom:` 是 `scopeDisplayName`
 * 按类型补的展示前缀。用于读既有数据(grants / visibility / 面板旧键)与渲染兜底;
 * 不做存在性检查,也不改 `project:` / `session:` 键。
 */
export function normalizeScopeKey(value        )         {
  const trimmed = value.trim()
  if (!trimmed.toLowerCase().startsWith('custom:')) return trimmed
  const bare = trimmed.slice('custom:'.length).trim()
  return bare === '' ? trimmed : bare
}

/**
 * 形态是否是一个合法的作用域键(不做存在性检查,0.26.0)。
 *
 * 用途:grant 落盘前拒绝"永远匹配不到任何记录"的幽灵键 —— 0.25.x 里
 * `memory_scopes request` 接受过 `custom:dsh-plugin-dev` 并把它原样写进 grants,
 * 结果授权看起来成功、检索时却重新弹审批。`custom:` 展示前缀不算合法键。
 */
export function isWellFormedScopeKey(value        )          {
  if (value === 'global') return true
  if (value.startsWith('project:')) {
    const path = value.slice('project:'.length).trim()
    return path !== '' && !hasControlChar(value) && codePointLength(value) <= MAX_PREFIXED_SCOPE_CHARS
  }
  if (value.startsWith('session:')) {
    const id = value.slice('session:'.length).trim()
    return id !== '' && !hasControlChar(value) && codePointLength(value) <= MAX_PREFIXED_SCOPE_CHARS
  }
  return normalizeCustomName(value).ok
}

/** scope 的种类(用于命名空间 / 阈值 / 排序);未知形态按自定义处理。 */
export function scopeKind(scope          )            {
  if (scope === 'global') return 'global'
  if (scope.startsWith('project:')) return 'project'
  if (scope.startsWith('session:')) return 'session'
  return 'custom'
}

/** 自定义 scope 才计入 scopes.custom.max。 */
export function isCustomScope(scope          )          {
  return isCustomScopeKey(scope)
}

/** 跨 scope 合并排序时的稳定 tie-break:session > project > 自定义 > global。 */
export function scopeTier(scope          )         {
  switch (scopeKind(scope)) {
    case 'session': return 0
    case 'project': return 1
    case 'custom': return 2
    default: return 3
  }
}

/** 会话 id 的展示长度。 */
export const SESSION_SHORT_ID_CHARS = 16

/**
 * 会话 id → 展示用的短 id(前 16 位,如 `session-1a2b3c4d`)。
 *
 * 为什么是 16 而不是 8:DSH 的会话 id 以 `session-` 开头 —— 那正好是 8 个字符。
 * 取前 8 位会让**所有**会话作用域显示成同一个「会话 session-」,等于没给 id。
 * 16 位 = `session-` + 8 位 uuid,既短又能区分。
 */
export function sessionShortId(sessionId        )         {
  return String(sessionId ?? '').slice(0, SESSION_SHORT_ID_CHARS)
}

/**
 * scope 键 → 展示用的**类型前缀**。
 *
 *   global      → `global:`
 *   project:*   → `project:`
 *   session:*   → `session:`
 *   其余(自定义) → `custom:`  —— 自定义 scope 的键**本身没有前缀**(就是一个名字),
 *                 所以这个前缀只能在这里补上;别拿 `scopeKind` 之外的规则去猜。
 */
export function scopeTypePrefix(scope          )         {
  if (scope === 'global') return 'global:'
  if (scope.startsWith('project:')) return 'project:'
  if (scope.startsWith('session:')) return 'session:'
  return 'custom:'
}

/** 没有别名 / 标题时,各类型自己的名字(前缀之后那一段)。 */
export function scopeDefaultName(scope          )         {
  if (scope === 'global') return '全局'
  if (scope.startsWith('project:')) return scope.slice('project:'.length)
  if (scope.startsWith('session:')) return sessionShortId(scope.slice('session:'.length))
  // 兜底:输入侧已把 `custom:<名字>` 归一,但旧数据 / 外部调用仍可能带着它进来,
  // 展示时绝不能叠成 `custom:custom:<名字>`。
  return normalizeScopeKey(String(scope)) || String(scope)
}

/**
 * scope 键 → 展示名,形如 `global:全局` / `project:<cwd>` / `session:session-1a2b3c4d` /
 * `custom:<名字>`。`humanName` 是服务端能拿到的人类可读名(会话标题、项目别名、自定义
 * 作用域的用途名),省略或空串时用类型默认名。
 *
 * 前缀必须由**类型**决定而不是由名字猜:自定义作用域的键天生没有前缀,老代码直接吐
 * 裸名字,在列表里会和 global / project 混在一起分不清种类。
 */
export function scopeDisplayName(scope          , humanName         )         {
  const name = typeof humanName === 'string' && humanName.length > 0 ? humanName : scopeDefaultName(scope)
  return `${scopeTypePrefix(scope)}${name}`
}

/**
 * 0.27.0：内置作用域的**默认用途描述**。scope-meta 里没写过 description 时，
 * 作用域目录（memory_scopes list）用它兜底，让每类作用域条目都带一句
 * 「这个域是干什么的」，而不是统一的「（未填写用途）」。
 * 自定义作用域的用途应该由创建者写（memory_save 的 scopeDescription），
 * 这里只给最通用的说明。
 */
export function defaultScopeDescription(scope          )         {
  if (scope === 'global') return '全局作用域：跨项目共享的通用事实与偏好；适合放与具体仓库无关的长期记忆。'
  if (scope.startsWith('project:')) return '项目作用域：绑定当前工作区路径的共享记忆；同一路径下的所有会话可读写。'
  if (scope.startsWith('session:')) return '会话作用域：仅本会话可见的过程记忆；换会话后经目录发现、不默认读取。'
  return '自定义作用域：按名字聚合的跨会话记忆；创建时建议用 memory_save 的 scopeDescription 写明用途。'
}

/** 写路径遇到只读 scope 时的错误码('all' 不能写)。 */
export const SCOPE_NOT_WRITABLE = 'SCOPE_NOT_WRITABLE'

// ------------------------------------------------------------------ 项目键的路径写法

/** `D:\x` / `D:/x` / `\\server\share` —— 只有这些才按 Windows 语义处理。 */
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\)/u
/** Windows 盘符路径(`D:` 后跟分隔符);UNC 没有盘符,单独判。 */
const DRIVE_PATH = /^[A-Za-z]:[\\/]/u
const POSIX_ABSOLUTE = /^\//u

/**
 * 判断一个路径是否已经是绝对路径，**同时认 POSIX 与 Windows 写法**，不依赖宿主 OS。
 *
 * 为什么不直接用 `node:path` 的 `isAbsolute`：它在 Linux 上不认 `D:/x`，于是
 * `memory_save({ path: 'D:/x' })` 会被当成相对路径拼到 cwd 下，同一个工作区在
 * 不同平台上得到两个 scope 键。
 */
export function isAbsoluteWorkspacePath(value        )          {
  const trimmed = value.trim()
  return WINDOWS_ABSOLUTE.test(trimmed) || POSIX_ABSOLUTE.test(trimmed)
}

/**
 * 项目作用域里的**路径规范形**:同一个目录只允许一种写法。
 *
 * 为什么需要:Windows 上 `D:/repositories/dsh-memory` 与 `D:\repositories\dsh-memory`
 * 是同一个目录,但 `project:<路径>` 是字符串键、落盘文件名是它的 SHA-1 —— 两种写法会
 * 变成两个 scope 文件。用 `memory_save({ path })` 写进去的记忆,同一个工作区里的会话
 * (键来自宿主 `session.header.cwd`,反斜杠形式)再也读不到,而且注入 / 面板里会看到
 * 两个"同名"作用域绝对路径。
 *
 * 只做**绝不可能指向另一个目录**的改写:
 *   - Windows 绝对路径走 `win32.resolve`:分隔符统一成 `\`、消掉 `.`/`..` 与末尾分隔符,
 *     盘符统一大写(`d:\x` → `D:\x`);
 *   - POSIX 绝对路径走 `posix.resolve`(同样消掉 `.`/`..` 与末尾分隔符);
 *   - 非绝对路径**原样返回**(不能拿 process.cwd() 去猜:那是 DSH 的 profile 目录);
 *   - 大小写除盘符外**不动** —— 既有 scope 文件是按原始大小写做 SHA-1 的,擅自小写会让
 *     旧数据"消失"。只是大小写不同的重复键由 `projectScopeIdentity` 识别、由 provider
 *     在发现作用域时合并。
 */
export function canonicalWorkspacePath(value        )         {
  const trimmed = value.trim()
  if (WINDOWS_ABSOLUTE.test(trimmed)) {
    const resolved = win32.resolve(trimmed)
    const driveFixed = DRIVE_PATH.test(resolved)
      ? resolved.replace(/^([a-z]):/u, (_, drive        ) => `${drive.toUpperCase()}:`)
      : resolved
    return stripTrailingSeparators(driveFixed, win32)
  }
  if (POSIX_ABSOLUTE.test(trimmed)) return stripTrailingSeparators(posix.resolve(trimmed), posix)
  return trimmed.replace(/[\\/]+$/u, '') || trimmed
}

function stripTrailingSeparators(path        , impl                             )         {
  // 根(`D:\` / `/`)本身就是一个合法的 scope 路径,不能剥成 `D:`。
  if (path === impl.parse(path).root) return path
  const stripped = path.replace(/[\\/]+$/u, '')
  return stripped === '' ? path : stripped
}

/**
 * 判断两个项目键是否指向"同一个目录":规范形之后,Windows 盘符路径再折叠大小写
 * (Windows 文件系统不区分大小写)。POSIX 路径保留大小写 —— 在 Linux 上
 * `/Users/a` 与 `/users/a` 是两个不同的目录。
 */
export function projectScopeIdentity(path        )         {
  const canonical = canonicalWorkspacePath(path)
  return WINDOWS_ABSOLUTE.test(canonical) ? canonical.toLowerCase() : canonical
}

// ------------------------------------------------------------------ 当前会话 / 当前项目

/** 宿主 agent 上我们真正会碰到的那几个字段(其余一律不碰)。 */
                     
             
                
                                                                                       
   
 

function asString(value         )                     {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

                                
                                             
                    
                                                
                   
 

/**
 * 从宿主的 agent 对象解析出"当前会话 / 当前项目"两个 key。
 *
 *   - sessionId 优先 `agent.session.header.id`,退回 `agent.session.id`;
 *   - **子代理沿用父会话的记忆**:`header.origin === 'subagent'` 且有 `parentSession` 时,
 *     sessionId 取 parentSession(子代理是同一个任务的一部分,不该另起一个记忆作用域);
 *   - cwd 优先 `header.cwd`,退回 `projectScope` 配置,最后 `process.cwd()`;
 *   - 任何字段缺失都只降级、**绝不抛错**(注入路径上抛错会打断整个 agent 循环)。
 */
export function resolveCurrentScopes(agent         , opts                            = {})                {
  let header                                                                                        
  let sessionId                    
  try {
    const session = (agent                         )?.session
    header = session?.header
    sessionId = asString(header?.id) ?? asString(session?.id)
    if (sessionId !== undefined && header?.origin === 'subagent') {
      sessionId = asString(header.parentSession) ?? sessionId
    }
  } catch {
    // 宿主对象形态意外:当作拿不到会话,继续走 project 回退
    sessionId = undefined
  }
  const cwd = asString(header?.cwd)
  // 项目 key 的优先级:**会话 cwd** > 显式配置的 projectScope > process.cwd()。
  // cwd 必须排第一:`session.header.cwd` 是宿主给的"canonical primary workspace",
  // 而 DSH 服务进程的 process.cwd() 是**profile 目录**(~/.dsh/profiles/<name>),
  // 与工作区无关 —— 0.5.5 及以前把 `project:${process.cwd()}` 当成"配置"先传进来,
  // 结果所有项目的项目级记忆都挤进同一个桶,`project:` 这个作用域等于失效。
  // 路径再过一遍 canonicalWorkspacePath:宿主若给出 `D:/x` / 带尾部分隔符的写法,
  // 与 path 参数、显式 project:<路径> 落到同一个 scope(0.11.1)。
  const projectPath = cwd ?? stripProjectPrefix(opts.projectScope) ?? process.cwd()
  const project = `project:${canonicalWorkspacePath(projectPath)}`
  return sessionId !== undefined ? { session: `session:${sessionId}`, project } : { project }
}

/**
 * `project:/x` → `/x`;不是字符串或空串 → undefined(交给下一级回退)。
 *
 * 显式配置按文档写成 `project:/abs/path`(见 tool-memory/cordis.patch.yml),所以拼接前缀前
 * 必须先脱掉已经带上的那一层,否则会得到 `project:project:/x` —— 与配置、与真实落点都对不上。
 */
function stripProjectPrefix(value         )                     {
  const s = asString(value)
  if (s === undefined) return undefined
  return (s.startsWith('project:') ? s.slice('project:'.length) : s) || undefined
}

// ------------------------------------------------------------------ kind → 具体 key

                            
                                   
                    
                  
                   
 

                                      
                                                 
                        
                                                      
                                                 
                       
                    
     
                                                                
                                                                
                                                                 
     
                          
 

                                
                                              
                                                

/**
 * 把 normalizeScopeInput 的结果落到具体 key。
 *
 * 写路径(`mode: 'write'`):
 *   - `undefined`(字段省略)→ defaultScope 口径;'session' 拿不到会话时**回退 project**,不报错;
 *   - 'session' → 同上;'project' → 项目 key;'global' → 'global';
 *   - 'all' / '*' → 明确报错(只读);
 *   - 显式 'session:<id>' → 原样写入(允许显式 pin 某个会话)。
 * 读路径(`mode: 'read'`):
 *   - `undefined` → `scope: undefined`(表示"由调用方决定合并集合",由工具层填三路合并);
 *   - 'session' 拿不到会话 → `scope: undefined`(等价于默认合并集合,而不是报错);
 *   - 'all' → `{ all: true }`。
 */
export function resolveScopeRef(
  input                      ,
  refs           ,
  opts                     ,
)                     {
  if (!input.ok) return { ok: false, code: input.code, message: input.message }
  if (input.kind === 'all') {
    if (opts.mode === 'write') {
      return { ok: false, code: SCOPE_NOT_WRITABLE, message: "scope 'all' is read-only; name one scope to write to" }
    }
    if (opts.allowAll === false) {
      return { ok: false, code: SCOPE_NOT_WRITABLE, message: "scope 'all' is not allowed here; name one scope" }
    }
    return { ok: true, all: true }
  }
  if (input.kind === 'global') return { ok: true, scope: 'global' }
  if (input.kind === 'current-project') return { ok: true, scope: refs.project }
  if (input.kind === 'current-session') {
    // 省略 scope:写路径按会话落点(拿不到会话 / 会话被关 → 回退项目);读路径交给
    // 调用方的合并集合 —— 工具层要的是"会话 + 项目 + global",不是单个 key。
    if (opts.mode === 'write') {
      const current = opts.sessionEnabled === false ? undefined : refs.session
      return { ok: true, scope: writeScopeForDefault(opts.defaultScope, { ...refs, session: current }) }
    }
    return { ok: true }
  }
  if (input.kind === 'session') {
    // 显式 'session:<id>' 原样 pin(开关关掉时由 provider 报 SCOPE_DISABLED);裸 'session'
    // 与省略等价:写按会话(被关则回退项目)、读交给合并集合。
    if (input.scope !== undefined) return { ok: true, scope: input.scope }
    const scope = opts.sessionEnabled === false ? undefined : refs.session
    if (opts.mode === 'write') {
      return { ok: true, scope: writeScopeForDefault(opts.defaultScope, { ...refs, session: scope }) }
    }
    return { ok: true }
  }
  // project / custom:scope 已经在 normalize 阶段确定
  if (input.scope !== undefined) return { ok: true, scope: input.scope }
  return { ok: false, code: 'SCOPE_INVALID', message: 'scope could not be resolved' }
}

/**
 * 写路径的默认口径:model 省略 scope 时按 `tools.defaultScope` 落到哪个 scope。
 * 'session' 拿不到会话 → project(不报错);'global' → global。
 */
export function writeScopeForDefault(
  defaultScope                                              ,
  refs           ,
)           {
  if (defaultScope === 'global') return 'global'
  if (defaultScope === 'project') return refs.project
  return refs.session ?? refs.project
}

// ------------------------------------------------------------------ 文件名与标签

/**
 * 自定义 scope 的稳定短哈希(8 位)。仅用于**展示/调试**;真正的文件名映射仍是
 * `scopeFileName()` 的完整 SHA-1,因此这里不参与任何寻址,不存在撞名风险。
 */
export function scopeShortHash(scope          )         {
  return createHash('sha1').update(scope).digest('hex').slice(0, 8)
}


//# sourceURL=source/memory-local/src/scope.ts