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

test('块 IV 逐字节一致（前 4 字节为 0，后 8 字节是块号）', () => {
  for (const ci of [0, 1, 255, 65536, 4294967296]) {
    assert.equal(Buffer.from(core.chunkIV(ci)).toString('hex'), chunkIV(ci).toString('hex'),
      `块号 ${ci} 的 IV 不一致`)
  }
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
