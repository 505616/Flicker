/**
 * 文档里那些**会随时间变化的具体数字**，必须有机器盯着
 * ==================================================
 *
 * ── 为什么要有这一条 ──
 * 2026-10 用户说"看看文档里有没有错误"，一次揪出四类会过期的数字：
 *   · i18n 文案条数（写着 171，实际 319 —— 现在是 373）
 *   · 单文件产物大小（写着 89.5 / 91 MB，实际 94 MB 出头）
 *   · 文档份数（写着各 10 份，实际各 12 份）
 *   · 示例输出里的版本号（写着 v1.0.0，实际 0.1.0）
 * 同一段时间里还发现过两次"数字写错但没人发现"（测试数量 242 vs 390、
 * 两个根本不存在的 npm 脚本）。结论：**数字越多的地方越需要判据** ——
 * 因为"看起来很精确"的东西最没人怀疑。
 *
 * ── 判据怎么定（只盯"当前事实"，不碰历史叙述）──
 * 这个脚本里每一条叫一个 **fact**：值由源码/产物**算**出来，然后要求文档里
 * 某一处**声明**它（正则里带一个捕获组）。两条都会验：
 *   ① 声明了 → 数字必须等于算出来的值；
 *   ② **一处都没声明 → 也算失败**（否则哪天那句话被删掉，这条判据就悄悄失效了，
 *      而"检查还在跑"会让人以为这件事还有人管）。
 *
 * 历史叙述**刻意不纳入**：变更记录里"171 → 实际 319"记录的是当年那次修正本身，
 * 它不是"当前事实"，写死了反而是对的。所以这里的正则都贴着具体句式
 * （比如 `条文案并列`），不去扫"所有数字" —— 那种判据只会天天误报。
 *
 * ── 产物大小（+`--artifact`）──
 * exe / zip 的 MB 数只有**构建之后**才知道，所以：
 *   · `npm run check` 里跑的是本文件（不带参数）：只核能从源码算出来的那些；
 *   · CI 的 Windows job 在 `build-sea.mjs` 之后跑 `--artifact`：把文档里写的
 *     产物大小与真实产物对一遍（±0.1 MB，因为赠品源码包里带着文档本身，
 *     改一次文档就会让产物浮动几十 KB）。
 * 其它平台不跑（各自产物大小不同，文档写的是 Windows 那个），会打印"跳过"。
 *
 * 用法：
 *   node gen/check-doc-numbers.mjs
 *   node gen/check-doc-numbers.mjs --artifact     # 额外的产物大小核对（要 dist/）
 *   node gen/check-doc-numbers.mjs --root=/tmp/x  # 判据自己的测试用
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { STRINGS } from '../web/i18n-strings.mjs'
import { parseWorkflow } from '../_lab/rehearse-ci.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 从 `--key=value` 里取值（测试注入坏掉的副本用） */
export function argOf(argv, name, fallback) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

/** 只读一次文件（同一份文档可能被多条 fact 引用） */
export function makeReader(root) {
  const cache = new Map()
  return (rel) => {
    if (!cache.has(rel)) {
      const full = path.join(root, rel)
      cache.set(rel, existsSync(full) ? readFileSync(full, 'utf8') : null)
    }
    return cache.get(rel)
  }
}

/**
 * 算出所有 fact。**纯函数之外只做两件可注入的事**：读文件、数目录。
 *
 * @returns {Array<{id:string,label:string,value:string,claims:Array<{file:string,re:RegExp,hint?:string}>}>}
 */
