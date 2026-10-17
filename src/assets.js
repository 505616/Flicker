/**
 * 资源读取（源码模式 / SEA 单文件模式 通用）
 * =========================================
 * 项目里有三类资源需要在运行时读取：接收端页面、站点页、**手机上传页**。
 *
 * 两种分发形态的资源位置不同：
 *   源码模式    —— 就在项目目录里，直接读盘
 *   SEA 单文件  —— 已嵌进可执行文件，由 SEA 的资产 API 读
 *
 * ── 为什么是"预装全局读取器"而不是条件导入 ──
 * 试过 `package.json` 的 `imports` 条件映射（`#assets-loader` → 按条件选实现），
 * 在普通 Node 下工作正常，但**在 SEA 产物里不成立**：SEA 的模块加载器
 * 不按包边界解析，实测连入口的 ES 模块都加载不了
 * （报 "Failed to load the ES module ... set type: module"）。
 *
 * 所以改成：入口在**加载任何模块之前**先装上根目录与读取器；
 * 这里只负责取用。这样"用哪个加载器"只有一个决策点，就是入口。
 */
import { readFile as readFileAsync } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join as joinPath } from 'node:path'

/** 资源名（同时是 SEA 资产的键名） */
export const ASSET = Object.freeze({
  RECEIVER_HTML: 'web/receiver.html',
  STATION_HTML: 'web/station.html',
  /** 手机上传页（手机当发送端时打开的那一页，由 `flicker recv` 送出） */
  PHONE_HTML: 'web/phone.html',
  PACKAGE_JSON: 'package.json',
})

/**
 * 资源指纹：内容的 SHA-256 前 16 位十六进制。
 *
 * 用途只有一个，但很关键：**证明单文件产物里内嵌的是哪一版页面**。
 *
 * 踩过的坑（2026-10）：SEA 产物把 `web/*.html` 打包进去，而构建脚本不会
 * 因为你改了页面就自动重跑 —— 于是 `dist/` 里那个 89.5 MB 的二进制是
 * **几天前**的界面，而 390 个测试全绿。`smoke` 也全绿，因为它只验
 * `--version` / `--help` / `--dry-run`，**不检查内嵌页面是不是最新的**。
 * 差一点就把"没有 i18n、没有单独清除按钮"的旧版本当成新版本发出去。
 *
 * 所以：构建时把每个资源的指纹记进内嵌的 `version.json`，
 * 冒烟时拿出来和磁盘上的文件比 —— 不一致就说明产物过期了。
 *
 * ⚠️ 指纹算的是**内容**，所以"用字符串算"和"用文件字节算"必须一致。
 *    对本项目成立：`check-line-endings.mjs` 保证这些文本文件是合法 UTF-8 且无 BOM，
 *    因此 `Buffer.from(text,'utf8')` 就是原始字节。
 *
 * @param {Buffer|Uint8Array|string} content
 * @returns {string} 16 位十六进制
 */
