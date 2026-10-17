/**
 * 中继房间逻辑的测试
 * ==================
 * 房间语义是最需要测试的部分 —— 它管着序号、删除与过期，
 * 出错的后果是"文件收不全"这种很难查的问题。
 *
 * 所以这些用例里最要紧的是**序号稳定性**和**前缀删除**两条。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RoomStore, RelayError, MAX_MESSAGE_BYTES, DEFAULT_MAX_MESSAGE_BYTES, MAX_MESSAGES_PER_ROOM,
} from '../src/relay/room.js'

const ROOM = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const bytes = (n, fill = 1) => new Uint8Array(n).fill(fill)

/** 可注入时钟的 store，便于测过期 */
function makeStore(opts = {}) {
  let clock = 1_000_000
  const store = new RoomStore({ now: () => clock, ...opts })
  return { store, tick: (ms) => { clock += ms }, at: () => clock }
}

// ── 房间号校验 ──────────────────────────────────────────────

test('房间名必须是 64 位十六进制（128 bit，不可枚举）', () => {
  assert.ok(RoomStore.validRoomId('a'.repeat(64)))
  assert.ok(RoomStore.validRoomId('0123456789abcdef'.repeat(4)))
  for (const bad of ['', 'abc', 'A'.repeat(64), 'z'.repeat(64),
    'a'.repeat(16), 'a'.repeat(63), 'a'.repeat(65), null, undefined, 12345]) {
    assert.ok(!RoomStore.validRoomId(bad), `应拒绝: ${String(bad)}`)
  }
  // 短房间号必须被拒绝 —— 16 位十六进制只有 64 bit，理论上可暴力尝试
  assert.ok(!RoomStore.validRoomId('abcdef0123456789'),
    '只有 16 位的短标识不应被中继接受')
})

test('创建房间：拒绝非法房间号', () => {
  const { store } = makeStore()
  assert.throws(() => store.create('bad'), (e) => e.code === 'BAD_ROOM_ID' && e.status === 400)
})

// ── 创建与幂等 ──────────────────────────────────────────────

test('创建房间是幂等的 —— 重连不该丢掉已放入的消息', () => {
  const { store, tick } = makeStore()
  const first = store.create(ROOM)
  assert.equal(first.created, true)

  store.put(ROOM, 0, bytes(10))
  store.put(ROOM, 1, bytes(10))

  tick(5000)
  const again = store.create(ROOM)      // 模拟发送端重连
  assert.equal(again.created, false, '重复创建应返回已有的房间')
  assert.equal(again.messages, 2, '已放入的消息必须还在')
  assert.equal(store.status(ROOM).pending, 2)
})

test('房间数超上限时拒绝新建', () => {
  const { store } = makeStore({ maxRooms: 2 })
  store.create('1111111111111111111111111111111111111111111111111111111111111111')
  store.create('2222222222222222222222222222222222222222222222222222222222222222')
  assert.throws(() => store.create('3333333333333333333333333333333333333333333333333333333333333333'),
    (e) => e.code === 'TOO_MANY_ROOMS' && e.status === 503)
  // 已存在的房间仍可复用
  assert.doesNotThrow(() => store.create('1111111111111111111111111111111111111111111111111111111111111111'))
})

// ── 序号：最要紧的性质 ──────────────────────────────────────

test('序号必须严格连续 —— 中继要尽早发现丢包', () => {
  const { store } = makeStore()
  store.create(ROOM)
  store.put(ROOM, 0, bytes(4))
  store.put(ROOM, 1, bytes(4))

  assert.throws(() => store.put(ROOM, 5, bytes(4)),
    (e) => e.code === 'BAD_SEQ' && e.status === 409, '跳号必须被拒绝')
  assert.throws(() => store.put(ROOM, 1, bytes(4)),
    (e) => e.code === 'BAD_SEQ', '重号必须被拒绝')
  assert.throws(() => store.put(ROOM, -1, bytes(4)),
    (e) => e.code === 'BAD_SEQ', '负号必须被拒绝')
})

