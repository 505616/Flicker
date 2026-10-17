/**
 * 把图标形状光栅化成字符画，好在终端里肉眼确认。
 *
 * 为什么需要：测试能验"图形落在安全区内""尺寸正确"，但验不了
 * **它看起来是不是一道闪电**。顶点坐标打出来是一堆数字，
 * 而一个画错的形状（比如顶点顺序乱了、自己交叉）在数字上完全看不出来。
 *
 * 这不是像素级渲染，只是对顶点做点内多边形测试 —— 够用来确认形状。
 *
 * 用法：node _lab/preview-icon.mjs [any|maskable]
 */
import { boltPoints, GLYPH_SCALE } from '../gen/pwa-assets.mjs'

const which = process.argv[2] === 'maskable' ? 'maskable' : 'any'
const scale = GLYPH_SCALE[which]
const W = 56, H = 28

/** 点是否在多边形内（射线法） */
function inPoly(px, py, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j]
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

// 归一化坐标 → 画布坐标（中心 0.5，glyph 边长 scale）
const poly = boltPoints().map(([dx, dy]) => [0.5 + dx * scale, 0.5 + dy * scale])

console.log(`\n图标形状预览（${which}，图形占边长 ${(scale * 100).toFixed(0)}%）`)
if (which === 'maskable') {
  // 画出 Android 圆形裁切的边界，看图形会不会被切到
  console.log('  ╭─ 虚线内是 Android 保证可见的圆形区域（直径 80%）\n')
} else {
  console.log('')
}

const safeR = 0.40
for (let r = 0; r < H; r++) {
  let line = ''
  for (let c = 0; c < W * 0.5; c++) {
    // 字符是高的，所以横向压缩一半
    const x = (c + 0.5) / (W * 0.5)
    const y = (r + 0.5) / H
    const dist = Math.hypot(x - 0.5, y - 0.5)
    if (inPoly(x, y, poly)) line += '█'
    else if (which === 'maskable' && Math.abs(dist - safeR) < 0.012) line += '·'
    else line += ' '
  }
  console.log('  ' + line)
}
console.log('')
