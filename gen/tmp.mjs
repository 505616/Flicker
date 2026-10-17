/**
 * 临时目录的统一处理（构建脚本与 _lab 脚本共用）
 * ==============================================
 *
 * ── 为什么需要这个文件 ────────────────────────────────────────
 *
 * 2026-10 用户看了一眼自己的 `%TEMP%`，发现里面**有 1000 多个文件、2.4 GB**，
 * 而且几乎全是我们的。查下来是两类原因：
 *
 *   ① `gen/smoke-sea.mjs` 每次冒烟都把 93 MB 的产物复制到临时目录里跑，
 *      收尾时 `rmSync(..., { force: true })` **删不掉就吞掉异常** ——
 *      而 Windows 上刚被 kill 的进程会短暂占着那个 exe，于是删不掉。
 *      22 次冒烟 = 22 份 93 MB 的副本 = 2.1 GB，安静地躺在用户硬盘上。
 *   ② 各种测试/演练脚本自己在临时目录建目录，失败路径或进程被强杀时来不及删。
 *
 * 这和项目对用户的核心承诺（"所有传输用到的东西都是一次性的，用完就销毁"）
 * 是同一件事：**我们不该在用户的机器上留东西**。测试工具也是我们的一部分。
 *
 * ── 这里的规矩 ──────────────────────────────────────────────
 *   · 建目录一律走 `makeTempDir()`：它自己登记，退出时统一删；
 *   · 删不掉**要重试**（Windows 上文件句柄释放有延迟），重试还不行就**报出来**，
 *     绝不静默吞掉 —— "看起来删了"是这个项目最忌讳的一类失败；
 *   · `process.on('exit')` 上挂一个同步兜底，Ctrl+C 也能收干净。
 */
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** 我们自己建的临时目录（退出时统一清理） */
const mine = new Set()

/**
 * 我们所有工具用的名字前缀 —— 清理脚本按它认领，别改得太随意。
 *
 * ⚠️ 只列**能确定是我们建的**前缀。太通用的（`sw-`、`shot-`、`race-`…）不算：
 *    清理脚本宁可漏掉几个，也不能删掉别的程序放在临时目录里的东西 ——
 *    那比"留下垃圾"严重得多。那些脚本的目录名已统一改成 `flicker-` 开头。
 */
export const PREFIXES = Object.freeze([
  'flicker-',            // 我们自己建的一切（smoke / cert / 测试 / 演练 / 体检…）
  'rehearsal-edge-',     // _lab/rehearsal-lan.mjs 的浏览器 profile
  'relay-browser-',      // _lab/e2e-relay-browser.mjs
  'bench-',              // _lab/bench-*.mjs
  'lan-bench-',          // _lab/bench-lan-parallel.mjs
  'verify-relay-',       // _lab/verify-relay.mjs
  'verify-remote-',      // _lab/verify-remote-relay.mjs
  'probe-gift-',         // _lab/probe-relay-gift.mjs
  'probe-source-pack-',  // _lab/probe-source-pack-runnable.mjs
])

/**
 * 建一个临时目录并登记清理。
 * @param {string} prefix 必须以我们自己的前缀开头（见 `PREFIXES`）
 * @returns {string} 目录路径
 */
export function makeTempDir(prefix) {
  if (!PREFIXES.some((p) => prefix.startsWith(p))) {
    throw new Error(`临时目录前缀 ${JSON.stringify(prefix)} 不在已知清单里 —— ` +
      '清理脚本认不出它，就会变成用户硬盘上的垃圾。请加进 PREFIXES')
  }
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  mine.add(dir)
  return dir
}

/** 删一个目录：重试几次（句柄释放有延迟），返回是否真的删掉了 */
export function removeTempDir(dir, { attempts = 6, delayMs = 250 } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      // force:true 对"本来就不存在"也返回成功 —— 我们关心的是"现在确实没有了"
      try { realpathSync(dir); /* 还在 */ } catch { return true }
    } catch { /* 再试 */ }
    // 同步 sleep：收尾路径上不能 await（exit 钩子里只能用同步 API）
    const until = Date.now() + delayMs
    while (Date.now() < until) { /* 忙等一小会儿 */ }
  }
  return false
}

/**
 * 清理我们建过的所有临时目录（含退出钩子里的同步兜底）。
 * @returns {{removed: string[], kept: string[]}} `kept` 非空时要**报出来**
 */
export function cleanupTempDirs() {
  const removed = [], kept = []
  for (const dir of mine) {
    if (removeTempDir(dir)) { mine.delete(dir); removed.push(dir) } else kept.push(dir)
  }
  return { removed, kept }
}

// 退出兜底：正常结束、异常结束、Ctrl+C 都会走这里。
// ⚠️ `exit` 钩子里只能用同步 API，所以 removeTempDir 是同步的。
function reportKept(kept) {
  if (!kept.length) return
  // 宁可让用户看到一行噪音，也不要安静地留下几个 GB
  try {
    process.stderr.write(`  ! 有 ${kept.length} 个临时目录没删掉（可能有进程还占着）：\n` +
      kept.map((d) => '      ' + d).join('\n') + '\n' +
      '    可以稍后跑 `node gen/clean-temp.mjs --yes` 清掉\n')
  } catch { /* 连 stderr 都写不了就算了 */ }
}

process.on('exit', () => {
  const { kept } = cleanupTempDirs()
  reportKept(kept)
})

// 信号：`exit` 事件**不会**为信号触发，所以要自己接一次再原样退出。
// 只在真的被 Ctrl+C 时清一次，清完把信号重新抛出（保持原来的退出语义）。
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    const { kept } = cleanupTempDirs()
    reportKept(kept)
    process.exit(sig === 'SIGINT' ? 130 : 143)
  })
}
