/**
 * 接收端内联脚本的验证
 * ====================
 * 接收端页面里的纯 JS 增量 SHA-256 是**完整性校验的根基** ——
 * 如果它算错了，所有文件都会被误判为"校验失败"。
 * 所以必须把它从 HTML 里抽出来，和 Node 的 crypto 逐字节对比。
 *
 * 同时验证 IV/AAD 派生是否与 Node 端完全一致 ——
 * 任何差异都会导致解密失败，而且这种失败极难排查。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  chunkAAD, chunkIV, MANIFEST_AAD, PARAMS, receiverMac, senderMac, SUITE_ID,
} from '../src/suite/flicker1.js'

import { registerRelayPageTests, codeOnly, extractSha256 } from './receiver-relay-tests.js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const html = await readFile(path.join(root, 'web', 'receiver.html'), 'utf8')

// 抽取逻辑只保留一份（在 receiver-relay-tests.js 里）：
// 那里的正则带**行首锚点**，否则会被 buildHashWorkerSource() 里的字符串字面量抢先匹配
const Sha256 = extractSha256(html).Sha256

const hex = (buf) => createHash('sha256').update(buf).digest('hex')

test('增量 SHA-256：与 Node crypto 在多种长度上完全一致', () => {
  const lengths = [0, 1, 2, 3, 55, 56, 57, 63, 64, 65, 100, 127, 128, 129,
    1000, 4096, 65535, 65536, 100000, 1 << 20]
  for (const n of lengths) {
    const data = randomBytes(n)
    const h = new Sha256()
    h.update(data)
    assert.equal(h.digest(), hex(data), `长度 ${n} 的摘要不一致`)
  }
})

test('增量 SHA-256：分多次喂入与一次喂入结果相同（真正增量的证明）', () => {
  const data = randomBytes(300000)
  // 一次性
  const one = new Sha256(); one.update(data)
  // 按各种块大小顺序喂完整个数据
  const many = new Sha256()
  let off = 0
  for (const size of [1, 7, 63, 64, 65, 127, 1000, 4096, 5, 99999]) {
    const chunk = data.subarray(off, Math.min(off + size, data.length))
    if (chunk.length) many.update(chunk)
    off += chunk.length
    if (off >= data.length) break
  }
  if (off < data.length) many.update(data.subarray(off))   // 剩余全喂进去
  assert.equal(off >= data.length || true, true)
  assert.equal(many.digest(), one.digest(), '分块喂入必须得到同样的摘要')
  assert.equal(one.digest(), hex(data))
})

test('增量 SHA-256：以随机切分喂入任意数据都一致', () => {
  for (let round = 0; round < 20; round++) {
    const n = Math.floor(Math.random() * 5000)
    const data = randomBytes(n)
    const h = new Sha256()
    let off = 0
    while (off < n) {
      const size = 1 + Math.floor(Math.random() * 200)
      h.update(data.subarray(off, Math.min(off + size, n)))
      off += size
    }
    assert.equal(h.digest(), hex(data), `第 ${round} 轮：长度 ${n} 随机切分后不一致`)
  }
})

test('增量 SHA-256：正好在块边界处切割（最容易写错的长度）', () => {
  for (const n of [64, 128, 192, 55, 56, 57]) {
    const data = randomBytes(n)
    for (let cut = 0; cut <= n; cut++) {
      const h = new Sha256()
      h.update(data.subarray(0, cut))
      h.update(data.subarray(cut))
      assert.equal(h.digest(), hex(data),
        `长度 ${n} 在第 ${cut} 字节切开时出错 —— 这是填充逻辑的经典陷阱`)
    }
  }
})

test('增量 SHA-256：空输入', () => {
  const h = new Sha256()
  h.update(new Uint8Array(0))
  assert.equal(h.digest(), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
})

test('增量 SHA-256：digest() 可重复调用而不破坏状态', () => {
  const data = randomBytes(1000)
  const h = new Sha256()
  h.update(data)
  const a = h.digest(), b = h.digest()
  assert.equal(a, b)
  h.update(randomBytes(10))
  assert.notEqual(h.digest(), a, '继续喂数据后摘要应改变')
})

test('增量 SHA-256：已知向量', () => {
  const cases = [
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
    ['a'.repeat(1000000), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'],
  ]
  for (const [s, want] of cases) {
    const h = new Sha256()
    h.update(new TextEncoder().encode(s))
    assert.equal(h.digest(), want, `已知向量不符: ${s.slice(0, 20)}…`)
  }
})

test('增量 SHA-256：算法在内存上真的是增量的（不累积整个输入）', () => {
  // 这是"大文件不爆内存"承诺的技术依据 —— 如果有人把它改回累积式，这条会挂。
  //
  // ⚠️ 判据从"字段名白名单"改成了"**状态大小与喂入量无关**"。
  //    旧写法断言实例上只有 H/buf/bufLen/total 四个字段，而优化哈希时要加一个
  //    **固定 256 字节**的消息扩展暂存数组（`w`）—— 它不是累积容器，
  //    却会被白名单挡住。白名单式断言会把"合法的常量缓冲"和"非法的累积容器"
  //    一起拒掉，于是要么误伤、要么被人顺手放宽。
  //    按**大小**判才是真正要守的那条线：喂 1 MiB 和喂 64 MiB，状态必须一样大。
  // 估算实例**实际持有**的字节数。
  // ⚠️ 必须递归、且必须认识**普通数组**：第一版只算了 TypedArray 与 number，
  //    于是"往实例上挂一个 Array 累积所有分块"这种做法**完全测不出来** ——
  //    而正向对照正好抓住了这个漏洞（一个测不出问题的判据等于没有判据）。
  const retained = (v, depth = 0) => {
    if (v == null || depth > 3) return 0
    if (v instanceof Uint8Array || v instanceof Uint32Array) return v.byteLength
    if (Array.isArray(v)) return v.length * 8 + v.reduce((s, x) => s + retained(x, depth + 1), 0)
    if (typeof v === 'number') return 8
    if (typeof v === 'string') return v.length * 2
    if (typeof v === 'object') {
      return Object.values(v).reduce((s, x) => s + retained(x, depth + 1), 0)
    }
    return 0
  }

  const small = new Sha256()
  small.update(randomBytes(1 << 20))                     // 1 MiB
  const large = new Sha256()
  for (let i = 0; i < 64; i++) large.update(randomBytes(1 << 20))   // 64 MiB

  assert.equal(retained(large), retained(small),
    `喂 64 MiB 之后状态变大了（${retained(small)} → ${retained(large)} 字节）—— ` +
    '说明有地方在累积输入，大文件会爆内存')
  assert.ok(retained(large) <= 1024,
    `实例状态 ${retained(large)} 字节，超过 1 KiB —— 增量哈希不该持有这么大的东西。\n` +
    `    当前字段：${Object.keys(large).join(', ')}`)
  assert.ok(large.buf.length <= 64, '残留缓冲不应超过一个块')
  assert.equal(large.total, 64 << 20, '应按字节累计长度')

  // 反向确认：这条断言**能**抓到累积容器（一个永远通过的检查等于没有检查）
  const fake = new Sha256()
  fake.acc = []                                          // 故意塞一个累积容器
  for (let i = 0; i < 64; i++) fake.acc.push(new Uint8Array(1 << 20))
  assert.notEqual(retained(fake), retained(small), '累积容器必须让状态变大，否则判据失效')
  assert.ok(retained(fake) > 1024, '累积容器必须超出上限')
})

// ── IV / AAD 派生必须与 Node 端逐字节一致 ────────────────────

test('⭐ 哈希的消息扩展暂存数组是复用的（不是每 64 字节新分配一个）', () => {
  // 这一条守的是**速度**，不是正确性 —— 而它守的是一个实测 2.3 倍的差距。
  //
  // 背景：浏览器里 WebCrypto 的 digest 不能增量喂，所以"整文件摘要"只能是纯 JS。
  // 而它就是接收速度的天花板（实测 92 MiB/s → 连 1 GbE 的 118 MB/s 都跟不上）。
  // 原因是最朴素的写法里 `_block()` 每次 `new Uint32Array(64)` ——
  // 每 64 字节一次分配，1 MiB 就是 16384 次，2 GiB 文件 3355 万次。
  //
  // 光"复用这一个数组"就把它从 92 提到 208 MiB/s，再加上局部化到 252 MiB/s。
  // 数字与复现脚本见 `_lab/bench-sha256-variants.mjs`。
  //
  // 为什么用源码断言而不是跑速度：CI 机器性能差异极大，速度断言必然变成偶发失败。
  // 而"有没有每次新分配"是**结构事实**，看源码就能判定，不会误报。
  const cls = html.slice(html.indexOf('class Sha256'), html.indexOf('\n}\n', html.indexOf('class Sha256')))
  const block = cls.slice(cls.indexOf('_block(d, off)'))
  assert.ok(!/new Uint32Array\(/.test(block),
    '_block() 里出现了 new Uint32Array —— 每 64 字节分配一次，实测慢 2.3 倍。\n' +
    '    正确做法：在构造函数里建一个 this.w 复用它。')
  assert.match(block, /const w = this\.w/,
    '_block() 应当复用构造函数里分配的 this.w')
  assert.match(cls, /this\.w = new Uint32Array\(64\)/,
    '构造函数里应当分配 this.w（消息扩展暂存数组）')
  // 复用不能破坏"增量"这条线：它必须是**定长**的 64 个 u32，不是随输入增长的东西
  assert.match(cls, /this\.w = new Uint32Array\(64\)/,
    'this.w 必须是定长的 64 个 u32（256 字节），不能随输入增长')
})

/** 从页面里抽出 ivFor 与 aadFor 的实现 */
function extractDerivations() {
  const iv = html.match(/const ivFor = \(chunkIndex\) => \{[\s\S]*?\n\};/)
  const aad = html.match(/const aadFor = \(fileIndex, chunkIndex, totalChunks, plainLen\) => \{[\s\S]*?\n\};/)
  const ivm = html.match(/const MANIFEST_AAD = enc\.encode\('([^']+)'\);/)
  const lab = html.match(/const LABEL = \{ room: '([^']+)', auth: '([^']+)', enc: '([^']+)' \};/)
  assert.ok(iv && aad && ivm && lab, '未能定位派生函数 —— 页面结构变了？')
  // eslint-disable-next-line no-new-func
  const fn = new Function('enc', `${iv[0]}\n${aad[0]}\nreturn { ivFor, aadFor, manifestLabel: ${JSON.stringify(ivm[1])}, labels: ${JSON.stringify([lab[1], lab[2], lab[3]])} }`)
  return fn(new TextEncoder())
}

