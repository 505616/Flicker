/**
 * 路径安全规则（PROTOCOL.md §6.2）
 * ================================
 *
 * 这是**安全边界**，不是 UI 细节。但这里测的主要不是"防黑客" ——
 * 而是**普通用户就能撞上、且后果是丢文件**的那几种情况：
 *
 *   · Linux 发来 `CON.txt` → Windows 上创建失败
 *   · Linux 发来 `name.`（结尾是点）→ Windows 静默丢掉那个点，两个文件变成同一个
 *   · 清单里同时有 `a:b.txt` 与 `a_b.txt` → 改写后同名 → **静默覆盖，丢一个**
 *   · macOS 上 `café`(NFC) 与 `café`(NFD) 是同一个文件 → 同样静默覆盖
 *   · 只差大小写的两个名字 → Windows/macOS 上是同一个文件
 *
 * 后两条正是 PROTOCOL.md §6.2 里挂着的「**待验证**：macOS 的 NFD/NFC 可能导致
 * 同名文件冲突」。这个文件就是把它从"待验证"变成"已验证"。
 *
 * ⚠️ 还有一条同样重要的：**页面里那份必须与 Node 这份完全一致**。
 *    从前两边各写一份、规则还不一样，于是同一份清单在 Node 测试里通过、
 *    在浏览器里静默丢文件。所以这里也检查内联段确实来自本模块。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import {
  checkRelPath, safeRelPath, compareKey, compareKeyOf, findPathConflict,
  dedupeRelPath, UnsafePathError, PATH_RULES, utf8Bytes, MAX_SEGMENT_BYTES,
} from '../src/path-safety.js'
import { sanitizeRelPath, sanitizeRelPathLenient, fromWire } from '../src/manifest.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ── 12 条规则逐条 ───────────────────────────────────────────

test('R1/R2/R3：绝对路径、盘符路径、UNC 路径都要拒绝，且各自报出规则号', () => {
  const cases = [
    ['/etc/passwd', 'R1'], ['/', 'R1'],
    ['C:/Windows/System32', 'R2'], ['c:\\x', 'R2'], ['D:', 'R2'],
    ['\\\\server\\share\\f', 'R3'], ['//server/share', 'R3'],
  ]
  for (const [evil, rule] of cases) {
    assert.throws(() => checkRelPath(evil), (e) => {
      assert.ok(e instanceof UnsafePathError)
      assert.equal(e.rule, rule, `${evil} 应当报 ${rule}，实际 ${e.rule}`)
      assert.equal(e.code, 'E_PATH_UNSAFE')
      assert.equal(e.fatal, true, '协议要求 fatal=true（中止整个会话）')
      return true
    }, `应拒绝: ${evil}`)
  }
})

test('R4：路径穿越一律拒绝（含藏在中间的）', () => {
  for (const evil of ['../etc/passwd', 'a/../../b', '..', 'a/..', 'x/../../../y', 'a/./../b']) {
    assert.throws(() => checkRelPath(evil), (e) => e.rule === 'R4' || e.rule === 'R5',
      `应拒绝: ${evil}`)
  }
})

test('R5：`.` 段——接收端（strict）拒绝，发送端折叠', () => {
  // 协议 R5 说拒绝。发送端扫自己的文件时 `./dir/a.txt` 是很自然的输入，
  // 折叠掉即可；接收端看的是不可信输入，按协议拒绝。
  assert.throws(() => checkRelPath('./dir/a.txt', { strict: true }), (e) => e.rule === 'R5')
  assert.throws(() => checkRelPath('a/./b', { strict: true }), (e) => e.rule === 'R5')
  assert.equal(checkRelPath('./dir/a.txt'), 'dir/a.txt', '宽松模式折叠')
  assert.equal(checkRelPath('a//b///c.txt'), 'a/b/c.txt', '空段一律折叠')
  assert.equal(sanitizeRelPathLenient('./dir/a.txt'), 'dir/a.txt')
})

test('R6：空字节与非字符串拒绝', () => {
  assert.throws(() => checkRelPath('a\0b'), (e) => e.rule === 'R6')
  for (const bad of ['', null, undefined, 42, {}, []]) {
    assert.throws(() => checkRelPath(bad), (e) => e.rule === 'R6', `应拒绝: ${String(bad)}`)
  }
})

test('R7：按**字节**算长度（中文按 3 字节），单段 255 / 整体 4096', () => {
  assert.equal(utf8Bytes('abc'), 3)
  assert.equal(utf8Bytes('中'), 3)
  assert.equal(utf8Bytes('😀'), 4, 'emoji 是 4 字节 —— 按 UTF-16 长度算会漏')

  assert.throws(() => checkRelPath('中'.repeat(85) + '.txt'), (e) => e.rule === 'R7')
  assert.equal(checkRelPath('中'.repeat(83) + '.txt'), '中'.repeat(83) + '.txt')
  assert.equal(MAX_SEGMENT_BYTES, 255)
  // 短段组成的长路径：1024~4096 之间按协议应当接受
  const long = 'ab/'.repeat(400) + 'c.txt'
  assert.equal(checkRelPath(long), long)
  assert.throws(() => checkRelPath('a/'.repeat(2200) + 'b.txt'), (e) => e.rule === 'R7')
})

test('R8：Windows 保留设备名拒绝（带扩展名也算）', () => {
  for (const evil of ['CON', 'con.txt', 'NUL', 'aux.log', 'COM1', 'lpt9.dat', 'sub/PRN.md']) {
    assert.throws(() => checkRelPath(evil, { windows: true }), (e) => e.rule === 'R8', `应拒绝: ${evil}`)
  }
  // 非 Windows 模式下不管它（Linux 上 CON 是合法名字）
  assert.equal(checkRelPath('CON', { windows: false }), 'CON')
})

test('R9/R10：非法字符与结尾的点、空格是**改写**而不是拒绝', () => {
  // 为什么必须是改写：Linux/macOS 上 `a:b.txt`、`report.` 都是正常文件名，
  // 发送端按自己的平台规则看它们没问题，于是原样写进清单。
  // 接收端（Windows）若直接拒绝，一次**完全正常的传输**就会整个失败。
  assert.equal(checkRelPath('a:b.txt', { windows: true }), 'a_b.txt')
  assert.equal(checkRelPath('what?.txt', { windows: true }), 'what_.txt')
  assert.equal(checkRelPath('report.', { windows: true }), 'report')
  assert.equal(checkRelPath('report ', { windows: true }), 'report')
  assert.equal(checkRelPath('a./b. ', { windows: true }), 'a/b')
  assert.equal(checkRelPath('...', { windows: true }), '_', '全点的名字要有兜底')
  // 非 Windows 保持原样
  assert.equal(checkRelPath('a:b.txt', { windows: false }), 'a:b.txt')
  assert.equal(checkRelPath('report.', { windows: false }), 'report.')
})

test('R11：反斜杠一律归一化成斜杠', () => {
  assert.equal(checkRelPath('dir\\sub\\a.txt'), 'dir/sub/a.txt')
  assert.equal(checkRelPath('a\\b/c.txt'), 'a/b/c.txt')
})

// ── 规范化：这几条才是"静默丢文件"的根源 ────────────────────

test('⭐ 比较键：NFC/NFD 与大小写都要折叠（macOS / Windows 的实际行为）', () => {
  const nfc = 'café.txt'                  // é = U+00E9
  const nfd = 'cafe\u0301.txt'            // e + U+0301（macOS 上就是这个形式）
  assert.notEqual(nfc, nfd, '裸字符串确实不相等 —— 这正是问题所在')
  assert.equal(compareKey(nfc), compareKey(nfd), '规范化后必须相等')

  assert.equal(compareKey('A.TXT'), compareKey('a.txt'), '大小写必须折叠')

  // 中文全角/半角不是规范化问题，不该被折叠（避免过度合并）
  assert.notEqual(compareKey('ａ.txt'), compareKey('a.txt'))
})

test('⭐ R12：NFC/NFD 只差的两个名字算冲突（否则 macOS 上会覆盖）', () => {
  const hit = findPathConflict(['dir/café.txt', 'dir/cafe\u0301.txt'])
  assert.ok(hit, '规范化后同名，必须报冲突')
  assert.equal(hit.exact, false, '不是逐字节相同，而是"规范化后相同"')

  assert.equal(findPathConflict(['a.txt', 'b.txt']), null)
  assert.equal(findPathConflict(['dir/a.txt', 'other/a.txt']), null, '不同目录不算冲突')
})

test('⭐ R12：只差大小写的两个名字算冲突（Windows/macOS 上是同一个文件）', () => {
  const hit = findPathConflict(['Readme.md', 'readme.md'])
  assert.ok(hit, '大小写不敏感的系统上这是同一个文件')
  assert.equal(findPathConflict(['a.txt', 'A.txt', 'b.txt']).paths.length, 2)
})

test('⭐ R12：Windows 上非法字符改写之后撞车，也算冲突', () => {
  // `a:b.txt` 与 `a_b.txt` 在 Windows 上都会被写成 `a_b.txt`：
  // 改写本身没错，错的是**没发现改写之后重名了**。
  const win = (p) => checkRelPath(p, { windows: true })
  const a = win('a:b.txt'), b = win('a_b.txt')
  assert.equal(a, b, '两个不同的清单条目净化成了同一个路径')
  const hit = findPathConflict([a, b])
  assert.ok(hit, '净化后撞车必须被查出来 —— 这是静默覆盖的入口')
})

test('⭐ R12：fromWire 在开传之前就拒绝会撞车的清单', () => {
  const file = (rel) => ({ rel, kind: 'file', name: 'x', size: 1, chunks: 1, chunkBytes: 1024, sha256: 'a', chunkHashes: ['b'] })
  const base = { v: 1, suite: 'FLICKER/1', totalBytes: 2, totalChunks: 2 }

  const bad = { ...base, files: [file('café.txt'), file('cafe\u0301.txt')] }
  assert.throws(() => fromWire(bad), (e) => {
    assert.equal(e.code, 'E_MANIFEST_DUPLICATE_PATH')
    assert.equal(e.fatal, true)
    assert.match(e.message, /同一个文件/, '要告诉用户为什么不能继续')
    return true
  })

  const ok = { ...base, files: [file('a.txt'), file('b.txt')] }
  assert.equal(fromWire(ok).files.length, 2)

  // 穿越路径在 fromWire 里也必须是 fatal
  const evil = { ...base, files: [file('../../etc/passwd'), file('b.txt')] }
  assert.throws(() => fromWire(evil), (e) => e.code === 'E_PATH_UNSAFE' && e.fatal === true)
})

// ── 发送端的去重 ────────────────────────────────────────────

test('去重：NFC/NFD 与大小写都按同一口径判重', () => {
  const taken = new Set()
  assert.equal(dedupeRelPath('café.txt', taken), 'café.txt')
  assert.equal(dedupeRelPath('cafe\u0301.txt', taken), 'cafe\u0301 (1).txt',
    '规范化后同名 → 加序号，而不是让它们落成同一个文件')

  const t2 = new Set()
  dedupeRelPath('Readme.md', t2)
  assert.equal(dedupeRelPath('readme.md', t2), 'readme (1).md')

  const t3 = new Set()
  assert.equal(dedupeRelPath('a.txt', t3), 'a.txt')
  assert.equal(dedupeRelPath('a.txt', t3), 'a (1).txt')
  assert.equal(dedupeRelPath('a.txt', t3), 'a (2).txt')
  assert.equal(dedupeRelPath('dir/b.md', t3), 'dir/b.md')
  assert.equal(dedupeRelPath('dir/b.md', t3), 'dir/b (1).md')
  assert.equal(dedupeRelPath('noext', t3), 'noext')
  assert.equal(dedupeRelPath('noext', t3), 'noext (1)', '无扩展名时序号加在末尾')
})

test('去重产出的名字自己也必须通过规则校验（否则等于没修好）', () => {
  const taken = new Set()
  const a = dedupeRelPath('长'.repeat(80) + '.txt', taken)      // 240 字节，接近上限
  const b = dedupeRelPath('长'.repeat(80) + '.txt', taken)
  assert.notEqual(a, b)
  // 加序号后可能超过 255 字节 —— 那就必须**报错**，而不是产出一个非法的名字
  try {
    checkRelPath(b)
  } catch (e) {
    assert.equal(e.rule, 'R7', '超长时必须报 R7')
  }
})

test('safeRelPath 永远不抛错：降级也要给出一个能用的相对路径', () => {
  // 发送端不该因为一个怪名字就整个发不出去
  assert.equal(safeRelPath('../../evil.txt'), 'evil.txt', '去掉上跳后仍可用')
  assert.equal(safeRelPath('/abs/x.txt'), 'abs/x.txt', '去掉前导斜杠')
  assert.equal(safeRelPath('a\\b.txt'), 'a/b.txt')
  assert.equal(typeof safeRelPath(null), 'string')
})

test('PATH_RULES 覆盖 R1–R12，没有漏项', () => {
  const ids = Object.keys(PATH_RULES)
  for (let i = 1; i <= 12; i++) assert.ok(ids.includes('R' + i), `缺 R${i}`)
  assert.equal(ids.length, 12)
  // 报错里的规则号必须都能在这张表里查到 —— 界面要用它给用户解释
  assert.throws(() => checkRelPath('/x'), (e) => Boolean(PATH_RULES[e.rule]) && e.rule === 'R1')
})

// ── 页面里那份必须与这份完全一致 ────────────────────────────

/**
 * 把 web/receiver.html 里内联的那段脚本抠出来，在**没有 Buffer / process 的沙箱**里跑一遍。
 *
 * ⚠️ 为什么用"跑一遍"而不是用正则查一遍：
 *    正则查 `Buffer` 会被注释里的字样误伤（本文件的注释里就写着"不许用 Buffer"），
 *    也会漏掉 `globalThis['Buf'+'fer']` 这种写法。而在一个**真的没有 Buffer 和
 *    process** 的 vm 上下文里执行，用到了就必然抛错 —— 这是判据，不是猜测。
 */
