/**
 * 接收模式（手机上传 → 电脑）的测试
 * ================================
 * 这一步是**协议与落盘安全**的验收（M1）。真正难的部分不是"能收"，而是这几条：
 *
 *   ① 正常路径：多文件、满块、不齐的尾块、空文件、中文名 —— 逐字节一致，且不留半成品
 *   ② **整文件校验必须能拦下篡改**：改一个字节 → 定稿文件**不产生**，半成品留在磁盘上
 *   ③ **路径不安全就中止整个会话**（`../x`、`CON`、带分隔符）—— 与接收端页面同一策略
 *   ④ 密码不对 → 401；连续失败到上限 → 会话销毁
 *   ⑤ **磁盘空间不足在开工前就拒绝**（不是传到一半才失败）
 *   ⑥ 同名文件的三种处理（改名 / 覆盖 / 跳过）都真的生效
 *   ⑦ 幂等：同一块重发不会写两遍（手机重试是常态）
 *
 * 这里的"手机"是一个 Node 客户端：**用的全是同一套套件函数**
 * （`deriveVerifier` / `deriveKeys` / `senderMac` / `sealManifest` / `sealChunk`），
 * 所以它验的是真协议，而不是我自己编的一套。
 *
 * ⚠️ 与项目惯例一致：判据要能被证伪 —— ②③⑤ 都是"故意做错，看它是否拒绝"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startReceiveServer, PART_SUFFIX } from '../src/upload-server.js'
import { Session, SessionError, MAX_AUTH_FAILURES, errorBody } from '../src/session.js'
import {
  deriveVerifier, deriveKeys, senderMac, receiverMac, sealManifest, sealChunk, PARAMS,
} from '../src/suite/flicker1.js'

const cleanups = []
test.after(async () => {
  for (const fn of cleanups.reverse()) {
    try { await fn() } catch (e) { console.error('清理失败：' + (e?.message ?? e)) }
  }
})

const PASSWORD = 'upload-test-pass'

/** 造一个"要发过去的文件树"（只造字节，不落盘） */
function makeFiles(spec) {
  return Object.entries(spec).map(([rel, buf]) => ({
    rel,
    bytes: buf,
    size: buf.length,
    chunkBytes: PARAMS.chunkBytes,
    chunks: Math.max(1, Math.ceil(buf.length / PARAMS.chunkBytes)),
    sha256: createHash('sha256').update(buf).digest('hex'),
  }))
}

/**
 * 扮演手机：一个够用的客户端。
 * 只实现协议里必须的那几步，没有多余的东西 —— 这样一旦服务端行为变了，它会立刻失败。
 */
