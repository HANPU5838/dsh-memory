/**
 * 记忆图 2D 视图状态:平移 + 以鼠标位置为锚点的缩放 + 适应画布。
 *
 * 这一层全是纯函数,不碰 DOM、不碰 React —— 所以它能被单元测试直接覆盖,
 * 也能被 3D 那边的取景逻辑借鉴同一套口径。
 *
 * 坐标系约定(改这里之前先把下面这段看完):
 *
 *   `.graph-canvas` 的布局盒是 `left:50%; top:50%; margin-left:-w/2; margin-top:-h/2`,
 *   也就是画布中心落在 stage 中心。行内 transform 是 `translate(panX,panY) scale(zoom)`,
 *   变换原点 `50% 50%`。于是画布局部点 `(cx,cy)` 的屏幕坐标是:
 *
 *     sx = stageW/2 + panX + (cx - w/2) * zoom
 *     sy = stageH/2 + panY + (cy - h/2) * zoom
 *
 *   panX/panY 因此是**屏幕像素**,与 zoom 无关 —— 拖多少像素就走多少像素,
 *   这正是"跟手"的前提。缩放时改 zoom 会连带缩放 pan 的视觉效果,所以以鼠标
 *   为锚点缩放必须**同时**重算 pan,否则锚点会漂走(这就是下面 anchorZoom 干的事)。
 */

/** 2D 视图状态的默认值。 */
function graph2DDefaultView() {
  return { zoom: 1, panX: 0, panY: 0 }
}

/** 缩放夹取。上下限集中定义在 GRAPH_VIEW,别在组件里再写一遍魔法数字。 */
function graph2DClampZoom(zoom) {
  if (!Number.isFinite(zoom)) return 1
  return Math.max(GRAPH_VIEW.zoomMin, Math.min(GRAPH_VIEW.zoomMax, zoom))
}

/** 平移夹取:以 stage 尺寸为单位,防止把整张图拖到彻底找不回来。 */
function graph2DClampPan(panX, panY, stageWidth, stageHeight) {
  const limitX = Math.max(120, (stageWidth || 0) * GRAPH_VIEW.panLimit)
  const limitY = Math.max(120, (stageHeight || 0) * GRAPH_VIEW.panLimit)
  const clamp = (value, limit) => (Number.isFinite(value) ? Math.max(-limit, Math.min(limit, value)) : 0)
  return { panX: clamp(panX, limitX), panY: clamp(panY, limitY) }
}

/**
 * 以鼠标位置为锚点缩放:缩放前后,鼠标下面那个画布点**留在原地**。
 *
 * 推导(只用 stage 中心做参考,不需要画布宽高):
 *   锚点相对 stage 中心的偏移 `u = a - stageCenter`。
 *   该点对应的画布偏移(以画布中心为原点)是 `(u - pan) / zoom`。
 *   缩放后要让它还落在 `u` 处:`pan' = u - (u - pan) * zoom' / zoom`。
 *
 * @param {{zoom:number,panX:number,panY:number}} view 当前视图状态
 * @param {number} nextZoom 目标缩放(未夹取)
 * @param {{x:number,y:number}} anchor 锚点,stage 坐标系(相对 stage 左上角)
 * @param {{width:number,height:number}} stage stage 的尺寸
 * @returns {{zoom:number,panX:number,panY:number}} 新的视图状态
 */
function graph2DAnchorZoom(view, nextZoom, anchor, stage) {
  const current = view || graph2DDefaultView()
  const zoom = graph2DClampZoom(current.zoom)
  const target = graph2DClampZoom(nextZoom)
  // 已经顶到上下限:什么都不改,免得在边界上抖动
  if (target === zoom) return { zoom: target, panX: current.panX, panY: current.panY }
  const stageWidth = Math.max(1, (stage && stage.width) || 1)
  const stageHeight = Math.max(1, (stage && stage.height) || 1)
  const ux = ((anchor && anchor.x) || 0) - stageWidth / 2
  const uy = ((anchor && anchor.y) || 0) - stageHeight / 2
  const ratio = target / zoom
  const pan = graph2DClampPan(
    ux - (ux - current.panX) * ratio,
    uy - (uy - current.panY) * ratio,
    stageWidth,
    stageHeight,
  )
  return { zoom: target, panX: pan.panX, panY: pan.panY }
}

