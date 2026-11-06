/**
 * ⭐ P0-2 回归：TransferServer 的共享分块缓冲区并发竞态
 * =====================================================
 *
 * 旧实现把"读盘 → 加密 → 清零"全部作用在**实例级单例** `this._buf` 上，而 `_handle`
 * 对每个请求独立异步执行 —— 接收页默认就是 6 并发预取（web/receiver.html 的 PREFETCH_MAX）。
 * 两个请求同时读/写同一块内存，A 的 `fill(0)` 还会清掉 B 刚读到的数据。
 * 现象是 GCM 解密"成功"（tag 是对错误内存内容算的），但明文与源文件不符，接收端
 * 报"第 N 块校验失败"，多块文件的默认传输路径高概率失败。
 *
 * 这里用真实 HTTP 栈 + 真实握手 + 真实 `openChunk` 解密，6 个请求同时发出，
 * 逐块与磁盘原文比对。修复前这条用例应当失败（报告实测 6 并发里 4~6 块内容错误）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TransferServer } from '../src/server.js'
import { Session } from '../src/session.js'
import {
  PARAMS, deriveKeys, deriveVerifier, openChunk, receiverMac, sealManifest,
} from '../src/suite/flicker1.js'

const PASSWORD = 'concurrency-test-pass'
const CHUNK = 4096          // 小一点，保证多块同时在路上（默认块大小是 1 MiB）

/**
 * 造一个真实会话 + 两个各 3 块的文件 + 一个明文 HTTP 的 TransferServer。
 * 明文 HTTP 只用于测试（生产路径走 HTTPS，路由与令牌语义完全一样）。
 */
async function makeSetup() {
  const dir = await mkdtemp(path.join(tmpdir(), 'flicker-concurrency-'))
  await mkdir(dir, { recursive: true })

  const specs = [
    { rel: 'a.bin', data: randomBytes(3 * CHUNK) },          // 正好 3 块
    { rel: 'b.bin', data: randomBytes(2 * CHUNK + 1000) },   // 3 块，尾块不齐
  ]
  const files = []
  let firstChunk = 0
  for (const [i, s] of specs.entries()) {
    const absPath = path.join(dir, s.rel)
    await writeFile(absPath, s.data)
    const chunks = Math.ceil(s.data.length / CHUNK)
    files.push({
      kind: 'file', name: s.rel, rel: s.rel, size: s.data.length, chunks,
      chunkBytes: CHUNK, index: i, firstChunk, absPath,
      // 本用例只走 /api/chunk，不需要真的哈希；字段留空字符串即可
      sha256: '', chunkHashes: [],
    })
    firstChunk += chunks
  }

  const salt = randomBytes(PARAMS.saltBytes)
  const verifier = deriveVerifier(PASSWORD, salt)
  const keys = deriveKeys(verifier)
  const wire = {
    v: 1, suite: 'FLICKER/1',
    files: files.map((f) => ({ ...f })),
    totalBytes: specs.reduce((a, s) => a + s.data.length, 0),
    totalChunks: firstChunk,
  }
  const enc = sealManifest(keys.enc, Buffer.from(JSON.stringify(wire), 'utf8'))
  const session = new Session({
    salt, verifier,
    encManifest: enc.ct, manifestIv: enc.iv, manifestTag: enc.tag,
  })
  const srv = new TransferServer({
    session,
    manifest: { ...wire, files },
    receiverHtml: '<!doctype html><meta charset="utf-8"><h1>接收页</h1>',
    onEvent: () => {},
  })
  const port = await srv.listen({ host: '127.0.0.1', port: 0 })
  return { dir, specs, files, keys, session, srv, base: `http://127.0.0.1:${port}` }
}

