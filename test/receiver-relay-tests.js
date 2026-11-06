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

/**
 * 切一个**可能带 async 的**页面函数。
 * ⚠️ sliceFn 从 `function name(` 开始切，会把前面的 `async ` 丢掉，
 *    抽出来的源码里带着 await —— 在 new Function 里直接 SyntaxError。
 */
export function slicePageFn(html, name) {
  const at = html.indexOf('function ' + name + '(')
  assert.notEqual(at, -1, `页面里找不到 function ${name}`)
  const isAsync = html.slice(Math.max(0, at - 6), at) === 'async '
  return (isAsync ? 'async ' : '') + sliceFn(html, name)
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

  // ── 清单分帧（P1-2）────────────────────────────────────────
  //
  // 中继单条消息有上限（约 2 MiB）。约一万个单块小文件的清单约 2.59 MB > 上限，
  // 从前"发一个文件夹"在中继模式下是**确定性失败**（413 TOO_LARGE，不可重试）。
  // 发送端把清单拆成多条；接收端按 seq=0 的 8 字节头自描述地拼回来。
  //
  // 这里的判据用**测试里独立实现的发送端分帧器**（frameManifest）—— 两边都按
  // 规格逐字节写，拼得回来才算真的对齐，而不是"页面里的实现自己和自己一致"。

  const MAX_PARTS = Number((/const MAX_MANIFEST_PARTS = (\d+);/.exec(html) || [])[1])
  assert.ok(Number.isInteger(MAX_PARTS), '页面里应当有 MAX_MANIFEST_PARTS 常量')

  // eslint-disable-next-line no-new-func
  const framer = new Function('t', 'MAX_MANIFEST_PARTS',
    sliceFn(html, 'manifestPartHeader') + '\n' + slicePageFn(html, 'fetchFramedManifest')
    + '\nreturn { manifestPartHeader, fetchFramedManifest }')((k) => k, MAX_PARTS)

  /**
   * 发送端那一侧的分帧（按规格独立实现）：
   *   payload = BE32(i) ‖ BE32(partCount) ‖ M.slice(i*partSize, …)，存于 seq=i
   */
  function frameManifest(msg, maxMsg) {
    const partSize = maxMsg - 8
    const partCount = Math.max(1, Math.ceil(msg.length / partSize))
    const out = []
    for (let i = 0; i < partCount; i++) {
      const frag = msg.slice(i * partSize, Math.min(msg.length, (i + 1) * partSize))
      const f = new Uint8Array(8 + frag.length)
      const dv = new DataView(f.buffer)
      dv.setUint32(0, i)
      dv.setUint32(4, partCount)
      f.set(frag, 8)
      out.push(f)
    }
    return out
  }

  test('清单分帧：头就是 BE32(index) ‖ BE32(partCount)，不足 8 字节返回 null', () => {
    const M = new Uint8Array(100)
    const frames = frameManifest(M, 30)
    const h = framer.manifestPartHeader(frames[2])
    assert.deepEqual(h, { index: 2, partCount: frames.length })
    assert.equal(framer.manifestPartHeader(new Uint8Array(7)), null)
    assert.equal(framer.manifestPartHeader(null), null)
  })

  test('⭐ 清单分帧：多条消息按序号拼回原来的完整字节', async () => {
    const M = new Uint8Array(250)
    for (let i = 0; i < M.length; i++) M[i] = (i * 37 + 11) & 0xff
    const frames = frameManifest(M, 40)          // partSize = 32 → 多条
    assert.ok(frames.length > 1, '这个长度应当被拆成多条，否则用例没测到分帧')
    for (const f of frames) assert.ok(f.length <= 40, '单条不能超过 maxMessageBytes')
    const got = await framer.fetchFramedManifest(async (seq) => frames[seq])
    assert.equal(got.partCount, frames.length)
    assert.equal(Buffer.from(got.msg).toString('hex'), Buffer.from(M).toString('hex'),
      '拼回来的 M 必须与发送端那条完整清单消息逐字节相同')
  })

  test('清单分帧：只有一条时也要能取（partCount=1 的常规场景）', async () => {
    const M = new Uint8Array(30).fill(9)
    const frames = frameManifest(M, 2 * 1024 * 1024)
    assert.equal(frames.length, 1)
    const got = await framer.fetchFramedManifest(async (seq) => frames[seq])
    assert.equal(got.partCount, 1)
    assert.equal(Buffer.from(got.msg).toString('hex'), Buffer.from(M).toString('hex'))
  })

  test('清单分帧：序号错位必须报错，绝不能把错位的段拼成一段坏清单', async () => {
    const M = new Uint8Array(100).fill(7)
    const frames = frameManifest(M, 30)
    const swapped = frames.slice()
    swapped[2] = frames[3]                       // 第 3 条的头写着 index=3
    await assert.rejects(() => framer.fetchFramedManifest(async (seq) => swapped[seq]),
      (e) => e.code === 'RELAY_BAD_MANIFEST',
      '序号对不上还继续拼，界面只会看到一句没法定位的"清单解密失败"')
  })

  test('⭐ 清单分帧：partCount 上限 1024，超了给可读错误而不是去取一万条', async () => {
    assert.equal(MAX_PARTS, 1024)
    const bad = new Uint8Array(8)
    const dv = new DataView(bad.buffer)
    dv.setUint32(0, 0)
    dv.setUint32(4, MAX_PARTS + 1)
    await assert.rejects(() => framer.fetchFramedManifest(async () => bad),
      (e) => e.code === 'RELAY_BAD_MANIFEST' && e.message === 'recv.msg.badManifestParts',
      '超过上限要报专门的文案（不是让接收端按坏头去拉一百亿条消息）')
  })

  test('⭐ 中继序号：数据块与 ack 都加上清单分帧条数', () => {
    const relay = sliceFn(html, 'relayTransport')
    assert.match(relay, /fetchFramedManifest\(fetchSeq\)/, 'prepare 要先拼回分帧清单')
    assert.match(relay, /manifestParts = framed\.partCount/, '记住分帧条数')
    assert.match(relay, /fetchSeq\(manifestParts \+ seq\)/,
      '取块的消息序号 = partCount + g')
    assert.match(relay, /const seq = manifestParts \+ 1 \+ chunkSeq/,
      'ack 的 upTo = partCount + 1 + g')
  })

  test('中继模式：密码错时先报可读的 BAD_PASSWORD（房间名校验）', () => {
    const relay = sliceFn(html, 'relayTransport')
    assert.match(relay, /toHex\(keys\.room\) !== room/,
      '没有握手的中继模式只能靠派生的房间名判断密码')
    assert.match(relay, /code: 'BAD_PASSWORD'/, '要落到"密码不一致"的文案上')
  })
}
