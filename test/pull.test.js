/**
 * `flicker recv <链接>`：用**程序自己**接收（2026-10 新增）
 * =====================================================
 *
 * 这条路以前不存在：`flicker recv <链接>` 只是 `openBrowser(link)`，接收由发送端发来的
 * 网页完成 —— 于是"双方都装了程序"其实没有任何区别。现在 Node 自己下载、逐块校验、落盘。
 *
 * 判据分三层（每一层都要能**证伪**，否则等于没验）：
 *
 *   ① **真的收得下来**：起一个真发送端（CLI，走用户默认的那条路），用 `flicker recv`
 *      收完，逐字节比对；`.flicker-part` 不留；发送端**因为收到 /api/done 而退出**。
 *   ② **坏数据必须被拦住**：这里用一个"坏发送端"（自己按协议封包，但故意篡改）——
 *      改一个块的密文、清单里放一个不安全路径、清单里两个路径会撞成同一个文件、
 *      整文件摘要对不上。每一种都必须**拒绝**，且定稿文件不存在。
 *   ③ **证书那一关**：指纹不一致必须拒绝（AUTH 退出码）；`--insecure` 能过但屏幕上
 *      必须写着"没有核对"；不给指纹又不是交互终端时必须**失败**，而不是默默当成假的算了。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  matchFingerprint, parseRecvLink, probePeer, pullFromLink,
} from '../src/pull.js'
import {
  deriveKeys, deriveVerifier, openManifest, receiverMac, sealChunk, sealManifest, senderMac,
} from '../src/suite/flicker1.js'
import * as trust from '../src/trust.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CLI = path.join(ROOT, 'bin', 'flicker.js')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const cleanups = []
const live = []
test.after(async () => {
  for (const c of live.splice(0)) { try { c.kill() } catch { /* 已退出 */ } }
  await sleep(150)
  for (const fn of cleanups.reverse()) {
    try { await fn() } catch (e) { console.error('清理失败：' + (e?.message ?? e)) }
  }
  // 兜底：被杀掉的发送端来不及走销毁链，可能留下临时证书目录
  await trust.cleanTempDirs().catch(() => {})
  await trust.cleanAllLeftovers().catch(() => {})
})

async function tempDir(prefix = 'flicker-pull-') {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** 起一个**真**发送端（CLI + --machine），并把指纹也读出来 */
function startSender(args) {
  return new Promise((resolve, reject) => {
    // ⚠️ `--no-cert-install`：这些用例只验**接收端**，不需要把会话 CA 装进系统信任库。
    //    装了却因为"故意失败/被 kill"没走销毁链，就会把证书留在库里 ——
    //    `test/trust.test.js` 有断言"运行前后的证书数量必须一致"，会因此红（2026-10 踩到）。
    const child = spawn(process.execPath, [CLI, ...args, '--machine', '--no-cert-install'],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    live.push(child)
    let out = '', err = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已退出 */ }
      reject(new Error(`发送端启动超时\n${out}\n${err}`))
    }, 20000)
    const onData = (b, isErr) => {
      const s = b.toString()
      if (isErr) err += s; else out += s
      const m = out.match(/__READY__ (\S+) (\S+)/)
      const fp = out.match(/__FINGERPRINT__ (\w+)/)
      if (m && fp) {
        clearTimeout(timer)
        resolve({ child, base: m[1], token: m[2], fingerprint: fp[1], getOut: () => out, getErr: () => err })
      }
    }
    child.stdout.on('data', (b) => onData(b, false))
    child.stderr.on('data', (b) => onData(b, true))
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code) reject(new Error(`发送端提前退出 (${code})\n${out}\n${err}`))
    })
  })
}

/** 跑一次 `flicker recv <链接>`（用户真正敲的那条命令） */
function runRecvCli(args, { stdin = 'ignore' } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'recv', ...args],
      { stdio: [stdin, 'pipe', 'pipe'], windowsHide: true })
    live.push(child)
    let out = '', err = ''
    child.stdout.on('data', (b) => { out += b.toString() })
    child.stderr.on('data', (b) => { err += b.toString() })
    const timer = setTimeout(() => { try { child.kill() } catch { /* 已退出 */ } }, 60000)
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out, err }) })
  })
}

