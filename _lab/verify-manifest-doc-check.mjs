/**
 * 反向验证 `gen/check-manifest-doc.mjs` 真的会失败
 * ===============================================
 *
 * 一个从不失败的检查等于没有检查 —— 这是本项目反复吃过亏的地方
 * （见 `行为与运行.md`：好几条"看着像检查"的东西其实永远绿）。
 *
 * 做法：把文档**临时改坏**，跑检查，确认它退出码非 0；再恢复，确认它退出 0。
 * 全程在同一个脚本里，用 try/finally 保证一定恢复原文（不留下改坏的文档）。
 *
 * 用例：
 *   ① 字段改名（`rel` → `path`）—— 模拟"文档与实现分家"
 *   ② 字段表里塞一个实现里没有的字段（`mtime`）
 *   ③ 对照表里把**已经实现**的字段列为"旧文档字段"
 *
 * 用法：node _lab/verify-manifest-doc-check.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CHECK = path.join(ROOT, 'gen', 'check-manifest-doc.mjs')
const target = path.join(ROOT, '中文文档', 'PROTOCOL.md')

const runCheck = () => spawnSync(process.execPath, [CHECK], { cwd: ROOT, encoding: 'utf8' })

const original = readFileSync(target, 'utf8')
let bad = 0

const cases = [
  ['字段改名 rel → path', (s) => s.replace('`files[].rel` | string | 是 |', '`files[].path` | string | 是 |')],
  ['字段表混入实现里没有的字段', (s) => s.replace(
    '| `gift` | object \\| null | 是 | 赠品摘要',
    '| `mtime` | number | 否 | 假装有 |\n| `gift` | object \\| null | 是 | 赠品摘要')],
  ['对照表把已实现的字段列为旧字段', (s) => s.replace(
    '> | `files[].gift` | `files[].kind` |',
    '> | `files[].rel` | `files[].kind` |')],
]

try {
  const clean = runCheck()
  if (clean.status !== 0) {
    console.error(`✗ 前提不成立：没改过的文档也过不了检查\n${clean.stdout}${clean.stderr}`)
    process.exit(1)
  }
  for (const [name, mutate] of cases) {
    const mutated = mutate(original)
    if (mutated === original) {
      console.error(`✗ 用例「${name}」没有真正改动文档 —— 判据写错了，等于没验`)
      bad++
      continue
    }
    writeFileSync(target, mutated)
    const r = runCheck()
    if (r.status === 0) {
      console.error(`✗ 用例「${name}」：文档被改坏了，检查却通过了`)
      bad++
    } else {
      console.log(`✓ 用例「${name}」：检查如实报错`)
    }
  }
} finally {
  writeFileSync(target, original)
}

const after = runCheck()
if (after.status !== 0) {
  console.error(`✗ 恢复后检查仍然失败 —— 文档可能没恢复干净\n${after.stdout}${after.stderr}`)
  bad++
} else {
  console.log('✓ 已恢复原文，检查重新通过')
}

if (bad) {
  console.error(`\n${bad} 处反向验证未通过`)
  process.exit(1)
}
console.log('✓ 反向验证通过：这条检查该失败的时候确实会失败')
