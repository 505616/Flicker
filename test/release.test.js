/**
 * 发布打包脚本（gen/release.mjs）。
 *
 * 为什么这些用例值得写：发布包有两类**不会被立刻发现**的错误 ——
 *
 *   ① **校验值算错**。用户下载 90 MB 的二进制、跑 sha256sum 对不上，
 *      第一反应是"这文件被篡改了"。这种恐慌比"没有校验值"更糟 ——
 *      它让校验这件事本身失去可信度。
 *
 *   ② **缺平台却没说**。SEA 不支持交叉编译，一台机器只能构建自己平台的产物。
 *      如果 RELEASE.md 不明说"本版没有 Linux 产物"，用户会在下载列表里
 *      反复找、以为是自己没看到。
 *
 * 两类都只在"别人下载时"才会暴露，所以必须由测试守住。
 *
 * 用几 KB 的假产物 + 可注入目录，所以这条测试是秒级的
 * （真的构建 SEA 产物要一分多钟，没人愿意跑）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readZipEntries } from '../gen/zip.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = path.join(ROOT, 'gen', 'release.mjs')

const cleanups = []
// try 住同步抛错、也容忍清理函数返回 undefined —— 否则一处异常会让后面的清理全不跑，
// 子进程攥着管道不放，测试进程永不退出（详见 test/relay-e2e.test.js 里的教训记录）。
test.after(async () => {
  for (const fn of cleanups.reverse()) {
    try { await fn() } catch (e) { console.error('清理失败：' + (e?.message ?? e)) }
  }
})

/** 造一个假 dist 目录，放几个指定平台的假产物 */
async function fixture({ version = '9.9.9', platforms = [] } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'flicker-rel-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  for (const [tag, bytes] of platforms) {
    const ext = tag.startsWith('windows') ? '.exe' : ''
    // 内容要各不相同，否则校验值会一样、测不出"逐文件算"
    await writeFile(path.join(dir, `flicker-${version}-${tag}${ext}`),
      Buffer.alloc(bytes, tag.length))
  }
  return dir
}

