// 量化窗口放宽带来的吞吐提升
//
// 本地中继延迟太低（<1ms），停等也能跑满，看不出差别。
// 所以给中继加**人为延迟**，模拟实测的跨网络往返（约 195 ms）。
//
// ── 延迟模型怎么建才对（这里改了三版）──────────────────────
//
// 第一版：给所有请求加延迟 → 接收端也背上 195 ms，它自己成了瓶颈。
// 第二版：只延迟发送端，但让每个请求独占 195 ms → **把延迟串行化了**，
//         于是窗口 1→32 吞吐完全没变（都顶在 1/RTT）。
// 第三版（现在这个）：一次往返可以**并发承载多条** ——
//         这才是流水线之所以有用的原因。
//
// 模型：发送端方向按"批次"放行，每批间隔 RTT；同一批内的请求并行完成。
//
// 用法：node _lab/bench-window.mjs
import { createServer } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { RoomStore } from '../src/relay/room.js'
import { handleRelay } from '../src/relay/protocol.js'
import { RelaySender } from '../src/relay/sender.js'
import { deriveVerifier, deriveKeys, sealManifest, relayRoomName, PARAMS } from '../src/suite/flicker1.js'
import { scan, toWire, fillHashes } from '../src/manifest.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const FILE_CHUNKS = 32
const RTT_MS = 195

async function startDelayedRelay(rttMs) {
  const store = new RoomStore()
  let batchStart = Date.now()
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = Buffer.concat(chunks)

    const isSenderSide = req.method === 'POST' && !url.pathname.endsWith('/ack')
    let releaseAt = 0
    if (isSenderSide) {
      const now = Date.now()
      if (now - batchStart >= rttMs) batchStart = now
      releaseAt = batchStart + rttMs
    }

    const r = await handleRelay(new Request('http://relay' + req.url, {
      method: req.method, body: body.length ? body : undefined,
    }), url.pathname, store)
    const buf = Buffer.from(await r.arrayBuffer())

    if (releaseAt) {
      const wait = releaseAt - Date.now()
      if (wait > 0) await sleep(wait)
    }
    const h = {}
    r.headers.forEach((v, k) => { h[k] = v })
    res.writeHead(r.status, h)
    res.end(buf)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
  }
}

async function drain(base, room, totalMessages, concurrency = 16) {
  const url = (s = '') => `${base}/r/${room}${s}`
  let next = 0
  let acked = -1
  const done = new Set()

  async function fetchOne(seq) {
    for (let i = 0; i < 20000; i++) {
      const r = await fetch(url(`?seq=${seq}`), { headers: { Connection: 'close' } })
      if (r.ok) { await r.arrayBuffer(); return seq }
      const j = await r.json().catch(() => ({}))
      if (j.error === 'NOT_YET') { await sleep(2); continue }
      throw new Error(`取 ${seq} 失败: ${r.status} ${j.error}`)
    }
    throw new Error(`取 ${seq} 超时`)
  }

  const inFlight = new Set()
  const drainAcks = async () => {
    while (done.has(acked + 1)) {
      acked++
      await fetch(url(`/ack?upTo=${acked}`), { method: 'POST', headers: { Connection: 'close' } })
    }
  }
  while (next < totalMessages || inFlight.size) {
    while (inFlight.size < concurrency && next < totalMessages) {
      const seq = next++
      const p = fetchOne(seq).then(() => { inFlight.delete(p); done.add(seq) })
      inFlight.add(p)
    }
    if (inFlight.size) await Promise.race(inFlight)
    await drainAcks()
  }
  await drainAcks()
  return acked + 1
}

async function bench(windowSize) {
  const relay = await startDelayedRelay(RTT_MS)
  const dir = await mkdtemp(path.join(tmpdir(), 'bench-'))
  await writeFile(path.join(dir, 'data.bin'), randomBytes(FILE_CHUNKS * PARAMS.chunkBytes))
  const m = await scan([dir], { chunkBytes: PARAMS.chunkBytes })
  await fillHashes(m)
  const wire = toWire(m)
  const salt = randomBytes(PARAMS.saltBytes)
  const keys = deriveKeys(deriveVerifier('bench', salt))
  const roomName = relayRoomName(keys)
  const enc = sealManifest(keys.enc, Buffer.from(JSON.stringify(wire), 'utf8'))
  const files = wire.files.map((f, i) => ({
    ...f, index: i, firstChunk: 0, absPath: m.files[i].absPath, _bytes: null, _gift: false,
  }))
  const total = 1 + wire.totalChunks

  const sender = new RelaySender({
    baseUrl: relay.base, roomName, encKey: keys.enc, salt,
    manifest: { ...wire, files }, encManifest: { iv: enc.iv, tag: enc.tag, ct: enc.ct },
    pollMs: 20, windowSize,
  })
  await sender.start()
  const t0 = Date.now()
  let senderDone = 0, drainDone = 0
  const [run] = await Promise.all([
    sender.run({ timeoutMs: 600000 }).then((r) => { senderDone = Date.now() - t0; return r }),
    drain(relay.base, roomName, total).then((n) => { drainDone = Date.now() - t0; return n }),
  ])
  const secs = (Date.now() - t0) / 1000
  console.log(`      窗口=${windowSize} 发送端完成 @${(senderDone / 1000).toFixed(1)}s  ` +
    `接收端完成 @${(drainDone / 1000).toFixed(1)}s  ` +
    `共 ${total} 条 → 平均 ${(secs * 1000 / total).toFixed(0)} ms/条`)
  await sender.destroy().catch(() => {})
  await relay.close()
  await rm(dir, { recursive: true, force: true })
  return { windowSize, secs, mb: FILE_CHUNKS, rate: FILE_CHUNKS / secs, ok: run.ok }
}

console.log('\n  量化：在途窗口对跨网络吞吐的影响')
console.log(`  人为往返延迟 ${RTT_MS} ms（实测到 Cloudflare 的最小值）`)
console.log(`  传输 ${FILE_CHUNKS} MiB，块大小 1 MiB\n`)
console.log('  窗口   耗时      吞吐         相对停等')
console.log('  ' + '─'.repeat(48))

const rows = []
for (const w of [1, 8]) {
  const r = await bench(w)
  rows.push(r)
  const base = rows[0]
  console.log(`  ${String(w).padStart(3)}   ${r.secs.toFixed(1).padStart(6)}s  ` +
    `${(r.rate.toFixed(2) + ' MB/s').padStart(11)}  ${(r.rate / base.rate).toFixed(1)}×`)
}

console.log('')
console.log('  理论：吞吐上限 ≈ 窗口 × 块大小 ÷ 往返延迟')
for (const w of [1, 8, 32]) {
  console.log(`    窗口 ${String(w).padStart(2)} → ${(w * 1048576 / (RTT_MS / 1000) / 1024 / 1024).toFixed(1)} MB/s`)
}
console.log('')
// 只汇总**这一轮真跑过**的行。早先这里硬编码了 w32，
// 而测量循环改成 [1, 8] 之后它恒为 undefined —— 基准脚本没报错，
// 却以退出码 1 结束（在 CI 里会像"测试失败"）。汇总必须跟着测量走。
const base = rows[0]
for (const r of rows.slice(1)) {
  const theo = r.windowSize * 1048576 / (RTT_MS / 1000) / 1024 / 1024
  console.log(`  实测：窗口 ${r.windowSize} vs 停等（1） → ${(r.rate / base.rate).toFixed(1)}×` +
    `（理论上限 ${theo.toFixed(1)} MB/s，达到 ${(r.rate / theo * 100).toFixed(0)}%）`)
}
console.log('')
