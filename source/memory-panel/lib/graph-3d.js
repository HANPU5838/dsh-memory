/**
 * 记忆图 3D 渲染器(Three.js)。
 *
 * 这个分片由 `tools/assemble-client.mjs` 内联进 `client.js` 的 factory 作用域,
 * 因此它能直接用 `kindMeta()` / `excerpt()` / `GRAPH_METRICS` / `GRAPH_VIEW` /
 * `buildMemoryGraph3D()` 这些同作用域的东西,不需要 import。
 *
 * 三个设计决定值得先说清楚:
 *
 * ① **Three.js 走懒加载**。宿主只给包一个同步 client 入口,three 那 2.5MB 只能作为
 *    `client.three.js` chunk 由 `require.async` 按需拉。所以本文件顶层绝不碰 three ——
 *    第一次真的切到 3D 才加载。只用树视图 / 2D 星图的用户完全不会下载它。
 *
 * ② **布局与渲染彻底分离**。三维坐标全部来自 `buildMemoryGraph3D()`(纯函数),
 *    本文件只负责把它们画出来、并把用户的拖拽结果通过回调交回去。所以刷新页面、
 *    切换视图、筛选变化都不会让星星"跳位"。
 *
 * ③ **交互按手势表分工**(见 docs/memory-graph-update.md §八):
 *    空白左拖 = 平移、Space+左拖 = 转视角、拖轨道 = 只转该作用域、
 *    拖中心球 = 移动整个作用域、拖星星 = 移动该节点、
 *    Ctrl+滚轮 = 缩放、双击星星 = 聚焦、单击星星 = 选中并开详情。
 *
 * 拾取一律走 Raycaster + 三维拖动平面,绝不把屏幕像素直接当世界坐标用。
 *
 * 关于 InstancedMesh 的一个坑:几十颗星共用**一个** Mesh,所以 `object.position`
 * 指的是整团的位置,不是单颗星的位置。因此每个节点都单独记 `local` 坐标,
 * 世界坐标由 `group.matrixWorld` 现算 —— 标签、连线、聚焦、拖动全都走这一条路。
 */

/** 3D chunk 的相对路径。必须匹配宿主 `CLIENT_CHUNK`(`client.<name>.js`)。 */
const GRAPH_3D_CHUNK = './client.three.js'

/** 超过这个数量就用 InstancedMesh,一次 draw call 画完整团。 */
const GRAPH_3D_INSTANCED_MIN = 24

/** 加载中的 Promise 缓存:切来切去只加载一次。失败后清空,允许重试。 */
let graphThreePromise = null

/** 按需加载 three.js chunk,返回其命名空间。 */
function loadGraphThree() {
  if (graphThreePromise !== null) return graphThreePromise
  graphThreePromise = (async () => {
    const loader = typeof require === 'function' ? require : null
    if (!loader || typeof loader.async !== 'function') {
      throw new Error('宿主不支持 require.async，无法加载 3D 渲染器')
    }
    const THREE = await loader.async(GRAPH_3D_CHUNK)
    if (!THREE || typeof THREE.Scene !== 'function' || typeof THREE.WebGLRenderer !== 'function') {
      throw new Error('client.three.js 没有导出可用的 three 命名空间')
    }
    return THREE
  })().catch((error) => {
    // 加载失败要能重试(例如宿主刚更新了包),所以清掉缓存
    graphThreePromise = null
    throw error
  })
  return graphThreePromise
}

/** 探测 WebGL:不可用就让调用方退回 2D,而不是给用户一块黑屏。 */
function graphWebGLAvailable() {
  try {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return false
    const canvas = document.createElement('canvas')
    if (!canvas || typeof canvas.getContext !== 'function') return false
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'))
  } catch {
    return false
  }
}

/**
 * 相机注视点。故意**不**用 THREE.Vector3:控制器在 three 加载完成之前就要能构造,
 * 而这里只需要 set / copy / addScaledVector 三个方法。
 */
function graphVec3(x = 0, y = 0, z = 0) {
  return {
    x, y, z,
    set(nx, ny, nz) { this.x = nx; this.y = ny; this.z = nz; return this },
    copy(other) { this.x = other.x; this.y = other.y; this.z = other.z; return this },
    addScaledVector(other, scale) {
      this.x += other.x * scale
      this.y += other.y * scale
      this.z += other.z * scale
      return this
    },
  }
}

/** 记忆类型色 → THREE.Color,远处压暗(和 2D 的 --z-op 同一口径)。 */
function graphStarColor(THREE, kind, depth) {
  const color = new THREE.Color(kindMeta(kind).color)
  color.multiplyScalar(1 - depth * 0.42)
  return color
}

/**
 * 创建 3D 星图控制器。
 *
 * @param {object} options
 * @param {HTMLElement} options.container 挂载点(必须已在文档里,尺寸才有值)。
 * @param {(id: string) => void} [options.onSelect] 单击记忆星。
 * @param {(id: string|null) => void} [options.onHover] 悬停记忆星。
 * @param {(scope: string, position: {x,y,z}) => void} [options.onScopeMove] 拖中心球。
 * @param {(scope: string, rotation: {x,y,z}) => void} [options.onScopeRotate] 拖轨道。
 * @param {(id: string, position: {x,y,z}) => void} [options.onNodeMove] 拖记忆星。
 * @param {(view: object) => void} [options.onView] 视角变化(节流后回调)。
 * @returns {object} 控制器
 */
