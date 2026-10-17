/**
 * 插件系统：**接收端页面平面**的测试
 * ==============================
 * 页面平面与另外两个平面的最大差别：**插件是构建期打进页面的**，不是运行时加载的。
 * 原因是硬约束 —— 接收端页面必须自包含（中继直接把 HTML 发出去，CSP 不允许外部脚本）。
 *
 * 所以这一组测两件事：
 *   ① **内联器**（`gen/inline-plugins.mjs`）：显式清单、空清单零代价、构建期校验
 *      （不许 import/require、必须有 export default、apiVersion 必须匹配）、
 *      以及"改了插件却忘了重跑"必须被判据拦下；
 *   ② **页面运行时**（`web/page-plugin-runtime.mjs`）：钩子按顺序触发、
 *      插件出错**不中断传输**（与另外两个平面相反，因为这里是对方在收文件）、
 *      拼错名字当场报错、`page/actions` 能渲染成按钮。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildPageBlock, readManifest, existingBlock, toBrowserSource, BEGIN, END,
} from '../gen/inline-plugins.mjs'
import { createPagePlugins, PAGE_HOOKS, PAGE_SLOTS, PAGE_API_VERSION } from '../web/page-plugin-runtime.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const cleanups = []
test.after(async () => {
  for (const fn of cleanups.reverse()) {
    try { await fn() } catch (e) { console.error('清理失败：' + (e?.message ?? e)) }
  }
})

/** 造一个"迷你仓库"：拷一份真运行时进去，再放若干插件文件 */
async function miniRepo(plugins = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'flicker-page-plugin-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  await mkdir(path.join(dir, 'web'), { recursive: true })
  await copyFile(path.join(ROOT, 'web', 'page-plugin-runtime.mjs'),
    path.join(dir, 'web', 'page-plugin-runtime.mjs'))
  await mkdir(path.join(dir, 'plugins'), { recursive: true })
  for (const [name, src] of Object.entries(plugins)) {
    await writeFile(path.join(dir, 'plugins', name), src, 'utf8')
  }
  return dir
}

const OK_PLUGIN = `
export default {
  name: 'ok', apiVersion: 1,
  apply(ctx) { ctx.log('hi') },
}
`

// ── ① 内联器 ────────────────────────────────────────────────

test('清单为空时内联段只有 marker —— 不为用不到的功能付页面体积', () => {
  const { block, plugins } = buildPageBlock(ROOT, { plugins: [] })
  assert.deepEqual(plugins, [])
  assert.ok(!block.includes('<script>'), '空清单不该内联运行时或任何脚本')
  assert.ok(block.startsWith(BEGIN) && block.endsWith(END))
  assert.ok(block.length < 300, `空清单一共才 ${block.length} 字节`)
})

test('⭐ 内联：运行时 + 插件一起进页面，并记下插件指纹（改了就能看出来）', async () => {
  const dir = await miniRepo({ 'ok.mjs': OK_PLUGIN })
  const { block, plugins } = buildPageBlock(dir, { plugins: ['plugins/ok.mjs'] })
  assert.equal(plugins.length, 1)
  assert.equal(plugins[0].name, 'ok')
  assert.match(plugins[0].digest, /^[0-9a-f]{16}$/)
  assert.ok(block.includes('window.FlickerPage = createPagePlugins()'), '要内联运行时')
  assert.ok(block.includes('window.FlickerPage.register(__plugin)'), '要注册插件')
  assert.ok(block.includes(`sha256:${plugins[0].digest}`), '注释里要写上插件指纹')
  assert.ok(block.includes('createPagePlugins'), '运行时的实现要真的进来')
})

test('构建期就把插件的形状与版本查掉（不许 import/require、必须有 export default、apiVersion 要匹配）', async () => {
  const cases = [
    ['import.mjs', 'import x from "./y.mjs"\nexport default { name: "a", apiVersion: 1, apply() {} }\n', /import\/require/],
    ['require.mjs', 'const fs = require("node:fs")\nexport default { name: "a", apiVersion: 1, apply() {} }\n', /import\/require/],
    ['nodeapi.mjs', 'export default { name: "a", apiVersion: 1, apply() { return process.env.X } }\n', /Buffer \/ process/],
    ['nodefault.mjs', '// 忘了 export default\nconst x = 1\n', /export default/],
    ['notobj.mjs', 'export default 42\n', /必须是对象/],
    ['noname.mjs', 'export default { apiVersion: 1, apply() {} }\n', /缺少 name/],
    ['noapply.mjs', 'export default { name: "a", apiVersion: 1 }\n', /缺少 apply/],
    ['badver.mjs', 'export default { name: "a", apiVersion: 2, apply() {} }\n', /apiVersion/],
  ]
  for (const [file, src, want] of cases) {
    const dir = await miniRepo({ [file]: src })
    assert.throws(() => buildPageBlock(dir, { plugins: [`plugins/${file}`] }), want,
      `${file} 应当在构建期被拒绝`)
  }
})

