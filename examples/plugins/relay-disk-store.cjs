/**
 * 示例插件：把中继的房间放到**磁盘**上（`relay/store` 贡献点）
 * ==========================================================
 *
 * 用途：自己部署中继（`node relay/local.mjs --plugin=examples/plugins/relay-disk-store.cjs`）时，
 * 让消息落到磁盘上而不是只活在进程内存里。
 *
 * ⚠️ **这是示例，不是生产实现。** 它刻意保持短，把接口讲清楚就够了：
 *    · 语义（序号、前缀 ack、幂等、过期）**直接委托给内置的 `RoomStore`** ——
 *      不重写一遍，避免"插件版语义和核心版不一样"这种最难查的漂移；
 *    · 磁盘上只额外存一份消息副本（`<目录>/<房间>/<序号>.bin`），ack 时删掉。
 *      进程重启后房间表并不恢复（那要序列化元数据与过期时间，属于存储后端自己的事），
 *      所以它演示的是"接缝在哪、怎么写"，**不是**"重启不断线"的成品。
 *    · 没有崩溃一致性：写盘失败只记一句，不假装成功。
 *
 * 目录：环境变量 `FLICKER_RELAY_STORE_DIR`，默认 `./flicker-relay-store`。
 */
const { mkdirSync, writeFileSync, rmSync, existsSync } = require('node:fs')
const path = require('node:path')
const { RoomStore } = require('../../src/relay/room.js')

module.exports = {
  name: 'relay-disk-store',
  version: '1.0.0',
  apiVersion: 1,
  apply(ctx) {
    const root = process.env.FLICKER_RELAY_STORE_DIR || path.join(process.cwd(), 'flicker-relay-store')
    ctx.log(`存储目录：${root}`)

    // 副作用走 ctx.effect：中继关闭时会调用这里返回的清理函数
    ctx.effect(() => {
      mkdirSync(root, { recursive: true })
      return () => { /* 目录留着：里面是用户的传输数据，不该由插件擅自删 */ }
    })

    const inner = new RoomStore()
    const dirOf = (id) => path.join(root, id)
    const fileOf = (id, seq) => path.join(dirOf(id), `${String(seq).padStart(8, '0')}.bin`)

    /** 把一条消息写盘（失败只记一句，绝不假装成功） */
    const persist = (id, seq, data) => {
      try {
        mkdirSync(dirOf(id), { recursive: true })
        writeFileSync(fileOf(id, seq), Buffer.from(data))
      } catch (e) {
        ctx.log(`写盘失败（seq ${seq}）：${e?.message ?? e} —— 中继仍会继续，但这条没落盘`)
      }
    }

    ctx.contribute('relay/store', () => ({
      // 能力字段：协议用它做能力协商（缺了客户端只能猜）
      maxMessageBytes: inner.maxMessageBytes,
      ttlMs: inner.ttlMs,

      create: (id) => inner.create(id),
      put: (id, seq, data) => { const r = inner.put(id, seq, data); persist(id, seq, data); return r },
      putBatch: (id, items) => {
        const r = inner.putBatch(id, items)
        r.seqs.forEach((seq, i) => persist(id, seq, items[i]))
        return r
      },
      get: (id, seq) => inner.get(id, seq),
      ack: (id, upToSeq) => {
        const before = inner.status(id).ackedBase
        const r = inner.ack(id, upToSeq)
        for (let seq = before; seq < r.ackedBase; seq++) {
          try { rmSync(fileOf(id, seq), { force: true }) } catch { /* 尽力 */ }
        }
        return r
      },
      status: (id) => inner.status(id),
      destroy: (id) => {
        const r = inner.destroy(id)
        try { if (existsSync(dirOf(id))) rmSync(dirOf(id), { recursive: true, force: true }) } catch { /* 尽力 */ }
        return r
      },
      stats: () => inner.stats(),
    }))
  },
}
