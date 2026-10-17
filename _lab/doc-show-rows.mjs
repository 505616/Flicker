/**
 * 打印某一节的"被计数的表格行"，用于查配对计数差在哪一行
 * 用法：node _lab/doc-show-rows.mjs 中文文档/PROTOCOL.md "### 6.1"
 */
import { readFileSync } from 'node:fs'

const [file, heading] = process.argv.slice(2)
const lines = readFileSync(file, 'utf8').split('\n')
let inSection = false
let inFence = false
let n = 0
for (let i = 0; i < lines.length; i++) {
  const l = lines[i]
  if (l.trimStart().startsWith('```')) { inFence = !inFence; continue }
  if (inFence) continue
  if (l.startsWith('### ') || l.startsWith('#### ')) {
    if (l.startsWith(heading)) { inSection = true; console.log(`── ${l}`); continue }
    if (inSection) break
  }
  if (inSection && /^\s*\|.*\|\s*$/.test(l)) {
    n++
    console.log(String(n).padStart(3), String(i + 1).padStart(5), l.slice(0, 90))
  }
}
console.log(`\n共 ${n} 行被计数`)
