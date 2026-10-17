/**
 * 路径安全规则（PROTOCOL.md §6.2）
 * =================================
 *
 * ⚠️ **这个文件必须在浏览器里也能跑。**
 *    不许 import `node:path`、不许用 Buffer、不许用任何 Node 专有的东西 ——
 *    它会被 `gen/inline-path-rules.mjs` **原样内联**进 web/receiver.html。
 *
 * ── 为什么要单独一份、还要内联 ────────────────────────────────
 *
 * 从前路径规则有**两份实现**，而且不一样：
 *   · `src/manifest.js`：12 条规则基本齐（R1–R12）
 *   · `web/receiver.html`：只有一行 `replace(/[<>:"|?*\x00-\x1f]/g, '_')`
 *
 * 而**真正决定文件落到用户磁盘上哪个名字的，是浏览器那一份**。
 * 于是下面这些情况在真实使用中会出事（都不是"恶意清单"，普通用户就能撞上）：
 *
 *   · Linux 发来名为 `CON.txt` / `NUL` 的文件 → Windows 上创建失败
 *   · Linux 发来 `name.`（结尾是点）→ Windows 静默丢掉那个点，两个文件变成同一个
 *   · 清单里同时有 `a:b.txt` 与 `a_b.txt` → 改写后同名 → **静默覆盖，丢一个文件**
 *   · macOS 上 `café`（NFC）与 `café`（NFD）是同一个文件 → 同样静默覆盖
 *   · 大小写只差的两个名字（`A.txt` / `a.txt`）→ Windows/macOS 上同一个文件
 *
 * 最后两条正是 PROTOCOL.md §6.2 里挂着的「**待验证**：macOS 的 NFD/NFC 可能导致
 * 同名文件冲突」。现在它不再待验证了：**比较用的键一律先做 NFC 规范化 + 大小写折叠**，
 * 并且接收端在**开传之前**就把冲突查出来、直接拒绝，而不是传到一半再覆盖。
 *
 * 一份实现 + 内联（`gen/inline-path-rules.mjs --check` 守住同步），
 * 就不会再出现"两边规则不一样"这种事。
 */

/** 规则的机器可读编号 → 人能看懂的一句话 */
export const PATH_RULES = {
  R1: '非绝对路径',
  R2: '非盘符路径',
  R3: '非 UNC 路径',
  R4: '无上跳（..）',
  R5: '无当前目录段（.）',
  R6: '无 NUL 字节',
  R7: '长度合法',
  R8: '非 Windows 保留设备名',
  R9: '无 Windows 非法字符',
  R10: '不以空格或点结尾',
  R11: '分隔符统一为 /',
  R12: '无重复路径',
}

/** 路径不安全。`rule` 说明违反了哪一条，`fatal` 一律为 true（协议要求中止整个会话） */
export class UnsafePathError extends Error {
  constructor(rule, message, input) {
    super(message)
    this.name = 'UnsafePathError'
    this.code = 'E_PATH_UNSAFE'
    this.rule = rule
    this.fatal = true
    this.input = input
  }
}

/** Windows 保留设备名。带扩展名也算（`CON.txt` 同样打不开） */
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i
/** Windows 非法字符 */
const WIN_ILLEGAL = /[<>:"|?*]/
/** 单个路径段的最大字节数（多数文件系统的硬限制是 255 字节） */
export const MAX_SEGMENT_BYTES = 255
/** 整体路径的最大字节数（协议 R7） */
export const MAX_PATH_BYTES = 4096

/**
 * 比较两个路径段时用的键。
 *
 * ⚠️ 三件事缺一不可，每一件都对应一种真实的丢文件方式：
 *   ① `normalize('NFC')` —— macOS 上是 NFD，别处可能是 NFC，
 *      不规范化就会把同一个文件认成两个（然后后者覆盖前者）
 *   ② `toLowerCase()` —— Windows 与 macOS 默认大小写不敏感，
 *      `A.txt` 与 `a.txt` 在那边是同一个文件
 *   ③ 只用于**比较**，不改写要写盘的名字（用户看到的名字应当原样保留）
 */
export function compareKey(seg) {
  // normalize 在个别老环境里可能缺失 —— 缺了就退化成原样比较，
  // 而不是抛错把整条路堵死（宁可少一层保护，也不能发不出文件）
  const s = typeof seg?.normalize === 'function' ? seg.normalize('NFC') : String(seg ?? '')
  return s.toLowerCase()
}

/** 整个相对路径的比较键 */
export function compareKeyOf(relPath) {
  return relPath.split('/').map(compareKey).join('/')
}

/** UTF-8 字节数（浏览器里没有 Buffer，用 TextEncoder） */
export function utf8Bytes(s) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length
  // 极老的兜底：非 ASCII 一律按 3 字节乐观估计（只用于长度判断）
  let n = 0
  for (const ch of s) n += ch.codePointAt(0) < 0x80 ? 1 : 3
  return n
}

