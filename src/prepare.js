/**
 * 发送端的共用准备阶段
 * ====================
 * 两种模式的**前半段完全一样**，所以放在这一处：
 *
 *   扫描文件 → 算校验值 → 取密码 → 派生密钥 → 组装清单（含自赠程序）→ 加密清单
 *
 * 不同的是后半段：
 *   局域网模式：起 HTTPS 服务，等浏览器直连（src/run.js）
 *   中继模式  ：把密文按序投到中继，等接收端来取（src/relay/run-relay.js）
 *
 * 抽出来的理由很实际：这段逻辑里有几处"必须一致"的约束
 * （盐只生成一次、密钥与验证值同源、赠品要重新编号），
 * 复制一份迟早会漂移，而漂移的表现是"另一种模式莫名其妙打不开"。
 */
import { randomBytes } from 'node:crypto'
import {
  scan, fillHashes, toWire, summarize, hashFile, hashBuffer, sanitizeRelPath,
} from './manifest.js'
import { deriveVerifier, deriveKeys, sealManifest, relayRoomName, PARAMS } from './suite/flicker1.js'
import { makeGifts } from './gift.js'
import { SLOTS } from './plugin/events.js'

/**
 * @param {object} o
 * @param {string[]} o.inputs
 * @param {string} [o.password]
 * @param {boolean} [o.gift]
 * @param {number} [o.chunkBytes] 覆盖协议默认块大小（**只给测量用**，见下）
 * @param {object} o.ui 终端界面（tty() 的返回值）
 * @param {object} [o.plugins] 插件注册表（有插件时，赠品列表里会多出它们贡献的文件）
 * @returns {Promise<object>} 准备结果
 *
 * ⚠️ 关于 `chunkBytes`：线上格式**本来就与块大小无关** ——
 *    清单里逐文件带 `chunkBytes`，接收端按它分块；IV 只由块号派生
 *    （`chunkIV(chunkIndex)`），AAD 只绑 (文件下标, 块号, 总块数, 明文长度)。
 *    所以换块大小不需要改协议。这里留一个显式入参，是为了能用**真实发送端**
 *    去量"块大小值多少"（`_lab/bench-recv-rtt.mjs`），而不是另写一个假发送端 ——
 *    假发送端测出来的东西不算数（见 `路线图.md` 里那条教训）。
 *    默认仍然是 `PARAMS.chunkBytes`，不改任何现有行为。
 */
