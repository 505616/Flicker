// 复现"第一次打不开、刷新才正常"
// 假设 H1：profile 里缓存了上一次的证书拒绝结果 → 装了 CA 后仍报错，刷新才好
// 假设 H2：浏览器实例复用导致新窗口用了旧 profile
// 用法: node lab-repro.mjs
import https from 'node:https'
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'

const PORT = 18550
const CDP_PORT = 19333
const HOST = '127.0.0.1'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const sh = (c, a) => execFileSync(c, a, { stdio: 'pipe', encoding: 'utf8' })
const certCount = () => Number(sh('powershell', ['-NoProfile', '-Command',
  '(Get-ChildItem Cert:\\CurrentUser\\Root).Count']).trim())
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeCerts(dir) {
  const ps = `
$ErrorActionPreference='Stop'
$ca  = New-SelfSignedCertificate -Subject 'CN=Flicker Repro CA' -KeyUsage CertSign,CRLSign -KeyExportPolicy Exportable -CertStoreLocation 'Cert:\\CurrentUser\\My' -NotAfter (Get-Date).AddDays(7) -TextExtension @('2.5.29.19={critical}{text}ca=1')
$srv = New-SelfSignedCertificate -Subject 'CN=${HOST}' -Signer $ca -KeyExportPolicy Exportable -CertStoreLocation 'Cert:\\CurrentUser\\My' -NotAfter (Get-Date).AddDays(7) -TextExtension @('2.5.29.17={critical}{text}IPAddress=${HOST}&DNS=localhost')
$pwd = ConvertTo-SecureString -String 'lab' -Force -AsPlainText
Export-PfxCertificate -Cert $srv -FilePath '${dir}\\srv.pfx' -Password $pwd | Out-Null
Export-Certificate  -Cert $ca  -FilePath '${dir}\\ca.cer' | Out-Null
"CA_THUMB=$($ca.Thumbprint)"`
  const out = sh('powershell', ['-NoProfile', '-Command', ps])
  return (out.match(/CA_THUMB=(.*)/) || [])[1].trim()
}

function cdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl)
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Key': Buffer.from(Array.from({ length: 16 }, () => Math.random() * 256 | 0)).toString('base64'),
        'Sec-WebSocket-Version': '13',
      },
    })
    req.on('upgrade', (_r, socket) => {
      let id = 0
      const pending = new Map(), handlers = []
      let buf = Buffer.alloc(0)
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk])
        for (;;) {
          if (buf.length < 2) return
          const op = buf[0] & 0x0f
          let len = buf[1] & 0x7f, off = 2
          if (len === 126) { len = buf.readUInt16BE(2); off = 4 }
          else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10 }
          if (buf.length < off + len) return
          const p = buf.subarray(off, off + len); buf = buf.subarray(off + len)
          if (op !== 1) continue
          const m = JSON.parse(p.toString())
          if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
          else handlers.forEach((h) => h(m))
        }
      })
      const send = (method, params = {}) => new Promise((res) => {
        const myId = ++id; pending.set(myId, res)
        const body = Buffer.from(JSON.stringify({ id: myId, method, params }))
        const mask = Buffer.from([9, 8, 7, 6])
        for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4]
        const head = body.length < 126 ? Buffer.from([0x81, 0x80 | body.length])
          : Buffer.concat([Buffer.from([0x81, 0xfe]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(body.length); return b })()])
        socket.write(Buffer.concat([head, mask, body]))
      })
      resolve({ send, on: (h) => handlers.push(h), close: () => socket.destroy() })
    })
    req.on('error', reject); req.end()
  })
}

// 启动浏览器，返回 { child, conn }
async function launch(profile, cdpPort, extraArgs = []) {
  fs.mkdirSync(profile, { recursive: true })
  const child = spawn(EDGE, [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    ...extraArgs, 'about:blank',
  ], { stdio: 'ignore' })
  let list = null
  for (let i = 0; i < 30; i++) {
    await sleep(400)
    try {
      list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
      if (list.find((t) => t.type === 'page')) break
    } catch {}
  }
  const t = list?.find((x) => x.type === 'page')
  if (!t) throw new Error('CDP 连不上')
  return { child, conn: await cdp(t.webSocketDebuggerUrl) }
}

