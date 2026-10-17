/**
 * 用**真实浏览器**跑一遍中继传输
 * =================================
 *
 * 为什么必须用真实浏览器：中继那条路的验证一直用的是 Node 端接收端
 * （`test/relay-e2e.test.js`、`_lab/verify-relay.mjs`），而浏览器页面
 * **从前根本不发 ack** —— 于是真实链路只能走完一个窗口就停住、
 * 发送端还误报成功，而所有验证一路绿灯。**验证脚本与真实客户端行为不一致，
 * 等于验证了另一条链路。**
 *
 * 这个脚本把真实的四样东西接在一起：
 *   ① 真实的 CLI 发送端（`node bin/flicker.js send --relay=…`）
 *   ② 真实的本地中继（`relay/local.mjs`，与 Cloudflare Worker 同一份实现）
 *   ③ **中继托管的真实接收页面**（`relay/page.generated.js`，即 web/receiver.html）
 *   ④ **真实的 Edge 浏览器**（headless，不开窗口）
 *
 * 判据是硬的：**发送端必须报 `ok:true`（= ackedBase >= 总消息数）** ——
 * 而确认只能来自浏览器里的那个页面。页面不 ack，这条测试必然失败。
 * 再加一条：把收到的文件下回来逐字节比对（下载路径可用时）。
 *
 * 实现上不用任何依赖：通过 CDP（Chrome DevTools Protocol）驱动，
 * 用的是 Node 内置的 WebSocket 与 fetch。
 *
 * 用法：
 *   node _lab/e2e-relay-browser.mjs             # 默认 4 MiB 文件
 *   node _lab/e2e-relay-browser.mjs 12          # 12 MiB
 *   node _lab/e2e-relay-browser.mjs --keep      # 保留临时目录（排查用）
 *   node _lab/e2e-relay-browser.mjs --show      # 显示浏览器窗口（调试用，会弹窗！）
 */

import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile, readFile, rm, mkdir, readdir, stat } from 'node:fs/promises'
import { randomBytes, createHash } from 'node:crypto'
import { makeTempDir, cleanupTempDirs } from '../gen/tmp.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Cdp } from './cdp.mjs'

const pexec = promisify(execFile)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MiB = 1024 * 1024

const argv = process.argv.slice(2)
const KEEP = argv.includes('--keep')
const SHOW = argv.includes('--show')
const SIZE_MIB = Number(argv.find((a) => /^\d+$/.test(a))) || 4
const RELAY_PORT = 8931 + Math.floor(Math.random() * 60)
const DEBUG_PORT = 9400 + Math.floor(Math.random() * 60)
const PASSWORD = 'browser-e2e-pass-1'
const OVERALL_TIMEOUT_MS = 180_000

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => p) // 存在性在下面用 fs 检查

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(...a)

let failures = 0
const ok = (m) => log(`  ✅ ${m}`)
const bad = (m) => { log(`  ❌ ${m}`); failures++ }

const cleanups = []
const cleanup = async () => {
  for (const fn of cleanups.reverse()) {
    // ⚠️ 有的清理函数返回 Promise，有的只是同步 kill —— 一律包一层。
    //    （第一版直接 `fn().catch(...)`，于是同步清理返回 undefined 时报
    //     "Cannot read properties of undefined (reading 'catch')"，
    //     把真正的失败信息盖掉了。）
    try { await fn() } catch { /* 尽力而为 */ }
  }
}
process.on('exit', () => { for (const fn of cleanups) { try { fn() } catch { /* 尽力 */ } } })

// ── CDP 小客户端 ───────────────────────────────────────────
// 实现已抽到 _lab/cdp.mjs（局域网那条演练脚本也要用；各写一份必然漂移）

// ── 主流程 ──────────────────────────────────────────────────

const work = makeTempDir('relay-browser-')
const downloadDir = path.join(work, 'downloads')
await mkdir(downloadDir, { recursive: true })
// ⚠️ 删不掉**要报出来**（见 gen/tmp.mjs 顶部）：浏览器 profile 一次五十多 MB，
//    2026-10 用户就是这么在自己的 %TEMP% 里发现十几份的（共 430 MB）。
cleanups.push(() => (KEEP ? Promise.resolve() : Promise.resolve(cleanupTempDirs())))

log(`\n══ 真实浏览器 · 中继端到端 ═══════════════════════════════`)
log(`  文件 ${SIZE_MIB} MiB · 中继端口 ${RELAY_PORT} · 调试端口 ${DEBUG_PORT}`)
log(`  模式：${SHOW ? '**会弹出浏览器窗口**（--show）' : 'headless（不弹窗）'}\n`)

