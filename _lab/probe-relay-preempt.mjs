/**
 * 中继开局：被抢占 / 创建响应丢失 —— 实测探针
 * ============================================
 *
 * 这是 `PROTOCOL.md` §3.3.1 那条核查的**原始探针**（2026-10）。文档里那段表格就是它跑出来的：
 *
 *   | 情形 | 房间状态 | 旧行为 | 现在 |
 *   | 攻击者建房间并占住 seq 0 | nextSeq=1，全是垃圾 | 静默跳过清单 | 明确报 ROOM_TAKEN |
 *   | 创建响应在回程丢了 | nextSeq=0，空房间 | 静默跳过清单 | 补投清单，传输照常 |
 *
 * 为什么脚本还在仓库里：文档既然写了"实测（`_lab/probe-relay-preempt.mjs`）"，
 * 那个文件就得真的存在、并且**现在还能跑出同样的结论** —— 否则引用就是一句空话。
 * 日常回归由 `test/relay-open.test.js` 负责（三条用例，跑在 `npm test` 里）；
 * 这个脚本是**给人看的那一份**：它把三种开局逐个跑一遍并打印结果。
 *
 * 用法：
 *   node _lab/probe-relay-preempt.mjs
 *   （零依赖：起一个真实的本地中继 —— `RoomStore` + `handleRelay`，与线上中继同一份代码）
 */
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { RoomStore } from '../src/relay/room.js'
import { handleRelay } from '../src/relay/protocol.js'
import { RelayClient } from '../src/relay/client.js'
import { deriveKeys, deriveVerifier, relayRoomName, PARAMS } from '../src/suite/flicker1.js'

/** 起一个真实的本地中继（与 relay-e2e / relay-open 用的是同一套做法） */
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
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
  }
}

function makeSession(password = 'preempt-probe-password') {
  const salt = randomBytes(PARAMS.saltBytes)
  const keys = deriveKeys(deriveVerifier(password, salt))
  return {
    roomName: relayRoomName(keys),
    keys,
    manifest: Buffer.concat([Buffer.from([0x01]), salt, randomBytes(64)]),
  }
}

const clientFor = (base, s) => new RelayClient({
  baseUrl: base, roomName: s.roomName, encKey: s.keys.enc, manifest: {},
})

const status = async (base, room) => (await (await fetch(`${base}/r/${room}/status`)).json())

let failed = 0
const check = (name, ok, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  —— ' + detail : ''}`)
  if (!ok) failed++
}

// ── ① 被抢占：攻击者只用房间名（链接里的那 64 个 hex），不需要密码 ──
console.log('\n① 房间被抢占（攻击者只需要链接里的房间名）')
{
  const { base, close } = await startRelay()
  try {
    const s = makeSession()
    await fetch(`${base}/r/${s.roomName}`, { method: 'POST' })            // 攻击者建房间
    await fetch(`${base}/r/${s.roomName}?seq=0`, { method: 'POST',        // 占住 seq 0
      body: Buffer.from('attacker junk that will never decrypt') })
    const st = await status(base, s.roomName)
    check('房间已被占住', st.nextSeq === 1, `nextSeq=${st.nextSeq}`)

    const c = clientFor(base, s)
    let code = null
    let msg = ''
    try { await c.open(s.manifest) } catch (e) { code = e.code; msg = e.message }
    check('发送端没有静默跳过，而是明确报错', code === 'ROOM_TAKEN', `code=${code}`)
    check('报错能指导用户（说清"房间名在链接里"并让人重新发起）',
      /房间名已经被占用/.test(msg) && /链接/.test(msg) && /重新启动/.test(msg), msg.slice(0, 60))
  } finally {
    await close()
  }
}

// ── ② 创建响应在回程丢了（与攻击者无关）：房间存在但是空的 ──
console.log('\n② 创建响应在回程丢了（空房间）')
{
  const { base, close } = await startRelay()
  try {
    const s = makeSession()
    await fetch(`${base}/r/${s.roomName}`, { method: 'POST' })            // 服务端建好了，客户端没收到
    check('前置：房间存在但没有消息', (await status(base, s.roomName)).nextSeq === 0)

    const c = clientFor(base, s)
    const created = await c.open(s.manifest)
    check('拿到的是"已存在"（created=false）', created.created === false)
    const st = await status(base, s.roomName)
    check('清单被补投出去（nextSeq 变成 1）', st.nextSeq === 1, `nextSeq=${st.nextSeq}`)

    const got = Buffer.from(await (await fetch(`${base}/r/${s.roomName}?seq=0`)).arrayBuffer())
    check('补投的内容与清单逐字节一致', got.length === s.manifest.length && got.equals(s.manifest))
  } finally {
    await close()
  }
}

// ── ③ 正常开局（对照）──
console.log('\n③ 正常开局（对照组）')
{
  const { base, close } = await startRelay()
  try {
    const s = makeSession()
    const c = clientFor(base, s)
    const created = await c.open(s.manifest)
    check('第一次 POST 创建了房间', created.created === true)
    check('清单落在 seq 0', (await status(base, s.roomName)).nextSeq === 1)
  } finally {
    await close()
  }
}

console.log(failed ? `\n✗ ${failed} 条与文档不符` : '\n✓ 三种开局都与 PROTOCOL.md §3.3.1 的表格一致')
process.exit(failed ? 1 : 0)
