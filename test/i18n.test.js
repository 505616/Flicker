/**
 * 界面双语（i18n）。
 *
 * 为什么这些用例值得写：i18n 有三类错误**在中文环境下完全看不出来** ——
 *
 *   ① **英文缺词**。`t()` 会退回中文，所以中文界面一切正常，
 *      只有把语言切成英文才会发现满屏中文。
 *   ② **占位符对不上**。中文写 `{n}`、英文写成 `{count}`，
 *      于是英文界面显示字面的 "{count}" —— 而中文界面永远是对的。
 *   ③ **硬编码文案**。新加的元素忘了加 data-i18n，中文照常显示，
 *      英文界面那一处永远是中文。
 *
 * 三类都只影响非中文用户，而这个项目的主要读者恰恰可能是英文用户
 * （英文 README 已经把英文用户引到这份界面上了）。
 *
 * 抽取方式与 test/receiver-page.test.js 一致：从**真实页面**里取出内联脚本，
 * 用注入的假 DOM 跑一遍，而不是读源码"觉得对"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PAGES = ['web/receiver.html', 'web/station.html'].map((p) => path.join(ROOT, p))
const html = Object.fromEntries(
  PAGES.map((p) => [path.relative(ROOT, p).replace(/\\/g, '/'), readFileSync(p, 'utf8')]))

// ── 从页面里抽出 i18n 数据与运行时 ────────────────────────────

/** 把 HTML 注释与内联脚本段去掉，避免从**文档示例**里假匹配出键名 */
function stripCommentsAndScripts(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
}

/** 取页面里内联的那段 i18n 脚本（文案表 + 运行时） */
function i18nSourceOf(page) {
  const src = html[page]
  const b = src.indexOf('<!-- i18n:begin')
  const e = src.indexOf('<!-- i18n:end -->')
  assert.ok(b >= 0 && e > b, `${page} 里没有 i18n 内联段 —— 先跑 node gen/inline-i18n.mjs`)
  const seg = src.slice(b, e)
  const m = seg.match(/<script>([\s\S]*?)<\/script>/)
  assert.ok(m, `${page} 的内联段里没有 <script>`)
  return m[1]
}

/** 取内联的文案表（JSON 字面量，parse 即可，不需要求值） */
function tableOf(page) {
  const m = i18nSourceOf(page).match(/globalThis\.__I18N__ = (\{[\s\S]*?\});\n/)
  assert.ok(m, '应当能从内联段里取出文案表 JSON')
  return JSON.parse(m[1])
}

/**
 * 页面里真正标注了 data-i18n 的元素（只看标签，不看注释与脚本）。
 * 注释里那些 `data-i18n="key"` 是**文档示例**，不参与断言 ——
 * 第一版没剔除注释，于是从示例里匹配出一个不存在的键 "key"。
 */
function annotatedKeys(page) {
  const clean = stripCommentsAndScripts(html[page])
  const keys = new Set()
  for (const m of clean.matchAll(/data-i18n="([^"]+)"/g)) keys.add(m[1])
  for (const m of clean.matchAll(/data-i18n-attr="([^"]+)"/g)) {
    for (const pair of m[1].split(',')) {
      const k = pair.split(':')[1]
      if (k) keys.add(k.trim())
    }
  }
  return [...keys]
}

/**
 * 在受控环境里跑一遍内联脚本，拿回它的 API。
 *
 * 用 `new Function('document','localStorage', ...)`：参数会**遮蔽**真全局，
 * 所以既不需要动 globalThis，也不会污染其他测试。
 */