// ① 造文件（内容确定，便于逐字节比对）
const srcDir = path.join(work, 'src')
await mkdir(srcDir, { recursive: true })
const srcFile = path.join(srcDir, 'test-data.bin')
const block = randomBytes(1 * MiB)
const srcHash = createHash('sha256')
{
  const fh = await (await import('node:fs/promises')).open(srcFile, 'w')
  for (let i = 0; i < SIZE_MIB; i++) {
    await fh.write(block); srcHash.update(block)
  }
  await fh.close()
}
const srcSum = srcHash.digest('hex')
log(`  源文件 ${srcFile}`)
log(`  SHA-256 ${srcSum.slice(0, 32)}…\n`)

// ② 起真实中继
const relay = spawn(process.execPath, ['relay/local.mjs', `--port=${RELAY_PORT}`],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
cleanups.push(() => { try { relay.kill() } catch { /* 已退出 */ } })
let relayOut = ''
relay.stdout.on('data', (b) => { relayOut += b.toString() })
relay.stderr.on('data', (b) => { relayOut += b.toString() })
await sleep(1200)
if (relay.exitCode !== null) { bad(`中继起不来:\n${relayOut}`); await cleanup(); process.exit(1) }
ok(`中继已启动（与 Cloudflare Worker 同一份协议实现）`)

// ③ 起真实 CLI 发送端
const cli = spawn(process.execPath, [
  'bin/flicker.js', 'send', srcFile,
  `--relay=http://127.0.0.1:${RELAY_PORT}`, `--password=${PASSWORD}`,
  '--timeout=120s', '--no-gift', '--no-qr', '--no-color',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
cleanups.push(() => { try { cli.kill() } catch { /* 已退出 */ } })

let cliOut = ''
let link = null
cli.stdout.on('data', (b) => {
  cliOut += b.toString()
  // ⚠️ 链接是印在**方框**里的：`│ http://…/#k=…&s=…│` —— 收尾的 `│` 与链接之间
  //    **没有空格**，所以 `[^\s]+` 会把框线字符一起吞进去。那样 salt 就变成
  //    33 个字符，页面的 `^[0-9a-f]{32}$` 校验不过 → readRelayParams() 返回 null
  //    → 页面退回**局域网**通路 → 去请求 /api/session → 中继回 404"没有这个接口"。
  //    第一版就是这么错的：界面上一句"没有这个接口"，看起来像中继坏了，
  //    其实是测试脚本多抓了一个字符。
  //    所以这里按**链接自身的格式**精确匹配，不做"非空白字符"这种宽匹配。
  const m = cliOut.replace(/\u001b\[[0-9;]*m/g, '')
    .match(/(https?:\/\/[^\s│┌┐└┘─]*\/#k=[0-9a-f]{64}&s=[0-9a-f]{32})/)
  if (m && !link) link = m[1]
})
cli.stderr.on('data', (b) => { cliOut += b.toString() })

for (let i = 0; i < 200 && !link; i++) await sleep(100)
if (!link) { bad(`CLI 没有打印出链接。输出:\n${cliOut}`); await cleanup(); process.exit(1) }
ok(`CLI 已就绪：${link.replace(/#.*/, '#…')}`)

// ④ 起真实浏览器（headless）
if (!(await stat(EDGE).catch(() => null))) { bad(`找不到 Edge: ${EDGE}`); await cleanup(); process.exit(1) }
const profileDir = path.join(work, 'edge-profile')
const edgeArgs = [
  SHOW ? '--new-window' : '--headless=new',
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${profileDir}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--disable-features=Translate,MediaRouter', '--disable-gpu',
  'about:blank',
].filter(Boolean)
const browser = spawn(EDGE, edgeArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
cleanups.push(() => { try { browser.kill() } catch { /* 已退出 */ } })
let browserErr = ''
browser.stderr.on('data', (b) => { browserErr += b.toString() })

let cdp = null
try {
  cdp = await Cdp.attach(DEBUG_PORT)
  cdp.wire()
  ok('浏览器已连上（CDP）')

  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  // 下载行为：接收页在没有目录选择器时走 Blob + <a download>
  await cdp.send('Browser.setDownloadBehavior', {
    behavior: 'allow', downloadPath: downloadDir, eventsEnabled: true,
  }).catch(() => cdp.send('Page.setDownloadBehavior', {
    behavior: 'allow', downloadPath: downloadDir,
  }))

  // 在页面自己的脚本之前注入探针：把 fetch / 文件选择器 / 错误构造都记下来。
  // 页面内部会 catch 掉异常并转成"出错了"，光看界面上的文字根本不知道是谁抛的。
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__trace = [];
      const T = (s) => { try { window.__trace.push(s) } catch (e) {} };
      const of = window.fetch;
      window.fetch = function (...a) {
        const u = String(a[0]);
        return of.apply(this, a).then((r) => { T('fetch ' + (a[1]?.method || 'GET') + ' ' + u + ' → ' + r.status); return r },
          (e) => { T('fetch ' + u + ' ✗ ' + (e && e.message)); throw e });
      };
      for (const n of ['showSaveFilePicker', 'showDirectoryPicker', 'showOpenFilePicker']) {
        const orig = window[n];
        if (typeof orig !== 'function') continue;
        window[n] = function (...a) {
          try { const r = orig.apply(this, a); T(n + '() 被调用 → 返回 promise'); return r }
          catch (e) { T(n + '() 同步抛 ' + e.name + ': ' + e.message); throw e }
        };
      }
      const oc = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (b) => { T('createObjectURL ' + (b && b.size) + 'B'); return oc(b) };
      const OrigError = window.Error;
      window.Error = function (...a) { const e = new OrigError(...a); T('new Error: ' + e.message); return e };
      window.Error.prototype = OrigError.prototype;
      window.addEventListener('unhandledrejection', (e) => T('unhandledrejection: ' + (e.reason && (e.reason.stack || e.reason.message || e.reason))));
    `,
  })

  await cdp.send('Page.navigate', { url: link })
  // 等页面把 fragment 读出来、把密码框渲染出来
  let ready = false
  for (let i = 0; i < 150 && !ready; i++) {
    await sleep(200)
    ready = await cdp.eval(`!!document.getElementById('pw') && !!document.getElementById('btnStart')`)
      .catch(() => false)
  }
  if (!ready) { bad('接收页没有渲染出密码框'); throw new Error('页面未就绪') }
  ok('接收页已渲染（中继托管的那份 HTML）')

  // ⚠️ 密码框要用**原生 setter** 赋值：直接 `el.value = x` 在某些情况下不会
  //    触发框架/监听器（这里没有框架，但保持一致习惯没坏处）
  await cdp.eval(`(() => {
    const el = document.getElementById('pw');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(PASSWORD)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value.length;
  })()`)
  await cdp.eval(`document.getElementById('btnStart').click(); true`)
  ok('已填入密码并点了「开始接收」')

  // ⑤ 等结果：要么发送端报完成，要么页面给出错误
  const t0 = Date.now()
  let cliExit = null, lastState = null
  while (Date.now() - t0 < OVERALL_TIMEOUT_MS) {
    await sleep(500)
    lastState = await cdp.eval(`(() => {
      const vis = (id) => { const el = document.getElementById(id); return el && !el.classList.contains('hide') };
      const txt = (id) => (document.getElementById(id)?.textContent || '').trim().slice(0, 120);
      return {
        screen: ['v-pw','v-busy','v-go','v-done','v-err'].filter(vis),
        cur: txt('cur-name'), pct: txt('go-pct'), done: txt('go-done'),
        errTitle: txt('err-title'), errMsg: txt('err-msg'),
        doneSum: txt('done-sum'),
      };
    })()`).catch(() => null)

    // 发送端退出 = 它已经有结论了（ok / 失败）
    if (cliExit === null && cli.exitCode !== null) cliExit = cli.exitCode

    if (lastState?.screen?.includes('v-done')) break
    if (lastState?.screen?.includes('v-err')) break
    if (cliExit !== null) break
  }

  // ⚠️ 发送端退出得比页面切屏**早**：它一收到最后一条 ack 就结束了，
  //    而页面还要走收尾（flushAcks → 整体校验 → 切完成屏）。
  //    所以这里要再等一小会儿，而不是立刻断言"没进完成屏"。
  if (!lastState?.screen?.includes('v-done') && !lastState?.screen?.includes('v-err')) {
    for (let i = 0; i < 60; i++) {
      await sleep(250)
      const st = await cdp.eval(`(() => {
        const vis = (id) => { const el = document.getElementById(id); return el && !el.classList.contains('hide') };
        const txt = (id) => (document.getElementById(id)?.textContent || '').trim().slice(0, 120);
        return { screen: ['v-pw','v-busy','v-go','v-done','v-err'].filter(vis),
          errTitle: txt('err-title'), errMsg: txt('err-msg'), doneSum: txt('done-sum') };
      })()`).catch(() => null)
      if (st) lastState = { ...lastState, ...st }
      if (lastState?.screen?.includes('v-done') || lastState?.screen?.includes('v-err')) break
    }
    log(`  收尾后的页面状态：${JSON.stringify(lastState)}`)
  }

  log(`  页面状态：${JSON.stringify(lastState)}`)
  // ⚠️ 只在**错误屏真的显示着**的时候才算错。
  //    `#err-title` 里一直留着默认文案（"出错了"），隐藏着也会被读出来 ——
  //    第一版就是这么误报的：页面明明停在完成屏，却报了一句"接收页报错：出错了 — —"。
  if (lastState?.screen?.includes('v-err')) {
    bad(`接收页报错：${lastState.errTitle} — ${lastState.errMsg}`)
    const trace = await cdp.eval('(window.__trace || []).slice(-40)').catch(() => null)
    if (trace?.length) {
      log('  页面内探针（最后 40 条）：')
      for (const t of trace) log('    ' + t)
    }
  }

  // 等发送端自己收尾 —— 它的完成判据是 `ackedBase >= total`，
  // 所以"它退出了、且报完成"正是被测的那条（浏览器有没有把 ack 全部送到）。
  // 给它足够时间：收到最后一个 ack 之后还要走销毁流程。
  if (cli.exitCode === null) {
    log('  等发送端确认收尾（它要等到 ackedBase >= 总数）…')
    await Promise.race([new Promise((r) => cli.on('exit', r)), sleep(60_000)])
  }

  const clean = cliOut.replace(/\u001b\[[0-9;]*m/g, '')
  // ⑥ 判据一：发送端报完成（= 浏览器确认了全部消息）
  if (cli.exitCode === 0) {
    ok('发送端退出码 0 —— 它只在「全部消息都被接收端确认」之后才会这样收尾')
  } else {
    bad(`发送端没有正常完成（退出码 ${cli.exitCode}）—— 它的完成判据是 ` +
      '`ackedBase >= total`，所以这一条直接反映浏览器有没有把 ack 送到。\n' +
      clean.split('\n').filter((l) => l.trim()).slice(-14).join('\n'))
  }
  if (/等不到接收端的确认|传输没有完成/.test(clean)) {
    bad('发送端报了"等不到确认/没有完成" —— 说明 ack 没有全部送到')
  }

  // ⑦ 判据二：页面显示完成 + 校验通过
  if (lastState?.screen?.includes('v-done')) ok('接收页进入「完成」屏')
  else bad(`接收页没有进入完成屏（screen=${JSON.stringify(lastState?.screen)}）`)

  // ⑧ 判据三：把下回来的文件逐字节比对
  await sleep(1500)                     // 等下载落盘
  const files = await readdir(downloadDir).catch(() => [])
  const got = files.filter((f) => !f.endsWith('.crdownload'))
  if (!got.length) {
    log('  ⚠️ 下载目录里没有文件 —— 无头模式下 <a download> 可能没落盘。' +
      '这一条**不算失败**，但也就没能逐字节验证（发送端报完成已经证明数据走通了）')
  } else {
    const bytes = await readFile(path.join(downloadDir, got[0]))
    const sum = createHash('sha256').update(bytes).digest('hex')
    if (sum === srcSum) ok(`下回来的文件逐字节一致（${(bytes.length / MiB).toFixed(1)} MiB，SHA-256 相同）`)
    else bad(`文件不一致：收到 ${bytes.length} 字节，期望 ${SIZE_MIB * MiB}`)
  }

  // ⑨ 判据四：中继侧不该看到明文
  const relaySawPlain = relayOut.includes('test-data') || relayOut.includes(PASSWORD)
  if (relaySawPlain) bad('中继的输出里出现了文件名或密码')
  else ok('中继侧没有出现明文内容（文件名与密码都没出现）')
} catch (e) {
  bad(`测试过程出错：${e.message}`)
  if (browserErr.trim()) log('  浏览器 stderr:\n' + browserErr.split('\n').slice(-6).join('\n'))
} finally {
  cdp?.close()
  await cleanup()
}

log('')
if (failures) {
  log(`  ❌ 有 ${failures} 项未通过\n`)
  process.exit(1)
}
log(`  ✅ 真实浏览器 + 真实中继 + 真实 CLI：跨网络那条路走得通\n`)
if (KEEP) log(`  （临时目录保留在 ${work}）\n`)
