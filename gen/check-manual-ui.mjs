/**
 * 《使用手册》§4.2 那张界面示意图里的每一段文字，都必须**真的在界面上**
 * ==================================================================
 *
 * ── 为什么要有这一条 ──
 * 2026-10 用户问了一句"我们现在的 UI 应该没有『有人要发给我』那个板块吧" ——
 * 手册 §4.2 画的是：
 *
 *      ┌── 有人要发给我 ──────────────────────┐
 *      │   一次性密码  [                  ]    │
 *      │              [ 开始接收 ]             │
 *
 * 而真实界面（`web/station.html`）上那块是：
 *
 *      或者，让别人发给我
 *      📲 手机拍的照片传到这台电脑
 *      [ 接收文件 ]
 *
 * 也就是说：**标题写错了，而且画了一个根本不存在的"在这一页输密码"的框**
 * （密码是手机上输入的，电脑这侧不输）。这种错误没人会同时读两份去核对 ——
 * 用户照着手册找那个输入框，只会以为程序坏了。
 *
 * ── 判据怎么定 ──
 * 不比对"布局"（画法本来就随意），只比对**文字**：把示意图里每一段文字抠出来，
 * 要求它是 `web/i18n-strings.mjs` 里某条中文（或英文）文案的**子串**。
 * 于是"凭记忆写出一个界面标题"这种错当场就红 —— 而且它不逼人抄格式：
 * 只要界面上真有这句话，怎么排版都行。
 *
 * 副作用（好的一面）：界面文案改了、手册没跟，这条也会红。
 *
 * 用法：
 *   node gen/check-manual-ui.mjs
 *   node gen/check-manual-ui.mjs --manual=<某份手册路径>   （判据自己的测试用）
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { STRINGS } from '../web/i18n-strings.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argOf = (name, fallback = null) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

/** 手册与它对应的界面语言（中文手册对中文界面、英文手册对英文界面） */
const PAIR = [
  { file: '中文文档/使用手册.md', lang: 'zh', heading: '### 4.2' },
  { file: 'docs/使用手册.md', lang: 'en', heading: '### 4.2' },
]

/** 图中那些纯装饰的字符（边框、箭头、项目符号）不算文字 */
const BOX = /[│┌┐└┘├┤┬┴┼─━┃┏┓┗┛┣┫┳┻╋╭╮╯╰═║]+/g

/**
 * 从一份手册里取出 §4.2 的第一个代码块。
 * @returns {{text:string, startLine:number}|null}
 */
export function diagramOf(md, heading = '### 4.2') {
  const lines = md.split('\n')
  const at = lines.findIndex((l) => l.startsWith(heading))
  if (at < 0) return null
  let open = -1
  for (let i = at + 1; i < lines.length; i++) {
    if (lines[i].startsWith('### ') || lines[i].startsWith('## ')) break   // 下一节了
    if (lines[i].trim() === '```') {
      if (open < 0) { open = i; continue }
      return { text: lines.slice(open + 1, i).join('\n'), startLine: open + 2 }
    }
  }
  return null
}

/**
 * 把示意图拆成"文字片段"。
 *
 * 规则：去掉边框字符 → 按**两个以上空格**切成视觉上的列 → 去掉首尾的符号/表情
 * （📥 📲 ● 🌐 这类）→ 留下长度 ≥ 2 的片段。
 */
export function fragmentsOf(diagram) {
  const out = []
  for (const line of diagram.split('\n')) {
    const clean = line.replace(BOX, ' ')
    for (const col of clean.split(/ {2,}/)) {
      const frag = col
        .replace(/^[^\p{L}\p{N}]+/u, '')       // 去掉开头的表情/圆点/方括号
        .replace(/[^\p{L}\p{N}）)】」』。！？.!?]+$/u, '')  // 去掉结尾的装饰
        .trim()
      if ([...frag].length >= 2) out.push(frag)
    }
  }
  return out
}

/** 某语言的全部文案拼在一起（片段是它的子串就算"界面上真有这句话"） */
export function corpusOf(lang) {
  return Object.values(STRINGS[lang] ?? {}).join('\n')
}

/**
 * 纯函数版：给一段示意图与一份"界面文案总集"，返回**对不上的片段**。
 * 抽成纯函数是为了让判据自己的测试能拿"改坏的那张图"去证明它真的会红。
 */
export function unchecked(diagram, corpus) {
  const bad = []
  for (const frag of fragmentsOf(diagram)) {
    if (corpus.includes(frag)) continue
    // 退一步：整段对不上时，拆成单词逐个查（"闪传 Flicker" 这种两段拼在一行里的）
    const words = frag.split(/[\s]+/).filter((w) => [...w].length >= 2)
    if (words.length > 1 && words.every((w) => corpus.includes(w))) continue
    bad.push(frag)
  }
  return bad
}

const manualOverride = argOf('manual')
let bad = 0

for (const p of PAIR) {
  const file = manualOverride ?? p.file
  // `--manual=` 可能是绝对路径（判据自己的测试会指向临时副本）—— 那样就不拼仓库根
  const abs = path.isAbsolute(file) ? file : path.join(ROOT, file)
  let md
  try {
    md = readFileSync(abs, 'utf8')
  } catch (e) {
    bad++
    console.error(`✗ 读不到 ${file}：${e?.message ?? e}`)
    continue
  }
  const diagram = diagramOf(md, p.heading)
  if (!diagram) {
    bad++
    console.error(`✗ ${file}：找不到 §4.2 的示意图（小节标题或代码块变了？）`)
    continue
  }
  const problems = unchecked(diagram.text, corpusOf(p.lang))
  if (problems.length) {
    bad++
    console.error(`\n✗ ${file} §4.2（第 ${diagram.startLine} 行起的示意图）里有界面不存在的文字：`)
    for (const t of problems) console.error(`    · 「${t}」`)
    console.error('  这些文字在 web/i18n-strings.mjs 里一条都对不上 —— ' +
      '要么界面已经改了（手册要跟），要么这行是凭记忆写的（删掉或改成界面上的原文）。')
  } else {
    console.log(`✓ ${file} §4.2 示意图里的文字都能在界面文案里找到（${fragmentsOf(diagram.text).length} 段）`)
  }
}

if (bad) process.exit(1)
console.log('✓ 手册里的界面示意图与真实界面文案一致')
