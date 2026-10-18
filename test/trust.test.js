/**
 * 信任库模块测试
 * ==============
 * 重点验证 **约束 1（证书自检）能否真的抓住那张没有 CA 标志的证书** ——
 * 那正是 _lab 实测中导致 ERR_CERT_INVALID 的根因。
 *
 * 这个测试会真的动你的证书库，但每一步都会还原，并在结束时断言证书数回到原值。
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { rm } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  generateSession, selfCheckOrThrow, trustCa, untrustCa, removeServerCert,
  rootStoreCount, findResidualCa, cleanResidual, localIPv4, primaryIPv4,
  support, CertError, CA_SUBJECT_MARK, keyUsageOf, manualTrustHint,
  removeFromMy, findMyLeftovers, myLeftoverCount, cleanAllLeftovers, cleanTempDirs,
} from '../src/trust.js'

const pexec = promisify(execFile)
const isWindows = process.platform === 'win32'

// ⚠️ 这里要区分**两种**跳过，混成一个会白丢一大片覆盖率：
//
//   `skipStore` —— 会真实改写当前用户**系统证书库**的用例。
//                 目前只有 Windows 有实现（macOS 必然弹认证对话框、
//                 Linux 没有零依赖路径），所以只在 Windows 上跑。
//   不加 skip  —— 只需要"生成一张证书"的用例（Key Usage 解析、结构自检、
//                 平台报告……）。证书生成从 2026-10 起是**纯 JS、全平台同一份代码**，
//                 所以这些用例在 macOS / Linux 上也**必须真的跑**，
//                 否则 CI 在那两个平台上等于没验证书这一块。
/**
 * 会真实改写**当前用户系统证书库**的用例，在两种情况下跳过：
 *   ① 非 Windows：装卸目前只有 Windows 实现；
 *   ② `FLICKER_NO_CERT_INSTALL=1`：CI 用的开关。
 *
 * ② 的理由是实测出来的：把根证书装进 CurrentUser\Root 会弹**系统确认框**，
 * 真机上由用户点"是"，而 CI 上没人点 —— certutil 会一直等，第一次 CI 就挂了 25 分钟。
 * 跳过时要**说清原因**，不能装作验过了（这条能力只在真机上有效验证）。
 */
const skipStore = !isWindows ? '系统证书库的装卸目前仅在 Windows 上实现'
  : process.env.FLICKER_NO_CERT_INSTALL === '1'
    ? 'CI 无法应答"安装根证书"的系统确认框（FLICKER_NO_CERT_INSTALL=1），这条只在真机上验'
    : false

let baseCount = 0
let session = null

before(async () => {
  // 生成在所有平台都可用 —— 不再用 isWindows 拦住它
  if (isWindows) baseCount = await rootStoreCount()
  session = await generateSession({ hosts: ['127.0.0.1', 'localhost'] })
})

after(async () => {
  if (!session) return
  // 做一次彻底的兜底清理
  await session.cleanup()
  // 这两条在非 Windows 上是安全的空操作（findResidualCa 在非 Windows 返回 []）
  await cleanAllLeftovers()
  await cleanTempDirs({ olderThanMs: 0 })

  if (!isWindows) return

  // ⚠️ 三条断言缺一不可。
  //    早先只断言了 Root 库，结果 My 库里悄悄积累了 148 张证书 ——
  //    正是"用完即销毁"要防的事，测试却没发现。
  assert.equal(await rootStoreCount(), baseCount,
    `Root 库未还原！测试前 ${baseCount}，测试后 ${await rootStoreCount()}`)
  assert.equal(await myLeftoverCount(), 0,
    `个人证书库里残留了 ${await myLeftoverCount()} 张本程序的证书 —— ` +
    'New-SelfSignedCertificate 会把 CA 也放这里，必须一并清理')
})

// ── Key Usage 解析（这是实测踩过的坑）────────────────────────

