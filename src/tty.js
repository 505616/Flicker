/**
 * 终端界面（TTY 前端）
 * ====================
 * 设计见 UI设计.md 第三章。两条硬约束：
 *   1. 不引入任何 TUI 依赖 —— 只用 ANSI 转义码 + Unicode 框线 + 块字符
 *   2. 老终端要能降级 —— --no-color 时退回纯 ASCII
 *
 * 与 GUI 前端的关系：两者渲染的是同一批事件（src/run.js 里注册的那些回调），
 * 所以业务逻辑一份都不重复。
 */
import { createInterface } from 'node:readline'
import { formatSize } from './manifest.js'
import { suggestPassword } from './suite/flicker1.js'
import { describeUA } from './server.js'
import { GIFT_KIND } from './gift.js'

const W = 54          // 框内宽度

/**
 * @param {object} [opts]
 * @param {boolean} [opts.noQr] 不显示二维码
 * @param {boolean} [opts.noColor] 不使用颜色（自动降级用）
 * @param {boolean} [opts.machine] 机器可读模式（只输出 __READY__ 行）
 * @param {NodeJS.WritableStream} [opts.stdout] 输出流，默认 process.stdout
 * @param {NodeJS.WritableStream} [opts.stderr] 错误流，默认 process.stderr
 * @param {NodeJS.ReadableStream} [opts.stdin] 输入流，默认 process.stdin
 *
 * 允许注入三个流是刻意的：测试就不必去劫持 process.stdout（实测在某些
 * Node 版本上不可靠），TTY 层也因此与全局对象解耦。
 */