export function collectFacts({ root = ROOT, includeArtifact = false } = {}) {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  const zh = Object.keys(STRINGS.zh)
  const en = Object.keys(STRINGS.en)
  const docCount = (dir) => {
    const full = path.join(root, dir)
    return existsSync(full) ? readdirSync(full).filter((f) => f.endsWith('.md')).length : 0
  }
  // CI 的步骤数：用预演脚本自己的解析器数（它读的就是 ci.yml）。
  // 文件不存在时返回 null —— 判据自己的测试会用临时目录造一个没有 .github 的"仓库"，
  // 那里不该凭空造一条事实出来（"CI 文件不存在"是 check-ci-parity 的活儿）。
  const ciSteps = () => {
    const f = path.join(root, '.github/workflows/ci.yml')
    if (!existsSync(f)) return null
    return String(parseWorkflow(readFileSync(f, 'utf8')).reduce((n, job) => n + job.steps.length, 0))
  }
  const facts = [
    {
      id: 'i18n.count',
      label: 'i18n 文案条数（中英各一份）',
      // 两边条数必须相等，这是 collectFacts 之外的前提 —— 不相等就直接报错更清楚
      value: String(zh.length === en.length ? zh.length : `不等（zh ${zh.length} / en ${en.length}）`),
      claims: [
        { file: '变更记录.md', re: /(\d+) 条文案并列/ },
        { file: 'CHANGELOG.md', re: /(\d+) strings side by side/ },
        { file: '中文文档/路线图.md', re: /（(\d+) 条中英并列）/ },
        { file: '中文文档/路线图.md', re: /（(\d+) 条文案，中英并列）/ },
        { file: '中文文档/路线图.md', re: /文案表（(\d+) 条）/ },
        { file: 'docs/路线图.md', re: /\((\d+) strings, Chinese and English side by side\)/ },
        { file: '_lab/交接.md', re: /i18n-strings\.mjs\s+(\d+) 条 × 中英/ },
      ],
    },
    {
      id: 'check.count',
      label: '`npm run check` 的判据条数',
      value: String(String(pkg.scripts?.check ?? '').split('&&').filter((s) => s.trim()).length),
      claims: [
        { file: '_lab/交接.md', re: /(\d+) 条判据/ },
      ],
    },
    // 用预演脚本自己的解析器数：这样"CI 加了一步、交接里还写着旧数字"会当场红，
    // 而不是等谁去数一遍（2026-10 就漂过一次：33 → 35）。
    ...(ciSteps() === null ? [] : [{
      id: 'ci.steps',
      label: 'CI 的步骤数（两个 job 加起来，rehearse 脚本读的就是它）',
      value: ciSteps(),
      claims: [
        { file: '_lab/交接.md', re: /把 (\d+) 个步骤按 CI 的顺序/ },
      ],
    }]),
    {
      id: 'docs.zh',
      label: '中文文档份数',
      value: String(docCount('中文文档')),
      claims: [
        { file: '变更记录.md', re: /各 (\d+) 份，结构由机器守着一致/ },
      ],
    },
    {
      id: 'docs.en',
      label: '英文文档份数',
      value: String(docCount('docs')),
      claims: [
        { file: 'CHANGELOG.md', re: /(\d+) each, with their structure kept in step/ },
      ],
    },
    {
      id: 'version',
      label: '示例/产物名里的版本号',
      value: String(pkg.version),
      // 形如 `flicker-0.1.0-windows-x64.exe`：出现在文档里就是一条"当前版本"的声明
      claims: [
        { file: '中文文档/架构决策.md', re: /flicker-(\d+\.\d+\.\d+)-windows-x64\.exe/ },
        { file: 'docs/架构决策.md', re: /flicker-(\d+\.\d+\.\d+)-windows-x64\.exe/ },
        { file: '中文文档/路线图.md', re: /flicker-(\d+\.\d+\.\d+)-windows-x64\.exe/ },
        { file: 'docs/路线图.md', re: /flicker-(\d+\.\d+\.\d+)-windows-x64\.exe/ },
      ],
    },
    {
      id: 'node.major',
      label: '最低 Node 版本（取自 package.json engines）',
      value: String(String(pkg.engines?.node ?? '').replace(/[^\d.]/g, '').split('.')[0]),
      claims: [
        { file: '中文文档/使用手册.md', re: /Node(?:\.js)? (\d+)\+/ },
        { file: 'docs/使用手册.md', re: /Node(?:\.js)? (\d+) or newer/ },
        { file: 'docs/使用手册.md', re: /Node(?:\.js)? (\d+)\+/ },
        { file: '中文文档/构建单文件.md', re: /\| Node(?:\.js)? (\d+)\+/ },
        { file: 'docs/构建单文件.md', re: /\| Node(?:\.js)? (\d+)\+/ },
        { file: 'docs/PROTOCOL.md', re: /depends on Node\.js (\d+)\+/ },
      ],
    },
  ]

  if (includeArtifact) {
    const dist = path.join(root, 'dist')
    const exe = existsSync(dist)
      ? readdirSync(dist).find((f) => f.endsWith('.exe'))
      : null
    if (exe) {
      const exeMb = (readFileSync(path.join(dist, exe)).length / 1048576).toFixed(1)
      // zip 的大小由 release.mjs 算，这里不重复一遍：只核 exe 与"文档里写的 zip"彼此一致
      facts.push({
        id: 'artifact.exeMb',
        label: '单文件产物大小（MB）',
        value: exeMb,
        tolerance: 0.1,
        // ⚠️ 只捕获**第一个**数字：`94.6 MB → 36.1 MB` 里第二个是 zip 的大小，
        //    属于另一条 fact（产物被压缩后多大），拿它去比 exe 的大小只会天天误报。
        claims: [
          { file: '中文文档/构建单文件.md', re: /\| 未压缩（exe） \| (\d+\.\d) MB \|/ },
          { file: 'docs/构建单文件.md', re: /\| Uncompressed \(the exe\) \| (\d+\.\d) MB \|/ },
          { file: '读我.md', re: /约 (\d+\.\d) MB → \d+\.\d MB/ },
          { file: 'README.md', re: /about (\d+\.\d) MB → \d+\.\d MB/ },
        ],
      })
      const relDir = path.join(root, 'dist', 'release')
      const zip = existsSync(relDir)
        ? readdirSync(relDir).find((f) => f.endsWith('.zip'))
        : null
      if (zip) {
        facts.push({
          id: 'artifact.zipMb',
          label: 'zip 产物大小（MB）',
          value: (readFileSync(path.join(relDir, zip)).length / 1048576).toFixed(1),
          tolerance: 0.1,
          claims: [
            { file: '中文文档/构建单文件.md', re: /\| zip \| \*\*(\d+\.\d) MB/ },
            { file: 'docs/构建单文件.md', re: /\| The zip \| \*\*(\d+\.\d) MB/ },
            { file: '读我.md', re: /约 \d+\.\d MB → (\d+\.\d) MB/ },
            { file: 'README.md', re: /about \d+\.\d MB → (\d+\.\d) MB/ },
          ],
        })
      }
    }
  }
  return facts
}

