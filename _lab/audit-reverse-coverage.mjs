/**
 * 体检：`npm run check` 里的每一条判据，是否都有"能红的证据"
 * ========================================================
 *
 * 一个从不失败的检查等于没有检查。所以每条判据都该有对应的测试文件，
 * 而且那个测试里要出现**两种东西之一**：
 *   · 真的去跑反向验证脚本（`_lab/verify-*-check.mjs`）；
 *   · 或者 import 判据导出的函数、用坏输入反过来验它。
 *
 * 这个脚本只读（不改任何东西），用来看"哪些判据目前只有正例"：
 *
 *   node _lab/audit-reverse-coverage.mjs            # 打一张表
 *   node _lab/audit-reverse-coverage.mjs --strict   # 有任何一条没有证据就退出码 1
 *
 * ⚠️ 这是**启发式**：它按"测试文件里出现判据文件名 + 出现反向证据词"来判断。
 *    判据换个写法（比如把逻辑搬到共享模块）它就会认不出 —— 所以只当体检用，
 *    没放进 `npm run check`（免得变成一条会误报的硬闸）。结论记在 `交接.md` §六点六。
 *
 * 用法：node _lab/audit-reverse-coverage.mjs [--strict]
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const strict = process.argv.includes('--strict')

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const chain = pkg.scripts.check.split('&&').map((s) => s.trim()).filter(Boolean)
  .map((s) => s.replace(/^node\s+/, '').split(/\s+/)[0])

/** 反向证据的几种形态 */
const EVIDENCE = [
  /_lab\/verify-[a-z-]*check/,
  /audit[A-Z]\w*\(/,
  /compare[A-Z]\w*\(/,
  /unregisteredPrefixes\(/,
  /structureOf\(/,
  /packStructureProblems\(/,
  /checkTestStatus\(/,
  /--check/,
  /--root=/,
  /反向/,
  /证伪/,
  /该抓的抓得住|不该误伤/,
]

const tests = readdirSync(path.join(ROOT, 'test'))
  .filter((f) => f.endsWith('.test.js'))
  .map((f) => ({ name: `test/${f}`, src: readFileSync(path.join(ROOT, 'test', f), 'utf8') }))

const rows = []
for (const cmd of chain) {
  const base = path.basename(cmd)
  const hits = tests.filter((t) => t.src.includes(base) || t.src.includes(cmd))
  const evidence = hits.filter((t) => EVIDENCE.some((re) => re.test(t.src)))
  rows.push({
    cmd,
    tests: hits.map((t) => t.name),
    coverage: hits.length === 0 ? '无测试'
      : evidence.length === 0 ? '有测试但没看到反向证据' : '有反向证据',
  })
}

const pad = (s, n) => s + ' '.repeat(Math.max(0, n - [...s].reduce((w, c) => w + (c.charCodeAt(0) > 127 ? 2 : 1), 0)))

console.log(pad('判据', 34) + pad('状态', 26) + '测试文件')
for (const r of rows) {
  console.log(pad(r.cmd, 34) + pad(r.coverage, 26) + (r.tests.join(', ') || '—'))
}

const bad = rows.filter((r) => r.coverage !== '有反向证据')
console.log(`\n${rows.length} 条判据：${rows.length - bad.length} 条有反向证据` +
  (bad.length ? `，${bad.length} 条需要人工确认：\n` + bad.map((b) => `  · ${b.cmd}（${b.coverage}）`).join('\n') : ''))
if (strict && bad.length) process.exit(1)