test('keyUsageOf 能解析出 CA 的 keyCertSign —— Node 内建属性做不到这件事', async () => {
  const { X509Certificate } = await import('node:crypto')
  const ca = new X509Certificate(session.caDer)
  const ku = keyUsageOf(session.caDer)          // 传 DER 字节，不是证书对象
  assert.ok(Array.isArray(ku), '应能解析出 Key Usage 扩展')
  assert.ok(ku.includes('keyCertSign'), `CA 必须含 keyCertSign，实际: ${ku.join(', ')}`)
  assert.ok(ku.includes('cRLSign'), `CA 应含 cRLSign，实际: ${ku.join(', ')}`)

  // ── 记录这个坑：Node 的 .keyUsage 属性装的是 **EKU 的 OID**，不是 Key Usage ──
  //
  // ⚠️ 这里断言的是**服务器证书**，不是 CA。
  //    旧版从 PowerShell 的 New-SelfSignedCertificate 拿到的 CA 带 EKU，
  //    所以 `ca.keyUsage` 是个数组；纯 JS 生成的 CA **只有 Key Usage、
  //    没有 EKU**，于是该属性是 undefined —— 断言必须跟着实际走，
  //    否则测试只是在记录一个已经不存在的实现细节。
  const srv = new X509Certificate(session.srvDer)
  assert.ok(Array.isArray(srv.keyUsage), 'keyUsage 属性在带 EKU 的证书上确实是数组（OID 列表）')
  assert.ok(srv.keyUsage.every((o) => /^\d+(\.\d+)+$/.test(o)),
    'keyUsage 属性里是 OID 字符串，不是人类可读名 —— 所以不能用它匹配 "Certificate Sign"')
  assert.ok(srv.keyUsage.includes('1.3.6.1.5.5.7.3.1'), '服务器证书的 EKU 应含 serverAuth')
  assert.equal(srv.extKeyUsage, undefined, 'extKeyUsage 属性恒为 undefined')
  // 而真正要看的 Key Usage（keyCertSign 那一类）在 Node 里**没有属性**：
  assert.equal(ca.keyUsage, undefined,
    'CA 没有 EKU，所以 .keyUsage 是 undefined —— 这也说明它读不到 Key Usage 扩展')

  // 也能吃 PEM
  const fromPem = keyUsageOf(session.srvPem)
  assert.ok(Array.isArray(fromPem), 'PEM 输入也应能解析')
  assert.deepEqual(fromPem, keyUsageOf(session.srvDer), 'PEM 与 DER 必须解析出同一结果')
})

test('服务器证书的 EKU 只给 serverAuth，不给 clientAuth（最小权限）', async () => {
  const { X509Certificate } = await import('node:crypto')
  const srv = new X509Certificate(session.srvDer)
  assert.ok(!srv.keyUsage.includes('1.3.6.1.5.5.7.3.2'),
    '这张证书只为"当一次 HTTPS 服务器"而生，不该同时具备客户端证书能力')
})

test('keyUsageOf 对服务器证书给出数字签名/密钥加密', async () => {
  const ku = keyUsageOf(session.srvDer)
  assert.ok(ku && ku.length > 0, '应能解析出服务器证书的 Key Usage')
  assert.ok(ku.includes('digitalSignature') || ku.includes('keyEncipherment'),
    `服务器证书应含 digitalSignature 或 keyEncipherment，实际: ${ku.join(', ')}`)
  assert.ok(!ku.includes('keyCertSign'), '服务器证书不应有 keyCertSign')
})

test('keyUsageOf 对垃圾输入返回 null 而不是抛错', () => {
  assert.equal(keyUsageOf(Buffer.from('garbage')), null)
  assert.equal(keyUsageOf(Buffer.alloc(0)), null)
  assert.equal(keyUsageOf(''), null)
  assert.equal(keyUsageOf(null), null)
  assert.equal(keyUsageOf({}), null)
  assert.equal(keyUsageOf(42), null)
})

// ── 地址探测 ────────────────────────────────────────────────

test('localIPv4 排除回环与链路本地地址', () => {
  const list = localIPv4()
  for (const a of list) {
    assert.ok(!a.address.startsWith('127.'), '不应包含回环地址')
    assert.ok(!a.address.startsWith('169.254.'), '不应包含链路本地地址')
    assert.match(a.address, /^\d+\.\d+\.\d+\.\d+$/)
  }
})

test('primaryIPv4 总能返回一个可用地址', () => {
  const ip = primaryIPv4()
  assert.match(ip, /^\d+\.\d+\.\d+\.\d+$/)
})

// ── 自检：核心用例 ──────────────────────────────────────────

test('自检通过：正确生成的证书应当无异议', () => {
  const r = selfCheckOrThrow({
    caDer: session.caDer,
    srvPem: session.srvPem,
    srvDer: session.srvDer,
    targetHost: '127.0.0.1',
  })
  assert.ok(r.ca.ca, 'CA 应带 CA=TRUE 标志')
  assert.ok(r.srv.subjectAltName.includes('127.0.0.1'))
  assert.ok(r.caKeyUsage.includes('keyCertSign'), '自检应确认 CA 有 keyCertSign')
  assert.ok(r.srvKeyUsage.includes('digitalSignature'), '自检应确认服务器证书可做数字签名')
})

