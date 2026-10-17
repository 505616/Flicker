/**
 * 中继模式：发送端的主循环
 * ========================
 * 与局域网模式（src/server.js）的区别只在**数据怎么走**：
 *
 *   局域网模式：接收端浏览器 ──HTTPS 直连──▶ 发送端 Node，发送端按请求现算现发
 *   中继模式  ：接收端浏览器 ──HTTPS──▶ 中继 ◀──HTTPS── 发送端 Node，发送端按需投递
 *
 * 加密、分块、清单、销毁**完全共用**，所以这里只负责"节奏"：
 *   · 建立房间、放入清单
 *   · 轮询房间状态，看接收端消费到哪了
 *   · 按需投递下一个分块（拉取式，发送端内存恒定）
 *   · 传输完成后销毁房间
 *
 * 这个模型的一个好处：接收端慢的时候发送端自然停下来等，
 * 中继上任何时刻只有少量在途密文。
 */
import { RelayClient, RelayAborted } from './client.js'
import { PHASE } from '../session.js'

export class RelaySender {
  /**
   * @param {object} o
   * @param {string} o.baseUrl 中继地址
   * @param {string} o.roomName 房间名
   * @param {Buffer} o.encKey 加密密钥
   * @param {Buffer} o.salt 盐（要放进链接的 fragment）
   * @param {object} o.manifest 服务端形式的清单
   * @param {object} o.encManifest 加密后的清单 { iv, tag, ct }
   * @param {(evt:object)=>void} [o.onEvent]
   * @param {number} [o.pollMs] 轮询间隔
   */
  /**
   * @param {object} o
   * @param {number} [o.windowSize] 在途消息上限（流水线深度）。
   *
   *   1  = 停等：速度被锁在 `块大小 ÷ 往返延迟`（实测 195 ms 下约 5 MB/s）。
   *   8  = 流水线：上限变成 8 倍。实测到 Cloudflare 的链路能跑 29.5 MB/s，
   *        所以这一项决定了跨网络到底是"勉强能用"还是"够快"。
   *
   *   代价：中继上最多同时存在 windowSize 条在途密文（8 MiB 左右）。
   *   接收端按**绝对序号**取消息、确认是前缀累积的，所以乱序与多条在途
   *   都不影响正确性 —— 这一点让加窗口变得很安全。
   */
  constructor({ baseUrl, roomName, encKey, salt, manifest, encManifest, onEvent,
    pollMs = 300, windowSize = 8, limiter = null }) {
    this.salt = salt
    this.onEvent = onEvent ?? (() => {})
    this.pollMs = pollMs
    /**
     * 可选的发送限速器（src/rate.js）。不传 = 不限速。
     * 在**投递之前**按明文字节数取额度，所以限的就是实际上行的字节。
     */
    this.limiter = limiter
    // ⚠️ 必须夹到至少 1。早先这里漏了这一行，于是 run() 里
    //    `inFlight >= undefined` 恒为 false —— 窗口实际是**无限大**，
    //    发送端会把整份文件一次性堆到中继上。
    //    这个疏漏是 test/relay-e2e.test.js 那条"不该堆积"的用例抓出来的。
    this.windowSize = Math.max(1, Number(windowSize) || 8)
    this.client = new RelayClient({ baseUrl, roomName, encKey, manifest })
    this.manifestMessage = RelayClient.packManifest({
      salt, iv: encManifest.iv, tag: encManifest.tag, ct: encManifest.ct,
    })
    this.manifest = manifest
    this._stopped = false
    this._lastAckedBase = 0
    this._lastPosted = 0
    this.phase = PHASE.WAITING
  }

  /** 建立房间并放入清单；返回给对方打开的链接 */
  async start() {
    await this.client.open(this.manifestMessage)
    this.phase = PHASE.WAITING
    this.onEvent({ type: 'relay-ready', posted: this.client.posted })
    return this.link()
  }

  link() {
    return this.client.link(this.salt.toString('hex'))
  }

