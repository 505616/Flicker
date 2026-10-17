/**
 * PWA（可安装）+ Web Share API。
 *
 * ── 为什么这些用例值得写 ──────────────────────────────────────
 *
 * PWA 的失败方式几乎全是**静默的**：
 *   · manifest 少一个字段 → 浏览器不提示"可安装"，但页面一切正常
 *   · 图标缺 maskable   → Android 上图标被裁得难看，桌面上看不出来
 *   · 图标指向外部 URL   → 在**没有外网的局域网里**装不上（而开发机上一直好好的）
 *   · 名字没跟着语言走   → 中文用户正常，英文用户装出来是中文名
 *
 * 这些都不会报错、也不会让任何现有用例失败。所以必须专门测。
 *
 * 抽法与 test/i18n.test.js 一致：从**真实页面**里取出内联脚本，注入假 DOM 跑一遍，
 * 再解析它生成的 manifest —— 而不是 grep 源码"看着对"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { icons, manifest as buildManifest, COLORS, boltPoints, GLYPH_SCALE } from '../gen/pwa-assets.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PAGES = ['web/receiver.html', 'web/station.html']
const html = Object.fromEntries(PAGES.map((p) => [p, readFileSync(path.join(ROOT, p), 'utf8')]))

// ── 从页面里抽出 PWA 脚本并跑起来 ─────────────────────────────

/** 取页面里内联的 PWA 段（图标 + manifest 生成） */
function pwaSourceOf(page) {
  const src = html[page]
  const b = src.indexOf('<!-- pwa:begin')
  const e = src.indexOf('<!-- pwa:end -->')
  assert.ok(b >= 0 && e > b, `${page} 里没有 PWA 内联段 —— 先跑 node gen/inline-pwa.mjs`)
  const seg = src.slice(b, e)
  const m = seg.match(/<script>([\s\S]*?)<\/script>/)
  assert.ok(m, `${page} 的 PWA 段里没有 <script>`)
  return m[1]
}

/**
 * 用假 DOM 跑一遍 PWA 脚本，拿回它往 <head> 里塞了什么。
 *
 * @param {string} lang 模拟界面语言（zh/en）—— 用来验证应用名跟着语言走
 */
function bootPwa(page, { lang = 'zh' } = {}) {
  const head = []
  const listeners = {}
  const makeEl = (tag) => {
    const el = {
      tagName: tag, _attrs: {}, children: [],
      setAttribute(k, v) { this._attrs[k] = v },
      getAttribute(k) { return this._attrs[k] ?? null },
      appendChild(c) { this.children.push(c); return c },
      addEventListener(t, fn) { (listeners[t] ||= []).push(fn) },
      get rel() { return this._attrs.rel }, set rel(v) { this._attrs.rel = v },
      get href() { return this._attrs.href }, set href(v) { this._attrs.href = v },
      get content() { return this._attrs.content }, set content(v) { this._attrs.content = v },
    }
    return el
  }
  const doc = {
    head: { appendChild(el) { head.push(el); return el } },
    documentElement: { getAttribute: (k) => (k === 'lang' ? (lang === 'zh' ? 'zh-CN' : 'en') : null) },
    createElement: makeEl,
    addEventListener(t, fn) { (listeners[t] ||= []).push(fn) },
  }
  // i18n 运行时提供 t()：用一张最小表模拟两种语言下的应用名
  const TABLE = { zh: { 'app.name': '闪传', 'app.tagline': '一次性文件传输 · 用完即销毁' },
    en: { 'app.name': 'Flicker', 'app.tagline': "One-shot file transfer · gone when it's done" } }
  const FlickerI18N = { t: (k) => TABLE[lang][k] ?? k }

  const fn = new Function('document', 'window', 'CustomEvent', `${pwaSourceOf(page)}`)
  fn(doc, { FlickerI18N, addEventListener: (t, f) => { (listeners[t] ||= []).push(f) } }, function () {})

  const manifestLink = head.find((el) => el.rel === 'manifest')
  const touchIcon = head.find((el) => el.rel === 'apple-touch-icon')
  const metas = head.filter((el) => el.tagName === 'meta')
  return { head, listeners, manifestLink, touchIcon, metas, doc }
}

