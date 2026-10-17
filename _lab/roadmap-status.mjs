/**
 * 统计路线图的完成情况。
 *
 * 为什么要单写一个脚本：状态判断看着简单，但表格里有划掉的项（`~~5b~~`）、
 * 有"部分完成"的项（限速做了、大文件内存优化没做），还有混杂在文档里的
 * **性能数据表**（那些行的第一列是数字，会被误当成待办项编号）。
 * 手写正则容易两头出错 —— 我第一版就把已完成的项全标成了未完成。
 *
 * 用法：node _lab/roadmap-status.mjs
 */
import { readFileSync } from 'node:fs'

const lines = readFileSync('中文文档/路线图.md', 'utf8').split('\n')

/** 只在这些顶层章节里找待办项（避免把性能数据表也算进来） */
const SECTIONS = /^## [一二三]、/
/** 形如 `| 12 | ... |` 或 `| ~~5b~~ | ... |` 或 `| **9b** | ... |` */
const ROW = /^\|\s*(~~)?\s*\*{0,2}(\d+[a-z]?)\*{0,2}\s*(~~)?\s*\|(.*)$/

let section = ''
const items = []
for (const line of lines) {
  if (/^## /.test(line)) { section = SECTIONS.test(line) ? line.slice(3) : '' ; continue }
  if (!section) continue
  const m = line.match(ROW)
  if (!m) continue

  const struck = Boolean(m[1] || m[3])          // 划掉 = 已完成
  const rest = m[4]
  // 状态判断要处理"部分完成"：第 9 项是"限速 ✅ + 大文件内存优化 ❌"，
  // 只看有没有 ✅ 会把它当成全做完，漏掉剩下那半。
  const hasTodo = /仍待做|还没做|仍待|待做/.test(rest)
  const done = (struck || /✅/.test(rest)) && !hasTodo
  const doing = !done && (/⏳/.test(rest) || hasTodo)
  // 项目名：第一列的下一列
  const cells = rest.split('|').map((s) => s.trim())
  const name = (cells[0] ?? '').replace(/\*+/g, '').replace(/~~/g, '')
  if (!name || /^\d/.test(name) || /MB\/s/.test(name)) continue   // 排除数字列

  items.push({ id: m[2], name, state: done ? 'done' : doing ? 'doing' : 'todo', section })
}

const groups = {}
for (const it of items) (groups[it.section] ||= []).push(it)

let totalDone = 0
let total = 0
for (const [sec, list] of Object.entries(groups)) {
  const done = list.filter((x) => x.state === 'done').length
  totalDone += done; total += list.length
  console.log(`\n【${sec}】${done}/${list.length} 完成`)
  for (const it of list) {
    const mark = it.state === 'done' ? '✅' : it.state === 'doing' ? '⏳' : '❌'
    console.log(`  ${mark} ${it.id.padStart(3)}  ${it.name.slice(0, 46)}`)
  }
}
console.log(`\n合计 ${totalDone}/${total} 完成，剩 ${total - totalDone} 项` +
  (items.some((x) => x.state === 'doing')
    ? `（其中 ${items.filter((x) => x.state === 'doing').length} 项做了一半）` : ''))

const todo = items.filter((x) => x.state !== 'done')
console.log('\n还没做的：')
for (const it of todo) console.log(`  ${it.state === 'doing' ? '⏳' : '❌'} ${it.id}  ${it.name}`)
