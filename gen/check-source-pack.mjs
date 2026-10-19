/**
 * 赠品源码包的两道判据
 * ====================
 * 背景（2026-10 实测的事故）：
 *   赠品里的 `.fkz` 源码包，说明写的是"源码 + 全部文档，对方可以自己看、自己改、
 *   自己构建"。但它当时是按 `src/gift.js` 里一份**手写清单**打的，只有 40 个条目
 *   （22 份文档 + 3 个启动脚本 + 十几个源码文件）：`src/run.js`、`src/gui.js`、
 *   `src/tty.js`、`src/assets.js`、`src/relay/*` 全都不在里面。
 *   实测：把包解开、在里面跑 `node bin/flicker.js --version`，
 *   第一句就 `ERR_MODULE_NOT_FOUND: Cannot find module .../src/assets.js`。
 *   也就是说：**对方收到的是一个跑不起来的半份源码。**
 *
 *   修法是把白名单换成"遍历整棵树 + 黑名单"（`collectSourceFiles`），
 *   于是"完整性"不再依赖谁记得去加一行。这台判据守住两件事：
 *
 *   ① **结构**：该在包里的东西必须在（入口的模块图、页面、构建脚本、两份文档……），
 *      不该在的必须不在（`dist/` 的产物、`node_modules/`、体检日志）；
 *   ② **行为**：现场打一份包，解开到临时目录，在那里**真的跑一次**
 *      `node bin/flicker.js --version`，断言退出码为 0。
 *
 * ⚠️ 为什么必须有②：①只能证明"我想到的那些文件都在"。真正要回答的问题是
 *    "对方拿到它能不能用" —— 那只能靠真的在解开的目录里跑一遍。
 *    反过来也不行：只有②时报的是深层的模块解析错误，
 *    而①能直接点出"包里少了哪几个文件"。
 *
 * 结构判据抽成纯函数 `packStructureProblems({ names, need })`、清单抽成
 * `requiredFiles(root)`、打包抽成 `buildPack(root)` —— 这样
 * `test/source-pack.test.js` 能喂假清单反过来验它（少一个必需文件必须报、
 * 混进凭据文件必须报），而不用每次真打一份包才能验逻辑。
 *
 * 用法：node gen/check-source-pack.mjs [--root=<另一棵树>]
 */
