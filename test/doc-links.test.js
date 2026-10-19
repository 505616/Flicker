/**
 * 文档本地链接判据（`gen/check-doc-links.mjs`）自己的判据
 * ====================================================
 * 这条判据的全部价值在于"改了文档名就红"。所以反向验证必须覆盖：
 *   · 指向不存在文件的链接 → 抓到（并指出是哪个文档、哪条链接）；
 *   · 目标存在 → 不许误报（否则判据会逼人删掉正常链接）；
 *   · 锚点 / http / mailto / 带 %XX 的中文名 → 各按约定处理。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditDocLinks } from '../gen/check-doc-links.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

function fakeRepo(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'flicker-doclinks-'))
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }
  return dir
}

test('真仓库：没有坏链接', () => {
  const { problems } = auditDocLinks(ROOT)
  assert.deepEqual(problems, [], '真仓库里不该有坏链接：\n' + problems.join('\n'))
})

test('指向不存在文件的链接 → 必须抓到，并指出文档与目标', () => {
  const dir = fakeRepo({ 'a.md': '见 [设计](设计文档.md)\n' })
  try {
    const { problems, docs, checked } = auditDocLinks(dir)
    assert.equal(docs, 1)
    assert.equal(checked, 1)
    assert.equal(problems.length, 1)
    assert.match(problems[0], /^a\.md → 设计文档\.md$/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('目标存在 → 不许误报（含子目录、锚点、`%XX` 中文名）', () => {
  const dir = fakeRepo({
    'docs/指南.md': '# 指南\n',
    'b.md': [
      '见 [指南](docs/指南.md)',
      '见 [某节](docs/指南.md#某节)',
      '见 [编码后的名字](docs/%E6%8C%87%E5%8D%97.md)',
      '见 [锚点](#本页标题)',
      '见 [外链](https://example.com/x.md)',
      '见 [邮件](mailto:a@b.c)',
      '见 <docs/指南.md>',
    ].join('\n'),
  })
  try {
    assert.deepEqual(auditDocLinks(dir).problems, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('子目录里的文档按**自己所在目录**解析相对链接（这是最容易写错的一处）', () => {
  const dir = fakeRepo({
    'docs/使用手册.md': '回见 [读我](../读我.md)\n',
    '读我.md': '# 读我\n',
  })
  try {
    assert.deepEqual(auditDocLinks(dir).problems, [], '../读我.md 应当解析到根目录的那份')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('不扫 node_modules / dist 里的 md（它们不进仓库、也不归我们管）', () => {
  const dir = fakeRepo({
    'a.md': '# a\n',
    'node_modules/x/README.md': '见 [不存在](nope.md)\n',
    'dist/release/README.md': '见 [不存在](nope.md)\n',
  })
  try {
    const r = auditDocLinks(dir)
    assert.equal(r.docs, 1, '只该扫到 a.md，实际扫到 ' + r.docs)
    assert.deepEqual(r.problems, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
