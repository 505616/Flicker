/**
 * 接收模式的会话与服务（电脑当接收方，手机上传）
 * ==============================================
 *
 * ── 和发送模式的关系 ────────────────────────────────────────
 * 密码核对、密钥派生、清单加密、分块的 IV/AAD 绑定 —— **全部同一套**（`src/suite/flicker1.js`
 * 与 `src/session.js`）。差别只有一个：**数据往哪个方向流**。
 *
 *   发送模式（`src/run.js` + `src/server.js`）：手机是接收端，用 `GET /chunk?seq=N` 一块块取
 *   接收模式（本文件）：手机是发送端，用 `PUT /up/chunk?f=&c=` 一块块推
 *
 * 所以这里**一行密码学代码都不复制**：验块用 `openChunk()`，解清单用 `openManifest()`，
 * 会话与降级保护用 `Session`（构造时传 `role: 'receiver'`）。
 *
 * ── 这个文件里真正新写的东西，是"收下来的字节怎么验、怎么写盘" ──
 *   ① 路径安全：每个 rel 过 `sanitizeRelPath`（与接收端页面同一套 12 条规则），
 *      而且**只允许单段文件名**（手机本来也只能选文件、选不了文件夹）；
 *   ② 先写 `<名字>.flicker-part`，整文件校验通过后才改名 —— 半途失败不会污染正常文件；
 *   ③ 清单先到：**开工前**就能查出"磁盘不够 / 文件太多 / 太大 / 重名"，而不是传到一半才失败；
 *   ④ 整文件摘要**在 finish 时按顺序重读 .part 算**，不依赖分块到达顺序（顺序错了也会被这一关抓住）。
 *
 * ⚠️ 本文件只到 HTTP 层：默认明文 HTTP（绑回环，供本机脚本扮演手机来验协议）。
 *    TLS、证书、局域网链接、二维码、销毁链接线在 `src/recv.js`（复用了 `src/run.js` 那套现成机制）。
 */
// ⚠️ 这两个名字与 `src/server.js` **保持同一套约定**：`createServer` 是 https 的，
//    `createHttpServer` 是 http 的。拼接式打包把所有模块放进同一个顶层作用域，
//    同一个名字绑到两个不同模块会被打包器直接拒绝 —— 与其各起各的别名，
//    不如全项目统一，读代码时也不会猜"这个 createServer 到底是哪个"。
import { createServer } from 'node:https'
import { createServer as createHttpServer } from 'node:http'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rename, rm, stat, statfs } from 'node:fs/promises'
import path from 'node:path'
import { Session, SessionError, errorBody } from './session.js'
import { openChunk, openManifest, PARAMS, wipe } from './suite/flicker1.js'
import { sanitizeRelPath, dedupePath } from './manifest.js'
// ⚠️ 一条消息的固定开销只有**一份**定义（`src/chunk-size.js`）。
//    从前这里另写了一个 17 —— 单跑没问题，打成一个文件时撞名（打包器拒绝构建）。
//    这类"重复定义"是这个项目明确要挡的东西：两份实现迟早会漂移。
import { MESSAGE_OVERHEAD } from './chunk-size.js'
import { EVENTS } from './plugin/events.js'

/** 默认上限（部署方/用户可以调） */
export const DEFAULT_LIMITS = Object.freeze({
  maxFiles: 5000,
  maxBytes: 200 * 1024 ** 3,                 // 200 GB
  /**
   * 单条消息（= 明文块 + 固定开销）的上限。
   *
   * ⚠️ 这里有两个容易搞混的数，客户端**不该自己去做减法**：
   *    · `maxChunkBytes`     —— 线上一条消息的上限（含 17 字节开销），协议里就这一个数；
   *    · `maxPlainChunkBytes`—— 明文块的上限（= 上一个减去开销），**清单里声明的 `chunkBytes` 受它约束**。
   *    之所以两个都报价（见 `/up/session` 的 `limits`）：手机页面要在建清单之前知道
   *    "一块最多能放多少明文"，让它去减一个只有实现才知道的 17 是不合理的 ——
   *    2026-10 真机演练里就是这么撞上的（页面按 `maxChunkBytes` 声明，服务端按 `+17` 拒绝）。
   * 默认 2 MiB 明文，与局域网发送端的块大小一致：块大一点，请求数就少一半，
   * 手机上（每一次往返都要唤醒射频）这个差别比桌面上明显得多。
   */
  maxChunkBytes: 2 * PARAMS.chunkBytes + MESSAGE_OVERHEAD,
  /** 连续多少个块验不过就中止整个会话（防止有人拿垃圾数据无限刷；正常抖动重传不会到这个数） */
  maxChunkFailures: 10,
})

