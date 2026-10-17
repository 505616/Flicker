/**
 * 图形界面里的「接收文件」（手机 → 这台电脑）
 * ============================================
 * 这一条验的是"用户真的会用鼠标走的那条路"：
 *
 *   `POST /api/recv/start` → 界面拿到链接/二维码/一次性密码 →（手机那侧推文件）
 *   → `/api/state` 里能看到进度与结果 → `POST /api/recv/stop` 真的销毁
 *
 * ⚠️ 与 `test/recv-cli.test.js` 的分工：那边验的是命令行那一整条（含**用导出的 CA
 *    做真实 TLS 验证**）。这边验的是界面接线（状态、按钮、销毁链），
 *    所以手机那一侧直接跑 `_lab/sim-phone.mjs`（开发者也会用的同一个工具），
 *    连它时用 `rejectUnauthorized:false` —— 证书本身的有效性在命令行那条用例里验过。
 *
 * ⚠️ 图形界面**一次只起一个**：它启动时会清理同名残留证书，
 *    两个实例同时跑会互删（gui.test.js 里记着这条，真机上同样成立）。
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CLI = path.join(ROOT, 'bin', 'flicker.js')
const SIM = path.join(ROOT, '_lab', 'sim-phone.mjs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const cleanups = []
test.after(async () => {
  for (const fn of cleanups.reverse()) {
    try { await fn() } catch (e) { console.error('清理失败：' + (e?.message ?? e)) }
  }
})

const liveGuis = []
afterEach(async () => {
  for (const child of liveGuis.splice(0)) {
    try { child.kill() } catch { /* 已退出 */ }
  }
  await sleep(150)
})

function startGui(extraArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, '--gui', ...extraArgs], {
      // ⚠️ `--no-open` 与 `FLICKER_NO_OPEN=1` 都是**必须的**：
      //    接收模式传完会弹资源管理器，而测试的临时目录随后就被删掉 ——
      //    那个窗口会变成一张"位置不可用"的系统错误框，弹在**用户**桌面上
      //    （2026-10 用户实测被弹到，截图发过来的就是它）。
      env: { ...process.env, FLICKER_NO_BROWSER: '1', FLICKER_NO_OPEN: '1' },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    liveGuis.push(child)
    cleanups.push(async () => { try { child.kill() } catch { /* 已退出 */ } })
    let out = '', err = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已退出 */ }
      reject(new Error(`GUI 启动超时\n${out}\n${err}`))
    }, 20000)
    const onData = (b, isErr) => {
      const s = b.toString()
      if (isErr) err += s; else out += s
      const m = out.match(/(http:\/\/127\.0\.0\.1:\d+\/)/)
      if (m) { clearTimeout(timer); resolve({ child, base: m[1], getOut: () => out, getErr: () => err }) }
    }
    child.stdout.on('data', (b) => onData(b, false))
    child.stderr.on('data', (b) => onData(b, true))
    child.on('exit', (c) => { clearTimeout(timer); if (c) reject(new Error(`GUI 退出 (${c})\n${out}\n${err}`)) })
  })
}

async function bootGui(extraArgs) {
  const gui = await startGui(extraArgs)
  /**
   * 调接口。
   * ⚠️ `body === undefined` 就是 **GET**（为了区分查询与命令）。
   *    所以"没有参数的命令"也必须显式传 `{}` —— 第一版漏了这一点，
   *    `api('recv/stop')` 发成了 GET，服务端回 404（那条路由只接受 POST），
   *    于是"停止"看起来没生效。**测试自己发错了请求**，不是产品的问题。
   */
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

/** 等 /api/state 里的接收状态满足条件（界面就是靠轮询看到它的） */
async function waitRecv(api, pred, { ms = 20000, what = '接收状态' } = {}) {
  const t0 = Date.now()
  let last = null
  while (Date.now() - t0 < ms) {
    const r = await api('state')
    last = r.json?.recv ?? null
    if (pred(last)) return last
    await sleep(150)
  }
  throw new Error(`等「${what}」超时，最后一次状态：${JSON.stringify(last)}`)
}

/** 跑"手机"：直接执行开发者也会用的那个脚本（与 recv-cli 用例同一个工具） */
function runSim({ url, password, srcDir, extra = [] }) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [
      SIM, `--url=${url}`, `--password=${password}`, `--dir=${srcDir}`, ...extra,
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = '', err = ''
    c.stdout.on('data', (b) => { out += b })
    c.stderr.on('data', (b) => { err += b })
    c.on('exit', (code) => resolve({ code, out, err }))
  })
}