const waitExit = (child, ms = 20000) => new Promise((resolve) => {
  const t = setTimeout(() => { resolve(null) }, ms)
  child.on('exit', (code) => { clearTimeout(t); resolve(code) })
})

// ── ① 真的收得下来（真发送端 + 真 CLI）──────────────────────

test('⭐ 真发送端 → `flicker recv <链接>`：逐字节一致、不留半成品、发送端收尾退出', { timeout: 120000 },
  async () => {
    const work = await tempDir()
    const src = path.join(work, 'src')
    const out = path.join(work, 'out')
    await mkdir(path.join(src, '照片'), { recursive: true })
    await writeFile(path.join(src, 'hello.txt'), 'hello pull 世界')
    await writeFile(path.join(src, '照片', 'sunset.bin'), randomBytes(3000))
    await writeFile(path.join(src, 'empty.dat'), '')
    await mkdir(out, { recursive: true })

    const sender = await startSender(['send', src, '--password=pull-e2e-pass', '--no-qr', '--no-color', '--no-gift'])
    const link = `${sender.base}/?k=${sender.token}`
    const r = await runRecvCli([link, '--password=pull-e2e-pass',
      `--fingerprint=${sender.fingerprint}`, `--dir=${out}`, '--no-open', '--no-color'])

    assert.equal(r.code, 0, `应当成功接收（退出码 ${r.code}）：\n${r.out}\n${r.err}`)
    assert.match(r.out, /校验通过/, '屏幕上要明说校验通过了')
    assert.match(r.out, new RegExp(sender.fingerprint), '要显示核对过的指纹')

    // ⚠️ 传的是**整个目录**，所以清单里的相对路径带目录名（`src/hello.txt`）——
    //    这正是 `scan()` 的约定，不是 bug。断言跟着约定走。
    for (const [rel, want] of [
      ['src/hello.txt', Buffer.from('hello pull 世界')],
      ['src/照片/sunset.bin', null],
      ['src/empty.dat', Buffer.alloc(0)],
    ]) {
      const got = await readFile(path.join(out, rel))
      if (want) assert.equal(Buffer.compare(got, want), 0, `${rel} 应当逐字节一致`)
      else assert.ok(got.length > 0, `${rel} 应当收到内容`)
    }
    // 不留半成品
    for (const name of await readdir(out)) {
      assert.ok(!name.endsWith('.flicker-part'), `不该留下半成品：${name}`)
    }
    // 发送端因为收到 /api/done 而收尾退出（协议里的完成判据）
    const code = await waitExit(sender.child, 20000)
    assert.equal(code, 0, '发送端应当在收到 /api/done 之后正常退出（用完即销毁）')
  })

test('指纹不一致 → 拒绝连接，且一个字节都不写（退出码 = AUTH）', { timeout: 120000 }, async () => {
  const work = await tempDir()
  const src = path.join(work, 'src')
  const out = path.join(work, 'out')
  await mkdir(src, { recursive: true })
  await mkdir(out, { recursive: true })
  await writeFile(path.join(src, 'a.txt'), 'secret')

  const sender = await startSender(['send', src, '--password=pull-fp-pass', '--no-qr', '--no-color'])
  const link = `${sender.base}/?k=${sender.token}`
  const wrong = sender.fingerprint === '00000000' ? '11111111' : '00000000'
  const r = await runRecvCli([link, '--password=pull-fp-pass',
    `--fingerprint=${wrong}`, `--dir=${out}`, '--no-open', '--no-color'])

  assert.equal(r.code, 4, `退出码应当是 4（认证/信任失败），实际 ${r.code}：\n${r.out}${r.err}`)
  assert.match(r.err + r.out, /指纹对不上/)
  assert.deepEqual(await readdir(out), [], '一个文件都不该写出来')
  try { sender.child.kill() } catch { /* 已退出 */ }
})

