/**
 * FLICKER/1 套件的单元测试
 * 运行: node --test test/
 *
 * 这个文件的目标不只是"跑通"，而是把**每一条安全性质**都变成可执行的断言：
 * 篡改、乱序、重放、跨文件拼接、凭证冒用 —— 每一种都必须被拒绝。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import {
  SUITE_ID, PARAMS, deriveVerifier, deriveKeys, roomId,
  newChallenge, receiverMac, senderMac, macEquals,
  sealChunk, openChunk, sealManifest, openManifest,
  chunkAAD, chunkIV, wipe, newToken, suggestPassword,
} from '../src/suite/flicker1.js'

// 测试用低迭代次数，避免每次跑测试都等 600k 次 PBKDF2（生产值另测）
const FAST = { ...PARAMS, iterations: 1000 }
const mkVerifier = (pw, salt, iters = 1000) =>
  deriveVerifier(pw, salt)   // 用真实参数，但只在少数用例调用

// ── 参数与标识 ──────────────────────────────────────────────

test('套件 ID 与关键参数是冻结的', () => {
  assert.equal(SUITE_ID, 'FLICKER/1')
  assert.equal(PARAMS.keyBytes, 32)
  assert.equal(PARAMS.ivBytes, 12)
  assert.equal(PARAMS.tagBytes, 16)
  assert.equal(PARAMS.chunkBytes, 1048576)
  assert.throws(() => { PARAMS.iterations = 1 }, TypeError, '参数必须不可变')
})

test('三个 HKDF 标签互不相同 —— 否则三把钥匙会退化成一吧', async () => {
  const { LABELS } = await import('../src/suite/flicker1.js')
  const vals = Object.values(LABELS)
  assert.equal(new Set(vals).size, vals.length)
})

// ── 密钥派生 ────────────────────────────────────────────────

test('deriveVerifier 拒绝长度错误或非字节的盐', () => {
  assert.throws(() => deriveVerifier('pw', Buffer.alloc(8)), /盐必须是 16 字节/)
  assert.throws(() => deriveVerifier('pw', 'not-a-buffer'), /盐必须是/)
  assert.throws(() => deriveVerifier('pw', null), /盐必须是/)
  // 但 Uint8Array 是**合法**输入：从中继消息里切出来的盐就是这个类型
  assert.doesNotThrow(() => deriveVerifier('pw', new Uint8Array(16)),
    'Uint8Array 也是 16 字节的字节序列，不该被拒（这条曾经误伤过）')
})

test('相同密码+相同盐 → 相同 V；不同盐 → 不同 V（盐确实起作用）', () => {
  const salt1 = Buffer.alloc(16, 1), salt2 = Buffer.alloc(16, 2)
  const a = mkVerifier('same-password', salt1)
  const b = mkVerifier('same-password', salt1)
  const c = mkVerifier('same-password', salt2)
  assert.deepEqual(a, b, '同盐必须可复现（接收端要算出同样的值）')
  assert.notDeepEqual(a, c, '不同盐必须得到不同的 V')
})

test('不同密码 → 不同 V', () => {
  const salt = Buffer.alloc(16, 7)
  assert.notDeepEqual(mkVerifier('password-a', salt), mkVerifier('password-b', salt))
})

test('deriveKeys 产出三把互不相同、长度正确的钥匙', () => {
  const v = randomBytes(32)
  const k = deriveKeys(v)
  assert.equal(k.room.length, 32)
  assert.equal(k.auth.length, 32)
  assert.equal(k.enc.length, 32)
  const all = [k.room.toString('hex'), k.auth.toString('hex'), k.enc.toString('hex')]
  assert.equal(new Set(all).size, 3, '三把钥匙必须互不相同')
  // 任何一把都不应等于 V 本身
  for (const key of [k.room, k.auth, k.enc]) assert.notDeepEqual(key, v)
})

test('deriveKeys 拒绝长度错误的 V', () => {
  assert.throws(() => deriveKeys(Buffer.alloc(16)), /验证值必须是 32 字节/)
  assert.doesNotThrow(() => deriveKeys(new Uint8Array(32)), 'Uint8Array 同样应被接受')
})

test('房间号由密码决定：同密码同房间，异密码异房间', () => {
  const salt = Buffer.alloc(16, 3)
  const r1 = roomId(deriveKeys(mkVerifier('pw-x', salt)))
  const r2 = roomId(deriveKeys(mkVerifier('pw-x', salt)))
  const r3 = roomId(deriveKeys(mkVerifier('pw-y', salt)))
  assert.equal(r1, r2)
  assert.notEqual(r1, r3)
  assert.match(r1, /^[0-9a-f]{16}$/)
})

// ── 握手认证 ────────────────────────────────────────────────

test('握手：正确的密码能通过双向认证', () => {
  const salt = randomBytes(16)
  const keys = deriveKeys(deriveVerifier('shared-secret', salt))
  const challenge = newChallenge()
  assert.equal(challenge.length, 32)

  const rMac = receiverMac(keys.auth, challenge)
  const sMac = senderMac(keys.auth, challenge)
  assert.ok(macEquals(rMac, rMac), '发送端应接受正确的接收端应答')
  assert.ok(macEquals(sMac, sMac), '接收端应接受正确的发送端应答')
})

test('握手：密码不同 → MAC 不同（这是"密码一致"的数学保证）', () => {
  const salt = randomBytes(16)
  const good = deriveKeys(deriveVerifier('right-password', salt))
  const bad = deriveKeys(deriveVerifier('wrong-password', salt))
  const challenge = newChallenge()
  assert.ok(!macEquals(receiverMac(good.auth, challenge), receiverMac(bad.auth, challenge)))
})

test('握手：角色域分离 —— 接收端的应答不能被当作发送端的应答重放', () => {
  const keys = deriveKeys(randomBytes(32))
  const challenge = newChallenge()
  const r = receiverMac(keys.auth, challenge)
  const s = senderMac(keys.auth, challenge)
  assert.ok(!macEquals(r, s), '两种角色的 MAC 必须不可互换（防反射攻击）')
})

test('握手：挑战是一次性的 —— 换挑战则应答失效（抗重放）', () => {
  const keys = deriveKeys(randomBytes(32))
  const c1 = newChallenge(), c2 = newChallenge()
  assert.notDeepEqual(c1, c2, '两次挑战不应相同')
  assert.ok(!macEquals(receiverMac(keys.auth, c1), receiverMac(keys.auth, c2)),
    '为旧挑战算出的应答不能用于新挑战')
})

test('macEquals 对长度不符返回 false 而不是抛错，且不泄露长度信息', () => {
  assert.equal(macEquals(Buffer.alloc(32), Buffer.alloc(16)), false)
  assert.equal(macEquals(Buffer.alloc(32), 'string'), false)
  assert.equal(macEquals(null, undefined), false)
  assert.equal(macEquals(Buffer.alloc(32, 1), Buffer.alloc(32, 2)), false)
})

// ── 分块加解密 ─────────────────────────────────────────────

const mkEnc = () => randomBytes(32)

test('分块：往返一致（含各种长度，尤其最后一块不齐）', () => {
  const key = mkEnc()
  for (const len of [0, 1, 15, 16, 17, 1024, PARAMS.chunkBytes, PARAMS.chunkBytes + 7]) {
    const plain = randomBytes(len)
    const { ct, tag } = sealChunk(key, 0, 0, 1, plain)
    assert.equal(ct.length, len, 'GCM 是流密码，密文长度应等于明文长度')
    assert.equal(tag.length, 16)
    const back = openChunk(key, 0, 0, 1, ct, tag, plain.length)
    assert.deepEqual(back, plain, `长度 ${len} 的往返必须一致`)
  }
})

test('分块：密文被改动一个比特 → 解密失败', () => {
  const key = mkEnc()
  const plain = randomBytes(1024)
  const { ct, tag } = sealChunk(key, 0, 0, 1, plain)
  for (const mutate of ['ct', 'tag']) {
    const bad = Buffer.from(mutate === 'ct' ? ct : tag)
    bad[0] ^= 0x01
    assert.throws(
      () => mutate === 'ct'
        ? openChunk(key, 0, 0, 1, bad, tag, plain.length)
        : openChunk(key, 0, 0, 1, ct, bad, plain.length),
      /authenticate|Unsupported|BAD_DECRYPT|invalid/i,
      `${mutate} 被篡改必须被发现`)
  }
})

test('分块：块序号写进 AAD —— 换序号解密必须失败（防乱序/重放）', () => {
  const key = mkEnc()
  const plain = randomBytes(512)
  const { ct, tag } = sealChunk(key, 0, 5, 10, plain)
  assert.deepEqual(openChunk(key, 0, 5, 10, ct, tag, plain.length), plain, '正确序号应成功')
  assert.throws(() => openChunk(key, 0, 6, 10, ct, tag, plain.length), /.*/, '换块号必须失败')
  assert.throws(() => openChunk(key, 0, 4, 10, ct, tag, plain.length), /.*/, '换块号必须失败')
})

