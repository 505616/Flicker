/**
 * 按平台挑选要跑的测试文件。
 *
 * 为什么需要它（而不是在 CI 里写死一个 glob）：
 * 有些能力**只在某些平台上实现**，在别的平台上相关测试必然失败。
 * 把这份判断写进脚本，好处是**本地也能预览** —— 不用等推上去跑 CI 才发现
 * "哦，这个平台跑不了这个文件"。
 *
 * ⚠️ 这个清单会**过时**，而且过时的方式很隐蔽：某个平台短板被补上之后，
 *    清单里还留着一行，于是那些用例在别的平台上**再也不会跑**，
 *    看起来一切正常（绿色），实际上覆盖率静悄悄地掉了一半。
 *    真实发生过：证书生成从 PowerShell 改成纯 JS 之后，
 *    这里仍然把 4 个文件挡在 macOS/Linux 之外 —— 而它们其实早就能跑了。
 *    所以现在有 `--check`：它按"这个文件是否真的碰了 Windows 专属的东西"
 *    逐条复核清单，对不上就报错。`npm run check` 会跑它。
 *
 * 用法：
 *   node gen/test-plan.mjs              # 打印本机要跑的文件
 *   node gen/test-plan.mjs --json       # 机器可读
 *   node gen/test-plan.mjs --glob       # 只输出可直接拼进命令行的参数
 *   node gen/test-plan.mjs --check      # 复核"平台专属清单"是否已经过时
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 只在 Windows 上跑的文件，附**具体原因**。
 *
 * 判据很硬：文件里必须真的出现 Windows 专属的命令或 API
 * （`certutil` / `powershell` / `Cert:\CurrentUser` / `--app=` 的 Edge 窗口 …）。
 * `--check` 会逐条扫源码验证这一点 —— 说"这个文件需要 Windows"却拿不出证据，
 * 就是在白丢覆盖率。
 */
const WINDOWS_ONLY = new Map()

/** Windows 专属的痕迹：出现任一，才允许把文件列进 WINDOWS_ONLY */
const WINDOWS_MARKERS = [
  /certutil/i,
  /powershell/i,
  /Cert:\\\\CurrentUser/,
  /'win32'/,
]

/** 读一个测试文件的源码 */
const readTest = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')

/** 找出文件里出现的 Windows 专属痕迹 */
function windowsMarkersIn(rel) {
  const src = readTest(rel)
  return WINDOWS_MARKERS.filter((re) => re.test(src)).map((re) => re.source)
}

/**
 * 所有测试文件
 * @param {string} [platform] 模拟的平台（默认本机）
 */
export function plan(platform = process.platform) {
  const all = readdirSync(path.join(ROOT, 'test'))
    .filter((f) => f.endsWith('.test.js'))
    .sort()
    .map((f) => `test/${f}`)

  const isWindows = platform === 'win32'
  const files = isWindows ? all : all.filter((f) => !WINDOWS_ONLY.has(f))
  const skipped = all.filter((f) => !files.includes(f))
  return { platform, all, files, skipped }
}

/**
 * 复核一批「平台专属」条目：每一条都要拿得出 Windows 专属的痕迹。
 *
 * 抽成接收参数的纯函数是**故意的**：这样测试可以塞一条假条目进来，
 * 确认它真的会被抓出来。一个"永远通过"的检查等于没有检查 ——
 * 本项目已经吃过一次这种亏（测试脚本没在测它声称在测的东西）。
 *
 * @param {Iterable<[string, string]>} entries [文件, 理由] 列表
 * @returns {string[]} 问题列表（空数组 = 通过）
 */
export function auditEntries(entries) {
  const problems = []
  for (const [file, reason] of entries) {
    let markers
    try {
      markers = windowsMarkersIn(file)
    } catch (e) {
      problems.push(`${file}: 读不到（${e.message}）—— 文件改名了？`)
      continue
    }
    if (markers.length === 0) {
      problems.push(
        `${file}: 清单说它需要 Windows（${reason}），但源码里找不到任何 Windows 专属的东西。\n` +
        '    → 它现在应当能在 macOS/Linux 上跑。把它从 WINDOWS_ONLY 里删掉，\n' +
        '      否则这些用例在那些平台上永远不会被执行（而且 CI 还是绿的）。')
    }
  }
  return problems
}

/** 复核真实的 WINDOWS_ONLY 清单 */
export function auditWindowsOnly() {
  return auditEntries(WINDOWS_ONLY)
}

/**
 * 本平台可跑的测试文件，**按目录聚成 glob**（形如 `test/*.test.js`）。
 *
 * 为什么不直接给一串文件名：
 *   ① npm script 与 CI 里要跨平台引用它，长串文件名拼进命令行又脆又难读；
 *   ② 但**不能**简单地一律用 `test/*.test.js` —— 那样会把 Windows 专属的
 *      文件也带进来，在 macOS/Linux 上必失败（见上面的 WINDOWS_ONLY）。
 *   ③ 所以：全平台都能跑时给单条 glob；否则枚举文件（此时无法用 glob 表达）。
 */
function asGlob(list, total) {
  if (list.length === total) return ['test/*.test.js']
  return list
}

// ── 命令行入口（被 import 时不执行）──────────────────────────
// ⚠️ 用 fileURLToPath 比对**真实路径**，不要拿 import.meta.url 去拼字符串：
//    路径里有中文时 URL 会做百分号编码，拼出来的字符串跟 argv[1] 对不上，
//    于是"被直接调用"永远判为 false —— 脚本静默地什么都不打印。
//    （这类"看起来在跑、其实没跑"的失败是本项目最想避免的一种。）
const invokedDirectly = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  const { platform, all, files, skipped } = plan()
  const pattern = asGlob(files, all.length)

  if (process.argv.includes('--check')) {
    const problems = auditWindowsOnly()
    if (problems.length) {
      console.error('✗ 「平台专属测试清单」已经过时：\n')
      for (const p of problems) console.error(`  - ${p}\n`)
      process.exit(1)
    }
    console.log(`✓ 平台专属测试清单复核通过（${WINDOWS_ONLY.size} 条，都有 Windows 专属痕迹为证）`)
  } else if (process.argv.includes('--json')) {
    console.log(JSON.stringify({
      platform, pattern, files, skipped,
      windowsOnly: Object.fromEntries(WINDOWS_ONLY),
    }, null, 2))
  } else if (process.argv.includes('--glob')) {
    // 只输出参数本身，供 npm script / CI 直接拼进命令行
    console.log(pattern.join(' '))
  } else {
    console.log(`平台：${platform}`)
    console.log(`要跑 ${files.length} 个文件${files.length === all.length ? '（全部）' : `（共 ${all.length} 个，跳过 ${skipped.length} 个）`}：`)
    for (const f of files) console.log(`  ✓ ${f}`)
    if (skipped.length) {
      console.log('\n跳过（确有 Windows 专属的依赖）：')
      for (const f of skipped) console.log(`  － ${f}  ← ${WINDOWS_ONLY.get(f)}`)
    }
    console.log(`\n命令行用法：node --test --test-concurrency=1 ${pattern.join(' ')}`)
  }
}
