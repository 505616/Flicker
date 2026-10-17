/**
 * 插件系统的测试（发送端平面）
 * ============================
 * 这一组盯住的是**契约**而不是实现细节：
 *
 *   · 加载策略：只认显式来源（`--plugin` / `FLICKER_PLUGINS`），不自动发现；
 *   · 形状与版本：`apiVersion` 对不上、缺 `name`/`apply`、文件不存在 —— 都要
 *     **明确报错**，而不是"尽力而为"（插件是别人写的代码，坏起来最难查）；
 *   · 拼错名字当场报错：`ctx.on('manifset/scanned')` 若只是"永远收不到事件"，
 *     插件作者会去查自己的 bug；
 *   · **可回收**：`ctx.effect()` 登记的清理函数一定会在销毁时被调用，
 *     逆序、且一个失败不影响其余；
 *   · 贡献点真的被用上：`gift/items` 推进来的文件要出现在清单里，且内容可取回。
 *
 * 端到端那一条（真 CLI + 真中继）在 `test/relay-e2e.test.js` 里，
 * 用的是那张"真子进程"测试床。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPluginRegistry, pluginPaths } from '../src/plugin/registry.js'
import { EVENTS, SLOTS, UI_LEVELS, PLUGIN_TABLE, SYNC_EVENTS } from '../src/plugin/events.js'
import { wrapUiForPlugins } from '../src/plugin/ui.js'
import { prepareSession } from '../src/prepare.js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const EXAMPLE = path.join(root, 'examples', 'plugins')

/** 建一个走完就删的临时目录，里面放几个插件文件 */
async function fixture(files) {
  const dir = await mkdtemp(path.join(tmpdir(), 'flicker-plugin-'))
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content, 'utf8')
  }
  return dir
}

/** 现写一个插件并加载它（返回注册表与临时目录） */
async function loadInline(source, { name = 'probe.cjs' } = {}) {
  const dir = await fixture({ [name]: source })
  const plugins = createPluginRegistry({ flickerVersion: '9.9.9', log: () => {} })
  await plugins.load([path.join(dir, name)])
  return { plugins, dir }
}

const cleanup = (dir) => rm(dir, { recursive: true, force: true })

// ── 加载策略 ────────────────────────────────────────────────

test('插件来源只认显式指定：--plugin 可重复、环境变量按系统分隔符拆、去重且保序', () => {
  const sep = path.delimiter
  assert.deepEqual(pluginPaths({ flagValue: undefined, env: {} }), [],
    '什么都不给时必须是空的 —— 绝不自动发现（不扫目录、不读 package.json）')
  assert.deepEqual(
    pluginPaths({ flagValue: 'a.cjs', env: {} }),
    ['a.cjs'], '单个 --plugin 是字符串')
  assert.deepEqual(
    pluginPaths({ flagValue: ['a.cjs', 'b.cjs'], env: {} }),
    ['a.cjs', 'b.cjs'], '多个 --plugin 按给定顺序')
  assert.deepEqual(
    pluginPaths({ flagValue: undefined, env: { FLICKER_PLUGINS: `x.cjs${sep}y.cjs` } }),
    ['x.cjs', 'y.cjs'], '环境变量按系统分隔符拆开')
  assert.deepEqual(
    pluginPaths({ flagValue: ['a.cjs'], env: { FLICKER_PLUGINS: 'a.cjs' } }),
    ['a.cjs'], '同一个路径给两次只算一次')
  assert.deepEqual(
    pluginPaths({ flagValue: '  ', env: { FLICKER_PLUGINS: '  ' } }),
    [], '空白要被忽略，而不是当成一个文件路径')
})

test('示例插件能被加载，并如实报出它订阅了什么、登记了几个副作用', async () => {
  const plugins = createPluginRegistry({ flickerVersion: '9.9.9', log: () => {} })
  await plugins.load([
    path.join(EXAMPLE, 'hello-logger.cjs'),
    path.join(EXAMPLE, 'attach-note.cjs'),
  ])
  assert.equal(plugins.count, 2)
  const [logger, note] = plugins.list
  assert.equal(logger.name, 'hello-logger')
  assert.equal(logger.apiVersion, 1)
  assert.equal(logger.effects, 1, '示例①登记了一个 ctx.effect')
  assert.deepEqual(logger.events,
    [EVENTS.RUN_START, EVENTS.MANIFEST_SCANNED, EVENTS.UI_MESSAGE, EVENTS.TRANSFER_COMPLETE],
    '订阅清单要按注册顺序如实记账（--plugins 与销毁清单都靠它）')
  assert.deepEqual(note.events, [SLOTS.GIFT_ITEMS, EVENTS.RUN_START, EVENTS.MANIFEST_SCANNED])
  assert.match(plugins.describe(), /hello-logger@1\.0\.0/, 'describe() 是给用户看的一行人话')
})

