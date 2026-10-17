/**
 * 就绪探测 = 约束 1（证书自检）的最终判据
 * ======================================
 *
 * 这是**真实 TLS 握手**那一层：起一个真的 HTTPS 服务，然后拿会话 CA 去连它。
 * 浏览器要走的每一步（验签名链、验主机名、验有效期）都在这里走一遍，
 * 而且连的是**真实运行中的服务**，不是另起的临时服务器。
 *
 * 这个文件锁住三件事，每一件都对应一种"看起来在验证、其实没有验证"的失败：
 *
 *   ① **不给 CA 时必须拒绝**，不能"能连上就算就绪"。
 *      曾经的写法是 `rejectUnauthorized: ca !== undefined` —— 不给 CA 就退化成
 *      "不验证"，连一张坏证书也返回 ok:true，而浏览器那边照样报错。
 *
 *   ② **CA 不对时必须报成"证书问题"**，不能与"连不上"混为一谈。
 *      两类故障的修法完全相反：证书验不过时去查防火墙是白费功夫，
 *      连不上时去查证书也是白费功夫。旧提示只有一句"请检查防火墙设置"。
 *
 *   ③ **CA 正确时必须真的连上**，并且拿到真实的 HTTP 响应 ——
 *      否则前两条可以被"永远失败"这种实现骗过去。
 *
 * 说明：本文件不碰系统证书库。`generateCerts()` 是纯 JS 生成，
 * 既不写磁盘也不装信任库，所以跑完不留痕迹。
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { generateCerts } from '../src/session-cert.js'
import { Session, PHASE } from '../src/session.js'
import { TransferServer } from '../src/server.js'
import { deriveVerifier, deriveKeys, sealManifest, PARAMS } from '../src/suite/flicker1.js'

const HOSTS = ['127.0.0.1', 'localhost']

let certA, certB, server, port, healthUrl

function makeServer() {
  const salt = randomBytes(PARAMS.saltBytes)
  const verifier = deriveVerifier('readiness-test-password', salt)
  const keys = deriveKeys(verifier)
  const wire = {
    v: 1, suite: 'FLICKER/1',
    files: [{ kind: 'file', name: 'a.txt', rel: 'a.txt', size: 5, chunks: 1,
      chunkBytes: PARAMS.chunkBytes, sha256: 'x', chunkHashes: ['y'] }],
    totalBytes: 5, totalChunks: 1,
  }
  const enc = sealManifest(keys.enc, Buffer.from(JSON.stringify(wire), 'utf8'))
  const session = new Session({
    salt, verifier, encManifest: enc.ct, manifestIv: enc.iv, manifestTag: enc.tag,
  })
  return new TransferServer({
    session,
    manifest: { ...wire, files: wire.files.map((f, i) => ({ ...f, index: i, firstChunk: 0, absPath: null })) },
    receiverHtml: '<!doctype html><meta charset="utf-8"><h1>接收页</h1>',
  })
}

before(async () => {
  // 两张互不相干的证书：B 用来验证"A 的服务不接受 B 的信任根"
  certA = generateCerts({ hosts: HOSTS })
  certB = generateCerts({ hosts: HOSTS })
  server = makeServer()
  port = await server.listen({
    key: certA.srvKeyPem, cert: certA.srvPem, host: '127.0.0.1', port: 0,
  })
  healthUrl = `https://127.0.0.1:${port}/api/health`
})

after(async () => { await server?.shutdown() })

test('⭐ 正向：拿正确的 CA 探测，必须真的连上并拿到 HTTP 响应', async () => {
  const r = await server.waitReady(healthUrl, { caDer: certA.caDer, timeoutMs: 5000 })
  assert.equal(r.ok, true, `正确 CA 应当连上，实际 ${r.detail}`)
  assert.equal(r.reason, 'ok')
  assert.match(r.detail, /HTTP 200/, '必须是真实的 HTTP 响应，不是"没报错就算过"')
  assert.equal(r.attempts, 1, '第一次就该成功 —— 若重试多次说明启动顺序有问题')
})

test('⭐ 反向：拿错误的 CA 探测 → 报成"证书问题"（cert），不是"连不上"', async () => {
  const r = await server.waitReady(healthUrl, { caDer: certB.caDer, timeoutMs: 1200 })
  assert.equal(r.ok, false, '另一张证书的 CA 不该被接受')
  assert.equal(r.reason, 'cert',
    `必须归为证书问题，实际 reason=${r.reason}（detail=${r.detail}）—— ` +
    '归成 connect 会把用户引去查防火墙，而真正的问题是证书')
  assert.match(r.detail, /CERT|VERIFY|SELF_SIGNED|ISSUER/,
    `detail 应当是 TLS 的证书错误码，实际 ${r.detail}`)
})

test('⭐ 不给 CA 时必须直接拒绝 —— 不能退化成"不验证"', async () => {
  const r = await server.waitReady(healthUrl, { timeoutMs: 1200 })
  assert.equal(r.ok, false,
    '安全模式下不给 CA 就等于没有验证；返回 ok:true 会让一张坏证书被当成"服务就绪"')
  assert.equal(r.reason, 'nocert')
  assert.equal(r.attempts, 0, '这种情况一次请求都不该发出')
})

test('明文模式（仅测试用）不受"必须有 CA"的限制', async () => {
  // 生产路径永远走 HTTPS；明文模式专供只验路由与令牌语义的测试。
  // 这里只断言它没有被上面那条新规则误伤。
  const plain = makeServer()
  const p = await plain.listen({ host: '127.0.0.1', port: 0 })
  try {
    const r = await plain.waitReady(`http://127.0.0.1:${p}/api/health`, { timeoutMs: 3000 })
    assert.equal(r.ok, true, `明文模式应当照常工作，实际 ${r.detail}`)
  } finally {
    await plain.shutdown()
  }
})

test('探测不消费一次性令牌（与 startup-order.test.js 互补的一条）', async () => {
  // 为什么在这里再断言一次：本文件走的是**真实 HTTPS + 真实证书**这条路，
  // 而令牌被探测吃掉的那个缺陷当初只在明文模式下被测到。
  const salt = randomBytes(PARAMS.saltBytes)
  const verifier = deriveVerifier('token-test-password', salt)
  const keys = deriveKeys(verifier)
  const wire = {
    v: 1, suite: 'FLICKER/1',
    files: [{ kind: 'file', name: 'b.txt', rel: 'b.txt', size: 5, chunks: 1,
      chunkBytes: PARAMS.chunkBytes, sha256: 'x', chunkHashes: ['y'] }],
    totalBytes: 5, totalChunks: 1,
  }
  const enc = sealManifest(keys.enc, Buffer.from(JSON.stringify(wire), 'utf8'))
  const session = new Session({
    salt, verifier, encManifest: enc.ct, manifestIv: enc.iv, manifestTag: enc.tag,
  })
  const srv = new TransferServer({
    session,
    manifest: { ...wire, files: wire.files.map((f, i) => ({ ...f, index: i, firstChunk: 0, absPath: null })) },
    receiverHtml: '<!doctype html><meta charset="utf-8"><h1>接收页</h1>',
  })
  const p = await srv.listen({
    key: certA.srvKeyPem, cert: certA.srvPem, host: '127.0.0.1', port: 0,
  })
  try {
    const r = await srv.waitReady(`https://127.0.0.1:${p}/api/health`,
      { caDer: certA.caDer, timeoutMs: 5000 })
    assert.equal(r.ok, true, `探测应当成功，实际 ${r.detail}`)
    assert.equal(session.tokenConsumed, false,
      '就绪探测绝不能消费一次性令牌 —— 否则用户打开链接会看到"链接已失效"')
    assert.equal(session.phase, PHASE.WAITING, '探测不应改变会话状态')
  } finally {
    await srv.shutdown()
  }
})
