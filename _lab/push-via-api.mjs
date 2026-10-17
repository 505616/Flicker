/**
 * 当 `git push` 连不上 github.com 时，用 **api.github.com** 把提交推上去
 * ================================================================
 *
 * 为什么会有这个工具（2026-10 实测这台机器所在的网络）：
 *   · `api.github.com`、`codeload.github.com`：正常（HTTP 200）
 *   · `github.com`（git 的 push/fetch 都走它）：**443 连接超时**，换了几个官方地址也一样，
 *     偶发能连上一次 —— 表现就是 `RPC failed; curl 52` 或者干等 21 秒超时。
 *   所以 `git push` 在这条网络上不可用，而 GitHub 的 **Git Data API** 是通的。
 *
 * 它做的事与 `git push` **等价**（不是"上传一个压缩包"这种近似）：
 *   1. 用 `git cat-file --batch` 取出**已提交的**每个 blob 的字节（不是工作区文件）
 *   2. `POST /git/blobs` 建 blob（两个都按内容寻址，所以返回的 SHA 与本地一模一样）
 *   3. `POST /git/trees` 用这些 blob 建一棵树（remote 端的 tree SHA 应当 == `git rev-parse HEAD^{tree}`）
 *   4. `POST /git/commits` 建提交，**作者/提交者/时间/说明与本地逐字相同**
 *      —— 于是 GitHub 生成的 commit SHA 应当 == 本地 `git rev-parse HEAD`
 *   5. `PATCH /git/refs/heads/<branch>` 把分支指过去（`force:false`，父提交不同就会被拒）
 *
 * 做完之后远端与本地**逐字节同一个提交**，不需要 fetch/reset 去对账；
 * 本脚本会顺手把 `refs/remotes/origin/<branch>` 更新成同一个 SHA（等价于 fetch 的结果）。
 *
 * ⚠️ 它不会、也不该被当成推送的常规方式：网络正常时请用 `git push`。
 *    这里唯一的理由是"git 协议走不通、HTTP API 走得通"，而且是用户自己的网络限制。
 *
 * 用法：
 *   node _lab/push-via-api.mjs --repo=505616/Flicker --branch=main --token=ghp_xxx
 *   （token 也可以用环境变量 GH_TOKEN；不要写进任何文件）
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argOf = (name, fallback = null) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const REPO = argOf('repo')
const BRANCH = argOf('branch', 'main')
const TOKEN = argOf('token') ?? process.env.GH_TOKEN
if (!REPO) { console.error('缺 --repo=owner/name'); process.exit(2) }
if (!TOKEN) { console.error('缺 --token=（或环境变量 GH_TOKEN）'); process.exit(2) }

const API = 'https://api.github.com'
const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'flicker-push-via-api',
}

const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

async function api(method, urlPath, body) {
  const res = await fetch(API + urlPath, {
    method,
    headers: { ...HEADERS, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON 就留 null */ }
  if (!res.ok) {
    const e = new Error(`${method} ${urlPath} → HTTP ${res.status}: ${json?.message ?? text.slice(0, 300)}`)
    e.status = res.status
    e.json = json
    throw e
  }
  return json
}

/** `git cat-file --batch` 取一批 blob 的原始字节（一次进程，不按文件起进程） */
function readBlobs(shas) {
  const input = shas.join('\n') + '\n'
  const buf = execFileSync('git', ['cat-file', '--batch'], {
    cwd: ROOT, input, maxBuffer: 512 * 1024 * 1024,
  })
  const out = new Map()
  let i = 0
  while (i < buf.length) {
    const nl = buf.indexOf(0x0a, i)
    const header = buf.subarray(i, nl).toString('utf8')
    const m = header.match(/^([0-9a-f]{40}) (\w+) (\d+)$/)
    if (!m) break
    const size = Number(m[3])
    const start = nl + 1
    out.set(m[1], buf.subarray(start, start + size))
    i = start + size + 1          // 跳过内容后那个换行
  }
  return out
}

const fail = (m) => { console.error(`✗ ${m}`); process.exit(1) }

console.log(`仓库：${REPO}  分支：${BRANCH}`)

// ── 0. 本地状态：必须是干净的，否则"推上去的"和"你看到的"不是一回事 ──
const dirty = git('status', '--porcelain').trim()
if (dirty) fail(`工作区有未提交的改动，先提交再推：\n${dirty.split('\n').slice(0, 10).join('\n')}`)