test('⭐ ack 之后，后续消息的序号必须保持不变', () => {
  // 这是真实写出过的 bug：早先的实现删掉前缀后把剩余消息重新编号成 0,1,2…，
  // 于是接收端原来记着的序号全部错位，表现是"文件收不全"。
  const { store } = makeStore()
  store.create(ROOM)
  for (let i = 0; i < 5; i++) store.put(ROOM, i, bytes(8, i + 1))

  // 确认前两条
  const r = store.ack(ROOM, 1)
  assert.equal(r.ackedBase, 2)
  assert.equal(r.nextSeq, 5, '已确认 2 条后，下一个可用序号仍是 5')

  // 第 2..4 条必须还能按**原序号**取到
  for (let i = 2; i < 5; i++) {
    const m = store.get(ROOM, i)
    assert.equal(m.seq, i, `第 ${i} 条的序号必须保持为 ${i}`)
    assert.equal(m.data[0], i + 1, `第 ${i} 条的内容必须是当初放进去的那条`)
  }

  // 已确认的不再可取，且错误码要能区分"已删除"与"还没到"
  assert.throws(() => store.get(ROOM, 0), (e) => e.code === 'GONE' && e.status === 410)
  assert.throws(() => store.get(ROOM, 1), (e) => e.code === 'GONE')
  assert.throws(() => store.get(ROOM, 9), (e) => e.code === 'NOT_YET' && e.status === 404)

  // 新消息的序号从 5 继续
  const p = store.put(ROOM, 5, bytes(8, 9))
  assert.equal(p.seq, 5)
  assert.equal(p.nextSeq, 6)
})

test('ack 是前缀语义：跳着确认只会确认到连续的那一段', () => {
  const { store } = makeStore()
  store.create(ROOM)
  for (let i = 0; i < 4; i++) store.put(ROOM, i, bytes(4))

  // 直接 ack 到 3（全部）
  const r = store.ack(ROOM, 3)
  assert.equal(r.ackedBase, 4)
  assert.equal(r.nextSeq, 4)
  assert.equal(store.status(ROOM).pending, 0, '全部确认后房间应为空')
})

test('ack 是幂等的，重复确认不会出错也不会丢消息', () => {
  const { store } = makeStore()
  store.create(ROOM)
  for (let i = 0; i < 4; i++) store.put(ROOM, i, bytes(4))

  store.ack(ROOM, 1)
  const again = store.ack(ROOM, 1)        // 重复同一个
  assert.equal(again.ackedBase, 2, '重复确认不应再推进')

  const older = store.ack(ROOM, 0)        // 确认一个更早的
  assert.equal(older.ackedBase, 2, '更早的确认不应回退')

  // 剩下的消息还在
  assert.equal(store.get(ROOM, 2).seq, 2)
  assert.equal(store.get(ROOM, 3).seq, 3)
})

test('ack 超过已有的消息数时只确认到已有的部分', () => {
  const { store } = makeStore()
  store.create(ROOM)
  for (let i = 0; i < 3; i++) store.put(ROOM, i, bytes(4))
  const r = store.ack(ROOM, 99)
  assert.equal(r.ackedBase, 3)
  assert.equal(store.status(ROOM).pending, 0)
})

test('get 之后不删除 —— 必须显式 ack（否则丢包无法重试）', () => {
  const { store } = makeStore()
  store.create(ROOM)
  store.put(ROOM, 0, bytes(4, 42))

  const a = store.get(ROOM, 0)
  const b = store.get(ROOM, 0)      // 重复读取
  assert.equal(a.data[0], 42)
  assert.equal(b.data[0], 42, '未 ack 前必须可以反复读取')
  assert.equal(store.status(ROOM).pending, 1)
})

// ── 大小与容量上限 ──────────────────────────────────────────

