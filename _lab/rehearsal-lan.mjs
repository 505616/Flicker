/**
 * Windows 全流程演练 · 第 1 步（局域网 + 真浏览器）+ 第 5 步（销毁与残留）
 * ======================================================================
 *
 * 这个脚本不是"再跑一遍测试"，它回答的是另一个问题：**用户拿到这个东西会不会卡住**。
 * 所以它把真实用户路径上的东西接在一起：
 *
 *   真实 CLI 发送端（`node bin/flicker.js send`）
 *     + 真实的会话证书（装进当前用户 Root 库 —— 这是"零警告"承诺的前提）
 *     + **真实 Edge**（headless，不弹窗）
 *     + 接收端**真页面**（真点密码框、真点"开始接收"）
 *     + 一整套刁钻命名与目录结构（中文、空格、`#`、`%`、`&`、emoji、空文件、深嵌套）
 *
 * 判据（每条都对齐路线图第八章的发布判据②）：
 *   ① 页面能正常渲染 = **浏览器没有弹证书警告页**（有警告页就看不到应用自己的 DOM）
 *   ② 发送端退出码 0（它的完成判据是 ackedBase >= 总数，不是"看起来传完了"）
 *   ③ 接收页进入「完成」屏
 *   ④ **每个文件逐字节一致**（在页面里对收到的 Blob 算 SHA-256，与源文件比）
 *   ⑤ 发送端退出后，那条链接必须失效（一次性承诺）
 *   ⑥ 销毁清单四行都在
 *   ⑦ 残留：证书库条目数回到演练前、%TEMP% 无残留、无遗留进程
 *   可选 `--with-rate` 再验一次限速真的生效（实测速度 vs 设定值）
 *
 * ⚠️ 两处**刻意**与"人手点"不同，都写在输出里，不藏着：
 *   · 禁用 `showSaveFilePicker`，走内存 Blob 回退 —— 原生保存对话框
 *     无法在 headless 里驱动，那一截只能人工点（第 1 步的"你本人做"部分）
 *   · 不弹窗（`--show` 才会弹，仅调试用）
 *
 * 用法：
 *   node _lab/rehearsal-lan.mjs                 # 大文件 32 MiB + 一批小文件
 *   node _lab/rehearsal-lan.mjs 128             # 大文件 128 MiB
 *   node _lab/rehearsal-lan.mjs --with-rate     # 额外验限速（2 MB/s）
 *   node _lab/rehearsal-lan.mjs --keep          # 保留临时目录（排查用）
 *   node _lab/rehearsal-lan.mjs --show          # 弹浏览器窗口（**会弹窗**，调试用）
 */

import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  mkdtemp, mkdir, writeFile, readFile, rm, readdir, stat, open,
} from 'node:fs/promises'
import { randomBytes, createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Cdp, sleep, TRACE_PROBE } from './cdp.mjs'

const pexec = promisify(execFile)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MiB = 1024 * 1024

const argv = process.argv.slice(2)
const KEEP = argv.includes('--keep')
const SHOW = argv.includes('--show')
const WITH_RATE = argv.includes('--with-rate')
const SIZE_MIB = Number(argv.find((a) => /^\d+$/.test(a))) || 32

const PASSWORD = 'lan-rehearsal-pass-1'
const RATE_SPEC = '2M'
const RATE_BYTES = 2 * MiB
const RATE_FILE_MIB = 8
const DEBUG_PORT = 9500 + Math.floor(Math.random() * 200)
const STEP_TIMEOUT_MS = 240_000

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find(Boolean)

let failures = 0
const log = (...a) => console.log(...a)
const ok = (m) => log(`  ✅ ${m}`)
const bad = (m) => { log(`  ❌ ${m}`); failures++ }
const warn = (m) => log(`  ⚠️  ${m}`)

