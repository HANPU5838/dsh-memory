/**
 * 记忆图布局持久化:把用户手动拖过的位置 / 转过的视角 / 缩放平移记到 localStorage。
 *
 * 为什么用 localStorage:这个 bundle 里唯一的既有持久化先例就是 localStorage
 * (`dsh-memory:audit-session`),宿主也没有给插件开放的布局存储接口。沿用同一套
 * 机制,不引入新的存储依赖。
 *
 * 数据结构(带版本号,方便以后迁移):
 *
 *   {
 *     version: 1,
 *     scopes:  { "<scope 键>": { x, y, z, rotationX, rotationY, rotationZ } },
 *     records: { "<记忆 id>":  { x, y, z } },
 *     views:   { "2d": { zoom, panX, panY },
 *                "3d": { cameraPosition: [x,y,z], cameraTarget: [x,y,z], zoom } }
 *   }
 *
 * 几条硬规则(决定了下面每个函数为什么这么写):
 *   ① 身份只用**稳定 ID**(作用域键 / 记忆 id),绝不用数组下标 —— 记录增删会让
 *      下标整体错位,存下来的布局会贴到错误的星上。
 *   ② 覆盖层是**稀疏**的:只记用户真的动过的东西。没动过的节点永远走确定性默认
 *      布局,于是「新增一条记忆」不会打乱任何已有位置。
 *   ③ 被筛掉 / 被折叠的节点**保留**它的布局:用户只是暂时看不见它,不是删了。
 *   ④ 「恢复默认」只清覆盖层,随后用确定性布局重新生成 —— 不做别的副作用。
 *   ⑤ 读取要防御:坏 JSON、旧版本、字段类型不对,一律当作「没有覆盖层」,绝不让
 *      面板因为脏数据打不开。
 */

/** localStorage 键名。带包名前缀,避免和同域其它插件撞车。 */
const GRAPH_LAYOUT_KEY = 'dsh-memory:graph-layout'

/** 当前数据结构版本。读到更高版本就放弃(未来版本可能不兼容)。 */
const GRAPH_LAYOUT_VERSION = 1

/** 视图状态里两个模式的键。 */
const GRAPH_MODES = ['2d', '3d']

/** 空的覆盖层(每次返回新对象,调用方可以随便改)。 */
function emptyGraphLayout() {
  return { version: GRAPH_LAYOUT_VERSION, scopes: {}, records: {}, views: {} }
}

/** 拿到 localStorage,拿不到(隐私模式 / 非浏览器环境)就返回 null。 */
function graphStorage() {
  try {
    const store = typeof window !== 'undefined' ? window.localStorage : undefined
    if (!store || typeof store.getItem !== 'function' || typeof store.setItem !== 'function') return null
    return store
  } catch {
    // Safari 隐私模式下访问 localStorage 会直接抛 SecurityError
    return null
  }
}

/** 只保留有限数字,其余一律当 0 —— 坏数据不该把相机或节点送到 NaN。 */
function safeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 三元组清洗:长度不是 3 / 有非数字 → null(表示"这一项无效")。 */
function safeTriple(value) {
  if (!Array.isArray(value) || value.length !== 3) return null
  if (!value.every((item) => typeof item === 'number' && Number.isFinite(item))) return null
  return [value[0], value[1], value[2]]
}

/** 位置对象清洗;完全无效时返回 null,让调用方回落到默认布局。 */
function safePosition(value) {
  if (!value || typeof value !== 'object') return null
  const { x, y, z } = value
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return null
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null
  return { x, y, z }
}

/** 作用域覆盖项清洗:位置与旋转各自独立,缺哪个就补默认值。 */
function safeScopeOverlay(value) {
  if (!value || typeof value !== 'object') return null
  const position = safePosition(value)
  const hasRotation = ['rotationX', 'rotationY', 'rotationZ'].some((key) => key in value)
  if (!position && !hasRotation) return null
  return {
    x: position ? position.x : 0,
    y: position ? position.y : 0,
    z: position ? position.z : 0,
    rotationX: safeNumber(value.rotationX),
    rotationY: safeNumber(value.rotationY),
    rotationZ: safeNumber(value.rotationZ),
  }
}

/** 2D 视图状态清洗。 */
function safeView2D(value) {
  if (!value || typeof value !== 'object') return null
  const zoom = safeNumber(value.zoom)
  return {
    zoom: zoom > 0 ? zoom : 1,
    panX: safeNumber(value.panX),
    panY: safeNumber(value.panY),
  }
}

