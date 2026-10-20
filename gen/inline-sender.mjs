/**
 * 把网页发送端的两个内核内联进 `web/sender.html`
 * ==============================================
 *
 * 为什么必须内联：这一页将来由中继托管（或随单文件产物发出），CSP 是
 * `default-src 'none'`，页面里不能 import、也不能 fetch 外部脚本 ——
 * 所以唯一的形态是**构建期把脚本打进 HTML**。与接收页、手机页同一套办法。
 *
 * 内联顺序有依赖：`phone-core.js` 先（密码学与 `FlickerPhone`），
 * 然后 `sender-core.js`（中继续传，读 `globalThis.FlickerPhone`）。
 *
 * 生成器顺手把两条硬约束当判据检查（浏览器不能直接吃的东西一律拒绝）：
 *   · 不许 import / require / export
 *   · 不许用 Buffer / process / fs 这些 Node 专有的东西
 *
 * 用法：
 *   node gen/inline-sender.mjs            # 内联
 *   node gen/inline-sender.mjs --check    # 只校验是否同步（CI 用）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from './bundler.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PAGE = path.join(ROOT, 'web', 'sender.html')
export const SOURCES = ['web/phone-core.js', 'web/sender-core.js']
export const BEGIN = '<!-- sender-core:begin —— 这一整段由 gen/inline-sender.mjs 生成，请勿手改 -->'
export const END = '<!-- sender-core:end -->'

/** 浏览器里跑不了的东西：内联前就拒掉，别等用户打开页面才发现 */
export const FORBIDDEN = [
  { re: /^\s*(import|export)\s/m, why: '页面脚本不能 import/export（CSP 与内联都要求纯脚本）' },
  { re: /\brequire\s*\(/, why: '页面里没有 require' },
  { re: /\bBuffer\b/, why: 'Buffer 是 Node 专有的，页面里用 Uint8Array' },
  { re: /\bprocess\s*\./, why: '页面里没有 process' },
  { re: /from ['"]node:/, why: '不能引用 node: 内置模块' },
]

/**
 * 核一遍源文件（纯函数，供测试注入坏样本）。
 * @param {Array<{rel:string, src:string}>} sources
 * @returns {string[]} 问题清单
 */
export function checkSources(sources) {
  const problems = []
  for (const { rel, src } of sources) {
    // ⚠️ 注释先剥掉：`web/phone-core.js` 的注释里就写着"不许用 Buffer/process"，
    //    直接扫原文会把这句解释本身判成违规（写这个生成器时实测撞到过）。
    //    stripComments 用等长空白替换，所以行号仍然对得上。
    const code = stripComments(src)
    for (const f of FORBIDDEN) {
      const m = code.match(f.re)
      if (m) {
        const line = src.slice(0, m.index).split('\n').length
        problems.push(`${rel}:${line} ${f.why}（命中 ${JSON.stringify(m[0].trim().slice(0, 24))}）`)
      }
    }
  }
  return problems
}

export function buildBlock(sources) {
  const parts = [BEGIN]
  for (const { rel, src } of sources) {
    parts.push(`<script data-inlined-from="${rel}">`)
    parts.push(src.replace(/\s+$/, ''))
    parts.push('</script>')
  }
  parts.push(END)
  return parts.join('\n')
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
  throw new Error('web/sender.html 里没有 sender-core 标记 —— 先手写两个 marker')
}

// ── CLI ──────────────────────────────────────────────────────

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  const checkOnly = process.argv.includes('--check')
  const sources = SOURCES.map((rel) => ({ rel, src: readFileSync(path.join(ROOT, rel), 'utf8') }))

  const problems = checkSources(sources)
  if (problems.length) {
    console.error('✗ 有源文件不符合"浏览器能直接吃"的约束：')
    for (const p of problems) console.error(`   ${p}`)
    process.exit(1)
  }

  if (!existsSync(PAGE)) {
    console.error('✗ 找不到 web/sender.html')
    process.exit(1)
  }
  const html = readFileSync(PAGE, 'utf8')
  const block = buildBlock(sources)

  if (checkOnly) {
    const now = existingBlock(html)
    if (!now) { console.error('  ✗ web/sender.html 没有内联段'); process.exit(1) }
    if (now !== block) {
      console.error('  ✗ web/sender.html 的内联段与源文件不同步 —— 改了 web/phone-core.js 或 ' +
        'web/sender-core.js 之后要重跑 `node gen/inline-sender.mjs`')
      process.exit(1)
    }
    console.log(`✓ 网页发送端内联段是最新的（${sources.map((s) => s.rel).join(' + ')}）`)
  } else {
    const next = inject(html, block)
    if (next === html) console.log('  － web/sender.html 已是最新')
    else {
      writeFileSync(PAGE, next, 'utf8')
      const delta = Buffer.byteLength(next) - Buffer.byteLength(html)
      console.log(`  ✓ web/sender.html  ${delta >= 0 ? '+' : ''}${(delta / 1024).toFixed(1)} KB`)
    }
    console.log(`\n  合计约 ${(block.length / 1024).toFixed(1)} KB（全部内联，零外部请求）`)
  }
}
