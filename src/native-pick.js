/**
 * 原生「选择文件夹」对话框
 * ======================
 *
 * 为什么需要它：程序自己的目录选择器（`web/station.html` 里那个弹窗）能列目录，
 * 但**看不到系统里的"新建文件夹"、也记不住上次去的地方**，还容易被误当成
 * "选择要发送的文件"那块（同一个弹窗被三种用途共用，文案和选中规则一不留神就串了
 * —— 2026-10 用户就是这么撞上的："选择文件夹的提示文字不是对应的，只要选择一个
 * 文件就从'存到这里'变成'就发这些'"）。选**保存目录**这件事交给系统对话框最省事，
 * 用户也最熟。
 *
 * ── 设计取舍 ─────────────────────────────────────────────
 *
 * **为什么不引依赖（比如 `@electron/remote` 一类）**：本项目零运行时依赖，
 * 用各平台自带的命令行工具就够了：
 *   · Windows：`powershell.exe` + `System.Windows.Forms.FolderBrowserDialog`
 *     （带「新建文件夹」按钮，`ShowNewFolderButton`）
 *   · macOS：`osascript` + `choose folder`
 *   · Linux：`zenity --file-selection --directory`
 *
 * **为什么不"随便猜一个能用的"**：拿不到对话框时**明确**返回 `unsupported`，
 * 让界面退回自带的选择器 —— 而不是悄悄什么都不做（用户会以为按钮坏了）。
 *
 * **为什么可以被关掉**：自动化测试里绝不能弹系统窗口（本项目"绝不自动弹窗"那条规则）。
 * `FLICKER_NO_NATIVE_PICK=1` 让这一层直接报 `disabled`，判据因此可以覆盖
 * "拿不到原生对话框时界面怎么退"而不用真的开窗。
 *
 * 用法：
 *   const r = await pickFolder({ title, startDir })
 *   r = { ok: true, path }                       用户选了
 *     | { ok: false, cancelled: true }           用户点了取消（正常的，不是错）
 *     | { ok: false, reason: 'disabled' }        被环境变量关掉
 *     | { ok: false, reason: 'unsupported' }     这个平台/环境没有可用的对话框
 *     | { ok: false, reason: 'failed', error }   起了但失败（含超时）
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * 用户可能对着对话框走开很久（去倒杯水、接个电话）。
 * 超时**不是**为了拦用户，只是别让一个卡死的子进程永远挂着 —— 10 分钟够了。
 */
export const PICK_TIMEOUT_MS = 10 * 60 * 1000

/** 把一段文字塞进 PowerShell 的单引号字符串（单引号本身要写两遍） */
export const psQuote = (s) => `'${String(s ?? '').replace(/'/g, "''")}'`