// ── 形状与版本 ──────────────────────────────────────────────

test('apiVersion 对不上 → 拒绝加载，并说清"要几、有几"', async () => {
  const dir = await fixture({
    'v2.cjs': 'module.exports = { name: "future", apiVersion: 2, apply() {} }\n',
  })
  try {
    const plugins = createPluginRegistry({ log: () => {} })
    await assert.rejects(() => plugins.load([path.join(dir, 'v2.cjs')]), (e) => {
      assert.match(e.message, /future/, '要说是哪个插件')
      assert.match(e.message, /要 API 版本 2/, '要说清它要哪一版')
      assert.match(e.message, /本程序提供的是 1/, '要说清本程序提供哪一版')
      return true
    })
    assert.equal(plugins.count, 0, '拒绝加载之后不能留下半个插件')
  } finally { await cleanup(dir) }
})

test('形状不对（不是对象 / 缺 name / 缺 apply）→ 各自给出能照着改的错误', async () => {
  const cases = [
    ['not-object.cjs', 'module.exports = function () {}\n', /格式不对/],
    ['no-name.cjs', 'module.exports = { apiVersion: 1, apply() {} }\n', /缺少 name/],
    ['no-apply.cjs', 'module.exports = { name: "x", apiVersion: 1 }\n', /缺少 apply/],
    ['bad-version.cjs', 'module.exports = { name: "x", apiVersion: "1", apply() {} }\n', /apiVersion 必须是整数/],
  ]
  for (const [file, src, want] of cases) {
    const dir = await fixture({ [file]: src })
    try {
      const plugins = createPluginRegistry({ log: () => {} })
      await assert.rejects(() => plugins.load([path.join(dir, file)]),
        (e) => { assert.match(e.message, want, `${file} 的报错要能看懂`); return true })
    } finally { await cleanup(dir) }
  }
})

test('文件不存在 / 语法错误 → 带上文件路径的明确报错（不是一句 undefined）', async () => {
  const plugins = createPluginRegistry({ log: () => {} })
  await assert.rejects(() => plugins.load([path.join(tmpdir(), '绝对不存在-xyz.cjs')]),
    /插件文件读不到/)

  const dir = await fixture({ 'broken.cjs': 'module.exports = { name: "x", apply( { }\n' })
  try {
    await assert.rejects(() => plugins.load([path.join(dir, 'broken.cjs')]),
      (e) => {
        assert.match(e.message, /插件加载失败/)
        assert.match(e.message, /broken\.cjs/, '要指出是哪个文件')
        return true
      })
  } finally { await cleanup(dir) }
})

test('两个插件同名 → 当场拒绝（否则销毁清单与日志会分不清是谁）', async () => {
  const dir = await fixture({
    'a.cjs': 'module.exports = { name: "same", apiVersion: 1, apply() {} }\n',
    'b.cjs': 'module.exports = { name: "same", apiVersion: 1, apply() {} }\n',
  })
  try {
    const plugins = createPluginRegistry({ log: () => {} })
    await assert.rejects(() => plugins.load([path.join(dir, 'a.cjs'), path.join(dir, 'b.cjs')]),
      /插件名重复/)
  } finally { await cleanup(dir) }
})

// ── 拼错名字当场报错 ────────────────────────────────────────

test('⭐ 拼错事件名/贡献点名 → apply 当场抛错（绝不"永远收不到事件"）', async () => {
  const typo = await fixture({
    'typo.cjs': 'module.exports = { name: "typo", apiVersion: 1, ' +
      'apply(ctx) { ctx.on("manifset/scanned", () => {}) } }\n',
  })
  const badSlot = await fixture({
    'slot.cjs': 'module.exports = { name: "slot", apiVersion: 1, ' +
      'apply(ctx) { ctx.contribute("gift/item", () => ({})) } }\n',
  })
  try {
    const a = createPluginRegistry({ log: () => {} })
    await assert.rejects(() => a.load([path.join(typo, 'typo.cjs')]), (e) => {
      assert.match(e.message, /不存在的事件 "manifset\/scanned"/)
      assert.match(e.message, /manifest\/scanned/, '要把可用的事件名列出来，照着改就行')
      return true
    })
    const b = createPluginRegistry({ log: () => {} })
    await assert.rejects(() => b.load([path.join(badSlot, 'slot.cjs')]),
      /不存在的贡献点 "gift\/item"/)
  } finally { await cleanup(typo); await cleanup(badSlot) }
})

