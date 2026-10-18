/**
 * 闪传 Flicker —— send / recv 主流程
 * =================================
 *
 * 本文件是"顺序"的唯一权威。启动顺序的硬约束（全部来自实测，见 架构决策.md §4.3）：
 *
 *   1. 生成证书 → 2. 自检 → 3. 清理残留 → 4. 装入信任库
 *   → 5. 监听 → 6. 就绪探测 → 7. 才允许打开浏览器窗口
 *
 * 顺序错了会出现两类极难排查的故障：
 *   · 先监听后装证书 → 浏览器缓存了证书错误，之后装证书也不生效
 *   · 服务未就绪就开窗口 → --app=<url> 停在一个不会自动重试的错误页上
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { formatSize } from './manifest.js'
import { PARAMS } from './suite/flicker1.js'
import { Session } from './session.js'
import { TransferServer } from './server.js'
import * as trust from './trust.js'
import { Destroyer, bindSignals } from './destroy.js'
import { tty } from './tty.js'
import { prepareSession } from './prepare.js'
import { chooseChunkBytes, describeChunk } from './chunk-size.js'
import { rootDir, readAsset, ASSET } from './assets.js'
import { toPem } from './x509.js'
import { buildSessionUrls } from './urls.js'
import { EVENTS } from './plugin/events.js'
import { manifestSummary, transferSummary } from './plugin/payload.js'
import { wrapUiForPlugins } from './plugin/ui.js'

// DER → PEM 只有一份实现（`src/x509.js`）。这里转出去，是因为历史上它属于本模块的公开 API：
// 自动化客户端（`--machine-cert`）拿到的必须是 PEM 文本，测试也从这里取。
// ⚠️ 从前这里另写了一份一模一样的 —— 两份实现在源码目录里相安无事，
//    打成一个文件时才撞名（打包器拒绝构建）。重复定义本身就是问题。
export { toPem }

/**
 * 读取接收端页面。
 * 走 assets.js 的统一入口 —— 源码模式读盘，SEA 模式读内嵌资产。
 */
async function loadReceiverHtml() {
  return readAsset(ASSET.RECEIVER_HTML)
}

/**
 * 发送方主流程。
 *
 * @param {object} opts
 * @param {string[]} opts.inputs 要发送的文件/目录
 * @param {string} [opts.password] 指定密码；不指定则交互生成并二次确认
 * @param {number} [opts.port]
 * @param {string} [opts.bind]
 * @param {number} [opts.timeoutMs]
 * @param {boolean} [opts.gift] 是否附带赠送程序（默认 true）
 * @param {boolean} [opts.installCert] 是否往信任库装证书（默认 true）
 * @param {boolean} [opts.noQr] [opts.noColor]
 * @param {boolean} [opts.dryRun]
 * @param {(info:object)=>void} [opts.onReady] 服务就绪后的回调（GUI 用它开窗口）
 */