/** 半成品文件的后缀 —— 一眼能认出来，也不会被当成正常文件 */
export const PART_SUFFIX = '.flicker-part'

/**
 * 接收模式的**端点表（方法 + 路径）** —— 单一来源。
 *
 * ⚠️ 为什么单独抽出来：`PROTOCOL.md` §7R 里有一张端点表，客户端是照着它写的。
 *    文档与实现各写一份的话，迟早出现"文档里有这个端点、程序里没有"
 *    （或反过来）—— 这种错误本机测试**全绿**，只有照文档写客户端的人会撞上。
 *    所以端点只在这里定义一次：`createReceiveSession` 按它拼路由，
 *    文档判据（`gen/check-recv-protocol-doc.mjs`）也按它比对文档。
 */
export const RECV_ROUTE_TABLE = Object.freeze([
  ['GET', '/'],
  ['POST', '/up/session'],
  ['POST', '/up/auth'],
  ['POST', '/up/manifest'],
  ['PUT', '/up/chunk'],
  ['GET', '/up/status'],
  ['POST', '/up/finish'],
])

/**
 * 接收模式**独有**的错误码 → HTTP 状态码。
 *
 * ⚠️ 为什么不在这张表里的码就是 500：握手/会话那几个码（`TOKEN_USED`、`BAD_PASSWORD`…）
 *    沿用 `session.js` 里那张**唯一**的表 —— 同一个码在两个地方给不同状态码，
 *    手机上就得靠猜。而**两边都没登记**的码（例如 `BAD_PROFILE`、`E_DOWNGRADE`）
 *    会落到 `errorBody()` 的兜底 500 —— 这是"实现缺陷"类的表现，不是设计。
 *    `PROTOCOL.md` §7R.10 那张表由 `gen/check-recv-protocol-doc.mjs` 按**本表 + 兜底**
 *    逐行核对：所以"文档里写 400、实现给 500"这种错误会被机器抓住。
 */
export const RECV_ERROR_STATUS = Object.freeze({
  BAD_MANIFEST: 400, EMPTY_MANIFEST: 400, BAD_CHUNK: 400,
  BAD_CHUNK_BYTES: 400, BAD_CHUNKS: 400, E_CHUNK_AUTH: 400,
  TOO_MANY_BAD_CHUNKS: 400, E_PATH_UNSAFE: 400, E_MANIFEST_DUPLICATE_PATH: 400,
  BODY_TOO_LARGE: 413, TOO_MANY_FILES: 413, TOO_MANY_BYTES: 413,
  MANIFEST_TWICE: 409, ALREADY_FINISHED: 409, INCOMPLETE: 409, NO_MANIFEST: 409,
  NO_SPACE: 507,
})

const b64 = (buf) => Buffer.from(buf).toString('base64')

/**
 * 建一个接收会话。
 *
 * @param {object} o
 * @param {string} o.dir 存到哪里（默认调用方传"下载目录"）
 * @param {string} [o.password] 一次性密码（电脑生成、手机输入）
 * @param {object} [o.limits] 见 `DEFAULT_LIMITS`
 * @param {(evt:object)=>void} [o.onEvent]
 * @param {(info:{rel:string, existing:string}) => Promise<'rename'|'overwrite'|'skip'>} [o.onCollision]
 *   同名文件怎么办 —— 由上层决定（命令行弹三选一、图形界面弹窗、`--no-ask` 一律改名）。
 *   默认**自动改名**（最安全，永不覆盖）。
 * @param {object} [o.plugins] 插件注册表（可选）。给了就按《插件.md》的"接收端进程平面"
 *   发事件；**插件出错不打断接收**（错误记进 `plugins.errors`，见 `emitAsyncSafe`）。
 * @param {object} [o.deps] 注入依赖，便于测试（`statfs`、`readFile` 之类）
 * @returns {{session:Session, handle:Function, state:object, close:Function, report:Function}}
 */
