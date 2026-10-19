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
 * 判据逻辑抽成 `auditDocLinks(root)`，CLI 只负责打印 —— 这样
 * `test/doc-links.test.js` 能拿一棵临时的小树反过来验它（坏链接必须被抓到）。
 *
 * 用法：node gen/check-doc-links.mjs [--root=<另一棵树>]
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 从 `--key=value` 里取值（测试注入坏掉的副本用） */
export function argOf(argv, name, fallback) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

/** 收集所有 .md（含 _lab 下的报告），跳过 node_modules / dist */
export function collectDocs(root) {
  const out = []
  const walk = (dir) => {
    let names = []
    try { names = readdirSync(dir) } catch { return }
    for (const name of names) {
      if (name === 'node_modules' || name === '.git' || name === 'dist') continue
      const full = path.join(dir, name)
      let st = null
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) walk(full)
      else if (name.endsWith('.md')) out.push(full)
    }
  }
  walk(root)
  return out.sort()
}

/**
 * 核一棵树里的本地链接。
 * @param {string} root 仓库根目录（测试时指向一份临时副本）
 * @returns {{problems:string[], docs:number, checked:number}}
 */
export function auditDocLinks(root = ROOT) {
  const docs = collectDocs(root)
  let checked = 0
  const problems = []

  for (const file of docs) {
    const src = readFileSync(file, 'utf8')
    const rel = path.relative(root, file).replace(/\\/g, '/')

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
        problems.push(`${rel} → ${target}`)
      }
    }
  }
  return { problems, docs: docs.length, checked }
}

// ── CLI ──────────────────────────────────────────────────────

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  const root = argOf(process.argv.slice(2), 'root', ROOT)
  const { problems, docs, checked } = auditDocLinks(root)
  console.log(`检查了 ${docs} 个文档里的 ${checked} 条本地链接`)
  if (problems.length) {
    console.error(`\n✗ ${problems.length} 条链接指向不存在的文件：`)
    for (const b of problems) console.error(`  ${b}`)
    console.error('\n改名文档时请一并更新这些引用。')
    process.exit(1)
  }
  console.log('✓ 没有坏链接')
}
