/**
 * 清单（manifest）：扫描文件、路径安全、分块规划、完整性校验
 * ==========================================================
 * 协议见 PROTOCOL.md 第 6 章。
 *
 * 这个模块掌握着"用户的文件路径"这类敏感信息，因此有两条铁律：
 *  1. 扫描阶段**只读文件大小**，绝不读内容（内容在传输时流式读取）
 *  2. 清单在发出**之前**就被加密，所以文件名永远不会出现在网络上
 */
import { createHash } from 'node:crypto'
import { open, readdir, stat, lstat } from 'node:fs/promises'
import path from 'node:path'

const KIND = Object.freeze({
  FILE: 'file',
  GIFT_SEA: 'flicker-station-sea',       // 赠送：单文件可执行程序
  GIFT_SOURCE: 'flicker-station-source', // 赠送：源码包
})

// ── 路径安全（PROTOCOL.md §6.2 的 12 条规则）────────────────────
//
// ⚠️ 规则的**唯一实现**在 src/path-safety.js。
//    这里只做两件事：把它的错误包成调用方熟悉的样子，以及把 `windows` 的默认值
//    定成"当前平台"。
//
//    为什么单独拆出去：那份实现要被**原样内联进 web/receiver.html**
//    （`gen/inline-path-rules.mjs`），而真正决定文件落到用户磁盘上叫什么的
//    是浏览器那一份。从前两边各写一份、规则还不一样 —— 于是同一份清单在
//    测试里通过、在浏览器里丢文件。这种事只能靠"只有一份实现"来根治。
import {
  checkRelPath, safeRelPath, compareKeyOf, dedupeRelPath, findPathConflict,
  UnsafePathError, PATH_RULES, MAX_SEGMENT_BYTES, MAX_PATH_BYTES,
} from './path-safety.js'

export {
  compareKeyOf, findPathConflict, UnsafePathError, PATH_RULES,
  MAX_SEGMENT_BYTES, MAX_PATH_BYTES,
}

/**
 * 把一个来自清单的"相对路径"净化成安全的相对路径。
 * 这是**接收端的防线**：清单可能来自一台被控制的电脑，甚至被中继篡改过
 * （虽然清单有 GCM 认证，但纵深防御不嫌多）。
 *
 * @param {string} raw 清单里的路径
 * @param {object} [opts]
 * @param {boolean} [opts.windows] 是否按 Windows 规则净化（默认按当前平台）
 * @returns {string} 净化后的相对路径
 * @throws {UnsafePathError} 路径违反 §6.2 的某条规则
 */
export function sanitizeRelPath(raw, opts = {}) {
  return checkRelPath(raw, {
    windows: opts.windows ?? process.platform === 'win32',
    strict: opts.strict ?? false,
  })
}

/** 宽松版：净化不出来时返回降级结果，不抛错（发送端扫自己的文件用） */
export function sanitizeRelPathLenient(raw, opts = {}) {
  return safeRelPath(raw, {
    windows: opts.windows ?? process.platform === 'win32',
  })
}

/**
 * 处理同名冲突：a.txt → a (1).txt
 *
 * ⚠️ 比较键是 **NFC + 小写**（见 path-safety.js 的 compareKeyOf），
 *    不是裸字符串。因为 Windows/macOS 的文件系统就是这么判重的：
 *    `A.txt` 与 `a.txt`、`café`(NFC) 与 `café`(NFD) 在那边都是同一个文件。
 *    用裸字符串比较，发送端会认为"不冲突"，接收端却只写出一个。
 */
export function dedupePath(relPath, taken) {
  return dedupeRelPath(relPath, taken)
}

// ── 扫描 ───────────────────────────────────────────────────

