/**
 * 临时目录前缀判据（`gen/check-temp-dirs.mjs`）自己的判据
 * ===================================================
 * 这条判据是 2026-10 用户 `%TEMP%` 里 2.8 GB / 6717 个文件的直接教训：
 * 我们建的临时目录名字五花八门，清理脚本不敢删它不认识的目录，于是一直躺着。
 *
 * 反向验证：没登记的前缀必须报、`flicker-` 开头必须放行、
 * 几种常见写法（`fs.mkdtempSync` / `os.tmpdir()` / 双引号 / 反引号）都要抓得到。
 *
 * ⚠️ 构造"坏样例"时同样**刻意拼**（`TD` / `CALL`）：判据扫的是源码文本，
 *    直接写会把它自己这条用例当成未登记的临时目录（写这轮反向用例时实测到过）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { unregisteredPrefixes, auditTempDirs } from '../gen/check-temp-dirs.mjs'
import { PREFIXES } from '../gen/tmp.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** 运行时拼出 `tmpdir()`，文件里不出现这个连写（判据扫的是文本） */
const TD = 'tmp' + 'dir()'
/** 拼一行 `mkdtemp(...)` 调用文本 */
const CALL = (prefix, head = `mkdtemp(path.join(${TD}, `) => `${head}${JSON.stringify(prefix)}))`

test('登记表里一定有 flicker-（清理脚本按它认领我们自己的目录）', () => {
  assert.ok(PREFIXES.includes('flicker-'), 'PREFIXES 里应当有 flicker-，实际：' + PREFIXES.join(', '))
  assert.deepEqual(unregisteredPrefixes(CALL('flicker-smoke-')), [])
})

test('没登记的前缀 → 必须报出来（附带位置）', () => {
  const src = `const d = ${CALL('evil-tmp-', `mkdtempSync(path.join(${TD}, `)}`
  const bad = unregisteredPrefixes(src)
  assert.equal(bad.length, 1)
  assert.equal(bad[0].prefix, 'evil-tmp-')
  assert.equal(bad[0].index, src.indexOf('mkdtempSync'))
})

test('四种常见写法都要抓得到（否则判据只守住了自己想到的那一种）', () => {
  const cases = [
    CALL('a-'),
    CALL('b-', `fs.mkdtempSync(path.join(os.${TD}, `),
    CALL('c-', `mkdtempSync(join(${TD}, `),
    CALL('d-', `fs.mkdtempSync(path.join(os.${TD}, `),
  ]
  for (const c of cases) {
    assert.equal(unregisteredPrefixes(c).length, 1, `没抓到这种写法：${c}`)
  }
})

test('动态拼出来的名字这里看不到（已知边界，写清楚免得被当成保证）', () => {
  // 这是**明确的能力边界**：`'flicker-' + name` 这种拼法抓不到，靠 code review。
  assert.deepEqual(unregisteredPrefixes(CALL('flicker-') + ' + name)'), [])
  assert.deepEqual(unregisteredPrefixes(`mkdtemp(path.join(${TD}, name))`), [])
})

test('真仓库：所有 mkdtemp 前缀都登记在册，且确实扫到了调用', () => {
  const { problems, seen } = auditTempDirs(ROOT)
  assert.deepEqual(problems, [], '真仓库里不该有未登记前缀：\n' +
    problems.map((p) => `${p.rel}:${p.line} '${p.prefix}'`).join('\n'))
  assert.ok(seen >= 20, `至少要扫到 20 处 mkdtemp 调用（实际 ${seen}）—— 一个都没扫到说明目录走错了`)
})

test('扫一棵树：未登记的文件要被点名（含相对路径与行号）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'flicker-tempdirs-'))
  try {
    mkdirSync(path.join(dir, 'gen'))
    mkdirSync(path.join(dir, 'test'))
    writeFileSync(path.join(dir, 'test', 'a.test.js'),
      `// 上面一行是注释\nconst d = ${CALL('nope-')}\n`, 'utf8')
    writeFileSync(path.join(dir, 'gen', 'ok.mjs'),
      `const d = ${CALL('flicker-ok-')}\n`, 'utf8')
    const { problems, seen } = auditTempDirs(dir)
    assert.equal(seen, 2)
    assert.deepEqual(problems.map((p) => `${p.rel}:${p.line}`), ['test/a.test.js:2'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
