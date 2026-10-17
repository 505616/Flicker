/**
 * 插件缺口清单两处一致（测试）
 * ============================
 *
 * `插件.md` §11 与 `路线图.md` §十三 记的是**同一批**"插件还没做的事"，
 * 而 2026-10 的真实状况是：前者列了 6 条，后者搜"插件"命中 **0** ——
 * 一个已经发出去的功能、连同它剩下的缺口，都不在"进度的唯一权威"里。
 *
 * 这与 `manifest-doc.test.js` / `recv-protocol-doc.test.js` / `send-protocol-doc.test.js`
 * 守的是同一类问题：**两份东西必须对得上，而没有任何人会同时读两份**。
 *
 * 这里不重写比对逻辑，直接跑 `gen/check-plugin-gaps.mjs`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

test('⭐ 插件缺口清单两处一致（插件.md §11 ↔ 路线图 §十三，中英各一对）', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'gen', 'check-plugin-gaps.mjs')], {
    encoding: 'utf8', cwd: ROOT,
  })
  assert.equal(r.status, 0,
    `插件缺口清单对不上：\n${r.stdout || ''}${r.stderr || ''}`)
})

test('中英两份的缺口**条数**也要一致（译文不该少写一条）', () => {
  /** 取某一节表格的『计划』列条数 */
  const count = (file, id, width) => {
    const lines = readFileSync(path.join(ROOT, file), 'utf8').split('\n')
    const start = lines.findIndex((l) => l.startsWith('## ') && l.slice(3).startsWith(id))
    assert.ok(start >= 0, `${file} 里找不到以「${id}」开头的一级标题`)
    let end = lines.length
    for (let k = start + 1; k < lines.length; k++) {
      if (/^## /.test(lines[k])) { end = k; break }
    }
    let n = 0
    for (const l of lines.slice(start, end)) {
      if (!/^\s*\|.*\|\s*$/.test(l) || /^>\s*\|/.test(l)) continue
      const cells = l.split('|').slice(1, -1).map((c) => c.trim())
      if (cells.every((c) => /^-+$/.test(c.replace(/[:\s]/g, '-')))) continue   // 分隔行
      if (cells.includes('计划') || cells.includes('Plan')) continue             // 表头
      if (cells.length === width) n++
    }
    assert.ok(n > 0, `${file} §${id}：一行都没解析出来（表格式变了？）`)
    return n
  }
  for (const [zhF, enF, zhId, enId, w] of [
    ['中文文档/插件.md', 'docs/插件.md', '十一、还没做的部分', '11. Not done yet', 2],
    ['中文文档/路线图.md', 'docs/路线图.md', '十三、插件系统', '13. Plugin system', 3],
  ]) {
    assert.equal(count(enF, enId, w), count(zhF, zhId, w),
      `${zhF} 与 ${enF} 的缺口条数不一致 —— 两边读者看到不同的清单`)
  }
})

test('这条检查进了检查链与 CI（否则只有手动跑才会发现漂移）', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.match(pkg.scripts.check, /check-plugin-gaps\.mjs/,
    'npm run check 里要跑插件缺口清单的一致性检查')
  const ci = readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
  assert.match(ci, /check-plugin-gaps\.mjs/, 'CI 里也要跑')
})

test('反向验证脚本在仓库里，且带一条"只改格式不该报错"的反例', () => {
  const src = readFileSync(path.join(ROOT, '_lab', 'verify-plugin-gaps-check.mjs'), 'utf8')
  assert.match(src, /writeFileSync\(c\.file, mutated\)/, '反向验证脚本应当真的去改坏文档再跑检查')
  assert.match(src, /finally/, '必须用 try/finally 保证恢复原文，不能留下改坏的文档')
  assert.match(src, /mustFail: false/,
    '要有一条"只是格式变了、不该报错"的反例 —— 否则证明不了它在区分"清单不一致"和"格式不一致"')
})