export function createReceiveSession({
  dir, password, limits = {}, onEvent, onCollision, pageHtml, plugins = null, deps = {},
} = {}) {
  const LIMITS = { ...DEFAULT_LIMITS, ...limits }
  const statfsImpl = deps.statfs ?? statfs

  const session = new Session({ password, onEvent, role: 'receiver' })

  /**
   * 给插件发一个事件（没有插件时是空操作）。
   *
   * ⚠️ 两个刻意的选择：
   *   ① 用 `emitAsyncSafe`：插件抛错**不打断接收**（对方正在推文件，让一个插件
   *      把这次传输弄失败，受害的只是想存照片的人）。错误会进 `plugins.errors`。
   *   ② **不 await 也不吞掉失败的 Promise**：这里逐条 await，是为了让事件的顺序
   *      与真实发生的顺序一致 —— 插件记审计日志时，"清单收到"必须排在"文件定稿"前面。
   */
  const emitP = (name, payload) => plugins?.emitAsyncSafe(name, payload)

  /** 只把必要信息交给插件：**密码与一次性令牌永远不进事件负载** */
  const peerInfo = (peer) => (peer
    ? { address: peer.address ?? null, userAgent: peer.userAgent ?? null }
    : null)

  /** 收下来的东西都记在这里（`files` 与清单里的下标一一对应） */
  const state = {
    dir,
    manifest: null,          // 解密后的清单
    accepted: [],            // [{ index, rel, size, chunks, chunkBytes, sha256, finalPath, partPath, handle, received:Uint8Array, receivedChunks, receivedBytes, renamedFrom }]
    skipped: [],             // [{ index, rel, reason }]
    totalChunks: 0,
    totalBytes: 0,          // 清单里"接受了的那部分"的总字节数（进度条的分母）
    receivedChunks: 0,
    receivedBytes: 0,
    chunkFailures: 0,
    finished: false,
    report: null,
  }

  const json = (res, status, obj) => {
    const body = JSON.stringify(obj)
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(body)
  }

  /**
   * 错误码 → HTTP 状态码。
   *
   * ⚠️ 两件事别搞混（第一版就在这里翻了车）：
   *   ① `errorBody(err)` 返回的是 **`{ status, body }` 这种自带状态码的包裹**
   *      （发送端那边一直这么用），不是 `{ error, message }` —— 直接塞进 json() 会得到
   *      `{"status":500,"body":{...}}` 这种嵌套的怪东西，客户端读 `error` 只会读到 undefined。
   *   ② 本文件**只登记接收模式独有的错误码**，握手/会话那几个码（TOKEN_USED、BAD_PASSWORD…）
   *      沿用 `session.js` 里那张**唯一**的表 —— 同一个码在两个地方给不同状态码，
   *      手机上就得靠猜。
   */
  function statusFor(err) {
    if (Number.isInteger(err?.status)) return err.status     // 调用方显式指定的最优先
    const own = RECV_ERROR_STATUS[err?.code]
    if (own) return own
    return errorBody(err).status                             // 其余沿用共享那张表（含 500 兜底）
  }

  const fail = (res, err) => json(res, statusFor(err), errorBody(err).body)

  /** 读请求体（有上限，避免有人拿超大 body 打我们） */
  async function readBody(req, maxBytes) {
    const chunks = []
    let total = 0
    for await (const c of req) {
      total += c.length
      if (total > maxBytes) {
        const e = new SessionError(`请求体过大（> ${maxBytes} 字节）`, 'BODY_TOO_LARGE')
        e.status = 413
        throw e
      }
      chunks.push(c)
    }
    return Buffer.concat(chunks)
  }

  /** 会话有效性：一切都要带 `X-Flicker-Sid` */
  function requireSid(req) {
    session.requireSid(String(req.headers['x-flicker-sid'] ?? ''))
  }

  /** 找一个可用的名字（不覆盖别人的东西）—— 复用接收端页面同一套判重规则 */
  function uniqueRel(rel, taken) {
    return dedupePath(rel, taken)
  }

  /** 目标文件在磁盘上是否已存在（含大小写/Unicode 归一化那套判重） */
  async function existsOnDisk(rel) {
    try {
      await stat(path.join(dir, rel))
      return true
    } catch { return false }
  }

  // ── 路由 ───────────────────────────────────────────────────

  /** `POST /up/session?k=<一次性令牌>` —— 发挑战，手机据此算 MAC */
  async function handleSession(req, res, url) {
    session.consumeToken(url.searchParams.get('k') ?? '')
    session.notePeer(req)
    await emitP(EVENTS.RECV_PEER, { peer: peerInfo(session.peer) })
    const a = session.startAuth()
    json(res, 200, {
      suite: 'FLICKER/1',
      salt: b64(session.salt),
      challenge: a.challenge,
      macProfiles: a.macProfiles,
      limits: {
        maxFiles: LIMITS.maxFiles,
        maxBytes: LIMITS.maxBytes,
        // 两个数都给：客户端按 `maxPlainChunkBytes` 决定"一块放多少明文"，
        // 不必知道线上还多了 17 字节开销（少一次"为什么我按报价声明还被拒"）
        maxChunkBytes: LIMITS.maxChunkBytes,
        maxPlainChunkBytes: LIMITS.maxChunkBytes - MESSAGE_OVERHEAD,
      },
    })
  }

  /** `POST /up/auth` —— 手机证明它知道密码；我们回自己的应答 */
  async function handleAuth(req, res) {
    const body = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}')
    const out = session.finishAuth({ mac: body.mac, challenge: body.challenge, macProfile: body.macProfile })
    await emitP(EVENTS.RECV_AUTH, { peer: peerInfo(session.peer), macProfile: session.macProfile ?? null })
    json(res, 200, out)
  }

  /**
   * `POST /up/manifest` —— 收加密清单，并且**在开工前**把所有能查的都查掉。
   * 体格式：iv(12) || tag(16) || 密文
   */
  async function handleManifest(req, res) {
    requireSid(req)
    if (state.manifest) throw new SessionError('清单已经收过了', 'MANIFEST_TWICE')
    const body = await readBody(req, 4 * 1024 * 1024)
    if (body.length < 28) throw new SessionError('清单太短，不是有效负载', 'BAD_MANIFEST')

    let wire
    try {
      const plain = openManifest(session.keys.enc, body.subarray(0, 12), body.subarray(28), body.subarray(12, 28))
      wire = JSON.parse(plain.toString('utf8'))
    } catch {
      // 解不开 = 密钥不对或清单被改过。与"密码不对"一样处理：中止并销毁。
      session.destroy()
      throw new SessionError('清单解密失败（密码不一致，或清单被篡改）', 'BAD_MANIFEST')
    }

    // ── 结构与上限 ──
    if (!wire || !Array.isArray(wire.files) || wire.files.length === 0) {
      throw new SessionError('清单里没有文件', 'EMPTY_MANIFEST')
    }
    if (wire.files.length > LIMITS.maxFiles) {
      throw new SessionError(`文件太多（${wire.files.length} > ${LIMITS.maxFiles}）`, 'TOO_MANY_FILES')
    }
    const totalBytes = wire.files.reduce((a, f) => a + (Number(f.size) || 0), 0)
    if (totalBytes > LIMITS.maxBytes) {
      throw new SessionError(
        `总量太大（${totalBytes} > ${LIMITS.maxBytes} 字节）`, 'TOO_MANY_BYTES')
    }

    // ── 路径安全：任何一条不符就**中止整个会话**（与接收端页面同一策略）──
    const seen = new Set()
    for (const f of wire.files) {
      const raw = String(f.rel ?? '')
      if (raw.includes('/') || raw.includes('\\')) {
        session.destroy()
        throw new SessionError(`文件名不允许带路径分隔符：${raw}`, 'E_PATH_UNSAFE')
      }
      let safe
      try {
        safe = sanitizeRelPath(raw)
      } catch (e) {
        session.destroy()
        throw new SessionError(`文件名不安全：${raw}（${e?.message ?? e}）`, 'E_PATH_UNSAFE')
      }
      const key = safe.normalize('NFC').toLowerCase()
      if (seen.has(key)) {
        session.destroy()
        throw new SessionError(`清单里有重名的文件：${safe}`, 'E_MANIFEST_DUPLICATE_PATH')
      }
      seen.add(key)
      f.rel = safe
      // 分块参数必须自洽：AAD 绑定了"总块数"与"最后一块的明文长度"，
      // 对不上就一定会验块失败 —— 与其传到一半才发现，不如现在拒绝。
      const cb = Number(f.chunkBytes)
      if (!Number.isInteger(cb) || cb <= 0 || cb + MESSAGE_OVERHEAD > LIMITS.maxChunkBytes) {
        throw new SessionError(
          `块大小不合法：${f.chunkBytes}（本机允许一块最多 ${LIMITS.maxChunkBytes - MESSAGE_OVERHEAD} 字节明文）`,
          'BAD_CHUNK_BYTES')
      }
      const wantChunks = Math.max(1, Math.ceil(Number(f.size) / cb))
      if (!Number.isInteger(f.chunks) || f.chunks !== wantChunks) {
        throw new SessionError(
          `分块数对不上：声明 ${f.chunks}，按 ${f.size} 字节 / ${cb} 字节一块应为 ${wantChunks}`, 'BAD_CHUNKS')
      }
    }

    // ── 磁盘空间：开工前查，不够就当场拒绝（附差多少）──
    let diskFree = null
    try {
      const st = await statfsImpl(dir)
      diskFree = Number(st.bavail) * Number(st.bsize)
    } catch { /* 查不到就不拦（有些文件系统不支持），下面按"能查到才判"处理 */ }
    if (diskFree !== null && diskFree < totalBytes * 1.1) {
      throw new SessionError(
        `磁盘空间不足：需要约 ${totalBytes} 字节（含 10% 余量），可用 ${diskFree} 字节`, 'NO_SPACE')
    }

    // ── 落盘准备：重名怎么处理（停下来问 / 自动改名 / 覆盖 / 跳过）──
    await mkdir(dir, { recursive: true })
    const taken = new Set()
    for (let i = 0; i < wire.files.length; i++) {
      const f = wire.files[i]
      const existing = await existsOnDisk(f.rel)
      const key = f.rel.normalize('NFC').toLowerCase()
      let rel = f.rel
      let renamedFrom = null
      if (existing || taken.has(key)) {
        // 先通知插件，再问上层 —— 插件**只观察**，"改名/覆盖/跳过"的决定权仍在用户手里
        await emitP(EVENTS.RECV_COLLISION, { rel: f.rel, existing: path.join(dir, f.rel) })
        const choice = onCollision
          ? await onCollision({ rel: f.rel, existing: path.join(dir, f.rel) })
          : 'rename'
        if (choice === 'skip') {
          state.skipped.push({ index: i, rel: f.rel, reason: '同名，按你的选择跳过' })
          continue
        }
        if (choice !== 'overwrite') {
          // ⚠️ 把"已经被占用的那个名字"先塞进 taken —— `dedupePath` 只在**名字已被占用**时
          //    才会去找 `x (1).ext`；不塞的话它会原样返回同一个名字，于是"改名"等于没改。
          taken.add(key)
          rel = uniqueRel(f.rel, taken)
          renamedFrom = rel === f.rel ? null : f.rel
        }
      }
      taken.add(rel.normalize('NFC').toLowerCase())
      state.accepted.push({
        index: i,
        rel,
        renamedFrom,
        size: Number(f.size),
        chunks: f.chunks,
        chunkBytes: Number(f.chunkBytes),
        sha256: typeof f.sha256 === 'string' ? f.sha256 : null,
        finalPath: path.join(dir, rel),
        partPath: path.join(dir, rel + PART_SUFFIX),
        handle: null,
        received: new Uint8Array(f.chunks),
        receivedChunks: 0,
        receivedBytes: 0,
      })
    }

    state.manifest = wire
    state.totalChunks = state.accepted.reduce((a, f) => a + f.chunks, 0)
    state.totalBytes = state.accepted.reduce((a, f) => a + f.size, 0)
    session.onEvent({
      type: 'manifest-received',
      files: state.accepted.length,
      skipped: state.skipped.length,
      totalBytes: state.accepted.reduce((a, f) => a + f.size, 0),
    })
    await emitP(EVENTS.RECV_MANIFEST, {
      files: state.accepted.length,
      skipped: state.skipped.length,
      totalBytes: state.totalBytes,
      totalChunks: state.totalChunks,
      diskFree,
    })

    json(res, 200, {
      accepted: state.accepted.map((f) => ({ index: f.index, rel: f.rel, renamedFrom: f.renamedFrom })),
      skipped: state.skipped,
      totalChunks: state.totalChunks,
      diskFree,
      partSuffix: PART_SUFFIX,
    })
  }

  /** `PUT /up/chunk?f=<下标>&c=<块号>` —— 收一块，验一块，写一块 */
  async function handleChunk(req, res, url) {
    requireSid(req)
    if (state.finished) throw new SessionError('这次会话已经收尾了', 'ALREADY_FINISHED')
    if (!state.manifest) throw new SessionError('还没收到清单', 'NO_MANIFEST')

    const fi = Number(url.searchParams.get('f'))
    const ci = Number(url.searchParams.get('c'))
    const file = state.accepted.find((x) => x.index === fi)
    if (!file) {
      const e = new SessionError(`没有这个文件下标：${fi}`, 'BAD_FILE_INDEX')
      e.status = 404
      throw e
    }
    if (!Number.isInteger(ci) || ci < 0 || ci >= file.chunks) {
      const e = new SessionError(`块号超出范围：${ci}（该文件共 ${file.chunks} 块）`, 'BAD_CHUNK_INDEX')
      e.status = 404
      throw e
    }
    // 幂等：重发同一块直接认下，不再写一次（手机上重试是常态）
    if (file.received[ci]) {
      return json(res, 200, { ok: true, already: true, f: fi, c: ci })
    }

    const body = await readBody(req, LIMITS.maxChunkBytes + 1024)
    if (body.length < 16) throw new SessionError('分块太短，不是有效负载', 'BAD_CHUNK')

    const plainLen = ci === file.chunks - 1
      ? file.size - (file.chunks - 1) * file.chunkBytes
      : file.chunkBytes
    let plain
    try {
      plain = openChunk(session.keys.enc, fi, ci, file.chunks, body.subarray(16), body.subarray(0, 16), plainLen)
    } catch {
      state.chunkFailures++
      const e = new SessionError(
        `第 ${ci} 块校验失败（数据损坏或被改过）`, 'E_CHUNK_AUTH')
      e.status = 400
      if (state.chunkFailures >= LIMITS.maxChunkFailures) {
        session.destroy()
        throw new SessionError(
          `连续 ${state.chunkFailures} 块校验失败，已中止这次会话`, 'TOO_MANY_BAD_CHUNKS')
      }
      throw e
    }

    if (!file.handle) file.handle = await open(file.partPath, 'w')
    await file.handle.write(plain, 0, plain.length, ci * file.chunkBytes)
    file.received[ci] = 1
    file.receivedChunks++
    file.receivedBytes += plain.length
    state.receivedChunks++
    state.receivedBytes += plain.length
    session.onEvent({
      type: 'chunk-received',
      fileName: file.rel,
      receivedChunks: state.receivedChunks,
      totalChunks: state.totalChunks,
      receivedBytes: state.receivedBytes,
      totalBytes: state.totalBytes,
    })
    json(res, 200, { ok: true, f: fi, c: ci })
  }

  /** `GET /up/status` —— 手机断线重来后先问这个，只补缺的块 */
  async function handleStatus(req, res) {
    requireSid(req)
    json(res, 200, {
      files: state.accepted.map((f) => ({
        index: f.index, rel: f.rel, chunks: f.chunks,
        received: f.receivedChunks, receivedBytes: f.receivedBytes, size: f.size,
        missing: [...f.received].map((v, i) => (v ? -1 : i)).filter((i) => i >= 0).slice(0, 64),
      })),
      totalChunks: state.totalChunks,
      totalBytes: state.totalBytes,
      receivedChunks: state.receivedChunks,
      receivedBytes: state.receivedBytes,
      finished: state.finished,
    })
  }

  /** 流式算一个文件的 SHA-256（按磁盘上的顺序，与分块到达顺序无关） */
  function hashOfFile(file) {
    return new Promise((resolve, reject) => {
      const h = createHash('sha256')
      const rs = createReadStream(file.partPath)
      rs.on('data', (c) => h.update(c))
      rs.on('error', reject)
      rs.on('end', () => resolve(h.digest('hex')))
    })
  }

  /** `POST /up/finish` —— 校验整文件摘要，通过才改名定稿 */
  async function handleFinish(req, res) {
    requireSid(req)
    if (!state.manifest) throw new SessionError('还没收到清单', 'NO_MANIFEST')
    if (state.finished) throw new SessionError('已经收尾过了', 'ALREADY_FINISHED')

    // 必须一块不缺 —— 缺块是要接收端补发，不是"当做成功"
    const missing = state.accepted
      .map((f) => ({ rel: f.rel, missing: f.chunks - f.receivedChunks }))
      .filter((x) => x.missing > 0)
    if (missing.length) {
      const e = new SessionError(
        `还有 ${missing.reduce((a, x) => a + x.missing, 0)} 块没收到：` +
        missing.map((x) => `${x.rel} 缺 ${x.missing}`).join('、'), 'INCOMPLETE')
      e.status = 409
      throw e
    }

    const done = [], failed = []
    for (const f of state.accepted) {
      if (f.handle) { await f.handle.close(); f.handle = null }
      const got = await hashOfFile(f)
      if (f.sha256 && got !== f.sha256) {
        // ⚠️ 校验不过就**不改成正式名字**：半成品留在磁盘上（`.flicker-part`），
        //    既不污染正常文件，也留下证据供排查。
        const reason = `整文件校验不通过（期望 ${f.sha256.slice(0, 16)}…，实际 ${got.slice(0, 16)}…）`
        failed.push({ rel: f.rel, reason })
        await emitP(EVENTS.RECV_FILE_FAILED, { rel: f.rel, reason })
        continue
      }
      await rename(f.partPath, f.finalPath)
      f.done = true
      done.push({ rel: f.rel, bytes: f.size, renamedFrom: f.renamedFrom })
      await emitP(EVENTS.RECV_FILE_DONE, { rel: f.rel, bytes: f.size, renamedFrom: f.renamedFrom })
    }

    state.finished = true
    state.report = { done, failed, skipped: state.skipped }
    session.onEvent({ type: 'transfer-complete', files: done.length, bytes: state.receivedBytes })
    await emitP(EVENTS.RECV_COMPLETE, {
      files: done.length,
      bytes: state.receivedBytes,
      done: done.map((d) => d.rel),
      failed: failed.map((d) => d.rel),
      skipped: state.skipped.map((d) => d.rel),
    })
    json(res, 200, state.report)
  }

  // ── HTTP 入口 ──────────────────────────────────────────────
  /**
   * `GET /` —— 手机打开的那个页面。
   *
   * 页面由调用方给（`pageHtml`）：M2 是构建期内联的手机上传页，
   * 本文件不关心它长什么样，也不去读磁盘（SEA 形态下没有磁盘可读）。
   * 没有页面时**如实说**，而不是回一个空 200 —— 扫码的人看到一片空白
   * 只会以为程序坏了。
   */
  async function handlePage(req, res) {
    if (!pageHtml) {
      return json(res, 404, {
        error: 'NO_PAGE',
        message: `这个服务只有上传接口（POST /up/session 等），没有页面。` +
          `可用接口：${ROUTES.map(([m, p]) => `${m} ${p}`).join(' · ')}`,
      })
    }
    const body = typeof pageHtml === 'function' ? await pageHtml() : pageHtml
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(buf)
  }

  /**
   * 处理函数表 —— 键必须与 `RECV_ROUTE_TABLE` 一一对应。
   * 少一个会**在建会话时当场抛错**，而不是安静地变成一个 404
   * （让照着文档写客户端的人对着"没有这个接口"发愣）。
   */
  const HANDLERS = {
    'GET /': handlePage,
    'POST /up/session': handleSession,
    'POST /up/auth': handleAuth,
    'POST /up/manifest': handleManifest,
    'PUT /up/chunk': handleChunk,
    'GET /up/status': handleStatus,
    'POST /up/finish': handleFinish,
  }
  const ROUTES = RECV_ROUTE_TABLE.map(([m, p]) => {
    const fn = HANDLERS[`${m} ${p}`]
    if (typeof fn !== 'function') {
      throw new Error(`端点表里有 ${m} ${p}，但没有对应的处理函数`)
    }
    return [m, p, fn]
  })

  async function handle(req, res) {
    const url = new URL(req.url, 'http://receive.local')
    const route = ROUTES.find(([m, p]) => m === req.method && p === url.pathname)
    if (!route) {
      return json(res, 404, { error: 'NOT_FOUND', message: `没有这个接口：${req.method} ${url.pathname}` })
    }
    try {
      await route[2](req, res, url)
    } catch (err) {
      fail(res, err)
    }
  }

  /** 收尾：关掉打开的文件句柄、清掉会话里的密钥（**收到的文件保留**） */
  async function close() {
    const reason = state.finished ? 'finished' : 'closed'
    for (const f of state.accepted) {
      if (f.handle) { try { await f.handle.close() } catch { /* 尽力而为 */ } f.handle = null }
    }
    session.destroy()
    wipe(session.keys?.enc, session.keys?.auth, session.keys?.room, session.salt)
    // ⚠️ 放在清完密钥之后：插件拿到这个事件时，密钥确实已经没了 ——
    //    它据此记账"这次会话结束了"才是真的（而不是"我以为结束了"）。
    await emitP(EVENTS.RECV_CLOSED, { reason })
  }

  return {
    session,
    handle,
    state,
    close,
    get report() { return state.report },
    /** 供上层做"磁盘空间不足"之类的友好提示 */
    limits: LIMITS,
    /** 页面给了没有（命令行据此提示"页面还没做"，而不是让用户对着 404 发愣） */
    hasPage: Boolean(pageHtml),
  }
}

