/**
 * 插件加载与注册表（发送端 / 中继共用的那一半）
 * ============================================
 *
 * ── 加载策略：只允许显式指定 ──────────────────────────────
 * 来源只有两个（见 `pluginPaths()`）：
 *   · 命令行 `--plugin=<路径>`（可重复）
 *   · 环境变量 `FLICKER_PLUGINS`（多个路径用系统分隔符分开）
 *
 * **绝不自动发现**：不扫当前目录、不读 `package.json` 里的字段、不找
 * `node_modules/flicker-plugin-*`。理由是安全模型 —— 插件是以你的权限运行的
 * 任意代码，而"顺手加载旁边的目录"会把"这个程序不需要装任何第三方东西"
 * 这句话变成一句谎。加载了什么必须打在屏幕上（见 `describe()`）。
 *
 * ── 加载机制：为什么是读文件 + `Module._compile` ──────────
 * 不用 `import()`，也不用 `require()`：
 *   · 单文件产物（SEA）里 `import()` **加载不了磁盘上的文件**（实测限制，
 *     见 entry/sea-entry.cjs 开头那两条），相对路径的动态 import 还会被
 *     打包器直接拒绝构建；
 *   · 而"读文件 + `new Module()._compile()`"这条路**已经在产物里跑通了** ——
 *     单文件入口就是用同样的办法把内嵌的 app.cjs 跑起来的。
 * 于是插件在源码模式与单文件产物里走的是**同一条路**，不会出现
 * "在源码目录里能用、把 exe 复制到桌面就报 Cannot find module"。
 */
import { readFileSync } from 'node:fs'
import Module from 'node:module'
import path from 'node:path'
import {
  API_VERSION, SUPPORTED_API_VERSIONS, KNOWN_EVENTS, KNOWN_SLOTS, EVENTS, SLOTS,
} from './events.js'
import { createPluginContext } from './context.js'

/** 从命令行与环境变量里收集插件路径（保持用户给的顺序，去重） */
export function pluginPaths({ flagValue, env = process.env } = {}) {
  const out = []
  const push = (p) => {
    const s = String(p ?? '').trim()
    if (s && !out.includes(s)) out.push(s)
  }
  if (Array.isArray(flagValue)) flagValue.forEach(push)
  else if (flagValue !== undefined && flagValue !== true) push(flagValue)
  const fromEnv = env.FLICKER_PLUGINS
  if (fromEnv) for (const p of String(fromEnv).split(path.delimiter)) push(p)
  return out
}

/**
 * 读一个插件文件并把它编译成 CommonJS 模块。
 *
 * ⚠️ 插件在 v1 里应当**自包含**：只用 `node:` 内置模块，不要 `require` 旁边的
 *    辅助文件。原因是"单文件产物里能不能 require 磁盘上的相对文件"这件事
 *    还没有实测结论（见 docs/插件.md 的"还没做的部分"）。
 */
function loadPluginModule(file) {
  const abs = path.resolve(file)
  let src
  try {
    src = readFileSync(abs, 'utf8')
  } catch (e) {
    throw new Error(`插件文件读不到：${file}\n  ${e?.message ?? e}`)
  }
  const mod = new Module(abs, null)
  mod.filename = abs
  mod.paths = Module._nodeModulePaths(path.dirname(abs))
  try {
    mod._compile(src, abs)
  } catch (e) {
    throw new Error(`插件加载失败：${file}\n  ${e?.message ?? e}`)
  }
  return mod.exports
}

/** 校验插件导出的形状 —— 形状不对要说得清清楚楚，而不是等运行时 undefined 报错 */
function checkDeclaration(exports, file) {
  const d = exports
  if (!d || typeof d !== 'object') {
    throw new Error(`插件格式不对：${file}\n` +
      '  应当 `module.exports = { name, apiVersion, apply(ctx) { … } }`')
  }
  if (typeof d.name !== 'string' || !d.name.trim()) {
    throw new Error(`插件缺少 name：${file}（这个名字会出现在界面与销毁清单里）`)
  }
  if (d.apiVersion !== undefined && !Number.isInteger(d.apiVersion)) {
    throw new Error(`插件 ${d.name} 的 apiVersion 必须是整数（现在填的是 ${JSON.stringify(d.apiVersion)}）`)
  }
  const want = d.apiVersion ?? 1
  if (!SUPPORTED_API_VERSIONS.includes(want)) {
    throw new Error(
      `插件 ${d.name} 要 API 版本 ${want}，而本程序提供的是 ${API_VERSION}` +
      `（支持：${SUPPORTED_API_VERSIONS.join(' / ')}）\n` +
      '  插件与程序的接口对不上时**拒绝加载**，而不是尽力而为 —— ' +
      '请换一个匹配的插件版本，或者升级程序。')
  }
  if (typeof d.apply !== 'function') {
    throw new Error(`插件 ${d.name} 缺少 apply(ctx) 函数：${file}`)
  }
  return { name: d.name.trim(), version: typeof d.version === 'string' ? d.version : null, apiVersion: want }
}