/** 人类可读的大小 */
export function formatSize(n) {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB', 'PB']
  let v = n / 1024, i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

/**
 * 扫描用户给出的路径，产出一个**未加密**的清单（含明文相对路径）。
 * 只读元数据，不读内容。
 *
 * @param {string[]} inputs 文件或目录路径
 * @param {object} [opts]
 * @param {number} [opts.chunkBytes]
 * @param {(msg:string)=>void} [opts.onWarn]
 * @returns {Promise<{files:Array, totalBytes:number, totalChunks:number}>}
 */
export async function scan(inputs, opts = {}) {
  const chunkBytes = opts.chunkBytes ?? (1 << 20)
  const onWarn = opts.onWarn ?? (() => {})
  const files = []
  const taken = new Set()

  for (const [srcIndex, input] of inputs.entries()) {
    const abs = path.resolve(input)
    let st
    try { st = await lstat(abs) } catch { throw new Error(`路径不存在或不可访问: ${input}`) }

    if (st.isSymbolicLink()) {
      // 不跟随符号链接：避免把链接指向的任意位置也发出去，也避免循环
      onWarn(`跳过符号链接: ${input}`)
      continue
    }
    if (st.isDirectory()) {
      const base = path.basename(abs)
      await walkDir(abs, base, files, taken, chunkBytes, onWarn, srcIndex)
    } else if (st.isFile()) {
      addFile(files, taken, path.basename(abs), abs, st.size, chunkBytes, KIND.FILE, srcIndex)
    } else {
      onWarn(`跳过非普通文件: ${input}`)
    }
  }

  if (files.length === 0) throw new Error('没有可发送的文件')

  // 分配序号与全局块序号
  let globalChunk = 0
  files.forEach((f, i) => {
    f.index = i
    f.firstChunk = globalChunk
    globalChunk += f.chunks
  })

  const totalBytes = files.reduce((s, f) => s + f.size, 0)
  return { files, totalBytes, totalChunks: globalChunk }
}

async function walkDir(dirAbs, relPrefix, files, taken, chunkBytes, onWarn, srcIndex) {
  let entries
  try { entries = await readdir(dirAbs, { withFileTypes: true }) } catch (e) {
    onWarn(`无法读取目录 ${dirAbs}: ${e.code}`); return
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))   // 稳定顺序，便于复现
  for (const ent of entries) {
    const childAbs = path.join(dirAbs, ent.name)
    const childRel = `${relPrefix}/${ent.name}`
    if (ent.isSymbolicLink()) { onWarn(`跳过符号链接: ${childRel}`); continue }
    if (ent.isDirectory()) {
      await walkDir(childAbs, childRel, files, taken, chunkBytes, onWarn, srcIndex); continue
    }
    if (!ent.isFile()) { onWarn(`跳过特殊文件: ${childRel}`); continue }
    let st
    try { st = await stat(childAbs) } catch { onWarn(`无法读取: ${childRel}`); continue }
    addFile(files, taken, childRel, childAbs, st.size, chunkBytes, KIND.FILE, srcIndex)
  }
}

/**
 * @param {number} srcIndex 这个文件来自 `inputs` 里的第几项。
 *
 * ⚠️ 界面要按"用户加进来的那一个东西"分组显示（加了一个文件夹 → 列表里显示
 *    文件夹的名字，点开看里面）。从前只能靠 `rel` 的第一段去猜是哪个输入，
 *    而两个同名的输入（比如两张卡里各有一个 `照片`）会被去重改名，猜错就串组。
 *    记下序号是唯一可靠的做法。
 *
 * 这个字段是**本地字段**，和 `absPath` 一样不会进清单（见 toWire）。
 */
function addFile(files, taken, relPath, absPath, size, chunkBytes, kind, srcIndex = 0) {
  // 发送端用自己的平台规则净化：在 Linux 上 `a:b.txt` 是正常名字，
  // 不该被提前改掉；真到了 Windows 接收端，由那边按 Windows 规则改写（见 path-safety.js）
  const safe = sanitizeRelPathLenient(relPath)
  const rel = dedupePath(safe, taken)
  const chunks = size === 0 ? 1 : Math.ceil(size / chunkBytes)   // 空文件也占一块
  files.push({
    kind,
    name: path.posix.basename(rel),
    rel,
    size,
    chunks,
    chunkBytes,
    sha256: null,     // 传输前由 hashFile 填充
    absPath,          // 仅发送端内存中存在，绝不进清单
    srcIndex,         // 来自第几个输入（界面上按它分组），同样不进清单
  })
}

// ── 完整性 ─────────────────────────────────────────────────

/**
 * 顺序读取整个文件，产出整体 SHA-256 与逐块 SHA-256。
 *
 * 完整性证据的构成（PROTOCOL.md §6.4）：
 *   整体 SHA-256  = 文件内容的最终指纹（接收端收完比对）
 *   逐块 SHA-256  = 明文块的指纹，用于断点续传后定位损坏的块
 * 二者都是对**明文**计算的，所以接收端解密后就能验证。
 *
 * 逐块哈希表会随清单一起加密下发（体积约为文件大小的 1/32768，可忽略）。
 *
 * @param {string} absPath
 * @param {number} chunkBytes
 * @param {(done:number,total:number)=>void} [onProgress]
 * @returns {Promise<{sha256:string, chunkHashes:string[]}>}
 */
export async function hashFile(absPath, chunkBytes, onProgress) {
  const fh = await open(absPath, 'r')
  try {
    const whole = createHash('sha256')
    const chunkHashes = []
    const buf = Buffer.allocUnsafe(chunkBytes)
    let done = 0
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, chunkBytes, null)
      if (bytesRead === 0) {
        if (done === 0) {                       // 空文件：整体哈希为空输入的哈希
          chunkHashes.push(createHash('sha256').update(Buffer.alloc(0)).digest('hex'))
        }
        break
      }
      const slice = buf.subarray(0, bytesRead)
      whole.update(slice)
      chunkHashes.push(createHash('sha256').update(slice).digest('hex'))
      done += bytesRead
      onProgress?.(done, null)
    }
    return { sha256: whole.digest('hex'), chunkHashes }
  } finally {
    await fh.close()
  }
}

