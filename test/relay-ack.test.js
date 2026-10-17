/**
 * 中继的确认（ack）语义 —— 一组真实踩过的缺陷
 * =============================================
 *
 * 三层问题，互相咬在一起，任何一层单独看都像"没问题"：
 *
 * ① **页面从不 ack**（只有一句写着"接收端每取一块都会 ack"的注释）。
 *    中继的队列因此永不回收，发送端的在途计数很快占满窗口。
 * ② **反停滞保护实际不起作用**：它算 `count = min(room, …)`，而它要救的场景
 *    恰恰是 `room === 0` —— 于是 count 也是 0，`putBatch` 收到 0 条直接返回
 *    `aborted`，循环 `break` 出去。
 * ③ **`break` 之后无条件 `return {ok:true}`** —— 于是"没传完"被报成"传输完成"。
 *    实测：接收端不 ack 时，发送端 148 ms 就宣布成功，而只投出 8/13 块、
 *    `ackedBase` 还是 0。用户看到成功，对方什么都没收到。
 *
 * 这三条合起来的效果是：**跨网络传输实际上只能走完一个窗口（8 块）就停住**，
 * 而发送端还会报成功。而 Node 端的 e2e（`test/relay-e2e.test.js`、
 * `_lab/verify-relay.mjs`）里的接收端**是 ack 的**，所以一直没暴露。
 * 验证脚本与真实客户端行为不一致，是这一类缺陷能长期潜伏的根本原因。
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { RoomStore } from '../src/relay/room.js'
import { handleRelay } from '../src/relay/protocol.js'
import { RelaySender } from '../src/relay/sender.js'
import { deriveVerifier, deriveKeys, sealManifest, relayRoomName, PARAMS } from '../src/suite/flicker1.js'
import { scan, toWire, fillHashes } from '../src/manifest.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CHUNKS = 12            // > 窗口 8，才能走到"窗口满"那一路
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 只保留代码，去掉注释。
 *
 * ⚠️ 这个 helper 是必需的，不是讲究：本文件里好几条断言在查"页面里还有没有某个写法"，
 *    而那些写法**正好会出现在解释它们的注释里**（比如"`f.firstChunk + ci` 算出 NaN"）。
 *    用裸正则查会出现"把注释写清楚反而报红、删掉注释才绿"的荒唐结果 ——
 *    断言必须只看代码。
 */
function codeOnly(src) {
  let out = ''
  let state = 'code'
  for (let i = 0; i < src.length; i++) {
    const c = src[i], c2 = src.slice(i, i + 2)
    if (state === 'code') {
      if (c2 === '//') { state = 'line'; i++; continue }
      if (c2 === '/*') { state = 'block'; i++; continue }
      out += c
      continue
    }
    if (state === 'line') { if (c === '\n') { state = 'code'; out += c } continue }
    if (state === 'block') { if (c2 === '*/') { state = 'code'; i++ } continue }
  }
  return out
}

const cleanups = []
// try 住同步抛错、也容忍清理函数返回 undefined —— 否则一处异常会让后面的清理全不跑，
// 子进程攥着管道不放，测试进程永不退出（详见 test/relay-e2e.test.js 里的教训记录）。
after(async () => {
  for (const fn of cleanups.reverse()) {
    try { await fn() } catch (e) { console.error('清理失败：' + (e?.message ?? e)) }
  }
})

async function startRelay() {
  const store = new RoomStore()
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const chunks = []
    for await (const c of req) chunks.push(c)
    const r = await handleRelay(new Request('http://relay' + req.url, {
      method: req.method, body: chunks.length ? Buffer.concat(chunks) : undefined,
    }), url.pathname, store)
    res.writeHead(r.status)
    res.end(Buffer.from(await r.arrayBuffer()))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  cleanups.push(() => new Promise((r) => server.close(r)))
  return { base: `http://127.0.0.1:${server.address().port}`, store }
}

/**
 * 跑一次完整传输。
 * @param {object} o
 * @param {'none'|'each'|'page'} o.ackMode
 *   none —— 完全不 ack（= 页面从前的行为）
 *   each —— 每块 await 一个 ack（= Node 端 e2e 的写法）
 *   page —— **页面现在的写法**：处理完再 ack，不等待、后台合并发送
 * @param {number} o.idleTimeoutMs
 */