function makePhone(base, password = PASSWORD, { token } = {}) {
  let sid = null
  let keys = null
  let profile = null
  const post = async (p, body, opts = {}) => {
    const headers = { 'Content-Type': 'application/json' }
    if (sid && !opts.noSid) headers['X-Flicker-Sid'] = sid
    const r = await fetch(`${base}${p}`, {
      method: opts.method ?? 'POST', headers,
      body: body === undefined ? undefined : (Buffer.isBuffer(body) ? body : JSON.stringify(body)),
    })
    const txt = await r.text()
    let json = null
    try { json = JSON.parse(txt) } catch { /* 非 JSON 就留 null */ }
    return { status: r.status, json, text: txt }
  }

  return {
    get sid() { return sid },
    get keys() { return keys },
    async handshake() {
      const s = await post(`/up/session?k=${encodeURIComponent(token)}`, undefined)
      assert.equal(s.status, 200, `建立会话应当成功：${s.text}`)
      const salt = Buffer.from(s.json.salt, 'base64')
      const challenge = s.json.challenge
      keys = deriveKeys(deriveVerifier(password, salt))
      const offered = s.json.macProfiles
      profile = offered.includes('v2') ? 'v2' : 'v1'
      const mac = senderMac(keys.auth, Buffer.from(challenge, 'base64'), { profile }).toString('base64')
      const a = await post('/up/auth', { mac, challenge, macProfile: profile })
      assert.equal(a.status, 200, `密码核对应当通过：${a.text}`)
      // 手机也要验服务端（它必须证明自己也知道密码）—— 这正是 role: 'receiver' 的回送
      const expected = receiverMac(keys.auth, Buffer.from(challenge, 'base64'), { profile }).toString('base64')
      assert.equal(a.json.mac, expected, '服务端回送的应答必须能被手机验过')
      sid = a.json.sid
      return a.json
    },
    /** 用**错的密码**握手（返回响应，不抛） */
    async handshakeWrong() {
      const s = await post(`/up/session?k=${encodeURIComponent(token)}`, undefined)
      const salt = Buffer.from(s.json.salt, 'base64')
      const k = deriveKeys(deriveVerifier(password + '-wrong', salt))
      const mac = senderMac(k.auth, Buffer.from(s.json.challenge, 'base64'), { profile: 'v2' }).toString('base64')
      return post('/up/auth', { mac, challenge: s.json.challenge, macProfile: 'v2' })
    },
    async sendManifest(files, mutate) {
      const wire = {
        files: files.map((f, i) => ({
          index: i, rel: f.rel, size: f.size, chunks: f.chunks,
          chunkBytes: f.chunkBytes, sha256: f.sha256,
        })),
        totalBytes: files.reduce((a, f) => a + f.size, 0),
        totalChunks: files.reduce((a, f) => a + f.chunks, 0),
      }
      if (mutate) mutate(wire)
      const sealed = sealManifest(keys.enc, Buffer.from(JSON.stringify(wire), 'utf8'))
      const body = Buffer.concat([sealed.iv, sealed.tag, sealed.ct])
      return post('/up/manifest', body)
    },
    /** 发一个文件的所有块 */
    async sendChunks(files) {
      let sent = 0
      for (let fi = 0; fi < files.length; fi++) {
        const f = files[fi]
        for (let ci = 0; ci < f.chunks; ci++) {
          const start = ci * f.chunkBytes
          const plain = f.bytes.subarray(start, Math.min(start + f.chunkBytes, f.size))
          const { ct, tag } = sealChunk(keys.enc, fi, ci, f.chunks, plain)
          const r = await post(`/up/chunk?f=${fi}&c=${ci}`, Buffer.concat([tag, ct]), { method: 'PUT' })
          assert.equal(r.status, 200, `发块 f=${fi} c=${ci} 应当成功：${r.text}`)
          sent++
        }
      }
      return sent
    },
    /** 单独发一块（可以故意改坏一个字节），用于反向验证 */
    async sendOneChunk(files, fi, ci, { corrupt = false } = {}) {
      const f = files[fi]
      const start = ci * f.chunkBytes
      const plain = f.bytes.subarray(start, Math.min(start + f.chunkBytes, f.size))
      const { ct, tag } = sealChunk(keys.enc, fi, ci, f.chunks, plain)
      const body = Buffer.concat([tag, ct])
      if (corrupt) body[body.length - 1] ^= 0xff
      const r = await fetch(`${base}/up/chunk?f=${fi}&c=${ci}`, {
        method: 'PUT', headers: { 'X-Flicker-Sid': sid }, body,
      })
      let json = null
      try { json = await r.json() } catch { /* 非 JSON 就留 null */ }
      return { status: r.status, json }
    },
    status: () => post('/up/status', undefined, { method: 'GET' }),
    finish: () => post('/up/finish', {}),
  }
}

/** 起一个接收服务 + 一个临时目录 */
async function boot(opts = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'flicker-recv-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const srv = await startReceiveServer({ dir, password: opts.password ?? PASSWORD, ...opts })
  cleanups.push(() => srv.stop())
  return { dir, srv, base: srv.url, token: srv.session.token }
}

const readOrNull = async (p) => { try { return await readFile(p) } catch { return null } }

// ── ① 正常路径 ─────────────────────────────────────────────

test('正常路径：多文件（满块 / 不齐尾块 / 空文件 / 中文名）逐字节落盘，且不留半成品', async () => {
  const { dir, base, token } = await boot()
  const files = makeFiles({
    '满块.bin': randomBytes(PARAMS.chunkBytes),
    '尾块.bin': randomBytes(PARAMS.chunkBytes + 777),
    '空.txt': Buffer.alloc(0),
    'note.md': Buffer.from('# 手机传来的\n', 'utf8'),
  })
  const phone = makePhone(base, PASSWORD, { token })
  await phone.handshake()
  const m = await phone.sendManifest(files)
  assert.equal(m.status, 200, `清单应当被接受：${m.text}`)
  assert.equal(m.json.accepted.length, 4)
  await phone.sendChunks(files)
  const st = await phone.status()
  assert.equal(st.json.receivedChunks, st.json.totalChunks, '所有块都应当收到')

  const fin = await phone.finish()
  assert.equal(fin.status, 200, `收尾应当成功：${fin.text}`)
  assert.equal(fin.json.failed.length, 0, '不应当有失败的文件：' + JSON.stringify(fin.json.failed))
  assert.equal(fin.json.done.length, 4)

  for (const f of files) {
    const got = await readFile(path.join(dir, f.rel))
    assert.equal(Buffer.compare(got, f.bytes), 0, `${f.rel} 应当逐字节一致`)
    assert.equal(await readOrNull(path.join(dir, f.rel + PART_SUFFIX)), null,
      `${f.rel} 定稿后不该留下半成品`)
  }
})