  /**
   * 主循环：直到全部投递完并被接收端确认完。
   *
   * ── 流水线投递（这是跨网络速度的关键）──────────────────────
   *
   * 最初这里是"发一块、等确认、再发下一块"，等于**停等协议**。
   * 那让速度被死锁在 `块大小 ÷ 往返延迟` 上：
   *
   *     1 MiB ÷ 195 ms ≈ 5 MB/s
   *
   * 而实测同一台机器到 Cloudflare 的链路能跑 **29.5 MB/s** ——
   * 瓶颈是实现，不是网络。
   *
   * 改成流水线：允许最多 WINDOW 条消息在途，然后补满、再看一次状态。
   * 吞吐上限变成 `WINDOW × 块大小 ÷ 往返延迟`，8 条就是约 40 MB/s。
   *
   * 为什么这是安全的：接收端按**绝对序号**取消息（前缀累积确认），
   * 所以乱序到达、多条在途都不影响正确性 —— 只是中继上会多占几 MiB。
   */
  async run({ timeoutMs = 15 * 60 * 1000, shouldStop } = {}) {
    // ⚠️ 这是**空闲超时**，不是总时长超时。
    //
    //    最初按"从开始算总时长"实现，结果大文件传到一半就被掐断 ——
    //    接收端正在取分块，房间却因为超时被销毁了，报 NO_ROOM。
    //    对"等对方连接"来说，总时长是对的；但对"正在传输"来说，
    //    唯一有意义的判据是**还有没有进展**。
    //    所以只要有 ack 在推进，就重置计时。
    this._idleSince = Date.now()
    this._idleRounds = 0
    const total = 1 + this.manifest.totalChunks
    let st = { ackedBase: 0, nextSeq: 0, pending: 0 }

    while (!this._stopped && !shouldStop?.()) {
      // 每个循环都先看停止标志：销毁可能发生在 await 的间隙里
      if (this._stopped) break
      const idleMs = Date.now() - this._idleSince
      if (idleMs > timeoutMs) {
        this.onEvent({ type: 'relay-timeout', idleMs })
        return { ok: false, reason: 'timeout' }
      }

      // ① 投一批 —— 一个往返投窗口大小条，**序号由服务端分配**。
      //
      //    ⚠️ 这里试过三种写法，只有第三种对：
      //
      //    ① 顺序 await 每一条 POST —— 窗口放开了但仍是串行等待，
      //       吞吐完全没变（实测窗口 1→32 都是 4.8 MB/s，平均 203 ms/条）。
      //       "允许更多在途"和"真的并发发出"是两件事。
      //
      //    ② 并发发出 N 条 POST —— 中继要求**严格按序**投递，
      //       而并发请求的到达顺序不保证，于是必然撞 409 BAD_SEQ。
      //       更糟的是服务端给所有撞车请求报的是**同一个**期望序号，
      //       于是它们重试时又撞在一起（实测的连锁失败）。
      //
      //    ③ 一批一次 POST（现在这样）—— 序号由**服务端**按到达顺序依次分配，
      //       不存在撞车；发送端只是把 N 条密文打包进一个请求。
      //       这才是"严格按序"与"高吞吐"能共存的唯一干净解法。
      //    ⚠️ 投递量是**窗口里的空位**，不是整个窗口。
      //
      //       这里最初写的是 `min(windowSize, total - startSeq)` —— 每轮
      //       都投满一整窗，完全没减去已经在途的那些。窗口于是形同虚设：
      //       接收端一个都还没确认时，在途就已经是 windowSize 条，
      //       下一轮再叠一窗。实测窗口设 1，在途却有 5 条。
      //       窗口是**在途上限**，所以必须先看还差多少才满。
      const startSeq = this.client.posted
      const inFlight = startSeq - this.client.ackedBase
      const room = Math.max(0, this.windowSize - inFlight)

      // ── 空位太少就**先不投**，去问状态 ────────────────────────
      //
      // ⚠️ 这一条是实测出来的关键，不加上吞吐直接砍半。
      //
      //    现象：窗口 8 时每批块数是 `[7,1,7,1,...]`，平均 4 块 —— 只有
      //    理论上限的一半。原因：投完一批后 ackedBase 是**上一轮**的读数，
      //    因此下一次进循环算出的空位恰好是 1，于是花了整整一个往返
      //    只投 1 块；等那个往返结束才拿到新 ack，再投一个满窗。
      //    于是"一个满窗"被摊到两个往返上。
      //
      //    修法：空位不足半个窗口时，**宁可这个往返只问状态**，
      //    拿回新 ack 再投满窗。剩余量本来就不足半窗时（快传完了）照投。
      const remaining = total - startSeq
      const worthSending = room >= Math.max(1, Math.ceil(this.windowSize / 2)) || room >= remaining
      // 反停滞：连续空转若干轮就**强制转一圈**（下面会重新读一次状态）。
      //
      // ⚠️ 这里试过"强制投递时允许超出窗口 1 条"，**已撤销**。原因不是实现麻烦，
      //    而是它换来的东西不值得：
      //      · 中继的队列在**内存**里。窗口就是在给这份内存封顶（默认 8 MiB）。
      //        接收端不 ack 时若允许持续超投，队列会一路涨到整个文件大小 ——
      //        传 10 GB 就要中继留 10 GB，直接把它撑爆。
      //      · 而"接收端不 ack"在修好页面之后只剩一种成因：**页面版本比发送端旧**
      //        （中继上托管的页面没重新部署）。那种情况下正确的做法是
      //        **如实失败**并让用户重新部署/重传，而不是拿中继的内存去赌。
      //    所以窗口是硬上限，不超投；`_idleRounds` 只用来触发"再问一次状态"。
      const forceSend = this._idleRounds >= 3

      let sentSomething = false
      if ((worthSending || forceSend) && startSeq < total && !this._stopped) {
        const count = Math.min(room, total - startSeq)

        // 限速：在**投递之前**按这一批的明文字节数取额度。
        // 放在这里而不是 putBatch 内部，是为了让"等待"发生在
        // 读磁盘/加密之前 —— 等待期间不占着分块缓冲。
        if (this.limiter) {
          const bytes = this._bytesFor(startSeq, count)
          await this.limiter.take(bytes, () => this._stopped)
          if (this._stopped) break
        }

        let batch = null
        try {
          batch = await this.client.putBatch(startSeq, count, { isAborted: () => this._stopped })
        } catch (e) {
          // 中止是**正常**的结束路径（用户点了取消），不该当成错误抛出去
          if (e instanceof RelayAborted) { this._stopped = true; break }
          // 房间在取分块的过程中被销毁了（多半就是我们自己在取消）——
          // 这和下面读状态时的判据是同一件事，按同样的方式收场，不要抛。
          if (this._stopped &&
              (e.code === 'NO_ROOM' || e.code === 'EXPIRED' || e.status === 404 || e.status === 410)) {
            break
          }
          throw e
        }
        // 投递过程中被叫停：这一批没真的发出去，别再往下统计
        if (batch.aborted || this._stopped) break
        sentSomething = batch.chunks.length > 0
        this._idleRounds = 0
        batch.chunks.forEach((c, i) => {
          this.phase = PHASE.READY
          this.onEvent({
            type: 'relay-chunk', seq: startSeq + i, ...c,
            sentBytes: this.client.bytesPosted, totalBytes: this.manifest.totalBytes,
            totalMessages: total, posted: this.client.posted,
          })
        })
        // 这一批的响应里也带了 ackedBase（虽然通常比不发新请求时更新）
        st = { ackedBase: this.client.ackedBase, nextSeq: this.client.posted, pending: 0 }
      }
      if (this._stopped) break

      // ── 完成判据（两条）──
      //
      // ⚠️ 必须等**接收端确认**，不能只看"我投完了 + 房间空了"。
      //
      //    踩过的坑：最初的条件是 `posted >= total && pending === 0`。
      //    看起来没问题，但它会在这种情况下误判：
      //      接收端 GET 走了最后一条（于是 pending 归零），
      //      但还没来得及 ACK，房间就被销毁了 —— 那条数据对方永远拿不到。
      //    实测日志：posted=6 total=6 pending=0 **ackedBase=5** → 误报完成。
      //
      //    正确判据是 ackedBase >= total：**接收端明确确认收下了全部消息**。
      //    "我发完了"不等于"对方收完了"。
      const complete = this.client.posted >= total && st.ackedBase >= total
      if (complete) break

      // 以服务端状态为准（本地计数只用于判断"还要不要投"）
      this.client.ackedBase = st.ackedBase
      this._noteProgress(st.ackedBase, total)

      if (!sentSomething) this._idleRounds++

      // 需要新 ack 才能继续时，才真的问一次状态（这是唯一会等一个往返的地方）
      if (!sentSomething || Math.max(0, this.windowSize - (this.client.posted - st.ackedBase)) === 0) {
        try {
          st = await this.client.status()
        } catch (e) {
          // 房间被销毁或过期 —— 传输结束（可能正常，也可能是对方关掉了页面）
          if (e.code === 'NO_ROOM' || e.status === 404 || e.status === 410) {
            return this._finishGone(total)
          }
          throw e
        }
        this.client.ackedBase = st.ackedBase
        this._noteProgress(st.ackedBase, total)
        if (this.client.posted >= total && st.ackedBase >= total) break
      }

      // 窗口满说明接收端还没跟上 —— 等一下再问；
      // 窗口没满（投完了在等最后几个 ack）则立刻再循环问一次。
      if (Math.max(0, this.windowSize - (this.client.posted - st.ackedBase)) === 0) {
        await new Promise((r) => setTimeout(r, this.pollMs))
      }
    }

    // ⚠️ 走到这里**不等于成功**。
    //
    //    while 循环会因为多种原因退出：`_stopped`（用户取消）、`shouldStop`、
    //    或循环体里的某个 `break`（例如 putBatch 返回 aborted）。
    //    其中**只有一种**叫完成：全部投递并且接收端全部确认。
    //
    //    从前这里是**无条件** `return { ok: true, reason: 'complete' }` ——
    //    于是"接收端一直不 ack → 窗口占满 → 强制投递算出 0 条 →
    //    putBatch 返回 aborted → break"这条链会把一次**没传完**的传输
    //    报成成功：实测 148 ms 就返回 ok:true，而只投出 8/13 块、
    //    ackedBase 还是 0。用户看到"传输完成"，对方什么都没收到。
    //    这是本项目最不能接受的一类错误：**失败被说成成功**。
    if (this.client.posted >= total && (this.client.ackedBase ?? 0) >= total) {
      this.phase = PHASE.DONE
      this.onEvent({ type: 'relay-complete', posted: this.client.posted })
      return { ok: true, reason: 'complete', bytes: this.client.bytesPosted }
    }

    // 没传完就退出了：如实说清楚，不要含糊成"完成"
    this.phase = this._stopped ? PHASE.DESTROYED : PHASE.READY
    this.onEvent({
      type: 'relay-incomplete',
      posted: this.client.posted, ackedBase: this.client.ackedBase ?? 0, total,
    })
    return {
      ok: false,
      reason: this._stopped ? 'aborted' : 'incomplete',
      posted: this.client.posted,
      ackedBase: this.client.ackedBase ?? 0,
      total,
    }
  }

