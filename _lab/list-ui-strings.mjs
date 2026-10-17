/**
 * 一次性排查脚本：把 UI 里所有用户可见文案捞出来，供 i18n 抽取时对照。
 *
 * 用法：
 *   node _lab/list-ui-strings.mjs            # 两个页面都列
 *   node _lab/list-ui-strings.mjs receiver   # 只看接收端
 */
import fs from 'node:fs'

const CJK = /[\u4e00-\u9fff]/

function htmlTexts(src) {
  const head = src.slice(0, src.indexOf('<script'))
  const clean = head.replace(/<!--[\s\S]*?-->/g, '').replace(/<style[\s\S]*?<\/style>/g, '')
  const out = []
  for (const m of clean.matchAll(/>([^<>{}]+)</g)) {
    const t = m[1].trim()
    if (t && CJK.test(t)) out.push(t)
  }
  return out
}

function jsStrings(src) {
  const i = src.indexOf('<script')
  if (i < 0) return []
  const js = src.slice(i)
  const out = new Set()
  // 单引号、双引号、反引号（反引号里可能有 ${}，照样抓）
  const re = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g
  for (const m of js.matchAll(re)) {
    const t = (m[1] ?? m[2] ?? m[3] ?? '').trim()
    if (t && CJK.test(t)) out.add(t)
  }
  return [...out]
}

const which = process.argv[2]
const files = (which === 'receiver' ? ['web/receiver.html']
  : which === 'station' ? ['web/station.html']
    : ['web/receiver.html', 'web/station.html'])

for (const f of files) {
  const src = fs.readFileSync(f, 'utf8')
  const h = htmlTexts(src)
  const j = jsStrings(src)
  console.log(`\n═══ ${f} ═══`)
  console.log(`\n— HTML 可见文案 ${h.length} 条 —`)
  h.forEach((t, i) => console.log(`  ${String(i + 1).padStart(3)}. ${t.slice(0, 92)}`))
  console.log(`\n— 脚本内字符串 ${j.length} 条 —`)
  j.forEach((t, i) => console.log(`  ${String(i + 1).padStart(3)}. ${t.slice(0, 92)}`))
  console.log(`\n合计 ${h.length + j.length} 条`)
}
