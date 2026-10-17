/**
 * 探测与令牌的交互（回归测试）
 * ============================
 * 这个文件锁住一个真实存在过的缺陷：
 *
 *   **就绪探测把一次性令牌消费掉了。**
 *
 * 原来的实现里，启动时的"服务就绪了吗"探测直接去 GET 接收页地址，
 * 而那个地址带着一次性令牌。于是"自检"这个动作本身消费了令牌，
 * 真正的用户打开链接时看到的是"链接已失效"（HTTP 410）——
 * 而启动日志一切正常（"服务就绪（探测 1 次）"），极难排查。
 *
 * 修复方式：新增一个**无副作用**的 /api/health 端点，探测只打这个。
 *
 * 教训：**探测一个服务的可用性，不能用会产生副作用的端点。**
 *
 * 关于本文件的取舍：不使用 src/trust.js 生成真证书，也不碰系统证书库 ——
 * 这里只需要一张能跑 HTTPS 的自签证书，手搓一张即可（下面有实现）。
 * 这样测试既快，又不会在你的机器上留下任何痕迹。
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { createSign, generateKeyPairSync, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { Session, PHASE } from '../src/session.js'
import { TransferServer } from '../src/server.js'
import { deriveVerifier, deriveKeys, sealManifest, PARAMS } from '../src/suite/flicker1.js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

// 说明：这里刻意不使用 HTTPS。
// 本文件验证的是**路由与令牌语义**，与传输层加密无关；
// 而"造一张能通过 OpenSSL 校验的证书"本身就是另一件事
// （需要正确的 basicConstraints / keyUsage / EKU，容易写成一场打地鼠）。
// 生产路径永远走 HTTPS —— 局域网接收端不这样浏览器就不给 crypto.subtle。
// 所以 TransferServer 支持不传证书时的明文模式，专供这类测试使用。

// ── 测试夹具 ────────────────────────────────────────────────

let session, server, port

function makeSession(password, name) {
  const salt = randomBytes(PARAMS.saltBytes)
  const verifier = deriveVerifier(password, salt)
  const keys = deriveKeys(verifier)
  const wire = {
    v: 1, suite: 'FLICKER/1',
    files: [{ kind: 'file', name, rel: name, size: 5, chunks: 1,
      chunkBytes: PARAMS.chunkBytes, sha256: 'x', chunkHashes: ['y'] }],
    totalBytes: 5, totalChunks: 1,
  }
  const enc = sealManifest(keys.enc, Buffer.from(JSON.stringify(wire), 'utf8'))
  const s = new Session({ salt, verifier, encManifest: enc.ct, manifestIv: enc.iv, manifestTag: enc.tag })
  const srv = new TransferServer({
    session: s,
    manifest: { ...wire, files: wire.files.map((f, i) => ({ ...f, index: i, firstChunk: 0, absPath: null })) },
    receiverHtml: '<!doctype html><meta charset="utf-8"><h1>接收页</h1>',
  })
  return { s, srv }
}

/** 发一个请求，返回 { status, body } */
function req(p, pathname, { method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const r = httpRequest({
      host: '127.0.0.1', port: p, path: pathname, method, timeout: 5000,
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    r.on('timeout', () => { r.destroy(new Error('请求超时')) })
    r.on('error', reject)
    r.end()
  })
}

before(async () => {
  const made = makeSession('probe-test-password', 'a.txt')
  session = made.s
  server = made.srv
  port = await server.listen({ host: '127.0.0.1' })
})

after(async () => { await server?.shutdown() })

// ── 用例 ────────────────────────────────────────────────────

test('健康检查端点无副作用：无需令牌、可重复访问、不改会话状态', async () => {
  for (let i = 0; i < 3; i++) {
    const r = await req(port, '/api/health')
    assert.equal(r.status, 200, `第 ${i + 1} 次健康检查应返回 200，实际 ${r.status}`)
    assert.equal(r.body, 'ok')
  }
  assert.equal(session.tokenConsumed, false,
    '健康检查**绝不能**消费一次性令牌 —— 否则用户拿到的链接会是失效的')
  assert.equal(session.phase, PHASE.WAITING, '健康检查不应改变会话状态')
})

test('回归：探测之后，真正的接收端仍然能打开页面（令牌没被吃掉）', async () => {
  // 复刻启动顺序：先探测，再把链接给用户
  await req(port, '/api/health')
  const page = await req(port, `/?k=${encodeURIComponent(session.token)}`)
  assert.equal(page.status, 200,
    '探测之后页面必须仍然可用。若这里是 410，说明探测把令牌消费掉了 —— ' +
    '这是真实发生过的缺陷：用户点开链接看到"链接已失效"，而启动日志一切正常')
  assert.match(page.body, /接收页/)
  assert.equal(session.tokenConsumed, true, '此时令牌才应被消费')
})

test('就绪探测确实能发现"服务没起来"（这是它的本职）', async () => {
  // ⚠️ 不要用 port + 1 猜一个"没人用"的端口：并行跑测试时它可能正被别人占用，
  //    于是这条用例会偶发失败（真实发生过）。改成先绑一个端口拿到号、再关掉，
  //    这样拿到的是系统刚分配过的、大概率仍然空闲的端口。
  const { createServer } = await import('node:net')
  const probeSrv = createServer()
  await new Promise((r) => probeSrv.listen(0, '127.0.0.1', r))
  const deadPort = probeSrv.address().port
  await new Promise((r) => probeSrv.close(r))

  const dead = await new Promise((resolve) => {
    const r = httpRequest({
      host: '127.0.0.1', port: deadPort, path: '/api/health', method: 'GET',
      timeout: 2000,
    }, (res) => { res.resume(); resolve(res.statusCode) })
    r.on('timeout', () => { r.destroy(); resolve(null) })
    r.on('error', () => resolve(null))
    r.end()
  })
  assert.equal(dead, null, '连不上的端口必须探测失败 —— 否则探测毫无意义')
})

test('健康检查开放，但所有带数据的端点仍然严格认证', async () => {
  const made = makeSession('another-password', 'b.txt')
  const p2 = await made.srv.listen({ host: '127.0.0.1' })
  try {
    assert.equal((await req(p2, '/api/health')).status, 200, '健康检查永远开放')
    assert.equal((await req(p2, '/api/chunk?seq=0')).status, 401, '分块必须要求认证')
    assert.equal((await req(p2, '/api/chunk?seq=0&sid=forged')).status, 401, '伪造 SID 必须被拒绝')
    assert.equal((await req(p2, '/api/manifest?sid=forged')).status, 401, '清单必须要求认证')
    assert.equal((await req(p2, '/')).status, 403, '没有令牌不应拿到页面')
    assert.equal((await req(p2, '/api/session')).status, 403, '未消费令牌时不给会话参数')
  } finally {
    await made.srv.shutdown()
  }
})

// ── 静态检查：把"顺序"这类隐式约定也纳入测试 ────────────────

test('源码顺序：四条启动约束在 run.js 里的调用次序正确', () => {
  const src = readFileSync(path.join(root, 'src', 'run.js'), 'utf8')
  const at = (re, label) => {
    const i = src.search(re)
    assert.notEqual(i, -1, `在 run.js 里找不到「${label}」`)
    return i
  }
  const order = [
    ['清理上次残留', at(/cleanAllLeftovers\(\)/, '清理上次残留')],
    ['生成证书', at(/generateSession\(/, '生成证书')],
    // ⚠️ 名字是 `selfCheckOrThrow`（trust.js 里那个"不合格就抛"的包装），
    //    不是 session-cert.js 的 `selfCheck`（那个返回报告、不抛）。
    //    两个契约不同的函数同名，在拼成单文件时会撞名 —— 所以各起了一个名字。
    ['证书自检', at(/selfCheckOrThrow\(/, '证书自检')],
    ['装入信任库', at(/trust\.trustCa\(/, '装入信任库')],
    ['监听端口', at(/server\.listen\(/, '监听端口')],
    ['就绪探测', at(/waitReady\(/, '就绪探测')],
    ['允许开窗口', at(/opts\.onReady\?\.\(/, '允许开窗口')],
  ]
  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i][1] > order[i - 1][1],
      `顺序错误：「${order[i][0]}」必须排在「${order[i - 1][0]}」之后。` +
      '这四条约束全部来自实测，顺序错了会出现极难排查的故障')
  }
})

test('源码：onReady 真的被调用（曾经漏掉过，页面因此拿不到链接）', () => {
  const src = readFileSync(path.join(root, 'src', 'run.js'), 'utf8')
  assert.match(src, /opts\.onReady\?\.\(/,
    'run.js 必须真的调用 opts.onReady —— 只在参数注释里提到它是不够的。' +
    '漏掉这个调用不会报错，只会让图形界面静默地卡在"等待对方连接"')
  // 而且要排在就绪探测之后
  assert.ok(src.search(/waitReady\(/) < src.search(/opts\.onReady\?\.\(/),
    'onReady 必须排在 waitReady 之后（约束 4）')
})

test('源码：就绪探测用的是无副作用的端点', () => {
  const src = readFileSync(path.join(root, 'src', 'run.js'), 'utf8')
  const i = src.indexOf('waitReady(')
  const around = src.slice(Math.max(0, i - 400), i + 120)
  assert.match(around, /health/i,
    '就绪探测必须打 /api/health。打接收页地址会把一次性令牌消费掉 —— ' +
    '这正是本文件要防的回归')
})

test('接收端页面：能力检测优先于 UA 判断，并给出降级提示', () => {
  const html = readFileSync(path.join(root, 'web', 'receiver.html'), 'utf8')
  assert.match(html, /typeof window\.showSaveFilePicker === 'function'/,
    '必须实测 API 是否存在，而不是猜浏览器名字')
  assert.match(html, /CAN_STREAM/)
  assert.match(html, /不支持/, '不支持流式写盘时要给出提示，不能让用户传到一半才失败')
})
