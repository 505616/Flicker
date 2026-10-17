/**
 * 协议里那几条「待验证」的真实行为
 * ================================
 *
 * PROTOCOL.md 里挂了 15 条「待验证」。这个文件负责其中**能在本机核实**的几条 ——
 * 核实的结论已经写回文档，这里把它钉住，免得以后被人"顺手改回去"。
 *
 * 为什么这些值得单独一组测试：它们都属于**文档与实现不一致**这一类问题。
 * 这类问题不会让任何测试变红（测试测的是实现），只会让读文档的人写出错的客户端、
 * 或者让用户按文档的承诺去期待一个程序做不到的行为。
 * 本项目的标准是"文档里写的必须是真的"，所以每条结论都要有代码或实测撑着。
 *
 * 已经核实的三条：
 *   ① `GET /session` 未认证时**不泄露**文件数量与总大小（比文档要求的更彻底）
 *   ② 一次性令牌**没有**"同一 TCP 连接不算新消费"的例外，且行为是确定的
 *   ③ `GET /session` 的响应字段与文档一致（文档此前是错的，已按实现改正）
 *
 * 另有两条属于**不可在本机核实**，在这里以断言的形式说明清楚，
 * 免得它们看起来像"忘了做"（见文件末尾）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { Agent, request } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Session, PHASE } from '../src/session.js'
import { TransferServer } from '../src/server.js'
import { deriveVerifier, deriveKeys, sealManifest, PARAMS } from '../src/suite/flicker1.js'
import { isTransientError } from '../src/relay/client.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function makeServer(password, { files = 3, bytes = 2_491_081_032 } = {}) {
  const salt = randomBytes(PARAMS.saltBytes)
  const verifier = deriveVerifier(password, salt)
  const keys = deriveKeys(verifier)
  const wire = {
    v: 1, suite: 'FLICKER/1',
    files: Array.from({ length: files }, (_, i) => ({
      kind: 'file', name: `secret-${i}.txt`, rel: `dir/secret-${i}.txt`,
      size: Math.floor(bytes / files), chunks: 1,
      chunkBytes: PARAMS.chunkBytes, sha256: 'x', chunkHashes: ['y'],
    })),
    totalBytes: bytes, totalChunks: files,
  }
  const enc = sealManifest(keys.enc, Buffer.from(JSON.stringify(wire), 'utf8'))
  const session = new Session({
    salt, verifier, encManifest: enc.ct, manifestIv: enc.iv, manifestTag: enc.tag,
  })
  const srv = new TransferServer({
    session,
    manifest: { ...wire, files: wire.files.map((f, i) => ({ ...f, index: i, firstChunk: i, absPath: null })) },
    receiverHtml: '<!doctype html><meta charset="utf-8"><h1>接收页</h1>',
  })
  return { session, srv, wire }
}

/** 用指定 agent 发一个请求（agent 用来控制是否复用同一条 TCP 连接） */
function req(port, pathname, agent) {
  return new Promise((resolve, reject) => {
    const r = request({
      host: '127.0.0.1', port, path: pathname, method: 'GET', agent, timeout: 5000,
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
        reused: r.reusedSocket === true,
      }))
    })
    r.on('timeout', () => { r.destroy(new Error('超时')) })
    r.on('error', reject)
    r.end()
  })
}

// ── ① 未认证时不泄露任何摘要 ────────────────────────────────

test('⭐ 未认证时 /api/session 不泄露文件数量与总大小', async () => {
  const made = makeServer('facts-password-1', { files: 3, bytes: 2_491_081_032 })
  const port = await made.srv.listen({ host: '127.0.0.1', port: 0 })
  const agent = new Agent({ keepAlive: true })
  try {
    // ① 完全不带令牌
    const bare = await req(port, '/api/session', agent)
    assert.equal(bare.status, 403, '未认证必须是 403')
    assert.ok(!/"files"/.test(bare.body), `响应里不该有 files 字段：${bare.body}`)
    assert.ok(!/"bytes"/.test(bare.body), `响应里不该有 bytes 字段：${bare.body}`)
    assert.ok(!/2491081032/.test(bare.body), '更不该把真实的总字节数漏出去')

    // ② 令牌错误
    const wrong = await req(port, '/api/session?k=definitely-not-the-token', agent)
    assert.equal(wrong.status, 403)
    assert.ok(!/"files"/.test(wrong.body))

    // ③ 令牌正确但**还没打开过页面**（令牌未被消费）
    const k = encodeURIComponent(made.session.token)
    const unconsumed = await req(port, `/api/session?k=${k}`, agent)
    assert.equal(unconsumed.status, 403, '必须先打开页面，令牌才算被消费')
    assert.ok(!/"files"/.test(unconsumed.body))
    assert.equal(made.session.tokenConsumed, false, '被拒绝的请求不该消费令牌')

    // ④ 走完正常顺序之后才有摘要 —— 而且摘要也不在 /api/session 里
    const page = await req(port, `/?k=${k}`, agent)
    assert.equal(page.status, 200)
    const ok = await req(port, `/api/session?k=${k}`, agent)
    assert.equal(ok.status, 200)
    const info = JSON.parse(ok.body)
    assert.equal(info.salt !== undefined, true, '盐是必须给的（派生密钥要用）')
    assert.ok(!('files' in info), '文件数量**始终**不发，而不是"认证后才发"')
    assert.ok(!('bytes' in info), '总大小同理')
    // 文件信息只能在解密清单之后才拿得到
    assert.ok(!/secret-0|secret-1/.test(ok.body), '响应里不能出现任何文件名')
  } finally {
    agent.destroy()
    await made.srv.shutdown()
  }
})

