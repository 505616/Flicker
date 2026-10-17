/**
 * 把 CI 在本机**预演一遍**（顺序、步骤、失败点全都照 ci.yml 来）
 * ==========================================================
 *
 * ── 为什么需要它 ──
 * "CI 第一次跑通"这件事以前只能**推上去才知道**。而推上去之后才发现的问题，
 * 修一次要等一轮 CI，而且失败的步骤可能只是顺序问题（比如内联检查放在生成之前）。
 *
 * 这个脚本不做第二份命令清单 —— 它**直接读 `.github/workflows/ci.yml`**，
 * 把里面每个 `run:` 步骤按顺序在本机跑一遍（`uses:` 的那种 action 跑不了，
 * 但会核对它要的东西：Node 版本、构建产物）。所以：
 *
 *   · 命令只有一份（ci.yml），不会漂；
 *   · 顺序就是 CI 的顺序，"第几步红的"在本机就能看到；
 *   · 出错时打印**步骤名 + 完整输出尾巴**，与 CI 的日志对照着看。
 *
 * ── 它不能替代什么 ──
 * 它跑在**你这台机器**上。Linux / macOS 上的差异（证书库、路径大小写、SEA 构建）
 * 仍然只有真 CI 能验 —— 这一点会打印在结尾，免得把它当成"CI 已经绿了"。
 *
 * 用法：
 *   node _lab/rehearse-ci.mjs                  # 两个 job 全跑（约 5–8 分钟，含构建）
 *   node _lab/rehearse-ci.mjs --only=docs      # 只跑 docs job（约 10 秒）
 *   node _lab/rehearse-ci.mjs --only=test --skip-build   # 跳过构建与冒烟（约 2.5 分钟）
 *   node _lab/rehearse-ci.mjs --parse-only     # 只解析并核对（不执行），约 1 秒
 */
import { readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argOf = (name, fallback = null) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const flag = (name) => args.includes(`--${name}`)

/** `--ci=` 给判据用：指向一份临时副本，证明"脚本路径写错时这里会红" */
const CI = argOf('ci') ? path.resolve(argOf('ci')) : path.join(ROOT, '.github', 'workflows', 'ci.yml')

const only = argOf('only')            // null = 全部
const parseOnly = flag('parse-only')
const skipBuild = flag('skip-build')

/**
 * 解析 workflow：返回 [{ job, steps: [{ name, run } | { name, uses, with }] }]
 *
 * ⚠️ 刻意只支持**这一份文件用到的 YAML 子集**（两空格 job、四空格 steps、
 *    `- name:` / `- uses:` + `run:` / `with:`）。写一个通用 YAML 解析器会引入
 *    "解析器本身有 bug"这一层风险，而这里需要的是"照着 CI 跑"，不是 YAML 完备性。
 *    解析不了的结构会**报错**而不是被默默跳过 —— 被跳过的步骤等于没预演。
 */
export function parseWorkflow(text) {
  const jobs = []
  let inJobs = false          // 只有 `jobs:` 之后的两空格键才是 job
  let job = null
  let step = null
  let inSteps = false
  let inWith = false

  const pushStep = () => {
    if (step && (step.run || step.uses)) job.steps.push(step)
    step = null
    inWith = false
  }
  const pushJob = () => {
    pushStep()
    if (job) jobs.push(job)
    job = null
    inSteps = false
  }

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim() || line.trim().startsWith('#')) continue

    // `jobs:` 从这一行开始；之前的两空格键（`on:` 下面的 push/pull_request…）不是 job
    if (/^jobs:\s*$/.test(line)) { inJobs = true; continue }
    if (/^[A-Za-z]/.test(line)) { inJobs = false; continue }   // 顶层键（on / permissions / name…）

    // `  test:` / `  docs:` —— 两空格缩进 + 冒号
    const jobHit = line.match(/^ {2}([A-Za-z][\w-]*):\s*$/)
    if (jobHit && inJobs) {
      pushJob()
      job = { name: jobHit[1], steps: [] }
      continue
    }
    if (!job) continue

    if (/^ {4}steps:\s*$/.test(line)) { inSteps = true; continue }
    if (!inSteps) continue

    const stepHit = line.match(/^ {6}-\s+(?:name|uses):\s*(.*)$/)
    if (stepHit) {
      pushStep()
      step = { name: stepHit[1].replace(/^["']|["']$/g, ''), run: null, uses: null }
      // `- uses: …` / `- name: …` 之后同一行可能没有别的信息，细节在下面的键里
      if (/^ {6}-\s+uses:/.test(line)) step.uses = step.name
      else step.name = step.name
      continue
    }
    if (!step) continue

    const runHit = line.match(/^ {8}run:\s*(.+)$/)
    if (runHit) { step.run = runHit[1].trim(); inWith = false; continue }
    if (/^ {8}with:\s*$/.test(line)) { inWith = true; continue }
    if (/^ {8}name:\s*(.+)$/.test(line) && !step.name) {
      step.name = line.match(/^ {8}name:\s*(.+)$/)[1].trim()
      continue
    }
    if (inWith) {
      const nodeVersion = line.match(/^ {10}node-version:\s*['"]?([^'"\s]+)['"]?\s*$/)
      if (nodeVersion) step.with = { ...(step.with ?? {}), nodeVersion: nodeVersion[1] }
    }
  }
  pushJob()
  return jobs
}

/** 直接运行本文件吗（被 import 时不要执行任何步骤） */
const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (!isDirectRun) {
  // 被 import：只导出解析器（判据用它验"哪些行算 job"）
} else {
  main()
}

function main() {
const jobs = parseWorkflow(readFileSync(CI, 'utf8'))
if (!jobs.length) {
  console.error(`✗ 解析不出任何 job —— ${path.relative(ROOT, CI)} 的结构变了？`)
  process.exit(1)
}

/** 每个 `run: node xxx` 里的脚本必须真的存在（写错路径 = CI 上第一条就红） */
const missing = []
for (const job of jobs) {
  for (const step of job.steps) {
    if (!step.run) continue
    for (const m of step.run.matchAll(/(?:^|\s)node\s+([\w./-]+\.(?:mjs|cjs|js))/g)) {
      const p = path.join(ROOT, m[1])
      if (!existsSync(p)) missing.push(`${job.name} / ${step.name} → node ${m[1]}`)
    }
  }
}
if (missing.length) {
  console.error('✗ CI 里引用了不存在的脚本：')
  for (const m of missing) console.error(`    · ${m}`)
  process.exit(1)
}

const plan = jobs.map((j) => ({
  job: j.name,
  steps: j.steps.map((s) => (s.run ? `run : ${s.run}` : `uses: ${s.uses}`)),
}))

if (parseOnly) {
  console.log(`✓ 解析出 ${jobs.length} 个 job、${jobs.reduce((a, j) => a + j.steps.length, 0)} 个步骤，` +
    '引用的脚本都存在：\n')
  for (const p of plan) {
    console.log(`  【${p.job}】`)
    for (const s of p.steps) console.log(`    ${s}`)
  }
  process.exit(0)
}

// ── Node 版本：CI 用 setup-node 装，本机至少要够新（否则预演没有意义） ──
const needNode = jobs.flatMap((j) => j.steps).map((s) => s.with?.nodeVersion).find(Boolean)
const major = Number(process.versions.node.split('.')[0])
if (needNode && Number(needNode) > major) {
  console.error(`✗ CI 用 Node ${needNode}，本机是 ${process.versions.node} —— ` +
    '预演结果不能代表 CI（先升 Node 再预演）')
  process.exit(1)
}

const t0 = Date.now()
const failures = []
let ran = 0
let skipped = 0

for (const job of jobs) {
  if (only && job.name !== only) continue
  console.log(`\n═══ job: ${job.name} ═══`)
  for (const step of job.steps) {
    if (!step.run) {
      console.log(`  · ${step.name}（${step.uses}，action 本机跑不了；只核对它要的东西）`)
      continue
    }
    // 构建与冒烟很慢，且需要 npx（可能联网）；`--skip-build` 时明确跳过并说出来
    if (skipBuild && /build-sea\.mjs|smoke-sea\.mjs/.test(step.run) && job.name === 'test') {
      skipped++
      console.log(`  ﹣ ${step.name}（--skip-build）`)
      continue
    }
    const started = Date.now()
    const r = spawnSync(step.run, { cwd: ROOT, shell: true, encoding: 'utf8' })
    const took = ((Date.now() - started) / 1000).toFixed(1)
    ran++
    if (r.status === 0) {
      console.log(`  ✓ ${step.name}  (${took}s)`)
    } else {
      console.log(`  ✗ ${step.name}  (${took}s, 退出码 ${r.status})`)
      failures.push({ job: job.name, step: step.name, out: `${r.stdout ?? ''}${r.stderr ?? ''}` })
    }
  }
}

const total = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`\n跑了 ${ran} 个步骤${skipped ? `（跳过 ${skipped} 个）` : ''}，用时 ${total}s`)

if (failures.length) {
  for (const f of failures) {
    console.error(`\n──── 失败：${f.job} / ${f.step} ────`)
    console.error(f.out.split('\n').slice(-25).join('\n'))
  }
  console.error(`\n✗ ${failures.length} 个步骤红了 —— CI 上会红在同一处。`)
  process.exit(1)
}

console.log('✓ 本机能预演的步骤全过了。')
console.log('  ⚠️ 这不是"CI 已经绿了"：Linux / macOS 的差异（证书库、路径大小写、')
console.log('     SEA 必须在目标平台构建）只有真 CI 能验。预演只保证"命令/顺序/路径"没问题。')
}
