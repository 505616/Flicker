/**
 * 收尾钩子的机器判据（`gen/check-test-cleanup.mjs`）
 * =================================================
 * 这条判据是为一次真实代价加的。测试的收尾循环原本写成
 *
 *     after(async () => { for (const fn of cleanups.reverse()) await fn().catch(() => {}) })
 *
 * 它只能接住"清理函数返回的 Promise 被 reject"这一种情况；而清理函数常常是
 * 同步箭头函数（返回 `undefined`），于是 `fn().catch` 当场抛 TypeError，
 * **后面的清理一个都不跑** —— HTTP 服务不关、子进程攥着 stdout 管道，
 * node 测试进程永远不退出。表象只是"卡住"，实测定位花了十几分钟。
 *
 * 判据必须能被证伪，所以这里两个方向都验：
 *   ① 真实的 `test/` 目录必须通过
 *   ② 故意写坏（把旧写法放进临时目录）必须**失败**，而且要指出行号
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CHECK = path.join(root, 'gen', 'check-test-cleanup.mjs')
const FIXTURE = path.join(root, '_lab', 'fixtures', 'cleanup-antipattern.txt')

/** 跑判据脚本（不传目录就检查真实的 test/） */
function runCheck(dir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, dir ? [CHECK, dir] : [CHECK],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    child.stdout.on('data', (b) => { out += b })
    child.stderr.on('data', (b) => { out += b })
    child.on('exit', (code) => resolve({ code, out }))
  })
}

test('收尾写法判据：真实的 test/ 目录必须通过', { timeout: 60000 }, async () => {
  const r = await runCheck()
  assert.equal(r.code, 0, `判据应通过，实际退出码 ${r.code}：\n${r.out}`)
  assert.match(r.out, /收尾写法都能兜住/, '通过时也要有一句明确的结论')
})

test('⭐ 收尾写法判据能被证伪：同一份坏写法必须让它失败并指出行号', { timeout: 60000 }, async () => {
  // 坏样本放在 `_lab/fixtures/cleanup-antipattern.txt` 里，**不是**内联字符串：
  //   · 判据扫的是 test/ 下的 .js —— 内联在这里的话，这个测试文件自己就会被判据扫到
  //     （判据是逐行文本匹配，它分不清"真代码"和"字符串字面量里的样本"）；
  //   · 夹具用 .txt 后缀，免得被任何"发现测试"的机制当用例跑。
  const badSource = await readFile(FIXTURE, 'utf8')
  const loopLine = badSource.split('\n').findIndex((l) => l.includes('cleanups.reverse()')) + 1
  assert.ok(loopLine > 0, '夹具里应当找得到那段坏写法')

  const dir = await mkdtemp(path.join(tmpdir(), 'flicker-cleanup-check-'))
  try {
    await writeFile(path.join(dir, 'bad.test.js'), badSource)

    const r = await runCheck(dir)
    assert.equal(r.code, 1, `坏写法必须让判据失败，实际退出码 ${r.code}：\n${r.out}`)
    assert.match(r.out, new RegExp(`bad\\.test\\.js:${loopLine}`),
      `要点出文件与行号（第 ${loopLine} 行）：\n${r.out}`)
    assert.match(r.out, /清理/, '要说清问题出在"清理"上，而不是丢一句泛泛的失败')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