function createMemoryGraph3D(options) {
  const container = options.container
  const callbacks = {
    onSelect: typeof options.onSelect === 'function' ? options.onSelect : () => {},
    onHover: typeof options.onHover === 'function' ? options.onHover : () => {},
    onScopeMove: typeof options.onScopeMove === 'function' ? options.onScopeMove : () => {},
    onScopeRotate: typeof options.onScopeRotate === 'function' ? options.onScopeRotate : () => {},
    onNodeMove: typeof options.onNodeMove === 'function' ? options.onNodeMove : () => {},
    onView: typeof options.onView === 'function' ? options.onView : () => {},
  }

  const state = {
    THREE: null,
    renderer: null,
    scene: null,
    camera: null,
    root: null,
    raycaster: null,
    pointer: null,
    canvas: null,
    labelLayer: null,
    scopeViews: new Map(),
    /** `record:<id>` / `scope:<scope>` → { object, group, local, index?, node } */
    nodeIndex: new Map(),
    starBatches: [],
    linkGroups: [],
    labels: [],
    disposed: false,
    paused: false,
    frame: 0,
    camera3: {
      target: graphVec3(),
      azimuth: 0.6,
      polar: 1.15,
      distance: GRAPH_VIEW.camera.distance,
    },
    drag: null,
    hoveredId: null,
    selectedId: null,
    nearKeys: new Set(),
    matchIds: new Set(),
    hasQuery: false,
    spaceHeld: false,
    width: 1,
    height: 1,
    data: null,
  }

  // ---------------------------------------------------------------- 相机

  /** 把球坐标同步到真实相机。 */
  const applyCamera = () => {
    const { camera } = state
    if (!camera) return
    const c = state.camera3
    c.polar = Math.max(0.12, Math.min(Math.PI - 0.12, c.polar))
    c.distance = Math.max(GRAPH_VIEW.camera.minDistance, Math.min(GRAPH_VIEW.camera.maxDistance, c.distance))
    const sin = Math.sin(c.polar)
    camera.position.set(
      c.target.x + Math.sin(c.azimuth) * sin * c.distance,
      c.target.y + Math.cos(c.polar) * c.distance,
      c.target.z + Math.cos(c.azimuth) * sin * c.distance,
    )
    camera.lookAt(c.target.x, c.target.y, c.target.z)
    camera.updateMatrixWorld()
    state.linksDirty = true
  }

  /** 当前视角。字段名与持久化 schema 一致:相机位置 + 注视点 + 缩放倍率。 */
  const readView = () => {
    const c = state.camera3
    const position = state.camera ? state.camera.position : { x: 0, y: 0, z: c.distance }
    return {
      cameraPosition: [position.x, position.y, position.z],
      cameraTarget: [c.target.x, c.target.y, c.target.z],
      zoom: GRAPH_VIEW.camera.distance / Math.max(1, c.distance),
    }
  }

  /** 应用持久化视角:从相机位置与注视点反解球坐标。 */
  const applyView = (view) => {
    if (!view || typeof view !== 'object') return
    const c = state.camera3
    const target = Array.isArray(view.cameraTarget) ? view.cameraTarget : null
    if (target && target.length === 3 && target.every((v) => Number.isFinite(v))) {
      c.target.set(target[0], target[1], target[2])
    }
    const position = Array.isArray(view.cameraPosition) ? view.cameraPosition : null
    if (position && position.length === 3 && position.every((v) => Number.isFinite(v))) {
      const dx = position[0] - c.target.x
      const dy = position[1] - c.target.y
      const dz = position[2] - c.target.z
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (distance > 0.001) {
        c.distance = distance
        c.polar = Math.acos(Math.max(-1, Math.min(1, dy / distance)))
        c.azimuth = Math.atan2(dx, dz)
      }
    }
    applyCamera()
  }

  // ---------------------------------------------------------------- 世界坐标

  /**
   * 节点的世界坐标。scope 节点的 local 就是世界坐标(root 恒等);记忆星的 local
   * 是相对所属作用域 Group 的,必须过一遍 matrixWorld。
   */
  const worldOf = (entry, out) => {
    out.set(entry.local.x, entry.local.y, entry.local.z)
    if (entry.group) out.applyMatrix4(entry.group.matrixWorld)
    return out
  }

  // ---------------------------------------------------------------- 初始化

  const buildScene = (THREE) => {
    const scene = new THREE.Scene()
    // 环境光打底(暗空里也要看得见星),两盏方向光给球体立体感,点光在原点当"恒星"
    scene.add(new THREE.AmbientLight(0xffffff, 1.2))
    const key = new THREE.DirectionalLight(0xffffff, 1.5)
    key.position.set(600, 900, 800)
    scene.add(key)
    const rim = new THREE.DirectionalLight(0x88aaff, 0.75)
    rim.position.set(-700, -400, -600)
    scene.add(rim)
    const core = new THREE.PointLight(0xffd9a0, 1.3, 8000, 2)
    core.position.set(0, 0, 0)
    scene.add(core)
    const root = new THREE.Group()
    scene.add(root)
    return { scene, root }
  }

  const initThree = (THREE) => {
    state.THREE = THREE
    const { scene, root } = buildScene(THREE)
    state.scene = scene
    state.root = root

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
    renderer.setPixelRatio(Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1))
    renderer.setClearAlpha(0)
    renderer.domElement.className = 'graph3-canvas'
    renderer.domElement.style.display = 'block'
    renderer.domElement.style.width = '100%'
    renderer.domElement.style.height = '100%'
    container.appendChild(renderer.domElement)
    state.renderer = renderer
    state.canvas = renderer.domElement

    state.camera = new THREE.PerspectiveCamera(GRAPH_VIEW.camera.fov, 1, GRAPH_VIEW.camera.near, GRAPH_VIEW.camera.far)
    state.raycaster = new THREE.Raycaster()
    state.pointer = new THREE.Vector2()

    // 标签层:HTML 覆盖层。比 Sprite 清晰、能直接用主题 token、也更好控制远近显隐。
    const labelLayer = document.createElement('div')
    labelLayer.className = 'graph3-labels'
    container.appendChild(labelLayer)
    state.labelLayer = labelLayer

    bindEvents()
    resize()
    // 相机初始位置在原点、朝向 -Z —— 不套一次球坐标,场景就落在相机背后,
    // 画出来是纯黑(而 canvas、标签层、事件全都"正常",极难从现象上定位)。
    applyCamera()
  }

  /** 容器尺寸变化时同步相机与 renderer。 */
  const resize = () => {
    if (!state.renderer || !state.camera) return
    const width = Math.max(1, container.clientWidth || 1)
    const height = Math.max(1, container.clientHeight || 1)
    state.width = width
    state.height = height
    state.renderer.setSize(width, height, false)
    state.camera.aspect = width / height
    state.camera.updateProjectionMatrix()
    state.linksDirty = true
  }

  // ---------------------------------------------------------------- 拾取

  const toPointer = (event) => {
    const rect = state.canvas.getBoundingClientRect()
    state.pointer.set(
      ((event.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
      -((event.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1,
    )
    return state.pointer
  }

  const castRay = (event) => {
    toPointer(event)
    state.raycaster.setFromCamera(state.pointer, state.camera)
    return state.raycaster
  }

  /** 命中测试:`star` / `scope`(中心球)/ `orbit`(轨道环)/ `none`,取最近的一个。 */
  const pick = (event) => {
    const raycaster = castRay(event)
    const starTargets = state.starBatches.map((batch) => batch.mesh).filter((mesh) => mesh && mesh.visible)
    const sphereTargets = []
    const orbitTargets = []
    for (const view of state.scopeViews.values()) {
      if (view.sphere) sphereTargets.push(view.sphere)
      // 拾取用代理环(够胖),没有代理时退回视觉环本身
      if (view.orbitHit) orbitTargets.push(view.orbitHit)
      else if (view.orbit) orbitTargets.push(view.orbit)
      if (view.orbit2Hit) orbitTargets.push(view.orbit2Hit)
      else if (view.orbit2) orbitTargets.push(view.orbit2)
    }

    const candidates = []
    for (const hit of raycaster.intersectObjects(starTargets, false)) {
      candidates.push({ distance: hit.distance, hit, kind: 'star' })
      break
    }
    for (const hit of raycaster.intersectObjects(sphereTargets, false)) {
      candidates.push({ distance: hit.distance, hit, kind: 'scope' })
      break
    }
    for (const hit of raycaster.intersectObjects(orbitTargets, false)) {
      candidates.push({ distance: hit.distance, hit, kind: 'orbit' })
      break
    }
    if (candidates.length === 0) return { type: 'none' }
    candidates.sort((a, b) => a.distance - b.distance)
    const winner = candidates[0]

    if (winner.kind === 'star') {
      const batch = state.starBatches.find((item) => item.mesh === winner.hit.object)
      if (!batch) return { type: 'none' }
      const node = batch.nodes[winner.hit.instanceId ?? 0]
      if (!node) return { type: 'none' }
      return { type: 'star', id: node.id, key: node.key, scope: node.scope }
    }
    const view = winner.hit.object.userData.graphScopeView
    if (!view) return { type: 'none' }
    return { type: winner.kind, scope: view.scope, key: `scope:${view.scope}` }
  }

  /** 建一条垂直于相机的拖动平面,让拖动跟手。 */
  const dragPlaneAt = (point) => {
    const THREE = state.THREE
    const normal = new THREE.Vector3()
    state.camera.getWorldDirection(normal)
    const plane = new THREE.Plane()
    plane.setFromNormalAndCoplanarPoint(normal, point)
    return plane
  }

  /** 指针射线 → 拖动平面上的世界坐标。 */
  const planePoint = (event, plane) => {
    const THREE = state.THREE
    const hit = new THREE.Vector3()
    const found = castRay(event).ray.intersectPlane(plane, hit)
    return found ? hit : null
  }

  // ---------------------------------------------------------------- 事件

  const bindEvents = () => {
    const canvas = state.canvas
    const THREE = () => state.THREE

    const onPointerDown = (event) => {
      if (event.button !== 0) return
      const hit = pick(event)
      const T = THREE()
      if (hit.type === 'star') {
        const entry = state.nodeIndex.get(hit.key)
        if (!entry) return
        const world = worldOf(entry, new T.Vector3())
        state.drag = {
          mode: 'node', key: hit.key, id: hit.id, scope: hit.scope,
          plane: dragPlaneAt(world), start: event, moved: false, changed: false,
        }
      } else if (hit.type === 'scope') {
        const view = state.scopeViews.get(hit.scope)
        if (!view) return
        const world = new T.Vector3().setFromMatrixPosition(view.group.matrixWorld)
        state.drag = {
          mode: 'scope', scope: hit.scope,
          plane: dragPlaneAt(world), start: event, moved: false, changed: false,
        }
      } else if (hit.type === 'orbit') {
        state.drag = { mode: 'rotate', scope: hit.scope, start: event, moved: false, changed: false }
      } else if (state.spaceHeld) {
        state.drag = { mode: 'orbit-camera', start: event, moved: false, changed: false }
      } else {
        state.drag = { mode: 'pan', start: event, moved: false, changed: false }
      }
      canvas.classList.add(state.drag.mode === 'pan' || state.drag.mode === 'orbit-camera' ? 'grabbing' : 'dragging')
      if (typeof canvas.setPointerCapture === 'function' && event.pointerId !== undefined) {
        try { canvas.setPointerCapture(event.pointerId) } catch {}
      }
      if (typeof event.preventDefault === 'function') event.preventDefault()
    }

    const onPointerMove = (event) => {
      const drag = state.drag
      if (!drag) {
        const hit = pick(event)
        const next = hit.type === 'star' ? hit.id : null
        if (next !== state.hoveredId) {
          state.hoveredId = next
          callbacks.onHover(next)
        }
        canvas.style.cursor = hit.type === 'star' ? 'pointer'
          : hit.type === 'scope' || hit.type === 'orbit' ? 'grab'
            : state.spaceHeld ? 'move' : 'grab'
        return
      }
      const dx = event.clientX - drag.start.clientX
      const dy = event.clientY - drag.start.clientY
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return
      drag.moved = true

      if (drag.mode === 'pan') {
        // 平移整个星图:按相机的右/上方向移动注视点,灵敏度随距离缩放(远处拖得快)
        const scale = state.camera3.distance * GRAPH_VIEW.panSpeed / Math.max(1, state.height)
        const right = new (THREE().Vector3)().setFromMatrixColumn(state.camera.matrixWorld, 0)
        const up = new (THREE().Vector3)().setFromMatrixColumn(state.camera.matrixWorld, 1)
        state.camera3.target.addScaledVector(right, -dx * scale)
        state.camera3.target.addScaledVector(up, dy * scale)
        applyCamera()
        emitView()
        return
      }
      if (drag.mode === 'orbit-camera') {
        state.camera3.azimuth -= dx * GRAPH_VIEW.orbitSpeed
        state.camera3.polar -= dy * GRAPH_VIEW.orbitSpeed
        applyCamera()
        emitView()
        return
      }
      if (drag.mode === 'rotate') {
        const view = state.scopeViews.get(drag.scope)
        if (!view) return
        // 用四元数累乘(不是欧拉角相加),避免万向锁与轴序问题。旋转轴取相机
        // 右/上方向在**父空间**里的投影 —— 于是"往右拖"永远绕屏幕上竖直的轴转,
        // 不管当前已经转到什么角度。
        const T = THREE()
        const right = new T.Vector3().setFromMatrixColumn(state.camera.matrixWorld, 0)
        const up = new T.Vector3().setFromMatrixColumn(state.camera.matrixWorld, 1)
        const parentQuat = new T.Quaternion()
        if (view.group.parent) view.group.parent.getWorldQuaternion(parentQuat)
        const inverse = parentQuat.clone().invert()
        const axisY = right.clone().applyQuaternion(inverse).normalize()
        const axisX = up.clone().applyQuaternion(inverse).normalize()
        const qY = new T.Quaternion().setFromAxisAngle(axisY, dx * GRAPH_VIEW.orbitSpeed)
        const qX = new T.Quaternion().setFromAxisAngle(axisX, dy * GRAPH_VIEW.orbitSpeed)
        view.group.quaternion.premultiply(qX).premultiply(qY)
        view.group.updateMatrixWorld(true)
        state.linksDirty = true
        drag.changed = true
        return
      }
      if (drag.mode === 'scope') {
        const view = state.scopeViews.get(drag.scope)
        if (!view) return
        const point = planePoint(event, drag.plane)
        if (!point) return
        // 世界坐标 → 父 Group 局部坐标。绝不把像素坐标直接当世界坐标。
        view.group.position.copy(view.group.parent.worldToLocal(point.clone()))
        view.group.updateMatrixWorld(true)
        const entry = state.nodeIndex.get(`scope:${drag.scope}`)
        if (entry) entry.local = { x: view.group.position.x, y: view.group.position.y, z: view.group.position.z }
        state.linksDirty = true
        drag.changed = true
        return
      }
      if (drag.mode === 'node') {
        const entry = state.nodeIndex.get(drag.key)
        if (!entry) return
        const point = planePoint(event, drag.plane)
        if (!point) return
        // 世界坐标 → 所属作用域 Group 的局部坐标
        const local = entry.group ? entry.group.worldToLocal(point.clone()) : point
        entry.local = { x: local.x, y: local.y, z: local.z }
        writeNodeLocal(entry)
        state.linksDirty = true
        drag.changed = true
      }
    }

    const finishDrag = (event) => {
      const drag = state.drag
      state.drag = null
      canvas.classList.remove('grabbing', 'dragging')
      if (!drag) return
      // 星上按下但没拖动 = 单击:选中并开详情。只在这里判一次,
      // 否则 pointerup 与 finishDrag 各触发一遍,抽屉会开了又关。
      const clicked = drag.mode === 'node' && !drag.moved
      if (drag.mode === 'node' && drag.changed) {
        const entry = state.nodeIndex.get(drag.key)
        if (entry) callbacks.onNodeMove(drag.id, { ...entry.local })
      } else if (drag.mode === 'scope' && drag.changed) {
        const view = state.scopeViews.get(drag.scope)
        if (view) callbacks.onScopeMove(drag.scope, {
          x: view.group.position.x, y: view.group.position.y, z: view.group.position.z,
        })
      } else if (drag.mode === 'rotate' && drag.changed) {
        const view = state.scopeViews.get(drag.scope)
        if (view) {
          const euler = new (THREE().Euler)().setFromQuaternion(view.group.quaternion, 'XYZ')
          callbacks.onScopeRotate(drag.scope, { x: euler.x, y: euler.y, z: euler.z })
        }
      } else if ((drag.mode === 'pan' || drag.mode === 'orbit-camera') && drag.moved) {
        emitView()
      }
      if (clicked && drag.id) callbacks.onSelect(drag.id)
      if (typeof canvas.releasePointerCapture === 'function' && event && event.pointerId !== undefined) {
        try { canvas.releasePointerCapture(event.pointerId) } catch {}
      }
    }

    const onDblClick = (event) => {
      const hit = pick(event)
      if (hit.type !== 'star') return
      focusNode(hit.key)
    }

    const onWheel = (event) => {
      // 只接管 Ctrl+滚轮,普通滚轮留给宿主页面滚动 —— 这是手势表的口径。
      if (!event.ctrlKey && !event.metaKey) return
      if (typeof event.preventDefault === 'function') event.preventDefault()
      const factor = Math.exp((event.deltaY || 0) * GRAPH_VIEW.zoomSpeed)
      state.camera3.distance *= factor
      applyCamera()
      emitView()
    }

    const onKeyDown = (event) => {
      if (event.code === 'Space' || event.key === ' ') {
        state.spaceHeld = true
        canvas.style.cursor = 'move'
      }
    }
    const onKeyUp = (event) => {
      if (event.code === 'Space' || event.key === ' ') {
        state.spaceHeld = false
        canvas.style.cursor = 'grab'
      }
    }
    const onContextMenu = (event) => {
      if (typeof event.preventDefault === 'function') event.preventDefault()
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', finishDrag)
    canvas.addEventListener('pointercancel', finishDrag)
    canvas.addEventListener('dblclick', onDblClick)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('contextmenu', onContextMenu)
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('keydown', onKeyDown)
      window.addEventListener('keyup', onKeyUp)
    }

    state.teardown = () => {
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', finishDrag)
      canvas.removeEventListener('pointercancel', finishDrag)
      canvas.removeEventListener('dblclick', onDblClick)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('contextmenu', onContextMenu)
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('keydown', onKeyDown)
        window.removeEventListener('keyup', onKeyUp)
      }
    }
  }

  /** 视角变化回调节流:拖动时每帧写 localStorage 太浪费。 */
  let viewTimer = 0
  const emitView = () => {
    if (viewTimer !== 0) return
    const schedule = typeof setTimeout === 'function' ? setTimeout : null
    if (!schedule) return
    viewTimer = schedule(() => {
      viewTimer = 0
      callbacks.onView(readView())
    }, 180)
  }

  // ---------------------------------------------------------------- 场景构建

  /** 把节点 local 坐标写进场景对象(单 Mesh 直接改 position,InstancedMesh 改矩阵)。 */
  const writeNodeLocal = (entry) => {
    const T = state.THREE
    if (!entry || !entry.object) return
    if (entry.index === undefined) {
      entry.object.position.set(entry.local.x, entry.local.y, entry.local.z)
      entry.object.updateMatrixWorld(true)
      return
    }
    const batch = state.starBatches.find((item) => item.mesh === entry.object)
    if (!batch) return
    const matrix = new T.Matrix4()
    matrix.compose(
      new T.Vector3(entry.local.x, entry.local.y, entry.local.z),
      new T.Quaternion(),
      new T.Vector3(entry.node.r, entry.node.r, entry.node.r),
    )
    entry.object.setMatrixAt(entry.index, matrix)
    entry.object.instanceMatrix.needsUpdate = true
  }

  /** 一个作用域下的星:数量多走 InstancedMesh,少则各自成 Mesh(拾取/高亮更直观)。 */
  const buildStars = (hub, group) => {
    const T = state.THREE
    const nodes = hub.members
    if (nodes.length === 0) return

    const geometry = new T.SphereGeometry(1, 12, 10)
    const instanced = nodes.length >= GRAPH_3D_INSTANCED_MIN

    if (instanced) {
      const material = new T.MeshStandardMaterial({ roughness: 0.55, metalness: 0.12, vertexColors: true })
      const mesh = new T.InstancedMesh(geometry, material, nodes.length)
      mesh.userData.graphScope = hub.scope
      const matrix = new T.Matrix4()
      const scale = new T.Vector3()
      const position = new T.Vector3()
      const identity = new T.Quaternion()
      const color = new T.Color()
      nodes.forEach((node, index) => {
        // 布局给的是世界坐标,这里减掉星心换成作用域局部坐标
        const lx = node.position.x - hub.position.x
        const ly = node.position.y - hub.position.y
        const lz = node.position.z - hub.position.z
        position.set(lx, ly, lz)
        scale.set(node.r, node.r, node.r)
        matrix.compose(position, identity, scale)
        mesh.setMatrixAt(index, matrix)
        mesh.setColorAt(index, color.copy(graphStarColor(T, node.kind, node.depth)))
        state.nodeIndex.set(node.key, {
          object: mesh, group, kind: 'record', id: node.id, scope: hub.scope, node, index,
          local: { x: lx, y: ly, z: lz },
        })
      })
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
      group.add(mesh)
      state.starBatches.push({ mesh, nodes, scope: hub.scope, instanced: true })
      return
    }

    nodes.forEach((node) => {
      const base = graphStarColor(T, node.kind, node.depth)
      const material = new T.MeshStandardMaterial({
        color: base.clone(),
        emissive: base.clone().multiplyScalar(0.35),
        roughness: 0.5,
        metalness: 0.15,
      })
      const mesh = new T.Mesh(geometry, material)
      const local = {
        x: node.position.x - hub.position.x,
        y: node.position.y - hub.position.y,
        z: node.position.z - hub.position.z,
      }
      mesh.position.set(local.x, local.y, local.z)
      mesh.scale.setScalar(node.r)
      mesh.userData.graphNode = { id: node.id, key: node.key, scope: hub.scope }
      group.add(mesh)
      state.starBatches.push({ mesh, nodes: [node], scope: hub.scope, instanced: false })
      state.nodeIndex.set(node.key, {
        object: mesh, group, kind: 'record', id: node.id, scope: hub.scope, node,
        local,
      })
    })
  }

  /** 连线:成员线与修正线各自一条 LineSegments,顶点按需刷新而不是重建几何。 */
  const buildLinks = (data) => {
    const T = state.THREE
    const make = (links, color, opacity) => {
      if (links.length === 0) return
      const positions = new Float32Array(links.length * 6)
      const geometry = new T.BufferGeometry()
      geometry.setAttribute('position', new T.BufferAttribute(positions, 3))
      const material = new T.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false })
      const lines = new T.LineSegments(geometry, material)
      lines.frustumCulled = false
      state.root.add(lines)
      state.linkGroups.push({ lines, links, positions })
    }
    make(data.links.filter((link) => link.type !== 'correction'), 0x6f86a8, 0.45)
    make(data.links.filter((link) => link.type === 'correction'), 0xc08bd8, 0.8)
  }

  /** 标签:作用域常显,记忆星只在命中 / 邻域 / 悬停 / 选中时出现。 */
  const buildLabels = (data) => {
    const layer = state.labelLayer
    if (!layer) return
    layer.textContent = ''
    state.labels = []
    for (const hub of data.scopes) {
      const el = document.createElement('div')
      el.className = 'graph3-label hub'
      el.textContent = `${hub.label} · ${hub.count}`
      layer.appendChild(el)
      state.labels.push({ el, key: `scope:${hub.scope}`, kind: 'hub', scope: hub.scope })
    }
    for (const node of data.records) {
      const el = document.createElement('div')
      el.className = 'graph3-label star'
      el.textContent = excerpt(node.rec.content, 22)
      el.style.setProperty('--k', kindMeta(node.kind).color)
      el.style.display = 'none'
      layer.appendChild(el)
      state.labels.push({ el, key: node.key, kind: 'star', id: node.id })
    }
  }

  /** 清场景:几何与材质都要显式 dispose,否则切几次视图就爆显存。 */
  const clearScene = () => {
    if (!state.root) return
    const geometries = new Set()
    const materials = new Set()
    state.root.traverse((object) => {
      if (object.geometry) geometries.add(object.geometry)
      if (object.material) {
        for (const material of (Array.isArray(object.material) ? object.material : [object.material])) {
          if (material) materials.add(material)
        }
      }
    })
    for (const geometry of geometries) if (typeof geometry.dispose === 'function') geometry.dispose()
    for (const material of materials) if (typeof material.dispose === 'function') material.dispose()
    while (state.root.children.length > 0) state.root.remove(state.root.children[0])
    state.scopeViews.clear()
    state.nodeIndex.clear()
    state.starBatches = []
    state.linkGroups = []
    state.labels = []
    if (state.labelLayer) state.labelLayer.textContent = ''
  }

  /**
   * 用三维布局重建场景。
   * @param {ReturnType<typeof buildMemoryGraph3D>} data
   */
  const setData = (data) => {
    const T = state.THREE
    if (!T || !state.root) return
    clearScene()
    state.data = data

    for (const hub of data.scopes) {
      const group = new T.Group()
      group.position.set(hub.position.x, hub.position.y, hub.position.z)
      group.quaternion.setFromEuler(new T.Euler(hub.rotation.x, hub.rotation.y, hub.rotation.z, 'XYZ'))
      group.userData.graphScope = hub.scope
      state.root.add(group)

      // 中心球:作用域的"恒星"
      const sphere = new T.Mesh(
        new T.SphereGeometry(Math.max(6, hub.r), 24, 18),
        new T.MeshStandardMaterial({
          color: 0xdfe9ff,
          emissive: new T.Color(0x5b8def),
          emissiveIntensity: hub.open ? 0.9 : 0.35,
          roughness: 0.42,
          metalness: 0.2,
          transparent: true,
          opacity: hub.open ? 1 : 0.55,
        }),
      )
      sphere.userData.graphScopeView = { scope: hub.scope, group }
      group.add(sphere)

      // 轨道环:真 3D 圆环(有厚度、有透视、会被遮挡)。躺在 XZ 平面。
      //
      // 管径不能写死:0.9 在 orbit=70 的环上折算到屏幕只有几像素,既看不出厚度,
      // 也根本点不中(拖动轨道旋转就废了)。按半径比例给粗细,并保底 1.8。
      const tube = Math.max(1.8, hub.orbit * 0.026)
      const orbitMaterial = new T.MeshStandardMaterial({
        color: 0x9fc6ff,
        emissive: 0x3f6fa8,
        emissiveIntensity: 0.9,
        roughness: 0.5,
        metalness: 0.2,
        transparent: true,
        opacity: hub.open ? 0.55 : 0.2,
      })
      const orbit = new T.Mesh(new T.TorusGeometry(Math.max(10, hub.orbit), tube, 8, 128), orbitMaterial)
      orbit.rotation.x = -Math.PI / 2
      orbit.userData.graphScopeView = { scope: hub.scope, group }
      group.add(orbit)

      // 拾取代理:视觉上的环要细才好看,但射线需要一个够胖的目标。
      // 关掉 visible(不渲染)仍可被 Raycaster 命中 —— three 的 intersect 只查 layers。
      const orbitHit = new T.Mesh(
        new T.TorusGeometry(Math.max(10, hub.orbit), tube * 3.2, 4, 96),
        new T.MeshBasicMaterial({ visible: false }),
      )
      orbitHit.rotation.x = -Math.PI / 2
      orbitHit.userData.graphScopeView = { scope: hub.scope, group }
      orbitHit.userData.graphPickOnly = true
      group.add(orbitHit)

      // 第二圈与之正交,给出"球壳"的体积暗示(比单环更像球,不是一圈铁丝)
      const orbit2 = new T.Mesh(
        new T.TorusGeometry(Math.max(10, hub.orbit), tube * 0.55, 6, 96),
        orbitMaterial.clone(),
      )
      orbit2.rotation.y = Math.PI / 2
      orbit2.material.opacity = hub.open ? 0.24 : 0.1
      orbit2.userData.graphScopeView = { scope: hub.scope, group }
      group.add(orbit2)

      const orbit2Hit = new T.Mesh(
        new T.TorusGeometry(Math.max(10, hub.orbit), tube * 2.0, 4, 72),
        new T.MeshBasicMaterial({ visible: false }),
      )
      orbit2Hit.rotation.y = Math.PI / 2
      orbit2Hit.userData.graphScopeView = { scope: hub.scope, group }
      orbit2Hit.userData.graphPickOnly = true
      group.add(orbit2Hit)

      state.scopeViews.set(hub.scope, { scope: hub.scope, group, sphere, orbit, orbit2, orbitHit, orbit2Hit, hub })
      state.nodeIndex.set(`scope:${hub.scope}`, {
        object: sphere, group: null, kind: 'scope', scope: hub.scope,
        local: { x: hub.position.x, y: hub.position.y, z: hub.position.z },
      })

      buildStars(hub, group)
    }

    buildLinks(data)
    buildLabels(data)
    state.linksDirty = true
    applyCamera()
  }

  // ---------------------------------------------------------------- 高亮

  /** 更新高亮:选中 / 悬停 / 邻域 / 搜索命中。 */
  const setHighlight = (next) => {
    const patch = next || {}
    state.selectedId = patch.selectedId ?? null
    state.hoveredId = patch.hoverId ?? null
    state.nearKeys = patch.nearKeys instanceof Set ? patch.nearKeys : new Set()
    state.matchIds = patch.matchIds instanceof Set ? patch.matchIds : new Set()
    state.hasQuery = Boolean(patch.hasQuery)

    const T = state.THREE
    if (!T) return
    const focusKey = state.hoveredId !== null ? `record:${state.hoveredId}`
      : state.selectedId !== null ? `record:${state.selectedId}` : null
    const white = new T.Color(0xffffff)

    for (const batch of state.starBatches) {
      if (!batch.mesh) continue
      if (batch.instanced) {
        const color = new T.Color()
        batch.nodes.forEach((node, index) => {
          const selected = state.selectedId !== null && node.id === state.selectedId
          const near = state.nearKeys.has(node.key) || node.key === focusKey
          const base = graphStarColor(T, node.kind, node.depth)
          if (selected) base.lerp(white, 0.65)
          else if (near) base.lerp(white, 0.4)
          else if (state.hasQuery && !state.matchIds.has(node.id)) base.multiplyScalar(0.35)
          batch.mesh.setColorAt(index, color.copy(base))
        })
        if (batch.mesh.instanceColor) batch.mesh.instanceColor.needsUpdate = true
        continue
      }
      const node = batch.nodes[0]
      const entry = state.nodeIndex.get(node.key)
      if (!entry) continue
      const selected = state.selectedId !== null && node.id === state.selectedId
      const near = state.nearKeys.has(node.key) || node.key === focusKey
      const base = graphStarColor(T, node.kind, node.depth)
      if (selected) base.lerp(white, 0.65)
      else if (near) base.lerp(white, 0.4)
      else if (state.hasQuery && !state.matchIds.has(node.id)) base.multiplyScalar(0.35)
      batch.mesh.material.color.copy(base)
      batch.mesh.material.emissive.copy(base).multiplyScalar(0.4)
      batch.mesh.scale.setScalar(node.r * (selected ? 1.6 : near ? 1.28 : 1))
      entry.object.updateMatrixWorld(true)
    }
  }

  // ---------------------------------------------------------------- 取景

  /** 把一颗记忆星放到画面中心(双击聚焦)。 */
  const focusNode = (key) => {
    const T = state.THREE
    const entry = state.nodeIndex.get(key)
    if (!entry || !T) return
    const world = worldOf(entry, new T.Vector3())
    state.camera3.target.copy(world)
    state.camera3.distance = Math.min(state.camera3.distance, 520)
    applyCamera()
    emitView()
  }

  /** 把整张图缩放到视野内。 */
  const fit = (radius) => {
    const r = Number.isFinite(radius) && radius > 0 ? radius : 400
    const fov = (GRAPH_VIEW.camera.fov * Math.PI) / 180
    const aspect = Math.max(0.4, state.width / Math.max(1, state.height))
    const vertical = r / Math.tan(fov / 2)
    const horizontal = vertical / aspect
    state.camera3.distance = Math.max(vertical, horizontal) * 1.35
    if (state.data) {
      state.camera3.target.set(state.data.center.x, state.data.center.y, state.data.center.z)
    } else {
      state.camera3.target.set(0, 0, 0)
    }
    applyCamera()
    emitView()
  }

  // ---------------------------------------------------------------- 每帧

  /** 连线端点重新写入 BufferAttribute(只改顶点,不重建几何)。 */
  const updateLinks = () => {
    if (!state.linkGroups || state.linkGroups.length === 0) return
    const T = state.THREE
    const from = new T.Vector3()
    const to = new T.Vector3()
    for (const group of state.linkGroups) {
      const { links, positions, lines } = group
      let offset = 0
      for (const link of links) {
        const a = state.nodeIndex.get(link.fromKey)
        const b = state.nodeIndex.get(link.toKey)
        if (!a || !b) {
          positions.fill(0, offset, offset + 6)
          offset += 6
          continue
        }
        worldOf(a, from)
        worldOf(b, to)
        positions[offset] = from.x
        positions[offset + 1] = from.y
        positions[offset + 2] = from.z
        positions[offset + 3] = to.x
        positions[offset + 4] = to.y
        positions[offset + 5] = to.z
        offset += 6
      }
      lines.geometry.attributes.position.needsUpdate = true
      lines.geometry.computeBoundingSphere()
    }
    state.linksDirty = false
  }

  /** 标签跟随:投影到屏幕;远处 / 屏幕外的隐藏。 */
  const updateLabels = () => {
    if (!state.labels || state.labels.length === 0) return
    const T = state.THREE
    const point = new T.Vector3()
    for (const label of state.labels) {
      const entry = state.nodeIndex.get(label.key)
      if (!entry) { label.el.style.display = 'none'; continue }
      if (label.kind === 'star') {
        // 和 2D 同一口径:只给"有意义的点"贴标签,否则星团糊成一片
        const selected = state.selectedId !== null && label.id === state.selectedId
        const hovered = state.hoveredId !== null && label.id === state.hoveredId
        const near = state.nearKeys.has(label.key)
        const matched = state.hasQuery && state.matchIds.has(label.id)
        if (!selected && !hovered && !near && !matched) {
          label.el.style.display = 'none'
          continue
        }
      }
      worldOf(entry, point).project(state.camera)
      if (point.z > 1 || point.z < -1) {
        label.el.style.display = 'none'
        continue
      }
      const x = (point.x * 0.5 + 0.5) * state.width
      const y = (-point.y * 0.5 + 0.5) * state.height
      label.el.style.display = 'block'
      label.el.style.transform = `translate(-50%, -50%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`
      // 远处的标签淡一点,近处清晰 —— 深度感靠这个和星本身的大小一起给
      label.el.style.opacity = String(Math.max(0.4, Math.min(1, 1.3 - point.z * 0.6)))
    }
  }

  const tick = () => {
    if (state.disposed || state.paused) { state.frame = 0; return }
    state.frame = requestAnimationFrame(tick)
    if (!state.renderer || !state.scene || !state.camera) return
    if (state.linksDirty) updateLinks()
    updateLabels()
    state.renderer.render(state.scene, state.camera)
  }

  const start = () => {
    if (state.frame !== 0 || state.disposed || state.paused) return
    if (typeof requestAnimationFrame !== 'function') return
    state.frame = requestAnimationFrame(tick)
  }

  const controller = {
    /** 异步加载 three 并建场景。失败时抛错,由调用方退回 2D。 */
    async mount(data, view) {
      const T = await loadGraphThree()
      if (state.disposed) return false
      initThree(T)
      if (data) setData(data)
      if (view) applyView(view)
      start()
      return true
    },
    setData,
    setHighlight,
    applyView,
    readView,
    fit,
    focusNode,
    resize,
    /** 切走时暂停渲染,省电省 GPU。 */
    pause() {
      state.paused = true
      if (state.frame !== 0) { cancelAnimationFrame(state.frame); state.frame = 0 }
    },
    resume() {
      if (state.disposed) return
      state.paused = false
      start()
    },
    /** 彻底销毁:移除监听、释放显存、摘掉 canvas 与标签层。 */
    dispose() {
      state.disposed = true
      if (state.frame !== 0) { cancelAnimationFrame(state.frame); state.frame = 0 }
      if (state.teardown) state.teardown()
      if (state.renderer) {
        clearScene()
        try { state.renderer.dispose() } catch {}
        const canvas = state.renderer.domElement
        if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas)
      }
      if (state.labelLayer && state.labelLayer.parentNode) {
        state.labelLayer.parentNode.removeChild(state.labelLayer)
      }
      state.scopeViews.clear()
      state.nodeIndex.clear()
      state.starBatches = []
      state.labels = []
    },
  }
  return controller
}
