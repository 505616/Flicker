/**
 * 解开赠品源码包（`flicker unpack`）
 * ================================
 *
 * 这条功能的由来：**"把源码送给对方"以前只做了一半。**
 * 程序会把源码 + 文档打成一个 `.fkz` 一起送过去，而产品里**没有任何东西能打开它** ——
 * 对方拿到文件、双击打不开、也没有命令行能解。这条缺口在 `_lab/交接.md` 里挂了一年。
 *
 * 判据的重点不是"能解一个正常的包"，而是：
 *   ① 真的能用：真包 → `flicker unpack` → 解开的那份**能跑起来**（`--version` 正确）；
 *   ② **不信任输入**：`.fkz` 可能来自别人，甚至是伪造的 —— 坏魔数、截断、路径穿越、
 *      两个条目落到同一个文件、非法 UTF-8、尾部多余字节，每一种都必须**拒绝**，
 *      而且不能在磁盘上留下半个树；
 *   ③ 撞车不覆盖：目标已存在时默认失败（`--force` 才覆盖）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { UNPACK_LIMITS, UnpackError, packForTest, unpackArchive, unpackToDir } from '../src/gift.js'
import { makeTempDir } from '../gen/tmp.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CLI = path.join(ROOT, 'bin', 'flicker.js')

const cleanups = []
test.after(async () => {
  for (const fn of cleanups.reverse()) {
    try { await fn() } catch (e) { console.error('清理失败：' + (e?.message ?? e)) }
  }
})

async function tempDir() {
  const dir = makeTempDir('flicker-unpack-')
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** 造一个合法的包（用生产里的打包函数，不手写字节） */
function pack(files) {
  return packForTest(files.map((f) => ({
    rel: f.rel, mode: f.mode ?? 0o644, data: Buffer.from(f.data),
  })))
}

// ── ① 正常路径 ───────────────────────────────────────────

test('解包：原文原样取回（含子目录、空文件、中文路径、可执行位）', () => {
  const bytes = pack([
    { rel: 'a.txt', data: 'hello' },
    { rel: '目录/深一点/b.bin', data: Buffer.from([0, 1, 2, 255]) },
    { rel: 'empty', data: '' },
    { rel: '启动.sh', mode: 0o755, data: '#!/bin/sh\n' },
  ])
  const entries = unpackArchive(bytes)
  assert.deepEqual(entries.map((e) => e.rel),
    ['a.txt', '目录/深一点/b.bin', 'empty', '启动.sh'])
  assert.equal(entries[0].data.toString(), 'hello')
  assert.deepEqual([...entries[1].data], [0, 1, 2, 255])
  assert.equal(entries[2].data.length, 0)
  assert.equal(entries[3].mode & 0o111, 0o111, '可执行位要保留（POSIX 上要靠它双击/直接跑）')
})

test('解包到目录：文件落在对的位置，长度对得上', async () => {
  const dir = await tempDir()
  const bytes = pack([{ rel: 'x/y/z.txt', data: 'deep' }, { rel: 'top.md', data: '# hi' }])
  const r = await unpackToDir(bytes, dir)
  assert.equal(r.files.length, 2)
  assert.equal(r.bytes, 'deep'.length + '# hi'.length, '解出来的总字节数要对得上')
  assert.equal(String(await readFile(path.join(dir, 'x', 'y', 'z.txt'))), 'deep')
  assert.equal(String(await readFile(path.join(dir, 'top.md'))), '# hi')
})

test('目标已存在：默认**不覆盖**；--force 才覆盖', async () => {
  const dir = await tempDir()
  const bytes = pack([{ rel: 'keep.txt', data: 'new' }])
  await writeFile(path.join(dir, 'keep.txt'), 'old')
  await assert.rejects(() => unpackToDir(bytes, dir), (e) => {
    assert.equal(e.code, 'EXISTS')
    assert.match(e.message, /已经存在/)
    return true
  })
  assert.equal(String(await readFile(path.join(dir, 'keep.txt'))), 'old', '拒绝之后旧文件必须原样')
  await unpackToDir(bytes, dir, { force: true })
  assert.equal(String(await readFile(path.join(dir, 'keep.txt'))), 'new')
})

