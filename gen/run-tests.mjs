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
 * ⚠️ **平台过滤的清单只有一处**：`gen/test-plan.mjs` 的 `plan()`（连同它的 `--check`）。
 *    这个脚本以前自己藏着一份"4 个文件跳过"的清单，而 `--check` 审计的是另一份空表 ——
 *    于是"审计通过"没在守任何东西：macOS/Linux 上 e2e 被静默跳过、CI 却全绿。
 *    现在这里直接 import `plan()`，不再维护第二份（见 test-plan.mjs 顶部的记录）。
 *
 * 用法：
 *   node gen/run-tests.mjs                # 本平台适用的全部测试
 *   node gen/run-tests.mjs --all          # 强制跑全部（含平台专属的）
 *   node gen/run-tests.mjs --fast         # 只跑纯逻辑测试（秒级，不需证书）
 *   node gen/run-tests.mjs --parallel     # 同样按平台过滤，但并发跑（默认串行）
 *   node gen/run-tests.mjs --dry          # 只打印将要执行的命令，不真跑
 *   node gen/run-tests.mjs --update-docs  # 完整一轮之后，把用例数/失败数写回 README
 *
 * 额外参数会原样透传给 `node --test`。
 */
import { spawn } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WINDOWS_ONLY, plan } from './test-plan.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)

/** 纯逻辑测试：不进程、不证书，任何平台都能跑，秒级 */
const FAST = new Set([
  'suite.test.js', 'manifest.test.js', 'bundler.test.js', 'receiver-page.test.js',
  'relay-room.test.js', 'relay-protocol.test.js', 'relay-retry.test.js',
  'rate.test.js', 'password.test.js', 'session-auth.test.js', 'release.test.js',
  'i18n.test.js', 'pwa.test.js', 'session-cert.test.js', 'asset-digests.test.js',
  'docs-pairing.test.js', 'manifest-doc.test.js', 'changelog.test.js',
  'receiver-prefetch.test.js', 'chunk-size.test.js', 'receiver-hash-worker.test.js',
  'handshake-downgrade.test.js', 'line-endings.test.js', 'doc-numbers.test.js', 'doc-paths.test.js', 'font-scale.test.js', 'qr.test.js',
])

/**
 * 平台过滤的唯一真相：`gen/test-plan.mjs` 的 `plan()`。
 * 这里只做"取结果"和"按 --fast/--all 再筛"，**不再**维护第二份平台清单。
 */
const planResult = plan()
const all = planResult.all                        // 形如 'test/foo.test.js'
let files
if (argv.includes('--all')) files = all
else if (argv.includes('--fast')) files = planResult.files.filter((f) => FAST.has(path.basename(f)))
else files = planResult.files

if (files.length === 0) {
  // `node --test` 遇到"glob 零命中"会打印 `tests 0` 并**以 0 退出** ——
  // 看起来像"通过"，其实是语法/目录写错了。这里把这种静默失败变成显式失败。
  console.error('✗ 一个测试文件都没选中 —— `test/` 目录不在预期位置，或者过滤条件全落空。')
  process.exit(1)
}

/** 本脚本自己的开关**不能**透传给 `node --test`（它不认识，会直接报错）。 */
const OWN_FLAGS = ['--all', '--fast', '--dry', '--parallel', '--update-docs', '--no-sweep']
const passThrough = argv.filter((a) => !OWN_FLAGS.includes(a))
const parallel = argv.includes('--parallel')
const updateDocs = argv.includes('--update-docs')

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
// 默认串行（--test-concurrency=1）：套件里有真实端口/证书/进程的用例，并发会互扰；
// --parallel 是显式的"我知道可能会互扰，但我想快一点"。
const concurrency = parallel
  ? String(Math.max(1, Math.min(4, availableParallelism())))
  : '1'
