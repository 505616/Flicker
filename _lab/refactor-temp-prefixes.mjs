/**
 * 把临时目录前缀统一改成 `flicker-` 开头（一次性重构脚本）
 * ==========================================================
 * 起因：用户在自己的 %TEMP% 里看到 2.8 GB 我们的残留。清理脚本只能删"认识的前缀"，
 * 于是散落的 `sw-`、`shot-`、`race-`、`relay-out-` 这些名字谁也认领不了。
 * 见 `gen/check-temp-dirs.mjs`（新判据）与 `gen/tmp.mjs`（登记表）。
 *
 * 用法：
 *   node _lab/refactor-temp-prefixes.mjs          # 只报告要改什么
 *   node _lab/refactor-temp-prefixes.mjs --apply  # 真的改
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APPLY = process.argv.includes('--apply')

/**
 * 旧前缀 → 新前缀。
 * ⚠️ 只改字符串字面量（`mkdtemp(..., '旧-')` 里的那一段），不做全局替换 ——
 *    这些词在别处还有别的含义（`relay-out-` 可能出现在注释里）。
 */
const MAP = {
  'check-source-pack-': 'flicker-check-pack-',
  'sw-': 'flicker-swsweep-',
  'lab-cert-': 'flicker-labcert-',
  'race-': 'flicker-race-',
  'repro-': 'flicker-repro-',
  'noack-': 'flicker-noack-',
  'shot-': 'flicker-shot-',
  'uiverify-': 'flicker-uiverify-',
  'ack-': 'flicker-ack-',
  'relay-e2e-': 'flicker-relay-e2e-',
  'relay-out-': 'flicker-relay-out-',
  'relay-out2-': 'flicker-relay-out2-',
  'relay-out3-': 'flicker-relay-out3-',
  'relay-out4-': 'flicker-relay-out4-',
  'relay-caps-': 'flicker-relay-caps-',
  'relay-rate-': 'flicker-relay-rate-',
  'relay-cli-out-': 'flicker-relay-cli-out-',
  'relay-legacy-out-': 'flicker-relay-legacy-out-',
  'relay-gift-out-': 'flicker-relay-gift-out-',
  'rel-space-': 'flicker-rel-space-',
  'rel space-': 'flicker-rel-space-',
  'rel-': 'flicker-rel-',
  'cleanup-check-': 'flicker-cleanup-check-',
}

const CALL = /(mkdtemp(?:Sync)?\(\s*(?:fs\.)?(?:path\.)?join\(\s*(?:os\.)?tmpdir\(\)\s*,\s*)(['"`])([^'"`]+)\2/g

let files = 0, edits = 0
const report = []

for (const dir of ['gen', '_lab', 'test']) {
  const walk = (d) => {
    for (const e of readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) { if (e.name !== 'out' && e.name !== 'node_modules') walk(full); continue }
      if (!/\.(mjs|js)$/.test(e.name)) continue
      // 本脚本、以及判据脚本里的**注释示例**都不改
      if (e.name === 'refactor-temp-prefixes.mjs' || e.name === 'check-temp-dirs.mjs') continue
      const src = readFileSync(path.join(ROOT, full), 'utf8')
      const next = src.replace(CALL, (all, head, q, prefix) => {
        const to = MAP[prefix]
        if (!to) return all
        edits++
        report.push(`${full}: '${prefix}' → '${to}'`)
        return head + q + to + q
      })
      if (next !== src) {
        files++
        if (APPLY) writeFileSync(path.join(ROOT, full), next, 'utf8')
      }
    }
  }
  walk(dir)
}

console.log(report.join('\n'))
console.log(`\n${APPLY ? '已改' : '要改'}：${edits} 处，分布在 ${files} 个文件`)
if (!APPLY) console.log('（只报告。要真的改：node _lab/refactor-temp-prefixes.mjs --apply）')
