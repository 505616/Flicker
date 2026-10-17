/**
 * 中继客户端（发送端用）
 * ======================
 * 把"发送端"接到中继上：创建房间、按需投递密文消息、销毁房间。
 *
 * ── 传输模型：拉取式 ────────────────────────────────────────
 * 中继是一个**按序号的信箱**，不是流。所以：
 *
 *    seq 0        清单（含 salt、加密的文件列表）—— 房间一建立就放进去
 *    seq 1..N     依次是各个文件分块的密文
 *
 * 分块**按需投递**：发送端先只放清单，然后根据房间里"已经涨到几号"
 * 来决定下一步投哪一块。这样：
 *   · 发送端内存恒定（不为整份文件排队）
 *   · 接收端慢的时候，发送端自然停下来等，不会被撑爆
 *   · 中继上任何时刻只有少量在途密文
 *
 * 所有内容在出门之前就已经加密（见 suite/flicker1.js 与 server.js 的 sealChunk），
 * 所以中继拿到的一律是密文。
 */
import { open } from 'node:fs/promises'
import { sealChunk, PARAMS } from '../suite/flicker1.js'
import { packMessage, packBatch, MSG } from './protocol.js'

/**
 * 被主动中止（用户点了取消、或程序要退出）。
 * 单独一个类是为了让调用方能区分"正常中止"与"真的出错" ——
 * 前者不该在屏幕上冒出一句吓人的报错。
 */
export class RelayAborted extends Error {
  constructor(where) {
    super(`中继操作已被中止（${where}）`)
    this.name = 'RelayAborted'
    this.code = 'ABORTED'
  }
}

/**
 * 判定一个错误值不值得重试。
 *
 * ⚠️ 只重试**瞬时**故障（网络抖动、超时、5xx、429）。
 *    其余一律不重试，因为重试也不会变好，只会拖长用户等待：
 *      NO_ROOM / EXPIRED / GONE → 房间真没了
 *      BAD_SEQ / TOO_LARGE / BAD_ROOM_ID / EMPTY_* → 请求本身有问题
 *      ABORTED → 用户点了取消
 *
 * 判断网络类错误靠 err.name / err.code（fetch 抛的是 TypeError("fetch failed")，
 * 其 cause 里可能是 ECONNRESET / ENOTFOUND / UND_ERR_* 等）。
 */
export function isTransientError(e, status) {
  // HTTP 层面：5xx 与 429 值得重试。
  // ⚠️ 这一条**必须排在前面**：调用方可能直接用状态码问
  //    （isTransientError(null, 503)），此时没有错误对象可查。
  if (typeof status === 'number') return status >= 500 || status === 429
  if (!e) return false
  if (e.code === 'ABORTED' || e.name === 'RelayAborted') return false
  // 协议层面：明确不可恢复的，不重试
  const fatal = ['NO_ROOM', 'EXPIRED', 'GONE', 'NOT_YET', 'BAD_SEQ', 'BAD_ROOM_ID',
    'TOO_LARGE', 'BAD_BODY', 'EMPTY_BODY', 'EMPTY_BATCH', 'BATCH_TOO_LARGE', 'BAD_BATCH']
  if (typeof e.code === 'string' && fatal.includes(e.code)) return false
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return true
  if (e.name === 'TypeError') return true                 // fetch 的网络层失败
  const cause = e.cause?.code ?? e.cause?.name
  if (typeof cause === 'string') return true              // ECONNRESET / UND_ERR_SOCKET …
  return false
}