// ── 极简 posix 路径工具（浏览器里没有 node:path）─────────────

export function posixDirname(p) {
  const i = p.lastIndexOf('/')
  return i < 0 ? '.' : (i === 0 ? '/' : p.slice(0, i))
}

export function posixBasename(p) {
  const i = p.lastIndexOf('/')
  return i < 0 ? p : p.slice(i + 1)
}

/** 扩展名（含点）；没有扩展名时返回 ''。与 node:path.posix.extname 同语义 */
export function posixExtname(p) {
  const base = posixBasename(p)
  const i = base.lastIndexOf('.')
  if (i <= 0) return ''
  return base.slice(i)
}

// ── 规则本体 ────────────────────────────────────────────────

/**
 * 校验并净化一个来自**不可信输入**的相对路径。
 *
 * 两种模式，差别**只有一处**（这一点刻意做小，免得"两种模式"变成两套规则）：
 *
 *   · `strict: false`（**发送端**扫自己的文件）：裸的 `.` 段直接折叠掉。
 *     用户输入的 `./dir/a.txt` 是很自然的东西，没必要因此发不出去。
 *   · `strict: true`（**接收端**校验清单）：裸的 `.` 段按协议 R5 直接拒绝。
 *     发送端从不产生这种段，所以拒绝它不影响任何正常传输，只挡住手工构造的清单。
 *
 * **R9（非法字符）与 R10（结尾的点/空格）在两种模式下都是"改写"而不是"拒绝"** ——
 * 这是想清楚才这么定的：Linux/macOS 上 `a:b.txt`、`report.` 都是合法文件名，
 * 发送端按自己的平台规则看它们是正常的，于是原样写进清单。若接收端（Windows）
 * 直接拒绝，一次**完全正常的传输**就会整个失败。所以接管方式是就地改写，
 * 改写的**后果**（可能撞名）由 R12 的冲突检查兜住。
 *
 * @param {string} raw
 * @param {object} [opts]
 * @param {boolean} [opts.windows] 是否按 Windows 的规则（保留名、非法字符、结尾）
 * @param {boolean} [opts.strict]
 * @param {boolean} [opts.normalize] 是否把结果统一成 NFC（默认 true）
 * @returns {string} 净化后的相对路径
 */