/** 登录（页面 → cookie → 挑战 → 应答），返回 SID；顺带断言 cookie 属性 */
async function handshake({ base, session, keys }) {
  const token = session.token
  const page = await fetch(`${base}/?k=${encodeURIComponent(token)}`)
  assert.equal(page.status, 200, '页面加载应当成功')
  const setCookie = page.headers.get('set-cookie') ?? ''
  assert.match(setCookie, /flicker_session=/, '页面加载必须种下会话 cookie')
  assert.match(setCookie, /HttpOnly/i)
  assert.match(setCookie, /SameSite=Strict/i)
  // 明文 HTTP 分支**不能**加 Secure —— 否则测试客户端根本不会回传 cookie
  assert.ok(!/;\s*Secure/i.test(setCookie), '明文 HTTP 测试下 cookie 不应带 Secure')
  const cookie = setCookie.split(';')[0]
  await page.text()

  const infoRes = await fetch(`${base}/api/session`, { headers: { Cookie: cookie } })
  assert.equal(infoRes.status, 200, '带正确 cookie 应当拿到会话参数')
  await infoRes.text()

  const startRes = await fetch(`${base}/api/auth/start`, {
    method: 'POST', headers: { Cookie: cookie },
  })
  assert.equal(startRes.status, 200)
  const start = await startRes.json()
  const challenge = Buffer.from(start.challenge, 'base64')
  const mac = receiverMac(keys.auth, challenge, { profile: 'v2' }).toString('base64')
  const finRes = await fetch(`${base}/api/auth/finish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge: start.challenge, mac, macProfile: 'v2' }),
  })
  assert.equal(finRes.status, 200, '正确密码应当通过握手')
  return (await finRes.json()).sid
}

/** 全局块序号 → (文件下标, 文件内块号, 明文长度) */
function locate(files, seq) {
  for (let fi = 0; fi < files.length; fi++) {
    const f = files[fi]
    if (seq >= f.firstChunk && seq < f.firstChunk + f.chunks) {
      const ci = seq - f.firstChunk
      return { fi, ci, plainLen: Math.min(f.chunkBytes, f.size - ci * f.chunkBytes) }
    }
  }
  throw new Error('块序号无法定位: ' + seq)
}

test('⭐ P0-2：两个文件各 3 块 + 6 个并发请求，逐块解密必须与源文件逐一相等',
  { timeout: 60_000 }, async () => {
    const made = await makeSetup()
    try {
      const sid = await handshake(made)
      const totalChunks = made.files.reduce((a, f) => a + f.chunks, 0)
      assert.equal(totalChunks, 6, '（前提）两个文件各 3 块，共 6 个请求')

      // 跑 3 轮：并发竞态是概率性的，一轮 6 个请求有时会"碰巧全对"，
      // 多跑几轮才能稳定地把它钉住（旧实现每轮都会错好几块）。
      for (let round = 1; round <= 3; round++) {
        const results = await Promise.all(
          Array.from({ length: totalChunks }, (_, seq) => (async () => {
            const r = await fetch(
              `${made.base}/api/chunk?seq=${seq}&sid=${encodeURIComponent(sid)}`)
            assert.equal(r.status, 200, `第 ${round} 轮块 ${seq} 请求失败`)
            const ct = Buffer.from(await r.arrayBuffer())
            const tag = Buffer.from(r.headers.get('x-flicker-tag') ?? '', 'base64')
            const { fi, ci, plainLen } = locate(made.files, seq)
            const f = made.files[fi]
            const plain = openChunk(made.keys.enc, fi, ci, f.chunks, ct, tag, plainLen)
            return { seq, fi, ci, plain }
          })()),
        )

        for (const got of results) {
          const f = made.files[got.fi]
          const want = made.specs[got.fi].data.subarray(
            got.ci * f.chunkBytes, Math.min((got.ci + 1) * f.chunkBytes, f.size))
          assert.equal(got.plain.length, want.length,
            `第 ${round} 轮 seq=${got.seq}（文件 ${got.fi} 第 ${got.ci} 块）长度不符`)
          assert.equal(Buffer.compare(got.plain, want), 0,
            `第 ${round} 轮 seq=${got.seq}（文件 ${got.fi} 第 ${got.ci} 块）解密内容与磁盘原文不一致 —— ` +
            '共享缓冲被并发请求写坏了（P0-2）')
        }
      }
    } finally {
      await made.srv.shutdown()
      await rm(made.dir, { recursive: true, force: true })
    }
  })
