/**
 * 发布打包：把 dist/ 里的产物整理成一个可以直接发布的版本。
 *
 * 产出（都在 dist/release/ 下）：
 *   · flicker-<版本>-<平台>…        —— 原样复制的产物
 *   · SHA256SUMS                    —— 校验值，供下载者核对
 *   · RELEASE.md                    —— Release 说明（含校验值、安装、已知限制）
 *
 * ── 为什么要有这个脚本，而不是发版时手搓 ──────────────────────
 *
 * ① **校验值不是可选项。** 这个程序的产物有 90 MB、没人会去读它的源码，
 *    那么"下载到的这个二进制确实来自这份源码"就只能靠校验值 + 可复现构建。
 *    手搓时最容易忘的就是它。
 *
 * ② **"缺哪些平台"必须被明确说出来。** SEA **不支持交叉编译** ——
 *    每个平台的产物必须在该平台上构建。所以在一台 Windows 机器上跑这个脚本，
 *    只能产出 Windows 产物。本脚本会把"这一版包含哪些平台、缺哪些平台"
 *    直接写进 RELEASE.md，而不是让人以为三平台都齐了。
 *
 * ③ Release 说明里必须**如实**带上已知限制。这个项目最怕的就是
 *    用户以为"端到端加密"等于"什么都防" —— 限制要跟着产物一起发布。
 *
 * 用法：
 *   node gen/release.mjs                  # 整理 dist/ 里已有的产物
 *   node gen/release.mjs --version=0.2.0  # 覆盖版本号（默认取 package.json）
 *   node gen/release.mjs --notes=extra.md # 把额外内容追加进 RELEASE.md
 *   node gen/release.mjs --check          # 只检查产物齐不齐，不生成文件
 *   node gen/release.mjs --dist=路径 --out=路径   # 换目录（测试用）
 */
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeZip, readZipEntries } from './zip.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const argv = process.argv.slice(2)
const argOf = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : undefined
}

// --dist / --out 是为了**可测试**：测试里塞几个几 KB 的假产物就能验全部逻辑，
// 不必真的构建 90 MB 的 SEA 产物（那样这条测试要跑一分多钟，没人愿意跑）。
const DIST = argOf('dist') ? path.resolve(argOf('dist')) : path.join(ROOT, 'dist')
const OUT = argOf('out') ? path.resolve(argOf('out')) : path.join(DIST, 'release')

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const version = argOf('version') ?? pkg.version
const checkOnly = argv.includes('--check')

/** 三个受支持的平台，以及它们的产物名特征 */
const PLATFORMS = [
  { tag: 'windows-x64', label: 'Windows x64', ext: '.exe', os: 'win32' },
  { tag: 'linux-x64', label: 'Linux x64', ext: '', os: 'linux' },
  { tag: 'darwin-x64', label: 'macOS x64', ext: '', os: 'darwin' },
  { tag: 'darwin-arm64', label: 'macOS arm64', ext: '', os: 'darwin' },
]

const human = (n) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/**
 * 发布包里给每个产物配一个 zip。
 *
 * ── 为什么发 zip ──
 * 产物 94 MB，其中 **89.2 MB 是 Node 运行时本身**（去不掉），我们自己的内容只有 4.6 MB。
 * 所以"减小体积"没有空间，**压缩下载量**才有：zip 之后 35.8 MB，省 62%。
 * `.gz` 也能到这个数，但 Windows 用户**双击打不开 `.gz`**，而 `.zip` 双击就能解压。
 *
 * 原始产物**照样发**（不想解压的人直接下），zip 是"推荐下载"那一个。
 */
const zipName = (name) => `${name}.zip`

if (!existsSync(DIST)) {
  console.error('✗ dist/ 不存在 —— 先跑 node gen/build-sea.mjs')
  process.exit(1)
}

// ── 收集产物 ────────────────────────────────────────────────
const artifacts = readdirSync(DIST)
  .filter((f) => f.startsWith(`flicker-${version}-`) && statSync(path.join(DIST, f)).isFile())
  .sort()

console.log(`版本 ${version}`)
console.log(`dist/ 里找到 ${artifacts.length} 个本版产物：\n`)

const found = []
for (const a of artifacts) {
  const full = path.join(DIST, a)
  const size = statSync(full).size
  const digest = sha256(readFileSync(full))
  // 从文件名反推平台
  const plat = PLATFORMS.find((p) => a.includes(`-${p.tag}${p.ext}`))
  found.push({ name: a, size, digest, platform: plat ?? null })
  console.log(`  ${a}`)
  console.log(`    ${human(size).padStart(9)}   sha256 ${digest.slice(0, 16)}…`)
}

