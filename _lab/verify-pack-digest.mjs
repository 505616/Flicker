/**
 * 反向验证：改了文档之后，"赠品源码包过期"真的会被发现
 * ======================================================
 *
 * 新加的判据是：产物把**内嵌源码包的指纹**记在 `version.json` 里，
 * 冒烟时现场打一份包、比指纹 —— 因为源码包装的是源码 + 全部文档，
 * 而文档改了、产物没重建，测试全绿、对方收到的却是旧文档。
 *
 * 判据本身会不会"永远绿"？这个脚本专门去证伪：
 *   ① 基线：产物记的指纹 == 现场打出来的 → 一致
 *   ② 往文档里加一行（模拟"改了文档没重新构建"）→ **必须**报不一致，且指向 source-pack.fz
 *   ③ 恢复原文 → 又一致（证明②不是别的原因造成的）
 *
 * ⚠️ 全程 try/finally：一定恢复原文，不留下改坏的文档。
 *
 * 用法：node _lab/verify-pack-digest.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareSourcePack } from '../gen/asset-digests.mjs'
import { SOURCE_PACK_ASSET } from '../src/gift.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXE = path.join(ROOT, 'dist', 'flicker-0.1.0-windows-x64.exe')
const DOC = path.join(ROOT, '中文文档', 'PROTOCOL.md')

if (!existsSync(EXE)) {
  console.error(`找不到产物 ${EXE} —— 先跑 node gen/build-sea.mjs`)
  process.exit(1)
}

/** 从**真实产物**里读出它记录的指纹（就是冒烟用的那条路） */
function recordedFromExe() {
  const r = spawnSync(EXE, ['--assets'], {
    encoding: 'utf8', timeout: 60000,
    env: { ...process.env, FLICKER_NO_BROWSER: '1' },
  })
  const out = {}
  for (const line of (r.stdout || '').split('\n')) {
    const m = line.trim().match(/^(\S+)\s+([0-9a-f]{16})$/)
    if (m) out[m[1]] = m[2]
  }
  return out
}

let bad = 0
const original = readFileSync(DOC, 'utf8')
const recorded = recordedFromExe()

if (!recorded[SOURCE_PACK_ASSET]) {
  console.error(`✗ 产物里没有记录 ${SOURCE_PACK_ASSET} 的指纹 —— 先重新构建`)
  process.exit(1)
}
console.log(`产物记录的 ${SOURCE_PACK_ASSET}：${recorded[SOURCE_PACK_ASSET]}`)

try {
  const baseline = await compareSourcePack(recorded)
  if (baseline) {
    console.error(`✗ 基线就不一致：${JSON.stringify(baseline)}`)
    bad++
  } else {
    console.log('✓ 基线：产物里的源码包与现场打出来的一致')
  }

  writeFileSync(DOC, original + '\n<!-- 反向验证用的临时一行 -->\n')
  const stale = await compareSourcePack(recorded)
  if (!stale) {
    console.error('✗ 改了文档之后仍然报"一致" —— 这条判据是永远绿的，等于没有')
    bad++
  } else if (stale.rel !== SOURCE_PACK_ASSET) {
    console.error(`✗ 报错指向了 ${stale.rel}，应当是 ${SOURCE_PACK_ASSET}`)
    bad++
  } else {
    console.log('✓ 改了文档：如实报出源码包过期，且指向 source-pack.fkz')
  }
} finally {
  writeFileSync(DOC, original)
}

const after = await compareSourcePack(recorded)
if (after) {
  console.error(`✗ 恢复之后仍然不一致 —— 文档可能没恢复干净：${JSON.stringify(after)}`)
  bad++
} else {
  console.log('✓ 已恢复原文，重新一致')
}

if (bad) {
  console.error(`\n${bad} 处反向验证未通过`)
  process.exit(1)
}
console.log('✓ 反向验证通过：赠品源码包一旦过期就会被拦下')
