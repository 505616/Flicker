/**
 * 接收端到底被什么卡住 —— 真实浏览器 + 真实中继 + 人造往返延迟
 * ==============================================================
 *
 * ── 为什么必须量这个 ──
 * 路线图里那句"跨网络能跑约 24 MB/s"是**接收端用 16 条并发取块**测出来的
 * （`bench-window-sweep.mjs` 的 drain 默认并发 16）。而**真实接收页是逐块串行的**：
 * 取一块、解密、写盘，再去取下一块 —— 每块一个网络往返。
 *
 * 同一份路线图里还留着一句自认的欠账：
 *   "那 24 MB/s 描述的是链路能力，不是用户实际拿到的手感。
 *     修好 ack 之后的真实数字需要在真机上重测。"
 * 这个脚本就是来还这笔账的。
 *
 * ── 量三件事 ──
 *   ① `page`  —— **真实用户路径**：真页面、真点"开始接收"，量端到端 MB/s，
 *                并把页面每次取块的时间戳记下来（看它是不是"一块一个往返"）
 *   ② `drain` —— **并发预取的上限**：在同一浏览器里按 K 条并发取块 + 按序 ack，
 *                量"如果接收端不再串行，能跑多快"（不含解密/哈希 —— 那一半
 *                已经在 `bench-lan-parallel.mjs` 里量过：串行 174.7、并发 8 226.3 MiB/s）
 *   ③ 两者相减，就得到"解密+哈希"到底占多少 —— 以及"该开几条并发"的答案
 *
 * ── 中继的延迟模型（这一版是**双向**的） ──
 * `bench-window-sweep.mjs` 只给**发送端方向**加了延迟（按批放行），
 * 所以它测不到"接收端每块一个往返"这件事（那个模型里 GET 是零延迟返回的）。
 * 这里换成：
 *   · 发送端的 POST：按 RTT 边界成批放行（与上面那个脚本一致，便于对照）
 *   · 接收端的 GET：走一个**单服务器 FIFO 队列** ——
 *     服务时间 = 字节数 ÷ 链路带宽，之后再加上 RTT（存储转发模型）。
 *     于是"K 条并发"的聚合速率在第一个 RTT 之后正好等于链路带宽，
 *     不会被一个假的串行化人为压住。
 *   · 链路带宽默认取本机实测的 29.5 MB/s（`--link=0` 关闭上限）
 *
 * 用法：
 *   node _lab/bench-recv-rtt.mjs                       # 默认：64 MiB，RTT 0/50/195
 *   node _lab/bench-recv-rtt.mjs --size=32 --rtt=195
 *   node _lab/bench-recv-rtt.mjs --conc=1,4,8 --link=0
 *   node _lab/bench-recv-rtt.mjs --modes=page          # 只量真实用户路径
 */
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, stat, open } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { RoomStore } from '../src/relay/room.js'
import { handleRelay, packBatch } from '../src/relay/protocol.js'
import { RECEIVER_HTML } from '../relay/page.generated.js'
import { PARAMS } from '../src/suite/flicker1.js'
import { Cdp, sleep } from './cdp.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MiB = 1024 * 1024

// ── 参数 ────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const opt = (name, dflt) => {
  const a = argv.find((x) => x.startsWith(`--${name}=`))
  return a ? a.slice(name.length + 3) : dflt
}
const KEEP = argv.includes('--keep')
const SHOW = argv.includes('--show')
const SIZE_MIB = Number(opt('size', 64))
const RTTS = opt('rtt', '0,50,195').split(',').map(Number)
const CONCS = opt('conc', '1,4,8').split(',').map(Number)
const LINK_MBPS = Number(opt('link', 29.5))       // 0 = 不卡链路
const MODES = opt('modes', 'page,drain').split(',')
const PREFILL = Number(opt('prefill', 64))        // prefill 模式灌多少块
const PF = opt('pf', '')                          // 给链接追加 &pf=N，用来 A/B 预取深度
const LINK_SUFFIX = PF ? `&pf=${PF}` : ''
/**
 * 块大小（MiB）—— 线上格式**逐文件带 `chunkBytes`**，所以它与协议默认值不同也能跑；
 * IV 只由块号派生、AAD 只绑 (文件下标, 块号, 总块数, 明文长度)，都与块大小无关。
 *
 * ⚠️ 但**中继**有一条硬上限：`MAX_MESSAGE_BYTES = 1 MiB + 17`（一条消息 = 一块）。
 *    所以这里必须同时把中继的上限放宽 —— 否则量的是"默认中继拒收大块"，
 *    而不是"大块能跑多快"。真实部署里的这一条，正是块大小不能随手调的**原因**。
 */
