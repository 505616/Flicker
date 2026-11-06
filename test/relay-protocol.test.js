/**
 * 中继协议层测试（HTTP 边界）
 * ==========================
 * 用**真实的 Request/Response**（Node 内置）驱动协议层，
 * 不需要 Cloudflare 运行时，也不需要起服务器。
 *
 * 这里验证的是"发送端 ↔ 中继 ↔ 接收端"的契约，以及两条最重要的性质：
 *   ① **中继拿到的永远是密文**（它解不开，也读不到文件名）
 *   ② **光有房间号不够，还必须证明知道密码**（授权密钥）
 */
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { RoomStore, MAX_MESSAGE_BYTES, DEFAULT_MAX_MESSAGE_BYTES } from '../src/relay/room.js'
import { handleRelay, packMessage, unpackMessage, MSG } from '../src/relay/protocol.js'
import { deriveVerifier, deriveKeys, sealManifest, sealChunk, relayRoomName, PARAMS } from '../src/suite/flicker1.js'

const BASE = 'https://relay.example'
let store
let ROOM

before(() => {
  store = new RoomStore()
  const keys = deriveKeys(deriveVerifier('relay-test-password', randomBytes(PARAMS.saltBytes)))
  ROOM = relayRoomName(keys)
})

/** 发一个请求给协议层 */
function call(method, path, body) {
  const init = { method }
  if (body !== undefined) init.body = body
  return handleRelay(new Request(BASE + path, init), path.split('?')[0], store)
}

/** 造一个独立的房间（自己的密码 → 自己的房间名） */
function newRoom(password) {
  const keys = deriveKeys(deriveVerifier(password, randomBytes(PARAMS.saltBytes)))
  return { rid: relayRoomName(keys), keys }
}

const bytesOf = async (res) => new Uint8Array(await res.arrayBuffer())

// ── 基本路由 ────────────────────────────────────────────────

test('健康检查无副作用、不需要凭据，并且**顺便声明自己的能力**', async () => {
  for (let i = 0; i < 3; i++) {
    const r = await call('GET', '/health', undefined)
    assert.equal(r.status, 200)
    // 2026-10 起它返回 JSON：`maxMessageBytes` 是**能力协商**的入口 ——
    // 发送端据此决定"能发多大的块"。老中继返回的是纯文本 "ok"，
    // 客户端读不到字段就回落到协议保证的 1 MiB + 17（见 src/chunk-size.js）。
    const body = await r.json()
    assert.equal(body.ok, true)
    assert.equal(body.maxMessageBytes, store.maxMessageBytes,
      '声明的上限必须与 store 实际执行的限制是同一个值')
    assert.ok(Number.isInteger(body.maxMessageBytes) && body.maxMessageBytes > 0)
  }
  assert.equal(store.stats().rooms, 0, '健康检查不应创建房间')
})

test('OPTIONS 预检返回 CORS 头（浏览器会先发这个）', async () => {
  const r = await call('OPTIONS', `/r/${ROOM}`, undefined)
  assert.equal(r.status, 204)
  assert.equal(r.headers.get('access-control-allow-origin'), '*')
  assert.match(r.headers.get('access-control-allow-methods') ?? '', /POST/)
})

test('首页返回接收端页面', async () => {
  const r = await handleRelay(new Request(BASE + '/'), '/', store, {
    pageHtml: async () => '<!doctype html><h1>接收页</h1>',
  })
  assert.equal(r.status, 200)
  assert.match(await r.text(), /接收页/)
  assert.match(r.headers.get('content-type') ?? '', /text\/html/)
})

test('/send 返回网页发送端（与接收页对称）', async () => {
  const r = await handleRelay(new Request(BASE + '/send'), '/send', store, {
    senderHtml: async () => '<!doctype html><h1>发送页</h1>',
  })
  assert.equal(r.status, 200)
  assert.match(await r.text(), /发送页/)
  assert.match(r.headers.get('content-type') ?? '', /text\/html/)
  assert.match(r.headers.get('cache-control') ?? '', /no-store/, '页面不该被缓存（换版本后要立刻生效）')
})

test('/send 没配置时返回 501 并说清怎么办（不假装能发）', async () => {
  const r = await handleRelay(new Request(BASE + '/send'), '/send', store, {})
  assert.equal(r.status, 501)
  const text = await r.text()
  assert.match(text, /没有配置网页发送端/)
  assert.match(text, /flicker send --relay=/, '要告诉用户还有哪条路可走')
})

test('未知路径返回 404', async () => {
  assert.equal((await call('GET', '/nope')).status, 404)
  assert.equal((await call('GET', '/r/')).status, 404)
})

