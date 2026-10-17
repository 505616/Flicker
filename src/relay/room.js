/**
 * 中继的房间逻辑（纯逻辑，不依赖任何运行时）
 * ==========================================
 *
 * 这个模块**刻意不 import 任何 Cloudflare 的东西**，也不碰 HTTP。
 * 原因：Workers 的运行时无法在本地跑单元测试，而"房间"的语义
 * （序号、过期、上限、注销）恰恰是最需要测试的部分。
 * 所以把逻辑抽出来，Worker 只做一层很薄的 HTTP 适配。
 *
 * ── 中继能看到什么、不能看到什么（这是设计的一部分，不是巧合）──
 *
 *   能看到：一个随机房间号、消息的序号与长度、消息到达的时间
 *   看不到：文件内容（AES-256-GCM 端到端加密）
 *           文件名与大小（清单本身也是加密的）
 *           密码（从不传输）
 *
 * 中继**不是**文件服务器，它是一个有顺序号的加密消息信箱。
 * 发送端把密文放进来，接收端按序号取走，取走的立刻删除。
 */


/** 房间默认存活时长（毫秒）。超时后自动清理 */
const DEFAULT_TTL_MS = 15 * 60 * 1000

/**
 * 单个消息的大小上限（字节）。
 *
 * ⚠️ 这个值是**协议给出的上界**，不是分块大小：
 *    一条消息 = 类型字节(1) + GCM 认证标签(16) + 密文(最多 1 MiB)
 *    所以上界是 1 MiB + 17。
 *
 *    最初这里写的是 1 << 20，结果**任何满块都会被 413 拒绝** ——
 *    小文件能传、大文件必挂，而且只在跨网络时出现。
 *    这个边界 bug 是集成测试（test/relay-protocol.test.js）抓出来的。
 */
export const MAX_MESSAGE_BYTES = (1 << 20) + 17

/**
 * 中继**默认接受**的单条消息上限（2 MiB + 17）。
 *
 * ── 为什么与 `MAX_MESSAGE_BYTES` 是两个常量 ──
 * `MAX_MESSAGE_BYTES` 是**协议保证的最小值**：任何符合规范的中继都必须收得下
 * 1 MiB + 17 字节的消息。客户端在"对方没有声明能力"时（老中继）就按它来。
 * 而本项目的部署（本地中继 / Cloudflare Worker）默认收得下 2 MiB + 17 ——
 * 实测（`_lab/bench-recv-rtt.mjs`，256 MiB、RTT 195 ms、链路 29.5 MB/s 封顶）：
 * 块 1 MiB 时端到端 18.9 MB/s，**2 MiB 时 26.3 MB/s（链路的 89%）**，4 MiB 反而没有额外收益。
 *
 * 客户端**不允许**假设对方是 2 MiB：它必须读中继声明的 `maxMessageBytes`
 * （见 protocol.js 的 /health 与创建响应），读不到就回落到 1 MiB + 17。
 */
export const DEFAULT_MAX_MESSAGE_BYTES = (2 << 20) + 17

/** 单个房间最多容纳的消息数（防滥用） */
export const MAX_MESSAGES_PER_ROOM = 4096

/** 同时存在的房间数上限（防止内存被拖垮） */
const MAX_ROOMS = 64

export class RelayError extends Error {
  constructor(message, code, status = 400) {
    super(message)
    this.name = 'RelayError'
    this.code = code
    this.status = status
  }
}

/**
 * 房间集合。
 * 在 Worker 里，一个实例由一次请求创建、请求结束即销毁 ——
 * 所以真正的持久化靠 Worker 的 globalThis 作用域（见 worker.js 的说明）。
 * 这样设计是为了让这个类本身可测。
 */
export class RoomStore {
  /**
   * @param {object} [opts]
   * @param {number} [opts.ttlMs]
   * @param {number} [opts.maxRooms]
   * @param {number} [opts.maxMessageBytes] 单条消息上限（默认 = 本项目部署的 2 MiB + 17）
   * @param {() => number} [opts.now] 注入时钟，便于测试过期
   *
   * ⚠️ 关于 `maxMessageBytes`：协议**保证的最小值**是 `MAX_MESSAGE_BYTES`（1 MiB + 17），
   *    而本项目的部署默认放宽到 `DEFAULT_MAX_MESSAGE_BYTES`（2 MiB + 17）。
   *    中继必须把这个值**告诉客户端**（`/health` 与创建响应里的 `maxMessageBytes`），
   *    客户端按 `min(它想要的, 对方声明的)` 选块大小 ——
   *    老中继不声明，客户端就按协议最小值来，于是谁都不会坏。
   */
  constructor(opts = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
    this.maxRooms = opts.maxRooms ?? MAX_ROOMS
    this.maxMessageBytes = opts.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES
    this.now = opts.now ?? (() => Date.now())
    /** @type {Map<string, {createdAt:number, updatedAt:number, messages:Array<{seq:number,data:Uint8Array,at:number}>}>} */
    this.rooms = new Map()
  }

