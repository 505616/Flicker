/**
 * 探针（HTTPS 版）：局域网模式下接收端页面是**自签证书**，浏览器会不会因此
 * 拒绝"装成应用"/注册 service worker？这决定了"手机把页面加到桌面"到底能不能用。
 *
 * 与 `_lab/probe-pwa-install.mjs` 的区别只有一点：那边用 http://127.0.0.1
 * （localhost 天生是安全上下文），这边用**本项目的自签证书**起 https，
 * 再通过 CDP 的 `Security.setIgnoreCertificateErrors` 模拟"用户点了继续前往"。
 *
 * 说明：这一步是**近似**——真机上用户点过"继续前往"后浏览器怎么算，只有真机知道；
 * 但"点过继续"之后仍然拿不到安全上下文/装不上，在真机上只会更差。
 *
 * 用法：node _lab/probe-pwa-install-https.mjs
 */
import { createServer } from 'node:https'
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateCerts } from '../src/session-cert.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PAGE = path.join(ROOT, 'web', 'receiver.html')

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
]

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.waiting = new Map()
    this.events = []
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data)
      if (msg.id && this.waiting.has(msg.id)) {
        const { resolve, reject } = this.waiting.get(msg.id)
        this.waiting.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
      } else if (msg.method) this.events.push(msg)
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
      setTimeout(() => {
        if (this.waiting.has(id)) { this.waiting.delete(id); reject(new Error(`${method} 超时`)) }
      }, 20000)
    })
  }

  close() { try { this.ws.close() } catch { /* ignore */ } }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

const exe = BROWSERS.find((p) => existsSync(p))
if (!exe) {
  console.error('没找到 Edge / Chrome')
  process.exit(1)
}

const certs = generateCerts({ hosts: ['127.0.0.1', 'localhost'] })
const html = readFileSync(PAGE, 'utf8')
const server = createServer({ cert: certs.srvPem, key: certs.srvKeyPem }, (req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(html)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `https://127.0.0.1:${server.address().port}`

const port = 9900 + Math.floor(Math.random() * 90)
const profile = mkdtempSync(path.join(tmpdir(), 'flicker-pwa-https-'))
const child = spawn(exe, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-gpu',
  'about:blank',
], { stdio: 'ignore', windowsHide: true })

let cdp = null
try {
  const ver = await waitDevtools(port)
  cdp = await Cdp.connect(ver.webSocketDebuggerUrl)
  // 模拟"用户点了继续前往（接受这个自签证书）"
  await cdp.send('Security.enable')
  await cdp.send('Security.setIgnoreCertificateErrors', { ignore: true })
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  await cdp.send('Page.enable', {}, sessionId)
  await cdp.send('Security.setIgnoreCertificateErrors', { ignore: true }, sessionId)
  await cdp.send('Page.navigate', { url: origin + '/' }, sessionId)
  await sleep(3000)

  const state = await cdp.send('Runtime.evaluate', {
    expression: `(async () => {
      let sw = 'unknown'
      try { sw = !!(await navigator.serviceWorker.getRegistration()) } catch (e) { sw = 'err:' + e.message }
      let swTry = 'n/a'
      try {
        await navigator.serviceWorker.register('/sw.js').then(() => { swTry = 'ok' }).catch((e) => { swTry = 'err:' + e.message })
      } catch (e) { swTry = 'err:' + e.message }
      return JSON.stringify({ href: location.href, secure: isSecureContext, sw, swTry })
    })()`,
    awaitPromise: true, returnByValue: true,
  }, sessionId).then((r) => JSON.parse(r.result.value))

  const manifest = await cdp.send('Page.getAppManifest', {}, sessionId).catch((e) => ({ errors: [{ message: e.message }] }))
  let inst = null
  try { inst = (await cdp.send('Page.getInstallabilityErrors', {}, sessionId)).installabilityErrors ?? [] } catch { /* 老浏览器 */ }

  console.log(`自签 HTTPS 源：${origin}`)
  console.log(`  安全上下文 isSecureContext：${state.secure}`)
  console.log(`  已有 service worker 注册：${state.sw}`)
  console.log(`  尝试注册 service worker：${state.swTry}`)
  console.log(`  manifest 解析错误：${(manifest.errors ?? []).length ? JSON.stringify(manifest.errors) : '（无）'}`)
  console.log(`  可安装性错误：${inst ? (inst.length ? JSON.stringify(inst) : '（无）') : '（这台浏览器没有该 API）'}`)
} catch (e) {
  console.error(`探测失败：${e.message}`)
} finally {
  if (cdp) cdp.close()
  try { child.kill() } catch { /* ignore */ }
  server.close()
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