// ── ② 反向：改一个字节必须被拦下 ───────────────────────────

test('⭐ 反向验证：把一块的密文改一个字节 → 块校验当场拒绝（400 E_CHUNK_AUTH），且不留半成品', async () => {
  const { dir, base, token } = await boot()
  const files = makeFiles({ 'x.bin': randomBytes(4096) })
  const phone = makePhone(base, PASSWORD, { token })
  await phone.handshake()
  await phone.sendManifest(files)

  const bad = await phone.sendOneChunk(files, 0, 0, { corrupt: true })
  assert.equal(bad.status, 400, `坏块必须被拒（实际 ${bad.status} ${JSON.stringify(bad.json)}）`)
  assert.equal(bad.json.error, 'E_CHUNK_AUTH')
  assert.equal(await readOrNull(path.join(dir, 'x.bin' + PART_SUFFIX)), null,
    '坏块不该在磁盘上留下任何东西')

  // 一次坏块不该毁掉整个会话：接着发**好的**那一块，仍然要能收下并定稿
  const good = await phone.sendOneChunk(files, 0, 0)
  assert.equal(good.status, 200, `修好之后应当能收下：${JSON.stringify(good.json)}`)
  const fin = await phone.finish()
  assert.equal(fin.json.done.length, 1, '一次坏块之后仍然应当能正常收尾')
  const got = await readFile(path.join(dir, 'x.bin'))
  assert.equal(Buffer.compare(got, files[0].bytes), 0)
})

test('⭐ 反向验证：整文件摘要对不上 → **不定稿**，半成品留在磁盘上（可查、不污染正常文件）', async () => {
  const { dir, base, token } = await boot()
  // 故意声明一个错的 sha256（清单里的摘要与内容不符）
  const real = randomBytes(3000)
  const files = makeFiles({ 'fake.bin': real })
  files[0].sha256 = createHash('sha256').update(Buffer.from('别的内容')).digest('hex')
  const phone = makePhone(base, PASSWORD, { token })
  await phone.handshake()
  await phone.sendManifest(files)
  await phone.sendChunks(files)

  const fin = await phone.finish()
  assert.equal(fin.status, 200)
  assert.equal(fin.json.done.length, 0, '摘不对就不该定稿')
  assert.equal(fin.json.failed.length, 1)
  assert.match(fin.json.failed[0].reason, /整文件校验不通过/)
  assert.equal(await readOrNull(path.join(dir, 'fake.bin')), null, '**不能**产生正式文件')
  const part = await readOrNull(path.join(dir, 'fake.bin' + PART_SUFFIX))
  assert.ok(part && Buffer.compare(part, real) === 0,
    '半成品应当保留在磁盘上（内容就是收到的字节，供排查）')
})

// ── ③ 反向：路径安全 ──────────────────────────────────────

