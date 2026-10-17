/**
 * 会话证书生成（纯 JS，零外部工具）。
 *
 * 生成两张证书：
 *   ① 自签的 CA —— `CN=Flicker Session CA`，带 CA 标志
 *   ② 服务器证书 —— 由 CA 签发，SAN 里带本次要用到的所有地址
 *
 * ── 为什么不用 PowerShell / openssl ───────────────────────────
 *
 * Windows 原来用 `New-SelfSignedCertificate`，macOS/Linux 原计划用 `openssl` 命令行。
 * 那样有三个问题：
 *   ① **依赖外部工具**：macOS 自带的是 LibreSSL（参数与 OpenSSL 有差异）、
 *      Linux 各发行版不一定装了命令行 openssl、Windows 默认根本没有。
 *   ② **无法验证**：在 Windows 上写的 macOS 代码只能"读着像对的" ——
 *      而这个项目的规矩是"没实测就不算做完"。
 *   ③ **两套实现会漂移**：一处改了 CA 标志、另一处没改，表现是"某个平台
 *      浏览器就是不认"，而且很难查。
 *
 * 统一成纯 JS 之后：**同一份代码在所有平台生成同样的结构**，
 * 而且生成结果可以立刻用 `crypto.X509Certificate` 解析回来逐项核对
 * （见 test/x509.test.js），不依赖任何平台的工具链。
 *
 * ── 曲线选择 ─────────────────────────────────────────────────
 *
 * 用 **P-256 (prime256v1)** 而不是 RSA-2048：
 *   · 生成快 —— RSA-2048 要几百毫秒且是阻塞的，P-256 只要几毫秒
 *   · 签名小 —— 证书体积约为 RSA 的三分之一，握手也更快
 *   · 浏览器与 Node 全部支持（TLS 1.2/1.3 的 ECDSA 套件）
 * 这是"一次性会话证书"，没有兼容老客户端的包袱。
 */
import { generateKeyPairSync, sign, createHash, randomBytes, X509Certificate } from 'node:crypto'
import * as D from './x509.js'
import { keyUsageOf, OID_SERVER_AUTH } from './x509.js'

/** CA 的主题标记。残留清理靠它辨认"这是我们装的" */
export const CA_CN = 'Flicker Session CA'

/** 证书有效期。会话级证书，7 天足够，短一点更安全 */
const VALID_DAYS = 7

/** 曲线与它的 OID（prime256v1 = P-256） */
const CURVE = 'prime256v1'
const CURVE_OID = '1.2.840.10045.3.1.7'

/** 密钥用途扩展的 OID 组合 */
const SERVER_AUTH = D.EXT.extKeyUsageServerAuth

/**
 * 生成一对 EC 密钥。
 *
 * 同时保留 **KeyObject** 与它的 **DER**：签名要用 KeyObject，
 * 而 SPKI DER 是证书里的 SubjectPublicKeyInfo，也要用。
 * （只拿 DER 是没法签名的 —— `sign()` 要 KeyObject 或 PEM。）
 */
function newKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: CURVE })
  return {
    publicKey,
    privateKey,
    spki: publicKey.export({ type: 'spki', format: 'der' }),
    pkcs8: privateKey.export({ type: 'pkcs8', format: 'der' }),
  }
}

/** 生成一个正随机序列号（最高位强制为 0，避免被当成负数） */
function newSerial() {
  const b = randomBytes(16)
  b[0] &= 0x7f
  if (b[0] === 0) b[0] = 1
  return b
}

/** SubjectKeyIdentifier 的**裸摘要**（20 字节），由 SPKI 派生（RFC 5280 方法 1） */
function skiDigest(spkiDer) {
  return createHash('sha1').update(spkiDer).digest()
}

/** SKI 扩展的值：`OCTET STRING { 摘要 }` */
const skiExtension = (spkiDer) => D.OCTET_STRING(skiDigest(spkiDer))

/**
 * AKI 扩展的值：`SEQUENCE { [0] IMPLICIT OCTET STRING }`。
 *
 * ⚠️ keyIdentifier 是 **IMPLICIT** 标记 —— tag 后面**直接跟裸的 20 字节摘要**，
 *    不能再套一层 OCTET STRING。第一版把完整的 `OCTET STRING{摘要}` 塞了进去，
 *    于是多出一层 `04 14`，`checkIssued()` 直接判失败。
 *    IMPLICIT 与 EXPLICIT 这一字之差是 X.509 编码里最经典的坑。
 */