/**
 * 核一遍：每条 fact 的所有声明都必须等于 value（支持 tolerance），
 * 而且要**至少命中一处**。
 *
 * @param {object} opts
 * @param {Array} opts.facts  collectFacts() 的结果
 * @param {(rel:string)=>string|null} opts.read  读文件（注入坏副本用）
 * @returns {{problems:Array<{fact:string,file?:string,line?:number,claim?:string,expected:string,note?:string}>, checked:number, hits:number}}
 */
export function checkFacts({ facts, read }) {
  const problems = []
  let checked = 0
  let hits = 0
  for (const fact of facts) {
    let factHits = 0
    for (const claim of fact.claims) {
      const src = read(claim.file)
      if (src === null) {
        problems.push({ fact: fact.id, file: claim.file, expected: fact.value, note: '声明的文件不存在' })
        continue
      }
      const lines = src.split('\n')
      let found = 0
      for (let i = 0; i < lines.length; i++) {
        const re = new RegExp(claim.re.source, claim.re.flags.includes('g') ? claim.re.flags : claim.re.flags + 'g')
        for (const m of lines[i].matchAll(re)) {
          found++
          factHits++
          hits++
          // 多组捕获（比如 "A MB → B MB"）时逐个比：两个数必须是同一个 fact 的值
          const groups = m.slice(1).filter((g) => g !== undefined)
          for (const got of groups) {
            if (!sameNumber(got, fact.value, fact.tolerance)) {
              problems.push({
                fact: fact.id, file: claim.file, line: i + 1,
                claim: m[0].slice(0, 80), expected: fact.value,
              })
            }
          }
        }
      }
      if (found === 0) {
        problems.push({
          fact: fact.id, file: claim.file, expected: fact.value,
          note: `没找到这句声明（正则 ${claim.re}）—— 句子被改掉/删掉之后这条判据就失效了`,
        })
      }
    }
    if (factHits > 0) checked++
  }
  return { problems, checked, hits }
}

/** 数字比较：字符串化的数字（"0.1.0" 这类版本号）必须逐字相等；MB 允许容差 */
export function sameNumber(claimed, expected, tolerance) {
  const c = String(claimed).trim()
  const e = String(expected).trim()
  if (tolerance !== undefined) {
    const cn = Number(c)
    const en = Number(e)
    if (!Number.isFinite(cn) || !Number.isFinite(en)) return c === e
    return Math.abs(cn - en) <= tolerance + 1e-9
  }
  return c === e
}

/**
 * README 里那句"测试现状"：**只许钉用例总数与失败数，不许钉跳过条数**。
 * -------------------------------------------------------------
 * 这是 2026-10 复查文档时抓到的一条真错误：两份 README 都写着
 * `725 个用例，721 通过、0 失败、4 跳过`，还额外解释"在 macOS / Linux 上另有
 * 4 个**文件**整体跳过"。实测下来两处都不成立：
 *   · 跳过条数是**环境属性** —— 同一台机器换一种跑法就从 4 变 1（能不能建符号链接、
 *     PATH 里有没有 git、有没有 IPv6 回环、CI 上证书库要不要人点确认框）；
 *   · `gen/test-plan.mjs` 里的 `WINDOWS_ONLY` 是**空的**，没有任何测试文件按平台整体
 *     跳过（`test-plan.test.js` 就是在守这一点）。
 * 数字写死之后没人会去每台机器各跑一遍验证，于是它就一直是错的。所以这条判据的做法是：
 *   ① 找到那句话（找不到 = 失败 —— 句子被删掉之后判据就悄悄失效了）；
 *   ② 失败数必须是 0；
 *   ③ 那句话里**不许**出现"N 跳过 / N skipped"这种钉死的统计。
 * 跳过原因该怎么写，文档里已经改成"随机器能力变化 + 逐条列原因"的写法。
 */
