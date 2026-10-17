// 反向验证：把某一份 插件.md 里的一行事件删掉，check-plugin-doc 必须失败。
// 判据必须能被证伪 —— 否则它只是个"永远绿"的装饰。
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const TARGET = 'docs/插件.md'
const orig = readFileSync(TARGET, 'utf8')
// 删掉 `transfer/complete` 那一整行表格
const lines = orig.split('\n')
const at = lines.findIndex((l) => l.includes('`transfer/complete`'))
if (at < 0) { console.error('找不到那行（锚点变了？）'); process.exit(2) }
lines.splice(at, 1)
writeFileSync(TARGET, lines.join('\n'))

let status = null, out = ''
try {
  const r = spawnSync(process.execPath, ['gen/check-plugin-doc.mjs'], { encoding: 'utf8' })
  status = r.status
  out = (r.stdout || '') + (r.stderr || '')
} finally {
  writeFileSync(TARGET, orig)
}

const reported = /transfer\/complete/.test(out) && /少了/.test(out)
const crashed = /SyntaxError|Cannot find module/.test(out)
console.log(out.split('\n').filter((l) => l.trim()).slice(0, 6).map((l) => '  ' + l).join('\n'))
console.log(`\n退出码 = ${status}（应为 1）；点出少哪个 = ${reported}；自己崩了 = ${crashed}`)
if (status !== 1 || !reported || crashed) {
  console.error('❌ 反向验证没通过（要么判据没失败，要么是"自己崩了才失败"的假绿）')
  process.exit(1)
}
console.log('✅ 判据确实能被证伪；' + TARGET + ' 已还原')