export async function runSend(opts) {
  // 插件：注册表由入口（bin/flicker.js）建好传进来；没有插件时它是个 count=0 的空壳，
  // 于是下面所有 `plugins?.` 都不需要条件判断，也不会改变任何现有行为。
  const plugins = opts.plugins ?? null
  const ui = wrapUiForPlugins(tty({ noQr: opts.noQr, noColor: opts.noColor, machine: opts.machine }), plugins)
  const destroyer = new Destroyer({ log: (m) => ui.destroyLog(m) })
  const signals = bindSignals(destroyer)
  let server = null, session = null, cert = null, ctx = null
  let trusted = false

  try {
    // ── 阶段 1–5：扫描、哈希、密码、密钥、清单、赠品 ──────
    // 这一整段与中继模式**完全共用**（见 src/prepare.js）。
    // 不复制一份的理由很实际：这里有"盐只生成一次""赠品要重新编号"之类的约束，
    // 复制出去迟早会漂移，而漂移的表现是"另一种模式莫名其妙打不开"。
    // ── 块大小：局域网没有中继那条"单条消息上限"，但同一条 BDP 判据仍然成立 ──
    //    实测（256 MiB，RTT 0）：1 MiB 25.2 MB/s、2 MiB 27.5、4 MiB 26.5 ——
    //    局域网里块大小几乎不影响吞吐，取自动值即可（2 MiB）。
    const chunkChoice = chooseChunkBytes({ spec: opts.chunk ?? { kind: 'auto' }, maxMessageBytes: Infinity })
    // 说清楚用了多大的块：它决定接收端的预取缓冲（6 × 块大小），
    // 也会出现在清单里（接收端按它分块）。局域网没有中继那条约束，所以只有这一个来源。
    if (chunkChoice.chunkBytes !== PARAMS.chunkBytes) {
      ui.info(`块大小 ${describeChunk(chunkChoice.chunkBytes)}`)
    }
    await plugins?.emitAsync(EVENTS.RUN_START, {
      mode: 'lan', inputs: [...(opts.inputs ?? [])], chunkBytes: chunkChoice.chunkBytes,
    })
    const prep = await prepareSession({
      inputs: opts.inputs, password: opts.password, gift: opts.gift, ui, plugins,
      chunkBytes: chunkChoice.chunkBytes,
    })
    const { manifest, wire, salt, verifier, keys, password } = prep
    const enc = { iv: prep.encManifest.iv, tag: prep.encManifest.tag, ct: prep.encManifest.ct }
    await plugins?.emitAsync(EVENTS.MANIFEST_SCANNED, {
      mode: 'lan', chunkBytes: chunkChoice.chunkBytes, summary: manifestSummary(wire),
    })

    if (opts.dryRun) {
      ui.info('（--dry-run）只列出清单，未启动传输')
      // ⚠️ 干跑也要释放插件资源：插件在 `run/start` 里就可能已经开了东西，
      //    漏掉这一步等于"干跑一次留下一个插件资源"。
      destroyer.step('插件资源已释放', () => (plugins ? plugins.asDestroyStep() : false))
      await destroyer.run()
      return { dryRun: true }
    }

    // ── 阶段 6：证书（局域网模式专属）────────────────────
    // 中继模式不需要这一步 —— 那是它比局域网模式更简单的地方：
    // 没有自签证书、没有防火墙、没有"对方能不能访问到我"的问题。
    const ips = trust.localIPv4().map((a) => a.address)
    // IPv6：只在"可能对别人有意义"时才收（全局 / ULA），见 trust.classifyIPv6 的说明。
    // 本机这条线路上一个全局 IPv6 都没有（运营商大内网），所以这里通常是空数组 ——
    // 但代码路径是真的，`test/ipv6.test.js` 用回环 `::1` 把它端到端验过。
    const ips6 = trust.localIPv6().map((a) => a.address)
    const certHosts = [...new Set([...ips, ...ips6, '127.0.0.1', 'localhost'])]
    const targetHost = ips[0] ?? ips6[0] ?? '127.0.0.1'
    ui.step(`准备证书（本机地址: ${[...ips, ...ips6].join(', ') || '仅回环'}）`)

    // ⚠️ 环境变量与 `--no-cert-install` 等价，专供 CI 用。
    //    原因很实在：把根证书装进"当前用户\Root"会弹出**系统确认框**，
    //    真机上是用户点的（2026-10 用户确认："Windows 的证书安装之前都是我点的"），
    //    而 CI 上没有人在，certutil 就会一直等下去 —— 第一次 CI 就是因此挂了 25 分钟。
    //    所以 CI 用 `FLICKER_NO_CERT_INSTALL=1` 跳过这一步；这条能力在真机上照旧验。
    const installCert = Boolean(opts.installCert) && process.env.FLICKER_NO_CERT_INSTALL !== '1'
    if (process.env.FLICKER_NO_CERT_INSTALL === '1' && opts.installCert) {
      ui.info('FLICKER_NO_CERT_INSTALL=1：本次不往系统信任库装证书（自动化场景；对方会看到一次"不安全"提示）')
    }
    const certSupport = trust.support()
    if (installCert && !certSupport.supported) {
      ui.warn(certSupport.detail)
      // 愿意自己动手的用户，给出确切命令。
      // 为什么打印而不是代跑：macOS 必然弹认证对话框、Linux 必然要装额外软件包 ——
      // 这两件事都不该由程序在启动路径上替用户决定（见 trust.support() 的注释）。
      const hint = trust.manualTrustHint()
      if (hint.length) {
        ui.info('想让它也零警告，可以自己把 CA 装进信任库（本次会话的证书是临时的，默认不落盘）：')
        for (const line of hint) ui.info(`    ${line}`)
      }
    }
    const willTrust = Boolean(installCert && certSupport.supported)

    if (willTrust) {
      // 约束 2：先清掉上次异常退出留下的**所有**残留（Root + My + 临时目录）
      //
      // ⚠️ 清理失败要**说出来**，不能装作干净。
      //    "读不到证书库"（例如 PowerShell 的 Cert: 盘不可用）从前会被当成
      //    "没有残留"，于是那张上次留下的 CA 一直躺在用户的信任库里 ——
      //    一个看起来在检查、实际什么都没查到的判据，是本项目最忌讳的一类错误。
      //    注意这里只**告警不中止**：清理是自愈动作，不该因为读不到库就让用户传不了文件。
      let resid = { root: [], my: [], failed: [] }
      try {
        resid = await trust.cleanAllLeftovers()
        const tempDirs = await trust.cleanTempDirs()
        const n = resid.root.length + resid.my.length
        if (n) ui.info(`清理了 ${n} 张上次残留的证书（信任库 ${resid.root.length} · 证书库 ${resid.my.length}）`)
        if (tempDirs.length) ui.info(`清理了 ${tempDirs.length} 个上次残留的临时目录`)
        for (const f of resid.failed) ui.warn(`残留清理失败: ${f}`)
      } catch (e) {
        ui.warn('无法读取系统证书库，本次**跳过了残留证书自扫**：' +
          `${e?.message ?? e}\n` +
          '  （若上次是异常退出，可能有一张旧的会话 CA 还留在信任库里；' +
          '可在「证书管理器 → 受信任的根证书颁发机构」里删除 Flicker Session CA）')
      }
    }

    cert = await trust.generateSession({ hosts: certHosts })
    // 约束 1：装进信任库之前必须自检。
    // 这一步能挡掉"生成的 CA 没有 CA 标志"那类故障 ——
    // 它在浏览器里表现为 ERR_CERT_INVALID，与"签发者不认识"极难区分。
    try {
      trust.selfCheckOrThrow({
        caDer: cert.caDer, srvPem: cert.srvPem, srvDer: cert.srvDer, targetHost,
      })
    } catch (e) {
      if (willTrust) throw e      // 要装信任库就必须是张好证书
      ui.warn(`证书自检未通过：${e.message}`)
    }

    if (willTrust) {
      await trust.trustCa(cert.caDer, cert.dir)
      trusted = true
      ui.ok(`证书自检通过并已装入信任库（指纹 ${cert.caThumbprint.slice(0, 16)}…）`)
    } else {
      ui.warn('未装入信任库：接收端首次打开会出现一次安全提示，点"继续访问"即可')
    }

    session = new Session({
      salt, verifier,
      encManifest: enc.ct, manifestIv: enc.iv, manifestTag: enc.tag,
      onEvent: (evt) => {
        if (evt.type === 'peer-connected') ui.peerConnected(evt.peer)
        else if (evt.type === 'authed') {
          ui.authed(evt.peer)
          // 降级保护的结果要**说出来**：对方是旧版页面时，这次握手用的是不绑套件的旧构造，
          // "套件协商防降级"这条保护对本次会话不成立。宁可多一句提示，也不假装安全。
          if (session.macProfile === 'v1') {
            ui.warn('对方的程序版本较旧（握手用的旧格式）—— 本次传输一切正常，' +
              '但"防套件降级"这条保护对这次会话不成立。介意的话请让对方用同版本的程序。')
          }
        } else if (evt.type === 'auth-failed') ui.authFailed(evt)
        else if (evt.type === 'chunk') ui.chunkProgress(evt)
        else if (evt.type === 'transfer-complete') ui.transferComplete(evt)
      },
    })

    // ── 阶段 7：监听（必须在证书装好之后 —— 约束 3）──────
    const html = await loadReceiverHtml()
    server = new TransferServer({
      session, manifest: prep.serverManifest, receiverHtml: html,
      limiter: opts.limiter ?? null,
    })

    /**
     * 绑定哪个地址 —— IPv6 就在这里落地。
     *
     * · 本机有可用的 IPv6（全局/ULA）→ 绑 `::`（**双栈**：IPv6 与 IPv4 都能连进来，
     *   这样证书里那些 IPv6 SAN 才不是一句空话）
     * · 否则 → 保持原来的 `0.0.0.0`（行为不变）
     *
     * ⚠️ 绑 `::` 可能失败（系统禁用了 IPv6、或权限受限）。**失败就回落 IPv4，
     *    并且把 IPv6 从链接候选里删掉** —— 绝不能广告一个我们没在监听的地址：
     *    那种"链接打得开但连不上"的失败，用户只会以为是自己的网有问题。
     */
    const wantIPv6 = ips6.length > 0 && !opts.bind
    let bindHost = opts.bind ?? (wantIPv6 ? '::' : '0.0.0.0')
    let ipv6Lost = false
    let port
    try {
      port = await server.listen({
        // ⚠️ 用 PEM 的 {key, cert}，**不是** pfx。
        //    Node 没有生成 PKCS#12 的 API，而 https.createServer 本来就收 PEM ——
        //    所以纯 JS 生成证书之后，这里直接给 PEM，不必再绕一次打包。
        //    （cert.pfx 现在是 null：那是给调用方的一个明确信号，见 trust.generateSession。）
        key: cert.srvKeyPem, cert: cert.srvPem,
        host: bindHost, port: opts.port ?? 0,
      })
    } catch (e) {
      if (!wantIPv6) throw e
      ipv6Lost = true
      bindHost = '0.0.0.0'
      ui.warn(`这台机器的 IPv6 监听不上（${e?.code ?? e?.message ?? e}），本次只用 IPv4 —— ` +
        '链接里不会再出现 IPv6 地址')
      port = await server.listen({
        key: cert.srvKeyPem, cert: cert.srvPem, host: '0.0.0.0', port: opts.port ?? 0,
      })
    }

    /** 只列**真的在监听**的地址：IPv6 丢了就把它从链接候选里剔除（证书里的 SAN 留着无害） */
    const urlHosts = ipv6Lost ? certHosts.filter((h) => !ips6.includes(h)) : certHosts

    // 机器可读模式：把 CA 证书写到调用方指定的路径，
    // 供自动化客户端（脚本、集成测试）把它加进自己的信任列表。
    // 注意这不改系统信任库 —— 只是把证书字节交给调用方自己决定怎么用。
    if (opts.machineCertFile) {
      const { writeFile } = await import('node:fs/promises')
      // ⚠️ 必须是 PEM 文本，不能是 DER 字节。
      // Node 的 tls ca 选项接受 PEM 字符串；直接给 DER Buffer 会报
      // SELF_SIGNED_CERT_IN_CHAIN（这个坑是集成测试抓出来的）。
      // PEM 同时也是 curl、浏览器、openssl 通用的格式。
      await writeFile(opts.machineCertFile, toPem(cert.caDer), 'utf8')
    }

    const urls = buildSessionUrls(urlHosts, port, session.token)
    ui.showUrls(urls, {
      password,
      trusted,
      timeoutMs: opts.timeoutMs ?? 10 * 60 * 1000,
      // 前 8 位足够人核对，也足够撞不上（同一次会话里只有一张证书）
      fingerprint: cert?.srvFingerprint ? cert.srvFingerprint.slice(0, 8) : null,
    })

    // ── 阶段 8：就绪探测（约束 3b）──────────────────────
    // 必须确认服务真的能返回响应，才允许开窗口。
    // 否则 --app=<url> 会停在一个 ERR_CONNECTION_REFUSED 错误页上且不会自动重试。
    // ⚠️ 探测 **/api/health**，不是接收页地址 —— 后者带一次性令牌，
    //    探测本身会把令牌消费掉，真正的用户打开链接就会看到"链接已失效"。
    //    服务可用性的探测必须无副作用。这个坑是 test/startup-order.test.js 抓出来的。
    const healthUrl = new URL('/api/health', urls.loopback).toString()
    const ready = await server.waitReady(healthUrl, { caDer: cert.caDer })
    if (ready.ok) {
      ui.ok(`服务就绪（探测 ${ready.attempts} 次）—— 并已用真实 TLS 握手验证证书可用`)
    } else if (ready.reason === 'cert') {
      // 本机拿会话 CA 都验不过这张证书 —— 接收端一定也连不上。
      // 这类失败与"连不上"的修法完全相反，所以分开报，别把用户引去查防火墙。
      ui.warn(`证书自检未通过（${ready.detail}）—— 本机用会话 CA 都无法完成 TLS 握手，` +
        '接收端也一定连不上。这是证书本身的问题（自检与握手是两道独立的检查），' +
        '请把这一行连同上面的证书指纹一起反馈')
    } else if (ready.reason === 'nocert') {
      // 走到这里说明代码有问题，不是环境问题 —— 说出来，别静默当成"就绪"
      ui.warn(`就绪探测未执行（${ready.detail}）—— 这是程序内部的错误，请反馈`)
    } else {
      ui.warn(`本机自检未通过（${ready.detail}）—— 若对方连不上，请检查防火墙设置`)
    }

    // ⚠️ 这一行是约束 3b 的落点，别删、也别往上挪。
    //    它必须排在 waitReady **之后** —— 图形界面收到这个回调才去开浏览器窗口，
    //    而在服务确认可用之前开窗口，用户会看到 ERR_CONNECTION_REFUSED 且不会自动重试。
    //    （曾经漏掉过这个调用：四条约束里这条只落实了一半，页面因此永远拿不到链接。）
    opts.onReady?.({ urls, port, password, session, server, cert, ready })

    ctx = { session, server, cert, trusted, keys, verifier, salt, plugins }

    // ── 阶段 9：等待完成 ────────────────────────────────
    const result = await waitForCompletion(session, opts.timeoutMs ?? 10 * 60 * 1000)
    await plugins?.emitAsync(EVENTS.TRANSFER_COMPLETE, transferSummary({
      mode: 'lan', ok: result.ok, reason: result.reason,
      bytes: session.bytesSent, fileCount: wire.files.length,
    }))
    ui.step('正在销毁')
    registerDestroySteps(destroyer, ctx)
    const report = await destroyer.run()
    ui.destroyReport(report)
    signals.uninstall()
    return {
      ok: result.ok, reason: result.reason,
      bytes: session.bytesSent, files: wire.files.length, report, urls,
    }
  } catch (err) {
    if (ctx || session || server || cert) {
      registerDestroySteps(destroyer, ctx ?? { session, server, cert, trusted, keys: null, plugins })
      await destroyer.run().catch(() => {})
    }
    signals.uninstall()
    throw err
  }
}


