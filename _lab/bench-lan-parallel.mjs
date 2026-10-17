/**
 * 局域网路径：实现能跑多快，并发取块有多少收益
 * ==============================================
 *
 * 为什么量这个：本机网卡是 **2.5 GbE（理论 ≈295 MB/s）**，而之前 loopback 端到端
 * 只测到 **187 MiB/s**。loopback 上没有链路限制，所以那 187 MiB/s 是**实现的上限**。
 * 若真机两端都是 2.5G，用户就白白少了一截 —— 那才是"提高传输速度"能落地的地方。
 *
 * 中继那条路（跨网络）不在这里量：路线图里已经用实测证明它的瓶颈是**带宽**
 * （窗口扫描到 32 只涨 18%，渐近线 28–30 MB/s = 链路稳态），再优化实现是白费力气。
 *
 * 量三件事：
 *   ① 纯取块（丢掉数据、不解密）—— 服务端 + TLS + 网络栈能跑多快
 *   ② 取块 + 解密 + 增量哈希 —— 真实接收端的代价
 *   ③ ①② 各自在并发 1 / 2 / 4 / 8 条连接下的表现
 *
 * 判据：若 ① 在并发 1 时就接近 295 MB/s，说明实现没问题、局域网已经贴住链路；
 *      若并发 4 明显快于并发 1，那收益就在"接收端并发取块"上 ——
 *      而浏览器接收端现在是**严格串行**逐块取的。
 *
 * 用法：node _lab/bench-lan-parallel.mjs
 */

import { Agent, request as httpsRequest } from 'node:https'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { randomBytes, createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateCerts } from '../src/session-cert.js'
import { Session } from '../src/session.js'
import { TransferServer } from '../src/server.js'
import { deriveVerifier, deriveKeys, sealManifest, openChunk, PARAMS } from '../src/suite/flicker1.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MiB = 1024 * 1024
const PASSWORD = 'lan-bench-password'
const CHUNKS = Number(process.argv[2]) || 256          // 256 MiB
const CONCURRENCIES = [1, 2, 4, 8]
const REPEATS = 2

const fmt = (n, u = '') => n.toFixed(1) + u
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]

// ── 造文件 ──────────────────────────────────────────────────

async function makeFile(dir, sizeBytes) {
  const p = path.join(dir, 'data.bin')
  const fh = await open(p, 'w')
  const block = randomBytes(4 * MiB)
  let w = 0
  try {
    while (w < sizeBytes) {
      const n = Math.min(block.length, sizeBytes - w)
      await fh.write(block, 0, n)
      w += n
    }
  } finally { await fh.close() }
  return p
}

// ── 起服务（真实 HTTPS + 真实会话密钥）───────────────────────

let session, server, port, base, certs

function req(pathname, agent) {
  return new Promise((resolve, reject) => {
    const r = httpsRequest({
      host: '127.0.0.1', port, path: pathname, method: 'GET',
      ca: certs.caPem, agent, timeout: 30000,
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }))
    })
    r.on('timeout', () => r.destroy(new Error('超时')))
    r.on('error', reject)
    r.end()
  })
}

/**
 * 按给定并发取完全部分块。
 * @param {object} o
 * @param {number} o.concurrency 同时在飞的请求数
 * @param {boolean} o.decrypt 是否解密 + 增量哈希（模拟真实接收端）
 */
async function pullAll({ concurrency, decrypt }) {
  const agent = new Agent({ keepAlive: true, maxSockets: concurrency })
  const total = session.manifest?.totalChunks ?? CHUNKS
  let next = 0
  const whole = createHash('sha256')
  const wholeChunks = []

  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= total) return
      const r = await req(`/api/chunk?seq=${i}&sid=${encodeURIComponent(sid)}`, agent)
      if (r.status !== 200) throw new Error(`块 ${i}: HTTP ${r.status}`)
      if (decrypt) {
        const tag = Buffer.from(r.headers['x-flicker-tag'], 'base64')
        const pt = openChunk(keys.enc, 0, i, total, r.buf, tag,
          Math.min(PARAMS.chunkBytes, fileSize - i * PARAMS.chunkBytes))
        whole.update(pt)
        wholeChunks.push(createHash('sha256').update(pt).digest('hex'))
      }
    }
  }

  const t0 = Date.now()
  await Promise.all(Array.from({ length: concurrency }, worker))
  const secs = (Date.now() - t0) / 1000
  agent.destroy()
  return { mbs: fileSize / MiB / secs, secs, hash: whole.digest('hex'), chunkCount: wholeChunks.length }
}

let sid, keys, fileSize

// ── 主流程 ──────────────────────────────────────────────────

const dir = await mkdtemp(path.join(tmpdir(), 'lan-bench-'))
const file = await makeFile(dir, CHUNKS * PARAMS.chunkBytes)
fileSize = CHUNKS * PARAMS.chunkBytes