/**
 * 建一个空的注册表。没有任何插件时它也是合法的（`count === 0`），
 * 调用方不需要到处写 `if (plugins)`。
 *
 * @param {object} [o]
 * @param {string} [o.flickerVersion] 塞进 `ctx.info.flicker`
 * @param {string[]|null} [o.planes]
 *   这次允许哪些平面的钩子（`['sender']` / `['relay']` / `['receive']` / `['sender','receive']`）。
 *   给了就**只允许**这些平面的钩子：用别处的当场报错（见 `src/plugin/context.js` 的 `checkPlane`）。
 *   不给 / null = 不限制：那是 `--plugins`（只列出、不运行）用的宽松模式。
 *   界面要同时做两个方向，所以给它 `['sender', 'receive']`。
 * @param {(line:string)=>void} [o.log] 插件自己 `ctx.log()` 的输出通道（默认 stderr）
 */
export function createPluginRegistry({ flickerVersion = null, planes = null, log } = {}) {
  // ⚠️ 用 `let` 而不是 `const`：图形界面会把插件的输出**改道**进界面的日志面板
  //    （见下面的 `setLog()`）。命令行默认写 stderr，那条在图形界面里是看不见的 ——
  //    而"插件说了话但用户看不到"正是本项目最不想要的静默失败。
  let emitLog = log ?? ((line) => process.stderr.write(line + '\n'))
  const loaded = []                 // 已加载的插件
  const listeners = new Map()       // 事件名 → [{ plugin, fn }]
  const slots = new Map()           // 贡献点 → [{ plugin, fn }]
  const asyncErrors = []            // 同步事件里返回 Promise 的那种错误（收尾时如实报告）
  let disposedAll = false           // 是否已经整体释放过（销毁链可能被跑两次）

  const subscribe = (event, plugin, fn) => {
    const list = listeners.get(event) ?? []
    list.push({ plugin, fn })
    listeners.set(event, list)
    return () => {
      const cur = listeners.get(event) ?? []
      const at = cur.findIndex((x) => x.fn === fn && x.plugin === plugin)
      if (at >= 0) cur.splice(at, 1)
    }
  }

  const addContribution = (slot, plugin, fn) => {
    const list = slots.get(slot) ?? []
    list.push({ plugin, fn })
    slots.set(slot, list)
  }

  /** 同步触发：处理函数必须同步完成（返回 Promise 会被记下来，绝不产生未处理的拒绝） */
  const emit = (event, payload) => {
    for (const { plugin, fn } of listeners.get(event) ?? []) {
      let out
      try {
        out = fn(payload)
      } catch (e) {
        throw new Error(`插件 ${plugin} 处理 ${event} 时出错：${e?.message ?? e}`)
      }
      if (out && typeof out.then === 'function') {
        out.then(undefined, (e) => {
          asyncErrors.push(`插件 ${plugin} 的 ${event} 处理函数返回了 Promise 并失败：${e?.message ?? e}`)
        })
        asyncErrors.push(`插件 ${plugin} 的 ${event} 是同步事件，但它返回了 Promise（已忽略）`)
      }
    }
  }

  /** 异步触发：按注册顺序逐个 await —— 顺序确定，插件之间不会互相踩 */
  const emitAsync = async (event, payload) => {
    for (const { plugin, fn } of listeners.get(event) ?? []) {
      try {
        await fn(payload)
      } catch (e) {
        throw new Error(`插件 ${plugin} 处理 ${event} 时出错：${e?.message ?? e}`)
      }
    }
  }

  /**
   * 异步触发，并把**第一个非 undefined 的返回值**交回来。
   *
   * 用途只有一个但很关键：中继的 `relay/route` —— 插件可以返回一个响应
   * （`{ status, body, headers }`）**直接结束这个请求**（鉴权、配额、IP 白名单）。
   * 第一个返回值的插件说了算，后面的照常执行（它们也能看到这个请求）。
   */
  const emitFirst = async (event, payload) => {
    let out
    for (const { plugin, fn } of listeners.get(event) ?? []) {
      let r
      try {
        r = await fn(payload)
      } catch (e) {
        throw new Error(`插件 ${plugin} 处理 ${event} 时出错：${e?.message ?? e}`)
      }
      if (r !== undefined && r !== null && out === undefined) out = { plugin, value: r }
    }
    return out
  }

  /**
   * 异步触发，但**插件出错不打断调用方**：错误记进 `errors`，事件继续往下发。
   *
   * 谁需要它：**接收端进程**（planes `receive`）。那里插件出错时对方正在推文件 ——
   * 因为一个插件写坏了就让这次传输失败，受害的是只想把照片存下来的人。
   * 与页面平面同一个取舍（见《插件.md》§五），但错误不会消失：它会进
   * `plugins.errors`，收尾时如实打印出来。
   */
  const emitAsyncSafe = async (event, payload) => {
    for (const { plugin, fn } of listeners.get(event) ?? []) {
      try {
        await fn(payload)
      } catch (e) {
        asyncErrors.push(`插件 ${plugin} 处理 ${event} 时出错（已忽略，接收继续）：${e?.message ?? e}`)
      }
    }
  }

  /** 收集一个贡献点的所有值（数组会被拍平） */
  const collect = (slot) => {
    const out = []
    for (const { plugin, fn } of slots.get(slot) ?? []) {
      let value
      try {
        value = fn()
      } catch (e) {
        throw new Error(`插件 ${plugin} 提供 ${slot} 时出错：${e?.message ?? e}`)
      }
      if (value === undefined || value === null) continue
      for (const v of Array.isArray(value) ? value : [value]) out.push({ plugin, value: v })
    }
    return out
  }

  const registry = {
    flickerVersion,
    planes: Array.isArray(planes) && planes.length ? Object.freeze([...planes]) : null,
    get count() { return loaded.length },
    get list() {
      return loaded.map((p) => ({
        name: p.name, version: p.version, apiVersion: p.apiVersion, file: p.file,
        events: [...new Set(p.events)], effects: p.effects,
      }))
    },
    get errors() { return [...asyncErrors] },
    pluginLog(plugin, text) { emitLog(`  [插件 ${plugin}] ${text}`) },
    /**
     * 换掉插件日志的出口。
     *
     * 谁需要它：**图形界面**。进程的 stderr 在界面里看不见，插件 `ctx.log()` 的话
     * 就等于扔了 —— 于是界面在启动传输前把出口改道到自己的日志面板。
     * 只换出口、不重载插件（`apply()` 不能跑第二遍）。
     */
    setLog(fn) {
      if (typeof fn !== 'function') throw new Error('setLog 需要一个函数')
      emitLog = fn
    },
    subscribe, addContribution, emit, emitAsync, emitFirst, emitAsyncSafe, collect,

    /**
     * 按顺序加载插件。任何一个加载失败都**立刻中止**（附文件名与原因）：
     * 用户显式要求了这个插件，静默跳过等于骗他。
     */
    async load(paths) {
      for (const file of paths) {
        const exports = loadPluginModule(file)
        const decl = checkDeclaration(exports, file)
        if (loaded.some((p) => p.name === decl.name)) {
          throw new Error(`插件名重复：${decl.name}（${file}）—— 两个插件不能同名`)
        }
        const rec = { ...decl, file, events: [], effects: 0 }
        // 记账：这个插件订阅了什么、登记了几个副作用（`--plugins` 与销毁清单要用）
        const { ctx, dispose } = createPluginContext(registry, decl, {
          event: (name) => rec.events.push(name),
          effect: () => { rec.effects++ },
        })

        try {
          await exports.apply(ctx)
        } catch (e) {
          await dispose()
          throw new Error(`插件 ${decl.name} 初始化失败（apply 抛错）：${e?.message ?? e}`)
        }
        loaded.push({ ...rec, dispose })
      }
      return registry
    },

    /** 释放所有插件的资源（逆序）。返回一份"跑了几个、哪些失败"的账单 */
    async dispose() {
      disposedAll = true
      const failed = []
      let ran = 0
      for (const p of [...loaded].reverse()) {
        const r = await p.dispose()
        ran += r.ran
        for (const f of r.failed) failed.push(`${p.name}: ${f}`)
      }
      failed.push(...asyncErrors.splice(0))
      return { ran, failed }
    },

    /**
     * 给销毁链用的那一步（`Destroyer.step` 的回调）。
     *
     * 抽出来是因为有三个地方要用它：局域网模式的销毁链、中继模式的销毁链、
     * 以及 `--dry-run` 的那条早退路径。**早退路径尤其容易漏** ——
     * 干跑也会加载插件（插件可能在 run/start 里就开了东西），
     * 漏掉这一步就等于"干跑一次留下一个插件资源"。
     *
     * 返回 falsy = "这次没有插件"，会被销毁清单记成"不适用"。
     */
    async asDestroyStep() {
      // 已经释放过就报"不适用"：销毁链在正常路径与 catch 兜底里都可能被跑到，
      // 第二次不能再报"已释放 0 项"（那会让销毁清单看起来像做了两遍）。
      if (!loaded.length || disposedAll) return false
      const r = await this.dispose()
      if (r.failed.length) throw new Error(`${r.failed.length} 项失败：${r.failed.join('；')}`)
      return `已释放 ${r.ran} 项`        // 字符串是 truthy，会进"已完成"清单
    },

    /** 给界面用的一行人话（加载了什么必须看得见） */
    describe() {
      if (!loaded.length) return null
      const names = loaded.map((p) => `${p.name}${p.version ? '@' + p.version : ''}`).join('、')
      return `${loaded.length} 个插件：${names}`
    },
  }
  return registry
}

export { EVENTS, SLOTS }
