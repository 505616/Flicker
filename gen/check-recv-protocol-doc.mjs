/**
 * `PROTOCOL.md` §7R（接收模式 `/up/*` 端点）与**实现**的一致性检查
 * ============================================================
 *
 * ── 为什么要有这一条 ──
 * §7R 是"手机 → 电脑"那条路的线上契约，客户端（手机页、以及将来别人照文档写的客户端）
 * 全靠它。而它有两个特别容易悄悄漂的地方：
 *
 *   ① **端点表**：文档里多一个端点、少一个端点、路径写错一个字母 ——
 *      本机测试**全绿**（测试测的是实现），只有照文档写客户端的人会撞上，
 *      而他看到的是"没有这个接口"或一个 404，会先怀疑自己。
 *   ② **响应字段**：文档里的 JSON 样例与实现输出的字段/类型对不上，
 *      客户端解析出来是 `undefined`，而错误信息离原因很远（§6.1 就是这么错过一次的）。
 *
 * 所以这里把两件事都做成机器判据：
 *   · 端点表：文档 §7R.2 的每一行 vs `src/upload-server.js` 的 `RECV_ROUTE_TABLE`
 *     （**单一来源**：实现按它拼路由），并且真的去请求一次，确认不是"表里有、路由没有"；
 *   · 响应形状：起一个**真的**接收服务，用真密码学走完
 *     `/up/session → /up/auth → /up/manifest → /up/chunk → /up/status → /up/finish`，
 *     拿真实响应的**字段集合、顺序、类型**去比文档 §7R.4–§7R.9 里那个 ```json 样例。
 *
 * 另外单独钉住几个**有意义的固定值**（不是会话数据）：`suite`、`macProfiles`、
 * `partSuffix`、以及 `limits` 的四个数 —— 2026-10 真机演练就是死在块大小报价上的。
 *
 * ⚠️ 不比的：`salt`/`challenge`/`sid`/`mac`/`rel`/`diskFree` 这类每次会话都不一样的值，
 *    只比类型。
 *
 * 中英文都查：只查一边的话，另一边照样能漂。
 *
 * 用法：node gen/check-recv-protocol-doc.mjs
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startReceiveServer, RECV_ROUTE_TABLE, RECV_ERROR_STATUS, PART_SUFFIX } from '../src/upload-server.js'
import { SessionError, errorBody } from '../src/session.js'
import {
  deriveVerifier, deriveKeys, senderMac, receiverMac, sealManifest, sealChunk,
} from '../src/suite/flicker1.js'
import { makeTempDir, cleanupTempDirs } from './tmp.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DOCS = ['中文文档/PROTOCOL.md', 'docs/PROTOCOL.md']
const PASSWORD = 'k7m-3fq'
const CHUNK = 64 * 1024

/** 文档小节 → 它所描述的那个端点的成功响应 */
const SECTION_OF = {
  '7R.4': '/up/session',
  '7R.5': '/up/auth',
  '7R.6': '/up/manifest',
  '7R.7': '/up/chunk',
  '7R.8': '/up/status',
  '7R.9': '/up/finish',
}

/**
 * 不走 `statusFor()`、由处理器**自己写死**状态码的两个码。
 *
 * ⚠️ 显式列出来而不是让它们落到 500：这是"实现里就是这样"，不是"文档可以含糊"。
 *    `NO_PAGE` 由 `handlePage` 直接 `json(404, …)`；两个 `BAD_*_INDEX` 由
 *    `handleChunk` 给 `e.status = 404`（它们只登记在 §7R.7 的表里，不在 §7R.10）。
 */
const INLINE_STATUS = Object.freeze({
  NO_PAGE: 404,
  BAD_FILE_INDEX: 404,
  BAD_CHUNK_INDEX: 404,
})

