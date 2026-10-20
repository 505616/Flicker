/**
 * 真浏览器里的**网页发送端** → 本地中继 → Node 侧逐块解密核对
 * ==========================================================
 * 这是"网页发送端"这条路的判据：发送端只有浏览器（`web/sender.html`），
 * 接收端由本脚本用**与接收页同一套解密规则**（`src/suite/flicker1.js`）还原。
 *
 * 为什么不是"页面发送 → 页面接收"：那是下一步（还要把发送页挂到中继路由上）。
 * 这一步要证明的是**协议与密码学兼容**：
 *   · 页面派生的房间名与 Node 派生的**同一个**（否则房间根本对不上）
 *   · 页面封的清单，Node 能打开，且 `v/suite/files[]/totalBytes/totalChunks` 都可解析
 *   · 页面封的每一块，Node 用 `openChunk` 能解（IV/AAD/顺序全对）
 *   · 还原出来的字节与原文件**逐字节一致**（导出 sha256 与清单里的对得上）
 *   · 中途按接收端的规则 ack，发送端才会报"完成"并销毁房间
 *
 * 用法：
 *   node _lab/e2e-page-sender.mjs            # 默认 2 MiB + 一个不齐的尾块
 *   node _lab/e2e-page-sender.mjs 8          # 8 MiB
 *   node _lab/e2e-page-sender.mjs --keep     # 保留临时目录（排查用）
 */
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RoomStore } from '../src/relay/room.js'
import { handleRelay, unpackMessage, MSG } from '../src/relay/protocol.js'
import {
  deriveVerifier, deriveKeys, openManifest, openChunk,
} from '../src/suite/flicker1.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
]
const MiB = 1 << 20

const argv = process.argv.slice(2)
const keep = argv.includes('--keep')
const sizeArg = argv.find((a) => /^\d+$/.test(a))
const SIZE = (sizeArg ? Number(sizeArg) : 2) * MiB + 12345   // 故意留一个不齐的尾块

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 极简 CDP 客户端（Node 24 自带全局 WebSocket）────────────────
class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.waiting = new Map(); this.events = []
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data)
      if (m.id && this.waiting.has(m.id)) {
        const { resolve, reject } = this.waiting.get(m.id)
        this.waiting.delete(m.id)
        if (m.error) reject(new Error(`${m.method}: ${m.error.message}`))
        else resolve(m.result)
      } else if (m.method) this.events.push(m)
    })
  }
  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true })
    })
    return new Cdp(ws)
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id
    this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }))
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject })
      setTimeout(() => { if (this.waiting.has(id)) { this.waiting.delete(id); reject(new Error(`${method} 超时`)) } }, 30000)
    })
  }
  close() { try { this.ws.close() } catch { /* ignore */ } }
}

async function waitDevtools(port, ms = 25000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (r.ok) return await r.json()
    } catch { /* 还没起来 */ }
    await sleep(200)
  }
  throw new Error('调试端口没起来')
}

// ── 本地中继 + 托管发送页 ────────────────────────────────────

function startRelay() {
  const store = new RoomStore({ ttlMs: 10 * 60 * 1000 })
  const sendHtml = readFileSync(path.join(ROOT, 'web', 'sender.html'), 'utf8')
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = Buffer.concat(chunks)
    const relayReq = new Request(`http://relay${req.url}`, {
      method: req.method,
      headers: Object.fromEntries(Object.entries(req.headers).filter(([, v]) => typeof v === 'string')),
      body: body.length ? body : undefined,
    })
    const r = await handleRelay(relayReq, url.pathname, store, { pageHtml: async () => '<!doctype html><title>relay</title>' })
    const out = Buffer.from(await r.arrayBuffer())
    const headers = {}
    for (const [k, v] of r.headers) headers[k] = v
    res.writeHead(r.status, headers)
    res.end(out)
  })
  // `handleRelay` 只服务协议端点；发送页由这里直接提供（等价于将来中继的 /send 路由）
  server.on('request', () => {})
  const orig = server.listeners('request')[0]
  server.removeAllListeners('request')
  server.on('request', (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
    if (url.pathname === '/send' || url.pathname === '/send/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(sendHtml)
      return
    }
    orig.call(server, req, res)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, store, base: `http://127.0.0.1:${server.address().port}` }))
  })
}

// ── 主流程 ──────────────────────────────────────────────────

const exe = BROWSERS.find((p) => existsSync(p))
if (!exe) { console.error('没找到 Edge / Chrome'); process.exit(1) }

