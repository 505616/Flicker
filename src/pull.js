/**
 * 直接用闪传接收（`flicker recv <链接>`：Node 自己下载、校验、落盘）
 * ================================================================
 *
 * ── 这是什么 ──
 * 从前 `flicker recv <链接>` 只是 `openBrowser(link)`：把链接丢给浏览器，
 * 接收全程由**发送端发过来的那个网页**完成。于是"双方都装了程序"其实没有带来
 * 任何区别 —— 收文件那一侧永远是浏览器。
 *
 * 这个模块补上另一半：用**程序自己**当接收端。
 *   · 协议与页面那条路**完全一样**（PROTOCOL.md §7，一行密码学都不另写）：
 *     访问页面消费令牌 → `/api/session` 拿盐与清单密文 → `/api/auth/*` 双向认证
 *     → `/api/chunk?seq=` 逐块取 → 自己验块哈希 → 整文件哈希 → 落盘 → `/api/done`
 *   · 与浏览器那条路的区别只有两个：写盘由 Node 做（不占浏览器内存、路径规则走
 *     `src/path-safety.js` 的同一份实现），以及**证书信任是我们自己决定的**。
 *
 * ── 证书：为什么不能"闭眼连" ──
 * 发送端用的是**自签证书**，CA 只装在他那台机器上。浏览器那条路靠用户点
 * "高级 → 继续前往"过这一关；Node 没有这个按钮，所以必须由我们明确选一条：
 *
 *   ① **核对指纹**（默认）：发送端屏幕上会打印"证书指纹 a3f9c1d2"，
 *      这里连上去之后算出同一份 SHA-256，显示给用户、要他确认一致。
 *      这就是 SSH 第一次连接那套做法：不信 CA，信"两边看到的是同一张证书"。
 *   ② **`--fingerprint=<8 位>`**：脚本/自动化用，不提问，对不上就失败。
 *   ③ **`--insecure`**：明确放弃这一步（屏幕上必须打印这一事实与指纹）。
 *
 * ⚠️ 内容安全**不依赖**这一步：清单与每个块都是 AES-256-GCM（钥匙由密码派生），
 *    还有逐块哈希与整文件哈希。这一步挡的是"你连到了冒充对方地址的假服务"。
 *
 * ── 刻意没做的 ──
 * · **中继链接**（`https://<中继>/room/…#<房间>:<盐>`）不走这条路：那条链路的接收端
 *   在页面里（中继发页面、页面拉房间），要在这里重写等于再实现一遍传输层。
 *   更实际的原因：中继的证书是可信的，浏览器那条路本来就没有门槛。所以中继链接
 *   在这里会**明确告诉你用浏览器打开**，而不是假装支持。
 * · **并发预取**：这里是串行取块（简单、正确）。页面那条路有 6 块预取，
 *   是跨网络吞吐的关键；这条路先不搬 —— 先把"能用、能验"做对。
 */
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, stat } from 'node:fs/promises'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import path from 'node:path'
import { compareKeyOf } from './path-safety.js'
import { dedupePath, sanitizeRelPath } from './manifest.js'
// 半成品后缀只有一份定义（`src/upload-server.js`）—— 两条接收路径用同一个后缀，
// 用户看到 `.flicker-part` 就知道那是"没收完的"，不必记两个名字。
import { PART_SUFFIX } from './upload-server.js'
import {
  deriveKeys, deriveVerifier, openChunk, openManifest, receiverMac, senderMac, wipe,
} from './suite/flicker1.js'

/** 判据/测试用的错误类型：带 code 与 status，别让调用方去猜字符串 */
export class PullError extends Error {
  constructor(message, code, status = null) {
    super(message)
    this.name = 'PullError'
    this.code = code
    this.status = status
  }
}

/**
 * 解析对方给的链接。
 *
 * 只认**直连**那条路：`https://<地址>:<端口>/?k=<一次性令牌>`。
 * 中继链接是 `https://<中继>/room/<房间>#<盐>` —— 它的接收端在页面里（见文件头），
 * 所以这里**明确拒绝并说清怎么办**，而不是收下之后在别处炸。
 *
 * @returns {{kind:'direct', base:string, token:string, secure:boolean}
 *          | {kind:'relay'|'unsupported', reason:string}}
 */