/** 某个错误码在接收模式上真实的 HTTP 状态码（与 `statusFor()` 同一条规则） */
const expectedStatus = (code) => INLINE_STATUS[code] ??
  RECV_ERROR_STATUS[code] ??
  errorBody(new SessionError('（判据探针）', code)).status

let bad = 0
const fail = (m) => { console.error(`✗ ${m}`); bad++ }

// ── ① 起一个真的接收服务，把每个端点的真实响应收下来 ──────────
//
// ⚠️ 用明文 HTTP 绑回环：这只是**本机判据**，不经过 TLS（TLS 那条路由
//    `_lab/recv-selftest.mjs` 用真证书连着 CLI 一起验）。这里要验的是
//    "端点与字段"，不是传输安全 —— 别把两件事混成一条判据。

const dir = makeTempDir('flicker-recv-doc-')
let server = null

/** 极简请求：够用就行，不为它引依赖 */
async function call(base, method, p, { headers = {}, body } = {}) {
  const r = await fetch(base + p, { method, headers, body })
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON（页面）就留 null */ }
  return { status: r.status, json, text }
}

async function traceRealFlow() {
  server = await startReceiveServer({
    dir, password: PASSWORD, host: '127.0.0.1', port: 0,
    pageHtml: '<!doctype html><meta charset="utf-8"><title>probe</title>',
  })
  const base = `http://127.0.0.1:${server.port}`
  const token = server.session.token
  const out = {}

  // ── 端点表：每一行都**真的请求一次**，只要求"不是路由 404" ──
  const probe = {}
  for (const [m, p] of RECV_ROUTE_TABLE) {
    const r = await call(base, m, p)
    probe[`${m} ${p}`] = r.json?.error ?? `HTTP ${r.status}`
  }
  const bogus = await call(base, 'GET', '/up/definitely-not-a-route')
  out.probe = probe
  out.bogusIs404 = bogus.json?.error === 'NOT_FOUND'

  // ── 正常路径 ──
  const s = await call(base, 'POST', `/up/session?k=${encodeURIComponent(token)}`)
  if (s.status !== 200) throw new Error(`/up/session 失败：${s.status} ${s.text}`)
  out['/up/session'] = s.json

  const salt = Buffer.from(s.json.salt, 'base64')
  const challenge = Buffer.from(s.json.challenge, 'base64')
  const profile = (s.json.macProfiles ?? []).includes('v2') ? 'v2' : 'v1'
  const keys = deriveKeys(deriveVerifier(PASSWORD, salt))
  const mac = senderMac(keys.auth, challenge, { profile })
  const b64 = (b) => Buffer.from(b).toString('base64')

  const a = await call(base, 'POST', '/up/auth', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mac: b64(mac), challenge: b64(challenge), macProfile: profile }),
  })
  if (a.status !== 200) throw new Error(`/up/auth 失败：${a.status} ${a.text}`)
  // 顺带确认电脑那一侧**确实**在证明自己知道密码（否则字段对了、语义是坏的）
  if (a.json.mac !== b64(receiverMac(keys.auth, challenge, { profile }))) {
    throw new Error('/up/auth 回送的 mac 不是 receiverMac —— 端点行为变了')
  }
  out['/up/auth'] = a.json
  const sid = a.json.sid
  const h = { 'X-Flicker-Sid': sid }

  const files = [
    { rel: 'note.txt', bytes: Buffer.from('手机发来的第一条\n', 'utf8') },
    { rel: 'photo.bin', bytes: Buffer.alloc(CHUNK + 4321, 7) },
  ]
  const wire = { files: [], totalBytes: 0, totalChunks: 0 }
  const metas = files.map((f, i) => {
    const chunks = Math.max(1, Math.ceil(f.bytes.length / CHUNK))
    wire.files.push({
      index: i, rel: f.rel, size: f.bytes.length, chunks, chunkBytes: CHUNK,
      sha256: createHash('sha256').update(f.bytes).digest('hex'),
    })
    wire.totalBytes += f.bytes.length
    wire.totalChunks += chunks
    return { ...f, chunks }
  })
  const sealed = sealManifest(keys.enc, Buffer.from(JSON.stringify(wire), 'utf8'))
  const m = await call(base, 'POST', '/up/manifest', {
    headers: { ...h, 'Content-Type': 'application/octet-stream' },
    body: Buffer.concat([sealed.iv, sealed.tag, sealed.ct]),
  })
  if (m.status !== 200) throw new Error(`/up/manifest 失败：${m.status} ${m.text}`)
  out['/up/manifest'] = m.json

  for (let fi = 0; fi < metas.length; fi++) {
    const f = metas[fi]
    for (let ci = 0; ci < f.chunks; ci++) {
      const start = ci * CHUNK
      const plain = f.bytes.subarray(start, Math.min(start + CHUNK, f.bytes.length))
      const { ct, tag } = sealChunk(keys.enc, fi, ci, f.chunks, plain)
      const r = await call(base, 'PUT', `/up/chunk?f=${fi}&c=${ci}`, {
        headers: { ...h, 'Content-Type': 'application/octet-stream' },
        body: Buffer.concat([tag, ct]),
      })
      if (r.status !== 200) throw new Error(`/up/chunk f=${fi} c=${ci} 失败：${r.status} ${r.text}`)
      if (fi === 0 && ci === 0) out['/up/chunk'] = r.json
    }
  }

  const st = await call(base, 'GET', '/up/status', { headers: h })
  if (st.status !== 200) throw new Error(`/up/status 失败：${st.status} ${st.text}`)
  out['/up/status'] = st.json

  const fin = await call(base, 'POST', '/up/finish', {
    headers: { ...h, 'Content-Type': 'application/json' }, body: '{}',
  })
  if (fin.status !== 200) throw new Error(`/up/finish 失败：${fin.status} ${fin.text}`)
  out['/up/finish'] = fin.json

  return out
}

