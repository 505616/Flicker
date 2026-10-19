/**
 * 文档参数判据（`gen/check-doc-flags.mjs`）自己的判据
 * ================================================
 * 这条判据守的是"文档里写的参数，程序真的认吗"。它自己必须被反向验：
 *   · 真仓库必须过；
 *   · 参数表里写一个程序不认的参数 → 必须抓到（2026-10 实测就这样错了 5 个）；
 *   · 程序认的参数写在**别的章节**里 → 不许误报（判据只看参数参考那一章）；
 *   · 章节标题被改掉 → 必须报"找不到章节"（否则判据会悄悄变成空转）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  auditDocFlags, flagSection, knownFlagsFrom, DOCS,
} from '../gen/check-doc-flags.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const FAKE_CLI = `#!/usr/bin/env node
const USAGE = \`
用法：
  flicker send <路径>       --to=IP --port=端口 --no-open --json
  flicker recv             --out=目录 --name=名字 --gzip
\`
/** 解析 --key=value */
const flags = { to: '', port: '', out: '', json: false, gzip: false }
if (flags.noOpen) {}
if (flags['dry-run']) {}
`

/** 中文手册的参数参考章节（只列给定参数） */
function zhManual(flags) {
  return [
    '# 使用手册',
    '',
    '## 五、接收文件',
    '',
    '这里提到 `--connect` 说明程序不认的参数写在别的章节不算数。',
    '',
    '## 六、完整参数参考',
    '',
    '| 参数 | 说明 |',
    '| --- | --- |',
    ...flags.map((f) => `| \`--${f}\` | 说明 |`),
    '',
    '## 七、退出码',
    '',
    '别的章节结束。',
  ].join('\n')
}

function enManual(flags) {
  return [
    '# Manual',
    '',
    '## 5. Receiving a file',
    '',
    'Mentions `--connect` outside the reference section.',
    '',
    '## 6. Full option reference',
    '',
    '| Option | Meaning |',
    '| --- | --- |',
    ...flags.map((f) => `| \`--${f}\` | meaning |`),
    '',
    '## 7. Exit codes',
  ].join('\n')
}

function fakeRepo({ flags = ['to', 'port', 'out', 'name', 'gzip', 'no-open', 'json'], cli = FAKE_CLI, headers = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'flicker-docflags-'))
  mkdirSync(path.join(dir, 'bin'), { recursive: true })
  writeFileSync(path.join(dir, 'bin', 'flicker.js'), cli, 'utf8')
  for (const rel of DOCS) {
    const body = rel === DOCS[0]
      ? (headers ? zhManual(flags) : zhManual(flags).replace('## 六、完整参数参考', '## 六、参数'))
      : (headers ? enManual(flags) : enManual(flags).replace('## 6. Full option reference', '## 6. Options'))
    const full = path.join(dir, rel)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, body, 'utf8')
  }
  return dir
}

test('真仓库：文档参数表里的参数程序都认', () => {
  const { problems } = auditDocFlags(ROOT)
  assert.deepEqual(problems, [], '真仓库应当过：\n' + problems.join('\n'))
})

test('CLI 里 flag 的三种写法都能被抓到（flags.x / flags[\'x\'] / USAGE 里的 --x）', () => {
  const known = knownFlagsFrom(FAKE_CLI)
  assert.ok(known.has('to'), 'flags.to')
  assert.ok(known.has('dry-run'), "flags['dry-run']")
  assert.ok(known.has('no-open'), 'USAGE 里列出的 --no-open 也算认')
  assert.ok(known.has('gzip'), 'USAGE 里的 --gzip')
})

test('参数表里写了程序不认的参数 → 必须抓到，并指出是哪份文档', () => {
  const dir = fakeRepo({ flags: [...['to', 'port', 'out'], 'nope'] })
  try {
    const { problems } = auditDocFlags(dir)
    assert.equal(problems.length, 2, '中英两份都要报，实际：' + JSON.stringify(problems))
    assert.ok(problems.every((p) => /--nope/.test(p) && /不认这个参数/.test(p)))
    assert.ok(problems.some((p) => p.startsWith(DOCS[0])))
    assert.ok(problems.some((p) => p.startsWith(DOCS[1])))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('别的章节里提到程序不认的参数 → 不许误报（判据只看参数参考那一章）', () => {
  const dir = fakeRepo()
  try {
    // fakeRepo 的"五、接收文件"章节里就写着 `--connect`，它不该被算进去
    assert.deepEqual(auditDocFlags(dir).problems, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('章节标题被改掉 → 必须报"找不到参数参考章节"（否则判据悄悄空转）', () => {
  const dir = fakeRepo({ headers: false })
  try {
    const { problems } = auditDocFlags(dir)
    assert.equal(problems.length, 2)
    assert.ok(problems.every((p) => /找不到"参数参考"章节/.test(p)))
    assert.equal(flagSection('# 无章节\n'), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI 文件不见了 → 报出来而不是静默通过', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'flicker-docflags-'))
  try {
    const { problems } = auditDocFlags(dir)
    assert.equal(problems.length, 1)
    assert.match(problems[0], /读不到 bin\/flicker\.js/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
