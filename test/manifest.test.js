/**
 * 清单模块测试 —— 重点在**路径安全**，因为清单是外来输入
 * 运行: node --test "test/*.test.js"
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  sanitizeRelPath, dedupePath, scan, hashFile, fillHashes,
  toWire, fromWire, summarize, formatSize,
} from '../src/manifest.js'

// ── 路径安全：每一条都必须被拒绝 ─────────────────────────────

test('路径穿越被拒绝', () => {
  for (const evil of ['../etc/passwd', 'a/../../b', '..', 'a/..', '../../..', 'x/../../../y']) {
    assert.throws(() => sanitizeRelPath(evil), /路径穿越/, `应拒绝: ${evil}`)
  }
})

test('绝对路径被拒绝（两种平台的形式都要挡）', () => {
  for (const evil of ['/etc/passwd', '/', 'C:/Windows/System32', 'c:/x', 'C:\\Windows', 'D:', '\\\\server\\share\\f']) {
    // ⚠️ UNC（`\\server\share`）现在报的是 **R3**，不再混在"绝对/盘符"里 ——
    //    规则表里 R1/R2/R3 本就是三条，报错说清是哪一条比笼统的"路径不合法"有用
    assert.throws(() => sanitizeRelPath(evil), /拒绝\s*(绝对|盘符|UNC)\s*路径/, `应拒绝: ${evil}`)
  }
  // 报错要带上规则编号：接收端拿它给用户解释"为什么这个文件收不了"
  assert.throws(() => sanitizeRelPath('/etc/passwd'), (e) => e.rule === 'R1' && e.code === 'E_PATH_UNSAFE')
  assert.throws(() => sanitizeRelPath('\\\\srv\\share'), (e) => e.rule === 'R3')
})

test('含冒号的普通文件名不能被误判成盘符路径', () => {
  // "a:b.txt" 在 NTFS 上是合法的（交替数据流），只是 Windows 资源管理器不让创建
  assert.equal(sanitizeRelPath('a:b.txt', { windows: true }), 'a_b.txt', '应替换冒号而非拒绝')
  assert.equal(sanitizeRelPath('note:2024.txt', { windows: true }), 'note_2024.txt')
})

test('空字节被拒绝', () => {
  assert.throws(() => sanitizeRelPath('a\0b'), /空字节/)
})

test('Windows 保留设备名被拒绝', () => {
  for (const evil of ['CON', 'con.txt', 'NUL', 'aux.log', 'COM1', 'lpt9.dat', 'sub/PRN.md']) {
    assert.throws(() => sanitizeRelPath(evil, { windows: true }), /保留设备名/, `应拒绝: ${evil}`)
  }
  // ⚠️ 这里刻意是"拒绝"而不是"改名成 _CON"：Windows 上 `CON` 是设备名，
  //    改名会骗到用户（他以为收到了 CON，其实那个名字根本创建不出来）
  assert.throws(() => sanitizeRelPath('CON', { windows: true }), (e) => e.rule === 'R8')
})

test('空路径与非字符串被拒绝', () => {
  for (const evil of ['', null, undefined, 42, {}]) {
    assert.throws(() => sanitizeRelPath(evil), /路径必须是/)
  }
})

test('正常路径被保留并规范化', () => {
  assert.equal(sanitizeRelPath('a.txt'), 'a.txt')
  assert.equal(sanitizeRelPath('dir/sub/a.txt'), 'dir/sub/a.txt')
  assert.equal(sanitizeRelPath('dir//sub///a.txt'), 'dir/sub/a.txt')
  assert.equal(sanitizeRelPath('./dir/a.txt'), 'dir/a.txt')
  assert.equal(sanitizeRelPath('dir\\sub\\a.txt'), 'dir/sub/a.txt', '反斜杠应归一化')
  assert.equal(sanitizeRelPath('中文/文件夹/文件.txt'), '中文/文件夹/文件.txt')
})

test('Windows 非法字符被替换而不是抛错（这类名字很常见）', () => {
  assert.equal(sanitizeRelPath('a:b.txt', { windows: true }), 'a_b.txt')
  assert.equal(sanitizeRelPath('what?.txt', { windows: true }), 'what_.txt')
  assert.equal(sanitizeRelPath('a<b>c.txt', { windows: true }), 'a_b_c.txt')
})

test('结尾的点与空格被清理（Windows 会静默丢弃，导致同名冲突）', () => {
  assert.equal(sanitizeRelPath('report.', { windows: true }), 'report')
  assert.equal(sanitizeRelPath('report ', { windows: true }), 'report')
  assert.equal(sanitizeRelPath('a./b. ', { windows: true }), 'a/b')
})

test('全为点的名字会被兜底处理，不会变成空段', () => {
  assert.equal(sanitizeRelPath('...', { windows: true }), '_')
})

test('超长路径被拒绝（按协议的字节口径，不是字符数）', () => {
  // ⚠️ 这里改过一次口径，值得记：旧实现拒绝的是 **1024 字符**，
  //    而 PROTOCOL.md §6.2 的 R7 写的是「单段 > 255 字节，或整体 > 4096 字节」。
  //    实现比协议严本身不是错，但两处不一致时以**协议**为准 ——
  //    否则文档写的限制与实际行为对不上，照着文档写客户端的人就会踩空。
  const long = 'ab/'.repeat(400) + 'c.txt'          // 1205 字节：旧实现拒、协议允许
  assert.equal(sanitizeRelPath(long), long, '1024~4096 字节之间、由短段组成的路径应当接受')

  assert.throws(() => sanitizeRelPath('a/'.repeat(2200) + 'b.txt'),
    (e) => e.rule === 'R7', '整体超过 4096 字节应当拒绝')
  // 单段超过 255 字节：中文按 UTF-8 是 3 字节，85 个汉字 = 255 字节，再加 ".txt" 就超了
  assert.throws(() => sanitizeRelPath('中'.repeat(85) + '.txt'),
    (e) => e.rule === 'R7', '单段超过 255 字节应当拒绝')
  assert.equal(sanitizeRelPath('中'.repeat(83) + '.txt'), '中'.repeat(83) + '.txt',
    '83 个汉字 + ".txt" = 253 字节，在限内，必须放行')
})

// ── 同名去重 ────────────────────────────────────────────────

test('dedupePath 生成不冲突的名字', () => {
  const taken = new Set()
  assert.equal(dedupePath('a.txt', taken), 'a.txt')
  assert.equal(dedupePath('a.txt', taken), 'a (1).txt')
  assert.equal(dedupePath('a.txt', taken), 'a (2).txt')
  assert.equal(dedupePath('dir/b.md', taken), 'dir/b.md')
  assert.equal(dedupePath('dir/b.md', taken), 'dir/b (1).md')
  assert.equal(dedupePath('noext', taken), 'noext')
  assert.equal(dedupePath('noext', taken), 'noext (1)')
})

test('dedupePath 大小写不敏感（避免 Windows/macOS 上落盘冲突）', () => {
  const taken = new Set()
  dedupePath('Readme.md', taken)
  assert.equal(dedupePath('readme.md', taken), 'readme (1).md')
})

// ── 扫描 ───────────────────────────────────────────────────

async function makeTree() {
  const root = await mkdtemp(path.join(tmpdir(), 'flicker-scan-'))
  await mkdir(path.join(root, '照片'), { recursive: true })
  await mkdir(path.join(root, '照片', '子目录'), { recursive: true })
  await writeFile(path.join(root, 'a.txt'), 'hello world')
  await writeFile(path.join(root, '照片', 'p1.jpg'), Buffer.alloc(100, 1))
  await writeFile(path.join(root, '照片', '子目录', 'p2.jpg'), Buffer.alloc(250, 2))
  await writeFile(path.join(root, 'empty.bin'), '')
  return root
}

test('扫描目录：递归、路径正确、块数正确', async () => {
  const root = await makeTree()
  try {
    const m = await scan([root], { chunkBytes: 100 })
    const rels = m.files.map((f) => f.rel).sort()
    assert.deepEqual(rels, [
      `${path.basename(root)}/a.txt`,
      `${path.basename(root)}/empty.bin`,
      `${path.basename(root)}/照片/p1.jpg`,
      `${path.basename(root)}/照片/子目录/p2.jpg`,
    ].sort())
    assert.equal(m.totalBytes, 11 + 100 + 250 + 0)

    const p2 = m.files.find((f) => f.rel.endsWith('p2.jpg'))
    assert.equal(p2.size, 250)
    assert.equal(p2.chunks, 3, '250 字节 / 每块 100 → 3 块（含不齐的尾块）')

    const empty = m.files.find((f) => f.rel.endsWith('empty.bin'))
    assert.equal(empty.size, 0)
    assert.equal(empty.chunks, 1, '空文件也占一块，否则接收端无法创建它')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('扫描：块序号全局连续且不重叠（跨文件）', async () => {
  const root = await makeTree()
  try {
    const m = await scan([root], { chunkBytes: 100 })
    let expected = 0
    for (const f of m.files) {
      assert.equal(f.firstChunk, expected, `${f.rel} 的起始块号应为 ${expected}`)
      expected += f.chunks
    }
    assert.equal(m.totalChunks, expected)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('扫描：单个文件与多个输入的混合', async () => {
  const root = await makeTree()
  try {
    const m = await scan([
      path.join(root, 'a.txt'),
      path.join(root, '照片'),
    ], { chunkBytes: 1 << 20 })
    assert.equal(m.files.length, 3)
    assert.ok(m.files.some((f) => f.rel === 'a.txt'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('扫描：不跟随符号链接（避免发出任意位置的文件）', async (t) => {
  const root = await makeTree()
  try {
    const secret = path.join(root, 'secret-target.txt')
    await writeFile(secret, 'should not be followed')
    try {
      await symlink(secret, path.join(root, 'link.txt'))
    } catch { return t.skip('此平台不支持创建符号链接') }

    const warns = []
    const m = await scan([root], { chunkBytes: 100, onWarn: (w) => warns.push(w) })
    assert.ok(!m.files.some((f) => f.rel.endsWith('link.txt')), '不应包含符号链接本身')
    assert.ok(warns.some((w) => w.includes('符号链接')), '应给出警告')
    // 链接目标本身仍在目录里，会被正常收录 —— 这是对的
    assert.ok(m.files.some((f) => f.rel.endsWith('secret-target.txt')))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('扫描：不存在的路径给出清晰错误', async () => {
  await assert.rejects(() => scan(['D:/definitely/not/here/xyz']), /不存在或不可访问/)
})

test('扫描：没有任何可发文件时报错', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'flicker-empty-'))
  try {
    await assert.rejects(() => scan([root]), /没有可发送的文件/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

// ── 哈希与完整性 ────────────────────────────────────────────

test('hashFile：已知内容的 SHA-256 正确', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'flicker-hash-'))
  try {
    const p = path.join(dir, 'known.txt')
    await writeFile(p, 'abc')
    const { sha256, chunkHashes } = await hashFile(p, 1024)
    // echo -n abc | sha256sum
    assert.equal(sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    assert.equal(chunkHashes.length, 1)
    assert.equal(chunkHashes[0], sha256, '单块文件的块哈希应等于整体哈希')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('hashFile：多块时块哈希数量正确，且整体哈希独立成立', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'flicker-hash2-'))
  try {
    const p = path.join(dir, 'multi.bin')
    await writeFile(p, Buffer.alloc(250, 7))
    const { sha256, chunkHashes } = await hashFile(p, 100)
    // 250 = 100 + 100 + 50 → 3 块
    assert.equal(chunkHashes.length, 3, '每块一个哈希，尾块不齐也算一块')
    assert.equal(chunkHashes[0], chunkHashes[1], '前两块内容相同（各 100 个 7），哈希应相同')
    assert.notEqual(chunkHashes[2], chunkHashes[0], '尾块只有 50 字节，哈希必须不同')
    assert.equal(sha256.length, 64)
    assert.notEqual(sha256, chunkHashes[0], '整体哈希与块哈希是不同的东西')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('hashFile：空文件也有合法的整体哈希', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'flicker-hash3-'))
  try {
    const p = path.join(dir, 'empty')
    await writeFile(p, '')
    const { sha256, chunkHashes } = await hashFile(p, 100)
    assert.equal(sha256, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    assert.equal(chunkHashes.length, 1)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('fillHashes 给每个文件补上完整性信息', async () => {
  const root = await makeTree()
  try {
    const m = await scan([root], { chunkBytes: 100 })
    await fillHashes(m)
    for (const f of m.files) {
      assert.equal(f.sha256.length, 64, `${f.rel} 缺少整体哈希`)
      assert.equal(f.chunkHashes.length, f.chunks, `${f.rel} 块哈希数量与块数不符`)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

// ── 清单序列化 ─────────────────────────────────────────────

test('toWire 剔除本地字段（absPath 绝不能进清单）', async () => {
  const root = await makeTree()
  try {
    const m = await scan([root], { chunkBytes: 100 })
    await fillHashes(m)
    const wire = toWire(m)
    const json = JSON.stringify(wire)
    assert.ok(!json.includes('absPath'), 'absPath 必须被剔除')
    assert.ok(!json.includes(root), '本地绝对路径不能出现在清单里')
    for (const f of wire.files) {
      assert.equal(f.absPath, undefined)
      assert.ok(f.rel && f.sha256 && Array.isArray(f.chunkHashes))
    }
    assert.equal(wire.v, 1)
    assert.equal(wire.suite, 'FLICKER/1')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('清单往返一致', async () => {
  const root = await makeTree()
  try {
    const m = await scan([root], { chunkBytes: 100 })
    await fillHashes(m)
    const wire = toWire(m)
    const back = fromWire(JSON.parse(JSON.stringify(wire)))
    assert.deepEqual(back.files.map((f) => f.rel), wire.files.map((f) => f.rel))
    assert.equal(back.totalChunks, wire.totalChunks)
    assert.equal(back.files[0].index, 0)
    assert.equal(back.files[1].firstChunk, back.files[0].chunks)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('fromWire 拒绝恶意或损坏的清单', () => {
  const good = { v: 1, files: [{ kind: 'file', name: 'a', rel: 'a', size: 1, chunks: 1, chunkBytes: 1024, sha256: 'x', chunkHashes: ['y'] }], totalBytes: 1, totalChunks: 1 }
  assert.throws(() => fromWire(null), /版本不支持/)
  assert.throws(() => fromWire({ v: 99, files: [] }), /版本不支持/)
  assert.throws(() => fromWire({ v: 1, files: [] }), /清单为空/)
  assert.throws(() => fromWire({ v: 1, files: [{ rel: '../x', size: 1, chunks: 1 }] }), /路径穿越/)
  assert.throws(() => fromWire({ v: 1, files: [{ rel: 'a', size: -1, chunks: 1 }] }), /大小非法/)
  assert.throws(() => fromWire({ v: 1, files: [{ rel: 'a', size: 1, chunks: 0 }] }), /块数非法/)
  assert.doesNotThrow(() => fromWire(good))
})

test('summarize 给出概览', async () => {
  const root = await makeTree()
  try {
    const m = await scan([root], { chunkBytes: 100 })
    const s = summarize(toWire(m))
    assert.equal(s.fileCount, 4)
    assert.equal(s.totalBytes, m.totalBytes)
    assert.equal(s.largest.size, 250)
    assert.ok(s.dirCount >= 2, '应识别出 照片 与 照片/子目录')
  } finally { await rm(root, { recursive: true, force: true }) }
})

// ── 显示辅助 ────────────────────────────────────────────────

test('formatSize 可读且边界正确', () => {
  assert.equal(formatSize(0), '0 B')
  assert.equal(formatSize(999), '999 B')
  assert.equal(formatSize(1024), '1.0 KB')
  assert.equal(formatSize(1536), '1.5 KB')
  assert.equal(formatSize(1024 * 1024), '1.0 MB')
  assert.equal(formatSize(2.5 * 1024 ** 3), '2.5 GB')
  assert.equal(formatSize(100 * 1024 ** 3), '100 GB')
})
