#!/usr/bin/env node
/**
 * 闪传 Flicker —— 命令行入口
 * ==========================
 * 保持极薄：只做参数解析与分发，业务逻辑全在 src/。
 *
 * 用法：
 *   flicker                          打开图形界面
 *   flicker send <路径...>           发送文件
 *   flicker recv <链接>              接收（用浏览器打开链接）
 *   flicker --help
 */
import process from 'node:process'
import { spawn } from 'node:child_process'
import { installFromDisk, version, ASSET, assetFingerprint, recordedAssetDigests, readAsset }
  from '../src/assets.js'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

// ⚠️ 这几个**必须是静态 import**，不能写成 `await import('../src/gui.js')`。
//
//    打包器（gen/bundler.mjs）只跟**静态** import 走一遍模块图，动态 import 里的
//    路径会被原样留在产物里 —— 而单文件产物运行时**磁盘上没有 src/**，
//    于是它按 exe 所在目录去解析 `../src/gui.js`：
//      在源码目录里跑 → 恰好能找到（所以测试全绿）
//      把 exe 复制到桌面双击 → `Cannot find module 'C:\Users\…\src\gui.js'`
//      控制台一闪而过，用户只看到"CMD 弹出来一下立刻消失"（2026-10 实测反馈）
//
//    这条坑的判据现在有三道：打包器见到相对路径的动态 import 直接**拒绝构建**、
//    冒烟必须把产物**复制到源码树之外**再跑、`test/startup-order.test.js` 盯着模块图。
import { runGui } from '../src/gui.js'
import { runSend } from '../src/run.js'
import { runSendViaRelay } from '../src/relay/run-relay.js'

/**
 * 块大小（`--chunk`）：`auto`（默认）/ `512k` / `2m` / `4m` / 纯字节数。
 *
 * ── 为什么默认是 auto，而且它只在中继允许时才变大 ──
 * 一条消息就是一块，中继有单条上限。发送端先问中继"你最多收多大"
 * （`/health` 与创建响应里的 `maxMessageBytes`），再取
 * `min(想要的, 对方声明的)`；**老中继不声明就回落到协议保证的 1 MiB + 17**，
 * 于是新客户端 + 老中继不会出现 413。
 *
 * 实测依据（256 MiB、RTT 195 ms、链路 29.5 MB/s 封顶）：块 1 MiB 端到端
 * 18.9 MB/s，2 MiB 是 26.3 MB/s（链路的 89%），4 MiB 没有额外收益。
 * 详细取舍见 `src/chunk-size.js`。
 */
function chunkSpec(flagValue) {
  // 测量用旁路优先（`_lab/bench-recv-rtt.mjs` 靠它固定块大小做 A/B）。
  // 注意它只覆盖"想要的"值，**照样会经过中继上限的裁剪** ——
  // 测量走的必须是生产同一条路，否则量出来的东西不算数。
  const env = chunkBytesOverride()
  if (env) return { kind: 'size', bytes: env }
  if (flagValue === undefined) return { kind: 'auto' }
  const parsed = parseChunkSpec(flagValue === true ? 'auto' : flagValue)
  if (parsed.error) {
    process.stderr.write('\n' + parsed.error + '\n')
    process.exit(EXIT.USAGE ?? 2)
  }
  return parsed
}

