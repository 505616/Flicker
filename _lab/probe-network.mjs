/**
 * 网络条件实测：IPv6 能不能用、链路到底能跑多快
 * ================================================
 *
 * 回答两个具体问题（都是用户问的，不能靠回忆回答）：
 *
 *   ① **IPv6 现在能直连了吗？** 这决定了路线图第 13 项能不能开始做。
 *      判据分三层，缺一不可：
 *        · 有没有全局 IPv6 地址（排除 fe80:: 链路本地与 fc00::/fd00:: 私有）
 *        · **能不能出网**（有地址不一定通 —— 这是最常见的坑）
 *        · 对端是不是也有 v6（用 AAAA 查询 + 实际连接来判）
 *
 *   ② **链路本身能跑多快？** 这决定了"提高传输速度"还有没有软件上的余地。
 *      若程序的吞吐已经贴着链路稳态，那再优化实现就是白费力气；
 *      若差得远，才说明瓶颈还在代码里。
 *
 * 所有测量都是**只读 + 有界**的：下载量固定、总时长有上限、失败就如实报失败。
 *
 * 用法：node _lab/probe-network.mjs
 */

import { networkInterfaces } from 'node:os'
import { connect as tcpConnect } from 'node:net'
import { lookup } from 'node:dns/promises'

const MB = 1024 * 1024
const TIMEOUT_MS = 12_000

const fmt = (n, unit = '') => `${n.toFixed(1)}${unit}`

// ── ① 地址盘点 ──────────────────────────────────────────────

console.log('══ ① 本机地址 ══════════════════════════════════════════\n')

const ifaces = networkInterfaces()
const globalV6 = [], linkLocalV6 = [], ulaV6 = [], v4 = []

for (const [name, addrs] of Object.entries(ifaces)) {
  for (const a of addrs ?? []) {
    if (a.internal) continue
    if (a.family === 'IPv6') {
      const ip = a.address.split('%')[0]          // 去掉 %eth0 这类 zone id
      if (/^fe80:/i.test(ip)) linkLocalV6.push({ name, ip })
      else if (/^f[cd]/i.test(ip)) ulaV6.push({ name, ip })
      else globalV6.push({ name, ip })
    } else if (a.family === 'IPv4') {
      v4.push({ name, ip: a.address })
    }
  }
}

/** 是不是运营商级 NAT 后面的私有地址（RFC1918 + 100.64/10 CGNAT 段） */
const isPrivate4 = (ip) =>
  /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
const isCgnat = (ip) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)

console.log(`  IPv4: ${v4.length} 个`)
for (const a of v4) {
  const tag = isCgnat(a.ip) ? '  ← CGNAT（运营商级 NAT）' : isPrivate4(a.ip) ? '  ← 内网' : ''
  console.log(`    ${a.name.padEnd(22)} ${a.ip}${tag}`)
}
console.log(`\n  全局 IPv6: ${globalV6.length} 个${globalV6.length ? '' : '   ← 没有！'}`)
for (const a of globalV6) console.log(`    ${a.name.padEnd(22)} ${a.ip}`)
if (linkLocalV6.length) {
  console.log(`  链路本地 IPv6: ${linkLocalV6.length} 个（fe80:: 不能用于跨网络直连）`)
  for (const a of linkLocalV6.slice(0, 3)) console.log(`    ${a.name.padEnd(22)} ${a.ip}`)
}
if (ulaV6.length) {
  console.log(`  私有 IPv6（ULA）: ${ulaV6.length} 个（也不能用于跨网络）`)
  for (const a of ulaV6) console.log(`    ${a.name.padEnd(22)} ${a.ip}`)
}

// ── ② IPv6 出网测试 ─────────────────────────────────────────

console.log('\n══ ② IPv6 能不能出网 ═════════════════════════════════\n')

/** 用 v6 或 v4 连一个地址，返回毫秒数或 null */
function tcpProbe(host, port, family, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const sock = tcpConnect({ host, port, family, timeout: timeoutMs }, () => {
      const ms = Date.now() - t0
      sock.destroy()
      resolve(ms)
    })
    sock.on('timeout', () => { sock.destroy(); resolve(null) })
    sock.on('error', () => { sock.destroy(); resolve(null) })
  })
}

// 测试目标：Cloudflare 的 v6 地址（与中继同一家，最有参考价值）
const V6_TARGETS = [
  ['2606:4700:4700::1111', 443, 'Cloudflare DNS 的 IPv6'],
  ['2400:3200::1', 443, '阿里 DNS 的 IPv6'],
]
for (const [host, port, label] of V6_TARGETS) {
  const ms = globalV6.length ? await tcpProbe(host, port, 6) : null
  console.log(`  ${label.padEnd(26)} ${ms === null ? '✗ 连不上' : `✓ ${ms} ms`}`)
}