async function workdir(tag) {
  const dir = await mkdtemp(path.join(tmpdir(), `flicker-${tag}-`))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const inbox = path.join(dir, 'inbox')
  const phone = path.join(dir, 'phone')
  await mkdir(inbox, { recursive: true })
  await mkdir(phone, { recursive: true })
  return { dir, inbox, phone }
}

const sha = (b) => createHash('sha256').update(b).digest('hex')

test('图形界面：站点页里有「接收文件」入口，且接口能起一个接收服务', { timeout: 90000 }, async () => {
  const { dir, inbox } = await workdir('gui-recv-start')
  const { gui, api } = await bootGui()

  // 页面里要有那个入口（否则接口再全，用户也点不到）
  const html = await (await fetch(gui.base)).text()
  assert.match(html, /id="recvEntry"/, '站点页缺少「接收文件」入口')
  assert.match(html, /data-i18n="recvui\.enter"/, '入口文案要走 i18n（中英双语）')
  assert.match(html, /id="v-recv"/, '缺少接收模式那一屏')

  // 没开始时状态是 null（页面据此显示"开始接收"那张卡片）
  assert.equal((await api('state')).json.recv, null)

  const r = await api('recv/start', { dir: inbox })
  assert.equal(r.status, 200, `启动失败：${r.text}`)
  assert.equal(r.json.ok, true)

  const recv = await waitRecv(api, (s) => s && (s.phase === 'waiting' || s.phase === 'transfer'), { what: '等待手机' })
  assert.equal(recv.phase, 'waiting')
  assert.match(recv.url, /^https:\/\/\d+\.\d+\.\d+\.\d+:\d+\/\?k=/, '链接必须是局域网 IP 的 HTTPS（手机上明文 HTTP 不是安全上下文）')
  assert.match(recv.password, /^[a-z0-9]{3}-[a-z0-9]{3}$/, '一次性密码应当是 6 位短码')
  assert.equal(recv.dir, inbox)
  assert.ok(recv.port > 0)

  // 停止 → 销毁链真的跑完（清单里每一条都在）
  const stop = await api('recv/stop', {})
  assert.equal(stop.status, 200)
  const ended = await waitRecv(api, (s) => s && s.phase === 'stopped', { what: '停止' })
  assert.ok(ended.report, '停止之后应当有销毁清单')
  assert.ok(ended.report.done.some((d) => d.includes('会话密钥与密码验证值已清零')), '销毁清单里要有密钥清零')
  assert.ok(ended.report.done.some((d) => d.includes('接收服务已关闭')), '销毁清单里要有服务关闭')
  assert.ok(ended.report.done.some((d) => d.includes('收到的文件已保留在')), '要写明收到的文件在哪')
})

