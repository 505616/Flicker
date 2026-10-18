/**
 * 图形界面里的「从对方的链接接收」（2026-10 新增）
 * ================================================
 * 这一条验的是用户真的会走的那条路：对方屏幕上有一条链接 + 一个一次性密码，
 * 把它们贴进站点页的「从对方的链接接收」，由**这台电脑的程序自己**去取文件。
 *
 * 判据分四层，每一层都要能**证伪**：
 *
 *   ① **真的收得下来**：起一个真发送端（CLI，走用户默认那条），界面里
 *      `/api/pull/probe` 拿到指纹 → `/api/pull/start` → `/api/state` 里看到 `done`，
 *      磁盘上逐字节一致、不留 `.flicker-part`、发送端因为收到 `/api/done` 而退出。
 *   ② **不核对就不许开始**：没确认、没打指纹、又没明确选「不核对」→ 必须拒绝
 *      （`NEED_CONFIRM`），且一个字节都不写。填错指纹 → 拒绝（`FINGERPRINT`）。
 *   ③ **停止是真的中断**：用一个限速的发送端，让传输持续几秒；点停止后状态变
 *      `stopped`，而且**定稿文件不存在**（只可能留 `.flicker-part`）。
 *   ④ **页面里真的有点得着的入口**：`#pullOpen` 能进到面板，面板上该有的元素全在，
 *      用到的每一条 `pullui.*` 文案都翻得出来（中英各一份）。
 *
 * ⚠️ 为什么由 Node 去取、而不是页面自己 fetch：页面在 `http://127.0.0.1:<端口>`，
 *    对方在 `https://192.168.x.x:<端口>` —— 跨源，而且对方是自签证书，
 *    浏览器不给 XHR 点「继续前往」。所以取文件走 `src/pull.js`（与命令行同一个实现），
 *    证书那一关改成"人核对 8 位指纹"。这条用例验的就是这个接线。
 *
 * ⚠️ 图形界面**一次只起一个**（启动会清理同名残留证书），所以每条用例结束就杀掉它。
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { STRINGS, LANGS } from '../web/i18n-strings.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CLI = path.join(ROOT, 'bin', 'flicker.js')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const cleanups = []
const live = []
test.after(async () => {
  for (const c of live.splice(0)) { try { c.kill() } catch { /* 已退出 */ } }
  await sleep(150)
  for (const fn of cleanups.reverse()) {
    try { await fn() } catch (e) { console.error('清理失败：' + (e?.message ?? e)) }
  }
})

// 每条用例结束就杀干净：两个界面同时活会互删对方的会话证书（见 gui.test.js）
afterEach(async () => {
  for (const c of live.splice(0)) { try { c.kill() } catch { /* 已退出 */ } }
  await sleep(150)
})

async function tempDir(tag) {
  const dir = await mkdtemp(path.join(tmpdir(), `flicker-${tag}-`))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** 起一个真发送端（CLI + `--machine`），把它屏幕上的链接、令牌、指纹都读出来 */
function startSender(args) {
  return new Promise((resolve, reject) => {
    // `--no-cert-install`：这些用例只验接收端。装了却因为被杀没走销毁链，
    // 会把证书留在系统库里（`test/trust.test.js` 有"数量必须一致"的断言）。
    const child = spawn(process.execPath, [CLI, ...args, '--machine', '--no-cert-install'],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    live.push(child)
    let out = '', err = ''
    // ⚠️ 退出码要**先记下来**，不能靠在用例里临时挂 `exit` 监听器。
    //    这条在 CI 的 Ubuntu 上红过一次：那边传得快，发送端在用例挂监听器**之前**
    //    就已经退出了，于是等到超时也拿不到码（`null !== 0`，看起来像"发送端没退出"）。
    //    事件不会为后来的监听器重放 —— 所以在这里就把它变成一条可 await 的 promise。
    let exitCode = null
    const exited = new Promise((res) => {
      child.on('exit', (code) => { exitCode = code; res(code) })
    })
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已退出 */ }
      reject(new Error(`发送端启动超时\n${out}\n${err}`))
    }, 30000)
    const onData = (b, isErr) => {
      const s = b.toString()
      if (isErr) err += s; else out += s
      const m = out.match(/__READY__ (\S+) (\S+)/)
      const fp = out.match(/__FINGERPRINT__ (\w+)/)
      if (m && fp) {
        clearTimeout(timer)
        resolve({
          child, base: m[1], token: m[2], fingerprint: fp[1],
          link: `${m[1]}/?k=${m[2]}`, getOut: () => out, getErr: () => err,
          /** 等它自己退出；超时返回 null（已经退出的话立刻拿到码） */
          waitExit: (ms = 20000) => Promise.race([
            exited,
            new Promise((r) => setTimeout(() => r(null), ms)),
          ]),
          exitCode: () => exitCode,
        })
      }
    }
    child.stdout.on('data', (b) => onData(b, false))
    child.stderr.on('data', (b) => onData(b, true))
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code) reject(new Error(`发送端提前退出 (${code})\n${out}\n${err}`))
    })
  })
}

