/**
 * 闪传 Flicker —— 接收模式（电脑当接收方，手机把文件发过来）
 * ==========================================================
 *
 * 为什么要有这条反向的路：手机**不能**起服务让电脑来取（浏览器做不到），
 * 所以只能反过来 —— 电脑起一个 HTTPS 服务，手机在浏览器里把文件**推**上来。
 * 手机端依然是"零安装"的网页，项目的底线没有被破坏（见 `_lab/设计草稿-手机发送端.md`）。
 *
 * 本文件是**顺序**的权威，和 `src/run.js`（发送模式）一一对应：
 *
 *   1. 定密码（短码）→ 2. 生成会话证书 → 3. 自检 → 4. 监听 → 5. 打印链接/二维码/密码
 *   → 6. 等对方发完 → 7. 销毁（密钥、服务、证书、临时文件）
 *
 * ⚠️ 顺序上仍然只有一条硬约束：**先有证书、再监听**。
 *    接收模式不往系统信任库装证书（手机装不了；证书只在本机有意义），
 *    所以发送模式那套"先装信任库再监听"的约束在这里不适用 —— 但"先生成再监听"依然成立，
 *    否则 `https.createServer` 会因为没有 key/cert 直接抛错。
 *
 * ── 与发送模式的差别，逐条写清（免得以后有人以为漏了）──────────
 *   · **不装信任库**：手机那边的"不安全"提示只能手动点过（除非用户自己 `--trust`）。
 *     所以屏幕上必须写清楚"点高级 → 继续前往"，否则用户会以为程序坏了。
 *   · **不需要扫描/清单加密**：要发什么是手机决定的，电脑只负责收、验、落盘。
 *   · **落盘策略不同**：发送端"只读、不碰你的文件"；接收端会**写出新文件**，
 *     所以销毁清单最后一条从"原始文件未被改动"换成"收到的文件已保留在 <目录>"。
 */