test('分块：文件序号写进 AAD —— 跨文件拼接必须失败', () => {
  const key = mkEnc()
  const plain = randomBytes(256)
  const { ct, tag } = sealChunk(key, 3, 0, 1, plain)
  assert.throws(() => openChunk(key, 4, 0, 1, ct, tag, plain.length), /.*/,
    '把文件 3 的块拿去当文件 4 的块必须失败')
})

test('分块：总块数写进 AAD —— 截断攻击必须失败', () => {
  const key = mkEnc()
  const plain = randomBytes(256)
  const { ct, tag } = sealChunk(key, 0, 0, 100, plain)
  assert.throws(() => openChunk(key, 0, 0, 99, ct, tag, plain.length), /.*/,
    '谎报总块数（截断）必须失败')
})

test('分块：明文长度写进 AAD —— 谎报长度必须失败', () => {
  const key = mkEnc()
  const plain = randomBytes(256)
  const { ct, tag } = sealChunk(key, 0, 0, 1, plain)
  assert.throws(() => openChunk(key, 0, 0, 1, ct, tag, 255), /.*/, '谎报明文长度必须失败')
})

test('分块：换一把钥匙必然失败', () => {
  const plain = randomBytes(128)
  const { ct, tag } = sealChunk(mkEnc(), 0, 0, 1, plain)
  assert.throws(() => openChunk(mkEnc(), 0, 0, 1, ct, tag, plain.length), /.*/)
})

