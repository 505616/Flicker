/**
 * 会话级证书与信任库
 * ==================
 *
 * 这个模块实现 架构决策.md §4.3 的四条实现约束：
 *   约束 1  证书自检 —— 装进信任库之前先验证它真的是一张合法的 CA 与服务器证书
 *   约束 2  残留清理 —— 启动时扫描并移除上次异常退出留下的证书
 *   约束 3  先装证书、再监听、再探测、最后才开窗口（本模块负责前两步和卸载）
 *
 * 这些约束来自实测，不是推测。踩过的坑（详见 _lab/实测报告-证书信任.md）：
 *   - 用 '2.5.29.19={text}critical:ca2' 生成的 CA **没有 CA 标志**，
 *     导致整条链无效、浏览器报 ERR_CERT_INVALID（"证书坏了"而不是"签发者不认识"）。
 *     正确写法是 '{critical}{text}ca=1'。
 *   - Remove-Item 删不掉 Root 库，只能用 certutil -delstore。
 *   - 装入后被强杀会永久残留，所以启动时必须自扫自清。
 *
 * 平台支持现状：**Windows 已实测通过**。macOS/Linux 未实测，
 * 调用方应捕获 NOT_SUPPORTED 并降级到 --no-cert-install（手动信任引导）。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { networkInterfaces, tmpdir } from 'node:os'
import { isIP } from 'node:net'
import path from 'node:path'
import { generateCerts, selfCheck as sessionSelfCheck } from './session-cert.js'
import { assertHandshake } from './session-cert-check.mjs'
import { keyUsageOf, OID_SERVER_AUTH } from './x509.js'

// 解码方向（读回 Key Usage）住在 src/x509.js —— 编码与解码放在一起，
// 而且只有这一份实现。这里转出去，是因为历史上它属于本模块的公开 API。
export { keyUsageOf }

const execFileAsync = promisify(execFile)

/**
 * 跑一个外部命令（PowerShell / certutil），**一定带超时**。
 *
 * 为什么必须带：2026-10 的 CI 第一次在 Windows 上跑，`CA 能装入信任库` 与
 * `cleanResidual` 两条用例各挂了 180 秒 —— 证书库命令**卡住不返回**，
 * 而 `execFile` 默认没有超时，于是 Promise 永远不 settle，整个测试进程只能被看门狗杀掉。
 * 卡住的原因可能是损坏的证书库、策略拦截、或某个命令在等标准输入；
 * 无论哪种，正确的表现都是**明确报错**（哪条命令、等了多久、退出码/信号是什么），
 * 而不是让调用方无限等待。
 */
const PEXEC_TIMEOUT_MS = Number(process.env.FLICKER_PEXEC_TIMEOUT_MS ?? 60_000)
async function pexec(cmd, argv, opts = {}) {
  try {
    return await execFileAsync(cmd, argv, { timeout: PEXEC_TIMEOUT_MS, ...opts })
  } catch (e) {
    const why = e?.killed ? `超过 ${PEXEC_TIMEOUT_MS} 毫秒没有返回（已强制结束）`
      : (e?.signal ? `被信号 ${e.signal} 结束` : `退出码 ${e?.code}`)
    const err = new Error(`${cmd} ${why}：${(e?.stderr || e?.message || '').toString().trim().slice(0, 300)}`)
    err.code = e?.code
    err.killed = e?.killed
    err.signal = e?.signal
    err.stderr = e?.stderr
    throw err
  }
}

/**
 * 跑 Windows PowerShell **5.1**（`powershell.exe`）时的环境变量。
 *
 * ── 为什么必须显式给 PSModulePath ──
 * 我们用它来读 `Cert:\CurrentUser\Root` / `Cert:\CurrentUser\My`
 * （`Cert:` 是 `Microsoft.PowerShell.Security` 提供的盘）。
 * 而模块是**按 PSModulePath 的顺序**解析的：谁在前面就用谁。
 *
 * 2026-10 实测踩到：从某些开发工具里启动本程序时，继承来的 PSModulePath
 * 里会**混进 PowerShell 7 的那份 Security 模块**，而且排 5.1 自己的模块目录前面。
 * 于是 5.1 去加载一个版本不兼容的模块、`Cert:` 盘根本不存在，
 * 报错是 `Cannot find drive. A drive with the name 'Cert' does not exist.` ——
 * 而这时候 `certutil` 一切正常、证书库里有 49 张证书。
 * 后果很实际：**启动时的"残留证书自扫"会失败**（约束 2 靠它）。
 *
 * 所以这里把 5.1 自己的模块目录**放到最前面**：顺序对了，就一定能解析到它自己的模块；
 * 用户自己装的模块仍然留在后面（功能不减）。
 */
