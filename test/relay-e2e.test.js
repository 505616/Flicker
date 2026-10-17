/**
 * 中继端到端测试
 * ==============
 * 用**真实的 RelaySender + RelayClient + 协议层**跑完整流程：
 *
 *   发送端（RelaySender）──HTTP──▶ 本地假中继 ──HTTP──▶ 接收端（本测试扮演）
 *
 * 假中继就是把 src/relay/protocol.js 挂到一个普通的 Node HTTP 服务上 ——
 * 与 Cloudflare Worker 用的是**同一份协议实现**，所以这里验证过的行为
 * 在真中继上同样成立。
 *
 * 这里要证明的三件事：
 *   ① 文件能逐字节送达（含满块、不齐的尾块、空文件、多文件）
 *   ② 中继上流动的**永远是密文**（测试直接检查中继侧看到的字节）
 *   ③ 用完即销毁（传输结束后房间消失）
 *
 * 文件末尾另有一组**真 CLI 用例**：起真子进程跑 `flicker send --relay=…`。
 * 上面这些用的是进程内的 RelaySender，而中继模式的**编排**在
 * `src/relay/run-relay.js` 里（问能力 → 选块大小 → 建房间 → 报链接 → 等确认 → 销毁），
 * 那一段此前是零 CI 覆盖。理由与判据写在那一组的开头。
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { randomBytes, createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { RoomStore } from '../src/relay/room.js'
import { handleRelay, unpackMessage, MSG } from '../src/relay/protocol.js'
import { RelaySender } from '../src/relay/sender.js'
import { chooseChunkBytes, fetchRelayCaps } from '../src/chunk-size.js'
import {
  deriveVerifier, deriveKeys, sealManifest, relayRoomName, PARAMS,
  chunkIV, chunkAAD, MANIFEST_AAD,
} from '../src/suite/flicker1.js'
import { createDecipheriv } from 'node:crypto'
import { scan, toWire, fillHashes } from '../src/manifest.js'
import { EXIT } from '../src/destroy.js'

const cleanups = []
const MiB = 1 << 20
/**
 * 收尾：跑完所有登记的清理。
 *
 * ⚠️ 必须 `try` 住**同步**抛错，也必须容忍清理函数返回 `undefined`。
 *    原来的写法是 `await fn().catch(() => {})` —— 它只能接住"返回的 Promise 被 reject"：
 *    清理函数自己同步抛错、或者干脆没写 `return`（返回 undefined）时，
 *    这一句会当场抛 `TypeError: Cannot read properties of undefined (reading 'catch')`，
 *    于是**后面的清理一个都不跑**：服务不关、子进程攥着 stdout 管道不放，
 *    node 测试进程永远不退出（表象是"三条用例全绿，进程却挂着不走"）。
 *    2026-10 实测踩过一次，定位花的时间比写用例还长。
 */
after(async () => {
  for (const fn of cleanups.reverse()) {
    try { await fn() } catch (e) { console.error('清理失败：' + (e?.message ?? e)) }
  }
})

/**
 * 起一个本地假中继。
 * 它会记录**中转过的每一个字节**，供"中继只能看到密文"那条断言使用。
 */
/**
 * 起一个本地假中继。
 *
 * @param {object} [opts]
 * @param {number} [opts.maxMessageBytes] 单条上限（默认 = 本项目部署的 2 MiB + 17）
 * @param {boolean} [opts.legacy] 模拟**老中继**：`/health` 返回纯文本 "ok"、
 *   创建响应里也不带 `maxMessageBytes`。2026-10 之前部署的中继就是这个样子 ——
 *   新客户端必须能安全地回落到 1 MiB，否则"升级客户端"会把老部署全打死。
 */
async function startFakeRelay(opts = {}) {
  const store = new RoomStore(opts.maxMessageBytes ? { maxMessageBytes: opts.maxMessageBytes } : {})
  const seen = []           // 中继侧看到的消息原文
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = Buffer.concat(chunks)

    // 记账：中继看到了什么
    if (url.pathname.startsWith('/r/') && body.length) seen.push(Buffer.from(body))

    // 模拟老中继：/health 是纯文本，创建响应里没有能力字段
    if (opts.legacy && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('ok')
      return
    }

    const req2 = new Request('http://relay' + req.url, {
      method: req.method,
      headers: Object.fromEntries(Object.entries(req.headers).filter(([, v]) => v !== undefined)),
      body: body.length ? body : undefined,
    })
    const r = await handleRelay(req2, url.pathname, store)
    let buf = Buffer.from(await r.arrayBuffer())
    if (opts.legacy) {
      // 老中继不知道这个字段：把它从响应里摘掉，逼客户端走回落路径
      try {
        const j = JSON.parse(buf.toString('utf8'))
        if (j && typeof j === 'object' && 'maxMessageBytes' in j) {
          delete j.maxMessageBytes
          buf = Buffer.from(JSON.stringify(j), 'utf8')
        }
      } catch { /* 不是 JSON 就原样返回 */ }
    }
    const headers = {}
    r.headers.forEach((v, k) => { headers[k] = v })
    if (opts.legacy) headers['content-length'] = String(buf.length)
    res.writeHead(r.status, headers)
    res.end(buf)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  // ⚠️ 必须先掐掉 keep-alive 连接，再 close()。
  //    只调 close() 的话，它会一直等已有连接结束 —— 而 fetch（undici）默认保留
  //    空闲连接约 4 秒、http 服务的 keepAliveTimeout 是 5 秒，于是"关服务"这一步
  //    偶尔会卡到超时甚至一直不返回：表现为**整个测试文件跑完却不退出**
  //    （2026-10 实测：三条真 CLI 用例全绿，进程却挂着不走）。
  //    closeAllConnections() 是 Node 18.2+ 的正式 API，测试里正合适。
  cleanups.push(() => new Promise((r) => {
    server.closeAllConnections()
    server.close(() => r())
  }))
  return { base: `http://127.0.0.1:${port}`, store, seen }
}

