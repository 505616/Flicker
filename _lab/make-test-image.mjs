// 生成一张真的 PNG 用来测手机接收（项目零依赖，所以手写最小 PNG）
// 用法：node _lab/make-test-image.mjs [宽] [高] [输出路径]
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const W = Number(process.argv[2] ?? 900)
const H = Number(process.argv[3] ?? 600)
const out = path.resolve(process.argv[4] ?? '_lab/out/phone-test.png')

// ── CRC32（PNG 每个块都要）──
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

// ── 一张彩色渐变 + 棋盘格，肉眼一看就知道图是完整的 ──
const raw = Buffer.alloc(H * (1 + W * 3))
let p = 0
for (let y = 0; y < H; y++) {
  raw[p++] = 0                                  // 每行的 filter 字节
  for (let x = 0; x < W; x++) {
    const checker = ((x >> 5) + (y >> 5)) % 2 === 0
    raw[p++] = Math.round((x / W) * 255)                 // R：横向渐变
    raw[p++] = Math.round((y / H) * 255)                 // G：纵向渐变
    raw[p++] = checker ? 220 : Math.round(((x + y) / (W + H)) * 255)  // B：棋盘 + 对角
  }
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4)
ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

mkdirSync(path.dirname(out), { recursive: true })
writeFileSync(out, png)
console.log(`  ✓ ${out}  ${W}×${H}  ${(png.length / 1024).toFixed(1)} KB`)
