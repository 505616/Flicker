// 探针：中继模式 + **默认带赠品**（源码形态送的是内存里的 source-pack.fkz）
// =====================================================================
// 疑点：src/prepare.js 把赠品的 `_giftBytes`（Buffer）直接塞进 wire.files，
// 而加密清单是 `JSON.stringify(wire)` 出来的 —— Buffer 会被序列化成
// {"type":"Buffer","data":[…]}，体积约 4~5 倍。源码包的 1.3 MB 于是变成
// 几 MB 的清单，而中继的单条消息上限（本项目部署值）是 2 MiB + 17。
//
// 所有中继测试都带 `--no-gift`，所以"默认设置走中继"这条路可能从来没被跑过。
//
// 用法：node _lab/probe-relay-gift.mjs
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RoomStore } from '../src/relay/room.js'
import { handleRelay } from '../src/relay/protocol.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const store = new RoomStore()
const seen = []
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const chunks = []
  for await (const c of req) chunks.push(c)
  const body = Buffer.concat(chunks)
  if (url.pathname.startsWith('/r/') && body.length) seen.push({ path: url.pathname, len: body.length })
  const r = await handleRelay(new Request('http://relay' + req.url, {
    method: req.method,
    headers: Object.fromEntries(Object.entries(req.headers).filter(([, v]) => typeof v === 'string')),
    body: body.length ? body : undefined,
  }), url.pathname, store)
  const buf = Buffer.from(await r.arrayBuffer())
  const headers = {}
  r.headers.forEach((v, k) => { headers[k] = v })
  res.writeHead(r.status, headers)
  res.end(buf)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

const work = await mkdtemp(path.join(tmpdir(), 'probe-gift-'))
const file = path.join(work, 'hello.bin')
await writeFile(file, Buffer.alloc(4096, 7))

console.log('中继: ' + base)
console.log('注意：**不带** --no-gift，也就是用户的默认设置\n')

const cli = spawn(process.execPath, [
  'bin/flicker.js', 'send', file,
  `--relay=${base}`, '--password=probe-gift-pass',
  '--machine', '--no-qr', '--no-color', '--timeout=20s',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })

let out = ''
cli.stdout.on('data', (b) => { out += b })
cli.stderr.on('data', (b) => { out += b })

let ready = null
for (let i = 0; i < 200 && !ready; i++) {
  await sleep(100)
  const m = out.match(/__READY__ (\S+) (\S+)/)
  if (m) ready = { base: m[1], room: m[2] }
  if (cli.exitCode !== null) break
}

if (!ready) {
  console.log('❌ 没有报出房间号，退出码 ' + cli.exitCode)
} else {
  console.log('✅ 房间已建：' + ready.room.slice(0, 12) + '…')
  // 清单是 seq=0，量一下它到底多大
  for (let i = 0; i < 100; i++) {
    const r = await fetch(`${ready.base}/r/${ready.room}?seq=0`)
    if (r.status === 200) {
      const buf = Buffer.from(await r.arrayBuffer())
      console.log(`   清单消息大小：${(buf.length / 1024 / 1024).toFixed(2)} MiB`)
      console.log(`   中继单条上限：${((store.maxMessageBytes - 17) / 1024 / 1024).toFixed(2)} MiB`)
      console.log(buf.length + 17 > store.maxMessageBytes
        ? '   ⚠️ 清单本身就超过中继单条上限'
        : '   ✓ 清单在单条上限之内')
      break
    }
    await sleep(100)
  }
}

await sleep(1500)
try { cli.kill() } catch { /* 已退出 */ }
console.log('\n--- CLI 输出（末 18 行）---')
console.log(out.replace(/\x1b\[[0-9;]*m/g, '').split('\n').slice(-18).join('\n'))
console.log('\n--- 中继侧看到的请求体大小 ---')
for (const s of seen.slice(0, 8)) console.log(`   ${s.path}  ${(s.len / 1024).toFixed(0)} KB`)

server.closeAllConnections()
server.close()
await rm(work, { recursive: true, force: true })
