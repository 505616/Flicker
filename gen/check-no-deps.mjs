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
 * 用法：node gen/check-no-deps.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let bad = 0
const fail = (msg) => { console.error(`✗ ${msg}`); bad++ }

// ── ① package.json ──────────────────────────────────────────
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const deps = Object.keys(pkg.dependencies ?? {})
if (deps.length) {
  fail(`package.json 的 dependencies 不为空：${deps.join(', ')}\n` +
    '  本项目承诺零运行时依赖。若确有必要，请先重新审视这条承诺 —— ' +
    '它决定了"能不能被人读完并信任"。')
} else {
  console.log('✓ package.json：dependencies 为空')
}
const dev = Object.keys(pkg.devDependencies ?? {})
console.log(`  devDependencies：${dev.length ? dev.join(', ') : '（空）'}`)
console.log('  注：构建期的 postject 由 gen/build-sea.mjs 用 npx 临时拉取，不进 package.json。')

// ── ② 源码里的裸模块引用 ────────────────────────────────────
/** 收集要检查的源码文件（不含测试与 _lab） */
function collect(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'dist') continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) collect(full, out)
    else if (/\.(m?js|cjs)$/.test(name)) out.push(full)
  }
  return out
}

const files = [
  ...collect(path.join(ROOT, 'src')),
  ...collect(path.join(ROOT, 'bin')),
  ...collect(path.join(ROOT, 'gen')),
  ...collect(path.join(ROOT, 'relay')),
]

// 静态 import / 动态 import() / require()，抓出模块说明符
const SPEC_RE = /(?:^|\n)\s*(?:import\s+(?:[\s\S]*?)\s+from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)['"]([^'"]+)['"]/g

const bare = []
for (const f of files) {
  const src = readFileSync(f, 'utf8')
  for (const m of src.matchAll(SPEC_RE)) {
    const spec = m[1]
    const isRelative = spec.startsWith('.') || spec.startsWith('/')
    const isBuiltin = spec.startsWith('node:')
    if (isRelative || isBuiltin) continue
    // 只放行真正的 Node 内置名（老写法 'fs' 而不带 node: 前缀）
    const { builtinModules } = await import('node:module')
    if (builtinModules.includes(spec)) continue
    bare.push(`${path.relative(ROOT, f)} → ${spec}`)
  }
}

if (bare.length) {
  fail('源码里引用了非内置模块：\n  ' + bare.join('\n  ') +
    '\n  本项目只用 node: 内置模块。')
} else {
  console.log(`✓ 源码：${files.length} 个文件，全部只引用相对路径或 node: 内置模块`)
}

if (bad) {
  console.error(`\n${bad} 处违反"零运行时依赖"`)
  process.exit(1)
}
console.log('\n✓ 零运行时依赖承诺成立')
