/**
 * 一次性排查：图形界面里点「停止并销毁」为什么没生效。
 * 用法：node _lab/probe-gui-recv-stop.mjs
 */
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeTempDir, cleanupTempDirs } from '../gen/tmp.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const work = makeTempDir('flicker-probe-gui-')
const inbox = path.join(work, 'inbox')
await mkdir(inbox, { recursive: true })

const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'flicker.js'), '--gui'], {
  env: { ...process.env, FLICKER_NO_BROWSER: '1' },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
})
let out = ''
child.stdout.on('data', (b) => { out += b; process.stdout.write('[gui] ' + b) })
child.stderr.on('data', (b) => process.stderr.write('[gui-err] ' + b))

let base = null
for (let i = 0; i < 200 && !base; i++) {
  await sleep(100)
  const m = out.match(/(http:\/\/127\.0\.0\.1:\d+\/)/)
  if (m) base = m[1]
}
console.log('base =', base)
const api = async (p, body) => {
  const r = await fetch(base + 'api/' + p, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const t = await r.text()
  return { status: r.status, body: t.slice(0, 300) }
}

console.log('start →', await api('recv/start', { dir: inbox }))
await sleep(800)
console.log('state →', (await api('state')).body.slice(-260))
// ⚠️ 命令一定要带 body（`{}`）：这个 helper 用"有没有 body"区分 GET 与 POST，
//    不带 body 会发成 GET，而命令类路由只接受 POST → 404。
//    第一版就是这么误判的：以为"停止没生效"，其实是自己发错了请求。
console.log('stop  →', await api('recv/stop', {}))
for (const ms of [300, 1000, 2500]) {
  await sleep(ms)
  const s = JSON.parse((await api('state')).body)
  console.log(`+${ms}ms phase=${s.recv?.phase} report=${s.recv?.report ? 'yes' : 'no'}`)
}
try { child.kill() } catch { /* 已退出 */ }
const { kept } = cleanupTempDirs()
if (kept.length) console.error(`  ! 临时目录没删掉：${kept.join('、')}（稍后 node gen/clean-temp.mjs --yes）`)