/** 起一个真图形界面（不开浏览器窗口） */
function startGui() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, '--gui'], {
      // `FLICKER_NO_OPEN` 也必须给：传完会弹资源管理器，而临时目录随后就被删了 ——
      // 那个窗口会变成用户桌面上的一张"位置不可用"错误框（用户实测到过）。
      // ⚠️ `FLICKER_NO_NATIVE_PICK=1`：整套自动化里**一个系统窗口都不许弹**。
      //    没有它，"点选择文件夹"会真的弹出 Windows 的文件夹对话框并卡在那儿等人点。
      env: {
        ...process.env, FLICKER_NO_BROWSER: '1', FLICKER_NO_OPEN: '1', FLICKER_NO_NATIVE_PICK: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    live.push(child)
    let out = '', err = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已退出 */ }
      reject(new Error(`界面启动超时\n${out}\n${err}`))
    }, 30000)
    const onData = (b, isErr) => {
      const s = b.toString()
      if (isErr) err += s; else out += s
      const m = out.match(/(http:\/\/127\.0\.0\.1:\d+\/)/)
      if (m) { clearTimeout(timer); resolve({ child, base: m[1], getOut: () => out, getErr: () => err }) }
    }
    child.stdout.on('data', (b) => onData(b, false))
    child.stderr.on('data', (b) => onData(b, true))
    child.on('exit', (c) => {
      clearTimeout(timer)
      if (c) reject(new Error(`界面退出 (${c})\n${out}\n${err}`))
    })
  })
}

async function bootGui() {
  const gui = await startGui()
  // ⚠️ `body === undefined` 才是 GET。没有参数的命令也必须显式传 `{}`，
  //    否则发成 GET，服务端 404（gui-recv.test.js 踩过这个坑）。
  const api = async (p, body) => {
    const r = await fetch(gui.base + 'api/' + p, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await r.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* 非 JSON */ }
    return { status: r.status, json, text }
  }
  return { gui, api }
}

/** 等 /api/state 里的 pull 满足条件（界面就是靠轮询看到它的） */
async function waitPull(api, pred, { ms = 60000, what = '接收状态' } = {}) {
  const t0 = Date.now()
  let last = null
  while (Date.now() - t0 < ms) {
    const r = await api('state')
    last = r.json?.pull ?? null
    if (pred(last)) return last
    await sleep(100)
  }
  throw new Error(`等「${what}」超时，最后一次状态：${JSON.stringify(last)}`)
}


// ── ① 真的收得下来 ─────────────────────────────────────────

