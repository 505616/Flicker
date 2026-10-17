/**
 * 图形界面的插件支持（2026-10 新增）
 * ================================
 *
 * 以前 `--plugin` + 图形界面是**明确拒绝**的（界面进程不解析插件，悄悄忽略会让用户
 * 以为插件生效了 —— 那是这个项目最忌讳的失败方式）。现在改成真的支持，所以要有判据钉住：
 *
 *   ① 带 `--plugin` 启动界面**不再被拒**，而且插件真的被加载了（`/api/state` 里看得见）
 *   ② 插件 `ctx.log()` 的输出**改道进界面日志**（默认写 stderr，在界面里看不见）
 *   ③ 接收模式**也支持插件**（2026-10 的第四个平面）：界面的注册表按
 *      `planes: ['sender', 'receive']` 建，点「接收文件」会真的起服务，`receive/ready` 真的送达
 *   ④ 接线本身：`gui.js` 把注册表交给 `runSend`（与命令行发送同一个入口）
 *
 * ⚠️ 刻意**不**在这里起一次真实传输：那要装证书、还要有真的接收端，会慢且脆。
 *    `runSend` 里插件那一侧的行为由 `test/plugin.test.js` 覆盖 —— 界面这条路
 *    复用的是**同一个** `runSend`，这里只需要证明"注册表确实交到了它手上"。
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPluginRegistry } from '../src/plugin/registry.js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CLI = path.join(root, 'bin', 'flicker.js')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const cleanups = []
const live = []

/**
 * 每个用例结束**立刻**杀掉它起的界面进程。
 *
 * ⚠️ 与 `test/gui.test.js` 里同一条纪律：界面进程启动时会清扫"上一次会话的残留证书"，
 *    而它是按证书名匹配删除的 —— **同时活两个界面**就会互相删掉对方刚装好的 CA，
 *    那个会话的就绪探测随即失败。这不是测试独有的问题（真机上同时开两个会话也一样），
 *    但测试**不该自己制造并发**：不立刻杀，后面几条 GUI 用例就会时灵时不灵。
 */
afterEach(async () => {
  for (const c of live.splice(0)) { try { c.kill() } catch { /* 已退出 */ } }
  await sleep(150)
})

test.after(async () => {
  for (const c of live.splice(0)) { try { c.kill() } catch { /* 已退出 */ } }
  for (const fn of cleanups.reverse()) {
    try { await fn() } catch (e) { console.error('清理失败：' + (e?.message ?? e)) }
  }
})

/** 起一个界面进程（可以带额外参数），等它把地址打出来 */
function startGui(extraArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, '--gui', ...extraArgs], {
      env: { ...process.env, FLICKER_NO_BROWSER: '1', FLICKER_NO_OPEN: '1' },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    live.push(child)
    let out = '', err = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已退出 */ }
      reject(new Error(`界面启动超时\n${out}\n${err}`))
    }, 15000)
    const onData = (b, isErr) => {
      const s = b.toString()
      if (isErr) err += s; else out += s
      const m = out.match(/(http:\/\/127\.0\.0\.1:\d+\/)/)
      if (m) {
        clearTimeout(timer)
        resolve({ child, base: m[1], getOut: () => out, getErr: () => err })
      }
    }
    child.stdout.on('data', (b) => onData(b, false))
    child.stderr.on('data', (b) => onData(b, true))
    child.on('exit', (c) => { clearTimeout(timer); if (c) reject(new Error(`界面退出 (${c})\n${out}\n${err}`)) })
  })
}

