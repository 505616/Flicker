/**
 * 把 PWA 元数据（manifest + 图标）内联进 web/*.html。
 *
 * ── 为什么不用常规做法 ─────────────────────────────────────────
 *
 * 常规 PWA 要三个文件：`manifest.webmanifest` + 两个 PNG 图标，
 * 再用 `<link rel="manifest" href="/manifest.webmanifest">` 引它们。
 *
 * 这个项目做不到 —— 接收端页面会被：
 *   · 发送端从**局域网自签 HTTPS** 直接发出
 *   · relay 从 **HTTPS** 发出（`relay/page.generated.js` 是同一份 HTML）
 * 两处的路径、协议、可达的文件都不一样。多出三个文件意味着
 * relay 的部署步骤又要多三步，而且任何一个路径写错就是"装不上、还不报错"。
 *
 * 所以：整份 manifest 作为 **data URL** 放在 `<link rel="manifest">` 里，
 * 图标也用 **SVG data URL**。**一个额外文件都不需要**，
 * 与页面"单文件、零外部请求"的约束一致。
 *
 * ── manifest 内容为什么要动态生成 ──────────────────────────────
 *
 * 应用名要跟随界面语言（中文"闪传" / 英文"Flicker"）。
 * 静态 manifest 做不到这一点 —— 它是一份文件，只有一种名字。
 * 所以这里只写**一段用 i18n 取词的脚本**，运行时拼出 manifest。
 *
 * 用法：
 *   node gen/inline-pwa.mjs          # 内联
 *   node gen/inline-pwa.mjs --check  # 只校验是否同步（CI 用）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { icons, COLORS } from './pwa-assets.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PAGES = ['web/receiver.html', 'web/station.html'].map((p) => path.join(ROOT, p))

const BEGIN = '<!-- pwa:begin —— 这一整段由 gen/inline-pwa.mjs 生成，请勿手改 -->'
const END = '<!-- pwa:end -->'

const checkOnly = process.argv.includes('--check')

/**
 * 生成要内联的脚本。
 *
 * 注意这里**不写死任何文案** —— manifest 里的名字从 i18n 取，
 * 所以切语言后重开（或重新加到主屏幕）会得到对应语言的应用名。
 */
function buildBlock() {
  const ic = icons()
  const data = {
    icons: ic,
    themeColor: COLORS.accent,
    background: COLORS.background,
  }

  return [
    BEGIN,
    `<script>`,
    `// PWA 元数据。由 gen/inline-pwa.mjs 从 gen/pwa-assets.mjs 生成。`,
    `// 图标与 manifest 都是 data URL —— **不产生任何外部请求**，`,
    `// 因为接收端可能在没有外网的局域网里打开。`,
    `(function () {`,
    `  'use strict'`,
    `  var A = ${JSON.stringify(data)};`,
    `  if (!document || !document.head) return`,
    ``,
    `  function meta(name, content) {`,
    `    var m = document.createElement('meta')`,
    `    m.setAttribute(name.indexOf(':') > 0 ? 'property' : 'name', name)`,
    `    m.setAttribute('content', content)`,
    `    document.head.appendChild(m)`,
    `  }`,
    ``,
    `  // ── manifest（data URL）────────────────────────────────────`,
    `  // 应用名跟随界面语言。t() 由 i18n 运行时提供；它没就位时退回页面上已有的中文名，`,
    `  // 不让"装到主屏幕上"变成一个没有名字的图标。`,
    `  function T(key, fallback) {`,
    `    try {`,
    `      var v = window.FlickerI18N && window.FlickerI18N.t(key)`,
    `      return (v && v !== key) ? v : fallback`,
    `    } catch (e) { return fallback }`,
    `  }`,
    ``,
    `  var mf = {`,
    `    name: T('app.name', '闪传') + ' Flicker',`,
    `    short_name: T('app.name', '闪传'),`,
    `    description: T('app.tagline', '一次性文件传输'),`,
    `    lang: document.documentElement.getAttribute('lang') || 'zh-CN',`,
    `    start_url: '.',`,
    `    scope: '.',`,
    `    display: 'standalone',`,
    `    orientation: 'any',`,
    `    background_color: A.background,`,
    `    theme_color: A.themeColor,`,
    `    icons: A.icons,`,
    `  }`,
    ``,
    `  var link = document.createElement('link')`,
    `  link.rel = 'manifest'`,
    `  link.href = 'data:application/manifest+json,' + encodeURIComponent(JSON.stringify(mf))`,
    `  document.head.appendChild(link)`,
    ``,
    `  // ── 图标与主题色 ───────────────────────────────────────────`,
    `  // apple-touch-icon 是给 iOS 的：Safari 不读 manifest 的 icons，`,
    `  // 只认这个 link。没有它，iOS 加到主屏幕会是页面的截图。`,
    `  var touch = document.createElement('link')`,
    `  touch.rel = 'apple-touch-icon'`,
    `  touch.href = A.icons[A.icons.length - 1].src`,
    `  document.head.appendChild(touch)`,
    ``,
    `  meta('theme-color', A.themeColor)`,
    `  meta('apple-mobile-web-app-capable', 'yes')`,
    `  meta('apple-mobile-web-app-status-bar-style', 'black-translucent')`,
    `  meta('apple-mobile-web-app-title', mf.short_name)`,
    ``,
    `  // 语言切换后应用名会变，重开时才能生效 —— 这里同步更新一下 manifest，`,
    `  // 免得"切了语言但主屏幕上的名字还是旧的"。`,
    `  window.addEventListener('flicker:lang', function () {`,
    `    mf.name = T('app.name', '闪传') + ' Flicker'`,
    `    mf.short_name = T('app.name', '闪传')`,
    `    mf.lang = document.documentElement.getAttribute('lang') || 'zh-CN'`,
    `    link.href = 'data:application/manifest+json,' + encodeURIComponent(JSON.stringify(mf))`,
    `  })`,
    `})()`,
    `</script>`,
    END,
  ].join('\n')
}

