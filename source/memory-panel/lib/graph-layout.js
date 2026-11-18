/**
 * 记忆图布局(纯函数层,不碰 DOM / 不碰 React / 不碰 Three.js)。
 *
 * 这个分片被 `tools/assemble-client.mjs` 内联进 `client.js` 的 factory 作用域,
 * 所以它可以直接用 `scopeLabel` / `kindMeta` / `kindRank` / `scopeRank` 这些
 * client.js 里的展示助手 —— 它们是同一个词法作用域,不需要 import。
 *
 * 两种渲染器共用这一层的产物:
 *   - 2D 星图:`buildMemoryGraph()` 的 `{x, y}` 平面坐标;
 *   - 3D 星图:`buildMemoryGraph3D()` 在同一份确定性布局上派生真实三维坐标。
 * 两条路径读的是**同一批记录、同一套作用域分组、同一套稳定 ID**,切换视图不会
 * 重新取数、不会重排。
 */

/**
 * 星图布局参数。
 *
 * 「深度」是假的但很有用:每个作用域是一颗星,它的记忆按黄金角铺成同心环,
 * 越靠外的环越暗、越小、越模糊 —— 于是同一团记忆看起来像一颗有体积的球,
 * 而不是一张平铺的散点图。近处清晰可点,远处只提供密度信息。
 */
const GRAPH_METRICS = {
  hubR: 12.5,
  hubPad: 22,
  nodeR: 6.4,
  ring: 15.5,
  hubGap: 30,
  padX: 60,
  padY: 56,
  iterations: 160,
  // 画布宽高比约 2.4:1,簇按椭圆铺开才能吃满横向空间
  ellipseX: 1.45,
  ellipseY: 0.92,
  // 记忆太多时不再继续放大簇半径,否则整张图会大到失去可读性
  maxSpread: 300,
}

/**
 * 视图参数集中在这里,别再散落到组件里写魔法数字。
 *
 * 缩放区间 `0.08 ~ 5` 是产品口径:0.08 让几百个节点的巨型星图也能整张塞进视口,
 * 5 让单个星团放大到能点中相邻的星。滚轮灵敏度按「每像素指数」给,保证任意
 * 起始缩放下的手感一致(线性步长在 0.1 附近会快得离谱、在 4 附近又几乎不动)。
 */
const GRAPH_VIEW = {
  zoomMin: 0.08,
  zoomMax: 5,
  zoomStep: 0.1,
  // 滚轮:deltaY 每 1px 的指数系数;一档滚轮(约 100px)≈ ×1.2
  wheelZoom: 0.0018,
  // 「适应画布」的留白(px)与缩放上下限:旧版就夹在 0.42~1.15,首屏观感别变
  fitPad: 40,
  fitMin: 0.42,
  fitMax: 1.15,
  // 平移限制:以画布尺寸为单位,防止把图拖到彻底找不回来
  panLimit: 3,
  // 3D 相机
  camera: {
    fov: 52,
    near: 1,
    far: 40000,
    distance: 1100,
    minDistance: 90,
    maxDistance: 9000,
  },
  // 3D 交互灵敏度
  orbitSpeed: 0.0075,
  panSpeed: 1.05,
  zoomSpeed: 0.0016,
  // 拖动结束后的惯性衰减(每帧保留比例),越小停得越快
  inertia: 0.92,
  inertiaFloor: 0.02,
}

/** 黄金角:同一套铺展规律在 2D 同心环和 3D 球面上都成立。 */
const GOLDEN_ANGLE = 2.399963229728653

/**
 * 星图布局:纯函数,不碰 DOM。
 *
 * 三步:①作用域按大小铺在圆上,再用确定性的斥力松弛避免簇重叠;
 * ②簇内记忆按黄金角(2.39996 rad)铺成同心环,天然均匀且无随机;
 * ③把包围盒平移进画布坐标。
 */