// 访问一次，返回结论
async function visit(conn, url, label, { clearCache = false } = {}) {
  const fails = []
  const handler = (m) => { if (m.method === 'Network.loadingFailed') fails.push(m.params) }
  conn.on(handler)
  if (clearCache) { try { await conn.send('Network.clearBrowserCache') } catch {} }
  await conn.send('Page.navigate', { url })
  await sleep(3000)
  const r = (await conn.send('Runtime.evaluate', {
    expression: `JSON.stringify({h1: document.querySelector('h1')?.textContent||'', body: document.body?document.body.innerText.slice(0,60).replace(/\\s+/g,' '):''})`,
    returnByValue: true,
  })).result.result.value
  const { h1, body } = JSON.parse(r)
  const certErr = fails.find((f) => f.errorText?.includes('CERT'))
  const verdict = h1.includes('验证页') ? '✅ 正常'
    : certErr ? `❌ ${certErr.errorText}`
    : '⚠️ ' + body.slice(0, 40)
  console.log(`   ${label.padEnd(28)} → ${verdict}`)
  return { ok: h1.includes('验证页'), err: certErr?.errorText }
}

const main = async () => {
  const before = certCount()
  console.log('=== 复现：第一次打不开、刷新才正常 ===')
  console.log(`Root 库基线: ${before}\n`)

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flicker-repro-'))
  const caThumb = makeCerts(dir).replace(/[^0-9A-F]/gi, '')
  const caFile = path.join(dir, 'ca.cer')

  const server = https.createServer({
    pfx: fs.readFileSync(path.join(dir, 'srv.pfx')), passphrase: 'lab',
  }, (_q, s) => { s.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); s.end('<!doctype html><meta charset=utf-8><h1>证书验证页</h1>') })
  await new Promise((r) => server.listen(PORT, HOST, r))
  const URL_ = `https://${HOST}:${PORT}/`

  // ── 场景 1：profile 里先留下一次"证书不受信任"的记录，再装 CA ──
  console.log('【场景 1】profile 已缓存拒绝结果 → 装 CA → 同一 profile 重开')
  const p1 = path.join(os.tmpdir(), 'repro-p1-' + Date.now())
  const A = await launch(p1, CDP_PORT)
  await A.conn.send('Page.enable'); await A.conn.send('Network.enable')
  await visit(A.conn, URL_, '① 未装 CA 时访问（应失败）')
  // 模拟用户点了"继续访问" —— 这一步可能是关键
  await A.conn.send('Page.navigate', { url: URL_ })
  await sleep(1200)
  await A.conn.send('Runtime.evaluate', { expression: `document.getElementById('details-button')?.click(); document.getElementById('proceed-link')?.click();` })
  await sleep(2500)
  await visit(A.conn, URL_, '② 点过"继续访问"后再访问')
  A.conn.close(); try { A.child.kill() } catch {}
  await sleep(1500)

  console.log('   >>> 装入 CA（浏览器已关闭）')
  sh('certutil', ['-user', '-addstore', '-f', 'Root', caFile])
  console.log(`   Root 库: ${before} → ${certCount()}`)

  const B = await launch(p1, CDP_PORT + 1)
  await B.conn.send('Page.enable'); await B.conn.send('Network.enable')
  const s1a = await visit(B.conn, URL_, '③ 装CA后首次访问（用户看到的）')
  const s1b = s1a.ok ? null : await visit(B.conn, URL_, '④ 刷新一次（用户说的）')

  // ── 场景 2：clearBrowserCache 是否足够修复 ──
  if (!s1a.ok) {
    console.log('\n【场景 2】同一 profile，清缓存后再访问')
    await visit(B.conn, URL_, '⑤ 仅清 HTTP 缓存', { clearCache: true })
  }
  B.conn.close(); try { B.child.kill() } catch {}
  await sleep(1500)

  // ── 场景 3：全新 profile + 已装 CA（产品实际会走的路径）──
  console.log('\n【场景 3】全新 profile + CA 已装（产品真实路径）')
  const p3 = path.join(os.tmpdir(), 'repro-p3-' + Date.now())
  const C = await launch(p3, CDP_PORT + 2)
  await C.conn.send('Page.enable'); await C.conn.send('Network.enable')
  await visit(C.conn, URL_, '⑥ 全新 profile 首次访问')
  C.conn.close(); try { C.child.kill() } catch {}

  // 清理
  await new Promise((r) => server.close(r))
  sh('certutil', ['-user', '-delstore', 'Root', caThumb])
  sh('powershell', ['-NoProfile', '-Command',
    `Get-ChildItem Cert:\\CurrentUser\\My | Where-Object { $_.Subject -like '*Flicker Repro*' } | Remove-Item -Force`])
  for (const d of [p1, p3, dir]) fs.rmSync(d, { recursive: true, force: true })
  await sleep(500)
  console.log(`\nRoot 库: → ${certCount()}  (应为 ${before})`)
  process.exit(0)
}
main().catch((e) => { console.error('失败:', e.message); process.exit(1) })
