// 探针：赠品源码包到底能不能跑？
// ==============================
// 疑点：`src/gift.js` 的 `SOURCE_FILES` 是一份**手写清单**，只有 40 个文件
// （其中 22 份文档 + 3 个启动脚本），而 `bin/flicker.js` 直接或间接 import 的
// 模块显然不止那几个。若清单不全，接收方拿到的"源码包"**根本起不来**，
// 而赠品那句话写的是"源码 + 全部文档，可以自己看、自己改、自己构建"。
//
// 做法：现场打一份包 → 自己解开（FKZ1 容器）→ 在解开的目录里真的跑一次。
//
// 用法：node _lab/probe-source-pack-runnable.mjs
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { installFromDisk } from '../src/assets.js'
import { buildSourcePack } from '../src/gift.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
installFromDisk(ROOT)

const pack = await buildSourcePack(ROOT)
console.log(`源码包：${pack.bytes.length} 字节，其中文档 ${pack.docCount} 份`)

// ── 解开 FKZ1 容器（写这个探针时才需要；产品里没有解包工具，见 变更记录 的已知限制）──
function unpack(buf) {
  if (buf.subarray(0, 4).toString('ascii') !== 'FKZ1') throw new Error('不是 FKZ1 容器')
  const count = buf.readUInt32BE(4)
  const out = []
  let off = 8
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16BE(off)
    const mode = buf.readUInt16BE(off + 2)
    const dataLen = buf.readUInt32BE(off + 4)
    off += 8
    const rel = buf.subarray(off, off + nameLen).toString('utf8'); off += nameLen
    const data = buf.subarray(off, off + dataLen); off += dataLen
    out.push({ rel, mode, data })
  }
  return out
}

const entries = unpack(pack.bytes)
console.log(`包含 ${entries.length} 个文件：`)
for (const e of entries) console.log('   ' + e.rel)

// ── 在临时目录里展开，然后真的跑一次 ─────────────────────
const dir = await mkdtemp(path.join(tmpdir(), 'probe-source-pack-'))
for (const e of entries) {
  const full = path.join(dir, e.rel)
  await mkdir(path.dirname(full), { recursive: true })
  await writeFile(full, e.data)
}

console.log('\n在解开的目录里跑 `node bin/flicker.js --version`：')
const r = spawnSync(process.execPath, ['bin/flicker.js', '--version'],
  { cwd: dir, encoding: 'utf8', windowsHide: true })
console.log('  退出码: ' + r.status)
if (r.stdout?.trim()) console.log('  stdout: ' + r.stdout.trim())
if (r.stderr?.trim()) console.log('  stderr: ' + r.stderr.trim().split('\n').slice(0, 6).join('\n          '))

const ok = r.status === 0
console.log('\n' + (ok
  ? '✅ 源码包可以运行'
  : '❌ 源码包**跑不起来** —— 赠品清单不全'))

await rm(dir, { recursive: true, force: true })
process.exit(ok ? 0 : 1)
