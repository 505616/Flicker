/**
 * 取块预取器的测试（`web/receiver.html` 里的 createPrefetcher）
 * ============================================================
 *
 * ── 为什么会有这个东西 ──
 * 2026-10 实测（`_lab/bench-recv-rtt.mjs`，真实页面 + 真 Edge + 双向延迟中继）：
 * 逐块串行取块在 195 ms 往返上只有 **4.0 MB/s** —— 相邻两次取块间隔中位 261 ms，
 * 其中真正算东西的只有约 20 ms，其余全在等一个往返。同样的链路换成 4~6 块并发
 * 能到 17.0 / 24.5 MB/s。所以取块这一步必须流水线化。
 *
 * ── 为什么这一条需要这么多测试 ──
 * 它是这个项目里**最容易出细微错误**的一块：一个有界的乱序缓冲 +
 * 按序交货 + 取消清理，任何一条破了都不会立刻炸，而是表现为
 * "偶尔卡住""内存慢慢涨""第 3 块坏了结果第 1、2 块也白收"。
 * 所以每个性质单独立一条，而且判据都尽量是**数出来的**（计数、表大小、到达顺序）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PARAMS } from '../src/suite/flicker1.js'
import { sliceFn } from './receiver-relay-tests.js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const html = await readFile(path.join(root, 'web', 'receiver.html'), 'utf8')

const tick = () => new Promise((r) => setTimeout(r, 0))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 把页面里的 createPrefetcher 抽出来在 Node 里跑（与页面用的是同一份源码） */
const makePrefetcher = (() => {
  const src = sliceFn(html, 'createPrefetcher')
  // eslint-disable-next-line no-new-func
  return new Function(src + '\nreturn createPrefetcher')()
})()

/** 同理抽出 prefetchDepth（它决定默认深度与上限） */
const prefetchDepth = (() => {
  const depths = /const PREFETCH_MAX = (\d+);/.exec(html)
  const dflt = /const PREFETCH_DEFAULT = (\d+);/.exec(html)
  assert.ok(depths && dflt, '页面里应当有 PREFETCH_MAX 与 PREFETCH_DEFAULT 两个常量')
  const src = sliceFn(html, 'prefetchDepth')
  // eslint-disable-next-line no-new-func
  const fn = new Function(`const PREFETCH_MAX = ${depths[1]};const PREFETCH_DEFAULT = ${dflt[1]};`
    + src + '\nreturn prefetchDepth')()
  return { fn, max: Number(depths[1]), dflt: Number(dflt[1]) }
})()

test('⭐ 预取：真的并发发出（深度 4 → 一上来就有 4 个请求在飞）', async () => {
  let started = 0
  const fetchChunk = (seq) => { started++; return new Promise(() => {}) }   // 永不解决
  const pf = makePrefetcher(fetchChunk, 4)
  const p = pf.take(0)
  await tick()
  assert.equal(started, 4, `深度 4 应当立刻发出 4 个请求（实际 ${started}）`)
  assert.equal(pf.pendingCount, 4, '挂起表里应当正好 4 项')
  pf.stop()
  await p.catch(() => {})
})

test('⭐ 预取：网络乱序返回，按序消费仍然严格按序拿到 0,1,2', async () => {
  // ⚠️ 契约要说清楚：预取器**不保证**"谁先回来谁先交货" —— 它保证的是
  //    ① 几块同时在飞  ② 消费方按序 take 时，拿到的就是那一块、且不会越过没到的那一块。
  //    写盘的顺序由消费方（receive 的循环）保证，所以"第 3 块先回来也不能先写"。
  const resolvers = new Map()
  const started = []
  const fetchChunk = (seq) => {
    started.push(seq)
    return new Promise((res) => resolvers.set(seq, res))
  }
  const pf = makePrefetcher(fetchChunk, 3)
  const got = []
  const consuming = (async () => {
    for (const s of [0, 1, 2]) got.push((await pf.take(s)).seq)
  })()
  await tick()
  assert.deepEqual(started, [0, 1, 2], '三块应当同时发出 —— 这才是"预取"的意义')

  // 第 3 块先回来：消费方必须**停在**第 1 块上，不能跳过去先写第 3 块
  resolvers.get(2)({ seq: 2 })
  await tick()
  assert.deepEqual(got, [], '第 1 块还没到，按序消费必须停在它上面')
  resolvers.get(0)({ seq: 0 })
  await tick()
  resolvers.get(1)({ seq: 1 })
  await consuming
  assert.deepEqual(got, [0, 1, 2], '最终交货顺序必须是 0,1,2')
})

