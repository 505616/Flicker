/**
 * 把页面插件内联进接收端页面（页面平面的"加载器"）
 * ================================================
 *
 * ── 为什么页面插件只能在**构建期**内联 ────────────────────────
 * 接收端页面必须自包含：中继直接把这份 HTML 发出去（`relay/page.generated.js`），
 * CSP 是 `default-src 'none'`，页面里不能 import 任何东西、也不能 fetch 外部脚本。
 * 所以"运行时加载插件"在页面上根本不存在 —— 唯一的形态是**把它们打进页面**。
 *
 * 这带来一个额外的好处：**任何页面插件都会改变页面指纹**
 * （`--assets` 能核对，构建时写进 `version.json`）。也就是说
 * "接收端拿到的页面到底是什么"这件事始终是可验证的。
 *
 * ── 显式启用 ────────────────────────────────────────────────
 * 只认 `web/page-plugins.json` 里列出的插件（默认空清单）。与另外两个平面同一条
 * 原则：**绝不自动发现**。空清单时页面里只有两个 marker 注释，行为与从前逐字节相同。
 *
 * ── 构建期就把能查的查掉 ────────────────────────────────────
 * 每个插件文件都会被检查：必须是浏览器能直接跑的纯 JS（不许 import/require/Node API）、
 * 必须有 `export default { … }`、声明的 `apiVersion` 必须与运行时一致、`apply` 必须是函数。
 * 检查方式是把源码放进 `node:vm` 里真的跑一遍取出那个声明 —— 顺便也验了语法。
 *
 * 用法：
 *   node gen/inline-plugins.mjs            # 内联
 *   node gen/inline-plugins.mjs --check    # 只校验是否同步（CI 用）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { codeOnly } from './code-only.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RUNTIME = 'web/page-plugin-runtime.mjs'
const MANIFEST = 'web/page-plugins.json'

export const BEGIN = '<!-- page-plugins:begin —— 这一整段由 gen/inline-plugins.mjs 生成，请勿手改 -->'
export const END = '<!-- page-plugins:end -->'

const digest16 = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16)

/** 读清单（显式启用的插件列表） */
export function readManifest(root = ROOT, manifestRel = MANIFEST) {
  const file = path.join(root, manifestRel)
  if (!existsSync(file)) return { plugins: [] }
  const text = readFileSync(file, 'utf8')
  let json
  try {
    json = JSON.parse(text)
  } catch (e) {
    // ⚠️ 这个文件是**严格 JSON**：不能写注释、不能用单引号、不能有多余逗号。
    //    第一版就是被自己写的注释坑了（读的时候 JSON.parse 直接炸），
    //    所以错误信息要说清"能怎么写、想写说明放哪儿"。
    throw new Error(`${manifestRel} 不是合法 JSON：${e.message}\n` +
      '  这个文件是**严格 JSON**：不能写注释、不能用单引号、最后一项后面不能有逗号。\n' +
      '  想写说明请用 "_comment" 字段（已有示例）。')
  }
  const plugins = json?.plugins
  if (!Array.isArray(plugins)) throw new Error(`${manifestRel} 里应当有 "plugins": [ … ] 数组`)
  return { plugins: plugins.map(String) }
}

/**
 * 把 ESM 源码变成"能在页面里直接跑的普通脚本"。
 * 与 `inline-path-rules.mjs` 同样的做法：去掉 `export`、包进 IIFE，不做任何转译。
 *
 * @param {object} [o]
 * @param {boolean} [o.needsDefault] 是不是"插件"（插件必须以 `export default {…}` 导出声明；
 *   运行时模块不是插件，它只提供函数，所以不需要）
 */
