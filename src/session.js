/**
 * 会话状态机与线上协议
 * ====================
 * 实现 PROTOCOL.md 的会话层与传输层端点。
 *
 * 三处分层（这是刻意的，别合并）：
 *   transport（本文件 + server.js）—— 只管字节怎么走
 *   session（本文件）              —— 只管握手与授权
 *   suite（suite/flicker1.js）     —— 只管密码学
 *
 * 一条重要设计：**认证是按端点分工的**（PROTOCOL.md §7.1.1）
 *   /api/session 只认一次性令牌（此时还没有会话密钥，无法认证别的）
 *   /api/auth    无认证（它就是用来认证的）
 *   /api/manifest、/api/chunk 认会话 ID（SID）
 * 这个分工解决了一个"先有鸡还是先有蛋"的问题：SID 是握手的产物，
 * 而握手之前就要先拿到 salt 和加密后的清单。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import {
  PARAMS, deriveVerifier, deriveKeys, roomId, newChallenge,
  receiverMac, senderMac, macEquals, wipe, MAC_PROFILES, SUITE_ID,
} from './suite/flicker1.js'

export const PHASE = Object.freeze({
  WAITING: 'waiting',       // 等待接收端连接
  AUTH: 'auth',             // 已发挑战，等接收端应答
  READY: 'ready',           // 双向认证完成
  DONE: 'done',             // 传输完成
  DESTROYED: 'destroyed',
})

/** 认证失败上限 —— 超过即销毁整个会话（防暴力破解） */
export const MAX_AUTH_FAILURES = 5

export class SessionError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'SessionError'
    this.code = code
  }
}

/**
 * 一次传输会话。
 *
 * 生命周期：waiting → auth → ready → done → destroyed
 * 密钥在 destroyed 时全部清零，不留引用。
 */
export class Session {
  /**
   * @param {object} o
   * @param {string} [o.password] 用户设定的密码（会用 o.salt 派生）
   * @param {Buffer} [o.salt] 已使用的盐。**必须与加密清单时用的是同一个**，
   *   否则接收端算出的密钥会和清单对不上 —— 这是极易犯又极难查的错误。
   * @param {Buffer} [o.verifier] 直接给出已验证值（内部使用，跳过 PBKDF2）
   * @param {Buffer} o.encManifest 已加密的清单
   * @param {Buffer} o.manifestIv
   * @param {Buffer} o.manifestTag
   * @param {'sender'|'receiver'} [o.role] 我们在这次传输里是**哪一端**（默认 `sender`）。
   *   ⚠️ 它只决定"握手时验谁的 MAC、回谁的 MAC"，其余（挑战、版本协商、降级检测、
   *   失败计数、销毁）**完全一样** —— 所以降级保护那套逻辑只有一份实现。
   *     · `sender`（默认，发送模式）：对端是接收端 → 验 `receiverMac`、回 `senderMac`
   *     · `receiver`（接收模式，手机往我们这儿传）：对端是发送端 → 验 `senderMac`、回 `receiverMac`
   *   两个方向分开算，是为了防"把对方发来的应答原样打回去"这种反射攻击。
   * @param {(evt:object)=>void} [o.onEvent] 事件回调（供 TTY / GUI 前端渲染）
   */
  constructor({ password, salt, verifier, encManifest, manifestIv, manifestTag, onEvent, role = 'sender' }) {
    if (role !== 'sender' && role !== 'receiver') {
      throw new Error(`Session 的 role 只能是 sender 或 receiver（收到 ${role}）`)
    }
    this.role = role
    this.onEvent = onEvent ?? (() => {})
    this.phase = PHASE.WAITING

    // 一次性令牌：进 URL 的 ?k=，首次访问即作废
    this.token = randomBytes(16).toString('base64url')

    if (verifier) {
      this.verifier = verifier
      this.salt = salt ?? randomBytes(PARAMS.saltBytes)
    } else {
      this.salt = salt ?? randomBytes(PARAMS.saltBytes)
      this.verifier = deriveVerifier(password, this.salt)
    }
    this.keys = deriveKeys(this.verifier)
    this.roomId = roomId(this.keys)

    // 清单（加密后）随会话一起持有
    this.encManifest = encManifest
    this.manifestIv = manifestIv
    this.manifestTag = manifestTag

    this.challenge = null
    this.sid = null
    this.failures = 0
    this.tokenConsumed = false
    this.createdAt = Date.now()
    this.peer = null            // { address, userAgent, at }
    this.bytesSent = 0
    this.chunksSent = 0
  }