function bootI18n(page, { lang, storage } = {}) {
  const src = i18nSourceOf(page)
  const calls = { text: [], attrs: [], html: [] }

  const makeEl = (attrs = {}) => {
    const el = {
      _attrs: { ...attrs },
      textContent: '',
      innerHTML: '',
      title: '',
      getAttribute(k) { return this._attrs[k] ?? null },
      setAttribute(k, v) { this._attrs[k] = v },
      hasAttribute(k) { return k in this._attrs },
      addEventListener() {},
    }
    return el
  }

  // 页面上真实存在的 data-i18n / data-i18n-attr，用于验证"每一条都翻得出来"。
  // ⚠️ 用剔除注释后的文本 —— 注释里的 `data-i18n="key"` 是文档示例，不是真元素。
  const clean = stripCommentsAndScripts(html[page])
  const textEls = []
  const attrEls = []
  for (const m of clean.matchAll(/<([a-z0-9-]+)([^>]*\bdata-i18n="([^"]+)"[^>]*)>/gi)) {
    textEls.push(makeEl({ 'data-i18n': m[3], ...(/\bdata-i18n-html\b/.test(m[2]) ? { 'data-i18n-html': '' } : {}) }))
  }
  for (const m of clean.matchAll(/data-i18n-attr="([^"]+)"/g)) {
    // 一个元素上可能挂多个属性（"placeholder:k1,aria-label:k2"），
    // 每个属性算一处替换 —— 与运行时 apply() 的计数方式保持一致
    for (const pair of m[1].split(',')) {
      if (pair.includes(':')) attrEls.push(makeEl({ 'data-i18n-attr': pair.trim() }))
    }
  }

  const doc = {
    readyState: 'complete',
    title: '',
    documentElement: makeEl({ lang: 'zh-CN' }),
    querySelectorAll(sel) {
      if (sel === '[data-i18n]') return textEls
      if (sel === '[data-i18n-attr]') return attrEls
      return []
    },
    addEventListener() {},
  }
  // 每次 setLang 之后把内容记下来，便于断言
  for (const el of textEls) {
    let v = ''
    Object.defineProperty(el, 'textContent', {
      get: () => v,
      set: (x) => { v = x; calls.text.push(x) },
    })
  }

  const ls = {
    _d: { ...(storage ?? {}) },
    getItem(k) { return this._d[k] ?? null },
    setItem(k, v) { this._d[k] = v },
  }

  // ⚠️ 接收端用 sessionStorage（关标签即消失），发送端才用 localStorage。
  //    内联器会按页面把运行时里的 __I18N_STORE__ 替换掉，所以这里两个都注入 ——
  //    谁被用到取决于被测页面。
  const fn = new Function('document', 'localStorage', 'sessionStorage', 'navigator',
    `${src}\nreturn globalThis.FlickerI18N`)
  const api = fn(doc, ls, ls, lang ? { languages: [lang] } : { languages: [] })
  return { api, doc, ls, calls, textEls, attrEls }
}

// ── 用例 ────────────────────────────────────────────────────

for (const page of Object.keys(html)) {
  test(`i18n：${page} 里内联的运行时能跑起来并给出 API`, () => {
    const { api } = bootI18n(page, { lang: 'en' })
    assert.ok(api, '页面里应当能拿到 globalThis.FlickerI18N')
    assert.equal(typeof api.t, 'function')
    assert.equal(typeof api.setLang, 'function')
    assert.equal(typeof api.getLang, 'function')
  })
}

test('i18n：中英两套的**键完全一致**（一边缺词在中文界面看不出来）', () => {
  const { api } = bootI18n('web/receiver.html', { lang: 'zh' })
  const table = tableOf('web/receiver.html')
  assert.ok(table.zh && table.en, '应当有 zh 与 en 两张表')

  const zhKeys = Object.keys(table.zh).sort()
  const enKeys = Object.keys(table.en).sort()
  const missingEn = zhKeys.filter((k) => !(k in table.en))
  const missingZh = enKeys.filter((k) => !(k in table.zh))
  assert.deepEqual(missingEn, [], `英文表缺这些键：${missingEn.join(', ')}`)
  assert.deepEqual(missingZh, [], `中文表缺这些键：${missingZh.join(', ')}`)
  assert.ok(zhKeys.length > 50, `文案条数偏少（${zhKeys.length}），像是没抽完`)

  // 空值也是"缺词"的一种
  for (const [lang, tbl] of Object.entries(table)) {
    const empty = Object.entries(tbl).filter(([, v]) => !String(v).trim()).map(([k]) => k)
    assert.deepEqual(empty, [], `${lang} 表里这些键是空的：${empty.join(', ')}`)
  }
  void api
})

test('⭐ i18n：占位符在两种语言里必须**一一对应**', () => {
  // 中文写 {n}、英文写成 {count} 的话，英文界面会显示字面的 "{count}"，
  // 而中文界面永远是对的 —— 只有这条用例能发现。
  const table = tableOf('web/receiver.html')

  const names = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
  const bad = []
  for (const key of Object.keys(table.zh)) {
    const a = names(table.zh[key])
    const b = names(table.en[key] ?? '')
    if (a.join(',') !== b.join(',')) {
      bad.push(`${key}: 中文 {${a.join(',')}} vs 英文 {${b.join(',')}}`)
    }
  }
  assert.deepEqual(bad, [],
    '占位符必须两边一致，否则另一种语言会显示字面的 {xxx}：\n  ' + bad.join('\n  '))
})

