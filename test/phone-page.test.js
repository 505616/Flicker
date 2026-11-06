/**
 * 手机上传页的协议内核：与 Node 套件**逐字节**比对
 * ================================================
 *
 * 项目里密码学有两份实现（Node 的 `src/suite/flicker1.js`、接收端页面内联的那份），
 * 手机上传页的内核是**第三份**。这个项目的教训是：两份实现一定会漂移，
 * 而漂移的表现是"密码不一致""块校验失败"这类**离原因很远**的现象
 * （接收端页面曾经漏了 MAC 的域前缀，局域网模式因此从来没成功过）。
 *
 * 所以这里的判据不是"跑得通"，而是"**每一个字节都相同**"：
 *   · PBKDF2 验证值、HKDF 三把钥匙 —— 差一个字节就永远握不上手
 *   · 两种握手构造的 MAC（v1/v2）—— 差一个字节就报"密码不一致"
 *   · 清单密文（固定 IV 时）与分块密文 —— 格式是 tag‖ct，subtle 给的是 ct‖tag
 *   · 块 AAD / 块 IV —— 差一个字节，接收端解不开，而错误信息只说"块校验失败"
 *   · 增量 SHA-256 —— 它算错的话，所有文件都会被判成"整文件校验不通过"
 *
 * ⚠️ 判据的独立性：这里**故意**不调用手机内核里那些"看起来更方便"的组合函数，
 *    而是直接用它给出的底层字节去做 Node 侧的加密/比对 —— 这样"两边算出同样的东西"
 *    才是真的被验过，而不是"两边都调了同一个错的东西"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac, randomBytes, webcrypto } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import {
  deriveVerifier, deriveKeys, senderMac, receiverMac, sealManifest, openManifest,
  openChunk, chunkAAD, chunkIV, MANIFEST_AAD, PARAMS, LABELS, MAC_PROFILES, SUITE_ID,
} from '../src/suite/flicker1.js'
import { sliceFn } from './receiver-relay-tests.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/**
 * 在**独立上下文**里执行 `web/phone-core.js`，模拟浏览器：
 * 只给 crypto / TextEncoder / atob / btoa / globalThis —— 浏览器里没有的东西一个都不给，
 * 这样"页面里其实用不了"的代码会当场暴露（而不是等真机上才发现）。
 */
async function loadCore() {
  const code = await readFile(path.join(ROOT, 'web', 'phone-core.js'), 'utf8')
  const sandbox = {
    crypto: webcrypto,
    TextEncoder, TextDecoder, Uint8Array, Uint32Array, DataView, BigInt, Math, Error, Promise,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox, { filename: 'web/phone-core.js' })
  const core = sandbox.FlickerPhone
  assert.ok(core, '内联脚本应当把接口挂到 globalThis.FlickerPhone 上')
  return core
}

const core = await loadCore()
const hex = (b) => createHash('sha256').update(b).digest('hex')
const u8 = (b) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength)

// ── ① 常量与参数 ────────────────────────────────────────────

test('套件常量与 Node 侧完全一致（套件 id / 参数 / 标签 / 构造表）', () => {
  assert.equal(core.SUITE_ID, SUITE_ID)
  assert.deepEqual({ ...core.PARAMS }, { ...PARAMS })
  assert.deepEqual({ ...core.LABELS }, { ...LABELS })
  assert.deepEqual([...core.MAC_PROFILES], [...MAC_PROFILES])
  assert.equal(Buffer.from(core.MANIFEST_AAD).toString('utf8'), MANIFEST_AAD.toString('utf8'))
  assert.equal(core.MANIFEST_AAD.length, MANIFEST_AAD.length)
})

// ── ② 密钥派生 ──────────────────────────────────────────────

