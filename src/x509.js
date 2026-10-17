/**
 * 最小 DER 编码器（ASN.1 的二进制编码）。
 *
 * ── 为什么自己写，而不是用 openssl 或 PowerShell ──────────────
 *
 * 会话证书必须在三个平台上都能生成：
 *   · Windows 原来用 `New-SelfSignedCertificate`（PowerShell）
 *   · macOS / Linux 本来打算用 `openssl` 命令行
 *
 * 两个问题：
 *   ① 依赖外部工具。macOS 自带 LibreSSL（不是 OpenSSL，参数有差异），
 *      Linux 各家发行版不一定装了命令行 openssl，Windows 默认根本没有。
 *   ② **没法验证**。在 Windows 上写的 macOS 代码只能靠"读着像对的" ——
 *      而这个项目的一贯做法是"没实测就不算做完"。
 *
 * 自己编码 X.509 之后这两个问题同时消失：**纯 JS、零外部依赖、
 * 同一份代码在所有平台上生成同样的结构**，而且可以在任何平台上
 * 用 `crypto.X509Certificate` 把生成结果解析回来逐项核对。
 *
 * ── 为什么这是可控的复杂度 ───────────────────────────────────
 *
 * X.509 看着吓人，但"自签 CA + 一张服务器证书"只用到很少一部分：
 * 定长字段 + 一小段 DER 编码 + 一次签名。**不涉及解析**（那才是复杂的部分），
 * 只涉及构造。所以它是几百行直白的代码，而不是一个协议栈。
 *
 * 编码规则只用到 DER（不是 BER，也不是 CER）：
 *   · 长度用**最短形式**（< 128 用单字节，否则 0x80|n + n 字节大端）
 *   · INTEGER 用**最短补码**，且正数最高位为 1 时要补一个 0x00
 *   · 所有 SEQUENCE / SET 都是定长（先算内容再写长度）
 */
import { createHash } from 'node:crypto'

// ── 基本类型 ──────────────────────────────────────────────────

/** 把一个 tag 与内容拼成 TLV */
function tlv(tag, content) {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content])
}

/** DER 长度：最短形式 */
function derLength(n) {
  if (n < 0x80) return Buffer.from([n])
  const bytes = []
  let v = n
  while (v > 0) { bytes.unshift(v & 0xff); v = Math.floor(v / 256) }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

/** 拼接多个已编码元素（用于 SEQUENCE 的内容） */
export const cat = (...parts) => Buffer.concat(parts)

// ── 通用类型 ──────────────────────────────────────────────────

export const SEQUENCE = (content) => tlv(0x30, content)
const SET = (content) => tlv(0x31, content)

/**
 * INTEGER。接受 Number / BigInt / Buffer。
 * ⚠️ 最短补码：正数最高位为 1 时必须补一个 0x00，
 *    否则会被解释成负数（序列号最容易踩这个）。
 */
export function INTEGER(value) {
  let bytes
  if (Buffer.isBuffer(value)) bytes = value
  else {
    let v = BigInt(value)
    if (v < 0n) throw new Error('INTEGER 只支持非负值')
    if (v === 0n) bytes = Buffer.from([0])
    else {
      const out = []
      while (v > 0n) { out.unshift(Number(v & 0xffn)); v >>= 8n }
      bytes = Buffer.from(out)
    }
  }
  // 最高位为 1 → 补 0x00，保持"非负"的语义
  if (bytes.length && (bytes[0] & 0x80)) bytes = Buffer.concat([Buffer.from([0]), bytes])
  return tlv(0x02, bytes)
}

/** BIT STRING。第一个字节是"未使用位数"，证书里几乎总是 0 */
export function BIT_STRING(content, unusedBits = 0) {
  return tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), content]))
}

export const OCTET_STRING = (content) => tlv(0x04, content)
const NULL = () => tlv(0x05, Buffer.alloc(0))

