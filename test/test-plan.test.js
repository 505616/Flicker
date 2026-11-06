/**
 * 「平台专属测试清单」本身必须是有效的
 * ====================================
 *
 * `gen/test-plan.mjs` 决定**哪些测试文件在 macOS / Linux 上被整个跳过**。
 * 这个清单一旦过时，后果很隐蔽：那些用例在别的平台上**永远不会被执行**，
 * 而 CI 依然是绿的 —— 看起来一切正常，实际覆盖率静悄悄掉了一半。
 *
 * 真实发生过一次：证书生成从 PowerShell 改成纯 JS 之后，
 * 清单里仍然挡着 4 个文件，而它们其实早就能跨平台跑了。
 *
 * 所以这里钉住四件事：
 *   ① 现在**没有**任何文件被整个平台挡住（有的话必须能拿出 Windows 专属证据）；
 *   ② 复核逻辑本身是有效的 —— 塞一条假的进去必须被抓出来
 *      （一个"永远通过"的检查等于没有检查）；
 *   ③ 过滤逻辑本身是有效的 —— 塞一份**非空**清单进去，被列出的文件必须真的消失；
 *   ④ **只有一份清单**：`gen/run-tests.mjs`（真正跑的入口）直接 import `plan()`，
 *      不能自己再藏一份（从前正是"两份真相"：入口跳过 4 个文件、审计的是空表）。
 *      这条用两项验证：读源码断言"没有第二份硬编码"，以及真跑一次 `--dry`
 *      把入口打印的文件数与本文件的 `plan()` 对齐。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { plan, auditWindowsOnly, auditEntries } from '../gen/test-plan.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('⭐ macOS / Linux 上没有"整个文件被跳过"的测试', () => {
  for (const platform of ['linux', 'darwin']) {
    const p = plan(platform)
    assert.deepEqual(p.skipped, [],
      `${platform} 上跳过了 ${p.skipped.length} 个文件（${p.skipped.join(', ')}）。\n` +
      '    如果它们真的需要 Windows，请把证据写进 WINDOWS_ONLY 并让 --check 通过；\n' +
      '    否则请把它们放回来跑 —— 被静默跳过的用例等于不存在。')
    assert.equal(p.files.length, p.all.length)
  }
})

test('⭐ 平台专属清单复核逻辑是有效的（塞假条目必须被抓出来）', () => {
  // 用一个**没有任何 Windows 痕迹**的文件当反例。
  // 若复核逻辑失效（比如忘了读源码、或正则写错），这条会失败。
  const problems = auditEntries([
    ['test/suite.test.js', '（故意编的理由：这个文件其实哪儿都能跑）'],
  ])
  assert.equal(problems.length, 1,
    '复核逻辑必须能识别出"声称需要 Windows、实则不需要"的条目 —— ' +
    '否则它只是个永远通过的装饰')
  assert.match(problems[0], /suite\.test\.js/)
  assert.match(problems[0], /WINDOWS_ONLY/, '报错要告诉人怎么修')

  // 正向对照：文件根本不存在时也要报，而不是默默通过
  const missing = auditEntries([['test/不存在的文件.test.js', 'n/a']])
  assert.equal(missing.length, 1)
  assert.match(missing[0], /读不到|改名/)
})

test('真实的平台专属清单当前是空的且复核通过', () => {
  // 空清单是**结论**，不是偷懒：e2e/startup-order 源码里没有任何 Windows 痕迹；
  // 碰系统证书库的用例是在 test/trust.test.js 内部用 { skip: skipStore } 自 gate 的；
  // gui.test.js 的平台分支也在用例内部。逐条理由见 gen/test-plan.mjs 的注释。
  assert.deepEqual(auditWindowsOnly(), [])
  const p = plan('win32')
  assert.equal(p.files.length, p.all.length, 'Windows 上当然要跑全部文件')
})

test('⭐ 过滤逻辑不是装饰：塞一份非空的假清单，被列出的文件必须真的消失', () => {
  const fake = new Map([['test/suite.test.js', '（假理由，仅用于验证过滤逻辑）']])
  const p = plan('linux', fake)
  assert.ok(p.skipped.includes('test/suite.test.js'),
    'plan() 必须真的把假清单里的文件过滤掉 —— 空清单时这只是行永远不会执行的代码')
  assert.ok(!p.files.includes('test/suite.test.js'))
  assert.equal(p.files.length, p.all.length - 1)
  // Windows 上不受影响：清单只表示"其它平台不能跑"
  const w = plan('win32', fake)
  assert.equal(w.files.length, w.all.length)
})

test('⭐ 只有一份清单：gen/run-tests.mjs 不得再硬编码平台跳过名单', () => {
  const src = readFileSync(path.join(ROOT, 'gen/run-tests.mjs'), 'utf8')
  assert.match(src, /from '\.\/test-plan\.mjs'/,
    'run-tests.mjs 必须从 test-plan.mjs 取平台清单（单一真相）')
  assert.match(src, /plan\(\)/, 'run-tests.mjs 必须调用 plan()')
  // 从前那 4 个名字是第二份真相的证据；只要入口里还出现任何一个，就说明清单又分叉了
  for (const name of ['e2e.test.js', 'startup-order.test.js', 'gui.test.js', 'trust.test.js']) {
    assert.ok(!src.includes(name),
      `run-tests.mjs 里出现了测试文件名 ${name} —— 平台清单只能有一份（test-plan.mjs）`)
  }
  assert.ok(!/readdirSync/.test(src),
    'run-tests.mjs 不该自己扫描 test/ 目录重建文件列表 —— 那会绕开 plan() 的过滤')
})

test('⭐ 入口（run-tests）与清单（test-plan）实际选中的文件数一致', () => {
  // 真跑一次入口的 --dry：它打印"平台 X：N/M 个测试文件"后直接退出，不跑任何用例。
  // 这条是"两份真相"的端到端反向验证 —— 若入口再引入一份清单，N 立刻对不上。
  const r = spawnSync(process.execPath,
    ['gen/run-tests.mjs', '--dry', '--no-sweep'],
    { cwd: ROOT, encoding: 'utf8', timeout: 60_000 })
  assert.equal(r.status, 0, `--dry 应当正常退出：\n${r.stderr || r.stdout}`)
  const m = (r.stdout || '').match(/^平台 (\S+)：(\d+)\/(\d+) 个测试文件/m)
  assert.ok(m, `没找到入口打印的"平台 X：N/M 个测试文件"这一行：\n${(r.stdout || '').slice(0, 500)}`)
  const [, platform, n, total] = m
  const p = plan()
  assert.equal(platform, p.platform)
  assert.equal(Number(n), p.files.length,
    '入口选中的文件数必须等于 plan() 的结果 —— 不等就说明清单分叉了')
  assert.equal(Number(total), p.all.length)
})

test('只在 Windows 上能做的用例是文件内自gate的，不是整个文件被跳过', () => {
  const src = readFileSync(path.join(ROOT, 'test/trust.test.js'), 'utf8')
  // 2026-10：这个门多了第二种理由（`FLICKER_NO_CERT_INSTALL=1`，CI 上没人点
  // "安装根证书"的系统确认框），所以断言只看"有 skipStore 这个门"，不钉死它的取值写法。
  assert.match(src, /const skipStore = /,
    'test/trust.test.js 应当用一个明确的 skipStore 变量标注"这些用例要碰系统证书库"')
  const gated = src.match(/\{ skip: skipStore \}/g) ?? []
  assert.ok(gated.length >= 3,
    `应当至少有 3 个用例（装入/残留清理/只认自己的证书）挂在 skip: skipStore 上，实际 ${gated.length} 个`)
  // 顺带钉住一个真犯过的错：写成 `{ skipStore }` 时 Node **不认识**这个键，
  // 于是"跳过"根本没发生（2026-10 实测：传了环境变量仍然跑了 21 条）。
  assert.doesNotMatch(src, /\{ skipStore \}/,
    'Node 的测试选项是 `skip`，`{ skipStore }` 不会跳过任何东西')

  // 反过来：只依赖"生成一张证书"的用例**不该**被门挡住。
  // 证书生成是纯 JS、全平台同一份代码，挡住它们就是在白丢覆盖率。
  const ungated = ['自检通过：正确生成的证书应当无异议', 'keyUsageOf 能解析出 CA 的 keyCertSign']
  for (const name of ungated) {
    const idx = src.indexOf(`test('${name}`)
    assert.ok(idx >= 0, `找不到用例: ${name}`)
    const line = src.slice(idx, src.indexOf('\n', idx))
    assert.ok(!line.includes('skip'),
      `「${name}」只依赖证书生成，不该被跳过：${line}`)
  }
})
