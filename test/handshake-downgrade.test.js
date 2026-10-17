/**
 * 握手 MAC 的降级保护（v2 = 绑套件 / v1 = 旧字节）
 * ==============================================
 *
 * ── 这道保护要挡的是什么 ──
 * 将来加了第二套加密算法之后，中间人（或中继）可以**把"我支持哪些套件"这条报价抹掉**，
 * 迫使双方退回较弱的套件 —— 而双方都以为自己是在正常协商。
 * 挡法是 TLS 的 downgrade sentinel 那套：接收端**必须如实回执自己用了哪套构造**，
 * 发送端看到"我报了新版、对方却回执旧版"就**直接中止**。
 *
 * ── 三条判据 ──
 *   ① 新版对端（会回执 v2）→ 用绑了 suite_id 的构造，双方一致
 *   ② **老版对端**（根本不回执）→ 按 v1 继续，但记下 `macProfile='v1'` 让上层告警
 *      （这条是兼容性：0.1.0 的接收页没有这个字段，不能因此拒绝它）
 *   ③ 报价被抹掉 / 被改（对方回执 v1，而我明明报了 v2）→ **中止**，且原因不是"密码错误"
 *
 * 另外还要钉住：**套件 id 真的进了被认证的材料** —— 改套件必然导致 MAC 不符。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import { Session, SessionError } from '../src/session.js'
import {
  MAC_PROFILES, macInput, receiverMac, senderMac, deriveVerifier, deriveKeys, SUITE_ID,
} from '../src/suite/flicker1.js'

const PASSWORD = 'downgrade-test-pass'

/** 造一个会话（真正的构造方式：给密码 + 盐，让它自己派生密钥） */
function sessionWithKeys() {
  const events = []
  const s = new Session({
    password: PASSWORD,
    salt: randomBytes(16),
    encManifest: Buffer.from('ct'),
    manifestIv: Buffer.from('iv'),
    manifestTag: Buffer.from('tag'),
    onEvent: (e) => events.push(e),
  })
  return { s, keys: s.keys, events }
}

test('⭐ v2 把套件 id 绑进了被认证的材料（改套件 → MAC 必变）', () => {
  const key = randomBytes(32)
  const nonce = randomBytes(32)

  const v2 = macInput('recv', nonce, { profile: 'v2' })
  assert.equal(v2.subarray(0, Buffer.from(`${SUITE_ID}\nrecv\n`).length).toString('utf8'),
    `${SUITE_ID}\nrecv\n`, 'v2 的前缀必须是「套件id + 换行 + 方向 + 换行」')

  const macOf = (suite) => createHmac('sha256', key)
    .update(macInput('recv', nonce, { profile: 'v2', suite })).digest('hex')

  assert.notEqual(macOf('FLICKER/1'), macOf('FLICKER/2'),
    '换了套件 id 却算出同一个 MAC —— 那 suite_id 就没被绑进认证材料，降级保护等于没有')
  assert.equal(macOf('FLICKER/1'), receiverMac(key, nonce, { profile: 'v2' }).toString('hex'),
    'receiverMac 默认就该用 v2')
})

test('⭐ v1 必须逐字节等于 0.1.0 的线上构造（否则老对端全连不上）', () => {
  const key = randomBytes(32)
  const nonce = randomBytes(32)
  // 这就是发布出去的那套字节：`flicker/1/<role>\n` ‖ nonce
  const legacy = Buffer.concat([Buffer.from('flicker/1/recv\n', 'utf8'), nonce])
  assert.deepEqual(macInput('recv', nonce, { profile: 'v1' }), legacy)
  assert.equal(receiverMac(key, nonce, { profile: 'v1' }).toString('hex'),
    createHmac('sha256', key).update(legacy).digest('hex'))
  // 两种构造必须不同（否则等于没改）
  assert.notDeepEqual(macInput('recv', nonce, { profile: 'v1' }),
    macInput('recv', nonce, { profile: 'v2' }))
})