const args = ['--test', `--test-concurrency=${concurrency}`, ...defaultTimeout, ...passThrough,
  ...files]

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
 * 只有"完整一轮"才有资格和 README 对数字。
 *
 * `--fast` / `--all` / `--test-name-pattern` / `--test-only` 都会跑出另一套数字，
 * 拿它们去比只会天天误报 —— 而天天误报的检查等于没有检查。
 * ⚠️ 2026-11 修正：`--all` 以前被漏掉了，注释却写着"非 Windows 上的 --all 会跑出另一套数字"，
 *    代码里并没有排除它 —— 注释与实现不一致本身就是这个项目最忌讳的一类失败。
 */
const isFullRun = !argv.includes('--fast') && !argv.includes('--all') &&
  files.length === all.length &&
  !passThrough.some((a) => a.startsWith('--test-name-pattern') || a.startsWith('--test-only'))
const tapFile = (userHasReporter || !isFullRun)
  ? null : path.join(tmpdir(), `flicker-tap-${process.pid}.tap`)
if (tapFile) {
  args.splice(2, 0, // 插在 --test --test-concurrency=… 之后、文件列表之前
    '--test-reporter=spec', '--test-reporter-destination=stdout',
    '--test-reporter=tap', `--test-reporter-destination=${tapFile}`)
}

console.log(`平台 ${process.platform}：${files.length}/${all.length} 个测试文件` +
  (parallel ? `（并发 ${concurrency}）` : '（串行）'))
// ⚠️ 平台跳过要按 **planResult.skipped** 打印，不能按 "files.length < all.length" ——
//    否则 `--fast` 少选的那些文件会被误报成"平台跳过"（2026-11 实测踩到）。
if (planResult.skipped.length) {
  console.log('跳过（清单在 gen/test-plan.mjs，每条都必须有 Windows 专属痕迹为证）：')
  for (const f of planResult.skipped) {
    console.log(`  － ${f}  ← ${WINDOWS_ONLY.get(f) ?? '（清单里没写理由 —— 这是 bug）'}`)
  }
}
if (argv.includes('--fast')) {
  console.log(`（--fast：只跑 ${files.length} 个纯逻辑测试文件，不是平台跳过）`)
}
if (updateDocs && !isFullRun) {
  console.log('（--update-docs 只认完整一轮测试；本次不是完整一轮，不会写文档）')
}

/**
 * 顺手扫一遍**上次留下的**临时目录（超过 1 小时的）。
 *
 * 为什么放在这里：测试与演练是我们往用户 `%TEMP%` 里写东西的主要来源，
 * 而"进程被强杀/删不掉"总会漏下几个。每跑一次测试顺手收一次，
 * 就不会像 2026-10 那样攒到 2.8 GB 才被用户发现（见 gen/tmp.mjs 顶部的记录）。
 * 只删**我们自己的 `flicker-` 前缀**、且超过 1 小时的（可删前缀比可建前缀更窄，
 * 见 gen/tmp.mjs 的 SWEEP_PREFIXES）—— 别的程序放在临时目录里的东西一律不碰。
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
  let exitCode = stalled ? 1 : signal ? 1 : (code ?? 0)
  if (tapFile) {
    const stale = checkReadmeCounts(tapFile, { updateDocs })
    // 数字过期而没加 --update-docs：默认**不写仓库**，但要让这次运行失败 ——
    // 否则"测试绿 + 文档数字过期"会一直被当成全绿（CI 里 check-doc-numbers 排在测试之前，
    // 它只看句式、看不到真实用例数，所以这一条必须由真正跑过测试的进程来兜底）。
    if (stale && exitCode === 0) exitCode = 1
    rmSync(tapFile, { force: true })
  }
  process.exit(exitCode)
})

/**
 * 用刚跑出来的数字核对 README 里写的数字。
 *
 * ── 默认只读（2026-11 修正）──
 * 从前这里**直接写回** README/读我.md。那让 `npm test` 有了仓库副作用：
 * 跑一次测试工作区就脏了，还把一次运行的数字默默固化进文档（测试套件本该只读）。
 * 现在默认只**报告 + 让本次运行失败**；真要写，显式加 `--update-docs`。
 *
 * 为什么"过期即失败"而不是"只警告"：2026-10 实测文档写 721 通过、实际 724，
 * 好几天没人发现 —— 一句黄字在几百行输出里没人会看。让 CI 红才是判据。
 *
 * @returns {boolean} 是否有数字对不上（true = 过期；调用方据此决定退出码）
 */