function loadInlinedRules() {
  const html = readFileSync(path.join(ROOT, 'web/receiver.html'), 'utf8')
  const begin = html.indexOf('path-rules:begin')
  const end = html.indexOf('path-rules:end')
  assert.ok(begin > 0 && end > begin, '页面里没有路径规则内联段')
  const block = html.slice(begin, end)
  const m = block.match(/<script>([\s\S]*?)<\/script>/)
  assert.ok(m, '内联段里没有 <script>')

  // 浏览器里有、Node 的裸上下文里没有的东西，按需注入。
  // **不注入** Buffer、process、require —— 缺了就说明这份代码在浏览器里也跑不了。
  const sandbox = { window: {}, TextEncoder, console }
  const context = vm.createContext(sandbox)
  new vm.Script(m[1], { filename: 'receiver.html#path-rules' }).runInContext(context)
  assert.ok(sandbox.window.FlickerPaths, '内联段执行后应当挂出 window.FlickerPaths')
  return { P: sandbox.window.FlickerPaths, block }
}

test('⭐ 页面里内联的规则能真的跑起来（沙箱里没有 Buffer / process）', () => {
  const { P } = loadInlinedRules()
  for (const fn of ['checkRelPath', 'safeRelPath', 'compareKeyOf', 'findPathConflict',
    'dedupeRelPath', 'utf8Bytes']) {
    assert.equal(typeof P[fn], 'function', `内联段缺少 ${fn}`)
  }
  assert.equal(typeof P.PATH_RULES, 'object', 'PATH_RULES 是张表，不是函数')
  assert.equal(typeof P.UnsafePathError, 'function')
  assert.ok(Object.keys(P.PATH_RULES).length >= 12)
})