async function api(gui, p, body) {
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

/** 造一个"加载时就把名字写进文件"的插件 —— 用来证明它真的被 apply 过 */
async function makeProbePlugin(dir, logFile) {
  const file = path.join(dir, 'probe.cjs')
  await writeFile(file, `
const { appendFileSync } = require('node:fs')
module.exports = {
  name: 'gui-probe',
  version: '1.0.0',
  apiVersion: 1,
  apply(ctx) {
    ctx.log('probe 已加载')
    ctx.on('run/start', (p) => { appendFileSync(${JSON.stringify(logFile)}, 'run/start\\n') })
  },
}
`, 'utf8')
  return file
}

test('⭐ 带 --plugin 启动图形界面：不再被拒，且插件真的加载了', { timeout: 60000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'flicker-guip-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const pluginFile = await makeProbePlugin(dir, path.join(dir, 'fired.txt'))

  const gui = await startGui([`--plugin=${pluginFile}`])
  const all = gui.getOut() + gui.getErr()

  assert.ok(!/图形界面暂不支持插件/.test(all),
    `不应当再出现"图形界面暂不支持插件"：\n${all}`)
  assert.match(all, /已加载/, '加载了什么必须打在屏幕上（这条是项目规矩）')
  assert.match(all, /gui-probe/, '要写出插件名')

  const st = await api(gui, 'state')
  assert.equal(st.status, 200)
  assert.ok(Array.isArray(st.json.plugins), '状态里要有 plugins 字段（页面据此显示）')
  assert.deepEqual(st.json.plugins.map((p) => p.name), ['gui-probe'],
    `界面状态里应当看得到已加载的插件，实际 ${JSON.stringify(st.json.plugins)}`)

  // ② 插件日志改道：`ctx.log()` 的内容要出现在界面输出里
  assert.match(all, /probe 已加载/,
    '插件 ctx.log() 的输出要进界面日志 —— 默认写 stderr，在界面里等于扔了')
})

test('⭐ 接收模式也支持插件：点「接收文件」会真的起服务，`receive/ready` 真的送达插件',
  { timeout: 60000 }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'flicker-guip-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const fired = path.join(dir, 'ready.txt')
    const pluginFile = path.join(dir, 'recv-probe.cjs')
    await writeFile(pluginFile, `
const { appendFileSync } = require('node:fs')
module.exports = {
  name: 'recv-probe',
  apiVersion: 1,
  apply(ctx) {
    ctx.on('receive/ready', (e) => appendFileSync(${JSON.stringify(fired)}, 'ready ' + e.port + '\\n'))
  },
}
`, 'utf8')
    const inbox = path.join(dir, 'inbox')

    const gui = await startGui([`--plugin=${pluginFile}`])
    const r = await api(gui, 'recv/start', { dir: inbox })
    // 从前这里必须失败（v1 没有接收平面）；现在要**真的起来**，而不是假装成功
    assert.equal(r.status, 200, `带接收平面插件时应当真的起得来：${JSON.stringify(r.json ?? r.text)}`)
    assert.equal(r.json?.ok, true, '接口要明确回报"起来了"')
    const st = await api(gui, 'state')
    assert.equal(st.json?.recv?.phase, 'waiting', '应收服务起来之后进入"等待对方"' +
      `（实际：${JSON.stringify(st.json?.recv?.phase)}）`)

    // `receive/ready` 要真的送到插件手里（不是只写了个发射点）
    let text = ''
    for (let i = 0; i < 40 && !text; i++) {
      await sleep(100)
      try { text = await readFile(fired, 'utf8') } catch { /* 还没写 */ }
    }
    assert.match(text, /^ready \d+/, `插件必须收到 receive/ready（实际：${JSON.stringify(text)}）`)
    assert.match(gui.getOut() + gui.getErr(), /recv-probe/, '加载了哪个插件必须打在屏幕上')

    // 收尾：停掉这次接收（界面进程本身由 afterEach 杀）
    const stopped = await api(gui, 'recv/stop', {})
    assert.equal(stopped.status, 200, '要能停得掉（否则这条用例把一个服务挂在后台）')
  })

test('接线：gui.js 把注册表交给 runSend，并把插件日志改道', async () => {
  const src = await readFile(path.join(root, 'src', 'gui.js'), 'utf8')
  assert.match(src, /const plugins = opts\.plugins \?\? null/,
    'runGui 要接收入口传进来的注册表')
  assert.match(src, /plugins\.setLog\(/, '插件日志要改道到界面日志（否则在界面里看不见）')
  assert.match(src, /runSend\(\{[\s\S]*?plugins,/,
    'startTransfer 要把 plugins 交给 runSend —— 与命令行发送走同一个入口，不另写一份')
})

test('registry.setLog：换出口立即生效，且不重载插件', async () => {
  const lines = []
  const reg = createPluginRegistry({ log: (l) => lines.push('旧:' + l) })
  const mod = {
    name: 'log-probe', apiVersion: 1,
    apply(ctx) { ctx.log('第一句') },
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'flicker-logp-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'log-probe.cjs')
  await writeFile(file, 'module.exports = { name: "log-probe", apiVersion: 1, apply(ctx) { ctx.log("第一句") } }', 'utf8')
  await reg.load([file])
  assert.ok(lines.some((l) => l.includes('第一句')), '默认出口应当收到日志')

  lines.length = 0
  reg.setLog((l) => lines.push('新:' + l))
  reg.pluginLog('log-probe', '第二句')
  assert.deepEqual(lines, ['新:  [插件 log-probe] 第二句'], '改道后新出口应当收到，旧出口不该再收到')
  assert.equal(reg.list.length, 1, 'setLog 不该重载插件（apply 只能跑一次）')
  assert.ok(mod)     // 只是让上面的对象不被当成未使用
  await reg.dispose()
  await sleep(1)
})
