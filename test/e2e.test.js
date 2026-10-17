/**
 * 端到端集成测试
 * ==============
 * 在 Node 里**扮演浏览器接收端**，完整走一遍真实协议：
 *   取参数 → 派生密钥 → 挑战应答 → 双向认证 → 解密清单 → 逐块下载解密 → 校验
 *
 * 这是除真实浏览器外最强的验证。它也验证了"两台电脑密码必须一致"这条安全性质 ——
 * 密码不对时必须失败，而且不能创建任何输出。
 *
 * 关于 TLS：测试**不使用"忽略证书错误"** —— 那会掩盖真实问题。
 * 做法是让发送端用 --machine-cert 导出它的会话 CA，测试只信任这一张。
 * 另有一个用例专门验证：不信任它时，标准客户端确实会拒绝。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { randomBytes, createHash, pbkdf2Sync, hkdfSync, createHmac, createDecipheriv } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { request as httpsRequest } from 'node:https'
import { PARAMS } from '../src/suite/flicker1.js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CLI = path.join(root, 'bin', 'flicker.js')
const TEST_PASSWORD = 'integration-test-password'
const START_TIMEOUT_MS = 20000

// ── 接收端实现（与 web/receiver.html 同一套算法，只是跑在 Node 里）──

const b64 = (s) => Buffer.from(s, 'base64')

function derive(password, saltB64) {
  const salt = b64(saltB64)
  const v = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, PARAMS.iterations, 32, 'sha256')
  const one = (label) => Buffer.from(hkdfSync('sha256', v, Buffer.alloc(0), label, 32))
  return { room: one('flicker/1/room'), auth: one('flicker/1/auth'), enc: one('flicker/1/enc') }
}

const recvMac = (authKey, ch) => createHmac('sha256', authKey)
  .update(Buffer.concat([Buffer.from('flicker/1/recv\n'), ch])).digest()
const sendMac = (authKey, ch) => createHmac('sha256', authKey)
  .update(Buffer.concat([Buffer.from('flicker/1/send\n'), ch])).digest()

const ivFor = (i) => { const b = Buffer.alloc(12); b.writeBigUInt64BE(BigInt(i), 4); return b }
const aadFor = (f, c, t, len) => {
  const b = Buffer.alloc(28)
  b.writeBigUInt64BE(BigInt(f), 0); b.writeBigUInt64BE(BigInt(c), 8)
  b.writeBigUInt64BE(BigInt(t), 16); b.writeUInt32BE(len >>> 0, 24)
  return b
}
const MANIFEST_AAD = Buffer.from('flicker/1/manifest', 'utf8')

function openManifest(encKey, iv, ct, tag) {
  const d = createDecipheriv('aes-256-gcm', encKey, iv, { authTagLength: 16 })
  d.setAAD(MANIFEST_AAD); d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()])
}
function openChunk(encKey, f, c, t, ct, tag, len) {
  const d = createDecipheriv('aes-256-gcm', encKey, ivFor(c), { authTagLength: 16 })
  d.setAAD(aadFor(f, c, t, len)); d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()])
}

/** 建立会话，走到拿到 SID 与解密后的清单为止 */
async function openSession(sender, password, client) {
  const F = (u, i = {}) => client(i.method ?? 'GET', `${sender.base}${u}`, i)
  // 必须先访问一次页面：一次性令牌在首次访问时消费，
  // /api/session 只认已消费的令牌（见 session.js 的按端点分工）。
  await (await F(`/?k=${encodeURIComponent(sender.token)}`)).text()
  const info = await (await F(`/api/session?k=${encodeURIComponent(sender.token)}`)).json()
  if (!info.salt) throw new Error('取会话参数失败: ' + JSON.stringify(info))
  const keys = derive(password, info.salt)
  const { challenge } = await (await F(`/api/auth/start?k=${encodeURIComponent(sender.token)}`, { method: 'POST' })).json()
  const mac = recvMac(keys.auth, b64(challenge))
  const fin = await F('/api/auth/finish', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge, mac: mac.toString('base64') }),
  })
  if (!fin.ok) {
    const e = new Error((await fin.json()).message); e.code = 'AUTH'; e.status = fin.status; throw e
  }
  const { sid, mac: serverMac } = await fin.json()
  assert.equal(serverMac, sendMac(keys.auth, b64(challenge)).toString('base64'),
    '发送端也必须能证明它知道密码')
  const wire = JSON.parse(openManifest(keys.enc,
    b64(info.manifest.iv), b64(info.manifest.ct), b64(info.manifest.tag)).toString('utf8'))
  return { F, keys, sid, wire, info }
}

