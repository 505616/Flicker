/**
 * 接收端进程平面（`flicker recv` 的插件）
 * ======================================
 *
 * 这是插件的**第四个平面**。判据的重点不是"事件表写了什么"，而是四件容易装作做到的事：
 *
 *   ① **事件真的按顺序发出来** —— `peer → auth → manifest → collision → file-done → complete`，
 *      顺序是协议的一部分（插件拿它写审计日志，顺序错了日志就是假的）；
 *   ② **校验不过时发的是 `receive/file-failed`，不是 `receive/file-done`** ——
 *      一个只在成功时才发事件的钩子是没法记账的；
 *   ③ **插件出错不打断接收** —— 对方正在推文件，一个插件写坏了不该让传输失败；
 *      但错误不能消失（进 `plugins.errors`，收尾时打印）；
 *   ④ **用错平面当场报错** —— 从前只拦"拼错的名字"，一个订阅 `run/start` 的接收插件
 *      会安静地什么都不做。现在两个方向都拦。
 *
 * 这里的"手机"是一个 Node 客户端，用的全是同一套套件函数 —— 验的是真协议。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startReceiveServer, PART_SUFFIX } from '../src/upload-server.js'
import { startReceiveService, waitForReceive } from '../src/recv.js'
import { createPluginRegistry } from '../src/plugin/registry.js'
import { EVENTS, PLANE_OF, PLUGIN_TABLE } from '../src/plugin/events.js'
import { PAGE_HOOKS, PAGE_SLOTS } from '../web/page-plugin-runtime.mjs'
import {
  deriveVerifier, deriveKeys, senderMac, receiverMac, sealManifest, sealChunk, PARAMS,
} from '../src/suite/flicker1.js'

const cleanups = []
test.after(async () => {
  for (const fn of cleanups.reverse()) {
    try { await fn() } catch (e) { console.error('清理失败：' + (e?.message ?? e)) }
  }
})

const PASSWORD = 'recv-plugin-pass'

/** 建一个临时目录（登记清理 —— 项目规矩：不在系统临时区留垃圾） */
async function tempDir(prefix = 'flicker-recv-plugin-') {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/**
 * 写一个"记录型插件"：把每次事件按顺序记进 `globalThis.__recvEvents`。
 *
 * 用真文件而不是构造函数 —— 插件是从磁盘加载的（`load()` 会真的 require 它），
 * 这样连"文件里的写法能不能跑"一并验了。
 */
async function recordingPlugins({ body = '', name = 'recorder' } = {}) {
  const dir = await tempDir()
  const file = path.join(dir, `${name}.cjs`)
  await writeFile(file, `
    globalThis.__recvEvents = globalThis.__recvEvents || []
    const push = (name) => (e) => { globalThis.__recvEvents.push({ name, payload: e }) }
    module.exports = {
      name: ${JSON.stringify(name)},
      apiVersion: 1,
      apply(ctx) {
        ${body || [
          "ctx.on('receive/peer', push('receive/peer'))",
          "ctx.on('receive/auth', push('receive/auth'))",
          "ctx.on('receive/manifest', push('receive/manifest'))",
          "ctx.on('receive/collision', push('receive/collision'))",
          "ctx.on('receive/file-done', push('receive/file-done'))",
          "ctx.on('receive/file-failed', push('receive/file-failed'))",
          "ctx.on('receive/complete', push('receive/complete'))",
          "ctx.on('receive/ready', push('receive/ready'))",
          "ctx.on('receive/closed', push('receive/closed'))",
        ].join('\n        ')}
      },
    }
  `, 'utf8')
  const plugins = createPluginRegistry({ planes: ['receive'], log: () => {} })
  await plugins.load([file])
  return plugins
}

const events = () => globalThis.__recvEvents ?? []
const names = () => events().map((e) => e.name)

/** 造"要推上去的文件" */
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

/** 扮演手机（只实现协议里必须的那几步） */
function makePhone(base, token, password = PASSWORD) {
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
    const text = await r.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* 非 JSON 就留 null */ }
    return { status: r.status, json, text }
  }
  return {
    async handshake() {
      const s = await post(`/up/session?k=${encodeURIComponent(token)}`, undefined)
      assert.equal(s.status, 200, `建立会话应当成功：${s.text}`)
      keys = deriveKeys(deriveVerifier(password, Buffer.from(s.json.salt, 'base64')))
      profile = s.json.macProfiles.includes('v2') ? 'v2' : 'v1'
      const challenge = Buffer.from(s.json.challenge, 'base64')
      const a = await post('/up/auth', {
        mac: senderMac(keys.auth, challenge, { profile }).toString('base64'),
        challenge: s.json.challenge, macProfile: profile,
      })
      assert.equal(a.status, 200, `密码核对应当通过：${a.text}`)
      assert.equal(a.json.mac, receiverMac(keys.auth, challenge, { profile }).toString('base64'))
      sid = a.json.sid
    },
    async sendManifest(files) {
      const wire = {
        files: files.map((f, i) => ({
          index: i, rel: f.rel, size: f.size, chunks: f.chunks,
          chunkBytes: f.chunkBytes, sha256: f.sha256,
        })),
        totalBytes: files.reduce((a, f) => a + f.size, 0),
        totalChunks: files.reduce((a, f) => a + f.chunks, 0),
      }
      const sealed = sealManifest(keys.enc, Buffer.from(JSON.stringify(wire), 'utf8'))
      return post('/up/manifest', Buffer.concat([sealed.iv, sealed.tag, sealed.ct]))
    },
    async sendChunks(files, { corruptLastByteOf } = {}) {
      for (let fi = 0; fi < files.length; fi++) {
        const f = files[fi]
        for (let ci = 0; ci < f.chunks; ci++) {
          const start = ci * f.chunkBytes
          const plain = f.bytes.subarray(start, Math.min(start + f.chunkBytes, f.size))
          const { ct, tag } = sealChunk(keys.enc, fi, ci, f.chunks, plain)
          let body = Buffer.concat([tag, ct])
          if (corruptLastByteOf && corruptLastByteOf.fi === fi && corruptLastByteOf.ci === ci) {
            body = Buffer.from(body)
            body[body.length - 1] ^= 0xff
          }
          const r = await post(`/up/chunk?f=${fi}&c=${ci}`, body, { method: 'PUT' })
          assert.equal(r.status, 200, `发块 f=${fi} c=${ci} 应当成功：${r.text}`)
        }
      }
    },
    finish: () => post('/up/finish', {}),
  }
}

