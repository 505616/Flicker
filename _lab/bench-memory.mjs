/**
 * 大文件内存实测
 * ==============
 *
 * 要回答的问题（路线图第 12 项 / 第 9 项的后半）：
 *   **发一个很大的文件时，发送端的内存会不会随文件大小一起涨？**
 *
 * 判据很硬，不靠读代码：
 *   跑**两个差 8 倍**的文件，比较发送端进程的**峰值物理内存**。
 *   · 真正的流式实现 → 峰值几乎不随文件大小变化（一个 1 MiB 的缓冲 + 常量开销）
 *   · "整体读进内存" → 峰值会随文件大小线性增长
 *   所以结论写成"512 MiB 的峰值 / 64 MiB 的峰值"，这个比值自己会说话。
 *
 * 峰值怎么取（不需要持续采样）：
 *   Windows  PeakWorkingSet64 —— 操作系统维护的**高水位**，跑完再读也是历史最大值
 *   Linux    /proc/<pid>/status 的 VmHWM —— 同样是高水位
 *   macOS    没有高水位可读，只能轮询 ps，所以记的是"采样到的最大值"（会偏低）
 *
 * 用法：
 *   node _lab/bench-memory.mjs              # 默认 64 与 512 MiB
 *   node _lab/bench-memory.mjs 32 256       # 自定义两组（MiB）
 *   node _lab/bench-memory.mjs --keep       # 保留临时文件（排查用）
 */

import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, open, rm, readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { request as httpsRequest } from 'node:https'
// ⚠️ 密码学一律用**生产代码**，绝不在这里重写一份。
//    第一版我手抄了密钥派生，结果 HKDF 的 salt 与 label 参数与产品不一致，
//    服务端直接回 BAD_PASSWORD —— 而报错完全指向"密码不对"，
//    看不出真正的原因是我抄错了协议。抄一份就等于埋一个假故障。
import { deriveVerifier, deriveKeys, receiverMac, openChunk, openManifest } from '../src/suite/flicker1.js'
import { unpackMessage, MSG } from '../src/relay/protocol.js'

const pexec = promisify(execFile)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI = path.join(ROOT, 'bin', 'flicker.js')

const args = process.argv.slice(2)
const KEEP = args.includes('--keep')
/** 走中继（跨网络那条路）而不是局域网直连 */
const VIA_RELAY = args.includes('--relay')
const sizesMiB = args.filter((a) => /^\d+$/.test(a)).map(Number)
// ⚠️ 基准行（1 MiB）是**必须**的，不是凑数：
//    Node 自己就有几十 MiB 的常驻内存。没有基准，就分不清"峰值 117 MiB"
//    里哪部分是解释器自己的、哪部分是文件带来的 —— 那样得出的结论
//    （"内存不随文件增长"）只是看起来成立，实际上没被验证。
const SIZES = [...new Set([1, ...(sizesMiB.length ? sizesMiB : [64, 512])])]

const PASSWORD = 'bench-memory-password'
const MiB = 1024 * 1024

const b64dec = (s) => Buffer.from(s, 'base64')

// ── 客户端：只信任发送端导出的那张 CA ───────────────────────

function makeClient(caFile) {
  // ⚠️ 必须用 readFileSync 读成**字符串**。写成异步 readFile 会得到一个 Promise，
  //    而 Node 的 ca 选项要的是 PEM 文本 —— 报错是
  //    "options.ca must be of type string or an instance of Buffer"，
  //    指向的是 ca，看不出真正的原因是"少了个 Sync"。
  const ca = readFileSync(caFile, 'utf8')
  return function req(method, url, init = {}) {
    const { headers = {}, body } = init
    const u = new URL(url)
    return new Promise((resolve, reject) => {
      const r = httpsRequest({
        method, host: u.hostname, port: u.port || 443,
        path: u.pathname + u.search, ca, headers,
      }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const buf = Buffer.concat(chunks)
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode, headers: res.headers,
            text: async () => buf.toString('utf8'),
            json: async () => JSON.parse(buf.toString('utf8')),
            arrayBuffer: async () => buf,
          })
        })
      })
      r.on('error', reject)
      if (body !== undefined) r.write(body)
      r.end()
    })
  }
}