const missing = PLATFORMS.filter((p) => !found.some((f) => f.platform?.tag === p.tag))

if (!found.length) {
  console.error(`\n✗ 没有找到 flicker-${version}-* 产物。` +
    '\n  先跑 node gen/build-sea.mjs（注意：SEA 不支持交叉编译，' +
    '每个平台必须在该平台上构建）。')
  process.exit(1)
}

if (missing.length) {
  console.log(`\n⚠️  本版缺少这些平台的产物：${missing.map((m) => m.label).join('、')}`)
  console.log('   这是正常的：SEA **不支持交叉编译**，每个平台必须在该平台上构建。')
  console.log('   CI 的矩阵会各自产出自己平台的产物（见 .github/workflows/ci.yml）。')
}

if (checkOnly) {
  // ── 发布包自检 ──────────────────────────────────────────────
  //
  // 为什么 --check 不能只报 dist/ 里的产物哈希：**发布的是 release/ 里那份副本**。
  // 2026-10 出现过两次这样的中间状态：dist/ 里的产物已经重建了，而 release/ 里
  // 还是上一轮的旧副本（名字一样、内容不同）—— 此时 `--check` 只看 dist/，
  // 报出来的是新哈希，看起来一切正常；而真正会被传上去的是旧副本。
  // 手工比对哈希才发现得了，所以这里补上。
  //
  // ⚠️ release/ **不存在**时不算失败：合法用法之一是"刚在 dist/ 里构建完，
  //    先看看缺哪些平台产物"，那时还没生成发布包。只提示一句，别把正常流程卡住。
  const problems = []
  if (!existsSync(OUT)) {
    console.log(`\n⚠️  还没有生成发布包（${path.relative(ROOT, OUT).replace(/\\/g, '/')}/ 不存在）——` +
      '\n   上面只检查了 dist/。要发布请跑：node gen/release.mjs')
    console.log('\n（--check：只检查，未生成文件）')
    process.exit(0)
  }

  const outRel = path.relative(ROOT, OUT).replace(/\\/g, '/') + '/'

  // ① 每个产物都要有一份**内容一致**的副本
  for (const f of found) {
    const copyPath = path.join(OUT, f.name)
    if (!existsSync(copyPath)) {
      problems.push(`  ${f.name}\n      副本不存在：${outRel}${f.name}\n` +
        '      发布时用的是 release/ 里的副本，不是一个都不发就是发错的')
      continue
    }
    const copyDigest = sha256(readFileSync(copyPath))
    if (copyDigest !== f.digest) {
      problems.push(`  ${f.name}\n` +
        `      dist/：   ${f.digest.slice(0, 16)}\n` +
        `      副本：    ${copyDigest.slice(0, 16)}   ← 旧副本\n` +
        '      产物重建后忘了重跑 gen/release.mjs —— 会发出去旧的那一个')
    }
  }

  // ①b 每个产物的 zip 必须在，而且**里面装的确实是这一版产物**。
  //     只比 zip 自己的哈希只能证明"zip 没被改过"，证明不了它装的是对的东西 ——
  //     所以这里解开 zip、逐字节算哈希，与 dist/ 的哈希比。
  const zipDigests = new Map()
  for (const f of found) {
    const zName = zipName(f.name)
    const zPath = path.join(OUT, zName)
    if (!existsSync(zPath)) {
      problems.push(`  ${zName} 不存在（${outRel}${zName}）\n` +
        '      zip 是推荐的下载方式，缺了它"少下 62%"这条承诺就不成立')
      continue
    }
    const zipBuf = readFileSync(zPath)
    zipDigests.set(zName, sha256(zipBuf))
    try {
      const entries = readZipEntries(zipBuf)
      if (entries.length !== 1) {
        problems.push(`  ${zName} 里有 ${entries.length} 个条目，应当只有 1 个（${f.name}）`)
        continue
      }
      const inner = entries[0]
      if (inner.name !== f.name) {
        problems.push(`  ${zName} 里装的是 ${inner.name}，应当装 ${f.name}`)
        continue
      }
      const innerDigest = sha256(inner.data)
      if (innerDigest !== f.digest) {
        problems.push(`  ${zName}\n` +
          `      里面装的：  ${innerDigest.slice(0, 16)}\n` +
          `      dist/ 里的：${f.digest.slice(0, 16)}   ← zip 是旧产物打的\n` +
          '      用户下载解压后拿到的不是这一版的产物')
      }
    } catch (e) {
      problems.push(`  ${zName} 解不开：${e?.message ?? e}\n` +
        '      压缩包坏了，用户会以为是我们发坏了文件')
    }
  }

  // ② SHA256SUMS 必须存在，且与 release/ 里的实际文件逐项对得上
  //
  // ⚠️ 期望的清单是"原始产物 + 它们的 zip"：**用户能下载到的每一个文件都要有校验值**。
  const expected = new Map()                        // 文件名 → 期望哈希
  for (const f of found) {
    expected.set(f.name, f.digest)
    const zName = zipName(f.name)
    if (zipDigests.has(zName)) expected.set(zName, zipDigests.get(zName))
  }
  const sumsPath = path.join(OUT, 'SHA256SUMS')
  if (!existsSync(sumsPath)) {
    problems.push(`  SHA256SUMS 不存在（${outRel}SHA256SUMS）\n` +
      '      没有校验值，下载的人就无法核对产物是不是这份源码构建的')
  } else {
    const listed = new Map()
    for (const line of readFileSync(sumsPath, 'utf8').split('\n')) {
      const m = line.match(/^([0-9a-f]{64})  (.+)$/)
      if (m) listed.set(m[2], m[1])
    }
    for (const [name, want] of expected) {
      const got = listed.get(name)
      if (!got) {
        problems.push(`  SHA256SUMS 里没有 ${name}`)
      } else if (got !== want) {
        problems.push(`  ${name}\n` +
          `      清单里写的：${got.slice(0, 16)}\n` +
          `      实际内容：  ${want.slice(0, 16)}\n` +
          '      校验值算错比没有校验值更糟：用户跑 sha256sum 对不上，' +
          '会以为文件被篡改')
      }
    }
    for (const name of listed.keys()) {
      if (!expected.has(name)) {
        problems.push(`  SHA256SUMS 里多出一条 ${name}（不是本版产物）`)
      }
    }
  }

  // ③ RELEASE.md 必须在（它是用户看到的第一份说明，也带着已知限制）
  if (!existsSync(path.join(OUT, 'RELEASE.md'))) {
    problems.push(`  RELEASE.md 不存在（${outRel}RELEASE.md）`)
  }

  // ④ release/ 里不该有"dist/ 里没有"的产物
  //    （上一版剩下的、或者手工塞进去的 —— 发布时 `dist/release/*` 会一起传上去）
  //    本版产物有两种合法形态：原始产物、以及它的 `.zip`。
  const strays = readdirSync(OUT)
    .filter((f) => f.startsWith('flicker-') &&
      !found.some((x) => x.name === f || zipName(x.name) === f))
  if (strays.length) {
    problems.push(`  ${outRel}里有 dist/ 里没有的产物：${strays.join('、')}\n` +
      '      发布时 `dist/release/*` 会一起传上去 —— 会把不属于本版的东西发出去')
  }

  if (problems.length) {
    console.error(`\n✗ 发布包与 dist/ 对不上（${problems.length} 处）：\n`)
    for (const p of problems) console.error(p)
    console.error('\n  重新生成：node gen/release.mjs')
    process.exit(1)
  }

  console.log(`\n✓ 发布包与 dist/ 一致（${found.length} 个产物 + 各自的 zip + SHA256SUMS + RELEASE.md）`)
  console.log('（--check：只检查，未生成文件）')
  process.exit(0)
}

