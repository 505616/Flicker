/**
 * 块大小策略与能力协商的测试
 * ==========================
 *
 * ── 这一套判据防的是什么 ──
 * "块大小"看着像个性能参数，其实是**跨端兼容性**问题：一条消息就是一块，
 * 而中继有单条上限。写错的话症状是**对方的中继 413 拒收**（或者更糟：
 * 老中继收下了、新客户端以为成功了），而用户完全不知道发生了什么。
 *
 * 所以这里把四条判据钉住：
 *   ① 老中继（不声明能力）→ 一定回落到协议保证的 1 MiB + 17，绝不冒险
 *   ② 中继声明的上限**优先于**用户想要的（宁可压小，不可发出去被拒）
 *   ③ "自动"只在对方允许时才变大（2 MiB 是实测甜点，不是拍脑袋）
 *   ④ 我们自己也有上限（超过 BDP 之后更大的块只买内存与更粗的粒度）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseChunkSpec, chooseChunkBytes, fetchRelayCaps,
  PROTOCOL_MIN_MESSAGE_BYTES, MESSAGE_OVERHEAD,
  AUTO_CHUNK_BYTES, MAX_CHUNK_BYTES, MIN_CHUNK_BYTES,
} from '../src/chunk-size.js'
import { DEFAULT_MAX_MESSAGE_BYTES, MAX_MESSAGE_BYTES, RoomStore } from '../src/relay/room.js'

const MiB = 1 << 20

test('⭐ 老中继没声明能力 → 回落到协议保证的最小值（绝不冒险）', () => {
  const { chunkBytes, reason } = chooseChunkBytes({ spec: { kind: 'auto' }, maxMessageBytes: null })
  assert.equal(chunkBytes, MAX_MESSAGE_BYTES - MESSAGE_OVERHEAD,
    '不声明时必须按协议最小值走')
  assert.equal(chunkBytes, 1 * MiB)
  assert.equal(reason, 'relay-limit', '要说清"是被对方的上限压下来的"')
})

test('⭐ 中继声明的上限优先于用户想要的（宁可压小，不可发出去被拒）', () => {
  // 用户明确要 4 MiB，但对端只收 1 MiB → 必须压到 1 MiB，而不是发出去等 413
  const r1 = chooseChunkBytes({ spec: { kind: 'size', bytes: 4 * MiB }, maxMessageBytes: MAX_MESSAGE_BYTES })
  assert.equal(r1.chunkBytes, 1 * MiB)
  assert.equal(r1.reason, 'relay-limit')

  // 对方收 2 MiB 时，用户要 4 MiB 也只能给 2 MiB
  const r2 = chooseChunkBytes({ spec: { kind: 'size', bytes: 4 * MiB }, maxMessageBytes: DEFAULT_MAX_MESSAGE_BYTES })
  assert.equal(r2.chunkBytes, 2 * MiB)
})

test('⭐ 自动模式：对方允许 2 MiB 才用 2 MiB（实测甜点，不是拍脑袋）', () => {
  assert.equal(chooseChunkBytes({ spec: { kind: 'auto' }, maxMessageBytes: DEFAULT_MAX_MESSAGE_BYTES }).chunkBytes,
    AUTO_CHUNK_BYTES)
  assert.equal(AUTO_CHUNK_BYTES, 2 * MiB, '自动目标就是实测的甜点 2 MiB')
  // 局域网没有中继这条约束（传 Infinity）→ 同样是 2 MiB
  assert.equal(chooseChunkBytes({ spec: { kind: 'auto' }, maxMessageBytes: Infinity }).chunkBytes, 2 * MiB)
})

test('⭐ 我们自己也有上限：不会因为对方"很能收"就把块开到任意大', () => {
  const r = chooseChunkBytes({ spec: { kind: 'auto' }, maxMessageBytes: 64 * MiB })
  assert.equal(r.chunkBytes, Math.min(AUTO_CHUNK_BYTES, MAX_CHUNK_BYTES))
  const big = chooseChunkBytes({ spec: { kind: 'size', bytes: 32 * MiB }, maxMessageBytes: 64 * MiB })
  assert.equal(big.chunkBytes, MAX_CHUNK_BYTES, `不应超过自己的上限 ${MAX_CHUNK_BYTES / MiB} MiB`)
  assert.equal(big.reason, 'our-limit')
})

test('块大小有下限：给个荒唐的小值也不会把往返次数放大到天上', () => {
  const r = chooseChunkBytes({ spec: { kind: 'size', bytes: 1024 }, maxMessageBytes: null })
  assert.equal(r.chunkBytes, MIN_CHUNK_BYTES)
  assert.equal(r.reason, 'too-small')
})

test('--chunk 的写法：auto / 512k / 2m / 4M / 纯字节数；看不懂就报错而不是静默忽略', () => {
  assert.deepEqual(parseChunkSpec(undefined), { kind: 'auto' })
  assert.deepEqual(parseChunkSpec(true), { kind: 'auto' })
  assert.deepEqual(parseChunkSpec('auto'), { kind: 'auto' })
  assert.deepEqual(parseChunkSpec('512k'), { kind: 'size', bytes: 512 * 1024 })
  assert.deepEqual(parseChunkSpec('2m'), { kind: 'size', bytes: 2 * MiB })
  assert.deepEqual(parseChunkSpec('4M'), { kind: 'size', bytes: 4 * MiB })
  assert.deepEqual(parseChunkSpec('2097152'), { kind: 'size', bytes: 2 * MiB })

  for (const bad of ['abc', '2x', '', 'm', '-1']) {
    const r = parseChunkSpec(bad)
    assert.ok(r.error, `「${bad}」应当被拒绝并给出写法提示`)
    assert.match(r.error, /可用写法/, '报错要直接告诉用户怎么写')
  }
})

test('⭐ 中继默认收得下 2 MiB，而协议最小值仍然是 1 MiB（两个常量不能混）', () => {
  assert.equal(MAX_MESSAGE_BYTES, (1 << 20) + 17, '协议保证的最小值不能动 —— 老客户端按它来')
  assert.equal(DEFAULT_MAX_MESSAGE_BYTES, (2 << 20) + 17, '本项目部署的默认值')
  const store = new RoomStore()
  assert.equal(store.maxMessageBytes, DEFAULT_MAX_MESSAGE_BYTES,
    '默认构造的 store 应当允许 2 MiB（本地中继与 Worker 都用这个默认）')
  // 出厂的 Worker / 本地中继都靠这个默认值，所以它必须 >= 客户端的自动目标 + 开销
  assert.ok(DEFAULT_MAX_MESSAGE_BYTES >= AUTO_CHUNK_BYTES + MESSAGE_OVERHEAD,
    '否则"自动"在自家中继上都会被压回 1 MiB')
})

test('能力探测：读 /health 的 maxMessageBytes；老中继返回纯文本时回落', async () => {
  const fake = (body, ok = true, status = 200) => async () => ({
    ok, status, text: async () => body,
  })

  const modern = await fetchRelayCaps('http://x', fake('{"ok":true,"maxMessageBytes":2097169}'))
  assert.equal(modern.maxMessageBytes, 2097169)
  assert.equal(modern.legacy, false)

  // 老中继：`/health` 返回的是纯文本 "ok"（本程序 0.1.0 之前的实现）
  const old = await fetchRelayCaps('http://x', fake('ok'))
  assert.equal(old.maxMessageBytes, PROTOCOL_MIN_MESSAGE_BYTES)
  assert.equal(old.legacy, true, '要标成 legacy，好让上层解释"为什么这次是 1 MiB"')

  // 中继返回 4xx/5xx、或者根本连不上 → 一律回落，不能猜
  const bad = await fetchRelayCaps('http://x', fake('nope', false, 500))
  assert.equal(bad.maxMessageBytes, PROTOCOL_MIN_MESSAGE_BYTES)
  const dead = await fetchRelayCaps('http://x', async () => { throw new Error('ECONNREFUSED') })
  assert.equal(dead.maxMessageBytes, PROTOCOL_MIN_MESSAGE_BYTES)
  assert.match(dead.detail, /问不到/, '失败原因要写清楚（排查时全靠它）')
})

test('中继把能力挂在 /health 与创建响应上（客户端两处都能读到）', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/relay/protocol.js', import.meta.url), 'utf8')
  // ⚠️ 这个窗口给得比较宽（900 字符），因为它中间现在还有一段**插件贡献字段**的合并逻辑：
  //    `relay/health` 允许插件往 /health 里加字段，但核心字段排在后面（插件的覆盖不了）。
  //    第一版窗口是 200，加插件时就被这条判据拦下了 —— 拦得对，但断言该盯的是
  //    "这两处都在返回能力"，而不是"它们挨得有多近"。
  assert.match(src, /pathname === '\/health'[\s\S]{0,900}maxMessageBytes: store\.maxMessageBytes/,
    '/health 必须返回 maxMessageBytes —— 能力协商的入口')
  assert.match(src, /maxMessageBytes: store\.maxMessageBytes/,
    '创建响应里也要带一份（发送端一定会走那一步，不必多发请求）')
})
