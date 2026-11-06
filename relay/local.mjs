#!/usr/bin/env node
/**
 * 本地中继（用于开发与自测）
 * ==========================
 * 把 src/relay/protocol.js 挂到一个普通的 Node HTTP 服务上 ——
 * 与 Cloudflare Worker 用的是**同一份协议实现**，所以本地能通的行为，
 * 部署到真中继上同样成立。
 *
 * 它同时也是一个可以真的用的中继：在局域网内跑起来，
 * 另一台电脑用 --relay=http://<你的IP>:8787 就能连上。
 * （跨互联网还是需要部署到 Cloudflare —— 或者给这个端口做端口转发。）
 *
 * 用法：
 *   node relay/local.mjs               # 监听 8787
 *   node relay/local.mjs --port=9000
 *   node relay/local.mjs --port=0      # 让系统分配端口（测试用；会把真实端口打出来）
 *   node relay/local.mjs --verbose     # 打印每条转发（会显示序号与长度，不显示内容）
 *   node relay/local.mjs --plugin=./p.cjs   # 加载插件（可重复；也可用 FLICKER_PLUGINS）
 *   node relay/local.mjs --plugins     # 只列出并校验插件，不启动服务
 */
import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import { RoomStore } from '../src/relay/room.js'
import { handleRelay, maxBatchBodyBytes } from '../src/relay/protocol.js'
import { createPluginRegistry, pluginPaths } from '../src/plugin/registry.js'
import { relayStoreFrom, describeStore } from '../src/plugin/relay-store.js'
import { RECEIVER_HTML } from './page.generated.js'
import { SENDER_HTML } from './sender.generated.js'

const args = process.argv.slice(2)
const portArg = args.find((a) => a.startsWith('--port='))
const port = portArg ? Number(portArg.split('=')[1]) : 8787
// P3：`--port=abc` 从前会一路走到 server.listen(NaN) 抛 ERR_SOCKET_BAD_PORT，
// 用户只看到一句 Node 内部错误。这里提前校验并给出可照做的提示。
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`\n  ✗ --port 需要一个 0–65535 的整数，收到 "${portArg?.split('=')[1] ?? port}"\n`)
  process.exit(2)
}
const verbose = args.includes('--verbose')
// `--plugin=a --plugin=b` 与 `--plugins`（只列不跑）
const pluginFlags = args.filter((a) => a.startsWith('--plugin=')).map((a) => a.slice('--plugin='.length))
const listOnly = args.includes('--plugins')

// ⚠️ 存储不再在这里建：它要等插件加载完才知道用哪个（见下面 `relayStoreFrom`）。

// ── 插件（与发送端同一套：**只认显式来源**，绝不自动发现）──────
//
// ⚠️ 中继与发送端的差别在于"谁装"：中继是**部署者**自己部署的服务，
//    所以插件由部署者在启动命令里指定（或者写进自己的启动脚本）。
//    但策略是同一个：不扫目录、不自动发现 —— 否则"这个中继只跑这一份代码"
//    这句话就不成立了，而中继是双方都要信任的那个中间人。
const pluginSources = pluginPaths({ flagValue: pluginFlags })
let plugins = null
if (pluginSources.length || listOnly) {
  // ⚠️ `planes: ['relay']`：中继平面上加载的插件只能用中继的钩子。
  //    在这之前只拦"拼错的名字"，一个订阅了 `run/start` 的中继插件会安静地什么都不做。
  plugins = createPluginRegistry({
    planes: args.includes('--plugins') ? null : ['relay'],
    log: (line) => console.log(line),
  })
  if (pluginSources.length) {
    try {
      await plugins.load(pluginSources)
    } catch (e) {
      console.error(`\n  ✗ ${e?.message ?? e}\n`)
      process.exit(2)
    }
  }
}

if (listOnly) {
  console.log(plugins.list.length
    ? plugins.list.map((p) => `  ${p.name}${p.version ? '@' + p.version : ''}` +
        `  api=${p.apiVersion}  订阅/贡献: ${p.events.join(', ') || '（无）'}` +
        `  副作用: ${p.effects} 个\n      ${p.file}`).join('\n')
    : '  （没有加载任何插件：用 --plugin=<路径> 或 FLICKER_PLUGINS 指定）')
  process.exit(0)
}