const localSha = git('rev-parse', 'HEAD').trim()
const localTree = git('rev-parse', 'HEAD^{tree}').trim()
const parentSha = git('rev-parse', 'HEAD^').trim()
const message = git('log', '-1', '--pretty=%B')
const authorName = git('log', '-1', '--pretty=%an').trim()
const authorEmail = git('log', '-1', '--pretty=%ae').trim()
const authorDate = git('log', '-1', '--pretty=%aI').trim()
const committerName = git('log', '-1', '--pretty=%cn').trim()
const committerEmail = git('log', '-1', '--pretty=%ce').trim()
const committerDate = git('log', '-1', '--pretty=%cI').trim()
console.log(`本地提交：${localSha.slice(0, 10)}  tree ${localTree.slice(0, 10)}  ` +
  `父提交 ${parentSha.slice(0, 10)}`)

// ── 1. 远端现状：已经有了就直接收工；父提交不在就是别的历史，别硬来 ──
const ref = await api('GET', `/repos/${REPO}/git/ref/heads/${BRANCH}`)
const remoteSha = ref.object.sha
if (remoteSha === localSha) {
  console.log('✓ 远端已经是这个提交了，不用做任何事')
  process.exit(0)
}
if (remoteSha !== parentSha) {
  fail(`远端 ${BRANCH} 指向 ${remoteSha.slice(0, 10)}，而本地这个提交的父提交是 ` +
    `${parentSha.slice(0, 10)} —— 不是同一条历史，先人工对齐（本工具不做合并）`)
}
console.log(`远端：${remoteSha.slice(0, 10)}（= 本地父提交，可以安全接上去）`)

// ── 2. 建 blob（内容寻址，所以 SHA 与本地一致）──
const entries = git('ls-files', '-s', '-z').split('\0').filter(Boolean).map((line) => {
  const m = line.match(/^(\d{6}) ([0-9a-f]{40}) \d+\t(.+)$/)
  return { mode: m[1] === '100755' ? '100755' : '100644', sha: m[2], file: m[3] }
})
console.log(`文件：${entries.length} 个`)
const blobs = readBlobs([...new Set(entries.map((e) => e.sha))])
console.log(`读取 blob：${blobs.size} 个（去重后）`)

let done = 0
const CONCURRENCY = 6
const queue = [...blobs.entries()]
async function worker() {
  for (;;) {
    const item = queue.shift()
    if (!item) return
    const [sha, data] = item
    const r = await api('POST', `/repos/${REPO}/git/blobs`, {
      content: Buffer.from(data).toString('base64'), encoding: 'base64',
    })
    if (r.sha !== sha) fail(`blob SHA 对不上：本地 ${sha}，远端 ${r.sha}（不该发生）`)
    done++
    if (done % 25 === 0 || done === blobs.size) console.log(`  已上传 ${done}/${blobs.size}`)
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker))

// ── 3. 建树 ──
const tree = await api('POST', `/repos/${REPO}/git/trees`, {
  tree: entries.map((e) => ({ path: e.file, mode: e.mode, type: 'blob', sha: e.sha })),
})
if (tree.sha !== localTree) {
  fail(`tree SHA 不一致：本地 ${localTree}，远端 ${tree.sha} —— 有人改过内容，别继续`)
}
console.log(`✓ tree ${tree.sha.slice(0, 10)} 与本地一致`)

// ── 4. 建提交（作者/提交者/时间/说明逐字相同 → SHA 应当相同）──
const commit = await api('POST', `/repos/${REPO}/git/commits`, {
  message,
  tree: tree.sha,
  parents: [parentSha],
  author: { name: authorName, email: authorEmail, date: authorDate },
  committer: { name: committerName, email: committerEmail, date: committerDate },
})
if (commit.sha !== localSha) {
  console.log(`⚠️ 远端生成的 commit SHA 与本地不同（${commit.sha.slice(0, 10)} vs ${localSha.slice(0, 10)}）`)
  console.log('   内容相同但元数据规范化不同；仍可更新分支，但本地要 reset 才能对上。')
} else {
  console.log(`✓ commit ${commit.sha.slice(0, 10)} 与本地逐字节相同`)
}

// ── 5. 更新分支（force:false —— 父提交不对就会失败，正是我们要的保护）──
const updated = await api('PATCH', `/repos/${REPO}/git/refs/heads/${BRANCH}`, {
  sha: commit.sha, force: false,
})
console.log(`✓ ${BRANCH} → ${updated.object.sha.slice(0, 10)}`)

// ── 6. 本地的 remote-tracking 也指过去（等价于 fetch 的结果；否则 git status 会以为分叉了）──
git('update-ref', `refs/remotes/origin/${BRANCH}`, updated.object.sha)
try {
  git('branch', `--set-upstream-to=origin/${BRANCH}`, BRANCH)
} catch { /* 分支名不是当前分支时忽略 */ }
console.log(`✓ 本地 refs/remotes/origin/${BRANCH} 已更新为同一个提交`)
console.log('\n完成。远端与本地现在是同一个提交。')