const CHUNK_SPEC = opt('chunk', '1')
const CHUNK_AUTO = CHUNK_SPEC === 'auto'
// auto = **不给发送端任何提示**，让它按产品自己的能力协商去定（新中继会声明 2 MiB）。
// 这一档量的才是"用户默认会拿到什么"。
const CHUNK_MIB = CHUNK_AUTO ? 2 : Number(CHUNK_SPEC)
const CHUNK_BYTES = Math.round(CHUNK_MIB * MiB)
const RELAY_MAX_MSG = CHUNK_BYTES + 17
const WINDOW = Number(opt('window', 32))          // 发送端在途块数：必须够大，别让它成为瓶颈
const PASSWORD = 'bench-recv-rtt-pass'
const CHUNK = CHUNK_BYTES
const CHUNKS = Math.ceil(SIZE_MIB * MiB / CHUNK)
const TOTAL_MESSAGES = 1 + CHUNKS                  // seq 0 = 清单

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find(() => true)

const log = (...a) => console.log(...a)
const fmt = (n, d = 1) => n.toFixed(d)

/**
 * 进度同时写一份到文件。
 *
 * 为什么：这个脚本一轮要跑十几分钟，而管道里的输出在进程结束前看不到
 * （`| Select-Object` 会一直缓冲）—— 于是"跑到哪了"完全不可知，
 * 上一次就是这么卡了快一小时才发现。
 * 现在随时可以 `Get-Content _lab/out/bench-recv-rtt.log -Tail 20`。
 */
const LOG_FILE = path.join(ROOT, '_lab', 'out', 'bench-recv-rtt.log')
let logFd = null
try {
  const { mkdirSync, writeFileSync, appendFileSync } = await import('node:fs')
  mkdirSync(path.dirname(LOG_FILE), { recursive: true })
  writeFileSync(LOG_FILE, `# ${new Date().toISOString()}\n`, 'utf8')
  logFd = appendFileSync
} catch { /* 写不了就只打屏 */ }
const progress = (msg) => {
  log(msg)
  try { logFd?.(LOG_FILE, msg + '\n', 'utf8') } catch { /* 忽略 */ }
}

// ── 延迟中继 ────────────────────────────────────────────────
/**
 * @param {object} o
 * @param {number} o.rttMs 往返延迟
 * @param {number} o.linkMBps 接收方向的链路带宽（MB/s，0 = 不限）
 */
