/**
 * 中继**适配层**的测试：relay/worker.js（Cloudflare）与 relay/local.mjs（本地）
 * =====================================================================
 *
 * 为什么单独一个文件：协议层（src/relay/protocol.js）已经被单测覆盖，但
 * "适配层"从前**一次都没有被 import 过** —— 于是 relay/worker.js 里漏掉
 * `SENDER_HTML` 的 import 也没人发现：生产环境的 /send 恒定 500，
 * 而所有测试都直接调 handleRelay、自己传 senderHtml，照样全绿。
 *
 * 这个文件做两件事：
 *   ① 真正 import relay/worker.js，走它的 fetch —— 覆盖 /、/send、/health；
 *   ② 起一个**真实的** relay/local.mjs 子进程，覆盖它的崩溃路径与请求体上限：
 *      客户端声明 Content-Length 后断开，进程必须仍然存活（P0-3）。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchRelayCaps } from '../src/chunk-size.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cleanups = []
after(async () => {
  for (const fn of cleanups.reverse()) {
    try { await fn() } catch (e) { console.error('清理失败：' + (e?.message ?? e)) }
  }
})

// ══════════════════════════════════════════════════════════════
// ① Cloudflare Worker 适配层（真正 import relay/worker.js）
// ══════════════════════════════════════════════════════════════

test('⭐ worker.js 真的能响应 /、/send、/health（漏 import 会让 /send 必 500）', async () => {
  const worker = (await import('../relay/worker.js')).default
  const call = (p) => worker.fetch(new Request('https://relay.example' + p), {}, {})

  const health = await call('/health')
  assert.equal(health.status, 200, '/health 必须 200')
  const h = await health.json()
  assert.equal(h.ok, true)
  assert.ok(Number.isInteger(h.maxMessageBytes) && h.maxMessageBytes > 0,
    '/health 要声明能力（客户端据此选块大小）')

  const home = await call('/')
  assert.equal(home.status, 200, '接收页必须 200')
  const homeHtml = await home.text()
  assert.match(homeHtml, /<html/i, '接收页应当是一段 HTML')
  assert.match(home.headers.get('content-type') ?? '', /text\/html/)
  assert.match(home.headers.get('content-security-policy') ?? '', /default-src 'none'/,
    '接收页要带 CSP（中继托管页面不能没有）')

  const send = await call('/send')
  assert.equal(send.status, 200,
    '/send 必须 200 —— 从前 worker.js 没 import SENDER_HTML，' +
    '这里会抛 ReferenceError，Cloudflare 上就是裸 500（手机传手机整条路不可用）')
  const sendHtml = await send.text()
  assert.ok(sendHtml.length > 1000, '/send 应当返回完整的发送页（不是空响应）')
  assert.match(sendHtml, /FlickerSender/, '发送页里必须有网页发送端内核')
  assert.match(sendHtml, /<html/i)
  assert.match(send.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/,
    '发送页同样要有 CSP（含 frame-ancestors）')
  assert.match(send.headers.get('content-security-policy') ?? '', /worker-src blob:/,
    '接收页的摘要 Worker 需要 worker-src blob:')
})

test('worker.js 对未知路径给 404（而不是抛异常）', async () => {
  const worker = (await import('../relay/worker.js')).default
  const r = await worker.fetch(new Request('https://relay.example/nope'), {}, {})
  assert.equal(r.status, 404)
})

// ══════════════════════════════════════════════════════════════
// ② 本地中继子进程（relay/local.mjs）
// ══════════════════════════════════════════════════════════════

/** 起一个真实的 relay/local.mjs（--port=0 让系统分配端口），等它打出真实端口 */
function startLocalRelay() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'relay', 'local.mjs'), '--port=0'], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, cwd: ROOT,
    })
    cleanups.push(() => { try { child.kill() } catch { /* 已退出 */ } })
    let out = ''
    const onData = (buf) => {
      out += buf.toString()
      const m = out.match(/监听: http:\/\/0\.0\.0\.0:(\d+)/)
      if (m) resolve({ child, base: `http://127.0.0.1:${m[1]}`, getOut: () => out })
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', (b) => { out += b.toString() })
    child.on('exit', (code) => reject(new Error(`本地中继提前退出（code ${code}）\n${out}`)))
    setTimeout(() => reject(new Error('本地中继 15 秒内没打出口令端口\n' + out)), 15000).unref?.()
  })
}

async function waitFor(fn, ms = 5000, step = 50) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, step))
  }
  return false
}

/** 用裸 socket 发一段 HTTP 请求头（不读响应），返回 socket */
function rawRequest(base, { method = 'POST', path: p, contentLength, body = '' }) {
  const u = new URL(base)
  const sock = connect(Number(u.port), u.hostname)
  sock.write(`${method} ${p} HTTP/1.1\r\nHost: ${u.hostname}\r\n` +
    `Content-Length: ${contentLength}\r\nConnection: close\r\n\r\n` + body)
  return sock
}

