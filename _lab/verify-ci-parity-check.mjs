/**
 * 反向验证 `gen/check-ci-parity.mjs`
 * ==================================
 *
 * 一条从不失败的判据等于没有判据。这条守的是"CI 与 npm run check 跑同一批命令"，
 * 所以要证明两件事：
 *   · 真的不一致时它会**失败**（CI 少一条 / 命令被改名 / 本地多了 CI 没有的一条）
 *   · 只是**格式噪音**时它**不该**失败（多一个 `node`、多几个空格、加引号）——
 *     否则它会变成"逼人抄格式"的检查
 *
 * 做法：把 package.json / ci.yml **复制到临时目录**再改坏，用 `--pkg= --ci=` 指向副本跑检查，
 * 仓库里的真文件一个字节都不动（改坏再恢复那套对 yml 的风险太高）。
 *
 * 用法：node _lab/verify-ci-parity-check.mjs
 */
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CHECK = path.join(ROOT, 'gen', 'check-ci-parity.mjs')

const pkgText = await readFile(path.join(ROOT, 'package.json'), 'utf8')
const ciText = await readFile(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')

const dir = await mkdtemp(path.join(tmpdir(), 'flicker-ci-parity-'))

/** 把改过的两份副本写盘，跑检查，返回 { status, out } */
async function runWith({ pkg = pkgText, ci = ciText } = {}) {
  const p = path.join(dir, `package-${Math.random().toString(36).slice(2)}.json`)
  const c = path.join(dir, `ci-${Math.random().toString(36).slice(2)}.yml`)
  await writeFile(p, pkg, 'utf8')
  await writeFile(c, ci, 'utf8')
  const r = spawnSync(process.execPath, [CHECK, `--pkg=${p}`, `--ci=${c}`], { encoding: 'utf8' })
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

const cases = [
  {
    name: 'ci.yml 里删掉一条检查步骤', mustFail: true,
    mutate: () => ({
      ci: ciText.replace(/\n\s*- name: 临时目录前缀都登记在册\n\s*run: node gen\/check-temp-dirs\.mjs\n/, '\n'),
    }),
  },
  {
    name: 'ci.yml 里把一条命令改了名', mustFail: true,
    mutate: () => ({ ci: ciText.replace('node gen/check-temp-dirs.mjs', 'node gen/check-temp-dir.mjs') }),
  },
  {
    name: '本地 check 里多了一条 CI 没有的判据', mustFail: true,
    mutate: () => {
      const pkg = JSON.parse(pkgText)
      pkg.scripts.check += ' && node gen/check-something-new.mjs'
      return { pkg: JSON.stringify(pkg, null, 2) + '\n' }
    },
  },
  {
    name: 'package.json 里没有 scripts.check', mustFail: true,
    mutate: () => {
      const pkg = JSON.parse(pkgText)
      delete pkg.scripts.check
      return { pkg: JSON.stringify(pkg, null, 2) + '\n' }
    },
  },
  {
    // 2026-10 真踩过：把一个 job 级 `env:` 贴进了 steps 列表（缩进 6 空格）。
    // YAML 非法 → GitHub 连 job 都建不出来（run 直接 failure、jobs 计数为 0），
    // 白丢一整轮 CI。判据现在会当场点名那一行。
    name: 'steps 列表里混进了 job 级的键（缩进写错了）', mustFail: true,
    mutate: () => ({
      ci: ciText.replace(/^ {6}- name: 环境$/m,
        "      env:\n        FLICKER_NO_CERT_INSTALL: '1'\n\n      - name: 环境"),
    }),
  },
  {
    name: '只是多写了 node / 多几个空格（格式噪音）→ 不该报错', mustFail: false,
    mutate: () => ({ ci: ciText.replace('run: node gen/check-temp-dirs.mjs', 'run:   node    gen/check-temp-dirs.mjs  ') }),
  },
  {
    name: '只是给命令加了引号（格式噪音）→ 不该报错', mustFail: false,
    mutate: () => ({ ci: ciText.replace('run: node gen/check-temp-dirs.mjs', 'run: node "gen/check-temp-dirs.mjs"') }),
  },
]

let bad = 0
const clean = await runWith()
if (clean.status !== 0) {
  console.error(`✗ 前提不成立：没改过的副本也过不了检查\n${clean.out}`)
  bad++
}

for (const c of cases) {
  const r = await runWith(c.mutate())
  if (c.mustFail && r.status === 0) {
    console.error(`✗ 用例「${c.name}」：文档/配置被改坏了，检查却通过了`)
    bad++
  } else if (!c.mustFail && r.status !== 0) {
    console.error(`✗ 用例「${c.name}」：只是格式变了，检查却报错（会变成"逼人抄格式"）\n${r.out}`)
    bad++
  } else {
    console.log(`✓ 用例「${c.name}」：${c.mustFail ? '检查如实报错' : '检查正确地没有报错'}`)
  }
}

await rm(dir, { recursive: true, force: true })

if (bad) {
  console.error(`\n${bad} 处反向验证未通过`)
  process.exit(1)
}
console.log('✓ 反向验证通过：该失败时会失败，只是格式变了时不会误报')
