/**
 * "把仓库 clone 到别处，还能跑起来吗？"—— 首次推送前的那道体检
 * ==============================================================
 *
 * ── 为什么需要它 ──
 * 推上去之后 CI 干的第一件事是 `git clone`，然后**只拿仓库里的东西**跑
 * `npm run check` 与全量测试。于是有一类失败只会在云端出现：
 *
 *   · 某个文件被 `.gitignore` 挡掉了，但本地跑测试时它恰好在（生成物、资源…）；
 *   · 某个生成脚本的产物被当成"我本地有就行"没提交；
 *   · 行尾/编码在你的机器上没问题，检出到 Linux 就变了（`.cmd` 被转成 LF）。
 *
 * 这些在本地**永远是绿的**，因为本地有那份文件。所以判据只能是"换一个干净的副本再跑一次"。
 *
 * 它验的是**已提交的那份快照**（`git clone` 只拿提交内容），所以：
 *   · 有未提交的改动时它会提醒你（那些改动不在被验的快照里）；
 *   · 它不会碰你的工作区（clone 到系统临时目录，跑完删掉）。
 *
 * ⚠️ 刻意**不跑构建**：`gen/build-sea.mjs` 要走 `npx postject`，在干净副本里
 *    那意味着联网下载（CI 上没问题，这里不该偷偷联网）。构建与冒烟由 CI 负责，
 *    本地那两条在 `npm run build` / `npm run smoke` 里各自验过。
 *
 * 用法：
 *   node _lab/verify-fresh-clone.mjs              # 检查链 + 全量测试（约 3 分钟）
 *   node _lab/verify-fresh-clone.mjs --check-only # 只跑检查链（约 1 分钟）
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeTempDir, removeTempDir } from '../gen/tmp.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const checkOnly = process.argv.includes('--check-only')

/**
 * 跑一条命令并把输出接回来（失败时把尾巴打出来，别只给一个退出码）。
 *
 * ⚠️ 默认把 `FLICKER_NO_CERT_INSTALL=1` 传下去，**和 CI 保持一致**：
 *    CI 里这个变量是 job 级 env（见 `.github/workflows/ci.yml`）。不设它的话，
 *    「把证书装进系统信任库」那一步会在这里弹一个 **Windows 确认框**等人点，
 *    于是 `test/gui.test.js` 里"等服务就绪"那条用例卡满 40 秒后失败 ——
 *    而 CI 上永远不会发生（它设了变量）。2026-10 实测踩到：这道体检本该**预测 CI**，
 *    却因为环境不一致，报出了一个 CI 上不存在的失败。
 */
function run(cmd, args, cwd, { label, env } = {}) {
  const r = spawnSync(cmd, args, {
    cwd, encoding: 'utf8', env: { ...process.env, FLICKER_NO_CERT_INSTALL: '1', ...env },
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  return { status: r.status, out, label }
}

let bad = 0
const fail = (m) => { console.error(`✗ ${m}`); bad++ }

// ── 0. 工作区必须是干净的：否则验的不是"将来推上去的东西" ──
{
  const st = run('git', ['status', '--porcelain'], ROOT)
  if (st.status !== 0) fail(`git status 跑不起来：${st.out.trim()}`)
  else if (st.out.trim()) {
    console.log('⚠️  工作区有未提交的改动 —— 这次验的是**已提交的快照**，改动不在里面：')
    for (const line of st.out.trim().split('\n').slice(0, 10)) console.log(`      ${line}`)
  }
}

const branch = (run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], ROOT).out ?? '').trim() || 'HEAD'
const head = (run('git', ['rev-parse', '--short', 'HEAD'], ROOT).out ?? '').trim()
console.log(`\n从提交 ${head}（${branch}）clone 一份干净副本…`)