test('⭐ 反向验证：清单里的文件名不安全 → **中止整个会话**，且磁盘上什么都没写', async () => {
  // ⚠️ `CON` 只在 **Windows 上**是不安全的名字（`src/path-safety.js` 的 R8 按平台生效）。
  //    2026-10 的 Linux CI 第一次跑就红了：断言"CON 必须被拒"，而 Linux 上它是完全合法的
  //    文件名，服务端接受它才是**正确**行为。所以这条用例按平台取输入表。
  const cases = [
    ['上跳目录', '../evil.txt'],
    ['带分隔符', 'sub/dir.txt'],
  ]
  if (process.platform === 'win32') cases.push(['Windows 保留名', 'CON'])
  for (const [label, rel] of cases) {
    const { dir, base, token } = await boot()
    const files = makeFiles({ 'ok.txt': Buffer.from('hi'), [rel]: Buffer.from('x') })
    // 手工构造清单：`rel` 保持原样（不让 makeFiles 之外的东西介入）
    files[files.length - 1].rel = rel
    const phone = makePhone(base, PASSWORD, { token })
    await phone.handshake()
    const m = await phone.sendManifest(files)
    assert.ok(m.status >= 400, `${label}：不安全的名字必须被拒（实际 ${m.status}）`)
    assert.match(m.json.error, /E_PATH_UNSAFE|E_MANIFEST_DUPLICATE_PATH|BAD/)
    // 中止 = 销毁：所以后续请求拿到的是 410「会话已销毁」，而不是 401。
    // 两个码都算"不可用"，但必须真的不可用 —— 这里只允许这两种。
    const after = await phone.status()
    assert.ok([401, 410].includes(after.status),
      `${label}：中止之后会话必须已经不可用（实际 ${after.status} ${after.text ?? ''}）`)
    const list = await readFile(path.join(dir, 'ok.txt')).catch(() => null)
    assert.equal(list, null, `${label}：中止的会话不该写出任何文件`)
  }
})

// ── ④ 密码与失败次数 ──────────────────────────────────────

test('密码不对 → 401 BAD_PASSWORD；失败到上限 → 会话销毁（这条在 Session 上直接验，不受一次性令牌干扰）', async () => {
  const { base, token } = await boot()
  const phone = makePhone(base, PASSWORD, { token })
  const first = await phone.handshakeWrong()
  assert.equal(first.status, 401, `密码错应当是 401：${first.text}`)
  assert.equal(first.json.error, 'BAD_PASSWORD')

  // 一次性令牌只能建一次会话，所以"失败次数上限"直接在 Session 上验：
  // 每次都用新挑战、都给错的 MAC。
  // 逐次记下错误码 —— 这条要盯的是**顺序**：前 4 次是普通的"密码不对"，
  // 第 5 次（正好到上限）必须把"会话因此没了"一起说清，之后再用这个会话只能拿到
  // TOO_MANY_FAILURES（而不是笼统的 DESTROYED，那样界面就没法解释原因）。
  const s = new Session({ password: PASSWORD, role: 'receiver' })
  const codes = []
  const messages = []
  for (let i = 0; i < 8; i++) {
    try {
      const a = s.startAuth()
      s.finishAuth({ mac: Buffer.alloc(32).toString('base64'), challenge: a.challenge, macProfile: 'v2' })
    } catch (e) { codes.push(e.code); messages.push(e.message); if (e.code === 'TOO_MANY_FAILURES') break }
  }
  assert.deepEqual(codes, [
    ...Array(MAX_AUTH_FAILURES - 1).fill('BAD_PASSWORD'),
    'BAD_PASSWORD',          // 第 5 次：这一次把会话打死了，但错因仍然是"密码不一致"
    'TOO_MANY_FAILURES',     // 第 6 次：再用就明确告诉你"是失败次数到上限"
  ], `失败到上限的过程应当是 ${MAX_AUTH_FAILURES} 次 BAD_PASSWORD 然后 TOO_MANY_FAILURES`)
  assert.match(messages[MAX_AUTH_FAILURES - 1], /达到上限.*已销毁/,
    '第 5 次的回复必须同时说清"密码错了"和"会话已经没了"')
  assert.equal(s.destroyed, true, '到上限之后会话必须是销毁状态')
  assert.equal(s.failures, MAX_AUTH_FAILURES, '失败计数应当正好停在上限')
  assert.ok(MAX_AUTH_FAILURES >= 3, '上限至少要有 3 次（给人输错的机会）')
  // 上限对应的 HTTP 状态码：410 —— 手机据此区分"还能再试"（401）和"没得试了"（410）
  assert.equal(errorBody(new SessionError('认证失败次数过多，会话已销毁', 'TOO_MANY_FAILURES')).status, 410)
})

