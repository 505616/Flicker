/**
 * 图形界面（站点页）测试
 * ======================
 * 真实启动 GUI，用 HTTP 连上去验证：
 *   界面服务可访问、只监听回环、/api/state 结构正确、
 *   添加路径能真的扫描出清单、密码生成、选项切换、
 *   以及**未选择文件时不许开始传输**。
 *
 * 注意：测试不真的开浏览器窗口 —— FLICKER_NO_BROWSER=1 让 gui.js 跳过。
 */

import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir, networkInterfaces } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CLI = path.join(root, 'bin', 'flicker.js')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const cleanups = []
/**
 * 收尾：杀掉自己起的界面进程、删掉临时目录。
 *
 * ⚠️ 必须 `try` 住**同步**的抛错。原来的写法是 `await fn().catch(...)` ——
 *    它只能接住"返回的 Promise 被 reject"，接不住 fn **自己**同步抛错。
 *    踩过一次：某条清理里 `rm` 被同名局部变量遮住，抛 `rm is not a function`，
 *    于是这个循环当场中断 —— **后面所有清理都没跑**，留下的界面进程攥着
 *    stdout 管道不放，node 测试进程永远不退出（表现为整套测试"卡住"，不报错）。
 *    所以：清理失败只记一笔，绝不吃掉测试结果、绝不留下孤儿进程。
 */
test.after(async () => {
  for (const fn of cleanups.reverse()) {
    try { await fn() } catch (e) { console.error('清理失败：' + (e?.message ?? e)) }
  }
})

/**
 * 每个用例结束后**立刻**杀掉它起的界面进程。
 *
 * ⚠️ 从前所有界面进程都留到文件末尾的 `test.after` 才清理 —— 于是这个文件里
 *    同时活着七八个界面实例。而这会跟"启动时清理残留证书"撞车：
 *    `cleanResidual()` 按证书名（`Flicker Session CA`）匹配并删除，
 *    于是**新起的那个界面会把别的界面刚装好的 CA 删掉**，那个会话的
 *    "就绪探测"就会失败、链接永远出不来。
 *    实测：这条用例曾卡满 40 秒预算（单独跑 5 秒就过）——就是被这个撞车拖住的。
 *
 * 这不是测试独有的问题：**真机上同时开两个会话也会互相删证书**。
 * 所以产品侧也写明了这条限制（见 `行为与运行.md` 的证书清理一节），
 * 而测试这边做的是"别自己制造并发"。
 */
const liveGuis = []
afterEach(async () => {
  for (const child of liveGuis.splice(0)) {
    try { child.kill() } catch { /* 已退出 */ }
  }
  if (liveGuis.length === 0) await sleep(150)
})

/** 启动 GUI 并等它报出地址 */
function startGui() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, '--gui'], {
      env: { ...process.env, FLICKER_NO_BROWSER: '1' },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    liveGuis.push(child)
    let out = '', err = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已退出 */ }
      reject(new Error(`GUI 启动超时\n${out}\n${err}`))
    }, 15000)
    const onData = (b, isErr) => {
      const s = b.toString()
      if (isErr) err += s; else out += s
      const m = out.match(/(http:\/\/127\.0\.0\.1:\d+\/)/)
      if (m) { clearTimeout(timer); resolve({ child, base: m[1], getOut: () => out, getErr: () => err }) }
    }
    child.stdout.on('data', (b) => onData(b, false))
    child.stderr.on('data', (b) => onData(b, true))
    child.on('exit', (c) => { clearTimeout(timer); if (c) reject(new Error(`GUI 退出 (${c})\n${out}\n${err}`)) })
  })
}

async function bootGui() {
  const gui = await startGui()
  cleanups.push(async () => { try { gui.child.kill() } catch { /* 已退出 */ } })
  const api = async (p, body) => {
    const r = await fetch(gui.base + 'api/' + p, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await r.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* 非 JSON */ }
    return { status: r.status, json, text }
  }
  return { gui, api }
}

test('图形界面：能启动并可访问', { timeout: 60000 }, async () => {
  const { gui, api } = await bootGui()
  const r = await api('state')
  assert.equal(r.status, 200)
  assert.equal(r.json.phase, 'idle')
  assert.ok(Array.isArray(r.json.files))
  assert.ok(typeof r.json.password === 'string' && r.json.password.length > 8,
    '应自动生成一个密码')
})

