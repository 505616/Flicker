/**
 * 会话的认证失败上限（在线暴力破解防护）。
 *
 * 为什么这条值得用测试钉住：它是**唯一**限制"在线猜密码"的机制 ——
 * 攻击者可以反复调用认证端点试密码，600,000 次 PBKDF2 迭代只保护
 * **离线**攻击（攻击者拿到密文后本地算），对在线尝试没用。
 *
 * 而且它的失败方式很安静：如果哪天有人动了 `_fail()`，
 * 变成"只是抛错、不销毁会话"，那么：
 *   · 表象完全正常（密码错的仍然被拒）
 *   · 但密码可以无限次尝试 —— 一个 6 位数字密码几小时就能撞开
 * 没有任何界面会显示异常，只有这条测试能发现。
 *
 * 实现位置：src/session.js 的 `_fail()`（第 5 次调用 destroy()）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Session, MAX_AUTH_FAILURES, PHASE } from '../src/session.js'
import { PARAMS } from '../src/suite/flicker1.js'
import { randomBytes } from 'node:crypto'

function makeSession() {
  const events = []
  const session = new Session({
    password: 'the-right-password',
    salt: randomBytes(PARAMS.saltBytes),
    encManifest: Buffer.from('ct'),
    manifestIv: Buffer.alloc(12),
    manifestTag: Buffer.alloc(16),
    onEvent: (e) => events.push(e),
  })
  return { session, events }
}

/** 走一次"密码不对"的认证，返回抛出的错误码 */
function attemptWrongPassword(session) {
  const { challenge } = session.startAuth()
  try {
    session.finishAuth({ mac: Buffer.alloc(32).toString('base64'), challenge })
    return null
  } catch (e) {
    return e.code
  }
}

test('密码错误会被拒（这是"两台电脑密码必须一致"的落点）', () => {
  const { session } = makeSession()
  assert.equal(attemptWrongPassword(session), 'BAD_PASSWORD')
  // 注意：失败后 phase 停在 AUTH（startAuth 已经把它从 WAITING 推进了），
  // 所以"会话还活着"的判据是 destroyed，不是 phase === WAITING。
  assert.equal(session.destroyed, false, '一次失败不该销毁会话')
  assert.equal(session.failures, 1)
})

test(`⭐ 连续 ${MAX_AUTH_FAILURES} 次失败必须**销毁整个会话**（不是只报错）`, () => {
  const { session, events } = makeSession()
  const keysBefore = session.keys

  for (let i = 1; i < MAX_AUTH_FAILURES; i++) {
    assert.equal(attemptWrongPassword(session), 'BAD_PASSWORD', `第 ${i} 次应报密码错误`)
    assert.equal(session.destroyed, false,
      `第 ${i} 次失败还不该销毁（上限是 ${MAX_AUTH_FAILURES}）`)
  }

  // 第 MAX_AUTH_FAILURES 次 —— 这一次必须销毁
  assert.equal(attemptWrongPassword(session), 'BAD_PASSWORD')
  assert.equal(session.phase, PHASE.DESTROYED,
    `第 ${MAX_AUTH_FAILURES} 次失败后会话必须进入 DESTROYED。` +
    '若这里还是 WAITING，说明"失败上限"只是抛了个错 —— ' +
    '攻击者可以无限次在线猜密码，而界面上看不出任何异常')
  assert.equal(session.destroyed, true)

  // 密钥与盐必须被清零（不是只改个标记）
  assert.equal(session.keys, null, '销毁后不该还留着密钥引用')
  assert.equal(session.salt, null, '销毁后不该还留着盐')
  assert.equal(session.verifier, null, '销毁后不该还留着 verifier')
  assert.ok(keysBefore, '（对照）销毁前 keys 应当是存在的')
})

test('⭐ 销毁后不能再发起认证 —— 否则"上限"形同虚设', () => {
  const { session } = makeSession()
  for (let i = 0; i < MAX_AUTH_FAILURES; i++) attemptWrongPassword(session)
  assert.equal(session.phase, PHASE.DESTROYED)

  // 再想开一轮认证必须被拒，而且理由必须是"已经不能用了"。
  // 这里报 TOO_MANY_FAILURES（而不是笼统的 DESTROYED）是**故意的**：
  // 界面上要能说出"是密码错了太多次，让电脑那边重新发起"，
  // 而 DESTROYED 只够说"没了"。两者都 410，但给用户的信息量差一整句。
  assert.throws(() => session.startAuth(), (e) => {
    assert.equal(e.code, 'TOO_MANY_FAILURES',
      '次数到上限而死的会话，必须报得出原因；若报 DESTROYED，界面只能说"会话已销毁"')
    assert.match(e.message, /已销毁/, '原因里要说明会话已经不能用了')
    return true
  })

  // ⚠️ 但"因为失败次数"和"因为别的原因销毁"必须分得开 ——
  //    否则哪天把超时/用户取消也误报成"暴力破解上限"，用户会以为是有人攻击他。
  const other = makeSession().session
  other.destroy()                      // 例如超时或用户点了取消
  assert.equal(other.failures, 0, '（前提）这条路径一次失败都没有')
  assert.throws(() => other.startAuth(), (e) => e.code === 'DESTROYED',
    '不是因为失败次数而销毁的会话，报的必须是 DESTROYED')
})

test('⭐ 销毁后连正确的密码也用不了（会话是一次性的）', () => {
  const { session } = makeSession()
  for (let i = 0; i < MAX_AUTH_FAILURES; i++) attemptWrongPassword(session)

  // 即便攻击者随后拿到了正确密码，这个会话也已经死了 ——
  // 必须重新建一个会话（而新会话意味着重新生成密钥与一次性令牌）
  assert.throws(() => session.startAuth(), (e) => e.code === 'TOO_MANY_FAILURES')
  assert.equal(session.keys, null)
})

test('失败计数与销毁过程对调用方可见（供 UI 提示"还剩几次"）', () => {
  const { session, events } = makeSession()
  attemptWrongPassword(session)
  attemptWrongPassword(session)

  const failed = events.filter((e) => e.type === 'auth-failed')
  assert.equal(failed.length, 2)
  assert.equal(failed[0].max, MAX_AUTH_FAILURES, '事件里要带上限，UI 才能算"还剩几次"')
  assert.equal(failed[1].failures, 2)

  const destroyed = events.filter((e) => e.type === 'destroyed')
  assert.equal(destroyed.length, 0, '还没到上限，不该有销毁事件')

  for (let i = 2; i < MAX_AUTH_FAILURES; i++) attemptWrongPassword(session)
  const after = events.filter((e) => e.type === 'destroyed')
  assert.equal(after.length, 1, '销毁事件应当只发一次（destroy 是幂等的）')

  const reasons = events.filter((e) => e.type === 'destroy-reason')
  assert.ok(reasons.some((r) => /失败次数/.test(r.reason)),
    '应当说明销毁原因，否则用户不知道为什么突然断了')
})

test('挑战不匹配也计入失败次数（防止用重放来绕过计数）', () => {
  const { session } = makeSession()
  const { challenge } = session.startAuth()
  // 用一个**别的**挑战去应答 —— 这是重放尝试
  assert.throws(
    () => session.finishAuth({ mac: Buffer.alloc(32).toString('base64'), challenge: 'AAAA' }),
    (e) => e.code === 'CHALLENGE_MISMATCH')
  assert.equal(session.failures, 1,
    '挑战不匹配也必须计数 —— 否则攻击者可以拿它反复试探而不触发上限')
  void challenge
})