export async function prepareSession({ inputs, password: givenPassword, gift, ui, chunkBytes, plugins }) {
  const CHUNK = Number.isInteger(chunkBytes) && chunkBytes > 0 ? chunkBytes : PARAMS.chunkBytes
  // ── 阶段 1：扫描 + 哈希 ─────────────────────────────
  ui.banner()
  ui.step('扫描文件')
  const manifest = await scan(inputs, {
    chunkBytes: CHUNK,
    onWarn: (w) => ui.warn(w),
  })
  ui.plan(manifest, summarize(toWire(manifest)))

  ui.step('正在计算校验值', true)
  await fillHashes(manifest, (done, total) => ui.progress(done, total))
  ui.progressDone()

  // ── 阶段 2：密码 ────────────────────────────────────
  const password = givenPassword ?? await ui.askPassword()
  if (!password) throw new Error('密码不能为空（或两次输入不一致）')

  // ── 阶段 3：密钥 ────────────────────────────────────
  // ⚠️ salt 只在这里生成一次，之后所有地方共用同一个。
  //    早先出过"接收端派生出不同密钥"的问题，表现是"密码明明一样却打不开"。
  const salt = randomBytes(PARAMS.saltBytes)
  const verifier = deriveVerifier(password, salt)
  const keys = deriveKeys(verifier)

  const wire = toWire(manifest, { sentAt: new Date().toISOString() })

  // ── 阶段 4：自赠程序（默认附带）──────────────────────
  //
  // ⚠️ 现在是**一组**文件，不是单个：单文件形态送"产物 + 源码包（源码 + 中英文文档）"，
  //    源码形态送源码包。用户的要求是"送闪传就一起送 EXE、源码还有文档"。
  //
  // ⚠️ 赠品的**磁盘路径**与**内存字节**只能留在本地（下面的 `giftLocals` 侧表），
  //    绝不能 push 进 `wire.files` —— 清单是 `JSON.stringify(wire)` 的产物，
  //    而 `Buffer` 会被序列化成 `{"type":"Buffer","data":[…]}`（约 4~5 倍体积）。
  //    2026-10 实测踩到：源码形态的赠品包 1.3 MB 被塞进清单后变成 **4.97 MB**，
  //    而中继的单条消息上限是 2 MiB —— 报"中继错误：消息过大
  //    （4970349 > 2097169 字节）"，传输当场失败。所有中继用例都带 `--no-gift`，
  //    所以这条**默认路径**一直没人跑过（`_lab/probe-relay-gift.mjs` 是为此补的探针）。
  //    顺带一提：`_giftAbsPath` 还会把发送端的本地绝对路径泄露给接收端。
  const giftLocals = new Map()          // wire.files 下标 → { absPath, bytes }
  if (gift !== false) {
    try {
      const gifts = await makeGifts()
      for (const g of gifts) {
        const { sha256, chunkHashes } = g.absPath
          ? await hashFile(g.absPath, CHUNK)
          : hashBuffer(g.bytes, CHUNK)
        const at = wire.files.length
        wire.files.push({
          kind: g.kind, name: g.name, rel: g.name, size: g.size,
          chunks: Math.max(1, Math.ceil(g.size / CHUNK)),
          chunkBytes: CHUNK, sha256, chunkHashes,
          _gift: true, _giftNote: g.note, _giftPlatform: g.platform,
        })
        giftLocals.set(at, { absPath: g.absPath ?? null, bytes: g.bytes ?? null })
        wire.totalBytes += g.size
        ui.gift(g)
      }
      // `wire.gift` 是给接收端看的一行摘要；多个赠品时列出全部名字
      wire.gift = {
        name: gifts.map((g) => g.name).join(' + '),
        names: gifts.map((g) => g.name),
        kind: gifts[0]?.kind,
        platform: gifts[0]?.platform,
        note: gifts.map((g) => g.note).join('；'),
        count: gifts.length,
      }
    } catch (e) {
      ui.warn(`赠送程序未能生成，继续只发文件：${e.message}`)
    }
  }

  // ── 阶段 4.5：插件追加的文件（`gift/items` 贡献点）──────────
  //
  // 走的是与赠品**完全同一套**机制：内容留在内存（`giftLocals` 侧表），
  // 清单里只放元数据 —— 也就是说，它绝不会撑大加密清单（那条坑见阶段 4 的注释）。
  //
  // ⚠️ 重名**当场报错**，不能放过去：两个文件同 rel 会让接收端的路径冲突检查
  //    中止整个会话（`E_MANIFEST_DUPLICATE_PATH`），而那时用户已经等了很久。
  if (plugins && plugins.count) {
    for (const { plugin, value } of plugins.collect(SLOTS.GIFT_ITEMS)) {
      const item = normalizePluginFile(value, plugin)
      if (wire.files.some((f) => f.rel === item.name)) {
        throw new Error(`插件 ${plugin} 追加的文件名与已经要发送的文件重名：${item.name}\n` +
          '  换个名字再试（同名会让接收端的路径冲突检查中止整个会话）')
      }
      const { sha256, chunkHashes } = hashBuffer(item.data, CHUNK)
      const at = wire.files.length
      wire.files.push({
        kind: 'file', name: item.name, rel: item.name, size: item.data.length,
        chunks: Math.max(1, Math.ceil(item.data.length / CHUNK)),
        chunkBytes: CHUNK, sha256, chunkHashes,
      })
      giftLocals.set(at, { absPath: null, bytes: item.data })
      wire.totalBytes += item.data.length
      ui.info(`插件 ${plugin} 追加了一个文件：${item.name}（${item.data.length} 字节）`)
    }
  }

  // ⚠️ `index` 与 `firstChunk` 必须在**加密之前无条件算好**，不能只在赠品分支里顺手赋值。
  //
  //    从前它们是在上面那个 `if (opts.gift)` 里、加赠品时才算的（"加了赠品要重新编号"）。
  //    于是：**不带赠品**（`--no-gift`）或**赠品生成失败**（那条 catch 只警告不中止）时，
  //    清单里根本没有 `firstChunk` —— 接收端算出的块序号是 `NaN`，
  //    一个块都取不到，界面上只报一句"中继返回 400"或"传输中断"。
  //    默认是带赠品的，所以这条路径一直没被走到，也就一直没暴露。
  //    "块的全局序号"是协议的一部分，不该是某个分支的副作用。
  {
    let g = 0
    wire.files.forEach((f, i) => { f.index = i; f.firstChunk = g; g += f.chunks })
    wire.totalChunks = g
  }

  // ── 阶段 5：加密清单 ────────────────────────────────
  const enc = sealManifest(keys.enc, Buffer.from(JSON.stringify(wire), 'utf8'))

  return {
    manifest, wire,
    salt, verifier, keys, password,
    encManifest: { iv: enc.iv, tag: enc.tag, ct: enc.ct },
    /** 中继房间名（跨网络模式用；由密码派生，单向不可逆） */
    relayRoomName: relayRoomName(keys),
    /** 服务端形式的清单（含磁盘路径），两种模式共用 */
    serverManifest: buildServerManifest(wire, manifest.files, giftLocals),
  }
}