function buildMemoryGraph(records, options = {}) {
  const M = GRAPH_METRICS
  const labels = options.labels || {}
  const collapsed = options.collapsed instanceof Set ? options.collapsed : new Set(options.collapsed || [])
  const activeKinds = options.activeKinds instanceof Set ? options.activeKinds : new Set(KIND_ORDER)
  const scopeFilter = typeof options.scopeFilter === 'string' ? options.scopeFilter : ''
  const query = String(options.query ?? '').trim().toLowerCase()

  const byScope = new Map()
  for (const rec of records) {
    if (!activeKinds.has(rec.kind)) continue
    if (scopeFilter !== '' && rec.scope !== scopeFilter) continue
    let list = byScope.get(rec.scope)
    if (list === undefined) { list = []; byScope.set(rec.scope, list) }
    list.push(rec)
  }

  const clusters = []
  for (const [scope, list] of byScope) {
    list.sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || (b.updatedAt || 0) - (a.updatedAt || 0))
    const count = list.length
    const hubRadius = M.hubR + Math.min(7, Math.sqrt(count) * 1.5)
    const open = !collapsed.has(`scope:${scope}`)
    const spread = open
      ? Math.min(M.maxSpread, hubRadius + M.hubPad + M.ring * Math.sqrt(Math.max(0, count - 1) + 0.45))
      : 0
    clusters.push({ scope, label: scopeLabel(scope, labels), records: list, count, hubRadius, spread, open })
  }
  clusters.sort((a, b) => scopeRank(a.scope) - scopeRank(b.scope) || a.label.localeCompare(b.label, 'zh'))

  const total = clusters.reduce((sum, c) => sum + c.count, 0)
  let ringSum = 0
  for (const cluster of clusters) ringSum += cluster.spread * 2 + M.hubGap
  const baseRadius = Math.max(84, ringSum / (Math.PI * 2))
  // 画布是宽幅的(约 2.4:1),簇按椭圆铺开才能吃满横向空间;圆形布局会
  // 被高度卡住,整张图被迫缩到 70% 以下。
  clusters.forEach((cluster, index) => {
    const angle = -Math.PI / 2 + (index / Math.max(1, clusters.length)) * Math.PI * 2
    cluster.x = Math.cos(angle) * baseRadius * M.ellipseX
    cluster.y = Math.sin(angle) * baseRadius * M.ellipseY
  })

  // 斥力松弛:簇半径差别大时均分角度会让小簇被大簇压住。
  // 全程无随机量,同样的输入永远得到同样的星图(测试与截图都靠这点)。
  const separate = (iterations) => {
    for (let iter = 0; iter < iterations; iter++) {
      for (let i = 0; i < clusters.length; i++) {
        for (let j = i + 1; j < clusters.length; j++) {
          const a = clusters[i]
          const b = clusters[j]
          let dx = b.x - a.x
          let dy = b.y - a.y
          let dist = Math.sqrt(dx * dx + dy * dy)
          const min = a.spread + b.spread + M.hubGap
          if (dist < 0.0001) { dx = 0.6; dy = 0.6; dist = 0.85 }
          if (dist >= min) continue
          const push = ((min - dist) / dist) / 2
          a.x -= dx * push
          a.y -= dy * push
          b.x += dx * push
          b.y += dy * push
        }
      }
    }
  }
  separate(M.iterations)

  // 收尾:松弛后仍可能有簇挨在一起(簇多、角度均匀时必然如此)。整体按最大
  // 重叠比例外扩,直到每对簇都留出间隙 —— 比继续迭代更稳,也不会破坏相对方位。
  for (let pass = 0; pass < 24; pass++) {
    let worst = 1
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const a = clusters[i]
        const b = clusters[j]
        const dist = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2)
        const min = a.spread + b.spread + M.hubGap
        if (dist >= min) continue
        worst = Math.max(worst, dist < 0.5 ? 2.2 : min / dist)
      }
    }
    if (worst <= 1.004) break
    const grow = Math.min(worst, 1.6)
    for (const cluster of clusters) { cluster.x *= grow; cluster.y *= grow }
  }

  const nodes = []
  const nodeByKey = new Map()
  const edges = []
  const corrections = []
  const addNode = (node) => { nodes.push(node); nodeByKey.set(node.key, node) }

  let visibleRecords = 0
  for (const cluster of clusters) {
    const hubKey = `scope:${cluster.scope}`
    addNode({
      key: hubKey, type: 'scope',
      scope: cluster.scope, label: cluster.label, count: cluster.count,
      x: cluster.x, y: cluster.y, r: cluster.hubRadius, z: 0, open: cluster.open,
    })
    if (!cluster.open) continue
    const maxRing = Math.sqrt(Math.max(1, cluster.records.length - 1) + 0.45)
    cluster.records.forEach((rec, index) => {
      const ring = Math.sqrt(index + 0.45)
      const angle = index * GOLDEN_ANGLE
      const radius = cluster.hubRadius + M.hubPad + M.ring * ring
      const z = Math.max(0, Math.min(1, ring / maxRing))
      const node = {
        key: `record:${rec.id}`, type: 'record', rec,
        scope: rec.scope, kind: rec.kind,
        x: cluster.x + Math.cos(angle) * radius,
        y: cluster.y + Math.sin(angle) * radius,
        r: M.nodeR * (1.42 - 0.62 * z), z,
        // 常显标签沿半径朝外放,靠角度决定挂在圆点的哪一侧
        angle, radius,
      }
      addNode(node)
      edges.push({
        key: `${hubKey}>${node.key}`, type: 'member',
        fromKey: hubKey, toKey: node.key, toType: 'record', toId: rec.id, hubKey,
      })
      visibleRecords += 1
    })
  }

  // 修正关系:两端都在图上时才画,和记忆树同一口径。
  for (const node of nodes) {
    if (node.type !== 'record') continue
    const rec = node.rec
    if (!rec.supersedes) continue
    const oldKey = `record:${rec.supersedes}`
    if (!nodeByKey.has(oldKey)) continue
    corrections.push({
      key: `corr:${rec.id}>${rec.supersedes}`,
      fromKey: node.key, toKey: oldKey, fromId: rec.id, toId: rec.supersedes,
    })
  }

  const matches = new Set()
  if (query !== '') {
    for (const node of nodes) {
      if (node.type !== 'record') continue
      const rec = node.rec
      const haystack = [
        rec.content, rec.kind, kindMeta(rec.kind).label,
        (rec.tags || []).join(' '), node.scope, scopeLabel(node.scope, labels),
      ].join(' ').toLowerCase()
      if (haystack.includes(query)) matches.add(rec.id)
    }
  }

  // 平移进画布:包围盒含节点半径,外加一圈留给悬停标签。
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const node of nodes) {
    const room = node.type === 'scope' ? node.r + 8 : node.r + 4
    minX = Math.min(minX, node.x - room)
    maxX = Math.max(maxX, node.x + room)
    minY = Math.min(minY, node.y - room)
    maxY = Math.max(maxY, node.y + room)
  }
  if (nodes.length === 0) { minX = 0; minY = 0; maxX = 0; maxY = 0 }
  const shiftX = M.padX - minX
  const shiftY = M.padY - minY
  for (const node of nodes) { node.x += shiftX; node.y += shiftY }
  for (const edge of edges) {
    const from = nodeByKey.get(edge.fromKey)
    const to = nodeByKey.get(edge.toKey)
    if (from && to) { edge.x1 = from.x; edge.y1 = from.y; edge.x2 = to.x; edge.y2 = to.y }
  }
  for (const edge of corrections) {
    const from = nodeByKey.get(edge.fromKey)
    const to = nodeByKey.get(edge.toKey)
    if (from && to) { edge.x1 = from.x; edge.y1 = from.y; edge.x2 = to.x; edge.y2 = to.y }
  }

  const visibleKinds = new Set()
  for (const node of nodes) if (node.type === 'record') visibleKinds.add(node.kind)
  // 每个星团的真实外沿(最远记忆到星心的距离):画成轨道环,让"团"有边界。
  // 平移对距离无影响,所以这里直接用最终坐标算。
  for (const node of nodes) {
    if (node.type !== 'scope') continue
    let far = 0
    for (const other of nodes) {
      if (other.type !== 'record' || other.scope !== node.scope) continue
      far = Math.max(far, Math.sqrt((other.x - node.x) ** 2 + (other.y - node.y) ** 2))
    }
    node.orbit = far > 0 ? far + M.nodeR * 1.8 : 0
  }
  const width = Math.max(240, maxX - minX + M.padX * 2)
  const height = Math.max(200, maxY - minY + M.padY * 2)

  return {
    nodes, edges, corrections, nodeByKey, matches,
    width, height,
    counts: {
      records: visibleRecords,
      scopes: clusters.length,
      kinds: visibleKinds.size,
      corrections: corrections.length,
      total,
    },
  }
}