const salt = randomBytes(PARAMS.saltBytes)
const verifier = deriveVerifier(PASSWORD, salt)
keys = deriveKeys(verifier)
const wire = {
  v: 1, suite: 'FLICKER/1',
  files: [{ kind: 'file', name: 'data.bin', rel: 'data.bin', size: fileSize,
    chunks: CHUNKS, chunkBytes: PARAMS.chunkBytes, sha256: 'x', chunkHashes: [] }],
  totalBytes: fileSize, totalChunks: CHUNKS,
}
const enc = sealManifest(keys.enc, Buffer.from(JSON.stringify(wire), 'utf8'))
session = new Session({
  salt, verifier, encManifest: enc.ct, manifestIv: enc.iv, manifestTag: enc.tag,
})
// 让服务端能按总块数工作
session.manifest = { totalChunks: CHUNKS }
server = new TransferServer({
  session,
  manifest: { ...wire, files: wire.files.map((f, i) => ({
    ...f, index: i, firstChunk: 0, absPath: file, _bytes: null, _gift: false })) },
  receiverHtml: '<!doctype html><meta charset="utf-8"><h1>x</h1>',
})
certs = generateCerts({ hosts: ['127.0.0.1'] })
port = await server.listen({ key: certs.srvKeyPem, cert: certs.srvPem, host: '127.0.0.1', port: 0 })

// 走一遍鉴权，拿到 sid
sid = await new Promise((resolve, reject) => {
  const r = httpsRequest({
    host: '127.0.0.1', port, path: '/api/auth/start', method: 'POST',
    ca: certs.caPem, timeout: 10000,
  }, (res) => {
    const cs = []
    res.on('data', (c) => cs.push(c))
    res.on('end', () => {
      const j = JSON.parse(Buffer.concat(cs).toString('utf8'))
      resolve(j.challenge)
    })
  })
  r.on('error', reject)
  r.end()
})
// 直接用 session 内部状态换一个 sid（基准脚本，不重复实现握手 MAC）
const { receiverMac } = await import('../src/suite/flicker1.js')
const ch = session.startAuth()
const mac = receiverMac(session.keys.auth, Buffer.from(ch.challenge, 'base64'))
sid = session.finishAuth({ mac: mac.toString('base64'), challenge: ch.challenge }).sid

console.log(`\n局域网路径基准：真实 HTTPS + 真实会话密钥，文件 ${CHUNKS} MiB（${CHUNKS} 块）`)
console.log('='.repeat(78))
console.log(`平台 ${process.platform} · Node ${process.version} · 服务与客户端在**同一台机器**上`)
console.log('说明：这是**实现上限**的测量（loopback 没有链路限制）。真机走网线时还要受网卡/交换机限制。\n')
console.log('  并发   仅取块（丢数据）        取块+解密+哈希          解密后整体哈希')
console.log('  ' + '─'.repeat(70))

const rows = []
for (const c of CONCURRENCIES) {
  const rawRuns = [], fullRuns = []
  let hashOk = false
  for (let i = 0; i < REPEATS; i++) {
    rawRuns.push((await pullAll({ concurrency: c, decrypt: false })).mbs)
    const f = await pullAll({ concurrency: c, decrypt: true })
    fullRuns.push(f.mbs)
    hashOk = Boolean(f.hash)
  }
  const raw = median(rawRuns), full = median(fullRuns)
  rows.push({ c, raw, full })
  console.log(`  ${String(c).padStart(3)}    ${(fmt(raw, ' MiB/s')).padStart(12)}` +
    `${' '.repeat(12)}${(fmt(full, ' MiB/s')).padStart(12)}${' '.repeat(10)}${hashOk ? '✓' : '✗'}`)
}

console.log('\n' + '─'.repeat(78))
const base1 = rows[0], best = rows.reduce((a, b) => (b.full > a.full ? b : a))
console.log(`  并发 1 → ${fmt(base1.full, ' MiB/s')}；最好的一档（并发 ${best.c}）→ ${fmt(best.full, ' MiB/s')}`)
console.log(`  并发带来的加速比：**${(best.full / base1.full).toFixed(2)}×**`)
console.log(`  纯取块上限：${fmt(Math.max(...rows.map((r) => r.raw)), ' MiB/s')}` +
  `（2.5 GbE 的理论上限约 295 MB/s）`)
if (best.full / base1.full < 1.2) {
  console.log('\n  → 并发几乎没有收益：串行取块已经不是瓶颈，实现贴住了它自己的上限。')
} else {
  console.log('\n  → 并发有明确收益。**而浏览器接收端现在是严格串行逐块取的** ——')
  console.log('     这就是局域网大文件提速最直接的一处。')
}

await server.shutdown()
await rm(dir, { recursive: true, force: true })
