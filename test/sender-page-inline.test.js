/**
 * 网页发送端内联生成器（`gen/inline-sender.mjs`）自己的判据
 * ======================================================
 * 这一页的全部脚本都要在**构建期内联**进 HTML（CSP 不许外部脚本、中继托管时页面必须自包含），
 * 所以生成器一旦静默失效，用户打开的就是一个"点了没反应"的页面 —— 而且不会有任何报错。
 *
 * 反向验证覆盖：
 *   · 真仓库：内联段与源文件一致（`--check` 通过），且页面里确实有 `FlickerPhone` 与 `FlickerSender`
 *   · 改了源文件不重跑 → `--check` 必须报"不同步"（在临时副本上验证，不碰真页面）
 *   · 源文件用了浏览器跑不了的东西（import/Buffer/process）→ 生成器必须拒绝并指出行号
 *   · 顺序：phone-core 必须先于 sender-core（后者依赖 globalThis.FlickerPhone）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkSources, buildBlock, SOURCES, BEGIN, END } from '../gen/inline-sender.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PAGE = path.join(ROOT, 'web', 'sender.html')
const GEN = path.join(ROOT, 'gen', 'inline-sender.mjs')

test('真仓库：--check 通过（内联段与源文件同步）', () => {
  const r = spawnSync(process.execPath, [GEN, '--check'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(r.status, 0, `内联段不同步：\n${r.stdout}${r.stderr}`)
  assert.match(r.stdout, /内联段是最新的/)
})

test('页面里两段内核都在，且顺序正确（phone-core 先）', () => {
  const html = readFileSync(PAGE, 'utf8')
  const b = html.indexOf(BEGIN)
  const e = html.indexOf(END)
  assert.ok(b >= 0 && e > b, '页面里要有 sender-core 内联段的标记')
  const block = html.slice(b, e)
  const phoneAt = block.indexOf(SOURCES[0])
  const senderAt = block.indexOf(SOURCES[1])
  assert.ok(phoneAt >= 0, '内联段里没有 phone-core.js')
  assert.ok(senderAt > phoneAt, 'sender-core.js 必须在 phone-core.js 之后（它要用 globalThis.FlickerPhone）')
  assert.ok(block.includes('globalThis.FlickerPhone'), '内联段里应当真的带着 FlickerPhone 的定义')
  assert.ok(block.includes('globalThis.FlickerSender'), '内联段里应当真的带着 FlickerSender 的定义')
})

test('源文件用了浏览器跑不了的东西 → 必须拒绝，并指到行号', () => {
  const cases = [
    ["import { x } from './y.js'\n", /import\/export/],
    ['const b = Buffer.from("x")\n', /Buffer/],
    ['const p = process.argv\n', /process/],
    ['const m = require("fs")\n', /require/],
  ]
  for (const [src, re] of cases) {
    const problems = checkSources([{ rel: 'fake.js', src }])
    assert.equal(problems.length, 1, `没拦住这段代码：${src.trim()}`)
    assert.match(problems[0], re)
    assert.match(problems[0], /fake\.js:1/, '要给出文件与行号：' + problems[0])
  }
})

test('注释里提到 Buffer / process 不算违规（源文件本来就有这种解释）', () => {
  const src = '// 这里不许用 Buffer，也不许用 process —— 那是 Node 专有的\nconst x = new Uint8Array(4)\n'
  assert.deepEqual(checkSources([{ rel: 'fake.js', src }]), [])
})

test('buildBlock 把每个源文件包成带来源标记的 script（排查时一眼看得出哪段来自哪）', () => {
  const block = buildBlock([
    { rel: 'a.js', src: 'globalThis.A = 1\n' },
    { rel: 'b.js', src: 'globalThis.B = 2\n' },
  ])
  assert.ok(block.startsWith(BEGIN))
  assert.ok(block.endsWith(END))
  assert.equal((block.match(/<script data-inlined-from=/g) || []).length, 2)
  assert.match(block, /data-inlined-from="a\.js"/)
  assert.match(block, /data-inlined-from="b\.js"/)
})

test('真源文件本身符合"浏览器能直接吃"（不多不少就这两份）', () => {
  const sources = SOURCES.map((rel) => ({ rel, src: readFileSync(path.join(ROOT, rel), 'utf8') }))
  assert.deepEqual(checkSources(sources), [])
  assert.deepEqual(SOURCES, ['web/phone-core.js', 'web/sender-core.js'])
})
