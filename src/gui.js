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
import { bindSignals, Destroyer } from './destroy.js'
import { cleanAllLeftovers, cleanTempDirs } from './trust.js'
import { runSend } from './run.js'
import { startReceiveService, defaultSaveDir, waitForReceive } from './recv.js'
import { matchFingerprint, parseRecvLink, probePeer, pullFromLink } from './pull.js'
import { dedupePath } from './manifest.js'
import { compareKeyOf } from './path-safety.js'
import { BROWSER_QR_SOURCE } from './tty.js'


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
  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const json = (obj, code = 200) => {
      const b = Buffer.from(JSON.stringify(obj), 'utf8')
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store' })
      res.end(b)
    }
    try {
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
        const body = await readBody(req)
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
  const signals = bindSignals(destroyer, async () => { await destroyNow('程序退出') })
  await new Promise((resolve) => {
    server.on('close', resolve)
    process.on('SIGINT', resolve)
  })
  await destroyNow('程序退出')
  await destroyer.run()
  // 兜底：把本程序在系统上留下的证书痕迹全部清掉。
  // 即使上面某一步没走完（窗口被强关、异常退出），这里也保证不留残迹。
  //
  // ⚠️ 从前这里是 `.catch(() => {})` —— 静默吞掉。
  //    而"读不到证书库"恰恰是最需要让人知道的情况（上次那张 CA 可能还在）。
  //    现在把失败写进日志（窗口关掉后终端还在，GUI 的日志也在状态里）。
  await cleanAllLeftovers().catch((e) => log(`  ⚠️ 退出时的证书残留清理没做完：${e?.message ?? e}`))
  await cleanTempDirs().catch((e) => log(`  ⚠️ 退出时的临时目录清理没做完：${e?.message ?? e}`))
  signals.uninstall()
  return 0

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
      timeoutMs: flags.timeout ? Number(flags.timeout) : 10 * 60 * 1000,
      onReady: (info) => {
        S.url = info.urls.primary
        S.phase = info.session.phase === 'ready' ? 'transfer' : 'waiting'
        // ⚠️ 必须留住这个句柄：界面上那个「立即销毁」按钮就是靠它工作的。
        //    从前这里只存了 `S.url`，句柄丢掉之后按钮只能改一下阶段文字，
        //    真正的会话（服务、密钥、证书）一个都没动 —— 用户看到的现象是
        //    **点了没反应**（2026-10 实测反馈）。runSend 的 waitForCompletion
        //    每 200ms 检查一次 `session.destroyed`，所以这里 destroy() 之后
        //    它会立刻收尾并走完整的销毁链。
        S.live = { session: info.session }
        log(`  ✓ 接收端链接：${S.url}`)
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
      if (S.destroyRequested) {
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
      } else if (!S.run && S.phase !== 'idle' && S.phase !== 'plan') {
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
    const dir = String(dirInput ?? '').trim() || defaultSaveDir()
    S.recv = {
      phase: 'starting', dir, url: null, password: null, port: null,
      plan: null, peer: null, pending: null, progress: null,
      report: null, error: null, elapsed: null,
    }
    const t0 = Date.now()
    let service
    try {
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
        plugins: plugins?.count ? plugins : null,
      })
    } catch (e) {
      S.recv.phase = 'error'
      S.recv.error = { title: '接收服务没能启动', message: e?.message ?? String(e) }
      log(`  ✗ 接收模式启动失败：${e?.message ?? e}`)
      throw e
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
    const timeoutMs = 30 * 60 * 1000        // 接收模式给宽一点：用户要先找手机、扫码、选照片
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

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  if (!chunks.length) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return {} }
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

/** 用系统默认方式打开 URL */
function openDefault(url) {
  const cmd = process.platform === 'win32' ? 'cmd'
    : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref() } catch { /* 打不开就算了 */ }
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