async function transfer({ ackMode, idleTimeoutMs = 4000 }) {
  const relay = await startRelay()
  const dir = await mkdtemp(path.join(tmpdir(), 'flicker-ack-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  await writeFile(path.join(dir, 'data.bin'), randomBytes(CHUNKS * PARAMS.chunkBytes))

  const m = await scan([dir], { chunkBytes: PARAMS.chunkBytes })
  await fillHashes(m)
  const wire = toWire(m)
  const salt = randomBytes(PARAMS.saltBytes)
  const keys = deriveKeys(deriveVerifier('ack-test', salt))
  const roomName = relayRoomName(keys)
  const enc = sealManifest(keys.enc, Buffer.from(JSON.stringify(wire), 'utf8'))
  const files = wire.files.map((f, i) => ({
    ...f, index: i, firstChunk: 0, absPath: m.files[i].absPath, _bytes: null, _gift: false,
  }))
  const total = 1 + wire.totalChunks
  const url = (s = '') => `${relay.base}/r/${roomName}${s}`

  const sender = new RelaySender({
    baseUrl: relay.base, roomName, encKey: keys.enc, salt,
    manifest: { ...wire, files }, encManifest: { iv: enc.iv, tag: enc.tag, ct: enc.ct },
    pollMs: 10, windowSize: 8,
  })
  await sender.start()

  // 页面那套：后台合并 ack
  let ackedSeq = -1, lastSent = -1, sending = false
  async function flushAcks() {
    if (sending) return
    sending = true
    try {
      while (ackedSeq > lastSent) {
        const target = ackedSeq
        try {
          const r = await fetch(url(`/ack?upTo=${target}`), { method: 'POST' })
          if (!r.ok && r.status !== 410) break
          lastSent = target
        } catch { break }
      }
    } finally { sending = false }
  }

  let received = 0
  const receiver = (async () => {
    // ⚠️ 顺序要与页面**完全一致**：清单占 seq 0，所以取块是 `1 + chunkSeq`、
    //    ack 也是 `1 + chunkSeq`。
    //    第一版这里按"消息序号"从 0 开始循环，看起来等价，实际掩盖了页面里的
    //    一个 off-by-one（页面取块用了 1+i、ack 却用了 i）—— 于是这个用例绿着，
    //    而真实浏览器里发送端永远等不到完成。**模拟得不像，等于没模拟。**
    for (let chunkSeq = 0; chunkSeq < total - 1; chunkSeq++) {
      const seq = 1 + chunkSeq
      let got = false
      for (let i = 0; i < 120 && !got; i++) {
        const r = await fetch(url(`?seq=${seq}`))
        if (r.ok) { await r.arrayBuffer(); received++; got = true; break }
        const j = await r.json().catch(() => ({}))
        if (j.error === 'NOT_YET') { await sleep(3); continue }
        throw new Error(`取 ${seq}: ${r.status} ${j.error}`)
      }
      if (!got) return                     // 等不到就放弃（模拟接收端超时）
      if (ackMode === 'each') {
        await fetch(url(`/ack?upTo=${seq}`), { method: 'POST' })
        lastSent = seq
      } else if (ackMode === 'page') {
        ackedSeq = 1 + chunkSeq            // 与页面一致：ack 的是消息序号
        flushAcks()                        // 不 await，与页面一致
      }
    }
  })()

  const [result] = await Promise.all([sender.run({ timeoutMs: idleTimeoutMs }), receiver])
  const room = await (await fetch(url())).json()
  await sender.destroy().catch(() => {})
  return { result, received, total, room }
}

// ── ① 不 ack：不能报成功 ────────────────────────────────────

test('⭐ 接收端不 ack 时，发送端**绝不能**报"传输完成"', async () => {
  const r = await transfer({ ackMode: 'none', idleTimeoutMs: 1500 })
  assert.equal(r.result.ok, false,
    '没收到确认就不能说成功 —— \n' +
    '    旧实现在这里返回 {ok:true, reason:"complete"}，而 ackedBase 还是 0。\n' +
    '    用户看到"传输完成"，对方其实一个字节都没拿到。失败被说成成功是最糟的一类错误。')
  assert.notEqual(r.result.reason, 'complete')
  assert.equal(r.room.ackedBase, 0, '没有任何 ack，中继侧就不该有已确认的量')
})

// ── ② 不 ack：窗口是硬上限，且要如实失败 ────────────────────

test('⭐ 接收端不 ack 时：在途不超过窗口，且如实报失败（不是误报成功）', async () => {
  // 这一条钉住的是**安全属性**：中继的队列在内存里，窗口就是给它封顶的。
  //
  // 曾经试过"强制投递时允许超出窗口 1 条"来解开卡死，撤销了 ——
  // 接收端不 ack 时它会一路把队列撑到整个文件大小（传 10 GB 就要中继留 10 GB）。
  // 正确做法是：窗口是硬上限，收不到确认就**如实失败**，让用户重传。
  const r = await transfer({ ackMode: 'none', idleTimeoutMs: 1200 })
  assert.equal(r.result.ok, false, '没有确认就不能算成功')
  assert.notEqual(r.result.reason, 'complete')

  // ⚠️ 队列长度要看 `nextSeq - ackedBase`，**不是** `total - ackedBase`。
  //    第一版写成了后者：total 是"一共多少条消息"，与"中继上现在压着几条"
  //    是两回事。于是发送端明明守住了窗口（只投了 8 条），测试却报"留了 13 条"。
  //    断言写错方向的代价是：它会让人去改一个**没有坏**的地方。
  const queued = r.room.nextSeq - r.room.ackedBase
  assert.ok(queued <= 8,
    `中继队列里压着 ${queued} 条 —— 窗口（8）没兜住。\n` +
    '    窗口必须是在途的**硬上限**：队列在中继内存里，不封顶的话' +
    '接收端不 ack 会把中继撑爆（传 10 GB 就要它留 10 GB）。')
  assert.ok((r.result.posted ?? 0) <= 9, `投出的条数 ${r.result.posted} 超出了窗口上限`)
})

// ── ③ 页面那套 ack 必须能让传输正常收尾 ────────────────────

test('⭐ 页面的合并 ack 能让发送端正常完成，并把中继队列清空', async () => {
  const r = await transfer({ ackMode: 'page', idleTimeoutMs: 8000 })
  // 接收端只取**块**（清单不在这段循环里），所以对照量是 total - 1
  assert.equal(r.received, r.total - 1, '数据要全部收到（清单那条不算）')
  assert.equal(r.result.ok, true,
    `发送端应当报完成，实际 ${JSON.stringify(r.result)}\n` +
    '    页面的 ack 是"后台合并发送"的：不在热路径上等待，但必须真的送到 —— ' +
    '少报最后一条，发送端就会一直等到空闲超时。')
  assert.equal(r.room.ackedBase, r.total, '中继队列应当被清空（否则内存随文件线性增长）')
  assert.equal(r.room.nextSeq - r.room.ackedBase, 0, '队列里不该有残留')
})

test('对照组：每块 await 一个 ack（Node 端 e2e 的写法）同样能完成', async () => {
  const r = await transfer({ ackMode: 'each', idleTimeoutMs: 8000 })
  assert.equal(r.received, r.total - 1)
  assert.equal(r.result.ok, true)
})

// ── ④ 页面接线：ack 必须在写入之后 ──────────────────────────

test('⭐ 页面：中继 transport 提供 ack，且在**写盘之后**调用', () => {
  const html = readFileSync(path.join(ROOT, 'web/receiver.html'), 'utf8')

  // transport 必须真的暴露 ack（从前只有注释，没有实现）
  assert.match(html, /ack:\s*ackChunk/, '中继 transport 必须暴露 ack')
  assert.match(html, /async function flushAcks\(\)/, '要有合并发送的逻辑')
  assert.match(html, /url\('\/ack\?upTo=' \+ target\)/, '要真的发 /ack 请求')

  // 顺序：写盘 → 哈希 → ack。ack 提前的话，中途失败的那一块就再也取不回来了。
  // ⚠️ 锚点跟着实现走，但**判据的含义不变**：
  //    · 取块走预取器（`await prefetch.take(seq)`）—— 只是把"网络那一半"提前；
  //    · 整文件摘要走 `fileHasher.update(pt, …)`（2026-10 起在 Web Worker 里算）——
  //      它仍然在**写盘之后**、**ack 之前**。
  //    任何一次实现调整都要回来改锚点，但"写盘 → 哈希 → ack"这个顺序不许变。
  const anchor = 'const chunk = await prefetch.take(seq)'
  assert.ok(html.includes(anchor),
    `主循环里应当通过预取器取块（找不到 ${anchor}）—— 页面结构变了？`)
  const loop = html.slice(html.indexOf(anchor))
  const iWrite = loop.indexOf('await sink.write(pt)')
  const iHash = loop.indexOf('fileHasher.update(pt')
  const iAck = loop.search(/S\.transport\.ack\?\.\(seq\)/)
  assert.ok(iWrite > 0 && iHash > 0 && iAck > 0, '主循环里应当有写入、哈希与 ack 三步')
  assert.ok(iAck > iWrite, 'ack 必须在写盘**之后** —— ack 会让中继删掉那条消息')
  assert.ok(iAck > iHash, 'ack 也应在校验/哈希之后')

  // 收尾要把最后的 ack 送出去（发送端的完成判据是 ackedBase >= total）
  const done = html.slice(html.indexOf('async done() {', html.indexOf('function relayTransport')))
  assert.match(done.slice(0, 600), /flushAcks\(\)/, 'done() 里要把最后的 ack 送出去')
  assert.match(done.slice(0, 600), /for \(let i = 0; i < \d+/, 'done() 里要重试，不能只发一次')
})

test('⭐ 页面：中继的两处序号偏移都不能少（都是真踩过的 off-by-one）', () => {
  const html = readFileSync(path.join(ROOT, 'web/receiver.html'), 'utf8')
  const relay = codeOnly(html.slice(html.indexOf('function relayTransport'),
    html.indexOf('/** 按链接判断该用哪条通路 */')))

  // ① 取块：清单占 seq 0，所以块 i 要取 `1 + i`
  assert.match(relay, /fetchSeq\(1 \+ seq\)/,
    '取块必须用 `1 + seq`（清单占 seq 0）')

  // ② ack：同样要用消息序号，不能直接拿块序号去 ack。
  //    少了这个 +1，中继的 ackedBase 会永远停在 total-1，
  //    而发送端的完成判据是 `ackedBase >= total` → 它永远等不到完成。
  //    症状很误导：文件其实已经收完了，发送端却一直不结束，最后报"等不到确认"。
  //
  //    ⚠️ 取 ackChunk 的函数体不能靠"到下一个函数为止"来切：
  //       flushAcks 定义在它**前面**，用 indexOf 切出来是空串（第一版就这么错的，
  //       断言恒失败，看着像代码有问题）。这里直接取固定长度的一段。
  const at = relay.indexOf('function ackChunk')
  assert.ok(at > 0, '找不到 ackChunk')
  const ackFn = relay.slice(at, at + 400)
  assert.match(ackFn, /const seq = 1 \+ chunkSeq/,
    'ackChunk 必须把块序号转成消息序号（`1 + chunkSeq`）—— 取块那边用了 +1，ack 这边也必须用')

  // ③ 消息的**类型字节**：中继存的是 `[类型][负载]`，切片前必须先剥掉
  assert.match(relay, /msg\[0\] !== MSG_MANIFEST/, '清单消息要校验类型字节')
  assert.match(relay, /msg\[0\] !== MSG_CHUNK/, '分块消息要校验类型字节')
  assert.match(relay, /const raw = msg\.subarray\(1\)/,
    '必须 `subarray(1)` 剥掉类型字节 —— 用 raw 直接切片会整体差一个字节，\n' +
    '    症状是清单解密失败、界面上一句没法定位的"未知错误"')
})

test('⭐ 页面：块的全局序号由接收端自己累加，不依赖清单里的 firstChunk', () => {
  const html = readFileSync(path.join(ROOT, 'web/receiver.html'), 'utf8')
  // 只看**代码**：那段说明里正好写着 `f.firstChunk + ci`（作为反例），
  // 用裸正则查注释会误报。
  const code = codeOnly(html)
  assert.ok(!/\.firstChunk/.test(code),
    '页面代码里不该再依赖 firstChunk —— 那个字段可能不存在（见 prepare.js 的说明）')
  assert.match(code, /f\._first = ord; ord \+= f\.chunks/,
    '应当自己累加出每个文件的起始块号')
  assert.match(code, /const seq = f\._first \+ ci/)
})