export function parseRecvLink(link) {
  let url
  try {
    url = new URL(String(link ?? ''))
  } catch {
    return { kind: 'unsupported', reason: '这不像一个链接（要以 http:// 或 https:// 开头）' }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { kind: 'unsupported', reason: `不认识的协议：${url.protocol}` }
  }
  // 中继链接：路径是 /room/<64 位房间号>，参数在 fragment 里
  if (/^\/room\/[0-9a-f]{64}$/i.test(url.pathname) || url.hash.length > 5) {
    return {
      kind: 'relay',
      reason: '这是**中继链接**：它的接收端是页面（中继把页面发给你，页面去房间里取）。' +
        '请用浏览器打开它 —— 加 `--browser` 或者直接把链接粘到浏览器里。',
    }
  }
  const token = url.searchParams.get('k') ?? ''
  if (!token) {
    return { kind: 'unsupported', reason: '链接里没有一次性令牌（`?k=` 后面那一串）—— 是不是少复制了一段？' }
  }
  const base = `${url.protocol}//${url.host}`
  return { kind: 'direct', base, token, secure: url.protocol === 'https:' }
}

/**
 * 一个够用的 HTTP 客户端：自己钉住证书指纹，按需解析 JSON。
 *
 * 为什么不用 `fetch`：这里需要"连上去之后**看一眼对端的证书**（DER）再决定"，
 * 以及把这条连接**钉死**（同一张证书）。`fetch` 拿不到 DER，也不给这个控制点。
 */
function makeClient({ base, pinnedSha256 = null, timeoutMs = 60_000 }) {
  // ⚠️ 只对 https 建 Agent：给 `http.request` 传一个 https.Agent 会直接抛错
  const agent = base.startsWith('https:')
    ? new HttpsAgent({ keepAlive: true, maxSockets: 1, rejectUnauthorized: false })
    : undefined

  /** 逐次核对：keep-alive 复用的是同一条连接，但新连接必须重新核一遍 */
  const verifyPeer = (res) => {
    if (!pinnedSha256) return
    const cert = res.socket.getPeerCertificate?.()
    if (!cert || !cert.raw) throw new PullError('拿不到对端证书', 'NO_PEER_CERT')
    const got = sha256Hex(cert.raw)
    if (got !== pinnedSha256) {
      throw new PullError(
        `对端证书变了（期望 ${pinnedSha256.slice(0, 8)}…，实际 ${got.slice(0, 8)}…）—— ` +
        '可能是有人中途冒充了对方的地址，已停止。', 'FINGERPRINT_CHANGED')
    }
  }

  const request = function request(reqPath, { method = 'GET', json = null, body = null } = {}) {
    const url = new URL(base + reqPath)
    const doRequest = url.protocol === 'https:' ? httpsRequest : httpRequest
    return new Promise((resolve, reject) => {
      const headers = {}
      let payload = body
      if (json !== null) {
        payload = Buffer.from(JSON.stringify(json), 'utf8')
        headers['Content-Type'] = 'application/json'
      }
      if (payload) headers['Content-Length'] = payload.length
      const req = doRequest(url, { method, headers, agent, timeout: timeoutMs }, (res) => {
        try { verifyPeer(res) } catch (e) { req.destroy(); reject(e); return }
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const buf = Buffer.concat(chunks)
          resolve({ status: res.statusCode, headers: res.headers, body: buf })
        })
        res.on('error', reject)
      })
      req.on('timeout', () => req.destroy(new PullError('对方太久没有响应', 'TIMEOUT')))
      req.on('error', reject)
      if (payload) req.write(payload)
      req.end()
    })
  }
  // keep-alive 的连接必须显式关掉：否则 CLI 收完之后进程还挂着（socket 让它"有事可做"），
  // 用户在终端看到的就是"传完了但命令不返回"。2026-10 在 CI 上排查卡住时想到的这条。
  request.close = () => { try { agent?.destroy() } catch { /* 尽力而为 */ } }
  return request
}

export const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex')

/**
 * 连上去、把对端证书的 SHA-256 算出来（**这一步不做任何信任决定**）。
 * 后面的决定由调用方看着指纹做。
 */
export async function probePeer({ base, timeoutMs = 15_000 }) {
  const url = new URL(base + '/api/health')
  if (url.protocol !== 'https:') return { sha256: null, secure: false }
  const agent = new HttpsAgent({ keepAlive: false, rejectUnauthorized: false })
  return new Promise((resolve, reject) => {
    const done = (fn, arg) => { try { agent.destroy() } catch { /* 尽力而为 */ } fn(arg) }
    const req = httpsRequest(url, { method: 'GET', agent, timeout: timeoutMs }, (res) => {
      const cert = res.socket.getPeerCertificate?.()
      res.resume()
      if (!cert?.raw) { done(reject, new PullError('拿不到对端证书', 'NO_PEER_CERT')); return }
      done(resolve, { sha256: sha256Hex(cert.raw), secure: true })
    })
    req.on('timeout', () => req.destroy(new PullError('对方太久没有响应（是不是已经关掉了？）', 'TIMEOUT')))
    req.on('error', (e) => done(reject, new PullError(
      `连不上 ${base}：${e?.code === 'ECONNREFUSED' ? '对方没在监听（程序是不是已经关了？）' : (e?.message ?? e)}`,
      'CONNECT')))
    req.end()
  })
}