const cleanups = []
async function cleanup() {
  for (const fn of cleanups.reverse()) {
    // ⚠️ 清理函数有的是 async、有的只同步 kill —— 一律包一层 try/await，
    //    别让清理失败把真正的失败信息盖掉（这个坑在中继那条脚本里踩过）
    try { await fn() } catch { /* 尽力而为 */ }
  }
}

// ── 工具 ────────────────────────────────────────────────────

/** 递归列出目录下所有文件（相对路径 + 绝对路径），跳过符号链接 */
async function walk(dir, base = dir, out = []) {
  for (const name of (await readdir(dir)).sort()) {
    const full = path.join(dir, name)
    const st = await stat(full)
    if (st.isDirectory()) await walk(full, base, out)
    else if (st.isFile()) out.push({ rel: path.relative(base, full).split(path.sep).join('/'), full, size: st.size })
  }
  return out
}

const sha256File = async (p) => createHash('sha256').update(await readFile(p)).digest('hex')

/** Root 证书库里的条目数（certutil 的输出里每个证书一段 ====== 分隔） */
async function rootCertCount() {
  try {
    const { stdout } = await pexec('certutil', ['-user', '-store', 'Root'], { encoding: 'utf8' })
    return (stdout.match(/={5,}\s*Certificate\s+\d+/gi) ?? []).length
  } catch { return null }        // 拿不到就不判（不阻塞演练）
}

async function flickerTempDirs() {
  const entries = await readdir(tmpdir()).catch(() => [])
  return entries.filter((n) => n.startsWith('flicker'))
}

async function flickerProcesses() {
  try {
    const { stdout } = await pexec('powershell', ['-NoProfile', '-Command',
      "(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
      "Where-Object { $_.CommandLine -like '*flicker.js*' }).ProcessId",
    ], { encoding: 'utf8' })
    return stdout.split('\n').map((s) => s.trim()).filter(Boolean)
  } catch { return [] }
}

