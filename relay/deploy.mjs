/**
 * 中继部署脚本
 * ============
 * 把中继（Cloudflare Worker）部署到**你自己的**免费账号。
 *
 * 这一步只需要做**一次**。之后每次跨网络传输都直接用那个地址，
 * 不再需要重复任何步骤。
 *
 * 为什么需要你自己部署：跨网络传输必须有第三个人帮忙牵线 ——
 * 因为你家宽带几乎肯定是运营商大内网，发送端没有可被外部访问的地址。
 * 用别人的公共服务也行，但那意味着"明天它可能关站"和"房间号被别人看见"。
 * 自己的免费 Worker 是零成本且可控的选择。
 *
 * 用法：
 *   node relay/deploy.mjs              # 引导式部署
 *   node relay/deploy.mjs --check      # 只检查环境，不部署
 */
import { spawnSync } from 'node:child_process'
import { existsSync, writeFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runNpx } from '../gen/npx.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const args = process.argv.slice(2)
const checkOnly = args.includes('--check')

const ok = (m) => console.log(`  ✓ ${m}`)
const bad = (m) => console.log(`  ✗ ${m}`)
const info = (m) => console.log(`    ${m}`)

/**
 * 跑一个**本机的 Node 脚本**（例如 `gen/gen-relay-page.mjs`）。
 *
 * ⚠️ 这里**绝不能**带 `shell: true`。第一版对所有命令都加了 shell（因为 npx 在
 *    Windows 上是个 `.cmd`，不带 shell 跑不了），结果 `node.exe` 的路径被
 *    cmd.exe 按空格截断：
 *
 *        'C:\Program' is not recognized as an internal or external command
 *
 *    而 Node 官方安装包在 Windows 上**默认就装在** `C:\Program Files\nodejs\`——
 *    也就是说：部署脚本在大多数 Windows 机器上第一步就失败。实测就是这样暴露的
 *    （用户点"开始部署"时的第一个输出）。
 *
 *    npx 那条路改走 `gen/npx.mjs` 的 `runNpx()`：它直接用当前 node 跑 `npx-cli.js`，
 *    不经 shell、也没有参数转义问题（那个文件就是为同类问题写的）。
 */
function runNode(argv, opts = {}) {
  const r = spawnSync(process.execPath, argv, { encoding: 'utf8', ...opts })
  return { code: r.status, out: ((r.stdout ?? '') + (r.stderr ?? '')).trim() }
}

console.log('\n  闪传 Flicker —— 部署中继（一次即可）\n')

// ── ⓪ 密钥文件（可选）：绕开浏览器登录 ─────────────────────
//
// ⚠️ 为什么需要这条路（2026-10 实测）：wrangler 的浏览器登录要用
//    `dash.cloudflare.com`，而在国内网络上那个域名经常连不上（接口
//    `api.cloudflare.com` 反而是通的）。表现是：浏览器里点了"允许"，
//    命令行这边却报 `Could not reach the Cloudflare auth server … timeout`，
//    授权就"断在半路"。这时候改用 API 令牌（用户在浏览器里创建）就能装成功 ——
//    因为部署只走 api.cloudflare.com。
//
// 令牌放在 `relay/api-token.txt`（已被 .gitignore 与赠品排除清单挡在外面，
// 有机器判据盯着"凭据绝不许进赠品"）。
const tokenFile = path.join(HERE, 'api-token.txt')
if (!process.env.CLOUDFLARE_API_TOKEN && existsSync(tokenFile)) {
  const raw = readFileSync(tokenFile, 'utf8')
  // 找一行"像令牌"的东西：够长、且不是说明文字/占位符
  const token = raw.split('\n')
    .map((l) => l.trim())
    .find((l) => /^[A-Za-z0-9_-]{30,}$/.test(l) && !/^PASTE_YOUR_TOKEN_HERE$/.test(l))
  if (token) {
    process.env.CLOUDFLARE_API_TOKEN = token
    console.log('\n  已从 relay/api-token.txt 读到密钥 —— 跳过浏览器登录，直接部署。')
    console.log('  （装好之后可以删掉那个文件；也可以到 Cloudflare 网站把令牌作废，')
    console.log('    作废不影响已经装好的中继。）')
  } else {
    console.log('\n  relay/api-token.txt 里还没有密钥 —— 如果你想用它，请把令牌粘进去；')
    console.log('  否则就走下面的浏览器登录。')
  }
}