/**
 * 滚轮 → 缩放。只接管 Ctrl+滚轮(手势表口径),普通滚轮留给宿主页面滚动。
 *
 * 用指数而不是线性步长:同样的"一档滚轮"在 0.1 和 4 的起点上给出相同的
 * 相对变化,手感才一致(线性步长在 0.1 附近会快得离谱)。
 *
 * @param {{zoom:number,panX:number,panY:number}} view
 * @param {number} deltaY 滚轮原始 deltaY(正数向下 = 缩小)
 * @param {{x:number,y:number}} anchor
 * @param {{width:number,height:number}} stage
 */
function graph2DWheelZoom(view, deltaY, anchor, stage) {
  const current = view || graph2DDefaultView()
  const factor = Math.exp(-(deltaY || 0) * GRAPH_VIEW.wheelZoom)
  return graph2DAnchorZoom(current, current.zoom * factor, anchor, stage)
}

/**
 * 按钮缩放(±):以 stage 中心为锚点,按钮点击时没有鼠标位置可依据。
 */
function graph2DStepZoom(view, delta, stage) {
  const current = view || graph2DDefaultView()
  const stageWidth = Math.max(1, (stage && stage.width) || 1)
  const stageHeight = Math.max(1, (stage && stage.height) || 1)
  return graph2DAnchorZoom(
    current,
    current.zoom + delta,
    { x: stageWidth / 2, y: stageHeight / 2 },
    stage,
  )
}

/** 拖动平移:delta 是屏幕像素,直接加到 pan 上(跟手)。 */
function graph2DPan(view, dx, dy, stage) {
  const current = view || graph2DDefaultView()
  const pan = graph2DClampPan(
    current.panX + (dx || 0),
    current.panY + (dy || 0),
    (stage && stage.width) || 0,
    (stage && stage.height) || 0,
  )
  return { zoom: current.zoom, panX: pan.panX, panY: pan.panY }
}

/**
 * 适应画布:同时算 zoom **和** panX/panY。
 *
 * 为什么必须一起算:只改 zoom 时,如果用户之前拖过图,整张图会缩到"画布中心"
 * 而不是"内容中心",看起来就像跑偏了。所以适应 = 缩放到位 + 平移归零
 * (平移归零即内容居中,因为画布中心本来就对齐 stage 中心)。
 *
 * 缩放夹在 GRAPH_VIEW.fitMin~fitMax:旧版首屏就是 0.42~1.15,观感别变。
 * 图比视口小很多时不放大到撑满,留一点呼吸感(上限 1.15)。
 *
 * @param {{width:number,height:number}} graph 图的逻辑尺寸
 * @param {{width:number,height:number}} stage stage 尺寸
 */
function graph2DFitView(graph, stage) {
  const width = graph && graph.width > 0 ? graph.width : 0
  const height = graph && graph.height > 0 ? graph.height : 0
  const stageWidth = Math.max(1, (stage && stage.width) || 1)
  const stageHeight = Math.max(1, (stage && stage.height) || 1)
  if (width <= 0 || height <= 0) return graph2DDefaultView()
  const pad = GRAPH_VIEW.fitPad
  const raw = Math.min(
    (stageWidth - pad) / width,
    (stageHeight - pad) / height,
  )
  const zoom = Math.max(GRAPH_VIEW.fitMin, Math.min(GRAPH_VIEW.fitMax, raw))
  return {
    zoom: Math.round(zoom * 100) / 100,
    panX: 0,
    panY: 0,
  }
}

/** 视图状态是否等价(避免无意义的 setState 触发重渲染)。 */
function graph2DSameView(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  return Math.abs(a.zoom - b.zoom) < 0.0005
    && Math.abs(a.panX - b.panX) < 0.5
    && Math.abs(a.panY - b.panY) < 0.5
}

/** 生成 `.graph-canvas` 的行内 transform。平移在前、缩放在后 → pan 是屏幕像素。 */
function graph2DTransform(view) {
  const zoom = graph2DClampZoom((view && view.zoom) ?? 1)
  const panX = Number.isFinite(view && view.panX) ? view.panX : 0
  const panY = Number.isFinite(view && view.panY) ? view.panY : 0
  // 小数位收一下,免得每帧都生成一长串浮点数字符串
  return `translate(${panX.toFixed(1)}px, ${panY.toFixed(1)}px) scale(${zoom.toFixed(4)})`
}

/**
 * 把事件坐标换算成 stage 局部坐标。
 * 拖动与锚点缩放都要它,单独拎出来免得两处算法漂移。
 */
function graph2DPointerInStage(event, element) {
  const rect = element && typeof element.getBoundingClientRect === 'function'
    ? element.getBoundingClientRect()
    : { left: 0, top: 0 }
  return {
    x: (event && event.clientX ? event.clientX : 0) - rect.left,
    y: (event && event.clientY ? event.clientY : 0) - rect.top,
  }
}