/**
 * 起一个接收服务。
 *
 * 默认是**明文 HTTP**，只绑在回环地址上 —— 那是给测试用的。
 * 真机（手机）必须走 HTTPS：`http://192.168.x.x` 不是"安全上下文"，
 * 浏览器会直接不给 `crypto.subtle`，页面连密码都算不出来。
 * 所以命令行那一条路一定带 `tls: {key, cert}`（见 src/recv.js）。
 *
 * @param {object} [opts] 见 `createReceiveSession`
 * @param {{key:string,cert:string}} [opts.tls] 给了就走 HTTPS（PEM 文本）
 */
export async function startReceiveServer(opts = {}) {
  const receive = createReceiveSession(opts)
  const handler = (req, res) => { receive.handle(req, res) }
  const server = opts.tls
    ? createServer({ key: opts.tls.key, cert: opts.tls.cert }, handler)
    : createHttpServer(handler)
  const host = opts.host ?? '127.0.0.1'
  await new Promise((r) => server.listen(opts.port ?? 0, host, r))
  const port = server.address().port
  const scheme = opts.tls ? 'https' : 'http'
  return {
    ...receive,
    server,
    port,
    scheme,
    url: `${scheme}://${host}:${port}`,
    /**
     * ⚠️ 这一行不是多余的：`createReceiveSession` 返回的 `report` 是 **getter**，
     *    而上面的 `...receive` 展开会**当场求值一次**并把结果固化下来 ——
     *    于是"传输还没结束"时它是 `undefined`，而且**永远是 undefined**。
     *    表现：调用方拿到 `undefined` 的落盘清单，以为"一个文件都没收下"
     *    （GUI 里就这么显示过"0 个文件"，而文件其实好好地在磁盘上）。
     *    getter 必须在展开**之后**重新定义一次才是活的。
     */
    get report() { return receive.state.report },
    /**
     * 关掉服务。
     *
     * ⚠️ 顺序与"怎么关"都有讲究（真机跑出来的）：
     *   ① 必须**等在途请求写完响应**再强断 —— `/up/finish` 的响应就是
     *      "文件已收到"那句话，它是在 `transfer-complete` 之后才发出的；
     *      一上来就 `closeAllConnections()` 会让手机在**成功之后**看到一个网络错误。
     *   ② 空闲的 keep-alive 连接会让 `server.close()` 一直等下去，所以要显式
     *      `closeIdleConnections()`；还赖着不走的（手机切后台）2 秒后强断。
     *   ③ 最后才清密钥、关文件句柄（`receive.close()`）—— 让"关门"发生在数据之后。
     */
    async stop() {
      await new Promise((r) => {
        server.close(() => r())
        server.closeIdleConnections?.()
        const t = setTimeout(() => server.closeAllConnections?.(), 2000)
        t.unref?.()
      })
      await receive.close()
    },
  }
}

/** 便于测试与清理：删掉一个半成品文件 */
export async function removePart(dir, rel) {
  await rm(path.join(dir, rel + PART_SUFFIX), { force: true })
}