// ── ① 生成页面模块（Worker 要把它发给接收端）──────────────
console.log('① 准备接收端页面…')
const gen = runNode([path.join(ROOT, 'gen', 'gen-relay-page.mjs')])
if (gen.code !== 0) {
  bad('页面模块生成失败')
  info(gen.out.slice(0, 400))
  process.exit(1)
}
info(gen.out.split('\n').pop()?.trim() ?? '')

// ── ② 生成 wrangler 配置 ───────────────────────────────────
console.log('\n② 生成部署配置…')
const cfgPath = path.join(HERE, 'wrangler.toml')
if (!existsSync(cfgPath)) {
  const name = `flicker-relay-${Math.random().toString(36).slice(2, 7)}`
  writeFileSync(cfgPath, `# 闪传 Flicker 中继配置
# 由 relay/deploy.mjs 生成；可以自由修改（比如换 name、加自定义域）
name = "${name}"
main = "worker.js"
compatibility_date = "2025-01-01"

# ⚠️ 刻意不配置任何持久化设施（KV / D1 / R2 / Durable Objects）。
#    消息只存在于内存里 —— 这是"用完即销毁"的落点之一。
#    如果你加了存储，请重新审视那个承诺。
`, 'utf8')
  ok(`已生成 relay/wrangler.toml（name = ${name}）`)
} else {
  const name = (readFileSync(cfgPath, 'utf8').match(/name\s*=\s*"([^"]+)"/) ?? [])[1]
  ok(`沿用已有的 relay/wrangler.toml（name = ${name ?? '未知'}）`)
}

// ── ③ 检查 wrangler ────────────────────────────────────────
console.log('\n③ 检查部署工具…')
const wv = runNpx(['--yes', 'wrangler@latest', '--version'])
if (wv.code !== 0) {
  bad('无法运行 wrangler（需要网络下载，或手动 npm i -g wrangler）')
  info(wv.out.slice(0, 300))
  process.exit(1)
}
// ⚠️ 不要用 `out.split('\n').pop()` 取版本号：npx 的输出末尾常有空行/提示行，
//    取到的是空字符串，屏幕上是 `✓ wrangler `（看起来像没装好，实测第一次就长这样）。
const version = (wv.out.match(/\d+\.\d+\.\d+[\w.-]*/) ?? [])[0] ?? '（版本号没解析出来，但能跑）'
ok(`wrangler ${version}`)
info('（wrangler 是 Cloudflare 的官方工具，只在部署时用到，不进产物）')

if (checkOnly) {
  console.log('\n  （--check）环境检查通过，未执行部署。\n')
  process.exit(0)
}

// ── ④ 登录 ─────────────────────────────────────────────────
console.log('\n④ 登录 Cloudflare…')
if (process.env.CLOUDFLARE_API_TOKEN) {
  console.log('   用的是 relay/api-token.txt 里的密钥（不需要浏览器登录）\n')
} else {
  console.log('   如果还没登录，浏览器会打开一个授权页面 —— 点「允许」即可。')
  console.log('   没有账号的话先注册：https://dash.cloudflare.com/sign-up')
  console.log('   （免费，不需要信用卡）\n')
}
const who = runNpx(['--yes', 'wrangler@latest', 'whoami'], { cwd: HERE })
if (who.code !== 0 || /not authenticated|You are not authenticated/i.test(who.out)) {
  console.log('   需要先登录，正在打开授权页面…')
  const login = runNpx(['--yes', 'wrangler@latest', 'login'], { cwd: HERE, stdio: 'inherit' })
  if (login.code !== 0) {
    bad('登录未完成')
    // ⚠️ 这条失败在国内网络上极常见，而报错本身完全指不到原因（它只说"连不上认证服务器"）。
    //    所以这里把**能照着做**的下一步直接写出来 —— 这正是本项目的做法。
    if (/Could not reach the Cloudflare auth server|UND_ERR_CONNECT_TIMEOUT/i.test(login.out)) {
      console.log('\n   原因：你的网络连不上 Cloudflare 的**控制台域名** dash.cloudflare.com')
      console.log('   （它的接口 api.cloudflare.com 是通的，挡住的只是控制台）。')
      console.log('   wrangler 的浏览器登录必须走控制台，所以这条路在你这里走不通。\n')
      console.log('   改用**密钥**即可绕开（不用浏览器登录）：')
      console.log('     1. 用 Edge 打开 https://dash.cloudflare.com/profile/api-tokens')
      console.log('        （Firefox 打不开这个页面时换 Edge —— 实测有效）')
      console.log('     2. Create Token → 模板选「Edit Cloudflare Workers」→ Continue → Create')
      console.log('     3. 复制那串字符，粘进 relay/api-token.txt，保存')
      console.log('     4. 重新跑：node relay/deploy.mjs\n')
    } else {
      info('也可以手动执行：npx wrangler login')
    }
    process.exit(1)
  }
} else {
  ok(process.env.CLOUDFLARE_API_TOKEN ? '密钥有效' : '已登录')
}