/** 完整接收，逐块与整体都校验 */
async function receiveAll({ sender, password, outDir, client, verify = true }) {
  const { F, keys, sid, wire } = await openSession(sender, password, client)
  const written = []
  for (let fi = 0; fi < wire.files.length; fi++) {
    const f = wire.files[fi]
    const full = path.join(outDir, f.rel)
    await mkdir(path.dirname(full), { recursive: true })
    const parts = []
    const whole = createHash('sha256')
    for (let ci = 0; ci < f.chunks; ci++) {
      const seq = f.firstChunk + ci
      const r = await F(`/api/chunk?seq=${seq}&sid=${encodeURIComponent(sid)}`)
      if (!r.ok) {
        const body = await r.text()
        const e = new Error(`块 ${seq} 失败: HTTP ${r.status} — ${body}`)
        e.code = 'CHUNK'; e.status = r.status; throw e
      }
      const ct = Buffer.from(await r.arrayBuffer())
      const tag = b64(r.headers.get('x-flicker-tag'))
      const plainLen = Math.min(f.chunkBytes, f.size - ci * f.chunkBytes)
      const pt = openChunk(keys.enc, fi, ci, f.chunks, ct, tag, plainLen)
      if (verify && f.chunkHashes && f.chunkHashes[ci]) {
        assert.equal(createHash('sha256').update(pt).digest('hex'), f.chunkHashes[ci],
          `${f.rel} 第 ${ci} 块哈希不符`)
      }
      parts.push(pt); whole.update(pt)
    }
    const buf = Buffer.concat(parts)
    if (verify && f.sha256) {
      assert.equal(whole.digest('hex'), f.sha256, `${f.rel} 整体哈希不符`)
    }
    await writeFile(full, buf)
    written.push({ rel: f.rel, size: buf.length, gift: Boolean(f.kind?.startsWith('flicker-station')) })
  }
  await F(`/api/done?sid=${encodeURIComponent(sid)}`, { method: 'POST' })
  return { wire, written }
}

// ── 启动发送端 ──────────────────────────────────────────────

/**
 * 只信任发送端导出的那张会话 CA。刻意不用"忽略证书错误"。
 * 用 node:https 而不是 fetch —— 因为 fetch 不接受自定义 CA，
 * 而 Node 自带的那份 undici 并不作为公开模块导出。
 * 这样测试用到的全是内置模块，和企业网里的实际行为也更接近。
 */
function makeClient(caFile) {
  // 用 utf8 读成 PEM 文本 —— Node 的 ca 选项要的是 PEM，不是 DER
  const ca = readFileSync(caFile, 'utf8')
  return function req(method, url, init) {
    if (typeof method !== 'string') {
      throw new Error(`client() 的第一个参数必须是 HTTP 方法字符串，收到 ${typeof method}`)
    }
    if (typeof url !== 'string') throw new Error(`client() 的 url 必须是字符串`)
    const { headers = {}, body } = init ?? {}
    const u = new URL(url)
    return new Promise((resolve, reject) => {
      const r = httpsRequest({
        method, host: u.hostname, port: u.port || 443,
        path: u.pathname + u.search, ca, headers,
      }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const buf = Buffer.concat(chunks)
          resolve({
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            headers: {
              get: (k) => res.headers[String(k).toLowerCase()] ?? null,
            },
            text: async () => buf.toString('utf8'),
            json: async () => JSON.parse(buf.toString('utf8')),
            arrayBuffer: async () => buf,
          })
        })
      })
      r.on('error', reject)
      if (body !== undefined) r.write(body)
      r.end()
    })
  }
}

