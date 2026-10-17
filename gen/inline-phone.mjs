/**
 * 把手机上传页的协议内核内联进 web/phone.html
 * ===========================================
 *
 * 与 `gen/inline-path-rules.mjs` 是同一套路子，只是来源不同：
 *   · 路径规则来自 Node 侧（`src/path-safety.js`，同一份实现给两边用）
 *   · 手机内核本身就是浏览器代码（`web/phone-core.js`），原样搬进去即可
 *
 * 为什么必须内联：这一页会被电脑上的 HTTPS 服务送出，而页面必须**自包含**
 * （CSP 不许外部脚本；单文件产物里也没有"旁边的 js 文件"可读）。
 * 多一个 URL 就多一处会 404 的地方，而 404 的表现是"页面点了没反应"。
 *
 * ── 这里守的三条（都是"注入一段文本"特有的坑）──────────────
 *   ① 源文件里不许出现 `</script>` —— 那会**提前闭合**标签，后面的代码全变成页面文字；
 *   ② 不许有 import/require（内联后没有模块系统）；
 *   ③ 不许用 Buffer / process（浏览器里没有）。
 * 三条都在生成时检查，并有反向验证：往源文件里塞一个 `</script>` 会让这个脚本失败。
 *
 * 用法：
 *   node gen/inline-phone.mjs          # 内联
 *   node gen/inline-phone.mjs --check  # 只校验是否同步（CI 用）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { codeOnly } from './code-only.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/**
 * 源文件路径可以被环境变量改掉 —— **只给测试用**（与 `FLICKER_CHUNK_BYTES` 同一类旁路）。
 * 用途：证明下面那三条检查真的会失败（往副本里塞一个 `</script>` 看它拒不拒），
 * 否则"有检查"这件事本身就没被验过。
 */
const SRC = process.env.FLICKER_INLINE_PHONE_SRC
  ? path.resolve(process.env.FLICKER_INLINE_PHONE_SRC)
  : path.join(ROOT, 'web', 'phone-core.js')
const PAGES = (process.env.FLICKER_INLINE_PHONE_PAGE
  ? [process.env.FLICKER_INLINE_PHONE_PAGE]
  : ['web/phone.html']).map((p) => path.resolve(ROOT, p))

const BEGIN = '<!-- phone-core:begin —— 这一整段由 gen/inline-phone.mjs 从 web/phone-core.js 生成，请勿手改 -->'
const END = '<!-- phone-core:end -->'

const checkOnly = process.argv.includes('--check')

const EXPORTS = [
  'SUITE_ID', 'PARAMS', 'LABELS', 'MAC_PROFILES', 'MANIFEST_AAD',
  'concat', 'equalBytes', 'b64', 'unb64', 'hex',
  'pbkdf2Verifier', 'hkdfKeys', 'importAuth', 'importEnc',
  'macInput', 'senderMac', 'receiverMac', 'pickMacProfile',
  'chunkAAD', 'chunkIV', 'sealChunk', 'sealManifest', 'openManifest',
  'Sha256', 'sha256Hex',
]

function buildBlock() {
  const src = readFileSync(SRC, 'utf8')
  const code = codeOnly(src)

  // ① `</script>` 会把内联段**提前结束**，剩下的代码变成页面上的文字
  if (/<\/script/i.test(src)) {
    throw new Error('web/phone-core.js 里出现了 `</script` —— 内联进页面时会把标签提前闭合。' +
      '真要写这个字符串，请拆成两段拼（例如 "<" + "/script>"）')
  }
  // ② 内联后没有模块系统
  const imports = code.split('\n')
    .map((l, i) => ({ l, n: i + 1 }))
    .filter((x) => /^\s*(import|require)\b/.test(x.l))
  if (imports.length) {
    throw new Error(
      `web/phone-core.js 里有 import/require（第 ${imports.map((x) => x.n).join(', ')} 行）。\n` +
      '    它要被**原样内联**进页面，所以必须是普通浏览器脚本。')
  }
  // ③ 浏览器里没有 Buffer / process
  const hit = code.match(/\bBuffer\b|\bprocess\s*\./)
  if (hit) throw new Error(`web/phone-core.js 里用到了 ${hit[0]} —— 浏览器里没有这个`)

  // 接口清单与源码对不上也是漂移：文件里 export 的东西必须都在页面上拿得到
  for (const name of EXPORTS) {
    if (!new RegExp(`\\b${name}\\b`).test(code)) {
      throw new Error(`接口清单里的 ${name} 在 web/phone-core.js 里找不到 —— ` +
        '要么改了名字，要么漏了；请同步 gen/inline-phone.mjs 的 EXPORTS')
    }
  }

  const digest = createHash('sha256').update(src).digest('hex').slice(0, 16)
  return {
    block: [
      BEGIN,
      '<script>',
      '// ── 手机上传页的协议内核（PBKDF2 / HKDF / HMAC / AES-GCM / SHA-256）──────',
      '// 由 gen/inline-phone.mjs 从 web/phone-core.js 原样内联，请勿手改。',
      `// 源文件指纹 ${digest}`,
      '//',
      '// 它与 src/suite/flicker1.js（Node 侧）**逐字节等价**，由 test/phone-page.test.js 钉住：',
      '// 验证值、三把钥匙、两种握手 MAC、清单密文、分块密文、AAD、IV、SHA-256，任何一个字节',
      '// 不同都会让那条测试失败 —— 这类漂移的表现是"密码不一致"，离原因很远。',
      src.trimEnd(),
      '</script>',
      END,
    ].join('\n'),
    digest,
  }
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

const { block, digest } = buildBlock()

let drifted = 0
for (const page of PAGES) {
  const rel = path.relative(ROOT, page).replace(/\\/g, '/')
  if (!existsSync(page)) { console.log(`  － ${rel} 不存在，跳过`); continue }
  const html = readFileSync(page, 'utf8')
  const now = existingBlock(html)

  if (checkOnly) {
    if (!now) { console.error(`  ✗ ${rel} 里没有手机内核内联段`); drifted++; continue }
    if (now !== block) {
      console.error(`  ✗ ${rel} 的手机内核内联段与 web/phone-core.js 不一致 —— ` +
        '改了内核之后要重跑 `node gen/inline-phone.mjs`')
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
  if (drifted) { console.error(`\n${drifted} 个页面的手机内核内联段需要更新`); process.exit(1) }
  console.log('\n✓ 手机内核内联段都是最新的')
} else {
  console.log(`\n  协议内核 · 约 ${(block.length / 1024).toFixed(1)} KB · 指纹 ${digest}`)
}
