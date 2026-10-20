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
 * 判据逻辑抽成 `auditCleanupText(src, file)`（纯函数：喂源码文本、回问题清单），
 * CLI 只负责扫盘与打印 —— `test/test-cleanup.test.js` 用它反过来验
 * （坏写法要抓到、正确写法与注释里的反面教材不许误报）。
 *
 * 用法：
 *   node gen/check-test-cleanup.mjs              # 检查 test/
 *   node gen/check-test-cleanup.mjs <目录>       # 检查指定目录
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 两条判据：单行写法与多行写法各一条 */
export const RULES = [
  {
    name: '收尾循环里用 .catch 接清理函数',
    test: (line) => line.includes('cleanups.reverse()') && line.includes('.catch('),
  },
  {
    name: '用 .catch 接清理函数的返回值',
    test: (line) => /\bfn\(\)\s*\.catch\(/.test(line),
  },
]

/**
 * 核一个文件的收尾写法。
 * @param {string} src 源码文本
 * @param {string} file 显示用的文件名
 * @returns {Array<{file:string, line:number, rule:string, text:string}>}
 */
export function auditCleanupText(src, file = '(inline)') {
  const problems = []
  src.split('\n').forEach((line, i) => {
    // 注释里解释这条教训是允许的（文档价值），只看真正的代码行
    const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, '')
    for (const rule of RULES) {
      if (rule.test(code)) problems.push({ file, line: i + 1, rule: rule.name, text: line.trim() })
    }
  })
  return problems
}

/**
 * 扫一个目录。
 * @param {string} dir 目录（默认仓库的 test/）
 */
export function TEST_DIR_OF(root, dir) {
  const target = dir ?? path.join(root, 'test')
  const files = readdirSync(target).filter((n) => n.endsWith('.js')).sort()
  const problems = []
  let scanned = 0
  for (const name of files) {
    scanned++
    problems.push(...auditCleanupText(readFileSync(path.join(target, name), 'utf8'), `test/${name}`))
  }
  return { problems, scanned, dir: target }
}

// ── CLI ──────────────────────────────────────────────────────

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  const arg = process.argv[2]
  // ⚠️ 这里曾经写错成 `TEST_DIR_OF(path.dirname(arg), path.basename(arg))` —— 于是它去
  //    `<临时目录>/test` 里找文件，报 ENOENT（`test/test-cleanup-check.test.js` 当场变红）。
  //    目录参数要**整体**传进去，不要再拆成 root + 名字。
  const { problems, scanned } = arg
    ? TEST_DIR_OF(ROOT, path.resolve(arg))
    : TEST_DIR_OF(ROOT)
  console.log(`检查了 ${scanned} 个测试文件的收尾写法`)
  if (problems.length) {
    console.error(`\n✗ ${problems.length} 处收尾写法会吞掉后续清理（测试进程可能永不退出）：\n`)
    for (const b of problems) console.error(`  ${b.file}:${b.line}  ${b.rule}\n      ${b.text}`)
    console.error('\n改成：')
    console.error('  for (const fn of cleanups.reverse()) {')
    console.error("    try { await fn() } catch (e) { console.error('清理失败：' + (e?.message ?? e)) }")
    console.error('  }')
    console.error('\n原因见本脚本头部注释（2026-10 实测：用例全绿但进程挂着不走）。')
    process.exit(1)
  }
  console.log('✓ 收尾写法都能兜住"同步抛错"与"返回 undefined"')
}
