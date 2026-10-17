/**
 * 局域网直连下"真页面"能跑多快（**中继不在路径上**）
 * ==================================================
 *
 * ── 为什么还要单独量这一条 ──
 * `_lab/bench-recv-rtt.mjs` 量的是中继那条路（跨网络），而它的路径上**有我自己的
 * Node 中继**（每条 2 MiB 消息几次内存拷贝）。把链路上限调到 2.5 Gbps 时，
 * 那套基准给出"纯取块 280 MB/s / 真页面 105 MB/s" —— 但 105 这个数字里
 * 混着基准自身的开销，**不能当成接收端的天花板**。要量准，就得让中继离开路径：
 * 局域网模式下，页面直连发送端的 HTTPS 服务。
 *
 * ── 这一版量的是什么 ──
 *   真实 CLI 发送端（真证书、真 TLS、真磁盘读取、真加密）
 *     + 真实 Edge（headless，CDP 驱动）
 *     + **真页面**（真填密码、真点开始、真解密、真逐块校验、真整体哈希）
 *     + **替身写盘**（见下）
 *
 * ⚠️ **写盘用替身，而且必须说清楚**：headless 里驱动不了原生"保存到"对话框。
 *    所以这里给 `showSaveFilePicker` 装一个**计数用的假句柄** ——
 *    页面仍然走**它自己的流式写盘那条分支**（`createWritable()` → `write()` → `close()`），
 *    只是字节被数一下、丢掉，不落盘。这样做的理由：我们要量的是
 *    "网络 + 解密 + 校验"这条流水线，而不是把 1 GiB 拼成 Blob 的内存行为
 *    （后者在真机上根本不会发生 —— 用户走的就是流式写盘）。
 *    代价：**不校验落盘内容**；内容正确性由页面自己的逐块哈希/整体哈希保证
 *    （任何一块不对，页面会停在错误屏，本脚本会如实报出来）。
 *
 * 用法：
 *   node _lab/bench-lan-page.mjs                        # 1024 MiB，默认块大小，局域网 IP
 *   node _lab/bench-lan-page.mjs --host=loopback        # 走回环，量实现上限（不碰网卡）
 *   node _lab/bench-lan-page.mjs --chunk=1 --size=512
 *   node _lab/bench-lan-page.mjs --pf=1                 # 关掉预取，做对照
 */
import { spawn } from 'node:child_process'
import { mkdir, open, rm, stat } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { makeTempDir, cleanupTempDirs } from '../gen/tmp.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Cdp, sleep, TRACE_PROBE } from './cdp.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MiB = 1024 * 1024
const argv = process.argv.slice(2)
const opt = (name, dflt) => {
  const a = argv.find((x) => x.startsWith(`--${name}=`))
  return a ? a.slice(name.length + 3) : dflt
}
const SIZE_MIB = Number(opt('size', 1024))
const CHUNK = opt('chunk', 'auto')          // auto | 1 | 2 | 4（MiB）；不给 --chunk 就是产品默认
const HOST_MODE = opt('host', 'lan')        // lan | loopback
const PF = opt('pf', '')                    // 覆盖预取深度（对照用，例如 --pf=1）
const KEEP = argv.includes('--keep')
const SHOW = argv.includes('--show')
const PASSWORD = 'bench-lan-page-pass'
const DEBUG_PORT = 9700 + Math.floor(Math.random() * 200)

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find(Boolean)

const log = (...a) => console.log(...a)
const fmt = (n, d = 1) => n.toFixed(d)
const LOG_FILE = path.join(ROOT, '_lab', 'out', 'bench-lan-page.log')
let appendLog = null
try {
  const { mkdirSync, writeFileSync, appendFileSync } = await import('node:fs')
  mkdirSync(path.dirname(LOG_FILE), { recursive: true })
  writeFileSync(LOG_FILE, `# ${new Date().toISOString()}\n`, 'utf8')
  appendLog = appendFileSync
} catch { /* 写不了就只打屏 */ }
const progress = (m) => { log(m); try { appendLog?.(LOG_FILE, m + '\n', 'utf8') } catch { /* 忽略 */ } }

const cleanups = []
process.on('exit', () => { for (const fn of cleanups) { try { fn() } catch { /* 尽力 */ } } })