test('非法房间号被拒绝（400）', async () => {
  for (const bad of ['abc', 'ZZZZZZZZZZZZZZZZ', 'abcdef012345678', 'abcdef01234567890']) {
    const r = await call('GET', `/r/${bad}`)
    assert.equal(r.status, 400, `应拒绝房间号 ${bad}`)
    assert.equal((await r.json()).error, 'BAD_ROOM_ID')
  }
})

// ── 房间名即能力 ────────────────────────────────────────────

test('⭐ 房间名不可枚举：64 位十六进制，短标识一律拒绝', async () => {
  for (const bad of ['abc', 'abcdef0123456789', 'Z'.repeat(64), 'a'.repeat(63)]) {
    const r = await call('GET', `/r/${bad}`)
    assert.equal(r.status, 400, `应拒绝房间名 ${bad.slice(0, 20)}`)
    assert.equal((await r.json()).error, 'BAD_ROOM_ID')
  }
})

test('⭐ 密码不同 → 房间名不同，于是找不到对方的房间', () => {
  const a = newRoom('password-a')
  const b = newRoom('password-b')
  assert.notEqual(a.rid, b.rid)
  assert.match(a.rid, /^[0-9a-f]{64}$/)
  assert.equal(a.rid.length, 64, '128 bit 才够不可枚举')
})

test('⭐ 房间名不含密码的任何痕迹（单向派生）', () => {
  const { rid } = newRoom('a-very-distinctive-password')
  assert.equal(rid.includes(Buffer.from('a-very-distinctive-password').toString('hex')), false)
  assert.equal(rid.includes('password'), false)
  // 房间名与加密密钥必须来自不同的派生标签 —— 知道房间名不能推出加密密钥
  const keys = deriveKeys(deriveVerifier('x', randomBytes(PARAMS.saltBytes)))
  assert.notEqual(relayRoomName(keys), keys.enc.toString('hex'))
})

// ── 完整的一轮投递 ──────────────────────────────────────────

test('完整投递：发送端放入、接收端取走、逐条确认', async () => {
  const { rid, auth, keys } = newRoom('delivery-test')
  const salt = randomBytes(PARAMS.saltBytes)
  const manifest = { v: 1, files: [{ rel: 'a.bin', size: 3 * PARAMS.chunkBytes, chunks: 3 }] }
  const enc = sealManifest(keys.enc, Buffer.from(JSON.stringify(manifest), 'utf8'))

  const messages = [
    packMessage(MSG.MANIFEST, Buffer.concat([salt, enc.iv, enc.tag, enc.ct])),
    ...Array.from({ length: 3 }, (_, i) => {
      const { ct, tag } = sealChunk(keys.enc, 0, i, 3, randomBytes(PARAMS.chunkBytes))
      return packMessage(MSG.CHUNK, Buffer.concat([tag, ct]))
    }),
  ]

  const created = await call('POST', `/r/${rid}`, )
  assert.equal(created.status, 200)
  assert.equal((await created.json()).created, true)

  for (let i = 0; i < messages.length; i++) {
    const r = await call('POST', `/r/${rid}?seq=${i}`, messages[i])
    assert.equal(r.status, 200, `放第 ${i} 条应成功`)
    const j = await r.json()
    assert.equal(j.seq, i)
    assert.equal(j.nextSeq, i + 1)
  }

  const got = []
  for (let i = 0; i < messages.length; i++) {
    const r = await call('GET', `/r/${rid}?seq=${i}`, )
    assert.equal(r.status, 200, `取第 ${i} 条应成功`)
    assert.equal(r.headers.get('x-flicker-seq'), String(i))
    got.push(await bytesOf(r))
    assert.equal((await call('POST', `/r/${rid}/ack?upTo=${i}`, )).status, 200)
  }

  for (let i = 0; i < messages.length; i++) {
    assert.deepEqual(got[i], messages[i], `第 ${i} 条内容必须逐字节一致`)
  }

  const st = await (await call('GET', `/r/${rid}/status`, )).json()
  assert.equal(st.pending, 0, '全部取走后房间应为空')
  assert.equal(st.ackedBase, messages.length)
})