  /** 清掉过期房间。每次访问都顺手做一次，不依赖定时器 */
  sweep() {
    const t = this.now()
    let removed = 0
    for (const [id, room] of this.rooms) {
      if (t - room.updatedAt > this.ttlMs) { this.rooms.delete(id); removed++ }
    }
    return removed
  }

  /**
   * 校验房间名格式：**64 位十六进制**。
   *
   * 房间名由密码经 HKDF 派生（见 suite/flicker1.js 的 relayRoomName），
   * 它本身就是"知道密码"的证明 —— 128 bit 且单向，不可枚举、不可反推。
   * 所以中继不需要第二套授权机制，房间名即能力。
   */
  static validRoomId(id) {
    return typeof id === 'string' && /^[0-9a-f]{64}$/.test(id)
  }

  _get(id) {
    const room = this.rooms.get(id)
    if (!room) {
      throw new RelayError('房间不存在或已过期', 'NO_ROOM', 404)
    }
    if (this.now() - room.updatedAt > this.ttlMs) {
      this.rooms.delete(id)
      throw new RelayError('房间已过期', 'EXPIRED', 410)
    }
    return room
  }

  /**
   * 创建房间。幂等：已存在就重置存活时间并返回现有的。
   * 幂等很重要 —— 发送端可能重连，不该因此丢掉已经放进去的消息。
   */
  /**
   * 创建房间。幂等：已存在就重置存活时间并返回现有的。
   * 幂等很重要 —— 发送端可能重连，不该因此丢掉已经放进去的消息。
   */
  create(id) {
    if (!RoomStore.validRoomId(id)) {
      throw new RelayError('房间号格式不正确', 'BAD_ROOM_ID', 400)
    }
    this.sweep()
    let room = this.rooms.get(id)
    if (room) {
      room.updatedAt = this.now()
      return { created: false, messages: room.messages.length }
    }
    if (this.rooms.size >= this.maxRooms) {
      throw new RelayError('中继上的房间太多，请稍后再试', 'TOO_MANY_ROOMS', 503)
    }
    room = { createdAt: this.now(), updatedAt: this.now(), messages: [], ackedBase: 0 }
    this.rooms.set(id, room)
    return { created: true, messages: 0 }
  }

  /**
   * 放入一条消息（发送端调用）。
   *
   * 序号由调用方指定，且**必须是下一个期望的序号** ——
   * 这样中继能立刻发现丢包或乱序，而不是把问题留到解密时才暴露。
   */
  put(id, seq, data) {
    const room = this._get(id)
    if (!(data instanceof Uint8Array)) {
      throw new RelayError('消息内容必须是字节', 'BAD_BODY', 400)
    }
    if (data.length === 0) throw new RelayError('消息不能为空', 'EMPTY_BODY', 400)
    if (data.length > this.maxMessageBytes) {
      throw new RelayError(
        `单条消息超过上限（${data.length} > ${this.maxMessageBytes} 字节）`, 'TOO_LARGE', 413)
    }
    if (room.messages.length >= MAX_MESSAGES_PER_ROOM) {
      throw new RelayError('这个房间的消息太多了', 'ROOM_FULL', 507)
    }
    const expected = room.ackedBase + room.messages.length
    if (seq !== expected) {
      throw new RelayError(
        `序号不连续：期望 ${expected}，收到 ${seq}。` +
        '发送端应严格按序投递 —— 让中继尽早发现丢包，而不是留到解密时才暴露',
        'BAD_SEQ', 409)
    }
    room.messages.push({ seq, data, at: this.now() })
    room.updatedAt = this.now()
    return { seq, nextSeq: room.ackedBase + room.messages.length }
  }

