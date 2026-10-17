/**
 * 复现：接收端不 ack 会怎样
 * ========================
 *
 * 页面里 `relayTransport.getChunk()` 只 GET 分块，**从不发 ack**
 * （第 1189 行那句注释"接收端每取一块都会 ack"与代码不符）。
 * 而发送端的完成判据是 `posted >= total && ackedBase >= total`。
 *
 * 这个脚本用**真实的** RelaySender + 真实中继，跑两种接收端：
 *   A. 会 ack 的（= _lab/verify-relay.mjs 里的做法，也是 Node 端 e2e 的做法）
 *   B. **不 ack 的（= 浏览器页面现在的行为）**
 * 看各自的耗时与最终结果。
 *
 * 文件取 12 块：刚好越过窗口 8，能触发反停滞强制投递那一路。
 *
 * 用法：node _lab/repro-no-ack.mjs
 */
import { createServer } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RoomStore } from '../src/relay/room.js'
import { handleRelay } from '../src/relay/protocol.js'
import { RelaySender } from '../src/relay/sender.js'
import { deriveVerifier, deriveKeys, sealManifest, relayRoomName, PARAMS } from '../src/suite/flicker1.js'
import { scan, toWire, fillHashes } from '../src/manifest.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const CHUNKS = 12
const TIMEOUT_MS = 6000          // 故意给短一点，否则要等 15 分钟

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
  return {
    base: `http://127.0.0.1:${server.address().port}`, store,
    close: () => new Promise((r) => server.close(r)),
  }
}

async function run({ ack }) {
  const relay = await startRelay()
  const dir = await mkdtemp(path.join(tmpdir(), 'flicker-noack-'))
  await writeFile(path.join(dir, 'data.bin'), randomBytes(CHUNKS * PARAMS.chunkBytes))
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
  const url = (s = '') => `${relay.base}/r/${roomName}${s}`

  const sender = new RelaySender({
    baseUrl: relay.base, roomName, encKey: keys.enc, salt,
    manifest: { ...wire, files }, encManifest: { iv: enc.iv, tag: enc.tag, ct: enc.ct },
    pollMs: 20, windowSize: 8,
  })
  await sender.start()

  let received = 0, acked = 0
  const t0 = Date.now()
  const receiver = (async () => {
    for (let seq = 0; seq < total; seq++) {
      for (let i = 0; i < 3000; i++) {
        const r = await fetch(url(`?seq=${seq}`))
        if (r.ok) { await r.arrayBuffer(); received++; break }
        const j = await r.json().catch(() => ({}))
        if (j.error === 'NOT_YET') { await sleep(5); continue }
        throw new Error(`取 ${seq}: ${r.status} ${j.error}`)
      }
      // ← 差别只有这一行
      if (ack) {
        await fetch(url(`/ack?upTo=${seq}`), { method: 'POST' })
        acked++
      }
    }
  })()

  // 把每一次批量投递与状态轮询都记下来
  const log = []
  const realPutBatch = sender.client.putBatch.bind(sender.client)
  sender.client.putBatch = async (startSeq, count, o) => {
    const r = await realPutBatch(startSeq, count, o)
    log.push({ t: Date.now() - t0, op: 'putBatch', startSeq, count,
      sent: r.seqs?.length ?? 0, aborted: r.aborted === true,
      postedAfter: sender.client.posted, ackedAfter: sender.client.ackedBase })
    return r
  }
  const realStatus = sender.client.status.bind(sender.client)
  sender.client.status = async () => {
    const st = await realStatus()
    log.push({ t: Date.now() - t0, op: 'status', ackedBase: st.ackedBase, nextSeq: st.nextSeq })
    return st
  }

  // 给 run() 加一层日志：它到底什么时候、以什么状态退出的
  const realRun = sender.run.bind(sender)
  let exitedAt = null
  sender.run = async (...a) => {
    try {
      const r = await realRun(...a)
      exitedAt = { t: Date.now() - t0, state: { posted: sender.client.posted, acked: sender.client.ackedBase, stopped: sender._stopped, phase: sender.phase, idle: sender._idleRounds } }
      return r
    } catch (e) {
      exitedAt = { t: Date.now() - t0, threw: e.message, code: e.code }
      throw e
    }
  }

  const result = await Promise.all([sender.run({ timeoutMs: TIMEOUT_MS }), receiver])
  const secs = (Date.now() - t0) / 1000
  const st = await (await fetch(url())).json()
  const state = {
    posted: sender.client.posted,
    ackedBase: sender.client.ackedBase,
    stopped: sender._stopped,
    idleRounds: sender._idleRounds,
    phase: sender.phase,
    exitedAt,
  }
  await sender.destroy().catch(() => {})
  await relay.close()
  await rm(dir, { recursive: true, force: true })
  return {
    secs, received, acked, total, ok: result[0].ok, reason: result[0].reason,
    returned: result[0], state, room: st, log,
  }
}

console.log(`\n文件 ${CHUNKS} 块，发送端窗口 8，空闲超时 ${TIMEOUT_MS} ms\n`)

for (const ack of [true, false]) {
  const label = ack ? 'A. 会 ack（Node 端 e2e / verify-relay 的做法）' : 'B. 不 ack（**浏览器页面现在的行为**）'
  console.log(`══ ${label}`)
  const r = await run({ ack })
  console.log(`  收到 ${r.received}/${r.total} 块，ack 了 ${r.acked} 次，耗时 ${r.secs.toFixed(1)} s`)
  console.log(`  发送端返回：${JSON.stringify(r.returned)}`)
  console.log(`  房间残留：ackBase=${r.room.ackedBase} 还在队列里 ${r.room.nextSeq - r.room.ackedBase} 条`)
  if (!ack) {
    console.log('  投递/轮询轨迹（前 24 条）：')
    for (const e of r.log.slice(0, 24)) {
      console.log(e.op === 'putBatch'
        ? `    +${String(e.t).padStart(5)}ms putBatch(start=${e.startSeq} count=${e.count}) → 发出 ${e.sent} 条` +
          `${e.aborted ? ' [aborted]' : ''}；之后 posted=${e.postedAfter} acked=${e.ackedAfter}`
        : `    +${String(e.t).padStart(5)}ms status → ackedBase=${e.ackedBase} nextSeq=${e.nextSeq}`)
    }
    if (r.log.length > 24) console.log(`    …共 ${r.log.length} 条`)
  }
  console.log('')
}
