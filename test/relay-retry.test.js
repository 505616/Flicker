/**
 * 瞬时故障重试。
 *
 * 为什么这些用例值得写：重试看着简单，但有两个真会咬人的地方 ——
 *
 *   ① **分类错了就白等**。把"房间不存在"当瞬时故障重试，
 *      用户会盯着屏幕等 4 轮退避（约 4.5 秒）才看到真正的错误。
 *      反过来把网络抖动当致命错误，几十 GB 的传输就白费了。
 *
 *   ② **batch POST 的失败语义是模糊的**。请求可能已经在服务端成功，
 *      只是响应在回程丢了。盲目重发会在房间尾部多出一批重复消息。
 *      协议给的判据是：序号由**服务端**分配（nextSeq）——
 *      重试前读一次状态就知道上一次到底落库没有。
 *      这个用例就是钉住这件事的。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { RoomStore } from '../src/relay/room.js'
import { handleRelay } from '../src/relay/protocol.js'
import { RelayClient, isTransientError, RelayAborted } from '../src/relay/client.js'
import { deriveVerifier, deriveKeys, relayRoomName, PARAMS } from '../src/suite/flicker1.js'

// ── 分类判据 ────────────────────────────────────────────────

test('瞬时故障分类：网络类错误要重试', () => {
  const netErr = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
  })
  assert.equal(isTransientError(netErr), true, '连接重置必须重试 —— 这是长传输最常见的失败')

  const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' })
  assert.equal(isTransientError(timeout), true, '超时必须重试')

  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
  assert.equal(isTransientError(abort), true, '超时用的 AbortSignal 也归为瞬时')

  assert.equal(isTransientError(null, 503), true, '5xx 必须重试')
  assert.equal(isTransientError(null, 429), true, '429 必须重试')
})

test('瞬时故障分类：这些**绝不能**重试（重试也不会变好，只会让用户白等）', () => {
  // 房间真没了
  for (const code of ['NO_ROOM', 'EXPIRED', 'GONE']) {
    assert.equal(isTransientError(Object.assign(new Error('x'), { code })), false,
      `${code} 重试一万次也不会变出来，必须立刻报错`)
  }
  // 请求本身有问题
  for (const code of ['BAD_SEQ', 'BAD_ROOM_ID', 'TOO_LARGE', 'EMPTY_BATCH', 'BATCH_TOO_LARGE']) {
    assert.equal(isTransientError(Object.assign(new Error('x'), { code })), false, `${code} 不该重试`)
  }
  // 用户点了取消
  assert.equal(isTransientError(new RelayAborted('test')), false, '用户取消不能触发重试')
  // 4xx（除 429）
  assert.equal(isTransientError(null, 400), false)
  assert.equal(isTransientError(null, 404), false)
  assert.equal(isTransientError(null, 413), false)
  // 不认识的普通错误：宁可不重试，也不要制造"卡住"的错觉
  assert.equal(isTransientError(new Error('whatever')), false)
})

// ── putBatch 重试的幂等性 ───────────────────────────────────

/** 起一个可注入"故障"的假中继：第 failAt 次 POST /batch 收下数据后不回响应 */
async function startFlakyRelay({ failAt = 0 } = {}) {
  const store = new RoomStore()
  let batchCount = 0
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = Buffer.concat(chunks)

    const isBatch = url.pathname.endsWith('/batch') && req.method === 'POST'
    if (isBatch) batchCount++

    const r = await handleRelay(new Request('http://relay' + req.url, {
      method: req.method, body: body.length ? body : undefined,
    }), url.pathname, store)
    const buf = Buffer.from(await r.arrayBuffer())

    // ⚠️ 关键：数据**已经进房间了**（handleRelay 已执行），但响应丢弃、
    //    连接直接掐断 —— 这精确模拟"请求成功、响应在回程丢了"。
    if (isBatch && batchCount === failAt) {
      req.socket.destroy()
      return
    }

    const h = {}
    r.headers.forEach((v, k) => { h[k] = v })
    res.writeHead(r.status, h)
    res.end(buf)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    store,
    batches: () => batchCount,
    close: () => new Promise((r) => server.close(r)),
  }
}

