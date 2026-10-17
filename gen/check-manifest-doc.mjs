/**
 * `PROTOCOL.md` §6.1 清单字段与**实现**的一致性检查
 * =================================================
 *
 * ── 为什么要有这一条 ──
 * §6.1 曾经整节写错：文档上是 `protocol` / `session` / `sid` / `files[].path` /
 * `files[].merkle` / `files[].mode` / `files[].mtime`，而实现里**一个都没有** ——
 * 照文档写客户端会直接解析失败（`fromWire` 只认 `v` 与 `rel`）。
 * 这类错误靠人眼审是发现不了的：文档读起来通顺、字段名也合理，
 * 只有把**真实代码的输出**和文档摆在一起比才会露出来。
 *
 * 所以这里不写"我保证以后会小心"，而是把判据写成机器检查：
 *   ① 用真实代码（`src/manifest.js` 的 `scan` + `toWire`）生成一份线格式清单
 *   ② 从两份 `PROTOCOL.md` 的 §6.1 里读出那个 ```json 围栏，解析它
 *   ③ 逐项比对：**字段集合、字段顺序、每个字段的类型**必须完全一致
 *   ④ 字段表必须正好覆盖这些字段，不能多也不能少
 *   ⑤ 那张"旧文档 → 实现"对照表里列出的旧字段，**必须确实不在实现里**
 *      （将来真加了 `mtime` 之类，这条会失败，逼着人回来改文档）
 *
 * 中英文都查：只查一边的话，另一边照样能漂。
 *
 * 用法：node gen/check-manifest-doc.mjs
 */
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scan, toWire, fillHashes } from '../src/manifest.js'
import { PARAMS } from '../src/suite/flicker1.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DOCS = ['中文文档/PROTOCOL.md', 'docs/PROTOCOL.md']

let bad = 0
const fail = (m) => { console.error(`✗ ${m}`); bad++ }

/**
 * ① 真实代码生成的清单。
 *
 * 走的是**和正式发送完全一样**的三步：`scan`（扫描）→ `fillHashes`（补校验值）
 * → `toWire`（转线格式）；`gift` 由 `prepare.js` 之后补上，这里按它的取值置 `null`。
 * 少走一步就会得出错误的字段集合 —— 第一版就漏了 `fillHashes`，
 * 于是检查反过来说文档里的 `sha256` "实现里是 null"。
 */
