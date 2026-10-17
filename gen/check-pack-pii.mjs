/**
 * 赠品源码包里的**个人信息与凭据**判据
 * ======================================
 *
 * ── 它防的是哪一种错 ──────────────────────────────────────────
 *
 * 赠品是"把整棵树打进包里送给对方"（`src/gift.js` 的 `collectSourceFiles`），
 * 而源码包还会被**嵌进单文件产物**。所以任何"只属于这台机器/这个人"的文件一旦漏进去，
 * 就等于跟着发出去的 exe 一起传播。
 *
 * 2026-10 用户要求"看看文档里有没有我的个人信息"，扫出来一件真的：
 * `relay/.wrangler/cache/wrangler-account.json`（wrangler 的本地缓存，里面有
 * **Cloudflare 账号 id 和邮箱**）**曾经真的在包里**，也因此进了当时构建的产物。
 * 排除清单里写着 `relay/api-token.txt`（凭据），但没人想到 `.wrangler/`。
 * ——这正是"白名单漏一个是必然的"那一类问题，所以要用**模式**判，而不是靠记得。
 *
 * ── 两条判据 ─────────────────────────────────────────────────
 *   A. **路径**：包里不许出现凭据/本地状态类文件（`.wrangler/`、`api-token*`、
 *      `.env*`、`.dev.vars`、`.npmrc`）；
 *   B. **内容**：包里不许出现邮箱、真实的 Windows 用户名路径、作者的账号名。
 *      允许清单（`ALLOW`）里每一条都要写**为什么可以**，不接受"先放着"。
 *
 * 用法：node gen/check-pack-pii.mjs
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectSourceFiles } from '../src/gift.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** A. 包里不该出现的路径（凭据与本地状态） */
const FORBIDDEN_PATHS = [
  { re: /(^|\/)\.wrangler\//, why: 'wrangler 本地状态：里面有账号 id 与邮箱' },
  { re: /(^|\/)api-token/i, why: '部署令牌（凭据）' },
  { re: /(^|\/)\.env(\..+)?$/, why: '环境变量文件，通常含密钥' },
  { re: /(^|\/)\.dev\.vars$/, why: 'Cloudflare 本地密钥文件' },
  { re: /(^|\/)\.npmrc$/, why: '可能含 npm token' },
]

/** B. 内容里不该出现的东西 */
const CONTENT = [
  { name: '邮箱地址', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  // 32 位十六进制：Cloudflare 账号 id 长这样（Node SEA 的哨兵也长这样，见 ALLOW）
  { name: '32 位十六进制（疑似账号 id）', re: /\b[0-9a-f]{32}\b/g },
  // 真实的 Windows 用户名路径；占位写法（…、you、a、name）不算
  { name: 'Windows 用户目录', re: /C:\\Users\\(?!…|you\b|a\b|name\b|yourname|<)[A-Za-z0-9._-]{2,}/g },
  { name: '作者账号', re: /\b1UWD\b|\b505645716\b/g },
  // 示例用的私网地址（192.168.1.x 这类）在文档里是**需要的**，见 ALLOW
  { name: '局域网 IP', re: /\b192\.168\.\d{1,3}\.\d{1,3}\b/g },
]

/**
 * 作者本机的地址：**任何文件里都不许再出现**，没有例外。
 *
 * 2026-10 用户要求检查个人信息时扫出来的：作者的电脑/手机/网关地址散在 20 个文件、
 * 65 处（含会随赠品发出去的文档）。已统一换成中性示例（`_lab/refactor-scrub-lan-ip.mjs`）。
 * 这一条是那次清理的护栏 —— 文档里的示例地址可以是 192.168.1.5，但不能又变回作者家里那个。
 */
const DENY_ANYWHERE = [
  {
    name: '作者本机地址',
    // ⚠️ 模式只写到**网段前缀**（最后一段不要求是数字）：
    //    第一版要求最后一段是数字，于是源文件里一句"某网段点 x"的注释从判据眼皮下溜过，
    //    还跟着赠品源码包进了产物（实测）。
    re: /192\.168\.50\./g,
  },
]

/**
 * 允许清单：**每一条都要写清楚为什么可以**。
 * 判据的原则是"能说出理由的例外"，不是"先放着不管"。
 */
const ALLOW = [
  {
    file: /^gen\/build-sea\.mjs$/,
    pattern: '32 位十六进制（疑似账号 id）',
    why: '那是 Node SEA 的 sentinel 字符串（fce680ab…），不是任何人的账号 id',
  },
  {
    file: /^(gen|_lab)\/check-pack-pii\.mjs$/,
    pattern: '局域网 IP',
    why: '判据脚本自己的模式字面量（`192\\.168\\.`），不是真实地址',
  },
  {
    file: /^(中文文档|docs)\//,
    pattern: '局域网 IP',
    why: '文档里的示例地址（已统一为 192.168.1.x 这类中性写法）。' +
      '作者本机那一段地址由上面的 DENY_ANYWHERE 单独挡着，不走这条例外',
  },
  {
    file: /^(中文文档|docs)\/原始需求以及作者的话\.md$/,
    pattern: '作者账号',
    why: '那一篇就是作者自己写的自我介绍（B站/Steam 账号），是**有意保留**的署名',
  },
  {
    file: /^(中文文档|docs|test|_lab)\//,
    pattern: 'Windows 用户目录',
    why: '文档与测试里的占位写法（C:\\Users\\…）',
  },
  {
    file: /^(src|_lab|test|ui-prototype\.html|读我\.md|README\.md)/,
    pattern: '局域网 IP',
    why: '注释/实测报告/测试里的**示例地址**（已统一为 192.168.1.x 这类中性写法）。' +
      '作者本机那一段地址由 DENY_ANYWHERE 单独挡着，不走这条例外',
  },
]

const files = await collectSourceFiles(ROOT)
const problems = []

for (const f of files) {
  for (const p of FORBIDDEN_PATHS) {
    if (p.re.test(f.rel)) problems.push(`包里不该有这个文件：${f.rel}（${p.why}）`)
  }
}

for (const f of files) {
  const text = f.data.toString('utf8')
  // 先查"任何文件都不许有"的（没有允许清单）
  //
  // ⚠️ 判据脚本**自己**要跳过：它必须写出那个模式才能去找它，否则它连自己都抓。
  //    （内容类判据（邮箱等）照旧扫这个文件 —— 只有"作者地址"这一条跳过。）
  const isCheckerItself = f.rel === 'gen/check-pack-pii.mjs'
  for (const d of DENY_ANYWHERE) {
    if (isCheckerItself) break
    const m = text.match(d.re)
    if (!m) continue
    const uniq = [...new Set(m)]
    problems.push(`${f.rel} 命中「${d.name}」：${uniq.slice(0, 3).join('、')} —— ` +
      '作者本机的地址不该出现在任何会发出去的文件里')
  }
  for (const c of CONTENT) {
    const m = text.match(c.re)
    if (!m) continue
    const allowed = ALLOW.find((a) => {
      try { return a.file.test(f.rel) && a.pattern === c.name } catch { return false }
    })
    if (allowed) continue
    const uniq = [...new Set(m)]
    problems.push(`${f.rel} 命中「${c.name}」${uniq.length} 处：` +
      uniq.slice(0, 3).map((v) => v.slice(0, 60)).join('、') +
      (uniq.length > 3 ? ` …共 ${uniq.length} 个` : ''))
  }
}

if (problems.length) {
  console.error(`✗ 赠品源码包里有 ${problems.length} 处不该带出去的东西：`)
  for (const p of problems) console.error('   ' + p)
  console.error('\n  处理办法：')
  console.error('    · 是凭据/本地状态 → 加进 src/gift.js 的 PACK_EXCLUDES，并从工作树里删掉')
  console.error('    · 是刻意保留的（作者署名、实测证据）→ 加进本文件顶部的 ALLOW，并写清理由')
  process.exit(1)
}
console.log(`✓ 赠品源码包干净（${files.length} 个文件，无凭据、无个人信息）`)
