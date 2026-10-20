/**
 * ⚠️ 构建产物，请勿手工编辑。
 * 由 gen/gen-relay-sender.mjs 从 web/sender.html 生成。
 *
 * 源文件 SHA-256（前 16 位）: 8f4fe3333f6b8a75
 * 页面大小: 48.1 KB
 *
 * 改页面请改 web/sender.html（以及它内联的 web/sender-core.js），
 * 然后依次运行：node gen/inline-sender.mjs && node gen/gen-relay-sender.mjs
 */
export const SENDER_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>闪传 Flicker · 发送（网页版）</title>
<!-- 这一页由中继托管（或将来自带），必须自包含：脚本全部内联，不请求任何外部资源。 -->
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src *; img-src data:; base-uri 'none'; form-action 'none'">
<style>
  :root { color-scheme: dark; --bg:#12141c; --card:#1b1e29; --text:#e8eaf2; --dim:#9aa0b4;
          --accent:#5b6cff; --ok:#3ddc97; --warn:#ffb454; --err:#ff6b6b; }
  * { box-sizing: border-box; }
  body { margin:0; padding:20px 16px 40px; background:var(--bg); color:var(--text);
         font:15px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif; }
  .wrap { max-width: 640px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: var(--dim); margin: 0 0 20px; font-size: 14px; }
  .card { background: var(--card); border-radius: 12px; padding: 16px; margin-bottom: 14px; }
  label { display:block; font-size: 13px; color: var(--dim); margin-bottom: 6px; }
  input[type=text], input[type=password] {
    width:100%; padding:10px 12px; border-radius:8px; border:1px solid #2c3040;
    background:#0e1017; color:var(--text); font-size:15px; }
  .row { display:flex; gap:8px; align-items:center; }
  .row > *:first-child { flex:1; }
  button { padding:10px 14px; border-radius:8px; border:0; background:var(--accent);
           color:#fff; font-size:15px; cursor:pointer; }
  button.ghost { background:#2c3040; color:var(--text); }
  button:disabled { opacity:.5; cursor:not-allowed; }
  .big { width:100%; padding:14px; font-size:16px; margin-top:8px; }
  .hint { color: var(--dim); font-size: 12.5px; margin-top: 8px; }
  .hidden { display:none !important; }
  #files { color: var(--dim); font-size: 13.5px; margin-top: 8px; }
  .bar { height:8px; border-radius:4px; background:#0e1017; overflow:hidden; margin:10px 0 6px; }
  .bar > i { display:block; height:100%; width:0; background:var(--accent); transition:width .15s; }
  .stat { display:flex; justify-content:space-between; font-size:12.5px; color:var(--dim); }
  .linkbox { display:flex; gap:8px; margin-top:8px; }
  .linkbox input { font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; }
  .err { color: var(--err); } .ok { color: var(--ok); } .warn { color: var(--warn); }
  .lang { position:fixed; right:12px; top:12px; }
  .lang button { padding:6px 10px; font-size:12.5px; }
</style>
</head>
<body>
<div class="lang"><button id="langBtn" class="ghost" type="button">English</button></div>
<div class="wrap">
  <h1 data-zh="我要发文件（网页版）" data-en="Send files (web version)">我要发文件（网页版）</h1>
  <p class="sub" data-zh="文件经中继转发，内容端到端加密 —— 中继解不开。对方用浏览器打开链接就能收。"
     data-en="Files travel through a relay, end-to-end encrypted —— the relay cannot read them. The other side just opens the link in a browser.">文件经中继转发，内容端到端加密 —— 中继解不开。对方用浏览器打开链接就能收。</p>

  <div class="card">
    <label data-zh="中继地址" data-en="Relay address">中继地址</label>
    <input id="relay" type="text" placeholder="https://your-relay.your-name.workers.dev" autocomplete="off">
    <div class="hint" data-zh="就是部署中继时得到的那个地址。同一个地址双方都用它。"
         data-en="The address you got when deploying the relay; both sides use the same one.">就是部署中继时得到的那个地址。同一个地址双方都用它。</div>
  </div>

  <div class="card">
    <label data-zh="一次性密码" data-en="One-time password">一次性密码</label>
    <div class="row">
      <input id="pw" type="text" autocomplete="off" spellcheck="false">
      <button id="gen" class="ghost" type="button" data-zh="换一个" data-en="New one">换一个</button>
    </div>
    <div class="hint" data-zh="对方要输入完全相同的密码。请**和链接分开**告诉对方（链接发消息、密码打电话）。"
         data-en="The other side must type exactly this. Send the link and the password **separately**.">对方要输入完全相同的密码。请和链接分开告诉对方。</div>
  </div>

  <div class="card">
    <label data-zh="要发的文件" data-en="Files to send">要发的文件</label>
    <input id="pick" type="file" multiple>
    <div id="files"></div>
    <div class="hint" data-zh="浏览器限制：不能选整个文件夹（目录结构会丢），手机上也一样。"
         data-en="Browser limit: a whole folder cannot be picked (the structure would be lost), on phones too.">浏览器限制：不能选整个文件夹（目录结构会丢），手机上也一样。</div>
  </div>

  <button id="start" class="big" disabled data-zh="开始（会先把文件读一遍算校验值）" data-en="Start (it will read every file once to compute checksums)">开始（会先把文件读一遍算校验值）</button>

  <div id="panel" class="card hidden" style="margin-top:14px">
    <div id="stage" class="stat"><span id="stageText"></span><span id="pct"></span></div>
    <div class="bar"><i id="barFill"></i></div>
    <div class="stat"><span id="bytes"></span><span id="speed"></span></div>
    <div id="linkWrap" class="hidden" style="margin-top:12px">
      <label data-zh="把这条链接发给对方（含一次性令牌）" data-en="Send this link to the other side">把这条链接发给对方（含一次性令牌）</label>
      <div class="linkbox">
        <input id="link" type="text" readonly>
        <button id="copy" class="ghost" type="button" data-zh="复制" data-en="Copy">复制</button>
      </div>
    </div>
    <button id="cancel" class="big ghost" type="button" data-zh="取消并销毁" data-en="Cancel and destroy">取消并销毁</button>
  </div>

  <div id="done" class="card hidden">
    <div id="doneText" class="ok"></div>
    <div class="hint" data-zh="房间已销毁：这条链接和密码从现在起都不能再用了。" data-en="The room is destroyed: this link and password no longer work.">房间已销毁：这条链接和密码从现在起都不能再用了。</div>
  </div>
</div>

<!-- sender-core:begin —— 这一整段由 gen/inline-sender.mjs 生成，请勿手改 -->
<script data-inlined-from="web/phone-core.js">
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
 * 所以它由 \`gen/inline-phone.mjs\` 原样内联进 \`web/phone.html\`。
 * 这个文件因此必须是"浏览器能直接吃"的普通脚本：不许 import/require，
 * 不许用 Buffer/process —— 生成器会把这几条当判据检查。
 *
 * ── 与 Node 那一份的关系（重要，别当成第三份实现就完事）──────────
 *
 * 密码学在项目里有**两份**实现：Node 侧（\`src/suite/flicker1.js\`）与接收端页面内联的那份。
 * 加上这一份就是第三份 —— 这是本项目反复吃过亏的地方（两份实现漂移，表现是"永远连不上"
 * 或"密码不一致"，而且测试全绿）。所以：
 *
 *   · 这一份**只服务发送方向**（接收端那份只做解密），两边能重合的地方刻意保持同名同形；
 *   · \`test/phone-page.test.js\` 把它与 \`src/suite/flicker1.js\` **逐字节**比对：
 *     验证值、三把钥匙、两种握手 MAC、清单密文、分块密文、AAD、IV、SHA-256 ——
 *     只要漂移一个字节，测试立刻失败；
 *   · 不把接收端页面里那份抽出来共用，是因为那一页已经真机验证过，
 *     设计草稿里明确写着"不改现有的接收端页面"（见 \`_lab/设计草稿-手机发送端.md\` §七）。
 *     将来若要合并成一份，先看这条测试覆盖了什么，别只做机械抽取。
 *
 * ⚠️ AES-GCM 的 \`subtle.encrypt\` 返回的是 **密文 ‖ 16 字节 tag**，
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

  /** 导入成 AES-GCM 用的钥匙（\`usage\` 是 'encrypt' 或 'decrypt'） */
  async function importEnc(raw, usage = 'encrypt') {
    return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [usage])
  }

  // ── 握手 ───────────────────────────────────────────────────

  /**
   * MAC 的输入 = 域分隔前缀 ‖ 挑战。
   * 前缀里的 \`send\` / \`recv\` 是**方向绑定** —— 没有它，一个方向的 MAC
   * 可以被原样重放到另一个方向（PROTOCOL.md §4.5）。
   */
  function macInput(role, challenge, profile = 'v2', suite = SUITE_ID) {
    const prefix = profile === 'v1' ? ('flicker/1/' + role + '\\n') : (suite + '\\n' + role + '\\n')
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
</script>
<script data-inlined-from="web/sender-core.js">
/**
 * 中继模式**网页发送端**的内核（纯浏览器 JS）
 * ============================================
 *
 * 从前"发送端"只能是那个 Node 程序（\`bin/flicker.js send --relay=…\`），因为
 * 它要读磁盘、要算哈希、要按接收端的确认节奏投递。手机上的浏览器做不到
 * "当服务端"，但**当中继的发送端**完全做得到 —— 这个文件就是把那件事做出来。
 *
 * ── 与另外几份实现的关系（别当成第四份就完事）───────────────
 * 密码学：直接用 \`web/phone-core.js\`（\`globalThis.FlickerPhone\`），它已经与 Node 侧
 *   \`src/suite/flicker1.js\` 做过分块/清单的逐字节比对。这份文件**不重新实现密码学**。
 * 流程控制：窗口规划的逻辑与 \`src/relay/core.js\` 的 \`planWindow()\` 同一套规则
 *   （投递量=空位、不足半窗先问状态、窗口是硬上限）。纯函数那份是给 Node 用的；
 *   这里因为要被内联进页面，只能写成同样的规则 —— \`test/sender-page-inline.test.js\`
 *   与 \`_lab/e2e-relay-page-sender.mjs\` 会盯住两边行为一致。
 *
 * ── 它不做的事（明确边界，别以为是漏了）─────────────────────
 *   · 不选文件夹（浏览器给的 File 只有名字，没有目录结构）
 *   · 不做断点续传（页面一刷新，密钥与房间名就没了 —— 与接收页同一条限制）
 *   · 不送赠品程序（那需要读本地可执行文件，中继模式的赠品路径也只对 Node 有意义）
 *   · 不做限速（手机上做限速意义不大，且会再引一套定时器）
 *
 * 所有内容在出门前就已加密（AES-256-GCM），中继拿到的只有密文。
 */
(function () {
  'use strict'

  const P = globalThis.FlickerPhone
  if (!P) throw new Error('sender-core 需要先内联 phone-core.js（FlickerPhone 不存在）')

  /** 消息类型（与 \`src/relay/protocol.js\` 的 MSG 一致） */
  const MSG = { MANIFEST: 0x01, CHUNK: 0x02 }
  /** 协议保证的**最小**单条上限（1 MiB 明文 + 1 字节类型 + 16 字节 tag） */
  const MIN_MESSAGE = (1 << 20) + 17
  /** 分块上限：比它更大没有收益（见 src/chunk-size.js 的实测） */
  const MAX_CHUNK = 4 << 20

  // ── 字节拼装（与 protocol.js 的 packMessage / packBatch 同格式）────────

  function concatAll(parts) {
    let n = 0
    for (const p of parts) n += p.length
    const out = new Uint8Array(n)
    let off = 0
    for (const p of parts) { out.set(p, off); off += p.length }
    return out
  }

  /** 一条消息：类型字节 + 负载 */
  function packMessage(type, payload) {
    const out = new Uint8Array(1 + payload.length)
    out[0] = type
    out.set(payload, 1)
    return out
  }

  /** 一批消息：\`[len(4, 大端) | 内容] × N\` —— 长度前缀比分隔符安全（密文里什么字节都可能有） */
  function packBatch(items) {
    const parts = []
    for (const it of items) {
      const len = new Uint8Array(4)
      new DataView(len.buffer).setUint32(0, it.length)
      parts.push(len, it)
    }
    return concatAll(parts)
  }

  /**
   * 这一轮该不该投、投多少（与 \`src/relay/core.js\` 的 planWindow 同一规则）。
   *
   *  ① 投递量是**空位**（窗口 − 在途），不是整个窗口；
   *  ② 空位不足半窗时先问状态，否则每窗要花两个往返（吞吐砍半）；
   *     剩余量本来就不足半窗时照投；
   *  ③ 窗口是硬上限：接收端不 ack 时绝不超投（中继队列在内存里）。
   */
  function planWindow({ total, posted, ackedBase, windowSize, idleRounds }) {
    const startSeq = posted
    const inFlight = startSeq - ackedBase
    const room = Math.max(0, windowSize - inFlight)
    const remaining = total - startSeq
    const worthSending = room >= Math.max(1, Math.ceil(windowSize / 2)) || room >= remaining
    const forcePoll = idleRounds >= 3
    const count = Math.min(room, Math.max(0, remaining))
    const send = (worthSending || forcePoll) && startSeq < total && count > 0
    return { startSeq, inFlight, room, remaining, worthSending, forcePoll, count, send }
  }

  // ── 主体 ────────────────────────────────────────────────────

  class Sender {
    /**
     * @param {object} o
     * @param {string} o.relayUrl 中继地址（https://xxx.workers.dev，可带结尾斜杠）
     * @param {string} o.password 一次性密码（双方输入同一个）
     * @param {File[]} o.files 浏览器给的 File 列表
     * @param {number} [o.windowSize] 在途消息上限（默认 4；手机上不宜太大）
     * @param {number} [o.pollMs] 等 ack 的轮询间隔
     * @param {(e:object)=>void} [o.onEvent]
     */
    constructor({ relayUrl, password, files, windowSize = 4, pollMs = 300, onEvent }) {
      this.base = String(relayUrl || '').replace(/\\/+$/, '')
      this.password = String(password || '')
      this.files = [...(files || [])]
      this.windowSize = Math.max(1, Number(windowSize) || 4)
      this.pollMs = Math.max(100, Number(pollMs) || 300)
      this.onEvent = onEvent ?? (() => {})
      this.stopped = false
      this.posted = 0
      this.ackedBase = 0
      this.bytesPosted = 0
      this.retryCount = 0
      this.chunkBytes = MIN_MESSAGE - 17
      this.keys = null
      this.room = null
      this.salt = null
      this.manifest = null
    }

    _emit(e) { try { this.onEvent(e) } catch { /* 回调里的异常不能影响传输 */ } }

    _sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

    /** 一次请求；只对**瞬时**故障重试（与 core.js 的 isTransientError 同一判据） */
    async _fetch(url, init = {}) {
      const out = await fetch(url, init)
      if (!out.ok) {
        let code = \`HTTP_\${out.status}\`, message = \`中继返回 \${out.status}\`
        try { const j = await out.json(); code = j.error ?? code; message = j.message ?? message } catch { /* 非 JSON */ }
        const e = new Error(\`中继错误：\${message}\`)
        e.code = code
        e.status = out.status
        throw e
      }
      return out
    }

    static _transient(e) {
      if (!e) return false
      if (e.code === 'ABORTED') return false
      const fatal = ['NO_ROOM', 'EXPIRED', 'GONE', 'NOT_YET', 'BAD_SEQ', 'BAD_ROOM_ID',
        'TOO_LARGE', 'BAD_BODY', 'EMPTY_BODY', 'EMPTY_BATCH', 'BATCH_TOO_LARGE', 'BAD_BATCH',
        'ROOM_TAKEN']
      if (typeof e.code === 'string' && fatal.includes(e.code)) return false
      if (typeof e.status === 'number') return e.status >= 500 || e.status === 429
      // fetch 的网络层失败抛 TypeError；超时是 TimeoutError/AbortError
      return e.name === 'TypeError' || e.name === 'TimeoutError' || e.name === 'AbortError' ||
        typeof e.cause?.code === 'string'
    }

    async _withRetry(label, fn, retries = 3) {
      let last = null
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (this.stopped) throw Object.assign(new Error('已取消'), { code: 'ABORTED' })
        try { return await fn(attempt) } catch (e) {
          last = e
          if (!Sender._transient(e) || attempt === retries) throw e
          const wait = Math.min(300 * 2 ** attempt, 8000) + Math.floor(Math.random() * 250)
          this.retryCount++
          this._emit({ type: 'retry', label, attempt, wait, code: e.code ?? e.name })
          await this._sleep(wait)
        }
      }
      throw last
    }

    /** 问中继：一条消息最多收多大（老中继不声明就按协议最小值） */
    async _caps() {
      try {
        const r = await this._fetch(\`\${this.base}/health\`)
        const j = await r.json()
        const n = Number(j.maxMessageBytes)
        if (Number.isFinite(n) && n > 0) return n
      } catch { /* 探测失败就按最小值走，创建房间时还会再拿到一次 */ }
      return MIN_MESSAGE
    }

    /** 第一步：派生密钥、扫描文件、建房间、放清单 */
    async start() {
      if (!this.base) throw new Error('缺少中继地址')
      if (!this.password) throw new Error('缺少一次性密码')
      if (!this.files.length) throw new Error('还没有选文件')

      // 块大小要按中继上限裁剪，而且必须在扫描之前定下来（清单里的 chunkBytes 依赖它）
      const cap = await this._caps()
      this.chunkBytes = Math.max(64 << 10, Math.min(MAX_CHUNK, cap - 17))
      this._emit({ type: 'caps', chunkBytes: this.chunkBytes, maxMessageBytes: cap })

      this._emit({ type: 'phase', phase: 'keys' })
      this.salt = crypto.getRandomValues(new Uint8Array(P.PARAMS.saltBytes))
      const verifier = await P.pbkdf2Verifier(this.password, this.salt)
      const keys = await P.hkdfKeys(verifier)
      this.keys = keys
      this.room = P.hex(keys.room)
      this.encKey = await P.importEnc(keys.enc, 'encrypt')

      this._emit({ type: 'phase', phase: 'scan' })
      const manifest = await this._scan()
      this.manifest = manifest

      this._emit({ type: 'phase', phase: 'seal-manifest' })
      const plain = new TextEncoder().encode(JSON.stringify(this._wire(manifest)))
      const em = await P.sealManifest(this.encKey, plain)
      this.manifestMessage = packMessage(MSG.MANIFEST,
        concatAll([this.salt, em.iv, em.tag, em.ct]))

      this._emit({ type: 'phase', phase: 'open' })
      const created = await this._withRetry('open', async () => {
        const r = await this._fetch(\`\${this.base}/r/\${this.room}\`, { method: 'POST' })
        return r.json()
      })
      if (Number.isInteger(created.maxMessageBytes) && created.maxMessageBytes > 0) {
        // 创建响应里的声明更权威：块大小已经算过，这里只在必要时再收紧一次
        const allowed = created.maxMessageBytes - 17
        if (allowed >= 64 << 10 && allowed < this.chunkBytes) {
          this.chunkBytes = allowed
          this._emit({ type: 'warn', message: '按中继上限把块大小调小了，清单已按新块大小重算' })
          const again = await this._scan()
          this.manifest = again
          const p2 = new TextEncoder().encode(JSON.stringify(this._wire(again)))
          const em2 = await P.sealManifest(this.encKey, p2)
          this.manifestMessage = packMessage(MSG.MANIFEST,
            concatAll([this.salt, em2.iv, em2.tag, em2.ct]))
        }
      }

      if (created.created) {
        await this._withRetry('manifest', () => this._put(0, this.manifestMessage))
      } else {
        // 房间已存在：空房间 = 我们的创建响应丢了（补投清单）；非空 = 别人占了这个名字
        const st = await this._withRetry('status', () => this._status())
        if (st.nextSeq > 0) {
          throw Object.assign(new Error(
            '这个会话的房间名已经被占用了 —— 房间里已经有别人的消息。请换一个密码重新开始。'),
          { code: 'ROOM_TAKEN' })
        }
        await this._withRetry('manifest', () => this._put(0, this.manifestMessage))
      }

      const st = await this._withRetry('status', () => this._status())
      this.posted = st.nextSeq
      this.ackedBase = st.ackedBase
      this.bytesPosted = 0

      this._emit({ type: 'ready', link: this.link(), total: 1 + this.manifest.totalChunks,
        bytes: this.manifest.totalBytes, files: this.files.length })
      return this.link()
    }

    link() {
      // 盐放在 fragment：浏览器不把它发给服务器，中继看不到
      return \`\${this.base}/#k=\${this.room}&s=\${P.hex(this.salt)}\`
    }

    async _status() {
      const r = await this._fetch(\`\${this.base}/r/\${this.room}\`)
      return r.json()
    }

    async _put(seq, message) {
      await this._fetch(\`\${this.base}/r/\${this.room}?seq=\${seq}\`, { method: 'POST', body: message })
    }

    /**
     * 扫描：每个文件的 **整文件 sha256** 与**逐块 sha256**。
     *
     * ⚠️ 这会把每个文件完整读一遍（浏览器里只能这样）。所以手机上大文件会有一段
     *    "准备中"的等待 —— 这是协议要求（清单里必须带上哈希，接收端靠它验完整性）。
     */
    async _scan() {
      const files = []
      let totalBytes = 0
      let totalChunks = 0
      for (const file of this.files) {
        const size = file.size
        const chunkBytes = this.chunkBytes
        const chunks = size === 0 ? 1 : Math.ceil(size / chunkBytes)
        const whole = new P.Sha256()
        const chunkHashes = []
        for (let i = 0; i < chunks; i++) {
          if (this.stopped) throw Object.assign(new Error('已取消'), { code: 'ABORTED' })
          const off = i * chunkBytes
          const part = new Uint8Array(await file.slice(off, Math.min(off + chunkBytes, size)).arrayBuffer())
          whole.update(part)
          const h = new P.Sha256()
          h.update(part)
          chunkHashes.push(h.digest())
          this._emit({ type: 'hash', file: file.name, done: i + 1, total: chunks })
        }
        const rel = file.name
        files.push({
          kind: 'file', name: file.name, rel,
          size, chunks, chunkBytes,
          sha256: whole.digest(),
          chunkHashes,
          firstChunk: totalChunks,
          _file: file,
        })
        totalBytes += size
        totalChunks += chunks
      }
      return { files, totalBytes, totalChunks }
    }

    /** 清单的**线上形式**（字段与 \`src/manifest.js\` 的 toWire 一致） */
    _wire(m) {
      return {
        v: 1,
        suite: 'FLICKER/1',
        sentAt: new Date().toISOString(),
        files: m.files.map((f) => ({
          kind: f.kind, name: f.name, rel: f.rel, size: f.size,
          chunks: f.chunks, chunkBytes: f.chunkBytes,
          sha256: f.sha256, chunkHashes: f.chunkHashes,
        })),
        totalBytes: m.totalBytes,
        totalChunks: m.totalChunks,
      }
    }

    /** 全局序号 → (文件, 文件内块号, 明文长度) */
    _locate(ordinal) {
      for (const file of this.manifest.files) {
        if (ordinal >= file.firstChunk && ordinal < file.firstChunk + file.chunks) {
          const chunkIndex = ordinal - file.firstChunk
          const plainLen = Math.max(0, Math.min(file.chunkBytes, file.size - chunkIndex * file.chunkBytes))
          return { file, chunkIndex, plainLen }
        }
      }
      throw new Error(\`分块序号无法定位: \${ordinal}\`)
    }

    /** 一批投递：把 [startSeq, startSeq+count) 逐块加密、包成 batch 发出去 */
    async _putBatch(startSeq, count) {
      const total = 1 + this.manifest.totalChunks
      const items = []
      const meta = []
      for (let i = 0; i < count; i++) {
        if (this.stopped) throw Object.assign(new Error('已取消'), { code: 'ABORTED' })
        const seq = startSeq + i
        if (seq >= total) break
        const { file, chunkIndex, plainLen } = this._locate(seq - 1)
        const off = chunkIndex * file.chunkBytes
        const plain = new Uint8Array(await file._file.slice(off, off + plainLen).arrayBuffer())
        if (plain.length !== plainLen) {
          throw new Error(\`文件在传输过程中被改动（\${file.rel} 第 \${chunkIndex} 块）\`)
        }
        const { ct, tag } = await P.sealChunk(this.encKey, file.index ?? this._indexOf(file),
          chunkIndex, file.chunks, plain)
        items.push(packMessage(MSG.CHUNK, concatAll([tag, ct])))
        meta.push({ seq, fileIndex: file.index ?? this._indexOf(file), chunkIndex, bytes: plainLen, fileName: file.rel })
      }
      if (!items.length) return { chunks: [], aborted: true }

      const body = packBatch(items)
      const wantNext = startSeq + items.length
      let landed = null
      const r = await this._withRetry('batch', async (attempt) => {
        if (attempt > 0 && !landed) {
          // 重试前先确认上一次到底落库没有：服务端 nextSeq 是唯一权威
          const st = await this._status().catch(() => null)
          const n = st?.nextSeq
          if (n === wantNext) { landed = st; return null }
          if (Number.isInteger(n) && n !== startSeq) {
            throw Object.assign(new Error(\`投递序号错乱：期望 nextSeq=\${startSeq}，服务端是 \${n}\`),
              { code: 'SEQ_DESYNC', status: 0, cause: null })
          }
        }
        return this._fetch(\`\${this.base}/r/\${this.room}/batch\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body,
        })
      }, 4)
      const j = landed ?? await r.json()
      this.posted = Math.max(this.posted, j.nextSeq)
      this.ackedBase = j.ackedBase
      for (const m of meta) this.bytesPosted += m.bytes
      return { chunks: meta }
    }

    _indexOf(file) {
      return this.manifest.files.indexOf(file)
    }

    /**
     * 主循环：投递 → 等确认 → 直到接收端确认了**全部**消息。
     *
     * ⚠️ 完成判据是 \`ackedBase >= total\`，不是"我投完了"。"我发完了"不等于"对方收完了"，
     *    这条在 Node 侧踩过（实测 posted=6/total=6/pending=0 而 ackedBase=5 → 误报完成）。
     */
    async run({ timeoutMs = 15 * 60 * 1000 } = {}) {
      const total = 1 + this.manifest.totalChunks
      let idleSince = Date.now()
      let idleRounds = 0
      let lastAcked = this.ackedBase
      let lastPosted = this.posted

      while (!this.stopped) {
        if (Date.now() - idleSince > timeoutMs) {
          this._emit({ type: 'incomplete', reason: 'timeout', posted: this.posted, ackedBase: this.ackedBase, total })
          return { ok: false, reason: 'timeout' }
        }
        const plan = planWindow({
          total, posted: this.posted, ackedBase: this.ackedBase,
          windowSize: this.windowSize, idleRounds,
        })
        let sentSomething = false
        if (plan.send) {
          const batch = await this._putBatch(plan.startSeq, plan.count)
          sentSomething = batch.chunks.length > 0
          if (sentSomething) {
            idleRounds = 0
            this._emit({
              type: 'progress', posted: this.posted, ackedBase: this.ackedBase,
              total, bytes: this.bytesPosted, totalBytes: this.manifest.totalBytes,
              chunk: batch.chunks[batch.chunks.length - 1],
            })
          }
        }
        if (this.posted >= total && this.ackedBase >= total) {
          this._emit({ type: 'complete', posted: this.posted, bytes: this.bytesPosted })
          return { ok: true, posted: this.posted }
        }
        if (!sentSomething) idleRounds++
        // 需要新 ack（或这一轮没投）时才问状态 —— 这是唯一会等一个往返的地方
        if (!sentSomething || Math.max(0, this.windowSize - (this.posted - this.ackedBase)) === 0) {
          const st = await this._status()
          if (st.ackedBase > lastAcked || this.posted !== lastPosted) {
            lastAcked = st.ackedBase; lastPosted = this.posted
            idleSince = Date.now()
            this._emit({ type: 'progress', posted: this.posted, ackedBase: st.ackedBase, total,
              bytes: this.bytesPosted, totalBytes: this.manifest.totalBytes })
          }
          this.ackedBase = st.ackedBase
          if (this.posted >= total && st.ackedBase >= total) {
            this._emit({ type: 'complete', posted: this.posted, bytes: this.bytesPosted })
            return { ok: true, posted: this.posted }
          }
          if (Math.max(0, this.windowSize - (this.posted - this.ackedBase)) === 0) {
            await this._sleep(this.pollMs)
          }
        }
        if (this.posted >= total && this.ackedBase >= total) {
          this._emit({ type: 'complete', posted: this.posted, bytes: this.bytesPosted })
          return { ok: true, posted: this.posted }
        }
      }
      this._emit({ type: 'incomplete', reason: 'aborted', posted: this.posted,
        ackedBase: this.ackedBase, total })
      return { ok: false, reason: 'aborted' }
    }

    /** 用户取消：停循环 + 删房间（房间没了，链接立即失效） */
    async stop() {
      this.stopped = true
      try {
        await this._fetch(\`\${this.base}/r/\${this.room}\`, { method: 'DELETE' })
      } catch { /* 已经没了就算了 */ }
      // 清掉密钥（清不掉 JS 字符串里的密码副本，这点在文档里如实写了）
      try { this.keys?.enc?.fill?.(0) } catch { /* 不可写就算了 */ }
    }

    /** 传完后销毁房间（与 stop 的区别只是语义：正常完成 vs 取消） */
    async destroy() {
      try {
        await this._fetch(\`\${this.base}/r/\${this.room}\`, { method: 'DELETE' })
        return true
      } catch { return false }
    }
  }

  globalThis.FlickerSender = { Sender, planWindow, packMessage, packBatch, MSG, MIN_MESSAGE, MAX_CHUNK }
})()
</script>
<!-- sender-core:end -->

<script>
(function () {
  'use strict'
  var S = globalThis.FlickerSender
  var $ = function (id) { return document.getElementById(id) }
  var lang = 'zh'
  function t(zh, en) { return lang === 'zh' ? zh : en }
  function applyLang() {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
    var nodes = document.querySelectorAll('[data-zh]')
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i]
      n.textContent = lang === 'zh' ? n.getAttribute('data-zh') : n.getAttribute('data-en')
    }
    $('langBtn').textContent = lang === 'zh' ? 'English' : '中文'
  }
  $('langBtn').onclick = function () { lang = lang === 'zh' ? 'en' : 'zh'; applyLang() }
  applyLang()

  /** 好念好打的一次性密码：两组三位（与手机页同一个字母表，去掉易混字符） */
  var ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'
  function newCode() {
    var out = ''
    for (var i = 0; i < 6; i++) {
      var b = new Uint8Array(1); crypto.getRandomValues(b)
      out += ALPHABET[b[0] % ALPHABET.length]
      if (i === 2) out += '-'
    }
    return out
  }
  $('pw').value = newCode()
  $('gen').onclick = function () { $('pw').value = newCode() }

  var picked = []
  function refreshPick() {
    var total = 0
    for (var i = 0; i < picked.length; i++) total += picked[i].size
    $('files').textContent = picked.length
      ? t('已选 ' + picked.length + ' 个 · 共 ' + fmt(total), picked.length + ' selected · ' + fmt(total))
      : ''
    syncStart()
  }
  $('pick').onchange = function () {
    picked = Array.prototype.slice.call($('pick').files || [])
    refreshPick()
  }
  function syncStart() {
    $('start').disabled = !(picked.length && $('relay').value.trim() && $('pw').value.trim())
  }
  $('relay').oninput = syncStart
  $('pw').oninput = syncStart

  function fmt(n) {
    if (n < 1024) return n + ' B'
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB'
    return (n / 1073741824).toFixed(2) + ' GB'
  }

  var sender = null
  var startedAt = 0
  var lastBytes = 0
  var lastAt = 0

  function setStage(text, pct) {
    $('stageText').textContent = text
    if (typeof pct === 'number') {
      $('pct').textContent = Math.floor(pct * 100) + '%'
      $('barFill').style.width = Math.max(0, Math.min(100, pct * 100)) + '%'
    }
  }

  function onEvent(ev) {
    if (ev.type === 'phase') {
      var m = {
        keys: t('正在派生密钥（约一两秒）…', 'Deriving keys (a second or two)…'),
        scan: t('正在读文件、算校验值…', 'Reading files and computing checksums…'),
        'seal-manifest': t('正在封清单…', 'Sealing the manifest…'),
        open: t('正在建立房间…', 'Opening the room…'),
      }
      setStage(m[ev.phase] || ev.phase, 0)
    } else if (ev.type === 'hash') {
      setStage(t('正在算校验值：' + ev.file + '（' + ev.done + '/' + ev.total + '）',
        'Checksums: ' + ev.file + ' (' + ev.done + '/' + ev.total + ')'), 0)
    } else if (ev.type === 'ready') {
      $('link').value = ev.link
      $('linkWrap').classList.remove('hidden')
      setStage(t('等待对方打开链接并核验密码…（链接与密码是一次性的）',
        'Waiting for the other side to open the link and verify the password…'), 0.02)
      startedAt = lastAt = Date.now()
    } else if (ev.type === 'progress') {
      var pct = ev.totalBytes ? ev.bytes / ev.totalBytes : 0
      setStage(t('正在发送（对方已确认 ' + ev.ackedBase + '/' + ev.total + '）',
        'Sending (confirmed ' + ev.ackedBase + '/' + ev.total + ')'), pct)
      $('bytes').textContent = fmt(ev.bytes) + ' / ' + fmt(ev.totalBytes)
      var now = Date.now()
      if (now - lastAt > 700) {
        var rate = (ev.bytes - lastBytes) / ((now - lastAt) / 1000)
        $('speed').textContent = rate > 0 ? fmt(rate) + '/s' : ''
        lastAt = now; lastBytes = ev.bytes
      }
    } else if (ev.type === 'retry') {
      setStage(t('网络抖了一下，正在重试（' + ev.attempt + '）…', 'Network hiccup, retrying (' + ev.attempt + ')…'))
    } else if (ev.type === 'complete') {
      setStage(t('发送完成', 'Done'), 1)
      $('panel').classList.add('hidden')
      $('done').classList.remove('hidden')
      $('doneText').textContent = t('全部发出，对方也确认收到了。', 'Everything sent and confirmed by the other side.')
    } else if (ev.type === 'incomplete') {
      var why = ev.reason === 'timeout'
        ? t('等不到对方的确认 —— 对方可能关掉了页面或断网了。已投出去的数据对方只收到一部分。',
          'No confirmation from the other side —— they may have closed the page or lost the network.')
        : t('已取消。', 'Cancelled.')
      $('panel').classList.add('hidden')
      $('done').classList.remove('hidden')
      $('doneText').textContent = why
      $('doneText').className = 'warn'
    } else if (ev.type === 'warn') {
      setStage(ev.message)
    }
  }

  $('start').onclick = function () {
    $('start').disabled = true
    $('panel').classList.remove('hidden')
    $('done').classList.add('hidden')
    $('bytes').textContent = ''
    $('speed').textContent = ''
    lastBytes = 0
    sender = new S.Sender({
      relayUrl: $('relay').value.trim(),
      password: $('pw').value,
      files: picked,
      onEvent: onEvent,
    })
    sender.start().then(function () { return sender.run() }).then(function (r) {
      if (r && r.ok) return sender.destroy()
      return null
    }).catch(function (e) {
      $('panel').classList.add('hidden')
      $('done').classList.remove('hidden')
      $('doneText').className = 'err'
      var msg = e && e.message ? e.message : String(e)
      if (e && e.code === 'ROOM_TAKEN') msg = t('房间名被占用了，换一个密码重试。', 'That room name is taken — try another password.')
      $('doneText').textContent = t('出错了：' + msg, 'Error: ' + msg)
      $('start').disabled = false
    })
  }

  $('cancel').onclick = function () {
    if (sender) sender.stop()
    $('panel').classList.add('hidden')
    $('done').classList.remove('hidden')
    $('doneText').className = 'warn'
    $('doneText').textContent = t('已取消，房间已销毁。', 'Cancelled; the room is destroyed.')
    $('start').disabled = false
  }

  $('copy').onclick = function () {
    var v = $('link').value
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(v).then(function () {
        $('copy').textContent = t('已复制', 'Copied')
        setTimeout(function () { $('copy').textContent = t('复制', 'Copy') }, 1200)
      })
    } else {
      $('link').select()
    }
  }
})()
</script>
</body>
</html>
`

/** 页面内容的指纹，用于自检"部署的页面与源文件是否一致" */
export const SENDER_HTML_DIGEST = '8f4fe3333f6b8a75'
