/**
 * `PROTOCOL.md` §7（发起方 HTTPS 服务）与**实现**的一致性检查
 * ==========================================================
 *
 * ── 为什么要有这一条 ──
 * §7.1 的端点表**整张写错过**，而且错了很久没人发现：
 *   · 路径少了 `/api/` 前缀（写 `/session`，实际 `/api/session`）
 *   · `/auth` 实际是两个端点（`start` / `finish`）
 *   · `/api/manifest` 与 `/api/health` 根本没进表
 *   · §7.2 说 SID 走 `X-Flicker-Sid` 请求头，而发起方服务实际读的是 `?sid=` 查询参数
 *   · §7.3 说的响应头（`X-Flicker-Seq` / `-Len`）、`429` 令牌桶、`E_BAD_SEQ` 那套码，一个都不存在
 *
 * 这些错误**本机测试全绿**（测试测的是实现），只有照着文档写客户端的人会撞上 ——
 * 而他撞到的是 404 与读不到的头，会先怀疑自己。所以判据必须是机器检查。
 *
 * ── 怎么查（三条，都不靠手抄一份清单）──
 *   ① **端点集合从源码抠**：路由器是一串 `if (p === '...')`，正则扫 `src/server.js`
 *      就得到"实现里真实存在哪些路径"。文档多写/漏写都会失败。
 *   ② **真的请求一遍**：起一个明文 HTTP 的 `TransferServer`（`src/server.js` 里
 *      明确支持这个测试模式），逐个请求文档里的每一行，确认不是"没有这个接口"；
 *      再用一个肯定不存在的路径反向确认这个探测器有效。
 *   ③ **§7.2 与 §7.3 按行为验**：用真的会话拿到 `sid`，确认 `?sid=` 能过、
 *      错的 `sid` 会被 401 拒；再取一块真的密文，把**文档里写的 `X-Flicker-*` 头**
 *      与真实响应头比集合；最后把文档那张状态码表与"真的能复现出来的状态码"比集合。
 *
 * ⚠️ 刻意**不**比 §7.1 表里的"方法"列：服务端根本不校验 HTTP 方法（只看路径），
 *    表里那列写的是"客户端应当用的方法"，不是实现的约束。这一点文档里已如实说明。
 *
 * 中英文都查：只查一边的话，另一边照样能漂。
 *
 * 用法：node gen/check-send-protocol-doc.mjs
 */
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Session } from '../src/session.js'
import { TransferServer } from '../src/server.js'
import { deriveVerifier, deriveKeys, receiverMac, sealManifest, PARAMS } from '../src/suite/flicker1.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DOCS = ['中文文档/PROTOCOL.md', 'docs/PROTOCOL.md']
const PASSWORD = 'k7m-3fq'

/**
 * 表里**不必**单列、但文档正文必须提到的路径。
 * 它们是别名或浏览器杂项，不承载会话 —— 所以列进表反而会误导。
 */
const EXEMPT = ['/index.html', '/favicon.ico']

let bad = 0
const fail = (m) => { console.error(`✗ ${m}`); bad++ }

// ── ① 实现里真实存在的路径（从源码抠，不手抄）─────────────────

function pathsInSource() {
  const src = readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8')
  const found = [...src.matchAll(/p === '([^']+)'/g)].map((m) => m[1])
  if (!found.length) {
    throw new Error('在 src/server.js 里没找到任何 `p === \'...\'` —— 路由写法变了？这份判据要跟着改')
  }
  return [...new Set(found)]
}

// ── 文档解析 ────────────────────────────────────────────────

