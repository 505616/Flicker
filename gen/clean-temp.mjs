/**
 * 清理我们留在系统临时目录里的东西
 * ==================================
 *
 * 起因（2026-10，用户发现的）：`%TEMP%` 里躺着 1000 多个文件、**2.4 GB**，
 * 几乎全是我们的 —— 22 份 93 MB 的产物副本（每次冒烟一份）、几十个测试与演练目录。
 * 冒烟脚本本来是删的，但它 `rmSync(..., {force:true})` **删不掉就吞异常**，
 * 而 Windows 上刚 kill 掉的进程会短暂占着 exe，于是每次都留一份。
 *
 * 这个脚本是"事后收拾"的那一半（"事前不留"由 `gen/tmp.mjs` 负责）：
 * 它只认**我们自己的前缀**（`gen/tmp.mjs` 的 PREFIXES），绝不碰别人放在临时目录里的东西。
 *
 * 用法：
 *   node gen/clean-temp.mjs            # 只报告（默认，安全）
 *   node gen/clean-temp.mjs --yes      # 真的删
 *   node gen/clean-temp.mjs --yes --min-age=0   # 连刚刚建的也删（默认跳过 60 秒内的）
 */
import { readdirSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PREFIXES } from './tmp.mjs'

const argv = process.argv.slice(2)
const yes = argv.includes('--yes')
const verbose = argv.includes('--all')
const minAgeMs = (() => {
  const a = argv.find((x) => x.startsWith('--min-age='))
  if (!a) return 60_000          // 默认跳过"刚刚建的"：可能有别的进程正用着
  const n = Number(a.slice('--min-age='.length))
  return Number.isFinite(n) ? n * 1000 : 60_000
})()

/**
 * 扫一遍并删掉"比自己老的"临时目录 —— 给 `gen/run-tests.mjs` 顺手调用。
 *
 * 抽成函数而不是让它 spawn 本脚本，是为了不引入一次进程启动（测试入口要快）。
 * 判据与命令行版**完全一样**：只认我们的前缀 + 只删足够老的。
 *
 * @param {{olderThanMs:number}} o
 * @returns {number} 删掉了几项
 */
export function sweepStale({ olderThanMs = 3600_000 } = {}) {
  let n = 0
  let names = []
  try { names = readdirSync(tmpdir()) } catch { return 0 }
  for (const name of names) {
    if (!PREFIXES.some((p) => name.startsWith(p))) continue
    const full = path.join(tmpdir(), name)
    let st
    try { st = statSync(full) } catch { continue }
    if (Date.now() - st.mtimeMs < olderThanMs) continue
    try { rmSync(full, { recursive: true, force: true }); n++ } catch { /* 占着就下次再说 */ }
  }
  return n
}

// ── 作为命令行的主体（被 import 时不执行）──
// ⚠️ 这里用 `import.meta.url` 与 `process.argv[1]` 比较：Node 的 ESM 没有 require.main。
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (!isMain) { /* 只是被 import：不打印、不删 */ } else {

const base = tmpdir()
const found = []
let skippedYoung = 0

for (const name of readdirSync(base)) {
  if (!PREFIXES.some((p) => name.startsWith(p))) continue
  const full = path.join(base, name)
  let st
  try { st = statSync(full) } catch { continue }
  if (minAgeMs > 0 && Date.now() - st.mtimeMs < minAgeMs) { skippedYoung++; continue }
  let bytes = st.size
  let files = 0
  if (st.isDirectory()) {
    bytes = 0
    const walk = (d) => {
      let entries = []
      try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const f = path.join(d, e.name)
        if (e.isDirectory()) walk(f)
        else { try { bytes += statSync(f).size; files++ } catch { /* 读不到就算了 */ } }
      }
    }
    walk(full)
  } else files = 1
  found.push({ name, full, bytes, files, mtime: st.mtimeMs })
}

found.sort((a, b) => b.bytes - a.bytes)
const totalBytes = found.reduce((s, x) => s + x.bytes, 0)
const totalFiles = found.reduce((s, x) => s + x.files, 0)

console.log(`临时目录：${base}`)
console.log(`我们留下的：${found.length} 项 · ${totalFiles} 个文件 · ${(totalBytes / 1048576).toFixed(1)} MB` +
  (skippedYoung ? `（另有 ${skippedYoung} 项不到 ${minAgeMs / 1000} 秒，跳过）` : ''))
console.log('')
for (const x of verbose ? found : found.slice(0, 25)) {
  console.log(`  ${(x.bytes / 1048576).toFixed(1).padStart(9)} MB  ${String(x.files).padStart(5)} 个文件  ${x.name}`)
}
if (!verbose && found.length > 25) {
  console.log(`  …还有 ${found.length - 25} 项（要全列：node gen/clean-temp.mjs --all）`)
}

if (!yes) {
  console.log('\n（只是报告，没有删。要真的删：node gen/clean-temp.mjs --yes）')
  process.exit(0)
}

let removed = 0, failed = []
for (const x of found) {
  try {
    rmSync(x.full, { recursive: true, force: true })
    removed++
  } catch (e) {
    failed.push(`${x.name}（${e?.code ?? e?.message ?? e}）`)
  }
}
console.log(`\n✓ 删掉 ${removed} 项，回收约 ${(totalBytes / 1048576).toFixed(1)} MB`)
if (failed.length) {
  console.error(`✗ ${failed.length} 项没删掉（多半有进程还占着）：`)
  for (const f of failed) console.error('   ' + f)
  process.exit(1)
}
}   // ← 结束"当命令跑"的那一段（被 import 时只导出 sweepStale，什么都不打印、不删）