async function startRelay({ rttMs, linkMBps }) {
  const store = new RoomStore({ maxMessageBytes: RELAY_MAX_MSG })
  let batchStart = Date.now()
  // 接收端"同时挂着的取块请求"峰值 —— 用来判断浏览器到底并行了几条。
  // 没有这个读数就只能猜（第一版就是靠猜，猜错了）。
  let getInFlight = 0
  let getMaxInFlight = 0
  // 取块时间线：到达时刻 / 算出要等多久 / 实际交付时刻。
  // 用来分辨"客户端发得慢"还是"服务端压着不发" —— 只看总吞吐猜不出来。
  const trace = []

  // 单服务器 FIFO：服务时间 = 字节 ÷ 带宽。下一条要等上一条"发完"才开始。
  let nextFreeAt = 0
  const serveBytes = (bytes) => {
    if (!linkMBps) return 0
    const now = Date.now()
    const start = Math.max(now, nextFreeAt)
    const serviceMs = (bytes / (linkMBps * 1e6)) * 1000
    nextFreeAt = start + serviceMs
    return nextFreeAt - now            // 还要等多久这条才"发完"
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = Buffer.concat(chunks)

    const isGet = req.method === 'GET'
    const isAck = req.method === 'POST' && url.pathname.endsWith('/ack')
    const isSenderPost = req.method === 'POST' && !isAck

    let releaseAt = 0
    if (isSenderPost && rttMs) {
      const now = Date.now()
      if (now - batchStart >= rttMs) batchStart = now
      releaseAt = batchStart + rttMs          // 与 bench-window-sweep 同一套模型
    }

    const r = await handleRelay(new Request('http://relay' + req.url, {
      method: req.method, body: body.length ? body : undefined,
    }), url.pathname, store, { pageHtml: async () => RECEIVER_HTML })
    const buf = Buffer.from(await r.arrayBuffer())

    // 接收方向：正文的传输时间 + 一个 RTT（存储转发）
    let wait = releaseAt ? Math.max(0, releaseAt - Date.now()) : 0
    if (isGet && buf.length) {
      getInFlight++
      if (getInFlight > getMaxInFlight) getMaxInFlight = getInFlight
      const service = serveBytes(buf.length)
      wait = Math.max(wait, service + (rttMs || 0))
      if (trace.length < 400) trace.push({ seq: url.searchParams.get('seq'), at: Date.now(), wait: Math.round(wait) })
    } else if (isAck && rttMs) {
      wait = Math.max(wait, rttMs)
    }

    try {
      if (wait > 0) await sleep(wait)
      const h = {}
      r.headers.forEach((v, k) => { h[k] = v })
      res.writeHead(r.status, h)
      res.end(buf)
      if (isGet && buf.length && trace.length) {
        const last = trace[trace.length - 1]
        if (last && last.seq === url.searchParams.get('seq') && last.done === undefined) {
          last.done = Date.now()
        }
      }
    } finally {
      if (isGet && buf.length) getInFlight--
    }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
    /**
     * 房间里"堆着还没被取走"的消息条数。
     *
     * 这个读数能一句话区分两种完全不同的瓶颈：
     *   · 深度常年贴着 0  → **发送端喂不满**（它自己的节奏/窗口是瓶颈）
     *   · 深度常年满     → **接收端取不快**（并发预取才有意义）
     * 不看它，光看吞吐会把两者混为一谈。
     */
    status: (room) => { try { return store.status(room) } catch { return null } },
    /** 接收端并发峰值（中继侧观察到的"同时挂着的取块请求"） */
    maxInFlight: () => getMaxInFlight,
    resetInFlight: () => { getMaxInFlight = 0; getInFlight = 0; trace.length = 0 },
    trace: () => trace.slice(),
  }
}

// ── 注入的探针：给页面里每一次取块打时间戳 ──────────────────
const TIMING_PROBE = `
  window.__chunkTimes = [];
  const __of = window.fetch;
  window.fetch = function (...a) {
    const u = String(a[0]);
    const t0 = performance.now();
    return __of.apply(this, a).then((r) => {
      if (/[?&]seq=\\d+/.test(u)) window.__chunkTimes.push([t0, performance.now(), r.status]);
      return r;
    });
  };
`

