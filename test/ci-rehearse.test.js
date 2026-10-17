/**
 * CI 预演脚本的判据（`_lab/rehearse-ci.mjs`）
 * ===========================================
 *
 * 那个脚本的价值在于"**直接读 ci.yml** 来跑，而不是再抄一份命令清单"——
 * 所以它自己的两个前提必须被守住：
 *
 *   ① **解析对**：`ci.yml` 里只有 `jobs:` 下面的两空格键才是 job。
 *      2026-10 第一版就错了：`on:` 下面的 `push:` / `pull_request:` 被当成 job，
 *      解析出了 5 个 job（真的只有 2 个）—— 预演会"多跑几个空 job"然后看起来一切正常。
 *   ② **路径对**：`run: node xxx` 里的脚本必须真的存在。写错一个字母，
 *      预演会红（好），但那说明 CI 上也会第一步就红（不好）—— 所以要在这里、推之前就红。
 *
 * 这里只测"解析 + 路径核对"（`--parse-only`，1 秒级）。真正把 28 个步骤跑一遍
 * 是 `node _lab/rehearse-ci.mjs`（约 2.5 分钟，含构建），不该塞进单元测试。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SCRIPT = path.join(ROOT, '_lab', 'rehearse-ci.mjs')
const CI = path.join(ROOT, '.github', 'workflows', 'ci.yml')

test('真实的 ci.yml 能解析：只有 jobs: 下面才是 job（不是 on: 下面的 push / pull_request）', async () => {
  // 直接 import 解析器，喂它**真的文件内容** —— 比跑外部进程更能定位问题
  // ⚠️ Windows 上必须用 file:// URL：绝对路径（D:\…）会被 ESM 加载器当成协议。
  const { parseWorkflow } = await import(pathToFileURL(SCRIPT).href)
  const jobs = parseWorkflow(readFileSync(CI, 'utf8'))
  assert.deepEqual(jobs.map((j) => j.name), ['test', 'docs'],
    '只有 test 与 docs 两个 job；多出来的（push / pull_request / workflow_dispatch）是 on: 的触发条件')
  for (const job of jobs) {
    assert.ok(job.steps.length > 0, `${job.name} 应当有步骤`)
    for (const step of job.steps) {
      assert.ok(step.run || step.uses, `${job.name} 里有一个步骤既没有 run 也没有 uses`)
    }
  }
  const runs = jobs.flatMap((j) => j.steps).filter((s) => s.run)
  assert.ok(runs.length >= 25, `能跑的命令步骤应当有 25 条以上，实际 ${runs.length}`)
  assert.ok(jobs.find((j) => j.name === 'test').steps.some((s) => /run-tests\.mjs/.test(s.run ?? '')),
    'test job 里必须跑全量测试')
  assert.ok(jobs.find((j) => j.name === 'test').steps.some((s) => /build-sea\.mjs/.test(s.run ?? '')),
    'test job 里必须构建产物（SEA 只能在本平台构建）')
})

test('--parse-only 通过：每个 run: node 指的脚本都真实存在', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--parse-only'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(r.status, 0, `预演脚本的解析阶段应当通过：\n${r.stdout}${r.stderr}`)
  assert.match(r.stdout, /引用的脚本都存在/)
  assert.match(r.stdout, /【test】/)
  assert.match(r.stdout, /【docs】/)
})

test('⭐ 反向验证：ci.yml 里写了不存在的脚本 → 预演在"解析阶段"就红（不用等推上去）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'flicker-rehearse-'))
  try {
    const broken = path.join(dir, 'ci.yml')
    const src = readFileSync(CI, 'utf8').replace('node gen/check-temp-dirs.mjs', 'node gen/check-temp-dir.mjs')
    assert.notEqual(src, readFileSync(CI, 'utf8'), '前提：真的改坏了那份副本')
    writeFileSync(broken, src, 'utf8')
    const r = spawnSync(process.execPath, [SCRIPT, '--parse-only', `--ci=${broken}`],
      { cwd: ROOT, encoding: 'utf8' })
    assert.notEqual(r.status, 0, '脚本路径写错时必须非零退出')
    assert.match(`${r.stdout}${r.stderr}`, /不存在的脚本/)
    assert.match(`${r.stdout}${r.stderr}`, /check-temp-dir\.mjs/, '要点名是哪个脚本')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('预演脚本被写进交接文档（否则没人会在推之前跑它）', async () => {
  const doc = readFileSync(path.join(ROOT, '_lab', '交接.md'), 'utf8')
  assert.match(doc, /rehearse-ci\.mjs/, '交接里要写清"推之前跑这个"')
})
