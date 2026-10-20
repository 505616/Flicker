/**
 * 中继传输的**平台无关核**
 * ========================
 *
 * 这份文件里只有纯函数：不碰磁盘、不碰 Buffer、不碰 `node:*`、不碰 DOM。
 * 目的只有一个 —— **同一个实现，Node 发送端与将来的网页发送端都用它**。
 *
 * ── 为什么值得单独拆出来 ──
 * 中继发送端最容易出错的地方不是密码学，而是**流程控制**，而且每一条都是踩出来的：
 *   · 窗口是"在途上限"，不是"每轮投递量"（写错过：窗口设 1，在途却有 5 条）
 *   · 空位不足半窗时宁可只问状态，否则每窗要花两个往返
 *   · batch POST 失败时无法判断到底落库没有，要靠服务端 nextSeq 反推
 *   · 完成判据是"接收端确认了全部"，不是"我投完了"
 * 这些逻辑如果照抄到网页里，必然会出现两套实现对不上的情况（本项目反复吃过这个亏）。
 * 所以先把它抽成纯函数，谁都可以调用、也都可以被反向测试。
 *
 * 这里**不**处理：读文件、加密、打包消息、发 HTTP —— 那些由调用方注入。
 */

/**
 * 判定一个错误值不值得重试。
 *
 * ⚠️ 只重试**瞬时**故障（网络抖动、超时、5xx、429）。
 *    其余一律不重试，因为重试也不会变好，只会拖长用户等待：
 *      NO_ROOM / EXPIRED / GONE → 房间真没了
 *      BAD_SEQ / TOO_LARGE / BAD_ROOM_ID / EMPTY_* → 请求本身有问题
 *      ABORTED → 用户点了取消
 *
 * 判断网络类错误靠 err.name / err.code（fetch 抛的是 TypeError("fetch failed")，
 * 其 cause 里可能是 ECONNRESET / ENOTFOUND / UND_ERR_* 等）。
 */
export function isTransientError(e, status) {
  // HTTP 层面：5xx 与 429 值得重试。
  // ⚠️ 这一条**必须排在前面**：调用方可能直接用状态码问
  //    （isTransientError(null, 503)），此时没有错误对象可查。
  if (typeof status === 'number') return status >= 500 || status === 429
  if (!e) return false
  if (e.code === 'ABORTED' || e.name === 'RelayAborted') return false
  // 协议层面：明确不可恢复的，不重试
  const fatal = ['NO_ROOM', 'EXPIRED', 'GONE', 'NOT_YET', 'BAD_SEQ', 'BAD_ROOM_ID',
    'TOO_LARGE', 'BAD_BODY', 'EMPTY_BODY', 'EMPTY_BATCH', 'BATCH_TOO_LARGE', 'BAD_BATCH']
  if (typeof e.code === 'string' && fatal.includes(e.code)) return false
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return true
  if (e.name === 'TypeError') return true                 // fetch 的网络层失败
  const cause = e.cause?.code ?? e.cause?.name
  if (typeof cause === 'string') return true              // ECONNRESET / UND_ERR_SOCKET …
  return false
}

/**
 * 第 `attempt` 次重试前等多久（毫秒）。
 *
 * 300ms 起，每次翻倍，封顶 8s。抖动由调用方加（这里保持纯函数，方便测试）。
 * @param {number} attempt 0 = 第一次重试
 */
export function retryDelay(attempt) {
  return Math.min(300 * 2 ** Math.max(0, attempt), 8000)
}