const D = extractDerivations()

test('ivFor 与服务端的 chunkIV 逐字节一致', () => {
  for (const idx of [0, 1, 2, 255, 256, 65535, 1000000, 2 ** 32, 2 ** 40]) {
    const a = Buffer.from(chunkIV(idx))
    const b = Buffer.from(D.ivFor(idx))
    assert.equal(Buffer.compare(a, b), 0, `块序号 ${idx} 的 IV 不一致`)
  }
})

test('ivFor 在大块序号下不因 32 位截断而出错', () => {
  // JS 位运算会在 32 位处静默截断 —— 这里专门验证超过 2^32 的序号
  const big = 2 ** 32 + 12345
  assert.equal(Buffer.compare(Buffer.from(chunkIV(big)), Buffer.from(D.ivFor(big))), 0)
})

test('aadFor 与服务端的 chunkAAD 逐字节一致（含大序号）', () => {
  const cases = [
    [0, 0, 1, 0], [0, 0, 1, 1], [1, 2, 3, 4], [7, 100, 1000, 1048576],
    [32767, 5, 10, 512],            // 32 位截断陷阱的边界
    [32768, 5, 10, 512],            // 危险区
    [70000, 1, 2, 3],
    [2 ** 32 + 5, 0, 1, 0],
    [2 ** 40, 2 ** 20, 2 ** 21, 1048576],
  ]
  for (const [fi, ci, tc, len] of cases) {
    const a = Buffer.from(chunkAAD(fi, ci, tc, len))
    const b = Buffer.from(D.aadFor(fi, ci, tc, len))
    assert.equal(Buffer.compare(a, b), 0,
      `AAD 不一致 @ file=${fi} chunk=${ci} total=${tc} len=${len}`)
  }
})