function startSender(args, workDir) {
  return new Promise((resolve, reject) => {
    const certFile = path.join(workDir, 'session-ca.cer')
    const child = spawn(process.execPath,
      [CLI, ...args, '--machine', `--machine-cert=${certFile}`],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = '', errOut = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已退出 */ }
      reject(new Error(`发送端启动超时\nstdout:\n${out}\nstderr:\n${errOut}`))
    }, START_TIMEOUT_MS)
    const onData = (buf, isErr) => {
      const s = buf.toString()
      if (isErr) errOut += s; else out += s
      const m = out.match(/__READY__ (\S+) (\S+)/)
      if (m) {
        clearTimeout(timer)
        const u = new URL(m[1])
        resolve({
          child, base: m[1], token: m[2], host: u.hostname, port: Number(u.port),
          certFile, getOut: () => out, getErr: () => errOut,
        })
      }
    }
    child.stdout.on('data', (b) => onData(b, false))
    child.stderr.on('data', (b) => onData(b, true))
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code) reject(new Error(`发送端提前退出 (code ${code})\nstdout:\n${out}\nstderr:\n${errOut}`))
    })
  })
}

const waitExit = (child, ms = 30000) => new Promise((resolve) => {
  const t = setTimeout(() => { try { child.kill() } catch { /* 已退出 */ } ; resolve(null) }, ms)
  child.on('exit', (code) => { clearTimeout(t); resolve(code) })
})

// ── 用例骨架：每个用例自己建目录、自己登记清理 ───────────────

const cleanups = []
test.after(async () => {
  // ⚠️ 用 try 而不是 `fn().catch(...)`：后者接不住"清理函数同步抛错"和
  //    "清理函数返回 undefined"两种情况，一旦命中就**后面的清理全不跑**，
  //    子进程攥着管道不放，测试进程永不退出（gui.test.js 里记过同一条教训）。
  for (const fn of cleanups.reverse()) {
    try { await fn() } catch (e) { console.error('清理失败：' + (e?.message ?? e)) }
  }
  // 兜底：即使某个用例没能优雅收尾，也不该给用户的系统留下痕迹
  const { cleanAllLeftovers, cleanTempDirs } = await import('../src/trust.js')
  await cleanAllLeftovers().catch(() => {})
  await cleanTempDirs().catch(() => {})
})