// ── 安装资源（源码模式）──────────────────────────────────────// SEA 单文件模式下由 entry/sea-entry.cjs 安装同样的接口，
// 所以 src/ 里的代码不需要知道自己跑在哪种形态里。
//
// 这里刻意用「入口先装、模块后取」而不是条件导入：
// 试过 package.json 的 imports 条件映射，普通 Node 下可用，
// 但 SEA 产物里不成立（SEA 的模块加载器不按包边界解析，连 ES 模块都加载不了）。
// 源码模式下入口是 ESM，可以放心用 import.meta 算路径；
// 但路径本身交给 assets.js，以免 import.meta 被带进打包产物
//（CommonJS 里 import.meta 不存在，用了就是语法错误）。
if (!globalThis.__flickerRoot) {
  installFromDisk(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'))
}

import { EXIT } from '../src/destroy.js'
import { RateLimiter, parseRate } from '../src/rate.js'
import { parseChunkSpec } from '../src/chunk-size.js'
import { sourcePackFingerprint, SOURCE_PACK_ASSET, unpackToDir } from '../src/gift.js'
import { runRecv, defaultSaveDir } from '../src/recv.js'
import { matchFingerprint, parseRecvLink, probePeer, pullFromLink } from '../src/pull.js'
import { tty } from '../src/tty.js'
import { createPluginRegistry, pluginPaths } from '../src/plugin/registry.js'

const USAGE = `
  闪传 Flicker —— 一次性文件传输，接收端零安装，用完即销毁

  用法
    flicker                          打开图形界面
    flicker send <路径...> [选项]     发送文件或文件夹
    flicker recv                     接收模式：起服务，等手机把文件发过来
    flicker recv --listen            同上（显式写法）
    flicker recv <链接>               用**程序自己**接收对方给的直连链接（逐块校验、落盘）
    flicker recv <链接> --browser      同上，但改用浏览器打开（中继链接也只能这样）
    flicker unpack <文件.fkz>          解开对方随文件送来的源码包（--dir=目录 / --force 覆盖）
    flicker --version                 显示版本号
    flicker --assets                  显示内嵌资源的指纹（核对产物是不是最新）

  接收选项（flicker recv <链接>：用程序直接接收）
    --dir=路径          存到哪里（默认：这台电脑的「下载」目录）
    --password=密码     对方给的一次性密码；不给就问你
    --fingerprint=前缀  对方屏幕上那个证书指纹（8 位），一致才连（脚本用，不提问）
    --insecure          跳过证书核对（屏幕上会明确写出"没有核对"；只用于自家局域网）
    --browser           改用浏览器打开链接（中继链接必须这样）

  接收选项（flicker recv：手机往这台电脑发）
    --dir=路径          存到哪里（默认：这台电脑的「下载」目录）
    --password=密码     指定一次性密码；不指定则生成一个 6 位短码（手机上好念好打）
    --no-ask            重名一律自动改名，不弹"换个名字/覆盖/跳过"（无人值守用）
    --no-open           传完不自动打开保存目录
    --trust             把会话证书装进本机信任库（**手机用不上**；只在本机预览时需要）
    --max-files=N       最多收多少个文件（默认 5000）
    --max-bytes=N       最多收多少字节（默认 200 GB）

  发送选项
    --relay=地址        经中继传输（两台电脑不在同一网络时用）
    --window=8          中继模式的在途块数（默认 8）
                        1 = 停等：实测 4.72 MB/s；8 = 批量投递：实测 20.75 MB/s
    --chunk=auto        块大小（auto / 512k / 2m / 4m）
                        auto 会先问中继"一条消息最多收多大"再决定；
                        老中继不声明就按协议默认的 1 MiB，不会出错
    --rate=5M           限速（两种模式都生效）。别占满公司/家里的上行带宽
                        写法：500K / 5M / 2G，或直接给字节数
    --password=密码     指定密码（不指定则随机生成并二次确认）
    --port=端口         指定监听端口（默认随机）
    --bind=地址         监听地址（默认 0.0.0.0，即允许局域网访问）
    --timeout=10m       等待对方连接的超时
    --no-gift           不附带赠送闪传程序
    --no-cert-install   不往系统证书库装证书（对方需手动点一次"继续访问"）
    --no-qr             不显示二维码
    --no-color          不使用颜色
    --dry-run           只列出要发送的清单，不启动传输

  插件（可选，详见 docs/插件.md）
    --plugin=<路径>     加载一个插件，可重复给多次
                        也可以写环境变量 FLICKER_PLUGINS（多个路径用 ; 或 : 分开）
                        **只在你显式指定时才会加载**：不扫目录、不自动发现
    --plugins           只列出并校验插件（不传输），插件作者用它确认写对了

  例子
    flicker send "D:\\视频\\旅行记录.mp4"
    flicker send "D:\\照片" "D:\\合同.pdf" --password=my-secret
    flicker send "D:\\文件.zip" --no-qr --timeout=30m
    flicker send "D:\\文件.zip" --relay=https://flicker.you.workers.dev
    flicker recv                               手机传照片：存到「下载」，密码显示在屏幕上
    flicker recv --dir="D:\\照片\\手机" --no-ask  指定目录，重名不打扰我

  安全说明
    · 密码不会离开本机 —— 两台电脑各自计算，只交换挑战与应答
    · 文件内容端到端加密，不写任何临时文件
    · 传输结束即销毁密钥、关闭服务、移除会话证书
    · 接收模式下**收到的文件会保留**（那是你的文件）；销毁清单会写明存在哪个目录

  文档：读我.md（中文）/ README.md（English）· 中文文档/ · docs/
`

/** 解析 --key=value / --flag 两种形式 */
function parseArgs(argv) {
  const flags = {}, positional = []
  for (const a of argv) {
    if (a.startsWith('--') || a.startsWith('-')) {
      const body = a.replace(/^-+/, '')
      const eq = body.indexOf('=')
      if (eq >= 0) {
        const k = body.slice(0, eq), v = body.slice(eq + 1)
        // 同一个选项给多次 → 收成数组（`--plugin=a --plugin=b`）。
        // 单个时仍然是字符串，所以现有调用方一个字都不用改。
        if (k in flags) flags[k] = Array.isArray(flags[k]) ? [...flags[k], v] : [flags[k], v]
        else flags[k] = v
      } else flags[body] = true
    } else positional.push(a)
  }
  return { flags, positional }
}

/** 解析时长：30s / 10m / 2h */
function parseDuration(s, fallbackMs) {
  if (s === undefined || s === true) return fallbackMs
  const m = String(s).match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i)
  if (!m) throw new Error(`看不懂的时长: ${s}（应为 30s / 10m / 2h）`)
  const n = Number(m[1])
  const unit = (m[2] ?? 'm').toLowerCase()
  const mult = { ms: 1, s: 1000, m: 60000, h: 3600000 }[unit]
  return Math.round(n * mult)
}

