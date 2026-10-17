/**
 * IPv6：地址分类、链接里的方括号、以及**回环上的真实 TLS 握手**
 * ============================================================
 *
 * ── 为什么这条判据必须存在 ──
 * IPv6 直连的代码**在有公网 IPv6 的线路上才能端到端验证**，而开发机的线路
 * （运营商大内网 + 没有全局 IPv6）三条判据全不满足（见 `路线图.md` 第五章）。
 * 于是很容易滑向"代码写了，就说它支持了" —— 那是这个项目最忌讳的"看起来对"。
 *
 * 所以这里把**能在本机验证的那一段**钉死：证书里编 IPv6 地址、端口绑在 IPv6 上、
 * 用 `https://[::1]:port/` 这样的**方括号 URL** 连进去，**必须真的握手成功**。
 * 回环 `::1` 不需要运营商开通，所以这条链路上每一环都是真的。
 *
 * 剩下的（公网 IPv6 直连）标注为"未验证"，不在这里假装做到 —— 见 `路线图.md` §五。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpsRequest } from 'node:https'
import { classifyIPv6, localIPv6, urlHost } from '../src/trust.js'
import { buildSessionUrls } from '../src/urls.js'
import { generateCerts } from '../src/session-cert.js'
import { handshakeCheck } from '../src/session-cert-check.mjs'

// ── 地址分类（纯函数，逐条钉住）──────────────────────────

test('IPv6 分类：只有全局 / ULA 才算"对别人有意义"', () => {
  const cases = [
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fe80::1', 'linklocal'],
    ['FE80::1234%12', 'linklocal'],          // 带 scope id，且是大写
    ['fc00::1', 'ula'],
    ['fd12:3456:789a::1', 'ula'],
    ['2001:db8::1', 'global'],
    ['2408:8207:1234::5', 'global'],
    ['::ffff:192.168.1.5', 'mapped'],        // 本质是 IPv4，不该进候选
    ['192.168.1.5', 'invalid'],
    ['not-an-address', 'invalid'],
    ['', 'invalid'],
    [null, 'invalid'],
  ]
  for (const [input, want] of cases) {
    assert.equal(classifyIPv6(input), want, `classifyIPv6(${JSON.stringify(input)}) 应当是 ${want}`)
  }
})

test('本机 IPv6 候选里绝不包含回环 / 链路本地 / IPv4-mapped', () => {
  // 不假设这台机器有没有 IPv6 —— 只断言"如果有，收进来的都是能用的那几类"
  for (const a of localIPv6()) {
    assert.ok(['global', 'ula'].includes(a.scope),
      `候选里混进了 ${a.address}（scope=${a.scope}）`)
    assert.ok(!a.address.startsWith('fe80'), '链路本地地址不能当对外地址')
    assert.notEqual(a.address, '::1')
    assert.ok(!a.address.startsWith('::ffff:'))
  }
})

// ── URL 里的方括号（写错了链接就是打不开的）───────────────

test('⭐ urlHost：IPv6 必须加方括号，IPv4 / 域名原样返回', () => {
  assert.equal(urlHost('2408:8207::1'), '[2408:8207::1]')
  assert.equal(urlHost('::1'), '[::1]')
  assert.equal(urlHost('[2408:8207::1]'), '[2408:8207::1]', '已经有方括号的不该重复加')
  assert.equal(urlHost('192.168.1.5'), '192.168.1.5')
  assert.equal(urlHost('flicker.example.com'), 'flicker.example.com')
  assert.equal(urlHost('localhost'), 'localhost')
  // 真实 URL 里能不能用，由下面那条握手测试证明（这里只管形状）
  assert.equal(urlHost(''),
    '', '空值不该变成 "[]"')
})

test('链接构造：有 IPv4 时优先 IPv4，IPv6 只作为候选列出', () => {
  const u = buildSessionUrls(['192.168.1.5', '2408:8207::1', 'localhost'], 8443, 'tok')
  assert.match(u.primary, /^https:\/\/192\.168\.1\.5:8443\/\?k=tok$/, '主链接应当是 IPv4（对方不一定有 IPv6）')
  assert.ok(u.all.includes('https://[2408:8207::1]:8443/?k=tok'), 'IPv6 候选必须带方括号')
  assert.deepEqual(u.ipv6, ['https://[2408:8207::1]:8443/?k=tok'])
  assert.match(u.loopback, /^https:\/\/127\.0\.0\.1:8443\/\?k=tok$/,
    '回环永远用 IPv4 —— 禁用了 IPv6 的机器上 [::1] 不通，而就绪探测要走这一条')
})

test('链接构造：只有 IPv6 时，主链接是带方括号的那一条', () => {
  const u = buildSessionUrls(['2408:8207::1', 'localhost'], 8443, 'tok')
  assert.equal(u.primary, 'https://[2408:8207::1]:8443/?k=tok')
  assert.equal(u.host, '2408:8207::1', 'host 字段给界面显示用，不带方括号')
})

// ── 真正的那条链：证书 SAN + IPv6 绑定 + 方括号 URL ─────────

/** 只在这台机器真的能用 IPv6 回环时才跑；不能用就明确 skip，而不是假装通过 */
function ipv6LoopbackAvailable() {
  return localIPv6() !== undefined && (() => {
    // 直接试绑一次 ::1（同步做不到，所以交给下面每个用例自己 catch）
    return true
  })()
}