test('`--insecure` 能连上，但屏幕上必须写着"没有核对"（不许悄悄放过）', { timeout: 120000 }, async () => {
  const work = await tempDir()
  const src = path.join(work, 'src')
  const out = path.join(work, 'out')
  await mkdir(src, { recursive: true })
  await mkdir(out, { recursive: true })
  await writeFile(path.join(src, 'a.txt'), 'insecure-ok')

  const sender = await startSender(['send', src, '--password=pull-ins-pass', '--no-qr', '--no-color'])
  const link = `${sender.base}/?k=${sender.token}`
  const r = await runRecvCli([link, '--password=pull-ins-pass', '--insecure',
    `--dir=${out}`, '--no-open', '--no-color'])

  assert.equal(r.code, 0, `--insecure 应当能收完：\n${r.out}\n${r.err}`)
  assert.match(r.out, /没有核对/, '必须明确写出"这次没有核对证书指纹"')
  assert.equal(String(await readFile(path.join(out, 'src', 'a.txt'))), 'insecure-ok')
})

test('既不给指纹、也不是交互终端 → **必须失败**（不能默默当没验过）', { timeout: 120000 }, async () => {
  const work = await tempDir()
  const src = path.join(work, 'src')
  const out = path.join(work, 'out')
  await mkdir(src, { recursive: true })
  await mkdir(out, { recursive: true })
  await writeFile(path.join(src, 'a.txt'), 'x')

  const sender = await startSender(['send', src, '--password=pull-noask-pass', '--no-qr', '--no-color'])
  const link = `${sender.base}/?k=${sender.token}`
  const r = await runRecvCli([link, '--password=pull-noask-pass',
    `--dir=${out}`, '--no-open', '--no-color'])

  assert.equal(r.code, 4, `应当以 AUTH(4) 失败，实际 ${r.code}：\n${r.out}${r.err}`)
  assert.match(r.err + r.out, /没有确认证书指纹|一致吗/)
  assert.deepEqual(await readdir(out), [], '没有确认就不该写任何文件')
  try { sender.child.kill() } catch { /* 已退出 */ }
})

test('密码不对 → 明确报"密码不一致"，不写任何文件（退出码 = AUTH）', { timeout: 120000 }, async () => {
  const work = await tempDir()
  const src = path.join(work, 'src')
  const out = path.join(work, 'out')
  await mkdir(src, { recursive: true })
  await mkdir(out, { recursive: true })
  await writeFile(path.join(src, 'a.txt'), 'x')

  const sender = await startSender(['send', src, '--password=right-pass', '--no-qr', '--no-color'])
  const link = `${sender.base}/?k=${sender.token}`
  const r = await runRecvCli([link, '--password=wrong-pass',
    `--fingerprint=${sender.fingerprint}`, `--dir=${out}`, '--no-open', '--no-color'])

  assert.equal(r.code, 4, `应当以 AUTH(4) 失败，实际 ${r.code}：\n${r.out}${r.err}`)
  assert.match(r.err + r.out, /密码不一致/)
  assert.deepEqual(await readdir(out), [])
  try { sender.child.kill() } catch { /* 已退出 */ }
})

// ── ② 坏数据必须被拦住（自己按协议封包的"坏发送端"）──────────

/**
 * 一个**故意不老实**的发送端：协议完全按 PROTOCOL §7 来，但可以篡改。
 * 用它才能精确制造"改一个字节 / 路径不安全 / 整文件哈希不符"这些情况 ——
 * 真发送端不会配合我们造这些。
 *
 * @param {object} o
 * @param {{rel:string, data:Buffer}[]} o.files
 * @param {(ctx:object)=>void} [o.mutateManifest] 造完清单后改一改（例如塞一个坏路径）
 * @param {(info:{fi:number,ci:number,ct:Buffer})=>Buffer} [o.tamperChunk] 篡改某个块
 * @param {(file:object)=>string} [o.wrongSha] 把某个文件的整体摘要改错
 */