/** 把某个 `### 7.x` 小节切出来（到下一个 `###` 或 `##` 为止） */
function section(file, id) {
  const lines = readFileSync(path.join(ROOT, file), 'utf8').split('\n')
  const esc = id.replace(/\./g, '\\.')
  const start = lines.findIndex((l) => new RegExp(`^### ${esc}\\b`).test(l))
  if (start < 0) { fail(`${file}：找不到 §${id}`); return null }
  let end = lines.length
  for (let k = start + 1; k < lines.length; k++) {
    if (/^#{2,3} /.test(lines[k])) { end = k; break }
  }
  return lines.slice(start, end)
}

/** §7.1 端点表 → [[method, path]]（路径截掉查询串） */
function documentedRoutes(file, lines) {
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
  if (!rows.length) fail(`${file} §7.1：端点表一行都没解析出来（表格式变了？）`)
  return rows
}

/** §7.3 的 ```http 围栏里列出的 `X-Flicker-*` 头名（小写） */
function documentedChunkHeaders(file, lines) {
  const inFence = []
  let on = false
  for (const l of lines) {
    if (l.trimStart().startsWith('```')) { on = !on; continue }
    if (on) inFence.push(l)
  }
  const names = new Set()
  for (const l of inFence) {
    for (const m of l.matchAll(/(X-Flicker-[A-Za-z]+)\s*:/gi)) names.add(m[1].toLowerCase())
  }
  if (!names.size) fail(`${file} §7.3：没解析出任何 \`X-Flicker-*\` 响应头（围栏格式变了？）`)
  return names
}

/** §7.3 状态码表里写的状态码 */
function documentedStatuses(file, lines) {
  const out = new Set()
  for (const l of lines) {
    if (!/^\s*\|.*\|\s*$/.test(l)) continue
    const first = l.split('|')[1] ?? ''
    const m = first.match(/`(\d{3})`/)
    if (m) out.add(Number(m[1]))
  }
  if (!out.size) fail(`${file} §7.3：状态码表一行都没解析出来`)
  return out
}

// ── ③ 起一个真的服务，按文档请求一遍 ────────────────────────

function http(port, method, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    // POST 显式带 Content-Length: 0 —— 否则服务端可能把请求体当成"还没结束"
    const h = method === 'POST' ? { 'Content-Length': '0', ...headers } : headers
    const r = request({ host: '127.0.0.1', port, method, path: pathname, headers: h, timeout: 5000 }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try { json = JSON.parse(text) } catch { /* 非 JSON（页面/纯文本） */ }
        resolve({ status: res.statusCode, headers: res.headers, json, text })
      })
    })
    r.on('timeout', () => r.destroy(new Error('超时')))
    r.on('error', reject)
    r.end()
  })
}

/**
 * 探一次，**永不抛**：网络层出错（连接被重置之类）在判据里也算一种结果。
 * 让判据自己崩掉是最糟的失败方式 —— 那样它连"哪里不对"都说不出来。
 */
async function probe(port, method, pathname, headers = {}) {
  try {
    return await http(port, method, pathname, headers)
  } catch (e) {
    return { status: null, headers: {}, json: null, text: '', error: e?.message ?? String(e) }
  }
}

/**
 * 起一个真的 `TransferServer`（**明文 HTTP** —— `src/server.js` 明确支持这个测试模式），
 * 并真的走一遍握手拿到 `sid`。
 *
 * ⚠️ 这里**不**负责关服务：关早了，后面所有请求都会 `ECONNREFUSED`（第一版就是这么错的 ——
 *    `finally` 在 `return` 时就把服务关了）。调用方拿到句柄后自己决定什么时候 `shutdown()`。
 */
