/**
 * 最小 ZIP 写入器（`gen/zip.mjs`）
 * ================================
 *
 * 这条判据的分量在于：**发布包用的是自己写的 ZIP**。写错了不会有人立刻发现，
 * 只会在"下载的人解不开压缩包"时才暴露 —— 而那时产物已经发出去了。
 *
 * 所以这里**不复用写入器的任何代码**去验证它自己：读取那一段是本文件里另写的一份
 * 最小解析器（只依赖 ZIP 规范），CRC 拿 `zlib.crc32` 当参照。
 * "用同一份实现验证同一份实现"等于没验。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { inflateRawSync, crc32 as zlibCrc32 } from 'node:zlib'
import { writeZip, crc32, Crc32 } from '../gen/zip.mjs'

const cleanups = []
test.after(async () => {
  for (const fn of cleanups.reverse()) {
    try { await fn() } catch (e) { console.error('清理失败：' + (e?.message ?? e)) }
  }
})

async function tmpDir() {
  const d = await mkdtemp(path.join(tmpdir(), 'flicker-zip-'))
  cleanups.push(() => rm(d, { recursive: true, force: true }))
  return d
}

/**
 * 独立的最小 ZIP 读取器（只按规范解析，不 import 写入器的任何东西）。
 * 只支持本测试用到的那一小块：无注释、非 zip64、单盘。
 */
function readZip(buf) {
  const eocd = buf.length - 22
  assert.equal(buf.readUInt32LE(eocd), 0x06054b50, 'EOCD 签名不对')
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  const entries = []
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(off), 0x02014b50, `第 ${i} 条中央目录签名不对`)
    const method = buf.readUInt16LE(off + 10)
    const time = buf.readUInt16LE(off + 12)
    const date = buf.readUInt16LE(off + 14)
    const crc = buf.readUInt32LE(off + 16)
    const compSize = buf.readUInt32LE(off + 20)
    const rawSize = buf.readUInt32LE(off + 24)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const externalAttrs = buf.readUInt32LE(off + 38)
    const localOff = buf.readUInt32LE(off + 42)
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8')

    assert.equal(buf.readUInt32LE(localOff), 0x04034b50, `第 ${i} 条本地头签名不对`)
    const lNameLen = buf.readUInt16LE(localOff + 26)
    const lExtraLen = buf.readUInt16LE(localOff + 28)
    const dataStart = localOff + 30 + lNameLen + lExtraLen
    const comp = buf.subarray(dataStart, dataStart + compSize)
    const raw = method === 0 ? Buffer.from(comp) : inflateRawSync(comp)
    entries.push({ name, method, time, date, crc, compSize, rawSize, externalAttrs, raw, dataStart })
    off += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

// ── CRC-32：自己写的那个必须有独立参照 ──────────────────────

test('⭐ 自写的 CRC-32 与 zlib.crc32 逐位一致（它是整个 ZIP 的完整性基础）', () => {
  for (const n of [0, 1, 2, 3, 31, 32, 33, 255, 1024, 65536]) {
    const buf = randomBytes(n)
    assert.equal(crc32(buf), zlibCrc32(buf),
      `长度 ${n} 时 CRC 与 zlib 不一致 —— 自己写的校验和必须能被独立实现证伪`)
  }
  // 增量用法（流式读文件走的就是这条路）必须与一次算完相同
  const whole = randomBytes(100000)
  const step = new Crc32()
  for (let i = 0; i < whole.length; i += 7919) step.update(whole.subarray(i, i + 7919))
  assert.equal(step.digest(), zlibCrc32(whole), '分块喂给 Crc32 的结果与一次算完不一致')
})

// ── 往返：写进去的必须原样读出来 ────────────────────────────

test('⭐ ZIP 往返：从磁盘读一个文件写进 zip，解出来逐字节一致', async () => {
  const dir = await tmpDir()
  const payload = randomBytes(300000)                  // 随机数据：压不动，正好也测 store/deflate 边界
  await writeFile(path.join(dir, 'a.bin'), payload)

  const zipPath = path.join(dir, 'a.zip')
  await writeZip(zipPath, [{ name: 'a.bin', path: path.join(dir, 'a.bin'), mode: 0o755 }])
  const zip = await readFile(zipPath)
  const entries = readZip(zip)

  assert.equal(entries.length, 1)
  assert.equal(entries[0].name, 'a.bin')
  assert.equal(entries[0].rawSize, payload.length, '头部里的原始大小不对')
  assert.equal(entries[0].crc, zlibCrc32(payload), '头部里的 CRC 不是这个文件的')
  assert.deepEqual(Buffer.compare(entries[0].raw, payload), 0, '解出来的字节与原文不一致')
})

test('ZIP 往返：可压缩的内容确实被压小了（否则"zip 分发"这个理由不成立）', async () => {
  const dir = await tmpDir()
  const payload = Buffer.alloc(2 * 1024 * 1024, 7)      // 高度可压缩
  await writeFile(path.join(dir, 'big.bin'), payload)

  const zipPath = path.join(dir, 'big.zip')
  const r = await writeZip(zipPath, [{ name: 'big.bin', path: path.join(dir, 'big.bin') }])
  const zipSize = (await readFile(zipPath)).length

  assert.ok(zipSize < payload.length / 4,
    `2 MiB 的重复内容压完还有 ${zipSize} 字节 —— 压缩没生效`)
  assert.equal(r.entries[0].rawSize, payload.length)
  assert.deepEqual(readZip(await readFile(zipPath))[0].raw, payload)
})

