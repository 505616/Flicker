/**
 * 摘要 Worker 与进度节流的测试
 * ============================
 *
 * ── 为什么要单独立一套 ──
 * 接收端在这台机器上的天花板原本是 ~130 MB/s，其中最大的一笔 CPU 是
 * **主线程上的整文件增量 SHA-256**（纯 JS，实测 252 MiB/s）。把它挪进 Web Worker 之后
 * 实测 128.6 → 208.9 MB/s。但这条优化动的是**完整性校验的根基**：
 *
 *   · 如果 Worker 里跑的不是页面里那个类（比如手抄了一份），两份实现算出的摘要
 *     可能不同 —— 症状是"文件明明完好却报校验失败"，而且只在部分输入上出现；
 *   · 如果缓冲被"零拷贝转移"给了 Worker、而写盘那条路还要用同一份字节，
 *     落盘/Blob 就会缺数据 —— 症状是"文件坏了但校验却过了"（更糟）。
 *
 * 所以这里把两件事都钉成**机器判据**：
 *   ① 把 Worker 的源码（由页面自己的 K256 + Sha256 拼出来）在 Node 里真的跑一遍，
 *      与 `node:crypto` 逐位比对；
 *   ② 检查"转移缓冲"的判据：只有流式写盘那条路才允许零拷贝。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sliceFn, extractSha256 } from './receiver-relay-tests.js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const html = await readFile(path.join(root, 'web', 'receiver.html'), 'utf8')

/** 在 Node 里执行页面的 buildHashWorkerSource()，拿到 Worker 脚本源码 */
function buildWorkerSource() {
  const { K256, Sha256 } = extractSha256(html)
  // eslint-disable-next-line no-new-func
  const build = new Function('K256', 'Sha256', sliceFn(html, 'buildHashWorkerSource')
    + '\nreturn buildHashWorkerSource')(K256, Sha256)
  return build()
}

