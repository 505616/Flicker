/**
 * 中继的 HTTP 协议层（不依赖 Cloudflare 运行时）
 * =============================================
 *
 * 为什么要单独一层：Cloudflare Workers 的运行时无法在本地跑单元测试，
 * 而这一层是"发送端 ↔ 中继 ↔ 接收端"契约所在的地方，最需要测试。
 * 所以协议层只依赖标准的 Request/Response 与一个 RoomStore，
 * Worker 那边只负责把请求交给它（见 relay/worker.js）。
 *
 * ── 协议 ────────────────────────────────────────────────────
 *
 *   POST /r/:room?seq=N     放入一条消息（发送端）
 *   GET  /r/:room?seq=N     取走一条消息（接收端，不删除）
 *   POST /r/:room/ack?upTo=N  确认并删除前缀（接收端）
 *   GET  /r/:room/status    房间状态（两端都用）
 *   DELETE /r/:room         销毁房间
 *   GET  /health            健康检查
 *   GET  /                  接收端页面
 *   GET  /app.js            接收端页面的脚本（如果页面拆成两个文件）
 *
 * ── 消息的封装 ──────────────────────────────────────────────
 * 房间只搬运**不透明的字节**，不理解内容。但接收端需要区分
 * "这是清单"和"这是某一分块"，所以消息的第一个字节是类型标记：
 *
 *   0x01 + 密文   清单（密钥协商参数与文件列表，已加密）
 *   0x02 + 密文   一个文件分块
 *
 * 这样房间逻辑保持纯粹（不认识这些类型），而接收端有足够信息。
 * 注意：这个标记**不是**安全边界 —— 内容仍然全靠 AES-GCM 认证。
 */

import { RoomStore, RelayError, DEFAULT_MAX_MESSAGE_BYTES } from './room.js'
import { EVENTS, SLOTS } from '../plugin/events.js'

/** 消息类型标记（放在消息的第一个字节） */
export const MSG = Object.freeze({
  MANIFEST: 0x01,
  CHUNK: 0x02,
})

/** 把类型与负载打成一个消息 */
export function packMessage(type, payload) {
  const out = new Uint8Array(1 + payload.length)
  out[0] = type
  out.set(payload, 1)
  return out
}

/** 拆开一个消息 */
export function unpackMessage(data) {
  if (!(data instanceof Uint8Array) || data.length < 1) {
    throw new RelayError('消息为空或格式不正确', 'BAD_MESSAGE', 400)
  }
  return { type: data[0], payload: data.subarray(1) }
}

/**
 * 一批消息的编码： [len(4) | 内容] × N
 * 长度前缀让服务端能干净地拆开 —— 比用分隔符安全（密文里什么字节都可能出现）。
 */
export function packBatch(items) {
  const parts = []
  for (const it of items) {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(it.length, 0)
    parts.push(len, Buffer.from(it))
  }
  return Buffer.concat(parts)
}

/** 拆开一批消息 */
function splitBatch(buf) {
  const items = []
  let off = 0
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new RelayError('批量数据被截断（缺长度前缀）', 'BAD_BATCH', 400)
    const len = (buf[off] << 24 | buf[off + 1] << 16 | buf[off + 2] << 8 | buf[off + 3]) >>> 0
    off += 4
    if (len === 0 || off + len > buf.length) {
      throw new RelayError('批量数据被截断（内容不足）', 'BAD_BATCH', 400)
    }
    // ⚠️ 这里必须**复制**，不能只留 subarray。
    //    子视图会一直引用整个请求体 ArrayBuffer：拆出 64 条、每条都小，
    //    只要房间还存着其中一条，那一个巨大的请求体就永远释放不掉
    //    （Worker 里就是"单请求瞬时占满 isolate 内存"的另一个来源）。
    //    new Uint8Array(subarray) 是一次真正的拷贝，断开这层引用。
    items.push(new Uint8Array(buf.subarray(off, off + len)))
    off += len
  }
  if (items.length === 0) throw new RelayError('批量数据为空', 'BAD_BATCH', 400)
  return items
}

