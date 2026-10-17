/**
 * 接收端页面的插件运行时（页面平面）
 * ==================================
 * 这个文件**会被原样内联进 `web/receiver.html`**（见 `gen/inline-plugins.mjs`），
 * 所以它必须是**浏览器能直接跑的纯 JS**：
 *   · 不许 `import` / `require` / `module.exports`；
 *   · 不许用 Node 专有 API（`process`、`Buffer`、`fs`…）；
 *   · 不许假设打包器/转译器存在。
 * 内联脚本会硬检查这几条（有人加了 import 就直接拒绝构建）。
 *
 * ── 为什么页面插件的错误**不能中断传输**（与另外两个平面相反）──
 * 发送端与中继上，插件出错就中止（那是"你显式要求的东西没做成"，必须说清楚）。
 * 但接收端页面不同：**这里是对方正在收文件**。插件是发送端/部署方装的扩展，
 * 它出错时把整场传输打断，受害的是那个只想把文件收下来的人。
 * 所以这里的选择是：**吞掉异常、如实记下来、继续跑**。
 * 记录同时进 console 与页面上的插件区域，不会"悄悄消失"。
 *
 * ── 为什么钩子名是"域/动作"两段式 ──
 * 与另外两个平面一致（`run/start`、`relay/route`…），
 * `gen/check-plugin-doc.mjs` 会把这里的清单与两份《插件.md》对齐。
 */

/** 本运行时提供的插件 API 版本（与另外两个平面各自独立，但语义相同） */
export const PAGE_API_VERSION = 1

/** 页面平面的钩子（改这里要同时改两份 插件.md，判据会拦） */
export const PAGE_HOOKS = [
  'page/ready',
  'recv/verified',
  'recv/file-done',
  'recv/complete',
]

/** 页面平面的贡献点 */
export const PAGE_SLOTS = [
  'page/actions',
]

/**
 * 建一个页面侧注册表。
 *
 * @param {object} [env] 注入的运行环境（测试用；默认用全局的 window/document）
 */
