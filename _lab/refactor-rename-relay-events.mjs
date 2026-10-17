// 一次性改名：中继的两个房间事件从三段式改成两段式
//   relay/room/created  → relay/room-created
//   relay/room/destroyed → relay/room-destroyed
//
// 为什么：这个项目的事件名约定是**两段式** `域/动作`（run/start、manifest/scanned、
// transfer/complete…），而 `gen/check-plugin-doc.mjs` 与 `test/plugin.test.js` 里的
// 判据都按两段式写的 —— 是文档判据先把这次不一致抓出来的（它说"文档里少了…"，
// 其实是名字的形状不在约定里）。
//
// 用法：node _lab/refactor-rename-relay-events.mjs [--dry]
import { readFileSync, writeFileSync } from 'node:fs'

const DRY = process.argv.includes('--dry')
const FILES = [
  'src/plugin/events.js',
  'test/plugin-relay.test.js',
  'docs/插件.md',
  '中文文档/插件.md',
  'examples/plugins/relay-gate.cjs',
]

let total = 0
const out = new Map()
for (const f of FILES) {
  const before = readFileSync(f, 'utf8')
  const after = before
    .replaceAll('relay/room/created', 'relay/room-created')
    .replaceAll('relay/room/destroyed', 'relay/room-destroyed')
  const n = (before.match(/relay\/room\/(created|destroyed)/g) ?? []).length
  if (n === 0) throw new Error(`${f}: 没找到要改的名字（锚点变了？）`)
  total += n
  out.set(f, after)
  console.log(`  ${f}：${n} 处`)
}
console.log(`共 ${total} 处`)
if (DRY) console.log('（--dry 预演，未写盘）')
else { for (const [f, text] of out) writeFileSync(f, text); console.log('已写盘') }
