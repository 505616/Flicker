/**
 * 会话证书的**真实 TLS 握手自检**。
 *
 * ── 为什么用握手取代 API 校验 ────────────────────────────────
 *
 * 最初的自检用 `X509Certificate.checkIssued()` 判"CA 签发了服务器证书"，
 * 它恒返回 false。我据此以为自己的 X.509 编码错了，改了 AKI 的 IMPLICIT、
 * KeyUsage 的位序（这两处确实也错了，但**不是它的原因**）——
 * 因为那个 API 的语义与"验签名链"不是一回事。
 * 换成 `ca.verify(srv.publicKey)` 之后**依然**是 false，而
 * `crypto.verify(tbs, sig, caPublicKey)` 明明是 true。
 *
 * 与其继续猜 Node 那几个 API 的语义差异，不如直接做**最终标准那件事**：
 * 起一个用这张证书的 HTTPS 服务器，然后以这个 CA 为信任根去连它。
 *
 *   · 连得上        → 证书链、签名算法、有效期、SAN 全都对
 *   · 错误的根被拒   → 证明校验**真的在起作用**（不是恒真的摆设）
 *
 * 浏览器做的就是这件事（验链 + 验主机名 + 验有效期），所以它比任何
 * API 调用都更接近真实结论。
 */
import { createServer, request as httpsRequest, Agent } from 'node:https'
import { isIP } from 'node:net'
import { generateCerts } from './session-cert.js'

/** 发一次请求，把给定的信任根传进去 */
function tlsProbe({ port, ca, serverName, host = '127.0.0.1' }) {
  return new Promise((resolve) => {
    const opts = {
      host, port, path: '/', method: 'GET',
      ca,                                   // ⚠️ 必须是 PEM 字符串，DER Buffer 不认
      agent: new Agent({ keepAlive: false, ca }),
      rejectUnauthorized: true,
      timeout: 8000,
    }
    // ⚠️ 只有**域名**才放进 servername：
    //    RFC 6066 不允许 IP 在 SNI 里，Node 会发弃用警告、未来版本会忽略它。
    //    IP 的匹配由证书里的 IP SAN 负责 —— 所以这里用 `isIP()` 判断，
    //    而不是只匹配 IPv4 的正则（第一版就是这么写的，IPv6 会被当成域名塞进 SNI）。
    if (serverName && isIP(serverName) === 0) opts.servername = serverName
    const req = httpsRequest(opts, (res) => {
      res.resume()
      res.on('end', () => resolve({ ok: true, status: res.statusCode }))
    })
    req.on('timeout', () => { req.destroy(new Error('timeout')) })
    req.on('error', (e) => resolve({ ok: false, code: e.code ?? e.message }))
    req.end()
  })
}

/**
 * @param {object} certs generateCerts 的返回值
 * @param {string} [targetHost] 顺便用这个主机名做握手（默认回环）
 * @param {{bindHost?:string, connectHost?:string}} [opts]
 *   绑定/连接地址。默认都是 `127.0.0.1`；**IPv6 验证**时传 `::1`（或 `[::1]` 里的裸地址），
 *   这样这条判据才能覆盖"IPv6 地址进 SAN、用方括号的 URL 连得上"整条链。
 * @returns {Promise<{ checks: Array<{name:string, required:boolean, ok:boolean, detail:string}> }>}
 */
