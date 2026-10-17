/**
 * 给页面拍一张截图（headless Edge + CDP，零依赖）
 * ================================================
 *
 * 为什么需要它：改布局不能靠"看 CSS 猜效果"。宽屏留白、两栏断点、
 * 控件挤不挤，这些只有**看**才知道；而本项目不许随便弹浏览器窗口，
 * 所以走 headless 截图这条路。
 *
 * 用法：
 *   node _lab/screenshot.mjs <url> <out.png> [宽] [高] [驱动脚本.js]
 *
 * 给了第 5 个参数时，会在截图前把那个 JS 文件的内容丢进页面执行 ——
 * 用来把界面推到某个状态（比如"加了文件之后的选项屏"）再拍。
 */

import { spawn } from 'node:child_process'
import { writeFile, mkdtemp, rm, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find(Boolean)

const [url, out, wArg, hArg, driveFile] = process.argv.slice(2)
if (!url || !out) {
  console.error('用法: node _lab/screenshot.mjs <url> <out.png> [宽] [高]')
  process.exit(1)
}
const width = Number(wArg) || 1920
const height = Number(hArg) || 1080

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const work = await mkdtemp(path.join(tmpdir(), 'flicker-shot-'))
const port = 9700 + Math.floor(Math.random() * 200)

const browser = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(work, 'p')}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  `--window-size=${width},${height}`, 'about:blank',
], { stdio: 'ignore' })

let ws = null
for (let i = 0; i < 100 && !ws; i++) {
  await sleep(150)
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const t = list.find((x) => x.type === 'page')
    if (t) {
      ws = new WebSocket(t.webSocketDebuggerUrl)
      await new Promise((res, rej) => {
        ws.addEventListener('open', res, { once: true })
        ws.addEventListener('error', rej, { once: true })
      })
    }
  } catch { /* 还没起来 */ }
}
if (!ws) { console.error('连不上 DevTools'); process.exit(1) }

let id = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id
  pending.set(i, res)
  ws.send(JSON.stringify({ id: i, method, params }))
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error(method + ' 超时')) } }, 20000)
})

await send('Page.enable')
// 视口要显式设，否则 headless 会用自己的默认尺寸，截出来的比例不对
await send('Emulation.setDeviceMetricsOverride', {
  width, height, deviceScaleFactor: 1, mobile: false,
})
await send('Page.navigate', { url })
await sleep(1800)                       // 等字体与脚本就位

// 可选：先把界面推到某个状态再拍
if (driveFile) {
  const src = await readFile(driveFile, 'utf8')
  const r = await send('Runtime.evaluate', {
    expression: src, awaitPromise: true, returnByValue: true,
  })
  if (r.result?.exceptionDetails) {
    console.error('驱动脚本出错: ' + (r.result.exceptionDetails.exception?.description
      ?? r.result.exceptionDetails.text))
  } else if (r.result?.result?.value !== undefined) {
    console.log('驱动脚本返回: ' + JSON.stringify(r.result.result.value))
  }
  await sleep(1200)                     // 等界面响应与轮询
}

const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
await mkdir(path.dirname(out), { recursive: true })
await writeFile(out, Buffer.from(r.result.data, 'base64'))
console.log(`已保存 ${out}（${width}×${height}）`)

ws.close()
browser.kill()
await sleep(300)
await rm(work, { recursive: true, force: true }).catch(() => {})