async function startRealServer() {
  const salt = randomBytes(PARAMS.saltBytes)
  const verifier = deriveVerifier(PASSWORD, salt)
  const keys = deriveKeys(verifier)

  // 两个文件：一个从内存给（赠品包那条路），一个指向不存在的磁盘路径（用来复现 500）
  const buf = Buffer.alloc(1024, 7)
  const chunkBytes = Math.max(1024, PARAMS.chunkBytes)
  const wireFiles = [
    { index: 0, rel: 'mem.bin', size: buf.length, chunks: 1, chunkBytes, sha256: 'x', chunkHashes: ['y'] },
    { index: 1, rel: 'gone.bin', size: 10, chunks: 1, chunkBytes, sha256: 'x', chunkHashes: ['y'] },
  ]
  const sealed = sealManifest(keys.enc, Buffer.from(JSON.stringify({ files: wireFiles }), 'utf8'))
  const session = new Session({
    salt, verifier, encManifest: sealed.ct, manifestIv: sealed.iv, manifestTag: sealed.tag,
  })
  const manifest = {
    files: wireFiles.map((f, i) => ({
      ...f,
      firstChunk: i,
      ...(i === 0 ? { _bytes: buf } : { absPath: path.join(ROOT, 'definitely-not-here.bin') }),
    })),
  }
  const srv = new TransferServer({ session, manifest, receiverHtml: '<!doctype html>ok' })
  const port = await srv.listen({ host: '127.0.0.1', port: 0 })

  // 真的走一遍握手拿到 sid（服务端是 sender，所以它验 receiverMac）
  const a = session.startAuth()
  const challenge = Buffer.from(a.challenge, 'base64')
  const mac = receiverMac(keys.auth, challenge, { profile: 'v2' }).toString('base64')
  const out = session.finishAuth({ mac, challenge: a.challenge, macProfile: 'v2' })

  return { srv, port, sid: out.sid, token: session.token }
}

/** 把需要"按行为验"的那几次请求收下来 */
async function collectProbes(ctx) {
  const { port, sid, token } = ctx
  return {
    bogus: await probe(port, 'GET', '/definitely-not-a-route'),
    chunkOk: await probe(port, 'GET', `/api/chunk?seq=0&sid=${encodeURIComponent(sid)}`),
    chunkBadSid: await probe(port, 'GET', '/api/chunk?seq=0&sid=wrong'),
    chunkRange: await probe(port, 'GET', `/api/chunk?seq=99&sid=${encodeURIComponent(sid)}`),
    chunkMissing: await probe(port, 'GET', `/api/chunk?seq=1&sid=${encodeURIComponent(sid)}`),
    page: await probe(port, 'GET', `/?k=${encodeURIComponent(token)}`),
  }
}

// ── 跑 ──────────────────────────────────────────────────────

let ctx = null
try {
  ctx = await startRealServer()
} catch (e) {
  fail(`起真服务时出错（判据本身没跑成）：${e?.message ?? e}`)
}

if (ctx) {
  try {
    await runChecks(ctx)
  } catch (e) {
    fail(`判据跑到一半出错：${e?.message ?? e}`)
  } finally {
    // 收尾：关服务。**在所有请求之后**才关（关早了后面全是 ECONNREFUSED）
    await ctx.srv.shutdown().catch(() => {})
  }
}

