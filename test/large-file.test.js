/**
 * 大文件：路径必须是流式的，不能把文件读进内存
 * ============================================
 *
 * 这一条**不能靠读代码确认**，因为"整体读进内存"和"分块读"在功能上完全等价 ——
 * 所有测试都会通过，只有内存会炸。所以这里用两种判据把它钉住：
 *
 *   ① **行为判据（动态）**：对一个 96 MiB 的文件算哈希，测**本进程 RSS 的增量**。
 *      流式实现的增量是常数（一个 1 MiB 缓冲 + GC 抖动）；整体读进内存的实现
 *      至少要涨 96 MiB。断言留了很宽的余量（< 48 MiB），所以不会因为 GC 抖动而闪。
 *
 *   ② **结构判据（静态）**：服务端与中继客户端里**不许出现 `readFile(`** ——
 *      它们只能 `open` + 按偏移 `read` 一块。这条比动态判据更早报警：
 *      哪天有人图省事写成 `readFile(absPath)`，测试会直接指出是哪个文件。
 *
 * 为什么值得单独一个测试文件：`_lab/bench-memory.mjs` 是**实测脚本**（要跑几分钟、
 * 要几 GB 磁盘），不能进 CI；而"这条性质不许退化"必须每次都验。
 * 两者分工：lab 脚本给出结论与数字，这个测试守住结论不被改掉。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, open, readFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { hashFile, hashBuffer } from '../src/manifest.js'
import { PARAMS } from '../src/suite/flicker1.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MiB = 1024 * 1024

/** 造一个确定内容的大文件（分块写，别把测试自己撑爆） */
async function makeFile(file, sizeBytes) {
  const fh = await open(file, 'w')
  const block = Buffer.allocUnsafe(4 * MiB)
  for (let i = 0; i < block.length; i++) block[i] = (i * 31 + 7) & 0xff
  let written = 0
  try {
    while (written < sizeBytes) {
      const n = Math.min(block.length, sizeBytes - written)
      await fh.write(block, 0, n)
      written += n
    }
  } finally { await fh.close() }
}

const rss = () => process.memoryUsage().rss