  /** 一次性令牌校验：首次通过后即作废 */
  consumeToken(token) {
    if (this.tokenConsumed) {
      throw new SessionError('这个链接已经被使用过了（一次性链接只允许访问一次）', 'TOKEN_USED')
    }
    if (typeof token !== 'string' || token.length !== this.token.length) {
      throw new SessionError('链接无效', 'TOKEN_INVALID')
    }
    // 常数时间比较，避免通过响应时间逐字节猜令牌
    const a = Buffer.from(token), b = Buffer.from(this.token)
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new SessionError('链接无效', 'TOKEN_INVALID')
    }
    this.tokenConsumed = true
    return true
  }

  /** 记录对端信息，供界面显示 */
  notePeer(req) {
    this.peer = {
      address: (req.socket?.remoteAddress ?? '').replace(/^::ffff:/, ''),
      userAgent: String(req.headers['user-agent'] ?? '').slice(0, 120),
      at: Date.now(),
    }
    this.onEvent({ type: 'peer-connected', peer: this.peer })
  }

  /**
   * 第 1 步：接收端索要参数。
   * 这个端点只认令牌 —— 此时还没有任何共享密钥，无法做别的认证。
   */
  sessionInfo() {
    if (this.phase === PHASE.DESTROYED) {
      throw new SessionError('会话已销毁', 'DESTROYED')
    }
    return {
      // 用套件层导出的那个 id，而不是在这里写一遍字面量 ——
      // 将来加套件时，只改套件层就不会漏掉这里（这个字段从前是硬编码的 'FLICKER/1'）
      suite: SUITE_ID,
      salt: this.salt.toString('base64'),
      room: this.roomId,
      // 认证前只给"清单的密文"，因为没有密钥就解不开 —— 连文件名都看不到
      manifest: {
        iv: this.manifestIv.toString('base64'),
        ct: this.encManifest.toString('base64'),
        tag: this.manifestTag.toString('base64'),
      },
      kdf: { name: PARAMS.kdf, iterations: PARAMS.iterations },
      chunkBytes: PARAMS.chunkBytes,
    }
  }

  /**
   * 第 2 步：发出挑战。
   * 这个端点无认证 —— 它存在的意义就是认证。
   *
   * 同时**报价**自己支持的握手 MAC 构造（降级保护，见 suite/flicker1.js 的 MAC_PROFILES）。
   * 这是**新增的可选字段**：老接收端不认识它就忽略，按 v1 算，行为与从前一致。
   */
  startAuth() {
    this._guardAlive()
    this.challenge = newChallenge()
    this.phase = PHASE.AUTH
    /** 这一次握手实际用了哪套构造（握手完成后可读） */
    this.macProfile = null
    return {
      challenge: this.challenge.toString('base64'),
      macProfiles: [...MAC_PROFILES],
    }
  }

  /**
   * 第 3 步：校验接收端的应答，并回送发送端的应答。
   * 这是"两台电脑密码必须一致"的落点：密码不同 → MAC 不同 → 这里拒绝。
   *
   * ⚠️ 这里同时是**降级检测**的落点（TLS 的 downgrade sentinel 是同一个思路）：
   *    · 回执 v2 → 双方用绑了 suite_id 的构造 ✓
   *    · 回执 v1，而**我明明报了 v2** → 报价在路上被动过手脚 → 直接失败（E_DOWNGRADE）
   *    · **根本没有回执** → 那是真的老对端（0.1.0 的页面不回执）→ 按 v1 继续，
   *      但把 `macProfile` 记下来，让上层**明确告警**（不假装安全）
   */
  finishAuth({ mac, challenge, macProfile }) {
    this._guardAlive()
    if (!this.challenge) throw new SessionError('还没有发起认证', 'NO_CHALLENGE')

    // 防止接收端自己换一个挑战来试探
    let ok = false
    try {
      const got = Buffer.from(String(challenge ?? ''), 'base64')
      ok = got.length === this.challenge.length && timingSafeEqual(got, this.challenge)
    } catch { ok = false }
    if (!ok) {
      this._fail('挑战不匹配（可能是重放尝试）')
      throw new SessionError('挑战不匹配', 'CHALLENGE_MISMATCH')
    }

    // 接收端回执的构造：必须是报价里的某一个；不认识的回执一律拒绝
    const echoed = typeof macProfile === 'string' ? macProfile : null
    if (echoed !== null && !MAC_PROFILES.includes(echoed)) {
      this._fail(`回执了不认识的握手构造：${echoed}`)
      throw new SessionError(`不认识的握手构造：${echoed}`, 'BAD_PROFILE')
    }
    const profile = echoed ?? 'v1'
    // 我报了 v2、对方却回执 v1 —— 报价被动过手脚（老对端不会回执）
    if (echoed === 'v1' && MAC_PROFILES.includes('v2')) {
      this._fail('对方回执了旧版握手构造（报价被篡改？）')
      throw new SessionError(
        '握手协商被篡改：我支持新版构造，对方却回执旧版 —— 已中止（可能是链路上的中间人）',
        'E_DOWNGRADE')
    }
    this.macProfile = profile

    // ⚠️ 方向由 role 决定，**不是**由"谁先说话"决定（见构造函数的说明）：
    //    · 我们是发送端 → 对端必须证明它是接收端（receiverMac），我们回 senderMac
    //    · 我们是接收端 → 对端必须证明它是发送端（senderMac），我们回 receiverMac
    //    两个方向分开算，防止把对方的应答原样打回去（反射）。
    const peerProves = this.role === 'receiver' ? senderMac : receiverMac
    const weProve = this.role === 'receiver' ? receiverMac : senderMac
    const expected = peerProves(this.keys.auth, this.challenge, { profile })
    let given
    try { given = Buffer.from(String(mac ?? ''), 'base64') } catch { given = Buffer.alloc(0) }

    if (!macEquals(expected, given)) {
      const fatal = this._fail('密码不一致')
      throw new SessionError(fatal
        // 最后一次失败必须把两件事一起说清："你密码错了" + "会话因此没了"。
        // 只说前者，手机界面会停在"再试一次"上，而那个会话已经不可能再通了。
        ? `密码不一致（已连续失败 ${this.failures} 次，达到上限，本次会话已销毁 —— 请在电脑上重新开始）`
        : '密码不一致', 'BAD_PASSWORD')
    }

    // 通过：生成会话 ID，回送我们自己的应答（证明我们也知道密码）
    this.sid = randomBytes(16).toString('base64url')
    this.phase = PHASE.READY
    this.onEvent({ type: 'authed', peer: this.peer })
    return {
      sid: this.sid,
      mac: weProve(this.keys.auth, this.challenge, { profile }).toString('base64'),
      macProfile: profile,
    }
  }

  /**
   * 这个会话还能不能用？不能用就抛出**能说明原因**的码。
   *
   * ⚠️ 顺序有意义：先看"是不是失败到上限"，再看"是不是已经销毁"。
   *    `_fail` 在到达上限时会顺手 `destroy()`，所以两个条件是同时成立的；
   *    反过来先看 DESTROYED 的话，手机第 6 次重试只会拿到笼统的"会话已销毁"，
   *    界面上就没法告诉用户"是你密码错了太多次，让电脑那边重新发起"。
   *    （页面的 i18n 里 TOO_MANY_FAILURES 本来就是这么写的，见 web/i18n-strings.mjs）
   */
  _guardAlive() {
    if (this.failures >= MAX_AUTH_FAILURES) {
      throw new SessionError('认证失败次数过多，会话已销毁', 'TOO_MANY_FAILURES')
    }
    if (this.phase === PHASE.DESTROYED) throw new SessionError('会话已销毁', 'DESTROYED')
  }

  /** @returns {boolean} 这一次失败是否把会话打死了（调用方据此把话说全） */
  _fail(why) {
    this.failures++
    this.onEvent({ type: 'auth-failed', why, failures: this.failures, max: MAX_AUTH_FAILURES })
    if (this.failures < MAX_AUTH_FAILURES) return false
    this.onEvent({ type: 'destroy-reason', reason: '认证失败次数过多' })
    this.destroy()
    return true
  }

  /** 校验会话 ID（清单与分块端点用） */
  requireSid(sid) {
    if (this.phase === PHASE.DESTROYED) throw new SessionError('会话已销毁', 'DESTROYED')
    if (this.phase !== PHASE.READY && this.phase !== PHASE.DONE) {
      throw new SessionError('尚未通过认证', 'NOT_AUTHED')
    }
    if (typeof sid !== 'string' || !this.sid) throw new SessionError('会话无效', 'NO_SID')
    const a = Buffer.from(sid), b = Buffer.from(this.sid)
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new SessionError('会话无效', 'BAD_SID')
    }
    return true
  }

  /** 记一笔已发送的量（供进度显示） */
  recordSent(bytes) {
    this.bytesSent += bytes
    this.chunksSent++
  }

  markDone() {
    if (this.phase === PHASE.READY) {
      this.phase = PHASE.DONE
      this.onEvent({ type: 'transfer-complete', bytes: this.bytesSent, chunks: this.chunksSent })
    }
  }

  /**
   * 销毁：清零所有密钥材料，让这个对象变得无用。
   * 这是"用完即销毁"的核心动作，必须在所有退出路径上被调用。
   */
  destroy() {
    if (this.phase === PHASE.DESTROYED) return
    wipe(this.verifier, this.salt,
      this.keys?.room, this.keys?.auth, this.keys?.enc,
      this.encManifest, this.manifestIv, this.manifestTag)
    for (const k of ['verifier', 'salt', 'challenge', 'sid', 'keys', 'encManifest', 'manifestIv', 'manifestTag']) {
      this[k] = null
    }
    this.token = null
    this.phase = PHASE.DESTROYED
    this.onEvent({ type: 'destroyed', at: Date.now() })
  }

  get destroyed() { return this.phase === PHASE.DESTROYED }
}

/** 统一错误响应体 */
export function errorBody(err) {
  const code = err instanceof SessionError ? err.code : 'INTERNAL'
  const status = {
    TOKEN_USED: 410, TOKEN_INVALID: 403,
    BAD_PASSWORD: 401, CHALLENGE_MISMATCH: 401, TOO_MANY_FAILURES: 410,
    NOT_AUTHED: 401, NO_SID: 401, BAD_SID: 401, NO_CHALLENGE: 400,
    DESTROYED: 410, NOT_FOUND: 404, RANGE: 416,
  }[code] ?? 500
  return { status, body: { error: code, message: err.message } }
}