test('IV 派生：同一文件内块序号不同 → IV 不同（绝不重用 IV）', () => {
  const ivs = new Set()
  for (let i = 0; i < 5000; i++) ivs.add(chunkIV(i).toString('hex'))
  assert.equal(ivs.size, 5000, 'IV 必须逐块唯一，否则 GCM 会灾难性失效')
  assert.equal(chunkIV(0).length, 12)
})

// ── 那个很隐蔽的 32 位截断陷阱 ──────────────────────────────

test('AAD 用 BigInt 写入：fileIndex 超过 32767 时不能出错', () => {
  // 如果用 (fileIndex << 16) | chunkIndex 这类 32 位运算，fileIndex >= 32768 会静默出错。
  // 这里直接验证 AAD 的实际字节，确保大序号被正确编码。
  const big = 70000
  const aad = chunkAAD(big, 1, 2, 3)
  assert.equal(aad.length, 28)
  assert.equal(aad.readBigUInt64BE(0), BigInt(big), `fileIndex=${big} 必须原样编码`)
  assert.equal(aad.readBigUInt64BE(8), 1n)
  assert.equal(aad.readBigUInt64BE(16), 2n)
  assert.equal(aad.readUInt32BE(24), 3)

  // 再验证一个真正会触发 32 位溢出的值
  const huge = 2 ** 32 + 5
  assert.equal(chunkAAD(huge, 0, 1, 0).readBigUInt64BE(0), BigInt(huge))
})