const akiExtension = (spkiDer) => D.SEQUENCE(D.implicit(0, skiDigest(spkiDer)))

/**
 * 组装一张证书并签名。
 *
 * TBS（待签名部分）的结构固定：
 *   version(2) ‖ serial ‖ sigAlg ‖ issuer ‖ validity ‖ subject ‖ SPKI ‖ [extensions]
 *
 * ⚠️ 签名是对 **TBS 的 DER 编码**做的，而证书最终的 DER 是
 *    `SEQUENCE { TBS, sigAlg, signature }` —— 也就是说 TBS 会被原样嵌进去，
 *    签名的输入与证书里那一段必须**逐字节相同**。
 *    ECDSA 的 `crypto.sign` 输出本身已经是 DER SEQUENCE，可直接放进 BIT STRING。
 */
function makeCert({ cn, issuerCn, keys, caKeys, isCa, hosts, serial, notBefore, notAfter }) {
  const extensions = []
  // ① 基本约束 —— CA 标志就是"浏览器认不认它是 CA"的分水岭
  extensions.push(D.Extension(D.EXT.basicConstraints, true,
    isCa ? D.basicConstraintsCa() : D.basicConstraintsLeaf()))
  // ② 密钥用途
  extensions.push(D.Extension(D.EXT.keyUsage, true,
    D.keyUsage(isCa ? { keyCertSign: true } : { digitalSignature: true })))
  // ③ 主体密钥标识
  extensions.push(D.Extension(D.EXT.subjectKeyIdentifier, false, skiExtension(keys.spki)))
  // ④ 服务器证书：SAN + 扩展密钥用途 + 指向 CA 的 AKI
  //    SAN 是必需的 —— 现代浏览器不看 CN，只看 SAN
  if (!isCa) {
    if (!hosts || !hosts.length) throw new Error('服务器证书必须有至少一个 SAN')
    extensions.push(D.Extension(D.EXT.subjectAltName, false, D.subjectAltName(hosts)))
    // ⚠️ 只给 serverAuth，**不给 clientAuth**。
    //    这张证书只为"当一次 HTTPS 服务器"而生，多一个 EKU 就是多一项它本不需要的
    //    能力（可以拿去当客户端证书）。一次性证书没有兼容老客户端的包袱，
    //    所以按最小权限给。旧版给的是 serverAuth+clientAuth（PowerShell 时代的默认值）。
    extensions.push(D.Extension(D.EXT.extKeyUsage, false, D.extKeyUsage(SERVER_AUTH)))
    // 指回签发者：CA 的 SKI。没有它某些客户端会把链判为不完整
    extensions.push(D.Extension(D.EXT.authorityKeyIdentifier, false, akiExtension(caKeys.spki)))
  }

  const tbs = D.SEQUENCE(D.cat(
    D.explicit(0, D.INTEGER(2)),                 // version v3（字段值 2）
    D.INTEGER(serial),
    D.algIdEcdsaSha256(),
    D.Name(issuerCn),
    D.SEQUENCE(D.cat(D.UTCTime(notBefore), D.UTCTime(notAfter))),
    D.Name(cn),
    keys.spki,
    D.explicit(3, D.SEQUENCE(D.cat(...extensions))),
  ))

  // 自签时用自己，签发时用 CA —— 都是 KeyObject
  const signature = sign('sha256', tbs, isCa ? keys.privateKey : caKeys.privateKey)
  return D.SEQUENCE(D.cat(tbs, D.algIdEcdsaSha256(), D.BIT_STRING(signature)))
}

/**
 * 生成一次会话用的 CA 与服务器证书。
 *
 * @param {object} opts
 * @param {string[]} opts.hosts 要在 SAN 里列出的地址（IP 或主机名）
 * @param {number} [opts.validDays]
 * @returns {{caPem:string, caDer:Buffer, caKeyPem:string, caFingerprint:string,
 *            srvPem:string, srvDer:Buffer, srvKeyPem:string, srvFingerprint:string,
 *            hosts:string[], notAfter:Date}}
 */
