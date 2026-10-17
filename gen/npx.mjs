/**
 * 用当前 Node 直接跑 npx（不经过 shell、不经过 .cmd）
 * ==================================================
 *
 * ── 为什么需要这个 ──
 *
 * 构建单文件产物时要调一次 `npx postject` 把 SEA blob 注入可执行文件
 * （postject 是**构建期唯一**的第三方工具，见 构建单文件.md 第七章）。
 *
 * 原来的写法是 `spawnSync('npx', [...], { shell: true })`，它能用，但：
 *
 * ① Node 24 会对它打 `DEP0190` 警告 —— 原话是
 *    "Passing args to a child process with shell option true can lead to security
 *     vulnerabilities, as the arguments are not escaped, only concatenated."
 *    也就是说：参数被拼进命令行字符串，转义的责任落到调用方头上。
 *    这里虽然只是本仓库路径 + 临时目录，但"靠运气没出事"不是理由。
 *
 * ② 走 shell 还意味着要经过 cmd.exe 的解析规则（引号、`^`、尾反斜杠……），
 *    而路径里带空格或中文（本项目的目录就叫 `D:\闪传`）时这些规则很容易踩。
 *
 * ③ 而且这条路本来就绕：`npx` 是个 shell 脚本 / `.cmd` 包装，
 *    真正执行的仍然是 `node <npm>/bin/npx-cli.js`。
 *    我们手上就有 node（正在跑本脚本的那个），直接跑它即可 ——
 *    不需要 shell，也没有参数转义问题。
 *
 * ── 为什么要"找候选 + 回退" ──
 *
 * npm 的安装位置随平台和安装方式变（官方安装包、nvm、apt、镜像源……），
 * 所以这里按常见布局找一遍；找不到就**回退到原来的 shell 写法**并保留警告 ——
 * 构建绝不能因为"没找到 npx"而失败，那条路一直是能用的。
 *
 * 用法：
 *   import { runNpx } from './npx.mjs'
 *   const r = runNpx(['--yes', 'postject@1.0.0-alpha.6', ...], { timeout: 300_000 })
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * 按常见布局列出 `npx-cli.js` 可能的路径。
 *
 * 已知的三种真实布局：
 *   · Windows 官方安装包：`C:\Program Files\nodejs\node_modules\npm\bin\npx-cli.js`
 *   · Unix 官方安装包 / CI：`/usr/local/lib/node_modules/npm/bin/npx-cli.js`
 *     （node 在 `/usr/local/bin/node`，npm 在它上一级的 lib 里）
 *   · 通过 npm 脚本启动时：`process.env.npm_execpath` 指向 `npm-cli.js`，
 *     `npx-cli.js` 就在同一个目录里
 *
 * @param {string} execPath 当前 node 可执行文件的路径
 * @param {Record<string,string|undefined>} env
 * @returns {string[]}
 */
export function npxCliCandidates(execPath = process.execPath, env = process.env) {
  const nodeDir = path.dirname(execPath)
  const out = []
  if (env.npm_execpath) out.push(path.join(path.dirname(env.npm_execpath), 'npx-cli.js'))
  // Windows：node_modules 与 node.exe 同级
  out.push(path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js'))
  // Unix：<prefix>/bin/node → <prefix>/lib/node_modules/...
  out.push(path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'))
  // 某些发行版把 npm 装在 share 下
  out.push(path.join(nodeDir, '..', 'share', 'node_modules', 'npm', 'bin', 'npx-cli.js'))
  return out.map((p) => path.normalize(p))
}

/** 找到第一个真实存在的 `npx-cli.js`；都没有就返回 null（调用方回退） */
export function resolveNpxCli(execPath = process.execPath, env = process.env) {
  for (const p of npxCliCandidates(execPath, env)) {
    if (existsSync(p)) return p
  }
  return null
}

/**
 * 跑一次 npx 命令。
 *
 * @param {string[]} args 传给 npx 的参数（**不含** `npx` 本身）
 * @param {object} [opts] 传给 spawnSync 的选项（timeout 等）
 * @returns {{code:number|null, out:string, via:string}} via 说明走的哪条路（便于排查）
 */
export function runNpx(args, opts = {}) {
  const cli = resolveNpxCli()
  const base = { encoding: 'utf8', ...opts }

  if (cli) {
    // 直接用当前 node 跑 npx-cli.js：无 shell、无 .cmd、无转义问题
    const r = spawnSync(process.execPath, [cli, ...args], { ...base, shell: false })
    return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), via: 'node+npx-cli.js' }
  }

  // 回退：找不到 npx-cli.js 时走 shell。
  //
  // ⚠️ 这条路必须保留：Windows 上从 Node 18.20/20.12/21.7 起（CVE-2024-27980 的修复），
  //    `spawn` **不允许**直接执行 `.cmd`/`.bat`，不带 shell 会直接 EINVAL ——
  //    所以"改成 shell:false + npx.cmd"那种写法在 Windows 上是坏的。
  //    Node 会为此打 DEP0190 警告，那就让它打：能用比没警告重要。
  const r = spawnSync('npx', args, { ...base, shell: true })
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), via: 'npx (shell)' }
}