/** OID。输入点分数字串，例如 '2.5.29.19' */
export function OID(dotted) {
  const parts = dotted.split('.').map((s) => {
    const n = Number(s)
    if (!Number.isInteger(n) || n < 0) throw new Error(`OID 段非法: ${s}`)
    return n
  })
  if (parts.length < 2) throw new Error(`OID 至少两段: ${dotted}`)
  // 前两段合并成 40*a + b
  const first = 40 * parts[0] + parts[1]
  const body = [first]
  for (const n of parts.slice(2)) {
    // base-128，最高位为续位标志
    const chunk = []
    let v = n
    do { chunk.unshift(v & 0x7f); v = Math.floor(v / 128) } while (v > 0)
    for (let i = 0; i < chunk.length - 1; i++) chunk[i] |= 0x80
    body.push(...chunk)
  }
  return tlv(0x06, Buffer.from(body))
}

/** UTCTime（YYMMDDHHMMSSZ）。证书有效期到 2049 年之前都用它 */
export function UTCTime(date) {
  const p = (n) => String(n).padStart(2, '0')
  const s = p(date.getUTCFullYear() % 100) + p(date.getUTCMonth() + 1) + p(date.getUTCDate()) +
    p(date.getUTCHours()) + p(date.getUTCMinutes()) + p(date.getUTCSeconds()) + 'Z'
  return tlv(0x17, Buffer.from(s, 'ascii'))
}

/** 带 context 标签的显式包装（`[n] EXPLICIT`） */
export const explicit = (n, content) => tlv(0xa0 | n, content)

/** 带 context 标签的隐式原始值（`[n]` 直接替换掉原 tag） */
export const implicit = (n, content) => tlv(0x80 | n, content)

// ── 证书里用到的复合类型 ──────────────────────────────────────

const OID_EC_PUBLIC_KEY = '1.2.840.10045.2.1'
const OID_ECDSA_SHA256 = '1.2.840.10045.4.3.2'
const OID_CN = '2.5.4.3'

/** 可打印字符串（证书里的 CN 用它，纯 ASCII 时最省事） */
const PrintableString = (s) => tlv(0x13, Buffer.from(s, 'ascii'))

/** UTF8String（CN 含非 ASCII 时用它 —— 例如中文主机名） */
const UTF8String = (s) => tlv(0x0c, Buffer.from(s, 'utf8'))

/**
 * Name（RDNSequence）。这里只支持单段 CN —— 会话证书不需要更多。
 * 含非 ASCII 时自动改用 UTF8String（X.509 允许，且比 PrintableString 正确）。
 */
export function Name(cn) {
  const ascii = /^[\x20-\x7e]*$/.test(cn)
  return SEQUENCE(SET(SEQUENCE(cat(OID(OID_CN), ascii ? PrintableString(cn) : UTF8String(cn)))))
}

export const algIdEcdsaSha256 = () => SEQUENCE(cat(OID(OID_ECDSA_SHA256)))

/** Extension：`SEQUENCE { extnID, critical BOOLEAN DEFAULT FALSE, extnValue OCTET STRING }` */
export function Extension(oid, critical, value) {
  return SEQUENCE(cat(
    OID(oid),
    ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []),
    OCTET_STRING(value),
  ))
}

export const EXT = {
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  subjectAltName: '2.5.29.17',
  subjectKeyIdentifier: '2.5.29.14',
  authorityKeyIdentifier: '2.5.29.35',
  authorityInfoAccess: '1.3.6.1.5.5.7.1.1',
  extKeyUsageServerAuth: '1.3.6.1.5.5.7.3.1',
  extKeyUsageClientAuth: '1.3.6.1.5.5.7.3.2',
}

/**
 * BasicConstraints。
 * ⚠️ `ca=true` 这一个 bit 就是"浏览器认不认这是 CA"的分水岭 ——
 *    Windows 那边实测踩过：漏了它，装进信任库浏览器仍然拒绝。
 *    对应 PowerShell 的 `2.5.29.19={critical}{text}ca=1`。
 */
export const basicConstraintsCa = () =>
  SEQUENCE(cat(tlv(0x01, Buffer.from([0xff])), INTEGER(0)))
export const basicConstraintsLeaf = () => SEQUENCE(Buffer.alloc(0))

