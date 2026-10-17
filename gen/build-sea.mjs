#!/usr/bin/env node
/**
 * 构建单文件可执行程序（SEA）
 * ===========================
 * Node 24 内置 SEA：把 JS 与资源嵌进一份 Node 运行时副本，产出**一个文件**。
 * 这是"自赠程序"的完整形态 —— 对方双击就能跑，什么都不用装。
 *
 * 流水线（每一步都会验证，失败即停）：
 *   ① 打包模块图       → app.cjs（CommonJS，因为 SEA 不解析包边界的 ES 模块）
 *   ② 准备构建目录     → app.cjs / sea-entry.cjs / version.json / 各资源文件
 *   ③ 生成 SEA blob    → node --experimental-sea-config
 *   ④ 复制 Node 运行时 → 以它为基底
 *   ⑤ 注入 blob        → postject（**它不依赖 Windows SDK**，纯 JS 改写 PE/ELF/Mach-O）
 *   ⑥ 自检产物         → 真的跑一次 --version，并对产物做完整性检查
 *
 * 关于 postject：这是唯一一个构建期第三方工具，运行期零依赖不变。
 * 试过自己实现 PE 段注入，但那是一条容易出错的路；postject 是 Node 官方文档
 * 指定的工具，且只在构建机器的 devDependencies 里出现。
 *
 * 用法：
 *   node gen/build-sea.mjs                 # 构建当前平台
 *   node gen/build-sea.mjs --no-inject     # 只到 blob，方便排查
 *   node gen/build-sea.mjs --keep          # 保留构建目录
 */
import { spawnSync } from 'node:child_process'
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundle } from './bundler.mjs'
import { SOURCE_ASSETS, digestAll } from './asset-digests.mjs'
import { runNpx } from './npx.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (n) => args.includes('--' + n)

// ── 要嵌进去的资源 ──────────────────────────────────────────
// ⚠️ **不在这里另抄一份清单**：这份清单必须与"运行时按名字去读的那几个键"
//    （`src/assets.js` 的 `ASSET`）完全一致，也要与冒烟时核对的那份一致。
//    抄成三份就会漂移：新加一个资源、构建忘了嵌，或者构建嵌了、冒烟漏查。
//    所以唯一来源是 `src/assets.js`，经 gen/asset-digests.mjs 转出来。
const ASSETS = SOURCE_ASSETS

const OUT_DIR = path.join(ROOT, 'dist')

/**
 * 构建目录。
 *
 * ⚠️ **名字必须是确定的，不许带时间戳/随机数。**
 *
 * 这个路径会**进 SEA blob** —— 入口文件名是 `…/sea-entry.cjs`，它以绝对路径的形式
 * 被写进产物（错误信息与堆栈里要显示它）。所以"带时间戳的临时目录"会让
 * **同样的源码产出不同的二进制**，可复现构建就没了。
 *
 * 实测（2026-10）：连续两次构建的产物只差 7 个字节，diff 出来正是
 * `…/flicker-sea-build-1791953763234/sea-entry.cjs` 里的那串时间戳。
 * 而 `release.mjs` 明写着"校验值 + 可复现构建"，README 也用这一点说服人下载 ——
 * 一个做不到的承诺比没有承诺更糟。
 *
 * 按平台命名（而不是按时间）就够了：同一台机器同一时间不会构建两个同平台产物；
 * 真并行构建时目录冲突会**立刻报错**，比悄悄产出两个不同的二进制好得多。
 */
const BUILD = path.join(tmpdir(), `flicker-sea-build-${platformTag()}`)

function log(step, msg) { console.log(`  ${step} ${msg}`) }
function fail(msg) { console.error(`\n  ✗ ${msg}\n`); process.exitCode = 1; throw new Error(msg) }

/** 源码包在产物里的资产名（在 try 块里赋值，供 sea-config 的 assets 用） */
let embeddedSourcePack = 'source-pack.fkz'

function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { encoding: 'utf8', ...opts })
  return { code: r.status, signal: r.signal ?? null, out: (r.stdout ?? '') + (r.stderr ?? '') }
}