export function tty({ noQr = false, noColor = false, machine = false,
  stdout = process.stdout, stderr = process.stderr, stdin = process.stdin } = {}) {
  // NO_COLOR 环境变量与不支持 TTY 时自动降级
  const color = !noColor && process.env.NO_COLOR === undefined && stdout.isTTY !== false
  const C = {
    reset: color ? '\x1b[0m' : '', dim: color ? '\x1b[2m' : '', bold: color ? '\x1b[1m' : '',
    cyan: color ? '\x1b[36m' : '', blue: color ? '\x1b[94m' : '', green: color ? '\x1b[32m' : '',
    yellow: color ? '\x1b[33m' : '', red: color ? '\x1b[31m' : '', inv: color ? '\x1b[7m' : '',
  }
  const out = (s = '') => stdout.write(s + '\n')
  const err = (s = '') => stderr.write(s + '\n')
  const box = (title, lines) => {
    const t = title ? ` ${title} ` : ''
    out(`${C.dim}┌${t}${'─'.repeat(Math.max(0, W - t.length))}┐${C.reset}`)
    for (const l of lines) {
      const visible = stripAnsi(l)
      out(`${C.dim}│${C.reset} ${l}${' '.repeat(Math.max(0, W - visible.length - 1))}${C.dim}│${C.reset}`)
    }
    out(`${C.dim}└${'─'.repeat(W)}┘${C.reset}`)
  }
  const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '')

  let lastProgressLen = 0
  const inlineProgress = (line) => {
    const pad = Math.max(0, lastProgressLen - stripAnsi(line).length)
    stdout.write('\r' + line + ' '.repeat(pad))
    lastProgressLen = stripAnsi(line).length
  }

  /** 还挂着的提问（销毁时要能全部结束，否则进程会一直等输入） */
  const pendingAsks = new Set()

  /**
   * 画一个"把链接给对方"的框：链接 + 二维码 + 附加说明。
   *
   * ⚠️ 链接**不一定放得进框里**：`https://192.168.1.5:41510/?k=<22 字符令牌>` 就是 53 列，
   *    而框内只有 54 列（还要减去左侧那个空格）。放不下时硬塞进去的表现是
   *    **链接紧贴着右边框**，看着像被截断了 —— 用户会怀疑链接少了一截。
   *    所以：放得下就放框里；放不下就**把链接单独打一行**（在框外，照样醒目），框里只留二维码。
   *    三种模式（局域网发送 / 中继 / 接收）共用这一处，免得只修好其中一条路。
   */
  const boxedLink = (title, url, { qrCaption = '扫码直接打开', extra = [] } = {}) => {
    const long = visibleLen(url) > W - 2
    const lines = []
    if (!long) lines.push(`${C.blue}${url}${C.reset}`, '')
    if (!noQr) {
      for (const l of qrLines(url)) lines.push(`   ${l}`)
      lines.push(`${C.dim}   ${qrCaption}${C.reset}`)
    }
    if (long && noQr) lines.push(`${C.dim}   链接较长，已单独打印在下面${C.reset}`)
    if (extra.length) {
      lines.push('')
      lines.push(...extra)
    } else if (!long) {
      lines.push('')
    }
    box(title, lines)
    if (long) {
      out()
      out(`  ${C.blue}${url}${C.reset}`)
    }
  }

  /** "还有多久超时"要说成人话：`--timeout=30s` 打印"0 分钟"没有意义 */
  const describeWait = (ms) => {
    const s = Math.round(ms / 1000)
    if (s < 60) return `${s} 秒`
    const m = Math.round(s / 60)
    if (m < 60) return `${m} 分钟`
    return `${(m / 60).toFixed(m % 60 ? 1 : 0)} 小时`
  }

  const api = {
    // ── 基本输出 ─────────────────────────────────────────
    banner() {
      out()
      out(`  ${C.cyan}⚡ 闪传 Flicker${C.reset} ${C.dim}· 一次性文件传输 · 用完即销毁${C.reset}`)
      out()
    },
    step(msg, spinner = false) {
      if (spinner) api._spinnerMsg = msg
      else out(`  ${C.dim}${msg}…${C.reset}`)
    },
    info(msg) { out(`  ${C.dim}${msg}${C.reset}`) },
    warn(msg) { out(`  ${C.yellow}!${C.reset} ${msg}`) },
    ok(msg) { out(`  ${C.green}✓${C.reset} ${msg}`) },
    error(msg) { err(`  ${C.red}✗${C.reset} ${msg}`) },
    destroyLog(msg) { if (msg.trim()) out(msg) },

    // ── 清单 ─────────────────────────────────────────────
    plan(manifest, info) {
      const lines = []
      const shown = manifest.files.slice(0, 12)
      for (const f of shown) {
        const icon = iconFor(f.rel)
        const name = f.rel.length > 34 ? f.rel.slice(0, 15) + '…' + f.rel.slice(-16) : f.rel
        lines.push(`${icon}  ${name}${' '.repeat(Math.max(1, 36 - visibleLen(name)))}${C.dim}${formatSize(f.size).padStart(9)}${C.reset}`)
      }
      if (manifest.files.length > shown.length) {
        lines.push(`${C.dim}   …还有 ${manifest.files.length - shown.length} 个文件${C.reset}`)
      }
      const summary = `共 ${info.fileCount} 个文件` +
        (info.dirCount ? `，${info.dirCount} 个子目录` : '')
      lines.push(`${C.bold}${summary}${' '.repeat(Math.max(1, 36 - visibleLen(summary)))}${formatSize(info.totalBytes).padStart(9)}${C.reset}`)
      box('本次传输', lines)
      out()
    },

    gift(g) {
      // 赠品现在是**一组**（单文件形态送"程序 + 源码包"），所以每条各自打印一行
      const label = g.kind === GIFT_KIND.SOURCE ? '附带赠送源码与文档' : '附带赠送程序'
      out(`  ${C.cyan}🎁${C.reset} ${label}：${C.bold}${g.name}${C.reset} ${C.dim}(${formatSize(g.size)})${C.reset}`)
      out(`     ${C.dim}${g.note}${C.reset}`)
      out()
    },

    // ── 哈希进度 ─────────────────────────────────────────
    progress(done, total) {
      const pct = total ? done / total : 0
      const bar = barFor(pct, 20)
      const label = total
        ? `${bar} ${C.bold}${Math.floor(pct * 100)}%${C.reset} ${C.dim}(${formatSize(done)} / ${formatSize(total)})${C.reset}`
        : `${bar} ${C.dim}${formatSize(done)}${C.reset}`
      inlineProgress(`  ${C.dim}${api._spinnerMsg ?? '处理中'}…${C.reset} ${label}`)
    },
    progressDone() {
      if (lastProgressLen) stdout.write('\n')
      lastProgressLen = 0
    },

    // ── 密码 ─────────────────────────────────────────────
    /**
     * 生成建议密码 + 二次确认。
     * 二次确认不是可选项：对方要一字不差地手打这个密码，
     * 发送端打错了对方永远进不来，而且看不出原因。
     */
    async askPassword() {
      const suggestion = suggestPassword()
      out()
      box('一次性密码', [
        '',
        `   ${C.inv} ${suggestion} ${C.reset}`,
        '',
        `${C.dim}   已随机生成（4 个词，好念好打）。${C.reset}`,
        `${C.dim}   直接回车使用它；想自己设定就输入自定义密码。${C.reset}`,
        '',
      ])

      const rl = createInterface({ input: stdin, output: stdout })

      /**
       * 带缓冲的提问状态机，而不是直接用 rl.question。
       *
       * 为什么：当输入到达得比提问快时（用户粘贴、或上层用管道一次性喂入），
       * readline 会先发完 line 事件再触发 close；此时第二次 rl.question
       * 会抛 ERR_USE_AFTER_CLOSE，或者答案随 close 一起丢掉，
       * 用户会莫名其妙被退回。这个坑是 test/password.test.js 抓出来的。
       *
       * 做法：到达的行先进 buffer；提问时优先消费缓冲，
       *       否则等下一个 line；EOF 时未回答的问题按空串处理。
       */
      const buffer = []
      const waiters = []
      let eof = false
      rl.on('line', (line) => {
        const w = waiters.shift()
        if (w) w(line)
        else buffer.push(line)
      })
      rl.on('close', () => {
        eof = true
        for (const w of waiters.splice(0)) w('')
      })

      const ask = (q) => {
        stdout.write(q)
        if (buffer.length) return Promise.resolve(buffer.shift())
        if (eof) return Promise.resolve('')
        return new Promise((resolve) => waiters.push(resolve))
      }

      try {
        /**
         * 交互设计（这里刻意与前几版不同）：
         *   · 直接回车       → 接受自动生成的密码，**不再二次确认**
         *   · 输入自定义密码 → 要求再打一遍确认
         *
         * 为什么这样分：自动生成的密码有 26 个字符。
         * 如果"接受默认值"也要再打一遍，那是在逼用户手抄一串随机词 ——
         * 既荒谬又极易出错，而它本来是零风险的操作（不接受就重新生成）。
         * 只有"自己设定密码"才值得二次确认，因为打错了对方永远进不来、
         * 而且看不出原因。
         */
        const typed = String(await ask(
          `  ${C.blue}?${C.reset} 密码 ${C.dim}[回车使用上面这个]${C.reset} `)).trim()

        if (!typed) {
          out(`  ${C.green}✓${C.reset} 密码已确认（使用自动生成的）`)
          out()
          return suggestion
        }

        const again = String(await ask(
          `  ${C.dim}请再输入一次以确认（防止手误）:${C.reset} `)).trim()
        if (again !== typed) {
          api.error('两次输入不一致，请重新运行')
          return null
        }
        out(`  ${C.green}✓${C.reset} 密码已确认`)
        out()
        return typed
      } finally {
        try { rl.close() } catch { /* 已经关了 */ }
      }
    },

    /**
     * 通用的一行提问（返回去掉了行尾的字符串；超时/EOF/被取消 → `null`）。
     *
     * 为什么要自己管 readline 而不是 `rl.question`：
     *   · 输入可能比提问先到（管道、粘贴）—— `question` 在这种情况下会丢答案；
     *   · 需要**超时**：接收模式下"电脑上已有同名文件"的问句不能永远挂着；
     *   · 需要**能被销毁链取消**：用户按 Ctrl+C 时，挂着的提问必须跟着结束，
     *     否则进程会一直等那一行输入（这个坑与"测试进程不退出"是同一个）。
     * 定时器 `unref()` —— 它是"最多等这么久"，不是"必须活着等这么久"。
     */
    async askLine(question, { timeoutMs = 0 } = {}) {
      if (!stdin || stdin.destroyed || stdin.readableEnded) return null
      stdout.write(question)
      let rl
      try {
        rl = createInterface({ input: stdin, output: stdout })
      } catch { return null }
      pendingAsks.add(rl)
      const answer = await new Promise((resolve) => {
        let settled = false
        const done = (v) => {
          if (settled) return
          settled = true
          if (timer) clearTimeout(timer)
          resolve(v)
        }
        rl.on('line', (l) => done(String(l)))
        rl.on('close', () => done(null))
        const timer = timeoutMs > 0
          ? setTimeout(() => done(null), timeoutMs)
          : null
        timer?.unref?.()
      })
      pendingAsks.delete(rl)
      try { rl.close() } catch { /* 已经关了 */ }
      return answer
    },

    /** 销毁链调用：把还挂着的提问全部结束（它们会按各自的"最安全默认值"继续） */
    cancelAsks() {
      const n = pendingAsks.size
      for (const rl of [...pendingAsks]) { try { rl.close() } catch { /* 已经关了 */ } }
      pendingAsks.clear()
      return n
    },

    // ── 链接与二维码 ─────────────────────────────────────
    showUrls(urls, { password, trusted, timeoutMs, fingerprint = null }) {
      // 机器可读模式：给自动化脚本与集成测试用。
      // 格式刻意放在单独一行且带唯一标记，永远不会与人类可读输出混淆。
      if (machine) {
        out(`__READY__ ${urls.loopback.replace(/\/\?k=.*$/, '')} ${urls.token}`)
        // 指纹也给机器一份：自动化/脚本接收（`flicker recv <链接> --fingerprint=`）要用它
        if (fingerprint) out(`__FINGERPRINT__ ${fingerprint}`)
        return
      }
      boxedLink('让对方打开这个链接', urls.primary, {
        extra: [
          `${C.dim}   链接含一次性令牌，首次访问后失效${C.reset}`,
          `${C.yellow}   建议链接和密码分开发送${C.reset}${C.dim}（链接发微信，密码打电话）${C.reset}`,
        ],
      })
      // 证书指纹：**只有"用程序直接接收"时才需要**，所以只在真的有时打印。
      //
      // 为什么需要它：对方如果也用闪传接收（`flicker recv <链接>`），Node 没有浏览器那个
      // "高级 → 继续前往"的按钮，必须由人核对"两边看到的是同一张证书"。
      // 这一步挡的是"有人冒充这台机器的地址"（自签证书没有第三方背书）。
      if (fingerprint) {
        out(`  证书指纹 ${C.bold}${fingerprint}${C.reset}` +
          `${C.dim}  ⇐ 对方用 flicker recv 直接接收时，屏幕上会出现同一串，核对一下即可${C.reset}`)
      }
      // IPv6 的可用链接：只在**真的有**全局/ULA 地址时才出现。
      // 为什么不默认用它：对方不一定有 IPv6，而局域网 IPv4 总是通的；
      // 但两边都有 IPv6 时，这条链接能跨网络直连、不经中继。
      if (Array.isArray(urls.ipv6) && urls.ipv6.length) {
        out(`  ${C.dim}这台机器还有 IPv6 地址（两端都有公网 IPv6 时，用它可跨网络直连、不经中继）：${C.reset}`)
        for (const u of urls.ipv6) out(`  ${C.dim}  ${u}${C.reset}`)
      }
      out()
      // ⚠️ 这一行**必须无条件打印**。
      //
      // 从前它挂在 `if (!trusted)` 下面 —— 而 trusted 说的是"本机装没装证书"，
      // 跟对方那台电脑会不会看到警告毫无关系。结果：发送端装好了证书（trusted=true）、
      // 本机预览一切正常，于是这句提示不打印；而对方在自己的电脑上照旧看到一个
      // **"不安全"红警告**，完全不知道该怎么办（2026-10 用户实测反馈的原话）。
      // 证书只装在发起方这台机器上 —— 接收方那台永远会看到一次警告，除非它自己也装了。
      out(`  ${C.yellow}!${C.reset} 对方那台电脑**第一次**打开会看到一次「不安全」提示 —— ` +
        `证书只装在本机。点${C.bold}「高级 → 继续前往」${C.reset}即可，数据仍然是加密的`)
      out(`  ${C.dim}  （若不想看到这一步：见 中文文档/使用手册.md §10.3 的说明${C.reset}` +
        `${C.dim}，或改用 --relay 走中继，那条路用的是正规 HTTPS${C.reset}）`)
      if (!trusted) {
        // 这是**本机**的情况：没装证书，所以连自己在浏览器里预览也会看到警告
        out(`  ${C.dim}  本机未安装会话证书（--no-cert-install？），本机预览同样会看到警告${C.reset}`)
      }
      out()
      out(`  ${C.yellow}⏳${C.reset} 等待对方连接… ${C.dim}（超时 ${describeWait(timeoutMs)}后自动销毁）${C.reset}`)
      out(`  ${C.dim}按 Ctrl+C 立即中止并销毁全部密钥${C.reset}`)
      out()
    },

    /**
     * 中继模式：把链接给对方。
     * 与局域网模式的关键差别要在屏幕上说清楚 ——
     * 数据会经过中继（虽然是密文），用户有权知道这件事。
     */
    relayReady(link, { password, room, timeoutMs }) {
      if (machine) {
        out(`__READY__ ${link.split('/#')[0]} ${room}`)
        return
      }
      boxedLink('让对方打开这个链接', link, {
        extra: [
          `${C.dim}   链接里的房间名与盐由密码派生，中继看不到盐${C.reset}`,
          `${C.dim}   （盐放在 # 之后，浏览器不会把它发给服务器）${C.reset}`,
        ],
      })
      out()
      out(`  ${C.yellow}注意${C.reset} 数据会经过中继转发，但内容是端到端加密的 ——`)
      out('       中继看不到文件内容、文件名，也看不到密码。')
      out()
      out(`  ${C.dim}密码：${C.reset}${C.bold}${password}${C.reset}${C.dim}（用你自己的方式告诉对方）${C.reset}`)
      out()
      out(`  ${C.yellow}⏳${C.reset} 等待对方连接… ${C.dim}（超时 ${describeWait(timeoutMs)}后自动销毁）${C.reset}`)
      out(`  ${C.dim}按 Ctrl+C 立即中止并销毁全部密钥${C.reset}`)
      out()
    },

    // ── 连接与传输 ───────────────────────────────────────
    peerConnected(peer) {
      out(`  ${C.green}✓${C.reset} 对方已连接  ${C.dim}${peer?.address ?? ''} · ${describeUA(peer?.userAgent)}${C.reset}`)
    },
    authed() {
      out(`  ${C.green}✓${C.reset} 密码核对通过  ${C.dim}双向认证完成 · 密钥已协商${C.reset}`)
      out()
      api._transferStart = Date.now()
      api._lastFile = null
    },
    authFailed(evt) {
      out(`  ${C.red}✗ 密码不一致${C.reset} ${C.dim}（失败 ${evt.failures}/${evt.max}）${C.reset}`)
      if (evt.failures < evt.max) api.info('对方可以重试')
    },

    chunkProgress(e) {
      api.progressLine({ fileName: e.fileName, doneBytes: e.sentBytes, totalBytes: e.totalBytes })
    },

    /**
     * 接收模式（手机往电脑发）的进度。
     * 与发送端共用同一条绘制逻辑 —— 只有"哪一头在动"不同，画出来的东西应当一样，
     * 否则用户在两种模式下会看到两种进度条。
     */
    recvProgress(e) {
      api.progressLine({
        fileName: e.fileName, doneBytes: e.receivedBytes, totalBytes: e.totalBytes,
      })
    },

    /** 进度条本体（发送/接收共用）。`_transferStart`/`_lastFile` 由 `authed()` 重置。 */
    progressLine({ fileName, doneBytes, totalBytes }) {
      if (fileName !== api._lastFile) {
        if (api._lastFile) stdout.write('\n')
        api._lastFile = fileName
        const nm = fileName.length > 40 ? '…' + fileName.slice(-39) : fileName
        out(`  ${C.bold}${nm}${C.reset}`)
      }
      const pct = totalBytes ? doneBytes / totalBytes : 0
      const t = (Date.now() - (api._transferStart ?? Date.now())) / 1000
      const speed = t > 0.2 ? doneBytes / t : 0
      inlineProgress(
        `  ${C.cyan}${barFor(pct, 28)}${C.reset} ${C.bold}${String(Math.floor(pct * 100)).padStart(3)}%${C.reset}` +
        ` ${C.dim}${formatSize(doneBytes)} / ${formatSize(totalBytes)}` +
        `  ·  ${formatSize(speed)}/s${C.reset}`)
    },

    transferComplete(e) {
      api.progressDone()
      out()
      out()
      out(`  ${C.green}✓ 全部完成${C.reset}  ${C.dim}${formatSize(e.bytes)} 已送达${C.reset}`)
      out()
    },

    // ── 接收模式（手机发过来）───────────────────────────
    /**
     * 接收模式就绪：把链接给**手机**。
     *
     * 与发送模式的差别不是文案好看，是**两边看到的东西不一样**：
     *   · 手机那边要点一次"不安全 → 继续"，因为证书只可能在电脑上；
     *   · 手机不能选文件夹（浏览器限制），所以清单里只有文件名；
     *   · 手机锁屏/切后台会被浏览器冻住 —— 这句必须写在屏幕上，用户才知道别切走。
     */
    recvReady(urls, { password, dir, timeoutMs }) {
      if (machine) {
        out(`__READY__ ${urls.loopback.replace(/\/\?k=.*$/, '')} ${urls.token}`)
        return
      }
      boxedLink('让手机打开这个链接', urls.primary, {
        qrCaption: '用手机扫码打开',
        extra: [`${C.dim}   链接含一次性令牌，首次访问后失效${C.reset}`],
      })
      out()
      out(`  ${C.yellow}一次性密码${C.reset}  ${C.bold}${password}${C.reset}` +
        `${C.dim}（手机页面上要输入它）${C.reset}`)
      out(`  ${C.dim}保存到${C.reset}      ${dir}`)
      out()
      out(`  ${C.yellow}手机第一次打开会看到一次「不安全」提示${C.reset} —— 证书只可能在电脑上。` +
        `点${C.bold}「高级 → 继续前往」${C.reset}即可，数据仍然是加密的`)
      out(`  ${C.dim}手机上请保持页面在前台、屏幕别熄（切到别的应用会被浏览器冻住，` +
        `回来后会从未传完的那一块继续）${C.reset}`)
      out()
      out(`  ${C.yellow}⏳${C.reset} 等待对方发来… ${C.dim}（超时 ${describeWait(timeoutMs)}后自动销毁）${C.reset}`)
      out(`  ${C.dim}按 Ctrl+C 立即中止并销毁全部密钥（已经收到的文件保留）${C.reset}`)
      out()
    },

    /** 清单到了：还没开始收数据，但用户有权先知道要收什么 */
    recvManifest(e) {
      const skipped = e.skipped ? `，跳过 ${e.skipped} 个` : ''
      out(`  ${C.green}✓${C.reset} 清单已收到  ${C.dim}${e.files} 个文件` +
        `${skipped} · 共 ${formatSize(e.totalBytes)}${C.reset}`)
      out()
    },

    recvComplete(e) {
      api.progressDone()
      out()
      out()
      out(`  ${C.green}✓ 全部收到${C.reset}  ${C.dim}共 ${formatSize(e.bytes)}，` +
        `${e.files} 个文件已保存在 ${e.dir}${C.reset}`)
      out()
    },

    /**
     * 同名文件三选一（接收模式）。
     *
     * ⚠️ 它发生在**清单阶段**：此刻一个字节都还没开始收，所以"问一下"不会卡住任何东西。
     *    超时（默认 5 分钟）按最安全的"换个名字"处理，并且**说出来** ——
     *    默默改名会让用户在下载目录里对不上号。
     *
     * @returns {Promise<'rename'|'overwrite'|'skip'>}
     */
    async askCollision(info, { timeoutMs = 5 * 60 * 1000 } = {}) {
      if (machine) return 'rename'            // 自动化场景不许停下来等人
      out()
      out(`  ${C.yellow}?${C.reset} 电脑上已经有 ${C.bold}${info.rel}${C.reset}` +
        `${C.dim}（${info.existing}）${C.reset}`)
      out(`    ${C.inv} 1 ${C.reset} 换个名字（${C.dim}${info.suggested}${C.reset}）` +
        `   ${C.inv} 2 ${C.reset} 覆盖它   ${C.inv} 3 ${C.reset} 跳过这个文件`)
      out(`    ${C.dim}直接回车 = 换个名字（最安全）。${Math.round(timeoutMs / 60000)} 分钟不回答也按它处理。${C.reset}`)
      const answer = await api.askLine(`  ${C.dim}怎么处理？[1/2/3]${C.reset} `, { timeoutMs })
      if (answer === null) {
        out(`  ${C.dim}（没人回答，按"换个名字"处理）${C.reset}`)
        return 'rename'
      }
      const a = String(answer).trim().toLowerCase()
      if (a === '2' || a === 'o' || a === 'overwrite') return 'overwrite'
      if (a === '3' || a === 's' || a === 'skip') return 'skip'
      return 'rename'
    },

    // ── 销毁清单 ─────────────────────────────────────────
    destroyReport(report) {
      api.progressDone()
      const lines = [`${C.dim}会话销毁清单${C.reset}`]
      for (const d of report.done) lines.push(`${C.green}✓${C.reset} ${d}`)
      for (const s of report.skipped) lines.push(`${C.dim}– ${s}${C.reset}`)
      for (const f of report.failed) lines.push(`${C.red}✗ ${f}${C.reset}`)
      if (report.failed.length) {
        lines.push('')
        lines.push(`${C.yellow}有项目未能清理，请手动处理（见 中文文档/使用手册.md 第十一章）${C.reset}`)
      }
      out()
      box('', lines)
      out()
    },
  }
  return api
}