/** 起一个明文 HTTP 接收服务（带插件）+ 临时目录 */
async function boot({ plugins = null, filesOnDisk = null } = {}) {
  const dir = await tempDir()
  if (filesOnDisk) {
    for (const [rel, buf] of Object.entries(filesOnDisk)) await writeFile(path.join(dir, rel), buf)
  }
  const srv = await startReceiveServer({ dir, password: PASSWORD, plugins })
  cleanups.push(() => srv.stop())
  return { dir, srv, base: srv.url, token: srv.session.token }
}

// ── ① 事件真的按顺序发出来 ─────────────────────────────────

test('⭐ 一次真实上传：接收平面的事件按顺序发出，且内容对得上', async () => {
  globalThis.__recvEvents = []
  const plugins = await recordingPlugins()
  const { base, token } = await boot({ plugins })
  const files = makeFiles({ 'a.txt': Buffer.from('hello\n', 'utf8'), 'b.bin': randomBytes(5000) })

  const phone = makePhone(base, token)
  await phone.handshake()
  const m = await phone.sendManifest(files)
  assert.equal(m.status, 200, `清单应当被接受：${m.text}`)
  await phone.sendChunks(files)
  const fin = await phone.finish()
  assert.equal(fin.status, 200, `收尾应当成功：${fin.text}`)

  // 顺序就是协议的一部分：审计日志靠它
  assert.deepEqual(names(), [
    'receive/peer', 'receive/auth', 'receive/manifest',
    'receive/file-done', 'receive/file-done', 'receive/complete',
  ], '事件的顺序必须与真实发生的顺序一致（实际：' + names().join(' → ') + '）')

  const byName = (n) => events().filter((e) => e.name === n)
  assert.equal(byName('receive/manifest')[0].payload.files, 2)
  assert.equal(byName('receive/manifest')[0].payload.skipped, 0)
  assert.equal(byName('receive/manifest')[0].payload.totalBytes, files.reduce((a, f) => a + f.size, 0))
  assert.equal(byName('receive/manifest')[0].payload.totalChunks, files.reduce((a, f) => a + f.chunks, 0))
  assert.equal(byName('receive/file-done')[0].payload.rel, 'a.txt')
  assert.equal(byName('receive/file-done')[0].payload.bytes, 6)
  assert.deepEqual(byName('receive/complete')[0].payload.done.sort(), ['a.txt', 'b.bin'])
  assert.deepEqual(byName('receive/complete')[0].payload.failed, [])
})

