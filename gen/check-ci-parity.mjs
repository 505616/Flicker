/**
 * CI 与本地检查链**跑的是同一批判据**
 * ==================================
 *
 * ── 为什么要有这一条 ──
 * `npm run check` 是本地那道闸（22 条判据），`.github/workflows/ci.yml` 是云端那道闸。
 * 两道闸**各自手写一份命令清单** —— 于是出现了一个没人守的缺口：
 *
 *   往 `package.json` 的 `check` 里加一条新判据时，如果有人忘了同步 ci.yml，
 *   这条判据**只在你自己的机器上跑**。CI 依然全绿，而"CI 绿"会被当成"全都验过了"。
 *   这个项目已经因为这类"以为验过了"栽过好几次（文档与实现各漂各的、内联段没重跑…）。
 *
 * 已有的那些"这条检查进了检查链与 CI"用例是**逐条**写的（每条新判据配一条断言），
 * 也就是说：**新加判据的人要先想到写那条断言**。这条判据反过来做 ——
 * 直接拿 `package.json` 的命令清单与 ci.yml 的命令集合比，**谁都不必记得**。
 *
 * ── 只查一个方向 ──
 * `check` 里的每条命令都必须在 CI 里出现（这不能漏）。
 * 反过来 CI 可以**多**跑东西（`run-tests.mjs`、构建、冒烟、上传产物）—— 那些不是判据，
 * 不该逼它们也进 `npm run check`（本地每次跑一遍构建太慢）。
 *
 * ── 怎么比 ──
 * 两边都归一化成"脚本路径 + 参数"再比（`node gen/x.mjs --check` → `gen/x.mjs --check`），
 * 免得多写一个 `node`、多一个空格就判成缺失。
 *
 * 用法：
 *   node gen/check-ci-parity.mjs
 *   node gen/check-ci-parity.mjs --pkg=/tmp/package.json --ci=/tmp/ci.yml   （判据自己的测试用）
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 从 `--key=value` 里取值（给测试注入坏掉的副本用） */
function argOf(name, fallback) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const pkgPath = argOf('pkg', path.join(ROOT, 'package.json'))
const ciPath = argOf('ci', path.join(ROOT, '.github', 'workflows', 'ci.yml'))

/**
 * 把一条命令行归一化成 `脚本路径 + 参数`。
 * 只处理这两种我们实际用的形状：`node <脚本> [参数…]`（可带引号）。
 */
function normalize(cmd) {
  return cmd
    .trim()
    .replace(/^node\s+/i, '')
    .replace(/\s+/g, ' ')
    .replace(/^["']|["']$/g, '')
}

/** `npm run check` 里的命令清单（按出现顺序） */
function checkCommands() {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const script = pkg.scripts?.check
  if (typeof script !== 'string' || !script.trim()) {
    throw new Error(`${pkgPath} 里没有 scripts.check —— 本地那道闸不存在`)
  }
  return script.split('&&').map(normalize).filter(Boolean)
}

/**
 * ci.yml 里所有 `run: node …` 的命令。
 *
 * ⚠️ 只认 `node <脚本>` 形状：CI 里还有 `npm install`、`node --version`、
 *    `node gen/test-plan.mjs`（只预览，不是判据）之类的步骤，它们不该被当成"判据"。
 */
function ciCommands() {
  const src = readFileSync(ciPath, 'utf8')
  const out = []
  for (const line of src.split('\n')) {
    // `- name: …` 之后的 `run: …` 是单行形式；也支持 `run: |` 里的逐行命令
    const m = line.match(/^\s*(?:-\s*)?run:\s*(?!\|)(.+)$/)
    if (!m) continue
    const cmd = normalize(m[1])
    if (!/^["']?[\w./-]+\.(?:mjs|cjs|js)\b/.test(cmd)) continue
    out.push(cmd)
  }
  return out
}

let bad = 0
const commands = checkCommands()
const inCi = new Set(ciCommands())

const missing = commands.filter((c) => !inCi.has(c))
if (missing.length) {
  bad++
  console.error(`\n✗ ${missing.length} 条本地判据没有在 CI 里跑 —— ` +
    '它们只在你自己的机器上生效，而"CI 绿"会被当成"全都验过了"：')
  for (const m of missing) console.error(`    · node ${m}`)
  console.error(`\n  改法：把上面这些加到 ${path.relative(ROOT, ciPath)} 的 ` +
    '"test"（或 "docs"）job 里，写法与相邻的步骤一致：\n' +
    '      - name: <一句话说清它在防什么>\n' +
    `        run: node ${missing[0]}\n`)
} else {
  console.log(`✓ CI 与 npm run check 跑的是同一批判据（${commands.length} 条，一条不缺）`)
}

// 反向的提醒（不算失败）：CI 里多跑的东西是正常的，但值得说出来，方便核对
const extra = [...inCi].filter((c) => !commands.includes(c))
if (extra.length) {
  console.log(`  （CI 另外还跑 ${extra.length} 条：${extra.join('、')}）`)
}

if (bad) process.exit(1)
console.log('✓ 检查链与 CI 一致')
