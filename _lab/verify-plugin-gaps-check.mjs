/**
 * 反向验证 `gen/check-plugin-gaps.mjs`
 * ====================================
 *
 * 一个从不失败的检查等于没有检查。这条判据守的是"同一批缺口写在两处、必须逐行对得上"，
 * 所以要证明两件事：
 *   · 两处**真的不一致**时它会失败（少一条 / 多一条 / 改名字 / 章节没了）
 *   · 只是**格式噪音**（加粗、去反引号）时它**不该**失败 ——
 *     否则它会变成"逼人抄格式"的检查，而不是"逼人同步清单"的检查
 *
 * 做法：把文档**临时改坏**，跑检查看退出码；再恢复。每个用例都单独恢复原文。
 *
 * 用法：node _lab/verify-plugin-gaps-check.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CHECK = path.join(ROOT, 'gen', 'check-plugin-gaps.mjs')
const ROADMAP = path.join(ROOT, '中文文档', '路线图.md')
const PLUGIN = path.join(ROOT, '中文文档', '插件.md')

const runCheck = () => spawnSync(process.execPath, [CHECK], { cwd: ROOT, encoding: 'utf8' })

const originals = new Map([
  [ROADMAP, readFileSync(ROADMAP, 'utf8')],
  [PLUGIN, readFileSync(PLUGIN, 'utf8')],
])

let bad = 0

/** @type {{file:string,name:string,mustFail:boolean,mutate:(s:string)=>string}[]} */
const cases = [
  {
    // ⚠️ 这里必须用**这一行独有**的文字来定位：早先用 `/^\| 4 \| /m` 删，结果删掉的是
    //    §八 那张表里的第 4 行（`| 4 | Install git …`）—— 文档确实被改了，但改的不是
    //    这一章，于是判据"正确地"没有报错，而反向验证看起来像失败。
    //    教训：**改坏文档的用例本身也要精确**，否则它证明不了任何事。
    //    ⚠️ 也别用行号 / 编号定位：缺口表从 6 条减到 1 条，改过三次，编号一变这条用例就静默失效。
    file: ROADMAP, mustFail: true, name: '路线图里删掉一条缺口',
    mutate: (s) => s.replace(/^\| \d+ \| Cloudflare Worker 形态的中继插件 \|.*$/m, ''),
  },
  {
    file: PLUGIN, mustFail: true, name: '插件文档里删掉一条缺口',
    mutate: (s) => s.replace(/^\| Cloudflare Worker 形态的中继插件 \|.*$/m, ''),
  },
  {
    file: ROADMAP, mustFail: true, name: '路线图里把一条缺口的名字改了',
    mutate: (s) => s.replace(
      /^\| (\d+) \| Cloudflare Worker 形态的中继插件 \|/m,
      '| $1 | Worker 形态的中继插件 |'),
  },
  {
    file: PLUGIN, mustFail: true, name: '插件文档里多加一条缺口',
    mutate: (s) => s.replace(
      /^(\| Cloudflare Worker 形态的中继插件 \|.*)$/m,
      '| 一个全新的缺口（只有这一处写了） | 未实现：假装有 |\n$1'),
  },
  {
    file: ROADMAP, mustFail: true, name: '路线图里这一章的标题改了名（章节找不到）',
    mutate: (s) => s.replace(/^## 十三、插件系统.*$/m, '## 十三、插件'),
  },
  {
    // ⚠️ 这一条是**反例**：只是格式变了，判据不该响。没有它，上面那些"会失败"证明不了
    //    这条检查在区分"清单不一致"和"格式不一致"。
    file: ROADMAP, mustFail: false, name: '只是给一条缺口加了粗（名字没变）→ 不该报错',
    mutate: (s) => s.replace(
      '| Cloudflare Worker 形态的中继插件 |',
      '| **Cloudflare Worker 形态的中继插件** |'),
  },
]

const clean = runCheck()
if (clean.status !== 0) {
  console.error(`✗ 前提不成立：没改过的文档也过不了检查\n${clean.stdout}${clean.stderr}`)
  process.exit(1)
}

for (const c of cases) {
  const original = originals.get(c.file)
  const mutated = c.mutate(original)
  if (mutated === original) {
    console.error(`✗ 用例「${c.name}」没有真正改动文档 —— 判据写错了，等于没验`)
    bad++
    continue
  }
  try {
    writeFileSync(c.file, mutated)
    const r = runCheck()
    if (c.mustFail && r.status === 0) {
      console.error(`✗ 用例「${c.name}」：文档被改坏了，检查却通过了`)
      bad++
    } else if (!c.mustFail && r.status !== 0) {
      console.error(`✗ 用例「${c.name}」：只是格式变了，检查却报错（会变成"逼人抄格式"）\n` +
        `${r.stdout}${r.stderr}`)
      bad++
    } else {
      console.log(`✓ 用例「${c.name}」：${c.mustFail ? '检查如实报错' : '检查正确地没有报错'}`)
    }
  } finally {
    writeFileSync(c.file, original)
  }
}

const after = runCheck()
if (after.status !== 0) {
  console.error(`✗ 恢复后检查仍然失败 —— 文档可能没恢复干净\n${after.stdout}${after.stderr}`)
  bad++
} else {
  console.log('✓ 已恢复原文，检查重新通过')
}

if (bad) {
  console.error(`\n${bad} 处反向验证未通过`)
  process.exit(1)
}
console.log('✓ 反向验证通过：该失败时会失败，只是格式变了时不会误报')
