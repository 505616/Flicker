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
import { handleRelay } from '../src/relay/protocol.js'
import { createPluginRegistry, pluginPaths } from '../src/plugin/registry.js'
import { relayStoreFrom, describeStore } from '../src/plugin/relay-store.js'
import { RECEIVER_HTML } from './page.generated.js'

const args = process.argv.slice(2)
const portArg = args.find((a) => a.startsWith('--port='))
const port = portArg ? Number(portArg.split('=')[1]) : 8787
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
  const chunks = []
  for await (const c of req) chunks.push(c)
  const body = Buffer.concat(chunks)

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
    plugins,
  })
  const buf = Buffer.from(await r.arrayBuffer())
  const headers = {}
  r.headers.forEach((v, k) => { headers[k] = v })
  res.writeHead(r.status, headers)
  res.end(buf)
})

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
