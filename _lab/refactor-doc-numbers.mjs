/**
 * 一次性重构：把文档里过时的数字与状态说法改对
 * ============================================
 * 用户要求"看看文档里有没有错误"。逐条核对了会随时间变化的东西：
 *   · i18n 文案条数（171 → 319）
 *   · 单文件产物大小（89.5/91 MB → 94 MB）
 *   · 文档份数（各 10 份 → 各 12 份）
 *   · 示例输出里的版本号（v1.0.0 → 0.1.0）
 * 只改**当前事实**的陈述；表示"当时那个产物"的历史叙述保持原样。
 *
 * 用法：
 *   node _lab/refactor-doc-numbers.mjs          # 只报告
 *   node _lab/refactor-doc-numbers.mjs --apply  # 真的改
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APPLY = process.argv.includes('--apply')

/** [文件, 原文, 新文, 说明] —— 逐条列出来，避免正则误伤 */
const EDITS = [
  ['中文文档/路线图.md', '文案表（171 条中英并列）', '文案表（319 条中英并列）', 'i18n 条数'],
  ['中文文档/路线图.md', '（171 条文案，中英并列）', '（319 条文案，中英并列）', 'i18n 条数'],
  ['中文文档/路线图.md', '文案表（171 条）', '文案表（319 条）', 'i18n 条数'],
  ['docs/路线图.md', '(171 strings, Chinese and English side by side)',
    '(319 strings, Chinese and English side by side)', 'i18n 条数'],
  ['变更记录.md', '171 条文案并列', '319 条文案并列', 'i18n 条数'],
  ['CHANGELOG.md', '171 strings side by side', '319 strings side by side', 'i18n 条数'],

  ['中文文档/架构决策.md', '约 89.5 MB', '约 94 MB', '产物大小（当前事实）'],
  ['docs/架构决策.md', 'about 89.5 MB', 'about 94 MB', '产物大小（当前事实）'],
  ['中文文档/路线图.md', 'flicker-0.1.0-windows-x64.exe (91 MB)', 'flicker-0.1.0-windows-x64.exe (94 MB)', '示例输出'],
  ['docs/路线图.md', 'flicker-0.1.0-windows-x64.exe (91 MB)', 'flicker-0.1.0-windows-x64.exe (94 MB)', '示例输出'],
  ['变更记录.md', 'Node SEA 打包，约 91 MB', 'Node SEA 打包，约 94 MB', '产物大小（当前事实）'],
  ['CHANGELOG.md', 'packed with Node SEA, about 91 MB', 'packed with Node SEA, about 94 MB', '产物大小（当前事实）'],

  ['变更记录.md', '各 10 份，结构由机器守着一致', '各 12 份，结构由机器守着一致', '文档份数'],
  ['CHANGELOG.md', 'ten each, with their structure', 'twelve each, with their structure', '文档份数'],

  ['中文文档/使用手册.md', '⚡ 闪传 Flicker  v1.0.0  ·  一次性文件传输',
    '⚡ 闪传 Flicker  v0.1.0  ·  一次性文件传输', '示例输出里的版本号'],
  ['docs/使用手册.md', '⚡ 闪传 Flicker  v1.0.0  ·  一次性文件传输',
    '⚡ 闪传 Flicker  v0.1.0  ·  一次性文件传输', '示例输出里的版本号'],
]

const changed = new Map()
for (const [file, from, to, why] of EDITS) {
  const full = path.join(ROOT, file)
  const src = readFileSync(full, 'utf8')
  if (!src.includes(from)) {
    console.log(`－ ${file}：找不到「${from.slice(0, 40)}…」（可能已经改过）`)
    continue
  }
  const n = src.split(from).length - 1
  console.log(`${APPLY ? '✓' : '·'} ${file}  ${n} 处  ${why}：${from.slice(0, 30)}… → ${to.slice(0, 30)}…`)
  if (APPLY) changed.set(file, src.split(from).join(to))
}
if (APPLY) for (const [file, text] of changed) writeFileSync(path.join(ROOT, file), text, 'utf8')
else console.log('\n（只报告。要真的改：node _lab/refactor-doc-numbers.mjs --apply）')
