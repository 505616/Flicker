/**
 * 中继的**存储后端**插件（`relay/store` 贡献点）
 * ============================================
 *
 * 这个接缝补的是 `插件.md` §11 里那条"中继的存储后端插件：`relay/route` 只能观察与拦截，
 * 换不掉内存存储"。换存储和拦请求是两件不同的事。
 *
 * 判据分四层，缺一层都不算做完：
 *   ① **真的换了**：插件贡献的存储收到了 `create`/`put` 这些调用（不是"贡献了但没用上"）
 *   ② **没贡献时不变**：仍然用内置的 RoomStore（零开销，不能让没有插件的人受影响）
 *   ③ **写错了要当场说清**：缺方法 → 启动时报错，点名插件与缺的方法
 *      （否则传一半才 `store.ack is not a function`，没人查得出来是谁的问题）
 *   ④ **示例插件真能跑**：磁盘存储端到端走一遍，消息真的出现在磁盘上、ack 后真的删掉
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RoomStore } from '../src/relay/room.js'
import { handleRelay } from '../src/relay/protocol.js'
import { createPluginRegistry } from '../src/plugin/registry.js'
import { relayStoreFrom, describeStore, STORE_METHODS } from '../src/plugin/relay-store.js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const cleanups = []
test.after(async () => {
  for (const fn of cleanups.reverse()) {
    try { await fn() } catch (e) { console.error('清理失败：' + (e?.message ?? e)) }
  }
})

async function tmp(prefix = 'flicker-relay-store-') {
  const d = await mkdtemp(path.join(tmpdir(), prefix))
  cleanups.push(() => rm(d, { recursive: true, force: true }))
  return d
}

/** 起一个中继（用解析出来的存储），返回 base 与 store */
async function startRelay(store) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = Buffer.concat(chunks)
    const r = await handleRelay(new Request('http://relay' + req.url, {
      method: req.method,
      headers: Object.fromEntries(Object.entries(req.headers).filter(([, v]) => typeof v === 'string')),
      body: body.length ? body : undefined,
    }), url.pathname, store, {})
    const buf = Buffer.from(await r.arrayBuffer())
    const headers = {}
    r.headers.forEach((v, k) => { headers[k] = v })
    res.writeHead(r.status, headers)
    res.end(buf)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  cleanups.push(() => new Promise((r) => { server.closeAllConnections(); server.close(() => r()) }))
  return `http://127.0.0.1:${server.address().port}`
}

async function loadPlugin(source, name = 'store-probe.cjs') {
  const dir = await tmp()
  await writeFile(path.join(dir, name), source, 'utf8')
  const reg = createPluginRegistry({ log: () => {} })
  await reg.load([path.join(dir, name)])
  return reg
}

const ROOM = 'b'.repeat(64)

test('⭐ 插件贡献的存储在**真的被用上**（不是"贡献了但没人取"）', async () => {
  const reg = await loadPlugin(`
    const { RoomStore } = require(${JSON.stringify(path.join(root, 'src/relay/room.js'))})
    module.exports = { name: 'counting-store', apiVersion: 1, apply(ctx) {
      const inner = new RoomStore()
      const calls = []
      globalThis.__storeCalls = calls
      const wrap = (m) => (...a) => { calls.push(m); return inner[m](...a) }
      ctx.contribute('relay/store', () => ({
        maxMessageBytes: inner.maxMessageBytes,
        ttlMs: inner.ttlMs,
        create: wrap('create'), put: wrap('put'), putBatch: wrap('putBatch'),
        get: wrap('get'), ack: wrap('ack'), status: wrap('status'),
        destroy: wrap('destroy'), stats: wrap('stats'),
      }))
    } }`)

  const store = relayStoreFrom(reg, new RoomStore())
  assert.notEqual(store, undefined)
  assert.equal(describeStore(store), '插件的存储后端（counting-store）',
    '应当能说出这次用的是谁的存储 —— 中继上"到底哪份代码在处理我的房间"必须可查')

  const base = await startRelay(store)
  const created = await fetch(`${base}/r/${ROOM}`, { method: 'POST' })
  assert.equal(created.status, 200)
  const put = await fetch(`${base}/r/${ROOM}?seq=0`, { method: 'POST', body: 'hello' })
  assert.equal(put.status, 200)
  const got = await fetch(`${base}/r/${ROOM}?seq=0`)
  assert.equal(Buffer.from(await got.arrayBuffer()).toString(), 'hello')

  const calls = globalThis.__storeCalls
  assert.ok(calls.includes('create'), `插件的 create 没被调用（实际：${calls.join(',')}）`)
  assert.ok(calls.includes('put'), '插件的 put 没被调用')
  assert.ok(calls.includes('get'), '插件的 get 没被调用')
  delete globalThis.__storeCalls
})

