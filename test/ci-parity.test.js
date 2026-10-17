/**
 * 判据：CI 与 `npm run check` 跑的是**同一批**命令
 * ================================================
 *
 * 这条用例守的是一个很具体的缺口（2026-10 补的）：
 *
 *   `npm run check` 是本地那道闸，`.github/workflows/ci.yml` 是云端那道闸，
 *   两边**各自手写一份命令清单**。往 package.json 里加一条判据却忘了同步 CI，
 *   它只在开发者自己的机器上生效 —— 而"CI 绿"会被人当成"全都验过了"。
 *   这正是这个项目反复吃亏的那类失败：**看起来验过了**。
 *
 * 判据分三层：
 *   ① 真实仓库通过（两边一致）
 *   ② ⭐ 能**证伪**：删一条 CI 步骤 / 改个命令名 / 本地多一条 CI 没有的 → 必须报错；
 *      只是多了空格或引号（格式噪音）→ 不该报错
 *   ③ 这条判据自己进了 `npm run check` 与 CI（否则它也只在你机器上跑）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CHECK = path.join(ROOT, 'gen', 'check-ci-parity.mjs')
const CI = path.join(ROOT, '.github', 'workflows', 'ci.yml')

const runCheck = () => spawnSync(process.execPath, [CHECK], { cwd: ROOT, encoding: 'utf8' })

test('真实的仓库里：CI 与 npm run check 跑的是同一批判据', () => {
  const r = runCheck()
  assert.equal(r.status, 0, `检查应当通过：\n${r.stdout}${r.stderr}`)
  assert.match(r.stdout, /同一批判据/)
})

test('⭐ 反向验证：CI 漏掉一条本地判据 → 检查如实报错（并说出该加什么）', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, '_lab', 'verify-ci-parity-check.mjs')], {
    cwd: ROOT, encoding: 'utf8',
  })
  assert.equal(r.status, 0, `反向验证脚本本身应当通过：\n${r.stdout}${r.stderr}`)
  assert.match(r.stdout, /删掉一条检查步骤.*如实报错/)
  assert.match(r.stdout, /改了名.*如实报错/)
  assert.match(r.stdout, /多了一条 CI 没有的判据.*如实报错/)
  assert.match(r.stdout, /格式噪音.*正确地没有报错/)
})

test('这条判据自己也在 npm run check 与 CI 里（否则它也只在你机器上跑）', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.match(pkg.scripts.check, /check-ci-parity\.mjs/, 'npm run check 里要跑它')
  const ci = readFileSync(CI, 'utf8')
  assert.match(ci, /check-ci-parity\.mjs/, 'CI 里也要跑它')
})

test('反向验证脚本在仓库里（证明这条判据真的会失败）', () => {
  assert.ok(existsSync(path.join(ROOT, '_lab', 'verify-ci-parity-check.mjs')),
    '_lab/verify-ci-parity-check.mjs 必须在——否则"它会失败"只是嘴上说说')
})
