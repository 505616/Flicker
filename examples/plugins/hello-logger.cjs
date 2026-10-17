/**
 * 示例插件①：把这次传输记录下来
 * ==============================
 * 演示三件事，正好是插件 API 的全部要点：
 *   · `apiVersion` —— 接口版本对不上时程序会**拒绝加载**（而不是尽力而为）
 *   · `ctx.on(...)` —— 订阅事件；**拼错事件名会当场报错**
 *   · `ctx.effect(...)` —— 任何副作用都要登记清理函数，
 *     它会在销毁链里被调用（"用完即销毁"对插件同样成立）
 *
 * 用法：
 *   flicker send "要发的文件" --plugin=examples/plugins/hello-logger.cjs
 *
 * 说明：这是**示例**，故意写得又短又直白，不做错误重试之类的花活。
 * 它会把经过写到 `flicker-plugin.log`（只记文件名与大小，不记内容）。
 */
const { appendFileSync } = require('node:fs')          // 只允许内置模块（插件要自包含）
const path = require('node:path')

module.exports = {
  name: 'hello-logger',
  version: '1.0.0',
  apiVersion: 1,

  apply(ctx) {
    const logFile = path.join(process.cwd(), 'flicker-plugin.log')
    const write = (line) => appendFileSync(logFile, line + '\n', 'utf8')

    ctx.log(`本次传输会记录到 ${logFile}`)

    // ① 参数解析完、还没开始扫描
    ctx.on('run/start', (e) => {
      write(`开始：模式=${e.mode} 块大小=${e.chunkBytes} 输入=${e.inputs.length} 项`)
    })

    // ② 清单算好之后 —— 这里能看到"要发哪些文件、各多大"
    ctx.on('manifest/scanned', (e) => {
      write(`清单：${e.summary.fileCount} 个文件，共 ${e.summary.totalBytes} 字节`)
      for (const f of e.summary.files) write(`  - ${f.rel} (${f.size} 字节, ${f.chunks} 块)`)
    })

    // ③ 每次界面输出（同步事件：处理函数要同步完成）
    ctx.on('ui/message', (e) => write(`界面[${e.level}] ${e.text}`))

    // ④ 传输结束 —— 收尾动作放在这里
    ctx.on('transfer/complete', (e) => {
      write(`结束：ok=${e.ok} 原因=${e.reason ?? '-'} 发出=${e.bytes} 字节`)
    })

    // ⑤ 副作用：登记一个清理函数。
    //    这里没什么真的需要清理的，但**演示了正确做法** ——
    //    如果这里开了定时器、监听端口、临时文件，就该在返回的函数里收掉。
    ctx.effect(() => {
      write('（插件已就绪）')
      return () => write('（插件资源已释放）')
    })
  },
}
