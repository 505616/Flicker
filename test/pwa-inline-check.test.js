/**
 * PWA 内联判据的**反向验证**（`gen/inline-pwa.mjs --check`）
 * ======================================================
 * `--check` 的职责是"页面里的内联段必须与 `gen/pwa-assets.mjs` 生成的结果逐字一致" ——
 * 改了图标或主题色却忘了重跑内联脚本时，它必须报错。
 *
 * 2026-10 复查时发现：这条判据只有正例（真仓库通过），**没有任何用例证明它会红**。
 * 于是补了这一条：把两份页面复制到临时目录、改坏其中一段，再要求 `--check` 退出非 0。
 *
 * 为什么用临时目录而不是改真页面：真页面是仓库里被引用的产物，改坏了要恢复；
 * `--root=` 只改变"页面从哪棵树找"，manifest 内容仍然来自本仓库的 `gen/pwa-assets.mjs`
 * （唯一真相不复制第二份）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SCRIPT = path.join(ROOT, 'gen', 'inline-pwa.mjs')
const PAGES = ['receiver.html', 'station.html']

const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' })

function tempTree() {
  const dir = mkdtempSync(path.join(tmpdir(), 'flicker-inlinepwa-'))
  mkdirSync(path.join(dir, 'web'))
  for (const p of PAGES) {
    writeFileSync(path.join(dir, 'web', p), readFileSync(path.join(ROOT, 'web', p), 'utf8'), 'utf8')
  }
  return dir
}

test('真仓库：--check 通过', () => {
  const r = run(['--check'])
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /PWA 内联段都是最新的/)
})

test('⭐ 改坏内联段（主题色变一个字符）→ --check 必须退出非 0', () => {
  const dir = tempTree()
  try {
    const page = path.join(dir, 'web', 'receiver.html')
    const before = readFileSync(page, 'utf8')
    // 改 A.background 的取值（内联段的 JSON 就在 `var A = {…}` 里）
    const mutated = before.replace('"background":"#12141c"', '"background":"#ff0000"')
    assert.notEqual(mutated, before, '用例自己得先改得动（否则它是空转）')
    writeFileSync(page, mutated, 'utf8')

    const r = run(['--check', `--root=${dir}`])
    assert.equal(r.status, 1, '内联段被改坏之后，--check 必须报错')
    assert.match(r.stderr + r.stdout, /不一致/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('整段删掉内联块 → --check 必须报"没有 PWA 内联段"', () => {
  const dir = tempTree()
  try {
    const page = path.join(dir, 'web', 'station.html')
    const html = readFileSync(page, 'utf8')
    const stripped = html
      .replace(/<!-- pwa:begin[\s\S]*?<!-- pwa:end -->/, '')
    assert.notEqual(stripped, html, '用例自己得先真的删掉那一段')
    writeFileSync(page, stripped, 'utf8')

    const r = run(['--check', `--root=${dir}`])
    assert.equal(r.status, 1)
    assert.match(r.stderr + r.stdout, /没有 PWA 内联段/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('原样复制一份（没改）→ --root 指向它也必须通过（证明临时树本身是干净的）', () => {
  const dir = tempTree()
  try {
    const r = run(['--check', `--root=${dir}`])
    assert.equal(r.status, 0, r.stdout + r.stderr)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
