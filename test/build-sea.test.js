/**
 * 构建脚本（gen/build-sea.mjs）的两条硬约束
 * ==========================================
 *
 * 这两条都不是"代码风格"，而是各自对应一次真实事故：
 *
 * ① **可复现构建**。`release.mjs` 的 RELEASE.md 与 README 都拿"校验值 + 可复现构建"
 *    说服人下载 —— 意思是"你拿这份源码自己构建，应该得到同一个二进制"。
 *    2026-10 实测：连续两次构建的产物差 7 个字节，diff 出来是构建目录名里的时间戳
 *    （入口文件名会以绝对路径进 SEA blob）。
 *    2026-11 又发现第二层：目录名虽然确定了，但 `tmpdir()` 随机器/用户变化 ——
 *    换台机器、甚至同一台机器换个 `TMPDIR`，产物又会不同。
 *    现在的做法：构建目录放在仓库 `dist/` 下，且 `sea-config.json` 只写**相对路径**、
 *    以构建目录为 cwd 去跑 node。于是 blob 里只有 `sea-entry.cjs` 这种相对文件名。
 *    一个做不到的承诺比没有承诺更糟 —— 别人照着验，发现对不上，只会以为产物被篡改。
 *
 * ② **不经 shell 调 npx**。原来写的是 `spawnSync('npx', [...], {shell:true})`，
 *    Node 24 会打 DEP0190：参数只拼接、不转义。而且走 shell 就要 cmd.exe 的
 *    引号规则，而本项目的路径里带中文、可能带空格。
 *
 * 为什么不真构建来验（90 MB、一两分钟、还要联网下载 postject）：
 * 所以用三层便宜的证据：
 *   · 结构断言：路径来源必须是"仓库内 + 确定"的，配置里不许出现绝对路径；
 *   · 真跑 `node --experimental-sea-config` 生成**极小的 blob**（几十字节、毫秒级），
 *     在两个不同目录各生成一次，断言 blob **逐字节相同** —— 这正是"换 TMPDIR 后
 *     产物哈希不变"的机制本身（blob 是产物里唯一带路径的部分）；
 *   · 验一次"npx 这条路真的能走通"（唯一便宜的功能断言）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { npxCliCandidates, resolveNpxCli } from '../gen/npx.mjs'
import { buildSeaConfig, resolveBuildDir } from '../gen/sea-config.mjs'
// 复用页面测试里那个"去掉注释与字符串字面量"的工具。
//
// ⚠️ 必须去注释：build-sea.mjs 的注释里就写着 `{shell:true}`（解释为什么改掉它），
//    直接对全文做"不许出现 shell:true"的断言会被自己的注释误伤 ——
//    这个坑本项目在 path-safety 那条上已经踩过一次（注释里写着"不许用 Buffer"）。
import { codeOnly } from './receiver-relay-tests.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUILD_SRC = readFileSync(path.join(ROOT, 'gen', 'build-sea.mjs'), 'utf8')
const BUILD_CODE = codeOnly(BUILD_SRC)
const NPX_SRC = readFileSync(path.join(ROOT, 'gen', 'npx.mjs'), 'utf8')

test('⭐ 构建目录必须确定且不依赖 tmpdir()（否则产物不可复现）', () => {
  const line = BUILD_SRC.split('\n').find((l) => l.startsWith('const BUILD ='))
  assert.ok(line, '找不到 BUILD 的定义 —— 构建脚本结构变了？')
  assert.doesNotMatch(line, /Date\.now|Math\.random|randomUUID|process\.hrtime/,
    'BUILD 的路径会进 SEA blob（入口文件名以绝对路径嵌进去），' +
    '带时间戳或随机数就意味着**同样的源码产出不同的二进制**：\n' +
    `    ${line.trim()}`)
  assert.doesNotMatch(line, /tmpdir\(\)/,
    'BUILD 不能建在 tmpdir() 下 —— 那个绝对路径随机器/用户变化，' +
    '换 TMPDIR 产物就不同（2026-11 修的就是这一条）')
  assert.match(line, /platformTag\(\)/, '应当按平台命名（确定的、又不会跟别的平台撞）')
  assert.match(line, /resolveBuildDir/, '路径计算应当走 gen/sea-config.mjs（可单测）')

  // 名字确定 ⇒ 上一次的残留必须先清掉，否则会混进这次产物
  // ⚠️ 两个定位上的坑（第一版都踩了）：
  //    · 不能拿"准备构建目录"去 indexOf —— 文件开头的流水线注释里也有这四个字
  //    · 不能在 codeOnly() 之后找中文 —— 字符串字面量已经被抹成 '' 了
  //    所以：在**原文**里从 `log('②'` 那一步开始切片，再断言切片里有 rmSync。
  const stepAt = BUILD_SRC.indexOf("log('②'")
  assert.ok(stepAt > 0, '找不到"准备构建目录"那一步 —— 构建脚本结构变了？')
  const step = BUILD_SRC.slice(stepAt, stepAt + 400)
  assert.match(step, /rmSync\(BUILD/,
    '复用确定的目录名之前必须先删干净 —— 残留文件会混进产物，而产物看起来还是新的')
})

test('⭐ 构建目录在仓库内、与机器无关（由 sea-config 的 resolveBuildDir 算）', () => {
  const a = resolveBuildDir({ root: ROOT, platformTag: 'windows-x64' })
  const b = resolveBuildDir({ root: ROOT, platformTag: 'windows-x64' })
  assert.equal(a, b, '同一个输入必须永远得到同一个路径')
  assert.ok(a.startsWith(path.join(ROOT, 'dist') + path.sep),
    `构建目录应当放在仓库 dist/ 下（gitignore 与赠品排除都已覆盖），实际：${a}`)
  assert.match(a, /windows-x64$/)
  // 换 TMPDIR/换平台不该影响它：函数只吃 root 与平台标签，没有环境变量输入
  assert.ok(!a.includes(tmpdir()) || tmpdir().length < 3,
    '构建目录不该嵌 tmpdir() 的路径（这正是跨机器不可复现的来源）')
})

test('⭐ 写进 sea-config 的一律是相对路径（绝对路径会进 blob）', () => {
  const cfg = buildSeaConfig({
    assets: ['web/receiver.html', 'src/assets.js'],
    embeddedSourcePack: 'source-pack.fkz',
  })
  const json = JSON.stringify(cfg)
  assert.doesNotMatch(json, /[A-Za-z]:\\\\/, '配置里不许出现 Windows 盘符路径：' + json)
  assert.ok(!json.includes(ROOT), '配置里不许出现仓库绝对路径')
  assert.equal(cfg.main, 'sea-entry.cjs', 'main 必须是相对构建目录的文件名')
  assert.equal(cfg.output, 'sea-prep.blob')
  assert.deepEqual(Object.keys(cfg.assets), [
    'web/receiver.html', 'src/assets.js', 'app.cjs', 'version.json', 'source-pack.fkz',
  ])
  for (const [key, value] of Object.entries(cfg.assets)) {
    assert.equal(value, key, '资产值也必须是相对路径（构建目录里按同样的相对路径存放）')
    assert.ok(!path.isAbsolute(value), `资产 ${key} 的路径是绝对路径：${value}`)
  }
})

test('⭐ 机制验证：同一份相对配置在不同目录生成的 SEA blob 逐字节相同', () => {
  // 不需要 90 MB 的真实构建：SEA 产物里"唯一会带机器路径"的就是 blob，
  // 而 blob 由 `node --experimental-sea-config` 生成（几十字节、毫秒级）。
  // 两个不同目录 = 模拟"换了 TMPDIR/换了机器路径"。
  const base = mkdtempSync(path.join(tmpdir(), 'flicker-sea-repro-'))
  const mk = (name) => {
    const dir = path.join(base, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'entry.cjs'), "console.log('hi')\n")
    writeFileSync(path.join(dir, 'asset.txt'), 'asset\n')
    const cfg = {
      main: 'entry.cjs',
      output: 'sea-prep.blob',
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
      assets: { 'asset.txt': 'asset.txt' },
    }
    writeFileSync(path.join(dir, 'sea-config.json'), JSON.stringify(cfg, null, 2))
    const r = spawnSync(process.execPath, ['--experimental-sea-config', 'sea-config.json'], {
      cwd: dir, encoding: 'utf8', timeout: 60_000,
    })
    assert.equal(r.status, 0, `生成 blob 失败：\n${r.stderr}`)
    return readFileSync(path.join(dir, 'sea-prep.blob'))
  }
  try {
    const one = mk('dir-one')
    const two = mk('dir-two')
    assert.ok(one.length > 0)
    assert.ok(one.equals(two),
      '不同目录下生成的 blob 不同 —— 说明配置里混进了绝对路径，' +
      '"换 TMPDIR 后产物哈希不变"就不成立')
    assert.ok(!one.toString('latin1').includes(base),
      'blob 里出现了构建目录的绝对路径 —— 它会跟着产物走，破坏可复现构建')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('⭐ 调 npx 不走 shell（Node 24 的 DEP0190 就是在说这件事）', () => {
  assert.doesNotMatch(BUILD_CODE, /shell:\s*true/,
    'build-sea.mjs 里不该再出现 shell:true —— 参数只拼接不转义，而且要过 cmd.exe 的引号规则')
  assert.match(BUILD_SRC, /import \{ runNpx \} from '\.\/npx\.mjs'/,
    '应当用 gen/npx.mjs 的 runNpx')
  // ⚠️ 断言要盯**意图**（"注入走 runNpx、参数是数组"），不是盯字面量写法：
  //    2026-10 把参数改成了先拼 `postjectArgs`（macOS 要多一个 `--macho-segment-name`），
  //    原来写的 `/runNpx\(\[/` 就把一个本来正确的实现判成了错的。
  assert.match(BUILD_CODE, /runNpx\(/,
    '注入那一步要走 runNpx')
  // ⚠️ 这一条要看 **BUILD_SRC**（原始源码），不能看 BUILD_CODE（打包后的代码）：
  //    打包器把资源类字符串字面量换成了 `''`，所以 `postject@…` 在 BUILD_CODE 里查不到。
  assert.match(BUILD_SRC, /postject@1\.0\.0-alpha\.6/,
    '仍然要调 postject（只是参数拼在数组里）')
  assert.match(BUILD_SRC, /--macho-segment-name/,
    'macOS 必须给 postject `--macho-segment-name NODE_SEA`，否则注入进错误的段、一跑就 SIGSEGV')
})

test('npx 的回退路径必须保留（否则某些安装方式就构建不了）', () => {
  // Windows 上从 Node 18.20/20.12/21.7（CVE-2024-27980 的修复）起，
  // `spawn` 不允许直接执行 .cmd/.bat，不带 shell 会 EINVAL ——
  // 所以"改成 shell:false + npx.cmd"是**错的**修法，回退必须留着。
  assert.match(NPX_SRC, /shell:\s*true/, '回退路径要保留 shell 写法')
  assert.match(NPX_SRC, /EINVAL|CVE-2024-27980/,
    '回退的理由要写在代码里，否则以后有人会"顺手把它删掉"')
  assert.match(NPX_SRC, /resolveNpxCli/, '要先尝试找到 npx-cli.js')
})

test('npx-cli.js 的候选覆盖已知布局（按**宿主**平台验，path 用的是宿主语义）', () => {
  // ⚠️ 必须按平台分开断言：`gen/npx.mjs` 用的是 `node:path`（宿主语义），
  //    在 Linux 上给它一个 `C:\\...` 路径，`path.dirname` 会返回 `.`，候选自然对不上 ——
  //    2026-10 的 Linux CI 第一次跑就是红在这条"用 Windows 路径在 Linux 上验"上。
  if (process.platform === 'win32') {
    const win = npxCliCandidates('C:\\Program Files\\nodejs\\node.exe', {})
    assert.ok(win.some((p) => p.endsWith(path.join('nodejs', 'node_modules', 'npm', 'bin', 'npx-cli.js'))),
      'Windows 官方安装包的布局：<nodejs>\\node_modules\\npm\\bin\\npx-cli.js')
    assert.equal(win.length, 3, '没有 npm_execpath 时应当有 3 个候选（同级 / lib / share）')
  } else {
    const list = npxCliCandidates('/opt/node/bin/node', {})
    assert.ok(list.some((p) => p.includes(path.join('lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'))),
      'Unix 官方安装包的布局：<prefix>/lib/node_modules/npm/bin/npx-cli.js')
    assert.ok(list.some((p) => p.includes(path.join('share', 'node_modules', 'npm', 'bin', 'npx-cli.js'))),
      '某些发行版把 npm 放在 share 下：<prefix>/share/node_modules/npm/bin/npx-cli.js')
    assert.equal(list.length, 3, '没有 npm_execpath 时应当有 3 个候选（同级 / lib / share）')
  }
  const viaNpm = npxCliCandidates('/usr/bin/node', { npm_execpath: '/usr/lib/node_modules/npm/bin/npm-cli.js' })
  assert.equal(viaNpm[0], path.join('/usr/lib/node_modules/npm/bin', 'npx-cli.js'),
    '通过 npm 脚本启动时，npx-cli.js 就在 npm-cli.js 旁边（最可靠的线索，排在第一个）')
})

test('这条 npx 路真的能跑（不是"看起来能找到"）', (t) => {
  const cli = resolveNpxCli()
  if (!cli) {
    t.skip('这台机器上的 npm 布局不在候选里 —— 构建会走回退路径（同样可用）')
    return
  }
  assert.ok(existsSync(cli), `解析出来的路径要真实存在：${cli}`)
  const r = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8', timeout: 120000 })
  assert.equal(r.status, 0, `用当前 node 跑 npx-cli.js 失败：\n${r.stderr}`)
  assert.match((r.stdout || '').trim(), /^\d+\.\d+\.\d+/,
    `npx --version 的输出不像版本号：${JSON.stringify((r.stdout || '').slice(0, 80))}`)
})
