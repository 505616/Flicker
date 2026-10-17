/**
 * 插件事件表（唯一真相）
 * ======================
 * 这一个文件同时决定三件事，所以它必须是唯一的一处：
 *
 *   ① **运行时的名字常量**（`EVENTS` / `SLOTS`）—— 触发点用常量，不写裸字符串；
 *   ② **注册时的校验** —— `ctx.on('manifset/scanned')` 这种拼错**当场报错**，
 *      而不是"永远收不到事件"（静默失败是这个项目最不想要的失败方式）；
 *   ③ **文档检查** —— `gen/check-plugin-doc.mjs` 拿这张表与两份《插件.md》的表格
 *      逐行比：文档漏写一个事件、或者代码加了事件忘了写文档，CI 都会失败。
 *
 * ⚠️ 加一个事件的正确顺序是：
 *      在下面加一行 → 在代码里 `emit` → 两份文档各加一行 → 跑 `npm run check`。
 *    少任何一步都会被机器拦下来，这是故意的。
 */

/**
 * 插件 API 版本。
 *
 * 不兼容的改动必须 +1，并且**拒绝加载**旧插件（而不是"尽力而为"）：
 * 插件是别人写的代码，接口变了还硬跑，坏起来会很难查。
 */
export const API_VERSION = 1

/** 本程序能加载的插件 API 版本（将来同时支持两代时会是 [1, 2]） */
export const SUPPORTED_API_VERSIONS = Object.freeze([1])

/**
 * 事件与贡献点的总表。
 *
 * `plane`：这个钩子属于哪个**平面** —— 发送端进程（`sender`）、中继服务（`relay`）、
 *   还是接收端页面（`page`，暂时没有）。插件在哪个平面被加载，就只能用哪个平面的钩子
 *   （注册时能看到全部名字，但用错平面的钩子永远不会被触发 —— 所以文档里按平面分组）。
 *
 * `kind`：
 *   · `event` —— 只读通知。处理函数**不能**改变传输内容，只能观察与做自己的事；
 *   · `slot`  —— 贡献点。返回值会被真正用上（见各处的 `collect`）。
 *
 * `sync`：`true` 表示这个事件在**同步上下文**里触发（例如界面输出），
 * 处理函数必须同步完成；返回 Promise 会被忽略并记为插件错误。
 * `false` 表示调用方会 `await`，处理函数可以是 async。
 */
const TABLE = [
  {
    key: 'RUN_START', kind: 'event', plane: 'sender', sync: false, name: 'run/start',
    payload: '{ mode, inputs, chunkBytes }',
  },
  {
    key: 'MANIFEST_SCANNED', kind: 'event', plane: 'sender', sync: false, name: 'manifest/scanned',
    payload: '{ mode, chunkBytes, summary: { fileCount, dirCount, totalBytes, totalChunks, files[] } }',
  },
  {
    key: 'TRANSFER_COMPLETE', kind: 'event', plane: 'sender', sync: false, name: 'transfer/complete',
    payload: '{ mode, ok, reason, bytes, fileCount }',
  },
  {
    key: 'UI_MESSAGE', kind: 'event', plane: 'sender', sync: true, name: 'ui/message',
    payload: '{ level, text }',
  },
  {
    key: 'GIFT_ITEMS', kind: 'slot', plane: 'sender', sync: true, name: 'gift/items',
    payload: '→ { name, data } 或它的数组（data 是 Buffer / Uint8Array / 字符串）',
  },
  {
    key: 'RELAY_ROUTE', kind: 'event', plane: 'relay', sync: false, name: 'relay/route',
    payload: '{ method, path, room, query, headers } → 可返回 { status, body, headers } 直接结束请求',
  },
  {
    key: 'RELAY_ROOM_CREATED', kind: 'event', plane: 'relay', sync: false, name: 'relay/room-created',
    payload: '{ room }',
  },
  {
    key: 'RELAY_ROOM_DESTROYED', kind: 'event', plane: 'relay', sync: false, name: 'relay/room-destroyed',
    payload: '{ room }',
  },
  {
    key: 'RELAY_HEALTH', kind: 'slot', plane: 'relay', sync: true, name: 'relay/health',
    payload: '→ 一个对象，字段会并进 /health 的响应（核心字段优先，插件覆盖不了）',
  },
  {
    key: 'RELAY_STORE', kind: 'slot', plane: 'relay', sync: true, name: 'relay/store',
    payload: '→ 一个存储后端对象（create/put/putBatch/get/ack/status/destroy/stats + maxMessageBytes），' +
      '替换掉默认的内存房间存储；多个插件都贡献时**第一个说了算**',
  },
  // ── 接收端进程平面（`flicker recv`：电脑起 HTTPS 服务、手机把文件推上来）──
  //
  // ⚠️ 这个平面**只有事件、没有贡献点**：落盘路径规则与逐块校验是接收端的安全底线，
  //    不允许插件插手（见《插件.md》§十）。插件在这里能做的是"知道发生了什么"——
  //    记账、通知、把收到的清单写进自己的审计日志。
  {
    key: 'RECV_READY', kind: 'event', plane: 'receive', sync: false, name: 'receive/ready',
    payload: '{ dir, port, tls, limits: { maxFiles, maxBytes, maxChunkBytes } }' +
      '（**不含**密码与链接令牌 —— 那两样不该交给插件）',
  },
  {
    key: 'RECV_PEER', kind: 'event', plane: 'receive', sync: false, name: 'receive/peer',
    payload: '{ peer: { address, userAgent } }（对方连上来了，但还没证明它知道密码）',
  },
  {
    key: 'RECV_AUTH', kind: 'event', plane: 'receive', sync: false, name: 'receive/auth',
    payload: '{ peer, macProfile }（密码核对通过；macProfile 是 "v1" 时说明对方页面较旧）',
  },
  {
    key: 'RECV_MANIFEST', kind: 'event', plane: 'receive', sync: false, name: 'receive/manifest',
    payload: '{ files, skipped, totalBytes, totalChunks, diskFree }（清单已解密并查完，一个字节都还没写）',
  },
  {
    key: 'RECV_COLLISION', kind: 'event', plane: 'receive', sync: false, name: 'receive/collision',
    payload: '{ rel, existing }（有同名文件；**只是通知** —— 改名/覆盖/跳过仍然由用户决定）',
  },
  {
    key: 'RECV_FILE_DONE', kind: 'event', plane: 'receive', sync: false, name: 'receive/file-done',
    payload: '{ rel, bytes, renamedFrom }（整文件摘要校验通过、已改成正式文件名）',
  },
  {
    key: 'RECV_FILE_FAILED', kind: 'event', plane: 'receive', sync: false, name: 'receive/file-failed',
    payload: '{ rel, reason }（整文件摘要对不上；半成品按设计留在磁盘上，后缀 .flicker-part）',
  },
  {
    key: 'RECV_COMPLETE', kind: 'event', plane: 'receive', sync: false, name: 'receive/complete',
    payload: '{ files, bytes, done, failed, skipped }（会话收尾成功；`done`/`failed` 是文件名数组）',
  },
  {
    key: 'RECV_CLOSED', kind: 'event', plane: 'receive', sync: false, name: 'receive/closed',
    payload: '{ reason }（服务关闭；reason 是 "finished" 或 "closed"）',
  },
]