test('拒绝空消息与超大消息（两个上限都验：协议最小值 + 本项目默认值）', () => {
  // 2026-10 起有了能力协商：store 的默认上限变成 2 MiB + 17，
  // 而协议**保证的最小值**（老客户端会按它发）仍是 1 MiB + 17。
  // 两个值都要"正好收下、多一个字节就拒"，否则改一处就会漏一处。
  for (const [label, limit] of [
    ['协议最小值', MAX_MESSAGE_BYTES],
    ['本项目默认值', DEFAULT_MAX_MESSAGE_BYTES],
  ]) {
    const { store } = makeStore({ maxMessageBytes: limit })
    store.create(ROOM)
    assert.equal(store.maxMessageBytes, limit)
    assert.throws(() => store.put(ROOM, 0, bytes(0)), (e) => e.code === 'EMPTY_BODY')
    assert.throws(() => store.put(ROOM, 0, bytes(limit + 1)),
      (e) => e.code === 'TOO_LARGE' && e.status === 413, `${label}: 多一字节必须 413`)
    // 正好等于上限应当允许（边界）
    assert.doesNotThrow(() => store.put(ROOM, 0, bytes(limit)), `${label}: 满消息必须收下`)
  }
})

test('拒绝非字节的消息内容', () => {
  const { store } = makeStore()
  store.create(ROOM)
  for (const bad of ['string', 123, {}, null, undefined, [1, 2, 3]]) {
    assert.throws(() => store.put(ROOM, 0, bad), (e) => e.code === 'BAD_BODY',
      `应拒绝: ${JSON.stringify(bad)}`)
  }
})

test('房间消息数超上限时拒绝', () => {
  const { store } = makeStore()
  store.create(ROOM)
  // 用小上限的 store 更快
  const small = new RoomStore({ now: store.now })
  small.create(ROOM)
  for (let i = 0; i < MAX_MESSAGES_PER_ROOM; i++) small.put(ROOM, i, bytes(1))
  assert.throws(() => small.put(ROOM, MAX_MESSAGES_PER_ROOM, bytes(1)),
    (e) => e.code === 'ROOM_FULL' && e.status === 507)
})

// ── 过期 ────────────────────────────────────────────────────

test('房间在闲置超时后自动过期', () => {
  const { store, tick } = makeStore({ ttlMs: 1000 })
  store.create(ROOM)
  store.put(ROOM, 0, bytes(4))

  // ⚠️ 这里有个容易写错的地方：**任何**访问（get / status / put / ack）都会刷新
  //    房间的闲置时间。所以"先断言还能用、再断言过期"这种写法会自己破坏前提 ——
  //    第一次断言已经把房间刷新成"刚刚活动过"了，第二次自然不过期。
  //    这个用例写错过两版，最后改成用**注入的时钟**判断时间，不再做多余访问。
  tick(500)
  assert.ok(store.rooms.has(ROOM), '未超时时房间应还在')

  tick(600)                          // 距上次活动 1100 > 1000，必须已过期
  assert.throws(() => store.get(ROOM, 0), (e) => e.code === 'EXPIRED' && e.status === 410)
  assert.ok(!store.rooms.has(ROOM), '过期房间应被顺手清掉')
})

test('访问会刷新闲置时间（活跃的传输不会被误杀）', () => {
  const { store, tick } = makeStore({ ttlMs: 1000 })
  store.create(ROOM)
  for (let i = 0; i < 10; i++) {
    store.put(ROOM, i, bytes(4))
    tick(400)                        // 每次间隔都小于 ttl
  }
  assert.doesNotThrow(() => store.status(ROOM), '持续有活动时不该过期')
})

test('sweep 清理过期房间并返回清理数量', () => {
  const { store, tick } = makeStore({ ttlMs: 1000 })
  store.create('1111111111111111111111111111111111111111111111111111111111111111')
  store.create('2222222222222222222222222222222222222222222222222222222222222222')
  tick(400)
  store.put('2222222222222222222222222222222222222222222222222222222222222222', 0, bytes(4))    // 让第 2 个保持活跃

  tick(700)                                     // 第 1 个过期，第 2 个没过
  const removed = store.sweep()
  assert.equal(removed, 1)
  assert.equal(store.stats().rooms, 1)
  assert.throws(() => store.status('1111111111111111111111111111111111111111111111111111111111111111'), (e) => e.code === 'NO_ROOM')
  assert.doesNotThrow(() => store.status('2222222222222222222222222222222222222222222222222222222222222222'))
})

