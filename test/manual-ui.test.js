/**
 * 判据：《使用手册》§4.2 的界面示意图必须与真实界面文案一致
 * ========================================================
 *
 * 起因是 2026-10 用户的一句话："我们现在的 UI 应该没有『有人要发给我』那个板块吧"。
 * 他是对的 —— 手册里那幅图画的是：
 *
 *      有人要发给我
 *      一次性密码  [        ]
 *      [ 开始接收 ]
 *
 * 而真实界面（`web/station.html`）上那块是「或者，让别人发给我」+「📲 手机拍的照片
 * 传到这台电脑」+「接收文件」。也就是说手册画了一个**不存在的输入框** ——
 * 而"在这一页输密码"这件事本身也是错的（密码是手机上输入的）。
 *
 * 这类错误谁都不会同时读两份去核对，所以只能用机器守：
 * `gen/check-manual-ui.mjs` 把示意图里的每一段文字与 `web/i18n-strings.mjs` 比。
 *
 * 这里守三层：
 *   ① 现在两份手册都过（真实状态）
 *   ② ⭐ 能证伪：2026-10 之前那张**真的错图**必须被拦住，并点名「有人要发给我」；
 *      只改排版不该误报
 *   ③ 这条判据自己进了 `npm run check` 与 CI；反向验证脚本在仓库里
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CHECK = path.join(ROOT, 'gen', 'check-manual-ui.mjs')
const REVERSE = path.join(ROOT, '_lab', 'verify-manual-ui-check.mjs')

test('两份手册的 §4.2 示意图都通过（图里的文字界面上都有）', () => {
  const r = spawnSync(process.execPath, [CHECK], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(r.status, 0, `检查应当通过：\n${r.stdout}${r.stderr}`)
  assert.match(r.stdout, /中文文档\/使用手册\.md/)
  assert.match(r.stdout, /docs\/使用手册\.md/)
})

test('⭐ 反向验证：2026-10 之前那张错图必须被拦住，且只改排版不误报', () => {
  const r = spawnSync(process.execPath, [REVERSE], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(r.status, 0, `反向验证脚本本身应当通过：\n${r.stdout}${r.stderr}`)
  assert.match(r.stdout, /旧错图.*点名「有人要发给我」/)
  assert.match(r.stdout, /按钮文案改一个字.*如实报错/)
  assert.match(r.stdout, /只是排版变了.*没有误报/)
})

test('手册示意图里没有"在这一页输密码"这种不存在的流程', () => {
  const zh = readFileSync(path.join(ROOT, '中文文档', '使用手册.md'), 'utf8')
  const at = zh.indexOf('### 4.2')
  const block = zh.slice(at, zh.indexOf('### 4.3'))
  assert.ok(!block.includes('有人要发给我'), '那个标题界面上不存在')
  assert.match(block, /或者，让别人发给我/, '要用界面上的原文')
  assert.match(block, /接收文件/, '入口按钮叫「接收文件」')
  // 图里不许出现密码输入框那种画法（真机上没有输入框；密码在手机上输入）
  assert.ok(!/一次性密码\s*\[/.test(block), '电脑这侧没有密码输入框')
})

test('这条判据自己也在 npm run check 与 CI 里（否则它只在你机器上跑）', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.match(pkg.scripts.check, /check-manual-ui\.mjs/, 'npm run check 里要跑它')
  assert.match(readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'),
    /check-manual-ui\.mjs/, 'CI 里也要跑它')
  assert.ok(existsSync(REVERSE), '_lab/verify-manual-ui-check.mjs 必须在 —— 否则"它会失败"只是嘴上说说')
})

test('站点页的接收面板用的是 `recvui.panelHead`，不是入口那句 `recvui.head`', () => {
  // 2026-10 之前面板标题复用了入口的 key，于是两块标题一模一样，
  // 而 `recvui.panelHead`（"接收文件（手机发过来）"）整整一条是死的。
  const src = readFileSync(path.join(ROOT, 'web', 'station.html'), 'utf8')
  const panel = src.slice(src.indexOf('id="v-recv"'), src.indexOf('id="v-recv"') + 600)
  assert.match(panel, /data-i18n="recvui\.panelHead"/,
    '接收面板的标题必须用 recvui.panelHead（否则和入口标题重复）')
})
