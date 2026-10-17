/**
 * 一次性重构：把文档/代码里作者本机的局域网地址换成中性示例
 * ==========================================================
 * 起因：用户要求检查"文档里有没有不该出现的个人信息"。扫出来作者的真实内网地址
 * （电脑、手机、网关那一段 —— 具体值见 `gen/check-pack-pii.mjs` 的 DENY_ANYWHERE）
 * 出现在 20 个文件里、共 65 处，包括会随赠品发出去的文档与源码。
 *
 * 换成中性示例**不损失任何实测结论**：那些句子的意思是"用真实局域网 IP 访问过、
 * 结果是 X"，地址本身不是结论（MB/s、ms 那些数字才是）。
 *
 * 用法：
 *   node _lab/refactor-scrub-lan-ip.mjs          # 只报告
 *   node _lab/refactor-scrub-lan-ip.mjs --apply  # 真的改
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APPLY = process.argv.includes('--apply')

/** 本机地址 → 中性示例（同网段的写法保持一致，读起来仍然像一个真实例子） */
const MAP = [
  [/192\.168\.50\.92/g, '192.168.1.5'],   // 作者的电脑
  [/192\.168\.50\.31/g, '192.168.1.6'],   // 作者的手机
  [/192\.168\.50\.1\b/g, '192.168.1.1'],  // 网关
]

/** 跳过：产物、依赖、以及判据脚本自己的模式字面量 */
const SKIP = [/node_modules/, /[\\/]dist[\\/]/, /[\\/]\.git[\\/]/, /check-pack-pii\.mjs$/, /refactor-scrub-lan-ip\.mjs$/]
const EXTS = /\.(md|mjs|js|json|html|txt|toml|yml)$/

let files = 0, edits = 0
const report = []

function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (SKIP.some((re) => re.test(full))) continue
    if (e.isDirectory()) { walk(full); continue }
    if (!EXTS.test(e.name)) continue
    const src = readFileSync(full, 'utf8')
    let next = src, n = 0
    for (const [re, to] of MAP) {
      const m = next.match(re)
      if (m) n += m.length
      next = next.replace(re, to)
    }
    if (n) {
      files++
      edits += n
      report.push(`${path.relative(ROOT, full).replace(/\\/g, '/')}  ${n} 处`)
      if (APPLY) writeFileSync(full, next, 'utf8')
    }
  }
}

walk(ROOT)
console.log(report.join('\n'))
console.log(`\n${APPLY ? '已替换' : '要替换'}：${edits} 处，分布在 ${files} 个文件`)
if (!APPLY) console.log('（只报告。要真的改：node _lab/refactor-scrub-lan-ip.mjs --apply）')