async function main() {
  const argv = process.argv.slice(2)
  const { flags, positional } = parseArgs(argv)

  if (flags.version || flags.v) {
    // 版本号由入口提供：源码模式读 package.json，SEA 模式读内嵌资产。
    // 这样这里不需要知道自己在哪种形态里跑。
    process.stdout.write(`闪传 Flicker ${await version()}  (Node ${process.versions.node})\n`)
    return EXIT.OK
  }

  // `--assets`：自证"我这个二进制里内嵌的是哪一版页面"。
  //
  // 为什么需要它：SEA 产物把 `web/*.html` 打包进去，而**构建脚本不会因为
  // 你改了页面就自动重跑**。2026-10 就真的出现过：dist/ 里那个 89.5 MB 的
  // 产物是好几天前的界面（没有 i18n、没有单独清除按钮），而 390 个用例全绿、
  // `smoke` 也全绿 —— 差一点把旧版本当新版本发出去。
  //
  // 单文件形态下这些指纹是**构建时**写进 version.json 的，所以它记录的是
  // "打包那一刻的样子"；源码模式下没有这个文件，就现算（源码模式读到什么就是什么）。
  // 两种情况下 `gen/smoke-sea.mjs` 都能拿这些值跟磁盘上的文件比对。
  if (flags.assets) {
    const recorded = await recordedAssetDigests()
    const lines = []
    for (const name of Object.values(ASSET)) {
      const digest = recorded
        ? (recorded[name] ?? '(未记录)')
        : assetFingerprint(await readAsset(name))
      lines.push(`${name}  ${digest}`)
    }
    // 内嵌的源码包（赠品）也自证一下。
    //
    // 为什么要多这一行：**它是同一个坑的第二次** —— 页面曾经"改了却忘了重新构建"，
    // 而源码包装的是源码 + 全部文档，改了文档不重新构建，对方收到的就是旧文档。
    //   单文件形态：读构建时记在 version.json 里的那份指纹
    //   源码形态  ：现场打一份（读盘即真相，与正式赠送走同一个 buildSourcePack）
    const pack = recorded
      ? (recorded[SOURCE_PACK_ASSET] ?? '(未记录)')
      : (await sourcePackFingerprint() ?? '(没有内嵌源码包)')
    lines.push(`${SOURCE_PACK_ASSET}  ${pack}`)
    process.stdout.write(lines.join('\n') + '\n')
    return EXIT.OK
  }

  if (flags.help || flags.h || (positional[0] === 'help')) {
    process.stdout.write(USAGE)
    return EXIT.OK
  }

  // ── 插件 ────────────────────────────────────────────────────
  //
  // 加载策略：**只允许显式指定**（`--plugin=` / `FLICKER_PLUGINS`），
  // 绝不自动发现 —— 插件是以你的权限运行的任意代码，顺手加载旁边的目录
  // 会把"这个程序不需要装任何第三方东西"变成一句谎。见 docs/插件.md。
  //
  // ⚠️ `planes` 必须在这里就定下来（2026-10）：一个插件在**哪个平面**加载，
  //    就只允许用那个平面的钩子。从前只拦"拼错的名字"，于是
  //    `flicker recv --plugin=<发送端插件>` 会安静地什么都不做。
  const cmd = positional[0]
  const isRecvServe = (cmd === 'recv' || cmd === 'receive') && positional[1] === undefined
  const pluginSources = pluginPaths({ flagValue: flags.plugin })
  const wantPlugins = pluginSources.length > 0 || flags.plugins === true
  let plugins = null
  if (wantPlugins) {
    plugins = createPluginRegistry({
      flickerVersion: await version(),
      // `--plugins` 只列出、不运行 → 不限制平面（它要能告诉你"你写的对不对"）；
      // 界面同时做发送与接收两个方向 → 两个平面都允许；
      // 命令行则严格按这次要做的事来。
      planes: flags.plugins === true ? null
        : cmd === undefined ? ['sender', 'receive']
          : isRecvServe ? ['receive'] : ['sender'],
    })
    if (pluginSources.length) {
      try {
        await plugins.load(pluginSources)
      } catch (e) {
        process.stderr.write(`\n  ✗ ${e?.message ?? e}\n\n`)
        return EXIT.USAGE          // 用户显式要求的插件加载不了 → 明确失败，不静默跳过
      }
    }
  }
  if (flags.plugins === true) {
    // `--plugins`：只列出并校验，不传输（插件作者用它确认自己写对了）
    const list = plugins.list
    process.stdout.write(list.length
      ? list.map((p) => `  ${p.name}${p.version ? '@' + p.version : ''}` +
          `  api=${p.apiVersion}  订阅/贡献: ${p.events.join(', ') || '（无）'}` +
          `  副作用: ${p.effects} 个\n      ${p.file}`).join('\n') + '\n'
      : '  （没有加载任何插件：用 --plugin=<路径> 或 FLICKER_PLUGINS 指定）\n')
    return EXIT.OK
  }

  // ── 接收：不带链接 = 起一个接收服务（手机往这台电脑发）；带链接 = 老行为（打开浏览器）──
  if (cmd === 'recv' || cmd === 'receive') {
    const link = positional[1]
    // `--listen` 是**显式同义词**（设计草稿里写的就是 `flicker recv --listen`）。
    // 留它的理由：不带参数的形态更好记，但"我准备好收了"这件事值得能说出来 ——
    // 而且如果只靠"没给链接"来判定，一个写错的 `--listne` 会**静默地**变成收文件模式，
    // 用户以为自己在等着收，其实也是（结果对、但理由不对，这里索性把它变成显式的）。
    if (flags.listen === true && link !== undefined) {
      process.stderr.write('  ✗ --listen 与链接不能同时给：\n' +
        '      flicker recv                 起服务，等手机/别人发过来\n' +
        '      flicker recv "<链接>"         用浏览器打开对方给的链接\n')
      return EXIT.USAGE
    }
    if (link === undefined) {
      // 接收模式从 2026-10 起**支持插件**（第四个平面：接收端进程，`recv/*`）。
      // 注册表在这里是按 `planes: ['receive']` 建的 —— 一个发送端插件会**当场报错**，
      // 而不是安静地什么都不做。
      const result = await runRecv({
        dir: typeof flags.dir === 'string' ? flags.dir : undefined,
        password: typeof flags.password === 'string' ? flags.password : undefined,
        port: flags.port ? Number(flags.port) : undefined,
        bind: typeof flags.bind === 'string' ? flags.bind : undefined,
        timeoutMs: parseDuration(flags.timeout, 10 * 60 * 1000),
        trust: flags.trust === true,
        ask: flags['no-ask'] !== true,
        noQr: flags['no-qr'] === true,
        noColor: flags['no-color'] === true,
        machine: flags.machine === true,
        machineCertFile: typeof flags['machine-cert'] === 'string' ? flags['machine-cert'] : undefined,
        limits: {
          ...(flags['max-files'] ? { maxFiles: Number(flags['max-files']) } : {}),
          ...(flags['max-bytes'] ? { maxBytes: Number(flags['max-bytes']) } : {}),
        },
        plugins: plugins?.count ? plugins : null,
      })
      // 传完之后把保存目录弹出来 —— 手机上"文件到底存哪了"是这个场景最常见的疑问。
      // （浏览器/系统不给打开就算了，屏幕上已经打印过路径。）
      if (result.ok && flags['no-open'] !== true) openPath(result.dir)
      return result.ok ? EXIT.OK : EXIT.TIMEOUT
    }
    if (!/^https?:\/\//.test(link)) {
      process.stderr.write(`  这不是一个链接: ${link}\n`)
      return EXIT.USAGE
    }

    // ── 给了链接：用**程序自己**接收（2026-10 起）──
    //
    // 从前这里只有 `openBrowser(link)`：把链接丢给浏览器，接收由发送端发来的那个
    // 网页完成。于是"双方都装了程序"其实没有区别 —— 收文件那侧永远是浏览器。
    // 现在默认反过来了：**Node 自己下载、逐块校验、落盘**；想用浏览器就加 `--browser`。
    //
    // 证书那一关（自签没有第三方背书，浏览器靠"高级 → 继续前往"过）在这里由人核对：
    // 发送端屏幕上会打印"证书指纹 a3f9c1d2"，这里算出同一份，要你确认一致。
    // 不想每次都问就 `--fingerprint=a3f9c1d2`；确定是自家局域网就 `--insecure`。
    const parsedLink = parseRecvLink(link)
    if (flags.browser === true || parsedLink.kind === 'relay') {
      if (flags.browser !== true) {
        // 中继链接：接收端在页面里（中继发页面、页面拉房间），这条路没实现，
        // 与其假装支持，不如说清楚 —— 而中继的证书本来就可信，浏览器那条路没有门槛。
        process.stderr.write(`  ✗ 中继链接请用浏览器打开：${parsedLink.reason}\n`)
        return EXIT.USAGE
      }
      openBrowser(link)
      process.stdout.write(`  已用浏览器打开：${link}\n  请在页面上输入对方告诉你的一次性密码。\n`)
      return EXIT.OK
    }
    if (parsedLink.kind !== 'direct') {
      process.stderr.write(`  ✗ ${parsedLink.reason}\n`)
      return EXIT.USAGE
    }

    const ui = tty({ noQr: true, noColor: flags['no-color'] === true, machine: flags.machine === true })
    ui.banner()
    ui.step(`登记这条链接：${parsedLink.base}`)
    let pinned = null
    const probe = await probePeer({ base: parsedLink.base })
    if (probe.secure) {
      const shown = probe.sha256.slice(0, 8).toUpperCase()
      const want = typeof flags.fingerprint === 'string' ? flags.fingerprint.trim() : null
      if (want) {
        if (!matchFingerprint(probe.sha256, want)) {
          process.stderr.write(`  ✗ 证书指纹对不上：屏幕上是 ${shown}，你给的是 ${want}\n` +
            '      —— 可能是有人冒充了对方的地址。已停止，没有传输任何数据。\n')
          return EXIT.AUTH
        }
        ui.ok(`证书指纹与 --fingerprint 一致（${shown}）`)
        pinned = probe.sha256
      } else if (flags.insecure === true) {
        ui.warn(`⚠️  --insecure：这次**没有核对**证书指纹（实际是 ${shown}）`)
        ui.warn('    一个冒充了对方地址的假服务，在这里是拦不住的 —— 只在你确定是自家局域网时这么用')
        pinned = probe.sha256   // 仍然钉住这次看到的证书，别中途换一张
      } else {
        // 让人核对：这是 SSH 第一次连接那套做法 —— 不信 CA，信"两边看到的是同一张证书"
        const answer = await ui.askLine(
          `  对方屏幕上应当显示「证书指纹 ${shown}」。一致吗？[y/N] `)
        if (!/^y(es)?$/i.test(String(answer).trim())) {
          process.stderr.write(
            '  ✗ 没有确认证书指纹，已停止（没有传输任何数据）。\n' +
            `     一致就再跑一次并加 --fingerprint=${shown}；` +
            '确定是自家局域网可以加 --insecure（屏幕上会明确写出"没有核对"）。\n')
          return EXIT.AUTH
        }
        pinned = probe.sha256
      }
    } else {
      ui.warn('这条链接是明文 http（只在测试或可信局域网里才该这样）—— 本次没有证书可核对')
    }

    // 密码：命令行给了就用，否则问。不给就当场失败（不许空密码去握手）
    let pullPassword = typeof flags.password === 'string' ? flags.password : null
    if (!pullPassword) {
      pullPassword = String(await ui.askLine('  输入对方告诉你的一次性密码: ')).trim()
    }
    if (!pullPassword) {
      process.stderr.write('  ✗ 没有密码：用 --password=<密码> 给，或在提示里输入\n')
      return EXIT.USAGE
    }

    const outDir = typeof flags.dir === 'string' ? flags.dir : defaultSaveDir()
    ui.step(`保存到：${outDir}`)
    let result
    try {
      result = await pullFromLink({
        link, password: pullPassword, dir: outDir, pinnedSha256: pinned, ui,
      })
    } catch (e) {
      ui.error(e?.message ?? String(e))
      const code = e?.code
      if (code === 'BAD_PASSWORD' || code === 'PEER_AUTH') return EXIT.AUTH
      if (code === 'TOKEN_USED' || code === 'TOKEN_INVALID') return EXIT.USAGE
      if (code === 'HASH' || code === 'CHUNK_HASH' || code === 'DECRYPT' || code === 'LENGTH') return EXIT.INTEGRITY
      if (code === 'CONNECT' || code === 'TIMEOUT') return EXIT.NETWORK
      return EXIT.ERROR
    }
    ui.progressDone()
    if (result.files.length) {
      ui.ok(`收到 ${result.files.length} 个文件，共 ${result.bytes} 字节，全部校验通过`)
      ui.info(`它们在 ${outDir}（“用完即销毁”只销毁密码与链接 —— 收到的文件是你的，不会被动）`)
    }
    if (result.failed.length) {
      for (const f of result.failed) ui.error(`${f.rel}：${f.reason}`)
      return EXIT.INTEGRITY
    }
    if (flags['no-open'] !== true) openPath(outDir)
    return EXIT.OK
  }

  // ── 解开收到的源码包（`flicker unpack <文件.fkz>`）──
  //
  // 这条命令的存在理由很具体：**把源码送给对方**这件事以前只做了一半 ——
  // 对方拿到 `.fkz` 之后，产品里没有任何东西能打开它（连"我们自己"都不能）。
  // 现在可以了，而且用的是**收到的那份程序**（exe），不需要装 Node、不需要别的工具。
  //
  // 安全上不信任这个包（它可能来自别人、甚至被伪造过）：路径、UTF-8、重复项、
  // 截断与尾部垃圾都由 `unpackArchive()` 挡，这里的职责只是"选目录 + 落盘 + 说结果"。
  if (cmd === 'unpack') {
    const file = positional[1]
    if (!file) {
      process.stderr.write('  ✗ 给一个 .fkz 文件的路径：flicker unpack <文件.fkz> [--dir=目录] [--force]\n')
      return EXIT.USAGE
    }
    let buf
    try {
      buf = await readFile(file)
    } catch (e) {
      process.stderr.write(`  ✗ 读不到 ${file}：${e?.code === 'ENOENT' ? '文件不存在' : (e?.message ?? e)}\n`)
      return EXIT.USAGE
    }
    const base = path.basename(file).replace(/\.fkz$/i, '')
    const into = typeof flags.dir === 'string' && flags.dir
      ? flags.dir
      : path.join(path.dirname(path.resolve(file)), base)
    try {
      const r = await unpackToDir(buf, into, { force: flags.force === true })
      if (flags.machine === true) {
        process.stdout.write(`__UNPACKED__ ${r.dir} ${r.files.length} ${r.bytes}\n`)
      } else {
        process.stdout.write(`  ✓ 解开 ${r.files.length} 个文件（${r.bytes} 字节）→ ${r.dir}\n`)
        process.stdout.write('  ' +
          '想看它是什么：node bin/flicker.js --help（需要 Node 24+）；' +
          '只想看代码，直接用编辑器打开那个目录即可\n')
      }
      return EXIT.OK
    } catch (e) {
      process.stderr.write(`  ✗ ${e?.message ?? e}\n`)
      // "目标已存在"是**用法**问题（换个目录、或加 --force），不是程序出错
      return e?.code === 'EXISTS' ? EXIT.USAGE : EXIT.ERROR
    }
  }

  // ── 发送（默认行为）──
  const rate = makeLimiter(flags.rate)
  if (rate.error) {
    process.stderr.write('  ' + rate.error + '\n')
    return EXIT.USAGE
  }
  const inputs = cmd === 'send' ? positional.slice(1) : positional
  if (inputs.length === 0) {
    // 什么都不带 → 打开图形界面。
    // 图形界面**支持插件**（2026-10）：注册表在这里加载好之后传进去，由界面把它
    // 挂到发送流程上，并把插件的日志改道进界面的日志面板（见 gui.js 的 setLog）。
    // ⚠️ 从前这里是"明确拒绝" —— 因为界面进程不解析 `--plugin`，悄悄忽略会让用户
    //    以为插件生效了。现在改成真的支持，而不是换个地方假装。
    return runGui({ flags, plugins })
  }

  // 插件加载了什么，必须打在屏幕上（`--machine` 模式下 stdout 只允许有 __READY__，
  // 所以那种情况改走 stderr —— 自动化客户端解析 stdout 的契约不能破）。
  if (plugins?.count) {
    const line = `  🧩 已加载 ${plugins.describe()}\n`
    if (flags.machine === true) process.stderr.write(line)
    else process.stdout.write(line)
  }

  // 两种模式选一：给了 --relay 就走中继（跨网络），否则走局域网直连。
  // 两者共用前半段（扫描/哈希/密钥/清单），差异只在数据怎么走。
  const viaRelay = typeof flags.relay === 'string' && flags.relay.length > 0
  const run = viaRelay ? runSendViaRelay : runSend

  const result = await run({
    inputs,
    password: typeof flags.password === 'string' ? flags.password : undefined,
    port: flags.port ? Number(flags.port) : undefined,
    bind: typeof flags.bind === 'string' ? flags.bind : undefined,
    timeoutMs: parseDuration(flags.timeout, 10 * 60 * 1000),
    gift: flags['no-gift'] !== true,
    installCert: flags['no-cert-install'] !== true,
    noQr: flags['no-qr'] === true,
    noColor: flags['no-color'] === true,
    dryRun: flags['dry-run'] === true,
    machine: flags.machine === true,
    relay: viaRelay ? flags.relay : undefined,
    windowSize: flags.window ? Number(flags.window) : undefined,
    chunk: chunkSpec(flags.chunk),
    limiter: rate.limiter ?? null,
    machineCertFile: typeof flags['machine-cert'] === 'string' ? flags['machine-cert'] : undefined,
    plugins,
  })
  if (result.dryRun) return EXIT.OK
  return result.ok ? EXIT.OK : EXIT.TIMEOUT
}