// ── 先把文件写出来，再写清单与说明 ──────────────────────────
//
// ⚠️ 顺序有讲究：RELEASE.md 的下载表要写 **zip 的实际大小**，而 zip 是这一刻才压出来的。
//    第一版把 sums/table 当成模块级常量在上面就算好了 —— 那样表格里只能是"原始大小"，
//    而"下载 35.8 MB"这个用户唯一关心的数字反而没地方写。
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const packed = []          // [{ f, zipName, zipSize, zipDigest }]
for (const f of found) {
  copyFileSync(path.join(DIST, f.name), path.join(OUT, f.name))
  const zName = zipName(f.name)
  const zPath = path.join(OUT, zName)
  // 权限位给 0755：macOS/Linux 上 `unzip` 靠它决定解出来的二进制能不能执行
  await writeZip(zPath, [{ name: f.name, path: path.join(DIST, f.name), mode: 0o755 }])
  const zipBuf = readFileSync(zPath)
  packed.push({ f, zipName: zName, zipSize: zipBuf.length, zipDigest: sha256(zipBuf) })
}

// ── 生成 SHA256SUMS ─────────────────────────────────────────
// 格式与 coreutils 的 sha256sum 一致，Linux/macOS 上可直接 `sha256sum -c SHA256SUMS`
// 覆盖**每一个用户能下载到的文件**：原始产物 + 它的 zip。
const sums = packed.flatMap(({ f, zipName: zn, zipDigest }) => [
  `${f.digest}  ${f.name}`,
  `${zipDigest}  ${zn}`,
]).join('\n') + '\n'