export function generateCerts({ hosts, validDays = VALID_DAYS }) {
  const list = [...new Set((hosts ?? []).filter(Boolean))]
  if (!list.length) throw new Error('没有可用地址用于生成证书')

  const notBefore = new Date(Date.now() - 5 * 60 * 1000)      // 回拨 5 分钟，容忍时钟偏差
  const notAfter = new Date(Date.now() + validDays * 86400_000)

  // ① CA：自签，issuer === subject
  const caKeys = newKeyPair()
  const caDer = makeCert({
    cn: CA_CN, issuerCn: CA_CN,
    keys: caKeys, caKeys,
    isCa: true, serial: newSerial(), notBefore, notAfter,
  })

  // ② 服务器证书：由 CA 签发。CN 用第一个地址（只为可读性，浏览器看 SAN）
  const srvKeys = newKeyPair()
  const srvDer = makeCert({
    cn: list[0], issuerCn: CA_CN,
    keys: srvKeys, caKeys,
    isCa: false, hosts: list, serial: newSerial(), notBefore, notAfter,
  })

  const caPem = D.toPem(caDer)
  const srvPem = D.toPem(srvDer)
  const caKeyPem = D.toPem(caKeys.pkcs8, 'PRIVATE KEY')
  const srvKeyPem = D.toPem(srvKeys.pkcs8, 'PRIVATE KEY')

  return {
    caPem, caDer, caKeyPem,
    caFingerprint: fingerprintOf(caDer),
    caThumbprint: thumbprintOf(caDer),
    srvPem, srvDer, srvKeyPem,
    srvFingerprint: fingerprintOf(srvDer),
    srvThumbprint: thumbprintOf(srvDer),
    hosts: list,
    notBefore, notAfter,
  }
}

/**
 * SHA-256 指纹（十六进制大写）。
 * 用于人看与跨平台比对 —— 所有平台都能算出来。
 */
export function fingerprintOf(der) {
  return createHash('sha256').update(der).digest('hex').toUpperCase()
}

/**
 * SHA-1 指纹（十六进制大写，无分隔符）。
 *
 * ⚠️ 这个**专门给 Windows 的 certutil 用** —— 它按 SHA-1 指纹定位证书。
 *    踩过一次：把 SHA-256 指纹（64 位）传给 `certutil -delstore`，
 *    命令**不报错但也不删**，于是测试报"卸载后应完全还原（50 !== 49）"，
 *    而且症状是"证书残留在信任库里" —— 正好是"用完即销毁"要防的事。
 *
 *    这里用它而不是 `X509Certificate.fingerprint`，是为了不依赖解析：
 *    指纹就是"对 DER 做 SHA-1"，直接算出来最直白。
 */
function thumbprintOf(der) {
  return createHash('sha1').update(der).digest('hex').toUpperCase()
}

/**
 * 自检：把生成结果解析回来，逐项核对它真的符合预期。
 *
 * ⚠️ 这一步不是形式。证书"生成成功"和"浏览器接受"之间隔着好几个
 *    容易写错的地方（CA 标志、SAN、有效期、签名），而**任何一个写错
 *    都只有到浏览器里才会暴露**。用 X509Certificate 解析回来检查，
 *    等于把"浏览器那一步"提前到生成阶段。
 *
 * @param {object} certs generateCerts 的返回值
 * @param {string} [targetHost] 顺便验证主机名匹配
 * @throws {Error} 任一项不符
 */
