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
 * 判据逻辑抽成 `unregisteredPrefixes()`（纯函数：喂源码文本、回问题清单），
 * CLI 只负责扫盘与打印 —— `test/temp-dirs.test.js` 用它反过来验这几条
 * （未登记必须报、`flicker-` 开头必须放行、几种写法都要抓得到）。
 *
 * 用法：node gen/check-temp-dirs.mjs [--root=<另一棵树>]
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PREFIXES } from './tmp.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 从 `--key=value` 里取值（测试注入坏掉的副本用） */
export function argOf(argv, name, fallback) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

/** 要检查的地方：构建脚本、体检脚本、演练脚本、测试 */
export const DIRS = ['gen', '_lab', 'test']

/**
 * `mkdtemp(tmpdir(), 'prefix-')` 的几种写法。
 * 例：`mkdtemp(path.join(tmpdir(), 'flicker-smoke-'))`、
 *     `fs.mkdtempSync(path.join(os.tmpdir(), 'lab-cert-'))`
 */
export const CALL = /mkdtemp(?:Sync)?\(\s*(?:fs\.)?(?:path\.)?join\(\s*(?:os\.)?tmpdir\(\)\s*,\s*(['"`])([^'"`]+)\1/g

/**
 * 从源码文本里找出所有 mkdtemp 前缀，挑出没登记的。
 * @param {string} src 源码文本
 * @param {string[]} prefixes 登记表（默认 gen/tmp.mjs 的 PREFIXES）
 * @returns {Array<{prefix:string, index:number}>}
 */
export function unregisteredPrefixes(src, prefixes = PREFIXES) {
  const out = []
  for (const m of src.matchAll(CALL)) {
    const prefix = m[2]
    if (!prefixes.some((p) => prefix.startsWith(p))) out.push({ prefix, index: m.index })
  }
  return out
}

/**
 * 扫一棵树：返回 { problems: [{rel, line, prefix}], seen }。
 * @param {string} root 仓库根目录（测试时指向临时副本）
 */
export function auditTempDirs(root = ROOT) {
  const self = new Set([path.join(root, 'gen', 'tmp.mjs')])
  const problems = []
  let seen = 0

  const walk = (dir) => {
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
      if (path.basename(full) === 'check-temp-dirs.mjs') continue      // 它读的是别人的名字
      if (self.has(path.resolve(full))) continue
      const rel = path.relative(root, full).replace(/\\/g, '/')
      const src = readFileSync(full, 'utf8')
      seen += [...src.matchAll(CALL)].length
      for (const { prefix, index } of unregisteredPrefixes(src)) {
        problems.push({ rel, line: src.slice(0, index).split('\n').length, prefix })
      }
    }
  }

  for (const d of DIRS) walk(path.join(root, d))
  return { problems, seen }
}

// ── CLI ──────────────────────────────────────────────────────

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  const root = argOf(process.argv.slice(2), 'root', ROOT)
  const { problems, seen } = auditTempDirs(root)
  if (problems.length) {
    console.error(`✗ 有 ${problems.length} 处临时目录的名字没用登记过的前缀：`)
    for (const p of problems) console.error(`   ${p.rel}:${p.line}  '${p.prefix}'`)
    console.error('\n  改法二选一：')
    console.error('    · 前缀改成 flicker- 开头（推荐，一眼认得出是我们的）')
    console.error('    · 或者加进 gen/tmp.mjs 的 PREFIXES —— 但只能用**能确定属于我们**的名字：')
    console.error('      清理脚本按前缀认领，认错了会删掉别的程序的东西')
    process.exit(1)
  }
  console.log(`✓ 临时目录前缀都登记在册（检查了 ${seen} 处 mkdtemp 调用）`)
}