test('GET /session 的响应字段就是实现发的那几个（文档已按实现改正）', async () => {
  const made = makeServer('facts-password-2')
  const port = await made.srv.listen({ host: '127.0.0.1', port: 0 })
  const agent = new Agent({ keepAlive: true })
  try {
    const k = encodeURIComponent(made.session.token)
    await req(port, `/?k=${k}`, agent)
    const info = JSON.parse((await req(port, `/api/session?k=${k}`, agent)).body)

    // ⚠️ PROTOCOL.md 原先列的是 protocol / suites / session / manifest(字符串) / files / bytes，
    //    与实现**六个字段全不一样**。照着那份文档写客户端必然对不上，所以文档改正了，
    //    这里钉住"文档现在写的就是实现发的"。
    assert.deepEqual(Object.keys(info).sort(),
      ['chunkBytes', 'kdf', 'manifest', 'room', 'salt', 'suite'])
    assert.equal(info.suite, 'FLICKER/1')
    assert.equal(typeof info.manifest, 'object', 'manifest 是 {iv,ct,tag} 对象，不是 base64 字符串')
    assert.deepEqual(Object.keys(info.manifest).sort(), ['ct', 'iv', 'tag'])
    assert.equal(info.kdf.name, PARAMS.kdf, 'kdf.name 就是 PARAMS.kdf（PBKDF2-SHA256）')
    assert.equal(info.kdf.iterations, PARAMS.iterations)
    assert.equal(info.chunkBytes, PARAMS.chunkBytes)
    // 文档里不该再出现那几个不存在的字段名
    const doc = readFileSync(path.join(ROOT, '中文文档', 'PROTOCOL.md'), 'utf8')
    const section = doc.slice(doc.indexOf('直连模式下 `GET /session` 的响应体'))
      .slice(0, 1200)
    assert.ok(!/"suites"\s*:/.test(section), '文档里不该再写 suites 字段（没有实现套件协商）')
    assert.ok(!/"protocol"\s*:/.test(section), '文档里不该再写 protocol 字段')
  } finally {
    agent.destroy()
    await made.srv.shutdown()
  }
})

// ── ② 一次性令牌：行为是确定的 ──────────────────────────────

test('⭐ 令牌没有"同一连接不算新消费"的例外 —— 连复用连接也一定 410', async () => {
  const made = makeServer('facts-password-3')
  const port = await made.srv.listen({ host: '127.0.0.1', port: 0 })
  // maxSockets: 1 + keepAlive → 三次请求必然走同一条 TCP 连接
  const agent = new Agent({ keepAlive: true, maxSockets: 1 })
  try {
    const k = encodeURIComponent(made.session.token)
    const first = await req(port, `/?k=${k}`, agent)
    const second = await req(port, `/?k=${k}`, agent)
    const third = await req(port, `/?k=${k}`, agent)

    assert.equal(first.status, 200)
    assert.equal(second.reused, true, '前置条件：第二次确实复用了同一条连接')
    assert.equal(second.status, 410, '复用连接同样是"新的一次消费"')
    assert.equal(third.status, 410)
    assert.match(second.body, /TOKEN_USED/)
  } finally {
    agent.destroy()
    await made.srv.shutdown()
  }
})