// ── 注入的并发取块器（drain 模式） ──────────────────────────
function drainerSource(concurrency) {
  return `(async () => {
    const p = new URLSearchParams(location.hash.replace(/^#/, ''));
    const room = p.get('k');
    const url = (s = '') => '/r/' + room + s;
    const TOTAL = ${TOTAL_MESSAGES};
    const K = ${concurrency};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const bytes = new Map();
    let next = 0, acked = -1;
    const done = new Set();

    async function fetchOne(seq) {
      for (let i = 0; i < 200000; i++) {
        const r = await fetch(url('?seq=' + seq), { cache: 'no-store' });
        if (r.ok) { const b = await r.arrayBuffer(); return b.byteLength; }
        let code = 'HTTP_' + r.status;
        try { code = (await r.json()).error || code } catch {}
        if (code === 'NOT_YET' || r.status === 404) { await sleep(2); continue }
        throw new Error('seq ' + seq + ' → ' + code);
      }
      throw new Error('seq ' + seq + ' 超时');
    }
    const flushAcks = async () => {
      while (done.has(acked + 1)) {
        acked++;
        await fetch(url('/ack?upTo=' + acked), { method: 'POST', cache: 'no-store' });
      }
    };
    // ⚠️ ack **绝不能**放在热路径上 await —— 真实接收页踩过这个坑（"接收端每取一块
    //    都会 ack"只是注释），这里第一版也踩了：循环里 await 一次 ack 就是多一个
    //    往返，于是"并发 8"实测和"并发 1"一样快，看起来像"并发没用"。
    //    正确做法与页面一致：合并成后台发送，主循环不等它。
    let ackBusy = false;
    const kickAcks = () => {
      if (ackBusy) return;
      ackBusy = true;
      flushAcks().catch(() => {}).finally(() => { ackBusy = false; });
    };

    const t0 = performance.now();
    const inFlight = new Set();
    while (next < TOTAL || inFlight.size) {
      while (inFlight.size < K && next < TOTAL) {
        const seq = next++;
        const pr = fetchOne(seq).then((n) => { inFlight.delete(pr); done.add(seq); bytes.set(seq, n) });
        inFlight.add(pr);
      }
      if (inFlight.size) await Promise.race(inFlight);
      kickAcks();
    }
    for (let i = 0; i < 200 && (ackBusy || acked < TOTAL - 1); i++) {
      await flushAcks().catch(() => {});
      if (acked >= TOTAL - 1) break;
      await sleep(50);
    }
    const ms = performance.now() - t0;
    let total = 0;
    for (let s = 1; s < TOTAL; s++) total += bytes.get(s) || 0;
    return { ms, acked, chunks: TOTAL - 1, payload: total };
  })()`
}

// ── 注入的"纯取块"器（prefill 模式） ────────────────────────
/**
 * 只做一件事：把房间里已经存在的 N 条消息按 K 条并发取回来，不 ack、不解密。
 *
 * 为什么要单独有这么一个模式：`drain` 模式里混着三件事（取块 / ack / 发送端补货），
 * 实测发现同一个 seq 会被取两次（126 条记录对应 64 个块）—— 那是一次 ack
 * 把消息从房间里删掉、而某个在途请求又去取它造成的竞态。
 * 有它在，任何"并发到底值多少"的结论都不可信。
 * 所以把变量清干净：房间**先灌满**，然后只取块，一次算准。
 */
function pureDrainerSource(concurrency, total) {
  return `(async () => {
    const p = new URLSearchParams(location.hash.replace(/^#/, ''));
    const url = (s = '') => '/r/' + p.get('k') + s;
    const TOTAL = ${total};
    const K = ${concurrency};
    const lat = [];
    let next = 0, bytes = 0;
    const errors = [];

    async function one(seq) {
      const t0 = performance.now();
      for (let i = 0; i < 20; i++) {
        const r = await fetch(url('?seq=' + seq), { cache: 'no-store' });
        if (r.ok) {
          const b = await r.arrayBuffer();
          lat.push(performance.now() - t0);
          return b.byteLength;
        }
        let code = 'HTTP_' + r.status;
        try { code = (await r.json()).error || code } catch {}
        if (code === 'NOT_YET') { await new Promise((x) => setTimeout(x, 5)); continue }
        errors.push('seq ' + seq + ' → ' + code); return 0;
      }
      errors.push('seq ' + seq + ' 重试耗尽'); return 0;
    }

    const t0 = performance.now();
    const inFlight = new Set();
    while (next < TOTAL || inFlight.size) {
      while (inFlight.size < K && next < TOTAL) {
        const seq = next++;
        const pr = one(seq).then((n) => { inFlight.delete(pr); bytes += n });
        inFlight.add(pr);
      }
      if (inFlight.size) await Promise.race(inFlight);
    }
    const ms = performance.now() - t0;
    lat.sort((a, b) => a - b);
    return { ms, bytes, fetches: lat.length, errors,
      p50: Math.round(lat[Math.floor(lat.length / 2)] ?? 0),
      max: Math.round(lat[lat.length - 1] ?? 0) };
  })()`
}