/** 星图连线:轻微外凸的二次曲线,比直线更像"星云"里的引力线。 */
function graphLinkPath(x1, y1, x2, y2) {
  const dx = x2 - x1
  const dy = y2 - y1
  const len = Math.sqrt(dx * dx + dy * dy) || 1
  const bend = Math.min(18, len * 0.13)
  const cx = (x1 + x2) / 2 - (dy / len) * bend
  const cy = (y1 + y2) / 2 + (dx / len) * bend
  return `M${x1},${y1} Q${cx},${cy} ${x2},${y2}`
}

/**
 * 把 2D 布局派生成立体星图:纯函数,同样的输入永远得到同样的三维坐标。
 *
 * 为什么不在三维里重跑一遍力导向:
 *   ① 2D 的簇间斥力已经解出了「互不重叠」的平面分布,直接当三维的 x/y 用,
 *      再叠一个确定性 z 位移,三维距离只会比平面距离更大 —— 重叠问题不会变差;
 *   ② 两套布局各自独立跑会出现「切视图时星团整个跳位」,而产品要求切换不重排;
 *   ③ 记忆星在簇内改用**黄金角球面螺旋**(而不是平面同心环),于是同一批数据
 *      在三维里是真正的球状星团 —— 有前后遮挡、有体积感,而不是一张立起来的饼。
 *
 * @param {ReturnType<typeof buildMemoryGraph>} graph 2D 布局产物。
 * @param {{ overlay?: object|null, metrics?: object }} [options]
 *   overlay 是用户手动拖拽的覆盖层(见 graph-layout-storage.js),按稳定 ID 取值;
 *   缺失的节点回落到确定性默认位置。
 */
