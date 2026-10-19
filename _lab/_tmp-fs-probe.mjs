import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Cdp, sleep } from './cdp.mjs'

const CLI = path.resolve('bin/flicker.js')
const pf86 = process.env['PROGRAMFILES(X86)'] ?? ''
const pf = process.env['PROGRAMFILES'] ?? ''
const la = process.env['LOCALAPPDATA'] ?? ''
const EDGE = [
  path.join(pf86, 'Microsoft/Edge/Application/msedge.exe'),
  path.join(pf, 'Microsoft/Edge/Application/msedge.exe'),
  path.join(pf, 'Google/Chrome/Application/chrome.exe'),
  path.join(la, 'Google/Chrome/Application/chrome.exe'),
].find((p) => existsSync(p))

const PORT = 9500 + Math.floor(Math.random() * 200)
const gui = spawn(process.execPath, [CLI, '--gui'], {
  env: { ...process.env, FLICKER_NO_BROWSER: '1', FLICKER_NO_OPEN: '1', FLICKER_NO_NATIVE_PICK: '1' },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
})
const base = await new Promise((resolve, reject) => {
  let out = ''
  gui.stdout.on('data', (b) => {
    out += b
    const m = out.match(/(http:\/\/127\.0\.0\.1:\d+\/)/)
    if (m) resolve(m[1])
  })
  setTimeout(() => reject(new Error('GUI 超时\n' + out)), 20000)
})
const udd = await mkdtemp(path.join(tmpdir(), 'flicker-fs-probe-'))
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${udd}`,
  '--no-first-run', '--disable-gpu', base], { stdio: 'ignore', windowsHide: true })
try {
  const cdp = await Cdp.attach(PORT, '127.0.0.1')
  cdp.wire(); await cdp.send('Runtime.enable'); await sleep(1200)
  const info = () => cdp.eval(`JSON.stringify({
    root: getComputedStyle(document.documentElement).fontSize,
    box: !!document.querySelector('.fk-fs'),
    pct: document.querySelector('.fk-fs-pct')?.textContent,
    title: document.querySelector('[data-fk="inc"]')?.title,
    body: getComputedStyle(document.body).fontSize,
    hint: (() => { const el = document.querySelector('.hint, .sub, p'); return el ? getComputedStyle(el).fontSize : null })(),
    ctl: (() => { const el = document.querySelector('.fk-fs button'); return el ? getComputedStyle(el).fontSize : null })(),
    hintBox: (() => { const el = document.querySelector('.hint, p'); return el ? Math.round(el.getBoundingClientRect().height * 10) / 10 : null })(),
    zoom: document.documentElement.style.zoom || '(none)',
  })`)
  console.log('初始：', await info())
  await cdp.eval(`document.querySelector('[data-fk="inc"]').click()`)
  await sleep(200)
  console.log('点一次 A+：', await info())
  await cdp.eval(`document.querySelector('[data-fk="inc"]').click()`)
  await sleep(200)
  console.log('再点一次：', await info())
  await cdp.eval(`document.querySelector('[data-fk="reset"]').click()`)
  await sleep(200)
  console.log('点百分比（复位）：', await info())
  // 刷新后是否记住（重置后再点一次放大，然后 reload）
  await cdp.eval(`document.querySelector('[data-fk="inc"]').click()`)
  await sleep(200)
  await cdp.eval('location.reload()')
  await sleep(1500)
  console.log('刷新之后：', await info())
} finally {
  try { edge.kill() } catch { /* 已退出 */ }
  try { gui.kill() } catch { /* 已退出 */ }
}
