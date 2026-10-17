/**
 * 用**真实的解压工具**验证我们自写的 ZIP（`gen/zip.mjs`）
 * =====================================================
 *
 * `test/zip.test.js` 里的解析器是**自己写的一份**（独立实现，但仍是"我方代码"）。
 * 这条判据补上最后一块：**别人的工具能不能解开**。
 * 自写的 ZIP 写错时，最典型的失败就是"我们自己的读取器说没问题，Windows 资源管理器
 * 说压缩包已损坏" —— 所以必须拿真工具试一次。
 *
 * 做法（全都是真的）：
 *   1. 把 dist/ 里真实的产物打成 zip
 *   2. 用系统自带的解压工具解到一个新目录
 *      · Windows：PowerShell `Expand-Archive`
 *      · macOS / Linux：`unzip`
 *   3. **逐字节比对**解出来的文件与原件（SHA-256）
 *   4. 打印真实体积（这也是"zip 分发到底省多少"的权威数字）
 *
 * 用法：node _lab/verify-zip.mjs [产物路径]
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeZip } from '../gen/zip.mjs'
import { makeTempDir, cleanupTempDirs } from '../gen/tmp.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const mb = (n) => (n / 1048576).toFixed(1) + ' MB'

let bad = 0
const check = (ok, msg) => {
  console.log(`  ${ok ? '✓' : '✗'} ${msg}`)
  if (!ok) bad++
}

/** 找要验证的产物：命令行给的，或 dist/ 里最大的那个 flicker-* */
function pickArtifact() {
  const given = process.argv.slice(2).find((a) => !a.startsWith('-'))
  if (given) return path.resolve(given)
  const dist = path.join(ROOT, 'dist')
  const cands = readdirSync(dist)
    .filter((f) => f.startsWith('flicker-') && statSync(path.join(dist, f)).isFile())
    .map((f) => ({ f, size: statSync(path.join(dist, f)).size }))
    .sort((a, b) => b.size - a.size)
  if (!cands.length) throw new Error('dist/ 里没有 flicker-* 产物 —— 先跑 node gen/build-sea.mjs')
  return path.join(dist, cands[0].f)
}

const artifact = pickArtifact()
const name = path.basename(artifact)
const work = makeTempDir('flicker-zipverify-')
const zipPath = path.join(work, `${name}.zip`)
const extractDir = path.join(work, 'out')

console.log(`产物 ${name}（${mb(statSync(artifact).size)}）`)
console.log(`临时目录 ${work}`)

// ── 1. 打包 ────────────────────────────────────────────────
console.log('\n① 用 gen/zip.mjs 打包')
const t0 = Date.now()
const zr = await writeZip(zipPath, [{ name, path: artifact, mode: 0o755 }])
const zipSize = statSync(zipPath).size
console.log(`  zip ${mb(zipSize)}（原始 ${mb(zr.entries[0].rawSize)}，` +
  `${(100 * zipSize / zr.entries[0].rawSize).toFixed(0)}%），用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
check(zipSize < zr.entries[0].rawSize, 'zip 比原件小（否则"zip 分发"这个理由不成立）')

// ── 2. 用系统工具解压 ──────────────────────────────────────
//
// ⚠️ 刻意准备**多个**候选并按顺序试：Windows 上的 `Expand-Archive` 依赖
//    `Microsoft.PowerShell.Archive` 模块自动加载，而这台机器上 `PSModulePath` 被上层
//    工具污染过（`test/trust.test.js` 有一条用例专门守这个），Windows PowerShell 5.1
//    里那句 `Expand-Archive` 会直接报"模块无法加载"。**判据不该因为环境脾气而失败** ——
//    换一个真工具继续验，并把用的是哪一个打印出来。
console.log('\n② 用系统自带的解压工具解开')
const CANDIDATES = process.platform === 'win32'
  ? [
      { label: 'pwsh Expand-Archive', cmd: 'pwsh', args: ['-NoProfile', '-Command',
        `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${extractDir}' -Force`] },
      { label: 'bsdtar (Windows 自带)', cmd: 'tar', args: ['-xf', zipPath, '-C', extractDir] },
      { label: 'Windows PowerShell 5.1 Expand-Archive', cmd: 'powershell', args: ['-NoProfile', '-Command',
        `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${extractDir}' -Force`] },
    ]
  : [
      { label: 'unzip', cmd: 'unzip', args: ['-o', zipPath, '-d', extractDir] },
      { label: 'bsdtar', cmd: 'tar', args: ['-xf', zipPath, '-C', extractDir] },
    ]

let usedTool = null
const attempts = []
for (const c of CANDIDATES) {
  rmSync(extractDir, { recursive: true, force: true })
  const r = spawnSync(c.cmd, c.args, { encoding: 'utf8' })
  const ok = r.status === 0 && existsSync(path.join(extractDir, name))
  attempts.push(`${c.label} → ${ok ? '好' : `不行（退出码 ${r.status ?? 'n/a'}）`}`)
  if (ok) { usedTool = c.label; break }
}
check(Boolean(usedTool), `真实解压工具能解开：${attempts.join('；')}`)
if (usedTool) console.log(`  工具：${usedTool}`)

// ── 3. 逐字节比对 ──────────────────────────────────────────
console.log('\n③ 解出来的与原件逐字节比对')
const extracted = path.join(extractDir, name)
if (!existsSync(extracted)) {
  check(false, `解压目录里没有 ${name} —— 条目名或目录结构写错了`)
} else {
  const [a, b] = await Promise.all([readFile(artifact), readFile(extracted)])
  check(a.length === b.length, `大小一致（${a.length} / ${b.length}）`)
  check(sha256(a) === sha256(b), `SHA-256 一致（${sha256(a).slice(0, 16)}…）`)
}

// ── 4. 结论 ────────────────────────────────────────────────
console.log('')
if (bad) {
  console.error(`✗ ${bad} 处没通过 —— 自写的 ZIP 有问题，别用它发版`)
} else {
  console.log('✓ 真实解压工具能解开，且内容逐字节一致')
  console.log(`  下载量：${mb(zr.entries[0].rawSize)} → ${mb(zipSize)}` +
    `（省 ${(100 - 100 * zipSize / zr.entries[0].rawSize).toFixed(0)}%）`)
}

// 临时目录里那个 zip 有 36 MB，别留着
rmSync(work, { recursive: true, force: true })
cleanupTempDirs()
process.exit(bad ? 1 : 0)
