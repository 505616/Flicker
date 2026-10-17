/**
 * 示例插件②：往这次传输里**追加一个文件**
 * ======================================
 * 演示贡献点 `gift/items`：插件可以把自己生成的文件一起送过去
 * （在接收端看，它就是一个普通文件，正常落盘）。
 *
 * 用法：
 *   flicker send "要发的文件" --plugin=examples/plugins/attach-note.cjs
 *
 * 几个要点：
 *   · 名字必须是**单个文件名**（不能带路径分隔符）—— 插件只能追加单个文件；
 *   · 名字要与已发送的文件不重名，否则程序会当场报错（而不是让接收端去撞路径冲突）；
 *   · 内容留在内存里发出去 —— 不会撑大加密清单，也不会在磁盘上留临时文件。
 */
module.exports = {
  name: 'attach-note',
  version: '1.0.0',
  apiVersion: 1,

  apply(ctx) {
    // 贡献点：返回值会被真正用上（这里是一个文件）
    ctx.contribute('gift/items', () => ({
      name: '发送说明.txt',
      data: [
        '这个文件是发送方的插件（attach-note）随传输一起送过来的。',
        `时间：${new Date().toISOString()}`,
        `插件看到的传输模式与块大小会在 run/start 里给出。`,
        '',
      ].join('\n'),
    }))

    ctx.on('run/start', (e) => ctx.log(`模式 ${e.mode}，块大小 ${e.chunkBytes} 字节`))
    ctx.on('manifest/scanned', (e) => ctx.log(`清单里现在有 ${e.summary.fileCount} 个文件`))
  },
}
