/**
 * 发送限速（`--rate`）。
 *
 * 为什么值得写用例：限速器有两类**沉默的**错误方式 ——
 *
 *   ① **限太松**：看着有配置、实际没生效。用户以为限了 5 MB/s，
 *      上行照样打满，只有等同事抱怨网络卡才发现。
 *   ② **限太死**：请求大于桶容量时永远等不到额度，直接**死锁**。
 *      用户把速率设得很低（比如 100 KB/s）就会踩到 —— 表现是"卡住不动"。
 *
 * 两种都不会报错，所以必须靠用例钉住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RateLimiter, parseRate } from '../src/rate.js'

/** 造一个可控时钟：now 手动推进，sleep 只推进时钟不真等 */
function fakeClock() {
  let t = 0
  return {
    now: () => t,
    sleep: (ms) => { t += ms; return Promise.resolve() },
    advance: (ms) => { t += ms },
    get t() { return t },
  }
}

/**
 * 用掉桶里那次性额度（1 秒的量），好让后续测量落在**稳态**上。
 *
 * ⚠️ 不知道这件事就会误判：桶初始是满的，速率越高能"白送"的越多 ——
 *    5 MiB/s 的桶有 5 MiB，够 5 个 1 MiB 的块一次放完。
 *    于是"等了 0ms"看着像限速失效，其实只是还在花初始额度。
 *    （`_lab/check-rate.mjs` 的第一版就是这么误报的。）
 */
async function drainBurst(lim) {
  await lim.take(lim.capacity)
}

test('解析：常见写法都要认', () => {
  assert.equal(parseRate('500K'), 512000)
  assert.equal(parseRate('5M'), 5242880)
  assert.equal(parseRate('2G'), 2147483648)
  assert.equal(parseRate('5m'), 5242880, '大小写不敏感')
  assert.equal(parseRate('1.5M'), 1572864, '小数要支持')
  assert.equal(parseRate('1048576'), 1048576, '纯数字按字节/秒')
  assert.equal(parseRate('5 MB'), 5242880, '带空格和 B 也认')
})

test('⭐ 解析：看不懂的写法必须报错，不能悄悄当成"不限速"', () => {
  // 这条是刻意的设计选择：静默降级成"不限速"是最坏的结果 ——
  // 用户以为限了、其实占满上行，而这一点只有别人抱怨时才发现。
  for (const bad of ['', '  ', 'abc', '0', '-5', '5X', 'M5', null, undefined, {}]) {
    assert.ok(Number.isNaN(parseRate(bad)),
      `「${bad}」应当解析失败（NaN），而不是被当成不限速`)
  }
})

test('限速真的生效：用掉额度后要等够时间', async () => {
  const clk = fakeClock()
  const lim = new RateLimiter(1000, { now: clk.now, sleep: clk.sleep })  // 1000 B/s

  await lim.take(1000)                 // 桶初始是满的：1 秒的量 = 1000 字节
  assert.equal(clk.t, 0, '首次取用不该等待（桶是满的）')

  await lim.take(1000)                 // 桶空了，要等 1 秒
  assert.ok(clk.t >= 1000,
    `取第二份 1000 字节应等约 1000ms，实际只等了 ${clk.t}ms —— 限速没生效`)
  assert.ok(lim.waitedMs >= 1000, '应记录等待时长（用于告知用户）')
})

test('限速是按字节的，不是按次数 —— 块大小变了也准', async () => {
  const clk = fakeClock()
  const lim = new RateLimiter(1000, { now: clk.now, sleep: clk.sleep })
  await drainBurst(lim)                // 先花掉初始额度，才量得到稳态
  // 一次要 500 字节、要 4 次 = 2000 字节；速率 1000 B/s → 约 2 秒
  for (let i = 0; i < 4; i++) await lim.take(500)
  assert.ok(clk.t >= 1900,
    `稳态下 2000 字节、速率 1000 B/s，应约 2000ms，实际 ${clk.t}ms`)
})

test('⭐ 单次请求大于桶容量时**不能死锁**，且速率仍然正确', async () => {
  // 用户把速率设得极低时的真实场景：1 MiB 的块 + 100 KB/s 的限速。
  // 若实现写成"等到 tokens >= n"且桶不长大，这里会永远等不到 —— 表现为"卡住不动"。
  //
  // ⚠️ 这条用**真实墙钟**（sleep 给真的 setTimeout），因为要验证的正是
  //    "会不会永远卡住" —— 用假时钟是验证不了死锁的。
  const lim = new RateLimiter(100_000)          // 100 KB/s，真等待
  const big = 1024 * 1024                       // 1 MiB > 初始桶容量

  await drainBurst(lim)                         // 先花掉初始额度

  const t0 = Date.now()
  let finished = false
  await Promise.race([
    lim.take(big).then(() => { finished = true }),
    new Promise((r) => setTimeout(r, 15000)),
  ])
  const ms = Date.now() - t0
  assert.equal(finished, true,
    `大于桶容量的请求必须能通过（只是慢），绝不能永远等（已过 ${ms}ms）`)
  // 桶长大到 1 MiB 之后，1 MiB ÷ 100 KB/s = 10.24 秒
  assert.ok(ms >= 9500 && ms <= 13000,
    `应等约 10240ms（并且**不能**是"夹到桶容量就放行"那种超发），实际 ${ms}ms`)
})