function platformTag() {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'ia32' ? 'x86' : 'x64'
  const os = process.platform === 'win32' ? 'windows' : process.platform
  return `${os}-${arch}`
}

function human(bytes) { return (bytes / 1024 / 1024).toFixed(1) + ' MB' }

// ── 主流程 ─────────────────────────────────────────────────

console.log('\n  闪传 Flicker —— 构建单文件程序')
console.log(`  平台: ${platformTag()}    Node: ${process.versions.node}\n`)

try {
  // ① 打包
  log('①', '打包模块图…')
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  let bundled
  try {
    bundled = bundle(path.join(ROOT, 'bin', 'flicker.js'), {
      // 入口在源码模式下用 import.meta.url 算项目根目录 —— 那在 ESM 里合法，
      // 但在 CommonJS 产物里不存在。SEA 入口已经装好了 __flickerRoot，
      // 所以这里把整段"算根目录"的表达式换成入口提供的值。
      replace: [{
        find: /path\.resolve\(path\.dirname\(fileURLToPath\(import\.meta\.url\)\), '\.\.'\)/,
        replace: '__flickerRoot',
      }],
    })
  } catch (e) {
    fail(`打包失败：${e.message}`)
  }
  log(' ', `${bundled.modules.length} 个模块，${(bundled.bytes / 1024).toFixed(1)} KB`)
  for (const m of bundled.modules) {
    log(' ', '  · ' + path.relative(ROOT, m).replace(/\\/g, '/'))
  }

  // ② 构建目录
  //
  // 先用后清：目录名是确定的（见 BUILD 的说明），所以上一次构建留下的东西
  // 必须先删干净 —— 否则残留文件会混进这次产物，而产物还"看起来很新"。
  log('②', '准备构建目录…')
  rmSync(BUILD, { recursive: true, force: true })
  mkdirSync(BUILD, { recursive: true })

  // 打包产物：CommonJS。ESM 的 export 语法已经由打包器剥掉，
  // 但二进制内容（如 BROWSER_QR_SOURCE 里的源码字符串）不受影响。
  writeFileSync(path.join(BUILD, 'app.cjs'), bundled.code, 'utf8')
  copyFileSync(path.join(ROOT, 'entry', 'sea-entry.cjs'), path.join(BUILD, 'sea-entry.cjs'))

  // 源码包（源码 + 中英文文档）也嵌进产物。
  //
  // 为什么：用户的要求是"送闪传就一起送 EXE、源码还有文档"，而单文件产物运行时
  // 磁盘上**没有源码与文档** —— 现场是打不出这个包的，只能构建时嵌进去。
  // 代价约 1 MB（在 90 MB 面前可以忽略），换来的是产物复制到哪儿都完整。
  // 打包逻辑与"源码形态下现场打包"共用同一个函数（src/gift.js 的 buildSourcePack），
  // 免得两处各打一份、内容还不一样。
  //
  // ⚠️ 顺序要紧：**先打这个包，再写 version.json** —— 因为它的指纹也要记进去。
  //    源码包和页面一样是"构建时冻住"的东西：改了文档不重新构建，
  //    对方收到的赠品里就是旧文档（页面上曾经真的出过这个错，见 asset-digests.mjs）。
  let packBytes = null
  {
    const { buildSourcePack, SOURCE_PACK_ASSET } = await import('../src/gift.js')
    const { installFromDisk } = await import('../src/assets.js')
    installFromDisk(ROOT)          // buildSourcePack 通过 assets.js 取根目录
    const pack = await buildSourcePack(ROOT)
    packBytes = pack.bytes
    writeFileSync(path.join(BUILD, SOURCE_PACK_ASSET), pack.bytes)
    log(' ', `源码包 ${SOURCE_PACK_ASSET}  ${(pack.bytes.length / 1024).toFixed(0)} KB` +
      `（${pack.fileCount} 个文件，其中文档 ${pack.docCount} 份）`)
    if (pack.missing.length) {
      log(' ', `（这些文件不存在，已跳过：${pack.missing.join('、')}）`)
    }
    embeddedSourcePack = SOURCE_PACK_ASSET
  }

  // version.json：版本号 + **每个源码资源的指纹** + **内嵌源码包的指纹**。
  //
  // 存指纹是为了让产物能自证"我内嵌的是哪一版东西"：`gen/smoke-sea.mjs`
  // 跑 `--assets` 把它读出来跟磁盘比对，不一致就说明这个产物是旧的。
  // 2026-10 真的这么漏过一次（旧产物里连 `lang-switch` 都搜不到），
  // 见 gen/asset-digests.mjs 的说明；源码包是同一个坑的第二次。
  //
  // ⚠️ **不许写构建时间**：这个文件进 blob、blob 进产物 —— 加了时间戳，
  //    同样的源码就会产出不同的二进制，"可复现构建"就没了
  //    （release.mjs 正是靠它来说"校验值一致 = 同一份源码构建的"）。
  //    指纹是内容的纯函数，安全。
  const assetDigests = digestAll()
  if (packBytes && embeddedSourcePack) {
    const { assetFingerprint } = await import('../src/assets.js')
    assetDigests[embeddedSourcePack] = assetFingerprint(packBytes)
  }
  writeFileSync(path.join(BUILD, 'version.json'),
    JSON.stringify({ version: pkg.version, assets: assetDigests }), 'utf8')

  // 资源：按**原始相对路径**放到构建目录，sea-config 再按同名键嵌入。
  // 这样"代码里用的名字"与"资产键名"天然一致，不需要维护一张映射表。
  for (const rel of ASSETS) {
    const src = path.join(ROOT, rel)
    if (!existsSync(src)) fail(`缺少资源文件: ${rel}`)
    const dst = path.join(BUILD, rel)
    mkdirSync(path.dirname(dst), { recursive: true })
    copyFileSync(src, dst)
    log(' ', `${rel}  ${(statSync(src).size / 1024).toFixed(1)} KB`)
  }

  // ③ SEA blob
  log('③', '生成 SEA blob…')
  const cfgPath = path.join(BUILD, 'sea-config.json')
  writeFileSync(cfgPath, JSON.stringify({
    main: path.join(BUILD, 'sea-entry.cjs'),
    output: path.join(BUILD, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    // ⚠️ app.cjs 也必须作为**资产**嵌入，不能只放磁盘上：
    //    SEA 里 require() 只认内置模块，加载不了文件；
    //    入口是用 sea.getAsset('app.cjs') 取出源码再 module._compile 执行的。
    assets: Object.fromEntries([
      ...ASSETS.map((rel) => [rel, path.join(BUILD, rel)]),
      ['app.cjs', path.join(BUILD, 'app.cjs')],
      ['version.json', path.join(BUILD, 'version.json')],
      // 源码 + 文档的打包（赠品要用，见上面生成它的那段说明）
      [embeddedSourcePack, path.join(BUILD, embeddedSourcePack)],
    ]),
  }, null, 2), 'utf8')

  const blobRun = run(process.execPath, ['--experimental-sea-config', cfgPath])
  const blobPath = path.join(BUILD, 'sea-prep.blob')
  if (blobRun.code !== 0 || !existsSync(blobPath)) {
    fail(`SEA blob 生成失败:\n${blobRun.out}`)
  }
  log(' ', `blob ${(statSync(blobPath).size / 1024).toFixed(1)} KB`)

  // ── 注入前的自检：**哨兵字符串只能出现一次** ──────────────────
  //
  // ⚠️ postject 靠"在二进制里找唯一一处哨兵"来定位要改写的 fuse。
  //    它找到不止一处时报的是 `Multiple occurences of sentinel ... found in the binary` ——
  //    而那个错误**完全指不到真正的原因**：哨兵出现在**被注入的 blob** 里。
  //
  //    这条坑是 2026-10 真实踩到的：源码包从"手写白名单"改成"遍历整棵树"之后，
  //    包里多了 `gen/build-sea.mjs` 自己 —— 而它就写着这个哨兵字面量。
  //    于是：包里含哨兵 → blob 含哨兵 → 注入失败，报错却指向 node 二进制。
  //
  //    所以这里先自己查一遍，报出**是哪些文件**把哨兵带进来的（那些文件就在源码包里）。
  const SENTINEL_FUSE = 'NODE_SEA_FUSE_' + 'fce680ab2cc467b6e072b8b5df1996b2'
  const sentinelBuf = Buffer.from(SENTINEL_FUSE, 'latin1')
  if (readFileSync(blobPath).includes(sentinelBuf)) {
    const { collectSourceFiles } = await import('../src/gift.js')
    const packed = await collectSourceFiles(ROOT)
    const offenders = packed.filter((f) => f.data.includes(sentinelBuf)).map((f) => f.rel)
    fail('注入前的自检：blob 里出现了 SEA 哨兵字符串，postject 一定会拒绝注入。\n' +
      '  含它的文件（源码包会把它们原样打进产物）：\n' +
      (offenders.length ? offenders.map((o) => '    ' + o).join('\n') : '    （没在源码包里找到？那要查内嵌资源）') +
      '\n  postject 的报错是 `Multiple occurences of sentinel ... found in the binary`，' +
      '完全指不到这里。\n' +
      '  修法：把那个文件里的哨兵字面量**拆成两段写**（本文件就是这么写的，见上面那行），' +
      '或者把它从源码包里排除。')
  }

  if (flag('no-inject')) {
    log(' ', `（--no-inject）只到 blob 为止，构建目录: ${BUILD}`)
    process.exit(0)
  }

  // ④ 以 Node 运行时为基底
  log('④', '复制 Node 运行时…')
  mkdirSync(OUT_DIR, { recursive: true })
  const ext = process.platform === 'win32' ? '.exe' : ''
  const outName = `flicker-${pkg.version}-${platformTag()}${ext}`
  const outPath = path.join(OUT_DIR, outName)
  copyFileSync(process.execPath, outPath)
  log(' ', `${outName}  ${human(statSync(outPath).size)}`)

  /**
   * macOS：签名这件事比看上去麻烦，2026-10 的 CI 先后踩了两次。
   *
   * ① **注入前**先把 Node 自带的签名去掉 —— postject 要改 Mach-O 的载荷，带着有效签名去改，
   *    得到的就是"签名与内容对不上"的文件，内核对它**直接 SIGKILL**。
   * ② **注入后**必须重新签名（ad-hoc：`--sign -`，不需要证书、不需要联网），但**不能丢 entitlements**：
   *    Node 的二进制带 `com.apple.security.cs.allow-jit` 等权限，V8 要靠 JIT 跑；
   *    权限丢了在 arm64 + Hardened Runtime 下同样是"运行它没有任何输出、退出码 null（被信号杀掉）"。
   *    所以先从**原 Node 二进制**里把 entitlements 取出来，重签时带回去。
   * ③ 失败时把 `codesign -dv` 的输出一并打印 —— 那比"产物无法正常运行"有用得多。
   */
  let macEntitlements = null
  if (process.platform === 'darwin') {
    const dump = run('codesign', ['-d', '--entitlements', ':-', process.execPath])
    if (/<plist/i.test(dump.out)) {
      const start = dump.out.indexOf('<?xml')
      const plist = start >= 0 ? dump.out.slice(start) : dump.out
      macEntitlements = path.join(BUILD, 'entitlements.plist')
      writeFileSync(macEntitlements, plist, 'utf8')
      log(' ', '已从 Node 二进制里取出 entitlements（重签时带上，否则 V8 的 JIT 权限会丢）')
    } else {
      log(' ', '（Node 二进制里没有 entitlements，重签用 ad-hoc 默认值）')
    }
    const stripped = run('codesign', ['--remove-signature', outPath])
    if (stripped.code !== 0) {
      log(' ', `（去掉 Node 原有签名失败，继续试：${stripped.out.trim().slice(0, 200)}）`)
    }
  }

  // ⑤ 注入
  log('⑤', '注入 blob（postject）…')
  // 用 gen/npx.mjs 走"当前 node + npx-cli.js"，不经 shell：
  // 原来 `spawnSync('npx', [...], {shell:true})` 会被 Node 24 打 DEP0190
  // （参数只拼接、不转义），而且路径里的空格/中文要过 cmd.exe 的引号规则。
  const pj = runNpx(['--yes', 'postject@1.0.0-alpha.6',
    outPath, 'NODE_SEA_BLOB', blobPath,
    '--sentinel-fuse', SENTINEL_FUSE],
  { timeout: 300_000 })
  if (pj.code !== 0) {
    rmSync(outPath, { force: true })
    fail(`注入失败（可能需要网络下载 postject）:\n${pj.out.slice(0, 800)}`)
  }
  log(' ', `产物 ${human(statSync(outPath).size)}`)

  // ⑥ 自检：真的跑起来看看
  log('⑥', '自检产物…')

  // ⚠️ macOS 必须先**重新做一次 ad-hoc 签名**才能跑（2026-10 CI 第一次跑抓到的）。
  //    不是我们的代码有问题：postject 往 Mach-O 里注入 blob 会改掉原有签名，
  //    而 macOS 内核对"签名与内容对不上"的可执行文件是**直接 SIGKILL** 的 ——
  //    表现是"运行它没有任何输出、退出码 -9/137"，在 Windows / Linux 上完全看不出来。
  //    Node 官方 SEA 文档也要求这一步；ad-hoc 签名（`--sign -`）不需要证书、不需要联网。
  if (process.platform === 'darwin') {
    // 重签时必须带上从 Node 二进制里取出的 entitlements（V8 的 JIT 权限在里面），
    // 否则 arm64 + Hardened Runtime 下产物同样会被内核杀掉，而且**没有任何输出**。
    // ⚠️ 刻意**不加** `--options runtime`：它会开启 Hardened Runtime，而 Node 的二进制里
    //    entitlements 未必带着 V8 需要的 JIT 例外；开启后正是"签名有效但一跑就被杀"。
    //    Node 官方 SEA 文档的做法是保留原 flags/requirements/entitlements，别额外加压。
    const signArgs = ['--force', '--sign', '-', '--preserve-metadata=requirements,flags']
    if (macEntitlements) signArgs.push('--entitlements', macEntitlements)
    signArgs.push(outPath)
    const resign = run('codesign', signArgs)
    if (resign.code !== 0) {
      fail(`ad-hoc 签名失败（少了它，产物会被内核直接杀掉）:\n${resign.out.slice(0, 800)}`)
    }
    const check = run('codesign', ['--verify', '--strict', '--verbose=2', outPath])
    log(' ', `ad-hoc 签名完成（${check.code === 0 ? 'codesign --verify 通过' : 'verify 有告警'}，` +
      '已带上 Node 的 entitlements）')
  }

  const ver = run(outPath, ['--version'])
  if (ver.code !== 0 || !/闪传 Flicker/.test(ver.out)) {
    // 退出码一定要打出来：被系统杀掉（spawnSync 的 status 是 **null**）与"程序自己报错"
    // 是两回事，而两者的输出都可能为空 —— 2026-10 macOS 两次都是被内核杀掉的。
    const diag = process.platform === 'darwin'
      ? `\n  codesign -dv:\n${run('codesign', ['-dv', '--verbose=4', outPath]).out.slice(0, 800)}`
      : ''
    fail(`产物无法正常运行（退出码 ${ver.code}` +
      `${ver.signal ? `，被信号 ${ver.signal} 杀掉` : ''}）:\n` +
      `${ver.out.slice(0, 600)}${diag}`)
  }
  log(' ', ver.out.trim())

  // 再验一次"不启浏览器、不建会话"的路径
  const help = run(outPath, ['--help'])
  if (help.code !== 0 || !/一次性文件传输/.test(help.out)) {
    fail(`产物的 --help 不正常:\n${help.out.slice(0, 400)}`)
  }
  log(' ', '--help 正常')

  console.log(`\n  ✅ 完成: ${path.relative(ROOT, outPath)}`)
  console.log(`     ${human(statSync(outPath).size)}，双击即可运行，不需要安装 Node\n`)
} finally {
  if (!flag('keep')) rmSync(BUILD, { recursive: true, force: true })
  else console.log(`  （--keep）构建目录保留在: ${BUILD}\n`)
}
