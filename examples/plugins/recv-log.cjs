/**
 * 示例插件：把"这次收到了什么"记进一个文件（接收端进程平面）
 * ========================================================
 *
 * 用途：`flicker recv --plugin=examples/plugins/recv-log.cjs`
 * （或在图形界面里带 `--plugin` 启动后点「接收文件」）。
 *
 * 它演示的是这个平面的形状：
 *   · **只有事件、没有贡献点** —— 落盘路径、逐块校验、销毁顺序都不许插件插手；
 *   · 四个平面各有各的钩子，用错平面**当场报错**（这里用的全是 `receive/*`）；
 *   · 插件抛错**不打断接收**（对方正在推文件），但错误会被如实记下来、结束时打印；
 *   · 事件里**没有密码、也没有一次性链接令牌** —— 那两样不该出现在任何插件手里。
 *
 * 日志默认写到 `./flicker-recv.log`，可用 `FLICKER_RECV_LOG` 改。
 * ⚠️ 这是示例：它只追加文本，不轮转、不加锁 —— 真要在生产里记账，请自己换成熟的做法。
 */
const { appendFileSync } = require('node:fs')
const path = require('node:path')

module.exports = {
  name: 'recv-log',
  version: '1.0.0',
  apiVersion: 1,
  apply(ctx) {
    const file = process.env.FLICKER_RECV_LOG || path.join(process.cwd(), 'flicker-recv.log')
    const write = (line) => appendFileSync(file, `${new Date().toISOString()} ${line}\n`)
    ctx.log(`记录到：${file}`)

    ctx.on('receive/ready', (e) => {
      write(`ready  port=${e.port} tls=${e.tls} dir=${e.dir} ` +
        `limits=${e.limits.maxFiles} 文件 / ${e.limits.maxBytes} 字节`)
    })
    ctx.on('receive/peer', (e) => write(`peer   ${e.peer?.address ?? '?'}`))
    ctx.on('receive/auth', (e) => write(`auth   macProfile=${e.macProfile ?? '?'}`))
    ctx.on('receive/manifest', (e) => {
      write(`manifest ${e.files} 个文件 / ${e.totalBytes} 字节 / ${e.totalChunks} 块 ` +
        `（跳过 ${e.skipped}，磁盘可用 ${e.diskFree ?? '未知'}）`)
    })
    // 撞名：想知道"撞了哪个"，但改名/覆盖/跳过的决定权仍然在用户手里
    ctx.on('receive/collision', (e) => write(`collision ${e.rel} 已存在于 ${e.existing}`))
    ctx.on('receive/file-done', (e) => {
      const renamed = e.renamedFrom ? `（原名 ${e.renamedFrom}，已改名）` : ''
      write(`file-done ${e.rel} ${e.bytes} 字节${renamed}`)
    })
    ctx.on('receive/file-failed', (e) => write(`file-failed ${e.rel}：${e.reason}`))
    ctx.on('receive/complete', (e) => {
      write(`complete 成功 ${e.done.length} 个 / 失败 ${e.failed.length} 个 / ` +
        `跳过 ${e.skipped.length} 个`)
    })
    ctx.on('receive/closed', (e) => write(`closed ${e.reason}`))
  },
}
