/**
 * 扮演手机：把文件"上传"给 `flicker recv`
 * ==========================================
 *
 * 这是设计草稿 M1 的验收工具（`_lab/设计草稿-手机发送端.md` §六）：
 * 在真正的手机页面（M2）做出来之前，用它证明**协议这一层是通的**。
 *
 * ⚠️ 它**不是**另写一套协议：清单加密、分块加密、MAC 全部调用 `src/suite/flicker1.js`
 *    里与发送端、接收端页面完全相同的那几个函数。所以它能跑通，说明的是真协议能跑通；
 *    如果它自己另实现一份，那只能证明"我写的两份东西碰巧一样"。
 *
 * 用法：
 *   node _lab/sim-phone.mjs --url=https://127.0.0.1:PORT --token=... --password=xxx --dir=<要发的目录或文件>
 *   node _lab/sim-phone.mjs --from-ready=<文件>     从 `flicker recv --machine` 的输出里读 URL/令牌
 *   node _lab/sim-phone.mjs ... --corrupt            故意改坏一块，验证接收端会拒绝
 *   node _lab/sim-phone.mjs ... --ca=<ca.cer>        用 `--machine-cert` 导出的 CA 校验（推荐）
 *   不加 --ca 时用 `rejectUnauthorized:false` —— 只在本机自测时接受
 *
 * 退出码：0 全部成功；1 有文件失败；2 用法/连接错误。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import path from 'node:path'
import {
  deriveVerifier, deriveKeys, senderMac, receiverMac,
  sealManifest, sealChunk, PARAMS,
} from '../src/suite/flicker1.js'

// ── 参数 ────────────────────────────────────────────────────
const args = {}
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/)
  if (m) args[m[1]] = m[2] ?? true
}
const from = (list) => list.map((p) => path.resolve(p))

function resolveTarget() {
  if (args['from-ready']) {
    const txt = readFileSync(args['from-ready'], 'utf8')
    const m = txt.match(/__READY__ (\S+) (\S+)/)
    if (!m) throw new Error(`${args['from-ready']} 里没有 __READY__ 行（用 flicker recv --machine 跑出来的？）`)
    return { base: m[1], token: m[2] }
  }
  if (!args.url) throw new Error('要给 --url=https://主机:端口（或 --from-ready=文件）')
  const u = new URL(args.url)
  const token = args.token ?? u.searchParams.get('k') ?? ''
  return { base: `${u.protocol}//${u.host}`, token }
}

/** 收集要发的文件：给目录就取目录下的文件（不递归 —— 手机也只能选文件） */
function collect(inputs) {
  const out = []
  for (const p of inputs) {
    const st = statSync(p)
    if (st.isDirectory()) {
      for (const n of readdirSync(p)) {
        const f = path.join(p, n)
        if (statSync(f).isFile()) out.push(f)
      }
    } else out.push(p)
  }
  return out
}

/** 极简请求包装：只用 node:http(s)，因为要能指定 CA（fetch 不接受自定义 CA） */
function makeClient({ base, ca }) {
  const secure = base.startsWith('https:')
  const doRequest = secure ? httpsRequest : httpRequest
  return function req(method, pathAndQuery, { headers = {}, body } = {}) {
    const u = new URL(base)
    return new Promise((resolve, reject) => {
      const r = doRequest({
        method, host: u.hostname, port: u.port || (secure ? 443 : 80),
        path: pathAndQuery, headers,
        ...(secure ? (ca ? { ca } : { rejectUnauthorized: false }) : {}),
      }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const buf = Buffer.concat(chunks)
          let json = null
          try { json = JSON.parse(buf.toString('utf8')) } catch { /* 非 JSON 就留 null */ }
          resolve({ status: res.statusCode, json, text: buf.toString('utf8'), buf })
        })
      })
      r.on('error', reject)
      if (body !== undefined) r.write(body)
      r.end()
    })
  }
}

const b64 = (b) => Buffer.from(b).toString('base64')

