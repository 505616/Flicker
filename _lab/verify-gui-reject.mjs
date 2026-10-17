// 体检⑤：界面模式下 runSend 异步失败会怎样？（复现：选完文件后文件被删/拔盘）
// 用法：node _lab/verify-gui-reject.mjs
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const dir = await mkdtemp(path.join(tmpdir(), 'flicker-reject-'))
const file = path.join(dir, 'a.bin')
await writeFile(file, Buffer.alloc(64 * 1024, 7))

const child = spawn(process.execPath, ['bin/flicker.js', '--gui'], {
  env: { ...process.env, FLICKER_NO_BROWSER: '1' },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
})
let out = '', err = ''
child.stdout.on('data', (b) => { out += b })
child.stderr.on('data', (b) => { err += b })
let exited = null
child.on('exit', (code) => { exited = code })

const base = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('界面启动超时\n' + out + err)), 15000)
  const check = () => {
    const m = out.match(/(http:\/\/127\.0\.0\.1:\d+\/)/)
    if (m) { clearTimeout(t); resolve(m[1]) }
  }
  child.stdout.on('data', check)
})
console.log('界面地址：' + base)

const api = async (name, body) => {
  const r = await fetch(base + 'api/' + name, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  return { status: r.status, json: await r.json().catch(() => null) }
}

console.log('add →', JSON.stringify((await api('add', { paths: [file] })).json))

// 关键动作：选完之后文件消失（被删 / U 盘拔了 / 被别的程序移走）
await unlink(file)
console.log('（已删除被选中的文件，模拟"选完就没了"）')

const started = await api('start', { password: 'reject-probe-pass' })
console.log('/api/start → HTTP ' + started.status + ' ' + JSON.stringify(started.json))

for (let i = 0; i < 25; i++) {
  await sleep(200)
  if (exited !== null) break
}
console.log('\n--- 界面进程是否还活着 ---')
console.log(exited === null ? '还活着（未退出）' : `已退出，退出码 ${exited}`)

let state = null
try {
  state = await (await fetch(base + 'api/state', { signal: AbortSignal.timeout(2500) })).json()
} catch (e) {
  state = '取不到状态：' + e.message
}
console.log('退出码=' + exited + '，/api/state → ' +
  (typeof state === 'string' ? state : `phase=${state.phase}` +
    (state.error ? ` error=${JSON.stringify(state.error).slice(0, 160)}` : '  （没有错误信息）')))

console.log('\n--- stderr（末尾 1200 字）---\n' + err.slice(-1200))
console.log('--- stdout（末尾 600 字）---\n' + out.slice(-600))

try { child.kill() } catch { /* 已退出 */ }
await rm(dir, { recursive: true, force: true })
