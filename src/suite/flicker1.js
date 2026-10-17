/**
 * FLICKER/1 加密套件
 * ==================
 *
 * 本文件是整个项目最需要被仔细阅读和审计的部分。
 * 协议规范见 PROTOCOL.md 第 2 章；设计理由见 设计文档.md 第四章。
 *
 * 设计要点：
 *  1. 密码永不上网线 —— 只交换挑战与应答
 *  2. 一个密码派生值 V，再用 HKDF 分成三把互不相关的钥匙
 *  3. 每块独立认证，块坐标写进 AAD，防止乱序/重放/拼接
 *  4. 所有密钥材料都用 Buffer/TypedArray，便于可靠清零（JS 字符串不可清零）
 *
 * 关于清零的诚实说明（对应 行为与运行.md §3.3）：
 *  JS 字符串不可变、可能被 GC 复制，历史副本无法触及。
 *  所以密码读入后立即转成 Buffer，字符串引用立刻丢弃，把窗口压到毫秒级。
 */
import {
  pbkdf2Sync, hkdfSync, randomBytes, createHmac,
  createCipheriv, createDecipheriv, timingSafeEqual, createHash,
} from 'node:crypto'

// ── 套件参数（PROTOCOL.md §2.4）──────────────────────────────
export const SUITE_ID = 'FLICKER/1'
export const PARAMS = Object.freeze({
  kdf: 'PBKDF2-SHA256',
  iterations: 600_000,
  saltBytes: 16,
  hash: 'sha256',
  aead: 'AES-256-GCM',
  keyBytes: 32,
  ivBytes: 12,
  tagBytes: 16,
  chunkBytes: 1 << 20,        // 1 MiB
  nonceBytes: 32,             // 握手挑战
})

/** HKDF 的三个标签 —— 必须互不相同，否则三把钥匙会退化成一吧 */
export const LABELS = Object.freeze({
  room: 'flicker/1/room',
  auth: 'flicker/1/auth',
  enc: 'flicker/1/enc',
})

// ── 密钥派生 ────────────────────────────────────────────────

/**
 * 由密码计算验证值 V。
 * 注意：V 本身就是"密码的等价物"，绝不可上网线 —— 它只用来派生钥匙。
 * @param {string|Buffer} password
 * @param {Buffer} salt 16 字节
 * @returns {Buffer} 32 字节
 */
export function deriveVerifier(password, salt) {
  // ⚠️ 判据是"16 字节的字节序列"，不是"必须恰好是 Buffer"。
  //    最初只接受 Buffer，结果从中继消息里切出来的盐（Uint8Array 视图）
  //    被拒了 —— 那是合法输入，属于误伤。
  //    真正要防的是"长度不对/不是字节"，那条依然在。
  if (!ArrayBuffer.isView(salt) || salt.length !== PARAMS.saltBytes) {
    throw new Error(`盐必须是 ${PARAMS.saltBytes} 字节的字节序列（Buffer 或 Uint8Array）`)
  }
  const pw = typeof password === 'string' ? Buffer.from(password, 'utf8') : password
  const v = pbkdf2Sync(pw, salt, PARAMS.iterations, PARAMS.keyBytes, PARAMS.hash)
  if (Buffer.isBuffer(pw) && pw !== password) pw.fill(0)   // 清掉我们自己的副本
  return v
}

/**
 * 从 V 派生三把用途隔离的钥匙。
 * @param {Buffer} verifier 32 字节
 * @returns {{room:Buffer, auth:Buffer, enc:Buffer}}
 */
export function deriveKeys(verifier) {
  if (!ArrayBuffer.isView(verifier) || verifier.length !== PARAMS.keyBytes) {
    throw new Error(`验证值必须是 ${PARAMS.keyBytes} 字节的字节序列（Buffer 或 Uint8Array）`)
  }
  const seed = Buffer.isBuffer(verifier) ? verifier : Buffer.from(verifier)
  const one = (label) => Buffer.from(hkdfSync(PARAMS.hash, seed, Buffer.alloc(0), label, PARAMS.keyBytes))
  return { room: one(LABELS.room), auth: one(LABELS.auth), enc: one(LABELS.enc) }
}