// ── ② 不信任输入：每一种坏包都必须被拒绝 ─────────────────

const hostile = [
  ['魔数不对', () => Buffer.from('NOPE' + '\0'.repeat(8)), /不是 .fkz|开头不是 FKZ1/],
  ['太短', () => Buffer.from('FKZ'), /太短/],
  ['条目数为 0', () => { const b = Buffer.alloc(8); b.write('FKZ1'); return b }, /没有任何文件/],
  ['条目数荒唐', () => {
    const b = Buffer.alloc(8); b.write('FKZ1'); b.writeUInt32BE(UNPACK_LIMITS.maxEntries + 1, 4); return b
  }, /条目数不合理/],
  ['头部被截断', () => {
    const b = Buffer.alloc(10); b.write('FKZ1'); b.writeUInt32BE(1, 4); return b
  }, /超出文件末尾|截断/],
  ['内容被截断', () => {
    const full = pack([{ rel: 'a.txt', data: '0123456789' }])
    return full.subarray(0, full.length - 4)
  }, /超出文件末尾|截断/],
  ['路径穿越', () => pack([{ rel: '../escape.txt', data: 'x' }]), /路径不安全/],
  ['绝对路径', () => pack([{ rel: '/etc/passwd', data: 'x' }]), /路径不安全/],
  ['两个条目落到同一个文件', () => pack([
    { rel: 'A.txt', data: '1' }, { rel: 'a.txt', data: '2' },
  ]), /同一个文件/],
  ['尾部多出字节', () => Buffer.concat([pack([{ rel: 'a.txt', data: 'x' }]), Buffer.from('junk')]),
    /[0-9]+ 个多余字节/],
]

for (const [name, make, want] of hostile) {
  test(`坏包必须被拒绝：${name}`, () => {
    const bytes = make()
    assert.throws(() => unpackArchive(bytes), (e) => {
      assert.ok(e instanceof UnpackError, `要是 UnpackError，实际 ${e?.name}`)
      assert.match(e.message, want)
      return true
    })
  })
}

test('Windows 保留名：Windows 上拒绝、其它平台是合法文件名（规则按平台生效）', () => {
  // ⚠️ 这一条踩过：把它塞进上面的"坏包表"里当"必须拒绝"的用例，
  //    Linux / macOS 上 `CON` 就是普通文件名，于是 CI 在 ubuntu 与 macOS 上红了两条。
  //    规则本身是按平台生效的（`src/path-safety.js` R8），判据要跟着平台走。
  const bytes = pack([{ rel: 'CON', data: 'x' }])
  if (process.platform === 'win32') {
    assert.throws(() => unpackArchive(bytes), /路径不安全/)
  } else {
    assert.equal(unpackArchive(bytes)[0].rel, 'CON', '非 Windows 上它是合法名字')
  }
})

test('非法 UTF-8 的文件名必须被拒绝（不能悄悄换成 U+FFFD）', () => {
  // 手工拼一个名字是非法 UTF-8 的条目：0xC3 单独出现不是合法序列
  const name = Buffer.from([0xc3])
  const head = Buffer.alloc(8)
  head.writeUInt16BE(name.length, 0)
  head.writeUInt16BE(0o644, 2)
  head.writeUInt32BE(1, 4)
  const bytes = Buffer.concat([Buffer.from('FKZ1'), (() => {
    const c = Buffer.alloc(4); c.writeUInt32BE(1); return c
  })(), head, name, Buffer.from('x')])
  assert.throws(() => unpackArchive(bytes), /不是合法 UTF-8/)
})

test('坏包不会在磁盘上留下半个树（先全解，再落盘）', async () => {
  const dir = await tempDir()
  const bytes = pack([{ rel: 'ok.txt', data: 'fine' }, { rel: '../bad.txt', data: 'x' }])
  await assert.rejects(() => unpackToDir(bytes, dir), /路径不安全/)
  assert.deepEqual(await readdir(dir), [], '拒绝时一个文件都不该写出来')
})

