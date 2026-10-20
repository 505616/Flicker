/**
 * `PROTOCOL.md` §7（发起方 HTTPS 服务）与实现一致（测试）
 * ====================================================
 *
 * §7.1 的端点表**整张写错过**，而且错了很久：路径少了 `/api/` 前缀、`/auth` 实际是
 * `start`/`finish` 两个端点、`/api/manifest` 与 `/api/health` 根本没进表；§7.2 说 SID 走
 * `X-Flicker-Sid` 请求头而实现读的是 `?sid=`；§7.3 的响应头与状态码也都不存在。
 *
 * 这与 `manifest-doc.test.js` / `recv-protocol-doc.test.js` 守的是**同一类**问题：
 * 文档与实现分家，而**本机测试全绿**（测试测的是实现），只有照文档写客户端的人会撞上。
 *
 * 这里不重写比对逻辑，直接跑 `gen/check-send-protocol-doc.mjs`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

test('⭐ §7 的发起方端点与真实实现一致（中英文各一份）', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'gen', 'check-send-protocol-doc.mjs')], {
    encoding: 'utf8', cwd: ROOT,
  })
  assert.equal(r.status, 0,
    `§7 与实现不一致：\n${r.stdout || ''}${r.stderr || ''}`)
})

test('两份文档的 §7.1 端点表列的是同一批端点（结构与顺序都该一致）', () => {
  /** 取 §7.1 表里的 [method, path]（路径截掉查询串） */
  const routes = (file) => {
    const lines = readFileSync(path.join(ROOT, file), 'utf8').split('\n')
    const start = lines.findIndex((l) => /^### 7\.1 /.test(l))
    assert.ok(start >= 0, `${file} 里找不到 §7.1`)
    let end = lines.length
    for (let k = start + 1; k < lines.length; k++) {
      if (/^#{2,3} /.test(lines[k])) { end = k; break }
    }
    const out = []
    for (const l of lines.slice(start, end)) {
      if (!/^\s*\|.*\|\s*$/.test(l)) continue       // 注意：`> |` 开头的引用块不算
      const cells = l.split('|').slice(1, -1).map((c) => c.trim())
      if (cells.length < 2) continue
      const method = (cells[0].match(/`([A-Z]+)`/) ?? [])[1]
      const p = (cells[1].match(/`([^`]+)`/) ?? [])[1]
      if (!method || !p) continue
      out.push(`${method} ${p.split('?')[0]}`)
    }
    assert.ok(out.length >= 5, `${file} 的 §7.1 只解析出 ${out.length} 行端点 —— 表结构变了？`)
    return out
  }
  assert.deepEqual(routes('docs/PROTOCOL.md'), routes('中文文档/PROTOCOL.md'),
    '两份文档的端点表必须逐行对应（顺序也一样）—— 否则两边读者看到不同的接口')
})

test('这条检查进了检查链与 CI（否则只有手动跑才会发现漂移）', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.match(pkg.scripts.check, /check-send-protocol-doc\.mjs/,
    'npm run check 里要跑 §7 与实现的一致性检查')
  const ci = readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
  assert.match(ci, /check-send-protocol-doc\.mjs/, 'CI 里也要跑')
})

test('反向验证脚本在仓库里（证明这条检查真的会失败）', () => {
  const src = readFileSync(path.join(ROOT, '_lab', 'verify-send-protocol-doc-check.mjs'), 'utf8')
  assert.match(src, /writeFileSync\(target, mutated\)/, '反向验证脚本应当真的去改坏文档再跑检查')
  assert.match(src, /finally/, '必须用 try/finally 保证恢复原文，不能留下改坏的文档')
})

test('⭐ 反向验证：临时改坏文档后这条检查确实会失败（脚本自己恢复原文）', () => {
  // 原来这里只断言"反向验证脚本在仓库里"，那等于把判据的作用托付给一段没人执行的代码：
  // 脚本可以一直在、检查却退化成永远通过，用例照样绿。所以现在**真的跑一遍**。
  // 脚本内部会改坏文档 → 跑检查（断言退出码非 0）→ 用 try/finally 恢复原文。
  const r = spawnSync(process.execPath, [path.join(ROOT, '_lab', 'verify-send-protocol-doc-check.mjs')], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000,
  })
  assert.equal(r.status, 0,
    `反向验证脚本应当通过（它内部断言"改坏之后检查会失败"）：\n${r.stdout}${r.stderr}`)
  assert.match(r.stdout, /反向验证通过/)
})