function psEnv() {
  const sysDir = process.env.WINDIR
    ? path.join(process.env.WINDIR, 'system32', 'WindowsPowerShell', 'v1.0', 'Modules')
    : null
  const inherited = process.env.PSModulePath ?? ''
  const parts = [sysDir, inherited].filter(Boolean).join(';')
  return { ...process.env, PSModulePath: parts }
}

/** 所有本程序产生的证书都带这个标记，用于识别残留 */
export const CA_SUBJECT_MARK = 'Flicker Session CA'

/** 临时证书目录的统一前缀（生成与清理必须一致） */
const TEMP_CERT_PREFIX = 'flicker-cert-'

export class CertError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'CertError'
    this.code = code
  }
}

// ── 本机地址探测 ────────────────────────────────────────────

/**
 * 列出本机可用于接收端访问的 IPv4 地址。
 * 排除回环、链路本地（169.254）、以及虚拟网卡常见的无用地址。
 */
export function localIPv4() {
  const out = []
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      if (a.address.startsWith('169.254.')) continue
      out.push({ iface: name, address: a.address })
    }
  }
  // 优先常见的物理网卡命名，把虚拟网卡排后面
  const score = (n) => (/wi-?fi|ethernet|以太网|wlan|en\d|eth\d/i.test(n) ? 0 : 1)
  out.sort((a, b) => score(a.iface) - score(b.iface) || a.iface.localeCompare(b.iface))
  return out
}

/** 挑一个最像"对方能访问到"的地址 */
export function primaryIPv4() {
  const list = localIPv4()
  return list.length ? list[0].address : '127.0.0.1'
}

/**
 * IPv6 地址分类（**纯函数**，便于判据逐条钉住）。
 *
 * ── 为什么必须分类，而不是"本机有 IPv6 就全用上" ──
 *   · **链路本地** `fe80::/10`：只在同一段链路上有意义，写进链接对方也用不了
 *     （而且链接必须带 `%网卡` 作用域才可能生效，浏览器里根本没法用）
 *   · **ULA** `fc00::/7`：只在同一个组织/家庭网络内可路由，出了这个网就没意义
 *   · **回环** `::1` / 未指定 `::`：不能当对外地址
 *   · **IPv4-mapped** `::ffff:a.b.c.d`：本质还是一个 IPv4 地址，混进来只会重复
 * 只有**全局**地址才可能跨网络直连，而那正是 IPv6 唯一能带来的东西。
 * 分类结果同时决定两件事：要不要放进候选链接、要不要写进证书的 SAN。
 *
 * @param {string} addr
 * @returns {'loopback'|'linklocal'|'ula'|'global'|'unspecified'|'mapped'|'invalid'}
 */
export function classifyIPv6(addr) {
  if (typeof addr !== 'string') return 'invalid'
  const a = addr.toLowerCase().split('%')[0]          // 去掉 scope id（fe80::1%12）
  if (isIP(a) !== 6) return 'invalid'
  if (a === '::') return 'unspecified'
  if (a === '::1') return 'loopback'
  if (a.startsWith('::ffff:')) return 'mapped'
  const first = parseInt(a.split(':')[0] || '0', 16)
  if ((first & 0xffc0) === 0xfe80) return 'linklocal'   // fe80::/10
  if ((first & 0xfe00) === 0xfc00) return 'ula'         // fc00::/7
  return 'global'
}

/**
 * 列出本机**可能对别人有意义**的 IPv6 地址（全局优先，其次 ULA）。
 *
 * 回环、链路本地、未指定、IPv4-mapped 一律不进候选 —— 理由见 `classifyIPv6()`。
 */
