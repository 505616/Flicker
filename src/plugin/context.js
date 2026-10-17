/**
 * 插件上下文（`ctx`）
 * ====================
 * 插件拿到的就是这一个对象。设计取舍只有一条最重要：
 *
 *   **插件做的每件事都必须能回收。**
 *
 * 这个程序的承诺是"所有传输用到的东西都是一次性的，用完就销毁"。
 * 插件要是能在进程里留下一个定时器、一个监听端口、一条常驻连接，
 * 那句承诺就只对核心代码成立、对插件不成立 —— 而用户根本分不清哪个是哪个。
 * 所以 `ctx.effect()` 是唯一的"做副作用"的入口：它当场执行，
 * 并把返回的清理函数登记进销毁链（`src/run.js` / `src/relay/run-relay.js`
 * 的销毁清单里那一步「插件资源已释放」）。
 *
 * 另一条同样重要：**拼错的名字要当场报错。**
 * `ctx.on('manifset/scanned')` 如果只是"永远收不到事件"，插件作者会以为
 * 自己的代码没被调用，去查自己的 bug —— 这类静默失败在这个项目里出过太多次。
 */
import { API_VERSION, KNOWN_EVENTS, KNOWN_SLOTS, SYNC_EVENTS, PLANE_OF, hooksOfPlane } from './events.js'

/**
 * 给一个插件建上下文。
 *
 * @param {object} registry 注册表（见 registry.js）
 * @param {{name:string, version?:string, file:string}} decl 插件的声明信息
 * @param {{event?:(name:string)=>void, effect?:()=>void}} [record] 记账钩子
 *   （`--plugins` 与销毁清单要显示"这个插件订阅了什么、登记了几个副作用"）
 * @returns {{ctx:object, dispose:() => Promise<{ran:number, failed:string[]}>}}
 */
export function createPluginContext(registry, decl, record = {}) {
  const disposers = []
  const offs = []
  let disposed = false

  /** 报错一律带上插件名 —— 用户要一眼看出是谁的问题 */
  const fail = (msg) => { throw new Error(`插件 ${decl.name}：${msg}`) }

  /**
   * 拦"用错平面"。
   *
   * 《插件.md》一直写着"插件在哪个平面被加载就只能用哪个平面的钩子 —— 用错了会当场报错"，
   * 而在 2026-10 之前**只拦了拼错的名字**：一个中继插件订阅 `run/start` 会安静地
   * 什么都不发生（它以为自己在工作）。加了接收平面之后这种混用更容易发生
   * （四个平面、19 个钩子），所以把它做成真的判据。
   *
   * `registry.planes` 为 null 时不检查 —— 那是 `--plugins` 的"只列出、不运行"，
   * 它要能加载**任意平面**的插件来告诉你"你写的对不对"。
   */
  const checkPlane = (name) => {
    const allowed = registry.planes
    if (!allowed) return
    const own = PLANE_OF.get(name)
    if (allowed.includes(own)) return
    const ok = allowed.flatMap((p) => hooksOfPlane(p))
    fail(`"${name}" 属于「${own}」平面，而这次只允许「${allowed.join('、')}」平面的钩子 —— ` +
      `用错平面的钩子永远不会被触发，所以这里直接报错。` +
      `可用：${ok.length ? ok.join(' / ') : '（没有）'}`)
  }

  const ctx = {
    /** 插件名（来自它自己的声明，不是文件名） */
    name: decl.name,
    /** 插件自报的版本（可选，仅用于显示） */
    version: decl.version ?? null,
    /** 本程序提供的插件 API 版本 */
    apiVersion: API_VERSION,
    /** 运行时信息（只读） */
    info: Object.freeze({
      flicker: registry.flickerVersion,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    }),

    /** 输出一行 —— 会带上插件名前缀，用户能看清是谁在说话 */
    log(text) { registry.pluginLog(decl.name, String(text)) },

    /**
     * 订阅一个事件。
     * @param {string} event 见 `EVENTS`（拼错会当场报错）
     * @param {Function} fn 处理函数；同步事件必须同步完成
     * @returns {Function} 取消订阅（也可以不管它 —— 销毁时会自动取消）
     */
    on(event, fn) {
      if (!KNOWN_EVENTS.has(event)) {
        fail(`订阅了不存在的事件 "${event}"（可用：${[...KNOWN_EVENTS].join(' / ')}）`)
      }
      checkPlane(event)
      if (typeof fn !== 'function') fail(`事件 ${event} 的处理函数必须是个函数`)
      const off = registry.subscribe(event, decl.name, fn)
      offs.push(off)
      record.event?.(event)
      return off
    },

    /**
     * 往一个贡献点里加东西。
     * @param {string} slot 见 `SLOTS`
     * @param {Function} fn 返回贡献值；可以是值、数组或 undefined
     */
    contribute(slot, fn) {
      if (!KNOWN_SLOTS.has(slot)) {
        fail(`用了不存在的贡献点 "${slot}"（可用：${[...KNOWN_SLOTS].join(' / ')}）`)
      }
      checkPlane(slot)
      if (typeof fn !== 'function') fail(`贡献点 ${slot} 必须给一个函数`)
      registry.addContribution(slot, decl.name, fn)
      record.event?.(slot)
    },

    /**
     * 注册一个**可回收的副作用**：立刻执行 `setup()`，
     * 把它返回的清理函数登记进销毁链。
     *
     * ```js
     * ctx.effect(() => {
     *   const srv = http.createServer(handler).listen(0)
     *   return () => srv.close()          // ← 销毁时一定会被调用
     * })
     * ```
     *
     * ⚠️ 允许返回 `undefined`（表示"这一步没有需要清理的东西"）——
     *    但那就等于放弃回收，只在该副作用确实没有残留时才这么写。
     *
     * @param {Function} setup
     * @returns {*} `setup()` 的返回值（方便 `const x = ctx.effect(…)`）
     */
    effect(setup) {
      if (typeof setup !== 'function') fail('ctx.effect 需要一个函数')
      const out = setup()
      if (typeof out === 'function') disposers.push(out)
      else if (out && typeof out.dispose === 'function') disposers.push(() => out.dispose())
      record.effect?.()
      return out
    },

    /** 是否已经释放过（销毁链跑过之后为 true） */
    get disposed() { return disposed },
  }

  return {
    ctx,
    /** 逆序释放：后建的东西先拆（与栈的直觉一致），一个失败不影响其余 */
    async dispose() {
      if (disposed) return { ran: 0, failed: [] }
      disposed = true
      let ran = 0
      const failed = []
      for (const off of offs.reverse()) {
        try { off() } catch (e) { failed.push(`取消订阅失败：${e?.message ?? e}`) }
      }
      for (const fn of disposers.reverse()) {
        try { await fn(); ran++ } catch (e) { failed.push(`${e?.message ?? e}`) }
      }
      return { ran, failed }
    },
  }
}