test('⭐ 预取：内存有界 —— 判据是"挂起表大小"，不是"在飞请求数"', async () => {
  // 这个用例专抓一个非常容易写错的实现：只按"在飞请求数"封顶。
  // 那样的话，取回很快 + 消费很慢时，已取回但没消费的块会无限堆积。
  let live = 0
  const fetchChunk = async (seq) => { live++; await sleep(5); live--; return { seq } }
  const pf = makePrefetcher(fetchChunk, 3)

  await pf.take(0)
  // 消费者故意停在这里不动，让"取回"远远跑在前面
  for (let i = 0; i < 20; i++) await sleep(10)
  assert.ok(pf.pendingCount <= 3,
    `挂起表必须 ≤ 深度 3（实际 ${pf.pendingCount}）—— ` +
    '只数在飞请求的实现会在这里涨到几十')
  assert.ok(live <= 3, `同时在飞的请求也必须 ≤ 3（实际 ${live}）`)
  pf.stop()
})

test('⭐ 预取：错误按序抛出，前面的块不受牵连', async () => {
  const boom = Object.assign(new Error('第 3 块坏了'), { code: 'DECRYPT' })
  const fetchChunk = async (seq) => {
    if (seq === 2) throw boom
    return { seq }
  }
  const pf = makePrefetcher(fetchChunk, 3)
  assert.deepEqual(await pf.take(0), { seq: 0 }, '第 1 块应当正常到手')
  assert.deepEqual(await pf.take(1), { seq: 1 }, '第 2 块应当正常到手')
  await assert.rejects(() => pf.take(2), (e) => e === boom,
    '第 3 块的错误必须原样抛出（错误码要能透到界面上）')
  assert.deepEqual(await pf.take(3), { seq: 3 }, '坏块的后面应当继续能用')
})