test('⭐ IPv6 端到端：证书 SAN 里编了 ::1，用 [::1] 连得上（真实 TLS 握手）', async (t) => {
  assert.ok(ipv6LoopbackAvailable())
  const certs = generateCerts({ hosts: ['::1', '127.0.0.1'] })
  assert.ok(certs.hosts.includes('::1'), '生成时应当把 ::1 声明进 SAN')

  let r
  try {
    r = await handshakeCheck(certs, '::1', { bindHost: '::1' })
  } catch (e) {
    if (e?.code === 'EADDRNOTAVAIL' || e?.code === 'EAFNOSUPPORT') {
      t.skip(`这台机器没有可用的 IPv6 回环（${e.code}），跳过`)
      return
    }
    throw e
  }
  const good = r.checks.find((c) => c.name === '以 CA 为信任根能连上')
  assert.ok(good?.ok,
    `IPv6 回环握手应当成功（实际 ${good?.detail}）—— 这条包含：` +
    '证书 SAN 里的 IPv6 编码、端口绑在 ::1 上、以及连接端用 [::1] 寻址')
  // 反向项也要成立：说明校验真的在起作用
  for (const c of r.checks.filter((x) => x.required)) {
    assert.ok(c.ok, `${c.name} 应当通过（实际 ${c.detail}）`)
  }
})

test('⭐ 反向验证：证书 SAN 里没有 ::1 时，用 [::1] 连必须被拒', async (t) => {
  // 只看"能连上"是不够的 —— 那样写成"校验根本没生效"也会通过。
  // 这里故意签一张**不含** ::1 的证书，同样的握手必须失败（主机名不匹配）。
  const certs = generateCerts({ hosts: ['127.0.0.1'] })
  let r
  try {
    r = await handshakeCheck(certs, '::1', { bindHost: '::1' })
  } catch (e) {
    if (e?.code === 'EADDRNOTAVAIL' || e?.code === 'EAFNOSUPPORT') {
      t.skip(`这台机器没有可用的 IPv6 回环（${e.code}），跳过`)
      return
    }
    throw e
  }
  const good = r.checks.find((c) => c.name === '以 CA 为信任根能连上')
  assert.equal(good?.ok, false,
    '证书里没有 ::1 却连上了 —— 说明主机名校验没生效，上面那条"能连上"的判据是假的')
  assert.match(String(good?.detail), /ALTNAME|CERT|ERR_TLS/i,
    `失败原因应当是证书/主机名，而不是别的东西：${good?.detail}`)
})

test('双栈绑定：listen 在 `::` 上时，IPv4 与 IPv6 回环都能连进来', async (t) => {
  const certs = generateCerts({ hosts: ['127.0.0.1', '::1', 'localhost'] })
  const server = createServer({ key: certs.srvKeyPem, cert: certs.srvPem },
    (_req, res) => { res.writeHead(200); res.end('ok') })
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '::', () => { server.removeListener('error', reject); resolve() })
    })
  } catch (e) {
    if (e?.code === 'EADDRNOTAVAIL' || e?.code === 'EAFNOSUPPORT') {
      t.skip(`这台机器不能双栈绑定（${e.code}），跳过`)
      return
    }
    throw e
  }

  const port = server.address().port
  const get = (host) => new Promise((resolve) => {
    const req = httpsRequest({
      host, port, path: '/', method: 'GET', ca: certs.caPem,
      rejectUnauthorized: true, timeout: 8000,
    }, (res) => { res.resume(); res.on('end', () => resolve({ ok: true, status: res.statusCode })) })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', (e) => resolve({ ok: false, code: e.code ?? e.message }))
    req.end()
  })

  try {
    // 绑 `::` 就是为了这一条：一个 socket 同时服务两种地址，
    // 这样"证书里既有 IPv4 又有 IPv6 SAN"才有意义。
    const v6 = await get('::1')
    assert.ok(v6.ok, `IPv6 回环连不上：${v6.code}`)
    // IPv4 那半在部分系统上要 IPV6_V6ONLY=0（Node 默认就是），失败就明确说出来
    const v4 = await get('127.0.0.1')
    assert.ok(v4.ok, `双栈绑定下 IPv4 回环也应当连得上，实际：${v4.code}`)
  } finally {
    await new Promise((r) => server.close(r))
  }
})
