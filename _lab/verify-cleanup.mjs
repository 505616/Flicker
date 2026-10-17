// 清理后复核：① 10 个死名字是否还有残留 ② 去掉的导入是否真的用不上了
// ③ 每个被改过的模块是否还能正常 import（ESM 语法与引用完整性）
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const DEAD = [
  'algIdEc', 'subjectPublicKeyInfo', 'unpackArchive', 'giftDigest',
  'prepareManifest', 'PROTOCOL_DEFAULT_CHUNK',
  'installRootDir', 'readAssetSync', 'installAssetLoader', 'installAssetLoaderBinary',
]
const TOUCHED = [
  'src/x509.js', 'src/gift.js', 'src/server.js', 'src/chunk-size.js', 'src/assets.js',
  'src/manifest.js', 'src/prepare.js', 'src/relay/protocol.js', 'src/relay/room.js',
  'src/run.js', 'src/gui.js', 'src/session-cert.js', 'src/trust.js', 'src/tty.js',
  'bin/flicker.js',
]

const files = []
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.(js|mjs|cjs|html|md)$/.test(e.name)) files.push(p)
  }
}
walk('.')

console.log('=== ① 死名字残留（忽略本次体检/重构脚本自身）===')
let bad = 0
for (const name of DEAD) {
  const re = new RegExp(`\\b${name}\\b`, 'g')
  for (const f of files) {
    if (/audit-symbol-refs|refactor-cleanup-dead|verify-cleanup/.test(f)) continue
    const m = readFileSync(f, 'utf8').match(re)
    if (m) { console.log(`  ⚠️ ${f.replace(/\\/g, '/')} ×${m.length}`); bad++ }
  }
}
console.log(bad ? '  → 仍有残留' : '  ✓ 10 个名字已彻底移除')

console.log('\n=== ② 被删掉的导入是否真没人用了 ===')
for (const [f, names] of [
  ['src/server.js', ['fromWire']],
  ['src/chunk-size.js', ['PARAMS']],
  ['src/assets.js', ['joinPath', 'readFileAsync', 'readFileSync']],
  ['src/gift.js', ['createHash', 'sanitizeRelPath']],
]) {
  const s = readFileSync(f, 'utf8')
  for (const n of names) {
    const c = (s.match(new RegExp(`\\b${n}\\b`, 'g')) ?? []).length
    console.log(`  ${c === 0 ? '⚠️ 已无引用（导入该删）' : '✓ 仍在使用'}  ${f}: ${n} ×${c}`)
  }
}

console.log('\n=== ③ 被改过的模块能否正常 import ===')
let fail = 0
for (const f of TOUCHED) {
  if (f.startsWith('bin/')) { console.log(`  – 跳过 ${f}（入口，改用 --help 冒烟）`); continue }
  try {
    await import(new URL('../' + f, import.meta.url).href)
    console.log(`  ✓ ${f}`)
  } catch (e) {
    fail++
    console.log(`  ✗ ${f}: ${e.message}`)
  }
}
process.exitCode = bad || fail ? 1 : 0
