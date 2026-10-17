/**
 * 极简打包器（构建期工具）
 * ========================
 * 为什么需要它：SEA（单文件可执行程序）只接受**一个** JS 入口，
 * 而本项目有十个模块。Node 的模块系统无法从内存里的 blob 解析 `./xxx.js`，
 * 所以必须先把模块图压成一个文件。
 *
 * 设计取舍：
 *   · 用**拓扑序拼接**，而不是引入 esbuild/rollup —— 后者会让"零依赖"变成空话
 *   · 只支持本项目实际用到的语法：静态 import / export、无循环依赖
 *   · 不做 tree-shaking、不做压缩 —— 目标是"能跑"，不是"最小"
 *   · 拼接前会校验：所有 import 都能解析、模块图无环。宁可构建失败，也不要产出坏产物
 *
 * 这个文件**不进产物**，只在构建时跑。
 */
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
import path from 'node:path'

/** 从源码里抽出静态 import 的模块说明符 */
function importSpecifiers(src) {
  const out = []
  // import ... from 'x'   /   import 'x'
  const re = /^[ \t]*import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/gm
  let m
  while ((m = re.exec(src))) out.push(m[1])
  // export ... from 'x'
  const re2 = /^[ \t]*export\s+(?:\*|\{[\s\S]*?\})\s+from\s+['"]([^'"]+)['"]/gm
  while ((m = re2.exec(src))) out.push(m[1])
  return out
}

/**
 * 找出**相对路径的动态 import**（`await import('./x.js')`）—— 见到就直接拒绝构建。
 *
 * ── 为什么这条必须让构建失败 ──
 * 这个打包器只跟**静态** import 走模块图，动态 import 里的路径会被原样留在产物里。
 * 而单文件产物运行时**磁盘上没有 src/**，于是它按 exe 所在目录去解析
 * `./gui.js`：
 *
 *   · 在源码目录里跑 → 恰好能找到旁边的源码 → **测试全绿**
 *   · 把 exe 复制到桌面双击 → `Cannot find module 'C:\Users\…\src\gui.js'`
 *     控制台一闪而过，用户只看到"CMD 弹出来一下立刻消失"
 *
 * 2026-10 就是这样漏的：产物里只有 5 个模块（其余全靠运行时去磁盘上找），
 * 而整整一套测试 + 冒烟脚本**都在源码目录里跑**，谁都没发现。
 * 这类"只在离开源码树时才暴露"的问题，必须在**构建时**就拦住 ——
 * 靠人记得"别忘了改成静态 import"是拦不住的。
 *
 * 内置模块（`node:` 开头）不受影响：它们由 Node 自己解析，本来就不进产物。
 */
function rejectDynamicImports(src, rel) {
  // ⚠️ 先剥掉注释：文档里解释"不能写成 `await import('./gui.js')`"的那句话
  //    本身就是一段相对路径的动态 import，不剥注释就会**被自己的文档误伤**
  //    （打包直接失败，而错误指向一行注释）。这个坑本项目在 import.meta 那条上踩过。
  const code = stripComments(src)
  const re = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  let m
  while ((m = re.exec(code))) {
    const spec = m[1]
    if (spec.startsWith('node:')) continue      // 内置模块，SEA 里也能解析
    const line = code.slice(0, m.index).split('\n').length
    throw new Error(
      `${rel}:${line} 用了相对路径的动态 import（${spec}）—— 打包器不会把它收进产物，\n` +
      '  单文件产物运行时磁盘上没有源码，会报 Cannot find module 然后一闪而过。\n' +
      '  请改成**静态 import**（`import { x } from \'…\'`）。\n' +
      '  如果确实需要懒加载，先给打包器加"把动态 import 也收进产物"的支持，别绕过这条。')
  }
}

/**
 * 去掉模块的 import / export 语法，只留实体代码。
 *
 * ⚠️ 这里刻意**不用正则**，而是逐行扫描。
 *    踩过的坑：用 /^import ... from '...';$/m 这类写法时，
 *    Windows 的行尾是 CRLF，而 `[\s\S]*?` 会跨行一路吞到最后一个匹配，
 *    把整个文件切碎 —— manifest.js 就是这么被毁掉的，靠自检才拦住。
 *    import 语句的边界其实是确定的（到第一个字符串字面量结束为止），
 *    所以扫描比正则可靠得多。
 */
