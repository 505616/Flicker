/**
 * 局域网 HTTPS 传输服务
 * ====================
 *
 * 遵守 架构决策.md §4.3 的顺序约束：
 *   生成证书 → 自检 → 清理残留 → 装入信任库 → 监听 → 就绪探测 → （GUI 才开窗口）
 *
 * 关键实现点：
 *  - 分块按需加密：只在被请求时才读盘、加密、发出，读完即清零缓冲
 *  - 全程不写临时文件
 *  - 所有退出路径都走 shutdown()，确保密钥清零与服务关闭
 */
import { createServer, request } from 'node:https'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { open } from 'node:fs/promises'
import { sealChunk, chunkIV, PARAMS } from './suite/flicker1.js'
import { Session, SessionError, errorBody, PHASE } from './session.js'

/** 把接收端的 User-Agent 变成一句人话，显示在终端上 */
export function describeUA(ua = '') {
  const tests = [
    [/Edg\/([\d.]+)/, 'Edge'], [/OPR\/([\d.]+)/, 'Opera'], [/Chrome\/([\d.]+)/, 'Chrome'],
    [/Firefox\/([\d.]+)/, 'Firefox'], [/Version\/([\d.]+).*Safari/, 'Safari'],
  ]
  for (const [re, name] of tests) {
    const m = ua.match(re)
    if (m) return `${name} ${m[1].split('.')[0]}`
  }
  return ua ? ua.slice(0, 30) : '未知浏览器'
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

/**
 * 把探测失败的错误码分成"证书问题"与"连不上"两类。
 *
 * ⚠️ 这个区分是必要的，不是为了好看：两类故障的**修法完全相反**。
 *    证书问题（本机拿会话 CA 都验不过）意味着接收端一定也连不上，
 *    这时去查防火墙是白费功夫；反之连不上时去查证书也是白费功夫。
 *    旧提示只有一句"若对方连不上，请检查防火墙设置" ——
 *    遇到证书故障时它会把用户引到错误的方向。
 */
function classifyProbeError(code) {
  // 证书/握手类：Node 的 TLS 错误码，以及主机名不匹配
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|ALTNAME|DEPTH_ZERO|HANDSHAKE/i.test(code)) {
    return 'cert'
  }
  return 'connect'
}

export class TransferServer {
  /**
   * @param {object} o
   * @param {Session} o.session
   * @param {object} o.manifest 线上形式的清单（已含 sha256 等）
   * @param {(evt:object)=>void} o.onEvent
   * @param {string} o.receiverHtml 接收端页面内容
   */
  constructor({ session, manifest, onEvent, receiverHtml, limiter }) {
    this.session = session
    this.manifest = manifest
    this.onEvent = onEvent
    this.receiverHtml = receiverHtml
    /** 可选的发送限速器（src/rate.js）。不传 = 不限速 */
    this.limiter = limiter ?? null
    this.server = null
    this.port = null
    this.sockets = new Set()
    // 常驻的分块缓冲区：复用同一个，避免大文件时产生大量垃圾对象。
    //
    // ⚠️ 大小必须按**清单里实际用到的最大块**来算，不能写死 `PARAMS.chunkBytes`：
    //    `chunkBytes` 是逐文件字段（线上格式允许它不等于协议默认值 ——
    //    见 prepare.js 的说明）。写死的话，块比默认值大时
    //    `fh.read(this._buf, 0, file.chunkBytes, …)` 会**静默截断**，
    //    症状是"大块传到一半文件就坏了"，而没有任何一处报错。
    const maxChunk = Math.max(PARAMS.chunkBytes,
      ...(manifest?.files ?? []).map((f) => Number(f.chunkBytes) || 0))
    this._buf = Buffer.allocUnsafe(maxChunk)
    this._closing = false
  }

  /**
   * 启动监听。⚠️ 必须在证书装好之后调用（约束 3）
   *
   * 不传 `pfx` / `key` 时使用**明文 HTTP**。
   * 这个分支只用于测试：路由与令牌语义跟传输层加密无关，
   * 用 HTTP 测就不需要造一张证书（少一层易错的手工编码，也更快）。
   * **生产路径永远传证书** —— 局域网接收端必须走 HTTPS，
   * 否则浏览器不提供 crypto.subtle，接收端根本无法解密。
   */
  async listen({ pfx, passphrase, key, cert, host = '0.0.0.0', port = 0 } = {}) {
    const handler = (req, res) => {
      this._handle(req, res).catch((err) => {
        const { status, body } = errorBody(err)
        if (!res.headersSent) {
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(body))
        } else res.end()
      })
    }
    const secure = Boolean(pfx || (key && cert))
    this.server = secure ? createServer({ pfx, passphrase, key, cert }, handler) : createHttpServer(handler)
    this.secure = secure

