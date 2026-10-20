/**
 * 平台无关核（`src/relay/core.js`）的判据
 * ======================================
 * 这个核存在的理由：把中继发送端最容易错的**流程控制**只写一份，
 * Node 发送端与将来的网页发送端都用它 —— 否则必然出现"两套实现对不上"。
 *
 * 所以这里要证明两件事：
 *   ① **规则本身对**（窗口不超投、不足半窗先问状态、落库反推、链接形状）；
 *   ② **两边真的在用同一份**（`client.js` / `sender.js` 都从 core 引入，
 *      而不是各自留一份复制品）。第二件事只能用"读源码 + 断言 import"来守，
 *      但它是这个重构唯一的价值所在，必须守住。
 *
 * 每条反向用例都刻意喂"写错过的那种取值"，见 _lab/交接.md 里记的坑。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  isTransientError, retryDelay, planWindow, batchOutcome, relayLink,
} from '../src/relay/core.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const src = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')

// ── 窗口规划 ────────────────────────────────────────────────

test('开局：还没投过任何东西 → 投满一个窗口', () => {
  const p = planWindow({ total: 100, posted: 0, ackedBase: 0, windowSize: 8 })
  assert.equal(p.startSeq, 0)
  assert.equal(p.inFlight, 0)
  assert.equal(p.room, 8)
  assert.equal(p.count, 8)
  assert.equal(p.send, true)
})

test('投递量是**空位**，不是整个窗口（历史上窗口设 1、在途却有 5 条）', () => {
  // 已投 5 条、只确认了 1 条 → 在途 4 条 → 空位只有 4
  const p = planWindow({ total: 100, posted: 5, ackedBase: 1, windowSize: 8 })
  assert.equal(p.inFlight, 4)
  assert.equal(p.room, 4)
  assert.equal(p.count, 4, '只能投空位那么多，不能投满 8')
})

test('接收端完全不 ack → 窗口占满时**一条都不许投**（中继内存是有限的）', () => {
  const p = planWindow({ total: 100, posted: 8, ackedBase: 0, windowSize: 8, idleRounds: 9 })
  assert.equal(p.room, 0)
  assert.equal(p.count, 0)
  assert.equal(p.send, false, '哪怕连续空转很久，也不许超投 —— 否则中继队列会涨到整个文件大小')
  assert.equal(p.forcePoll, true, '但应该触发"再读一次状态"')
})

test('空位不足半窗 → 这一轮先不投（否则每窗要花两个往返，吞吐砍半）', () => {
  // 窗口 8、在途 7 条（posted 8 - ackedBase 1）→ 空位只有 1，而剩余很多 → 不值得投
  const p = planWindow({ total: 100, posted: 8, ackedBase: 1, windowSize: 8 })
  assert.equal(p.inFlight, 7)
  assert.equal(p.room, 1)
  assert.equal(p.worthSending, false)
  assert.equal(p.send, false)
})

test('快传完了就不必凑满半窗（剩余 2 条、空位 3 条 → 照投 2 条）', () => {
  const p = planWindow({ total: 10, posted: 8, ackedBase: 6, windowSize: 8 })
  assert.equal(p.remaining, 2)
  assert.equal(p.room, 6)
  assert.equal(p.count, 2)
  assert.equal(p.send, true)
})

test('连续空转 ≥3 轮时，空位不足半窗也照投（反停滞）', () => {
  const p = planWindow({ total: 100, posted: 8, ackedBase: 1, windowSize: 8, idleRounds: 3 })
  assert.equal(p.forcePoll, true)
  assert.equal(p.send, true, '空位 1 条也要投，否则永远等不到推进')
  assert.equal(p.count, 1)
})

test('已经投完 → 不再投（send=false）', () => {
  const p = planWindow({ total: 5, posted: 5, ackedBase: 3, windowSize: 8 })
  assert.equal(p.remaining, 0)
  assert.equal(p.count, 0)
  assert.equal(p.send, false)
})

test('窗口 1（停等）也不会一次发出两条', () => {
  const p = planWindow({ total: 100, posted: 3, ackedBase: 3, windowSize: 1 })
  assert.equal(p.count, 1)
  assert.equal(p.send, true)
  const stalled = planWindow({ total: 100, posted: 3, ackedBase: 2, windowSize: 1 })
  assert.equal(stalled.room, 0)
  assert.equal(stalled.send, false)
})

// ── 落库反推（batch POST 失败后的判据）────────────────────────

test('batch 落库反推：nextSeq 涨到 wantNext → 当作成功（别重复发一遍）', () => {
  assert.equal(batchOutcome({ startSeq: 8, wantNext: 13, statusNextSeq: 13 }), 'landed')
})

test('batch 落库反推：nextSeq 没动 → 安全重发', () => {
  assert.equal(batchOutcome({ startSeq: 8, wantNext: 13, statusNextSeq: 8 }), 'resend')
})

test('batch 落库反推：nextSeq 涨到别处 → 报错别猜（说明有并发写）', () => {
  assert.equal(batchOutcome({ startSeq: 8, wantNext: 13, statusNextSeq: 10 }), 'desync')
})

test('batch 落库反推：状态读不到 → 按普通失败重试', () => {
  assert.equal(batchOutcome({ startSeq: 8, wantNext: 13, statusNextSeq: null }), 'unknown')
  assert.equal(batchOutcome({ startSeq: 8, wantNext: 13, statusNextSeq: undefined }), 'unknown')
})

// ── 重试策略 ───────────────────────────────────────────────

test('退避：300 起、翻倍、封顶 8s', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 10].map(retryDelay),
    [300, 600, 1200, 2400, 4800, 8000, 8000, 8000])
})

test('只重试瞬时故障：5xx / 429 / 网络层失败', () => {
  assert.equal(isTransientError(null, 503), true)
  assert.equal(isTransientError(null, 429), true)
  assert.equal(isTransientError(null, 404), false)
  assert.equal(isTransientError(new TypeError('fetch failed')), true)
  assert.equal(isTransientError(Object.assign(new Error('x'), { name: 'TimeoutError' })), true)
  assert.equal(isTransientError(Object.assign(new Error('x'), { cause: { code: 'ECONNRESET' } })), true)
})

test('不重试不可恢复的：房间没了 / 序号错 / 用户取消', () => {
  for (const code of ['NO_ROOM', 'EXPIRED', 'GONE', 'BAD_SEQ', 'TOO_LARGE']) {
    assert.equal(isTransientError(Object.assign(new Error('x'), { code })), false, code)
  }
  const aborted = Object.assign(new Error('x'), { code: 'ABORTED' })
  assert.equal(isTransientError(aborted), false)
  const named = Object.assign(new Error('x'), { name: 'RelayAborted' })
  assert.equal(isTransientError(named), false)
})

// ── 链接形状（也是文档那轮错误的守门人）────────────────────────

test('中继链接是 #k=<房间>&s=<盐>，不是早期的 #/<房间>.<盐>', () => {
  const link = relayLink({ base: 'https://relay.example.com', room: 'a'.repeat(64), saltHex: 'b'.repeat(32) })
  assert.equal(link, `https://relay.example.com/#k=${'a'.repeat(64)}&s=${'b'.repeat(32)}`)
  assert.match(link, /#k=[0-9a-f]{64}&s=[0-9a-f]{32}$/)
  assert.ok(!/#\//.test(link), '接收页的 readRelayParams() 只认 k= 与 s=，`#/` 那种形状打不开')
})

test('中继地址末尾多斜杠不会拼出双斜杠', () => {
  assert.equal(relayLink({ base: 'https://r.example.com/', room: 'x', saltHex: 'y' }),
    'https://r.example.com/#k=x&s=y')
  assert.equal(relayLink({ base: 'https://r.example.com///', room: 'x', saltHex: 'y' }),
    'https://r.example.com/#k=x&s=y')
})

// ── 两边真的在用同一份（这个重构唯一的价值）──────────────────────

test('client.js 与 sender.js 都从 core.js 引入，没有各自留一份实现', () => {
  const client = src('src/relay/client.js')
  const sender = src('src/relay/sender.js')
  assert.match(client, /from '\.\/core\.js'/, 'client.js 必须从 core.js 引入')
  assert.match(sender, /from '\.\/core\.js'/, 'sender.js 必须从 core.js 引入')
  assert.match(client, /batchOutcome\(/, 'putBatch 的落库反推要用 core 的 batchOutcome')
  assert.match(client, /retryDelay\(/, '退避要用 core 的 retryDelay')
  assert.match(client, /relayLink\(/, '链接要用 core 的 relayLink')
  assert.match(sender, /planWindow\(/, '窗口规划要用 core 的 planWindow')
  // 反例守卫：这几个函数在 src/ 里只许有一份定义
  for (const fn of ['function planWindow', 'function batchOutcome', 'function retryDelay', 'function relayLink']) {
    const hits = ['src/relay/core.js', 'src/relay/client.js', 'src/relay/sender.js']
      .filter((f) => src(f).includes(fn))
    assert.deepEqual(hits, ['src/relay/core.js'], `${fn} 只许在 core.js 里定义，实际出现在 ${hits.join(', ')}`)
  }
})

test('isTransientError 仍然能从旧的入口导入（外部 import 不破）', async () => {
  const mod = await import('../src/relay/client.js')
  assert.equal(typeof mod.isTransientError, 'function')
  assert.equal(mod.isTransientError(null, 503), true, 're-export 的要与 core 里同一份行为')
})
