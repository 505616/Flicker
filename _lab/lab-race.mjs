// 验证竞态假设：浏览器先开、服务后起 → 用户看到"无法打开"，刷新才好
// 这正是真实产品 GUI 的行为（先拉窗口，再 --app=url）
// 用法: node lab-race.mjs
import https from 'node:https'
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'

const PORT = 18660
const CDP_PORT = 19444
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const sh = (c, a) => execFileSync(c, a, { stdio: 'pipe', encoding: 'utf8' })
const certCount = () => Number(sh('powershell', ['-NoProfile', '-Command',
  '(Get-ChildItem Cert:\\CurrentUser\\Root).Count']).trim())
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
      let id = 0; const pending = new Map(), handlers = []
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
        const mask = Buffer.from([5, 4, 3, 2])
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

const read = async (conn) => {
  const r = (await conn.send('Runtime.evaluate', {
    expression: `JSON.stringify({h1:document.querySelector('h1')?.textContent||'',body:document.body?document.body.innerText.slice(0,50).replace(/\\s+/g,' '):''})`,
    returnByValue: true,
  })).result.result.value
  return JSON.parse(r)
}

const main = async () => {
  const before = certCount()
  console.log('=== 竞态验证：浏览器先开，服务后起 ===')
  console.log(`Root 库基线: ${before}\n`)

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flicker-race-'))
  const ps = `
$ErrorActionPreference='Stop'
$ca  = New-SelfSignedCertificate -Subject 'CN=Flicker Race CA' -KeyUsage CertSign,CRLSign -KeyExportPolicy Exportable -CertStoreLocation 'Cert:\\CurrentUser\\My' -NotAfter (Get-Date).AddDays(7) -TextExtension @('2.5.29.19={critical}{text}ca=1')
$srv = New-SelfSignedCertificate -Subject 'CN=127.0.0.1' -Signer $ca -KeyExportPolicy Exportable -CertStoreLocation 'Cert:\\CurrentUser\\My' -NotAfter (Get-Date).AddDays(7) -TextExtension @('2.5.29.17={critical}{text}IPAddress=127.0.0.1&DNS=localhost')
$pwd = ConvertTo-SecureString -String 'lab' -Force -AsPlainText
Export-PfxCertificate -Cert $srv -FilePath '${dir}\\srv.pfx' -Password $pwd | Out-Null
Export-Certificate  -Cert $ca  -FilePath '${dir}\\ca.cer' | Out-Null
"CA_THUMB=$($ca.Thumbprint)"`
  const caThumb = (sh('powershell', ['-NoProfile', '-Command', ps]).match(/CA_THUMB=(.*)/) || [])[1].trim().replace(/[^0-9A-F]/gi, '')
  sh('certutil', ['-user', '-addstore', '-f', 'Root', path.join(dir, 'ca.cer')])
  console.log(`CA 已装（这是产品的正常状态）: ${before} → ${certCount()}\n`)

  // 关键：先开浏览器，此时服务还没起
  const profile = path.join(os.tmpdir(), 'race-prof-' + Date.now())
  fs.mkdirSync(profile, { recursive: true })
  const URL_ = `https://127.0.0.1:${PORT}/`
  const child = spawn(EDGE, [
    '--headless=new',
    `--app=${URL_}`,                 // 产品 GUI 的行为：直接指定 URL 开窗口
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
  ], { stdio: 'ignore' })

  // 等浏览器起来
  let conn = null
  for (let i = 0; i < 30; i++) {
    await sleep(300)
    try {
      const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
      const t = l.find((x) => x.type === 'page')
      if (t) { conn = await cdp(t.webSocketDebuggerUrl); break }
    } catch {}
  }
  if (!conn) { console.log('CDP 连不上'); process.exit(1) }
  await conn.send('Page.enable'); await conn.send('Network.enable')

  const fails = []
  conn.on((m) => { if (m.method === 'Network.loadingFailed') fails.push(m.params) })

  await sleep(2500)
  const s1 = await read(conn)
  console.log('【A】浏览器已打开，服务尚未启动，用户此时看到：')
  console.log('   ', s1.h1 || s1.body || '(空白)')
  console.log('    加载失败:', fails.map((f) => f.errorText).join(', ') || '无')

  // 现在启动服务（模拟程序完成初始化）
  const server = https.createServer(
    { pfx: fs.readFileSync(path.join(dir, 'srv.pfx')), passphrase: 'lab' },
    (_q, s) => { s.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); s.end('<!doctype html><meta charset=utf-8><h1>证书验证页</h1>') })
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
  console.log('\n   >>> 服务现已启动')

  // 【B】用户按 F5 —— 这是用户说的"刷新一下就好了"
  fails.length = 0
  await conn.send('Page.reload', { ignoreCache: true })
  await sleep(3000)
  const s2 = await read(conn)
  console.log('\n【B】用户在错误页按 F5 刷新后：')
  console.log('   ', s2.h1 || s2.body || '(空白)')
  console.log('    加载失败:', fails.map((f) => f.errorText).join(', ') || '无')

  // 【C】不刷新，程序自己重新导航（产品应有的行为）
  const profile3 = path.join(os.tmpdir(), 'race-prof2-' + Date.now())
  fs.mkdirSync(profile3, { recursive: true })
  const child2 = spawn(EDGE, [
    '--headless=new', `--app=${URL_}`,
    `--remote-debugging-port=${CDP_PORT + 1}`,
    `--user-data-dir=${profile3}`,
    '--no-first-run', '--no-default-browser-check',
  ], { stdio: 'ignore' })
  let conn2 = null
  for (let i = 0; i < 30; i++) {
    await sleep(300)
    try {
      const l = await (await fetch(`http://127.0.0.1:${CDP_PORT + 1}/json/list`)).json()
      const t = l.find((x) => x.type === 'page')
      if (t) { conn2 = await cdp(t.webSocketDebuggerUrl); break }
    } catch {}
  }
  await conn2.send('Page.enable'); await conn2.send('Network.enable')
  await sleep(3000)
  const s3 = await read(conn2)
  console.log('\n【C】服务已就绪后才打开浏览器（产品应该这样做）：')
  console.log('   ', s3.h1 || s3.body || '(空白)')

  // 清理
  conn.close(); conn2.close()
  try { child.kill() } catch {}; try { child2.kill() } catch {}
  await new Promise((r) => server.close(r))
  sh('certutil', ['-user', '-delstore', 'Root', caThumb])
  sh('powershell', ['-NoProfile', '-Command',
    `Get-ChildItem Cert:\\CurrentUser\\My | Where-Object { $_.Subject -like '*Flicker Race*' } | Remove-Item -Force`])
  for (const d of [profile, profile3, dir]) fs.rmSync(d, { recursive: true, force: true })
  await sleep(500)
  console.log(`\nRoot 库: → ${certCount()}  (应为 ${before})`)
  process.exit(0)
}
main().catch((e) => { console.error('失败:', e.message); process.exit(1) })
