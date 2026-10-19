/**
 * 插件文档一致性判据（`gen/check-plugin-doc.mjs`）自己的判据
 * ======================================================
 * 这条判据守的是"文档里的事件表 = 实现的事件表"。它自己必须被反向验：
 *   · 真仓库的两份 `插件.md` 必须过；
 *   · 文档里**少写**一个事件 → 必须报"文档里少了：xxx"；
 *   · 文档里**多写**一个实现里没有的事件 → 必须报"文档里多了"（这一条最要紧：
 *     插件作者照着一个不存在的事件写，`ctx.on()` 会当场抛错，他会以为是自己写错了）；
 *   · 版本号缺失 → 必须报（写错 `apiVersion` 插件会被拒绝加载）。
 *
 * 测试里的"正确文档"是**按代码里的名字现生成**的，不是抄一份 —— 抄一份就成了
 * 第二份会漂移的事实。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditPluginDoc, expectedNames, DOCS } from '../gen/check-plugin-doc.mjs'
import { PLUGIN_TABLE, API_VERSION } from '../src/plugin/events.js'
import { PAGE_API_VERSION } from '../web/page-plugin-runtime.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** 生成一份"与实现完全一致"的插件文档：表格里每个事件一行 */
function goodDoc() {
  const rows = [...expectedNames()].map((n) => `| \`${n}\` | 说明 |`)
  return [
    '# 插件',
    '',
    `\`\`\`js`,
    `module.exports = { apiVersion: ${API_VERSION}, name: 'x' }`,
    `\`\`\``,
    '',
    '页面平面也应该写清楚：`' + `apiVersion: ${PAGE_API_VERSION}` + '`。',
    '',
    '| 事件 | 说明 |',
    '| --- | --- |',
    ...rows,
    '',
  ].join('\n')
}

function fakeRepo({ docs = {} } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'flicker-plugindoc-'))
  for (const [rel, content] of Object.entries(docs)) {
    const full = path.join(dir, rel)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }
  return dir
}

const TWO = () => Object.fromEntries(DOCS.map((rel) => [rel, goodDoc()]))

test('真仓库：两份插件文档都与实现一致', () => {
  const { problems } = auditPluginDoc(ROOT)
  assert.deepEqual(problems, [], '真仓库应当过：\n' + problems.join('\n'))
})

test('按代码生成的一份"正确文档"本身就能过（说明判据与实现同源）', () => {
  const dir = fakeRepo({ docs: TWO() })
  try {
    assert.deepEqual(auditPluginDoc(dir).problems, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('文档里少写一个事件 → 必须报出"文档里少了：<名字>"', () => {
  const docs = TWO()
  const dropped = PLUGIN_TABLE[0].name
  docs[DOCS[0]] = docs[DOCS[0]].split('\n').filter((l) => !l.includes(`\`${dropped}\``)).join('\n')
  const dir = fakeRepo({ docs })
  try {
    const { problems } = auditPluginDoc(dir)
    assert.equal(problems.length, 1, '只该报少了事件这一条，实际：' + JSON.stringify(problems))
    assert.match(problems[0], new RegExp(`文档里少了：.*${dropped.replace('/', '\\/')}`))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('文档里多写一个实现里没有的事件 → 必须报（插件作者会被误导）', () => {
  const docs = TWO()
  const bogus = 'recv/not-a-real-event'
  docs[DOCS[1]] = docs[DOCS[1]].replace('| 事件 | 说明 |', `| 事件 | 说明 |\n| \`${bogus}\` | 假的 |`)
  const dir = fakeRepo({ docs })
  try {
    const { problems } = auditPluginDoc(dir)
    assert.equal(problems.length, 1)
    assert.match(problems[0], /文档里多了（实现里没有）：.*recv\/not-a-real-event/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('版本号写错（整份文档都换掉）→ 程序侧与页面侧各报一条', () => {
  const docs = TWO()
  for (const rel of DOCS) {
    docs[rel] = docs[rel].split(`apiVersion: ${API_VERSION}`).join('apiVersion: 999')
  }
  const dir = fakeRepo({ docs })
  try {
    const { problems } = auditPluginDoc(dir)
    assert.equal(problems.length, 4, '两份文档各缺两个版本号，实际：' + JSON.stringify(problems))
    for (const rel of DOCS) {
      assert.ok(problems.some((p) => p.startsWith(rel) && p.includes(`apiVersion: ${API_VERSION}`)))
      assert.ok(problems.some((p) => p.startsWith(rel) && p.includes('页面平面')))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('只删掉页面平面那一行 → 也必须报（两个版本号当前相同，旧写法这里会漏）', () => {
  // 2026-10 写这条反向用例时发现的真漏洞：API_VERSION 与 PAGE_API_VERSION 都是 1，
  // 于是"程序侧写了、页面侧没写"的文档用 includes 两条都能过 —— 判据一声不响。
  const docs = TWO()
  docs[DOCS[0]] = docs[DOCS[0]].split('\n')
    .filter((l) => !l.includes('页面平面'))
    .join('\n')
  const dir = fakeRepo({ docs })
  try {
    const { problems } = auditPluginDoc(dir)
    assert.equal(problems.length, 1, '只该报页面平面这一条，实际：' + JSON.stringify(problems))
    assert.match(problems[0], /页面平面/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('文档文件本身不存在 → 必须报（改名后判据不能悄悄变成空转）', () => {
  const dir = fakeRepo({ docs: {} })
  try {
    const { problems } = auditPluginDoc(dir)
    assert.equal(problems.length, DOCS.length, '两份文档都不存在，应当各报一条')
    assert.ok(problems.every((p) => /文件不存在/.test(p)))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