export class RelayClient {
  /**
   * @param {object} o
   * @param {string} o.baseUrl 中继地址，例如 https://flicker.you.workers.dev
   * @param {string} o.roomName 房间名（64 位十六进制，由密码经 HKDF 派生）
   * @param {Buffer} o.encKey 加密密钥（K_enc）
   * @param {object} o.manifest 内部清单（含 absPath / _bytes，服务端形式）
   * @param {number} [o.fetchTimeoutMs] 单次请求超时
   * @param {number} [o.retries] 瞬时故障的重试次数（默认 4）
   * @param {(info:object)=>void} [o.onRetry] 每次重试前的回调，用于告诉用户"正在重连"
   * @param {() => number} [o.now] 注入时钟，便于测试
   * @param {(ms:number)=>Promise<void>} [o.sleep] 注入等待，便于测试
   */
  constructor({
    baseUrl, roomName, encKey, manifest, fetchTimeoutMs = 30_000,
    retries = 4, onRetry, now, sleep,
  }) {
    this.base = baseUrl.replace(/\/+$/, '')
    this.room = roomName
    this.encKey = encKey
    this.manifest = manifest
    this.timeout = fetchTimeoutMs
    this.retries = retries
    this.onRetry = onRetry ?? (() => {})
    this._now = now ?? (() => Date.now())
    this._sleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    /** 已经投递到中继的消息条数（含清单那条） */
    this.posted = 0
    this.bytesPosted = 0
    /**
     * 正在飞的那一批投递（没有则为 null）。
     *
     * 存在的理由是一个**真实踩到的竞态**：
     *   putBatch 在 `await _readChunk(...)` 处会让出控制权，
     *   如果此刻有人调用 destroy()，DELETE 可能**先于**那条 batch POST
     *   到达服务端 —— 房间被删掉，随后发出的 POST 拿到 404"房间不存在"。
     *   表现是：用户点"取消"这种正常操作，屏幕上却冒出中继报错。
     * 所以 destroy() 必须先把这一批等完，再删房间。
     */
    this._inFlight = null
    /** 累计重试次数（供 UI 显示"链路不稳，已自动重连 N 次"） */
    this.retryCount = 0
    /**
     * 中继声明的单条消息上限（能力协商的结果）。`null` = 对方没声明。
     *
     * 它决定"能发多大的块"：一条消息就是一块。老中继不声明 → 调用方按
     * 协议保证的最小值（1 MiB + 17）走，于是新客户端 + 老中继也不会坏。
     */
    this.maxMessageBytes = null
    // 读文件的常驻缓冲：按**清单里实际用到的最大块**分配，不能写死协议默认值。
    // 写死的话，块比默认值大时 `fh.read(this._buf, 0, file.chunkBytes, …)` 读不满，
    // 下面那句 `bytesRead !== plainLen` 会把它当成"文件在传输过程中被改动" ——
    // 报错信息指向文件，而真正的原因在缓冲区大小。
    // （局域网那侧是同一个坑的第二处，见 src/server.js。）
    this._buf = Buffer.allocUnsafe(Math.max(PARAMS.chunkBytes,
      ...(manifest?.files ?? []).map((f) => Number(f.chunkBytes) || 0)))
  }

  _url(suffix = '') {
    return `${this.base}/r/${this.room}${suffix}`
  }