export function checkRelPath(raw, opts = {}) {
  const win = opts.windows ?? false
  const strict = opts.strict ?? false
  const doNormalize = opts.normalize ?? true

  if (typeof raw !== 'string' || raw.length === 0) {
    throw new UnsafePathError('R6', '路径必须是非空字符串', raw)
  }
  if (raw.includes('\0')) throw new UnsafePathError('R6', '路径含空字节', raw)

  // ① 先归一化分隔符，再判断"是不是绝对路径" —— 顺序反了会被 a/./../b 这类输入绕过
  let p = raw.replace(/\\/g, '/')

  // ② 绝对路径 / 盘符 / UNC
  if (p.startsWith('//')) throw new UnsafePathError('R3', `拒绝 UNC 路径: ${raw}`, raw)
  if (p.startsWith('/')) throw new UnsafePathError('R1', `拒绝绝对路径: ${raw}`, raw)
  // ⚠️ 盘符的判据是「单个字母 + 冒号 + 斜杠或结尾」。
  //    只看"有没有冒号"会把 `a:b.txt` 误判成盘符 —— 而它是合法的文件名
  //    （NTFS 交替数据流），实测很常见。
  if (/^[a-zA-Z]:([/\\]|$)/.test(p)) throw new UnsafePathError('R2', `拒绝盘符路径: ${raw}`, raw)

  // ③ 逐段
  const parts = []
  for (let seg of p.split('/')) {
    if (seg === '') continue                                  // 折叠空段（a//b）
    if (seg === '.') {
      if (strict) throw new UnsafePathError('R5', `拒绝当前目录段: ${raw}`, raw)
      continue
    }
    if (seg === '..') throw new UnsafePathError('R4', `拒绝路径穿越: ${raw}`, raw)

    if (doNormalize && typeof seg.normalize === 'function') seg = seg.normalize('NFC')

    if (win && WIN_RESERVED.test(seg)) {
      // 保留名**不能**靠改名绕过：CON → _CON 会让用户以为收到了 `CON`，
      // 而那个文件在 Windows 上根本打不开。直接报错、说清原因。
      throw new UnsafePathError('R8', `拒绝 Windows 保留设备名: ${seg}（这类名字在 Windows 上无法创建）`, raw)
    }
    if (win) {
      // 非法字符：改写，不拒绝（见上面的说明）
      if (WIN_ILLEGAL.test(seg)) seg = seg.replace(/[<>:"|?*]/g, '_')
      // 结尾的点与空格在 Windows 上会被**静默丢弃**：`a.` 与 `a` 变成同一个文件
      const trimmed = seg.replace(/[. ]+$/, '')
      if (trimmed !== seg) seg = trimmed || '_'
    }
    if (utf8Bytes(seg) > MAX_SEGMENT_BYTES) {
      throw new UnsafePathError('R7',
        `单个路径段超过 ${MAX_SEGMENT_BYTES} 字节: ${seg}（${utf8Bytes(seg)} 字节）`, raw)
    }
    parts.push(seg)
  }

  if (parts.length === 0) throw new UnsafePathError('R5', `路径净化后为空: ${raw}`, raw)

  const rel = parts.join('/')
  if (utf8Bytes(rel) > MAX_PATH_BYTES) {
    throw new UnsafePathError('R7', `整体路径超过 ${MAX_PATH_BYTES} 字节: ${raw}`, raw)
  }
  return rel
}

/**
 * 宽松版：只净化、不抛错（发送端扫描自己的文件时用）。
 * 真的净化不出来时**也要给一个安全的降级结果**。
 *
 * ⚠️ 降级路径本身必须也是安全的 —— 这里曾经写成
 *    `raw.replace(/\\/g,'/').replace(/^\/+/,'')`，把 `../../evil.txt` 原样返回。
 *    也就是说"安全函数"在兜底时吐出了一个穿越路径。**降级不等于放弃检查**：
 *    兜底这段照样要把 `..`、`.`、空段去掉。
 */
export function safeRelPath(raw, opts = {}) {
  try {
    return checkRelPath(raw, { ...opts, strict: false })
  } catch {
    const cleaned = String(raw ?? '')
      .replace(/\\/g, '/')
      .split('/')
      .filter((s) => s !== '' && s !== '.' && s !== '..')
      .join('/')
      .replace(/^\/+/, '')
    return cleaned || 'unnamed'
  }
}

/**
 * R12：在**开传之前**找出"落盘后会撞在一起"的路径。
 *
 * 这一步是防**静默覆盖**的关键。比较用的是 `compareKeyOf`（NFC + 大小写折叠），
 * 因为 Windows/macOS 的默认文件系统就是这样判重的：
 * 两个不同的清单条目在那边会变成同一个文件，后写的把先写的覆盖掉 ——
 * 用户看到"传输完成"，却少了一个文件，而且没有任何提示。
 *
 * @param {string[]} relPaths 已净化过的相对路径
 * @returns {{key:string, paths:string[]}|null} 第一组冲突；没有冲突返回 null
 */
export function findPathConflict(relPaths) {
  const seen = new Map()
  for (const p of relPaths) {
    const key = compareKeyOf(p)
    if (seen.has(key)) {
      const hit = seen.get(key)
      if (hit === p) return { key, paths: [hit, p], exact: true }
      return { key, paths: [hit, p], exact: false }
    }
    seen.set(key, p)
  }
  return null
}

/**
 * 发送端用：为 `relPath` 找一个不与 `taken` 冲突的名字。
 * `a.txt` → `a (1).txt`。`taken` 里放的是 `compareKeyOf` 的结果。
 */
export function dedupeRelPath(relPath, taken) {
  const key = compareKeyOf(relPath)
  if (!taken.has(key)) { taken.add(key); return relPath }
  const dir = posixDirname(relPath)
  const ext = posixExtname(relPath)
  const base = posixBasename(relPath).slice(0, posixBasename(relPath).length - ext.length)
  for (let i = 1; i < 10000; i++) {
    const cand = `${dir === '.' ? '' : dir + '/'}${base} (${i})${ext}`
    const ck = compareKeyOf(cand)
    if (!taken.has(ck)) { taken.add(ck); return cand }
  }
  throw new Error(`无法为 ${relPath} 找到不冲突的名字`)
}