// ── ⑤ 部署 ─────────────────────────────────────────────────
console.log('\n⑤ 部署…')
const dep = runNpx(['--yes', 'wrangler@latest', 'deploy'], { cwd: HERE })
console.log(dep.out.split('\n').map((l) => '    ' + l).join('\n'))

const url = (dep.out.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/) ?? [])[0]
if (dep.code !== 0 || !url) {
  console.log()
  bad('部署没有成功，或没能从输出里找到地址')
  info('请把上面的输出发到 issues，或手动检查 npx wrangler deploy 的结果')
  process.exit(1)
}

console.log(`\n  ✅ 完成！你的中继地址是：\n`)
console.log(`     ${url}\n`)

// ── ⑥ 立刻探一次这个地址（替用户先踩坑）────────────────────
//
// ⚠️ 这一步是 2026-10 加上的，起因是一次真实部署：装是装成功了（Cloudflare 那边
//    确实在跑），但从用户的网络**根本连不上** —— `*.workers.dev` 在那个网络里被
//    整体屏蔽（域名被解析到一个不属于 Cloudflare 的地址、443 超时，而同一时刻
//    Cloudflare 的接口是通的）。当时文档只在最后一章的排查表里提了一句，
//    用户看到的是"✅ 完成！你的中继地址是 …"，然后怎么试都不通。
//    所以现在装完立刻自己试一次，连不上就**当场把原因和出路说清楚**。
console.log('⑥ 探一次刚部署的地址（替你先试一下能不能连上）…')
let reachable = null
try {
  const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(20000) })
  const j = await r.json().catch(() => null)
  reachable = r.ok && j?.ok === true
  if (reachable) {
    ok(`地址可达（/health 正常，单条上限 ${j.maxMessageBytes} 字节）`)
  } else {
    bad(`地址有响应但内容不对：HTTP ${r.status} ${JSON.stringify(j)?.slice(0, 120)}`)
  }
} catch (e) {
  reachable = false
  bad(`连不上这个地址：${e?.cause?.code ?? e?.name ?? e?.message ?? e}`)
}

if (reachable === false) {
  // 这一步**不算部署失败**（中继确实装好了），但必须把话说明白，否则用户会一直试
  console.log('\n  ⚠️ 中继装好了，但**这台机器现在访问不到它**。')
  console.log('     这不是安装出错 —— 多半是你的网络屏蔽了 `*.workers.dev` 这个域名')
  console.log('     （实测：它会把这个域名解析到一个不属于 Cloudflare 的地址，端口也连不上；')
  console.log('       而 Cloudflare 的接口是通的，所以部署能成功、访问却不行）。')
  console.log('\n     两条出路（详见 中文文档/中继部署.md 第二章与第七章）：')
  console.log('       · 给它绑一个自己的域名（约 30–60 元/年）：Workers → 你的 Worker →')
  console.log('         设置 → 域与路由 → 添加自定义域。中继不用重装，只是换个地址。')
  console.log('       · 或者干脆不用中继：两台电脑在同一个网络时直接 `flicker send "文件"`。')
  console.log('\n     想先确认是不是网络问题：用浏览器打开上面那个地址 ——')
  console.log('     打不开就是被挡了（浏览器和命令行结论一致）。')
}

console.log('\n  以后跨网络传输这样用（只需要记住这个地址）：\n')
console.log(`     flicker send "要传的文件" --relay=${url}\n`)
console.log('  把这个地址和密码给对方（密码用另一种渠道发），对方用浏览器打开链接即可。\n')
console.log('  免费额度：10 万请求/天。按"每 MiB 约 2 次请求"算，约合 50 GB/天 —— 个人用途远远够用。\n')
