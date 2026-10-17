// 把 relay/wrangler.toml 里的 Worker 名字改成简短的 flicker
// （账号子域名已经注册成 flicker-relay-6dbp7，所以最终地址是
//   https://flicker.flicker-relay-6dbp7.workers.dev —— 比两个随机串更好记）
import { readFileSync, writeFileSync } from 'node:fs'

const FILE = 'relay/wrangler.toml'
const s = readFileSync(FILE, 'utf8')
const m = s.match(/name\s*=\s*"([^"]+)"/)
if (!m) throw new Error('找不到 name = "..." 这一行')
if (m[1] === 'flicker') {
  console.log('  已经叫 flicker 了，无需改动')
  process.exit(0)
}
writeFileSync(FILE, s.replace(/name\s*=\s*"[^"]+"/, 'name = "flicker"'))
console.log(`  Worker 名：${m[1]} → flicker`)
console.log('  将来的地址形如：https://flicker.flicker-relay-6dbp7.workers.dev')