test('PBKDF2 验证值与 Node 逐字节一致（60 万轮，慢是应该的）', async () => {
  const salt = randomBytes(PARAMS.saltBytes)
  const want = deriveVerifier('k7m-3fq', salt)
  const got = await core.pbkdf2Verifier('k7m-3fq', u8(salt))
  assert.equal(Buffer.from(got).toString('hex'), want.toString('hex'))
  assert.equal(got.length, 32)
})

test('HKDF 三把钥匙与 Node 逐字节一致（用途隔离靠标签，差一个字节就握不上手）', async () => {
  const verifier = deriveVerifier('another-password', randomBytes(PARAMS.saltBytes))
  const want = deriveKeys(verifier)
  const got = await core.hkdfKeys(u8(verifier))
  for (const k of ['room', 'auth', 'enc']) {
    assert.equal(Buffer.from(got[k]).toString('hex'), want[k].toString('hex'), `${k} 钥匙不一致`)
  }
})

// ── ③ 握手 MAC ──────────────────────────────────────────────

test('两种握手构造的 MAC 都与 Node 一致（v2 绑套件、v1 是发布时的字节）', async () => {
  const verifier = deriveVerifier('mac-test', randomBytes(PARAMS.saltBytes))
  const { auth } = deriveKeys(verifier)
  const challenge = randomBytes(PARAMS.nonceBytes)
  const key = await core.importAuth(u8(auth))

  for (const profile of MAC_PROFILES) {
    const wantSend = senderMac(auth, challenge, { profile })
    const gotSend = await core.senderMac(key, u8(challenge), { profile })
    assert.equal(Buffer.from(gotSend).toString('hex'), wantSend.toString('hex'),
      `${profile} 的发送端 MAC 不一致 —— 表现是"密码不一致"，但密码其实是对的`)

    const wantRecv = receiverMac(auth, challenge, { profile })
    const gotRecv = await core.receiverMac(key, u8(challenge), { profile })
    assert.equal(Buffer.from(gotRecv).toString('hex'), wantRecv.toString('hex'),
      `${profile} 的接收端 MAC 不一致`)
  }
})

// ── ④ AAD 与 IV ─────────────────────────────────────────────

test('块 AAD 逐字节一致，且确实按 64 位写（fileIndex ≥ 32768 也不能截断）', () => {
  for (const [fi, ci, total, len] of [
    [0, 0, 1, 0], [0, 0, 1, PARAMS.chunkBytes], [32767, 5, 10, 1024],
    [32768, 0, 4294967296, 1], [Number.MAX_SAFE_INTEGER, 7, 9, 1048576],
  ]) {
    const got = core.chunkAAD(fi, ci, total, len)
    assert.equal(Buffer.from(got).toString('hex'), chunkAAD(fi, ci, total, len).toString('hex'),
      `AAD 不一致：fi=${fi} ci=${ci} total=${total} len=${len}`)
    assert.equal(got.length, 28)
  }
})

test('块 IV 逐字节一致：BE32(fileIndex) ‖ BE64(chunkIndex)', () => {
  for (const [fi, ci] of [
    [0, 0], [0, 1], [1, 0], [7, 3], [255, 65535], [256, 256],
    [1000000, 2], [2 ** 32, 2 ** 40], [2 ** 40, 2 ** 20],
  ]) {
    assert.equal(Buffer.from(core.chunkIV(fi, ci)).toString('hex'), chunkIV(fi, ci).toString('hex'),
      `IV 不一致：fileIndex=${fi} chunkIndex=${ci}`)
    assert.equal(core.chunkIV(fi, ci).length, 12)
  }
})