/** 一批最多几条（与 room.js 的 putBatch 上限一致） */
export const MAX_BATCH_MESSAGES = 64

export function maxBatchBodyBytes(maxMessageBytes) {
  return MAX_BATCH_MESSAGES * maxMessageBytes + 4 * MAX_BATCH_MESSAGES
}

export const MAX_MANIFEST_PARTS = 1024

export function packManifestParts(manifestMessage, maxMessageBytes) {
  if (!(manifestMessage instanceof Uint8Array) || manifestMessage.length === 0) {
    throw new RelayError('清单消息为空', 'BAD_MESSAGE', 400)
  }
  const max = Number.isInteger(maxMessageBytes) && maxMessageBytes > 9 ? maxMessageBytes : 9
  const partSize = max - 8
  const partCount = Math.max(1, Math.ceil(manifestMessage.length / partSize))
  if (partCount > MAX_MANIFEST_PARTS) {
    throw new RelayError(
      `清单太大：${manifestMessage.length} 字节需要拆成 ${partCount} 条`,
      'MANIFEST_TOO_LARGE', 413)
  }
  const parts = []
  for (let i = 0; i < partCount; i++) {
    const start = i * partSize
    const end = Math.min(manifestMessage.length, start + partSize)
    const msg = new Uint8Array(8 + (end - start))
    const dv = new DataView(msg.buffer)
    dv.setUint32(0, i)
    dv.setUint32(4, partCount)
    msg.set(manifestMessage.subarray(start, end), 8)
    parts.push(msg)
  }
  return parts
}

async function readRequestBytes(request, limit, what) {
  const declared = request.headers.get('content-length')
  if (declared !== null && /^[0-9]+$/.test(declared.trim())) {
    const n = Number(declared)
    if (Number.isSafeInteger(n) && n > limit) {
      throw new RelayError(`${what}过大（声明 ${n} > ${limit} 字节）`, 'TOO_LARGE', 413)
    }
  }
  const buf = new Uint8Array(await request.arrayBuffer())
  if (buf.length > limit) {
    throw new RelayError(`${what}过大（${buf.length} > ${limit} 字节）`, 'TOO_LARGE', 413)
  }
  return buf
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
}

/**
 * 中继托管页面的安全响应头。
 *
 * 照搬局域网模式（src/server.js 的 sec）：页面完全自包含、不做任何外部请求。
 * 一旦页面里有 XSS（接收页曾把文件名写进 innerHTML），没有 CSP 就能把解密后的
 * 内容外发到任意外部地址；有 CSP 至少把出口堵死。
 *
 * ⚠️ script-src 'unsafe-inline' 是**必需**的：内核必须内联（零外部请求）。
 *    它确实是 XSS 的放大器，所以真正的修法仍是消除 innerHTML —— CSP 是第二道闸。
 * ⚠️ worker-src blob: 也是必需的：接收页把整文件摘要放进 Blob Worker。
 * ⚠️ frame-ancestors 'none'：中继页面不该被任何站点套进 iframe（点击劫持）。
 */
const PAGE_SECURITY_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
    "img-src data:; connect-src 'self'; worker-src blob:; " +
    "form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  })
}

/**
 * 交给 `relay/route` 插件的请求视图。
 *
 * 刻意是**只读副本**：插件不该拿到活对象（Request 的 body 只能读一次、
 * 头部对象改动会影响后续处理）。要拒绝请求就返回 `{ status, body, headers }`。
 */
function pluginRouteView(method, pathname, url, request) {
  const query = {}
  for (const [k, v] of url.searchParams) query[k] = v
  const headers = {}
  for (const [k, v] of request.headers) headers[k.toLowerCase()] = v
  const room = pathname.match(/^\/r\/([^/]+)/)?.[1] ?? null
  return Object.freeze({
    method, path: pathname, room,
    query: Object.freeze(query), headers: Object.freeze(headers),
  })
}

