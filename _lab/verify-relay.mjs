/**
 * 中继模式的完整链路验证
 * ======================
 * 把三样**真实的东西**接在一起跑一遍：
 *
 *   ① 真实的 CLI（node bin/flicker.js send --relay=…）
 *   ② 真实的本地中继（relay/local.mjs，与 Cloudflare Worker 同一份协议实现）
 *   ③ 真正的中继接收逻辑（与浏览器接收端同一套算法）
 *
 * 这条验证的意义在于：前面所有中继测试用的都是自己拼的元素，
 * 而这里跑的是**用户真正会执行的那条命令**。
 *
 * ⚠️ **下面扮演的接收端必须与 `web/receiver.html` 做同样的事，一件都不能少。**
 *    曾经因为少做一步（ack），这个脚本一路"验证通过"，而真实浏览器里
 *    跨网络传输**只能走完一个窗口就停住**，发送端还误报成功 ——
 *    验证脚本与真实客户端行为不一致，等于验证了另一条链路。
 *    现在两边都 ack（页面是后台合并发送，这里是每块 await），
 *    用例见 `test/relay-ack.test.js`。改动这里时请先读那一条。
 *
 * 用法：node _lab/verify-relay.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { randomBytes, createDecipheriv } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  deriveVerifier, deriveKeys, chunkIV, chunkAAD, MANIFEST_AAD, relayRoomName, PARAMS,
} from '../src/suite/flicker1.js'
import { unpackMessage, MSG } from '../src/relay/protocol.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PORT = 8899
const PASSWORD = 'verify-relay-password'
const t0 = Date.now()
const stamp = () => `+${String(Date.now() - t0).padStart(5)}ms`

let failures = 0
const ok = (m) => console.log(`  ${stamp()} ✅ ${m}`)
const bad = (m) => { console.log(`  ${stamp()} ❌ ${m}`); failures++ }

const work = await mkdtemp(path.join(tmpdir(), 'verify-relay-'))
const outDir = path.join(work, 'out')
await mkdir(outDir, { recursive: true })

// 覆盖有代表性的形态：满块、不齐尾块、空文件、中文名
const SOURCES = ['full.bin', 'odd.bin', 'empty.dat', '说明.txt']
await writeFile(path.join(work, 'full.bin'), randomBytes(PARAMS.chunkBytes))
await writeFile(path.join(work, 'odd.bin'), randomBytes(PARAMS.chunkBytes + 777))
await writeFile(path.join(work, 'empty.dat'), Buffer.alloc(0))
await writeFile(path.join(work, '说明.txt'), Buffer.from('经中继传输的文本', 'utf8'))

console.log('\n  验证中继模式的完整链路\n')

// ── 起本地中继 ──────────────────────────────────────────────
const relay = spawn(process.execPath, ['relay/local.mjs', `--port=${PORT}`],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
let relayOut = ''
relay.stdout.on('data', (b) => { relayOut += b.toString() })
relay.stderr.on('data', (b) => { relayOut += b.toString() })
await sleep(1200)
if (relay.exitCode !== null) { bad(`中继启动失败:\n${relayOut}`); process.exit(1) }
ok('本地中继已启动（与 Cloudflare Worker 同一份协议实现）')

// ── 跑真实的 CLI ────────────────────────────────────────────
console.log('\n  --- 执行真实的命令 ---')
console.log(`  flicker send <4 个文件> --relay=http://127.0.0.1:${PORT} --password=…\n`)

const cli = spawn(process.execPath, [
  'bin/flicker.js', 'send', ...SOURCES.map((s) => path.join(work, s)),
  `--relay=http://127.0.0.1:${PORT}`, `--password=${PASSWORD}`,
  '--timeout=180s', '--machine', '--no-qr', '--no-gift',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })

let cliOut = ''
let ready = null
cli.stdout.on('data', (b) => {
  cliOut += b.toString()
  const m = cliOut.match(/__READY__ (\S+) (\S+)/)
  if (m && !ready) ready = { base: m[1], room: m[2] }
})
cli.stderr.on('data', (b) => { cliOut += b.toString() })

for (let i = 0; i < 150 && !ready; i++) await sleep(100)
if (!ready) {
  bad(`CLI 没有报出就绪标记。输出:\n${cliOut}`)
  relay.kill(); process.exit(1)
}
ok(`CLI 已就绪，房间名 ${ready.room.slice(0, 16)}…`)

const url = (s = '') => `${ready.base}/r/${ready.room}${s}`

// ── 扮演浏览器接收端 ────────────────────────────────────────
console.log('\n  --- 扮演接收端（与浏览器同一套算法）---')

// 清单
let raw = null
for (let i = 0; i < 200 && !raw; i++) {
  const r = await fetch(url('?seq=0'))
  if (r.ok) { raw = Buffer.from(await r.arrayBuffer()); break }
  const j = await r.json().catch(() => ({}))
  if (j.error !== 'NOT_YET') { bad(`取清单失败: ${r.status} ${j.error ?? ''}`); break }
  await sleep(100)
}
if (!raw) { bad('拿不到清单'); relay.kill(); await rm(work, { recursive: true, force: true }); process.exit(1) }

const { type: msgType, payload } = unpackMessage(new Uint8Array(raw))
if (msgType !== MSG.MANIFEST) bad(`第一条消息类型不对：${msgType}`)
const salt = Buffer.from(payload.subarray(0, 16))
const keys = deriveKeys(deriveVerifier(PASSWORD, salt))
if (relayRoomName(keys) !== ready.room) {
  bad('用密码算出的房间名与链接里的不一致 —— 密钥派生有问题')
} else {
  ok('房间名与密码派生结果一致（等价于密码核对通过）')
}
const d = createDecipheriv('aes-256-gcm', keys.enc, Buffer.from(payload.subarray(16, 28)), { authTagLength: 16 })
d.setAAD(MANIFEST_AAD); d.setAuthTag(Buffer.from(payload.subarray(28, 44)))
const wire = JSON.parse(Buffer.concat([d.update(Buffer.from(payload.subarray(44))), d.final()]).toString('utf8'))
ok(`清单解密成功：${wire.files.length} 个文件，共 ${(wire.totalBytes / 1024).toFixed(1)} KB`)

// 逐条取
let ordinal = 0
for (let fi = 0; fi < wire.files.length; fi++) {
  const f = wire.files[fi]
  f.firstChunk = ordinal; ordinal += f.chunks
  const full = path.join(outDir, f.rel)
  await mkdir(path.dirname(full), { recursive: true })
  const parts = []
  for (let ci = 0; ci < f.chunks; ci++) {
    const seq = 1 + f.firstChunk + ci
    let got = null
    for (let i = 0; i < 400 && !got; i++) {
      const r = await fetch(url(`?seq=${seq}`))
      if (r.ok) { got = Buffer.from(await r.arrayBuffer()); break }
      const j = await r.json().catch(() => ({}))
      if (j.error === 'NOT_YET') { await sleep(40); continue }
      bad(`取 seq=${seq} 失败: ${r.status} ${j.error ?? ''}`)
      break
    }
    if (!got) break
    const { payload: cp } = unpackMessage(new Uint8Array(got))
    const len = Math.min(f.chunkBytes, f.size - ci * f.chunkBytes)
    const dd = createDecipheriv('aes-256-gcm', keys.enc, chunkIV(ci), { authTagLength: 16 })
    dd.setAAD(chunkAAD(fi, ci, f.chunks, len)); dd.setAuthTag(Buffer.from(cp.subarray(0, 16)))
    parts.push(Buffer.concat([dd.update(Buffer.from(cp.subarray(16))), dd.final()]))
    await fetch(url(`/ack?upTo=${seq}`), { method: 'POST' })
  }
  if (parts.length === f.chunks) await writeFile(full, Buffer.concat(parts))
}
if (failures === 0) ok(`已取回全部 ${wire.files.length} 个文件（${ordinal} 块）`)

// ── 逐字节比对 ──────────────────────────────────────────────
console.log('\n  --- 逐字节比对 ---')
let compared = 0
for (const name of SOURCES) {
  const a = await readFile(path.join(work, name)).catch(() => null)
  const b = await readFile(path.join(outDir, name)).catch(() => null)
  if (!a || !b) { bad(`${name} 缺失`); continue }
  if (Buffer.compare(a, b) === 0) { ok(`${name}（${a.length} 字节）一致`); compared++ }
  else bad(`${name} 内容不一致`)
}
if (compared === SOURCES.length) ok('全部文件逐字节一致')

// ── 中继侧不该看到明文 ──────────────────────────────────────
console.log('\n  --- 中继侧检查 ---')
if (relayOut.includes('经中继传输的文本')) bad('中继输出里出现了明文！')
else ok('中继侧没有出现明文内容')

// ── 等发送端收尾 ────────────────────────────────────────────
console.log('\n  --- 等待发送端收尾 ---')
const code = await new Promise((r) => {
  if (cli.exitCode !== null) return r(cli.exitCode)
  const t = setTimeout(() => { cli.kill(); r(null) }, 60000)
  cli.on('exit', (c) => { clearTimeout(t); r(c) })
})
const clean = cliOut.replace(/\x1b\[[0-9;]*m/g, '')
console.log(clean.split('\n').slice(-16).map((l) => '    ' + l).join('\n'))

if (/中继房间已销毁/.test(clean)) ok('销毁清单里包含「中继房间已销毁」')
else bad('销毁清单里没有中继房间销毁记录')
if (code === 0) ok('发送端退出码为 0')
else bad(`发送端退出码为 ${code}`)

const after = await fetch(url())
if (after.status === 404) ok('传输结束后房间已从中继上消失')
else bad(`房间仍然存在（HTTP ${after.status}）`)

// ── 清理 ────────────────────────────────────────────────────
relay.kill()
await sleep(300)
await rm(work, { recursive: true, force: true })

console.log('\n  ' + (failures ? `❌ 有 ${failures} 项检查未通过` : '✅ 全部通过 —— 跨网络链路可用') + '\n')
process.exit(failures ? 1 : 0)