test('⭐ 界面：探测 → 核对指纹 → 开始 → 收完（逐字节一致、不留半成品）', { timeout: 180000 }, async () => {
  const work = await tempDir('pull-gui-e2e')
  const src = path.join(work, 'src')
  const out = path.join(work, 'out')
  await mkdir(path.join(src, '照片'), { recursive: true })
  await mkdir(out, { recursive: true })
  await writeFile(path.join(src, 'hello.txt'), 'hello gui pull 世界')
  await writeFile(path.join(src, '照片', 'sunset.bin'), randomBytes(3000))
  await writeFile(path.join(src, 'empty.dat'), '')

  // ⚠️ 先起界面、再起发送端：界面启动时会清理残留证书，反过来会把正在用的那份当成残留
  const { api } = await bootGui()
  const sender = await startSender(['send', src, '--password=pull-gui-pass', '--no-qr', '--no-color', '--no-gift'])

  // 状态里要有一个默认保存目录（页面拿它填输入框）
  const s0 = (await api('state')).json
  assert.equal(s0.pull, null, '还没开始时状态里应当是 null（页面据此显示"可以开始"）')
  assert.equal(typeof s0.pullDefaultDir, 'string')
  assert.ok(s0.pullDefaultDir.length > 0, '要有一个默认保存目录')

  // ① 探测：只连一次，把证书指纹算出来
  const probe = await api('pull/probe', { link: sender.link })
  assert.equal(probe.json?.ok, true, `探测应当成功：${probe.text}`)
  assert.equal(probe.json.tls, true, '发送端是 https，应当报告有证书')
  assert.equal(probe.json.fingerprint, sender.fingerprint.slice(0, 8).toUpperCase(),
    '界面显示的指纹必须就是对方屏幕上那 8 位（用户要拿它对照）')

  // ② 开始（等价于用户点了"指纹一致，开始接收"）：不许 await 到传完，
  //    否则这个 HTTP 请求会挂到结束为止（发送端踩过同一个坑）
  const started = Date.now()
  const start = await api('pull/start', {
    link: sender.link, password: 'pull-gui-pass', dir: out,
    typed: probe.json.fingerprint, confirm: true,
  })
  assert.equal(start.json?.ok, true, `开始应当成功：${start.text}`)
  assert.ok(Date.now() - started < 5000, '`/api/pull/start` 必须立刻返回（传输在后台跑）')

  // ③ 等它传完
  const done = await waitPull(api, (p) => p && p.phase === 'done', { what: '接收完成' })
  assert.equal(done.phase, 'done')
  assert.equal(done.error, null)
  assert.equal(done.report?.failed, 0, `不该有失败的文件：${JSON.stringify(done.failed)}`)
  assert.equal(done.report?.files, 3, `应当收到 3 个文件：${JSON.stringify(done.report)}`)
  assert.ok(done.report.bytes > 3000, '报告的总字节数要包含那 3 KB 的二进制文件')
  assert.equal(done.dir, out, '状态里要写明存到哪个目录了（页面显示它）')
  assert.ok(done.elapsed >= 0, '要用时')

  // ④ 磁盘上逐字节一致
  //    传的是**整个目录**，所以清单里的相对路径带目录名（`src/hello.txt`）——
  //    这是 `scan()` 的约定，不是 bug。
  assert.equal(String(await readFile(path.join(out, 'src', 'hello.txt'))), 'hello gui pull 世界')
  assert.equal((await readFile(path.join(out, 'src', '照片', 'sunset.bin'))).length, 3000)
  assert.equal((await readFile(path.join(out, 'src', 'empty.dat'))).length, 0)

  // ⑤ 不留半成品
  for (const name of await readdir(out)) {
    assert.ok(!name.endsWith('.flicker-part'), `不该留下半成品：${name}`)
  }

  // ⑥ 发送端因为收到 /api/done 而收尾退出（协议里的完成判据，用完即销毁）
  assert.equal(await sender.waitExit(), 0, '发送端应当在收到 /api/done 之后正常退出')
})

// ── ② 不核对就不许开始 ──────────────────────────────────────