test('⭐ 不同文件的同一块号 IV 必须不同（GCM nonce 复用会毁掉整个会话）', () => {
  // 整个会话共用一把 keys.enc；如果 IV 只由块号决定，文件 0 与文件 1 的第 0 块
  // 会用同一个 nonce —— C1⊕C2 = P1⊕P2，还能做 forbidden attack（P0-1）。
  const hexOf = (u8) => Buffer.from(u8).toString('hex')
  assert.notEqual(hexOf(core.chunkIV(0, 0)), hexOf(core.chunkIV(1, 0)),
    '两个文件的第 0 块 IV 相同 —— GCM nonce 复用了')
  assert.notEqual(hexOf(core.chunkIV(0, 0)), hexOf(core.chunkIV(0, 1)),
    '同一文件的两个不同块 IV 相同')
  // 同一坐标必须稳定：加密与解密各算一次，必须逐字节一致
  assert.equal(hexOf(core.chunkIV(5, 9)), hexOf(core.chunkIV(5, 9)))
  // 前 4 字节就是 fileIndex（大端）
  assert.equal(hexOf(core.chunkIV(0x01020304, 0).subarray(0, 4)), '01020304')
})

test('⭐ 跨文件同块号封出的密文不同，且同一坐标可复现', async () => {
  const verifier = deriveVerifier('iv-boundary', randomBytes(PARAMS.saltBytes))
  const { enc } = deriveKeys(verifier)
  const key = await core.importEnc(u8(enc), 'encrypt')
  const plain = u8(randomBytes(64))
  const a = await core.sealChunk(key, 0, 0, 1, plain)
  const b = await core.sealChunk(key, 1, 0, 1, plain)
  assert.notEqual(Buffer.from(a.ct).toString('hex'), Buffer.from(b.ct).toString('hex'),
    '同明文、同块号、不同文件封出相同密文 —— IV 没有绑定 fileIndex')
  const a2 = await core.sealChunk(key, 0, 0, 1, plain)
  assert.equal(Buffer.from(a2.ct).toString('hex'), Buffer.from(a.ct).toString('hex'),
    '同一坐标两次封装的密文必须相同（否则解密端永远对不上）')
})

// ── ⑤ 分块加密：与 Node 的**解密**互通（真正的判据）──────────

test('⭐ 手机封的块能被 Node 的 openChunk 解开（tag‖ct 的顺序不能错）', async () => {
  const verifier = deriveVerifier('chunk-test', randomBytes(PARAMS.saltBytes))
  const { enc } = deriveKeys(verifier)
  const key = await core.importEnc(u8(enc), 'encrypt')

  for (const [fi, ci, total, len] of [[0, 0, 1, 10], [3, 0, 4, PARAMS.chunkBytes], [32768, 2, 3, 1]]) {
    const plain = randomBytes(len)
    const { ct, tag } = await core.sealChunk(key, fi, ci, total, u8(plain))
    // 长度先对齐：subtle 返回的是 ct‖tag，本项目要求 tag‖ct
    assert.equal(ct.length, len, '密文长度应当等于明文长度（GCM 不改变长度）')
    assert.equal(tag.length, PARAMS.tagBytes)
    const opened = openChunk(enc, fi, ci, total, Buffer.from(ct), Buffer.from(tag), len)
    assert.equal(opened.toString('hex'), plain.toString('hex'),
      `fi=${fi} ci=${ci} 的块解不开或内容不符`)
  }
})

test('⭐ 块 AAD 真的绑住了坐标：换一个块号就解不开（否则"绑坐标"是空话）', async () => {
  const verifier = deriveVerifier('aad-test', randomBytes(PARAMS.saltBytes))
  const { enc } = deriveKeys(verifier)
  const key = await core.importEnc(u8(enc), 'encrypt')
  const plain = randomBytes(64)
  const { ct, tag } = await core.sealChunk(key, 0, 1, 4, u8(plain))
  assert.throws(() => openChunk(enc, 0, 2, 4, Buffer.from(ct), Buffer.from(tag), 64),
    '把块号从 1 换成 2 还能解开 —— AAD 没起作用')
  assert.throws(() => openChunk(enc, 1, 1, 4, Buffer.from(ct), Buffer.from(tag), 64),
    '把文件下标换掉还能解开 —— AAD 没起作用')
  assert.throws(() => openChunk(enc, 0, 1, 5, Buffer.from(ct), Buffer.from(tag), 64),
    '把总块数换掉还能解开 —— AAD 没起作用')
})

