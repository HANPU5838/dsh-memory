/**
 * dsh-memory — 客户端半边(设置页「记忆系统」区块)。
 *
 * 合并后本 bundle 与 provider / 工具 / 注入同属一个 npm 包
 * `@restregular/dsh-memory`:一个包名、一条 Loader entry、两侧都在。
 * 拆成两个包时这里曾是 '@restregular/dsh-memory-panel'。
 *
 * 与 dsh-meme / dshmarket 客户端同款形态:
 *   - window.__ModuleLoader__.load({id, factory(require)}):**id 必须等于包名**
 *     (client-modules 按包名建图行;声明成别的名字会让宿主找不到该行、回退重拉
 *      同一个 bundle → 二次注册 → "duplicate factory registration" 启动失败);
 *     而且 client bundle 只为「有活 Loader entry 且该 entry 解析到包名」的包服务,
 *     所以这个 id 与 patch 里那一行的 name 必须同时是本包名。
 *   - exports.inject = ['slots'](dsh-client-ui-slots 在 desktop 宿主 asar 里存在);
 *   - ctx.get('slots') 判空防御,缺 slots 就静默退出,绝不让 client boot 失败;
 *   - 数据走 /memory/api HTTP(服务端半边注册的 prefix 路由);
 *   - 颜色全走宿主 --dsw-alias-* 主题 token,深浅色自适应,零硬编码色值。
 */
window.__ModuleLoader__.load({
  id: '@restregular/dsh-memory',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /**
     * 0.25.8：把「记忆权限」浮窗挂到 document.body 用的 portal。
     *
     * 按钮注册在 conversation.input.right，整个输入框在宿主会话的 active 阶段是
     * `.composerSeat{position:sticky; z-index:7}` —— 一个独立的层叠上下文。浮窗哪怕写
     * `position:fixed` 也只能在这个上下文里排层级，永远压不过兄弟层的「回到底部」圆钮
     * (`.toBottomSlot{z-index:8}`)，表现为圆钮盖在浮窗上面。portal 到 body 之后浮窗直接
     * 在根层叠上下文里参与排序，才真正高于 8。
     *
     * react-dom 由宿主的 ModuleLoader 以 seed word 提供(宿主自己与 dshmarket / rewind
     * 等插件的 client bundle 都 require 它)。拿不到就退回原地渲染：层级受限，但不报错。
     */
    const createPortal = (() => {
      try {
        const dom = require('react-dom')
        return dom && typeof dom.createPortal === 'function' ? dom.createPortal : null
      } catch { return null }
    })()

    const API = '/memory/api'

    const CSS = [
      '.memp{display:flex;flex-direction:column;gap:14px;padding:2px 0;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.memp .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.memp .toolbar input[type=text]{flex:1;min-width:170px;max-width:320px}',
      '.memp .linkbtn{background:none;border:none;padding:2px 4px;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.memp .linkbtn:hover{color:var(--dsw-alias-brand-primary);border:none}',
      // 概览
      '.memp .stats{display:flex;gap:10px;flex-wrap:wrap}',
      '.memp .stat{min-width:104px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:8px 14px;background:var(--dsw-alias-bg-layer-1)}',
      '.memp .stat b{display:block;font-size:17px;font-weight:600;line-height:1.35}',
      '.memp .stat span{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.memp .muted{font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.memp .mono{font-family:var(--ds-font-family-code, ui-monospace, monospace);font-size:11px;color:var(--dsw-alias-label-secondary)}',
      // 向量服务
      '.memp .server{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:8px}',
      '.memp .server-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.memp .server-spacer{flex:1}',
      '.memp .dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-border-l1)}',
      '.memp .dot.on{background:var(--dsw-alias-brand-primary)}',
      '.memp .dot.off{background:var(--dsw-alias-label-danger, #e05555)}',
      '.memp .pill{font-size:11px;line-height:1.7;padding:0 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);flex:none}',
      '.memp .hint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}',
      '.memp .hint code,.memp .mono code{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:5px;padding:0 4px}',
      // 控件
      '.memp input[type=text],.memp input[type=search],.memp select,.memp input[type=number]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 10px;font-size:13px;outline:none}',
      '.memp input[type=text]:focus,.memp input[type=search]:focus,.memp select:focus,.memp textarea:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.memp textarea{width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 10px;font-size:13px;outline:none;resize:vertical;font-family:inherit}',
      '.memp button{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:5px 12px;font-size:13px;cursor:pointer;transition:border-color .12s ease,color .12s ease}',
      // hover 只改边框与文字颜色。**不要**再叠 box-shadow:那会在边框外多出一圈线
      // (看起来就是"双层边框"),鼠标移开时又容易被看成残留。
      '.memp button:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      // 点击后浏览器给的 focus 环同理:鼠标操作不留痕,键盘操作仍可见。
      '.memp button:focus{outline:none}',
      '.memp button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.memp button:disabled{opacity:.5;cursor:default;border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}',
      // 服务器开关(switch 造型)。配色照抄宿主 [role=switch]:
      //   - 关闭态轨道 border-l3(border-l1 只有 ~6% 透明度,深浅色下都几乎看不见);
      //   - 圆点关闭态 switch-thumb、开启态 label-primary-foreground。
      // 深色主题的 brand-primary 是近白色,圆点写死 #fff 会直接融进轨道里。
      '.memp .toggle{display:inline-flex;align-items:center;gap:8px;padding:4px 12px 4px 5px}',
      '.memp .toggle-track{width:34px;height:18px;border-radius:999px;background:var(--dsw-alias-border-l3);position:relative;transition:background .15s ease;flex:none;display:inline-block}',
      '.memp .toggle.on .toggle-track{background:var(--dsw-alias-brand-primary)}',
      '.memp .toggle-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-switch-thumb);box-shadow:0 1px 3px rgba(0,0,0,.25);transition:transform .15s ease,background .15s ease}',
      '.memp .toggle.on .toggle-knob{transform:translateX(16px);background:var(--dsw-alias-label-primary-foreground)}',
      // 记忆列表:一条一行时信息密度优先
      '.memp .list{display:flex;flex-direction:column;gap:8px}',
      '.memp .rec{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:9px 12px;background:var(--dsw-alias-bg-layer-1)}',
      '.memp .rec:hover{border-color:var(--dsw-alias-brand-primary)}',
      '.memp .rec-head{display:flex;gap:7px;align-items:center;font-size:11.5px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none}',
      '.memp .rec-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:6px}',
      '.memp .chev{font-size:9px;opacity:.6;width:9px;flex:none;transition:transform .12s ease}',
      '.memp .chev.open{transform:rotate(90deg)}',
      '.memp .badge{border:1px solid var(--dsw-alias-border-l1);border-radius:5px;padding:0 6px;line-height:1.7;color:var(--dsw-alias-label-secondary);flex:none}',
      '.memp .badge.scope{color:var(--dsw-alias-brand-primary);max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.memp .badge.corrected{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.memp .badge.expired{color:#C0563B;border-color:color-mix(in srgb,#C0563B 55%,transparent)}',
      '.memp .tags{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}',
      '.memp .tag{font-size:11px;line-height:1.7;padding:0 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}',
      '.memp .meta{display:flex;align-items:center;gap:8px;margin-top:8px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.memp .meta-id{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px;padding:1px 6px;border-radius:5px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);cursor:pointer;user-select:all}',
      '.memp .meta-id:hover{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.memp .meta-done{color:var(--dsw-alias-brand-primary);font-size:11.5px}',
      '.memp .footer{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:2px;margin-top:18px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1);font-size:12px;color:var(--dsw-alias-label-secondary);text-align:center}',
      '.memp .footer a{color:var(--dsw-alias-brand-primary);text-decoration:none}',
      '.memp .footer a:hover{text-decoration:underline}',
      '.memp .pending{flex:none}',
      '.memp .time{margin-left:auto;flex:none}',
      '.memp .preview{margin-top:7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary);line-height:1.5}',
      '.memp .content{margin-top:7px;white-space:pre-wrap;word-break:break-word;line-height:1.55}',
      '.memp .rec-body{margin-top:6px}',
      '.memp .acts{display:flex;gap:6px;margin-top:8px}',
      '.memp .acts button{padding:3px 10px;font-size:12px}',
      '.memp .editrow{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:6px}',
      '.memp .editrow input[type=text]{padding:4px 8px}',
      '.memp .editrow input[type=number]{width:64px;padding:4px 8px}',
      '.memp .err{color:var(--dsw-alias-label-danger, #e05555);font-size:12px}',
      '.memp .empty{color:var(--dsw-alias-label-secondary);font-size:12.5px;padding:16px 2px;text-align:center}',
      // 语义检索:搜索框旁的 toggle(轨道 + 圆点,沿用 .toggle 的宿主 token 配色,
      // 深浅色都由 --dsw-alias-switch-thumb / brand-primary / label-primary-foreground
      // 决定,不再写死颜色)+ 结果说明行 + 结果卡上的排序得分
      '.memp .toolbar .semantic{flex:none;padding:4px 10px 4px 5px}',
      '.memp .toolbar .semantic-label{font-size:12px;line-height:1.6}',
      '.memp .toolbar .semantic-state{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.memp .toolbar .semantic.on .semantic-state{color:var(--dsw-alias-brand-primary)}',
      '.memp .search-note{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary)}',
      '.memp .search-note b{font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.memp .search-note .muted{font-size:11.5px}',
      '.memp .badge.score{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent)}',
      // 维护区（卸载向量服务 / 清空记忆数据）
      '.memp .maint{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}',
      '.memp .maint-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:12.5px}',
      '.memp .maint-row .grow{flex:1;min-width:160px}',
      '.memp .path{max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.memp .danger{color:var(--dsw-alias-label-danger, #e05555);border-color:var(--dsw-alias-label-danger, #e05555)}',
      // 模型与硬件(折叠在向量服务卡片里:默认视图保持干净)
      '.memp .adv{border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px}',
      // 原生三角标记藏掉:展开/收起由左边的 .advcaret 自己画
      '.memp .adv summary{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary);outline:none;list-style:none}',
      '.memp .adv summary::-webkit-details-marker{display:none}',
      '.memp .adv summary:hover{color:var(--dsw-alias-brand-primary)}',
      '.memp .advsum{display:flex;gap:6px;align-items:center;flex-wrap:wrap}',
      '.memp .advcaret{font-size:9px;opacity:.7;flex:none}',
      '.memp .advsum .spacer{flex:1}',
      '.memp .spacer{flex:1}',
      '.memp .advbody{display:flex;flex-direction:column;gap:8px;padding-top:8px}',
      // 标签气泡(本机配置 / 当前模型 / 选项里的体积与推荐)
      // 两行都一样:一条线排开,超出就横向滚动(不换行、不挤压)
      // 但**不显示滚动条**(宽度太显眼):仍可用滚轮 / 触控板 / 拖拽滚动。
      '.memp .vec{display:flex;flex-direction:column;gap:8px}',
      '.memp .chipline{display:flex;gap:8px;align-items:center;min-width:0}',
      '.memp .chiptitle{flex:none;font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.memp .chips{display:flex;gap:6px;align-items:center;flex:1;min-width:0;flex-wrap:nowrap;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;-ms-overflow-style:none}',
      '.memp .chips .chip{flex:none}',
      '.memp .chips::-webkit-scrollbar{display:none;width:0;height:0}',
      '.memp .chip{font-size:11px;line-height:1.75;padding:0 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);white-space:nowrap}',
      '.memp .chip.rec{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.memp .chip.on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      // 自定义下拉(原生 select 画不出气泡)
      '.memp .drop{position:relative;display:inline-flex;flex-direction:column;align-items:flex-start}',
      '.memp .dropbtn{display:inline-flex;align-items:center;gap:6px;max-width:100%}',
      '.memp .dropname{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      // 模型名可能很长:按钮与列表都给个上限,超出的省略
      '.memp .drop.modeldrop .dropbtn{max-width:360px}',
      '.memp .caret{margin-left:6px;opacity:.6;font-size:10px}',
      '.memp .droplist{position:absolute;z-index:10;top:100%;left:0;margin-top:4px;max-height:264px;overflow:auto;max-width:min(90vw,460px);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 8px 24px rgba(0,0,0,.20);padding:4px}',
      '.memp .dropitem{display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:6px;cursor:pointer;white-space:nowrap;border:1px solid transparent;transition:border-color .12s ease,color .12s ease,background .12s ease}',
      // hover 的边框只出现在指针下;移开即恢复透明边框,不留痕
      '.memp .dropitem:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}',
      // 当前项不用边框做标记(容易被看成残留),改用品牌色 + 加粗的名字
      '.memp .dropitem.on{background:var(--dsw-alias-bg-layer-2)}',
      '.memp .dropitem.on .dropname{font-weight:600;color:var(--dsw-alias-brand-primary)}',
      '.memp .warn{font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      // 面板内的标签栏:分段式按钮(参照宿主设置页的分段控件)
      '.memp .tabs{display:inline-flex;gap:2px;padding:2px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);margin-bottom:14px}',
      '.memp .tab{background:none;border:0;border-radius:7px;padding:4px 14px;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:13px;line-height:1.6;transition:background .12s ease,color .12s ease}',
      '.memp .tab:hover{color:var(--dsw-alias-label-primary)}',
      '.memp .tab.on{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-brand-primary);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.10)}',
      // 标签页里的二级切换(记录 → 记忆 / 作用域):比主标签栏小一档,跟在主标签栏下面
      '.memp .subtabs{display:inline-flex;gap:2px;padding:2px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}',
      '.memp .subtab{background:none;border:0;border-radius:6px;padding:2px 12px;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;line-height:1.7;transition:background .12s ease,color .12s ease}',
      '.memp .subtab:hover{color:var(--dsw-alias-label-primary)}',
      '.memp .subtab.on{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-brand-primary);font-weight:600}',
      // 作用域清单:一行一个作用域(名称 + 条数 + 用途 + 真实键)
      '.memp .scope-row{display:flex;flex-direction:column;gap:5px;padding:9px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}',
      '.memp .scope-row:hover{border-color:var(--dsw-alias-brand-primary)}',
      '.memp .scope-row-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-size:11.5px;color:var(--dsw-alias-label-secondary);min-width:0}',
      '.memp .scope-row-name{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary);max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.memp .scope-row-desc{font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary)}',
      '.memp .scope-row-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:10.5px;color:var(--dsw-alias-label-secondary)}',
      '.memp .scope-row-key{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10.5px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      // 作用域编辑(0.29.0):用途 textarea + 可选别名输入,动作行只有保存 / 取消
      '.memp .scope-edit{display:flex;flex-direction:column;gap:5px;padding:2px 0 4px}',
      '.memp .scope-edit label{font-size:10.5px;color:var(--dsw-alias-label-secondary)}',
      '.memp .scope-edit textarea{width:100%;min-height:46px;resize:vertical;font-size:12px;line-height:1.5}',
      '.memp .scope-edit input[type=text]{width:100%;font-size:12px}',
      '.memp .scope-edit-actions{display:flex;gap:6px;padding-top:2px}',
      '.memp .scope-edit-actions button{padding:3px 12px;font-size:11.5px}',
      // 记录视图:各区块之间留出呼吸感(之前全贴在一起)
      '.memp .memp-body > * + *{margin-top:14px}',
      '.memp .stats{margin-bottom:0}',
      '.memp .setrow{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;padding:11px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.memp .setrow .set-title{min-width:112px;font-weight:600;font-size:13px}',
      '.memp .setrow .set-desc{flex:1 1 100%;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.memp .setrow .set-field{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.memp .setrow input[type=number]{width:78px}',
      // 开关:与向量服务的 toggle 同一套视觉(轨道 + 圆点),配色同宿主 switch。
      // 深色主题下开启态轨道是近白色,圆点必须用 label-primary-foreground 才看得见;
      // 关闭态轨道用 border-l3、圆点用 switch-thumb,避免"只剩一个白点"。
      '.memp .switch{position:relative;width:34px;height:20px;padding:0;border:0;border-radius:999px;background:var(--dsw-alias-border-l3);cursor:pointer;transition:background .12s ease}',
      '.memp .switch.on{background:var(--dsw-alias-brand-primary)}',
      '.memp .switch .knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-switch-thumb);transition:left .12s ease,background .12s ease;box-shadow:0 1px 2px rgba(0,0,0,.25)}',
      '.memp .switch.on .knob{left:16px;background:var(--dsw-alias-label-primary-foreground)}',
      '.memp .setfoot{display:flex;align-items:center;gap:10px;padding-top:12px}',
      // 新版设置页:卡片 + 可见 label + 状态文案 + 字段说明
      '.memp .setp{display:flex;flex-direction:column;gap:10px}',
      '.memp .sethead{display:flex;align-items:flex-end;gap:12px;padding:0 2px 2px}',
      '.memp .sethead-text{flex:1;min-width:0}',
      '.memp .sethead-title{font-size:14px;font-weight:600;line-height:1.35}',
      '.memp .sethead-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.5;margin-top:2px}',
      '.memp .sethead-saved{flex:none;font-size:11.5px;color:var(--dsw-alias-brand-primary);padding-bottom:2px}',
      '.memp .setcards{display:flex;flex-direction:column;gap:9px}',
      '.memp .setcard{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}',
      '.memp .setcard-head{display:flex;align-items:flex-start;gap:14px;padding:11px 13px;background:linear-gradient(120deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 5%,var(--dsw-alias-bg-layer-1)),var(--dsw-alias-bg-layer-1) 62%)}',
      '.memp .setcard-heading{flex:1;min-width:0}',
      '.memp .setcard-title{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;line-height:1.4}',
      '.memp .setcard-desc{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.55;margin-top:3px}',
      '.memp .setcard-pill{font-size:10px;font-weight:400;line-height:1.7;padding:0 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.memp .setcard-enable{display:flex;align-items:center;gap:6px;flex:none;padding-top:1px}',
      '.memp .setcard-enable-label{font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.memp .setcard-enable-state{font-size:10px;color:var(--dsw-alias-label-secondary);min-width:42px;text-align:right}',
      '.memp .setcard-body{display:grid;grid-template-columns:repeat(auto-fit,minmax(245px,1fr));gap:8px;padding:11px 13px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
      '.memp .setcard-body.data-body{display:block}',
      '.memp .setcard-note{padding:0 13px 11px;font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.5}',
      '.memp .setfield{display:flex;align-items:center;gap:10px;min-width:0;padding:7px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-2)}',
      '.memp .setfield-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.memp .setfield-label{font-size:12px;font-weight:500;line-height:1.45;color:var(--dsw-alias-label-primary)}',
      '.memp .setfield-hint{font-size:10.5px;line-height:1.45;color:var(--dsw-alias-label-secondary)}',
      '.memp .setfield-control{display:flex;align-items:center;gap:5px;flex:none}',
      '.memp .setfield-state{font-size:10px;color:var(--dsw-alias-label-secondary);min-width:38px;text-align:right}',
      '.memp .setfield input[type=number]{width:82px;padding:4px 7px;background:var(--dsw-alias-bg-layer-1)}',
      '.memp .setcard-body .autorecall{grid-column:1/-1}',
      '.memp .setcard-body .autorecall textarea{min-height:132px;background:var(--dsw-alias-bg-layer-1)}',
      '.memp .setcard.datacard .setcard-head{background:var(--dsw-alias-bg-layer-1)}',
      '@media (max-width:560px){.memp .setcard-head{flex-wrap:wrap}.memp .setcard-enable{margin-left:auto}.memp .setcard-body{grid-template-columns:1fr}}',
      '.memp .autorecall{flex:1 1 100%;display:flex;flex-direction:column;gap:6px;margin-top:6px}',
      '.memp .autorecall textarea{min-height:150px;font-family:var(--ds-font-family-code, ui-monospace, monospace);font-size:11px;line-height:1.5}',
      '.memp .autorecall .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.memp .create{padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;margin:8px 0;background:var(--dsw-alias-bg-layer-2)}',
      '.memp .create .row{display:flex;gap:8px;align-items:center;margin:6px 0;flex-wrap:wrap}',
      '.memp .create textarea{width:100%;min-height:64px}',
      '.memp .data{padding-top:4px}',
      '.memp .data .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:8px}',
      // 数据页:列表在独立滚动容器里,记忆多也不把面板撑长
      '.memp .scroll{max-height:min(52vh,460px);overflow-y:auto;overscroll-behavior:contain;padding:2px 8px 2px 2px;margin-right:-2px}',
      '.memp .scroll.is-empty{max-height:none;overflow:visible;padding-right:0}',
      // 自定义滚动条:细、圆头、透明轨道,hover 才加深;Firefox 用 scrollbar-width/color
      '.memp .scroll{scrollbar-width:thin;scrollbar-color:color-mix(in srgb, var(--dsw-alias-label-secondary) 30%, transparent) transparent}',
      '.memp .scroll::-webkit-scrollbar{width:8px;height:8px}',
      '.memp .scroll::-webkit-scrollbar-track{background:transparent}',
      '.memp .scroll::-webkit-scrollbar-thumb{background:rgba(127,127,127,.28);background:color-mix(in srgb, var(--dsw-alias-label-secondary) 30%, transparent);border-radius:999px;border:2px solid transparent;background-clip:padding-box}',
      '.memp .scroll::-webkit-scrollbar-thumb:hover{background:rgba(127,127,127,.5);background:color-mix(in srgb, var(--dsw-alias-label-secondary) 55%, transparent);border:2px solid transparent;background-clip:padding-box}',
      '.memp .scroll::-webkit-scrollbar-corner{background:transparent}',
      '.memp .list{display:flex;flex-direction:column;gap:8px;padding-bottom:4px}',
      // 侧栏入口打开的主界面页面:整块可滚动,内容用面板本体
      '.mem-page{height:100%;overflow:auto;padding:16px 20px 40px}',
      // 主界面里空间更大:列表容器跟着视口长高,别停在设置面板那档 62vh
      '.mem-page .memp .scroll{max-height:calc(100vh - 340px)}',
      '.mem-page-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}',
      '.mem-page-head h2{font-size:15px;font-weight:600;margin:0}',
      // ===== 记忆树 =====
      // 结构:统计 → 工具条/类型图例 → 画布(HTML 节点 + SVG 连线) → 右侧详情抽屉。
      // 节点用 HTML 而不是 SVG <text>:内容换行、省略号、悬停过渡都由浏览器排版,
      // SVG 只负责画连接线,缩放时整体 transform。
      '.memp .tree-tab{display:flex;flex-direction:column;gap:12px}',
      '.memp .tree-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}',
      '.memp .tree-stats .stat{position:relative;overflow:hidden;padding:8px 12px 7px;border-radius:11px;background:linear-gradient(160deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,var(--dsw-alias-bg-layer-1)),var(--dsw-alias-bg-layer-1) 72%)}',
      '.memp .tree-stats .stat::after{content:"";position:absolute;right:-14px;top:-20px;width:56px;height:56px;border-radius:50%;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 9%,transparent);pointer-events:none}',
      '.memp .tree-stats .stat b{font-size:18px}',
      '.memp .tree-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.memp .tree-toolbar input[type=text]{flex:1 1 190px;min-width:150px;max-width:300px}',
      '.memp .tree-toolbar .spacer{flex:1}',
      '.memp .tree-toolbar button{padding:5px 10px;font-size:12px}',
      // 工具条里的类型胶囊沿用 kchip 的圆角与内边距,不被上面的通用 button 规则撑高。
      '.memp .tree-toolbar .kchip{padding:1px 9px 1px 7px;line-height:1.8;border-radius:999px;font-size:11.5px}',
      '.memp .tree-toolbar .linkbtn{padding:2px 4px;border:0;background:none}',
      '.memp .kindbar{display:flex;gap:6px;align-items:center;flex-wrap:wrap;min-width:0}',
      '.memp .kindbar-label{font-size:11.5px;color:var(--dsw-alias-label-secondary);flex:none}',
      '.memp .kchip{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 9px 1px 7px;font-size:11.5px;line-height:1.8;cursor:pointer;transition:opacity .12s ease,border-color .12s ease,color .12s ease,background .12s ease}',
      '.memp .kchip .tdot{width:7px;height:7px;border-radius:50%;background:var(--k);box-shadow:0 0 0 3px color-mix(in srgb,var(--k) 15%,transparent)}',
      '.memp .kchip b{font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.memp .kchip.off{opacity:.42;background:transparent}',
      '.memp .kchip.on{color:var(--dsw-alias-label-primary);border-color:color-mix(in srgb,#D9A441 45%,var(--dsw-alias-border-l1));background:color-mix(in srgb,#D9A441 8%,var(--dsw-alias-bg-layer-1))}',
      '.memp .kchip:hover{border-color:var(--k);color:var(--dsw-alias-label-primary)}',
      '.memp .kchip .corr-swatch{width:14px;border-top:1.5px dashed #D9A441}',
      '.memp .tree-matchinfo{font-size:11px;color:var(--dsw-alias-label-secondary);flex:none}',
      '.memp .tree-wrap{position:relative;height:min(56vh,560px);min-height:320px;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;overflow:hidden;background:radial-gradient(circle at 16% 8%,color-mix(in srgb,var(--dsw-alias-brand-primary) 9%,transparent),transparent 44%),radial-gradient(circle at 1px 1px,color-mix(in srgb,var(--dsw-alias-label-secondary) 15%,transparent) 1px,transparent 0) 0 0/22px 22px,var(--dsw-alias-bg-layer-1)}',
      '.mem-page .memp .tree-wrap{height:calc(100vh - 360px);min-height:420px}',
      '.memp .tree-scroll{height:100%;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--dsw-alias-label-secondary) 30%,transparent) transparent}',
      '.memp .tree-scroll::-webkit-scrollbar{width:9px;height:9px}',
      '.memp .tree-scroll::-webkit-scrollbar-track{background:transparent}',
      '.memp .tree-scroll::-webkit-scrollbar-thumb{background:rgba(127,127,127,.28);background:color-mix(in srgb,var(--dsw-alias-label-secondary) 30%,transparent);border-radius:999px;border:2px solid transparent;background-clip:padding-box}',
      '.memp .tree-scroll::-webkit-scrollbar-thumb:hover{background:rgba(127,127,127,.5);background:color-mix(in srgb,var(--dsw-alias-label-secondary) 55%,transparent);border:2px solid transparent;background-clip:padding-box}',
      '.memp .tree-scroll::-webkit-scrollbar-corner{background:transparent}',
      '.memp .tree-zoomspace{position:relative;margin:0 auto}',
      '.memp .tree-canvas{position:relative;transform-origin:0 0;transition:transform .16s ease}',
      '.memp .tree-edges{position:absolute;inset:0;overflow:visible;pointer-events:none}',
      '.memp .edge{fill:none;stroke:color-mix(in srgb,var(--dsw-alias-label-secondary) 40%,transparent);stroke-width:1.2;transition:opacity .15s ease,stroke .15s ease,stroke-width .15s ease}',
      '.memp .edge.active{stroke:var(--dsw-alias-brand-primary);stroke-width:1.8;opacity:.95}',
      '.memp .tree-canvas.focused .edge:not(.active){opacity:.28}',
      '.memp .corr-edge{fill:none;stroke:#D9A441;stroke-width:1.25;stroke-dasharray:4 3;opacity:.5;transition:opacity .15s ease,stroke-width .15s ease}',
      '.memp .corr-edge.active{opacity:1;stroke-width:2;stroke-dasharray:none}',
      '.memp .tree-canvas.focused .corr-edge:not(.active){opacity:.14}',
      '.memp .corr-dot{fill:#D9A441;opacity:.6;transition:opacity .15s ease}',
      '.memp .corr-dot.active{opacity:1}',
      '.memp .tree-node{position:absolute;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:11px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;user-select:none;transition:border-color .14s ease,box-shadow .14s ease,opacity .14s ease,background .14s ease;animation:memNodeIn .2s ease both}',
      '@keyframes memNodeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}',
      '.memp .tree-node.root{display:flex;align-items:center;gap:7px;padding:0 10px;border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,var(--dsw-alias-border-l1));background:linear-gradient(145deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,var(--dsw-alias-bg-layer-1)),var(--dsw-alias-bg-layer-1) 72%);box-shadow:0 6px 18px color-mix(in srgb,var(--dsw-alias-brand-primary) 13%,transparent);cursor:default}',
      '.memp .tree-node.root .root-icon{display:inline-flex;color:var(--dsw-alias-brand-primary);flex:none}',
      '.memp .tree-node.root b{display:block;font-size:13px;line-height:1.2}',
      '.memp .tree-node.root span{display:block;font-size:10.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.memp .tree-node.scope{display:flex;align-items:center;gap:7px;padding:0 10px;background:linear-gradient(120deg,var(--dsw-alias-bg-layer-1),color-mix(in srgb,var(--dsw-alias-brand-primary) 5%,var(--dsw-alias-bg-layer-1)))}',
      '.memp .tree-node.scope:hover,.memp .tree-node.kind:hover{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 60%,var(--dsw-alias-border-l1))}',
      '.memp .tn-ico{flex:none;width:20px;height:20px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;font-size:10.5px;font-weight:600;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-brand-primary)}',
      '.memp .tn-scope{flex:1;min-width:0;font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.memp .tn-count{flex:none;font-size:10.5px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:0 6px;line-height:1.6;background:var(--dsw-alias-bg-layer-2)}',
      '.memp .tn-caret{flex:none;font-size:9px;color:var(--dsw-alias-label-secondary);opacity:.8}',
      '.memp .tree-node.collapsed{border-style:dashed}',
      '.memp .tree-node.kind{display:flex;align-items:center;gap:6px;padding:0 9px;border-radius:9px;border-left:3px solid var(--k)}',
      '.memp .tree-node.kind .tn-name{flex:1;min-width:0;font-size:11.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.memp .tree-node.kind .tdot{width:6px;height:6px;border-radius:50%;background:var(--k);flex:none}',
      '.memp .tree-node.record{padding:6px 9px 6px 12px;display:flex;flex-direction:column;gap:4px;box-shadow:0 1px 2px rgba(0,0,0,.04)}',
      '.memp .tree-node.record::before{content:"";position:absolute;left:0;top:8px;bottom:8px;width:3px;border-radius:999px;background:var(--k);opacity:.85}',
      '.memp .tree-node.record:hover{border-color:var(--k);box-shadow:0 6px 16px color-mix(in srgb,var(--k) 16%,transparent)}',
      '.memp .tree-node.record.selected{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,transparent),0 8px 20px rgba(0,0,0,.10)}',
      '.memp .tree-node.record.related{border-color:color-mix(in srgb,var(--k) 70%,var(--dsw-alias-border-l1))}',
      '.memp .tree-node.record.miss{opacity:.28}',
      '.memp .tree-node.record.match{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary) 32%,transparent)}',
      '.memp .tree-canvas.focused .tree-node.record:not(.related){opacity:.55}',
      '.memp .tn-head{display:flex;align-items:center;gap:5px;min-width:0;font-size:10.5px;color:var(--dsw-alias-label-secondary)}',
      '.memp .tn-head .tdot{width:6px;height:6px;border-radius:50%;background:var(--k);flex:none}',
      '.memp .tn-kind{font-weight:600;color:var(--dsw-alias-label-primary);letter-spacing:.02em;flex:none}',
      '.memp .tn-badge{border-radius:999px;padding:0 5px;line-height:1.55;font-size:9.5px;border:1px solid transparent;flex:none}',
      '.memp .tn-badge.corr{color:color-mix(in srgb,#D9A441 62%,var(--dsw-alias-label-primary));background:color-mix(in srgb,#D9A441 14%,transparent);border-color:color-mix(in srgb,#D9A441 35%,transparent)}',
      '.memp .tn-badge.old{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1)}',
      '.memp .tn-badge.expired{color:color-mix(in srgb,#C0563B 70%,var(--dsw-alias-label-primary));background:color-mix(in srgb,#C0563B 12%,transparent);border-color:color-mix(in srgb,#C0563B 30%,transparent)}',
      '.memp .tn-time{margin-left:auto;flex:none;font-size:9.5px;opacity:.75}',
      '.memp .tn-content{font-size:11.5px;line-height:1.45;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}',
      '.memp .tree-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:1.6;text-align:center;padding:24px;z-index:1}',
      '.memp .tree-empty .big{font-size:22px;opacity:.65}',
      '.memp .tree-empty button{padding:4px 12px;font-size:12px}',
      '.memp .tree-zoom{position:absolute;right:10px;bottom:10px;display:flex;align-items:center;gap:1px;padding:3px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 88%,transparent);backdrop-filter:blur(6px);box-shadow:0 4px 14px rgba(0,0,0,.12);z-index:3}',
      '.memp .tree-zoom button{background:none;border:0;padding:2px 8px;border-radius:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.memp .tree-zoom button:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary)}',
      '.memp .tree-zoom .zoomval{font-size:10.5px;min-width:38px;text-align:center;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.memp .tree-legend{position:absolute;left:10px;bottom:10px;display:flex;gap:10px;align-items:center;font-size:10.5px;color:var(--dsw-alias-label-secondary);padding:3px 9px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 88%,transparent);border:1px solid var(--dsw-alias-border-l1);backdrop-filter:blur(6px);z-index:2;pointer-events:none}',
      '.memp .tree-legend .line{display:inline-block;width:18px;height:0;border-top:1.5px dashed #D9A441;margin-right:4px;vertical-align:middle}',
      '.memp .tree-detail{position:absolute;z-index:4;top:10px;left:10px;bottom:10px;width:min(322px,calc(100% - 20px));display:flex;flex-direction:column;gap:10px;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 96%,transparent);backdrop-filter:blur(10px);box-shadow:0 16px 42px rgba(0,0,0,.22);overflow:auto;font-size:11.5px;scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--dsw-alias-label-secondary) 30%,transparent) transparent}',
      '.memp .tree-detail::-webkit-scrollbar{width:8px}',
      '.memp .tree-detail::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 30%,transparent);border-radius:999px;border:2px solid transparent;background-clip:padding-box}',
      '.memp .td-head{display:flex;align-items:center;gap:6px}',
      '.memp .td-head .td-title{font-weight:600;font-size:12px}',
      '.memp .td-close{margin-left:auto;background:none;border:0;font-size:15px;line-height:1;padding:2px 4px;color:var(--dsw-alias-label-secondary)}',
      '.memp .td-close:hover{color:var(--dsw-alias-brand-primary)}',
      '.memp .td-scope{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary);padding-bottom:8px;border-bottom:1px solid var(--dsw-alias-border-l1);min-width:0}',
      '.memp .td-scope .tn-scope{font-size:11px;font-weight:500}',
      '.memp .td-content{font-size:12.5px;line-height:1.62;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary)}',
      '.memp .td-tags{display:flex;flex-wrap:wrap;gap:4px}',
      '.memp .td-meta{display:flex;flex-direction:column;gap:5px;font-size:10.5px;color:var(--dsw-alias-label-secondary);padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.memp .td-meta .rowline{display:flex;align-items:center;gap:6px;min-width:0}',
      '.memp .td-meta .rowline b{font-weight:500;color:var(--dsw-alias-label-primary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.memp .td-impbar{flex:1;height:4px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}',
      '.memp .td-impbar i{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent),var(--dsw-alias-brand-primary))}',
      '.memp .td-id{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:9.5px;padding:1px 5px;border-radius:5px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);cursor:pointer;user-select:all;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.memp .td-rel{display:flex;flex-direction:column;gap:5px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.memp .td-rel-label{font-size:10px;color:var(--dsw-alias-label-secondary);letter-spacing:.04em}',
      '.memp .td-rel-btn{display:flex;align-items:flex-start;gap:6px;text-align:left;padding:6px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);font-size:10.5px;line-height:1.45}',
      '.memp .td-rel-dir{flex:none;color:color-mix(in srgb,#D9A441 62%,var(--dsw-alias-label-primary));font-weight:600}',
      '.memp .td-rel-text{color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}',
      '@media (max-width:620px){.memp .tree-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.memp .tree-toolbar input[type=text]{max-width:none}}',
      // ===== 审计 =====
      '.memp .audit{display:flex;flex-direction:column;gap:10px;min-height:0;height:calc(100vh - 210px);max-height:calc(100vh - 210px);overflow:hidden}',
      '.memp .audit-head{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap}',
      '.memp .audit-title{font-size:16px;font-weight:650;line-height:1.35}',
      '.memp .audit-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.55;margin-top:2px}',
      '.memp .audit-mode{margin-left:auto;display:flex;gap:6px;align-items:center;flex-wrap:wrap}',
      '.memp .audit-inline-note{font-size:10.5px;color:var(--dsw-alias-brand-primary);white-space:nowrap}',
      '.memp .audit-banner{border:1px solid color-mix(in srgb,#D9A441 42%,var(--dsw-alias-border-l1));background:color-mix(in srgb,#D9A441 9%,transparent);border-radius:9px;padding:7px 10px;font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary)}',
      '.memp .audit-banner.bad{border-color:color-mix(in srgb,var(--dsw-alias-label-danger, #e05555) 45%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-label-danger, #e05555) 8%,transparent)}',
      '.memp .audit-stats{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px}',
      '.memp .audit-stat{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:7px 10px;min-width:0}',
      '.memp .audit-stat b{display:block;font-size:17px;line-height:1.3;font-weight:650;font-variant-numeric:tabular-nums}',
      '.memp .audit-stat span{display:block;font-size:10.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.memp .audit-toolbar{display:flex;flex-direction:column;gap:7px;padding:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}',
      '.memp .audit-filter-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap;min-width:0}',
      '.memp .audit-filter-row .dropbtn{padding:4px 9px}',
      '.memp .audit-filter-row .spacer{flex:1;min-width:8px}',
      '.memp .audit-filter-row input[type=text],.memp .audit-filter-row input[type=search]{min-width:150px;max-width:230px;padding:4px 8px}',
      '.memp .audit-filter-row input.audit-search{flex:1;min-width:180px;max-width:340px}',
      '.memp .audit-filter-row input.audit-trigger{max-width:240px}',
      '.memp .audit-filter-row input.audit-date{width:116px;min-width:0}',
      '.memp .audit-switch{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;padding:2px 4px;border-radius:7px}',
      '.memp .audit-switch .switch{width:30px;height:16px;padding:0;flex:none}',
      '.memp .audit-switch .switch .knob{width:12px;height:12px;top:2px;left:2px}',
      '.memp .audit-switch .switch.on .knob{left:16px}',
      '.memp .audit-filter-sub{padding-top:1px}',
      '.memp .audit-range-sep{color:var(--dsw-alias-label-secondary);font-size:11px;flex:none}',
      '.memp .audit-split{display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr);gap:10px;min-height:0;flex:1;overflow:hidden;align-items:stretch}',
      '.memp .audit-split.has-detail{grid-template-columns:minmax(0,1fr) minmax(300px,360px)}',
      '.memp .audit-list-wrap{display:flex;flex-direction:column;min-height:0;min-width:0;overflow:hidden}',
      '.memp .audit-table-head{display:grid;grid-template-columns:62px 140px minmax(150px,1.3fr) minmax(110px,0.8fr) 112px minmax(108px,0.9fr) 92px;gap:8px;align-items:center;position:sticky;top:0;z-index:2;box-sizing:border-box;padding:6px 9px;margin-bottom:2px;font-size:10px;letter-spacing:.03em;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border:1px solid transparent;border-bottom-color:var(--dsw-alias-border-l1)}',
      '.memp .audit-table-head span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.memp .audit-list{display:flex;flex-direction:column;gap:5px;min-width:0;flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;padding:5px 4px 1px 1px;scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--dsw-alias-label-secondary) 30%,transparent) transparent}',
      '.memp .audit-list::-webkit-scrollbar{width:8px}',
      '.memp .audit-list::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 28%,transparent);border-radius:999px;border:2px solid transparent;background-clip:padding-box}',
      '.memp .audit-list::-webkit-scrollbar-track{background:transparent}',
      '.memp .audit-row{display:grid;grid-template-columns:62px 140px minmax(150px,1.3fr) minmax(110px,0.8fr) 112px minmax(108px,0.9fr) 92px;gap:8px;align-items:center;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1);padding:6px 9px;font-size:11.5px;cursor:pointer;text-align:left;color:inherit;width:100%}',
      '.memp .audit-row:hover{border-color:var(--dsw-alias-brand-primary)}',
      '.memp .audit-row.on{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 6%,var(--dsw-alias-bg-layer-1))}',
      '.memp .audit-row .m{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.memp .audit-row .t{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10.5px;color:var(--dsw-alias-label-secondary)}',
      '.memp .audit-row .ch{font-weight:600}',
      '.memp .audit-row .trig{color:var(--dsw-alias-label-secondary);font-size:10.5px}',
      '.memp .audit-row .nums{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}',
      '.memp .audit-row .del{font-size:10.5px}',
      '.memp .audit-pill{display:inline-flex;align-items:center;gap:4px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);padding:0 6px;line-height:1.65;font-size:10px;white-space:nowrap;max-width:100%}',
      '.memp .audit-pill.ok{color:color-mix(in srgb,#2E9B68 78%,var(--dsw-alias-label-primary));border-color:color-mix(in srgb,#2E9B68 38%,var(--dsw-alias-border-l1))}',
      '.memp .audit-pill.warn{color:color-mix(in srgb,#D9A441 82%,var(--dsw-alias-label-primary));border-color:color-mix(in srgb,#D9A441 42%,var(--dsw-alias-border-l1))}',
      '.memp .audit-pill.bad{color:var(--dsw-alias-label-danger, #e05555);border-color:color-mix(in srgb,var(--dsw-alias-label-danger, #e05555) 42%,var(--dsw-alias-border-l1))}',
      '.memp .audit-pill.mute{color:var(--dsw-alias-label-secondary)}',
      '.memp .audit-empty{border:1px dashed var(--dsw-alias-border-l1);border-radius:10px;padding:26px 16px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.65}',
      '.memp .audit-detail{border:1px solid var(--dsw-alias-border-l1);border-radius:11px;background:var(--dsw-alias-bg-layer-1);padding:10px 11px 20px;box-sizing:border-box;display:flex;flex-direction:column;gap:9px;height:auto;max-height:calc(100vh - 340px);min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin}',
      '.memp .audit-detail-head{display:flex;gap:7px;align-items:center}',
      '.memp .audit-detail-head b{font-size:12.5px}',
      '.memp .audit-detail-head .spacer{flex:1}',
      '.memp .audit-close{background:none;border:0;padding:0 4px;font-size:15px;line-height:1;color:var(--dsw-alias-label-secondary)}',
      '.memp .audit-kv{display:grid;grid-template-columns:74px minmax(0,1fr);gap:4px 8px;font-size:11px;line-height:1.5}',
      '.memp .audit-kv .k{color:var(--dsw-alias-label-secondary)}',
      '.memp .audit-kv .v{min-width:0;overflow-wrap:anywhere}',
      '.memp .audit-sec{border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px;display:flex;flex-direction:column;gap:5px}',
      '.memp .audit-sec-title{font-size:10.5px;letter-spacing:.04em;color:var(--dsw-alias-label-secondary)}',
      '.memp .audit-budget{display:grid;grid-template-columns:64px minmax(0,1fr) 92px;gap:7px;align-items:center;font-size:10.5px;color:var(--dsw-alias-label-secondary)}',
      '.memp .audit-budget-compact{display:flex;align-items:center;gap:5px;min-width:0;font-size:10px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.memp .audit-budget-compact .bar{flex:1;min-width:18px;height:4px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}',
      '.memp .audit-budget-compact .bar i{display:block;height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary)}',
      '.memp .audit-budget-compact .bar i.over{background:var(--dsw-alias-label-danger, #e05555)}',
      '.memp .audit-budget-compact .num{flex:none;white-space:nowrap}',
      '.memp .audit-budget .bar{height:5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}',
      '.memp .audit-budget .bar i{display:block;height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary)}',
      '.memp .audit-budget .bar i.over{background:var(--dsw-alias-label-danger, #e05555)}',
      '.memp .audit-budget .num{text-align:right;font-variant-numeric:tabular-nums}',
      '.memp .audit-json{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10px;line-height:1.45;white-space:pre-wrap;word-break:break-word;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px;max-height:220px;overflow:auto}',
      '.memp .audit-pager{display:flex;gap:6px;align-items:center;justify-content:flex-end;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.memp .audit-flat{display:flex;flex-wrap:wrap;gap:4px}',
      '.memp .audit-id{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10px;line-height:1.65;padding:1px 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);cursor:pointer;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.memp .audit-id:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.memp .audit-id.omit{color:color-mix(in srgb,#D9A441 78%,var(--dsw-alias-label-primary));border-color:color-mix(in srgb,#D9A441 32%,var(--dsw-alias-border-l1))}',
      '.memp .audit-id.dedup{opacity:.75}',
      '.memp .audit-id-group{display:flex;flex-direction:column;gap:5px;padding:7px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 55%,transparent)}',
      '.memp .audit-id-group-title{display:flex;align-items:center;gap:6px;font-size:10.5px;color:var(--dsw-alias-label-secondary);letter-spacing:.02em}',
      '.memp .audit-id-group-title b{font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
      '.memp .audit-id-sub{font-size:9.5px;color:var(--dsw-alias-label-secondary);opacity:.85}',
      '.memp .audit-tip{position:fixed;z-index:120;max-width:min(380px,calc(100vw - 24px));max-height:min(300px,60vh);overflow:auto;padding:9px 10px;border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l1));border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 97%,black 3%);box-shadow:0 14px 36px rgba(0,0,0,.28);pointer-events:auto;cursor:pointer;color:var(--dsw-alias-label-primary)}',
      '.memp .audit-tip-head{display:flex;align-items:center;gap:6px;margin-bottom:5px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.memp .audit-tip-title{font-weight:600;color:var(--dsw-alias-label-primary);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
      '.memp .audit-tip-meta{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:5px}',
      '.memp .audit-tip-content{font-size:11px;line-height:1.55;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary);max-height:none;overflow:visible}',
      '.memp .audit-tip-foot{margin-top:6px;font-size:9.5px;color:var(--dsw-alias-label-secondary)}',
      '.memp .rec.focus{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary) 25%,transparent)}',
      // 审计 → 轨迹的精准跳转按钮：只在有锚点时出现，不抢详情头部的主操作。
      '.memp .audit-jump{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;padding:2px 7px;font-size:10.5px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.memp .audit-jump:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.memp .audit-jump[disabled]{opacity:.55;cursor:default}',
      '.memp .audit-jump-note{font-size:10px;color:var(--dsw-alias-label-secondary)}',
      // 会话视图里的「记忆审计」页：壳层已经有自己的滚动区，这里只负责头部。
      '.mem-view{display:flex;flex-direction:column;gap:10px;padding:12px 14px 6px;min-height:0;height:100%;box-sizing:border-box;overflow:hidden;color:var(--dsw-alias-label-primary)}',
      '.mem-view-head{display:flex;align-items:center;gap:9px;flex-wrap:wrap;flex:none}',
      '.mem-view-head b{font-size:14px}',
      '.mem-view-head .muted{font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.mem-view-head .spacer{flex:1}',
      // 记忆视图自己占满 viewArea，并声明 composer overlay：壳层会把 viewArea
      // 压成 flex:1 1 0 / min-height:0，滚动只发生在审计列表里，外层不再跟着滚。
      '.mem-view{display:flex;flex-direction:column;gap:10px;padding:12px 14px calc(var(--dsh-composer-height,152px) + 14px);min-height:0;height:100%;box-sizing:border-box;overflow:hidden;color:var(--dsw-alias-label-primary)}',
      '.mem-view-body{min-height:0;flex:1;display:flex;flex-direction:column;overflow:hidden}',
      '.mem-view .audit{height:100%;max-height:none;min-height:0;flex:1;overflow:hidden}',
      '.mem-view .audit-split{min-height:0}',
      '.mem-view .audit-detail{max-height:100%}',
      // 轨迹详情面板的「记忆审计」页签。Trajectory 没有行级/页签级 slot，所以
      // 按钮和面板都放在 shell.overlay 里用 fixed 定位贴着详情面板；不在 React
      // 管理的 tabs 行里插 DOM，避免被轨迹的重渲染清掉。
      '.mem-traj-audit-tab{position:fixed;z-index:71;box-sizing:border-box;display:flex;align-items:center;justify-content:center;height:26px;padding:0 8px;border:0;border-bottom:2px solid transparent;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-tertiary);font-size:13px;font-weight:500;line-height:16px;white-space:nowrap;cursor:pointer;pointer-events:auto}',
      '.mem-traj-audit-tab:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}',
      '.mem-traj-audit-tab.on{color:var(--dsw-alias-state-business-primary);border-bottom-color:var(--dsw-alias-state-business-primary)}',
      '.mem-traj-audit-pane{position:fixed;z-index:72;box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden;border-left:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);pointer-events:auto}',
      '.mem-traj-audit-pane-head{display:flex;align-items:center;gap:8px;flex:none;padding:8px 10px;border-bottom:.5px solid var(--dsw-alias-border-l1)}',
      '.mem-traj-audit-pane-head b{font-size:12px}',
      '.mem-traj-audit-pane-head .spacer{flex:1}',
      '.mem-traj-audit-pane-body{flex:1;min-height:0;overflow:auto;padding:6px 10px 10px;display:flex;flex-direction:column;gap:6px}',
      '.mem-traj-audit-pane-foot{flex:none;display:flex;gap:6px;align-items:center;padding:8px 10px;border-top:.5px solid var(--dsw-alias-border-l1)}',
      '.mem-traj-audit-pane-foot .spacer{flex:1}',
      '.mem-traj-audit-row{display:flex;flex-direction:column;gap:4px;text-align:left;width:100%;box-sizing:border-box;padding:7px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);cursor:pointer;color:inherit;font-size:11.5px}',
      '.mem-traj-audit-row:hover{border-color:var(--dsw-alias-brand-primary)}',
      '.mem-traj-audit-row-top{display:flex;align-items:center;gap:6px;min-width:0}',
      '.mem-traj-audit-row-top .t{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10px;color:var(--dsw-alias-label-secondary);flex:none}',
      '.mem-traj-audit-row-top .ch{font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mem-traj-audit-row-meta{font-size:10.5px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mem-traj-audit-row-ids{display:flex;flex-wrap:wrap;gap:3px;max-height:44px;overflow:hidden}',
      '.mem-traj-audit-empty{padding:16px 8px;color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1.6}',
      // 轨迹行上的记忆徽标：fixed 定位在选中行右侧，不改轨迹表格结构。
      '.mem-traj-chip{position:fixed;z-index:70;display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 7px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 42%,var(--dsw-alias-border-l1));border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-brand-primary);font-size:10px;line-height:1;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.18);white-space:nowrap}',
      '.mem-traj-chip:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,var(--dsw-alias-bg-layer-1))}',
      '.mem-traj-chip .dot{width:5px;height:5px;border-radius:50%;background:currentColor}',
      // 轨迹行左侧的线条图标标记（年轮）。只做指示，点击直接打开该调用的审计。
      '.mem-traj-mark{position:fixed;z-index:69;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;padding:0;border:0;border-radius:4px;background:transparent;color:color-mix(in srgb,var(--dsw-alias-brand-primary) 74%,var(--dsw-alias-label-secondary));cursor:pointer;pointer-events:auto;opacity:.9}',
      '.mem-traj-mark:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-brand-primary);opacity:1}',
      '.mem-traj-mark:focus-visible{outline:1px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
      '@media (max-width:900px){.memp .audit-split.has-detail{grid-template-columns:minmax(0,1fr)}.memp .audit-row{grid-template-columns:54px 120px 120px minmax(100px,1fr) 96px 100px 80px}.memp .audit-table-head{grid-template-columns:54px 120px 120px minmax(100px,1fr) 96px 100px 80px}}',
      '@media (max-width:620px){.memp .audit-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.memp .audit-table-head{display:none}.memp .audit-row{display:flex;flex-wrap:wrap;gap:4px 8px}.memp .audit-row .col-trigger,.memp .audit-row .col-budget{display:none}.memp .audit-row .col-nums{margin-left:auto}.memp .audit-row .col-time{order:1}.memp .audit-row .col-channel{order:2}.memp .audit-row .col-delivery{order:3}.memp .audit-row .col-outcome{order:4;margin-left:auto}.memp .audit-filter-row input[type=text],.memp .audit-filter-row input[type=search]{max-width:none;flex:1}.memp .audit{height:calc(100vh - 150px);max-height:calc(100vh - 150px)}.memp .audit-detail{max-height:calc(100vh - 280px)}}',
      '.mem-scope-wrap{display:inline-flex;min-width:0}',
      '.mem-scope-btn{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 55%,transparent);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1;cursor:pointer;flex:none;transition:border-color .12s ease,color .12s ease,background .12s ease}',
      '.mem-scope-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      // 0.20.0:数字 = 当前生效的作用域数量;边框样式 = 限制等级
      //   绝对限制 = 橙黄实线 · 普通限制 = 蓝色实线 · 无限制 = 灰色虚线
      '.mem-scope-btn.is-absolute{border-color:var(--dsw-alias-state-warn-primary,#d9a23b);color:var(--dsw-alias-state-warn-primary,#d9a23b);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d9a23b) 10%,transparent)}',
      '.mem-scope-btn.is-normal{border-color:var(--dsw-alias-state-business-primary,#4176e6);color:var(--dsw-alias-state-business-primary,#4176e6);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 10%,transparent)}',
      '.mem-scope-btn.is-none{border:1px dashed color-mix(in srgb,var(--dsw-alias-label-secondary) 55%,var(--dsw-alias-border-l1));color:var(--dsw-alias-label-secondary);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 55%,transparent)}',
      '.mem-scope-btn.is-absolute:hover,.mem-scope-btn.is-normal:hover,.mem-scope-btn.is-none:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.mem-scope-btn svg{flex:none}',
      // 毛玻璃浮窗:半透明 + backdrop blur;不支持 backdrop-filter 时退回实心底。
      // 0.25.8:z-index 80 → 900。浮窗 portal 到 body 后与宿主各层在根层叠上下文里比较:
      // 会话层的「回到底部」按钮是 z-index:8、宿主的下拉/菜单层是 100,而宿主自己的
      // 对话框 / 提示层是 1000 起 —— 取 900 保证压过会话里的所有浮动件，又不会盖住宿主弹窗。
      '.mem-scope-pop{position:fixed;z-index:900;width:340px;max-height:min(520px,72vh);display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2,var(--dsw-alias-border-l1)) 60%,transparent);border-radius:14px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 78%,transparent);-webkit-backdrop-filter:blur(20px) saturate(1.35);backdrop-filter:blur(20px) saturate(1.35);box-shadow:0 10px 28px rgba(0,0,0,.18);color:var(--dsw-alias-label-primary);font-size:13px;overflow:hidden}',
      '@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){.mem-scope-pop{background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1))}}',
      '.mem-scope-head{display:flex;align-items:center;gap:8px}',
      '.mem-scope-head h4{margin:0;font-size:13px;font-weight:600;line-height:1.4}',
      '.mem-scope-head .spacer{flex:1}',
      '.mem-scope-count{flex:none;padding:1px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:1.7}',
      '.mem-scope-pop .hint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.55}',
      '.mem-scope-level{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:5px}',
      '.mem-scope-level-btn{display:flex;flex-direction:column;align-items:flex-start;gap:1px;padding:7px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;text-align:left;cursor:pointer;transition:border-color .12s ease,background .12s ease}',
      '.mem-scope-level-btn b{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.mem-scope-level-btn span{font-size:9.5px;line-height:1.4;color:var(--dsw-alias-label-secondary)}',
      '.mem-scope-level-btn:hover{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,var(--dsw-alias-border-l1))}',
      '.mem-scope-level-btn.on{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 60%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 14%,transparent)}',
      '.mem-scope-level-btn.on b,.mem-scope-level-btn.on span{color:var(--dsw-alias-state-business-primary)}',
      '.mem-scope-note{padding:5px 8px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d9a23b) 10%,transparent);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5}',
      '.mem-scope-search{display:flex;align-items:center;gap:6px}',
      '.mem-scope-search input[type=search]{flex:1;min-width:0;padding:5px 9px;font-size:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 78%,transparent);color:var(--dsw-alias-label-primary);outline:none}',
      '.mem-scope-search input[type=search]:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.mem-scope-search .linkbtn{white-space:nowrap;padding:2px 3px;border:none;background:none;color:var(--dsw-alias-label-secondary);font-size:11px;cursor:pointer}',
      '.mem-scope-search .linkbtn:hover{color:var(--dsw-alias-brand-primary);border:none}',
      '.mem-scope-list{display:flex;flex-direction:column;gap:3px;overflow:auto;min-height:0;max-height:min(220px,32vh);padding:2px 2px 2px 0;scrollbar-width:thin}',
      '.mem-scope-list::-webkit-scrollbar{width:8px}',
      '.mem-scope-list::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 35%,transparent);border-radius:999px;border:2px solid transparent;background-clip:padding-box}',
      '.mem-scope-item{display:flex;flex-direction:column;gap:4px;padding:5px 6px;border:1px solid transparent;border-radius:10px;cursor:pointer;user-select:none}',
      '.mem-scope-item:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.mem-scope-item.on{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 38%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 8%,transparent)}',
      // 0.25.5：AI 授权的勾选与用户自己勾选要能一眼分开 —— 行用虚线边框 + 中性底，
      // 勾选框用描边（虚线、透明底、蓝勾），不再套用用户选中的实心蓝底。
      '.mem-scope-item.ai{border-style:dashed;border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 32%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-label-primary) 3%,transparent)}',
      '.mem-scope-item.ai:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.mem-scope-check.ai .box{background:transparent}',
      '.mem-scope-row{display:flex;align-items:center;gap:8px}',
      '.mem-scope-check{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border:none;background:transparent;flex:none;cursor:pointer}',
      '.mem-scope-check .box{display:flex;align-items:center;justify-content:center;width:16px;height:16px;border:1.5px solid color-mix(in srgb,var(--dsw-alias-label-secondary) 52%,var(--dsw-alias-border-l1));border-radius:5px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent);color:var(--dsw-alias-label-primary-foreground);transition:background .12s ease,border-color .12s ease}',
      '.mem-scope-check.on .box{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground)}',
      '.mem-scope-check.on.ai .box{background:transparent;border-style:dashed;border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 72%,var(--dsw-alias-border-l1));color:var(--dsw-alias-state-business-primary,#4176e6)}',
      '.mem-scope-check:focus-visible{outline:1px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
      '.mem-scope-label{flex:1;min-width:0;padding:0;border:none;background:transparent;color:var(--dsw-alias-label-primary);font-size:12.5px;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}',
      '.mem-scope-label:hover{color:var(--dsw-alias-brand-primary);border:none}',
      '.mem-scope-row .cnt{flex:none;color:var(--dsw-alias-label-secondary);font-size:10.5px}',
      // 0.25.11:显示名与真实键不一致时露出完整键(项目别名→路径、会话短 id→uuid、
      // 自定义名→裸键)。**不手工截断**:容器多宽就显示多少,放不下按 CSS 省略 ——
      // 与勾选框左对齐,字号比名字小一档,便于扫读又不会抢戏。
      '.mem-scope-key{min-width:0;padding:0 0 0 26px;font-family:var(--ds-font-family-code, ui-monospace, monospace);font-size:10px;line-height:1.45;color:color-mix(in srgb,var(--dsw-alias-label-secondary) 88%,transparent);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.mem-scope-item:hover .mem-scope-key{color:var(--dsw-alias-label-secondary)}',
      // 0.23.0:每个作用域的状态按钮行 —— 绑定 | 可读 | 可写。
      '.mem-scope-state-row{display:flex;align-items:center;gap:4px;padding-left:26px}',
      '.mem-scope-state{padding:1px 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:1.65;cursor:pointer;transition:border-color .12s ease,background .12s ease,color .12s ease}',
      '.mem-scope-state:hover:not(:disabled){border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,var(--dsw-alias-border-l1));color:var(--dsw-alias-label-primary)}',
      '.mem-scope-state.on{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 58%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 14%,transparent);color:var(--dsw-alias-state-business-primary)}',
      '.mem-scope-state.bind.on{border-style:dashed}',
      '.mem-scope-state.bind.locked{opacity:.82;cursor:default}',
      '.mem-scope-state:disabled{opacity:.42;cursor:default}',
      '.mem-scope-state:focus-visible{outline:1px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
      '.mem-scope-sep{width:1px;height:12px;margin:0 1px;background:var(--dsw-alias-border-l1);flex:none}',
      // 0.25.3：Agent 授权用「勾选 + AI 气泡」呈现，气泡挂在作用域名称右边。
      '.mem-scope-ai{flex:none;font-size:9.5px;line-height:1.7;padding:0 6px;border-radius:999px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 45%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 12%,transparent);color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 78%,var(--dsw-alias-label-primary));white-space:nowrap;cursor:help}',
      '.mem-scope-ai.inherited{border-style:dashed;background:transparent;color:var(--dsw-alias-label-secondary)}',
      '.mem-scope-ai.pending{opacity:.62;border-style:dashed;text-decoration:line-through}',
      '.mem-scope-foot{display:flex;align-items:center;gap:8px}',
      '.mem-scope-foot .spacer{flex:1}',
      '.mem-scope-reset{padding:6px 13px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer;transition:border-color .12s ease,color .12s ease}',
      '.mem-scope-reset:hover:not(:disabled){border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,var(--dsw-alias-border-l1));color:var(--dsw-alias-brand-primary)}',
      '.mem-scope-save{padding:6px 16px;border:1px solid var(--dsw-alias-state-business-primary);border-radius:9px;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground);font-size:12px;font-weight:600;cursor:pointer;box-shadow:0 2px 8px color-mix(in srgb,var(--dsw-alias-state-business-primary) 26%,transparent);transition:filter .12s ease}',
      '.mem-scope-save:hover:not(:disabled){filter:brightness(1.06);color:var(--dsw-alias-label-primary-foreground);border-color:var(--dsw-alias-state-business-primary)}',
      '.mem-scope-reset:disabled,.mem-scope-save:disabled{opacity:.5;cursor:default;filter:none}',
      '.mem-scope-save:disabled{color:var(--dsw-alias-label-primary-foreground)}',
      '.mem-scope-err{padding:5px 8px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d33) 10%,transparent);color:var(--dsw-alias-state-error-primary,#d33);font-size:12px;line-height:1.5}',
      // 范围外访问审批卡(0.21.0):注册在 conversation.input.dock,只在所属会话里显示。
      // 版式照抄宿主 dsh-client-ui-approval 的审批卡(strip + body + 右对齐动作行),
      // 尺寸/圆角/底色/阴影全走同一批主题 token;缺少 composer 变量时给出同样的回退值。
      '.mem-approval{box-sizing:border-box;width:100%;padding:8px calc(var(--dsh-composer-side-clearance,0px) + 16px) 12px;display:flex;flex-direction:column;align-items:center;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.mem-approval-card{box-sizing:border-box;width:100%;max-width:var(--dsh-chat-content-width,752px);border:1px solid var(--dsw-alias-state-warn-secondary,color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d9a23b) 55%,transparent));border-radius:var(--dsw-radius-xl,16px);background:var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-1));box-shadow:var(--dsw-shadow-lv2,0 6px 20px rgba(0,0,0,.12));overflow:hidden}',
      '.mem-approval-strip{align-items:center;gap:8px;padding:10px 16px;font-size:13px;line-height:18px;display:flex;background:var(--dsw-alias-state-warn-tertiary,color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d9a23b) 14%,transparent));color:var(--dsw-alias-state-warn-primary,#d9a23b)}',
      '.mem-approval-dot{width:8px;height:8px;border-radius:50%;flex:none;background:currentColor;box-shadow:0 0 0 3px color-mix(in srgb,currentColor 18%,transparent)}',
      '.mem-approval-tool{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:11.5px;opacity:.8;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mem-approval .spacer{flex:1}',
      '.mem-approval .muted{color:var(--dsw-alias-label-secondary);font-size:11.5px}',
      // 与宿主审批卡同一口径:只受 composer 文本区最大高度约束(不再叠一层 46vh,
      // 否则窗口一矮,详情行占位后条目列表只剩几十像素)。条目多时只让列表滚动(0.22.2)。
      '.mem-approval-body{box-sizing:border-box;max-height:var(--dsh-composer-text-max-height,320px);display:flex;flex-direction:column;gap:6px;padding:12px 16px 0;overflow-y:auto;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2,color-mix(in srgb,var(--dsw-alias-label-secondary) 35%,transparent))}',
      '.mem-approval-headline{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:500;line-height:24px;flex:none}',
      '.mem-approval-hint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.55;flex:none}',
      // 这三行的 overflow:auto 会让 flex 的自动最小尺寸变成 0;若不锁 flex:none,
      // 条目列表一长,它们会和列表一起被压缩到 0 高 —— 审批时完全看不到查询/说明(0.22.2)。
      '.mem-approval-command{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:13px;line-height:20px;word-break:break-word;white-space:pre-wrap;max-height:72px;overflow:auto;flex:none}',
      '.mem-approval-list{display:flex;flex-direction:column;gap:6px;overflow:auto;min-height:0;padding-bottom:2px}',
      '.mem-approval-item{display:flex;align-items:flex-start;gap:8px;padding:7px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 55%,transparent)}',
      '.mem-approval-item.is-clickable{cursor:pointer;transition:border-color .12s ease,background .12s ease}',
      '.mem-approval-item.is-clickable:hover{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 42%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 6%,transparent)}',
      '.mem-approval-item.is-off{opacity:.62}',
      '.mem-approval-toggle{padding:0 2px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:18px;cursor:pointer;flex:none}',
      '.mem-approval-toggle:hover{color:var(--dsw-alias-label-primary);text-decoration:underline}',
      '.mem-approval-toggle:focus-visible{outline:1px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
      '.mem-approval-item-body{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}',
      '.mem-approval-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.mem-approval-id{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:11px;color:var(--dsw-alias-label-secondary);padding:0;border:none;background:transparent;text-align:left;line-height:1.4;cursor:pointer;border-radius:4px}',
      '.mem-approval-id:hover{color:var(--dsw-alias-state-business-primary,#4176e6);text-decoration:underline}',
      '.mem-approval-id:focus-visible{outline:1px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '.mem-approval-desc{color:var(--dsw-alias-label-primary);font-size:12.5px;line-height:1.55;word-break:break-word;white-space:pre-wrap;max-height:90px;overflow:auto;flex:none}',
      '.mem-approval-bulk{display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--dsw-alias-label-secondary);flex:none}',
      '.mem-approval-bulk button{padding:0;border:none;background:transparent;color:var(--dsw-alias-state-business-primary,#4176e6);font-size:11.5px;cursor:pointer}',
      '.mem-approval-bulk button:hover:not(:disabled){text-decoration:underline}',
      '.mem-approval-bulk button:disabled{color:var(--dsw-alias-label-secondary);opacity:.55;cursor:default;text-decoration:none}',
      '.mem-approval-summary{color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1.5;word-break:break-word}',
      '.mem-approval-check{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;margin-top:1px;padding:0;border:none;background:transparent;flex:none;cursor:pointer}',
      '.mem-approval-check .box{display:flex;align-items:center;justify-content:center;width:16px;height:16px;border:1.5px solid color-mix(in srgb,var(--dsw-alias-label-secondary) 52%,var(--dsw-alias-border-l1));border-radius:5px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent);color:var(--dsw-alias-label-primary-foreground);transition:background .12s ease,border-color .12s ease}',
      '.mem-approval-check.on .box{background:var(--dsw-alias-state-business-primary,#4176e6);border-color:var(--dsw-alias-state-business-primary,#4176e6);color:var(--dsw-alias-label-primary-foreground)}',
      '.mem-approval-check:focus-visible{outline:1px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
      '.mem-approval-check .tick{font-size:11px;line-height:1}',
      '.mem-approval-err{padding:5px 8px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d33) 10%,transparent);color:var(--dsw-alias-state-error-primary,#d33);font-size:12px;line-height:1.5}',
      '.mem-approval-actionrow{justify-content:flex-end;gap:8px;padding:14px 16px;display:flex}',
      '.mem-approval-reject{display:inline-flex;align-items:center;justify-content:center;height:32px;padding:0 16px;border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l1));border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;cursor:pointer;transition:background .12s ease,border-color .12s ease,color .12s ease}',
      '.mem-approval-reject:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger,color-mix(in srgb,var(--dsw-alias-state-error-primary,#d33) 10%,transparent));color:var(--dsw-alias-state-error-primary,#d33);border-color:transparent}',
      '.mem-approval-allow{display:inline-flex;align-items:center;justify-content:center;height:32px;padding:0 18px;border:1px solid var(--dsw-alias-state-business-primary,#4176e6);border-radius:8px;background:var(--dsw-alias-state-business-primary,#4176e6);color:var(--dsw-alias-label-primary-foreground);font-size:13px;font-weight:600;cursor:pointer;transition:filter .12s ease}',
      '.mem-approval-allow:hover:not(:disabled){filter:brightness(1.06)}',
      '.mem-approval-reject:disabled,.mem-approval-allow:disabled{opacity:.5;cursor:default;filter:none}',
      '.mem-approval-allow:disabled{color:var(--dsw-alias-label-primary-foreground)}',
    ].join('')

    async function api(method, body) {
      const res = await fetch(`${API}/${method}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      let wire
      try { wire = await res.json() } catch { throw new Error(`memory api: bad response (${res.status})`) }
      if (!wire || wire.ok !== true) throw new Error((wire && wire.error && wire.error.message) || `memory api: ${method} failed`)
      return wire.value
    }

    function fmtTime(ts) {
      if (!ts) return '—'
      const d = new Date(ts)
      const pad = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }

    /** Agent 授权里的权限文案（read / write 组合）。 */
    function grantPermissionText(permissions) {
      return (Array.isArray(permissions) ? permissions : [])
        .map((permission) => (permission === 'write' ? '可写' : '只读'))
        .join(' / ')
    }

    /** 过期时间的人话描述:还剩多久 / 已过期多久。 */
    function expiryText(ts) {
      if (!ts) return '永不过期'
      const diff = Number(ts) - Date.now()
      const abs = Math.abs(diff)
      const days = Math.floor(abs / 86_400_000)
      const hours = Math.floor((abs % 86_400_000) / 3_600_000)
      const span = days > 0 ? `${days} 天${hours > 0 ? ` ${hours} 小时` : ''}` : `${Math.max(1, hours)} 小时`
      return diff >= 0 ? `还剩 ${span}` : `已过期 ${span}`
    }

    function isExpired(rec) {
      return rec && rec.expiredAt !== null && rec.expiredAt !== undefined && Number(rec.expiredAt) < Date.now()
    }

    /**
     * 会话 id → 展示用的短 id(前 16 位,如 `session-1a2b3c4d`)。
     *
     * 为什么是 16 而不是 8:DSH 的会话 id 以 `session-` 开头 —— 正好 8 个字符。
     * 取前 8 位会让所有会话作用域都显示成同一个名字,等于没给 id。
     * 服务端 memory-local 的 sessionShortId 是同一口径。
     */
    const SESSION_SHORT_ID_CHARS = 16
    function sessionShortId(sessionId) {
      return String(sessionId === null || sessionId === undefined ? '' : sessionId).slice(0, SESSION_SHORT_ID_CHARS)
    }

    /**
     * scope 键 → **类型前缀**:`global:` / `project:` / `session:` / `custom:`。
     *
     * 注意后两个坑:①会话 id 以 `session-` 开头(正好 8 个字符),短 id 必须取 16 位;
     * ②**自定义作用域的键本身没有前缀**(就是一个名字,例如 `handbook`),global 的键
     * 也只有 `global` 这个词 —— 所以前缀只能按类型补,不能靠键里现成的样子。
     * 服务端 memory-local 的 scopeTypePrefix / scopeDisplayName 是同一口径。
     */
    function scopeTypePrefix(scope) {
      if (scope === 'global') return 'global:'
      const value = String(scope)
      if (value.startsWith('project:')) return 'project:'
      if (value.startsWith('session:')) return 'session:'
      return 'custom:'
    }

    /** 没有别名 / 标题时,各类型自己的名字(前缀之后那一段)。 */
    function scopeDefaultName(scope) {
      if (scope === 'global') return '全局'
      const value = String(scope)
      if (value.startsWith('project:')) return value.slice('project:'.length)
      if (value.startsWith('session:')) return sessionShortId(value.slice('session:'.length))
      return value
    }

    /** scope 键 → 展示名(带类型前缀),形如 `global:全局` / `custom:handbook`。 */
    function scopeDisplayName(scope, humanName) {
      const name = typeof humanName === 'string' && humanName.length > 0 ? humanName : scopeDefaultName(scope)
      return `${scopeTypePrefix(scope)}${name}`
    }

    /**
     * scope 键 → 展示名。优先用 /status 返回的 `label`(服务端能查会话标题、能解析
     * project 的 cwd,且已经带类型前缀);服务端没给(旧 provider / 还没加载到)时用
     * 本地回退 —— 回退也必须带前缀,所以走 scopeDisplayName 而不是裸键。
     */
    function scopeLabel(scope, labels) {
      const mapped = labels && labels[scope]
      if (typeof mapped === 'string' && mapped.length > 0) return mapped
      return scopeDisplayName(scope)
    }

    /**
     * 悬停提示里的作用域身份:`显示名 → 真实键`。
     *
     * 0.25.11：项目作用域有别名时显示名是 `project:dsh-pocket`,真实键却是完整路径;
     * 会话与自定义作用域同理(短 id / 裸键)。只给键看不出它是哪个项目,只给名字又拿不到
     * 能直接粘进工具参数的值，所以两段都给。显示名与键相同时不重复。
     */
    function scopeTitle(scope, label) {
      const key = String(scope === null || scope === undefined ? '' : scope)
      const name = typeof label === 'string' && label !== '' ? label : scopeDisplayName(scope)
      return key === '' || key === name ? key : `${name} → ${key}`
    }

    /** 记忆类型 → 中文名 + 树里的强调色(与宿主主题无关的固定色相,底色用 color-mix 自适应)。 */
    const KIND_ORDER = ['fact', 'decision', 'preference', 'procedure', 'note', 'rule', 'state']
    const KIND_META = {
      fact: { label: '事实', color: '#5B8DEF' },
      decision: { label: '决策', color: '#D99A2B' },
      preference: { label: '偏好', color: '#D868A8' },
      procedure: { label: '流程', color: '#3FAE7A' },
      note: { label: '笔记', color: '#7C8AA0' },
      rule: { label: '规则', color: '#9B6BE0' },
      state: { label: '状态', color: '#4AA3B8' },
    }

    function kindMeta(kind) {
      return KIND_META[kind] || { label: String(kind), color: '#8B93A7' }
    }

    function kindRank(kind) {
      const index = KIND_ORDER.indexOf(kind)
      return index < 0 ? KIND_ORDER.length : index
    }

    function scopeRank(scope) {
      if (scope === 'global') return 0
      if (scope.startsWith('project:')) return 1
      if (scope.startsWith('session:')) return 2
      return 3
    }

    /** 作用域类型的一字记号(全 / 项 / 会 / 自),比抽象图标更好认。 */
    function scopeGlyph(scope) {
      if (scope === 'global') return '全'
      if (scope.startsWith('project:')) return '项'
      if (scope.startsWith('session:')) return '会'
      return '自'
    }

    /** 紧凑时间:今天只给时分,其它日期给月/日。 */
    function shortTime(ts) {
      if (!ts) return ''
      const date = new Date(ts)
      const pad = (n) => String(n).padStart(2, '0')
      const now = new Date()
      if (date.toDateString() === now.toDateString()) return `${pad(date.getHours())}:${pad(date.getMinutes())}`
      return `${date.getMonth() + 1}/${date.getDate()}`
    }

    function excerpt(text, limit = 64) {
      const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
      return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
    }

    /**
     * 记忆树的**纯布局**:输入记录,输出节点的绝对坐标、层级连线与修正连线。
     *
     * 层级固定为 root → scope → kind → record,列间平推、叶子纵向堆叠;父节点在自己
     * 子树的高度里居中。折叠一个 scope/kind 只是不展开它下面的节点,布局仍然成立。
     * 修正关系不改变层级(一条记录只会修正同一个作用域里的旧记录),所以单独作为
     * 曲线叠在右侧,避免把树本身拧成图。
     *
     * 这个函数不碰 DOM,测试可以直接断言节点与连线。
     */
    const TREE_METRICS = {
      rootW: 100, rootH: 48,
      scopeW: 202, scopeH: 42,
      kindW: 128, kindH: 30,
      recordW: 236, recordH: 56,
      padX: 26, padY: 24,
      colGap: 54, leafGap: 8, groupGap: 16,
      arcRoom: 104,
    }

    function buildMemoryTree(records, options = {}) {
      const M = TREE_METRICS
      const labels = options.labels || {}
      const collapsed = options.collapsed instanceof Set ? options.collapsed : new Set(options.collapsed || [])
      const activeKinds = options.activeKinds instanceof Set ? options.activeKinds : new Set(KIND_ORDER)
      const scopeFilter = typeof options.scopeFilter === 'string' ? options.scopeFilter : ''
      const query = String(options.query ?? '').trim().toLowerCase()

      const byScope = new Map()
      for (const rec of records) {
        if (!activeKinds.has(rec.kind)) continue
        if (scopeFilter !== '' && rec.scope !== scopeFilter) continue
        let kinds = byScope.get(rec.scope)
        if (kinds === undefined) { kinds = new Map(); byScope.set(rec.scope, kinds) }
        let list = kinds.get(rec.kind)
        if (list === undefined) { list = []; kinds.set(rec.kind, list) }
        list.push(rec)
      }

      const scopeGroups = []
      for (const [scope, kindMap] of byScope) {
        const kinds = []
        for (const [kind, list] of kindMap) {
          kinds.push({ kind, records: list.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)) })
        }
        kinds.sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || String(a.kind).localeCompare(String(b.kind)))
        let count = 0
        for (const entry of kinds) count += entry.records.length
        scopeGroups.push({ scope, label: scopeLabel(scope, labels), kinds, count })
      }
      scopeGroups.sort((a, b) => scopeRank(a.scope) - scopeRank(b.scope) || a.label.localeCompare(b.label, 'zh'))

      const scopeKey = (scope) => `scope:${scope}`
      const kindKey = (scope, kind) => `kind:${scope}|${kind}`
      const recordKey = (id) => `record:${id}`

      const scopeBlocks = scopeGroups.map((group) => {
        const collapsedScope = collapsed.has(scopeKey(group.scope))
        const kindBlocks = collapsedScope ? [] : group.kinds.map((entry) => {
          const collapsedKind = collapsed.has(kindKey(group.scope, entry.kind))
          const recordsHeight = entry.records.length * M.recordH
            + Math.max(0, entry.records.length - 1) * M.leafGap
          return {
            ...entry,
            collapsed: collapsedKind,
            height: collapsedKind ? M.kindH : Math.max(M.kindH, recordsHeight),
          }
        })
        let body = 0
        for (const entry of kindBlocks) body += entry.height
        const height = collapsedScope
          ? M.scopeH
          : Math.max(M.scopeH, body + Math.max(0, kindBlocks.length - 1) * M.groupGap)
        return { ...group, collapsed: collapsedScope, kindBlocks, height }
      })

      let scopesHeight = 0
      for (const block of scopeBlocks) scopesHeight += block.height
      if (scopeBlocks.length > 1) scopesHeight += (scopeBlocks.length - 1) * M.groupGap
      const contentHeight = Math.max(M.rootH, scopesHeight)

      const nodes = []
      const nodeByKey = new Map()
      const recordNode = new Map()
      const edges = []
      const corrections = []
      const addNode = (node) => { nodes.push(node); nodeByKey.set(node.key, node) }

      const rootX = M.padX
      const rootY = M.padY + (contentHeight - M.rootH) / 2
      const scopeX = rootX + M.rootW + M.colGap
      const kindX = scopeX + M.scopeW + M.colGap
      const recordX = kindX + M.kindW + M.colGap
      let visibleRecords = 0

      addNode({
        key: 'root', type: 'root',
        x: rootX, y: rootY, w: M.rootW, h: M.rootH,
        count: scopeGroups.reduce((sum, group) => sum + group.count, 0),
      })

      let top = M.padY
      for (const scope of scopeBlocks) {
        const sKey = scopeKey(scope.scope)
        addNode({
          key: sKey, type: 'scope',
          x: scopeX, y: top + (scope.height - M.scopeH) / 2, w: M.scopeW, h: M.scopeH,
          scope: scope.scope, label: scope.label, count: scope.count, collapsed: scope.collapsed,
        })
        edges.push({ key: `root>${sKey}`, type: 'tree', fromKey: 'root', toKey: sKey, toType: 'scope', toId: scope.scope })

        let kindTop = top
        for (const entry of scope.kindBlocks) {
          const kKey = kindKey(scope.scope, entry.kind)
          addNode({
            key: kKey, type: 'kind',
            x: kindX, y: kindTop + (entry.height - M.kindH) / 2, w: M.kindW, h: M.kindH,
            scope: scope.scope, kind: entry.kind, count: entry.records.length, collapsed: entry.collapsed,
          })
          edges.push({
            key: `${sKey}>${kKey}`, type: 'tree',
            fromKey: sKey, toKey: kKey, toType: 'kind', toId: `${scope.scope}|${entry.kind}`,
          })
          if (!entry.collapsed) {
            const recordsHeight = entry.records.length * M.recordH
              + Math.max(0, entry.records.length - 1) * M.leafGap
            const recordTop = kindTop + (entry.height - recordsHeight) / 2
            entry.records.forEach((rec, index) => {
              const rKey = recordKey(rec.id)
              const y = recordTop + index * (M.recordH + M.leafGap)
              addNode({
                key: rKey, type: 'record',
                x: recordX, y, w: M.recordW, h: M.recordH,
                scope: rec.scope, kind: rec.kind, rec,
              })
              recordNode.set(rec.id, rKey)
              edges.push({ key: `${kKey}>${rKey}`, type: 'tree', fromKey: kKey, toKey: rKey, toType: 'record', toId: rec.id })
              visibleRecords += 1
            })
          }
          kindTop += entry.height + M.groupGap
        }
        top += scope.height + M.groupGap
      }

      // 修正连线要等**所有**节点都落位后再算:新记录排在旧记录前面(按 updatedAt 倒序),
      // 单遍循环时还看不到被修正的旧记录。
      for (const node of nodes) {
        if (node.type !== 'record') continue
        const rec = node.rec
        const oldKey = rec.supersedes ? recordNode.get(rec.supersedes) : undefined
        if (oldKey === undefined) continue
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

      const visibleKinds = new Set()
      for (const group of scopeGroups) for (const entry of group.kinds) visibleKinds.add(entry.kind)
      const width = recordX + M.recordW + M.padX + M.arcRoom
      const height = M.padY * 2 + contentHeight

      return {
        nodes, edges, corrections, nodeByKey, recordNode, matches,
        width, height,
        counts: {
          records: visibleRecords,
          scopes: scopeGroups.length,
          kinds: visibleKinds.size,
          corrections: corrections.length,
        },
      }
    }

    /** 层级连线:从父节点右缘到子节点左缘,水平方向用三次贝塞尔。 */
    function treeEdgePath(from, to) {
      const x1 = from.x + from.w
      const y1 = from.y + from.h / 2
      const x2 = to.x
      const y2 = to.y + to.h / 2
      const bend = Math.max(18, Math.abs(x2 - x1) * 0.48)
      return `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`
    }

    /** 修正连线:两端都从卡片右缘出,向右侧鼓出一条弧,不穿过叶子文本。 */
    function treeCorrectionPath(from, to) {
      const x1 = from.x + from.w
      const y1 = from.y + from.h / 2
      const x2 = to.x + to.w
      const y2 = to.y + to.h / 2
      const bend = 34 + Math.min(66, Math.abs(y2 - y1) * 0.09)
      return `M${x1},${y1} C${x1 + bend},${y1} ${x2 + bend},${y2} ${x2},${y2}`
    }

    function KindDot({ kind }) {
      return h('span', {
        className: 'tdot',
        style: { '--k': kindMeta(kind).color },
        'aria-hidden': 'true',
      })
    }

    function RecordCard({ rec, vectorOn, labels, onSaved, onDeleted, focus = false, score = null }) {
      // collapsed by default: the list stays scannable, full text on demand
      const [expanded, setExpanded] = React.useState(false)
      const [editing, setEditing] = React.useState(false)
      const [content, setContent] = React.useState(rec.content)
      const [kind, setKind] = React.useState(rec.kind)
      const [tags, setTags] = React.useState(rec.tags.join(', '))
      const [triggers, setTriggers] = React.useState((rec.triggers ?? []).join(', '))
      const [importance, setImportance] = React.useState(rec.importance)
      const [ttlDays, setTtlDays] = React.useState(
        rec.expiredAt ? Math.max(1, Math.round((Number(rec.expiredAt) - Date.now()) / 86_400_000)) : 7,
      )
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [copied, setCopied] = React.useState(false)

      // 从审计页点 memory ID 跳过来时自动展开目标记录。
      // 记录列表可能很长，展开后还要把它滚进视口，否则用户看到的是列表顶部。
      const cardRef = React.useRef(null)
      React.useEffect(() => {
        if (!focus) return undefined
        setExpanded(true)
        const node = cardRef.current
        if (node === null || typeof node.scrollIntoView !== 'function') return undefined
        const timer = setTimeout(() => {
          try { node.scrollIntoView({ block: 'center', behavior: 'smooth' }) } catch { /* 滚动失败不影响展开 */ }
        }, 60)
        return () => clearTimeout(timer)
      }, [focus])

      const copyId = () => {
        try {
          if (navigator?.clipboard?.writeText) void navigator.clipboard.writeText(rec.id)
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        } catch { /* 剪贴板不可用时忽略 */ }
      }

      // editing implies expanded: the editor replaces the body
      const open = expanded || editing
      const toggle = () => { if (!editing) setExpanded((v) => !v) }

      const save = async () => {
        setBusy(true); setError('')
        try {
          await api('update', {
            id: rec.id,
            content,
            kind,
            importance: Number(importance) || 0,
            tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
            ...(kind === 'procedure' ? { triggers: triggers.split(',').map((t) => t.trim()).filter(Boolean) } : {}),
            ...(kind === 'state' ? { ttlMs: Math.max(1, Number(ttlDays) || 7) * 86_400_000 } : {}),
          })
          setEditing(false)
          onSaved()
        } catch (e) { setError(String(e.message || e)) } finally { setBusy(false) }
      }

      const del = async () => {
        if (!window.confirm('删除这条记忆?')) return
        setBusy(true); setError('')
        try { await api('delete', { id: rec.id }); onDeleted() } catch (e) { setError(String(e.message || e)) } finally { setBusy(false) }
      }

      const cancelEdit = () => {
        setEditing(false)
        setContent(rec.content); setKind(rec.kind)
        setTags(rec.tags.join(', ')); setImportance(rec.importance)
        setTriggers((rec.triggers ?? []).join(', '))
        setTtlDays(rec.expiredAt ? Math.max(1, Math.round((Number(rec.expiredAt) - Date.now()) / 86_400_000)) : 7)
      }

      return h('div', { className: 'rec' + (focus ? ' focus' : ''), ref: cardRef },
        h('div', {
          className: 'rec-head',
          role: 'button',
          tabIndex: 0,
          'aria-expanded': open,
          title: open ? '收起' : '展开查看完整内容',
          onClick: toggle,
          onKeyDown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() }
          },
        },
          h('span', { className: open ? 'chev open' : 'chev' }, '▶'),
          h('span', { className: 'badge scope', title: scopeTitle(rec.scope, scopeLabel(rec.scope, labels)) }, scopeLabel(rec.scope, labels)),
          h('span', { className: 'badge' }, rec.kind),
          score !== null && score !== undefined && Number.isFinite(Number(score))
            ? h('span', {
                className: 'badge score',
                // 这是**排序分**,不是概率:向量/词法命中 × 重要度 × 时效 × 访问次数加权,
                // 访问次数多时可能大于 1。叫「相关度」会让人误以为一定在 0~1 之间。
                title: '检索得分 = 向量/词法命中 × 重要度 × 时效 × 访问次数；只用于结果排序，可能大于 1',
              }, `得分 ${Number(score).toFixed(2)}`)
            : null,
          rec.supersedes
            ? h('span', {
                className: 'badge corrected',
                title: `修正版:它覆盖了旧记录 #${rec.supersedes}（旧记录仍可检索，只是排序降权）`,
              }, `修正自 ${rec.supersedes.slice(0, 8)}`)
            : null,
          rec.supersededBy
            ? h('span', {
                className: 'badge',
                title: `已被 #${rec.supersededBy} 修正（旧记录仍可检索，只是排序降权）`,
              }, '已被修正')
            : null,
          isExpired(rec)
            ? h('span', {
                className: 'badge expired',
                title: `过期于 ${fmtTime(rec.expiredAt)}；默认检索/摘要/召回会隐藏，memory_get 仍可取`,
              }, '已过期')
            : null,
          // 只在"待嵌入"时提示:已嵌入是常态,向量没启用时这条也没有行动价值。
          !rec.embedded && vectorOn ? h('span', { className: 'pending', title: '待嵌入:向量服务就绪后会自动补上' }, '待嵌入') : null,
          h('span', { className: 'time', title: `更新于 ${fmtTime(rec.updatedAt)}` }, fmtTime(rec.updatedAt)),
        ),
        !open ? h('div', { className: 'preview' }, rec.content) : null,
        open
          ? h('div', { className: 'rec-body' },
              editing
                ? h('div', null,
                    h('textarea', { rows: 4, value: content, onChange: (e) => setContent(e.target.value) }),
                    h('div', { className: 'editrow' },
                      // 类型也用同一个自绘下拉(全站不再有原生 select)
                      h(Dropdown, {
                        items: ['fact', 'decision', 'preference', 'procedure', 'note', 'rule', 'state'].map((k) => ({ value: k, label: k })),
                        value: kind,
                        disabled: busy,
                        onChange: (next) => setKind(next),
                      }),
                      h('input', { type: 'text', style: { width: 170 }, value: tags, placeholder: '标签, 逗号分隔', onChange: (e) => setTags(e.target.value) }),
                      kind === 'procedure'
                        ? h('input', { type: 'text', style: { width: 170 }, value: triggers, placeholder: '触发词(工具名/关键词)', onChange: (e) => setTriggers(e.target.value) })
                        : null,
                      h('label', null, '重要度 ',
                        h('input', { type: 'number', min: 0, max: 1, step: 0.1, value: importance, onChange: (e) => setImportance(e.target.value) })),
                      kind === 'state'
                        ? h('label', null, '有效期(天) ',
                            h('input', { type: 'number', min: 1, max: 365, step: 1, value: ttlDays, onChange: (e) => setTtlDays(e.target.value) }))
                        : null,
                    ),
                    h('div', { className: 'acts' },
                      h('button', { disabled: busy, onClick: save }, busy ? '保存中…' : '保存修正版'),
                      h('button', { disabled: busy, onClick: cancelEdit }, '取消'),
                    ),
                    h('div', { className: 'hint' }, '保存会新建一条修正版（supersedes 当前记录），旧记录保留；记录页默认隐藏已被修正的旧版本。'),
                  )
                : h('div', null,
                    h('div', { className: 'content' }, rec.content),
                    h('div', { className: 'meta' },
                      h('span', { className: 'meta-label' }, 'id'),
                      h('code', { className: 'meta-id', title: '点击复制完整 id', onClick: copyId }, rec.id),
                      copied ? h('span', { className: 'meta-done' }, '已复制') : null,
                    ),
                    rec.tags && rec.tags.length > 0
                      ? h('div', { className: 'tags' }, rec.tags.map((tag) => h('span', { className: 'tag', key: tag }, tag)))
                      : null,
                    rec.triggers && rec.triggers.length > 0
                      ? h('div', { className: 'tags' },
                          h('span', { className: 'meta-label' }, '触发'),
                          rec.triggers.map((trigger) => h('span', { className: 'tag', key: trigger }, trigger)),
                        )
                      : null,
                    rec.expiredAt
                      ? h('div', { className: 'meta' },
                          h('span', { className: 'meta-label' }, '过期'),
                          h('span', { className: isExpired(rec) ? 'meta-done' : '' }, `${fmtTime(rec.expiredAt)}（${expiryText(rec.expiredAt)}）`),
                        )
                      : null,
                  ),
            )
          : null,
        error ? h('div', { className: 'err' }, error) : null,
        open && !editing
          ? h('div', { className: 'acts' },
              h('button', { onClick: () => setEditing(true) }, '编辑'),
              h('button', { disabled: busy, onClick: del }, busy ? '…' : '删除'),
            )
          : null,
      )
    }

    /** 树上的一条记忆:内容两行封顶,类型/修正/时间放在头行。 */
    function TreeRecordNode({ node, selected, related, miss, match, onSelect, onHover }) {
      const rec = node.rec
      const meta = kindMeta(rec.kind)
      const classes = ['tree-node', 'record']
      if (selected) classes.push('selected')
      if (related) classes.push('related')
      if (miss) classes.push('miss')
      if (match) classes.push('match')
      const pick = () => onSelect(rec.id)
      return h('div', {
        className: classes.join(' '),
        style: { left: node.x, top: node.y, width: node.w, height: node.h, '--k': meta.color },
        title: rec.content,
        role: 'button',
        tabIndex: 0,
        'aria-pressed': Boolean(selected),
        onClick: pick,
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pick() }
        },
        onMouseEnter: () => onHover(rec.id),
        onMouseLeave: () => onHover(null),
        onFocus: () => onHover(rec.id),
        onBlur: () => onHover(null),
      },
        h('div', { className: 'tn-head' },
          h(KindDot, { kind: rec.kind }),
          h('span', { className: 'tn-kind' }, meta.label),
          rec.supersedes
            ? h('span', { className: 'tn-badge corr', title: `这条记录修正了旧记录 #${rec.supersedes}` }, '修正版')
            : null,
          rec.supersededBy
            ? h('span', { className: 'tn-badge old', title: `已被 #${rec.supersededBy} 修正` }, '已修正')
            : null,
          isExpired(rec)
            ? h('span', { className: 'tn-badge expired', title: `过期于 ${fmtTime(rec.expiredAt)}` }, '已过期')
            : null,
          h('span', { className: 'tn-time' }, shortTime(rec.updatedAt)),
        ),
        h('div', { className: 'tn-content' }, rec.content),
      )
    }

    /** 树上的一个作用域:点击折叠/展开。 */
    function TreeScopeNode({ node, onToggle }) {
      return h('div', {
        className: 'tree-node scope' + (node.collapsed ? ' collapsed' : ''),
        style: { left: node.x, top: node.y, width: node.w, height: node.h },
        role: 'button',
        tabIndex: 0,
        'aria-expanded': !node.collapsed,
        title: `${scopeTitle(node.scope, node.label)} · 点击${node.collapsed ? '展开' : '折叠'}`,
        onClick: () => onToggle(node.scope),
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onToggle(node.scope) }
        },
      },
        h('span', { className: 'tn-ico' }, scopeGlyph(node.scope)),
        h('span', { className: 'tn-scope' }, node.label),
        h('span', { className: 'tn-count' }, String(node.count)),
        h('span', { className: 'tn-caret' }, node.collapsed ? '▸' : '▾'),
      )
    }

    /** 树上的一个类型分组:点击折叠/展开。 */
    function TreeKindNode({ node, onToggle }) {
      const meta = kindMeta(node.kind)
      return h('div', {
        className: 'tree-node kind' + (node.collapsed ? ' collapsed' : ''),
        style: { left: node.x, top: node.y, width: node.w, height: node.h, '--k': meta.color },
        role: 'button',
        tabIndex: 0,
        'aria-expanded': !node.collapsed,
        title: `${node.kind} · ${meta.label} · 点击${node.collapsed ? '展开' : '折叠'}`,
        onClick: () => onToggle(node.scope, node.kind),
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onToggle(node.scope, node.kind) }
        },
      },
        h('span', { className: 'tdot' }),
        h('span', { className: 'tn-name' }, meta.label),
        h('span', { className: 'tn-count' }, String(node.count)),
        h('span', { className: 'tn-caret' }, node.collapsed ? '▸' : '▾'),
      )
    }

    function TreeRootNode({ node }) {
      return h('div', {
        className: 'tree-node root',
        style: { left: node.x, top: node.y, width: node.w, height: node.h },
        title: '所有作用域的记忆',
      },
        h('span', { className: 'root-icon' }, h(NavLineIcon, { size: 19 })),
        h('span', null,
          h('b', null, '记忆系统'),
          h('span', null, `${node.count} 条`),
        ),
      )
    }

    /** 右侧详情抽屉:全文、标签、重要度、id,以及修正关系的双向入口。 */
    function TreeDetail({ rec, labels, byId, onClose, onJump }) {
      const [copied, setCopied] = React.useState(false)
      const meta = kindMeta(rec.kind)
      const older = rec.supersedes ? byId.get(rec.supersedes) : undefined
      const newer = rec.supersededBy ? byId.get(rec.supersededBy) : undefined
      const copyId = () => {
        try {
          if (navigator?.clipboard?.writeText) void navigator.clipboard.writeText(rec.id)
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        } catch { /* 剪贴板不可用时忽略 */ }
      }
      return h('aside', { className: 'tree-detail', 'aria-label': '记忆详情' },
        h('div', { className: 'td-head' },
          h(KindDot, { kind: rec.kind }),
          h('span', { className: 'td-title' }, meta.label),
          h('span', { className: 'tn-count' }, rec.kind),
          h('button', { className: 'td-close', title: '关闭详情', onClick: onClose }, '×'),
        ),
        h('div', { className: 'td-scope' },
          h('span', { className: 'tn-ico' }, scopeGlyph(rec.scope)),
          h('span', { className: 'tn-scope' }, scopeLabel(rec.scope, labels)),
        ),
        h('div', { className: 'td-content' }, rec.content),
        rec.tags && rec.tags.length > 0
          ? h('div', { className: 'td-tags' }, rec.tags.map((tag) => h('span', { className: 'tag', key: tag }, tag)))
          : null,
        rec.triggers && rec.triggers.length > 0
          ? h('div', { className: 'td-tags' },
              h('span', { className: 'meta-label' }, '触发'),
              rec.triggers.map((trigger) => h('span', { className: 'tag', key: trigger }, trigger)),
            )
          : null,
        h('div', { className: 'td-meta' },
          h('div', { className: 'rowline' },
            h('span', null, '重要度'),
            h('span', { className: 'td-impbar' }, h('i', { style: { width: `${Math.round((Number(rec.importance) || 0) * 100)}%` } })),
            h('span', null, `${Math.round((Number(rec.importance) || 0) * 100)}%`),
          ),
          h('div', { className: 'rowline' }, h('span', null, '创建'), h('b', null, fmtTime(rec.createdAt))),
          h('div', { className: 'rowline' }, h('span', null, '更新'), h('b', null, fmtTime(rec.updatedAt))),
          rec.expiredAt
            ? h('div', { className: 'rowline' },
                h('span', null, '过期'),
                h('b', null, `${fmtTime(rec.expiredAt)}（${expiryText(rec.expiredAt)}）`),
                isExpired(rec) ? h('span', { className: 'tn-badge expired' }, '已过期') : null,
              )
            : null,
          h('div', { className: 'rowline' },
            h('span', null, 'id'),
            h('code', { className: 'td-id', title: '点击复制完整 id', onClick: copyId }, rec.id),
            copied ? h('span', { className: 'meta-done' }, '已复制') : null,
          ),
        ),
        h('div', { className: 'td-rel' },
          h('span', { className: 'td-rel-label' }, '修正关系'),
          older
            ? h('button', { className: 'td-rel-btn', title: `跳转到被修正的旧记录 #${older.id}`, onClick: () => onJump(older.id) },
                h('span', { className: 'td-rel-dir' }, '修正自'),
                h('span', { className: 'td-rel-text' }, excerpt(older.content)),
              )
            : null,
          newer
            ? h('button', { className: 'td-rel-btn', title: `跳转到修正它的新记录 #${newer.id}`, onClick: () => onJump(newer.id) },
                h('span', { className: 'td-rel-dir' }, '已被修正为'),
                h('span', { className: 'td-rel-text' }, excerpt(newer.content)),
              )
            : null,
          !older && !newer ? h('span', { className: 'muted' }, '这条记忆没有修正关系。') : null,
          older && newer
            ? h('span', { className: 'muted' }, '这条记录处在一条修正链的中间。')
            : null,
        ),
      )
    }

    /**
     * 「记忆树」标签页。
     *
     * 层级:记忆 → 作用域 → 类型 → 记录。三个维度正好对应记忆的归属(scope)、
     * 语义(kind)与内容;修正关系是跨记录的点对点关系,用金色虚线单独画在树的右侧,
     * 悬停/选中任意一端时两端与整条链一起点亮。
     */
    function MemoryTreeTab({ records, scopes, loading, error, onRefresh }) {
      const [query, setQuery] = React.useState('')
      const [scopeFilter, setScopeFilter] = React.useState('')
      const [kindFilter, setKindFilter] = React.useState(null)
      const [collapsed, setCollapsed] = React.useState(new Set())
      const [selectedId, setSelectedId] = React.useState(null)
      const [hoverId, setHoverId] = React.useState(null)
      const [showCorrections, setShowCorrections] = React.useState(true)
      const [zoom, setZoom] = React.useState(1)
      const [autoFitDone, setAutoFitDone] = React.useState(false)
      const wrapRef = React.useRef(null)

      const labels = {}
      for (const entry of scopes) {
        if (entry && typeof entry.scope === 'string' && typeof entry.label === 'string') labels[entry.scope] = entry.label
      }
      const recordById = new Map()
      const kindCounts = new Map()
      const presentKinds = []
      const presentScopes = []
      for (const rec of records) {
        recordById.set(rec.id, rec)
        kindCounts.set(rec.kind, (kindCounts.get(rec.kind) || 0) + 1)
        if (!presentKinds.includes(rec.kind)) presentKinds.push(rec.kind)
        if (!presentScopes.includes(rec.scope)) presentScopes.push(rec.scope)
      }
      presentKinds.sort((a, b) => kindRank(a) - kindRank(b) || String(a).localeCompare(String(b)))
      presentScopes.sort((a, b) => scopeRank(a) - scopeRank(b) || scopeLabel(a, labels).localeCompare(scopeLabel(b, labels), 'zh'))

      const allKinds = new Set(presentKinds)
      const activeKinds = kindFilter === null
        ? allKinds
        : new Set(presentKinds.filter((kind) => kindFilter.has(kind)))

      const layout = buildMemoryTree(records, {
        labels, collapsed, activeKinds, scopeFilter, query,
      })

      // 第一次拿到记录时把宽度缩到画布内:右侧的记录列默认不该被横向截断。
      // 高度方向仍可滚动 —— 记忆很多时把整棵树压到一屏里会小到看不清。
      React.useEffect(() => {
        if (autoFitDone || layout.counts.records === 0) return
        const wrap = wrapRef.current
        const scroll = wrap && typeof wrap.querySelector === 'function' ? wrap.querySelector('.tree-scroll') : null
        if (!scroll || scroll.clientWidth <= 0 || layout.width <= 0) return
        const widthFit = (scroll.clientWidth - 28) / layout.width
        if (widthFit < 0.99) setZoom(Math.max(0.62, Math.round(widthFit * 100) / 100))
        setAutoFitDone(true)
      }, [autoFitDone, layout.counts.records, layout.width])

      // 根节点在整棵树的高度里居中;树比视口高时,首屏应该正好看到它,
      // 而不是从最上面的作用域往下翻。
      React.useEffect(() => {
        if (!autoFitDone) return
        const wrap = wrapRef.current
        const scroll = wrap && typeof wrap.querySelector === 'function' ? wrap.querySelector('.tree-scroll') : null
        const root = layout.nodeByKey.get('root')
        if (!scroll || !root) return
        const max = Math.max(0, scroll.scrollHeight - scroll.clientHeight)
        const target = (root.y + root.h / 2) * zoom - scroll.clientHeight / 2
        scroll.scrollTop = Math.max(0, Math.min(target, max))
      }, [autoFitDone, zoom])

      // 选中一条记忆时把它滚进视口:右侧详情是从「修正关系」里跳过来的,
      // 目标可能在当前滚动范围之外。
      React.useEffect(() => {
        if (selectedId === null) return
        const wrap = wrapRef.current
        const scroll = wrap && typeof wrap.querySelector === 'function' ? wrap.querySelector('.tree-scroll') : null
        const node = scroll ? scroll.querySelector('.tree-node.record.selected') : null
        if (!scroll || !node) return
        const top = node.offsetTop * zoom
        const bottom = top + node.offsetHeight * zoom
        const viewTop = scroll.scrollTop
        const viewBottom = viewTop + scroll.clientHeight
        if (top < viewTop + 12) scroll.scrollTop = Math.max(0, top - 12)
        else if (bottom > viewBottom - 12) scroll.scrollTop = bottom - scroll.clientHeight + 12
      }, [selectedId])

      const focusId = hoverId || selectedId
      const related = new Set()
      if (focusId) {
        related.add(focusId)
        for (const correction of layout.corrections) {
          if (correction.fromId === focusId) related.add(correction.toId)
          if (correction.toId === focusId) related.add(correction.fromId)
        }
      }
      const pathKeys = new Set()
      for (const id of related) {
        const rec = recordById.get(id)
        if (rec) {
          pathKeys.add(`scope:${rec.scope}`)
          pathKeys.add(`kind:${rec.scope}|${rec.kind}`)
        }
      }
      const edgeActive = (edge) => {
        if (focusId === null) return false
        if (edge.type === 'correction') return related.has(edge.fromId) || related.has(edge.toId)
        if (edge.toType === 'record') return related.has(edge.toId)
        if (edge.toType === 'kind' || edge.toType === 'scope') return pathKeys.has(edge.toKey)
        return false
      }

      const toggleScope = (scope) => {
        const key = `scope:${scope}`
        setCollapsed((previous) => {
          const next = new Set(previous)
          if (next.has(key)) next.delete(key); else next.add(key)
          return next
        })
      }
      const toggleKind = (scope, kind) => {
        const key = `kind:${scope}|${kind}`
        setCollapsed((previous) => {
          const next = new Set(previous)
          if (next.has(key)) next.delete(key); else next.add(key)
          return next
        })
      }
      const toggleKindFilter = (kind) => {
        setKindFilter((previous) => {
          const next = previous === null ? new Set(presentKinds) : new Set(previous)
          if (next.has(kind)) next.delete(kind); else next.add(kind)
          return next
        })
      }
      const resetFilters = () => {
        setQuery('')
        setScopeFilter('')
        setKindFilter(null)
        setCollapsed(new Set())
      }
      const jumpTo = (id) => {
        // 从详情里跳修正链:清掉筛选并展开全部,否则目标可能正好被折叠/筛掉。
        setKindFilter(null)
        setScopeFilter('')
        setQuery('')
        setCollapsed(new Set())
        setSelectedId(id)
        setHoverId(null)
        setShowCorrections(true)
      }
      const stepZoom = (delta) => {
        setZoom((value) => Math.max(0.45, Math.min(1.6, Math.round((value + delta) * 100) / 100)))
      }
      const fitView = () => {
        try {
          const wrap = wrapRef.current
          const scroll = wrap && typeof wrap.querySelector === 'function' ? wrap.querySelector('.tree-scroll') : null
          if (!scroll || layout.width <= 0 || layout.height <= 0) { setZoom(1); return }
          const next = Math.min(
            (scroll.clientWidth - 28) / layout.width,
            Math.max((scroll.clientHeight - 28) / layout.height, 0.72),
            1.15,
          )
          setZoom(Math.max(0.5, Math.min(1.6, Math.round(next * 100) / 100)))
        } catch { setZoom(1) }
      }

      const selected = selectedId === null ? undefined : recordById.get(selectedId)
      const scopeItems = [{ value: '', label: '全部作用域' }]
      for (const scope of presentScopes) scopeItems.push({ value: scope, label: scopeLabel(scope, labels) })
      const correctionsTotal = records.reduce((sum, rec) => sum + (rec.supersedes ? 1 : 0), 0)
      const scopeTotal = new Set(records.map((rec) => rec.scope)).size
      const emptyText = records.length === 0
        ? (loading ? '正在加载记忆…' : '还没有记忆。去「记录」里新建一条，或让 Agent 用 memory_save 写一条。')
        : layout.counts.records === 0
          ? '当前筛选下没有记忆。'
          : ''
      const showEmpty = emptyText !== '' || (Boolean(error) && records.length === 0)

      const stats = h('div', { className: 'tree-stats' },
        h('div', { className: 'stat' }, h('b', null, String(records.length)), h('span', null, '条记忆')),
        h('div', { className: 'stat' }, h('b', null, String(scopeTotal)), h('span', null, '个作用域')),
        h('div', { className: 'stat' }, h('b', null, String(presentKinds.length)), h('span', null, '种类型')),
        h('div', { className: 'stat' }, h('b', null, String(correctionsTotal)), h('span', null, '处修正')),
      )

      const toolbar = h('div', { className: 'tree-toolbar' },
        h('input', {
          type: 'text',
          placeholder: '搜索内容、类型、标签或作用域',
          value: query,
          onChange: (event) => setQuery(event.target.value),
        }),
        h(Dropdown, {
          items: scopeItems,
          value: scopeFilter,
          disabled: loading,
          onChange: setScopeFilter,
        }),
        h('button', {
          className: 'kchip' + (showCorrections ? ' on' : ' off'),
          title: '显示 / 隐藏修正关系连线',
          onClick: () => setShowCorrections((value) => !value),
        }, h('span', { className: 'corr-swatch' }), '修正连线'),
        query.trim() !== ''
          ? h('span', { className: 'tree-matchinfo' }, `匹配 ${layout.matches.size} 条`)
          : null,
        h('span', { className: 'spacer' }),
        h('button', { onClick: () => setCollapsed(new Set()) }, '全部展开'),
        h('button', { onClick: () => setCollapsed(new Set(presentScopes.map((scope) => `scope:${scope}`))) }, '只看作用域'),
        h('button', { disabled: loading, onClick: onRefresh }, loading ? '刷新中…' : '刷新'),
      )

      const kindbar = h('div', { className: 'kindbar' },
        h('span', { className: 'kindbar-label' }, '类型'),
        presentKinds.map((kind) => h('button', {
          key: kind,
          className: 'kchip' + (activeKinds.has(kind) ? '' : ' off'),
          style: { '--k': kindMeta(kind).color },
          title: `${kind} · ${kindMeta(kind).label}`,
          onClick: () => toggleKindFilter(kind),
        },
          h('span', { className: 'tdot' }),
          kindMeta(kind).label,
          h('b', null, String(kindCounts.get(kind) || 0)),
        )),
        presentKinds.length > 0 && presentKinds.every((kind) => activeKinds.has(kind))
          ? null
          : h('button', { className: 'linkbtn', onClick: () => setKindFilter(null) }, '恢复全部类型'),
      )

      const nodes = []
      const add = (child) => { if (child !== null) nodes.push(child) }
      for (const node of layout.nodes) {
        if (node.type === 'root') {
          add(h(TreeRootNode, { key: node.key, node }))
        } else if (node.type === 'scope') {
          add(h(TreeScopeNode, { key: node.key, node, onToggle: toggleScope }))
        } else if (node.type === 'kind') {
          add(h(TreeKindNode, { key: node.key, node, onToggle: toggleKind }))
        } else {
          const rec = node.rec
          add(h(TreeRecordNode, {
            key: node.key,
            node,
            selected: rec.id === selectedId,
            related: related.has(rec.id),
            miss: query.trim() !== '' && !layout.matches.has(rec.id),
            match: query.trim() !== '' && layout.matches.has(rec.id),
            onSelect: (id) => setSelectedId((current) => current === id ? null : id),
            onHover: setHoverId,
          }))
        }
      }

      const edgePaths = []
      for (const edge of layout.edges) {
        const from = layout.nodeByKey.get(edge.fromKey)
        const to = layout.nodeByKey.get(edge.toKey)
        if (!from || !to) continue
        edgePaths.push(h('path', {
          key: edge.key,
          className: 'edge' + (edgeActive(edge) ? ' active' : ''),
          d: treeEdgePath(from, to),
        }))
      }
      if (showCorrections) {
        for (const edge of layout.corrections) {
          const from = layout.nodeByKey.get(edge.fromKey)
          const to = layout.nodeByKey.get(edge.toKey)
          if (!from || !to) continue
          const active = edgeActive(edge)
          edgePaths.push(h('path', {
            key: edge.key,
            className: 'corr-edge' + (active ? ' active' : ''),
            d: treeCorrectionPath(from, to),
          }))
          edgePaths.push(h('circle', {
            key: `${edge.key}:dot`,
            className: 'corr-dot' + (active ? ' active' : ''),
            cx: to.x + to.w,
            cy: to.y + to.h / 2,
            r: 2.6,
          }))
        }
      }

      const canvas = h('div', {
        className: 'tree-canvas' + (focusId !== null ? ' focused' : ''),
        style: { width: layout.width, height: layout.height, transform: `scale(${zoom})` },
      },
        h('svg', {
          className: 'tree-edges',
          width: layout.width,
          height: layout.height,
          viewBox: `0 0 ${layout.width} ${layout.height}`,
          'aria-hidden': 'true',
        }, edgePaths),
        nodes,
      )

      const treeWrap = h('div', { className: 'tree-wrap', ref: wrapRef },
        h('div', { className: 'tree-scroll' },
          h('div', {
            className: 'tree-zoomspace',
            style: { width: Math.ceil(layout.width * zoom), height: Math.ceil(layout.height * zoom) },
          }, canvas),
        ),
        showEmpty
          ? h('div', { className: 'tree-empty' },
              h('span', { className: 'big' }, '🌳'),
              h('span', null, emptyText || String(error)),
              emptyText === '当前筛选下没有记忆。'
                ? h('button', { onClick: resetFilters }, '清空筛选')
                : null,
            )
          : null,
        showEmpty ? null : h('div', { className: 'tree-zoom' },
          h('button', { title: '缩小', onClick: () => stepZoom(-0.1) }, '−'),
          h('span', { className: 'zoomval' }, `${Math.round(zoom * 100)}%`),
          h('button', { title: '放大', onClick: () => stepZoom(0.1) }, '+'),
          h('button', { title: '适应画布', onClick: fitView }, '适应'),
        ),
        showCorrections && layout.corrections.length > 0 && !showEmpty
          ? h('div', { className: 'tree-legend' }, h('span', null, h('i', { className: 'line' }), '修正关系'))
          : null,
        selected
          ? h(TreeDetail, {
              rec: selected,
              labels,
              byId: recordById,
              onClose: () => setSelectedId(null),
              onJump: jumpTo,
            })
          : null,
      )

      return h('div', { className: 'tree-tab' },
        stats,
        toolbar,
        kindbar,
        error && records.length > 0 ? h('div', { className: 'err' }, error) : null,
        treeWrap,
      )
    }

    /** 磁盘文案:MB 就是 MB,不足 1GB 时别显示成 "0GB"(曾经多除了一次 1024)。 */
    function diskText(freeDiskMb) {
      return freeDiskMb >= 1024 ? `${(freeDiskMb / 1024).toFixed(0)}GB` : `${freeDiskMb.toFixed(0)}MB`
    }

    /** 体积文案:小于 1GB 用 MB,否则 GB。 */
    function sizeText(bytes) {
      const mb = bytes / 1048576
      return mb >= 1024 ? `${(mb / 1024).toFixed(1)}GB` : `${Math.round(mb)}MB`
    }

    /** 标签气泡。 */
    function Chip({ children, tone, title }) {
      return h('span', { className: `chip${tone ? ` ${tone}` : ''}`, ...(title ? { title } : {}) }, children)
    }

    /** 运行时风味的中文名。 */
    function flavorLabel(flavor) {
      if (flavor === 'cuda') return 'CUDA（显卡）'
      if (flavor === 'vulkan') return 'Vulkan（显卡）'
      if (flavor === 'metal') return 'Metal（显卡）'
      return 'CPU'
    }

    /**
     * 统一的**自绘下拉**:模型 / 运行时 / 作用域都用它。
     *
     * 为什么不用原生 `<select>`:它画不出气泡(体积、推荐标记),也没法在按钮里放多段内容。
     * 行为对齐原生:点按钮开合、点选项选中并关闭、点外面关、Esc 关。
     * `items`: [{ value, label, chips?, recommended? }]
     */
    function Dropdown({ items, value, disabled, title, onChange, className }) {
      const [open, setOpen] = React.useState(false)
      const current = items.find((item) => item.value === value) || items[0] || null

      // 点列表外面(或按 Esc)关掉 —— 原生 select 自带的行为,自绘的得自己补。
      // document 不可用(单元测试的脚手架)时安静跳过。
      React.useEffect(() => {
        if (!open) return undefined
        const doc = typeof document !== 'undefined' ? document : undefined
        if (doc === undefined || typeof doc.addEventListener !== 'function') return undefined
        const inside = (target) => Boolean(target && typeof target.closest === 'function' && target.closest('.drop'))
        const onDown = (event) => { if (!inside(event && event.target)) setOpen(false) }
        const onKey = (event) => { if (event && event.key === 'Escape') setOpen(false) }
        doc.addEventListener('click', onDown)
        doc.addEventListener('keydown', onKey)
        return () => {
          doc.removeEventListener('click', onDown)
          doc.removeEventListener('keydown', onKey)
        }
      }, [open])

      return h('div', { className: `drop${className ? ` ${className}` : ''}` },
        h('button', {
          className: 'dropbtn',
          disabled,
          ...(title ? { title } : {}),
          'aria-haspopup': 'listbox',
          'aria-expanded': open,
          onClick: () => setOpen(!open),
        },
          h('span', { className: 'dropname' }, current === null ? '—' : current.label),
          ...(current === null ? [] : (current.chips ?? []).map((text, i) => h(Chip, { key: `c${i}` }, text))),
          current !== null && current.recommended ? h(Chip, { tone: 'rec' }, '推荐') : null,
          h('span', { className: 'caret' }, '▾'),
        ),
        open
          ? h('div', { className: 'droplist', role: 'listbox' },
              items.map((item) => h('div', {
                key: item.value,
                role: 'option',
                'aria-selected': item.value === value,
                className: `dropitem${item.value === value ? ' on' : ''}`,
                onClick: () => { setOpen(false); onChange(item.value) },
              },
                h('span', { className: 'dropname' }, item.label),
                ...(item.chips ?? []).map((text, i) => h(Chip, { key: `c${i}` }, text)),
                item.recommended ? h(Chip, { tone: 'rec' }, '推荐') : null,
              )),
            )
          : null,
      )
    }

    /**
     * 向量服务这一整块:本机配置行 + 当前模型行 + 折叠的「模型与硬件」。
     *
     * 三行放在一起,是因为它们必须**始终可见**(不展开也要看到本机配置、当前模型和安装按钮),
     * 而展开体里只放"改选择"的东西。硬件探测在面板一出现时取一次(服务端有 10 分钟缓存),
     * 所以这两行不用等展开。下拉是自绘的 —— 原生 select 画不出气泡。
     */
    function ModelPicker({ busy, installing, installedBackend, current, onInstall }) {
      const [open, setOpen] = React.useState(false)
      const [report, setReport] = React.useState(null)
      const [err, setErr] = React.useState('')
      const [preset, setPreset] = React.useState('')
      const [variant, setVariant] = React.useState('')
      const [flavor, setFlavor] = React.useState('')
      const [customOpen, setCustomOpen] = React.useState(false)
      const [url, setUrl] = React.useState('')
      const [dims, setDims] = React.useState('')

      const load = async (force) => {
        setErr('')
        try {
          setReport(await api(force ? 'embed/model/refresh' : 'embed/model', force ? {} : undefined))
        } catch (e) {
          setErr(String(e.message || e))
        }
      }
      // 面板一出现就取一次(不等到展开):未配置时要在「向量服务」下面**直接**显示
      // 默认选中(推荐)的模型与配置,而不是点开「模型与硬件」才出现。
      // 服务端对硬件探测有 10 分钟缓存,所以这次请求通常只是一次读缓存。
      React.useEffect(() => { if (report === null && err === '') load(false) }, [])

      const catalog = (report && report.catalog) || []
      const rec = report && report.recommendation
      const hw = report && report.hardware
      const options = []
      for (const m of catalog) {
        for (const v of m.variants) {
          options.push({
            key: `${m.id}/${v.id}`,
            name: m.label,
            variantLabel: v.label,
            modelId: m.id,
            variantId: v.id,
            bytes: v.bytes,
            dims: m.dims,
            pooling: m.pooling,
            // 逐档的"装没装"(服务端按 exe + 该档模型文件是否存在判断)
            installed: Boolean(v.installed),
            recommended: Boolean(rec && rec.modelId === m.id && rec.variantId === v.id),
          })
        }
      }
      const configured = Boolean(current && current.presetId && current.presetId !== 'custom')
      const fallbackKey = configured
        ? `${current.presetId}/${current.variantId}`
        : (rec ? `${rec.modelId}/${rec.variantId}` : (options[0] ? options[0].key : ''))
      const selectedKey = preset !== '' && variant !== '' ? `${preset}/${variant}` : fallbackKey
      const selected = options.find((o) => o.key === selectedKey) || options[0] || null
      const flavors = (hw && hw.flavors) || ['cpu']
      const flavorValue = flavor !== '' ? flavor : (configured ? (current.flavor || 'cpu') : (rec ? rec.flavor : 'cpu'))

      // 本机配置的四个事实(气泡行)
      const machine = hw === null || hw === undefined
        ? []
        : [
            `${hw.cpuCount} 核`,
            `${Math.round(hw.totalRamMb / 1024)}GB 内存`,
            hw.gpu ? `显卡 ${hw.gpu.name}${hw.gpu.vramMb ? `(${Math.round(hw.gpu.vramMb / 1024)}GB)` : ''}` : '无独立显卡',
            hw.freeDiskMb !== null ? `磁盘剩余 ${diskText(hw.freeDiskMb)}` : '磁盘剩余未知',
          ]
      // 「当前模型」:已配置就显示实际配置,未配置就跟着上面的选择实时变
      const currentChips = []
      if (configured) {
        const [name, variantLabel] = String(current.modelLabel || current.model || '').split(' · ')
        currentChips.push(name, variantLabel, current.dims ? `${current.dims} 维` : null, current.pooling, current.flavor)
      } else if (selected !== null) {
        currentChips.push(selected.name, selected.variantLabel, `${selected.dims} 维`, selected.pooling, flavorValue)
      }
      const chipList = currentChips.filter(Boolean)

      // 选中的这一档装没装。两个来源:catalog 的逐档标记(准,但要等清单刷新),
      // 以及后端快照 install.installed(= exe + **当前配置那份**模型文件都在)。
      // 后者让"刚下完"的那一刻按钮就能立刻变「已安装」,不用等重新拉清单。
      const alreadyInstalled = selected !== null && (selected.installed
        || (Boolean(installedBackend) && configured && selectedKey === `${current.presetId}/${current.variantId}`))
      // 已经装过东西(运行时 + 某个模型)就不许再装第二个:要换模型,先去「维护」里卸载。
      // 允许并行安装会让 <root>/llamacpp 与 models 里堆着多份文件,而配置只能指向一份,
      // 之后"当前到底在跑哪个"就说不清了。
      const hasInstalled = Boolean(installedBackend) || options.some((o) => o.installed)
      const needUninstall = selected !== null && !alreadyInstalled && hasInstalled

      // 安装/卸载状态一变就重拉清单:否则清单里"装没装"的标记会一直是旧的,
      // 卸载完按钮还卡在「需先卸载」。
      const [seenState, setSeenState] = React.useState(null)
      React.useEffect(() => {
        const now = `${installing ? 'running' : 'idle'}:${installedBackend ? 'in' : 'out'}`
        if (seenState === null) { setSeenState(now); return }
        if (seenState === now) return
        setSeenState(now)
        load(false)
      }, [installing, installedBackend, seenState])

      const pickFlavor = (next) => setFlavor(next)
      const doInstall = () => {
        if (selected === null) return
        onInstall({ preset: selected.modelId, variant: selected.variantId, flavor: flavorValue })
      }
      const doCustom = () => {
        if (url.trim() === '' || !(Number(dims) > 0)) { setErr('自定义模型需要填 URL 与维度'); return }
        onInstall({ custom: { url: url.trim(), dims: Number(dims) } })
      }

      return h('div', { className: 'vec' },
        // 两行状态气泡都带标题、都横向滚动不换行;动作按钮各自挂在这一行的最右边。
        h('div', { className: 'chipline' },
          h('span', { className: 'chiptitle' }, '本机配置：'),
          h('div', { className: 'chips' },
            (machine.length > 0 ? machine : ['读取中…']).map((label, i) => h(Chip, { key: i }, label))),
          h('button', { disabled: busy, onClick: () => load(true) }, '重新检测硬件'),
        ),
        h('div', { className: 'chipline' },
          h('span', { className: 'chiptitle' }, '当前模型：'),
          h('div', { className: 'chips' }, chipList.map((label, i) => h(Chip, { key: i }, label))),
          h('button', {
            className: 'install',
            // 四态:请求中 / 下载中 / 已装好 / 已装过别的(要先卸载)。后三种都不可点。
            disabled: busy || installing || selected === null || alreadyInstalled || needUninstall,
            ...(installing ? { title: '正在下载,进度见上方向量服务那一行' }
              : alreadyInstalled ? { title: '这一档已经装好了' }
                : needUninstall ? { title: '已经装过一个模型了。要换模型,请先在下面的「维护」里卸载向量服务' } : {}),
            onClick: doInstall,
          }, busy ? '处理中…'
            : installing ? '下载中…'
              : alreadyInstalled ? '已安装'
                : needUninstall ? '需先卸载'
                  : '下载并安装'),
        ),
        h('details', { className: 'adv', onToggle: (e) => setOpen(Boolean(e.target.open)) },
          h('summary', { className: 'advsum' },
            h('span', { className: 'advcaret' }, open ? '▾' : '▸'),
            h('span', null, '模型与硬件'),
          ),
          h('div', { className: 'advbody' },
            report === null && err === '' ? h('div', { className: 'muted' }, '正在读取…') : null,
            err ? h('div', { className: 'err' }, err) : null,
            h('div', { className: 'row' },
              h('span', { className: 'hint' }, '向量检索为可选功能，可以自定义配置任意 OpenAI 兼容的服务'),
            ),
          selected !== null
            ? h('div', { className: 'row' },
                h(Dropdown, {
                  items: options.map((o) => ({
                    value: o.key,
                    label: o.name,
                    chips: [o.variantLabel, sizeText(o.bytes)],
                    recommended: o.recommended,
                  })),
                  value: selectedKey,
                  disabled: busy,
                  className: 'modeldrop',
                  onChange: (key) => {
                    const [pid, vid] = key.split('/')
                    setPreset(pid); setVariant(vid)
                  },
                }),
                h(Dropdown, {
                  items: flavors.map((f) => ({ value: f, label: flavorLabel(f) })),
                  value: flavorValue,
                  disabled: busy,
                  title: '运行时:CPU 最稳,GPU 更快',
                  onChange: (next) => pickFlavor(next),
                }),
              )
            : null,
          h('div', { className: 'row' },
            h('button', { onClick: () => setCustomOpen(!customOpen) }, customOpen ? '收起自定义模型' : '自定义 GGUF…'),
          ),
          customOpen
            ? h('div', { className: 'row' },
                h('input', { type: 'text', placeholder: 'https://…/model.gguf', value: url, onChange: (e) => setUrl(e.target.value) }),
                h('input', { type: 'number', placeholder: '维度', value: dims, style: { width: 80 }, onChange: (e) => setDims(e.target.value) }),
                h('button', { disabled: busy, onClick: doCustom }, '安装'),
              )
            : null,
          report && report.records > 0
            ? h('div', { className: 'muted' }, `换模型会让这 ${report.records} 条记忆重新嵌入;期间检索暂时用词法匹配。`)
            : null,
          ),
        ),
      )
    }

    /** 设置项开关:轨道 + 圆点,与向量服务的 toggle 同一套视觉。 */
    function Switch({ checked, disabled, onChange, title, label }) {
      const aria = title || label
      return h('button', {
        type: 'button',
        className: 'switch' + (checked ? ' on' : ''),
        role: 'switch',
        'aria-checked': Boolean(checked),
        disabled: Boolean(disabled),
        ...(title ? { title } : {}),
        ...(aria ? { 'aria-label': aria } : {}),
        onClick: () => onChange(!checked),
      }, h('span', { className: 'knob' }))
    }

    /** 设置自动保存的合并定时器:连续调数值只发一次请求。 */
    let autoSaveTimer = null

    /**
     * 设置标签页:这些开关直接改注入行为,改完立即保存(没有"保存"按钮)。
     * 每轮召回 → 印象 → 会话摘要 → 系统提示(策略/规则) → 轮末提醒 → 界面。
     */
    const SETTINGS_GROUPS = [
      {
        key: 'recall', title: '每轮召回',
        desc: '按本轮用户消息检索记忆并插入上下文；内容没变不会重复注入。',
        fields: [
          { k: 'enabled', label: '启用', type: 'bool', hint: '关闭后每轮不再按问题检索记忆。' },
          { k: 'topK', label: '最多条数', type: 'num', min: 1, max: 20, step: 1, hint: '每次最多注入几条相关记忆。' },
          { k: 'tokenBudget', label: 'token 预算', type: 'num', min: 50, max: 4000, step: 50, hint: '召回块允许占用的最大 token 数。' },
        ],
      },
      {
        key: 'impression', title: '印象形态',
        desc: '召回时只给每条记忆的开头，模型需要细节时再用 memory_get 取全文。',
        fields: [
          { k: 'enabled', label: '启用', type: 'bool', hint: '关闭后召回直接给长文摘要。' },
          { k: 'chars', label: '每条字数', type: 'num', min: 40, max: 800, step: 20, hint: '每条记忆在召回块里保留多少字。' },
        ],
      },
      {
        key: 'digest', title: '会话摘要',
        desc: '新会话第一步给一次项目 / 全局记忆概览；正文被截断时附一条可检索的标签索引。',
        fields: [
          { k: 'enabled', label: '启用', type: 'bool', hint: '关闭后新会话不再收到记忆摘要。' },
          { k: 'topK', label: '最多条数', type: 'num', min: 1, max: 30, step: 1, hint: '摘要正文最多列几条。' },
          { k: 'tokenBudget', label: '正文预算', type: 'num', min: 50, max: 4000, step: 50, hint: '正文摘要的 token 预算；超出部分转成标签索引。' },
          { k: 'hintBudget', label: '标签预算', type: 'num', min: 30, max: 1000, step: 10, hint: '标签索引独立预算，不占正文。' },
          { k: 'hintMaxItems', label: '标签条数', type: 'num', min: 1, max: 30, step: 1, hint: '标签索引最多列几条。' },
        ],
      },
      {
        key: 'policy', title: '记忆使用策略',
        desc: '系统提示常驻段：什么时候该查记忆、查到后怎么用、查不到怎么办。',
        fields: [
          { k: 'enabled', label: '启用', type: 'bool', hint: '关闭只移除这段提示，不影响记忆检索。' },
        ],
      },
      {
        key: 'state', title: '状态记忆',
        desc: 'kind=state 的默认有效期；注入时带「状态，使用前验证」前缀，过期后默认不进检索/摘要/召回。',
        hint: '过期不会自动删除：面板和 memory_get 仍能取到，方便核对历史。',
        fields: [
          { k: 'ttlMs', label: '默认有效期(天)', type: 'num', min: 1, max: 365, step: 1, scale: 86_400_000, hint: '设置里存毫秒；面板按天编辑。' },
        ],
      },
      {
        key: 'rules', title: '硬性规则',
        desc: '把 kind=rule 的记忆放进系统提示常驻段；旧会话下一轮补一条新增 / 变更的规则。',
        hint: '关闭只影响系统提示常驻段，规则本身仍可被 memory_search 检索。',
        fields: [
          { k: 'enabled', label: '启用', type: 'bool', hint: '关闭后规则不再进入系统提示常驻段。' },
          { k: 'maxItems', label: '最多条数', type: 'num', min: 1, max: 40, step: 1, hint: '规则段最多列几条。' },
          { k: 'tokenBudget', label: 'token 预算', type: 'num', min: 50, max: 4000, step: 50, hint: '规则段的 token 上限；mandatory 溢出会额外警告。' },
          { k: 'delta', label: '变更提醒', type: 'bool', hint: '旧会话在下一轮第一步补一条新增 / 编辑过的规则；没变化不重复。' },
        ],
      },
      {
        key: 'procedures', title: '流程索引',
        desc: '把当前工作区与任务触发词命中的 procedure 列成目录（id · 触发词 → 标题），需要细节时模型用 memory_get 取全文。',
        hint: '只在系统提示里占几行，不复制流程正文；没有命中项时不注入。',
        fields: [
          { k: 'enabled', label: '启用', type: 'bool', hint: '关闭后流程只能靠 memory_search 主动检索。' },
          { k: 'maxItems', label: '最多条数', type: 'num', min: 1, max: 30, step: 1, hint: '流程索引最多列几条。' },
          { k: 'tokenBudget', label: 'token 预算', type: 'num', min: 50, max: 4000, step: 50, hint: '流程索引的 token 上限。' },
        ],
      },
      {
        key: 'autoRecall', title: '自动召回',
        desc: '从可见文本（assistant 输出、任务清单、命令 / 工具描述、失败信息）匹配记忆标签，命中即检索。',
        fields: [
          { k: 'enabled', label: '启用', type: 'bool', hint: '关闭后只保留普通每轮召回与工具失败召回。' },
          { k: 'useToolDescription', label: '使用工具 description', type: 'bool', hint: '失败或命中时优先用工具调用自己写的 description 做检索。' },
          { k: 'useMemoryTags', label: '使用记忆标签', type: 'bool', hint: '自动把记忆库里已有的标签并入触发词。' },
          { k: 'maxQueryChars', label: '查询字数上限', type: 'num', min: 40, max: 500, step: 10, hint: '单次自动召回查询最多多少字，避免把整段命令塞进检索。' },
        ],
      },
      {
        key: 'turnEnd', title: '轮末提醒',
        desc: '下一轮开头提醒把本轮结论落盘；默认关闭，避免打断连续对话。',
        fields: [
          { k: 'enabled', label: '启用', type: 'bool', hint: '开启后每轮结束会给一条“有结论就记一条”的提醒。' },
        ],
      },
      {
        key: 'sidebar', title: '侧栏入口',
        desc: '在左侧栏「插件」下方显示「记忆系统」入口，点击在主界面打开面板。',
        fields: [
          { k: 'enabled', label: '启用', type: 'bool', hint: '关闭只隐藏侧栏入口，设置页仍然可用。' },
        ],
      },
    ]

    /**
     * 自动召回“模式”编辑器:模式就是一组标签,每行一个。
     * 工具 name / description / 参数命中任一标签就召回;失败调用始终用 description。
     */
    function AutoRecallTagsEditor({ tags, onSave }) {
      const [text, setText] = React.useState((tags ?? []).join('\n'))
      return h('div', { className: 'autorecall' },
        h('div', { className: 'hint' },
          '每行一个额外标签。记忆库里已有的标签会自动并入（可关）；',
          '可见文本命中任一个就触发召回，工具失败时始终用 description 检索。'),
        h('textarea', {
          rows: 8,
          spellCheck: false,
          value: text,
          placeholder: 'release\npublish\ndeploy\ndatabase\ncredentials\n发布\n部署',
          onChange: (e) => setText(e.target.value),
        }),
        h('div', { className: 'row' },
          h('button', {
            onClick: () => onSave(text.split(/[\n,，]+/).map((tag) => tag.trim()).filter(Boolean)),
          }, '保存标签'),
          h('span', { className: 'muted' }, '额外标签为空时仍会使用记忆库标签和失败召回'),
        ),
      )
    }

    /** 单个数值 / 开关字段:label 和 hint 都必须是可见文本,不能只放在 title 里。 */
    function SettingField({ field, value, onPatch }) {
      if (field.type === 'bool') {
        const checked = Boolean(value)
        return h('div', { className: 'setfield' },
          h('div', { className: 'setfield-main' },
            h('span', { className: 'setfield-label' }, field.label),
            field.hint ? h('span', { className: 'setfield-hint' }, field.hint) : null,
          ),
          h('div', { className: 'setfield-control' },
            h(Switch, {
              checked,
              label: field.label,
              title: field.hint || field.label,
              onChange: onPatch,
            }),
            h('span', { className: 'setfield-state' }, checked ? '已开启' : '已关闭'),
          ),
        )
      }
      return h('label', { className: 'setfield' },
        h('span', { className: 'setfield-main' },
          h('span', { className: 'setfield-label' }, field.label),
          field.hint ? h('span', { className: 'setfield-hint' }, field.hint) : null,
        ),
        h('input', {
          type: 'number', min: field.min, max: field.max, step: field.step,
          value: field.scale ? Math.round(Number(value) / field.scale) : value,
          onChange: (e) => onPatch(field.scale ? Number(e.target.value) * field.scale : Number(e.target.value)),
        }),
      )
    }

    /** 一张设置卡:标题 + 描述 + 显式的「启用」开关 + 字段网格。 */
    function SettingsCard({ group, value, rulesCount, patch, tags }) {
      const enabledField = group.fields.find((field) => field.k === 'enabled' && field.type === 'bool')
      const fields = group.fields.filter((field) => field !== enabledField)
      const enabled = enabledField ? Boolean(value[enabledField.k]) : true
      return h('section', { className: 'setcard' },
        h('div', { className: 'setcard-head' },
          h('div', { className: 'setcard-heading' },
            h('div', { className: 'setcard-title' },
              group.title,
              group.key === 'rules' && rulesCount !== null
                ? h('span', { className: 'setcard-pill' }, `${rulesCount.total} 条规则 / ${rulesCount.scopes} 个作用域`)
                : null,
            ),
            h('div', { className: 'setcard-desc' }, group.desc),
          ),
          enabledField
            ? h('div', { className: 'setcard-enable' },
                h('span', { className: 'setcard-enable-label' }, enabledField.label || '启用'),
                h(Switch, {
                  checked: enabled,
                  label: enabledField.label,
                  title: enabledField.hint || `${group.title}：${enabledField.label}`,
                  onChange: (next) => patch(group.key, enabledField.k, next),
                }),
                h('span', { className: 'setcard-enable-state' }, enabled ? '已开启' : '已关闭'),
              )
            : null,
        ),
        fields.length > 0 || group.key === 'autoRecall'
          ? h('div', { className: 'setcard-body' },
              fields.map((field) => h(SettingField, {
                key: field.k,
                field,
                value: value[field.k],
                onPatch: (next) => patch(group.key, field.k, next),
              })),
              group.key === 'autoRecall'
                ? h(AutoRecallTagsEditor, {
                    tags,
                    onSave: (next) => patch('autoRecall', 'tags', next),
                  })
                : null,
            )
          : null,
        group.hint ? h('div', { className: 'setcard-note' }, group.hint) : null,
      )
    }

    function SettingsTab() {
      const [settings, setSettings] = React.useState(null)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [rulesCount, setRulesCount] = React.useState(null)
      const [dataNotice, setDataNotice] = React.useState('')

      React.useEffect(() => {
        api('settings').then(setSettings).catch((e) => setError(String(e.message || e)))
        api('status')
          .then((status) => setRulesCount(status && status.rules ? status.rules : null))
          .catch(() => setRulesCount(null))
      }, [])

      /** 导出:纯文本 JSON,不含向量(导入时按当前模型重新嵌入)。 */
      const exportAll = async () => {
        setDataNotice('')
        try {
          const doc = await api('export')
          const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = `dsh-memory-${new Date().toISOString().slice(0, 10)}.json`
          a.click()
          setTimeout(() => URL.revokeObjectURL(url), 2000)
          setDataNotice(`已导出 ${doc.records.length} 条（${doc.records.length > 0 ? '含作用域与类型' : '暂无记忆'}）`)
        } catch (e) {
          setDataNotice(`导出失败：${String(e.message || e)}`)
        }
      }

      /** 导入:接受导出的同一个文档(或记录数组),逐条走 save,自动重新嵌入。 */
      const importFile = async (event) => {
        const file = event && event.target && event.target.files && event.target.files[0]
        if (!file) return
        setDataNotice('')
        try {
          const text = await file.text()
          const doc = JSON.parse(text)
          const result = await api('import', doc)
          const firstError = result.errors && result.errors.length > 0 ? `；${result.errors[0]}` : ''
          setDataNotice(`导入完成：新增 ${result.imported}，跳过重复 ${result.skipped}，失败 ${result.rejected}${firstError}`)
          if (result.imported > 0 && typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
            try { window.dispatchEvent(new CustomEvent('dsh-memory:refresh')) } catch { /* 没有 CustomEvent 就靠下次打开面板刷新 */ }
          }
        } catch (e) {
          setDataNotice(`导入失败：${String(e.message || e)}`)
        }
        event.target.value = ''
      }

      // 改动即保存:开关/数值一变就提交(数值连续输入时合并成一次请求)，
      // 不再有"保存设置"按钮 —— 界面上也就不该再写"保存后生效"这类话。
      const patch = (group, key, value) => {
        if (!settings) return
        const next = { ...settings, [group]: { ...settings[group], [key]: value } }
        setSettings(next)
        autoSave(next)
      }

      const autoSave = (next) => {
        if (autoSaveTimer !== null) clearTimeout(autoSaveTimer)
        setError('')
        autoSaveTimer = setTimeout(async () => {
          autoSaveTimer = null
          try {
            await api('settings', next)
            setNotice('已保存')
            setTimeout(() => setNotice(''), 1500)
            if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
              try { window.dispatchEvent(new CustomEvent('dsh-memory:settings')) } catch { /* 没有 CustomEvent 就等下次启动 */ }
            }
          } catch (e) {
            setError(String(e.message || e))
          }
        }, 250)
      }

      if (!settings) return h('div', { className: 'empty' }, error || '加载设置…')

      return h('div', { className: 'setp' },
        h('div', { className: 'sethead' },
          h('div', { className: 'sethead-text' },
            h('div', { className: 'sethead-title' }, '注入设置'),
            h('div', { className: 'sethead-sub' }, '修改后立即保存到 settings.json；开关旁显示当前状态，字段下方是说明。'),
          ),
          notice ? h('span', { className: 'sethead-saved' }, notice) : null,
        ),
        h('div', { className: 'setcards' },
          SETTINGS_GROUPS.map((group) => h(SettingsCard, {
            key: group.key,
            group,
            value: settings[group.key] || {},
            rulesCount,
            patch,
            tags: settings.autoRecall && Array.isArray(settings.autoRecall.tags) ? settings.autoRecall.tags : [],
          })),
        ),
        h('section', { className: 'setcard datacard' },
          h('div', { className: 'setcard-head' },
            h('div', { className: 'setcard-heading' },
              h('div', { className: 'setcard-title' }, '数据'),
              h('div', { className: 'setcard-desc' }, '导出文本不含向量；导入按当前模型重新嵌入，并按「作用域 + 内容」去重。'),
            ),
          ),
          h('div', { className: 'setcard-body data-body' },
            h('div', { className: 'row' },
              h('button', { onClick: exportAll }, '导出全部'),
              h('label', { className: 'set-field' }, '导入文件',
                h('input', { type: 'file', accept: '.json,application/json', onChange: importFile })),
              dataNotice ? h('span', { className: 'muted' }, dataNotice) : null,
            ),
          ),
        ),
        error ? h('div', { className: 'err' }, error) : null,
      )
    }

    /**
     * 新建记忆 / 规则。作用域必须是**明确的键**:面板拿不到会话上下文,所以
     * 'project' / 'session' 这种相对写法不提供,列出现有作用域 + global,再加
     * 一个自定义输入(project:<路径> / session:<id> / 自定义名)。
     */
    function CreateForm({ scopes, onCancel, onCreated }) {
      const [scope, setScope] = React.useState('global')
      const [customScope, setCustomScope] = React.useState('')
      const [kind, setKind] = React.useState('note')
      const [content, setContent] = React.useState('')
      const [tags, setTags] = React.useState('')
      const [triggers, setTriggers] = React.useState('')
      const [importance, setImportance] = React.useState(0.6)
      const [ttlDays, setTtlDays] = React.useState(7)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')

      const scopeItems = [
        { value: 'global', label: '全局（global）' },
        ...scopes
          .filter((s) => s.scope !== 'global')
          .map((s) => ({ value: s.scope, label: s.label || scopeLabel(s.scope) })),
        { value: '__custom__', label: '自定义 / 指定作用域…' },
      ]
      const resolvedScope = scope === '__custom__' ? customScope.trim() : scope

      const submit = async () => {
        setBusy(true); setError('')
        try {
          await api('create', {
            scope: resolvedScope,
            kind,
            content,
            tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
            ...(kind === 'procedure' ? { triggers: triggers.split(',').map((t) => t.trim()).filter(Boolean) } : {}),
            importance: Number(importance),
            ...(kind === 'state' ? { ttlMs: Math.max(1, Number(ttlDays) || 7) * 86_400_000 } : {}),
          })
          setBusy(false)
          onCreated()
        } catch (e) {
          setError(String(e.message || e))
          setBusy(false)
        }
      }

      return h('div', { className: 'create' },
        h('div', { className: 'row' },
          h(Dropdown, { items: scopeItems, value: scope, disabled: busy, onChange: setScope }),
          scope === '__custom__'
            ? h('input', {
                type: 'text', style: { width: 260 },
                placeholder: 'project:<路径> / session:<id> / 自定义名',
                value: customScope, onChange: (e) => setCustomScope(e.target.value),
              })
            : null,
          h(Dropdown, {
            items: ['fact', 'decision', 'preference', 'procedure', 'note', 'rule', 'state'].map((k) => ({ value: k, label: k })),
            value: kind, disabled: busy, onChange: setKind,
          }),
          kind === 'rule' ? h('span', { className: 'warn' }, '规则会进入系统提示常驻段') : null,
          kind === 'state' ? h('span', { className: 'warn' }, '状态会带“使用前验证”前缀，过期后默认隐藏') : null,
        ),
        h('div', { className: 'row' },
          h('textarea', {
            rows: 3,
            placeholder: '内容：一句自洽的话，脱离上下文也能读懂（写之前先搜一下有没有重复）',
            value: content, onChange: (e) => setContent(e.target.value),
          }),
        ),
        h('div', { className: 'row' },
          h('label', { className: 'set-field' }, '标签 ',
            h('input', {
              type: 'text', style: { width: 190 }, placeholder: '逗号分隔，例如 pnpm, 工具链',
              value: tags, onChange: (e) => setTags(e.target.value),
            })),
          kind === 'procedure'
            ? h('label', { className: 'set-field' }, '触发词 ',
                h('input', {
                  type: 'text', style: { width: 190 }, placeholder: '工具名 / 关键词，例如 npm, deploy',
                  value: triggers, onChange: (e) => setTriggers(e.target.value),
                }))
            : null,
          h('label', null, '重要度 ',
            h('input', { type: 'number', min: 0, max: 1, step: 0.1, value: importance, onChange: (e) => setImportance(e.target.value) })),
          kind === 'state'
            ? h('label', null, '有效期(天) ',
                h('input', { type: 'number', min: 1, max: 365, step: 1, value: ttlDays, onChange: (e) => setTtlDays(e.target.value) }))
            : null,
          h('button', { onClick: submit, disabled: busy || content.trim() === '' || resolvedScope === '' }, busy ? '保存中…' : '保存'),
          h('button', { className: 'linkbtn', onClick: onCancel, disabled: busy }, '取消'),
        ),
        error ? h('div', { className: 'err' }, error) : null,
      )
    }

    // ===== 记忆审计 ↔ 会话轨迹 的桥接 =====
    //
    // DSH 的 Trajectory 面板是一个纯投影：它只声明 `conversation.trajectory.images`
    // 一个子槽，没有行/列的扩展点，选中状态也是组件私有的。但它**支持按 callId
    // 深链聚焦**（`toolCallFocus` 就是同一性映射），而每个 `conversation.view`
    // 的渲染产物都会收到 `openView(view, focus)`。所以：
    //   - 会话内的「记忆审计」视图直接用 openView('trajectory', callId)；
    //   - 主面板（不在会话视图树里）通过 `conversation.session` 条目挂的 per-session
    //     store 调同一个 action。这里是宿主 slot 服务的内部字段（`_stores`），
    //     全部做了存在性判断；拿不到就退化成“只打开会话/只切轨迹页”，绝不 throw。
    let clientCtx = null
    const AUDIT_FOCUS_EVENT = 'dsh-memory:audit-focus'
    let pendingAuditFocus = null

    function safeSlots() {
      try { return clientCtx?.get?.('slots') } catch { return undefined }
    }

    function uiWorkspace() {
      try { return clientCtx?.get?.('uiWorkspace') } catch { return undefined }
    }

    function openSessionById(id) {
      if (typeof id !== 'string' || id === '') return
      try {
        const workspace = uiWorkspace()
        if (workspace && typeof workspace.openSession === 'function') {
          workspace.openSession(id)
          return
        }
        if (typeof window !== 'undefined') window.location.hash = `#/s/${encodeURIComponent(id)}`
      } catch { /* 旧宿主没有 uiWorkspace：保持原状 */ }
    }

    /** 当前主视图保留的会话（Host 用 retainedBy.mainView 标出）。 */
    function currentSessionId() {
      try {
        const snapshot = uiWorkspace()?.sessions?.list?.getSnapshot?.()
        const rows = snapshot && snapshot.byId ? Object.values(snapshot.byId) : []
        const current = rows.find((row) => row && row.retainedBy && (row.retainedBy.mainView ?? 0) > 0)
        return current && typeof current.id === 'string' ? current.id : undefined
      } catch {
        return undefined
      }
    }

    /** 审计条目的轨迹锚：优先 operationId（记忆工具调用/工具信号），其次 signal.callId。 */
    function auditEntryCallId(entry) {
      if (!entry || typeof entry !== 'object') return undefined
      if (typeof entry.operationId === 'string' && entry.operationId !== '') return entry.operationId
      const signalCall = entry.signal && typeof entry.signal.callId === 'string' ? entry.signal.callId : ''
      return signalCall !== '' ? signalCall : undefined
    }

    /**
     * Trajectory 的行 key 形如 `tool\0call\0<callId>`，但 DOM 上看到的是
     * `trajectoryVirtualRecordKey()` 返回的 **URI 编码**（`tool%00call%00callId`）。
     * 必须 decode 一次再解析；collapsed summary 还会追加 `\0summary\0<kind>`。
     */
    function trajectoryRowCallId(row) {
      try {
        const raw = row && typeof row.getAttribute === 'function' ? row.getAttribute('data-trajectory-row-key') : ''
        if (typeof raw !== 'string' || raw === '') return undefined
        let key = raw
        try { key = decodeURIComponent(raw) } catch { /* 不是合法编码时按原文解析 */ }
        const sep = '\u0000call\u0000'
        const at = key.indexOf(sep)
        if (at < 0) return undefined
        const rest = key.slice(at + sep.length)
        const cut = rest.indexOf('\u0000')
        const callId = cut < 0 ? rest : rest.slice(0, cut)
        return callId === '' ? undefined : callId
      } catch {
        return undefined
      }
    }

    /**
     * 轨迹行可见区域：表格滚动容器（`_tablePane`）的上下边界，扣掉 sticky 表头，
     * 底部再扣掉浮动的 composer。
     * fixed 定位的浮层不会被表格的 overflow 裁剪，所以必须自己做这个裁剪；
     * 否则行滚到表头/工具栏上方或 composer 后面时，图标还会留在原地。
     */
    function trajectoryRowClip(row) {
      try {
        if (!row || typeof row.closest !== 'function') return null
        const pane = row.closest('[class*="_tablePane"]')
        if (!pane) return null
        const paneRect = pane.getBoundingClientRect()
        if (paneRect.height <= 0) return null
        const table = row.closest('table')
        const head = table && typeof table.querySelector === 'function' ? table.querySelector('thead') : null
        const headRect = head ? head.getBoundingClientRect() : null
        let bottom = paneRect.bottom
        // Trajectory 把 composer 浮在 ledger 底部；表格会一直延伸到它后面。
        // composer 可见时，浮层不应盖在输入框上。
        const root = typeof row.closest === 'function' ? row.closest('[class*="_scrollBody"]') : null
        let composer = null
        try {
          composer = root && typeof root.querySelector === 'function'
            ? root.querySelector('[class*="_composerSeat"]')
            : (typeof document !== 'undefined' ? document.querySelector('[class*="_composerSeat"]') : null)
        } catch { composer = null }
        if (composer !== null) {
          const composerRect = composer.getBoundingClientRect()
          if (composerRect.height > 0 && composerRect.top > paneRect.top) {
            bottom = Math.min(bottom, composerRect.top)
          }
        }
        return {
          top: Math.max(paneRect.top, headRect ? headRect.bottom : paneRect.top),
          bottom,
        }
      } catch {
        return null
      }
    }

    /**
     * `conversation.session` 注册时把 per-session store 交给 slot 服务；服务把实例
     * 放在 `_stores` 的 handle 记录里，按 session id 解析。这是主面板唯一能拿到
     * `openView` 的路径（slot 只把 actions 交给注册者自己）。
     */
    function conversationStoreFor(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return undefined
      try {
        const slots = safeSlots()
        const entries = slots?.entries?.('conversation.session') ?? []
        const handle = entries.map((entry) => entry?.store).find((value) => value !== undefined)
        if (handle === undefined) return undefined
        const record = slots?._stores?.get?.(handle)
        const instances = record && record.instances
        if (!(instances instanceof Map)) return undefined
        const direct = instances.get(sessionId)
        if (direct !== undefined) return direct
        for (const [key, store] of instances) {
          if (String(key) === sessionId || String(key).endsWith(sessionId)) return store
        }
        if (instances.size === 1) return [...instances.values()][0]
        return undefined
      } catch {
        return undefined
      }
    }

    function setConversationView(sessionId, view, focus) {
      const store = conversationStoreFor(sessionId)
      const actions = store && store.actions
      if (!actions) return false
      try {
        if (typeof actions.openView === 'function') {
          actions.openView(view, focus)
          return true
        }
        if (typeof actions.setView === 'function') {
          actions.setView(view)
          return true
        }
      } catch { /* action 失败：调用方退化成打开会话 */ }
      return false
    }

    /** 打开会话并把 Trajectory 切到指定 callId；拿不到 store 时轮询等待会话挂载。 */
    async function jumpToTrajectory(sessionId, focus) {
      if (typeof sessionId !== 'string' || sessionId === '') return { opened: false, focused: false }
      openSessionById(sessionId)
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const store = conversationStoreFor(sessionId)
        const actions = store && store.actions
        if (actions) {
          try {
            if (focus !== undefined && typeof actions.openView === 'function') {
              actions.openView('trajectory', focus)
              return { opened: true, focused: true }
            }
            if (typeof actions.setView === 'function') {
              actions.setView('trajectory')
              return { opened: true, focused: false }
            }
          } catch { /* 继续重试 */ }
        }
        await new Promise((resolve) => setTimeout(resolve, 75))
      }
      return { opened: false, focused: false }
    }

    /** 无 operationId 时，用 turn/step 去 Host 的会话事件里找该步的工具调用。 */
    async function resolveAuditFocus(entry) {
      const direct = auditEntryCallId(entry)
      if (direct !== undefined) return direct
      if (!entry || typeof entry.sessionId !== 'string' || entry.sessionId === '') return undefined
      if (typeof entry.turn !== 'number' && typeof entry.step !== 'number') return undefined
      try {
        const params = new URLSearchParams({ session: entry.sessionId })
        if (typeof entry.turn === 'number') params.set('turn', String(entry.turn))
        if (typeof entry.step === 'number') params.set('step', String(entry.step))
        const value = await api(`anchor?${params.toString()}`)
        return value && typeof value.callId === 'string' && value.callId !== '' ? value.callId : undefined
      } catch {
        return undefined
      }
    }

    async function jumpAuditEntryToTrajectory(entry) {
      if (!entry || typeof entry.sessionId !== 'string' || entry.sessionId === '') {
        return { opened: false, focused: false, reason: 'no_session' }
      }
      const focus = await resolveAuditFocus(entry)
      const result = await jumpToTrajectory(entry.sessionId, focus)
      return { ...result, reason: focus === undefined ? 'no_anchor' : 'focused' }
    }

    function requestAuditFocus(target) {
      pendingAuditFocus = target && typeof target === 'object' ? { ...target, at: Date.now() } : null
      try {
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
          window.dispatchEvent(new CustomEvent(AUDIT_FOCUS_EVENT, { detail: pendingAuditFocus }))
        }
      } catch { /* 没有 CustomEvent 时靠挂载时取一次 */ }
    }

    function takeAuditFocus(audience) {
      const target = pendingAuditFocus
      if (!target) return null
      if (audience && target.audience && target.audience !== audience) return null
      pendingAuditFocus = null
      return target
    }

    /** 只读探测：面板挂载时据此先切到「审计」标签，再让 AuditTab 自己消费。 */
    function peekAuditFocus(audience) {
      const target = pendingAuditFocus
      if (!target) return null
      if (audience && target.audience && target.audience !== audience) return null
      return target
    }

    // ===== 记录焦点总线：审批浮层里的记忆 ID → 面板「记录」页并展开卡片 =====
    const RECORD_FOCUS_EVENT = 'dsh-memory:record-focus'
    let pendingRecordFocus = null

    function requestRecordFocus(target) {
      pendingRecordFocus = target && typeof target === 'object' ? { ...target, at: Date.now() } : null
      try {
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
          window.dispatchEvent(new CustomEvent(RECORD_FOCUS_EVENT, { detail: pendingRecordFocus }))
        }
      } catch { /* 没有 CustomEvent 时靠面板挂载时取一次 */ }
    }

    function takeRecordFocus() {
      const target = pendingRecordFocus
      if (!target) return null
      pendingRecordFocus = null
      return target
    }

    function peekRecordFocus() {
      return pendingRecordFocus
    }

    /**
     * 打开记忆面板并定位到某条记录(审批浮层 hover 的点击动作)。
     * 优先侧栏主面板；没有侧栏入口时打开设置页。目标由面板挂载/事件消费。
     */
    function openMemoryRecordPanel(id, scope, record) {
      if (typeof id !== 'string' || id === '') return 'none'
      requestRecordFocus({ id, scope: typeof scope === 'string' ? scope : '', record: record || null })
      try {
        const main = safeSlots()?.entries?.('main') ?? []
        if (main.some((entry) => entry?.options?.key === 'memory')) {
          try { clientCtx?.get?.('layout')?.selectPanel?.('memory') } catch { /* 交给挂载消费 */ }
          return 'panel'
        }
      } catch { /* fallthrough */ }
      try {
        const settings = clientCtx?.get?.('settings')
        const openSection = settings?.store?.actions?.openSection ?? settings?.actions?.openSection ?? settings?.openSection
        if (typeof openSection === 'function') { openSection('memory'); return 'settings' }
      } catch { /* fallthrough */ }
      try { clientCtx?.get?.('layout')?.selectPanel?.('settings') } catch { /* 无布局服务 */ }
      return 'settings'
    }

    /**
     * 从轨迹/头部入口打开记忆审计：优先主面板；没有侧栏入口时切到会话内的
     * 「记忆」视图；两者都不可用时至少打开设置页（面板挂载后会消费 pending）。
     */
    function openMemoryAuditPanel(target) {
      const sessionId = target && typeof target.sessionId === 'string' ? target.sessionId : undefined
      try {
        const main = safeSlots()?.entries?.('main') ?? []
        if (main.some((entry) => entry?.options?.key === 'memory')) {
          requestAuditFocus({ ...target, audience: 'panel' })
          try { clientCtx?.get?.('layout')?.selectPanel?.('memory') } catch { /* 交给挂载消费 */ }
          return 'panel'
        }
      } catch { /* fallthrough */ }
      try {
        const views = safeSlots()?.entries?.('conversation.view') ?? []
        const hasView = views.some((entry) => entry?.options?.id === 'memory')
        if (hasView && sessionId !== undefined && conversationStoreFor(sessionId) !== undefined) {
          requestAuditFocus({ ...target, audience: 'view' })
          if (setConversationView(sessionId, 'memory')) return 'view'
        }
      } catch { /* fallthrough */ }
      requestAuditFocus({ ...target, audience: 'panel' })
      try { clientCtx?.get?.('layout')?.selectPanel?.('settings') } catch { /* 无布局服务 */ }
      return 'settings'
    }

    // ===== 审计标签页 =====
    const AUDIT_CHANNEL_META = {
      digest: '摘要', recall: '召回', rules: '规则', rules_delta: '规则增量',
      policy: '策略', nudge: '提醒', signal: '信号', lifecycle: '生命周期',
    }
    const AUDIT_OUTCOME_META = {
      success: { label: '成功', tone: 'ok' },
      failed: { label: '失败', tone: 'bad' },
      skipped: { label: '跳过', tone: 'mute' },
      partial: { label: '部分', tone: 'warn' },
      unknown: { label: '未知', tone: 'mute' },
    }
    const AUDIT_DELIVERY_META = {
      appended: { label: '已投递', tone: 'ok' },
      suppressed: { label: '被抑制', tone: 'warn' },
      rejected: { label: '被拒绝', tone: 'bad' },
      not_attempted: { label: '未尝试', tone: 'mute' },
      unknown: { label: '未确认', tone: 'mute' },
    }

    function readAuditSession() {
      try { return window.localStorage.getItem('dsh-memory:audit-session') || '' } catch { return '' }
    }
    function writeAuditSession(value) {
      try {
        if (value) window.localStorage.setItem('dsh-memory:audit-session', value)
        else window.localStorage.removeItem('dsh-memory:audit-session')
      } catch { /* 隐私模式等 */ }
    }
    function auditChannelLabel(channel) {
      return AUDIT_CHANNEL_META[channel] || String(channel || '未知')
    }
    function auditOutcomeMeta(outcome) {
      return AUDIT_OUTCOME_META[outcome] || { label: String(outcome || '未知'), tone: 'mute' }
    }
    function auditDeliveryMeta(entry) {
      const delivery = entry && entry.delivery
      if (!delivery || !delivery.status) return { label: '未记录', tone: 'mute', detail: '' }
      let meta = AUDIT_DELIVERY_META[delivery.status] || { label: String(delivery.status), tone: 'mute' }
      if (delivery.status === 'unknown' && entry.reasonCode === 'prepared') {
        meta = { label: '已准备（投递未确认）', tone: 'warn' }
      }
      const reason = delivery.suppressedBy ? `（${delivery.suppressedBy}）` : ''
      return { ...meta, detail: reason }
    }
    function auditPill(text, tone, title) {
      return h('span', { className: `audit-pill ${tone || 'mute'}`, ...(title ? { title } : {}) }, text)
    }
    function auditBudgetOf(entry) {
      const budgets = entry && entry.budgets ? entry.budgets : null
      if (!budgets) return null
      const name = Object.keys(budgets)[0]
      return name ? { name, ...budgets[name] } : null
    }
    function auditSummaryLine(entry) {
      if (!entry) return ''
      if (entry.kind === 'delivery') {
        const meta = auditDeliveryMeta(entry)
        return `${meta.label}${meta.detail}${entry.delivery && entry.delivery.textChars ? ` · ${entry.delivery.textChars} 字符` : ''}`
      }
      if (entry.kind === 'signal') {
        if (entry.stage === 'tool_call') return `记忆工具调用${entry.signal && entry.signal.tool ? ` · ${entry.signal.tool}` : ''}`
        const stage = entry.stage === 'signal_consumed' ? '信号已消费' : entry.stage === 'signal_dropped' ? '信号被丢弃' : '信号已排队'
        return `${stage}${entry.signal && entry.signal.reason ? ` · ${entry.signal.reason}` : ''}`
      }
      if (entry.error) return `失败：${entry.error.code}（${entry.error.stage}）`
      if (entry.reasonCode === 'no_candidates') return '没有候选'
      if (entry.reasonCode === 'all_omitted') return '候选全部被省略'
      if (entry.reasonCode === 'deduped') return '全部命中已注入去重'
      if (entry.reasonCode === 'retrieval_failed') return '检索失败'
      if (entry.selected && entry.selected.count > 0) return `选中 ${entry.selected.count} 条`
      return entry.reasonCode || '—'
    }
    async function copyAuditText(text, setNotice) {
      try {
        if (navigator?.clipboard?.writeText) {
          await navigator.clipboard.writeText(text)
          setNotice('已复制')
          setTimeout(() => setNotice(''), 2200)
          return
        }
      } catch { /* fallthrough */ }
      setNotice('复制失败：浏览器不允许访问剪贴板')
    }

    /**
     * 独立“审计”标签页：事件流 + 详情 + 健康状态。
     *
     * 数据全部来自 /memory/api/audit；没有数据就显示真实空状态，不补造。
     * 展示口径：evaluation 的“选中”不等于投递；投递看 delivery 事件的 status。
     */
    const AUDIT_RANGE_META = [
      { value: '', label: '全部时间', ms: null },
      { value: '15m', label: '近 15 分钟', ms: 15 * 60_000 },
      { value: '1h', label: '近 1 小时', ms: 60 * 60_000 },
      { value: '24h', label: '近 24 小时', ms: 24 * 60 * 60_000 },
      { value: '7d', label: '近 7 天', ms: 7 * 24 * 60 * 60_000 },
      { value: '30d', label: '近 30 天', ms: 30 * 24 * 60 * 60_000 },
      { value: 'custom', label: '自定义日期…', ms: null },
    ]

    const AUDIT_OMIT_LABEL = {
      top_k: '条数上限', budget: '预算', superseded: '已退役', expired: '已过期',
      tag_mismatch: '标签不匹配', dedup: '去重', excluded: '被排除', skipped: '跳过',
    }

    function AuditTab({
      scopes,
      records = [],
      openRecord,
      openSession,
      sessionInfo,
      audience = 'panel',
      lockSession,
      openTrajectory,
    }) {
      const [entries, setEntries] = React.useState([])
      const [stats, setStats] = React.useState(null)
      const [total, setTotal] = React.useState(0)
      const [nextCursor, setNextCursor] = React.useState(null)
      const [cursorStack, setCursorStack] = React.useState([])
      const [cursor, setCursor] = React.useState('')
      const [loading, setLoading] = React.useState(true)
      const [error, setError] = React.useState('')
      const [copyNotice, setCopyNotice] = React.useState('')
      const [exportNotice, setExportNotice] = React.useState('')
      const [focusNotice, setFocusNotice] = React.useState('')
      const [focusBusy, setFocusBusy] = React.useState(false)
      const [autoRefresh, setAutoRefresh] = React.useState(true)
      const [refreshMs, setRefreshMs] = React.useState(500)
      const loadingRef = React.useRef(false)
      const [session, setSession] = React.useState(lockSession || readAuditSession())
      const [channel, setChannel] = React.useState('')
      const [outcome, setOutcome] = React.useState('')
      const [trigger, setTrigger] = React.useState('')
      const [search, setSearch] = React.useState('')
      const [problem, setProblem] = React.useState(false)
      const [range, setRange] = React.useState('')
      const [since, setSince] = React.useState('')
      const [until, setUntil] = React.useState('')
      const [selectedId, setSelectedId] = React.useState(null)
      const [reloadTick, setReloadTick] = React.useState(0)
      const [tip, setTip] = React.useState(null)
      const [recordCache, setRecordCache] = React.useState({})
      const tipTimer = React.useRef(null)
      const hideTimer = React.useRef(null)
      const effectiveSession = lockSession || session

      function queryParams(cursorValue) {
        const params = new URLSearchParams()
        if (effectiveSession) params.set('session', effectiveSession)
        if (channel) params.set('channel', channel)
        if (outcome) params.set('outcome', outcome)
        if (trigger.trim()) params.set('trigger', trigger.trim())
        const needle = search.trim()
        if (needle) {
          if (needle.startsWith('trace:')) params.set('trace', needle.slice(6).trim())
          else if (needle.startsWith('op:')) params.set('operation', needle.slice(3).trim())
          else params.set('memory', needle)
        }
        if (problem) params.set('problem', '1')
        const rangeMeta = AUDIT_RANGE_META.find((item) => item.value === range)
        if (rangeMeta && rangeMeta.ms !== null) params.set('since', String(Date.now() - rangeMeta.ms))
        if (range === 'custom') {
          if (since) params.set('since', String(new Date(`${since}T00:00:00`).getTime()))
          if (until) params.set('until', String(new Date(`${until}T23:59:59.999`).getTime()))
        }
        if (cursorValue) params.set('cursor', cursorValue)
        params.set('limit', '50')
        return params
      }

      async function load(cursorValue, stack, options = {}) {
        const silent = options.silent === true
        if (silent && loadingRef.current) return
        loadingRef.current = true
        if (!silent) { setLoading(true); setError('') }
        try {
          const value = await api(`audit?${queryParams(cursorValue)}`)
          const list = Array.isArray(value.entries) ? value.entries : []
          setEntries(list)
          setStats(value.stats || null)
          setTotal(typeof value.total === 'number' ? value.total : list.length)
          setNextCursor(typeof value.nextCursor === 'string' ? value.nextCursor : null)
          setCursor(cursorValue || '')
          if (stack !== undefined) setCursorStack(stack)
          if (selectedId !== null && !list.some((entry) => entry.id === selectedId)) { setSelectedId(null); setCopyNotice('') }
          if (silent) setError('')
        } catch (e) {
          setError(String(e.message || e))
          if (!silent) setEntries([])
        }
        loadingRef.current = false
        if (!silent) setLoading(false)
      }

      React.useEffect(() => { load('', []) }, [reloadTick])

      // 从轨迹行/会话头部跳到审计时，可能带着 session + callId + 具体事件 id。
      // 面板挂载时先取一次 pending，之后靠同一个 window 事件接收（面板已经在
      // 屏幕上时不必重挂）。只消费与自己 audience 匹配的目标。
      React.useEffect(() => {
        const applyFocus = () => {
          const target = takeAuditFocus(audience)
          if (!target) return
          if (!lockSession && typeof target.sessionId === 'string' && target.sessionId !== '') {
            setSession(target.sessionId)
            writeAuditSession(target.sessionId)
          }
          if (typeof target.callId === 'string' && target.callId !== '') {
            setSearch(`op:${target.callId}`)
            setFocusNotice(`已定位到轨迹调用 ${target.callId.slice(0, 12)}`)
          } else if (!lockSession) {
            setSearch('')
          }
          if (typeof target.entryId === 'string' && target.entryId !== '') setSelectedId(target.entryId)
          setReloadTick((n) => n + 1)
        }
        applyFocus()
        const onFocus = () => applyFocus()
        try {
          if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener(AUDIT_FOCUS_EVENT, onFocus)
        } catch { /* 没有 window 事件也能靠挂载时消费 */ }
        return () => {
          try {
            if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') window.removeEventListener(AUDIT_FOCUS_EVENT, onFocus)
          } catch { /* cleanup 失败不影响面板 */ }
        }
      }, [audience, lockSession])

      // 自动刷新：默认 500ms，可关；页面隐藏时跳过，避免后台无意义轮询。
      React.useEffect(() => {
        if (!autoRefresh) return undefined
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden) return
          load(cursor, cursorStack, { silent: true })
        }, refreshMs)
        return () => clearInterval(timer)
      }, [autoRefresh, refreshMs, cursor, cursorStack, effectiveSession, channel, outcome, trigger, search, problem, range, since, until])

      const resetAndReload = () => { setCursor(''); setCursorStack([]); setReloadTick((n) => n + 1) }
      const selected = selectedId === null ? null : entries.find((entry) => entry.id === selectedId) || null

      // 记忆 ID / 会话 ID 的悬停浮窗与跳转。
      const recordMap = {}
      for (const rec of records) if (rec && rec.id) recordMap[rec.id] = rec
      for (const [id, rec] of Object.entries(recordCache)) if (!recordMap[id]) recordMap[id] = rec
      const findRecord = (id) => {
        if (recordMap[id]) return recordMap[id]
        return records.find((rec) => rec && rec.id && rec.id.startsWith(id)) || recordCache[id]
      }
      const fetchRecord = async (id) => {
        const known = findRecord(id)
        if (known) return known
        try {
          const value = await api(`records?id=${encodeURIComponent(id)}`)
          const rec = Array.isArray(value.records) ? value.records[0] : undefined
          if (rec !== undefined) setRecordCache((prev) => ({ ...prev, [rec.id]: rec, [id]: rec }))
          return rec
        } catch {
          return undefined
        }
      }
      const clearTipTimers = () => {
        if (tipTimer.current !== null) { clearTimeout(tipTimer.current); tipTimer.current = null }
        if (hideTimer.current !== null) { clearTimeout(hideTimer.current); hideTimer.current = null }
      }
      React.useEffect(() => () => clearTipTimers(), [])
      const positionForAnchor = (element) => {
        const width = typeof window !== 'undefined' ? window.innerWidth : 1200
        const height = typeof window !== 'undefined' ? window.innerHeight : 800
        const rect = element && typeof element.getBoundingClientRect === 'function' ? element.getBoundingClientRect() : null
        if (rect === null) return { x: 12, y: 12 }
        const tipWidth = Math.min(380, width - 24)
        const tipHeight = 240
        const x = Math.max(12, Math.min(rect.left, width - tipWidth - 12))
        let y = rect.bottom + 8
        if (y + tipHeight > height - 12) y = Math.max(12, rect.top - tipHeight - 8)
        return { x, y }
      }
      const scheduleTip = (build, element) => {
        clearTipTimers()
        if (tip !== null && tip.id !== build().id) setTip(null)
        tipTimer.current = setTimeout(() => {
          tipTimer.current = null
          setTip({ ...build(), ...positionForAnchor(element) })
        }, 350)
      }
      const cancelHideTip = () => {
        if (hideTimer.current !== null) { clearTimeout(hideTimer.current); hideTimer.current = null }
      }
      const scheduleHideTip = () => {
        if (tipTimer.current !== null) { clearTimeout(tipTimer.current); tipTimer.current = null }
        cancelHideTip()
        hideTimer.current = setTimeout(() => { hideTimer.current = null; setTip(null) }, 220)
      }
      const hideTip = () => { clearTipTimers(); setTip(null) }
      const showMemoryTip = (id, element) => {
        const known = findRecord(id)
        const box = { record: known }
        scheduleTip(() => ({ type: 'memory', id, record: box.record, loading: box.record === undefined }), element)
        if (known === undefined) {
          fetchRecord(id).then((record) => {
            if (record === undefined) return
            box.record = record
            setTip((prev) => prev !== null && prev.id === id ? { ...prev, record, loading: false } : prev)
          })
        }
      }
      const showSessionTip = (id, element) => {
        const summary = typeof sessionInfo === 'function' ? (() => { try { return sessionInfo(id) } catch { return undefined } })() : undefined
        scheduleTip(() => ({ type: 'session', id, summary }), element)
      }
      const openMemoryId = async (id) => {
        const record = findRecord(id) || await fetchRecord(id)
        hideTip()
        if (typeof openRecord === 'function') openRecord(record?.id ?? id, record?.scope, record)
      }
      const openSessionId = (id) => {
        hideTip()
        if (typeof openSession === 'function') openSession(id)
      }
      const idChip = (id, tone = '', title = undefined) => h('button', {
        key: `${tone}:${id}`,
        className: 'audit-id' + (tone ? ` ${tone}` : ''),
        'aria-label': title || id,
        onMouseEnter: (event) => showMemoryTip(id, event.currentTarget),
        onMouseLeave: scheduleHideTip,
        onClick: () => openMemoryId(id),
      }, id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id)

      const prepared = entries.filter((entry) => entry.delivery && entry.delivery.status === 'unknown' && entry.reasonCode === 'prepared').length
      const suppressed = entries.filter((entry) => entry.delivery && (entry.delivery.status === 'suppressed' || entry.delivery.status === 'not_attempted')).length
      const failed = entries.filter((entry) => entry.outcome === 'failed').length
      const persistence = stats && stats.persistence ? stats.persistence : 'memory'
      const capacity = stats && typeof stats.capacity === 'number' ? stats.capacity : null
      const dropped = stats && typeof stats.dropped === 'number' ? stats.dropped : 0
      const writeErrors = stats && typeof stats.writeErrors === 'number' ? stats.writeErrors : 0
      const sessionOptions = [{ value: '', label: '全部会话（显式）' }]
        .concat((scopes || []).filter((scope) => scope.scope?.startsWith('session:')).map((scope) => ({
          value: scope.scope.slice('session:'.length),
          label: scope.label || scopeDisplayName(scope.scope),
        })))
      if (effectiveSession && !sessionOptions.some((item) => item.value === effectiveSession)) {
        sessionOptions.push({ value: effectiveSession, label: scopeDisplayName(`session:${effectiveSession}`) })
      }
      const channelOptions = [{ value: '', label: '全部通道' }].concat(Object.keys(AUDIT_CHANNEL_META).map((key) => ({ value: key, label: AUDIT_CHANNEL_META[key] })))
      const outcomeOptions = [{ value: '', label: '全部结果' }].concat(Object.keys(AUDIT_OUTCOME_META).map((key) => ({ value: key, label: AUDIT_OUTCOME_META[key].label })))
      const rangeOptions = AUDIT_RANGE_META.map((item) => ({ value: item.value, label: item.label }))
      const refreshOptions = [500, 1000, 2000, 5000, 10000].map((ms) => ({ value: String(ms), label: `${ms / 1000} 秒` }))

      const exportAudit = async (format) => {
        setExportNotice('')
        try {
          const res = await fetch(`${API}/audit/export?${queryParams('')}&format=${format}`)
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const blob = await res.blob()
          const url = URL.createObjectURL(blob)
          const link = document.createElement('a')
          link.href = url
          link.download = `dsh-memory-audit.${format}`
          link.click()
          setTimeout(() => URL.revokeObjectURL(url), 1000)
          setExportNotice(`已导出当前筛选（${format.toUpperCase()}）。`)
          setTimeout(() => setExportNotice(''), 2200)
        } catch (e) {
          setExportNotice(`导出失败：${String(e.message || e)}`)
        }
      }

      const banner = []
      if (persistence === 'memory') {
        banner.push(h('div', { className: 'audit-banner', key: 'mem' },
          `内存模式：重启后记录不会保留${capacity === null ? '' : `；当前容量 ${capacity} 条`}${dropped > 0 ? `，已有 ${dropped} 条被容量策略丢弃` : ''}。`))
      } else if (persistence === 'degraded') {
        banner.push(h('div', { className: 'audit-banner bad', key: 'deg' }, '审计存储处于降级状态：部分记录可能缺失。'))
      }
      if (writeErrors > 0) {
        banner.push(h('div', { className: 'audit-banner bad', key: 'err' }, `审计写入失败 ${writeErrors} 次；面板数据可能不完整。`))
      }

      const filterActive = Boolean(effectiveSession || channel || outcome || trigger || search || problem || range)
      const toolbar = h('div', { className: 'audit-toolbar' },
        h('div', { className: 'audit-filter-row' },
          lockSession
            ? h('span', { className: 'audit-pill mute', title: lockSession }, scopeDisplayName(`session:${lockSession}`))
            : h(Dropdown, {
                items: sessionOptions, value: session, disabled: loading,
                onChange: (next) => { setSession(next); writeAuditSession(next); resetAndReload() },
              }),
          h(Dropdown, {
            items: channelOptions, value: channel, disabled: loading,
            onChange: (next) => { setChannel(next); resetAndReload() },
          }),
          h(Dropdown, {
            items: outcomeOptions, value: outcome, disabled: loading,
            onChange: (next) => { setOutcome(next); resetAndReload() },
          }),
          h(Dropdown, {
            items: rangeOptions, value: range, disabled: loading,
            onChange: (next) => { setRange(next); resetAndReload() },
          }),
          h('input', {
            type: 'search', className: 'audit-search', placeholder: '搜索 memory / trace: / op:', value: search,
            'aria-label': '按 memory / trace / operation ID 搜索',
            onChange: (e) => setSearch(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') resetAndReload() },
          }),
          h('span', { className: 'audit-switch' },
            h(Switch, { checked: problem, disabled: loading, label: '仅看问题', onChange: (next) => { setProblem(next); resetAndReload() } }),
            '仅看问题',
          ),
          h('span', { className: 'spacer' }),
          h('button', { disabled: loading, onClick: () => setReloadTick((n) => n + 1) }, loading ? '刷新中…' : '刷新'),
        ),
        h('div', { className: 'audit-filter-row audit-filter-sub' },
          h('span', { className: 'audit-switch' },
            h(Switch, { checked: autoRefresh, disabled: loading, label: '自动刷新', onChange: (next) => setAutoRefresh(next) }),
            '自动刷新',
          ),
          h(Dropdown, {
            items: refreshOptions, value: String(refreshMs), disabled: loading || !autoRefresh,
            onChange: (next) => setRefreshMs(Number(next)),
          }),
          h('input', {
            type: 'text', className: 'audit-trigger', placeholder: '触发源', value: trigger,
            'aria-label': '按触发源筛选',
            onChange: (e) => setTrigger(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') resetAndReload() },
          }),
          range === 'custom'
            ? h('input', {
                type: 'text', className: 'audit-date', placeholder: '开始 YYYY-MM-DD', value: since,
                'aria-label': '自定义开始日期', inputMode: 'numeric',
                onChange: (e) => setSince(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') resetAndReload() },
              })
            : null,
          range === 'custom' ? h('span', { className: 'audit-range-sep' }, '→') : null,
          range === 'custom'
            ? h('input', {
                type: 'text', className: 'audit-date', placeholder: '结束 YYYY-MM-DD', value: until,
                'aria-label': '自定义结束日期', inputMode: 'numeric',
                onChange: (e) => setUntil(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') resetAndReload() },
              })
            : null,
          filterActive
            ? h('button', { className: 'linkbtn', onClick: () => {
                setSession(lockSession || ''); if (!lockSession) writeAuditSession(''); setChannel(''); setOutcome(''); setTrigger(''); setSearch(''); setProblem(false); setRange(''); setSince(''); setUntil(''); resetAndReload()
              } }, '清空筛选')
            : null,
          h('span', { className: 'spacer' }),
          h('button', { disabled: loading, onClick: () => exportAudit('jsonl') }, '导出 JSONL'),
          h('button', { disabled: loading, onClick: () => exportAudit('json') }, '导出 JSON'),
          exportNotice ? h('span', { className: 'audit-inline-note' }, exportNotice) : null,
        ),
      )

      const row = (entry) => {
        const delivery = auditDeliveryMeta(entry)
        const outcomeMeta = auditOutcomeMeta(entry.outcome)
        const budget = auditBudgetOf(entry)
        const picked = entry.selected ? entry.selected.count : 0
        const omitted = Array.isArray(entry.omitted) ? entry.omitted.length : 0
        const candidates = typeof entry.candidates === 'number' ? entry.candidates : '—'
        return h('button', {
          key: entry.id,
          className: 'audit-row' + (entry.id === selectedId ? ' on' : ''),
          onClick: () => { setSelectedId(entry.id); setCopyNotice('') },
        },
          h('span', { className: 'm t col-time', title: fmtTime(entry.at) }, shortTime(entry.at)),
          h('span', { className: 'm col-channel' },
            h('b', { className: 'ch' }, auditChannelLabel(entry.channel)),
            h('span', { className: 'trig' }, ` · ${entry.kind || 'event'}`),
          ),
          h('span', { className: 'm trig col-trigger', title: `${entry.trigger || ''} ${entry.phase || ''}` },
            `${entry.trigger || '—'}${entry.phase ? ` / ${entry.phase}` : ''}`),
          h('span', { className: 'm nums col-nums' }, `${candidates} / ${picked} / ${omitted}`),
          h('span', { className: 'm col-budget' }, budget
            ? h('span', { className: 'audit-budget-compact' },
                h('span', { className: 'bar' }, h('i', { className: budget.over ? 'over' : '', style: { width: `${budget.budget > 0 ? Math.min(100, Math.round((budget.used / budget.budget) * 100)) : 100}%` } })),
                h('span', { className: 'num' }, `${budget.used}/${budget.budget}`),
              )
            : h('span', { className: 'muted' }, '—')),
          h('span', { className: 'm del col-delivery' }, auditPill(delivery.label + delivery.detail, delivery.tone, delivery.detail || undefined)),
          h('span', { className: 'm col-outcome' }, auditPill(outcomeMeta.label, outcomeMeta.tone)),
        )
      }

      const detail = selected ? (() => {
        const delivery = auditDeliveryMeta(selected)
        const budgetRows = Object.entries(selected.budgets || {}).map(([name, budget]) => {
          const pct = budget.budget > 0 ? Math.min(100, Math.round((budget.used / budget.budget) * 100)) : 100
          return h('div', { className: 'audit-budget', key: name },
            h('span', null, name),
            h('span', { className: 'bar' }, h('i', { className: budget.over ? 'over' : '', style: { width: `${pct}%` } })),
            h('span', { className: 'num' }, `${budget.used}/${budget.budget}${budget.over ? ' 超' : ''}`),
          )
        })
        const selectedIds = selected.selected ? selected.selected.contentIds : (selected.contentIds || [])
        const hintIds = selected.selected ? selected.selected.hintIds : (selected.hintIds || [])
        const newlyAddedIds = selected.selected && Array.isArray(selected.selected.newlyAddedIds) ? selected.selected.newlyAddedIds : []
        const omitted = Array.isArray(selected.omitted) ? selected.omitted : []
        const dedupIds = selected.dedup && Array.isArray(selected.dedup.ids) ? selected.dedup.ids : []
        const omitGroups = new Map()
        for (const item of omitted) {
          const reason = item.reason || 'other'
          if (!omitGroups.has(reason)) omitGroups.set(reason, [])
          omitGroups.get(reason).push(item)
        }
        const sameIdSet = (a, b) => a.length === b.length && a.every((id) => b.includes(id))
        const idGroup = (label, ids, tone, empty = '无', titleOf = undefined) => h('div', { className: 'audit-id-group' },
          h('div', { className: 'audit-id-group-title' }, h('span', null, label), h('b', null, String(ids.length))),
          ids.length > 0
            ? h('div', { className: 'audit-flat' }, ids.map((id) => idChip(id, tone, titleOf ? titleOf(id) : undefined)))
            : h('span', { className: 'audit-id-sub' }, empty),
        )
        const kv = (label, value) => (value === undefined || value === null || value === '')
          ? null
          : [h('span', { className: 'k', key: `k-${label}` }, label), h('span', { className: 'v', key: `v-${label}` }, String(value))]
        const sessionNode = selected.sessionId
          ? [h('span', { className: 'k', key: 'k-session' }, '会话'),
             h('span', { className: 'v', key: 'v-session' }, h('button', {
               className: 'audit-id',
               'aria-label': selected.sessionId,
               onMouseEnter: (event) => showSessionTip(selected.sessionId, event.currentTarget),
               onMouseLeave: scheduleHideTip,
               onClick: () => openSessionId(selected.sessionId),
             }, selected.sessionId))]
          : null
        const directCall = auditEntryCallId(selected)
        const hasStep = typeof selected.turn === 'number' || typeof selected.step === 'number'
        const jumpTarget = directCall !== undefined
          ? `callId ${directCall}`
          : hasStep ? `第 ${selected.turn ?? '?'} 轮 / 第 ${selected.step ?? '?'} 步（按步查找）` : undefined
        const onJump = async () => {
          if (!selected.sessionId) return
          setFocusBusy(true)
          setFocusNotice('')
          try {
            const focus = await resolveAuditFocus(selected)
            if (typeof openTrajectory === 'function') {
              const result = await openTrajectory(focus, selected)
              if (result && result.focused === true) setFocusNotice('已定位到轨迹')
              else if (result && result.opened === true) setFocusNotice('已切到轨迹页（未找到精确锚点）')
              else if (result === undefined) setFocusNotice(focus === undefined ? '已切到轨迹页（这条没有精确锚点）' : '已定位到轨迹')
              else setFocusNotice('定位失败')
              return
            }
            const result = await jumpAuditEntryToTrajectory(selected)
            setFocusNotice(result.focused ? '已定位到轨迹' : result.opened ? '已切到轨迹页（未找到精确锚点）' : '打开轨迹失败')
          } catch {
            setFocusNotice('定位失败')
          } finally {
            setFocusBusy(false)
          }
        }
        const json = JSON.stringify(selected, null, 2)
        return h('div', { className: 'audit-detail' },
          h('div', { className: 'audit-detail-head' },
            h('b', null, auditSummaryLine(selected)),
            h('span', { className: 'spacer' }),
            selected.sessionId
              ? h('button', {
                  className: 'audit-jump',
                  disabled: focusBusy,
                  title: jumpTarget === undefined ? '切到该会话的轨迹页（本条没有 callId/turn/step 锚点）' : `在轨迹中定位：${jumpTarget}`,
                  onClick: onJump,
                }, focusBusy ? '定位中…' : '在轨迹中定位')
              : null,
            h('button', { className: 'linkbtn', onClick: () => copyAuditText(selected.id, setCopyNotice) }, '复制 ID'),
            copyNotice ? h('span', { className: 'audit-inline-note' }, copyNotice) : null,
            h('button', { className: 'audit-close', title: '关闭', onClick: () => { setSelectedId(null); setCopyNotice('') } }, '×'),
          ),
          focusNotice ? h('div', { className: 'audit-jump-note' }, focusNotice) : null,
          h('div', { className: 'audit-kv' },
            kv('事件', selected.id),
            kv('序号', selected.seq),
            kv('时间', fmtTime(selected.at)),
            kv('schema', selected.schemaVersion || '旧版'),
            sessionNode,
            kv('step', selected.step),
            kv('轨迹锚点', jumpTarget),
            kv('通道', `${auditChannelLabel(selected.channel)} / ${selected.kind}`),
            kv('阶段', selected.stage),
            kv('触发', selected.trigger),
            kv('phase', selected.phase),
            kv('原因', selected.reasonCode),
            kv('作用域', (selected.scopes || []).join(' → ')),
          ),
          selected.query ? h('div', { className: 'audit-sec' },
            h('div', { className: 'audit-sec-title' }, '查询（已脱敏）'),
            h('div', null, selected.query.text || '（文本已脱敏/为空）'),
            h('div', { className: 'muted' }, `${selected.query.chars} 字符${selected.query.redacted ? ' · 命中凭据脱敏' : ''}${selected.query.hash ? ` · ${selected.query.hash}` : ''}`),
          ) : null,
          selected.filter ? h('div', { className: 'audit-sec' },
            h('div', { className: 'audit-sec-title' }, '检索与过滤'),
            h('div', { className: 'audit-kv' },
              kv('原始命中', selected.filter.rawHits),
              kv('标签过滤', selected.filter.tagFiltered),
              kv('退役排除', selected.filter.supersededExcluded),
              kv('最终候选', selected.filter.candidates),
            ),
          ) : null,
          h('div', { className: 'audit-sec' },
            h('div', { className: 'audit-sec-title' }, '选择与省略'),
            h('div', { className: 'audit-kv' },
              kv('候选', selected.candidates),
              kv('选中', selectedIds.length),
              kv('新增', selected.selected && selected.selected.newlyAddedIds ? selected.selected.newlyAddedIds.length : '—'),
              kv('hint', hintIds.length),
              kv('省略', omitted.length),
              kv('去重跳过', selected.dedup ? selected.dedup.skipped : '—'),
            ),
            h('div', { className: 'audit-id-sub' }, '候选中的可枚举 ID = 选中 + 省略；标签过滤 / 退役排除只在上方计数里。'),
            idGroup(selected.channel === 'rules' ? '选中规则' : '选中正文', selectedIds, '', '没有选中 ID'),
            newlyAddedIds.length > 0 && !sameIdSet(newlyAddedIds, selectedIds)
              ? idGroup('本次新增到消息', newlyAddedIds, '', '无')
              : null,
            hintIds.length > 0 ? idGroup('标签索引（只给 ID，未注入正文）', hintIds, '', '无') : null,
            ...Array.from(omitGroups.entries()).map(([reason, items]) => idGroup(
              `省略 · ${AUDIT_OMIT_LABEL[reason] || reason}`,
              items.map((item) => item.id),
              'omit',
              '无',
              (id) => {
                const item = items.find((entry) => entry.id === id)
                return `${id}${item && item.tags && item.tags.length > 0 ? ` · ${item.tags.join(', ')}` : ''}`
              },
            )),
            dedupIds.length > 0 ? idGroup('去重跳过', dedupIds, 'dedup', '无') : null,
            selectedIds.length + hintIds.length + omitted.length + dedupIds.length === 0
              ? h('div', { className: 'audit-id-sub' }, '这条事件没有可枚举的记忆 ID。')
              : null,
          ),
          budgetRows.length > 0 ? h('div', { className: 'audit-sec' },
            h('div', { className: 'audit-sec-title' }, '预算'),
            ...budgetRows,
          ) : null,
          selected.delivery ? h('div', { className: 'audit-sec' },
            h('div', { className: 'audit-sec-title' }, '投递'),
            h('div', { className: 'audit-kv' },
              kv('状态', delivery.label + delivery.detail),
              kv('appended', selected.delivery.appended === null ? '未知' : String(selected.delivery.appended)),
              kv('抑制原因', selected.delivery.suppressedBy),
              kv('字符数', selected.delivery.textChars),
              kv('内容 hash', selected.delivery.textHash),
            ),
          ) : null,
          selected.error ? h('div', { className: 'audit-sec' },
            h('div', { className: 'audit-sec-title' }, '失败'),
            h('div', null, `${selected.error.stage} / ${selected.error.code}`),
            h('div', { className: 'muted' }, '审计只保留稳定错误码，不包含堆栈或异常原文。'),
          ) : null,
          selected.signal ? h('div', { className: 'audit-sec' },
            h('div', { className: 'audit-sec-title' }, '信号'),
            h('div', { className: 'audit-kv' },
              kv('key', selected.signal.key),
              kv('reason', selected.signal.reason),
              kv('tool', selected.signal.tool),
              kv('tag', selected.signal.tag),
              kv('errorClass', selected.signal.errorClass),
              kv('source', selected.signal.source),
            ),
          ) : null,
          h('details', { className: 'audit-sec' },
            h('summary', { className: 'audit-sec-title' }, '原始结构化事件'),
            h('pre', { className: 'audit-json' }, json),
            h('div', { className: 'row' }, h('button', { className: 'linkbtn', onClick: () => copyAuditText(json, setCopyNotice) }, '复制 JSON'), copyNotice ? h('span', { className: 'audit-inline-note' }, copyNotice) : null),
          ),
        )
      })() : null

      const listHeader = h('div', { className: 'audit-table-head' },
        h('span', null, '时间'),
        h('span', null, '通道 / 事件'),
        h('span', null, '触发 / 阶段'),
        h('span', null, '候选 / 选中 / 省略'),
        h('span', null, '预算'),
        h('span', null, '投递'),
        h('span', null, '结果'),
      )
      const listBody = loading
        ? h('div', { className: 'audit-empty' }, '加载审计事件…')
        : entries.length === 0
          ? h('div', { className: 'audit-empty' },
              error ? '加载失败。' : '当前筛选没有审计事件。',
              error ? null : h('div', { className: 'muted' }, '开始一轮任务后，这里会出现注入评估与投递记录。'),
              error ? h('div', { className: 'err' }, error) : null,
              error ? h('div', null, h('button', { onClick: () => setReloadTick((n) => n + 1) }, '重试')) : null,
            )
          : h('div', { className: 'audit-list' }, listHeader, entries.map(row))
      const listArea = h('div', { className: 'audit-list-wrap' }, listBody)

      const tipNode = tip === null ? null : (() => {
        if (tip.type === 'session') {
          const summary = tip.summary || {}
          const title = summary.title || summary.name || sessionShortId(tip.id)
          return h('div', { className: 'audit-tip', style: { left: tip.x, top: tip.y }, onMouseEnter: cancelHideTip, onMouseLeave: hideTip, onClick: () => openSessionId(tip.id) },
            h('div', { className: 'audit-tip-head' }, h('span', null, '会话'), h('span', { className: 'audit-tip-title' }, title)),
            h('div', { className: 'audit-tip-meta' },
              auditPill(`${sessionShortId(tip.id)}…`, 'mute'),
              summary.running === true ? auditPill('运行中', 'ok') : null,
              summary.archived === true ? auditPill('已归档', 'warn') : null,
            ),
            summary.cwd ? h('div', { className: 'audit-tip-content' }, summary.cwd) : null,
            h('div', { className: 'audit-tip-content' }, `ID ${tip.id}`),
            summary.updatedAt ? h('div', { className: 'audit-tip-foot' }, `更新于 ${fmtTime(summary.updatedAt)}`) : null,
            h('div', { className: 'audit-tip-foot' }, '点击打开会话'),
          )
        }
        const record = tip.record
        return h('div', { className: 'audit-tip', style: { left: tip.x, top: tip.y }, onMouseEnter: cancelHideTip, onMouseLeave: hideTip, onClick: () => openMemoryId(tip.id) },
          h('div', { className: 'audit-tip-head' }, h('span', null, '记忆'), h('span', { className: 'audit-tip-title' }, record ? record.id : tip.id)),
          record
            ? h('div', null,
                h('div', { className: 'audit-tip-meta' },
                  auditPill(record.kind, 'mute'),
                  auditPill(record.scope, 'mute'),
                  auditPill(`重要度 ${Number(record.importance ?? 0).toFixed(2)}`, 'mute'),
                ),
                record.tags && record.tags.length > 0
                  ? h('div', { className: 'audit-flat' }, record.tags.map((tag) => h('span', { className: 'tag', key: tag }, tag)))
                  : null,
                h('div', { className: 'audit-tip-content' }, String(record.content || '')),
              )
            : h('div', { className: 'audit-tip-content' }, tip.loading ? '加载记录…' : '记录未找到（可能已删除或不在已加载作用域）'),
          h('div', { className: 'audit-tip-foot' }, '点击跳转到「记录」页并展开'),
        )
      })()


      return h('div', { className: 'audit' },
        ...banner,
        h('div', { className: 'audit-stats' },
          h('div', { className: 'audit-stat' }, h('b', null, String(total)), h('span', null, '筛选内事件')),
          h('div', { className: 'audit-stat' }, h('b', null, String(prepared)), h('span', null, '本页已准备（投递未确认）')),
          h('div', { className: 'audit-stat' }, h('b', null, String(suppressed)), h('span', null, '本页被抑制/未尝试')),
          h('div', { className: 'audit-stat' }, h('b', null, String(failed)), h('span', null, '本页失败')),
          h('div', { className: 'audit-stat' }, h('b', null, dropped > 0 ? String(dropped) : '0'), h('span', null, capacity === null ? '已丢弃' : `已丢弃 / 容量 ${capacity}`)),
        ),
        toolbar,
        error && entries.length > 0 ? h('div', { className: 'err' }, error) : null,
        h('div', { className: 'audit-split' + (selected ? ' has-detail' : '') },
          listArea,
          detail,
        ),
        h('div', { className: 'audit-pager' },
          h('button', { disabled: loading || cursorStack.length === 0, onClick: () => {
            const stack = cursorStack.slice()
            const prev = stack.pop() || ''
            setCursorStack(stack)
            load(prev, stack)
          } }, '上一页'),
          h('span', null, `${total} 条${nextCursor ? '' : ' · 已到末页'}`),
          h('button', { disabled: loading || !nextCursor, onClick: () => {
            const stack = cursorStack.concat(cursor || '')
            setCursorStack(stack)
            load(nextCursor, stack)
          } }, '下一页'),
        ),
        tipNode,
      )
    }

    /** 待嵌入自动刷新:最多 300 次 × 1.5s(后端挂着时不无限轮询)。 */
    const PENDING_POLL_LIMIT = 300

    function MemoryPanel({ openSession, sessionInfo, audience = 'panel', lockSession } = {}) {
      const [records, setRecords] = React.useState([])
      const [scopes, setScopes] = React.useState([])
      const [embedServer, setEmbedServer] = React.useState(null)
      const [embedBusy, setEmbedBusy] = React.useState(false)
      const [embedNotice, setEmbedNotice] = React.useState('')
      const [installRequested, setInstallRequested] = React.useState(false)
      const [dangerAsk, setDangerAsk] = React.useState('')
      const [scopeFilter, setScopeFilter] = React.useState('')
      // 0.23.0:记录页「是否被修正」筛选。默认隐藏已被 supersede 的旧记录,
      // 但历史仍可切到「显示全部 / 只看已修正」查看。
      const [supersededFilter, setSupersededFilter] = React.useState('hide')
      const [q, setQ] = React.useState('')
      // 语义检索:默认关(记录页原本是"关键词过滤");开启后搜索走 /search,
      // 由 provider 用向量 + 词法同一套排序,列表按相关度排。
      const [semantic, setSemantic] = React.useState(false)
      const [searchInfo, setSearchInfo] = React.useState(null)
      const [focusRecord, setFocusRecord] = React.useState(null)
      const [focusRecordData, setFocusRecordData] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [error, setError] = React.useState('')
      const [tab, setTab] = React.useState('data')
      // 「记录」页里的二级标签页(0.28.0)：记忆(列表) / 作用域(名称 + 用途 + 条数)。
      // 两个视图共用 /status 的那次拉取，切换不重新请求。
      const [dataView, setDataView] = React.useState('memories')
      const [scopeQuery, setScopeQuery] = React.useState('')
      // 作用域编辑（0.29.0）：同一时间只编辑一行 —— 描述 / 别名都是全局共享的元数据，
      // 同时开多个编辑框只会让人不确定保存的是哪一条。
      const [editingScope, setEditingScope] = React.useState('')
      const [scopeDraftDescription, setScopeDraftDescription] = React.useState('')
      const [scopeDraftName, setScopeDraftName] = React.useState('')
      const [scopeBusy, setScopeBusy] = React.useState(false)
      const [scopeError, setScopeError] = React.useState('')
      const [scopeSaved, setScopeSaved] = React.useState('')
      const [pendingTick, setPendingTick] = React.useState(0)
      const [creating, setCreating] = React.useState(false)

      // 从轨迹/会话头部带进来的焦点：面板可能正停在「记录」页，先切到「审计」，
      // 具体的 session/entry 过滤由 AuditTab 挂载时消费。
      React.useEffect(() => {
        const sync = () => { if (peekAuditFocus(audience) !== null) setTab('audit') }
        sync()
        try {
          if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener(AUDIT_FOCUS_EVENT, sync)
        } catch { /* 无事件环境 */ }
        return () => {
          try {
            if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') window.removeEventListener(AUDIT_FOCUS_EVENT, sync)
          } catch { /* cleanup 失败不影响面板 */ }
        }
      }, [audience])

      const load = async (query, scopeF, semanticF) => {
        setLoading(true); setError('')
        try {
          const params = new URLSearchParams()
          const qq = query !== undefined ? query : q
          const ss = scopeF !== undefined ? scopeF : scopeFilter
          const sem = semanticF !== undefined ? semanticF : semantic
          // 空查询在语义模式下没有意义(embedding 空串),直接列全部记录。
          const semanticSearch = sem && qq.trim() !== ''
          if (ss) params.set('scope', ss)
          if (qq.trim()) params.set('q', qq.trim())
          const suffix = params.toString() ? `?${params}` : ''
          const [listVal, status] = await Promise.all([
            api(`${semanticSearch ? 'search' : 'records'}${suffix}`),
            api('status'),
          ])
          setRecords(semanticSearch ? listVal.hits : listVal.records)
          setSearchInfo(semanticSearch
            ? {
                mode: listVal.mode === 'vector' ? 'vector' : 'lexical',
                reason: listVal.reason,
                embedded: Number(listVal.embedded) || 0,
                total: Number(listVal.total) || 0,
                query: qq.trim(),
              }
            : null)
          setScopes(status.scopes)
          setEmbedServer(status.embedServer ?? null)
        } catch (e) {
          setError(String(e.message || e))
        }
        setLoading(false)
      }
      React.useEffect(() => { load('', '') }, [])

      /** 审计里的记忆 ID → 切到「记录」页并展开对应记录。 */
      const openRecord = (id, scope, record = null) => {
        setFocusRecord(id)
        // 目标记录可能不在当前筛选结果里（作用域/搜索/分页），先把它拿在手上，
        // 列表里没有时补一张卡，保证跳过去一定能展开。
        setFocusRecordData(record && record.id ? record : null)
        setTab('data')
        // 「记录」页现在是 记忆 / 作用域 两个子标签页：跳转必须落在记忆列表上。
        setDataView('memories')
        setQ('')
        // 语义模式是按查询排名的:跳转要看到那条记录,必须回到普通列表。
        setSemantic(false)
        setSearchInfo(null)
        const nextScope = scope || ''
        setScopeFilter(nextScope)
        load('', nextScope, false)
      }
      /** 作用域行的「查看记忆」：切回记忆子标签页并只看这个作用域。 */
      const openScopeRecords = (scope) => {
        setDataView('memories')
        setScopeFilter(scope)
        setQ('')
        setSupersededFilter('hide')
        setSemantic(false)
        setSearchInfo(null)
        load('', scope, false)
      }
      /**
       * 编辑作用域的描述 / 别名(0.29.0)。
       *
       * 用途只预填**自己写的**那句：`descriptionSource==='default'` 是按类型补的默认
       * 描述，预填进去再保存等于把默认文案固化成手写内容。
       * 别名字段对 global / session 不显示 —— provider 也不接受（显示名跟随类型/会话 id）。
       */
      const beginScopeEdit = (row) => {
        setEditingScope(row.scope)
        setScopeDraftDescription(row.descriptionSource === 'custom' ? row.description : '')
        setScopeDraftName(row.name === undefined ? '' : row.name)
        setScopeError('')
        setScopeSaved('')
      }
      const cancelScopeEdit = () => {
        setEditingScope('')
        setScopeError('')
      }
      const saveScopeEdit = async (row) => {
        setScopeBusy(true); setScopeError(''); setScopeSaved('')
        try {
          await api('scope-meta', {
            scope: row.scope,
            description: scopeDraftDescription.trim(),
            ...(row.canAlias ? { name: scopeDraftName.trim() } : {}),
          })
          setEditingScope('')
          setScopeSaved(row.scope)
          // 重新拉 /status：用途、别名与展示名都由服务端算（别名影响 label 与下拉）。
          await load()
        } catch (e) {
          setScopeError(String(e.message || e))
        } finally {
          setScopeBusy(false)
        }
      }
      // 审批浮层 / 其它入口点击记忆 ID:挂载时消费一次 pending,之后靠同一事件。
      React.useEffect(() => {
        const applyFocus = () => {
          const target = takeRecordFocus()
          if (!target || typeof target.id !== 'string' || target.id === '') return
          openRecord(target.id, target.scope, target.record || null)
        }
        applyFocus()
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        window.addEventListener(RECORD_FOCUS_EVENT, applyFocus)
        return () => window.removeEventListener(RECORD_FOCUS_EVENT, applyFocus)
      }, [])
      // 导入完成后从设置页切换回记录页时,列表要能看到新数据(事件由设置页发出)。
      React.useEffect(() => {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        const onRefresh = () => { load('', '') }
        window.addEventListener('dsh-memory:refresh', onRefresh)
        return () => window.removeEventListener('dsh-memory:refresh', onRefresh)
      }, [])

      const embedAction = async (action, body = {}) => {
        setEmbedBusy(true); setEmbedNotice('')
        try {
          const value = await api(`embed/${action}`, body)
          // 安装接口返回的是 { install, ...status }：先落状态，进度由轮询刷新
          setEmbedServer(value.embedServer ? { ...value.embedServer } : value)
          if (action === 'install') {
            // 不弹任何"下载开始"提示:进度本身就是反馈,装好会自动变成运行中。
            setInstallRequested(true)
          } else if (action === 'install/cancel') {
            setInstallRequested(false)
            setEmbedNotice('已请求取消下载')
          } else if (action === 'start') {
            setEmbedNotice(value.state === 'disabled'
              ? '未配置自启(spawn.enabled),无法启动'
              : value.reachable ? `已启动(pid ${value.pid ?? '?'})` : '已请求启动,但健康检查未通过,请看 llama-server.log')
          } else {
            setEmbedNotice(value.stopped
              ? '已停止'
              : value.reason === 'EXTERNAL_INSTANCE'
                ? '这是应用外部启动的实例,不受本应用管理,未关闭'
                : '当前没有由本应用管理的进程')
          }
        } catch (e) {
          setEmbedNotice(`操作失败: ${String(e.message || e)}`)
        }
        setEmbedBusy(false)
      }

      /**
       * 维护动作：卸载向量服务 / 清空记忆数据 / 重建全部向量。前两者不可撤销，重建代价高，
       * 都走两步确认（dangerAsk 记住当前等确认的那一项，第二次点击才真的发请求）。
       */
      const maintenanceAction = async (which) => {
        if (dangerAsk !== which) { setDangerAsk(which); setEmbedNotice(''); return }
        setDangerAsk('')
        setEmbedBusy(true); setEmbedNotice('')
        try {
          const value = which === 'uninstall'
            ? await api('embed/uninstall', {})
            : which === 'reindex'
              ? await api('embed/reindex', {})
              // 服务端要求显式 confirm:"delete"，避免任何一次误触就清库
              : await api('data/wipe', { confirm: 'delete' })
          setEmbedServer(value.embedServer ? { ...value.embedServer } : value)
          if (which === 'uninstall') {
            setEmbedNotice(value.removed
              ? `已卸载向量服务，释放约 ${((value.freedBytes ?? 0) / 1048576).toFixed(1)} MB。向量检索已关闭，词法检索照常。`
              : value.reason === 'EXTERNAL_BACKEND'
                ? '当前后端不在本插件管理的目录里（是你自己装的），没有删除任何东西。'
                : '没有找到本插件安装的向量服务文件。')
          } else if (which === 'reindex') {
            setPendingTick(0)
            setEmbedNotice(`已开始重建 ${value.records ?? 0} 条的向量；「待嵌入向量」会逐步下降，期间检索暂时只用词法。`)
          } else {
            setEmbedNotice(`已清空 ${value.removed ?? 0} 条记忆（${(value.scopes ?? []).length} 个作用域）。`)
          }
          await load('', '')
        } catch (e) {
          setEmbedNotice(`操作失败: ${String(e.message || e)}`)
        }
        setEmbedBusy(false)
      }

      // 安装状态要在 effect 之前算出来：依赖数组在渲染期取值，晚于它的 const 会踩 TDZ。
      const install = (embedServer && embedServer.install) || null
      const maintenance = (embedServer && embedServer.maintenance) || null
      const usageMb = maintenance ? (maintenance.usageBytes / 1048576).toFixed(1) : '0.0'
      const installPhase = install && install.phase ? install.phase : 'idle'
      const installRunning = installPhase !== 'idle' && installPhase !== 'done' && installPhase !== 'error'
      const installBusy = installRunning
      const installed = Boolean(install && install.installed)
      // 点了按钮就一定要轮询：provider 的 start() 是 fire-and-forget，紧接着返回的那次
      // 状态可能还停在 idle，只看 phase 会让进度永远不刷新。
      const shouldPoll = shouldPollInstall(installPhase, installRequested)
      React.useEffect(() => {
        if (!shouldPoll) return undefined
        const timer = setInterval(() => { load('', '') }, 1500)
        return () => clearInterval(timer)
      }, [shouldPoll])
      React.useEffect(() => {
        if (installRequested && (installPhase === 'done' || installPhase === 'error')) setInstallRequested(false)
      }, [installRequested, installPhase])

      const total = scopes.reduce((n, s) => n + s.records, 0)
      const pending = scopes.reduce((n, s) => n + s.pendingEmbeds, 0)
      // 有"待嵌入"时自动刷新:编辑后向量重建需要一两秒,列表与统计不能一直停在旧状态,
      // 等用户切标签/重进面板才知道好了。(有上限,后端挂着时不会无限轮询。)
      React.useEffect(() => {
        if (pending === 0 || pendingTick >= PENDING_POLL_LIMIT) return undefined
        if (!configured || !vectorEnabled) return undefined
        const timer = setTimeout(() => {
          setPendingTick((n) => n + 1)
          load()
        }, 1500)
        return () => clearTimeout(timer)
      }, [pendingTick, pending])
      // 服务端 /status 给的 scope → label 映射(会话标题、project 的 cwd 只有服务端知道)
      const labels = {}
      for (const s of scopes) if (s && s.scope && typeof s.label === 'string') labels[s.scope] = s.label

      // 向量卡片的状态判定。provider 给的 mode 决定"该不该有启停开关"：
      //   off      没配置任何后端 → 不给开关,模型与安装入口都在「模型与硬件」里
      //   external 只知道 endpoint（云端/用户自建）→ 开关无意义，我们不该假装拥有它
      //   managed  配置了 spawn（或刚自动装好）→ 我们托管子进程，给开关
      // 另外 enabled=false（配置里显式关掉）时也不能给一个"开了也没用"的开关。
      const mode = embedServer && embedServer.mode
        ? embedServer.mode
        : (embedServer && embedServer.baseUrl ? 'managed' : 'off')
      const vectorEnabled = embedServer ? Boolean(embedServer.enabled) : false
      const configured = Boolean(embedServer && (embedServer.configured !== undefined
        ? embedServer.configured
        : mode !== 'off'))
      const serverOn = Boolean(embedServer && embedServer.reachable)
      const managed = mode === 'managed'
      const canToggle = Boolean(embedServer) && managed && vectorEnabled
      const toggleTitle = !embedServer
        ? '当前 provider 未提供向量服务管理'
        : mode === 'external' ? '这是外部服务（云端或你自己跑的），不由本应用启停'
          : !vectorEnabled ? '向量检索已在配置里关闭'
            : serverOn ? '点击关闭向量服务' : '点击启动向量服务'

      const mb = (n) => (n / 1048576).toFixed(1)
      const installPercent = install && install.totalBytes ? Math.min(100, Math.round((install.receivedBytes / install.totalBytes) * 100)) : null

      const dotClass = serverOn ? 'dot on' : 'dot off'
      // 状态只说状态,归属由 pill 说 —— 之前两处各说一遍("运行中 · 由本应用管理" + "由本应用托管")。
      let stateText
      if (!embedServer) stateText = '不可用'
      else if (mode === 'off') stateText = installBusy ? '正在安装' : installed ? '检测到本地文件' : '未配置'
      else if (!vectorEnabled) stateText = '已在配置里关闭'
      else if (serverOn) stateText = '运行中'
      else stateText = managed ? '已停止' : '未连接'

      // 端点/pid/模型是排障信息,折成一行 mono;完整信息放 title,不占版面。
      const endpoint = embedServer ? String(embedServer.baseUrl || embedServer.endpoint || '') : ''
      const endpointLabel = (() => {
        if (!endpoint) return ''
        try { return new URL(endpoint).host } catch { return endpoint.replace(/^https?:\/\//, '').split('/')[0] }
      })()
      const endpointTitle = [endpoint, embedServer && embedServer.pid ? `pid ${embedServer.pid}` : '', embedServer && embedServer.model ? `模型 ${embedServer.model}` : ''].filter(Boolean).join(' · ')

      // 右侧动作区:安装进度 > 重试 > 启停开关。
      // 原则:只在"开关真能改变什么"时才渲染它——未配置、外部服务、配置里显式
      // 关闭,这三种情况给别的动作或干脆不给,避免一个永远灰着的开关。
      // 安装入口不放这里:模型在下面的「模型与硬件」里选,安装按钮跟着选择走。
      const actions = []
      if (installBusy) {
        actions.push(h('span', { className: 'muted', key: 'prog' },
          `${install.message || install.phase}${installPercent === null ? '' : ` ${installPercent}%`}`
          + (install.totalBytes ? `（${mb(install.receivedBytes)}/${mb(install.totalBytes)} MB）` : '')))
        actions.push(h('button', { key: 'cancel', disabled: embedBusy, onClick: () => embedAction('install/cancel') }, '取消'))
      } else if (install && install.phase === 'error') {
        actions.push(h('button', { key: 'retry', disabled: embedBusy, onClick: () => embedAction('install') }, '重试下载'))
      } else if (canToggle) {
        actions.push(h('button', {
          key: 'toggle',
          className: serverOn ? 'toggle on' : 'toggle',
          role: 'switch',
          'aria-checked': serverOn,
          disabled: embedBusy,
          title: toggleTitle,
          onClick: () => embedAction(serverOn ? 'stop' : 'start'),
        },
          h('span', { className: 'toggle-track' }, h('span', { className: 'toggle-knob' })),
          h('span', null, embedBusy ? '处理中…' : serverOn ? '已开启' : '已关闭'),
        ))
      }

      // 错误说明只在这里出现一次(重试按钮在右上方);配置里关掉了向量检索时解释一句。
      let notice = null
      if (mode !== 'off' && !vectorEnabled) {
        notice = h('div', { className: 'hint' }, '配置里关掉了向量检索（', h('code', null, 'retrieval.vector.enabled'), ' 改回 true 并重启即可）。')
      } else if (install && install.phase === 'error') {
        notice = h('div', { className: 'hint err' }, `安装失败：${install.error || install.message}`)
      }

      const filtering = q.trim() !== '' || scopeFilter !== '' || supersededFilter !== 'hide'

      // 三个标签的内容分开构建:记录(概览) / 数据(列表) / 设置。
      const statsCard = h('div', { className: 'stats' },
        h('div', { className: 'stat' }, h('b', null, String(total)), h('span', null, '条记忆')),
        h('div', { className: 'stat' }, h('b', null, String(scopes.length)), h('span', null, '个作用域')),
        configured && vectorEnabled
          ? h('div', { className: 'stat' }, h('b', null, String(pending)), h('span', null, '待嵌入向量'))
          : h('div', { className: 'stat' }, h('b', null, '—'), h('span', null, '向量未启用')),
      )
      const serverCard = h('div', { className: 'server' },
        h('div', { className: 'server-head' },
          h('span', { className: dotClass }),
          h('b', null, '向量服务'),
          h('span', { className: 'muted' }, stateText),
          // 地址紧跟在状态右边(排障要看的就是它),完整信息(pid/模型)进 title。
          endpointLabel ? h('span', { className: 'mono', title: endpointTitle }, endpointLabel) : null,
          configured && vectorEnabled ? h('span', { className: 'pill' }, managed ? '由本应用托管' : '外部服务') : null,
          h('span', { className: 'server-spacer' }),
          actions,
        ),
        notice,
        embedNotice ? h('div', { className: 'muted' }, embedNotice) : null,
        h(ModelPicker, {
          busy: embedBusy,
          // 下载是后台跑的,`busy`(一次请求)早就结束了;要单独把"正在下载"传给按钮,
          // 否则下载中还能反复点「下载并安装」。
          installing: installBusy || installRequested,
          installedBackend: installed,
          current: embedServer
            ? { presetId: embedServer.presetId, variantId: embedServer.variantId, model: embedServer.model, modelLabel: embedServer.modelLabel, dims: embedServer.dims, pooling: embedServer.pooling, flavor: embedServer.flavor }
            : null,
          onInstall: (override) => embedAction('install', override),
        }),
      )
      // 重建向量只在"配置了后端且启用"时有意义(maintenanceCard 在 configured 声明之前构建)。
      const canReindex = Boolean(embedServer && embedServer.enabled && (embedServer.configured === undefined ? Boolean(embedServer.baseUrl) : embedServer.configured))
      // 维护区：DSH 卸载插件时不会给插件任何提问机会（就是 pnpm remove + 去掉
      // bundles），所以"要不要留向量服务 / 要不要留记忆数据"只能在这里、卸载之前问。
      const maintenanceCard = maintenance
        ? h('div', { className: 'maint' },
          h('div', { className: 'maint-row' },
            h('b', null, '维护'),
            h('span', { className: 'muted' }, '卸载插件不会移除已配置的向量服务与记忆文件'),
          ),
          h('div', { className: 'maint-row' },
            h('span', { className: 'grow' }, `向量服务：${usageMb} MB`),
            maintenance.usageBytes > 0
              ? (dangerAsk === 'uninstall'
                ? [h('button', { key: 'ok', className: 'danger', disabled: embedBusy, onClick: () => maintenanceAction('uninstall') }, `确认卸载（释放 ${usageMb} MB）`),
                   h('button', { key: 'no', disabled: embedBusy, onClick: () => setDangerAsk('') }, '取消')]
                : h('button', { key: 'ask', disabled: embedBusy, onClick: () => maintenanceAction('uninstall') }, '卸载向量服务'))
              : h('span', { className: 'muted' }, '未安装'),
          ),
          h('div', { className: 'maint-row' },
            h('span', { className: 'grow' }, `向量索引：${maintenance.records} 条`),
            canReindex
              ? (maintenance.records > 0
                ? (dangerAsk === 'reindex'
                  ? [h('button', { key: 'ok', className: 'danger', disabled: embedBusy, onClick: () => maintenanceAction('reindex') }, `确认重建 ${maintenance.records} 条的向量`),
                     h('button', { key: 'no', disabled: embedBusy, onClick: () => setDangerAsk('') }, '取消')]
                  : h('button', { key: 'ask', disabled: embedBusy, onClick: () => maintenanceAction('reindex') }, '重建全部向量'))
                : h('span', { className: 'muted' }, '无'))
              : h('span', { className: 'muted' }, '向量未启用'),
          ),
          h('div', { className: 'maint-row' },
            h('span', { className: 'grow' }, `记忆数据：${maintenance.records} 条`),
            maintenance.storeDir ? h('span', { className: 'muted path', title: maintenance.storeDir }, maintenance.storeDir) : null,
            maintenance.records > 0
              ? (dangerAsk === 'wipe'
                ? [h('button', { key: 'ok', className: 'danger', disabled: embedBusy, onClick: () => maintenanceAction('wipe') }, `确认清空 ${maintenance.records} 条（不可恢复）`),
                   h('button', { key: 'no', disabled: embedBusy, onClick: () => setDangerAsk('') }, '取消')]
                : h('button', { key: 'ask', disabled: embedBusy, onClick: () => maintenanceAction('wipe') }, '清空记忆数据'))
              : h('span', { className: 'muted' }, '无'),
          ),
        )
        : null

      const toolbar = h('div', { className: 'row toolbar' },
        h('input', {
          type: 'text',
          placeholder: semantic ? '描述你要找的记忆，回车语义检索' : '搜索内容、类型或标签',
          value: q,
          onChange: (e) => setQ(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter') load(q, scopeFilter) },
        }),
        // 语义检索开关:与「向量服务」同一套 toggle(轨道 + 圆点)。轨道/圆点/文字颜色
        // 全部走宿主 token,深色主题下关闭态轨道用 border-l3、圆点用 switch-thumb,
        // 开启态轨道用 brand-primary、圆点用 label-primary-foreground。
        h('button', {
          type: 'button',
          className: 'toggle semantic' + (semantic ? ' on' : ''),
          role: 'switch',
          'aria-checked': semantic,
          disabled: !(configured && vectorEnabled),
          title: configured && vectorEnabled
            ? (semantic ? '语义检索已开启：按语义相似度排序，点击切回关键词过滤' : '按语义相似度检索（向量 + 词法；未命中时结果会标注已回退）')
            : '需要先在「服务」页配置并启用向量检索',
          onClick: () => {
            const next = !semantic
            setSemantic(next)
            // 已经有查询词时立刻按新模式重跑一次,不用再敲回车。
            if (q.trim() !== '') load(q, scopeFilter, next)
          },
        },
          h('span', { className: 'toggle-track' }, h('span', { className: 'toggle-knob' })),
          h('span', { className: 'semantic-label' }, '语义检索'),
          h('span', { className: 'semantic-state' }, semantic ? '已开启' : '已关闭'),
        ),
        // 作用域也用同一个自绘下拉(与模型/运行时统一);标签优先用服务端给的 label
        h(Dropdown, {
          items: [
            { value: '', label: '全部作用域' },
            ...scopes.map((s) => ({ value: s.scope, label: s.label || scopeLabel(s.scope) })),
          ],
          value: scopeFilter,
          disabled: loading,
          onChange: (next) => { setScopeFilter(next); load(q, next) },
        }),
        // 0.23.0:是否被修正。默认隐藏旧版本;要看历史关系时切到另外两档。
        h(Dropdown, {
          items: [
            { value: 'hide', label: '隐藏已修正' },
            { value: 'all', label: '显示全部' },
            { value: 'only', label: '只看已修正' },
          ],
          value: supersededFilter,
          disabled: loading,
          title: '是否被修正：默认隐藏已被新版本取代的旧记录',
          onChange: setSupersededFilter,
        }),
        h('button', { onClick: () => setCreating((v) => !v), disabled: loading }, creating ? '收起' : '新建'),
        h('button', { onClick: () => load(q, scopeFilter), disabled: loading }, loading ? '刷新中…' : '刷新'),
        filtering ? h('button', { className: 'linkbtn', onClick: () => { setQ(''); setScopeFilter(''); setSupersededFilter('hide'); setSearchInfo(null); load('', '', semantic) } }, '清空筛选') : null,
      )
      // 语义检索结果的出处:真跑了向量,还是因为服务/向量缺失退回了词法 —— 明说,
      // 不把词法结果冒充成"语义找到的"。
      const fallbackReason = {
        'vector-disabled': '向量检索未启用',
        'no-vectors': '记录尚未嵌入向量',
        'no-records': '没有可检索的记录',
        'embed-failed': '向量服务没有响应',
        'provider-lexical': '当前 provider 不支持语义检索',
      }
      const searchNoteNode = searchInfo
        ? h('div', { className: 'search-note' },
            h('span', { className: 'pill' }, searchInfo.mode === 'vector' ? '语义排序' : '关键词回退'),
            h('b', null, `「${excerpt(searchInfo.query, 28)}」`),
            h('span', null, `命中 ${records.length} 条`),
            searchInfo.mode === 'vector'
              ? h('span', { className: 'muted' }, `向量覆盖 ${searchInfo.embedded}/${searchInfo.total} 条`)
              : h('span', { className: 'muted' }, searchInfo.reason === 'no-records'
                ? '该作用域没有记录'
                : `${fallbackReason[searchInfo.reason] || '向量不可用'}，本次按关键词排序`),
          )
        : semantic
          ? h('div', { className: 'search-note' },
              h('span', { className: 'muted' }, '输入一句话描述你要找的记忆，按回车开始语义检索。'))
          : null
      const createForm = creating
        ? h(CreateForm, {
            scopes,
            onCancel: () => setCreating(false),
            // 新建完成后回到普通列表:新记录不一定命中当前语义查询,留在搜索结果里会让人以为没保存。
            onCreated: () => {
              setCreating(false); setPendingTick(0)
              setQ(''); setSemantic(false); setSearchInfo(null)
              load('', '', false)
            },
          })
        : null
      const emptyText = searchInfo ? '没有语义相关的记忆' : filtering ? '没有匹配的记忆' : '还没有记忆'
      // 0.23.0:「是否被修正」筛选。默认隐藏已被 supersede 的旧记录,
      // 历史核对时可切到「显示全部 / 只看已修正」。
      const supersededRecords = supersededFilter === 'all'
        ? records
        : supersededFilter === 'only'
          ? records.filter((rec) => Boolean(rec.supersededBy))
          : records.filter((rec) => !rec.supersededBy)
      // 从审计跳过来的目标记录如果不在当前筛选结果里，先把它补到列表最前面，
      // 否则跳转后列表里根本没有这张卡，focus 自然也无法展开。
      const displayRecords = focusRecordData !== null && !supersededRecords.some((rec) => rec.id === focusRecordData.id)
        ? [focusRecordData, ...supersededRecords]
        : supersededRecords
      const listBody = !loading && !error && displayRecords.length === 0
        ? h('div', { className: 'empty' },
            emptyText,
            searchInfo ? h('div', { className: 'muted' }, '换个说法试试；刚写入的记录可能还没嵌入向量。') : null)
        : h('div', { className: 'list' },
            displayRecords.map((rec) => h(RecordCard, { key: rec.id, rec, score: rec.score, focus: focusRecord === rec.id, vectorOn: configured && vectorEnabled, labels: labels, onSaved: () => { setPendingTick(0); load() }, onDeleted: () => { setPendingTick(0); load() } })))

      // 服务页底部:一句号召 + 两个外链(Star / issue)。放在内容最后,不打扰上面的状态卡。
      const footer = h('div', { className: 'footer' },
        '觉得好用？',
        h('a', { href: 'https://github.com/RestRegular/dsh-memory', target: '_blank', rel: 'noreferrer' }, '⭐ 去 GitHub 点个 Star'),
        ' · ',
        h('a', { href: 'https://github.com/RestRegular/dsh-memory/issues/new', target: '_blank', rel: 'noreferrer' }, '💬 反馈建议 / 提 issue'),
      )
      const overviewBody = h('div', { className: 'memp-body' }, serverCard, maintenanceCard, footer)

      // ---- 「记录」页的二级标签页:记忆 / 作用域(0.28.0) ----
      // 作用域子标签页回答的是「有哪些域、各自干什么、多少条」——用途与
      // memory_scopes 目录、memory_search 的范围外清单同源(服务端 /status 已合并)。
      const scopeRows = (() => {
        const needle = scopeQuery.trim().toLowerCase()
        return scopes
          .map((s) => ({
            scope: s.scope,
            label: scopeLabel(s.scope, labels),
            description: typeof s.description === 'string' ? s.description.trim() : '',
            descriptionSource: s.descriptionSource === 'custom' ? 'custom' : (s.descriptionSource === 'default' ? 'default' : 'none'),
            name: typeof s.name === 'string' && s.name !== '' ? s.name : undefined,
            // global / session 的显示名跟随类型与会话 id，provider 也不接受别名。
            canAlias: !(String(s.scope) === 'global' || String(s.scope).startsWith('session:')),
            records: Number(s.records) || 0,
            pendingEmbeds: Number(s.pendingEmbeds) || 0,
            updatedAt: Number(s.updatedAt) || 0,
            // 0.30.0：会话归档后作用域保留但读写冻结；恢复会话自动复原。
            archived: s.archived === true,
          }))
          .filter((row) => needle === ''
            || row.label.toLowerCase().includes(needle)
            || row.scope.toLowerCase().includes(needle)
            || row.description.toLowerCase().includes(needle)
            || (row.name !== undefined && row.name.toLowerCase().includes(needle)))
          .sort((a, b) => b.records - a.records || b.updatedAt - a.updatedAt || a.label.localeCompare(b.label))
      })()
      const viewSwitch = h('div', { className: 'row' },
        h('div', { className: 'subtabs' },
          h('button', {
            className: 'subtab' + (dataView === 'memories' ? ' on' : ''),
            onClick: () => setDataView('memories'),
          }, '记忆'),
          h('button', {
            className: 'subtab' + (dataView === 'scopes' ? ' on' : ''),
            onClick: () => setDataView('scopes'),
          }, '作用域'),
        ),
      )
      const scopeToolbar = h('div', { className: 'row toolbar' },
        h('input', {
          type: 'text',
          placeholder: '搜索作用域名称 / 用途 / 键',
          value: scopeQuery,
          onChange: (e) => setScopeQuery(e.target.value),
        }),
        h('button', { onClick: () => load(), disabled: loading }, loading ? '刷新中…' : '刷新'),
        scopeQuery.trim() !== '' ? h('button', { className: 'linkbtn', onClick: () => setScopeQuery('') }, '清空筛选') : null,
      )
      const scopeListBody = !loading && !error && scopeRows.length === 0
        ? h('div', { className: 'empty' }, scopeQuery.trim() !== '' ? '没有匹配的作用域' : '还没有作用域')
        : h('div', { className: 'list' },
            scopeRows.map((row) => {
              const editing = editingScope === row.scope
              return h('div', { className: 'scope-row', key: row.scope },
                h('div', { className: 'scope-row-head' },
                  h('span', { className: 'scope-row-name', title: scopeTitle(row.scope, row.label) }, row.label),
                  h('span', { className: 'badge' }, `${row.records} 条记忆`),
                  row.archived
                    ? h('span', {
                        className: 'badge',
                        title: '所属会话已归档：作用域与记忆被冻结，取消归档后自动恢复读写',
                      }, '已归档')
                    : null,
                  row.pendingEmbeds > 0
                    ? h('span', { className: 'pending', title: '待嵌入向量：向量服务就绪后会自动补上' }, `待嵌入 ${row.pendingEmbeds}`)
                    : null,
                  scopeSaved === row.scope ? h('span', { className: 'meta-done' }, '已保存') : null,
                  h('span', {
                    className: 'time',
                    title: row.updatedAt > 0 ? `最近更新 ${fmtTime(row.updatedAt)}` : '还没有记录',
                  }, row.updatedAt > 0 ? fmtTime(row.updatedAt) : '—'),
                ),
                editing
                  ? h('div', { className: 'scope-edit' },
                      h('label', null, '用途'),
                      h('textarea', {
                        rows: 2,
                        value: scopeDraftDescription,
                        placeholder: '一句话说明这个作用域放什么；留空保存 = 清空，回退到按类型的默认描述',
                        onChange: (e) => setScopeDraftDescription(e.target.value),
                      }),
                      row.canAlias
                        ? h('label', null, '别名（可选）')
                        : h('div', { className: 'hint' }, 'global / session 作用域不支持别名：显示名跟随类型与会话 id。'),
                      row.canAlias
                        ? h('input', {
                            type: 'text',
                            value: scopeDraftName,
                            placeholder: '只影响显示与引用；留空保存 = 移除别名。不改作用域键本身。',
                            onChange: (e) => setScopeDraftName(e.target.value),
                          })
                        : null,
                      scopeError !== '' ? h('div', { className: 'err' }, scopeError) : null,
                      h('div', { className: 'scope-edit-actions' },
                        h('button', { disabled: scopeBusy, onClick: () => saveScopeEdit(row) }, scopeBusy ? '保存中…' : '保存'),
                        h('button', { disabled: scopeBusy, onClick: cancelScopeEdit }, '取消'),
                      ),
                    )
                  : h('div', { className: 'scope-row-desc' },
                      row.description === '' ? '（未填写用途）' : row.description,
                      row.descriptionSource === 'default' ? h('span', { className: 'muted' }, ' · 默认描述') : null,
                    ),
                editing
                  ? null
                  : h('div', { className: 'scope-row-foot' },
                      h('span', { className: 'scope-row-key', title: '作用域键：工具参数直接用它（自定义作用域传裸名）' }, row.scope),
                      h('span', { style: { flex: 1 } }),
                      row.records > 0
                        ? h('button', {
                            className: 'linkbtn',
                            title: '切到「记忆」并只看这个作用域',
                            onClick: () => openScopeRecords(row.scope),
                          }, '查看记忆')
                        : null,
                      h('button', {
                        className: 'linkbtn',
                        title: '编辑这个作用域的用途与别名（别名可选）',
                        onClick: () => beginScopeEdit(row),
                      }, '编辑'),
                    ),
              )
            }),
          )
      // 旧 provider 没有 scope-meta 用途：说明一句，而不是让人以为作用域都没有用途。
      const scopeDescriptionMissing = scopes.length > 0
        && scopes.every((s) => !(typeof s.description === 'string' && s.description.trim() !== ''))

      // 记录页:统计 + 工具栏 + 新建表单固定在上面,只有列表在滚动容器里 —— 记忆多了也不把面板撑长。
      const dataBody = h('div', { className: 'memp-body' },
        viewSwitch,
        statsCard,
        dataView === 'scopes' ? scopeToolbar : toolbar,
        dataView === 'scopes' ? null : searchNoteNode,
        dataView === 'scopes'
          ? (scopeDescriptionMissing
            ? h('div', { className: 'hint' }, '当前 provider 没有返回作用域用途（升级 @restregular/dsh-memory 后即可显示）。')
            : null)
          : createForm,
        error ? h('div', { className: 'err' }, error) : null,
        h('div', {
          className: 'scroll' + ((dataView === 'scopes' ? scopeRows.length > 0 : records.length > 0) || loading ? '' : ' is-empty'),
        }, dataView === 'scopes' ? scopeListBody : listBody),
      )
      // 记忆树是自己的过滤维度(客户端即时筛选),进来时先拉一份不带服务端筛选的全量记录,
      // 否则从「记录」页带着搜索词切过来会只剩一部分树。
      const treeBody = h(MemoryTreeTab, {
        records,
        scopes,
        loading,
        error,
        onRefresh: () => { setPendingTick(0); load('', '') },
      })

      return h('div', { className: 'memp' },
        h('div', { className: 'tabs' },
          h('button', { className: 'tab' + (tab === 'records' ? ' on' : ''), onClick: () => setTab('records') }, '服务'),
          h('button', { className: 'tab' + (tab === 'data' ? ' on' : ''), onClick: () => { if (tab !== 'data') load(); setTab('data') } }, '记录'),
          h('button', {
            className: 'tab' + (tab === 'tree' ? ' on' : ''),
            onClick: () => { if (tab !== 'tree') load('', ''); setTab('tree') },
          }, '记忆树'),
          h('button', { className: 'tab' + (tab === 'settings' ? ' on' : ''), onClick: () => setTab('settings') }, '设置'),
          h('button', { className: 'tab' + (tab === 'audit' ? ' on' : ''), onClick: () => setTab('audit') }, '审计'),
        ),
        tab === 'settings'
          ? h(SettingsTab, {})
          : tab === 'data'
            ? dataBody
            : tab === 'tree'
              ? treeBody
              : tab === 'audit'
                ? h(AuditTab, {
                    scopes,
                    records,
                    openRecord,
                    openSession,
                    sessionInfo,
                    audience,
                    lockSession,
                  })
                : overviewBody,
      )
    }

    /**
     * 会话内的「记忆审计」视图：和 Chat/Trajectory 同一个 view ring。
     *
     * 它拿到 owner 传下来的 `openView(view, focus)`，所以从这里跳轨迹是宿主
     * 官方支持的深链路径，不依赖任何内部字段。主面板（侧栏/设置）不在 view
     * ring 里，走 `conversationStoreFor` 的 bridge。
     */
    function MemoryAuditView({ sessionId, openView, sessionInfo }) {
      const openTrajectory = (focus) => {
        try {
          if (typeof openView === 'function') {
            openView('trajectory', focus)
            return { opened: true, focused: focus !== undefined }
          }
        } catch { /* 视图不可用时保持在本页 */ }
        return { opened: false, focused: false }
      }
      return h('div', {
        className: 'memp mem-view',
        // 让宿主把 composer 浮起来、把 viewArea 压成固定高度（与 Trajectory 同一机制），
        // 否则外层 scrollBody 会滚动，审计列表拿不到自己的滚动视口。
        'data-conversation-composer-overlay': '',
      },
        h('div', { className: 'mem-view-head' },
          h('b', null, '记忆审计'),
          h('span', { className: 'muted' }, '本会话的注入评估、投递与记忆工具调用；选中一条可在轨迹里精确定位。'),
          h('span', { className: 'spacer' }),
          h('button', {
            className: 'linkbtn',
            onClick: () => openMemoryAuditPanel({ sessionId }),
          }, '打开完整面板'),
        ),
        h('div', { className: 'mem-view-body' },
          h(AuditTab, {
            scopes: [],
            records: [],
            sessionInfo,
            lockSession: sessionId,
            audience: 'view',
            openTrajectory,
          }),
        ),
      )
    }

    /**
     * Trajectory 行上的记忆徽标。
     *
     * Trajectory 不提供行级 slot，选中状态也只存在于组件内部。这里用宿主已经
     * 渲染到 DOM 上的稳定属性（`data-selected` / `data-trajectory-row-key`：
     * `kind\0call\0<callId>`）做只读观察，再把一个 fixed 徽标浮在选中行右侧。
     * 它不插入表格、不改轨迹结构；选择器失配时什么都不显示。
     */
    function TrajectoryMemoryBadge() {
      const [badge, setBadge] = React.useState(null)
      const cache = React.useRef(new Map())
      React.useEffect(() => {
        let disposed = false
        let raf = 0
        const rafFn = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : ((fn) => setTimeout(fn, 16))
        const cancelFn = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : ((id) => clearTimeout(id))
        const schedule = () => {
          if (disposed || raf !== 0) return
          raf = rafFn(() => { raf = 0; tick() })
        }
        const tick = () => {
          try {
            if (typeof document === 'undefined' || typeof window === 'undefined') return
            const row = document.querySelector('tr[data-selected="true"][data-trajectory-row-key]')
            const callId = trajectoryRowCallId(row)
            const sessionId = currentSessionId()
            if (!row || callId === undefined || sessionId === undefined) {
              setBadge(null)
              return
            }
            const rect = row.getBoundingClientRect()
            const clip = trajectoryRowClip(row)
            if (clip !== null && (rect.top < clip.top - 0.5 || rect.bottom > clip.bottom + 0.5)) {
              setBadge(null)
              return
            }
            const position = {
              top: Math.max(4, rect.top + 4),
              left: Math.max(8, Math.min(window.innerWidth - 132, rect.right - 122)),
            }
            const key = `${sessionId}|${callId}`
            const cached = cache.current.get(key)
            const now = Date.now()
            if (cached && cached.pending === true) return
            if (cached && now - cached.at < 4000) {
              setBadge(cached.entries.length === 0 ? null : { ...position, sessionId, callId, entries: cached.entries })
              return
            }
            cache.current.set(key, { at: now, pending: true, entries: [] })
            api(`audit?session=${encodeURIComponent(sessionId)}&operation=${encodeURIComponent(callId)}&limit=20`)
              .then((value) => {
                const entries = value && Array.isArray(value.entries) ? value.entries : []
                cache.current.set(key, { at: Date.now(), pending: false, entries })
                if (!disposed) schedule()
              })
              .catch(() => {
                cache.current.set(key, { at: Date.now(), pending: false, entries: [] })
              })
          } catch { /* 观察失败：保持无徽标 */ }
        }
        let observer = null
        try {
          observer = new MutationObserver(schedule)
          observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['data-selected'],
          })
        } catch { observer = null }
        const onScroll = () => schedule()
        let onResize = onScroll
        try {
          window.addEventListener('scroll', onScroll, true)
          window.addEventListener('resize', onResize)
        } catch { /* 非浏览器环境 */ }
        schedule()
        return () => {
          disposed = true
          if (raf !== 0) cancelFn(raf)
          try { observer?.disconnect() } catch { /* 已断开 */ }
          try {
            window.removeEventListener('scroll', onScroll, true)
            window.removeEventListener('resize', onResize)
          } catch { /* 非浏览器环境 */ }
        }
      }, [])
      if (badge === null) return null
      return h('button', {
        className: 'mem-traj-chip',
        style: { top: badge.top, left: badge.left },
        title: '这次工具调用有记忆审计记录；点击在记忆面板里查看',
        onClick: () => {
          openMemoryAuditPanel({
            sessionId: badge.sessionId,
            callId: badge.callId,
            ...(badge.entries[0]?.id ? { entryId: badge.entries[0].id } : {}),
          })
          setBadge(null)
        },
      }, h('span', { className: 'dot' }), `记忆 ${badge.entries.length}`)
    }

    /** 轨迹行左侧的「产品线条图标」标记：有记忆审计的调用才显示。 */
    function TrajectoryMemoryMarks() {
      const [marks, setMarks] = React.useState([])
      const cacheRef = React.useRef(new Map())
      React.useEffect(() => {
        let disposed = false
        let raf = 0
        const rafFn = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : ((fn) => setTimeout(fn, 16))
        const cancelFn = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : ((id) => clearTimeout(id))
        const same = (a, b) => a.length === b.length && a.every((mark, index) => {
          const other = b[index]
          return other !== undefined
            && mark.callId === other.callId
            && Math.abs(mark.top - other.top) < 1
            && Math.abs(mark.left - other.left) < 1
            && mark.count === other.count
        })
        const tick = () => {
          try {
            if (disposed || typeof document === 'undefined' || typeof window === 'undefined') return
            const sessionId = currentSessionId()
            if (sessionId === undefined) { setMarks((prev) => prev.length === 0 ? prev : []); return }
            const rows = [...document.querySelectorAll('tr[data-trajectory-row-key]')]
            if (rows.length === 0) { setMarks((prev) => prev.length === 0 ? prev : []); return }
            const visible = new Map()
            for (const row of rows) {
              const callId = trajectoryRowCallId(row)
              if (callId === undefined) continue
              const rect = row.getBoundingClientRect()
              if (rect.bottom < 0 || rect.top > window.innerHeight || rect.height <= 0) continue
              // fixed 浮层不受表格 overflow 裁剪：行必须完整落在滚动容器（扣掉
              // sticky 表头）内，否则行滚到表头上方时图标会留在原地。
              const clip = trajectoryRowClip(row)
              if (clip !== null && (rect.top < clip.top - 0.5 || rect.bottom > clip.bottom + 0.5)) continue
              visible.set(callId, rect)
            }
            if (visible.size === 0) { setMarks((prev) => prev.length === 0 ? prev : []); return }
            const cached = cacheRef.current.get(sessionId)
            const now = Date.now()
            if (cached && cached.pending === true) return
            if (!cached || now - cached.at > 3000) {
              cacheRef.current.set(sessionId, { at: now, pending: true, byOp: new Map() })
              api(`audit?session=${encodeURIComponent(sessionId)}&limit=200`)
                .then((value) => {
                  const byOp = new Map()
                  const entries = value && Array.isArray(value.entries) ? value.entries : []
                  for (const entry of entries) {
                    const callId = auditEntryCallId(entry)
                    if (callId !== undefined) byOp.set(callId, (byOp.get(callId) ?? 0) + 1)
                  }
                  cacheRef.current.set(sessionId, { at: Date.now(), pending: false, byOp })
                  if (!disposed) schedule()
                })
                .catch(() => {
                  cacheRef.current.set(sessionId, { at: Date.now(), pending: false, byOp: new Map() })
                })
              if (!cached) return
            }
            const byOp = cached && cached.byOp instanceof Map ? cached.byOp : null
            if (byOp === null) return
            const next = []
            for (const [callId, rect] of visible) {
              const count = byOp.get(callId)
              if (count === undefined) continue
              next.push({
                callId,
                count,
                top: Math.max(2, rect.top + (rect.height - 16) / 2),
                left: Math.max(2, rect.left + 22),
                sessionId,
              })
            }
            setMarks((prev) => same(prev, next) ? prev : next)
          } catch { /* 观察失败：保持现状 */ }
        }
        const schedule = () => {
          if (disposed || raf !== 0) return
          raf = rafFn(() => { raf = 0; tick() })
        }
        let observer = null
        try {
          observer = new MutationObserver(schedule)
          observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-selected'] })
        } catch { observer = null }
        const onScroll = () => schedule()
        let timer = null
        try {
          window.addEventListener('scroll', onScroll, true)
          window.addEventListener('resize', onScroll)
          timer = setInterval(tick, 800)
        } catch { /* 非浏览器环境 */ }
        schedule()
        return () => {
          disposed = true
          if (raf !== 0) cancelFn(raf)
          if (timer !== null) clearInterval(timer)
          try { observer?.disconnect() } catch { /* 已断开 */ }
          try {
            window.removeEventListener('scroll', onScroll, true)
            window.removeEventListener('resize', onScroll)
          } catch { /* 非浏览器环境 */ }
        }
      }, [])
      if (marks.length === 0) return null
      return h(React.Fragment, null, marks.map((mark) => h('button', {
        key: `${mark.sessionId}:${mark.callId}`,
        className: 'mem-traj-mark',
        style: { top: mark.top, left: mark.left },
        title: `这次调用有 ${mark.count} 条记忆审计；点击在记忆面板里查看`,
        onClick: (event) => {
          try { event.stopPropagation() } catch { /* 忽略 */ }
          openMemoryAuditPanel({ sessionId: mark.sessionId, callId: mark.callId })
        },
      }, h('svg', { width: 12, height: 12, viewBox: NAV_VIEW_BOX, fill: 'none', 'aria-hidden': 'true' },
        h('rect', { ...NAV_FRAME, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 }),
        h('path', { d: NAV_RING, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      ))))
    }

    /**
     * 轨迹详情面板里的「记忆审计」页签。
     *
     * Trajectory 的详情页签是包内私有的 `detailTabs` 数组，没有给插件留 slot。
     * 这里不在 React 管理的 `<div data-slot>` 里插节点（会被重渲染清掉），而是：
     *   1. 给详情页签行加 `padding-right` 预留 96px；
     *   2. 在 `shell.overlay` 里用 fixed 定位渲染一个页签按钮，贴在保留区；
     *   3. 点开后用 fixed 覆盖详情正文区域，展示这条记录的审计；
     *   4. 页签/面板的位置随滚动、resize、详情切换重新测量。
     * 选择器全部用 CSS Modules 的稳定后缀（`_details` / `_detailTabs` / `_detailBody`），
     * 失配时什么都不显示，不影响轨迹本身。
     */
    function TrajectoryDetailAudit() {
      const [layout, setLayout] = React.useState({
        visible: false, tabTop: 0, tabLeft: 0, tabWidth: 88, paneTop: 0, paneLeft: 0, paneWidth: 0, paneHeight: 0,
      })
      const [open, setOpen] = React.useState(false)
      const [callId, setCallId] = React.useState(undefined)
      const [sessionId, setSessionId] = React.useState(undefined)
      const [entries, setEntries] = React.useState([])
      const [loading, setLoading] = React.useState(false)
      const [error, setError] = React.useState('')
      const layoutRef = React.useRef(layout)
      const openRef = React.useRef(false)
      const keyRef = React.useRef('')
      const cacheRef = React.useRef(new Map())
      const setOpenBoth = (value) => { openRef.current = value; setOpen(value) }

      const loadAudit = (sid, cid) => {
        const key = `${sid}|${cid}`
        const cached = cacheRef.current.get(key)
        if (cached && cached.pending === true) return
        if (cached && Date.now() - cached.at < 4000) {
          setEntries(cached.entries)
          setLoading(false)
          setError('')
          return
        }
        cacheRef.current.set(key, { at: Date.now(), pending: true, entries: [] })
        setLoading(true)
        setError('')
        api(`audit?session=${encodeURIComponent(sid)}&operation=${encodeURIComponent(cid)}&limit=50`)
          .then((value) => {
            const list = value && Array.isArray(value.entries) ? value.entries : []
            cacheRef.current.set(key, { at: Date.now(), pending: false, entries: list })
            if (keyRef.current === key) { setEntries(list); setLoading(false) }
          })
          .catch((reason) => {
            cacheRef.current.set(key, { at: Date.now(), pending: false, entries: [] })
            if (keyRef.current === key) { setEntries([]); setLoading(false); setError(String(reason?.message || reason)) }
          })
      }

      React.useEffect(() => {
        let disposed = false
        let raf = 0
        const rafFn = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : ((fn) => setTimeout(fn, 16))
        const cancelFn = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : ((id) => clearTimeout(id))
        const apply = (next) => {
          const prev = layoutRef.current
          if (prev.visible === next.visible
            && Math.abs(prev.tabTop - next.tabTop) < 1
            && Math.abs(prev.tabLeft - next.tabLeft) < 1
            && Math.abs(prev.paneTop - next.paneTop) < 1
            && Math.abs(prev.paneLeft - next.paneLeft) < 1
            && Math.abs(prev.paneWidth - next.paneWidth) < 1
            && Math.abs(prev.paneHeight - next.paneHeight) < 1) return
          layoutRef.current = next
          setLayout(next)
        }
        const hide = () => {
          apply({ visible: false, tabTop: 0, tabLeft: 0, tabWidth: 88, paneTop: 0, paneLeft: 0, paneWidth: 0, paneHeight: 0 })
          keyRef.current = ''
        }
        const tick = () => {
          try {
            if (disposed || typeof document === 'undefined' || typeof window === 'undefined') return
            const details = document.querySelector('[class*="_details"]')
            if (details === null) { hide(); return }
            const tabs = details.querySelector('[class*="_detailTabs"]')
            const body = details.querySelector('[class*="_detailBody"]')
            const row = document.querySelector('tr[data-selected="true"][data-trajectory-row-key]')
            if (tabs === null || body === null || row === null) { hide(); return }
            const detailsRect = details.getBoundingClientRect()
            const tabsRect = tabs.getBoundingClientRect()
            if (detailsRect.width < 220 || detailsRect.height < 120 || tabsRect.height === 0) { hide(); return }
            const sid = currentSessionId()
            if (sid === undefined) { hide(); return }
            // 给受 React 管理的 tabs 行留出右侧空位；只改 style，不动 DOM 结构。
            if (tabs.style.paddingRight !== '96px') tabs.style.paddingRight = '96px'
            const cid = trajectoryRowCallId(row)
            const key = `${sid}|${cid ?? ''}`
            if (key !== keyRef.current) {
              keyRef.current = key
              setCallId(cid)
              setSessionId(sid)
              setOpenBoth(false)
              if (cid === undefined) {
                setEntries([])
                setLoading(false)
                setError('')
              } else {
                loadAudit(sid, cid)
              }
            }
            const tabWidth = 88
            const tabTop = tabsRect.top + 4
            const tabLeft = Math.max(0, tabsRect.right - tabWidth - 4)
            const paneTop = tabsRect.bottom
            const paneLeft = detailsRect.left
            const paneWidth = detailsRect.width
            // 轨迹会把 composer 浮在面板底部；审计面板停在 composer 上沿，
            // 避免把输入框盖住（composer 不存在/隐藏时退回面板底边）。
            const composerSeat = document.querySelector('[class*="_composerSeat"]')
            const composerRect = composerSeat ? composerSeat.getBoundingClientRect() : null
            const paneBottom = composerRect !== null && composerRect.height > 0
              ? Math.min(detailsRect.bottom, composerRect.top)
              : detailsRect.bottom
            const paneHeight = Math.max(0, paneBottom - tabsRect.bottom)
            apply({ visible: true, tabTop, tabLeft, tabWidth, paneTop, paneLeft, paneWidth, paneHeight })
          } catch { /* 观察失败：保持现状 */ }
        }
        const schedule = () => {
          if (disposed || raf !== 0) return
          raf = rafFn(() => { raf = 0; tick() })
        }
        let observer = null
        try {
          observer = new MutationObserver(schedule)
          observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['data-selected', 'class', 'style'],
          })
        } catch { observer = null }
        const onScroll = () => schedule()
        let timer = null
        try {
          window.addEventListener('scroll', onScroll, true)
          window.addEventListener('resize', onScroll)
          timer = setInterval(tick, 700)
        } catch { /* 非浏览器环境 */ }
        const onDocClick = (event) => {
          try {
            const target = event.target
            if (!target || typeof target.closest !== 'function') return
            if (target.closest('.mem-traj-audit-tab') || target.closest('.mem-traj-audit-pane')) return
            if (target.closest('[class*="_detailTab"]')) setOpenBoth(false)
          } catch { /* 忽略 */ }
        }
        try { document.addEventListener('click', onDocClick, true) } catch { /* 忽略 */ }
        schedule()
        return () => {
          disposed = true
          if (raf !== 0) cancelFn(raf)
          if (timer !== null) clearInterval(timer)
          try { observer?.disconnect() } catch { /* 已断开 */ }
          try {
            window.removeEventListener('scroll', onScroll, true)
            window.removeEventListener('resize', onScroll)
            document.removeEventListener('click', onDocClick, true)
          } catch { /* 非浏览器环境 */ }
        }
      }, [])

      if (!layout.visible) return null
      const toggle = () => setOpenBoth(!openRef.current)
      const close = () => setOpenBoth(false)
      const openInPanel = (entryId) => {
        openMemoryAuditPanel({
          sessionId,
          ...(callId !== undefined ? { callId } : {}),
          ...(entryId !== undefined ? { entryId } : {}),
        })
      }
      const rowView = (entry) => {
        const ids = entry.selected && Array.isArray(entry.selected.contentIds) ? entry.selected.contentIds : []
        const outcome = auditOutcomeMeta(entry.outcome)
        return h('button', {
          key: entry.id,
          className: 'mem-traj-audit-row',
          title: `${fmtTime(entry.at)} · ${entry.trigger || entry.stage || ''}`,
          onClick: () => openInPanel(entry.id),
        },
          h('div', { className: 'mem-traj-audit-row-top' },
            h('span', { className: 't' }, shortTime(entry.at)),
            h('span', { className: 'ch' }, `${auditChannelLabel(entry.channel)} · ${entry.kind || 'event'}`),
            h('span', { className: 'spacer' }),
            h('span', { className: `audit-pill ${outcome.tone}` }, outcome.label),
          ),
          h('div', { className: 'mem-traj-audit-row-meta' },
            `${entry.trigger || '—'}${entry.stage ? ` / ${entry.stage}` : ''}`
            + (entry.delivery ? ` · ${auditDeliveryMeta(entry).label}` : '')
            + (entry.candidates !== undefined ? ` · 候选 ${entry.candidates}` : '')
            + (entry.selected && entry.selected.count !== undefined ? ` · 选中 ${entry.selected.count}` : ''),
          ),
          ids.length > 0
            ? h('div', { className: 'mem-traj-audit-row-ids' },
                ids.slice(0, 4).map((id) => h('span', { className: 'audit-id', key: id }, String(id).length > 14 ? `${String(id).slice(0, 10)}…` : String(id))),
                ids.length > 4 ? h('span', { className: 'audit-id-sub' }, `+${ids.length - 4}`) : null,
              )
            : null,
        )
      }
      return h(React.Fragment, null,
        h('button', {
          className: 'mem-traj-audit-tab' + (open ? ' on' : ''),
          style: { top: layout.tabTop, left: layout.tabLeft, width: layout.tabWidth },
          title: callId === undefined ? '这条记录没有 callId 锚点，可打开本会话记忆审计' : `查看这次调用的记忆审计（${callId}）`,
          onClick: toggle,
        }, `记忆审计${entries.length > 0 ? ` ${entries.length}` : ''}`),
        open
          ? h('div', {
              className: 'memp mem-traj-audit-pane',
              style: {
                top: layout.paneTop,
                left: layout.paneLeft,
                width: layout.paneWidth,
                height: layout.paneHeight,
              },
            },
              h('div', { className: 'mem-traj-audit-pane-head' },
                h('b', null, '记忆审计'),
                callId !== undefined ? h('span', { className: 'mono', title: callId }, callId.length > 20 ? `${callId.slice(0, 18)}…` : callId) : null,
                h('span', { className: 'spacer' }),
                h('button', { className: 'linkbtn', onClick: close }, '返回轨迹'),
              ),
              h('div', { className: 'mem-traj-audit-pane-body' },
                loading
                  ? h('div', { className: 'mem-traj-audit-empty' }, '加载审计…')
                  : error
                    ? h('div', { className: 'mem-traj-audit-empty' }, `加载失败：${error}`)
                    : entries.length === 0
                      ? h('div', { className: 'mem-traj-audit-empty' },
                          callId === undefined
                            ? '这条轨迹记录没有 callId 锚点，无法精确过滤；可以打开本会话记忆审计，按轮次/步骤查找。'
                            : '这次调用没有记忆审计记录（可能发生在审计开启前，或已被容量策略淘汰）。',
                        )
                      : entries.map(rowView),
              ),
              h('div', { className: 'mem-traj-audit-pane-foot' },
                h('span', { className: 'muted' }, entries.length > 0 ? `${entries.length} 条` : ''),
                h('span', { className: 'spacer' }),
                h('button', { onClick: () => openInPanel(entries[0]?.id) }, '打开本会话记忆审计'),
              ),
            )
          : null,
      )
    }

    const inject = ['slots']

    /** 侧栏入口打开的主界面页面(整块可滚动,内容就是面板本体)。 */
    function MemoryPage({ openSession, sessionInfo } = {}) {
      return h('div', { className: 'mem-page' },
        h('div', { className: 'mem-page-head' }, h('h2', null, '记忆系统')),
        h(MemoryPanel, { openSession, sessionInfo, audience: 'panel' }),
      )
    }

    /**
     * 侧栏入口图标:年轮线稿(16 网格、1.3 描边、currentColor),按 size 缩放(默认 16)。
     *
     * 这里和插件列表的 **icon.svg** 是两个 surface,不能共用一套画法:
     *   - 插件管理器卡片/行:30/36px、深咖瓦片 + 香槟金年轮,是插件的品牌美术;
     *   - 左侧栏 / 设置侧栏:16px 单色线稿(宿主 Icon*OutlineMedium 同规范:
     *     16 网格、fill:none、stroke:currentColor、strokeWidth 1.3)。
     * 0.9.3 曾把彩色瓦片塞进侧栏,结果在那一列里是一块实心深色方块,和旁边的线稿
     * 图标格格不入;0.9.4 改回线稿,但记号仍是"年轮"(圆角瓦片轮廓 + 1.75 圈螺旋),
     * 不再是 0.9.1 以前的"内存芯片"。
     *
     * 螺旋用 7 段圆弧近似(不是几百个点的折线),16px 下是一条完整的线;颜色跟随
     * currentColor,深浅主题自动适配。
     */
    const NAV_ICON_NS = 'http://www.w3.org/2000/svg'
    const NAV_VIEW_BOX = '0 0 16 16'
    /** 年轮螺旋:16 网格、从中心 r1.3 长到 r4.4、1.75 圈。 */
    const NAV_RING = 'M7.35 6.87 A1.52 1.52 0 0 1 9.51 7.13 A1.96 1.96 0 0 1 9.09 9.89 A2.41 2.41 0 0 1 5.72 9.31 A2.85 2.85 0 0 1 6.46 5.34 A3.29 3.29 0 0 1 11.04 6.24 A3.74 3.74 0 0 1 9.98 11.43 A4.18 4.18 0 0 1 4.19 10.20'
    /** 圆角瓦片轮廓:与 icon.svg 的瓦片同形,只是描边而不是填色。 */
    const NAV_FRAME = { x: 1.65, y: 1.65, width: 12.7, height: 12.7, rx: 3.8 }

    function NavLineIcon({ size = 16 } = {}) {
      return h('svg', { width: size, height: size, viewBox: NAV_VIEW_BOX, fill: 'none', 'aria-hidden': 'true' },
        h('rect', { ...NAV_FRAME, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 }),
        h('path', { d: NAV_RING, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )
    }

    /**
     * 输入框里的「记忆可见范围」按钮。
     *
     * 宿主 `conversation.input.right` 是 session 作用域的 list 槽,owner 会把
     * `sessionId` 作为标准 prop 传进来,所以这里不需要 register 的 inject。
     *
     * 读写走 /memory/api/visibility:
     *   GET  ?session=<id> → { override, effective, inherited, scopes }
     *   POST { session, scopes: string[] | null } → 同上
     * `override === null` = 使用默认三路集合;子 Agent 会话会继承父会话的 override。
     *
     * 弹层用 fixed 定位(按按钮 rect 往上开),避免被 composer 的 overflow 裁掉。
     */
    /**
     * 输入框里的「记忆可见域」按钮 + 浮窗。
     *
     * 宿主 `conversation.input.right` 是 session 作用域的 list 槽,owner 会把
     * `sessionId` 作为标准 prop 传进来,所以这里不需要 register 的 inject。
     *
     * 读写走 /memory/api/visibility:
     *   GET  ?session=<id> → { override, effective, inherited, scopes, kinds }
     *   POST { session, visibility: { scopes: [{ scope, kinds? }], level } | null } → 同上
     * `override === null` = 使用默认三路集合;子 Agent 会话会继承父会话的 override。
     *
     * 弹层用 fixed 定位(按按钮 rect 往上开),避免被 composer 的 overflow 裁掉。
     * 视觉:毛玻璃背景 + 自定义勾选 + 类型 chips + 三档限制等级。
     */
    /**
     * 输入框里的「记忆范围」按钮 + 浮窗。
     *
     * 宿主 `conversation.input.right` 是 session 作用域的 list 槽,owner 会把
     * `sessionId` 作为标准 prop 传进来,所以这里不需要 register 的 inject。
     *
     * 0.19.1 起:
     *   - 打开会话就 GET 一次,按钮直接显示该会话的范围数量(不再等点击才刷新);
     *   - 按钮只显示数字,不再显示「记忆可见域」文字;
     *   - 首次打开且没有显式覆盖时,按服务端给的 defaults 预选默认范围;
     *   - 不再按记忆类型收窄,只选作用域。
     *
     * 读写走 /memory/api/visibility:
     *   GET  ?session=<id> → { override, effective, inherited, defaults, workspace, bindings, scopes }
     *   POST { session, visibility: { scopes: [{ scope, read?, write? }], level } | null,
     *          bindings: string[] } → 同上
     *
     * 0.25.13 起还有只写绑定的 /bindings:
     *   POST { session, bindings: string[] } → { sessionId, bindings }
     *   绑定是工作区级设置（本工作区新会话的默认可见范围），点一下就落盘，
     *   不等「保存」；也不需要给会话注入上下文提示。
     *
     * 0.23.0:
     *   - 每个作用域有「绑定 / 可读 / 可写」状态按钮;绑定是工作区级(新会话默认可见),
     *     可读 / 可写是会话级,直接影响工具读到 / 写到该作用域时的结果与失败原因;
     *   - 保存时 read/write 只在关掉时提交 false,绑定整体提交。
     *
     * 0.25.13:
     *   - 「绑定」按钮点一下立即保存（工作区级，POST /bindings），不再等「保存」；
     *     勾选范围 / 可读 / 可写仍是草稿，点「保存」才生效。
     *   - 绑定变化不注入「记忆权限已更新」上下文提示（当前会话读什么没变）。
     */
    function MemoryVisibilityButton({ sessionId } = {}) {
      const [open, setOpen] = React.useState(false)
      const [loading, setLoading] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [data, setData] = React.useState(null)
      const [level, setLevel] = React.useState('normal')
      const [entries, setEntries] = React.useState({})
      const [savedEntries, setSavedEntries] = React.useState({})
      const [pendingRevoke, setPendingRevoke] = React.useState({})
      const [perms, setPerms] = React.useState({})
      const [bound, setBound] = React.useState({})
      // 0.25.13：绑定按钮是**即时保存**的，这里记正在提交的作用域键（空 = 空闲）。
      const [bindBusy, setBindBusy] = React.useState('')
      const [defaultBound, setDefaultBound] = React.useState({})
      const [catalog, setCatalog] = React.useState([])
      const [search, setSearch] = React.useState('')
      const [anchor, setAnchor] = React.useState(null)
      const [grants, setGrants] = React.useState([])
      const [grantBusy, setGrantBusy] = React.useState('')
      const [grantError, setGrantError] = React.useState('')
      const wrapRef = React.useRef(null)
      // 0.25.8：浮窗 portal 到 body 后不再长在 wrapRef 这棵树里，点它自己不能算「点外面」。
      const popRef = React.useRef(null)

      React.useEffect(() => {
        if (!open) return undefined
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
        const inside = (node, target) => Boolean(node && typeof node.contains === 'function' && node.contains(target))
        const onDown = (event) => {
          try {
            const target = event ? event.target : null
            if (inside(wrapRef.current, target) || inside(popRef.current, target)) return
            setOpen(false)
          } catch { /* 关闭失败不影响页面 */ }
        }
        const onKey = (event) => { if (event && event.key === 'Escape') setOpen(false) }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
          try {
            document.removeEventListener('mousedown', onDown)
            document.removeEventListener('keydown', onKey)
          } catch { /* 宿主卸载时 document 可能已不可用 */ }
        }
      }, [open])

      const applyPayload = (value) => {
        if (!value || typeof value !== 'object') return
        setData(value)
        const config = (value.override && typeof value.override === 'object' && !Array.isArray(value.override))
          ? value.override
          : (value.effective && typeof value.effective === 'object' && !Array.isArray(value.effective) ? value.effective : null)
        setLevel(config && (config.level === 'absolute' || config.level === 'none') ? config.level : 'normal')
        const selected = new Set()
        const selectedRules = config && Array.isArray(config.scopes) ? config.scopes : []
        for (const rule of selectedRules) {
          const scope = typeof rule === 'string' ? rule : rule && typeof rule.scope === 'string' ? rule.scope : ''
          if (scope !== '') selected.add(scope)
        }
        // 没有显式覆盖 / 生效策略时用 defaults(默认会话 + 项目 + global)预选。
        // 服务端可能没把 defaults 放进目录(旧版或宿主缺 sessions),这里自己补齐。
        if (selected.size === 0 && Array.isArray(value.defaults)) {
          for (const scope of value.defaults) if (typeof scope === 'string' && scope !== '') selected.add(scope)
        }
        const nextCatalog = []
        const seen = new Set()
        for (const item of Array.isArray(value.scopes) ? value.scopes : []) {
          if (!item || typeof item.scope !== 'string' || item.scope === '' || seen.has(item.scope)) continue
          seen.add(item.scope)
          nextCatalog.push(item)
        }
        for (const scope of selected) {
          if (seen.has(scope)) continue
          seen.add(scope)
          nextCatalog.push({ scope, label: scopeDisplayName(scope), records: 0 })
        }
        // 旧服务端没有 defaults 时的兜底:至少把默认三路(会话 / 项目 / global)选上,
        // 不要再出现"一打开什么都没选"。
        if (selected.size === 0) {
          for (const item of nextCatalog) {
            if (item.scope === 'global' || item.scope.startsWith('session:') || item.scope.startsWith('project:')) {
              selected.add(item.scope)
            }
          }
        }
        const nextEntries = {}
        for (const item of nextCatalog) nextEntries[item.scope] = selected.has(item.scope)
        // 0.23.0:每个作用域的 read / write 状态 + 工作区绑定。
        const ruleByScope = new Map()
        for (const rule of selectedRules) {
          const scope = typeof rule === 'string' ? rule : rule && typeof rule.scope === 'string' ? rule.scope : ''
          if (scope !== '' && !ruleByScope.has(scope)) ruleByScope.set(scope, rule)
        }
        const boundSet = new Set(
          (Array.isArray(value.bindings) ? value.bindings : [])
            .filter((scope) => typeof scope === 'string' && scope !== ''),
        )
        // 默认基础范围(会话 + 项目 + global)天然包含在默认范围里:展示为已绑定、
        // 不可取消;只有额外绑定才进 bound 状态、才会随保存提交。
        const defaultSet = new Set(
          (Array.isArray(value.defaultScopes)
            ? value.defaultScopes
            : (Array.isArray(value.defaults) ? value.defaults : []).filter((scope) => typeof scope === 'string'
              && (scope === 'global' || scope.startsWith('session:') || scope.startsWith('project:'))))
            .filter((scope) => typeof scope === 'string' && scope !== ''),
        )
        const nextPerms = {}
        const nextBound = {}
        const nextDefaultBound = {}
        for (const item of nextCatalog) {
          const rule = ruleByScope.get(item.scope)
          nextPerms[item.scope] = {
            read: rule ? rule.read !== false : item.read !== false,
            write: rule ? rule.write !== false : item.write !== false,
          }
          nextBound[item.scope] = boundSet.has(item.scope)
          nextDefaultBound[item.scope] = defaultSet.has(item.scope) || item.defaultBound === true
        }
        setCatalog(nextCatalog)
        setEntries(nextEntries)
        // 保存过的勾选基线:排序与「已选」都以它为准,草稿改动不立刻重排。
        setSavedEntries({ ...nextEntries })
        setPerms(nextPerms)
        setBound(nextBound)
        setDefaultBound(nextDefaultBound)
      }

      const load = () => {
        setLoading(true)
        setError('')
        api(`visibility?session=${encodeURIComponent(sessionId)}`)
          .then(applyPayload)
          .catch((e) => setError(String((e && e.message) || e)))
          .finally(() => setLoading(false))
      }

      // 打开会话就加载一次:按钮上的数字来自这个会话的设置,不需要用户先点按钮。
      React.useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId === '') return
        load()
      }, [sessionId])

      const toggle = (event) => {
        if (open) { setOpen(false); return }
        let nextAnchor = null
        try {
          const rect = event && event.currentTarget && event.currentTarget.getBoundingClientRect
            ? event.currentTarget.getBoundingClientRect()
            : null
          if (rect) nextAnchor = { left: rect.left, top: rect.top }
        } catch { nextAnchor = null }
        setAnchor(nextAnchor)
        setSearch('')
        setOpen(true)
        load()
      }

      /**
       * 0.25.3：本会话的 Agent 授权（grants）。
       * 授权结果直接体现在作用域行的勾选上（外加「AI」气泡），所以浮窗打开期间
       * 按 3 秒轮询：Agent 刚审批到的授权不用重开面板就能看到勾选与气泡。
       */
      const loadGrants = () => {
        if (typeof sessionId !== 'string' || sessionId === '') return
        api(`grants?session=${encodeURIComponent(sessionId)}`)
          .then((value) => {
            setGrants(Array.isArray(value.grants) ? value.grants : [])
            setGrantError('')
          })
          .catch((e) => setGrantError(String((e && e.message) || e)))
      }

      /**
       * 0.25.6：轮询不再限定「浮窗打开」。
       * 输入框按钮上的数字是「可见范围 ∪ 本会话 AI 授权」，浮窗关着的时候也得跟着
       * 授权变 —— 否则 Agent 刚审批到的权限，用户要手动开一次浮窗数字才更新
       * （表现为「数字没有实时变化」）。浮窗打开的实时性与 0.25.3 一致。
       */
      React.useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId === '') return undefined
        // 换会话 = 换一份授权清单：先清掉上一个会话的，避免按钮数字短暂串台。
        setGrants([])
        loadGrants()
        if (typeof setInterval !== 'function') return undefined
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden) return
          loadGrants()
        }, 3000)
        return () => clearInterval(timer)
      }, [sessionId])

      /**
       * 0.25.6：草稿不跨「关闭浮窗」。
       * 点外面 / Esc / 再点按钮把浮窗关掉时，取消勾选留下的「AI·待撤销」标记与勾选
       * 草稿一律丢弃：重开时只显示服务端真值（没保存就还原，不要记住草稿）。
       */
      React.useEffect(() => {
        if (open) return
        setPendingRevoke((prev) => (Object.keys(prev).length === 0 ? prev : {}))
        setGrantError((prev) => (prev === '' ? prev : ''))
        // 勾选草稿回到「保存过的状态」；正常路径 load() 会再拉一次真值，这里兜住拉取失败。
        setEntries((prev) => {
          const keys = Object.keys(prev)
          const next = {}
          let changed = false
          for (const scope of keys) {
            next[scope] = Boolean(savedEntries[scope])
            if (next[scope] !== prev[scope]) changed = true
          }
          return changed ? next : prev
        })
      }, [open, savedEntries])

      /** 撤销一条本会话授权（继承自父会话的授权只能到父会话撤销）。 */
      const revokeGrant = (grant) => {
        if (!grant || grant.inherited === true) return Promise.resolve()
        const id = typeof grant.id === 'string' ? grant.id : ''
        if (id === '') return Promise.resolve()
        const owner = typeof grant.ownerSession === 'string' && grant.ownerSession !== '' ? grant.ownerSession : sessionId
        setGrantBusy(id)
        setGrantError('')
        return api('grants', { session: owner, id, view: sessionId })
          .then((value) => setGrants(Array.isArray(value.grants) ? value.grants : []))
          .catch((e) => setGrantError(String((e && e.message) || e)))
          .finally(() => setGrantBusy(''))
      }

      /**
       * 勾选 / 取消勾选作用域 —— 都是草稿状态，点「保存」才生效。
       * 取消勾选一条 AI 授权的行 = 标记为「待撤销」，保存时才真正撤销授权。
       */
      const toggleScope = (scope) => {
        const grant = grantsByScope.get(scope)
        if (!grant) {
          setEntries((prev) => ({ ...prev, [scope]: !prev[scope] }))
          return
        }
        if (grant.inherited === true) {
          setEntries((prev) => ({ ...prev, [scope]: true }))
          setGrantError('继承自父会话的授权需要到父会话撤销')
          return
        }
        const pending = Boolean(pendingRevoke[scope])
        setPendingRevoke((prev) => {
          const next = { ...prev }
          if (pending) delete next[scope]
          else next[scope] = true
          return next
        })
        // 取消勾选先清掉草稿里的范围勾选；再勾回来时恢复到保存时的勾选状态。
        setEntries((prev) => ({ ...prev, [scope]: pending ? Boolean(savedEntries[scope]) : false }))
      }

      /** 切换某个作用域的可读 / 可写状态（会话级）。 */
      const togglePerm = (scope, key) => {
        setPerms((prev) => {
          const current = prev[scope] ?? { read: true, write: true }
          return { ...prev, [scope]: { ...current, [key]: !current[key] } }
        })
      }

      /** 切换某个作用域是否绑定到当前工作区（工作区级，新会话默认可见）。 */
      const toggleBound = (scope) => {
        // 0.25.13：绑定**点一下就落盘**，不再等「保存」。
        // 理由：绑定是工作区级设置（本工作区新会话的默认可见范围），和浮窗里
        // 「勾选范围 / 可读可写」那份会话级草稿互不相干；以前混在一次保存里，
        // 用户点完「绑定」看不出任何反馈，还以为没生效。
        if (typeof sessionId !== 'string' || sessionId === '') return
        if (bindBusy !== '') return
        if (defaultBound[scope] || String(scope).startsWith('session:')) return
        const previous = { ...bound }
        const nextBound = { ...bound, [scope]: !bound[scope] }
        const bindings = catalog
          .filter((item) => nextBound[item.scope] && !defaultBound[item.scope] && !String(item.scope).startsWith('session:'))
          .map((item) => item.scope)
        setBound(nextBound) // 乐观更新：按钮立刻变成已绑定 / 已解除
        setBindBusy(scope)
        setError('')
        api('bindings', { session: sessionId, bindings })
          .then((value) => {
            // 以服务端返回的落盘结果为准（它会做去重 / 规范化）。
            const saved = Array.isArray(value && value.bindings) ? value.bindings : bindings
            const confirmed = {}
            for (const item of catalog) {
              confirmed[item.scope] = defaultBound[item.scope] === true || saved.includes(item.scope)
            }
            setBound(confirmed)
            setData((prev) => (prev && typeof prev === 'object' ? { ...prev, bindings: saved } : prev))
          })
          .catch((e) => {
            setBound(previous) // 失败回滚，别让按钮显示一个没落盘的状态
            setError(String((e && e.message) || e))
          })
          .finally(() => setBindBusy(''))
      }

      const selectAll = () => {
        setEntries((prev) => {
          const next = { ...prev }
          for (const key of Object.keys(next)) next[key] = true
          return next
        })
        // 全选 = 不再撤销任何授权（草稿里取消的重新勾回来）。
        setPendingRevoke({})
      }

      const clearAll = () => {
        setEntries((prev) => {
          const next = { ...prev }
          for (const key of Object.keys(next)) next[key] = false
          return next
        })
        // 取消全选也是草稿：AI 授权只标记「待撤销」，点保存才真正撤销；
        // 继承自父会话的授权撤销不了，只提示去父会话操作。
        const next = {}
        let inherited = 0
        for (const grant of Array.isArray(grants) ? grants : []) {
          if (!grant || typeof grant.scope !== 'string' || grant.scope === '') continue
          if (grant.inherited === true) { inherited += 1; continue }
          next[grant.scope] = true
        }
        setPendingRevoke(next)
        if (inherited > 0) setGrantError('继承自父会话的授权需要到父会话撤销')
      }

      const save = (config, revokeFirst) => {
        setBusy(true)
        setError('')
        // 只提交**额外**绑定:默认范围自带的会话 / 项目 / global 不需要也不允许写入。
        // 0.25.13 起绑定已经由 toggleBound **即时**写入 /bindings，这里再带上一次是
        // 幂等的兜底（同一份状态，旧客户端 / 老服务端仍能按一次保存生效）。
        const bindings = catalog
          .filter((item) => bound[item.scope] && !defaultBound[item.scope] && !String(item.scope).startsWith('session:'))
          .map((item) => item.scope)
        // 保存时先撤销草稿里取消勾选的 AI 授权，再写可见范围。
        let chain = Promise.resolve()
        for (const grant of Array.isArray(revokeFirst) ? revokeFirst : []) {
          chain = chain.then(() => revokeGrant(grant))
        }
        chain
          .then(() => api('visibility', { session: sessionId, visibility: config, bindings }))
          .then((value) => {
            applyPayload(value)
            setPendingRevoke({})
            setOpen(false)
          })
          .catch((e) => setError(String((e && e.message) || e)))
          .finally(() => setBusy(false))
      }

      const saveDraft = () => {
        const scopes = catalog.filter((item) => entries[item.scope]).map((item) => ({
          scope: item.scope,
          read: perms[item.scope]?.read !== false,
          write: perms[item.scope]?.write !== false,
        }))
        if (scopes.length === 0) { setError('至少选择一个可见范围'); return }
        const pendingGrants = Object.keys(pendingRevoke)
          .filter((scope) => pendingRevoke[scope])
          .map((scope) => grantsByScope.get(scope))
          .filter(Boolean)
        save({ scopes, level }, pendingGrants)
      }

      if (typeof sessionId !== 'string' || sessionId === '') return null

      const override = data && data.override && typeof data.override === 'object' && !Array.isArray(data.override)
        ? data.override
        : null
      const hasOverride = override !== null
      const effectiveConfig = override
        ?? (data && data.effective && typeof data.effective === 'object' && !Array.isArray(data.effective) ? data.effective : null)
      const selectedCount = catalog.filter((item) => entries[item.scope]).length
      const needle = search.trim().toLowerCase()
      // 0.25.4：Agent 授权的结果用勾选呈现 —— 勾选 = 本会话可访问，授权来的作用域
      // 在名称右边挂一个「AI」气泡。取消勾选只是草稿（标「待撤销」），点「保存」才撤销；
      // 列表顺序按**已保存**的勾选排序，保存后才重排。
      const grantList = Array.isArray(grants) ? grants : []
      const grantsByScope = new Map()
      for (const grant of grantList) {
        if (!grant || typeof grant.scope !== 'string' || grant.scope === '') continue
        if (!grantsByScope.has(grant.scope)) grantsByScope.set(grant.scope, grant)
      }
      /** 当前草稿里的勾选状态（取消勾选的 AI 授权算未勾选）。 */
      const isChecked = (scope) => Boolean(entries[scope])
        || (grantsByScope.has(scope) && !pendingRevoke[scope])
      /** 已保存状态的勾选（排序只看它，草稿改动不立刻重排）。 */
      const savedChecked = (scope) => Boolean(savedEntries[scope]) || grantsByScope.has(scope)
      /**
       * 0.25.8：本会话自己的 session scope 在列表里叫「当前会话」；0.25.10 起名字统一带
       * 类型前缀，所以是 `session:当前会话`。
       *
       * 面板是「这个会话」的权限面板，那一行就是用户正在用的会话 —— 显示
       * `session:<uuid>` 或 `session-1a2b3c4d` 都只有实现细节，用户无从对号。
       * **只**改本会话那一条：目录里可能还有别的会话的 scope（它们带记录就会被发现），
       * 那些仍按标题 / 短 id 显示，不能跟着叫「当前会话」。
       *
       * 标签一律带类型前缀（`global:` / `project:` / `session:` / `custom:`）：自定义
       * 作用域的键本身没有前缀，直接吐裸名字会和 global / project 混在一起分不清种类。
       */
      const currentSessionScope = (typeof sessionId === 'string' && sessionId !== '') ? `session:${sessionId}` : ''
      const displayName = (scope, label) => (currentSessionScope !== '' && scope === currentSessionScope)
        ? scopeDisplayName(scope, '当前会话')
        : (typeof label === 'string' && label !== '' ? label : scopeDisplayName(scope))
      const matches = (label, scope) => !needle
        || displayName(scope, label).toLowerCase().includes(needle) || String(scope).toLowerCase().includes(needle)
      const visibleScopes = catalog.filter((item) => matches(item.label || item.scope, item.scope))
      // 目录里已经看不到的作用域（记录删光 / 元数据没了）仍占一行，方便取消勾选撤销授权。
      const catalogScopes = new Set(catalog.map((item) => item.scope))
      const orphanGrants = grantList.filter((grant) => grant && typeof grant.scope === 'string' && grant.scope !== ''
        && !catalogScopes.has(grant.scope) && matches(grant.label || grant.scope, grant.scope))
      // 已勾选的排上面、未勾选的排下面，组内按名称字母排序；顺序以保存过的状态为准。
      const rows = [
        ...visibleScopes.map((item) => ({ scope: item.scope, name: displayName(item.scope, item.label), item })),
        ...orphanGrants.map((grant) => ({ scope: grant.scope, name: displayName(grant.scope, grant.label), grant })),
      ]
      rows.sort((a, b) => (Number(savedChecked(b.scope)) - Number(savedChecked(a.scope)))
        || a.name.localeCompare(b.name, 'zh-Hans-CN', { sensitivity: 'base', numeric: true })
        || a.scope.localeCompare(b.scope))
      /** 作用域名称右边的「AI」气泡：表示这条勾选来自 Agent 申请的授权。 */
      const grantTag = (grant, scope) => {
        const pending = Boolean(pendingRevoke[scope])
        return h('span', {
          className: `mem-scope-ai${grant.inherited === true ? ' inherited' : ''}${pending ? ' pending' : ''}`,
          title: pending
            ? `Agent 申请的范围外授权（${grantPermissionText(grant.permissions)}）；点「保存」后撤销`
            : (grant.inherited === true
              ? `Agent 申请的范围外授权（${grantPermissionText(grant.permissions)}）· 继承自父会话，要到父会话撤销`
              : `Agent 申请的范围外授权（${grantPermissionText(grant.permissions)}）；取消勾选后点「保存」即撤销`),
        }, pending ? 'AI·待撤销' : (grant.inherited === true ? 'AI·继承' : 'AI'))
      }
      let popStyle = {}
      if (anchor) {
        const width = 340
        const margin = 8
        const viewportW = (typeof window !== 'undefined' && Number(window.innerWidth)) || 1024
        const viewportH = (typeof window !== 'undefined' && Number(window.innerHeight)) || 768
        popStyle = {
          left: Math.min(Math.max(margin, anchor.left), Math.max(margin, viewportW - width - margin)),
          bottom: Math.max(margin, viewportH - anchor.top + 8),
        }
      }

      const levelMeta = [
        { value: 'absolute', label: '绝对限制', hint: '范围外查不到' },
        { value: 'normal', label: '普通限制', hint: '范围外需审批' },
        { value: 'none', label: '无限制', hint: '不限制读写' },
      ]
      // 按钮上的边框样式来自**生效中**的限制等级:没有显式覆盖时是默认的普通限制。
      const buttonLevel = effectiveConfig && (effectiveConfig.level === 'absolute' || effectiveConfig.level === 'none')
        ? effectiveConfig.level
        : 'normal'
      const buttonLevelLabel = (levelMeta.find((item) => item.value === buttonLevel) ?? levelMeta[1]).label
      const sourceText = data && data.source === 'inherited'
        ? '继承自父会话'
        : hasOverride ? '本会话已设置' : '本会话使用默认'
      // 0.25.5：按钮数字 = 可见范围 ∪ AI 授权（AI 授权也是本会话能读的作用域，算进去）。
      const effectiveScopeKeys = effectiveConfig && Array.isArray(effectiveConfig.scopes)
        ? effectiveConfig.scopes
          .map((rule) => (typeof rule === 'string' ? rule : rule && typeof rule.scope === 'string' ? rule.scope : ''))
          .filter((scope) => scope !== '')
        : (data && Array.isArray(data.defaults) ? data.defaults.filter((scope) => typeof scope === 'string') : [])
      const accessibleCount = new Set([
        ...effectiveScopeKeys,
        ...grantList.filter((grant) => grant && typeof grant.scope === 'string' && grant.scope !== '')
          .map((grant) => grant.scope),
      ]).size
      // 弹窗头部的「已选」= 当前勾选数（含 AI 授权的勾选；标了待撤销的不算）。
      const orphanChecked = grantList.filter((grant) => grant && typeof grant.scope === 'string'
        && grant.scope !== '' && !catalogScopes.has(grant.scope) && !pendingRevoke[grant.scope]).length
      const checkedCount = catalog.filter((item) => isChecked(item.scope)).length + orphanChecked
      const scopeCountText = `${accessibleCount} 个作用域`
      const portalTarget = typeof document !== 'undefined' && document !== null && document.body ? document.body : null
      // 0.25.8：浮窗 portal 到 body（原因见文件头 createPortal 的注释）。拿不到 react-dom
      // 或没有 document.body 时退回原地渲染 —— 层级受限，但功能完全一致。
      const popover = open ? h('div', { className: 'mem-scope-pop', ref: popRef, style: popStyle, role: 'dialog', 'aria-label': '记忆权限' },
          h('div', { className: 'mem-scope-head' },
            h('h4', null, '记忆权限'),
            h('span', { className: 'spacer' }),
            h('span', { className: 'mem-scope-count' }, `已选 ${checkedCount}`),
          ),
          data && data.inherited
            ? h('div', { className: 'hint' }, '当前继承自父会话；保存后在本会话独立生效。')
            : null,
          h('div', { className: 'mem-scope-level', role: 'radiogroup', 'aria-label': '限制等级' },
            levelMeta.map((item) => h('button', {
              key: item.value,
              type: 'button',
              role: 'radio',
              'aria-checked': level === item.value,
              className: `mem-scope-level-btn${level === item.value ? ' on' : ''}`,
              onClick: () => setLevel(item.value),
              title: item.hint,
            }, h('b', null, item.label), h('span', null, item.hint))),
          ),
          level === 'none'
            ? h('div', { className: 'mem-scope-note' }, '无限制：范围选择会保存，但暂不参与读取限制。')
            : null,
          h('div', { className: 'mem-scope-search' },
            h('input', {
              type: 'search',
              placeholder: '搜索作用域…',
              value: search,
              'aria-label': '搜索作用域',
              onChange: (event) => setSearch(event.target.value),
            }),
            h('button', { type: 'button', className: 'linkbtn', onClick: selectAll }, '全选'),
            h('button', { type: 'button', className: 'linkbtn', onClick: clearAll }, '取消全选'),
          ),
          // 0.25.13：两种设置的生命周期不同 —— 绑定是工作区级、点一下立即保存；
          // 勾选范围 / 可读 / 可写是本会话的草稿，点「保存」才生效。
          h('div', { className: 'hint' }, '「绑定」点一下立即保存（工作区级）；勾选范围与可读 / 可写点「保存」后生效。'),
          loading && data === null
            ? h('div', { className: 'hint' }, '读取中…')
            : h('div', { className: 'mem-scope-list' },
                rows.length === 0
                  ? h('div', { className: 'hint' }, needle ? '没有匹配的作用域。' : '还没有可选的范围。')
                  : rows.map((row) => {
                    const item = row.item
                    const grant = item ? grantsByScope.get(row.scope) : row.grant
                    const checked = isChecked(row.scope)
                    // 只靠 AI 授权才勾上的行加 .ai：样式与用户自己勾选的行区分开。
                    const aiOnly = Boolean(grant) && !entries[row.scope]
                    // 0.25.7：整张卡片都可点选 —— 按钮（勾选框 / 绑定 / 可读 / 可写）自己处理点击，
                    // 点卡片其余区域（名称、计数、留白）等同点勾选框，避免只能戳 16px 的小方块。
                    const toggleFromCard = (event) => {
                      const target = event && event.target
                      if (target && typeof target.closest === 'function'
                        && target.closest('button,input,textarea,select,a,label')) return
                      toggleScope(row.scope)
                    }
                    const shownName = displayName(row.scope, item ? item.label : row.grant.label)
                    return h('div', {
                      className: `mem-scope-item${checked ? ' on' : ''}${aiOnly ? ' ai' : ''}`,
                      key: row.scope,
                      onClick: toggleFromCard,
                    },
                      h('div', { className: 'mem-scope-row' },
                        h('button', {
                          type: 'button',
                          role: 'checkbox',
                          'aria-checked': checked,
                          className: `mem-scope-check${checked ? ' on' : ''}${aiOnly ? ' ai' : ''}`,
                          onClick: () => toggleScope(row.scope),
                          'aria-label': checked ? '取消选择' : '选择',
                          title: grant
                            ? (grant.inherited === true
                              ? 'AI 申请的授权（继承自父会话，要到父会话撤销）'
                              : (pendingRevoke[row.scope] ? '已标记撤销，点「保存」生效' : '取消勾选后点「保存」撤销 AI 申请的这条授权'))
                            : null,
                        }, h('span', { className: 'box' }, checked ? h('svg', { width: 11, height: 11, viewBox: '0 0 12 12', 'aria-hidden': 'true' }, h('path', { d: 'M2 6.2 4.7 9 10 3.4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' })) : null)),
                        h('button', {
                          type: 'button',
                          className: 'mem-scope-label',
                          title: item ? scopeTitle(row.scope, shownName) : `${row.scope}（目录中已不可见）`,
                          onClick: () => toggleScope(row.scope),
                        }, shownName),
                        grant ? grantTag(grant, row.scope) : null,
                        h('span', { className: 'cnt' }, item ? `${item.records ?? 0}` : '目录中已不可见'),
                      ),
                      // 0.25.11：显示名与真实键不一致时，把**完整键**单独一行放出来
                      // （项目别名 → 完整路径、会话短 id → 完整 uuid、自定义名 → 裸键）。
                      // 不做手工截断：CSS 按可用宽度省略，容器宽就多显示几个字符，窗口变窄自动收。
                      shownName === String(row.scope)
                        ? null
                        : h('div', { className: 'mem-scope-key', title: String(row.scope) }, String(row.scope)),
                      item
                        ? h('div', { className: 'mem-scope-state-row' },
                          h('button', {
                            type: 'button',
                            className: `mem-scope-state bind${defaultBound[item.scope] || bound[item.scope] ? ' on' : ''}${defaultBound[item.scope] ? ' locked' : ''}`,
                            'aria-pressed': Boolean(defaultBound[item.scope] || bound[item.scope]),
                            'aria-busy': bindBusy === item.scope,
                            disabled: Boolean(defaultBound[item.scope]) || bindBusy !== '',
                            title: defaultBound[item.scope]
                              ? '默认可见范围已包含（会话 + 项目 + global 默认绑定），无需再绑定'
                              : (bound[item.scope]
                                ? '已绑定到当前工作区（点一下立即解除绑定）：本工作区新会话的默认可见范围会包含它'
                                : '绑定到当前工作区（点一下立即保存，不用再点「保存」）：本工作区新会话的默认可见范围会包含它'),
                            onClick: () => { if (!defaultBound[item.scope]) toggleBound(item.scope) },
                          }, '绑定'),
                          h('span', { className: 'mem-scope-sep', 'aria-hidden': 'true' }),
                          h('button', {
                            type: 'button',
                            className: `mem-scope-state read${perms[item.scope]?.read !== false ? ' on' : ''}`,
                            'aria-pressed': perms[item.scope]?.read !== false,
                            disabled: !entries[item.scope],
                            title: entries[item.scope]
                              ? (perms[item.scope]?.read !== false ? '可读：搜索 / 读取会命中该作用域' : '不可读：搜索 / 读取会跳过该作用域')
                              : (grant ? '这条勾选来自 AI 授权，权限由审批决定；你自己勾选后可改' : '先勾选该作用域再调整可读 / 可写'),
                            onClick: () => togglePerm(item.scope, 'read'),
                          }, '可读'),
                          h('button', {
                            type: 'button',
                            className: `mem-scope-state write${perms[item.scope]?.write !== false ? ' on' : ''}`,
                            'aria-pressed': perms[item.scope]?.write !== false,
                            disabled: !entries[item.scope],
                            title: entries[item.scope]
                              ? (perms[item.scope]?.write !== false ? '可写：保存 / 删除会作用到该作用域' : '不可写：保存 / 删除会被拒绝并告知原因')
                              : (grant ? '这条勾选来自 AI 授权，权限由审批决定；你自己勾选后可改' : '先勾选该作用域再调整可读 / 可写'),
                            onClick: () => togglePerm(item.scope, 'write'),
                          }, '可写'),
                        )
                        : null,
                    )
                  }),
              ),
          grantError ? h('div', { className: 'mem-scope-err' }, grantError) : null,
          error ? h('div', { className: 'mem-scope-err' }, error) : null,
          h('div', { className: 'mem-scope-foot' },
            h('button', {
              type: 'button',
              className: 'mem-scope-reset',
              disabled: busy || !data || data.override === null,
              onClick: () => save(null),
            }, '恢复默认'),
            h('span', { className: 'spacer' }),
            h('button', {
              type: 'button',
              className: 'mem-scope-save',
              disabled: busy || selectedCount === 0,
              onClick: saveDraft,
            }, busy ? '保存中…' : '保存'),
          ),
        ) : null
      return h('span', { className: 'mem-scope-wrap', ref: wrapRef },
        h('button', {
          type: 'button',
          className: `mem-scope-btn is-${buttonLevel}`,
          title: `${sourceText}记忆权限：${scopeCountText} · ${buttonLevelLabel}`,
          'aria-label': `${sourceText}记忆权限，${scopeCountText}，${buttonLevelLabel}`,
          'aria-expanded': open,
          onMouseDown: (event) => { try { event.preventDefault() } catch { /* keepFocus */ } },
          onClick: toggle,
        },
          h(NavLineIcon, { size: 14 }),
          data === null ? null : h('span', null, String(accessibleCount)),
        ),
        popover === null
          ? null
          : (createPortal !== null && portalTarget !== null ? createPortal(popover, portalTarget) : popover),
      )
    }
    /** 0.25.14：全局待审批快照的轮询周期。与审批卡同频，避免黄点比卡片晚太多。 */
    const APPROVAL_PRESENCE_POLL_MS = 1500

    /**
     * 0.25.14：把「本会话正在等待记忆审批」传播成宿主的 pending interaction。
     *
     * 为什么需要它：`MemoryApprovalDock` 只是我们自己画的卡片（conversation.input.dock），
     * 宿主的侧边栏会话列表并不认识它 —— 黄点 /「待审批」/ 自动把会话提到水线以上，
     * 全部来自 `ctx.uiSession` 的 pending interaction 注册表。宿主自己的
     * `dsh-client-ui-approval` 和 `dsh-client-ui-user-questions` 就是通过
     * `registerPendingInteraction` 发布 `kind: 'approval' | 'question'` 的；
     * 我们照抄同一条通道，发布一个**合成 interaction**（kind='approval'）：
     *   - 侧边栏拿到 warning 状态 → 左上角黄点、紧凑文案「待审批」、悬停「等待审批」；
     *   - 其它插件（包括宿主会话本体）也能从 `uiSession.sessionStatus` 读到这个阻塞，
     *     和系统审批 / ask 工具完全同构；
     *   - 它**不是** `PendingApproval` 实例，所以宿主的审批卡片不会抢着渲染它，
     *     我们自己的 dock 仍然是唯一可见的审批 UI。
     *
     * 发布按审批 id 增删（一个会话可能同时有多条），回答 / 超时后由下一次轮询移除。
     * `summary=1` 只拿 id + sessionId，不把正文搬来搬去。
     */
    let approvalPresenceSync = null

    function installApprovalPresence(ctx) {
      if (ctx === null || typeof ctx !== 'object' || typeof ctx.inject !== 'function') return
      try {
        // 不在 apply 里一次性 ctx.get('uiSession')：那会在服务尚未 provide 时拿到
        // undefined 且永不重试（插件冷启动丢注册的老坑）。inject 等就绪后再挂。
        ctx.inject(['uiSession'], (scope) => {
          const uiSession = scope.uiSession
          if (uiSession === null || typeof uiSession !== 'object'
            || typeof uiSession.registerPendingInteraction !== 'function') return
          const publish = uiSession.registerPendingInteraction(() => 0)
          if (typeof publish !== 'function') return

          // approval id → 撤销发布函数。按 id 增删，避免同一会话的多条审批互相顶掉。
          const live = new Map()
          let active = true

          const sync = async () => {
            let value
            try { value = await api('approvals?summary=1') } catch { return }
            if (!active) return
            const list = value && Array.isArray(value.approvals) ? value.approvals : []
            const seen = new Set()
            for (const item of list) {
              if (item === null || typeof item !== 'object') continue
              const id = typeof item.id === 'string' ? item.id : ''
              const sessionId = typeof item.sessionId === 'string' ? item.sessionId : ''
              if (id === '' || sessionId === '' || seen.has(id)) continue
              seen.add(id)
              if (live.has(id)) continue
              try {
                const remove = publish({
                  sessionId,
                  kind: 'approval',
                  key: `memory-approval:${id}`,
                  toolName: typeof item.tool === 'string' && item.tool !== '' ? item.tool : 'memory',
                }, () => {})
                if (typeof remove === 'function') live.set(id, remove)
              } catch { /* 单条发布失败不影响其它会话的提醒 */ }
            }
            for (const [id, remove] of [...live]) {
              if (seen.has(id)) continue
              live.delete(id)
              try { remove() } catch { /* 组件/服务已释放 */ }
            }
          }

          approvalPresenceSync = () => { void sync() }
          void sync()
          let timer
          if (typeof setInterval === 'function') {
            timer = setInterval(() => {
              if (typeof document !== 'undefined' && document.hidden) return
              void sync()
            }, APPROVAL_PRESENCE_POLL_MS)
            // Node 测试环境：不因为一个轮询句柄让进程永不退出；浏览器没有 unref。
            if (timer && typeof timer.unref === 'function') timer.unref()
          }
          const stop = () => {
            if (!active) return
            active = false
            if (timer !== undefined) clearInterval(timer)
            timer = undefined
            approvalPresenceSync = null
            for (const remove of live.values()) { try { remove() } catch { /* 已释放 */ } }
            live.clear()
          }
          try { scope.effect(() => stop, 'dsh-memory: approval presence') } catch { /* 旧宿主没有 effect 时随服务释放 */ }
        })
      } catch { /* 旧宿主没有 ctx.inject：少一个侧边栏提醒，绝不让 client apply 失败 */ }
    }

    /**
     * 普通限制下的「范围外记忆访问审批」卡片(0.21.0)。
     *
     * 工具在 memory_search / memory_get / memory_list 命中可见域外的记录时会在
     * provider 里挂起一个 Promise,这里轮询 /memory/api/approvals 把它显示给用户。
     * 用户点「拒绝 / 允许一次(勾选的 N 条)」→ POST /memory/api/approvals →
     * 工具拿到结论继续。
     *
     * 与 0.20 的区别(对齐系统自带的权限审批弹窗):
     *   - 注册在 conversation.input.dock(会话作用域),不再挂 shell.overlay ——
     *     审批只在它所属的那个会话里出现,切到别的会话看不到,也不会挡住别人的界面;
     *   - 视觉照抄宿主 dsh-client-ui-approval 的审批卡:警告色 strip + 卡片 +
     *     右对齐的「拒绝 / 允许」两个动作,宽高、圆角、底色、阴影都走同一批主题 token;
     *   - 读审批支持逐条勾选:用户只允许其中一条或多条时,工具只放行这些 id,
     *     其余按拒绝处理(withheld.reason='partial')。
     *
     * 轮询按 sessionId 过滤:宿主在切会话时会用新的 sessionId 重新渲染这个槽,
     * 上一个会话的待审批不会串到当前会话。
     */
    function MemoryApprovalDock({ sessionId } = {}) {
      const [approvals, setApprovals] = React.useState([])
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      // approval id → 勾选的条目 id;没有记录 = 默认全选(与「允许一次」同义)。
      const [picked, setPicked] = React.useState({})
      // approval id → 是否折叠了详情(0.22.1)。折叠只藏正文,strip 与动作行仍在,
      // 用户不必展开就能拒绝 / 允许。
      const [collapsed, setCollapsed] = React.useState({})
      const activeRef = React.useRef(true)
      const sessionRef = React.useRef(sessionId)
      sessionRef.current = sessionId

      React.useEffect(() => {
        activeRef.current = true
        return () => { activeRef.current = false }
      }, [])

      const refresh = () => {
        const session = sessionRef.current
        if (typeof session !== 'string' || session === '') return
        api(`approvals?session=${encodeURIComponent(session)}`)
          .then((value) => {
            if (!activeRef.current) return
            const list = Array.isArray(value.approvals) ? value.approvals : []
            // 服务端已按 session 过滤;客户端再兜一层,老 provider 不带 sessionId 时按本会话处理。
            setApprovals(list.filter((item) => item && (item.sessionId === undefined || item.sessionId === '' || item.sessionId === session)))
          })
          .catch(() => { /* 轮询失败静默重试 */ })
      }

      React.useEffect(() => {
        // 切换会话 = 换一张审批卡:清掉上一个会话的待审批与勾选状态。
        setApprovals([])
        setPicked({})
        setCollapsed({})
        setError('')
        setBusy('')
        if (typeof sessionId !== 'string' || sessionId === '') return undefined
        refresh()
        if (typeof setInterval !== 'function') return undefined
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden) return
          refresh()
        }, 1500)
        return () => clearInterval(timer)
      }, [sessionId])

      const pending = approvals.length > 0 ? approvals[0] : null
      if (pending === null) return null

      // 0.20 起写/删也会触发审批,文案按 action 走。
      const action = pending.action === 'write' || pending.action === 'delete' ? pending.action : 'read'
      // 0.24.0：grant 模式 = 作用域权限申请，不是记忆条目审批。
      const grantMode = pending.mode === 'grant'
      const actionLabel = grantMode ? '访问' : action === 'write' ? '写入' : action === 'delete' ? '删除' : '读取'
      const actionHint = grantMode
        ? 'Agent 申请访问可见域外的作用域。勾选要授予的权限（默认只读）；授权仅在本会话有效，子 Agent 会继承。'
        : action === 'write'
          ? 'Agent 想把一条记忆写入可见域外的作用域。允许只对本次调用生效；拒绝则不写入。'
          : action === 'delete'
            ? 'Agent 想删除可见域外的记忆。允许只对本次调用生效；拒绝则不删除。'
            : '以下记忆不在本会话的可见域内。勾选要允许的条目（默认全选）；允许只对本次调用生效，其余条目不会返回。'
      const items = Array.isArray(pending.items) ? pending.items : []
      // 模型写的用途说明(0.22.0;普通限制下工具层强制提供)。
      const description = typeof pending.description === 'string' ? pending.description.trim() : ''
      const allIds = items.map((item) => item.id)
      // grant 模式默认只勾只读项（写权限必须用户主动勾）；普通读审批默认全选。
      const defaultIds = grantMode
        ? items.filter((item) => item.grantPermission !== 'write').map((item) => item.id)
        : allIds
      // 多条目才有逐条勾选的意义；grant 模式下 even 1 条也走勾选以明确权限。
      const selectable = grantMode ? allIds.length > 0 : action === 'read' && allIds.length > 1
      const stored = Array.isArray(picked[pending.id]) ? picked[pending.id].filter((id) => allIds.includes(id)) : null
      const selectedIds = stored === null ? defaultIds : stored
      const selectedSet = new Set(selectedIds)
      const selectedCount = selectedIds.length

      const toggle = (itemId) => {
        setPicked((prev) => {
          const current = Array.isArray(prev[pending.id]) ? prev[pending.id].filter((id) => allIds.includes(id)) : [...defaultIds]
          const next = current.includes(itemId) ? current.filter((id) => id !== itemId) : [...current, itemId]
          return { ...prev, [pending.id]: next }
        })
      }

      // 折叠只藏详情(列表 / 说明),strip 与动作行保留 —— 折叠状态下仍可审批。
      const isCollapsed = collapsed[pending.id] === true
      const toggleCollapse = () => setCollapsed((prev) => ({ ...prev, [pending.id]: !prev[pending.id] }))

      // 逐条勾选之外的批量操作:全选 / 取消全选(0.22.0)。
      const selectAll = () => setPicked((prev) => ({ ...prev, [pending.id]: [...allIds] }))
      const clearAll = () => setPicked((prev) => ({ ...prev, [pending.id]: [] }))

      const answer = (outcome, ids) => {
        if (busy === pending.id) return
        setBusy(pending.id)
        setError('')
        const body = { id: pending.id, outcome }
        // 全选 = 老口径(不带 allowedIds,覆盖本次请求全部条目);
        // 只勾了一部分才把选中集合传回去。
        if (outcome === 'allowed-once' && selectable && Array.isArray(ids) && ids.length > 0 && ids.length < allIds.length) {
          body.allowedIds = ids
        }
        api('approvals', body)
          .then(() => {
            setApprovals((prev) => prev.filter((item) => item.id !== pending.id))
            setPicked((prev) => {
              const next = { ...prev }
              delete next[pending.id]
              return next
            })
            // 立刻撤销侧边栏黄点，不必等下一次 1.5s 轮询。
            if (approvalPresenceSync !== null) approvalPresenceSync()
          })
          .catch((e) => setError(String((e && e.message) || e)))
          .finally(() => setBusy(''))
      }
      const allow = () => {
        if (selectable && selectedCount === 0) return
        answer('allowed-once', selectable ? allIds.filter((id) => selectedSet.has(id)) : undefined)
      }

      const keydown = (event) => {
        if (event.defaultPrevented || busy === pending.id) return
        const target = event.target
        if (target && typeof target.closest === 'function') {
          if (target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]') !== null) return
          if (event.key === 'Enter' && target.closest('button, a[href], [role="button"]') !== null) return
        }
        if (event.key !== 'Enter' && event.key !== 'Escape') return
        if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
        event.preventDefault()
        event.stopPropagation()
        if (event.key === 'Escape') {
          answer('rejected')
          return
        }
        allow()
      }

      const allowLabel = busy === pending.id
        ? '处理中…'
        : grantMode && selectable && selectedCount !== allIds.length
          ? `允许选中的 ${selectedCount} 项（本会话）`
          : grantMode
            ? '允许授权（本会话）'
            : selectable && selectedCount !== allIds.length
              ? `允许选中的 ${selectedCount} 条`
              : '允许一次'

      return h('div', {
        className: 'mem-approval',
        'data-approval-id': pending.id,
        onKeyDown: keydown,
      },
        h('div', { className: 'mem-approval-card', role: 'dialog', 'aria-label': grantMode ? '记忆访问授权审批' : `记忆${actionLabel}审批`, 'aria-busy': busy === pending.id },
          h('div', { className: 'mem-approval-strip' },
            h('span', { className: 'mem-approval-dot' }),
            h('span', null, busy === pending.id ? '处理中…' : '等待审批'),
            h('span', { className: 'mem-approval-tool' }, pending.tool || 'memory'),
            h('span', { className: 'spacer' }),
            selectable && isCollapsed ? h('span', { className: 'muted' }, `已选 ${selectedCount}/${allIds.length}`) : null,
            approvals.length > 1 ? h('span', { className: 'muted' }, `还有 ${approvals.length - 1} 个待审批`) : null,
            h('button', {
              type: 'button',
              className: 'mem-approval-toggle',
              'aria-expanded': !isCollapsed,
              'aria-label': isCollapsed ? '展开审批详情' : '折叠审批详情',
              title: isCollapsed ? '展开审批详情' : '折叠审批详情（折叠后仍可直接允许 / 拒绝）',
              onClick: toggleCollapse,
            }, isCollapsed ? '展开' : '折叠'),
          ),
          isCollapsed
            ? null
            : h('div', { className: 'mem-approval-body' },
                h('div', { className: 'mem-approval-headline' }, grantMode
                  ? `工具 ${pending.tool || 'memory'} 申请访问可见域外的作用域`
                  : `工具 ${pending.tool || 'memory'} 请求${actionLabel}可见域外的记忆`),
                h('div', { className: 'mem-approval-hint' }, actionHint),
                h('div', { className: 'mem-approval-command' }, grantMode
                  ? `申请理由：${pending.query || '（未提供）'}`
                  : `Agent 查询：${pending.query || '（未提供）'}`),
                description !== ''
                  ? h('div', { className: 'mem-approval-desc', title: description }, `Agent 说明：${description}`)
                  : null,
                selectable
                  ? h('div', { className: 'mem-approval-bulk' },
                      h('span', null, `已选 ${selectedCount} / ${allIds.length}`),
                      h('span', { className: 'spacer' }),
                      h('button', {
                        type: 'button',
                        disabled: busy === pending.id || selectedCount === allIds.length,
                        onClick: selectAll,
                      }, '全选'),
                      h('button', {
                        type: 'button',
                        disabled: busy === pending.id || selectedCount === 0,
                        onClick: clearAll,
                      }, '取消全选'),
                    )
                  : null,
                h('div', { className: 'mem-approval-list' },
                  items.map((item) => {
                    const checked = !selectable || selectedSet.has(item.id)
                    return h('div', {
                      className: 'mem-approval-item'
                        + (selectable && !checked ? ' is-off' : '')
                        + (selectable ? ' is-clickable' : ''),
                      key: item.id,
                      // 整行可点选(0.22.1):不必非要点中那个小勾选框;按钮各自 stopPropagation。
                      ...(selectable
                        ? {
                          onClick: () => toggle(item.id),
                          title: checked ? '点击取消选择这条记忆' : '点击选择这条记忆',
                        }
                        : {}),
                    },
                      selectable
                        ? h('button', {
                          type: 'button',
                          className: 'mem-approval-check' + (checked ? ' on' : ''),
                          role: 'checkbox',
                          'aria-checked': checked,
                          'aria-label': grantMode ? `允许这项权限 ${item.id}` : `允许这条记忆 ${item.id}`,
                          onClick: (event) => {
                            if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                            toggle(item.id)
                          },
                        }, h('span', { className: 'box' }, checked ? h('span', { className: 'tick' }, '✓') : null))
                        : null,
                      h('div', { className: 'mem-approval-item-body' },
                        h('div', { className: 'mem-approval-row' },
                          !grantMode && action === 'read'
                            ? h('button', {
                              type: 'button',
                              className: 'mem-approval-id',
                              title: '在记忆面板中查看并展开这条记忆',
                              'aria-label': `在记忆面板中查看记忆 ${item.id}`,
                              // 点击 → 主面板「记录」页:切 tab、定位、展开并滚到这条(0.22.0)。
                              onClick: (event) => {
                                if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                                openMemoryRecordPanel(item.id, item.scope, item)
                              },
                            }, String(item.id).length > 12 ? `${item.id.slice(0, 8)}…${item.id.slice(-4)}` : String(item.id))
                            : h('span', { className: 'mem-approval-id', title: item.id }, grantMode
                              ? (item.grantPermission === 'write' ? '可写' : '只读')
                              : (String(item.id).length > 12 ? `${item.id.slice(0, 8)}…${item.id.slice(-4)}` : String(item.id))),
                          // 作用域显示名带类型前缀;title 里给出「显示名 → 真实键」。
                          h('span', { className: 'audit-pill mute', title: scopeTitle(item.scope, scopeLabel(item.scope)) }, scopeLabel(item.scope)),
                          grantMode
                            ? h('span', { className: 'audit-pill mute' }, item.grantPermission === 'write' ? '写入 / 删除' : '只读访问')
                            : h('span', { className: 'audit-pill mute' }, item.kind ? kindMeta(item.kind).label : '未知'),
                          grantMode
                            ? h('span', { className: 'audit-pill warn' }, '本会话授权')
                            : item.reason === 'kind'
                              ? h('span', { className: 'audit-pill warn' }, '类型受限')
                              : h('span', { className: 'audit-pill warn' }, '范围外'),
                        ),
                        h('div', { className: 'mem-approval-summary' }, grantMode
                          ? (item.grantPermission === 'write' ? '允许新增、修改与删除该作用域的记录' : '允许查询与读取该作用域的正文')
                          : String(item.content || '').replace(/\s+/g, ' ').slice(0, 180)),
                      ),
                    )
                  }),
                ),
              ),
          error ? h('div', { className: 'mem-approval-err' }, error) : null,
          h('div', { className: 'mem-approval-actionrow' },
            h('button', {
              type: 'button',
              className: 'mem-approval-reject',
              disabled: busy === pending.id,
              onClick: () => answer('rejected'),
            }, '拒绝'),
            h('button', {
              type: 'button',
              className: 'mem-approval-allow',
              disabled: busy === pending.id || (selectable && selectedCount === 0),
              onClick: allow,
            }, allowLabel),
          ),
        ),
      )
    }

    function apply(ctx) {
      try {
        const styleEl = document.createElement('style')
        styleEl.textContent = CSS
        document.head.appendChild(styleEl)
        // 侧栏那一行的图标:宿主写死了齿轮,我们只改它 SVG 的孩子(见 wrapSettingsNav)
        const stopNavWatch = wrapSettingsNav()
        ctx.effect(() => () => { styleEl.remove(); stopNavWatch() }, 'dsh-memory: styles + nav icon')

        // 0.25.14：侧边栏黄点提示（独立于 slots；旧宿主没有 uiSession 时静默跳过）。
        installApprovalPresence(ctx)

        const slots = ctx.get('slots')
        if (slots === undefined) return
        clientCtx = ctx

        /** 宿主 uiWorkspace 服务：打开会话 / 读取会话摘要（旧宿主缺失时静默降级）。 */
        const workspaceService = () => {
          try { return ctx.get('uiWorkspace') } catch { return undefined }
        }
        const openSession = (id) => {
          try {
            const workspace = workspaceService()
            if (workspace && typeof workspace.openSession === 'function') {
              workspace.openSession(id)
              return
            }
            // 没有 uiWorkspace（极旧宿主/独立预览）时退回 hash 路由；不保证宿主识别。
            if (typeof window !== 'undefined') window.location.hash = `#/s/${encodeURIComponent(id)}`
          } catch (error) {
            console.warn('[dsh-memory] 打开会话失败:', error?.message)
          }
        }
        const sessionInfo = (id) => {
          try {
            const workspace = workspaceService()
            const summary = workspace?.sessions?.list?.getSnapshot?.()?.byId?.[id]
            if (summary !== undefined) return summary
            const session = ctx.get('sessions')?.get?.(id)
            if (session === undefined) return undefined
            return session.summary ?? session
          } catch {
            return undefined
          }
        }

        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'memory', order: 24, label: NAV_LABEL },
          () => React.createElement(MemoryPanel, {
            openSession,
            sessionInfo,
            audience: 'panel',
          }),
        ))

        // 侧栏入口(可选):开启后在左侧栏「插件」下方多一个「记忆系统」,点击在主界面打开面板。
        // 注册契约见 dsh-client-ui-schedule:sidebar.panellist 给 id/label/icon,main 用同一个 key。
        let sidebarDisposers = null
        const syncSidebar = () => {
          api('settings').then((settings) => {
            const want = Boolean(settings && settings.sidebar && settings.sidebar.enabled)
            if (want === (sidebarDisposers !== null)) return
            if (!want) {
              for (const dispose of sidebarDisposers ?? []) {
                try { if (typeof dispose === 'function') dispose() } catch { /* 已卸载 */ }
              }
              sidebarDisposers = null
              return
            }
            try {
              sidebarDisposers = [
                slots.inject('main', () => slots.register({ name: 'main', key: 'memory' }, () => React.createElement(MemoryPage, {
                  openSession,
                  sessionInfo,
                }))),
                slots.inject('sidebar.panellist', () => slots.register(
                  { name: 'sidebar.panellist', id: 'memory', order: 20, label: () => NAV_LABEL },
                  () => React.createElement(NavLineIcon),
                )),
              ]
            } catch (error) {
              sidebarDisposers = null
              console.warn('[dsh-memory] 侧栏入口注册失败:', error?.message)
            }
          }).catch(() => { /* 读不到设置就维持现状 */ })
        }
        syncSidebar()
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          window.addEventListener('dsh-memory:settings', syncSidebar)
          ctx.effect(() => () => window.removeEventListener('dsh-memory:settings', syncSidebar), 'dsh-memory: sidebar entry')
        }

        // ===== 会话轨迹 / 视图环 / 浮层集成 =====
        // 每一条都单独兜底：宿主没有这个槽（旧版本/精简组合）时只是少一个入口，
        // 绝不能让整个 client apply 失败。
        try {
          slots.inject('conversation.view', () => slots.register({
            name: 'conversation.view',
            id: 'memory',
            order: 20,
            label: () => '记忆',
            inject: (sessionId) => ({ sessionId, sessionInfo }),
          }, MemoryAuditView))
        } catch (error) {
          console.warn('[dsh-memory] 记忆审计视图注册失败:', error?.message)
        }
        // 输入框工具行右侧:本会话「记忆权限」按钮。session 作用域的 list 槽,
        // owner 会把 sessionId 作为标准 prop 传进来;旧宿主没有这个槽时只少一个入口。
        try {
          slots.inject('conversation.input.right', () => slots.register({
            name: 'conversation.input.right',
            id: 'memory-visibility',
            order: 30,
            label: () => '记忆权限',
          }, MemoryVisibilityButton))
        } catch (error) {
          console.warn('[dsh-memory] 记忆可见范围按钮注册失败:', error?.message)
        }
        try {
          slots.inject('shell.overlay', () => slots.register({
            name: 'shell.overlay',
            id: 'memory-audit-marks',
            order: 59,
          }, () => React.createElement(TrajectoryMemoryMarks)))
        } catch (error) {
          console.warn('[dsh-memory] 轨迹行记忆标记注册失败:', error?.message)
        }
        try {
          slots.inject('shell.overlay', () => slots.register({
            name: 'shell.overlay',
            id: 'memory-audit-badge',
            order: 60,
          }, () => React.createElement(TrajectoryMemoryBadge)))
        } catch (error) {
          console.warn('[dsh-memory] 轨迹记忆徽标注册失败:', error?.message)
        }
        try {
          slots.inject('shell.overlay', () => slots.register({
            name: 'shell.overlay',
            id: 'memory-audit-detail',
            order: 61,
          }, () => React.createElement(TrajectoryDetailAudit)))
        } catch (error) {
          console.warn('[dsh-memory] 轨迹详情记忆页签注册失败:', error?.message)
        }
        // 普通限制下的范围外访问审批卡:会话作用域(conversation.input.dock),
        // 只在它所属的那个会话里出现;组件按标准 sessionId prop 轮询本会话待审批。
        try {
          slots.inject('conversation.input.dock', () => slots.register({
            name: 'conversation.input.dock',
            id: 'memory-access-approval',
            order: 40,
          }, MemoryApprovalDock))
        } catch (error) {
          console.warn('[dsh-memory] 记忆访问审批卡注册失败:', error?.message)
        }
      } catch (error) {
        console.error('[dsh-memory] client apply 失败(已吞掉):', error?.message)
      }
    }

    /**
     * 侧栏这一行的显示名。导航图标覆盖靠"认出自己那一行"来定位,所以文案必须只有一处,
     * 注册与识别共用这个常量(改文案时不会漏改)。
     */
    const NAV_LABEL = '记忆系统'

    /**
     * 设置侧栏「记忆系统」那一行的图标 —— 与侧栏入口、插件列表共用同一只年轮。
     *
     * 宿主把导航图标写死在 `dsh-client-ui-settings-general` 的 `navIcon(id)` 里:只有
     * account / models / agent-presets / plugins / archived-sessions 五个 id 有专属图标
     * (`IconUserOutlineMedium` 等),其余(包括我们的 `memory`)一律回退成**齿轮**
     * `IconSettingsOutlineMedium`。`settings.section` 的注册契约是
     * `{ name, id, order, label, locale, inject }` —— **没有 icon 字段**,宿主也不读插件包
     * `package.json` 的 `icon`(那个只用于插件管理器的卡片/行),所以插件侧没有任何
     * "官方指定图标"的入口。
     *
     * 因此只有一条路:用宿主自己的类名做一次**定向覆盖** —— 把那颗齿轮**就地**换成我们的
     * 记号。三条护栏让它不会把界面弄坏:
     *   1. 选择器只认 className 的**后缀**:宿主的类名是 CSS Modules 生成的
     *      `<hash>_navCell` / `<hash>_navIcon`(hash 随构建变),所以用
     *      `[class*="_navIcon"]` 匹配,hash 变了也照样命中;
     *   2. 只在**我们这一行**生效:wrapSettingsNav 给"文案等于 `NAV_LABEL`"的那个按钮加
     *      `dsh-memory-nav` 标记类,规则全部限定在它下面 —— 其它区块(账号/模型/插件市场)
     *      的图标一个都不碰。标记打在**按钮自己**身上而不是它所在的列表上:整列共用一个
     *      列表容器,标在容器上会波及所有区块。
     *   3. **不改布局、不插 DOM**:那颗 svg 还是宿主自己渲染的,我们只把它内部换成线稿,
     *      盒子尺寸/行高/对齐全由宿主保证。
     *
     * 记号必须和这一列**同一规范**:16 网格、`fill:none`、`stroke:currentColor`、1.3 描边。
     * 0.5.3/0.5.4 塞过蓝色瓦片,0.9.3 塞过深咖年轮瓦片 —— 在那个单色列里都是一块实心
     * 色块,和旁边的线稿不一致。0.9.4 起画成**年轮线稿**:圆角瓦片轮廓 + 1.75 圈螺旋,
     * 形状仍来自插件美术,但颜色只跟 currentColor,深浅主题自动适配。
     *
     * 实现:把宿主那颗 svg 的**子节点**换成线稿(viewBox 保持 16 网格)。三条被否掉的
     * 路,留给后来人:
     *   - `::before` 补一个(0.5.3):真机上盒子没成形 —— 齿轮没了、记号也没出现,空一格;
     *   - 给 svg 上背景图(0.5.4):能画出来,但只能画色块,画不出 1.3 描边的线稿;
     *   - `content: url(...)` 替换 svg 内容:SVG 元素不支持 content 替换,实测无效。
     * 换子节点这条路的失败模式是良性的:svg 由宿主渲染,我们只动它的孩子,尺寸/对齐/行高
     * 一定由宿主保证;万一类名约定变了,选中不到就没有任何改动,图标保持原样。
     * React 若重渲染把图形覆盖回去,observer 会在下一轮按子节点重新补上。
     */
    const NAV_DOM = [
      { tag: 'rect', attrs: { ...NAV_FRAME, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.3' } },
      { tag: 'path', attrs: { d: NAV_RING, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.3', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'data-dsh-memory-logo': '1' } },
    ]

    /** 递归建 SVG 节点(不用 innerHTML:避开宿主 CSP,也避免命名空间被字符串解析弄丢)。 */
    function svgNode({ tag, attrs, children }) {
      const node = document.createElementNS(NAV_ICON_NS, tag)
      for (const [name, value] of Object.entries(attrs ?? {})) node.setAttribute(name, String(value))
      for (const child of children ?? []) node.appendChild(svgNode(child))
      return node
    }

    /** 把一颗 nav 图标的图形换成年轮线稿;已经是线稿就跳过(observer 会反复调到这里)。 */
    function paintNavIcon(svg) {
      if (svg.querySelector('[data-dsh-memory-logo]') !== null) return
      svg.setAttribute('viewBox', NAV_VIEW_BOX)
      svg.replaceChildren(...NAV_DOM.map(svgNode))
    }

    /**
     * 在"含「记忆系统」那一行"上做记号并换图。
     *
     * 关键:记号打在**按钮自己**身上,绝不打在父级 navList 上 —— 整列是同一个容器,
     * 打到父级等于给所有区块都加图标。面板随时可能卸载/重挂(它是 body 上的 portal),
     * 所以用 MutationObserver 跟着 DOM 走;识别依据是**这一行的文案**(trim 后比对),
     * 不依赖任何类名 —— 类名约定变了只是什么都不做,图标保持宿主原样。
     */
    function wrapSettingsNav() {
      const mark = () => {
        try {
          for (const cell of document.querySelectorAll('[class*="_navCell"]')) {
            const label = (cell.textContent ?? '').trim()
            if (label !== NAV_LABEL) continue
            cell.classList?.add('dsh-memory-nav')
            const icon = cell.querySelector('[class*="_navIcon"]')
            if (icon) paintNavIcon(icon)
          }
        } catch { /* 换图失败:图标保持宿主原样 */ }
      }
      mark()
      const observer = new MutationObserver(mark)
      observer.observe(document.body, { childList: true, subtree: true })
      return () => observer.disconnect()
    }

    exports.apply = apply
    exports.inject = inject
    // exported for the render smoke test only (host/bundler never reads it),
    // same convention as the official dsh-meme client
    /**
     * Should the panel keep polling the status endpoint?
     *
     * Two cases, and the second one is the reason this is a named function: the
     * provider's start() is fire-and-forget, so the status returned immediately
     * after POST /embed/install can still say 'idle'. Polling only while a phase
     * is in flight would then never show any progress at all.
     */
    function shouldPollInstall(phase, requested) {
      const running = phase !== 'idle' && phase !== 'done' && phase !== 'error'
      return running || (requested === true && phase === 'idle')
    }

    exports.__test = {
      RecordCard: RecordCard,
      MemoryPanel: MemoryPanel,
      MemoryTreeTab: MemoryTreeTab,
      SettingsTab: SettingsTab,
      AuditTab: AuditTab,
      MemoryVisibilityButton: MemoryVisibilityButton,
      MemoryApprovalDock: MemoryApprovalDock,
      // 0.25.14：侧边栏阻塞提示的发布器（测试直接驱动，不等真实 1.5s 定时器）。
      installApprovalPresence: installApprovalPresence,
      approvalPresenceSync: () => approvalPresenceSync,
      openMemoryRecordPanel: openMemoryRecordPanel,
      requestRecordFocus: requestRecordFocus,
      takeRecordFocus: takeRecordFocus,
      buildMemoryTree: buildMemoryTree,
      // 会话作用域展示名:取会话 id 前 16 位(前 8 位恒为 `session-`)
      sessionShortId: sessionShortId,
      scopeDisplayName: scopeDisplayName,
      scopeTypePrefix: scopeTypePrefix,
      scopeTitle: scopeTitle,
      scopeLabel: scopeLabel,
      KIND_META: KIND_META,
      CSS: CSS,
      shouldPollInstall: shouldPollInstall,
      // 图标一致性护栏:测试会核对两条渲染路径都是同一份 16px 单色线稿
      NavLineIcon: NavLineIcon,
      NAV_DOM: NAV_DOM,
      paintNavIcon: paintNavIcon,
      // 审计 ↔ 轨迹桥（测试只覆盖纯解析/焦点总线，不碰宿主 slot 实例）
      MemoryAuditView: MemoryAuditView,
      TrajectoryMemoryBadge: TrajectoryMemoryBadge,
      TrajectoryMemoryMarks: TrajectoryMemoryMarks,
      TrajectoryDetailAudit: TrajectoryDetailAudit,
      auditEntryCallId: auditEntryCallId,
      trajectoryRowCallId: trajectoryRowCallId,
      requestAuditFocus: requestAuditFocus,
      takeAuditFocus: takeAuditFocus,
      conversationStoreFor: conversationStoreFor,
      setConversationView: setConversationView,
      setClientCtx: (value) => { clientCtx = value },
    }
    return module.exports
  },
})
