/**
 * 文档里提到的**文件 / npm 脚本 / 环境变量**，必须真的存在
 * ======================================================
 *
 * ── 为什么要有这一条 ──
 * 这个项目栽过好几次同一类跟头：**文档说"有"，代码里没有**。
 *   · README 让人跑 `npm run test:unit` / `npm run test:serial` —— 这两个脚本从来不存在；
 *   · `PROTOCOL.md` 与路线图引用 `_lab/probe-relay-preempt.mjs` 作为"实测"证据，
 *     而那个脚本**当时并不在仓库里**（引用等于一句空话）；
 *   · 文档里的数字、参数名、协议字段各有一台机器在守，**唯独"文档提到的文件"没人守**。
 *
 * 这一条把文档里的三类引用抠出来逐个核：
 *   ① **仓库内的路径**（`src/…`、`gen/…`、`test/…`、`web/…`、`bin/…`、`relay/…`、
 *     `examples/…`、`_lab/…` + 常见扩展名）→ 必须存在；
 *   ② **`npm run <脚本>`** → 必须在 `package.json` 的 scripts 里；
 *   ③ **`FLICKER_*` 环境变量** → 必须在源码里真的被读过（否则用户设了也没用）。
 *
 * ── 刻意留的两个口子（都要写清理由）──
 *   · 允许清单：少数"长得像我们的路径、其实不是"的（npm 自己的 `bin/npx-cli.js`、
 *     被排除的本机状态示例 `relay/.wrangler/…`）；
 *   · **同一行明说"不存在"的不算**：变更记录里"`npm run test:unit` —— 这两个脚本从来不存在"
 *     是**记录当年那个错误**，把它判红等于逼人把历史抹掉。
 *
 * 用法：
 *   node gen/check-doc-paths.mjs
 *   node gen/check-doc-paths.mjs --root=/tmp/x     （判据自己的测试用）
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 从 `--key=value` 取值 */
export function argOf(argv, name, fallback) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

/** 要扫的文档：两个文档目录 + 根目录那几份 + 交接 */
export function docFiles(root) {
  const out = []
  for (const dir of ['docs', '中文文档']) {
    const full = path.join(root, dir)
    if (!existsSync(full)) continue
    for (const f of readdirSync(full)) if (f.endsWith('.md')) out.push(`${dir}/${f}`)
  }
  for (const f of readdirSync(root)) {
    if (f.endsWith('.md')) out.push(f)
  }
  if (existsSync(path.join(root, '_lab/交接.md'))) out.push('_lab/交接.md')
  return out
}

/**
 * 允许清单：**每一条都必须写清"为什么它不是我们要检查的路径"**。
 * 判据的原则是"能说出理由的例外"，不是"先放着不管"。
 */
export const PATH_ALLOW = [
  {
    re: /^bin\/npx-cli\.js$/,
    why: '这是 **npm 自己**的内部文件（`node <npm>/bin/npx-cli.js`），不是本仓库的文件',
  },
  {
    re: /^relay\/\.wrangler\//,
    why: '文档举的是"这类本机状态不许进赠品包"的例子，文件本身当然不进仓库',
  },
  {
    re: /^relay\/api-token\.txt$/,
    why: '文档举的是"这种文件是凭据、**不许**提交"的反面例子 —— 它就该不存在',
  },
]

/**
 * 从一段 markdown 里抠出三类引用。
 *
 * ⚠️ 扩展名必须**从长到短**排（`json` 在 `js` 前）并且用 `(?![A-Za-z0-9_])` 收边界 ——
 *    否则 `web/page-plugins.json` 会被截成 `web/page-plugins.js`，判成"文件不存在"
 *    （第一版就是这么误报的）。
 */
export function extractRefs(markdown) {
  const lines = String(markdown).split('\n')
  const refs = { paths: [], npmRuns: [], envVars: [] }
  const PATH_RE = /(?<![\w/.-])((?:src|gen|test|web|bin|relay|examples|_lab)\/[A-Za-z0-9_./\u4e00-\u9fa5-]+?\.(?:mjs|cjs|json|md|html|yml|yaml|js|sh|cmd|command|txt|png|fkz))(?![A-Za-z0-9_])/g
  const NPM_RE = /npm run ([A-Za-z0-9:_-]+)/g
  const ENV_RE = /\bFLICKER_[A-Z0-9_]+/g

  lines.forEach((line, i) => {
    for (const m of line.matchAll(PATH_RE)) refs.paths.push({ value: m[1], line: i + 1, text: line })
    for (const m of line.matchAll(NPM_RE)) refs.npmRuns.push({ value: m[1], line: i + 1, text: line })
    for (const m of line.matchAll(ENV_RE)) refs.envVars.push({ value: m[0], line: i + 1, text: line })
  })
  return refs
}

