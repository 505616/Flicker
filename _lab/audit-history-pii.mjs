/**
 * 体检：**历史提交**里有没有个人信息
 * =================================
 * `gen/check-pack-pii.mjs` 只看当前工作树。但推到一个**公开**仓库时，
 * 泄漏靠的是**历史**：哪怕现在的工作树干净，某个旧提交里可能还留着
 * 真实局域网 IP、邮箱、Windows 用户名、账号名。
 *
 * 做法：对每个提交跑一遍 `git grep`（模式直接取自 `check-pack-pii.mjs` 导出的
 * `CONTENT`，**不在这里抄第二份**），把命中的提交与文件列出来。只读，不改任何东西。
 *
 * 例外（与 `check-pack-pii.mjs` 的 ALLOW 一致）：
 *   · 作者署名那一篇（`原始需求以及作者的话.md` / `AUTHOR-NOTES.md`）里的账号是**有意保留**的；
 *   · 判据脚本自己（模式字面量）与它的测试不算泄漏；
 *   · 文档里的示例地址统一是 192.168.1.x 这类中性写法。
 *
 * 用法：
 *   node _lab/audit-history-pii.mjs                  # 全部提交
 *   node _lab/audit-history-pii.mjs --range=old/main..HEAD   # 只看新提交
 */
import { spawnSync } from 'node:child_process'
import { CONTENT } from '../gen/check-pack-pii.mjs'

const rangeArg = process.argv.slice(2).find((a) => a.startsWith('--range='))
const range = rangeArg ? rangeArg.slice('--range='.length) : '--all'

/** 只关心"真会指向人"的四类；32 位十六进制在历史里有 SEA 哨兵之类的噪音，跳过 */
const CATEGORIES = ['邮箱地址', 'Windows 用户目录', '作者账号', '局域网 IP', '公网 IPv4']
const PATTERNS = CONTENT.filter((c) => CATEGORIES.includes(c.name))

/** 有意保留 / 判据自己的字面量：与 check-pack-pii 的 ALLOW 对齐 */
const ALLOWED = [
  /^("?)(原始需求以及作者的话|AUTHOR-NOTES)\.md$/,
  /^(gen|_lab)\/check-pack-pii\.mjs$/,
  /^_lab\/audit-history-pii\.mjs$/,
  /^test\/pack-pii\.test\.js$/,
  /^(中文文档|docs)\//,          // 文档里的示例地址（192.168.1.x 这类）
  /^test\//,                     // 测试里的占位写法（C:\Users\…）
]

const git = (args) => spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

const revs = git(['rev-list', ...(range.startsWith('--') ? ['--all'] : [range])])
  .stdout.split('\n').filter(Boolean)

console.log(`扫描 ${revs.length} 个提交（范围：${range}），模式取自 gen/check-pack-pii.mjs`)

const hits = new Map()
for (const rev of revs) {
  for (const pat of PATTERNS) {
    // ⚠️ core.quotepath=false：否则中文路径会被转义成 å…，文件名对不上 ALLOW 规则
    const r = git(['-c', 'core.quotepath=false', 'grep', '-I', '-E', '-l', pat.re.source, rev, '--'])
    if (r.status !== 0 || !r.stdout.trim()) continue
    for (const line of r.stdout.trim().split('\n')) {
      const file = line.slice(line.indexOf(':') + 1).replace(/^"|"$/g, '')
      if (ALLOWED.some((re) => re.test(file))) continue
      const key = `${pat.name} @ ${file}`
      if (!hits.has(key)) hits.set(key, rev.slice(0, 12))
    }
  }
}

if (!hits.size) {
  console.log('✓ 历史里没有发现个人信息（四类模式全过）')
} else {
  console.error(`✗ 历史里有 ${hits.size} 处命中：`)
  for (const [key, rev] of hits) console.error(`  ${key}   最早出现于 ${rev}`)
  console.error('\n推公开仓库前必须处理：git filter-repo，或换一份干净历史（见 _lab/交接.md）')
  process.exit(1)
}