test('⭐ 新版接收端回执 v2 → 握手成功，且用的是绑定构造', () => {
  const { s, keys } = sessionWithKeys()
  const started = s.startAuth()
  assert.deepEqual(started.macProfiles, [...MAC_PROFILES], '报价应当含 v2 与 v1')
  const challenge = Buffer.from(started.challenge, 'base64')

  const fin = s.finishAuth({
    challenge: started.challenge,
    mac: receiverMac(keys.auth, challenge, { profile: 'v2' }).toString('base64'),
    macProfile: 'v2',
  })
  assert.equal(fin.macProfile, 'v2')
  assert.equal(s.macProfile, 'v2', '会话要记住这次用的是哪套构造')
  assert.equal(fin.mac, senderMac(keys.auth, challenge, { profile: 'v2' }).toString('base64'),
    '回送的发送端应答也必须用同一套构造')
})

test('⭐ 老版接收端（根本不回执）→ 按 v1 继续，但如实记下"旧版"', () => {
  const { s, keys } = sessionWithKeys()
  const started = s.startAuth()
  const challenge = Buffer.from(started.challenge, 'base64')

  // 0.1.0 的页面：不传 macProfile，MAC 用旧字节算
  const fin = s.finishAuth({
    challenge: started.challenge,
    mac: receiverMac(keys.auth, challenge, { profile: 'v1' }).toString('base64'),
  })
  assert.equal(fin.macProfile, 'v1')
  assert.equal(s.macProfile, 'v1',
    '要记下来：上层据此**明确告警**"对方版本较旧，本次无法防套件降级"，而不是假装一切正常')
  assert.equal(fin.mac, senderMac(keys.auth, challenge, { profile: 'v1' }).toString('base64'))
})

test('⛔ 报价被抹掉（对方回执 v1，而我报了 v2）→ 中止，且不是"密码错误"', () => {
  const { s, keys } = sessionWithKeys()
  const started = s.startAuth()
  const challenge = Buffer.from(started.challenge, 'base64')

  assert.throws(() => s.finishAuth({
    challenge: started.challenge,
    mac: receiverMac(keys.auth, challenge, { profile: 'v1' }).toString('base64'),
    macProfile: 'v1',            // ← 新页面被"没看到报价"时就会这样回执：这就是降级信号
  }), (e) => {
    assert.ok(e instanceof SessionError)
    assert.equal(e.code, 'E_DOWNGRADE')
    assert.match(e.message, /篡改|降级|中间人/, '报错要说清是协商被动了手脚，而不是密码问题')
    return true
  })
})

test('⛔ 回执了不认识的构造 → 拒绝（不是静默按 v1 处理）', () => {
  const { s, keys } = sessionWithKeys()
  const started = s.startAuth()
  const challenge = Buffer.from(started.challenge, 'base64')
  assert.throws(() => s.finishAuth({
    challenge: started.challenge,
    mac: receiverMac(keys.auth, challenge, { profile: 'v1' }).toString('base64'),
    macProfile: 'v9',
  }), (e) => e.code === 'BAD_PROFILE')
})

test('⛔ 谎报构造：回执 v2 却给 v1 的 MAC → 认证失败（不能靠"声称"过关）', () => {
  const { s, keys } = sessionWithKeys()
  const started = s.startAuth()
  const challenge = Buffer.from(started.challenge, 'base64')
  assert.throws(() => s.finishAuth({
    challenge: started.challenge,
    mac: receiverMac(keys.auth, challenge, { profile: 'v1' }).toString('base64'),
    macProfile: 'v2',            // 声称用了新版，实际给的是旧字节
  }), (e) => e.code === 'BAD_PASSWORD')
})

test('每种构造都必须真的被验过：密码不对时两种构造都拒绝', () => {
  const { s } = sessionWithKeys()
  const wrong = deriveKeys(deriveVerifier('wrong-password', randomBytes(16)))
  for (const profile of MAC_PROFILES) {
    const st = s.startAuth()
    const challenge = Buffer.from(st.challenge, 'base64')
    assert.throws(() => s.finishAuth({
      challenge: st.challenge,
      mac: receiverMac(wrong.auth, challenge, { profile }).toString('base64'),
      // ⚠️ v1 这一路**不能**带 macProfile：带了就是"回执旧版构造"，
      //    那会先撞上降级保护（E_DOWNGRADE），测不到"密码不对"这条。
      //    真实的老对端本来就不带这个字段（见上一条用例）。
      ...(profile === 'v1' ? {} : { macProfile: profile }),
    }), (e) => e.code === 'BAD_PASSWORD', `${profile}：错密码必须被拒`)
  }
})
