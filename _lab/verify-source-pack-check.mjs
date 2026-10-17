// 反向验证：往 PACK_EXCLUDES 里塞一条"故意排除 stations 页面"的规则，
// gen/check-source-pack.mjs 必须**报出缺了哪个文件**并失败（否则这台判据只是装饰）。
//
// ⚠️ 两个坑都踩过：
//   ① 用内联 `node -e` 打补丁时，shell 会把正则里的反斜杠吃掉 → 源码被写坏，
//      判据"失败"了，但失败原因是语法错，不是判据生效（假绿）。
//   ② 所以这里用**脚本文件**，而且塞进去的是一条不带任何反斜杠的规则
//      （`{ test: (p) => p === "…" }`）。判据里的 `re.test(probe)` 照样能用。
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const FILE = 'src/gift.js'
const orig = readFileSync(FILE, 'utf8')
const RULE = 'const PACK_EXCLUDES = [\n' +
  '  { test: (p) => p === "web/station.html" },   // 反向验证：故意排除一个必需文件\n'
const patched = orig.replace('const PACK_EXCLUDES = [\n', RULE)
if (patched === orig) { console.error('补丁没生效（锚点变了？）'); process.exit(2) }

writeFileSync(FILE, patched)
let status = null, out = ''
try {
  const r = spawnSync(process.execPath, ['gen/check-source-pack.mjs'], { encoding: 'utf8' })
  status = r.status
  out = (r.stdout || '') + (r.stderr || '')
} finally {
  writeFileSync(FILE, orig)                  // 无论如何都要还原
}

const reported = /web\/station\.html/.test(out) && /少了/.test(out)
const crashed = /SyntaxError|Cannot find module/.test(out)
console.log(out.split('\n').slice(0, 8).map((l) => '  ' + l).join('\n'))
console.log(`\n退出码 = ${status}（应为 1）；报出了缺哪个文件 = ${reported}；自己崩了 = ${crashed}`)

if (status !== 1 || !reported || crashed) {
  console.error('❌ 反向验证没通过：判据要么没失败、要么是"因为自己崩了才失败"（那是假绿）')
  process.exit(1)
}
console.log('✅ 判据确实能被证伪，而且是"点出缺哪个文件"地失败；src/gift.js 已还原')
