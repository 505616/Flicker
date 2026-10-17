/**
 * 界面转发：让插件能看到界面输出（`ui/message`）
 * ============================================
 * 为什么用"包一层"而不是在每个输出点插一行 `emit`：
 *   · 输出点有几十处，散在各模块里，加一行就要改几十个地方，还会漏；
 *   · 界面对象本来就是一个**已经存在的接缝**（`src/tty.js` 返回的那个对象），
 *     换掉的只是"调用完之后顺手通知一声"。
 *
 * ⚠️ 只包文本类的方法（见 `UI_LEVELS`），**不包**进度类与结构化调用 ——
 *    前者每块触发一次（几十 GB 就是几万条），后者传的是清单/链接/账单对象，
 *    插件要那些应当订阅事件，而不是从界面里捞。
 *
 * ⚠️ 界面输出是**同步**上下文：`ui/message` 的处理函数必须同步完成。
 *    返回 Promise 会被注册表记成错误（不会产生未处理的拒绝）。
 */
import { EVENTS, UI_LEVELS } from './events.js'
import { uiMessage } from './payload.js'

/** 把界面调用的参数压成一行可读文本 —— 插件只该看到文本，不该拿到内部对象 */
function textOf(args) {
  const first = args[0]
  if (typeof first === 'string') return first
  if (first && typeof first === 'object') {
    // `gift(g)` 这类：给个能认出来的名字就够了
    if (typeof first.name === 'string') return first.name
    if (typeof first.rel === 'string') return first.rel
    if (typeof first.message === 'string') return first.message
    return '[对象]'
  }
  return args.map((a) => (a === undefined ? '' : String(a))).join(' ').trim()
}

/**
 * @param {object} ui 原来的界面对象（`tty()` 的返回值）
 * @param {object} [plugins] 插件注册表；没有插件时**原样返回**（零开销）
 */
export function wrapUiForPlugins(ui, plugins) {
  if (!plugins || !plugins.count) return ui
  const out = { ...ui }
  for (const level of UI_LEVELS) {
    const orig = ui[level]
    if (typeof orig !== 'function') continue
    out[level] = (...args) => {
      const r = orig.apply(ui, args)
      plugins.emit(EVENTS.UI_MESSAGE, uiMessage(level, textOf(args)))
      return r
    }
  }
  return out
}
