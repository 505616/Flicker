// 证书信任验证台
// 问题：自签证书 + 装入"当前用户 Root 库"，Edge 会不会仍然拒绝？
// 证据：CDP 的 Network.responseReceived → securityDetails（直接读浏览器的验证结论）
// 用法: node lab-cert.mjs [--window] [--no-install] [--lan]
import https from 'node:https'
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'

const args = process.argv.slice(2)
const flag = (n) => args.some((a) => a === n || a === '-' + n || a === '--' + n)
const HEADLESS = !flag('window')
const INSTALL = !flag('no-install')
const USE_LAN = flag('lan')            // 用 192.168.1.5 而不是 127.0.0.1
const PORT = 18443
const CDP_PORT = 19222
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const HOST = USE_LAN ? '192.168.1.5' : '127.0.0.1'

const sh = (cmd, a) => execFileSync(cmd, a, { stdio: 'pipe', encoding: 'utf8' })
const certCount = () => Number(sh('powershell', ['-NoProfile', '-Command',
  '(Get-ChildItem Cert:\\CurrentUser\\Root).Count']).trim())

// ── 用 certreq 生成两级证书（系统标准做法）──────────────────
function genCerts() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flicker-labcert-'))
  const inf = (name, subj, ca, sans) => `[Version]
Signature = "$Windows NT$"

[Strings]
szOID_BASIC_CONSTRAINTS2 = "2.5.29.19"
szOID_KEY_USAGE          = "2.5.29.15"
szOID_SUBJECT_ALT_NAME2  = "2.5.29.17"

[NewRequest]
Subject = "${subj}"
KeySpec = 1
KeyLength = 2048
Exportable = TRUE
MachineKeySet = FALSE
ProviderName = "Microsoft RSA SChannel Cryptographic Provider"
ProviderType = 12
RequestType = Cert
HashAlgorithm = SHA256
UseExistingKeySet = FALSE
${ca ? 'KeyUsage = 0x80' : 'KeyUsage = 0xF8'}

[Extensions]
${ca
  ? `2.5.29.19 = "{text}critical:ca2"
2.5.29.15 = "{text}critical:keyCertSign"`
  : `2.5.29.19 = "{text}critical:"
2.5.29.15 = "{text}critical:digitalSignature,keyEncipherment"
2.5.29.37 = "{text}1.3.6.1.5.5.7.3.1"`}
2.5.29.17 = "{text}${sans}"

[RequestAttributes]
`
  fs.writeFileSync(path.join(dir, name + '.inf'), inf(name, subj, ca, sans), 'ascii')
  const cer = path.join(dir, name + '.cer')
  sh('certreq', ['-new', path.join(dir, name + '.inf'), cer, cer.replace('.cer', '.p7b')])
  const thumb = sh('powershell', ['-NoProfile', '-Command',
    `(Get-Item "${cer.replace('.cer', '.crt')}" -ErrorAction SilentlyContinue).Thumbprint`]).trim()
  return { dir, cer, thumb }
}

// 更可靠：直接用 PowerShell 的 New-SelfSignedCertificate 做两级
function genCertsPS() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flicker-labcert-'))
  // 关键：根 CA 必须显式带 basicConstraints CA=TRUE，否则浏览器拒绝整条链
  const ps = `
$ErrorActionPreference='Stop'
$caParams = @{
  Subject           = 'CN=Flicker Lab Session CA'
  KeyUsage          = 'CertSign','CRLSign'
  KeyExportPolicy   = 'Exportable'
  CertStoreLocation = 'Cert:\\CurrentUser\\My'
  NotAfter          = (Get-Date).AddDays(7)
  TextExtension     = @('2.5.29.19={critical}{text}ca=1')
}
$ca  = New-SelfSignedCertificate @caParams
$srv = New-SelfSignedCertificate -Subject 'CN=${HOST}' -Signer $ca -KeyExportPolicy Exportable -CertStoreLocation 'Cert:\\CurrentUser\\My' -NotAfter (Get-Date).AddDays(7) -TextExtension @('2.5.29.17={critical}{text}IPAddress=${HOST}&IPAddress=127.0.0.1&DNS=localhost')
$pwd = ConvertTo-SecureString -String 'lab' -Force -AsPlainText
Export-PfxCertificate -Cert $srv -FilePath '${dir.replace(/\\/g, '\\\\')}\\srv.pfx' -Password $pwd | Out-Null
Export-Certificate  -Cert $ca  -FilePath '${dir.replace(/\\/g, '\\\\')}\\ca.cer' | Out-Null
"CA_THUMB=$($ca.Thumbprint)"
"SVR_THUMB=$($srv.Thumbprint)"
"SVR_SAN=$($srv.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.17' } | ForEach-Object { $_.Format(0) })"
"CA_BASIC=$($ca.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.19' } | ForEach-Object { $_.Format(0) })"
"SVR_BASIC=$($srv.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.19' } | ForEach-Object { $_.Format(0) })"
"SVR_EKU=$($srv.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.37' } | ForEach-Object { $_.Format(0) })"
"SVR_CHAIN=$($srv.Verify())"
`
  const out = sh('powershell', ['-NoProfile', '-Command', ps])
  const g = (k) => (out.match(new RegExp(k + '=(.*)')) || [])[1]?.trim()
  return {
    dir, caThumb: g('CA_THUMB'), srvThumb: g('SVR_THUMB'), san: g('SVR_SAN'),
    caBasic: g('CA_BASIC'), srvBasic: g('SVR_BASIC'), eku: g('SVR_EKU'),
    chainValid: g('SVR_CHAIN'), raw: out,
  }
}