/**
 * 认证并拿到 SID + 解密后的清单。
 *
 * 步骤与协议文档 §7 一一对应，顺序也有讲究：**先访问一次页面**消费一次性令牌
 * （`/api/session` 只认已消费的令牌 —— 这是"一次性链接"的落点）。
 */
export async function openPullSession({ client, token, password, ui = null }) {
  // ① 消费一次性令牌（浏览器那条路是"打开页面"，这里是同一个动作的 HTTP 形态）
  const page = await client(`/?k=${encodeURIComponent(token)}`)
  if (page.status === 410) throw new PullError('这个链接已经被用过了（一次性链接）', 'TOKEN_USED', 410)
  if (page.status !== 200) {
    throw new PullError(`打开链接失败：HTTP ${page.status}`, 'TOKEN_INVALID', page.status)
  }

  // ② 会话参数（盐 + 清单密文）
  const info = await client(`/api/session?k=${encodeURIComponent(token)}`)
  if (info.status !== 200) {
    const e = safeJson(info)
    throw new PullError(e?.message ?? `取会话参数失败：HTTP ${info.status}`, e?.error ?? 'SESSION', info.status)
  }
  const params = safeJson(info)
  const salt = Buffer.from(params.salt, 'base64')
  const keys = deriveKeys(deriveVerifier(password, salt))

  // ③ 挑战
  const start = await client(`/api/auth/start?k=${encodeURIComponent(token)}`, { method: 'POST' })
  if (start.status !== 200) throw new PullError(`取挑战失败：HTTP ${start.status}`, 'AUTH_START', start.status)
  const { challenge, macProfiles } = safeJson(start)
  const cbuf = Buffer.from(challenge, 'base64')
  // 降级保护：对方报价里有 v2 就用 v2（把套件 id 绑进被认证的材料）
  const profile = Array.isArray(macProfiles) && macProfiles.includes('v2') ? 'v2' : 'v1'
  const mac = receiverMac(keys.auth, cbuf, { profile }).toString('base64')

  // ④ 完成认证：我们证明知道密码，对方也必须证明
  const fin = await client('/api/auth/finish', {
    method: 'POST', json: { challenge, mac, macProfile: profile },
  })
  const finBody = safeJson(fin)
  if (fin.status !== 200) {
    const code = finBody?.error ?? 'AUTH'
    const hint = code === 'BAD_PASSWORD' ? '密码不一致 —— 确认双方输入的是同一个密码（区分大小写）' : (finBody?.message ?? '')
    throw new PullError(hint || `认证失败：HTTP ${fin.status}`, code, fin.status)
  }
  const expected = senderMac(keys.auth, cbuf, { profile }).toString('base64')
  if (finBody.mac !== expected) {
    throw new PullError('对方未能证明它知道密码 —— 已中止（对方可能是冒充的，或版本不一致）', 'PEER_AUTH')
  }
  const sid = finBody.sid
  if (!sid) throw new PullError('对方没有给会话 ID（SID）', 'NO_SID')

  // ⑤ 清单：拿到的是密文，钥匙在我们手里
  const mf = await client(`/api/manifest?sid=${encodeURIComponent(sid)}`)
  if (mf.status !== 200) {
    throw new PullError(`取清单失败：HTTP ${mf.status}`, safeJson(mf)?.error ?? 'MANIFEST', mf.status)
  }
  const wireRaw = safeJson(mf)
  let wire
  try {
    const plain = openManifest(keys.enc,
      Buffer.from(wireRaw.iv, 'base64'), Buffer.from(wireRaw.ct, 'base64'),
      Buffer.from(wireRaw.tag, 'base64'))
    wire = JSON.parse(plain.toString('utf8'))
  } catch {
    throw new PullError('清单解不开（密码不对，或清单被改过）', 'BAD_MANIFEST')
  }
  if (!Array.isArray(wire?.files) || !wire.files.length) {
    throw new PullError('清单里没有文件', 'EMPTY_MANIFEST')
  }
  if (ui) ui.info(`清单已解密：${wire.files.length} 个文件 · ${wire.totalBytes ?? 0} 字节（逐块校验）`)
  return { sid, keys, wire, profile, chunkBytes: params.chunkBytes }
}