// ── ⑥ 清单加密 ─────────────────────────────────────────────

test('⭐ 手机封的清单能被 Node 的 openManifest 解开（IV 随机，AAD 固定）', async () => {
  const verifier = deriveVerifier('manifest-test', randomBytes(PARAMS.saltBytes))
  const { enc } = deriveKeys(verifier)
  const key = await core.importEnc(u8(enc), 'encrypt')
  const wire = JSON.stringify({ files: [{ rel: '照片.jpg', size: 3 }], totalBytes: 3, totalChunks: 1 })
  const plain = new TextEncoder().encode(wire)
  const { iv, ct, tag } = await core.sealManifest(key, plain)
  assert.equal(iv.length, PARAMS.ivBytes)
  const opened = openManifest(enc, Buffer.from(iv), Buffer.from(ct), Buffer.from(tag))
  assert.equal(opened.toString('utf8'), wire, '清单解出来不是原来的字节')
})

test('清单的 IV 每次都不同（随机），但都能解开 —— 固定 IV 会毁掉 GCM 的安全性', async () => {
  const verifier = deriveVerifier('iv-test', randomBytes(PARAMS.saltBytes))
  const { enc } = deriveKeys(verifier)
  const key = await core.importEnc(u8(enc), 'encrypt')
  const plain = new TextEncoder().encode('同样的内容')
  const seen = new Set()
  for (let i = 0; i < 5; i++) {
    const { iv, ct, tag } = await core.sealManifest(key, plain)
    seen.add(Buffer.from(iv).toString('hex'))
    assert.equal(openManifest(enc, Buffer.from(iv), Buffer.from(ct), Buffer.from(tag)).toString('utf8'),
      '同样的内容')
  }
  assert.equal(seen.size, 5, '五次封装的 IV 必须各不相同')
})

test('Node 封的清单也能被手机内核解开（反向：两边真的互通）', async () => {
  const verifier = deriveVerifier('both-ways', randomBytes(PARAMS.saltBytes))
  const { enc } = deriveKeys(verifier)
  const key = await core.importEnc(u8(enc), 'decrypt')
  const plain = new TextEncoder().encode('{"hello":"世界"}')
  const sealed = sealManifest(enc, Buffer.from(plain))
  const opened = await core.openManifest(key, u8(sealed.iv), u8(sealed.ct), u8(sealed.tag))
  assert.equal(Buffer.from(opened).toString('utf8'), '{"hello":"世界"}')
})

// ── ⑦ 增量 SHA-256 ─────────────────────────────────────────

test('增量 SHA-256：多种长度上与 Node 完全一致（含所有填充边界）', () => {
  const lengths = [0, 1, 2, 3, 55, 56, 57, 63, 64, 65, 100, 127, 128, 129,
    1000, 4096, 65535, 65536, 100000, 1 << 20]
  for (const n of lengths) {
    const data = randomBytes(n)
    const h = new core.Sha256()
    h.update(u8(data))
    assert.equal(h.digest(), hex(data), `长度 ${n} 的摘要不一致`)
  }
})

test('增量 SHA-256：分多次喂入与一次喂入相同（真正增量的证明）', () => {
  const data = randomBytes(300000)
  const one = new core.Sha256(); one.update(u8(data))
  const many = new core.Sha256()
  let off = 0
  for (const size of [1, 7, 63, 64, 65, 127, 1000, 4096, 5, 99999]) {
    const chunk = data.subarray(off, Math.min(off + size, data.length))
    if (chunk.length) many.update(u8(chunk))
    off += chunk.length
    if (off >= data.length) break
  }
  if (off < data.length) many.update(u8(data.subarray(off)))
  assert.equal(many.digest(), one.digest(), '分块喂入必须得到同样的摘要')
  assert.equal(one.digest(), hex(data))
})