/** 这一行是不是在**记录"它不存在"**（历史叙述），而不是在声称它存在 */
export function saysMissing(line) {
  return /从来不存在|不存在这个脚本|does(?:n't| not) exist|don't exist|do not exist|never existed|not exist/i.test(line)
}

/** 源码里读过哪些 `FLICKER_*` 环境变量 */
export function sourceEnvVars(root) {
  const dirs = ['src', 'bin', 'gen', 'test', 'relay', 'web']
  const out = new Set()
  const walk = (dir) => {
    const full = path.join(root, dir)
    if (!existsSync(full)) return
    for (const name of readdirSync(full)) {
      const p = path.join(full, name)
      const st = statSync(p)
      if (st.isDirectory()) { if (name !== 'node_modules') walk(path.join(dir, name)); continue }
      if (!/\.(mjs|cjs|js|html|json)$/.test(name)) continue
      for (const m of readFileSync(p, 'utf8').matchAll(/\bFLICKER_[A-Z0-9_]+/g)) out.add(m[0])
    }
  }
  for (const d of dirs) walk(d)
  return out
}

/**
 * 核一遍。
 * @returns {{problems:Array<{file:string,line:number,kind:string,value:string,note?:string}>, counts:{paths:number,npmRuns:number,envVars:number}}}
 */
export function checkDocRefs({ root = ROOT, files, allow = PATH_ALLOW } = {}) {
  const list = files ?? docFiles(root)
  const scripts = new Set(Object.keys(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts ?? {}))
  const envs = sourceEnvVars(root)
  const problems = []
  const counts = { paths: 0, npmRuns: 0, envVars: 0 }

  for (const file of list) {
    const src = readFileSync(path.join(root, file), 'utf8')
    const refs = extractRefs(src)
    for (const r of refs.paths) {
      counts.paths++
      const allowed = allow.some((a) => a.re.test(r.value))
      if (allowed) continue
      if (existsSync(path.join(root, r.value))) continue
      problems.push({
        file, line: r.line, kind: '路径', value: r.value,
        note: '文档提到这个文件，仓库里没有 —— 要么补上文件，要么把句子改掉',
      })
    }
    for (const r of refs.npmRuns) {
      counts.npmRuns++
      if (scripts.has(r.value)) continue
      if (saysMissing(r.text)) continue        // 历史叙述："这两个脚本从来不存在"
      problems.push({
        file, line: r.line, kind: 'npm 脚本', value: `npm run ${r.value}`,
        note: 'package.json 里没有这个脚本 —— 用户照着敲只会以为是自己抄错了',
      })
    }
    for (const r of refs.envVars) {
      counts.envVars++
      if (envs.has(r.value)) continue
      problems.push({
        file, line: r.line, kind: '环境变量', value: r.value,
        note: '源码里从来没读过这个变量 —— 用户设了也不起作用',
      })
    }
  }
  return { problems, counts }
}

// ── CLI ──────────────────────────────────────────────────────
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  const root = argOf(process.argv.slice(2), 'root', ROOT)
  const { problems, counts } = checkDocRefs({ root })
  if (problems.length) {
    console.error(`✗ 文档里有 ${problems.length} 处引用对不上：`)
    for (const p of problems) {
      console.error(`   ${p.file}:${p.line}  [${p.kind}] ${p.value}\n      ${p.note}`)
    }
    console.error('\n改法二选一：补上被引用的东西，或者把文档里那句话改掉；' +
      '如果引用的本来就不是本仓库的文件，请把它加进 PATH_ALLOW 并写清理由。')
    process.exit(1)
  }
  console.log(`✓ 文档里的引用都能落地（路径 ${counts.paths} 处 / npm 脚本 ${counts.npmRuns} 处 / 环境变量 ${counts.envVars} 处）`)
}