export function checkTestStatus({ read }) {
  const problems = []
  // anchor 只负责"找到那句话"，re 负责"它的形状对不对" —— 分开是有意的：
  // 旧写法（721 通过、4 跳过）连形状都变了，如果只有一条正则，报出来的会是
  // "找不到那一行"，把真正的问题（写死了跳过条数）盖住。
  const rules = [
    {
      file: '读我.md',
      anchor: /测试现状：/,
      re: /\*\*测试现状：(\d+) 个用例，(\d+) 失败/,
      shape: '**测试现状：725 个用例，0 失败。**',
    },
    {
      file: 'README.md',
      anchor: /^\*\*Tests: /,
      re: /\*\*Tests: (\d+) cases, (\d+) failures?/,
      shape: '**Tests: 725 cases, 0 failures.**',
    },
  ]
  // "钉死跳过条数"的两种写法：`4 跳过`、`4 条跳过`、`4 skipped`
  const PINNED_SKIPS = /(\d+\s*条?\s*跳过|\d+\s*skipped)/i
  const EXPECT_SHAPE = '只写用例总数与失败数（形如 ' + '**测试现状：725 个用例，0 失败。**），跳过条数与环境有关、不许写死'
  for (const { file, anchor, re, shape } of rules) {
    const src = read(file)
    if (src === null) {
      problems.push({ fact: 'testStatus', file, note: '文件不存在' })
      continue
    }
    const lines = src.split('\n')
    const idx = lines.findIndex((l) => anchor.test(l))
    if (idx < 0) {
      problems.push({
        fact: 'testStatus', file,
        note: `找不到"测试现状"那一行（找的是 ${anchor}）—— 句子被改掉/删掉之后这条判据就失效了`,
      })
      continue
    }
    const line = lines[idx]
    const m = line.match(re)
    if (!m) {
      problems.push({
        fact: 'testStatus', file, line: idx + 1,
        claim: line.slice(0, 80), expected: `${EXPECT_SHAPE}（例如 ${shape}）`,
      })
      continue
    }
    if (m[2] !== '0') {
      problems.push({
        fact: 'testStatus', file, line: idx + 1,
        claim: `失败数写成 ${m[2]}`, expected: '0 失败（有失败就该修测试，而不是改文档）',
      })
    }
    if (PINNED_SKIPS.test(line)) {
      problems.push({
        fact: 'testStatus', file, line: idx + 1,
        claim: line.slice(0, 80),
        expected: '不要写死跳过条数（它随机器能力变化）—— 只写用例总数与失败数，跳过原因逐条列',
      })
    }
  }
  return { problems }
}

// ── CLI ──────────────────────────────────────────────────────

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  const argv = process.argv.slice(2)
  const root = argOf(argv, 'root', ROOT)
  const includeArtifact = argv.includes('--artifact')
  const read = makeReader(root)

  if (includeArtifact && process.platform !== 'win32') {
    console.log(`✓ 产物大小核对：跳过（文档写的是 Windows 产物；这台是 ${process.platform}）`)
  }
  const wantArtifact = includeArtifact && process.platform === 'win32'
  const facts = collectFacts({ root, includeArtifact: wantArtifact })
  if (wantArtifact && !facts.some((f) => f.id === 'artifact.exeMb')) {
    console.log('✓ 产物大小核对：跳过（dist/ 里还没有 .exe —— 先 npm run build）')
  }

  const { problems, checked, hits } = checkFacts({ facts, read })
  const status = checkTestStatus({ read })
  problems.push(...status.problems)

  for (const fact of facts) {
    const n = fact.claims.length
    console.log(`  · ${fact.label}：${fact.value}（${n} 处声明）`)
  }
  if (problems.length) {
    console.error(`\n✗ 有 ${problems.length} 处文档数字与实现不符：`)
    for (const p of problems) {
      const where = p.file + (p.line ? `:${p.line}` : '')
      if (p.note) console.error(`   ${where}  [${p.fact}] ${p.note}`)
      else console.error(`   ${where}  [${p.fact}] 文档写的是 ${p.claim ?? ''}，实际应为 ${p.expected}`)
    }
    console.error('\n改法：把文档里的那个数字改成上面"实际应为"的值；' +
      '如果是句子被改掉了，请把那个句式补回去（这条判据靠它定位）。')
    process.exit(1)
  }
  console.log(`✓ 测试现状那一行：只钉用例总数与失败数，没有写死跳过条数`)
  console.log(`\n✓ 文档里的数字与实现一致（${checked} 条事实 / ${hits} 处声明）`)
}
