// 一次性重构：删掉 10 处死代码、去掉 21 处多余导出的 `export`
// ==========================================================
// 每个锚点都要求**恰好命中一次**，否则整体中止（不做半截事）。
// 复核依据：_lab/audit-symbol-refs.mjs 的输出 —— 这 10 个名字除了定义处
// 全仓库（含文档、CI、测试、_lab）零引用；21 个名字只在定义文件内部使用。
//
// 用法：node _lab/refactor-cleanup-dead-exports.mjs [--dry]
import { readFileSync, writeFileSync } from 'node:fs'

const DRY = process.argv.includes('--dry')
const log = []

/** 找声明行：`export <kind> <name>` */
function declLine(lines, name, kinds = ['function', 'const', 'async function']) {
  const re = new RegExp(`^export (?:${kinds.join('|')}) ${name}\\b`)
  const hits = []
  lines.forEach((l, i) => { if (re.test(l)) hits.push(i) })
  if (hits.length !== 1) throw new Error(`${name}: 声明行命中 ${hits.length} 次（要求 1 次）`)
  return hits[0]
}

/** 声明上方紧邻的文档注释块（若有），返回起始行号 */
function docStart(lines, i) {
  const prev = lines[i - 1] ?? ''
  if (/^\s*\/\*\*.*\*\/\s*$/.test(prev)) return i - 1
  if (/^\s*\*\/\s*$/.test(prev)) {
    for (let k = i - 2; k >= 0; k--) {
      if (/^\s*\/\*\*/.test(lines[k])) return k
      if (/^\s*(?:\/\/|$)/.test(lines[k])) continue
    }
  }
  return i
}

/** 删除一个函数声明（含其上方文档注释）；返回删掉的行数 */
function dropFunction(text, name, file) {
  const lines = text.split('\n')
  const start = declLine(lines, name)
  let end = -1
  for (let k = start + 1; k < lines.length; k++) if (/^\}/.test(lines[k])) { end = k; break }
  if (end < 0) throw new Error(`${file}: ${name} 找不到收尾的顶格 }`)
  const from = docStart(lines, start)
  // 顺带吃掉声明后面多余的空行，避免留下两个连续空行
  let to = end + 1
  if (lines[from - 1] === '' && lines[to] === '') to++
  const removed = lines.splice(from, to - from)
  log.push(`  ✂️  ${file}: 删除 ${name}()（${removed.length} 行，原 ${from + 1}–${to}）`)
  return lines.join('\n')
}

/** 删除一个单行 const 声明（含其上方文档注释） */
function dropConst(text, name, file) {
  const lines = text.split('\n')
  const start = declLine(lines, name, ['const'])
  const src = lines[start]
  // 只允许删「一行写完」的常量：结尾不能是还没收口的 { [ ( 或续行符
  if (/[{[,(\\]$/.test(src.trim())) throw new Error(`${file}: ${name} 不是单行声明，请手工处理`)
  const from = docStart(lines, start)
  let to = start + 1
  if (lines[from - 1] === '' && lines[to] === '') to++
  const removed = lines.splice(from, to - from)
  log.push(`  ✂️  ${file}: 删除常量 ${name}（${removed.length} 行，原 ${from + 1}–${to}）`)
  return lines.join('\n')
}

/** 去掉 `export ` 前缀（声明保持模块内可见） */
function deExport(text, name, file) {
  const lines = text.split('\n')
  const i = declLine(lines, name)
  const before = lines[i]
  lines[i] = before.replace(/^export /, '')
  if (lines[i] === before) throw new Error(`${file}: ${name} 的 export 没被去掉`)
  log.push(`  ·   ${file}: ${name} 改为模块内可见`)
  return lines.join('\n')
}

/** 删除一整行 import（要求恰好一次） */
function dropLine(text, needle, file) {
  const lines = text.split('\n')
  const hits = lines.map((l, i) => (l.includes(needle) ? i : -1)).filter((i) => i >= 0)
  if (hits.length !== 1) throw new Error(`${file}: 删导入 "${needle}" 命中 ${hits.length} 次`)
  log.push(`  ✂️  ${file}: 删除导入 ${lines[hits[0]].trim()}（${needle}）`)
  lines.splice(hits[0], 1)
  return lines.join('\n')
}

const jobs = {
  'src/x509.js': (t, f) => {
    t = dropFunction(t, 'algIdEc', f)
    t = dropFunction(t, 'subjectPublicKeyInfo', f)
    t = deExport(t, 'SET', f)
    t = deExport(t, 'NULL', f)
    return t
  },
  'src/gift.js': (t, f) => {
    t = dropFunction(t, 'unpackArchive', f)
    t = dropFunction(t, 'giftDigest', f)
    t = dropLine(t, "import { createHash } from 'node:crypto'", f)
    t = dropLine(t, "import { sanitizeRelPath } from './manifest.js'", f)
    t = deExport(t, 'projectRoot', f)
    t = deExport(t, 'giftWarnings', f)
    t = deExport(t, 'packArchive', f)
    return t
  },
  'src/server.js': (t, f) => {
    t = dropFunction(t, 'prepareManifest', f)
    return t
  },
  'src/chunk-size.js': (t, f) => {
    t = dropConst(t, 'PROTOCOL_DEFAULT_CHUNK', f)
    return t
  },
  'src/assets.js': (t, f) => {
    t = dropFunction(t, 'installRootDir', f)
    t = dropFunction(t, 'readAssetSync', f)
    t = dropFunction(t, 'installAssetLoader', f)
    t = dropFunction(t, 'installAssetLoaderBinary', f)
    t = dropLine(t, "import { readFileSync as readFileSyncFs } from 'node:fs'", f)
    t = deExport(t, 'injectedVersion', f)
    return t
  },
  'src/manifest.js': (t, f) => {
    t = deExport(t, 'KIND', f)
    t = deExport(t, 'hashSource', f)
    return t
  },
  'src/prepare.js': (t, f) => deExport(t, 'buildServerManifest', f),
  'src/relay/protocol.js': (t, f) => deExport(t, 'splitBatch', f),
  'src/relay/room.js': (t, f) => {
    t = deExport(t, 'DEFAULT_TTL_MS', f)
    t = deExport(t, 'MAX_ROOMS', f)
    return t
  },
  'src/run.js': (t, f) => {
    t = deExport(t, 'loadReceiverHtml', f)
    t = deExport(t, 'registerDestroySteps', f)
    return t
  },
  'src/gui.js': (t, f) => deExport(t, 'findChromium', f),
  'src/session-cert.js': (t, f) => deExport(t, 'thumbprintOf', f),
  'src/trust.js': (t, f) => deExport(t, 'TEMP_CERT_PREFIX', f),
  'src/tty.js': (t, f) => deExport(t, 'qrLines', f),
  'bin/flicker.js': (t, f) => {
    t = deExport(t, 'parseArgs', f)
    t = deExport(t, 'parseDuration', f)
    t = deExport(t, 'openBrowser', f)
    return t
  },
}

console.log(DRY ? '=== 预演（不写盘）===' : '=== 执行 ===')
const out = new Map()
for (const [file, fn] of Object.entries(jobs)) {
  const before = readFileSync(file, 'utf8')
  const after = fn(before, file)
  if (after === before) throw new Error(`${file}: 没有任何变化（锚点是不是写错了？）`)
  out.set(file, after)
}
for (const line of log) console.log(line)
if (!DRY) {
  for (const [file, text] of out) writeFileSync(file, text)
  console.log(`\n已写盘 ${out.size} 个文件`)
} else {
  console.log(`\n预演通过：${out.size} 个文件、${log.length} 处改动`)
}
