/**
 * 网络诊断：现在这条链路到底是什么状况
 * ======================================
 *
 * 起因：`_lab/probe-network.mjs` 测出来"到 Cloudflare 只有 0.1 MB/s，还 403"，
 * 而路线图里记录的历史实测是 **29.5 MB/s**。差了 300 倍，这不是"带宽小"，
 * 是**中间有东西**。这个脚本用来把"东西"找出来。
 *
 * 要分清三种完全不同的情况，因为对策完全不同：
 *   A. 本机配了代理（Clash/v2ray 之类）—— 浏览器走代理，而 Node 的 fetch **默认不读系统代理**。
 *      那么"网页能开、程序很慢"就有了统一解释，而对策是让程序也能走代理。
 *   B. 运营商/防火墙在限速或拦截 —— 换目标（国内中继）或换时段。
 *   C. 链路本身就这么慢 —— 那只能换网络。
 *
 * 全部只读、有界；不修改任何系统设置。
 *
 * 用法：node _lab/probe-net-diag.mjs
 */

import { connect as tcpConnect } from 'node:net'
import { networkInterfaces } from 'node:os'

const TIMEOUT_MS = 6000
const MB = 1024 * 1024
const fmt = (n, u = '') => `${n.toFixed(1)}${u}`

/** TCP 连接测延迟；返回毫秒或 null */
function tcpProbe(host, port, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const sock = tcpConnect({ host, port, timeout: timeoutMs }, () => {
      const ms = Date.now() - t0
      sock.destroy(); resolve(ms)
    })
    sock.on('timeout', () => { sock.destroy(); resolve(null) })
    sock.on('error', (e) => { sock.destroy(); resolve({ err: e.code }) })
  })
}

const show = (r) => (r === null ? '✗ 超时' : typeof r === 'object' ? `✗ ${r.err}` : `✓ ${r} ms`)

// ── ① 代理痕迹 ──────────────────────────────────────────────

console.log('══ ① 有没有代理 ═══════════════════════════════════════\n')

const proxyVars = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy']
const setVars = proxyVars.filter((k) => process.env[k])
console.log(`  环境变量里的代理：${setVars.length ? setVars.map((k) => `${k}=${process.env[k]}`).join('  ') : '（没有）'}`)

// 常见本地代理端口：Clash 7890/7891、v2ray 10808/10809、SS 1080、通用 8080/8888
const PORTS = [7890, 7891, 10808, 10809, 1080, 8080, 8888, 20171]
const open = []
for (const p of PORTS) {
  const r = await tcpProbe('127.0.0.1', p, 400)
  if (typeof r === 'number') open.push(p)
}
console.log(`  本机监听的常见代理端口：${open.length ? open.join(', ') : '（没有）'}`)

// Windows 系统代理（注册表）——Node 不读它，但浏览器读
if (process.platform === 'win32') {
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const pexec = promisify(execFile)
    const { stdout } = await pexec('reg', ['query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '/v', 'ProxyEnable'], { windowsHide: true })
    const enabled = /0x1/.test(stdout)
    const { stdout: s2 } = await pexec('reg', ['query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '/v', 'ProxyServer'], { windowsHide: true }).catch(() => ({ stdout: '' }))
    const server = (s2.match(/ProxyServer\s+REG_SZ\s+(.+)/) ?? [])[1] ?? ''
    console.log(`  Windows 系统代理：${enabled ? `**已启用** ${server.trim()}` : '未启用'}`)
    if (enabled && !setVars.length) {
      console.log('    ⚠️ 系统代理开着而环境变量没有 —— **Node 的 fetch 不读系统代理**，')
      console.log('       所以浏览器能开网页、而这个程序会走直连。这能解释"网页正常、程序很慢"。')
    }
  } catch (e) {
    console.log(`  Windows 系统代理：读不到（${e.message.split('\n')[0]}）`)
  }
}

// ── ② 直连延迟：国内 vs 国外 ────────────────────────────────

console.log('\n══ ② 直连延迟（443 端口）═════════════════════════════\n')

const TARGETS = [
  ['223.5.5.5', '阿里 DNS', '国内'],
  ['119.29.29.29', '腾讯 DNS', '国内'],
  ['180.101.50.242', '百度', '国内'],
  ['1.1.1.1', 'Cloudflare DNS', '国外'],
  ['8.8.8.8', 'Google DNS', '国外'],
  ['104.16.132.229', 'Cloudflare CDN', '国外'],
]
for (const [ip, label, where] of TARGETS) {
  const r = await tcpProbe(ip, 443)
  console.log(`  ${where}  ${label.padEnd(18)} ${ip.padEnd(18)} ${show(r)}`)
}

// ── ③ 吞吐：分别打国内与国外 ────────────────────────────────

console.log('\n══ ③ 吞吐对比（各下 8 MB，测 25 秒上限）═══════════════\n')

async function throughput(url, label) {
  const t0 = Date.now()
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(25_000) })
    if (!r.ok) { console.log(`  ${label.padEnd(28)} HTTP ${r.status}`); return null }
    let got = 0
    for await (const c of r.body) {
      got += c.length
      if (Date.now() - t0 > 25_000) break
    }
    const s = (Date.now() - t0) / 1000
    const mbs = got / MB / s
    console.log(`  ${label.padEnd(28)} ${fmt(got / MB, ' MB')} / ${fmt(s, ' s')} = **${fmt(mbs, ' MB/s')}**`)
    return mbs
  } catch (e) {
    console.log(`  ${label.padEnd(28)} ✗ ${e.cause?.code ?? e.name ?? e.message}`)
    return null
  }
}

// 国内：腾讯软件下载站的固定大文件（长期稳定、支持 Range）
const dom = await throughput(
  'https://dldir1.qq.com/qqfile/qq/PCQQ9.7.17/QQ9.7.17.29225.exe', '国内 · 腾讯下载站')
// 国外：Cloudflare 测速端点
const intl = await throughput('https://speed.cloudflare.com/__down?bytes=8388608', '国外 · Cloudflare')

// ── ④ 结论 ──────────────────────────────────────────────────

console.log('\n══ ④ 结论 ═════════════════════════════════════════════\n')
console.log(`  国内链路：${dom === null ? '测不到' : fmt(dom, ' MB/s')}`)
console.log(`  国外链路：${intl === null ? '测不到' : fmt(intl, ' MB/s')}`)
if (open.length && !setVars.length) {
  console.log('\n  ⚠️ 本机有代理端口在监听，而环境变量里没有代理 ——')
  console.log('     中继模式若要提速，最直接的一步是**让程序能走这个代理**，而不是改传输代码。')
}
console.log('\n  提示：这些数字只代表"此刻这条路"，家宽的国际出口在不同时段能差十倍。')
