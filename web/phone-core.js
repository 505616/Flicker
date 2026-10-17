/**
 * 手机上传页的协议内核（纯浏览器 JS）
 * ====================================
 *
 * 这里放的是"手机当发送端"要用的**全部密码学与协议拼接**：
 * PBKDF2 → HKDF → HMAC 握手 → AES-256-GCM 封清单与封块 → 增量 SHA-256。
 *
 * ── 为什么单独一个文件、还要在构建期内联 ────────────────────────
 *
 * 页面必须**自包含**（CSP 不许外部脚本；这一页还会被中继/单文件产物托管），
 * 所以它由 `gen/inline-phone.mjs` 原样内联进 `web/phone.html`。
 * 这个文件因此必须是"浏览器能直接吃"的普通脚本：不许 import/require，
 * 不许用 Buffer/process —— 生成器会把这几条当判据检查。
 *
 * ── 与 Node 那一份的关系（重要，别当成第三份实现就完事）──────────
 *
 * 密码学在项目里有**两份**实现：Node 侧（`src/suite/flicker1.js`）与接收端页面内联的那份。
 * 加上这一份就是第三份 —— 这是本项目反复吃过亏的地方（两份实现漂移，表现是"永远连不上"
 * 或"密码不一致"，而且测试全绿）。所以：
 *
 *   · 这一份**只服务发送方向**（接收端那份只做解密），两边能重合的地方刻意保持同名同形；
 *   · `test/phone-page.test.js` 把它与 `src/suite/flicker1.js` **逐字节**比对：
 *     验证值、三把钥匙、两种握手 MAC、清单密文、分块密文、AAD、IV、SHA-256 ——
 *     只要漂移一个字节，测试立刻失败；
 *   · 不把接收端页面里那份抽出来共用，是因为那一页已经真机验证过，
 *     设计草稿里明确写着"不改现有的接收端页面"（见 `_lab/设计草稿-手机发送端.md` §七）。
 *     将来若要合并成一份，先看这条测试覆盖了什么，别只做机械抽取。
 *
 * ⚠️ AES-GCM 的 `subtle.encrypt` 返回的是 **密文 ‖ 16 字节 tag**，
 *    而本项目的线上格式是"tag 在前、密文在后"（见 PROTOCOL.md §5.2）。
 *    这个拆分点极易写错，测试里专门钉了它。
 */