export function localIPv6() {
  const out = []
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv6' || a.internal) continue
      const scope = classifyIPv6(a.address)
      if (scope !== 'global' && scope !== 'ula') continue
      out.push({ iface: name, address: a.address, scope })
    }
  }
  // 全局的排在 ULA 前面（它能跨网络），再按网卡名把物理网卡排前面
  const score = (n) => (/wi-?fi|ethernet|以太网|wlan|en\d|eth\d/i.test(n) ? 0 : 1)
  out.sort((a, b) => (a.scope === b.scope ? 0 : a.scope === 'global' ? -1 : 1) ||
    score(a.iface) - score(b.iface) || a.iface.localeCompare(b.iface))
  return out
}

/**
 * 把主机放进 URL 的 host 部分。**IPv6 必须用方括号**：
 *   `https://[2408:8207::1]:8443/`  —— 不加方括号时冒号会被当成"端口分隔符"，
 *   浏览器会解析成主机 `2408`、端口 `8207::1` 而直接报错。
 * IPv4 与域名原样返回；已经带方括号的不重复加。
 */
export function urlHost(host) {
  const h = String(host ?? '')
  if (!h || h.startsWith('[') || !h.includes(':')) return h
  return `[${h}]`
}

// ── Key Usage 解析 ──────────────────────────────────────────
//
// 实现住在 src/x509.js 的 `keyUsageOf()` —— 与 `keyUsage()` 编码器放在一起，
// 而且全项目**只有这一份**。
//
// ⚠️ 这里是踩过坑才这么放的：曾经 trust.js 与 session-cert.js 各写了一份解码器，
//    其中一份把 BIT STRING 的 **unused 字节当成了内容字节**，于是 CA 的
//    keyUsage 被读成空数组 —— 而自检正好靠它判 keyCertSign，结论是
//    "CA 缺少 keyCertSign"，把一张完全正确的证书判成不合格。
//    重复实现不会"多一层保险"，只会让两处以不同的姿势出错。
//
// ⚠️ 另一个实测记录（不要凭直觉改）：
//    Node 的 `X509Certificate.keyUsage` 装的是 **Extended Key Usage 的 OID 数组**
//    （例如 ["1.3.6.1.5.5.7.3.1"] = serverAuth），**Key Usage 扩展（2.5.29.15）
//    根本没有对应的属性**（证书没有 EKU 时该属性直接是 undefined）；
//    `extKeyUsage` 属性恒为 undefined。所以想检查 keyCertSign 只能自己解 DER。
//    这个坑是测试抓出来的：最初的自检拿 /Certificate Sign/ 去匹配 keyUsage，
//    而它实际是 OID 字符串，永远匹配不上。
//
// 这里转出是为了兼容历史调用方与测试 —— 它们一直从 trust.js 取这个函数。

// ── 约束 1：证书自检 ────────────────────────────────────────

/**
 * 严格校验证书。**这一步在实测中挡掉了一整类最难查的故障。**
 *
 * 现在委托给 `src/session-cert.js` 的 `selfCheck()` —— 生成与校验用同一份代码，
 * 不会再出现"生成改了、校验没跟上"的漂移。这里只负责把它的错误转成 `CertError`
 * （调用方与测试都依赖那个类型）。
 *
 * ⚠️ 名字里那个 `OrThrow` 不是装饰：它与 `session-cert.js` 的 `selfCheck()` 的
 *    **契约不同**（那边返回一份"哪几项不合格"的报告，这里不合格就抛 `CertError`）。
 *    两种契约共用一个名字，在源码目录里跑没事，**打成一个文件时就会撞名**
 *    （打包器直接拒绝构建）—— 而且调用方也分不清拿到的是报告还是异常。
 *    所以按行为各起一个名字。
 *
 * ⚠️ 关于"签发关系"的验证方式，这里记一笔代价：
 *    旧实现用 `srv.verify(ca.publicKey)` 判链，实测对纯 JS 生成的证书返回 false，
 *    而 `crypto.verify(tbs, sig, caPublicKey)` 返回 true —— 签名是对的，
 *    是那个 API 的语义与"验签名链"不同。所以**判签发关系改用真实 TLS 握手**
 *    （`assertHandshake()`，在服务起来之后跑），结构校验留在这里。
 *
 * @param {{caDer:Buffer, caPem?:string, srvPem:string, srvDer?:Buffer, srvKeyPem?:string, hosts?:string[], targetHost:string}} p
 * @throws {CertError}
 */