/**
 * 把 `--rate` 变成一个 RateLimiter。
 *
 * 返回 { limiter }、{ error }（参数看不懂）或 {}（没给这个参数）。
 *
 * ⚠️ 为什么不"解析不了就当不限速"：用户以为限了 5 MB/s、实际占满上行，
 *    这种误解只有等同事抱怨网络卡才会被发现。宁可现在报错。
 */
function makeLimiter(spec) {
  if (spec === undefined || spec === false) return {}
  const n = parseRate(spec === true ? '' : spec)
  if (!Number.isFinite(n)) {
    return {
      error: `--rate 的写法看不懂：「${spec}」\n` +
        '  可用写法：500K、5M、2G（按字节/秒，K/M/G 是 1024 进制），' +
        '或直接给数字（字节/秒，例如 1048576）\n',
    }
  }
  return { limiter: new RateLimiter(n) }
}

/**
 * 块大小的**测量用**覆盖（`FLICKER_CHUNK_BYTES`）。
 *
 * ⚠️ 这是给 `_lab/` 的基准脚本用的旁路，**不是给用户的**：
 *    它绕过能力协商，直接把块大小钉死（测量时需要"同一份发送端跑不同块大小"）。
 *    用户请用 `--chunk`，那条路会先问中继能收多大。
 */