test('⭐ 半截请求（声明 1 MB 只发 10 字节后断开）不能打死本地中继进程', { timeout: 60000 }, async () => {
  const relay = await startLocalRelay()
  const room = 'a'.repeat(64)

  // 先确认它活着
  assert.equal((await fetch(`${relay.base}/health`)).status, 200)

  // 真实复现 P0-3：声明 Content-Length: 1000000，只发 10 字节，然后 destroy。
  // 旧实现里 for await 会抛 ECONNRESET，async 回调 reject 无人接 → 进程 exit 1。
  await new Promise((resolve) => {
    const sock = rawRequest(relay.base, {
      path: `/r/${room}?seq=0`, contentLength: 1000000, body: '0123456789',
    })
    sock.on('error', () => { /* 主动 destroy 会报 ECONNRESET，忽略 */ })
    setTimeout(() => { sock.destroy(); resolve() }, 120)
  })

  // 给进程一点时间把错误路径走完（旧实现此时已经 exit 1）
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(relay.child.exitCode, null,
    `客户端中途断开后进程必须存活（实际 exitCode=${relay.child.exitCode}）\n${relay.getOut()}`)

  const health = await fetch(`${relay.base}/health`)
  assert.equal(health.status, 200, '断开之后 /health 仍应 200（进程没崩、房间没被清空）')
})

test('本地中继：超大的 Content-Length 在读取前就被 413（不能无上限缓存请求体）', { timeout: 60000 }, async () => {
  const relay = await startLocalRelay()
  const room = 'b'.repeat(64)
  // 默认单条上限 2 MiB + 17，/batch 上限 = 64 × 单条 + 长度前缀 ≈ 128 MiB。
  // 声明 999999999 字节远大于它 —— 必须 413，而不是开始读（更不能 OOM）。
  const status = await new Promise((resolve, reject) => {
    const sock = rawRequest(relay.base, {
      path: `/r/${room}/batch`, contentLength: 999999999, body: '',
    })
    let buf = ''
    sock.on('data', (b) => { buf += b.toString('latin1') })
    sock.on('end', () => resolve(Number((buf.match(/^HTTP\/1\.1 (\d+)/) ?? [])[1])))
    sock.on('error', reject)
    setTimeout(() => { sock.destroy(); resolve(Number((buf.match(/^HTTP\/1\.1 (\d+)/) ?? [])[1])) }, 3000)
  })
  assert.equal(status, 413, '超过请求体上限必须 413')
  assert.equal((await fetch(`${relay.base}/health`)).status, 200, '拒绝之后进程仍应存活')
})

test('本地中继：--port=abc 给出可读提示而不是 ERR_SOCKET_BAD_PORT', { timeout: 30000 }, async () => {
  const child = spawn(process.execPath, [path.join(ROOT, 'relay', 'local.mjs'), '--port=abc'], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, cwd: ROOT,
  })
  let err = ''
  child.stderr.on('data', (b) => { err += b.toString() })
  const code = await new Promise((resolve) => child.on('exit', resolve))
  assert.equal(code, 2)
  assert.match(err, /--port/)
  assert.ok(!/ERR_SOCKET_BAD_PORT/.test(err), '不该把 Node 内部错误名甩给用户')
})




// ══════════════════════════════════════════════════════════════
// ⑤ 网页发送端内核（web/sender-core.js，浏览器端）
// ══════════════════════════════════════════════════════════════

/** 在 vm 里加载 sender-core.js（它要求 globalThis.FlickerPhone 存在） */
function loadWebSenderCore() {
  const code = readFileSync(path.join(ROOT, 'web', 'sender-core.js'), 'utf8')
  const sandbox = {
    FlickerPhone: { PARAMS: { saltBytes: 16 } },
    console, setTimeout, clearTimeout,
    Uint8Array, DataView, Error, Promise,
    TextEncoder: globalThis.TextEncoder,
    fetch: async () => { throw new Error('这条用例不该真的发请求') },
  }
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox)
  return sandbox.FlickerSender
}

function newWebSender() {
  const { Sender } = loadWebSenderCore()
  const s = new Sender({ relayUrl: 'http://relay.invalid', password: 'x', files: [] })
  s.manifest = { files: [], totalChunks: 0, totalBytes: 0 }
  s.manifestParts = 1
  s.posted = 0
  s.ackedBase = 0
  s.windowSize = 4
  return s
}

test('网页发送端：总消息数 = 清单分片数 + 数据块数（清单分片存的是条数，不是数组）', () => {
  const s = newWebSender()
  s.manifest = { files: [], totalChunks: 7, totalBytes: 0 }
  s.manifestParts = 3
  assert.equal(s.totalMessages, 10)
  assert.equal(typeof s.manifestParts, 'number')
  // 静态守卫：start() 里把 packManifestParts(...) 的结果赋给 manifestParts 时
  // 必须取 .length —— 忘了它会让 totalMessages 变成字符串拼接。
  const src = readFileSync(path.join(ROOT, 'web', 'sender-core.js'), 'utf8')
  assert.match(src, /this\.manifestParts = parts\.length|this\.manifestParts = packManifestParts\([^)]*\)\.length/,
    'manifestParts 必须是条数（取 .length），不能直接存分片数组')
})