test('⭐ 图形界面 + 真手机路径：模拟手机把文件推进来，电脑上逐字节一致', { timeout: 120000 }, async () => {
  const { inbox, phone } = await workdir('gui-recv-full')
  const files = {
    'note.txt': Buffer.from('来自手机的问候\n', 'utf8'),
    '跨块.bin': Buffer.from(Array.from({ length: 2 * 1024 * 1024 + 999 }, (_, i) => (i * 31 + 7) & 0xff)),
  }
  for (const [name, buf] of Object.entries(files)) await writeFile(path.join(phone, name), buf)

  const { gui, api } = await bootGui(['--no-ask'])   // --no-ask：重名不打扰（这条用例不测询问）
  const start = await api('recv/start', { dir: inbox })
  assert.equal(start.status, 200, start.text)
  const recv = await waitRecv(api, (s) => s && s.phase === 'waiting', { what: '等待手机' })

  // "手机"连上来推文件
  const sim = await runSim({ url: recv.url, password: recv.password, srcDir: phone })
  assert.equal(sim.code, 0, `手机侧应当成功：\n${sim.out}\n${sim.err}`)

  // 界面状态：传完 → done（并且带销毁清单与文件数）
  const done = await waitRecv(api, (s) => s && (s.phase === 'done' || s.phase === 'error'), { what: '接收完成' })
  assert.equal(done.phase, 'done', `接收应当完成：${JSON.stringify(done.error)}`)
  assert.equal(done.filesDone, Object.keys(files).length, '完成数应当与文件数一致')
  assert.ok(done.report?.done?.length, '应当有销毁清单')

  // 落盘：逐字节一致，且不留半成品
  for (const [name, buf] of Object.entries(files)) {
    const got = await readFile(path.join(inbox, name))
    assert.equal(sha(got), sha(buf), `${name} 应当逐字节一致`)
  }
  assert.deepEqual((await readdir(inbox)).filter((n) => n.endsWith('.flicker-part')), [],
    '不该留下半成品')
})

test('图形界面：重名时把问题摆到界面上，按用户的选择处理', { timeout: 120000 }, async () => {
  const { inbox, phone } = await workdir('gui-recv-ask')
  await writeFile(path.join(inbox, 'a.txt'), '电脑上原来就有的', 'utf8')
  await writeFile(path.join(phone, 'a.txt'), '手机发来的新内容', 'utf8')

  const { api } = await bootGui()                  // 不问 --no-ask = 界面上问
  const start = await api('recv/start', { dir: inbox })
  assert.equal(start.status, 200, start.text)
  const recv = await waitRecv(api, (s) => s && s.phase === 'waiting', { what: '等待手机' })

  const simP = runSim({ url: recv.url, password: recv.password, srcDir: phone })
  // 手机发清单时会撞上同名文件 → 界面出现三选一
  const pending = await waitRecv(api, (s) => s && s.pending, { what: '重名询问' })
  assert.equal(pending.pending.rel, 'a.txt')
  assert.ok(pending.pending.suggested, '要给出改名建议（例如 a (1).txt）')

  const answer = await api('recv/collision', { choice: 'skip' })
  assert.equal(answer.status, 200)
  assert.equal(answer.json.choice, 'skip')

  const sim = await simP
  assert.equal(sim.code, 0, `手机侧应当成功：\n${sim.out}\n${sim.err}`)
  const done = await waitRecv(api, (s) => s && (s.phase === 'done' || s.phase === 'error'), { what: '接收完成' })
  assert.equal(done.phase, 'done', JSON.stringify(done.error))

  assert.equal(await readFile(path.join(inbox, 'a.txt'), 'utf8'), '电脑上原来就有的',
    '选了「跳过」时旧文件必须原封不动')
  const names = await readdir(inbox)
  assert.deepEqual(names.filter((n) => n !== 'a.txt'), [], '跳过时不该写出任何新文件')
})

