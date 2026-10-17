// 给 Cloudflare 账号注册一个 workers.dev 子域名（发布 Worker 的前提）
// ================================================================
// wrangler 在非交互环境下对"要不要现在注册子域名"这个问题默认回答 no，
// 于是部署会失败并让你去网页上操作。这个脚本用同一把密钥直接调接口完成，
// 省掉一轮浏览器操作（用户的网络到控制台域名本来就不通畅）。
//
// 用法：node _lab/cf-register-subdomain.mjs <account_id> <想要的子域名>
import { readFileSync, existsSync } from 'node:fs'

const [, , accountId, wanted] = process.argv
if (!accountId || !wanted) {
  console.error('用法：node _lab/cf-register-subdomain.mjs <account_id> <子域名>')
  process.exit(2)
}

// 从用户粘贴的文件里取令牌（绝不打印它）
const raw = existsSync('relay/api-token.txt') ? readFileSync('relay/api-token.txt', 'utf8') : ''
const token = raw.split('\n').map((l) => l.trim())
  .find((l) => /^[A-Za-z0-9_-]{30,}$/.test(l))
if (!token) {
  console.error('relay/api-token.txt 里没有可用的令牌')
  process.exit(2)
}

const api = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

const get = await fetch(api, { headers, signal: AbortSignal.timeout(30000) })
const got = await get.json().catch(() => null)
console.log(`① 当前子域名：HTTP ${get.status}  ${JSON.stringify(got?.result ?? got?.errors ?? null)}`)
if (got?.result?.subdomain) {
  console.log(`   已经有子域名了：${got.result.subdomain}.workers.dev —— 不需要再注册`)
  process.exit(0)
}

const put = await fetch(api, {
  method: 'PUT', headers,
  body: JSON.stringify({ subdomain: wanted }),
  signal: AbortSignal.timeout(30000),
})
const out = await put.json().catch(() => null)
console.log(`② 注册「${wanted}」：HTTP ${put.status}`)
if (out?.success) {
  console.log(`   ✓ 成功：你的中继地址将会是 https://<worker 名>.${out.result.subdomain}.workers.dev`)
  process.exit(0)
}
console.log('   ✗ 失败：' + JSON.stringify(out?.errors ?? out))
console.log('   （这个令牌可能没有注册子域名的权限 —— 那就得在浏览器里点一下）')
process.exit(1)
