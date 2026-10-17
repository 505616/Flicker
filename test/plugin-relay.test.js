/**
 * 插件系统：**中继平面**的测试
 * ============================
 * 中继与发送端的差别在于"谁装插件"：中继是**部署者**自己部署的服务，
 * 所以插件由部署者在启动命令里指定。但策略与语义完全一样：
 *   · 只认显式来源（`--plugin=` / `FLICKER_PLUGINS`），绝不自动发现；
 *   · `relay/route` 能拦下请求（鉴权、配额、IP 白名单），拦不下的放行；
 *   · 房间的建立与销毁会通知插件（真实生命周期，重复操作不重复通知）；
 *   · `relay/health` 能加字段，但**核心字段优先** —— 插件覆盖不了
 *     `maxMessageBytes`（那是能力协商的依据，被覆盖等于中继对客户端说谎）；
 *   · 插件资源在服务关闭时释放（`ctx.effect` → 销毁）。
 *
 * ⚠️ 用**内存里的真中继**（`createServer` + `handleRelay`，与 local.mjs 同一份代码路径）
 *    而不是直接调函数：这样连"插件看到的请求视图"和真实 HTTP 行为一起验了。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RoomStore } from '../src/relay/room.js'
import { handleRelay } from '../src/relay/protocol.js'
import { createPluginRegistry } from '../src/plugin/registry.js'
import { EVENTS, SLOTS } from '../src/plugin/events.js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const cleanups = []
test.after(async () => {
  for (const fn of cleanups.reverse()) {
    try { await fn() } catch (e) { console.error('清理失败：' + (e?.message ?? e)) }
  }
})

/** 起一个"带插件的中继"（与 relay/local.mjs 同一份代码路径） */
async function startRelayWith(pluginSource, { name = 'relay-probe.cjs' } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'flicker-relay-plugin-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  await writeFile(path.join(dir, name), pluginSource, 'utf8')

  const plugins = createPluginRegistry({ log: () => {} })
  await plugins.load([path.join(dir, name)])

  const store = new RoomStore()
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = Buffer.concat(chunks)
    const r = await handleRelay(new Request('http://relay' + req.url, {
      method: req.method,
      headers: Object.fromEntries(Object.entries(req.headers).filter(([, v]) => typeof v === 'string')),
      body: body.length ? body : undefined,
    }), url.pathname, store, { plugins })
    const buf = Buffer.from(await r.arrayBuffer())
    const headers = {}
    r.headers.forEach((v, k) => { headers[k] = v })
    res.writeHead(r.status, headers)
    res.end(buf)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  cleanups.push(() => new Promise((r) => { server.closeAllConnections(); server.close(() => r()) }))
  return { base: `http://127.0.0.1:${server.address().port}`, store, plugins, dir }
}

const ROOM = 'a'.repeat(64)

test('relay/route：插件能拦下请求（鉴权/配额/白名单），而且拦在**路由之前**（连 /health 也过这一关）', async () => {
  const { base } = await startRelayWith(`
    module.exports = { name: 'gate', apiVersion: 1, apply(ctx) {
      ctx.on('relay/route', (e) => {
        // 只放行带正确口令的请求 —— 最小的"自建中继访问控制"例子
        if (e.headers['x-token'] !== 'open-sesame') {
          return { status: 403, body: { error: 'FORBIDDEN', message: '口令不对' } }
        }
      })
    } }`)

  const denied = await fetch(`${base}/health`)
  assert.equal(denied.status, 403, '插件应当能拦下 /health —— 拦在路由之前')
  assert.match(await denied.text(), /FORBIDDEN/)

  const denied2 = await fetch(`${base}/r/${ROOM}?seq=0`, { method: 'POST' })
  assert.equal(denied2.status, 403, '房间接口同样要经过这一关')

  const allowed = await fetch(`${base}/health`, { headers: { 'x-token': 'open-sesame' } })
  assert.equal(allowed.status, 200, '带上口令就应当放行')
  const j = await allowed.json()
  assert.equal(j.ok, true)
  assert.ok(Number.isInteger(j.maxMessageBytes), '放行后仍要返回能力字段')
})

test('relay/route：插件自己抛错 → 500 且**点名是哪个插件**（中继上最难查的就是"谁干的"）', async () => {
  const { base } = await startRelayWith(`
    module.exports = { name: 'boom', apiVersion: 1, apply(ctx) {
      ctx.on('relay/route', () => { throw new Error('我的策略写错了') })
    } }`)
  const r = await fetch(`${base}/health`)
  assert.equal(r.status, 500)
  const j = await r.json()
  assert.equal(j.error, 'PLUGIN_ERROR')
  assert.match(j.message, /boom/, '要说是哪个插件出错了')
  assert.match(j.message, /我的策略写错了/, '也要带上插件自己的那句话')
})