// ── 主流程 ──────────────────────────────────────────────────
const work = await mkdtemp(path.join(tmpdir(), 'bench-recv-rtt-'))
const cleanups = []
const cleanup = async () => {
  for (const fn of cleanups.reverse()) { try { await fn() } catch { /* 尽力 */ } }
}
process.on('exit', () => { for (const fn of cleanups) { try { fn() } catch { /* 尽力 */ } } })

log(`\n══ 接收端瓶颈测量 · 真实浏览器 + 真实中继 ═══════════════════`)
log(`  文件 ${SIZE_MIB} MiB（${CHUNKS} 块 × ${CHUNK_MIB} MiB）· RTT ${RTTS.join('/')} ms · 并发 ${CONCS.join('/')}`)
log(`  链路带宽 ${LINK_MBPS || '不限'} ${LINK_MBPS ? 'MB/s（接收方向）' : ''} · 发送端窗口 ${WINDOW}`)
log(`  中继单条上限 ${(RELAY_MAX_MSG / MiB).toFixed(2)} MiB（默认部署值是 1.00）· 模式 ${MODES.join('+')} · ${SHOW ? '**会弹窗**' : 'headless'}\n`)

// 源文件（内容随机但确定，只造一次）
const srcDir = path.join(work, 'src')
await mkdir(srcDir, { recursive: true })
const srcFile = path.join(srcDir, 'bench.bin')
{
  const block = randomBytes(MiB)
  const fh = await open(srcFile, 'w')
  for (let i = 0; i < SIZE_MIB; i++) await fh.write(block)
  await fh.close()
}
log(`  源文件 ${SIZE_MIB} MiB 已就绪\n`)

// 浏览器只起一次，后面每轮只导航
const debugPort = 9500 + Math.floor(Math.random() * 200)
const profileDir = path.join(work, 'edge-profile')
const browser = spawn(EDGE, [
  SHOW ? '--new-window' : '--headless=new',
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profileDir}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--disable-features=Translate,MediaRouter', '--disable-gpu', 'about:blank',
].filter(Boolean), { stdio: ['ignore', 'pipe', 'pipe'] })
cleanups.push(() => { try { browser.kill() } catch { /* 已退出 */ } })
let browserErr = ''
browser.stderr.on('data', (b) => { browserErr += b.toString() })

const cdp = await Cdp.attach(debugPort)
cdp.wire()
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')
await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: TIMING_PROBE })
log('  浏览器已连上（CDP），探针已注入\n')

