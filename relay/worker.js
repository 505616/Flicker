/**
 * 闪传 Flicker —— 跨网络中继（Cloudflare Worker）
 * ==============================================
 *
 * 部署这一个文件，你的两台电脑就能在**不同网络**之间传输文件。
 * 部署方式见 `中继部署.md`，或者直接跑 `node relay/deploy.mjs`。
 *
 * ── 它是做什么的 ────────────────────────────────────────────
 *
 * 你家的宽带几乎肯定是运营商大内网（CGNAT），发送端**没有可被外部访问的地址**。
 * 所以跨网络传输必须有第三个人帮忙传话 —— 但不是"看内容"，只是"搬箱子"：
 *
 *   发送端 ──密文──▶ 中继（按序号存放）──密文──▶ 接收端
 *
 * ── 中继能看到什么、不能看到什么 ────────────────────────────
 *
 *   能看到：一个随机房间号、消息的序号与长度、消息到达的时间、双方 IP
 *   看不到：文件内容（AES-256-GCM 端到端加密，密钥只存在于两端内存）
 *           文件名与文件大小（清单本身也是加密的）
 *           密码（**从不传输**，两端各自在本地算）
 *
 * 换句话说：**中继拿到的是一个它解不开的加密流。**
 * 把中继换成一台被完全攻破的机器，也只能做到"拒绝服务"或"记录元数据"，
 * 改不了内容（每个分块都有认证标签）、读不到文件。
 *
 * ── 关于"用完即销毁" ────────────────────────────────────────
 *
 * 消息只存在**内存**里，从不写磁盘（Workers 本来也没有持久磁盘）。
 * 接收端每取走一条就确认一次，中继随即删除。
 * 房间里 15 分钟没有任何活动就整体消失 —— 靠 `RoomStore.sweep()` 在每个请求开头顺手清理，
 * 所以即使两端都异常掉线、房间也不会一直留着（**代价**：清理是"下次有人来时"才发生，
 * 不是精确到点；isolate 被回收时整个 Store 一起消失，因此不需要持久化的定时器）。
 */
import { RoomStore, RelayError } from '../src/relay/room.js'
import { handleRelay } from '../src/relay/protocol.js'
import { RECEIVER_HTML } from './page.generated.js'

// ⚠️ 这里的 Store 存在**模块作用域**，也就是活在 Worker 的 isolate 里。
//    Cloudflare 会在没有请求时回收 isolate —— 那一刻所有房间一起消失，
//    这正好符合"一次性"的语义：没有人用的时候什么都不留。
//
//    代价要说清楚：**同一个房间的请求必须落在同一个 isolate 上，否则会看到不同的房间集合。**
//    对于本方案这是可接受的，因为：
//      · 一次传输是两个人、几分钟内的连续请求，被路由到不同 isolate 的概率很低
//      · 万一发生，表现是"对方连不上"，重新发起即可，不会传错内容
//      · 想要强一致就得用 Durable Objects（每个房间一个），那会让免费额度更紧张
//    这个取舍是刻意的，不要当成疏漏。
const store = new RoomStore()

export default {
  /**
   * @param {Request} request
   * @param {object} env 绑定与环境变量
   * @param {object} ctx
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    // 接收端页面由 page.generated.js 提供（构建产物，源自 web/receiver.html）。
    // 页面是单文件、零外部请求的，所以中继只需要回这一段 HTML。
    const pageHtml = async () => RECEIVER_HTML
    // 网页发送端（手机传手机时两边都只有浏览器，只能由中继提供这一页）
    const senderHtml = async () => SENDER_HTML

    return handleRelay(request, url.pathname, store, { pageHtml, senderHtml })
  },
}