test('没带会话 ID 就想上传 → 401（会话是唯一入口，没有匿名写入这回事）', async () => {
  const { base, token } = await boot()
  for (const [label, p, method] of [
    ['清单', '/up/manifest', 'POST'],
    ['分块', '/up/chunk?f=0&c=0', 'PUT'],
    ['状态', '/up/status', 'GET'],
  ]) {
    // ⚠️ GET 不能带 body（undici 会直接抛 TypeError），所以按方法决定带不带
    const r = await fetch(`${base}${p}`, method === 'GET'
      ? { method }
      : { method, body: Buffer.alloc(40) })
    assert.equal(r.status, 401, `${label}：没有会话 ID 应当是 401（实际 ${r.status}）`)
    // 还没认证过 —— 所以码是 NOT_AUTHED（"先去认证"），而不是笼统的 NO_SID
    assert.equal((await r.json()).error, 'NOT_AUTHED', `${label}：应当指明"尚未认证"`)
  }
  // 认证之后，拿**别人的**（错的）会话 ID 来写 → 401 BAD_SID：不许顶掉已建立的会话
  const phone = makePhone(base, PASSWORD, { token })
  await phone.handshake()
  const files = makeFiles({ 'a.txt': Buffer.from('hi') })
  const wire = JSON.stringify({ files: files.map((f, i) => ({ index: i, rel: f.rel, size: f.size, chunks: 1, chunkBytes: f.chunkBytes, sha256: f.sha256 })), totalBytes: 2, totalChunks: 1 })
  const sealed = sealManifest(phone.keys.enc, Buffer.from(wire, 'utf8'))
  const bad = await fetch(`${base}/up/manifest`, {
    // ⚠️ HTTP 头只能是 latin1，中文放进去 undici 会直接抛
    method: 'POST', headers: { 'X-Flicker-Sid': 'not-my-session-id' },
    body: Buffer.concat([sealed.iv, sealed.tag, sealed.ct]),
  })
  assert.equal(bad.status, 401)
  assert.equal((await bad.json()).error, 'BAD_SID', '错的会话 ID 必须被认出来')
})

// ── ⑤ 磁盘空间 ────────────────────────────────────────────

test('⭐ 磁盘空间不足 → 开工前拒绝（507），磁盘上一个文件都不写', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'flicker-recv-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  // 注入一个"只剩 1 KB"的假 statfs —— 不真去填满磁盘
  const srv = await startReceiveServer({
    dir, password: PASSWORD,
    deps: { statfs: async () => ({ bavail: 1, bsize: 1024 }) },
  })
  cleanups.push(() => srv.stop())
  const files = makeFiles({ 'big.bin': randomBytes(1024 * 1024) })
  const phone = makePhone(srv.url, PASSWORD, { token: srv.session.token })
  await phone.handshake()
  const m = await phone.sendManifest(files)
  assert.equal(m.status, 507, `空间不足应当是 507：${m.text}`)
  assert.match(m.json.error, /NO_SPACE/)
  assert.match(m.json.message, /可用/, '要说清可用多少、需要多少')
  const files2 = await readFile(path.join(dir, 'big.bin')).catch(() => null)
  assert.equal(files2, null)
})

// ── ⑥ 同名文件三种处理 ────────────────────────────────────