test('图形界面：根路径返回站点页，且是自包含的', { timeout: 60000 }, async () => {
  const { gui } = await bootGui()
  const r = await fetch(gui.base)
  assert.equal(r.status, 200)
  const html = await r.text()
  assert.match(html, /闪传/)
  assert.match(html, /我要发文件/)
  assert.match(html, /有人要发给我|开始接收|让对方扫码/, '应有接收或分享区块')
  // 自包含：不能引用任何外部资源
  //
  // ⚠️ 扫之前先去掉 `placeholder="…"`：它只是输入框里的**提示文字**（比如
  //    `https://192.168.x.x:8443/?k=…`，告诉用户该粘什么），浏览器不会去取它。
  //    第一版没去掉，加了那个例子之后这条用例就红了 —— 红得没道理；
  //    而"把判据整个改松"又不是想做的事，所以只排除这一处明确不是资源引用的属性。
  const noPlaceholder = html.replace(/\bplaceholder="[^"]*"/gi, 'placeholder=""')
  for (const re of [/<script[^>]+src=/i, /<link[^>]+href=/i, /https?:\/\/(?!127\.0\.0\.1|localhost)/i]) {
    assert.ok(!re.test(noPlaceholder), `站点页不应引用外部资源: ${re}`)
  }
})

test('⭐ 图形界面：限速选项能设上，且**非法的写法不会被悄悄当成不限速**', { timeout: 60000 }, async () => {
  // 这一项的要害不是"能不能限速"，而是"写错了会怎样"。
  // `--rate` 的用途是别占满上行带宽；把看不懂的写法当成不限速，
  // 用户会以为限住了、实际把带宽吃满 —— 这种误解只有等别人抱怨才会被发现。
  const { api } = await bootGui()

  // 默认不限速
  assert.equal((await api('state')).json.rate, '')

  // 预设写法
  let r = await api('options', { rate: '5M' })
  assert.equal(r.status, 200)
  assert.equal(r.json.rate, '5M')
  assert.equal((await api('state')).json.rate, '5M', '状态里要能读到当前限速')

  // 小写、带 /s、纯数字都要认（与命令行 parseRate 同一套）
  for (const spec of ['512k', '1.5M', '2G', '1048576']) {
    r = await api('options', { rate: spec })
    assert.equal(r.status, 200, `${spec} 应当被接受`)
    assert.equal(r.json.rate, spec)
  }

  // 非法写法：必须 400 + 说清怎么改，而且**状态保持原样**
  const before = (await api('state')).json.rate
  for (const bad of ['快一点', '5X', '-1M', 'abc']) {
    r = await api('options', { rate: bad })
    assert.equal(r.status, 400, `「${bad}」应当被拒绝`)
    assert.match(r.json.error, /看不懂/, '报错要说清是写法问题')
    assert.match(r.json.error, /512K|5M|2G/, '报错要给出正确写法')
    assert.equal((await api('state')).json.rate, before,
      `被拒绝之后状态不能变（实际从 ${before} 变成了 ${(await api('state')).json.rate}）—— ` +
      '悄悄改成不限速是最糟的结果')
  }

  // 空字符串 = 不限速
  r = await api('options', { rate: '' })
  assert.equal(r.status, 200)
  assert.equal(r.json.rate, '')
})

test('⭐ 图形界面：限速真的接到了传输上（不是只存了一个值）', { timeout: 60000 }, async () => {
  // 结构断言：`startTransfer` 必须把 S.rate 变成 RateLimiter 交给 runSend。
  // 只测"接口能存值"是不够的 —— 存了却没用上，用户照样占满带宽。
  const src = await readFile(path.join(root, 'src', 'gui.js'), 'utf8')
  assert.match(src, /import \{ RateLimiter, parseRate \} from '\.\/rate\.js'/,
    'gui.js 应当复用命令行那套限速实现（同一个解析器，两种入口写法一致）')
  assert.match(src, /limiter: S\.rate \? new RateLimiter\(S\.rate\.bytesPerSec\) : null/,
    'startTransfer 要把限速变成 limiter 传给 runSend')
  const { parseRate } = await import('../src/rate.js')
  assert.equal(parseRate('5M'), 5 * 1024 * 1024, '解析口径要与命令行一致')
  assert.ok(Number.isNaN(parseRate('快一点')))
})

