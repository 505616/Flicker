/**
 * 纯 JS SHA-256 的优化尝试（先量再改）
 * =====================================
 *
 * 背景：页面里那份增量 SHA-256 只有 **92 MiB/s**，而 1 GbE 就要 118 MB/s。
 * 逐块校验用的是原生 `crypto.subtle.digest`（快），瓶颈全在"整文件摘要"这一步 ——
 * 它必须是增量的，而 WebCrypto 的 digest **不能增量喂**，所以只能是 JS。
 *
 * 那能优化到什么程度？这个脚本把几个候选写法放在同一台机器上比。
 * 全部先用原生实现逐位校验正确性 —— 错的实现跑得再快也没意义。
 *
 * 用法：node _lab/bench-sha256-variants.mjs
 */

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const html = readFileSync(path.join(ROOT, 'web/receiver.html'), 'utf8')
const MiB = 1024 * 1024

// ── 现状：从页面里抠出来 ────────────────────────────────────

function extract(html, clsStart) {
  const start = html.indexOf(clsStart)
  if (start < 0) throw new Error(`找不到 ${clsStart}`)
  let i = html.indexOf('{', start), depth = 0
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++
    else if (html[i] === '}') { depth--; if (depth === 0) break }
  }
  return html.slice(start, i + 1)
}
const kStart = html.indexOf('const K256')
const K256_SRC = html.slice(kStart, html.indexOf(']);', kStart) + 3)
const CURRENT = extract(html, 'class Sha256')

// ── 候选写法 ────────────────────────────────────────────────

/**
 * B：把消息扩展的临时数组**复用**，不再每 64 字节新分配一个 Uint32Array。
 *
 * 这是最明显的一处浪费：当前实现每处理 64 字节就 `new Uint32Array(64)`，
 * 1 MiB 数据 = 16384 次分配。2 GiB 的文件就是 3355 万次。
 */
const VARIANT_B = `
class Sha256B {
  constructor() {
    this.H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    this.buf = new Uint8Array(64);
    this.w = new Uint32Array(64);      // ← 复用，不再每块新分配
    this.bufLen = 0;
    this.total = 0;
  }
  update(u8) {
    this.total += u8.length;
    let off = 0;
    if (this.bufLen > 0) {
      const need = 64 - this.bufLen;
      const take = Math.min(need, u8.length);
      this.buf.set(u8.subarray(0, take), this.bufLen);
      this.bufLen += take; off = take;
      if (this.bufLen === 64) { this._block(this.buf, 0); this.bufLen = 0; }
    }
    while (off + 64 <= u8.length) { this._block(u8, off); off += 64; }
    if (off < u8.length) {
      this.buf.set(u8.subarray(off), 0);
      this.bufLen = u8.length - off;
    }
  }
  _block(d, off) {
    const w = this.w;
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = (d[j] << 24) | (d[j+1] << 16) | (d[j+2] << 8) | d[j+3];
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i-15], y = w[i-2];
      const s0 = ((x>>>7)|(x<<25)) ^ ((x>>>18)|(x<<14)) ^ (x>>>3);
      const s1 = ((y>>>17)|(y<<15)) ^ ((y>>>19)|(y<<13)) ^ (y>>>10);
      w[i] = w[i-16] + s0 + w[i-7] + s1;
    }
    const H = this.H;
    let a = H[0], b = H[1], c = H[2], dd = H[3];
    let e = H[4], f = H[5], g = H[6], h = H[7];
    const K = K256;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e>>>6)|(e<<26)) ^ ((e>>>11)|(e<<21)) ^ ((e>>>25)|(e<<7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = ((a>>>2)|(a<<30)) ^ ((a>>>13)|(a<<19)) ^ ((a>>>22)|(a<<10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (dd + t1) >>> 0;
      dd = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + dd) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  digest() {
    const bits = this.total * 8;
    const pad = new Uint8Array(this.bufLen < 56 ? 64 : 128);
    pad.set(this.buf.subarray(0, this.bufLen));
    pad[this.bufLen] = 0x80;
    const dv = new DataView(pad.buffer);
    dv.setUint32(pad.length - 8, Math.floor(bits / 0x100000000));
    dv.setUint32(pad.length - 4, bits >>> 0);
    const saveH = this.H.slice(), saveLen = this.bufLen;
    for (let o = 0; o < pad.length; o += 64) this._block(pad, o);
    let out = '';
    for (let i = 0; i < 8; i++) out += (this.H[i] >>> 0).toString(16).padStart(8, '0');
    this.H = saveH; this.bufLen = saveLen;
    return out;
  }
}`

/**
 * C：在 B 的基础上，把消息扩展里的 16 轮展开成"一次算 16 轮"的写法，
 *    减少循环开销与数组下标重复计算（经典做法）。
 */
const VARIANT_C = VARIANT_B
  .replace('class Sha256B', 'class Sha256C')
  .replace(`    for (let i = 16; i < 64; i++) {
      const x = w[i-15], y = w[i-2];
      const s0 = ((x>>>7)|(x<<25)) ^ ((x>>>18)|(x<<14)) ^ (x>>>3);
      const s1 = ((y>>>17)|(y<<15)) ^ ((y>>>19)|(y<<13)) ^ (y>>>10);
      w[i] = w[i-16] + s0 + w[i-7] + s1;
    }`, `    for (let i = 16; i < 64; i += 8) {
      // 一次算 8 轮：把 w[i-15]/w[i-2] 这些下标运算集中在这里
      for (let k = 0; k < 8; k++) {
        const idx = i + k;
        const x = w[idx-15], y = w[idx-2];
        const s0 = ((x>>>7)|(x<<25)) ^ ((x>>>18)|(x<<14)) ^ (x>>>3);
        const s1 = ((y>>>17)|(y<<15)) ^ ((y>>>19)|(y<<13)) ^ (y>>>10);
        w[idx] = w[idx-16] + s0 + w[idx-7] + s1;
      }
    }`)

