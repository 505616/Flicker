/**
 * 中英文文档配对判据（`gen/check-doc-pairs.mjs`）自己的判据
 * ====================================================
 * 这条判据守的是"两份文档不许各漂各的"。它自己必须被反向验：
 *   · 少一份英文（或中文）→ 必须报"没有对应的英文版"；
 *   · 少一个二级标题 / 少一个代码围栏 / 少一行表格 → 必须报结构不一致；
 *   · 内容措辞不同但结构相同 → **不许**误报（否则会逼人凑字数）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { comparePairDocs, compareStructures, structureOf, ROOT_PAIRS } from '../gen/check-doc-pairs.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const ZH_DOC = [
  '# 标题',
  '',
  '## 一、小节',
  '',
  '### 1.1 更小',
  '',
  '```powershell',
  'flicker send x',
  '```',
  '',
  '| a | b |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
].join('\n')

/** 结构相同、措辞不同（应当通过） */
const EN_DOC = [
  '# Title',
  '',
  '## 1. Section',
  '',
  '### 1.1 Smaller',
  '',
  '```powershell',
  'flicker send x',
  '```',
  '',
  '| a | b |',
  '| --- | --- |',
  '| one | two |',
  '',
].join('\n')

function fakeTree({ zh = {}, en = {}, rootFiles = {}, pairs = [] } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'flicker-docpairs-'))
  mkdirSync(path.join(dir, '中文文档'))
  mkdirSync(path.join(dir, 'docs'))
  for (const [n, c] of Object.entries(zh)) writeFileSync(path.join(dir, '中文文档', n), c, 'utf8')
  for (const [n, c] of Object.entries(en)) writeFileSync(path.join(dir, 'docs', n), c, 'utf8')
  for (const [n, c] of Object.entries(rootFiles)) writeFileSync(path.join(dir, n), c, 'utf8')
  return { dir, pairs }
}

test('structureOf：数出标题层级、围栏、表格行', () => {
  assert.deepEqual(structureOf(ZH_DOC), { h1: 1, h2: 1, h3: 1, fences: 2, tableRows: 3 })
})

test('措辞不同但结构相同 → 不许误报', () => {
  const { dir } = fakeTree({ zh: { 'a.md': ZH_DOC }, en: { 'a.md': EN_DOC } })
  try {
    assert.deepEqual(comparePairDocs({ root: dir, rootPairs: [] }).problems, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('少一份英文 → 必须报（反向同理）', () => {
  const { dir } = fakeTree({ zh: { 'a.md': ZH_DOC, 'b.md': ZH_DOC }, en: { 'a.md': EN_DOC } })
  try {
    const p = comparePairDocs({ root: dir, rootPairs: [] }).problems
    assert.equal(p.length, 1)
    assert.match(p[0], /中文文档\/b\.md 没有对应的英文版/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('英文多一份 → 也必须报（不能只查一个方向）', () => {
  const { dir } = fakeTree({ zh: { 'a.md': ZH_DOC }, en: { 'a.md': EN_DOC, 'c.md': EN_DOC } })
  try {
    const p = comparePairDocs({ root: dir, rootPairs: [] }).problems
    assert.equal(p.length, 1)
    assert.match(p[0], /docs\/c\.md 没有对应的中文版/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('少一个标题 / 少一个围栏 / 少一行表格 → 三种漂移各自被抓到', () => {
  // 注意"降级一个标题"会同时改变两级标题的数量（## → ###），所以只钉"抓到了对应的那一维"
  const cases = [
    ['少一个二级标题', ZH_DOC.replace('## 一、小节', '### 一、小节（降级）'), /二级标题/],
    ['少一个代码围栏', ZH_DOC.replace('```powershell', ''), /代码围栏/],
    ['少一行表格', ZH_DOC.replace('| 1 | 2 |\n', ''), /表格行/],
  ]
  for (const [label, mutated, re] of cases) {
    assert.notEqual(mutated, ZH_DOC, `用例自己得先改得动（${label}）`)
    const { dir } = fakeTree({ zh: { 'a.md': mutated }, en: { 'a.md': EN_DOC } })
    try {
      const p = comparePairDocs({ root: dir, rootPairs: [] }).problems
      assert.ok(p.length >= 1, `${label}：一条都没报`)
      assert.ok(p.some((x) => re.test(x)), `${label}：没指出对应的那一维，实际 ${JSON.stringify(p)}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('compareStructures 直接比两个指纹也能用（CLI 与测试同一个实现）', () => {
  const a = structureOf(ZH_DOC)
  assert.deepEqual(compareStructures('x ↔ y', a, a), [])
  assert.equal(compareStructures('x ↔ y', a, { ...a, fences: a.fences - 1 }).length, 1)
})

test('根目录那几对也要比结构', () => {
  const zhRoot = '# 记录\n\n## 一、小节\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n'
  const enRoot = '# Log\n\n## 1. Section\n\n| a | b |\n| --- | --- |\n| one | two |\n'
  const { dir } = fakeTree({
    rootFiles: { '变更记录.md': zhRoot, 'CHANGELOG.md': enRoot },
  })
  try {
    const ok = comparePairDocs({ root: dir, rootPairs: [['变更记录.md', 'CHANGELOG.md']] })
    assert.deepEqual(ok.problems, [])
    const bad = comparePairDocs({ root: dir, rootPairs: [['变更记录.md', '读我.md']] })
    assert.equal(bad.problems.length, 1)
    assert.match(bad.problems[0], /根目录缺少 读我\.md/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('真仓库：两份文档一一对应且结构一致', () => {
  const { problems, zhFiles, enFiles } = comparePairDocs({ root: ROOT })
  assert.deepEqual(problems, [], '真仓库不该有不配对：\n' + problems.join('\n'))
  assert.equal(zhFiles.length, enFiles.length)
  assert.ok(zhFiles.length >= 11, `中文文档至少 11 份（实际 ${zhFiles.length}）`)
  assert.equal(ROOT_PAIRS.length, 2, '根目录那两对（变更记录 / 作者的话）不能少')
})