test('⭐ 自动化场景**绝不弹资源管理器**：先判自动化、目录不在也不 spawn', { timeout: 90000 },
  async () => {
  // 这条是用户在测试跑到一半时被弹窗逼出来的：
  //   接收模式传完会自动打开保存目录 → 测试的临时目录随后被删 → Windows 弹
  //   "位置不可用 / 该位置可能已移动或删除"。那个框弹在**用户**桌面上。
  //   所以两件事都要成立：① 自动化时压根不碰目录；② 目录不在时也不 spawn。
  const { dir, inbox } = await workdir('gui-recv-noopen')
  const { gui, api } = await bootGui()

  // ① 起一个接收会话，把"保存目录"固定成这个临时目录（不依赖 ~/Downloads 是否存在 ——
  //    CI 的 Linux 上它不存在，2026-10 那条第一次跑就因此红了）
  const started = await api('recv/start', { dir: inbox })
  assert.equal(started.status, 200, `起接收服务失败：${started.text}`)

  // ② 自动化场景（FLICKER_NO_OPEN=1）→ 不弹，且原因必须**说清是自动化跳过**
  const blocked = await api('recv/open', {})
  assert.equal(blocked.status, 200)
  assert.equal(blocked.json.ok, false, '自动化场景不该真的去打开文件夹')
  assert.match(String(blocked.json.error), /FLICKER_NO_OPEN/,
    '要说清是自动化场景跳过，而不是"打不开"')

  // ③ 目录被删掉之后（真机上就是"用户手工删了保存目录"）→ 仍然不弹
  await rm(inbox, { recursive: true, force: true })
  const gone = await api('recv/open', {})
  assert.equal(gone.json.ok, false, '目录都没了，绝不能去 spawn explorer')

  // ④ 整个运行过程中日志里不能出现"已打开保存文件夹"（那是真的 spawn 了才会打的字）
  const out = gui.getOut()
  assert.ok(!out.includes('已打开保存文件夹'), `不该打开文件夹，但日志里出现了：
${out.slice(-500)}`)
  assert.ok(dir, '（占位：保持临时目录的清理登记）')
})

test('`openFolder`：自动化判定排在"目录在不在"前面；目录不在时不 spawn', async () => {
  // ⚠️ 这两条顺序约束在集成测试里验不全（GUI 子进程的环境是固定的），所以直接单测它。
  //    第二条尤其重要：目录不存在时**先返回原因**，而不是让 explorer/xdg-open 去弹系统错误框。
  const { openFolder } = await import('../src/gui.js')
  const tmp = await mkdtemp(path.join(tmpdir(), 'flicker-openfolder-'))
  cleanups.push(() => rm(tmp, { recursive: true, force: true }))
  const readEnv = process.env.FLICKER_NO_OPEN
  try {
    // 自动化：即使目录不存在，原因也必须是"自动化场景"，而不是"不在了"
    process.env.FLICKER_NO_OPEN = '1'
    const auto = openFolder(path.join(tmp, 'does-not-exist'))
    assert.equal(auto.ok, false)
    assert.match(auto.error, /FLICKER_NO_OPEN/, '自动化判定要排在存在性检查前面')

    // 非自动化 + 目录不存在：返回"不在了"，且**绝不 spawn**（spawn 会弹窗）
    delete process.env.FLICKER_NO_OPEN
    const gone = openFolder(path.join(tmp, 'does-not-exist'))
    assert.equal(gone.ok, false)
    assert.match(gone.error, /不在了/)
  } finally {
    if (readEnv === undefined) delete process.env.FLICKER_NO_OPEN
    else process.env.FLICKER_NO_OPEN = readEnv
  }
})

test('图形界面：一次接收结束后可以「再来一次」（会话是一次性的）', { timeout: 90000 }, async () => {
  const { inbox } = await workdir('gui-recv-again')
  const { api } = await bootGui()
  await api('recv/start', { dir: inbox })
  const first = await waitRecv(api, (s) => s && s.phase === 'waiting', { what: '第一次启动' })
  await api('recv/stop', {})
  await waitRecv(api, (s) => s && s.phase === 'stopped', { what: '停止' })

  const again = await api('recv/again', {})
  assert.equal(again.status, 200)
  assert.equal((await api('state')).json.recv, null, '「再来一次」应当回到未开始的状态')

  const second = await api('recv/start', { dir: inbox })
  assert.equal(second.status, 200, second.text)
  const s2 = await waitRecv(api, (s) => s && s.phase === 'waiting', { what: '第二次启动' })
  assert.notEqual(s2.url, first.url, '新会话必须是新链接（一次性令牌不复用）')
  assert.notEqual(s2.password, first.password, '新会话要有新的一次性密码')
  await api('recv/stop', {})
})