test('自检：SAN 不含接收端要访问的地址 → 必须拒绝', () => {
  // 这是最容易犯的错：证书只写了 localhost，但接收端访问的是 192.168.x.x
  assert.throws(
    () => selfCheckOrThrow({
      caDer: session.caDer, srvPem: session.srvPem, srvDer: session.srvDer,
      targetHost: '192.168.99.99',
    }),
    (e) => e instanceof CertError && e.code === 'SELF_CHECK_FAILED' && /SAN 不含/.test(e.message),
    '缺 SAN 目标时必须被自检拦下')
})

test('自检：把服务器证书当成 CA 传进去 → 必须拒绝（CA 标志缺失）', () => {
  // 这正是 _lab 里那个真实故障：生成出来的"CA"没有 CA 标志
  assert.throws(
    () => selfCheckOrThrow({
      caDer: session.srvDer, srvPem: session.srvPem, srvDer: session.srvDer,
      targetHost: '127.0.0.1',
    }),
    (e) => e instanceof CertError && /CA=TRUE|无法被该 CA 验证/.test(e.message),
    '没有 CA 标志的证书必须被拒绝 —— 否则会出现 ERR_CERT_INVALID')
})

test('自检：无法解析的输入 → 清晰报错而不是崩溃', () => {
  assert.throws(() => selfCheckOrThrow({ caDer: Buffer.from('not a cert'), srvPem: 'x', targetHost: 'a' }),
    (e) => e instanceof CertError && e.code === 'CA_UNPARSEABLE')
  assert.throws(() => selfCheckOrThrow({ caDer: Buffer.from('x'), srvPem: 'y', targetHost: 'a' }),
    (e) => e instanceof CertError && /无法解析/.test(e.message))
})

test('自检错误信息里必须包含"为什么"和"怎么修"', () => {
  try {
    selfCheckOrThrow({
      caDer: session.caDer, srvPem: session.srvPem, srvDer: session.srvDer,
      targetHost: '10.0.0.1',
    })
    assert.fail('应当抛错')
  } catch (e) {
    assert.match(e.message, /SAN/, '要说清是 SAN 的问题')
    assert.match(e.message, /必须出现在 SAN 里/, '要给出原因')
  }
})

// ── 信任库：装入 / 卸载 / 残留清理 ──────────────────────────

test('CA 能装入信任库，且不需要管理员权限', { skip: skipStore }, async () => {
  const before = await rootStoreCount()
  await trustCa(session.caDer, session.dir)
  const afterAdd = await rootStoreCount()
  assert.equal(afterAdd, before + 1, '装入后证书数应 +1')

  const found = await findResidualCa()
  assert.equal(found.length, 1, '应能通过标记找到刚装入的证书')
  assert.match(found[0].subject, new RegExp(CA_SUBJECT_MARK))

  const ok = await untrustCa(session.caThumbprint)
  assert.equal(ok, true, 'certutil 卸载应成功')
  assert.equal(await rootStoreCount(), before, '卸载后应完全还原')
})

test('约束 2：cleanResidual 能清掉上次异常退出留下的证书', { skip: skipStore }, async () => {
  // 先保证起点干净（即使前面的用例失败也不会互相拖累）
  await cleanResidual()
  const before = await rootStoreCount()

  // 模拟"装了但没卸"的异常退出
  await trustCa(session.caDer, session.dir)
  const afterTrust = await rootStoreCount()
  assert.equal(afterTrust, before + 1, '装入后证书数应 +1')

  const residual = await findResidualCa()
  assert.equal(residual.length, 1, '应能找到残留')

  const { removed, failed } = await cleanResidual()
  assert.equal(removed.length, 1, `应清掉 1 个残留，实际 ${removed.length}`)
  assert.equal(failed.length, 0, '不应有清理失败')
  assert.equal(await rootStoreCount(), before, '清理后应完全还原')

  // 幂等：再清一次不应该出错、也不应该删掉别的东西
  const again = await cleanResidual()
  assert.equal(again.removed.length, 0)
  assert.equal(await rootStoreCount(), before)
})

test('findResidualCa 只认自己的证书，不动别人的', { skip: skipStore }, async () => {
  await cleanResidual()
  const before = await rootStoreCount()
  const found = await findResidualCa()
  assert.equal(found.length, 0, '清干净后不应再有残留')
  assert.equal(await rootStoreCount(), before, '查询不应改动证书库')
})