/**
 * KeyUsage（BIT STRING）。
 *
 * ⚠️ 这里错过三次，值得完整说清 —— X.509 的 BIT STRING 有两个容易混淆的"位"：
 *
 *   ① **位下标**：bit 0 = 0x80，bit 1 = 0x40，… bit 7 = 0x01。
 *      这是规范里写 keyUsage 用的编号（digitalSignature=0、keyCertSign=5）。
 *   ② **unused 字段**：BIT STRING 编码里的第一个字节，表示
 *      "**最后一个内容字节**里有几位没用到"。它等于内容字节的**前导零位数**
 *      （对单字节来说就是 `Math.clz32(byte) - 24`）。
 *
 *    三次错误：
 *      第 1 次 `7 − 最高置位下标` → {keyCertSign} 得 2（应为 1）
 *      第 2 次 忘了减            → {keyCertSign} 得 5（应为 1）
 *      第 3 次 用 `7 − 最低置位下标` → 还是 2（应为 1），因为"低位侧的空位"
 *              不是 unused —— 规范里的序是**从高位往低位**编的，
 *              第一个未使用的位后面必须全是 0，所以只有**前导**零才算 unused。
 *
 *    症状也值得记：unused 错一位，`X509Certificate` 就**解析不出 keyUsage**
 *    （属性直接是 undefined），而证书里其他字段全都正常 ——
 *    从表面完全看不出是这里错。正确值：{digitalSignature} → `03 02 07 80`；
 *    {keyCertSign,cRLSign} → `03 02 01 06`。
 */
export function keyUsage({ keyCertSign = false, cRLSign = false, digitalSignature = false } = {}) {
  const bits = new Set()
  if (digitalSignature) bits.add(0)
  if (keyCertSign) bits.add(5)
  if (cRLSign) bits.add(6)
  // ⚠️ CA 证书按惯例 keyCertSign 与 cRLSign 同时置位 —— 只给前者时，
  //    有些校验器会认为这不是一个完整的 CA（旧 PowerShell 版给的就是两个位）。
  if (keyCertSign && !cRLSign) bits.add(6)
  if (!bits.size) return tlv(0x03, Buffer.from([0x00, 0x00]))   // 空 BIT STRING

  let byte = 0
  for (const b of bits) byte |= 0x80 >> b

  // unused：用**已知正确值**反推定义，别再靠记规范。
  //   {digitalSignature}（bit0 → 0x80）期望 `03 02 07 80` → unused = 7
  //   {keyCertSign,cRLSign}（bit5,6 → 0x06）期望 `03 02 01 06` → unused = 1
  //   两者都等于该字节的**尾随零位数**（0x80→7 个，0x06→1 个）。
  //
  //   直观解释：keyUsage 的位是**从最高位往低位**编的，最后一个置位的
  //   bit 之后剩下的位（即低位的零）就是"未使用"的；而 DER 要求它们为 0。
  let unused = 0
  if (byte !== 0) { let v = byte; while ((v & 1) === 0) { unused++; v >>= 1 } }
  return tlv(0x03, Buffer.from([unused, byte]))
}

/** ExtKeyUsage：serverAuth (+ clientAuth) */
export const extKeyUsage = (...oids) => SEQUENCE(cat(...oids.map(OID)))

/**
 * SubjectAltName。
 * SAN 是**必需**的：现代浏览器不再看 CN，只看 SAN。
 * 这也是自签证书最容易漏的一项。
 */
export function subjectAltName(hosts) {
  const parts = hosts.map((h) => {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
      // iPAddress：四个字节的原始值，不是字符串
      const b = h.split('.').map(Number)
      if (b.some((n) => n < 0 || n > 255)) throw new Error(`IPv4 地址非法: ${h}`)
      return implicit(7, Buffer.from(b))
    }
    if (/^[0-9a-f:]+$/i.test(h) && h.includes(':')) {
      // IPv6：16 字节原始值
      const groups = expandIPv6(h)
      return implicit(7, groups)
    }
    // dNSName
    return implicit(2, Buffer.from(h, 'ascii'))
  })
  return SEQUENCE(cat(...parts))
}