    // 跟踪连接，销毁时要能强制断开 —— 否则 shutdown 会一直等到对方超时
    this.server.on('connection', (sock) => {
      this.sockets.add(sock)
      sock.on('close', () => this.sockets.delete(sock))
    })

    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, host, () => {
        this.server.removeListener('error', reject)
        this.port = this.server.address().port
        resolve()
      })
    })
    return this.port
  }

  /**
   * 约束 3b：就绪探测。
   * 必须确认服务真的能返回响应，才允许打开浏览器窗口 ——
   * 否则 --app=<url> 会导航到一个 ERR_CONNECTION_REFUSED 错误页，且不会自动重试。
   *
   * ⚠️ 这里有两个踩过的坑，别改回去：
   *   1. **不能用 fetch 探测自己**。Node 的 fetch 不信任我们那张自签证书，
   *      会抛 SELF_SIGNED_CERT_IN_CHAIN，让探测白等一整个超时（实测 8 秒），
   *      并且报出"就绪探测未通过"这句会让用户以为出错的话 —— 而服务其实是好的。
   *      正确做法是用 node:https 并显式传入本次会话的 CA。
   *   2. **ca 必须是 PEM 文本**，给 DER Buffer 同样会报 SELF_SIGNED_CERT_IN_CHAIN。
   *
   * @param {string} url 要探测的地址（通常是给本机看的 https://127.0.0.1:port/）
   * @param {object} opts
   * @param {Buffer} [opts.caDer] 本次会话的 CA（DER），会转成 PEM 后用于校验
   * @param {number} [opts.timeoutMs]
   * @returns {Promise<{ok:boolean, attempts:number, detail:string, reason:'ok'|'cert'|'connect'|'http'}>}
   *
   * ⚠️ 这个函数顺带承担了"约束 1：证书自检"的**最终判据**：
   *    它用 `rejectUnauthorized: true` + 本次会话的 CA 去连**真实运行中的服务**，
   *    走的正是浏览器要走的每一步（验签名链、验主机名、验有效期）。
   *    比 session-cert-check.mjs 里那个临时服务器更强 —— 连的是真货。
   *    所以这里**不再**额外跑一次 handshakeSelfCheck：那是同一个握手做两遍，
   *    多花时间但不多任何信息。`handshakeSelfCheck` 留给测试与诊断用。
   */
  async waitReady(url, { caDer, timeoutMs = 5000 } = {}) {
    // ⚠️ 安全模式下**必须**给 CA。
    //    不给 CA 时 `rejectUnauthorized` 只能置 false，于是这个"就绪探测"
    //    会连一张坏证书也照收 —— 它会返回 ok:true，而浏览器那边照样报错。
    //    这正是本项目反复踩过的那类坑：一个**看起来在验证、其实没有验证**的检查
    //    （同类：探测带一次性令牌的页面，把令牌消费掉还报"就绪"）。
    //    所以这里直接拒绝，而不是降级成"能连上就算就绪"。
    if (this.secure && !caDer) {
      return {
        ok: false, attempts: 0, reason: 'nocert',
        detail: '未提供会话 CA —— 安全模式下就绪探测必须验证证书，否则等于没验证',
      }
    }
    const deadline = Date.now() + timeoutMs
    const u = new URL(url)
    // 把会话 CA 从 DER 转成 PEM —— tls 只认 PEM 文本
    const ca = caDer
      ? '-----BEGIN CERTIFICATE-----\n' +
        caDer.toString('base64').match(/.{1,64}/g).join('\n') +
        '\n-----END CERTIFICATE-----\n'
      : undefined
    // 明文模式（仅测试）用 http 请求；生产路径一定走 https
    const requester = this.secure ? request : httpRequest

    let attempts = 0, lastErr = '', reason = 'connect'
    while (Date.now() < deadline) {
      attempts++
      try {
        const status = await new Promise((resolve, reject) => {
          const req = requester({
            host: u.hostname, port: u.port || 443,
            path: u.pathname + u.search, method: 'GET',
            ca, rejectUnauthorized: ca !== undefined,
            timeout: 1500,
          }, (res) => {
            res.resume()                    // 丢弃响应体，只关心能否连上
            res.on('end', () => resolve(res.statusCode))
          })
          req.on('timeout', () => { req.destroy(new Error('超时')) })
          req.on('error', reject)
          req.end()
        })
        if (status < 500) return { ok: true, attempts, detail: `HTTP ${status}`, reason: 'ok' }
        lastErr = `HTTP ${status}`
        reason = 'http'
      } catch (e) {
        lastErr = e?.code ?? e?.message ?? String(e)
        reason = classifyProbeError(e?.code ?? '')
      }
      await new Promise((r) => setTimeout(r, 120))
    }
    return { ok: false, attempts, detail: lastErr, reason }
  }

  // ── 请求路由 ─────────────────────────────────────────────

  async _handle(req, res) {
    const url = new URL(req.url, `https://${req.headers.host ?? 'localhost'}`)
    const p = url.pathname
    const sid = url.searchParams.get('sid')
    const token = url.searchParams.get('k')

    // 安全响应头：这个页面不做任何外部请求
    //
    // ⚠️ `worker-src blob:` 是**必须**的，不是可选项：接收端把"整文件增量摘要"
    //    放进 Web Worker（它是主线程上最大的一笔 CPU，见 receiver.html 里的实测），
    //    而那个 Worker 是用 `URL.createObjectURL(new Blob([源码]))` 建的 ——
    //    没有这一条，CSP 会直接拦掉，页面只能退回主线程（功能不受影响，但慢一截）。
    //    `blob:` 仍然在**本页自己**的范围里，不引入任何外部来源。
    const sec = {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
        "img-src data:; connect-src 'self'; worker-src blob:; " +
        'form-action \'none\'; base-uri \'none\'',
    }

    // ⓪ 健康检查：**不需要令牌**，供启动时的就绪探测使用。
    //
    // ⚠️ 这个端点是必需的，不是可有可无的。
    //    最初的就绪探测直接去 GET 接收页的地址，而那个地址带着一次性令牌 ——
    //    于是"自检"这个动作自己把令牌消费掉了，真正的用户打开链接会看到
    //    "链接已失效"（HTTP 410）。而启动日志一切正常，极难排查。
    //    所以：**探测服务可用性，必须用一个不产生副作用的端点。**
    if (p === '/api/health') {
      res.writeHead(200, { ...sec, 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('ok')
      return
    }

    if (p === '/favicon.ico') { res.writeHead(204).end(); return }

    // ① 接收端页面（唯一需要令牌的地方）
    if (p === '/' || p === '/index.html') {
      this.session.consumeToken(token)
      this.session.notePeer(req)
      res.writeHead(200, { ...sec, 'Content-Type': MIME['.html'] })
      res.end(this.receiverHtml)
      return
    }

    // ② 会话参数（令牌认证）
    if (p === '/api/session') {
      if (!this.session.tokenConsumed) {
        // 允许在已消费令牌的同一会话内再次询问（比如页面刷新前）
        throw new SessionError('需要先打开接收页面', 'TOKEN_INVALID')
      }
      this._json(res, sec, 200, this.session.sessionInfo())
      return
    }

    // ③ 发起认证（无认证 —— 它就是用来认证的）
    if (p === '/api/auth/start') {
      if (!this.session.tokenConsumed) throw new SessionError('需要先打开接收页面', 'TOKEN_INVALID')
      this._json(res, sec, 200, this.session.startAuth())
      return
    }

    // ④ 完成认证（无认证，靠 MAC 自证）
    if (p === '/api/auth/finish') {
      const body = await this._readJson(req)
      // `macProfile` 是接收端**回执**它用了哪套 MAC 构造（降级保护，见 session.js）。
      // 可选字段：老页面不传 → 按 v1 处理并记下来供上层告警。
      this._json(res, sec, 200, this.session.finishAuth({
        mac: body.mac, challenge: body.challenge, macProfile: body.macProfile,
      }))
      return
    }

    // ⑤ 清单（SID 认证）—— 客户端拿到的是密文，密钥在它自己手里
    if (p === '/api/manifest') {
      this.session.requireSid(sid)
      const info = this.session.sessionInfo()
      this._json(res, sec, 200, info.manifest)
      return
    }

    // ⑥ 分块（SID 认证）—— 按需读盘、加密、发出
    if (p === '/api/chunk') {
      this.session.requireSid(sid)
      await this._sendChunk(url, res, sec)
      return
    }

    // ⑦ 全部完成
    if (p === '/api/done') {
      this.session.requireSid(sid)
      this.session.markDone()
      this._json(res, sec, 200, { ok: true })
      return
    }

    throw new SessionError('没有这个接口', 'NOT_FOUND')
  }

  _json(res, sec, status, obj) {
    const buf = Buffer.from(JSON.stringify(obj), 'utf8')
    res.writeHead(status, { ...sec, 'Content-Type': MIME['.json'], 'Content-Length': buf.length })
    res.end(buf)
  }

  async _readJson(req) {
    const chunks = []
    let total = 0
    for await (const c of req) {
      total += c.length
      if (total > 64 * 1024) throw new SessionError('请求体过大', 'NOT_FOUND')
      chunks.push(c)
    }
    if (!chunks.length) return {}
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
      throw new SessionError('请求体不是合法 JSON', 'NOT_FOUND')
    }
  }

  /**
   * 发送一个加密分块。
   * 客户端请求的是**全局块序号** seq（跨文件连续），这样断点续传只需一个数字。
   */
  async _sendChunk(url, res, sec) {
    const seq = Number(url.searchParams.get('seq'))
    if (!Number.isInteger(seq) || seq < 0 || seq >= this.manifest.totalChunks) {
      throw new SessionError(`块序号超出范围: ${seq}`, 'RANGE')
    }

    const { file, chunkIndex, plainLen } = this._locate(seq)

    // 内容来源有两种：磁盘文件，或内存缓冲（源码形态的赠品包）
    let plain
    let release = () => {}
    if (file._bytes) {
      plain = file._bytes.subarray(chunkIndex * file.chunkBytes,
        Math.min((chunkIndex + 1) * file.chunkBytes, file._bytes.length))
      if (plain.length !== plainLen) {
        throw new SessionError(`赠品包第 ${chunkIndex} 块长度不符`, 'INTERNAL')
      }
    } else {
      const fh = await open(file.absPath, 'r')
      try {
        const { bytesRead } = await fh.read(this._buf, 0, file.chunkBytes, chunkIndex * file.chunkBytes)
        if (bytesRead !== plainLen) {
          throw new SessionError(
            `文件在传输过程中被改动（${file.rel} 第 ${chunkIndex} 块：` +
            `期望 ${plainLen} 字节，实读 ${bytesRead}）`, 'INTERNAL')
        }
      } catch (e) { await fh.close(); throw e }
      release = () => fh.close()
    }

    try {
      const src = file._bytes ? plain : this._buf.subarray(0, plainLen)

      // 限速：在**加密之前**等，等的时候不占着明文缓冲。
      // 判据用 _closing（服务正在关闭 = 这次传输已经没意义了），
      // 免得关闭时还傻等一段限速。
      if (this.limiter) await this.limiter.take(plainLen, () => this._closing)

      const { ct, tag } = sealChunk(this.session.keys.enc, file.index, chunkIndex, file.chunks, src)

      res.writeHead(200, {
        ...sec,
        'Content-Type': 'application/octet-stream',
        'Content-Length': ct.length,
        'X-Flicker-Tag': tag.toString('base64'),
        'X-Flicker-File': String(file.index),
        'X-Flicker-Chunk': String(chunkIndex),
      })
      res.end(ct)

      this.session.recordSent(plainLen)
      this.onEvent({
        type: 'chunk',
        seq, fileIndex: file.index, fileName: file.rel, fileCount: this.manifest.files.length,
        bytes: plainLen, totalBytes: this.manifest.totalBytes,
        sentBytes: this.session.bytesSent,
      })
      // 明文缓冲用后立即清零 —— 发送端不保留任何明文副本
      if (!file._bytes) this._buf.subarray(0, plainLen).fill(0)
    } finally {
      await release()
    }
  }

  /** 全局块序号 → (文件, 文件内块号, 明文长度) */
  _locate(seq) {
    // 文件数量通常很小，线性扫描足够；若将来支持上万文件再改二分
    for (const file of this.manifest.files) {
      if (seq >= file.firstChunk && seq < file.firstChunk + file.chunks) {
        const chunkIndex = seq - file.firstChunk
        const plainLen = Math.min(file.chunkBytes, file.size - chunkIndex * file.chunkBytes)
        return { file, chunkIndex, plainLen: Math.max(0, plainLen) }
      }
    }
    throw new SessionError(`块序号无法定位: ${seq}`, 'RANGE')
  }

  // ── 关闭与销毁 ───────────────────────────────────────────

  /**
   * 关闭服务并强制断开所有连接。
   * 不做强制断开的话，keep-alive 连接会让 close() 一直挂着。
   */
  async shutdown() {
    if (this._closing) return
    this._closing = true
    this._buf?.fill(0)
    const srv = this.server
    if (!srv) return
    await new Promise((resolve) => {
      srv.close(() => resolve())
      for (const sock of this.sockets) {
        try { sock.destroy() } catch { /* 已经关了 */ }
      }
      this.sockets.clear()
      // 兜底：500ms 后无论如何都返回，避免卡住销毁流程
      setTimeout(resolve, 500).unref?.()
    })
    this.server = null
  }

  get listening() { return Boolean(this.server?.listening) }
}

export { PHASE }