test('满块必须能被接受，且**上限精确**（多一个字节就 413）', async () => {
  // 边界回归：上限最初写成 1<<20，结果**任何满块都被 413 拒绝** ——
  // 小文件能传、大文件必挂，而且只在跨网络时出现。
  //
  // 2026-10 起有了能力协商：本项目部署的默认上限是 2 MiB + 17，
  // 而**协议保证的最小值**仍是 1 MiB + 17（老客户端按它来）。
  // 所以这里对**两个值**都验一遍"正好收下、多一字节就拒"，
  // 免得以后有人只改一处、另一处悄悄失守。
  const LIMITS = [
    ['协议保证的最小值', MAX_MESSAGE_BYTES],
    ['本项目部署的默认值', DEFAULT_MAX_MESSAGE_BYTES],
  ]
  for (const [label, limit] of LIMITS) {
    const local = new RoomStore({ maxMessageBytes: limit })
    const call2 = (method, path, body) =>
      handleRelay(new Request(BASE + path, {
        method, body: body ? Buffer.from(body) : undefined,
      }), path.replace(/\?.*/, ''), local)
    const rid = 'f'.repeat(64)
    assert.equal((await call2('POST', `/r/${rid}`)).status, 200)

    // 一条"满消息" = 类型字节 + 16 字节 tag + (limit - 17) 字节载荷
    const payload = limit - 17
    const full = packMessage(MSG.CHUNK, Buffer.concat([randomBytes(16), randomBytes(payload)]))
    assert.equal(full.length, limit, `${label}: 构造出来的应当是正好满的消息`)
    assert.equal((await call2('POST', `/r/${rid}?seq=0`, full)).status, 200,
      `${label}（${limit} 字节）的满消息必须被接受`)

    const over = packMessage(MSG.CHUNK, Buffer.concat([randomBytes(16), randomBytes(payload + 1)]))
    assert.equal((await call2('POST', `/r/${rid}?seq=1`, over)).status, 413,
      `${label}: 多一个字节就该 413`)
  }
})

// ── 错误情形 ────────────────────────────────────────────────

test('序号不连续 → 409，让丢包尽早暴露', async () => {
  const { rid, auth } = newRoom('seq-test')
  await call('POST', `/r/${rid}`, )
  await call('POST', `/r/${rid}?seq=0`, new Uint8Array([1, 2, 3]))
  const r = await call('POST', `/r/${rid}?seq=5`, new Uint8Array([1, 2, 3]))
  assert.equal(r.status, 409)
  assert.equal((await r.json()).error, 'BAD_SEQ')
})

test('还没到的消息 → 404 NOT_YET（接收端应继续等，而不是报错）', async () => {
  const { rid, auth } = newRoom('wait-test')
  await call('POST', `/r/${rid}`, )
  await call('POST', `/r/${rid}?seq=0`, new Uint8Array([1]))
  const r = await call('GET', `/r/${rid}?seq=7`, )
  assert.equal(r.status, 404)
  assert.equal((await r.json()).error, 'NOT_YET')
})

test('已确认删除的消息 → 410 GONE（与"还没到"要能区分）', async () => {
  const { rid, auth } = newRoom('gone-test')
  await call('POST', `/r/${rid}`, )
  await call('POST', `/r/${rid}?seq=0`, new Uint8Array([1]))
  await call('POST', `/r/${rid}?seq=1`, new Uint8Array([2]))
  await call('POST', `/r/${rid}/ack?upTo=0`, )
  const r = await call('GET', `/r/${rid}?seq=0`, )
  assert.equal(r.status, 410)
  assert.equal((await r.json()).error, 'GONE')
  assert.equal((await call('GET', `/r/${rid}?seq=1`, )).status, 200)
})

test('不存在的房间 → 404 NO_ROOM', async () => {
  const rid = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
  assert.equal((await call('GET', `/r/${rid}`)).status, 404)
  assert.equal((await call('GET', `/r/${rid}?seq=0`)).status, 404)
})

test('ack 缺参数或参数非法 → 400（不能悄悄当成 upTo=0）', async () => {
  const { rid, auth } = newRoom('ack-test')
  await call('POST', `/r/${rid}`, )
  // ⚠️ Number(null) / Number('') / Number(' ') 全都是 0 而不是 NaN ——
  //    只查 isNaN 会让"缺参数"变成一次有效确认。这个 JS 陷阱真实踩过。
  for (const q of ['', '?upTo=', '?upTo=%20', '?upTo=abc', '?upTo=-1', '?upTo=1.5', '?upTo=NaN', '?upTo=0x10']) {
    const r = await call('POST', `/r/${rid}/ack${q}`, )
    assert.equal(r.status, 400, `ack${q} 应返回 400，实际 ${r.status}`)
  }
  await call('POST', `/r/${rid}?seq=0`, new Uint8Array([1]))
  assert.equal((await call('POST', `/r/${rid}/ack?upTo=0`, )).status, 200)
})