const work = mkdtempSync(path.join(tmpdir(), 'flicker-page-sender-'))
const srcFile = path.join(work, 'sample.bin')
const srcBytes = randomBytes(SIZE)
writeFileSync(srcFile, srcBytes)
const srcSha = createHash('sha256').update(srcBytes).digest('hex')

const { server, base } = await startRelay()
const port = 9700 + Math.floor(Math.random() * 200)
const profile = path.join(work, 'profile')
mkdirSync(profile, { recursive: true })
const child = spawn(exe, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-gpu',
  '--ignore-certificate-errors', 'about:blank',
], { stdio: 'ignore', windowsHide: true })

const password = 'k7m-3fq'
let cdp = null
try {
  const ver = await waitDevtools(port)
  cdp = await Cdp.connect(ver.webSocketDebuggerUrl)
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  const S = (m, p) => cdp.send(m, p, sessionId)
  await S('Page.enable'); await S('Runtime.enable'); await S('DOM.enable')
  await S('Page.navigate', { url: `${base}/send` })
  await sleep(1200)

  // 填表：中继地址 + 密码 + 选文件（CDP 的 setFileInputFiles 能设置真实路径）
  const evalJs = async (expr) => {
    const r = await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(`页面脚本出错：${r.exceptionDetails.text}`)
    return r.result?.value
  }
  await evalJs(`(() => {
    const relay = document.getElementById('relay')
    relay.value = ${JSON.stringify(base)}
    relay.dispatchEvent(new Event('input'))
    const pw = document.getElementById('pw')
    pw.value = ${JSON.stringify(password)}
    pw.dispatchEvent(new Event('input'))
    return true
  })()`)
  const doc = await S('DOM.getDocument', { depth: -1 })
  const node = await S('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#pick' })
  await S('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [srcFile] })
  await evalJs(`document.getElementById('pick').dispatchEvent(new Event('change'))`)
  await sleep(300)
  const enabled = await evalJs(`!document.getElementById('start').disabled`)
  if (!enabled) throw new Error('开始按钮没启用（表单没填全？）')
  await evalJs(`document.getElementById('start').click()`)

  // 拿到链接（fragment 里有房间名与盐）
  let link = null
  for (let i = 0; i < 100; i++) {
    link = await evalJs(`document.getElementById('link').value || ''`)
    if (link) break
    await sleep(150)
  }
  if (!link) {
    const errText = await evalJs(`document.getElementById('doneText').textContent || ''`)
    throw new Error(`没有出现链接：${errText}`)
  }
  console.log(`  ✅ 页面已建立房间：${link.replace(/^(https?:\/\/[^/]+).*/, '$1')}/#k=…`)

  const u = new URL(link)
  const room = u.hash.replace(/^#/, '').split('&')[0].split('=')[1]
  const saltHex = u.hash.split('&')[1].split('=')[1]

  // ── Node 侧：按接收端的规则取消息、解密、ack ────────────────
  const relayFetch = (suffix, init) => fetch(`${base}/r/${room}${suffix}`, init)
  const status = async () => (await relayFetch('')).json()
  const getSeq = async (seq) => {
    const r = await relayFetch(`?seq=${seq}`)
    if (!r.ok) throw new Error(`取第 ${seq} 条失败：HTTP ${r.status}`)
    return new Uint8Array(await r.arrayBuffer())
  }

  // 等清单落地
  let st = await status()
  for (let i = 0; i < 200 && st.nextSeq < 1; i++) { await sleep(100); st = await status() }

  const salt = Buffer.from(saltHex, 'hex')
  const verifier = deriveVerifier(password, salt)
  const keys = deriveKeys(verifier)
  const encKey = keys.enc

  const m0 = unpackMessage(Buffer.from(await getSeq(0)))
  if (m0.type !== MSG.MANIFEST) throw new Error(`第 0 条不是清单（类型 ${m0.type}）`)
  const salt16 = m0.payload.subarray(0, 16)
  if (Buffer.compare(salt16, salt) !== 0) throw new Error('清单里的盐与链接里的盐不一致')
  const iv = m0.payload.subarray(16, 28)
  const tag = m0.payload.subarray(28, 44)
  const ct = m0.payload.subarray(44)
  const wire = JSON.parse(Buffer.from(openManifest(encKey, iv, ct, tag)).toString('utf8'))
  console.log(`  ✅ 清单解开：${wire.files.length} 个文件 · ${wire.totalBytes} 字节 · ${wire.totalChunks} 块 · 块大小 ${wire.files[0].chunkBytes}`)
  if (wire.v !== 1 || wire.suite !== 'FLICKER/1') throw new Error('清单版本/套件字段不对')
  if (!Array.isArray(wire.files) || !wire.files[0].chunkHashes) throw new Error('清单缺 chunkHashes')

  // 逐块取回、解密、ack
  const parts = new Map()          // fileIndex → [chunk...]
  let nextSeq = 1
  let acked = 0
  const total = 1 + wire.totalChunks
  while (acked < total) {
    const s = await status()
    while (nextSeq < s.nextSeq) {
      const msg = unpackMessage(Buffer.from(await getSeq(nextSeq)))
      if (msg.type !== MSG.CHUNK) throw new Error(`第 ${nextSeq} 条不是分块（类型 ${msg.type}）`)
      const ctag = msg.payload.subarray(0, 16)
      const cct = msg.payload.subarray(16)
      const ordinal = nextSeq - 1
      let fileIndex = -1, chunkIndex = 0, plainLen = 0
      let acc = 0
      for (let i = 0; i < wire.files.length; i++) {
        const f = wire.files[i]
        if (ordinal >= acc && ordinal < acc + f.chunks) {
          fileIndex = i; chunkIndex = ordinal - acc
          plainLen = Math.max(0, Math.min(f.chunkBytes, f.size - chunkIndex * f.chunkBytes))
          break
        }
        acc += f.chunks
      }
      if (fileIndex < 0) throw new Error(`序号 ${ordinal} 定位不到文件`)
      const f = wire.files[fileIndex]
      const plain = openChunk(encKey, fileIndex, chunkIndex, f.chunks, cct, ctag, plainLen)
      if (!parts.has(fileIndex)) parts.set(fileIndex, [])
      parts.get(fileIndex)[chunkIndex] = plain
      nextSeq++
    }
    acked = nextSeq
    if (acked < total) {
      await relayFetch(`/ack?upTo=${acked}`, { method: 'POST' })
      await sleep(150)
      continue
    }
    await relayFetch(`/ack?upTo=${acked}`, { method: 'POST' })
  }

  const joined = Buffer.concat((parts.get(0) || []))
  const gotSha = createHash('sha256').update(joined).digest('hex')
  if (joined.length !== srcBytes.length) throw new Error(`长度不对：${joined.length} ≠ ${srcBytes.length}`)
  if (gotSha !== srcSha) throw new Error('还原出来的字节与原文件不一致')
  if (gotSha !== wire.files[0].sha256) throw new Error('清单里的整文件哈希与实际不符')
  console.log(`  ✅ 逐块解密并拼回：${joined.length} 字节，sha256 一致`)

  // 发送端应当报"完成"（它只在整个 ackedBase 到达后才这样收尾）
  let doneText = ''
  for (let i = 0; i < 100; i++) {
    doneText = await evalJs(`document.getElementById('done').classList.contains('hidden') ? '' : document.getElementById('doneText').textContent`)
    if (doneText) break
    await sleep(150)
  }
  console.log(`  ✅ 页面显示：${doneText || '(还没有)'}`)
  if (!/全部发出|Everything sent/.test(doneText)) throw new Error('发送端没有进入"完成"状态')

  // 房间应当已被销毁（页面在完成后 destroy）。
  // 判据是"GET 状态不再能拿到房间" —— 删除后服务端回 404 / NO_ROOM，
  // 而不是 nextSeq 归零（房间是整条消失的，不是清空）。
  let gone = false
  for (let i = 0; i < 40 && !gone; i++) {
    const r = await fetch(`${base}/r/${room}`)
    if (r.status === 404) gone = true
    else {
      const j = await r.json().catch(() => ({}))
      gone = j.error === 'NO_ROOM' || j.code === 'NO_ROOM'
    }
    if (!gone) await sleep(150)
  }
  console.log(gone ? '  ✅ 房间已销毁（链接与密码从此刻起失效）' : '  ⚠️ 房间还在（可能还没销毁完）')
  if (!gone) throw new Error('传输完成后房间没有销毁')

  console.log('\n  ✅ 网页发送端 → 中继 → Node 逐块解密：协议与密码学兼容，字节一致')
} finally {
  if (cdp) cdp.close()
  try { child.kill() } catch { /* 已退出 */ }
  server.close()
  if (keep) console.log(`\n  保留临时目录：${work}`)
  else rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