function makeClient(base, blocks) {
  const salt = randomBytes(PARAMS.saltBytes)
  const keys = deriveKeys(deriveVerifier('retry-test', salt))
  const roomName = relayRoomName(keys)
  // 用内存里的 _bytes 伪装成文件内容，免得真的建临时文件
  const files = [{
    kind: 'file', name: 'a.bin', rel: 'a.bin',
    size: blocks * PARAMS.chunkBytes, chunks: blocks,
    chunkBytes: PARAMS.chunkBytes, sha256: 'x',
    index: 0, firstChunk: 0, absPath: '/nonexistent',
    _bytes: randomBytes(blocks * PARAMS.chunkBytes), _gift: false,
  }]
  const manifest = {
    name: 't', files, totalChunks: blocks, totalBytes: files[0].size,
  }
  const client = new RelayClient({
    baseUrl: base, roomName, encKey: keys.enc, manifest,
    retries: 4, sleep: () => Promise.resolve(),      // 测试里不等退避
  })
  return { client, roomName, keys, files }
}

test('⭐ 重试不会造成重复投递：请求其实已落库、只是响应丢了', async () => {
  const relay = await startFlakyRelay({ failAt: 1 })   // 第 1 次 batch 掐断响应
  try {
    const { client, roomName } = makeClient(relay.base, 3)
    await client.open(Buffer.from('manifest'))
    assert.equal(client.posted, 1, 'open 之后应只有清单那一条')
    assert.equal(relay.batches(), 0, 'open 阶段不该有 batch 请求')

    // 这一批投 3 块。第一次 POST 会被掐断，但数据已经进房间了。
    await client.putBatch(1, 3)

    // ── 核心断言 ──
    // 正确的行为是：发现"上一次其实成功了"，于是**不再重发**，改为读状态对齐。
    // 所以 batch 请求**总数仍然是 1** —— 若这里是 2，说明同一批被投了两遍。
    assert.equal(relay.batches(), 1,
      '重试路径必须先确认上一次是否已落库；确认已落库就**不能再发一次**。' +
      '若这里是 2，接收端会白取一遍重复消息')

    const st = await (await fetch(`${relay.base}/r/${roomName}`)).json()
    assert.equal(st.nextSeq, 4,
      `房间里的消息数必须正好一份：期望 4（清单+3块），实际 ${st.nextSeq}`)
    assert.equal(client.posted, 4, 'posted 应与服务端对齐')
    assert.equal(client.retryCount, 1, '应记录到 1 次重试（用于告知用户链路不稳）')
  } finally { await relay.close() }
})

test('重试真的会重发：请求根本没到服务端（连接被拒）', async () => {
  // 先用一个只接一次请求的服务器拿到一个"死"端口号
  const dead = createServer(() => {})
  await new Promise((r) => dead.listen(0, '127.0.0.1', r))
  const deadPort = dead.address().port
  await new Promise((r) => dead.close(r))

  const relay = await startFlakyRelay({ failAt: 0 })
  try {
    const { client } = makeClient(relay.base, 2)
    // 把第一次请求指向死端口，之后的请求回到真中继
    let first = true
    const realFetch = globalThis.fetch
    globalThis.fetch = (url, init) => {
      if (first && String(url).includes('/batch')) {
        first = false
        return realFetch(String(url).replace(relay.base, `http://127.0.0.1:${deadPort}`), init)
      }
      return realFetch(url, init)
    }
    try {
      await client.open(Buffer.from('manifest'))
      await client.putBatch(1, 2)
    } finally { globalThis.fetch = realFetch }

    assert.equal(client.posted, 3, '重试成功后 posted 应推进到 3')
    assert.ok(client.retryCount >= 1, '应至少重试一次')
  } finally { await relay.close() }
})

test('房间不存在时不重试 —— 立刻报错，不让用户白等', async () => {
  const relay = await startFlakyRelay()
  try {
    const { client } = makeClient(relay.base, 2)
    await client.open(Buffer.from('manifest'))
    // 绕过正常流程直接删房间（模拟"中继上房间过期了"）
    await fetch(`${relay.base}/r/${client.room}`, { method: 'DELETE' })

    const t0 = Date.now()
    await assert.rejects(() => client.putBatch(client.posted, 2), (e) => {
      assert.equal(e.code, 'NO_ROOM')
      return true
    })
    assert.equal(client.retryCount, 0, 'NO_ROOM 不该触发任何重试')
    assert.ok(Date.now() - t0 < 2000, '必须立刻失败，不能耗在退避上')
  } finally { await relay.close() }
})



// ── P1-1：没有新数据可投时必须按 pollMs 等待（不能死循环 status）──────