test('没核对指纹就点开始 → 拒绝，且一个字节都不写', { timeout: 120000 }, async () => {
  const work = await tempDir('pull-gui-noconfirm')
  const src = path.join(work, 'src')
  const out = path.join(work, 'out')
  await mkdir(src, { recursive: true })
  await mkdir(out, { recursive: true })
  await writeFile(path.join(src, 'a.txt'), 'secret')

  const { api } = await bootGui()
  const sender = await startSender(['send', src, '--password=pull-gui-nc', '--no-qr', '--no-color', '--no-gift'])
  await api('pull/probe', { link: sender.link })

  // 既不确认、也不打指纹、也没选"不核对"
  const r = await api('pull/start', {
    link: sender.link, password: 'pull-gui-nc', dir: out,
  })
  assert.equal(r.json?.ok, false, '不核对就应当拒绝')
  assert.equal(r.json.code, 'NEED_CONFIRM')
  assert.match(r.json.error, /核对/)
  assert.deepEqual(await readdir(out), [], '被拒绝时一个字节都不该写')

  // 填错指纹：明说"可能有人在冒充"
  const wrong = sender.fingerprint.slice(0, 8) === '00000000' ? '11111111' : '00000000'
  const r2 = await api('pull/start', {
    link: sender.link, password: 'pull-gui-nc', dir: out, typed: wrong, confirm: true,
  })
  assert.equal(r2.json?.ok, false, '指纹不一致就应当拒绝')
  assert.equal(r2.json.code, 'FINGERPRINT')
  assert.match(r2.json.error, /冒充/)
  assert.deepEqual(await readdir(out), [], '指纹不一致时也不许写任何东西')

  // 状态不能因为两次拒绝就变成"在传"或"传完了"
  const p = (await api('state')).json.pull
  assert.notEqual(p?.phase, 'done', '被拒绝之后不许显示"已收完"')

  try { sender.child.kill() } catch { /* 已退出 */ }
})

// ── ③ 停止是真的中断 ───────────────────────────────────────

test('停止按钮真的中断：状态变 stopped，定稿文件不存在', { timeout: 180000 }, async () => {
  const work = await tempDir('pull-gui-stop')
  const src = path.join(work, 'src')
  const out = path.join(work, 'out')
  await mkdir(src, { recursive: true })
  await mkdir(out, { recursive: true })
  // 512 KB，块 32 KB、限速 100K/s ≈ 5 秒 —— 足够在传完之前点停止。
  // ⚠️ 必须同时压块大小：限速桶会**长大到装得下请求的块**（rate.js 里"坑二"的
  //    正确解法），所以默认 1 MiB 的块配上 200K/s 仍然是一次突发送完 1 MiB ——
  //    实测 2 MB 只花 209 ms，根本没有可以按停止的窗口。
  await writeFile(path.join(src, 'big.bin'), randomBytes(512 * 1024))

  const { api } = await bootGui()
  const sender = await startSender([
    'send', src, '--password=pull-gui-stop', '--no-qr', '--no-color', '--no-gift',
    '--chunk=32K', '--rate=100K',
  ])
  const probe = await api('pull/probe', { link: sender.link })
  assert.equal(probe.json?.ok, true, `探测应当成功：${probe.text}`)

  const start = await api('pull/start', {
    link: sender.link, password: 'pull-gui-stop', dir: out,
    typed: probe.json.fingerprint, confirm: true,
  })
  assert.equal(start.json?.ok, true, `开始应当成功：${start.text}`)

  // 等它真的开始往下写（拿到几块字节），再点停止
  await waitPull(api, (p) => p && p.phase === 'transfer' && (p.progress?.bytes ?? 0) > 0,
    { what: '开始收到字节' })
  const stop = await api('pull/stop', {})
  assert.equal(stop.json?.ok, true, `停止应当成功：${stop.text}`)

  const p = await waitPull(api, (s) => s && s.phase === 'stopped', { what: '状态变 stopped' })
  assert.equal(p.phase, 'stopped')
  assert.equal(p.error, null, '这是用户主动停止，不该报错')

  // 定稿文件**不存在**（只可能留 `.flicker-part`：用户能看出那是没收完的）
  const names = await readdir(path.join(out, 'src'))
  assert.ok(!names.includes('big.bin'), `定稿文件不该存在：${names.join('、')}`)
  assert.ok(names.length >= 1, '中断之后应当能看到半成品 —— 用户据此看出"这个文件没收完"')
  for (const n of names) {
    assert.ok(n.endsWith('.flicker-part'), `中断之后只该留半成品：${n}`)
  }

  // 停止是幂等的：再点一次不会炸
  assert.equal((await api('pull/stop', {})).json?.ok, true)

  try { sender.child.kill() } catch { /* 已退出 */ }
})

// ── ④ 页面里真的有点得着的入口 ──────────────────────────────