test('⭐ 图形界面：目录浏览接口（让用户点着选，而不是手打路径）', { timeout: 60000 }, async () => {
  // 为什么需要它：浏览器**不会**把本地文件的绝对路径交给网页
  // （input[type=file]、拖拽、File System Access 都不给），而发送端是 Node
  // 直接读原文件，要的恰恰是路径。所以列目录只能由本地服务来做。
  const dir = await mkdtemp(path.join(tmpdir(), 'flicker-browse-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  await mkdir(path.join(dir, '子目录'), { recursive: true })
  await writeFile(path.join(dir, 'a.txt'), 'hello')
  await writeFile(path.join(dir, 'b.bin'), Buffer.alloc(10, 1))

  const { api } = await bootGui()

  // ① 不给路径 → 列根（Windows 上是盘符）
  const roots = await api('browse')
  assert.equal(roots.status, 200)
  assert.equal(roots.json.roots, true)
  assert.ok(roots.json.entries.length >= 1, '至少要列出根')
  if (process.platform === 'win32') {
    assert.ok(roots.json.entries.every((e) => /^[A-Z]:\\$/.test(e.path)),
      'Windows 上应当列出盘符')
  }

  // ② 列一个真实目录：文件夹在前、文件在后
  const r = await api('browse?path=' + encodeURIComponent(dir))
  assert.equal(r.status, 200)
  assert.equal(r.json.path, dir)
  const names = r.json.entries.map((e) => e.name)
  assert.deepEqual(names.slice(0, 1), ['子目录'], '文件夹应当排在前面')
  assert.ok(names.includes('a.txt') && names.includes('b.bin'))
  const file = r.json.entries.find((e) => e.name === 'b.bin')
  assert.equal(file.kind, 'file')
  assert.equal(file.size, 10, '文件要带大小，界面上要显示')
  assert.ok(r.json.entries.every((e) => path.isAbsolute(e.path)), '每个条目都要给绝对路径')

  // ③ 路径不存在 / 不是目录 → 400 + 人话（不能让页面看到裸 ENOENT）
  const missing = await api('browse?path=' + encodeURIComponent(path.join(dir, '不存在')))
  assert.equal(missing.status, 400)
  assert.match(missing.json.error, /打不开/)
  const notDir = await api('browse?path=' + encodeURIComponent(path.join(dir, 'a.txt')))
  assert.equal(notDir.status, 400)
  assert.match(notDir.json.error, /不是一个文件夹/)
})

test('⭐ 图形界面：按"添加项"分组，且明细按需拉取', { timeout: 60000 }, async () => {
  // 用户要的是：加一个文件夹 → 列表里显示**文件夹的名字**，点开看里面。
  // 而"一共有几万个文件"是很容易发生的（照片、素材库），所以明细不能
  // 每轮轮询都往页面灌一份 —— 分组信息常发，明细等点开再拉。
  const dir = await mkdtemp(path.join(tmpdir(), 'flicker-group-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  await mkdir(path.join(dir, '照片', '子目录'), { recursive: true })
  await writeFile(path.join(dir, '照片', 'p1.jpg'), Buffer.alloc(100, 1))
  await writeFile(path.join(dir, '照片', '子目录', 'p2.jpg'), Buffer.alloc(250, 2))
  await writeFile(path.join(dir, '单独.txt'), 'hi')

  const { api } = await bootGui()
  await api('add', { paths: [path.join(dir, '照片')] })
  await api('add', { paths: [path.join(dir, '单独.txt')] })

  const st = await api('state')
  assert.equal(st.json.fileCount, 3, '一共 3 个文件')
  assert.equal(st.json.groups.length, 2, '两次添加 = 两组')
  const folder = st.json.groups[0]
  assert.equal(folder.name, '照片', '组名 = 用户加进来的那个东西的名字')
  assert.equal(folder.fileCount, 2)
  assert.equal(folder.bytes, 350)
  const single = st.json.groups[1]
  assert.equal(single.name, '单独.txt')
  assert.equal(single.fileCount, 1)

  // 明细按需拉，且 rel 是"含文件夹名"的路径（界面会把前缀去掉再显示）
  //
  // ⚠️ 定位用**路径**（`?p=`），不是序号：删掉中间一项之后序号会前移，
  //    而页面上"哪一项展开着"是按路径记的 —— 用序号会展开到错的那一项。
  assert.equal(folder.path, path.join(dir, '照片'), '组里要带上当初加进去的路径')
  const g0 = await api('group?p=' + encodeURIComponent(folder.path))
  assert.equal(g0.status, 200)
  assert.equal(g0.json.entries.length, 2)
  assert.ok(g0.json.entries.every((e) => e.rel.startsWith('照片/')),
    '明细里的 rel 应当带组名前缀，界面负责去掉')
  assert.ok(g0.json.entries.some((e) => e.rel.endsWith('子目录/p2.jpg')),
    '子目录里的文件也要在明细里')
  assert.equal(g0.json.more, 0)

  const bad = await api('group?p=' + encodeURIComponent(path.join(dir, '没加过')))
  assert.equal(bad.status, 404)
  const empty = await api('group?p=')
  assert.equal(empty.status, 404, '空路径不该匹配上任何一项')
})

test('⭐ 图形界面：能单独去掉清单里的一项（不用清空重来）', { timeout: 60000 }, async () => {
  // 用户的原话："如果选错了文件或者文件夹只能全部清除，应该加入单独清除的选项"。
  // 这一条守的是三件事：能删、删了之后总数对、**删中间一项不会张冠李戴**。
  const dir = await mkdtemp(path.join(tmpdir(), 'flicker-remove-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const a = path.join(dir, 'A')
  const b = path.join(dir, 'B')
  await mkdir(a); await mkdir(b)
  await writeFile(path.join(a, 'a1.bin'), Buffer.alloc(300, 1))
  await writeFile(path.join(b, 'b1.bin'), Buffer.alloc(500, 2))
  await writeFile(path.join(dir, 'c.txt'), 'hello')

  const { api } = await bootGui()
  await api('add', { paths: [a] })
  await api('add', { paths: [b] })
  await api('add', { paths: [path.join(dir, 'c.txt')] })

  let st = (await api('state')).json
  assert.equal(st.groups.length, 3)
  assert.equal(st.fileCount, 3)
  assert.equal(st.totalBytes, 300 + 500 + 5)

  // ① 删中间那一项
  const removed = await api('remove', { path: b })
  assert.equal(removed.status, 200)
  assert.equal(removed.json.remaining, 2)

  st = (await api('state')).json
  assert.deepEqual(st.groups.map((g) => g.name), ['A', 'c.txt'],
    '删掉中间一项后，剩下的两项都要还在、顺序不乱')
  assert.equal(st.fileCount, 2, '总数要跟着减 —— 只改分组不改文件数是错的')
  assert.equal(st.totalBytes, 305, '字节数要跟着减')
  assert.equal((await api('group?p=' + encodeURIComponent(b))).status, 404,
    '删掉之后它的明细必须取不到了')

  // ② 删到空 —— 要回到"还没选文件"那一屏，而不是停在一个空清单上
  assert.equal((await api('remove', { path: a })).status, 200)
  assert.equal((await api('state')).json.phase, 'plan', '还剩一项，仍在清单屏')
  assert.equal((await api('remove', { path: path.join(dir, 'c.txt') })).status, 200)
  st = (await api('state')).json
  assert.equal(st.phase, 'idle', '清空之后要回到初始那一屏')
  assert.equal(st.fileCount, 0)
  assert.equal(st.groups.length, 0)

  // ③ 乱删不能破坏状态
  const again = await api('remove', { path: a })
  assert.equal(again.status, 404, '已经在清单里的不算错，但**不在**里面的要明确报错')
  assert.equal((await api('remove', {})).status, 400, '没给 path 是请求错误')
  assert.equal((await api('state')).json.phase, 'idle', '报错不能把状态改坏')

  // ④ 删完还能接着加（状态机没卡住）
  await api('add', { paths: [path.join(dir, 'c.txt')] })
  assert.equal((await api('state')).json.fileCount, 1)
})

test('⭐ 图形界面：选文件支持多选，且选择能跨目录累积', { timeout: 60000 }, async () => {
  // 这一条守的是"加 5 个文件要点 5 次"那个毛病。DOM 行为没法在 Node 里点，
  // 所以断言的是**结构上的不变量** —— 每一条都对应一种会退化的写法。
  const html = await readFile(path.join(root, 'web', 'station.html'), 'utf8')

  // ① 选择必须存在**列表数据之外**：否则翻目录时会被重建冲掉
  assert.match(html, /const browseSel = new Map\(\)/,
    '选中项要单独存（browseSel），不能塞在列表数据里 —— 翻目录会重建列表')
  const loadFn = html.slice(html.indexOf('async function loadBrowse'), html.indexOf('async function addPathsFrom'))
  assert.ok(!/browseSel\.clear\(\)/.test(loadFn),
    'loadBrowse 里不能清空选择 —— 那会让"换个目录再选一个"变成不可能')
  const openFn = html.slice(html.indexOf('async function openBrowse'), html.indexOf('function closeBrowse'))
  assert.match(openFn, /browseSel\.clear\(\)/, '每次打开窗口才清空，从头开始选')

  const clickHandler = loadFn.slice(loadFn.indexOf("row.addEventListener('click'"),
    loadFn.indexOf("row.addEventListener('dblclick'"))

  // ② Shift 连选：必须先处理、必须带 return，**绝不能落到"进目录"那一路**
  const shiftAt = clickHandler.indexOf('ev.shiftKey')
  const enterAt = clickHandler.indexOf('loadBrowse(e.path)')
  assert.ok(shiftAt > 0, '要支持 Shift 连选')
  assert.ok(shiftAt < enterAt, 'Shift 分支必须排在"进目录"之前')
  const shiftBlock = clickHandler.slice(shiftAt, enterAt)
  assert.match(shiftBlock, /return/,
    'Shift 分支必须 return —— 否则会继续往下走到"进目录"（用户实测过：连选变成了点进文件夹）')
  assert.match(shiftBlock, /browseLastIdx >= 0 \? browseLastIdx : idx/,
    '没有锚点时要锚在当前项 —— 否则第一次按 Shift（想从头连到尾）什么都不会发生')

  // ③ 点方框 = 选中；点名字按模式分工
  assert.match(clickHandler, /classList\.contains\('mcheck'\)[\s\S]{0,80}toggleSel\(e\)/,
    '点右边方框应当切换选中')
  assert.match(clickHandler, /if \(e\.kind === 'dir'\)[\s\S]{0,200}browseMode === 'dir'/,
    '文件夹那一路必须按模式分工：选文件夹时点名字=选中，选文件时点名字=进去')

  // ④ 「▸」按钮：两种模式下都是"进目录"（这样点名字才能安心地按模式分工）
  assert.match(loadFn, /className = 'mgo'/, '文件夹左边要有进目录的 ▸ 按钮')
  assert.match(loadFn, /go\.addEventListener\('click'[\s\S]{0,120}loadBrowse\(e\.path\)/,
    '▸ 按钮点击要进目录')

  // ⑤ 双击仍然直接发这一个（保留快路径）
  //
  // ⚠️ 这里断言两条，而不是一条宽松的正则：
  //    2026-10 加上"选保存目录"模式之后，双击的第一支是"进这一层"
  //    （和系统对话框一致，且**绝不能**把目录加进发送清单），
  //    `addPathsFrom` 因此退到第二支。原来的 `/dblclick[\s\S]{0,120}addPathsFrom/`
  //    直接被那段新代码挤爆了 —— 红得对，但那说明断言写的是**写法**而不是**行为**。
  assert.match(loadFn, /dblclick[\s\S]{0,200}if \(browseSave\) \{ await loadBrowse\(e\.path\); return; \}/,
    '选保存目录时，双击应当是"进这一层"，绝不能把目录加进发送清单')
  assert.match(loadFn, /dblclick[\s\S]{0,400}addPathsFrom\(\[e\.path\]\)/,
    '双击仍然要能直接发这一个 —— 只加一个文件时不该被迫"选中再确认"')

  // ⑥ 确认按钮要显示选了几个
  assert.match(html, /t\('send\.browse\.pickFiles', \{ n \}\)/, '按钮文案要带选中的数量')
})

test('⭐ 图形界面：目录浏览的四个真踩过的坑（返回上一级 / 模式差异 / 只列文件夹）', { timeout: 60000 }, async () => {
  const html = await readFile(path.join(root, 'web', 'station.html'), 'utf8')

  // ①「上一级」必须用服务端给的 parent，不能在本地拼字符串。
  //    本地拼错过一次：`D:\闪传` → `D:`，而 Windows 上 `path.resolve('D:')`
  //    是"D 盘的当前目录"= 进程 CWD = `D:\闪传` —— 上一级原地打转，出不去。
  assert.ok(!/function browseParent/.test(html),
    '不该再有本地拼上级目录的函数 —— 服务端的列表响应里就有权威的 parent')
  assert.match(html, /browseLastData\?\.parent/,
    '「上一级」要用服务端给的 parent')
  const guiSrc = await readFile(path.join(root, 'src', 'gui.js'), 'utf8')
  assert.match(guiSrc, /if \(!path\.isAbsolute\(p\)\) throw new Error\('需要绝对路径'\)/,
    '服务端要拒绝相对路径 —— `path.resolve(\'D:\')` 会悄悄变成进程 CWD，' +
    '那个行为正是"上一级打转"的根源')

  // ② 两种模式必须真的不一样：选文件夹模式只列文件夹
  assert.match(html, /browseMode === 'dir' \? '&only=dir' : ''/,
    '选文件夹模式要请求 only=dir（只列文件夹）')
  assert.match(guiSrc, /dirsOnly: url\.searchParams\.get\('only'\) === 'dir'/,
    '服务端要认 only=dir')
  assert.match(guiSrc, /ent\.isFile\(\) && !opts\.dirsOnly/,
    'dirsOnly 时不该把文件塞进结果里')
  // 提示语也要按模式分开（同一句话说不清两种操作）
  assert.match(html, /send\.browse\.hintDir/, '选文件夹模式要有自己的提示')
  assert.match(html, /send\.browse\.hintFile/, '选文件模式要有自己的提示')
})

test('⭐ 图形界面：每一项都有单独的「✕」，且定位一律走路径不走序号', { timeout: 60000 }, async () => {
  // 用户的原话："如果选错了文件或者文件夹只能全部清除，应该加入单独清除的选项。"
  // DOM 点不了，所以断言结构上的不变量 —— 每一条都对应一种会退化的写法。
  const html = await readFile(path.join(root, 'web', 'station.html'), 'utf8')
  const guiSrc = await readFile(path.join(root, 'src', 'gui.js'), 'utf8')

  // ① 分组行里要有删除按钮，并且点击**不能**冒泡成"展开/收起"
  const renderFn = html.slice(html.indexOf('function renderGroups'))
  const delBlock = renderFn.slice(renderFn.indexOf("del.className = 'gdel'"),
    renderFn.indexOf("row.append(caret"))
  assert.ok(delBlock.length > 100, '分组行里要有移除按钮')
  assert.match(delBlock, /ev\.stopPropagation\(\)/,
    '点删除不能冒泡到分组行 —— 否则会把这一项"展开"一下再删掉')
  assert.match(delBlock, /api\('remove', \{ path: g\.path \}\)/,
    '移除要按**路径**提交，不能按序号（删中间一项会让序号全错位）')

  // ② 展开状态与 DOM 指纹都按路径记
  assert.match(html, /const openGroups = new Set\(\)/,
    '展开状态要按路径记')
  assert.match(html, /openGroups\.has\(g\.path\)/, '展开判断要按路径')
  assert.match(renderFn, /`\$\{g\.path\}:\$\{g\.fileCount\}`/,
    'DOM 指纹要含路径 —— 否则"删掉 A、B 顶上"这种变化看不出结构变了')
  assert.match(renderFn, /openGroups\.delete\(g\.path\)/,
    '移除之后要把它的展开状态一起清掉，免得路径被重新加回来时"自动展开"')

  // ③ 明细也按路径取
  assert.match(html, /api\('group\?p=' \+ encodeURIComponent\(/,
    '明细要按路径拉')
  assert.ok(!/api\('group\?i=/.test(html), '不该再有按序号拉明细的写法')

  // ④ 后端：加一项、删一项必须走同一个状态更新函数，
  //    否则删完之后分组编号、总字节数、phase 会和加进去时不一致
  assert.match(guiSrc, /async function removePath\(p\)/,
    '后端要有 removePath')
  assert.match(guiSrc, /const i = S\.paths\.indexOf\(p\)/,
    'removePath 要按当初加进去的那个路径匹配')
  const rmFn = guiSrc.slice(guiSrc.indexOf('async function removePath'),
    guiSrc.indexOf('async function startTransfer'))
  assert.match(rmFn, /await applyPaths\(S\.paths\.filter/,
    '删一项要走 applyPaths —— 两条路径必须是同一个状态形状')
  const addFn = guiSrc.slice(guiSrc.indexOf('async function addPaths'),
    guiSrc.indexOf('async function removePath'))
  assert.match(addFn, /await applyPaths\(/,
    '加一项也要走 applyPaths（两边同源）')
  assert.match(guiSrc, /if \(!paths\.length\) \{[\s\S]{0,120}S\.phase = 'idle'/,
    '删到空要回到 idle —— 否则会停在一个空清单上等人点「开始传输」')
})

test('图形界面：页面只监听回环地址（局域网内访问不到）', { timeout: 60000 }, async () => {
  const { gui } = await bootGui()
  const port = new URL(gui.base).port
  // 找一个非回环的局域网地址，尝试连上去 —— 应当失败
  const lan = Object.values(networkInterfaces()).flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))
    .map((a) => a.address)
  if (!lan.length) return   // 没有局域网地址就跳过
  const target = `http://${lan[0]}:${port}/api/state`
  await assert.rejects(
    async () => { await fetch(target, { signal: AbortSignal.timeout(2500) }) },
    /.*/,
    `界面服务不应在 ${lan[0]} 上可达 —— 它必须只绑定 127.0.0.1`)
})

test('图形界面：添加路径后会扫描出真实清单', { timeout: 60000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'flicker-gui-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  await mkdir(path.join(dir, 'sub'), { recursive: true })
  await writeFile(path.join(dir, 'a.txt'), 'hello')
  await writeFile(path.join(dir, 'sub', 'b.bin'), Buffer.alloc(500, 7))

  const { api } = await bootGui()
  const r = await api('add', { paths: [dir] })
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)

  const st = await api('state')
  assert.equal(st.json.phase, 'plan')
  assert.equal(st.json.files.length, 2, '应扫出 2 个文件')
  assert.equal(st.json.totalBytes, 5 + 500)
  const rels = st.json.files.map((f) => f.rel)
  assert.ok(rels.some((x) => x.endsWith('a.txt')))
  assert.ok(rels.some((x) => x.endsWith('b.bin')))
})

test('图形界面：添加不存在的路径会报错而不是静默失败', { timeout: 60000 }, async () => {
  const { api } = await bootGui()
  const r = await api('add', { paths: ['D:/definitely/not/here/xyz123'] })
  assert.equal(r.status, 500)
  assert.match(r.json.error, /不存在|不可访问/)
})

test('图形界面：没有选文件时不许开始传输（防止出现空会话）', { timeout: 60000 }, async () => {
  const { api } = await bootGui()
  const r = await api('start', { password: 'something' })
  assert.equal(r.status, 500)
  assert.match(r.json.error, /还没有选择文件/)
})

test('图形界面：密码为空时不许开始', { timeout: 60000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'flicker-gui2-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  await writeFile(path.join(dir, 'a.txt'), 'x')
  const { api } = await bootGui()
  await api('add', { paths: [path.join(dir, 'a.txt')] })
  const r = await api('start', { password: '' })
  assert.equal(r.status, 500)
  assert.match(r.json.error, /密码不能为空/)
})

test('图形界面：可以换密码、可以切换赠送选项', { timeout: 60000 }, async () => {
  const { api } = await bootGui()
  const a = (await api('state')).json.password
  const b = (await api('password', {})).json.password   // 生成新密码是 POST
  assert.notEqual(a, b, '换一个应当得到不同的密码')
  assert.match(b, /^[a-z]+(-[a-z]+){3}$/, '应是 4 个单词的易读密码')

  assert.equal((await api('state')).json.gift, true, '赠送程序默认开启')
  await api('options', { gift: false })
  assert.equal((await api('state')).json.gift, false, '应能关掉')
  await api('options', { gift: true })
  assert.equal((await api('state')).json.gift, true, '应能再打开')
})

test('⭐ 图形界面：「立即销毁」必须真的销毁，不是只改一下界面文字', { timeout: 150000 }, async () => {
  // 用户实测反馈的原话："发送端的销毁没有用，点击没有反应"。
  // 原因是两条叠在一起：
  //   ① 传输启动后 `S.run` 已经存在，老代码用 `if (!S.run && …)` 判断，
  //      于是**恰好在这个按钮最该起作用的时候什么都不做**
  //   ② 就算改了阶段，会话/服务/密钥/证书一个都没动 —— 那是"看起来销毁了"
  // 这里走的正是页面上那个按钮调用的接口：POST /api/destroy。
  const dir = await mkdtemp(path.join(tmpdir(), 'flicker-destroy-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  await writeFile(path.join(dir, 'a.bin'), Buffer.alloc(64 * 1024, 3))

  const { gui, api } = await bootGui()
  await api('add', { paths: [dir] })

  const started = await api('start', { password: 'destroy-test-pass' })
  assert.equal(started.status, 200, JSON.stringify(started.json))

  // 等到会话真的起来（拿到链接 = 服务在听、证书装好了）
  //
  // ⚠️ 这里的等待预算必须给足：`onReady` 之前要走完「生成密钥 → 生成会话证书 →
  //    装进信任库（certutil）→ 监听端口」，满负载时（整轮测试 + 别的 node 一起跑）
  //    实测超过过 15 秒 —— 原先 100×150ms 的预算正好卡在这个边缘，
  //    结果是一条**与本次改动无关**的偶发失败（2026-10 真出现过一次）。
  //    预算放宽到 40 秒，并把"卡在哪一步"写进断言消息里，免得下次还要猜。
  const t0 = Date.now()
  let st = null
  for (let i = 0; i < 200; i++) {
    await sleep(200)
    st = (await api('state')).json
    if (st.phase === 'waiting' && st.url) break
    if (st.phase === 'error') break
  }
  assert.equal(st.phase, 'waiting',
    `应停在等待对方连接的阶段（实际 ${st.phase}，等了 ${Date.now() - t0}ms` +
    `${st.error ? `，错误：${st.error.title ?? ''} ${st.error.detail ?? ''}` : ''}）`)
  const url = st.url
  // ⚠️ 断言必须带上界面进程的输出：单看"url 为空"根本没法定位
  //    （是证书没装上？端口没监听？探测没过？）。实测这条曾经卡满 40 秒而
  //    只报一句"仍为空"，等于把排查成本全推给下一个人。
  const dump = (gui.getOut?.() ?? '') + (gui.getErr?.() ?? '')
  assert.ok(url,
    `应拿到接收端链接（等了 ${Date.now() - t0}ms 仍为空 —— 会话没起来，` +
    '检查证书生成/信任库安装/监听端口这几步）\n' +
    '--- 界面进程输出（末尾 1500 字）---\n' + dump.slice(-1500))

  // 点「立即销毁」
  const r = await api('destroy', {})
  assert.equal(r.status, 200)

  // 收尾要点时间：会话销毁 → runSend 发现 → 走完销毁链 → 回传清单
  for (let i = 0; i < 120; i++) {
    await sleep(150)
    st = (await api('state')).json
    if (st.phase === 'destroyed' || st.phase === 'error') break
  }

  assert.equal(st.phase, 'destroyed',
    `点了销毁之后阶段应当是 destroyed（实际 ${st.phase}）—— ` +
    '停在 waiting 就是"点击没有反应"那个毛病又回来了')
  assert.match(String(st.error?.title ?? ''), /销毁/,
    '要明确告诉用户"已按你的要求销毁"，而不是报一句吓人的"传输未完成"')
  const done = st.report?.done ?? []
  assert.ok(done.some((d) => /已清零/.test(d)), `销毁清单里应有"密钥已清零"：${done.join(' / ')}`)
  assert.ok(done.some((d) => /服务已关闭/.test(d)), '销毁清单里应有"服务已关闭"')
  assert.ok(done.some((d) => /链接已失效/.test(d)), '销毁清单里应有"链接已失效"')

  // 真正的判据：那个链接必须已经连不上了（服务真的关了，不是只改了文字）
  await assert.rejects(
    async () => { await fetch(url, { signal: AbortSignal.timeout(3000) }) },
    /.*/, '销毁之后链接必须连不上 —— 否则"销毁"只是界面上的一句话')

  // 销毁之后界面要能重新开始（不然用户被卡在一个死状态里）
  await api('reset', {})
  assert.equal((await api('state')).json.phase, 'idle', '销毁后应当能回到初始状态再传一次')
})

test('图形界面：赠品说明必须如实（源码版送的是源码包，不是 exe）', { timeout: 60000 }, async () => {
  // 用户实测反馈："闪传发送过去不是一个 exe 文件，全名是 flicker-0.1.0-source.fkz"。
  // 行为是对的（源码形态只能送源码包），但界面上那行提示一直写着
  // "对方收到后也能把文件发给别人，不用再去下载" —— 两种形态共用一句话，
  // 等于在源码模式下骗人：对方拿到 .fkz 是**需要先装 Node** 的。
  const { api } = await bootGui()
  const st = (await api('state')).json
  assert.ok(st.giftNote, '界面上必须有"赠品到底是什么"的说明')
  if (st.giftNote.includes('源码')) {
    assert.match(st.giftNote, /Node|源码包/,
      '源码形态下必须说清"对方要先装 Node"，否则用户以为送出去的是能双击的 exe')
  } else {
    assert.match(st.giftNote, /双击/, '单文件形态下应说明对方双击即可运行')
  }
})

test('图形界面：清空后回到初始状态', { timeout: 60000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'flicker-gui3-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  await writeFile(path.join(dir, 'a.txt'), 'x')
  const { api } = await bootGui()
  await api('add', { paths: [path.join(dir, 'a.txt')] })
  assert.equal((await api('state')).json.phase, 'plan')
  await api('clear', {})
  const st = (await api('state')).json
  assert.equal(st.phase, 'idle')
  assert.equal(st.files.length, 0)
  assert.equal(st.totalBytes, 0)
})

test('图形界面：未知接口返回 404 而不是 500', { timeout: 60000 }, async () => {
  const { api } = await bootGui()
  const r = await api('nope', {})
  assert.equal(r.status, 404)
})

test('图形界面：二维码编码器可被页面加载', { timeout: 60000 }, async () => {
  const { gui } = await bootGui()
  const r = await fetch(gui.base + 'api/qr.js')
  assert.equal(r.status, 200)
  const src = await r.text()
  assert.match(src, /qrMatrix/, '应暴露 qrMatrix 函数')
  // 能真的算出一个矩阵
  const m = new Function(src + '\nreturn qrMatrix("https://example.com/x");')()
  assert.ok(Array.isArray(m) && m.length > 20, '应返回一个合理的矩阵')
  assert.ok(m.every((row) => row.length === m.length), '矩阵应为正方形')
  assert.ok(m.every((row) => row.every((v) => v === 0 || v === 1)), '应只含 0/1')
})