test('apply 抛错 → 报错带上插件名，并且**已经登记的副作用会被释放**', async () => {
  const dir = await fixture({
    'half.cjs': [
      'globalThis.__pluginHalfDisposed = false',
      'module.exports = { name: "half", apiVersion: 1, apply(ctx) {',
      '  ctx.effect(() => () => { globalThis.__pluginHalfDisposed = true })',
      '  throw new Error("初始化到一半失败了")',
      '} }',
    ].join('\n'),
  })
  try {
    const plugins = createPluginRegistry({ log: () => {} })
    await assert.rejects(() => plugins.load([path.join(dir, 'half.cjs')]),
      /插件 half 初始化失败（apply 抛错）：初始化到一半失败了/)
    assert.equal(globalThis.__pluginHalfDisposed, true,
      'apply 失败也要把已经登记的资源收掉 —— 否则"加载失败"会留下垃圾')
    assert.equal(plugins.count, 0)
  } finally { await cleanup(dir); delete globalThis.__pluginHalfDisposed }
})

// ── 可回收 ──────────────────────────────────────────────────

test('⭐ ctx.effect 的清理函数一定被调用，且**逆序**（后建的先拆）', async () => {
  const dir = await fixture({
    'effects.cjs': [
      'globalThis.__pluginOrder = []',
      'module.exports = { name: "fx", apiVersion: 1, apply(ctx) {',
      '  ctx.effect(() => { globalThis.__pluginOrder.push("a+lots"); return () => globalThis.__pluginOrder.push("a-") })',
      '  ctx.effect(() => { globalThis.__pluginOrder.push("b+lots"); return () => globalThis.__pluginOrder.push("b-") })',
      '} }',
    ].join('\n'),
  })
  try {
    const plugins = createPluginRegistry({ log: () => {} })
    await plugins.load([path.join(dir, 'effects.cjs')])
    const step = await plugins.asDestroyStep()
    assert.equal(step, '已释放 2 项', '销毁清单里要如实说是几项')
    assert.deepEqual(globalThis.__pluginOrder, ['a+lots', 'b+lots', 'b-', 'a-'],
      '后登记的先释放（与栈的直觉一致）')
    // 幂等：销毁链可能被跑两次（正常路径 + catch 兜底），不能重复释放
    assert.equal(await plugins.asDestroyStep(), false, '第二次调用应当是"不适用"')
  } finally { await cleanup(dir); delete globalThis.__pluginOrder }
})

test('清理函数自己失败时：如实记账，但不影响其它插件的清理', async () => {
  const dir = await fixture({
    'bad.cjs': 'module.exports = { name: "bad", apiVersion: 1, ' +
      'apply(ctx) { ctx.effect(() => () => { throw new Error("我关不掉") }) } }\n',
    'good.cjs': 'module.exports = { name: "good", apiVersion: 1, ' +
      'apply(ctx) { ctx.effect(() => () => { globalThis.__goodDisposed = true }) } }\n',
  })
  try {
    const plugins = createPluginRegistry({ log: () => {} })
    await plugins.load([path.join(dir, 'bad.cjs'), path.join(dir, 'good.cjs')])
    await assert.rejects(() => plugins.asDestroyStep(), (e) => {
      assert.match(e.message, /bad: 我关不掉/, '要点名是哪个插件的哪一步失败')
      return true
    })
    assert.equal(globalThis.__goodDisposed, true, '一个插件清理失败不能连累另一个')
  } finally { await cleanup(dir); delete globalThis.__goodDisposed }
})