test('增量 SHA-256：在每个可能的切点上切开都一致（填充逻辑的经典陷阱）', () => {
  for (const n of [55, 56, 57, 64, 65, 128]) {
    const data = randomBytes(n)
    for (let cut = 0; cut <= n; cut++) {
      const h = new core.Sha256()
      h.update(u8(data.subarray(0, cut)))
      h.update(u8(data.subarray(cut)))
      assert.equal(h.digest(), hex(data), `长度 ${n} 在第 ${cut} 字节切开时出错`)
    }
  }
})

test('一次性 sha256Hex 与 Node 一致（逐块校验走这条路）', async () => {
  for (const n of [0, 1, 64, 1024, 1 << 20]) {
    const data = randomBytes(n)
    assert.equal(await core.sha256Hex(u8(data)), hex(data), `长度 ${n} 不一致`)
  }
})

// ── ⑧ 工具函数 ─────────────────────────────────────────────

test('base64 与字节互转正确（令牌/盐/挑战都走它）', () => {
  for (const n of [0, 1, 15, 16, 32, 100]) {
    const data = randomBytes(n)
    const b64 = core.b64(u8(data))
    assert.equal(b64, data.toString('base64'), `长度 ${n} 的 base64 不一致`)
    assert.equal(Buffer.from(core.unb64(b64)).toString('hex'), data.toString('hex'))
  }
})

test('equalBytes 是常数时间风格的比较，且长度不同直接 false', () => {
  const a = randomBytes(32)
  assert.equal(core.equalBytes(a, new Uint8Array(a)), true)
  const b = Uint8Array.from(a); b[31] ^= 1
  assert.equal(core.equalBytes(a, b), false, '最后一个字节不同必须被认出来')
  assert.equal(core.equalBytes(a, a.subarray(0, 31)), false)
  assert.equal(core.equalBytes(a, null), false)
})

test('pickMacProfile：优先 v2，没报价时退回 v1（老版本互通）', () => {
  assert.equal(core.pickMacProfile(['v2', 'v1']), 'v2')
  assert.equal(core.pickMacProfile(['v1']), 'v1')
  assert.equal(core.pickMacProfile(undefined), 'v1', '老版本不报价 → 按 v1')
  assert.equal(core.pickMacProfile([]), 'v1')
  assert.equal(core.pickMacProfile(['v3']), 'v1', '不认识的报价 → 按 v1（由发送端的中止逻辑兜底）')
})


// ── ⑨ 页面逻辑（web/phone.html）：暂停死锁 / 下标错位 / 非幂等重试 ──
//
// 这一页的 bug 都是"状态机 + 重试策略"级别的，跑不了真 DOM，所以按
// test/receiver-page.test.js 的套路：把页面里的**真实函数**切片抽出来，
// 配上最小桩在 Node 里跑 —— 验证的是页面那段代码本身，不是测试里另写的一份。

const pageHtml = await readFile(path.join(ROOT, 'web', 'phone.html'), 'utf8')

function fakeEl() {
  return { textContent: '', innerHTML: '', className: '', disabled: false, classList: { add() {}, remove() {} } }
}

/**
 * 切一个**可能带 async 的**页面函数。
 * ⚠️ sliceFn 从 `function name(` 开始切，会把前面的 `async ` 丢掉 ——
 *    抽出来的源码里带着 await，直接 SyntaxError。这里把前缀补回去。
 */
function slicePageFn(source, name) {
  const at = source.indexOf('function ' + name + '(')
  assert.notEqual(at, -1, '页面里找不到 function ' + name)
  const isAsync = source.slice(Math.max(0, at - 6), at) === 'async '
  return (isAsync ? 'async ' : '') + sliceFn(source, name)
}

