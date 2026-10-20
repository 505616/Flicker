/**
 * 网页发送端 → 中继 → 网页接收端（**两边都只有浏览器**）
 * ====================================================
 * 这是"手机传手机"那条路的判据：没有 Node 发送端、没有局域网直连，
 * 两边都是浏览器，中间只有一份中继。
 *
 * 与 `_lab/e2e-page-sender.mjs` 的区别：
 *   那边接收端由脚本用 Node 解密核对（证明协议兼容）；
 *   这边接收端是**真的接收页**，文件由浏览器真的落盘，再逐字节比对（证明整条链路可用）。
 *
 * 中继用的是**真实产物**：`relay/page.generated.js`（接收页）与
 * `relay/sender.generated.js`（发送页）—— 也就是部署到 Cloudflare 的那两份。
 * 路由走 `handleRelay` 的 `/` 与 `/send`，与线上同一条代码路径。
 *
 * 用法：
 *   node _lab/e2e-page-to-page.mjs           # 3 MiB + 不齐尾块
 *   node _lab/e2e-page-to-page.mjs 12        # 12 MiB
 *   node _lab/e2e-page-to-page.mjs --keep
 */
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RoomStore } from '../src/relay/room.js'
import { handleRelay } from '../src/relay/protocol.js'
import { RECEIVER_HTML } from '../relay/page.generated.js'
import { SENDER_HTML } from '../relay/sender.generated.js'

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
const SIZE = (sizeArg ? Number(sizeArg) : 3) * MiB + 4321
const PASSWORD = 'p2p-9xq'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.waiting = new Map()
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data)
      if (m.id && this.waiting.has(m.id)) {
        const { resolve, reject } = this.waiting.get(m.id)
        this.waiting.delete(m.id)
        if (m.error) reject(new Error(`${m.error.message}`)); else resolve(m.result)
      }
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
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return await r.json() } catch { /* 等 */ }
    await sleep(200)
  }
  throw new Error('调试端口没起来')
}

/** 起本地中继：真实的两份生成产物 + handleRelay（与线上同一条路径） */
function startRelay() {
  const store = new RoomStore({ ttlMs: 10 * 60 * 1000 })
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
    const r = await handleRelay(relayReq, url.pathname, store, {
      pageHtml: async () => RECEIVER_HTML,
      senderHtml: async () => SENDER_HTML,
    })
    const out = Buffer.from(await r.arrayBuffer())
    const headers = {}
    for (const [k, v] of r.headers) headers[k] = v
    res.writeHead(r.status, headers)
    res.end(out)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, store, base: `http://127.0.0.1:${server.address().port}` }))
  })
}

const exe = BROWSERS.find((p) => existsSync(p))
if (!exe) { console.error('没找到 Edge / Chrome'); process.exit(1) }

const work = mkdtempSync(path.join(tmpdir(), 'flicker-p2p-'))
const srcFile = path.join(work, 'sample.bin')
const srcBytes = randomBytes(SIZE)
writeFileSync(srcFile, srcBytes)
const srcSha = createHash('sha256').update(srcBytes).digest('hex')
const downloadDir = path.join(work, 'downloads')
mkdirSync(downloadDir, { recursive: true })

const { server, base } = await startRelay()
const port = 9800 + Math.floor(Math.random() * 150)
const profile = path.join(work, 'profile')
mkdirSync(profile, { recursive: true })
const child = spawn(exe, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-gpu',
  'about:blank',
], { stdio: 'ignore', windowsHide: true })

