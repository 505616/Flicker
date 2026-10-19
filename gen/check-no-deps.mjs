/**
 * 断言"零运行时依赖"这条承诺。
 *
 * 为什么值得单写一个脚本并在 CI 里跑：
 *   这是这个项目最核心的可信度来源之一 —— 想审计它的人可以读完所有代码。
 *   一旦有人不小心 `npm i` 了某个包并写进 dependencies，承诺就破了，
 *   而**运行时**往往还是正常的（本地 node_modules 里有），
 *   只有拿到干净环境里才会暴露。CI 是唯一能在提交时就拦住它的地方。
 *
 * 判据分两层：
 *   ① package.json 的 dependencies 必须为空
 *   ② 源码里不得 import/require 非 node: 的裸模块名
 *      （②更重要：dependencies 为空但代码里 import 'lodash' 一样是依赖）
 *
 * ⚠️ 这一条也被自己的测试反过来验（`test/no-deps.test.js`）：拿一份塞了坏输入的
 *    假仓库去跑，必须报出问题。所以判据逻辑抽成了 `auditNoDeps(root)`，CLI 只是
 *    打印它 —— 否则"检查脚本"就只能靠人读代码相信它。
 *
 * 用法：node gen/check-no-deps.mjs [--root=<另一棵树>]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { builtinModules } from 'node:module'
import { stripComments } from './bundler.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 从 `--key=value` 里取值（测试注入坏掉的副本用） */
export function argOf(argv, name, fallback) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

/** 收集要检查的源码文件（不含测试与 _lab） */
export function collectSources(root) {
  const out = []
  const walk = (dir) => {
    let names = []
    try { names = readdirSync(dir) } catch { return }
    for (const name of names) {
      if (name === 'node_modules' || name === '.git' || name === 'dist') continue
      const full = path.join(dir, name)
      let st = null
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) walk(full)
      else if (/\.(m?js|cjs)$/.test(name)) out.push(full)
    }
  }
  for (const dir of ['src', 'bin', 'gen', 'relay']) walk(path.join(root, dir))
  return out
}

/** 静态 import / 动态 import() / require()，抓出模块说明符 */
const SPEC_RE = /(?:^|\n)\s*(?:import\s+(?:[\s\S]*?)\s+from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)['"]([^'"]+)['"]/g
/** 行中间的 `require('pkg')`（`const x = require('pkg')` 是常见写法） */
const REQUIRE_RE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
/** 行中间的 `await import('pkg')` */
const DYN_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g

/**
 * 核一棵树：返回 { problems, info }。
 * @param {string} root 仓库根目录（测试时指向一份临时副本）
 */
export function auditNoDeps(root = ROOT) {
  const problems = []
  const info = []

  // ── ① package.json ────────────────────────────────────────
  let pkg = {}
  try {
    pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  } catch (e) {
    problems.push(`读不到 package.json：${e.message}`)
    return { problems, info }
  }
  const deps = Object.keys(pkg.dependencies ?? {})
  if (deps.length) {
    problems.push(`package.json 的 dependencies 不为空：${deps.join(', ')}\n` +
      '  本项目承诺零运行时依赖。若确有必要，请先重新审视这条承诺 —— ' +
      '它决定了"能不能被人读完并信任"。')
  } else {
    info.push('✓ package.json：dependencies 为空')
  }
  const dev = Object.keys(pkg.devDependencies ?? {})
  info.push(`  devDependencies：${dev.length ? dev.join(', ') : '（空）'}`)
  info.push('  注：构建期的 postject 由 gen/build-sea.mjs 用 npx 临时拉取，不进 package.json。')

  // ── ② 源码里的裸模块引用 ──────────────────────────────────
  const files = collectSources(root)
  const bare = []
  for (const f of files) {
    const raw = readFileSync(f, 'utf8')
    // ⚠️ 注释先剥掉（复用 bundler 里那份实现，同一个坑只踩一次）：
    //    `check-no-deps.mjs` 自己的注释里就写着 `const x = require('pkg')` ——
    //    不剥注释，判据会被自己的文档误伤（bundler.mjs 的 `await import('./gui.js')`
    //    当年就是这么被误伤的）。
    const src = stripComments(raw)
    const specs = new Set()
    for (const m of raw.matchAll(SPEC_RE)) specs.add(m[1])
    // ⚠️ 上面那条正则要求 `import` 出现在行首 —— 那只是写法之一。
    //    `const x = require('pkg')` 与 `await import('pkg')` 都在行中间，
    //    不单独扫一遍就会漏（2026-10 写反向用例时实测：假仓库里的 require 一条都没抓到）。
    for (const m of src.matchAll(REQUIRE_RE)) specs.add(m[1])
    for (const m of src.matchAll(DYN_IMPORT_RE)) specs.add(m[1])
    for (const spec of specs) {
      const isRelative = spec.startsWith('.') || spec.startsWith('/')
      const isBuiltin = spec.startsWith('node:')
      if (isRelative || isBuiltin) continue
      // 模板插值（`require('${mod}')`）在这里的静态扫描无法定值，不当作依赖：
      // gen/bundler.mjs 自己就是用模板拼 `require('node:http')` 的。
      if (spec.includes('${')) continue
      // 只放行真正的 Node 内置名（老写法 'fs' 而不带 node: 前缀）
      if (builtinModules.includes(spec)) continue
      bare.push(`${path.relative(root, f).replace(/\\/g, '/')} → ${spec}`)
    }
  }

  if (bare.length) {
    problems.push('源码里引用了非内置模块：\n  ' + bare.join('\n  ') +
      '\n  本项目只用 node: 内置模块。')
  } else {
    info.push(`✓ 源码：${files.length} 个文件，全部只引用相对路径或 node: 内置模块`)
  }
  return { problems, info }
}

// ── CLI ──────────────────────────────────────────────────────

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  const root = argOf(process.argv.slice(2), 'root', ROOT)
  const { problems, info } = auditNoDeps(root)
  for (const line of info) console.log(line)
  if (problems.length) {
    for (const p of problems) console.error(`✗ ${p}`)
    console.error(`\n${problems.length} 处违反"零运行时依赖"`)
    process.exit(1)
  }
  console.log('\n✓ 零运行时依赖承诺成立')
}