test('i18n：HTML 里引用的每个键都存在于表中', () => {
  const table = tableOf('web/receiver.html')

  // ⚠️ 只看**标签**上的标注，不看注释 ——
  //    注释里那些 `data-i18n="key"` 是文档示例，第一版没剔除注释，
  //    于是从示例里匹配出一个根本不存在的键 "key" 而误报。
  const used = new Set()
  for (const page of Object.keys(html)) {
    for (const k of annotatedKeys(page)) used.add(k)
  }
  const unknown = [...used].filter((k) => !(k in table.zh))
  assert.deepEqual(unknown, [],
    `HTML 里引用了表中没有的键：${unknown.join(', ')}`)
  assert.ok(used.size > 10, `页面里应当已经标注了若干 data-i18n（实际 ${used.size} 个）`)
})

test('i18n：切换语言后 t() 立刻给出另一种语言', () => {
  const { api } = bootI18n('web/receiver.html', { lang: 'zh' })
  const zh = api.t('recv.pw.start')
  assert.equal(api.setLang('en'), true)
  const en = api.t('recv.pw.start')
  assert.notEqual(zh, en, '切换语言后取到的文案必须变了')
  assert.equal(api.getLang(), 'en')
  assert.equal(api.setLang('zh'), true)
  assert.equal(api.t('recv.pw.start'), zh, '切回来应当与原来一致')
})

test('i18n：占位符会被替换（而不是留字面的 {n}）', () => {
  const { api } = bootI18n('web/receiver.html', { lang: 'zh' })
  const zh = api.t('recv.msg.moreFiles', { n: 3 })
  assert.match(zh, /3/, '数字应当被填进去')
  assert.doesNotMatch(zh, /\{n\}/, '不该留下未替换的占位符')

  api.setLang('en')
  const en = api.t('recv.msg.moreFiles', { n: 3 })
  assert.match(en, /3/)
  assert.doesNotMatch(en, /\{n\}/)
  assert.notEqual(zh, en, '中英语序不同，两句应当不一样')
})

test('⭐ i18n：缺词时退回键名（刺眼好排查），而不是静默空白', () => {
  const { api } = bootI18n('web/receiver.html', { lang: 'en' })
  assert.equal(api.t('no.such.key.exists'), 'no.such.key.exists',
    '缺词应返回键名 —— 界面上出现 "recv.pw.title" 这种字样一眼就能看出漏了哪条，' +
    '静默显示空白反而难查')
})

test('i18n：非法的语言代码不会被接受（避免把界面弄成空白）', () => {
  const { api } = bootI18n('web/receiver.html', { lang: 'zh' })
  const before = api.getLang()
  assert.equal(api.setLang('klingon'), false, '不支持的语言应返回 false')
  assert.equal(api.getLang(), before, '语言不应被改掉')
  assert.ok(api.t('recv.pw.start'), '界面仍应能取到文案')
})

test('i18n：浏览器语言为英文时自动选英文', () => {
  const { api } = bootI18n('web/receiver.html', { lang: 'en-US' })
  assert.equal(api.getLang(), 'en', 'en-US 应当归到 en')
})

test('i18n：浏览器语言是中文（含 zh-CN / zh-Hans-CN）时选中文', () => {
  for (const tag of ['zh', 'zh-CN', 'zh-Hans-CN', 'zh-TW']) {
    const { api } = bootI18n('web/receiver.html', { lang: tag })
    assert.equal(api.getLang(), 'zh', `${tag} 应当归到 zh`)
  }
})

test('i18n：这次会话里选过的语言优先于浏览器语言', () => {
  const { api } = bootI18n('web/receiver.html', { lang: 'en-US', storage: { 'flicker.lang': 'zh' } })
  assert.equal(api.getLang(), 'zh',
    '用户选过的应当优先于浏览器语言 —— 否则每次打开都被改回去')
})

test('i18n：只往存储里写语言这一个键（不夹带别的）', () => {
  // 接收端承诺过"不写跨会话的持久化存储"。语言偏好存在 sessionStorage 里
  // （关标签即消失），但必须确认没顺手写别的键 ——
  // 一旦写了别的，就得逐个向用户解释那是干什么的。
  const { api, ls } = bootI18n('web/receiver.html', { lang: 'zh' })
  api.setLang('en')
  const keys = Object.keys(ls._d)
  assert.deepEqual(keys, ['flicker.lang'],
    `只应写入语言偏好这一个键，实际写了：${keys.join(', ')}`)
})