const dir = makeTempDir('flicker-fresh-clone-')
const clone = path.join(dir, 'repo')
try {
  const r = run('git', ['clone', '--quiet', '--no-hardlinks', ROOT, clone], ROOT)
  if (r.status !== 0) throw new Error(`git clone 失败：${r.out}`)

  // ── 1. 干净副本里**不该**有这些（它们靠 .gitignore 挡着） ──
  for (const mustNot of ['dist', 'node_modules', 'relay/api-token.txt', '.wrangler']) {
    if (existsSync(path.join(clone, mustNot))) fail(`干净副本里不该有 ${mustNot}（.gitignore 漏了？）`)
  }
  // 反过来：这些**必须**在仓库里（本地有、CI 没有 = 云端第一句就挂）
  for (const must of ['package.json', 'bin/flicker.js', 'gen/run-tests.mjs',
    'web/receiver.html', 'web/station.html', 'web/phone.html', 'relay/page.generated.js']) {
    if (!existsSync(path.join(clone, must))) fail(`干净副本里缺 ${must}（CI 上会直接失败）`)
  }

  // ── 2. 行尾：`.cmd` 必须是 CRLF、`.sh` 必须是 LF（跨平台检出的经典坑） ──
  {
    const r2 = run(process.execPath, ['gen/check-line-endings.mjs'], clone)
    if (r2.status !== 0) fail(`干净副本里的行尾/编码检查失败（CI 上会红）：\n${r2.out}`)
    else console.log('✓ 干净副本里的行尾与编码符合约定')
  }

  // ── 2b. 可执行位：`.sh` / `.command` 在 git 里必须记成 100755 ──
  //
  // ⚠️ 这一条本来在 `test/git-modes.test.js` 里，但那个用例在没有 git 的环境里会跳过
  //    （2026-10 实测：这台机器的 PowerShell PATH 里没有 git，只有 DSH 的 bash 里有）。
  //    本脚本本身就要用 git，所以在这里**再验一次** —— 这条判据不能只在 CI 上生效。
  {
    const r2b = run('git', ['-c', 'core.quotepath=false', 'ls-files', '-s', '--', '启动.sh', '启动.command'], clone)
    if (r2b.status !== 0) fail(`干净副本里列不出启动脚本的模式：${r2b.out}`)
    for (const line of r2b.out.split('\n').filter(Boolean)) {
      const mode = line.split(' ')[0]
      if (mode !== '100755') {
        fail(`干净副本里这个文件在 git 里是 ${mode}，必须是 100755：${line.split('\t')[1]}\n` +
          '      （Linux/macOS 的 clone 会得到"不能执行"的脚本：双击或 ./启动.sh 都 Permission denied）\n' +
          '      改法：git update-index --chmod=+x 启动.sh 启动.command')
      }
    }
    if (!bad) console.log('✓ 干净副本里：启动脚本的 git 模式是 100755（Linux/macOS 上能执行）')
  }

  // ── 3. 检查链（CI 里跑的是同一批：见 gen/check-ci-parity.mjs） ──
  {
    const r3 = run(process.execPath, ['gen/check-ci-parity.mjs'], clone)
    if (r3.status !== 0) fail(`干净副本里"检查链与 CI 一致"失败：\n${r3.out}`)
    else console.log('✓ 干净副本里：CI 与 npm run check 跑的是同一批判据')
  }
  {
    const pkg = JSON.parse((run(process.execPath, ['-e',
      "process.stdout.write(require('fs').readFileSync('package.json','utf8'))"], clone).out) || '{}')
    const cmds = String(pkg.scripts?.check ?? '').split('&&').map((s) => s.trim()).filter(Boolean)
    if (!cmds.length) fail('干净副本里读不到 scripts.check')
    for (const cmd of cmds) {
      const [bin, ...args] = cmd.split(/\s+/)
      const r4 = run(bin === 'node' ? process.execPath : bin, args, clone)
      if (r4.status !== 0) {
        fail(`干净副本里这条判据失败：${cmd}\n${r4.out.split('\n').slice(-12).join('\n')}`)
      }
    }
    if (!bad) console.log(`✓ 干净副本里 ${cmds.length} 条判据全过`)
  }

  // ── 4. 全量测试（CI 上跑的是同一份 gen/run-tests.mjs） ──
  if (checkOnly) {
    console.log('（--check-only：跳过全量测试）')
  } else {
    const r5 = run(process.execPath, ['gen/run-tests.mjs'], clone)
    const tail = r5.out.split('\n').filter((l) => /ℹ (tests|pass|fail|skipped)/.test(l))
    if (r5.status !== 0) fail(`干净副本里全量测试失败：\n${r5.out.split('\n').slice(-25).join('\n')}`)
    else console.log(`✓ 干净副本里全量测试通过：${tail.join(' / ')}`)
  }
} catch (e) {
  fail(`体检中途出错：${e?.message ?? e}`)
} finally {
  await removeTempDir(dir)
}

if (bad) {
  console.error(`\n${bad} 处问题 —— 现在推上去，CI 第一次跑就会红在这些地方。`)
  process.exit(1)
}
console.log('\n✓ 提交是自包含的：换一个干净副本（也就是 CI 看到的东西）检查链与测试都能过')