  /**
   * 房间没了（被销毁 / 过期）。
   * 判据：**只有接收端确认完全部消息**才算成功 —— 否则是"对方关掉了页面"。
   */
  _finishGone(total) {
    const done = this.client.posted >= total && (this.client.ackedBase ?? 0) >= total
    this.phase = done ? PHASE.DONE : PHASE.DESTROYED
    this.onEvent({ type: done ? 'relay-complete' : 'relay-gone', posted: this.client.posted })
    return { ok: done, reason: done ? 'complete' : 'room-gone' }
  }

  /** 有进展就重置空闲计时并上报（ack 前进、或我们投了新的一块） */
  _noteProgress(ackedBase, total) {
    if (ackedBase > this._lastAckedBase || this.client.posted !== this._lastPosted) {
      this._lastAckedBase = ackedBase
      this._lastPosted = this.client.posted
      this._idleSince = Date.now()
      this.onEvent({
        type: 'relay-progress',
        ackedBase, totalMessages: total,
        sentBytes: this.client.bytesPosted, totalBytes: this.manifest.totalBytes,
      })
    }
  }

  /**
   * 一批投递会送出的**明文字节数**（用于限速取额度）。
   *
   * 序号 → 文件/块号 的换算与 client._locate 一致；这里只需要长度，
   * 所以不碰磁盘、只是算术。限速按明文字节算：密文比明文多一点点
   * （每块 16 字节标签），对"别占满带宽"这个目的来说可以忽略。
   */
  _bytesFor(startSeq, count) {
    const files = this.manifest.files
    let bytes = 0
    for (let i = 0; i < count; i++) {
      const ordinal = startSeq + i - 1        // seq 0 是清单
      if (ordinal < 0) continue
      for (const f of files) {
        if (ordinal >= f.firstChunk && ordinal < f.firstChunk + f.chunks) {
          const ci = ordinal - f.firstChunk
          bytes += Math.max(0, Math.min(f.chunkBytes, f.size - ci * f.chunkBytes))
          break
        }
      }
    }
    return bytes
  }

  /** 供外部查询：是否已被要求停止 */
  get stopped() { return this._stopped }

  /**
   * 停止并销毁房间。
   *
   * ⚠️ 必须先立 `_stopped` 再发销毁请求。
   *    最初写反了（先 await 销毁、后设标志），于是主循环会在
   *    "房间已销毁"与"标志还没设上"之间抢一次投递 —— 表现是
   *    用户点了取消之后屏幕上冒出一句"序号不连续"的报错。
   *    这类竞态靠读代码很难发现，是端到端测试的顺序追踪抓出来的。
   */
  async destroy() {
    this._stopped = true
    const ok = await this.client.destroy()
    this.phase = PHASE.DESTROYED
    this.onEvent({ type: 'relay-destroyed', ok })
    return ok
  }
}
