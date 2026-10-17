// 用**项目自己的二维码编码器**把链接画成"聊天窗口里也能扫"的二维码
// ==================================================================
// 为什么不用终端那份：`src/tty.js` 的 qrLines() 把两行模块并成一行（用 ▀▄█ 半格字符）
// 来省屏幕空间。终端行距紧，没问题；但贴到网页/聊天窗口里会被竖向拉伸，手机多半扫不出来。
//
// 这里改用 `BROWSER_QR_SOURCE`（**图形界面用的同一份编码器**，由 tty.js 导出）
// 直接编码链接，然后一个模块画成两个字符（'██' / '  '）—— 模块在网页里接近正方形。
//
// 用法：node _lab/qr-square.mjs <链接>
import { BROWSER_QR_SOURCE } from '../src/tty.js'

const url = process.argv[2]
if (!url) {
  console.error('用法：node _lab/qr-square.mjs "https://…"')
  process.exit(2)
}

// 图形界面就是这么用它的：eval 之后拿到 QR
const QR = new Function(`${BROWSER_QR_SOURCE}\nreturn QR`)()
const m = QR.encode(url)
if (!m || !m.length) {
  console.error('编码失败（链接太长？）')
  process.exit(1)
}
const n = m.length
if (!m.every((row) => row.length === n)) {
  console.error('矩阵不是正方形 —— 编码器输出异常')
  process.exit(1)
}

// 三个角上的"定位图案"（7×7）必须存在 —— 这是二维码能被扫到的前提，
// 顺便也证明矩阵没被写反/截断。
const finder = (r0, c0) =>
  m[r0][c0] === 1 && m[r0][c0 + 6] === 1 && m[r0 + 6][c0] === 1 &&
  m[r0 + 1][c0 + 1] === 0 && m[r0 + 3][c0 + 3] === 1
if (!(finder(0, 0) && finder(0, n - 7) && finder(n - 7, 0))) {
  console.error('定位图案不对 —— 矩阵有问题，先别拿去扫')
  process.exit(1)
}

/**
 * 两种画法，选哪种取决于贴到哪里：
 *   · `--half`（默认）：**一个模块一个字符**，用 ▀▄█ 把两行并成一行。
 *     在网页/聊天窗口里，一个文本格约 0.6em 宽 × 1.2em 高，装两个模块正好是**正方形**，
 *     而且只有 33 个字符宽 —— 不会被自动换行弄坏。**推荐贴聊天用这个。**
 *   · `--square2`：一个模块两个字符（'██'）。模块也是正方形，但要 66 字符宽，
 *     窄窗口里可能被折行 —— 折了就扫不出来。
 */
const MODE = process.argv.includes('--square2') ? 'square2' : 'half'

const QUIET = 2                      // 静区：扫码需要一圈白边
const size = n + QUIET * 2
const black = (r, c) => r >= 0 && r < n && c >= 0 && c < n && m[r][c] === 1
const lines = []

if (MODE === 'half') {
  for (let i = 0; i < size; i += 2) {
    let line = ''
    for (let j = 0; j < size; j++) {
      const top = black(i - QUIET, j - QUIET)
      const bot = black(i + 1 - QUIET, j - QUIET)
      line += top && bot ? '█' : top ? '▀' : bot ? '▄' : ' '
    }
    lines.push(line)
  }
} else {
  for (let i = 0; i < size; i++) {
    let line = ''
    for (let j = 0; j < size; j++) line += black(i - QUIET, j - QUIET) ? '██' : '  '
    lines.push(line)
  }
}

console.error(`模块 ${n}×${n}；画法 ${MODE}；输出 ${lines.length} 行 × ${[...lines[0]].length} 字符`)
console.log(lines.join('\n'))