/** 把插件返回的 `{ status, body, headers }` 变成一个响应 */
function pluginResponse(gate) {
  const v = gate.value ?? {}
  const status = Number.isInteger(v.status) ? v.status : 403
  const headers = { ...CORS }
  if (v.headers && typeof v.headers === 'object') {
    for (const [k, val] of Object.entries(v.headers)) headers[k] = String(val)
  }
  const body = v.body === undefined ? '' : v.body
  if (typeof body === 'object' && body !== null) {
    return json({ ...body, by: gate.plugin }, status)
  }
  if (!('Content-Type' in headers)) headers['Content-Type'] = 'text/plain; charset=utf-8'
  return new Response(String(body), { status, headers })
}

function errResponse(err) {
  const status = err instanceof RelayError ? err.status : 500
  const code = err instanceof RelayError ? err.code : 'INTERNAL'
  return json({ error: code, message: err?.message ?? '内部错误' }, status)
}

/**
 * 把一次请求交给房间处理。
 *
 * @param {Request} request
 * @param {string} pathname 例如 "/r/abcdef0123456789/ack"
 * @param {RoomStore} store
 * @param {object} [opts]
 * @param {() => Promise<string>} [opts.pageHtml] 返回接收端页面（可选）
 * @returns {Promise<Response>}
 */
