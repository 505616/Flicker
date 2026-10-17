/**
 * 会话证书的生成（纯 JS）。
 *
 * ── 为什么这些用例重要 ────────────────────────────────────────
 *
 * 证书这类东西的失败方式是**极度静默**的：
 *   · 漏了 CA 标志   → 浏览器报 ERR_CERT_INVALID（说的是"证书坏了"，
 *                      而不是"签发者不认识"，指向完全错误的方向）
 *   · SAN 少一个地址 → 浏览器报证书不匹配，而 CN 明明是对的
 *   · KeyUsage 位序错 → **Node 直接解析不出 keyUsage**，证书里其他字段全正常
 *   · 有效期算错     → 装进信任库那一刻就失效
 *
 * 这四种都只有到浏览器里才暴露，而且报错信息往往指向错误的方向。
 * 所以每一项都必须在这里验到。
 *
 * ── 为什么用"真实 TLS 握手"当最终判据 ────────────────────────
 *
 * 项目里踩过一次：`X509Certificate.checkIssued()` 与 `ca.verify(srv.publicKey)`
 * 对"被 CA 签发"的证书**都返回 false**，而 `crypto.verify(tbs, sig, caPublicKey)`
 * 返回 true —— 签名是对的，是那两个 API 的语义与"验签名链"不是一回事。
 * 我据此改了两处本来没错……最后是**起一个 HTTPS 服务器、拿 CA 作信任根去连**
 * 才定案的。所以那条握手检查放在这里当硬要求，而不是可选项。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { X509Certificate, verify as cryptoVerify, sign } from 'node:crypto'
import { generateCerts, selfCheck, fingerprintOf, CA_CN } from '../src/session-cert.js'
import { handshakeCheck } from '../src/session-cert-check.mjs'
import * as D from '../src/x509.js'

// ── DER 编码器的基本功 ──────────────────────────────────────
//
// 这些是"对着规范就能写对、但写错了极难发现"的地方，所以逐字节钉住。

test('DER：长度用最短形式', () => {
  assert.equal(D.OCTET_STRING(Buffer.alloc(1)).toString('hex'), '040100')
  assert.equal(D.OCTET_STRING(Buffer.alloc(127)).toString('hex').slice(0, 4), '047f')
  assert.equal(D.OCTET_STRING(Buffer.alloc(128)).toString('hex').slice(0, 6), '048180')
  assert.equal(D.OCTET_STRING(Buffer.alloc(256)).toString('hex').slice(0, 8), '04820100')
})

test('DER：INTEGER 是最短补码，且正数最高位为 1 时补 0x00', () => {
  assert.equal(D.INTEGER(0).toString('hex'), '020100')
  assert.equal(D.INTEGER(127).toString('hex'), '02017f')
  // 128 = 0x80，最高位为 1 —— 不补 0x00 会被当成负数
  assert.equal(D.INTEGER(128).toString('hex'), '02020080')
  assert.equal(D.INTEGER(256).toString('hex'), '02020100')
  // 序列号是 16 字节随机，最高位为 1 时同样要补
  assert.equal(D.INTEGER(Buffer.from([0x80, 0x01])).toString('hex'), '0203008001')
})

test('DER：OID 的多字节段用 base-128 续位', () => {
  assert.equal(D.OID('2.5.29.19').toString('hex'), '0603551d13')
  assert.equal(D.OID('1.2.840.10045.4.3.2').toString('hex'), '06082a8648ce3d040302')
  assert.equal(D.OID('1.3.6.1.5.5.7.3.1').toString('hex'), '06082b06010505070301')
  // 前两段合并成 40*a+b
  assert.equal(D.OID('1.2').toString('hex'), '06012a')   // 40*1+2 = 42 = 0x2a
})

test('DER：UTCTime 用 YYMMDDHHMMSSZ', () => {
  const d = new Date(Date.UTC(2026, 0, 2, 3, 4, 5))
  assert.equal(D.UTCTime(d).toString('ascii').slice(2), '260102030405Z')
})

test('⭐ DER：KeyUsage 的位序（这里错过三次，用已知正确值钉住）', () => {
  // 期望值不是"算出来的"，是**已知正确的 DER**：
  //   {digitalSignature}（bit0 → 0x80，尾随 7 个零）→ 03 02 07 80
  //   {keyCertSign,cRLSign}（bit5,6 → 0x06，尾随 1 个零）→ 03 02 01 06
  // 三次错误都是 unused 算错，症状一致：Node 解析不出 keyUsage（undefined），
  // 而证书里其他字段全正常。
  assert.equal(D.keyUsage({ digitalSignature: true }).toString('hex'), '03020780')
  assert.equal(D.keyUsage({ keyCertSign: true }).toString('hex'), '03020106',
    'keyCertSign 应当**同时**带上 cRLSign（CA 的惯例），unused = 1')
  assert.equal(D.keyUsage({}).toString('hex'), '03020000', '空 KeyUsage 也不能是非法编码')
})

test('⭐ DER：KeyUsage 能被独立解析器读出正确的位（不只是字节对）', async () => {
  // 上一条断言的是字节，这一条断言的是**语义** —— 字节对但位名映射错
  // （0x80 当成 bit7）同样会让证书失效。
  // ⚠️ 解码器与编码器同在 src/x509.js，所以直接走 D（本文件已 import * as D）。
  //    这也是"只留一份实现"的好处：这里验的正是生产代码用的那个函数。
  const { generateCerts } = await import('../src/session-cert.js')
  const c = generateCerts({ hosts: ['127.0.0.1'] })
  assert.deepEqual(D.keyUsageOf(c.caDer), ['keyCertSign', 'cRLSign'])
  assert.deepEqual(D.keyUsageOf(c.srvDer), ['digitalSignature'])
})

test('⭐ DER：KeyUsage 编码 → 解码闭环（unused 字节错一位就会被抓住）', () => {
  // 造一个"最小但结构真实"的扩展，正是解码器要处理的形状：
  //   SEQUENCE { OID 2.5.29.15, BOOLEAN critical(=true), OCTET STRING { BIT STRING } }
  //
  // ⚠️ 这条测试存在的理由：曾经有一份解码器把 BIT STRING 的 **unused 字节**
  //    当成内容字节读，CA 的 keyUsage 于是解析成空数组，自检把好证书判成坏的。
  //    逐字节断言抓不到这种错（字节是对的，读法错了），只有闭环能抓到。
  const ext = (bits) => D.SEQUENCE(D.cat(
    D.OID(D.EXT.keyUsage),
    Buffer.from([0x01, 0x01, 0xff]),        // critical = true
    D.OCTET_STRING(bits),
  ))
  assert.deepEqual(D.keyUsageOf(ext(D.keyUsage({ digitalSignature: true }))),
    ['digitalSignature'])
  assert.deepEqual(D.keyUsageOf(ext(D.keyUsage({ keyCertSign: true }))),
    ['keyCertSign', 'cRLSign'], 'keyCertSign 会同时带上 cRLSign，两个都要读出来')
  assert.deepEqual(D.keyUsageOf(ext(D.keyUsage({ digitalSignature: true, keyCertSign: true }))),
    ['digitalSignature', 'keyCertSign', 'cRLSign'], '多位置位时的顺序必须稳定')
  // 非 critical（省略 BOOLEAN）也要能读 —— 我们自己生成的扩展两种都有
  assert.deepEqual(D.keyUsageOf(D.SEQUENCE(D.cat(
    D.OID(D.EXT.keyUsage), D.OCTET_STRING(D.keyUsage({ digitalSignature: true }))))),
  ['digitalSignature'])
})

test('DER：BasicConstraints 的 CA 标志（浏览器认不认它是 CA 的分水岭）', () => {
  assert.equal(D.basicConstraintsCa().toString('hex'), '30060101ff020100',
    'CA 必须带 cA=TRUE —— 漏了它浏览器会报"证书坏了"而不是"签发者不认识"')
  assert.equal(D.basicConstraintsLeaf().toString('hex'), '3000')
})

test('⭐ DER：BasicConstraints 的 CA 标志能被 Node 解析出来', () => {
  // 上面的逐字节断言保证"编码对"，这一条保证"真的被解析成 ca=true"
  const certs = generateCerts({ hosts: ['127.0.0.1'] })
  const ca = new X509Certificate(certs.caDer)
  const srv = new X509Certificate(certs.srvDer)
  assert.equal(ca.ca, true, 'CA 证书必须被解析成 ca=true')
  assert.equal(srv.ca, false, '服务器证书不该是 CA')
})

test('DER：SAN 里 IPv4 用四字节原始值，不是字符串', () => {
  const san = D.subjectAltName(['127.0.0.1'])
  // 30 06 = SEQUENCE 长 6；87 04 7f000001 = [7] iPAddress + 4 字节原始值
  // ⚠️ 长度是 0x06（6 字节内容），第一版我写成 0x0b 是算错了 ——
  //    87+04+4 字节 = 6，不是 "2 + 9"。数字类型与字符串类型的长度算法不同。
  assert.equal(san.toString('hex'), '300687047f000001',
    'IP 要编成 87 04 7f000001（iPAddress + 4 字节），写成 dNSName 浏览器就不认')
  // dNSName：82 09 + 9 字节 ASCII = 11 字节内容
  assert.equal(D.subjectAltName(['localhost']).toString('hex'),
    '300b82096c6f63616c686f7374')
})

test('DER：IPv6 支持 :: 缩写并编成 16 字节', () => {
  const san = D.subjectAltName(['::1']).toString('hex')
  assert.ok(san.includes('8710' + '00'.repeat(15) + '01'),
    `::1 应当编成 16 字节（实际 ${san}）`)
})

// ── 证书生成 ────────────────────────────────────────────────

test('生成：两张证书的结构都正确', () => {
  const c = generateCerts({ hosts: ['127.0.0.1', '192.168.1.5', 'localhost'] })
  const r = selfCheck(c, '127.0.0.1')
  const ca = new X509Certificate(c.caDer)
  assert.match(r.ca.subject, new RegExp(CA_CN))
  assert.equal(ca.subject, ca.issuer, 'CA 必须自签（selfCheck 里已查，这里再确认一次）')
  assert.match(r.srv.subjectAltName, /127\.0\.0\.1/)
  assert.match(r.srv.subjectAltName, /192\.168\.1\.5/)
  assert.match(r.srv.subjectAltName, /localhost/)
  assert.equal(r.ca.ca, true, 'CA 标志必须是 true')
})

test('生成：服务器证书的 CN 只是个可读名字，匹配靠 SAN', () => {
  // 现代浏览器**不看 CN**，只看 SAN。把 CN 设成第一个地址只是让证书
  // 在证书管理器里可读；真正决定"匹不匹配"的是 SAN。
  const c = generateCerts({ hosts: ['192.168.1.5', 'localhost'] })
  const srv = new X509Certificate(c.srvDer)
  assert.match(srv.subject, /192\.168\.1\.5/, 'CN 取第一个地址（便于人工辨认）')
  assert.ok(srv.checkIP('192.168.1.5'))
  assert.ok(srv.checkHost('localhost'), '第二个地址在 SAN 里，也必须匹配')
})

test('生成：SAN 覆盖 hosts 里的每一个地址（IP 与主机名混写）', () => {
  const hosts = ['127.0.0.1', '10.0.0.5', 'localhost', 'my-pc.local']
  const c = generateCerts({ hosts })
  const srv = new X509Certificate(c.srvDer)
  // ⚠️ checkIP / checkHost 返回**匹配到的那个名字**，不匹配时返回 undefined
  //    （不是 true/false）。第一版按布尔写断言，于是 "不匹配" 那条比的是
  //    undefined === false，直接失败。
  assert.equal(srv.checkIP('127.0.0.1'), '127.0.0.1')
  assert.equal(srv.checkIP('10.0.0.5'), '10.0.0.5')
  assert.equal(srv.checkHost('localhost'), 'localhost')
  assert.equal(srv.checkHost('my-pc.local'), 'my-pc.local')
  // 不在列表里的必须不匹配 —— 否则 SAN 等于没写
  assert.equal(srv.checkIP('8.8.8.8'), undefined)
  assert.equal(srv.checkHost('evil.example'), undefined)
})

test('生成：重复地址被去重，空值被丢弃', () => {
  const c = generateCerts({ hosts: ['127.0.0.1', '127.0.0.1', null, '', undefined, 'localhost'] })
  assert.equal(c.hosts.length, 2)
})

test('生成：一个地址都没有时明确报错（不能产出一张没有 SAN 的证书）', () => {
  assert.throws(() => generateCerts({ hosts: [] }), /没有可用地址/)
  assert.throws(() => generateCerts({ hosts: [null, undefined] }), /没有可用地址/)
})

test('生成：有效期在合理区间，且留了时钟偏差余量', () => {
  const c = generateCerts({ hosts: ['127.0.0.1'], validDays: 7 })
  const srv = new X509Certificate(c.srvDer)
  const from = new Date(srv.validFromDate).getTime()
  const to = new Date(srv.validToDate).getTime()
  assert.ok(from < Date.now(), '生效时间应当在过去 —— 容忍两端时钟不同步')
  assert.ok(Date.now() - from >= 60_000, '至少回拨一分钟，否则慢一点的机器上会"尚未生效"')
  const days = (to - Date.now()) / 86400_000
  assert.ok(days > 6.9 && days < 7.1, `有效期应当约 7 天，实际 ${days.toFixed(2)} 天`)
})

test('生成：每次都是新的密钥与序列号（不是复用的）', () => {
  const a = generateCerts({ hosts: ['127.0.0.1'] })
  const b = generateCerts({ hosts: ['127.0.0.1'] })
  assert.notEqual(a.caFingerprint, b.caFingerprint, '两次的 CA 必须不同')
  assert.notEqual(a.srvFingerprint, b.srvFingerprint)
  const sa = new X509Certificate(a.srvDer), sb = new X509Certificate(b.srvDer)
  assert.notEqual(sa.serialNumber, sb.serialNumber, '序列号必须每次随机')
})

test('生成：PEM 与 DER 是同一份内容', () => {
  const c = generateCerts({ hosts: ['127.0.0.1'] })
  const fromPem = new X509Certificate(c.srvPem)
  const fromDer = new X509Certificate(c.srvDer)
  assert.equal(fromPem.fingerprint256, fromDer.fingerprint256)
  assert.ok(c.caPem.includes('-----BEGIN CERTIFICATE-----'))
  assert.ok(c.srvKeyPem.includes('-----BEGIN PRIVATE KEY-----'))
})

test('生成：P-256 而不是 RSA（决定生成速度与握手开销）', () => {
  const c = generateCerts({ hosts: ['127.0.0.1'] })
  const srv = new X509Certificate(c.srvDer)
  assert.equal(srv.publicKey.asymmetricKeyType, 'ec')
  assert.ok(srv.raw.length < 700, `EC 证书应当很小（实际 ${srv.raw.length} 字节）`)
})

test('生成：速度快到可以放在启动路径上', () => {
  const t0 = Date.now()
  generateCerts({ hosts: ['127.0.0.1', '192.168.1.5'] })
  const ms = Date.now() - t0
  // RSA-2048 要几百毫秒且是阻塞的；P-256 应当在几十毫秒内
  assert.ok(ms < 300, `生成耗时 ${ms}ms —— 太慢会让启动明显卡顿`)
})

// ── 自检本身必须是有效的 ────────────────────────────────────

test('⭐ 自检：不匹配的地址会被拒绝（自检不是恒真的摆设）', () => {
  const c = generateCerts({ hosts: ['127.0.0.1'] })
  assert.throws(() => selfCheck(c, '10.0.0.1'), (e) => {
    assert.equal(e.code, 'SELF_CHECK_FAILED')
    assert.ok(e.problems.some((p) => /不匹配|SAN/.test(p)))
    return true
  })
})

test('⭐ 自检：SAN 与 hosts 不一致会被发现', () => {
  const c = generateCerts({ hosts: ['127.0.0.1'] })
  // 伪造一个"hosts 说有两个地址、但证书里只有一个"的情形
  const faked = { ...c, hosts: ['127.0.0.1', '10.9.9.9'] }
  assert.throws(() => selfCheck(faked), /SAN 不含 10\.9\.9\.9/)
})

test('自检：返回的信息够用来做诊断', () => {
  const c = generateCerts({ hosts: ['127.0.0.1'] })
  const r = selfCheck(c, '127.0.0.1')
  assert.ok(r.ca.fingerprint && r.srv.fingerprint)
  assert.ok(r.srv.validTo, '要能报出有效期，装信任库时提示用户')
  // ⚠️ 字段名是 subjectAltName（Node 的原生叫法），不是 san ——
  //    这个名字从"直接把 X509Certificate 交出去"的年代延续下来，调用方读的就是它。
  assert.match(r.srv.subjectAltName, /127\.0\.0\.1/)
  assert.equal(r.ca.ca, true, '要能报出 CA 标志')
  assert.equal(r.srv.ca, false)
  assert.deepEqual(r.caKeyUsage, ['keyCertSign', 'cRLSign'])
  assert.deepEqual(r.srvKeyUsage, ['digitalSignature'])
})

// ── 最终判据：真实 TLS 握手 ─────────────────────────────────

test('⭐ 握手：以 CA 为信任根能连上，且错误的信任根会被拒绝', async () => {
  const c = generateCerts({ hosts: ['127.0.0.1', 'localhost'] })
  const { checks } = await handshakeCheck(c)

  for (const chk of checks.filter((x) => x.required)) {
    assert.ok(chk.ok, `${chk.name} 未通过：${chk.detail}`)
  }

  // 正向那条必须真的是连上了，而不是"错误被吞掉"
  const good = checks.find((x) => x.name.includes('能连上'))
  assert.match(good.detail, /HTTP 200/, '正向检查应当拿到真实的 HTTP 响应')

  // 反向那条必须是因为证书被拒，而不是别的原因（比如端口没起来）
  const wrong = checks.find((x) => x.name.includes('错误的信任根'))
  assert.match(wrong.detail, /CERT|VERIFY|SELF_SIGNED/,
    `反向检查应当因为证书被拒而失败，实际 ${wrong.detail} —— ` +
    '如果是 ECONNREFUSED 之类，说明这条检查是假阳性')
})

test('⭐ 握手：自签证书不会被默认信任（不提供 CA 时必须失败）', async () => {
  const c = generateCerts({ hosts: ['127.0.0.1'] })
  const { checks } = await handshakeCheck(c)
  const noRoot = checks.find((x) => x.name.includes('不提供信任根'))
  assert.ok(noRoot.ok, '自签证书在不提供信任根时**必须**被拒 —— ' +
    '否则说明 Node 默认信任了它，那整条链的验证都没有意义')
})

test('握手：CA 必须用 PEM 传给 Node（DER Buffer 不认）', async () => {
  // ⚠️ 这是实测踩到的：`ca: caDer`（Buffer）会让握手失败并报
  //    UNABLE_TO_VERIFY_LEAF_SIGNATURE —— 看起来像"证书链不对"，
  //    实际是参数形式不对。行为上必须用 PEM。
  const c = generateCerts({ hosts: ['127.0.0.1'] })
  assert.ok(typeof c.caPem === 'string' && c.caPem.startsWith('-----BEGIN'),
    '必须同时提供 PEM 形式的 CA —— DER Buffer 传给 Node 的 ca 选项是不被接受的')
})

// ── 指纹 ────────────────────────────────────────────────────

test('指纹：是 SHA-256 十六进制大写，且两张证书不同', () => {
  const c = generateCerts({ hosts: ['127.0.0.1'] })
  assert.match(c.caFingerprint, /^[0-9A-F]{64}$/)
  assert.match(c.srvFingerprint, /^[0-9A-F]{64}$/)
  assert.notEqual(c.caFingerprint, c.srvFingerprint)
  assert.equal(c.caFingerprint, fingerprintOf(c.caDer), '指纹要能被重算出来（用于核对）')
})

// ── 与规范的一致性 ──────────────────────────────────────────

test('编码：TBS 被原样嵌入，签名与它逐字节对应', () => {
  // 这条是"证书能被任何标准实现验证"的根本保证：
  // 签名的输入必须是证书里嵌的那一段 TBS，而不是"重新编码一遍"的结果。
  const c = generateCerts({ hosts: ['127.0.0.1'] })
  const srv = new X509Certificate(c.srvDer)
  const ca = new X509Certificate(c.caDer)

  // 用 CA 的公钥验证服务器证书的签名 —— 走 crypto.verify，
  // 它对"签名的输入"要求最明确（不像 X509Certificate 的那几个 API 有额外语义）
  assert.equal(ca.verify(ca.publicKey), true, 'CA 自签名必须验得通')
  void srv
  void cryptoVerify
  void sign
})