test('⭐ 预取：坏块的错误不会变成"未处理的拒绝"', async () => {
  // 没接住的话 Node 会打 unhandledRejection（浏览器里是控制台报错），
  // 而且**进程可能直接退出** —— 这类问题在页面上表现为"莫名其妙中断"。
  const seen = []
  const onUnhandled = (e) => seen.push(e)
  process.on('unhandledRejection', onUnhandled)
  try {
    const fetchChunk = async (seq) => { if (seq === 1) throw new Error('坏'); return seq }
    const pf = makePrefetcher(fetchChunk, 3)
    await pf.take(0)
    pf.stop()                       // 第 1 块的错误没人消费就取消了
    await sleep(30)
    assert.deepEqual(seen, [], '取消之后，未被消费的错误也不该冒成未处理拒绝')
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('⭐ 预取：stop() 之后不再发起新请求，并立刻丢掉缓冲', async () => {
  let started = 0
  const pf = makePrefetcher(async (seq) => { started++; return seq }, 4)
  assert.equal(await pf.take(0), 0)
  const before = started
  assert.ok(before >= 4, `取完第 1 块时应当已经预取了后面的（实际只发了 ${before} 个）`)

  pf.stop()
  assert.equal(pf.pendingCount, 0, 'stop() 必须立刻释放挂起表（内存马上回来）')
  await sleep(30)
  assert.equal(started, before, 'stop() 之后不许再发起任何新请求')
})

test('预取：跳号（前面有文件被跳过）时丢掉旧缓冲、不越界', async () => {
  const seen = []
  const pf = makePrefetcher(async (seq) => { seen.push(seq); return seq }, 3)
  assert.equal(await pf.take(0), 0)
  // 模拟"中间整个文件已经收过、被跳过"：直接跳到第 10 块
  assert.equal(await pf.take(10), 10)
  assert.ok(pf.pendingCount <= 3)
  assert.ok(seen.includes(10), `跳号之后应当去取第 10 块（实际取过 ${seen.join(',')}）`)
  assert.equal(await pf.take(11), 11, '跳号之后要能继续按序走')
})

test('预取：不按序调用 take() 会被显式拒绝（页面自己的 bug 不该悄悄过去）', async () => {
  const pf = makePrefetcher(async (seq) => seq, 3)
  await pf.take(0)
  await pf.take(1)
  // 往回取：这一块已经被消费并丢掉了
  await assert.rejects(() => pf.take(0), (e) => e.code === 'PREFETCH_SEQ')
})

test('⭐ 默认深度与上限：默认 6、上限 6（浏览器同源并发连接就是 6）', () => {
  assert.equal(prefetchDepth.dflt, 6,
    '默认深度应当是 6 —— A/B 实测（RTT 195 ms）串行 4.1、深度 4 是 14.0、深度 6 是 17.0 MB/s')
  assert.equal(prefetchDepth.max, 6,
    '上限必须是 6 —— 浏览器对同一个源最多 6 条并发连接，再加深度不会更快')
  assert.equal(prefetchDepth.fn(''), 6, '没有 pf 参数时用默认值')
  assert.equal(prefetchDepth.fn('#k=aa&s=bb'), 6)
  assert.equal(prefetchDepth.fn('#k=aa&s=bb&pf=4'), 4, 'pf 覆盖要生效（A/B 用）')
  assert.equal(prefetchDepth.fn('#pf=1'), 1)
  assert.equal(prefetchDepth.fn('#pf=99'), 6, '超过上限一律压到 6，不许"尽力而为"')
  assert.equal(prefetchDepth.fn('#pf=0'), 6, '非法值回落默认')
  assert.equal(prefetchDepth.fn('#pf=abc'), 6)
  assert.equal(prefetchDepth.fn('#pf=2x'), 6, '半截数字不算数')
})

test('⭐ 内存上限是硬的：默认深度 × 块大小 = 6 MiB', () => {
  const cap = prefetchDepth.dflt * PARAMS.chunkBytes
  assert.equal(cap, 6 * 1024 * 1024,
    `默认预取的缓冲上限应当是 6 MiB（实际 ${(cap / 1024 / 1024).toFixed(1)} MiB）—— ` +
    '这个数写进文档里的"大文件不爆内存"承诺里，改深度要一起改说法')
})

test('页面确实把取块接到了预取器上（不只是写了个没人用的类）', () => {
  const receiveSrc = sliceFn(html, 'receive')
  assert.match(receiveSrc, /createPrefetcher\(/, 'receive() 里要创建预取器')
  assert.match(receiveSrc, /S\.transport\.getChunk\(s\)/,
    '预取器要接在传输层的 getChunk 上（两条通路共用同一个收口）')
  assert.match(receiveSrc, /await prefetch\.take\(seq\)/,
    '取块必须走 prefetch.take(seq) —— 直接调 getChunk 就等于又变回串行')
  assert.match(receiveSrc, /prefetch\.stop\(\)/,
    '失败/取消时必须停掉预取器（否则它会继续把后面的块取回来）')

  // 顺序语义一个字都不许变：写盘后才 ack、且 ack 在取块之后
  const iTake = receiveSrc.indexOf('prefetch.take(seq)')
  const iWrite = receiveSrc.indexOf('await sink.write(pt)')
  const iAck = receiveSrc.indexOf('S.transport.ack?.(seq)')
  assert.ok(iTake < iWrite && iWrite < iAck,
    '顺序必须是 取块 → 写盘 → ack（ack 提前会让中继删掉还没落盘的块）')
})