test('⭐ 上层工具污染 PSModulePath 时，证书库查询仍然可用', { skip: skipStore }, async (t) => {
  // 这个用例复刻的是一次**真实故障**（2026-10）：
  // 从某些开发工具里启动时，继承来的 PSModulePath 里混进了 PowerShell 7 的
  // Security 模块、而且排在 5.1 自己的模块目录前面。于是 5.1 去加载一个
  // 版本不兼容的模块，`Cert:` 盘根本不存在：
  //     Cannot find drive. A drive with the name 'Cert' does not exist.
  // 而 certutil 一切正常、证书库里有 49 张证书。
  // 后果很实际：**启动时的"残留证书自扫"（约束 2）会失败**。
  //
  // ⚠️ 反向对照不能是"把 PSModulePath 指向一个不存在的目录" —— 那种情况下
  //    5.1 会回退到默认路径，照样能找到自己的模块（第一版就是这么写错的，
  //    结果这条用例自己红了）。真正会坏的是"**找到了另一个版本的同名模块**"。
  //    所以对照项只在环境里真的存在这样一个模块时才跑，否则如实说明跳过。
  const sysDir = path.join(process.env.WINDIR ?? 'C:\\Windows',
    'system32', 'WindowsPowerShell', 'v1.0', 'Modules')
  const polluter = (process.env.PSModulePath ?? '').split(';').filter(Boolean)
    .find((d) => d.toLowerCase() !== sysDir.toLowerCase()
      && existsSync(path.join(d, 'Microsoft.PowerShell.Security', 'Microsoft.PowerShell.Security.psd1')))

  const real = process.env.PSModulePath
  try {
    // ① 修复后的代码：无论 PSModulePath 长什么样，都必须给出**真值**
    process.env.PSModulePath = [polluter, real].filter(Boolean).join(';')
    const n = await rootStoreCount()
    assert.ok(Number.isInteger(n) && n >= 0,
      `证书数应当是有效整数（实际 ${n}）—— 说明子进程拿到了可用的模块路径`)
    assert.ok(Array.isArray(await findResidualCa()), '残留查询也应当正常返回数组')

    // ② 反向对照：旧写法在同样的环境下**给不出真值**（要么报错，要么读出假 0）。
    //    ⚠️ 不能只断言"它会抛错"：实测过它有时**退出码 0、stdout 是 "0"**，
    //    也就是"看起来查到了 0 张证书"——比抛错恶劣得多（那正是本项目的头号禁忌：
    //    一个看起来在检查、其实什么都没查到的判据）。所以判据是"读到的值与真值不符"。
    if (!polluter) {
      t.diagnostic('环境里没有"另一个版本的 Security 模块"，跳过反向对照')
      return
    }
    let naive
    try {
      const r = await pexec('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        '(Get-ChildItem Cert:\\CurrentUser\\Root).Count'],
      { windowsHide: true, env: { ...process.env, PSModulePath: [polluter, real].join(';') } })
      naive = Number(r.stdout.trim())
    } catch {
      naive = null            // 报错也算"没给出真值"
    }
    assert.notEqual(naive, n,
      `旧写法在污染环境下读到了真值 ${n} —— 说明这条用例没有复刻到真正的故障`)
    t.diagnostic(`反向对照：旧写法读到 ${naive === null ? '（直接报错）' : naive}，真值是 ${n}`)
  } finally {
    if (real === undefined) delete process.env.PSModulePath
    else process.env.PSModulePath = real
  }
})

