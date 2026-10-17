/**
 * 最小 ZIP 写入器（零依赖）
 * ==========================
 *
 * ── 为什么需要自己写 ──
 * Node **没有**写 ZIP 容器的内置模块：`node:zlib` 只给 deflate 压缩流，
 * 不管 ZIP 的头、中央目录、CRC-32。而这个项目的要求是**零运行时依赖**
 * （`gen/check-no-deps.mjs` 守着），构建期也只允许 postject 一个第三方工具。
 *
 * 而 ZIP 是这个发布场景**唯一**合理的格式：产物是 94 MB 的 exe，
 * gzip 之后 36 MB（38%），但 Windows 用户**打不开 `.gz`**，
 * 而 `.zip` 双击就能解压。少这 62% 的下载量对"发给别人"这件事很实在。
 *
 * ── 只支持我们要用的那一小块（刻意不通用）──
 *   · 单个或多个**文件**条目（不支持目录、符号链接、加密、zip64）
 *   · deflate 或 store
 *   · **不写 data descriptor**：压缩结果先在内存里攒着（94 MB → 36 MB，可控），
 *     这样头部可以一次写对，不用处理"边写边回填长度"那套容易错的逻辑
 *   · 单文件 > 4 GiB 会抛错（那时候需要 zip64，本项目用不上）
 *
 * ── 可复现（很重要）──
 * ZIP 头里有"修改时间"字段。若写进当前时间，**同一份源码构建两次会得到不同的 zip**，
 * 而这个项目的发布说明写着"可复现构建"（`test/build-sea.test.js` 钉着那条）。
 * 所以这里的时间戳是**固定常量**（1980-01-01 00:00:00，ZIP 的纪元零点），
 * 条目顺序按调用方给的顺序，不写任何额外字段。
 *
 * 用法：
 *   import { writeZip, crc32, Crc32 } from './zip.mjs'
 *   await writeZip('out.zip', [{ name: 'a.exe', path: 'dist/a.exe', mode: 0o755 }])
 */
import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { once } from 'node:events'
import { createDeflateRaw, inflateRawSync } from 'node:zlib'

/** ZIP 的纪元：1980-01-01 00:00:00（DOS 时间格式能表示的最早时刻） */
const DOS_TIME = 0
const DOS_DATE = 0x0021          // 年 = 1980-1980 = 0，月 = 1，日 = 1

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50

/** 通用位标记：bit 11 = 文件名是 UTF-8。我们的文件名是 ASCII，但声明一下更正确 */
const FLAG_UTF8 = 0x0800

/** 版本号：20 = 2.0（deflate 需要的最低版本） */
const VERSION = 20

export const MAX_ENTRY_BYTES = 0xffffffff     // 单条 4 GiB，超出需要 zip64

/**
 * 增量 CRC-32（IEEE 802.3，ZIP 用的那个）。
 *
 * ⚠️ 为什么不用 `zlib.crc32()`：它**只能一次算完整个 buffer**，而我们要流式读 94 MB
 *    的文件（不想把明文整个读进内存）。所以自己实现，并在 `test/zip.test.js` 里
 *    **拿 `zlib.crc32` 当参照**逐个长度比对 —— 自己写的校验和必须有独立判据。
 */
const TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    t[i] = c >>> 0
  }
  return t
})()

export class Crc32 {
  constructor() { this.c = 0xffffffff }
  /** @param {Buffer|Uint8Array} buf */
  update(buf) {
    let c = this.c
    for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
    this.c = c
    return this
  }
  /** @returns {number} 无符号 32 位 */
  digest() { return (this.c ^ 0xffffffff) >>> 0 }
}

/** 一次性 CRC-32（与 `zlib.crc32` 应当逐位相同） */
export function crc32(buf) { return new Crc32().update(buf).digest() }

/** 把一个数值写成 ZIP 的小端字段（放进给定的 buffer 偏移处） */
function u16(buf, off, v) { buf.writeUInt16LE(v & 0xffff, off) }
function u32(buf, off, v) { buf.writeUInt32LE(v >>> 0, off) }