/**
 * 房间号（局域网模式用的短标识）—— 中继能看到的那个标识，由密码决定，反推不出密码。
 * 16 位十六进制。
 */
export function roomId(keys) {
  return createHash('sha256').update(keys.room).digest('hex').slice(0, 16)
}

/**
 * 中继房间名 —— 跨网络模式下用的**完整**标识，64 位十六进制。
 *
 * ── 为什么这里不额外做"授权" ──
 * 一开始我给中继加了"授权密钥"：房间创建时登记，之后每个请求都要出示。
 * 但测试立刻暴露了一个**先到先得的竞态**：
 * 房间不存在时，第一个到达的请求决定了登记哪把密钥 ——
 * 于是"攻击者用自己派生的密钥抢先建了同名房间"就能把真正的发送端挡在外面。
 * 换成"比对房间名"也不行，因为房间名本来就在 URL 里。
 *
 * 正确的模型是：**房间名本身就是能力**。
 *   · 它由密码经 HKDF 派生，只有知道密码的人算得出来
 *   · 它是单向的（SHA-256 / HKDF），从房间名反推不出密码
 *   · 它只在 URL 的 fragment（# 之后）里，**浏览器不会把 fragment 发给服务器**
 *   · 完整 128 bit 让它不可枚举（短房间号只有 16 位十六进制，理论上可暴力试）
 * 所以"知道房间名"等价于"知道密码"，中继不需要再有第二套授权机制。
 * 加密密钥与房间密钥是分开派生的，所以中继知道了房间名也解不开任何东西。
 */
export function relayRoomName(keys) {
  return keys.room.toString('hex')
}

// ── 握手：挑战—应答（双向认证）────────────────────────────────

/**
 * 接收端发起：生成一次性挑战
 * @returns {Buffer} 32 字节
 */
export function newChallenge() {
  return randomBytes(PARAMS.nonceBytes)
}

/**
 * 握手 MAC 的两种构造（**降级保护**，2026-10）
 * ==========================================
 *
 * ── 为什么要两套 ──
 * `PROTOCOL.md` §2.6 说"防降级攻击靠把 `suite_id` 绑进 MAC"。
 * 但**线上已经跑着只认旧构造的实现**（尤其是中继托管的那份接收页：
 * 老中继 = 老页面），直接改字节会让所有老部署互相"密码不一致"。
 * 所以改成两个**具名构造**，由发送端报价、接收端选择并**回执**：
 *
 *   v2（`bound`）  ：MAC 输入 = `utf8(suite_id + "\n" + role + "\n")` ‖ nonce
 *                    —— 套件 id 被绑进被认证的材料，改套件必被发现
 *   v1（`legacy`） ：MAC 输入 = `utf8("flicker/1/" + role + "\n")` ‖ nonce
 *                    —— **就是 0.1.0 发布时的字节**，只为了跟老对端互通
 *
 * ── 回执为什么能挡住降级（TLS 的 downgrade sentinel 是同一个思路）──
 * 中间人可以把"我支持 v2"这条报价**抹掉**，于是新接收端会退回 v1 ——
 * 但它必须**如实回执自己用了哪套**。发送端看到"我报了 v2、对方却回执 v1"，
 * 就知道报价被动了手脚，**直接失败**，而不是悄悄用弱的那套。
 * 老页面根本不回执（字段不存在）→ 那是真的老对端，按 v1 继续并**明确告警**。
 *
 * ⚠️ **这套保护管不到什么**（必须说清，别当成万能）：中继模式下接收页**由中继托管**，
 *    一个恶意中继可以直接换掉页面代码，那时任何协议层保护都没有意义 ——
 *    它挡的是"诚实但版本不齐"的对端与链路中间人，不是"对端代码被换掉"。
 */
export const MAC_PROFILES = Object.freeze(['v2', 'v1'])

