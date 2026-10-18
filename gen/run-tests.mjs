/**
 * 跨平台的测试入口：按平台挑选文件，再调用 `node --test`。
 *
 * 为什么需要一个脚本，而不是在 package.json 里写
 *   `node --test ... $(node gen/test-plan.mjs --glob)`
 * 因为 **npm 在 Windows 上用的是 cmd.exe**，它不支持 `$(...)` 命令替换 ——
 * 那种写法在 Linux/macOS 上能跑、在 Windows 上直接把字面量当参数传进去。
 * 这类"只在某个平台坏"的写法最容易漏，所以统一收进这个脚本：
 * 它在任何平台都用同样的方式工作，而且能自己打印实际跑的哪个文件列表。
 *
 * 用法：
 *   node gen/run-tests.mjs            # 本平台适用的全部测试
 *   node gen/run-tests.mjs --all      # 强制跑全部（含平台专属的，非 Windows 上会失败）
 *   node gen/run-tests.mjs --fast     # 只跑纯逻辑测试（秒级，不需证书）
 *   node gen/run-tests.mjs --dry      # 只打印将要执行的命令，不真跑
 *
 * 额外参数会原样透传给 `node --test`。
 */
import { spawn } from 'node:child_process'
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)

const isWindows = process.platform === 'win32'

/** 只在 Windows 上能跑的文件（证书机制仅 Windows 有实现，见 src/trust.js） */
const WINDOWS_ONLY = new Set([
  'trust.test.js', 'e2e.test.js', 'gui.test.js', 'startup-order.test.js',
])

/** 纯逻辑测试：不进程、不证书，任何平台都能跑，秒级 */
const FAST = new Set([
  'suite.test.js', 'manifest.test.js', 'bundler.test.js', 'receiver-page.test.js',
  'relay-room.test.js', 'relay-protocol.test.js', 'relay-retry.test.js',
  'rate.test.js', 'password.test.js', 'session-auth.test.js', 'release.test.js',
  'i18n.test.js', 'pwa.test.js', 'session-cert.test.js', 'asset-digests.test.js',
  'docs-pairing.test.js', 'manifest-doc.test.js', 'changelog.test.js',
  'receiver-prefetch.test.js', 'chunk-size.test.js', 'receiver-hash-worker.test.js',
  'handshake-downgrade.test.js', 'line-endings.test.js', 'doc-numbers.test.js', 'doc-paths.test.js',
])

const all = readdirSync(path.join(ROOT, 'test'))
  .filter((f) => f.endsWith('.test.js')).sort()

let files
if (argv.includes('--all')) files = all
else if (argv.includes('--fast')) files = all.filter((f) => FAST.has(f))
else files = isWindows ? all : all.filter((f) => !WINDOWS_ONLY.has(f))

const passThrough = argv.filter((a) => !['--all', '--fast', '--dry'].includes(a))

/**
 * 每个用例的超时（默认 3 分钟）。
 *
 * 为什么要有：2026-10 的 CI 第一次跑，**Windows 上"跑测试"这一步挂了 25 分钟还没结束**
 * —— 一个用例卡住（表现是"永远不返回"），而 `node --test` 默认**没有**超时，
 * 于是整个 job 就那么挂着，日志里也不会出现任何失败的名字。加上它之后，
 * "卡住"会变成一个**带名字、带超时说明的失败**，一眼能看出是谁。
 * 3 分钟是这个套件里最慢的用例（GUI + 真实 TLS 那几条，本地约 10 秒）的十余倍。
 */
const userHasTimeout = passThrough.some((a) => a.startsWith('--test-timeout'))
const defaultTimeout = userHasTimeout ? [] : ['--test-timeout=180000']

// 注意：文件名逐个列出（不用 glob）—— 这样平台过滤的结果是**确定**的，
// 不会因为 shell 展开 glob 的顺序或范围不同而意外包含被排除的文件。
const args = ['--test', '--test-concurrency=1', ...defaultTimeout, ...passThrough,
  ...files.map((f) => path.join('test', f))]