export function selfCheck(certs, targetHost) {
  const ca = parseCert(certs.caDer ?? certs.caPem, 'CA', 'CA_UNPARSEABLE')
  const srv = parseCert(certs.srvDer ?? certs.srvPem, '服务器证书', 'SRV_UNPARSEABLE')
  const problems = []

  // ── CA ──
  if (!ca.ca) {
    problems.push('CA 缺少 basicConstraints CA=TRUE —— 这不是一个 CA，' +
      '用它签发的整条链都会无效。\n' +
      '    现象：浏览器报 ERR_CERT_INVALID，含义是"证书本身坏了"' +
      '而不是"签发者不认识" —— 这个指向差异会让排查走很久。\n' +
      '    修法：生成时带上 ca=1（见 src/x509.js 的 basicConstraintsCa）')
  }
  if (ca.subject !== ca.issuer) {
    problems.push(`CA 不是自签的（subject=${ca.subject} issuer=${ca.issuer}）—— ` +
      '自签是"能作为信任根"的前提。修法：CA 用自己的私钥签名')
  }
  if (!ca.verify(ca.publicKey)) {
    problems.push('CA 的自签名验证失败 —— 签名与 TBS 内容对不上。\n' +
      '    多半是 DER 编码有误（长度、INTEGER 补码、或签名没覆盖完整的 TBS）')
  }
  const caKu = keyUsageOfCert(ca)
  if (caKu && !caKu.includes('keyCertSign')) {
    problems.push(`CA 的 Key Usage 缺少 keyCertSign（实际: ${caKu.join(', ') || '空'}）—— ` +
      '没有它就不是一个能签发证书的 CA')
  }

  // ── 服务器证书 ──
  if (srv.ca) {
    problems.push('服务器证书不该带 CA 标志 —— 它是叶子证书，' +
      '带上 CA 标志会让某些校验器认为链的结构不对')
  }
  if (srv.issuer !== ca.subject) {
    problems.push(`服务器证书的 issuer（${srv.issuer}）应当等于 CA 的 subject（${ca.subject}）—— ` +
      '签发时写错了签发者名字')
  }
  // ⚠️ 这里**刻意不判"签名链"**：`ca.verify(srv.publicKey)` 与
  //    `ca.checkIssued(srv)` 对"被 CA 签发"的证书都返回 false（实测），
  //    而 `crypto.verify(tbs, sig, caPublicKey)` 返回 true —— 签名一直是对的，
  //    是那两个 API 的语义与"验签名链"不同。判签发关系交给**真实 TLS 握手**
  //    （src/session-cert-check.mjs）：起一个 HTTPS 服务器、拿这个 CA 作信任根去连。

  // ── SAN（现代浏览器一律拒绝没有 SAN 的证书，且不看 CN）──
  const san = srv.subjectAltName ?? ''
  if (!san) {
    problems.push('服务器证书没有 SAN —— 现代浏览器一律拒绝没有 SAN 的证书（它们不看 CN）。\n' +
      '    修法：生成 subjectAltName 扩展，把所有要用的地址列进去')
  }
  // ⚠️ 匹配用 checkHost / checkIP，**不要用 san.includes(host)** ——
  //    字符串包含会把 10.0.0.1 匹配到 10.0.0.10，也会误判 DNS 后缀。
  //    这两个 API 用的正是 OpenSSL/浏览器的匹配逻辑。
  //
  // ⚠️ 而且要查的是**两组地址的并集**，不是"有 hosts 就只看 hosts"：
  //    ① certs.hosts —— 生成时声明要写进 SAN 的地址；
  //    ② targetHost —— 接收端**实际会访问**的那个地址。
  //
  //    曾经写成 `certs.hosts ?? [targetHost]`（有 hosts 就不看 targetHost），
  //    于是最自然的调用方式 `selfCheck(generateCerts(...), '10.0.0.1')`
  //    **完全不检查 10.0.0.1** —— 一张只签了 127.0.0.1 的证书照样"自检通过"，
  //    而接收端打开链接时必然报错。这正是自检要挡的那类故障，测试把它抓出来了。
  const wanted = [...new Set([
    ...(Array.isArray(certs.hosts) ? certs.hosts : []),
    ...(targetHost ? [targetHost] : []),
  ])]
  for (const h of wanted) {
    const ok = /^\d+\.\d+\.\d+\.\d+$/.test(h) ? srv.checkIP(h) : srv.checkHost(h)
    if (!ok) {
      problems.push(`服务器证书的 SAN 不含 ${h}（实际: ${san}）—— ` +
        '接收端访问的地址**必须出现在 SAN 里**，否则必然报错。\n' +
        '    注意：现代浏览器不看 CN，只看 SAN')
    }
  }

  // ── EKU（`.keyUsage` 属性装的是 EKU 的 OID 数组，名字有误导性）──
  const eku = Array.isArray(srv.keyUsage) ? srv.keyUsage : []
  if (eku.length && !eku.includes(OID_SERVER_AUTH)) {
    problems.push(`服务器证书的 EKU 不含 serverAuth（实际: ${eku.join(', ')}）`)
  }
  const srvKu = keyUsageOfCert(srv)
  if (srvKu && !srvKu.includes('digitalSignature') && !srvKu.includes('keyEncipherment')) {
    problems.push(`服务器证书的 Key Usage 既无 digitalSignature 也无 keyEncipherment` +
      `（实际: ${srvKu.join(', ') || '空'}）`)
  }

  // ── 有效期 ──
  const now = Date.now()
  for (const [label, c] of [['CA', ca], ['服务器证书', srv]]) {
    if (new Date(c.validFromDate).getTime() > now) {
      problems.push(`${label}尚未生效（${c.validFrom}）—— ` +
        '多半是两端时钟不同步。修法：生成时把生效时间往前拨几分钟')
    }
    if (new Date(c.validToDate).getTime() < now) {
      problems.push(`${label}已过期（${c.validTo}）`)
    }
  }

  if (problems.length) {
    const e = new Error('证书自检未通过:\n  - ' + problems.join('\n  - '))
    e.code = 'SELF_CHECK_FAILED'
    e.problems = problems
    throw e
  }
  // ⚠️ 返回结构说明（调用方与测试都依赖它）：
  //    `ca.ca` / `srv.ca` 是 Node 解析出来的 CA 标志**布尔值**，
  //    而 `srv.subjectAltName` 是它解析出来的 SAN 文本。
  //    这两个字段名看着别扭（`ca.ca`），但它们从"直接把 X509Certificate
  //    对象交出去"的年代就在用了 —— 那时它们是对象上的原生属性。
  //    现在改成只交出叶子字段，是为了**不把可变的活对象漏出去**：
  //    调用方只能读到快照，读不到 KeyObject。
  return {
    ca: {
      ca: ca.ca,
      subject: ca.subject,
      issuer: ca.issuer,
      validFrom: ca.validFrom,
      validTo: ca.validTo,
      fingerprint: ca.fingerprint256,
      keyUsage: caKu,
    },
    srv: {
      ca: srv.ca,
      subject: srv.subject,
      issuer: srv.issuer,
      subjectAltName: san,
      validFrom: srv.validFrom,
      validTo: srv.validTo,
      fingerprint: srv.fingerprint256,
      keyUsage: srvKu,
    },
    caKeyUsage: caKu,
    srvKeyUsage: srvKu,
  }
}