/** 把清单里的相对路径过一遍安全规则；任何一条不过就**整场拒绝**（一个字节都不写） */
export function checkManifestPaths(wire) {
  const seen = new Map()
  const out = []
  for (const f of wire.files) {
    const raw = String(f.rel ?? '')
    let rel
    try {
      rel = sanitizeRelPath(raw)
    } catch (e) {
      throw new PullError(
        `清单里的路径不安全：${raw}（${e?.message ?? e}）—— 一个字节都没有写入`, 'E_PATH_UNSAFE')
    }
    const key = compareKeyOf(rel)
    if (seen.has(key)) {
      throw new PullError(
        `清单里有两个路径会落到同一个文件：${seen.get(key)} 与 ${rel} —— ` +
        '继续写会静默覆盖掉一个，已停止（一个字节都没有写入）', 'E_MANIFEST_DUPLICATE_PATH')
    }
    seen.set(key, rel)
    out.push({ ...f, rel })
  }
  return out
}

/**
 * 取一个文件的所有块、验块哈希、写进 `.flicker-part`，最后验整文件哈希再改名。
 *
 * @returns {Promise<{rel:string, finalRel:string, bytes:number, ok:boolean, reason?:string}>}
 */
async function pullFile({ client, sid, keys, file, fi, dir, taken, ui, onBytes }) {
  const wanted = file.rel
  const existingKey = compareKeyOf(wanted)
  let finalRel = wanted
  let renamed = false
  if (taken.has(existingKey) || await existsOnDisk(dir, wanted)) {
    // ⚠️ 默认**绝不覆盖**：改名并把"原来叫什么"说出来（与接收模式 `/up/*` 的默认一致）
    const set = new Set([...taken, existingKey])
    finalRel = dedupePath(wanted, set)
    renamed = true
  }
  taken.add(compareKeyOf(finalRel))
  if (renamed && ui) ui.warn(`「${wanted}」在磁盘上已存在，改存为「${finalRel}」（不覆盖）`)

  const finalPath = path.join(dir, finalRel)
  const partPath = finalPath + '.flicker-part'
  await mkdir(path.dirname(finalPath), { recursive: true })

  const out = createWriteStream(partPath)
  const whole = createHash('sha256')
  let bytes = 0
  try {
    for (let ci = 0; ci < file.chunks; ci++) {
      const seq = (Number.isInteger(file.firstChunk) ? file.firstChunk : 0) + ci
      const r = await client(`/api/chunk?seq=${seq}&sid=${encodeURIComponent(sid)}`)
      if (r.status !== 200) {
        const e = safeJson(r)
        throw new PullError(
          `取第 ${seq} 块失败：HTTP ${r.status}${e?.message ? ` — ${e.message}` : ''}`,
          e?.error ?? 'CHUNK', r.status)
      }
      const tag = Buffer.from(String(r.headers['x-flicker-tag'] ?? ''), 'base64')
      const plainLen = Math.min(file.chunkBytes, file.size - ci * file.chunkBytes)
      let plain
      try {
        plain = openChunk(keys.enc, fi, ci, file.chunks, r.body, tag, plainLen)
      } catch {
        throw new PullError(`第 ${seq} 块解密失败（数据被改过或损坏），已中止；这一块没有写盘`, 'DECRYPT')
      }
      if (plain.length !== plainLen) {
        throw new PullError(`第 ${seq} 块长度不符（期望 ${plainLen}，实际 ${plain.length}）`, 'LENGTH')
      }
      if (Array.isArray(file.chunkHashes) && file.chunkHashes[ci]) {
        if (sha256Hex(plain) !== file.chunkHashes[ci]) {
          throw new PullError(`第 ${seq} 块哈希不符（内容与清单不一致），已中止`, 'CHUNK_HASH')
        }
      }
      whole.update(plain)
      bytes += plain.length
      await new Promise((resolve, reject) => out.write(plain, (e) => (e ? reject(e) : resolve())))
      onBytes?.(plain.length)
      ui?.progress?.(bytes, file.size)
    }
  } finally {
    await new Promise((resolve) => out.end(resolve))
  }

  if (file.sha256) {
    const got = whole.digest('hex')
    if (got !== file.sha256) {
      // 半成品**故意留下**：一眼能认出来，也不污染正常文件（与接收模式一致）
      throw new PullError(
        `「${finalRel}」整文件校验失败（期望 ${file.sha256.slice(0, 16)}…，实际 ${got.slice(0, 16)}…）；` +
        `半成品留在 ${path.basename(partPath)}`, 'HASH')
    }
  }
  await rename(partPath, finalPath)
  return { rel: wanted, finalRel, bytes, ok: true }
}

