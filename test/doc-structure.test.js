/**
 * 文档结构判据（`_lab/check-docs.mjs`）自己的判据
 * ============================================
 * 它守的是"编辑文档没把结构弄坏"：围栏成对、`<details>` 闭合、表格列数一致。
 * 这三类错误渲染前肉眼极难发现，所以判据必须被反向验：
 *   · 围栏落单 → 抓到；成对 → 不报；
 *   · `<details>` 不闭合 → 抓到；
 *   · 表格列数不一致 → 抓到；但 `\|` 转义与行内代码里的竖线 → **不许**误报
 *     （第一版就是这么误报的，改法记在判据的注释里）；
 *   · 默认文件列表里的文档必须真的存在 —— 否则它每天"跳过（不存在）"还一片绿。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { auditDocStructure, DEFAULT_FILES, ROOT } from '../_lab/check-docs.mjs'

function withDocs(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'flicker-docstruct-'))
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), content, 'utf8')
  }
  return dir
}

test('默认列表里的文档都真实存在（否则判据会天天"跳过"还显示通过）', () => {
  const absent = DEFAULT_FILES.filter((f) => !existsSync(path.join(ROOT, f)))
  assert.deepEqual(absent, [], '这些默认体检的文档不见了：' + absent.join(', '))
})

test('真仓库：默认那批文档结构都通过', () => {
  const { problems, missing } = auditDocStructure(DEFAULT_FILES, { root: ROOT })
  assert.deepEqual(missing, [])
  assert.deepEqual(problems, [], '真文档结构有问题：\n' +
    problems.map((p) => `${p.file}: ${p.message}`).join('\n'))
})

test('代码围栏落单 → 抓到；成对 → 不报', () => {
  const dir = withDocs({
    'bad.md': '标题\n\n```js\nconst a = 1\n',
    'good.md': '标题\n\n```js\nconst a = 1\n```\n\n后面还是正文\n',
  })
  try {
    const r = auditDocStructure(['bad.md', 'good.md'], { root: dir })
    assert.equal(r.problems.length, 1)
    assert.equal(r.problems[0].file, 'bad.md')
    assert.match(r.problems[0].message, /代码围栏落单/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('<details> 不闭合 → 抓到', () => {
  const dir = withDocs({
    'bad.md': '<details>\n<summary>x</summary>\n\n正文\n',
    'good.md': '<details>\n<summary>x</summary>\n\n正文\n\n</details>\n',
  })
  try {
    const r = auditDocStructure(['bad.md', 'good.md'], { root: dir })
    assert.equal(r.problems.length, 1)
    assert.match(r.problems[0].message, /<details> 不配对/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('表格列数不一致 → 抓到（并指出起始行与出错行）', () => {
  const dir = withDocs({
    'bad.md': ['| a | b |', '| --- | --- |', '| 1 | 2 | 3 |', ''].join('\n'),
  })
  try {
    const r = auditDocStructure(['bad.md'], { root: dir })
    assert.equal(r.problems.length, 1)
    // 列数怎么数（首尾空串算不算）属于实现细节，这里只钉"指出起始行与出错行"
    assert.match(r.problems[0].message, /表格列数不一致（第 1 行起 \d+ 列，第 3 行 \d+ 列）/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('转义竖线 `\\|` 与行内代码里的竖线 → 不许误报', () => {
  const dir = withDocs({
    'ok.md': [
      '| 命令 | 说明 |',
      '| --- | --- |',
      '| `netstat -ano \\| findstr` | 过滤 |',
      '| `CON|PRN` | 设备名 |',
      '',
    ].join('\n'),
  })
  try {
    assert.deepEqual(auditDocStructure(['ok.md'], { root: dir }).problems, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('文件不存在 → 记进 missing 而不是假装通过', () => {
  const dir = withDocs({})
  try {
    const r = auditDocStructure(['nope.md'], { root: dir })
    assert.deepEqual(r.missing, ['nope.md'])
    assert.equal(r.checked, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
