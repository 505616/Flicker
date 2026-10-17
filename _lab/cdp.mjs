/**
 * 极简 CDP 客户端（零依赖，只用 Node 内置的 WebSocket 与 fetch）
 * ============================================================
 *
 * 从 `_lab/e2e-relay-browser.mjs` 里抽出来的 —— 现在有两个演练脚本要用它
 * （中继那条、局域网那条），各写一份必然会漂移。
 *
 * 只实现需要的那几件事：连上 DevTools 端点、发命令、在页面里求值、收集事件。
 * 不引 puppeteer 之类的库：本项目的"零依赖"承诺不该被验证脚本破坏。
 */

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [] }

  /** 等 DevTools 端点起来并连上（matchUrl 用于在同一浏览器的多个标签里挑一个） */
  static async attach(port, matchUrl) {
    for (let i = 0; i < 100; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
        const target = list.find((t) => t.type === 'page' && (!matchUrl || t.url.includes(matchUrl)))
          ?? list.find((t) => t.type === 'page')
        if (target?.webSocketDebuggerUrl) {
          const ws = new WebSocket(target.webSocketDebuggerUrl)
          await new Promise((res, rej) => {
            ws.addEventListener('open', res, { once: true })
            ws.addEventListener('error', rej, { once: true })
          })
          return new Cdp(ws)
        }
      } catch { /* 还没起来 */ }
      await sleep(150)
    }
    throw new Error('连不上 DevTools 端点')
  }

  send(method, params = {}) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${method} 超时`)) }
      }, 30_000)
    })
  }

  /** 在页面里求值，返回 JSON 化的结果 */
  async eval(expression, awaitPromise = false) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise, allowUnsafeEvalBlockedByCSP: true,
    })
    if (r.exceptionDetails) {
      throw new Error('页面里求值出错: ' + (r.exceptionDetails.exception?.description
        ?? r.exceptionDetails.text))
    }
    return r.result?.value
  }

  wire() {
    this.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id)
        this.pending.delete(m.id)
        if (m.error) reject(new Error(m.error.message))
        else resolve(m.result)
      } else if (m.method) {
        this.events.push(m)
      }
    })
  }

  close() { try { this.ws.close() } catch { /* 已经关了 */ } }
}

/**
 * 浏览器里那份探针脚本：把 fetch、文件选择器、错误构造都记下来。
 *
 * 为什么需要：接收页内部会把异常 catch 掉、转成界面上的"出错了"，
 * 光看页面文字根本不知道是谁抛的。排查时这几十行能省掉半小时。
 */
export const TRACE_PROBE = `
  window.__trace = [];
  const T = (s) => { try { window.__trace.push(s) } catch (e) {} };
  const of = window.fetch;
  window.fetch = function (...a) {
    const u = String(a[0]);
    const body = a[1] && a[1].body ? String(a[1].body).slice(0, 300) : null;
    return of.apply(this, a).then((r) => {
      T('fetch ' + (a[1]?.method || 'GET') + ' ' + u + ' → ' + r.status + (body ? '  body=' + body : ''));
      return r;
    }, (e) => { T('fetch ' + u + ' ✗ ' + (e && e.message)); throw e });
  };
  const OrigError = window.Error;
  window.Error = function (...a) { const e = new OrigError(...a); T('new Error: ' + e.message); return e };
  window.Error.prototype = OrigError.prototype;
  window.addEventListener('unhandledrejection', (e) => T('unhandledrejection: ' + (e.reason && (e.reason.stack || e.reason.message || e.reason))));
`