/** 扮演接收端：从假中继按序取消息、解密、还原文件 */
async function receiveAll({ base, roomName, password, outDir }) {
  const url = (s = '') => `${base}/r/${roomName}${s}`

  // 取清单
  let manifestMsg = null
  for (let i = 0; i < 100 && !manifestMsg; i++) {
    const r = await fetch(url('?seq=0'))
    if (r.status === 200) { manifestMsg = new Uint8Array(await r.arrayBuffer()); break }
    if (r.status !== 404) throw new Error(`取清单失败: HTTP ${r.status}`)
    await new Promise((x) => setTimeout(x, 50))
  }
  assert.ok(manifestMsg, '应能从中继取到清单')

  const { type, payload } = unpackMessage(manifestMsg)
  assert.equal(type, MSG.MANIFEST)

  // ⚠️ subarray 返回的是 Uint8Array 视图，而 deriveVerifier 按设计只接受 Buffer
  //    （长度校验会拒绝其他类型）。用 Buffer.from 复制一份并明确类型。
  const salt = Buffer.from(payload.subarray(0, 16))
  const iv = Buffer.from(payload.subarray(16, 28))
  const tag = Buffer.from(payload.subarray(28, 44))
  const ct = Buffer.from(payload.subarray(44))

  // 用密码派生密钥 —— 这一步证明"密码一致才能解开"
  const keys = deriveKeys(deriveVerifier(password, salt))
  assert.equal(relayRoomName(keys), roomName, '密码必须能算出同一个房间名')

  const d = createDecipheriv('aes-256-gcm', keys.enc, iv, { authTagLength: 16 })
  d.setAAD(MANIFEST_AAD); d.setAuthTag(tag)
  const wire = JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8'))

  // 逐块取回并按序解密。
  // ⚠️ 清单的**线上格式**里没有 firstChunk —— 那是接收端自己累计出来的
  //    （见 src/manifest.js 的 fromWire）。漏了这一步会让序号变成 NaN。
  const written = []
  let ordinal = 0
  for (let fi = 0; fi < wire.files.length; fi++) {
    const f = wire.files[fi]
    f.firstChunk = ordinal
    ordinal += f.chunks
    const full = path.join(outDir, f.rel)
    await mkdir(path.dirname(full), { recursive: true })
    const parts = []
    for (let ci = 0; ci < f.chunks; ci++) {
      const seq = 1 + f.firstChunk + ci
      let buf = null
      for (let i = 0; i < 400 && !buf; i++) {          // 发送端是按需投递的，要等
        const r = await fetch(url(`?seq=${seq}`))
        if (r.status === 200) { buf = new Uint8Array(await r.arrayBuffer()); break }
        if (r.status !== 404) throw new Error(`取分块 ${seq} 失败: HTTP ${r.status}`)
        await new Promise((x) => setTimeout(x, 40))
      }
      assert.ok(buf, `应能取到分块 ${seq}`)
      const { type: t, payload: p } = unpackMessage(buf)
      assert.equal(t, MSG.CHUNK)
      const ctag = Buffer.from(p.subarray(0, 16))
      const cct = Buffer.from(p.subarray(16))
      const plainLen = Math.min(f.chunkBytes, f.size - ci * f.chunkBytes)
      const dd = createDecipheriv('aes-256-gcm', keys.enc, chunkIV(ci), { authTagLength: 16 })
      dd.setAAD(chunkAAD(fi, ci, f.chunks, plainLen)); dd.setAuthTag(ctag)
      const pt = Buffer.concat([dd.update(cct), dd.final()])
      assert.equal(pt.length, plainLen, `分块 ${seq} 长度不符`)
      parts.push(pt)
      // 逐条确认 —— 中继随即删除
      const ack = await fetch(url(`/ack?upTo=${seq}`), { method: 'POST' })
      assert.equal(ack.status, 200, `确认 ${seq} 应成功`)
    }
    await writeFile(full, Buffer.concat(parts))
    written.push({ rel: f.rel, size: f.size })
  }
  return { wire, written, manifestBytes: manifestMsg.length }
}

/** 造一棵测试文件树并算出清单（与真实发送端同一条代码路径） */
async function makeManifest(files) {
  return makeManifestWithChunk(files, PARAMS.chunkBytes)
}

