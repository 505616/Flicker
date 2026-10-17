/**
 * 反向验证：文档配对检查**真的会失败**
 * ====================================
 *
 * 这个项目吃过"检查永远绿"的亏（见 `行为与运行.md`：好几条"看着像检查"的东西
 * 其实从来没失败过）。配对检查尤其危险：它比的是**数量**（标题数、围栏数、表格行数），
 * 一旦比较逻辑写错（比如遍历了一个空数组、或者根目录那几对根本没进循环），
 * 它就会安静地打印"✓ 一致"，而两份文档早就各说各话。
 *
 * 所以这里把文档**临时改坏**，看它是否如实报错，再恢复：
 *   ① 文件夹里的中文文档少一个二级标题 → 必须报错
 *   ② 根目录的 CHANGELOG.md 多一个三级标题（`ROOT_PAIRS` 那条路）→ 必须报错
 *   ③ 英文文档多一个代码围栏 → 必须报错
 *
 * ⚠️ 全程 try/finally：一定恢复原文（不留下改坏的文档）。
 *
 * 用法：node _lab/verify-pairs-check.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CHECK = path.join(ROOT, 'gen', 'check-doc-pairs.mjs')

const runCheck = () => spawnSync(process.execPath, [CHECK], { cwd: ROOT, encoding: 'utf8' })

/** 改一个文件、跑检查、恢复 —— 返回检查是否失败（true = 如实报错） */
function expectFail(file, mutate) {
  const target = path.join(ROOT, file)
  const original = readFileSync(target, 'utf8')
  try {
    const mutated = mutate(original)
    if (mutated === original) return { ok: false, why: '判据没改到东西（脚本写错了）' }
    writeFileSync(target, mutated)
    const r = runCheck()
    return r.status === 0
      ? { ok: false, why: '文档被改坏了，检查却通过了' }
      : { ok: true, why: (r.stdout + r.stderr).trim().split('\n').find((l) => l.startsWith('✗')) ?? '' }
  } finally {
    writeFileSync(target, original)
  }
}

let bad = 0
const clean = runCheck()
if (clean.status !== 0) {
  console.error(`✗ 前提不成立：没改过的文档也过不了检查\n${clean.stdout}${clean.stderr}`)
  process.exit(1)
}

const cases = [
  ['中文文档少一个二级标题（文件夹那对）',
    ['中文文档/PROTOCOL.md', (s) => s.replace('## 6. 应用层：manifest', '### 6. 应用层：manifest')]],
  ['英文 CHANGELOG 多一个三级标题（根目录那对）',
    ['CHANGELOG.md', (s) => s.replace('### Added', '### Added\n\n### An extra heading that only exists in English')]],
  ['英文文档多一个代码围栏',
    ['docs/构建单文件.md', (s) => s + '\n```\n多出来的一个围栏\n```\n']],
]

for (const [name, [file, mutate]] of cases) {
  const r = expectFail(file, mutate)
  if (r.ok) {
    console.log(`✓ 用例「${name}」：检查如实报错`)
    if (r.why) console.log(`      ${r.why}`)
  } else {
    console.error(`✗ 用例「${name}」：${r.why}`)
    bad++
  }
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
console.log('✓ 反向验证通过：配对检查该失败的时候确实会失败')