// ── 辅助 ────────────────────────────────────────────────────

const visibleLen = (s) => {
  // 中文按 2 列宽度计算，否则框线会歪
  let n = 0
  for (const ch of s.replace(/\x1b\[[0-9;]*m/g, '')) {
    n += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1
  }
  return n
}

function barFor(pct, width) {
  const filled = Math.max(0, Math.min(width, Math.round(pct * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

function iconFor(name) {
  const e = (name.split('.').pop() ?? '').toLowerCase()
  if (['mp4', 'mkv', 'mov', 'avi', 'webm'].includes(e)) return '🎬'
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic'].includes(e)) return '🖼️'
  if (['mp3', 'wav', 'flac', 'm4a', 'ogg'].includes(e)) return '🎵'
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(e)) return '🗜️'
  if (['pdf'].includes(e)) return '📄'
  if (['doc', 'docx', 'txt', 'md'].includes(e)) return '📝'
  if (['xls', 'xlsx', 'csv'].includes(e)) return '📊'
  if (['exe', 'msi', 'dmg', 'appimage'].includes(e)) return '⚙️'
  return '📄'
}

// ── 二维码 ──────────────────────────────────────────────────
//
// 零依赖实现。用半块字符（▀▄█）把两行像素拼进一行，所以输出高度减半。
// 部分 Windows 老终端字体不支持这些字符，此时用 --no-qr，或走 GUI。
// ⚠️ 本实现只覆盖字节模式、纠错级别 L/M、版本 1–10 —— 够放一个 URL。
//    超出范围时返回空数组，界面自动省略二维码（而不是打印垃圾）。

const QR = (() => {
  // GF(256) 乘法表
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256)
  for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x = x << 1 ^ (x & 0x80 ? 0x11d : 0) }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
  const mul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]

  /** RS 纠错码字 */
  function rs(data, ecLen) {
    const gen = new Uint8Array(ecLen)
    gen[ecLen - 1] = 1
    for (let i = 0; i < ecLen; i++) {
      const factor = EXP[i]
      for (let j = 0; j < ecLen; j++) {
        gen[j] = mul(gen[j], factor)
        if (j + 1 < ecLen) gen[j] ^= gen[j + 1]
      }
    }
    const res = new Uint8Array(ecLen)
    for (const b of data) {
      const factor = b ^ res[0]
      res.copyWithin(0, 1)
      res[ecLen - 1] = 0
      for (let i = 0; i < ecLen; i++) res[i] ^= mul(gen[i], factor)
    }
    return res
  }

  // 各版本的容量与对齐图案位置（字节模式，纠错 M）
  const SPEC = {
    1: { ec: 10, groups: [[1, 26]] }, 2: { ec: 16, groups: [[1, 44]] },
    3: { ec: 26, groups: [[1, 70]] }, 4: { ec: 18, groups: [[2, 50]] },
    5: { ec: 24, groups: [[2, 67]] }, 6: { ec: 16, groups: [[4, 43]] },
    7: { ec: 18, groups: [[4, 49]] }, 8: { ec: 22, groups: [[2, 60], [2, 61]] },
    9: { ec: 20, groups: [[3, 58], [2, 59]] }, 10: { ec: 24, groups: [[4, 69], [1, 70]] },
  }
  const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] }

  function encode(text) {
    const bytes = Buffer.from(text, 'utf8')
    let ver = 0
    for (let v = 1; v <= 10; v++) {
      const totalBits = SPEC[v].groups.reduce((s, [n, k]) => s + n * k, 0) * 8
      const need = 4 + (v <= 9 ? 8 : 16) + bytes.length * 8
      if (need <= totalBits) { ver = v; break }
    }
    if (!ver) return null

    const spec = SPEC[ver]
    const dataWords = spec.groups.reduce((s, [n, k]) => s + n * k, 0)
    const bits = []
    const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1) }
    push(4, 4)                                   // 字节模式
    push(bytes.length, ver <= 9 ? 8 : 16)
    for (const b of bytes) push(b, 8)
    // 结束符 + 补齐到字节
    for (let i = 0; i < 4 && bits.length < dataWords * 8; i++) bits.push(0)
    while (bits.length % 8) bits.push(0)
    const pad = [0xEC, 0x11]
    for (let i = 0; bits.length < dataWords * 8; i++) push(pad[i % 2], 8)

    const words = new Uint8Array(dataWords)
    for (let i = 0; i < words.length; i++) {
      words[i] = bits.slice(i * 8, i * 8 + 8).reduce((a, b) => (a << 1) | b, 0)
    }

    // 分块 + 纠错
    const blocks = []
    let off = 0
    for (const [count, k] of spec.groups) {
      for (let i = 0; i < count; i++) {
        const d = words.subarray(off, off + k); off += k
        blocks.push({ d, e: rs(d, spec.ec) })
      }
    }
    // 交错
    const out = []
    const maxD = Math.max(...blocks.map((b) => b.d.length))
    for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i])
    for (let i = 0; i < spec.ec; i++) for (const b of blocks) out.push(b.e[i])
    return buildMatrix(ver, out)
  }

  function buildMatrix(ver, codewords) {
    const size = ver * 4 + 17
    const m = Array.from({ length: size }, () => new Array(size).fill(null))
    const setF = (r, c, v) => { if (r >= 0 && c >= 0 && r < size && c < size) m[r][c] = v }

    // 定位图案 + 分隔
    for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
      for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
        const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6))
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4
        setF(r0 + r, c0 + c, inRing || inCore ? 1 : 0)
      }
    }
    // 校正图案
    for (const r of ALIGN[ver]) for (const c of ALIGN[ver]) {
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
        setF(r + dr, c + dc, (Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0)) ? 1 : 0)
      }
    }
    // 时序图案
    for (let i = 8; i < size - 8; i++) {
      if (m[6][i] === null) setF(6, i, i % 2 === 0 ? 1 : 0)
      if (m[i][6] === null) setF(i, 6, i % 2 === 0 ? 1 : 0)
    }
    // 固定的暗模块
    setF(size - 8, 8, 1)
    // 预留格式信息区
    for (let i = 0; i < 9; i++) { if (m[8][i] === null) setF(8, i, 0); if (m[i][8] === null) setF(i, 8, 0) }
    for (let i = 0; i < 8; i++) { if (m[8][size - 1 - i] === null) setF(8, size - 1 - i, 0); if (m[size - 1 - i][8] === null) setF(size - 1 - i, 8, 0) }

    // 数据（之字形，跳过时序列）
    let bitIdx = 0
    const bits = []
    for (const w of codewords) for (let i = 7; i >= 0; i--) bits.push((w >> i) & 1)
    let up = true
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--
      for (let i = 0; i < size; i++) {
        const row = up ? size - 1 - i : i
        for (const c of [col, col - 1]) {
          if (m[row][c] === null) {
            m[row][c] = bitIdx < bits.length ? bits[bitIdx++] : 0
          }
        }
      }
      up = !up
    }
    // 掩码（固定用 0 号掩码，实现简单且合法）
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
      if (isFunctionModule(ver, size, r, c)) continue
      if ((r + c) % 2 === 0) m[r][c] ^= 1
    }
    // 格式信息（纠错级别 M = 00，掩码 0）
    const fmt = 0b101010000010010 ^ (0b00 << 3 | 0) << 10
    const fmtBits = ((0b00 << 3) | 0)
    let fmtData = fmtBits << 10
    for (let i = 14; i >= 10; i--) if ((fmtData >> i) & 1) fmtData ^= 0b10100110111 << (i - 10)
    const fmtFull = (((0b00 << 3) | 0) << 10 | fmtData) ^ 0b101010000010010
    for (let i = 0; i < 15; i++) {
      const b = (fmtFull >> i) & 1
      if (i < 6) setF(8, i, b)
      else if (i < 8) setF(8, i + 1, b)
      else if (i === 8) setF(7, 8, b)
      else setF(14 - i, 8, b)
    }
    for (let i = 0; i < 8; i++) setF(size - 1 - i, 8, (fmtFull >> i) & 1)
    for (let i = 8; i < 15; i++) setF(8, size - 15 + i, (fmtFull >> i) & 1)
    setF(size - 8, 8, 1)
    return m
  }

  function isFunctionModule(ver, size, r, c) {
    if (r < 9 && c < 9) return true
    if (r < 9 && c >= size - 8) return true
    if (r >= size - 8 && c < 9) return true
    if (r === 6 || c === 6) return true
    for (const ar of ALIGN[ver]) for (const ac of ALIGN[ver]) {
      if ((ar <= 8 && ac <= 8) || (ar <= 8 && ac >= size - 9) || (ar >= size - 9 && ac <= 8)) continue
      if (Math.abs(r - ar) <= 2 && Math.abs(c - ac) <= 2) return true
    }
    return false
  }

  return { encode }
})()