export function selfCheckOrThrow(p) {
  try {
    // 整个结果原样转出（含 caKeyUsage / srvKeyUsage）——
    // 调用方要能读到"哪一项不合格、实际值是什么"，只留 subject/validTo 不够诊断。
    return sessionSelfCheck({
      caDer: p.caDer,
      caPem: p.caPem,
      srvDer: p.srvDer ?? p.srvPem,
      hosts: p.hosts ?? [p.targetHost].filter(Boolean),
    }, p.targetHost)
  } catch (e) {
    throw new CertError(e.message, e.code ?? 'SELF_CHECK_FAILED')
  }
}

/**
 * 真实 TLS 握手自检（在服务已经监听之后调用）。
 *
 * 这是"证书能不能用"的**最终判据** —— 浏览器做的就是这件事：
 * 验签名链、验主机名、验有效期。比任何 X509 API 调用都更接近真实结论。
 *
 * @param {object} cert  generateSession 的返回值
 * @param {string} [targetHost]
 * @throws {CertError}
 */
export async function handshakeSelfCheck(cert, targetHost) {
  try {
    return await assertHandshake({
      srvPem: cert.srvPem, srvKeyPem: cert.srvKeyPem, caPem: cert.caPem,
    }, targetHost)
  } catch (e) {
    throw new CertError(e.message, e.code ?? 'HANDSHAKE_CHECK_FAILED')
  }
}

// ── 生成（所有平台：纯 JS）──────────────────────────────────

const isWindows = process.platform === 'win32'

/**
 * 生成会话 CA + 服务器证书。
 * 目前只有 Windows 后端（已实测）；其他平台抛 NOT_SUPPORTED，调用方应降级。
 *
 * @param {object} opts
 * @param {string[]} opts.hosts 要写进 SAN 的地址（IPv4 与主机名）
 * @param {() => void} [opts.onStep] 进度回调
 * @returns {Promise<{dir:string, caDer:Buffer, caThumbprint:string, pfx:Buffer, passphrase:string, cleanup:()=>Promise<void>}>}
 */
