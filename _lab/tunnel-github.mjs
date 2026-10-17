/**
 * 一个只干一件事的本地隧道：把 github.com:443 转到**能连通的**那个 GitHub 地址
 * =====================================================================
 *
 * 为什么需要它（2026-10 实测：这台机器所在的网络）：
 *   · `api.github.com` / `codeload.github.com` 正常（HTTP 200）
 *   · 但 `github.com` 的默认解析地址（20.205.243.166）**443 连接超时**
 *   · 换一个 GitHub 官方地址（140.82.112.3）就 200
 *
 * 于是 git 的 push/fetch 全卡在"连不上 github.com"。改 hosts 要管理员权限、也不该为了
 * 一次推送去改系统文件 —— 所以在这里起一个**只监听 127.0.0.1** 的 CONNECT 隧道：
 *
 *   git  --(CONNECT github.com:443)-->  本进程  --(TCP)-->  <TUNNEL_TO>:443
 *
 * TLS 仍然由 git 自己跟 github.com 握手（SNI 与证书校验都在它那边，目标 IP 只是换了个入口），
 * 所以"换 IP"不会削弱任何校验：证书对不上，git 照样会拒绝。
 *
 * 用法：
 *   node _lab/tunnel-github.mjs --port=9090 --to=140.82.112.3
 *   git -c http.proxy=http://127.0.0.1:9090 push origin main
 */
import { createServer, connect } from 'node:net'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const PORT = Number(argOf('port', 9090))
const TO = argOf('to', '140.82.112.3')
const TO_PORT = Number(argOf('toPort', 443))

const server = createServer((client) => {
  let head = ''
  let connected = false

  const onData = (buf) => {
    if (connected) return
    head += buf.toString('latin1')
    if (!head.includes('\r\n\r\n')) return          // 等 CONNECT 请求头收完

    const firstLine = head.split('\r\n')[0]
    const m = firstLine.match(/^CONNECT\s+([^:\s]+):(\d+)\s+HTTP\/1\.[01]$/i)
    if (!m) {
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }
    // 只放行 github.com —— 这个隧道不是通用代理，别让它变成出口
    if (m[1].toLowerCase() !== 'github.com') {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }

    connected = true
    client.removeListener('data', onData)

    const upstream = connect(TO_PORT, TO, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head !== '') {
        const rest = head.slice(head.indexOf('\r\n\r\n') + 4)
        if (rest) upstream.write(Buffer.from(rest, 'latin1'))
      }
      // 双向管道；任何一边出错就两边都关，避免半开连接挂着
      client.pipe(upstream)
      upstream.pipe(client)
      client.on('error', () => upstream.destroy())
      upstream.on('error', () => client.destroy())
      client.on('close', () => upstream.destroy())
      upstream.on('close', () => client.destroy())
    })
    upstream.on('error', (e) => {
      if (!client.destroyed) client.end(`HTTP/1.1 502 Bad Gateway\r\n\r\n${e.message}`)
    })
    upstream.setTimeout(60000, () => { upstream.destroy(); client.destroy() })
  }

  client.on('data', onData)
  client.on('error', () => { /* 客户端自己断了就算了 */ })
  client.setTimeout(60000, () => client.destroy())
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`隧道就绪：http://127.0.0.1:${PORT}  →  github.com:443  =  ${TO}:${TO_PORT}`)
})

process.on('SIGTERM', () => server.close(() => process.exit(0)))
process.on('SIGINT', () => server.close(() => process.exit(0)))
