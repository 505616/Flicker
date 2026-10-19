/**
 * 字号调节（手机页 / 接收页 / 站点页共用一份）
 * ============================================
 *
 * 2026-10 用户反馈："字有点太小了，可以加一个调整字体大小的功能吗"。
 * 尤其手机上传那一页 —— 密码框、文件清单、进度数字都是给小屏写的，
 * 近视/老花或者手机屏小的时候确实吃力。
 *
 * ── 设计取舍 ──────────────────────────────────────────────
 *
 * **为什么是"改根字号"而不是逐个元素调 CSS**：三个页面的字号全都写成 `rem`，
 * 所以只需要改 `<html>` 的 font-size，整页文字按比例变大，布局（间距、宽度）
 * 也跟着走，不会出现"字大了但框没大"的挤压。控件自己用 `px` 固定，免得越点越大。
 *
 * **为什么是四档而不是连续滑块**：手机上要的是"点两下就合适"，不是精确调节。
 * 100% → 115% → 130% → 150%，到顶/到底就停（按钮变灰，而不是无声地点不动）。
 *
 * **存哪里**：由内联器按页面替换 `__FONT_SCALE_STORE__`（与 i18n 同一套做法）——
 * 发送端 localStorage、接收端与手机页 sessionStorage。这样"接收端页面里
 * 根本不出现 `localStorage` 这个名字"这条承诺仍然成立（判据会查）。
 *
 * 用法（页面里由 `gen/inline-font-scale.mjs` 内联，不手写）：
 *   `globalThis.FlickerFontScale` 暴露 STEPS / pctOf / clampIndex / nextIndex /
 *   readIndex / applyIndex / mount，纯函数部分由 `test/font-scale.test.js` 直接验。
 */