/** 同上，但可以指定块大小（能力协商会改变它，见对应的用例） */
async function makeManifestWithChunk(files, chunkBytes) {
  const dir = await mkdtemp(path.join(tmpdir(), 'flicker-relay-e2e-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, content)
  }
  const m = await scan([dir], { chunkBytes })
  await fillHashes(m)
  return { dir, manifest: m, wire: toWire(m) }
}

/** 组装一个完整的发送端（内部用真实的 RelaySender） */
async function bootSender({ relayBase, password, manifest, wire, limiter }) {
  const salt = randomBytes(PARAMS.saltBytes)
  const keys = deriveKeys(deriveVerifier(password, salt))
  const roomName = relayRoomName(keys)
  const enc = sealManifest(keys.enc, Buffer.from(JSON.stringify(wire), 'utf8'))

  const files = wire.files.map((f, i) => {
    const src = manifest.files[i]
    return {
      kind: f.kind, name: f.name, rel: f.rel, size: f.size,
      chunks: f.chunks, chunkBytes: f.chunkBytes,
      index: i, firstChunk: 0,
      absPath: src.absPath, _bytes: null, _gift: false,
    }
  })
  let g = 0
  for (const f of files) { f.firstChunk = g; g += f.chunks }

  const events = []
  const sender = new RelaySender({
    baseUrl: relayBase, roomName, encKey: keys.enc, salt,
    manifest: { ...wire, files, totalChunks: g },
    encManifest: { iv: enc.iv, tag: enc.tag, ct: enc.ct },
    onEvent: (e) => events.push(e),
    pollMs: 40,
    limiter: limiter ?? null,
  })
  const link = await sender.start()
  return { sender, roomName, keys, link, events, salt }
}

// ── 用例 ────────────────────────────────────────────────────

test('端到端：经中继逐字节送达（多文件、满块、不齐尾块、空文件）', { timeout: 180000 }, async () => {
  const relay = await startFakeRelay()
  const out = await mkdtemp(path.join(tmpdir(), 'flicker-relay-out-'))
  cleanups.push(() => rm(out, { recursive: true, force: true }))

  // 覆盖各种形态：满块(1MiB)、不齐尾块、空文件、小文件、中文路径
  const { manifest, wire } = await makeManifest({
    'full.bin': randomBytes(PARAMS.chunkBytes),              // 正好一块
    'odd.bin': randomBytes(PARAMS.chunkBytes + 12345),       // 两块，尾块不齐
    'empty.dat': Buffer.alloc(0),                            // 空文件
    'hello.txt': Buffer.from('hello relay 世界', 'utf8'),
    '照片/sunset.bin': randomBytes(5000),
  })

  const { sender, roomName } = await bootSender({
    relayBase: relay.base, password: 'relay-e2e-password', manifest, wire,
  })

  // 一边发一边收
  const runP = sender.run({ timeoutMs: 120000 })
  const recvP = receiveAll({
    base: relay.base, roomName, password: 'relay-e2e-password', outDir: out,
  })
  const [run, recv] = await Promise.all([runP, recvP])

  assert.equal(run.ok, true, `发送端应报告完成，实际: ${run.reason}`)
  assert.equal(recv.written.length, wire.files.length, '文件数应一致')

  // 逐字节比对
  for (const w of recv.written) {
    const a = await readFile(path.join(manifest.files.find((f) => f.rel === w.rel).absPath))
    const b = await readFile(path.join(out, w.rel))
    assert.equal(Buffer.compare(a, b), 0, `${w.rel} 内容不一致`)
  }
  // 空文件必须真的被创建
  const empty = await readFile(path.join(out, manifest.files.find((f) => f.rel.endsWith('empty.dat')).rel))
  assert.equal(empty.length, 0)
})

test('⭐ 能力协商：中继声明 2 MiB → 用 2 MiB 的块跑通；老中继不声明 → 回落到 1 MiB 也跑通', { timeout: 240000 }, async () => {
  // 这一条把"能力协商"从单元测试抬到**真的传一遍**：
  //   · 新中继（/health 带 maxMessageBytes）→ 客户端自动选 2 MiB 的块，
  //     满块正好是 2 MiB + 17（中继的默认上限），一个字节都不能超；
  //   · 老中继（纯文本 /health、创建响应没有该字段）→ 必须回落到 1 MiB，
  //     否则"升级客户端"会把所有已部署的老中继打死（413 TOO_LARGE）。
  for (const scenario of [
    { name: '新中继（声明 2 MiB）', legacy: false, expectChunk: 2 * MiB },
    { name: '老中继（不声明）', legacy: true, expectChunk: PARAMS.chunkBytes },
  ]) {
    const relay = await startFakeRelay({ legacy: scenario.legacy })
    const caps = await fetchRelayCaps(relay.base)
    assert.equal(caps.legacy, scenario.legacy,
      `${scenario.name}: 能力探测应当${scenario.legacy ? '' : '不'}走回落路径`)
    const { chunkBytes } = chooseChunkBytes({ spec: { kind: 'auto' }, maxMessageBytes: caps.maxMessageBytes })
    assert.equal(chunkBytes, scenario.expectChunk,
      `${scenario.name}: 自动模式应当选 ${scenario.expectChunk / MiB} MiB`)

    const out = await mkdtemp(path.join(tmpdir(), 'flicker-relay-caps-'))
    cleanups.push(() => rm(out, { recursive: true, force: true }))
    // 故意用"正好一块 + 不齐尾块"，把边界也走到
    const { manifest, wire } = await makeManifestWithChunk({
      'full.bin': randomBytes(chunkBytes),
      'odd.bin': randomBytes(chunkBytes + 4321),
    }, chunkBytes)

    const { sender, roomName, events } = await bootSender({
      relayBase: relay.base, password: 'caps-password', manifest, wire,
    })
    const runP = sender.run({ timeoutMs: 120000 })
    const recvP = receiveAll({
      base: relay.base, roomName, password: 'caps-password', outDir: out,
    })
    const [run, recv] = await Promise.all([runP, recvP])

    assert.equal(run.ok, true, `${scenario.name}: 发送端应报告完成（${run.reason}）`)
    assert.equal(recv.written.length, wire.files.length)
    for (const w of recv.written) {
      const a = await readFile(manifest.files.find((f) => f.rel === w.rel).absPath)
      const b = await readFile(path.join(out, w.rel))
      assert.equal(Buffer.compare(a, b), 0, `${scenario.name}: ${w.rel} 内容不一致`)
    }
    // 每一位块序号都要被确认（完成判据的硬要求）
    assert.ok(events.some((e) => e.type === 'relay-complete'), '应当收到完成事件')
  }
})

test('⭐ 中继上流动的永远是密文（直接检查中继侧看到的字节）', { timeout: 180000 }, async () => {
  const relay = await startFakeRelay()
  const out = await mkdtemp(path.join(tmpdir(), 'flicker-relay-out2-'))
  cleanups.push(() => rm(out, { recursive: true, force: true }))

  // 放一段高度可识别的明文，以及一个可识别的文件名
  const marker = 'TOPSECRET-MARKER-绝不该出现在中继上'
  const { manifest, wire } = await makeManifest({
    '机密文件.txt': Buffer.from(marker.repeat(50), 'utf8'),
  })

  const { sender, roomName } = await bootSender({
    relayBase: relay.base, password: 'confidentiality-check', manifest, wire,
  })
  const runP = sender.run({ timeoutMs: 120000 })
  await receiveAll({ base: relay.base, roomName, password: 'confidentiality-check', outDir: out })
  await runP

  assert.ok(relay.seen.length >= 2, `中继应转发了至少 2 条消息，实际 ${relay.seen.length}`)

  const all = Buffer.concat(relay.seen)
  // 明文标记不该出现
  assert.equal(all.indexOf(Buffer.from(marker, 'utf8')), -1,
    '明文标记绝不能出现在中继转发的数据里')
  assert.equal(all.toString('latin1').includes('TOPSECRET'), false)
  // 文件名也不该出现（清单是加密的）
  assert.equal(all.indexOf(Buffer.from('机密文件.txt', 'utf8')), -1,
    '文件名绝不能出现在中继上 —— 清单是加密的')
  assert.equal(all.toString('utf8').includes('.txt'), false, '连扩展名都不该泄露')
})

test('⭐ 密码不对就打不开（房间名都算不出来）', { timeout: 180000 }, async () => {
  const relay = await startFakeRelay()
  const out = await mkdtemp(path.join(tmpdir(), 'flicker-relay-out3-'))
  cleanups.push(() => rm(out, { recursive: true, force: true }))

  const { manifest, wire } = await makeManifest({ 'a.txt': Buffer.from('secret') })
  const { sender, roomName } = await bootSender({
    relayBase: relay.base, password: 'the-right-one', manifest, wire,
  })
  const runP = sender.run({ timeoutMs: 30000 })

  // 用错误密码算房间名：得到的是另一个房间，什么都没有
  const wrongKeys = deriveKeys(deriveVerifier('the-wrong-one', randomBytes(PARAMS.saltBytes)))
  const wrongRoom = relayRoomName(wrongKeys)
  assert.notEqual(wrongRoom, roomName, '不同密码必须得到不同房间名')

  // ⚠️ 这条 fetch 是**后台**跑的，必须自己接住失败。
  //    它和下面的 teardown 并发，若此刻中继已经被关掉，
  //    拒绝就会以 unhandledRejection 的形式记到**这个**用例头上
  //    （表现是"用例已经结束却有异步活动"）。接住了才只剩断言本身。
  const r = await fetch(`${relay.base}/r/${wrongRoom}?seq=0`)
    .catch((e) => ({ status: 0, _err: e }))
  assert.equal(r.status, 404, `错误密码算出的房间应该不存在，实际 ${r.status}${r._err ? ` (${r._err.message})` : ''}`)

  await sender.destroy().catch(() => {})
  await runP
})

test('⭐ 用完即销毁：传输结束后房间从中继上消失', { timeout: 180000 }, async () => {
  const relay = await startFakeRelay()
  const out = await mkdtemp(path.join(tmpdir(), 'flicker-relay-out4-'))
  cleanups.push(() => rm(out, { recursive: true, force: true }))

  const { manifest, wire } = await makeManifest({ 'x.txt': Buffer.from('bye') })
  const { sender, roomName } = await bootSender({
    relayBase: relay.base, password: 'destroy-check', manifest, wire,
  })

  const runP = sender.run({ timeoutMs: 60000 })
  await receiveAll({ base: relay.base, roomName, password: 'destroy-check', outDir: out })
  const run = await runP
  assert.equal(run.ok, true)

  // 房间还在（发送端没主动销毁），但消息应已被全部消费
  const st = await (await fetch(`${relay.base}/r/${roomName}`)).json()
  assert.equal(st.pending, 0, '全部消费后中继上不应留下任何消息')

  // 主动销毁
  assert.equal(await sender.destroy(), true)
  assert.equal((await fetch(`${relay.base}/r/${roomName}`)).status, 404,
    '销毁后房间必须立刻不可用')
})

test('投递是拉取式的：接收端不取，发送端就不会把整份文件堆到中继上', { timeout: 180000 }, async () => {
  const relay = await startFakeRelay()
  const { manifest, wire } = await makeManifest({
    'big.bin': randomBytes(5 * PARAMS.chunkBytes),        // 5 块
  })
  const { sender, roomName } = await bootSender({
    relayBase: relay.base, password: 'pull-model', manifest, wire,
  })

  // 只让发送端跑一会儿，接收端什么都不做
  const runP = sender.run({ timeoutMs: 8000 })
  await new Promise((r) => setTimeout(r, 1200))

  const st = await (await fetch(`${relay.base}/r/${roomName}`)).json()
  // 没有任何 ack，所以在途消息必须被**窗口**挡住，不能无限堆积。
  // 窗口默认 8；这里 sender 没传 windowSize，所以按默认值断言。
  //
  // ⚠️ 这条用例只能证明**上界**：它的文件只有 5 块（共 6 条消息），
  //    连一窗都装不满，所以"每轮投满一整窗、不减在途"那种写法
  //    在这里也是 6 条 —— 照样通过。
  //    真正证明"窗口是上限"的是下面那条"窗口设为 1"的用例：
  //    它用 4 块（5 条）的文件 + 窗口 1，把超发直接暴露成 5 条在途。
  const inFlight = st.nextSeq - st.ackedBase
  assert.ok(inFlight <= 8,
    `在途消息必须受窗口约束（默认 8），实际 ${inFlight} 条 —— ` +
    '若这里是全部块数，说明窗口没生效，发送端把整份文件堆到了中继上')
  assert.ok(inFlight >= 1, '应该至少投递了一条（否则流水线没动起来）')
  assert.equal(st.ackedBase, 0, '没有接收端时不应有任何确认')

  await sender.destroy().catch(() => {})
  await runP
})

test('中继不可达时给出清晰错误，而不是静默卡住', { timeout: 60000 }, async () => {
  const { manifest, wire } = await makeManifest({ 'a.txt': Buffer.from('x') })
  const salt = randomBytes(PARAMS.saltBytes)
  const keys = deriveKeys(deriveVerifier('unreachable', salt))
  const enc = sealManifest(keys.enc, Buffer.from(JSON.stringify(wire), 'utf8'))
  const files = wire.files.map((f, i) => ({
    ...f, index: i, firstChunk: 0, absPath: manifest.files[i].absPath, _bytes: null, _gift: false,
  }))
  const sender = new RelaySender({
    baseUrl: 'http://127.0.0.1:1',      // 一个必然连不上的地址
    roomName: relayRoomName(keys), encKey: keys.enc, salt,
    manifest: { ...wire, files }, encManifest: { iv: enc.iv, tag: enc.tag, ct: enc.ct },
    pollMs: 40,
  })
  await assert.rejects(() => sender.start(), (e) => {
    assert.ok(e instanceof Error, '应抛出错误')
    return true
  }, '中继不可达时必须明确报错')
})

// ── 回归：完成判据必须等接收端确认 ──────────────────────────

test('⭐ 完成判据必须等接收端确认，而不是"我投完了就算完"（真实踩过的 bug）', { timeout: 180000 }, async () => {
  // 现场记录（实测日志）：
  //   [done-check] posted=6 total=6 pending=0 ackedBase=5 → 误报完成 → 销毁房间
  //   接收端只确认了 5 条（共 6 条），第 6 条它取走了但还没确认，
  //   房间一销毁，那条数据对方就永远拿不到了。
  //
  // 所以判据必须是 ackedBase >= total（接收端明确确认收下了全部），
  // 而不能是 "posted >= total && pending === 0"。
  //
  // 这里直接对**被修的那条判据**做验证 —— 构造精确的中间状态在这个
  // 拉取式协议里很脆（发送端会主动补投，pending 不等于 1），
  // 而判据本身才是回归的重点。
  const relay = await startFakeRelay()
  const { manifest, wire } = await makeManifest({
    'a.bin': randomBytes(2 * PARAMS.chunkBytes + 100),
  })
  const { sender } = await bootSender({
    relayBase: relay.base, password: 'ack-gate-test', manifest, wire,
  })
  const total = 1 + wire.files.reduce((s, f) => s + f.chunks, 0)

  const runP = sender.run({ timeoutMs: 60000 })

  // 让发送端把前几条投出去、并被确认若干次，形成"有进展"的状态
  await new Promise((r) => setTimeout(r, 400))
  let settled = false
  runP.then(() => { settled = true })

  // 关键断言：只要接收端还没确认完，发送端就不许结束。
  // （把全部消息都取走但不确认 —— 此时 pending 会归零，
  //   如果判据只看 pending，发送端就会在这里误报完成。）
  const url = (s = '') => `${relay.base}/r/${sender.client.room ?? ''}${s}`
  for (let seq = 0; seq < total; seq++) {
    for (let i = 0; i < 200; i++) {
      const r = await fetch(`${relay.base}/r/${sender.client.room}?seq=${seq}`)
      if (r.ok) { await r.arrayBuffer(); break }
      await new Promise((x) => setTimeout(x, 25))
    }
    if (seq >= 1) {
      // 确认前一条 —— 但**永不确认最后一条**
      await fetch(`${relay.base}/r/${sender.client.room}/ack?upTo=${seq - 1}`, { method: 'POST' })
    }
    await new Promise((x) => setTimeout(x, 30))
  }

  await new Promise((r) => setTimeout(r, 800))
  const st = await (await fetch(`${relay.base}/r/${sender.client.room}`)).json()
  assert.ok(st.ackedBase < total,
    `接收端应还差至少一条没确认（ackedBase=${st.ackedBase} total=${total}）`)
  assert.equal(settled, false,
    '接收端还没确认完，发送端就不该结束 —— ' +
    '否则它一销毁房间，那条没确认的数据对方就永远拿不到了')

  // 补上确认 → 这时才该完成
  await fetch(`${relay.base}/r/${sender.client.room}/ack?upTo=${total - 1}`, { method: 'POST' })
  const run = await Promise.race([
    runP,
    new Promise((r) => setTimeout(() => r({ ok: 'timeout' }), 15000)),
  ])
  assert.equal(run.ok, true, '接收端确认完毕后，发送端才应报告完成')

  await sender.destroy().catch(() => {})
})

test('提前销毁会让接收端拿不到数据（说明为什么上面的判据是必需的）', { timeout: 180000 }, async () => {
  // 反向验证：如果发送端在接收端取完之前就销毁房间，数据是真的会丢。
  // 这条用例存在的意义是证明"上面那条不是洁癖"。
  const relay = await startFakeRelay()
  const { manifest, wire } = await makeManifest({
    'b.bin': randomBytes(3 * PARAMS.chunkBytes),
  })
  const { sender, roomName } = await bootSender({
    relayBase: relay.base, password: 'early-destroy', manifest, wire,
  })
  const url = (s = '') => `${relay.base}/r/${roomName}${s}`
  const runP = sender.run({ timeoutMs: 60000 })

  // 只取第一条，然后直接销毁
  for (let i = 0; i < 300; i++) {
    const r = await fetch(url('?seq=0'))
    if (r.ok) break
    await new Promise((x) => setTimeout(x, 30))
  }
  await sender.destroy()
  await runP.catch(() => {})

  // 后面的分块已经取不到了
  const r = await fetch(url('?seq=1'))
  assert.equal(r.status, 404, '房间销毁后剩下的数据确实拿不到了 —— 所以完成判据必须严格')
})

test('⭐ 限速接在中继路径上，且按**明文字节**计账', { timeout: 180000 }, async () => {
  // 局域网模式的限速在 test/e2e.test.js 里验过（真实 HTTPS、真实耗时）。
  // 中继模式走的是另一条代码路径（RelaySender 主循环里的"投递前取额度"），
  // 需要单独证明"它确实被调用了、而且算的是明文字节数"。
  //
  // 做法：注入一个**记录用的**限速器（立刻返回、不真等待），
  // 这样既验证接线，又不让用例跑上几秒。真实速率准确性由 test/rate.test.js 负责。
  const relay = await startFakeRelay()
  const out = await mkdtemp(path.join(tmpdir(), 'flicker-relay-rate-'))
  cleanups.push(() => rm(out, { recursive: true, force: true }))

  const CHUNKS = 4
  const { manifest, wire } = await makeManifest({
    'big.bin': randomBytes(CHUNKS * PARAMS.chunkBytes),
  })
  const calls = []
  const limiter = {
    enabled: true,
    rate: 512 * 1024,
    capacity: 512 * 1024,
    waitedMs: 0,
    async take(n, isAborted) {
      calls.push(n)
      // 中止判据必须被传进来（等待期间用户可能点取消）
      assert.equal(typeof isAborted, 'function', 'take() 应收到中止判据')
    },
  }

  const { sender, roomName } = await bootSender({
    relayBase: relay.base, password: 'rate-check', manifest, wire, limiter,
  })
  const runP = sender.run({ timeoutMs: 60000 })
  await receiveAll({ base: relay.base, roomName, password: 'rate-check', outDir: out })
  const run = await runP
  assert.equal(run.ok, true, '限速不该影响传输的正确性')

  assert.ok(calls.length >= 1,
    '中继路径必须调用限速器 —— 否则 --rate 在中继模式下是空配置')
  const total = calls.reduce((a, b) => a + b, 0)
  const expectBytes = CHUNKS * PARAMS.chunkBytes
  assert.equal(total, expectBytes,
    `限速额度应按**明文字节**累计：期望 ${expectBytes}，实际 ${total}。` +
    '若明显偏小，说明按"块数"或"密文长度"算错了')
  // 每一批的额度都不该超过剩余总量
  assert.ok(calls.every((n) => n > 0 && n <= expectBytes), '每次取额度都应是正整数')
})

test('窗口设为 1 时退回停等行为（只有一条在途）', { timeout: 180000 }, async () => {
  // 流水线是性能优化，但"停等"这个行为本身仍然要可用 ——
  // 它是排查问题时的对照，也是低带宽场景下的省流选择。
  const relay = await startFakeRelay()
  const { manifest, wire } = await makeManifest({
    'big.bin': randomBytes(4 * PARAMS.chunkBytes),
  })
  const { sender } = await bootSender({
    relayBase: relay.base, password: 'window-one', manifest, wire,
  })
  sender.windowSize = 1

  const runP = sender.run({ timeoutMs: 8000 })
  await new Promise((r) => setTimeout(r, 1200))

  // 房间名不在 client 上，直接从 sender 拿链接里的
  const room = sender.link().split('#k=')[1].split('&')[0]
  const st2 = await (await fetch(`${relay.base}/r/${room}`)).json()
  assert.ok(st2.nextSeq - st2.ackedBase <= 2,
    `窗口为 1 时在途不该超过 2，实际 ${st2.nextSeq - st2.ackedBase}`)

  await sender.destroy().catch(() => {})
  await runP
})

// ══════════════════════════════════════════════════════════════
// 真 CLI：用户真正会执行的那条命令
// ══════════════════════════════════════════════════════════════
//
// 为什么单独立一组：上面所有用例都是**在进程内**拼出发送端（直接 new RelaySender），
// 而中继模式的**编排**在 `src/relay/run-relay.js` 里 —— 它只被 bin/flicker.js 引用，
// `test/` 里此前**一次都没提到过它**（`_lab/verify-relay.mjs` 之类的手工脚本跑过，
// 但手工脚本不进 CI，也不会在别人改坏它的时候响）。
//
// 这条路径值得被机器守住：它是"双方都不用装东西、还能过公网"的唯一通路，
// 而且比局域网模式多了几步容易写错的顺序（能力协商必须在**扫描与哈希之前**，
// 否则清单里的 chunkBytes 与逐块哈希对不上）。
//
// 顺带一个好处：中继模式**不需要证书**（没有本地 HTTPS 服务），
// 所以这组用例不需要 `--machine-cert`，也不碰系统信任库 —— 比局域网那组干净。

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CLI = path.join(root, 'bin', 'flicker.js')

/** 去掉终端颜色（断言输出文本前先剥掉，免得被 ANSI 序列干扰） */
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '')

