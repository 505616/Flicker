/**
 * 接收端那套纯 JS 的 SHA-256 到底有多快
 * ======================================
 *
 * 为什么怀疑它：浏览器里 **WebCrypto 的 `crypto.subtle.digest` 是一次性的**
 * （不能增量喂），而接收端必须"边收边算、内存恒定"，所以页面里自带了一份
 * 纯 JS 的增量 SHA-256。纯 JS 的 SHA-256 比原生慢一个数量级是很常见的事 ——
 * 若它只有几十 MB/s，那么**不管网卡多快、并发多高，接收端都会卡在这上面**。
 *
 * 这是"提高传输速度"最可能被忽略的一处：大家盯着网络和并发，
 * 而真正的天花板可能是自己写的哈希。
 *
 * 量法：把页面里那个类**原样抠出来**（与 test/receiver-page.test.js 同一手法），
 * 在 Node 里对同样的数据跑一遍，与 `node:crypto` 的原生实现对比。
 *
 * 用法：node _lab/bench-browser-sha256.mjs
 */

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MiB = 1024 * 1024
const html = readFileSync(path.join(ROOT, 'web/receiver.html'), 'utf8')

/** 把页面里的 Sha256 类抠出来（用 vm 跑，避免 eval 的语义意外） */
function loadPageSha256() {
  // 类从 `class Sha256` 开始，到下一个顶层 `}` 结束 —— 用花括号配平来切
  const start = html.indexOf('class Sha256')
  if (start < 0) throw new Error('页面里找不到 class Sha256 —— 结构变了？')
  let i = html.indexOf('{', start)
  let depth = 0
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++
    else if (html[i] === '}') { depth--; if (depth === 0) break }
  }
  const src = html.slice(start, i + 1)
  const ctx = vm.createContext({})
  // K256 是页面里与这个类配套的常量表，必须一起喂进去 ——
  // 只抠类会得到一个"跑起来就 K256 is not defined"的空壳。
  const kStart = html.indexOf('const K256')
  if (kStart < 0) throw new Error('页面里找不到 K256 常量表')
  // ⚠️ 别用 indexOf(']') 切数组：页面里写的是 `new Uint32Array([...])`，
  //    第一个 `]` 只是内层数组的结束，切出来会缺一个 `)`，报的是
  //    "missing ) after argument list" —— 一个和"找不到常量"毫无关系的错。
  //    改成一直切到这一条语句的 `]);` 为止。
  const kEndMark = html.indexOf(']);', kStart)
  const kSrc = html.slice(kStart, kEndMark + 3)
  new vm.Script(kSrc + '\n' + src + '\n;globalThis.__S = Sha256').runInContext(ctx)
  return { Ctor: ctx.__S, src: kSrc + '\n' + src }
}

const { Ctor, src } = loadPageSha256()
console.log(`\n页面里的 Sha256：${src.split('\n').length} 行，${(src.length / 1024).toFixed(1)} KB`)

/** 用页面里的类算一个缓冲区的摘要（页面的 API 是 digest()，返回 hex） */
function pageHash(buf, chunk = 1 * MiB) {
  const h = new Ctor()
  for (let off = 0; off < buf.length; off += chunk) {
    h.update(buf.subarray(off, Math.min(off + chunk, buf.length)))
  }
  return h.digest()
}

/** 正确性先确认：错的实现跑得再快也没意义 */
const vectors = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
]
let ok = true
for (const [input, want] of vectors) {
  const got = pageHash(Buffer.from(input, 'utf8'))
  if (got !== want) { console.log(`  ✗ 已知向量不符: ${JSON.stringify(input)} → ${got}`); ok = false }
}
// 再对一个 3 MiB 的随机数据比对原生实现（覆盖多块与不齐尾块）
const probe = Buffer.alloc(3 * MiB + 12345)
for (let i = 0; i < probe.length; i++) probe[i] = (i * 31 + 7) & 0xff
const nativeProbe = createHash('sha256').update(probe).digest('hex')
if (pageHash(probe) !== nativeProbe) { console.log('  ✗ 3 MiB 数据与原生实现不一致'); ok = false }
console.log(`  正确性：${ok ? '✓ 与原生实现逐位一致（含不齐尾块）' : '✗ 有问题，下面的速度没有意义'}`)
if (!ok) process.exit(1)

const SIZE = 64 * MiB
const data = Buffer.alloc(SIZE)
for (let i = 0; i < SIZE; i += 4096) data[i] = i & 0xff     // 内容不重要，只测速度

console.log(`\n对 ${SIZE / MiB} MiB 数据算一次摘要：\n`)

// 原生
let t0 = Date.now()
const a = createHash('sha256').update(data).digest('hex')
let nativeMs = Date.now() - t0

// 页面里的那份（按浏览器实际的喂入方式：每块 1 MiB）
t0 = Date.now()
const b = pageHash(data, 1 * MiB)
let pageMs = Date.now() - t0

console.log(`  node:crypto 原生      ${String(nativeMs).padStart(6)} ms   ` +
  `**${(SIZE / MiB / (nativeMs / 1000)).toFixed(0)} MiB/s**`)
console.log(`  页面里的纯 JS          ${String(pageMs).padStart(6)} ms   ` +
  `**${(SIZE / MiB / (pageMs / 1000)).toFixed(0)} MiB/s**`)
console.log(`  摘要一致：${a === b ? '✓' : '✗'}`)
console.log(`  → 纯 JS 比原生慢 **${(pageMs / nativeMs).toFixed(1)}×**\n`)

// ── 这对接速度意味着什么 ────────────────────────────────────

const jsSpeed = SIZE / MiB / (pageMs / 1000)
console.log('─'.repeat(72))
console.log('这对接收速度意味着什么：\n')
const cases = [
  ['1 GbE 局域网', 118],
  ['2.5 GbE 局域网', 295],
  ['Wi-Fi 6 实测常见', 60],
]
console.log('  链路                     链路上限      纯 JS 哈希能否跟上')
for (const [name, mbps] of cases) {
  const ok2 = jsSpeed >= mbps
  console.log(`  ${name.padEnd(22)} ${String(mbps).padStart(5)} MB/s    ` +
    `${ok2 ? '✓ 能' : `✗ **不能**（上限只有 ${jsSpeed.toFixed(0)} MB/s）`}`)
}
console.log('')
if (jsSpeed < 118) {
  console.log('  → 结论：**纯 JS 的 SHA-256 是局域网大文件的真天花板。**')
  console.log('     加并发、换网卡都没用 —— 哈希算不过来。')
} else {
  console.log('  → 哈希能跟上常见链路，它不是瓶颈。')
}