test('aadFor 的长度恒为 28 字节', () => {
  for (const [fi, ci, tc, len] of [[0,0,1,0], [1,1,1,1024], [2**40, 2**20, 2**21, 1048576]]) {
    assert.equal(D.aadFor(fi, ci, tc, len).length, 28)
  }
})

test('三种 AAD 的长度关系符合协议（清单 18 / 数据块 28，刻意不同）', () => {
  assert.equal(MANIFEST_AAD.length, 18)
  assert.equal(D.aadFor(0, 0, 1, 0).length, 28)
  assert.equal(new TextEncoder().encode(D.manifestLabel).length, D.manifestLabel.length)
  assert.equal(D.manifestLabel, 'flicker/1/manifest')
})

test('HKDF 标签与 Node 端逐字一致（写错一个字符就会解密失败）', () => {
  assert.deepEqual(D.labels, ['flicker/1/room', 'flicker/1/auth', 'flicker/1/enc'])
})

test('页面引用的协议常量与服务端一致', () => {
  assert.match(html, /const SUITE = 'FLICKER\/1'/)
  assert.equal(PARAMS.chunkBytes, 1 << 20)
  // 页面不应硬编码块大小，而应使用服务端下发的值
  assert.ok(html.includes('f.chunkBytes'), '页面应使用清单里的 chunkBytes')
})

// ── 页面本身的硬性约束 ──────────────────────────────────────

test('接收端页面零外部请求（局域网可能没有外网）', () => {
  const externals = [
    /<script[^>]+src=/i, /<link[^>]+href=/i, /@import/i,
    /fonts\.googleapis/i, /cdn\./i, /unpkg/i, /jsdelivr/i,
    /https?:\/\/(?!127\.0\.0\.1|localhost)[a-z0-9.-]+\//i,
  ]
  for (const re of externals) {
    assert.ok(!re.test(html), `页面里出现了外部资源引用: ${re}`)
  }
})

