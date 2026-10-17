/**
 * 接收模式的**命令行**验收（M1）
 * ==================================
 * 与 `test/upload-server.test.js` 的分工是刻意的：
 *
 *   · `upload-server.test.js`：进程内、明文 HTTP、注入依赖 —— 验**协议与落盘**
 *     （改一个字节要被拒、路径不安全要中止、空间不足要 507、重名三选一……）
 *   · 本文件：起一个**真的 `flicker recv` 子进程** —— 验**整条命令行**
 *     （证书生成 → TLS 监听 → 打印链接 → 收 → 校验 → 落盘 → 销毁 → 退出码）
 *
 * 手机那一侧不在这里重写一遍，而是直接跑 `_lab/sim-phone.mjs` ——
 * 它是开发者也会用的那个工具（`node _lab/recv-selftest.mjs` 是同一件事的手动版）。
 * 这样"测试里能过"和"命令行上能过"说的是同一件事。
 *
 * ⚠️ 用的是 `--machine --machine-cert=<文件>`：导出本次会话的 CA，
 *    测试只信任这一张（不用"忽略证书错误"），和 test/e2e.test.js 同一套做法。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI = path.join(ROOT, 'bin', 'flicker.js')
const SIM = path.join(ROOT, '_lab', 'sim-phone.mjs')
const PASSWORD = 'k7m-3fq'
const START_TIMEOUT_MS = 60_000

const cleanups = []
test.after(async () => {
  for (const fn of cleanups.reverse()) {
    try { await fn() } catch (e) { console.error('清理失败：' + (e?.message ?? e)) }
  }
})

/** 起一个接收端（真的子进程），等它打印 `__READY__` */
function startRecv({ dir, extra = [] }) {
  const caFile = path.join(dir, 'ca.cer')
  const child = spawn(process.execPath, [
    CLI, 'recv', `--dir=${path.join(dir, 'inbox')}`, `--password=${PASSWORD}`,
    '--machine', `--machine-cert=${caFile}`, '--no-ask', '--no-open', ...extra,
  ], {
    // `FLICKER_NO_OPEN=1` 是第二道保险：即使哪天忘了传 --no-open，
    // 也不会有人在测试跑到一半时被弹一个资源管理器窗口（那个窗口随后会变成
    // "位置不可用"的系统错误框 —— 2026-10 用户实测被弹到过）。
    env: { ...process.env, FLICKER_NO_OPEN: '1' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let out = '', errOut = ''
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)))
  cleanups.push(async () => { try { child.kill() } catch { /* 已经退了 */ } })
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(
      `等 __READY__ 超时\nstdout:\n${out}\nstderr:\n${errOut}`)), START_TIMEOUT_MS)
    const scan = (b, isErr) => {
      const s = b.toString()
      if (isErr) errOut += s; else out += s
      // 机器可读契约（与发送模式同一条）：单独一行、唯一标记
      const m = out.match(/__READY__ (\S+) (\S+)/)
      if (m) { clearTimeout(timer); resolve({ base: m[1], token: m[2] }) }
    }
    child.stdout.on('data', (b) => scan(b, false))
    child.stderr.on('data', (b) => scan(b, true))
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`接收端提前退出 (code ${code})\nstdout:\n${out}\nstderr:\n${errOut}`))
    })
  })
  return { child, ready, exited, caFile, getOut: () => out, getErr: () => errOut }
}

/** 跑"手机"：直接执行开发者也会用的那个脚本 */
function runSim({ readyFile, srcDir, caFile, extra = [] }) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [
      SIM, `--from-ready=${readyFile}`, `--dir=${srcDir}`, `--password=${PASSWORD}`,
      `--ca=${caFile}`, ...extra,
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = '', errOut = ''
    c.stdout.on('data', (b) => { out += b })
    c.stderr.on('data', (b) => { errOut += b })
    c.on('exit', (code) => resolve({ code, out, err: errOut }))
  })
}