test('刷新页面 = 新连接 + 已消费的令牌 → 410（这是确定的行为，不是偶发）', async () => {
  const made = makeServer('facts-password-4')
  const port = await made.srv.listen({ host: '127.0.0.1', port: 0 })
  const k = encodeURIComponent(made.session.token)
  const a1 = new Agent({ keepAlive: true })
  const a2 = new Agent({ keepAlive: false })
  try {
    assert.equal((await req(port, `/?k=${k}`, a1)).status, 200)
    const refresh = await req(port, `/?k=${k}`, a2)   // 全新连接
    assert.equal(refresh.status, 410)
    assert.match(refresh.body, /TOKEN_USED/, '要告诉用户"链接已被使用过"，而不是含糊的失败')
  } finally {
    a1.destroy(); a2.destroy()
    await made.srv.shutdown()
  }
})

// ── ③ 被占用时报的错必须是"不可重试" ────────────────────────

test('ROOM_TAKEN 被判定为不可重试（重试一万次房间也还是别人的）', () => {
  const e = new Error('房间名已被占用')
  e.code = 'ROOM_TAKEN'
  assert.equal(isTransientError(e), false)
  // 对照：真正的瞬时故障仍然要重试，免得上面那条把重试一刀切掉
  assert.equal(isTransientError(null, 503), true)
  const net = new TypeError('fetch failed')
  assert.equal(isTransientError(net), true)
})

// ── ④ 浏览器能力探测与显式降级 ──────────────────────────────

