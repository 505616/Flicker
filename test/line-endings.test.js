/**
 * 行尾判据（`gen/check-line-endings.mjs`）必须真的会**红**
 * ======================================================
 *
 * 为什么要专门验它：这条判据存在的原因本身就是"一次只有 CI 才发现的失败" ——
 * 2026-10 有个脚本在 Windows 上用文本模式回写了几份文件（`\n` → `\r\n`），
 * 而 `gen/inline-i18n.mjs` 的指纹算的是**字节**：
 *   本地 `npm run check` 全绿 → 推上去 → CI 三个平台齐红 → 报"i18n 内联段不一致"，
 *   完全指不到根因是行尾。
 *
 * 于是这里做**反向验证**：真的放一个 CRLF 的文本文件进仓库，判据必须退出码 1 并点名它；
 * 删掉之后必须恢复绿。只验"跑起来不报错"的判据等于没有判据。
 *
 * ⚠️ 这个用例会在仓库根目录里**短暂**创建一个文件。清理放在 `finally` 里
 *    （失败也不会留痕），并且用 `flicker-` 前缀，一眼认得出是测试留的。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SCRIPT = path.join(ROOT, 'gen', 'check-line-endings.mjs')
const NAME = `flicker-eol-probe-${randomBytes(4).toString('hex')}.md`
const FILE = path.join(ROOT, NAME)

const run = () => spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8' })

const cleanups = []
after(() => {
  for (const fn of cleanups.splice(0)) {
    try { fn() } catch (e) { console.error('清理失败：' + (e?.message ?? e)) }
  }
})

test('现在应当是绿的（没有 CRLF 的文本文件）', () => {
  const r = run()
  assert.equal(r.status, 0, `判据应当通过：\n${r.stdout}${r.stderr}`)
})

test('⭐ 反向验证：放一个 CRLF 的 .md 进去，判据必须红并点名它', () => {
  cleanups.push(() => rmSync(FILE, { force: true }))
  writeFileSync(FILE, '# 探针\r\n\r\n这个文件用 CRLF 行尾，判据必须抓住它。\r\n')
  const r = run()
  assert.notEqual(r.status, 0, '有 CRLF 文件时判据必须失败')
  const out = r.stdout + r.stderr
  assert.match(out, new RegExp(NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    '报错必须**点名是哪个文件** —— 只报"有文件行尾不对"等于让人去猜')
  assert.match(out, /CRLF/, '要说清是 CRLF 的问题')
  assert.match(out, /指纹|eol=lf/, '要说清为什么在乎行尾（内容指纹 / .gitattributes）')

  // 删掉之后必须立刻恢复绿 —— 否则这条判据可能只是"永远红"
  rmSync(FILE, { force: true })
  cleanups.length = 0
  const again = run()
  assert.equal(again.status, 0, `删掉探针文件之后应当恢复通过：\n${again.stdout}${again.stderr}`)
})

test('.sh / .command 仍然要求全 LF（这条比文本文件的约定更老，别被改松）', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(r.status, 0)
  // 判据的存在性由上面那条反向验证覆盖；这里确认它没有在改规则时被整体删掉
  const src = spawnSync(process.execPath, ['-e',
    `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(SCRIPT)},'utf8'))`],
  { encoding: 'utf8' }).stdout
  assert.match(src, /'\.cmd': 'CRLF'/, 'cmd/bat 仍必须是 CRLF（cmd.exe 的要求）')
  assert.match(src, /'\.sh': 'LF'/, 'sh 仍必须是 LF')
})