test('事件负载里**没有密码、也没有一次性令牌**（凭据不交给插件）', async () => {
  globalThis.__recvEvents = []
  const plugins = await recordingPlugins()
  const { base, token } = await boot({ plugins })
  const phone = makePhone(base, token)
  await phone.handshake()
  await phone.sendManifest(makeFiles({ 'x.txt': Buffer.from('x') }))
  await phone.sendChunks(makeFiles({ 'x.txt': Buffer.from('x') }))

  const dump = JSON.stringify(events())
  assert.equal(dump.includes(PASSWORD), false, '密码绝不能出现在插件事件里')
  assert.equal(dump.includes(token), false, '一次性令牌绝不能出现在插件事件里')
})

test('同名文件：先发 `receive/collision`，决定权仍在用户（订阅者改不了结果）', async () => {
  globalThis.__recvEvents = []
  const plugins = await recordingPlugins()
  const { dir, base, token } = await boot({ plugins, filesOnDisk: { 'same.txt': Buffer.from('旧内容') } })
  const files = makeFiles({ 'same.txt': Buffer.from('新内容') })
  const phone = makePhone(base, token)
  await phone.handshake()
  const m = await phone.sendManifest(files)      // 没给 onCollision → 自动改名
  assert.equal(m.status, 200, m.text)
  assert.equal(m.json.accepted[0].rel, 'same (1).txt', '默认策略仍然是最安全的"改名"')
  assert.equal(names().includes('receive/collision'), true, '撞名时必须通知插件')
  const evt = events().find((e) => e.name === 'receive/collision')
  assert.equal(evt.payload.rel, 'same.txt')
  assert.match(evt.payload.existing, /same\.txt$/, '要给出磁盘上的那个路径')
  // 旧文件原封不动
  assert.equal(String(await readFile(path.join(dir, 'same.txt'))), '旧内容')
})

// ── ② 失败要发 file-failed，不是 file-done ─────────────────

test('⭐ 整文件摘要对不上 → 发 `receive/file-failed`（不是 file-done），半成品留下', async () => {
  globalThis.__recvEvents = []
  const plugins = await recordingPlugins()
  const dir = await tempDir()
  const srv = await startReceiveServer({ dir, password: PASSWORD, plugins })
  cleanups.push(() => srv.stop())

  const bytes = randomBytes(3000)
  // 清单里声明一个不可能对上的摘要 —— 这就是"传输途中被改过"的样子
  const files = [{
    rel: 'bad.bin', bytes, size: bytes.length,
    chunkBytes: PARAMS.chunkBytes, chunks: 1,
    sha256: createHash('sha256').update('完全不同').digest('hex'),
  }]
  const phone = makePhone(srv.url, srv.session.token)
  await phone.handshake()
  const m = await phone.sendManifest(files)
  assert.equal(m.status, 200, m.text)
  await phone.sendChunks(files)
  const fin = await phone.finish()
  assert.equal(fin.status, 200, `收尾请求本身应当成功（失败写在报告里）：${fin.text}`)
  assert.equal(fin.json.failed.length, 1)
  assert.equal(fin.json.done.length, 0)

  assert.equal(names().includes('receive/file-done'), false, '校验不出结果就不能发"定稿"')
  const bad = events().find((e) => e.name === 'receive/file-failed')
  assert.ok(bad, '必须发 file-failed（实际：' + names().join(' → ') + '）')
  assert.equal(bad.payload.rel, 'bad.bin')
  assert.match(bad.payload.reason, /整文件校验不通过/)
  // 半成品按设计留着（一眼能认出来，不污染正常文件）
  const left = await readdir(dir)
  assert.equal(left.includes('bad.bin'), false, '不能产出正式文件名')
  assert.equal(left.includes('bad.bin' + PART_SUFFIX), true, '半成品要留着')
})

// ── ③ 插件出错不打断接收，但错误要如实记下 ─────────────────

