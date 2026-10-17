// 代码体检③：把探针写对之后再看一遍（死导出 / 长函数 / 吞异常 / 无测试覆盖）
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
for (const d of ['src', 'bin', 'gen', 'web', 'relay', 'entry', 'test', '_lab']) {
  try { walk(d) } catch { /* 目录不存在 */ }
}
const rel = (f) => path.relative(ROOT, f).replace(/\\/g, '/')
const text = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]))

console.log('=== ① 导出了但"只有定义处提到它"（多余导出）与"全仓库都没人用"（真死代码）===')
const srcOnly = files.filter((f) => /^(src|bin)\//.test(rel(f)))
for (const f of srcOnly) {
  const s = text.get(f)
  for (const m of s.matchAll(/export (?:async )?function (\w+)|export const (\w+)/g)) {
    const name = m[1] ?? m[2]
    let outside = 0
    let inside = 0
    for (const [g, t] of text) {
      const n = (t.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length
      if (g === f) inside += n
      else outside += n
    }
    if (outside === 0) {
      console.log(`  ${inside > 1 ? '·' : '⚠️'} ${rel(f)}: ${name}  ` +
        (inside > 1 ? '（只在定义文件里用 —— 导出是多余的）' : '（全仓库没有任何引用 —— 可能是死代码）'))
    }
  }
}

console.log('\n=== ② 超长函数（>120 行）：最难审、最容易藏 bug ===')
for (const [f, s] of text) {
  if (!/^(src|web|relay)\//.test(rel(f))) continue
  const lines = s.split('\n')
  const starts = []
  lines.forEach((l, i) => {
    const m = l.match(/^\s*(?:export )?(?:async )?function (\w+)|^\s*(?:const|let) (\w+) = (?:async )?\(?[^=]*=>\s*\{/)
    if (m) starts.push({ name: m[1] ?? m[2], at: i })
  })
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k].at
    const to = k + 1 < starts.length ? starts[k + 1].at : lines.length
    // 粗略：数到第一个顶格的 } 为止
    let end = to
    for (let i = from + 1; i < to; i++) if (/^\}/.test(lines[i])) { end = i; break }
    const len = end - from
    if (len > 120) console.log(`  ⚠️ ${rel(f)}: ${starts[k].name}() 约 ${len} 行（${from + 1}–${end + 1}）`)
  }
}

console.log('\n=== ③ 吞异常（catch 里什么都没做）—— "静默失败"的温床 ===')
for (const [f, s] of text) {
  if (!/^(src|web|relay|bin)\//.test(rel(f))) continue
  const n = (s.match(/catch\s*(\([^)]*\))?\s*\{\s*(\/\*[^*]*\*\/)?\s*\}/g) ?? []).length
  if (n) console.log(`  ${n >= 3 ? '⚠️' : '  '} ${rel(f)}: ${n} 处`)
}

console.log('\n=== ④ src/ 里哪些文件没有任何测试提到过 ===')
const testText = [...text].filter(([f]) => rel(f).startsWith('test/')).map(([, t]) => t).join('\n')
for (const f of srcOnly) {
  const base = path.basename(f)
  if (!testText.includes(base) && !testText.includes(`src/${base}`)) {
    console.log(`  ⚠️ ${rel(f)}（${text.get(f).split('\n').length} 行）没有测试文件直接引用它`)
  }
}