test('⭐ 能力探测实测 API 而不是猜浏览器名字，且降级是**显式**的', () => {
  const html = readFileSync(path.join(ROOT, 'web/receiver.html'), 'utf8')
  const strings = readFileSync(path.join(ROOT, 'web/i18n-strings.mjs'), 'utf8')

  // ① 探测方式：`架构决策.md` §2.3 的原则是"能力检测永远优先于 UA 判断"
  assert.match(html, /const CAN_STREAM = typeof window\.showSaveFilePicker === 'function'/,
    '必须实测 API 是否存在，不能靠 UA 猜')

  // ② 能力不足时**在密码屏就提示**，而不是等传失败了才说
  //
  // ⚠️ 这里**不能**用"从 CAN_STREAM 往后切 700 字"这种固定窗口 ——
  //    那个窗口里后来插进了别的常量（预取深度那一段），分支一下就被挤出窗口，
  //    于是这条测试失败得莫名其妙（它测的本来是"有没有分支"，不是"离得多远"）。
  //    改成切到插入语句为止，并且只判"两端的相对位置对不对"，不判距离。
  const probeAt = html.indexOf('const CAN_STREAM')
  const insertAt = html.indexOf("$('v-pw').insertBefore")
  assert.ok(probeAt > 0 && insertAt > probeAt,
    '页面结构变了：找不到能力探测或它的降级分支')
  // 切到那个 if 块的结尾（含插入语句本身 —— "插在哪一屏"正是要判的东西）
  const blockEnd = html.indexOf('\n}', insertAt)
  const detect = html.slice(probeAt, blockEnd > insertAt ? blockEnd : insertAt + 200)
  assert.match(detect, /if \(!CAN_STREAM\)/, '缺能力时要有分支')
  assert.match(detect, /v-pw/, '提示要插在**密码屏**（用户还没开始传就该知道）')
  assert.match(detect, /note warn/, '要用醒目的警告样式，不是普通说明')
  assert.match(detect, /data-i18n/, '文案要走 i18n，否则切语言时这句不会跟着变')

  // ③ 文案要说清"后果 + 建议"，不能只说"不支持"
  // ⚠️ 文案表里的长句是**跨行拼接**的（'…' + '…'），所以不能拿一条
  //    "整句在一行里"的正则去匹配 —— 那会永远匹配不上，而失败信息看起来
  //    像是"文案里没写建议"，其实只是断行了。改成"找到键之后往后看一段"。
  for (const key of ['recv.go.noStreamWarn', 'recv.go.bigWarn']) {
    const needle = `'${key}':`
    const hits = []
    for (let i = strings.indexOf(needle); i >= 0; i = strings.indexOf(needle, i + 1)) hits.push(i)
    assert.equal(hits.length, 2, `${key} 应当中英各一条，实际 ${hits.length} 条`)
    for (const i of hits) {
      const body = strings.slice(i, i + 400)
      assert.match(body, /Edge/, `${key} 要给浏览器建议（这段里没提到 Edge）`)
      assert.match(body, /Chrome/, `${key} 要给浏览器建议（这段里没提到 Chrome）`)
    }
  }

  // ④ 大文件再补一刀：超过告警线时换成带具体体积的警告
  //
  // ⚠️ 判据盯的是**行为**（拿阈值常量去比），不是那个字面量。
  //    阈值后来抽成了 `MEMORY_MODE_LIMIT`，并被两处共用（"浏览器不支持流式写盘"
  //    与"用户拒绝了写入权限"）。继续钉字面值的话，"把数字抽成常量"这种改进
  //    反而会把测试弄红 —— 那种测试会逼着人把好结构改回去。
  const limit = html.match(/const MEMORY_MODE_LIMIT = (\d+) \* 1024 \* 1024/)
  assert.ok(limit, '内存模式的告警线要是一个具名常量（两处共用，避免只改一处）')
  const limitMb = Number(limit[1])
  assert.ok(limitMb >= 256 && limitMb <= 4096,
    `告警线 ${limitMb} MB 不像个合理值 —— 太小会误报、太大就失去意义`)
  assert.match(html, /!CAN_STREAM && total > MEMORY_MODE_LIMIT/,
    '大文件要提前警告（别让他传到一半才失败）')

  // ⑤ 能力判断不许按浏览器名字来。
  //    ⚠️ 判据要精确：页面里出现 "Firefox" 这个词本身没问题 ——
  //       注释里解释"Firefox/Safari 走内存路径"是有用的文档。
  //       要禁的是**用 UA 去猜能力**，所以判据是"同一行里既有 UA 又有浏览器名"。
  const uaLines = html.split('\n')
    .filter((l) => /navigator\.(userAgent|vendor|platform)/.test(l))
    .filter((l) => /Firefox|Chrome|Safari|Edg\//.test(l))
  assert.deepEqual(uaLines, [],
    '出现了"看 UA 猜浏览器 → 决定能力"的写法。能力检测要实测 API（见 CAN_STREAM）——\n' +
    '    UA 可以改、可以说谎、新的浏览器名字也认不出来，猜错了要么误报要么漏报。\n' +
    `    冒犯的行：${uaLines.map((l) => l.trim()).join(' | ')}`)

  // 平台判断（Windows 的文件名规则）确实需要看 platform —— 那是"文件系统规则不同"，
  // 不是"能力不同"，用特性检测根本无法判断。这里只要求它**只用于路径规则**。
  const platLines = html.split('\n').filter((l) => /navigator\.platform/.test(l))
  assert.ok(platLines.length <= 2, `platform 判断应当只有一处（路径规则），实际 ${platLines.length} 处`)
})

// ── 明确"本机无法核实"的两条 ────────────────────────────────

test('文档里剩下的「待验证」都写明了为什么本机验不了、需要什么条件', () => {
  const doc = readFileSync(path.join(ROOT, '中文文档', 'PROTOCOL.md'), 'utf8')
  const all = doc.split('\n').map((line, i) => ({ line, no: i + 1 }))
    .filter((x) => x.line.includes('待验证'))

  // 已经核实过的三条不许再挂着「待验证」
  for (const gone of ['macOS 上 HFS+/APFS 的 Unicode 规范化',
    '此例外在浏览器并发请求下的行为需要实测',
    '实现时需确认 `token` 校验发生在返回摘要**之前**']) {
    assert.ok(!doc.includes(gone), `这条已经核实过了，不该还挂着「待验证」：${gone}`)
  }

  // 只审"真正还挂着的条目"：
  //   · 判据是**加粗的条目标记**（`**待验证**`）—— 正文里提到"待验证"这个词的
  //     地方（图例、状态说明、历史叙述）都不算条目。用"包含待验证"这种宽判据，
  //     检查就变成"逼着人改文档措辞"而不是"逼着人把事做完"。
  //   · 划掉的（`~~…~~`）= 已撤回或已解决。
  //   · 已经标了 ✅/已实测 的（讲历史时还会提到）。
  const isItem = (s) => /\*\*待验证\*\*/.test(s) && !/~~\s*\*\*待验证\*\*/.test(s)
  const legend = /该条为设计推断/
  const resolved = /✅|已实测|已核实|不再是待验证|已按实现更正|标注待验证/
  const items = all.filter((x) => isItem(x.line) && !legend.test(x.line) && !resolved.test(x.line))

  assert.ok(items.length > 0, '一条待验证都没有了？那这份文档该把图例也删掉')
  for (const { line, no } of items) {
    // 每条都要说清"卡在哪里" —— 只写「待验证」而不写条件，
    // 半年后看起来就像"忘了做"，而不是"需要真机/真账号/真网络"
    assert.ok(/候选实测目标|需要实测|需实测|需真机|需要真机|无设备|无法在本机|需按/.test(line),
      `中文文档/PROTOCOL.md 第 ${no} 行的「待验证」没有说明卡在哪里：\n      ${line.trim()}`)
  }
})