/**
 * 链接的构造现在在 `src/urls.js` —— **发送端与接收模式共用一份**。
 * 从前这里有一个 `buildUrls`，`recv.js` 里还有一个 `buildRecvUrls`；
 * 加 IPv6 方括号时只要一处漏了，那条路造出来的链接就是打不开的。
 */

/** 等待传输完成 / 超时 / 被销毁 */
function waitForCompletion(session, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (r) => {
      if (settled) return
      settled = true
      clearInterval(tick); clearTimeout(timer)
      resolve(r)
    }
    const prev = session.onEvent
    session.onEvent = (evt) => {
      prev(evt)
      if (evt.type === 'transfer-complete') finish({ ok: true, reason: 'complete' })
      else if (evt.type === 'destroyed') finish({ ok: session.bytesSent > 0, reason: 'destroyed' })
    }
    const tick = setInterval(() => {
      if (session.destroyed) finish({ ok: session.bytesSent > 0, reason: 'destroyed' })
    }, 200)
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs)
  })
}

/** 把所有需要清理的东西登记到销毁器（顺序有意义） */
function registerDestroySteps(destroyer, { session, server, cert, trusted, plugins }) {
  destroyer
    .step('会话密钥与密码验证值已清零', () => {
      const alive = Boolean(session && !session.destroyed)
      session?.destroy()
      return alive || Boolean(session?.destroyed)
    })
    .step('发送端服务已关闭', async () => {
      if (!server) return false
      await server.shutdown()
      return true
    })
    .step('一次性链接已失效', () => Boolean(session?.destroyed))
    .step('会话证书已从系统信任库移除', async () => {
      if (!trusted || !cert) return false
      return trust.untrustCa(cert.caThumbprint)
    })
    .step('服务器证书与私钥已从个人证书库移除', async () => {
      if (!cert) return false
      return trust.removeFromMy(cert.srvThumbprint)
    })
    .step('会话 CA 的本地副本已从个人证书库移除', async () => {
      // ⚠️ New-SelfSignedCertificate 会把 CA 也放进 My 库。
      //    只清 Root 的话，My 库会悄悄积累残留 —— 这是实测发现的问题。
      if (!cert) return false
      return trust.removeFromMy(cert.caThumbprint)
    })
    .step('临时证书文件已删除', async () => {
      if (!cert?.cleanup) return false
      await cert.cleanup()
      return true
    })
    // ⚠️ 插件资源必须**由销毁链来释放**，不能指望插件自觉。
    //    "所有传输用到的东西都是一次性的"这句承诺，对插件也要成立 ——
    //    否则用户没法区分"核心干净了、插件还留着东西"。
    //    插件的清理动作统一走 `ctx.effect()` 登记（见 src/plugin/context.js）。
    .step('插件资源已释放', () => (plugins ? plugins.asDestroyStep() : false))
    .step('原始文件未被改动（本程序只读）', () => true)
  return destroyer
}
