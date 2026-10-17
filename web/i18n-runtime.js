/**
 * 界面文案的运行时（中英）。
 *
 * ⚠️ 这个文件由 gen/inline-i18n.mjs **内联进 web/*.html**，不是运行时加载的。
 *    接收端页面必须保持单文件、零外部请求（局域网可能没有外网）。
 *    内联时会把 web/i18n-strings.mjs 的文案表以 **JSON 字面量**塞进 __I18N__，
 *    不用 eval、也不做模块打包 —— 页面里就是一份普通数据。
 *
 * ── 为什么把 document / localStorage 作为**参数**传进 IIFE ──────
 *
 * 一开始这几处写的是 `global.document`（从 globalThis 上取）。在浏览器里没问题，
 * 但那样**无法测试**：Node 的 globalThis 上没有 document，于是
 * `if (global.document)` 恒为假、boot() 从不执行，而 API 又挂在 globalThis 上
 * 所以"看起来能跑"。测试里想注入假 DOM 也无从下手 —— 注入的 document
 * 根本不在 globalThis 上。
 *
 * 改成参数之后：浏览器里拿到真的 document，测试里 `new Function('document', …)`
 * 注入假 DOM 就能真正生效。**这条依赖是测试逼出来的，不是设计洁癖。**
 *
 * ── 为什么用 data-i18n 属性，而不是把文案全塞进 JS ────────────
 *
 * 因为**页面在没有脚本时也该能看**。HTML 标签里保留中文原文，
 * 脚本只是"按语言替换" —— 脚本没跑起来时用户看到的仍是完整的中文界面，
 * 而不是一堆空白。
 *
 * ── 用法 ─────────────────────────────────────────────────────
 *
 *   HTML:
 *     <h2 data-i18n="recv.pw.title">对方想给你发文件</h2>
 *     <input data-i18n-attr="placeholder:recv.pw.placeholder" placeholder="…">
 *     <p data-i18n="recv.go.streamNote" data-i18n-html>正在<b>边收边写</b>…</p>
 *     <html data-i18n-title="recv.title">          ← <title> 单独处理
 *     <button data-lang-switch></button>           ← 语言切换按钮
 *
 *   JS:
 *     t('recv.msg.moreFiles', { n: 3 })     // 「还有 3 个文件」/ "3 more files"
 *     setLang('en')                          // 切换并重绘
 */
