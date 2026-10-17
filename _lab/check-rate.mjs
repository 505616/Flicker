/**
 * 限速器的手工核对：直接看每次请求等了多久。
 * 单元测试在 test/rate.test.js；这里是给人看的数字。
 *
 * 用法：node _lab/check-rate.mjs
 */
import { RateLimiter } from '../src/rate.js'

const K = 1024

async function run(label, rateBps, reqBytes, times) {
  const lim = new RateLimiter(rateBps)
  const want = (reqBytes / rateBps).toFixed(2)
  console.log(`\n${label}`)
  console.log(`  速率 ${(rateBps / K).toFixed(0)} KiB/s，每次请求 ${(reqBytes / K).toFixed(0)} KiB` +
    ` → 每次应约 ${want}s（首次有 1 秒初始额度）`)

  // ⚠️ 先把初始额度耗尽，否则量到的是"桶里攒的额度"而不是稳态速率。
  //    速率越高、桶越大，初始额度能白送的就越多：
  //    5 MiB/s 的桶有 5 MiB，够 5 个 1 MiB 的块一次放完 —— 不先耗尽就会
  //    看到"等了 0ms"，误以为限速没生效（这个核对脚本第一版就是这么误报的）。
  await lim.take(lim.capacity)
  const burstSecs = (lim.capacity / rateBps).toFixed(1)
  console.log(`  已先耗尽初始额度（${(lim.capacity / K).toFixed(0)} KiB，相当于 ${burstSecs}s 的突发）`)

  const waits = []
  for (let i = 1; i <= times; i++) {
    const t = Date.now()
    await lim.take(reqBytes)
    const ms = Date.now() - t
    waits.push(ms)
    console.log(`  第 ${i} 次等了 ${String(ms).padStart(6)}ms`)
  }
  const avg = waits.reduce((a, b) => a + b, 0) / waits.length
  const expectMs = reqBytes / rateBps * 1000
  const err = Math.abs(avg - expectMs) / expectMs * 100
  console.log(`  平均 ${avg.toFixed(0)}ms，期望 ${expectMs.toFixed(0)}ms，偏差 ${err.toFixed(1)}%` +
    (err < 15 ? '  ✓' : '  ✗ 偏差过大'))
}

console.log('限速器核对（真实等待，所以会花几秒）')
await run('【1】请求小于桶容量', 131072, 128 * K, 4)
await run('【2】请求大于桶容量（1 MiB 块 + 极低速率）', 100 * K, 1024 * K, 3)
await run('【3】典型家用限速', 5 * 1024 * K, 1024 * K, 4)
console.log('')