test('网页发送端：取消（ABORTED）是正常结束 —— run() 不能 reject（否则页面显示"出错了"）', async () => {
  const s = newWebSender()
  const events = []
  s.onEvent = (e) => events.push(e)
  s._putBatch = async () => {
    throw Object.assign(new Error('已取消'), { code: 'ABORTED' })
  }
  const result = await s.run({ timeoutMs: 2000 })   // 用 await 而非 assert.rejects
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'aborted')
  assert.ok(events.some((e) => e.type === 'incomplete' && e.reason === 'aborted'),
    '应当 emit incomplete/aborted（页面据此显示"已取消"，而不是错误）')
})

test('网页发送端：stop() 先等在途 batch 结束，再发 DELETE（消除取消竞态）', async () => {
  const s = newWebSender()
  const order = []
  s._inFlight = new Promise((resolve) => {
    setTimeout(() => { order.push('batch'); resolve() }, 25)
  })
  s._fetch = async () => { order.push('delete'); return { ok: true } }
  await s.stop()
  assert.deepEqual(order, ['batch', 'delete'],
    'DELETE 必须排在在途 POST 之后 —— 否则正常的取消会因竞态变成 NO_ROOM 错误')
})

test('网页发送端：没有新数据可投时也按 pollMs 等待（不能死循环 status）', async () => {
  const s = newWebSender()
  s.posted = 1            // 全部消息（清单 1 条）已投完
  s.manifest = { files: [], totalChunks: 0, totalBytes: 0 }
  s.pollMs = 5
  let calls = 0
  s._status = async () => {
    calls++
    return { ackedBase: 0, nextSeq: 1, pending: 1 }
  }
  const result = await s.run({ timeoutMs: 80 })
  assert.equal(result.reason, 'timeout')
  assert.ok(calls <= 40,
    `没有新数据可投时必须等 pollMs；实际 ${calls} 次 status（旧实现同 Node 端一样死循环）`)
})

// ══════════════════════════════════════════════════════════════
// ④ 部署脚本（relay/deploy.mjs）的只读语义
// ══════════════════════════════════════════════════════════════

test('deploy.mjs --check 真正只读：不写生成产物、不联网，且明确说出来', { timeout: 60000 }, async () => {
  const files = ['relay/page.generated.js', 'relay/sender.generated.js', 'relay/wrangler.toml']
  const before = files.map((f) => readFileSync(path.join(ROOT, f), 'utf8'))

  const run = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'relay', 'deploy.mjs'), '--check'], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    let out = ''
    child.stdout.on('data', (b) => { out += b.toString() })
    child.stderr.on('data', (b) => { out += b.toString() })
    child.on('exit', (code) => resolve({ code, out }))
  })

  const after = files.map((f) => readFileSync(path.join(ROOT, f), 'utf8'))
  assert.deepEqual(after, before,
    '--check 不许写任何仓库文件（从前它会跑不带 --check 的生成器，把产物改掉）')
  assert.match(run.out, /未写任何文件、未联网/,
    '--check 必须明确自己是只读的')
  assert.match(run.out, /接收页产物|接收页产物与源文件一致/,
    '--check 应当同时核对接收页与发送页两个产物')
  assert.ok(run.code === 0 || run.code === 1,
    `--check 只该用 0/1 表示产物是否同步，实际退出码 ${run.code}`)
})

test('deploy.mjs 的登录诊断能拿到输出（stdio:inherit 会让 out 恒为空 → 死代码）', () => {
  const src = readFileSync(path.join(ROOT, 'relay', 'deploy.mjs'), 'utf8')
  // login 必须 pipe 输出，否则 runNpx 返回的 out 是空串，下面"连不上控制台"的
  // 那段排查指引永远不会显示。
  assert.match(src, /login'\][\s\S]{0,160}stdio: \['inherit', 'pipe', 'pipe'\]/,
    'wrangler login 必须用 pipe 捕获输出（同时再打印给用户）')
  assert.ok(!/wrangler@latest', 'login'\s*\}\s*\)/.test(src),
    'login 调用必须带选项')
})

// ══════════════════════════════════════════════════════════════
// ③ 能力探测超时（fetchRelayCaps 不能把 CLI 启动挂死）
// ══════════════════════════════════════════════════════════════

test('fetchRelayCaps 有超时：中继不响应时几秒内回落并说明原因', async () => {
  // 一个"永远不响应"的服务器：接受连接但从不写响应
  const server = createServer(() => { /* 故意不响应 */ })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  cleanups.push(() => new Promise((r) => { server.closeAllConnections(); server.close(() => r()) }))
  const base = `http://127.0.0.1:${server.address().port}`

  const t0 = Date.now()
  const caps = await fetchRelayCaps(base, undefined, { timeoutMs: 150 })
  const elapsed = Date.now() - t0
  assert.equal(caps.legacy, true, '探测不到就按协议最小值回落，不能猜')
  assert.equal(caps.maxMessageBytes, (1 << 20) + 17)
  assert.match(caps.detail, /超时|问不到/, '失败原因要可读（排查时全靠它）')
  assert.ok(elapsed < 3000, `必须在超时附近返回（实际 ${elapsed}ms）—— 否则 CLI 启动会挂住`)
})