export async function generateSession(opts) {
  const hosts = [...new Set(opts.hosts.filter(Boolean))]
  if (hosts.length === 0) throw new CertError('没有可用地址用于生成证书', 'NO_HOST')

  // ── 纯 JS 生成（所有平台同一份实现）──────────────────────
  //
  // 从前 Windows 走 PowerShell 的 New-SelfSignedCertificate，macOS/Linux
  // 直接抛 NOT_SUPPORTED；中间还试过用 openssl 补非 Windows 平台。
  // 现在统一成纯 JS（src/session-cert.js）：零外部工具、所有平台同样结构、
  // 而且**可以在任何平台上用真实 TLS 握手验证**。
  //
  // 外部工具那条路的问题：macOS 自带的是 LibreSSL（参数与 OpenSSL 有差异）、
  // Linux 各发行版不一定装了命令行 openssl —— 每多一个平台就多一套要维护的差异，
  // 而一份纯 JS 实现没有任何这类差异。
  opts.onStep?.()

  let certs
  try {
    certs = generateCerts({ hosts })
  } catch (e) {
    throw new CertError(`证书生成失败: ${e.message}`, 'GENERATE_FAILED')
  }

  // 临时目录：仍然是"用完即销毁"的一部分（即使纯 JS 生成不落盘内容）
  const dir = await mkdtemp(path.join(tmpdir(), TEMP_CERT_PREFIX))
  const caCerPath = path.join(dir, 'ca.cer')
  await writeFile(caCerPath, certs.caDer)

  // Windows 的信任库装卸靠指纹辨认证书。
  //
  // ⚠️ 必须用 **SHA-1** 指纹（40 hex），不是 SHA-256 —— `certutil -delstore`
  //    按 SHA-1 定位证书；给它 SHA-256 时它**不报错也不删**，
  //    结果是证书留在信任库里（正是"用完即销毁"要防的事），
  //    而表面上每一步都"成功"。
  const caThumbprint = certs.caThumbprint
  const srvThumbprint = certs.srvThumbprint

  const cleanup = async () => {
    // ⚠️ 纯 JS 生成**不往证书库里放任何东西** —— 所以这里要清的比从前少：
    //    · Root 库：如果 trustCa 装过，要移除
    //    · My  库：从前 PowerShell 会把 CA 与服务器证书都放进 My，
    //              一度悄悄积累了 148 张 —— 现在不放了，但**仍然扫一遍**，
    //              因为可能是更早的版本留下的
    await untrustCa(caThumbprint)
    await removeFromMy(srvThumbprint)
    await removeFromMy(caThumbprint)
    // 临时目录：**重试两次**再认输。
    //
    // ⚠️ Windows 上刚被别的进程碰过的目录会短暂地删不掉（EPERM/EBUSY），
    //    实测偶发：上一次运行留下了一个空的 `flicker-cert-XXXX/`（用户在自己的
    //    %TEMP% 里看到的就包括这类）。"删不掉就报错"是对的，但**先重试**才算尽力 ——
    //    否则每几十次运行就会漏下一个，而下次运行要等 60 秒才会扫它。
    let lastErr = null
    for (let i = 0; i < 3; i++) {
      try {
        await rm(dir, { recursive: true, force: true })
        lastErr = null
        break
      } catch (e) {
        lastErr = e
        await new Promise((r) => setTimeout(r, 150 * (i + 1)))
      }
    }
    if (lastErr) throw lastErr      // 三次都不行就抛出去：销毁清单里会显示 ✗（不假装删了）
  }

  return {
    dir,
    hosts,
    // DER 与 PEM 都给：DER 用于跨平台比对与诊断，PEM 用于传给 tls
    caDer: certs.caDer,
    caPem: certs.caPem,
    caThumbprint,
    srvDer: certs.srvDer,
    srvPem: certs.srvPem,
    srvKeyPem: certs.srvKeyPem,
    srvThumbprint,
    // SHA-256 指纹（大写十六进制）。
    // ⚠️ 与 `srvThumbprint`（SHA-1）**不是一回事**：那个专门给 Windows 的 certutil 用。
    //    这个给人核对 —— 发送端屏幕上打印前 8 位，对方用 `flicker recv <链接>` 时核对
    //    （自签证书没有第三方背书，Node 又没有浏览器那个"继续前往"的按钮）。
    srvFingerprint: certs.srvFingerprint,
    caFingerprint: certs.caFingerprint,
    notAfter: certs.notAfter,
    // ⚠️ 不再有 pfx —— Node 没有生成 PKCS#12 的 API，而
    //    `server.listen` 本来就支持 {key, cert} 的 PEM 形式（src/server.js），
    //    所以直接用它，绕开整件事。留 null 是为了让调用方能明确察觉这个变化。
    pfx: null,
    passphrase: null,
    generatedBy: 'pure-js',
    cleanup,
  }
}

// ── 信任库操作（Windows）────────────────────────────────────

/**
 * 当前用户 Root 库里的证书数（用于测试断言与诊断）。
 *
 * ⚠️ 必须带 `-ErrorAction Stop`：`Cert:` 盘不存在时，不带它的写法会
 *    **退出码 0、stdout 是 "0"** —— 调用方会以为"证书库是空的"。
 *    实测过（2026-10，PSModulePath 被污染时）：这正是"看起来在检查、
 *    其实什么都没查到"的假阴性，本项目的头号禁忌。
 */
export async function rootStoreCount() {
  const { stdout } = await pexec('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-ChildItem Cert:\\CurrentUser\\Root -ErrorAction Stop | ' +
    'Measure-Object | Select-Object -ExpandProperty Count'],
  { windowsHide: true, env: psEnv() })
  const n = Number(stdout.trim())
  if (!Number.isInteger(n)) {
    throw new CertError(`读到的证书数不是整数：「${stdout.trim()}」`, 'STORE_UNREADABLE')
  }
  return n
}

/**
 * 当前用户 Root 库里所有由本程序装入的证书（用于约束 2）。
 *
 * ⚠️ `-ErrorAction Stop` 同样不能省：残留自扫**必须**在"读不到证书库"时失败，
 *    而不是返回空数组 —— 空了就等于告诉启动流程"没有残留"，于是那张上次
 *    异常退出留下的 CA 会一直躺在用户的信任库里。
 */