export function toBrowserSource(src, { file, needsDefault = true }) {
  const code = codeOnly(src)
  // ⚠️ 判据要够宽：`import` 只可能出现在行首（语句），而 `require(` 能出现在任何位置
  //    （`const fs = require('node:fs')`）。第一版只查了 `^\s*(import|require)\b`，
  //    于是**行内的 require 溜过去了** —— 页面里跑到那一句才会炸。
  const badImport = /^\s*import\b/m.test(code) || /\bimport\s*\(/.test(code) || /(^|[^.\w])require\s*\(/.test(code)
  if (badImport) {
    throw new Error(`${file} 里出现了 import/require。\n` +
      '    页面插件会被**原样内联**进接收端页面，所以必须是浏览器能直接跑的纯 JS：\n' +
      '    不许 import、不许 require、不许用 Node 的 API（Buffer / process / fs…）。')
  }
  if (/\bBuffer\b|\bprocess\s*\.|\bmodule\s*\.\s*exports/.test(code)) {
    throw new Error(`${file} 的**代码**里用到了 Buffer / process / module.exports —— 浏览器里没有这些`)
  }
  if (needsDefault && !/^(\s*)export default /m.test(src)) {
    throw new Error(`${file} 必须以 \`export default { name, apiVersion, apply(ctx) { … } }\` 结尾`)
  }
  // 允许缩进（插件作者可能把 export default 写在缩进里）
  let out = src
  if (needsDefault) out = out.replace(/^(\s*)export default /m, '$1const __plugin = ')
  out = out.replace(/^(\s*)export\s+/gm, '$1')
  return out
}

/** 在 vm 里真的跑一遍插件源码，取出它导出的声明（顺便验语法与形状） */
function loadDeclaration(browserSource, { file }) {
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    window: {}, document: undefined,
  })
  let decl
  try {
    decl = vm.runInContext(browserSource + '\n;__plugin', context, { filename: file, timeout: 2000 })
  } catch (e) {
    throw new Error(`${file} 在加载时就抛错了：${e?.message ?? e}`)
  }
  if (!decl || typeof decl !== 'object') throw new Error(`${file} 的 export default 必须是对象`)
  if (typeof decl.name !== 'string' || !decl.name.trim()) throw new Error(`${file} 缺少 name`)
  if (typeof decl.apply !== 'function') throw new Error(`${file} 缺少 apply(ctx)`)
  return decl
}

/**
 * 拼出内联段：先运行时、再逐个插件。
 *
 * @param {string} root 仓库根目录
 * @param {{plugins:string[]}} [manifest]
 * @returns {{block:string, plugins:Array<{rel:string,digest:string,name:string,apiVersion:number}>}}
 */
export function buildPageBlock(root = ROOT, manifest = readManifest(root)) {
  // ⚠️ 空清单时**只放 marker**，不内联运行时（约 9 KB）。
  //    没有插件却先把运行时塞进页面，等于让所有用户为一个用不到的功能付页面体积；
  //    而页面里的钩子调用写的是 `window.FlickerPage?.emit(…)`，没有运行时就是空操作。
  if (manifest.plugins.length === 0) {
    return {
      block: [BEGIN, '<!-- 没有启用任何页面插件（web/page-plugins.json 的清单是空的） -->', END].join('\n'),
      plugins: [],
    }
  }

  const runtimeSrc = readFileSync(path.join(root, RUNTIME), 'utf8')
  const runtimeCode = toBrowserSource(runtimeSrc, { file: RUNTIME, needsDefault: false })

  // 运行时的版本号：从源码里读出来（页面插件声明的版本必须与它一致）
  const m = runtimeSrc.match(/export const PAGE_API_VERSION = (\d+)/)
  if (!m) throw new Error(`${RUNTIME} 里找不到 PAGE_API_VERSION`)
  const apiVersion = Number(m[1])

  const runtimeBlock = [
    BEGIN,
    '<script>',
    '// ── 页面插件运行时 ────────────────────────────────────────────',
    `// 由 gen/inline-plugins.mjs 从 ${RUNTIME} 原样内联，请勿手改。`,
    '// 页面插件只能构建期内联：中继直接把这份 HTML 发出去，CSP 不允许任何外部脚本。',
    '(function () {',
    "  'use strict'",
    runtimeCode.split('\n').map((l) => (l ? '  ' + l : l)).join('\n'),
    '  window.FlickerPage = createPagePlugins()',
    '})()',
    '</script>',
  ]

  const plugins = []
  const pluginBlocks = []
  for (const rel of manifest.plugins) {
    const abs = path.join(root, rel)
    if (!existsSync(abs)) throw new Error(`清单里的插件文件不存在：${rel}`)
    const src = readFileSync(abs, 'utf8')
    const browserSource = toBrowserSource(src, { file: rel })
    const decl = loadDeclaration(browserSource, { file: rel })
    if (decl.apiVersion !== undefined && decl.apiVersion !== apiVersion) {
      throw new Error(`${rel} 声明 apiVersion: ${decl.apiVersion}，而页面运行时提供的是 ${apiVersion}`)
    }
    const digest = digest16(src)
    plugins.push({ rel, digest, name: decl.name, apiVersion: decl.apiVersion ?? apiVersion })
    pluginBlocks.push([
      '<script>',
      `// 插件：${decl.name}${decl.version ? '@' + decl.version : ''}（${rel}  sha256:${digest}）`,
      '(function () {',
      "  'use strict'",
      browserSource.split('\n').map((l) => (l ? '  ' + l : l)).join('\n'),
      '  window.FlickerPage.register(__plugin)',
      '})()',
      '</script>',
    ])
  }

  const tail = plugins.length
    ? pluginBlocks.flat()
    : ['<!-- 没有启用任何页面插件（web/page-plugins.json 的清单是空的） -->']

  return { block: [...runtimeBlock, ...tail, END].join('\n'), plugins }
}