function buildMemoryGraph3D(graph, options = {}) {
  const M = GRAPH_METRICS
  const overlay = options.overlay && typeof options.overlay === 'object' ? options.overlay : {}
  const scopeOverlay = overlay.scopes && typeof overlay.scopes === 'object' ? overlay.scopes : {}
  const recordOverlay = overlay.records && typeof overlay.records === 'object' ? overlay.records : {}

  const scopes = []
  const records = []
  const nodeByKey = new Map()
  const links = []
  const matches = new Set(graph.matches)

  // 把平面画布中心搬到三维原点:相机绕原点转,整张图才是「在眼前」而不是「在脚边」。
  const cx = graph.width / 2
  const cy = graph.height / 2
  // z 振幅按图的尺度给:小图别摊太散,大图别挤成一张纸。
  const zAmplitude = Math.max(70, Math.min(260, Math.min(graph.width, graph.height) * 0.32))

  const scopeNodes = graph.nodes.filter((node) => node.type === 'scope')
  scopeNodes.forEach((node, index) => {
    const stored = scopeOverlay[node.scope]
    const fallback = {
      x: node.x - cx,
      // 三维里 y 轴向上为正,平面 y 向下为正 —— 翻一下符号,否则整张图会上下颠倒
      y: -(node.y - cy),
      z: Math.cos(index * GOLDEN_ANGLE) * zAmplitude,
    }
    const position = pickPosition(stored, fallback)
    const rotation = pickRotation(stored)
    const entry = {
      key: node.key,
      type: 'scope',
      scope: node.scope,
      label: node.label,
      count: node.count,
      open: node.open,
      r: node.r,
      position,
      rotation,
      // 轨道半径先给 0,等星全部落位后按最远那颗算(和 2D 的 orbit 同一口径)
      orbit: 0,
      members: [],
    }
    scopes.push(entry)
    nodeByKey.set(entry.key, entry)
  })

  // 每个作用域下的可见记忆数:球面螺旋的纬度步长要用。先数一遍,别在循环里重数。
  const scopeSizes = new Map()
  for (const node of graph.nodes) {
    if (node.type !== 'record') continue
    scopeSizes.set(node.scope, (scopeSizes.get(node.scope) || 0) + 1)
  }

  for (const node of graph.nodes) {
    if (node.type !== 'record') continue
    const hub = nodeByKey.get(`scope:${node.scope}`)
    if (!hub) continue
    const index = hub.members.length
    const rec = node.rec
    const stored = recordOverlay[rec.id]
    // 簇内球面螺旋:极角按黄金角递进,纬度按序号均匀铺满,半径随环号增长。
    // 三项都只依赖 index,没有任何随机量。
    const ring = Math.sqrt(index + 0.45)
    const radius = M.hubR + M.hubPad + M.ring * ring
    const n = Math.max(1, scopeSizes.get(node.scope) || 1)
    const latitude = 1 - (2 * (index + 0.5)) / n
    const ringRadius = Math.sqrt(Math.max(0, 1 - latitude * latitude))
    const theta = index * GOLDEN_ANGLE
    const fallback = {
      x: hub.position.x + Math.cos(theta) * ringRadius * radius,
      y: hub.position.y + latitude * radius,
      z: hub.position.z + Math.sin(theta) * ringRadius * radius,
    }
    const position = pickPosition(stored, fallback)
    const depth = Math.max(0, Math.min(1, ring / Math.max(1, Math.sqrt(Math.max(1, n - 1) + 0.45))))
    const entry = {
      key: node.key,
      type: 'record',
      id: rec.id,
      rec,
      scope: rec.scope,
      kind: rec.kind,
      // 远近:0 最靠近星心(亮、大),1 最外圈(暗、小)。渲染器据此调材质。
      depth,
      r: M.nodeR * (1.42 - 0.62 * depth),
      position,
      hubKey: hub.key,
    }
    records.push(entry)
    nodeByKey.set(entry.key, entry)
    // 注意:members 里放的是**三维条目**,不是 2D 节点 —— 渲染器要读 position。
    hub.members.push(entry)
  }

  // 轨道半径:取簇内星到星心的最大距离 —— 圆环要真的套住所有星,而不是画个装饰圈。
  for (const hub of scopes) {
    let far = 0
    for (const rec of hub.members) {
      far = Math.max(far, Math.hypot(
        rec.position.x - hub.position.x,
        rec.position.y - hub.position.y,
        rec.position.z - hub.position.z,
      ))
    }
    hub.orbit = far > 0 ? far + M.nodeR * 1.8 : hub.r * 1.6
  }

  const pushLink = (link) => {
    const from = nodeByKey.get(link.fromKey)
    const to = nodeByKey.get(link.toKey)
    if (!from || !to) return
    links.push({
      ...link,
      from: from.position,
      to: to.position,
      fromPosition: from.position,
      toPosition: to.position,
    })
  }
  for (const edge of graph.edges) pushLink(edge)
  for (const edge of graph.corrections) pushLink({ ...edge, type: 'correction' })

  // 包围盒:相机取景与「双击聚焦」都要用它,免得每次在渲染器里重算。
  const bounds = {
    minX: Infinity, minY: Infinity, minZ: Infinity,
    maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity,
  }
  for (const hub of scopes) {
    const reach = Math.max(hub.orbit, hub.r * 2)
    bounds.minX = Math.min(bounds.minX, hub.position.x - reach)
    bounds.maxX = Math.max(bounds.maxX, hub.position.x + reach)
    bounds.minY = Math.min(bounds.minY, hub.position.y - reach)
    bounds.maxY = Math.max(bounds.maxY, hub.position.y + reach)
    bounds.minZ = Math.min(bounds.minZ, hub.position.z - reach)
    bounds.maxZ = Math.max(bounds.maxZ, hub.position.z + reach)
  }
  if (scopes.length === 0) {
    bounds.minX = -120; bounds.maxX = 120
    bounds.minY = -120; bounds.maxY = 120
    bounds.minZ = -120; bounds.maxZ = 120
  }
  const radius = Math.max(
    bounds.maxX - bounds.minX,
    bounds.maxY - bounds.minY,
    bounds.maxZ - bounds.minZ,
    240,
  ) / 2

  return {
    scopes, records, links, nodeByKey, matches, bounds,
    radius,
    center: {
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2,
      z: (bounds.minZ + bounds.maxZ) / 2,
    },
    counts: { ...graph.counts, links: links.length },
  }
}

/** 从持久化覆盖层里取一个合法坐标,否则回落到默认位置。 */
function pickPosition(stored, fallback) {
  if (stored && isFiniteNumber(stored.x) && isFiniteNumber(stored.y) && isFiniteNumber(stored.z)) {
    return { x: stored.x, y: stored.y, z: stored.z }
  }
  return fallback
}

/** 从持久化覆盖层里取合法欧拉角(弧度),否则归零。 */
function pickRotation(stored) {
  const read = (value) => (isFiniteNumber(value) ? value : 0)
  return {
    x: read(stored && stored.rotationX),
    y: read(stored && stored.rotationY),
    z: read(stored && stored.rotationZ),
  }
}

/** 有限数字判定:NaN / Infinity / 字符串 / null 全部挡掉,免得坏数据把场景搞崩。 */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}