test('不存在的房间给出明确的 404', () => {
  const { store } = makeStore()
  for (const fn of [
    () => store.status('1111111111111111111111111111111111111111111111111111111111111111'),
    () => store.get('1111111111111111111111111111111111111111111111111111111111111111', 0),
    () => store.put('1111111111111111111111111111111111111111111111111111111111111111', 0, bytes(4)),
    () => store.ack('1111111111111111111111111111111111111111111111111111111111111111', 0),
  ]) {
    assert.throws(fn, (e) => e.code === 'NO_ROOM' && e.status === 404)
  }
})

// ── 销毁 ────────────────────────────────────────────────────

test('销毁房间后立刻不可用（用完即销毁的落点）', () => {
  const { store } = makeStore()
  store.create(ROOM)
  store.put(ROOM, 0, bytes(4))

  assert.deepEqual(store.destroy(ROOM), { destroyed: true })
  assert.throws(() => store.status(ROOM), (e) => e.code === 'NO_ROOM')
  assert.equal(store.stats().rooms, 0)
  // 幂等：再销毁一次不报错
  assert.deepEqual(store.destroy(ROOM), { destroyed: false })
})

// ── 完整的一轮投递 ──────────────────────────────────────────

test('完整投递：发送端按序放入，接收端按序取走并确认', () => {
  const { store } = makeStore()
  store.create(ROOM)

  // 模拟一次传输：清单 + 若干分块
  const messages = [bytes(64, 0), ...Array.from({ length: 5 }, (_, i) => bytes(1024, i + 1))]
  for (let i = 0; i < messages.length; i++) {
    const r = store.put(ROOM, i, messages[i])
    assert.equal(r.seq, i)
    assert.equal(r.nextSeq, i + 1)
  }

  // 接收端逐条取走
  const got = []
  for (let i = 0; i < messages.length; i++) {
    const m = store.get(ROOM, i)
    got.push(m.data)
    // 每取一条就确认（前缀删除）
    const a = store.ack(ROOM, i)
    assert.equal(a.ackedBase, i + 1)
  }

  assert.equal(got.length, messages.length)
  for (let i = 0; i < messages.length; i++) {
    assert.deepEqual(got[i], messages[i], `第 ${i} 条内容必须一致`)
  }
  assert.equal(store.status(ROOM).pending, 0, '全部取走后房间应为空')
})

test('大量消息下序号与内容都不漂移', () => {
  const { store } = makeStore()
  store.create(ROOM)
  const N = 500
  for (let i = 0; i < N; i++) store.put(ROOM, i, bytes(8, i % 256))
  // 边取边确认，模拟真实的流式消费
  for (let i = 0; i < N; i++) {
    if (i % 50 === 0 && i > 0) store.ack(ROOM, i - 1)
    const m = store.get(ROOM, i)
    assert.equal(m.seq, i)
    assert.equal(m.data[0], i % 256, `第 ${i} 条内容漂移了`)
  }
})

// ── 中继看不到什么 ──────────────────────────────────────────

test('房间逻辑不解释消息内容 —— 它只搬运字节', () => {
  const { store } = makeStore()
  store.create(ROOM)
  // 放进一段"看起来像"明文的东西，中继不应该有任何反应或转换
  const payload = new TextEncoder().encode('这是不该被中继理解的明文')
  store.put(ROOM, 0, payload)
  const out = store.get(ROOM, 0)
  assert.deepEqual(out.data, payload, '必须原样搬运，不做任何解读')
  // 状态里也不该出现任何内容相关的字段
  const st = store.status(ROOM)
  const keys = Object.keys(st)
  for (const forbidden of ['name', 'content', 'text', 'filename', 'size', 'sha256']) {
    assert.ok(!keys.includes(forbidden), `状态里不该有 ${forbidden}`)
  }
})