function checkReadmeCounts(file, { updateDocs = false } = {}) {
  let tap = ''
  try { tap = readFileSync(file, 'utf8') } catch { return false }
  const num = (k) => Number((tap.match(new RegExp(`^# ${k} (\\d+)$`, 'm')) ?? [])[1])
  const tests = num('tests'), fail = num('fail')
  if (!Number.isFinite(tests)) return false   // 没拿到数字（reporter 变了）就安静跳过

  // ⚠️ 只比 **用例总数** 与 **失败数**。跳过的条数是**环境属性**（有没有 git、能不能建
  //    符号链接、有没有 IPv6 回环、证书库要不要人点确认框……），同一份代码在不同机器上
  //    取值不同：2026-10 实测本机 1 条、CI 上 5 条、开 `FLICKER_NO_CERT_INSTALL=1`
  //    时 8 条。把它写进 README 就等于写了一个必然过期的数字，所以文档里只写"随机器
  //    能力变化，跑完会打印"，这里也就没有跳过数可比。
  const targets = [
    // 中文版叫 `读我.md`（用户要求：中文 README 改名、英文的去掉 `.en`，两份都放根目录）
    ['读我.md', /\*\*测试现状：(\d+) 个用例，(\d+) 失败/],
    ['README.md', /\*\*Tests: (\d+) cases, (\d+) failures?/],
  ]

  // ⚠️ **失败数不为 0 时一个字都不写、也不算数字过期**：文档里绝不能出现
  //    "788 个用例，2 失败"这种被机器写上去的失败记录 —— 那等于把一次坏掉的运行
  //    固化进 README。实测踩过：改坏判据的那一轮把 `失败数 0 → 2` 写了进去。
  if (fail > 0) {
    console.log(`\n⚠️  这次有 ${fail} 条用例失败，**不**更新/核对 README 里的测试现状`)
    return false
  }

  const changed = []
  const stale = []
  const missing = []
  for (const [f, re] of targets) {
    const full = path.join(ROOT, f)
    const src = readFileSync(full, 'utf8')
    const m = src.match(re)
    if (!m) { missing.push(f); continue }
    if (Number(m[1]) === tests && Number(m[2]) === fail) continue
    const bits = []
    if (Number(m[1]) !== tests) bits.push(`用例总数 ${m[1]} → ${tests}`)
    if (Number(m[2]) !== fail) bits.push(`失败数 ${m[2]} → ${fail}`)
    if (!updateDocs) { stale.push(`${f}：${bits.join('、')}`); continue }
    const fixed = src.replace(re, (whole, a, b) => whole.replace(a, tests).replace(b, fail))
    writeFileSync(full, fixed, 'utf8')
    changed.push(`${f}：${bits.join('、')}`)
  }

  if (missing.length) {
    console.log(`\n⚠️  这几份 README 里找不到"测试现状"那一行（是不是改过写法？）：${missing.join(', ')}`)
    console.log('   （只是提醒，不影响测试结果 —— 但 npm run check 里的 check-doc-numbers 会失败）')
  }
  if (stale.length) {
    console.error('\n✗ README 里的测试数字已经过期（本次没有写盘）：')
    for (const s of stale) console.error(`   ${s}`)
    console.error('  改法：跑一次完整测试并加 --update-docs（它会写回上面这两行）：')
    console.error('      node gen/run-tests.mjs --update-docs')
    console.error('  或者手动把上面"→"右边的数字填进对应那一行。')
    return true
  }
  if (changed.length) {
    console.log('\n✓ 已把这次跑出来的数字写回 README（--update-docs）：')
    for (const c of changed) console.log(`   ${c}`)
    console.log('   （这些改动记得一起提交；跳过条数刻意不写进文档，它随机器能力变化）')
  }
  return false
}
