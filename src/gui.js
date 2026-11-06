/**
 * 图形界面（站点页）
 * ==================
 * 设计见 架构决策.md 第二章。要点：
 *
 *  1. **不是原生窗口，而是一个只监听回环地址的本地网页。**
 *     理由：接收端本来就是网页，发送端也用网页 → 整个产品只有一套 UI 代码；
 *     而且发送端页面跑在 http://127.0.0.1（安全上下文），
 *     所以它自己接收别人的文件时同样能使用流式写盘。
 *
 *  2. **Node 是内核，页面是视图。** 页面通过 /api/state 轮询内核状态，
 *     通过 /api/* 下达命令。业务逻辑一份都不在页面里。
 *
 *  3. **浏览器探测**（约束）：默认浏览器很可能是 Firefox ——
 *     它不支持流式写盘、也没有 --app 模式。所以主动去找 Edge/Chrome，
 *     找不到才退回默认浏览器，并在页面上如实告知降级后果。
 *
 *  4. **就绪探测通过后才开窗口**（约束 3b，实测得出的硬约束）。
 */
// ⚠️ 用 `as createHttpServer` 而不是直接叫 createServer：
//    单文件打包把所有模块拼进**同一个顶层作用域**，而 server.js 那边
//    `createServer` 指的是 node:https 的 —— 同名不同物，拼在一起就分不清了
//    （打包器会直接拒绝构建，报"同名内置 API 来自不同的 node: 模块"）。
import { createServer as createHttpServer } from 'node:http'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { suggestPassword } from './suite/flicker1.js'
import { RateLimiter, parseRate } from './rate.js'
import { scan, toWire, formatSize } from './manifest.js'
import { primaryIPv4 } from './trust.js'
import { readAsset, ASSET } from './assets.js'
import { detectSelf } from './gift.js'
// ⚠️ 静态 import —— 动态 import 的相对路径进不了单文件产物（见 bin/flicker.js 顶部的说明）
import { Destroyer, EXIT } from './destroy.js'
import { cleanAllLeftovers, cleanTempDirs } from './trust.js'
import { runSend } from './run.js'
import { startReceiveService, defaultSaveDir, waitForReceive } from './recv.js'
import { matchFingerprint, parseRecvLink, probePeer, pullFromLink } from './pull.js'
import { pickFolder } from './native-pick.js'
import { dedupePath } from './manifest.js'
import { compareKeyOf } from './path-safety.js'
import { BROWSER_QR_SOURCE } from './tty.js'
import { createPluginRegistry } from './plugin/registry.js'


// ── 浏览器探测 ──────────────────────────────────────────────

/**
 * 找一个"能力足够"的浏览器（Chromium 系）。
 * ⚠️ 刻意不无脑用系统默认浏览器：默认可能是 Firefox，
 *    而它不支持 File System Access（大文件会失败）也没有 --app 模式。
 *    用户不该在不知情的情况下掉进这个坑。
 */