/**
 * 读回一个 ZIP（**严格模式**：CRC 与长度不对就抛错）。
 *
 * 为什么写入器还要配一个读取器：`gen/release.mjs --check` 要能回答
 * "发布包里那个 zip 里装的**确实**是 dist/ 里这一版产物吗" ——
 * 只比 zip 文件自己的哈希只能证明"zip 没被改过"，证明不了它装的是**对的那个东西**。
 *
 * ⚠️ 自己写的读取器不能当**唯一**判据（写错的方式可能一致）：真实解压工具的验证在
 *    `_lab/verify-zip.mjs`（Windows `Expand-Archive` / `unzip`），
 *    独立解析器在 `test/zip.test.js`。
 *
 * @param {Buffer} buf
 * @returns {{name:string, method:number, crc:number, compSize:number, rawSize:number, externalAttrs:number, data:Buffer}[]}
 */
export function readZipEntries(buf) {
  const eocd = buf.length - 22
  if (eocd < 0 || buf.readUInt32LE(eocd) !== SIG_EOCD) throw new Error('不是 ZIP（找不到 EOCD）')
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  const out = []
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== SIG_CENTRAL) throw new Error(`第 ${i} 条中央目录签名不对`)
    const method = buf.readUInt16LE(off + 10)
    const crc = buf.readUInt32LE(off + 16)
    const compSize = buf.readUInt32LE(off + 20)
    const rawSize = buf.readUInt32LE(off + 24)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const externalAttrs = buf.readUInt32LE(off + 38)
    const localOff = buf.readUInt32LE(off + 42)
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8')

    if (buf.readUInt32LE(localOff) !== SIG_LOCAL) throw new Error(`${name}: 本地头签名不对`)
    const dataStart = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28)
    const comp = buf.subarray(dataStart, dataStart + compSize)
    const data = method === 0 ? Buffer.from(comp) : inflateRawSync(comp)
    if (data.length !== rawSize) throw new Error(`${name}: 解出来 ${data.length} 字节，头部声明 ${rawSize}`)
    const got = new Crc32().update(data).digest()
    if (got !== crc) throw new Error(`${name}: CRC 不符（头部 ${crc.toString(16)}，实际 ${got.toString(16)}）`)

    out.push({ name, method, crc, compSize, rawSize, externalAttrs, data })
    off += 46 + nameLen + extraLen + commentLen
  }
  return out
}

/**
 * 读一个文件，边读边算 CRC，并用 deflate 压到内存里。
 * @returns {Promise<{crc:number, rawSize:number, deflated:Buffer[]}>}
 */
async function deflateFile(filePath, level) {
  const src = createReadStream(filePath)
  const def = createDeflateRaw({ level })
  const deflated = []
  def.on('data', (c) => deflated.push(c))

  const crc = new Crc32()
  let rawSize = 0
  try {
    for await (const chunk of src) {
      rawSize += chunk.length
      crc.update(chunk)
      if (!def.write(chunk)) await once(def, 'drain')
    }
  } catch (e) {
    src.destroy()
    def.destroy()
    throw e
  }
  def.end()
  await once(def, 'end')
  return { crc: crc.digest(), rawSize, deflated }
}

/**
 * 写一个 ZIP。
 *
 * @param {string} outPath
 * @param {{name:string, path?:string, data?:Buffer, mode?:number}[]} entries
 *   `path` = 从磁盘读（流式，推荐）；`data` = 直接用内存里的字节（测试与小块用）
 * @param {{level?:number}} [opts]
 * @returns {Promise<{bytes:number, entries:{name:string,rawSize:number,compSize:number,crc:number}[]}>}
 */