/**
 * 剥掉注释，只留代码（**保留脚本内容** —— 这里要检查的正是脚本里的存储用法）。
 *
 * ⚠️ 必须先剥注释：解释"为什么不用 localStorage"的注释里会出现这个名字，
 *    直接 includes 会误报。项目里在 import.meta 的检查上踩过同一个坑。
 */
function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')            // HTML 注释
    .replace(/\/\*[\s\S]*?\*\//g, '')            // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')        // 行注释（不误伤 https:// ）
}

test('⭐ 链接里的凭据不会被写进任何存储（fragment 只读不存）', () => {
  // 对应 PROTOCOL.md 的 Q10：链接的 fragment 里同时放着一次性令牌与盐，
  // 拿到链接的人就等于拿到两者。所以页面**绝不能**把它持久化 ——
  // 一旦落盘，一个"一次性"凭据就变成了留在磁盘上、可被翻出来的东西。
  //
  // 页面上唯一允许写存储的地方是语言偏好（见下面那条用例）。
  // 这里检查的是：所有 setItem 写的都是语言键，不涉及链接参数。
  const code = stripComments(html)

  const writes = [...code.matchAll(/setItem\(\s*([^,)]+)/g)].map((m) => m[1].trim())
  assert.ok(writes.length > 0, '应当能定位到存储写入点（否则这条用例是空转的）')
  for (const w of writes) {
    assert.ok(/flicker\.lang|KEY/.test(w),
      `存储写入的键是 ${w} —— 只允许写语言偏好，不许写任何与链接/传输有关的东西`)
  }

  // fragment 必须能被读出来（否则链接用不了），但只能用于派生
  assert.match(code, /location\.hash/, '应当从 fragment 读参数')
  assert.doesNotMatch(code, /setItem\([^)]*(token|salt|hash)/i,
    'fragment 里的令牌/盐绝不能进存储')
})