function stripModuleSyntax(src, { label }) {
  // ⚠️ shebang 只在文件第一行合法。拼接后入口的 shebang 会落到中间，
  //    导致 "Invalid or unexpected token" —— 这个坑是构建期语法检查抓出来的。
  //    产物不需要 shebang：它由 Node 直接执行或经 SEA 入口加载。
  if (src.startsWith('#!')) src = src.slice(src.indexOf('\n') + 1)

  const lines = src.split(/\r?\n/)
  const out = []
  let i = 0

  /** 从第 from 行开始找 import 语句的结束行 */
  function endOfImport(from) {
    for (let k = from; k < lines.length; k++) {
      if (/from\s*(['"])[^'"]*\1/.test(lines[k])) return k
      if (/^\s*import\s*(['"])[^'"]*\1/.test(lines[k])) return k
      // import { ... } 换行写、from 在下一行的情况：最多容忍 12 行
      if (k - from > 12) break
    }
    return from
  }

  while (i < lines.length) {
    const t = lines[i].trim()

    if (/^import\s/.test(t)) { i = endOfImport(i) + 1; continue }
    if (/^export\s/.test(t) && /\sfrom\s*['"]/.test(t)) { i++; continue }
    if (/^export\s*\{/.test(t)) {
      let k = i
      while (k < lines.length && !/\}\s*;?\s*$/.test(lines[k])) k++
      i = k + 1
      continue
    }

    let line = lines[i]
    line = line.replace(/^(\s*)export\s+default\s+/, '$1')
    line = line.replace(/^(\s*)export\s+(const|let|var|function|async\s+function|class)\s/, '$1$2 ')
    out.push(line)
    i++
  }

  const code = out.join('\n')
  const leftover = code.match(/^[ \t]*(import|export)\s/m)
  if (leftover) {
    throw new Error(`打包后 ${label} 仍残留模块语法: ${leftover[0].trim()}\n` +
      '说明打包器没覆盖到这种写法 —— 需要先扩展打包器，而不是绕过它')
  }
  return code
}

/**
 * 把入口及其依赖打包成一个自包含的源码字符串。
 *
 * @param {string} entry 入口文件的绝对路径
 * @param {object} [opts]
 * @param {Array<{find:RegExp|string, replace:string}>} [opts.replace]
 *   定点替换。用于处理"源码模式合法、CommonJS 里不合法"的写法。
 *   刻意做成显式传入而不是自动推断：自动改代码容易改错，
 *   而这些替换点很少、很清楚，写出来更好审计。
 * @returns {{code:string, modules:string[], bytes:number}}
 */
/**
 * 把源码里的注释换成等长空白。
 * 等长是为了让报错行号仍然对得上。
 * 只处理 // 与 /* *\/ 两种；不处理字符串里的"//"，那种情况这里不会遇到。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
}

export function bundle(entry, opts = {}) {
  const modules = new Map()      // absPath -> { src, deps }
  const order = []
  const visiting = new Set()
  const visited = new Set()

  function resolve(fromFile, spec) {
    // 内置模块不参与打包：Node 24 里 crypto / fs / path / child_process 等
    // 都是全局可用的，产物顶部的 require 只是给少数非全局 API 兜底。
    if (spec.startsWith('node:')) return null
    if (!spec.startsWith('.')) {
      throw new Error(`${path.basename(fromFile)} 引用了非相对模块 "${spec}"。` +
        'SEA 产物必须完全自包含 —— 不接受内置模块之外的外部依赖')
    }
    const abs = path.resolve(path.dirname(fromFile), spec)
    if (!existsSync(abs)) throw new Error(`解析不到模块: ${spec}（来自 ${fromFile}）`)
    return abs
  }

  function walk(file) {
    if (visited.has(file)) return
    if (visiting.has(file)) {
      throw new Error(`模块图存在循环依赖，涉及 ${file}。` +
        '打包器用拓扑序拼接，无法处理环 —— 请先解开这个环')
    }
    visiting.add(file)
    const src = readFileSync(file, 'utf8')
    rejectDynamicImports(src, file)
    const deps = importSpecifiers(src).map((s) => resolve(file, s)).filter(Boolean)
    for (const d of deps) walk(d)
    visiting.delete(file)
    visited.add(file)
    modules.set(file, src)
    order.push(file)             // 依赖先于使用者 → 依赖在前
  }

  const entryAbs = path.resolve(entry)
  walk(entryAbs)

  // ── 跨模块重名检测 ──
  // 拼接后所有模块共享同一个顶层作用域，重名的 const/let/class/function 会直接
  // 让产物无法解析。早先 gift.js 与 run.js 各自声明了 __dirname 就是这么撞的。
  // 宁可构建失败并指出是哪两个文件，也不要产出一个跑不起来的东西。
  const declared = new Map()
  const collisions = []
  for (const file of order) {
    const body = stripModuleSyntax(modules.get(file), { label: file })
    for (const m of body.matchAll(/^(?:const|let|var|class|function|async function)\s+([A-Za-z_$][\w$]*)/gm)) {
      const name = m[1]
      if (declared.has(name) && declared.get(name) !== file) {
        collisions.push(`${name}（${path.basename(declared.get(name))} 与 ${path.basename(file)}）`)
      } else declared.set(name, file)
    }
  }
  if (collisions.length) {
    throw new Error(
      '以下顶层名字在多个模块里重复，拼接后会冲突：\n  - ' + collisions.join('\n  - ') +
      '\n请把这些共同的东西收拢到一个模块里（像 assets.js 的 rootDir() 那样），' +
      '而不是让打包器去改名绕过 —— 重复定义本身就是问题')
  }

  const parts = []
  const banner = (f) => {
    const rel = path.relative(path.dirname(entryAbs), f).replace(/\\/g, '/')
    return `\n// ${'─'.repeat(66)}\n// ${rel}\n// ${'─'.repeat(66)}\n`
  }

  // ── 内置模块的绑定（`import { promisify } from 'node:util'`）──
  //
  // 坑：拼接会把 `import` 整行删掉，而 `require` 只在内置模块是**全局**的时候
  // 才等价（`process`、`Buffer` 是全局，但 `promisify`、`execFile`、`path` 不是）。
  // 原来产物顶部只硬编码了一小串兜底 require，于是新模块一旦用到别的内置 API
  // 就会在**运行时**报 `promisify is not defined` / `path is not defined` ——
  // 构建期自检抓到的正是这两个。
  //
  // 现在改成**从源码里推导**，支持本项目实际用到的两种形态：
  //   · 命名导入   `import { a, b as c } from 'node:x'`  → `const { a, c } = require('node:x')`
  //   · 默认导入   `import path from 'node:path'`        → `const path = require('node:path')`
  // 哪个模块用了什么就补什么，不需要人维护一张表。
  // 其他形态（`import * as`、`import a, { b }`）本项目没用到 —— 真用到时会在
  // 产物自检（node --check + 真跑一次）里暴露，而不是悄悄产出一个跑不起来的东西。
  {
    const fromModule = new Map()      // 本地名 -> 'node:x'
    const named = new Map()           // 'node:x' -> Map(本地名 -> 原名)
    const defaults = new Map()        // 'node:x' -> Set(本地名)
    const conflicts = []
    const bind = (name, mod) => {
      const prev = fromModule.get(name)
      if (prev && prev !== mod) conflicts.push(`${name}（${prev} 与 ${mod}）`)
      fromModule.set(name, mod)
    }

    for (const f of order) {
      const code = stripComments(modules.get(f))   // 注释里的 import 不算
      // 命名导入（可能带 as）
      for (const m of code.matchAll(/^[ \t]*import\s*\{([^}]*)\}\s*from\s*['"](node:[^'"]+)['"]/gm)) {
        if (!named.has(m[2])) named.set(m[2], new Map())
        for (const piece of m[1].split(',')) {
          const pair = piece.trim().split(/\s+as\s+/).map((x) => x.trim())
          const orig = pair[0]
          const local = pair[1] ?? pair[0]
          if (!orig) continue
          bind(local, m[2])
          // ⚠️ 记的是 (本地名 → 原名)：生成时要写成 `const { createServer: createHttpServer }`。
          //    直接写 `const { createHttpServer } = require('node:http')` 会在运行时
          //    报 "createHttpServer is not a function" —— node:http 里没有这个名字，
          //    那个名字是**源码作者**为了避开重名自己起的。第一版就是这么错的。
          named.get(m[2]).set(local, orig)
        }
      }
      // 默认导入
      for (const m of code.matchAll(/^[ \t]*import\s+([A-Za-z_$][\w$]*)\s*,\s*\{/gm)) {
        throw new Error(`${path.basename(f)} 用了 \`import ${m[1]}, { … }\` 这种混合形态，` +
          '打包器还没支持 —— 请拆成两条 import 语句')
      }
      for (const m of code.matchAll(/^[ \t]*import\s+([A-Za-z_$][\w$]*)\s+from\s*['"](node:[^'"]+)['"]/gm)) {
        bind(m[1], m[2])
        if (!defaults.has(m[2])) defaults.set(m[2], new Set())
        defaults.get(m[2]).add(m[1])
      }
    }

    if (conflicts.length) {
      throw new Error('同一个名字被绑定到了不同的 node: 模块，打包器无法区分：\n  - ' +
        [...new Set(conflicts)].join('\n  - ') +
        '\n  请在其中一处用 `import { x as y }` 起个不同的名字' +
        '（拼接后所有模块共享同一个顶层作用域）')
    }

    for (const [mod, map] of named) {
      const body = [...map].map(([local, orig]) => (local === orig ? local : `${orig}: ${local}`))
      parts.push(`const { ${body.join(', ')} } = require('${mod}')\n`)
    }
    for (const [mod, names] of defaults) {
      for (const n of names) parts.push(`const ${n} = require('${mod}')\n`)
    }
  }
  // ── 命名空间导入（`import * as D from './x509.js'`）──
  //
  // 拼接式打包会把 `import` 整行删掉，于是 `D.SEQUENCE(...)` 里的 `D` 就没有了 ——
  // 产物能构建成功，但一运行就报 `D is not defined`（构建期自检抓到的就是这个）。
  //
  // 做法：把每个模块的导出名收集起来，在**那个模块的代码之后**生成一个
  // `const D = { toPem, SEQUENCE, ... }`。位置必须在依赖之后、使用者之前 ——
  // 拓扑序正好保证这一点（而且 `session-cert.js` 在**顶层**就用了 `D.EXT`，
  // 所以不能偷懒统一放到文件末尾）。
  //
  // 本项目只用到最基本的两种导出形式（`export function/const/class X` 与
  // `export { X }`，没有 `export *` / `export default` / `as` 改名）——
  // 与打包器"只支持实际用到的语法"这条一致。
  const namespaceAliases = new Map()   // 被导入的模块 -> Set(别名)
  const aliasOwner = new Map()         // `as` 别名 -> 声明它的模块（查重名用）
  for (const f of order) {
    const src = modules.get(f)
    for (const m of src.matchAll(/^[ \t]*import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/gm)) {
      const dep = resolve(f, m[2])
      if (!dep) continue
      if (!namespaceAliases.has(dep)) namespaceAliases.set(dep, new Set())
      namespaceAliases.get(dep).add(m[1])
    }
  }

  /** 一个模块导出的顶层名字（拼接后它们就是同一个作用域里的绑定） */
  function exportedNames(src) {
    const names = new Set()
    for (const m of src.matchAll(/^[ \t]*export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
      names.add(m[1])
    }
    for (const m of src.matchAll(/^[ \t]*export\s*\{([^}]*)\}/gm)) {
      for (const piece of m[1].split(',')) {
        const name = piece.trim().split(/\s+as\s+/).pop().trim()
        if (name) names.add(name)
      }
    }
    return [...names]
  }

  /**
   * 相对导入里的 `as` 别名（`import { version as pkgVersion } from './assets.js'`）
   * → 要补一条 `const pkgVersion = version`。
   *
   * 拼接后依赖模块留下的是**原名**，别名不存在了 —— 运行时就是
   * `pkgVersion is not defined`（构建期真跑一次才抓到）。
   * 入口也要走这一步：`main.js` 里同样可能写别名。
   */
  function aliasBindingsFor(f) {
    const lines = []
    for (const m of stripComments(modules.get(f))
      .matchAll(/^[ \t]*import\s*\{([^}]*)\}\s*from\s*['"]\.[^'"]*['"]/gm)) {
      for (const piece of m[1].split(',')) {
        const pair = piece.trim().split(/\s+as\s+/)
        if (pair.length !== 2) continue
        const [orig, alias] = pair.map((x) => x.trim())
        const prev = aliasOwner.get(alias)
        if (prev && prev !== f) {
          throw new Error(`别名 ${alias} 在 ${path.basename(prev)} 与 ${path.basename(f)} 里` +
            '被绑到了不同的东西上 —— 拼接后所有模块共享同一个顶层作用域，请改个名字')
        }
        aliasOwner.set(alias, f)
        lines.push(`const ${alias} = ${orig}\n`)
      }
    }
    return lines
  }

  for (const f of order) {
    if (f === entryAbs) continue   // 入口最后单独处理

    const aliasLines = aliasBindingsFor(f)
    parts.push(banner(f) + (aliasLines.length ? aliasLines.join('') : '') +
      stripModuleSyntax(modules.get(f), { label: f }))
    const aliases = namespaceAliases.get(f)
    if (aliases) {
      const names = exportedNames(modules.get(f))
      if (!names.length) {
        throw new Error(`${path.basename(f)} 被 \`import * as\` 导入，但它没有任何导出 —— ` +
          '打包器无法生成命名空间对象')
      }
      parts.push(`\n// 上面这个模块的命名空间对象（供 import * as 使用）\n` +
        [...aliases].map((a) => `const ${a} = { ${names.join(', ')} }\n`).join(''))
    }
  }

  // ── 入口 ──
  // 入口的导出要挂到全局，供 SEA 的 CommonJS 入口取用。
  // 见 src/entry-globals.md 的说明：为什么不做完整的模块系统。
  const entrySrc = modules.get(entryAbs)
  let entryStripped = stripModuleSyntax(entrySrc, { label: entryAbs })
  // 入口的相对导入也可能带 `as` 别名 —— 和非入口模块一样要补绑定
  const entryAliases = aliasBindingsFor(entryAbs)
  if (entryAliases.length) entryStripped = entryAliases.join('') + entryStripped

  // 收集入口导出的名字
  const exported = new Set()
  for (const m of entrySrc.matchAll(/^[ \t]*export\s+(?:default\s+)?(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    exported.add(m[1])
  }
  for (const m of entrySrc.matchAll(/^[ \t]*export\s*\{([^}]*)\}/gm)) {
    for (const piece of m[1].split(',')) {
      const name = piece.trim().split(/\s+as\s+/).pop().trim()
      if (name) exported.add(name)
    }
  }

  // 顶层 await 在 CommonJS 产物里不合法 —— 把入口的自动执行改成 Promise 链。
  // 只处理这一种形态（本项目实际用到的），不做通用转换。
  const autoRun = /^(\s*)await\s+main\(([^)]*)\)\s*$/m
  if (autoRun.test(entryStripped)) {
    entryStripped = entryStripped.replace(autoRun,
      '$1main($2).then((code) => { process.exitCode = code ?? 0 })' +
      '\n$1  .catch((err) => {' +
      '\n$1    process.stderr.write("\\n  \u2717 " + (err?.message ?? err) + "\\n\\n")' +
      '\n$1    if (process.env.FLICKER_DEBUG) process.stderr.write((err?.stack ?? "") + "\\n")' +
      '\n$1    process.exitCode = 1' +
      '\n$1  })')
  }
  // ⚠️ 这里**故意不做**"扫一遍看有没有 await 开头的行"那种检查。
  //
  //    踩过一次：原来的判据是 `/^\s*await\s/m`，它**分不清**"顶层 await"和
  //    "函数体里缩进较浅的 await"。实测一个写在 class 方法 → try → if → while
  //    里的 `await`（8 个空格缩进）被它误判成顶层 await，构建直接失败，
  //    而报错只说"含顶层 await"，完全没指出是哪一行 —— 排查花了很久。
  //
  //    逐行正则做不到这件事：要准确判断得跟踪括号深度解析，那等于写半个解析器。
  //    而下面本来就有一步 `node --check`（真实语法检查）——
  //    **真的**有顶层 await 时，它一定会报语法错，而且报得比正则准。
  //    所以这里交给它，既不误报也不漏报。

  parts.push(banner(entryAbs) + entryStripped)
  if (exported.size) {
    parts.push('\n' + `globalThis.__flickerEntry = { ${[...exported].join(', ')} }\n`)
  }

  let code = parts.join('\n')

  // 定点替换（在自检之前做，所以替换完仍会被完整校验）
  for (const r of opts.replace ?? []) {
    code = code.replace(r.find, r.replace)
  }

  // 最终自检：不能残留 import/export
  const bad = code.match(/^[ \t]*(?:import|export)\s/m)
  if (bad) throw new Error(`打包结果仍含模块语法: ${bad[0].trim()}`)

  // ⚠️ 这里**故意不检查**"有没有以 await 开头的行"。
  //
  //    原来有这么一条：`/^\s*await\s/m`。问题在于它**分不清**"顶层 await"
  //    和"函数体里缩进较浅的 await"。实测一个写在
  //    class 方法 → try → if → while 里的 await（8 个空格缩进）被它
  //    误判成顶层 await，构建直接失败；而报错只说"含顶层 await"，
  //    完全没指出是哪一行、哪个模块 —— 排查花了很久。
  //
  //    逐行正则做不到这件事：要判准得跟踪括号深度，那等于写半个解析器。
  //    而本函数后面本来就有一步 `node --check`（真实语法检查）：
  //    **真的**有顶层 await 时它一定报语法错，而且报得比正则准。
  //    交给它 —— 既不误报也不漏报。
  //    （入口那处已知的顶层 await 已在上面用 Promise 链替换掉了。）

  if (/^#!/m.test(code)) {
    throw new Error('打包结果含 shebang —— 它只在文件第一行合法，拼接后必然出错')
  }
  // ⚠️ 必须先剥掉注释再判断。
  //    最初直接在原文里搜 import.meta，结果被**注释里提到它**误伤了 ——
  //    文档里解释"这里不能用 import.meta"反而触发了检查。
  //    这类误报会浪费很多时间，所以检查本身也要精确。
  const codeOnly = stripComments(code)
  if (/\bimport\.meta\b/.test(codeOnly)) {
    const where = codeOnly.slice(0, codeOnly.search(/\bimport\.meta\b/)).split('\n').length
    throw new Error(`打包结果里用了 import.meta（约第 ${where} 行）—— ` +
      'CommonJS 里没有这个对象，会直接语法报错。' +
      '模块里不要用 import.meta，把路径从入口传进来（见 src/assets.js 的 installFromDisk）')
  }

  // ── 真实语法检查 ──
  // 只查关键字是不够的：上面那个 shebang 问题就是关键字检查漏掉的。
  // 这里把产物写到临时文件交给 node --check，用真正的解析器验收。
  // 宁可构建慢一点，也不要产出一个跑不起来的东西。
  {
    const { spawnSync } = require('node:child_process')
    const { writeFileSync, mkdtempSync, rmSync } = require('node:fs')
    const { tmpdir } = require('node:os')
    const dir = mkdtempSync(require('node:path').join(tmpdir(), 'flicker-bundle-check-'))
    const probe = require('node:path').join(dir, 'bundle.cjs')
    try {
      writeFileSync(probe, code, 'utf8')
      const r = spawnSync(process.execPath, ['--check', probe], { encoding: 'utf8' })
      if (r.status !== 0) {
        const raw = r.stderr || ''
        const where = (raw.match(/bundle\.cjs:(\d+)/) ?? [])[1]
        // 把两类**可预见的**失败翻译成人话 —— node 的原文（ERR_AMBIGUOUS_MODULE_SYNTAX
        // / "await is only valid in async functions"）对不看产物的人没有指向性。
        // 注意：这里不是"再写一遍语法检查"，而是把真实检查的结果解释清楚。
        if (/await is only valid in async functions|ERR_AMBIGUOUS_MODULE_SYNTAX/i.test(raw)) {
          throw new Error(
            `打包结果含顶层 await（约第 ${where} 行）—— CommonJS 里非法，` +
            '无法作为单文件产物运行。\n' +
            '  入口的 `await main()` 会被自动转成 Promise 链；其他模块里\n' +
            '  不该有顶层 await，请把它移进一个 async 函数。')
        }
        const err = raw.split('\n').slice(0, 6).join('\n')
        throw new Error('打包产物没有通过语法检查：\n' + err)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  return { code, modules: order, bytes: Buffer.byteLength(code, 'utf8') }
}
