// 代码体检：规模、重复、死代码、吞异常、TODO —— 只读，不改任何东西
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const dirs = ['src', 'src/relay', 'src/suite', 'bin', 'gen', 'test', 'web', 'relay', 'entry', '_lab']
const files = []
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.(mjs|js|cjs|html)$/.test(e.name)) files.push(p)
  }
}
for (const d of dirs) { try { walk(d) } catch { /* 目录不存在 */ } }

const rows = files.map((f) => {
  const s = readFileSync(f, 'utf8')
  const lines = s.split('\n').length
  return {
    f: path.relative(ROOT, f).replace(/\\/g, '/'),
    lines,
    bytes: statSync(f).size,
    todos: (s.match(/TODO|FIXME|XXX|HACK/g) ?? []).length,
    emptyCatch: (s.match(/catch\s*(\([^)]*\))?\s*\{\s*\}/g) ?? []).length,
    swallow: (s.match(/catch\s*(\([^)]*\))?\s*\{\s*\/\*/g) ?? []).length,
  }
}).sort((a, b) => b.lines - a.lines)

console.log('=== 最大的 15 个文件 ===')
for (const r of rows.slice(0, 15)) {
  console.log(`  ${String(r.lines).padStart(5)} 行  ${String(r.bytes / 1024).padStart(7)} KB  ${r.f}` +
    (r.todos ? `  TODO×${r.todos}` : '') + (r.emptyCatch ? `  空catch×${r.emptyCatch}` : ''))
}
console.log('\n=== 按目录统计 ===')
const byDir = {}
for (const r of rows) {
  const d = r.f.includes('/') ? r.f.split('/').slice(0, r.f.startsWith('src/') ? 2 : 1).join('/') : '(根)'
  byDir[d] = byDir[d] ?? { n: 0, lines: 0 }
  byDir[d].n++; byDir[d].lines += r.lines
}
for (const [d, v] of Object.entries(byDir).sort((a, b) => b[1].lines - a[1].lines)) {
  console.log(`  ${String(v.lines).padStart(6)} 行 / ${String(v.n).padStart(3)} 个文件  ${d}`)
}
console.log(`\n合计 ${rows.length} 个源文件，${rows.reduce((s, r) => s + r.lines, 0)} 行`)
console.log(`TODO/FIXME 合计 ${rows.reduce((s, r) => s + r.todos, 0)} 处`)