/**
 * 这一轮该不该投、投多少。
 *
 * ── 三条规则，每条都是踩出来的 ──
 *  ① 投递量是**窗口里的空位**，不是整个窗口。写错的话窗口形同虚设
 *     （实测：窗口设 1，在途却有 5 条）。
 *  ② 空位不足半个窗口时，这一轮**只问状态**，别只投一块 —— 否则每个窗要
 *     花两个往返，吞吐直接砍半（实测窗口 8 时每批是 7,1,7,1…）。
 *     例外：剩余量本来就不足半个窗口（快传完了），照投。
 *  ③ 窗口是**硬上限**，永不超投。接收端不 ack 时中继队列会一路涨到
 *     整个文件大小（10 GB 就撑爆 10 GB 内存）。
 *     `idleRounds >= 3` 只用来触发"再读一次状态"，不是"允许超投一条"。
 *
 * @param {object} p
 * @param {number} p.total 消息总数（清单那条也算，= 1 + 分块数）
 * @param {number} p.posted 已经投递到中继的条数
 * @param {number} p.ackedBase 接收端已确认到哪一条（不含）
 * @param {number} p.windowSize 在途上限
 * @param {number} [p.idleRounds] 连续空转轮数
 * @returns {{startSeq:number, inFlight:number, room:number, remaining:number,
 *   worthSending:boolean, forcePoll:boolean, count:number, send:boolean}}
 *   `send` 为真才真的投；`forcePoll` 为真表示"这一轮无论投不投，都该读一次状态"。
 */
export function planWindow({ total, posted, ackedBase, windowSize, idleRounds = 0 }) {
  const startSeq = posted
  const inFlight = startSeq - ackedBase
  const room = Math.max(0, windowSize - inFlight)
  const remaining = total - startSeq
  const worthSending = room >= Math.max(1, Math.ceil(windowSize / 2)) || room >= remaining
  const forcePoll = idleRounds >= 3
  // ⚠️ `count > 0` 是 send 的必要条件。
  //    从前只判 `worthSending || forcePoll`，于是"空位为 0 + 连续空转"会走到
  //    putBatch(startSeq, 0) → 返回 aborted → 外层 break → 整轮传输提前结束。
  //    注释里写的是"强制转一圈（重新读一次状态）"，实现却会终止 —— 两回事。
  const count = Math.min(room, Math.max(0, remaining))
  const send = (worthSending || forcePoll) && startSeq < total && count > 0
  return { startSeq, inFlight, room, remaining, worthSending, forcePoll, count, send }
}

/**
 * 一批投递的 POST 失败后，靠服务端 nextSeq 反推它到底落库没有。
 *
 * 为什么需要：请求可能已经在服务端成功，只是响应在回程丢了。盲目重发会在
 * 房间尾部多出一批重复消息（接收端白取一遍）。
 *
 * @param {object} p
 * @param {number} p.startSeq 这一批的起始序号
 * @param {number} p.wantNext 这一批全部落库后，服务端的 nextSeq 应当等于它
 * @param {number|null} p.statusNextSeq 刚才读到的服务端 nextSeq（读不到给 null）
 * @returns {'landed'|'resend'|'desync'|'unknown'}
 *   landed  → 当作成功（补记账）
 *   resend  → 没落库，安全重发
 *   desync  → 涨到别处了（不该发生），报错别猜
 *   unknown → 状态读不到，按普通失败重试
 */
export function batchOutcome({ startSeq, wantNext, statusNextSeq }) {
  if (!Number.isInteger(statusNextSeq)) return 'unknown'
  if (statusNextSeq === wantNext) return 'landed'
  if (statusNextSeq === startSeq) return 'resend'
  return 'desync'
}

/**
 * 中继上接收端页面的地址。
 *
 * ⚠️ salt 放在 **fragment**（`#` 之后）里：浏览器不把 fragment 发给服务器，
 *    所以中继看不到 salt —— 它参与密钥派生，泄露会削弱"中继不知道对方在传什么"。
 *
 * ⚠️ 形状是 `#k=<房间名>&s=<盐>`，**不是** `#/<房间名>.<盐>`。后者是早期文档的
 *    写法，而接收页只认 `k=` 与 `s=`（`web/receiver.html` 的 readRelayParams），
 *    照旧写法打开的链接是空的 —— 2026-10 修过一轮文档。
 *
 * @param {{base:string, room:string, saltHex:string}} p
 */
export function relayLink({ base, room, saltHex }) {
  const trimmed = String(base).replace(/\/+$/, '')
  return `${trimmed}/#k=${room}&s=${saltHex}`
}
