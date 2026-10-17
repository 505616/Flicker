/**
 * `PROTOCOL.md` §7R 与实现一致（测试）
 * ====================================
 *
 * §7R（接收模式 `/up/*`，手机 → 电脑）是 2026-10 才补上的一章。它属于
 * `manifest-doc.test.js` 守的那**同一类**问题：文档与实现分家，而**本机测试全绿** ——
 * 因为测试测的是实现，读文档的人才会撞上（照着 `§8.2` 的码写直连客户端就是例子）。
 *
 * 这里不重写比对逻辑，直接跑 `gen/check-recv-protocol-doc.mjs` ——
 * 两处各写一套的话，迟早出现"测试过了、检查没过"这种谁也说不清的场面。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

test('⭐ §7R 的接收模式端点与真实实现一致（中英文各一份）', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'gen', 'check-recv-protocol-doc.mjs')], {
    encoding: 'utf8', cwd: ROOT,
  })
  assert.equal(r.status, 0,
    `§7R 与实现不一致：\n${r.stdout || ''}${r.stderr || ''}`)
})

test('两份文档的 §7R json 样例数量与字段顺序一致（译文不该改结构）', () => {
  /** 取 §7R 里**全部** ```json 样例（按出现顺序） */
  const grabAll = (file) => {
    const lines = readFileSync(path.join(ROOT, file), 'utf8').split('\n')
    const start = lines.findIndex((l) => /^## 7R\./.test(l))
    assert.ok(start >= 0, `${file} 里找不到 §7R`)
    let end = lines.length
    for (let k = start + 1; k < lines.length; k++) {
      if (/^## /.test(lines[k])) { end = k; break }
    }
    const out = []
    let inFence = false
    let buf = null
    for (const l of lines.slice(start, end)) {
      if (l.trimStart().startsWith('```')) {
        if (!inFence) { buf = /^```json\s*$/.test(l.trimStart()) ? [] : null; inFence = true; continue }
        if (buf) out.push(JSON.parse(buf.join('\n')))
        inFence = false; buf = null; continue
      }
      if (inFence && buf) buf.push(l)
    }
    assert.ok(out.length >= 6, `${file} 的 §7R 里 json 样例太少（${out.length} 个）—— 端点章节少了？`)
    return out
  }
  /** 递归收集"字段路径"（只收集对象与对象数组），用来比结构 */
  const shape = (v, at = '') => {
    if (v === null || typeof v !== 'object') return [at]
    if (Array.isArray(v)) return v.length && typeof v[0] === 'object' && v[0] !== null
      ? shape(v[0], `${at}[]`) : [at]
    return Object.entries(v).flatMap(([k, x]) => shape(x, at ? `${at}.${k}` : k))
  }
  const zh = grabAll('中文文档/PROTOCOL.md')
  const en = grabAll('docs/PROTOCOL.md')
  assert.equal(en.length, zh.length, '§7R 里 json 样例的**数量**必须一致（译文不该多或少一节）')
  for (let i = 0; i < zh.length; i++) {
    assert.deepEqual(shape(en[i]), shape(zh[i]),
      `第 ${i + 1} 个 json 样例的字段结构与中文版不一致`)
  }
})

test('这条检查进了检查链与 CI（否则只有手动跑才会发现漂移）', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.match(pkg.scripts.check, /check-recv-protocol-doc\.mjs/,
    'npm run check 里要跑 §7R 与实现的一致性检查')
  const ci = readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
  assert.match(ci, /check-recv-protocol-doc\.mjs/, 'CI 里也要跑')
})

test('反向验证脚本在仓库里（证明这条检查真的会失败）', () => {
  const src = readFileSync(path.join(ROOT, '_lab', 'verify-recv-protocol-doc-check.mjs'), 'utf8')
  assert.match(src, /writeFileSync\(target, mutated\)/, '反向验证脚本应当真的去改坏文档再跑检查')
  assert.match(src, /finally/, '必须用 try/finally 保证恢复原文，不能留下改坏的文档')
})
