/**
 * 二维码编码器（`src/tty.js` 里的 QR）必须**真的能扫出来**
 * ====================================================
 * 2026-10 用户实测："手机扫二维码根本没反应，识别不出这是个二维码"（浏览器和微信都试过）。
 *
 * ── 查出来的三个 bug（都是"结构看着正常、数据全错"那种）──
 *   ① **版本表填错**：`groups` 里填的是"每块总码字数"，代码却当成"数据码字数"用，
 *      于是数据区多塞了纠错码字、超出部分被静默截断；
 *   ② **暗模块写错位置**：写到 `(size-8, 8)`，而标准是 `(8, size-8)` ——
 *      正好覆盖掉格式信息副本 B 的第 7 位，两份副本对不上；
 *   ③ **格式信息按低位先写**：坐标表第 i 位应放 15 位值的第 (14-i) 位。写反了，
 *      解码器读到的 EC 等级/掩码全是错的（于是永远解不出来）。
 *
 * 这三个都**看不出**：定位图案、定时图案、格式图案全都"像那么回事"，
 * 只有真正按规范读一遍才能发现。所以这条判据自带一个小解码器（纯 JS、零依赖），
 * 把编码结果**读回原文**。
 *
 * ⚠️ 解码器不是"照着编码器反着写"就行（那样两个对称的 bug 会互相抵消 ——
 *    上面 ③ 的第一版就是这么漏掉的）。它是按规范写的，并且**用 OpenCV 生成的
 *    参考二维码校准过**：同一份读法能解出 OpenCV 的码（`_lab` 里的排查脚本），
 *    再拿来读我们的码。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BROWSER_QR_SOURCE, qrMatrixTerminal } from '../src/tty.js'

// ── 编码器（浏览器那一份模板；终端那份逻辑相同）──
const QR = new Function(`${BROWSER_QR_SOURCE}\nreturn { qrMatrix };`)()

// ── 规范表（EC level M）──
const BLOCKS = {
  1: [[1, 16]], 2: [[1, 28]], 3: [[1, 44]], 4: [[2, 32]], 5: [[2, 43]],
  6: [[4, 27]], 7: [[4, 31]], 8: [[2, 38], [2, 39]], 9: [[3, 36], [2, 37]],
  10: [[4, 43], [1, 44]],
}
const EC_LEN = { 1: 10, 2: 16, 3: 26, 4: 18, 5: 24, 6: 16, 7: 18, 8: 22, 9: 22, 10: 26 }
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
}

// GF(256)（多项式 0x11d，QR 用的就是这个）
const EXP = new Array(512).fill(0)
const LOG = new Array(256).fill(0)
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x = (x << 1) ^ (x & 0x80 ? 0x11d : 0) }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
const gmul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]])

/** 按规范读一个二维码矩阵；返回 {text, version, format} */
function decodeMatrix(m) {
  const size = m.length
  const version = (size - 17) / 4
  assert.ok(Number.isInteger(version), `尺寸 ${size} 不是合法的二维码尺寸`)

  const isFunc = (r, c) => {
    if (r < 9 && c < 9) return true
    if (r < 9 && c >= size - 8) return true
    if (r >= size - 8 && c < 9) return true
    if (r === 6 || c === 6) return true
    // v7 起的版本信息块（两块 6×3）也是功能区
    if (version >= 7) {
      if (r < 6 && c >= size - 11 && c < size - 8) return true
      if (c < 6 && r >= size - 11 && r < size - 8) return true
    }
    for (const ar of ALIGN[version]) {
      for (const ac of ALIGN[version]) {
        if ((ar <= 8 && ac <= 8) || (ar <= 8 && ac >= size - 9) || (ar >= size - 9 && ac <= 8)) continue
        if (Math.abs(r - ar) <= 2 && Math.abs(c - ac) <= 2) return true
      }
    }
    return false
  }

  // 格式信息：**高位在前**（第 i 个位置 = 15 位值的第 14-i 位）
  const copyA = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8],
    [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ]
  const copyB = [
    ...Array.from({ length: 8 }, (_, i) => [size - 1 - i, 8]),
    ...Array.from({ length: 7 }, (_, i) => [8, size - 15 + 8 + i]),
  ]
  const readCopy = (coords) => {
    let v = 0
    coords.forEach(([r, c], i) => { v |= (m[r][c] & 1) << (14 - i) })
    return v
  }
  const fmtA = readCopy(copyA)
  const fmtB = readCopy(copyB)
  assert.equal(fmtA, fmtB, '两份格式信息必须一致（暗模块写错位置会覆盖副本 B 的第 7 位）')

  const rawFmt = fmtA ^ 0b101010000010010
  const data5 = (rawFmt >> 10) & 0b11111
  // BCH(15,5) 复核
  let rem = data5 << 10
  for (let i = 14; i >= 10; i--) if ((rem >> i) & 1) rem ^= 0b10100110111 << (i - 10)
  assert.equal(((data5 << 10) | rem) ^ 0b101010000010010, fmtA, '格式信息必须通过 BCH 校验')
  const ecBits = (data5 >> 3) & 0b11
  const mask = data5 & 0b111
  assert.equal(ecBits, 0b00, '本编码器固定用 EC level M（两位 00）')
  assert.equal(mask, 0b000, '本编码器固定用掩码 0')

  // 暗模块：规范位置是 (8, size-8)
  assert.equal(m[8][size - 8], 1, '暗模块必须在 (8, size-8)')

  // 去掩码（mask 0：(r+c) 偶数取反）
  const un = m.map((row) => row.slice())
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!isFunc(r, c) && (r + c) % 2 === 0) un[r][c] ^= 1
    }
  }

  // 按规范顺序读比特：列对从右往左，跳过第 6 列；列对内先右后左
  const bits = []
  let right = size - 1
  while (right >= 1) {
    if (right === 6) right = 5
    const upward = ((right + 1) & 2) === 0
    for (let vert = 0; vert < size; vert++) {
      const y = upward ? size - 1 - vert : vert
      for (const x of [right, right - 1]) {
        if (!isFunc(y, x)) bits.push(un[y][x] & 1)
      }
    }
    right -= 2
  }
  const cw = []
  for (let i = 0; i + 7 < bits.length; i += 8) {
    let v = 0
    for (const b of bits.slice(i, i + 8)) v = (v << 1) | b
    cw.push(v)
  }

  // 分块 + 去交织
  const lens = []
  for (const [count, dlen] of BLOCKS[version]) for (let i = 0; i < count; i++) lens.push(dlen)
  const blocks = lens.map((d) => ({ d: new Array(d).fill(0), e: new Array(EC_LEN[version]).fill(0) }))
  let idx = 0
  const maxD = Math.max(...lens)
  for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.d.length) b.d[i] = cw[idx++]
  for (let i = 0; i < EC_LEN[version]; i++) for (const b of blocks) b.e[i] = cw[idx++]
  assert.equal(idx, cw.length, '码字数量必须与版本表对得上（表填错时会多出来，被静默截断）')

  // RS 校验子必须全零（数据与纠错码自洽）
  for (const b of blocks) {
    const code = [...b.d, ...b.e]
    for (let j = 0; j < EC_LEN[version]; j++) {
      let s = 0
      for (let i = 0; i < code.length; i++) {
        if (code[i]) s ^= gmul(code[i], EXP[(j * (code.length - 1 - i)) % 255])
      }
      assert.equal(s, 0, 'RS 校验子必须全零（数据区与纠错码不自洽）')
    }
  }

  // 解析字节模式：4 位模式 + 8 位长度 + 数据
  const dataWords = blocks.flatMap((b) => b.d)
  const ab = []
  for (const v of dataWords) for (let i = 7; i >= 0; i--) ab.push((v >> i) & 1)
  let mode = 0
  for (const b of ab.slice(0, 4)) mode = (mode << 1) | b
  assert.equal(mode, 0b0100, '本编码器固定用字节模式')
  // ⚠️ 长度字段的位宽随版本变：v1–v9 是 8 位，**v10 起是 16 位**（字节模式）
  const lenBits = version <= 9 ? 8 : 16
  let len = 0
  for (const b of ab.slice(4, 4 + lenBits)) len = (len << 1) | b
  const out = []
  let off = 4 + lenBits
  for (let i = 0; i < len; i++) {
    let v = 0
    for (const b of ab.slice(off, off + 8)) v = (v << 1) | b
    off += 8
    out.push(v)
  }
  return { text: Buffer.from(out).toString('utf8'), version, format: fmtA }
}

