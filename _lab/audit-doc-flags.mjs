/**
 * 一次性排查：文档里写的命令行参数，程序真的认吗？
 * 用法：node _lab/audit-doc-flags.mjs
 *
 * 做法（刻意简单、可复核）：
 *   ① 从 bin/flicker.js 里抓出**真正被读到的** flag 名（`flags.xxx` / `flags['xxx']`）+ USAGE 里列出的；
 *   ② 从两份使用手册的"参数参考"章节抓出 `--xxx` 形式的名字；
 *   ③ 差集 = 文档提到、程序不认的（会误导用户）；反向差集 = 程序认、文档没写的。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = readFileSync(path.join(ROOT, 'bin', 'flicker.js'), 'utf8')

const known = new Set()
for (const m of cli.matchAll(/flags\.([a-zA-Z][\w-]*)/g)) known.add(m[1])
for (const m of cli.matchAll(/flags\[['"]([\w-]+)['"]\]/g)) known.add(m[1])
// USAGE 文本里列出来的（`--xxx` 形式）
const usage = cli.slice(cli.indexOf('const USAGE'), cli.indexOf('/** 解析 --key=value'))
for (const m of usage.matchAll(/--([a-z][\w-]*)/g)) known.add(m[1])
known.delete('plugin')   // 由 registry 读取，不经过 flags
known.add('plugin')

const docFlags = new Map()
for (const rel of ['中文文档/使用手册.md', 'docs/使用手册.md']) {
  const txt = readFileSync(path.join(ROOT, rel), 'utf8')
  // 只看参数参考章节：从"完整参数参考"到下一个一级标题
  const start = txt.search(/^## .*(完整参数参考|Complete option reference)/m)
  const rest = start >= 0 ? txt.slice(start) : txt
  const section = rest.split(/^## /m).slice(0, 2).join('\n')
  for (const m of section.matchAll(/`--([a-z][\w-]*)/g)) {
    if (!docFlags.has(m[1])) docFlags.set(m[1], [])
    docFlags.get(m[1]).push(rel)
  }
}

const missing = [...docFlags.keys()].filter((f) => !known.has(f)).sort()
console.log(`程序认识的 flag：${[...known].sort().join(', ')}\n`)
if (missing.length) {
  console.log('⚠️ 文档参数表里写了、但程序不认的：')
  for (const f of missing) console.log(`   --${f}   （出现在 ${docFlags.get(f).join('、')}）`)
} else {
  console.log('✓ 文档参数表里的 flag 程序都认')
}