export async function findResidualCa() {
  if (!isWindows) return []
  const ps = `Get-ChildItem Cert:\\CurrentUser\\Root -ErrorAction Stop | ` +
    `Where-Object { $_.Subject -like '*${CA_SUBJECT_MARK}*' } | ` +
    `ForEach-Object { "$($_.Thumbprint)|$($_.Subject)|$($_.NotAfter.ToString('s'))" }`
  const { stdout } = await pexec('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
    { windowsHide: true, env: psEnv() })
  return stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [thumbprint, subject, notAfter] = line.split('|')
    return { thumbprint, subject, notAfter }
  })
}

/**
 * 约束 2：清理上次异常退出留下的残留证书。
 * 因为卸载只能靠 certutil，被强杀（或断电）时会残留，所以启动时必须自扫自清。
 * @returns {Promise<{removed:string[], failed:{thumbprint:string,error:string}[]}>}
 */
export async function cleanResidual() {
  const found = await findResidualCa()
  const removed = [], failed = []
  for (const c of found) {
    try {
      await pexec('certutil', ['-user', '-delstore', 'Root', c.thumbprint], { windowsHide: true })
      removed.push(c.thumbprint)
    } catch (e) {
      failed.push({ thumbprint: c.thumbprint, error: (e.stderr || e.message || '').toString().trim() })
    }
  }
  return { removed, failed }
}

/**
 * 把 CA 装进当前用户信任库。**不需要管理员权限**（已实测）。
 * @returns {Promise<boolean>} 是否成功
 */
export async function trustCa(caDer, workDir) {
  const cerPath = path.join(workDir, 'ca-to-trust.cer')
  await writeFile(cerPath, caDer)
  try {
    await pexec('certutil', ['-user', '-addstore', '-f', 'Root', cerPath], { windowsHide: true })
    return true
  } catch (e) {
    throw new CertError(
      `无法把证书装入信任库: ${(e.stderr || e.message || '').toString().trim()}\n` +
      '如果是企业策略限制，请改用 --no-cert-install。',
      'TRUST_FAILED')
  }
}

/**
 * 从信任库移除 CA。
 * ⚠️ 只能用 certutil —— Remove-Item 删不掉 Root 库
 * （实测报 "The operation is on user root store and UI is not allowed."）
 * @returns {Promise<boolean>}
 */
export async function untrustCa(thumbprint) {
  if (!thumbprint) return false
  const thumb = thumbprint.replace(/[^0-9A-Fa-f]/g, '')
  try {
    await pexec('certutil', ['-user', '-delstore', 'Root', thumb], { windowsHide: true })
    return true
  } catch {
    // 移除失败不抛错：销毁流程要继续走完，最后会报告给用户
    return false
  }
}

/** 把服务器证书与私钥从个人证书库删除 */
export async function removeServerCert(thumbprint) {
  return removeFromMy(thumbprint)
}

/**
 * 从"个人"证书库（`Cert:\CurrentUser\My`）删除一张证书。
 *
 * ⚠️ 这里踩过一个坑：`New-SelfSignedCertificate` 会把 **CA 和服务器证书
 *    都放进 My 库**。最初只清理了 Root 库里的 CA，于是 My 库里
 *    悄悄积累了 148 张 `CN=Flicker Session CA` —— 正是"用完即销毁"要防的事。
 *    所以 CA 的 My 库副本也必须删。
 */
export async function removeFromMy(thumbprint) {
  if (!thumbprint || !isWindows) return false
  const thumb = thumbprint.replace(/[^0-9A-Fa-f]/g, '')
  if (!thumb) return false
  try {
    await pexec('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-ChildItem Cert:\\CurrentUser\\My -ErrorAction Stop | ` +
      `Where-Object { $_.Thumbprint -eq '${thumb}' } | Remove-Item -Force`],
    { windowsHide: true, env: psEnv() })
    return true
  } catch { return false }
}

/** 个人证书库里所有由本程序生成的证书（用于残留清理） */
export async function findMyLeftovers() {
  if (!isWindows) return []
  // 同 findResidualCa：读不到就必须失败，不能"读不到 = 没有残留"
  const ps = `Get-ChildItem Cert:\\CurrentUser\\My -ErrorAction Stop | ` +
    `Where-Object { $_.Subject -like '*${CA_SUBJECT_MARK}*' } | ` +
    `ForEach-Object { "$($_.Thumbprint)|$($_.Subject)" }`
  // ⚠️ 这里**不吞异常**（原来是 `catch { return [] }`）。
  //    吞掉的后果和上面那条一样：读不到证书库被当成"没有残留"，
  //    于是上次异常退出留下的证书静默地留在用户机器上。
  //    调用方（启动流程）负责把它变成一句明确的告警，而不是让程序假装干净。
  const { stdout } = await pexec('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
    { windowsHide: true, env: psEnv() })
  return stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [thumbprint, subject] = line.split('|')
    return { thumbprint, subject }
  })
}