test('同名文件的三种处理都真的生效：改名 / 覆盖 / 跳过', async () => {
  // 改名用的是 `dedupeRelPath`（与发送端、接收端页面同一套规则）：`a.txt` → `a (1).txt`，
  // 序号加在**扩展名之前**（资源管理器 / macOS 那边的习惯），不是浏览器下载那样的 `a.txt (1)`。
  const cases = [
    ['rename', async (dir) => {
      await writeFile(path.join(dir, 'a.txt'), '旧内容', 'utf8')
      return { expectRel: 'a (1).txt', expectOld: '旧内容' }
    }],
    ['overwrite', async (dir) => {
      await writeFile(path.join(dir, 'a.txt'), '旧内容', 'utf8')
      return { expectRel: 'a.txt', expectOld: null }
    }],
    ['skip', async (dir) => {
      await writeFile(path.join(dir, 'a.txt'), '旧内容', 'utf8')
      return { expectRel: null, expectOld: '旧内容' }
    }],
  ]
  for (const [choice, prepare] of cases) {
    const dir = await mkdtemp(path.join(tmpdir(), 'flicker-recv-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    await mkdir(dir, { recursive: true })
    const { expectRel, expectOld } = await prepare(dir)
    const asked = []
    const srv = await startReceiveServer({
      dir, password: PASSWORD,
      onCollision: async (info) => { asked.push(info.rel); return choice },
    })
    cleanups.push(() => srv.stop())
    const NEW = Buffer.from('新内容-new')
    const files = makeFiles({ 'a.txt': NEW })
    const phone = makePhone(srv.url, PASSWORD, { token: srv.session.token })
    await phone.handshake()
    const m = await phone.sendManifest(files)
    assert.equal(m.status, 200, `${choice}: 清单应当被接受：${m.text}`)
    assert.deepEqual(asked, ['a.txt'], `${choice}: 应当问过一次`)

    if (choice === 'skip') {
      assert.deepEqual(m.json.accepted, [], '跳过时不该接受任何文件')
      assert.equal(await readFile(path.join(dir, 'a.txt'), 'utf8'), expectOld)
      continue
    }
    await phone.sendChunks(files)
    const fin = await phone.finish()
    assert.equal(fin.status, 200, `${choice}: ${fin.text}`)
    assert.equal(fin.json.done.length, 1, `${choice}: 应当定稿一个文件`)
    const got = await readFile(path.join(dir, expectRel))
    assert.equal(Buffer.compare(got, NEW), 0, `${choice}: 内容应当是新的（落在 ${expectRel}）`)
    if (choice === 'overwrite') {
      assert.equal(await readOrNull(path.join(dir, 'a (1).txt')), null, '覆盖时不该再产生改名副本')
    } else {
      assert.equal(await readFile(path.join(dir, 'a.txt'), 'utf8'), expectOld,
        '改名时旧文件必须原封不动')
    }
  }
})

// ── ⑦ 幂等与缺块 ──────────────────────────────────────────

test('幂等：同一块重发不会写两遍（手机重试是常态）', async () => {
  const { dir, base, token } = await boot()
  const files = makeFiles({ 'idem.bin': randomBytes(2000) })
  const phone = makePhone(base, PASSWORD, { token })
  await phone.handshake()
  await phone.sendManifest(files)
  const { ct, tag } = sealChunk(phone.keys.enc, 0, 0, 1, files[0].bytes)
  const body = Buffer.concat([tag, ct])
  const put = () => fetch(`${base}/up/chunk?f=0&c=0`, {
    method: 'PUT', headers: { 'X-Flicker-Sid': phone.sid }, body,
  })
  const first = await put()
  assert.equal(first.status, 200)
  const second = await put()
  assert.equal(second.status, 200)
  assert.equal((await second.json()).already, true, '第二次应当是"已经收到过"')

  await phone.finish()
  const got = await readFile(path.join(dir, 'idem.bin'))
  assert.equal(Buffer.compare(got, files[0].bytes), 0, '重发之后内容仍然正确')
})

test('缺块就收尾 → 409 INCOMPLETE，并且说清缺了多少块', async () => {
  const { base, token } = await boot()
  const files = makeFiles({ 'two.bin': randomBytes(PARAMS.chunkBytes + 10) })
  const phone = makePhone(base, PASSWORD, { token })
  await phone.handshake()
  await phone.sendManifest(files)
  // 只发第一块
  const first = files[0].bytes.subarray(0, PARAMS.chunkBytes)
  const { ct, tag } = sealChunk(phone.keys.enc, 0, 0, files[0].chunks, first)
  await fetch(`${base}/up/chunk?f=0&c=0`, {
    method: 'PUT', headers: { 'X-Flicker-Sid': phone.sid }, body: Buffer.concat([tag, ct]),
  })
  const fin = await phone.finish()
  assert.equal(fin.status, 409)
  assert.match(fin.json.error, /INCOMPLETE/)
  assert.match(fin.json.message, /缺 1/, '要说清缺几块')
})

// ── ⑧ 清单自身的自洽性 ────────────────────────────────────

test('清单里的分块参数不自洽 → 开工前拒绝（块大小 / 分块数）', async () => {
  const { base, token } = await boot()
  const phone = makePhone(base, PASSWORD, { token })
  await phone.handshake()

  const files = makeFiles({ 'a.bin': randomBytes(1000) })
  const tooBig = await phone.sendManifest(files, (w) => { w.files[0].chunkBytes = PARAMS.chunkBytes * 4 })
  assert.ok(tooBig.status >= 400, '超过本机允许的单条上限必须被拒')
  assert.match(tooBig.json.error, /BAD_CHUNK_BYTES/)
})

test('文件数超过上限 → 拒绝（防止有人拿一堆空文件灌进来）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'flicker-recv-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const srv = await startReceiveServer({ dir, password: PASSWORD, limits: { maxFiles: 3 } })
  cleanups.push(() => srv.stop())
  const files = makeFiles({ 'a.txt': Buffer.from('1'), 'b.txt': Buffer.from('2'), 'c.txt': Buffer.from('3'), 'd.txt': Buffer.from('4') })
  const phone = makePhone(srv.url, PASSWORD, { token: srv.session.token })
  await phone.handshake()
  const m = await phone.sendManifest(files)
  assert.ok(m.status >= 400)
  assert.match(m.json.error, /TOO_MANY_FILES/)
})

test('会话销毁之后：接口不再接受任何操作（密钥也已清零）', async () => {
  const { base, token, srv } = await boot()
  const phone = makePhone(base, PASSWORD, { token })
  await phone.handshake()
  // ⚠️ 销毁会把 `session.keys` 整个置成 null，所以"清零"必须**先抓住那块内存**再验：
  //    验的是同一块缓冲区真的被 fill(0) 过，而不是"对象上已经没有这个字段了"。
  const enc = srv.session.keys.enc
  const room = srv.session.keys.room
  assert.ok(enc.some((b) => b !== 0), '前提：销毁前密钥不是全零（否则这条等于没验）')
  await srv.close()
  // 销毁之后**每一个**端点都必须关门 —— 不能只有状态查询关掉了，写入还开着。
  // 状态码是 410（曾经存在、现在没了），不是 401：401 会被手机理解成"再试一次也许行"。
  for (const [label, r] of [
    ['状态', await phone.status()],
    ['清单', await phone.sendManifest(makeFiles({ 'z.txt': Buffer.from('z') }))],
    ['分块', await phone.sendOneChunk(makeFiles({ 'z.txt': Buffer.from('z') }), 0, 0)],
    ['收尾', await phone.finish()],
  ]) {
    assert.equal(r.status, 410, `${label}：会话关掉之后必须是 410 Gone（实际 ${r.status}）`)
    assert.equal(r.json?.error, 'DESTROYED', `${label}：码应当是 DESTROYED（实际 ${r.json?.error}）`)
  }
  assert.ok(enc.every((b) => b === 0) && room.every((b) => b === 0), '销毁时密钥必须就地清零')
  assert.equal(srv.session.keys, null, '销毁后连密钥对象的引用都不该留着')
  assert.equal(srv.session.sid, null, '销毁时会话 ID 也必须清掉')
})

test('服务的 report 是**活的**：定稿前是 null，定稿后立刻能读到落盘清单', async () => {
  // ⚠️ 这条盯的是一个很隐蔽的坑：`createReceiveSession` 的 `report` 是 getter，
  //    而 `startReceiveServer` 用 `...receive` 展开它 —— 展开会**当场求值一次**，
  //    于是拿到的永远是 `undefined`（"一个文件都没收下"）。
  //    GUI 里就这么显示过一次"0 个文件"，而文件其实好好地在磁盘上。
  const { dir, base, token, srv } = await boot()
  assert.equal(srv.report, null, '还没定稿时应当是 null（不是 undefined）')
  const files = makeFiles({ 'r.txt': Buffer.from('report 是活的'), 'e.bin': Buffer.alloc(0) })
  const phone = makePhone(base, PASSWORD, { token })
  await phone.handshake()
  await phone.sendManifest(files)
  await phone.sendChunks(files)
  const fin = await phone.finish()
  assert.equal(fin.status, 200)
  assert.ok(srv.report, '定稿之后必须能读到 report')
  assert.equal(srv.report.done.length, 2, 'report 里应当是两个文件')
  assert.deepEqual(srv.report.done.map((d) => d.rel).sort(), ['e.bin', 'r.txt'])
  assert.equal(await readOrNull(path.join(dir, 'r.txt')) === null, false)
})

test('收到的文件在磁盘上真的是"完整文件"，不是只有大小对', async () => {
  // 这条盯的是"边收边写 + 按偏移写"最容易出的错：写到错的位置上，长度对而内容错。
  const { dir, base, token } = await boot()
  const big = randomBytes(PARAMS.chunkBytes * 2 + 1234)
  const files = makeFiles({ 'three-chunks.bin': big })
  const phone = makePhone(base, PASSWORD, { token })
  await phone.handshake()
  await phone.sendManifest(files)
  await phone.sendChunks(files)
  await phone.finish()
  const got = await readFile(path.join(dir, 'three-chunks.bin'))
  assert.equal(got.length, big.length)
  assert.equal(createHash('sha256').update(got).digest('hex'),
    createHash('sha256').update(big).digest('hex'),
    '三块文件的摘要必须一致（内容写错位置会在这里露出来）')
  const st = await stat(path.join(dir, 'three-chunks.bin'))
  assert.equal(st.size, big.length)
})
