/**
 * 仓库里的**可执行位**与**行尾约定**（git 层面的两件事）
 * ====================================================
 *
 * 这两样都属于"本地全绿、换一台机器 / 换一个平台才炸"的类别 —— 而且都是
 * 在 **git 里**决定的，跑代码的测试看不见它们：
 *
 *   ① **可执行位**：`启动.sh` / `启动.command` 在 Linux / macOS 上是要**执行**的
 *      （文档就是这么教用户的："双击 `启动.command`"、`./启动.sh`）。
 *      Windows 上没有可执行位这个概念，`git add` 会把它们记成 100644 ——
 *      于是 Linux 用户 clone 下来只会得到 `Permission denied`，
 *      而作者在 Windows 上**永远不会看到**这个报错。
 *      2026-10 首次提交时就正是 100644，是这条用例把它抓出来的。
 *   ② **行尾**：`.cmd` 必须 CRLF（`cmd.exe` 的 `for /f` 遇到 LF 会静默失效，
 *      症状是"明明装了 Node 却让你去下载 Node"）、`.sh` 必须 LF（CRLF 会让 shebang
 *      变成 `/bin/sh^M`）。规则必须写进 `.gitattributes`，否则结果取决于每台机器
 *      的 `core.autocrlf` —— 而 Git for Windows 的默认值恰恰会把 `.sh` 转成 CRLF。
 *      （行尾本身由 `gen/check-line-endings.mjs` 守；这里守的是"git 里也这么写"。）
 *
 * ⚠️ 没有 git 时**跳过**而不是失败：这是仓库元数据的判据，不是产品行为的判据；
 *    在没有 git 的机器上跑不了它并不说明代码有问题。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/**
 * 找 git：先看 PATH，再看几个标准安装位置。
 *
 * ⚠️ 为什么不能只用 PATH：2026-10 实测这台机器上 `git` 只在 **DSH 的 bash 环境**里
 * （`/ucrt64/bin/git`）可用，PowerShell 的 PATH 里**没有** —— 于是"默认跑法"
 * （`npm test`，走 pwsh）会把这三条判据静默跳过，而它们是唯一能发现
 * "启动脚本在 git 里不可执行"的东西。Git for Windows 的安装位置是固定的几个，
 * 直接去那儿看一眼，用户装了就能生效。
 *
 * @returns {string|null} 可用的 git 可执行文件路径（找不到就是 null）
 */
function findGit() {
  const candidates = [process.env.FLICKER_GIT, 'git',
    'C:/Program Files/Git/cmd/git.exe', 'C:/Program Files (x86)/Git/cmd/git.exe',
    '/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git']
  for (const candidate of candidates) {
    if (!candidate) continue
    if (candidate !== 'git' && !existsSync(candidate)) continue
    const r = spawnSync(candidate, ['--version'], { cwd: ROOT, encoding: 'utf8' })
    if (!r.error && r.status === 0) return candidate
  }
  return null
}

const GIT = findGit()

/** git 能用吗（不能用就跳过，见文件头） */
function gitReady() {
  if (!GIT) return false
  return existsSync(path.join(ROOT, '.git'))
}

/** `git ls-files -s` → { path: mode } */
function indexModes() {
  // ⚠️ `-c core.quotepath=false`：默认会把非 ASCII 路径转义成 `"\345\220\257..."`，
  //    于是"启动.sh"永远匹配不上 —— 判据会以"文件不存在"的样子失败，离原因很远。
  const r = spawnSync(GIT, ['-c', 'core.quotepath=false', 'ls-files', '-s'],
    { cwd: ROOT, encoding: 'utf8' })
  assert.equal(r.status, 0, `git ls-files 失败：${r.stderr}`)
  const out = new Map()
  for (const line of r.stdout.split('\n')) {
    // 形状：`100755 <sha> 0\t<path>`
    const m = line.match(/^(\d{6}) [0-9a-f]{40} \d+\t(.+)$/)
    if (m) out.set(m[2], m[1])
  }
  return out
}

/** 路径在 `git ls-files` 输出里可能被转义（中文名），用 `-z` 版本查一次 */
function modeOf(file) {
  const r = spawnSync(GIT, ['ls-files', '-s', '-z', '--', file], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(r.status, 0, `git ls-files 失败：${r.stderr}`)
  const rec = (r.stdout ?? '').split('\0').find(Boolean)
  assert.ok(rec, `git 里没有 ${file}`)
  return rec.split(' ')[0]
}

test('启动脚本在 git 里必须是可执行的（否则 Linux / macOS 上双击或 ./启动.sh 都跑不起来）',
  (t) => {
    if (!gitReady()) return t.skip('这台机器上没有可用的 git（PATH 与常见安装位置都没找到），跳过仓库元数据判据')
    for (const file of ['启动.sh', '启动.command']) {
      assert.equal(modeOf(file), '100755',
        `${file} 在 git 里是 100644 —— Linux/macOS 的 clone 拿到的是"不能执行"的脚本。` +
        `改法：git update-index --chmod=+x ${file}`)
    }
  })

test('反过来：普通文件不该乱带可执行位（判据不是"全都 755"）', (t) => {
  if (!gitReady()) return t.skip('这台机器上没有可用的 git（PATH 与常见安装位置都没找到），跳过仓库元数据判据')
  for (const file of ['读我.md', 'package.json', 'src/recv.js']) {
    assert.equal(modeOf(file), '100644', `${file} 不该是可执行的`)
  }
})

test('`.gitattributes` 把行尾规则钉进仓库（不靠各机器的 core.autocrlf）', () => {
  const p = path.join(ROOT, '.gitattributes')
  assert.ok(existsSync(p), '.gitattributes 必须在 —— 否则 .sh 会被 Windows 的 autocrlf 转成 CRLF')
  const src = readFileSync(p, 'utf8')
  assert.match(src, /^\*\.cmd\s+text\s+eol=crlf$/m, '`*.cmd` 必须 CRLF（cmd.exe 的要求）')
  assert.match(src, /^\*\.bat\s+text\s+eol=crlf$/m, '`*.bat` 必须 CRLF')
  assert.match(src, /^\*\.sh\s+text\s+eol=lf$/m, '`*.sh` 必须 LF（CRLF 会让 shebang 坏掉）')
  assert.match(src, /^\*\.command\s+text\s+eol=lf$/m, '`*.command` 必须 LF')
})

test('索引里的模式与工作区文件对得上（不是只改了一个不存在的条目）', (t) => {
  if (!gitReady()) return t.skip('这台机器上没有可用的 git（PATH 与常见安装位置都没找到），跳过仓库元数据判据')
  const modes = indexModes()
  assert.ok(modes.size > 200, `git 里应当有 200 个以上文件，实际 ${modes.size}`)
  // 已知必须可执行的只有两个启动脚本；其他一律 644（新加的可执行文件先想清楚再放行）
  const exec = [...modes.entries()].filter(([, m]) => m === '100755').map(([f]) => f)
  assert.deepEqual(exec.sort(), ['启动.command', '启动.sh'],
    `可执行文件只该有两个启动脚本，实际：${JSON.stringify(exec)}`)
})
