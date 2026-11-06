/**
 * 中继模式**网页发送端**的内核（纯浏览器 JS）
 * ============================================
 *
 * 从前"发送端"只能是那个 Node 程序（`bin/flicker.js send --relay=…`），因为
 * 它要读磁盘、要算哈希、要按接收端的确认节奏投递。手机上的浏览器做不到
 * "当服务端"，但**当中继的发送端**完全做得到 —— 这个文件就是把那件事做出来。
 *
 * ── 与另外几份实现的关系（别当成第四份就完事）───────────────
 * 密码学：直接用 `web/phone-core.js`（`globalThis.FlickerPhone`），它已经与 Node 侧
 *   `src/suite/flicker1.js` 做过分块/清单的逐字节比对。这份文件**不重新实现密码学**。
 * 流程控制：窗口规划的逻辑与 `src/relay/core.js` 的 `planWindow()` 同一套规则
 *   （投递量=空位、不足半窗先问状态、窗口是硬上限）。纯函数那份是给 Node 用的；
 *   这里因为要被内联进页面，只能写成同样的规则 —— `test/sender-page-inline.test.js`
 *   与 `_lab/e2e-relay-page-sender.mjs` 会盯住两边行为一致。
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

  /** 消息类型（与 `src/relay/protocol.js` 的 MSG 一致） */
  const MSG = { MANIFEST: 0x01, CHUNK: 0x02 }
  /** 协议保证的**最小**单条上限（1 MiB 明文 + 1 字节类型 + 16 字节 tag） */
  const MIN_MESSAGE = (1 << 20) + 17
  /** 分块上限：比它更大没有收益（见 src/chunk-size.js 的实测） */
  const MAX_CHUNK = 4 << 20
  /** 清单最多拆成几条（与 src/relay/protocol.js 的 MAX_MANIFEST_PARTS 一致） */
  const MAX_MANIFEST_PARTS = 1024

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

  /** 一批消息：`[len(4, 大端) | 内容] × N` —— 长度前缀比分隔符安全（密文里什么字节都可能有） */
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
   * 清单分帧（P1-2）——与 `src/relay/protocol.js` 的 packManifestParts
   * 以及网页接收端**逐字节一致**，三处任何一处改动都必须同步。
   *
   *   第 i 条（占 seq=i）= BE32(i) || BE32(partCount) || M.slice(i*partSize, …)
   *   这条消息**不带**类型字节（类型字节在 M 的第一字节里）。
   *   M 就是原来那条完整清单消息，序列化方式不变。
   */
  function packManifestParts(manifestMessage, maxMessageBytes) {
    const max = Number.isInteger(maxMessageBytes) && maxMessageBytes > 9 ? maxMessageBytes : 9
    const partSize = max - 8
    const partCount = Math.max(1, Math.ceil(manifestMessage.length / partSize))
    if (partCount > MAX_MANIFEST_PARTS) {
      throw Object.assign(new Error(
        `清单太大：${manifestMessage.length} 字节需要拆成 ${partCount} 条（上限 ${MAX_MANIFEST_PARTS} 条），` +
        '请减少文件数量后分批发送'), { code: 'MANIFEST_TOO_LARGE' })
    }
    const out = []
    for (let i = 0; i < partCount; i++) {
      const start = i * partSize
      const end = Math.min(manifestMessage.length, start + partSize)
      const msg = new Uint8Array(8 + (end - start))
      const dv = new DataView(msg.buffer)
      dv.setUint32(0, i)
      dv.setUint32(4, partCount)
      msg.set(manifestMessage.subarray(start, end), 8)
      out.push(msg)
    }
    return out
  }

  /**
   * 这一轮该不该投、投多少（与 `src/relay/core.js` 的 planWindow 同一规则）。
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
      this.base = String(relayUrl || '').replace(/\/+$/, '')
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
      /** 中继声明的单条消息上限（清单分帧按它切） */
      this.maxMessageBytes = MIN_MESSAGE
      /** 清单被拆成了几条（数据块从 seq = manifestParts 开始） */
      this.manifestParts = 1
      /**
       * 正在飞的那一批投递（与 Node 端 `client._inFlight` 同一个理由）：
       * `stop()` 里的 DELETE 若不先等它，就会与在途 POST 抢同一个房间 ——
       * 服务端先删、后到的 POST 拿 404，一次正常的"取消"被报成中继错误。
       */
      this._inFlight = null
    }

    /** 本次传输的总消息数（清单分片 + 数据块） */
    get totalMessages() {
      return this.manifestParts + (this.manifest?.totalChunks ?? 0)
    }

    _emit(e) { try { this.onEvent(e) } catch { /* 回调里的异常不能影响传输 */ } }

    _sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

    /** 一次请求；只对**瞬时**故障重试（与 core.js 的 isTransientError 同一判据） */
    async _fetch(url, init = {}) {
      const out = await fetch(url, init)
      if (!out.ok) {
        let code = `HTTP_${out.status}`, message = `中继返回 ${out.status}`
        try { const j = await out.json(); code = j.error ?? code; message = j.message ?? message } catch { /* 非 JSON */ }
        const e = new Error(`中继错误：${message}`)
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
        'ROOM_TAKEN', 'ROOM_FULL', 'ROOM_QUOTA', 'STORE_FULL', 'MANIFEST_TOO_LARGE',
        'SEQ_DESYNC']
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
        const r = await this._fetch(`${this.base}/health`)
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
      // 清单分帧也按这个上限切（创建响应里若声明得更小，下面还会校正）
      this.maxMessageBytes = cap
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
        const r = await this._fetch(`${this.base}/r/${this.room}`, { method: 'POST' })
        return r.json()
      })
      if (Number.isInteger(created.maxMessageBytes) && created.maxMessageBytes > 0) {
        // 创建响应里的声明更权威：块大小已经算过，这里只在必要时再收紧一次
        this.maxMessageBytes = created.maxMessageBytes
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

      // ── 清单分帧（P1-2，与 Node 发送端/接收端逐字节一致）──
      // M 是原来那条完整清单消息；按中继声明的单条上限切成 N 条。
      // 注意：**一条都不例外**，清单很小也会带 8 字节分片头（partCount=1），
      // 这样接收端只有一种格式要处理。
      // ⚠️ 这里必须存**条数**（.length），不是分片数组本身：
      //    后面的 totalMessages / 数据块序号偏移都要拿它做算术。
      const parts = packManifestParts(this.manifestMessage, this.maxMessageBytes)
      this.manifestParts = parts.length

      if (created.created) {
        await this._putManifestParts(parts)
      } else {
        // 房间已存在：空房间 = 我们的创建响应丢了（补投清单）；非空 = 别人占了这个名字
        const st = await this._withRetry('status', () => this._status())
        if (st.nextSeq > 0) {
          throw Object.assign(new Error(
            '这个会话的房间名已经被占用了 —— 房间里已经有别人的消息。请换一个密码重新开始。'),
          { code: 'ROOM_TAKEN' })
        }
        await this._putManifestParts(parts)
      }

      const st = await this._withRetry('status', () => this._status())
      this.posted = st.nextSeq
      this.ackedBase = st.ackedBase
      this.bytesPosted = 0

      this._emit({ type: 'ready', link: this.link(), total: this.totalMessages,
        bytes: this.manifest.totalBytes, files: this.files.length })
      return this.link()
    }

    link() {
      // 盐放在 fragment：浏览器不把它发给服务器，中继看不到
      return `${this.base}/#k=${this.room}&s=${P.hex(this.salt)}`
    }

    async _status() {
      const r = await this._fetch(`${this.base}/r/${this.room}`)
      return r.json()
    }

    async _put(seq, message) {
      // 也记入 _inFlight：取消可能发生在投清单阶段（start() 里），
      // stop() 的 DELETE 必须先等它落定，否则会抢同一个房间。
      const p = this._fetch(`${this.base}/r/${this.room}?seq=${seq}`, { method: 'POST', body: message })
      this._inFlight = p
      try { await p } finally { this._inFlight = null }
    }

    /** 按序投递所有清单分片（seq = 0..parts.length-1） */
    async _putManifestParts(parts) {
      for (let i = 0; i < parts.length; i++) {
        await this._putManifestPart(i, parts[i])
      }
    }

    /**
     * 投递一个清单分片，并在重试/撞 409 时先对齐服务端（P2-1）。
     *
     * 旧行为是"重试仍然是 POST ?seq=0"：第一次已落库、响应丢了时，
     * 重发会撞 409 BAD_SEQ（不可重试）→ 整次传输在开局失败。
     * 判据与 Node 端一致：服务端 nextSeq 是唯一权威（i+1 = 已落库，i = 重发）。
     */
    async _putManifestPart(i, part) {
      const wantNext = i + 1
      try {
        await this._withRetry('manifest', async (attempt) => {
          if (attempt > 0) {
            const st = await this._status().catch(() => null)
            if (st) {
              if (st.nextSeq === wantNext) return
              if (st.nextSeq !== i) throw this._desyncErr(i, st.nextSeq)
            }
          }
          await this._put(i, part)
        })
      } catch (e) {
        if (e.code !== 'BAD_SEQ') throw e
        const st = await this._status().catch(() => null)
        if (st && st.nextSeq === wantNext) return
        if (st && st.nextSeq !== i) throw this._desyncErr(i, st.nextSeq)
        throw e
      }
    }

    _desyncErr(expectedNext, actualNext) {
      return Object.assign(new Error(
        `清单投递序号错乱：期望 nextSeq=${expectedNext}，服务端是 ${actualNext}`),
      { code: 'SEQ_DESYNC' })
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

    /** 清单的**线上形式**（字段与 `src/manifest.js` 的 toWire 一致） */
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
      throw new Error(`分块序号无法定位: ${ordinal}`)
    }

    /** 一批投递：把 [startSeq, startSeq+count) 逐块加密、包成 batch 发出去 */
    async _putBatch(startSeq, count) {
      const total = this.totalMessages
      const items = []
      const meta = []
      for (let i = 0; i < count; i++) {
        if (this.stopped) throw Object.assign(new Error('已取消'), { code: 'ABORTED' })
        const seq = startSeq + i
        if (seq >= total) break
        // 数据块全局序号从清单分片之后开始（旧协议写死 -1）
        const { file, chunkIndex, plainLen } = this._locate(seq - this.manifestParts)
        const off = chunkIndex * file.chunkBytes
        const plain = new Uint8Array(await file._file.slice(off, off + plainLen).arrayBuffer())
        if (plain.length !== plainLen) {
          throw new Error(`文件在传输过程中被改动（${file.rel} 第 ${chunkIndex} 块）`)
        }
        const { ct, tag } = await P.sealChunk(this.encKey, file.index ?? this._indexOf(file),
          chunkIndex, file.chunks, plain)
        items.push(packMessage(MSG.CHUNK, concatAll([tag, ct])))
        meta.push({ seq, fileIndex: file.index ?? this._indexOf(file), chunkIndex, bytes: plainLen, fileName: file.rel })
      }
      if (!items.length || this.stopped) return { chunks: [], aborted: true }

      const body = packBatch(items)
      const wantNext = startSeq + items.length
      const sendOnce = async () => {
        // 记录在途请求：stop()/destroy() 发 DELETE 前必须先等它结束，
        // 否则 DELETE 会与这条 POST 抢同一个房间（正常的取消会被报成 404）。
        const p = this._fetch(`${this.base}/r/${this.room}/batch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body,
        })
        this._inFlight = p
        try { return await p } finally { this._inFlight = null }
      }
      let landed = null
      const r = await this._withRetry('batch', async (attempt) => {
        if (attempt > 0 && !landed) {
          // 重试前先确认上一次到底落库没有：服务端 nextSeq 是唯一权威
          const st = await this._status().catch(() => null)
          const n = st?.nextSeq
          if (n === wantNext) { landed = st; return null }
          if (Number.isInteger(n) && n !== startSeq) {
            throw Object.assign(new Error(`投递序号错乱：期望 nextSeq=${startSeq}，服务端是 ${n}`),
              { code: 'SEQ_DESYNC', status: 0, cause: null })
          }
        }
        return sendOnce()
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
     * ⚠️ 完成判据是 `ackedBase >= total`，不是"我投完了"。"我发完了"不等于"对方收完了"，
     *    这条在 Node 侧踩过（实测 posted=6/total=6/pending=0 而 ackedBase=5 → 误报完成）。
     */
    async run({ timeoutMs = 15 * 60 * 1000 } = {}) {
      const total = this.totalMessages
      let idleSince = Date.now()
      let idleRounds = 0
      let lastAcked = this.ackedBase
      let lastPosted = this.posted

      try {
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
        // 需要新 ack（或这一轮没投）时才问状态 —— 这是唯一会等一个往返的地方。
        // ⚠️ P1-4：状态轮询也走重试；一次瞬时 5xx/网络抖动不该废掉整次传输。
        if (!sentSomething || Math.max(0, this.windowSize - (this.posted - this.ackedBase)) === 0) {
          const st = await this._withRetry('status', () => this._status())
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
          // ⚠️ P1-1：没有新数据可投时也必须等 pollMs（与 Node 端同一修法）。
          //    旧条件只判"窗口满"，于是数据全投完、在等最后几个 ack 时会以
          //    往返速度死循环 status（浏览器标签页 CPU 打满、中继免费额度烧光）。
          if (!sentSomething ||
              Math.max(0, this.windowSize - (this.posted - this.ackedBase)) === 0) {
            await this._sleep(this.pollMs)
          }
        }
        if (this.posted >= total && this.ackedBase >= total) {
          this._emit({ type: 'complete', posted: this.posted, bytes: this.bytesPosted })
          return { ok: true, posted: this.posted }
        }
      }
      } catch (e) {
        // 取消是**正常结束路径**，run() 绝不能 reject —— 页面的 .catch 会把它
        // 显示成红色"出错了：已取消"，盖掉刚显示的正确提示（P2-6）。
        const aborted = (e && e.code === 'ABORTED') ||
          (this.stopped && e &&
            (e.code === 'NO_ROOM' || e.code === 'EXPIRED' || e.status === 404 || e.status === 410))
        if (!aborted) throw e
        this._emit({ type: 'incomplete', reason: 'aborted', posted: this.posted,
          ackedBase: this.ackedBase, total })
        return { ok: false, reason: 'aborted' }
      }
      this._emit({ type: 'incomplete', reason: 'aborted', posted: this.posted,
        ackedBase: this.ackedBase, total })
      return { ok: false, reason: 'aborted' }
    }

    /** 用户取消：停循环 + 删房间（房间没了，链接立即失效） */
    async stop() {
      this.stopped = true
      // 先等在途的 /batch 落定，再 DELETE —— 否则两个请求抢同一个房间，
      // 一次正常的取消会以 NO_ROOM 的形式冒出来（Node 端已修过同一个竞态）。
      if (this._inFlight) await this._inFlight.catch(() => {})
      try {
        await this._fetch(`${this.base}/r/${this.room}`, { method: 'DELETE' })
      } catch { /* 已经没了就算了 */ }
      // 清掉密钥（清不掉 JS 字符串里的密码副本，这点在文档里如实写了）
      try { this.keys?.enc?.fill?.(0) } catch { /* 不可写就算了 */ }
    }

    /** 传完后销毁房间（与 stop 的区别只是语义：正常完成 vs 取消） */
    async destroy() {
      if (this._inFlight) await this._inFlight.catch(() => {})
      try {
        await this._fetch(`${this.base}/r/${this.room}`, { method: 'DELETE' })
        return true
      } catch { return false }
    }
  }

  globalThis.FlickerSender = { Sender, planWindow, packMessage, packBatch, MSG, MIN_MESSAGE, MAX_CHUNK }
})()