;(function (global, doc, store, nav) {
  'use strict'

  var TABLE = global.__I18N__ || { zh: {}, en: {} }
  var LANGS = global.__I18N_LANGS__ || [{ code: 'zh', label: '中文' }]
  var KEY = global.__I18N_KEY__ || 'flicker.lang'
  var DEFAULT = global.__I18N_DEFAULT__ || 'zh'
  /**
   * 要不要**跨会话记住**语言偏好。
   *
   * ⚠️ 两个页面的答案不一样，这是刻意的：
   *   · 发送端（station）：用户自己的机器，会反复用 → 记住，省得每次切。
   *   · 接收端（receiver）：**对方的一次性页面** → 不记住。
   *     这个页面对接收端的承诺是"不留痕迹"，不该为了省一次点击就破例 ——
   *     在浏览器里留下一条记录，本身就是痕迹。
   *     所以接收端只在**本次会话内**记住（sessionStorage，关标签即消失）。
   */
  var PERSIST = global.__I18N_PERSIST__ !== false
  // 传进来的 store **已经是存储对象本身** —— 内联器把运行时末尾的
  // __I18N_STORE__ 占位符按页面换成了 localStorage 或 sessionStorage。
  // 取不到（隐私模式）就整块禁用，只影响"记不记得住语言"，不影响界面显示。
  var storeArea = store || null

  var SUPPORTED = LANGS.map(function (l) { return l.code })

  // ── 语言选择 ────────────────────────────────────────────────
  //
  // 优先级：本次记得的 > 浏览器语言 > 默认。
  // ⚠️ 接收端**不写** localStorage；见上面 PERSIST 的说明。
  function readStored() {
    if (!storeArea) return null
    try {
      var v = storeArea.getItem(KEY)
      return SUPPORTED.indexOf(v) >= 0 ? v : null
    } catch (e) { return null }        // 隐私模式下访问存储会抛
  }

  function detect() {
    var stored = readStored()
    if (stored) return stored
    // ⚠️ 这里必须用**参数** nav，不能写 global.navigator。
    //    Node 里 globalThis.navigator **是存在的**（值来自系统区域设置），
    //    所以它会静默遮蔽测试注入的假 navigator —— 而且不报错，
    //    只是语言检测永远按宿主机的区域走。这个坑排查了很久：
    //    表现是"测试里传了 en-US，运行时却按 zh 走"。
    var list = (nav && (nav.languages || (nav.language ? [nav.language] : null))) || []
    for (var i = 0; i < list.length; i++) {
      var tag = String(list[i] || '').toLowerCase()
      if (!tag) continue
      // zh-CN / zh-Hans-CN → zh ；en-US → en
      var base = tag.split('-')[0]
      if (SUPPORTED.indexOf(base) >= 0) return base
    }
    return DEFAULT
  }

  var lang = detect()

  // ── 取词与插值 ──────────────────────────────────────────────
  //
  // 占位符是 {name}。中英语序不同，所以**必须**整句翻译 + 占位符替换，
  // 不能靠拼字符串 —— 例：「还有 {n} 个文件」→ "{n} more files"。
  function t(key, vars) {
    var s = (TABLE[lang] && TABLE[lang][key])
    // 缺词时退回默认语言，再退回键名本身。
    // 退回键名是刻意的：界面上出现 "recv.pw.title" 这样的字样很刺眼，
    // 一眼就知道漏了哪一条，比悄悄显示空白或中文好排查。
    if (s == null) s = (TABLE[DEFAULT] && TABLE[DEFAULT][key])
    if (s == null) return key
    if (!vars) return s
    return s.replace(/\{(\w+)\}/g, function (m, name) {
      return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m
    })
  }

  // ── 重绘 ────────────────────────────────────────────────────
  function apply(root) {
    var scope = root || doc
    if (!scope || !scope.querySelectorAll) return 0
    var n = 0

    // 文本节点
    var nodes = scope.querySelectorAll('[data-i18n]')
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i]
      var key = el.getAttribute('data-i18n')
      if (!key) continue
      var val = t(key)
      if (el.hasAttribute('data-i18n-html')) el.innerHTML = val
      else el.textContent = val
      n++
    }

    // 属性：data-i18n-attr="placeholder:key" 或 "title:key,aria-label:key2"
    var attrs = scope.querySelectorAll('[data-i18n-attr]')
    for (var j = 0; j < attrs.length; j++) {
      var el2 = attrs[j]
      var spec = el2.getAttribute('data-i18n-attr') || ''
      var parts = spec.split(',')
      for (var k = 0; k < parts.length; k++) {
        var pair = parts[k].split(':')
        if (pair.length !== 2) continue
        var attr = pair[0].trim(), key2 = pair[1].trim()
        if (attr && key2) { el2.setAttribute(attr, t(key2)); n++ }
      }
    }

    return n
  }

  // ── 切换 ────────────────────────────────────────────────────
  function setLang(code) {
    if (SUPPORTED.indexOf(code) < 0) return false
    lang = code
    try { if (storeArea) storeArea.setItem(KEY, code) } catch (e) { /* 隐私模式，忽略 */ }

    if (doc && doc.documentElement) {
      doc.documentElement.setAttribute('lang', code === 'zh' ? 'zh-CN' : code)
    }
    apply()

    // 按钮显示的是"另一种语言"的名字 —— 切完要跟着换，否则切到英文后
    // 按钮上还写着"English"（点不动你自己）
    var buttons = doc ? doc.querySelectorAll('[data-lang-switch]') : []
    var other = LANGS.filter(function (l) { return l.code !== lang })[0]
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].textContent = other ? other.label : ''
      buttons[i].setAttribute('title', t('common.langSwitch'))
    }

    // <title> 不是普通元素，单独处理（属性挂在 <html> 上）
    var titleKey = doc && doc.documentElement && doc.documentElement.getAttribute('data-i18n-title')
    if (titleKey && doc) doc.title = t(titleKey)

    // 广播一次，让**页面之外**依赖语言的东西也能跟上。
    // 目前只有 PWA 的 manifest 用它（应用名要跟着语言走，
    // 否则切了语言、加到主屏幕上的名字还是旧的）。
    try {
      if (doc && global.CustomEvent && doc.dispatchEvent) {
        doc.dispatchEvent(new global.CustomEvent('flicker:lang', { detail: { lang: lang } }))
      }
    } catch (e) { /* 没有 CustomEvent 就算了，不影响界面 */ }

    return true
  }

  function getLang() { return lang }

  var api = { t: t, apply: apply, setLang: setLang, getLang: getLang, LANGS: LANGS }
  global.FlickerI18N = api

  // ── 自动就位 ────────────────────────────────────────────────
  function boot() {
    setLang(lang)
    var buttons = doc ? doc.querySelectorAll('[data-lang-switch]') : []
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener('click', function (ev) {
        ev.preventDefault()
        var next = LANGS.filter(function (l) { return l.code !== lang })[0]
        if (next) setLang(next.code)
      })
    }
  }

  if (doc) {
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot)
    else boot()
  }
})(
  typeof globalThis !== 'undefined' ? globalThis : this,
  typeof document !== 'undefined' ? document : null,
  // 存储：**由内联器按页面替换占位符**（见 gen/inline-i18n.mjs）。
  //   · 接收端 → sessionStorage（关标签即消失）
  //   · 发送端 → localStorage
  // 用占位符而不是"两个都传进来再挑一个"，是为了让**接收端页面里
  // 根本不出现 localStorage 这个名字** —— 否则"不留跨会话痕迹"这条承诺
  // 就只能靠注释解释"虽然出现了但没用"，静态检查也失效。
  // 隐私模式下"访问"存储对象本身就会抛，所以整个取值都要包起来。
  (function () {
    try { return typeof __I18N_STORE__ !== 'undefined' ? __I18N_STORE__ : null } catch (e) { return null }
  })(),
  // navigator 也走参数（见 detect() 里的说明：global.navigator 会遮蔽注入）
  (function () { try { return typeof navigator !== 'undefined' ? navigator : null } catch (e) { return null } })()
)