// ── 手搓 CDP WebSocket 客户端（零依赖）──────────────────────
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
    req.on('upgrade', (_res, socket) => {
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
          const payload = buf.subarray(off, off + len)
          buf = buf.subarray(off + len)
          if (op !== 1) continue
          const msg = JSON.parse(payload.toString())
          if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
          else handlers.forEach((h) => h(msg))
        }
      })
      const send = (method, params = {}) => new Promise((res) => {
        const myId = ++id
        pending.set(myId, res)
        const body = Buffer.from(JSON.stringify({ id: myId, method, params }))
        const mask = Buffer.from([1, 2, 3, 4])
        for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4]
        const head = body.length < 126
          ? Buffer.from([0x81, 0x80 | body.length])
          : Buffer.concat([Buffer.from([0x81, 0xfe]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(body.length); return b })()])
        socket.write(Buffer.concat([head, mask, body]))
      })
      resolve({ send, on: (h) => handlers.push(h), close: () => socket.destroy() })
    })
    req.on('error', reject)
    req.end()
  })
}

// ── 主流程 ─────────────────────────────────────────────────
const main = async () => {
  const APPMODE = flag('app')
  const MODE = APPMODE ? 'app 无地址栏窗口' : (HEADLESS ? 'headless=new' : '真实窗口')
  console.log('=== 证书信任验证台 ===')
  console.log(`目标地址: https://${HOST}:${PORT}   浏览器: Edge   模式: ${MODE}`)
  console.log(`策略: ${INSTALL ? '自签证书 + 装入当前用户 Root 库' : '自签证书，不装（对照组）'}\n`)

  const c = genCertsPS()
  console.log('证书生成:')
  console.log('  ' + c.raw.trim().split('\n').join('\n  '))
  console.log()

  const before = certCount()
  const thumb = c.caThumb.replace(/[^0-9A-F]/gi, '')
  if (INSTALL) {
    sh('certutil', ['-user', '-addstore', '-f', 'Root', path.join(c.dir, 'ca.cer')])
    console.log(`Root 库: ${before} → ${certCount()}`)
  }

  const server = https.createServer({
    pfx: fs.readFileSync(path.join(c.dir, 'srv.pfx')),
    passphrase: 'lab',
  }, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><meta charset=utf-8><h1>证书验证页</h1>')
  })
  await new Promise((r) => server.listen(PORT, USE_LAN ? '0.0.0.0' : '127.0.0.1', r))
  console.log(`HTTPS 已监听 https://${HOST}:${PORT}\n`)

  const profile = path.join(os.tmpdir(), 'lab-prof-' + Date.now())
  // 关键：profile 目录必须由我们创建，否则已有实例会吞掉 --new-window，导致新窗口
  // 使用旧 profile —— 而旧 profile 里可能缓存着上一次的证书错误，让测试得出假结论
  fs.mkdirSync(profile, { recursive: true })
  const browserArgs = [
    ...(flag('ignore-cert') ? ['--ignore-certificate-errors'] : []),
    ...(APPMODE ? [`--app=https://${HOST}:${PORT}/`] : [HEADLESS ? '--headless=new' : '--new-window']),
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', 'about:blank',
  ]
  const child = spawn(EDGE, browserArgs, { stdio: 'ignore' })

  let ver, list
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try {
      ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()
      list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
      break
    } catch {}
  }
  if (!ver) { console.log('❌ 无法连接 CDP'); process.exit(1) }
  console.log('浏览器:', ver.Browser)

  const target = list.find((t) => t.type === 'page')
  const conn = await cdp(target.webSocketDebuggerUrl)
  await conn.send('Page.enable')
  await conn.send('Network.enable')
  // 清掉可能被继承的证书错误缓存，保证这次测试是干净的
  await conn.send('Network.clearBrowserCache')

  let security = null
  const failures = []
  conn.on((m) => {
    if (m.method === 'Network.responseReceived') {
      const sd = m.params.response.securityDetails
      if (sd) security = sd
    }
    if (m.method === 'Network.loadingFailed') failures.push(m.params)
  })

  await conn.send('Page.navigate', { url: `https://${HOST}:${PORT}/` })
  try { await conn.send('Page.bringToFront') } catch {}
  await new Promise((r) => setTimeout(r, 4000))

  const title = (await conn.send('Runtime.evaluate', {
    expression: `document.querySelector('h1')?.textContent || '(未渲染)'`, returnByValue: true,
  })).result.result.value

  // 直接检测"是不是停在浏览器的安全警告页"（而不是我们的页面）
  const interstitial = (await conn.send('Runtime.evaluate', {
    expression: `(() => {
      const t = document.body ? document.body.innerText.slice(0, 400) : '';
      const marks = ['不是专用连接','隐私设置错误','NET::ERR','继续前往','高级','您的连接不是私密','back to safety','Proceed'];
      const hit = marks.filter(m => t.includes(m) || document.title.includes(m));
      return JSON.stringify({ title: document.title, hit, sample: t.replace(/\\s+/g,' ').slice(0,90) });
    })()`, returnByValue: true,
  })).result.result.value
  const ist = JSON.parse(interstitial)

  // 关键证据：浏览器自己的验证结论
  const secState = (await conn.send('Runtime.evaluate', {
    expression: `(async()=>{try{const r=await fetch('https://${HOST}:${PORT}/ping',{cache:'no-store'});return 'fetch_OK_'+r.status}catch(e){return 'fetch_FAIL: '+e.message}})()`,
    awaitPromise: true, returnByValue: true,
  })).result.result.value

  console.log('\n──────────── 判定 ────────────')
  console.log('页面渲染内容      :', title)
  console.log('页面标题          :', ist.title)
  console.log('页面内 fetch 结果 :', secState)
  console.log('CDP 看到的 SSL 信息:', security ? '有 (说明确实建立了 TLS 连接)' : '无')
  console.log('安全警告页标志    :', ist.hit.length ? '⚠️ 命中 ' + ist.hit.join(',') : '无')
  console.log('页面开头          :', ist.sample)
  if (failures.length) {
    console.log('加载失败事件      :')
    for (const f of failures.slice(0, 5)) console.log('   -', f.type, '|', f.errorText, '|', f.blockedReason || '')
  } else {
    console.log('加载失败事件      : 无')
  }

  let verdict
  if (ist.hit.length) {
    verdict = '❌ 停在安全警告页 —— 需要在真实窗口里点"继续访问"才行'
  } else if (title.includes('证书验证页') && secState.startsWith('fetch_OK')) {
    verdict = '✅ 成立 —— 浏览器接受了这张证书，真实窗口下无警告'
  } else if (failures.some((f) => f.errorText?.includes('CERT'))) {
    verdict = `❌ 失败 —— 证书被拒绝: ${failures.find((f) => f.errorText?.includes('CERT')).errorText}`
  } else {
    verdict = '⚠️ 未能判定，需人工看窗口'
  }
  console.log('\n结论:', verdict)

  if (!HEADLESS && !flag('app')) {
    console.log('\n[真实窗口模式] 窗口将保持 12 秒，你可以肉眼确认地址栏有没有安全警告')
    await new Promise((r) => setTimeout(r, 12000))
  }

  conn.close()
  try { child.kill() } catch {}
  await new Promise((r) => server.close(r))
  if (INSTALL) {
    try { sh('certutil', ['-user', '-delstore', 'Root', thumb]) } catch (e) { console.log('卸载警告:', e.message) }
    console.log(`Root 库: → ${certCount()} (应为 ${before})`)
  }
  // 清掉 My 库里的探针证书
  sh('powershell', ['-NoProfile', '-Command',
    `Get-ChildItem Cert:\\CurrentUser\\My | Where-Object { $_.Subject -like '*Flicker Lab*' } | Remove-Item -Force`])
  fs.rmSync(profile, { recursive: true, force: true })
  fs.rmSync(c.dir, { recursive: true, force: true })
  console.log('探针已清理')
  process.exit(0)
}
main().catch((e) => { console.error('运行失败:', e.message, e.stdout || '', e.stderr || ''); process.exit(1) })