function runRelease(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

test('发布包：SHA256SUMS 的校验值与产物真实内容一致（原始 + zip 都要有）', async () => {
  const dist = await fixture({ platforms: [['windows-x64', 4096], ['linux-x64', 2048]] })
  const r = runRelease([`--dist=${dist}`, '--version=9.9.9'])
  assert.equal(r.code, 0, r.out)

  const sums = await readFile(path.join(dist, 'release', 'SHA256SUMS'), 'utf8')
  const lines = sums.trim().split('\n')
  // 每个产物两行：原始文件 + 它的 zip。用户**能下载到的每一个文件**都要有校验值。
  assert.equal(lines.length, 4, `应有 4 行（2 个产物 × 2 种形态），实际 ${lines.length}\n${sums}`)

  for (const line of lines) {
    const m = line.match(/^([0-9a-f]{64})  (.+)$/)
    assert.ok(m, `行格式不符合 coreutils 约定（64 位十六进制 + 两个空格 + 文件名）：${line}`)
    const [, want, name] = m

    // 与 release/ 里那份比对（用户下载的就是它）
    const copied = await readFile(path.join(dist, 'release', name))
    assert.equal(sha256(copied), want,
      `${name} 的校验值算错了 —— 用户下载后 sha256sum 会对不上，` +
      '会误以为文件被篡改')
  }
})

test('发布包：两个不同内容的产物不会得到同一个校验值', async () => {
  // 防"算了一次就复用"这类实现错误
  const dist = await fixture({ platforms: [['windows-x64', 4096], ['linux-x64', 2048]] })
  runRelease([`--dist=${dist}`, '--version=9.9.9'])
  const sums = await readFile(path.join(dist, 'release', 'SHA256SUMS'), 'utf8')
  const rows = sums.trim().split('\n')
  // 顺序是 [原始, zip, 原始, zip]，所以两个**原始**产物在第 0、2 行
  assert.notEqual(rows[0].slice(0, 64), rows[2].slice(0, 64),
    '内容不同的两个产物得到了相同的校验值 —— 说明只算了一个文件')
})

test('⭐ 发布包：每个产物都配一个 zip，且 zip 里装的确实是它（省下载量靠这个）', async () => {
  const dist = await fixture({ platforms: [['windows-x64', 4096], ['linux-x64', 2048]] })
  runRelease([`--dist=${dist}`, '--version=9.9.9'])

  for (const [tag, bytes] of [['windows-x64', 4096], ['linux-x64', 2048]]) {
    const ext = tag.startsWith('windows') ? '.exe' : ''
    const name = `flicker-9.9.9-${tag}${ext}`
    const zipPath = path.join(dist, 'release', `${name}.zip`)
    const buf = await readFile(zipPath)
    const entries = readZipEntries(buf)
    assert.equal(entries.length, 1, `${name}.zip 应当只有一个条目`)
    assert.equal(entries[0].name, name, `zip 里的条目名应当是 ${name}`)
    assert.deepEqual(Buffer.compare(entries[0].data, await readFile(path.join(dist, name))), 0,
      `${name}.zip 里装的不是 dist/ 里那一版产物`)
  }
})

test('发布包：RELEASE.md 的"大小"是**下载大小**（zip），并说明原始文件也在', async () => {
  const dist = await fixture({ platforms: [['windows-x64', 4096]] })
  runRelease([`--dist=${dist}`, '--version=9.9.9'])
  const rel = await readFile(path.join(dist, 'release', 'RELEASE.md'), 'utf8')

  // 下载表里给的是 zip 名，不是原始文件名（那才是用户要点的那个）
  assert.match(rel, /\|\s*Windows x64\s*\|\s*`flicker-9\.9\.9-windows-x64\.exe\.zip`\s*\|/,
    '下载表里应当给 zip（推荐下载），否则"少下 62%"这条没人看得到')
  // 不想解压的人也得有路可走，而且要写清代价
  assert.match(rel, /不想解压/, '要说明原始文件也在（不然只想直接跑的人会以为必须解压）')
  assert.match(rel, /flicker-9\.9\.9-windows-x64\.exe`（/, '要列出原始文件名和它的大小')
  // 必须讲清"压得掉、减不掉"——否则用户会以为我们在藏一个更小的产物
  assert.match(rel, /Node 运行时/, '要解释为什么"减小体积"没有空间、只有压缩下载量')
})

test('⭐ 发布包：缺哪些平台必须明确写出来（不能让人以为齐了）', async () => {
  // 只给 Windows —— 这是最常见的真实情况（在一台 Windows 机器上打包）
  const dist = await fixture({ platforms: [['windows-x64', 4096]] })
  const r = runRelease([`--dist=${dist}`, '--version=9.9.9'])
  assert.equal(r.code, 0, r.out)

  const rel = await readFile(path.join(dist, 'release', 'RELEASE.md'), 'utf8')
  for (const want of ['Linux x64', 'macOS x64', 'macOS arm64']) {
    assert.match(rel, new RegExp(want),
      `RELEASE.md 必须写明本版缺少 ${want} 产物 —— ` +
      '否则用户会在下载列表里反复找，以为是自己没看到')
  }
  assert.match(rel, /不支持交叉编译/, '要解释**为什么**缺，否则像是漏了')
})

test('发布包：Windows 产物标"已实测"，其他平台标"未在真机验证"', async () => {
  const dist = await fixture({ platforms: [['windows-x64', 4096], ['linux-x64', 2048]] })
  runRelease([`--dist=${dist}`, '--version=9.9.9'])
  const rel = await readFile(path.join(dist, 'release', 'RELEASE.md'), 'utf8')

  // 表格行：| Windows x64 | `文件` | 大小 | 已实测 |
  assert.match(rel, /\|\s*Windows x64\s*\|[^|]*\|\s*[\d.]+ [KMG]B\s*\|\s*已实测\s*\|/)
  assert.match(rel, /\|\s*Linux x64\s*\|[^|]*\|[^|]*\|\s*\*\*未在真机验证\*\*\s*\|/,
    '非 Windows 平台必须标"未在真机验证" —— 这是这个项目最需要如实说明的一点')
})

test('发布包：RELEASE.md 必须带上已知限制（不能只写好消息）', async () => {
  const dist = await fixture({ platforms: [['windows-x64', 4096]] })
  runRelease([`--dist=${dist}`, '--version=9.9.9'])
  const rel = await readFile(path.join(dist, 'release', 'RELEASE.md'), 'utf8')

  // 用关键词而不是整句原文，这样改措辞时测试不会误报
  const must = [
    [/中继.*密文|密文.*中继/, '中继会经手数据（但只有密文）'],
    [/Firefox|Safari/, 'Firefox/Safari 收大文件可能失败'],
    [/续传|关.*页面|第 N 字节/, '关掉页面无法续传'],
    [/弱密码|PBKDF2/, '弱密码的风险'],
    [/SECURITY\.md/, '指向完整威胁模型'],
  ]
  for (const [re, what] of must) {
    assert.match(rel, re, `RELEASE.md 缺少这条已知限制：${what}`)
  }
})

test('发布包：--check 不生成任何文件', async () => {
  const dist = await fixture({ platforms: [['windows-x64', 4096]] })
  const r = runRelease([`--dist=${dist}`, '--version=9.9.9', '--check'])
  assert.equal(r.code, 0, r.out)
  const entries = await readdir(dist)
  assert.ok(!entries.includes('release'),
    '--check 只该检查，不该在 dist 里留下 release/ 目录')
  // 还没生成发布包时不算失败（"刚构建完先看看缺哪些平台"是合法用法），
  // 但必须明确说出来，免得有人以为"检查通过 = 发布包是好的"
  assert.match(r.out, /还没有生成发布包|不存在/,
    'release/ 不存在时要明确提示，不能默默通过')
})

// ── 发布包自检（--check 要能发现 release/ 里的副本过期）────────────
//
// 这一组守的是一种**看起来一切正常**的错误：dist/ 里的产物重建了，
// 而 release/ 里还是上一轮的旧副本（同名、不同内容）。此时只看 dist/ 的检查
// 会报出新哈希，一切"正常"；而真正会被传上去的是那份旧副本。
// 2026-10 出现过两次，都是靠手工比对哈希才发现的。

test('⭐ 发布包自检：一致时通过', async () => {
  const dist = await fixture({ platforms: [['windows-x64', 4096], ['linux-x64', 2048]] })
  runRelease([`--dist=${dist}`, '--version=9.9.9'])
  const r = runRelease([`--dist=${dist}`, '--version=9.9.9', '--check'])
  assert.equal(r.code, 0, `刚生成的发布包应当自检通过：\n${r.out}`)
  assert.match(r.out, /发布包与 dist\/ 一致/)
})

test('⭐ 发布包自检：release/ 里是旧副本必须失败（这是最危险的那种）', async () => {
  const dist = await fixture({ platforms: [['windows-x64', 4096]] })
  runRelease([`--dist=${dist}`, '--version=9.9.9'])

  // 模拟真实场景：dist/ 里的产物重建了（内容变了），release/ 里的副本没跟着更新
  await writeFile(path.join(dist, 'flicker-9.9.9-windows-x64.exe'), Buffer.alloc(4096, 42))

  const r = runRelease([`--dist=${dist}`, '--version=9.9.9', '--check'])
  assert.notEqual(r.code, 0, '副本与产物内容不一致时必须失败 —— ' +
    '否则会把旧的那一个发出去，而检查看起来一切正常')
  assert.match(r.out, /flicker-9\.9\.9-windows-x64\.exe/, '要点出是哪个文件')
  assert.match(r.out, /旧副本|dist\//, '要说清哪边是新、哪边是旧')
  assert.match(r.out, /gen\/release\.mjs/, '要给出修复命令')
})

test('⭐ 发布包自检：SHA256SUMS 与实际内容对不上必须失败', async () => {
  const dist = await fixture({ platforms: [['windows-x64', 4096]] })
  runRelease([`--dist=${dist}`, '--version=9.9.9'])

  // 手改校验值（比如复制粘贴时改错了一位）
  const sumsPath = path.join(dist, 'release', 'SHA256SUMS')
  const sums = await readFile(sumsPath, 'utf8')
  await writeFile(sumsPath, sums.replace(/^[0-9a-f]{64}/, 'f'.repeat(64)))

  const r = runRelease([`--dist=${dist}`, '--version=9.9.9', '--check'])
  assert.notEqual(r.code, 0, '校验值算错必须失败')
  assert.match(r.out, /清单里写的|校验值算错/, '要说明是校验值的问题')
})

test('⭐ 发布包自检：release/ 里混进别的产物必须失败', async () => {
  const dist = await fixture({ platforms: [['windows-x64', 4096]] })
  runRelease([`--dist=${dist}`, '--version=9.9.9'])

  // 上一版剩下的产物、或者手工塞进来的东西 —— `dist/release/*` 会连它一起传上去
  await writeFile(path.join(dist, 'release', 'flicker-0.0.1-linux-x64'), Buffer.alloc(64, 1))

  const r = runRelease([`--dist=${dist}`, '--version=9.9.9', '--check'])
  assert.notEqual(r.code, 0, 'release/ 里有不属于本版的产物时必须失败')
  assert.match(r.out, /flicker-0\.0\.1-linux-x64/, '要点出是哪个多余的文件')
})

test('发布包：没有本版产物时明确失败，而不是生成一个空发布', async () => {
  const dist = await fixture({ platforms: [] })     // 空目录
  const r = runRelease([`--dist=${dist}`, '--version=9.9.9'])
  assert.notEqual(r.code, 0, '没有产物时必须失败 —— 生成空发布比不生成更糟')
  assert.match(r.out, /没有找到|build-sea/, '错误信息要告诉人下一步该做什么')
})

test('发布包：版本号从 package.json 取（不写死）', async () => {
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'))
  const dist = await fixture({ version: pkg.version, platforms: [['windows-x64', 4096]] })
  const r = runRelease([`--dist=${dist}`])            // 不传 --version
  assert.equal(r.code, 0, r.out)
  const sums = await readFile(path.join(dist, 'release', 'SHA256SUMS'), 'utf8')
  assert.match(sums, new RegExp(`flicker-${pkg.version.replace(/\./g, '\\.')}-windows-x64\\.exe`),
    '默认应使用 package.json 里的版本号')
})

test('发布包：--version 覆盖有效（用于打补丁版本）', async () => {
  const dist = await fixture({ version: '1.2.3', platforms: [['windows-x64', 4096]] })
  const r = runRelease([`--dist=${dist}`, '--version=1.2.3'])
  assert.equal(r.code, 0, r.out)
  const rel = await readFile(path.join(dist, 'release', 'RELEASE.md'), 'utf8')
  assert.match(rel, /v1\.2\.3/, '标题里应出现版本号')
  assert.match(rel, /flicker-1\.2\.3-windows-x64\.exe/, '文件名里也应出现')
})

test('⭐ 发布包自检：zip 是旧产物打的必须失败', async () => {
  const dist = await fixture({ platforms: [['windows-x64', 4096]] })
  runRelease([`--dist=${dist}`, '--version=9.9.9'])

  // dist/ 里的产物重建了，zip 还是上一轮的 —— 用户下载解压后拿到的是旧程序。
  // ⚠️ 只比 zip 自己的哈希发现不了这件事（zip 确实没被改过），
  //    所以判据必须**解开 zip 比里面的内容**。
  await writeFile(path.join(dist, 'flicker-9.9.9-windows-x64.exe'), Buffer.alloc(4096, 42))

  const r = runRelease([`--dist=${dist}`, '--version=9.9.9', '--check'])
  assert.notEqual(r.code, 0, 'zip 里装的是旧产物时必须失败')
  assert.match(r.out, /\.zip/, '要点出是哪个 zip')
  assert.match(r.out, /旧产物|不是这一版/, '要说清 zip 里装的不是这一版')
})

test('⭐ 发布包自检：zip 坏了必须失败（用户会以为是我们发坏了文件）', async () => {
  const dist = await fixture({ platforms: [['windows-x64', 4096]] })
  runRelease([`--dist=${dist}`, '--version=9.9.9'])

  const zipPath = path.join(dist, 'release', 'flicker-9.9.9-windows-x64.exe.zip')
  const buf = await readFile(zipPath)
  buf[buf.length - 40] ^= 0xff                 // 破坏中央目录/EOCD 附近的字节
  await writeFile(zipPath, buf)

  const r = runRelease([`--dist=${dist}`, '--version=9.9.9', '--check'])
  assert.notEqual(r.code, 0, '压缩包坏掉必须失败 —— 否则会发出去一个解不开的包')
})

test('⭐ 发布包自检：release/ 里少了 zip 必须失败', async () => {
  const dist = await fixture({ platforms: [['windows-x64', 4096]] })
  runRelease([`--dist=${dist}`, '--version=9.9.9'])
  await rm(path.join(dist, 'release', 'flicker-9.9.9-windows-x64.exe.zip'))

  const r = runRelease([`--dist=${dist}`, '--version=9.9.9', '--check'])
  assert.notEqual(r.code, 0, '缺 zip 时必须失败')
  assert.match(r.out, /zip 不存在|不存在/, '要说清缺了什么')
})

test('发布包：产物被复制进 release/（不是只写清单）', async () => {
  const dist = await fixture({ platforms: [['windows-x64', 4096]] })
  runRelease([`--dist=${dist}`, '--version=9.9.9'])
  const entries = await readdir(path.join(dist, 'release'))
  assert.ok(entries.includes('flicker-9.9.9-windows-x64.exe'), '产物本身也要在里面')
  assert.ok(entries.includes('flicker-9.9.9-windows-x64.exe.zip'), 'zip 也要在里面')
  assert.ok(entries.includes('SHA256SUMS'))
  assert.ok(entries.includes('RELEASE.md'))

  // 大小要一致（防止复制截断）
  const a = await stat(path.join(dist, 'flicker-9.9.9-windows-x64.exe'))
  const b = await stat(path.join(dist, 'release', 'flicker-9.9.9-windows-x64.exe'))
  assert.equal(a.size, b.size, '复制后的产物大小应与原件相同')
})

test('发布包：给出下一步的确切命令（不然发版还得现查）', async () => {
  const dist = await fixture({ platforms: [['windows-x64', 4096]] })
  const r = runRelease([`--dist=${dist}`, '--version=9.9.9'])
  assert.match(r.out, /gh release create v9\.9\.9/,
    '输出里应给出可以直接复制的 gh 命令')
  assert.match(r.out, /--notes-file/, '要指向生成的 RELEASE.md')
})

test('发布包：中文与路径里的空格不影响生成', async () => {
  // 带空格的目录名是最常见的踩坑点
  const base = await mkdtemp(path.join(tmpdir(), 'flicker-rel-space-'))
  cleanups.push(() => rm(base, { recursive: true, force: true }))
  const dist = path.join(base, '假 产物 目录')
  await mkdir(dist, { recursive: true })
  await writeFile(path.join(dist, 'flicker-9.9.9-windows-x64.exe'), Buffer.alloc(512, 7))

  const r = runRelease([`--dist=${dist}`, '--version=9.9.9'])
  assert.equal(r.code, 0, `带空格/中文的路径应当正常工作：\n${r.out}`)
  const sums = await readFile(path.join(dist, 'release', 'SHA256SUMS'), 'utf8')
  assert.match(sums, /flicker-9\.9\.9-windows-x64\.exe/)
})
