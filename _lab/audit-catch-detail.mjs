// 代码体检④：把"吞异常的 catch"逐条打印出来带上下文 —— 判断是不是真的静默失败
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const files = []
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'page.generated.js') continue
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.(mjs|js|cjs|html)$/.test(e.name)) files.push(p)
  }
}
for (const d of process.argv.slice(2).length ? process.argv.slice(2) : ['src', 'bin']) {
  try { walk(d) } catch { /* 目录不存在 */ }
}
const rel = (f) => path.relative(ROOT, f).replace(/\\/g, '/')

const RE = /catch\s*(\([^)]*\))?\s*\{\s*(\/\*[^*]*\*\/)?\s*\}/g
for (const f of files) {
  const s = readFileSync(f, 'utf8')
  const lines = s.split('\n')
  const hits = []
  for (const m of s.matchAll(RE)) {
    hits.push(s.slice(0, m.index).split('\n').length)
  }
  if (!hits.length) continue
  console.log(`\n── ${rel(f)}（${hits.length} 处）`)
  for (const ln of hits) {
    // 往上找最近的一行"做了什么"的代码作为语境
    let ctx = ''
    for (let i = ln - 2; i >= Math.max(0, ln - 8); i--) {
      const t = lines[i].trim()
      if (t && !t.startsWith('}') && !t.startsWith('//') && !t.startsWith('*')) { ctx = t; break }
    }
    console.log(`   L${ln}: 吞掉 ← ${ctx.slice(0, 100)}`)
    console.log(`         ${lines[ln - 1].trim().slice(0, 100)}`)
  }
}
