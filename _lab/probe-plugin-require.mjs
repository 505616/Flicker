/**
 * 实测：**插件能不能 `require` 自己目录下的辅助文件**（SEA 单文件产物里）
 * =======================================================================
 *
 * `插件.md` §11 里挂着一条「未验证：单文件产物里能否 `require` 磁盘上的相对文件」，
 * 所以插件文档要求"自包含"。这条一直没人量过 —— 而它直接决定插件作者能不能拆文件。
 *
 * 判据（可证伪）：
 *   ① 自包含插件 → `--plugins` 必须**通过**（否则是插件加载器本身坏了，测不出任何东西）
 *   ② 带 `require('./helper.cjs')` 的插件 → 结果必须**明确**：要么跑通（文档可以放宽），
 *      要么报一个能看懂的错误（文档要把"不行"写成事实，而不是"未验证"）
 *
 * 用法：node _lab/probe-plugin-require.mjs [产物路径]
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeTempDir, cleanupTempDirs } from '../gen/tmp.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function pickExe() {
  const given = process.argv.slice(2).find((a) => !a.startsWith('-'))
  if (given) return path.resolve(given)
  const dist = path.join(ROOT, 'dist')
  const cands = readdirSync(dist)
    .filter((f) => f.startsWith('flicker-') && statSync(path.join(dist, f)).isFile())
  if (!cands.length) throw new Error('dist/ 里没有产物 —— 先跑 node gen/build-sea.mjs')
  return path.join(dist, cands.sort().pop())
}

const exe = pickExe()
const dir = makeTempDir('flicker-probe-plugin-')
console.log(`产物 ${path.basename(exe)}`)
console.log(`临时目录 ${dir}\n`)

// 辅助文件：内容无关紧要，只要能分辨"require 成功拿到它"和"没拿到"
await writeFile(path.join(dir, 'helper.cjs'),
  'module.exports = { fromHelper: true, note: "被 require 到了" }\n', 'utf8')

/** 自包含插件（对照组） */
const SELF_CONTAINED = `
module.exports = {
  name: 'self-contained-probe',
  apiVersion: 1,
  apply(ctx) {
    ctx.on('run/start', () => {})
  },
}
`
/** 会去 require 同目录辅助文件的插件（实验组） */
const NEEDS_HELPER = `
const helper = require('./helper.cjs')
module.exports = {
  name: 'needs-helper-probe',
  apiVersion: 1,
  apply(ctx) {
    if (!helper || !helper.fromHelper) throw new Error('helper 没被拿到')
    ctx.on('run/start', () => {})
  },
}
`

await writeFile(path.join(dir, 'self-contained.cjs'), SELF_CONTAINED, 'utf8')
await writeFile(path.join(dir, 'needs-helper.cjs'), NEEDS_HELPER, 'utf8')

/** 跑一次 `--plugins --plugin=<文件>`（`--plugins` 只加载+校验，不传输） */
function runWith(pluginFile) {
  const r = spawnSync(exe, ['--plugins', `--plugin=${pluginFile}`], {
    encoding: 'utf8', timeout: 60000, windowsHide: true,
    env: { ...process.env, FLICKER_NO_OPEN: '1' },
  })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }
}

let bad = 0
const check = (ok, msg, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${msg}${detail ? `\n      ${detail.replace(/\n/g, '\n      ')}` : ''}`)
  if (!ok) bad++
}

console.log('① 对照组：自包含插件')
const a = runWith(path.join(dir, 'self-contained.cjs'))
check(a.code === 0, `退出码 ${a.code}（应当 0 —— 不然连插件加载器都坏了，下面的结论没意义）`,
  a.out.slice(0, 400))

console.log('\n② 实验组：插件 require 同目录的 helper.cjs')
const b = runWith(path.join(dir, 'needs-helper.cjs'))
const worked = b.code === 0
const named = /helper|Cannot find|MODULE_NOT_FOUND|require/i.test(b.out)
check(worked || named,
  worked ? '✅ **能用** —— 插件可以拆辅助文件（文档要放宽）'
    : '❌ **不能用** —— 但错误信息里点出了 require/helper 相关的原因',
  b.out.slice(0, 600))
if (!worked && !named) {
  console.log('      （错误信息没提 require/helper —— 对插件作者来说等于没有线索）')
}

console.log('')
if (bad) {
  console.error('✗ 有结论没拿到 —— 别急着改文档')
} else {
  console.log(worked
    ? '结论：**单文件产物里插件可以 require 相对文件**（文档里"要求自包含"的说法可以放宽）'
    : '结论：**单文件产物里插件不能 require 相对文件**（文档要把"未验证"改成"不行"，并要求自包含）')
}

cleanupTempDirs()
process.exit(bad ? 1 : 0)
