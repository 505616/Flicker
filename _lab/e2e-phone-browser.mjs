/**
 * 真浏览器演练：手机上传页 → `flicker recv`（M2 的验收）
 * ======================================================
 *
 * 走的是**用户真正会走的那条路**：
 *   `flicker recv`（真子进程、真证书、真 HTTPS）→ headless Edge 打开手机页面
 *   → 填密码 → 注入文件（模拟相册选择）→ 点「开始发送」→ 页面上显示完成
 *   → 电脑上逐字节比对收到的文件 → 销毁清单 → 退出码 0
 *
 * 为什么必须用真浏览器：这一页的能力（`crypto.subtle`、`File.slice`、`DataTransfer`、
 * 安全上下文判定）在 Node 里都不存在 —— 而"手机上到底能不能用"恰恰取决于这些。
 * 单元测试能证明算法一致（`test/phone-page.test.js`），只有这里能证明**页面真的能跑**。
 *
 * ⚠️ 判据是"逐字节一致"，不是"页面显示成功"：
 *    页面说成功而字节不对，是这个项目最不能接受的失败方式。
 *
 * 用法：
 *   node _lab/e2e-phone-browser.mjs            # headless
 *   node _lab/e2e-phone-browser.mjs --show     # 开一个能看见的窗口（排查用）
 *   node _lab/e2e-phone-browser.mjs --keep     # 跑完不删临时目录（排查用）
 */
import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Cdp, sleep, TRACE_PROBE } from './cdp.mjs'
// 临时目录一律走这里（登记 + 退出兜底 + 删不掉会报出来，见 gen/tmp.mjs 顶部）
import { makeTempDir, cleanupTempDirs } from '../gen/tmp.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI = path.join(ROOT, 'bin', 'flicker.js')
const argv = process.argv.slice(2)
const SHOW = argv.includes('--show')
const KEEP = argv.includes('--keep')

const PASSWORD = 'k7m-3fq'
const DEBUG_PORT = 9600 + Math.floor(Math.random() * 200)
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(Boolean)

let failures = 0
const log = (...a) => console.log(...a)
const ok = (m) => log(`  ✅ ${m}`)
const bad = (m) => { log(`  ❌ ${m}`); failures++ }
const info = (m) => log(`  ·  ${m}`)

const cleanups = []
async function cleanup() {
  for (const fn of cleanups.reverse()) {
    try { await fn() } catch { /* 尽力而为 */ }
  }
}

/**
 * 确定性字节流（Node 与页面里各写一份、逐字节相同）。
 *
 * 为什么不用随机数 + 传过去：几 MB 的 base64 穿过 CDP 又慢又容易出错。
 * 只传"种子 + 长度"，两边各自生成同一串字节，再在电脑上比对收到的文件 ——
 * 判据依然是逐字节一致，而且**不依赖任何传输通道**。
 */
const STREAM_JS = `
function __stream(seed, size) {
  const out = new Uint8Array(size);
  let x = seed >>> 0;
  for (let i = 0; i < size; i++) {
    x ^= (x << 13); x >>>= 0;
    x ^= (x >>> 17);
    x ^= (x << 5); x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}
`

function streamBytes(seed, size) {
  const out = Buffer.alloc(size)
  let x = seed >>> 0
  for (let i = 0; i < size; i++) {
    x ^= (x << 13); x >>>= 0
    x ^= (x >>> 17)
    x ^= (x << 5); x >>>= 0
    out[i] = x & 0xff
  }
  return out
}

const sha = (b) => createHash('sha256').update(b).digest('hex')

/** 要发的文件：一个小的、一个跨 2 MiB 块的、一个空的 */
const FILES = [
  { name: 'note.txt', seed: 1, size: 137 },
  { name: '跨块的照片.bin', seed: 42, size: 2 * 1024 * 1024 + 1234 },
  { name: 'empty.dat', seed: 7, size: 0 },
]

