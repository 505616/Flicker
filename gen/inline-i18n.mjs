/**
 * 把 i18n 运行时与文案表内联进 web/*.html。
 *
 * ── 为什么是"内联回源文件"而不是生成另一份 .generated.html ──────
 *
 * 接收端页面必须保持**单文件、零外部请求**（局域网可能没有外网），
 * 所以文案表不能运行时 fetch。于是只剩两条路：
 *   A. 生成 `receiver.generated.html`，服务与中继都用它
 *   B. 内联回 `receiver.html` 本身
 *
 * 选 B。理由：选 A 的话 `receiver.html` 就成了"半成品源文件"，
 * 而 README、文档、`relay/page.generated.js` 全都指向它 ——
 * 以后一定有人直接打开源文件、发现界面是死的。宁可让源文件本身就是可用的成品。
 *
 * 代价是生成区域出现在源文件里。所以用**哨兵注释**圈起来，
 * 并在文件顶部写明"这段是生成的，别手改"。
 *
 * ── --check ─────────────────────────────────────────────────
 *   `node gen/inline-i18n.mjs --check` 只校验"已内联的内容与当前源文件一致"，
 *   不写盘。CI 里跑它，防止有人改了文案表却忘了重新内联。
 *
 * 用法：
 *   node gen/inline-i18n.mjs          # 内联（写盘）
 *   node gen/inline-i18n.mjs --check  # 只校验是否同步
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const STRINGS = path.join(ROOT, 'web', 'i18n-strings.mjs')
const RUNTIME = path.join(ROOT, 'web', 'i18n-runtime.js')
const PAGES = ['web/receiver.html', 'web/station.html', 'web/phone.html'].map((p) => path.join(ROOT, p))

const BEGIN = '<!-- i18n:begin —— 这一整段由 gen/inline-i18n.mjs 生成，请勿手改 -->'
const END = '<!-- i18n:end -->'

const checkOnly = process.argv.includes('--check')

/** 从 i18n-strings.mjs 里取出需要的导出（用真的 import，不靠正则解析） */
async function loadStrings() {
  const mod = await import(`file://${STRINGS.replace(/\\/g, '/')}?t=${Date.now()}`)
  return {
    table: mod.STRINGS,
    langs: mod.LANGS,
    defaultLang: mod.DEFAULT_LANG,
    key: mod.LANG_KEY,
  }
}

/**
 * 生成要内联的那段脚本。
 *
 * 文案表以 **JSON 字面量**塞进去 —— 不用 eval、不做模块打包。
 * 页面里它就是一份普通数据，任何工具都能读、浏览器也能读懂。
 *
 * @param {boolean} persist 是否跨会话记住语言偏好。
 *   · 发送端 → true：用户自己的机器，会反复用，记住更省事。
 *   · 接收端 → **false**：那是对方的一次性页面，对它的承诺是"不留痕迹"。
 *     在浏览器里留一条记录本身就是痕迹，不该为省一次点击破例。
 *     接收端只在本次会话内用 sessionStorage 记住（关标签即消失）。
 */
function buildBlock(strings, runtimeSrc, sourceDigest, persist) {
  const data = JSON.stringify(strings.table)
  const langs = JSON.stringify(strings.langs)

  const head = [
    BEGIN,
    `<script>`,
    `// 文案表与运行时。源文件：web/i18n-strings.mjs + web/i18n-runtime.js`,
    `// 源文件指纹 ${sourceDigest}（改了文案表就要重跑 node gen/inline-i18n.mjs）`,
    `globalThis.__I18N__ = ${data};`,
    `globalThis.__I18N_LANGS__ = ${langs};`,
    `globalThis.__I18N_KEY__ = ${JSON.stringify(strings.key)};`,
    `globalThis.__I18N_DEFAULT__ = ${JSON.stringify(strings.defaultLang)};`,
    `globalThis.__I18N_PERSIST__ = ${persist};`,
  ].join('\n')

  // 运行时是普通浏览器脚本（IIFE），原样内联即可。
  // 但要把存储占位符替换掉：接收端用 sessionStorage（关标签即消失），
  // 发送端用 localStorage（用户自己的机器，会反复用）。
  // 这样**接收端页面里根本不会出现 localStorage 这个名字** ——
  // "不留跨会话痕迹"于是可以被静态检查真正守住。
  const storeName = persist ? 'localStorage' : 'sessionStorage'
  const body = runtimeSrc.trimEnd().replaceAll('__I18N_STORE__', storeName)
  if (body.includes('__I18N_STORE__')) {
    throw new Error('运行时里的 __I18N_STORE__ 占位符没被全部替换 —— 检查拼写')
  }
  const tail = [`</script>`, END].join('\n')

  return { block: `${head}\n${body}\n${tail}`, bytes: data.length, storeName }
}