/**
 * 解析证书；失败时给出**指向明确**的错误，而不是让 X509Certificate 的原话冒上去。
 *
 * @param {Buffer|string} input DER 或 PEM
 * @param {string} label 出错时告诉调用方**是哪一张**证书坏了
 * @param {string} [code] 错误码。CA 与服务器证书给不同的码，
 *   这样"CA 解不出来"和"服务器证书解不出来"在日志里能区分开
 */
function parseCert(input, label, code = 'UNPARSEABLE') {
  if (input == null) {
    throw Object.assign(new Error(`${label} 是空的 —— 生成阶段就没产出它`),
      { code: `${label === 'CA' ? 'CA' : 'SRV'}_MISSING` })
  }
  try {
    return new X509Certificate(input)
  } catch (e) {
    throw Object.assign(new Error(
      `${label}无法解析: ${e.message}\n` +
      `    输入类型：${Buffer.isBuffer(input) ? 'Buffer(DER)' : typeof input}` +
      `，长度 ${input.length ?? '?'} 字节\n` +
      '    多半是 DER 编码有误，或把 PEM 文本当 DER 传了'), { code })
  }
}

/**
 * 读出证书的 KeyUsage 位名。
 *
 * ⚠️ Node 的 `X509Certificate` **没有**暴露 KeyUsage ——
 *    它的 `.keyUsage` 属性装的是 **EKU** 的 OID 数组（名字有误导性），
 *    所以这里自己解 DER。解析不出来时返回 null（"读不出来"不等于"不合法"）。
 *
 * ⚠️ 这里原本有一份手写的字节扫描实现，它把 BIT STRING 的 **unused 字节**
 *    当成了内容字节（`raw[i+4]` 应为 `raw[i+5]`），于是 CA 的 keyUsage 读成
 *    空数组，自检报"CA 的 Key Usage 缺少 keyCertSign（实际: 空）"——
 *    把一张正确的证书判成不合格。现在统一走 src/x509.js 那一份解码器。
 */
function keyUsageOfCert(cert) {
  return keyUsageOf(Buffer.isBuffer(cert?.raw) ? cert.raw : cert)
}