// ── 峰值内存读取 ────────────────────────────────────────────

/**
 * 持续采样子进程的峰值物理内存。
 *
 * ⚠️ **必须边跑边采**，不能等跑完再读一次。
 *    中继模式下发送端一发现"全部 ack 完"就立刻走销毁流程并退出，
 *    等我们回头读 `Get-Process -Id` 时进程已经没了 —— 采到 null，
 *    表格里那一栏显示"—"。局域网模式因为要等 timeout 才退出，碰巧没暴露。
 *    "只在某一种模式下坏"的测量脚本最危险：数据看着正常，其实是空的。
 *
 * 三个平台各有各的办法：
 *   Windows  PeakWorkingSet64 是高水位，采到一次就是"到目前为止的最大值"
 *   Linux    /proc/<pid>/status 的 VmHWM 同样是高水位
 *   macOS    没有高水位，只能看当前 RSS，所以结果**偏低**（报告里注明）
 *
 * @returns {{stop:()=>void, peak:()=>number|null, samples:number}}
 */
function startSampler(pid) {
  const samples = []
  let child = null

  if (process.platform === 'win32') {
    // 常驻一个 PowerShell 循环，而不是每 400ms 起一个新进程 ——
    // 后者每次有 100~200ms 启动开销，采样间隔会被拖得不可控；
    // 更要紧的是，进程退出后那些零散的读就全落空了。
    const script = `while ($true) {
      $p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
      if (-not $p) { break }
      $p.PeakWorkingSet64
      Start-Sleep -Milliseconds 400
    }`
    child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    let acc = ''
    child.stdout.on('data', (b) => {
      acc += b.toString()
      const lines = acc.split(/\r?\n/)
      acc = lines.pop() ?? ''
      for (const l of lines) {
        const n = Number(l.trim())
        if (Number.isFinite(n) && n > 0) samples.push(n)
      }
    })
    child.on('error', () => { /* 采不到就显示 —，不编数 */ })
  } else {
    const tick = async () => {
      if (process.platform === 'linux') {
        try {
          const s = await readFile(`/proc/${pid}/status`, 'utf8')
          const m = s.match(/VmHWM:\s+(\d+)\s+kB/)
          if (m) samples.push(Number(m[1]) * 1024)
        } catch { /* 进程已退出 */ }
      } else {
        try {
          const { stdout } = await pexec('ps', ['-o', 'rss=', '-p', String(pid)])
          const kb = Number(stdout.trim())
          if (Number.isFinite(kb) && kb > 0) samples.push(kb * 1024)
        } catch { /* 进程已退出 */ }
      }
    }
    child = setInterval(tick, 300)
    tick()
  }

  return {
    stop: () => {
      if (process.platform === 'win32') { try { child?.kill() } catch { /* 已退出 */ } }
      else clearInterval(child)
    },
    // 高水位是单调递增的，所以取最大值就是最好的估计
    peak: () => (samples.length ? Math.max(...samples) : null),
    // ⚠️ 必须是**函数**而不是 `samples: samples.length`：
    //    后者在 startSampler 返回时就被求值了，永远是 0 ——
    //    于是每一行的"采样次数"都显示 0，看起来像"一次都没采到"，
    //    而峰值明明是有数的。两个字段自相矛盾时，先怀疑统计口径。
    sampleCount: () => samples.length,
  }
}
// ── 造一个大文件（分块写，别把自己撑爆）─────────────────────

async function makeBigFile(dir, name, sizeBytes) {
  const p = path.join(dir, name)
  const fh = await open(p, 'w')
  const block = Buffer.allocUnsafe(4 * MiB)
  let written = 0
  try {
    while (written < sizeBytes) {
      randomBytes(0)                     // 保持与其它用例一致的调用节奏
      for (let i = 0; i < block.length; i += 4096) block.writeUInt32LE((written + i) >>> 0, i)
      const n = Math.min(block.length, sizeBytes - written)
      await fh.write(block, 0, n)
      written += n
    }
  } finally { await fh.close() }
  return p
}