test('销毁房间后立刻不可用', async () => {
  const { rid, auth } = newRoom('del-test')
  await call('POST', `/r/${rid}`, )
  await call('POST', `/r/${rid}?seq=0`, new Uint8Array([1]))
  assert.equal((await (await call('DELETE', `/r/${rid}`, )).json()).destroyed, true)
  assert.equal((await call('GET', `/r/${rid}/status`, )).status, 404)
})



// ── CSP：中继托管页面必须补上安全响应头（报告：中继页没有 CSP）──

test('接收页 / 发送页都带 CSP 与反嗅探头（XSS 时至少堵死外发）', async () => {
  const send = await handleRelay(new Request(BASE + '/send'), '/send', store, {
    senderHtml: async () => '<!doctype html><script>1</script>',
  })
  const home = await handleRelay(new Request(BASE + '/'), '/', store, {
    pageHtml: async () => '<!doctype html><script>1</script>',
  })
  for (const [label, r] of [['/send', send], ['/', home]]) {
    const csp = r.headers.get('content-security-policy') ?? ''
    assert.match(csp, /default-src 'none'/, `${label}: 必须有默认拒绝策略`)
    assert.match(csp, /script-src 'unsafe-inline'/, `${label}: 页面是内联脚本，必须允许 inline（CSP 是第二道闸）`)
    assert.match(csp, /connect-src 'self'/, `${label}: 只许连自己的中继`)
    assert.match(csp, /worker-src blob:/, `${label}: 接收页的摘要 Worker 用 Blob 建，缺了会退回主线程`)
    assert.match(csp, /frame-ancestors 'none'/, `${label}: 不许被任何站点套 iframe（点击劫持）`)
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer')
    assert.match(r.headers.get('cache-control') ?? '', /no-store/, `${label}: 页面不该被缓存`)
  }
})

// ── 非法 seq 不能被当成"创建房间"（P3-2）──────────────────────

test('POST ?seq=abc 必须 400，不能静默当成创建房间并把消息丢掉', async () => {
  const { rid } = newRoom('bad-seq')
  const r = await call('POST', `/r/${rid}?seq=abc`, new Uint8Array([1, 2, 3]))
  assert.equal(r.status, 400)
  assert.equal((await r.json()).error, 'BAD_SEQ')
  assert.equal(store.stats().rooms === 0 || !store.rooms.has(rid), true,
    '非法 seq 不该顺手创建出房间（旧行为会创建并返回 200）')
  // 空参数、小数、负号、十六进制同样拒绝
  for (const q of ['?seq=', '?seq=1.5', '?seq=-1', '?seq=0x10', '?seq=%20']) {
    const bad = await call('POST', `/r/${rid}${q}`, new Uint8Array([1]))
    assert.equal(bad.status, 400, `${q} 应 400`)
  }
  // 不写 seq 才是创建
  assert.equal((await call('POST', `/r/${rid}`)).status, 200)
})

// ── 请求体上限在**读之前**生效（P1-3）──────────────────────────

test('Content-Length 超限的 /batch 与单条 POST 在读取请求体之前就 413', async () => {
  const limit = store.maxMessageBytes
  // 造一个"一读就会失败"的假 Request：只要 arrayBuffer 被调用就说明先读了内存
  const fake = (path, contentLength) => {
    let reads = 0
    return {
      get reads() { return reads },
      request: {
        url: BASE + path,
        method: 'POST',
        headers: new Headers({ 'content-length': String(contentLength) }),
        arrayBuffer: async () => { reads++; throw new Error('不该读请求体') },
      },
    }
  }

  const batch = fake('/r/' + 'e'.repeat(64) + '/batch', 64 * limit + 4 * 64 + 1)
  const r1 = await handleRelay(batch.request, '/r/' + 'e'.repeat(64) + '/batch', store)
  assert.equal(r1.status, 413, '超过 /batch 上限必须 413')
  assert.equal((await r1.json()).error, 'TOO_LARGE')
  assert.equal(batch.reads, 0, 'Content-Length 已经说明超限，不该把请求体读进内存')

  const single = fake('/r/' + 'e'.repeat(64) + '?seq=0', limit + 1)
  const r2 = await handleRelay(single.request, '/r/' + 'e'.repeat(64), store)
  assert.equal(r2.status, 413, '超过单条上限必须 413')
  assert.equal(single.reads, 0, '单条 POST 也必须先看 Content-Length')
})

// ── 清单分帧（P1-2）：发送端/接收端共用的线格式 ──────────────