export async function writeZip(outPath, entries, { level = 6 } = {}) {
  if (!entries?.length) throw new Error('writeZip: 至少要有一个条目')

  const fh = await open(outPath, 'w')
  try {
    const locals = []
    const centrals = []
    let offset = 0
    const report = []

    for (const e of entries) {
      if (typeof e.name !== 'string' || !e.name) throw new Error('writeZip: 条目缺少 name')
      const nameBuf = Buffer.from(e.name, 'utf8')
      if (nameBuf.length > 0xffff) throw new Error(`writeZip: 文件名太长（${nameBuf.length} 字节）`)

      let crc, rawSize, deflated
      if (e.data) {
        const c = new Crc32().update(e.data)
        const d = createDeflateRaw({ level })
        const chunks = []
        d.on('data', (x) => chunks.push(x))
        d.end(e.data)
        await once(d, 'end')
        crc = c.digest(); rawSize = e.data.length; deflated = chunks
      } else {
        ({ crc, rawSize, deflated } = await deflateFile(e.path, level))
      }

      if (rawSize > MAX_ENTRY_BYTES) {
        throw new Error(`writeZip: ${e.name} 有 ${rawSize} 字节，超过 4 GiB —— 需要 zip64，本写入器不支持`)
      }
      const compSize = deflated.reduce((n, c) => n + c.length, 0)
      // ⚠️ 只有**手上有明文**时才能选 store：从磁盘读的条目此刻只有压缩结果，
      //    要 store 就得再读一遍文件。而压缩几乎不会变大（deflate 对压不动的数据
      //    会自己退化成 stored block），所以磁盘条目一律 deflate。
      const stored = Boolean(e.data) && compSize >= rawSize
      const payload = stored ? [e.data] : deflated
      const method = stored ? 0 : 8
      const dataSize = stored ? rawSize : compSize

      // 解压后的权限位：macOS/Linux 上 `unzip` 靠它决定可执行位。
      // 不写这条的话，解出来的二进制**没有执行权限** —— 用户会看到 "Permission denied"，
      // 而错误信息离"打包时少写了一个字段"十万八千里。
      const mode = e.mode ?? 0o644
      const externalAttrs = ((mode & 0xffff) << 16) >>> 0

      const local = Buffer.alloc(30 + nameBuf.length)
      u32(local, 0, SIG_LOCAL)
      u16(local, 4, VERSION)
      u16(local, 6, FLAG_UTF8)
      u16(local, 8, method)
      u16(local, 10, DOS_TIME)
      u16(local, 12, DOS_DATE)
      u32(local, 14, crc)
      u32(local, 18, dataSize)
      u32(local, 22, rawSize)
      u16(local, 26, nameBuf.length)
      u16(local, 28, 0)
      nameBuf.copy(local, 30)
      locals.push({ header: local, payload })

      const central = Buffer.alloc(46 + nameBuf.length)
      u32(central, 0, SIG_CENTRAL)
      // 高字节 3 = UNIX（这样上面的 externalAttrs 权限位才会被 unzip 认；Windows 忽略它）
      u16(central, 4, (3 << 8) | VERSION)
      u16(central, 6, VERSION)
      u16(central, 8, FLAG_UTF8)
      u16(central, 10, method)
      u16(central, 12, DOS_TIME)
      u16(central, 14, DOS_DATE)
      u32(central, 16, crc)
      u32(central, 20, dataSize)
      u32(central, 24, rawSize)
      u16(central, 28, nameBuf.length)
      u16(central, 30, 0)          // extra
      u16(central, 32, 0)          // comment
      u16(central, 34, 0)          // disk number
      u16(central, 36, 0)          // internal attrs
      u32(central, 38, externalAttrs)
      // ⚠️ 这里必须是**这一条本地头即将被写到的偏移**。第一版写成了在第二个循环里
      //    才累加的 offset —— 那时它还是 0，于是所有条目的 localOff 全成了 0，
      //    解压器会拿第一条的数据去配第二条的名字（多条目时才暴露，单条目完全正常）。
      //    所以偏移在**构建阶段**就要定下来：每条 = 本地头长度 + 数据长度。
      u32(central, 42, offset)
      nameBuf.copy(central, 46)
      centrals.push(central)

      offset += local.length + dataSize
      report.push({ name: e.name, rawSize, compSize: dataSize, crc, stored })
    }

    // 写本地条目。偏移已经在上面累加完了（offset 此刻正好等于中央目录的起点），
    // 这里**不再**重复累加 —— 两处各算一遍迟早会不一致。
    for (const l of locals) {
      await fh.write(l.header)
      for (const chunk of l.payload) {
        if (!chunk) continue
        await fh.write(chunk)
      }
    }

    const cdOffset = offset
    let cdSize = 0
    for (const c of centrals) {
      await fh.write(c)
      cdSize += c.length
    }

    const eocd = Buffer.alloc(22)
    u32(eocd, 0, SIG_EOCD)
    u16(eocd, 4, 0)
    u16(eocd, 6, 0)
    u16(eocd, 8, centrals.length)
    u16(eocd, 10, centrals.length)
    u32(eocd, 12, cdSize)
    u32(eocd, 16, cdOffset)
    u16(eocd, 20, 0)
    await fh.write(eocd)

    return { bytes: cdOffset + cdSize + eocd.length, entries: report }
  } finally {
    await fh.close()
  }
}