/** 把 IPv6 文本展开成 16 字节（支持 `::` 缩写） */
function expandIPv6(text) {
  const [head, tail] = text.split('::')
  const h = head ? head.split(':').filter(Boolean) : []
  const t = tail !== undefined && tail ? tail.split(':').filter(Boolean) : []
  const missing = 8 - h.length - t.length
  if (missing < 0) throw new Error(`IPv6 地址非法: ${text}`)
  const groups = [...h, ...Array(tail !== undefined ? missing : 0).fill('0'), ...t]
  if (groups.length !== 8) throw new Error(`IPv6 地址非法: ${text}`)
  const out = Buffer.alloc(16)
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g || '0', 16), i * 2))
  return out
}

/**
 * SubjectKeyIdentifier（RFC 5280 方法 1：公钥 BIT STRING 内容的 SHA-1 前 20 字节）。
 * 只在 CA 上生成 —— 叶子证书用它来指回签发者。
 */
export function subjectKeyIdentifier(spkiDer) {
  const digest = createHash('sha1').update(spkiDer).digest()
  return OCTET_STRING(digest)
}

/** AuthorityKeyIdentifier：指向签发者的 SKI。叶子证书用它。 */
export function authorityKeyIdentifier(skiOctetStringValue) {
  // keyIdentifier [0] IMPLICIT OCTET STRING
  return SEQUENCE(implicit(0, skiOctetStringValue))
}

