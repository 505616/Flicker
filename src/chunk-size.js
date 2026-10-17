/**
 * 块大小策略（`chunkBytes` 该取多少）
 * ==================================
 *
 * ── 为什么需要"策略"而不是一个常量 ──
 * 线上格式里 `chunkBytes` 是**逐文件字段**，接收端按它分块，所以换块大小不需要改协议。
 * 但"该取多少"要同时满足三件事，其中两件是硬约束：
 *
 *   ① 跑满链路：`连接数 × 块 ≥ 带宽 × 往返`（BDP）。浏览器只给同一个源 6 条连接，
 *      所以 1 MiB 的块在 195 ms 往返上刚好够（实测端到端 18.9 MB/s），
 *      2 MiB 有余量（26.3 MB/s，链路的 89%），4 MiB 没有额外收益。
 *      —— 实测：`_lab/bench-recv-rtt.mjs`，256 MiB，链路 29.5 MB/s 封顶。
 *   ② 对方收得下：一条消息就是一块，中继有单条上限。超出会被 413 拒收。
 *      中继通过 `/health` 与创建响应里的 `maxMessageBytes` **主动声明**自己的能力；
 *      老中继不声明 → 回落到协议保证的最小值（1 MiB + 17），新客户端也不会坏。
 *   ③ 内存有界：接收端的预取缓冲 = 预取深度 × 块大小（深度默认 6）。
 *
 * 超出 BDP 之后，更大的块只会让"进度 / 重传 / 首字节"的粒度变粗
 * （实测：5 MB/s 的链路上 1 MiB 与 4 MiB 吞吐完全一样，但相邻取块间隔
 * 从 212 ms 变成 837 ms）。所以这里有**自己的上限**，不是"越大越好"。
 */

/** 协议保证的最小单条消息上限（任何符合规范的中继都必须收得下） */
export const PROTOCOL_MIN_MESSAGE_BYTES = (1 << 20) + 17

/** 一条消息的固定开销：类型字节 + 16 字节 GCM tag（见 relay/protocol.js 的 packMessage） */
export const MESSAGE_OVERHEAD = 17

/** 自动模式的目标块大小（实测的甜点） */
export const AUTO_CHUNK_BYTES = 2 << 20

/** 我们自己允许的最大块：再大买不到收益，只买内存与更粗的粒度 */
export const MAX_CHUNK_BYTES = 8 << 20

/** 最小块：再小就是拿往返次数换内存，没有意义 */
export const MIN_CHUNK_BYTES = 64 << 10

/**
 * 解析 `--chunk` 的写法。
 *
 * 接受：`auto`（默认）、`512k` / `2m` / `4m`（K/M/G，1024 进制）、纯字节数。
 * @param {string|boolean|undefined} spec
 * @returns {{kind:'auto'}|{kind:'size', bytes:number}|{error:string}}
 */
export function parseChunkSpec(spec) {
  if (spec === undefined || spec === true || spec === 'auto') return { kind: 'auto' }
  const s = String(spec).trim()
  const m = /^(\d+(?:\.\d+)?)\s*([kKmMgG])?[bB]?$/.exec(s)
  if (!m) {
    return { error: `--chunk 的写法看不懂：「${spec}」\n` +
      '  可用写法：auto、512k、2m、4m，或直接给字节数（例如 2097152）\n' }
  }
  const unit = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[(m[2] ?? '').toLowerCase()] ?? 1
  const bytes = Math.round(Number(m[1]) * unit)
  if (!Number.isFinite(bytes) || bytes <= 0) return { error: `--chunk 的数值不合法：「${spec}」\n` }
  return { kind: 'size', bytes }
}

/**
 * 决定这一趟用多大的块。
 *
 * @param {object} o
 * @param {{kind:'auto'}|{kind:'size',bytes:number}} o.spec 来自命令行（默认 auto）
 * @param {number|null} [o.maxMessageBytes] 中继声明的单条上限；`null`/`undefined` = 没声明
 *   （老中继）→ 按协议最小值；局域网模式传 `Infinity`（没有中继这条约束）
 * @returns {{chunkBytes:number, clamped:boolean, reason:string}}
 */
export function chooseChunkBytes({ spec = { kind: 'auto' }, maxMessageBytes = null } = {}) {
  // ⚠️ 三种输入要分清（这里踩过一次）：
  //    · 正整数        = 中继声明的上限
  //    · Infinity      = **没有这条约束**（局域网直连没有中继）
  //    · null/undefined/其它 = 对方没声明（老中继）→ 按协议保证的最小值
  //    第一版只判了 `Number.isInteger(...)`，而 `Number.isInteger(Infinity)` 是 false，
  //    于是局域网被**静默压回 1 MiB** —— 测试里那条"局域网也应当用 2 MiB"当场抓住。
  const noCap = maxMessageBytes === Infinity
  const declared = Number.isInteger(maxMessageBytes) && maxMessageBytes > 0
    ? maxMessageBytes
    : PROTOCOL_MIN_MESSAGE_BYTES
  // 中继限制的是**整条消息**（含 17 字节开销），块是它的载荷
  const capByRelay = noCap ? Infinity : Math.max(MIN_CHUNK_BYTES, declared - MESSAGE_OVERHEAD)
  const ceiling = Math.min(capByRelay, MAX_CHUNK_BYTES)

  const wanted = spec.kind === 'auto' ? AUTO_CHUNK_BYTES : spec.bytes
  const chunkBytes = Math.max(MIN_CHUNK_BYTES, Math.min(ceiling, wanted))
  const clamped = chunkBytes !== wanted
  const reason = !clamped ? 'ok'
    : wanted > ceiling ? (ceiling === capByRelay ? 'relay-limit' : 'our-limit')
      : 'too-small'
  return { chunkBytes, clamped, reason }
}

/**
 * 问中继"一条消息最多收多大"。
 *
 * 读 `/health` 的 `maxMessageBytes`。**老中继没有这个字段**（它以前返回纯文本 "ok"）
 * 或者根本不是 JSON —— 这两种情况都回落到协议保证的最小值，并标成 `legacy`，
 * 好让上层把"为什么这次用了 1 MiB"讲清楚。
 *
 * @param {string} baseUrl
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{maxMessageBytes:number, legacy:boolean, detail:string}>}
 */
export async function fetchRelayCaps(baseUrl, fetchImpl = fetch) {
  const legacy = {
    maxMessageBytes: PROTOCOL_MIN_MESSAGE_BYTES, legacy: true,
    detail: '中继没有声明单条上限（老版本），按协议最小值 1 MiB + 17',
  }
  try {
    const url = baseUrl.replace(/\/+$/, '') + '/health'
    const r = await fetchImpl(url, { headers: { Accept: 'application/json' } })
    if (!r.ok) return { ...legacy, detail: `中继的 /health 返回 ${r.status}，按协议最小值` }
    const text = await r.text()
    let j = null
    try { j = JSON.parse(text) } catch { /* 老中继返回的是纯文本 "ok" */ }
    if (!j || !Number.isInteger(j.maxMessageBytes) || j.maxMessageBytes <= 0) return legacy
    return { maxMessageBytes: j.maxMessageBytes, legacy: false, detail: 'ok' }
  } catch (e) {
    return { ...legacy, detail: `问不到中继的能力（${e?.message ?? e}），按协议最小值` }
  }
}

/** 页面/日志里显示块大小用（1.00 MiB 这种） */
export function describeChunk(bytes) {
  return `${(bytes / (1 << 20)).toFixed(2)} MiB`
}