/**
 * 浏览器可用的二维码源码（同一份实现，两种用法）
 * ==============================================
 * 这段字符串就是下面的 QR 实现，**只此一份**：
 *   · 终端页 —— 由下面的 qrLines() 直接使用（真正的模块代码）
 *   · 图形界面 —— 由 /api/qr.js 把这个字符串发给页面，页面 eval 后使用
 *
 * 为什么要存成字符串：图形界面需要在**浏览器**里画二维码，而服务端跑在 Node 里。
 * 早先的做法是运行时读 tty.js 的源文件再切出这一段 ——
 * 那在 SEA 单文件形态下必然失败（没有源文件可读），也让两处逻辑容易漂移。
 * 现在只有一处定义，构建期和运行期看到的是同一段代码。
 */
export const BROWSER_QR_SOURCE = `
const QR = (() => {
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256)
  for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x = x << 1 ^ (x & 0x80 ? 0x11d : 0) }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
  const mul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]
  function rs(data, ecLen) {
    const gen = new Uint8Array(ecLen); gen[ecLen - 1] = 1
    for (let i = 0; i < ecLen; i++) {
      const factor = EXP[i]
      for (let j = 0; j < ecLen; j++) { gen[j] = mul(gen[j], factor); if (j + 1 < ecLen) gen[j] ^= gen[j + 1] }
    }
    const res = new Uint8Array(ecLen)
    for (const b of data) {
      const factor = b ^ res[0]
      res.copyWithin(0, 1); res[ecLen - 1] = 0
      for (let i = 0; i < ecLen; i++) res[i] ^= mul(gen[i], factor)
    }
    return res
  }
  const SPEC = {
    1:{ec:10,groups:[[1,26]]}, 2:{ec:16,groups:[[1,44]]}, 3:{ec:26,groups:[[1,70]]},
    4:{ec:18,groups:[[2,50]]}, 5:{ec:24,groups:[[2,67]]}, 6:{ec:16,groups:[[4,43]]},
    7:{ec:18,groups:[[4,49]]}, 8:{ec:22,groups:[[2,60],[2,61]]},
    9:{ec:20,groups:[[3,58],[2,59]]}, 10:{ec:24,groups:[[4,69],[1,70]]},
  }
  const ALIGN = { 1:[],2:[6,18],3:[6,22],4:[6,26],5:[6,30],6:[6,34],7:[6,22,38],8:[6,24,42],9:[6,26,46],10:[6,28,50] }
  function encode(text) {
    const bytes = Array.from(new TextEncoder().encode(text))
    let ver = 0
    for (let v = 1; v <= 10; v++) {
      const totalBits = SPEC[v].groups.reduce((s, g) => s + g[0] * g[1], 0) * 8
      if (4 + (v <= 9 ? 8 : 16) + bytes.length * 8 <= totalBits) { ver = v; break }
    }
    if (!ver) return null
    const spec = SPEC[ver]
    const dataWords = spec.groups.reduce((s, g) => s + g[0] * g[1], 0)
    const bits = []
    const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1) }
    push(4, 4); push(bytes.length, ver <= 9 ? 8 : 16)
    for (const b of bytes) push(b, 8)
    for (let i = 0; i < 4 && bits.length < dataWords * 8; i++) bits.push(0)
    while (bits.length % 8) bits.push(0)
    const pad = [0xEC, 0x11]
    for (let i = 0; bits.length < dataWords * 8; i++) push(pad[i % 2], 8)
    const words = new Uint8Array(dataWords)
    for (let i = 0; i < words.length; i++) words[i] = bits.slice(i * 8, i * 8 + 8).reduce((a, b) => (a << 1) | b, 0)
    const blocks = []; let off = 0
    for (const [count, k] of spec.groups) for (let i = 0; i < count; i++) { const d = words.subarray(off, off + k); off += k; blocks.push({ d, e: rs(d, spec.ec) }) }
    const out = []; const maxD = Math.max(...blocks.map((b) => b.d.length))
    for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i])
    for (let i = 0; i < spec.ec; i++) for (const b of blocks) out.push(b.e[i])
    return buildMatrix(ver, out)
  }
  function buildMatrix(ver, codewords) {
    const size = ver * 4 + 17
    const m = Array.from({ length: size }, () => new Array(size).fill(null))
    const setF = (r, c, v) => { if (r >= 0 && c >= 0 && r < size && c < size) m[r][c] = v }
    for (const [r0, c0] of [[0,0],[0,size-7],[size-7,0]]) {
      for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
        const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6))
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4
        setF(r0 + r, c0 + c, inRing || inCore ? 1 : 0)
      }
    }
    for (const r of ALIGN[ver]) for (const c of ALIGN[ver]) {
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++)
        setF(r + dr, c + dc, (Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0)) ? 1 : 0)
    }
    for (let i = 8; i < size - 8; i++) {
      if (m[6][i] === null) setF(6, i, i % 2 === 0 ? 1 : 0)
      if (m[i][6] === null) setF(i, 6, i % 2 === 0 ? 1 : 0)
    }
    setF(size - 8, 8, 1)
    for (let i = 0; i < 9; i++) { if (m[8][i] === null) setF(8, i, 0); if (m[i][8] === null) setF(i, 8, 0) }
    for (let i = 0; i < 8; i++) { if (m[8][size-1-i] === null) setF(8, size-1-i, 0); if (m[size-1-i][8] === null) setF(size-1-i, 8, 0) }
    let bitIdx = 0; const bits = []
    for (const w of codewords) for (let i = 7; i >= 0; i--) bits.push((w >> i) & 1)
    let up = true
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--
      for (let i = 0; i < size; i++) {
        const row = up ? size - 1 - i : i
        for (const c of [col, col - 1]) if (m[row][c] === null) m[row][c] = bitIdx < bits.length ? bits[bitIdx++] : 0
      }
      up = !up
    }
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
      if (isFunctionModule(ver, size, r, c)) continue
      if ((r + c) % 2 === 0) m[r][c] ^= 1
    }
    let fmtData = 0 << 10
    for (let i = 14; i >= 10; i--) if ((fmtData >> i) & 1) fmtData ^= 0b10100110111 << (i - 10)
    const fmtFull = ((0 << 3 | 0) << 10 | fmtData) ^ 0b101010000010010
    for (let i = 0; i < 15; i++) {
      const b = (fmtFull >> i) & 1
      if (i < 6) setF(8, i, b); else if (i < 8) setF(8, i + 1, b)
      else if (i === 8) setF(7, 8, b); else setF(14 - i, 8, b)
    }
    for (let i = 0; i < 8; i++) setF(size - 1 - i, 8, (fmtFull >> i) & 1)
    for (let i = 8; i < 15; i++) setF(8, size - 15 + i, (fmtFull >> i) & 1)
    setF(size - 8, 8, 1)
    return m
  }
  function isFunctionModule(ver, size, r, c) {
    if (r < 9 && c < 9) return true
    if (r < 9 && c >= size - 8) return true
    if (r >= size - 8 && c < 9) return true
    if (r === 6 || c === 6) return true
    for (const ar of ALIGN[ver]) for (const ac of ALIGN[ver]) {
      if ((ar <= 8 && ac <= 8) || (ar <= 8 && ac >= size - 9) || (ar >= size - 9 && ac <= 8)) continue
      if (Math.abs(r - ar) <= 2 && Math.abs(c - ac) <= 2) return true
    }
    return false
  }
  return { encode }
})()
function qrMatrix(text) { try { return QR.encode(text) } catch { return null } }
`

/** 生成二维码的行数组（半块字符，两行像素拼一行） */
function qrLines(text) {
  try {
    const m = QR.encode(text)
    if (!m) return []
    const lines = []
    for (let r = 0; r < m.length; r += 2) {
      let line = ''
      for (let c = 0; c < m.length; c++) {
        const top = m[r][c], bot = r + 1 < m.length ? m[r + 1][c] : 0
        line += top && bot ? '█' : top ? '▀' : bot ? '▄' : ' '
      }
      lines.push(line)
    }
    return lines
  } catch { return [] }
}