// ── 存储后端：插件可以换掉内存存储（`relay/store` 贡献点）──────
//
// ⚠️ 校验在**这里**做（启动时），不是第一次写入时：少一个方法就该现在报错并点名，
//    否则用户传到一半才看到 `store.ack is not a function`。
const store = relayStoreFrom(plugins, new RoomStore())
if (verbose || store.__plugin) console.log(`  存储后端：${describeStore(store)}`)

/**
 * 单个请求体的上限。
 *
 * 与协议层的 /batch 上限**同一个公式**（64 条 × 单条上限 + 长度前缀）——
 * 本地中继绝不能比 Worker 更宽松，否则"本地能跑、线上 413"又会成为一类假象。
 * 关键不在具体数值，而在**有界**：从前这里完全没有上限，
 * 局域网内任何人发一个 1 GB 的 POST 就能把进程内存翻倍。
 */
const MAX_BODY_BYTES = maxBatchBodyBytes(store.maxMessageBytes)

/** 客户端中途断开时抛出的错误 —— 这是**正常现象**（取消上传、网络抖动），不该刷屏 */
function isConnectionReset(e) {
  const code = e?.code ?? e?.cause?.code
  return code === 'ECONNRESET' || code === 'EPIPE' || code === 'ERR_STREAM_PREMATURE_CLOSE' ||
    code === 'ERR_STREAM_DESTROYED' || e?.name === 'AbortError' || e?.message === 'aborted'
}

function sendJson(res, status, obj) {
  if (res.headersSent) { try { res.end() } catch { /* 已断 */ } return }
  const buf = Buffer.from(JSON.stringify(obj))
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(buf.length),
    // 超限时客户端可能还在发；让连接在响应后关闭，不再把剩余字节读进内存
    Connection: 'close',
  })
  res.end(buf)
}

/**
 * 读请求体：先看 Content-Length，再边读边累计，超限立刻 413 并停止读。
 *
 * 旧写法是 `for await (const c of req) chunks.push(c)` 无上限地缓存 ——
 * 半截请求抛出的 ECONNRESET 没有 catch，async 回调 reject 且无人接，
 * Node 默认按 unhandled rejection 处理 → **整个中继进程 exit 1**，
 * 所有房间与进行中的传输一起消失。
 */
async function readRequestBody(req) {
  const declared = req.headers['content-length']
  if (declared !== undefined) {
    if (!/^[0-9]+$/.test(String(declared).trim())) {
      throw Object.assign(new Error('Content-Length 不合法'), { code: 'BAD_REQUEST', status: 400 })
    }
    const n = Number(declared)
    if (Number.isSafeInteger(n) && n > MAX_BODY_BYTES) {
      throw Object.assign(
        new Error(`请求体过大（声明 ${n} > ${MAX_BODY_BYTES} 字节）`),
        { code: 'TOO_LARGE', status: 413 })
    }
  }
  // 已知 Content-Length 时**预分配一次**、直接拷进去：
  // 旧写法"先把 chunks 都留着、最后 Buffer.concat"的峰值是 2× 请求体，
  // 而一个满窗 /batch 就是十几 MiB。预分配把峰值压到 1×。
  const declaredLen = Number(declared)
  if (Number.isSafeInteger(declaredLen) && declaredLen >= 0 && declaredLen <= MAX_BODY_BYTES) {
    const buf = Buffer.allocUnsafe(declaredLen)
    let off = 0
    for await (const c of req) {
      if (off + c.length > declaredLen) {
        throw Object.assign(new Error('请求体超出 Content-Length'), { code: 'BAD_REQUEST', status: 400 })
      }
      c.copy(buf, off)
      off += c.length
    }
    if (off !== declaredLen) {
      throw Object.assign(new Error('请求体被截断（少于 Content-Length）'), { code: 'BAD_REQUEST', status: 400 })
    }
    return buf
  }

  // 没有 Content-Length（chunked）或长度不合法：只能边读边累计，超限立刻中止
  const chunks = []
  let total = 0
  for await (const c of req) {
    total += c.length
    if (total > MAX_BODY_BYTES) {
      throw Object.assign(
        new Error(`请求体过大（已读 ${total} > ${MAX_BODY_BYTES} 字节）`),
        { code: 'TOO_LARGE', status: 413 })
    }
    chunks.push(c)
  }
  return Buffer.concat(chunks)
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)

  let body
  try {
    body = await readRequestBody(req)
  } catch (e) {
    // 客户端中途断开：正常现象，安静收场（进程必须活着）
    if (isConnectionReset(e)) return
    const status = Number.isInteger(e?.status) ? e.status : 400
    if (verbose) console.log(`  ${req.method} ${url.pathname} → ${status} ${e.message}`)
    sendJson(res, status, { error: e.code ?? 'BAD_REQUEST', message: e.message })
    return
  }

  if (verbose && url.pathname.startsWith('/r/')) {
    const room = url.pathname.split('/')[2] ?? ''
    const seq = url.searchParams.get('seq')
    console.log(`  ${req.method} ${room.slice(0, 8)}… ` +
      (seq === null ? '(状态)' : `seq=${seq} ${body.length}B`))
  }

  const relayReq = new Request(`http://relay${req.url}`, {
    method: req.method,
    headers: Object.fromEntries(
      Object.entries(req.headers).filter(([, v]) => typeof v === 'string')),
    body: body.length ? body : undefined,
  })

  const r = await handleRelay(relayReq, url.pathname, store, {
    pageHtml: async () => RECEIVER_HTML,
    senderHtml: async () => SENDER_HTML,
    plugins,
  })
  const buf = Buffer.from(await r.arrayBuffer())
  const headers = {}
  r.headers.forEach((v, k) => { headers[k] = v })
  res.writeHead(r.status, headers)
  res.end(buf)
}

