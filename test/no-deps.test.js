/**
 * 零运行时依赖判据（`gen/check-no-deps.mjs`）自己的判据
 * ================================================
 * 守的这条承诺是整个项目的可信度来源，所以"检查脚本本身有效"必须能验证：
 *   · 真仓库必须过（否则 npm run check 早就红了，写在这里是为了反向用例有对照）；
 *   · dependencies 塞一个包 → 必须报出来；
 *   · 代码里 import 一个裸模块（dependencies 仍为空）→ 必须报出来
 *     —— 这一层才是关键：只查 package.json 会漏掉 `import 'lodash'`；
 *   · `import fs from 'fs'`（不带 node: 前缀的内置模块）与相对路径 → **不许**误报。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditNoDeps } from '../gen/check-no-deps.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** 造一棵最小的假仓库：只需要 package.json + 若干源码文件 */
function fakeRepo({ pkg = {}, files = {} } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'flicker-nodeps-'))
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8')
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }
  return dir
}

test('真仓库：零运行时依赖成立（dependencies 为空且没有裸模块引用）', () => {
  const { problems } = auditNoDeps(ROOT)
  assert.deepEqual(problems, [], '真仓库应当过：\n' + problems.join('\n'))
})

test('dependencies 里塞一个包 → 必须报出来', () => {
  const dir = fakeRepo({ pkg: { dependencies: { lodash: '^4.0.0' } } })
  try {
    const { problems } = auditNoDeps(dir)
    assert.equal(problems.length, 1)
    assert.match(problems[0], /dependencies 不为空：lodash/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dependencies 为空但代码里 import 裸模块 → 必须报出来（这一层最容易漏）', () => {
  const dir = fakeRepo({
    pkg: { dependencies: {} },
    files: { 'src/a.js': "import _ from 'lodash'\nexport default _\n" },
  })
  try {
    const { problems } = auditNoDeps(dir)
    assert.equal(problems.length, 1, '应当只报裸模块这一条，实际：' + JSON.stringify(problems))
    assert.match(problems[0], /src\/a\.js → lodash/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('require() 与动态 import() 的裸模块也要抓（老写法同样算依赖）', () => {
  const dir = fakeRepo({
    files: {
      'src/cjs.cjs': "const x = require('express')\n",
      'src/dyn.js': "const y = await import('axios')\nexport default y\n",
    },
  })
  try {
    const { problems } = auditNoDeps(dir)
    assert.equal(problems.length, 1)
    assert.match(problems[0], /express/)
    assert.match(problems[0], /axios/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('内置模块的旧写法与相对路径不算依赖（不许误报）', () => {
  const dir = fakeRepo({
    files: {
      'src/ok.js': [
        "import fs from 'fs'",
        "import { join } from 'node:path'",
        "import './local.js'",
        "export default fs && join",
      ].join('\n'),
      'src/local.js': 'export const x = 1\n',
    },
  })
  try {
    assert.deepEqual(auditNoDeps(dir).problems, [],
      "`import fs from 'fs'` 是内置模块的老写法，不能报成第三方依赖")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
