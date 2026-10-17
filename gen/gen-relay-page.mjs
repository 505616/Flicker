#!/usr/bin/env node
/**
 * 生成中继用的页面模块
 * ====================
 * 中继需要把接收端页面发给浏览器。页面本身是 `web/receiver.html`，
 * 但 Worker 需要的是一个 JS 模块。
 *
 * 做法：把它转成 `relay/page.generated.js`（导出一个字符串）。
 *
 * ── 为什么不直接复制一份页面 ──
 * 那会变成两份会各自漂移的副本 —— 改了页面忘了改副本，
 * 结果是"局域网模式正常、跨网络模式是旧版"，这类问题极难发现。
 * 所以只有**一个**页面源文件，这里是构建产物。
 *
 * ── 为什么不用 wrangler 的文本模块规则 ──
 * `rules: [{ type = "Text", globs = ["**\/*.html"] }]` 也能做到，
 * 但那样部署方式就绑死在 wrangler 上，而且排错时多一层不透明的转换。
 * 生成一个普通 JS 文件更直白，任何工具都能构建、也能直接读懂。
 *
 * 用法：node gen/gen-relay-page.mjs
 *       node gen/gen-relay-page.mjs --check   # 只核对产物是否跟得上源文件（不写盘）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'web', 'receiver.html')
const OUT = path.join(ROOT, 'relay', 'page.generated.js')
const CHECK = process.argv.includes('--check')

if (!existsSync(SRC)) {
  console.error(`  ✗ 找不到页面源文件: ${SRC}`)
  process.exit(1)
}

const html = readFileSync(SRC, 'utf8')
const digest = createHash('sha256').update(html).digest('hex').slice(0, 16)

/**
 * `--check`：产物是不是跟得上源文件。
 *
 * 为什么需要它：接收端页面在**两处**被用到 —— 局域网直连时由 `src/server.js`
 * 直接读 `web/receiver.html`，跨网络时由中继 Worker 用这个生成产物。
 * 只改页面、忘了重跑本脚本，症状是"局域网正常、跨网络还是旧版"，
 * 而这种差异恰恰要等到别人反馈才会暴露。所以让静态检查盯住它。
 */
if (CHECK) {
  if (!existsSync(OUT)) {
    console.error(`  ✗ ${path.relative(ROOT, OUT)} 不存在 —— 请运行：node gen/gen-relay-page.mjs`)
    process.exit(1)
  }
  const cur = readFileSync(OUT, 'utf8')
  const m = cur.match(/RECEIVER_HTML_DIGEST = '([0-9a-f]+)'/)
  if (!m) {
    console.error(`  ✗ ${path.relative(ROOT, OUT)} 里没有指纹，无法核对 —— 请重新生成`)
    process.exit(1)
  }
  if (m[1] !== digest) {
    console.error(`  ✗ ${path.relative(ROOT, OUT)} 是旧版：`)
    console.error(`      产物记录 ${m[1]}，而 web/receiver.html 现在是 ${digest}`)
    console.error('      跨网络（中继）会发出旧页面。请运行：node gen/gen-relay-page.mjs')
    process.exit(1)
  }
  console.log(`  ✓ relay/page.generated.js 与 web/receiver.html 一致（${digest}）`)
  process.exit(0)
}

/** 把任意文本安全地放进模板字符串 */
function toTemplateLiteral(s) {
  return s
    .replace(/\\/g, '\\\\')      // 反斜杠必须先处理
    .replace(/`/g, '\\`')        // 反引号
    .replace(/\$\{/g, '\\${')    // 模板插值
}

const out = `/**
 * ⚠️ 构建产物，请勿手工编辑。
 * 由 gen/gen-relay-page.mjs 从 web/receiver.html 生成。
 *
 * 源文件 SHA-256（前 16 位）: ${digest}
 * 页面大小: ${(Buffer.byteLength(html, 'utf8') / 1024).toFixed(1)} KB
 *
 * 改页面请改 web/receiver.html，然后重新运行：node gen/gen-relay-page.mjs
 */
export const RECEIVER_HTML = \`${toTemplateLiteral(html)}\`

/** 页面内容的指纹，用于自检"部署的页面与源文件是否一致" */
export const RECEIVER_HTML_DIGEST = '${digest}'
`

writeFileSync(OUT, out, 'utf8')

// 自检：生成出来的必须真的是同一份内容
const back = (await import(`${new URL('file://' + OUT.replace(/\\/g, '/')).href}?t=${Date.now()}`)).RECEIVER_HTML
if (back !== html) {
  console.error('  ✗ 生成结果与源文件不一致 —— 转义逻辑有问题')
  process.exit(1)
}

console.log(`  ✓ relay/page.generated.js  ${(Buffer.byteLength(out, 'utf8') / 1024).toFixed(1)} KB`)
console.log(`    源文件指纹 ${digest}，往返校验通过`)