// ── 启动发送端 ──────────────────────────────────────────────

function startSender(target, certFile, extraArgs, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath,
      [CLI, 'send', target, `--password=${PASSWORD}`, `--timeout=${timeoutMs}ms`,
        '--no-qr', '--no-color', ...(VIA_RELAY ? [] : ['--no-cert-install']),
        '--no-gift', '--machine',
        ...(VIA_RELAY ? [] : ['--machine-cert=' + certFile]), ...extraArgs],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = '', errOut = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已退出 */ }
      reject(new Error(`发送端启动超时\n${out}\n${errOut}`))
    }, 60000)
    const onData = (buf, isErr) => {
      const s = buf.toString()
      if (isErr) errOut += s; else out += s
      const m = out.match(/__READY__ (\S+) (\S+)/)
      if (m) {
        clearTimeout(timer)
        resolve({ child, base: m[1], token: m[2], getOut: () => out, getErr: () => errOut })
      }
    }
    child.stdout.on('data', (b) => onData(b, false))
    child.stderr.on('data', (b) => onData(b, true))
    child.on('exit', (c) => {
      clearTimeout(timer)
      if (c) reject(new Error(`发送端提前退出 (code ${c})\n${out}\n${errOut}`))
    })
  })
}

/** 起一个本地中继（与 Cloudflare Worker 同一份协议实现） */
async function startRelay(port) {
  const child = spawn(process.execPath, ['relay/local.mjs', `--port=${port}`],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (b) => { out += b.toString() })
  child.stderr.on('data', (b) => { out += b.toString() })
  await new Promise((r) => setTimeout(r, 1200))
  if (child.exitCode !== null) throw new Error(`中继启动失败:\n${out}`)
  return child
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 扮演接收端，把中继房间里的分块全部取走并 ack。
 * ⚠️ 接收端**不保存**明文（只喂给哈希），否则测出来的就成了本脚本的内存，
 *    而不是发送端的。
 */
async function drainRelay(base, room, onDone) {
  const url = (s = '') => `${base}/r/${room}${s}`
  let raw = null
  for (let i = 0; i < 300 && !raw; i++) {
    const r = await fetch(url('?seq=0'))
    if (r.ok) { raw = Buffer.from(await r.arrayBuffer()); break }
    const j = await r.json().catch(() => ({}))
    if (j.error !== 'NOT_YET') throw new Error(`取清单失败: ${r.status} ${j.error ?? ''}`)
    await sleep(50)
  }
  if (!raw) throw new Error('拿不到清单（NOT_YET 超时）')
  const { type, payload } = unpackMessage(new Uint8Array(raw))
  if (type !== MSG.MANIFEST) throw new Error(`第一条消息类型不对：${type}`)
  const salt = Buffer.from(payload.subarray(0, 16))
  const keys = deriveKeys(deriveVerifier(PASSWORD, salt))
  const wire = JSON.parse(openManifest(keys.enc,
    Buffer.from(payload.subarray(16, 28)),
    Buffer.from(payload.subarray(44)),
    Buffer.from(payload.subarray(28, 44))).toString('utf8'))

  const t0 = Date.now()
  let bytes = 0
  const f = wire.files[0]
  const whole = createHash('sha256')
  for (let ci = 0; ci < f.chunks; ci++) {
    const seq = 1 + ci
    let got = null
    for (let i = 0; i < 600 && !got; i++) {
      const r = await fetch(url(`?seq=${seq}`))
      if (r.ok) { got = Buffer.from(await r.arrayBuffer()); break }
      const j = await r.json().catch(() => ({}))
      if (j.error === 'NOT_YET') { await sleep(20); continue }
      throw new Error(`取 seq=${seq} 失败: ${r.status} ${j.error ?? ''}`)
    }
    if (!got) throw new Error(`seq=${seq} 等不到（发送端停了？）`)
    const { payload: cp } = unpackMessage(new Uint8Array(got))
    const len = Math.min(f.chunkBytes, f.size - ci * f.chunkBytes)
    const pt = openChunk(keys.enc, 0, ci, f.chunks,
      Buffer.from(cp.subarray(16)), Buffer.from(cp.subarray(0, 16)), len)
    whole.update(pt)
    bytes += pt.length
    // 必须 ack：中继靠它推进窗口，不 ack 发送端会停
    await fetch(url(`/ack?upTo=${seq}`), { method: 'POST' })
  }
  const elapsed = Date.now() - t0
  return { bytes, elapsed, hashOk: whole.digest('hex') === f.sha256, chunks: f.chunks, wire }
}

const waitExit = (child, ms) => new Promise((resolve) => {
  const t = setTimeout(() => { try { child.kill() } catch { /* 已退出 */ } resolve(null) }, ms)
  child.on('exit', (code) => { clearTimeout(t); resolve(code) })
})

/**
 * 收到的字节数必须等于文件大小。
 * ⚠️ 这条不是形式：接收端如果少收了几块，测出来的"峰值内存很低"
 *    只是因为它压根没走完全程 —— 一个看门狗能防住整份结论是假的。
 */
function assertSameSize(r, expected) {
  if (r.bytes !== expected) {
    throw new Error(`只收到 ${(r.bytes / MiB).toFixed(1)} MiB，期望 ${(expected / MiB).toFixed(0)} MiB —— ` +
      '传输没走完，这一轮的峰值数据不能用')
  }
}

// ── 一次测量 ────────────────────────────────────────────────

async function measure(sizeBytes, workDir, extraArgs = []) {
  const label = `${(sizeBytes / MiB).toFixed(0)} MiB`
  const file = await makeBigFile(workDir, `big-${sizeBytes}.bin`, sizeBytes)
  const certFile = path.join(workDir, `ca-${sizeBytes}.pem`)

  // 文件本身很大 ⇒ 给足超时（哈希一遍 + 传一遍）
  const timeoutMs = 15 * 60 * 1000
  const sender = await startSender(file, certFile, extraArgs, timeoutMs)
  const pid = sender.child.pid
  const sampler = startSampler(pid)

  let result, failure = null
  try {
    if (VIA_RELAY) {
      // 中继模式：发送端只往房间里投，进度由我们在对面 ack 推进
      const u = new URL(sender.base)
      const room = sender.token                     // __READY__ 的第二个字段就是房间名
      const r = await drainRelay(u.origin, room)
      result = r
    } else {
      const client = makeClient(certFile)
      const F = (u, i = {}) => client(i.method ?? 'GET', `${sender.base}${u}`, i)

      await (await F(`/?k=${encodeURIComponent(sender.token)}`)).text()
      const info = await (await F(`/api/session?k=${encodeURIComponent(sender.token)}`)).json()
      const keys = deriveKeys(deriveVerifier(PASSWORD, b64dec(info.salt)))
      const { challenge } = await (await F(`/api/auth/start?k=${encodeURIComponent(sender.token)}`, { method: 'POST' })).json()
      // challenge 是 base64 文本，receiverMac 要的是**字节**（它内部做 Buffer.concat）
      const mac = receiverMac(keys.auth, b64dec(challenge))
      const fin = await F('/api/auth/finish', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challenge, mac: mac.toString('base64') }),
      })
      if (!fin.ok) throw new Error('认证失败: ' + (await fin.text()))
      const { sid } = await fin.json()
      const wire = JSON.parse(openManifest(keys.enc, b64dec(info.manifest.iv),
        b64dec(info.manifest.ct), b64dec(info.manifest.tag)).toString('utf8'))

      const f = wire.files[0]
      const whole = createHash('sha256')
      let bytes = 0
      const t0 = Date.now()
      for (let ci = 0; ci < f.chunks; ci++) {
        const r = await F(`/api/chunk?seq=${ci}&sid=${encodeURIComponent(sid)}`)
        if (!r.ok) throw new Error(`块 ${ci} 失败: HTTP ${r.status} — ${await r.text()}`)
        const ct = Buffer.from(await r.arrayBuffer())
        const tag = b64dec(r.headers['x-flicker-tag'])
        const plainLen = Math.min(f.chunkBytes, f.size - ci * f.chunkBytes)
        const pt = openChunk(keys.enc, 0, ci, f.chunks, ct, tag, plainLen)
        whole.update(pt)
        bytes += pt.length
      }
      const elapsed = Date.now() - t0
      const hashOk = whole.digest('hex') === f.sha256
      await F(`/api/done?sid=${encodeURIComponent(sid)}`, { method: 'POST' })
      result = { bytes, elapsed, hashOk, chunks: f.chunks }
    }
    assertSameSize(result, sizeBytes)
  } catch (e) {
    failure = e
  } finally {
    sampler.stop()
    // 采样器一直在跑，所以这里读到的是真峰值 —— 即使进程已经退出
    const peak = sampler.peak()
    const sampleCount = sampler.sampleCount()
    if (sender.child.exitCode === null) await waitExit(sender.child, 20000)
    if (!KEEP) await rm(file, { force: true })

    if (failure) {
      console.error(`\n  ✗ ${label} 失败：${failure.message}`)
      // 只留最后几行 —— 大文件的进度条会把日志淹掉（实测 512 MiB 有上万行）
      const tail = sender.getOut().split('\n').filter((l) => l.trim()).slice(-3).join('\n')
      console.error(tail)
      return null
    }
    return { label, ...result, peak, sampleCount }
  }
}

