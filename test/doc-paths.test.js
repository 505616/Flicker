/**
 * 「文档说有的东西必须真的有」判据自己的判据
 * ============================================
 * `gen/check-doc-paths.mjs` 守三类引用：仓库内路径、`npm run <脚本>`、`FLICKER_*` 环境变量。
 * 它自己也得能**证伪**，否则就是又一个"看起来在管、其实从不失败"的检查。
 *
 * 这里用**临时目录**造一个"迷你仓库"（而不是改真文档）：真文档一个字都不动，
 * 判据的每条分支都能单独验：
 *   ① 现在真文档必须全过；
 *   ② 引用了不存在的文件 → 报**文件与行号**；
 *   ③ 扩展名边界：`page-plugins.json` 不能被截成 `.js`（第一版就是这样误报的）；
 *   ④ `npm run` 不存在 → 红；但同一行写着"从来不存在"的历史叙述 → 不红；
 *   ⑤ `FLICKER_*` 源码没读过 → 红；
 *   ⑥ 允许清单里的（npm 自己的 `bin/npx-cli.js`）→ 不红，而且每条都得写理由。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  PATH_ALLOW, checkDocRefs, docFiles, extractRefs, saysMissing, sourceEnvVars,
} from '../gen/check-doc-paths.mjs'

const cleanups = []
after(() => {
  for (const fn of cleanups.splice(0)) {
    try { fn() } catch (e) { console.error('清理失败：' + (e?.message ?? e)) }
  }
})

/** 造一个迷你仓库：package.json + 一个读 FLICKER_REAL 的源文件 + 一份文档 */
function miniRepo({ doc = '', scripts = { check: 'node gen/x.mjs', 'test:fast': 'x' }, src = 'process.env.FLICKER_REAL\n' } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'flicker-docpaths-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(path.join(root, 'src'), { recursive: true })
  mkdirSync(path.join(root, 'docs'), { recursive: true })
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts }))
  writeFileSync(path.join(root, 'src', 'x.mjs'), src)
  writeFileSync(path.join(root, 'docs', 'x.md'), doc)
  return root
}

test('① 真文档里的引用全都能落地', () => {
  const { problems, counts } = checkDocRefs({})
  assert.deepEqual(problems, [], problems.map((p) => `${p.file}:${p.line} ${p.value}`).join('\n'))
  assert.ok(counts.paths > 50, `应当真的在核一批路径（实际 ${counts.paths}）`)
  assert.ok(counts.npmRuns > 10, `应当真的在核一批 npm 脚本（实际 ${counts.npmRuns}）`)
  assert.ok(counts.envVars > 0, '应当真的在核 FLICKER_* 变量')
})

test('② 反向验证：文档引用了一个不存在的文件 → 报出文件与行号', () => {
  const root = miniRepo({ doc: '第一行\n见 `src/missing.mjs`。\n' })
  const { problems } = checkDocRefs({ root })
  const hit = problems.find((p) => p.value === 'src/missing.mjs')
  assert.ok(hit, '不存在的文件必须被报出来')
  assert.equal(hit.line, 2, '行号要对得上（方便直接跳过去改）')
  assert.equal(hit.file, 'docs/x.md')
})

test('③ 扩展名边界：`page-plugins.json` 不能被截成 `.js`', () => {
  const refs = extractRefs('清单见 `web/page-plugins.json`，别删。')
  assert.deepEqual(refs.paths.map((p) => p.value), ['web/page-plugins.json'])
  // 真仓库里这个文件确实存在，所以不该被报
  const { problems } = checkDocRefs({})
  assert.ok(!problems.some((p) => /page-plugins/.test(p.value)))
})

test('④ npm run：不存在的脚本要红，但"记录它不存在"的历史叙述不红', () => {
  const bad = miniRepo({ doc: '请跑 `npm run nope` 试试。\n' })
  assert.ok(checkDocRefs({ root: bad }).problems.some((p) => p.kind === 'npm 脚本' && p.value === 'npm run nope'))

  const history = miniRepo({ doc: '`npm run test:unit` / `npm run test:serial` —— 这两个脚本从来不存在。\n' })
  assert.deepEqual(checkDocRefs({ root: history }).problems, [],
    '历史叙述（明说这两个脚本不存在）不该被这条判据判红 —— 否则等于逼人抹掉历史')
  assert.ok(saysMissing('这两个脚本从来不存在'), 'saysMissing 要认得这句中文')
  assert.ok(saysMissing("these scripts don't exist"), '也要认得英文')
})

test('④ 存在的脚本不报', () => {
  const ok = miniRepo({ doc: '跑 `npm run test:fast` 即可。\n' })
  assert.deepEqual(checkDocRefs({ root: ok }).problems, [])
})

test('⑤ FLICKER_* 环境变量：源码没读过就要红', () => {
  const root = miniRepo({ doc: '可以设 `FLICKER_TOTALLY_FAKE=1`。\n' })
  const { problems } = checkDocRefs({ root })
  assert.ok(problems.some((p) => p.kind === '环境变量' && p.value === 'FLICKER_TOTALLY_FAKE'))

  const ok = miniRepo({ doc: '可以设 `FLICKER_REAL=1`。\n' })
  assert.deepEqual(checkDocRefs({ root: ok }).problems, [])
  assert.ok(sourceEnvVars(ok).has('FLICKER_REAL'))
})

test('⑥ 允许清单：npm 自己的路径不算我们的，而且每条都写了理由', () => {
  const root = miniRepo({ doc: '真正执行的是 `node <npm>/bin/npx-cli.js`。\n' })
  assert.deepEqual(checkDocRefs({ root }).problems, [], 'npm 内部文件不该被当成"我们缺文件"')
  assert.ok(PATH_ALLOW.length > 0)
  for (const a of PATH_ALLOW) {
    assert.ok(a.why && a.why.length > 10, `允许清单里每条都要写清理由：${a.re}`)
  }
})

test('真仓库的文档清单里包含中英文两套与交接', () => {
  const files = docFiles(path.resolve('.'))
  assert.ok(files.includes('docs/路线图.md'))
  assert.ok(files.includes('中文文档/路线图.md'))
  assert.ok(files.includes('_lab/交接.md'))
})