test('⭐ i18n：发送端界面也能真正翻成英文（不只是属性加上了）', () => {
  // 只验证"元素上有 data-i18n"是不够的 —— 那只能说明标注了，
  // 说明不了**翻得出来**。这里真的跑一遍替换并检查产出的文字。
  const { api, textEls } = bootI18n('web/station.html', { lang: 'en' })
  assert.ok(textEls.length >= 20,
    `发送端应当标注了若干元素，实际 ${textEls.length} 个`)

  const n = api.apply()
  assert.ok(n > 0, 'apply() 应当替换了内容')

  const got = textEls.map((el) => el.textContent).filter(Boolean)
  const chineseLeft = got.filter((s) => /[\u4e00-\u9fff]/.test(s))
  assert.deepEqual(chineseLeft, [],
    `切到英文后这些元素里还有中文：\n  ${chineseLeft.join('\n  ')}`)

  // 抽查几句关键文案确实是英文
  assert.equal(api.t('send.pick.files'), 'Choose files')
  assert.equal(api.t('send.start'), 'Start transfer')
  assert.match(api.t('send.foot'), /loopback/)
})

test('⭐ i18n：接收端界面切到英文后不留中文', () => {
  const { api, textEls } = bootI18n('web/receiver.html', { lang: 'en' })
  api.apply()
  const got = textEls.map((el) => el.textContent).filter(Boolean)
  const chineseLeft = got.filter((s) => /[\u4e00-\u9fff]/.test(s))
  assert.deepEqual(chineseLeft, [],
    `切到英文后这些元素里还有中文：\n  ${chineseLeft.join('\n  ')}`)
})

test('⭐ i18n：两个页面都装了语言切换按钮，而且要看得见', () => {
  // 用户的原话："语言切换的按键不够显眼"。原来是一个灰字透明底的小胶囊，
  // 混在页头里几乎看不见 —— 而**需要它的人恰恰是看不懂当前界面的人**。
  // 所以这里不只断言"按钮存在"，还断言它带主色（.accent）和底色。
  for (const page of Object.keys(html)) {
    assert.match(html[page], /data-lang-switch/,
      `${page} 里没有语言切换按钮 —— 用户就没法切语言了`)

    const css = html[page].slice(html[page].indexOf('.lang-switch{'),
      html[page].indexOf('.lang-switch:hover'))
    assert.ok(css.length > 40, `${page} 里找不到 .lang-switch 的样式`)
    // 主色文字 + 主色淡底 + 描边：三样至少要在，否则又退回"灰字看不见"
    assert.match(css, /var\(--accent\)/, `${page} 的语言按钮没有用主色，会淹没在页头里`)
    assert.match(css, /background:var\(--accent-soft\)/,
      `${page} 的语言按钮没有底色 —— 灰字透明底就是用户抱怨的那个样子`)
    assert.match(css, /border:1px solid/, `${page} 的语言按钮没有描边`)
    // 地球图标：不能写进 HTML（按钮文字是运行时 set textContent 填的，会被冲掉）
    assert.match(html[page], /\.lang-switch::before\{content:'🌐'/,
      `${page} 的语言按钮要有地球图标，且必须走 ::before`)
    assert.match(html[page], /<button class="lang-switch"[^>]*><\/button>/,
      `${page} 的语言按钮文字必须留空、由运行时填（写死的话切完语言还写着旧语言的名字）`)
  }
})

test('i18n：apply() 会替换所有标注过的元素', () => {
  const { api, textEls, attrEls } = bootI18n('web/receiver.html', { lang: 'en' })
  assert.ok(textEls.length > 0, '页面里应当有 data-i18n 元素')
  const n = api.apply()
  // apply() 的返回值是**替换处数**：文本元素 + 属性替换（每个属性算一处），
  // 所以不能只跟 textEls.length 比 —— 第一版就是这么误报的。
  const expect = textEls.length + attrEls.length
  assert.equal(n, expect,
    `应替换 ${expect} 处（文本 ${textEls.length} + 属性 ${attrEls.length}），实际 ${n} 处`)
  for (const el of textEls) {
    assert.ok(el.textContent && el.textContent.length,
      '替换后不该有元素是空的')
    assert.doesNotMatch(el.textContent, /^[a-z]+(\.[a-z]+)+$/i,
      `元素内容是键名「${el.textContent}」—— 说明这个键在表里没有`)
  }
})