function chunkBytesOverride() {
  const raw = process.env.FLICKER_CHUNK_BYTES
  if (!raw) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1024 || n > 64 * 1024 * 1024) {
    throw new Error(`FLICKER_CHUNK_BYTES 只能是 1024 ~ 67108864 之间的整数，收到「${raw}」`)
  }
  return n
}

/** 用系统默认方式打开一个 URL（不阻塞） */
function openBrowser(url) {
  const cmd = process.platform === 'win32' ? 'cmd'
    : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref()
  } catch { /* 打不开就算了，用户自己复制链接 */ }
}

/**
 * 用系统默认方式打开一个**文件夹**（不阻塞）。
 *
 * 与 openBrowser 分开写，是因为 Windows 上打开文件夹不能走 `start` 的 URL 形式：
 * 路径里带空格或 `&` 时会被 cmd 当成参数分隔符（`C:\Users\a & b\Downloads` 会
 * 打开两个东西）。explorer.exe 直接收路径，不做二次解析。
 *
 * ⚠️ **目录不存在就什么都不做**：explorer.exe 遇到不存在的路径不会安静失败，
 *    而是弹一个"位置不可用 / 该位置可能已移动或删除"的系统错误框（2026-10 用户实测）。
 *    自动化场景（`FLICKER_NO_OPEN=1`）同样跳过 —— 在别人桌面上弹窗口不是"顺手"。
 */
function openPath(p) {
  if (!p || !existsSync(p)) return false
  if (process.env.FLICKER_NO_OPEN === '1') return false
  const cmd = process.platform === 'win32' ? 'explorer'
    : process.platform === 'darwin' ? 'open' : 'xdg-open'
  try {
    spawn(cmd, [p], { detached: true, stdio: 'ignore' }).unref()
    return true
  } catch { return false }   // 打不开就算了，屏幕上已经打印过路径
}

main()
  .then((code) => { process.exitCode = code ?? EXIT.OK })
  .catch((err) => {
    process.stderr.write(`\n  ✗ ${err?.message ?? err}\n\n`)
    if (process.env.FLICKER_DEBUG) process.stderr.write((err?.stack ?? '') + '\n')
    process.exitCode = EXIT.ERROR
  })