async function runChecks(ctx) {
  const res = await collectProbes(ctx)
  const sourcePaths = pathsInSource()

  // 反向确认"不是 404"这个探测器是有效的
  if (res.bogus.json?.error !== 'NOT_FOUND') {
    fail('反向探测失灵了：一个肯定不存在的路径没有回 NOT_FOUND —— 下面"不是 404"的判据因此不成立')
  }

  for (const file of DOCS) {
    const sec71 = section(file, '7.1')
    const sec73 = section(file, '7.3')
    if (!sec71 || !sec73) continue

    // ① 端点集合：文档 vs 源码（两个方向都查）
    const docRoutes = documentedRoutes(file, sec71)
    const docPaths = new Set(docRoutes.map(([, p]) => p))
    const documentedText = readFileSync(path.join(ROOT, file), 'utf8')
    for (const p of sourcePaths) {
      if (docPaths.has(p)) continue
      if (EXEMPT.includes(p)) {
        if (!documentedText.includes(p)) {
          fail(`${file}：实现里有 ${p}，它不在端点表里（可以），但正文也没提到它 —— 读者会以为不存在`)
        }
        continue
      }
      fail(`${file} §7.1：端点表少了实现里真实存在的路径 —— ${p}`)
    }
    for (const p of docPaths) {
      if (!sourcePaths.includes(p)) {
        fail(`${file} §7.1：端点表里有实现中不存在的路径 —— ${p}`)
      }
    }

    // ② 逐条真的请求一遍
    for (const [method, p] of docRoutes) {
      const r = await probe(ctx.port, method, p)
      if (r.error) {
        fail(`${file} §7.1 的 ${method} ${p}：请求直接失败了（${r.error}）—— 端点存在吗？`)
        continue
      }
      if (r.json?.error === 'NOT_FOUND') {
        fail(`${file} §7.1 的 ${method} ${p}：实现里没有这个端点（路由回了"没有这个接口"）`)
      }
    }

    // ③ §7.2：SID 的传递方式 —— 既按行为验，也要求文档**说对**
    //    （行为对、文档写错，正是这次发现的问题：实现用 `?sid=`，文档写的是请求头）
    const t72 = (section(file, '7.2') ?? []).join('\n')
    if (!t72.includes('?sid=')) {
      fail(`${file} §7.2：没写出发起方服务实际用的传递方式 —— 查询参数 \`?sid=\``)
    }
    if (!t72.includes('X-Flicker-Sid')) {
      fail(`${file} §7.2：没写明接收方服务用的请求头 \`X-Flicker-Sid\``)
    }
    if (res.chunkOk.status !== 200) {
      fail(`${file} §7.2：\`?sid=\` 应当能通过认证，实际 ${res.chunkOk.status} ` +
        `${res.chunkOk.json?.error ?? ''} —— 文档里 SID 的传递方式与实现不一致`)
    }
    if (res.chunkBadSid.status !== 401 || res.chunkBadSid.json?.error !== 'BAD_SID') {
      fail(`${file} §7.2：错的 sid 应当被 401 BAD_SID 拒绝，实际 ` +
        `${res.chunkBadSid.status} ${res.chunkBadSid.json?.error ?? ''}`)
    }

    // ④ §7.3：文档写的响应头 vs 真响应的头
    const docHeaders = documentedChunkHeaders(file, sec73)
    const realHeaders = new Set(Object.keys(res.chunkOk.headers)
      .filter((h) => h.toLowerCase().startsWith('x-flicker-')))
    const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x))
    if (!sameSet(docHeaders, realHeaders)) {
      fail(`${file} §7.3：\`X-Flicker-*\` 响应头与实现不一致\n` +
        `    文档：${[...docHeaders].sort().join(', ')}\n` +
        `    实现：${[...realHeaders].sort().join(', ')}`)
    }
    const cc = String(res.chunkOk.headers['cache-control'] ?? '')
    if (!/no-store/.test(cc)) {
      fail(`${file} §7.3：成功响应里应当有 \`Cache-Control: no-store\`（安全要求），实际 "${cc}"`)
    }
    if (res.chunkOk.headers['content-length'] === undefined) {
      fail(`${file} §7.3：成功响应里应当有 \`Content-Length\``)
    }

    // ⑤ §7.3：文档那张状态码表，与"真的能复现出来的状态码"比集合
    const docStatuses = documentedStatuses(file, sec73)
    const realStatuses = new Set([
      res.chunkOk.status, res.chunkBadSid.status,
      res.chunkRange.status, res.chunkMissing.status,
    ].filter((s) => s !== undefined))
    const missingDoc = [...realStatuses].filter((s) => !docStatuses.has(s))
    const missingReal = [...docStatuses].filter((s) => !realStatuses.has(s))
    if (missingDoc.length) {
      fail(`${file} §7.3：实现会回这些状态码，文档表里没有 —— ${missingDoc.join(', ')}`)
    }
    if (missingReal.length) {
      fail(`${file} §7.3：文档表里写了这些状态码，但判据复现不出来 —— ${missingReal.join(', ')}` +
        '（要么它不会发生、要么判据该补一条复现路径）')
    }
  }
}

if (bad) {
  console.error(`\n${bad} 处 §7 与实现不一致`)
  process.exit(1)
}
console.log('✓ PROTOCOL.md §7 与实现一致（中英文各 1 份：端点集合按源码抠、逐条真请求、' +
  'SID 传递与响应头/状态码按行为验）')