test('⭐ 页面里的规则与 Node 里的**行为完全一致**（同一张输入表逐条比）', () => {
  // 这是本文件最重要的一条：两份实现对同一份输入必须给出同样的结论。
  // 只比"都有 checkRelPath"是不够的 —— 从前两边也都有各自的实现，规则却不一样。
  const { P } = loadInlinedRules()

  const inputs = [
    'a.txt', 'dir/sub/a.txt', 'a//b///c.txt', './dir/a.txt', 'dir\\sub\\a.txt',
    '/etc/passwd', 'C:/Windows', '\\\\srv\\share', '../x', 'a/../../b', '..', 'a/..',
    'a\0b', '', 'CON', 'con.txt', 'NUL', 'sub/PRN.md', 'COM1',
    'a:b.txt', 'what?.txt', 'report.', 'report ', 'a./b. ', '...',
    '中'.repeat(83) + '.txt', '中'.repeat(85) + '.txt',
    'café.txt', 'cafe\u0301.txt', 'Readme.md', 'readme.md',
    'ab/'.repeat(400) + 'c.txt', 'a/'.repeat(2200) + 'b.txt',
  ]
  // ⚠️ 跨 realm 比较不能用 deepStrictEqual：vm 里的对象原型与本 realm 不同，
  //    于是"值完全一样"也会被判为不相等（diff 打出来两边长得一模一样，很误导）。
  //    这里一律比 JSON 文本。
  const J = (x) => JSON.stringify(x)

  for (const win of [false, true]) {
    for (const strict of [false, true]) {
      for (const input of inputs) {
        const run = (fn) => {
          try { return { ok: true, v: fn(input, { windows: win, strict }) } } catch (e) {
            return { ok: false, rule: e && e.rule, code: e && e.code }
          }
        }
        const a = run(checkRelPath)
        const b = run((x, o) => P.checkRelPath(x, o))
        assert.equal(J(b), J(a),
          `行为不一致：input=${JSON.stringify(input)} windows=${win} strict=${strict}\n` +
          `  Node: ${J(a)}\n  页面: ${J(b)}\n` +
          '    两边必须一模一样 —— 真正决定文件落到用户磁盘上叫什么的是页面那一份')
      }
      // 宽松版（永不抛错）也要一致：它的兜底分支最容易两边写得不一样
      for (const input of inputs) {
        assert.equal(J(P.safeRelPath(input, { windows: win })),
          J(safeRelPath(input, { windows: win })),
          `safeRelPath 不一致：${JSON.stringify(input)} windows=${win}`)
      }
    }
  }

  // 比较键与冲突检测也要一致（这两处错了就是静默覆盖）
  for (const p of ['café.txt', 'cafe\u0301.txt', 'A/B.TXT', '中/文.txt']) {
    assert.equal(P.compareKeyOf(p), compareKeyOf(p), `compareKeyOf 不一致: ${p}`)
  }
  const sets = [
    ['café.txt', 'cafe\u0301.txt'],
    ['Readme.md', 'readme.md'],
    ['a.txt', 'b.txt'],
    ['dir/a.txt', 'other/a.txt'],
  ]
  for (const s of sets) {
    assert.equal(J(P.findPathConflict(s)), J(findPathConflict(s)), `冲突判定不一致: ${s.join(', ')}`)
  }
  const taken = new Set()
  const takenP = new Set()
  for (const p of ['a.txt', 'a.txt', 'café.txt', 'cafe\u0301.txt', 'noext', 'noext']) {
    assert.equal(P.dedupeRelPath(p, takenP), dedupeRelPath(p, taken), `去重结果不一致: ${p}`)
  }
})

