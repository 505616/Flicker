/**
 * 临时目录前缀的判据
 * ==================
 *
 * 2026-10 用户在自己的 `%TEMP%` 里发现 **2.8 GB / 6717 个文件**，几乎全是我们的：
 * 22 份 93 MB 的产物副本（每次冒烟一份）、十几份浏览器 profile、一堆测试目录。
 * 直接原因各有各的（删不掉被吞掉、进程被强杀），但**共同的可预防条件**是：
 * 我们建的临时目录**名字五花八门**，事后没有任何东西能安全地认领它们 ——
 * 清理脚本不敢删它不认识的目录，于是只能一直躺着。
 *
 * 所以这条判据守的是一句话：**凡是我们建的临时目录，前缀必须登记在册**
 * （`gen/tmp.mjs` 的 `PREFIXES`）。登记了才谈得上自动清理。
 *
 * 检查的是**字面量**：`mkdtemp(join(tmpdir(), 'xxx-'))` 里的 `'xxx-'`。
 * 动态拼出来的名字这里看不到 —— 那属于更隐蔽的写法，靠 code review 兜。
 *
 * 用法：node gen/check-temp-dirs.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PREFIXES } from './tmp.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 要检查的地方：构建脚本、体检脚本、演练脚本、测试 */
const DIRS = ['gen', '_lab', 'test']

/** 本文件自己不算（它读的是别人的名字），tmp.mjs 是登记表本身 */
const SELF = new Set([
  path.join(ROOT, 'gen', 'tmp.mjs'),
  fileURLToPath(import.meta.url),
])

/**
 * `mkdtemp(tmpdir(), 'prefix-')` 的几种写法。
 * 例：`mkdtemp(path.join(tmpdir(), 'flicker-smoke-'))`、
 *     `fs.mkdtempSync(path.join(os.tmpdir(), 'lab-cert-'))`
 */
const CALL = /mkdtemp(?:Sync)?\(\s*(?:fs\.)?(?:path\.)?join\(\s*(?:os\.)?tmpdir\(\)\s*,\s*(['"`])([^'"`]+)\1/g

const problems = []
let seen = 0

function walk(dir) {
  let entries = []
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'out' || e.name === 'node_modules') continue   // _lab/out 是产物目录
      walk(full)
      continue
    }
    if (!e.name.endsWith('.mjs') && !e.name.endsWith('.js')) continue
    if (SELF.has(path.resolve(full))) continue
    const rel = path.relative(ROOT, full).replace(/\\/g, '/')
    const src = readFileSync(full, 'utf8')
    for (const m of src.matchAll(CALL)) {
      seen++
      const prefix = m[2]
      if (!PREFIXES.some((p) => prefix.startsWith(p))) {
        const line = src.slice(0, m.index).split('\n').length
        problems.push({ rel, line, prefix })
      }
    }
  }
}

for (const d of DIRS) walk(path.join(ROOT, d))

if (problems.length) {
  console.error(`✗ 有 ${problems.length} 处临时目录的名字没用登记过的前缀：`)
  for (const p of problems) {
    console.error(`   ${p.rel}:${p.line}  '${p.prefix}'`)
  }
  console.error('\n  改法二选一：')
  console.error('    · 前缀改成 flicker- 开头（推荐，一眼认得出是我们的）')
  console.error('    · 或者加进 gen/tmp.mjs 的 PREFIXES —— 但只能用**能确定属于我们**的名字：')
  console.error('      清理脚本按前缀认领，认错了会删掉别的程序的东西')
  process.exit(1)
}
console.log(`✓ 临时目录前缀都登记在册（检查了 ${seen} 处 mkdtemp 调用）`)