export function assetFingerprint(content) {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

/**
 * 读取构建期记录的"内嵌资源指纹"（只存在于单文件形态）。
 *
 * 源码模式下没有 `version.json`，返回 `null` —— 调用方（`--assets`）
 * 会退回到"现算"，因为源码模式下"程序会读到的"就是磁盘上那份，现算即真相。
 *
 * @returns {Promise<Record<string,string>|null>}
 */
export async function recordedAssetDigests() {
  try {
    const meta = JSON.parse(await readAsset('version.json'))
    return meta && typeof meta.assets === 'object' ? meta.assets : null
  } catch {
    return null            // 没有这个资产（源码模式），或产物是旧版没记
  }
}

let versionCache = null

/**
 * 读取版本号。
 * 源码模式与 SEA 模式都通过同一个资源读取器拿 —— 所以这里不关心自己跑在哪种形态。
 * @returns {Promise<string>}
 */
export async function version() {
  if (versionCache) return versionCache
  try {
    const pkg = JSON.parse(await readAsset(ASSET.PACKAGE_JSON))
    versionCache = pkg.version ?? '0.0.0'
  } catch {
    // 单文件形态下可能没有 package.json 资产，用入口注入的值兜底
    versionCache = injectedVersion() ?? '0.0.0'
  }
  return versionCache
}

/**
 * 项目根目录（源码模式下是仓库目录；SEA 模式下是承载资源的逻辑根）。
 *
 * ⚠️ 刻意做成一个**函数**而不是模块级常量：
 *   常量会在模块加载时求值，而那时入口可能还没装上读取器。
 *
 * ⚠️ 也刻意**集中到这一处**：早先 `gift.js` 和 `run.js` 各自写了一份
 *   `const __dirname = path.dirname(fileURLToPath(import.meta.url))`，
 *   单文件打包（拓扑序拼接）时两个 `__dirname` 直接撞名、产物无法解析。
 *   两个模块重复计算同一个常量本来就是冗余，收拢到这里更合理。
 */
export function rootDir() {
  const r = globalThis.__flickerRoot
  if (!r) {
    throw new Error('项目根目录尚未安装（源码模式由 bin/flicker.js 安装，' +
      'SEA 模式由 entry/sea-entry.cjs 安装）')
  }
  return r
}

/**
 * 源码模式：把"根目录 + 读盘式资源读取器"一次性装好。
 *
 * ⚠️ 传进来的是**目录路径**，不是 import.meta.url ——
 *    因为打包成 CommonJS 后 import.meta 不存在，用了就语法报错。
 *    路径由入口自己算（源码模式下入口是 ESM，可以放心用 import.meta）。
 *
 * @param {string} rootDir 项目根目录
 */
export function installFromDisk(rootDir) {
  // 刻意做成同步：入口是 ESM，而打包成 CommonJS 后不允许顶层 await。
  // 读取器本身仍是异步接口（Promise），只是"安装"这一步不需要等待。
  globalThis.__flickerRoot = rootDir
  globalThis.__flickerIsSea = false
  globalThis.__flickerAssets = (name) => readFileAsync(joinPath(rootDir, name), 'utf8')
  // 二进制版：不传编码，readFile 返回 Buffer
  globalThis.__flickerAssetsBinary = (name) => readFileAsync(joinPath(rootDir, name))
}

/**
 * 读取一个资源，返回字符串。
 * @param {string} name 见 ASSET
 */
export async function readAsset(name) {
  const loader = globalThis.__flickerAssets
  if (!loader) {
    throw new Error(
      `没有可用的资源读取器（想读 ${name}）。` +
      '源码模式下由 bin/flicker.js 安装，SEA 模式下由 entry/sea-entry.cjs 安装')
  }
  return loader(name)
}

/**
 * 读取一个**二进制**资源（返回 Buffer）。
 *
 * 字符串那条路（`readAsset`）会做 UTF-8 解码，二进制内容会被破坏 ——
 * 所以内嵌的源码包（`.fkz`）这类资产必须走这里。
 */
export async function readAssetBinary(name) {
  const loader = globalThis.__flickerAssetsBinary
  if (!loader) {
    throw new Error(`没有可用的二进制资源读取器（想读 ${name}）—— ` +
      '源码模式由 bin/flicker.js 安装，SEA 模式由 entry/sea-entry.cjs 安装')
  }
  return loader(name)
}

/** 资产不存在时返回 null（而不是抛错）—— 用于"老产物里没有这个资产"的情形 */
export async function tryReadAssetBinary(name) {
  try { return await readAssetBinary(name) } catch { return null }
}

/** 判断当前是不是单文件可执行形态 */
export function isSingleFile() {
  return Boolean(globalThis.__flickerIsSea)
}

/** 入口注入的版本号（SEA 形态下磁盘上没有 package.json 可读时的兜底） */
function injectedVersion() {
  return globalThis.__flickerVersion ?? null
}