  /**
   * 一批消息按到达顺序放入（发送端一次投递多条）。
   *
   * ── 为什么需要这个 ──
   * 中继要求**严格按序**投递，而流水线投递会同时发出多条请求 ——
   * 它们的到达顺序不保证，于是必然撞 409。
   * 更糟的是：服务端给所有撞车请求报的是**同一个**期望序号，
   * 于是它们重试时又撞在一起（实测的连锁失败）。
   *
   * 严格按序与并发天然不相容。所以改成"一次投一批"：
   * 序号由**服务端**按到达顺序依次分配，发送端不再自己猜。
   * 一个往返投一批，吞吐照样上得去。
   *
   * @param {string} id 房间名
   * @param {Uint8Array[]} items 一批消息（顺序即投递顺序）
   * @returns {{seqs:number[], nextSeq:number}}
   */
  putBatch(id, items) {
    const room = this._get(id)
    if (!Array.isArray(items) || items.length === 0) {
      throw new RelayError('一批至少要有一条消息', 'EMPTY_BATCH', 400)
    }
    if (items.length > 64) {
      throw new RelayError('一批最多 64 条', 'BATCH_TOO_LARGE', 413)
    }
    // 先全部校验，避免"放进去一半才报错"
    for (let i = 0; i < items.length; i++) {
      const d = items[i]
      if (!(d instanceof Uint8Array)) throw new RelayError('消息内容必须是字节', 'BAD_BODY', 400)
      if (d.length === 0) throw new RelayError('消息不能为空', 'EMPTY_BODY', 400)
      if (d.length > this.maxMessageBytes) {
        throw new RelayError(`第 ${i} 条超过上限（${d.length} > ${this.maxMessageBytes} 字节）`, 'TOO_LARGE', 413)
      }
    }
    if (room.messages.length + items.length > MAX_MESSAGES_PER_ROOM) {
      throw new RelayError('这个房间的消息太多了', 'ROOM_FULL', 507)
    }
    const seqs = []
    for (const data of items) {
      const seq = room.ackedBase + room.messages.length
      room.messages.push({ seq, data, at: this.now() })
      seqs.push(seq)
    }
    room.updatedAt = this.now()
    return { seqs, nextSeq: room.ackedBase + room.messages.length }
  }

  /** 读取一条消息（接收端调用）。不删除 —— 由 ack 显式确认 */
  get(id, seq) {
    const room = this._get(id)
    if (!Number.isInteger(seq) || seq < 0) {
      throw new RelayError('序号必须是非负整数', 'BAD_SEQ', 400)
    }
    // 序号是**绝对**的，不随 ack 改变 —— 接收端可以放心地按序号重试
    const idx = seq - room.ackedBase
    if (idx < 0) {
      throw new RelayError(`第 ${seq} 条已经被确认删除了`, 'GONE', 410)
    }
    const msg = room.messages[idx]
    if (!msg) {
      // 区分"还没到"和"已经取走了"对接收端很重要：前者应该继续等，后者是出错
      throw new RelayError(`第 ${seq} 条还没到`, 'NOT_YET', 404)
    }
    room.updatedAt = this.now()
    return {
      seq: msg.seq, data: msg.data,
      nextSeq: room.ackedBase + room.messages.length,
    }
  }

  /**
   * 确认已收到并删除。
   *
   * ⚠️ 两条约束，都是为了让序号**保持稳定**：
   *   ① 只做前缀删除 —— 只能删掉"从头开始连续已确认"的那一段。
   *      否则接收端可以跳着 ack，把中间没取的消息永久丢掉。
   *   ② **删掉后不重新编号**，而是抬高 ackedBase。
   *      早先的写法在删除后把剩余消息重新编号成 0,1,2…，
   *      于是接收端原来记着的序号全部错位 —— 这是实打实的 bug。
   */
  ack(id, upToSeq) {
    const room = this._get(id)
    if (!Number.isInteger(upToSeq) || upToSeq < 0) {
      throw new RelayError('确认序号必须是非负整数', 'BAD_SEQ', 400)
    }
    const base = room.ackedBase
    const available = base + room.messages.length
    if (upToSeq + 1 <= base) {
      // 已经确认过了，幂等返回
      return { ackedBase: base, nextSeq: available }
    }
    const count = Math.min(upToSeq + 1, available) - base
    if (count > 0) {
      room.messages.splice(0, count)
      room.ackedBase = base + count
      room.updatedAt = this.now()
    }
    return { ackedBase: room.ackedBase, nextSeq: room.ackedBase + room.messages.length }
  }

  /** 房间状态：发送端与接收端用它对齐进度 */
  status(id) {
    const room = this._get(id)
    return {
      roomId: id,
      pending: room.messages.length,
      ackedBase: room.ackedBase,
      nextSeq: room.ackedBase + room.messages.length,
      ageMs: this.now() - room.createdAt,
      idleMs: this.now() - room.updatedAt,
      ttlMs: this.ttlMs,
    }
  }

  /** 主动销毁房间（两端任一方都能调用；"用完即销毁"的落点） */
  destroy(id) {
    const existed = this.rooms.delete(id)
    return { destroyed: existed }
  }

  /** 维护用：当前房间数与消息总数 */
  stats() {
    let messages = 0
    for (const r of this.rooms.values()) messages += r.messages.length
    return { rooms: this.rooms.size, messages, ttlMs: this.ttlMs }
  }
}
