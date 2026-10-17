/**
 * 示例插件③：自建中继的**访问控制 + 审计**
 * ==========================================
 * 演示中继平面的三个钩子：
 *   · `relay/route` —— 拦在**任何路由之前**（连 /health 都经过它），
 *     返回 `{ status, body }` 就直接结束这个请求，返回 undefined 就放行；
 *   · `relay/room-created` / `relay/room-destroyed` —— 房间的真实生命周期；
 *   · `relay/health` —— 往 /health 里加自己的字段（核心字段覆盖不了）。
 *
 * 用法（自建中继）：
 *   set RELAY_TOKEN=open-sesame
 *   node relay/local.mjs --port=8787 --plugin=examples/plugins/relay-gate.cjs
 *
 * 然后在发送端带上同一个口令：
 *   flicker send "文件" --relay=http://<你的IP>:8787
 *   （发收两端用的是程序自己发的请求，所以真实使用时通常**不设** token ——
 *     这个示例主要是给"想给自建中继加一道门"的人照抄的骨架；
 *     真要启用，得让发送端也带上这个头，见文件末尾的说明。）
 *
 * ⚠️ 这个示例默认**不启用**拦截（没设 RELAY_TOKEN 就放行），否则你照抄之后
 *    会发现"程序连不上了"却不知道是自己刚加的那道门拦的。
 */
const { appendFileSync } = require('node:fs')
const path = require('node:path')

module.exports = {
  name: 'relay-gate',
  version: '1.0.0',
  apiVersion: 1,

  apply(ctx) {
    const token = process.env.RELAY_TOKEN
    const logFile = path.join(process.cwd(), 'relay-plugin.log')
    const log = (line) => appendFileSync(logFile, line + '\n', 'utf8')

    if (!token) {
      ctx.log('没有设置 RELAY_TOKEN —— 本插件只做审计，不拦任何请求')
    } else {
      ctx.log('已启用访问控制：请求必须带 x-relay-token 头')
    }

    // ① 拦在路由之前。核心的 /health 与房间接口都在它后面。
    ctx.on('relay/route', (e) => {
      if (!token) return undefined                 // 没配口令 → 放行（只审计）
      if (e.headers['x-relay-token'] === token) return undefined
      log(`拒绝 ${e.method} ${e.path}`)
      return { status: 403, body: { error: 'FORBIDDEN', message: '缺少或错误的口令' } }
    })

    // ② 房间的真实生命周期（重复创建/重复销毁不会重复报）
    ctx.on('relay/room-created', (e) => log(`房间建立 ${e.room}`))
    ctx.on('relay/room-destroyed', (e) => log(`房间销毁 ${e.room}`))

    // ③ 让 /health 多报一个字段，方便自己核对部署
    ctx.contribute('relay/health', () => ({
      operator: process.env.RELAY_OPERATOR || 'self-hosted',
    }))

    ctx.log(`审计日志写到 ${logFile}`)
  },
}

/**
 * 想真的启用访问控制，请注意一件事：**发送端与接收端都要带上这个头**。
 * 目前程序自己发的请求不带自定义头，所以在自建中继上直接开拦会两端都连不上。
 * 可行的做法有三种（都不需要改这个插件）：
 *   ① 用反向代理（nginx / Caddy）在更外层做鉴权，把令牌换成 URL 里的路径或查询串；
 *   ② 只在 `relay/route` 里拦"创建房间"（`e.method === 'POST' && !e.query.seq`），
 *      放行其余的读写请求 —— 加密与密码校验本来就不依赖中继的保密性；
 *   ③ 等上游支持"插件参与能力声明"（见 docs/插件.md 的"还没做的部分"）。
 */
