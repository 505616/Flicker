/**
 * 只保留**代码**，去掉注释与字符串字面量
 * ======================================
 * 用途：判断"这份源码里有没有用到 X"。
 *
 * ⚠️ 为什么必须有它，而且不能只用一个正则：
 *   `src/path-safety.js` 的**注释里**就写着"不许用 Buffer、不许用 process"，
 *   于是最朴素的 `/\bBuffer\b/` 检查第一件事就是误报 —— 一个专门用来防错的检查，
 *   开口就报了个假错。判断"源码里有没有用到 X"必须只看**代码**。
 *
 * ⚠️ 为什么是小状态机而不是正则：字符串里可能出现 `//`（比如 URL），
 *   用它当注释起点会把后面的代码整段吞掉，于是**漏报** —— 而漏报比误报危险得多。
 *
 * 这个实现原本长在 `gen/inline-path-rules.mjs` 里；页面插件的内联脚本也要用它
 * （插件与运行时都必须是"浏览器能直接跑的纯 JS"，不许 import/require/Node API），
 * 所以抽到这一处 —— 两份实现迟早会漂，而漂的那一份会漏检。
 */

/**
 * @param {string} src 源码
 * @returns {string} 只剩代码（注释、字符串字面量、模板串都替换成空）
 */
export function codeOnly(src) {
  let out = ''
  let i = 0
  const n = src.length
  let state = 'code'      // code | line | block | sq | dq | tpl
  while (i < n) {
    const c = src[i], c2 = src.slice(i, i + 2)
    if (state === 'code') {
      if (c2 === '//') { state = 'line'; i += 2; continue }
      if (c2 === '/*') { state = 'block'; i += 2; continue }
      if (c === "'") { state = 'sq'; i++; continue }
      if (c === '"') { state = 'dq'; i++; continue }
      if (c === '`') { state = 'tpl'; i++; continue }
      out += c; i++; continue
    }
    if (state === 'line') { if (c === '\n') { state = 'code'; out += c } i++; continue }
    if (state === 'block') { if (c2 === '*/') { state = 'code'; i += 2 } else i++; continue }
    if (state === 'sq' || state === 'dq') {
      const q = state === 'sq' ? "'" : '"'
      if (c === '\\') { i += 2; continue }
      if (c === q) { state = 'code' }
      i++; continue
    }
    if (state === 'tpl') {
      if (c === '\\') { i += 2; continue }
      if (c === '`') { state = 'code' }
      i++; continue
    }
    i++
  }
  return out
}