import {
  readFileSync, existsSync, readdirSync, statSync,
  mkdtempSync, mkdirSync, writeFileSync, rmSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 从 `--key=value` 里取值（测试注入坏掉的副本用） */
export function argOf(argv, name, fallback) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

/** 列目录里的普通文件（不存在就返回空；跳过隐藏文件） */
export function filesIn(root, dir) {
  const abs = path.join(root, dir)
  if (!existsSync(abs)) return []
  return readdirSync(abs)
    .filter((f) => !f.startsWith('.'))
    .filter((f) => { try { return statSync(path.join(abs, f)).isFile() } catch { return false } })
    .sort()
}

/** 沿静态 import 走模块图（只跟相对路径；`node:` 内置模块不是文件） */
export function moduleGraph(root, entry, seen = new Set()) {
  const abs = path.resolve(root, entry)
  if (seen.has(abs) || !existsSync(abs)) return seen
  seen.add(abs)
  const src = readFileSync(abs, 'utf8')
  const re = /(?:^|\n)\s*(?:import|export)[^\n]*?from\s*['"](\.[^'"]+)['"]|(?:^|\n)\s*import\s*['"](\.[^'"]+)['"]/g
  let m
  while ((m = re.exec(src))) {
    const rel = path.relative(root, path.resolve(path.dirname(abs), m[1] ?? m[2])).replace(/\\/g, '/')
    moduleGraph(root, rel, seen)
  }
  return seen
}

/**
 * 一个"完整的源码树"至少要有这些东西。
 * 入口的模块图是**自动走出来的**，所以以后新增模块不会被漏掉。
 */
export function requiredFiles(root = ROOT) {
  const graph = [...moduleGraph(root, 'bin/flicker.js')]
    .map((p) => path.relative(root, p).replace(/\\/g, '/'))
  const extra = [
    'bin/flicker.js', 'package.json', 'LICENSE', 'README.md', '读我.md',
    'CHANGELOG.md', '变更记录.md',
    'web/receiver.html', 'web/station.html',
    'relay/local.mjs', 'relay/page.generated.js',
    'entry/sea-entry.cjs',
    '启动.cmd', '启动.command', '启动.sh',
  ]
  const gen = filesIn(root, 'gen').map((f) => `gen/${f}`)
  const examples = filesIn(root, 'examples/plugins').map((f) => `examples/plugins/${f}`)
  const docs = []
  for (const dir of ['中文文档', 'docs']) {
    for (const f of filesIn(root, dir)) if (f.endsWith('.md')) docs.push(`${dir}/${f}`)
  }
  return [...new Set([...graph, ...extra, ...gen, ...examples, ...docs])].sort()
}

/** 打包里的文件名不该长这样 */
export function isForbidden(rel) {
  return rel.startsWith('dist/') || rel.startsWith('node_modules/') || rel.startsWith('_lab/out/') ||
    rel.startsWith('.git/') ||
    // ⚠️ 凭据类文件：赠品是**要送给别人的**，密钥绝不能跟着走（产物里也会有一份）
    /(^|\/)(api-token|\.env|credentials?|secrets?)[^/]*$/i.test(rel)
}

/**
 * 结构判据（纯函数：只比两个名字集合，不碰磁盘）。
 * @param {{names:Set<string>|string[], need:string[]}} p
 * @returns {{missing:string[], forbidden:string[], credential:string[]}}
 */
export function packStructureProblems({ names, need }) {
  const have = names instanceof Set ? names : new Set(names)
  const missing = need.filter((f) => !have.has(f))
  const forbidden = [...have].filter(isForbidden)
  const credential = forbidden.filter((f) => /token|credential|secret|\.env$/i.test(f))
  return { missing, forbidden, credential }
}

/** 打出真包并列出里面的文件（FKZ1 容器，格式见 src/gift.js 顶部注释） */
export async function buildPack(root = ROOT) {
  const { installFromDisk } = await import('../src/assets.js')
  installFromDisk(root)
  const { buildSourcePack, unpackArchive } = await import('../src/gift.js')
  const pack = await buildSourcePack(root)
  const buf = pack.bytes
  // ⚠️ 用 `src/gift.js` 的**唯一**读实现，不在这里再手写一遍：
  //    同一个容器格式两份解析器，迟早会出现"打包端能读、解包端读不了"这种最难查的漂移。
  const entries = unpackArchive(buf)
  return { bytes: buf, entries, docCount: pack.docCount }
}

/**
 * 核一棵树：结构 + 就地解开真跑一次。
 * @returns {Promise<{problems:string[], info:string[], entries:number, docCount:number, names:Set<string>}>}
 */
export async function auditSourcePack(root = ROOT, { runVersion = true } = {}) {
  const problems = []
  const info = []
  const pack = await buildPack(root)
  const names = new Set(pack.entries.map((e) => e.rel))
  const need = requiredFiles(root)

  info.push(`源码包：${pack.entries.length} 个文件（其中文档 ${pack.docCount} 份）；` +
    `按模块图与资源算下来至少需要 ${need.length} 项`)

  const { missing, forbidden, credential } = packStructureProblems({ names, need })
  if (missing.length) {
    problems.push(`源码包少了 ${missing.length} 个必需文件 —— 对方拿到的是一个跑不起来的半份源码：\n` +
      missing.map((f) => `    ${f}`).join('\n') +
      '\n如果这是被 src/gift.js 的 PACK_EXCLUDES 排除掉的，请把排除规则改回来；' +
      '\n（清单是遍历式的，所以"少了文件"通常意味着排除规则写宽了。）')
  }
  if (forbidden.length) {
    let msg = `源码包里混进了不该有的东西（${forbidden.length} 项）：\n` +
      forbidden.slice(0, 10).map((f) => `    ${f}`).join('\n') +
      '\n构建产物、依赖目录、体检日志都不该进赠品。'
    if (credential.length) {
      msg += '\n⚠️ 其中含有**凭据类文件**！这类东西一旦进了赠品，就等于把钥匙' +
        '\n   连同源码一起送给对方（而且产物里也会有一份）。' +
        '\n   修法：把它加进 src/gift.js 的 PACK_EXCLUDES（并确认 .gitignore 也忽略了它）。'
    }
    problems.push(msg)
  }
  if (problems.length) return { problems, info, entries: pack.entries.length, docCount: pack.docCount, names }

  if (!runVersion) return { problems, info, entries: pack.entries.length, docCount: pack.docCount, names }

  // ── ② 行为：解开真包，在里面真的跑一次 ───────────────────
  const dir = mkdtempSync(path.join(tmpdir(), 'flicker-check-pack-'))
  try {
    for (const e of pack.entries) {
      const full = path.join(dir, e.rel)
      mkdirSync(path.dirname(full), { recursive: true })
      writeFileSync(full, e.data)
    }
    const r = spawnSync(process.execPath, ['bin/flicker.js', '--version'],
      { cwd: dir, encoding: 'utf8', windowsHide: true })
    if (r.status !== 0) {
      problems.push(`源码包解开后**跑不起来**（退出码 ${r.status}）：\n` +
        (r.stderr || r.stdout || '').split('\n').slice(0, 12).map((l) => '    ' + l).join('\n') +
        '\n判据：接收方解压后应当能直接 `node bin/flicker.js --version`。')
    } else {
      info.push(`✓ 结构完整，且解开后能跑起来（--version → ${JSON.stringify((r.stdout || '').trim())}）`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  return { problems, info, entries: pack.entries.length, docCount: pack.docCount, names }
}

// ── CLI ──────────────────────────────────────────────────────

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  const root = argOf(process.argv.slice(2), 'root', ROOT)
  const { problems, info } = await auditSourcePack(root)
  for (const line of info) console.log(line)
  if (problems.length) {
    for (const p of problems) console.error(`\n✗ ${p}`)
    process.exit(1)
  }
}