async function existsOnDisk(dir, rel) {
  try {
    await stat(path.join(dir, rel))
    return true
  } catch { return false }
}

/**
 * 主流程：从链接收完一整场。
 *
 * @param {object} o
 * @param {string} o.link 对方给的链接
 * @param {string} o.password 一次性密码
 * @param {string} o.dir 存到哪个目录
 * @param {string} [o.pinnedSha256] 已确认过的证书指纹（不传就现探）
 * @param {object} [o.ui] tty 界面（可选）
 * @param {(n:number)=>void} [o.onBytes] 每收下一块回调一次（图形界面/测试用）
 * @param {(info:object)=>void} [o.onFile] 每个文件结束时回调
 * @returns {Promise<{ok:boolean, dir:string, files:object[], failed:object[], bytes:number}>}
 */
export async function pullFromLink(o = {}) {
  const { link, password, dir: outDir } = o
  const ui = o.ui ?? null
  if (!link) throw new PullError('没有链接', 'NO_LINK')
  if (!password) throw new PullError('没有密码', 'NO_PASSWORD')
  if (!outDir) throw new PullError('没有保存目录', 'NO_DIR')

  const parsed = parseRecvLink(link)
  if (parsed.kind !== 'direct') {
    throw new PullError(parsed.reason, parsed.kind === 'relay' ? 'RELAY_LINK' : 'BAD_LINK')
  }

  const client = makeClient({ base: parsed.base, pinnedSha256: o.pinnedSha256 ?? null })
  await mkdir(outDir, { recursive: true })

  const { sid, keys, wire, profile } = await openPullSession({
    client, token: parsed.token, password, ui,
  })
  const files = checkManifestPaths(wire)
  if (profile === 'v1' && ui) {
    ui.warn('对方的程序较旧（握手用的旧格式）：本次传输正常，但"防套件降级"对这次会话不成立')
  }

  const taken = new Set()
  const done = []
  const failed = []
  let totalBytes = 0
  try {
    for (let fi = 0; fi < files.length; fi++) {
      const file = files[fi]
      ui?.step(`接收中：${file.rel}`)
      try {
        const r = await pullFile({
          client, sid, keys, file, fi, dir: outDir, taken, ui,
          onBytes: (n) => { totalBytes += n; o.onBytes?.(n) },
        })
        ui?.progressDone?.()
        ui?.ok?.(`${r.finalRel}  ${r.bytes} 字节 · 校验通过`)
        done.push(r)
        o.onFile?.(r)
      } catch (e) {
        ui?.progressDone?.()
        failed.push({ rel: file.rel, reason: e?.message ?? String(e) })
        ui?.error?.(`${file.rel}：${e?.message ?? e}`)
        o.onFile?.({ rel: file.rel, ok: false, reason: e?.message })
      }
    }

    // 告诉对方"收完了" → 发送端据此销毁（它不会自己先销毁，这是协议里的完成判据）
    const fin = await client(`/api/done?sid=${encodeURIComponent(sid)}`, { method: 'POST' })
    if (fin.status !== 200) {
      ui?.warn?.(`通知对方"已完成"时收到 HTTP ${fin.status}（不影响本地文件，对方可能会多等一会儿）`)
    }
  } finally {
    wipe(keys?.enc, keys?.auth, keys?.room)
    client.close?.()
  }

  return { ok: failed.length === 0, dir: outDir, files: done, failed, bytes: totalBytes }
}

/** 解析响应体里的 JSON（解析不了就返回 null，绝不抛错） */
function safeJson(r) {
  try { return JSON.parse(r.body.toString('utf8')) } catch { return null }
}

/** 供测试/工具用：算一张 DER 证书的 SHA-256 */
export function certFingerprint(der) {
  return sha256Hex(der)
}

/**
 * 核对用户给的指纹（发送端屏幕上那 8 位，或完整的 64 位）。
 *
 * 比的是**前缀**、不分大小写：屏幕上只显示前 8 位，让人把 64 位全打一遍不现实，
 * 而 8 位（32 bit）在一次会话里够用 —— 前提本来就是"你看着对方的屏幕核对"。
 */
export function matchFingerprint(actualSha256, expected) {
  const want = String(expected ?? '').replace(/[^0-9a-f]/gi, '').toUpperCase()
  if (!want) return false
  return String(actualSha256).toUpperCase().startsWith(want)
}


