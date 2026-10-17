/**
 * 自赠程序
 * ========
 * 实现 架构决策.md 第三章：把程序本身随文件一起送给对方。
 *
 * 关键设计：**送什么取决于程序自己是什么形态。**
 *   单文件可执行程序（SEA）→ 直接把自己送过去，对方双击就能跑（最优）
 *   源码目录            → 打包运行所需的源码 + 启动脚本，对方需要先装 Node
 *
 * 这个功能是项目唯一的传播机制：每送出去一次，接收方就多一个完整的站点。
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  rootDir, version as pkgVersion, isSingleFile, readAssetBinary,
  tryReadAssetBinary, assetFingerprint,
} from './assets.js'

/** 项目根目录 —— 集中由 assets.js 提供，不要在本模块里自己算 */
function projectRoot() { return rootDir() }

/**
 * 源码包在单文件产物里的资产名。
 *
 * 为什么要把源码包**打进产物**：单文件产物运行时磁盘上只有它自己 ——
 * 没有 `src/`、没有文档。而用户的要求是"送闪传就一起送 EXE、源码还有文档"。
 * 所以构建时把源码 + 中英文文档打成 `.fkz` 嵌进去，运行时直接取出来送给对方。
 * 代价是产物大约多 1 MB（在 90 MB 面前可以忽略），换来的是**它到哪儿都完整**：
 * 复制到桌面、发给别人，源码和文档都跟着走。
 */
export const SOURCE_PACK_ASSET = 'source-pack.fkz'

export const GIFT_KIND = Object.freeze({
  SEA: 'flicker-station-sea',
  SOURCE: 'flicker-station-source',
})

/**
 * 赠品相关的告警（"这次没送源码包"之类）。
 *
 * 为什么要有这个出口：**静默少送一样东西**比报错更糟 ——
 * 用户以为对方拿到了源码和文档，实际没有。所以能送就送，送不了就**说清楚**。
 */
const giftWarnings = []

/**
 * 判断自己是怎么被分发的。
 * 不做任何猜测：直接看运行时事实。
 */
export function detectSelf() {
  // ⚠️ 判断"我是不是单文件产物"要用入口注入的标记（来自官方 sea.isSea()），
  //    不要靠 argv / execPath 猜。实测发现 SEA 里 argv[1] 是**可执行文件自身的路径**
  //    （不是空的），所以基于 argv 的判据是错的。
  const sea = isSingleFile()
  return {
    mode: sea ? 'sea' : 'source',
    execPath: process.execPath,
    scriptPath: process.argv[1] ?? null,
    version: process.versions.node,
  }
}

/**
 * 打包源码树时要**排除**的东西。
 *
 * ⚠️ 这里是从"手写白名单"改成"遍历 + 黑名单"的 —— 原因是一次实测事故：
 *    原来那份手写清单只有 40 个条目（22 份文档 + 3 个启动脚本 + 十几个源码文件），
 *    而 `src/run.js`、`src/gui.js`、`src/tty.js`、`src/assets.js`、`src/relay/*`
 *    全都不在里面。把包解开、在里面跑 `node bin/flicker.js --version`，
 *    第一句就 `ERR_MODULE_NOT_FOUND: Cannot find module .../src/assets.js`。
 *    也就是说：**对方收到的是一个跑不起来的半份源码**，而赠品的说明写着
 *    "源码 + 全部文档，对方可以自己看、自己改、自己构建"。
 *
 *    白名单这种东西漏一个是必然的（新加一个模块就会漏），而且**没人会发现** ——
 *    所以改成遍历整棵树：完整性不再依赖谁记得去加一行。
 *    判据在 `gen/check-source-pack.mjs`：结构（该在的都在）+ 行为（解开后真的跑一次）。
 */
const PACK_EXCLUDES = [
  /^\.git\//,                    // 版本库
  /^node_modules\//,
  /^dist\//,                     // 构建产物（源码包里不该有 91 MB 的 exe）
  /^_lab\/out\//,                // 体检/压测的日志与截图（临时产物）
  /(^|\/)\.DS_Store$/,
  /(^|\/)Thumbs\.db$/,
  /^flicker-plugin\.log$/,       // 示例插件往 cwd 写的日志（跑过一次就会出现）
  /^relay\/api-token\.txt$/,     // ⚠️ 凭据！Cloudflare 部署令牌，绝不能进赠品
  // ⚠️ **本地状态目录**：里面是"这台机器/这个人"的东西，不是源码。
  //    `relay/.wrangler/cache/wrangler-account.json` 里就有 Cloudflare 账号 id 与邮箱
  //    ——2026-10 用户要求检查个人信息时发现的：它**曾经真的进了赠品**，
  //    也因此进了单文件产物（产物内嵌源码包）。判据见 gen/check-pack-pii.mjs。
  /(^|\/)\.wrangler\//,
  /(^|\/)\.dev\.vars$/,
  /(^|\/)\.env(\..+)?$/,
  /(^|\/)\.npmrc$/,
]