test('⭐ 插件在某事件里抛错：接收照常完成，错误进 plugins.errors（不静默）', async () => {
  globalThis.__recvEvents = []
  const plugins = await recordingPlugins({
    name: 'boom',
    body: `
      ctx.on('receive/manifest', () => { throw new Error('故意炸') })
      ctx.on('receive/file-done', (e) => { globalThis.__recvEvents.push({ name: 'receive/file-done', payload: e }) })
    `,
  })
  const { dir, base, token } = await boot({ plugins })
  const files = makeFiles({ 'ok.txt': Buffer.from('still fine') })
  const phone = makePhone(base, token)
  await phone.handshake()
  const m = await phone.sendManifest(files)
  assert.equal(m.status, 200, '插件炸了也不能让清单这一步失败')
  await phone.sendChunks(files)
  const fin = await phone.finish()
  assert.equal(fin.status, 200, '插件炸了也不能让收尾失败')
  assert.equal(fin.json.done.length, 1)
  assert.equal(String(await readFile(path.join(dir, 'ok.txt'))), 'still fine')

  const errs = plugins.errors
  assert.equal(errs.length, 1, '错误必须留痕（实际：' + JSON.stringify(errs) + '）')
  assert.match(errs[0], /boom/)
  assert.match(errs[0], /receive\/manifest/)
  assert.match(errs[0], /故意炸/)
  // 出错只影响它自己那一刻，后续事件照常送达
  assert.equal(names().includes('receive/file-done'), true)
})

// ── ④ 平面判据：用错平面当场报错 ───────────────────────────

test('⭐ 接收平面里订阅发送端的事件 → 当场报错，并点明两个平面', async () => {
  const dir = await tempDir()
  const file = path.join(dir, 'wrong.cjs')
  await writeFile(path.join(dir, 'wrong.cjs'),
    'module.exports = { name: "wrong", apiVersion: 1, ' +
    'apply(ctx) { ctx.on("run/start", () => {}) } }\n', 'utf8')
  const plugins = createPluginRegistry({ planes: ['receive'], log: () => {} })
  await assert.rejects(() => plugins.load([file]), (e) => {
    assert.match(e.message, /run\/start/)
    assert.match(e.message, /sender/)
    assert.match(e.message, /receive/)
    assert.match(e.message, /receive\/ready/, '要列出本平面可用的钩子（照着改就行）')
    return true
  })
})

test('发送平面里订阅接收端进程的事件 → 同样当场报错（两条方向都要拦）', async () => {
  const dir = await tempDir()
  const file = path.join(dir, 'wrong2.cjs')
  await writeFile(file,
    'module.exports = { name: "wrong2", apiVersion: 1, ' +
    'apply(ctx) { ctx.on("receive/manifest", () => {}) } }\n', 'utf8')
  const plugins = createPluginRegistry({ planes: ['sender'], log: () => {} })
  await assert.rejects(() => plugins.load([file]), (e) => {
    assert.match(e.message, /receive\/manifest/)
    assert.match(e.message, /run\/start/, '要列出本平面可用的钩子')
    return true
  })
})

test('`--plugins` 的宽松模式（planes: null）能加载任意平面的插件 —— 它只用来校验写法', async () => {
  const dir = await tempDir()
  const file = path.join(dir, 'both.cjs')
  await writeFile(file,
    'module.exports = { name: "both", apiVersion: 1, apply(ctx) {' +
    '  ctx.on("run/start", () => {}); ctx.on("receive/ready", () => {}) } }\n', 'utf8')
  const plugins = createPluginRegistry({ planes: null, log: () => {} })
  await plugins.load([file])                       // 不报错：它只是"列出并校验"
  assert.equal(plugins.count, 1)
  assert.equal(plugins.planes, null)
  assert.deepEqual(plugins.list[0].events.sort(), ['receive/ready', 'run/start'])
})

test('名字全局唯一：`recv/file-done`（页面）与 `receive/file-done`（接收进程）是两个不同的东西', async () => {
  const all = [...PLUGIN_TABLE.map((r) => r.name), ...PAGE_HOOKS, ...PAGE_SLOTS]
  assert.equal(new Set(all).size, all.length, '钩子名必须全局唯一（重名会让 PLANE_OF 静默丢一条）')
  // 页面平面那三个 `recv/*` 是页面里的"收到"事件，与接收端进程的 `receive/*` 不是一回事
  assert.equal(PAGE_HOOKS.includes('recv/file-done'), true)
  assert.equal(PLANE_OF.get('receive/file-done'), 'receive')
  assert.equal(PLANE_OF.has('recv/file-done'), false, '页面钩子不在 Node 侧的表里（它在 web/page-plugin-runtime.mjs）')
})

