/**
 * 中英文文档逐节计数对比（只在排查配对失败时用）
 * 用法：node _lab/doc-section-counts.mjs 中文文档/PROTOCOL.md docs/PROTOCOL.md
 */
import { readFileSync } from 'node:fs'

function sections(file) {
  const lines = readFileSync(file, 'utf8').split('\n')
  const out = []
  let cur = { h: '(前言)', rows: 0, fences: 0 }
  let inF = false
  for (const l of lines) {
    if (l.trimStart().startsWith('```')) { cur.fences++; inF = !inF; continue }
    if (inF) continue
    if (/^### /.test(l)) { out.push(cur); cur = { h: l, rows: 0, fences: 0 }; continue }
    if (/^\s*\|.*\|\s*$/.test(l)) cur.rows++
  }
  out.push(cur)
  return out
}

const [zf, ef] = process.argv.slice(2)
// 标题文字两边是译文，不能当键 —— 按**出现顺序**配对（两边章节顺序一致）
const a = sections(zf)
const b = sections(ef)
if (a.length !== b.length) {
  console.log(`⚠️ 章节数不同：中文 ${a.length} / 英文 ${b.length}`)
}
console.log('en  zh  dRows 第几节  英文标题')
for (let i = 0; i < Math.max(a.length, b.length); i++) {
  const s = b[i] ?? { h: '(英文缺这一节)', rows: -1, fences: -1 }
  const m = a[i]
  const dr = m && m.rows >= 0 ? m.rows - s.rows : '?'
  const df = m && m.fences >= 0 ? m.fences - s.fences : '?'
  const clean = m && m.rows === s.rows && m.fences === s.fences
  console.log(
    String(s.rows).padStart(3), String(m ? m.rows : '-').padStart(3),
    String(dr).padStart(5), String(df).padStart(4), ' ',
    String(i).padStart(3), ' ', (s.h.replace(/^### /, '') || '(前言)').slice(0, 40),
    clean ? '' : '   <<< 不一致',
  )
}
const ta = a.reduce((n, s) => n + s.rows, 0)
const tb = b.reduce((n, s) => n + s.rows, 0)
console.log(`\n表格行合计：中文 ${ta} / 英文 ${tb}`)
