// 中继模式（跨网络）的测试
// ========================
// 接收端有两条通路（局域网直连 / 经中继），但**加密、校验、写盘完全一样**。
// 这里要盯住的性质是：
//   ① 参数从 URL 的 **fragment** 读 —— 浏览器不把 fragment 发给服务器，
//      所以中继连密钥派生的输入（盐）都看不到
//   ② 房间名必须是 64 位十六进制 —— 短的就只有 64 bit，可暴力枚举
//   ③ 两条通路都以**同一个**密钥派生函数收口，不会变成两套加密逻辑
//   ④ NOT_YET 是"稍等"而不是错误（发送端是按需投递的）
//
// 由 test/receiver-page.test.js 引入，复用那边的 html 常量。

import { test } from 'node:test'
import assert from 'node:assert/strict'

/** 从页面里抽出 readRelayParams，并绑定一个假的 location */
export function makeReadRelayParams(html) {
  const m = html.match(/function readRelayParams\(\) \{[\s\S]*?\n\}/)
  assert.ok(m, '未能从 receiver.html 定位 readRelayParams —— 页面结构变了？')
  const src = m[0]
  return (hash) => {
    // eslint-disable-next-line no-new-func
    const fn = new Function('location', src + '\nreturn readRelayParams')
    return fn({ hash, search: '' })()
  }
}

/**
 * 按**花括号配对**截出一个函数的完整源码。
 *
 * ⚠️ 两个坑，都踩过：
 *   ① 不能用 "找到 function X( 再找下一个 \n}\n" 这种字符串切法 ——
 *      函数体内部就有顶格的 \n}\n，会切进相邻函数里。
 *   ② 就算改用花括号配对，也**不能从第一个 { 开始数** ——
 *      参数里的解构（`function f({ room, salt })`）也有花括号，
 *      会让配对在参数结束处就归零，只切到一行。
 *      正确做法：先跳过参数列表（按圆括号配对），再从函数体的 { 开始数。
 */
export function sliceFn(html, name) {
  const start = html.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `页面里找不到 function ${name}`)

  // ① 按圆括号配对跳过参数列表
  const paren = html.indexOf('(', start)
  assert.notEqual(paren, -1, `${name} 后面应有参数列表`)
  let pd = 0, afterParams = -1
  for (let i = paren; i < html.length; i++) {
    if (html[i] === '(') pd++
    else if (html[i] === ')') {
      pd--
      if (pd === 0) { afterParams = i; break }
    }
  }
  assert.notEqual(afterParams, -1, `${name} 的参数括号没有配对`)

  // ② 从参数之后的第一个 { 开始数花括号
  const brace = html.indexOf('{', afterParams)
  assert.notEqual(brace, -1, `${name} 的函数体应以 { 开始`)
  let depth = 0
  for (let i = brace; i < html.length; i++) {
    const c = html[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return html.slice(start, i + 1)
    }
  }
  throw new Error(`${name} 的花括号没有配对`)
}

/** 去掉注释与字符串字面量，只留真正的代码 —— 用于"不该出现 X"这类断言 */
export function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

/**
 * 从页面里抽出 `K256` 与 `Sha256`（纯 JS 的增量 SHA-256）。
 *
 * ⚠️ 锚点必须带 `^`（配合 `m`）：页面里 **`buildHashWorkerSource()` 的字符串字面量**
 *    也含有 `const K256 = new Uint32Array([` 这段文字 —— 不带行首锚点时，
 *    正则会从那个字面量开始匹配，抽出一段"半字符串半代码"的东西，
 *    报错是 `Invalid or unexpected token`，看起来像页面语法坏了。实测踩过一次（2026-10）。
 */
export function extractSha256(html) {
  // 注意 K256 那段：数组字面量的最后一行是 `…0xc67178f2]);` —— `]);` 前面**没有换行**，
  // 所以这里不能写成 `\n\]\);`（第一版就是这么写的，结果一条都匹配不到）。
  const m = html.match(
    /^const K256 = new Uint32Array\(\[[\s\S]*?\]\);\n[\s\S]*?^class Sha256 \{[\s\S]*?\n\}/m)
  assert.ok(m, '未能从 receiver.html 定位 K256/Sha256 —— 页面结构变了？')
  // eslint-disable-next-line no-new-func
  return new Function(m[0] + '\nreturn { K256, Sha256 }')()
}

