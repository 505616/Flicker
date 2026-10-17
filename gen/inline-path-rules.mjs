/**
 * 把路径安全规则内联进 web/*.html
 * =================================
 *
 * ── 为什么必须内联，而不是让页面去 fetch 一个 .js ────────────────
 *
 * 接收端页面会被三种方式送出：发送端的局域网自签 HTTPS、中继的 HTTPS、
 * 以及 SEA 单文件里的内嵌副本。三处的路径、协议、可达文件都不一样，
 * 多一个 `.js` 文件就多一处会 404 的地方（而 404 的表现是"收不了文件"，
 * 排查起来离"路径规则"十万八千里）。这与页面"单文件、零外部请求"的约束一致。
 *
 * ── 为什么必须是同一份实现 ────────────────────────────────────
 *
 * 从前 `web/receiver.html` 里只有一行
 * `rel.replace(/[<>:"|?*\x00-\x1f]/g, '_')`，而 `src/manifest.js` 有 12 条规则。
 * 两边不一致的后果不是"少一层防护"，而是**丢文件**：
 * 清单里同时有 `a:b.txt` 与 `a_b.txt` 时，浏览器改写后两条路径撞成同一个，
 * 后写的把先写的**静默覆盖** —— 测试全绿（测试走的是 Node 那一份），
 * 用户在浏览器里少收一个文件，且没有任何提示。
 *
 * 所以：规则只在 `src/path-safety.js` 里写一次，这里**原样**内联。
 * `--check` 守住同步（与 inline-i18n / inline-pwa 同样的做法）。
 *
 * 用法：
 *   node gen/inline-path-rules.mjs          # 内联
 *   node gen/inline-path-rules.mjs --check  # 只校验是否同步（CI 用）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { codeOnly } from './code-only.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'src', 'path-safety.js')
const PAGES = ['web/receiver.html', 'web/phone.html'].map((p) => path.join(ROOT, p))

const BEGIN = '<!-- path-rules:begin —— 这一整段由 gen/inline-path-rules.mjs 从 src/path-safety.js 生成，请勿手改 -->'
const END = '<!-- path-rules:end -->'

const checkOnly = process.argv.includes('--check')

function buildBlock() {
  let src = readFileSync(SRC, 'utf8')
  const code = codeOnly(src)

  const imports = code.split('\n')
    .map((l, i) => ({ l, n: i + 1 }))
    .filter((x) => /^\s*(import|require)\b/.test(x.l))
  if (imports.length) {
    throw new Error(
      `src/path-safety.js 里出现了 import/require（第 ${imports.map((x) => x.n).join(', ')} 行）。\n` +
      '    这个文件要被**原样内联**进浏览器页面，所以它必须是纯 JS：\n' +
      '    不许 import node:path、不许用 Buffer —— 需要什么就在这里自己实现。')
  }
  if (/\bBuffer\b|\bprocess\s*\./.test(code)) {
    throw new Error('src/path-safety.js 的**代码**里用到了 Buffer 或 process —— 浏览器里没有这些')
  }

  // export 一律去掉（内联后就在同一个作用域里）
  src = src.replace(/^export\s+/gm, '')

  // 只把真正要给页面用的东西交出去。
  // 不整体暴露 `this`，免得页面里的其它代码误撞名字。
  const EXPORTS = [
    'checkRelPath', 'safeRelPath', 'compareKeyOf', 'findPathConflict',
    'dedupeRelPath', 'UnsafePathError', 'utf8Bytes', 'PATH_RULES',
  ]

  return [
    BEGIN,
    '<script>',
    '// ── 路径安全规则（PROTOCOL.md §6.2）────────────────────────────',
    '// 由 gen/inline-path-rules.mjs 从 src/path-safety.js 原样内联，请勿手改。',
    '//',
    '// 为什么在页面里也要有这一份：真正决定文件落到用户磁盘上叫什么的，',
    '// 是**这里**，不是 Node 那边。改名的后果（两条路径撞成同一个 → 静默覆盖）',
    '// 也只有在页面里才防得住。',
    '(function () {',
    "  'use strict'",
    src.split('\n').map((l) => (l ? '  ' + l : l)).join('\n'),
    '  window.FlickerPaths = {',
    EXPORTS.map((e) => `    ${e}: ${e},`).join('\n'),
    '  }',
    '})()',
    '</script>',
    END,
  ].join('\n')
}

function sourceDigest() {
  return createHash('sha256').update(readFileSync(SRC, 'utf8')).digest('hex').slice(0, 16)
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
  // 首次插入：放在 </head> 之前（页面里的脚本都在 body 末尾，规则要先就位）
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
    if (!now) { console.error(`  ✗ ${rel} 里没有路径规则内联段`); drifted++; continue }
    if (now !== block) {
      console.error(`  ✗ ${rel} 的路径规则内联段与 src/path-safety.js 不一致 —— ` +
        '改了规则之后要重跑 `node gen/inline-path-rules.mjs`')
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
  if (drifted) { console.error(`\n${drifted} 个页面的路径规则内联段需要更新`); process.exit(1) }
  console.log('\n✓ 路径规则内联段都是最新的')
} else {
  console.log(`\n  12 条路径规则 · 约 ${(block.length / 1024).toFixed(1)} KB · 指纹 ${digest}`)
  console.log('  ⚠️ receiver.html 改了之后还要重跑：node gen/gen-relay-page.mjs')
}
