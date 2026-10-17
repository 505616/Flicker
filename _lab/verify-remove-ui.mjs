/**
 * 真浏览器验证：清单里单独去掉一项 + 语言按钮显眼程度
 * ======================================================
 *
 * 为什么不能用 Node 里的字符串断言代替：那只能证明"代码是这么写的"，
 * 证明不了"点下去真的会生效"。这一轮的两个改动都**长在 DOM 上**：
 *   · 分组行右边的 ✕ —— 要真的点得到、点了真的少一项、点了不会顺手把这一项展开
 *   · 语言按钮 —— 要真的能在页面里看见（底色/主色/图标），而不是"CSS 里写了"
 * 所以这里开一个 headless Edge，用真点击、真读数验证。
 * 截图落在 `_lab/out/`（已被 .gitignore 忽略），用来"顺便看一眼"。
 *
 * 用法：node _lab/verify-remove-ui.mjs
 */

import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find(Boolean)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
function check(ok, what, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? ` —— ${detail}` : ''}`)
  if (!ok) failures++
}

// ── ① 起一个发送端（回环 + 不开浏览器窗口） ──────────────────────
const gui = spawn(process.execPath, [path.join(ROOT, 'bin', 'flicker.js'), '--gui'], {
  env: { ...process.env, FLICKER_NO_BROWSER: '1' },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
})
let base = ''
{
  let out = ''
  const t0 = Date.now()
  while (Date.now() - t0 < 20000 && !base) {
    await sleep(120)
    out += gui.stdout.read()?.toString() ?? ''
    const m = out.match(/http:\/\/127\.0\.0\.1:\d+\//)
    if (m) base = m[0]
  }
}
if (!base) { console.error('发送端没起来'); gui.kill(); process.exit(1) }
console.log(`发送端：${base}`)

const api = async (p, body) => {
  const r = await fetch(base + 'api/' + p, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: r.status, json: await r.json().catch(() => null) }
}

// ── ② 造三个可发的目录，加进清单 ────────────────────────────────
const dir = await mkdtemp(path.join(tmpdir(), 'flicker-uiverify-'))
const A = path.join(dir, '甲目录')
const B = path.join(dir, '乙目录')
const C = path.join(dir, '丙目录')
for (const [d, files] of [[A, ['a1.txt', 'a2.txt']], [B, ['b1.txt']], [C, ['c1.txt']]]) {
  await mkdir(d, { recursive: true })
  for (const f of files) await writeFile(path.join(d, f), 'x'.repeat(2048))
}
await api('add', { paths: [A] })
await api('add', { paths: [B] })
await api('add', { paths: [C] })

// ── ③ 顺带把接收端页面挂在一个本地静态服务上（只为看页头） ──────
const receiverHtml = await readFile(path.join(ROOT, 'web', 'receiver.html'))
const staticSrv = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(receiverHtml)
})
await new Promise((r) => staticSrv.listen(0, '127.0.0.1', r))
const recvUrl = `http://127.0.0.1:${staticSrv.address().port}/`

// ── ④ 开 headless Edge ─────────────────────────────────────────
const work = await mkdtemp(path.join(tmpdir(), 'flicker-uiverify-'))
const port = 9700 + Math.floor(Math.random() * 200)
const browser = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(work, 'p')}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--window-size=1400,900', 'about:blank',
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
if (!ws) { console.error('连不上 DevTools'); gui.kill(); process.exit(1) }

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

/** 在页面里求值；出错直接抛，不静默 */
async function evalJs(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  const ex = r.result?.exceptionDetails
  if (ex) throw new Error(ex.exception?.description ?? ex.text)
  return r.result?.result?.value
}
async function shot(file) {
  const dir = path.join(ROOT, '_lab', 'out')          // 已被 .gitignore 忽略
  await mkdir(dir, { recursive: true })
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  await writeFile(path.join(dir, file), Buffer.from(r.result.data, 'base64'))
  console.log(`  截图：_lab/out/${file}`)
}