/**
 * 把页面里的 hashAll 抽出来跑。
 * ⚠️ `var hashing` 是 hashAll 的模块级兄弟变量，必须和它放进**同一个** Function 体 ——
 *    分开包一层会拿不到它，run 起来直接 ReferenceError。
 */
function runHashAll(S, stubs = {}) {
  return new Function('S', 'C', '$', 'paintPick', 'fail', 't', 'updateSendButtons',
    'var hashing = false\n' + slicePageFn(pageHtml, 'hashAll') + '\nreturn hashAll')(
    S,
    stubs.C || {
      // 用真实算法，顺便证明喂进去的字节没错
      Sha256: class {
        constructor() { this.h = createHash('sha256') }
        update(u8) { this.h.update(u8) }
        digest() { return this.h.digest('hex') }
      },
    },
    stubs.$ || (() => fakeEl()),
    stubs.paintPick || (() => {}),
    stubs.fail || (() => {}),
    (k) => k,
    stubs.updateSendButtons || (() => {}))
}

test('⭐ P1-3：暂停状态（S.cancel=true）下摘要照样算完，不会把 hashing 永久钉成 true', async () => {
  // 复现原 bug 的最小条件：暂停之后 hashAll 被再次触发，而 S.cancel 还是 true。
  // 旧代码在读到第一块之前就 `if (S.cancel) return`，于是 f.hashing 永远是 true、
  // sha256 永远是 null → hashPending() 恒真 → 发送/继续按钮永久禁用。
  const bytes = Buffer.from('hello-flicker')
  const picked = [{
    rel: 'a.jpg', size: bytes.length, sha256: null, hashing: false,
    file: {
      slice(start, end) {
        return { arrayBuffer: async () => Uint8Array.from(bytes.subarray(start, end)).buffer }
      },
    },
  }]
  const S = { picked, cancel: true }
  const calls = { fail: null, update: 0, painted: 0 }
  const els = { hashNote: fakeEl() }
  const hashAll = runHashAll(S, {
    $: (id) => els[id] || fakeEl(),
    paintPick: () => { calls.painted++ },
    fail: (e) => { calls.fail = e },
    updateSendButtons: () => { calls.update++ },
  })
  await hashAll()
  assert.equal(picked[0].sha256, createHash('sha256').update(bytes).digest('hex'),
    '暂停状态下也必须把摘要算完（暂停只停网络，不该停本地校验值）')
  assert.equal(picked[0].hashing, false, 'hashing 必须复位 —— 否则这个文件永远"正在算"')
  assert.equal(calls.fail, null, '正常读取不该报错')
  assert.ok(calls.update >= 1, '收尾要刷新一次按钮状态（hashPending 变成 false）')
})

test('⭐ P1-3：读文件失败时 hashing 也会复位，不会留下"永远在算"的文件', async () => {
  const picked = [{
    rel: 'missing.jpg', size: 10, sha256: null, hashing: false,
    file: { slice() { throw Object.assign(new Error('文件被移走了'), { name: 'NotFoundError' }) } },
  }]
  const S = { picked, cancel: false }
  const calls = { fail: null }
  const withFlag = new Function('S', 'C', '$', 'paintPick', 'fail', 't', 'updateSendButtons',
    'var hashing = false\n' + slicePageFn(pageHtml, 'hashAll') + '\nreturn hashAll')(
    S, { Sha256: class {} }, () => fakeEl(), () => {}, (e) => { calls.fail = e }, (k) => k, () => {})
  await withFlag()
  assert.ok(calls.fail, '读文件失败要如实报出来，而不是当成"算完了"')
  assert.equal(picked[0].hashing, false, '失败路径也必须复位 hashing')
})

