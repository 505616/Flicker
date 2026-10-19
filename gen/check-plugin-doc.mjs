/**
 * 插件文档与事件表的一致性检查
 * ============================
 * 插件的"契约"写在三个地方，而它们天生会漂移：
 *   · `src/plugin/events.js` 的 `PLUGIN_TABLE` —— 运行时用的名字常量与校验依据（唯一真相）
 *   · `中文文档/插件.md` 的事件表
 *   · `docs/插件.md` 的事件表
 *
 * 漂移的后果很具体：文档里写着一个不存在的事件，插件作者照着写 →
 * `ctx.on()` 当场抛"订阅了不存在的事件" —— 他会以为是自己写错了。
 * 反过来，代码里加了事件而文档没写，等于功能藏起来了。
 *
 * 所以这台判据把三处的**名字集合**逐一对齐（不比对描述文字：那是给人看的，
 * 两种语言本来就不一样）。中英文结构一致由 `gen/check-doc-pairs.mjs` 另行守着。
 *
 * 判据逻辑抽成 `auditPluginDoc(root)`，CLI 只负责打印：
 * `test/plugin-doc.test.js` 会拿一棵临时树（文档里故意少写一个 / 多写一个事件）
 * 反过来验它 —— 否则"文档与实现一致"这句就只能靠人相信。
 *
 * 用法：node gen/check-plugin-doc.mjs [--root=<另一棵树>]
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLUGIN_TABLE, API_VERSION, SUPPORTED_API_VERSIONS } from '../src/plugin/events.js'
import { PAGE_HOOKS, PAGE_SLOTS, PAGE_API_VERSION } from '../web/page-plugin-runtime.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DOCS = ['中文文档/插件.md', 'docs/插件.md']

/** 从 `--key=value` 里取值（测试注入坏掉的副本用） */
export function argOf(argv, name, fallback) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

/**
 * 事件表里的人话名字（代码是唯一真相）。
 *
 * ⚠️ 三个平面的"唯一真相"不在同一个文件里：发送端与中继在 `src/plugin/events.js`，
 *    页面在 `web/page-plugin-runtime.mjs`（那一份要被内联进页面，不能 import Node 侧的模块）。
 *    所以这里把两处合起来比 —— 页面平面漏写进文档同样会被拦下。
 */
export function expectedNames() {
  return new Set([
    ...PLUGIN_TABLE.map((r) => r.name),
    ...PAGE_HOOKS,
    ...PAGE_SLOTS,
  ])
}

/**
 * 从文档的**表格行**里取出所有 `域/动作` 形式的名字。
 *
 * ⚠️ 名字的形状是**两段式** `域/动作`，动作里允许连字符
 *    （`relay/room-created`）。这条正则与 `test/plugin.test.js` 里的
 *    "事件表自洽"用例必须一致 —— 2026-10 就是因为这里只允许纯字母，
 *    而代码里写的是三段式 `relay/room/created`，判据报的是"文档里少了…"，
 *    读起来像是文档漏写，其实是命名形状不在约定里。
 */
export function namesInDocText(src) {
  const got = new Set()
  for (const line of src.split('\n')) {
    if (!line.trim().startsWith('|')) continue          // 只看表格行
    for (const m of line.matchAll(/`([a-z]+(?:\/[a-z-]+)+)`/g)) got.add(m[1])
  }
  return got
}

export function namesInDoc(root, rel) {
  return namesInDocText(readFileSync(path.join(root, rel), 'utf8'))
}

/**
 * 核一棵树：返回 { problems, info }。
 * @param {string} root 仓库根目录（测试时指向一份临时副本）
 */
export function auditPluginDoc(root = ROOT) {
  const problems = []
  const info = []
  const want = expectedNames()

  for (const rel of DOCS) {
    let src = null
    try { src = readFileSync(path.join(root, rel), 'utf8') } catch { /* 交给下面报 */ }
    if (src === null) {
      problems.push(`${rel}: 文件不存在（文档改名了？这条判据要跟着改）`)
      continue
    }
    const got = namesInDocText(src)
    const missing = [...want].filter((n) => !got.has(n))
    const extra = [...got].filter((n) => !want.has(n))
    if (missing.length || extra.length) {
      let msg = `${rel} 的事件表与实现不一致（实现里的名字见 src/plugin/events.js 的 PLUGIN_TABLE）`
      if (missing.length) msg += `\n    文档里少了：${missing.join('、')}`
      if (extra.length) msg += `\n    文档里多了（实现里没有）：${extra.join('、')}`
      problems.push(msg)
    } else {
      info.push(`✓ ${rel}：${got.size} 个事件/贡献点与实现一致`)
    }
  }

  // 版本号也要一致：文档里教人写 `apiVersion: N`，写错了插件会被拒绝加载
  for (const rel of DOCS) {
    let src = null
    try { src = readFileSync(path.join(root, rel), 'utf8') } catch { continue }
    problems.push(...versionProblems(src, rel))
  }
  return { problems, info, want }
}

/**
 * 版本号检查（抽出来是为了能被反向测试单独喂进去）。
 *
 * ⚠️ 这里用**出现次数**而不是 `includes`：本程序的 `API_VERSION` 与页面平面的
 *    `PAGE_API_VERSION` 当前**都是同一个数字**，于是"程序侧写了、页面侧没写"这种
 *    文档用 `includes` 两条都能过（2026-10 写反向用例时实测：删掉一整行页面版本，
 *    判据一声不响）。两个数字相同时就要求至少出现两次。
 */
export function versionProblems(src, rel) {
  const problems = []
  const count = (needle) => src.split(needle).length - 1
  const sameNumber = PAGE_API_VERSION === API_VERSION
  const programHits = count(`apiVersion: ${API_VERSION}`)
  const pageHits = count(`apiVersion: ${PAGE_API_VERSION}`)
  if (programHits < 1) {
    problems.push(`${rel} 里没有出现 \`apiVersion: ${API_VERSION}\` —— ` +
      `本程序提供的插件 API 版本是 ${API_VERSION}（支持：${SUPPORTED_API_VERSIONS.join(' / ')}）`)
  }
  if (pageHits < (sameNumber ? 2 : 1)) {
    problems.push(`${rel} 里没有出现页面平面的 \`apiVersion: ${PAGE_API_VERSION}\`` +
      (sameNumber
        ? `（页面平面与程序侧当前是同一个数字 ${API_VERSION}，所以两份都要写，文档里只出现了 ${pageHits} 次）`
        : ''))
  }
  return problems
}

// ── CLI ──────────────────────────────────────────────────────

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  const root = argOf(process.argv.slice(2), 'root', ROOT)
  const { problems, info, want } = auditPluginDoc(root)
  for (const line of info) console.log(line)
  if (problems.length) {
    for (const p of problems) console.error(`\n✗ ${p}`)
    console.error('\n改事件时请一次改三处：src/plugin/events.js 的表、两份 插件.md 的表格行，' +
      '然后再跑一次本检查。')
    process.exit(1)
  }
  console.log(`✓ 插件文档与实现一致（API 版本 ${API_VERSION}，${want.size} 个事件/贡献点，中英各一份）`)
}