/**
 * 额外挂一个 TAP reporter 写进临时文件。
 *
 * 为什么要多此一举：stdout 保持 `spec` reporter（终端里有颜色、可读），
 * 而 TAP 的结尾是机器可读的 `# tests 390 / # pass 389 …`，
 * 用它去核对 README 里写死的测试数量。**这个数字漂移过一次** ——
 * README 上写着 242，实际已经 390；同一段里还提到两个根本不存在的
 * npm 脚本（`test:unit` / `test:serial`）。文档里最容易骗人的就是
 * "看起来精确"的数字，所以让它每次跑测试时自己对一遍。
 *
 * 用户自己传了 `--test-reporter` 就不插手（免得参数打架）。
 */
const userHasReporter = passThrough.some((a) => a.startsWith('--test-reporter'))
/**
 * 只有"本平台的完整一轮"才有资格和 README 对数字。
 * `--fast`、`--test-name-pattern`、非 Windows 上 `--all` 都会跑出另一套数字，
 * 拿它们去比只会天天误报 —— 而天天误报的检查等于没有检查。
 */
const isFullRun = !argv.includes('--fast') && files.length === all.length &&
  !passThrough.some((a) => a.startsWith('--test-name-pattern') || a.startsWith('--test-only'))
const tapFile = (userHasReporter || !isFullRun)
  ? null : path.join(tmpdir(), `flicker-tap-${process.pid}.tap`)
if (tapFile) {
  args.splice(2, 0, // 插在 --test --test-concurrency=1 之后、文件列表之前
    '--test-reporter=spec', '--test-reporter-destination=stdout',
    '--test-reporter=tap', `--test-reporter-destination=${tapFile}`)
}

console.log(`平台 ${process.platform}：${files.length}/${all.length} 个测试文件`)
if (files.length < all.length) {
  const skipped = all.filter((f) => !files.includes(f))
  console.log(`跳过（证书机制仅 Windows 有实现）：${skipped.join(', ')}`)
  console.log('  这不是"跳过失败"，是明确的平台能力边界 —— 见 gen/test-plan.mjs 的说明')
}

/**
 * 顺手扫一遍**上次留下的**临时目录（超过 1 小时的）。
 *
 * 为什么放在这里：测试与演练是我们往用户 `%TEMP%` 里写东西的主要来源，
 * 而"进程被强杀/删不掉"总会漏下几个。每跑一次测试顺手收一次，
 * 就不会像 2026-10 那样攒到 2.8 GB 才被用户发现（见 gen/tmp.mjs 顶部的记录）。
 * 只删我们自己前缀、且超过 1 小时的 —— 正在跑的会话（无论哪个进程）都不会被动到。
 */
if (!argv.includes('--no-sweep')) {
  try {
    const { sweepStale } = await import('./clean-temp.mjs')
    const n = sweepStale({ olderThanMs: 3600_000 })
    if (n) console.log(`（顺手清掉了 ${n} 个上次留下的临时目录）`)
  } catch { /* 清理失败不该影响跑测试 */ }
}
console.log(`\n$ node ${args.join(' ')}\n`)

if (argv.includes('--dry')) process.exit(0)

/**
 * 看门狗：**一段时间没有任何输出**就判定"卡住了"，主动杀掉并说清卡在哪一步。
 *
 * 为什么需要：2026-10 的 CI 在 Windows 上挂过 25 分钟 —— 某个用例永远不返回，
 * 而 `node --test` 默认没有整体超时，job 就一直挂着，日志里连失败名字都没有。
 * 每用例的 `--test-timeout` 管不了"卡在测试之外"（钩子、模块加载、子进程不退）。
 * 这里管的是整体：5 分钟一声不响就当作卡死，把**最后的输出尾巴**打出来再失败 ——
 * 有尾巴才能看出来是哪个用例、哪个子进程在攥着管道。
 */
const STALL_MS = Number(process.env.FLICKER_TEST_STALL_MS ?? 300_000)
let tail = []
let stallTimer = null
let stalled = false