if (!globalV6.length) {
  console.log('\n  → 没有全局 IPv6 地址，出网测试无意义（本机根本没有 v6 出口）')
}

// DNS 侧：看看目标域名有没有 AAAA 记录（对端是否支持 v6）
console.log('\n  DNS AAAA 记录（对端是否支持 v6）：')
for (const name of ['speed.cloudflare.com', 'www.taobao.com', 'www.baidu.com']) {
  try {
    const r = await lookup(name, { family: 6, all: true })
    console.log(`    ${name.padEnd(24)} ✓ ${r[0].address}`)
  } catch (e) {
    console.log(`    ${name.padEnd(24)} ✗ ${e.code ?? e.message}`)
  }
}

// ── ③ 公网出口到底是什么 ────────────────────────────────────

console.log('\n══ ③ 公网出口 ═════════════════════════════════════════\n')

/** 取 Cloudflare 的 trace（同时能验证 v4/v6 哪条路通） */
async function trace(url, label) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!r.ok) { console.log(`  ${label.padEnd(12)} HTTP ${r.status}`); return null }
    const txt = await r.text()
    const kv = Object.fromEntries(txt.trim().split('\n').map((l) => l.split('=')))
    console.log(`  ${label.padEnd(12)} ip=${kv.ip ?? '?'}  colo=${kv.colo ?? '?'}  ` +
      `http=${kv.http ?? '?'}`)
    return kv
  } catch (e) {
    console.log(`  ${label.padEnd(12)} ✗ ${e.cause?.code ?? e.name ?? e.message}`)
    return null
  }
}

const traceV4 = await trace('https://1.1.1.1/cdn-cgi/trace', 'IPv4')
const traceV6 = await trace('https://[2606:4700:4700::1111]/cdn-cgi/trace', 'IPv6')

if (traceV4?.ip) {
  const pub = traceV4.ip
  const localIsPrivate = v4.some((a) => isPrivate4(a.ip) || isCgnat(a.ip))
  const same = v4.some((a) => a.ip === pub)
  console.log(`\n  公网 IPv4 = ${pub}`)
  console.log(`  本机地址是内网/CGNAT：${localIsPrivate ? '是' : '否'}；` +
    `公网地址与网卡地址相同：${same ? '是' : '否'}`)
  console.log(`  → 能否被外面直接连进来：${same ? '可能是公网直连' : '**不能**（在 NAT 后面）'}`)
}

// ── ④ 链路吞吐 ──────────────────────────────────────────────

console.log('\n══ ④ 链路吞吐（这是"还能不能更快"的判据）═════════════\n')

/**
 * 从 Cloudflare 的测速端点下载固定字节数，返回 MB/s。
 * ⚠️ 只测一次、且下载量固定 —— 反复测会把用户的流量吃掉。
 */
async function download(bytes, label) {
  const url = `https://speed.cloudflare.com/__down?bytes=${bytes}`
  const t0 = Date.now()
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(60_000) })
    if (!r.ok) { console.log(`  ${label.padEnd(18)} HTTP ${r.status}`); return null }
    let got = 0
    for await (const chunk of r.body) {
      got += chunk.length
      if (Date.now() - t0 > 45_000) break        // 超时就停，别无限下载
    }
    const secs = (Date.now() - t0) / 1000
    const mbs = got / MB / secs
    console.log(`  ${label.padEnd(18)} ${fmt(got / MB, ' MB')} / ${fmt(secs, ' s')} = ` +
      `**${fmt(mbs, ' MB/s')}**（${fmt(mbs * 8, ' Mbps')}）`)
    return mbs
  } catch (e) {
    console.log(`  ${label.padEnd(18)} ✗ ${e.cause?.code ?? e.name ?? e.message}`)
    return null
  }
}

// 小样本预热（TCP 慢启动 + TLS 握手不该算进稳态）
await download(2 * MB, '预热 2 MB')
const link1 = await download(16 * MB, '稳态 16 MB')
const link2 = await download(48 * MB, '稳态 48 MB')

console.log('\n══ 结论 ═══════════════════════════════════════════════\n')
const best = Math.max(link1 ?? 0, link2 ?? 0)
if (globalV6.length && traceV6?.ip) {
  console.log('  IPv6：✅ 有全局地址，且**能出网** —— 直连方案有实现价值')
} else if (globalV6.length) {
  console.log('  IPv6：⚠️ 有全局地址，但出网测试失败（有地址不一定通）')
} else {
  console.log('  IPv6：❌ 没有全局地址，直连方案现在做了也用不上')
}
if (best > 0) {
  console.log(`  链路：到 Cloudflare 稳态约 ${fmt(best, ' MB/s')}（${fmt(best * 8, ' Mbps')}）`)
  console.log('        中继模式的实测吞吐若已经贴住这个数，说明瓶颈是带宽而不是代码')
}
