/**
 * 插件的**待办清单**两处一致：`插件.md` §11 ↔ `路线图.md` §十三/§13
 * =================================================================
 *
 * ── 为什么要有这一条 ──
 * 同一批"插件还没做的事"写在两个地方，而且是**给两种读者**写的：
 *   · `插件.md` §11 —— 写给**插件作者**（"计划 / 现状"）
 *   · `路线图.md` §十三 —— 写给**接手的人**（按"要不要为发布做"排）
 *
 * 2026-10 的真实状况是：`插件.md` 老老实实列了 6 条，而 `路线图.md`（被交接文档称作
 * "进度的**唯一权威**"）里搜"插件"**命中 0** —— 一个已经发出去的功能、连同它剩下的缺口，
 * 都不在那份"权威"里。两处清单可以各自漂，没人会发现（这正是本项目反复吃亏的那类问题）。
 *
 * `gen/check-plugin-doc.mjs` 守的是"**事件表**与实现一致"，它守不住这张待办清单 ——
 * 所以这条判据单独存在。
 *
 * ── 查什么 ──
 * 两处表格的「计划」列必须**逐行同名、同序、同数量**（中英各一对）。
 * 只比这一列：两边的「现状」列本来就该各写各的（一边讲给作者听、一边讲给接手的人听），
 * 卡它只会逼人抄一遍。但**缺口的名字**必须一致 —— 否则就是两份不同的清单。
 *
 * 比较前做一次归一化（去掉 `**`、反引号、多余空白），免得"加粗/不加粗"这种噪音把判据弄红。
 *
 * 用法：node gen/check-plugin-gaps.mjs
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 中英各一对：插件文档的缺口表 ↔ 路线图的缺口表 */
const PAIRS = [
  { lang: '中文', plugin: '中文文档/插件.md', pluginId: '十一、还没做的部分', roadmap: '中文文档/路线图.md', roadmapId: '十三、插件系统' },
  { lang: 'English', plugin: 'docs/插件.md', pluginId: '11. Not done yet', roadmap: 'docs/路线图.md', roadmapId: '13. Plugin system' },
]

let bad = 0
const fail = (m) => { console.error(`✗ ${m}`); bad++ }

/** 把 `## <id>` 这一节切出来（到下一个 `## ` 为止） */
function section(file, id) {
  const lines = readFileSync(path.join(ROOT, file), 'utf8').split('\n')
  const start = lines.findIndex((l) => l.startsWith('## ') && l.slice(3).startsWith(id))
  if (start < 0) { fail(`${file}：找不到以「${id}」开头的一级标题`); return null }
  let end = lines.length
  for (let k = start + 1; k < lines.length; k++) {
    if (/^## /.test(lines[k])) { end = k; break }
  }
  return lines.slice(start, end)
}

/** 表格行 → 单元格数组（`|` 分隔）。表头行与分隔行返回 null */
function cells(line, headerFirst) {
  if (!/^\s*\|.*\|\s*$/.test(line)) return null
  if (/^>\s*\|/.test(line)) return null                 // 引用块里的表（例如警告框）不算
  const out = line.split('|').slice(1, -1).map((c) => c.trim())
  if (!out.length) return null
  if (out.every((c) => /^-+$/.test(c.replace(/[:\s]/g, '-')))) return null   // 分隔行
  if (out.includes(headerFirst)) return null           // 表头行（"计划" / "Plan"）
  return out
}

/** 归一化：去掉 markdown 强调与反引号，压平空白 */
const norm = (s) => s.replace(/[*`]/g, '').replace(/\s+/g, ' ').trim()

/** `插件.md` §11 的「计划」列 = 第一格 */
function pluginPlans(lines) {
  const out = []
  for (const l of lines) {
    const c = cells(l, '计划')
    if (c && c.length === 2) out.push(norm(c[0]))
    else {
      const e = cells(l, 'Plan')
      if (e && e.length === 2) out.push(norm(e[0]))
    }
  }
  return out
}

/** `路线图.md` §十三 的「计划」列 = 第二格（第一格是序号） */
function roadmapPlans(lines) {
  const out = []
  for (const l of lines) {
    const c = cells(l, '计划')
    if (c && c.length === 3) out.push(norm(c[1]))
    else {
      const e = cells(l, 'Plan')
      if (e && e.length === 3) out.push(norm(e[1]))
    }
  }
  return out
}

for (const p of PAIRS) {
  const pl = section(p.plugin, p.pluginId)
  const rl = section(p.roadmap, p.roadmapId)
  if (!pl || !rl) continue

  const a = pluginPlans(pl)
  const b = roadmapPlans(rl)

  if (!a.length) fail(`${p.plugin} §${p.pluginId}：缺口表一行都没解析出来（表格式变了？）`)
  if (!b.length) fail(`${p.roadmap} §${p.roadmapId}：缺口表一行都没解析出来（表格式变了？）`)
  if (!a.length || !b.length) continue

  if (a.length !== b.length) {
    fail(`${p.lang}：两处缺口数量不一致 —— ${p.plugin} 有 ${a.length} 条，` +
      `${p.roadmap} 有 ${b.length} 条\n    插件文档：${a.join(' | ')}\n    路线图：  ${b.join(' | ')}`)
    continue
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      fail(`${p.lang}：第 ${i + 1} 条缺口在两处的名字不一样\n` +
        `    ${p.plugin}：${a[i]}\n    ${p.roadmap}：${b[i]}\n` +
        '    → 同一件事必须同一个名字，否则就是两份不同的清单')
    }
  }
}

if (bad) {
  console.error(`\n${bad} 处插件缺口清单对不上`)
  process.exit(1)
}
console.log('✓ 插件缺口清单两处一致（插件.md §11 ↔ 路线图 §十三；中英各一对，逐行同名同序）')