// ── 造源文件（确定性内容，够大且已在页缓存里）──
const work = makeTempDir('bench-lan-page-')
cleanups.push(() => { if (!KEEP) { cleanupTempDirs() } })
const srcDir = path.join(work, 'src')
await mkdir(srcDir, { recursive: true })
const srcFile = path.join(srcDir, 'bench.bin')
{
  const block = randomBytes(MiB)
  const fh = await open(srcFile, 'w')
  for (let i = 0; i < SIZE_MIB; i++) await fh.write(block)
  await fh.close()
}

progress(`\n══ 局域网直连 · 真页面吞吐 ═══════════════════════════════`)
progress(`  文件 ${SIZE_MIB} MiB · 块 ${CHUNK === 'auto' ? '自动（产品默认）' : CHUNK + ' MiB'}` +
  ` · 主机 ${HOST_MODE} · 预取深度 ${PF || '默认(6)'}`)

// ── 起真实 CLI 发送端 ──
const cliArgs = [
  'bin/flicker.js', 'send', srcDir,
  `--password=${PASSWORD}`, '--timeout=180s', '--no-qr', '--no-color', '--no-gift',
]
if (CHUNK !== 'auto') cliArgs.push(`--chunk=${CHUNK}m`)
const cli = spawn(process.execPath, cliArgs, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
cleanups.push(() => { try { cli.kill() } catch { /* 已退出 */ } })

let cliOut = ''
let link = null
const onCli = (b) => {
  cliOut += b.toString()
  if (!link) {
    const m = cliOut.replace(/\u001b\[[0-9;]*m/g, '')
      .match(/https:\/\/([\d.]+):(\d+)\/\?k=([A-Za-z0-9_-]+)/)
    if (m) link = { host: m[1], port: m[2], token: m[3], raw: m[0] }
  }
}
cli.stdout.on('data', onCli)
cli.stderr.on('data', onCli)
for (let i = 0; i < 600 && !link && cli.exitCode === null; i++) await sleep(100)
if (!link) {
  progress(`  ❌ 发送端没有给出链接：\n${cliOut.slice(-1200)}`)
  process.exit(1)
}
progress(`  发送端已就绪：https://${link.host}:${link.port}/?k=…`)

// 回环模式：把主机名换成 127.0.0.1（证书里本来就签了它），完全不碰网卡
const targetHost = HOST_MODE === 'loopback' ? '127.0.0.1' : link.host
const url = `https://${targetHost}:${link.port}/?k=${link.token}`

// ── 起真浏览器 ──
const profileDir = path.join(work, 'edge-profile')
const browser = spawn(EDGE, [
  SHOW ? '--new-window' : '--headless=new',
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${profileDir}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--disable-features=Translate,MediaRouter', '--disable-gpu', 'about:blank',
].filter(Boolean), { stdio: ['ignore', 'pipe', 'pipe'] })
cleanups.push(() => { try { browser.kill() } catch { /* 已退出 */ } })

const cdp = await Cdp.attach(DEBUG_PORT)
cdp.wire()
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')

// 注入：探针 + 取块计时 + **替身写盘**（走页面自己的流式分支，只数字节不落盘）
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: TRACE_PROBE + `
    window.__chunkTimes = [];
    const __of = window.fetch;
    window.fetch = function (...a) {
      const u = String(a[0]);
      const t0 = performance.now();
      return __of.apply(this, a).then((r) => {
        if (/\\/api\\/chunk\\?/.test(u)) window.__chunkTimes.push([t0, performance.now(), r.status]);
        return r;
      });
    };
    window.__written = 0;
    const fakeWritable = () => ({
      write: async (u8) => { window.__written += u8.length; },
      close: async () => {},
      abort: async () => {},
    });
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: async () => ({ createWritable: async () => fakeWritable() }),
    });
    Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: undefined });
  `,
})

const t0 = Date.now()
await cdp.send('Page.navigate', { url })
let ready = false
for (let i = 0; i < 150 && !ready; i++) {
  await sleep(200)
  ready = await cdp.eval(`!!document.getElementById('pw') && !!document.getElementById('btnStart')`).catch(() => false)
}
if (!ready) {
  progress('  ❌ 接收页没有渲染出来（证书警告页？）')
  process.exit(1)
}
progress('  接收页已渲染 —— 说明没有证书警告页')