/** 把 DER 转成 PEM */
export function toPem(der, label = 'CERTIFICATE') {
  const b64 = der.toString('base64').match(/.{1,64}/g).join('\n')
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`
}

/**
 * EKU 的 OID：serverAuth（1.3.6.1.5.5.7.3.1）。
 *
 * ⚠️ 这个常量**只在这里定义一次**。从前 `session-cert.js` 与 `trust.js` 各写了一份，
 *    一直没出问题，只是因为它们从来没同时进过同一个产物 —— 直到单文件打包
 *    把两边收进同一个作用域，拼接后立刻发现重名（打包器会直接拒绝构建）。
 *    证书常量属于这一层（DER / OID 工具），所以放这里，两边都 import。
 */
export const OID_SERVER_AUTH = '1.3.6.1.5.5.7.3.1'

// ── 解码方向：只做"读回 Key Usage"这一件事 ───────────────────
//
// 为什么需要一个解码器：
//
//   Node 的 `X509Certificate.keyUsage` 属性装的是 **Extended Key Usage 的
//   OID 数组**（例如 ["1.3.6.1.5.5.7.3.1"] = serverAuth），而 **Key Usage
//   扩展（2.5.29.15）根本没有对应的属性**（证书没有 EKU 时该属性直接是
//   undefined）。`extKeyUsage` 属性恒为 undefined。
//
//   所以想检查 keyCertSign（CA 的关键标志）只能自己解析 DER。
//   这个坑是测试抓出来的：最初的自检拿 /Certificate Sign/ 去匹配 keyUsage，
//   而它实际是 OID 字符串，永远匹配不上。
//
// ⚠️ 这份解码器**只此一份**。曾经 trust.js 与 session-cert.js 各写了一个版本，
//    其中一个把 BIT STRING 的"unused 位数字节"当成了内容字节，于是
//    CA 的 keyUsage 被读成空数组 —— 而自检正好靠它判断 keyCertSign，
//    结论就是"CA 缺少 keyCertSign"，把一张完全正确的证书判成不合格。
//    重复实现 = 两处都可能错，且错的姿势不同。

const OID_KEY_USAGE = Buffer.from([0x55, 0x1d, 0x0f])      // 2.5.29.15

const KU_BITS = ['digitalSignature', 'nonRepudiation', 'keyEncipherment',
  'dataEncipherment', 'keyAgreement', 'keyCertSign', 'cRLSign',
  'encipherOnly', 'decipherOnly']

/**
 * 极简 DER 递归下降：把 [start,end) 里的同级 TLV 逐个切出来。
 *
 * ⚠️ 这里踩过一次坑，记下来免得重犯：
 *   最初写的是"边扫边跳"（扫到 TLV 就 i = j + len 往下跳），
 *   在遇到最外层 SEQUENCE 之前就**失去了 TLV 边界** ——
 *   跳到一个位置后把普通字节当成长度读，得到 1607252168 这种垃圾长度，
 *   于是整个扩展容器都没被遍历到，Key Usage 自然找不到。
 *   正确做法是严格按容器递归：每个 SEQUENCE/SET 单独用 (start,end) 界定。
 */
function derChildren(buf, start, end) {
  const out = []
  let i = start
  while (i < end) {
    const tag = buf[i]
    let j = i + 1
    if (j >= end) break
    let len = buf[j++]
    if (len & 0x80) {
      const n = len & 0x7f
      if (n === 0 || n > 4 || j + n > end) break
      len = 0
      for (let k = 0; k < n; k++) len = (len << 8) | buf[j++]
    }
    if (len < 0 || j + len > end) break
    out.push({ tag, constructed: (tag & 0x20) !== 0, start: j, end: j + len, at: i })
    i = j + len
  }
  return out
}

/**
 * 解 OCTET STRING 里那层 BIT STRING，返回被置位的 Key Usage 名称。
 *
 * ⚠️ 字节序（这是上面提到的那个 bug 的根源）：
 *    `03 <len> <unused> <内容…>` —— 第 3 个字节是 **unused**（末字节里有几位
 *    没用到），内容从第 4 个字节开始。把 unused 当成内容，读出来永远是错的。
 */
function parseKeyUsageBits(inner) {
  if (!inner || inner.length < 3 || inner[0] !== 0x03) return null
  const unused = inner[2]
  const content = inner.subarray(3)
  const names = []
  for (let b = 0; b < KU_BITS.length; b++) {
    const byteIdx = b >> 3
    if (byteIdx >= content.length) break
    const set = (content[byteIdx] >> (7 - (b & 7))) & 1
    const isUnused = byteIdx === content.length - 1 && (b & 7) >= (8 - unused)
    if (set && !isUnused) names.push(KU_BITS[b])
  }
  return names
}

/** 在任意容器里找 2.5.29.15 的 OID，找到后回到它的父容器继续往后找 OCTET STRING */
function findKeyUsage(der) {
  const oid = OID_KEY_USAGE
  let result = null

  const searchOid = (children, depth) => {
    for (let idx = 0; idx < children.length && !result; idx++) {
      const c = children[idx]
      if (c.tag === 0x06 && c.end - c.start === oid.length && der.subarray(c.start, c.end).equals(oid)) {
        // 沿着同级往后找 OID 之后的第一个 OCTET STRING（跳过 critical 的 BOOLEAN）
        for (let k = idx + 1; k < children.length; k++) {
          const sib = children[k]
          if (sib.tag === 0x04) {
            const bits = parseKeyUsageBits(der.subarray(sib.start, sib.end))
            if (bits) { result = bits; return }
            break
          }
          if (sib.tag !== 0x01) break      // 只允许中间夹一个 BOOLEAN(critical)
        }
        return
      }
      if (c.constructed && depth < 12) searchOid(derChildren(der, c.start, c.end), depth + 1)
    }
  }

  try {
    searchOid(derChildren(der, 0, der.length), 0)
  } catch { return null }
  return result
}

/**
 * 从 DER 或 PEM 里解析 Key Usage（2.5.29.15）。
 *
 * ⚠️ 只接受字节，不接受 `X509Certificate` 对象 —— 想传对象请用 `.raw`。
 *    调用方通常已经持有 DER，这里就不再从对象上取。
 *
 * @param {Buffer|string} input DER Buffer 或 PEM 字符串
 * @returns {string[]|null} 名称数组；找不到或解析失败返回 null
 */
export function keyUsageOf(input) {
  try {
    let der
    if (Buffer.isBuffer(input)) {
      der = input
    } else if (typeof input === 'string') {
      const b64 = input.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
      if (!b64) return null
      der = Buffer.from(b64, 'base64')
    } else return null
    if (!der.length) return null
    return findKeyUsage(der)
  } catch { return null }
}
