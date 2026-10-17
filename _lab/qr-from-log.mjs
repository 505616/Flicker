// 把终端里那份"半格字符"二维码还原成矩阵，再用正方形方式重画
// ============================================================
// 为什么需要它：src/tty.js 的 qrLines() 为了省屏幕空间，把**两行模块并成一行**，
// 用 ▀▄█ 三个半格字符表示。这在终端里没问题（行距紧），但贴到聊天窗口里会被
// 竖向拉伸，手机多半扫不出来。
//
// 做法：把半格字符反解回 0/1 矩阵（█→上下都黑、▀→上黑、▄→下黑、空格→都白），
// 再用"一个模块 = 两个字符"重画（'██' / '  '）—— 这样模块在网页里接近正方形，
// 四周再补一圈白边（扫码需要静区）。
//
// 用法：node _lab/qr-from-log.mjs _lab/out/phone-send2.log
import { readFileSync } from 'node:fs'

const file = process.argv[2] ?? '_lab/out/phone-send2.log'
let text = readFileSync(file, 'utf8')

// 去掉 ANSI 颜色，统一换行；只保留"由二维码字符组成"的行
//
// ⚠️ 必须先处理 CRLF：Windows 上重定向出来的日志每行结尾是 `\r\n`，
//    不剥掉 \r 的话 `^[█▀▄ ]+$` 永远匹配不上（第一版就是这么"没找到二维码"的）。
text = text.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r\n?/g, '\n')
const QR_CHARS = /^[█▀▄ ]+$/
const rows = []
for (const raw of text.split('\n')) {
  // 去掉可能的框线（│ … │）与两侧空白
  let line = raw.replace(/[│|]/g, '')
  if (!QR_CHARS.test(line)) continue
  if (!/[█▀▄]/.test(line)) continue          // 纯空白行不算
  rows.push(line)
}

if (rows.length < 8) {
  console.error(`在 ${file} 里没找到二维码（找到 ${rows.length} 行候选）`)
  process.exit(1)
}

// 左右按最宽的一行对齐（二维码本体是等宽的，框线去掉了就对得齐）
const width = Math.max(...rows.map((r) => [...r].length))
const matrix = []
for (const line of rows) {
  const chars = [...line]
  while (chars.length < width) chars.push(' ')
  const top = []
  const bot = []
  for (const ch of chars) {
    if (ch === '█') { top.push(1); bot.push(1) }
    else if (ch === '▀') { top.push(1); bot.push(0) }
    else if (ch === '▄') { top.push(0); bot.push(1) }
    else { top.push(0); bot.push(0) }
  }
  matrix.push(top, bot)
}

// 裁掉四周多余的白边，再补一圈 2 模块的静区
const isBlack = (r, c) => matrix[r]?.[c] === 1
let top = 0, bottom = matrix.length - 1, left = 0, right = width - 1
while (top < bottom && !matrix[top].some((v) => v)) top++
while (bottom > top && !matrix[bottom].some((v) => v)) bottom--
while (left < right && !matrix.slice(top, bottom + 1).some((row) => isBlack(matrix.indexOf(row), left))) left++
while (right > left && !matrix.slice(top, bottom + 1).some((row) => isBlack(matrix.indexOf(row), right))) right--

const QUIET = 2
const size = bottom - top + 1 + QUIET * 2
const out = []
for (let i = 0; i < size; i++) {
  let line = ''
  for (let j = 0; j < size; j++) {
    const r = top + i - QUIET
    const c = left + j - QUIET
    const black = r >= top && r <= bottom && c >= left && c <= right && matrix[r][c] === 1
    line += black ? '██' : '  '
  }
  out.push(line)
}

console.log(`二维码模块：${bottom - top + 1}×${bottom - top + 1}（含静区 ${size}×${size}，共 ${out.length} 行）`)
console.log('\n' + out.join('\n'))
