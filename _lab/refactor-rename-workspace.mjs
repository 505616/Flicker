/**
 * 一次性重构：把注释/文档里对旧工作区路径的引用改成新名字
 * ======================================================
 * 用户把工作区从 `D:\新项目` 改名成 `D:\闪传`（"闪传"才是这个项目的名字）。
 * 仓库里有一批注释/文档举例引用了旧路径 —— 它们不影响运行，但改名之后就是错的。
 *
 * ⚠️ 只改**文本里的举例**与一处硬编码常量；`_lab/out/*.log` 是历史输出，不动。
 *
 * 用法：
 *   node _lab/refactor-rename-workspace.mjs          # 只报告
 *   node _lab/refactor-rename-workspace.mjs --apply  # 真的改
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APPLY = process.argv.includes('--apply')

/** 要改的文件（相对路径）—— 逐个列出，避免误伤 _lab/out 里的历史日志 */
const FILES = [
  '中文文档/构建单文件.md', 'docs/构建单文件.md',
  '中文文档/路线图.md', 'docs/路线图.md',
  '中文文档/设计文档.md', 'docs/设计文档.md',
  '中文文档/UI设计.md', 'docs/UI设计.md',
  'gen/npx.mjs',
  'src/gui.js',
  'test/gui.test.js',
  'web/station.html',
  '_lab/lab-cert.mjs',
]

let edits = 0
for (const rel of FILES) {
  const full = path.join(ROOT, rel)
  const src = readFileSync(full, 'utf8')
  const next = src.replaceAll('D:\\新项目', 'D:\\闪传').replaceAll('D:/新项目', 'D:/闪传')
  const n = (src.split('D:\\新项目').length - 1) + (src.split('D:/新项目').length - 1)
  if (!n) { console.log(`－ ${rel}：没有旧路径`); continue }
  edits += n
  console.log(`${APPLY ? '✓' : '·'} ${rel}  ${n} 处`)
  if (APPLY) writeFileSync(full, next, 'utf8')
}
console.log(`\n${APPLY ? '已改' : '要改'} ${edits} 处`)
if (!APPLY) console.log('（只报告。要真的改：node _lab/refactor-rename-workspace.mjs --apply）')
