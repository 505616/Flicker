/**
 * 内嵌资源的指纹：构建时记录、冒烟时核对
 * ======================================
 *
 * 这个文件存在的唯一理由，是让"产物里的页面是不是最新的"变成一条**机器判据**。
 *
 * ── 它防的是哪一种错 ──
 * SEA 产物把 `web/receiver.html`、`web/station.html`、`package.json` 打包进
 * 一个 89 MB 的可执行文件。构建脚本**不会**因为你改了页面就自动重跑，于是：
 *
 *   · `npm test` 390 个用例全绿 —— 测试读的是磁盘上的页面，不是产物里的
 *   · `smoke-sea.mjs` 也全绿 —— 它验 `--version` / `--help` / `--dry-run`，
 *     **从来不检查内嵌页面是哪一版**
 *   · 结果：`dist/` 里躺着几天前的界面，随时可能被当成新版本发出去
 *
 * 2026-10 实际发生过一次（旧产物里连 `lang-switch` 这个字符串都搜不到）。
 * 所以：**构建时把指纹写进产物，冒烟时拿出来和磁盘比对** —— 不一致就报错，
 * 并直接告诉你跑哪条命令。
 *
 * ── 为什么两份逻辑放在一个文件里 ──
 * "哪些资源要记"和"怎么算指纹"必须**只有一份**：构建记了一套、冒烟查了另一套，
 * 就会出现"永远对得上"或"永远对不上"两种假象。所以两边都 import 这里。
 *
 * 用法（两个脚本各自 import，不单独运行）：
 *   import { SOURCE_ASSETS, digestAll, compareDigests } from './asset-digests.mjs'
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// 指纹算法与资源名都取自运行时那一份（src/assets.js），避免两处各写一套
import { ASSET, assetFingerprint } from '../src/assets.js'
// 源码包的**资产名**同理只有一份（src/gift.js 的 SOURCE_PACK_ASSET）
import { SOURCE_PACK_ASSET, buildSourcePack } from '../src/gift.js'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 会被嵌进单文件产物的**源码资源**。
 *
 * 直接用 `src/assets.js` 的 `ASSET` —— 那正是运行时按名字去读的那几个键。
 * 刻意**不**在这里另抄一份清单：抄一份就会漂移（新加一个资源、构建忘了嵌，
 * 或者反过来构建嵌了、冒烟漏查）。
 *
 * 注意不含 `app.cjs` 与 `version.json`：它们是构建期的产物，不是源码资源。
 * `app.cjs` 由源码打包而来（改源码必然重新构建，不存在"忘记重建"的情形 ——
 * 不重建根本跑不到这一步）；`version.json` 本身就在记指纹。
 */
export const SOURCE_ASSETS = Object.freeze(Object.values(ASSET))

/** 某个资源**在磁盘上**的指纹 */
export function digestOfFile(root, rel) {
  return assetFingerprint(readFileSync(path.join(root, rel)))
}

/** 全部源码资源在磁盘上的指纹（构建时写进 version.json 的就是它） */
export function digestAll(root = ROOT) {
  return Object.fromEntries(SOURCE_ASSETS.map((rel) => [rel, digestOfFile(root, rel)]))
}

/**
 * 比对：产物里记录的指纹 vs 磁盘上现在的文件。
 *
 * @param {Record<string,string>|null} recorded 产物记录的指纹（null = 产物没记）
 * @param {string} root 源码根目录
 * @returns {Array<{rel:string, was:string|null, now:string, why:string}>} 空数组 = 一致
 */
export function compareDigests(recorded, root = ROOT) {
  const out = []
  for (const rel of SOURCE_ASSETS) {
    const now = digestOfFile(root, rel)
    const was = recorded?.[rel] ?? null
    if (!was) {
      out.push({ rel, was: null, now, why: '产物里没有记录这一项' })
    } else if (was !== now) {
      out.push({ rel, was, now, why: '产物里内嵌的是旧版' })
    }
  }
  return out
}

/** 把比对结果写成给人看的几行（smoke 与测试共用同一段措辞） */
export function describeMismatch(list) {
  return list.map((m) => `  ${m.rel}\n` +
    `      产物里：${m.was ?? '（没有）'}\n` +
    `      磁盘上：${m.now}\n` +
    `      ${m.why}`)
}

// ── 内嵌源码包（赠品）的指纹 ────────────────────────────────
//
// 它是"页面指纹"那个坑的第二次：源码包同样是**构建时冻进产物**的东西，
// 装的正是源码 + 全部文档（用户明确要求赠品里带文档）。改了文档不重新构建，
// 测试照样全绿（测试读磁盘），而对方收到的赠品里是旧文档。
//
// 它不像页面那样有一个"磁盘上的同名文件"可比 —— 它是**算出来的**，
// 所以"现在应该是多少"要现场打一份包（与正式赠送走同一个 buildSourcePack）。

/**
 * 现场打一份源码包，返回它的指纹。
 * @param {string} root 项目根目录
 * @returns {Promise<string>} 16 位十六进制
 */
export async function digestOfSourcePack(root = ROOT) {
  const { bytes } = await buildSourcePack(root)
  return assetFingerprint(bytes)
}

/**
 * 比对：产物里记录的源码包指纹 vs 现场打出来的。
 * @param {Record<string,string>|null} recorded
 * @param {string} root
 * @returns {Promise<{rel:string, was:string|null, now:string, why:string}|null>} null = 一致
 */
export async function compareSourcePack(recorded, root = ROOT) {
  const now = await digestOfSourcePack(root)
  const was = recorded?.[SOURCE_PACK_ASSET] ?? null
  if (!was) {
    return { rel: SOURCE_PACK_ASSET, was: null, now,
      why: '产物里没有记录这一项（这个产物构建时还没记源码包指纹 —— 重新构建即可）' }
  }
  if (was !== now) {
    return { rel: SOURCE_PACK_ASSET, was, now,
      why: '产物里内嵌的是旧版 —— 源码或文档改过之后没有重新构建' }
  }
  return null
}
