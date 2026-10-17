// 代码体检②：重复的常量与逻辑、死导出、以及"两份实现"的地方
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const files = []
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'page.generated.js') continue
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.(mjs|js|cjs|html)$/.test(e.name)) files.push(p)
  }
}
for (const d of ['src', 'bin', 'gen', 'web', 'relay', 'entry']) { try { walk(d) } catch { /* */ } }

const src = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]))
const rel = (f) => path.relative(ROOT, f).replace(/\\/g, '/')

/** 在哪些文件里出现了这个模式（排除测试与脚本） */
const where = (re, only = null) => {
  const hits = []
  for (const [f, s] of src) {
    if (only && !only(f)) continue
    const n = (s.match(re) ?? []).length
    if (n) hits.push(`${rel(f)}×${n}`)
  }
  return hits
}
const core = (f) => /[\\/](src|bin|web|relay|entry)[\\/]/.test(f)

console.log('=== 同一份"事实"被写在几个地方（核心代码内）===')
const probes = [
  ['套件 id 字面量 FLICKER/1', /'FLICKER\/1'|"FLICKER\/1"/g],
  ['KDF 标签 flicker/1/', /flicker\/1\//g],
  ['单条消息开销 17', /\b17\b/g],
  ['1 MiB 块大小 (1 << 20)', /1 << 20/g],
  ['AAD 常量 flicker/1/manifest', /flicker\/1\/manifest/g],
  ['MAC 前缀 flicker/1/${role}', /flicker\/1\/\$\{role\}|'flicker\/1\/' \+ role/g],
  ['块大小字段 chunkBytes', /chunkBytes/g],
  ['MAX_MESSAGE / maxMessageBytes', /maxMessageBytes|MAX_MESSAGE_BYTES/g],
]
for (const [label, re] of probes) {
  const hits = where(re, core)
  console.log(`  ${hits.length > 1 ? '⚠️ ' : '   '}${label}: ${hits.join('  ')}`)
}

console.log('\n=== src/ 里的导出：哪些从来没被别处用过（死导出的嫌疑）===')
const srcFiles = [...src.keys()].filter((f) => rel(f).startsWith('src/') || rel(f).startsWith('bin/'))
const dead = []
for (const f of srcFiles) {
  const s = src.get(f)
  for (const m of s.matchAll(/export (?:async )?function (\w+)|export const (\w+)/g)) {
    const name = m[1] ?? m[2]
    let used = 0
    for (const [g, t] of src) {
      if (g === f) continue
      used += (t.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length
    }
    // 测试与 _lab 也算"用过"（它们会 import）
    for (const d of ['test', '_lab']) {
      try {
        for (const e of readdirSync(d)) {
          if (!/\.(mjs|js)$/.test(e)) continue
          used += (readFileSync(path.join(d, e), 'utf8').match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length
        }
      } catch { /* */ }
    }
    if (used === 0) dead.push(`${rel(f)}: ${name}`)
  }
}
console.log(dead.length ? dead.map((d) => '  ⚠️ ' + d).join('\n') : '  （没有发现完全没人用的导出）')

console.log('\n=== 同一段逻辑出现在 Node 与页面两边（"两份实现"清单）===')
const page = src.get([...src.keys()].find((f) => rel(f) === 'web/receiver.html')) ?? ''
const dupes = [
  ['deriveKeys（PBKDF2+HKDF）', /deriveKeys/, /deriveBits|deriveKey/],
  ['macInput（握手 MAC）', /function macInput/, /function macInput/],
  ['chunkIV / ivFor', /chunkIV/, /function ivFor/],
  ['chunkAAD / aadFor', /chunkAAD/, /function aadFor/],
  ['AES-GCM 解密', /openChunk/, /subtle\.decrypt/],
  ['路径安全规则 R1–R12', /PATH_RULES|R1 /, /PATH_RULES/],
  ['SHA-256 增量实现', /class Sha256/, /class Sha256/],
  ['chunkBytes/总块数换算', /totalChunks/, /totalChunks/],
]
for (const [label, a, b] of dupes) {
  const inNode = srcFiles.filter((f) => a.test(src.get(f))).map(rel)
  const inPage = b.test(page)
  console.log(`  ${inPage ? '⚠️' : '  '} ${label}: Node 侧 ${inNode.join(',') || '（内联在页面）'} | 页面 ${inPage ? '有' : '无'}`)
}
