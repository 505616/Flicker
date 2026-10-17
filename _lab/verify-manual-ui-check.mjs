/**
 * 反向验证 `gen/check-manual-ui.mjs`
 * ==================================
 *
 * 这条判据守的是"手册里那幅界面示意图的文字必须真的在界面上"。要证明它**会失败**，
 * 最有力的证据就是拿**2026-10 之前手册里那张真的错图**去跑 —— 它当时把
 * "或者，让别人发给我"写成了「有人要发给我」，还画了一个不存在的"在这一页输密码"的框。
 *
 * 用例：
 *   ① 那张旧的错图 → 必须报错，且**点名**「有人要发给我」
 *   ② 把某个按钮文案改一个字（"选择文件" → "选择文档"）→ 必须报错
 *   ③ 只是排版变了（改框宽、换表情、多几个空格）→ **不该**报错（否则会变成"逼人抄格式"）
 *   ④ 手册里找不到 §4.2 了（标题被改）→ 必须报错，而不是"没图就不查"
 *
 * 做法：判据把抠图与比对做成了纯函数，所以这里**直接调**它们（不碰仓库里的文件）；
 *       另有一条走真 CLI（临时副本 + `--manual=`），证明"真的会被拦住"。
 *
 * 用法：node _lab/verify-manual-ui-check.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CHECK = path.join(ROOT, 'gen', 'check-manual-ui.mjs')
const MANUAL = path.join(ROOT, '中文文档', '使用手册.md')

const { diagramOf, unchecked, corpusOf } = await import(pathToFileURL(CHECK).href)
const corpus = corpusOf('zh')

/** 2026-10 之前手册里那张**真的画错了**的图（原文照抄，用来当"必然失败"的样本） */
const OLD_WRONG_DIAGRAM = `┌────────────────────────────────────────────────┐
│  闪传 Flicker            🌐 English ▾  ● 空闲中 │
├────────────────────────────────────────────────┤
│                                                │
│   ┌── 我要发文件 ─────────────────────────┐    │
│   │                                       │    │
│   │   把文件或文件夹拖到这里               │    │
│   │            或                         │    │
│   │        [ 选择文件 ]  [ 选择文件夹 ]    │    │
│   │                                       │    │
│   └───────────────────────────────────────┘    │
│                                                │
│   ┌── 有人要发给我 ──────────────────────┐    │
│   │                                       │    │
│   │   一次性密码  [                  ]    │    │
│   │              [ 开始接收 ]             │    │
│   │                                       │    │
│   └───────────────────────────────────────┘    │
│                                                │
└────────────────────────────────────────────────┘`

const GOOD_DIAGRAM = `┌──────────────────────────────────────────┐
│  闪传 Flicker              🌐 English      │
├──────────────────────────────────────────┤
│  我要发文件                                │
│    把文件或文件夹拖到这里                  │
│    [ 选择文件 ]  [ 选择文件夹 ]            │
│  或者，让别人发给我                        │
│    接收文件                                │
└──────────────────────────────────────────┘`

let bad = 0
const fail = (m) => { console.error(`✗ ${m}`); bad++ }
const ok = (m) => console.log(`✓ ${m}`)

// ── ① 旧的错图必须被抓出来，并且点名到底哪一句是编的 ──
{
  const problems = unchecked(OLD_WRONG_DIAGRAM, corpus)
  if (!problems.length) fail('用例「2026-10 之前那张错图」：判据没报错 —— 它当时就该拦住这一处')
  else if (!problems.some((t) => t.includes('有人要发给我'))) {
    fail(`用例「旧错图」：报错了，但没有点名「有人要发给我」（实际：${problems.join(' / ')}）`)
  } else ok(`用例「旧错图」：如实报错，并点名「有人要发给我」（共 ${problems.length} 处）`)
}

// ── ② 改一个字也要拦 ──
{
  const problems = unchecked(GOOD_DIAGRAM.replace('选择文件', '选择文档'), corpus)
  if (!problems.some((t) => t.includes('选择文档'))) {
    fail(`用例「按钮文案改一个字」：没抓到（实际报了：${problems.join(' / ') || '无'}）`)
  } else ok('用例「按钮文案改一个字」：如实报错')
}

// ── ③ 只是排版不同，不该报错 ──
{
  const reflowed = GOOD_DIAGRAM
    .replace('┌──────────────────────────────────────────┐', '┌────────────────────────────────────────────────┐')
    .replace('│  我要发文件 ', '│    📥 我要发文件 ')
    .replace('[ 选择文件 ]', '[   选择文件   ]')
  const problems = unchecked(reflowed, corpus)
  if (problems.length) fail(`用例「只是排版变了」：不该报错却报了：${problems.join(' / ')}`)
  else ok('用例「只是排版变了」：判据没有误报')
}

// ── ③b 拿手册里**现在这张**图跑，也不该报错（前提成立） ──
{
  const md = readFileSync(MANUAL, 'utf8')
  const d = diagramOf(md)
  if (!d) fail('前提不成立：现在的手册里也找不到 §4.2 的示意图')
  else {
    const problems = unchecked(d.text, corpus)
    if (problems.length) fail(`现在这张图也报错：${problems.join(' / ')}`)
    else ok('用例「现在这张图」：通过（前提成立）')
  }
}

// ── ④ 走真 CLI：把错图塞进一份临时副本，`--manual=` 指过去必须非零退出 ──
{
  const dir = await mkdtemp(path.join(tmpdir(), 'flicker-manual-ui-'))
  try {
    const md = readFileSync(MANUAL, 'utf8')
    const d = diagramOf(md)
    const broken = path.join(dir, '手册.md')
    const lines = md.split('\n')
    // 把示意图所在的代码块整段换成旧的错图
    const start = lines.findIndex((l, i) => i >= (d.startLine - 2) && l.trim() === '```')
    const end = lines.findIndex((l, i) => i > start && l.trim() === '```')
    lines.splice(start + 1, end - start - 1, ...OLD_WRONG_DIAGRAM.split('\n'))
    writeFileSync(broken, lines.join('\n'), 'utf8')

    const r = spawnSync(process.execPath, [CHECK, `--manual=${broken}`], { cwd: ROOT, encoding: 'utf8' })
    if (r.status === 0) fail('用例「真 CLI + 换成旧错图」：检查通过了 —— 它本该失败')
    else if (!`${r.stdout}${r.stderr}`.includes('有人要发给我')) {
      fail(`用例「真 CLI + 换成旧错图」：失败了但没点名，输出：\n${r.stdout}${r.stderr}`)
    } else ok('用例「真 CLI + 换成旧错图」：非零退出且点名了错处')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

if (bad) {
  console.error(`\n${bad} 处反向验证未通过`)
  process.exit(1)
}
console.log('✓ 反向验证通过：编出来的界面文字会被拦住，只是排版不同不会误报')