test('没有插件 / 没人贡献 → 仍然是内置的 RoomStore（不能影响不用插件的人）', async () => {
  const fallback = new RoomStore()
  assert.equal(relayStoreFrom(null, fallback), fallback, 'plugins=null 时要原样用 fallback')
  const reg = await loadPlugin(`
    module.exports = { name: 'no-store', apiVersion: 1, apply(ctx) { ctx.on('relay/route', () => {}) } }`)
  assert.equal(relayStoreFrom(reg, fallback), fallback, '插件没贡献存储时也要用 fallback')
  assert.equal(describeStore(fallback), '内存（内置 RoomStore）')
})

test('⭐ 存储写错了：启动时当场报错，点名插件与缺的方法（不能等传到一半才炸）', async () => {
  const reg = await loadPlugin(`
    module.exports = { name: 'broken-store', apiVersion: 1, apply(ctx) {
      ctx.contribute('relay/store', () => ({
        maxMessageBytes: 1024,
        create() {}, put() {}, putBatch() {}, get() {},
        // 故意不写 ack / status / destroy / stats
      }))
    } }`)
  let err = null
  try { relayStoreFrom(reg, new RoomStore()) } catch (e) { err = e }
  assert.ok(err, '缺方法必须抛错 —— 静默接受等于把它拖到传输中途才暴露')
  assert.match(err.message, /broken-store/, '错误里要点名是哪个插件')
  for (const m of ['ack', 'status', 'destroy', 'stats']) {
    assert.match(err.message, new RegExp(m), `要指出缺少 ${m}`)
  }
  assert.match(err.message, /现在就报错/, '要解释为什么不把它拖到运行时')
})

test('⭐ 存储缺 maxMessageBytes 也要报错（那是能力协商的依据，缺了只能猜）', async () => {
  const reg = await loadPlugin(`
    module.exports = { name: 'no-caps', apiVersion: 1, apply(ctx) {
      const f = () => ({})
      ctx.contribute('relay/store', () => ({
        create: f, put: f, putBatch: f, get: f, ack: f, status: f, destroy: f, stats: f,
      }))
    } }`)
  assert.throws(() => relayStoreFrom(reg, new RoomStore()), /maxMessageBytes/)
})

test('⭐ 示例插件 relay-disk-store：消息真的落盘、ack 后真的删掉、销毁时清目录', async () => {
  const storeDir = await tmp('flicker-relay-disk-')
  const prev = process.env.FLICKER_RELAY_STORE_DIR
  process.env.FLICKER_RELAY_STORE_DIR = storeDir
  try {
    const reg = createPluginRegistry({ log: () => {} })
    await reg.load([path.join(root, 'examples', 'plugins', 'relay-disk-store.cjs')])
    const store = relayStoreFrom(reg, new RoomStore())
    assert.equal(describeStore(store), '插件的存储后端（relay-disk-store）')
    // 接口完整性：示例插件必须自己满足契约（不然文档里的例子是错的）
    for (const m of STORE_METHODS) assert.equal(typeof store[m], 'function', `示例存储缺少 ${m}`)

    const base = await startRelay(store)
    assert.equal((await fetch(`${base}/r/${ROOM}`, { method: 'POST' })).status, 200)
    assert.equal((await fetch(`${base}/r/${ROOM}?seq=0`, { method: 'POST', body: 'first' })).status, 200)
    assert.equal((await fetch(`${base}/r/${ROOM}?seq=1`, { method: 'POST', body: 'second' })).status, 200)

    const roomDir = path.join(storeDir, ROOM)
    assert.ok(existsSync(roomDir), '消息应当被写到磁盘上的房间目录里')
    const files = (await readdir(roomDir)).sort()
    assert.deepEqual(files, ['00000000.bin', '00000001.bin'], `磁盘上应当是两条消息，实际 ${files}`)

    // ack 掉第 0 条 → 磁盘上的那份也要删掉，第 1 条留着
    const ack = await fetch(`${base}/r/${ROOM}/ack?upTo=0`, { method: 'POST' })
    assert.equal(ack.status, 200)
    assert.deepEqual((await readdir(roomDir)).sort(), ['00000001.bin'],
      'ack 之后那条消息的磁盘副本应当被删掉（"用完即销毁"对落盘那一份同样成立）')

    // 销毁房间 → 整个目录消失
    assert.equal((await fetch(`${base}/r/${ROOM}`, { method: 'DELETE' })).status, 200)
    assert.equal(existsSync(roomDir), false, '销毁房间时磁盘目录也要清掉')
  } finally {
    if (prev === undefined) delete process.env.FLICKER_RELAY_STORE_DIR
    else process.env.FLICKER_RELAY_STORE_DIR = prev
  }
})
