/**
 * 探针：这份接收端页面在真实浏览器里**能不能装成应用**（PWA / 装到桌面）。
 *
 * 为什么需要它：`gen/inline-pwa.mjs` 把 manifest 作为 **data URL** 内联进页面，
 * 而 manifest 里的 `start_url: '.'` / `scope: '.'` 是**相对地址** —— 按规范，
 * 相对地址要相对 **manifest 自己的 URL** 解析，而 data: 是不透明源，解析不了。
 * 这一条如果真成立，Chrome / Edge 就会认为"这个应用装不上"，而且**页面一切正常、
 * 没有任何报错** —— 正是这个项目最怕的那类错误（"看起来是对的"）。
 *
 * 所以这里不听规范，直接问浏览器：
 *   ① `Page.getAppManifest` —— 浏览器解析出来的 manifest 与它的错误列表；
 *   ② `Page.getInstallabilityErrors` —— 装不上的**具体原因**（Chrome 实验性 API）。
 *
 * 三种变体各测一遍，用来区分"到底是哪一条挡住了"：
 *   --as-is    页面原样（默认可不写）
 *   --abs      只把 start_url / scope 改成绝对地址
 *   --sw       在 --abs 的基础上再加一个最小 service worker（带 fetch 处理）
 *
 * 用法：
 *   node _lab/probe-pwa-install.mjs --as-is
 *   node _lab/probe-pwa-install.mjs --abs
 *   node _lab/probe-pwa-install.mjs --sw
 *   node _lab/probe-pwa-install.mjs --all      # 三种各跑一遍，打一张表
 *
 * 依赖：本机要有 Edge 或 Chrome（用 `--remote-debugging-port` 驱动，零 npm 依赖）。
 * 页面通过 **http://127.0.0.1** 提供 —— localhost 属于安全上下文，等价于 HTTPS。
 */
import { createServer } from 'node:http'
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PAGE = path.join(ROOT, 'web', 'receiver.html')

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
]

const SW_JS = `self.addEventListener('fetch', function () {})`

/** 把页面按变体改造（只在内存里，不写文件） */
function variantHtml(html, variant) {
  let out = html
  if (variant === 'as-is') return out
  // 把 manifest 里的相对 start_url / scope 换成绝对地址
  out = out
    .replace("start_url: '.',", 'start_url: location.origin + "/",')
    .replace("scope: '.',", 'scope: location.origin + "/",')
  if (variant === 'sw') {
    out = out.replace('</head>', '<script>navigator.serviceWorker&&navigator.serviceWorker.register("/sw.js")</script>\n</head>')
  }
  return out
}