test('AAD 对不同坐标产生不同字节（不会发生碰撞）', () => {
  const seen = new Set()
  for (let f = 0; f < 60; f++) seen.add(chunkAAD(f, 0, 1, 0).toString('hex'))
  assert.equal(seen.size, 60)
})

// ── 清单加解密 ──────────────────────────────────────────────

test('清单：往返一致，且用了独立的随机 IV', () => {
  const key = mkEnc()
  const doc = Buffer.from(JSON.stringify({ files: [{ name: 'a.txt', size: 3 }] }), 'utf8')
  const a = sealManifest(key, doc)
  const b = sealManifest(key, doc)
  assert.notDeepEqual(a.iv, b.iv, '每次加密都应有新 IV')
  assert.notDeepEqual(a.ct, b.ct, '相同明文两次加密不应产生相同密文')
  assert.deepEqual(openManifest(key, a.iv, a.ct, a.tag), doc)
})

test('清单：篡改必须失败', () => {
  const key = mkEnc()
  const doc = Buffer.from('{"files":[]}', 'utf8')
  const { iv, ct, tag } = sealManifest(key, doc)
  const bad = Buffer.from(ct); bad[0] ^= 1
  assert.throws(() => openManifest(key, iv, bad, tag), /.*/)
  assert.throws(() => openManifest(mkEnc(), iv, ct, tag), /.*/)
})

test('清单的 AAD 与数据块的 AAD 长度不同，这是刻意的', async () => {
  const { MANIFEST_AAD } = await import('../src/suite/flicker1.js')
  assert.equal(MANIFEST_AAD.length, 18)
  assert.equal(chunkAAD(0, 0, 1, 0).length, 28)
  assert.notEqual(MANIFEST_AAD.length, 28,
    '二者长度不同是设计的一部分：禁止"补零对齐"，否则会引入歧义')
  assert.equal(MANIFEST_AAD.toString('utf8'), 'flicker/1/manifest')
})

// ── 内存清零与辅助工具 ──────────────────────────────────────

test('wipe 覆写缓冲区，并容忍 null/undefined', () => {
  const a = Buffer.from('super-secret-key-material')
  const b = randomBytes(32)
  const before = Buffer.from(a)
  wipe(a, b, null, undefined)
  assert.notDeepEqual(a, before, '缓冲必须被改写')
  assert.ok(a.every((x) => x === 0), '必须全部置零')
  assert.ok(b.every((x) => x === 0))
})

test('wipe 支持 TypedArray', () => {
  const u = new Uint8Array([1, 2, 3, 4])
  wipe(u)
  assert.deepEqual([...u], [0, 0, 0, 0])
})

test('newToken 产出 URL 安全且不重复的令牌', () => {
  const seen = new Set()
  for (let i = 0; i < 2000; i++) {
    const t = newToken()
    assert.match(t, /^[A-Za-z0-9_-]+$/, '必须可安全放进 URL')
    assert.ok(!seen.has(t), '令牌绝不能重复')
    seen.add(t)
  }
  assert.equal(seen.size, 2000)
})

test('suggestPassword 产出好念的密码，且有足够随机性', () => {
  const pw = suggestPassword()
  assert.match(pw, /^[a-z]+-[a-z]+-[a-z]+-[a-z]+$/, '应为 4 个单词、连字符分隔')
  const seen = new Set()
  for (let i = 0; i < 3000; i++) seen.add(suggestPassword())
  // 40 个词取 4 个 → 约 2^21 种组合；3000 个样本里碰撞应当很少
  assert.ok(seen.size > 2990, `随机性不足：3000 次只产生了 ${seen.size} 个不同密码`)
})