/**
 * 起一个**真的**发送端子进程（`flicker send --relay=…`），等它报出房间号。
 *
 * `--machine` 是程序给自动化客户端的正式接口：只输出
 * `__READY__ <链接去掉 fragment> <房间名>`（局域网模式同样用它，见 test/e2e.test.js）。
 * 房间名是**密码派生**出来的，所以接收端只要知道密码就能算出同一个名字 ——
 * 这正是"双方输入同一个密码"在协议上的样子。
 *
 * @param {object} o
 * @param {string} o.relayBase 假中继地址
 * @param {string[]} o.files 要发送的文件（绝对路径）
 * @param {string} o.password 一次性密码
 * @param {string[]} [o.extra] 追加的命令行选项（如 `--timeout=2s`）
 * @param {boolean} [o.gift] 带上默认赠品（默认 false = 加 `--no-gift`，跑得快）
 * @param {string} [o.cwd] 子进程的工作目录（默认仓库根；插件往 cwd 写文件时用它隔离）
 */
function startRelayCli({ relayBase, files, password, extra = [], gift = false, cwd = root }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      CLI, 'send', ...files,
      `--relay=${relayBase}`, `--password=${password}`,
      '--machine', '--no-qr', '--no-color', ...(gift ? [] : ['--no-gift']), ...extra,
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, cwd })
    // 子进程攥着管道不放会让整个测试进程退不出去 —— 登记清理，绝不留下孤儿进程
    cleanups.push(() => { try { child.kill() } catch { /* 已退出 */ } })

    let out = '', err = '', settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch { /* 已退出 */ }
      reject(new Error(`发送端 60 秒内没报出房间号\nstdout:\n${out}\nstderr:\n${err}`))
    }, 60000)

    const onData = (buf, isErr) => {
      const s = buf.toString()
      if (isErr) err += s; else out += s
      const m = out.match(/__READY__ (\S+) (\S+)/)
      if (m && !settled) {
        settled = true
        clearTimeout(timer)
        resolve({ child, base: m[1], room: m[2], getOut: () => out, getErr: () => err })
      }
    }
    child.stdout.on('data', (b) => onData(b, false))
    child.stderr.on('data', (b) => onData(b, true))
    child.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`发送端没报出房间号就退出了（code ${code}）\nstdout:\n${out}\nstderr:\n${err}`))
    })
  })
}