/** 起一个发送端并等它打印出链接 */
async function startSender(relayBase) {
  const cli = spawn(process.execPath, [
    'bin/flicker.js', 'send', srcFile,
    `--relay=${relayBase}`, `--password=${PASSWORD}`,
    `--window=${WINDOW}`, '--timeout=180s', '--no-gift', '--no-qr', '--no-color',
  ], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    // 块大小：`--chunk=auto` 时**什么都不设**，让发送端走产品自己的能力协商
    // （先问中继 /health，再取 min(想要的, 对方声明的)）—— 那才是用户默认路径。
    // 其余情况用测量旁路 FLICKER_CHUNK_BYTES 把块大小钉死，
    // 它照样会经过同一套裁剪逻辑（测量走的必须是生产那条路）。
    env: CHUNK_AUTO ? process.env : { ...process.env, FLICKER_CHUNK_BYTES: String(CHUNK_BYTES) },
  })
  let out = ''
  let link = null
  const onData = (b) => {
    out += b.toString()
    const m = out.replace(/\u001b\[[0-9;]*m/g, '')
      .match(/(https?:\/\/[^\s│┌┐└┘─]*\/#k=[0-9a-f]{64}&s=[0-9a-f]{32})/)
    if (m && !link) link = m[1]
  }
  cli.stdout.on('data', onData)
  cli.stderr.on('data', onData)
  for (let i = 0; i < 300 && !link && cli.exitCode === null; i++) await sleep(100)
  if (!link) throw new Error(`发送端没有给出链接：\n${out.slice(0, 600)}`)
  return { cli, link, out: () => out }
}

const results = []

for (const rtt of RTTS) {
  const relay = await startRelay({ rttMs: rtt, linkMBps: LINK_MBPS })
  log(`\n── RTT ${rtt} ms ──────────────────────────────────────────`)

  for (const mode of MODES) {
    const concs = mode === 'page' ? [1] : CONCS
    for (const conc of concs) {
      const label = mode === 'page' ? '真实页面（逐块串行）'
        : mode === 'prefill' ? `纯取块 K=${conc}` : `并发取块 K=${conc}`
      let row = { rtt, mode, conc, ok: false }
      relay.resetInFlight()
      let sender = null
      // 在 try 之前声明：finally 里要无条件停掉它（漏了就会跑完不退出）
      let stopSampler = () => {}
      try {
        // prefill 模式**不起发送端**：直接从 Node 把房间灌满。
        // 为什么要这样：发送端在没有 ack 的情况下会超时收尾并把房间销毁
        // （实测：K=1 的 32 块还没取完，房间就没了，取块开始报 NO_ROOM），
        // 于是"纯取块"这件事根本量不准。绕开它，变量就只剩延迟、带宽与并发。
        let link = null
        if (mode === 'prefill') {
          const room = randomBytes(32).toString('hex')
          // ⚠️ 必须先**创建房间**：`POST /r/:room/batch` 不负责创建
          //    （协议里只有"不带 seq 的基础 POST"有创建语义）—— 少了这一句，
          //    batch 会一路回 404 NO_ROOM，看起来像"中继不认这个房间"。
          const created = await fetch(`${relay.base}/r/${room}`, { method: 'POST' })
          if (!created.ok) throw new Error(`创建房间失败：${created.status}`)
          const msg = Buffer.alloc(1 + 16 + CHUNK, 7)
          const items = Array.from({ length: PREFILL }, () => msg)
          for (let off = 0; off < items.length; off += 8) {
            const body = packBatch(items.slice(off, off + 8))
            const r = await fetch(`${relay.base}/r/${room}/batch`, { method: 'POST', body })
            if (!r.ok) throw new Error(`灌房间失败：${r.status} ${await r.text().catch(() => '')}`)
          }
          link = `${relay.base}/#k=${room}&s=${'0'.repeat(32)}`
        } else {
          sender = await startSender(relay.base)
          link = sender.link + LINK_SUFFIX
        }
        await cdp.send('Page.navigate', { url: link })
        // 等页面读 fragment、渲染出密码框（drain/prefill 模式不需要它，但页面得先加载好）
        let ready = false
        for (let i = 0; i < 100 && !ready; i++) {
          await sleep(100)
          ready = await cdp.eval(`!!document.getElementById('pw')`).catch(() => false)
        }
        if (!ready) throw new Error('接收页没有渲染出来')

        // 队列深度采样：房间里堆着多少条没被取走 —— 用来分辨"谁在拖后腿"
        const room = (() => {
          try { return new URLSearchParams(new URL(link).hash.slice(1)).get('k') } catch { return null }
        })()
        const depths = []
        const sampler = room ? setInterval(() => {
          const st = relay.status(room)
          if (st) depths.push(Math.max(0, st.nextSeq - st.ackedBase))
        }, 150) : null
        const stopSamplerInner = () => {
          if (sampler) clearInterval(sampler)
          if (depths.length) {
            const d = [...depths].sort((a, b) => a - b)
            row.depthMedian = d[Math.floor(d.length / 2)]
            row.depthMax = d[d.length - 1]
            row.depthMin = d[0]
          }
        }
        stopSampler = stopSamplerInner

        if (mode === 'page') {
          await cdp.eval(`window.__chunkTimes = []; true`)
          await cdp.eval(`(() => {
            const el = document.getElementById('pw');
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(el, ${JSON.stringify(PASSWORD)});
            el.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
          })()`)
          const t0 = Date.now()
          await cdp.eval(`document.getElementById('btnStart').click(); true`)
          let state = null
          for (let i = 0; i < 3000; i++) {
            await sleep(200)
            state = await cdp.eval(`(() => {
              const vis = (id) => { const el = document.getElementById(id); return el && !el.classList.contains('hide') };
              return { done: vis('v-done'), err: vis('v-err'),
                errMsg: (document.getElementById('err-msg')?.textContent || '').trim().slice(0, 100) };
            })()`).catch(() => null)
            if (state?.done || state?.err) break
          }
          const ms = Date.now() - t0
          row = { ...row, ok: !!state?.done, ms, mbps: (SIZE_MIB * MiB / 1e6) / (ms / 1000) }
          row.errMsg = state?.err ? state.errMsg : null
          const times = (await cdp.eval('(window.__chunkTimes || [])').catch(() => []))
            .filter((t) => t[2] === 200)
          row.fetches = times.length
          if (times.length >= 2) {
            // 只算"取块阶段"：从第一次取块到最后一取块结束 ——
            // 把握手（PBKDF2 60 万次）那段排除掉，否则小文件会被启动开销污染
            const first = times[0][0]
            const last = times[times.length - 1][1]
            row.steadyMs = Math.round(last - first)
            row.steadyMbps = ((times.length - 1) * CHUNK / 1e6) / ((last - first) / 1000)
          }
          const gaps = []
          for (let i = 1; i < times.length; i++) gaps.push(times[i][0] - times[i - 1][0])
          gaps.sort((a, b) => a - b)
          row.gapCount = gaps.length
          row.gapMedian = gaps.length ? Math.round(gaps[Math.floor(gaps.length / 2)]) : null
        } else if (mode === 'prefill') {
          // 房间已经灌满（没有发送端会来销毁它），直接纯取块
          const r = await cdp.eval(pureDrainerSource(conc, PREFILL), true)
          const ms = Math.round(r.ms)
          const payload = (r.bytes / 1e6)
          row = { ...row, ok: r.errors.length === 0 && r.fetches === PREFILL,
            ms, mbps: payload / (ms / 1000), prefillChunks: PREFILL,
            p50: r.p50, pMax: r.max, errors: r.errors.slice(0, 3) }
        } else {
          const r = await cdp.eval(drainerSource(conc), true)
          const ms = Math.round(r.ms)
          row = { ...row, ok: r.acked === TOTAL_MESSAGES - 1, ms,
            mbps: (SIZE_MIB * MiB / 1e6) / (ms / 1000), acked: r.acked }
        }

        // 等发送端收尾（它要等 ackedBase >= total）—— 顺便证明 ack 真的到位了。
        // ⚠️ prefill 模式**没有发送端**（房间是直接从 Node 灌的），这里必须判空：
        //    第一版直接读了 `sender.cli`，一抛错就跳过了 stopSampler()，
        //    setInterval 留着不退 → 整个脚本跑完全部用例却不退出（卡了近一小时）。
        if (sender) {
          for (let i = 0; i < 300 && sender.cli.exitCode === null; i++) await sleep(100)
          row.senderExit = sender.cli.exitCode
        }
        row.maxInFlight = relay.maxInFlight()
        stopSampler()
      } catch (e) {
        row.error = e.message
      } finally {
        // 采样定时器必须**无条件**停掉：它一漏，进程就跑完了也不退出
        try { stopSampler() } catch { /* 没起来过 */ }
        if (sender) { try { sender.cli.kill() } catch { /* 已退出 */ } }
      }
      results.push(row)
      const speed = row.ok ? `${fmt(row.mbps)} MB/s` : `失败（${row.error || row.errMsg || '未完成'}）`
      const steady = row.steadyMbps ? ` · 取块阶段 ${fmt(row.steadyMbps)} MB/s` : ''
      const depth = row.depthMedian !== undefined
        ? ` · 队列深度 中位 ${row.depthMedian}/最大 ${row.depthMax} 条` : ''
      const inflight = row.maxInFlight ? ` · 实际并发峰值 ${row.maxInFlight}` : ''
      const lat = row.p50 !== undefined ? ` · 单块延迟 p50=${row.p50}ms 最大=${row.pMax}ms` : ''
      progress(`  ${label.padEnd(22)} ${String(row.ms ?? '-').padStart(6)} ms   ${speed}${steady}${depth}${inflight}${lat}` +
        (row.prefillChunks ? `   （${row.prefillChunks} 块）` : '') +
        (row.errors?.length ? `   ⚠️ ${row.errors.join('；')}` : '') +
        (row.gapMedian ? `   （相邻取块间隔中位 ${row.gapMedian} ms）` : '') +
        (row.senderExit !== undefined ? `   发送端退出码 ${row.senderExit}` : ''))
      if (process.env.FLICKER_TRACE === '1') {
        const tr = relay.trace().filter((t) => t.seq !== null)
        const base = tr[0]?.at ?? 0
        const gaps = []
        for (let i = 1; i < tr.length; i++) gaps.push(tr[i].at - tr[i - 1].at)
        gaps.sort((a, b) => a - b)
        const p = (q) => gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * q))] : 0
        log(`      取块（不含状态轮询）共 ${tr.length} 条 · 相邻到达间隔 p50=${p(0.5)}ms p90=${p(0.9)}ms 最大=${gaps[gaps.length - 1] ?? 0}ms`)
        log('      时间线尾部（相对首条）：')
        for (const t of tr.slice(-8)) {
          log(`        seq=${String(t.seq).padStart(3)}  到达 +${String(t.at - base).padStart(6)}ms  等 ${String(t.wait).padStart(4)}ms  交付 +${t.done !== undefined ? String(t.done - base).padStart(6) + 'ms' : '   ?'}`)
        }
      }
    }
  }
  await relay.close()
}

