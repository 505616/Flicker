/**
 * 变更记录的测试
 * ==============
 * 变更记录是最容易"第一版认真写、以后永远不更新"的文件 ——
 * 它不在任何人的必经之路上，改了代码也不会有人想起它。
 *
 * 所以这里钉三件事，都是**能自动判的**：
 *   ① 版本号必须与 `package.json` 一致（两份文件都要有那一行）
 *   ② 中英文两份的版本号集合一致（不能只给一边加）
 *   ③ 它进了配对检查与两份 README（否则新读者根本找不到它）
 *
 * 不判"写得全不全" —— 那没法自动判，硬凑一条只会变成走过场。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const ZH = path.join(ROOT, '变更记录.md')
const EN = path.join(ROOT, 'CHANGELOG.md')

/** 抓出所有 `## [x.y.z]` 形式的版本号（按出现顺序） */
function versions(file) {
  return [...readFileSync(file, 'utf8').matchAll(/^##\s+\[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1])
}

test('⭐ 变更记录的版本号与 package.json 一致', () => {
  assert.ok(existsSync(ZH), '中文变更记录应当是 变更记录.md（根目录）')
  assert.ok(existsSync(EN), '英文变更记录应当是 CHANGELOG.md（根目录）')

  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  for (const [file, label] of [[ZH, '变更记录.md'], [EN, 'CHANGELOG.md']]) {
    const v = versions(file)
    assert.ok(v.length > 0, `${label} 里应当至少有一条 "## [版本号]"`)
    assert.equal(v[0], pkg.version,
      `${label} 的最新版本是 ${v[0]}，而 package.json 是 ${pkg.version} —— ` +
      '发版时要一起改（这条测试就是防"忘了改 changelog"）')
  }
})

test('中英文两份的版本号集合一致（不能只给一边加）', () => {
  assert.deepEqual(versions(EN), versions(ZH),
    '两份变更记录的版本号必须一一对应 —— 只加一边，另一种语言的读者就看不到那一版')
})

test('变更记录进了配对检查（否则它会悄悄漂）', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'gen', 'check-doc-pairs.mjs')], {
    encoding: 'utf8', cwd: ROOT,
  })
  assert.equal(r.status, 0, `配对检查没通过：\n${r.stdout || ''}${r.stderr || ''}`)

  const check = readFileSync(path.join(ROOT, 'gen', 'check-doc-pairs.mjs'), 'utf8')
  assert.match(check, /ROOT_PAIRS/, '检查脚本里要有根目录配对表')
  assert.match(check, /'变更记录\.md'[^]*?'CHANGELOG\.md'|'CHANGELOG\.md'[^]*?'变更记录\.md'/,
    '这对文件必须真的在 ROOT_PAIRS 里 —— 否则根目录那两份没人比')
})

test('两份 README 都指向变更记录', () => {
  const zh = readFileSync(path.join(ROOT, '读我.md'), 'utf8')
  const en = readFileSync(path.join(ROOT, 'README.md'), 'utf8')
  assert.match(zh, /\]\(变更记录\.md\)/, '中文 README 里要有指向 变更记录.md 的链接')
  assert.match(en, /\]\(CHANGELOG\.md\)/, '英文 README 里要有指向 CHANGELOG.md 的链接')
})

test('反向验证脚本在仓库里（证明配对检查真的会失败）', () => {
  const lab = path.join(ROOT, '_lab', 'verify-pairs-check.mjs')
  assert.ok(existsSync(lab), '反向验证脚本应当在 _lab/verify-pairs-check.mjs')
  const src = readFileSync(lab, 'utf8')
  assert.match(src, /CHANGELOG\.md/, '反向验证要覆盖根目录那一对')
  assert.match(src, /finally/, '必须用 try/finally 保证恢复原文')
})