test('⭐ 读证书库的每条命令都必须带 -ErrorAction Stop（否则会读出假 0）', () => {
  // 这条判据防的是"悄悄退回去"：
  //   `Get-ChildItem Cert:\… -ErrorAction SilentlyContinue`（或干脆不写）
  //   在 Cert: 盘不可用时会**退出码 0 + 输出 0 条**，
  //   于是 findResidualCa() 返回空数组 = "没有残留" —— 而残留还在。
  // 实测记录见 `_lab/tmp-*.mjs` 的对话记录与路线图第五·补章。
  const src = readFileSync(new URL('../src/trust.js', import.meta.url), 'utf8')
  const reads = [
    ...src.matchAll(/Get-ChildItem Cert:\\+CurrentUser\\+(Root|My)[^\n`]*/g),
  ].map((m) => m[0])
  assert.ok(reads.length >= 4, `应当至少有 4 处读取证书库（实际 ${reads.length}）`)
  for (const r of reads) {
    assert.match(r, /-ErrorAction Stop/,
      `这条读证书库的命令没有 -ErrorAction Stop：${r.trim()}`)
  }
})

test('untrustCa 对空指纹安全返回，不抛错', async () => {
  assert.equal(await untrustCa(''), false)
  assert.equal(await untrustCa(null), false)
})

test('removeServerCert 对空指纹安全返回', async () => {
  assert.equal(await removeServerCert(''), false)
})

// ── 平台支持现状 ────────────────────────────────────────────

test('support() 如实报告平台支持情况', () => {
  const s = support()
  assert.equal(typeof s.supported, 'boolean')
  assert.equal(typeof s.detail, 'string')
  assert.equal(typeof s.platform, 'string')
  assert.equal(s.platform, process.platform)

  // ⚠️ 这里要分清两件事，别混成一句"支持/不支持"：
  //   ① 证书**生成**：纯 JS，全平台，有真实 TLS 握手作判据 → 永远 true
  //   ② 装进**系统信任库**：平台相关，目前只有 Windows 实测过
  assert.equal(s.generate, true, '证书生成在所有平台都可用（纯 JS，不依赖外部工具）')
  assert.equal(typeof s.verified, 'boolean', '要能看出"是否在真机验过"，而不是只有支持/不支持')

  if (process.platform === 'win32') {
    assert.equal(s.supported, true, 'Windows 已实测，应报告支持')
    assert.equal(s.verified, true)
    assert.equal(s.installMethod, 'certutil')
    assert.match(s.detail, /实测/, '要说明它凭什么算"支持"')
  } else {
    assert.equal(s.supported, false, '非 Windows 未实测，必须如实报告不支持')
    assert.equal(s.verified, false)
    assert.match(s.detail, /no-cert-install/, '要告诉用户降级办法')
    // "不支持"必须说清**为什么**，而且理由要具体到平台机制 ——
    // 只说"未实测"会让人以为"再等等就好了"，而这里有些是机制上做不到。
    assert.ok(s.detail.length > 30, `detail 要有信息量，实际：「${s.detail}」`)
  }
})

test('⭐ 证书生成在所有平台都可用 —— 不再抛 NOT_SUPPORTED', async () => {
  // 这条测试**刻意不加 skip**：它必须在 macOS / Linux 的 CI 上真的跑一遍。
  // 从前这里断言的是"非 Windows 抛 NOT_SUPPORTED"，而生成改成纯 JS 之后，
  // 那个断言会变成"记录一个已经不存在的限制" —— 而且在 CI 上直接失败。
  const cert = await generateSession({ hosts: ['127.0.0.1', 'localhost'] })
  try {
    assert.equal(cert.generatedBy, 'pure-js', '生成方式应当是纯 JS（无外部工具）')
    assert.ok(cert.caPem.includes('BEGIN CERTIFICATE'))
    assert.ok(cert.srvKeyPem.includes('BEGIN PRIVATE KEY'))
    // ⚠️ pfx 恒为 null：Node 没有生成 PKCS#12 的 API，
    //    而 server.listen 本来就收 PEM 的 {key, cert}，所以直接绕开这件事。
    assert.equal(cert.pfx, null, 'pfx 应为 null —— 这是"改用 PEM"的明确信号')
    assert.equal(cert.passphrase, null)
    // 自检能在任何平台上跑（它只用 Node 内建的 X509Certificate）
    const r = selfCheckOrThrow({ caDer: cert.caDer, srvPem: cert.srvPem, srvDer: cert.srvDer,
      targetHost: '127.0.0.1' })
    assert.deepEqual(r.caKeyUsage, ['keyCertSign', 'cRLSign'])
  } finally {
    await cert.cleanup()
  }
})

test('manualTrustHint() 给出各平台的确切命令（不自动代跑）', () => {
  // 值得从 Windows 上断言：这些字符串是给用户照抄的，写错一个路径就白折腾
  const mac = manualTrustHint('darwin').join('\n')
  assert.match(mac, /security add-trusted-cert/)
  assert.match(mac, /login\.keychain-db/, '用户钥匙串路径要写全，否则用户不知道 -k 填什么')
  assert.match(mac, /machine-cert-file/, '要告诉用户怎么把 CA 导出来（默认不落盘）')

  const linux = manualTrustHint('linux').join('\n')
  assert.match(linux, /nssdb/, 'Linux 的浏览器读的是 NSS 库，不是系统 CA 目录')
  assert.match(linux, /libnss3-tools|nss-tools/, '要说明 certutil 来自哪个包（默认不装）')
  assert.match(linux, /-A -t "C,,"/, '信任标志写错就等于没装')
  assert.match(linux, /Firefox/, 'Firefox 用自己的库，必须单独提一句')

  assert.deepEqual(manualTrustHint('win32'), [],
    'Windows 已经自动装了，不该再打印手动命令')
})

