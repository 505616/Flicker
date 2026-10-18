/**
 * 原生「选择文件夹」对话框（`src/native-pick.js`）
 * ==============================================
 * 2026-10 用户提的两条，这条判据就是围着它们写的：
 *
 *   "选择文件夹的提示文字不是对应的，只要选择一个文件就从『存到这里』变成『就发这些』"
 *   "而且不能新建文件夹，要不还是用原生的对话框吧"
 *
 * 结论是给"选保存目录"这件事换成**系统自带**的对话框（Windows: FolderBrowserDialog /
 * macOS: choose folder / Linux: zenity），拿不到再退回程序自带的选择器。
 *
 * ⚠️ 这里**一个窗口都不许弹**（本项目"绝不自动化窗口化操作"那条规则），
 *    所以判据只验"命令长什么样"和"结果怎么翻译"，不真的调起来：
 *
 *   ① **命令拼得对**：每个平台的命令与参数、标题里的引号会不会把脚本拼坏、
 *      能不能新建文件夹（Windows 的 `ShowNewFolderButton`、Linux 的 `--directory`）。
 *   ② **拿不到就明说**：没有图形会话 / 没装 zenity / 被 `FLICKER_NO_NATIVE_PICK=1`
 *      关掉时，必须返回 `unsupported`/`disabled`，**而且一次都不许去 spawn**
 *      （否则自动化里就真弹窗了）。
 *   ③ **"取消"不能当成失败**：三个平台取消时长得都不一样（Windows 是自己 `exit 3`、
 *      osascript 是 `-128`、zenity 是退出码 1 且没 stderr）—— 都要翻译成 `cancelled`。
 *   ④ **中文路径不许变成乱码**：Windows 上 `[Console]::OutputEncoding` 必须钉成 UTF-8，
 *      否则 `D:\闪传` 回来是乱码（这一条是实测踩出来的，注释里记着）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  PICK_TIMEOUT_MS, asQuote, buildPickCommand, onPath, parsePickResult, pickFolder, powershellPath, psQuote, unavailableReason,
} from '../src/native-pick.js'

// ── ① 命令拼得对 ─────────────────────────────────────────────

test('Windows：用 System32 里的 PowerShell 5.1 + -STA（FolderBrowserDialog 是 COM，MTA 下会抛）', () => {
  // ⚠️ 注入 `exists: () => true`：这条验的是**命令拼法**，不该因为"宿主是 Linux、
  //    没有 C:\Windows\...\powershell.exe"而红（CI 上就是这么红的）。
  const c = buildPickCommand({
    platform: 'win32', title: '选择存到哪个文件夹', startDir: 'D:\\闪传',
    env: { ...process.env, SystemRoot: 'C:\\Windows' }, exists: () => true,
  })
  assert.ok(c, 'Windows 上应当给出命令（这台机器有 System32\\WindowsPowerShell）')
  assert.match(c.cmd, /powershell\.exe$/i)
  assert.ok(c.args.includes('-STA'), '必须带 -STA')
  assert.ok(c.args.includes('-NoProfile'), '别加载用户的 profile（会变慢、还可能报错）')
  const script = c.args[c.args.length - 1]
  assert.match(script, /FolderBrowserDialog/, '要的就是"选择文件夹"那个对话框')
  assert.match(script, /ShowNewFolderButton = \$true/, '必须能新建文件夹（用户点名要的）')
  assert.match(script, /选择存到哪个文件夹/, '标题要写进 Description')
  assert.match(script, /\[Console\]::OutputEncoding = \[System\.Text\.Encoding\]::UTF8/,
    '输出编码必须钉成 UTF-8 —— 否则中文路径回来是乱码')
  assert.match(script, /D:\\闪传/, '起始目录要带进 SelectedPath')
})

test('⭐ Windows：先造一个 TopMost 主人窗口再 ShowDialog(owner)（否则窗口会被压在浏览器后面）', () => {
  // 2026-10 用户实测"系统对话框没有弹出来"：实测发现对话框**建出来了**
  // （进程里有可见的 #32770），但发起它的进程没有前台窗口，Windows 把它压到后面。
  const c = buildPickCommand({
    platform: 'win32', title: '存到哪', startDir: 'D:\\x',
    env: { ...process.env, SystemRoot: 'C:\\Windows' }, exists: () => true,
  })
  const script = c.args[c.args.length - 1]
  assert.match(script, /\$o\.TopMost = \$true/, '主人窗口必须是 TopMost')
  assert.match(script, /ShowDialog\(\$o\)/, '对话框要挂在主人窗口上（模态子窗口跟主人一起到前面）')
  assert.match(script, /SetForegroundWindow/, '显示时要试着抢一次前台')
  assert.match(script, /dialog-opening/, '要往 stderr 写一行标记，界面日志据此判断"到底弹了没有"')
  assert.match(script, /\$o\.Close\(\)/, '选完要把主人窗口收掉（否则留一个 1×1 的透明窗口）')
  assert.ok(!c.args.includes('-NonInteractive'), '去掉 -NonInteractive：它只影响控制台提示，留着没好处')
})

test('Windows：没有 System32 里那个 PowerShell 就不给命令（不猜别的）', () => {
  const c = buildPickCommand({
    platform: 'win32', title: 'x', env: { SystemRoot: 'C:\\nowhere', windir: 'C:\\nowhere' },
    exists: () => false,
  })
  assert.equal(c, null)
  assert.equal(powershellPath({ env: { SystemRoot: 'C:\\nowhere' }, exists: () => false }), null)
})

test('macOS：osascript + choose folder（有起始目录就带 default location）', () => {
  const c = buildPickCommand({ platform: 'darwin', title: '存到哪', startDir: '/Users/a/Downloads' })
  assert.equal(c.cmd, 'osascript')
  const script = c.args[c.args.length - 1]
  assert.match(script, /POSIX path of \(choose folder/)
  assert.match(script, /default location POSIX file "\/Users\/a\/Downloads"/)
})

test('Linux：zenity --file-selection --directory（取消时退出码 1、stderr 为空）', () => {
  const c = buildPickCommand({ platform: 'linux', title: '存到哪', startDir: '/home/a' })
  assert.equal(c.cmd, 'zenity')
  assert.ok(c.args.includes('--directory'))
  assert.ok(c.args.includes('--file-selection'))
  assert.ok(c.args.includes('--title=存到哪'))
  assert.ok(c.args.some((a) => a.startsWith('--filename=/home/a/')))
})

test('不认识的平台：明确不给命令（而不是猜一个）', () => {
  assert.equal(buildPickCommand({ platform: 'freebsd', title: 'x' }), null)
})

test('标题里带引号也不能把脚本拼坏（单引号/双引号两种方言都要挡住）', () => {
  assert.equal(psQuote("a'b"), "'a''b'")
  assert.equal(asQuote('a"b'), '"a\\"b"')
  assert.equal(asQuote('a\\b'), '"a\\\\b"')
  const win = buildPickCommand({
    platform: 'win32', title: "it's", env: { ...process.env, SystemRoot: 'C:\\Windows' }, exists: () => true,
  })
  assert.match(win.args[win.args.length - 1], /Description = 'it''s'/)
  const mac = buildPickCommand({ platform: 'darwin', title: 'say "hi"' })
  assert.match(mac.args[mac.args.length - 1], /prompt "say \\"hi\\""/)
})

// ── ② 拿不到就明说（而且不许 spawn）────────────────────────────

test('FLICKER_NO_NATIVE_PICK=1 → disabled（自动化靠它保证一个窗都不弹）', () => {
  assert.equal(unavailableReason({ platform: 'win32', env: { FLICKER_NO_NATIVE_PICK: '1' } }), 'disabled')
  assert.equal(unavailableReason({ platform: 'linux', env: { FLICKER_NO_NATIVE_PICK: '1', PATH: '/usr/bin' } }), 'disabled')
})

test('没有可用命令 → unsupported（不认的平台也一样）', () => {
  assert.equal(unavailableReason({ platform: 'linux', env: {}, has: () => false }), 'unsupported')
  assert.equal(unavailableReason({ platform: 'freebsd', env: {}, has: () => true }), 'unsupported')
  assert.equal(unavailableReason({ platform: 'linux', env: {}, has: (c) => c === 'zenity' }), null)
  assert.equal(unavailableReason({ platform: 'darwin', env: {}, has: (c) => c === 'osascript' }), null)
})

test('⭐ 拿不到对话框时**一次都不去 spawn**（自动化里绝不能真弹窗）', async () => {
  let spawned = 0
  const r = await pickFolder({
    platform: 'linux', env: {}, has: () => false,
    spawnImpl: () => { spawned++; throw new Error('不该走到这里') },
  })
  assert.deepEqual(r, { ok: false, reason: 'unsupported' })
  assert.equal(spawned, 0)

  const r2 = await pickFolder({
    platform: 'win32', env: { FLICKER_NO_NATIVE_PICK: '1' },
    spawnImpl: () => { spawned++; throw new Error('不该走到这里') },
  })
  assert.deepEqual(r2, { ok: false, reason: 'disabled' })
  assert.equal(spawned, 0)
})

test('命令起不来（没有图形会话 / 命令被删）→ unsupported，不是崩溃', async () => {
  const r = await pickFolder({
    platform: 'linux', env: {}, has: (c) => c === 'zenity',
    spawnImpl: () => { throw Object.assign(new Error('spawn zenity ENOENT'), { code: 'ENOENT' }) },
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'unsupported')
})

// ── ③ "取消"不能当成失败 ────────────────────────────────────

test('三个平台的"用户点了取消"都翻译成 cancelled', () => {
  assert.deepEqual(parsePickResult({ platform: 'win32', code: 3 }), { ok: false, cancelled: true })
  assert.deepEqual(parsePickResult({ platform: 'darwin', code: 1, stderr: 'execution error: User canceled. (-128)' }),
    { ok: false, cancelled: true })
  assert.deepEqual(parsePickResult({ platform: 'linux', code: 1 }), { ok: false, cancelled: true })
})

test('真选了一个目录 → ok，路径去掉结尾的分隔符（osascript 会给结尾斜杠）', () => {
  assert.deepEqual(parsePickResult({ platform: 'darwin', code: 0, stdout: '/Users/a/Downloads/\n' }),
    { ok: true, path: '/Users/a/Downloads' })
  assert.deepEqual(parsePickResult({ platform: 'win32', code: 0, stdout: 'D:\\闪传\r\n' }),
    { ok: true, path: 'D:\\闪传' })
})

test('真的失败了 → failed 且带上原因（不许悄悄当成取消）', () => {
  const r = parsePickResult({ platform: 'linux', code: 2, stderr: 'cannot open display' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'failed')
  assert.match(r.error, /cannot open display/)
})

// ── ④ 真的"跑"一遍（只到进程边界，不进窗口）────────────────

/** 假子进程：只要 stdout/stderr 能发 data、能 emit('exit')、能 kill() */
function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killed = false
  child.kill = () => { child.killed = true }
  return child
}

