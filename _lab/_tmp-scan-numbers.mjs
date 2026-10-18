/**
 * 临时扫描：文档里那些"会随时间变化的具体数字"都有哪些、现在是否还对。
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { STRINGS } from '../web/i18n-strings.mjs'

const ROOT = path.resolve('.')
const docs = [
  '读我.md', 'README.md', '变更记录.md', 'CHANGELOG.md',
  ...readdirSync('docs').filter((f) => f.endsWith('.md')).map((f) => 'docs/' + f),
  ...readdirSync('中文文档').filter((f) => f.endsWith('.md')).map((f) => '中文文档/' + f),
  '_lab/交接.md',
]

const zh = Object.keys(STRINGS.zh)
console.log('实际：i18n 条数 =', zh.length, '（en', Object.keys(STRINGS.en).length, '）')
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
console.log('实际：version =', pkg.version, '· engines.node =', pkg.engines?.node)
const checkCount = pkg.scripts.check.split('&&').length
console.log('实际：npm run check 判据条数 =', checkCount)
console.log('实际：docs/ 里 md =', readdirSync('docs').filter((f) => f.endsWith('.md')).length,
  '· 中文文档/ 里 md =', readdirSync('中文文档').filter((f) => f.endsWith('.md')).length)

const probes = [
  { name: 'i18n 条数', re: /(\d{2,4})\s*(?:条|strings)/g },
  { name: '文档份数', re: /各\s*(\d+)\s*份|(?:ten|twelve|eleven|thirteen)\s+each/gi },
  { name: '版本号', re: /v?(\d+\.\d+\.\d+)/g },
  { name: '产物大小', re: /(\d{2,3}(?:\.\d)?)\s*(?:MB|M)\b/g },
  { name: '判据条数', re: /(\d+)\s*条判据/g },
]

for (const p of probes) {
  const hits = []
  for (const f of docs) {
    let src
    try { src = readFileSync(path.join(ROOT, f), 'utf8') } catch { continue }
    const lines = src.split('\n')
    lines.forEach((line, i) => {
      for (const m of line.matchAll(p.re)) hits.push(`${f}:${i + 1}  ${m[0]}  «${line.trim().slice(0, 90)}»`)
    })
  }
  console.log(`\n=== ${p.name}（${hits.length} 处）`)
  for (const h of hits.slice(0, 14)) console.log('  ' + h)
  if (hits.length > 14) console.log(`  …还有 ${hits.length - 14} 处`)
}
