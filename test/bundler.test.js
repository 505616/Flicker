/**
 * 打包器测试
 * ==========
 * 打包器是**构建期工具**：它出错不会让程序崩溃，只会产出一个跑不起来的产物，
 * 或者更糟 —— 一个看起来正常、实际行为不对的产物。所以它必须有测试。
 *
 * 这个文件同时是一份"踩过的坑"清单：
 *   · shebang 只在第一行合法 → 拼接后跑到中间
 *   · import.meta 在 CommonJS 里不存在
 *   · Windows CRLF 让基于正则的语句剥离把文件切碎
 *   · 两个模块各自声明 __dirname → 拼接后撞名
 *   · 顶层 await 在 CommonJS 里非法
 * 每一条都对应下面一个用例。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundle } from '../gen/bundler.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** 造一个临时项目，files 是相对路径 → 内容 */
async function fixture(files) {
  const dir = await mkdtemp(path.join(tmpdir(), 'flicker-bundle-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    await writeFile(abs, content, 'utf8').catch(async (e) => {
      if (e.code === 'ENOENT') {
        const { mkdir } = await import('node:fs/promises')
        await mkdir(path.dirname(abs), { recursive: true })
        await writeFile(abs, content, 'utf8')
      } else throw e
    })
  }
  return { dir, entry: path.join(dir, 'main.js') }
}

// ── 正常路径 ────────────────────────────────────────────────

