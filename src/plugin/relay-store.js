/**
 * 中继的存储后端：把"房间存在哪里"变成插件可以替换的东西
 * ======================================================
 *
 * ── 为什么要这个接缝 ──
 * 中继原本把房间放在进程内存里（`src/relay/room.js` 的 `RoomStore`）。这对
 * "Cloudflare Worker + 一个进程"是最合适的，但对**自己部署中继**的人不总是：
 *   · 想在中继重启后**不让正在传的会话断掉**（内存一没，房间就没了）
 *   · 想用磁盘 / 对象存储 / 数据库，而不是吃内存
 *   · 想接自家的可观测性或配额
 * 而 `relay/route` 只能**观察与拦截**请求，换不掉存储本身 —— 这是两件不同的事。
 *
 * ── 这个文件只做一件事：把插件贡献的存储**校验**成可用的 ──
 * 校验必须发生在**启动时**，而不是第一次写入时：
 *   · 少一个方法 → 现在就报错，并点名是哪个插件、少哪几个
 *   · 等到客户端传到一半才 500，报的还是 `store.ack is not a function`，
 *     没人能从这句话里看出是插件写错了
 *
 * ⚠️ **Worker 形态不支持**：Worker 里装不了这套从磁盘加载的插件（没有磁盘），
 *    所以这个接缝只对自部署的 `relay/local.mjs` 生效。见 `插件.md` §十一。
 */
import { SLOTS } from './events.js'

/**
 * 一个存储后端必须实现的方法（来自 `src/relay/protocol.js` 的实际调用点）。
 *
 * 刻意**只列协议真正用到的**：多列一个方法就等于要求插件多写一段死代码，
 * 而少列一个的表现是运行时 `undefined is not a function`。
 */
export const STORE_METHODS = Object.freeze([
  'create',    // (id) → {created, messages}
  'put',       // (id, seq, data) → {seq, nextSeq}
  'putBatch',  // (id, items) → {seqs, nextSeq}
  'get',       // (id, seq) → {seq, data, nextSeq}
  'ack',       // (id, upToSeq) → {ackedBase, nextSeq}
  'status',    // (id) → {pending, ackedBase, nextSeq, ageMs, idleMs, ttlMs}
  'destroy',   // (id) → {destroyed}
  'stats',     // () → {rooms, messages, ttlMs}
])

/** 校验一个候选存储对象；不合格就抛错（信息里必须带上插件名，否则没人查得出来） */
function checkStore(value, plugin) {
  const bad = []
  if (!value || typeof value !== 'object') {
    throw new Error(`插件 ${plugin} 提供的 relay/store 不是对象（拿到的是 ${value === null ? 'null' : typeof value}）`)
  }
  for (const m of STORE_METHODS) {
    if (typeof value[m] !== 'function') bad.push(m)
  }
  if (bad.length) {
    throw new Error(
      `插件 ${plugin} 提供的 relay/store 少了这些方法：${bad.join('、')}\n` +
      '  存储后端必须实现：' + STORE_METHODS.join(' / ') +
      '\n  现在就报错是故意的 —— 等传了一半才 `undefined is not a function`，没人查得出来是插件的问题')
  }
  if (!Number.isInteger(value.maxMessageBytes) || value.maxMessageBytes <= 0) {
    throw new Error(
      `插件 ${plugin} 提供的 relay/store 缺少 maxMessageBytes（或不是正整数：${JSON.stringify(value.maxMessageBytes)}）\n` +
      '  它是能力协商的依据：客户端按它选块大小，缺了只能猜 —— 而猜错的表现是"大文件必挂"')
  }
  return value
}

/**
 * 从插件注册表里取出存储后端；没有插件或没人贡献就用 `fallback`。
 *
 * @param {object|null} plugins `createPluginRegistry()` 的返回值
 * @param {object} fallback 默认的内存存储（`new RoomStore()`）
 * @returns {object} 存储对象
 */
export function relayStoreFrom(plugins, fallback) {
  if (!plugins || !plugins.count) return fallback
  const got = plugins.collect(SLOTS.RELAY_STORE)
  if (!got.length) return fallback
  // 多个插件都贡献：**第一个说了算**。不合并 —— 两个存储后端加在一起没有意义，
  // 而"悄悄只用其中一个"必须能被解释清楚，所以返回的是第一个、并把来源交给调用方显示。
  const { plugin, value } = got[0]
  const store = checkStore(value, plugin)
  // 标记来源（调用方据此在启动时打印"存储后端来自哪个插件"）
  Object.defineProperty(store, '__plugin', { value: plugin, enumerable: false, configurable: true })
  return store
}

/** 给界面/日志用的一句话：这次用的是谁的存储 */
export function describeStore(store) {
  const plugin = store?.__plugin
  return plugin ? `插件的存储后端（${plugin}）` : '内存（内置 RoomStore）'
}
