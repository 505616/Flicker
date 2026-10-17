/**
 * 窗口选型：多个窗口大小 × 多次重复，取中位数。
 *
 * 为什么不能只跑一次：这套基准用的是**人造延迟**（每批放行、批间隔 RTT），
 * 单次结果波动能到 ±15%（同一配置实测过 17.7 与 20.8）。选默认值得看中位数。
 *
 * 对照项"旧·串行"：用 SERIAL=1 环境变量让发送端退回
 * "先投一批、再单独 await 一次状态"的老路径，用来验证这轮优化到底值多少。
 *
 * 用法：
 *   node _lab/bench-window-sweep.mjs
 *   $env:FLICKER_SERIAL='1'; node _lab/bench-window-sweep.mjs   # 对照旧行为
 */
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
const REPEATS = 3
const WINDOWS = [4, 8, 16, 32]
const SERIAL = process.env.FLICKER_SERIAL === '1'

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
  let next = 0, acked = -1
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

async function once(windowSize) {
  const relay = await startDelayedRelay(RTT_MS)
  const dir = await mkdtemp(path.join(tmpdir(), 'flicker-swsweep-'))
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

  // 对照：退回"投一批 → 单独 await 状态"的串行老路径
  if (SERIAL) {
    const c = sender.client
    let lastAck = 0
    const realPut = c.putBatch.bind(c)
    c.putBatch = async (...a) => { const r = await realPut(...a); lastAck = c.ackedBase; return r }
    c.status = async () => {
      const st = await (await fetch(`${relay.base}/r/${roomName}`)).json()
      lastAck = st.ackedBase
      return st
    }
    void lastAck
  }

  const t0 = Date.now()
  await Promise.all([sender.run({ timeoutMs: 600000 }), drain(relay.base, roomName, total)])
  const secs = (Date.now() - t0) / 1000
  await sender.destroy().catch(() => {})
  await relay.close()
  await rm(dir, { recursive: true, force: true })
  return FILE_CHUNKS * PARAMS.chunkBytes / secs / 1024 / 1024
}

const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]

console.log(`\n人造往返延迟 ${RTT_MS} ms，文件 ${FILE_CHUNKS} MiB，每档重复 ${REPEATS} 次取中位`)
console.log(`  模式：${SERIAL ? '对照（旧的串行：投一批 → 单独 await 状态）' : '现行（状态探测与投递重叠 + 最小批量阈值）'}\n`)
console.log('  窗口   中位吞吐     各次实测                 理论上限   达到')
console.log('  ' + '─'.repeat(64))

for (const w of WINDOWS) {
  const runs = []
  for (let i = 0; i < REPEATS; i++) runs.push(await once(w))
  const med = median(runs)
  const theo = w * 1048576 / (RTT_MS / 1000) / 1024 / 1024
  console.log(`  ${String(w).padStart(3)}   ${(med.toFixed(2) + ' MB/s').padStart(10)}   ` +
    `${runs.map((r) => r.toFixed(1)).join(' / ').padEnd(22)}  ` +
    `${theo.toFixed(1).padStart(6)}   ${(med / theo * 100).toFixed(0)}%`)
}
console.log('')