test('⭐ P2-1：sendChunk 从首次发送的快照取字节，暂停期间增删文件不会读到别的文件', async () => {
  const snapshotBytes = Uint8Array.from([7, 7, 7, 7])
  // S.picked 已经变了（模拟暂停期间删光/换了顺序）——旧代码会读它，直接 undefined
  const S = {
    wire: { files: [{ chunkBytes: 4, chunks: 1, size: 4 }] },
    sendingFiles: [{
      rel: 'a.bin', size: 4, sha256: 'x',
      file: { slice: (s, e) => ({ arrayBuffer: async () => Uint8Array.from(snapshotBytes.subarray(s, e)).buffer }) },
    }],
    picked: [],
    sent: new Set(), doneChunks: 0, doneBytes: 0,
    perFile: { 0: { done: 0, chunks: 1, rel: 'a.bin', renamed: false } },
  }
  const calls = { sealed: null }
  const sendChunk = new Function('S', 'C', 'api', 't', 'paintProgress', 'sidHeader',
    slicePageFn(pageHtml, 'readSlice') + '\n' + slicePageFn(pageHtml, 'sendChunk') + '\nreturn sendChunk')(
    S,
    {
      sealChunk: async (key, fi, ci, total, u8) => {
        calls.sealed = { fi, ci, total, bytes: Array.from(u8) }
        return { tag: new Uint8Array([1]), ct: new Uint8Array([2]) }
      },
      concat: (...parts) => parts[0],
    },
    async () => ({}),
    (k) => k,
    () => {},
    () => ({}))
  await sendChunk({ f: 0, c: 0, len: 4 })
  assert.deepEqual(calls.sealed.bytes, [7, 7, 7, 7],
    '必须从 S.sendingFiles 读字节 —— 从 S.picked 读会拿到别的文件（P2-1）')
  assert.equal(calls.sealed.fi, 0)

  // 快照丢了（理论上不会发生）要报可读错误，而不是 TypeError
  const S2 = { ...S, sendingFiles: null }
  const sendChunk2 = new Function('S', 'C', 'api', 't', 'paintProgress', 'sidHeader',
    slicePageFn(pageHtml, 'readSlice') + '\n' + slicePageFn(pageHtml, 'sendChunk') + '\nreturn sendChunk')(
    S2, { sealChunk: async () => ({}), concat: () => new Uint8Array(0) },
    async () => ({}), (k) => k, () => {}, () => ({}))
  await assert.rejects(() => sendChunk2({ f: 0, c: 0, len: 4 }), (e) => e.code === 'MANIFEST_CHANGED')
})

