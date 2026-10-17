/**
 * `RelayClient.open()` 的三种开局
 * ================================
 *
 * 这一组用例来自对 PROTOCOL.md §3.3.1 那条「待验证」的核查。文档原本写的是：
 *
 *   「恶意方理论上可以直接 POST 一个 `from:"i"` 的消息抢占房间名。
 *     **但房间名是 256 bit 不可猜测的**，所以实际风险为零 ——
 *     想抢占就必须先知道密码。」
 *
 * 这句话的推理**是错的**：房间名确实不可猜测，但它**就在链接里**（64 hex）。
 * 拿到链接、没拿到密码的人不需要猜。顺着这条线查下去，还发现了一个与攻击者
 * 完全无关的**自身缺陷**（下面的第 2 条）。
 *
 * 实测（`_lab/probe-relay-preempt.mjs`）当时的结果：
 *
 *   | 情形 | 房间状态 | 旧行为 |
 *   |---|---|---|
 *   | 攻击者占住 seq 0 | nextSeq=1（全是垃圾） | 发送端**静默跳过清单**，接收端解密失败 |
 *   | 创建响应在回程丢了 | nextSeq=0（空房间） | 发送端**静默跳过清单**，接收端等 2 分钟超时 |
 *
 * 两种都是"清单根本没投出去"，而用户已经把链接发出去了。
 * 现在按"房间里有没有东西"区分：空 = 自己的响应丢了（补投清单）；
 * 非空 = 被别人占了（明确报错 `ROOM_TAKEN`）。
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { RoomStore } from '../src/relay/room.js'
import { handleRelay } from '../src/relay/protocol.js'
import { RelayClient } from '../src/relay/client.js'
import { deriveVerifier, deriveKeys, relayRoomName, PARAMS } from '../src/suite/flicker1.js'

const cleanups = []
// try 住同步抛错、也容忍清理函数返回 undefined —— 否则一处异常会让后面的清理全不跑，
// 子进程攥着管道不放，测试进程永不退出（详见 test/relay-e2e.test.js 里的教训记录）。
after(async () => {
  for (const fn of cleanups.reverse()) {
    try { await fn() } catch (e) { console.error('清理失败：' + (e?.message ?? e)) }
  }
})

/** 起一个**真实的本地中继**（与 relay-e2e 同样的做法：RoomStore + handleRelay） */
async function startRelay() {
  const store = new RoomStore()
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const chunks = []
    for await (const c of req) chunks.push(c)
    const r = await handleRelay(new Request('http://relay' + req.url, {
      method: req.method,
      headers: Object.fromEntries(Object.entries(req.headers).filter(([, v]) => v !== undefined)),
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    }), url.pathname, store)
    res.writeHead(r.status)
    res.end(Buffer.from(await r.arrayBuffer()))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  cleanups.push(() => new Promise((r) => server.close(r)))
  return { base: `http://127.0.0.1:${server.address().port}`, store }
}

/** 造一个会话：密码 + 盐 → 房间名 + 一条像样的清单消息 */
function makeSession(password = 'open-test-password') {
  const salt = randomBytes(PARAMS.saltBytes)
  const keys = deriveKeys(deriveVerifier(password, salt))
  return {
    roomName: relayRoomName(keys),
    keys,
    manifestMessage: Buffer.concat([Buffer.from([0x01]), salt, randomBytes(64)]),
  }
}

const clientFor = (base, s) => new RelayClient({
  baseUrl: base, roomName: s.roomName, encKey: s.keys.enc, manifest: {},
})

const statusOf = async (base, room) => {
  const r = await fetch(`${base}/r/${room}/status`)
  assert.equal(r.status, 200, '房间应当存在')
  return r.json()
}

// ── 1. 正常开局 ─────────────────────────────────────────────

test('正常开局：房间由自己创建，清单落在 seq 0', async () => {
  const { base } = await startRelay()
  const s = makeSession()
  const c = clientFor(base, s)
  const created = await c.open(s.manifestMessage)

  assert.equal(created.created, true, '第一次 POST 应当创建房间')
  const st = await statusOf(base, s.roomName)
  assert.equal(st.nextSeq, 1, '清单必须已经投出去（nextSeq=1）')
  assert.equal(c.posted, 1, '本地计数也要与服务端对齐')

  // seq 0 的内容必须**就是**我们那条清单，一个字节都不能差
  const got = Buffer.from(await (await fetch(`${base}/r/${s.roomName}?seq=0`)).arrayBuffer())
  assert.deepEqual(got, s.manifestMessage)
})

// ── 2. 创建响应丢了（与攻击者无关的自身缺陷）───────────────