test('⭐ Worker 脚本由页面自己的实现拼成（不是手抄的第二份）', () => {
  const src = buildWorkerSource()
  assert.match(src, /class Sha256 \{/, '应当直接取 Sha256.toString()，而不是另写一份')
  assert.match(src, /const K256 = new Uint32Array\(\[/, 'K256 应当从运行时那个数组还原')
  assert.match(src, /self\.onmessage/, 'Worker 要有消息循环')
  // 页面里只能有**一处** SHA-256 实现（除了 Worker 源码字符串这个引用）
  const impls = html.match(/class Sha256 \{/g) ?? []
  assert.equal(impls.length, 1,
    `页面里只应有一份 Sha256 实现（实际 ${impls.length} 处）—— 两份实现必然漂移`)
})

test('⭐ 把 Worker 脚本真的跑起来：与 node:crypto 逐位一致', () => {
  const src = buildWorkerSource()
  // 造一个最小的 Worker 环境：self / postMessage，然后把脚本喂进去
  const posted = []
  const self = { onmessage: null, postMessage: (m) => posted.push(m) }
  // eslint-disable-next-line no-new-func
  new Function('self', src)(self)
  assert.equal(typeof self.onmessage, 'function', '脚本应当装上 onmessage')

  const cases = [
    Buffer.alloc(0), Buffer.from('a'), Buffer.from('hello 世界'),
    Buffer.alloc(1 << 20, 7),                       // 1 MiB（一个分块）
    Buffer.alloc((2 << 20) + 12345, 9),             // 2 MiB 出头（跨多次喂入）
  ]
  for (const data of cases) {
    posted.length = 0
    // 按 1/2/3 块的大小喂进去（模拟分块到达），最后要摘要
    const chunkSize = Math.max(1, Math.floor(data.length / 3) || 1)
    for (let off = 0; off < data.length; off += chunkSize) {
      const slice = data.subarray(off, off + chunkSize)
      const buf = slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength)
      self.onmessage({ data: { buf } })
    }
    self.onmessage({ data: { finish: true, id: 1 } })
    const want = createHash('sha256').update(data).digest('hex')
    assert.equal(posted.length, 1, '一次 finish 应当只回一条消息')
    assert.equal(posted[0].hex, want, `长度 ${data.length} 的摘要必须一致`)
    assert.equal(posted[0].id, 1, '要带回请求的 id（否则并发时会串摘要）')
    // 摘完之后必须重置内部状态，否则第二个文件会接着上一个算
    // ⚠️ 这里必须给**刚好长度**的缓冲：Node 的 Buffer.from('x') 是 8 KiB 池上的一个视图，
    //    直接取它的 .buffer 会把整个池子交给 Worker（摘要就成了 8192 字节的）。
    //    页面那边传的永远是精确长度的缓冲，所以这条只影响测试写法。
    const exact = new TextEncoder().encode('x')
    self.onmessage({ data: { buf: exact.buffer } })
    self.onmessage({ data: { finish: true, id: 2 } })
    assert.equal(posted[1].hex, createHash('sha256').update('x').digest('hex'),
      '取完摘要要重置状态（否则第二个文件会算错）')
  }
})

test('⭐ 零拷贝转移只允许发生在流式写盘那条路上', () => {
  // Blob 回退路径会把每一块的**视图**留到最后拼 Blob；如果这时把它的底层缓冲
  // 转移给 Worker，Buffer 会被"挪走"，落盘的 Blob 就是空的 —— 而整文件摘要
  // 反而是对的（因为 Worker 收到了字节），于是"校验通过、文件是坏的"。
  // 所以判据必须写在代码里：transferable 由 sink 的 streaming 标志决定。
  assert.match(html, /fileHasher\.update\(pt, \{ transferable: streamingSink \}\)/,
    '转移与否必须由 streamingSink 决定')
  const openSink = sliceFn(html, 'openSink')
  const streamReturns = (openSink.match(/streaming: true/g) ?? []).length
  assert.equal(streamReturns, 2,
    '两条流式路径（目录句柄 / 保存对话框）都要标 streaming: true')
  assert.match(openSink, /streaming: false,/, 'Blob 回退路径必须标 streaming: false')
  // 而且 Blob 路径确实"保留了数据"
  assert.match(openSink, /parts\.push\(u8\)/, 'Blob 路径会把视图留着 —— 正是不能转移的原因')
})

test('⭐ 进度刷新有节流，且收尾会强制刷一次（否则会停在 99%）', () => {
  const src = sliceFn(html, 'paintProgress')
  const painted = []
  const $ = (id) => ({
    get style() { return { set width(v) { painted.push([id + '.width', v]) } } },
    set textContent(v) { painted.push([id, v]) },
  })
  let now = 1000
  const performance = { now: () => now }
  const bytes = (n) => n + 'B'
  // eslint-disable-next-line no-new-func
  const paint = new Function('$', 'performance', 'bytes',
    'let lastPaintAt = 0;\n' + src + '\nreturn paintProgress')($, performance, bytes)

  const file = { size: 1000 }
  paint(file, 100, 100, 1000)
  const afterFirst = painted.length
  assert.ok(afterFirst > 0, '第一次应当真的画')
  paint(file, 200, 200, 1000)               // 同一毫秒内
  assert.equal(painted.length, afterFirst, '100ms 以内的刷新应当被跳过（省下的是主线程）')
  now += 150
  paint(file, 500, 500, 1000)
  assert.ok(painted.length > afterFirst, '过了节流窗口就该画')
  const before = painted.length
  paint(file, 1000, 1000, 1000, true)       // 收尾强制刷
  assert.ok(painted.length > before, 'force=true 必须无视节流（保证显示到 100%）')
  assert.ok(painted.some(([k, v]) => k === 'go-pct' && v === '100%'),
    '收尾这一次应当把总进度画到 100%')
})