test('⭐ 正常大小的请求必须真的等（不能被"大于容量"的保护顺手放过）', async () => {
  // ⚠️ 这条用例是为了一个**真实踩过的 bug**：
  //    "要补多少"曾写成 `Math.min(n, capacity) - tokens`，桶满时它恒为 0
  //    （capacity - capacity）→ waitMs = 0 → **限速完全失效**。
  //    当时只有"大于容量不死锁"的用例，它照样通过 —— 因为那条路径
  //    恰好也需要 min()。两条一起才有覆盖。
  const lim = new RateLimiter(131072)           // 128 KiB/s，真等待
  const chunk = 393216                          // 384 KiB

  await drainBurst(lim)                         // 先花掉初始额度

  const t0 = Date.now()
  await lim.take(chunk)
  const ms = Date.now() - t0
  // 稳态下 384 KiB ÷ 128 KiB/s = 3 秒
  assert.ok(ms >= 2700,
    `稳态下 384 KiB 在 128 KiB/s 应等约 3000ms，实际只等了 ${ms}ms —— ` +
    '限速形同虚设，或"夹到桶容量"导致超发')
  assert.ok(lim.waitedMs >= 2700, 'waitedMs 应记录到真实等待时长')
})

test('连续取用：速率对得上（总量 ÷ 速率 = 总时长）', async () => {
  const clk = fakeClock()
  const lim = new RateLimiter(100_000, { now: clk.now, sleep: clk.sleep })
  await drainBurst(lim)
  // 10 次 × 100 KB = 1 MB，速率 100 KB/s → 约 10 秒
  for (let i = 0; i < 10; i++) await lim.take(100_000)
  assert.ok(clk.t >= 9500 && clk.t <= 10500,
    `稳态下 1 MB 在 100 KB/s 应约 10 秒，实际 ${clk.t}ms`)
})

test('不限速时不引入任何等待', async () => {
  const clk = fakeClock()
  for (const spec of [0, -1, NaN, Infinity, undefined]) {
    const lim = new RateLimiter(spec, { now: clk.now, sleep: clk.sleep })
    assert.equal(lim.active, false, `${spec} 应视为不限速`)
    await lim.take(100 * 1024 * 1024)
    assert.equal(clk.t, 0, '不限速时不该有任何等待')
  }
})

test('中止判据：等待期间用户点取消要立刻返回', async () => {
  const clk = fakeClock()
  const lim = new RateLimiter(100, { now: clk.now, sleep: clk.sleep })
  await lim.take(100)                        // 清空桶
  let aborted = false
  // 等待 100 字节 = 1 秒，但中途判据为真
  await lim.take(100, () => { aborted = true; return true })
  assert.equal(aborted, true, '应查到中止判据')
  assert.ok(clk.t < 1000,
    `中止后不该继续等完（实际等了 ${clk.t}ms）—— 长等待正是用户最容易点取消的时刻`)
})

test('突发额度：暂停后攒下的额度可以用掉，但不超过桶容量', async () => {
  const clk = fakeClock()
  const lim = new RateLimiter(1000, { now: clk.now, sleep: clk.sleep })
  await lim.take(1000)                       // 桶空
  clk.advance(10_000)                        // 停 10 秒 —— 攒下的额度封顶在 1 秒量
  await lim.take(1000)
  assert.equal(clk.t, 10_000,
    '停 10 秒后桶应已补满（可免等取 1000 字节），实际又等了 ' + (clk.t - 10_000) + 'ms')
})

test('限速器不持有定时器（没有需要清理的状态）', async () => {
  // 按需补令牌的实现不该创建任何 timer；否则传输结束时得记得清掉，
  // 忘了就会让进程迟迟不退出。
  const clk = fakeClock()
  const before = process.getActiveResourcesInfo?.().filter((x) => x === 'Timeout').length ?? 0
  const lim = new RateLimiter(1000, { now: clk.now, sleep: clk.sleep })
  await lim.take(2000)
  const after = process.getActiveResourcesInfo?.().filter((x) => x === 'Timeout').length ?? 0
  assert.ok(after <= before, `限速器不该留下 Timeout 资源（${before} → ${after}）`)
})