test('⭐ 编码 → 按规范解码 → 必须读回原文（多个长度、跨版本）', () => {
  const urls = [
    'A',
    'HELLO',
    'https://a.b/c',
    'https://192.168.1.5:52118/?k=abc',
    'https://192.168.1.5:52118/?k=KtZEWp4SgaRX5ZgbOXKucw',
    'https://10.0.0.5:8443/?k=' + 'x'.repeat(60),
    'https://10.0.0.5:8443/?k=' + 'y'.repeat(120),
    '中文文件名也要能编码：闪传二维码测试',
  ]
  for (const url of urls) {
    const m = QR.qrMatrix(url)
    assert.ok(m, `应当能编码：${url.slice(0, 30)}`)
    const got = decodeMatrix(m)
    assert.equal(got.text, url, `二维码读回来必须与原文一致（${url.slice(0, 30)}）`)
  }
})

test('版本覆盖：从 v1 到 v10 都能自洽解码', () => {
  const seen = new Set()
  // v10 的数据容量是 216 字节（还要减去模式/长度头），所以最多到 ~190 就够覆盖 v1–v10
  for (let len = 1; len <= 190; len += 7) {
    const text = 'https://x/' + 'a'.repeat(len)
    const m = QR.qrMatrix(text)
    assert.ok(m, `长度 ${len} 应当能编码`)
    const got = decodeMatrix(m)
    assert.equal(got.text, text)
    seen.add(got.version)
  }
  assert.ok(seen.size >= 5, `应当覆盖多个版本（实际 ${[...seen].sort((a, b) => a - b).join(',')}）`)
})