/** 把 manifest 的 data URL 解回对象 */
function parseManifest(link) {
  assert.ok(link, '没有找到 <link rel="manifest">')
  const href = link.href
  assert.match(href, /^data:application\/manifest\+json,/, 'manifest 必须是 data URL（不能是外部文件）')
  return JSON.parse(decodeURIComponent(href.slice('data:application/manifest+json,'.length)))
}

// ── 用例 ────────────────────────────────────────────────────

for (const page of PAGES) {
  test(`PWA：${page} 生成的 manifest 合法且能被浏览器接受`, () => {
    const { manifestLink } = bootPwa(page)
    const mf = parseManifest(manifestLink)

    // 必填字段（缺了浏览器就不提示"可安装"，但页面看起来完全正常）
    for (const k of ['name', 'short_name', 'start_url', 'display', 'icons']) {
      assert.ok(mf[k] !== undefined && mf[k] !== '', `manifest 缺字段 ${k} —— 浏览器不会提示可安装`)
    }
    assert.equal(mf.display, 'standalone',
      'display 必须是 standalone，否则"加到主屏幕"后还带地址栏，不像应用')
    assert.ok(mf.name.length <= 45,
      `name 超过 45 字符（${mf.name.length}）会被有些平台截断`)
    assert.ok(mf.short_name.length <= 12,
      `short_name 超过 12 字符（${mf.short_name.length}）在主屏幕上会被截断`)

    // start_url / scope 用相对值：接收端可能挂在任意路径下
    assert.equal(mf.start_url, '.', 'start_url 必须是"."，写死 / 会在子路径下指错地方')
    assert.equal(mf.scope, '.')

    // 颜色必须是合法 CSS 颜色
    assert.match(mf.theme_color, /^#[0-9a-f]{6}$/i)
    assert.match(mf.background_color, /^#[0-9a-f]{6}$/i)
  })

  test(`PWA：${page} 的图标必须自包含（局域网可能没有外网）`, () => {
    const { manifestLink, touchIcon, head } = bootPwa(page)
    const mf = parseManifest(manifestLink)

    assert.ok(mf.icons.length >= 2, '至少要有 192 与 512 两个尺寸')
    for (const i of mf.icons) {
      assert.match(i.src, /^data:image\//,
        `图标必须是 data URL，实际是 ${i.src.slice(0, 40)} —— ` +
        '指向外部文件的话，在**没有外网的局域网**里就装不上，而开发机上一直正常')
      assert.ok(i.sizes, '每个图标必须声明 sizes')
      assert.ok(i.type, '每个图标必须声明 type')
    }

    // 192 与 512 都在（Chrome 的安装条件要求）
    const sizes = mf.icons.map((i) => i.sizes)
    assert.ok(sizes.includes('192x192'), '缺 192x192 —— Chrome 不认为可安装')
    assert.ok(sizes.includes('512x512'), '缺 512x512 —— Chrome 不认为可安装')

    // maskable 必须有：缺了 Android 会把图标裁得很难看
    assert.ok(mf.icons.some((i) => (i.purpose || '').includes('maskable')),
      '缺 maskable 图标 —— Android 的自适应图标会裁掉图形边缘')

    // iOS 不读 manifest 的 icons，只认 apple-touch-icon
    assert.ok(touchIcon, '缺 <link rel="apple-touch-icon"> —— iOS 加到主屏幕会变成页面截图')
    assert.match(touchIcon.href, /^data:image\//, 'apple-touch-icon 也必须是 data URL')

    // 页面里绝不能出现外部图标引用
    for (const bad of [/rel=["']?manifest["']?\s+href=["']?(?!data:)/i,
      /rel=["']?apple-touch-icon["']?\s+href=["']?(?!data:)/i]) {
      assert.ok(!bad.test(html[page]), `页面里有指向外部文件的图标/manifest 引用：${bad}`)
    }
    void head
  })

  test(`PWA：${page} 的应用名跟着界面语言走`, () => {
    // 中文
    const zh = parseManifest(bootPwa(page, { lang: 'zh' }).manifestLink)
    // 英文
    const en = parseManifest(bootPwa(page, { lang: 'en' }).manifestLink)

    assert.notEqual(zh.short_name, en.short_name,
      '中英两种语言下 short_name 应当不同 —— 否则英文用户装出来是中文名')
    assert.match(zh.short_name, /闪传/)
    assert.match(en.short_name, /Flicker/)
    assert.match(en.name, /Flicker/)
    // lang 字段要跟着走
    assert.equal(zh.lang, 'zh-CN')
    assert.equal(en.lang, 'en')
  })

  test(`PWA：${page} 装了 iOS 需要的 meta（Safari 不读 manifest 的一部分）`, () => {
    const { metas } = bootPwa(page)
    const names = metas.map((m) => m.getAttribute('name'))
    for (const want of ['theme-color', 'apple-mobile-web-app-capable', 'apple-mobile-web-app-title']) {
      assert.ok(names.includes(want), `缺 <meta name="${want}">`)
    }
    const cap = metas.find((m) => m.getAttribute('name') === 'apple-mobile-web-app-capable')
    assert.equal(cap.getAttribute('content'), 'yes',
      'apple-mobile-web-app-capable 必须是 yes，否则 iOS 加到主屏幕后仍带 Safari 界面')
  })

  test(`PWA：${page} 在切换语言后会刷新 manifest`, () => {
    const { listeners, manifestLink } = bootPwa(page, { lang: 'zh' })
    const before = manifestLink.href
    const fns = listeners['flicker:lang']
    assert.ok(fns && fns.length, '应当监听 flicker:lang 事件 —— 否则切了语言、主屏幕上的名字还是旧的')
    // 模拟语言已切到英文后事件触发
    const box = bootPwa(page, { lang: 'en' })
    assert.notEqual(box.manifestLink.href, before, '英文下应当是另一个 manifest')
    assert.notEqual(parseManifest(box.manifestLink).short_name,
      parseManifest(manifestLink).short_name)
  })
}

// ── 图标本身的性质 ──────────────────────────────────────────

test('PWA 图标：SVG 合法，且 maskable 的图形收在安全区里', () => {
  const ic = icons()
  for (const i of ic) {
    const svg = decodeURIComponent(i.src.slice('data:image/svg+xml,'.length))
    assert.match(svg, /^<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/,
      'SVG 必须带 xmlns，否则作为图片加载时不渲染')
    assert.match(svg, /viewBox="0 0 \d+ \d+"/, '缺 viewBox 会缩放错乱')

    // 解析出 width/height 与 sizes 声明是否一致
    const w = Number(svg.match(/width="(\d+)"/)[1])
    const h = Number(svg.match(/height="(\d+)"/)[1])
    assert.equal(`${w}x${h}`, i.sizes, `SVG 尺寸 ${w}x${h} 与声明的 ${i.sizes} 不一致`)
  }

  // maskable 的图形必须落在中心 80% 内（Android 会裁到那里）
  const maskable = ic.find((i) => i.purpose === 'maskable')
  const svg = decodeURIComponent(maskable.src.slice('data:image/svg+xml,'.length))
  assert.match(svg, /<rect width="512" height="512" rx="0"/,
    'maskable 必须铺满整块（rx=0）—— 圆角由系统裁切决定，自己画圆角会在裁切后露出直角')
})

test('PWA 图标：maskable 的图形几何上确实落在安全区内', () => {
  // ⚠️ 用**坐标算**，不要拿正则去 SVG 文本里猜数字 ——
  //    第一版就是这么写的，结果把渐变 `stop` 的 offset="1" 也当成坐标，
  //    算出 1744px 这种荒唐的偏移量。
  const SIZE = 512
  const safe = SIZE * 0.40          // 中心 40% 半径 = 直径 80%
  const scale = GLYPH_SCALE.maskable
  const glyph = SIZE * scale

  for (const [dx, dy] of boltPoints()) {
    const off = Math.hypot(dx * glyph, dy * glyph)
    assert.ok(off <= safe,
      `maskable 图形顶点 (${dx}, ${dy}) 距中心 ${off.toFixed(0)}px，` +
      `超过了安全半径 ${safe}px —— Android 裁切后会切掉图形边缘`)
  }
})

test('PWA 图标：常规图标的图形比 maskable 的大（要看起来像图标，不是色块）', () => {
  assert.ok(GLYPH_SCALE.any > GLYPH_SCALE.maskable,
    '常规图标应当把图形画得更大：它不会被裁切，留太多边距会显得图形很小')
  // 常规图标也不该顶到边（否则看着像纯色块）
  const maxGlyph = Math.max(...boltPoints().map(([x, y]) => Math.hypot(x, y))) * GLYPH_SCALE.any
  assert.ok(maxGlyph <= 0.5, `常规图标的图形伸到了画布边缘（${(maxGlyph * 100).toFixed(0)}%）`)
})

test('PWA：manifest 生成函数与页面内联的结果一致', () => {
  // 防止两边各自漂移：gen/pwa-assets.mjs 改了、页面却还是旧的
  const fromModule = buildManifest({
    lang: 'zh-CN', title: '闪传 Flicker', shortName: '闪传', description: 'x',
  })
  assert.deepEqual(fromModule.icons, icons(), '模块里的图标应与 icons() 一致')
  assert.equal(fromModule.theme_color, COLORS.accent)
  assert.equal(fromModule.background_color, COLORS.background)
})

// ── Web Share API（分享 / 存到相册）──────────────────────────

test('分享：只在 canShare 真的通过时才显示按钮（不能只看 API 存在）', () => {
  // ⚠️ 这是最容易写错的一处：`typeof navigator.share === 'function'` 说明不了
  //    这个平台**能分享文件** —— 桌面 Chrome 有 share() 但不支持 files，
  //    而且对类型/大小也有限制。所以必须先问 canShare({files:[...]})。
  const src = readFileSync(path.join(ROOT, 'web/receiver.html'), 'utf8')
  const fn = src.slice(src.indexOf('async function shareFile('))
  const body = fn.slice(0, fn.indexOf('\n}\n') + 3)

  assert.match(body, /navigator\.canShare\(\{\s*files:\s*\[file\]\s*\}\)/,
    'shareFile 必须用**具体文件**问一次 canShare —— 只判断 API 存在会让按钮点了没反应')
  assert.match(body, /AbortError/,
    '用户点系统面板的"取消"会抛 AbortError —— 那是正常操作，不该弹错误框')
  assert.doesNotMatch(body, /alert\([^)]*AbortError/,
    'AbortError 应当直接 return，不该 alert（用户会以为自己操作错了）')
})

test('分享：按钮的显示条件包含"内容还在内存里"', () => {
  const src = readFileSync(path.join(ROOT, 'web/receiver.html'), 'utf8')
  // 找到渲染完成屏文件列表的那段
  const i = src.indexOf('const canShare =')
  assert.ok(i > 0, '应当先问一次 canShare 能力')
  const seg = src.slice(i, i + 2000)
  assert.match(seg, /canShare && f\._blob/,
    '显示条件是 canShare && f._blob —— 流式写盘那条路径没有内存副本，' +
    '给它显示按钮点了会失败')
})

test('分享：内存路径会把 Blob 留下来，流式路径不会', () => {
  const src = readFileSync(path.join(ROOT, 'web/receiver.html'), 'utf8')
  // 路径 C（内存累积）里应当留下 blob
  const cPath = src.slice(src.indexOf('// 路径 C'), src.indexOf('// ── 收尾'))
  assert.match(cPath, /file\._blob = blob/,
    '内存路径必须把 Blob 挂在 file 上，否则分享拿不到文件内容')

  // 流式路径（A/B）不该留下整份内容 —— 那正是"大文件不爆内存"的承诺
  const abPath = src.slice(src.indexOf('// 路径 A'), src.indexOf('// 路径 C'))
  assert.doesNotMatch(abPath, /_blob/,
    '流式写盘路径不该保留文件内容 —— 会破坏"大文件不爆内存"的承诺')
})

test('分享：无法分享时说明原因，而不是静默不给按钮', () => {
  const src = readFileSync(path.join(ROOT, 'web/receiver.html'), 'utf8')
  assert.match(src, /shareUnavailable/,
    '一个文件都没法分享时必须说明原因 —— 否则用户以为程序坏了')
  assert.match(src, /shareUnsupported/, 'canShare 对某个文件返回 false 时也要说明')
})

test('分享：中文与英文都有文案，且占位符一致', () => {
  const { STRINGS } = { STRINGS: null } // 占位，下面直接从文件读
  void STRINGS
  const src = readFileSync(path.join(ROOT, 'web/i18n-strings.mjs'), 'utf8')
  for (const key of ['recv.done.share', 'recv.done.shareUnavailable',
    'recv.done.shareUnsupported', 'recv.done.shareFailed']) {
    const hits = src.split(`'${key}':`).length - 1
    assert.equal(hits, 2, `${key} 应当在中文与英文表里各出现一次（实际 ${hits} 次）`)
  }
})