import { mkdir, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { homedir } from 'node:os'
import { tty } from './tty.js'
import { Destroyer, bindSignals } from './destroy.js'
import * as trust from './trust.js'
import { toPem } from './x509.js'
import { startReceiveServer, PART_SUFFIX, DEFAULT_LIMITS } from './upload-server.js'
import { suggestCode } from './suite/flicker1.js'
import { dedupePath } from './manifest.js'
import { compareKeyOf } from './path-safety.js'
import { readAsset, ASSET } from './assets.js'
import { buildSessionUrls } from './urls.js'
import { EVENTS } from './plugin/events.js'

/** 手机上打开的那一页（构建期内联：协议内核 + 路径规则 + 中英文文案） */
async function loadPhoneHtml() {
  return readAsset(ASSET.PHONE_HTML)
}

/** 手机上打不出错的默认保存位置：这台电脑的「下载」目录 */
export function defaultSaveDir() {
  return path.join(homedir(), 'Downloads')
}

/**
 * 接收模式主流程。
 *
 * @param {object} opts
 * @param {string} [opts.dir] 存到哪里（默认 下载目录）
 * @param {string} [opts.password] 一次性密码；不给就生成一个短码（`k7m-3fq`）
 * @param {number} [opts.port] [opts.bind]
 * @param {number} [opts.timeoutMs] 等对方发来的超时（默认 10 分钟）
 * @param {boolean} [opts.trust] 是否把会话证书装进本机信任库（默认否：手机用不上）
 * @param {boolean} [opts.ask] 重名时问不问（默认问；`--no-ask` 一律自动改名）
 * @param {object} [opts.limits] 覆盖 `DEFAULT_LIMITS`
 * @param {boolean} [opts.noQr] [opts.noColor] [opts.machine]
 * @param {string} [opts.machineCertFile] 把会话 CA 以 PEM 写到这个路径（自动化用）
 * @param {string} [opts.pageHtml] `GET /` 返回的页面（M2 是手机上传页；这里由调用方给）
 * @param {(info:object)=>void} [opts.onReady]
 * @returns {Promise<{ok:boolean, reason:string, dir:string, files:string[], bytes:number, report:object, urls:object}>}
 */
export async function runRecv(opts = {}) {
  const ui = tty({ noQr: opts.noQr, noColor: opts.noColor, machine: opts.machine })
  const dir = opts.dir ?? defaultSaveDir()
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000
  const signals = bindSignals(new Destroyer({ log: () => {} }))

  let service = null
  try {
    service = await startReceiveService({
      ...opts,
      dir,
      ui,
      onStop: () => ui.cancelAsks(),
      onServiceEvent: opts.onServiceEvent,
    })
    const { urls, password, receive, cert, trusted } = service

    if (opts.machineCertFile) {
      const { writeFile } = await import('node:fs/promises')
      await writeFile(opts.machineCertFile, toPem(cert.caDer), 'utf8')
    }

    ui.recvReady(urls, { password, dir, timeoutMs })
    opts.onReady?.({ urls, port: receive.port, password, dir, receive, cert, trusted })

    // ── 等对方发完 ──────────────────────────────────────
    const result = await waitForReceive(receive, timeoutMs)
    ui.step('正在销毁')
    const report = await service.stop()
    const leftovers = await partFiles(dir)
    if (leftovers.length) {
      // 半成品**故意留下**（设计草稿 §四.3）：它一眼能认出来，也不污染正常文件。
      // 但必须让用户知道它在，否则磁盘上会莫名多出几个 GB。
      ui.warn(`有 ${leftovers.length} 个未完成的文件留在 ${dir}（后缀 ${PART_SUFFIX}）：` +
        leftovers.slice(0, 5).join('、') + (leftovers.length > 5 ? ' 等' : ''))
    }
    ui.destroyReport(report)
    // 插件出错**不打断接收**（对方正在推文件），但绝不能吞掉 —— 屏幕上一行一句
    for (const line of opts.plugins?.errors ?? []) ui.warn(`插件出错：${line}`)
    signals.uninstall()
    const files = receive.report?.done?.map((d) => d.rel) ?? []
    return {
      ok: result.ok, reason: result.reason,
      dir, files, bytes: receive.state.receivedBytes, report, urls,
    }
  } catch (err) {
    if (service) await service.stop().catch(() => {})
    signals.uninstall()
    throw err
  }
}

/**
 * 起一个接收服务（**命令行与图形界面共用同一份实现**）。
 *
 * 这是"一个实现、两个前端"的落点：CLI 拿它接 tty 界面，图形界面拿它接 HTTP 接口，
 * 销毁链也只有一份（`stop()` 的返回就是销毁清单）。两边各写一份的话，
 * 迟早会出现"命令行干净、界面里留下证书"这类差异，而那种差异没人会发现。
 *
 * @param {object} opts
 * @param {string} opts.dir 存到哪里（目录不存在会建）
 * @param {string} [opts.password] 一次性密码；不给就生成 6 位短码
 * @param {string} [opts.bind] [opts.port]
 * @param {object} [opts.limits] 覆盖 `DEFAULT_LIMITS`
 * @param {boolean} [opts.trust] 是否把会话证书装进本机信任库（默认否：手机用不上）
 * @param {boolean} [opts.ask] 重名时问不问（默认问；不传 `onCollision` 时一律自动改名）
 * @param {boolean} [opts.machine] 机器可读：不许停下来等人
 * @param {string|Function} [opts.pageHtml] `GET /` 送出去的页面（默认手机上传页）
 * @param {object} [opts.ui] tty 界面（只有命令行才需要；给了就用它打提示）
 * @param {(evt:object)=>void} [opts.onServiceEvent] 每次会话事件都回调一次（图形界面用它更新状态）
 * @param {()=>number} [opts.onStop] 销毁时先调一次（命令行用它结束挂着的提问）
 * @param {(info:object)=>void} [opts.onReady]
 * @returns {Promise<{urls:object, password:string, dir:string, port:number,
 *   receive:object, cert:object, trusted:boolean, stop:()=>Promise<object>}>}
 */
export async function startReceiveService(opts = {}) {
  const ui = opts.ui ?? null
  const dir = opts.dir ?? defaultSaveDir()
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000   // 只有 tty 那条路用它显示超时
  const plugins = opts.plugins ?? null
  let receive = null, cert = null, trusted = false

  const destroyer = new Destroyer({ log: opts.onDestroyLog })
  const fail = async (err) => {
    registerRecvDestroySteps(destroyer, { receive, cert, trusted, plugins }, { dir, onStop: opts.onStop, ui })
    await destroyer.run().catch(() => {})
    throw err
  }

  try {
    if (plugins?.count) ui?.info(`🧩 已加载 ${plugins.describe()}`)
    await mkdir(dir, { recursive: true })
    const password = opts.password ?? suggestCode()

    // ── 顺手扫掉上次异常退出留下的证书目录 ───────────────
    // 接收模式**每次都会**建一个 `flicker-cert-XXXX/`（见 trust.generateSession），
    // 而它被强杀时来不及删。发送端那条路一直在做这件事（装信任库时顺手清），
    // 接收模式从前没做 —— 于是那些目录只能等下一次"装了信任库的运行"才被收走。
    // `olderThanMs: 60_000` 保证不会动到正在进行的会话（无论哪个进程的）。
    try {
      const swept = await trust.cleanTempDirs()
      if (swept.length) ui?.info(`清理了 ${swept.length} 个上次残留的证书临时目录`)
    } catch { /* 清不掉不该挡住收文件 */ }

    // ── 证书：先生成、先自检，再监听 ─────────────────────
    const ips = trust.localIPv4().map((a) => a.address)
    const hosts = [...new Set([...ips, '127.0.0.1', 'localhost'])]
    const targetHost = ips[0] ?? '127.0.0.1'
    ui?.step(`准备证书（本机地址: ${ips.join(', ') || '仅回环'}）`)
    cert = await trust.generateSession({ hosts })
    try {
      trust.selfCheckOrThrow({ caDer: cert.caDer, srvPem: cert.srvPem, srvDer: cert.srvDer, targetHost })
    } catch (e) {
      // 接收模式没有"装信任库"这一步，所以证书自检失败不一定要中止：
      // 但必须**说出来** —— 一张自检不过的证书，手机那边大概率连"继续前往"都点不过去。
      ui?.warn(`证书自检未通过：${e.message}（手机可能连不上，请把这一行反馈）`)
    }
    if (opts.trust) {
      await trust.trustCa(cert.caDer, cert.dir)
      trusted = true
      ui?.ok(`证书已装入本机信任库（指纹 ${cert.caThumbprint.slice(0, 16)}…）`)
    }

    // ── 同名文件：先问，还是直接改名 ─────────────────────
    const ask = opts.ask !== false
    const onCollision = ask
      ? (opts.onCollision ?? (ui && !opts.machine
        ? async (info) => {
          const guessed = dedupePath(info.rel, new Set([compareKeyOf(info.rel)]))
          return ui.askCollision({ rel: info.rel, existing: info.existing, suggested: guessed })
        }
        : undefined))
      : undefined

    // ── 监听 ────────────────────────────────────────────
    // 手机页面必须**自包含**（协议内核、路径规则、中英文文案都在构建期内联进去了），
    // 所以这里就是把那个文件整段送出去 —— 手机不会再向我们要任何东西。
    const pageHtml = opts.pageHtml ?? await loadPhoneHtml()
    receive = await startReceiveServer({
      dir,
      password,
      pageHtml,
      limits: opts.limits ?? {},
      tls: { key: cert.srvKeyPem, cert: cert.srvPem },
      host: opts.bind ?? '0.0.0.0',
      port: opts.port ?? 0,
      onCollision,
      plugins,
      onEvent: (evt) => {
        opts.onServiceEvent?.(evt)
        if (!ui) return
        if (evt.type === 'peer-connected') ui.peerConnected(evt.peer)
        else if (evt.type === 'authed') {
          ui.authed(evt.peer)
          if (receive?.session?.macProfile === 'v1') {
            ui.warn('对方的页面版本较旧（握手用的旧格式）—— 本次传输一切正常，' +
              '但"防套件降级"这条保护对这次会话不成立。')
          }
        } else if (evt.type === 'auth-failed') ui.authFailed(evt)
        else if (evt.type === 'manifest-received') ui.recvManifest(evt)
        else if (evt.type === 'chunk-received') ui.recvProgress(evt)
      },
    })

    const urls = buildRecvUrls(hosts, receive.port, receive.session.token)
    registerRecvDestroySteps(destroyer, { receive, cert, trusted, plugins }, { dir, onStop: opts.onStop, ui })

    // 插件的"接收服务就绪"——**不含**密码与一次性令牌（那两样不交给插件）
    await plugins?.emitAsyncSafe(EVENTS.RECV_READY, {
      dir,
      port: receive.port,
      tls: true,
      limits: {
        maxFiles: receive.limits.maxFiles,
        maxBytes: receive.limits.maxBytes,
        maxChunkBytes: receive.limits.maxChunkBytes,
      },
    })

    return {
      urls, password, dir, port: receive.port, receive, cert, trusted, hosts,
      /** 销毁：关服务、清密钥、卸证书、删临时文件。**幂等**（Destroyer 自己保证）。 */
      stop: () => destroyer.run(),
    }
  } catch (err) {
    return fail(err)
  }
}

/**
 * 手机上要打开的那个链接。
 *
 * 拼 URL 的代码**只有一份**（`src/urls.js`），发送端与接收模式共用 ——
 * 理由是 IPv6 的方括号：只要有一处漏了，那条路造出来的链接就是打不开的。
 *
 * ⚠️ 接收模式这边仍然**只列 IPv4**：手机扫码走局域网，链路本地 IPv6 用不了、
 *    ULA 又要对方也落在同一个网络里，而且这条路的绑定地址这一轮没有改动。
 *    将来要支持时，把地址加进 `hosts` 即可，不用再改拼 URL 的代码。
 */
function buildRecvUrls(hosts, port, token) {
  return buildSessionUrls(hosts, port, token)
}

/**
 * 等"对方发完 / 超时 / 被销毁"。
 * 与发送模式的 `waitForCompletion` 是同一条思路，判据换成接收端的：
 * `transfer-complete` 只在 `/up/finish` 成功、整文件校验通过之后才发。
 *
 * 导出是给图形界面用的：它也要等同一件事（命令行与界面共用一份判据，
 * 免得出现"命令行认为传完了、界面还在等"这种差异）。
 */
export function waitForReceive(receive, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    let timer = null
    const finish = (r) => {
      if (settled) return
      settled = true
      clearInterval(tick); clearTimeout(timer)
      resolve(r)
    }
    const prev = receive.session.onEvent
    receive.session.onEvent = (evt) => {
      prev(evt)
      if (evt.type === 'transfer-complete') finish({ ok: true, reason: 'complete' })
      else if (evt.type === 'destroyed') {
        finish({ ok: false, reason: 'destroyed' })
      }
    }
    const tick = setInterval(() => {
      if (receive.session.destroyed) finish({ ok: false, reason: 'destroyed' })
    }, 200)
    timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs)
    timer.unref?.()
  })
}

