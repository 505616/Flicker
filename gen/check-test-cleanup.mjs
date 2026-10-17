/**
 * 检查测试的收尾钩子有没有用 `.catch` 去接清理函数。
 *
 * 为什么需要（2026-10，代价换来的）：
 *   收尾循环原本写成
 *       after(async () => { for (const fn of cleanups.reverse()) await fn().catch(() => {}) })
 *   它只能接住"清理函数返回的 Promise 被 reject"这一种情况。而清理函数常常是
 *       cleanups.push(() => { try { child.kill() } catch {} })
 *   这种**同步箭头函数** —— 它返回 `undefined`，于是 `fn().catch` 当场抛
 *       TypeError: Cannot read properties of undefined (reading 'catch')
 *   后果不是"少一次清理"，而是**后面的清理一个都不跑**：HTTP 服务不关、
 *   子进程攥着 stdout 管道不放，于是 node 测试进程**永远不退出** ——
 *   表象是"三条用例全绿，进程却挂着不走"，定位成本极高（实测一次花了十几分钟）。
 *   同步抛错的情况更早就在 gui.test.js 里记过同一条教训，但只改了那一个文件。
 *
 * 正确写法（照抄 gui.test.js）：
 *       for (const fn of cleanups.reverse()) {
 *         try { await fn() } catch (e) { console.error('清理失败：' + (e?.message ?? e)) }
 *       }
 *   `try { await fn() }` 同时覆盖"同步抛错"和"返回 undefined"两种情况，
 *   而且一处失败不会连累后面的清理；失败只记一笔，绝不吃掉测试结果。
 *
 * 用法：
 *   node gen/check-test-cleanup.mjs              # 检查 test/
 *   node gen/check-test-cleanup.mjs <目录>       # 检查指定目录（反向验证用）
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TEST_DIR = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, 'test')

/** 两条判据：单行写法与多行写法各一条 */
const RULES = [
  {
    name: '收尾循环里用 .catch 接清理函数',
    test: (line) => line.includes('cleanups.reverse()') && line.includes('.catch('),
  },
  {
    name: '用 .catch 接清理函数的返回值',
    test: (line) => /\bfn\(\)\s*\.catch\(/.test(line),
  },
]

const files = readdirSync(TEST_DIR)
  .filter((n) => n.endsWith('.js'))
  .sort()

const bad = []
let scanned = 0
for (const name of files) {
  const rel = `test/${name}`
  const lines = readFileSync(path.join(TEST_DIR, name), 'utf8').split('\n')
  scanned++
  lines.forEach((line, i) => {
    // 注释里解释这条教训是允许的（文档价值），只看真正的代码行
    const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, '')
    for (const rule of RULES) {
      if (rule.test(code)) bad.push(`${rel}:${i + 1}  ${rule.name}\n      ${line.trim()}`)
    }
  })
}

console.log(`检查了 ${scanned} 个测试文件的收尾写法`)
if (bad.length) {
  console.error(`\n✗ ${bad.length} 处收尾写法会吞掉后续清理（测试进程可能永不退出）：\n`)
  for (const b of bad) console.error(`  ${b}`)
  console.error('\n改成：')
  console.error('  for (const fn of cleanups.reverse()) {')
  console.error("    try { await fn() } catch (e) { console.error('清理失败：' + (e?.message ?? e)) }")
  console.error('  }')
  console.error('\n原因见本脚本头部注释（2026-10 实测：用例全绿但进程挂着不走）。')
  process.exit(1)
}
console.log('✓ 收尾写法都能兜住"同步抛错"与"返回 undefined"')