/** 个人证书库里由本程序生成的证书数量 */
export async function myLeftoverCount() {
  return (await findMyLeftovers()).length
}

/**
 * 彻底清理本程序在系统上留下的**所有**证书痕迹。
 * 覆盖两个库：Root（信任）与 My（证书本体+私钥），外加临时目录。
 * 用于启动时自愈，以及程序退出时的兜底。
 *
 * @returns {Promise<{root:string[], my:string[], failed:string[]}>}
 */
export async function cleanAllLeftovers() {
  const root = await cleanResidual()
  const mine = await findMyLeftovers()
  const removedMy = [], failed = [...root.failed.map((f) => `${f.thumbprint}: ${f.error}`)]
  for (const c of mine) {
    if (await removeFromMy(c.thumbprint)) removedMy.push(c.thumbprint)
    else failed.push(`${c.thumbprint}: 无法从个人证书库删除`)
  }
  return { root: root.removed, my: removedMy, failed }
}

/**
 * 清理遗留的临时证书目录（进程被强杀时可能残留）。
 *
 * ⚠️ 默认只清理**足够老**的目录（60 秒前创建/修改的）。
 *    原因：这个函数在启动时会被调用，而**可能同时有另一个 flicker 实例正在运行** ——
 *    它的临时证书目录就在那里。无差别清理会把别人的目录删掉，
 *    表现是"先启动的那个实例突然报找不到证书文件"。
 *    这个竞态是并行跑测试时暴露出来的（两个测试文件互相删目录），
 *    但它在真实使用中同样会发生：同一个用户先后启动两次就会撞上。
 *
 *    所以：清理要看年龄。真正"上次异常退出留下的"必然已经超过 60 秒。
 *
 * @param {object} [opts]
 * @param {number} [opts.olderThanMs] 只清理早于这个时长的目录，默认 60000
 */
export async function cleanTempDirs({ olderThanMs = 60_000 } = {}) {
  const { readdir, rm, stat } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const base = tmpdir()
  const removed = []
  let names = []
  try { names = await readdir(base) } catch { return removed }
  for (const name of names) {
    if (!name.startsWith(TEMP_CERT_PREFIX)) continue
    const full = path.join(base, name)
    try {
      if (olderThanMs > 0) {
        const st = await stat(full)
        if (Date.now() - st.mtimeMs < olderThanMs) continue
      }
      await rm(full, { recursive: true, force: true })
      removed.push(name)
    } catch { /* 删不掉就算了，不阻断 */ }
  }
  return removed
}