/**
 * 列出要打进源码包的文件：**整棵树**减去上面的排除项。
 *
 * 排序是刻意的：同样的源码树要打出**逐字节相同**的包（可复现构建是项目的硬要求，
 * 而"包里文件顺序随机"会让指纹每次都不一样）。
 *
 * @param {string} root 项目根目录
 * @returns {Promise<Array<{rel:string, data:Buffer, mode:number}>>}
 *
 * ⚠️ 这个函数也被构建脚本用（`gen/build-sea.mjs` 在注入前拿它查哨兵字符串，
 *    见那边的"注入前的自检"），所以它是导出的。
 */
export async function collectSourceFiles(root) {
  const out = []
  const walk = async (dir, prefix) => {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of entries) {
      const rel = prefix ? prefix + '/' + e.name : e.name
      const probe = e.isDirectory() ? rel + '/' : rel
      if (PACK_EXCLUDES.some((re) => re.test(probe))) continue
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) await walk(abs, rel)
      else if (e.isFile()) {
        out.push({ rel, data: await readFile(abs), mode: rel.startsWith('启动') ? 0o755 : 0o644 })
      }
    }
  }
  await walk(root, '')
  return out
}

/**
 * 组装赠品 —— 返回**一组**文件（不是单个）。
 *
 * 为什么是一组：用户的要求是"发送闪传应该一起发送 EXE 和源码还有文档"。
 * 从前只会送一个：单文件形态送 exe、源码形态送 `.fkz` 源码包。
 * 现在单文件形态送**两个**：
 *   ① 产物本身（对方双击就能用）
 *   ② 源码包（源码 + 中英文文档，对方可以自己看、自己改、自己构建）
 *
 * ⚠️ 源码形态只能送 ②：自己就是靠磁盘上的源码跑起来的，没法凭空变出一个 exe。
 *    这是**能力边界**，界面上要如实说（见 gui.js 的 giftNoteForUser）。
 *
 * @param {object} [opts]
 * @param {string} [opts.version] 版本号（写进文件名，方便对方看出新旧）
 * @returns {Promise<Array<{kind:string, name:string, rel:string, size:number, absPath?:string,
 *                          bytes?:Buffer, platform?:string, note:string}>>}
 */
export async function makeGifts(opts = {}) {
  const version = opts.version ?? await readVersion()
  const self = detectSelf()
  const out = []

  if (self.mode === 'sea') {
    // ① 把自己整个送过去：对方双击就能用
    const st = await stat(self.execPath)
    const ext = process.platform === 'win32' ? '.exe' : ''
    const name = `flicker-${version}-${platformTag()}${ext}`
    out.push({
      kind: GIFT_KIND.SEA,
      name,
      rel: name,
      size: st.size,
      absPath: self.execPath,
      platform: platformTag(),        // SEA 必须给具体平台（PROTOCOL.md §9.1.1）
      note: '对方双击即可运行，不需要安装任何东西',
    })

    // ② 再送一份源码 + 文档 —— 从**构建时嵌进产物**的那份包里取。
    //    单文件产物运行时磁盘上没有 src/ 与文档，现场打包是打不出来的。
    const pack = await tryReadAssetBinary(SOURCE_PACK_ASSET)
    if (pack && pack.length) {
      out.push(sourceGiftFromPack(pack, version, { alongsideExe: true }))
    } else {
      // 老产物（构建时还没嵌这份包）不该让整个赠品失败 —— 程序本身照送，
      // 但要**明确说清楚**这次没有源码包，而不是静默少送一样东西。
      out.push(null)      // 占位：下面 filter 掉
      giftWarnings.push('这个产物里没有内嵌源码包（是旧版本构建的？），' +
        '本次只送程序本身。重新构建（node gen/build-sea.mjs）即可带上源码与文档。')
    }
    return out.filter(Boolean)
  }

  // 源码形态：只有源码包（自己就是靠磁盘上的源码跑起来的，变不出 exe）
  out.push(await makeSourcePack(version))
  return out
}

/**
 * 把源码 + 文档打成 `.fkz`。
 *
 * @param {string} root 项目根目录
 * @returns {Promise<{bytes: Buffer, fileCount: number, docCount: number, missing: string[]}>}
 */