/** 等子进程退出；超时就杀掉（返回 null 表示是被杀掉的，不是自己退的） */
function waitExit(child, ms = 60000) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode)
    const t = setTimeout(() => {
      try { child.kill() } catch { /* 已退出 */ }
      resolve(null)
    }, ms)
    child.on('exit', (code) => { clearTimeout(t); resolve(code) })
  })
}

/** 轮询到房间消失；返回最后一次拿到的状态码（等不到时不是 404） */
async function waitRoomGone(base, room, ms = 15000) {
  const deadline = Date.now() + ms
  let last = null
  while (Date.now() < deadline) {
    const r = await fetch(`${base}/r/${room}`)
    last = r.status
    if (r.status === 404) return 404
    await new Promise((x) => setTimeout(x, 100))
  }
  return last
}

/** 把发送端输出附在断言消息里 —— 失败时不用再去猜"卡在哪一步" */
const dumpOf = (cli) =>
  `\n--- 发送端输出 ---\n${stripAnsi(cli.getOut()).slice(-1500)}` +
  (cli.getErr() ? `\n--- stderr ---\n${cli.getErr().slice(-800)}` : '')

test('⭐ 真 CLI 走中继：逐字节送达、全程密文、用完房间消失、退出码 0（此前零覆盖的编排路径）',
  { timeout: 240000 }, async () => {
    const relay = await startFakeRelay()
    // 四种有代表性的形态：满块 / 不齐的尾块 / 空文件 / 中文名（含一段明文特征串）
    const PLAINTEXT = '经中继传输的文本'
    const { dir } = await makeManifest({
      'full.bin': randomBytes(PARAMS.chunkBytes),
      'odd.bin': randomBytes(PARAMS.chunkBytes + 777),
      'empty.dat': Buffer.alloc(0),
      '说明.txt': Buffer.from(PLAINTEXT, 'utf8'),
    })
    const names = ['full.bin', 'odd.bin', 'empty.dat', '说明.txt']
    const password = 'relay-cli-e2e-pass'

    const cli = await startRelayCli({
      relayBase: relay.base, files: names.map((n) => path.join(dir, n)), password,
    })
    try {
      assert.match(cli.base, /^http:\/\/127\.0\.0\.1:\d+$/,
        `__READY__ 的第一个字段应是中继地址${dumpOf(cli)}`)

      const outDir = await mkdtemp(path.join(tmpdir(), 'flicker-relay-cli-out-'))
      cleanups.push(() => rm(outDir, { recursive: true, force: true }))
      const { wire } = await receiveAll({
        base: cli.base, roomName: cli.room, password, outDir,
      })
      assert.equal(wire.files.length, 4, '清单里应有 4 个文件')

      for (const rel of names) {
        const a = await readFile(path.join(dir, rel))
        const b = await readFile(path.join(outDir, rel))
        assert.equal(a.length, b.length, `${rel} 长度应一致`)
        assert.equal(Buffer.compare(a, b), 0, `${rel} 应逐字节一致`)
      }

      // 中继侧看到的每一个字节（假中继记了账）
      const seen = Buffer.concat(relay.seen)
      assert.ok(seen.length > 0, '中继应该确实转发了数据')
      assert.ok(!seen.includes(Buffer.from(PLAINTEXT, 'utf8')),
        '中继侧不该出现明文 —— 这条链路是端到端加密的')

      const code = await waitExit(cli.child)
      assert.equal(code, EXIT.OK, `发送端应正常退出${dumpOf(cli)}`)
      const out = stripAnsi(cli.getOut())
      assert.match(out, /中继房间已销毁/, `销毁清单里要有"中继房间已销毁"${dumpOf(cli)}`)
      assert.equal(await waitRoomGone(cli.base, cli.room), 404,
        '传输结束后房间必须从中继上消失 —— 否则"用完即销毁"这句话在中继模式上是假的')
    } finally {
      await waitExit(cli.child, 5000)
    }
  })