const server = createServer((req, res) => {
  // ⚠️ 这个 .catch 是**进程存活**的关键，不是防御性编程：
  //    async 回调返回的 Promise 没人接 → Node 默认 --unhandled-rejections=throw →
  //    半截上传就能让整个本地中继 exit 1（症状：所有人房间突然消失）。
  handleRequest(req, res).catch((e) => {
    if (isConnectionReset(e)) return
    console.error(`  ✗ 请求处理失败：${e?.stack ?? e}`)
    sendJson(res, 500, { error: 'INTERNAL', message: String(e?.message ?? e) })
  })
})

// 超时：没有它们，慢速攻击（只发头不发体、或极慢地上传）可以无限占着连接。
// requestTimeout 是"整个请求（含请求体）必须在这个时间内收完"。
// 取 10 分钟而不是 30 秒：大窗口（64 × 2 MiB）在慢上行上本来就可能传很久，
// 超时的目的只是不让连接**永远**挂着。
server.requestTimeout = 10 * 60 * 1000
server.headersTimeout = 60 * 1000

/**
 * 收尾：**插件资源必须释放**（与发送端同一条承诺）。
 * 中继是常驻服务，"用完即销毁"在这里的含义是"关掉服务时不留东西"。
 */
async function shutdown(signal) {
  console.log('\n  正在关闭…')
  server.close(() => {})
  if (plugins?.count) {
    const r = await plugins.dispose()
    console.log(`  ✓ 插件资源已释放（${r.ran} 项）` +
      (r.failed.length ? `\n  ✗ 有 ${r.failed.length} 项失败：${r.failed.join('；')}` : ''))
  }
  setTimeout(() => process.exit(0), 200).unref()
}

server.listen(port, '0.0.0.0', () => {
  // ⚠️ 用 `server.address().port` 而不是命令行里那个数：`--port=0` 时
  //    系统会分配一个真实端口，而命令行里写的是 0 —— 打印错的端口
  //    会让自动化脚本连到一个"看起来对、其实没人听"的地址上。
  const actual = server.address().port
  const ips = []
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) ips.push(a.address)
    }
  }
  console.log('')
  console.log('  闪传 Flicker —— 本地中继')
  console.log(`  监听: http://0.0.0.0:${actual}`)
  for (const ip of ips) console.log(`  局域网内可用: http://${ip}:${actual}`)
  if (plugins?.count) console.log(`  🧩 已加载 ${plugins.describe()}`)
  console.log('')
  console.log(`  发送: flicker send "文件" --relay=http://${ips[0] ?? '127.0.0.1'}:${actual}`)
  console.log('')
  console.log('  ⚠️ 消息只存在内存里，进程退出即全部消失（这符合"用完即销毁"）。')
  console.log('')
})

process.on('SIGINT', () => { shutdown('SIGINT') })
process.on('SIGTERM', () => { shutdown('SIGTERM') })
