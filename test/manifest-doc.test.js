/**
 * `PROTOCOL.md` §6.1 与实现一致（测试）
 * ====================================
 * 这一节写错过一次，而且错得很彻底：文档上的字段名（`protocol` / `session` /
 * `files[].path` / `files[].merkle` / `files[].mode` / `files[].mtime`）
 * 在实现里**一个都没有** —— 照文档写客户端会直接解析失败。
 *
 * 人眼审不出来：文档读起来通顺、字段名也合理。所以判据必须是机器检查，
 * 而且检查本身要**真的会失败**（`_lab/verify-manifest-doc-check.mjs` 负责证明这一点）。
 *
 * 这里不重写比较逻辑，直接跑 `gen/check-manifest-doc.mjs` ——
 * 两处各写一套的话，迟早出现"测试过了、检查没过"这种谁也说不清的场面。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

test('⭐ §6.1 的清单字段与真实代码一致（中英文各一份）', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'gen', 'check-manifest-doc.mjs')], {
    encoding: 'utf8', cwd: ROOT,
  })
  assert.equal(r.status, 0,
    `§6.1 与实现不一致：\n${r.stdout || ''}${r.stderr || ''}`)
})

test('两份文档的 §6.1 json 样例字段顺序一致（译文不该改结构）', () => {
  const grab = (file) => {
    const lines = readFileSync(path.join(ROOT, file), 'utf8').split('\n')
    const start = lines.findIndex((l) => /^### 6\.1 /.test(l))
    assert.ok(start >= 0, `${file} 里找不到 §6.1`)
    let end = lines.length
    for (let k = start + 1; k < lines.length; k++) {
      if (/^### /.test(lines[k])) { end = k; break }
    }
    let inFence = false
    let buf = null
    for (const l of lines.slice(start, end)) {
      if (l.trimStart().startsWith('```')) {
        if (!inFence && /^```json\s*$/.test(l.trimStart())) buf = []
        else if (inFence && buf) return JSON.parse(buf.join('\n'))
        inFence = !inFence
        continue
      }
      if (inFence && buf) buf.push(l)
    }
    throw new Error(`${file} 的 §6.1 里没有 json 样例`)
  }
  const zh = grab('中文文档/PROTOCOL.md')
  const en = grab('docs/PROTOCOL.md')
  assert.deepEqual(Object.keys(en), Object.keys(zh), '顶层字段顺序必须一致')
  assert.deepEqual(Object.keys(en.files[0]), Object.keys(zh.files[0]), 'files[] 字段顺序必须一致')
})

test('这条检查进了检查链与 CI（否则只有手动跑才会发现漂移）', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.match(pkg.scripts.check, /check-manifest-doc\.mjs/,
    'npm run check 里要跑 §6.1 与实现的一致性检查')
  const ci = readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
  assert.match(ci, /check-manifest-doc\.mjs/, 'CI 里也要跑')
})

test('反向验证脚本在仓库里（证明这条检查真的会失败）', () => {
  const lab = path.join(ROOT, '_lab', 'verify-manifest-doc-check.mjs')
  const src = readFileSync(lab, 'utf8')
  assert.match(src, /临时改坏|mutate/, '反向验证脚本应当真的去改坏文档再跑检查')
  assert.match(src, /finally/, '必须用 try/finally 保证恢复原文，不能留下改坏的文档')
})