// ── ② 从两份文档里读 §7R ────────────────────────────────────

/** 把 §7R 拆成 { '7R.4': [那一节的行] } */
function readSection(file) {
  const lines = readFileSync(path.join(ROOT, file), 'utf8').split('\n')
  const start = lines.findIndex((l) => /^## 7R\./.test(l))
  if (start < 0) { fail(`${file}：找不到 §7R 这一章`); return null }
  let end = lines.length
  for (let k = start + 1; k < lines.length; k++) {
    if (/^## /.test(lines[k])) { end = k; break }
  }
  const secs = new Map()
  let cur = null
  for (const l of lines.slice(start, end)) {
    const m = /^### (7R\.\d+)\b/.exec(l)
    if (m) { cur = m[1]; secs.set(cur, []) } else if (cur) secs.get(cur).push(l)
  }
  if (!secs.size) fail(`${file}：§7R 里一个小节都没有`)
  return secs
}

/** 取一节里的 ```json 样例（必须**恰好一个**：多了就说明规则被破坏） */
function jsonSample(file, sec, lines) {
  const found = []
  let inFence = false
  let buf = null
  for (const l of lines) {
    if (l.trimStart().startsWith('```')) {
      if (!inFence) { buf = /^```json\s*$/.test(l.trimStart()) ? [] : null; inFence = true; continue }
      if (buf) found.push(buf.join('\n'))
      inFence = false; buf = null; continue
    }
    if (inFence && buf) buf.push(l)
  }
  if (found.length !== 1) {
    fail(`${file} §${sec}：应当**恰好**有一个 \`\`\`json 样例（成功响应），实际 ${found.length} 个`)
    return null
  }
  try { return JSON.parse(found[0]) } catch (e) {
    fail(`${file} §${sec}：json 样例解析失败 —— ${e.message}`)
    return null
  }
}

/** 端点表：第一格是方法、第二格是路径 */
function readRouteTable(file, lines) {
  const rows = []
  for (const l of lines) {
    if (!/^\s*\|.*\|\s*$/.test(l)) continue
    const cells = l.split('|').slice(1, -1).map((c) => c.trim())
    if (cells.length < 2) continue
    const method = (cells[0].match(/`([A-Z]+)`/) ?? [])[1]
    const p = (cells[1].match(/`([^`]+)`/) ?? [])[1]
    if (!method || !p) continue
    rows.push([method, p.split('?')[0]])
  }
  if (!rows.length) fail(`${file} §7R.2：端点表一行都没解析出来（表格式变了？）`)
  return rows
}

/**
 * 错误表：第一格是**码**（可能一格写两个，如 `` `BAD_CHUNK_BYTES` / `BAD_CHUNKS` ``），
 * 第二格是 HTTP 状态码。
 */
function readErrorTable(file, lines) {
  const rows = []
  for (const l of lines) {
    if (!/^\s*\|.*\|\s*$/.test(l)) continue
    const cells = l.split('|').slice(1, -1).map((c) => c.trim())
    if (cells.length < 2) continue
    const codes = [...cells[0].matchAll(/`([A-Z][A-Z_]+)`/g)].map((m) => m[1])
    const status = Number((cells[1].match(/`(\d{3})`/) ?? [])[1])
    if (!codes.length || !status) continue
    for (const c of codes) rows.push([c, status])
  }
  if (!rows.length) fail(`${file} §7R.10：错误表一行都没解析出来（表格式变了？）`)
  return rows
}

// ── ③ 形状比对 ──────────────────────────────────────────────

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)

function compareShape(rel, sec, label, docVal, realVal) {
  const dt = typeOf(docVal)
  const rt = typeOf(realVal)
  if (dt !== rt) {
    fail(`${rel} §${sec} ${label}：文档写的是 ${dt}，实现给的是 ${rt}`)
    return
  }
  if (dt === 'object') {
    const dk = Object.keys(docVal)
    const rk = Object.keys(realVal)
    const same = dk.length === rk.length && dk.every((x, i) => x === rk[i])
    if (!same) {
      fail(`${rel} §${sec} ${label} 的字段与实现不一致\n    文档：${dk.join(', ')}\n    实现：${rk.join(', ')}`)
    }
    for (const k of dk) {
      if (k in realVal) compareShape(rel, sec, `${label}.${k}`, docVal[k], realVal[k])
    }
    return
  }
  // 只往下钻"对象数组"，而且只在实响应也确实非空时 ——
  // 空数组（例如 failed: []）在成功路径上本来就取不到元素。
  if (dt === 'array' && docVal.length && typeOf(docVal[0]) === 'object' && realVal.length) {
    compareShape(rel, sec, `${label}[0]`, docVal[0], realVal[0])
  }
}

// ── 跑 ──────────────────────────────────────────────────────

let real = null
try {
  real = await traceRealFlow()
} catch (e) {
  fail(`跑真实流程时出错（判据本身没跑成）：${e?.message ?? e}`)
}

if (real) {
  // 端点表：真请求过一遍，确认文档里的每一行都真的路由到了东西
  for (const [key, err] of Object.entries(real.probe)) {
    if (err === 'NOT_FOUND') fail(`实现的端点表里有 ${key}，但请求它得到的是"没有这个接口"`)
  }
  if (!real.bogusIs404) {
    fail('反向探测失灵了：一个肯定不存在的路径没有回 NOT_FOUND —— 上面的"不是 404"判据因此不成立')
  }

  const realRoutes = RECV_ROUTE_TABLE.map(([m, p]) => `${m} ${p}`).sort()

  for (const rel of DOCS) {
    const secs = readSection(rel)
    if (!secs) continue

    // ① 端点表逐行比对
    const docRoutes = readRouteTable(rel, secs.get('7R.2') ?? []).map(([m, p]) => `${m} ${p}`).sort()
    const missing = realRoutes.filter((r) => !docRoutes.includes(r))
    const extra = docRoutes.filter((r) => !realRoutes.includes(r))
    if (missing.length) fail(`${rel} §7R.2：端点表少了这些端点 —— ${missing.join(', ')}`)
    if (extra.length) fail(`${rel} §7R.2：端点表里有实现中不存在的端点 —— ${extra.join(', ')}`)

    // ② 错误表：每一行的状态码必须与实现一致，且接收模式独有的码**一个都不能漏**
    const errRows = readErrorTable(rel, secs.get('7R.10') ?? [])
    for (const [code, status] of errRows) {
      const want = expectedStatus(code)
      if (status !== want) {
        fail(`${rel} §7R.10：${code} 写的状态码是 ${status}，实现是 ${want}`)
      }
    }
    const documentedCodes = new Set(errRows.map(([c]) => c))
    const undoc = Object.keys(RECV_ERROR_STATUS).filter((c) => !documentedCodes.has(c))
    if (undoc.length) {
      fail(`${rel} §7R.10：错误表里少了接收模式独有的这些码 —— ${undoc.join(', ')}` +
        '（实现会发出来，文档里没有，客户端就只能猜）')
    }

    // ② 每个端点的成功响应形状
    const samples = {}
    for (const [sec, endpoint] of Object.entries(SECTION_OF)) {
      const sample = jsonSample(rel, sec, secs.get(sec) ?? [])
      if (!sample) continue
      samples[sec] = sample
      compareShape(rel, sec, endpoint, sample, real[endpoint])
    }

    // ③ 几个"有意义的固定值"（不是会话数据）单独钉住
    const caps = samples['7R.4']?.limits ?? {}
    for (const k of ['maxFiles', 'maxBytes', 'maxChunkBytes', 'maxPlainChunkBytes']) {
      if (k in caps && caps[k] !== real['/up/session'].limits[k]) {
        fail(`${rel} §7R.4 limits.${k}：文档写 ${caps[k]}，实现给 ${real['/up/session'].limits[k]}`)
      }
    }
    if (samples['7R.4']?.suite && samples['7R.4'].suite !== real['/up/session'].suite) {
      fail(`${rel} §7R.4 suite：文档写 ${samples['7R.4'].suite}，实现给 ${real['/up/session'].suite}`)
    }
    const docProfiles = samples['7R.4']?.macProfiles
    if (Array.isArray(docProfiles) &&
        JSON.stringify(docProfiles) !== JSON.stringify(real['/up/session'].macProfiles)) {
      fail(`${rel} §7R.4 macProfiles：文档写 ${JSON.stringify(docProfiles)}，` +
        `实现给 ${JSON.stringify(real['/up/session'].macProfiles)}`)
    }
    const docSuffix = samples['7R.6']?.partSuffix
    if (docSuffix !== undefined && docSuffix !== real['/up/manifest'].partSuffix) {
      fail(`${rel} §7R.6 partSuffix：文档写 ${docSuffix}，实现给 ${real['/up/manifest'].partSuffix}`)
    }
    if (real['/up/manifest'].partSuffix !== PART_SUFFIX) {
      fail(`实现自己不一致：/up/manifest 报的 partSuffix 与导出的 PART_SUFFIX 不同`)
    }
  }
}

// 收尾：关服务、清临时目录（不留东西）
try { await server?.stop() } catch { /* 尽力 */ }
cleanupTempDirs()

if (bad) {
  console.error(`\n${bad} 处 §7R 与实现不一致`)
  process.exit(1)
}
console.log(`✓ PROTOCOL.md §7R 与实现一致（中英文各 1 份，` +
  `${RECV_ROUTE_TABLE.length} 个端点、6 个响应样例、${Object.keys(RECV_ERROR_STATUS).length} 个独有错误码逐条比对）`)