test('⭐ 反向验证：三个修过的 bug 各自都会让解码失败', () => {
  const url = 'https://192.168.1.5:52118/?k=KtZEWp4SgaRX5ZgbOXKucw'
  const good = QR.qrMatrix(url)

  // ① 暗模块写错位置（换回 (size-8, 8)）
  const n = good.length
  const m1 = good.map((r) => r.slice())
  m1[n - 8][8] = 1
  m1[8][n - 8] = 0
  assert.throws(() => decodeMatrix(m1), /格式信息|暗模块/, '暗模块位置写错必须能被抓住')

  // ② 格式信息按低位先写（把两份副本的第 i 位与第 14-i 位对调）
  const m2 = good.map((r) => r.slice())
  const coordsA = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8],
    [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]]
  const bits = coordsA.map(([r, c]) => m2[r][c])
  coordsA.forEach(([r, c], i) => { m2[r][c] = bits[14 - i] })
  assert.throws(() => decodeMatrix(m2), /BCH|格式信息/, '格式位序写反必须能被抓住')

  // ③ 版本表退化成"每块总码字数"（数据区多塞 → 码字数对不上）
  const m3 = good.map((r) => r.slice())
  // 直接把数据区清成白色：码字自然不自洽
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const inFunc = (r < 9 && c < 9) || (r < 9 && c >= n - 8) || (r >= n - 8 && c < 9) || r === 6 || c === 6
      if (!inFunc) m3[r][c] = 0
    }
  }
  assert.throws(() => decodeMatrix(m3), /RS|码字/, '数据区被破坏必须能被抓住')
})

test('⭐ 两份实现（终端 / 浏览器模板）必须产生**逐格相同**的矩阵', () => {
  // `src/tty.js` 里这份算法有两份副本：终端用的真代码，和给页面 eval 的模板字符串。
  // 修 bug 时两处都得改 —— 这份判据就是那种"只改一处"的护栏。
  const urls = ['A', 'https://a.b/c', 'https://192.168.1.5:52118/?k=KtZEWp4SgaRX5ZgbOXKucw']
  for (const url of urls) {
    const fromTerminal = qrMatrixTerminal(url)
    const fromBrowser = QR.qrMatrix(url)
    assert.ok(fromTerminal && fromBrowser, `两份都应当能编码：${url}`)
    assert.deepEqual(fromBrowser, fromTerminal, `两份矩阵必须逐格相同：${url}`)
  }
})