function findChromium() {
  const candidates = process.platform === 'win32' ? [
    process.env['PROGRAMFILES'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env['PROGRAMFILES(X86)'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env['PROGRAMFILES'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['LOCALAPPDATA'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['LOCALAPPDATA'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env['LOCALAPPDATA'] + '\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  ] : process.platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ] : [
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge', '/snap/bin/chromium',
  ]
  for (const c of candidates) {
    if (c && existsSync(c)) return c
  }
  return null
}

// ── 图形界面主流程 ──────────────────────────────────────────

/**
 * 界面上那句"赠品是什么"的准话。
 *
 * 按运行时事实（`detectSelf()`）分两种，**不共用一句话**：
 *   单文件形态 → 送**两个**：程序本身（对方双击就能用）+ 源码包（源码 + 中英文文档）
 *   源码形态   → 只能送源码包；对方要先装 Node。这与"双击就能用"是两回事，
 *                混着说会让用户以为送出去的是能双击的 exe（实测反馈过）。
 */
function giftNoteForUser() {
  const self = detectSelf()
  if (self.mode === 'sea') {
    return '会送两样：① 这个程序本身（对方双击即可运行）；' +
      '② 源码包（源码 + 中英文文档，对方可以自己看、自己改、自己构建）。'
  }
  return '当前是**源码版**：只会送源码包（flicker-…-source.fkz，含源码与中英文文档），' +
    '对方要先装 Node.js 24+ 才能用。想让对方双击就能用，请改用单文件版（dist 里那个 .exe）。'
}

/**
 * @param {object} opts
 * @param {object} [opts.flags] 命令行传进来的选项（no-cert-install / no-gift 等）
 * @param {(msg:string)=>void} [opts.log]
 */
export async function runGui(opts = {}) {
  const flags = opts.flags ?? {}
  const log = opts.log ?? ((m) => process.stdout.write(m + '\n'))

  /**
   * 插件注册表（由入口 `bin/flicker.js` 加载好传进来；没有插件时是 null）。
   *
   * 图形界面的插件插在哪、为什么这样插：
   *   · **发送**这条路真的支持（注册表直接交给 `runSend`，事件/贡献点/销毁那一步全生效）；
   *   · **接收模式**还不支持（v1 的事件表里没有"接收平面"）—— 界面里点「接收文件」时
   *     **明确报错**，而不是让插件静默失效（那是本项目最忌讳的失败方式）。
   *   · 插件 `ctx.log()` 的输出默认写 stderr，在图形界面里**看不见** ——
   *     所以这里把出口改道到界面自己的日志面板（`setLog`，不重载插件）。
   */
  const plugins = opts.plugins ?? null
  if (plugins?.count) {
    plugins.setLog((line) => log(line))
    log(`  🧩 已加载 ${plugins.describe()}`)
  }

  // 内核状态：页面就是它的一个视图
  // ── 限速参数（命令行给的那一个）────────────────────────────
  /**
   * 把 `--rate` 变成 `{spec, bytesPerSec}`，非法时**明确说一句**再按不限速处理。
   *
   * ⚠️ 为什么不能悄悄忽略：`--rate` 的用途就是"别占满上行带宽"。
   *    写错了却当不限速，用户以为限住了、实际把带宽吃满 —— 这种误解
   *    只有等别人抱怨网络卡才会被发现（`src/rate.js` 的注释里记着这条）。
   */
  function initRate(spec) {
    if (spec === undefined) return null
    if (spec === true) {
      log('  ! --rate 后面要跟速率（例如 --rate=5M），本次按不限速处理')
      return null
    }
    const n = parseRate(String(spec))
    if (!Number.isFinite(n)) {
      log(`  ! --rate 的写法看不懂：「${spec}」，本次按不限速处理`)
      return null
    }
    return { spec: String(spec), bytesPerSec: n }
  }

  const S = {
    phase: 'idle',          // idle | plan | waiting | transfer | done | error | destroyed
    paths: [],
    files: [],
    totalBytes: 0,
    host: primaryIPv4(),
    url: null,
    password: suggestPassword(),
    gift: flags['no-gift'] !== true,
    // 「顺便把闪传送给对方」到底会送出什么，**必须如实写在界面上**：
    //   单文件版 → 它自己（对方双击就能用）
    //   源码版   → 源码包 flicker-x.y.z-source.fkz（对方要先装 Node.js 24+）
    // 2026-10 有用户实测时发现"送过去不是一个 exe，是 source.fkz" —— 行为是对的，
    // 但界面上那行提示一直写着"对方收到后也能把文件发给别人，不用再去下载"，
    // 两种形态共用一句话，等于在源码模式下骗人。这里按运行时事实（detectSelf）给准话。
    giftNote: giftNoteForUser(),
    destroyRequested: false, // 用户是否点过「立即销毁」（决定收尾时显示"已销毁"还是"完成"）
    live: null,              // onReady 给的会话句柄 —— 销毁按钮就靠它
    // 限速（界面上可选）。null = 不限速。
    // 写法与命令行 `--rate` 完全一致（同一个 parseRate），界面上可以随时改。
    // 命令行给了非法值时不静默忽略 —— 那会变成"用户以为限了、其实占满带宽"。
    rate: initRate(flags.rate),
    progress: null,
    report: null,
    error: null,
    elapsed: null,
    run: null,              // 正在跑的发送会话
    browserNote: null,
    // ── 接收模式（手机 → 这台电脑）──────────────────────────
    // 与发送是**两个独立的方向**：可以同时开着（一边发、一边等手机发过来），
    // 所以状态也分开存，互不干扰。
    recv: {
      phase: 'off',         // off | starting | waiting | transfer | done | stopped | timeout | error
      dir: null, url: null, password: null, port: null,
      plan: null,           // {files, skipped, totalBytes}
      peer: null,           // 已连上的对端地址
      pending: null,        // 重名询问：{rel, existing, suggested}
      progress: null,
      report: null,
      error: null,
      elapsed: null,
    },
    recvLive: null,         // startReceiveService 给的句柄（停止按钮靠它）
    recvRun: null,          // 后台等待的 promise
    // ── 用闪传自己接收（`flicker recv <链接>` 的界面版）────────────
    // 这是**第三个方向**：不是"我要发"，也不是"等手机发过来"，而是
    // "我到对方的链接里把文件取回来"。它由 **Node** 去取（不是页面 fetch）——
    // 页面在 127.0.0.1、对方是局域网 IP + 自签证书，浏览器的跨源与证书都会拦下来。
    pull: {
      phase: 'off',         // off | ready | transfer | done | stopped | error
      link: '', dir: null,
      fingerprint: null,    // 探测到的证书指纹（前 8 位，大写）
      plan: null,           // {files, totalBytes}
      progress: null,       // {bytes, totalBytes, files, totalFiles, current}
      files: [],            // 已定稿的文件名（给结果面板）
      failed: [],
      report: null,
      error: null,
      elapsed: null,
    },
    pullController: null,   // AbortController：停止按钮靠它
    pullRun: null,          // 后台跑的 promise
  }

  /**
   * 克隆一份**只用于这一场传输**的插件注册表（P2-1）。
   *
   * 为什么必须克隆：注册表的 `dispose()` 会把订阅全部 off 掉，而且 `apply()`
   * 不允许跑第二遍 —— 但界面进程要比一场传输活得久（传完还能「再传一次」、
   * 接收模式也能反复起停）。从前界面直接把入口那份注册表交出去，第一场结束后
   * 插件就永久静默失效，而状态里还写着"已加载 N 个插件"（项目最忌的静默失败）。
   * 入口那份只当模板与展示用，它自己的副作用在**进程退出**时统一释放。
   */
  async function freshPlugins() {
    if (!plugins?.count) return null
    const next = createPluginRegistry({
      flickerVersion: plugins.flickerVersion,
      planes: plugins.planes,
      log: (line) => log(line),
    })
    await next.load(plugins.list.map((p) => p.file))
    return next
  }

  // ── 目录浏览（"选择文件/文件夹"背后的实现）──────────────────
  /**
   * 列出 `p` 目录下的内容。`p` 为空时列出**盘符**（Windows）或根（其它平台）。
   *
   * ⚠️ 这是"把本机文件系统的一部分暴露给页面"。它安全的前提只有一条：
   *    **这个服务只监听 127.0.0.1**（见 runGui 里的 listen 与
   *    `test/gui.test.js` 的"只监听回环地址"用例）。能访问它的进程本来
   *    就能直接读同一台机器的文件系统，所以没有额外风险。
   *
   * 与 `scan()` 保持一致：**不跟随符号链接**（避免把一个链接指到的任意位置也列出来）。
   *
   * @param {string} p 绝对路径；空字符串 = 列出根
   * @param {object} [opts]
   * @param {boolean} [opts.dirsOnly] 只列文件夹（"选择文件夹"模式下用）
   */
  async function browseDir(p, opts = {}) {
    const { readdir, stat } = await import('node:fs/promises')

    if (!p) {
      if (process.platform === 'win32') {
        const entries = []
        // 从 C 开始：A/B 是软驱，列出来只会是噪音
        for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
          const root = `${letter}:\\`
          if (existsSync(root)) entries.push({ name: root, path: root, kind: 'dir' })
        }
        return { path: '', parent: null, entries, roots: true }
      }
      return { path: '/', parent: null, entries: [{ name: '/', path: '/', kind: 'dir' }], roots: true }
    }

    // ⚠️ 必须是绝对路径。用 `path.resolve` 收下相对路径会得到**盘符相对**的怪东西：
    //    Windows 上 `path.resolve('D:')` = "D 盘的当前目录" = 进程的 CWD。
    //    页面从前就是这么把自己的上级算错成 `D:` 的，结果"上一级"原地打转
    //    （在 D:\闪传 里点上一级 → 还是 D:\闪传）。这里直接拒绝，别再让它悄悄成立。
    if (!path.isAbsolute(p)) throw new Error('需要绝对路径')

    const abs = path.resolve(p)
    let st
    try { st = await stat(abs) } catch { throw new Error(`打不开：${p}`) }
    if (!st.isDirectory()) throw new Error('这不是一个文件夹')

    let dirents
    try { dirents = await readdir(abs, { withFileTypes: true }) } catch (e) {
      // 权限不足、被占用、网络盘掉线 —— 都要给一句人话，不能让页面看到裸 EPERM
      throw new Error(`读不了这个文件夹（${e.code}）—— 可能是权限不够，或者盘符不在线`)
    }

    const dirs = [], files = []
    for (const ent of dirents) {
      if (ent.isSymbolicLink()) continue
      const full = path.join(abs, ent.name)
      if (ent.isDirectory()) dirs.push({ name: ent.name, path: full, kind: 'dir' })
      else if (ent.isFile() && !opts.dirsOnly) {
        let size = 0
        try { size = (await stat(full)).size } catch { /* 读不到就按 0 显示 */ }
        files.push({ name: ent.name, path: full, kind: 'file', size })
      }
    }
    // 文件夹在前、文件在后，各自按名字排 —— 与资源管理器的习惯一致
    const byName = (a, b) => a.name.localeCompare(b.name, 'zh')
    dirs.sort(byName); files.sort(byName)
    const all = [...dirs, ...files]
    const LIMIT = 800
    const parent = path.dirname(abs)
    return {
      path: abs,
      // 已经是根（`C:\` 或 `/`）时，parent 用空串表示"回到盘符列表"
      parent: parent === abs ? '' : parent,
      entries: all.slice(0, LIMIT),
      more: all.length > LIMIT,
      dirCount: dirs.length, fileCount: files.length,
      dirsOnly: Boolean(opts.dirsOnly),
    }
  }

  /** 第 i 个"添加项"里的文件明细（点开文件夹时按需拉取）。按**路径**定位。 */
  function groupEntries(p) {
    const i = S.paths.indexOf(p)
    if (i < 0) return null
    const mine = S.files.filter((f) => f.srcIndex === i)
    const LIMIT = 500
    return {
      i,
      name: groupName(i),
      path: p,
      fileCount: mine.length,
      bytes: mine.reduce((s, f) => s + f.size, 0),
      entries: mine.slice(0, LIMIT).map((f) => ({ rel: f.rel, size: f.size })),
      more: Math.max(0, mine.length - LIMIT),
    }
  }

  /** 一个添加项在界面上的显示名：文件夹/文件取其 basename */
  function groupName(i) {
    const p = S.paths[i] ?? ''
    const seg = p.split(/[\\/]/).filter(Boolean)
    return seg[seg.length - 1] ?? p
  }

  // ── 本地界面服务（只监听回环）────────────────────────────
  const stationPromise = readAsset(ASSET.STATION_HTML)
  // 稍后被 Host 校验用到：界面只接受 127.0.0.1/localhost:<这个端口>（见 localRequestProblem）
  let boundPort = 0
  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const json = (obj, code = 200) => {
      const b = Buffer.from(JSON.stringify(obj), 'utf8')
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store' })
      res.end(b)
    }
    try {
      // ── P1-4：只接受「本机页面自己」发来的请求 ─────────────
      // 只监听回环挡不住 CSRF（任意网页都能 fetch 127.0.0.1）与 DNS rebinding
      // （攻击者的域名解析到 127.0.0.1，浏览器就把它当成同源，能读 /api/browse 的
      // 文件列表）。所以每个请求都要过 Host/Origin 这一关；写接口另查 Content-Type。
      const bad = localRequestProblem(req, boundPort)
      if (bad) {
        log(`  ! 拒绝了可疑的界面请求：${bad}`)
        if (url.pathname.startsWith('/api/')) json({ error: bad }, 403)
        else { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('forbidden') }
        return
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const html = await stationPromise
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(html)
        return
      }
      // 页面需要的二维码编码器：由 tty.js 导出同一份源码，服务端不再读盘。
      // （旧实现运行时读 tty.js 的源文件再切一段，在 SEA 单文件形态下必然失败。）
      if (url.pathname === '/api/qr.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(BROWSER_QR_SOURCE)
        return
      }

      if (url.pathname === '/api/state') { json(publicState()); return }

      // 目录浏览：让用户**点**着选文件/文件夹，而不是手打路径。
      //
      // ⚠️ 为什么必须由后端来做：浏览器**不会**把本地文件的绝对路径交给网页
      //    （`input[type=file]`、拖拽、File System Access API 都不给）。
      //    而发送端是 Node 在直接读原文件（不复制、不占内存），它需要的是**路径**。
      //    所以"选择文件"只能由本地服务去列目录 —— 这个服务本来就只监听回环。
      if (url.pathname === '/api/browse') {
        try {
          json(await browseDir(url.searchParams.get('path') ?? '',
            { dirsOnly: url.searchParams.get('only') === 'dir' }))
        } catch (e) {
          json({ error: e.message }, 400)
        }
        return
      }

      // 某一个"添加项"里的文件明细（点开文件夹时才拉，避免大文件夹每轮都传）
      //
      // ⚠️ 用**路径**定位，不用序号：删掉中间一项之后，它后面所有项的序号都会前移，
      //    而页面里"哪一项是展开的"是按路径记的 —— 两边口径不一致就会展开错的那一项。
      if (url.pathname === '/api/group') {
        const g = groupEntries(url.searchParams.get('p') ?? '')
        if (!g) { json({ error: '没有这一项' }, 404); return }
        json(g); return
      }

      if (req.method === 'POST') {
        // P1-4：写接口只收 application/json。跨站的「简单请求」（text/plain 等）
        // 浏览器不发预检；这里不查的话，任意网页都能 POST 上来改状态。
        const ct = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
        if (ct !== 'application/json') {
          json({ error: '请求体必须是 application/json（拒绝跨站的简单请求）' }, 415)
          return
        }
        let body
        try {
          body = await readJsonBody(req)
        } catch (err) {
          json({ error: err?.message ?? String(err) }, err?.code === 'TOO_LARGE' ? 413 : 400)
          return
        }
        switch (url.pathname) {
          case '/api/add': {
            const paths = (body.paths ?? []).filter((p) => typeof p === 'string' && p.trim());
            if (paths.length) await addPaths(paths)
            json({ ok: true }); return
          }
          case '/api/clear': await applyPaths([]); json({ ok: true }); return
          case '/api/remove': {
            const p = typeof body.path === 'string' ? body.path : ''
            if (!p) { json({ error: '缺少 path' }, 400); return }
            try {
              await removePath(p)
            } catch (e) {
              json({ error: e.message }, 404)
              return
            }
            json({ ok: true, remaining: S.paths.length })
            return
          }
          case '/api/password': S.password = suggestPassword(); json({ password: S.password }); return
          case '/api/options': {
            if (typeof body.gift === 'boolean') S.gift = body.gift
            // 限速：空字符串 = 不限速。写法与命令行 `--rate` 完全一致（parseRate），
            // 不认的写法**明确报错**，不悄悄当成"不限速" ——
            // 用户以为限了、其实占满带宽，这种误解只有别人抱怨时才会被发现。
            if (typeof body.rate === 'string') {
              const spec = body.rate.trim()
              if (!spec) {
                S.rate = null
              } else {
                const n = parseRate(spec)
                if (!Number.isFinite(n)) {
                  json({ error: `限速写法看不懂：「${spec}」。可以写 512K、5M、2G（纯数字按字节/秒算）` }, 400)
                  return
                }
                S.rate = { spec, bytesPerSec: n }
              }
            }
            json({ ok: true, rate: S.rate?.spec ?? '' }); return
          }
          case '/api/start': await startTransfer(body.password); json({ ok: true }); return
          case '/api/destroy': await destroyNow('用户从界面点了销毁'); json({ ok: true }); return
          case '/api/reset': await resetAll(); json({ ok: true }); return
          // ── 接收模式（手机 → 这台电脑）──────────────────────
          case '/api/recv/start': json(await startRecv(body.dir)); return
          case '/api/recv/stop': json(await stopRecv('用户从界面点了停止')); return
          case '/api/recv/again': json(await resetRecv()); return
          case '/api/recv/collision': json(answerCollision(body.choice)); return
          case '/api/recv/open': json(await openRecvDir()); return
          case '/api/pull/probe': json(await probePullLink(body.link)); return
          case '/api/pull/start': json(await startPull(body)); return
          case '/api/pull/stop': json(await stopPull()); return
          case '/api/pull/open': json(await openPullDir()); return
          case '/api/pickdir': json(await pickSaveFolder(body)); return
          case '/api/mkdir': json(await makeDir(body)); return
          default: json({ error: '没有这个接口' }, 404); return
        }
      }
      res.writeHead(404); res.end()
    } catch (err) {
      json({ error: err?.message ?? String(err) }, 500)
    }
  })

  const port = await new Promise((resolve, reject) => {
    server.once('error', reject)
    // 只绑定回环：局域网内其他设备无法访问发送端的界面
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
  boundPort = port
  const guiUrl = `http://127.0.0.1:${port}/`

  // ── 就绪探测（约束 3b）──────────────────────────────────
  // 必须确认界面服务真的能响应，才允许开窗口。
  // 否则 --app=<url> 会停在一个 ERR_CONNECTION_REFUSED 错误页上，而且不会自动重试。
  const ready = await probe(guiUrl)
  if (!ready.ok) log(`  ! 界面自检未通过（${ready.detail}）`)

  // ── 打开窗口 ────────────────────────────────────────────
  // 测试与自动化场景可以要求不开窗口（FLICKER_NO_BROWSER=1）
  if (process.env.FLICKER_NO_BROWSER === '1') {
    log(`  ✓ 图形界面已就绪（未打开窗口）: ${guiUrl}`)
    log('')
  } else {
  const chromium = findChromium()
  if (chromium) {
    // --app 模式：独立窗口、无地址栏，用起来就是一个桌面应用
    spawn(chromium, [`--app=${guiUrl}`, '--no-first-run', '--no-default-browser-check'],
      { detached: true, stdio: 'ignore' }).unref()
    log(`  ✓ 已打开图形界面（${path.basename(chromium)}）`)
    log(`    窗口没出现的话，手动打开：${guiUrl}`)
  } else {
    S.browserNote = '未找到 Edge/Chrome：接收大文件可能受浏览器内存限制，建议安装其一';
    openDefault(guiUrl)
    log('  ! 没有找到 Edge 或 Chrome，已用系统默认浏览器打开')
    log('    默认浏览器是 Firefox 的话，接收超过约 1 GB 的文件可能失败')
    log(`    也可以手动打开：${guiUrl}`)
  }
  log('    关闭这个窗口即结束（界面本身只监听本机，局域网内其他设备访问不到）')
  log('')
  }

  // ── 等待退出 ────────────────────────────────────────────
  const destroyer = new Destroyer({ log: () => {} })
  destroyer.step('图形界面服务已关闭', async () => {
    await new Promise((r) => { server.close(() => r()); setTimeout(r, 500).unref?.() })
    return true
  })
  // 入口加载的插件模板（每场传输用的是它的克隆）：它自己的 apply 副作用在这里释放。
  destroyer.step('插件资源已释放（进程退出）', () => (plugins ? plugins.asDestroyStep() : false))

  /**
   * 真正退出前的销毁链：会话/接收服务/证书 + 本程序留下的其他痕迹，全部 await。
   * 这正是 P2-11 的落点：以前这些异步动作跟在 process.exit 后面，来不及跑完。
   */
  async function shutdown(reason) {
    try { await destroyNow(reason) } catch { /* 尽力而为 */ }
    try { await destroyer.run() } catch { /* Destroyer 本身永不抛错 */ }
    // 兜底：把本程序在系统上留下的证书痕迹全部清掉。
    // 即使上面某一步没走完（窗口被强关、异常退出），这里也保证不留残迹。
    //
    // ⚠️ 从前这里是 `.catch(() => {})` —— 静默吞掉。
    //    而"读不到证书库"恰恰是最需要让人知道的情况（上次那张 CA 可能还在）。
    //    现在把失败写进日志（窗口关掉后终端还在，GUI 的日志也在状态里）。
    await cleanAllLeftovers().catch((e) => log(`  ⚠️ 退出时的证书残留清理没做完：${e?.message ?? e}`))
    await cleanTempDirs().catch((e) => log(`  ⚠️ 退出时的临时目录清理没做完：${e?.message ?? e}`))
  }

  // ⚠️ 这里不能用 destroy.js 的 bindSignals（P2-11）：它跑完 destroyer 后只
  //    `onExit?.()` **不 await** 就 `process.exit`，而图形界面的销毁链（停接收服务、
  //    清证书、删临时目录）全是异步的 —— Ctrl+C 时它们可能一个都没跑完，会话 CA
  //    就留在系统信任库里了。改成"信号只请求退出"，由主流程 await 完销毁再决定退出码。
  let exitCode = 0
  let exitRequested = false
  let resolveExit = () => {}
  const exitPromise = new Promise((r) => { resolveExit = r })
  const onSignal = (sig) => {
    if (exitRequested) {
      process.stderr.write('\n  再次收到中断，立即退出（销毁可能未完成）\n')
      process.exit(130)
    }
    exitRequested = true
    exitCode = sig === 'SIGTERM' ? EXIT.TERMINATED : EXIT.INTERRUPTED
    process.stderr.write(`\n  收到 ${sig}，正在销毁…（再按一次可强制退出）\n`)
    resolveExit()
  }
  const signalHandlers = [
    ['SIGINT', () => onSignal('SIGINT')],
    ['SIGTERM', () => onSignal('SIGTERM')],
    ...(process.platform === 'win32' ? [] : [['SIGHUP', () => onSignal('SIGHUP')]]),
  ]
  for (const [sig, fn] of signalHandlers) process.on(sig, fn)
  server.on('close', () => resolveExit())

  await exitPromise
  // 销毁链跑完再退出；60 秒兜底（证书清理要调系统命令，偶尔会卡住）。
  await Promise.race([
    shutdown('程序退出'),
    new Promise((r) => { setTimeout(r, 60_000).unref?.() }),
  ])
  for (const [sig, fn] of signalHandlers) process.off(sig, fn)
  return exitCode

  // ── 内部实现 ────────────────────────────────────────────

  function publicState() {
    // ⚠️ `files` 只给**前若干个**：它每一轮轮询都会重发一遍，
    //    而"加了一个几万文件的文件夹"是很容易发生的事（照片、素材库）。
    //    界面真正要的是**分组**（每组几个文件、多大），明细等用户点开再拉
    //    （`/api/group`）。文件数量与总字节数仍然如实给出。
    const SAMPLE = 120
    return {
      phase: S.phase,
      files: S.files.slice(0, SAMPLE).map((f) => ({ rel: f.rel, size: f.size })),
      fileCount: S.files.length,
      // 按"用户加进来的那一个东西"分组：加文件夹 → 一行文件夹，点开看内容
      groups: S.paths.map((p, i) => {
        const mine = S.files.filter((f) => f.srcIndex === i)
        return {
          i,
          name: groupName(i),
          path: p,
          fileCount: mine.length,
          bytes: mine.reduce((s, f) => s + f.size, 0),
        }
      }),
      totalBytes: S.totalBytes, host: S.host, url: S.url,
      password: S.password,        // 页面要显示它 —— 用户需要把它告诉对方
      gift: S.gift, giftNote: S.giftNote, progress: S.progress,
      rate: S.rate?.spec ?? '',
      report: S.report, error: S.error, elapsed: S.elapsed,
      browserNote: S.browserNote,
      // 接收模式：整块给出去（页面据此画"接收文件"那一屏）。
      // 不在这里裁剪字段：它本来就只有几个标量，而"少给一个字段"的表现是
      // 界面上一块空白，排查起来要来回对两边的字段名。
      recv: S.recv.phase === 'off' ? null : { ...S.recv },
      recvDefaultDir: defaultSaveDir(),
      // 用闪传自己接收：整块给出去（字段少，不裁剪 —— 少一个字段的表现是界面一块空白）
      pull: S.pull.phase === 'off' ? null : { ...S.pull },
      pullDefaultDir: defaultSaveDir(),
      // 插件：加载了什么**必须看得见**（项目规矩）。页面可以据此显示
      // "本次界面带着 2 个插件" —— 没有插件时是空数组，页面不用做条件判断。
      plugins: plugins?.list ?? [],
    }
  }

  /**
   * 把"要发的那些路径"整体重置一遍（扫描 → 更新状态）。
   *
   * 加一项、删一项都走这里：两条路径必须得到**同一个**状态形状，
   * 否则删掉一项之后分组编号、总字节数、phase 就会和加进去时不一致。
   * 空清单回落到 `idle`（界面回到"我要发文件"那一屏）。
   */
  async function applyPaths(paths) {
    if (!paths.length) {
      S.paths = []; S.files = []; S.totalBytes = 0; S.phase = 'idle'
      return
    }
    const m = await scan(paths, { onWarn: (w) => log(`  ! ${w}`) })
    S.paths = paths
    // ⚠️ `toWire()` 会剔掉本地字段（`absPath`、`srcIndex`），而界面**要用
    //    `srcIndex` 分组**（第几个添加项下面的文件），所以显式搬过来。
    //    搬漏了的表现是：左边显示"4 个文件"，而分组那一行是"0 个文件"。
    S.files = toWire(m).files.map((f, i) => ({ ...f, srcIndex: m.files[i].srcIndex }))
    S.totalBytes = m.totalBytes
    S.phase = 'plan'
  }

  async function addPaths(paths) {
    // 同一个路径重复加没有意义（scan 会按输入逐项扫，重复项会被去重改名），
    // 所以这里先去重，避免用户点两次"选择文件夹"就多出一份 `x (1)` 副本。
    const merged = [...new Set([...S.paths, ...paths])]
    await applyPaths(merged)
    log(`  已选 ${S.files.length} 个文件，共 ${formatSize(S.totalBytes)}`)
  }

  /** 从清单里移掉某一项（按**当初加进去的那个路径**匹配，不用序号 —— 删中间一项会让序号全错位） */
  async function removePath(p) {
    const i = S.paths.indexOf(p)
    if (i < 0) throw new Error('这一项已经不在清单里了')
    await applyPaths(S.paths.filter((_, k) => k !== i))
    log(S.paths.length
      ? `  已移除 1 项，还剩 ${S.files.length} 个文件，共 ${formatSize(S.totalBytes)}`
      : '  清单已空')
  }

  async function startTransfer(password) {
    if (!S.files.length) throw new Error('还没有选择文件')
    if (!password) throw new Error('密码不能为空')
    // P2-3：接口没有防重入时，500ms 内双击「开始传输」会起**两个**会话、两张证书，
    // 而「立即销毁」只作用于后一个 —— 前一个只能等自己的 --timeout 到点。
    // 第二次明确拒绝（错误会在页面上显示，不是静默丢弃）。
    if (S.run) throw new Error('已经在传输了（要重新开始，请先「立即销毁」当前会话）')
    S.password = password
    S.error = null; S.report = null; S.progress = null; S.phase = 'waiting'
    log('')
    log(`  开始传输：${S.files.length} 个文件，共 ${formatSize(S.totalBytes)}`)

    const t0 = Date.now()
    // ⚠️ 这里**不能 await**：runSend 要等到传输结束（或用户销毁）才 resolve，
    //    而 `/api/start` 是 await startTransfer 之后才回响应的 ——
    //    await 它等于"这个 HTTP 请求一直挂到传输结束"（实测：8 秒都拿不到响应，
    //    一把大文件的传输就是几分钟）。页面靠轮询 /api/state 才看起来正常，
    //    所以这个毛病一直没被发现。
    //    正确做法：把 runSend 的 promise 挂到 S.run 上，收尾逻辑放进 .then()。
    // P2-1：每场传输用一份**新的**注册表（理由见 freshPlugins 的说明）。
    // 变量名故意仍叫 plugins：下面那行仍是 `plugins,`，接线与测试都保持原样。
    let plugins
    try {
      plugins = await freshPlugins()
    } catch (e) {
      // 用户显式要求了插件，就不能安静地"没有插件跑完"—— 明确失败并说清原因。
      S.phase = 'error'
      S.error = { title: '插件加载失败', message: e?.message ?? String(e) }
      throw e
    }
    S.run = runSend({
      inputs: S.paths,
      password,
      gift: S.gift,
      // 插件：与命令行发送走的是**同一个** `runSend`，所以事件、贡献点、
      // 销毁清单那一步全都自动生效 —— 界面这条路不需要另一份插件实现。
      plugins,
      limiter: S.rate ? new RateLimiter(S.rate.bytesPerSec) : null,
      installCert: flags['no-cert-install'] !== true,
      noQr: true, noColor: true,
      // P1-3：--timeout 在入口已解析成毫秒（从前 GUI 里 Number('30m') = NaN）。
      timeoutMs: opts.timeoutMs ?? 10 * 60 * 1000,
      onReady: (info) => {
        S.url = info.urls.primary
        // P3-13：onReady 触发时 session.phase 还是 WAITING（ready 要等 authed），
        // 所以这里**不能**用它判断"已认证"—— 阶段一律先置 waiting，交给事件驱动。
        S.phase = 'waiting'
        // ⚠️ 必须留住这个句柄：界面上那个「立即销毁」按钮就是靠它工作的。
        //    从前这里只存了 `S.url`，句柄丢掉之后按钮只能改一下阶段文字，
        //    真正的会话（服务、密钥、证书）一个都没动 —— 用户看到的现象是
        //    **点了没反应**（2026-10 实测反馈）。runSend 的 waitForCompletion
        //    每 200ms 检查一次 `session.destroyed`，所以这里 destroy() 之后
        //    它会立刻收尾并走完整的销毁链。
        S.live = { session: info.session }
        log(`  ✓ 接收端链接：${S.url}`)
        // P1-2：用户可能在**扫描/哈希阶段**就点了「立即销毁」—— 那时 S.live 还没就绪，
        // 请求只能先记下来（见 destroyNow）。现在服务刚起来，立刻兑现它：
        // 不这么做，按钮在最长几分钟的扫描期里等于没反应，而且传输完成后还会误报
        // "已按你的要求销毁"（数据其实已经发出去了）。
        if (S.destroyRequested) {
          log('  · 准备阶段收到的销毁请求：服务刚就绪，立即销毁')
          info.session.destroy()
        }
      },
      onEvent: (evt) => {
        if (evt.type === 'peer-connected') log(`  ✓ 对方已连接 ${evt.peer?.address ?? ''}`)
        else if (evt.type === 'authed') { S.phase = 'transfer'; log('  ✓ 密码核对通过') }
        else if (evt.type === 'chunk') {
          S.phase = 'transfer'
          const elapsed = (Date.now() - t0) / 1000
          S.progress = {
            sentBytes: evt.sentBytes, totalBytes: evt.totalBytes,
            fileName: evt.fileName, elapsed,
            speed: elapsed > 0.3 ? evt.sentBytes / elapsed : 0,
          }
        } else if (evt.type === 'transfer-complete') {
          S.phase = 'done'
        }
      },
    })

    // 后台收尾（不阻塞 /api/start 的响应）
    S.run.then((result) => {
      S.live = null
      const report = result.report ?? { done: [], skipped: [], failed: [] }
      // P1-2：只有**真的被销毁**了才说"已按你的要求销毁"。从前只看 destroyRequested
      // 这个标志 —— 扫描阶段点了按钮（那次请求其实被忽略）也会在传输**完成**之后
      // 显示"已销毁"，而数据已经发出去了。result.reason 是销毁链/等待循环给出的真相。
      if (S.destroyRequested && result.reason === 'destroyed') {
        // 用户自己点的「立即销毁」：这不是错误，别报"传输未完成"吓人。
        // 把销毁清单原样给他，让他看到"确实销毁了"。
        S.phase = 'destroyed'
        S.error = {
          title: '已按你的要求销毁',
          message: '会话密钥已清零、服务已关闭、链接已失效、会话证书已移除。<br>' +
            report.done.map((d) => '✓ ' + d).join('<br>'),
        }
      } else {
        S.phase = result.ok ? 'done' : 'error'
        if (!result.ok) {
          S.error = {
            title: result.reason === 'timeout' ? '等待超时' : '传输未完成',
            message: result.reason === 'timeout'
              ? '对方一直没有连接，会话已自动销毁。可以重新开始。'
              : '传输没有正常完成，会话已销毁。',
          }
        }
      }
      S.report = report
      S.elapsed = (Date.now() - t0) / 1000
      log('')
      log('  ' + '会话销毁清单')
      for (const d of report.done) log('  ✓ ' + d)
      for (const s of report.skipped) log('  – ' + s)
      for (const f of report.failed) log('  ✗ ' + f)
      log('')
      log('  可以关闭窗口，或刷新界面再传一次。')
    }).catch((e) => {
      S.live = null
      S.phase = 'error'
      S.error = { title: '启动失败', message: e?.message ?? String(e) }
      log(`  ✗ ${e?.message ?? e}`)
    }).finally(() => {
      S.run = null
    })
  }

  /**
   * 「立即销毁 / 取消并销毁」。
   *
   * ⚠️ 这里必须真的销毁，不能只把阶段改成 'destroyed'。
   *    2026-10 用户实测反馈"点击没有反应"—— 原因有两个，都在这一处：
   *      ① 传输已经启动时 `S.run` 是存在的，老代码用 `if (!S.run && …)` 判断，
   *         于是**恰好在这个按钮最该起作用的时候什么都不做**；
   *      ② 就算改了阶段，会话、服务、密钥、证书一个都没动 —— 那是"看起来销毁了"。
   *    正确做法：拿到 onReady 给的会话句柄直接 destroy()，
   *    剩下的交给 runSend（它会走完整的销毁链并把清单交回来）。
   */
  async function destroyNow(reason) {
    if (S.destroying) return
    S.destroying = true
    try {
      S.destroyRequested = true
      // 接收模式也要一起收掉：它是**另一个** HTTPS 服务 + 另一张证书，
      // 用户点「销毁」/关窗口时如果只管发送那一路，接收那边的证书就留在系统里了。
      if (S.recvLive) {
        log(`  · 一并停止接收模式（${reason}）`)
        try { await stopRecv(reason) } catch { /* 尽力而为 */ }
      }
      const live = S.live?.session
      if (live && !live.destroyed) {
        log(`  · 用户要求销毁（${reason}）`)
        live.destroy()          // runSend 200ms 内发现 → 走销毁链 → 回传清单
      } else if (S.run) {
        // P1-2：扫描/哈希阶段，会话还没建出来（onReady 没到）→ 只能先把请求记下来，
        // 由 onReady 在服务就绪那一刻立刻 destroy()。**不能**在这里改阶段：
        // 此刻什么都没销毁，改阶段就是骗人。
        log('  · 已收到销毁请求：准备阶段结束后会立刻销毁（不用再点）')
      } else if (S.phase !== 'idle' && S.phase !== 'plan') {
        // 没有在跑的会话（比如启动阶段就失败），但要给界面一个明确交代
        S.phase = 'destroyed'
      }
    } finally {
      S.destroying = false
    }
  }

  async function resetAll() {
    S.paths = []; S.files = []; S.totalBytes = 0; S.url = null
    S.progress = null; S.report = null; S.error = null; S.elapsed = null
    S.live = null; S.destroyRequested = false
    S.password = suggestPassword()
    S.phase = 'idle'
  }

  // ── 接收模式（手机 → 这台电脑）────────────────────────────
  //
  // 与发送是**反方向**，所以用的是另一套东西：电脑起一个 HTTPS 服务、
  // 手机扫码打开页面往上推（见 src/recv.js）。这里只负责
  // "把句柄收好、把状态给页面、把销毁链走完"。
  //
  // 为什么界面里也要有：用户实际是用鼠标收文件的 —— 让他为了收一张照片
  // 去开命令行，等于这个功能没做。

  /** 起一个接收服务（不阻塞：等对方的过程在后台） */
  async function startRecv(dirInput) {
    // 接收模式从 2026-10 起**支持插件**（第四个平面：接收端进程）。
    // 界面的注册表建的是 `planes: ['sender', 'receive']` —— 同一个插件可以两个方向都管，
    // 起接收服务时只把 `recv/*` 那批事件发出去（`upload-server.js` 里的 emitP）。
    if (S.recvLive) throw new Error('接收服务已经在运行了（先停止，或者等它结束）')
    // P3-12：上一轮"停止"留下的标志必须清掉 —— 否则这一轮成功收完也会被标成"已停止"。
    S.recvStopped = false
    // P2-2：启动窗口期（生成证书要一两秒）里点「停止接收」时服务还没拿到句柄，
    // 只能先记下"要停"；服务一出来立刻关掉（见下面 startReceiveService 之后）。
    S.recvAbort = false
    const dir = String(dirInput ?? '').trim() || defaultSaveDir()
    S.recv = {
      phase: 'starting', dir, url: null, password: null, port: null,
      plan: null, peer: null, pending: null, progress: null,
      report: null, error: null, elapsed: null,
    }
    const t0 = Date.now()
    let service
    try {
      // P2-1：与发送一样，每场接收用一份**新的**注册表（用完由接收服务的销毁链释放）。
      // 放在 try 里：加载失败也要走下面的"接收服务没能启动"，而不是卡在 starting。
      const recvPlugins = await freshPlugins()
      service = await startReceiveService({
        dir,
        trust: flags.trust === true,
        machine: false,
        onServiceEvent: (evt) => onRecvEvent(evt, t0),
        // 重名问不问：界面上问（三选一那张卡片），5 分钟没人回答按最安全的"改名"处理
        onCollision: flags['no-ask'] === true ? undefined : askCollision,
        onDestroyLog: (m) => log(m),
        // 接收平面的插件（`recv/*`）。发射点是 `upload-server.js` 与 `recv.js`，
        // 出错**不打断接收**（错误会在结束时打进界面日志）。
        plugins: recvPlugins,
      })
    } catch (e) {
      S.recv.phase = 'error'
      S.recv.error = { title: '接收服务没能启动', message: e?.message ?? String(e) }
      log(`  ✗ 接收模式启动失败：${e?.message ?? e}`)
      throw e
    }
    // P2-2：启动过程中用户已经点了「停止接收」—— 服务现在才真的起来，
    // 立刻销毁它并保持"已停止"（否则界面先显示已停止、一两秒后又"复活"成等待中，
    // 链接/密码/证书其实都还在）。
    if (S.recvAbort) {
      const report = await service.stop().catch(() => null)
      S.recvLive = null
      S.recv.phase = 'stopped'
      S.recv.report = report
      log('  · 启动过程中已收到停止请求：接收服务已立即销毁')
      return { ok: true, stopped: true }
    }
    S.recvLive = service
    S.recv.phase = 'waiting'
    S.recv.url = service.urls.primary
    S.recv.password = service.password
    S.recv.port = service.port
    log(`  ✓ 接收模式已就绪：${S.recv.url}`)
    log(`    一次性密码 ${service.password} · 保存到 ${dir}`)

    // 后台等结束（对方发完 / 超时 / 用户点停止）——**不能 await**，
    // 否则 /api/recv/start 这个请求会一直挂到传输结束（发送那边踩过同一个坑）。
    // P1-3：命令行给了 --timeout 就必须听它的（从前这里写死 30 分钟，flag 被静默忽略）；
    // 没给时接收模式仍给宽一点的时间：用户要先找手机、扫码、选照片。
    const timeoutMs = opts.timeoutMs ?? 30 * 60 * 1000
    S.recvRun = (async () => {
      const result = await waitForReceive(service.receive, timeoutMs)
      const report = await service.stop()
      S.recvLive = null
      S.recv.report = report
      S.recv.elapsed = (Date.now() - t0) / 1000
      const done = service.receive.report?.done?.length ?? 0
      S.recv.filesDone = done
      if (S.recvStopped) S.recv.phase = 'stopped'
      else if (result.ok) S.recv.phase = 'done'
      else S.recv.phase = result.reason === 'timeout' ? 'timeout' : 'error'
      if (S.recv.phase === 'timeout' && !S.recv.error) {
        S.recv.error = { title: '等待超时', message: '一直没有手机连上来，接收服务已销毁。可以再来一次。' }
      }
      log('')
      log(`  接收模式结束（${S.recv.phase}）：${done} 个文件，共 ` +
        `${formatSize(service.receive.state.receivedBytes)}`)
      for (const d of report.done) log('  ✓ ' + d)
      for (const s of report.skipped) log('  – ' + s)
      for (const f of report.failed) log('  ✗ ' + f)
      log('')
      // 传完之后把保存目录弹出来 —— "我手机传的照片到底存哪了"是这个场景最常见的疑问。
      //
      // ⚠️ 但**自动化场景绝不能弹**：测试用的临时目录在测试收尾时就被删掉，
      //    而弹出的资源管理器窗口会在几秒后变成一张"位置不可用"的错误框
      //    —— 2026-10 用户在跑测试时被这个弹窗糊了一脸。
      //    所以除了 `--no-open`，还认 `FLICKER_NO_OPEN=1`（测试/CI 用），
      //    而且 `openFolder()` 自己也会先确认目录还在（见那里的说明）。
      if (S.recv.phase === 'done' && flags['no-open'] !== true
        && process.env.FLICKER_NO_OPEN !== '1') {
        const r = await openRecvDir()
        if (r.ok) log(`  · 已打开保存文件夹：${r.dir}`)
      }
    })().catch((e) => {
      S.recvLive = null
      S.recv.phase = 'error'
      S.recv.error = { title: '接收模式出错', message: e?.message ?? String(e) }
      log(`  ✗ 接收模式出错：${e?.message ?? e}`)
    }).finally(() => { S.recvRun = null })
    return { ok: true, url: S.recv.url, password: S.recv.password, dir }
  }

  /** 会话事件 → 界面状态（页面上那条进度、清单、连接状态都从这来） */
  function onRecvEvent(evt, t0) {
    switch (evt.type) {
      case 'peer-connected':
        S.recv.peer = evt.peer?.address ?? null
        log(`  ✓ 手机已连接 ${S.recv.peer ?? ''}`)
        break
      case 'authed':
        S.recv.phase = 'transfer'
        log('  ✓ 密码核对通过')
        break
      case 'auth-failed':
        log(`  ✗ 密码不一致（第 ${evt.failures}/${evt.max} 次）`)
        break
      case 'manifest-received':
        S.recv.plan = { files: evt.files, skipped: evt.skipped, totalBytes: evt.totalBytes }
        S.recv.phase = 'transfer'
        log(`  清单已收到：${evt.files} 个文件，共 ${formatSize(evt.totalBytes)}`)
        break
      case 'chunk-received': {
        const elapsed = (Date.now() - t0) / 1000
        S.recv.progress = {
          receivedBytes: evt.receivedBytes, totalBytes: evt.totalBytes,
          fileName: evt.fileName, elapsed,
          speed: elapsed > 0.3 ? evt.receivedBytes / elapsed : 0,
        }
        break
      }
      case 'transfer-complete':
        // ⚠️ 这里**不设成 'done'**：那一刻数据收完了，但销毁链还没跑、清单还没拿到 ——
        //    界面如果这时就显示"完成"，会带着一份空的销毁清单（用户最该看到的
        //    "密钥到底清没清"恰好缺失）。终态**只有一个写入点**（下面那个后台循环），
        //    这里只表示"正在收尾"。
        S.recv.phase = 'finalizing'
        break
      default:
        break
    }
  }

  /**
   * 重名询问：把问题摆到界面上，等用户点（或 5 分钟超时）。
   *
   * ⚠️ 这里是**服务端等浏览器**（与发送那边"页面轮询服务端"方向相反），
   *    所以用一个挂起的 Promise + `/api/recv/collision` 来回答。
   *    超时按最安全的"换个名字"处理，并且界面上会说明是自动改的名。
   */
  function askCollision(info) {
    return new Promise((resolve) => {
      const suggested = dedupePath(info.rel, new Set([compareKeyOf(info.rel)]))
      S.recv.pending = { rel: info.rel, existing: info.existing, suggested }
      const done = (choice) => {
        if (!S.recv.pending) return
        S.recv.pending = null
        if (S.recvCollisionTimer) { clearTimeout(S.recvCollisionTimer); S.recvCollisionTimer = null }
        log(`  · 重名「${info.rel}」→ ${choice === 'overwrite' ? '覆盖' : choice === 'skip' ? '跳过' : '改名'}`)
        resolve(choice)
      }
      S.recvCollisionAnswer = done
      S.recvCollisionTimer = setTimeout(() => done('rename'), 5 * 60 * 1000)
      S.recvCollisionTimer.unref?.()
    })
  }

  function answerCollision(choice) {
    const c = ['rename', 'overwrite', 'skip'].includes(choice) ? choice : 'rename'
    if (!S.recvCollisionAnswer) return { ok: true, ignored: true }
    S.recvCollisionAnswer(c)
    S.recvCollisionAnswer = null
    return { ok: true, choice: c }
  }

  /** 用户点「停止接收」：真的销毁（会话、服务、证书），不是只改个状态 */
  async function stopRecv(reason) {
    S.recvStopped = true
    S.recvAbort = true            // 启动窗口期里的停止请求也要兑现（P2-2）
    if (S.recvCollisionAnswer) S.recvCollisionAnswer('rename')     // 别让挂着的提问拖住销毁
    const live = S.recvLive
    if (!live) {
      if (S.recv.phase !== 'off') S.recv.phase = 'stopped'
      return { ok: true }
    }
    log(`  · 用户要求停止接收（${reason}）`)
    live.receive.session.destroy()      // 后台那个等待循环会在 200ms 内发现并走完整销毁链
    return { ok: true }
  }

  /** 收完一批之后：回到"可以再开一次"的状态（会话是一次性的，必须重新起） */
  async function resetRecv() {
    if (S.recvLive) await stopRecv('重新开始')
    S.recv = {
      phase: 'off', dir: S.recv.dir, url: null, password: null, port: null,
      plan: null, peer: null, pending: null, progress: null,
      report: null, error: null, elapsed: null,
    }
    S.recvStopped = false
    return { ok: true }
  }

  /**
   * 把保存目录弹出来（"文件到底存哪了"）。
   * 目录不在时**不弹**，把原因返回给页面（页面会用 alert 说明，而不是弹系统错误框）。
   */
  async function openRecvDir() {
    const dir = S.recv.dir ?? defaultSaveDir()
    const r = openFolder(dir)
    if (!r.ok) log(`  ! 没有打开保存文件夹：${r.error}`)
    return r
  }

  // ── 用闪传自己接收（界面版 `flicker recv <链接>`）──────────────
  //
  // 为什么由 **Node** 去取，而不是让页面去 fetch：
  //   · 页面在 `http://127.0.0.1:<端口>`，对方的接口在 `https://192.168.x.x:<端口>` ——
  //     跨源，而 `src/server.js` 一个 CORS 头都不发；
  //   · 对方用的是**自签证书**，CA 只装在他那台机器上，浏览器不会为 XHR 给"继续前往"。
  //   把取文件这件事交给同一个进程里的 `pullFromLink()`，两个问题一起消失：
  //   它本来就是 `flicker recv <链接>` 那条命令的实现。证书那一关改成"人核对指纹"。

  /**
   * 弹系统自带的「选择文件夹」对话框（Windows: FolderBrowserDialog / macOS: choose folder /
   * Linux: zenity）。拿不到就**明说**原因，让页面退回自带的那个选择器 ——
   * 不要静默失败（用户会以为按钮坏了）。
   *
   * 2026-10 用户提的原话："不能新建文件夹，要不还是用原生的对话框吧"。
   * 页面自带的选择器是给"挑要发的东西"写的，用在"挑保存目录"上处处别扭；
   * 系统对话框有「新建文件夹」、也记得上次去的地方。
   */
  async function pickSaveFolder(body = {}) {
    const title = String(body.title ?? '').trim()
    const startDir = String(body.startDir ?? '').trim() || defaultSaveDir()
    const r = await pickFolder({ title, startDir })
    // ⚠️ **每一种结果都要打一行**：2026-10 用户报"系统对话框没有弹出来"，
    //    而当时只有"成功了"和"这台机器没有"两种会留痕 —— 正好把最需要线索的那两种
    //    （用户取消 / 弹了但失败）吞掉了，只能靠猜。
    if (r.ok) log(`  · 保存文件夹：${r.path}`)
    else if (r.cancelled) log('  · 用户取消了系统文件夹窗口')
    else if (r.reason === 'unsupported') {
      log(`  · 这台机器没有可用的系统文件夹对话框${r.error ? '（' + r.error + '）' : ''}，改用它自带的选择器`)
    } else {
      log(`  ! 系统文件夹窗口打不开（${r.reason}）：${r.error ?? ''}` +
        `${r.stderr ? ' ｜ ' + r.stderr.split('\n').join(' / ') : ''} —— 改用它自带的选择器`)
    }
    return r
  }

  /**
   * 建一个目录（自带选择器的「新建文件夹」用它）。
   *
   * 只允许在**已存在的绝对路径**下建一层，名字里不许有路径分隔符与 Windows 保留字符 ——
   * 这个接口的用途只有"给用户建一个存文件的文件夹"，不该变成一个通用的写盘入口。
   */
  async function makeDir(body = {}) {
    const { mkdir } = await import('node:fs/promises')
    const parent = String(body.parent ?? '').trim()
    const name = String(body.name ?? '').trim()
    if (!parent || !path.isAbsolute(parent)) return { ok: false, error: '需要一个绝对路径的父目录' }
    if (!name) return { ok: false, error: '文件夹名不能为空' }
    // ⚠️ 控制字符也要挡：JS 里 `'a\b'` 是**退格符**（0x08），不是"a 反斜杠 b" ——
    //    在 Linux 上它还是个合法文件名，于是真能建出一个名字里有退格符的文件夹。
    //    人在界面上不会想建这种名字，一律拒绝。
    if (name === '.' || name === '..' || /[\\/:*?"<>|\u0000-\u001f]/.test(name)) {
      return { ok: false, error: '这个名字里含路径分隔符、控制字符或系统不允许的字符' }
    }
    const full = path.join(parent, name)
    // 只允许"在 parent **里面**建一层"：`../escape`、`/abs` 这类一旦放过去，
    // 这个接口就成了"任意位置写目录"的入口（名字里没分隔符也能靠 `..` 逃出去）。
    if (path.dirname(path.resolve(full)) !== path.resolve(parent)) {
      return { ok: false, error: '不能建到上一级目录之外' }
    }
    try {
      await mkdir(full)
    } catch (e) {
      if (e?.code === 'EEXIST') return { ok: true, path: full, existed: true }
      return { ok: false, error: e?.message ?? String(e) }
    }
    log(`  · 新建文件夹：${full}`)
    return { ok: true, path: full }
  }

  /** 只探测：解析链接、连一次、把证书指纹算出来给界面显示（不传任何数据） */
  async function probePullLink(link) {
    const parsed = parseRecvLink(link)
    if (parsed.kind === 'relay') {
      return { ok: false, error: `中继链接请用浏览器打开：${parsed.reason}`, code: 'RELAY_LINK' }
    }
    if (parsed.kind !== 'direct') return { ok: false, error: parsed.reason, code: 'BAD_LINK' }
    try {
      const probe = await probePeer({ base: parsed.base })
      S.pull = {
        ...S.pull,
        phase: 'ready',
        link: String(link),
        fingerprint: probe.secure ? probe.sha256.slice(0, 8).toUpperCase() : null,
        // http 链接没有证书可核对：界面上要**明确**说出来，不能让人以为核对过了
        insecureNoTls: !probe.secure,
        error: null,
        report: null,
        plan: null,
        progress: null,
        files: [],
        failed: [],
      }
      S.pullPinned = probe.secure ? probe.sha256 : null      // 完整 SHA-256：钉住用，不给页面
      log(`  · 探测到对方证书指纹 ${S.pull.fingerprint ?? '（明文 http，无证书）'}`)
      return { ok: true, fingerprint: S.pull.fingerprint, tls: probe.secure, dir: S.pull.dir }
    } catch (e) {
      S.pull = { ...S.pull, phase: 'off', error: { code: e?.code ?? 'PROBE', message: e?.message ?? String(e) } }
      return { ok: false, error: e?.message ?? String(e), code: e?.code ?? 'PROBE' }
    }
  }

  /**
   * 开始接收。**不 await 传输本身** —— 否则这个 HTTP 请求会挂到传完为止
   * （发送那边踩过同一个坑：`/api/start` 里 await 了整场传输）。
   */
  async function startPull(body = {}) {
    const link = String(body.link ?? S.pull.link ?? '').trim()
    const password = String(body.password ?? '')
    const dir = String(body.dir ?? S.pull.dir ?? defaultSaveDir()).trim() || defaultSaveDir()
    if (!link) return { ok: false, error: '还没有链接' }
    if (!password) return { ok: false, error: '还没有填密码' }
    if (S.pull.phase === 'transfer') return { ok: false, error: '已经在接收了' }
    if (S.pull.phase !== 'ready') {
      const p = await probePullLink(link)
      if (!p.ok) return p
    }

    // 指纹核对：界面把探测到的指纹显示给用户，用户点了"一致"才继续。
    // 不勾"已核对"就必须自己把指纹打进来（等价于命令行的 `--fingerprint=`）。
    // 三种形态，界面上的说法与命令行一一对应：
    //   · 用户自己把对方屏幕上的指纹打进来（等价 --fingerprint=）
    //   · 用户点了"我核对过，一致"（界面已经把指纹显示出来了）
    //   · 用户明确选择"不核对"（等价 --insecure，界面上必须写着没核对）
    const typed = String(body.typed ?? '').toUpperCase().replace(/[^0-9A-F]/g, '')
    const insecure = body.insecure === true
    if (S.pull.fingerprint) {
      if (typed && !matchFingerprint(S.pullPinned, typed)) {
        return { ok: false, error: '你输入的指纹与对方证书不一致 —— 可能有人在冒充对方的地址', code: 'FINGERPRINT' }
      }
      if (!insecure && !typed && body.confirm !== true) {
        return { ok: false, error: '请先核对界面上的证书指纹（或明确选择"不核对"）', code: 'NEED_CONFIRM' }
      }
    } else if (!insecure) {
      // 明文 http：没有证书可核对，但也不能悄悄放过
      return { ok: false, error: '这条链接是明文 http，没有证书可核对；确定要继续就明确选择"不核对"', code: 'NEED_CONFIRM' }
    }
    if (insecure) log('  ! 用户选择**不核对**证书指纹（界面上有说明）')

    const controller = new AbortController()
    S.pullController = controller
    S.pull = {
      ...S.pull, phase: 'transfer', link, dir,
      plan: null,
      progress: { bytes: 0, totalBytes: 0, files: 0, totalFiles: 0, current: null },
      files: [], failed: [], report: null, error: null, elapsed: null,
    }
    const t0 = Date.now()
    log(`  ⬇ 开始从对方的链接取文件：${link.replace(/\?k=.*/, '?k=…')} → ${dir}`)
    S.pullRun = (async () => {
      try {
        const r = await pullFromLink({
          link,
          password,
          dir,
          signal: controller.signal,
          // 探测阶段拿到的是**完整 SHA-256**（只把前 8 位显示给用户）：
          // 整场传输都用它钉住证书，中途换一张就立刻失败（见 src/pull.js 的 verifyPeer）
          pinnedSha256: S.pullPinned,
          onManifest: (m) => {
            S.pull.plan = { files: m.files, totalBytes: m.totalBytes }
            S.pull.progress = { ...S.pull.progress, totalBytes: m.totalBytes, totalFiles: m.files }
          },
          onBytes: (n) => {
            const p = S.pull.progress ?? { bytes: 0, totalBytes: 0, files: 0, totalFiles: 0, current: null }
            S.pull.progress = { ...p, bytes: p.bytes + n }
          },
          onFile: (f) => {
            if (f.ok) {
              S.pull.files = [...S.pull.files, { rel: f.finalRel ?? f.rel, bytes: f.bytes }]
              S.pull.progress = { ...S.pull.progress, files: S.pull.files.length, current: f.finalRel ?? f.rel }
            } else {
              S.pull.failed = [...S.pull.failed, { rel: f.rel, reason: f.reason }]
            }
          },
        })
        S.pull.report = { files: r.files.length, bytes: r.bytes, failed: r.failed.length }
        S.pull.elapsed = (Date.now() - t0) / 1000
        S.pull.phase = 'done'
        log(`  ✓ 收到 ${r.files.length} 个文件，共 ${formatSize(r.bytes)}（全部逐块校验）`)
        if (r.failed.length) log(`  ! ${r.failed.length} 个文件失败：${r.failed.map((f) => f.rel).join('、')}`)
      } catch (e) {
        const cancelled = e?.code === 'CANCELLED' || controller.signal.aborted
        S.pull.phase = cancelled ? 'stopped' : 'error'
        S.pull.elapsed = (Date.now() - t0) / 1000
        if (!cancelled) {
          S.pull.error = { code: e?.code ?? 'PULL', message: e?.message ?? String(e) }
          log(`  ✗ 接收失败：${e?.message ?? e}`)
        } else {
          log('  · 已按你的要求停止接收（已收下的文件保留）')
        }
      } finally {
        S.pullController = null
        S.pullRun = null
      }
    })()
    return { ok: true }
  }

  /** 停止：真的中断（关连接），不是只改状态 */
  async function stopPull() {
    if (!S.pullController) {
      if (S.pull.phase === 'transfer') S.pull.phase = 'stopped'
      return { ok: true }
    }
    log('  · 用户要求停止接收')
    S.pullController.abort()
    return { ok: true }
  }

  async function openPullDir() {
    const dir = S.pull.dir ?? defaultSaveDir()
    const r = openFolder(dir)
    if (!r.ok) log(`  ! 没有打开保存文件夹：${r.error}`)
    return r
  }
}

// ── 小工具 ──────────────────────────────────────────────────

/** 界面接口的请求体上限：这些接口只传路径/选项/密码，1 MiB 已经非常宽松（P3-8） */
const MAX_BODY_BYTES = 1024 * 1024

async function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = []
  let total = 0
  for await (const c of req) {
    total += c.length
    if (total > maxBytes) {
      const err = new Error(`请求体超过 ${maxBytes} 字节上限`)
      err.code = 'TOO_LARGE'
      throw err
    }
    chunks.push(c)
  }
  if (!chunks.length) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return {} }
}

/**
 * 判断一个界面请求是不是「本机页面自己」发来的（P1-4）。
 *
 * 只监听 127.0.0.1 **不能**防住这两类攻击：
 *   · CSRF：用户打开任意恶意网页，那个网页可以 fetch http://127.0.0.1:<port>/api/add
 *     （浏览器不拦 —— 请求确实发到了本机）；
 *   · DNS rebinding：攻击者域名先解析到自己的 IP、再切到 127.0.0.1，浏览器就把它
 *     当成同源，于是能读 /api/browse 的文件列表。
 * 所以：Host 必须精确等于本机回环:<这个端口>；带了 Origin 就必须同源。
 * （同源 GET 不带 Origin、POST 会带 —— 两种都要放行，否则会误伤自己的页面。）
 *
 * @returns {string|null} 问题描述；null = 放行
 */
function localRequestProblem(req, port) {
  const host = req.headers.host
  let hostUrl
  try { hostUrl = new URL('http://' + String(host ?? '')) } catch {
    return `Host 不合法（${JSON.stringify(host)}）`
  }
  const name = hostUrl.hostname.toLowerCase()
  const gotPort = hostUrl.port ? Number(hostUrl.port) : 80
  if ((name !== '127.0.0.1' && name !== 'localhost') || gotPort !== port) {
    return `Host 不是本机回环地址（${JSON.stringify(host)}）—— 可能是 DNS rebinding`
  }
  const origin = req.headers.origin
  if (origin !== undefined) {
    const ok = origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`
    if (!ok) return `拒绝跨站请求（Origin: ${origin}）`
  }
  return null
}

/** 就绪探测：确认本地界面服务真的能返回响应 */
async function probe(url, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  let attempts = 0, lastErr = ''
  while (Date.now() < deadline) {
    attempts++
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1000) })
      if (r.status < 500) { await r.text(); return { ok: true, attempts, detail: `HTTP ${r.status}` } }
      lastErr = `HTTP ${r.status}`
    } catch (e) { lastErr = e?.cause?.code ?? e?.name ?? String(e) }
    await new Promise((r) => setTimeout(r, 100))
  }
  return { ok: false, attempts, detail: lastErr }
}

/**
 * 用系统默认方式打开一个 URL（不阻塞）。**导出给 bin/flicker.js 与测试共用**。
 *
 * ⚠️ 这里**绝不能**走 cmd /c start（P0-1 的根因）：Windows 的 spawn 不会给
 *    不含空格的参数加引号，cmd.exe 会把 URL 里的 & 当命令分隔符 ——
 *    对方给的链接 https://relay/room/…?x=1&calc 就等于任意命令执行。
 *    所以 Windows 改用 rundll32 url.dll,FileProtocolHandler（数组传参、不经 shell）。
 * 另外只允许 http/https：file: / javascript: 没有任何理由由界面的「打开」按钮执行。
 *
 * @param {string} url
 * @returns {{cmd:string,args:string[]}}
 * @throws {Error} 不是 http/https 链接
 */
export function openUrlCommand(url) {
  let parsed
  try { parsed = new URL(String(url)) } catch { throw new Error(`不是一个合法的链接：${url}`) }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`只允许打开 http/https 链接（收到 ${parsed.protocol}）`)
  }
  const win = process.platform === 'win32'
  const cmd = win ? 'rundll32' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = win ? ['url.dll,FileProtocolHandler', String(url)] : [String(url)]
  return { cmd, args }
}

/** 打开 URL；打开失败就算了（屏幕上已经给过链接），但**链接非法时要能说出原因**。 */
export function openUrl(url) {
  const { cmd, args } = openUrlCommand(url)
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref() } catch { /* 打不开就算了 */ }
  return { cmd, args }
}

/** 用系统默认方式打开 URL（界面自用的薄包装） */
function openDefault(url) {
  try { openUrl(url) } catch { /* 打开失败就算了：屏幕上已经打印了链接 */ }
}

/**
 * 用系统默认方式打开一个**文件夹**。
 *
 * ⚠️ Windows 上不能走 `start` 的 URL 形式：路径里带空格或 `&` 时会被 cmd
 *    当成参数分隔符（`C:\Users\a & b\Downloads` 会打开两个东西）。
 *    explorer.exe 直接收路径，不做二次解析。
 *
 * ⚠️ **先用 `existsSync` 确认目录还在**（2026-10 用户实测的弹窗）：
 *    目录不存在时 explorer 不会安静失败，而是弹一个"位置不可用 / 该位置可能已移动或删除"
 *    的系统错误框。那个框既看不懂也关不掉意义，而且它会出现在**用户**的屏幕上
 *    （测试跑完删掉临时目录、而窗口还开着时就是这样）。
 *    所以：目录不在就什么都不做，把原因**返回给调用方**，由它决定怎么告诉用户。
 */
/**
 * 打开保存目录。
 *
 * 导出**只为测试**：这条逻辑有两个必须成立的顺序约束（自动化先判、目录不在就不 spawn），
 * 而集成测试里 GUI 子进程的环境是固定的（`FLICKER_NO_OPEN=1`），没法同时验两条分支。
 */
export function openFolder(dir) {
  if (!dir) return { ok: false, dir, error: '没有保存目录' }
  // ⚠️ 自动化场景要**排在"目录在不在"前面**（2026-10 Linux CI 抓出来的）：
  //    自动化时根本不该去碰这个目录，返回的原因也必须是"自动化场景跳过"。
  //    若先查存在性，在没有 ~/Downloads 的环境（CI 的 Linux 就是）会报
  //    "保存目录已经不在了" —— 那是个**看起来像 bug** 的误导性原因。
  if (process.env.FLICKER_NO_OPEN === '1') {
    return { ok: false, dir, error: 'FLICKER_NO_OPEN=1：跳过打开文件夹（自动化场景）' }
  }
  if (!existsSync(dir)) {
    return { ok: false, dir, error: `保存目录已经不在了：${dir}` }
  }
  const cmd = process.platform === 'win32' ? 'explorer'
    : process.platform === 'darwin' ? 'open' : 'xdg-open'
  try {
    spawn(cmd, [dir], { detached: true, stdio: 'ignore' }).unref()
    return { ok: true, dir }
  } catch (e) {
    return { ok: false, dir, error: e?.message ?? String(e) }
  }
}
