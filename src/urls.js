/**
 * 会话链接的构造（**发送端与接收模式共用一份**）
 * ================================================
 *
 * ── 为什么要单独一个模块 ──
 * 发送端（`run.js`）和接收模式（`recv.js`）都要造同一形状的东西：
 *   `https://<地址>:<端口>/?k=<一次性令牌>`
 * 从前两边各写一份（`buildUrls` / `buildRecvUrls`），**已经开始漂了** ——
 * 比如 IPv6 的方括号只有一份实现时，另一条路就会造出一个打不开的链接。
 * 这个项目反复吃过"两份实现必然漂移"的亏（见 `_lab/交接.md` 第 4 条），所以合成一份。
 *
 * ── 选主链接的顺序 ──
 *   IPv4 局域网地址 → IPv6 → 回环
 * 为什么不优先 IPv6：**对方不一定有 IPv6**。IPv4 局域网地址在同一个 WiFi 下总能通，
 * 而 IPv6 只是"如果两边都有，就能跨网络直连"的那条路。
 * 所有的候选都放在 `all` / `ipv6` 里，界面可以列出来让人自己选。
 */
import { isIP } from 'node:net'
import { urlHost } from './trust.js'

/**
 * @param {string[]} hosts 已经在监听的地址（不能包含没在监听的，否则链接是假的）
 * @param {number} port
 * @param {string} token
 * @param {'https'|'http'} [scheme] 测试会用 http（明文回环，见 `_lab/recv-selftest.mjs`）
 */
export function buildSessionUrls(hosts, port, token, scheme = 'https') {
  const k = encodeURIComponent(token)
  const mk = (h) => `${scheme}://${urlHost(h)}:${port}/?k=${k}`

  const v4 = hosts.filter((h) => isIP(h) === 4 && !h.startsWith('127.'))
  const v6 = hosts.filter((h) => isIP(h) === 6)
  // 回环永远用 IPv4：`127.0.0.1` 在所有平台上都通，而 `[::1]` 在禁用了 IPv6 的机器上不通。
  // 就绪探测与 `--machine` 的 `__READY__` 都走这一条，不能因为环境差异而失败。
  const primaryHost = v4[0] ?? v6[0] ?? '127.0.0.1'

  return {
    primary: mk(primaryHost),
    loopback: `${scheme}://127.0.0.1:${port}/?k=${k}`,
    all: hosts.map(mk),
    ipv6: v6.map(mk),
    /** 主链接用的主机（**不带**方括号，界面显示用；拼 URL 请用 primary/all） */
    host: primaryHost, port, token, scheme,
  }
}
