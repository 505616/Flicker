#!/usr/bin/env node
/**
 * 生成中继用的**网页发送端**页面模块
 * ==================================
 * 与 `gen/gen-relay-page.mjs` 同一个套路，只是源文件是 `web/sender.html`、
 * 产物是 `relay/sender.generated.js`（导出 `SENDER_HTML`）。
 *
 * ── 为什么发送页也要由中继托管 ──
 * 手机传手机时，两边都只有浏览器：没有人的机器能当服务端。所以要有一处
 * **双方都能打开**的地方来交换字节 —— 那就是中继。接收页早就是中继托管的，
 * 发送页现在也走同一条路：打开 `/send` 就能发。
 *
 * ── 为什么不让中继在运行时去读 web/sender.html ──
 * Cloudflare Worker 里没有文件系统。所以页面必须在**构建期**变成 JS 模块
 * （与接收页同样的理由，也是为什么这份产物要进 git）。
 *
 * 用法：
 *   node gen/gen-relay-sender.mjs            # 生成
 *   node gen/gen-relay-sender.mjs --check    # 只核对产物是否跟得上源文件
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'web', 'sender.html')
const OUT = path.join(ROOT, 'relay', 'sender.generated.js')
const CHECK = process.argv.includes('--check')

if (!existsSync(SRC)) {
  console.error(`  ✗ 找不到页面源文件: ${SRC}`)
  process.exit(1)
}

const html = readFileSync(SRC, 'utf8')
const digest = createHash('sha256').update(html).digest('hex').slice(0, 16)

/**
 * ⚠️ 页面必须自包含（CSP 不许外部脚本）。这里顺手当判据：内联段必须在，
 *    否则"上传页能打开但没有内核"——点了开始没反应，还不报错。
 */
if (!html.includes('sender-core:begin')) {
  console.error('  ✗ web/sender.html 里没有 sender-core 内联段 —— 先运行：node gen/inline-sender.mjs')
  process.exit(1)
}

if (CHECK) {
  if (!existsSync(OUT)) {
    console.error(`  ✗ ${path.relative(ROOT, OUT)} 不存在 —— 请运行：node gen/gen-relay-sender.mjs`)
    process.exit(1)
  }
  const cur = readFileSync(OUT, 'utf8')
  const m = cur.match(/SENDER_HTML_DIGEST = '([0-9a-f]+)'/)
  if (!m) {
    console.error(`  ✗ ${path.relative(ROOT, OUT)} 里没有指纹，无法核对 —— 请重新生成`)
    process.exit(1)
  }
  if (m[1] !== digest) {
    console.error(`  ✗ ${path.relative(ROOT, OUT)} 是旧版：`)
    console.error(`      产物记录 ${m[1]}，而 web/sender.html 现在是 ${digest}`)
    console.error('      中继上的 /send 会发出旧页面。请运行：node gen/gen-relay-sender.mjs')
    process.exit(1)
  }
  console.log(`  ✓ relay/sender.generated.js 与 web/sender.html 一致（${digest}）`)
  process.exit(0)
}

/** 把任意文本安全地放进模板字符串 */
function toTemplateLiteral(s) {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${')
}

const out = `/**
 * ⚠️ 构建产物，请勿手工编辑。
 * 由 gen/gen-relay-sender.mjs 从 web/sender.html 生成。
 *
 * 源文件 SHA-256（前 16 位）: ${digest}
 * 页面大小: ${(Buffer.byteLength(html, 'utf8') / 1024).toFixed(1)} KB
 *
 * 改页面请改 web/sender.html（以及它内联的 web/sender-core.js），
 * 然后依次运行：node gen/inline-sender.mjs && node gen/gen-relay-sender.mjs
 */
export const SENDER_HTML = \`${toTemplateLiteral(html)}\`

/** 页面内容的指纹，用于自检"部署的页面与源文件是否一致" */
export const SENDER_HTML_DIGEST = '${digest}'
`

writeFileSync(OUT, out, 'utf8')

// 自检：生成出来的必须真的是同一份内容
const back = (await import(`${new URL('file://' + OUT.replace(/\\/g, '/')).href}?t=${Date.now()}`)).SENDER_HTML
if (back !== html) {
  console.error('  ✗ 生成结果与源文件不一致 —— 转义逻辑有问题')
  process.exit(1)
}

console.log(`  ✓ relay/sender.generated.js  ${(Buffer.byteLength(out, 'utf8') / 1024).toFixed(1)} KB`)
console.log(`    源文件指纹 ${digest}，往返校验通过`)