const child = spawn(process.execPath, args, { stdio: ['inherit', 'pipe', 'pipe'], cwd: ROOT })
const pump = (stream, out) => {
  stream.on('data', (b) => {
    out.write(b)
    tail.push(b.toString())
    if (tail.length > 80) tail.shift()
    if (stallTimer) stallTimer.refresh()
  })
}
pump(child.stdout, process.stdout)
pump(child.stderr, process.stderr)

if (STALL_MS > 0) {
  stallTimer = setTimeout(() => {
    stalled = true
    console.error(`\n✗ ${Math.round(STALL_MS / 1000)} 秒没有任何输出 —— 有东西卡住了。`)
    console.error('  最后 40 行输出：')
    for (const line of tail.slice(-40)) console.error(line.replace(/\s+$/, ''))
    console.error('\n（已经杀掉这个测试进程。卡住的用例名通常就在上面最后几行里；' +
      '若是"测试跑完却不退出"，那就是某个子进程/句柄没关，见 gen/check-test-cleanup.mjs）')
    try { child.kill('SIGKILL') } catch { /* 可能已经退出 */ }
  }, STALL_MS)
  stallTimer.unref?.()
}

child.on('exit', (code, signal) => {
  if (stallTimer) clearTimeout(stallTimer)
  const exitCode = stalled ? 1 : signal ? 1 : (code ?? 0)
  if (tapFile) { checkReadmeCounts(tapFile); rmSync(tapFile, { force: true }) }
  process.exit(exitCode)
})

/**
 * 用刚跑出来的数字核对 README 里写的数字。**只警告，不让测试失败**。
 *
 * 为什么不让它失败：测试数量每加一条用例就变，让文档数字卡住 CI
 * 会逼着人把这个数字删掉 —— 那就从"过期"变成"没有"，更糟。
 * 警告直指该改哪一行，成本最低。
 */
function checkReadmeCounts(file) {
  // CI 上会多几条"明确跳过"的用例（FLICKER_NO_CERT_INSTALL=1 → 证书库那 4 条），
  // 数字天然与 README 对不上。这里不刷警告，否则每天都是一条假警报；
  // 真机上仍然是"跑完就把数字对一遍"。
  if (process.env.FLICKER_NO_CERT_INSTALL === '1') return
  let tap = ''
  try { tap = readFileSync(file, 'utf8') } catch { return }
  const num = (k) => Number((tap.match(new RegExp(`^# ${k} (\\d+)$`, 'm')) ?? [])[1])
  const tests = num('tests'), pass = num('pass'), fail = num('fail'), skipped = num('skipped')
  if (!Number.isFinite(tests)) return       // 没拿到数字（reporter 变了）就安静跳过

  const targets = [
    // ⚠️ 中文版叫 `读我.md`（用户要求：中文 README 改名、英文的去掉 `.en`，
    //    两份都放根目录），英文版就叫 `README.md`。
    ['读我.md', /(\*\*测试现状：)(\d+) 个用例，(\d+) 通过、(\d+) 失败、(\d+) 跳过/,
      `**测试现状：${tests} 个用例，${pass} 通过、${fail} 失败、${skipped} 跳过`],
    ['README.md', /(\*\*Tests: )(\d+) cases — (\d+) pass, (\d+) fail, (\d+) skipped/,
      `**Tests: ${tests} cases — ${pass} pass, ${fail} fail, ${skipped} skipped`],
  ]

  const stale = []
  for (const [f, re, wanted] of targets) {
    const src = readFileSync(path.join(ROOT, f), 'utf8')
    const m = src.match(re)
    if (!m) { stale.push(`  ${f}：找不到测试数量那一行（是不是改过写法？）`); continue }
    const got = [Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])]
    if (got[0] !== tests || got[1] !== pass || got[2] !== fail || got[3] !== skipped) {
      stale.push(`  ${f}：写着 ${got.join('/')}，实际是 ${[tests, pass, fail, skipped].join('/')}\n` +
        `    应改成：${wanted}`)
    }
  }

  if (stale.length) {
    console.log('\n⚠️  文档里的测试数量和这次运行对不上：')
    for (const s of stale) console.log(s)
    console.log('   （只是提醒，不影响测试结果）')
  }
}