;(function () {
  'use strict'

  const SUITE_ID = 'FLICKER/1'

  /** 套件参数 —— 必须与 src/suite/flicker1.js 的 PARAMS 完全一致 */
  const PARAMS = {
    kdf: 'PBKDF2-SHA256',
    iterations: 600000,
    saltBytes: 16,
    hash: 'sha256',
    aead: 'AES-256-GCM',
    keyBytes: 32,
    ivBytes: 12,
    tagBytes: 16,
    chunkBytes: 1 << 20,
    nonceBytes: 32,
  }

  /** HKDF 的三个标签 */
  const LABELS = {
    room: 'flicker/1/room',
    auth: 'flicker/1/auth',
    enc: 'flicker/1/enc',
  }

  /** 握手 MAC 的两种构造：v2 绑套件 id，v1 是 0.1.0 发布时的字节 */
  const MAC_PROFILES = ['v2', 'v1']

  const enc = new TextEncoder()

  /** 清单 AAD —— 与块 AAD（28 字节）长度不同是刻意的，禁止补零对齐 */
  const MANIFEST_AAD = enc.encode('flicker/1/manifest')

  // ── 小工具 ─────────────────────────────────────────────────

  function concat(...parts) {
    let n = 0
    for (const p of parts) n += p.length
    const out = new Uint8Array(n)
    let off = 0
    for (const p of parts) { out.set(p, off); off += p.length }
    return out
  }

  function equalBytes(a, b) {
    if (!a || !b || a.length !== b.length) return false
    let diff = 0
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
    return diff === 0
  }

  function b64(u8) {
    let s = ''
    const bytes = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8)
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
    return btoa(s)
  }

  function unb64(text) {
    const bin = atob(String(text))
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }

  function hex(u8) {
    let s = ''
    for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0')
    return s
  }

  // ── 密钥派生 ───────────────────────────────────────────────

  /**
   * 由密码算验证值 V（PBKDF2-SHA-256，60 万轮）。
   * V 本身是"密码的等价物"，绝不上网线 —— 它只用来派生钥匙。
   */
  async function pbkdf2Verifier(password, salt, iterations = PARAMS.iterations) {
    if (!(salt instanceof Uint8Array) || salt.length !== PARAMS.saltBytes) {
      throw new Error('盐必须是 ' + PARAMS.saltBytes + ' 字节')
    }
    const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, 256)
    return new Uint8Array(bits)
  }

  /** 从 V 派生三把用途隔离的钥匙（HKDF-SHA-256，空盐，按标签分离） */
  async function hkdfKeys(verifier) {
    const vKey = await crypto.subtle.importKey('raw', verifier, 'HKDF', false, ['deriveBits'])
    const one = async (label) => new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(label) },
      vKey, 256))
    const [room, auth, encKey] = await Promise.all([one(LABELS.room), one(LABELS.auth), one(LABELS.enc)])
    return { room, auth, enc: encKey }
  }

  /** 导入成 HMAC 签名用的钥匙 */
  async function importAuth(raw) {
    return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  }

  /** 导入成 AES-GCM 用的钥匙（`usage` 是 'encrypt' 或 'decrypt'） */
  async function importEnc(raw, usage = 'encrypt') {
    return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [usage])
  }

  // ── 握手 ───────────────────────────────────────────────────

  /**
   * MAC 的输入 = 域分隔前缀 ‖ 挑战。
   * 前缀里的 `send` / `recv` 是**方向绑定** —— 没有它，一个方向的 MAC
   * 可以被原样重放到另一个方向（PROTOCOL.md §4.5）。
   */
  function macInput(role, challenge, profile = 'v2', suite = SUITE_ID) {
    const prefix = profile === 'v1' ? ('flicker/1/' + role + '\n') : (suite + '\n' + role + '\n')
    return concat(enc.encode(prefix), challenge)
  }

  /** 手机（发送端）证明自己知道密码 */
  async function senderMac(authKey, challenge, o = {}) {
    const sig = await crypto.subtle.sign('HMAC', authKey, macInput('send', challenge, o.profile, o.suite))
    return new Uint8Array(sig)
  }

  /** 核对电脑（接收端）的应答 —— 手机也要验它，否则可能是钓鱼页面 */
  async function receiverMac(authKey, challenge, o = {}) {
    const sig = await crypto.subtle.sign('HMAC', authKey, macInput('recv', challenge, o.profile, o.suite))
    return new Uint8Array(sig)
  }

  /** 从电脑的报价里挑一个双方都认识的构造（没报价 = 老版本 → v1） */
  function pickMacProfile(offered) {
    if (!Array.isArray(offered)) return 'v1'
    for (const p of MAC_PROFILES) if (offered.includes(p)) return p
    return 'v1'
  }

  // ── AAD 与 IV ──────────────────────────────────────────────

  /**
   * 块 AAD = fileIndex(8) ‖ chunkIndex(8) ‖ totalChunks(8) ‖ plainLen(4) = 28 字节。
   * 必须按 64 位写（DataView），不能用 JS 位运算 —— 那会在 32 位处静默截断。
   */
  function chunkAAD(fileIndex, chunkIndex, totalChunks, plainLen) {
    const b = new Uint8Array(28)
    const dv = new DataView(b.buffer)
    dv.setBigUint64(0, BigInt(fileIndex))
    dv.setBigUint64(8, BigInt(chunkIndex))
    dv.setBigUint64(16, BigInt(totalChunks))
    dv.setUint32(24, plainLen >>> 0)
    return b
  }

  /** 每块 IV = 12 字节，前 4 字节为 0，后 8 字节为块号 */
  function chunkIV(chunkIndex) {
    const iv = new Uint8Array(PARAMS.ivBytes)
    new DataView(iv.buffer).setBigUint64(4, BigInt(chunkIndex))
    return iv
  }

  // ── 加解密 ─────────────────────────────────────────────────

  /**
   * 封一块。
   * @returns {Promise<{ct:Uint8Array, tag:Uint8Array}>} 与 Node 侧 sealChunk 的输出一致
   */
  async function sealChunk(encKey, fileIndex, chunkIndex, totalChunks, plain) {
    const iv = chunkIV(chunkIndex)
    const aad = chunkAAD(fileIndex, chunkIndex, totalChunks, plain.length)
    const out = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, encKey, plain))
    // subtle 给的是 ct‖tag，本项目的格式是 tag‖ct
    return { ct: out.subarray(0, out.length - PARAMS.tagBytes), tag: out.subarray(out.length - PARAMS.tagBytes) }
  }

  /** 封清单（IV 随机，随清单一起传，不保密） */
  async function sealManifest(encKey, plain) {
    const iv = crypto.getRandomValues(new Uint8Array(PARAMS.ivBytes))
    const out = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: MANIFEST_AAD, tagLength: 128 }, encKey, plain))
    return { iv, ct: out.subarray(0, out.length - PARAMS.tagBytes), tag: out.subarray(out.length - PARAMS.tagBytes) }
  }

  /** 打开清单（这一页只在自己回读时用得上，但留着它能少一次"两边不一致"的排查） */
  async function openManifest(encKey, iv, ct, tag) {
    const body = concat(ct, tag)
    const out = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: MANIFEST_AAD, tagLength: 128 }, encKey, body)
    return new Uint8Array(out)
  }

  // ── 增量 SHA-256 ───────────────────────────────────────────
  //
  // 为什么不用 crypto.subtle.digest：它**没有流式接口**，要一次性拿到全部字节 ——
  // 那就等于把整个 4 GB 视频留在内存里。整文件摘要（清单里的 sha256）必须边读边算。
  // 算法出自 FIPS 180-4，与接收端页面里那份**逐字相同**（两份都有与 Node crypto 对比的测试）。
  const K256 = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2])

  class Sha256 {
    constructor() {
      this.H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
      this.buf = new Uint8Array(64)
      // ⚠️ 消息扩展的临时数组必须复用：这一处就是 2.26× 的差距（见接收端页面里的实测）
      this.w = new Uint32Array(64)
      this.bufLen = 0
      this.total = 0
    }
    update(u8) {
      this.total += u8.length
      let off = 0
      if (this.bufLen > 0) {
        const need = 64 - this.bufLen
        const take = Math.min(need, u8.length)
        this.buf.set(u8.subarray(0, take), this.bufLen)
        this.bufLen += take; off = take
        if (this.bufLen === 64) { this._block(this.buf, 0); this.bufLen = 0 }
      }
      while (off + 64 <= u8.length) { this._block(u8, off); off += 64 }
      if (off < u8.length) {
        this.buf.set(u8.subarray(off), 0)
        this.bufLen = u8.length - off
      }
    }
    _block(d, off) {
      const w = this.w
      const H = this.H
      const K = K256
      for (let i = 0; i < 16; i++) {
        const j = off + i * 4
        w[i] = (d[j] << 24) | (d[j + 1] << 16) | (d[j + 2] << 8) | d[j + 3]
      }
      for (let i = 16; i < 64; i++) {
        const x = w[i - 15], y = w[i - 2]
        const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)
        const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10)
        w[i] = w[i - 16] + s0 + w[i - 7] + s1
      }
      let a = H[0], b = H[1], c = H[2], dd = H[3]
      let e = H[4], f = H[5], g = H[6], h = H[7]
      for (let i = 0; i < 64; i++) {
        const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
        const ch = (e & f) ^ (~e & g)
        const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0
        const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
        const maj = (a & b) ^ (a & c) ^ (b & c)
        const t2 = (S0 + maj) >>> 0
        h = g; g = f; f = e; e = (dd + t1) >>> 0
        dd = c; c = b; b = a; a = (t1 + t2) >>> 0
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0
      H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + dd) >>> 0
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0
      H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0
    }
    digest() {
      const bits = this.total * 8
      const pad = new Uint8Array(this.bufLen < 56 ? 64 : 128)
      pad.set(this.buf.subarray(0, this.bufLen))
      pad[this.bufLen] = 0x80
      const dv = new DataView(pad.buffer)
      dv.setUint32(pad.length - 8, Math.floor(bits / 0x100000000))
      dv.setUint32(pad.length - 4, bits >>> 0)
      const saveH = this.H.slice(), saveLen = this.bufLen
      for (let o = 0; o < pad.length; o += 64) this._block(pad, o)
      let out = ''
      for (let i = 0; i < 8; i++) out += (this.H[i] >>> 0).toString(16).padStart(8, '0')
      this.H = saveH; this.bufLen = saveLen
      return out
    }
  }

  /** 一次性的 SHA-256（走原生 WebCrypto，只用于小块） */
  async function sha256Hex(u8) {
    const d = await crypto.subtle.digest('SHA-256', u8)
    return hex(new Uint8Array(d))
  }

  globalThis.FlickerPhone = {
    SUITE_ID, PARAMS, LABELS, MAC_PROFILES, MANIFEST_AAD,
    concat, equalBytes, b64, unb64, hex,
    pbkdf2Verifier, hkdfKeys, importAuth, importEnc,
    macInput, senderMac, receiverMac, pickMacProfile,
    chunkAAD, chunkIV, sealChunk, sealManifest, openManifest,
    Sha256, sha256Hex,
  }
})()
