/**
 * 检查脚本文件的行尾与 BOM 是否符合各自平台的约定。
 *
 * 为什么需要它：这个坑**已经踩过一次**，而且症状极具误导性 ——
 *   启动.cmd 是 LF 行尾时，Windows 的 `cmd.exe` 会让里面的 `for /f` 解析失效，
 *   于是版本号读成空值，脚本错误地判定"Node 太旧"并**打开 Node 下载页**。
 *   用户看到的现象是"我明明装了 Node，双击却让我去下载 Node" ——
 *   完全联想不到是行尾问题（我自己也是逐行实验才定位到）。
 *
 *   Git 的 `core.autocrlf` 设置、跨平台编辑器、甚至某些工具的输出
 *   都会在不知不觉中改掉行尾。所以必须机器来守。
 *
 * 约定：
 *   · `.cmd` / `.bat`  → 必须 **CRLF、无 BOM**（cmd.exe 的要求）
 *   · `.sh` / `.command` → 必须 **LF、无 BOM**（Unix shell 的要求；
 *     LF 的 .sh 在 Windows 上 Git 检出时若被转成 CRLF 会报
 *     `bad interpreter: /bin/sh^M`）
 *   · `.js` / `.mjs` / `.json` / `.md` / `.html` → 不作限制（都能处理），
 *     但**不许有 BOM**（BOM 会破坏 JSON.parse 与不少工具）
 *   · 所有文本文件 → 必须是**合法 UTF-8**（见下面 ③ 的说明）
 *
 * 用法：node gen/check-line-endings.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 严格 UTF-8 解码器：遇到坏字节**抛错**，而不是悄悄换成 U+FFFD。
 * 只有会抛错才可能当判据用 —— `Buffer.toString('utf8')` 永远不报错。
 */
const strictUtf8 = new TextDecoder('utf-8', { fatal: true })

/** 要检查的扩展名 → 期望的行尾（null = 不限制） */
const RULES = {
  '.cmd': 'CRLF',
  '.bat': 'CRLF',
  '.sh': 'LF',
  '.command': 'LF',
  '.js': null, '.mjs': null, '.cjs': null,
  '.json': null, '.md': null, '.html': null, '.yml': null, '.txt': null,
}

/** 检查 BOM 的扩展名（BOM 对这些格式都有害） */
const NO_BOM = new Set(Object.keys(RULES))

function collect(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'dist') continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) collect(full, out)
    else out.push(full)
  }
  return out
}

const files = collect(ROOT)
let bad = 0

for (const f of files) {
  const ext = path.extname(f).toLowerCase()
  if (!(ext in RULES)) continue

  const buf = readFileSync(f)
  const rel = path.relative(ROOT, f).replace(/\\/g, '/')

  // ① BOM
  if (NO_BOM.has(ext) && buf.length >= 3 &&
      buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    console.error(`✗ ${rel}：有 UTF-8 BOM。` +
      'BOM 会被当成内容的一部分（cmd.exe 会把它当命令、JSON.parse 会直接失败）。')
    bad++
  }

  // ② 行尾
  let crlf = 0, bareLf = 0
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) { if (i > 0 && buf[i - 1] === 0x0d) crlf++; else bareLf++ }
  }
  const want = RULES[ext]
  if (want === 'CRLF' && bareLf > 0) {
    console.error(`✗ ${rel}：是 ${ext} 文件，但有 ${bareLf} 个裸 LF 行尾（应为全 CRLF）。\n` +
      '    cmd.exe 对 LF-only 的批处理解析不完整：for /f、goto、if 都可能失效。\n' +
      '    实测症状：版本号读成空值 → 误判"Node 太旧" → 打开下载页。')
    bad++
  }
  if (want === 'LF' && crlf > 0) {
    console.error(`✗ ${rel}：是 ${ext} 文件，但有 ${crlf} 个 CRLF 行尾（应为全 LF）。\n` +
      '    Unix 下会报 `bad interpreter: /bin/sh^M`。')
    bad++
  }

  // ③ 必须是合法 UTF-8
  //
  // 为什么必须机器来查：这个坑也踩过一次，而且**没有任何测试会失败**。
  // 用 Windows PowerShell 5.1 的 `Set-Content` 改一个含中文/破折号的 markdown 时，
  // 它按 ANSI 编码回写，每个非 ASCII 字符的最后一个字节变成 `?`
  // （`e2 80 94` → `e2 80 3f`）。文件照样"能打开"，只是所有破折号、勾号、
  // 中文文档名全花了 —— 而且是在 GitHub 上被别人先看见。
  // 用 `fatal: true` 解码才能发现：普通 `toString('utf8')` 只会悄悄塞 U+FFFD。
  try {
    strictUtf8.decode(buf)
  } catch {
    const rel2 = rel
    console.error(`✗ ${rel2}：不是合法的 UTF-8。\n` +
      '    常见原因：用 PowerShell 的 `Set-Content`（默认 ANSI）或用 GBK 编辑器\n' +
      '    保存过这个文件 —— 非 ASCII 字符会被写成 `?` 或乱码，而文件仍能打开。\n' +
      '    请用 UTF-8 重新保存（本项目所有文本文件都是 UTF-8）。')
    bad++
  }
}

if (bad) {
  console.error(`\n${bad} 处行尾/BOM 不合约定`)
  process.exit(1)
}
console.log(`✓ 行尾与 BOM 都符合约定（检查了 ${files.length} 个文件）`)