await cleanup()

// ── 结果表 ──────────────────────────────────────────────────
log(`\n══ 结果 ═══════════════════════════════════════════════════`)
log(`  ${'RTT'.padStart(5)} ${'模式'.padEnd(20)} ${'耗时'.padStart(9)} ${'吞吐'.padStart(12)}   ${'取块阶段'.padStart(12)}   理论(块÷RTT)`)
for (const r of results) {
  const theo = r.rtt > 0 ? `${fmt((CHUNK / MiB) / (r.rtt / 1000))} MB/s` : '不受延迟限制'
  const label = r.mode === 'page' ? '真实页面' : `并发 K=${r.conc}`
  log(`  ${String(r.rtt).padStart(4)}ms ${label.padEnd(20)} ${String(r.ms ?? '-').padStart(7)}ms ` +
    `${(r.ok ? fmt(r.mbps) : '—').padStart(10)} MB/s   ` +
    `${(r.steadyMbps ? fmt(r.steadyMbps) : '—').padStart(10)} MB/s   ` +
    `${r.mode === 'drain' ? '' : theo}`)
}

const outFile = path.join(ROOT, '_lab', 'out', 'bench-recv-rtt.json')
await mkdir(path.dirname(outFile), { recursive: true })
const { writeFile } = await import('node:fs/promises')
await writeFile(outFile, JSON.stringify({
  at: new Date().toISOString(), sizeMiB: SIZE_MIB, chunks: CHUNKS,
  linkMBps: LINK_MBPS || null, window: WINDOW, results,
}, null, 2), 'utf8')
log(`\n  原始数据：${path.relative(ROOT, outFile)}`)
if (KEEP) {
  log(`  临时目录保留在 ${work}`)
} else {
  // ⚠️ 先等浏览器真的退出，再删临时目录 —— 否则 Edge 还攥着
  //    `first_party_sets.db-journal`，rm 会 EBUSY 抛出来把结果盖掉（第一版就是这样）。
  try { browser.kill() } catch { /* 已退出 */ }
  await sleep(800)
  await rm(work, { recursive: true, force: true }).catch(() => { /* 删不掉就算了，别盖住结果 */ })
}
if (browserErr.trim()) log(`  （浏览器 stderr 有输出，长度 ${browserErr.length}）`)

// 硬退出：任何漏掉的定时器/句柄都不该让脚本跑完还挂着
// （第一版就因为一个没清掉的 setInterval 卡了近一小时，什么结果都没打印出来）
process.exit(results.some((r) => !r.ok) ? 1 : 0)