async function serve(variant) {
  const html = variantHtml(readFileSync(PAGE, 'utf8'), variant)
  const server = createServer((req, res) => {
    const url = req.url.split('?')[0]
    if (url === '/sw.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' })
      res.end(SW_JS)
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  return { server, origin: `http://127.0.0.1:${port}` }
}

/** 极简 CDP 客户端（Node 24 自带全局 WebSocket，不需要 npm 包） */
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
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`))
        else resolve(msg.result)
      } else if (msg.method) {
        this.events.push(msg)
      }
    })
  }

  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true })
    })
    return new Cdp(ws)
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    this.ws.send(JSON.stringify(payload))
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject })
      setTimeout(() => {
        if (this.waiting.has(id)) {
          this.waiting.delete(id)
          reject(new Error(`${method} 超时`))
        }
      }, 20000)
    })
  }

  close() { try { this.ws.close() } catch { /* 已经关了 */ } }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForDevtools(port, deadlineMs = 25000) {
  const t0 = Date.now()
  while (Date.now() - t0 < deadlineMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (r.ok) return await r.json()
    } catch { /* 还没起来 */ }
    await sleep(200)
  }
  throw new Error(`浏览器没有在 ${deadlineMs}ms 内打开调试端口 ${port}`)
}

/** 跑一个变体，返回 { variant, installability: [...], manifestErrors: [...], parsed } */
async function probe(variant) {
  const exe = BROWSERS.find((p) => existsSync(p))
  if (!exe) throw new Error('没找到 Edge / Chrome，无法探测')
  const { server, origin } = await serve(variant)
  const port = 9500 + Math.floor(Math.random() * 400)
  const profile = mkdtempSync(path.join(tmpdir(), 'flicker-pwa-probe-'))
  const child = spawn(exe, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-gpu',
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true })

  let cdp = null
  try {
    const ver = await waitForDevtools(port)
    cdp = await Cdp.connect(ver.webSocketDebuggerUrl)
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Runtime.enable', {}, sessionId)
    await cdp.send('Page.navigate', { url: origin + '/' }, sessionId)

    // 等 load，再给它一点时间处理动态插入的 manifest
    const t0 = Date.now()
    while (Date.now() - t0 < 15000) {
      const loaded = cdp.events.some((e) => e.method === 'Page.loadEventFired' && e.sessionId === sessionId)
      if (loaded) break
      await sleep(100)
    }
    await sleep(2500)

    const manifest = await cdp.send('Page.getAppManifest', {}, sessionId).catch((e) => ({ error: e.message }))
    let installability = null
    let installNote = ''
    try {
      const r = await cdp.send('Page.getInstallabilityErrors', {}, sessionId)
      installability = r.installabilityErrors ?? []
    } catch (e) {
      installNote = `（这个浏览器不支持 Page.getInstallabilityErrors：${e.message}）`
    }
    const parsed = await cdp
      .send('Runtime.evaluate', {
        expression: `(async () => {
          let sw = 'unknown'
          try { sw = !!(await navigator.serviceWorker.getRegistration()) } catch (e) { sw = 'err:' + e.message }
          const prompted = await new Promise((resolve) => {
            let fired = false
            addEventListener('beforeinstallprompt', () => { fired = true })
            setTimeout(() => resolve(fired), 2000)
          })
          return JSON.stringify({
            href: location.href,
            secure: isSecureContext,
            manifestLinks: [...document.querySelectorAll('link[rel=manifest]')].length,
            touchIcon: [...document.querySelectorAll('link[rel=apple-touch-icon]')].length,
            sw,
            beforeinstallprompt: prompted,
          })
        })()`,
        awaitPromise: true,
        returnByValue: true,
      }, sessionId)
      .then((r) => (r.result && r.result.value ? JSON.parse(r.result.value) : null))
      .catch(() => null)

    return {
      variant,
      installability,
      installNote,
      manifestUrl: manifest.url ? manifest.url.slice(0, 60) + '…' : null,
      manifestErrors: manifest.errors ?? [],
      startUrl: manifest.data ? JSON.parse(manifest.data).start_url : null,
      scope: manifest.data ? JSON.parse(manifest.data).scope : null,
      iconTypes: manifest.data ? (JSON.parse(manifest.data).icons ?? []).map((i) => i.type) : [],
      page: parsed,
    }
  } finally {
    if (cdp) cdp.close()
    try { child.kill() } catch { /* 已经退出 */ }
    server.close()
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

const argv = process.argv.slice(2)
const all = argv.includes('--all')
const wanted = all ? ['as-is', 'abs', 'sw'] : [argv.find((a) => a.startsWith('--'))?.slice(2) ?? 'as-is']

for (const v of wanted) {
  const label = { 'as-is': '原样（相对 start_url）', abs: 'start_url 改绝对地址', sw: '绝对地址 + service worker' }[v] ?? v
  console.log(`\n=== 变体 ${v}：${label} ===`)
  try {
    const r = await probe(v)
    console.log(`  页面：${r.page?.href ?? '(未知)'}`)
    console.log(`  manifest：${r.manifestUrl ?? '(浏览器没解析到)'}`)
    if (r.manifestErrors?.length) {
      console.log(`  ✗ manifest 错误：`)
      for (const e of r.manifestErrors) console.log(`      - ${e.message}${e.critical ? '（critical）' : ''}`)
    } else {
      console.log('  ✓ manifest 解析无错误')
    }
    if (r.startUrl !== null) console.log(`  浏览器解析出的 start_url：${JSON.stringify(r.startUrl)}  scope：${JSON.stringify(r.scope)}`)
    if (r.iconTypes.length) console.log(`  图标类型：${[...new Set(r.iconTypes)].join(', ')}`)
    if (r.page?.sw !== undefined) console.log(`  service worker 已注册：${r.page.sw}`)
    if (r.installability) {
      if (r.installability.length === 0) console.log('  ✓ 浏览器认为**可以安装**（installabilityErrors 为空）')
      else {
        console.log('  ✗ 装不上的原因：')
        for (const e of r.installability) console.log(`      - ${e.errorId}${e.errorArguments?.length ? '  ' + JSON.stringify(e.errorArguments) : ''}`)
      }
    } else if (r.installNote) {
      console.log(`  ? ${r.installNote}`)
    }
  } catch (e) {
    console.log(`  ✗ 探测失败：${e.message}`)
  }
}