/** 本程序可用的证书方案摘要，用于启动时决策与 --no-cert-install 的提示 */
export function support() {
  // ⚠️ 这里要分清**两件不同的事**，混在一起会给出误导性的结论：
  //
  //   ① 证书**生成** —— 从 2026-10 起是纯 JS（src/session-cert.js），
  //      不依赖任何外部工具，也不依赖平台。而且有真实 TLS 握手作判据
  //      （test/session-cert.test.js、test/readiness.test.js），
  //      所以"全平台可用"是**已验证**的结论，不是推测。
  //   ② 把 CA 装进**系统信任库** —— 这一步是平台相关的，目前只有 Windows
  //      实测过。`supported` 说的是这一件事（run.js 用它决定要不要动证书库）。
  const generate = true
  // ⚠️ `platform` 一律用 process.platform 的原值（'win32' / 'darwin' / 'linux'），
  //    不翻译成 'windows' 之类 —— 这样它可以直接传给 manualTrustHint()。
  if (isWindows) {
    return {
      platform: 'win32',
      supported: true,
      verified: true,
      generate,
      installMethod: 'certutil',
      detail: '已实测通过（Edge 155，全模式零警告）',
    }
  }
  if (process.platform === 'darwin') {
    // 依据：`man security` / add-trusted-cert 的原文 ——
    //   "When modifying per-user Trust Settings, user authentication is required
    //    via an authentication dialog. When modifying admin Trust Settings, the
    //    process must be running as root, or admin authentication is required."
    // 也就是说 macOS 上**没有**"静默装进去"这条路：要么弹一次认证对话框，
    // 要么以 root 运行。这与本程序"启动即用、无交互"的定位直接冲突。
    return {
      platform: 'darwin',
      supported: false,
      verified: false,
      generate,
      installMethod: 'security',
      detail: 'macOS 未在真机实测。系统自带的 `security add-trusted-cert` 可用（不需要第三方工具），' +
        '但按 Apple 的说明，改用户信任设置**必须经过一次认证对话框**，改 admin 域则需要 root —— ' +
        '没有"静默生效"的选项。所以不自动启用：请用 --no-cert-install。',
    }
  }
  if (process.platform === 'linux') {
    // 依据：Chromium 官方文档 docs/linux/cert_management.md ——
    //   浏览器**不读**系统 CA 目录，而是读 NSS Shared DB
    //   （M146 起 $HOME/.local/share/pki/nssdb，之前是 $HOME/.pki/nssdb），
    //   而写入它需要 `certutil`，来自 libnss3-tools / nss-tools —— **默认不安装**。
    //   Firefox 另有自己的 profile 库。
    // 结论：Linux 上不存在"零外部依赖"的路径，所以如实报不支持。
    return {
      platform: 'linux',
      supported: false,
      verified: false,
      generate,
      installMethod: null,
      detail: 'Linux 未在真机实测，而且这里**没有零依赖的做法**：浏览器不读系统 CA 目录，' +
        '而是读 NSS 数据库（Chromium M146 起是 ~/.local/share/pki/nssdb），' +
        '写入需要 certutil（来自 libnss3-tools / nss-tools，默认不装），Firefox 还各用自己的库。' +
        '请用 --no-cert-install。',
    }
  }
  return {
    platform: process.platform,
    supported: false,
    verified: false,
    generate,
    installMethod: null,
    detail: `未在 ${process.platform} 上实测；请使用 --no-cert-install，接收端会出现一次安全提示`,
  }
}

/**
 * 手动把它装进信任库的命令（给愿意自己动手的用户）。
 *
 * 为什么不自动做：见 `support()` 里的说明 —— macOS 必然弹认证对话框、
 * Linux 必然要装额外软件包。这两件事都不该由程序在启动路径上替用户决定。
 *
 * ⚠️ 命令里的 `$HOME/.pki/nssdb` 与 `~/.local/share/pki/nssdb` 是 Chromium
 *    的**两个**路径（分界线是 M146），文档里写错过会让人白试一遍，所以都列出来。
 *    另外这里的 `certutil` 是 **NSS 的 certutil**，与 Windows 那个同名的
 *    `certutil.exe` 毫无关系 —— 名字撞车是个真实的坑。
 *
 * @param {string} [platform]
 * @returns {string[]} 给用户看的命令行（Windows 返回空数组：它已经自动装了）
 */
export function manualTrustHint(platform = process.platform) {
  const cert = '<CA 证书的 PEM 文件>'
  if (platform === 'darwin') {
    return [
      `security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db "${cert}"`,
      '（会弹一次认证对话框；去掉 -k 则写入系统钥匙串，需要 root）',
      `用 \`--machine-cert-file=${'<路径>'}\` 可以让程序把 CA 写到你要的路径`,
    ]
  }
  if (platform === 'linux') {
    return [
      '# Chromium / Chrome（需要先装 NSS 工具，默认不带）：',
      '#   Debian/Ubuntu: sudo apt install libnss3-tools',
      '#   Fedora:        sudo dnf install nss-tools',
      `certutil -d sql:$HOME/.local/share/pki/nssdb -A -t "C,," -n "${CA_SUBJECT_MARK}" -i "${cert}"`,
      '#   更早的 Chromium（M146 之前）用的是 ~/.pki/nssdb，改成那个路径即可',
      '# Firefox 用自己的 profile 库，不读上面这个，要在"证书管理器"里单独导入',
      '# 只影响 OpenSSL/curl 等系统程序（不影响浏览器）：',
      '#   sudo cp <CA PEM> /usr/local/share/ca-certificates/flicker-session-ca.crt && sudo update-ca-certificates',
    ]
  }
  return []
}