/** 3D 视图状态清洗。 */
function safeView3D(value) {
  if (!value || typeof value !== 'object') return null
  const zoom = safeNumber(value.zoom)
  return {
    cameraPosition: safeTriple(value.cameraPosition),
    cameraTarget: safeTriple(value.cameraTarget),
    zoom: zoom > 0 ? zoom : 1,
  }
}

/** 读盘:任何异常都退化成空覆盖层,绝不让面板挂掉。 */
function loadGraphLayout() {
  const store = graphStorage()
  if (!store) return emptyGraphLayout()
  let raw = null
  try {
    raw = store.getItem(GRAPH_LAYOUT_KEY)
  } catch {
    return emptyGraphLayout()
  }
  if (typeof raw !== 'string' || raw === '') return emptyGraphLayout()

  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    return emptyGraphLayout()
  }
  if (!parsed || typeof parsed !== 'object') return emptyGraphLayout()
  // 版本比本代码新:可能是降级运行,读不懂就别猜,直接当没有覆盖层。
  if (typeof parsed.version === 'number' && parsed.version > GRAPH_LAYOUT_VERSION) return emptyGraphLayout()

  const layout = emptyGraphLayout()
  if (parsed.scopes && typeof parsed.scopes === 'object') {
    for (const [scope, value] of Object.entries(parsed.scopes)) {
      if (typeof scope !== 'string' || scope === '') continue
      const overlay = safeScopeOverlay(value)
      if (overlay) layout.scopes[scope] = overlay
    }
  }
  if (parsed.records && typeof parsed.records === 'object') {
    for (const [id, value] of Object.entries(parsed.records)) {
      if (typeof id !== 'string' || id === '') continue
      const overlay = safePosition(value)
      if (overlay) layout.records[id] = overlay
    }
  }
  if (parsed.views && typeof parsed.views === 'object') {
    const view2d = safeView2D(parsed.views['2d'])
    if (view2d) layout.views['2d'] = view2d
    const view3d = safeView3D(parsed.views['3d'])
    if (view3d) layout.views['3d'] = view3d
  }
  return layout
}

/** 写盘:配额满 / 被禁用时静默失败 —— 布局存不下来不该影响任何交互。 */
function saveGraphLayout(layout) {
  const store = graphStorage()
  if (!store) return false
  try {
    store.setItem(GRAPH_LAYOUT_KEY, JSON.stringify(layout))
    return true
  } catch {
    return false
  }
}

/**
 * 清掉覆盖层。`mode` 省略 = 全清(「恢复默认布局」);给 '2d' / '3d' 只清该模式的
 * 视图状态(「恢复默认视角」)。
 */
function clearGraphLayout(mode) {
  const current = loadGraphLayout()
  if (mode === '2d' || mode === '3d') {
    const next = { ...current, views: { ...current.views } }
    delete next.views[mode]
    saveGraphLayout(next)
    return next
  }
  const next = emptyGraphLayout()
  saveGraphLayout(next)
  return next
}

/**
 * 不可变地改一项节点位置。返回新覆盖层,方便直接塞进 React state。
 *
 * 只写 `target` 指定的那一层,其它层原样引用 —— React 的浅比较才能正确判断
 * "布局没变,别重渲染"。
 */
function withNodePosition(layout, kind, id, position) {
  const base = layout || emptyGraphLayout()
  if (typeof id !== 'string' || id === '') return base
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) return base
  const rounded = {
    x: Math.round(position.x * 100) / 100,
    y: Math.round(position.y * 100) / 100,
    z: Math.round(position.z * 100) / 100,
  }
  if (kind === 'scope') {
    const previous = base.scopes[id] || { x: 0, y: 0, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0 }
    return { ...base, scopes: { ...base.scopes, [id]: { ...previous, ...rounded } } }
  }
  return { ...base, records: { ...base.records, [id]: rounded } }
}

/** 不可变地改一个作用域的旋转(欧拉角,弧度)。 */
function withScopeRotation(layout, scope, rotation) {
  const base = layout || emptyGraphLayout()
  if (typeof scope !== 'string' || scope === '') return base
  if (!rotation) return base
  const previous = base.scopes[scope] || { x: 0, y: 0, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0 }
  return {
    ...base,
    scopes: {
      ...base.scopes,
      [scope]: {
        ...previous,
        rotationX: safeNumber(rotation.x),
        rotationY: safeNumber(rotation.y),
        rotationZ: safeNumber(rotation.z),
      },
    },
  }
}

/** 不可变地改某个模式的视图状态。 */
function withViewState(layout, mode, view) {
  const base = layout || emptyGraphLayout()
  if (!GRAPH_MODES.includes(mode) || !view || typeof view !== 'object') return base
  return { ...base, views: { ...base.views, [mode]: { ...base.views[mode], ...view } } }
}