test('清单分帧：头 8 字节 = BE32(i)||BE32(partCount)，拼回后与 M 逐字节一致', async () => {
  const { packManifestParts, MAX_MANIFEST_PARTS } = await import('../src/relay/protocol.js')
  // 造一个 3 段的 M：每条上限 8 + 4 = 12 → partSize = 4
  const M = new Uint8Array(10).map((_, i) => i + 1)
  const parts = packManifestParts(M, 12)
  assert.equal(parts.length, 3, 'partSize=4、M=10 字节 → 3 段')
  const rebuilt = new Uint8Array(M.length)
  let off = 0
  for (let i = 0; i < parts.length; i++) {
    const dv = new DataView(parts[i].buffer)
    assert.equal(dv.getUint32(0), i, '第 i 段的头必须是 BE32(i)')
    assert.equal(dv.getUint32(4), parts.length, '头里必须带 partCount（接收端先取 seq=0 读它）')
    assert.ok(parts[i].length <= 12, '每段都不得超过中继声明的单条上限')
    const body = parts[i].subarray(8)
    rebuilt.set(body, off); off += body.length
  }
  assert.deepEqual(Buffer.from(rebuilt), Buffer.from(M), '拼回来必须与 M 逐字节一致（含类型字节）')
  // 单段也必须带 8 字节头 —— 接收端只处理一种格式
  const one = packManifestParts(new Uint8Array([1, 2, 3]), 1024)
  assert.equal(one.length, 1)
  assert.equal(new DataView(one[0].buffer).getUint32(4), 1)
  assert.deepEqual(Buffer.from(one[0].subarray(8)), Buffer.from([1, 2, 3]))
  // 上限：超过 1024 段必须明确报错，而不是无限分
  assert.equal(MAX_MANIFEST_PARTS, 1024)
  assert.throws(() => packManifestParts(new Uint8Array(1024 * 8 + 1), 9),
    (e) => e.code === 'MANIFEST_TOO_LARGE' && e.status === 413)
})

// ── 消息封装 ────────────────────────────────────────────────

test('消息封装的往返一致', () => {
  const payload = randomBytes(1000)
  for (const type of [MSG.MANIFEST, MSG.CHUNK]) {
    const packed = packMessage(type, payload)
    assert.equal(packed.length, payload.length + 1)
    const { type: t, payload: p } = unpackMessage(packed)
    assert.equal(t, type)
    assert.deepEqual(Buffer.from(p), payload)
  }
})

test('空消息被拒绝', () => {
  assert.throws(() => unpackMessage(new Uint8Array(0)), /消息为空/)
})

// ── 安全性质：中继看到的永远是密文 ──────────────────────────

test('⭐ 中继拿到的分块与明文没有任何可辨认的关系', async () => {
  const { rid, auth, keys } = newRoom('confidentiality')
  const marker = Buffer.from('SUPER-SECRET-MARKER-绝不应该是明文', 'utf8')
  const plain = Buffer.concat([marker, randomBytes(PARAMS.chunkBytes - marker.length)])
  const { ct, tag } = sealChunk(keys.enc, 0, 0, 1, plain)
  const packed = packMessage(MSG.CHUNK, Buffer.concat([tag, ct]))

  await call('POST', `/r/${rid}`, )
  await call('POST', `/r/${rid}?seq=0`, packed)
  const whole = Buffer.from(await bytesOf(await call('GET', `/r/${rid}?seq=0`, )))

  assert.equal(whole.indexOf(marker), -1, '明文标记绝不能出现在中继转发的数据里')
  assert.equal(whole.toString('utf8').includes('SUPER-SECRET'), false)
  assert.equal(whole.toString('latin1').includes('SECRET'), false)
})

test('⭐ 房间状态里不含任何内容相关的字段', async () => {
  const { rid, auth } = newRoom('status-check')
  await call('POST', `/r/${rid}`, )
  await call('POST', `/r/${rid}?seq=0`, new Uint8Array([1, 2, 3]))

  const st = await (await call('GET', `/r/${rid}/status`, )).json()
  const allowed = new Set(['roomId', 'pending', 'ackedBase', 'nextSeq', 'ageMs', 'idleMs', 'ttlMs'])
  for (const k of Object.keys(st)) {
    assert.ok(allowed.has(k), `房间状态里出现了不该有的字段: ${k}`)
  }
})

test('worker.js 不含任何持久化设施（消息只在内存）', async () => {
  // 这是"设计成不可持久化"的断言：若有人加了 KV/D1/R2/DO，这条会失败，
  // 提醒他重新审视"用完即销毁"的承诺。
  const src = await readFile(new URL('../relay/worker.js', import.meta.url), 'utf8')
  for (const forbidden of ['D1', 'R2Bucket', 'DurableObject', 'env.DB', 'env.KV']) {
    assert.equal(src.includes(forbidden), false,
      `worker.js 里出现了持久化设施 ${forbidden} —— 消息只应存在于内存`)
  }
})
