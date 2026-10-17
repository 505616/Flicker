/**
 * 冒烟测试：刚构建出来的单文件产物**真的能跑**吗？
 *
 * 为什么需要它：构建成功 ≠ 产物可用。
 *   SEA 产物最容易出的问题是"构建报成功，运行时立刻崩" ——
 *   入口形态不对（必须 CommonJS）、资源没打进去、
 *   postject 注入的段位置不对，都可能到运行时才暴露。
 *   本机从来只验过 Windows 产物，macOS/Linux 的产物**一次都没跑过**。
 *
 * 选 `--version` 与 `--help` 是有讲究的：它们
 *   · 不生成证书、不碰系统信任库（CI 里不该改系统状态）
 *   · 不起服务、不占端口
 *   · 因此适合在任意平台无副作用地验证"这个二进制是活的、资源是完整的"
 *
 * ── ④ 内嵌资源指纹（2026-10 补）──
 * 前面三项都通过，**也不代表产物是新的**。测试读的是磁盘上的页面，
 * `--version` / `--help` / `--dry-run` 都不看页面内容 —— 所以"改了页面忘了
 * 重新构建"这件事，整套测试 + 冒烟可以一起全绿，而 dist/ 里躺着旧界面。
 * 2026-10 实际漏过一次（旧产物里连 `lang-switch` 都搜不到）。
 * 现在构建时把资源指纹写进产物的 version.json，这里跑 `--assets` 读出来
 * 与磁盘上的文件比对 —— 不一致就是"产物过期"，直接失败并告诉你重新构建。
 *
 * 用法：node gen/smoke-sea.mjs
 */
import { readdirSync, statSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { SOURCE_ASSETS, compareDigests, compareSourcePack, describeMismatch } from './asset-digests.mjs'
import { SOURCE_PACK_ASSET } from '../src/gift.js'
// 临时目录一律走这里：它登记清理 + 删不掉会**报出来**（见 gen/tmp.mjs 顶部的说明）
import { makeTempDir, cleanupTempDirs } from './tmp.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist')

let bad = 0
const fail = (m) => { console.error(`✗ ${m}`); bad++ }

if (!statSync(DIST, { throwIfNoEntry: false })?.isDirectory()) {
  fail('dist/ 不存在 —— 先跑 node gen/build-sea.mjs')
  process.exit(1)
}

// 产物文件名形如 flicker-0.1.0-windows-x64.exe / flicker-0.1.0-linux-x64
const artifacts = readdirSync(DIST).filter((f) => f.startsWith('flicker-'))
if (!artifacts.length) {
  fail('dist/ 里没有 flicker-* 产物')
  process.exit(1)
}

console.log(`发现 ${artifacts.length} 个产物：`)
for (const a of artifacts) {
  const full = path.join(DIST, a)
  console.log(`  ${a}  ${(statSync(full).size / 1024 / 1024).toFixed(1)} MB`)
}

// 只验当前平台的产物（别的平台的跑不了）
const osTag = process.platform === 'win32' ? 'windows' : process.platform
const mine = artifacts.filter((a) => a.includes(`-${osTag}-`))
if (!mine.length) {
  console.log(`\n（本平台是 ${process.platform}，没有对应产物可验 —— 跳过。` +
    '这是正常的：SEA 不支持交叉编译，各平台在自己的 CI 里构建自己的产物。）')
  process.exit(0)
}

/**
 * 把产物复制到**源码树之外**再验。
 *
 * ⚠️ 这一步是整个冒烟里最要紧的一步，而且是 2026-10 才补上的。
 *
 * 从前所有检查都在 `dist/` 里直接跑产物 —— 而 `dist/` 就在源码树里。
 * 于是"产物其实不自包含、运行时靠磁盘上的 src/ 找模块"这个致命的毛病
 * **一次都没被发现**：在源码目录里，那些动态 import 恰好都能解析到旁边的源码。
 * 用户把 exe 复制到桌面双击，才看到控制台一闪而过：
 * `Cannot find module 'C:\Users\…\src\gui.js'`。
 *
 * 所以：**每个产物都先复制到临时目录，再从那里运行**。
 * 这条一旦加上，"离开源码树就跑不起来"这类问题就再也过不了冒烟。
 */
