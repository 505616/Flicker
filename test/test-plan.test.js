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
 * 所以这里钉住三件事：
 *   ① 现在**没有**任何文件被整个平台挡住（有的话必须能拿出 Windows 专属证据）；
 *   ② 复核逻辑本身是有效的 —— 塞一条假的进去必须被抓出来
 *      （一个"永远通过"的检查等于没有检查）；
 *   ③ 那些"只在 Windows 上能做的用例"是**文件内部**自gate的
 *      （`{ skipStore }`），而不是整个文件被跳过 —— 这样文件里其余用例
 *      在三平台上都真的会跑。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
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
  // 空清单是**结论**，不是偷懒：证书生成已经纯 JS 化，
  // 而碰系统证书库的用例是在 test/trust.test.js 内部用 { skipStore } 自gate的，
  // 不需要把整个文件挡在平台之外。
  assert.deepEqual(auditWindowsOnly(), [])
  const p = plan('win32')
  assert.equal(p.files.length, p.all.length, 'Windows 上当然要跑全部文件')
})

test('只在 Windows 上能做的用例是文件内自gate的，不是整个文件被跳过', () => {
  const src = readFileSync(path.join(ROOT, 'test/trust.test.js'), 'utf8')
  assert.match(src, /const skipStore = isWindows \? false/,
    'test/trust.test.js 应当用一个明确的 skipStore 变量标注"这些用例要碰系统证书库"')
  const gated = src.match(/\{ skipStore \}/g) ?? []
  assert.ok(gated.length >= 3,
    `应当至少有 3 个用例（装入/残留清理/只认自己的证书）挂在这个门上，实际 ${gated.length} 个`)

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