/** 把一段文字塞进 AppleScript 的双引号字符串 */
export const asQuote = (s) => `"${String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/** Windows 上 PowerShell 的绝对路径（PATH 里不一定有它） */
export function powershellPath({ env = process.env, exists = existsSync } = {}) {
  const roots = [env.SystemRoot, env.windir, 'C:\\Windows'].filter(Boolean)
  for (const root of roots) {
    const p = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if (exists(p)) return p
  }
  return null
}

/**
 * 当前平台能不能弹原生对话框（不能的话返回原因，能就返回 null）。
 *
 * @param {object} opts
 * @param {string} [opts.platform] 默认 `process.platform`（测试里注入）
 * @param {object} [opts.env]      默认 `process.env`
 * @param {(cmd:string)=>boolean} [opts.has] 判断某个命令在不在（测试里注入）
 */
export function unavailableReason({ platform = process.platform, env = process.env, has } = {}) {
  if (env.FLICKER_NO_NATIVE_PICK === '1') return 'disabled'
  const exists = has ?? ((cmd) => onPath(cmd, env))
  if (platform === 'win32') return powershellPath({ env }) || exists('powershell.exe') ? null : 'unsupported'
  if (platform === 'darwin') return exists('osascript') ? null : 'unsupported'
  if (platform === 'linux') return exists('zenity') ? null : 'unsupported'
  return 'unsupported'
}

/** 在 PATH 里找命令（只判断存在，不执行） */
export function onPath(cmd, env = process.env) {
  const dirs = String(env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)
  const exts = process.platform === 'win32'
    ? ['.exe', '.cmd', '.bat', '']
    : ['']
  for (const d of dirs) {
    for (const e of exts) {
      try { if (existsSync(path.join(d, cmd + e))) return true } catch { /* 盘符不在线 */ }
    }
  }
  return false
}

/**
 * 造出"调哪个命令、带什么参数"。**纯函数**（不执行、不看文件系统），
 * 这样每个平台的写法都能被判据直接验，而不是靠"在我这台机器上能弹出来"。
 *
 * @returns {{cmd:string, args:string[]}|null} null = 这平台上没有可用命令
 */
export function buildPickCommand({ platform = process.platform, title = '', startDir = '', env = process.env,
  exists = existsSync } = {}) {
  const t = title || ''
  if (platform === 'win32') {
    const cmd = powershellPath({ env, exists })
    if (!cmd) return null
    // ⚠️ 一定用 PowerShell 5.1 + `-STA`：FolderBrowserDialog 是 COM 组件，
    //    在 MTA 线程里创建会抛 "Current thread must be set to single thread
    //    apartment (STA) mode"。pwsh 7 也能跑，但它的 `-STA` 只在 Windows 上成立，
    //    用 `System32` 里那个 5.1 更稳。
    const script = [
      // ⚠️ 必须把控制台输出编码钉成 UTF-8：Windows 上默认是本地代码页（GBK…），
      //    而 Node 按 UTF-8 解码子进程的 stdout —— 中文文件夹名（`D:\闪传`）会变成乱码。
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      `$d.Description = ${psQuote(t)}`,
      '$d.ShowNewFolderButton = $true',
      startDir ? `try { $d.SelectedPath = ${psQuote(startDir)} } catch { }` : '',
      'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
      '  [Console]::Out.Write($d.SelectedPath)',
      '} else { exit 3 }',
    ].filter(Boolean).join('\n')
    return { cmd, args: ['-NoProfile', '-NonInteractive', '-STA', '-Command', script] }
  }
  if (platform === 'darwin') {
    const where = startDir ? ` default location POSIX file ${asQuote(startDir)}` : ''
    return {
      cmd: 'osascript',
      args: ['-e', `POSIX path of (choose folder with prompt ${asQuote(t)}${where})`],
    }
  }
  if (platform === 'linux') {
    const args = ['--file-selection', '--directory', `--title=${t || '选择文件夹'}`]
    if (startDir) args.push(`--filename=${startDir.replace(/\/?$/, '/')}`)
    return { cmd: 'zenity', args }
  }
  return null
}

/**
 * 把子进程的结果翻译成统一形状。
 *
 * 各平台的"用户点了取消"长得都不一样：Windows 是自己 `exit 3`，
 * osascript 是退出码 1 + stderr 里 `User canceled`，zenity 是退出码 1。
 * 这些差别收在这一个函数里，调用方只看到 `cancelled` 或 `ok`。
 */
export function parsePickResult({ platform, code, stdout = '', stderr = '' }) {
  const out = String(stdout).trim()
  if (code === 0 && out) {
    // osascript 给的是 POSIX 路径，文件夹会带结尾斜杠
    const cleaned = out.replace(/[\\/]+$/, '') || out
    return { ok: true, path: cleaned }
  }
  if (platform === 'win32' && code === 3) return { ok: false, cancelled: true }
  if (code === 0 && !out) return { ok: false, cancelled: true }
  if (/user canceled|\(-128\)/i.test(stderr)) return { ok: false, cancelled: true }
  // zenity: 取消时退出码 1、stderr 为空
  if (platform === 'linux' && code === 1 && !String(stderr).trim()) return { ok: false, cancelled: true }
  return { ok: false, reason: 'failed', error: `退出码 ${code}${stderr ? '：' + String(stderr).trim().slice(0, 300) : ''}` }
}

/**
 * 弹系统对话框，等用户选。**不弹**由 `unavailableReason()` 决定（测试靠它）。
 */
export async function pickFolder(opts = {}) {
  const { platform = process.platform, title = '', startDir = '', env = process.env,
    has, spawnImpl = spawn, timeoutMs = PICK_TIMEOUT_MS } = opts
  const why = unavailableReason({ platform, env, has })
  if (why) return { ok: false, reason: why }
  const built = buildPickCommand({ platform, title, startDir, env })
  if (!built) return { ok: false, reason: 'unsupported' }

  return await new Promise((resolve) => {
    let child
    try {
      child = spawnImpl(built.cmd, built.args, { windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ ok: false, reason: 'unsupported', error: e?.message ?? String(e) })
      return
    }
    let out = '', err = ''
    let done = false
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r) } }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已经退出 */ }
      finish({ ok: false, reason: 'failed', error: `对话框等了 ${Math.round(timeoutMs / 60000)} 分钟没有响应` })
    }, timeoutMs)
    child.stdout?.on('data', (b) => { out += b.toString() })
    child.stderr?.on('data', (b) => { err += b.toString() })
    child.on('error', (e) => {
      // 命令不存在 / 没有图形会话（Linux 上没有 DISPLAY）都走这里
      finish({ ok: false, reason: 'unsupported', error: e?.message ?? String(e) })
    })
    child.on('exit', (code) => finish(parsePickResult({ platform, code, stdout: out, stderr: err })))
  })
}
