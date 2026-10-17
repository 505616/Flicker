/**
 * 密码交互的测试
 * ==============
 * 交互设计（刻意如此，别改成"都要打两遍"）：
 *   · 直接回车       → 接受自动生成的密码，不再二次确认
 *   · 输入自定义密码 → 要求再打一遍确认
 *
 * 理由：生成的密码有 26 个字符。逼用户手抄一遍来"确认接受默认值"
 * 既荒谬又极易出错，而它本来是零风险操作。
 * 只有自己设密码才值得二次确认 —— 打错了对方永远进不来，且看不出原因。
 *
 * 测试手法：tty() 支持注入输入输出流，所以这里不需要劫持 process.stdout
 * （实测在某些 Node 版本上劫持 process.stdout.write 不可靠）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { tty } from '../src/tty.js'

/** 用给定的输入行跑一次 askPassword */
async function askWith(lines) {
  const stdin = Readable.from([lines.length ? lines.join('\n') + '\n' : ''])
  const sink = { isTTY: false, text: '', write(c) { this.text += String(c); return true } }
  const ui = tty({ noQr: true, noColor: true, machine: true, stdin, stdout: sink, stderr: sink })
  const pw = await ui.askPassword()
  return { pw, out: sink.text }
}

/** 从输出里解析出终端显示的那个建议密码（在框线中间那一行） */
function suggestionFrom(out) {
  // 密码在框线中间那一行，形如：│     ember-copper-quiver-harbor     │
  const m = out.match(/([a-z]{3,}(?:-[a-z]{3,}){3})/)
  assert.ok(m, '输出里应显示一个自动生成的密码，实际:\n' + out)
  return m[1]
}

test('直接回车 → 接受自动生成的密码，且不再要求二次确认', async () => {
  const { pw, out } = await askWith([''])     // 一个空行 = 按了一次回车
  assert.ok(pw, '应返回一个密码')
  assert.equal(pw, suggestionFrom(out), '返回的应正是屏幕上显示的那个密码')
  assert.match(pw, /^[a-z]+(-[a-z]+){3}$/, '应是 4 个单词的易读密码')
  assert.doesNotMatch(out, /请再输入一次以确认/,
    '接受默认值不该要求二次确认 —— 否则等于逼用户手抄 26 个字符')
  assert.match(out, /密码已确认/)
})

test('自定义密码打两遍一样 → 采用自定义的', async () => {
  const { pw, out } = await askWith(['my-secret', 'my-secret'])
  assert.equal(pw, 'my-secret')
  assert.match(out, /请再输入一次以确认/, '自定义密码必须二次确认')
})

test('自定义密码两遍不一样 → 返回 null（调用方据此中止）', async () => {
  const { pw, out } = await askWith(['aaa', 'bbb'])
  assert.equal(pw, null, '不一致必须返回 null，绝不能默默用一个错密码开始传输')
  assert.match(out, /不一致/)
})

test('自定义密码里的空格被原样保留（对方要照抄）', async () => {
  const { pw } = await askWith(['correct horse battery staple', 'correct horse battery staple'])
  assert.equal(pw, 'correct horse battery staple')
})

test('自定义密码首尾空白被去掉（避免看不见的字符导致双方对不上）', async () => {
  const { pw } = await askWith(['  mypass  ', '  mypass  '])
  assert.equal(pw, 'mypass')
})

test('输入提前结束（EOF）时按"回车接受默认"处理，不卡死也不崩溃', async () => {
  const { pw } = await askWith([])     // 完全没有输入
  assert.ok(pw, 'EOF 应视为接受默认密码，而不是抛错')
  assert.match(pw, /^[a-z]+(-[a-z]+){3}$/)
})

test('连续两次调用会得到不同的密码（每次都是新的）', async () => {
  const a = (await askWith([''])).pw
  const b = (await askWith([''])).pw
  assert.notEqual(a, b, '每次生成的密码都应是新的')
})

test('提示里包含必要的说明', async () => {
  const { out } = await askWith([''])
  assert.match(out, /一次性密码/, '要有标题')
  assert.match(out, /回车使用上面这个/, '要说明回车的行为')
  assert.match(out, /已随机生成/, '要说明密码是怎么来的')
})

test('自定义密码的场景下提示也清楚', async () => {
  const { out } = await askWith(['x', 'x'])
  assert.match(out, /想自己设定就输入自定义密码/, '要告诉用户可以自己设')
})
