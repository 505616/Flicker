/**
 * 一次性排查：把两份变更记录「修复」表的首列并排列出来，人眼对一遍
 * 用法：node _lab/diff-changelog-rows.mjs
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function fixRows(file) {
  const lines = readFileSync(path.join(ROOT, file), 'utf8').split('\n')
  let inFix = false
  const out = []
  for (const l of lines) {
    if (/^### /.test(l)) { inFix = /修复|^### Fixed/.test(l); continue }
    if (inFix && /^\|/.test(l) && !/^\|\s*:?-{2,}/.test(l)) out.push(l.split('|')[1].trim())
  }
  return out
}

const cn = fixRows('变更记录.md')
const en = fixRows('CHANGELOG.md')
console.log(`中文 ${cn.length} 行 / 英文 ${en.length} 行`)
const n = Math.max(cn.length, en.length)
for (let i = 0; i < n; i++) {
  console.log(`${String(i + 1).padStart(2)} 中: ${(cn[i] ?? '——').slice(0, 46)}`)
  console.log(`   英: ${(en[i] ?? '——').slice(0, 46)}`)
}