export function registerRelayPageTests(html) {
  const readRelayParams = makeReadRelayParams(html)
  const ROOM = 'a'.repeat(64)
  const SALT = 'b'.repeat(32)

  test('中继模式：fragment 解析正确（房间名 + 盐）', () => {
    assert.deepEqual(readRelayParams(`#k=${ROOM}&s=${SALT}`), { room: ROOM, salt: SALT })
    assert.deepEqual(readRelayParams(`#s=${SALT}&k=${ROOM}`), { room: ROOM, salt: SALT })
  })

  test('中继模式：缺参数或格式不对时返回 null（不抛错，也不拿错数据去解密）', () => {
    for (const bad of [
      '', '#', `#k=${ROOM}`, `#s=${SALT}`,
      `#k=short&s=${SALT}`, `#k=${ROOM}&s=tooshort`,
      `#k=${'Z'.repeat(64)}&s=${SALT}`,
      `#k=${ROOM}&s=${'g'.repeat(32)}`,
    ]) {
      assert.equal(readRelayParams(bad), null, `应拒绝: ${bad.slice(0, 40)}`)
    }
  })

  test('中继模式：房间名必须是 64 位（短的可暴力枚举，必须拒绝）', () => {
    assert.equal(readRelayParams(`#k=${'a'.repeat(16)}&s=${SALT}`), null,
      '16 位房间名必须被拒绝 —— 64 bit 不够')
    assert.equal(readRelayParams(`#k=${'a'.repeat(63)}&s=${SALT}`), null)
    assert.equal(readRelayParams(`#k=${'a'.repeat(65)}&s=${SALT}`), null)
    assert.ok(readRelayParams(`#k=${'a'.repeat(64)}&s=${SALT}`))
  })

  test('中继模式：参数只从 location.hash 读（绝不能从 search 读）', () => {
    // fragment 不参与 HTTP 请求 —— 改成 search 就会把房间名与盐都发给中继
    const src = html.match(/function readRelayParams\(\) \{[\s\S]*?\n\}/)[0]
    assert.match(src, /location\.hash/, '必须从 location.hash 读')
    assert.doesNotMatch(codeOnly(src), /location\.search/, '绝不能从 search 读')
  })

  test('中继模式：链接里带的是房间名与盐，不包含密码或密钥', () => {
    const src = html.match(/function readRelayParams\(\) \{[\s\S]*?\n\}/)[0]
    for (const forbidden of ['password', 'passwd', 'secret']) {
      assert.doesNotMatch(codeOnly(src), new RegExp(`get\\(\\s*'${forbidden}'`),
        `链接里不该出现 ${forbidden}`)
    }
  })

  test('中继模式：两条通路都以同一个密钥派生函数收口', () => {
    assert.match(html, /function localTransport\(\)/, '应有局域网通路')
    assert.match(html, /function relayTransport\(/, '应有中继通路')
    assert.match(html, /function pickTransport\(\)/, '应有选择逻辑')

    const local = sliceFn(html, 'localTransport')
    const relay = sliceFn(html, 'relayTransport')
    assert.match(local, /deriveKeysFn\(/, '局域网通路应调用传入的派生函数')
    assert.match(relay, /deriveKeysFn\(/, '中继通路必须调用**同一个**派生函数')
    // 两条通路都不该自己实现派生（否则会漂移）
    for (const [name, src] of [['local', local], ['relay', relay]]) {
      assert.doesNotMatch(codeOnly(src), /PBKDF2|HKDF/,
        `${name} 通路不该自己实现密钥派生 —— 必须复用同一份`)
    }
  })

  test('中继模式：NOT_YET 必须被当作"稍等"，而不是错误', () => {
    const src = sliceFn(html, 'relayTransport')
    assert.match(src, /NOT_YET/, '必须专门处理 NOT_YET —— 发送端是按需投递的')
    assert.match(src, /setTimeout/, 'NOT_YET 应重试等待，而不是直接报错')
    assert.match(src, /RELAY_TIMEOUT|等了很久/, '等待要有上限，不能无限等下去')
  })

  test('中继模式：房间消失/过期时给出可读提示，而不是抛 HTTP 404', () => {
    assert.match(sliceFn(html, 'relayTransport'), /房间已经不存在|RELAY_GONE/)
  })

  test('中继模式：接收端不主动销毁房间（交给发送端决定）', () => {
    const src = sliceFn(html, 'relayTransport')
    const i = src.indexOf('async done()')
    assert.notEqual(i, -1, '应有 done()')
    assert.doesNotMatch(codeOnly(src.slice(i)), /DELETE/,
      '接收端不该主动销毁房间 —— 发送端可能还在等确认')
  })

  test('中继模式：主流程不区分模式（差异只在传输层）', () => {
    // 主流程里不该出现"如果是中继模式就……"这类分支 ——
    // 那意味着加密或写盘逻辑被复制了第二份。
    const start = sliceFn(html, 'start')
    assert.match(start, /pickTransport\(\)/, '主流程应通过 pickTransport 选通路')
    assert.match(start, /transport\.prepare\(/, '参数获取应走传输层')
    assert.doesNotMatch(codeOnly(start), /relayTransport|readRelayParams|'relay'/,
      '主流程里不该出现通路选择的具体实现 —— 模式差异应完全收在传输层里')
  })

  test('中继模式：分块与完成通知都走传输层', () => {
    assert.match(html, /S\.transport\.getChunk\(/, '分块应走传输层')
    assert.match(html, /S\.transport\.done\(\)/, '完成通知应走传输层')

    // 除了局域网通路内部，不该有别的代码直接请求 /api/chunk。
    // 注意：要剥掉注释再判断 —— 文档里提到这个端点是正常的。
    const local = sliceFn(html, 'localTransport')
    const withoutLocal = html.replace(local, '')
    assert.doesNotMatch(codeOnly(withoutLocal), /api\/chunk/,
      '除了局域网通路内部，不该有别的代码直接请求 /api/chunk')
    assert.match(local, /api\/chunk/, '局域网通路内部当然要用它')
  })
}