test('界面转发：只包文本类输出，且同步事件返回 Promise 会被记成错误（不产生未处理拒绝）', async () => {
  // 用**真的插件文件**走一遍（而不是直接 subscribe）：这样连"没有插件时零开销"
  // 那道闸门也一起验了 —— `wrapUiForPlugins` 在没有插件时原样返回，
  // 所以直接 subscribe 是测不到转发逻辑的。
  const dir = await fixture({
    'ui-probe.cjs': [
      'globalThis.__pluginUi = []',
      'module.exports = { name: "ui-probe", apiVersion: 1, apply(ctx) {',
      '  ctx.on("ui/message", (e) => { globalThis.__pluginUi.push(e.level + "|" + e.text) })',
      '} }',
    ].join('\n'),
  })
  try {
    const plugins = createPluginRegistry({ log: () => {} })
    await plugins.load([path.join(dir, 'ui-probe.cjs')])
    const lines = []
    const ui = {
      banner() { lines.push('banner') },
      info(m) { lines.push('info:' + m) },
      progress() { lines.push('progress') },          // 高频，不该被转发
      chunkProgress() { lines.push('chunk') },
      plan() { lines.push('plan') },                  // 结构化，不该被转发
    }
    assert.equal(wrapUiForPlugins(ui, null), ui, '没有插件时必须原样返回（零开销）')

    const wrapped = wrapUiForPlugins(ui, plugins)
    wrapped.banner()
    wrapped.info('你好')
    wrapped.progress(1, 2)
    wrapped.chunkProgress({})
    wrapped.plan({}, {})
    assert.deepEqual(lines, ['banner', 'info:你好', 'progress', 'chunk', 'plan'],
      '原来的界面输出必须一个字都不变')
    assert.deepEqual(globalThis.__pluginUi, ['banner|', 'info|你好'],
      '只有文本类被转发；进度与结构化调用不转发（否则日志会被淹没）')
    assert.ok(UI_LEVELS.every((l) => typeof l === 'string'), '层级就是界面方法名')

    // 同步事件返回 Promise：记一笔，不能让它在进程里变成未处理的拒绝
    plugins.subscribe(EVENTS.UI_MESSAGE, 'async-probe', async () => { throw new Error('我不该是 async') })
    wrapped.info('再一次')
    await new Promise((r) => setImmediate(r))
    assert.ok(plugins.errors.some((m) => /同步事件/.test(m)),
      '同步事件返回 Promise 要被记账：' + JSON.stringify(plugins.errors))
  } finally { await cleanup(dir); delete globalThis.__pluginUi }
})

// ── 贡献点真的被用上 ────────────────────────────────────────

/** 造一个够用的假界面（prepareSession 会调这些） */
function stubUi() {
  const lines = []
  return {
    lines,
    banner() {}, step(m) { lines.push('step:' + m) }, info(m) { lines.push('info:' + m) },
    warn(m) { lines.push('warn:' + m) }, ok(m) { lines.push('ok:' + m) },
    plan() {}, progress() {}, progressDone() {}, gift(g) { lines.push('gift:' + g.name) },
    async askPassword() { return 'stub-password' },
  }
}

test('⭐ gift/items 贡献点：插件追加的文件进清单、内容可原样取回（且不撑大清单）', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'flicker-prep-'))
  await mkdir(path.join(work, 'in'), { recursive: true })
  await writeFile(path.join(work, 'in', 'a.txt'), 'hello', 'utf8')

  const dir = await fixture({
    'note.cjs': [
      'module.exports = { name: "note", apiVersion: 1, apply(ctx) {',
      '  ctx.contribute("gift/items", () => ({ name: "说明.txt", data: "插件写的说明" }))',
      '} }',
    ].join('\n'),
  })
  try {
    const plugins = createPluginRegistry({ log: () => {} })
    await plugins.load([path.join(dir, 'note.cjs')])
    const ui = stubUi()
    const prep = await prepareSession({
      inputs: [path.join(work, 'in')], password: 'pw', gift: false, ui, plugins,
    })

    const added = prep.wire.files.find((f) => f.rel === '说明.txt')
    assert.ok(added, '插件追加的文件必须出现在清单里：' + JSON.stringify(prep.wire.files.map((f) => f.rel)))
    assert.equal(added.kind, 'file', '对接收端来说它就是个普通文件')
    assert.equal(added.size, Buffer.byteLength('插件写的说明', 'utf8'))

    // 内容要能真的取回来（发送端是按清单下标从内存里取字节的）
    const at = prep.serverManifest.files.findIndex((f) => f.rel === '说明.txt')
    const bytes = prep.serverManifest.files[at]._bytes
    assert.ok(Buffer.isBuffer(bytes), '发送端要能从内存取到这些字节（否则传输时会读不到文件）')
    assert.equal(bytes.toString('utf8'), '插件写的说明')

    // 判据：清单里不能出现插件文件的**内容**（只应有元数据）
    const sealed = JSON.stringify(prep.serverManifest.files[at])
    assert.ok(!sealed.includes('插件写的说明'), '内容不许进清单 —— 那是"清单被撑大"的老坑')

    // 而且必须有明确的界面提示：用户得知道多了一个文件
    assert.ok(ui.lines.some((l) => /插件 note 追加了一个文件：说明\.txt/.test(l)),
      '多出来的文件要打在屏幕上：' + JSON.stringify(ui.lines))
  } finally { await cleanup(dir); await rm(work, { recursive: true, force: true }) }
})