/** 为一个文件补上完整性信息 */
export async function fillHashes(manifest, onProgress) {
  const total = manifest.totalBytes
  let acc = 0
  for (const f of manifest.files) {
    const { sha256, chunkHashes } = await hashSource(f, (d) => onProgress?.(acc + d, total))
    f.sha256 = sha256
    f.chunkHashes = chunkHashes
    acc += f.size
  }
  return manifest
}

/**
 * 对一个"内容来源"计算整体哈希与逐块哈希。
 * 来源有两种：
 *   磁盘文件（absPath）—— 正常文件，以及单文件形态的赠品
 *   内存缓冲（_bytes）—— 源码形态的赠品包，本来就在内存里
 * 两种都要走同一套哈希逻辑，保证接收端的校验口径一致。
 */
async function hashSource(src, onProgress) {
  if (src.absPath) return hashFile(src.absPath, src.chunkBytes, onProgress)
  if (src._bytes) return hashBuffer(src._bytes, src.chunkBytes, onProgress)
  throw new Error(`文件 ${src.rel ?? '?'} 既没有磁盘路径也没有内存内容，无法计算校验值`)
}

/** 对内存缓冲算哈希；分块方式必须与 hashFile 完全一致 */
export function hashBuffer(buf, chunkBytes, onProgress) {
  const whole = createHash('sha256')
  const chunkHashes = []
  if (buf.length === 0) {
    chunkHashes.push(createHash('sha256').update(Buffer.alloc(0)).digest('hex'))
  } else {
    for (let off = 0; off < buf.length; off += chunkBytes) {
      const slice = buf.subarray(off, Math.min(off + chunkBytes, buf.length))
      whole.update(slice)
      chunkHashes.push(createHash('sha256').update(slice).digest('hex'))
      onProgress?.(Math.min(off + chunkBytes, buf.length), null)
    }
  }
  if (buf.length === 0) whole.update(Buffer.alloc(0))
  return { sha256: whole.digest('hex'), chunkHashes }
}

// ── 清单的序列化（不含 absPath —— 那是发送端内部字段）────────

/** 转成可以加密下发的形式。刻意剔除 absPath 等本地字段。 */
export function toWire(manifest, extra = {}) {
  return {
    v: 1,
    suite: 'FLICKER/1',
    ...extra,
    files: manifest.files.map((f) => ({
      kind: f.kind,
      name: f.name,
      rel: f.rel,
      size: f.size,
      chunks: f.chunks,
      chunkBytes: f.chunkBytes,
      sha256: f.sha256,
      chunkHashes: f.chunkHashes,
    })),
    totalBytes: manifest.totalBytes,
    totalChunks: manifest.totalChunks,
  }
}

/** 从线上形式恢复成可用对象 */
export function fromWire(wire) {
  if (!wire || wire.v !== 1) throw new Error('清单版本不支持')
  if (!Array.isArray(wire.files) || wire.files.length === 0) throw new Error('清单为空')
  // ⚠️ 接收端一律用 **strict**：这是一份**不可信输入**。
  //    它可能来自一台被控制的电脑，也可能被中继改过（虽有 GCM 认证，纵深防御不嫌多）。
  const win = process.platform === 'win32'
  const files = wire.files.map((f, i) => {
    const rel = checkRelPath(f.rel, { windows: win, strict: true })
    if (!Number.isInteger(f.size) || f.size < 0) throw new Error(`文件 ${rel} 的大小非法`)
    if (!Number.isInteger(f.chunks) || f.chunks < 1) throw new Error(`文件 ${rel} 的块数非法`)
    return { ...f, rel, index: i, firstChunk: 0 }
  })
  // R12：**开传之前**就查冲突。合并后的路径可能撞在一起
  // （大小写只差、NFC/NFD 只差、或 Windows 上非法字符被改写后撞车），
  // 而落盘时后写的会**静默覆盖**先写的 —— 用户看到"完成"，却少了一个文件。
  const conflict = findPathConflict(files.map((f) => f.rel))
  if (conflict) {
    throw Object.assign(new Error(
      `清单里有两条路径落盘后会撞在一起：${conflict.paths.join(' 与 ')}\n` +
      '    它们在你这个系统上会是**同一个文件**，继续写会静默覆盖掉一个。' +
      '已中止，以免丢了文件还不知道。'), {
      code: 'E_MANIFEST_DUPLICATE_PATH', fatal: true, key: conflict.key,
    })
  }
  let g = 0
  for (const f of files) { f.firstChunk = g; g += f.chunks }
  return { ...wire, files, totalChunks: g }
}

/** 清单的概览，用于终端/界面展示 */
export function summarize(wire) {
  const dirs = new Set()
  for (const f of wire.files) {
    const d = path.posix.dirname(f.rel)
    if (d !== '.') dirs.add(d)
  }
  return {
    fileCount: wire.files.length,
    dirCount: dirs.size,
    totalBytes: wire.totalBytes,
    totalChunks: wire.totalChunks,
    largest: wire.files.reduce((a, b) => (a.size >= b.size ? a : b)),
  }
}
