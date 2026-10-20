/**
 * 文档结构体检：确认编辑过的 .md 没有把结构弄坏。
 *
 * 为什么需要：文档里加了 <details> 和代码块之后，最容易出的问题是
 * ① 代码围栏落单（后半篇全变成代码块）② <details> 没闭合 ③ 表格列数乱掉。
 * 这类问题在渲染前肉眼很难发现，机器一查就出来。
 *
 * 判据逻辑抽成 `auditDocStructure(files)`（纯函数：给一串路径，回来一堆问题），
 * CLI 只负责挑默认文件列表并打印 —— 这样 `test/doc-structure.test.js` 能拿几条
 * 故意写坏的临时文档反过来验它（围栏落单 / details 不配对 / 列数不一致必须被抓到，
 * 而 `\|` 与行内代码里的竖线不许误报）。
 *
 * 用法：
 *   node _lab/check-docs.mjs              # 体检默认那批文档
 *   node _lab/check-docs.mjs a.md b.md    # 只体检这几份（路径相对当前目录）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(HERE, '..')

/**
 * 默认要体检的文档。
 * 两个 README 在根目录（中文叫「读我」、英文叫 README）；
 * 其余文档分中英文两个文件夹 —— 结构由用户指定，命名由 gen/check-doc-pairs.mjs 守。
 */
export const DEFAULT_FILES = [
  '读我.md', 'README.md',
  '中文文档/SECURITY.md', '中文文档/使用手册.md', '中文文档/手机使用指南.md', '中文文档/行为与运行.md',
  '中文文档/设计文档.md', '中文文档/架构决策.md', '中文文档/PROTOCOL.md',
  '中文文档/中继部署.md', '中文文档/路线图.md', '中文文档/构建单文件.md',
  '中文文档/UI设计.md',
  'docs/SECURITY.md', 'docs/使用手册.md', 'docs/手机使用指南.md', 'docs/行为与运行.md',
  'docs/设计文档.md', 'docs/架构决策.md', 'docs/PROTOCOL.md',
  'docs/中继部署.md', 'docs/路线图.md', 'docs/构建单文件.md',
  'docs/UI设计.md',
]

const FENCE = '```'

/**
 * 体检一批文档。
 * @param {string[]} files 文件路径（相对 root 或绝对）
 * @param {{root?:string}} [opts]
 * @returns {{problems:Array<{file:string,message:string}>, missing:string[], checked:number}}
 */
export function auditDocStructure(files = DEFAULT_FILES, { root = process.cwd() } = {}) {
  const problems = []
  const missing = []
  let checked = 0

  for (const rel of files) {
    const full = path.isAbsolute(rel) ? rel : path.join(root, rel)
    if (!fs.existsSync(full)) { missing.push(rel); continue }
    checked++
    const s = fs.readFileSync(full, 'utf8')
    const lines = s.split('\n')
    const add = (message) => problems.push({ file: rel, message })

    // ① 代码围栏成对
    const fences = lines.filter((l) => l.trimStart().startsWith(FENCE)).length
    if (fences % 2 !== 0) add(`代码围栏落单（${fences} 个）`)

    // ② <details> / <summary> 配对
    const open = (s.match(/<details>/g) ?? []).length
    const close = (s.match(/<\/details>/g) ?? []).length
    if (open !== close) add(`<details> 不配对（开 ${open} 关 ${close}）`)

    // ③ 表格：连续的 | 行块里，列数应一致
    //
    // ⚠️ 必须先去掉**转义竖线** `\|` 和**行内代码**里的竖线。
    //    否则像 `netstat -ano \| findstr` 或 `` `CON|PRN` `` 这样的单元格
    //    会被误数成多一列 —— 第一版检查器就是这么误报了 3 处。
    const countCols = (line) => line.trim()
      .replace(/`[^`]*`/g, '`x`')      // 行内代码整体视为一个原子
      .replace(/\\\|/g, '\u0001')      // 转义竖线先藏起来
      .split('|').length
    let inTable = false, cols = 0, startLine = 0
    lines.forEach((l, i) => {
      const isRow = l.trim().startsWith('|') && l.trim().endsWith('|')
      if (isRow) {
        const n = countCols(l)
        if (!inTable) { inTable = true; cols = n; startLine = i + 1 }
        else if (n !== cols) add(`表格列数不一致（第 ${startLine} 行起 ${cols} 列，第 ${i + 1} 行 ${n} 列）`)
      } else { inTable = false }
    })
  }
  return { problems, missing, checked }
}

// ── CLI ──────────────────────────────────────────────────────

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const args = process.argv.slice(2)
  const files = args.length ? args : DEFAULT_FILES
  const { problems, missing } = auditDocStructure(files, { root: process.cwd() })

  for (const f of missing) console.log('－ 跳过（不存在）', f)
  for (const rel of files) {
    if (missing.includes(rel)) continue
    const own = problems.filter((p) => p.file === rel)
    if (own.length) {
      console.log('✖', rel)
      for (const p of own) console.log('   ·', p.message)
    } else {
      console.log('✓', rel)
    }
  }
  console.log(problems.length ? `\n${new Set(problems.map((p) => p.file)).size} 个文件有问题` : '\n全部通过')
  process.exit(problems.length ? 1 : 0)
}