// ── ③ 真包 + 真 CLI：解开的那份要能跑 ───────────────────

test('⭐ 真源码包：`flicker unpack` 解开之后那份程序能跑起来', { timeout: 180000 }, async () => {
  const { installFromDisk } = await import('../src/assets.js')
  installFromDisk(ROOT)
  const { buildSourcePack } = await import('../src/gift.js')
  const work = await tempDir()
  const pack = await buildSourcePack(ROOT)
  const fkz = path.join(work, 'flicker-test-source.fkz')
  await writeFile(fkz, pack.bytes)

  const r = spawnSync(process.execPath, [CLI, 'unpack', fkz], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(r.status, 0, `解开应当成功：\n${r.stdout}${r.stderr}`)
  const out = path.join(work, 'flicker-test-source')
  assert.ok(existsSync(path.join(out, 'bin', 'flicker.js')), '应当解出 bin/flicker.js')
  assert.ok(existsSync(path.join(out, '中文文档')), '应当解出中文文档目录')

  // 解开的那份**自己就是一份完整源码**：能在源代码树之外跑起来
  const v = spawnSync(process.execPath, [path.join(out, 'bin', 'flicker.js'), '--version'],
    { cwd: work, encoding: 'utf8' })
  assert.equal(v.status, 0, `解开后的源码跑不起来：\n${v.stdout}${v.stderr}`)
  assert.match(v.stdout, /闪传 Flicker/)
})

test('CLI：坏包给出非零退出码与能读懂的错（不是一句 undefined）', { timeout: 60000 }, async () => {
  const work = await tempDir()
  const bad = path.join(work, 'bad.fkz')
  await writeFile(bad, 'this is not an fkz')
  const r = spawnSync(process.execPath, [CLI, 'unpack', bad], { cwd: ROOT, encoding: 'utf8' })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /不是 .fkz|开头不是 FKZ1/)
})

test('CLI：没给文件 → 用法错误（不是静默成功）', () => {
  const r = spawnSync(process.execPath, [CLI, 'unpack'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(r.status, 2, '退出码应当是 USAGE(2)')
  assert.match(r.stderr, /给一个 \.fkz 文件的路径/)
})

test('CLI：解开后重跑同一条命令 → 明确拒绝覆盖（退出码 2）', { timeout: 120000 }, async () => {
  const work = await tempDir()
  const bytes = pack([{ rel: 'a.txt', data: 'x' }])
  const fkz = path.join(work, 'p.fkz')
  await writeFile(fkz, bytes)
  const first = spawnSync(process.execPath, [CLI, 'unpack', fkz, `--dir=${path.join(work, 'out')}`],
    { cwd: ROOT, encoding: 'utf8' })
  assert.equal(first.status, 0, first.stderr)
  const again = spawnSync(process.execPath, [CLI, 'unpack', fkz, `--dir=${path.join(work, 'out')}`],
    { cwd: ROOT, encoding: 'utf8' })
  assert.equal(again.status, 2, '已存在时应当以 USAGE(2) 失败')
  assert.match(again.stderr, /已经存在/)
})

test('解包后的文件哈希与打包前一致（逐字节，不是"看起来一样"）', async () => {
  const work = await tempDir()
  const data = Buffer.from('逐字节比对\n'.repeat(1000))
  const sha = createHash('sha256').update(data).digest('hex')
  const fkz = path.join(work, 'one.fkz')
  await writeFile(fkz, pack([{ rel: 'deep/dir/file.txt', data }]))
  const r = spawnSync(process.execPath, [CLI, 'unpack', fkz, `--dir=${path.join(work, 'o')}`],
    { cwd: ROOT, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const got = await readFile(path.join(work, 'o', 'deep', 'dir', 'file.txt'))
  assert.equal(createHash('sha256').update(got).digest('hex'), sha)
})