async function makeTree() {
  const dir = await mkdtemp(path.join(tmpdir(), 'flicker-e2e-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  await mkdir(path.join(dir, 'src', '照片'), { recursive: true })
  // 覆盖各种情况：普通文本、整块、不齐尾块、空文件、中文目录
  await writeFile(path.join(dir, 'src', 'hello.txt'), 'hello flicker 世界')
  await writeFile(path.join(dir, 'src', 'exact.bin'), randomBytes(1024))
  await writeFile(path.join(dir, 'src', '照片', 'sunset.bin'), randomBytes(2500))
  await writeFile(path.join(dir, 'src', 'empty.dat'), '')
  await writeFile(path.join(dir, 'src', '照片', 'picked.bin'), randomBytes(700))
  return dir
}

const sendArgs = (target, extra = []) => [
  'send', target, `--password=${TEST_PASSWORD}`,
  '--timeout=5s', '--no-qr', '--no-color', '--no-cert-install', ...extra,
]

/** 启动发送端并建好信任通道，登记清理 */
async function boot(args, workDir) {
  const sender = await startSender(args, workDir)
  // ⚠️ 优先等它自然超时退出 —— 这样销毁流程会真的跑一遍，
  //    证书会被清干净。直接 kill 会跳过销毁，让测试自己污染系统。
  cleanups.push(async () => {
    if (sender.child.exitCode === null) await waitExit(sender.child, 12000)
    if (sender.child.exitCode === null) { try { sender.child.kill() } catch { /* 已退出 */ } }
  })
  const client = makeClient(sender.certFile)
  return { sender, client }
}

// ── 用例 ────────────────────────────────────────────────────

test('⭐ 限速真的接到传输路径上了（不只是解析参数）', { timeout: 180000 }, async () => {
  // 单元测试能证明"限速器算得对"，但证明不了"它接在传输路径上"。
  //
  // ⚠️ 文件必须**大于一块**。第一块会用到桶里的初始额度
  //    （1 秒的量）而立刻通过 —— 只传一块的话量到的永远是 0 等待，
  //    看起来像"限速没生效"，其实是测试设计错了（第一版就栽在这里）。
  //
  // ⚠️ 而且**必须显式钉住块大小**。块大小现在是能力协商出来的（默认 auto → 2 MiB），
  //    于是"1.5 MiB 文件 = 2 块"这个前提在默认值变化后就悄悄不成立了
  //    （实测：这条用例真的因此红过一次）。测限速就只测限速：
  //    把块大小写死成 1 MiB，算术与默认值脱钩。
  const work = await mkdtemp(path.join(tmpdir(), 'flicker-rate-'))
  cleanups.push(() => rm(work, { recursive: true, force: true }))
  const src = path.join(work, 'src')
  await mkdir(src, { recursive: true })
  const SIZE = 1536 * 1024                  // 1.5 MiB → 2 块（1 MiB + 0.5 MiB）
  await writeFile(path.join(src, 'big.bin'), randomBytes(SIZE))

  const t0 = Date.now()
  const { sender, client } = await boot(
    sendArgs(src, ['--rate=512K', '--no-gift', '--chunk=1m']), work)
  const tBoot = Date.now() - t0

  const { F, keys, sid, wire } = await openSession(sender, TEST_PASSWORD, client)
  const f = wire.files[0]
  assert.equal(f.rel, 'src/big.bin')
  assert.equal(f.size, SIZE, '文件大小应符合预期')
  assert.equal(f.chunks, 2, `1.5 MiB 在 1 MiB 分块下应是 2 块，实际 ${f.chunks}`)

  const tFetch = Date.now()
  let offset = 0
  const whole = createHash('sha256')
  for (let ci = 0; ci < f.chunks; ci++) {
    const r = await F(`/api/chunk?seq=${offset + ci}&sid=${encodeURIComponent(sid)}`)
    assert.ok(r.ok, `取第 ${ci} 块失败：HTTP ${r.status}`)
    const pt = openChunk(keys.enc, 0, ci, f.chunks,
      Buffer.from(await r.arrayBuffer()), b64(r.headers.get('x-flicker-tag')),
      Math.min(f.chunkBytes, f.size - ci * f.chunkBytes))
    whole.update(pt)
  }
  const fetchMs = Date.now() - tFetch
  await F(`/api/done?sid=${encodeURIComponent(sid)}`, { method: 'POST' })

  // 限速不能损坏数据
  assert.equal(whole.digest('hex'), f.sha256,
    '限速不得改变文件内容（整体哈希必须一致）')

  // 第 1 块（1 MiB）用初始额度免等；第 2 块（512 KiB）在 512 KiB/s 下要等约 1 秒。
  // 若限速没接上，本地回环两块加起来是几毫秒。
  assert.ok(fetchMs >= 700,
    `第 2 块应被限速拦住约 1 秒，实际整体只用了 ${fetchMs}ms —— ` +
    '说明 --rate 没接到传输路径上（本地回环本来会瞬间传完）')
  assert.ok(fetchMs <= 8000,
    `限速不该慢到这个程度（实际 ${fetchMs}ms）—— 可能限得太死或死锁了`)
  void tBoot
})

test('端到端：真实传输并逐字节校验（含多种文件形态）', { timeout: 180000 }, async () => {
  const work = await makeTree()
  const outDir = path.join(work, 'out')
  await mkdir(outDir, { recursive: true })
  const { sender, client } = await boot(sendArgs(path.join(work, 'src')), work)

  const got = await receiveAll({ sender, password: TEST_PASSWORD, outDir, client })
  const files = got.written.filter((w) => !w.gift)
  assert.ok(files.length >= 5, `应收到至少 5 个文件，实际 ${files.length}`)

  let compared = 0
  for (const w of files) {
    // rel 以被扫描目录的名称为前缀（这里是 "src/…"），比对源文件时要去掉
    const relInSrc = w.rel.split('/').slice(1).join('/')
    const a = await readFile(path.join(work, 'src', relInSrc))
    const b = await readFile(path.join(outDir, w.rel))
    assert.equal(Buffer.compare(a, b), 0, `${w.rel} 内容不一致`)
    compared++
  }
  assert.equal(compared, files.length, '每个文件都应逐字节比对过')

  const names = files.map((w) => w.rel)
  assert.ok(names.some((n) => n.endsWith('hello.txt')), '缺少普通文本文件')
  assert.ok(names.some((n) => n.endsWith('exact.bin')), '缺少整块文件')
  assert.ok(names.some((n) => n.endsWith('sunset.bin')), '缺少不齐尾块文件')
  assert.ok(names.some((n) => n.endsWith('empty.dat')), '缺少空文件')
  assert.ok(names.some((n) => n.includes('照片')), '缺少中文目录')

  const empty = await readFile(path.join(outDir, files.find((x) => x.rel.endsWith('empty.dat')).rel))
  assert.equal(empty.length, 0, '空文件应被创建且长度为 0')
})

test('端到端：大文件（多块）也必须逐字节一致', { timeout: 180000 }, async () => {
  const work = await makeTree()
  const big = path.join(work, 'big.bin')
  await writeFile(big, randomBytes(3 * 1024 * 1024 + 12345))   // 跨多块
  const outDir = path.join(work, 'out')
  await mkdir(outDir, { recursive: true })
  const { sender, client } = await boot(sendArgs(big), work)

  const got = await receiveAll({ sender, password: TEST_PASSWORD, outDir, client })
  const name = got.written[0].rel
  assert.equal(Buffer.compare(await readFile(big), await readFile(path.join(outDir, name))), 0,
    '多块大文件必须逐字节一致')
})

test('密码不一致必须被拒绝，且不产出任何文件', { timeout: 180000 }, async () => {
  const work = await makeTree()
  const outDir = path.join(work, 'out')
  await mkdir(outDir, { recursive: true })
  const { sender, client } = await boot([
    'send', path.join(work, 'src', 'hello.txt'), '--password=the-right-password',
    '--timeout=5s', '--no-qr', '--no-color', '--no-cert-install',
  ], work)

  await assert.rejects(
    () => receiveAll({ sender, password: 'the-WRONG-password', outDir, client }),
    (e) => e.code === 'AUTH' && e.status === 401,
    '错误密码必须被拒绝')

  const created = await stat(path.join(outDir, 'hello.txt')).catch(() => null)
  assert.equal(created, null, '密码错误时绝不能创建任何文件')
})

test('一次性令牌：用过一次就不能再用第二次', { timeout: 180000 }, async () => {
  const work = await makeTree()
  const { sender, client } = await boot(sendArgs(path.join(work, 'src', 'hello.txt')), work)
  const F = (u) => client('GET', `${sender.base}${u}`)

  const r1 = await F(`/?k=${encodeURIComponent(sender.token)}`)
  assert.equal(r1.status, 200, '首次访问应成功')
  await r1.text()

  const r2 = await F(`/?k=${encodeURIComponent(sender.token)}`)
  assert.equal(r2.status, 410, '二次访问一次性链接必须被拒绝')
  assert.equal((await r2.json()).error, 'TOKEN_USED')
})

test('错误的令牌无法访问', { timeout: 180000 }, async () => {
  // ⚠️ 每个错误令牌都要配一个**全新的**发送端。
  //    因为第一次访问就会消费一次性令牌，之后任何请求都会得到 TOKEN_USED(410)，
  //    那样就分不清"令牌本身是错的"和"令牌已经用过了"这两件不同的事。
  for (const bad of ['wrong-token-value', 'short', 'x'.repeat(22)]) {
    const work = await makeTree()
    const { sender, client } = await boot(sendArgs(path.join(work, 'src', 'hello.txt')), work)
    const r = await client('GET', `${sender.base}/?k=${encodeURIComponent(bad)}`)
    assert.equal(r.status, 403, `错误令牌 "${bad}" 应被拒绝（403），实际 HTTP ${r.status}`)
    assert.equal((await r.json()).error, 'TOKEN_INVALID')
    // ⚠️ 必须等它**自然超时退出**（发送端超时 5s），不能提前强杀：
    //    强杀会跳过销毁流程，留下证书残留，还会干扰后面的用例。
    //    之前这里写的是 3000ms，比发送端自身的超时还短 —— 必然强杀，
    //    表现是偶发的失败（真实发生过）。
    const code = await waitExit(sender.child, 25000)
    assert.notEqual(code, null, '发送端应在超时后自行退出，而不是被强杀')
  }
})

test('按端点分工的认证：未认证拿不到清单与分块', { timeout: 180000 }, async () => {
  const work = await makeTree()
  const { sender, client } = await boot(sendArgs(path.join(work, 'src', 'hello.txt')), work)
  const F = (u, i) => client(i?.method ?? 'GET', `${sender.base}${u}`, i)

  await (await F(`/?k=${encodeURIComponent(sender.token)}`)).text()

  assert.equal((await F('/api/chunk?seq=0')).status, 401, '未认证不应拿到分块')
  assert.equal((await F('/api/chunk?seq=0&sid=forged-session-id')).status, 401, '伪造 SID 必须被拒绝')

  const { sid } = await openSession(sender, TEST_PASSWORD, client)
  for (const seq of ['-1', '999999', 'abc', '1.5']) {
    const r = await F(`/api/chunk?seq=${seq}&sid=${encodeURIComponent(sid)}`)
    assert.ok(r.status >= 400, `越界序号 ${seq} 应被拒绝，实际 ${r.status}`)
    await r.text()
  }
})

test('篡改的密文会被 GCM 拒绝（真实 HTTP 层验证）', { timeout: 180000 }, async () => {
  const work = await makeTree()
  const { sender, client } = await boot(sendArgs(path.join(work, 'src', 'exact.bin')), work)

  const { F, keys, sid, wire } = await openSession(sender, TEST_PASSWORD, client)
  const f = wire.files.find((x) => x.rel.endsWith('exact.bin'))
  assert.ok(f, '找不到目标文件')

  const r = await F(`/api/chunk?seq=${f.firstChunk}&sid=${encodeURIComponent(sid)}`)
  const ct = Buffer.from(await r.arrayBuffer())
  const tag = b64(r.headers.get('x-flicker-tag'))
  const plainLen = Math.min(f.chunkBytes, f.size)

  assert.doesNotThrow(() => openChunk(keys.enc, f.index, 0, f.chunks, ct, tag, plainLen))

  const badCt = Buffer.from(ct); badCt[10] ^= 0x01
  assert.throws(() => openChunk(keys.enc, f.index, 0, f.chunks, badCt, tag, plainLen),
    /.*/, '篡改的密文必须被拒绝')

  const badTag = Buffer.from(tag); badTag[0] ^= 0x01
  assert.throws(() => openChunk(keys.enc, f.index, 0, f.chunks, ct, badTag, plainLen),
    /.*/, '篡改的标签必须被拒绝')

  assert.throws(() => openChunk(keys.enc, f.index + 1, 0, f.chunks, ct, tag, plainLen),
    /.*/, '跨文件拼接必须被拒绝')

  assert.throws(() => openChunk(keys.enc, f.index, 0, f.chunks, ct, tag, Math.max(0, plainLen - 1)),
    /.*/, '谎报长度必须被拒绝')
})

test('未信任该证书时标准客户端确实会拒绝（说明 TLS 真的在起作用）', { timeout: 180000 }, async () => {
  const work = await makeTree()
  const { sender } = await boot(sendArgs(path.join(work, 'src', 'hello.txt')), work)
  // 刻意不传 dispatcher —— 用 Node 默认的信任列表
  await assert.rejects(
    async () => { await fetch(`${sender.base}/?k=${encodeURIComponent(sender.token)}`) },
    (e) => /certificate/i.test(e?.cause?.message ?? e?.message ?? ''),
    '没有信任该 CA 的客户端必须拒绝连接 —— 否则说明我们无意中关掉了校验')
})

test('超时后进程自行退出，退出码为 0', { timeout: 180000 }, async () => {
  const work = await makeTree()
  const sender = await startSender([
    'send', path.join(work, 'src', 'hello.txt'), `--password=${TEST_PASSWORD}`,
    '--timeout=3s', '--no-qr', '--no-color', '--no-cert-install',
  ], work)
  cleanups.push(async () => { try { sender.child.kill() } catch { /* 已退出 */ } })
  const code = await waitExit(sender.child, 40000)
  // 超时是"未完成"而非"出错"：按 使用手册.md §6 的退出码约定，超时为 6
  assert.equal(code, 6, `超时后应以退出码 6 结束，实际 ${code}`)
  assert.match(sender.getOut(), /销毁/, '应打印销毁清单')
})