export async function handleRelay(request, pathname, store, opts = {}) {
  const url = new URL(request.url)
  const method = request.method.toUpperCase()
  const plugins = opts.plugins ?? null

  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

  // ── 插件：路由钩子（鉴权 / 配额 / IP 白名单）────────────────
  //
  // 放在**最前面**（连 /health 与首页都会经过）：一个想给中继加访问控制的
  // 部署方，需要的是"所有请求都过这一关"，而不是"部分请求"。
  // 插件返回 `{ status, body, headers }` 就直接结束这个请求；返回 undefined 表示放行。
  //
  // ⚠️ 插件抛错 → 500 并**点名是哪个插件**（见下面 catch）：中继是别人部署的服务，
  //    "某个请求莫名其妙 500" 而不知道是谁干的，是最难查的一类故障。
  if (plugins && plugins.count) {
    let gate
    try {
      gate = await plugins.emitFirst(EVENTS.RELAY_ROUTE, pluginRouteView(method, pathname, url, request))
    } catch (e) {
      // 插件自己出错 → 500，而且**点名是哪个插件**。
      // 中继是别人部署的服务，"某个请求莫名 500 而不知道谁干的"是最难查的一类故障。
      return json({ error: 'PLUGIN_ERROR', message: e?.message ?? String(e) }, 500)
    }
    if (gate) return pluginResponse(gate)
  }

  // ── 健康检查：给启动时的就绪探测用（无副作用）──
  //
  // 2026-10 起它同时是**能力协商**的入口：`maxMessageBytes` 告诉客户端
  // "这个中继一条消息最多收多大"。一条消息就是一块，所以它等于
  // "这个中继允许的最大的块"。发送端据此选块大小 ——
  // 老中继不返回这个字段，客户端就回落到协议保证的最小值（1 MiB + 17），
  // 于是**新旧组合都不会坏**。
  //
  // 插件可以用 `relay/health` 往里加自己的字段（例如地区、运营方），
  // 但**核心字段优先**：插件覆盖不了 `maxMessageBytes` —— 那是能力协商的依据，
  // 让它被覆盖等于让中继对客户端说谎。
  if (pathname === '/health') {
    const extra = {}
    for (const { value } of plugins ? plugins.collect(SLOTS.RELAY_HEALTH) : []) {
      if (value && typeof value === 'object') Object.assign(extra, value)
    }
    return json({ ...extra, ok: true, maxMessageBytes: store.maxMessageBytes, protocol: 1 }, 200)
  }

  // ── /send：网页发送端 ──
  //
  // 手机传手机时两边都只有浏览器，"谁当服务端"无解 —— 只能由中继提供这一页。
  // 与接收页同一条约束：页面自包含（构建期把内核内联进 HTML），中继只回一段 HTML。
  if (pathname === '/send' || pathname === '/send/') {
    if (!opts.senderHtml) {
      return new Response('这个中继没有配置网页发送端（只提供接收）。\n' +
        '用本机的 `flicker send --relay=…` 发送，或部署新版本的中继。\n', {
        status: 501,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS },
      })
    }
    const html = await opts.senderHtml()
    return new Response(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', ...PAGE_SECURITY_HEADERS, ...CORS },
    })
  }

  // ── 首页：接收端页面 ──
  if (pathname === '/' || pathname === '/index.html') {
    if (!opts.pageHtml) {
      return new Response('这个中继没有配置接收端页面。\n', {
        status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS },
      })
    }
    const html = await opts.pageHtml()
    return new Response(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', ...PAGE_SECURITY_HEADERS, ...CORS },
    })
  }

  // ── 房间相关的所有接口 ──
  const m = pathname.match(/^\/r\/([^/]+)(\/[a-z]+)?$/)
  if (!m) return json({ error: 'NOT_FOUND', message: '没有这个接口' }, 404)
  const roomId = m[1]
  const action = m[2] ?? ''

  if (!RoomStore.validRoomId(roomId)) {
    return errResponse(new RelayError('房间号格式不正确', 'BAD_ROOM_ID', 400))
  }
  // ⚠️ 非法 seq 不能"当成没写" —— 那会把一个错误请求变成一次**创建房间**，
  //    请求返回 200 而消息被静默丢弃（同一文件里 ack 的参数校验就很严格，这里也要）。
  //    只有"完全没写 seq"才表示创建；写了就必须是非负整数。
  /**
 * 单条消息上限。
 *
 * 内置 RoomStore 一定有这个字段；插件存储可能没有（`STORE_METHODS` 没把它列为必需）。
 * 没有时回落到协议保证的最小值 —— 绝不能变成 `undefined`：那会让
 * `n > undefined` 恒为 false，读取上限直接失效（未认证的大 POST 就能打满内存）。
 */
  function limitBytes() {
    return Number.isSafeInteger(store.maxMessageBytes) && store.maxMessageBytes > 0
      ? store.maxMessageBytes
      : DEFAULT_MAX_MESSAGE_BYTES
  }

  const seqParam = url.searchParams.get('seq')
  let seq = null
  if (seqParam !== null) {
    if (!/^[0-9]+$/.test(seqParam.trim())) {
      return errResponse(new RelayError(
        'seq 必须是非负整数，收到 "' + seqParam + '"', 'BAD_SEQ', 400))
    }
    seq = Number(seqParam)
  }

  // 每次进房间接口都顺手清一遍过期房间（P3-4）：
  // 过期清理原本只挂在 create() 上，而一个只 GET 的客户端可以让房间一直占着内存。
  // 成本是 64 次比较，可接受。
  // `sweep()` 是**可选**方法：内置 RoomStore 有，插件存储可以没有（清理由插件自己负责）。
  // 直接调用会让没实现的插件存储在第一个请求上就 500 —— 这是 P3-6 说的"契约没写清"。
  if (typeof store.sweep === 'function') store.sweep()

  try {
    switch (`${method} ${action}`) {
      // 取消息（接收端）
      case 'GET ': {
        if (seq === null) return json(store.status(roomId), 200)
        const got = store.get(roomId, seq)
        // 直接回二进制，避免 base64 的 33% 膨胀
        return new Response(got.data, {
          status: 200,
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Flicker-Seq': String(got.seq),
            'X-Flicker-Next': String(got.nextSeq),
            'Cache-Control': 'no-store',
            ...CORS,
          },
        })
      }

      // ⚠️ 这个分支必须排在下面的基础 POST 之前。
      //    switch 的 case 是按字符串匹配的，'/r/x/ack' 的 action 是 '/ack'，
      //    但最初的写法把基础 POST 放在前面，于是 ack 请求被它吃掉、
      //    upTo 参数被忽略、悄悄按 upTo=0 处理 —— 静默的错误行为。
      //    这个坑是协议测试抓出来的（"ack 缺少 upTo 参数 → 400" 那条）。
      // 确认（接收端）
      case 'POST /ack': {
        // ⚠️ 必须先判 null 再转数字。
        //    Number(null) === 0 而不是 NaN —— 只查 isNaN 的话，
        //    "缺少参数"会被悄悄当成 upTo=0，把一个错误请求变成一次有效确认。
        //    这类 JS 陷阱不会报错，只会做出错误的事情。
        // ⚠️ 三处 JavaScript 陷阱，每一个都会把"错误请求"变成"有效确认"：
        //      Number(null) === 0    缺参数
        //      Number('')   === 0    空参数（?upTo=）
        //      Number(' ')  === 0    只有空白
        //    所以判据必须是"看起来像个非负整数字符串"，而不是"转换后是不是数字"。
        const raw = url.searchParams.get('upTo')
        if (raw === null || raw.trim() === '' || !/^\d+$/.test(raw.trim())) {
          return errResponse(new RelayError(
            raw === null ? '缺少 upTo 参数'
              : `upTo 必须是非负整数，收到 "${raw}"`, 'BAD_SEQ', 400))
        }
        const upTo = Number(raw)
        if (!Number.isInteger(upTo) || upTo < 0) {
          return errResponse(new RelayError(
            `upTo 必须是非负整数，收到 "${raw}"`, 'BAD_SEQ', 400))
        }
        return json(store.ack(roomId, upTo), 200)
      }

      // ⚠️ 批量投递必须排在基础 POST 之前（switch 按字符串匹配）。
      //    序号由**服务端**分配 —— 这是并发投递不撞车的唯一干净解法。
      case 'POST /batch': {
        // 先按 Content-Length 预检、再读；上限 = 64 条 × 单条上限 + 长度前缀
        const body = await readRequestBytes(request, maxBatchBodyBytes(limitBytes()), '批量请求')
        const items = splitBatch(body)
        const r = store.putBatch(roomId, items)
        return json({ ...r, ...store.status(roomId) }, 200)
      }

      // 放消息（发送端）；seq 缺省表示"创建房间并告诉我下一个序号"
      case 'POST ': {
        // 先确保房间存在（幂等）
        const created = store.create(roomId)
        if (created && created.created && plugins && plugins.count) {
          await plugins.emitAsync(EVENTS.RELAY_ROOM_CREATED, Object.freeze({ room: roomId }))
        }
        if (seq === null) {
          // 创建响应里也带上能力：发送端一定会走这一步，不必额外发一次请求
          return json({ ...created, ...store.status(roomId), maxMessageBytes: store.maxMessageBytes }, 200)
        }
        // 单条上限与 store 用**同一个**读数（默认都是协议上界 1 MiB + 17）。
        // 两处各写死一份常量必然漂，所以这里读 store 的实例字段 ——
        // 它允许部署方或测量脚本放宽（见 room.js 的 maxMessageBytes 说明）。
        // readRequestBytes 会先看 Content-Length：超限的请求**根本不读进内存**。
        const body = await readRequestBytes(request, limitBytes(), '消息')
        const r = store.put(roomId, seq, body)
        return json({ ...r, ...store.status(roomId) }, 200)
      }

      // 状态
      case 'GET /status':
        return json(store.status(roomId), 200)

      // 销毁
      case 'DELETE ':
      case 'POST /destroy': {
        const out = store.destroy(roomId)
        // 房间真的没了才通知插件（重复销毁不该报两次"已销毁"）
        if (out && out.destroyed !== false && plugins && plugins.count) {
          await plugins.emitAsync(EVENTS.RELAY_ROOM_DESTROYED, Object.freeze({ room: roomId }))
        }
        return json(out, 200)
      }

      default:
        return json({ error: 'NOT_FOUND', message: `不支持 ${method} ${pathname}` }, 404)
    }
  } catch (err) {
    return errResponse(err)
  }
}