test('relay/room-created 与 relay/room-destroyed：按真实生命周期通知，重复操作不重复通知', async () => {
  const { base, plugins } = await startRelayWith(`
    globalThis.__relayEvents = []
    module.exports = { name: 'audit', apiVersion: 1, apply(ctx) {
      ctx.on('relay/room-created', (e) => globalThis.__relayEvents.push('created:' + e.room.slice(0, 4)))
      ctx.on('relay/room-destroyed', (e) => globalThis.__relayEvents.push('destroyed:' + e.room.slice(0, 4)))
    } }`)
  assert.equal(plugins.count, 1)

  // 创建：`POST /r/:room` 不带 seq 就是"建房间"
  assert.equal((await fetch(`${base}/r/${ROOM}`, { method: 'POST' })).status, 200)
  // 再来一次：房间已存在，不该再报一次"已建立"
  assert.equal((await fetch(`${base}/r/${ROOM}`, { method: 'POST' })).status, 200)
  // 销毁
  assert.equal((await fetch(`${base}/r/${ROOM}`, { method: 'DELETE' })).status, 200)

  assert.deepEqual(globalThis.__relayEvents, ['created:aaaa', 'destroyed:aaaa'],
    '重复创建/重复销毁都不该重复通知：' + JSON.stringify(globalThis.__relayEvents))
  delete globalThis.__relayEvents
})

test('relay/health 贡献点：插件字段并进响应，但**核心字段优先**（覆盖不了 maxMessageBytes）', async () => {
  const { base, store } = await startRelayWith(`
    module.exports = { name: 'meta', apiVersion: 1, apply(ctx) {
      ctx.contribute('relay/health', () => ({ region: 'lab-1', operator: 'flicker-test' }))
      // 恶意/写错的插件：想改能力协商的依据 —— 必须无效
      ctx.contribute('relay/health', () => ({ maxMessageBytes: 1, protocol: 99, ok: false }))
    } }`)
  const j = await (await fetch(`${base}/health`)).json()
  assert.equal(j.region, 'lab-1', '插件加的字段要出现在 /health 里')
  assert.equal(j.operator, 'flicker-test')
  assert.equal(j.maxMessageBytes, store.maxMessageBytes,
    'maxMessageBytes 必须还是核心那个值 —— 被插件覆盖等于中继对客户端说谎')
  assert.equal(j.protocol, 1, '协议版本同理')
  assert.equal(j.ok, true, 'ok 同理')
})

test('中继平面用错钩子名（比如用了发送端的事件）→ apply 当场报错', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'flicker-relay-plugin-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  await writeFile(path.join(dir, 'wrong.cjs'),
    'module.exports = { name: "wrong", apiVersion: 1, ' +
    'apply(ctx) { ctx.on("room/created", () => {}) } }\n', 'utf8')
  const plugins = createPluginRegistry({ log: () => {} })
  await assert.rejects(() => plugins.load([path.join(dir, 'wrong.cjs')]), (e) => {
    assert.match(e.message, /不存在的事件 "room\/created"/)
    assert.match(e.message, /relay\/room-created/, '要把可用的名字列出来（照着改就行）')
    return true
  })
})

test('插件资源在服务关闭时释放（ctx.effect → 销毁清单的那一步）', async () => {
  const { plugins } = await startRelayWith(`
    globalThis.__relayDisposed = false
    module.exports = { name: 'holder', apiVersion: 1, apply(ctx) {
      ctx.effect(() => () => { globalThis.__relayDisposed = true })
    } }`)
  const step = await plugins.asDestroyStep()
  assert.equal(step, '已释放 1 项', '销毁那一步要如实报出释放了几项')
  assert.equal(globalThis.__relayDisposed, true, '清理函数必须真的被调用')
  assert.equal(await plugins.asDestroyStep(), false, '再关一次应当报"不适用"（幂等）')
  delete globalThis.__relayDisposed
})

test('真 CLI：relay/local.mjs 认 --plugin、打印实际端口、加载了什么打在屏幕上', { timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'flicker-relay-cli-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const pluginFile = path.join(dir, 'relay-meta.cjs')
  await writeFile(pluginFile, `
    module.exports = { name: 'relay-meta', version: '1.0.0', apiVersion: 1, apply(ctx) {
      ctx.contribute('relay/health', () => ({ region: 'cli-test' }))
    } }`, 'utf8')

  // ⚠️ `--port=0` 让系统分配端口，所以解析必须用**打印出来的实际端口** ——
  //    命令行里那个 0 连上去只会得到 ECONNREFUSED。
  const child = spawn(process.execPath,
    ['relay/local.mjs', '--port=0', `--plugin=${pluginFile}`],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  cleanups.push(() => { try { child.kill() } catch { /* 已退出 */ } })

  let out = ''
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`中继启动超时：\n${out}`)), 30000)
    child.stdout.on('data', (b) => {
      out += b.toString()
      const m = out.match(/监听: http:\/\/0\.0\.0\.0:(\d+)/)
      if (m) { clearTimeout(timer); resolve(`http://127.0.0.1:${m[1]}`) }
    })
    child.stderr.on('data', (b) => { out += b.toString() })
    child.on('exit', (code) => reject(new Error(`中继提前退出（code ${code}）：\n${out}`)))
  })

  // ⚠️ 插件横幅打在"监听"那几行**之后**，所以这里要等它出现再断言 ——
  //    一看到端口就断言会撞上竞态（第一版就是这么偶发失败的）。
  for (let i = 0; i < 50 && !/🧩/.test(out); i++) {
    await new Promise((r) => setTimeout(r, 100))
  }
  assert.match(out, /🧩 已加载 1 个插件：relay-meta@1\.0\.0/,
    `加载了什么必须打在屏幕上：\n${out}`)
  const j = await (await fetch(`${base}/health`)).json()
  assert.equal(j.region, 'cli-test', '真中继上插件贡献的字段也要生效')
  assert.equal(j.ok, true)

  try { child.kill() } catch { /* 已退出 */ }
})