test('页面：入口、面板元素、接线、文案（中英各一份）都在', { timeout: 60000 }, async () => {
  const html = await readFile(path.join(ROOT, 'web', 'station.html'), 'utf8')

  // 入口 + 面板
  assert.match(html, /id="pullEntry"/, '要有「从对方的链接接收」的入口块')
  assert.match(html, /id="pullOpen"[^>]*data-i18n="pullui\.enter"/, '入口按钮要带文案标注')
  assert.match(html, /id="v-pull"/, '要有独立的一屏')
  for (const id of [
    'pullLink', 'pullPassword', 'pullDir', 'pullDirPick', 'pullProbe', 'pullBack',
    'pullConfirm', 'pullFp', 'pullTlsNote', 'pullStart', 'pullInsecure', 'pullConfirmBack',
    'pullLive', 'pullStateLine', 'pullDirShow', 'pullBytes', 'pullTotal', 'pullPct',
    'pullBar', 'pullCur', 'pullSpeed', 'pullElapsed', 'pullStop',
    'pullFinished', 'pullResult', 'pullOpenDir', 'pullBack2',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `面板里缺元素 #${id}`)
  }

  // 接线：这一屏要能被切换进来、初始化、并在轮询里渲染
  assert.match(html, /'v-pull'/, "VIEWS 里要包含 'v-pull'（否则 show() 切不过去）")
  assert.match(html, /function initPull\s*\(/, '要有 initPull()')
  assert.match(html, /^\s*initPull\(\)/m, 'initPull() 要被调用（否则按钮全是死的）')
  assert.match(html, /renderPull\(s\.pull\)/, 'applyState 里要渲染 pull 状态')

  // 文案：页面用到的每一条 pullui.* 都要翻得出来（中英各一份，缺一条屏幕上就是键名）
  const used = new Set()
  // ⚠️ 一定要排除 `'pullui.err.' + code` 这种**动态拼接**的前缀：
  //    它不指向任何一条具体文案，硬算进去只会误报"缺文案 pullui.err."（踩过）。
  const KEY = 'pullui\.([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)'
  const clean = html.replace(/<!--[\s\S]*?-->/g, '')
  for (const m of clean.matchAll(new RegExp(`'${KEY}'`, 'g'))) used.add(m[1])
  for (const m of clean.matchAll(new RegExp(`data-i18n="${KEY}"`, 'g'))) used.add(m[1])
  assert.ok(used.size >= 30, `页面里应当用到若干 pullui 文案（实际 ${used.size} 条）`)
  for (const { code: lang } of LANGS) {
    const table = STRINGS[lang]
    for (const key of used) {
      assert.equal(typeof table['pullui.' + key], 'string',
        `[${lang}] 缺文案 pullui.${key} —— 屏幕上会直接显示这个键名`)
    }
  }

  // 两边的文案条目一一对应（漏了一条就是那种语言里的界面露键名）
  const zhKeys = Object.keys(STRINGS.zh).filter((k) => k.startsWith('pullui.'))
  const enKeys = Object.keys(STRINGS.en).filter((k) => k.startsWith('pullui.'))
  assert.deepEqual(enKeys.sort(), zhKeys.sort(), '中英文的 pullui.* 必须一一对应')
})

// ── ⑤ 2026-10 用户反馈的三件事（返回、目录文案、原生对话框）──────────

test('「返回」在面板**最上面**（用户：点进来之后没法退回上一个页面）', { timeout: 60000 }, async () => {
  const html = await readFile(path.join(ROOT, 'web', 'station.html'), 'utf8')
  const edit = html.slice(html.indexOf('id="pullEdit"'), html.indexOf('id="pullConfirm"'))
  const confirm = html.slice(html.indexOf('id="pullConfirm"'), html.indexOf('id="pullLive"'))
  // 两个子视图都要有返回，而且都在自己那块的**开头**（第一个按钮）
  for (const [name, block] of [['填链接那屏', edit], ['核对指纹那屏', confirm]]) {
    const back = block.indexOf('data-i18n="pullui.back"')
    const firstInput = block.search(/<input|id="pullFp"/)
    assert.ok(back > 0, `${name}必须有一个「返回」按钮`)
    assert.ok(firstInput < 0 || back < firstInput, `${name}的「返回」要排在输入框/指纹**前面**（否则窗口矮一点就看不见）`)
  }
})

test('「选择文件夹」走系统对话框；退回自带选择器时文案也必须对（不是"就发这些"）', { timeout: 60000 }, async () => {
  const html = await readFile(path.join(ROOT, 'web', 'station.html'), 'utf8')

  // ① 先试原生：两个入口都调 pickSaveDir（顺序：先系统对话框，再自带选择器）
  assert.match(html, /async function pickSaveDir\(/, '要有 pickSaveDir()')
  assert.match(html, /await api\('pickdir'/, '要真的去请求原生对话框')
  assert.match(html, /openSaveDirPicker\(/, '拿不到原生对话框时要退回自带选择器')

  // ② 自带选择器有独立的"选保存目录"模式：单选、文案用各自的（pullui / recvui）
  assert.match(html, /browseMode = 'saveDir'/, "要有 'saveDir' 模式")
  assert.match(html, /input: 'pullDir', titleKey: 'pullui\.dirPickTitle', okKey: 'pullui\.dirPickOk'/)
  assert.match(html, /input: 'recvDir', titleKey: 'recvui\.dirPickTitle', okKey: 'recvui\.dirPickOk'/)
  assert.match(html, /t\(browseSave\.okKey\)/, '按钮文案要来自当前模式的 key')

  // ③ 单选：saveDir 下选一个要把别的勾去掉
  assert.match(html, /if \(on && browseSave\)[\s\S]{0,200}browseSel\.clear\(\)/, '选保存目录时必须是单选')

  // ④ 新建文件夹（用户点名要的）
  assert.match(html, /id="browseNew"[^>]*data-i18n="send\.browse\.newDir"/)
  assert.match(html, /await api\('mkdir'/, '新建文件夹要真去建')
  assert.match(html, /send\.browse\.hintSave/, '退回选择器时要有专门的提示文案（不能借用"选要发的东西"那句）')

  // ⑤ 旧写法必须真的没了（那个布尔就是文案串味的根源）
  assert.ok(!/browseForRecvDir/.test(html.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')),
    '`browseForRecvDir` 这种"一个布尔打天下"的写法要删干净')
})

test('接口：原生对话框被关掉时明说 disabled（自动化里绝不弹窗）', { timeout: 90000 }, async () => {
  const { api } = await bootGui()
  const r = await api('pickdir', { title: '存到哪', startDir: '' })
  assert.equal(r.json?.ok, false)
  assert.equal(r.json.reason, 'disabled', '`FLICKER_NO_NATIVE_PICK=1` 下应当报 disabled，让页面退回自带选择器')
})

test('接口：新建文件夹真的建得出来；名字里带分隔符/越权一律拒绝', { timeout: 90000 }, async () => {
  const work = await tempDir('pull-gui-mkdir')
  const { api } = await bootGui()

  const ok = await api('mkdir', { parent: work, name: '新建文件夹' })
  assert.equal(ok.json?.ok, true, `应当建成：${ok.text}`)
  await readdir(work).then((n) => assert.deepEqual(n, ['新建文件夹']))

  // 再建一次：算是成功（文件夹本来就在），但要说清是"已存在"
  const again = await api('mkdir', { parent: work, name: '新建文件夹' })
  assert.equal(again.json?.ok, true)
  assert.equal(again.json.existed, true)

  for (const bad of ['../escape', 'a/b', 'a\b', '.', '..', '']) {
    const r = await api('mkdir', { parent: work, name: bad })
    assert.equal(r.json?.ok, false, `「${bad}」应当被拒绝`)
  }
  // 父目录必须是绝对路径（否则就成了"相对当前工作目录"的写盘入口）
  const rel = await api('mkdir', { parent: 'relative/dir', name: 'x' })
  assert.equal(rel.json?.ok, false)
  const outside = await readdir(path.join(work, '..'))
  assert.ok(!outside.includes('escape'), '越权那一笔不能真的建出来')
})