/**
 * 拼出 MAC 的输入字节。
 * @param {'recv'|'send'} role
 * @param {Buffer} challenge
 * @param {{profile?: 'v1'|'v2', suite?: string}} [o]
 */
export function macInput(role, challenge, { profile = 'v2', suite = SUITE_ID } = {}) {
  const prefix = profile === 'v1'
    ? `flicker/1/${role}\n`
    : `${suite}\n${role}\n`
  return Buffer.concat([Buffer.from(prefix, 'utf8'), challenge])
}

/** 接收端证明自己知道密码 */
export function receiverMac(authKey, challenge, o = {}) {
  return createHmac(PARAMS.hash, authKey).update(macInput('recv', challenge, o)).digest()
}

/** 发送端证明自己知道密码 */
export function senderMac(authKey, challenge, o = {}) {
  return createHmac(PARAMS.hash, authKey).update(macInput('send', challenge, o)).digest()
}

/** 常数时间比较，避免通过响应时间泄露信息 */
export function macEquals(a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b) || a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

// ── AAD：把块坐标绑进认证范围 ────────────────────────────────

/**
 * 数据块的 AAD = fileIndex(8) || chunkIndex(8) || totalChunks(8) || plainLen(4) = 28 字节
 *
 * 必须用 BigInt 写入 —— JS 位运算会在 32 位处静默截断，
 * fileIndex >= 32768 时会出错（PROTOCOL.md §5.1.1），这是很隐蔽的坑。
 */
export function chunkAAD(fileIndex, chunkIndex, totalChunks, plainLen) {
  const b = Buffer.alloc(28)
  b.writeBigUInt64BE(BigInt(fileIndex), 0)
  b.writeBigUInt64BE(BigInt(chunkIndex), 8)
  b.writeBigUInt64BE(BigInt(totalChunks), 16)
  b.writeUInt32BE(plainLen >>> 0, 24)
  return b
}

/**
 * 清单的 AAD —— 与数据块的 AAD（28 字节）**长度不同，这是刻意的**。
 * 禁止"补零对齐"：长度不同的 AAD 天然不会与块 AAD 混淆，补零反而引入歧义。
 * 长度由下面的自检断言保证，不靠人记。
 */
export const MANIFEST_AAD = Buffer.from('flicker/1/manifest', 'utf8')

// 自检：这两个 AAD 必须不可能被混淆
if (MANIFEST_AAD.length === 28) {
  throw new Error('清单 AAD 与数据块 AAD 长度相同，会引入歧义 —— 请修改标签')
}

/** 每块的 IV = 12 字节，前 4 字节为 0，后 8 字节为块序号（保证同文件内不重复） */
export function chunkIV(chunkIndex) {
  const iv = Buffer.alloc(PARAMS.ivBytes)
  iv.writeBigUInt64BE(BigInt(chunkIndex), 4)
  return iv
}

// ── 分块加解密 ─────────────────────────────────────────────

/**
 * 加密一块。
 * @returns {{ct:Buffer, tag:Buffer}} ct 为密文，tag 为 16 字节认证标签
 */
export function sealChunk(encKey, fileIndex, chunkIndex, totalChunks, plain) {
  const iv = chunkIV(chunkIndex)
  const aad = chunkAAD(fileIndex, chunkIndex, totalChunks, plain.length)
  const c = createCipheriv(PARAMS.aead, encKey, iv, { authTagLength: PARAMS.tagBytes })
  c.setAAD(aad)
  const ct = Buffer.concat([c.update(plain), c.final()])
  return { ct, tag: c.getAuthTag() }
}

/**
 * 解密一块。任何篡改、乱序、跨文件拼接都会在这里抛错 —— 这是设计目标。
 */
export function openChunk(encKey, fileIndex, chunkIndex, totalChunks, ct, tag, plainLen) {
  const iv = chunkIV(chunkIndex)
  const aad = chunkAAD(fileIndex, chunkIndex, totalChunks, plainLen)
  const d = createDecipheriv(PARAMS.aead, encKey, iv, { authTagLength: PARAMS.tagBytes })
  d.setAAD(aad)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()])
}

