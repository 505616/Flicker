/**
 * 插件能看到的负载
 * ================
 * 事件里传给插件的对象**都是新建的、冻结的小副本**，不是内部对象本身。理由有两条：
 *
 *   ① 内部对象是**活数据**：`wire` / `session` / `manifest` 在传输过程中还会变。
 *      插件拿着它改一下（哪怕只是无心），坏起来极难查 —— 而"难查"在
 *      这个项目里已经被证明是最贵的成本。
 *   ② 内部字段本来就不该外流：`wire.files[]._bytes`（内存里的字节）、
 *      `absPath`（发送端的本地路径）都属于发送端自己。
 *
 * 所以：**每个事件都构造一份新的、冻结的、只有插件真正用得上的字段的副本。**
 * 这也让"插件能看到什么"变成一份可以写进文档、也能被机器检查的清单。
 */

/** 冻结一层数组与对象（浅冻结就够 —— 里面的值都是原始类型） */
const freezeList = (list) => Object.freeze(list.map((x) => Object.freeze(x)))

/**
 * 清单概览：有哪些文件、多大、多少块。
 *
 * ⚠️ `rel` 是**相对路径**（接收端会按它落盘），`kind` 用来区分普通文件与赠品
 *    （`file` / `flicker-station-sea` / `flicker-station-source`）。
 *
 * @param {object} wire 线上清单
 * @returns {{fileCount:number, dirCount:number, totalBytes:number, totalChunks:number, files:ReadonlyArray}}
 */
export function manifestSummary(wire) {
  const dirs = new Set()
  for (const f of wire.files) {
    const at = f.rel.lastIndexOf('/')
    if (at > 0) dirs.add(f.rel.slice(0, at))
  }
  return Object.freeze({
    fileCount: wire.files.length,
    dirCount: dirs.size,
    totalBytes: wire.totalBytes,
    totalChunks: wire.totalChunks,
    files: freezeList(wire.files.map((f) => ({
      name: f.name, rel: f.rel, size: f.size, chunks: f.chunks, kind: f.kind,
    }))),
  })
}

/**
 * 界面输出：`{ level, text }`。
 * `level` 是界面对象上的方法名（见 `UI_LEVELS`）。
 */
export function uiMessage(level, text) {
  return Object.freeze({ level, text: String(text) })
}

/** 传输结束：给插件一份结算单（不含任何文件内容） */
export function transferSummary({ mode, ok, reason, bytes, fileCount }) {
  return Object.freeze({ mode, ok: Boolean(ok), reason: reason ?? null, bytes: Number(bytes) || 0, fileCount: Number(fileCount) || 0 })
}