/** 超时这个定时器是"最多等这么久"，不该拖住进程退出（与 tty.askLine 同一个理由） */

/** 目录里剩下的半成品（用来如实报告，不删） */
async function partFiles(dir) {
  try {
    const names = await readdir(dir)
    const out = []
    for (const n of names) {
      if (!n.endsWith(PART_SUFFIX)) continue
      try {
        const st = await stat(path.join(dir, n))
        out.push(`${n}（${st.size} 字节）`)
      } catch { out.push(n) }
    }
    return out
  } catch { return [] }
}

/**
 * 接收模式的销毁链。
 *
 * 与发送模式的差别只有**最后两条**，但这两条正是用户最容易误解的地方：
 *   · 发送端说"原始文件未被改动（本程序只读）"—— 那是发送端的承诺；
 *   · 接收端必须说"收到的文件已保留在 <目录>"，否则用户会以为程序把收到的文件也销毁了。
 */
function registerRecvDestroySteps(destroyer, { receive, cert, trusted, plugins }, { ui, dir, onStop }) {
  destroyer
    // 先把挂着的提问结束掉：否则"电脑上已有同名文件"那个问句会一直等输入，
    // 进程退不出去（表现是 Ctrl+C 之后卡住）。图形界面没有这种挂起的提问 → 记"不适用"。
    .step('未回答的提示已结束', () => {
      const n = onStop?.() ?? 0
      return n > 0            // 没有挂着的提示就记成"不适用"，而不是假装做了一件事
    })
    .step('会话密钥与密码验证值已清零', () => {
      const alive = Boolean(receive?.session && !receive.session.destroyed)
      receive?.session?.destroy()
      return alive || Boolean(receive?.session?.destroyed)
    })
    .step('接收服务已关闭', async () => {
      if (!receive) return false
      await receive.stop()
      return true
    })
    .step('一次性链接已失效', () => Boolean(receive?.session?.destroyed))
    .step('会话证书已从系统信任库移除', async () => {
      if (!trusted || !cert) return false
      return trust.untrustCa(cert.caThumbprint)
    }, { optional: true })
    .step('服务器证书与私钥已从个人证书库移除', async () => {
      if (!cert) return false
      return trust.removeFromMy(cert.srvThumbprint)
    }, { optional: true })
    .step('会话 CA 的本地副本已从个人证书库移除', async () => {
      if (!cert) return false
      return trust.removeFromMy(cert.caThumbprint)
    }, { optional: true })
    .step('临时证书文件已删除', async () => {
      if (!cert?.cleanup) return false
      await cert.cleanup()
      return true
    })
    // 插件登记的资源（定时器、连接、自己开的文件）—— 与发送端同一步、同一个写法。
    // 放在密钥清零之后：插件在清理时不该还能碰到会话密钥。
    // 没有插件时 `asDestroyStep()` 返回 false，销毁清单会记成"不适用"。
    .step('插件资源已释放', () => (plugins ? plugins.asDestroyStep() : false))
    // ⚠️ 这一条与发送端的措辞**必须不同**：接收端写出的是**用户的文件**，不是垃圾。
    .step(`收到的文件已保留在 ${dir}`, () => true)
  return destroyer
}

export { DEFAULT_LIMITS, PART_SUFFIX }
