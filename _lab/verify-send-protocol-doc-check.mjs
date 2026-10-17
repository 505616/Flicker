/**
 * 反向验证 `gen/check-send-protocol-doc.mjs` 真的会失败
 * ===================================================
 *
 * 一个从不失败的检查等于没有检查 —— 这条判据本身就是因为"文档整张写错、
 * 而本机测试全绿"才加的，所以更要证明它真的会拦。
 *
 * 做法：把文档**临时改坏**，跑检查，确认退出码非 0；再恢复，确认退出 0。
 * 全程用 try/finally 保证恢复原文。
 *
 * 用例（每一项都对应 §7 真实发生过的漂移）：
 *   ① 路径少了 `/api/` 前缀（`/api/session` → `/session`）
 *   ② 端点表里**删掉**一行（`/api/manifest`）
 *   ③ 端点表里**加**一个实现中不存在的端点
 *   ④ 响应头写错（`X-Flicker-Tag` → `X-Flicker-Seq`）
 *   ⑤ 状态码写错（`416` → `400`）
 *   ⑥ §7.2 把 SID 的传递方式写回成请求头（删掉 `?sid=`）
 *
 * 用法：node _lab/verify-send-protocol-doc-check.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CHECK = path.join(ROOT, 'gen', 'check-send-protocol-doc.mjs')
const target = path.join(ROOT, '中文文档', 'PROTOCOL.md')

const runCheck = () => spawnSync(process.execPath, [CHECK], { cwd: ROOT, encoding: 'utf8' })

const MANIFEST_ROW = '| `GET` | `/api/manifest` | `SID`（见 §7.2） | 返回清单密文 `{iv, ct, tag}` |'
const HEALTH_ROW = '| `GET` | `/api/health` | 无 | 就绪探测：纯文本 `ok`；**无副作用、不泄露任何会话信息** |'

const original = readFileSync(target, 'utf8')
let bad = 0

const cases = [
  ['路径少了 /api/ 前缀（/api/session → /session）',
    (s) => s.replace('| `GET` | `/api/session` |', '| `GET` | `/session` |')],
  ['端点表删掉一行（/api/manifest）',
    (s) => s.replace(`${MANIFEST_ROW}\n`, '')],
  ['端点表加一个实现里没有的端点',
    (s) => s.replace(HEALTH_ROW, `${HEALTH_ROW}\n| \`GET\` | \`/api/reset\` | 无 | 假装有这个端点 |`)],
  ['响应头写错（X-Flicker-Tag → X-Flicker-Seq）',
    (s) => s.replace('X-Flicker-Tag: <BASE64(GCM tag)>', 'X-Flicker-Seq: 12345')],
  ['状态码写错（416 → 400）',
    (s) => s.replace('| `416` | `seq` 非法或超出 `totalChunks` |', '| `400` | `seq` 非法或超出 `totalChunks` |')],
  ['§7.2 把 SID 的传递方式写回成请求头（删掉 ?sid=）',
    (s) => s.replace('**查询参数** `?sid=<SID>`', '**请求头** `X-Flicker-Sid`')],
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