  async _fetch(url, init = {}) {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(this.timeout) })
    if (!r.ok) {
      let code = `HTTP_${r.status}`, message = `中继返回 ${r.status}`
      try { const j = await r.json(); code = j.error ?? code; message = j.message ?? message } catch { /* 非 JSON */ }
      const e = new Error(`中继错误：${message}`)
      e.code = code
      e.status = r.status
      throw e
    }
    return r
  }

  /**
   * 带**指数退避**的重试包装。
   *
   * 为什么必须区分"值不值得重试"：网络抖动重试一下就好；
   * 而"房间不存在"重试一万次也不会变出来，只会让用户白等。
   * 判据见 isTransientError()。
   *
   * 退避：300ms、600ms、1200ms…（上限 8s）＋ 随机抖动，避免多个请求同时回来再撞一次。
   *
   * @param {string} label 日志/回调里显示的用途，例如 'batch'
   * @param {(attempt:number) => Promise<any>} fn 收到尝试序号（0 为首次）。
   *   调用方据此决定"重试前要不要先确认上一次是否其实已经成功"。
   */
  async _withRetry(label, fn) {
    let lastErr = null
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return await fn(attempt)
      } catch (e) {
        lastErr = e
        if (!isTransientError(e, e.status)) throw e
        if (attempt === this.retries) break
        // 300ms 起，每次翻倍，封顶 8s，再加 0–250ms 抖动
        const backoff = Math.min(300 * 2 ** attempt, 8000)
        const waitMs = backoff + Math.floor(Math.random() * 250)
        this.retryCount++
        this.onRetry({
          label, attempt: attempt + 1, max: this.retries,
          waitMs, code: e.code ?? e.name ?? 'NETWORK', message: e.message,
        })
        await this._sleep(waitMs)
      }
    }
    throw lastErr
  }

  /**
   * 建立房间并放入清单（幂等：重连不会丢已放进去的消息）。
   *
   * ⚠️ 进度的权威来源是**服务端的 nextSeq**，不是本地计数。
   *    最初这里用本地 `posted` 推着走，一旦两者不一致（重连、并发、或
   *    某次请求的响应没读到），下一个分块就会和中继的期望序号对不上，
   *    报"序号不连续：期望 0，收到 1"。这类不一致在自己维护计数器时
   *    迟早会发生 —— 所以每次 open 都从服务端对齐。
   */
  async open(manifestMessage) {
    const created = await this._withRetry('open',
      async () => (await this._fetch(this._url(), { method: 'POST' })).json())

    // 中继声明的"一条消息最多收多大"（= 最大的块）。老中继没有这个字段，
    // 这里就记成 null，由调用方回落到协议保证的最小值。
    if (Number.isInteger(created.maxMessageBytes) && created.maxMessageBytes > 0) {
      this.maxMessageBytes = created.maxMessageBytes
    }

    if (created.created) {
      await this._withRetry('manifest', () => this._put(0, manifestMessage))
    } else {
      // ⚠️ 房间已经存在。这里有**两种完全相反**的可能，必须分开处理 ——
      //    从前一律当"自己的房间"跳过投递，于是两种情况都会**静默失败**：
      //
      //    ① **是我们自己建的，只是创建响应在回程丢了**（网络抖动、代理超时）。
      //       此时房间是**空的**（nextSeq === 0），清单一条都没投出去。
      //       旧行为：跳过投递 → 接收端永远等不到 seq 0 → 两分钟后报"等不到了"。
      //       而用户已经把链接发出去了。实测复现过（见下面的测试）。
      //    ② **别人抢先占用了这个房间名**。房间名虽然不可猜测，
      //       但它**就在链接里**（64 hex）—— 拿到链接、没拿到密码的人
      //       不需要猜就能抢占。此时房间里已经有别人的东西。
      //
      //    判据就是"房间里有没有东西"：空 = 情况 ①（补投清单），
      //    非空 = 情况 ②（中止，并说清是什么事）。
      const st = await this._withRetry('status', () => this.status())
      if (st.nextSeq > 0) {
        // 用与本文件其它错误一致的形式（Error + code），不引入新的错误类 ——
        // `code` 会被上层拿去查文案表，也是 isTransientError 的判据。
        // ROOM_TAKEN 不在可重试名单里（重试一万次房间也还是别人的）。
        const e = new Error(
          '这个会话的房间名已经被占用了 —— 房间里已经有别人的消息。\n' +
          '    房间名是由密码派生出来的，而它就在链接里；拿到链接的人可以抢先占用，' +
          '对方就打不开你的链接了。\n' +
          '    请**重新启动**一次发送（会生成新的房间名与链接），' +
          '并把链接与密码**分开**告诉对方。')
        e.code = 'ROOM_TAKEN'
        throw e
      }
      await this._withRetry('manifest', () => this._put(0, manifestMessage))
    }

    // 无论新旧房间，都以服务端状态为准
    const st = await this._withRetry('status', () => this.status())
    this.posted = st.nextSeq
    this.ackedBase = st.ackedBase
    this.bytesPosted = 0
    return created
  }

  async _put(seq, message) {
    await this._fetch(this._url(`?seq=${seq}`), { method: 'POST', body: message })
  }

  /** 把清单打包成消息（salt + 加密清单 一起放，接收端一次就能拿到全部参数） */
  static packManifest({ salt, iv, tag, ct }) {
    return packMessage(MSG.MANIFEST, Buffer.concat([salt, iv, tag, ct]))
  }

  /**
   * 投递一条分块消息。
   *
   * @param {number} [explicitSeq] 要投递的序号。**由调用方指定**，不再自己去读状态 ——
   *   这是流水线投递的关键：原来每次投递前都先读一次房间状态，
   *   那是**每条消息两个往返**，流水线就白做了。
   *   不传时退回旧行为（自己读一次状态），方便单独调用。
   * @param {object} [opts]
   * @param {() => boolean} [opts.isAborted]
   * @returns {Promise<{seq:number, fileIndex:number, chunkIndex:number, bytes:number}|null>}
   *   返回 null 表示全部投递完毕
   */
  async pumpOne(explicitSeq, { isAborted } = {}) {
    // 参数兼容：pumpOne({ isAborted }) 这种旧写法也要能用
    if (explicitSeq !== null && typeof explicitSeq === 'object') {
      isAborted = explicitSeq.isAborted
      explicitSeq = undefined
    }

    let seq
    if (Number.isInteger(explicitSeq)) {
      seq = explicitSeq
      // ⚠️ **不要**在这里改 this.posted。
      //    调用方（RelaySender）在并发投递时自己管理序号；
      //    这里动它会让并发的序号计算互相打架 —— 实测表现为
      //    "序号不连续：期望 2，收到 4"。
      //    投递成功后把 posted 推进到 seq+1（取最大值，避免并发回退）。
      this._bumpPosted = seq + 1
      // ⚠️ 这个检查必须在**真正发请求之前**。
      //    中止（用户点取消）可能发生在 await 的间隙里，
      //    此时房间已经被销毁，再投递就会得到一句"序号不连续"的报错 ——
      //    用户看到的是取消之后突然冒出的错误。
      if (isAborted?.()) throw new RelayAborted('投递前检查')
    } else {
      // 旧路径：自己读一次服务端进度
      const st = await this.status()
      if (isAborted?.()) throw new RelayAborted('投递前检查')
      this.posted = st.nextSeq
      this.ackedBase = st.ackedBase
      seq = this.posted
      this._bumpPosted = undefined
    }

    // ── 并发投递时序号会撞车，这里要能自愈 ──────────────────
    //
    // 中继要求**严格按序**投递（seq 必须等于它期望的下一个）。
    // 但流水线投递会同时发出多条请求，它们到达中继的顺序不保证 ——
    // 于是必然有请求撞上 409 BAD_SEQ。
    //
    // 处理方式：遇到 409 就取一次服务端进度，按它给的下一个序号**重新投递**。
    // 这是安全的，因为消息内容是**按 seq 定位的**（seq 决定用哪个文件的哪一块、
    // 以及 IV/AAD 里的坐标），所以"换一个序号"等于换一条不同的消息来发，
    // 而不是把同一条消息重复投递。
    //
    // 代价：每撞一次多一次往返。窗口 8 时通常只有少数几条会撞，
    // 对总体吞吐影响很小。
    const attempt = async (trySeq) => {
      const ordinal = trySeq - 1
      const { file, chunkIndex, plainLen } = this._locate(ordinal)
      const payload = await this._readChunk(file, chunkIndex, plainLen)
      const { ct, tag } = sealChunk(this.encKey, file.index, chunkIndex, file.chunks, payload.plain)
      if (payload.release) await payload.release()
      const packed = packMessage(MSG.CHUNK, Buffer.concat([tag, ct]))
      await this._put(trySeq, packed)
      return { seq: trySeq, fileIndex: file.index, chunkIndex, bytes: plainLen, fileName: file.rel }
    }

    const total = 1 + this.manifest.totalChunks
    if (seq >= total) return null

    let result = null
    try {
      result = await attempt(seq)
    } catch (e) {
      if (e.code !== 'BAD_SEQ') throw e
      // 撞车了：以服务端为准，按它期望的序号重投
      const st = await this.status()
      this.ackedBase = st.ackedBase
      if (st.nextSeq >= total) return null
      result = await attempt(st.nextSeq)
      this._bumpPosted = st.nextSeq + 1
    }
    if (this._bumpPosted !== undefined) {
      this.posted = Math.max(this.posted, this._bumpPosted)
      this._bumpPosted = undefined
    }
    this.bytesPosted += result.bytes
    return result
  }

  /** 读出一个分块的明文（内存里的赠品包，或磁盘上现读） */
  async _readChunk(file, chunkIndex, plainLen) {
    if (file._bytes) {
      const slice = file._bytes.subarray(
        chunkIndex * file.chunkBytes,
        Math.min((chunkIndex + 1) * file.chunkBytes, file._bytes.length))
      return { plain: slice, release: null }
    }
    const fh = await open(file.absPath, 'r')
    try {
      const { bytesRead } = await fh.read(this._buf, 0, file.chunkBytes, chunkIndex * file.chunkBytes)
      if (bytesRead !== plainLen) {
        throw new Error(
          `文件在传输过程中被改动（${file.rel} 第 ${chunkIndex} 块：` +
          `期望 ${plainLen} 字节，实读 ${bytesRead}）`)
      }
    } catch (e) { await fh.close(); throw e }
    return {
      plain: this._buf.subarray(0, plainLen),
      release: async () => { await fh.close(); this._buf.subarray(0, plainLen).fill(0) },
    }
  }


  /** 全局分块序号 → (文件, 文件内块号, 明文长度) */
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

  /**
   * 一次投递一批分块（从 startSeq 开始，连续 windowSize 条）。
   *
   * 序号由**服务端**按到达顺序分配，所以并发投递不会撞车 ——
   * 这是流水线能与"严格按序"共存的唯一干净解法。
   *
   * @param {number} startSeq 这一批的起始序号
   * @param {number} count 投几条
   * @param {() => boolean} [isAborted] 中止判据。每一轮循环都问一次 ——
   *   读取分块是异步的（`await _readChunk`），这中间足以发生一次 destroy()。
   *   问过之后再决定要不要把密文发出去，才能保证"取消之后就真的不再发"。
   * @returns {Promise<{seqs:number[], chunks:Array}>}
   */
  async putBatch(startSeq, count, { isAborted } = {}) {
    const total = 1 + this.manifest.totalChunks
    const items = []
    const meta = []
    for (let i = 0; i < count; i++) {
      // 每一轮都重新问一次：上面的 await 可能已经让 destroy() 插进来了
      if (isAborted?.()) return { seqs: [], chunks: [], aborted: true }
      const seq = startSeq + i
      if (seq >= total) break
      const ordinal = seq - 1
      const { file, chunkIndex, plainLen } = this._locate(ordinal)
      const payload = await this._readChunk(file, chunkIndex, plainLen)
      try {
        const { ct, tag } = sealChunk(this.encKey, file.index, chunkIndex, file.chunks, payload.plain)
        items.push(packMessage(MSG.CHUNK, Buffer.concat([tag, ct])))
        meta.push({ fileIndex: file.index, chunkIndex, bytes: plainLen, fileName: file.rel })
        this.bytesPosted += plainLen
      } finally {
        await payload.release?.()
      }
    }
    // 最后一道闸：发给中继之前再确认一次（上面最后一次 release 也可能让出）
    if (!items.length || isAborted?.()) return { seqs: [], chunks: meta, aborted: true }

    // ── 重试的歧义，以及为什么可以安全解决 ──────────────────────
    //
    // ⚠️ batch POST 失败时**无法直接判断它到底落库没有**：
    //    请求可能已经在服务端成功，只是响应在回程丢了。
    //    盲目重发会在房间尾部多出一批重复消息 —— 接收端会白取一遍。
    //
    //    好在协议给了现成的判据：**序号由服务端分配**（nextSeq）。
    //    所以每次重试前先读一次状态：
    //      · nextSeq 已经涨到 startSeq + items.length  → 说明确实落库了，
    //        直接当作成功返回（补上 bytesPosted 的记账）；
    //      · nextSeq 没涨（还是 startSeq）             → 没落库，安全重发；
    //      · 涨到别处（不该发生，说明有并发写）        → 报错，别猜。
    //
    //    这条"服务端分配序号"的设计当初是为了解决并发撞车，
    //    在这里又额外买到一次"重试幂等"。
    const body = packBatch(items)
    const wantNext = startSeq + items.length

    const sendOnce = async () => {
      this._inFlight = this._fetch(this._url('/batch'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body,
      })
      try {
        return await this._inFlight
      } finally {
        this._inFlight = null
      }
    }

    let landed = null            // 上一次尝试"其实已经成功"时的状态读数
    try {
      const r = await this._withRetry('batch', async (attempt) => {
        // 重试（attempt > 0）之前先确认上一次到底落库没有
        if (attempt > 0 && !landed) {
          const st = await this.status().catch(() => null)
          if (st && st.nextSeq === wantNext) { landed = st; return null }
          if (st && st.nextSeq !== startSeq) {
            const e = new Error(
              `投递序号错乱：期望 nextSeq=${startSeq}，服务端是 ${st.nextSeq}`)
            e.code = 'SEQ_DESYNC'
            throw e
          }
        }
        return sendOnce()
      })
      const j = landed ?? await r.json()
      this.posted = Math.max(this.posted, j.nextSeq)
      this.ackedBase = j.ackedBase
      return { seqs: j.seqs ?? [], chunks: meta }
    } catch (e) {
      // 这一批彻底失败 —— 已经算进 bytesPosted 的字节要退回去，
      // 否则进度条会显示一个永远到不了的数字
      for (const m of meta) this.bytesPosted -= m.bytes
      throw e
    }
  }

  /** 房间状态（接收端确认了多少、涨到几号了） */
  async status() {
    const r = await this._fetch(this._url())
    return r.json()
  }

  /** 销毁房间（用完即销毁的落点） */
  async destroy() {
    // ⚠️ 先把**在飞的那一批**等完，再删房间。
    //    不等的话，DELETE 会与那条 batch POST 抢同一个房间：
    //    服务端先处理 DELETE，后到的 POST 就报 404"房间不存在"——
    //    一次正常的取消会被报成中继错误。
    //    这里只等、不抛：那一批本身失败与否由 run() 决定。
    if (this._inFlight) await this._inFlight.catch(() => {})
    try {
      await this._fetch(this._url(), { method: 'DELETE' })
      return true
    } catch { return false }
  }

  /** 中继上的接收端页面地址（把它发给对方） */
  link(saltHex) {
    // ⚠️ salt 放在 **fragment**（# 之后）里：
    //    浏览器不会把 fragment 发给服务器，所以中继看不到 salt。
    //    这不是洁癖 —— salt 参与密钥派生，泄露它虽然不能直接解密，
    //    但会削弱"中继完全不知道对端在传什么"这个承诺。
    return `${this.base}/#k=${this.room}&s=${saltHex}`
  }
}