/** 加密清单 */
export function sealManifest(encKey, plain) {
  const iv = randomBytes(PARAMS.ivBytes)
  const c = createCipheriv(PARAMS.aead, encKey, iv, { authTagLength: PARAMS.tagBytes })
  c.setAAD(MANIFEST_AAD)
  const ct = Buffer.concat([c.update(plain), c.final()])
  return { iv, ct, tag: c.getAuthTag() }
}

/** 解密清单。IV 随清单一起传输（不保密），AAD 固定。 */
export function openManifest(encKey, iv, ct, tag) {
  const d = createDecipheriv(PARAMS.aead, encKey, iv, { authTagLength: PARAMS.tagBytes })
  d.setAAD(MANIFEST_AAD)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()])
}

// ── 密钥清零 ───────────────────────────────────────────────

/**
 * 覆写一把钥匙。传 null/undefined 时静默通过，方便调用点写成一行。
 * 注意：只能清零 Buffer/TypedArray，清不掉 JS 字符串里的副本。
 */
export function wipe(...bufs) {
  for (const b of bufs) {
    if (Buffer.isBuffer(b) || ArrayBuffer.isView(b)) b.fill(0)
  }
}

/** 一次性令牌（放进 URL 的 ?k=，首次访问后作废） */
export function newToken(bytes = 16) {
  return randomBytes(bytes).toString('base64url')
}

/** 人类可读的随机密码：4 个单词，好念好打（见 UI设计.md §3.3） */
const WORDS = ('correct horse battery staple dolphin lantern meadow copper ' +
  'velvet canyon orbit pebble thistle marble walnut cactus ember fable ' +
  'ginger harbor indigo jigsaw kettle lagoon mitten nectar oyster ' +
  'puzzle quiver rabbit saddle timber urchin violet willow yonder zephyr').trim().split(/\s+/)

export function suggestPassword(words = 4) {
  const out = []
  for (let i = 0; i < words; i++) {
    // 拒绝采样，避免模偏差
    let idx
    do { idx = randomBytes(1)[0] } while (idx >= Math.floor(256 / WORDS.length) * WORDS.length)
    out.push(WORDS[idx % WORDS.length])
  }
  return out.join('-')
}

/**
 * 手机端用的短密码：`k7m-3fq` 这种两组三位（默认 6 个字符）。
 *
 * 为什么不像发送端那样用 4 个词：这个密码是**在手机键盘上敲**的。
 * 发送端那 26 个字符的密码是在电脑上复制粘贴/看屏幕打的，手机上打 26 个字符
 * 又慢又容易错，而错一次就浪费一次"失败额度"（错 5 次整个会话销毁）。
 *
 * 短不等于弱，这里的理由是**可算的**：
 *   · 字母表 31 个字符（去掉了长得像的 0 O 1 l I o），6 位 ≈ 2^29.7 种
 *   · 在线爆破每次会话只有 5 次机会，随后会话销毁（`MAX_AUTH_FAILURES`）
 *     → 单次会话被猜中的概率 ≤ 5 / 8.9e8 ≈ 5.6e-9
 *   · 而且 URL 里的令牌是一次性的，攻击者得先拿到链接
 *   · 想更强就 `--password=` 自己指定，程序不做限制
 */
const CODE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'   // 31 个，无易混字符

export function suggestCode({ groups = 2, size = 3 } = {}) {
  const out = []
  const limit = Math.floor(256 / CODE_ALPHABET.length) * CODE_ALPHABET.length
  for (let i = 0; i < groups * size; i++) {
    let idx
    do { idx = randomBytes(1)[0] } while (idx >= limit)      // 拒绝采样，避免模偏差
    out.push(CODE_ALPHABET[idx % CODE_ALPHABET.length])
  }
  const s = out.join('')
  return Array.from({ length: groups }, (_, i) => s.slice(i * size, (i + 1) * size)).join('-')
}

