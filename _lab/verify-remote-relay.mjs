// 用**用户自己部署的那个真中继**跑一次完整传输
// =============================================
// `_lab/verify-relay.mjs` 验的是本地中继；这个脚本验的是**公网上的那个地址**：
//   真 CLI 发送端 ──HTTPS──▶ （用户的 Cloudflare 中继）──HTTPS──▶ 本脚本扮演的接收端
//
// 判据（缺一条都不算通）：
//   ① /health 能读到能力声明（发送端据此选块大小）
//   ② 首页能拿到接收端页面（对方打开的就是它）
//   ③ 文件**逐字节**送达，且用的是密码派生出的房间名
//   ④ 传完之后房间消失（"用完即销毁"在真中继上成立）
//   ⑤ 发送端以退出码 0 结束，且销毁清单里有"中继房间已销毁"
//
// 用法：node _lab/verify-remote-relay.mjs https://你的中继地址
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { randomBytes, createDecipheriv } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  deriveVerifier, deriveKeys, chunkIV, chunkAAD, MANIFEST_AAD, relayRoomName,
} from '../src/suite/flicker1.js'
import { unpackMessage, MSG } from '../src/relay/protocol.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const base = (process.argv[2] ?? '').replace(/\/+$/, '')
if (!/^https?:\/\//.test(base)) {
  console.error('用法：node _lab/verify-remote-relay.mjs https://你的中继地址')
  process.exit(2)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PASSWORD = 'remote-relay-verify-2026'
let failures = 0
const ok = (m) => console.log(`  ✅ ${m}`)
const bad = (m) => { console.log(`  ❌ ${m}`); failures++ }

console.log(`\n  验证真中继：${base}\n`)

// ── ①② 能力声明与首页 ─────────────────────────────────────
try {
  const h = await fetch(`${base}/health`, { signal: AbortSignal.timeout(30000) })
  const j = await h.json()
  if (j.ok && Number.isInteger(j.maxMessageBytes)) {
    ok(`/health 读到能力声明：单条上限 ${j.maxMessageBytes} 字节（${(j.maxMessageBytes / 1048576).toFixed(2)} MiB）`)
  } else bad(`/health 的响应不对：${JSON.stringify(j)}`)
} catch (e) { bad('读 /health 失败：' + (e?.message ?? e)) }

try {
  const p = await fetch(`${base}/`, { signal: AbortSignal.timeout(30000) })
  const html = await p.text()
  if (p.ok && /闪传/.test(html) && html.length > 50000) ok(`首页拿到了接收端页面（${(html.length / 1024).toFixed(0)} KB）`)
  else bad(`首页不对：HTTP ${p.status}，${html.length} 字节`)
} catch (e) { bad('取首页失败：' + (e?.message ?? e)) }

// ── ③ 真传输 ──────────────────────────────────────────────
const work = await mkdtemp(path.join(tmpdir(), 'verify-remote-'))
const NAMES = ['hello.bin', '说明.txt']
await writeFile(path.join(work, 'hello.bin'), randomBytes(300 * 1024))
await writeFile(path.join(work, '说明.txt'), Buffer.from('经公网中继传输的文本', 'utf8'))

const cli = spawn(process.execPath, [
  'bin/flicker.js', 'send', ...NAMES.map((n) => path.join(work, n)),
  `--relay=${base}`, `--password=${PASSWORD}`,
  '--machine', '--no-qr', '--no-color', '--no-gift', '--timeout=180s',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })

let out = ''
cli.stdout.on('data', (b) => { out += b })
cli.stderr.on('data', (b) => { out += b })

let ready = null
for (let i = 0; i < 300 && !ready; i++) {
  await sleep(200)
  const m = out.match(/__READY__ (\S+) (\S+)/)
  if (m) ready = { base: m[1], room: m[2] }
  if (cli.exitCode !== null) break
}

const outDir = path.join(work, 'out')
if (ready) {
  ok(`发送端就绪，房间 ${ready.room.slice(0, 12)}…`)

  // 清单（seq 0）
  let raw = null
  for (let i = 0; i < 200 && !raw; i++) {
    const r = await fetch(`${ready.base}/r/${ready.room}?seq=0`, { signal: AbortSignal.timeout(30000) })
    if (r.ok) { raw = Buffer.from(await r.arrayBuffer()); break }
    await sleep(200)
  }
  if (!raw) bad('拿不到清单')
  else {
    const { type, payload } = unpackMessage(new Uint8Array(raw))
    if (type !== MSG.MANIFEST) bad(`第一条消息类型不对：${type}`)
    const salt = Buffer.from(payload.subarray(0, 16))
    const keys = deriveKeys(deriveVerifier(PASSWORD, salt))
    if (relayRoomName(keys) !== ready.room) bad('密码算出的房间名与链接不一致')
    else ok('房间名与密码派生结果一致（等价于密码核对通过）')

    const d = createDecipheriv('aes-256-gcm', keys.enc, Buffer.from(payload.subarray(16, 28)), { authTagLength: 16 })
    d.setAAD(MANIFEST_AAD); d.setAuthTag(Buffer.from(payload.subarray(28, 44)))
    const wire = JSON.parse(Buffer.concat([d.update(Buffer.from(payload.subarray(44))), d.final()]).toString('utf8'))
    ok(`清单解密成功：${wire.files.length} 个文件，共 ${(wire.totalBytes / 1024).toFixed(1)} KB`)

    // 逐块取、解密、确认
    let ordinal = 0
    let allOk = true
    for (let fi = 0; fi < wire.files.length; fi++) {
      const f = wire.files[fi]
      f.firstChunk = ordinal; ordinal += f.chunks
      const parts = []
      for (let ci = 0; ci < f.chunks; ci++) {
        const seq = 1 + f.firstChunk + ci
        let got = null
        for (let i = 0; i < 300 && !got; i++) {
          const r = await fetch(`${ready.base}/r/${ready.room}?seq=${seq}`, { signal: AbortSignal.timeout(30000) })
          if (r.ok) { got = Buffer.from(await r.arrayBuffer()); break }
          await sleep(150)
        }
        if (!got) { bad(`取 seq=${seq} 失败`); allOk = false; break }
        const { payload: cp } = unpackMessage(new Uint8Array(got))
        const len = Math.min(f.chunkBytes, f.size - ci * f.chunkBytes)
        const dd = createDecipheriv('aes-256-gcm', keys.enc, chunkIV(ci), { authTagLength: 16 })
        dd.setAAD(chunkAAD(fi, ci, f.chunks, len)); dd.setAuthTag(Buffer.from(cp.subarray(0, 16)))
        parts.push(Buffer.concat([dd.update(Buffer.from(cp.subarray(16))), dd.final()]))
        await fetch(`${ready.base}/r/${ready.room}/ack?upTo=${seq}`, { method: 'POST', signal: AbortSignal.timeout(30000) })
      }
      if (parts.length === f.chunks) await writeFile(path.join(work, 'out-' + f.rel), Buffer.concat(parts))
    }
    if (allOk) ok(`取回全部 ${wire.files.length} 个文件、共 ${ordinal} 块`)

    // 逐字节比对
    let compared = 0
    for (const n of NAMES) {
      const a = await readFile(path.join(work, n)).catch(() => null)
      const b = await readFile(path.join(work, 'out-' + n)).catch(() => null)
      if (a && b && Buffer.compare(a, b) === 0) compared++
      else bad(`${n} 内容不一致`)
    }
    if (compared === NAMES.length) ok('全部文件逐字节一致')
  }
} else {
  bad('发送端没有报出房间号')
}

// ── ⑤ 发送端收尾 ──────────────────────────────────────────
const code = await new Promise((r) => {
  if (cli.exitCode !== null) return r(cli.exitCode)
  const t = setTimeout(() => { try { cli.kill() } catch { /* 已退出 */ } ; r(null) }, 90000)
  cli.on('exit', (c) => { clearTimeout(t); r(c) })
})
const clean = out.replace(/\x1b\[[0-9;]*m/g, '')
if (code === 0) ok('发送端退出码 0')
else bad(`发送端退出码 ${code}`)
if (/中继房间已销毁/.test(clean)) ok('销毁清单里有"中继房间已销毁"')
else bad('销毁清单里没有中继房间销毁记录')

// ── ④ 房间消失 ────────────────────────────────────────────
if (ready) {
  let status = null
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${ready.base}/r/${ready.room}`, { signal: AbortSignal.timeout(30000) })
    status = r.status
    if (status === 404) break
    await sleep(250)
  }
  if (status === 404) ok('传输结束后房间已从中继上消失')
  else bad(`房间仍然存在（HTTP ${status}）`)
}

await rm(work, { recursive: true, force: true })
console.log('\n  ' + (failures ? `❌ 有 ${failures} 项未通过` : '✅ 全部通过 —— 你的公网中继可以用了') + '\n')
process.exit(failures ? 1 : 0)