export async function buildSourcePack(root) {
  const files = await collectSourceFiles(root)
  const missing = []                 // 遍历式收集不会有"缺失"，保留这个字段是为了兼容调用方
  if (files.length < 20) {
    throw new Error(`源码包内容不完整（只找到 ${files.length} 个文件）—— 无法生成源码包`)
  }
  // 文档一份都没有 → 目录结构变了或文档没生成。明确报出来，
  // 而不是悄悄产出一个"没有文档的源码包"（用户的要求里文档是明确的一项）。
  const docCount = files.filter((f) => /^(中文文档|docs)\//.test(f.rel)).length
  if (docCount === 0) {
    throw new Error('源码包里一份文档都没找到（中文文档/ 与 docs/ 都为空或路径变了）')
  }
  // 入口必须在包里 —— 少了它就等于"对方拿到一份跑不起来的源码"，
  // 而那正是这次要修的事故，所以在源码里先钉一道，判据里再钉一道
  // （见 gen/check-source-pack.mjs 的"解开后真的跑一次"）。
  if (!files.some((f) => f.rel === 'bin/flicker.js')) {
    throw new Error('源码包里没有 bin/flicker.js —— 对方拿到的是跑不起来的源码')
  }
  return { bytes: packArchive(files), fileCount: files.length, docCount, missing }
}

/**
 * 源码包的指纹（给 `--assets` 自证用）。
 *
 * ── 为什么源码包也要有指纹 ──
 * 页面有指纹（`ASSET` 那几项），是因为"改了页面忘了重新构建"曾经真的发生过：
 * 测试读磁盘所以全绿，发出去的二进制里却是几天前的界面。
 * **源码包是同一个坑的第二次**：它同样在构建时被冻进产物，同样不会被
 * 测试发现 —— 而且它装的正是"源码 + 全部文档"，改了文档不重新构建，
 * 对方收到的就是旧文档（用户明确要求赠品里带文档）。
 *
 * 两种形态各自取"程序真正会送出去的那份"：
 *   单文件形态：读内嵌的资产（构建那一刻冻住的）
 *   源码形态  ：现场打一份（读盘即真相）—— 与正式赠送走**同一个** `buildSourcePack`
 *
 * @returns {Promise<string|null>} 16 位十六进制；单文件形态里没嵌这份包时返回 null
 */
export async function sourcePackFingerprint() {
  if (isSingleFile()) {
    const bytes = await tryReadAssetBinary(SOURCE_PACK_ASSET)
    return bytes ? assetFingerprint(bytes) : null
  }
  const { bytes } = await buildSourcePack(rootDir())
  return assetFingerprint(bytes)
}

/** 用现成的一包字节组装赠品条目（单文件形态用这个：包是构建时嵌进去的） */
function sourceGiftFromPack(bytes, version, { alongsideExe }) {
  const name = `flicker-${version}-source.fkz`
  return {
    kind: GIFT_KIND.SOURCE,
    name,
    rel: name,
    size: bytes.length,
    bytes,
    platform: 'any',                  // 源码必须给 any（PROTOCOL.md §9.1.1）
    note: alongsideExe
      ? '源码 + 中英文文档：对方可以自己看、自己改、自己构建'
      : '源码 + 中英文文档。对方需要先安装 Node.js 24+，然后双击「启动.cmd」',
  }
}

/** 源码形态：现场从磁盘打包 */
async function makeSourcePack(version) {
  const { bytes, docCount } = await buildSourcePack(projectRoot())
  const g = sourceGiftFromPack(bytes, version, { alongsideExe: false })
  g.note = `源码 + 中英文文档（${docCount} 份）。` +
    '对方需要先安装 Node.js 24+，然后双击「启动.cmd」'
  return g
}

/**
 * 读取版本号。
 *
 * ⚠️ 走 assets.js 的统一入口，**不要自己读磁盘上的 package.json**：
 *    单文件（SEA）形态下磁盘上没有那个文件，会静默退回 '0.0.0' ——
 *    于是赠品文件名变成 flicker-0.0.0-windows-x64.exe，
 *    接收方会以为这是个很旧的版本。这个 bug 实测出现过。
 */
async function readVersion() {
  return pkgVersion()
}

function platformTag() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  return `${process.platform === 'win32' ? 'windows' : process.platform}-${arch}`
}

// ── 极简归档格式 ────────────────────────────────────────────
//
// Node 没有内置 tar/zip，所以自定义一个最简单的容器：
//   magic "FKZ1" | 条目数(u32) | [ 路径长度(u16) | 路径 | 模式(u16) | 长度(u32) | 内容 ]...
// 目的只是"把几个文件装进一个文件里方便传输"，不做压缩（压缩对源码收益很小）。
//
// ⚠️ 这里**只写不读**：接收方是浏览器页面，它把 `.fkz` 原样存到磁盘，由使用者自己解开。
//    注意当前事实：**产品里没有任何东西能打开它**（这是一个已知缺口，最自然的补法在
//    接收端页面 —— 文件字节本来就在它手里）。
//    从前这里有一个 `unpackArchive()`，但全仓库零调用、零测试，
//    留着只会让"谁负责解这个包"看起来已经有答案了（2026-10 删除）。

const MAGIC = Buffer.from('FKZ1', 'ascii')

function packArchive(files) {
  const parts = [MAGIC]
  const count = Buffer.alloc(4); count.writeUInt32BE(files.length); parts.push(count)
  for (const f of files) {
    const nameBuf = Buffer.from(f.rel, 'utf8')
    const head = Buffer.alloc(2 + 2 + 4)
    head.writeUInt16BE(nameBuf.length, 0)
    head.writeUInt16BE(f.mode ?? 0o644, 2)
    head.writeUInt32BE(f.data.length, 4)
    parts.push(head, nameBuf, f.data)
  }
  return Buffer.concat(parts)
}
