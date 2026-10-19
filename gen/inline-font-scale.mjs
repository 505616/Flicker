/**
 * 把「字号调节」控件内联进三个页面
 * ================================
 *
 * 与 `gen/inline-path-rules.mjs` 同一个套路：一份实现（`web/font-scale.js`），
 * 原样内联进 `web/station.html`、`web/receiver.html`、`web/phone.html`。
 *
 * ── 为什么不各写一份 ─────────────────────────────────────
 * 三个页面各写一份的下场是"只有手机页能调字号"或者"三份行为不一致"——
 * 这个项目已经因为"两份实现必然漂移"吃过好几次亏（见 `_lab/交接.md`）。
 *
 * ── 为什么必须内联，而不是 `<script src>` ──────────────────
 * 页面要**自包含**：接收端页面还会被中继托管、被手机通过自签 HTTPS 打开，
 * 多一个外部文件就多一处会 404 的地方；而且页面的 CSP 只允许内联脚本。
 *
 * ── 存储按页面替换 ────────────────────────────────────────
 * `web/font-scale.js` 里写的是占位符 `__FONT_SCALE_STORE__`：
 *   · 发送端（station）→ `localStorage`（这台电脑上记住偏好）
 *   · 接收端 / 手机页 → `sessionStorage`（关掉标签即消失）
 * 这样"接收端页面里根本不出现 localStorage 这个名字"那条承诺仍然成立
 * （`test/receiver-page.test.js` 会查），而偏好又能记住。
 *
 * 用法：
 *   node gen/inline-font-scale.mjs          # 内联
 *   node gen/inline-font-scale.mjs --check  # 只校验是否同步（CI 用）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const SRC = path.join(ROOT, 'web', 'font-scale.js')

export const BEGIN = '<!-- font-scale:begin —— 这一整段由 gen/inline-font-scale.mjs 从 web/font-scale.js 生成，请勿手改 -->'
export const END = '<!-- font-scale:end -->'

/** 每个页面用哪种存储（见文件头的说明） */
export const PAGES = [
  { file: 'web/station.html', store: 'localStorage' },
  { file: 'web/receiver.html', store: 'sessionStorage' },
  { file: 'web/phone.html', store: 'sessionStorage' },
]

/** 生成一段内联块（纯函数：只依赖源码文本与页面配置，便于判据直接验） */
export function buildBlock(src, store) {
  const code = src
    .replace(/__FONT_SCALE_STORE__/g, store)
    .split('\n')
    .map((l) => (l ? '  ' + l : l))
    .join('\n')
  return [
    BEGIN,
    '<script>',
    '// 字号调节（四档：100% / 115% / 130% / 150%）',
    '// 由 gen/inline-font-scale.mjs 从 web/font-scale.js 原样内联，请勿手改。',
    '(function () {',
    code,
    '})()',
    '</script>',
    END,
  ].join('\n')
}

/** 取出页面里已有的内联块（没有则 null） */
export function existingBlock(html) {
  const b = html.indexOf(BEGIN)
  const e = html.indexOf(END)
  return b >= 0 && e > b ? html.slice(b, e + END.length) : null
}

/** 把块插进页面（已有就替换；没有就插在 </head> 之前） */
export function inject(html, block) {
  const b = html.indexOf(BEGIN)
  const e = html.indexOf(END)
  if (b >= 0 && e > b) return html.slice(0, b) + block + html.slice(e + END.length)
  const headEnd = html.indexOf('</head>')
  if (headEnd < 0) throw new Error('页面里没有 </head>，无法确定插入位置')
  return html.slice(0, headEnd) + block + '\n' + html.slice(headEnd)
}

/** 源码指纹（--check 与日志用） */
export function sourceDigest(src) {
  return createHash('sha256').update(src).digest('hex').slice(0, 16)
}

// ── CLI ──────────────────────────────────────────────────────
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  const checkOnly = process.argv.includes('--check')
  const src = readFileSync(SRC, 'utf8')
  if (/\bimport\s|\brequire\s*\(/.test(src)) {
    throw new Error('web/font-scale.js 必须是不带 import/require 的纯浏览器脚本（它要被原样内联）')
  }
  const digest = sourceDigest(src)
  let drifted = 0

  for (const { file, store } of PAGES) {
    const full = path.join(ROOT, file)
    const rel = file
    if (!existsSync(full)) { console.error(`  ✗ ${rel} 不存在`); drifted++; continue }
    const block = buildBlock(src, store)
    const html = readFileSync(full, 'utf8')
    const now = existingBlock(html)

    if (checkOnly) {
      if (!now) { console.error(`  ✗ ${rel} 里没有字号控件内联段`); drifted++; continue }
      if (now !== block) {
        console.error(`  ✗ ${rel} 的字号控件内联段与 web/font-scale.js 不一致 —— ` +
          '改了控件之后要重跑 `node gen/inline-font-scale.mjs`')
        drifted++
        continue
      }
      console.log(`  ✓ ${rel}`)
      continue
    }
    const next = inject(html, block)
    if (next === html) { console.log(`  ✓ ${rel}（无变化）`); continue }
    writeFileSync(full, next)
    const kb = (Buffer.byteLength(block) / 1024).toFixed(1)
    console.log(`  ✓ ${rel}  +${kb} KB`)
  }

  if (drifted) {
    console.error(`\n${drifted} 个页面的字号控件内联段需要更新`)
    process.exit(1)
  }
  console.log(`\n${checkOnly ? '✓ 字号控件内联段都是最新的' : '✓ 字号控件已内联'}（源码指纹 ${digest}）`)
}