test('P2-1：名单发出后冻结选择集（增删按钮禁用、addFiles 直接拒绝）', () => {
  const upd = sliceFn(pageHtml, 'updateSendButtons')
  assert.match(upd, /locked/, '按钮状态要考虑"名单已发"')
  assert.match(upd, /btnClear'\)\.disabled = [^\n]*locked/)
  assert.match(upd, /btnPhotos'\)\.disabled = locked/)
  assert.match(upd, /btnOther'\)\.disabled = locked/)
  const add = sliceFn(pageHtml, 'addFiles')
  assert.match(add, /if \(S\.manifestSent\)/, 'addFiles 必须拒绝往已发名单的会话里加文件')
  assert.match(sliceFn(pageHtml, 'paintPick'), /rm\.disabled = Boolean\(S\.manifestSent\)/)
  // 快照的建立点：首次发送时把 picked 复制一份
  assert.match(pageHtml, /S\.sendingFiles = S\.picked\.slice\(\)/)
})

test('⭐ P2-2：清单/收尾不自动重试；失败先问服务端状态，409 按"已成功"处理', () => {
  // 非幂等请求不能进通用重试（重发即 409）
  assert.match(pageHtml, /async function apiOnce\(/, '需要一条"只发一次"的通道')
  const manifest = sliceFn(pageHtml, 'sendManifestRequest')
  assert.match(manifest, /apiOnce\('\/up\/manifest'/, '清单必须走 apiOnce，不能走自动重试的 api')
  assert.match(manifest, /MANIFEST_TWICE/, '409 MANIFEST_TWICE 要按"已经收下了"处理')
  assert.match(manifest, /probeStatus\(\)/, '网络失败后要先问服务端状态')
  const finish = sliceFn(pageHtml, 'sendFinishRequest')
  assert.match(finish, /apiOnce\('\/up\/finish'/)
  assert.match(finish, /ALREADY_FINISHED/, '409 ALREADY_FINISHED 要按"已经成功了"处理')
  assert.match(finish, /reportFromStatus/, '收尾回执丢了要用 /up/status 重建')
  // 老的直接 api() 调用必须消失（否则重试又会把 409 当成失败）
  assert.doesNotMatch(pageHtml, /await api\('\/up\/manifest'/)
  assert.doesNotMatch(pageHtml, /await api\('\/up\/finish'/)
})

test('⭐ P3-4：手机页的错误与进度也有无障碍语义', () => {
  assert.match(pageHtml, /id="errTitle" role="alert"/, '错误标题要有 role=alert')
  assert.match(pageHtml, /id="retryNote"[^>]*aria-live="polite"/, '重试/恢复提示要有 aria-live')
  assert.match(pageHtml, /id="curFile"[^>]*aria-live="polite"/, '当前文件行要有 aria-live')
  assert.match(pageHtml, /id="fileBarWrap" role="progressbar"[^>]*aria-valuenow="0"/,
    '单文件进度条要有 progressbar 语义与读数')
  assert.match(pageHtml, /id="totalBarWrap" role="progressbar"[^>]*aria-valuenow="0"/,
    '总进度条要有 progressbar 语义与读数')
  assert.match(sliceFn(pageHtml, 'setPct'), /aria-valuenow/,
    '画进度时必须同步更新 aria-valuenow（写死 0 等于没有读数）')
})

test('P2-2：从 /up/status 重建的回执结构正确（丢失响应后的补救）', () => {
  const manifestFrom = new Function(sliceFn(pageHtml, 'manifestResultFromStatus')
    + '\nreturn manifestResultFromStatus')()
  const reportFrom = new Function(sliceFn(pageHtml, 'reportFromStatus')
    + '\nreturn reportFromStatus')()
  const st = { files: [{ index: 0, rel: 'b.jpg', size: 9 }, { index: 2, rel: 'c.jpg', size: 5 }], totalChunks: 4 }
  assert.deepEqual(manifestFrom(st), {
    accepted: [{ index: 0, rel: 'b.jpg', renamedFrom: null }, { index: 2, rel: 'c.jpg', renamedFrom: null }],
    skipped: [], totalChunks: 4,
  })
  assert.deepEqual(reportFrom(st), {
    done: [{ rel: 'b.jpg', bytes: 9, renamedFrom: null }, { rel: 'c.jpg', bytes: 5, renamedFrom: null }],
    failed: [], skipped: [],
  })
})

test('HMAC 的输入里带方向前缀：发送端与接收端的 MAC 必须不同（防重放）', async () => {
  const verifier = deriveVerifier('domain-test', randomBytes(PARAMS.saltBytes))
  const { auth } = deriveKeys(verifier)
  const key = await core.importAuth(u8(auth))
  const challenge = randomBytes(PARAMS.nonceBytes)
  const send = await core.senderMac(key, u8(challenge), { profile: 'v2' })
  const recv = await core.receiverMac(key, u8(challenge), { profile: 'v2' })
  assert.notEqual(Buffer.from(send).toString('hex'), Buffer.from(recv).toString('hex'),
    '两个方向的 MAC 相同 —— 拿到一个就能往另一个方向重放')

  // 手算对照：前缀就是 `FLICKER/1\nsend\n`
  const manual = createHmac('sha256', auth)
    .update(Buffer.concat([Buffer.from(`${SUITE_ID}\nsend\n`, 'utf8'), challenge])).digest()
  assert.equal(Buffer.from(send).toString('hex'), manual.toString('hex'))
})