// ── 生成 RELEASE.md ─────────────────────────────────────────
const table = packed.map(({ f, zipName: zn, zipSize }) => {
  const p = f.platform
  // 只在有真实提醒时才写"说明"列 —— 空单元格在 markdown 里很难看，
  // 而"未在真机验证"这一条恰恰是必须让人看见的。
  const note = f.platform && f.platform.os !== 'win32'
    ? '**未在真机验证**'
    : '已实测'
  // "文件"列给的是 **zip**（推荐下载），"大小"列是**下载大小** ——
  // 这才是用户关心、并且会被"少下 62%"影响的那个数。
  return `| ${p ? p.label : '未知平台'} | \`${zn}\` | ${human(zipSize)} | ${note} |`
}).join('\n')

/** 原始产物那一行的说明（不想解压的人用） */
const rawList = packed
  .map(({ f, zipSize }) => `\`${f.name}\`（${human(f.size)}）`)
  .join('、')
const anyZip = packed[0]
const savedPct = anyZip ? Math.round(100 - 100 * anyZip.zipSize / anyZip.f.size) : 0

const extra = argOf('notes')
const extraText = extra
  ? (existsSync(extra) ? readFileSync(extra, 'utf8') : `\n<!-- 追加说明文件不存在：${extra} -->\n`)
  : ''

const release = `# 闪传 Flicker v${version}

一次性文件传输 —— 用完即销毁。接收端什么都不用装。

## 下载哪个

| 平台 | 文件 | 大小 | 说明 |
|---|---|---|---|
${table}

> **上面的"大小"是下载大小**（zip 压缩后）。压缩包里装的就是那个可执行文件本身，
> 解压出来是**未压缩**的大小 —— 单文件产物里 89 MB 是 Node 运行时，压得掉、减不掉，
> 所以"减小体积"没有空间，**压缩下载量**才是实际能拿到的那 ${savedPct}%。

> **不想解压？** 原始文件也在发布包里：${rawList}。
> 直接双击就能跑，代价是多下几十 MB。

${missing.length ? `> **本版没有这些平台的产物**：${missing.map((m) => m.label).join('、')}。
> 单文件产物（SEA）**不支持交叉编译** —— 每个平台必须在自己的机器上构建。
> 需要它们的话，请在该平台上跑 \`node gen/build-sea.mjs\`。\n` : ''}
## 怎么用

### 单文件产物（下载后直接跑，不需要装 Node）