/** 源文件指纹：图标或颜色改了就要重新内联 */
function sourceDigest() {
  return createHash('sha256')
    .update(readFileSync(path.join(ROOT, 'gen', 'pwa-assets.mjs'), 'utf8'))
    .digest('hex').slice(0, 16)
}

function existingBlock(html) {
  const b = html.indexOf(BEGIN)
  const e = html.indexOf(END)
  return (b >= 0 && e > b) ? html.slice(b, e + END.length) : null
}

function inject(html, block) {
  const b = html.indexOf(BEGIN)
  const e = html.indexOf(END)
  if (b >= 0 && e > b) return html.slice(0, b) + block + html.slice(e + END.length)
  const headEnd = html.indexOf('</head>')
  if (headEnd < 0) throw new Error('页面里没有 </head>')
  return html.slice(0, headEnd) + block + '\n' + html.slice(headEnd)
}

const block = buildBlock()
const digest = sourceDigest()

let drifted = 0
for (const page of PAGES) {
  const rel = path.relative(ROOT, page).replace(/\\/g, '/')
  if (!existsSync(page)) { console.log(`  － ${rel} 不存在，跳过`); continue }
  const html = readFileSync(page, 'utf8')
  const now = existingBlock(html)

  if (checkOnly) {
    if (!now) { console.error(`  ✗ ${rel} 里没有 PWA 内联段`); drifted++; continue }
    // 图标是 data URL，比较字符串即可 —— 但整段很长，比指纹更实用的是直接比内容
    if (now !== block) {
      console.error(`  ✗ ${rel} 的 PWA 内联段与当前 gen/pwa-assets.mjs 不一致 —— ` +
        '改了图标或主题色之后要重跑 `node gen/inline-pwa.mjs`')
      drifted++
      continue
    }
    console.log(`  ✓ ${rel}`)
    continue
  }

  const next = inject(html, block)
  if (next === html) console.log(`  － ${rel} 已是最新`)
  else {
    writeFileSync(page, next, 'utf8')
    const delta = Buffer.byteLength(next) - Buffer.byteLength(html)
    console.log(`  ✓ ${rel}  ${delta >= 0 ? '+' : ''}${(delta / 1024).toFixed(1)} KB`)
  }
}

if (checkOnly) {
  if (drifted) { console.error(`\n${drifted} 个页面的 PWA 内联段需要更新`); process.exit(1) }
  console.log('\n✓ PWA 内联段都是最新的')
} else {
  console.log(`\n  manifest + 3 个图标 · 合计约 ${(block.length / 1024).toFixed(1)} KB（全部 data URL）`)
  console.log(`  指纹 ${digest}`)
}
