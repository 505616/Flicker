/**
 * 文档配对测试
 * =============
 * 用户的要求：文档做两份（中文一份、英文一份），分两个文件夹：
 *   中文 → `中文文档/`，英文 → `docs/`，文件名一一对应。
 *
 * 为什么必须有这条测试（而不是只放在 `npm run check` 里）：
 * `npm test` 是开发者最常跑的命令，而"加了一份中文文档、忘了英文那份"
 * 恰恰是开发过程中最容易发生的事。静态检查漏在 CI 之外时，测试还能拦住。
 *
 * 判据直接跑 `gen/check-doc-pairs.mjs`（**同一份实现**，不重新写一遍比较逻辑）——
 * 两处各写一套的话，迟早会出现"测试过了、检查没过"这种谁也说不清的场面。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

test('⭐ 中英文文档一一对应：两边文件名必须配得上', () => {
  const zh = path.join(ROOT, '中文文档')
  const en = path.join(ROOT, 'docs')
  assert.ok(existsSync(zh), '中文文档应当都在 中文文档/ 里')
  assert.ok(existsSync(en), '英文文档应当都在 docs/ 里')

  const md = (d) => readdirSync(d).filter((f) => f.endsWith('.md')).sort()
  const zhFiles = md(zh)
  const enFiles = md(en)

  assert.ok(zhFiles.length >= 10, `中文文档应当有 10 份以上，实际 ${zhFiles.length}`)
  assert.deepEqual(zhFiles, enFiles,
    '两边的文件名必须一一对应 —— 中文加了新文档、英文没跟上（或反过来），' +
    '只读一种语言的读者就永远看不到那一份')

  for (const f of ['使用手册.md', 'SECURITY.md', 'PROTOCOL.md']) {
    assert.ok(zhFiles.includes(f), `中文文档/ 里应有 ${f}`)
  }
})

test('⭐ 文档配对检查本身通过（结构一致，不只是文件名）', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'gen', 'check-doc-pairs.mjs')], {
    encoding: 'utf8', cwd: ROOT,
  })
  assert.equal(r.status, 0,
    `中英文文档结构不一致：\n${r.stdout || ''}${r.stderr || ''}`)
})

test('文档配对检查进了检查链与 CI（否则只有手动跑才会发现漂移）', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.match(pkg.scripts.check, /check-doc-pairs\.mjs/,
    'npm run check 里要跑文档配对检查')
  const ci = readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
  assert.match(ci, /check-doc-pairs\.mjs/, 'CI 里也要跑')
})

test('两个 README 在根目录，且中文那份额外指向英文版', () => {
  // 用户的要求：中文 README 改名「读我」、英文的去掉 .en，两份都放根目录
  assert.ok(existsSync(path.join(ROOT, '读我.md')), '中文 README 应当是 读我.md')
  assert.ok(existsSync(path.join(ROOT, 'README.md')), '英文 README 应当是 README.md')
  assert.ok(!existsSync(path.join(ROOT, 'README.en.md')), 'README.en.md 不该还在（已改名）')

  const zh = readFileSync(path.join(ROOT, '读我.md'), 'utf8')
  assert.match(zh, /\]\(README\.md\)/, '中文 README 里要有指向英文版的一行')
  const en = readFileSync(path.join(ROOT, 'README.md'), 'utf8')
  assert.match(en, /\]\(读我\.md\)/, '英文 README 里要有指向中文版的一行')
})

test('⭐ 新增一份文档时，赠品源码包也必须带上它', async () => {
  // 用户的要求是"送闪传就一起送 EXE、源码还有文档"。
  //
  // ⚠️ 这里从前查的是 `src/gift.js` 里那份**手写清单**（SOURCE_FILES）。
  //    2026-10 实测发现那份清单只有 40 项：`src/run.js`、`src/gui.js`、`src/assets.js`、
  //    `src/relay/*` 全不在里面 —— 把包解开跑 `node bin/flicker.js --version`，
  //    第一句就 ERR_MODULE_NOT_FOUND，**对方收到的是跑不起来的半份源码**。
  //    所以清单换成了"遍历整棵树 + 黑名单"（`collectSourceFiles`），
  //    这里也就改成**直接问打包函数要文件清单**（不再解析源码文本，免得再一次漂移）。
  const { installFromDisk } = await import('../src/assets.js')
  installFromDisk(ROOT)

  const { buildSourcePack, unpackArchive } = await import('../src/gift.js')
  const pack = await buildSourcePack(ROOT)
  // 从包里读回文件清单 —— 用 `src/gift.js` 的**唯一**读实现（别在这里再手写一份解析器）
  const names = unpackArchive(pack.bytes).map((e) => e.rel)
  const listed = new Set(names)

  for (const dir of ['中文文档', 'docs']) {
    const files = readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.md'))
    assert.ok(files.length >= 11, `${dir}/ 里应当有 11 份以上文档，实际 ${files.length}`)
    for (const f of files) {
      assert.ok(listed.has(`${dir}/${f}`),
        `赠品源码包里少了 ${dir}/${f} —— 对方收到的源码包里没有这一份`)
    }
  }
  for (const f of ['读我.md', 'README.md', '变更记录.md', 'CHANGELOG.md', 'LICENSE',
    'bin/flicker.js', 'src/run.js', 'package.json']) {
    assert.ok(listed.has(f), `赠品源码包里少了 ${f}`)
  }
  // 反向：构建产物与临时垃圾**不许**进包（91 MB 的 exe 混进去过一次就够呛）
  for (const n of names) {
    assert.ok(!n.startsWith('dist/'), `源码包里不该有构建产物：${n}`)
    assert.ok(!n.startsWith('node_modules/'), `源码包里不该有 node_modules：${n}`)
    assert.ok(!n.startsWith('_lab/out/'), `源码包里不该有体检日志：${n}`)
  }
})
