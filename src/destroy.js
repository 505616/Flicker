/**
 * 销毁流程
 * ========
 * 实现 行为与运行.md 第四章的销毁清单。
 *
 * 设计原则：**销毁必须是幂等的、可重入的、且永不抛错。**
 * 因为销毁会在所有退出路径上被调用（正常完成、Ctrl+C、超时、出错、信号），
 * 如果销毁本身会抛错，就会出现"想清理却清理不掉"的最坏情况。
 * 所以这里每一步都单独 try/catch，最后只汇报结果，不中断流程。
 */
import { wipe } from './suite/flicker1.js'

/**
 * @typedef {object} DestroyReport
 * @property {string[]} done    已完成的动作（供界面展示）
 * @property {string[]} failed  失败的动作（要如实告诉用户）
 * @property {string[]} skipped 不适用的动作
 */

export class Destroyer {
  /**
   * @param {object} o
   * @param {(msg:string)=>void} [o.log]
   */
  constructor({ log } = {}) {
    this.log = log ?? (() => {})
    this.steps = []
    this._ran = false
    this._report = null
  }

  /**
   * 注册一个销毁步骤。
   * @param {string} label 人类可读的动作名（会显示在销毁清单里）
   * @param {() => any} fn 实际动作；返回 falsy 视为"不适用"
   * @param {object} [opts]
   * @param {boolean} [opts.optional] 失败是否可接受（例如证书本来就没装）
   */
  step(label, fn, opts = {}) {
    this.steps.push({ label, fn, optional: Boolean(opts.optional) })
    return this
  }

  /** 注册一个"清内存"步骤 */
  wipe(label, ...bufs) {
    return this.step(label, () => {
      wipe(...bufs)
      return true
    })
  }

  /**
   * 依次执行所有步骤。**永不抛错。**
   * @returns {Promise<DestroyReport>}
   */
  async run() {
    if (this._ran) return this._report       // 幂等：重复调用直接返回上次结果
    this._ran = true
    const done = [], failed = [], skipped = []
    for (const s of this.steps) {
      try {
        const r = await s.fn()
        if (r === false || r === undefined || r === null) skipped.push(s.label)
        else { done.push(s.label); this.log(`  ✓ ${s.label}`) }
      } catch (e) {
        const detail = (e?.message ?? String(e)).trim()
        if (s.optional) {
          skipped.push(s.label)
          this.log(`  – ${s.label}（不适用: ${detail}）`)
        } else {
          failed.push(`${s.label}（${detail}）`)
          this.log(`  ✗ ${s.label}: ${detail}`)
        }
      }
    }
    this._report = { done, failed, skipped }
    return this._report
  }

  /** 按 行为与运行.md 的格式渲染销毁清单 */
  render(report) {
    const r = report ?? this._report ?? { done: [], failed: [], skipped: [] }
    const lines = ['会话销毁清单']
    for (const d of r.done) lines.push(`✓ ${d}`)
    for (const s of r.skipped) lines.push(`– ${s}`)
    for (const f of r.failed) lines.push(`✗ ${f}`)
    if (r.failed.length) {
      lines.push('')
      lines.push('有项目未能清理，请手动处理（详见 中文文档/使用手册.md 第十一章）')
    }
    return lines.join('\n')
  }
}

/**
 * 把"等待退出信号"和销毁绑定起来。
 * Ctrl+C 第一次触发优雅销毁；如果销毁卡住，第二次立即退出。
 *
 * @param {Destroyer} destroyer
 * @param {() => void} [onExit]
 * @returns {{uninstall:()=>void, trigger:(reason:string)=>Promise<DestroyReport>}}
 */
export function bindSignals(destroyer, onExit) {
  let count = 0
  const handler = async (sig) => {
    count++
    if (count >= 2) {
      process.stderr.write('\n  再次收到中断，立即退出（销毁可能未完成）\n')
      process.exit(130)
    }
    process.stderr.write(`\n  收到 ${sig}，正在销毁…（再按一次可强制退出）\n`)
    try { await destroyer.run() } catch { /* 永不抛错 */ }
    onExit?.()
    process.exit(sig === 'SIGTERM' ? 143 : 130)
  }
  const onInt = () => handler('SIGINT')
  const onTerm = () => handler('SIGTERM')
  const onHup = () => handler('SIGHUP')
  process.on('SIGINT', onInt)
  process.on('SIGTERM', onTerm)
  if (process.platform !== 'win32') process.on('SIGHUP', onHup)

  return {
    uninstall() {
      process.off('SIGINT', onInt)
      process.off('SIGTERM', onTerm)
      if (process.platform !== 'win32') process.off('SIGHUP', onHup)
    },
    trigger: async (reason) => {
      destroyer.log(`  销毁原因: ${reason}`)
      return destroyer.run()
    },
  }
}

/** 退出码（行为与运行.md §5.2） */
export const EXIT = Object.freeze({
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  NETWORK: 3,
  AUTH: 4,
  INTEGRITY: 5,
  TIMEOUT: 6,
  INTERRUPTED: 130,
  TERMINATED: 143,
})