try {
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1400, height: 900, deviceScaleFactor: 1, mobile: false,
  })

  // ── ⑤ 发送端：清单里单独去掉一项 ─────────────────────────────
  console.log('\n【发送端】清单里单独去掉一项')
  await send('Page.navigate', { url: base })
  await sleep(2000)

  const rows = await evalJs(`(() => {
    const gs = [...document.querySelectorAll('#plan-files .group')]
    return gs.map((g) => ({
      name: g.querySelector('.gname')?.textContent,
      meta: g.querySelector('.gmeta')?.textContent,
      hasDel: !!g.querySelector('.gdel'),
    }))
  })()`)
  check(rows.length === 3, '三个添加项各占一行', `实际 ${rows.length} 行`)
  check(rows.every((r) => r.hasDel), '每一行都有 ✕')

  // ✕ 必须真的能被鼠标点到（没有被别的东西盖住）
  const hit = await evalJs(`(() => {
    const b = document.querySelectorAll('#plan-files .gdel')[1]
    const r = b.getBoundingClientRect()
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return { size: [Math.round(r.width), Math.round(r.height)], at: at?.className ?? null }
  })()`)
  check(hit.size[0] > 0 && hit.size[1] > 0, '✕ 有可点的尺寸', `${hit.size.join('×')}`)
  check(String(hit.at).includes('gdel'), '✕ 的位置上点下去命中的就是它自己', `命中 ${hit.at}`)

  await shot('截图-清单三项.png')

  // 点中间那一项的 ✕
  await evalJs(`document.querySelectorAll('#plan-files .gdel')[1].click()`)
  await sleep(1200)

  const after = await evalJs(`(() => {
    const gs = [...document.querySelectorAll('#plan-files .group')]
    return {
      names: gs.map((g) => g.querySelector('.gname')?.textContent),
      // ⚠️ "展开"这个类是加在 .grow（那一行）上的，不在 .group（外层容器）上 ——
      //    第一版查错了元素，于是"没被展开"这条**白过**
      expanded: gs.filter((g) => g.querySelector('.grow')?.classList.contains('open')).length,
      sum: document.querySelector('#plan-files .file-sum')?.textContent,
    }
  })()`)
  check(JSON.stringify(after.names) === JSON.stringify(['甲目录', '丙目录']),
    '点掉中间那一项之后，剩下两项还在、顺序不乱', after.names.join(' / '))
  check(after.expanded === 0, '点 ✕ 不会顺手把这一项展开（stopPropagation 生效）')
  check(/3 个文件/.test(after.sum ?? ''), '下面的合计跟着减到 3 个文件', after.sum)

  const st = await api('state')
  check(st.json.groups.length === 2, '后端状态也只剩两项')
  check(st.json.fileCount === 3, '后端文件数 = 3', String(st.json.fileCount))

  // 剩下的项还能正常展开 —— 证明重建 DOM 之后事件没丢
  await evalJs(`document.querySelectorAll('#plan-files .grow')[0].click()`)
  await sleep(600)
  const opened = await evalJs(`(() => {
    const g = document.querySelector('#plan-files .group')
    return {
      open: g.querySelector('.grow').classList.contains('open'),
      files: [...g.querySelectorAll('.gentries .file-name')].map((e) => e.textContent),
    }
  })()`)
  check(opened.open, '剩下的项还能点开（重建之后事件还在）')
  check(opened.files.includes('a1.txt') && opened.files.includes('a2.txt'),
    '展开后能看到里面的文件，且去掉了文件夹名前缀', opened.files.join(' | '))
  await shot('截图-清单展开.png')

  // ── ⑥ 发送端的语言按钮 ───────────────────────────────────────
  console.log('\n【发送端】语言按钮')
  const switcher = await evalJs(`(() => {
    const b = document.querySelector('.lang-switch')
    const cs = getComputedStyle(b)
    const before = getComputedStyle(b, '::before')
    const r = b.getBoundingClientRect()
    return {
      label: b.textContent, color: cs.color, bg: cs.backgroundColor,
      border: cs.borderTopWidth, font: cs.fontSize, radius: cs.borderRadius,
      icon: before.content, w: Math.round(r.width), h: Math.round(r.height),
    }
  })()`)
  console.log(`    ${JSON.stringify(switcher)}`)
  check(switcher.bg !== 'rgba(0, 0, 0, 0)', '按钮有底色（不是原来的透明底）', switcher.bg)
  check(/rgb\(7[0-9]|rgb\(77, 159, 255\)|rgb\(26, 115, 232\)/.test(switcher.color) ||
    switcher.color !== 'rgb(140, 154, 180)', '按钮用的是主色而不是灰字', switcher.color)
  check(switcher.icon.includes('🌐'), '按钮上有地球图标', switcher.icon)
  check(switcher.w >= 70 && switcher.h >= 24, '按钮有足够的点击尺寸',
    `${switcher.w}×${switcher.h}`)

  await evalJs(`document.querySelector('.lang-switch').click()`)
  await sleep(500)
  const switched = await evalJs(`({
    lang: document.documentElement.lang,
    label: document.querySelector('.lang-switch').textContent,
    head: document.querySelector('.gname')?.textContent,
    files: document.querySelector('[data-i18n="send.pick.files"]')?.textContent,
  })`)
  check(switched.lang === 'en', '切到英文（<html lang>）', switched.lang)
  check(switched.label === '中文', '按钮改显示"中文"（另一种语言的名字）', switched.label)
  check(switched.files === 'Choose files', '界面文案真的翻了', String(switched.files))
  await shot('截图-清单英文.png')

  // ── ⑦ 接收端的语言按钮 ───────────────────────────────────────
  console.log('\n【接收端】语言按钮')
  await send('Page.navigate', { url: recvUrl })
  await sleep(1800)
  const recv = await evalJs(`(() => {
    const b = document.querySelector('.lang-switch')
    if (!b) return null
    const cs = getComputedStyle(b)
    const r = b.getBoundingClientRect()
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return {
      label: b.textContent, color: cs.color, bg: cs.backgroundColor,
      icon: getComputedStyle(b, '::before').content,
      w: Math.round(r.width), h: Math.round(r.height), at: at?.className ?? null,
      align: cs.marginLeft,
    }
  })()`)
  console.log(`    ${JSON.stringify(recv)}`)
  check(!!recv, '接收端页头里有语言按钮')
  check(recv && recv.bg !== 'rgba(0, 0, 0, 0)', '接收端按钮也有底色', recv?.bg)
  check(recv && recv.icon.includes('🌐'), '接收端按钮也有地球图标', recv?.icon)
  check(recv && String(recv.at).includes('lang-switch'), '接收端按钮点得到',
    `命中 ${recv?.at}`)
  check(recv && recv.w >= 70, '接收端按钮够大', recv ? `${recv.w}×${recv.h}` : '')

  await evalJs(`document.querySelector('.lang-switch').click()`)
  await sleep(400)
  const recvEn = await evalJs(`({
    lang: document.documentElement.lang,
    label: document.querySelector('.lang-switch').textContent,
    title: document.querySelector('#v-pw h2')?.textContent,
  })`)
  check(recvEn.lang === 'en', '接收端也能切到英文', recvEn.lang)
  check(recvEn.label === '中文', '接收端按钮改显示"中文"', recvEn.label)
  check(/files/i.test(recvEn.title ?? ''), '接收端文案真的翻了', String(recvEn.title))
  await shot('截图-接收端英文.png')
} finally {
  ws.close()
  browser.kill()
  staticSrv.close()
  gui.kill()
  await sleep(400)
  await rm(work, { recursive: true, force: true }).catch(() => {})
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}

console.log(failures ? `\n✗ ${failures} 项没通过` : '\n✓ 全部通过')
process.exit(failures ? 1 : 0)
