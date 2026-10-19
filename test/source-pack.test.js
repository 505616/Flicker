/**
 * 赠品源码包判据（`gen/check-source-pack.mjs`）自己的判据
 * ====================================================
 * 这里发生过的真事故：源码包按手写清单打包，少了一堆 `src/*.js`，
 * 对方解开后跑 `node bin/flicker.js --version` 直接 ERR_MODULE_NOT_FOUND。
 * 所以这台判据必须被反向验：
 *   · 少一个必需文件 → 必须报出缺哪个（而不是只说"跑不起来"）；
 *   · 混进凭据文件（`relay/api-token.txt`）→ 必须报，而且要提醒"等于把钥匙送人"；
 *   · 混进 `dist/` 产物、`node_modules/` → 必须报；
 *   · 清单是**按模块图自动走的**：`requiredFiles()` 必须真的包含 `src/run.js` 这类
 *     当年漏掉的文件（否则清单退化成手写清单，判据就白设了）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  packStructureProblems, requiredFiles, moduleGraph, auditSourcePack, buildPack,
} from '../gen/check-source-pack.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

test('结构判据：少一个必需文件 → 报出是哪个', () => {
  const { missing, forbidden } = packStructureProblems({
    names: ['bin/flicker.js', 'package.json'],
    need: ['bin/flicker.js', 'package.json', 'LICENSE'],
  })
  assert.deepEqual(missing, ['LICENSE'])
  assert.deepEqual(forbidden, [])
})

test('结构判据：混进凭据文件 → 必须报，并被标成凭据类', () => {
  const { forbidden, credential } = packStructureProblems({
    names: ['bin/flicker.js', 'relay/api-token.txt', 'web/receiver.html'],
    need: ['bin/flicker.js'],
  })
  assert.deepEqual(forbidden, ['relay/api-token.txt'])
  assert.deepEqual(credential, ['relay/api-token.txt'], '要能让上层提醒"等于把钥匙送给对方"')
})

test('结构判据：dist/ 产物、node_modules、_lab/out 都不许进包', () => {
  const { forbidden } = packStructureProblems({
    names: ['dist/flicker.exe', 'node_modules/x/index.js', '_lab/out/report.md', 'src/run.js'],
    need: [],
  })
  assert.equal(forbidden.length, 3)
  assert.ok(!forbidden.includes('src/run.js'))
})

test('清单是按模块图走出来的：当年漏掉的 src/*.js 必须真的在里面', () => {
  const need = requiredFiles(ROOT)
  for (const f of ['src/run.js', 'src/gui.js', 'src/tty.js', 'src/assets.js', 'bin/flicker.js']) {
    assert.ok(need.includes(f), `清单里应当有 ${f}（2026-10 就是漏了这些，赠品跑不起来）`)
  }
  // 模块图里的每一项都必须真的存在于仓库（否则清单会把不存在的文件算进去）
  const graph = [...moduleGraph(ROOT, 'bin/flicker.js')]
    .map((p) => path.relative(ROOT, p).replace(/\\/g, '/'))
  for (const f of graph) assert.ok(existsSync(path.join(ROOT, f)), `模块图里的 ${f} 不存在`)
})

test('真仓库：打出来的包结构完整且不可含禁止项（不打第二次包，用现成结果）', async () => {
  const { entries } = await buildPack(ROOT)
  const names = new Set(entries.map((e) => e.rel))
  const { missing, forbidden } = packStructureProblems({ names, need: requiredFiles(ROOT) })
  assert.deepEqual(missing, [], '真包的必需文件都在')
  assert.deepEqual(forbidden, [], '真包里不该有禁止项')
})

test('整条判据（含"解开后真的跑一次"）在真仓库上通过', async () => {
  // 这条会把真包解开到临时目录并执行 `node bin/flicker.js --version` ——
  // 也就是 npm run check 里那一步；放在测试里是为了它能被 CI 之外的入口复验。
  const { problems, info } = await auditSourcePack(ROOT)
  assert.deepEqual(problems, [], problems.join('\n'))
  assert.ok(info.some((l) => l.includes('--version')), '要有"解开后能跑起来"的那句证据')
})
