// 探测：这台机器到底有没有可用的公网 IPv6（决定"IPv6 直连"这条路今天能不能谈）
// ============================================================================
// 背景：项目里 IPv6 直连的代码在，但一直标注"没有网络条件验证"（本机无全局 IPv6）。
// 这个脚本把"有没有"这件事查清楚，结论可以写进文档，而不是继续猜。
//
// 两类检查：
//   ① 本机有没有**全局** IPv6 地址（fe80:: 是链路本地，不算；家里的路由器可能给 /64）
//   ② 能不能**出去**（访问只提供 IPv6 的接口）—— 有地址但出不去也很常见
//
// 用法：node _lab/probe-ipv6.mjs
import { networkInterfaces } from 'node:os'

console.log('① 本机的 IPv6 地址')
const all = []
for (const [name, list] of Object.entries(networkInterfaces())) {
  for (const a of list ?? []) {
    if (a.family === 'IPv6' || a.family === 6) {
      const kind = a.address.startsWith('fe80:') ? '链路本地（不能用来对外）'
        : a.address.startsWith('fc') || a.address.startsWith('fd') ? '唯一本地（内网）'
          : a.address === '::1' ? '回环'
            : '**全局**（可能可用于直连）'
      all.push({ name, address: a.address, kind, scopeid: a.scopeid ?? null })
    }
  }
}
if (!all.length) console.log('  （一个 IPv6 地址都没有）')
for (const a of all) console.log(`  ${a.name}: ${a.address}  ${a.kind}`)
const global6 = all.filter((a) => a.kind.startsWith('**'))
console.log(`  → 全局 IPv6：${global6.length ? '有 ' + global6.length + ' 个' : '**没有**'}`)

console.log('\n② 能不能用 IPv6 出去（只连 IPv6 的接口）')
const targets = [
  ['https://api6.ipify.org/', 'ipify（只走 IPv6）'],
  ['https://v6.ident.me/', 'ident.me（只走 IPv6）'],
]
for (const [url, label] of targets) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(12000) })
    const t = (await r.text()).trim()
    console.log(`  ✓ ${label} → HTTP ${r.status}  出口 IPv6 = ${t.slice(0, 60)}`)
  } catch (e) {
    console.log(`  ✗ ${label} → ${e?.cause?.code ?? e?.name ?? e?.message ?? e}`)
  }
}

console.log('\n③ 顺带看看 IPv4 的出口（作对照）')
try {
  const r = await fetch('https://api.ipify.org/', { signal: AbortSignal.timeout(12000) })
  console.log(`  ✓ 出口 IPv4 = ${(await r.text()).trim()}`)
} catch (e) {
  console.log(`  ✗ ${e?.cause?.code ?? e?.name ?? e?.message ?? e}`)
}

console.log('\n结论怎么写')
if (!global6.length) {
  console.log('  · 本机**没有全局 IPv6** → "IPv6 直连"在你这条宽带上今天不可能，')
  console.log('    代码留着可以，但文档要继续标"本机无网络条件验证"。')
} else {
  console.log('  · 本机有全局 IPv6 —— 下一步要验的是**入站**：路由器/防火墙放不放行、')
  console.log('    手机（走移动数据）能不能连上这个地址。那一步必须手机配合实测。')
}