test('打包真实入口：产出语法合法的 CommonJS', () => {
  const r = bundle(path.join(ROOT, 'bin', 'flicker.js'), {
    replace: [{
      find: /path\.resolve\(path\.dirname\(fileURLToPath\(import\.meta\.url\)\), '\.\.'\)/,
      replace: '__flickerRoot',
    }],
  })
  assert.ok(r.modules.length >= 3, `应包含至少 3 个模块，实际 ${r.modules.length}`)
  assert.ok(r.bytes > 5000, '产物不应是空的')
  assert.doesNotMatch(r.code, /^[ \t]*import\s/m, '不应残留 import')
  assert.doesNotMatch(r.code, /^[ \t]*export\s/m, '不应残留 export')
  assert.doesNotMatch(r.code, /^#!/m, '不应残留 shebang')
  // 依赖必须排在使用者之前
  const assetsIdx = r.code.indexOf('installFromDisk')
  assert.ok(assetsIdx > 0, '应包含 assets.js 的内容')
})

test('模块按依赖顺序排列（依赖在前）', async () => {
  const { entry, dir } = await fixture({
    'main.js': "import { a } from './a.js'\nconsole.log(a)\n",
    'a.js': "import { b } from './b.js'\nexport const a = b + 1\n",
    'b.js': "export const b = 1\n",
  })
  try {
    const r = bundle(entry)
    assert.equal(r.modules.length, 3)
    const iB = r.modules.findIndex((f) => f.endsWith('b.js'))
    const iA = r.modules.findIndex((f) => f.endsWith('a.js'))
    const iM = r.modules.findIndex((f) => f.endsWith('main.js'))
    assert.ok(iB < iA, 'b.js 应排在 a.js 之前')
    assert.ok(iA < iM, 'a.js 应排在 main.js 之前')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

// ── 每一个"踩过的坑"对应一个用例 ────────────────────────────

test('坑 1：入口的 shebang 必须被剥掉（只在第一行合法）', async () => {
  const { entry, dir } = await fixture({
    'main.js': "#!/usr/bin/env node\nimport { x } from './x.js'\nconsole.log(x)\n",
    'x.js': "export const x = 1\n",
  })
  try {
    const r = bundle(entry)
    assert.doesNotMatch(r.code, /^#!/m,
      'shebang 拼接后会落到文件中间，导致 "Invalid or unexpected token"')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('坑 2：import.meta 必须被拒绝（CommonJS 里不存在）', async () => {
  const { entry, dir } = await fixture({
    'main.js': "import { x } from './x.js'\nconsole.log(x, import.meta.url)\n",
    'x.js': "export const x = 1\n",
  })
  try {
    assert.throws(() => bundle(entry), /import\.meta/,
      '用了 import.meta 应当构建失败，而不是产出语法错误的文件')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('坑 2b：注释里提到 import.meta 不应误报', async () => {
  const { entry, dir } = await fixture({
    'main.js': "import { x } from './x.js'\n// 这里不能用 import.meta，会被打包器拒绝\n/* import.meta.url 也不行 */\nconsole.log(x)\n",
    'x.js': "export const x = 1\n",
  })
  try {
    assert.doesNotThrow(() => bundle(entry),
      '检查必须先剥注释 —— 文档里解释"不能用 import.meta"不该触发检查')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('坑 3：CRLF 行尾不能让语句剥离把文件切碎', async () => {
  // 这是真实发生过的：基于正则的剥离在 CRLF 下跨行吞掉了整个文件
  const crlf = (s) => s.split('\n').join('\r\n')
  const { entry, dir } = await fixture({
    'main.js': crlf("import { x } from './x.js'\nconsole.log(x)\n"),
    'x.js': crlf("import { y } from './y.js'\nexport const x = y + 1\n"),
    'y.js': crlf("export const y = 1\nexport const z = 2\n"),
  })
  try {
    const r = bundle(entry)
    assert.ok(r.code.includes('const y = 1'), 'y.js 的实体代码必须保留')
    assert.ok(r.code.includes('const x = y + 1'), 'x.js 的实体代码必须保留')
    assert.ok(r.code.includes('console.log(x)'), '入口的实体代码必须保留')
    assert.doesNotMatch(r.code, /\r/, '产物应使用 LF，避免下游再踩行尾的坑')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('坑 4：跨模块重复的顶层声明必须让构建失败', async () => {
  const { entry, dir } = await fixture({
    'main.js': "import './a.js'\nimport './b.js'\n",
    'a.js': "const __dirname = '/a'\nexport const a = __dirname\n",
    'b.js': "const __dirname = '/b'\nexport const b = __dirname\n",
  })
  try {
    assert.throws(() => bundle(entry), /__dirname/,
      '拼接后两个 __dirname 会直接撞名 —— 必须报出是哪两个文件，' +
      '而不是产出一个无法解析的产物')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('坑 5：入口的顶层 await 必须被拒绝（CommonJS 里非法）', async () => {
  const { entry, dir } = await fixture({
    'main.js': "import { x } from './x.js'\nawait x()\n",
    'x.js': "export const x = async () => 1\n",
  })
  try {
    assert.throws(() => bundle(entry), /顶层 await/,
      '顶层 await 在 CommonJS 里非法 —— 应该构建失败，或者由显式的转换处理')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('坑 5c：函数体里**浅缩进的 await** 不能被误判成顶层 await', async () => {
  // ⚠️ 这是一次真实的构建失败留下的用例。
  //
  //    旧判据是 `/^\s*await\s/m`（扫产物每一行）—— 它分不清"顶层 await"
  //    和"函数体里缩进较浅的 await"。新加的 src/rate.js 里有一行
  //    `await this._sleep(chunk)`，缩进 8 空格
  //    （class 方法 → try → if → while），于是整个构建挂掉，
  //    报错只说"含顶层 await"，没指出是哪一行哪个模块。
  //
  //    正确的分工是：这类判断交给 `node --check`（真实语法检查），
  //    它既不误报也不漏报。下面这个 fixture 就是当初那个形状。
  const { entry, dir } = await fixture({
    'main.js': "import { make } from './m.js'\nmain()\nasync function main() { return make() }\n",
    // 缩进层级与当初踩坑时一致
    'm.js': [
      'export class Limiter {',
      '  async take(n) {',
      '    if (n > 0) {',
      '      while (n > 0) {',
      '        await Promise.resolve()',
      '        n--',
      '      }',
      '    }',
      '  }',
      '}',
      'export const make = async () => new Limiter()',
    ].join('\n'),
  })
  // ⚠️ 清理必须放在 try/finally 里：断言失败时也要删掉临时目录。
  //    这一点是被"系统里冒出两个 flicker- 残留目录"抓出来的 ——
  //    测试自己失败却把垃圾留在用户机器上，和产品留垃圾一样不可接受。
  try {
    const r = bundle(entry)
    assert.ok(r.bytes > 0, '浅缩进的 await 在函数体里是合法的，不该让构建失败')
    assert.doesNotThrow(() => new Function(r.code),
      '产物应当仍是合法 JS（这一步会真正解析一遍）')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('坑 5b：入口的 await main() 会被转换成 Promise 链', async () => {
  const { entry, dir } = await fixture({
    'main.js': "import { run } from './x.js'\nawait main()\nasync function main() { return run() }\n",
    'x.js': "export const run = async () => 0\n",
  })
  try {
    const r = bundle(entry)
    assert.doesNotMatch(r.code, /^\s*await\s/m, '不应残留顶层 await')
    assert.match(r.code, /main\(\)\s*\.then/, 'await main() 应被转成 Promise 链')
    assert.match(r.code, /process\.exitCode/, '转换后要设置退出码，否则调用方拿不到结果')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

// ── 拒绝不合法的输入 ────────────────────────────────────────

test('拒绝非相对的外部依赖（产物必须自包含）', async () => {
  const { entry, dir } = await fixture({
    'main.js': "import x from 'some-npm-package'\nconsole.log(x)\n",
  })
  try {
    assert.throws(() => bundle(entry), /非相对模块/,
      'SEA 产物必须完全自包含，不能有运行期外部依赖')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('内置模块：import 语句被剥掉，但**用到的名字要补上 require 绑定**', async () => {
  // ⚠️ 这条用例从前写的是"内置模块是全局可用的，import 剥掉就行" —— 那个信念是错的，
  //    而且正是 2026-10 那次"单文件产物离开源码树就跑不起来"的根源之一：
  //    `process` / `Buffer` 确实全局，但 `promisify`、`path`、`execFile` 不是。
  //    产物里只硬编码了一小串兜底 require，别的模块一用到就 `xxx is not defined`。
  //    现在改成从源码推导绑定，这条用例改为钉住**新契约**。
  const { entry, dir } = await fixture({
    'main.js': "import { createHash } from 'node:crypto'\n" +
      "import path from 'node:path'\n" +
      "import { execFile as run } from 'node:child_process'\n" +
      'console.log(createHash, path, run)\n',
  })
  try {
    const r = bundle(entry)
    assert.equal(r.modules.length, 1)
    // 不能再有 ESM 语法
    assert.ok(!/^[ \t]*import\s/m.test(r.code), 'import 语句必须被剥掉')
    // 但用到的名字必须真的被绑定
    assert.match(r.code, /const \{ createHash \} = require\('node:crypto'\)/,
      '命名导入要生成对应的 require')
    assert.match(r.code, /const path = require\('node:path'\)/,
      '默认导入要生成对应的 require（path 不是全局的）')
    assert.match(r.code, /const \{ execFile: run \} = require\('node:child_process'\)/,
      '带 as 的命名导入要写成 `{ 原名: 本地名 }` —— ' +
      '写成 `{ run }` 会报 "run is not a function"，因为 node: 模块里没有那个名字')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('⭐ 相对路径的动态 import 必须让构建失败（否则产物离开源码树就跑不起来）', async () => {
  // 这是那次事故的直接原因：打包器只跟静态 import 走模块图，动态 import 的路径
  // 被原样留在产物里。在源码目录里跑恰好能找到旁边的源码（所以整套测试全绿），
  // 复制到桌面双击就 `Cannot find module …src/gui.js`，控制台一闪而过。
  const { entry, dir } = await fixture({
    'main.js': "import { a } from './a.js'\nconst m = await import('./lazy.js')\nconsole.log(a, m)\n",
    'a.js': 'export const a = 1\n',
    'lazy.js': 'export const b = 2\n',
  })
  try {
    assert.throws(() => bundle(entry), /动态 import/,
      '动态 import 必须构建失败 —— 靠人记得"要写成静态"是拦不住的')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('注释里提到的动态 import 不该被误判（判据本身也要精确）', async () => {
  // 文档里解释"不能写成 await import('./gui.js')"的那句话本身就是一段动态 import。
  // 不剥注释就会**被自己的文档**弄红构建 —— 这个坑本项目在 import.meta 上踩过。
  const { entry, dir } = await fixture({
    'main.js': "// 注意：不能写成 await import('./x.js')\n" +
      "/* 也不能写成 import('./y.js') */\n" +
      'export const ok = 1\nconsole.log(ok)\n',
  })
  try {
    const r = bundle(entry)
    assert.match(r.code, /export const ok = 1|const ok = 1/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('⭐ 相对导入的 as 别名要补一条绑定（pkgVersion is not defined）', async () => {
  const { entry, dir } = await fixture({
    'main.js': "import { v as version2 } from './a.js'\nconsole.log(version2)\n",
    'a.js': 'export const v = 42\n',
  })
  try {
    const r = bundle(entry)
    assert.match(r.code, /const version2 = v\b/,
      '别名要生成 `const 别名 = 原名` —— 拼接后依赖模块留下的是原名')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('⭐ 命名空间导入要生成命名空间对象（D is not defined）', async () => {
  const { entry, dir } = await fixture({
    'main.js': "import * as D from './der.js'\nconsole.log(D.SEQUENCE, D.OID)\n",
    'der.js': 'export function SEQUENCE() {}\nexport const OID = 1\n',
  })
  try {
    const r = bundle(entry)
    assert.match(r.code, /const D = \{ SEQUENCE, OID \}/,
      'import * as 要生成命名空间对象 —— 拼接把 import 删掉之后 D 就不存在了')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('同一个名字绑到不同的 node: 模块 → 构建失败（拼接后无法区分）', async () => {
  const { entry, dir } = await fixture({
    'main.js': "import { createServer } from 'node:http'\nimport { helper } from './h.js'\nconsole.log(createServer, helper)\n",
    'h.js': "import { createServer } from 'node:https'\nexport const helper = createServer\n",
  })
  try {
    assert.throws(() => bundle(entry), /不同的 node: 模块/,
      '必须失败并提示用 `import { x as y }` 改名 —— ' +
      '否则生成的 require 会张冠李戴（拿 http 的当 https 的用）')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('拒绝解析不到的相对路径', async () => {
  const { entry, dir } = await fixture({
    'main.js': "import { x } from './nope.js'\nconsole.log(x)\n",
  })
  try {
    assert.throws(() => bundle(entry), /解析不到模块/,
      '缺失的模块必须构建失败，而不是留到运行时才报错')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('拒绝循环依赖（拓扑序拼接无法处理环）', async () => {
  const { entry, dir } = await fixture({
    'main.js': "import { a } from './a.js'\nconsole.log(a)\n",
    'a.js': "import { b } from './b.js'\nexport const a = b\n",
    'b.js': "import { a } from './a.js'\nexport const b = a\n",
  })
  try {
    assert.throws(() => bundle(entry), /循环依赖/,
      '有环时应明确指出，而不是产出一个求值顺序错误的产物')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

// ── 导出的各种写法 ──────────────────────────────────────────

test('正确处理 export const / function / class 与导出列表', async () => {
  const { entry, dir } = await fixture({
    'main.js': "import { A, fn, Klass } from './x.js'\nconsole.log(A, fn, Klass)\n",
    'x.js': "export const A = 1\nexport function fn() {}\nexport class Klass {}\nconst extra = 2\nexport { extra }\n",
  })
  try {
    const r = bundle(entry)
    assert.ok(r.code.includes('const A = 1'), 'export const 应保留实体声明')
    assert.ok(r.code.includes('function fn()'), 'export function 应保留')
    assert.ok(r.code.includes('class Klass'), 'export class 应保留')
    assert.doesNotMatch(r.code, /export\s*\{/, '导出列表应被删除')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('入口的导出名会被收集（供 SEA 入口取用）', async () => {
  const { entry, dir } = await fixture({
    'main.js': "import { x } from './x.js'\nexport async function main() { return x }\nexport const helper = 1\n",
    'x.js': "export const x = 1\n",
  })
  try {
    const r = bundle(entry)
    assert.match(r.code, /globalThis\.__flickerEntry\s*=\s*\{[^}]*main/,
      '入口导出应挂到全局 —— SEA 入口是 CommonJS，取不到 ESM 的导出')
    assert.match(r.code, /__flickerEntry\s*=\s*\{[^}]*helper/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