test('⭐ 接收端页面不写跨会话的持久化存储（不留痕迹）', () => {
  // ⚠️ 这条用例真的抓到过一次回归：加 i18n 时我给语言偏好用了 localStorage，
  //    于是接收端会在对方浏览器里留下一条记录 —— 而"不留痕迹"是这个页面
  //    对接收端的核心承诺之一，不该为了省一次点击破例。
  //    现在接收端只用 sessionStorage（关标签即消失），发送端才用 localStorage。
  //
  // ⚠️ 必须先剥掉注释再查：解释"为什么不用 localStorage"的注释里
  //    会出现这个名字，直接 includes 会误报（项目里 import.meta 的检查
  //    被文档注释误伤过一次，同一个教训）。
  const code = stripComments(html)
  for (const bad of ['localStorage', 'indexedDB', 'document.cookie']) {
    assert.ok(!code.includes(bad),
      `接收端页面的**代码**里不应出现 ${bad} —— 会在对方浏览器里留下跨会话的痕迹。` +
      '要记住界面偏好就用 sessionStorage（关标签即消失）。')
  }
  // sessionStorage 允许存**界面偏好**：语言 + 字号（2026-10 加的字体大小调节）。
  // 两者都只影响界面观感，关掉标签即消失，绝不涉及链接 / 令牌 / 传输数据。
  //
  // ⚠️ 数量上限放宽到 10 是因为字号控件是内联进来的一小段（读一次、写一次、
  //    能力检测几次）。**真正的约束是"记的只能是偏好"** —— 上面那条
  //    （所有 setItem 的键）与下面这条（键名必须在这两个之内）才是要紧的。
  const uses = [...code.matchAll(/sessionStorage[.\w]*/g)].map((m) => m[0])
  assert.ok(uses.length <= 10,
    `sessionStorage 的使用点偏多（${uses.length} 处）—— 确认只用来存界面偏好（语言 / 字号）`)
  assert.match(code, /flicker\.fontScale/,
    '字号偏好应当存进 sessionStorage，键是 flicker.fontScale')
  assert.doesNotMatch(code, /setItem\(\s*['"`][^'"`]*(token|salt|hash)/i,
    '任何存储都不许写链接里的令牌/盐')
  assert.match(html, /globalThis\.__I18N_PERSIST__ = false;/,
    '接收端必须显式关掉"跨会话记住语言"，否则运行时会去用 localStorage')
  assert.match(code, /typeof sessionStorage/,
    '接收端应当把语言偏好存进 sessionStorage（关标签即消失）')
})

test('接收端页面声明了必要的信息（标题、编码、referrer 策略）', () => {
  assert.match(html, /<meta charset="UTF-8">/)
  assert.match(html, /<title>/)
  assert.match(html, /referrer[^>]*no-referrer/i)
})

test('接收端脚本语法正确（能在严格模式下解析）', () => {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  assert.ok(scripts.length >= 1, '应至少有一段内联脚本')
  for (const s of scripts) {
    assert.doesNotThrow(() => new Function(s), '内联脚本存在语法错误')
  }
})

// ── 瞬时故障重试（接收端）──────────────────────────────────
//
// 从前 fetch 抛出的网络错误直接冒到顶层 → 传输失败。
// Wi-Fi 抖一下、手机切个网，几十 GB 就白传了。
// 这一组用例从页面里**真实抽出**那段逻辑来验，不靠"读代码觉得对"。

/** 抽出 isTransientNet + withRetry + NET 常量，配上最小的 $ / setTimeout 桩 */
function extractRetryLayer() {
  // 从 `const NET = {…}` 一直抓到 `async function api(` 之前 ——
  // 中间包含 isTransientNet / noteRetry / clearRetryNote / withRetry。
  // ⚠️ 别把终点写成"某个具体函数的开头"：i18n 改造时在 api 之前插了
  //    `const t = …` 一行，终点就再也匹配不到，整组用例报"未能定位重试层"。
  //    用 api 这个**稳定的边界**（它一直是紧接重试层之后的第一个页面函数）。
  const start = html.indexOf('const NET = {')
  const end = html.indexOf('async function api(')
  assert.ok(start > 0 && end > start,
    '未能从 receiver.html 中定位重试层 —— 页面结构变了？')
  const body = html.slice(start, end)
  const src = `
    const el = { textContent: '', classList: { add(){}, remove(){} } };
    function $(id) { return id === 'reconnect' ? el : null; }
    const t = (k) => k;
    ${body}
    return { NET, isTransientNet, withRetry, el };
  `
  // ⚠️ 注入 setTimeout 桩有二用：
  //    ① 不换掉的话，"重试用尽"那条用例要真等 400+800+1600+3200+6400 ≈ 12 秒；
  //    ② 桩把每次的等待时长记下来，于是"退避确实在指数增长"可以被断言。
  //    页面代码里的退避走的就是全局 setTimeout，所以换掉它对被测逻辑无侵入。
  const waits = []
  const stub = (fn, ms) => { waits.push(Math.round(ms)); fn(); return 0 }
  // eslint-disable-next-line no-new-func
  const api = new Function('setTimeout', src)(stub)
  return { ...api, waits }
}

const retry = extractRetryLayer()

test('接收端重试层：退避是指数增长的（不会把中继打爆）', async () => {
  const { withRetry, waits } = retry
  waits.length = 0
  await assert.rejects(() => withRetry('t', async () => { throw new TypeError('fetch failed') }))
  assert.ok(waits.length >= 3, `至少应观察到 3 次退避，实际 ${waits.length}`)
  for (let i = 1; i < waits.length; i++) {
    assert.ok(waits[i] > waits[i - 1],
      `退避必须逐次变长：第 ${i} 次 ${waits[i]}ms 不大于第 ${i - 1} 次 ${waits[i - 1]}ms`)
  }
  const max = Math.max(...waits)
  assert.ok(max <= 9000, `单次退避不该超过 ~8s，实际 ${max}ms`)
})

test('接收端重试层：区分瞬时故障与致命错误', () => {
  const { isTransientNet } = retry
  // 瞬时 —— 必须重试
  assert.equal(isTransientNet(new TypeError('fetch failed')), true, '网络层失败要重试')
  assert.equal(isTransientNet(Object.assign(new Error('t'), { name: 'TimeoutError' })), true)
  assert.equal(isTransientNet(null, 503), true, '5xx 要重试')
  assert.equal(isTransientNet(null, 429), true, '429 要重试')
  // 致命 —— 绝不能重试（重试也不会变好，只会让用户白等）
  for (const code of ['NO_ROOM', 'EXPIRED', 'GONE', 'PEER_AUTH', 'DECRYPT', 'CHUNK_HASH', 'RELAY_GONE']) {
    assert.equal(isTransientNet(Object.assign(new Error('x'), { code })), false,
      `${code} 不该触发重试`)
  }
  assert.equal(isTransientNet(null, 404), false)
  assert.equal(isTransientNet(new Error('随便什么错误')), false)
})

test('接收端重试层：网络错误会被重试，最终成功', async () => {
  const { withRetry, NET } = retry
  let calls = 0
  const out = await withRetry('test', async () => {
    calls++
    if (calls < 3) throw new TypeError('fetch failed')
    return 'ok'
  })
  assert.equal(out, 'ok')
  assert.equal(calls, 3, `应重试到第 3 次才成功，实际 ${calls} 次`)
  assert.ok(NET.retries >= 3, '重试次数上限不能太小 —— 长传输里网络抖动是常态')
})

test('接收端重试层：致命错误立刻抛出，不浪费用户时间', async () => {
  const { withRetry } = retry
  let calls = 0
  const t0 = Date.now()
  await assert.rejects(
    () => withRetry('test', async () => {
      calls++
      throw Object.assign(new Error('房间没了'), { code: 'NO_ROOM' })
    }),
    (e) => e.code === 'NO_ROOM')
  assert.equal(calls, 1, '致命错误只该尝试一次')
  assert.ok(Date.now() - t0 < 500, '不该在退避上耗时')
})

test('接收端重试层：重试次数用尽后把最后一个错误抛出去', async () => {
  const { withRetry, NET } = retry
  let calls = 0
  await assert.rejects(
    () => withRetry('test', async () => {
      calls++
      throw new TypeError('fetch failed')
    }),
    (e) => e.name === 'TypeError')
  assert.equal(calls, NET.retries + 1, `应为 1 次首发 + ${NET.retries} 次重试`)
})

test('接收端页面有"正在重连"的提示位 —— 静默重试看起来像卡死', () => {
  assert.match(html, /id="reconnect"/,
    '需要一个元素告诉用户"链路不稳正在重连"；否则长退避期间界面毫无反应，用户会以为程序挂了')
})

// ── 文件粒度续传（重试时不重传已完成的文件）─────────────────

/** 抽出 resetProgressFor / currentSessionTag 与两个状态变量 */
function extractProgressTracker() {
  // 两个函数都要抓到 —— 原来用 `[\s\S]*?\n\}\n` 只到第一个 `}`，
  // 把 currentSessionTag 截掉了（测试里报 "currentSessionTag is not defined"）。
  const m = html.match(/let DONE_FILES = new Set\(\);[\s\S]*?function currentSessionTag\(\) \{[\s\S]*?\n\}/)
  assert.ok(m, '未能从 receiver.html 中定位续传进度跟踪 —— 页面结构变了？')
  const src = `
    const readRelayParams = () => globalThis.__relay;
    const location = globalThis.__loc;
    ${m[0]}
    return {
      DONE_FILES: () => DONE_FILES,
      fileDoneBytes,
      resetProgressFor,
      currentSessionTag,
      markDone: (fi, size) => { DONE_FILES.add(fi); fileDoneBytes[fi] = size; },
    };
  `
  // eslint-disable-next-line no-new-func
  return new Function(src)()
}

test('⭐ 续传记录必须按会话隔离（换了链接绝不能沿用旧记录）', () => {
  const g = globalThis
  g.__relay = { room: 'a'.repeat(64), salt: 'b'.repeat(32) }
  g.__loc = { host: '127.0.0.1:8080' }
  const t = extractProgressTracker()

  t.resetProgressFor(t.currentSessionTag())
  t.markDone(0, 100)
  t.markDone(1, 200)
  assert.equal(t.DONE_FILES().size, 2, '同一会话内应累积')

  // 换一个房间（新的传输）—— 必须清空
  g.__relay = { room: 'c'.repeat(64), salt: 'b'.repeat(32) }
  t.resetProgressFor(t.currentSessionTag())
  assert.equal(t.DONE_FILES().size, 0,
    '换了链接还沿用旧的跳过集合，会**跳过根本没收到的文件** —— ' +
    '用户拿到残缺目录，比"重传一遍"严重得多')

  // 同一会话再来一次（点重试）—— 必须保留
  t.markDone(0, 100)
  t.resetProgressFor(t.currentSessionTag())
  assert.equal(t.DONE_FILES().size, 1, '同一会话重试时必须保留进度，否则重试等于重来')

  // 局域网模式按源站区分
  g.__relay = null
  t.resetProgressFor(t.currentSessionTag())
  assert.equal(t.DONE_FILES().size, 0, '局域网模式换了源站也要清空')
  delete g.__relay
  delete g.__loc
})

test('续传只跳过**完整校验通过**的文件（半途的文件不能跳）', () => {
  // 这条用源码结构来钉：DONE_FILES.add 必须出现在整体校验之后
  const addAt = html.indexOf('DONE_FILES.add(fi)')
  const verifyAt = html.indexOf("f._ok = f.sha256 ? digest === f.sha256 : null")
  assert.ok(addAt > 0 && verifyAt > 0, '应同时存在整体校验与 DONE_FILES.add')
  assert.ok(addAt > verifyAt,
    'DONE_FILES.add 必须排在整体校验**之后** —— 排在前面就会把' +
    '收到一半的文件也标记为完成，下次重试直接跳过，用户拿到残缺文件')

  // 跳过分支必须存在且按 fi 判断
  assert.match(html, /if \(DONE_FILES\.has\(fi\)\)/,
    '循环里需要有"这个文件已完成 → 跳过"的分支')
})

// ── 中继模式（跨网络）──────────────────────────────────────
// 细节在 test/receiver-relay-tests.js 里，这里只是把它挂上。
registerRelayPageTests(html)

// ── 局域网握手：页面的 MAC 必须与套件实现**逐字节**一致 ─────
//
// 2026-10 演练时才发现的真 bug：页面只签了 `challenge` 本身，漏掉了域分隔前缀
// （套件里是 `flicker/1/recv\n` / `flicker/1/send\n`）。后果不是"少一层防护"，
// 是**局域网模式完全连不上**：两边算出的 MAC 永远不同，页面只会显示"密码不一致"。
//
// 为什么测试没早发现：`test/e2e.test.js` 用的是 Node 侧那份**按协议写**的接收端，
// 而页面这套握手是**另写了一遍**的。这类"两份实现"正是本项目反复吃亏的地方，
// 所以这里直接把页面的函数抠出来，与套件的 receiverMac/senderMac 对比**真实 MAC 值**。

test('⭐ 局域网握手：页面的两种 MAC 构造都必须与套件逐字节一致', () => {
  // 2026-10 起有两种构造（降级保护，见 src/suite/flicker1.js 的 MAC_PROFILES）：
  //   v2 = `套件id\n方向\n` ‖ nonce   （默认；套件被绑进被认证的材料）
  //   v1 = `flicker/1/方向\n` ‖ nonce （0.1.0 的字节，只为了跟老发送端互通）
  // 两种都要与 Node 侧一致 —— 少一种就是"某种对端永远连不上"。
  const m = html.match(/function macInput\(role, challenge, profile[\s\S]*?\n\}/)
  assert.ok(m, '页面里找不到 macInput() —— 握手 MAC 的构造方式变了？')

  // 在沙箱里跑页面那段函数（只需要 TextEncoder 与页面自己的 SUITE 常量，不碰 DOM）
  const suiteLit = html.match(/const SUITE = '([^']+)'/)
  assert.ok(suiteLit, '页面里应当有 SUITE 常量')
  assert.equal(suiteLit[1], SUITE_ID,
    '页面里的套件 id 必须与套件层导出的 SUITE_ID 一致 —— 它是 v2 MAC 前缀的一部分')
  const pageMacInput = new Function('enc', 'SUITE', m[0] + '\nreturn macInput')(
    new TextEncoder(), suiteLit[1])

  const authKey = randomBytes(32)
  const challenge = randomBytes(32)
  const pageMac = (role, profile) =>
    createHmac('sha256', authKey).update(pageMacInput(role, challenge, profile)).digest('hex')

  for (const profile of ['v2', 'v1']) {
    assert.equal(pageMac('recv', profile),
      receiverMac(authKey, challenge, { profile }).toString('hex'),
      `页面算的"接收端 MAC"（${profile}）与套件的 receiverMac 不一致 —— ` +
      '结果是局域网模式下**永远提示密码不一致**')
    assert.equal(pageMac('send', profile),
      senderMac(authKey, challenge, { profile }).toString('hex'),
      `页面算的"校验发送端应答"那一侧（${profile}）也必须与 senderMac 一致`)
    // 两个方向必须不同（域分隔存在的意义）
    assert.notEqual(pageMac('recv', profile), pageMac('send', profile),
      `${profile}：recv 与 send 的 MAC 相同 —— 一个方向的 MAC 可以重放到另一个方向`)
  }
  // 两种构造本身必须不同 —— 否则"绑了套件"就没意义
  assert.notEqual(pageMac('recv', 'v2'), pageMac('recv', 'v1'),
    'v2 与 v1 的 MAC 相同 —— 那 suite_id 就没被绑进认证材料，降级保护形同虚设')

  // 调用点也要真的用上它（防止以后有人"简化"成直接签 challenge）
  //
  // ⚠️ 这里只用"去注释"，不能用 `codeOnly()` —— 它会把字符串字面量抹成 `''`，
  //    于是 `sign('HMAC', …)` 变成 `sign('', …)`，断言就永远匹配不上（第一版就栽在这）。
  const noComments = html
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1 ')
  assert.match(noComments, /sign\('HMAC', keys\.auth, macInput\('recv', challenge, profile\)\)/,
    '接收端 MAC 的调用点必须走 macInput，并带上选定的构造')
  assert.match(noComments, /sign\('HMAC', keys\.auth, macInput\('send', challenge, profile\)\)/,
    '校验发送端应答的调用点必须用**同一套**构造（否则双向认证白做）')
  // 回执：页面必须把自己用的构造告诉发送端（发送端据此发现降级）
  assert.match(noComments, /macProfile: profile/,
    'finish 请求里必须回执 macProfile —— 少了它，发送端就无法发现报价被篡改')
  assert.match(noComments, /pickMacProfile\(ch\.macProfiles\)/,
    '构造必须由发送端的报价挑出来，不能写死')
})

test('⭐ 局域网握手：两种构造的前缀字面值钉死，页面不许"自己发明"', () => {
  // 上一条比的是"页面 vs 套件"，两边同时改错就测不出来。
  // 这条把前缀的**字面值**钉死：它出现在协议与实现里，改它等于改协议。
  const m = html.match(/function macInput\(role, challenge, profile[\s\S]*?\n\}/)
  assert.match(m[0], /'flicker\/1\/' \+ role \+ '\\n'/,
    'v1 的前缀必须是 `flicker/1/<role>\\n` —— 那是 0.1.0 的线上字节，改了老对端就全废')
  assert.match(m[0], /\(suite \+ '\\n' \+ role \+ '\\n'\)/,
    'v2 的前缀必须是 `套件id\\n<role>\\n` —— 套件绑定就是靠它')
})

test('⭐ 拒绝写入权限：小文件给出警告，大文件明确失败（不许静默退到内存模式）', () => {
  // 2026-10 复查发现的问题：`showDirectoryPicker` 的失败被一句
  // "退化到逐个文件询问"合并处理了，于是**用户点"拒绝"**这条最危险的路被静默吞掉：
  // 浏览器明明支持流式写盘（所以那句"你的浏览器不支持"的警告不会触发），
  // 但权限没给 → 页面退到内存里拼装 → 几十 GB 会**传到一半**把浏览器撑爆。
  //
  // 三种失败必须分开处理，这里逐条钉住（用源码判据，因为要跑真对话框才能触发）。
  const catchBlock = html.slice(html.indexOf('showDirectoryPicker({ mode: \'readwrite\''),
    html.indexOf("let lastTick = performance.now(), lastBytes = 0, speed = 0;"))

  assert.match(catchBlock, /AbortError/,
    '用户点"取消"要单独识别（AbortError）—— 那是干净中止，不是失败')
  assert.match(catchBlock, /NotAllowedError/,
    '用户点"拒绝"必须单独识别（Chromium 给的是 NotAllowedError）')
  assert.match(catchBlock, /NO_WRITE_PERMISSION/,
    '大文件 + 拒绝权限必须抛 NO_WRITE_PERMISSION，而不是继续往内存模式走')
  assert.match(catchBlock, /recv\.go\.noPermissionWarn/,
    '小文件 + 拒绝权限要继续，但必须给出明确警告（说明接下来会先收进内存）')

  // 两条路共用同一个阈值常量 —— 各写一个字面值迟早只改一处
  assert.match(html, /const MEMORY_MODE_LIMIT = \d+ \* 1024 \* 1024;/,
    '内存模式的告警线要抽成常量')
  const uses = (html.match(/MEMORY_MODE_LIMIT/g) ?? []).length
  assert.ok(uses >= 3,
    `阈值常量应当被"不支持流式写盘"和"拒绝权限"两处共用（实际出现 ${uses} 次，含定义）`)

  // 错误码要进 KNOWN 列表，否则界面会退化成"出错了 / 未知错误"，
  // 用户看不到"去点允许"这句关键指引
  assert.match(html, /'NO_WRITE_PERMISSION'\]/,
    'NO_WRITE_PERMISSION 必须登记在 fail() 的 KNOWN 列表里')
  const known = html.slice(html.indexOf('const KNOWN = ['), html.indexOf('const key = KNOWN.includes'))
  assert.ok(!/fatal:\s*true/.test(catchBlock),
    '这条错**不该**标成 fatal —— 用户点一次"允许"就能成功，要给重试按钮')
})

test('⭐ 中继发出的页面与 web/receiver.html 是同一份（不许悄悄变成旧版）', async () => {
  // 接收端页面在两处被用到：局域网直连时读 web/receiver.html，
  // 跨网络时读构建产物 relay/page.generated.js。只改页面、忘了重跑
  // gen/gen-relay-page.mjs，症状是"局域网是新版、跨网络是旧版" ——
  // 而这种差异要等到别人反馈才暴露。所以在这里钉住。
  const { RECEIVER_HTML, RECEIVER_HTML_DIGEST } =
    await import('../relay/page.generated.js')
  assert.equal(RECEIVER_HTML, html,
    'relay/page.generated.js 与 web/receiver.html 内容不一致 —— ' +
    '请运行：node gen/gen-relay-page.mjs')
  const now = createHash('sha256').update(html).digest('hex').slice(0, 16)
  assert.equal(RECEIVER_HTML_DIGEST, now,
    '产物里记的指纹和页面现在的指纹不一样 —— 请运行：node gen/gen-relay-page.mjs')
})