async function main() {
  const { base, token } = resolveTarget()
  const password = String(args.password ?? '')
  if (!password) throw new Error('要给 --password=（电脑屏幕上那个一次性密码）')
  const files = collect(from(String(args.dir ?? args._ ?? '').split(',').filter(Boolean)))
  if (!files.length) throw new Error('没有要发的文件：给 --dir=<目录或文件>')
  const ca = args.ca ? readFileSync(args.ca, 'utf8') : null
  const req = makeClient({ base, ca })

  console.log(`→ ${base}`)
  console.log(`  要发 ${files.length} 个文件`)

  // ── 1. 建立会话（拿盐与挑战）─────────────────────────────
  const s = await req('POST', `/up/session?k=${encodeURIComponent(token)}`)
  if (s.status !== 200) throw new Error(`建立会话失败：${s.status} ${s.text}`)
  const salt = Buffer.from(s.json.salt, 'base64')
  const challenge = Buffer.from(String(s.json.challenge), 'base64')
  const offered = s.json.macProfiles ?? []
  const profile = offered.includes('v2') ? 'v2' : 'v1'
  // 块大小按**电脑报价的明文上限**来（不自己减那个 17 字节开销：
  // 那是实现细节，客户端猜错的表现是"清单被拒，一块都没发出去"）
  const lim = s.json.limits || {}
  const plainMax = lim.maxPlainChunkBytes || (lim.maxChunkBytes ? lim.maxChunkBytes - 17 : PARAMS.chunkBytes)
  const chunkBytes = Math.min(2 * PARAMS.chunkBytes, plainMax)
  console.log(`  套件 ${s.json.suite} · 握手构造 ${profile} · 块 ${chunkBytes} 字节 · 上限 ${JSON.stringify(lim)}`)

  // ── 2. 核对密码（双方各自算 MAC，密码本身不过网）──────────
  const keys = deriveKeys(deriveVerifier(password, salt))
  const mac = senderMac(keys.auth, challenge, { profile })
  const a = await req('POST', '/up/auth', {
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.from(JSON.stringify({ mac: b64(mac), challenge: b64(challenge), macProfile: profile })),
  })
  if (a.status !== 200) throw new Error(`密码核对失败：${a.status} ${a.text}`)
  // 手机也必须验电脑：它得证明自己也知道密码（否则可能是钓鱼页面）
  const expected = receiverMac(keys.auth, challenge, { profile })
  if (a.json.mac !== b64(expected)) throw new Error('电脑回送的应答不对 —— 对面不知道密码？')
  const sid = a.json.sid
  console.log(`  ✓ 双向认证通过（收到的应答已验证）`)

  // ── 3. 清单（加密）──────────────────────────────────────
  const wire = { files: [], totalBytes: 0, totalChunks: 0 }
  const metas = files.map((p, i) => {
    const bytes = readFileSync(p)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const chunks = Math.max(1, Math.ceil(bytes.length / chunkBytes))
    wire.files.push({
      index: i, rel: path.basename(p), size: bytes.length, chunks,
      chunkBytes, sha256,
    })
    wire.totalBytes += bytes.length
    wire.totalChunks += chunks
    return { rel: path.basename(p), bytes, chunks }
  })
  const sealedM = sealManifest(keys.enc, Buffer.from(JSON.stringify(wire), 'utf8'))
  const m = await req('POST', '/up/manifest', {
    headers: { 'Content-Type': 'application/octet-stream', 'X-Flicker-Sid': sid },
    body: Buffer.concat([sealedM.iv, sealedM.tag, sealedM.ct]),
  })
  if (m.status !== 200) throw new Error(`清单被拒：${m.status} ${m.text}`)
  // ⚠️ 只发**服务端接受了的**那些文件：被跳过的（用户选了"跳过"）在服务端没有条目，
  //    硬发它的块会得到 404 BAD_FILE_INDEX —— 第一版就是这么错的，
  //    而报错信息（"没有这个文件下标"）听起来像协议问题，其实是客户端没看清单答复。
  const acceptedIdx = new Set(m.json.accepted.map((f) => f.index))
  console.log(`  ✓ 清单已接受：${m.json.accepted.map((f) => f.rel).join(', ') || '（没有文件）'}` +
    `${m.json.skipped?.length ? `（跳过 ${m.json.skipped.length} 个）` : ''}`)

  // ── 4. 分块（逐块加密 + 幂等重发一次）────────────────────
  let sent = 0
  const t0 = Date.now()
  for (let fi = 0; fi < metas.length; fi++) {
    if (!acceptedIdx.has(fi)) continue
    const f = metas[fi]
    for (let ci = 0; ci < f.chunks; ci++) {
      const start = ci * chunkBytes
      const plain = f.bytes.subarray(start, Math.min(start + chunkBytes, f.bytes.length))
      const { ct, tag } = sealChunk(keys.enc, fi, ci, f.chunks, plain)
      let body = Buffer.concat([tag, ct])
      const corrupting = args.corrupt && fi === 0 && ci === 0
      if (corrupting) {
        body = Buffer.from(body)
        body[body.length - 1] ^= 0xff
      }
      const r = await req('PUT', `/up/chunk?f=${fi}&c=${ci}`, {
        headers: { 'Content-Type': 'application/octet-stream', 'X-Flicker-Sid': sid },
        body,
      })
      if (corrupting) {
        // 这条是**反向验证**：改坏一个字节必须被拒（否则加密等于装饰）。
        // 验完就结束 —— 那块数据本来就没被接收，继续收尾只会得到 409（缺块）。
        const ok = r.status >= 400
        console.log(`  ${ok ? '✓' : '✗'} 故意改坏第 1 块 → 接收端 ${r.status} ${r.json?.error ?? ''}` +
          `${ok ? '（正确拒绝）' : '（**没有拒绝，这是缺陷**）'}`)
        return ok ? 0 : 1
      }
      if (r.status !== 200) throw new Error(`第 ${fi}/${ci} 块失败：${r.status} ${r.text}`)
      sent++
      if (args.echo && sent % 20 === 0) {
        const st = await req('GET', '/up/status', { headers: { 'X-Flicker-Sid': sid } })
        console.log(`    ${st.json.receivedChunks}/${st.json.totalChunks} 块`)
      }
    }
  }
  const dt = (Date.now() - t0) / 1000
  const bytes = metas.reduce((a, f) => a + f.bytes.length, 0)
  console.log(`  ✓ ${sent} 块已上传 · ${(bytes / 1048576).toFixed(1)} MiB · ` +
    `${(bytes / 1048576 / Math.max(dt, 0.001)).toFixed(1)} MiB/s`)

  // ── 5. 收尾（电脑在这里校验整文件摘要，通过才改名定稿）────
  const fin = await req('POST', '/up/finish', {
    headers: { 'Content-Type': 'application/json', 'X-Flicker-Sid': sid }, body: Buffer.from('{}'),
  })
  if (fin.status !== 200) throw new Error(`收尾失败：${fin.status} ${fin.text}`)
  console.log(`  ✓ 定稿 ${fin.json.done.length} 个` +
    `${fin.json.failed.length ? ` · 失败 ${fin.json.failed.length}（${fin.json.failed.map((x) => x.rel).join(',')}）` : ''}`)
  for (const d of fin.json.done) {
    console.log(`      ${d.rel}${d.renamedFrom ? `（电脑上原来有同名的，已存为这个名字）` : ''} · ${d.bytes} 字节`)
  }
  return fin.json.failed.length ? 1 : 0
}

main()
  .then((code) => { process.exitCode = code })
  .catch((e) => {
    console.error(`✗ ${e?.message ?? e}`)
    if (process.env.FLICKER_DEBUG) console.error(e?.stack ?? '')
    process.exitCode = 2
  })