test('⭐ 真 CLI + 老中继（不声明单条上限）：回落到 1 MiB 跑通，并且如实告诉用户用了多大块',
  { timeout: 240000 }, async () => {
    // 这条守的是"升级客户端不会打死已部署的旧中继"：老中继的 /health 是纯文本、
    // 创建响应里没有 maxMessageBytes，客户端必须回落到协议保证的最小值。
    // ⚠️ 回落**只能靠清单里的 chunkBytes**（逐文件字段），所以这条用例同时验证了
    //    "扫描与哈希用的是回落后的块大小"—— 顺序写反的话清单与逐块哈希会对不上，
    //    接收端当场就会报块校验失败。
    const relay = await startFakeRelay({ legacy: true })
    const { dir } = await makeManifest({
      'legacy.bin': randomBytes(PARAMS.chunkBytes + 1234),
    })
    const password = 'legacy-relay-pass'
    const cli = await startRelayCli({
      relayBase: relay.base, files: [path.join(dir, 'legacy.bin')], password,
    })
    try {
      const outDir = await mkdtemp(path.join(tmpdir(), 'flicker-relay-legacy-out-'))
      cleanups.push(() => rm(outDir, { recursive: true, force: true }))
      const { wire } = await receiveAll({ base: cli.base, roomName: cli.room, password, outDir })

      assert.equal(wire.files[0].chunkBytes, 1 << 20,
        '老中继不声明上限时，块大小应回落到协议最小值 1 MiB')
      const out = stripAnsi(cli.getOut())
      assert.match(out, /块大小 1\.00 MiB/,
        `必须明确告诉用户实际用了多大的块${dumpOf(cli)}`)
      assert.match(out, /对方未声明/,
        '还要说清"为什么不是默认的 2 MiB" —— 否则用户会以为程序偷偷改了行为')

      const a = await readFile(path.join(dir, 'legacy.bin'))
      const b = await readFile(path.join(outDir, 'legacy.bin'))
      assert.equal(Buffer.compare(a, b), 0, '老中继链路上也必须逐字节一致')

      const code = await waitExit(cli.child)
      assert.equal(code, EXIT.OK, `发送端应正常退出${dumpOf(cli)}`)
    } finally {
      await waitExit(cli.child, 5000)
    }
  })

