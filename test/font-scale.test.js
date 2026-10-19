/**
 * 字号调节控件（`web/font-scale.js` + `gen/inline-font-scale.mjs`）
 * ============================================================
 * 2026-10 用户反馈："字有点太小了，可以加一个调整字体大小的功能吗"。
 *
 * 这里验四件事，每件都能**证伪**：
 *   ① **档位与边界**：100/115/130/150 四档；到顶/到底就停（不循环）；百分比显示对得上。
 *   ② **缩放真的覆盖"最小的字"**：三个页面里还有一堆 **px** 字号，
 *      只改 `<html>` 的 font-size 会漏掉它们（第一版就是这么错的）——
 *      所以优先用 CSS `zoom`；判据直接查"源码里有 zoom 分支"与"降级分支仍在"。
 *   ③ **三个页面都内联了同一份**：`--check` 能发现漂移（改了控件忘了重跑生成器）。
 *   ④ **存储按页面分开**：接收端/手机页不许出现 `localStorage`（有另一条判据在查），
 *      所以生成器按页面替换占位符；这里验替换结果。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  PAGES, ROOT, buildBlock, existingBlock, inject, sourceDigest,
} from '../gen/inline-font-scale.mjs'

const SRC = readFileSync(path.join(ROOT, 'web', 'font-scale.js'), 'utf8')
const readPage = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')

/** 在 Node 里造一个最小 DOM，把控件跑起来（只为了验纯逻辑） */
function loadModule({ store = null } = {}) {
  const style = {}
  const root = { style, __fkBase: null }
  const doc = {
    readyState: 'complete',
    documentElement: root,
    body: null,
    getElementById: () => null,
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, innerHTML: '' }),
    head: { appendChild() {} },
    addEventListener() {},
  }
  const globalStub = {
    document: doc,
    getComputedStyle: () => ({ fontSize: '16px' }),
    __FONT_SCALE_STORE__: store,
    t: (k, vars) => (vars ? `${k}(${Object.values(vars).join(',')})` : k),
  }
  // 把模块包一层，注入假的 global / document
  const fn = new Function('globalThis', 'document', `${SRC}\nreturn globalThis.FlickerFontScale`)
  return { api: fn(globalStub, doc), root }
}

const memStore = (init = {}) => {
  const m = new Map(Object.entries(init))
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), _m: m }
}

test('① 四档档位：到顶/到底就停，百分比与倍数对得上', () => {
  const { api } = loadModule()
  assert.deepEqual(api.STEPS, [1, 1.15, 1.3, 1.5])
  assert.deepEqual(api.STEPS.map((_, i) => api.pctOf(i)), [100, 115, 130, 150])
  // 边界：clamp
  assert.equal(api.clampIndex(-5), 0)
  assert.equal(api.clampIndex(99), api.STEPS.length - 1)
  assert.equal(api.clampIndex('abc'), 0)
  // 到顶再放大 = 还在顶上；到底再缩小 = 还在底下（不循环）
  assert.equal(api.nextIndex(api.STEPS.length - 1, +1), api.STEPS.length - 1)
  assert.equal(api.nextIndex(0, -1), 0)
  assert.equal(api.nextIndex(0, +1), 1)
})

test('① 百分比文案：150% 那档显示 150%，不是 1.5%', () => {
  const { api } = loadModule()
  assert.equal(api.pctOf(3), 150)
})

test('② 优先用 CSS zoom（否则最小的那些 px 提示行不会变大）', () => {
  const { api, root } = loadModule()
  assert.ok(/CSS\.supports\('zoom'/.test(SRC), '源码里应当有 zoom 的能力探测')
  api.applyIndex(2, root)    // 130%
  // 在假 DOM 里拿不到 zoom 支持（没有 CSS 对象）→ 走降级分支：改根字号
  assert.ok(root.style.fontSize === '20.8px' || root.style.zoom === '1.3',
    `应当要么设 zoom、要么改根字号（实际 ${JSON.stringify(root.style)}）`)
  assert.ok(/el\.style\.zoom = String\(scale\)/.test(SRC), '支持 zoom 时必须优先用 zoom')
  assert.ok(/el\.style\.fontSize = \(base \* scale\)/.test(SRC), '不支持 zoom 时必须有降级分支')
})

test('③ 三个页面都内联了**同一份**（--check 能抓漂移）', () => {
  for (const { file, store } of PAGES) {
    const html = readPage(file)
    const block = buildBlock(SRC, store)
    assert.equal(existingBlock(html), block, `${file} 的字号控件内联段与 web/font-scale.js 不一致`)
    assert.ok(block.includes('A−') && block.includes('A+'), '控件要有"缩小/放大"两个按钮')
    assert.ok(block.includes('fontScale.smaller') && block.includes('fontScale.larger'),
      '按钮要带可翻译的标题（切语言时会跟着换）')
  }
})

test('③ 反向验证：页面里的块被改坏 → 对不上（生成器就会报）', () => {
  const { file, store } = PAGES[0]
  const html = readPage(file)
  const broken = html.replace('A−', 'A-')
  assert.notEqual(broken, html, '测试自己得先改得动')
  assert.notEqual(existingBlock(broken), buildBlock(SRC, store), '改坏之后必须对不上')
})

test('④ 存储按页面分：手机页/接收页只能用 sessionStorage', () => {
  for (const { file, store } of PAGES) {
    const block = buildBlock(SRC, store)
    assert.ok(block.includes(store), `${file} 的内联段里应当出现 ${store}`)
    if (file === 'web/station.html') continue
    // 代码里（去掉注释后）不许出现 localStorage —— 与 test/receiver-page.test.js 同一条承诺
    const code = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    assert.ok(!/localStorage/.test(code), `${file} 的代码里不许出现 localStorage`)
  }
})

test('④ 存储坏了（隐私模式）不该让控件失效', () => {
  const broken = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } }
  const { api } = loadModule({ store: broken })
  assert.equal(api.readIndex(), 0, '读不出来就退回默认档')
  assert.doesNotThrow(() => api.applyIndex(1))
})

test('控件与内联块的指纹稳定（同一份源码两次生成，字节相同）', () => {
  const a = buildBlock(SRC, 'sessionStorage')
  const b = buildBlock(SRC, 'sessionStorage')
  assert.equal(a, b)
  assert.equal(sourceDigest(SRC), sourceDigest(SRC))
  // 换存储必须换内容（否则"按页面替换"就是摆设）
  assert.notEqual(buildBlock(SRC, 'localStorage'), buildBlock(SRC, 'sessionStorage'))
})

test('inject：已有块就替换，没有就插在 </head> 之前', () => {
  const block = buildBlock(SRC, 'sessionStorage')
  const fresh = '<html><head><title>t</title></head><body></body></html>'
  const once = inject(fresh, block)
  assert.equal(existingBlock(once), block)
  const twice = inject(once, block)
  assert.equal(twice, once, '重复注入必须幂等（否则每次生成都会长一块）')
})