/**
 * 校验插件追加的文件（`gift/items` 的返回值）。
 *
 * 外来输入一律当不可信处理：文件名要过**与接收端同一套**路径规则
 * （`sanitizeRelPath`），内容必须是字节 —— 否则就会变成"发送端造出一个
 * 接收端必然拒绝的清单"，而用户看到的是传输失败。
 *
 * @param {*} value 插件返回的东西
 * @param {string} plugin 插件名（出错信息里要带上，用户得知道是谁的锅）
 * @returns {{name:string, data:Buffer}}
 */
function normalizePluginFile(value, plugin) {
  const fail = (msg) => { throw new Error(`插件 ${plugin} 提供的文件不合法：${msg}`) }
  if (!value || typeof value !== 'object') fail('应当返回 { name, data }')
  const rawName = String(value.name ?? '').trim()
  if (!rawName) fail('缺少 name')
  if (rawName.includes('/') || rawName.includes('\\')) {
    fail(`name 不能带路径分隔符（现在：${rawName}）—— 插件只能追加**单个文件**`)
  }
  let name
  try {
    name = sanitizeRelPath(rawName)      // 与接收端同一套规则（保留名、非法字符…）
  } catch (e) {
    fail(`${rawName} —— ${e?.message ?? e}`)
  }
  const data = value.data
  if (typeof data === 'string') return { name, data: Buffer.from(data, 'utf8') }
  if (Buffer.isBuffer(data)) return { name, data }
  if (data instanceof Uint8Array) return { name, data: Buffer.from(data) }
  fail(`data 必须是字符串 / Buffer / Uint8Array（现在：${Object.prototype.toString.call(data)}）`)
}

/**
 * 把内部清单转成"读盘时要用"的形式。
 *
 * ⚠️ 分工要说清楚：wire 里**没有** absPath —— 那是本地字段，出网前就被剔除了。
 *    所以路径从**原始的 manifest.files** 按序号取回，而不是从 wire 里找。
 *    踩过的坑：只从 wire 取路径会让 absPath 变成 null，
 *    然后 open(null) 报 "The path argument must be of type string"。
 *
 * ⚠️ 赠品是第三条来源：它的路径/字节既不在 wire 里（会撑爆清单，见阶段 4 的注释），
 *    也不在磁盘清单里（它们不是用户选的文件），而是 `giftLocals` 侧表。
 *    三者的下标与 `wire.files` 一一对应，所以这里按 `i` 取。
 *
 * @param {object} wire 线上清单
 * @param {Array} sourceFiles 扫描出来的磁盘文件（下标与 wire.files 前段对应）
 * @param {Map<number,{absPath:?string,bytes:?Buffer}>} [giftLocals] 赠品的本地信息
 */
function buildServerManifest(wire, sourceFiles, giftLocals = new Map()) {
  const files = wire.files.map((f, i) => {
    const src = sourceFiles?.[i]
    const gift = giftLocals.get(i)
    return {
      kind: f.kind, name: f.name, rel: f.rel, size: f.size,
      chunks: f.chunks, chunkBytes: f.chunkBytes,
      sha256: f.sha256, chunkHashes: f.chunkHashes,
      index: i, firstChunk: 0,
      absPath: gift ? (gift.absPath ?? null) : (src?.absPath ?? null),
      _bytes: gift?.bytes ?? null,
      _gift: Boolean(gift),
    }
  })
  let g = 0
  for (const f of files) { f.firstChunk = g; g += f.chunks }
  return { ...wire, files, totalChunks: g }
}