test('⭐ 真 CLI 等不到接收端：超时也要把中继房间销毁掉（失败路径上同样"用完即销毁"）',
  { timeout: 180000 }, async () => {
    // 没人来取的时候最容易"忘了销毁"：房间留在中继上，过期前谁拿到链接都能试密码。
    // 这条用例把失败路径钉住 —— 超时退出码是 EXIT.TIMEOUT（见 行为与运行.md §5.2），
    // 而销毁清单与房间消失两件事都必须照做。
    const relay = await startFakeRelay()
    const { dir } = await makeManifest({ 'nobody.bin': randomBytes(2048) })
    const cli = await startRelayCli({
      relayBase: relay.base, files: [path.join(dir, 'nobody.bin')],
      password: 'timeout-relay-pass', extra: ['--timeout=2s'],
    })
    const code = await waitExit(cli.child)
    const out = stripAnsi(cli.getOut())
    assert.equal(code, EXIT.TIMEOUT, `超时应以退出码 ${EXIT.TIMEOUT} 结束${dumpOf(cli)}`)
    assert.match(out, /等不到接收端的确认/,
      `要明确告诉用户"对方没来取"，而不是只说一句"传输未完成"${dumpOf(cli)}`)
    assert.match(out, /中继房间已销毁/, `销毁清单里要有"中继房间已销毁"${dumpOf(cli)}`)
    assert.equal(await waitRoomGone(cli.base, cli.room), 404,
      '超时退出后房间也必须消失')
  })