test('⭐ 哈希大文件时 RSS 不随文件大小增长（流式，不是整体读入）', async () => {
  const SIZE = 96 * MiB
  const dir = await mkdtemp(path.join(tmpdir(), 'flicker-large-'))
  const file = path.join(dir, 'big.bin')
  try {
    await makeFile(file, SIZE)

    // 先热身一次小文件，把"首次分配缓冲"那部分开销排除掉
    await hashFile(file, PARAMS.chunkBytes)

    const before = rss()
    const { sha256, chunkHashes } = await hashFile(file, PARAMS.chunkBytes)
    const growth = rss() - before

    assert.equal(chunkHashes.length, Math.ceil(SIZE / PARAMS.chunkBytes),
      '逐块哈希的数量应当等于块数')
    assert.match(sha256, /^[0-9a-f]{64}$/)

    // 整体读入的话，光是那一份 Buffer 就 ≥96 MiB
    assert.ok(growth < 48 * MiB,
      `哈希 ${SIZE / MiB} MiB 文件时 RSS 涨了 ${(growth / MiB).toFixed(1)} MiB —— ` +
      '这远超一个 1 MiB 缓冲该有的量，说明有地方把文件整体读进了内存。\n' +
      '    正确做法见 src/manifest.js 的 hashFile：open + 按块 read，缓冲复用。')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('⭐ 正向对照：同一个判据确实能抓到"整体读进内存"', async () => {
  // ⚠️ 这条是给上面那条测试用的"看门狗"。
  //    如果 RSS 这个判据本身不灵敏（比如系统已经吃满、或者 RSS 读的是缓存值），
  //    那么"RSS 没涨"就只能说明**测不出来**，不能说明实现是流式的。
  //    这里故意用 readFile 把同一个文件整体读进来，要求判据必须报警。
  //    一个永远不会失败的检查等于没有检查 —— 本项目已经吃过这种亏。
  const SIZE = 96 * MiB
  const dir = await mkdtemp(path.join(tmpdir(), 'flicker-large-'))
  const file = path.join(dir, 'control.bin')
  try {
    await makeFile(file, SIZE)
    // 先热身，排除首次分配的影响
    await hashFile(file, PARAMS.chunkBytes)

    const before = rss()
    const wholeBuf = await readFile(file)          // ← 这就是"错误做法"
    const growth = rss() - before
    assert.equal(wholeBuf.length, SIZE)
    assert.ok(growth > 48 * MiB,
      `整体读入 ${SIZE / MiB} MiB 之后 RSS 只涨了 ${(growth / MiB).toFixed(1)} MiB —— ` +
      '说明这个判据不灵敏，上面那条"流式"的结论也就不可信了')
    // 别让优化器把大缓冲提前回收掉
    assert.equal(wholeBuf[0], wholeBuf[wholeBuf.length - 1] === 0 ? wholeBuf[0] : wholeBuf[0])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('hashFile 与 hashBuffer 对同一份内容给出完全相同的结果', async () => {
  // 这条锁住"两种来源走同一套分块口径"。它们一旦漂移，
  // 症状是"磁盘文件传过去校验失败、内存里的赠品包却没事"—— 极难查。
  // 分段构造，正好覆盖"最后一块不齐"的情形。
  const chunkBytes = PARAMS.chunkBytes
  const size = chunkBytes * 2 + 777
  const buf = Buffer.allocUnsafe(size)
  for (let i = 0; i < size; i++) buf[i] = (i * 17 + 3) & 0xff

  const dir = await mkdtemp(path.join(tmpdir(), 'flicker-large-'))
  const file = path.join(dir, 'same.bin')
  try {
    await open(file, 'w').then(async (fh) => { await fh.write(buf, 0, size); await fh.close() })
    const fromDisk = await hashFile(file, chunkBytes)
    const fromMem = hashBuffer(buf, chunkBytes)
    assert.equal(fromDisk.sha256, fromMem.sha256, '整体哈希必须一致')
    assert.deepEqual(fromDisk.chunkHashes, fromMem.chunkHashes, '逐块哈希必须逐个一致')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('⭐ 服务端、中继客户端与中继核只做分块读，源码里不许出现 readFile(', () => {
  // 静态判据。它比动态判据更早、更准地指出问题出在哪一行。
  // 2026-10：中继侧的公用核 `src/relay/core.js` 也算在内 ——
  // 它现在同时被 Node 发送端与（将来的）网页发送端使用，
  // "整文件读进内存"在这里同样不可接受。
  for (const rel of ['src/server.js', 'src/relay/client.js', 'src/relay/core.js']) {
    const src = readFileSync(path.join(ROOT, rel), 'utf8')
    const hits = src.split('\n')
      .map((line, i) => ({ line, no: i + 1 }))
      .filter((x) => /readFile\s*\(/.test(x.line) && !/^\s*(\*|\/\/)/.test(x.line))
    assert.deepEqual(hits.map((h) => `${rel}:${h.no}`), [],
      `${rel} 里出现了 readFile( —— 这条路必须按块读（open + read + 偏移），` +
      '否则发大文件时整个文件会进内存。见 _lab/bench-memory.mjs 的实测数字。')
  }
})

test('分块缓冲只分配一次，且大小覆盖清单里最大的块', async () => {
  // 断言缓冲是**常量**：每个分块新分配一个 1 MiB Buffer 不会立刻爆，
  // 但它会让 GC 压力随文件大小增长（2 GiB 就是 2048 次 1 MiB 分配）。
  //
  // ⚠️ 2026-10 改了判据：原来断言的是"大小 == PARAMS.chunkBytes"这个**字面值**，
  //    而块大小其实是**逐文件字段**（线上格式允许它不等于协议默认值）。
  //    写死默认值的后果实测过：局域网发送端会**静默截断**（读不满的当成零字节发出去），
  //    中继发送端会误报"文件在传输过程中被改动"。所以正确的判据是两条：
  //      ① 分配只发生一次（在构造函数里，不在每块）
  //      ② 大小按清单里实际用到的最大块来算
  const { TransferServer } = await import('../src/server.js')
  const srv = Object.create(TransferServer.prototype)
  const src = readFileSync(path.join(ROOT, 'src/server.js'), 'utf8')
  assert.equal((src.match(/Buffer\.allocUnsafe\(/g) ?? []).length, 1,
    '服务端的读取缓冲必须"构造时分配一次、之后复用"')
  assert.match(src, /this\._buf = Buffer\.allocUnsafe\(maxChunk\)/,
    '大小要按清单里最大的块分配')
  assert.match(src, /Math\.max\(PARAMS\.chunkBytes,[\s\S]{0,120}f\.chunkBytes\)/,
    '取值是 max(协议默认值, 清单里各文件的 chunkBytes) —— 不能写死默认值')

  const relay = readFileSync(path.join(ROOT, 'src/relay/client.js'), 'utf8')
  assert.equal((relay.match(/Buffer\.allocUnsafe\(/g) ?? []).length, 1,
    '中继客户端同理：只分配一次')
  assert.match(relay, /Math\.max\(PARAMS\.chunkBytes,[\s\S]{0,120}f\.chunkBytes\)/,
    '中继客户端也要按最大的块分配（同一个坑的第二处）')
  assert.ok(srv)   // 只是为了让上面的 import 有意义
})

test('哈希用的缓冲也是复用的（不是每块新分配）', () => {
  const src = readFileSync(path.join(ROOT, 'src/manifest.js'), 'utf8')
  const fn = src.slice(src.indexOf('export async function hashFile'))
  const body = fn.slice(0, fn.indexOf('\n}\n'))
  const allocs = body.match(/Buffer\.allocUnsafe\(/g) ?? []
  assert.equal(allocs.length, 1,
    `hashFile 里应当只分配一次缓冲（实际 ${allocs.length} 次）—— ` +
    '每块新分配一个 1 MiB Buffer 会让 GC 压力随文件大小增长')
  // 而且要分配在循环**外面**：循环体内分配同样等于每块一次
  const loopIdx = body.indexOf('for (;;)')
  assert.ok(body.indexOf('Buffer.allocUnsafe(') < loopIdx,
    '缓冲必须分配在循环之外')
})

test('大文件哈希的耗时是线性的（顺带证明它真的在读盘，而不是跳着读）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'flicker-large-'))
  const small = path.join(dir, 'small.bin')
  const big = path.join(dir, 'big.bin')
  try {
    await makeFile(small, 8 * MiB)
    await makeFile(big, 32 * MiB)

    // ⚠️ 计时类判据必须**取多轮里最快的一次**，否则它测的是"当时机器有多忙"。
    //    这条用例真的在整套测试里偶发失败过一次（正好排在构建 90 MB 产物之后，
    //    磁盘与 CPU 都被占着）：8 MiB 那次恰好被拖慢，于是 32 MiB/8 MiB 的比值
    //    掉到 1.5 以下。判据本身没问题，是测量方式不抗干扰。
    //    先跑一遍预热（进页缓存），再取 3 轮最小值 —— 剩下的差异才是真的。
    const fastest = async (p, runs = 3) => {
      await hashFile(p, PARAMS.chunkBytes)              // 预热
      let best = Infinity
      for (let i = 0; i < runs; i++) {
        const t = Date.now()
        await hashFile(p, PARAMS.chunkBytes)
        best = Math.min(best, Date.now() - t)
      }
      return best
    }

    const tSmall = await fastest(small)
    const tBig = await fastest(big)
    // 4 倍文件，耗时应当明显更长（界留得很宽，只排除"根本没读"这种荒谬情况）
    assert.ok(tBig > tSmall * 1.5,
      `32 MiB 最快 ${tBig}ms，8 MiB 最快 ${tSmall}ms —— 比例不像线性，检查是否真的在按块读`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