/** 页面里现有内联段 */
export function existingBlock(html) {
  const b = html.indexOf(BEGIN)
  const e = html.indexOf(END)
  return (b >= 0 && e > b) ? html.slice(b, e + END.length) : null
}

/** 把内联段写进页面（首次插入放在 </head> 之前） */
export function inject(html, block) {
  const b = html.indexOf(BEGIN)
  const e = html.indexOf(END)
  if (b >= 0 && e > b) return html.slice(0, b) + block + html.slice(e + END.length)
  const headEnd = html.indexOf('</head>')
  if (headEnd < 0) throw new Error('页面里没有 </head>')
  return html.slice(0, headEnd) + block + '\n' + html.slice(headEnd)
}

// ── CLI ────────────────────────────────────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const checkOnly = process.argv.includes('--check')
  const pageArg = process.argv.find((a) => a.startsWith('--page='))
  const pages = pageArg ? [pageArg.slice('--page='.length)] : ['web/receiver.html']

  const manifest = readManifest(ROOT)
  const { block, plugins } = buildPageBlock(ROOT, manifest)

  let drifted = 0
  for (const rel of pages) {
    const file = path.join(ROOT, rel)
    if (!existsSync(file)) { console.log(`  － ${rel} 不存在，跳过`); continue }
    const html = readFileSync(file, 'utf8')
    const now = existingBlock(html)

    if (checkOnly) {
      if (!now) { console.error(`  ✗ ${rel} 里没有页面插件内联段（先跑一次 node gen/inline-plugins.mjs）`); drifted++; continue }
      if (now !== block) {
        console.error(`  ✗ ${rel} 的页面插件内联段与 web/page-plugins.json（或插件文件本身）不一致 ——` +
          '改了清单或插件之后要重跑 `node gen/inline-plugins.mjs`')
        drifted++
        continue
      }
      console.log(`  ✓ ${rel}`)
      continue
    }

    const next = inject(html, block)
    if (next === html) console.log(`  － ${rel} 已是最新`)
    else {
      writeFileSync(file, next, 'utf8')
      const delta = Buffer.byteLength(next) - Buffer.byteLength(html)
      console.log(`  ✓ ${rel}  ${delta >= 0 ? '+' : ''}${(delta / 1024).toFixed(1)} KB`)
    }
  }

  if (checkOnly) {
    if (drifted) { console.error(`\n${drifted} 个页面的插件内联段需要更新`); process.exit(1) }
    console.log('\n✓ 页面插件内联段都是最新的')
  } else {
    console.log(`\n  ${plugins.length} 个页面插件` +
      (plugins.length ? '：' + plugins.map((p) => `${p.name}(sha256:${p.digest})`).join('、') : '（空清单）'))
    console.log('  ⚠️ receiver.html 改了之后还要重跑：node gen/gen-relay-page.mjs')
  }
}