async function main() {
  const work = makeTempDir('flicker-phone-e2e-')
  if (!KEEP) cleanups.push(() => { cleanupTempDirs(); return Promise.resolve() })
  else log(`  （临时目录保留：${work}）`)
  const inbox = path.join(work, 'inbox')
  const profileDir = path.join(work, 'edge-profile')
  const caFile = path.join(work, 'ca.cer')
  await mkdir(inbox, { recursive: true })

  // ── 起接收端（真命令）─────────────────────────────────────
  const cli = spawn(process.execPath, [
    CLI, 'recv', `--dir=${inbox}`, `--password=${PASSWORD}`,
    '--machine', `--machine-cert=${caFile}`, '--no-ask', '--no-open',
  ], {
    // 第二道保险：绝不弹资源管理器（临时目录随后就删，窗口会变成"位置不可用"错误框）
    env: { ...process.env, FLICKER_NO_OPEN: '1' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  cleanups.push(() => { try { cli.kill() } catch { /* 已退出 */ } })
  let cliOut = '', cliErr = ''
  cli.stdout.on('data', (b) => { cliOut += b.toString() })
  cli.stderr.on('data', (b) => { cliErr += b.toString() })
  const cliExit = new Promise((r) => cli.on('exit', (code) => r(code)))

  let base = null, token = null
  for (let i = 0; i < 400 && !base; i++) {
    await sleep(100)
    const m = cliOut.match(/__READY__ (\S+) (\S+)/)
    if (m) { base = m[1]; token = m[2] }
  }
  if (!base) { bad(`接收端没有就绪\n${cliOut}\n${cliErr}`); return }
  ok(`接收端已就绪：${base}`)
  if (!base.startsWith('https://')) bad('接收模式必须是 HTTPS —— 手机上明文 HTTP 不是安全上下文')

  // ── 起浏览器 ──────────────────────────────────────────────
  if (!EDGE) { bad('找不到 Edge/Chrome，跳过浏览器演练'); return }
  const browser = spawn(EDGE, [
    SHOW ? '--new-window' : '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-features=Translate,MediaRouter', '--disable-gpu',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  cleanups.push(() => { try { browser.kill() } catch { /* 已退出 */ } })

  const cdp = await Cdp.attach(DEBUG_PORT)
  cdp.wire()
  cleanups.push(() => cdp.close())
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')

  // 自签证书：浏览器会看到"不安全"。手机上是用户手动点"继续前往"，
  // 这里用 CDP 等价地放行 —— 关键是**放行之后它仍然是安全上下文**，
  // 否则 `crypto.subtle` 不存在，整页根本跑不起来（这正是要验的东西）。
  let certIgnored = false
  try {
    await cdp.send('Security.enable')
    await cdp.send('Security.setIgnoreCertificateErrors', { ignore: true })
    certIgnored = true
  } catch (e) {
    info(`CDP 不支持忽略证书错误（${e.message}）—— 改用命令行的等价开关`)
  }
  if (!certIgnored) {
    try { browser.kill() } catch { /* 忽略 */ }
    bad('这个浏览器不支持 Security.setIgnoreCertificateErrors —— 请手动跑 --show 看一眼证书页')
    return
  }

  // 页面脚本之前注入：① 探针（出错时知道是谁抛的）② 造文件的工具函数
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: TRACE_PROBE + STREAM_JS + `
      // 模拟相册选文件：造出 File 对象，塞进页面的 input 并触发 change
      window.__pick = (specs) => {
        const inputs = Array.from(document.querySelectorAll('input[type=file]'));
        if (!inputs.length) return 'no-input';
        const inp = inputs.find(i => (i.accept || '').includes('image')) || inputs[0];
        const dt = new DataTransfer();
        for (const s of specs) dt.items.add(new File([__stream(s.seed, s.size)], s.name));
        inp.files = dt.files;
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        // ⚠️ 必须在赋值**之后**读 input.files：把 FileList 赋给 input 之后，
        //    原来那个 DataTransfer 会被清空（规范如此）—— 读它就永远是 0。
        return inp.files.length;
      };
      window.__visible = (id) => {
        const el = document.getElementById(id);
        return !!el && !el.classList.contains('hide');
      };
    `,
  })

  const url = `${base}/?k=${encodeURIComponent(token)}`
  await cdp.send('Page.navigate', { url })

  // ① 页面渲染 + 安全上下文
  let ready = false
  for (let i = 0; i < 150 && !ready; i++) {
    await sleep(200)
    ready = await cdp.eval(`!!document.getElementById('pw')`).catch(() => false)
  }
  if (!ready) {
    const title = await cdp.eval('document.title').catch(() => '?')
    bad(`手机页面没有渲染（title=${JSON.stringify(title)}）—— 多半停在证书警告页`)
    return
  }
  const env = await cdp.eval(`({
    secure: window.isSecureContext, proto: location.protocol,
    subtle: !!(window.crypto && window.crypto.subtle),
    core: !!window.FlickerPhone, paths: !!window.FlickerPaths, i18n: !!window.FlickerI18N,
    wakeLock: !!(navigator.wakeLock && navigator.wakeLock.request),
    hashing: typeof window.FlickerPhone.Sha256 === 'function',
  })`)
  ok(`手机页面已渲染（${env.proto}，isSecureContext=${env.secure}）`)
  if (!env.secure) bad('不是安全上下文 —— 手机上 crypto.subtle 会不存在，整页跑不起来')
  if (!env.subtle) bad('crypto.subtle 不存在')
  if (!env.core || !env.paths || !env.i18n) {
    bad(`内联段没齐：core=${env.core} paths=${env.paths} i18n=${env.i18n}`)
  }
  info(`wakeLock ${env.wakeLock ? '可用' : '不可用（这个环境正常，页面上有提示）'}`)

  // ② 密码 → 连接
  await cdp.eval(`(() => {
    const el = document.getElementById('pw');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(PASSWORD)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btnConnect').click();
    return true;
  })()`)
  let picked = false
  const tConnect = Date.now()
  for (let i = 0; i < 200 && !picked; i++) {
    await sleep(150)
    picked = await cdp.eval(`window.__visible('v-pick')`).catch(() => false)
    const onErr = await cdp.eval(`window.__visible('v-err')`).catch(() => false)
    if (onErr) {
      const t = await cdp.eval(`document.getElementById('errTitle').textContent + ' / ' +
        document.getElementById('errMsg').textContent`)
      bad(`连接失败：${t}`)
      return
    }
  }
  if (!picked) { bad('点了连接之后没有进入选文件界面'); return }
  ok(`密码核对通过（PBKDF2 60 万轮 + 双向 MAC 验证，用时 ${Date.now() - tConnect} ms）`)

  // ③ 注入文件（模拟从相册选）
  //
  // ⚠️ 判据看**页面自己的列表**，不看 `input.files`：页面的 change 处理器
  //    处理完会 `input.value = ''`（这样用户能再选同一个文件），所以注入完再读
  //    input.files 永远是 0 —— 第一版就是这么误报的（页面其实收下了 3 个文件）。
  await cdp.eval(`window.__pick(${JSON.stringify(FILES)})`)
  let listed = 0
  for (let i = 0; i < 50 && listed !== FILES.length; i++) {
    await sleep(100)
    listed = await cdp.eval(`document.querySelectorAll('#fileList li').length`).catch(() => 0)
  }
  if (listed !== FILES.length) bad(`页面列表里只有 ${listed} 个文件（应为 ${FILES.length}）`)
  else ok(`已选 ${listed} 个文件（${FILES.map((f) => f.name).join('、')}）`)

  // ④ 等校验值算完（清单里要带整文件 SHA-256）
  const tHash = Date.now()
  let canSend = false
  for (let i = 0; i < 600 && !canSend; i++) {
    await sleep(100)
    canSend = await cdp.eval(`!document.getElementById('btnSend').disabled`).catch(() => false)
    const onErr = await cdp.eval(`window.__visible('v-err')`).catch(() => false)
    if (onErr) {
      const t = await cdp.eval(`document.getElementById('errMsg').textContent`)
      bad(`算校验值时出错：${t}`)
      return
    }
  }
  if (!canSend) { bad('校验值一直没算完（按钮始终不可点）'); return }
  ok(`校验值已算好，用时 ${Date.now() - tHash} ms（约 ${(2.1 / ((Date.now() - tHash) / 1000)).toFixed(1)} MB/s，纯 JS）`)

  // ⑤ 开始发送，并**盯着进度真的在动**
  await cdp.eval(`document.getElementById('btnSend').click(); true`)
  let sawProgress = false, sawGo = false, maxPct = -1
  const tSend = Date.now()
  for (let i = 0; i < 600; i++) {
    await sleep(120)
    const st = await cdp.eval(`({
      go: window.__visible('v-go'), done: window.__visible('v-done'), err: window.__visible('v-err'),
      pct: document.getElementById('totalPct').textContent,
      cur: document.getElementById('curFile').textContent,
    })`).catch(() => null)
    if (!st) continue
    if (st.go) sawGo = true
    if (st.pct) {
      const v = parseInt(String(st.pct).replace('%', ''), 10)
      if (v > maxPct) maxPct = v
      if (v > 0) sawProgress = true
    }
    if (st.err) {
      const t = await cdp.eval(`document.getElementById('errTitle').textContent + ' / ' +
        document.getElementById('errMsg').textContent`)
      bad(`发送中出错：${t}`)
      return
    }
    if (st.done) break
  }
  const secs = (Date.now() - tSend) / 1000
  const doneVisible = await cdp.eval(`window.__visible('v-done')`)
  if (!doneVisible) { bad('没有走到"全部发完"界面'); return }
  if (!sawGo) info('（没捕捉到传输中界面 —— 数据太小，可能一帧就到了）')
  ok(`页面显示已完成：进度爬到 ${maxPct}%，用时 ${secs.toFixed(1)} s` +
    `（${(2.1 / secs).toFixed(1)} MB/s，含加密与 HTTP 往返）`)

  const doneText = await cdp.eval(`document.getElementById('doneDetail').textContent`)
  info(`完成页文案：${doneText}`)

  // ⑥ 电脑侧：逐字节比对 + 销毁清单 + 退出码
  const code = await Promise.race([cliExit, sleep(30000).then(() => 'timeout')])
  if (code !== 0) bad(`接收端退出码 ${code}（应为 0）\n${cliOut.slice(-1500)}\n${cliErr.slice(-500)}`)
  else ok('接收端以 0 退出')

  const names = (await readdir(inbox)).sort()
  const want = FILES.map((f) => f.name).sort()
  if (JSON.stringify(names) !== JSON.stringify(want)) {
    bad(`落盘的文件不对：${JSON.stringify(names)}（应为 ${JSON.stringify(want)}）`)
  } else {
    ok(`落盘文件：${names.join('、')}`)
  }
  for (const f of FILES) {
    let got
    try { got = await readFile(path.join(inbox, f.name)) } catch { bad(`${f.name} 不在磁盘上`); continue }
    const expect = streamBytes(f.seed, f.size)
    if (got.length !== expect.length) { bad(`${f.name} 长度不对：${got.length} ≠ ${expect.length}`); continue }
    if (sha(got) !== sha(expect)) { bad(`${f.name} 内容不一致（逐字节比对）`); continue }
    ok(`${f.name} 逐字节一致（${f.size} 字节）`)
  }
  if (cliOut.includes('收到的文件已保留在')) ok('销毁清单写明了"收到的文件保留在哪"')
  else bad('销毁清单里没有"收到的文件已保留"')
  if ((await readdir(inbox)).some((x) => x.endsWith('.flicker-part'))) bad('留下了半成品文件')
}

main()
  .catch((e) => { bad(`脚本抛错：${e?.stack ?? e}`) })
  .finally(async () => {
    await cleanup()
    log(failures ? `\n✗ ${failures} 项没通过` : '\n✓ 全部通过')
    process.exitCode = failures ? 1 : 0
  })