/** 冻结过的表（防止插件在运行时改它） */
export const PLUGIN_TABLE = Object.freeze(TABLE.map((row) => Object.freeze(row)))

/**
 * 名字不许重复 —— **两个平面共用一个名字会让"平面"这个概念失效**。
 *
 * 2026-10 加接收平面时就撞上了：我一开始把进程侧的事件也叫 `recv/file-done`、
 * `recv/complete`，而**页面平面已经有这两个名字**（页面里"某个文件收完 / 全部收完"）。
 * 后果很隐蔽：`PLANE_OF` 是一张 Map，同名的两条只剩后一条 —— "用错平面"的判据
 * 对这两个名字直接失效，而且没人看得出来。现在加载时就抛错。
 *
 * 页面平面的名字在 `web/page-plugin-runtime.mjs`（那份要内联进页面），
 * 跨平面的重名由 `test/plugin.test.js` 的"名字全局唯一"用例守着。
 */
{
  const seen = new Map()
  for (const r of PLUGIN_TABLE) {
    if (seen.has(r.name)) {
      throw new Error(`插件事件表里"${r.name}"出现了两次（${seen.get(r.name)} 与 ${r.plane}）` +
        '—— 名字必须全局唯一')
    }
    seen.set(r.name, r.plane)
  }
}

const pick = (kind) => Object.freeze(Object.fromEntries(
  PLUGIN_TABLE.filter((r) => r.kind === kind).map((r) => [r.key, r.name])))

/** 事件名常量：`EVENTS.MANIFEST_SCANNED` */
export const EVENTS = pick('event')

/** 贡献点常量：`SLOTS.GIFT_ITEMS` */
export const SLOTS = pick('slot')

/** 事件名集合（注册时校验用） */
export const KNOWN_EVENTS = new Set(PLUGIN_TABLE.filter((r) => r.kind === 'event').map((r) => r.name))

/** 贡献点名集合（注册时校验用） */
export const KNOWN_SLOTS = new Set(PLUGIN_TABLE.filter((r) => r.kind === 'slot').map((r) => r.name))

/** 同步事件集合（`sync: true` 的那些） */
export const SYNC_EVENTS = new Set(
  PLUGIN_TABLE.filter((r) => r.kind === 'event' && r.sync).map((r) => r.name))

/** 某个平面的全部钩子名（文档按平面分组，注册时也会按平面提示） */
export function hooksOfPlane(plane) {
  return PLUGIN_TABLE.filter((r) => r.plane === plane).map((r) => r.name)
}

/** 钩子名 → 它属于哪个平面（注册时用来拦"用错平面"） */
export const PLANE_OF = new Map(PLUGIN_TABLE.map((r) => [r.name, r.plane]))

/** 已知的平面（顺序就是文档里的顺序） */
export const PLANES = Object.freeze([...new Set(PLUGIN_TABLE.map((r) => r.plane))])

/**
 * 界面输出的层级 —— 也就是 `ui/message` 里 `level` 的取值。
 *
 * 这些就是界面对象上的方法名（见 `src/tty.js`）。刻意**只包文本类**的调用：
 *   · 不包 `progress` / `chunkProgress`：每块都触发，转发给插件只会把日志淹没
 *     （几十 GB 的传输是几万次）；
 *   · 不包 `plan` / `showUrls` / `relayReady` / `destroyReport` 这些**结构化**的：
 *     它们传的是清单、链接、账单对象 —— 插件要那些信息应当订阅对应事件
 *     （`manifest/scanned` / `transfer/complete`），而不是从界面里捞。
 */
export const UI_LEVELS = Object.freeze([
  'banner', 'step', 'info', 'warn', 'ok', 'error', 'destroyLog', 'gift',
])