// ── 载入与校验 ──────────────────────────────────────────────

/**
 * B1：**只改一处** —— 复用 w 数组，其余与现状逐字相同。
 *     隔离变量的意义：若 2.7× 其实来自别的改动（比如把 K256 提成局部变量），
 *     那结论就会写错，而结论是要写进文档的。
 */
const VARIANT_B1 = CURRENT
  .replace('class Sha256 {', 'class Sha256B1 {')
  .replace(`    this.buf = new Uint8Array(64);
    this.bufLen = 0;`, `    this.buf = new Uint8Array(64);
    this.w = new Uint32Array(64);
    this.bufLen = 0;`)
  .replace('    const w = new Uint32Array(64);', '    const w = this.w;')

function load(src, exportName) {
  const ctx = vm.createContext({})
  new vm.Script(K256_SRC + '\n' + src + `\n;globalThis.__C = ${exportName}`).runInContext(ctx)
  return ctx.__C
}

const impls = [
  ['现状（页面里的）', load(CURRENT, 'Sha256')],
  ['B1 只复用 w 数组', load(VARIANT_B1, 'Sha256B1')],
  ['B 复用 w + 局部化', load(VARIANT_B, 'Sha256B')],
  ['C B + 展开扩展', load(VARIANT_C, 'Sha256C')],
]

function hashWith(Ctor, buf, chunk) {
  const h = new Ctor()
  for (let off = 0; off < buf.length; off += chunk) {
    h.update(buf.subarray(off, Math.min(off + chunk, buf.length)))
  }
  return h.digest()
}

// 正确性
const probes = [
  Buffer.from(''), Buffer.from('abc'),
  Buffer.from('a'.repeat(55)), Buffer.from('a'.repeat(56)),
  Buffer.from('a'.repeat(63)), Buffer.from('a'.repeat(64)),
  Buffer.from('a'.repeat(65)), Buffer.from('a'.repeat(1000)),
]
const big = Buffer.alloc(3 * MiB + 777)
for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff
probes.push(big)

console.log('\n正确性（对已知向量 + 边界长度 + 大缓冲，与 node:crypto 比）：')
let allOk = true
for (const [name, Ctor] of impls) {
  let ok = true
  for (const p of probes) {
    if (hashWith(Ctor, p, 1 * MiB) !== createHash('sha256').update(p).digest('hex')) ok = false
  }
  if (!ok) allOk = false
  console.log(`  ${name.padEnd(20)} ${ok ? '✓ 逐位一致' : '✗ 不一致'}`)
}
if (!allOk) { console.error('\n有实现算错了，速度没有意义。'); process.exit(1) }

// 速度
const SIZE = 64 * MiB
const data = Buffer.alloc(SIZE)
for (let i = 0; i < SIZE; i += 4096) data[i] = i & 0xff

console.log(`\n速度（${SIZE / MiB} MiB，按浏览器实际的喂入方式：每次 1 MiB）：\n`)
const base = createHash('sha256').update(data).digest('hex')
const results = []
for (const [name, Ctor] of impls) {
  // 跑两遍取第二遍（避开 JIT 预热）
  hashWith(Ctor, data.subarray(0, 4 * MiB), 1 * MiB)
  const t0 = Date.now()
  const got = hashWith(Ctor, data, 1 * MiB)
  const ms = Date.now() - t0
  const mbs = SIZE / MiB / (ms / 1000)
  results.push({ name, ms, mbs, ok: got === base })
  console.log(`  ${name.padEnd(20)} ${String(ms).padStart(6)} ms   ${mbs.toFixed(0).padStart(5)} MiB/s` +
    `   ${got === base ? '' : '  ✗ 摘要不符'}`)
}

const t0 = Date.now(); createHash('sha256').update(data).digest(); const nativeMs = Date.now() - t0
console.log(`  ${'node:crypto 原生'.padEnd(20)} ${String(nativeMs).padStart(6)} ms   ` +
  `${(SIZE / MiB / (nativeMs / 1000)).toFixed(0).padStart(5)} MiB/s`)

const cur = results[0], best = results.reduce((a, b) => (b.mbs > a.mbs ? b : a))
console.log('\n' + '─'.repeat(72))
console.log(`  最好的一档：${best.name}  提升 **${(best.mbs / cur.mbs).toFixed(2)}×**` +
  `（${cur.mbs.toFixed(0)} → ${best.mbs.toFixed(0)} MiB/s）`)
for (const [name, limit] of [['1 GbE', 118], ['2.5 GbE', 295]]) {
  console.log(`  ${name.padEnd(8)}（${limit} MB/s）：现状 ${cur.mbs >= limit ? '✓ 跟得上' : '✗ 跟不上'}；` +
    `优化后 ${best.mbs >= limit ? '✓ 跟得上' : '✗ 仍跟不上'}`)
}
console.log('')