let cdp = null
const log = (s) => console.log(s)
try {
  const ver = await waitDevtools(port)
  cdp = await Cdp.connect(ver.webSocketDebuggerUrl)
  await cdp.send('Browser.setDownloadBehavior', {
    behavior: 'allow', downloadPath: downloadDir, eventsEnabled: true,
  }).catch(() => {})

  /** 开一个标签页，返回 {S, eval} */
  async function openTab(url) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    const S = (m, p) => cdp.send(m, p, sessionId)
    await S('Page.enable'); await S('Runtime.enable'); await S('DOM.enable')
    await S('Page.navigate', { url })
    await sleep(1000)
    const evalJs = async (expr) => {
      const r = await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
      if (r.exceptionDetails) throw new Error(`页面脚本出错：${r.exceptionDetails.text}`)
      return r.result?.value
    }
    return { S, eval: evalJs }
  }

  // ── ① 发送端：/send ────────────────────────────────────────
  const senderTab = await openTab(`${base}/send`)
  if (!await senderTab.eval('!!globalThis.FlickerSender')) throw new Error('发送页里没有内核（内联失败？）')
  await senderTab.eval(`(() => {
    const relay = document.getElementById('relay')
    relay.value = ${JSON.stringify(base)}; relay.dispatchEvent(new Event('input'))
    const pw = document.getElementById('pw')
    pw.value = ${JSON.stringify(PASSWORD)}; pw.dispatchEvent(new Event('input'))
    return true
  })()`)
  const doc = await senderTab.S('DOM.getDocument', { depth: -1 })
  const node = await senderTab.S('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#pick' })
  await senderTab.S('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [srcFile] })
  await senderTab.eval(`document.getElementById('pick').dispatchEvent(new Event('change'))`)
  await sleep(300)
  await senderTab.eval(`document.getElementById('start').click()`)

  let link = ''
  for (let i = 0; i < 200; i++) {
    link = await senderTab.eval(`document.getElementById('link').value || ''`)
    if (link) break
    await sleep(150)
  }
  if (!link) throw new Error('发送页没有给出链接')
  log(`  ✅ 发送页建好房间：${link.replace(/#.*/, '#k=…')}`)

  // ── ② 接收端：用链接打开接收页 ─────────────────────────────
  const recvTab = await openTab(link)
  await sleep(500)
  const screens = () => recvTab.eval(`(() => {
    const vis = (id) => { const el = document.getElementById(id); return !!el && !el.classList.contains('hide') }
    return JSON.stringify({ screens: ['v-pw','v-busy','v-go','v-done','v-err'].filter(vis),
      err: (document.getElementById('err-title')?.textContent||'').trim() })
  })()`).then(JSON.parse)

  // 填密码并开始
  await recvTab.eval(`(() => {
    const pw = document.getElementById('pw')
    pw.value = ${JSON.stringify(PASSWORD)}
    pw.dispatchEvent(new Event('input'))
    document.getElementById('btnStart').click()
    return true
  })()`)

  let st = null
  for (let i = 0; i < 600; i++) {
    st = await screens()
    if (st.screens.includes('v-done') || st.screens.includes('v-err')) break
    await sleep(250)
  }
  log(`  接收页状态：${JSON.stringify(st)}`)
  if (!st || st.screens.includes('v-err')) throw new Error(`接收页报错：${st?.err}`)
  if (!st.screens.includes('v-done')) throw new Error('接收页没有进入完成屏')
  log('  ✅ 接收页进入「完成」屏')

  // 发送页也应当报完成
  let senderDone = ''
  for (let i = 0; i < 200; i++) {
    senderDone = await senderTab.eval(
      `document.getElementById('done').classList.contains('hidden') ? '' : document.getElementById('doneText').textContent`)
    if (senderDone) break
    await sleep(150)
  }
  if (!/全部发出|Everything sent/.test(senderDone)) throw new Error(`发送页没有报完成：${senderDone || '(空)'}`)
  log(`  ✅ 发送页报：${senderDone}`)

  // ── ③ 逐字节比对下载回来的文件 ─────────────────────────────
  await sleep(1500)
  const files = readdirSync(downloadDir).filter((f) => !f.endsWith('.crdownload'))
  if (!files.length) {
    throw new Error('下载目录里没有文件 —— 接收页没有真的落盘')
  }
  const got = files
    .map((f) => path.join(downloadDir, f))
    .sort((a, b) => statSync(b).size - statSync(a).size)[0]
  const gotBytes = readFileSync(got)
  const gotSha = createHash('sha256').update(gotBytes).digest('hex')
  if (gotBytes.length !== srcBytes.length) throw new Error(`长度不对：${gotBytes.length} ≠ ${srcBytes.length}`)
  if (gotSha !== srcSha) throw new Error('下载回来的字节与原文件不一致')
  log(`  ✅ 下载回来的文件逐字节一致（${(gotBytes.length / MiB).toFixed(2)} MiB，SHA-256 相同）`)

  // ── ④ 房间应当已销毁 ───────────────────────────────────────
  const room = new URL(link).hash.replace(/^#/, '').split('&')[0].split('=')[1]
  let gone = false
  for (let i = 0; i < 40 && !gone; i++) {
    const r = await fetch(`${base}/r/${room}`)
    if (r.status === 404) gone = true
    else { const j = await r.json().catch(() => ({})); gone = j.error === 'NO_ROOM' }
    if (!gone) await sleep(150)
  }
  if (!gone) throw new Error('传输完成后房间没有销毁')
  log('  ✅ 房间已销毁（链接与密码从此刻起失效）')

  log('\n  ✅ 网页发送端 → 中继 → 网页接收端：两边都只有浏览器，文件逐字节送达')
} finally {
  if (cdp) cdp.close()
  try { child.kill() } catch { /* 已退出 */ }
  server.close()
  if (keep) console.log(`\n  保留临时目录：${work}`)
  else rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