async function badSender({ password, files, mutateManifest, tamperChunk, wrongSha } = {}) {
  const token = randomBytes(18).toString('base64url')
  const salt = randomBytes(16)
  const keys = deriveKeys(deriveVerifier(password, salt))
  const challenge = randomBytes(32)
  const sid = 'sid-test'
  let tokenConsumed = false
  let done = false

  // 清单 + 逐块哈希（分块大小用协议默认值）
  const { PARAMS } = await import('../src/suite/flicker1.js')
  const chunkBytes = PARAMS.chunkBytes
  const wire = files.map((f, i) => {
    const chunks = Math.max(1, Math.ceil(f.data.length / chunkBytes))
    const chunkHashes = []
    for (let ci = 0; ci < chunks; ci++) {
      const plain = f.data.subarray(ci * chunkBytes, Math.min((ci + 1) * chunkBytes, f.data.length))
      chunkHashes.push(createHash('sha256').update(plain).digest('hex'))
    }
    return {
      index: i, rel: f.rel, size: f.data.length, chunks, chunkBytes,
      sha256: createHash('sha256').update(f.data).digest('hex'),
      chunkHashes, firstChunk: 0,
    }
  })
  // firstChunk 按全局块序号连续
  let acc = 0
  for (const f of wire) { f.firstChunk = acc; acc += f.chunks }
  if (wrongSha) for (const f of wire) f.sha256 = wrongSha(f)
  if (mutateManifest) mutateManifest(wire)
  const sealed = sealManifest(keys.enc, Buffer.from(JSON.stringify({
    files: wire, totalBytes: files.reduce((a, f) => a + f.data.length, 0), totalChunks: acc,
  }), 'utf8'))

  const cert = await trust.generateSession({ hosts: ['127.0.0.1'] })
  const server = createServer({ key: cert.srvKeyPem, cert: cert.srvPem }, async (req, res) => {
    const url = new URL(req.url, 'https://x')
    const json = (status, obj) => {
      const b = Buffer.from(JSON.stringify(obj))
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': b.length })
      res.end(b)
    }
    if (url.pathname === '/api/health') { res.writeHead(200).end('ok'); return }
    if (url.pathname === '/') { tokenConsumed = true; res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html></html>'); return }
    if (url.pathname === '/api/session') {
      if (!tokenConsumed) { json(401, { error: 'TOKEN_INVALID', message: '先打开页面' }); return }
      json(200, {
        suite: 'FLICKER/1', salt: salt.toString('base64'),
        manifest: {
          iv: sealed.iv.toString('base64'), ct: sealed.ct.toString('base64'),
          tag: sealed.tag.toString('base64'),
        },
        kdf: { name: PARAMS.kdf, iterations: PARAMS.iterations }, chunkBytes,
      })
      return
    }
    if (url.pathname === '/api/auth/start') {
      json(200, { challenge: challenge.toString('base64'), macProfiles: ['v2'] })
      return
    }
    if (url.pathname === '/api/auth/finish') {
      // 不校验 MAC（这是个"坏发送端"，我们只验**接收端**的行为）
      const b = Buffer.concat(await (async () => { const c = []; for await (const x of req) c.push(x); return c })())
      const body = JSON.parse(b.toString('utf8') || '{}')
      const mac = senderMac(keys.auth, Buffer.from(body.challenge, 'base64'), { profile: 'v2' }).toString('base64')
      json(200, { sid, mac })
      return
    }
    if (url.pathname === '/api/manifest') { json(200, wire_manifest()); return }
    if (url.pathname === '/api/chunk') {
      const seq = Number(url.searchParams.get('seq'))
      let fi = -1, ci = -1
      for (let i = 0; i < wire.length; i++) {
        if (seq >= wire[i].firstChunk && seq < wire[i].firstChunk + wire[i].chunks) {
          fi = i; ci = seq - wire[i].firstChunk; break
        }
      }
      if (fi < 0) { json(416, { error: 'RANGE' }); return }
      const f = wire[fi]
      const plain = files[fi].data.subarray(ci * chunkBytes,
        Math.min((ci + 1) * chunkBytes, files[fi].data.length))
      const { ct, tag } = sealChunk(keys.enc, fi, ci, f.chunks, plain)
      let body = ct
      if (tamperChunk) body = tamperChunk({ fi, ci, ct })
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream', 'Content-Length': body.length,
        'X-Flicker-Tag': tag.toString('base64'), 'X-Flicker-File': String(fi), 'X-Flicker-Chunk': String(ci),
      })
      res.end(body)
      return
    }
    if (url.pathname === '/api/done') { done = true; json(200, { ok: true }); return }
    json(404, { error: 'NOT_FOUND' })
  })
  const wire_manifest = () => ({
    iv: sealed.iv.toString('base64'), ct: sealed.ct.toString('base64'), tag: sealed.tag.toString('base64'),
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `https://127.0.0.1:${server.address().port}`
  cleanups.push(() => new Promise((r) => server.close(r)))
  cleanups.push(() => cert.cleanup())
  return { base, token, link: `${base}/?k=${token}`, get done() { return done }, cert, wire }
}

const password = 'bad-sender-pass'

test('⭐ 反向：改掉一块密文 → 拒绝，定稿文件不产生，半成品留着（INTSECRITY 退出码）',
  { timeout: 120000 }, async () => {
    const out = await tempDir()
    const s = await badSender({
      password,
      files: [{ rel: 'x.bin', data: randomBytes(4096) }],
      tamperChunk: ({ ct }) => { const b = Buffer.from(ct); b[b.length - 1] ^= 0xff; return b },
    })
    const probe = await probePeer({ base: s.base })
    const r = await runRecvCli([s.link, `--password=${password}`,
      `--fingerprint=${probe.sha256.slice(0, 8)}`, `--dir=${out}`, '--no-open', '--no-color'])
    assert.notEqual(r.code, 0, '篡改过的块必须让这次接收失败')
    assert.match(r.err + r.out, /解密失败|哈希不符|损坏/)
    const left = await readdir(out)
    assert.ok(!left.includes('x.bin'), '定稿文件不能产生')
  })

test('⭐ 反向：清单里路径不安全（`../x`）→ 整场拒绝，一个字节都不写', { timeout: 120000 }, async () => {
  const out = await tempDir()
  const s = await badSender({
    password,
    files: [{ rel: 'ok.txt', data: Buffer.from('x') }],
    mutateManifest: (wire) => { wire[0].rel = '../escape.txt' },
  })
  const probe = await probePeer({ base: s.base })
  const r = await runRecvCli([s.link, `--password=${password}`,
    `--fingerprint=${probe.sha256.slice(0, 8)}`, `--dir=${out}`, '--no-open', '--no-color'])
  assert.notEqual(r.code, 0)
  assert.match(r.err + r.out, /路径不安全/)
  assert.deepEqual(await readdir(out), [], '一个字节都不该写')
})

test('⭐ 反向：清单里两个路径会落成同一个文件 → 整场拒绝（不许静默覆盖）', { timeout: 120000 },
  async () => {
    const out = await tempDir()
    const s = await badSender({
      password,
      files: [{ rel: 'a.txt', data: Buffer.from('1') }, { rel: 'b.txt', data: Buffer.from('2') }],
      mutateManifest: (wire) => { wire[1].rel = 'A.TXT' },   // Windows/macOS 上是同一个文件
    })
    const probe = await probePeer({ base: s.base })
    const r = await runRecvCli([s.link, `--password=${password}`,
      `--fingerprint=${probe.sha256.slice(0, 8)}`, `--dir=${out}`, '--no-open', '--no-color'])
    assert.notEqual(r.code, 0)
    assert.match(r.err + r.out, /同一个文件|静默覆盖/)
    assert.deepEqual(await readdir(out), [])
  })

test('⭐ 反向：整文件摘要对不上 → 不定稿，半成品留下（INTSECRITY 退出码）', { timeout: 120000 },
  async () => {
    const out = await tempDir()
    const s = await badSender({
      password,
      files: [{ rel: 'bad.bin', data: randomBytes(2048) }],
      wrongSha: () => createHash('sha256').update('完全不同').digest('hex'),
    })
    const probe = await probePeer({ base: s.base })
    const r = await runRecvCli([s.link, `--password=${password}`,
      `--fingerprint=${probe.sha256.slice(0, 8)}`, `--dir=${out}`, '--no-open', '--no-color'])
    assert.equal(r.code, 5, `应当以 INTSECRITY(5) 失败，实际 ${r.code}：\n${r.out}${r.err}`)
    assert.match(r.err + r.out, /整文件校验失败/)
    const left = await readdir(out)
    assert.ok(!left.includes('bad.bin'), '定稿文件不能产生')
    assert.ok(left.includes('bad.bin.flicker-part'), '半成品要留下（一眼能认出来）')
  })

test('同名文件 → 自动改名，绝不覆盖（与接收模式一致）', { timeout: 120000 }, async () => {
  const out = await tempDir()
  const s = await badSender({ password, files: [{ rel: 'dup.txt', data: Buffer.from('新的') }] })
  await writeFile(path.join(out, 'dup.txt'), '旧的')
  const probe = await probePeer({ base: s.base })
  const r = await runRecvCli([s.link, `--password=${password}`,
    `--fingerprint=${probe.sha256.slice(0, 8)}`, `--dir=${out}`, '--no-open', '--no-color'])
  assert.equal(r.code, 0, `应当成功：\n${r.out}${r.err}`)
  assert.equal(String(await readFile(path.join(out, 'dup.txt'))), '旧的', '旧文件不许被动')
  const left = (await readdir(out)).sort()
  assert.deepEqual(left, ['dup (1).txt', 'dup.txt'], `应当改名保存，实际：${left.join(', ')}`)
  assert.equal(String(await readFile(path.join(out, 'dup (1).txt'))), '新的')
})

test('收完之后通知对方 /api/done（协议里的完成判据）', { timeout: 120000 }, async () => {
  const out = await tempDir()
  const s = await badSender({ password, files: [{ rel: 'one.txt', data: Buffer.from('1') }] })
  const probe = await probePeer({ base: s.base })
  const r = await runRecvCli([s.link, `--password=${password}`,
    `--fingerprint=${probe.sha256.slice(0, 8)}`, `--dir=${out}`, '--no-open', '--no-color'])
  assert.equal(r.code, 0, `${r.out}${r.err}`)
  await sleep(100)
  assert.equal(s.done, true, '必须发 /api/done —— 否则发送端会一直等下去')
})

// ── ③ 链接解析与指纹比较（纯函数）──────────────────────────

test('parseRecvLink：直连链接认得出，中继链接明确拒绝并说清怎么办', () => {
  const direct = parseRecvLink('https://192.168.1.5:8443/?k=abc-123')
  assert.equal(direct.kind, 'direct')
  assert.equal(direct.base, 'https://192.168.1.5:8443')
  assert.equal(direct.token, 'abc-123')

  const relay = parseRecvLink(`https://relay.example/room/${'a'.repeat(64)}#${'b'.repeat(22)}`)
  assert.equal(relay.kind, 'relay')
  assert.match(relay.reason, /中继链接/)
  assert.match(relay.reason, /浏览器/)

  assert.equal(parseRecvLink('https://1.2.3.4:8443/').kind, 'unsupported')
  assert.equal(parseRecvLink('不是链接').kind, 'unsupported')
  assert.equal(parseRecvLink('ftp://x/?k=1').kind, 'unsupported')
})

test('matchFingerprint：前 8 位、完整值、大小写、带分隔符都认；空值一律不认', () => {
  const full = 'A3F9C1D2E4B5A6978879'
  assert.equal(matchFingerprint(full, 'a3f9c1d2'), true)
  assert.equal(matchFingerprint(full, 'A3F9'), true)
  assert.equal(matchFingerprint(full, full.toLowerCase()), true)
  assert.equal(matchFingerprint(full, 'a3:f9:c1:d2'), true, '带冒号也要认（用户可能照抄指纹格式）')
  assert.equal(matchFingerprint(full, '00000000'), false)
  assert.equal(matchFingerprint(full, ''), false)
  assert.equal(matchFingerprint(full, null), false)
})