async function copyOutOfTree(a) {
  const dir = makeTempDir('flicker-smoke-')
  const dst = path.join(dir, a)
  copyFileSync(path.join(DIST, a), dst)
  mkdirSync(path.join(dir, 'tosend'), { recursive: true })
  writeFileSync(path.join(dir, 'tosend', 'hello.txt'), 'smoke test\n')
  return { dir, exe: dst, input: path.join(dir, 'tosend') }
}

for (const a of mine) {
  const { dir, exe, input } = await copyOutOfTree(a)
  console.log(`\n验证 ${a}（已复制到源码树之外：${dir}）`)

  // ① --version
  const v = spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: 60000 })
  if (v.status !== 0 && v.status !== null) {
    fail(`--version 退出码 ${v.status}\n  stderr: ${(v.stderr || '').slice(0, 400)}`)
    continue
  }
  const vOut = (v.stdout || '').trim()
  if (!/\d+\.\d+\.\d+/.test(vOut)) {
    fail(`--version 没输出版本号，实际输出: ${JSON.stringify(vOut.slice(0, 120))}`)
  } else {
    console.log(`  ✓ --version → ${vOut.split('\n')[0]}`)
  }

  // ② --help
  const h = spawnSync(exe, ['--help'], { encoding: 'utf8', timeout: 60000 })
  const hOut = (h.stdout || '') + (h.stderr || '')
  if (!hOut.trim()) {
    fail('--help 没有任何输出 —— 产物可能是空的，或资源没打进去')
  } else if (!/flicker|闪传|send|recv/i.test(hOut)) {
    fail(`--help 的输出不像本程序的帮助：${JSON.stringify(hOut.slice(0, 200))}`)
  } else {
    console.log(`  ✓ --help → 输出 ${hOut.length} 字节`)
  }

  // ③ 资源真的在产物里（这是 SEA 最容易出问题的地方）
  //    用 dry-run 扫一个真实目录：它会去读接收端页面与入口资源；
  //    顺带覆盖"扫描 → 清单 → 赠送程序"这一整条链路（那条链用到最多的模块）
  {
    const d = spawnSync(exe, ['send', input, '--dry-run', '--no-color'], {
      encoding: 'utf8', timeout: 120000, cwd: dir,
    })
    const out = (d.stdout || '') + (d.stderr || '')
    if (d.status !== 0) {
      fail(`--dry-run 退出码 ${d.status} —— 产物能启动但跑不动，` +
        `多半是打包进去的资源不完整\n  ${out.slice(0, 500)}`)
    } else if (!/hello\.txt/.test(out)) {
      fail(`--dry-run 没有列出 hello.txt，输出：${out.slice(0, 300)}`)
    } else if (/is not defined|Cannot find module/.test(out)) {
      // 典型的"产物不自包含"症状：模块没打进去，运行时才炸
      fail(`--dry-run 报出了"缺少模块/变量"—— 产物不自包含：\n  ${out.slice(0, 400)}`)
    } else {
      console.log('  ✓ send --dry-run → 资源完整、清单能生成（在源码树之外）')
    }
  }

  // ④ 内嵌资源是不是**当前**这一版（防"改了页面忘了重新构建"）
  //
  // ⚠️ 环境里必须带 FLICKER_NO_BROWSER=1：万一这是个**不认识 --assets 的旧产物**，
  //    它会把 `--assets` 当成未知开关、走到"什么参数都不带 → 打开图形界面"那一路，
  //    于是可能弹出浏览器窗口、并且一直不退出。带上这个变量就不会弹窗，
  //    超时也会被当成"产物太旧"，报错而不是卡住。
  // ⚠️ 变量名不能叫 `a` —— 外层循环就是 `for (const a of mine)`，
  //    同名 `const` 会让上面那句 `path.join(DIST, a)` 落进暂时性死区（实测报错）。
  const assetsRun = spawnSync(exe, ['--assets'], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, FLICKER_NO_BROWSER: '1' },
  })
  const aOut = assetsRun.stdout || ''
  const recorded = {}
  for (const line of aOut.split('\n')) {
    const m = line.trim().match(/^(\S+)\s+([0-9a-f]{16})$/)
    if (m) recorded[m[1]] = m[2]
  }
  if (assetsRun.error?.code === 'ETIMEDOUT' || assetsRun.signal) {
    fail('--assets 没有在 30 秒内退出 —— 这个产物多半不认识 --assets（旧产物），' +
      '请重新构建：node gen/build-sea.mjs')
  } else if (!Object.keys(recorded).length) {
    fail('--assets 没有输出任何可识别的指纹 —— 这个产物是旧的（构建时还没记录指纹），' +
      '请重新构建：node gen/build-sea.mjs\n' +
      `  stdout: ${JSON.stringify(aOut.slice(0, 200))}`)
  } else {
    const missing = SOURCE_ASSETS.filter((rel) => !recorded[rel])
    const bad = compareDigests(recorded)
    // 源码包（赠品）单独比一下：它不是磁盘上的文件，而是现场打出来的
    const packBad = await compareSourcePack(recorded)
    if (packBad) bad.push(packBad)
    if (missing.length || bad.length) {
      fail('产物与源码**对不上** —— 这个二进制里内嵌的东西不是磁盘上现在这一版。\n' +
        (bad.length ? describeMismatch(bad).join('\n') + '\n' : '') +
        (missing.length ? `  产物里没有记录：${missing.join('、')}\n` : '') +
        '  请重新构建：node gen/build-sea.mjs\n' +
        '  （这正是"改了页面/文档忘了重新构建"的样子：测试读磁盘所以全绿，' +
        '而发出去的二进制是旧的）')
    } else {
      const total = SOURCE_ASSETS.length + 1
      console.log(`  ✓ --assets → 内嵌资源与磁盘一致（${total} 项，含赠品源码包）`)
      for (const rel of SOURCE_ASSETS) console.log(`      ${rel}  ${recorded[rel]}`)
      console.log(`      ${SOURCE_PACK_ASSET}  ${recorded[SOURCE_PACK_ASSET]}`)
    }
  }

  // ⑤ 图形界面能不能起来（**用户双击那条路**）
  //
  // 这一条是用户实测反馈"复制到桌面双击，CMD 弹出来一下立刻消失"之后补的。
  // 它是唯一会走到 gui.js / trust.js / run.js 那半个模块图的路径 ——
  // 而那几个模块从前**根本没进产物**（靠磁盘上的源码），在源码目录里跑永远正常。
  //
  // 判据：不带参数启动，12 秒后**仍然活着** = 界面服务起来了。
  // 带 FLICKER_NO_BROWSER=1 以免冒烟脚本弹出浏览器窗口。
  {
    const { spawn } = await import('node:child_process')
    const gui = spawn(exe, [], {
      cwd: dir, env: { ...process.env, FLICKER_NO_BROWSER: '1' },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    let guiOut = ''
    gui.stdout.on('data', (b) => { guiOut += b.toString() })
    gui.stderr.on('data', (b) => { guiOut += b.toString() })
    const exited = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 12000)
      gui.on('exit', () => { clearTimeout(t); resolve(true) })
    })
    if (exited) {
      fail('不带参数启动后**立刻就退出了**（图形界面没起来）—— 这正是用户双击时看到的' +
        '"CMD 弹出来一下立刻消失"。多半是某个模块没打进产物、运行时才炸。\n' +
        guiOut.split('\n').filter((l) => l.trim()).slice(-8).join('\n'))
    } else {
      gui.kill()
      console.log('  ✓ 图形界面能起来（12 秒未退出，源码树之外）')
    }
  }
}

// 收尾：临时目录里放的是 90 MB 的产物副本。
//
// ⚠️ 这一段从前是 `rmSync(..., {force:true})` + 吞异常 —— 而 Windows 上刚 kill 的
//    进程会短暂占着那个 exe，于是**每次都删不掉、每次都留 93 MB**。
//    2026-10 用户看了一眼 %TEMP%，发现 22 份副本、2.1 GB（见 gen/tmp.mjs 顶部）。
//    现在交给 `cleanupTempDirs()`：带重试，删不掉会**明确报出来**并给出清理命令。
const { kept } = cleanupTempDirs()
if (kept.length) {
  fail(`${kept.length} 个临时目录没删掉（里面是产物副本，每个约 90 MB）：\n` +
    kept.map((d) => '    ' + d).join('\n') +
    '\n  可以跑 `node gen/clean-temp.mjs --yes` 清掉')
}

if (bad) {
  console.error(`\n${bad} 项失败 —— 产物不可用`)
  process.exit(1)
}
console.log('\n✓ 产物可用')
