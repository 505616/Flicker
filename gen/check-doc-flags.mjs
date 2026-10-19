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
 * 判据逻辑抽成 `auditDocFlags(root)`，CLI 只负责打印 ——
 * `test/doc-flags.test.js` 会拿一份"文档写了 --nope、程序不认"的假仓库反过来验它。
 *
 * 用法：node gen/check-doc-flags.mjs [--root=<另一棵树>]
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI_REL = 'bin/flicker.js'
export const DOCS = ['中文文档/使用手册.md', 'docs/使用手册.md']
/** 参数参考章节的标题（中文 / 英文各一条） */
const SECTION = /^## (六、完整参数参考|6\. Full option reference)/m

/** 从 `--key=value` 里取值（测试注入坏掉的副本用） */
export function argOf(argv, name, fallback) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

/**
 * 从 CLI 源码里抓"程序真的认"的参数名。
 * @param {string} cli bin/flicker.js 的源码
 */
export function knownFlagsFrom(cli) {
  const known = new Set()
  for (const m of cli.matchAll(/flags\.([a-zA-Z][\w-]*)/g)) known.add(m[1])
  for (const m of cli.matchAll(/flags\[['"]([\w-]+)['"]\]/g)) known.add(m[1])
  const start = cli.indexOf('const USAGE')
  const end = cli.indexOf('/** 解析 --key=value')
  if (start >= 0) {
    const usage = cli.slice(start, end < 0 ? undefined : end)
    for (const m of usage.matchAll(/--([a-z][\w-]*)/g)) known.add(m[1])
  }
  return known
}

/** 取"参数参考"那一章（找不到返回 null） */
export function flagSection(txt) {
  const start = txt.search(SECTION)
  if (start < 0) return null
  const rest = txt.slice(start)
  // 章节在本文件里是 `## 六、…` / `## 6. …`，下一个同级标题即章节结束
  const end = rest.slice(1).search(/^## /m)
  return end < 0 ? rest : rest.slice(0, end + 1)
}

/**
 * 核一棵树：返回 { problems, info, known }。
 * @param {string} root 仓库根目录（测试时指向一份临时副本）
 */
export function auditDocFlags(root = ROOT) {
  const problems = []
  const info = []

  let cli = ''
  try {
    cli = readFileSync(path.join(root, CLI_REL), 'utf8')
  } catch {
    return { problems: [`读不到 ${CLI_REL}（路径变了？这条判据要跟着改）`], info, known: new Set() }
  }
  const known = knownFlagsFrom(cli)

  /** 文档里提到、但**不是命令行参数**的东西（表格里的占位符之类） */
  const IGNORE = new Set([])

  for (const rel of DOCS) {
    let txt = ''
    try {
      txt = readFileSync(path.join(root, rel), 'utf8')
    } catch {
      problems.push(`${rel}: 文件不存在（文档改名了？这条判据要跟着改）`)
      continue
    }
    const section = flagSection(txt)
    if (section === null) {
      problems.push(`${rel}: 找不到"参数参考"章节（标题改了？正则要跟着改）`)
      continue
    }
    for (const m of section.matchAll(/`--([a-z][\w-]*)/g)) {
      const flag = m[1]
      if (IGNORE.has(flag) || known.has(flag)) continue
      problems.push(`${rel}: 参数表里写了 --${flag}，但 ${CLI_REL} 不认这个参数`)
    }
  }

  const undocumented = [...known].filter((f) => !['h', 'help', 'v', 'version', 'machine', 'machine-cert', 'plugin', 'plugins', 'dry-run'].includes(f))
  for (const rel of DOCS) {
    let txt = ''
    try { txt = readFileSync(path.join(root, rel), 'utf8') } catch { continue }
    for (const f of undocumented) {
      if (!txt.includes(`--${f}`)) info.push(`  （提示）${rel} 里没提到 --${f}（可能是有意不写，例如安装/构建用的）`)
    }
  }
  return { problems, info, known }
}

// ── CLI ──────────────────────────────────────────────────────

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  const root = argOf(process.argv.slice(2), 'root', ROOT)
  const { problems, info, known } = auditDocFlags(root)
  for (const line of info) console.log(line)
  if (problems.length) {
    console.error('✗ 文档与命令行的参数对不上：')
    for (const p of problems) console.error(`   ${p}`)
    console.error('  改法：要么在 bin/flicker.js 里真的实现它，要么把文档改对（不要留着不存在的参数）')
    process.exit(1)
  }
  console.log(`✓ 文档参数表里的参数程序都认（共 ${known.size} 个已知参数）`)
}