await cdp.eval(`(() => {
  const el = document.getElementById('pw');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(PASSWORD)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`)
const tClick = Date.now()
await cdp.eval(`document.getElementById('btnStart').click(); true`)

let state = null
for (let i = 0; i < 6000; i++) {
  await sleep(200)
  state = await cdp.eval(`(() => {
    const vis = (id) => { const el = document.getElementById(id); return el && !el.classList.contains('hide') };
    const txt = (id) => (document.getElementById(id)?.textContent || '').trim().slice(0, 120);
    return { done: vis('v-done'), err: vis('v-err'), errTitle: txt('err-title'), errMsg: txt('err-msg'),
      written: window.__written | 0, speedUi: txt('go-speed') };
  })()`).catch(() => null)
  if (state?.done || state?.err) break
  if (cli.exitCode !== null && i > 10) break
}
const ms = Date.now() - tClick

// 等发送端收尾（它会走销毁流程、卸掉证书）
for (let i = 0; i < 600 && cli.exitCode === null; i++) await sleep(100)

const times = ((await cdp.eval('(window.__chunkTimes || [])').catch(() => [])) ?? [])
  .filter((t) => t[2] === 200)
// 实际用的块大小：发送端会打印一行"块大小 X.XX MiB"（只有不等于协议默认值时才打印）；
// 没打印就是协议默认的 1 MiB。
const chunkMiB = (() => {
  const m = cliOut.replace(/\u001b\[[0-9;]*m/g, '').match(/块大小\s+([\d.]+)\s*MiB/)
  if (m) return Number(m[1])
  return CHUNK === 'auto' ? 1 : Number(CHUNK)
})()
let steady = null
if (times.length >= 2) {
  const first = times[0][0]
  const last = times[times.length - 1][1]
  // 探针只统计 `/api/chunk?…`，所以每一条都是一块（清单走 `/api/manifest`，不在内）
  const payloadMB = times.length * chunkMiB
  steady = { ms: Math.round(last - first), rate: (payloadMB) / ((last - first) / 1000) }
}

progress(`\n  页面状态：${state?.done ? '✅ 完成屏' : state?.err ? '❌ 错误屏' : '⚠️ 未结束'}` +
  (state?.err ? `\n     ${state.errTitle} — ${state.errMsg}` : ''))
progress(`  端到端 ${ms} ms · 页面显示速率 ${state?.speedUi || '-'} · 替身写盘收到 ${((state?.written ?? 0) / MiB).toFixed(1)} MiB`)
progress(`  取块 ${times.length} 次（含清单）` +
  (steady ? ` · 取块阶段 ${steady.ms} ms → ${steady.rate ? fmt(steady.rate) + ' MB/s' : '—'}` : ''))
progress(`  端到端吞吐 ${fmt((SIZE_MIB * MiB / 1e6) / (ms / 1000))} MB/s`)

const okBytes = (state?.written ?? 0) === SIZE_MIB * MiB
if (!state?.done) progress('  ❌ 没有到达完成屏（内容校验失败或传输中断）')
if (!okBytes) progress(`  ❌ 写入字节数不符：期望 ${SIZE_MIB * MiB}，实际 ${state?.written}`)

const outFile = path.join(ROOT, '_lab', 'out', 'bench-lan-page.json')
try {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(outFile, JSON.stringify({
    at: new Date().toISOString(), sizeMiB: SIZE_MIB, chunk: CHUNK, host: HOST_MODE, pf: PF || null,
    ms, written: state?.written ?? null, fetches: times.length, steady,
    rateMBps: (SIZE_MIB * MiB / 1e6) / (ms / 1000), done: !!state?.done,
  }, null, 2), 'utf8')
  progress(`  原始数据：${path.relative(ROOT, outFile)}`)
} catch { /* 忽略 */ }

try { browser.kill() } catch { /* 已退出 */ }
try { cli.kill() } catch { /* 已退出 */ }
if (KEEP) progress(`  临时目录保留在 ${work}`)
else {
  await sleep(800)
  await rm(work, { recursive: true, force: true }).catch(() => {})
}
process.exit(state?.done && okBytes ? 0 : 1)
