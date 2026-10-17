/**
 * 检查所有 .md 里的**本地**链接是否指向真实存在的文件。
 *
 * 为什么需要：这个项目的文档量比代码还大，交叉引用很多。
 * 文件一旦改名（例如把 `设计文档.md` 拆开），那些链接会**静默失效** ——
 * 读者点到 404 才发现，而作者本地完全看不出来。
 * CI 里跑一次就能一直守住。
 *
 * 只管本地相对路径；http(s) 外链与纯锚点（#开头）跳过 ——
 * 外链要联网、会因对方站点波动而误报，不适合放进 CI。
 *
 * 用法：node gen/check-doc-links.mjs
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 收集所有 .md（含 _lab 下的报告），跳过 node_modules / dist */
function collect(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'dist') continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) collect(full, out)
    else if (name.endsWith('.md')) out.push(full)
  }
  return out
}

const docs = collect(ROOT).sort()
let checked = 0
const broken = []

for (const file of docs) {
  const src = readFileSync(file, 'utf8')
  const rel = path.relative(ROOT, file).replace(/\\/g, '/')

  // 匹配 markdown 链接的目标：](target)
  for (const m of src.matchAll(/\]\(([^)]+)\)/g)) {
    let target = m[1].trim()

    // 去掉标题锚点
    const hash = target.indexOf('#')
    if (hash >= 0) target = target.slice(0, hash)
    // 去掉可能的 <...> 包裹
    target = target.replace(/^<|>$/g, '').trim()
    if (!target) continue                                   // 纯锚点
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue        // http: mailto: 等

    // URL 解码（中文文件名在链接里可能是 %XX）
    let decoded = target
    try { decoded = decodeURIComponent(target) } catch { /* 保持原样 */ }

    const abs = path.resolve(path.dirname(file), decoded)
    checked++
    if (!existsSync(abs)) {
      broken.push(`${rel} → ${target}`)
    }
  }
}

console.log(`检查了 ${docs.length} 个文档里的 ${checked} 条本地链接`)
if (broken.length) {
  console.error(`\n✗ ${broken.length} 条链接指向不存在的文件：`)
  for (const b of broken) console.error(`  ${b}`)
  console.error('\n改名文档时请一并更新这些引用。')
  process.exit(1)
}
console.log('✓ 没有坏链接')
