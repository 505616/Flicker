/**
 * 发送限速（令牌桶）。
 *
 * 为什么需要：用户的原话是"别占满公司/家里网络的带宽"。
 * 传几十 GB 时把上行打满是真实困扰 —— 视频会议卡住、网页打不开。
 *
 * ── 设计取舍 ──────────────────────────────────────────────
 *
 * **为什么是令牌桶，而不是"每块 sleep 固定时间"**：
 * 固定 sleep 会把速度锁死在 `块大小 ÷ sleep`，一旦块大小变了就失准；
 * 而且它不允许突发 —— 中间停顿时攒下的额度白白浪费。
 * 令牌桶按**字节**计账，块大小怎么变都对，且允许用掉攒下的额度（突发）。
 *
 * **桶容量为什么是 1 秒的量**：够大，能吸收磁盘读取的抖动和网络重传，
 * 不会因为一次慢读就把后续节奏拖垮；又够小，不会让"攒了很久"的一次
 * 突发把链路打满好几秒。
 *
 * **为什么不用 setInterval 补令牌**：定时器会一直占着事件循环，
 * 而且传输结束还得记得清掉。改成**按需计算**：每次要字节时按
 * "上次到现在过了多久"补上，没有定时器、没有需要清理的状态。
 */
export class RateLimiter {
  /**
   * @param {number} bytesPerSec 目标速率（字节/秒）。<= 0 或非有限值 = 不限速
   * @param {object} [opts]
   * @param {() => number} [opts.now] 注入时钟（毫秒），便于测试
   * @param {(ms:number) => Promise<void>} [opts.sleep] 注入等待，便于测试
   */
  constructor(bytesPerSec, { now, sleep } = {}) {
    const n = Number(bytesPerSec)
    this.enabled = Number.isFinite(n) && n > 0
    this.rate = this.enabled ? n : Infinity
    // 桶容量 = 1 秒的量（见上面的取舍说明）
    this.capacity = this.enabled ? n : Infinity
    this.tokens = this.capacity
    this._now = now ?? (() => Date.now())
    this._sleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this._last = this._now()
    /** 累计因为限速而等待的毫秒数（用于告诉用户"限速生效中"） */
    this.waitedMs = 0
  }

  /** 按经过的时间补充令牌 */
  _refill() {
    if (!this.enabled) return
    const t = this._now()
    const dt = Math.max(0, t - this._last)
    this._last = t
    this.tokens = Math.min(this.capacity, this.tokens + (dt / 1000) * this.rate)
  }

  /**
   * 取 n 个字节的额度，不够就等到够。
   *
   * ⚠️ 这里有两个都踩过的坑，方向正好相反：
   *
   * **坑一（限速失效）**：把"要补多少"写成 `Math.min(n, capacity) - tokens`。
   *   桶满时它恒为 0（capacity − capacity）→ `waitMs = 0` → 永远不等。
   *
   * **坑二（超发）**：发现坑一之后，改成"请求比桶大就夹到桶容量再放行"。
   *   看着解决了，其实**少扣了令牌** —— 要 384 KB、只扣 128 KB，
   *   于是第二次请求只等 1 秒就把 384 KB 放过去了（应等 3 秒）。
   *   实测：速率 128 KiB/s，连续两次 384 KiB，第二次只等 1038ms。
   *
   * **正确做法**：桶必须**装得下被请求的量**。桶比请求小的时候，
   *   任何"夹一下再放行"都是在超发；把桶长大到能容纳它才是对的。
   *   代价只是突发上限变大（桶容量），对"别占满带宽"这个目的无影响 ——
   *   长期平均速率仍然精确等于 rate。
   *
   * @param {number} n 字节数
   * @param {() => boolean} [isAborted] 中止判据 —— 等待期间用户可能点了取消，
   *   那时必须立刻返回，不能傻等（长等待正是取消最容易发生的时刻）
   */
  async take(n, isAborted) {
    if (!this.enabled || !(n > 0)) return

    // 桶装不下这个请求就把它长大（见"坑二"）。长大时按比例补上已有额度，
    // 这样不会凭空多送也不会有未记账的令牌残留。
    if (n > this.capacity) {
      this._refill()
      this.tokens = this.tokens / this.capacity * n
      this.capacity = n
    }

    this._refill()
    if (this.tokens >= n) { this.tokens -= n; return }

    const need = n - this.tokens
    const waitMs = Math.ceil((need / this.rate) * 1000)

    if (waitMs > 0) {
      // 分数段等待：长时间傻等会让"取消"反应很迟钝
      const SLICE = 200
      let left = waitMs
      while (left > 0) {
        if (isAborted?.()) return
        const chunk = Math.min(SLICE, left)
        await this._sleep(chunk)
        this.waitedMs += chunk
        left -= chunk
      }
      this._refill()
    }

    this.tokens = Math.max(0, this.tokens - n)
  }

  /** 供 UI 显示：是否真的在限速 */
  get active() { return this.enabled }
}

/**
 * 把 `--rate 5M` 这类写法解析成字节/秒。
 *
 * 支持：`500K` / `5M` / `2G`（大小写均可），纯数字按**字节/秒**算。
 * 不认的写法返回 NaN，让调用方去报错 —— 悄悄当成"不限速"是最糟的选择，
 * 用户以为限了、其实占满带宽，而这种误解只有别人抱怨时才被发现。
 *
 * @param {string|number} spec
 * @returns {number} 字节/秒；无法解析时为 NaN
 */
export function parseRate(spec) {
  if (typeof spec === 'number') return Number.isFinite(spec) && spec > 0 ? spec : NaN
  if (typeof spec !== 'string') return NaN
  const s = spec.trim()
  if (!s) return NaN
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([kKmMgG]?)(?:[bB])?(?:\/s)?$/)
  if (!m) return NaN
  const v = Number(m[1])
  if (!Number.isFinite(v) || v <= 0) return NaN
  const mul = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase()]
  return Math.round(v * mul)
}
