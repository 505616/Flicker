// 体检⑥：删除前逐个复核 —— 把 31 个候选符号在所有文件类型里的出现位置全部列出来
// 用法：node _lab/audit-symbol-refs.mjs
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const NAMES = [
  // ① 10 处死代码
  'algIdEc', 'subjectPublicKeyInfo', 'unpackArchive', 'giftDigest',
  'prepareManifest', 'PROTOCOL_DEFAULT_CHUNK',
  'installRootDir', 'readAssetSync', 'installAssetLoader', 'installAssetLoaderBinary',
  // ② 21 处多余导出
  'injectedVersion', 'projectRoot', 'giftWarnings', 'packArchive', 'findChromium',
  'KIND', 'hashSource', 'buildServerManifest', 'splitBatch',
  'DEFAULT_TTL_MS', 'MAX_ROOMS', 'loadReceiverHtml', 'registerDestroySteps',
  'thumbprintOf', 'TEMP_CERT_PREFIX', 'qrLines', 'SET', 'NULL',
  'parseArgs', 'parseDuration', 'openBrowser',
]

const files = []
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.(js|mjs|cjs|html|md|yml|yaml|json)$/.test(e.name)) files.push(p)
  }
}
walk('.')

const text = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]))
const rel = (f) => path.relative(ROOT, f).replace(/\\/g, '/')

for (const name of NAMES) {
  const re = new RegExp(`\\b${name}\\b`, 'g')
  const hits = []
  for (const [f, t] of text) {
    const n = (t.match(re) ?? []).length
    if (n) hits.push(`${rel(f)}×${n}`)
  }
  const outside = hits.filter((h) => !/^src\/[^/]+\.js×1$/.test(h))
  const flag = hits.length === 1 ? '🔴 只有定义处' : (outside.length <= 1 ? '🟡 仅定义文件内' : '⚪ 有外部引用')
  console.log(`${flag}  ${name.padEnd(24)} ${hits.join(', ')}`)
}
