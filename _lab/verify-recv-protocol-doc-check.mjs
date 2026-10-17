/**
 * 反向验证 `gen/check-recv-protocol-doc.mjs` 真的会失败
 * ===================================================
 *
 * 一个从不失败的检查等于没有检查 —— 本项目在这上面吃过亏
 * （见 `行为与运行.md`：好几条"看着像检查"的东西其实永远绿）。
 *
 * 做法：把文档**临时改坏**，跑检查，确认它退出码非 0；再恢复，确认它退出 0。
 * 全程用 try/finally 保证恢复原文（不留下改坏的文档）。
 *
 * 用例（每一项都对应一类真实发生过的漂移）：
 *   ① 端点表里把路径写错一个词（`/up/status` → `/up/state`）
 *   ② 端点表里**删掉**一行
 *   ③ 端点表里**加**一个实现中不存在的端点
 *   ④ 成功响应的 json 样例里改一个字段名（`partSuffix` → `suffix`）
 *   ⑤ json 样例里改一个**有意义的固定值**（`maxFiles` 5000 → 4999）
 *   ⑥ 错误表里把一个状态码写错（`TOKEN_INVALID` 403 → 401）
 *   ⑦ 错误表里**删掉**一个接收模式独有的码（`NO_SPACE`）
 *
 * 用法：node _lab/verify-recv-protocol-doc-check.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CHECK = path.join(ROOT, 'gen', 'check-recv-protocol-doc.mjs')
const target = path.join(ROOT, '中文文档', 'PROTOCOL.md')

const runCheck = () => spawnSync(process.execPath, [CHECK], { cwd: ROOT, encoding: 'utf8' })

const STATUS_ROW = '| `GET` | `/up/status` | `SID` | 已收到哪些块（断线续传用） |'
const FINISH_ROW = '| `POST` | `/up/finish` | `SID` | 收尾：整文件摘要校验 → 定稿改名 |'

const original = readFileSync(target, 'utf8')
let bad = 0

const cases = [
  ['端点表把路径写错（/up/status → /up/state）',
    (s) => s.replace(STATUS_ROW, STATUS_ROW.replace('/up/status', '/up/state'))],
  ['端点表删掉一行',
    (s) => s.replace(`${STATUS_ROW}\n`, '')],
  ['端点表加一个实现里没有的端点',
    (s) => s.replace(FINISH_ROW, `| \`POST\` | \`/up/reset\` | \`SID\` | 假装有这个端点 |\n${FINISH_ROW}`)],
  ['json 样例里改字段名（partSuffix → suffix）',
    (s) => s.replace('  "partSuffix": ".flicker-part"', '  "suffix": ".flicker-part"')],
  ['json 样例里改一个有意义的固定值（maxFiles 5000 → 4999）',
    (s) => s.replace('    "maxFiles": 5000,', '    "maxFiles": 4999,')],
  ['错误表里把状态码写错（TOKEN_INVALID 403 → 401）',
    (s) => s.replace('| `TOKEN_INVALID` | `403` |', '| `TOKEN_INVALID` | `401` |')],
  ['错误表里删掉一个接收模式独有的码（NO_SPACE）',
    (s) => s.replace('| `NO_SPACE` | `507` | 可用空间 < 总量 × 1.1 | **开工前**拒绝；清出空间后重来 |\n', '')],
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