export async function handshakeCheck(certs, targetHost = '127.0.0.1', opts = {}) {
  const bindHost = opts.bindHost ?? '127.0.0.1'
  const connectHost = opts.connectHost ?? bindHost
  const server = createServer({ key: certs.srvKeyPem, cert: certs.srvPem },
    (_req, res) => { res.writeHead(200); res.end('ok') })
  await new Promise((resolve, reject) => {
    // ⚠️ 必须挂 error：绑 `::1` 在禁用了 IPv6 的机器上会失败，
    //    没有这个 listener 时 Node 会抛未捕获的 'error'，整个进程崩掉。
    server.once('error', reject)
    server.listen(0, bindHost, () => { server.removeListener('error', reject); resolve() })
  })
  const port = server.address().port

  const checks = []
  try {
    // ① 正向：用 CA 作信任根，必须连得上
    const good = await tlsProbe({ port, ca: certs.caPem, serverName: targetHost, host: connectHost })
    checks.push({
      name: '以 CA 为信任根能连上',
      required: true,
      ok: good.ok,
      detail: good.ok ? `HTTP ${good.status}` : String(good.code),
    })

    // ② 反向：拿服务器证书自己当信任根，必须被拒。
    //    没有这一条，① 可能只是"校验根本没生效"造成的假阳性。
    const wrongRoot = await tlsProbe({ port, ca: certs.srvPem, host: connectHost })
    checks.push({
      name: '错误的信任根会被拒绝',
      required: true,
      ok: !wrongRoot.ok,
      detail: wrongRoot.ok ? '竟然连上了 —— 说明证书校验没有生效' : String(wrongRoot.code),
    })

    // ③ 反向：不提供信任根，必须被拒（自签证书不该被系统默认信任）
    const noRoot = await tlsProbe({ port, ca: undefined, host: connectHost })
    checks.push({
      name: '不提供信任根会被拒绝',
      required: true,
      ok: !noRoot.ok,
      detail: noRoot.ok ? '竟然连上了 —— 自签证书被默认信任了' : String(noRoot.code),
    })

    // ④ 反向：主机名不匹配时必须被拒（浏览器会拦的那种情况）
    const badHost = await tlsProbe({ port, ca: certs.caPem, serverName: 'not-in-san.example', host: connectHost })
    checks.push({
      name: '主机名不匹配会被拒绝',
      required: false,      // 有些栈默认不做 SNI 校验，不达标不算致命
      ok: !badHost.ok,
      detail: badHost.ok ? '连上了（某些 TLS 栈不校验 SNI）' : String(badHost.code),
    })
  } finally {
    await new Promise((r) => server.close(r))
  }
  return { checks }
}

/** 跑一遍并在失败时抛出（供启动流程用） */
export async function assertHandshake(certs, targetHost) {
  const { checks } = await handshakeCheck(certs, targetHost)
  const failed = checks.filter((c) => c.required && !c.ok)
  if (failed.length) {
    const e = new Error('证书握手自检未通过：\n  - ' +
      failed.map((c) => `${c.name}（${c.detail}）`).join('\n  - '))
    e.code = 'HANDSHAKE_CHECK_FAILED'
    e.checks = checks
    throw e
  }
  return checks
}

/**
 * 直接运行：生成一套证书，跑握手自检，打印结果。
 *
 * ⚠️ 这段必须包在 async 函数里 —— **模块顶层不许有 `await`**。
 *    它在 ESM 里合法，但本项目要把模块拼成一个 CommonJS 单文件产物，
 *    顶层 await 在那边直接是语法错误（构建会失败，报"await is only valid
 *    in async functions"）。这个模块被 trust.js 静态引用，所以它进产物。
 */
async function runHandshakeSelfCheck() {
  const certs = generateCerts({ hosts: ['127.0.0.1', 'localhost'] })
  console.log('生成证书（纯 JS，无外部工具）')
  console.log('  CA 指纹    ', certs.caFingerprint.slice(0, 24) + '…')
  console.log('  服务器 SAN ', certs.hosts.join(', '))
  console.log('  有效期至   ', certs.notAfter.toISOString())
  const { checks } = await handshakeCheck(certs)
  console.log('\n真实 TLS 握手自检：')
  let bad = 0
  for (const c of checks) {
    const mark = c.ok ? '✓' : (c.required ? '✗' : '·')
    if (!c.ok && c.required) bad++
    console.log(`  ${mark} ${c.name.padEnd(24)} ${c.detail}`)
  }
  console.log(bad ? `\n✗ ${bad} 项必需检查未通过` : '\n✅ 全部通过 —— 证书可被信任根验通，且错误信任根会被拒绝')
  process.exit(bad ? 1 : 0)
}

if (process.argv[1] && /session-cert-check\.mjs$/.test(process.argv[1])) {
  runHandshakeSelfCheck().catch((e) => {
    console.error('\n  ✗ ' + (e?.message ?? e) + '\n')
    process.exit(1)
  })
}
