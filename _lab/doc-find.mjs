/**
 * 在某一节里按正则找行（排查中英文内容是否对齐时用）
 * 用法：node _lab/doc-find.mjs docs/PROTOCOL.md "### 6.2" "rel|path"
 */
import { readFileSync } from 'node:fs'

const [file, heading, pattern] = process.argv.slice(2)
const re = new RegExp(pattern)
const lines = readFileSync(file, 'utf8').split('\n')

let from = -1
let to = lines.length
for (let i = 0; i < lines.length; i++) {
  if (/^#{3,4} /.test(lines[i])) {
    if (from < 0) { if (lines[i].startsWith(heading)) from = i }
    else { to = i; break }
  }
}
if (from < 0) { console.error(`找不到节 ${heading}`); process.exit(1) }
console.log(`── ${lines[from]}  (${from + 1}-${to})`)
let n = 0
for (let k = from; k < to; k++) {
  if (re.test(lines[k])) { n++; console.log(String(k + 1).padStart(5), lines[k].slice(0, 160)) }
}
console.log(`共 ${n} 行命中`)