test('插件在加载时就抛错 → 构建失败并点名文件（而不是打进页面里等着运行时炸）', async () => {
  const dir = await miniRepo({ 'boom.mjs': 'throw new Error("我加载就炸")\nexport default { name: "b", apiVersion: 1, apply() {} }\n' })
  assert.throws(() => buildPageBlock(dir, { plugins: ['plugins/boom.mjs'] }), /我加载就炸/)
})

test('清单不存在/不是数组/不是合法 JSON → 给出能照着改的报错', async () => {
  const dir = await miniRepo()
  assert.deepEqual(readManifest(dir).plugins, [], '没有清单文件时按空清单处理')
  await writeFile(path.join(dir, 'web', 'page-plugins.json'), '{ "plugins": 3 }\n')
  assert.throws(() => readManifest(dir), /plugins.*数组/)
  await writeFile(path.join(dir, 'web', 'page-plugins.json'), '{\n // 注释\n "plugins": []\n}\n')
  assert.throws(() => readManifest(dir), /严格 JSON/)
})

test('⭐ 真实页面必须与清单同步（改了插件却忘了重跑 → 判据失败）', () => {
  const r = spawnSync(process.execPath, ['gen/inline-plugins.mjs', '--check'],
    { cwd: ROOT, encoding: 'utf8' })
  assert.equal(r.status, 0, `页面插件内联段应当是最新的：\n${r.stdout}${r.stderr}`)
})

test('页面里的三个钩子点都用了可选链（没有插件时是空操作）', async () => {
  const html = await readFile(path.join(ROOT, 'web', 'receiver.html'), 'utf8')
  for (const hook of ['recv/verified', 'recv/file-done', 'recv/complete']) {
    assert.ok(html.includes(`window.FlickerPage?.emit('${hook}'`),
      `页面里应当在对应位置触发 ${hook}（且用可选链）`)
  }
  assert.ok(existingBlock(html), '页面里应当有插件内联段的 marker')
})

// ── ② 页面运行时 ────────────────────────────────────────────

/** 一个够用的假 DOM（只实现运行时用到的几个方法） */
function fakeDom() {
  const nodes = {}
  const make = (id) => {
    const el = {
      id, className: '', textContent: '', title: '', children: [], listeners: {},
      setAttribute(k, v) { this[k] = v },
      append(child) {
        this.children.push(child)
        // 追加进去的元素要能被 getElementById 找到 —— 真 DOM 就是这样，
        // 少了这一步，运行时的"容器已存在就不再建"那条分支永远测不到（会建两个）。
        if (child?.id) nodes[child.id] = child
      },
      addEventListener(ev, fn) { (this.listeners[ev] ??= []).push(fn) },
      click() { for (const fn of this.listeners.click ?? []) fn() },
    }
    if (id) nodes[id] = el
    return el
  }
  return {
    nodes,
    document: {
      readyState: 'complete',   // 直接就绪：运行时会把 page/ready 推到下一个 tick（见它的注释）
      getElementById: (id) => nodes[id] ?? null,
      createElement: (tag) => make(null, tag),
      addEventListener() {},
      body: make('body'),
    },
  }
}

/** 建一个运行时并注册一个插件；返回 { api, logs } */
function runtimeWith(src, env = {}) {
  const logs = []
  const dom = env.dom ?? fakeDom()
  const api = createPagePlugins({
    window: {}, document: dom.document,
    console: { log: (m) => logs.push(String(m)), warn: (m) => logs.push('WARN ' + m) },
  })
  // 把插件源码当"已经内联好的脚本"来跑：用内联器**同一套**转换（免得测试与实现漂移）
  const code = toBrowserSource(src, { file: 'test-plugin' })
  // eslint-disable-next-line no-new-func
  const decl = new Function(`${code}\nreturn __plugin`)()
  const ok = api.register(decl)
  return { api, logs, dom, ok }
}

/** 等一个 tick（`page/ready` 是下一个 tick 触发的） */
const nextTick = () => new Promise((r) => setTimeout(r, 0))

