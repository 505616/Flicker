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
 * 用法：node gen/check-plugin-doc.mjs
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLUGIN_TABLE, API_VERSION, SUPPORTED_API_VERSIONS } from '../src/plugin/events.js'
import { PAGE_HOOKS, PAGE_SLOTS, PAGE_API_VERSION } from '../web/page-plugin-runtime.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DOCS = ['中文文档/插件.md', 'docs/插件.md']

/**
 * 事件表里的人话名字（代码是唯一真相）。
 *
 * ⚠️ 三个平面的"唯一真相"不在同一个文件里：发送端与中继在 `src/plugin/events.js`，
 *    页面在 `web/page-plugin-runtime.mjs`（那一份要被内联进页面，不能 import Node 侧的模块）。
 *    所以这里把两处合起来比 —— 页面平面漏写进文档同样会被拦下。
 */
const want = new Set([
  ...PLUGIN_TABLE.map((r) => r.name),
  ...PAGE_HOOKS,
  ...PAGE_SLOTS,
])

/**
 * 从文档的**表格行**里取出所有 `域/动作` 形式的名字。
 *
 * ⚠️ 名字的形状是**两段式** `域/动作`，动作里允许连字符
 *    （`relay/room-created`）。这条正则与 `test/plugin.test.js` 里的
 *    "事件表自洽"用例必须一致 —— 2026-10 就是因为这里只允许纯字母，
 *    而代码里写的是三段式 `relay/room/created`，判据报的是"文档里少了…"，
 *    读起来像是文档漏写，其实是命名形状不在约定里。
 */
function namesInDoc(rel) {
  const src = readFileSync(path.join(ROOT, rel), 'utf8')
  const got = new Set()
  for (const line of src.split('\n')) {
    if (!line.trim().startsWith('|')) continue          // 只看表格行
    for (const m of line.matchAll(/`([a-z]+(?:\/[a-z-]+)+)`/g)) got.add(m[1])
  }
  return got
}

let bad = 0
for (const rel of DOCS) {
  const got = namesInDoc(rel)
  const missing = [...want].filter((n) => !got.has(n))
  const extra = [...got].filter((n) => !want.has(n))
  if (missing.length || extra.length) {
    bad++
    console.error(`\n✗ ${rel} 的事件表与实现不一致（实现里的名字见 src/plugin/events.js 的 PLUGIN_TABLE）`)
    if (missing.length) console.error(`    文档里少了：${missing.join('、')}`)
    if (extra.length) console.error(`    文档里多了（实现里没有）：${extra.join('、')}`)
  } else {
    console.log(`✓ ${rel}：${got.size} 个事件/贡献点与实现一致`)
  }
}

// 版本号也要一致：文档里教人写 `apiVersion: N`，写错了插件会被拒绝加载
for (const rel of DOCS) {
  const src = readFileSync(path.join(ROOT, rel), 'utf8')
  if (!src.includes(`apiVersion: ${API_VERSION}`)) {
    bad++
    console.error(`\n✗ ${rel} 里没有出现 \`apiVersion: ${API_VERSION}\` —— ` +
      `本程序提供的插件 API 版本是 ${API_VERSION}（支持：${SUPPORTED_API_VERSIONS.join(' / ')}）`)
  }
  if (!src.includes(`apiVersion: ${PAGE_API_VERSION}`)) {
    bad++
    console.error(`\n✗ ${rel} 里没有出现页面平面的 \`apiVersion: ${PAGE_API_VERSION}\``)
  }
}

if (bad) {
  console.error('\n改事件时请一次改三处：src/plugin/events.js 的表、两份 插件.md 的表格行，' +
    '然后再跑一次本检查。')
  process.exit(1)
}
console.log(`✓ 插件文档与实现一致（API 版本 ${API_VERSION}，${want.size} 个事件/贡献点，中英各一份）`)