test('⭐ 创建响应在回程丢了 → 仍然要把清单投出去（否则整条传输静默失败）', async () => {
  const { base } = await startRelay()
  const s = makeSession()

  // 模拟"服务端已经建好房间、客户端没收到 created:true"的结果：
  // 房间存在，但里面一条消息都没有。
  await fetch(`${base}/r/${s.roomName}`, { method: 'POST' })
  assert.equal((await statusOf(base, s.roomName)).nextSeq, 0, '前置条件：空房间')

  const c = clientFor(base, s)
  const created = await c.open(s.manifestMessage)
  assert.equal(created.created, false, '这次拿到的当然是"已存在"')

  const st = await statusOf(base, s.roomName)
  assert.equal(st.nextSeq, 1,
    '清单必须被补投出去。\n' +
    '    旧行为是"房间已存在就跳过投递"，于是接收端永远等不到 seq 0，' +
    '    两分钟后报"等不到了" —— 而用户已经把链接发出去了。\n' +
    '    触发条件很平常：初始 POST 的响应在回程丢了（网络抖动、代理超时）。')

  const got = Buffer.from(await (await fetch(`${base}/r/${s.roomName}?seq=0`)).arrayBuffer())
  assert.deepEqual(got, s.manifestMessage, '补投的内容必须与清单一致')
})

// ── 3. 被抢占（文档说"风险为零"，实测不是）─────────────────

test('⭐ 房间被抢占 → 明确报 ROOM_TAKEN，而不是静默地把清单丢掉', async () => {
  const { base } = await startRelay()
  const s = makeSession()

  // 攻击者只需要**链接里的房间名**，不需要密码：建房间 + 占住 seq 0
  await fetch(`${base}/r/${s.roomName}`, { method: 'POST' })
  const junk = Buffer.from('attacker junk message that will never decrypt')
  const atk = await fetch(`${base}/r/${s.roomName}?seq=0`, { method: 'POST', body: junk })
  assert.equal(atk.status, 200)

  const c = clientFor(base, s)
  await assert.rejects(() => c.open(s.manifestMessage), (e) => {
    assert.equal(e.code, 'ROOM_TAKEN')
    // 报错要能指导用户：说清是什么事、怎么办
    assert.match(e.message, /房间名已经被占用/)
    assert.match(e.message, /链接/, '要指出房间名就在链接里')
    assert.match(e.message, /重新启动/, '要给出可执行的动作')
    return true
  })

  // 而且**不能**把自己的清单插进别人的房间里（那只会让接收端更困惑）
  const st = await statusOf(base, s.roomName)
  assert.equal(st.nextSeq, 1, '房间里应当还是只有攻击者那一条')
  const seq0 = Buffer.from(await (await fetch(`${base}/r/${s.roomName}?seq=0`)).arrayBuffer())
  assert.deepEqual(seq0, junk, 'seq 0 必须原封不动 —— 我们一个字节都没写进去')
})

test('被抢占时报的是不可重试的错误（重试一万次房间也还是别人的）', async () => {
  const { isTransientError } = await import('../src/relay/client.js')
  const { base } = await startRelay()
  const s = makeSession()
  await fetch(`${base}/r/${s.roomName}`, { method: 'POST' })
  await fetch(`${base}/r/${s.roomName}?seq=0`, { method: 'POST', body: Buffer.from('x') })

  const c = clientFor(base, s)
  let err = null
  try { await c.open(s.manifestMessage) } catch (e) { err = e }
  assert.ok(err, '应当抛错')
  assert.equal(isTransientError(err), false,
    'ROOM_TAKEN 不该被当成瞬时故障重试 —— 那只会让用户白等四轮退避')
})

// ── 4. 幂等：重复 open 不会污染房间 ─────────────────────────

test('对同一个房间再次 open（自己的房间已就绪）→ 不重复投清单', async () => {
  const { base } = await startRelay()
  const s = makeSession()
  const c1 = clientFor(base, s)
  await c1.open(s.manifestMessage)
  assert.equal((await statusOf(base, s.roomName)).nextSeq, 1)

  // 第二个客户端（比如发送端重连后新建的实例）看到房间已存在且非空：
  // 它无法判断里面是不是自己的清单，但**绝不能**再往 seq 0 插一条。
  const c2 = clientFor(base, s)
  await assert.rejects(() => c2.open(s.manifestMessage), (e) => e.code === 'ROOM_TAKEN')
  assert.equal((await statusOf(base, s.roomName)).nextSeq, 1,
    '房间里仍然只有一条消息 —— 没有把清单重复插进去')
})