test('运行时：钩子按注册顺序触发，page/ready 在下一个 tick 自动触发', async () => {
  const { api, logs, ok } = runtimeWith(`
    export default { name: 'probe', apiVersion: 1, apply(ctx) {
      ctx.on('page/ready', () => ctx.log('ready'))
      ctx.on('recv/verified', (e) => ctx.log('verified:' + e.fileCount))
      ctx.on('recv/file-done', (e) => ctx.log('file:' + e.name))
      ctx.on('recv/complete', (e) => ctx.log('complete:' + e.seconds))
    } }`)
  assert.equal(ok, true)
  // `ctx.log` 会带上插件名前缀（`[页面插件 probe] …`）—— 断言前先剥掉它
  const mine = () => logs.filter((l) => !l.startsWith('WARN'))
    .map((l) => l.replace(/^\[页面插件 [^\]]+\] /, ''))
  assert.deepEqual(mine(), [],
    'page/ready 不能**立刻**触发 —— 那时同一段脚本里的插件还没注册完')
  await nextTick()
  assert.deepEqual(mine(), ['ready'],
    'page/ready 应当在下一个 tick 触发（插件已经注册好了）')
  assert.equal(api.emit('recv/verified', { fileCount: 2 }), 1)
  api.emit('recv/file-done', { name: 'a.txt' })
  api.emit('recv/complete', { seconds: 1.5 })
  assert.deepEqual(mine(), ['ready', 'verified:2', 'file:a.txt', 'complete:1.5'])
  assert.deepEqual(PAGE_HOOKS, ['page/ready', 'recv/verified', 'recv/file-done', 'recv/complete'])
  assert.deepEqual(PAGE_SLOTS, ['page/actions'])
  assert.equal(PAGE_API_VERSION, 1)
})

test('⭐ 页面插件出错**不中断传输**：吞掉、如实记下来、继续跑下一个', () => {
  const { api, logs } = runtimeWith(`
    export default { name: 'boom', apiVersion: 1, apply(ctx) {
      ctx.on('recv/verified', () => { throw new Error('我的钩子炸了') })
      ctx.on('recv/verified', () => ctx.log('第二个处理函数照常跑'))
    } }`)
  const n = api.emit('recv/verified', { fileCount: 1 })
  assert.equal(n, 1, '出错的那个不算成功，后面的照常执行')
  assert.ok(logs.some((l) => l.includes('第二个处理函数照常跑')))
  assert.ok(api.errors.some((m) => /boom/.test(m) && /我的钩子炸了/.test(m)),
    '要如实记下是哪个插件、什么错：' + JSON.stringify(api.errors))
})

test('拼错钩子名/贡献点名、apiVersion 不匹配 → 当场报错（记下来，不让页面白屏）', () => {
  const bad1 = runtimeWith(`export default { name: 't1', apiVersion: 1,
    apply(ctx) { ctx.on('recv/verifed', () => {}) } }`)
  assert.equal(bad1.ok, false)
  assert.ok(bad1.api.errors.some((m) => /不存在的事件 "recv\/verifed"/.test(m)))

  const bad2 = runtimeWith(`export default { name: 't2', apiVersion: 1,
    apply(ctx) { ctx.contribute('page/action', () => ({})) } }`)
  assert.equal(bad2.ok, false)
  assert.ok(bad2.api.errors.some((m) => /不存在的贡献点 "page\/action"/.test(m)))

  const bad3 = runtimeWith(`export default { name: 't3', apiVersion: 9, apply() {} }`)
  assert.equal(bad3.ok, false)
  assert.ok(bad3.api.errors.some((m) => /API 版本 9/.test(m)))
})

test('page/actions 贡献点：渲染成按钮，点一下调用 onClick；一个插件出错不影响别的', () => {
  const { api, logs, dom } = runtimeWith(`
    export default { name: 'btn', apiVersion: 1, apply(ctx) {
      ctx.contribute('page/actions', () => ({ label: '复制清单', onClick: () => ctx.log('点了') }))
      ctx.contribute('page/actions', () => ({ label: '坏的', onClick: () => { throw new Error('按钮炸了') } }))
      ctx.contribute('page/actions', () => { throw new Error('提供时就炸了') })
    } }`)
  const n = api.mountActions()
  assert.equal(n, 2, '两个有效按钮（第三个在提供值时就炸了，被记下来跳过）')
  const box = dom.document.getElementById('page-plugin-actions')
  assert.ok(box, '按钮容器要自己建出来（插件不需要知道页面 DOM 结构）')
  assert.equal(box.children.length, 2)
  box.children[0].click()
  assert.ok(logs.some((l) => l.includes('点了')), '点击要真的调用 onClick')
  box.children[1].click()
  assert.ok(api.errors.some((m) => /按钮炸了/.test(m)), '按钮里抛错也要记下来，不能让页面炸掉')
})

test('ctx.effect 的清理函数在页面卸载时被调用（与另外两个平面同样的写法）', () => {
  const { api, logs } = runtimeWith(`
    export default { name: 'fx', apiVersion: 1, apply(ctx) {
      ctx.effect(() => () => ctx.log('清理了'))
    } }`)
  assert.deepEqual(api.list.map((p) => p.effects), [1], '要记下这个插件登记了几个副作用')
  api.dispose()
  assert.ok(logs.some((l) => l.includes('清理了')))
})