// ── 主流程 ──────────────────────────────────────────────────

const fmtMiB = (n) => (n == null ? '—' : (n / MiB).toFixed(1) + ' MiB')

console.log('大文件内存实测：发送端峰值内存 vs 文件大小')
console.log('='.repeat(64))
console.log(`平台 ${process.platform} · 分块 1 MiB · 关闭赠品（只测目标文件本身）`)
console.log(`传输方式：${VIA_RELAY ? '经中继（跨网络那条路）' : '局域网直连 HTTPS'}`)
console.log(`峰值来源：${process.platform === 'win32' ? 'PeakWorkingSet64（高水位）'
  : process.platform === 'linux' ? 'VmHWM（高水位）'
    : 'ps 轮询（偏低，macOS 没有高水位）'}\n`)

// 中继模式下先起一个本地中继（与 Cloudflare Worker 同一份协议实现）
const RELAY_PORT = 8800 + Math.floor(Math.random() * 100)
let relayChild = null
if (VIA_RELAY) {
  try {
    relayChild = await startRelay(RELAY_PORT)
    console.log(`  本地中继已启动（127.0.0.1:${RELAY_PORT}）\n`)
  } catch (e) {
    console.error(`  ✗ ${e.message}`)
    process.exit(1)
  }
}

const workDir = await mkdtemp(path.join(tmpdir(), 'flicker-bench-mem-'))
const rows = []
try {
  for (const mib of SIZES) {
    process.stdout.write(`  正在测 ${mib} MiB …`)
    const r = await measure(mib * MiB, workDir,
      VIA_RELAY ? [`--relay=http://127.0.0.1:${RELAY_PORT}`] : [])
    if (r) {
      rows.push(r)
      console.log(` 完成（${r.elapsed} ms，${(r.bytes / MiB / (r.elapsed / 1000)).toFixed(0)} MiB/s）`)
    } else {
      console.log(' 失败')
    }
  }
} finally {
  if (!KEEP) await rm(workDir, { recursive: true, force: true })
  if (relayChild) { try { relayChild.kill() } catch { /* 已退出 */ } }
}