test('⭐ 真 CLI 走中继 + **默认赠品**：赠品的字节绝不许进清单（回归：曾把中继模式打死）',
  { timeout: 240000 }, async () => {
    // 这条守的是一个**真实发生过的事故**（2026-10）：
    //   src/prepare.js 从前把赠品的本地字段 `_giftAbsPath` / `_giftBytes` 直接
    //   push 进 `wire.files`，而清单是 `JSON.stringify(wire)` 的产物 ——
    //   Buffer 会被序列化成 `{"type":"Buffer","data":[…]}`，源码包 1.3 MB
    //   于是变成 **4.97 MB 的清单**，而中继的单条消息上限是 2 MiB：
    //   报"中继错误：消息过大（4970349 > 2097169 字节）"，**默认设置下跨网络直接不可用**。
    //
    //   ⚠️ 为什么一直没被发现：所有中继用例都带 `--no-gift`（跑得快），
    //      而赠品默认是**开**的 —— 也就是说，**用户默认走的那条路没人跑过**。
    //      所以这条用例刻意不带 `--no-gift`，并且把"清单有多大"当成判据。
    const relay = await startFakeRelay()
    const { dir } = await makeManifest({ 'hello.bin': randomBytes(4096) })
    const password = 'relay-default-gift-pass'

    const cli = await startRelayCli({
      relayBase: relay.base, files: [path.join(dir, 'hello.bin')], password,
      gift: true,                       // ← 关键：走用户的默认设置
    })
    try {
      const outDir = await mkdtemp(path.join(tmpdir(), 'flicker-relay-gift-out-'))
      cleanups.push(() => rm(outDir, { recursive: true, force: true }))
      const { wire, manifestBytes } = await receiveAll({
        base: cli.base, roomName: cli.room, password, outDir,
      })

      // ① 清单本身必须远小于中继的单条上限。判据取"1 MiB 以内"而不是"不超限"：
      //    超限会直接失败，但"快超限"说明又有大块东西被塞进清单了。
      assert.ok(manifestBytes + 17 <= relay.store.maxMessageBytes,
        `清单消息（${manifestBytes} 字节）已经超过中继单条上限 —— 默认设置会直接失败`)
      assert.ok(manifestBytes < 1 << 20,
        `清单不该这么大（${manifestBytes} 字节）—— 八成又有二进制内容被写进了 wire.files`)

      // ② 用户文件 + 赠品都在，且赠品是靠 kind 认出来的
      assert.equal(wire.files.length, 2, `应有 2 个文件（1 个用户文件 + 1 个赠品）`)
      const giftFile = wire.files.find((f) => f.kind === 'flicker-station-source')
      assert.ok(giftFile, `赠品应当以 kind=flicker-station-source 出现在清单里`)
      // 赠品得是"真的那一份"（源码 + 两份文档，实测约 1.3 MB）：
      // 否则"送了个空包"也会让下面那几条断言全绿。
      assert.ok(giftFile.size > 256 * 1024,
        `赠品应当是一份完整的源码包（实际只有 ${giftFile.size} 字节）`)

      // ③ 用户文件逐字节一致
      const a = await readFile(path.join(dir, 'hello.bin'))
      const b = await readFile(path.join(outDir, 'hello.bin'))
      assert.equal(Buffer.compare(a, b), 0, '用户文件必须逐字节一致')

      // ④ 赠品的**内容**必须真的对 —— 这是"本地侧表"那条路的关键判据：
      //    字节没进清单，就得靠侧表按序号取回来；错位/取空都会在这里露出来。
      const got = await readFile(path.join(outDir, giftFile.rel))
      assert.equal(got.length, giftFile.size, '赠品长度应与清单声明一致')
      assert.equal(createHash('sha256').update(got).digest('hex'), giftFile.sha256,
        '赠品内容的摘要必须等于清单里声明的 sha256')

      const code = await waitExit(cli.child)
      assert.equal(code, EXIT.OK, `发送端应正常退出${dumpOf(cli)}`)
      assert.equal(await waitRoomGone(cli.base, cli.room), 404, '房间用完必须消失')
    } finally {
      await waitExit(cli.child, 5000)
    }
  })

test('⭐ 真 CLI + 插件：事件真的被触发、贡献的文件真的送达、销毁清单里有"插件资源已释放"',
  { timeout: 240000 }, async () => {
    // 这条是插件系统的端到端验收 —— 用的是本项目"两张真实"的原则：
    // 真的子进程 + 真的中继协议，插件也是仓库里那份**示例插件**（不是测试专用的假插件）。
    //
    // 判据分三层，缺一层都会让"插件系统看起来能用"变成假象：
    //   ① 插件**看得到**这次传输（它自己写的日志文件里必须有 run/start、manifest/scanned、
    //      transfer/complete 与界面输出的记录）；
    //   ② 插件的**贡献真的生效**（它追加的文件出现在接收端，内容逐字节对得上）；
    //   ③ 插件的**资源真的被释放**（日志里有"插件资源已释放"，且销毁清单里那一步是 ✓）。
    const relay = await startFakeRelay()
    const { dir } = await makeManifest({ 'data.bin': randomBytes(4096) })
    // 插件往 cwd 写日志 —— 把子进程的工作目录指到临时目录，别把仓库弄脏
    const workDir = await mkdtemp(path.join(tmpdir(), 'flicker-plugin-cli-'))
    cleanups.push(() => rm(workDir, { recursive: true, force: true }))
    const logFile = path.join(workDir, 'flicker-plugin.log')
    const logger = path.join(root, 'examples', 'plugins', 'hello-logger.cjs')
    const note = path.join(root, 'examples', 'plugins', 'attach-note.cjs')
    const password = 'relay-plugin-pass'

    const cli = await startRelayCli({
      relayBase: relay.base, files: [path.join(dir, 'data.bin')], password, cwd: workDir,
      extra: [`--plugin=${logger}`, `--plugin=${note}`],
    })
    try {
      const outDir = await mkdtemp(path.join(tmpdir(), 'flicker-plugin-out-'))
      cleanups.push(() => rm(outDir, { recursive: true, force: true }))
      const { wire } = await receiveAll({ base: cli.base, roomName: cli.room, password, outDir })

      // ② 贡献生效：接收端应当看到 2 个文件（用户文件 + 插件追加的说明）
      const added = wire.files.find((f) => f.rel === '发送说明.txt')
      assert.ok(added, `插件追加的文件应当出现在清单里：${wire.files.map((f) => f.rel).join(', ')}`)
      const got = await readFile(path.join(outDir, '发送说明.txt'))
      assert.equal(got.length, added.size, '追加文件的长度应与清单一致')
      assert.equal(createHash('sha256').update(got).digest('hex'), added.sha256,
        '追加文件的内容摘要必须等于清单声明值')
      assert.match(got.toString('utf8'), /attach-note/, '内容应当是那个示例插件生成的')

      const code = await waitExit(cli.child)
      assert.equal(code, EXIT.OK, `发送端应正常退出${dumpOf(cli)}`)
      const out = stripAnsi(cli.getOut())
      // ⚠️ `--machine` 模式下 stdout 要留给机器读（只允许 `__READY__`），
      //    所以"已加载 N 个插件"这行是往 **stderr** 打的 —— 断言要看两边。
      const allOut = out + '\n' + stripAnsi(cli.getErr())
      assert.match(allOut, /🧩 已加载 2 个插件/, `加载了什么必须打出来${dumpOf(cli)}`)
      assert.match(out, /插件资源已释放/, `销毁清单里要有这一步${dumpOf(cli)}`)

      // ① 插件看到了这次传输（它自己的日志）
      const log = await readFile(logFile, 'utf8')
      assert.match(log, /开始：模式=relay/, `run\/start 要带上模式：\n${log}`)
      assert.match(log, /清单：2 个文件/, `manifest\/scanned 要带上清单概览：\n${log}`)
      assert.match(log, /结束：ok=true/, `transfer\/complete 要带上结算：\n${log}`)
      assert.match(log, /界面\[/, `ui\/message 要有界面输出：\n${log}`)
      // ③ 资源释放：dispose 里那句也必须落进日志（而不是只出现在销毁清单上）
      assert.match(log, /（插件资源已释放）/, `ctx.effect 的清理函数必须被调用：\n${log}`)
    } finally {
      await waitExit(cli.child, 5000)
    }
  })