const runLinux = (onRun, opts = {}) => pickFolder({
  platform: 'linux', env: {}, has: (c) => c === 'zenity',
  spawnImpl: () => {
    const child = fakeChild()
    onRun(child)
    return child
  },
  ...opts,
})

test('子进程给出路径 → ok（顺带带回 stderr，供界面日志判断"到底弹了没有"）', async () => {
  assert.deepEqual(await runLinux((child) => {
    setTimeout(() => {
      child.stderr.emit('data', Buffer.from('dialog-opening\n'))
      child.stdout.emit('data', Buffer.from('/tmp/x\n'))
      child.emit('exit', 0)
    }, 5)
  }), { ok: true, path: '/tmp/x', stderr: 'dialog-opening' })
})

test('子进程退出码 1 且没有 stderr → cancelled（zenity 的取消长这样）', async () => {
  assert.deepEqual(await runLinux((child) => {
    setTimeout(() => child.emit('exit', 1), 5)
  }), { ok: false, cancelled: true, stderr: '' })
})

test('超时 → failed（并且真的去 kill 了那个子进程）', async () => {
  let killed = false
  const r = await pickFolder({
    platform: 'linux', env: {}, has: (c) => c === 'zenity', timeoutMs: 20,
    spawnImpl: () => {
      const child = fakeChild()
      child.kill = () => { killed = true }
      return child
    },
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'failed')
  assert.match(r.error, /没有响应/)
  assert.ok(killed, '超时必须把子进程杀掉，不能留着')
})

test('超时是 10 分钟（够用户走开一会儿，但别让子进程永远挂着）', () => {
  assert.equal(PICK_TIMEOUT_MS, 10 * 60 * 1000)
})

test('onPath：PATH 里没有的命令不算有（Linux 上不猜 zenity 在哪）', () => {
  assert.equal(onPath('这个命令不存在-xyz', { PATH: process.env.PATH }), false)
})
