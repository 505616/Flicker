/**
 * 一次性体检：把所有文档里标着"没做/未做/待做/未验证"的条目捞出来
 * ================================================================
 * 用户问"没做的就剩下那几个了是吧"，所以要**从文档里逐条捞**，不能凭记忆答。
 *
 * 判据：一行里同时出现 [❌|⏳|还没做|未做|未实现|待做|未验证|not done|not implemented|to do|unverified]
 * 就打印出来，连同文件与行号，人工再过一遍。
 *
 * 用法：node _lab/audit-todo-markers.mjs
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MARK = /(❌|⏳|还没做|未做|未实现|待做|未验证|未实测|尚未|not done|not implemented|to do|unverified|not yet)/
const FILES = []
for (const d of ['', '中文文档', 'docs', '_lab', '.github']) {
  const dir = path.join(ROOT, d)
  let entries = []
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
  for (const e of entries) {
    if (!e.isFile()) continue
    if (!/\.(md|yml)$/.test(e.name)) continue
    if (d === '_lab' && !e.name.endsWith('.md')) continue
    FILES.push(path.join(d, e.name))
  }
}
// 根目录只关心那几份正式文档
const ROOT_DOCS = ['读我.md', 'README.md', '变更记录.md', 'CHANGELOG.md']
const list = FILES.filter((f) => {
  const dir = path.dirname(f)
  if (dir !== '.') return true
  return ROOT_DOCS.includes(path.basename(f))
}).sort()

let n = 0
for (const rel of list) {
  const lines = readFileSync(path.join(ROOT, rel), 'utf8').split('\n')
  lines.forEach((l, i) => {
    if (!MARK.test(l)) return
    const t = l.trim()
    if (t.length < 8) return
    n++
    console.log(`${rel}:${i + 1}  ${t.slice(0, 190)}`)
  })
}
console.log(`\n共 ${n} 行命中（${list.length} 个文档）`)