if (rows.length) {
  console.log('\n' + '─'.repeat(72))
  console.log('文件大小        峰值内存     传输量      耗时      吞吐      哈希   采样')
  for (const r of rows) {
    console.log(
      `${r.label.padEnd(14)}${fmtMiB(r.peak).padEnd(13)}` +
      `${fmtMiB(r.bytes).padEnd(12)}${(r.elapsed + ' ms').padEnd(10)}` +
      `${(r.bytes / MiB / (r.elapsed / 1000)).toFixed(0).padStart(4)} MiB/s   ` +
      `${r.hashOk ? '✓' : '✗'}     ${r.sampleCount ?? 0}`)
  }

  // ⚠️ 峰值为空的那些行必须**排除在分析之外**，不能当成 0 或忽略不提。
  //    采样器要先把 PowerShell 拉起来（约 200~400ms），而中继模式下传一个
  //    1 MiB 的文件只要 8ms —— 进程早就退出了，一次都没采到。
  //    拿空值去算斜率会得出"内存反而下降"这种荒唐结论。
  const noSample = rows.filter((r) => r.peak == null)
  const withPeak = rows.filter((r) => r.peak != null)
  if (noSample.length) {
    console.log(`\n注：${noSample.map((r) => r.label).join('、')} 这一行没采到内存 —— ` +
      '传输太快，采样器还没起来进程就退出了。这几行**不参与**下面的分析。')
  }

  const base = withPeak[0]
  const big = withPeak[withPeak.length - 1]
  if (withPeak.length >= 2 && base.peak && big.peak) {
    console.log('\n' + '─'.repeat(72))
    const sizeRatio = big.bytes / base.bytes
    const memRatio = big.peak / base.peak
    const extra = big.peak - base.peak
    console.log(`文件大了 ${sizeRatio.toFixed(0)} 倍（${base.label} → ${big.label}）：` +
      `峰值内存 ${fmtMiB(base.peak)} → ${fmtMiB(big.peak)}（${memRatio.toFixed(2)} 倍）`)

    // ⚠️ 单位要盯住：peak 是**字节**，斜率要换成 MiB 内存 / MiB 文件 才有意义。
    //    这里写错过一次（乘了 1024 而不是除），于是"每 MiB 涨 34 KiB"
    //    被打成"每 MiB 涨 3600 万 KiB"，结论也跟着反了。
    const slope = extra / (big.bytes - base.bytes)          // 字节内存 / 字节文件
    console.log(`斜率：文件每多 1 MiB，峰值上涨 ${(slope * 1024).toFixed(1)} KiB` +
      `（= ${(slope).toFixed(3)} MiB 内存 / MiB 文件）`)
    // 最直观的一个数：峰值占最大文件的比例。整体读进内存的话它必然 > 100%
    console.log(`峰值 ${fmtMiB(big.peak)} 是最大文件 ${big.label} 的 ` +
      `${(big.peak / big.bytes * 100).toFixed(1)}%`)

    if (slope < 0.05) {
      console.log('→ 斜率≈0：**峰值不随文件大小增长**，缓冲是常量。这是流式实现的硬证据。')
      console.log('   （若把整个文件读进内存，斜率应当≈1 MiB/MiB，且峰值占比 >100%。）')
    } else if (slope > 0.5) {
      console.log('→ 斜率接近 1：**确实有地方把整个文件读进了内存**，必须修。')
    } else {
      console.log('→ 斜率明显小于 1：有恒定开销，但值得看一眼是哪里在涨。')
    }

    // 饱和判据：若"每 MiB 文件的增量"随文件变大而下降，说明它是有界的，
    // 而不是在积累。这个判据比单看总斜率更能说明问题。
    if (withPeak.length >= 3) {
      const inc = []
      for (let i = 1; i < withPeak.length; i++) {
        const dMem = withPeak[i].peak - withPeak[i - 1].peak
        const dFile = withPeak[i].bytes - withPeak[i - 1].bytes
        inc.push({ pair: `${withPeak[i - 1].label}→${withPeak[i].label}`,
          perMiB: dMem / dFile, dMem, dFile })
      }
      console.log('\n每段的增量（越往后越小 = 有界，不是积累）：')
      for (const x of inc) {
        console.log(`  ${x.pair.padEnd(18)}文件 +${fmtMiB(x.dFile).padEnd(11)}` +
          `峰值 +${fmtMiB(x.dMem).padEnd(11)}每 MiB 文件 ${(x.perMiB * 1024).toFixed(1)} KiB`)
      }
      const first = inc[0].perMiB, last = inc[inc.length - 1].perMiB
      if (last < first / 4) {
        console.log('→ 增量在**收敛**：工作集有上界，不随文件增长。')
      }
    }
  }
}