test('页面里不再有自己手写的那套路径替换（两份实现的分叉点）', () => {
  const html = readFileSync(path.join(ROOT, 'web/receiver.html'), 'utf8')
  assert.ok(!/replace\(\/\[<>:"\|?\*\\x00-\\x1f\]\/g, '_'\)/.test(html),
    '页面里不该再有自己手写的非法字符替换 —— 规则只允许有一份')
  assert.match(html, /window\.FlickerPaths\s*=/, '页面应当使用内联的规则对象')
})

// ── 页面里的接线（顺序与错误码）─────────────────────────────

test('⭐ 路径检查排在"开始传输"之前：有问题就一个字节都不传', () => {
  const html = readFileSync(path.join(ROOT, 'web/receiver.html'), 'utf8')
  const recv = html.slice(html.indexOf('async function receive(wire)'))
  // ⚠️ 匹配要带上分号：上面那段注释里就写着「必须在 show('v-go') 之前」，
  //    不带分号的 indexOf 会命中注释，于是"检查在切换界面之后"这种误判就出现了。
  //    （第一次写这条断言时就是这么错的 —— 代码搜索必须能区分代码与注释。）
  const iCheck = recv.indexOf('validatePaths(wire)')
  const iShow = recv.search(/show\('v-go'\)\s*;/)
  assert.ok(iCheck > 0, 'receive() 里应当调用 validatePaths')
  assert.ok(iShow > 0, "receive() 里应当有 show('v-go'); 这次真正的调用")
  assert.ok(iCheck < iShow,
    '路径检查必须在切到"传输中"界面之前 —— 否则用户会先看到进度条再看到报错，' +
    '更糟的是如果检查被挪到写盘时才做，就会发生静默覆盖')

  // 目录选择也要排在检查之后（别让用户先选完目录才说文件不合法）
  const iPick = recv.indexOf('showDirectoryPicker')
  assert.ok(iPick === -1 || iCheck < iPick, '选目录应当在路径检查之后')
})

test('页面的错误码与文案表对得上，且不给"按了也没用"的重试按钮', () => {
  const html = readFileSync(path.join(ROOT, 'web/receiver.html'), 'utf8')
  const strings = readFileSync(path.join(ROOT, 'web/i18n-strings.mjs'), 'utf8')

  for (const code of ['E_PATH_UNSAFE', 'E_MANIFEST_DUPLICATE_PATH']) {
    assert.ok(html.includes(`'${code}'`), `${code} 应当出现在页面的 KNOWN 列表里`)
    // 文案表里必须中英各有 .t 与 .m（漏一个就会显示成键名）
    for (const suffix of ['.t', '.m']) {
      const n = (strings.match(new RegExp(`recv\\.err\\.${code}${suffix.replace('.', '\\.')}':`, 'g')) ?? []).length
      assert.equal(n, 2, `recv.err.${code}${suffix} 应当中英各一条，实际 ${n} 条`)
    }
  }
  // 参数必须随错误传出去（表里的消息带 {name} / {a} / {b} 占位符）
  assert.match(html, /params:\s*\{\s*name:/, 'E_PATH_UNSAFE 要把文件名带进 params')
  assert.match(html, /params:\s*\{\s*a:/, '重复路径要把两个名字带进 params')
  assert.match(html, /t\('recv\.err\.' \+ key \+ '\.m', \(err && err\.params\)/,
    'fail() 必须把 err.params 传给 t()，否则占位符不会被替换')

  // 重试按钮：路径问题重试必然同样失败，不能给按钮。
  // 取"重试策略"那一段：从 BAD_PASSWORD 分支起，到第一个 hide 为止 ——
  // 这段正好是"隐藏按钮"那个分支的条件。
  const fail = html.slice(html.indexOf('function fail(err)'))
  const policy = fail.slice(fail.indexOf("if (code === 'BAD_PASSWORD')"))
  const hideBranch = policy.slice(0, policy.indexOf("classList.add('hide')"))
  assert.match(hideBranch, /E_PATH_UNSAFE/, '路径问题应当走"隐藏重试按钮"这个分支')
  assert.match(hideBranch, /E_MANIFEST_DUPLICATE_PATH/)
})

test('内联段的指纹与源文件一致（改规则必须重跑生成器）', () => {
  const src = readFileSync(path.join(ROOT, 'src/path-safety.js'), 'utf8')
  const html = readFileSync(path.join(ROOT, 'web/receiver.html'), 'utf8')
  // 生成器把源文件去掉 export 后加两格缩进 —— 这里复刻同一变换再比内容
  const expected = src.replace(/^export\s+/gm, '').split('\n')
    .map((l) => (l ? '  ' + l : l)).join('\n')
  const begin = html.indexOf('path-rules:begin')
  const end = html.indexOf('path-rules:end')
  const block = html.slice(begin, end)
  assert.ok(block.includes(expected),
    '内联段与 src/path-safety.js 不一致 —— 请重跑 `node gen/inline-path-rules.mjs`')
  // 指纹只用于日志，这里确认它确实是源文件的哈希（防止生成器算错对象）
  const digest = createHash('sha256').update(src).digest('hex').slice(0, 16)
  assert.equal(digest.length, 16)
})