async function realManifest() {
  const dir = mkdtempSync(path.join(tmpdir(), 'flicker-mfdoc-'))
  try {
    writeFileSync(path.join(dir, 'a.bin'), Buffer.alloc(64, 1))
    const m = await scan([path.join(dir, 'a.bin')], { chunkBytes: PARAMS.chunkBytes })
    await fillHashes(m)
    const wire = toWire(m, { sentAt: '<ISO timestamp>' })
    wire.gift = null                      // prepare.js 之后才加，见 src/prepare.js
    return wire
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)

/** ② 从文档的 §6.1 里取出 json 样例、字段表、旧字段对照表 */
function parseDoc(file) {
  const lines = readFileSync(file, 'utf8').split('\n')
  const start = lines.findIndex((l) => /^### 6\.1 /.test(l))
  if (start < 0) { fail(`${file}：找不到 §6.1`); return null }
  let end = lines.length
  for (let k = start + 1; k < lines.length; k++) {
    if (/^### /.test(lines[k])) { end = k; break }
  }
  const body = lines.slice(start, end)

  let sample = null
  let table = []
  let oldTable = []
  let inFence = false
  let fenceBuf = null
  for (const l of body) {
    if (l.trimStart().startsWith('```')) {
      if (!inFence && /^```json\s*$/.test(l.trimStart())) fenceBuf = []
      else if (inFence && fenceBuf) { sample = fenceBuf.join('\n'); fenceBuf = null }
      inFence = !inFence
      continue
    }
    if (inFence) { if (fenceBuf) fenceBuf.push(l); continue }
    if (/^>\s*\|/.test(l)) { oldTable.push(l); continue }
    if (/^\s*\|.*\|\s*$/.test(l)) table.push(l)
  }
  if (sample === null) { fail(`${file}：§6.1 里没有找到 json 样例围栏`); return null }

  let json
  try { json = JSON.parse(sample) } catch (e) {
    fail(`${file}：§6.1 的 json 样例解析失败 —— ${e.message}`)
    return null
  }

  const cells = (row) => row.split('|').slice(1, -1).map((c) => c.trim())
  const isSep = (r) => /^\|[\s:|-]+\|$/.test(r.trim().replace(/\|/g, (m, i) => m))

  // 字段表：第一格里的标识符
  const documented = []
  for (const row of table) {
    const c = cells(row)
    if (!c.length) continue
    if (/^-{2,}$/.test(c[0].replace(/[:\s]/g, '-'))) continue
    const ids = [...c[0].matchAll(/`([^`]+)`/g)].map((m) => m[1])
    if (!ids.length) continue                      // 表头（"字段"/"Field"）
    documented.push(ids[0])
  }

  // 旧字段对照表：第一格里所有反引号标识符
  const oldFields = []
  for (const row of oldTable) {
    const c = cells(row)
    if (!c.length) continue
    if (/^-{2,}$/.test(c[0].replace(/[:\s]/g, '-'))) continue
    for (const m of c[0].matchAll(/`([^`]+)`/g)) oldFields.push(m[1])
  }

  return { json, documented, oldFields }
}

const real = await realManifest()
const topKeys = Object.keys(real)
const fileKeys = Object.keys(real.files[0])
/** 顶层 `files` 在文档里写成数组形式的 `files[]`，这里统一 */
const realKeys = new Set([
  ...topKeys.map((k) => (k === 'files' ? 'files[]' : k)),
  ...fileKeys.map((k) => `files[].${k}`),
])

const realTypes = new Map()
for (const k of topKeys) realTypes.set(k, typeOf(real[k]))
for (const k of fileKeys) realTypes.set(`files[].${k}`, typeOf(real.files[0][k]))

for (const rel of DOCS) {
  const doc = parseDoc(path.join(ROOT, rel))
  if (!doc) continue

  // ③ 字段集合、顺序、类型
  const docTop = Object.keys(doc.json)
  const docFile = doc.json.files?.[0] ? Object.keys(doc.json.files[0]) : []
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])
  if (!same(docTop, topKeys)) {
    fail(`${rel} §6.1：顶层字段与实现不一致\n    文档：${docTop.join(', ')}\n    实现：${topKeys.join(', ')}`)
  }
  if (!same(docFile, fileKeys)) {
    fail(`${rel} §6.1：files[] 字段与实现不一致\n    文档：${docFile.join(', ')}\n    实现：${fileKeys.join(', ')}`)
  }
  for (const [k, t] of realTypes) {
    const v = k.startsWith('files[].') ? doc.json.files?.[0]?.[k.slice(8)] : doc.json[k]
    if (v === undefined) continue                   // 集合不一致上面已经报过
    if (typeOf(v) !== t) {
      fail(`${rel} §6.1：${k} 的类型是 ${typeOf(v)}，实现是 ${t}`)
    }
  }

  // ④ 字段表必须正好覆盖实现的字段
  const documented = doc.documented.map((k) => (k === 'files' ? 'files[]' : k))
  const missing = [...realKeys].filter((k) => !documented.includes(k))
  const extra = documented.filter((k) => !realKeys.has(k))
  if (missing.length) fail(`${rel} §6.1：字段表少了这些字段 —— ${missing.join(', ')}`)
  if (extra.length) fail(`${rel} §6.1：字段表里有实现中不存在的字段 —— ${extra.join(', ')}`)

  // ⑤ 对照表里列的旧字段必须确实不在实现里
  for (const f of doc.oldFields) {
    const bare = f.startsWith('files[].') ? f.slice(8) : f
    const inTop = topKeys.includes(f)
    const inFile = fileKeys.includes(bare)
    if (inTop || inFile) {
      fail(`${rel} §6.1：对照表把 \`${f}\` 列为"旧文档字段"，但它**已经出现在实现里了** —— ` +
        '实现变了，文档这一段要跟着改')
    }
  }
}

if (bad) {
  console.error(`\n${bad} 处 §6.1 与实现不一致`)
  process.exit(1)
}
console.log(`✓ PROTOCOL.md §6.1 与实现一致（中英文各 1 份，顶层 ${topKeys.length} 字段 / ` +
  `files[] ${fileKeys.length} 字段）`)