/** 源文件指纹：文案表 + 运行时，任一改动都要重新内联 */
function sourceDigest(stringsSrc, runtimeSrc) {
  return createHash('sha256')
    .update(stringsSrc).update('\0').update(runtimeSrc)
    .digest('hex').slice(0, 16)
}

/**
 * 把块插进页面。
 * · 已有哨兵 → 替换中间内容
 * · 没有     → 插在 </head> 之前（脚本要在页面脚本之前跑起来）
 */
function inject(html, block) {
  const b = html.indexOf(BEGIN)
  const e = html.indexOf(END)
  if (b >= 0 && e > b) {
    return html.slice(0, b) + block + html.slice(e + END.length)
  }
  const headEnd = html.indexOf('</head>')
  if (headEnd < 0) throw new Error('页面里没有 </head>，无法确定插入位置')
  return html.slice(0, headEnd) + block + '\n' + html.slice(headEnd)
}

/** 取出页面里已内联的那一段（没有则 null） */
function existingBlock(html) {
  const b = html.indexOf(BEGIN)
  const e = html.indexOf(END)
  return (b >= 0 && e > b) ? html.slice(b, e + END.length) : null
}

/**
 * 剥掉注释，只留代码。
 *
 * ⚠️ 检查"有没有用 localStorage"必须先剥注释 ——
 *    否则**解释"为什么不用它"的那段注释**会把检查触发掉。
 *    这个坑项目里踩过一次（`import.meta` 的检查被文档注释误伤），
 *    所以这里沿用同一套做法：先剥注释，再判断。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')   // 不误伤 https:// 里的 //
}

const strings = await loadStrings()
const stringsSrc = readFileSync(STRINGS, 'utf8')
const runtimeSrc = readFileSync(RUNTIME, 'utf8')
const digest = sourceDigest(stringsSrc, runtimeSrc)
// 只有发送端跨会话记住语言偏好；接收端与手机上传页都是对方的一次性页面，不留痕迹
const persistOf = (rel) => rel.includes('station')

let drifted = 0
for (const page of PAGES) {
  const rel = path.relative(ROOT, page).replace(/\\/g, '/')
  if (!existsSync(page)) {
    console.log(`  － ${rel} 不存在，跳过`)
    continue
  }
  const { block, storeName } = buildBlock(strings, runtimeSrc, digest, persistOf(rel))
  const html = readFileSync(page, 'utf8')
  const now = existingBlock(html)

  if (checkOnly) {
    if (!now) { console.error(`  ✗ ${rel} 里没有 i18n 内联段`); drifted++; continue }
    if (now !== block) {
      console.error(`  ✗ ${rel} 的内联段与当前文案表不一致 —— ` +
        '改了 web/i18n-strings.mjs 或 web/i18n-runtime.js 之后要重跑 ' +
        '`node gen/inline-i18n.mjs`')
      drifted++
      continue
    }
    // 顺带守住"接收端不许出现 localStorage"（剥注释后再查，
    // 否则解释"为什么不用它"的注释会把检查触发掉）
    if (!persistOf(rel) && stripComments(now).includes('localStorage')) {
      console.error(`  ✗ ${rel} 里出现了 localStorage —— 接收端不该留跨会话痕迹`)
      drifted++
      continue
    }
    console.log(`  ✓ ${rel}（存储：${storeName}）`)
    continue
  }

  const next = inject(html, block)
  if (next === html) {
    console.log(`  － ${rel} 已是最新`)
  } else {
    writeFileSync(page, next, 'utf8')
    const delta = Buffer.byteLength(next) - Buffer.byteLength(html)
    console.log(`  ✓ ${rel}  ${delta >= 0 ? '+' : ''}${(delta / 1024).toFixed(1)} KB`)
  }
}

if (checkOnly) {
  if (drifted) {
    console.error(`\n${drifted} 个页面的 i18n 内联段需要更新`)
    process.exit(1)
  }
  console.log('\n✓ i18n 内联段都是最新的')
} else {
  console.log(`\n  文案表 ${(JSON.stringify(strings.table).length / 1024).toFixed(1)} KB（JSON 字面量，不用 eval）`)
  console.log(`  指纹 ${digest}`)
}
