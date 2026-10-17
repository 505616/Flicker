/**
 * 手机上传页的"自包含"与内联守卫
 * ================================
 * 这一页的失败方式很特别：它由**电脑上的 HTTPS 服务**送出去，手机拿到之后
 * 不能再向我们要任何东西，也不能假设自己跑在什么网络里。所以有两类判据：
 *
 *   ① **自包含**：页面里不许有外部资源引用（`<script src>`、`<link href>`、
 *      外链图片/字体、`fetch` 外域）—— 多一个 URL 就多一处会 404 的地方，
 *      而 404 的表现是"页面点了没反应"或"样式全丢"，离原因很远。
 *   ② **内联段同步**：协议内核 / 路径规则 / 中英文文案都是**生成**进来的，
 *      手改生成物必然漂移。`gen/inline-phone.mjs --check` 等三条判据守着这一条，
 *      这里再证明"那三条判据真的会失败"（往副本里塞一个 `</script>` 看它拒不拒）——
 *      否则"有检查"这件事本身就没被验过。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PAGE = path.join(ROOT, 'web', 'phone.html')

const cleanups = []
test.after(async () => {
  for (const fn of cleanups.reverse()) {
    try { await fn() } catch (e) { console.error('清理失败：' + (e?.message ?? e)) }
  }
})

const run = (cmd, argv, env = {}) => new Promise((resolve) => {
  const c = spawn(cmd, argv, {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, ...env },
  })
  let out = '', err = ''
  c.stdout.on('data', (b) => { out += b })
  c.stderr.on('data', (b) => { err += b })
  c.on('exit', (code) => resolve({ code, out, err }))
})

test('手机页面是自包含的：没有任何外部资源引用（除了那个必须的一次性链接）', async () => {
  const html = await readFile(PAGE, 'utf8')
  const body = html.replace(/<!--[\s\S]*?-->/g, '')      // 注释里提到 URL 不算

  // <script src> / <link href> / <img src> 这类外部引用一个都不该有
  const externals = []
  for (const m of body.matchAll(/<(script|link|img|iframe|video|audio|source)\b[^>]*>/gi)) {
    const tag = m[0]
    const url = (tag.match(/\b(?:src|href)\s*=\s*["']([^"']+)["']/i) || [])[1]
    if (url && !url.startsWith('data:')) externals.push(url)
  }
  assert.deepEqual(externals, [], `页面里有外部资源引用：${externals.join('、')}`)

  // 相对/外域 fetch 也不该有（这一页只跟自己所在的源说话）
  const fetches = [...body.matchAll(/fetch\(\s*['"`]([^'"`]+)/g)].map((m) => m[1])
  for (const f of fetches) {
    assert.ok(f.startsWith('/'), `页面里出现了非本站请求：${f}（手机的网络里没有别的东西可依赖）`)
  }

  assert.match(html, /<!-- i18n:begin/, '缺 i18n 内联段')
  assert.match(html, /<!-- phone-core:begin/, '缺协议内核内联段')
  assert.match(html, /<!-- path-rules:begin/, '缺路径规则内联段')
  assert.match(html, /globalThis\.FlickerPhone\s*=/, '协议内核没有挂到 FlickerPhone 上')
  assert.match(body, /data-lang-switch/, '缺语言切换按钮（中英双语是项目的既有承诺）')
})

test('内联守卫真的会失败：源文件里出现 `</script>` 时必须拒绝生成', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'flicker-phone-guard-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const bad = path.join(dir, 'phone-core-bad.js')
  const good = await readFile(path.join(ROOT, 'web', 'phone-core.js'), 'utf8')
  // 故意塞一个会**提前闭合 script 标签**的字符串
  await writeFile(bad, good + '\nvar x = "</script>";\n', 'utf8')

  const r = await run(process.execPath, [path.join(ROOT, 'gen', 'inline-phone.mjs'), '--check'],
    { FLICKER_INLINE_PHONE_SRC: bad })
  assert.notEqual(r.code, 0, '含 `</script>` 的源文件必须让生成器失败')
  assert.match(r.err, /<\/script/, '失败信息里要点出是 `</script>` 的问题')
  assert.match(r.err, /提前闭合/, '要说清后果（标签提前闭合），而不是只报"有非法字符"')
})

test('内联守卫真的会失败：源文件里出现 import 时必须拒绝（浏览器里没有模块系统）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'flicker-phone-guard2-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const bad = path.join(dir, 'phone-core-bad2.js')
  await writeFile(bad, 'import { createHash } from "node:crypto"\nvar ok = 1\n', 'utf8')

  const r = await run(process.execPath, [path.join(ROOT, 'gen', 'inline-phone.mjs'), '--check'],
    { FLICKER_INLINE_PHONE_SRC: bad })
  assert.notEqual(r.code, 0, '含 import 的源文件必须让生成器失败')
  assert.match(r.err, /import/, '失败信息里要点出是 import 的问题')
})