test('ZIP 往返：空文件与多条目（顺序也要保持）', async () => {
  const dir = await tmpDir()
  const zipPath = path.join(dir, 'multi.zip')
  await writeZip(zipPath, [
    { name: 'empty.txt', data: Buffer.alloc(0) },
    { name: 'one.txt', data: Buffer.from('一', 'utf8') },
    { name: 'two.txt', data: Buffer.from('22222') },
  ])
  const entries = readZip(await readFile(zipPath))

  assert.deepEqual(entries.map((e) => e.name), ['empty.txt', 'one.txt', 'two.txt'],
    '条目顺序必须与写入顺序一致（中央目录顺序影响解压/列表体验）')
  assert.equal(entries[0].rawSize, 0)
  assert.equal(entries[0].crc, 0, '空文件的 CRC 应当是 0')
  assert.equal(entries[0].raw.length, 0)
  assert.equal(entries[1].raw.toString('utf8'), '一')
  assert.equal(entries[2].raw.toString('utf8'), '22222')
})

// ── 可复现：同输入两次必须得到同一个字节串 ───────────────────

test('⭐ 同一个输入写两次，zip 逐字节相同（否则"可复现构建"就是假的）', async () => {
  const dir = await tmpDir()
  const payload = randomBytes(50000)
  await writeFile(path.join(dir, 'x.bin'), payload)

  const a = path.join(dir, 'a.zip')
  const b = path.join(dir, 'b.zip')
  await writeZip(a, [{ name: 'x.bin', path: path.join(dir, 'x.bin') }])
  await writeZip(b, [{ name: 'x.bin', path: path.join(dir, 'x.bin') }])

  const [ba, bb] = [await readFile(a), await readFile(b)]
  assert.deepEqual(Buffer.compare(ba, bb), 0,
    '两次打包结果不同 —— ZIP 头里一定写进了会变的东西（时间/顺序/临时名）')
  // 时间戳是固定的 1980-01-01，不是"当前时间"
  const e = readZip(ba)[0]
  assert.equal(e.time, 0, 'DOS 时间字段应当是固定常量 0')
  assert.equal(e.date, 0x0021, 'DOS 日期字段应当是固定的 1980-01-01')
})

test('ZIP：解压后的权限位（macOS/Linux 上要靠它拿到可执行位）', async () => {
  const dir = await tmpDir()
  const zipPath = path.join(dir, 'm.zip')
  await writeZip(zipPath, [{ name: 'flicker', data: Buffer.from('x'), mode: 0o755 }])
  const e = readZip(await readFile(zipPath))[0]
  assert.equal(e.externalAttrs >>> 16, 0o755,
    '没有把权限位写进外部属性 —— 在 Linux/macOS 上解出来会没有执行权限')

  const zip2 = path.join(dir, 'm2.zip')
  await writeZip(zip2, [{ name: 'doc.md', data: Buffer.from('x') }])
  assert.equal(readZip(await readFile(zip2))[0].externalAttrs >>> 16, 0o644,
    '默认应当是 0644（文档类文件不该是可执行）')
})

// ── 反向验证：损坏必须被发现 ────────────────────────────────

test('⭐ 反向验证：压缩数据里改一个字节 → CRC 对不上必须被抓住', async () => {
  const dir = await tmpDir()
  const payload = Buffer.alloc(20000, 3)
  const zipPath = path.join(dir, 'c.zip')
  await writeZip(zipPath, [{ name: 'c.bin', path: await (async () => {
    await writeFile(path.join(dir, 'c.bin'), payload)
    return path.join(dir, 'c.bin')
  })() }])

  const zip = await readFile(zipPath)
  const e = readZip(zip)[0]
  // 数据区起点由**解析器**给（第一版这里是测试自己算的，算错了 —— 减多了，
  // 结果改坏的是本地头里的文件名字节，数据没动，于是"什么都没抓住"）
  const bad = Buffer.from(zip)
  bad[e.dataStart + Math.floor(e.compSize / 2)] ^= 0xff

  let detected = false
  try {
    const got = readZip(bad)[0].raw
    detected = zlibCrc32(got) !== e.crc
  } catch {
    detected = true                 // 结构被改坏、inflate 直接抛错，也算抓住
  }
  assert.ok(detected, '改坏了压缩数据却没人发现 —— 说明"往返一致"那条断言是空的')
})

test('反向验证：把 CRC 字段本身改掉，独立计算必须与它不符', async () => {
  const dir = await tmpDir()
  const zipPath = path.join(dir, 'd.zip')
  await writeZip(zipPath, [{ name: 'd.bin', data: Buffer.from('hello world') }])

  const zip = Buffer.from(await readFile(zipPath))
  const e = readZip(zip)[0]
  // 中央目录里的 CRC（在本地头里也有一份，这里改中央目录那份）
  const cd = zip.length - 22 - 46 - e.name.length
  zip.writeUInt32LE((e.crc ^ 0xdeadbeef) >>> 0, cd + 16)

  const got = readZip(zip)[0]
  assert.notEqual(got.crc, zlibCrc32(got.raw), '改过的 CRC 竟然还对得上')
})