// ── ⑤ ready / closed 与销毁链 ──────────────────────────────

test('receive/ready 与 receive/closed 都真的发得出来（整套服务，含证书与销毁链）', async () => {
  globalThis.__recvEvents = []
  const plugins = await recordingPlugins()
  const dir = await tempDir()
  // 手机页要在启动时装进来（源码模式下由入口装；这里是测试，自己装）
  const { installFromDisk } = await import('../src/assets.js')
  installFromDisk(fileURLToPath(new URL('..', import.meta.url)))
  const service = await startReceiveService({
    dir, plugins, timeoutMs: 300, port: 0, bind: '127.0.0.1', noQr: true, noColor: true,
  })
  const ready = events().find((e) => e.name === 'receive/ready')
  assert.ok(ready, '服务就绪时必须通知插件（实际：' + names().join(' → ') + '）')
  assert.equal(ready.payload.dir, dir)
  assert.equal(ready.payload.port, service.port)
  assert.equal(ready.payload.tls, true)
  assert.equal(typeof ready.payload.limits.maxBytes, 'number')
  assert.equal(JSON.stringify(ready.payload).includes(service.password), false, '不能把密码交给插件')

  // 等超时退出（不连手机），然后走销毁链
  const result = await waitForReceive(service.receive, 300)
  assert.equal(result.ok, false)
  const report = await service.stop()
  assert.equal(names().includes('receive/closed'), true, '关闭时必须通知（实际：' + names().join(' → ') + '）')
  const closed = events().find((e) => e.name === 'receive/closed')
  assert.equal(closed.payload.reason, 'closed')
  // 销毁清单里那一步真的跑了（插件资源可回收）
  assert.equal(report.done.includes('插件资源已释放'), true,
    '销毁清单里必须有"插件资源已释放"这一步（实际已完成：' + report.done.join('、') + '）')
})

// ── ⑥ 接线：三个入口都把"平面"与"注册表"接上了 ─────────────

test('示例插件 `examples/plugins/recv-log.cjs` 能加载，且覆盖接收平面的每一个钩子', async () => {
  const { hooksOfPlane } = await import('../src/plugin/events.js')
  const plugins = createPluginRegistry({ planes: ['receive'], log: () => {} })
  await plugins.load([fileURLToPath(new URL('../examples/plugins/recv-log.cjs', import.meta.url))])
  assert.equal(plugins.count, 1)
  assert.deepEqual([...plugins.list[0].events].sort(), [...hooksOfPlane('receive')].sort(),
    '示例要跟着事件表走（漏一个就意味着文档里的例子过期了）')
})

test('接线：命令行 / 界面 / 接收服务 / 中继都按平面建注册表，并把插件交给接收平面', async () => {
  const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8')
  const bin = await read('bin/flicker.js')
  assert.match(bin, /planes:\s*flags\.plugins === true \? null/, '命令行按动作定平面（--plugins 不限）')
  assert.match(bin, /isRecvServe \? \['receive'\]/, '`flicker recv` 必须是接收平面')
  assert.match(bin, /plugins: plugins\?\.count \? plugins : null/, '插件必须交给 runRecv')

  const gui = await read('src/gui.js')
  assert.match(gui, /planes: \['sender', 'receive'\]/, '界面两个方向都要允许')
  assert.match(gui, /plugins: plugins\?\.count \? plugins : null/, '界面起接收服务时要把插件传下去')

  const recv = await read('src/recv.js')
  assert.match(recv, /EVENTS\.RECV_READY/, 'ready 必须在服务就绪时发')
  assert.match(recv, /registerRecvDestroySteps\(destroyer, \{ receive, cert, trusted, plugins \}/,
    '销毁链必须带上插件（否则插件资源不回收）')

  const relay = await read('relay/local.mjs')
  assert.match(relay, /planes: args\.includes\('--plugins'\) \? null : \['relay'\]/,
    '中继也要按平面建注册表')
})
