/**
 * 中英文文档**配对**检查
 * ======================
 *
 * 用户的要求：文档做两份，一份中文一份英文，分两个文件夹（`中文文档/` 与 `docs/`）。
 *
 * ── 为什么必须机器来守 ──
 * "两份文档"天生会漂移：中文改了一句、英文忘了跟，谁也不会发现 ——
 * 中文读者看中文，英文读者看英文，**没有任何一个人会同时读两份**。
 * 这与本项目反复吃亏的"两份实现"是同一类问题，所以用同一个办法：
 * 把判据写成机器检查。
 *
 * 检查三件事：
 *   ① 文件名一一对应（中文文件夹里的每个 .md，英文文件夹里都要有同名的）
 *   ② 结构一致（`#`/`##`/`###` 标题的**数量**、代码围栏的数量、表格行数一致）——
 *      译文可以改措辞，但不该删章节、不该丢代码块
 *   ③ 两边的相对链接都指向真实存在的文件（这一条由 check-doc-links.mjs 负责）
 *
 * ⚠️ 刻意**不**比较正文行数：译文长短本来就会差，卡行数只会逼人凑字数。
 *    结构一致 + 链接有效，才是"两份内容对得上"的合理近似。
 *
 * 判据逻辑抽成 `comparePairDocs({ zhDir, enDir, rootPairs, root })` 与
 * `structureOf(src)`（纯函数），CLI 只负责挑目录与打印 ——
 * `test/doc-pairs.test.js` 用它反过来验（少一份 / 少一个标题 / 少一个表格行、
 * 少一个代码围栏，四种漂移都要被抓到）。
 *
 * 万一这条失败（两边标题/围栏/表格行数对不上），别靠数行去猜 ——
 * `_lab/` 里有两个只读的排查小工具，按**出现顺序**把两边逐节摆出来：
 *
 *   node _lab/doc-section-counts.mjs 中文文档/PROTOCOL.md docs/PROTOCOL.md
 *       → 每节的表格行数与围栏数差在哪一节（标题是译文，所以按顺序配对）
 *   node _lab/doc-show-rows.mjs docs/PROTOCOL.md "### 6.1"
 *       → 打印某一节里"被计数的表格行"，逐行看是哪一行多/少了
 *
 * 用法：node gen/check-doc-pairs.mjs [--root=<另一棵树>]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 从 `--key=value` 里取值（测试注入坏掉的副本用） */
export function argOf(argv, name, fallback) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

/**
 * 根目录下也有一对"中文名 / 英文名"的文件。
 *
 * 它们刻意不放进文件夹：位置本身就是信息 —— `变更记录.md` 与 `CHANGELOG.md`
 * 是**发布物料**（与两份 README 并列），不是手册。
 * 代价是文件夹那套一一对应的检查管不到它们，所以在这里显式列出，
 * 用**同一个** structure() 比结构。漏一个就会悄悄漂。
 */
export const ROOT_PAIRS = [
  ['变更记录.md', 'CHANGELOG.md'],
  // 2026-10 作者要求把「原始需求以及作者的话」放到根目录（中英各一份）
  ['原始需求以及作者的话.md', 'AUTHOR-NOTES.md'],
]

/** 一份文档的结构指纹：标题层级数量、代码围栏数、表格行数 */
export function structureOf(src) {
  const lines = src.split('\n')
  let h1 = 0, h2 = 0, h3 = 0, fences = 0, tableRows = 0, inFence = false
  for (const l of lines) {
    if (l.trimStart().startsWith('```')) { fences++; inFence = !inFence; continue }
    if (inFence) continue
    if (/^# /.test(l)) h1++
    else if (/^## /.test(l)) h2++
    else if (/^### /.test(l)) h3++
    if (/^\s*\|.*\|\s*$/.test(l)) tableRows++
  }
  return { h1, h2, h3, fences, tableRows }
}

/** 比两个结构指纹，返回问题清单（空 = 一致） */
export function compareStructures(label, a, b) {
  const problems = []
  const cmp = (key, what) => {
    if (a[key] !== b[key]) {
      problems.push(`${label}：${what}数量不一致（中文 ${a[key]} / 英文 ${b[key]}）—— ` +
        '译文可以改措辞，但不该删章节、丢代码块或漏掉表格行')
    }
  }
  cmp('h1', '一级标题')
  cmp('h2', '二级标题')
  cmp('h3', '三级标题')
  cmp('fences', '代码围栏')
  cmp('tableRows', '表格行')
  return problems
}

/**
 * 核一棵树里的两份文档。
 * @param {{root?:string, zhDir?:string, enDir?:string, rootPairs?:Array<[string,string]>}} [opts]
 * @returns {{problems:string[], zhFiles:string[], enFiles:string[]}}
 */
export function comparePairDocs(opts = {}) {
  const root = opts.root ?? ROOT
  const zhDir = opts.zhDir ?? path.join(root, '中文文档')
  const enDir = opts.enDir ?? path.join(root, 'docs')
  const rootPairs = opts.rootPairs ?? ROOT_PAIRS
  const problems = []

  if (!existsSync(zhDir)) problems.push('找不到中文文档/ —— 中文文档应当都在这个文件夹里')
  if (!existsSync(enDir)) problems.push('找不到 docs/ —— 英文文档应当都在这个文件夹里')
  if (problems.length) return { problems, zhFiles: [], enFiles: [] }

  const md = (dir) => readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
  const zhFiles = md(zhDir)
  const enFiles = md(enDir)

  // ① 一一对应
  for (const f of zhFiles) {
    if (!enFiles.includes(f)) {
      problems.push(`中文文档/${f} 没有对应的英文版 —— 英文读者看不到这一份（应当在 docs/${f}）`)
    }
  }
  for (const f of enFiles) {
    if (!zhFiles.includes(f)) {
      problems.push(`docs/${f} 没有对应的中文版（应当在 中文文档/${f}）`)
    }
  }

  // ② 结构一致
  for (const f of zhFiles.filter((x) => enFiles.includes(x))) {
    problems.push(...compareStructures(
      f,
      structureOf(readFileSync(path.join(zhDir, f), 'utf8')),
      structureOf(readFileSync(path.join(enDir, f), 'utf8')),
    ))
  }

  // ③ 根目录的那几对（同样比结构）
  for (const [zh, en] of rootPairs) {
    const zhPath = path.join(root, zh)
    const enPath = path.join(root, en)
    if (!existsSync(zhPath)) { problems.push(`根目录缺少 ${zh}（发布物料）`); continue }
    if (!existsSync(enPath)) { problems.push(`根目录缺少 ${en}（${zh} 的英文版）`); continue }
    problems.push(...compareStructures(`${zh} ↔ ${en}`,
      structureOf(readFileSync(zhPath, 'utf8')),
      structureOf(readFileSync(enPath, 'utf8'))))
  }

  return { problems, zhFiles, enFiles }
}

// ── CLI ──────────────────────────────────────────────────────

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  const root = argOf(process.argv.slice(2), 'root', ROOT)
  const { problems, zhFiles } = comparePairDocs({ root })
  if (problems.length) {
    for (const p of problems) console.error(`✗ ${p}`)
    console.error(`\n${problems.length} 处中英文文档不配对`)
    process.exit(1)
  }
  console.log(`✓ 中英文文档一一对应且结构一致（两个文件夹各 ${zhFiles.length} 份` +
    ` + 根目录 ${ROOT_PAIRS.length} 对）`)
}
