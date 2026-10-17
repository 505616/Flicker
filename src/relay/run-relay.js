/**
 * 中继模式：发送端主流程
 * ======================
 * 与局域网模式（src/run.js 的 runSend）**共用**扫描、哈希、密码、密钥派生、
 * 清单加密、自赠程序、销毁登记 —— 差异只在数据怎么走。
 *
 * 所以这里不复制那套流程，而是调用共用的 prepare()（见 src/prepare.js），
 * 然后换上中继的驱动循环。
 */
import { PARAMS } from '../suite/flicker1.js'
import { Destroyer, bindSignals } from '../destroy.js'
import { tty } from '../tty.js'
import { RelaySender } from './sender.js'
import { prepareSession } from '../prepare.js'
import { chooseChunkBytes, fetchRelayCaps, describeChunk } from '../chunk-size.js'
import { EVENTS } from '../plugin/events.js'
import { manifestSummary, transferSummary } from '../plugin/payload.js'
import { wrapUiForPlugins } from '../plugin/ui.js'

/**
 * @param {object} opts 与 runSend 相同的选项，外加：
 * @param {string} opts.relay 中继地址
 */
export async function runSendViaRelay(opts) {
  const plugins = opts.plugins ?? null
  const ui = wrapUiForPlugins(tty({ noQr: opts.noQr, noColor: opts.noColor, machine: opts.machine }), plugins)
  const destroyer = new Destroyer({ log: (m) => ui.destroyLog(m) })
  const signals = bindSignals(destroyer)
  let sender = null

  try {
    // ── 能力协商：先问中继"一条消息最多收多大"，再决定块大小 ──
    //
    // ⚠️ 顺序不能反：块大小必须在**扫描与哈希之前**定下来（清单里的
    //    `chunkBytes` 与逐块哈希都依赖它），所以不能等 RelaySender 建好再问。
    //    中继老到没有这个字段时回落到协议保证的最小值 —— 新客户端 + 老中继不会坏。
    const caps = await fetchRelayCaps(opts.relay)
    const { chunkBytes, reason } = chooseChunkBytes({
      spec: opts.chunk ?? { kind: 'auto' }, maxMessageBytes: caps.maxMessageBytes,
    })
    if (chunkBytes !== PARAMS.chunkBytes || reason !== 'ok') {
      ui.info(`块大小 ${describeChunk(chunkBytes)}（中继允许单条 ${describeChunk(caps.maxMessageBytes)}` +
        `${caps.legacy ? '，对方未声明，按协议最小值' : ''}）` +
        (reason === 'relay-limit' && !caps.legacy ? ' —— 已按中继的上限压低' : ''))
    }

    // 扫描 / 哈希 / 密码 / 密钥 / 清单 / 赠品 —— 与局域网模式完全同一套
    await plugins?.emitAsync(EVENTS.RUN_START, {
      mode: 'relay', inputs: [...(opts.inputs ?? [])], chunkBytes,
    })
    const prep = await prepareSession({ ...opts, ui, plugins, chunkBytes })
    const { manifest, wire, encManifest, keys, salt, password } = prep
    await plugins?.emitAsync(EVENTS.MANIFEST_SCANNED, {
      mode: 'relay', chunkBytes, summary: manifestSummary(wire),
    })

    // 中继模式下不需要本地 HTTPS 服务，也就不需要证书。
    // 这是它比局域网模式**更简单**的地方：没有自签证书、没有防火墙、没有 IP 可达性。
    ui.step(`连接中继 ${opts.relay}`)

    sender = new RelaySender({
      baseUrl: opts.relay,
      roomName: prep.relayRoomName,
      encKey: keys.enc,
      salt,
      manifest: prep.serverManifest,
      encManifest,
      pollMs: 300,
      windowSize: opts.windowSize ?? 8,
      limiter: opts.limiter ?? null,
      onEvent: (evt) => {
        if (evt.type === 'relay-chunk') ui.chunkProgress({
          fileName: evt.fileName, bytes: evt.bytes,
          sentBytes: evt.sentBytes, totalBytes: evt.totalBytes,
        })
        else if (evt.type === 'relay-complete') ui.transferComplete({ bytes: evt.posted })
        else if (evt.type === 'relay-gone') ui.warn('房间已消失（可能已过期，或对方关掉了页面）')
      },
    })

    const link = await sender.start()

    // 链接里带上盐（放在 fragment 里，中继看不到）
    ui.relayReady(link, {
      password, room: prep.relayRoomName,
      timeoutMs: opts.timeoutMs ?? 15 * 60 * 1000,
    })

    // 就绪探测：中继模式下要确认中继真的可达 ——
    // 局域网模式的教训（探测用了带副作用的端点，把一次性令牌吃掉）在这里不适用，
    // 因为中继的房间名就是凭据、GET 状态没有副作用。
    const reachable = await probeRelay(opts.relay, prep.relayRoomName)
    if (reachable.ok) ui.ok(`中继可达（探测 ${reachable.attempts} 次）`)
    else {
      ui.warn(`中继探测未通过（${reachable.detail}）—— 请确认地址与网络`)
    }

    const result = await sender.run({
      timeoutMs: opts.timeoutMs ?? 15 * 60 * 1000,
      shouldStop: () => ui.stopped?.() === true,
    })

    // ⚠️ 没传完就要**说出来**。中继模式的完成判据是"接收端确认了全部消息"，
    //    所以这里失败的含义是"对方可能没拿全"，而不是"我们没发出去" ——
    //    两者对用户的意义完全不同（前者要重传，后者要查网络）。
    //    从前这里什么都不打印，只让进程以非零码退出：用户看到一个销毁清单，
    //    却不知道到底传成功没有。
    if (!result.ok) {
      if (result.reason === 'timeout') {
        ui.warn('等不到接收端的确认 —— 对方可能已经关掉页面或断网。' +
          '已投出的数据对方只收到了一部分，请重新发起一次传输')
      } else if (result.reason === 'incomplete') {
        ui.warn(`传输没有完成：已投出 ${result.posted ?? '?'}/${result.total ?? '?'} 条，` +
          `接收端确认了 ${result.ackedBase ?? '?'} 条`)
      } else if (result.reason === 'room-gone') {
        ui.warn('中继上的房间在传输结束前就消失了（可能已过期，或对方取消了）')
      } else if (result.reason === 'aborted') {
        ui.warn('传输已被取消')
      }
    }

    ui.step('正在销毁')
    await plugins?.emitAsync(EVENTS.TRANSFER_COMPLETE, transferSummary({
      mode: 'relay', ok: result.ok, reason: result.reason,
      bytes: sender.client.bytesPosted, fileCount: wire.files.length,
    }))
    destroyer
      .step('中继房间已销毁', async () => sender.destroy())
      .step('会话密钥已清零', () => {
        for (const k of [keys.enc, keys.room, keys.auth, salt]) k?.fill?.(0)
        return true
      })
      // ⚠️ 插件资源由销毁链释放（与局域网模式同一条承诺）。
      //    插件的清理动作统一走 `ctx.effect()` 登记，见 src/plugin/context.js。
      .step('插件资源已释放', () => (plugins ? plugins.asDestroyStep() : false))
      .step('原始文件未被改动（本程序只读）', () => true)
    const report = await destroyer.run()
    ui.destroyReport(report)
    signals.uninstall()

    return {
      ok: result.ok, reason: result.reason,
      bytes: sender.client.bytesPosted, files: wire.files.length, report, link,
    }
  } catch (err) {
    try { await sender?.destroy() } catch { /* 尽力而为 */ }
    // 插件资源也要尽力释放 —— 出错路径上同样不能让它们留在进程里
    try { await plugins?.dispose() } catch { /* 尽力而为 */ }
    signals.uninstall()
    throw err
  }
}

/** 探测中继是否可达（无副作用：只读房间状态） */
async function probeRelay(baseUrl, roomName, timeoutMs = 8000) {
  const url = `${baseUrl.replace(/\/+$/, '')}/r/${roomName}`
  const deadline = Date.now() + timeoutMs
  let attempts = 0, lastErr = ''
  while (Date.now() < deadline) {
    attempts++
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2500) })
      if (r.status < 500) return { ok: true, attempts, detail: `HTTP ${r.status}` }
      lastErr = `HTTP ${r.status}`
    } catch (e) {
      lastErr = e?.cause?.code ?? e?.name ?? String(e)
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  return { ok: false, attempts, detail: lastErr }
}
