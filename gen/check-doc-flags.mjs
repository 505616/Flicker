/**
 * 文档里的命令行参数，程序真的认吗？
 * ================================
 * 这条判据守的是一类**很安静**的错误：文档里写着一个程序不认的参数。
 *
 * 为什么值得单独守：
 *   · 用户照着文档打了 `flicker recv --connect=...`，程序回一句"这不是一个链接" ——
 *     他会以为是自己抄错了，而不是文档错了；
 *   · 这类错误在测试、构建、发布里全都看不出来（文档不进 CI 的执行路径），
 *     只有真的有人照着敲才会暴露；
 *   · 2026-10 实测就有 5 个：`--gui`、`--quiet`、`--lang`、`--connect`、`--out`
 *     —— 全是文档里写了、程序从来没实现过的（其中 `recv` 那两行描述的还是一个
 *     当时根本不存在的子命令形态）。
 *
 * 做法（刻意简单、可复核）：
 *   ① 从 `bin/flicker.js` 抓出**真正被读到的**参数名：`flags.xxx` / `flags['xxx']`
 *      ＋ 用法说明（USAGE）里列出来的；
 *   ② 从两份使用手册的**参数参考章节**抓出 `` `--xxx `` 形式的名字
 *      （只看这一章：别的章节里的示例难免提到构建脚本的参数，如 `--dist`）；
 *   ③ 差集就是"文档说了、程序不认"的，直接失败。
 *
 * ⚠️ 反向（程序认、文档没写）只提示不失败：`--machine`、`--machine-cert`
 *    这类是给自动化客户端用的，本来就不打算写进用户手册。
 *
 * 用法：node gen/check-doc-flags.mjs
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI_REL = 'bin/flicker.js'
const DOCS = ['中文文档/使用手册.md', 'docs/使用手册.md']
/** 参数参考章节的标题（中文 / 英文各一条） */
const SECTION = /^## (六、完整参数参考|6\. Full option reference)/m

const cli = readFileSync(path.join(ROOT, CLI_REL), 'utf8')

const known = new Set()
for (const m of cli.matchAll(/flags\.([a-zA-Z][\w-]*)/g)) known.add(m[1])
for (const m of cli.matchAll(/flags\[['"]([\w-]+)['"]\]/g)) known.add(m[1])
const usage = cli.slice(cli.indexOf('const USAGE'), cli.indexOf('/** 解析 --key=value'))
for (const m of usage.matchAll(/--([a-z][\w-]*)/g)) known.add(m[1])

/** 文档里提到、但**不是命令行参数**的东西（表格里的占位符之类） */
const IGNORE = new Set([])

const problems = []
for (const rel of DOCS) {
  const txt = readFileSync(path.join(ROOT, rel), 'utf8')
  const start = txt.search(SECTION)
  if (start < 0) {
    problems.push(`${rel}: 找不到"参数参考"章节（标题改了？正则要跟着改）`)
    continue
  }
  const rest = txt.slice(start)
  // 章节在本文件里是 `## 六、…` / `## 6. …`，下一个同级标题即章节结束
  const end = rest.slice(1).search(/^## /m)
  const section = end < 0 ? rest : rest.slice(0, end + 1)
  for (const m of section.matchAll(/`--([a-z][\w-]*)/g)) {
    const flag = m[1]
    if (IGNORE.has(flag) || known.has(flag)) continue
    problems.push(`${rel}: 参数表里写了 --${flag}，但 ${CLI_REL} 不认这个参数`)
  }
}

const undocumented = [...known].filter((f) => !['h', 'help', 'v', 'version', 'machine', 'machine-cert', 'plugin', 'plugins', 'dry-run'].includes(f))
for (const rel of DOCS) {
  const txt = readFileSync(path.join(ROOT, rel), 'utf8')
  for (const f of undocumented) {
    if (!txt.includes(`--${f}`)) console.log(`  （提示）${rel} 里没提到 --${f}（可能是有意不写，例如安装/构建用的）`)
  }
}

if (problems.length) {
  console.error('✗ 文档与命令行的参数对不上：')
  for (const p of problems) console.error(`   ${p}`)
  console.error('  改法：要么在 bin/flicker.js 里真的实现它，要么把文档改对（不要留着不存在的参数）')
  process.exit(1)
}
console.log(`✓ 文档参数表里的参数程序都认（共 ${known.size} 个已知参数）`)
