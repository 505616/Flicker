/**
 * "产物里的页面是不是最新的"这条判据本身的测试
 * ==============================================
 *
 * 背景（2026-10 真踩过）：SEA 产物把 `web/*.html` 打包进一个 89 MB 的可执行文件，
 * 而构建脚本不会因为你改了页面就自动重跑。于是 `dist/` 里那个二进制是好几天前的
 * 界面（连 `lang-switch` 都搜不到），而 **390 个用例 + 冒烟全绿** ——
 * 因为测试读的是磁盘上的页面，冒烟也不看页面内容。
 *
 * 修法是：构建时把资源指纹写进产物，冒烟时读出来和磁盘比。
 * 那么这条判据自己会不会失灵？会 —— 比如"比对的清单和记录的清单不是同一份"，
 * 那就会永远对得上。所以这里既测比对逻辑，也测"两处接线是同一份清单"。
 *
 * 2026-10 又补了**第二次**：赠品里的 `source-pack.fkz`（源码 + 全部文档）
 * 同样是构建时冻进产物的，改了文档不重建 → 对方收到旧文档。
 * 它不是磁盘上的文件，而是由整棵树算出来的，所以"现在该是多少"要现场打一份包。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ASSET, assetFingerprint } from '../src/assets.js'
import { SOURCE_PACK_ASSET } from '../src/gift.js'
import {
  SOURCE_ASSETS, digestAll, compareDigests, describeMismatch,
  digestOfSourcePack, compareSourcePack,
} from '../gen/asset-digests.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const cleanups = []
test.after(async () => {
  for (const fn of cleanups.reverse()) {
    try { await fn() } catch (e) { console.error('清理失败：' + (e?.message ?? e)) }
  }
})

test('指纹清单只有一份来源：就是运行时按名字读的那几个资源', () => {
  // 如果构建记的是 A 清单、冒烟查的是 B 清单，判据就会"永远对得上"
  assert.deepEqual([...SOURCE_ASSETS].sort(), Object.values(ASSET).sort())
  assert.ok(SOURCE_ASSETS.includes(ASSET.RECEIVER_HTML), '接收端页面必须在内')
  assert.ok(SOURCE_ASSETS.includes(ASSET.STATION_HTML), '站点页必须在内')
})

test('指纹是内容的函数：同样内容同值，改一个字节就变', () => {
  assert.equal(assetFingerprint('abc'), assetFingerprint(Buffer.from('abc', 'utf8')),
    '用字符串算和用字节算必须一致 —— 否则"源码模式现算"与"构建期记录"会对不上')
  assert.match(assetFingerprint('abc'), /^[0-9a-f]{16}$/)
  assert.notEqual(assetFingerprint('abc'), assetFingerprint('abd'))
})

test('⭐ 比对能发现"页面改了但产物没重建"', async () => {
  // 用假的根目录跑：不必真的构建 90 MB 产物
  const dir = await mkdtemp(path.join(tmpdir(), 'flicker-digest-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  await mkdir(path.join(dir, 'web'), { recursive: true })
  for (const rel of SOURCE_ASSETS) {
    await writeFile(path.join(dir, rel), '原始内容 ' + rel + '\n')
  }

  const recorded = digestAll(dir)
  assert.deepEqual(compareDigests(recorded, dir), [], '没改过就应该一致')

  // 改一个页面 —— 正是"改了 web/station.html 但没重新构建"的情形
  await writeFile(path.join(dir, ASSET.STATION_HTML), '改过了\n')
  const bad = compareDigests(recorded, dir)
  assert.equal(bad.length, 1, `应当只报出被改的那个（实际 ${bad.length} 个）`)
  assert.equal(bad[0].rel, ASSET.STATION_HTML)
  assert.equal(bad[0].was, recorded[ASSET.STATION_HTML])
  assert.notEqual(bad[0].now, bad[0].was)
  assert.match(describeMismatch(bad).join('\n'), /产物里内嵌的是旧版/,
    '报错要说人话，直接点出"产物是旧的"')
})

test('⭐ 产物"根本没记录指纹"也必须算不一致（旧产物就是这种）', () => {
  // 这条防的是"升级后忘了重建"：旧产物没有 assets 字段，
  // 如果比对方把它当成"没得比 → 跳过"，那这条判据对旧产物就永远沉默。
  const missing = compareDigests(null)
  assert.equal(missing.length, SOURCE_ASSETS.length, '每一项都要报"没有记录"')
  assert.ok(missing.every((m) => m.was === null))
  assert.match(describeMismatch(missing).join('\n'), /产物里没有记录/)
})

test('⭐ 比对能发现"源码包改了但产物没重建"（赠品里的文档就是这个坑）', async () => {
  // 源码包和页面是同一类东西：构建时冻进产物、测试读磁盘所以全绿。
  // 它装的正是源码 + 全部文档（用户要求赠品带文档），过期了对方就收到旧文档。
  const now = await digestOfSourcePack()

  // ① 产物里没记这一项（这次加指纹之前构建的产物）
  const missing = await compareSourcePack({}, root)
  assert.ok(missing, '没记录就必须报出来 —— 否则这条判据对旧产物永远沉默')
  assert.equal(missing.rel, SOURCE_PACK_ASSET)
  assert.equal(missing.was, null)
  assert.equal(missing.now, now)
  assert.match(describeMismatch([missing]).join('\n'), /产物里没有记录/)

  // ② 记的是一个"改了文档之后没重建"的旧指纹
  const stale = await compareSourcePack({ [SOURCE_PACK_ASSET]: 'deadbeefdeadbeef' }, root)
  assert.ok(stale, '指纹对不上就必须报出来')
  assert.match(stale.why, /旧版/, '要说清楚是"产物里内嵌的是旧版"')

  // ③ 记的就是现在这一份 → 一致
  assert.equal(await compareSourcePack({ [SOURCE_PACK_ASSET]: now }, root), null)
})

test('⭐ 构建与冒烟接的是同一份指纹（不许只写一半）', () => {
  // 为什么用源码断言而不是真构建：真构建一次要一两分钟、还会往 dist/ 写 90 MB，
  // 不适合放进每次 npm test。所以这里钉住"两条线都接上了"：
  //   构建要**写**指纹进 version.json，冒烟要**读**出来比对。
  // 判据本身的行为已经在上面两条里测过了。
  const build = readFileSync(path.join(root, 'gen', 'build-sea.mjs'), 'utf8')
  assert.match(build, /import \{[^}]*digestAll[^}]*\} from '\.\/asset-digests\.mjs'/,
    '构建脚本要从共享模块取指纹')
  assert.match(build, /JSON\.stringify\(\{ version: pkg\.version, assets: assetDigests \}\)/,
    'version.json 里必须带上 assets —— 不带就等于没记录，冒烟会判为不一致')
  assert.ok(!/new Date\(\)|Date\.now\(\)/.test(build.split('version.json')[0].split('assetDigests')[1] ?? ''),
    'version.json 里不许出现时间戳：同样的源码必须产出同样的二进制（可复现构建）')
  assert.match(build, /const ASSETS = SOURCE_ASSETS/,
    '构建脚本不许自己另抄一份资源清单（抄一份就会漂移）')
  assert.match(build, /assetDigests\[embeddedSourcePack\] = assetFingerprint\(packBytes\)/,
    '源码包的指纹也必须记进 version.json —— 不记就等于没这条判据')

  const smoke = readFileSync(path.join(root, 'gen', 'smoke-sea.mjs'), 'utf8')
  assert.match(smoke, /compareDigests\(recorded\)/, '冒烟必须真的比对')
  assert.match(smoke, /await compareSourcePack\(recorded\)/,
    '冒烟也必须比对源码包（赠品里的文档过期同样要拦下来）')
  assert.match(smoke, /FLICKER_NO_BROWSER: '1'/,
    '跑 --assets 时要禁掉浏览器：旧产物不认识这个开关，会走到"打开图形界面"那一路')
  assert.match(smoke, /请重新构建：node gen\/build-sea\.mjs/,
    '报错要直接给出修复命令')
})

test('bin/flicker.js --assets 在源码模式下给出与磁盘一致的指纹', async () => {
  // 源码模式下没有 version.json，程序现算 —— 那就必须与磁盘上的文件逐项一致
  const r = spawnSync(process.execPath, [path.join(root, 'bin', 'flicker.js'), '--assets'], {
    encoding: 'utf8', timeout: 60000,
    env: { ...process.env, FLICKER_NO_BROWSER: '1' },
  })
  assert.equal(r.status, 0, `--assets 退出码 ${r.status}\n${r.stderr}`)

  const got = {}
  for (const line of r.stdout.split('\n')) {
    const m = line.trim().match(/^(\S+)\s+([0-9a-f]{16})$/)
    if (m) got[m[1]] = m[2]
  }
  assert.deepEqual(got, { ...digestAll(), [SOURCE_PACK_ASSET]: await digestOfSourcePack() },
    '--assets 的输出必须与磁盘上现算的指纹一致（源码包是现场打出来的那一份）')

  // 帮助里要看得见（否则没人知道有这条自检）
  const h = spawnSync(process.execPath, [path.join(root, 'bin', 'flicker.js'), '--help'], {
    encoding: 'utf8', timeout: 60000,
  })
  assert.match(h.stdout, /--assets/, '--help 里要提到 --assets')
})
