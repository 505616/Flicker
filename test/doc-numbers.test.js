/**
 * 文档数字判据（`gen/check-doc-numbers.mjs`）自己的判据
 * ==================================================
 * 这条判据盯着"文档里会过期的数字"。它自己也得有判据，否则它就是
 * 又一个"看起来在管、其实从不失败"的检查。
 *
 * 三件事各验一遍：
 *   ① **算得对**：i18n 条数 / 判据条数 / 文档份数 / 版本号 / Node 版本 —— 都得等于源码里的真值
 *      （不是写死数字，而是与源文件重算一遍对比：写死就成了第二份会漂移的事实）。
 *   ② **真的会红**：把一份真文档里的数字改坏，必须报出**文件与行号**；
 *      把句式整句删掉，必须报"没找到声明"（否则哪天那句话没了，判据会悄悄失效）。
 *   ③ **历史叙述不许被误伤**：变更记录里"171 → 实际 319"那种是**记录当年那次修正**，
 *      写死才对 —— 判据的正则必须贴着"当前事实"的句式，不能去扫所有数字。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  checkFacts, checkTestStatus, collectFacts, makeReader, sameNumber,
} from '../gen/check-doc-numbers.mjs'
import { STRINGS } from '../web/i18n-strings.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const read = makeReader(ROOT)

test('① 每条 fact 的值都等于源码里的真值（不是抄一遍）', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const facts = collectFacts({ root: ROOT })
  const value = (id) => facts.find((f) => f.id === id)?.value

  assert.equal(value('i18n.count'), String(Object.keys(STRINGS.zh).length))
  assert.equal(Object.keys(STRINGS.zh).length, Object.keys(STRINGS.en).length,
    '中英文案必须一一对应，否则 i18n 条数这条判据算出来就没有意义')
  assert.equal(value('check.count'), String(pkg.scripts.check.split('&&').filter((s) => s.trim()).length))
  assert.equal(value('docs.zh'), String(readdirSync(path.join(ROOT, '中文文档')).filter((f) => f.endsWith('.md')).length))
  assert.equal(value('docs.en'), String(readdirSync(path.join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).length))
  assert.equal(value('version'), pkg.version)
  assert.equal(value('node.major'), String(String(pkg.engines.node).replace(/[^\d.]/g, '').split('.')[0]))
})

test('① 现在的文档必须全对（否则 npm run check 就红了）', () => {
  const facts = collectFacts({ root: ROOT })
  const r = checkFacts({ facts, read })
  assert.deepEqual(r.problems, [], '文档里的数字与实现不一致：\n' +
    r.problems.map((p) => `${p.file}:${p.line ?? '?'} ${p.note ?? p.expected}`).join('\n'))
  assert.ok(r.checked >= 5, `至少要有 5 条事实在真被核（实际 ${r.checked}）`)
})

test('② 反向验证：把文档里的数字改坏，必须报出**文件与行号**', () => {
  const facts = collectFacts({ root: ROOT })
  const bad = makeReader(ROOT)
  const file = '变更记录.md'
  const real = read(file)
  const mutated = real.replace(/(\d+) 条文案并列/, '999 条文案并列')
  assert.notEqual(mutated, real, '测试自己得先改得动这句话（否则这条用例是空转）')
  const r = checkFacts({
    facts,
    read: (rel) => (rel === file ? mutated : read(rel)),
  })
  const hit = r.problems.find((p) => p.fact === 'i18n.count' && p.file === file)
  assert.ok(hit, '改坏之后必须报出来')
  assert.match(String(hit.line), /^\d+$/, '要报出**行号**（只报文件名等于让人自己找）')
  assert.equal(hit.expected, String(Object.keys(STRINGS.zh).length))
})

test('② 反向验证：句式被整句删掉 → 报"没找到声明"，不许当没事', () => {
  const facts = collectFacts({ root: ROOT })
  const file = 'docs/路线图.md'
  const real = read(file)
  // ⚠️ 按**当前**条数构造反例：写死 373 的话，文案表一改这条用例自己就失效
  //    （而它失效的样子是"通过"—— 比红更糟）。
  const n = collectFacts({ root: ROOT }).find((f) => f.id === 'i18n.count').value
  const stripped = real.replace(new RegExp(`\\(${n} strings, Chinese and English side by side\\)`), '(文案条数见下)')
  assert.notEqual(stripped, real)
  const r = checkFacts({ facts, read: (rel) => (rel === file ? stripped : read(rel)) })
  const hit = r.problems.find((p) => p.file === file && /没找到这句声明/.test(String(p.note)))
  assert.ok(hit, '句子没了就必须报"没找到声明" —— 否则判据会悄悄失效，而"检查还在跑"会骗人')
})

test('③ 历史叙述不受影响：动"当年那次修正"里的老数字，判据不该有反应', () => {
  const facts = collectFacts({ root: ROOT })
  const file = '变更记录.md'
  const real = read(file)
  assert.match(real, /171 → 实际 319/, '变更记录里应当保留"当年 171 → 修正为 319"这条历史')
  // 把**历史那句**里的数字换成别的：它不是当前事实，判据不该因此报错
  const mutated = real.replace('171 → 实际 319', '999 → 实际 999')
  assert.notEqual(mutated, real, '测试自己得先改得动那句历史')
  const r = checkFacts({ facts, read: (rel) => (rel === file ? mutated : read(rel)) })
  assert.deepEqual(r.problems, [], '历史叙述里的数字不该被这条判据管 —— 否则它就是"扫所有数字"的坏判据')
})

test('数字比较：版本号逐字比、MB 允许容差', () => {
  assert.ok(sameNumber('0.1.0', '0.1.0'))
  assert.ok(!sameNumber('1.0.0', '0.1.0'))
  assert.ok(sameNumber('94.6', '94.6'))
  assert.ok(sameNumber('94.5', '94.6', 0.1), '±0.1 之内算一致（产物会因文档本身而浮动）')
  assert.ok(!sameNumber('94.0', '94.6', 0.1))
  assert.ok(!sameNumber('abc', '94.6', 0.1))
})

test('--artifact：产物不在时不假装核过（会自己跳过）', () => {
  // 这条只验"收集器在没产物时不硬造事实"，真正的产物核对在 CI 的 Windows job 里跑
  const facts = collectFacts({ root: ROOT, includeArtifact: false })
  assert.ok(!facts.some((f) => f.id === 'artifact.exeMb'), '不加 --artifact 时不该有产物大小的事实')
})

test('--artifact：真产物比文档大/小超过 0.1 MB 时必须红（用临时目录造产物，不碰 dist/）', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const root = mkdtempSync(path.join(tmpdir(), 'flicker-docnum-'))
  try {
    mkdirSync(path.join(root, 'dist', 'release'), { recursive: true })
    // 造一个正好 1 MiB 的"产物"与一个 0.5 MiB 的 zip
    writeFileSync(path.join(root, 'dist', 'flicker-9.9.9-windows-x64.exe'), Buffer.alloc(1048576))
    writeFileSync(path.join(root, 'dist', 'release', 'flicker-x.exe.zip'), Buffer.alloc(524288))
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '9.9.9', engines: { node: '>=24.0.0' } }))
    mkdirSync(path.join(root, '中文文档'), { recursive: true })
    mkdirSync(path.join(root, 'docs'), { recursive: true })
    const doc = [
      '| 未压缩（exe） | 1.0 MB |',
      '| zip | **0.5 MB（50%）** |',
      '约 1.0 MB → 0.5 MB',
    ].join('\n')
    writeFileSync(path.join(root, '中文文档', '构建单文件.md'), doc, 'utf8')
    writeFileSync(path.join(root, 'docs', '构建单文件.md'),
      ['| Uncompressed (the exe) | 1.0 MB |', '| The zip | **0.5 MB (50%)** |'].join('\n'), 'utf8')
    writeFileSync(path.join(root, '读我.md'), '约 1.0 MB → 0.5 MB', 'utf8')
    writeFileSync(path.join(root, 'README.md'), 'about 1.0 MB → 0.5 MB', 'utf8')

    const facts = collectFacts({ root, includeArtifact: true })
      .filter((f) => f.id.startsWith('artifact.'))
    assert.equal(facts.length, 2, '产物事实应当有 exe 与 zip 两条')
    assert.equal(facts.find((f) => f.id === 'artifact.exeMb').value, '1.0')
    assert.equal(facts.find((f) => f.id === 'artifact.zipMb').value, '0.5')
    const reader = makeReader(root)
    assert.deepEqual(checkFacts({ facts, read: reader }).problems, [], '文档写的 1.0 / 0.5 应当通过')

    // 文档写 2.0（差 1 MB）→ 必须红；写 1.1（差 0.1）→ 容差内，通过
    writeFileSync(path.join(root, '读我.md'), '约 2.0 MB → 0.5 MB', 'utf8')
    const bad = checkFacts({ facts, read: makeReader(root) }).problems
    assert.ok(bad.some((p) => p.fact === 'artifact.exeMb'), '差 1 MB 必须报出来')

    writeFileSync(path.join(root, '读我.md'), '约 1.1 MB → 0.5 MB', 'utf8')
    assert.deepEqual(checkFacts({ facts, read: makeReader(root) }).problems, [],
      '±0.1 MB 之内应当算一致（改一次文档产物就会浮动几十 KB）')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── "测试现状"那一行：只许钉用例总数与失败数，不许钉跳过条数 ────────────
//
// 2026-10 复查时这两份 README 都写着 `721 通过、0 失败、4 跳过`，而同一台机器
// 换个跑法实测就是 1 条跳过 —— 跳过条数是环境属性，写死必然过期。下面四条把
// "它能抓出旧写法"和"它不会误伤正确写法"两件事都钉住。

const statusDoc = (zh, en) => (rel) => ({
  '读我.md': zh,
  'README.md': en,
}[rel] ?? null)

test('测试现状那一行：现在两份 README 都合规（且确实被读到）', () => {
  const r = checkTestStatus({ read: makeReader(ROOT) })
  assert.deepEqual(r.problems, [], '两份 README 的测试现状应当只写用例总数与失败数：\n' +
    r.problems.map((p) => `${p.file}:${p.line ?? '?'} ${p.note ?? p.claim}`).join('\n'))
})

test('测试现状那一行：写死"N 跳过"必须被抓出来（就是这次修掉的旧写法）', () => {
  const read = statusDoc(
    '**测试现状：725 个用例，721 通过、0 失败、4 跳过。**',
    '**Tests: 725 cases — 721 pass, 0 fail, 4 skipped.**')
  const p = checkTestStatus({ read }).problems
  assert.equal(p.length, 2, '中英两份都要报，实际：' + JSON.stringify(p.map((x) => x.file)))
  assert.ok(p.every((x) => /跳过条数|skipped/.test(x.expected)), '要指出"不许写死跳过条数"，实际：' +
    JSON.stringify(p.map((x) => x.expected)))
})

test('测试现状那一行：失败数不是 0 必须报（文档不能掩盖失败）', () => {
  const read = statusDoc(
    '**测试现状：725 个用例，3 失败。**',
    '**Tests: 725 cases, 3 failures.**')
  const p = checkTestStatus({ read }).problems
  assert.equal(p.length, 2)
  assert.ok(p.every((x) => /0 失败/.test(x.expected)))
})

test('测试现状那一行：整句被删掉也必须报（否则判据悄悄失效）', () => {
  const read = statusDoc('## 读我\n\n什么都没写\n', '## Read me\n\nnothing here\n')
  const p = checkTestStatus({ read }).problems
  assert.equal(p.length, 2)
  assert.ok(p.every((x) => /找不到/.test(x.note)), '要说明"句子被删掉之后判据就失效了"')
})

test('测试现状那一行：说明性的"本轮实测 1 条 / 5 条"不算写死（不误伤）', () => {
  const read = statusDoc(
    '**测试现状：725 个用例，0 失败。** 本轮实测：本机 1 条、CI 上 5 条。',
    '**Tests: 725 cases, 0 failures.** This run: 1 locally, 5 in CI.')
  assert.deepEqual(checkTestStatus({ read }).problems, [],
    '只写"总量 + 失败数 + 本轮实测"是正确的写法，不能因为出现数字就报错')
})
