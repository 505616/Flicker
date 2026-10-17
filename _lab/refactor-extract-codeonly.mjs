// 一次性重构：把 gen/inline-path-rules.mjs 里的 codeOnly() 抽到 gen/code-only.mjs
// （页面插件的内联脚本也要用它，两份实现迟早会漂，而漂的那份会漏检）
import { readFileSync, writeFileSync } from 'node:fs'

const FILE = 'gen/inline-path-rules.mjs'
const s = readFileSync(FILE, 'utf8')

const start = s.indexOf('function codeOnly(src) {')
const end = s.indexOf('function buildBlock()')
if (start < 0 || end < 0 || end < start) throw new Error(`锚点没找到 start=${start} end=${end}`)
// 连它上面那段文档注释一起删
const docStart = s.lastIndexOf('/**', start)
const from = docStart >= 0 && docStart > end - 4000 ? docStart : start
const removed = s.slice(from, end)
if (!/tpl/.test(removed) || !/state/.test(removed)) throw new Error('要删的那一段里没看到状态机实现')

let out = s.slice(0, from) + s.slice(end)
const importLine = "import { fileURLToPath } from 'node:url'"
if (!out.includes(importLine)) throw new Error('找不到 import 锚点')
out = out.replace(importLine, importLine + "\nimport { codeOnly } from './code-only.mjs'")

writeFileSync(FILE, out)
console.log(`删掉 ${removed.length} 字符，改为从 gen/code-only.mjs 引入 codeOnly`)