export function createPagePlugins(env = {}) {
  const win = env.window ?? globalThis
  const doc = env.document ?? globalThis.document
  const console_ = env.console ?? globalThis.console ?? { log() {}, warn() {} }

  const listeners = new Map()
  const slots = new Map()
  const loaded = []
  const errors = []

  const fail = (decl, msg) => {
    errors.push(`插件 ${decl?.name ?? '?'}：${msg}`)
    // ⚠️ 必须显式 return false：`errors.push(...)` 的返回值是**新长度**（一个数字），
    //    直接 `return errors.push(...)` 会让"注册失败"看起来像成功（真踩过：apiVersion
    //    不匹配时 register 返回 1，测试里 `assert.equal(ok, false)` 当场露馅）。
    return false
  }

  /** 记一笔（同时 console + 页面区域），不抛错 */
  const note = (text) => {
    errors.push(text)
    try { console_.warn('[Flicker 页面插件] ' + text) } catch { /* 控制台都没了就没办法 */ }
  }

  const api = {
    apiVersion: PAGE_API_VERSION,

    /** 由内联进去的插件代码调用 */
    register(decl) {
      if (!decl || typeof decl !== 'object') return fail(decl, '应当传 { name, apiVersion, apply }')
      if (typeof decl.name !== 'string' || !decl.name.trim()) return fail(decl, '缺少 name')
      if (decl.apiVersion !== undefined && decl.apiVersion !== PAGE_API_VERSION) {
        return fail(decl, `要 API 版本 ${decl.apiVersion}，而页面提供的是 ${PAGE_API_VERSION}`)
      }
      if (typeof decl.apply !== 'function') return fail(decl, '缺少 apply(ctx)')

      const rec = { name: decl.name.trim(), version: decl.version ?? null, effects: 0 }
      const disposers = []
      const ctx = {
        name: rec.name,
        version: rec.version,
        apiVersion: PAGE_API_VERSION,
        info: Object.freeze({ page: 'receiver', hooks: PAGE_HOOKS.length }),
        log: (text) => { try { console_.log(`[页面插件 ${rec.name}] ${text}`) } catch { /* 忽略 */ } },
        on(event, fn) {
          if (!PAGE_HOOKS.includes(event)) {
            // 与另外两个平面一致：拼错名字要当场说清楚（这里是记下来并抛出，
            // 由 register 外面那层 catch 收走 —— 页面上不能因为插件写错就白屏）
            throw new Error(`插件 ${rec.name}：订阅了不存在的事件 "${event}"（可用：${PAGE_HOOKS.join(' / ')}）`)
          }
          if (typeof fn !== 'function') throw new Error(`插件 ${rec.name}：${event} 的处理函数必须是函数`)
          const list = listeners.get(event) ?? []
          list.push({ plugin: rec.name, fn })
          listeners.set(event, list)
        },
        contribute(slot, fn) {
          if (!PAGE_SLOTS.includes(slot)) {
            throw new Error(`插件 ${rec.name}：用了不存在的贡献点 "${slot}"（可用：${PAGE_SLOTS.join(' / ')}）`)
          }
          const list = slots.get(slot) ?? []
          list.push({ plugin: rec.name, fn })
          slots.set(slot, list)
        },
        /** 页面没有"销毁链"，但保留同样的写法：返回值当清理函数，页面卸载时调用 */
        effect(setup) {
          const out = setup()
          if (typeof out === 'function') disposers.push(out)
          rec.effects++
          return out
        },
      }

      try {
        decl.apply(ctx)
      } catch (e) {
        // 一个插件初始化失败不影响别的插件，也不影响页面
        note(`插件 ${rec.name} 初始化失败：${e?.message ?? e}`)
        try { for (const d of disposers.reverse()) d() } catch { /* 尽力而为 */ }
        return false
      }
      loaded.push({ ...rec, dispose: () => { for (const d of disposers.reverse()) { try { d() } catch { /* 尽力而为 */ } } } })
      return true
    },

    /**
     * 触发一个钩子。**永远不抛错**（见文件头的说明）。
     * @returns {number} 实际被调用的处理函数个数（测试与排查用）
     */
    emit(event, payload) {
      const list = listeners.get(event) ?? []
      let n = 0
      for (const { plugin, fn } of list) {
        try { fn(payload); n++ } catch (e) {
          note(`${plugin} 处理 ${event} 时出错（已忽略，传输继续）：${e?.message ?? e}`)
        }
      }
      return n
    },

    /** 收集一个贡献点的值 */
    collect(slot) {
      const out = []
      for (const { plugin, fn } of slots.get(slot) ?? []) {
        try {
          const v = fn()
          if (v === undefined || v === null) continue
          for (const one of Array.isArray(v) ? v : [v]) out.push({ plugin, value: one })
        } catch (e) {
          note(`${plugin} 提供 ${slot} 时出错：${e?.message ?? e}`)
        }
      }
      return out
    },

    /** 已加载的插件（页面插件区域与排查用） */
    get list() { return loaded.map((p) => ({ name: p.name, version: p.version, effects: p.effects })) },
    get errors() { return [...errors] },

    /**
     * 把 `page/actions` 贡献的按钮渲染出来。
     *
     * 容器由运行时自己建，挂到 `#v-done`（接收完成那块面板）里 ——
     * 这样插件不需要知道页面的 DOM 结构，页面也不需要为插件留占位。
     */
    mountActions() {
      if (!doc) return 0
      const items = api.collect('page/actions')
      if (!items.length) return 0
      let box = doc.getElementById('page-plugin-actions')
      if (!box) {
        box = doc.createElement('div')
        box.id = 'page-plugin-actions'
        box.className = 'files'
        box.setAttribute('data-plugin-actions', '1')
        const host = doc.getElementById('v-done') ?? doc.body
        if (!host) return 0
        host.append(box)
      }
      box.textContent = ''
      let n = 0
      for (const { plugin, value } of items) {
        if (!value || typeof value !== 'object') continue
        const btn = doc.createElement('button')
        btn.className = 'mini'
        btn.type = 'button'
        btn.textContent = String(value.label ?? value.text ?? plugin)
        btn.title = `由页面插件 ${plugin} 提供`
        btn.addEventListener('click', () => {
          try { value.onClick?.() } catch (e) { note(`${plugin} 的按钮出错：${e?.message ?? e}`) }
        })
        box.append(btn)
        n++
      }
      return n
    },

    /** 页面卸载时释放插件资源（与另外两个平面的 effect 语义一致） */
    dispose() {
      for (const p of [...loaded].reverse()) p.dispose()
    },
  }

  // `page/ready`：等 DOM 就绪后触发（此时插件可以安全地碰 DOM）
  //
  // ⚠️ "已经就绪"时必须**推到下一个 tick**再触发，不能立刻触发：
  //    内联进页面的顺序是"运行时在前、插件紧跟其后"，而如果在创建运行时的那一刻
  //    就发 `page/ready`，插件根本还没注册上 —— 事件发了但没人听。
  //    这个坑在测试里先暴露出来（真页面里因为脚本在 `<head>`、readyState 还是
  //    'loading' 而侥幸没出问题），但它属于"换个加载顺序就错"的那类隐患。
  const schedule = env.setTimeout ?? ((fn) => setTimeout(fn, 0))
  const fireReady = () => { api.emit('page/ready', Object.freeze({ page: 'receiver' })) }
  if (doc && doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', fireReady)
  else schedule(fireReady)

  return api
}