/** 从 CLI 输出里抓局域网链接。框线字符必须排除掉（踩过：`[^\s]+` 会把 `│` 一起吞进去） */
function extractLink(text) {
  const clean = text.replace(/\u001b\[[0-9;]*m/g, '')
  const m = clean.match(/https:\/\/[^\s│┌┐└┘─]+\/\?k=[A-Za-z0-9_\-]+/)
  return m ? m[0] : null
}

/** 页面上的状态快照 */
const STATE_PROBE = `(() => {
  const vis = (id) => { const el = document.getElementById(id); return el && !el.classList.contains('hide') };
  const txt = (id) => (document.getElementById(id)?.textContent || '').trim().slice(0, 120);
  return {
    screen: ['v-pw','v-busy','v-go','v-done','v-err'].filter(vis),
    pct: txt('go-pct'), done: txt('go-done'), speed: txt('go-speed'),
    errTitle: txt('err-title'), errMsg: txt('err-msg'), doneSum: txt('done-sum'),
  };
})()`

// ── 一次完整会话 ────────────────────────────────────────────
/**
 * 跑一次"发送端 + 真浏览器接收"，返回判据结果。
 * @param {{label:string, srcDir:string, extraArgs?:string[], timeoutMs?:number,
 *          denyWrite?:boolean}} opts
 *   denyWrite=true 时模拟"用户在文件夹窗口点了拒绝"（NotAllowedError）——
 *   用来验证页面会给出明确警告，而不是静默退到内存模式。
 */
async function session({ label, srcDir, extraArgs = [], timeoutMs = STEP_TIMEOUT_MS, denyWrite = false }) {
  log(`\n── ${label} ──────────────────────────────────────`)

  const cli = spawn(process.execPath, [
    'bin/flicker.js', 'send', srcDir,
    `--password=${PASSWORD}`, '--timeout=120s', '--no-qr', '--no-color', '--no-gift',
    ...extraArgs,
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  cleanups.push(() => { try { cli.kill() } catch { /* 已退出 */ } })

  let cliOut = ''
  let link = null
  cli.stdout.on('data', (b) => {
    cliOut += b.toString()
    if (!link) link = extractLink(cliOut)
  })
  cli.stderr.on('data', (b) => { cliOut += b.toString() })

  for (let i = 0; i < 200 && !link; i++) await sleep(100)
  if (!link) {
    bad(`${label}：发送端没有打印出链接\n${cliOut.slice(-800)}`)
    try { cli.kill() } catch { /* 已退出 */ }
    return { ok: false, link: null }
  }
  ok(`发送端已就绪：${link.replace(/\?k=.*/, '?k=…')}`)

  // 起浏览器（每次一个新 profile，避免缓存/权限残留影响判据）
  const profileDir = path.join(tmpdir(), `rehearsal-edge-${Date.now()}`)
  cleanups.push(() => rm(profileDir, { recursive: true, force: true }))
  const browser = spawn(EDGE, [
    SHOW ? '--new-window' : '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-features=Translate,MediaRouter', '--disable-gpu',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  cleanups.push(() => { try { browser.kill() } catch { /* 已退出 */ } })

  let cdp = null
  let result = { ok: false, link }
  try {
    cdp = await Cdp.attach(DEBUG_PORT)
    cdp.wire()
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')

    // 在页面自己的脚本之前注入：
    //   ① 探针（出错时能知道是谁抛的）
    //   ② **禁用原生保存对话框** —— headless 里驱动不了它。
    //      禁掉之后页面走内存 Blob 回退，并把 Blob 挂到 window.__blobs 上，
    //      我们就可以在页面里直接对它算 SHA-256（比等下载落盘可靠得多）。
    //   ③ denyWrite 模式下改成"让文件夹窗口抛 NotAllowedError"，
    //      模拟真实用户点了「拒绝」—— 这条路的代码分支完全不同，必须单独验。
    const pickerStub = denyWrite
      ? `
        const denied = () => Promise.reject(Object.assign(new Error('denied by user'),
          { name: 'NotAllowedError' }));
        Object.defineProperty(window, 'showDirectoryPicker', { value: denied, configurable: true });
        Object.defineProperty(window, 'showSaveFilePicker', { value: denied, configurable: true });
      `
      : `
        Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
        Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true });
      `
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: TRACE_PROBE + pickerStub + `
        window.__blobs = [];
        const oc = URL.createObjectURL.bind(URL);
        URL.createObjectURL = (b) => {
          // ⚠️ 只收**要下载的**那个 Blob。页面自己也会用 createObjectURL 造
          //    摘要 Worker 的脚本（type: text/javascript）—— 全收进来的话，
          //    校验会看到"多出来 N 个文件"，而它们其实是一段源码。
          //    实测踩过：那 8 个"多出来的文件"就是 8 个 Worker 脚本。
          try { if (b && b.type !== 'text/javascript') window.__blobs.push(b) } catch (e) {}
          return oc(b)
        };
      `,
    })

    const t0 = Date.now()
    await cdp.send('Page.navigate', { url: link })

    // ① 页面渲染出应用自己的 DOM = **没有证书警告页**
    let ready = false
    for (let i = 0; i < 120 && !ready; i++) {
      await sleep(200)
      ready = await cdp.eval(`!!document.getElementById('pw') && !!document.getElementById('btnStart')`)
        .catch(() => false)
    }
    if (!ready) {
      const title = await cdp.eval('document.title').catch(() => '?')
      bad(`${label}：接收页没有渲染出密码框（title=${JSON.stringify(title)}）—— ` +
        '多半是浏览器停在了证书警告页')
      return result
    }
    const sec = await cdp.eval(`({ secure: window.isSecureContext, proto: location.protocol, host: location.host })`)
    ok(`接收页已渲染（${sec.proto}//${sec.host}，isSecureContext=${sec.secure}）—— 说明**没有证书警告页**`)
    if (!sec.secure) bad(`${label}：不是安全上下文，会话证书那条链没走通`)

    // ② 填密码 + 点开始（用原生 setter，确保触发框架/监听器）
    await cdp.eval(`(() => {
      const el = document.getElementById('pw');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(PASSWORD)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return el.value.length;
    })()`)
    await cdp.eval(`document.getElementById('btnStart').click(); true`)
    const tStart = Date.now()
    ok('已填入密码并点了「开始接收」')

    // ③ 等结束
    let st = null
    let cliExit = null
    while (Date.now() - t0 < timeoutMs) {
      await sleep(400)
      st = await cdp.eval(STATE_PROBE).catch(() => null)
      if (cliExit === null && cli.exitCode !== null) cliExit = cli.exitCode
      if (st?.screen?.includes('v-done') || st?.screen?.includes('v-err')) break
    }
    // 发送端会先退（它拿到最后一条 ack 就结束），页面还要走收尾（整体校验 → 切屏）
    if (!st?.screen?.includes('v-done') && !st?.screen?.includes('v-err')) {
      for (let i = 0; i < 80; i++) {
        await sleep(250)
        const s2 = await cdp.eval(STATE_PROBE).catch(() => null)
        if (s2) st = s2
        if (st?.screen?.includes('v-done') || st?.screen?.includes('v-err')) break
      }
    }
    const elapsed = (Date.now() - tStart) / 1000

    if (st?.screen?.includes('v-err')) {
      bad(`${label}：接收页报错 —— ${st.errTitle} / ${st.errMsg}`)
      const trace = await cdp.eval('(window.__trace || []).slice(-30)').catch(() => null)
      if (trace?.length) { log('  页面探针：'); for (const t of trace) log('    ' + t) }
      // 密码不一致时把"页面到底拿什么去算的"也打出来 —— 否则只能猜
      const pwSeen = await cdp.eval(`(() => {
        const el = document.getElementById('pw');
        return { value: el ? el.value : null, len: el ? el.value.length : 0 };
      })()`).catch(() => null)
      log(`  页面输入框当时的值：${JSON.stringify(pwSeen)}（期望长度 ${PASSWORD.length}）`)
    }

    if (cli.exitCode === null) {
      log('  等发送端收尾（它要等到 ackedBase >= 总数）…')
      await Promise.race([new Promise((r) => cli.on('exit', r)), sleep(90_000)])
    }
    const clean = cliOut.replace(/\u001b\[[0-9;]*m/g, '')

    // ④ 判据：发送端退出码 0
    if (cli.exitCode === 0) ok('发送端退出码 0（= 全部消息都被接收端确认）')
    else bad(`${label}：发送端退出码 ${cli.exitCode}\n` +
      clean.split('\n').filter((l) => l.trim()).slice(-12).join('\n'))
    if (/等不到接收端的确认|传输没有完成/.test(clean)) bad('发送端报了"等不到确认/没有完成"')

    // ⑤ 判据：页面进入完成屏
    if (st?.screen?.includes('v-done')) ok(`接收页进入「完成」屏（${elapsed.toFixed(1)} 秒）`)
    else bad(`${label}：接收页没有进入完成屏（screen=${JSON.stringify(st?.screen)}）`)

    // ⑥ 判据：逐字节一致（在页面里对收到的 Blob 算 SHA-256）
    const pageHashes = await cdp.eval(`(async () => {
      const out = [];
      for (const b of (window.__blobs || [])) {
        const buf = await b.arrayBuffer();
        const d = await crypto.subtle.digest('SHA-256', buf);
        out.push({ size: buf.byteLength,
          sha256: [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('') });
      }
      return out;
    })()`, true).catch((e) => { bad(`在页面里算哈希失败：${e.message}`); return [] })

    const srcFiles = await walk(srcDir)
    const srcList = []
    for (const f of srcFiles) srcList.push({ rel: f.rel, size: f.size, sha256: await sha256File(f.full) })

    if (!pageHashes.length) {
      bad(`${label}：页面没有产出任何 Blob —— 逐字节校验没法做`)
    } else {
      const got = pageHashes.map((h) => h.sha256).sort()
      const want = srcList.map((h) => h.sha256).sort()
      const missing = want.filter((h) => !got.includes(h))
      const extra = got.filter((h) => !want.includes(h))
      if (!missing.length && !extra.length) {
        ok(`逐字节一致：${srcList.length} 个文件全部 SHA-256 相同` +
          `（共 ${(srcList.reduce((s, f) => s + f.size, 0) / MiB).toFixed(1)} MiB）`)
      } else {
        bad(`${label}：文件对不上 —— 少了 ${missing.length} 个、多了 ${extra.length} 个`)
        if (missing.length) {
          for (const h of srcList.filter((f) => missing.includes(f.sha256))) log(`      没收到的：${h.rel}`)
        }
      }
    }

    // ⑦ 判据：销毁清单（用 CLI **真实**打印的措辞；编造的措辞会误报 —— 第一版就是）
    //    局域网路径的六步见 src/run.js 的 destroyer.step 链。
    const destroyLines = [
      '会话密钥与密码验证值已清零',
      '发送端服务已关闭',
      '一次性链接已失效',
      '会话证书已从系统信任库移除',
      '服务器证书与私钥已从个人证书库移除',
      '会话 CA 的本地副本已从个人证书库移除',
    ]
    const missingLines = destroyLines.filter((l) => !clean.includes(l))
    if (!missingLines.length) ok(`销毁清单 ${destroyLines.length} 步都在`)
    else bad(`${label}：销毁清单缺少 —— ${missingLines.join('、')}`)

    // ⑧ 判据：发送端必须**提前**告诉用户"对方会看到什么"
    //
    // 2026-10 用户实测反馈："接收端有不安全的提醒" —— 行为本身是设计如此
    // （证书只装在发起方这台机器上），但发送端当时**什么都没说**：
    // 那句提示挂在了 `if (!trusted)` 下面，而"本机装了证书"恰恰让提示不打印，
    // 于是发送方以为一切正常、接收方对着一个红警告不知道点哪里。
    const hintLines = [
      '不安全',        // 明确说出对方会看到"不安全"
      '继续前往',      // 给出确切的按钮文字
    ]
    const missingHint = hintLines.filter((l) => !clean.includes(l))
    if (!missingHint.length) ok('发送端提前说明了"对方第一次会看到不安全提示、点继续前往"')
    else bad(`${label}：发送端没有告诉用户对方会看到什么（缺：${missingHint.join('、')}）—— ` +
      '接收方会对着一个红警告发呆')

    // ⑨ 判据（仅 denyWrite 模式）：拒绝授权后必须**明确说清楚**
    //
    // 2026-10 复查发现的静默路径：用户点"拒绝"之后页面会退到"先收进内存"，
    // 而那句"你的浏览器不支持流式写盘"的警告**不会**触发（浏览器本身支持）。
    // 小文件还撑得住，几十 GB 会在传到一半时把浏览器撑爆。
    // 现在：小文件给警告 + 继续；大文件直接明确失败（源码判据在 receiver-page.test.js）。
    if (denyWrite) {
      const note = await cdp.eval(`(() => {
        const el = document.getElementById('go-note-txt');
        const box = document.getElementById('go-note');
        return { txt: el ? el.textContent.trim().slice(0, 160) : null,
                 warn: box ? box.className.includes('warn') : false };
      })()`).catch(() => null)
      if (note?.txt && /内存|memory/i.test(note.txt)) {
        ok(`拒绝授权后页面给出了明确警告：${JSON.stringify(note.txt.slice(0, 60))}…`)
      } else {
        bad(`${label}：拒绝授权后**没有**给出"会先收进内存"的警告` +
          `（note=${JSON.stringify(note)}）—— 用户不会知道自己掉进了内存模式`)
      }
    }

    result = { ok: failures === 0, link, elapsed, st, clean, srcList }
  } catch (e) {
    bad(`${label}：演练过程出错 —— ${e.message}`)
  } finally {
    cdp?.close()
    try { browser.kill() } catch { /* 已退出 */ }
    // 发送端要留着（下面还要验"链接事后失效"），由调用方负责
  }
  return { ...result, cli }
}

// ══ 主流程 ═════════════════════════════════════════════════

log('\n══ Windows 全流程演练 · 局域网 + 真浏览器 ═══════════════')
log(`  大文件 ${SIZE_MIB} MiB · 调试端口 ${DEBUG_PORT}`)
log(`  浏览器：${SHOW ? '**会弹窗**（--show）' : 'headless（不弹窗）'}`)
log('  ⚠️ 会往**当前用户** Root 证书库装一张会话证书，程序退出时自动移除；')
log('     脚本会核对演练前后条目数一致。')
log('  ⚠️ 刻意禁用原生保存对话框（headless 驱动不了），走内存 Blob 回退 ——')
log('     那一截（点"保存"选目录）只能人工点，不在本脚本范围内。')

const work = await mkdtemp(path.join(tmpdir(), 'flicker-rehearsal-'))
cleanups.push(() => (KEEP ? Promise.resolve() : rm(work, { recursive: true, force: true })))

// ── 基线（演练前）────────────────────────────────────────────
log('\n【0】演练前的系统状态')
const certBefore = await rootCertCount()
const tempBefore = await flickerTempDirs()
const procBefore = await flickerProcesses()
log(`  Root 证书库条目：${certBefore ?? '（读不到，不判）'}`)
log(`  %TEMP% 里 flicker* ：${tempBefore.length}`)
log(`  在跑的 flicker 进程：${procBefore.length}`)

// ── 造源目录（刁钻命名 + 各种边界）──────────────────────────
const srcDir = path.join(work, '要发的文件')
await mkdir(path.join(srcDir, '文档', '子目录', '再深一层'), { recursive: true })

const bigName = '大文件.bin'
{
  const fh = await open(path.join(srcDir, bigName), 'w')
  const block = randomBytes(1 * MiB)
  for (let i = 0; i < SIZE_MIB; i++) await fh.write(block)
  await fh.close()
}
await writeFile(path.join(srcDir, '文档', '合同 扫描件.pdf'), randomBytes(64 * 1024))
await writeFile(path.join(srcDir, '文档', '子目录', 'notes & 备注 #1.txt'), '带空格、& 和 # 的名字\n')
await writeFile(path.join(srcDir, '文档', '子目录', '再深一层', 'deep.txt'), 'x'.repeat(1000))
await writeFile(path.join(srcDir, '空文件.txt'), '')                    // 0 字节的边界
await writeFile(path.join(srcDir, '火箭 🚀 emoji.txt'), 'emoji 文件名\n')
await writeFile(path.join(srcDir, '%百分号%.txt'), '百分号\n')
await writeFile(path.join(srcDir, '很长'.repeat(30) + '.txt'), '长文件名\n')

const srcFiles = await walk(srcDir)
log(`\n【1】源目录已就绪：${srcFiles.length} 个文件，共 ` +
  `${(srcFiles.reduce((s, f) => s + f.size, 0) / MiB).toFixed(1)} MiB`)
for (const f of srcFiles) log(`  · ${JSON.stringify(f.rel)}  ${f.size} B`)

// ── 演练一：完整会话 ────────────────────────────────────────
const s1 = await session({ label: '【2】局域网 + 真浏览器：完整传一次', srcDir })

// ── 判据：链接事后必须失效 ──────────────────────────────────
if (s1.link) {
  log('\n【3】销毁核对：链接必须失效')
  await sleep(800)
  let alive = false
  try {
    const r = await fetch(s1.link, { signal: AbortSignal.timeout(4000) })
    alive = r.ok || r.status < 500        // 还能连上就算没销毁
    if (alive) bad(`发送端已经退出，链接居然还活着（HTTP ${r.status}）`)
  } catch {
    ok('链接已失效（连不上了）—— 一次性承诺成立')
  }
}

// ── 可选：限速 ──────────────────────────────────────────────
if (WITH_RATE) {
  log('\n【4】限速演练')
  const rateDir = path.join(work, '限速用')
  await mkdir(rateDir, { recursive: true })
  {
    const fh = await open(path.join(rateDir, 'rate.bin'), 'w')
    const block = randomBytes(1 * MiB)
    for (let i = 0; i < RATE_FILE_MIB; i++) await fh.write(block)
    await fh.close()
  }
  const s2 = await session({
    label: `限速 ${RATE_SPEC}（文件 ${RATE_FILE_MIB} MiB）`,
    srcDir: rateDir, extraArgs: [`--rate=${RATE_SPEC}`],
  })
  if (s2.elapsed) {
    const mbps = RATE_FILE_MIB / s2.elapsed
    const lo = RATE_BYTES / MiB * 0.6, hi = RATE_BYTES / MiB * 1.6
    log(`  实测 ${mbps.toFixed(2)} MB/s（页面自报速度：${s2.st?.speed ?? '—'}）` +
      `，允许区间 ${lo.toFixed(2)}–${hi.toFixed(2)} MB/s`)
    if (mbps >= lo && mbps <= hi) ok(`限速生效：实测落在 ${RATE_SPEC} 附近`)
    else bad(`限速没生效或偏差过大：实测 ${mbps.toFixed(2)} MB/s，应为 ${RATE_BYTES / MiB} MB/s 上下`)
  }
} else {
  log('\n【4】限速演练：跳过（加 --with-rate 才跑）')
}

// ── 演练三：用户拒绝写入权限（小文件）──────────────────────
// 这条模拟一个很常见的误操作：文件夹窗口里点了"拒绝"。
// 期望：页面明确告诉用户"接下来会先收进内存"，并且**仍然把文件传完**。
log('\n【4b】拒绝写入权限（模拟用户在文件夹窗口点了「拒绝」）')
const s3 = await session({
  label: '拒绝授权 · 小文件应当给警告并继续',
  srcDir,
  denyWrite: true,
})

// ── 第 5 步：残留核对 ───────────────────────────────────────
log('\n【5】残留核对')
await sleep(1500)
const certAfter = await rootCertCount()
const tempAfter = (await flickerTempDirs()).filter((d) => !tempBefore.includes(d))
const procAfter = await flickerProcesses()

if (certBefore !== null && certAfter !== null) {
  if (certAfter === certBefore) ok(`Root 证书库条目数回到演练前（${certAfter}）`)
  else bad(`证书库没恢复：演练前 ${certBefore} → 现在 ${certAfter}`)
} else warn('证书库条目数读不到，这一条没验')

const leftovers = tempAfter.filter((d) => !/^rehearsal-edge-/.test(d))
if (!leftovers.length) ok('%TEMP% 里没有新增的 flicker* 残留')
else bad(`%TEMP% 里有残留：${leftovers.join('、')}`)

if (!procAfter.length) ok('没有遗留的 flicker 进程')
else bad(`还有 flicker 进程在跑：${procAfter.join('、')}`)

// ── 收尾 ────────────────────────────────────────────────────
try { s1.cli?.kill() } catch { /* 已退出 */ }
await cleanup()

log('')
if (failures) {
  log(`  ❌ 有 ${failures} 项未通过\n`)
  process.exit(1)
}
log('  ✅ 局域网 + 真浏览器 + 逐字节校验 + 销毁与残留：全部通过')
log('     还需**人工**确认的两截：① 双击 exe / SmartScreen / 防火墙（第 3 步）')
log('                              ② 原生"保存到"对话框（本脚本刻意禁用）')
if (KEEP) log(`  （临时目录保留在 ${work}）`)
log('')