/** 带 CA 校验的 HTTPS 请求（fetch 不接受自定义 CA，所以用 node:https） */
function httpsGet(url, caFile) {
  const ca = readFileSync(caFile, 'utf8')
  const u = new URL(url)
  return new Promise((resolve, reject) => {
    const r = httpsRequest({ method: 'GET', host: u.hostname, port: u.port, path: u.pathname + u.search, ca },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({
          status: res.statusCode,
          type: res.headers['content-type'],
          text: Buffer.concat(chunks).toString('utf8'),
        }))
      })
    r.on('error', reject)
    r.end()
  })
}

async function workdir(tag) {
  const dir = await mkdtemp(path.join(tmpdir(), `flicker-${tag}-`))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  await mkdir(path.join(dir, 'inbox'), { recursive: true })
  await mkdir(path.join(dir, 'phone'), { recursive: true })
  return dir
}

const sha = (b) => createHash('sha256').update(b).digest('hex')

// ── ① 完整一轮：TLS + 三个文件 + 销毁清单 + 退出码 ───────────

test('flicker recv：真命令行走完一轮（HTTPS + 三个文件逐字节一致 + 退出码 0）', async () => {
  const dir = await workdir('recv-cli')
  const src = path.join(dir, 'phone')
  const files = {
    'note.txt': Buffer.from('手机发来的第一条\n', 'utf8'),
    'full-chunk.bin': randomBytes(2 * 1024 * 1024),
    '跨块的照片.bin': randomBytes(2 * 1024 * 1024 + 4321),
  }
  for (const [name, buf] of Object.entries(files)) await writeFile(path.join(src, name), buf)

  const recv = startRecv({ dir })
  const { base, token } = await recv.ready

  // 链接必须是 HTTPS：明文 HTTP 在手机上不是"安全上下文"，
  // 浏览器会直接不给 crypto.subtle —— 那意味着页面连密码都算不出来。
  assert.match(base, /^https:\/\//, '接收模式必须走 HTTPS')
  assert.ok(token, '机器可读行里必须带一次性令牌')

  // 页面：必须是**手机上传页**（web/phone.html），且**逐字节相同** ——
  // 这条盯的是"资源接线断了"：构建脚本漏了内联、assets.js 忘了登记、
  // 或者单文件产物里嵌的还是旧页面，都会在这里被抓住。
  // 只断言"返回了 HTML"是不够的：占位页也是 HTML。
  const page = await httpsGet(`${base}/?k=${token}`, recv.caFile)
  assert.equal(page.status, 200, 'GET / 应当返回页面')
  assert.match(String(page.type), /text\/html/, '页面必须是 HTML')
  const want = await readFile(path.join(ROOT, 'web', 'phone.html'), 'utf8')
  assert.equal(sha(Buffer.from(page.text, 'utf8')), sha(Buffer.from(want, 'utf8')),
    '送出的手机页面必须与 web/phone.html 逐字节相同（内联段跑过了吗？）')
  assert.match(page.text, /FlickerPhone/, '页面里应当有协议内核（构建期内联）')

  const readyFile = path.join(dir, 'ready.txt')
  await writeFile(readyFile, `__READY__ ${base} ${token}\n`, 'utf8')
  const sim = await runSim({ readyFile, srcDir: src, caFile: recv.caFile })
  assert.equal(sim.code, 0, `手机侧应当全部成功：\n${sim.out}\n${sim.err}`)

  const code = await recv.exited
  const out = recv.getOut()
  assert.equal(code, 0, `接收端应当以 0 退出（实际 ${code}）：\n${out}\n${recv.getErr()}`)

  // 落盘：逐字节一致，且不留半成品
  for (const [name, buf] of Object.entries(files)) {
    const got = await readFile(path.join(dir, 'inbox', name))
    assert.equal(sha(got), sha(buf), `${name} 应当逐字节一致`)
  }
  const names = await readdir(path.join(dir, 'inbox'))
  assert.deepEqual(names.filter((n) => n.endsWith('.flicker-part')), [],
    '成功定稿之后不该留下半成品')

  // 销毁清单：该说的都要说到
  assert.match(out, /会话密钥与密码验证值已清零/)
  assert.match(out, /接收服务已关闭/)
  assert.match(out, /一次性链接已失效/)
  assert.match(out, /收到的文件已保留在/, '接收模式的销毁清单必须写明"收到的文件在哪"')
  assert.doesNotMatch(out, /原始文件未被改动/,
    '那是发送端的承诺，接收端写出的是用户的文件，不能照抄')
})

// ── ② 反向验证：改坏一个字节必须被拒 ─────────────────────────

test('⭐ 反向验证：手机把一块密文改一个字节 → 接收端当场拒绝，且不留半成品', async () => {
  const dir = await workdir('recv-corrupt')
  const src = path.join(dir, 'phone')
  await writeFile(path.join(src, 'x.bin'), randomBytes(3000))

  // 反正是要被拒的（没人收尾），超时压到几秒，别让测试等满 10 分钟
  const recv = startRecv({ dir, extra: ['--timeout=6s'] })
  const { base, token } = await recv.ready
  const readyFile = path.join(dir, 'ready.txt')
  await writeFile(readyFile, `__READY__ ${base} ${token}\n`, 'utf8')

  const sim = await runSim({ readyFile, srcDir: src, caFile: recv.caFile, extra: ['--corrupt'] })
  assert.equal(sim.code, 0, `sim-phone 应当报告"被正确拒绝"：\n${sim.out}\n${sim.err}`)
  assert.match(sim.out, /正确拒绝/, '反向验证必须看到"正确拒绝"这四个字')

  const code = await recv.exited
  assert.equal(code, 6, `没人收尾 → 按超时退出（EXIT.TIMEOUT＝6，实际 ${code}）`)
  const inbox = await readdir(path.join(dir, 'inbox'))
  assert.deepEqual(inbox, [], '整块被拒 + 没人收尾 → 磁盘上不该出现正式文件')
})

// ── ④ 用法错误：`--listen` 与链接不能同时给 ──────────────────

test('--listen 与链接同时给 → 用法错误（不静默挑一个执行）', async () => {
  // 这两种用法是**相反**的（一个起服务、一个打开别人的链接）。同时给的时候
  // 随便挑一个执行都会让用户以为另一个生效了 —— 所以直接报用法错误。
  const run = await new Promise((resolve) => {
    const c = spawn(process.execPath, [
      CLI, 'recv', '--listen', 'https://192.168.1.5:8443/?k=abc',
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = '', errOut = ''
    c.stdout.on('data', (b) => { out += b })
    c.stderr.on('data', (b) => { errOut += b })
    c.on('exit', (code) => resolve({ code, out, err: errOut }))
  })
  assert.equal(run.code, 2, `用法错误应当是退出码 2（实际 ${run.code}）`)
  assert.match(run.err, /不能同时给/, '要说清这两个用法是冲突的，而不是随便挑一个执行')
  assert.equal(run.out.trim(), '', '用法错误时不该有任何正常输出（更不能顺手打开浏览器）')
})

// ── ③ 重名：不问的时候一律自动改名（--no-ask / --machine）─────

test('接收模式遇到同名文件：不问的时候自动改名，旧文件原封不动', async () => {
  const dir = await workdir('recv-rename')
  const src = path.join(dir, 'phone')
  await writeFile(path.join(dir, 'inbox', 'a.txt'), '电脑上原来就有的', 'utf8')
  const sent = Buffer.from('手机发来的新内容')
  await writeFile(path.join(src, 'a.txt'), sent)

  const recv = startRecv({ dir })                    // startRecv 已经带了 --no-ask
  const { base, token } = await recv.ready
  const readyFile = path.join(dir, 'ready.txt')
  await writeFile(readyFile, `__READY__ ${base} ${token}\n`, 'utf8')
  const sim = await runSim({ readyFile, srcDir: src, caFile: recv.caFile })
  assert.equal(sim.code, 0, `手机侧应当成功：\n${sim.out}\n${sim.err}`)
  assert.equal(await recv.exited, 0)

  assert.equal(await readFile(path.join(dir, 'inbox', 'a.txt'), 'utf8'), '电脑上原来就有的',
    '旧文件必须原封不动')
  const got = await readFile(path.join(dir, 'inbox', 'a (1).txt'))
  assert.equal(got.toString('utf8'), sent.toString('utf8'),
    '新文件应当落在 a (1).txt（序号在扩展名之前，与发送端同一套去重规则）')
})