;(function (global, doc) {
  'use strict'

  var KEY = 'flicker.fontScale'
  /** 四档：100% / 115% / 130% / 150%（倍数） */
  var STEPS = [1, 1.15, 1.3, 1.5]

  function clampIndex(i) {
    var n = Number(i)
    if (!isFinite(n)) return 0
    n = Math.round(n)
    return n < 0 ? 0 : n >= STEPS.length ? STEPS.length - 1 : n
  }

  function pctOf(i) { return Math.round(STEPS[clampIndex(i)] * 100) }

  /** 下一档：dir=+1 放大、-1 缩小（到顶/到底返回原值，不循环） */
  function nextIndex(i, dir) {
    return clampIndex(clampIndex(i) + (dir >= 0 ? 1 : -1))
  }

  /** 读存储里的档位；任何异常（隐私模式、存储被禁）都退回 0 */
  function readIndex() {
    var store = null
    try { store = typeof __FONT_SCALE_STORE__ !== 'undefined' ? __FONT_SCALE_STORE__ : null } catch (e) { store = null }
    if (!store) return 0
    try { return clampIndex(store.getItem(KEY)) } catch (e) { return 0 }
  }

  function saveIndex(i) {
    var store = null
    try { store = typeof __FONT_SCALE_STORE__ !== 'undefined' ? __FONT_SCALE_STORE__ : null } catch (e) { store = null }
    if (!store) return
    try { store.setItem(KEY, String(clampIndex(i))) } catch (e) { /* 隐私模式：忽略，本次仍然生效 */ }
  }

  /**
   * 真的把整页放大/缩小。
   *
   * ⚠️ 这里踩过一次坑：一开始只改 `<html>` 的 `font-size`，以为"页面字号都是 rem" ——
   *    实测发现三个页面里还有一堆 **px** 的字号（提示行 11px、小字 13px…），
   *    于是"调大字号"只放大了标题和正文，**偏偏最小的那些提示行没变**，
   *    而用户抱怨的正是"字太小"。
   *
   * 所以优先用 CSS **`zoom`**（浏览器缩放的那套语义：整页等比放大、布局重排），
   * 只有在不支持 `zoom` 的浏览器上才退回"改根字号"（那样 rem 部分会放大，
   * px 部分不会 —— 是降级，但比什么都不做强）。
   *
   * 为什么不两条一起上：`zoom` 会连 rem 的换算结果一起放大，两个叠加就是平方。
   */
  function supportsZoom() {
    try { return !!(global.CSS && global.CSS.supports && global.CSS.supports('zoom', '1.5')) } catch (e) { return false }
  }

  function applyIndex(i, root) {
    var el = root || (doc && doc.documentElement)
    if (!el || !el.style) return
    var scale = STEPS[clampIndex(i)]
    if (supportsZoom()) {
      el.style.zoom = String(scale)
      if (el.style.fontSize) el.style.fontSize = ''
      return
    }
    // 降级：改根字号。基数取"当前根字号"（用户可能自己改过浏览器默认字号），
    // 而且只读一次 —— 已经缩放过的值当基准会叠乘。
    var base = 16
    try {
      if (!el.__fkBase) {
        var cur = parseFloat(global.getComputedStyle ? global.getComputedStyle(el).fontSize : '')
        el.__fkBase = isFinite(cur) && cur > 0 ? cur : 16
      }
      base = el.__fkBase
    } catch (e) { base = 16 }
    el.style.fontSize = (base * scale) + 'px'
  }

  function t(key, vars) {
    try {
      if (typeof global.t === 'function') return global.t(key, vars)
    } catch (e) { /* 文案表还没就绪 */ }
    return key
  }

  var state = { index: 0, box: null, pctBtn: null }

  function paint() {
    if (!state.box) return
    if (state.pctBtn) state.pctBtn.textContent = pctOf(state.index) + '%'
    var dec = state.box.querySelector('[data-fk="dec"]')
    var inc = state.box.querySelector('[data-fk="inc"]')
    if (dec) dec.disabled = state.index <= 0
    if (inc) inc.disabled = state.index >= STEPS.length - 1
  }

  function setIndex(i) {
    state.index = clampIndex(i)
    saveIndex(state.index)
    applyIndex(state.index)
    paint()
    // 让工具提示（"恢复默认字号（当前 130%）"）里的百分比也跟着更新
    try { if (global.FlickerI18N && global.FlickerI18N.apply) global.FlickerI18N.apply() } catch (e) { /* 没有 i18n 也能用 */ }
  }

  var CSS = [
    // 底部留出控件本身的高度：否则它可能盖住页面最下面那个按钮/文字
    'body{padding-bottom:calc(60px + env(safe-area-inset-bottom))}',
    '.fk-fs{position:fixed;z-index:60;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));',
    'display:flex;align-items:center;gap:4px;padding:4px;border:1px solid var(--line,#333);',
    'border-radius:999px;background:var(--card,rgba(20,20,22,.92));box-shadow:0 2px 10px rgba(0,0,0,.35);',
    'font-size:14px;line-height:1}',
    '.fk-fs button{font:inherit;font-size:14px;min-width:36px;min-height:34px;padding:0 8px;cursor:pointer;',
    'color:var(--text,#eee);background:transparent;border:0;border-radius:999px}',
    '.fk-fs button:active{background:rgba(255,255,255,.14)}',
    '.fk-fs button:disabled{opacity:.35;cursor:default}',
    '.fk-fs .fk-fs-pct{min-width:52px;font-variant-numeric:tabular-nums;font-size:13px;color:var(--dim,#aaa)}',
  ].join('')

  function mount() {
    if (state.box || !doc || !doc.body) return
    if (!doc.getElementById('fk-fs-style')) {
      var st = doc.createElement('style')
      st.id = 'fk-fs-style'
      st.textContent = CSS
      doc.head.appendChild(st)
    }
    var box = doc.createElement('div')
    box.className = 'fk-fs'
    box.setAttribute('role', 'group')
    box.innerHTML = [
      '<button type="button" data-fk="dec" data-i18n-attr="title:fontScale.smaller,aria-label:fontScale.smaller">A−</button>',
      '<button type="button" data-fk="reset" class="fk-fs-pct" data-i18n-attr="title:fontScale.reset,aria-label:fontScale.reset">100%</button>',
      '<button type="button" data-fk="inc" data-i18n-attr="title:fontScale.larger,aria-label:fontScale.larger">A+</button>',
    ].join('')
    state.box = box
    state.pctBtn = box.querySelector('[data-fk="reset"]')

    box.addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('button[data-fk]') : null
      if (!btn || btn.disabled) return
      ev.preventDefault()
      ev.stopPropagation()
      var act = btn.getAttribute('data-fk')
      if (act === 'reset') setIndex(0)
      else setIndex(nextIndex(state.index, act === 'inc' ? 1 : -1))
    })
    doc.body.appendChild(box)

    // 文案：先按当前语言填一遍；切语言时 i18n 运行时会重新 apply 这些 data-i18n-attr
    try { if (global.FlickerI18N && global.FlickerI18N.apply) global.FlickerI18N.apply() } catch (e) { /* 忽略 */ }
    paint()
  }

  // 尽早生效：脚本内联在 <head>，此时 documentElement 已在，先按存档的字号设好，
  // 免得"先按小的渲染、再跳大"闪一下。
  state.index = readIndex()
  applyIndex(state.index)

  function boot() {
    mount()
    paint()
  }
  if (doc) {
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot)
    else boot()
  }

  global.FlickerFontScale = {
    STEPS: STEPS,
    clampIndex: clampIndex,
    pctOf: pctOf,
    nextIndex: nextIndex,
    readIndex: readIndex,
    applyIndex: applyIndex,
    setIndex: function (i) { setIndex(i) },
    mount: mount,
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, typeof document !== 'undefined' ? document : null)