test('⭐ 数据已全部投出、只等最后几个 ack 时：status 调用必须被 pollMs 节流', async () => {
  const { RelaySender } = await import('../src/relay/sender.js')
  const sender = new RelaySender({
    baseUrl: 'http://127.0.0.1:1', // 不会真的请求（client 被替换）
    roomName: 'a'.repeat(64),
    encKey: Buffer.alloc(32),
    salt: Buffer.alloc(16),
    manifest: { files: [], totalChunks: 0, totalBytes: 0 },
    encManifest: { iv: Buffer.alloc(12), tag: Buffer.alloc(16), ct: Buffer.alloc(0) },
    pollMs: 100,
    windowSize: 8,
  })

  let statusCalls = 0
  // 模拟"清单+数据全投完了，接收端还剩几条没确认"：
  // posted=1=total，ackedBase=0 → planWindow 不会再投，但也没完成。
  sender.client = {
    posted: 1,
    ackedBase: 0,
    bytesPosted: 0,
    manifestParts: 1,
    totalMessages: 1,
    // ⚠️ 只提供带重试的入口：若发送端退回直接调 status()，这里会 TypeError 当场失败
    statusWithRetry: async () => {
      statusCalls++
      return { ackedBase: 0, nextSeq: 1, pending: 1 }
    },
    putBatch: async () => { throw new Error('这一轮不该再投递') },
    destroy: async () => true,
  }

  const t0 = Date.now()
  const result = await sender.run({ timeoutMs: 350 })
  const elapsed = Date.now() - t0

  assert.equal(result.reason, 'timeout', '一直等不到确认 → 如实超时')
  assert.ok(elapsed >= 250, `应等到空闲超时（实际 ${elapsed}ms）`)
  assert.ok(statusCalls <= 6,
    `没有新数据可投时必须按 pollMs 等待；实际 ${statusCalls} 次 status（旧实现 100ms 内 90 万次）`)
  assert.ok(statusCalls >= 2, '也不能一次都不问（那样永远不知道对方确认了没有）')
})

// ── P1-4：状态轮询要走重试（一次 5xx 不该废掉整次传输）───────────

test('状态轮询遇到一次瞬时 503 → 自动重试后成功（/batch 早就这么做了）', async () => {
  let hits = 0
  const server = createServer((req, res) => {
    hits++
    if (hits === 1) {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'UNAVAILABLE', message: '临时不可用' }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ackedBase: 0, nextSeq: 0, pending: 0 }))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try {
    const client = new RelayClient({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      roomName: 'a'.repeat(64),
      encKey: Buffer.alloc(32),
      manifest: { files: [], totalChunks: 0 },
      retries: 2,
      sleep: () => Promise.resolve(),
    })
    const st = await client.statusWithRetry()
    assert.equal(st.nextSeq, 0, '重试后应拿到真实状态')
    assert.equal(hits, 2, '一次 503 之后应当再试一次')
    assert.equal(client.retryCount, 1, '要记录到一次重试（供 UI 显示"链路不稳"）')
  } finally {
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
  }
})

// ── P2-2：请求超时随体积放大（慢上行不会被固定 30s 掐断）────────

test('P2-2：/batch 的超时按体积放大，且有上限', () => {
  const client = new RelayClient({
    baseUrl: 'http://x', roomName: 'a'.repeat(64),
    encKey: Buffer.alloc(32), manifest: { files: [], totalChunks: 0 },
  })
  assert.equal(client._timeoutFor(0), 30_000, '无请求体（GET/创建）就是基础超时')
  // 16 MiB 满窗：30s + 16 MiB / 64 KB/s = 30s + 256s
  assert.equal(client._timeoutFor(16 << 20), 30_000 + 256_000)
  assert.equal(client._timeoutFor(2 ** 30), client.maxTimeout, '必须有封顶，不能无限等')
  assert.ok(client.maxTimeout <= 15 * 60 * 1000)
})

test('彻底失败时退回记账：进度条不会显示一个永远到不了的数字', async () => {
  const relay = await startFlakyRelay({ failAt: 1 })
  // 把中继整个关掉，制造一个"怎么重试都不行"的局面
  const { client } = makeClient(relay.base, 3)
  await client.open(Buffer.from('manifest'))
  const before = client.bytesPosted

  await relay.close()          // 端口没了 → 每次都是网络错误
  await assert.rejects(() => client.putBatch(1, 3))

  assert.equal(client.bytesPosted, before,
    `失败的批次必须把已计入的字节退回去（before=${before}，after=${client.bytesPosted}）`)
})