**先解压**（Windows 上右键 → 全部解压缩；macOS/Linux 上 \`unzip 文件名\`），
把解出来的可执行文件放到任意目录，然后**在该目录里**：

\`\`\`powershell
# 图形界面（双击也行）
.\\flicker-${version}-windows-x64.exe

# 命令行：局域网直连
.\\flicker-${version}-windows-x64.exe send "D:\\要发的文件.zip"

# 命令行：跨网络（需要先部署一次中继，见 中文文档/中继部署.md）
.\\flicker-${version}-windows-x64.exe send "D:\\要发的文件.zip" --relay=https://你的中继地址

# 收到链接后，用浏览器打开即可（也可以让程序代开）
.\\flicker-${version}-windows-x64.exe recv "https://对方给的链接"
\`\`\`

> **想让 \`flicker\` 这个短命令可用**，把产物改名为 \`flicker.exe\` 并放进一个
> 已在 PATH 里的目录（例如 \`%LOCALAPPDATA%\\Microsoft\\WindowsApps\`），
> 或者用 \`setx PATH "%PATH%;<产物所在目录>"\` 把该目录加进 PATH。
> 下面的示例为了简短都写成 \`flicker\`。

### 从源码跑（要有 Node 24+）

\`\`\`powershell
git clone <仓库地址> && cd flicker
node bin/flicker.js                 # 图形界面
node bin/flicker.js send "D:\\文件.zip"
\`\`\`

**接收端两种方式都一样**：什么都不用装。让对方把链接发给你，
浏览器打开、输入同一个密码即可（手机、平板也一样）。

## 校验下载到的文件

\`SHA256SUMS\` 里**每个可下载的文件都有一行** —— 你下的是 zip 就核对 zip，下的是 exe 就核对 exe：

\`\`\`
# Linux / macOS（在解压后的目录里，会逐行核对）
sha256sum -c SHA256SUMS

# Windows PowerShell
Get-FileHash .\\flicker-${version}-windows-x64.exe.zip -Algorithm SHA256
\`\`\`

正确的校验值见下面的 SHA256SUMS 一节。**这一步不是形式** ——
90 MB 的二进制没人会读完源码，校验值是"这个文件确实来自这份源码"的唯一凭据。
（zip 那一行的值是**压缩包**的；想核对解压出来的程序，用它自己那一行。）

## 已知限制（请务必读）

| 限制 | 说明 |
|---|---|
| **跨网络模式下中继会经手全部数据** | 但只有密文；中继读不出内容、看不到文件名。不接受就用局域网模式，或自建中继 |
| **macOS / Linux 未在真机验证** | 证书**生成**是全平台同一份纯 JS 代码（有真实 TLS 握手用例），但把 CA 装进**系统信任库**这一步只有 Windows 实现 —— 那两个平台请加 \`--no-cert-install\`，程序会打印手动安装的确切命令 |
| **Firefox / Safari 收大文件可能失败** | 它们不支持流式写盘；超过约 1 GB 会受内存限制。建议用 Edge 或 Chrome |
| **关掉页面无法续传** | 链路抖动会自动重连（已实现），但关页面后未写完的文件作废 —— 浏览器没有"从第 N 字节接着写"的接口 |
| **弱密码有风险** | 600,000 次 PBKDF2 只保护离线攻击。程序默认会生成强密码，直接用就好 |

完整的威胁模型、密码学参数与自行核验清单见 [中文文档/SECURITY.md](中文文档/SECURITY.md)；
English: [docs/SECURITY.md](docs/SECURITY.md)。

## 这一版的产物校验值

每个**可以下载的文件**都有校验值（原始产物 + 它的 zip）：

\`\`\`
${sums.trimEnd()}
\`\`\`

> \`SHA256SUMS\` 里的 zip 值是**压缩包本身**的；解压出来的可执行文件的校验值是前面那一行。
> 想核对"我拿到的程序确实是这一版"，两种都可以 —— 见上面「校验下载到的文件」。

## 构建信息

- 版本：\`${version}\`
- 运行时：产物内嵌的 Node.js（见 \`--version\` 输出）
- 运行时依赖：**零**（只用 Node 内置模块）
- 构建期依赖：\`postject\`（由构建脚本临时拉取）
- 许可证：MIT
- **这一版改了什么**：\`变更记录.md\`（中文）/ \`CHANGELOG.md\`（English）——
  含每条修复是**怎么发现的**，以及实测数据与教训

${extraText}
---

_本文件由 \`gen/release.mjs\` 生成。要修改内容请改脚本，不要手改这个文件 ——
下一次构建会覆盖它。_
`

// ── 写清单与说明（产物本身在上面已经写好、也已经压好）──────
writeFileSync(path.join(OUT, 'SHA256SUMS'), sums, 'utf8')
writeFileSync(path.join(OUT, 'RELEASE.md'), release, 'utf8')

const rawTotal = packed.reduce((s, { f }) => s + f.size, 0)
const zipTotal = packed.reduce((s, { zipSize }) => s + zipSize, 0)
console.log(`\n✓ 发布包已生成：dist/release/`)
console.log(`  ${found.length} 个产物 + ${packed.length} 个 zip + SHA256SUMS + RELEASE.md`)
console.log(`  未压缩 ${human(rawTotal)} → 下载 ${human(zipTotal)}` +
  `（省 ${Math.round(100 - 100 * zipTotal / rawTotal)}%；两种都在包里）`)

// ── 给出下一步的确切命令 ────────────────────────────────────
const tag = `v${version}`
console.log(`\n下一步（需要已安装 gh 并登录）：`)
console.log(`  gh release create ${tag} dist/release/* \\`)
console.log(`    --title "闪传 Flicker ${tag}" \\`)
console.log(`    --notes-file dist/release/RELEASE.md`)
console.log(`\n若缺少某些平台的产物，建议先在那些平台上跑 CI 或本地构建，`)
console.log(`再把它们放进 dist/ 后重跑本脚本 —— 一次发布覆盖全部平台。`)
