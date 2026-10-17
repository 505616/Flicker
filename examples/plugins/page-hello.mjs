/**
 * 示例插件④：接收端页面的插件（构建期内联）
 * ==========================================
 * 页面插件与另外两个平面不同：**它是在构建期被打进页面的**。
 * 原因见 docs/插件.md —— 接收端页面必须自包含（中继直接把 HTML 发出去，
 * CSP 不允许任何外部脚本），所以页面上不存在"运行时加载插件"这回事。
 *
 * 启用方式（两步，都要显式做）：
 *   1. 把本文件写进 `web/page-plugins.json` 的清单：
 *        { "plugins": ["examples/plugins/page-hello.mjs"] }
 *   2. 重跑内联与中继页面生成：
 *        node gen/inline-plugins.mjs && node gen/gen-relay-page.mjs
 *      然后重新构建产物（页面指纹会变，`--assets` 能核对）。
 *
 * 这个示例做了三件事，正好覆盖页面平面的四个钩子与一个贡献点：
 *   · `page/ready`     —— 页面就绪时在控制台报一声；
 *   · `recv/verified`  —— 密码核对通过、清单解开后，知道对方要发什么；
 *   · `recv/file-done` —— 每收完一个文件记一笔；
 *   · `recv/complete`  —— 全部收完（这里再挂一个按钮）；
 *   · `page/actions`   —— 往"接收完成"那块面板里加一个按钮（默认按钮文案见下）。
 *
 * ⚠️ 页面插件里**不许** import/require，也不许用 Node 的 API ——
 *    内联脚本会在构建期硬检查（还有 `apiVersion` 与形状，也都在构建期校验）。
 */

/** 收到的文件（页面插件自己的状态，随便放哪儿都行 —— 这里是模块级变量） */
const received = []

/** 最近一次的清单摘要（给按钮用） */
let lastSummary = ''

export default {
  name: 'page-hello',
  version: '1.0.0',
  apiVersion: 1,

  apply(ctx) {
    ctx.log('页面插件已就绪')

    ctx.on('page/ready', () => {
      ctx.log('页面已就绪（DOM 可以安全操作了）')
    })

    ctx.on('recv/verified', (e) => {
      received.length = 0
      ctx.log(`对方要发 ${e.fileCount} 个文件，共 ${e.totalBytes} 字节`)
    })

    ctx.on('recv/file-done', (e) => {
      received.push(e.name)
      ctx.log(`收到 ${e.name}（${e.size} 字节）`)
    })

    ctx.on('recv/complete', (e) => {
      ctx.log(`全部收完：${e.fileCount} 个文件，用时 ${e.seconds}s`)
      // 把文件名复制到剪贴板 —— 这里演示"插件自己做事"，
      // 页面不需要知道有这么个按钮存在。
      lastSummary = `收到 ${e.fileCount} 个文件：${received.join('、')}`
    })

    // 贡献一个按钮，挂在"接收完成"面板里
    ctx.contribute('page/actions', () => ({
      label: '复制文件清单',
      onClick: () => {
        const text = lastSummary || '（还没有收到文件）'
        // 剪贴板 API 在非安全上下文里可能不存在，所以要有兜底
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(text).then(
            () => ctx.log('已复制到剪贴板'),
            (e) => ctx.log('复制失败：' + e.message))
        } else {
          ctx.log('这个浏览器不给剪贴板权限，清单是：' + text)
        }
      },
    }))

    // 页面没有"销毁链"，但 `ctx.effect` 的写法与另外两个平面一致：
    // 返回的清理函数会在页面卸载时被调用（适合放定时器、事件监听这类东西）。
    ctx.effect(() => {
      const onUnload = () => ctx.log('页面要关了，插件资源在这里释放')
      window.addEventListener('beforeunload', onUnload)
      return () => window.removeEventListener('beforeunload', onUnload)
    })
  },
}