test('插件追加的文件与已发送文件重名 → 当场报错（不能留给接收端去撞路径冲突）', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'flicker-prep2-'))
  await mkdir(path.join(work, 'in'), { recursive: true })
  await writeFile(path.join(work, 'in', 'dup.txt'), 'x', 'utf8')

  const dir = await fixture({
    'dup.cjs': [
      'module.exports = { name: "dup", apiVersion: 1, apply(ctx) {',
      '  ctx.contribute("gift/items", () => ({ name: "dup.txt", data: "抢名字" }))',
      '} }',
    ].join('\n'),
  })
  try {
    const plugins = createPluginRegistry({ log: () => {} })
    await plugins.load([path.join(dir, 'dup.cjs')])
    // ⚠️ 输入用**文件本身**（不是它的目录）：目录输入时清单里的 rel 是 `in/dup.txt`，
    //    与插件的 `dup.txt` 并不重名 —— 那样测的就不是重名判据了（第一版就是这么写错的）。
    await assert.rejects(() => prepareSession({
      inputs: [path.join(work, 'in', 'dup.txt')], password: 'pw', gift: false, ui: stubUi(), plugins,
    }), /重名：dup\.txt/)
  } finally { await cleanup(dir); await rm(work, { recursive: true, force: true }) }
})

test('插件文件的名字要过与接收端同一套路径规则（带分隔符、保留名、非法字符都拒绝）', async () => {
  const cases = [
    ['../escape.txt', /不能带路径分隔符/],
    ['sub/dir.txt', /不能带路径分隔符/],
    ['CON', /CON|保留/],
    ['', /缺少 name/],
  ]
  for (const [name, want] of cases) {
    const dir = await fixture({
      'p.cjs': 'module.exports = { name: "p", apiVersion: 1, apply(ctx) { ' +
        `ctx.contribute("gift/items", () => ({ name: ${JSON.stringify(name)}, data: "x" })) } }\n`,
    })
    const work = await mkdtemp(path.join(tmpdir(), 'flicker-prep3-'))
    await mkdir(path.join(work, 'in'), { recursive: true })
    await writeFile(path.join(work, 'in', 'ok.txt'), 'x', 'utf8')
    try {
      const plugins = createPluginRegistry({ log: () => {} })
      await plugins.load([path.join(dir, 'p.cjs')])
      await assert.rejects(() => prepareSession({
        inputs: [path.join(work, 'in')], password: 'pw', gift: false, ui: stubUi(), plugins,
      }), (e) => {
        assert.match(e.message, /插件 p 提供的文件不合法/)
        assert.match(e.message, want)
        return true
      }, `名字 ${JSON.stringify(name)} 应当被拒绝`)
    } finally { await cleanup(dir); await rm(work, { recursive: true, force: true }) }
  }
})

// ── 表本身的自洽性 ──────────────────────────────────────────

test('事件表自洽：常量与表一一对应、贡献点不在事件里、同步事件是界面输出那条', () => {
  const events = PLUGIN_TABLE.filter((r) => r.kind === 'event').map((r) => r.name)
  const slots = PLUGIN_TABLE.filter((r) => r.kind === 'slot').map((r) => r.name)
  assert.deepEqual(Object.values(EVENTS).sort(), [...events].sort(),
    'EVENTS 常量必须与表完全一致（触发点用的是常量，表是文档检查的依据）')
  assert.deepEqual(Object.values(SLOTS).sort(), [...slots].sort())
  for (const n of events) assert.ok(!slots.includes(n), `事件与贡献点不能同名：${n}`)
  assert.deepEqual([...SYNC_EVENTS], [EVENTS.UI_MESSAGE],
    '目前只有界面输出是同步事件')
  assert.ok(PLUGIN_TABLE.every((r) => Object.isFrozen(r)), '表要冻结，防止运行时被改')
  assert.ok(events.every((n) => /^[a-z]+(\/[a-z-]+)+$/.test(n)),
    '事件名统一用**两段式** `域/动作`（动作里可以有连字符）：' + events.join(', '))
})
